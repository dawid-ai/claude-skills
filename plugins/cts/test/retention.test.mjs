import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Project } from '../src/lib/project.mjs';
import { paths, serialize } from '../src/lib/util.mjs';
import { writeHumanEvent } from '../src/lib/log.mjs';
import { planTrim, trim, snapshotFile } from '../src/lib/retention.mjs';
import * as N from '../src/lib/narrative.mjs';
import { Sim, JEST_RED, JEST_GREEN } from './helpers.mjs';

const DAY = 86400000;
const CTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cts');
const SECRET_PROMPT = 'please refactor the Initech billing module quietly';

function seed(cfg = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-ret-')); fs.mkdirSync(path.join(root, '.git'));
  const p = paths(root); fs.mkdirSync(p.sessions, { recursive: true });
  fs.writeFileSync(p.config, JSON.stringify({ port: 0, ...cfg }));
  const write = (s) => fs.writeFileSync(path.join(p.sessions, s.sid + '.jsonl'), s.events.map(serialize).join(''));
  // Two old sessions: a fight, a reversal, a hedge left open, a subagent disagreement, lots of ordinary traffic.
  const a = new Sim({ sid: 'old1', start: Date.now() - 20 * DAY }); a.start();
  a.prompt(SECRET_PROMPT); a.adv(1);
  for (let i = 0; i < 12; i++) { a.call('Read', { file_path: `src/f${i}.js` }); a.adv(0.5); }
  for (let i = 0; i < 4; i++) { a.bash('npm test', { ok: false, out: JEST_RED(2) }); a.adv(2); }
  a.bash('npm test', { out: JEST_GREEN }); a.adv(1);
  a.prompt('wait, go back to the old refill logic'); a.adv(1);
  a.prompt('use an in-memory store for now, revisit the limiter store later'); a.adv(1);
  a.stop('Done for today.'); a.ev('session.end', { reason: 'prompt_input_exit' });
  write(a);
  const b = new Sim({ sid: 'old2', start: Date.now() - 15 * DAY }); b.start('resume');
  b.subStart('p1', 'planner', 'planner'); b.adv(3); b.subStop('p1', 'planner', 'The plan is complete and ready to implement.');
  b.adv(2); b.subStart('e1', 'evaluator', 'evaluator'); b.adv(3); b.subStop('e1', 'evaluator', 'Rejected: the rollback step is missing from the plan.');
  for (let i = 0; i < 8; i++) { b.call('Grep', { pattern: 'limiter' + i }); b.adv(0.3); }
  b.stop('ok'); b.ev('session.end', { reason: 'prompt_input_exit' });
  write(b);
  // A recent session that is never trimmed and closes the old hedge with a commit about the limiter store.
  const c = new Sim({ sid: 'new', start: Date.now() - 3600e3 }); c.start('resume');
  c.prompt('ship the limiter'); c.adv(1);
  c.bash('git commit -m "limiter: move the store to redis"', { git: { branch: 'main', subject: 'limiter: move the store to redis', files: ['src/limiter.js'], stat: { files: 1, ins: 20, del: 4 } } });
  c.stop('Shipped.');
  write(c);
  return root;
}

const state = (pr) => JSON.stringify({
  moments: pr.engine.listMoments().map((m) => [m.id, m.kind, m.status, m.score, m.headline, m.t0, m.t1, m.thread]),
  threads: [...pr.engine.threads.values()].map((t) => [t.id, !!t.closed, t.closed && t.closed.how]).sort(),
  arcs: pr.engine.arcs().map((a) => [a.id, a.shape, a.status, a.moments]),
  sessions: pr.engine.sessionList().map((s) => [s.sid, s.start, s.end, s.parent, s.stats.moments, s.stats.attempts]),
  drafts: pr.engine.drafts.list().map((d) => [d.id, d.status]),
});
const hashes = (root) => Object.fromEntries(fs.readdirSync(paths(root).sessions).map((f) => [f, crypto.createHash('sha1').update(fs.readFileSync(path.join(paths(root).sessions, f))).digest('hex')]));
const allText = (root) => fs.readdirSync(paths(root).sessions).map((f) => fs.readFileSync(path.join(paths(root).sessions, f), 'utf8')).join('');

