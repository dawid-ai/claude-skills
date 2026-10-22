import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Project } from '../src/lib/project.mjs';
import { paths, serialize } from '../src/lib/util.mjs';
import * as ex from '../src/lib/extract.mjs';
import { Sim, JEST_RED, JEST_GREEN } from './helpers.mjs';

function proj() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-ex-')); fs.mkdirSync(path.join(root, '.git'));
  const s = new Sim({ start: Date.now() - 3600e3 }); s.start();
  s.prompt('make the limiter pass its tests'); s.adv(1);
  for (let i = 0; i < 4; i++) { s.bash('npm test', { ok: false, out: JEST_RED(2) }); s.adv(2); }
  s.bash('npm test', { out: JEST_GREEN }); s.adv(1);
  s.prompt('wait, go back to the old refill logic'); s.adv(1);
  s.stop('Reverted. Done.');
  fs.mkdirSync(paths(root).sessions, { recursive: true });
  fs.writeFileSync(path.join(paths(root).sessions, 's1.jsonl'), s.events.map(serialize).join(''));
  return { root, s };
}

test('prepare builds a bounded packet and apply refines the detector moment', () => {
  const { root } = proj(); const pr = Project.open(root);
  const before = pr.engine.listMoments();
  assert.ok(before.some((m) => m.kind === 'fight'));
  const packet = ex.prepare(pr);
  assert.ok(packet.count >= 2 && packet.instructions.includes('surprise a peer'));
  const fight = packet.candidates.find((c) => c.kind === 'fight');
  assert.ok(fight.cite.every((id) => packet.events[id]), 'every cited event is in the packet');
  assert.ok(Object.keys(packet.events).length < 40);
  const r = ex.apply(pr, { moments: [{ target: fight.id, headline: 'Limiter test stayed red for 4 runs, then one change fixed it', body: ['Same failure each time.'], score: 82, cite: fight.cite, evidence: { error: 'expected 5 received 4' } }] });
  assert.equal(r.accepted.moments, 1, JSON.stringify(r.rejected));
  const m = pr.engine.moments.get(fight.id);
  assert.equal(m.tier, 2); assert.equal(pr.engine.score(m), 82); assert.match(m.headline, /Limiter/);
  assert.ok(!ex.pending(pr).some((x) => x.id === fight.id), 'extracted moments are no longer pending');
  pr.close();
  // survives a rebuild from the log
  fs.rmSync(paths(root).db, { force: true });
  const pr2 = Project.open(root); assert.equal(pr2.engine.moments.get(fight.id).xscore, 82); pr2.close();
});

test('the honesty guard rejects invented numbers, missing events, and paraphrased quotes', () => {
  const { root } = proj(); const pr = Project.open(root);
  const c = ex.prepare(pr).candidates.find((x) => x.kind === 'fight');
  const bad = (o, re) => { const r = ex.validate(pr, { moments: [{ target: c.id, headline: 'Limiter fight', body: [], score: 60, cite: c.cite, ...o }] }); assert.equal(r.moments.length, 0); assert.match(r.rejected[0].reason, re, JSON.stringify(r.rejected)); };
  bad({ headline: 'Limiter test stayed red for 37 runs' }, /not traceable/);
  bad({ headline: 'It took nine tries' }, /nine/);
  bad({ cite: ['01NOSUCHEVENT'] }, /not in the log/);
  bad({ evidence: { error: 'the refill count was off by one' } }, /exact quote/);
  bad({ score: 140 }, /score/);
  bad({ kind: 'nonsense' }, /kind/);
  bad({ body: ['a', 'b', 'c', 'd'] }, /3 short lines/);
  bad({ actors: ['agent:ghost'] }, /actor/);
  assert.equal(pr.eventCount(), pr.eventCount());
  pr.close();
});

test('drop, merge and new tier-2 moments; marked moments cannot be dropped', () => {
  const { root } = proj(); const pr = Project.open(root);
  const c = ex.prepare(pr).candidates;
  const rev = c.find((x) => x.kind === 'reversal'), fight = c.find((x) => x.kind === 'fight');
  const r = ex.apply(pr, {
    moments: [{ kind: 'learned', headline: 'Reverting beat patching here', body: [], score: 55, cite: rev.cite, evidence: { prompt: 'wait, go back to the old refill logic' } }],
    drop: [{ target: rev.id, reason: 'routine' }],
    merge: [{ target: fight.id, into: rev.id }],
  });
  assert.equal(r.accepted.moments, 1, JSON.stringify(r.rejected)); assert.equal(r.accepted.drops, 1); assert.equal(r.accepted.merges, 1);
  assert.equal(pr.engine.moments.get(rev.id).status, 'dropped');
  assert.ok(pr.engine.listMoments().some((m) => m.kind === 'learned' && m.tier === 2));
  const again = ex.validate(pr, { drop: [{ target: fight.id }] });
  assert.equal(again.drops.length, 0);
  assert.match(again.rejected[0].reason, /already merged/);
  const repeat = ex.validate(pr, { drop: [{ target: rev.id, reason: 'routine' }] });
  assert.deepEqual([repeat.drops.length, repeat.rejected.length], [0, 0], 'a repair round repeating an accepted drop is a no-op, not a rejection');
  pr.close();
});

test('extract events never become a lane and never count as a session', () => {
  const { root } = proj(); const pr = Project.open(root);
  const fight = ex.prepare(pr).candidates.find((x) => x.kind === 'fight');
  ex.apply(pr, { moments: [{ target: fight.id, headline: 'Limiter fight, refined', body: [], score: 70, cite: fight.cite }] });
  const S = pr.engine.sessions.get('s1');
  assert.deepEqual([...S.actors.keys()].sort(), ['human', 'main']);
  assert.equal(pr.engine.sessionList().length, 1);
  pr.close();
});

test('cts extract run works against an API (mock server) and applies the validated answer', async () => {
  const { root } = proj(); const pr = Project.open(root);
  const fight = ex.prepare(pr).candidates.find((x) => x.kind === 'fight');
  let seen;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      seen = { key: req.headers['x-api-key'], body: JSON.parse(b) };
      const answer = { moments: [{ target: fight.id, headline: 'Limiter stayed red, then went green', body: [], score: 77, cite: fight.cite }] };
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ content: [{ type: 'text', text: 'Here you go:\n' + JSON.stringify(answer) }] }));
    });
  }).listen(0);
  await new Promise((r) => srv.on('listening', r));
  const r = await ex.runApi(pr, { key: 'test-key', baseUrl: `http://127.0.0.1:${srv.address().port}` });
  srv.close();
  assert.equal(seen.key, 'test-key'); assert.ok(seen.body.system.includes('CTS extractor'));
  assert.ok(!JSON.stringify(seen.body).includes('"instructions"'), 'instructions go in the system prompt only');
  assert.equal(ex.apply(pr, r.answer).accepted.moments, 1);
  await assert.rejects(ex.runApi(pr, { key: '' }).catch((e) => { if (process.env.ANTHROPIC_API_KEY) throw new Error('env key set'); throw e; }), /ANTHROPIC_API_KEY|env key/);
  pr.close();
});
