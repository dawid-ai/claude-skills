#!/usr/bin/env node
// Capture hook: read one payload, append one line, never block, never print (except SessionStart context).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findRoot, ensureProject, paths, serialize, pidAlive, readJson, ago, loadConfig, SERVER_FLAGS } from './lib/util.mjs';
import { normalize } from './lib/normalize.mjs';
import { register } from './lib/registry.mjs';

function readStdin() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    let n;
    try { n = fs.readSync(0, buf, 0, buf.length, null); } catch (e) { if (e.code === 'EAGAIN') continue; if (e.code === 'EOF') break; break; }
    if (!n) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function logFail(root, err) {
  try { fs.appendFileSync(paths(root).hooklog, `${new Date().toISOString()} ${err && err.stack || err}\n`); } catch { /* nothing else to do */ }
}

function startServer(root, p) {
  if (process.env.CTS_NO_SERVER) return;
  const s = readJson(p.server);
  if (s && pidAlive(s.pid)) return;
  const server = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs');
  const child = spawn(process.execPath, [...SERVER_FLAGS, server, '--root', root], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

function contextNote(p) {
  const c = readJson(p.context);
  if (!c) return null;
  const lines = [];
  if (c.threads && c.threads.length) {
    lines.push(`CTS project log: ${c.threads.length} open thread${c.threads.length === 1 ? '' : 's'}:`);
    for (const t of c.threads.slice(0, 8)) lines.push(`- (${ago(Date.now() - Date.parse(t.opened_ts))} old, opened by ${t.opened_by}) ${t.text}`);
  } else lines.push('CTS project log: no open threads.');
  if (c.last) lines.push(`Last moment: "${c.last.headline}" (${c.last.kind}, score ${c.last.score}).`);
  if (c.pending_extract) lines.push(`${c.pending_extract} detected moment${c.pending_extract === 1 ? '' : 's'} await Tier 2 extraction (the user can run /cts:extract).`);
  if (c.pending_drafts) lines.push(`${c.pending_drafts} drafted post${c.pending_drafts === 1 ? '' : 's'} await the user\'s review (/cts:queue). Do not approve or publish them yourself.`);
  lines.push('Facts from .cts/ event log; full detail via the cts_threads / cts_moments MCP tools.');
  return lines.join('\n').slice(0, 1800);
}

/** The one line the user sees at session start: drafts waiting for review. Off with "notify": {"terminal": false}. */
function userLine(root, p) {
  const c = readJson(p.context);
  if (!c || !c.pending_drafts) return null;
  if (loadConfig(root).notify.terminal === false) return null;
  return `CTS: ${c.pending_drafts} drafted post${c.pending_drafts === 1 ? '' : 's'} await${c.pending_drafts === 1 ? 's' : ''} your review (/cts:queue, or the Drafts view in /cts:open).`;
}

// CTS's own helper sessions (`claude -p` for auto-extraction) set this, so they never record themselves.
if (process.env.CTS_SKIP_CAPTURE) process.exit(0);

try {
  const raw = readStdin();
  const inp = raw.trim() ? JSON.parse(raw) : {};
  const root = findRoot(inp.cwd || process.cwd());
  const p = ensureProject(root);
  if (!fs.existsSync(p.paused)) {
    const ev = normalize(inp);
    const fd = fs.openSync(path.join(p.sessions, `${String(ev.sid).replace(/[^\w.-]/g, '_')}.jsonl`), 'a');
    fs.writeSync(fd, serialize(ev));
    fs.closeSync(fd);
  }
  if (inp.hook_event_name === 'SessionStart') {
    try { register(root); } catch (e) { logFail(root, e); }
    startServer(root, p);
    const paused = fs.existsSync(p.paused);
    const note = paused ? null : contextNote(p);
    const msg = paused ? null : userLine(root, p);
    if (note || msg) process.stdout.write(JSON.stringify({ ...(msg ? { systemMessage: msg } : {}), ...(note ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: note } } : {}) }));
  }
} catch (e) {
  try { logFail(findRoot(process.cwd()), e); } catch { /* never surface */ }
}
process.exit(0);
