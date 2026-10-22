import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importTranscripts, encodeProjectDir, transcriptDir } from '../src/lib/transcripts.mjs';
import { Project } from '../src/lib/project.mjs';
import { paths, serialize } from '../src/lib/util.mjs';
import { Sim } from './helpers.mjs';

const T0 = Date.parse('2026-07-01T09:00:00Z');
const ts = (m) => new Date(T0 + m * 60000).toISOString();
const rec = (o) => JSON.stringify(o) + '\n';
const user = (m, content, extra = {}) => rec({ type: 'user', timestamp: ts(m), sessionId: 'old1', cwd: '/w', gitBranch: 'main', message: { role: 'user', content }, ...extra });
const asst = (m, content, model = 'claude-sonnet-5-5') => rec({ type: 'assistant', timestamp: ts(m), sessionId: 'old1', gitBranch: 'main', message: { role: 'assistant', model, content } });
const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
const res = (id, text, err = false) => ({ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], is_error: err });

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-tr-'));
  const dir = path.join(base, 'proj'); fs.mkdirSync(path.join(dir, 'old1', 'subagents'), { recursive: true });
  const lines = [
    rec({ type: 'ai-title', aiTitle: 'Old limiter work', sessionId: 'old1' }),
    user(0, '<system-reminder>ignore me</system-reminder>', { isMeta: true }),
    user(1, 'add a limiter'),
    asst(2, [{ type: 'text', text: 'On it.' }, use('t1', 'Bash', { command: 'npm test' })]),
    user(3, [res('t1', 'Tests: 2 failed, 3 passed, 5 total', true)]),
    asst(4, [use('t2', 'Bash', { command: 'npm test' })]),
    user(5, [res('t2', 'Tests: 5 passed, 5 total')], { toolUseResult: {} }),
    asst(6, [use('t3', 'Agent', { subagent_type: 'evaluator', description: 'review' })]),
    user(7, [res('t3', 'Rejected: missing rollback.')], { toolUseResult: { agentId: 'ag1', agentType: 'evaluator' } }),
    user(8, 'wait, go back'),
    rec({ type: 'user', timestamp: ts(9), sessionId: 'old1', isCompactSummary: true, message: { role: 'user', content: 'summary of the work so far' } }),
    asst(10, [use('t4', 'Bash', { command: 'git commit -m "limiter done"' })], 'claude-opus-5-5'),
    user(11, [res('t4', '[main abc] limiter done')]),
    asst(12, [{ type: 'text', text: 'Committed. Done.' }]),
  ];
  fs.writeFileSync(path.join(dir, 'old1.jsonl'), lines.join(''));
  const sub = [
    rec({ type: 'user', isSidechain: true, agentId: 'ag1', timestamp: ts(6.5), sessionId: 'old1', message: { role: 'user', content: 'review the plan' } }),
    rec({ type: 'assistant', isSidechain: true, agentId: 'ag1', timestamp: ts(6.8), sessionId: 'old1', message: { role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'Rejected: missing rollback.' }] } }),
  ];
  fs.writeFileSync(path.join(dir, 'old1', 'subagents', 'agent-ag1.jsonl'), sub.join(''));
  fs.writeFileSync(path.join(dir, 'old1', 'subagents', 'agent-ag1.meta.json'), JSON.stringify({ agentType: 'evaluator' }));
  return { dir, lines };
}
const proj = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-trp-')); fs.mkdirSync(path.join(d, '.git')); return d; };

test('project directory encoding matches Claude Code', () => {
  assert.equal(encodeProjectDir('/home/claude'), '-home-claude');
  assert.equal(encodeProjectDir('F:\\88_CODE\\CTS'), 'F--88-CODE-CTS');
  assert.equal(path.basename(transcriptDir('/nope/x', '/nonexistent')), '-nope-x');
});

test('transcript import: attribution, enrichment, offsets and the detectors all work on past sessions', () => {
  const { dir, lines } = fixture(); const root = proj();
  const r = importTranscripts(root, { dir });
  assert.equal(r.sessions, 1); assert.equal(r.subagents, 1); assert.ok(r.events >= 14);
  const pr = Project.open(root);
  const evs = pr.events({ order: 'asc', limit: 200 });
  const kinds = evs.map((e) => e.kind);
  for (const k of ['session.start', 'prompt', 'tool.pre', 'tool.post', 'tool.fail', 'compact.post', 'model.post', 'turn.end', 'session.end', 'subagent.start', 'subagent.stop']) assert.ok(kinds.includes(k), k);
  assert.ok(!evs.some((e) => e.kind === 'prompt' && /ignore me/.test(e.d.text)), 'system reminders are not prompts');
  assert.equal(evs.find((e) => e.kind === 'prompt' && /wait/.test(e.d.text)).actor, 'human');
  const sub = evs.filter((e) => e.actor === 'agent:ag1');
  assert.equal(sub.length, 2); assert.equal(sub[0].agent_type, 'evaluator');
  assert.ok(sub[0].tp.path.endsWith('agent-ag1.jsonl'));
  const fail = evs.find((e) => e.kind === 'tool.fail');
  assert.equal(fail.d.test.red, true); assert.equal(fail.d.test.fail, 2);
  const commit = evs.find((e) => e.d.git && e.d.git.op === 'commit');
  assert.equal(commit.d.git.branch, 'main'); assert.equal(commit.d.git.subject, 'limiter done');
  // the byte offset points at the transcript line that justified the event
  const fileText = fs.readFileSync(path.join(dir, 'old1.jsonl'));
  const pre = evs.find((e) => e.kind === 'tool.pre' && e.d.tool_use_id === 't4');
  assert.ok(fileText.toString('utf8', pre.tp.off, pre.tp.off + 60).includes('"assistant"'));
  assert.equal(pr.engine.sessions.get('old1').title, undefined);
  const mk = pr.engine.listMoments().map((m) => m.kind);
  assert.ok(mk.includes('reversal') && mk.includes('shipped') && mk.includes('memory-cut') === false);
  assert.ok(pr.engine.sessionList()[0].start === T0 + 60000 || pr.engine.sessionList()[0].start >= T0);
  pr.close();
  // idempotent and byte-identical
  const f = path.join(paths(root).sessions, 'old1.jsonl'); const a = fs.readFileSync(f, 'utf8');
  importTranscripts(root, { dir }); assert.equal(fs.readFileSync(f, 'utf8'), a);
  void lines;
});

