// Tier 2: model extraction at boundaries. CTS never calls a model by itself in the capture path.
// `prepare` builds a bounded packet (only the spans the candidates need); a model (the cts:extractor subagent in the
// user's own session, or `cts extract --api`) answers with JSON; `apply` validates it against the log and appends
// extract.* events. Nothing the model says enters the log unless every citation and every number checks out.
import { KINDS } from './engine.mjs';
import { writeHumanEvent } from './log.mjs';
import { scrubSecrets } from './secrets.mjs';
import { summarize } from './summary.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { trunc } from './util.mjs';

export const INSTRUCTIONS = `You are the CTS extractor. Question to answer for each candidate: what here would surprise a peer who is good at this?
Keep only moments that pass that test. Merge overlapping candidates. Drop routine ones with a reason.
For every kept moment write: a one-line headline (max 120 chars), a body of at most 3 short lines, a score 0-100, and evidence.
Posts are built from the headline and body, so write them as plain first-person story lines a peer can follow ("I went with X instead of Y because ...", "I skipped Z for now"), not log lines: no commands, file names, paths, branch names, test names or quoted prompts there. Exact quotes belong in evidence only.
You may also add moments the detectors cannot see (kind "theory" = a wrong theory held for a while, "workaround" = a clever workaround, "learned" = a thing learned) but only from events in the packet.
HARD RULES (a validator rejects violations):
- cite: list the event ids that justify the moment. Every id must be one of the ids in the packet.
- Every number in your headline, body and evidence (attempts, minutes, lines, counts) must appear in the cited events. Do not compute new numbers except the elapsed minutes between the first and last cited event.
- evidence.prompt and evidence.error must be exact substrings of a cited event's text. Quote, never paraphrase.
- Never state a lesson, cause or outcome that the events do not show. If unsure, leave it out.
- Use the few-shot feedback: moments the human confirmed show their taste, dismissed ones show what to drop.
Reply with ONLY a JSON object:
{"moments":[{"target":"<candidate id or omit>","kind":"<kind>","headline":"","body":["","",""],"score":0,"cite":["<event id>"],"evidence":{"prompt":"","error":"","diff":"","elapsed":""},"actors":["human","main"]}],
 "merge":[{"target":"<id>","into":"<id>"}],
 "drop":[{"target":"<id>","reason":""}],
 "threads":[{"op":"close","thread":"<thread id>","resolution":"","cite":["<event id>"]},{"op":"open","text":"","cite":["<event id>"]}]}`;

export const evText = (e) => {
  const d = e.d || {}, i = d.input || {};
  return [d.text, d.last, i.command, i.file_path, i.pattern, i.description, d.out && String(d.out), d.git && `${d.git.op} ${d.git.subject || ''} ${d.git.stat ? `+${d.git.stat.ins} -${d.git.stat.del} ${d.git.stat.files} files` : ''} ${(d.git.files || []).join(' ')}`, d.note, d.test && Object.entries(d.test).map(([k, v]) => `${k} ${v}`).join(' ')].filter(Boolean).join('\n');
};
const compactEvent = (e) => {
  const d = e.d || {};
  const o = { id: e.id, ts: e.ts, actor: e.actor, kind: e.kind, summary: summarize(e) };
  if (e.kind === 'prompt') o.text = trunc(d.text, 800);
  if (e.kind === 'tool.fail' && d.out) o.out = trunc(String(d.out).split('\n').slice(-12).join('\n'), 600);
  if ((e.kind === 'turn.end' || e.kind === 'subagent.stop') && d.last) o.text = trunc(d.last, 800);
  if (d.test) o.test = d.test;
  if (d.git) o.git = d.git;
  return o;
};

/** Moments still waiting for Tier 2, best first. */
export function pending(pr, { min = 30, limit = 12 } = {}) {
  return [...pr.engine.moments.values()]
    .filter((m) => m.tier === 1 && !m.extracted && !m.demo && (m.status === 'auto' || m.status === 'confirmed') && m.kind !== 'mark')
    .map((m) => pr.engine.view(m)).filter((m) => m.score >= min)
    .sort((a, b) => b.score - a.score).slice(0, limit);
}

