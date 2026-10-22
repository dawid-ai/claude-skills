import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Project } from '../src/lib/project.mjs';
import { paths, serialize, readJson, pidAlive } from '../src/lib/util.mjs';
import { buildStoryHtml, publicData, cardSvg, CARD_SIZES } from '../src/lib/share.mjs';
import { Sim } from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CTS = path.join(ROOT, 'bin', 'cts');
const proj = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-cli-')); fs.mkdirSync(path.join(d, '.git')); fs.mkdirSync(path.join(d, '.cts')); fs.writeFileSync(path.join(d, '.cts', 'cts.json'), JSON.stringify({ port: 0 })); return d; };
const cts = (root, ...a) => spawnSync(process.execPath, [CTS, ...a], { cwd: root, encoding: 'utf8', env: { ...process.env, CTS_NO_SERVER: '1' } });
const write = (root, sim) => { const p = paths(root); fs.mkdirSync(p.sessions, { recursive: true }); fs.writeFileSync(path.join(p.sessions, sim.sid + '.jsonl'), sim.events.map(serialize).join('')); };

test('every command prints help with --help and exits 0; bare `cts` prints usage', () => {
  const root = proj();
  assert.match(cts(root).stdout, /usage: cts/);
  for (const c of ['init', 'open', 'status', 'mark', 'dismiss', 'confirm', 'threads', 'digest', 'pause', 'resume', 'reindex', 'share', 'export', 'import', 'demo', 'statusline', 'subagent-statusline', 'watch', 'trim', 'consent', 'doctor', 'serve', 'draft', 'queue', 'voice', 'extract']) {
    const r = cts(root, c, '--help');
    assert.equal(r.status, 0, c); assert.ok(r.stdout.trim().length > 10, c);
  }
});

test('commands with no arguments work on an empty project', () => {
  const root = proj();
  for (const c of ['status', 'threads', 'digest', 'doctor', 'statusline', 'reindex']) { const r = cts(root, c); assert.equal(r.status, 0, `${c}: ${r.stderr}`); }
  assert.equal(cts(root, 'statusline').stdout, '', 'status line prints nothing when the server is down');
});

test('mark, mark ?, dismiss, pause and resume go through the log', () => {
  const root = proj(); const sim = new Sim({ sid: 'cur', start: Date.now() - 20000 }); sim.start(); sim.prompt('wait, undo that'); write(root, sim);
  cts(root, 'dismiss');
  let pr = Project.open(root);
  assert.equal(pr.engine.listMoments({ min: 1 }).length, 0, 'the auto-detected reversal is dismissed');
  assert.equal(pr.engine.weight('reversal'), 0.9);
  pr.close();
  assert.match(cts(root, 'mark', 'the', 'good', 'bit').stdout, /marked: the good bit/);
  assert.match(cts(root, 'mark', '?', 'cache', 'strategy?').stdout, /opened a thread/);
  pr = Project.open(root);
  const mk = pr.engine.listMoments().find((m) => m.kind === 'mark');
  assert.equal(mk.score, 100); assert.equal(mk.note, 'the good bit');
  assert.equal(pr.engine.openThreads()[0].text, 'cache strategy?');
  pr.close();
  assert.match(cts(root, 'pause').stdout, /paused/);
  assert.ok(fs.existsSync(paths(root).paused));
  assert.match(cts(root, 'resume').stdout, /resumed/);
  pr = Project.open(root);
  const kinds = pr.events({ order: 'asc', limit: 100 }).map((e) => e.kind);
  assert.ok(kinds.includes('pause') && kinds.includes('resume'), 'the gap is a visible paused span');
  pr.close();
});

