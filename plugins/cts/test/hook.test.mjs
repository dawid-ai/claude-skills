import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFrom } from '../src/lib/log.mjs';
import { Project } from '../src/lib/project.mjs';
import { paths } from '../src/lib/util.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'hook.mjs');
const hooksJson = JSON.parse(fs.readFileSync(path.join(path.dirname(HOOK), '..', 'hooks', 'hooks.json'), 'utf8'));
const proj = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-hook-')); fs.mkdirSync(path.join(d, '.git')); return d; };
const fire = (root, payload, env = {}) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: 'sess1', cwd: root, transcript_path: path.join(root, 't.jsonl'), prompt_id: 'p1', permission_mode: 'default', ...payload }), env: { ...process.env, CTS_NO_SERVER: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', ...env }, encoding: 'utf8' });
const lines = (root, sid = 'sess1') => { const f = path.join(paths(root).sessions, sid + '.jsonl'); return fs.existsSync(f) ? readFrom(f).events : []; };

// One payload per registered hook. Shapes follow the Claude Code docs where verified; the rest are best-effort.
const PAYLOADS = {
  SessionStart: { source: 'startup', model: 'claude-sonnet-5-5' },
  UserPromptSubmit: { prompt: 'add a limiter, key sk-ant-abcdefghijklmnopqrstuvwxyz123456' },
  PreToolUse: { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'tu1' },
  PostToolUse: { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'tu1', tool_response: { stdout: 'Tests: 3 passed, 3 total', stderr: '' } },
  PostToolUseFailure: { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'tu2', error: 'Tests: 1 failed, 2 passed, 3 total' },
  PostToolBatch: {},
  SubagentStart: { agent_id: 'a1', agent_type: 'planner' },
  SubagentStop: { agent_id: 'a1', agent_type: 'planner', last_assistant_message: 'The plan is complete.' },
  Stop: { last_assistant_message: 'Done.' },
  StopFailure: { error: 'rate_limit' },
  PreCompact: { trigger: 'auto' },
  PostCompact: { trigger: 'auto', summary: 'summary text' },
  PreModelSwitch: { from_model: 'claude-sonnet-5-5', to_model: 'claude-opus-5-5' },
  PostModelSwitch: { from_model: 'claude-sonnet-5-5', to_model: 'claude-opus-5-5' },
  SessionEnd: { reason: 'other' },
  Notification: { message: 'Claude needs your permission', notification_type: 'permission_prompt' },
  PermissionRequest: { tool_name: 'Bash', tool_input: { command: 'rm -rf x' } },
  PermissionDenied: { tool_name: 'Bash', tool_input: { command: 'rm -rf x' }, reason: 'denied' },
  TaskCreated: { task_id: 't1', task_subject: 'write tests' },
  TaskCompleted: { task_id: 't1' },
  TeammateIdle: { teammate_name: 'qa' },
  CwdChanged: { new_cwd: '/tmp/x' },
  DirectoryAdded: { directory: '/tmp/y' },
  Elicitation: { mcp_server_name: 'x', message: 'pick one' },
  ElicitationResult: { mcp_server_name: 'x', action: 'accept' },
};

test('hooks.json registers exactly the hooks we have payloads for; only SessionStart is synchronous', () => {
  assert.deepEqual(Object.keys(hooksJson.hooks).sort(), Object.keys(PAYLOADS).sort());
  for (const [name, arr] of Object.entries(hooksJson.hooks)) {
    const h = arr[0].hooks[0];
    assert.equal(h.type, 'command'); assert.match(h.command, /\$\{CLAUDE_PLUGIN_ROOT\}\/src\/hook\.mjs/);
    assert.equal(!!h.async, name !== 'SessionStart', name);
  }
});

test('every hook event produces exactly one valid, attributed JSONL line and no stdout/stderr', () => {
  const root = proj();
  const names = Object.keys(PAYLOADS);
  for (const [i, name] of names.entries()) {
    const r = fire(root, { hook_event_name: name, ...PAYLOADS[name] });
    assert.equal(r.status, 0, name);
    assert.equal(r.stderr, '', name);
    if (name !== 'SessionStart') assert.equal(r.stdout, '', name);
    const evs = lines(root);
    assert.equal(evs.length, i + 1, `${name} wrote exactly one line`);
    assert.equal(evs[i].hook, name);
    assert.ok(evs[i].id && evs[i].ts && evs[i].kind && evs[i].actor);
  }
  const evs = lines(root);
  assert.equal(evs.find((e) => e.hook === 'UserPromptSubmit').actor, 'human');
  assert.equal(evs.find((e) => e.hook === 'SubagentStop').actor, 'agent:a1');
  assert.equal(evs.find((e) => e.hook === 'SubagentStop').agent_type, 'planner');
  assert.equal(evs.find((e) => e.hook === 'Stop').actor, 'main');
  assert.equal(evs.find((e) => e.hook === 'PostToolUse').d.test.pass, 3);
  assert.equal(evs.find((e) => e.hook === 'PostToolUseFailure').d.test.red, true);
  assert.match(evs.find((e) => e.hook === 'UserPromptSubmit').d.text, /\[redacted\]/, 'secrets never enter the log');
  assert.ok(!JSON.stringify(evs).includes('abcdefghijklmnopqrstuvwxyz123456'));
  assert.deepEqual(evs.find((e) => e.hook === 'Notification').d.extra.message, 'Claude needs your permission');
  assert.ok(fs.existsSync(path.join(paths(root).cts, '.gitignore')));
});

test('three concurrent subagents produce three attributed lanes joined to their own transcripts', () => {
  const root = proj();
  const sub = path.join(root, 't', 'subagents'); fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(root, 't.jsonl'), '{"type":"user"}\n');
  for (const id of ['a1', 'a2', 'a3']) fs.writeFileSync(path.join(sub, `agent-${id}.jsonl`), `{"type":"assistant","who":"${id}"}\n`);
  const procs = ['a1', 'a2', 'a3'].flatMap((id) => ['SubagentStart', 'PreToolUse', 'PostToolUse', 'SubagentStop'].map((h) => ({ id, h })));
  for (const { id, h } of procs) fire(root, { hook_event_name: h, agent_id: id, agent_type: { a1: 'planner', a2: 'evaluator', a3: 'cts:reviewer' }[id], tool_name: 'Read', tool_input: { file_path: 'a.js' }, tool_use_id: id + h, last_assistant_message: 'ok done here' });
  const evs = lines(root);
  assert.equal(evs.length, 12);
  for (const id of ['a1', 'a2', 'a3']) {
    const mine = evs.filter((e) => e.actor === 'agent:' + id);
    assert.equal(mine.length, 4);
    assert.ok(mine.every((e) => e.tp && e.tp.path.endsWith(`agent-${id}.jsonl`)), 'joined to the subagent transcript');
  }
  const pr = Project.open(root);
  const lanes = pr.engine.sessions.get('sess1').actors;
  assert.deepEqual([...lanes.keys()], ['human', 'main', 'agent:a1', 'agent:a2', 'agent:a3']);
  assert.equal(lanes.get('agent:a3').label, 'cts:reviewer');
  pr.close();
});