export function prepare(pr, { min = 30, limit = 12 } = {}) {
  const cands = pending(pr, { min, limit });
  const events = {};
  const add = (e) => { if (e && !events[e.id]) events[e.id] = compactEvent(e); };
  const candidates = cands.map((m) => {
    for (const id of m.span.ids) add(pr.eventById(id));
    const prior = pr.events({ sid: m.sid, kinds: ['prompt'], before: m.span.first, limit: 2 });
    prior.forEach(add);
    let transcript = null;
    const ref = m.tp[0];
    if (ref) { try { const t = pr.transcript(ref.path, ref.off, 3000); if (t) transcript = trunc(t.lines.map((l) => l.text).join('\n'), 2500); } catch { /* gone */ } }
    return { id: m.id, kind: m.kind, detector_score: m.score, headline: m.headline, actors: m.actors, files: m.files, branch: m.branch, cite: m.span.ids, prior_prompts: prior.map((e) => e.id), t0: new Date(m.t0).toISOString(), t1: new Date(m.t1).toISOString(), transcript };
  });
  const all = [...pr.engine.moments.values()];
  const fb = (st) => all.filter((m) => m.status === st).slice(-6).map((m) => ({ kind: m.kind, headline: m.headline }));
  return {
    schema: 1, instructions: INSTRUCTIONS, generated: new Date().toISOString(), count: candidates.length,
    candidates, events,
    feedback: { confirmed: fb('confirmed'), dismissed: fb('dismissed') },
    threads: pr.engine.openThreads().map((t) => ({ id: t.id, text: t.text, opened_ts: t.opened_ts, opened_by: t.opened_by })),
  };
}

const nums = (s) => (String(s).match(/\d+(?:[.,]\d+)?/g) || []).map((x) => x.replace(',', '.'));
const WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The honesty guard shared by Tier 2 and drafts. Returns null if every number, number-word and quote in claimText
 * can be traced to the events, else a one-line reason. extra: numbers that come from structure (counts of moments, days).
 */
export function claimProblems(claimText, evs, { quotes = [], extra = [], redactFn = null, voiceText = '' } = {}) {
  const times = evs.map((e) => e.t).filter(Boolean);
  const mins = times.length ? Math.round((Math.max(...times) - Math.min(...times)) / 60000) : 0;
  const secs = times.length ? Math.round((Math.max(...times) - Math.min(...times)) / 1000) : 0;
  let factText = evs.map(evText).join('\n') + '\n' + voiceText;
  const facts = new Set(nums(factText));
  for (const n of [mins, secs, evs.length, evs.filter((e) => e.kind === 'tool.fail' || (e.d.test && e.d.test.red)).length, evs.filter((e) => e.kind === 'tool.pre').length, ...extra]) facts.add(String(n));
  const bad = nums(claimText).filter((n) => !facts.has(n));
  if (bad.length) return `number(s) not traceable to the cited events: ${[...new Set(bad)].join(', ')}`;
  const badWord = Object.keys(WORDS).find((w) => new RegExp(`\\b${w}\\b`, 'i').test(claimText) && !facts.has(String(WORDS[w])));
  if (badWord) return `"${badWord}" is not traceable to the cited events`;
  let hay = norm(factText);
  if (redactFn) hay += '\n' + norm(redactFn(factText));
  const badQuote = quotes.find((q) => !hay.includes(norm(q)));
  if (badQuote !== undefined) return `quote is not an exact quote from the cited events: ${trunc(badQuote, 50)}`;
  return null;
}