test('mark returns in well under 100 ms of our own time', () => {
  // Node's own startup varies by platform (about 70-200 ms on Windows), so the budget is what CTS adds on top of it.
  // Runs are interleaved with bare Node so background load hits both sides equally.
  const root = proj();
  const times = [], bare = [];
  for (let i = 0; i < 9; i++) {
    let t = process.hrtime.bigint(); cts(root, 'mark', 'x'); times.push(Number(process.hrtime.bigint() - t) / 1e6);
    t = process.hrtime.bigint(); spawnSync(process.execPath, ['-e', '0']); bare.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  times.sort((a, b) => a - b); bare.sort((a, b) => a - b);
  console.log(`# mark median ${times[4].toFixed(0)} ms (bare node ${bare[4].toFixed(0)} ms)`);
  assert.ok(times[4] - bare[4] < 50, `mark adds ${(times[4] - bare[4]).toFixed(0)} ms`);
});

test('server lifecycle via CLI: open starts it, statusline reads it, it works without it', async () => {
  const root = proj(); const sim = new Sim({ sid: 's', start: Date.now() - 60000 }); sim.start(); sim.prompt('wait, undo that'); write(root, sim);
  const r = spawnSync(process.execPath, [CTS, 'open', '--no-browser'], { cwd: root, encoding: 'utf8' });
  assert.match(r.stdout, /http:\/\/localhost:\d+/);
  const s = readJson(paths(root).server);
  try {
    assert.ok(pidAlive(s.pid));
    const sl = cts(root, 'statusline').stdout;
    assert.match(sl, /^CTS ● 1 moment · 0 open threads · last: "You pulled back/);
    assert.match(cts(root, 'status').stdout, /running on/);
    const res = await fetch(`http://localhost:${s.port}/api/summary`); assert.equal((await res.json()).moments, 1);
  } finally { process.kill(s.pid); await new Promise((ok) => setTimeout(ok, 300)); }
  assert.equal(cts(root, 'statusline').stdout, '');
});

test('MCP: Claude can answer "what is still undecided?" with the same answer the dashboard shows', () => {
  const root = proj(); const sim = new Sim({ sid: 'm', start: Date.now() - 600000 });
  sim.start(); sim.prompt('go'); sim.stop('Wired it up with a flat file for now, revisit the storage layer later.'); write(root, sim);
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'cts_threads', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'cts_mark', arguments: { note: 'chose sqlite', thread: false } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'cts_moments', arguments: { min_score: 0 } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'cts_search', arguments: { query: 'flat file' } } },
  ];
  const r = spawnSync(process.execPath, [path.join(ROOT, 'src', 'mcp.mjs')], { input: msgs.map((m) => JSON.stringify(m)).join('\n') + '\n', env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: 'utf8' });
  const out = Object.fromEntries(r.stdout.trim().split('\n').map((l) => JSON.parse(l)).map((o) => [o.id, o]));
  assert.equal(out[1].result.serverInfo.name, 'cts');
  assert.deepEqual(out[2].result.tools.map((t) => t.name), ['cts_moments', 'cts_threads', 'cts_search', 'cts_mark', 'cts_drafts']);
  const pr = Project.open(root);
  assert.ok(out[3].result.content[0].text.includes(pr.engine.openThreads()[0].text));
  assert.match(out[4].result.content[0].text, /Marked/);
  assert.match(out[5].result.content[0].text, /mark/);
  assert.match(out[6].result.content[0].text, /flat file/);
  pr.close();
});

