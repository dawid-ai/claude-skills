import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Project } from '../src/lib/project.mjs';
import { serialize, paths } from '../src/lib/util.mjs';
import { readFrom } from '../src/lib/log.mjs';
import { Sim, JEST_RED, JEST_GREEN } from './helpers.mjs';
import { writeHumanEvent } from '../src/lib/log.mjs';

function tmpProject() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-')); fs.mkdirSync(path.join(d, '.git')); return d; }
function writeSession(root, sim) {
  const p = paths(root); fs.mkdirSync(p.sessions, { recursive: true });
  fs.writeFileSync(path.join(p.sessions, sim.sid + '.jsonl'), sim.events.map(serialize).join(''));
}
function scenario(sim) {
  sim.start(); sim.prompt('add a limiter');
  for (let i = 0; i < 4; i++) { sim.bash('npm test', { ok: false, out: JEST_RED(2) }); sim.adv(2); }
  sim.bash('npm test', { out: JEST_GREEN });
  sim.prompt('wait, go back to the token bucket');
  sim.stop('Using a fixed window for now, will revisit limiter.js later. Done.');
  sim.prompt('ok, commit it');
  sim.bash('git commit -m "limiter"', { git: { branch: 'main', subject: 'limiter', files: ['limiter.js'], stat: { files: 1, ins: 20, del: 0 } } });
}

test('truncated and corrupt lines are skipped, never fatal', () => {
  const sim = new Sim(); sim.start(); sim.prompt('hello'); sim.prompt('again');
  const good = sim.events.map(serialize);
  const d = tmpProject(); const f = path.join(d, 'x.jsonl');
  fs.writeFileSync(f, good[0] + 'garbage line\n' + good[1].replace('hello', 'HELLO') + good[2].slice(0, 40));
  const r = readFrom(f);
  assert.equal(r.events.length, 1); assert.equal(r.bad, 2);
  assert.equal(r.end, Buffer.byteLength(good[0] + 'garbage line\n' + good[1]));
});

test('project sync builds moments, threads, sessions; reindex reproduces the same state', () => {
  const root = tmpProject(); const sim = new Sim(); scenario(sim); writeSession(root, sim);
  const a = Project.open(root);
  const snap = (pr) => JSON.stringify({ m: pr.engine.listMoments(), t: [...pr.engine.threads.values()], s: pr.engine.sessionList(), arcs: pr.engine.arcs(), n: pr.eventCount() });
  const before = snap(a);
  const kinds = a.engine.listMoments().map((m) => m.kind);
  assert.ok(kinds.includes('fight') && kinds.includes('reversal') && kinds.includes('shipped'));
  assert.equal(a.engine.openThreads().length, 1, 'shipping the work in the same session is not a decision about "for now"');
  assert.equal([...a.engine.threads.values()].length, 1);
  assert.equal(a.eventCount(), sim.events.length);
  a.reindex();
  assert.equal(snap(a), before, 'reindex reproduces the dashboard state exactly');
  const rows = a.db.prepare('SELECT * FROM moments').all(); assert.equal(rows.length, a.engine.moments.size);
  // delete the db file entirely, reopen
  a.close(); for (const s of ['', '-wal', '-shm']) fs.rmSync(paths(root).db + s, { force: true });
  const b = Project.open(root);
  assert.equal(snap(b), before);
  b.close();
});

test('incremental sync picks up appended events and human decisions', () => {
  const root = tmpProject(); const sim = new Sim(); sim.start(); sim.prompt('wait no'); writeSession(root, sim);
  const pr = Project.open(root);
  const m = pr.engine.listMoments()[0];
  assert.equal(m.kind, 'reversal');
  writeHumanEvent(root, 'dismiss', { target: m.id }, { sid: sim.sid });
  const r = pr.sync();
  assert.equal(r.events.length, 1); assert.ok(r.ch.moments.has(m.id));
  assert.equal(pr.engine.moments.get(m.id).status, 'dismissed');
  assert.equal(pr.db.prepare('SELECT status FROM moments WHERE id=?').get(m.id).status, 'dismissed');
  assert.equal(pr.sync().events.length, 0);
  pr.close();
});

test('threads survive session end, resume and compaction, and close when decided', () => {
  const root = tmpProject();
  const s1 = new Sim({ sid: 'day1', start: Date.parse('2026-10-19T10:00:00Z') });
  s1.start(); s1.prompt('implement the cache'); s1.stop('Implemented cache.js with an in-memory map for now, revisit eviction in cache.js later.');
  s1.ev('compact.post', { trigger: 'auto' }); s1.ev('session.end', { reason: 'other' });
  const s2 = new Sim({ sid: 'day2', start: Date.parse('2026-10-20T10:00:00Z') });
  s2.start('resume'); s2.prompt('what is still open?');
  writeSession(root, s1); writeSession(root, s2);
  let pr = Project.open(root);
  assert.equal(pr.engine.openThreads().length, 1);
  assert.equal(pr.engine.sessions.get('day2').parent, 'day1');
  const ctx = JSON.parse(fs.readFileSync(paths(root).context, 'utf8'));
  assert.equal(ctx.threads.length, 1);
  pr.close();
  const s3 = new Sim({ sid: 'day2', start: Date.parse('2026-10-20T11:00:00Z') });
  s3.prompt("Let's go with LRU eviction in cache.js, final decision.");
  fs.appendFileSync(path.join(paths(root).sessions, 'day2.jsonl'), s3.events.map(serialize).join(''));
  pr = Project.open(root);
  assert.equal(pr.engine.openThreads().length, 0);
  const th = [...pr.engine.threads.values()][0];
  assert.equal(th.closed.how, 'decision');
  pr.close();
});

test('a commit speaking to the topic, or touching its files in a later session, closes a hedge; a plain commit in the same session does not', () => {
  const root = tmpProject();
  const s1 = new Sim({ sid: 'a', start: Date.parse('2026-10-19T10:00:00Z') });
  s1.start(); s1.prompt('build it'); s1.stop('Stored in a flat file for now, revisit the storage backend in store.js later.');
  s1.prompt('commit'); s1.bash('git commit -m "add store"', { git: { branch: 'main', subject: 'add store', files: ['store.js'] } });
  writeSession(root, s1);
  let pr = Project.open(root);
  assert.equal(pr.engine.openThreads().length, 1);
  pr.close();
  const s2 = new Sim({ sid: 'b', start: Date.parse('2026-10-20T10:00:00Z') });
  s2.start('resume'); s2.prompt('go'); s2.bash('git commit -m "tidy"', { git: { branch: 'main', subject: 'tidy', files: ['store.js'] } });
  writeSession(root, s2);
  pr = Project.open(root);
  assert.equal(pr.engine.openThreads().length, 0, 'later session touching store.js');
  assert.equal([...pr.engine.threads.values()][0].closed.how, 'commit');
  pr.close();
  const root2 = tmpProject();
  const t = new Sim({ sid: 'c', start: Date.parse('2026-10-19T10:00:00Z') });
  t.start(); t.prompt('x'); t.stop('Flat file storage for now, revisit later.'); t.prompt('y'); t.bash('git commit -m "switch storage backend to sqlite"', { git: { branch: 'main', subject: 'switch storage backend to sqlite', files: ['db.js'] } });
  writeSession(root2, t);
  pr = Project.open(root2);
  assert.equal(pr.engine.openThreads().length, 0, 'subject names the topic');
  pr.close();
});