test('transcript byte offsets point at real positions', () => {
  const root = proj(); fs.writeFileSync(path.join(root, 't.jsonl'), 'x'.repeat(1234));
  fire(root, { hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
  assert.deepEqual(lines(root)[0].tp, { path: path.join(root, 't.jsonl'), off: 1234 });
});

test('a git commit through Bash is enriched with branch, subject, files and diff stat', () => {
  const root = proj(); fs.rmSync(path.join(root, '.git'), { recursive: true });
  const g = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 'a@b.c'); g('config', 'user.name', 'T');
  fs.writeFileSync(path.join(root, 'a.js'), 'one\ntwo\n'); g('add', '.'); g('commit', '-q', '-m', 'first commit');
  fire(root, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -m "first commit"' }, tool_use_id: 'g1', tool_response: { stdout: '[main abc] first commit' } });
  const e = lines(root)[0];
  assert.equal(e.d.git.op, 'commit'); assert.equal(e.d.git.branch, 'main'); assert.equal(e.d.git.subject, 'first commit');
  assert.deepEqual(e.d.git.files, ['a.js']); assert.deepEqual(e.d.git.stat, { files: 1, ins: 2, del: 0 });
  const pr = Project.open(root);
  assert.ok(pr.engine.listMoments().some((m) => m.kind === 'shipped' && /first commit/.test(m.headline)));
  pr.close();
});

test('pause: nothing is recorded while paused; broken input never surfaces', () => {
  const root = proj();
  fire(root, { hook_event_name: 'UserPromptSubmit', prompt: 'before' });
  fs.writeFileSync(paths(root).paused, 'x');
  fire(root, { hook_event_name: 'UserPromptSubmit', prompt: 'secret work' });
  fs.rmSync(paths(root).paused);
  fire(root, { hook_event_name: 'UserPromptSubmit', prompt: 'after' });
  const evs = lines(root);
  assert.deepEqual(evs.map((e) => e.d.text), ['before', 'after']);
  assert.ok(!fs.readFileSync(path.join(paths(root).sessions, 'sess1.jsonl'), 'utf8').includes('secret work'));
  const r = spawnSync(process.execPath, [HOOK], { input: '{not json', cwd: root, encoding: 'utf8', env: { ...process.env, CTS_NO_SERVER: '1' } });
  assert.equal(r.status, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
});

test('SessionStart injects open threads and the last moment as additional context', () => {
  const root = proj();
  fs.mkdirSync(paths(root).cts, { recursive: true });
  fs.writeFileSync(paths(root).context, JSON.stringify({ threads: [{ id: 'x', text: 'Redis or in-memory for the limiter?', opened_ts: new Date(Date.now() - 3 * 86400e3).toISOString(), opened_by: 'main' }], last: { headline: 'evaluator rejected plan', kind: 'disagreement', score: 70 } }));
  const r = fire(root, { hook_event_name: 'SessionStart', source: 'resume' });
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /1 open thread/);
  assert.match(out.hookSpecificOutput.additionalContext, /Redis or in-memory/);
  assert.match(out.hookSpecificOutput.additionalContext, /evaluator rejected plan/);
});

test('hook overhead: median time CTS adds per event on top of Node startup stays under 50 ms', () => {
  // The acceptance budget is 100 ms per event. Node's own startup varies by platform (about 70-200 ms on Windows), so the
  // test checks what CTS adds, with runs interleaved with bare Node so background load hits both sides equally.
  const root = proj();
  const times = [], bare = [];
  for (let i = 0; i < 25; i++) {
    let t = process.hrtime.bigint(); fire(root, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'a' }, tool_use_id: 'u' + i }); times.push(Number(process.hrtime.bigint() - t) / 1e6);
    t = process.hrtime.bigint(); spawnSync(process.execPath, ['-e', '0']); bare.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  times.sort((a, b) => a - b); bare.sort((a, b) => a - b);
  const med = times[12], base = bare[12];
  console.log(`# hook median ${med.toFixed(1)} ms (bare node ${base.toFixed(1)} ms; CTS adds ~${(med - base).toFixed(1)} ms)`);
  assert.ok(med - base < 50, `CTS adds ${(med - base).toFixed(1)} ms`);
  assert.equal(lines(root).length, 25);
});

test('killing mid-write loses at most the last line and the log stays parseable', () => {
  const root = proj();
  for (let i = 0; i < 5; i++) fire(root, { hook_event_name: 'UserPromptSubmit', prompt: 'p' + i });
  const f = path.join(paths(root).sessions, 'sess1.jsonl');
  fs.appendFileSync(f, '{"v":1,"id":"01TRUNC');
  const r = readFrom(f);
  assert.equal(r.events.length, 5);
  fire(root, { hook_event_name: 'UserPromptSubmit', prompt: 'after crash' });
  // the truncated fragment fuses with the next line; that one line is lost, the rest are intact
  assert.ok(readFrom(f).events.length >= 5);
});

test('SessionStart shows the user one line about drafts awaiting review, unless notify.terminal is off', () => {
  const root = proj();
  fs.mkdirSync(paths(root).cts, { recursive: true });
  fs.writeFileSync(paths(root).context, JSON.stringify({ threads: [], pending_drafts: 2 }));
  let out = JSON.parse(fire(root, { hook_event_name: 'SessionStart', source: 'startup' }).stdout);
  assert.match(out.systemMessage, /^CTS: 2 drafted posts await your review/);
  assert.match(out.hookSpecificOutput.additionalContext, /Do not approve or publish them yourself/);
  fs.writeFileSync(paths(root).config, JSON.stringify({ notify: { terminal: false } }));
  out = JSON.parse(fire(root, { hook_event_name: 'SessionStart', source: 'startup' }).stdout);
  assert.equal(out.systemMessage, undefined);
});

test('a background task notification injected as a user turn is not a human prompt', () => {
  const root = proj();
  fire(root, { hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>a1</task-id>\n<result>keep it for now, revisit later</result>\n</task-notification>' });
  fire(root, { hook_event_name: 'UserPromptSubmit', prompt: 'wait, keep it for now' });
  const evs = lines(root);
  assert.deepEqual(evs.map((e) => [e.kind, e.actor]), [['notify', 'main'], ['prompt', 'human']]);
  assert.equal(evs[0].d.synthetic, 'task-notification');
  assert.match(evs[1].d.who, /^[0-9a-f]{12}$/);
});

test('a prompt in a headless session (`CLAUDE_CODE_ENTRYPOINT=sdk-cli`) is attributed to the caller', () => {
  const root = proj();
  fire(root, { hook_event_name: 'SessionStart', source: 'startup' }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' });
  fire(root, { hook_event_name: 'UserPromptSubmit', prompt: 'Reply with JSON only.' }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' });
  fire(root, { hook_event_name: 'UserPromptSubmit', prompt: 'and from the IDE' }, { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' });
  const [start, p, q] = lines(root);
  assert.equal(start.d.headless, 'sdk-cli');
  assert.equal(p.actor, 'caller'); assert.equal(p.d.who, undefined);
  assert.equal(q.actor, 'human'); assert.ok(q.d.who, 'interactive surfaces other than the CLI are still you');
});