test('share/export: planted client names, paths, emails and secrets never reach the story, cards or exports', () => {
  const root = proj();
  const cfg = { port: 0, redact: { deny: ['Acme Corp', 'Project Nightingale'] } };
  fs.writeFileSync(path.join(root, '.cts', 'cts.json'), JSON.stringify(cfg));
  const sim = new Sim({ sid: 'leak', start: Date.now() - 3600e3, cwd: root }); sim.start();
  sim.prompt('wait, no. use the Acme Corp endpoint https://api.acmecorp.internal/v1 and email maria.lopez@acmecorp.com from /home/dawid/clients/acme/pay.ts');
  sim.bash('git commit -m "Project Nightingale: wire secret_token=abcd1234efgh5678 into src/clients/acme/ledger.ts"', { git: { branch: 'main', subject: 'Project Nightingale: wire secret_token=abcd1234efgh5678 into src/clients/acme/ledger.ts', files: ['src/clients/acme/ledger.ts'], stat: { files: 1, ins: 9, del: 1 } } });
  for (let i = 0; i < 3; i++) sim.bash('npm test', { ok: false, out: 'FAIL at /home/dawid/clients/acme/pay.ts password="hunter2hunter2"' }, { actor: 'main' });
  sim.bash('npm test', { out: 'Tests: 5 passed, 5 total' });
  write(root, sim);
  const pr = Project.open(root);
  assert.ok(pr.engine.listMoments().length >= 3);
  const needles = ['Acme Corp', 'acmecorp', 'maria.lopez', '/home/dawid', 'clients/acme', 'Nightingale', 'abcd1234efgh5678', 'hunter2', 'ledger.ts'];
  const blobs = [buildStoryHtml(pr), JSON.stringify(publicData(pr)), ...publicData(pr).moments.flatMap((m) => Object.keys(CARD_SIZES).map((s) => cardSvg(m, s)))];
  pr.close();
  for (const f of ['moments', 'threads', 'events']) for (const fmt of ['json', 'csv']) blobs.push(cts(root, 'export', f, '--format', fmt).stdout);
  const shareDir = path.join(root, 'out'); const sh = cts(root, 'share', '--cards', '--out', shareDir); assert.equal(sh.status, 0, sh.stderr);
  for (const f of fs.readdirSync(shareDir)) blobs.push(fs.readFileSync(path.join(shareDir, f), 'utf8'));
  assert.ok(blobs[0].length > 500 && blobs[1].length > 100);
  for (const b of blobs) for (const n of needles) assert.ok(!b.includes(n), `leaked "${n}" in: ${b.slice(0, 300)}`);
  assert.match(blobs[0], /redaction|Redaction/i);
  const raw = cts(root, 'export', 'moments', '--raw').stdout; assert.ok(raw.includes('Acme Corp'), '--raw is the local escape hatch');
});

test('private projects disable share and export', () => {
  const root = proj(); fs.writeFileSync(path.join(root, '.cts', 'cts.json'), JSON.stringify({ private: true }));
  assert.match(cts(root, 'share').stdout, /private/); assert.match(cts(root, 'export', 'moments').stdout, /private/);
});

test('import git: merges, reverts and tags become events and moments; re-import is idempotent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-git-'));
  const g = (...a) => { const r = spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' }); return r.stdout; };
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 'a@b.c'); g('config', 'user.name', 'T');
  fs.writeFileSync(path.join(root, 'a'), '1'); g('add', '.'); g('commit', '-q', '-m', 'init');
  g('checkout', '-q', '-b', 'feat'); fs.writeFileSync(path.join(root, 'b'), '2'); g('add', '.'); g('commit', '-q', '-m', 'feat work');
  g('checkout', '-q', 'main'); g('merge', '-q', '--no-ff', 'feat', '-m', 'Merge feat'); g('tag', 'v0.1.0');
  fs.writeFileSync(path.join(root, 'c'), '3'); g('add', '.'); g('commit', '-q', '-m', 'oops'); g('revert', '--no-edit', 'HEAD');
  const r = cts(root, 'import', 'git'); assert.match(r.stdout, /imported 3 /, r.stdout + r.stderr);
  let pr = Project.open(root);
  const kinds = pr.engine.listMoments().map((m) => m.kind).sort();
  assert.deepEqual(kinds, ['reversal', 'shipped', 'shipped']);
  pr.close();
  cts(root, 'import', 'git');
  pr = Project.open(root); assert.equal(pr.engine.listMoments().length, 3); pr.close();
});

test('demo loads, produces every headline detector, and clears', () => {
  const root = proj();
  assert.match(cts(root, 'demo').stdout, /loaded/);
  const pr = Project.open(root);
  const kinds = new Set(pr.engine.listMoments().map((m) => m.kind));
  for (const k of ['fight', 'reversal', 'disagreement', 'shipped', 'broke', 'refusal', 'memory-cut', 'escalation']) assert.ok(kinds.has(k), k);
  assert.ok(pr.engine.openThreads().length >= 1);
  assert.equal(pr.engine.sessionList().length, 2);
  pr.close();
  assert.match(cts(root, 'demo', 'clear').stdout, /removed 2/);
});

