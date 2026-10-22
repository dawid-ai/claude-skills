import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Project } from '../src/lib/project.mjs';
import { paths, serialize, readJson, pidAlive } from '../src/lib/util.mjs';
import { whoAmI } from '../src/lib/consent.mjs';
import { register, listProjects, projectSummaries } from '../src/lib/registry.mjs';
import { DatabaseSync } from '../src/lib/db.mjs';
import { buildStoryHtml, publicData } from '../src/lib/share.mjs';
import * as X from '../src/lib/exporters.mjs';
import * as N from '../src/lib/narrative.mjs';
import { startServer } from '../src/server.mjs';
import { Sim } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CTS = path.join(HERE, '..', 'bin', 'cts'), HOOK = path.join(HERE, '..', 'src', 'hook.mjs');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const as = (name, fn) => { const prev = process.env.CTS_USER; process.env.CTS_USER = name; try { return fn(); } finally { if (prev === undefined) delete process.env.CTS_USER; else process.env.CTS_USER = prev; } };

test('consent: a person who chose summary has their prompts withheld from every shared output, not from the dashboard', () => {
  const alice = as('alice', whoAmI), bob = as('bob', whoAmI);
  assert.notEqual(alice, bob); assert.match(alice, /^[0-9a-f]{12}$/);
  const root = tmp('cts-consent-'); fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(paths(root).sessions, { recursive: true });
  fs.writeFileSync(paths(root).config, JSON.stringify({ people: { [bob]: { prompts: 'summary' } } }));
  const BOB = 'wait, go back, the Globex invoice parser is wrong';
  const ALICE = 'no, do not touch the migration';
  const s = new Sim({ sid: 'team', start: Date.now() - 600000 }); s.start();
  s.prompt(BOB).d.who = bob; s.adv(1);
  s.prompt(ALICE).d.who = alice; s.adv(1);
  s.stop('ok');
  fs.writeFileSync(path.join(paths(root).sessions, 'team.jsonl'), s.events.map(serialize).join(''));
  const pr = Project.open(root);
  const local = pr.engine.listMoments().map((m) => m.headline).join('\n');
  assert.ok(local.includes('Globex invoice parser'), 'the local dashboard shows everything');

  const out = tmp('cts-consent-out-');
  X.exportMarkdown(pr, out);
  const md = fs.readdirSync(out, { recursive: true }).filter((f) => String(f).endsWith('.md')).map((f) => fs.readFileSync(path.join(out, String(f)), 'utf8')).join('\n');
  const rev = pr.engine.listMoments().find((m) => m.kind === 'reversal');
  const draft = N.createDraft(pr, rev.id, { channel: 'x', force: true });
  const shared = {
    story: buildStoryHtml(pr), data: JSON.stringify(publicData(pr)), markdown: md,
    events: X.eventsNdjson(pr), replay: JSON.stringify(X.replayData(pr, { sid: 'team' })), draft: pr.engine.drafts.get(draft.id).text,
  };
  for (const [k, v] of Object.entries(shared)) assert.ok(!v.includes('Globex invoice parser'), `${k} leaks the withheld prompt`);
  assert.match(shared.events, /prompt withheld, 9 words/);
  assert.match(shared.data, /prompt withheld/);
  assert.ok(shared.data.includes('do not touch the migration'), 'alice kept the default: verbatim');
  assert.ok(N.checkDraft(pr, pr.engine.drafts.get(draft.id)).ok, 'the withheld draft still passes its honesty guard');
  assert.ok(X.eventsNdjson(pr, { raw: true }).includes('Globex invoice parser'), 'the private raw backup keeps everything');
  pr.close();

  const r = spawnSync(process.execPath, [CTS, 'consent', 'summary'], { cwd: root, encoding: 'utf8', env: { ...process.env, CTS_USER: 'carol', CTS_NO_SERVER: '1' } });
  assert.match(r.stdout, /your prompts in shared output: summary/);
  const cfg = readJson(paths(root).config);
  assert.equal(cfg.people[as('carol', whoAmI)].prompts, 'summary'); assert.equal(cfg.people[bob].prompts, 'summary', 'other people kept');
  assert.ok(!JSON.stringify(cfg).includes('carol'), 'names never enter the file');
});

test('registry: the hook registers a project once an hour; the dashboard lists projects and opens another one', async () => {
  const home = tmp('cts-home-');
  const prev = process.env.CTS_HOME; process.env.CTS_HOME = home;
  const stops = [];
  try {
    const a = tmp('cts-reg-a-'), b = tmp('cts-reg-b-');
    for (const r of [a, b]) { fs.mkdirSync(path.join(r, '.git')); fs.mkdirSync(path.join(r, '.cts'), { recursive: true }); fs.writeFileSync(path.join(r, '.cts', 'cts.json'), JSON.stringify({ port: 0 })); }
    const fire = (root) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's1', cwd: root, source: 'startup' }), env: { ...process.env, CTS_NO_SERVER: '1' }, encoding: 'utf8' });
    fire(a); fire(b);
    assert.deepEqual(listProjects().map((p) => path.basename(p.root)).sort(), [path.basename(a), path.basename(b)].sort());
    const seen = listProjects().find((p) => p.root === path.resolve(a)).lastSeen;
    assert.equal(register(a), false, 'not rewritten within the hour'); fire(a);
    assert.equal(listProjects().find((p) => p.root === path.resolve(a)).lastSeen, seen);

    Project.open(b).close();
    const sums = projectSummaries(DatabaseSync, { current: a });
    assert.equal(sums.find((p) => p.current).root, path.resolve(a));
    assert.ok(sums.find((p) => p.root === path.resolve(b)).activity.length >= 1, 'activity read from the index');

    const s = await startServer({ root: a, port: 0, quiet: true, tickMs: 50 }); stops.push(() => s.stop());
    const call = (p, body, headers = {}) => new Promise((ok) => { const req = http.request({ host: '127.0.0.1', port: s.port, path: p, method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...headers } }, (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => ok({ status: res.statusCode, body: t ? JSON.parse(t) : null })); }); req.end(body ? JSON.stringify(body) : undefined); });
    assert.equal((await call('/api/projects')).body.projects.length, 2);
    assert.equal((await call('/api/project-open', { root: b })).status, 403, 'needs the write header');
    assert.equal((await call('/api/project-open', { root: os.tmpdir() }, { 'x-cts': '1' })).status, 404, 'only registered projects');
    const opened = await call('/api/project-open', { root: b }, { 'x-cts': '1' });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const srvB = readJson(path.join(b, '.cts', 'server.json'));
    stops.push(() => { try { process.kill(srvB.pid); } catch { /* gone */ } });
    assert.equal(srvB.port, opened.body.port); assert.ok(pidAlive(srvB.pid));
  } finally {
    for (const f of stops) f();
    if (prev === undefined) delete process.env.CTS_HOME; else process.env.CTS_HOME = prev;
  }
});
