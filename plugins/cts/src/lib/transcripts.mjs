// `cts import transcripts`: rebuild the log for sessions that ran before CTS was installed, from Claude Code's own
// transcripts (~/.claude/projects/<project>/<session>.jsonl and <session>/subagents/agent-<id>.jsonl).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalize } from './normalize.mjs';
import { ulid, serialize, ensureProject } from './util.mjs';
import { gitOp } from './parse.mjs';

export const encodeProjectDir = (root) => (/^([A-Za-z]:[\\/]|\/)/.test(root) ? root : path.resolve(root)).replace(/[^A-Za-z0-9]/g, '-');
export function transcriptDir(root, base = path.join(os.homedir(), '.claude', 'projects')) {
  const exact = path.join(base, encodeProjectDir(root));
  if (fs.existsSync(exact)) return exact;
  try { const want = encodeProjectDir(root).toLowerCase(); const hit = fs.readdirSync(base).find((d) => d.toLowerCase() === want); if (hit) return path.join(base, hit); } catch { /* none */ }
  return exact;
}

function* rawLines(file) {
  const data = fs.readFileSync(file);
  let pos = 0;
  while (pos < data.length) {
    let nl = data.indexOf(10, pos);
    if (nl < 0) nl = data.length;
    const line = data.toString('utf8', pos, nl);
    if (line.trim()) { try { yield { o: JSON.parse(line), off: pos }; } catch { /* skip junk */ } }
    pos = nl + 1;
  }
}
const textOfContent = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x.type === 'text' ? x.text : x.type === 'tool_result' ? textOfContent(x.content) : '')).join('\n') : '');
const stripReminders = (s) => String(s || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<(?:local-command-[a-z-]+|command-[a-z-]+)>[\s\S]*?<\/(?:local-command-[a-z-]+|command-[a-z-]+)>/g, '').trim();
const det = (key) => crypto.createHash('sha1').update(key).digest().subarray(0, 10);

/** Convert one transcript file into CTS events. `agent` = {id, type} for subagent files. */
export function convertTranscript(file, { sid, agent = null, agentTypes = new Map() } = {}) {
  const events = [];
  const pending = new Map();
  let lastText = '', lastTs = 0, model = null, branch = null, title = null, started = false, lastOff = 0, turnOpen = false, entrypoint = '';
  const actor = agent ? `agent:${agent.id}` : 'main';
  const emit = (inp, t, off) => {
    const ev = normalize({ session_id: sid, cwd: inp.cwd || null, entrypoint, ...inp }, { enrich: false, now: t });
    ev.id = ulid(t, det(`${sid}:${actor}:${off}:${events.length}:${inp.hook_event_name}`));
    ev.d.imported = true;
    if (agent) { ev.actor = actor; ev.agent_type = agent.type; }
    else if (ev.actor !== 'human' && ev.actor !== 'caller') ev.actor = 'main';
    ev.tp = { path: file, off };
    ev.hook = 'import:transcript';
    events.push(ev);
    return ev;
  };
  const closeTurn = (t, off) => {
    if (!turnOpen) return;
    turnOpen = false;
    if (agent) return; // subagent stop is emitted once at the end
    emit({ hook_event_name: 'Stop', last_assistant_message: lastText }, t, off);
  };
  for (const { o, off } of rawLines(file)) {
    const t = o.timestamp ? Date.parse(o.timestamp) : lastTs;
    if (!t) continue;
    if (o.entrypoint) entrypoint = o.entrypoint;
    if (o.type === 'ai-title') { title = o.aiTitle; continue; }
    if (!['user', 'assistant', 'system'].includes(o.type)) continue;
    lastTs = t; lastOff = off;
    if (o.gitBranch) branch = o.gitBranch;
    if (!started) {
      started = true;
      if (agent) emit({ hook_event_name: 'SubagentStart', agent_type: agent.type }, t, off);
      else emit({ hook_event_name: 'SessionStart', source: 'import', model: o.message && o.message.model, cwd: o.cwd }, t, off);
    }
    if (o.type === 'system') { if (o.subtype === 'compact_boundary') emit({ hook_event_name: 'PostCompact', trigger: (o.compactMetadata && o.compactMetadata.trigger) || 'auto' }, t, off); continue; }
    if (o.isCompactSummary) { emit({ hook_event_name: 'PostCompact', trigger: 'auto', summary: stripReminders(textOfContent(o.message.content)).slice(0, 2000) }, t, off); continue; }
    const c = o.message && o.message.content;
    if (o.type === 'assistant') {
      const m = o.message.model;
      if (m && model && m !== model && !agent) emit({ hook_event_name: 'PostModelSwitch', from_model: model, to_model: m }, t, off);
      if (m) model = m;
      turnOpen = true;
      for (const part of Array.isArray(c) ? c : []) {
        if (part.type === 'text' && part.text && part.text.trim()) lastText = part.text;
        if (part.type === 'tool_use') {
          pending.set(part.id, { name: part.name, input: part.input });
          emit({ hook_event_name: 'PreToolUse', tool_name: part.name, tool_input: part.input, tool_use_id: part.id }, t, off);
        }
      }
      continue;
    }
    // user record
    if (Array.isArray(c) && c.some((x) => x.type === 'tool_result')) {
      for (const part of c.filter((x) => x.type === 'tool_result')) {
        const p = pending.get(part.tool_use_id) || { name: 'unknown', input: {} };
        const body = textOfContent(part.content);
        const ok = !part.is_error;
        const inp = { hook_event_name: ok ? 'PostToolUse' : 'PostToolUseFailure', tool_name: p.name, tool_input: p.input, tool_use_id: part.tool_use_id };
        if (ok) inp.tool_response = { stdout: body }; else inp.error = body;
        const ev = emit(inp, t, off);
        if (ev.d.git && branch) ev.d.git.branch = branch;
        if (ev.d.git && ev.d.git.op === 'commit' && ok) {
          const m = /-m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(p.input.command || '') || /<<\s*'?EOF'?\s*\n([^\n]+)/.exec(p.input.command || '');
          if (m) ev.d.git.subject = (m[1] || m[2] || m[0]).slice(0, 200);
        }
        const ta = o.toolUseResult && typeof o.toolUseResult === 'object' && o.toolUseResult.agentId;
        if (ta && o.toolUseResult.agentType) agentTypes.set(ta, o.toolUseResult.agentType);
        pending.delete(part.tool_use_id);
      }
      continue;
    }
    if (o.isMeta) continue;
    const text = stripReminders(textOfContent(c));
    if (!text) continue;
    if (!agent) { closeTurn(t, off); emit({ hook_event_name: 'UserPromptSubmit', prompt: text, prompt_id: o.promptId }, t, off); }
  }
  if (!started) return { events, title };
  if (agent) emit({ hook_event_name: 'SubagentStop', agent_type: agent.type, last_assistant_message: lastText }, lastTs, lastOff);
  else { closeTurn(lastTs, lastOff); emit({ hook_event_name: 'SessionEnd', reason: 'imported' }, lastTs, lastOff); }
  if (title && events[0]) events[0].d.title = title.slice(0, 120);
  for (const e of events) { e.prompt_id = e.prompt_id || null; if (e.d.git === undefined && false) e.d.git = null; }
  return { events, title };
}