test('draft → queue → approve → publish through the CLI; pause publishing stops it; import transcripts --help', () => {
  const root = proj(); const sim = new Sim({ sid: 'cur', start: Date.now() - 600000 }); sim.start();
  sim.prompt('add a limiter'); sim.adv(1); sim.prompt('wait, go back to the old refill logic'); sim.adv(1); sim.stop('ok');
  write(root, sim);
  let r = cts(root, 'draft', 'last');
  assert.equal(r.status, 0, r.stderr + r.stdout); assert.match(r.stdout, /I stopped and pulled the work back to an earlier direction\./); assert.ok(!r.stdout.includes('refill logic'), 'the post tells it, it does not quote the prompt');
  assert.match(cts(root, 'draft', 'last', '--via', 'nope').stdout, /--via must be template, claude or api/); assert.match(r.stdout, /honesty guard: ok/);
  r = cts(root, 'queue'); assert.match(r.stdout, /pending/); assert.match(r.stdout, /1 pending/);
  const id = /^(\w{8})\s+pending/m.exec(r.stdout)[1];
  assert.match(cts(root, 'draft', 'last').stdout, /already exists/);
  cts(root, 'pause', 'publishing');
  r = cts(root, 'queue', 'approve', id); assert.match(r.stdout, /not published: publishing is paused/);
  cts(root, 'resume', 'publishing');
  r = cts(root, 'queue', 'publish'); assert.match(r.stdout, /published .cts\/outbox\/x\//);
  const out = fs.readdirSync(path.join(root, '.cts', 'outbox', 'x'));
  assert.equal(out.length, 1);
  assert.match(fs.readFileSync(path.join(root, '.cts', 'outbox', 'x', out[0]), 'utf8'), /^I stopped and pulled the work back/);
  assert.match(cts(root, 'queue', 'list', '--all').stdout, /published/);
  r = cts(root, 'voice', 'show'); assert.match(r.stdout, /CTS voice/);
});

test('subagent status line: one row per agent with moments, matched by id or a unique agent type; nothing otherwise', () => {
  const root = proj();
  const sim = new Sim({ sid: 'sa', start: Date.now() - 600000 });
  sim.start();
  sim.subStart('a1', 'planner', 'planner'); sim.adv(3); sim.subStop('a1', 'planner', 'The plan is complete and ready to implement.');
  sim.adv(2); sim.subStart('a2', 'evaluator', 'evaluator'); sim.adv(3); sim.subStop('a2', 'evaluator', 'Rejected: the rollback step is missing from the plan.');
  write(root, sim);
  Project.open(root).close(); // writes context.json
  const line = (input) => spawnSync(process.execPath, [CTS, 'subagent-statusline'], { cwd: root, input: JSON.stringify({ cwd: root, ...input }), encoding: 'utf8' });
  const r = line({ session_id: 'sa', columns: 100, tasks: [{ id: 'a1', name: 'planner', agentType: 'planner', description: 'plan it' }, { id: 'x9', agentType: 'evaluator' }, { id: 'zz', agentType: 'other' }] });
  assert.equal(r.status, 0);
  const rows = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((x) => x.id), ['a1', 'x9']);
  assert.match(rows[0].content, /^planner plan it · CTS ● 1 moment: "/);
  assert.ok(rows.every((x) => x.content.length <= 100));
  assert.equal(line({ tasks: [] }).stdout, '');
  assert.equal(spawnSync(process.execPath, [CTS, 'subagent-statusline'], { cwd: root, input: 'not json', encoding: 'utf8' }).stdout, '');
});

test('cts watch --once renders the companion pane without a server; the renderer fits the width', async () => {
  const { renderCompanion } = await import('../src/lib/companion.mjs');
  const root = proj();
  const sim = new Sim({ sid: 'w', start: Date.now() - 600000 }); sim.start(); sim.prompt('wait, undo that'); sim.adv(1); sim.prompt('keep the in-memory store for now, revisit later');
  write(root, sim);
  const r = cts(root, 'watch', '--once', '--plain');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^CTS /); assert.match(r.stdout, /reversal/); assert.match(r.stdout, /\n {2}\? /);
  const d = { root, now: Date.now(), pending: 2, summary: { moments: 1, openThreads: 0, paused: true }, header: null, threads: [],
    moments: [{ id: 'm', kind: 'fight', score: 70, headline: 'x'.repeat(200), t1: Date.now() - 60000 }] };
  const lines = renderCompanion(d, { width: 40, color: false, port: 4848 });
  assert.ok(lines.every((l) => l.length <= 40), 'fits'); assert.match(lines[0], /PAUSED/); assert.match(lines[1], /2 drafts to review/); assert.match(lines.at(-1), /localhost:4848/);
});