/** Validate one extractor answer against the log. Returns { ok, items, rejected }. Pure: writes nothing. */
export function validate(pr, answer) {
  const rejected = [], moments = [], merges = [], drops = [], threads = [];
  const rej = (what, reason) => rejected.push({ what: trunc(typeof what === 'string' ? what : JSON.stringify(what), 100), reason });
  const get = (id) => pr.eventById(id);
  const A = answer && typeof answer === 'object' ? answer : {};

  for (const it of A.moments || []) {
    const target = it.target ? pr.engine.moments.get(it.target) : null;
    if (it.target && !target) { rej(it.headline, `unknown target ${it.target}`); continue; }
    const cite = Array.isArray(it.cite) && it.cite.length ? it.cite : target ? target.span.ids : [];
    if (!cite.length) { rej(it.headline, 'no cited events'); continue; }
    const evs = cite.map(get);
    const missing = cite.filter((_, i) => !evs[i]);
    if (missing.length) { rej(it.headline, `cited event(s) not in the log: ${missing.slice(0, 3).join(', ')}`); continue; }
    const kind = it.kind || (target && target.kind);
    if (!KINDS.includes(kind) || kind === 'mark') { rej(it.headline, `invalid kind ${kind}`); continue; }
    if (typeof it.headline !== 'string' || it.headline.trim().length < 5 || it.headline.length > 140) { rej(it.headline, 'headline must be 5-140 chars'); continue; }
    const body = Array.isArray(it.body) ? it.body : [];
    if (body.length > 3 || body.some((l) => typeof l !== 'string' || l.length > 260)) { rej(it.headline, 'body must be at most 3 short lines'); continue; }
    const score = Number(it.score);
    if (!Number.isFinite(score) || score < 0 || score > 100) { rej(it.headline, 'score must be 0-100'); continue; }
    const ev = it.evidence && typeof it.evidence === 'object' ? it.evidence : {};

    // honesty guard
    const times = evs.map((e) => e.t).filter(Boolean);
    const claimText = [it.headline, ...body, ...Object.values(ev).map(String)].join('\n');
    const problem = claimProblems(claimText, evs, { quotes: ['prompt', 'error'].map((k) => ev[k]).filter(Boolean) });
    if (problem) { rej(it.headline, problem); continue; }
    const hay = norm(evs.map(evText).join('\n'));

    const actors = [...new Set(evs.map((e) => e.actor))];
    if (Array.isArray(it.actors) && it.actors.some((a) => !actors.includes(a) && !(target && target.actors.includes(a)))) { rej(it.headline, 'names an actor that is not in the cited events'); continue; }
    moments.push({
      sid: evs[0].sid, d: {
        target: target ? target.id : null, kind, headline: scrubSecrets(it.headline.trim()), body: body.map((l) => scrubSecrets(l)), score: Math.round(score),
        evidence: Object.fromEntries(Object.entries(ev).filter(([, v]) => typeof v === 'string' && v).map(([k, v]) => [k, scrubSecrets(v)])),
        cite, actors: it.actors && it.actors.length ? it.actors : actors, files: Array.isArray(it.files) ? it.files.filter((f) => hay.includes(norm(f))) : [],
        t0: Math.min(...times), t1: Math.max(...times), tp: evs.filter((e) => e.tp).slice(0, 8).map((e) => ({ id: e.id, ...e.tp })),
      },
    });
  }
  for (const m of A.merge || []) {
    const a = pr.engine.moments.get(m.target), b = pr.engine.moments.get(m.into);
    if (!a || !b || a === b) rej(m, 'merge needs two different known moments'); else merges.push({ sid: a.sid, d: { target: a.id, into: b.id } });
  }
  for (const m of A.drop || []) {
    const a = pr.engine.moments.get(m.target);
    if (!a) rej(m, 'unknown target');
    else if (a.status === 'dropped') continue; // an earlier round already did it; a repair round often repeats it
    else if (a.status === 'merged') rej(m, 'already merged into another moment');
    else if (a.status !== 'auto') rej(m, 'a moment the human confirmed or marked cannot be dropped'); else drops.push({ sid: a.sid, d: { target: a.id, reason: trunc(m.reason || '', 160) } });
  }
  for (const t of A.threads || []) {
    const evs = (t.cite || []).map(get);
    if (!evs.length || evs.some((e) => !e)) { rej(t, 'thread change needs cited events that exist'); continue; }
    if (t.op === 'close') {
      const th = pr.engine.threads.get(t.thread);
      if (!th || th.closed) rej(t, 'no such open thread'); else threads.push({ sid: evs[0].sid, d: { op: 'close', thread: th.id, resolution: scrubSecrets(trunc(t.resolution || '', 160)), cite: t.cite } });
    } else if (t.op === 'open' && typeof t.text === 'string' && t.text.length >= 8) threads.push({ sid: evs[0].sid, d: { op: 'open', text: scrubSecrets(trunc(t.text, 200)), cite: t.cite } });
    else rej(t, 'unknown thread op');
  }
  return { moments, merges, drops, threads, rejected };
}

/** Validate then append. Accepted items become extract.* events written by the actor "extractor". */
export function apply(pr, answer) {
  const v = validate(pr, answer);
  const w = (kind, x) => writeHumanEvent(pr.root, kind, x.d, { sid: x.sid, actor: 'extractor' });
  v.moments.forEach((x) => w('extract.moment', x));
  v.merges.forEach((x) => w('extract.merge', x));
  v.drops.forEach((x) => w('extract.drop', x));
  v.threads.forEach((x) => w('extract.thread', x));
  const n = v.moments.length + v.merges.length + v.drops.length + v.threads.length;
  if (n) {
    const sid = (v.moments[0] || v.merges[0] || v.drops[0] || v.threads[0]).sid;
    writeHumanEvent(pr.root, 'extract.run', { n, rejected: v.rejected.length }, { sid, actor: 'extractor' });
  }
  pr.sync();
  return { accepted: { moments: v.moments.length, merges: v.merges.length, drops: v.drops.length, threads: v.threads.length }, rejected: v.rejected };
}

