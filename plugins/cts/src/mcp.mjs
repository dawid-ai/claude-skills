#!/usr/bin/env node
// Minimal MCP server over stdio so Claude can read (and mark) the CTS log. Same Project/engine as the dashboard.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Project } from './lib/project.mjs';
import { findRoot, trunc, ago } from './lib/util.mjs';
import { writeHumanEvent } from './lib/log.mjs';
import { evidenceLine } from './lib/share.mjs';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const TOOLS = [
  { name: 'cts_moments', description: 'List scored moments from the project log (reversals, fights, disagreements, ships, breaks...). Same list the CTS dashboard shows.', inputSchema: { type: 'object', properties: { limit: { type: 'number' }, min_score: { type: 'number' }, kind: { type: 'string' }, since_hours: { type: 'number' } } } },
  { name: 'cts_threads', description: 'List open (or closed) decision threads: unanswered questions and hedged decisions such as "for now" or "revisit". Answers "what is still undecided?".', inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'closed', 'all'] } } } },
  { name: 'cts_search', description: 'Search prompts, commands, commit messages and moment headlines in the project log.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'cts_mark', description: 'Flag the current moment (score 100). With thread=true, open an undecided thread instead, e.g. after making a hedged decision.', inputSchema: { type: 'object', properties: { note: { type: 'string' }, thread: { type: 'boolean' } } } },
  { name: 'cts_drafts', description: 'List drafted posts waiting in the review queue (read-only). Approving, editing and declining are done by the human in the dashboard or with `cts queue`; there is deliberately no tool for that.', inputSchema: { type: 'object', properties: { status: { type: 'string', description: 'pending (default), approved, published, declined, expired' } } } },
];

export function makeHandler(root) {
  const pr = Project.open(root);
  const fmtM = (m) => `- [${m.score}] ${m.kind} · ${new Date(m.t0).toISOString().slice(0, 16).replace('T', ' ')} · ${m.headline}${evidenceLine(m) ? ` (${evidenceLine(m)})` : ''} · id ${m.id}`;
  const calls = {
    cts_moments: (a) => {
      pr.sync();
      let ms = pr.engine.listMoments({ min: a.min_score ?? pr.cfg.threshold });
      if (a.kind) ms = ms.filter((m) => m.kind === a.kind);
      if (a.since_hours) ms = ms.filter((m) => m.t1 >= Date.now() - a.since_hours * 3600e3);
      ms = ms.slice(-(a.limit || 10)).reverse();
      return ms.length ? ms.map(fmtM).join('\n') : 'No moments above the score floor.';
    },
    cts_threads: (a) => {
      pr.sync();
      const st = a.status || 'open';
      const all = [...pr.engine.threads.values()];
      const sel = st === 'open' ? pr.engine.openThreads() : st === 'closed' ? all.filter((t) => t.closed) : all;
      return sel.length ? sel.map((t) => `- (${ago(Date.now() - t.opened_t)} old, opened by ${t.opened_by}, ${t.kind}) ${t.text}${t.closed ? ` [closed: ${t.closed.how}]` : ''} · id ${t.id}`).join('\n') : `No ${st} threads.`;
    },
    cts_search: (a) => {
      pr.sync();
      const r = pr.search(a.query, a.limit || 15);
      return [`Moments (${r.moments.length}):`, ...r.moments.slice(0, 10).map(fmtM), `Events (${r.events.length}):`, ...r.events.map((e) => `- ${e.ts.slice(0, 16)} ${e.actor} ${e.kind}: ${trunc(e.d.text || (e.d.input && (e.d.input.command || e.d.input.file_path)) || e.d.last || (e.d.git && e.d.git.subject) || '', 120)}`)].join('\n');
    },
    cts_drafts: (a) => {
      pr.sync();
      const l = pr.engine.drafts.list({ status: a.status || 'pending' });
      return l.length ? l.map((x) => `- ${x.id.slice(-8)} · ${x.channel}/${x.format} · ${x.kind || ''} · ${trunc(x.text.replace(/\s+/g, ' '), 100)}`).join('\n') : `No ${a.status || 'pending'} drafts.`;
    },
    cts_mark: (a) => {
      writeHumanEvent(root, 'mark', { note: a.note || '', flag: a.thread ? '?' : null }, { actor: 'main' });
      pr.sync();
      return a.thread ? 'Opened a thread.' : 'Marked.';
    },
  };
  return (msg) => {
    const { id, method, params } = msg;
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') return ok({ protocolVersion: (params && params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'cts', version: VERSION } });
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools: TOOLS });
    if (method === 'tools/call') {
      const fn = calls[params.name];
      if (!fn) return { jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool ' + params.name } };
      try { return ok({ content: [{ type: 'text', text: fn(params.arguments || {}) }] }); } catch (e) { return ok({ isError: true, content: [{ type: 'text', text: String(e.message) }] }); }
    }
    if (id === undefined) return null; // notification
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } };
  };
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain || process.env.CTS_MCP === '1') {
  const root = findRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const handle = makeHandler(root);
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { const r = handle(JSON.parse(line)); if (r) process.stdout.write(JSON.stringify(r) + '\n'); } catch (e) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: String(e.message) } }) + '\n'); }
    }
  });
}