test('trim removes old raw events, keeps every moment, thread, arc and draft, and reindex reproduces the same state', () => {
  const root = seed({ retentionDays: 7, drafts: { kinds: ['fight', 'reversal', 'disagreement', 'shipped'], min: 0 } });
  let pr = Project.open(root);
  // Decisions before the trim: a confirm, a dismissal, and drafts whose honesty guard cites old events.
  const fight = pr.engine.listMoments().find((m) => m.kind === 'fight');
  writeHumanEvent(root, 'confirm', { target: fight.id }, { sid: 'new' });
  const rev = pr.engine.listMoments().find((m) => m.kind === 'reversal');
  writeHumanEvent(root, 'dismiss', { target: rev.id }, { sid: 'new' });
  pr.sync();
  N.autoDrafts(pr);
  const made = N.createDraft(pr, fight.id, { channel: 'x' });
  assert.ok(made.id, JSON.stringify(made));
  assert.ok(pr.engine.drafts.list().length >= 2, 'a draft from an old moment and one from the new session');
  const kinds = new Set(pr.engine.listMoments().map((m) => m.kind));
  for (const k of ['fight', 'reversal', 'disagreement', 'shipped']) assert.ok(kinds.has(k), k);
  assert.ok(pr.engine.threads.size >= 1);
  const before = state(pr), eventsBefore = pr.engine.eventCount, guardBefore = pr.engine.drafts.list().map((d) => N.checkDraft(pr, d).ok);

  const dry = trim(pr, Project, { dryRun: true });
  assert.equal(dry.applied, false); assert.ok(dry.rehearsed); assert.ok(dry.plan.drop >= 15, `drops ${dry.plan.drop}`);
  assert.deepEqual(dry.plan.sids.sort(), ['old1', 'old2']);
  assert.ok(!fs.existsSync(snapshotFile(root)), 'a dry run writes nothing');

  const mtime = fs.statSync(path.join(paths(root).sessions, 'old1.jsonl')).mtimeMs;
  const r = trim(pr, Project, {});
  assert.equal(r.applied, true);
  assert.equal(state(pr), before, 'same state right after the trim');
  assert.ok(pr.engine.eventCount < eventsBefore);
  assert.equal(Math.round(fs.statSync(path.join(paths(root).sessions, 'old1.jsonl')).mtimeMs), Math.round(mtime), 'mtime kept');
  assert.ok(!allText(root).includes(SECRET_PROMPT), 'an uncited raw prompt is gone from disk');
  assert.ok(allText(root).includes('wait, go back to the old refill logic'), 'the reversal prompt a moment cites stays');
  assert.deepEqual(pr.engine.drafts.list().map((d) => N.checkDraft(pr, d).ok), guardBefore, 'the honesty guard still finds its events');
  pr.close();

  pr = Project.open(root); assert.equal(state(pr), before, 'same state from a fresh open');
  pr.reindex(); assert.equal(state(pr), before, 'same state after reindex');
  // Life goes on: a decision written later into an old session still applies on top of the snapshot.
  writeHumanEvent(root, 'rescore', { target: fight.id, score: 33 }, { sid: 'old1' });
  pr.sync();
  assert.equal(pr.engine.view(pr.engine.moments.get(fight.id)).score, 33);
  assert.equal(planTrim(pr).drop, 0, 'a second trim has nothing left to remove');
  pr.close();
});

test('a trim that would change anything is refused and leaves every file untouched', () => {
  const root = seed({ retentionDays: 7 });
  const pr = Project.open(root);
  const before = hashes(root);
  const Broken = { open: (r) => { const p = Project.open(r); p.engine.moments.delete([...p.engine.moments.keys()][0]); return p; } };
  const r = trim(pr, Broken, {});
  assert.equal(r.applied, false); assert.match(r.problem, /did not reproduce/);
  assert.deepEqual(hashes(root), before); assert.ok(!fs.existsSync(snapshotFile(root)));
  pr.close();
});

test('another process notices the rewrite and rebuilds; retention off means nothing to do; the CLI rehearses by default', () => {
  const root = seed({ retentionDays: 0 });
  const a = Project.open(root);
  assert.match(planTrim(a).note, /retention is off/);
  const b = Project.open(root);
  const before = state(a);
  assert.equal(trim(b, Project, { days: 7 }).applied, true);
  b.close();
  const r = a.sync();
  assert.equal(r.reset, true, 'shrunk files trigger a rebuild');
  assert.equal(state(a), before);
  a.close();

  const root2 = seed({ retentionDays: 7 });
  const h = hashes(root2);
  const cli = (...x) => spawnSync(process.execPath, [CTS, ...x], { cwd: root2, encoding: 'utf8', env: { ...process.env, CTS_NO_SERVER: '1' } });
  const dry = cli('trim');
  assert.match(dry.stdout, /would remove \d+ raw events .* from 2 session\(s\)/); assert.match(dry.stdout, /cts trim --yes/);
  assert.deepEqual(hashes(root2), h, 'rehearsal only');
  assert.match(cli('trim', '--yes').stdout, /^removed \d+ raw events/);
  assert.match(cli('trim', '--yes').stdout, /nothing to trim/);
});
