// Hook payload -> one normalized CTS event. Pure except for the optional git/stat probes.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ulid, SCHEMA } from './util.mjs';
import { scrubSecrets } from './secrets.mjs';
import { whoAmI } from './consent.mjs';
import { testInfo, gitOp } from './parse.mjs';

const COMMON = new Set(['session_id', 'prompt_id', 'transcript_path', 'cwd', 'scratchpad_dir', 'permission_mode', 'effort', 'hook_event_name', 'agent_id', 'agent_type']);

const SYNTHETIC_PROMPT = /^\s*<(?:task-notification|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder)\b/;
const cap = (s, n) => { s = s == null ? '' : String(s); return s.length > n ? s.slice(0, n) + '…' : s; };
const clean = (s, n) => cap(scrubSecrets(typeof s === 'string' ? s : s == null ? '' : JSON.stringify(s)), n);

export const KIND = {
  SessionStart: 'session.start', UserPromptSubmit: 'prompt', PreToolUse: 'tool.pre', PostToolUse: 'tool.post',
  PostToolUseFailure: 'tool.fail', PostToolBatch: 'batch', SubagentStart: 'subagent.start', SubagentStop: 'subagent.stop',
  Stop: 'turn.end', StopFailure: 'turn.fail', PreCompact: 'compact.pre', PostCompact: 'compact.post',
  PreModelSwitch: 'model.pre', PostModelSwitch: 'model.post', SessionEnd: 'session.end', Notification: 'notify',
  PermissionRequest: 'permission.request', PermissionDenied: 'permission.denied', TaskCreated: 'task.created',
  TaskCompleted: 'task.completed', TeammateIdle: 'teammate.idle', CwdChanged: 'cwd.changed', DirectoryAdded: 'dir.added',
  Elicitation: 'elicitation', ElicitationResult: 'elicitation.result', WorktreeCreate: 'worktree.create',
  WorktreeRemove: 'worktree.remove', FileChanged: 'file.changed',
};

export function summarizeInput(tool, ti) {
  if (!ti || typeof ti !== 'object') return {};
  const o = {};
  for (const k of ['file_path', 'path', 'notebook_path', 'pattern', 'url', 'description', 'query', 'subagent_type', 'name', 'skill', 'glob']) if (ti[k] != null) o[k] = clean(ti[k], 400);
  if (ti.command != null) o.command = clean(ti.command, 2000);
  if (ti.prompt != null) o.prompt = clean(ti.prompt, 400);
  if (Array.isArray(ti.questions)) o.questions = ti.questions.slice(0, 4).map((q) => clean(q && (q.question || q), 300));
  if (tool === 'Write' && typeof ti.content === 'string') o.bytes = ti.content.length;
  if (tool === 'Edit') { o.old_len = (ti.old_string || '').length; o.new_len = (ti.new_string || '').length; }
  return o;
}

function textOf(resp) {
  if (resp == null) return '';
  if (typeof resp === 'string') return resp;
  if (typeof resp === 'object') {
    const parts = [];
    for (const k of ['stdout', 'stderr', 'output', 'content', 'text', 'error']) if (typeof resp[k] === 'string') parts.push(resp[k]);
    if (parts.length) return parts.join('\n');
    try { return JSON.stringify(resp); } catch { return ''; }
  }
  return String(resp);
}
const tail = (s, n) => (s.length > n ? '…' + s.slice(-n) : s);

function git(cwd, args) {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}
export function gitEnrich(cmd, cwd, ok) {
  const g = gitOp(cmd);
  if (!g) return null;
  const info = { op: g.op, args: cap(g.args, 200) };
  if (!ok) { info.failed = true; return info; }
  info.branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (g.op === 'commit') {
    const out = git(cwd, ['show', '--numstat', '--format=%H%x09%s', 'HEAD']);
    const lines = out.split('\n');
    const [sha, ...subj] = (lines[0] || '').split('\t');
    info.sha = sha; info.subject = cap(subj.join('\t'), 200);
    const files = []; let ins = 0, del = 0;
    for (const l of lines.slice(1)) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l);
      if (m) { ins += +m[1] || 0; del += +m[2] || 0; files.push(m[3]); }
    }
    info.stat = { files: files.length, ins, del };
    info.files = files.slice(0, 40);
  }
  if (g.op === 'tag') info.tag = cap(g.args.split(/\s+/).filter((x) => !x.startsWith('-'))[0], 80);
  return info;
}

function transcriptRef(inp) {
  let p = inp.transcript_path;
  if (!p) return null;
  if (inp.agent_id) {
    const sub = path.join(p.replace(/\.jsonl$/, ''), 'subagents', `agent-${inp.agent_id}.jsonl`);
    try { fs.statSync(sub); p = sub; } catch { /* fall back to main transcript */ }
  }
  let off = 0;
  try { off = fs.statSync(p).size; } catch { return null; }
  return { path: p, off };
}