export function parseAnswer(text) {
  const s = String(text || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('no JSON object in the model reply');
  return JSON.parse(s.slice(a, b + 1));
}

/** One extraction call through the Anthropic API with a key the user configured. Returns the reply text. */
export async function askApi(system, user, { model, key, baseUrl } = {}) {
  key = key || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('set ANTHROPIC_API_KEY, or use "auto": "claude" to run through your Claude Code login (or /cts:extract)');
  const res = await fetch(`${baseUrl || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    // Current Haiku thinks by default, so leave room for thinking plus the JSON answer.
    body: JSON.stringify({ model, max_tokens: 16000, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${trunc(await res.text(), 200)}`);
  const j = await res.json();
  if (j.stop_reason === 'refusal') throw new Error('the model declined the packet');
  if (j.stop_reason === 'max_tokens') throw new Error('the reply hit max_tokens before the JSON was complete');
  return (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

/**
 * One extraction call through the user's own Claude Code login (`claude -p`), so no API key is needed. No tools, no MCP
 * servers, no plugins, no session saved, run from an empty temp dir with CTS_SKIP_CAPTURE set so CTS's own hooks do not record the helper session.
 */
export function askClaude(system, user, { model, bin = process.env.CTS_CLAUDE_BIN || 'claude', timeoutMs = 300000 } = {}) {
  return new Promise((ok, no) => {
    // The system prompt goes through a file: a .cmd shim would mangle a long multi-line argument.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-x-'));
    const sysFile = path.join(dir, 'system.txt');
    fs.writeFileSync(sysFile, system);
    const shell = /\.(cmd|bat)$/i.test(bin);
    // --tools "" alone leaves MCP connectors (mail, docs...) callable. --restricted and --strict-mcp-config remove those,
    // the user's plugins and settings too, so text from the log never reaches a model that can act on anything.
    let args = ['-p', '--restricted', '--strict-mcp-config', '--tools', '', '--output-format', 'json', '--no-session-persistence', '--system-prompt-file', sysFile, ...(model ? ['--model', model] : [])];
    if (shell) args = args.map((a) => `"${a}"`);
    const done = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } };
    const child = spawn(shell ? `"${bin}"` : bin, args, { cwd: dir, env: { ...process.env, CTS_SKIP_CAPTURE: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); done(); no(new Error(`claude -p timed out after ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
    child.stdout.on('data', (c) => (out += c)); child.stderr.on('data', (c) => (err += c));
    child.on('error', (e) => { clearTimeout(timer); done(); no(new Error(`could not run ${bin}: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer); done();
      let j = null; try { j = JSON.parse(out); } catch { /* not JSON */ }
      if (Array.isArray(j)) j = j.find((m) => m && m.type === 'result') || null; // some CLI versions print every message
      if (code !== 0 || !j || j.is_error) return no(new Error(`claude -p failed (exit ${code}): ${trunc((j && j.result) || err || out, 200)}`));
      ok(String(j.result || ''));
    });
    child.stdin.end(user);
  });
}

/**
 * Prepare, ask, validate, apply. If the validator rejects items, the model gets one chance to fix exactly those.
 * `ask(system, user)` returns the reply text; tests inject one. Returns { none } or { accepted, rejected, rounds }.
 */
export async function extractNow(pr, { via = 'api', model, min = 30, limit = 12, ask } = {}) {
  const packet = prepare(pr, { min, limit });
  if (!packet.count) return { none: true };
  model = model || pr.cfg.extraction?.model || 'claude-haiku-5-5';
  ask = ask || (via === 'claude' ? (sys, u) => askClaude(sys, u, { model }) : (sys, u) => askApi(sys, u, { model }));
  const { instructions, ...rest } = packet;
  const user = JSON.stringify(rest);
  let r = apply(pr, parseAnswer(await ask(instructions, user)));
  const total = { ...r.accepted }; let rounds = 1;
  if (r.rejected.length) {
    const list = r.rejected.map((x) => `- "${x.what}": ${x.reason}`).join('\n');
    const fix = `${user}\n\nYour previous answer had items the validator rejected:\n${list}\nReturn a JSON object with corrected versions of ONLY those items (same format). Drop an item rather than guess.`;
    r = apply(pr, parseAnswer(await ask(instructions, fix))); rounds = 2;
    for (const k of Object.keys(total)) total[k] += r.accepted[k];
  }
  return { accepted: total, rejected: r.rejected, rounds, count: packet.count };
}

/** `cts extract run`: kept for the CLI; one call through the API without the repair round. */
export async function runApi(pr, { model, baseUrl, key, min, limit } = {}) {
  const packet = prepare(pr, { min, limit });
  if (!packet.count) return { packet, none: true };
  const { instructions, ...rest } = packet;
  const text = await askApi(instructions, JSON.stringify(rest), { model: model || pr.cfg.extraction?.model || 'claude-haiku-5-5', baseUrl, key });
  return { packet, answer: parseAnswer(text) };
}