export function importTranscripts(root, { dir, since = 0, dryRun = false } = {}) {
  const p = ensureProject(root);
  const tdir = dir || transcriptDir(root);
  const res = { dir: tdir, sessions: 0, events: 0, skippedLive: 0, skippedOld: 0, subagents: 0 };
  if (!fs.existsSync(tdir)) return { ...res, missing: true };
  for (const f of fs.readdirSync(tdir).filter((x) => x.endsWith('.jsonl')).sort()) {
    const sid = f.slice(0, -6);
    const out = path.join(p.sessions, `${sid}.jsonl`);
    if (fs.existsSync(out)) {
      const first = fs.readFileSync(out, 'utf8').split('\n', 1)[0];
      if (!first.includes('"import:transcript"')) { res.skippedLive++; continue; }
    }
    const agentTypes = new Map();
    const main = convertTranscript(path.join(tdir, f), { sid, agentTypes });
    if (!main.events.length) continue;
    if (since && Date.parse(main.events[main.events.length - 1].ts) < since) { res.skippedOld++; continue; }
    let all = main.events;
    const subdir = path.join(tdir, sid, 'subagents');
    if (fs.existsSync(subdir)) {
      for (const sf of fs.readdirSync(subdir).filter((x) => /^agent-.+\.jsonl$/.test(x))) {
        const id = sf.replace(/^agent-/, '').replace(/\.jsonl$/, '');
        let type = agentTypes.get(id);
        try { const meta = JSON.parse(fs.readFileSync(path.join(subdir, sf.replace(/\.jsonl$/, '.meta.json')), 'utf8')); type = type || meta.agentType || meta.agent_type; } catch { /* no meta */ }
        const sub = convertTranscript(path.join(subdir, sf), { sid, agent: { id, type: type || 'subagent' } });
        all = all.concat(sub.events); res.subagents++;
      }
    }
    all.sort((a, b) => (a.id < b.id ? -1 : 1));
    res.sessions++; res.events += all.length;
    if (!dryRun) fs.writeFileSync(out, all.map((e) => { delete e._t; return serialize(e); }).join(''));
  }
  return res;
}