/** Normalize one hook payload. `enrich:false` skips git/stat probes (tests). */
export function normalize(inp, { enrich = true, now = Date.now() } = {}) {
  const h = inp.hook_event_name;
  const kind = KIND[h] || 'hook.' + String(h || 'unknown');
  const agent = inp.agent_id ? `agent:${inp.agent_id}` : null;
  const ev = {
    v: SCHEMA, id: ulid(now), sid: inp.session_id || 'unknown', ts: new Date(now).toISOString(),
    hook: h, kind,
    actor: h === 'UserPromptSubmit' ? 'human' : agent || 'main',
    prompt_id: inp.prompt_id || null,
    cwd: inp.cwd || null,
    d: {},
  };
  if (inp.agent_type) ev.agent_type = inp.agent_type;
  const d = ev.d;
  const tool = inp.tool_name;
  switch (h) {
    case 'SessionStart':
      d.source = inp.source || 'startup'; d.model = inp.model || null; if (inp.session_title) d.title = clean(inp.session_title, 120);
      break;
    case 'UserPromptSubmit':
      d.text = clean(inp.prompt ?? inp.user_prompt ?? inp.message ?? '', 20000);
      d.who = whoAmI();
      break;
    case 'PreToolUse':
      d.tool = tool; d.tool_use_id = inp.tool_use_id; d.input = summarizeInput(tool, inp.tool_input);
      break;
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const ok = h === 'PostToolUse';
      d.tool = tool; d.tool_use_id = inp.tool_use_id; d.ok = ok; d.input = summarizeInput(tool, inp.tool_input);
      const out = textOf(inp.tool_response) || '';
      const err = inp.error != null ? textOf(inp.error) : '';
      const body = ok ? out : err || out;
      d.out = clean(tail(body, 1200), 1300);
      if (inp.duration_ms != null) d.dur_ms = inp.duration_ms;
      if (inp.tool_response && typeof inp.tool_response === 'object') {
        const r = inp.tool_response;
        if (r.exit_code != null || r.exitCode != null) d.exit = r.exit_code ?? r.exitCode;
        if (r.interrupted) d.interrupted = true;
      }
      if (tool === 'Bash') {
        const cmd = inp.tool_input && inp.tool_input.command;
        const t = testInfo(cmd, scrubSecrets(body), ok);
        if (t) d.test = { ...t, seg: clean(t.seg, 200) };
        if (enrich) { const g = gitEnrich(cmd, inp.cwd || process.cwd(), ok); if (g) d.git = g; }
        else { const g = gitOp(cmd); if (g) d.git = { op: g.op, args: cap(g.args, 200) }; }
      }
      break;
    }
    case 'SubagentStart':
      d.agent_type = inp.agent_type || null; d.name = inp.agent_name || inp.name || null; d.description = clean(inp.description || '', 200);
      break;
    case 'SubagentStop': case 'Stop':
      d.last = clean(inp.last_assistant_message || '', 4000);
      if (inp.stop_hook_active != null) d.hook_active = !!inp.stop_hook_active;
      break;
    case 'StopFailure':
      d.error = clean(inp.error || inp.reason || inp.matcher || '', 500); d.last = clean(inp.last_assistant_message || '', 1000);
      break;
    case 'PreCompact': case 'PostCompact':
      d.trigger = inp.trigger || null; d.summary = clean(inp.summary || inp.compact_summary || '', 4000);
      break;
    case 'PreModelSwitch': case 'PostModelSwitch':
      d.from = inp.from_model || null; d.to = inp.to_model || null;
      break;
    case 'SessionEnd':
      d.reason = inp.reason || null;
      break;
    case 'PermissionRequest': case 'PermissionDenied':
      d.tool = tool; d.input = summarizeInput(tool, inp.tool_input); d.tool_use_id = inp.tool_use_id;
      if (inp.reason) d.reason = clean(inp.reason, 300);
      break;
    default:
      break;
  }
  // Keep unknown extras (task, notification, elicitation, batch ...) without trusting their shape.
  const known = new Set(['tool_name', 'tool_input', 'tool_response', 'tool_use_id', 'prompt', 'source', 'model', 'session_title', 'last_assistant_message', 'error', 'trigger', 'summary', 'from_model', 'to_model', 'reason', 'duration_ms', 'stop_hook_active', 'entrypoint']);
  const extra = {};
  for (const [k, v] of Object.entries(inp)) {
    if (COMMON.has(k) || known.has(k)) continue;
    extra[k] = clean(v, 400);
  }
  if (Object.keys(extra).length) d.extra = extra;
  // Claude Code injects some user turns itself (background task results, local command output). Those are not the
  // human speaking: they must not open threads, count as reversals or sit in the human lane.
  if (ev.kind === 'prompt' && SYNTHETIC_PROMPT.test(d.text || '')) {
    ev.kind = 'notify'; ev.actor = agent || 'main';
    ev.d = { message: cap(d.text, 600), synthetic: (/^\s*<([\w-]+)/.exec(d.text) || [])[1] };
  }
  // `claude -p` and the SDKs (entrypoint `sdk-*`): a program wrote the prompt, such as an app's own agent calls or a
  // script, so it belongs to the caller, not to you. Interactive surfaces (`cli`, the IDE and desktop apps) stay yours.
  const entry = (inp.entrypoint !== undefined ? inp.entrypoint : process.env.CLAUDE_CODE_ENTRYPOINT) || ''; // imports pass their own
  if (/^sdk-/.test(entry) && (ev.kind === 'prompt' || ev.kind === 'session.start')) {
    d.headless = cap(entry, 40);
    if (ev.kind === 'prompt') { ev.actor = 'caller'; delete d.who; }
  }
  const tp = enrich ? transcriptRef(inp) : null;
  if (tp) ev.tp = tp;
  return ev;
}