test('sessions captured live are never overwritten by an import', () => {
  const { dir } = fixture(); const root = proj();
  const sim = new Sim({ sid: 'old1' }); sim.start(); sim.prompt('live'); fs.mkdirSync(paths(root).sessions, { recursive: true });
  fs.writeFileSync(path.join(paths(root).sessions, 'old1.jsonl'), sim.events.map(serialize).join(''));
  const r = importTranscripts(root, { dir });
  assert.equal(r.skippedLive, 1); assert.equal(r.sessions, 0);
  assert.match(fs.readFileSync(path.join(paths(root).sessions, 'old1.jsonl'), 'utf8'), /"live"/);
});

test('three months of transcripts import in well under a minute', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-big-')); const dir = path.join(base, 'p'); fs.mkdirSync(dir);
  let total = 0;
  for (let s = 0; s < 90; s++) {
    const out = []; let m = s * 1440;
    out.push(JSON.stringify({ type: 'user', timestamp: ts(m), sessionId: 's' + s, message: { role: 'user', content: 'work on item ' + s } }) + '\n');
    for (let i = 0; i < 300; i++) {
      out.push(JSON.stringify({ type: 'assistant', timestamp: ts(m + i), sessionId: 's' + s, message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [use('u' + i, i % 5 ? 'Read' : 'Bash', i % 5 ? { file_path: 'a.js' } : { command: 'npm test' })] } }) + '\n');
      out.push(JSON.stringify({ type: 'user', timestamp: ts(m + i + 0.5), sessionId: 's' + s, message: { role: 'user', content: [res('u' + i, i % 5 ? 'ok' : (i % 50 < 15 ? 'Tests: 1 failed, 2 passed' : 'Tests: 3 passed'), i % 5 === 0 && i % 50 < 15)] } }) + '\n');
      total += 2;
    }
    fs.writeFileSync(path.join(dir, `s${s}.jsonl`), out.join(''));
  }
  const root = proj(); const t = Date.now();
  const r = importTranscripts(root, { dir });
  const pr = Project.open(root);
  const took = Date.now() - t;
  console.log(`# imported ${r.events.toLocaleString()} events from ${r.sessions} sessions and indexed them in ${took} ms`);
  assert.ok(took < 60000); assert.ok(pr.engine.listMoments().length > 0);
  pr.close();
});

test('a headless `claude -p` session (an app calling Claude Code) is the caller\'s, not yours', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-trh-')), dir = path.join(base, 'proj'); fs.mkdirSync(dir);
  const sdk = { entrypoint: 'sdk-cli', sessionId: 'hd1' };
  fs.writeFileSync(path.join(dir, 'hd1.jsonl'), [
    rec({ type: 'user', timestamp: ts(0), cwd: '/w', message: { role: 'user', content: "Don't call any tools. Reply with only this JSON object." }, ...sdk }),
    rec({ type: 'assistant', timestamp: ts(1), message: { role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: '{"notes":[]}' }] }, ...sdk }),
  ].join(''));
  fs.writeFileSync(path.join(dir, 'me1.jsonl'), user(0, "don't touch the config", { sessionId: 'me1', entrypoint: 'cli' }));
  const root = proj();
  const prev = process.env.CLAUDE_CODE_ENTRYPOINT; process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli'; // an import run from inside `claude -p`
  try { importTranscripts(root, { dir }); } finally { if (prev === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT; else process.env.CLAUDE_CODE_ENTRYPOINT = prev; }
  const pr = Project.open(root);
  const prompts = pr.events({ kinds: ['prompt'], order: 'asc', limit: 10 });
  const hp = prompts.find((e) => e.sid === 'hd1'), mp = prompts.find((e) => e.sid === 'me1');
  assert.equal(hp.actor, 'caller'); assert.equal(hp.d.headless, 'sdk-cli'); assert.equal(hp.d.who, undefined);
  assert.equal(mp.actor, 'human', 'the transcript says cli: the importing process does not decide');
  const s = pr.engine.sessionList().find((x) => x.sid === 'hd1');
  assert.equal(s.headless, 'sdk-cli'); assert.equal(s.actors.find((a) => a.id === 'caller').label, 'claude -p');
  const kinds = pr.engine.listMoments().map((m) => `${m.sid}:${m.kind}`);
  assert.ok(!kinds.includes('hd1:refusal'), "a program's \"Don't call any tools\" is not you saying no");
  assert.ok(kinds.includes('me1:refusal'));
  pr.close();
});
