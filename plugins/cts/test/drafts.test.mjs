import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Project } from '../src/lib/project.mjs';
import { paths, serialize } from '../src/lib/util.mjs';
import { writeHumanEvent } from '../src/lib/log.mjs';
import * as N from '../src/lib/narrative.mjs';
import * as P from '../src/lib/publish.mjs';
import { loadVoice, acceptSuggestion, undoSuggestion, initVoice } from '../src/lib/voice.mjs';
import { Sim, JEST_RED, JEST_GREEN } from './helpers.mjs';

function setup(cfg = {}, extra = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-dr-')); fs.mkdirSync(path.join(root, '.git')); fs.mkdirSync(paths(root).sessions, { recursive: true });
  fs.writeFileSync(paths(root).config, JSON.stringify(cfg));
  const s = new Sim({ start: Date.now() - 2 * 3600e3 }); s.start();
  s.prompt('make the limiter pass its tests'); s.adv(1);
  for (let i = 0; i < 4; i++) { s.bash('npm test', { ok: false, out: JEST_RED(2) }); s.adv(2); }
  s.bash('npm test', { out: JEST_GREEN }); s.adv(1);
  s.prompt('wait, go back to the old refill logic'); s.adv(1);
  s.bash('git commit -m "limiter: restore refill logic"', { git: { branch: 'main', subject: 'limiter: restore refill logic', files: ['src/limiter.js'], stat: { files: 3, ins: 40, del: 2 } } }); s.adv(1);
  s.stop('Done.');
  extra(s);
  fs.writeFileSync(path.join(paths(root).sessions, 's1.jsonl'), s.events.map(serialize).join(''));
  return { root, pr: Project.open(root) };
}
const momentOf = (pr, kind) => pr.engine.listMoments().find((m) => m.kind === kind);

test('every detector kind drafts into text that passes its own honesty guard and fits the platform', () => {
  const { pr } = setup();
  for (const kind of ['fight', 'reversal', 'shipped']) {
    const m = momentOf(pr, kind); assert.ok(m, kind);
    const r = N.createDraft(pr, m.id, { channel: 'x' }); assert.ok(r.id, JSON.stringify(r));
    const d = pr.engine.drafts.get(r.id);
    assert.ok(d.text.length <= 280, d.text);
    const chk = N.checkDraft(pr, d); assert.deepEqual(chk.problems, [], d.text); assert.ok(chk.redactionClean);
  }
  const f = pr.engine.drafts.list().find((x) => x.kind === 'fight');
  assert.match(f.text, /It took 4 failed attempts before it finally passed\./);
  const rv = pr.engine.drafts.list().find((x) => x.kind === 'reversal');
  assert.match(rv.text, /^I stopped and pulled the work back/);
  for (const x of pr.engine.drafts.list()) {
    assert.ok(!/[“”"`]|npm test|refill logic|limiter/.test(x.text), `a post tells the story, it never quotes the log: ${x.text}`);
    assert.ok(!/\bYou\b/.test(x.text));
  }
  pr.close();
});

test('guard rejects an edited draft with an invented number, a fake quote, or a never-word', () => {
  const { root, pr } = setup();
  initVoice(root);
  const id = N.createDraft(pr, momentOf(pr, 'fight').id, { channel: 'x' }).id;
  for (const [text, re] of [['9 failed runs of npm test.', /not traceable/], ['4 failed runs. “we never saw this error”', /quote/], ['4 failed runs, a total game-changer', /game-changer/]]) {
    N.edit(pr, id, text);
    const chk = N.checkDraft(pr, pr.engine.drafts.get(id)); assert.equal(chk.ok, false, text); assert.match(chk.problems.join(' '), re);
  }
  pr.close();
});

test('arc → thread and linkedin and long and devlog formats', () => {
  const { pr } = setup();
  const arc = pr.engine.arcs().find((a) => a.moments.length > 1); assert.ok(arc);
  const t = N.createDraft(pr, 'arc:' + arc.id, { channel: 'x' }); const th = pr.engine.drafts.get(t.id);
  assert.equal(th.format, 'thread'); assert.match(th.text, /^1\/\d /); assert.ok(th.text.split('\n\n---\n\n').every((p) => p.length <= 280));
  for (const [ch, fmt] of [['linkedin', 'linkedin'], ['blog', 'long'], ['changelog', 'devlog']]) {
    const r = N.createDraft(pr, 'arc:' + arc.id, { channel: ch }); assert.ok(r.id, JSON.stringify(r));
    const d = pr.engine.drafts.get(r.id); assert.equal(d.format, fmt);
    assert.deepEqual(N.checkDraft(pr, d).problems, [], d.text);
  }
  assert.match(pr.engine.drafts.list().find((x) => x.format === 'long').text, /^---\ntitle: "/);
  pr.close();
});

test('declined sources are never regenerated unless forced; duplicates are not created', () => {
  const { pr } = setup();
  const m = momentOf(pr, 'fight');
  const id = N.createDraft(pr, m.id, { channel: 'x' }).id;
  assert.match(N.createDraft(pr, m.id, { channel: 'x' }).error, /already exists/);
  N.decline(pr, id, 'too inside-baseball');
  assert.match(N.createDraft(pr, m.id, { channel: 'x' }).error, /declined/);
  assert.equal(N.autoDrafts(pr).filter((d) => pr.engine.drafts.get(d).source.id === m.id).length, 0);
  assert.ok(N.createDraft(pr, m.id, { channel: 'x', force: true }).id);
  assert.equal(pr.engine.drafts.get(id).declined.reason, 'too inside-baseball');
  pr.close();
});

test('autopilot drafts shipped/reversal over the bar; below the bar and dismissed ones are skipped', () => {
  const { pr } = setup();
  const made = N.autoDrafts(pr);
  const kinds = made.map((id) => pr.engine.drafts.get(id).kind);
  assert.ok(kinds.includes('shipped') && kinds.includes('reversal'));
  assert.ok(!kinds.includes('fight'), 'fight is not in the default autopilot kinds');
  assert.equal(N.autoDrafts(pr).length, 0, 'second run drafts nothing new');
  pr.close();
});

test('publish gate: every bypass path is refused, the happy path writes byte for byte with a receipt', () => {
  const { root, pr } = setup();
  const id = N.createDraft(pr, momentOf(pr, 'shipped').id, { channel: 'x' }).id;
  const no = (re, msg) => { const r = P.publishDraft(pr, id); assert.equal(r.ok, false, msg); assert.match(r.reason, re, msg); };
  no(/not approved/, 'pending draft');
  // forged approvals
  writeHumanEvent(root, 'draft.approve', { draft: id, via: 'human', text_hash: 'deadbeef' }, { actor: 'human' }); pr.sync();
  no(/not approved/, 'approval of a different text is ignored');
  const h = (await_import_hash => await_import_hash)(null);
  void h;
  // autopilot approval without an auto rule
  N.approve(pr, id, { via: 'autopilot', rule: 'shipped:x' });
  no(/no auto-publish rule/, 'autopilot approval with no rule in cts.json');
  // an approval event whose actor does not match its claimed kind
  const bad = N.createDraft(pr, momentOf(pr, 'reversal').id, { channel: 'x' }).id;
  const store = pr.engine.drafts; const x2 = store.get(bad);
  writeHumanEvent(root, 'draft.approve', { draft: bad, via: 'human', text_hash: require_hash(x2.text) }, { actor: 'cts' }); pr.sync();
  assert.equal(P.publishDraft(pr, bad).ok, false); assert.match(P.publishDraft(pr, bad).reason, /wrong actor/);
  // human approval, then an edit voids it
  const id2 = N.createDraft(pr, momentOf(pr, 'fight').id, { channel: 'x' }).id;
  N.approve(pr, id2); N.edit(pr, id2, '4 failed runs of npm test. Fixed it.');
  assert.equal(pr.engine.drafts.get(id2).status, 'pending');
  assert.match(P.publishDraft(pr, id2).reason, /not approved/);
  // kill switch
  N.approve(pr, id2); P.setKillSwitch(pr, true);
  assert.match(P.publishDraft(pr, id2).reason, /paused/); assert.deepEqual(P.runQueue(pr), []);
  P.setKillSwitch(pr, false);
  // scheduled
  const later = new Date(Date.now() + 3600e3).toISOString();
  const id3 = N.createDraft(pr, momentOf(pr, 'reversal').id, { channel: 'bluesky' }).id;
  N.approve(pr, id3, { at: later });
  assert.match(P.publishDraft(pr, id3).reason, /scheduled for/);
  // happy path: byte for byte
  const text = pr.engine.drafts.get(id2).text;
  const r = P.publishDraft(pr, id2); assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(fs.readFileSync(path.join(root, r.receipt.path), 'utf8'), text, 'published file equals the draft byte for byte');
  assert.equal(pr.engine.drafts.get(id2).status, 'published'); assert.equal(pr.engine.drafts.get(id2).receipts.length, 1);
  assert.match(P.publishDraft(pr, id2).reason, /already published/);
  pr.close();
  // the whole state survives a rebuild from the log
  fs.rmSync(paths(root).db, { force: true });
  const pr2 = Project.open(root); assert.equal(pr2.engine.drafts.get(id2).status, 'published'); assert.equal(pr2.engine.drafts.pubPaused, false); pr2.close();
});
import crypto from 'node:crypto';
function require_hash(t) { return crypto.createHash('sha1').update(t, 'utf8').digest('hex'); }

test('auto-publish only with an explicit rule, a clean guard and a clean redaction report', () => {
  const { root, pr } = setup({ drafts: { modes: { 'shipped:x': 'auto' } } });
  const m = momentOf(pr, 'shipped');
  const id = N.createDraft(pr, m.id, { channel: 'x', origin: 'autopilot' }).id;
  assert.equal(N.maybeAutoApprove(pr, id), true);
  const r = P.publishDraft(pr, id); assert.equal(r.ok, true, JSON.stringify(r));
  // a draft that needs redaction drops back to draft
  const m2 = momentOf(pr, 'reversal');
  const id2 = N.createDraft(pr, m2.id, { channel: 'x', mode: 'auto' }).id;
  N.edit(pr, id2, 'I pulled back. contact me at someone@example.com');
  assert.equal(N.maybeAutoApprove(pr, id2), false);
  assert.equal(pr.engine.drafts.get(id2).status, 'pending');
  assert.ok(pr.engine.drafts.get(id2).redaction.count > 0);
  assert.ok(!pr.engine.drafts.get(id2).text.includes('someone@example.com'));
  pr.close(); void root;
});

test('daily cap, private projects, path escapes and expiry', () => {
  const { root, pr } = setup({ publishing: { channels: { x: { cap: 1 }, blog: { adapter: 'blog', dir: '../escape' } } } });
  const a = N.createDraft(pr, momentOf(pr, 'fight').id, { channel: 'x' }).id, b = N.createDraft(pr, momentOf(pr, 'reversal').id, { channel: 'x' }).id;
  N.approve(pr, a); N.approve(pr, b);
  assert.equal(P.publishDraft(pr, a).ok, true); assert.match(P.publishDraft(pr, b).reason, /daily cap/);
  const arc = pr.engine.arcs()[0];
  const bl = N.createDraft(pr, 'arc:' + arc.id, { channel: 'blog' }).id; N.approve(pr, bl);
  assert.match(P.publishDraft(pr, bl).reason, /adapter failed.*escapes/);
  assert.ok(!fs.existsSync(path.join(path.dirname(root), 'escape')));
  const later = Date.now() + 8 * 86400e3;
  const pend = N.createDraft(pr, momentOf(pr, 'shipped').id, { channel: 'x' }).id;
  assert.equal(pr.engine.drafts.list({}, later).find((x) => x.id === pend).status, 'expired');
  assert.match(N.approve(pr, pend).error || '', /^$/);
  pr.close();
  const p2 = setup({ private: true });
  assert.match(N.createDraft(p2.pr, momentOf(p2.pr, 'fight').id).error, /private/); p2.pr.close();
});

test('voice: profile shapes drafts; edits are offered to the profile exactly once, opt-in, reversible', () => {
  const { root, pr } = setup();
  fs.writeFileSync(paths(root).voice, 'opener: Build log:\nx.max: 200\nnever: synergy\n');
  const id = N.createDraft(pr, momentOf(pr, 'fight').id, { channel: 'x' }).id;
  const d = pr.engine.drafts.get(id);
  assert.ok(d.text.startsWith('Build log:\n')); assert.ok(d.text.length <= 200);
  // shorten twice -> one max suggestion; the same words removed from two drafts -> one never suggestion
  const r1 = N.edit(pr, id, '4 failed runs.');
  assert.equal(r1.suggestions.filter((s) => s.key === 'x.max').length, 1);
  const id2 = N.createDraft(pr, momentOf(pr, 'reversal').id, { channel: 'x' }).id;
  const again = N.edit(pr, id2, 'I pulled back.');
  assert.equal(again.suggestions.filter((s) => s.key === 'x.max').length, 0, 'not offered twice');
  const sug = [...pr.engine.drafts.suggestions.values()];
  assert.ok(sug.every((s) => s.status === 'offered'));
  assert.equal(loadVoice(root).for('x').max, 200, 'nothing is added without a yes');
  const s = sug.find((x) => x.key === 'x.max');
  assert.ok(acceptSuggestion(root, s)); assert.equal(loadVoice(root).for('x').max, +s.value);
  assert.ok(fs.readFileSync(paths(root).voice, 'utf8').includes(`<!-- s:${s.id} -->`));
  assert.ok(undoSuggestion(root, s.id)); assert.equal(loadVoice(root).for('x').max, 200);
  pr.close();
});

test('notify mode: each draft is announced once (desktop + terminal), never repeated after reindex; draft mode stays silent', async () => {
  const { notifyDrafts } = await import('../src/lib/notify.mjs');
  const { root, pr } = setup({ drafts: { modes: { 'shipped:x': 'notify' } } });
  N.autoDrafts(pr);
  const sent = [];
  const send = (t, b) => sent.push([t, b]);
  const ids = notifyDrafts(pr, { url: 'http://localhost:4848/', send });
  const notifyMode = pr.engine.drafts.list({ status: 'pending' }).filter((x) => x.notify);
  assert.ok(notifyMode.length >= 1 && ids.length === notifyMode.length, 'every notify-mode draft announced');
  assert.ok(pr.engine.drafts.list().filter((x) => !x.notify).every((x) => !ids.includes(x.id)), 'draft-mode drafts stay silent');
  assert.equal(sent.length, 1); assert.match(sent[0][0], /CTS drafted/); assert.match(sent[0][1], /#\/drafts$/);
  assert.deepEqual(notifyDrafts(pr, { send }), []);
  pr.reindex();
  assert.deepEqual(notifyDrafts(pr, { send }), []); assert.equal(sent.length, 1);
  assert.ok(pr.engine.drafts.get(ids[0]).notified.via.includes('desktop'));
  pr.close();
  const off = setup({ drafts: { modes: { 'shipped:x': 'notify' } }, notify: { desktop: false } });
  N.autoDrafts(off.pr);
  const sent2 = [];
  assert.ok(notifyDrafts(off.pr, { send: (t, b) => sent2.push(t) }).length >= 1);
  assert.equal(sent2.length, 0, 'desktop off: recorded for the terminal line only');
  off.pr.close();
});

test('desktopNotify passes title and body as data, never inside the script', async () => {
  const { desktopNotify } = await import('../src/lib/notify.mjs');
  const calls = [];
  const run = (...a) => { calls.push(a); return { on() {}, unref() {} }; };
  const evil = '"; rm -rf / #$(whoami)';
  const prev = process.env.CTS_NO_NOTIFY; delete process.env.CTS_NO_NOTIFY;
  try {
    for (const platform of ['win32', 'darwin', 'linux']) desktopNotify(evil, 'body', { platform, run });
  } finally { if (prev !== undefined) process.env.CTS_NO_NOTIFY = prev; }
  assert.equal(calls.length, 3);
  assert.ok(!calls[0][1].join(' ').includes(evil) && calls[0][2].env.CTS_N_TITLE === evil, 'windows: env var');
  assert.equal(calls[1][1].at(-2), evil, 'mac: argv');
  assert.equal(calls[2][1][1], evil, 'linux: argv');
});

const BROKE_OUT = '     × applies probability deterministically and ratchets evenly 8ms\n⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯\n Test Files  1 failed | 32 passed (33)\n      Tests  1 failed | 312 passed (313)\n41 passed in 2.43s';
const brokeSetup = () => setup({}, (s) => {
  s.prompt('the ratchet has to be even, keep the probability deterministic'); s.adv(1);
  s.bash('npm test 2>&1 | tail -6', { out: ' Test Files  33 passed (33)\n      Tests  313 passed (313)' }); s.adv(3);
  s.bash('npx tsc -b && npm test 2>&1 | grep -E "×|Tests"', { out: BROKE_OUT }); s.adv(1);
  s.stop('One probability test broke because the ratchet now rounds down. I kept the rounding and updated the test, since even steps matter more here.');
});

test('a broke draft says what broke in words; the failing test name and the runner summary stay on the dashboard', () => {
  const { pr } = brokeSetup();
  const m = momentOf(pr, 'broke');
  assert.match(N.beat(pr, m).errLine, /^× applies probability/, 'the error line is still found for the dashboard');
  const d = pr.engine.drafts.get(N.createDraft(pr, m.id, { channel: 'x' }).id);
  assert.equal(d.text, 'A change broke 1 test that was passing before.', d.text);
  assert.equal(d.writer, 'template');
  assert.deepEqual(N.checkDraft(pr, d).problems, []);
  pr.close();
});

test('storyteller: a story that follows the rules becomes the draft; it saw only redacted material', async () => {
  const { pr } = brokeSetup();
  const m = momentOf(pr, 'broke');
  let seen;
  const story = 'One test broke after a change to how the ratchet rounds. I kept the new rounding and changed the test instead, since even steps matter more here.';
  const r = await N.writeStory(pr, m.id, { channel: 'x', via: 'claude', ask: async (sys, user) => { seen = { sys, user }; return 'Sure:\n' + JSON.stringify({ title: 'I kept the rounding', text: story }); } });
  assert.ok(r.id, JSON.stringify(r)); assert.equal(r.writer, 'claude'); assert.equal(r.fallback, undefined);
  const d = pr.engine.drafts.get(r.id);
  assert.equal(d.text, story); assert.equal(d.title, 'I kept the rounding'); assert.equal(d.writer, 'claude');
  assert.deepEqual(N.checkDraft(pr, d).problems, [], 'the stored draft passes the same guard as a template');
  assert.match(seen.sys, /Never quote/); assert.match(seen.user, /even steps matter more/, 'the agent\'s reason is in the material');
  assert.ok(!seen.user.includes(pr.root.replace(/\\/g, '\\\\')) && !seen.user.includes(path.basename(pr.root)), 'no project path or name reaches the model');
  pr.close();
});

test('storyteller: quotes, commands, paths, copied prompts and invented numbers are refused; one repair round, then the template', async () => {
  const { pr } = brokeSetup();
  const m = momentOf(pr, 'broke');
  const pk = (() => { const src = N.resolveSource(pr, m.id); return N.storyPacket(pr, src, N.compose(pr, src, 'x', 'short'), 'x', 'short'); })();
  const bad = (text, re) => { const p = N.storyProblems(pr, text, { ...pk, format: 'short' }); assert.ok(p.some((x) => re.test(x)), `${text} -> ${p}`); };
  bad('I said “keep it even” and the test broke.', /quotes/);
  bad('I ran npm test with --watch and one broke.', /flag/);
  bad('The failure was in src/lib/ratchet.js all along.', /file or a path/);
  bad('I told it the ratchet has to be even, keep the probability deterministic, and it broke.', /word for word/);
  bad('It took 9 tries to get the ratchet right.', /not traceable/);
  bad('The [repo] tests broke after a change.', /placeholder/);
  assert.deepEqual(N.storyProblems(pr, 'A change broke one test. I kept the change and fixed the test, since even steps matter more here.', { ...pk, format: 'short' }), []);
  let calls = 0;
  const r = await N.writeStory(pr, m.id, { channel: 'x', via: 'api', ask: async (sys, user) => { calls++; if (calls === 2) assert.match(user, /validator rejected your story:\n- it quotes/); return JSON.stringify({ title: 't', text: 'I said “keep it even” and one test broke.' }); } });
  assert.equal(calls, 2, 'one repair round'); assert.equal(r.writer, 'template'); assert.match(r.fallback, /quotes/);
  assert.equal(pr.engine.drafts.get(r.id).writer, 'template');
  const r2 = await N.writeStory(pr, m.id, { channel: 'linkedin', ask: async () => { throw new Error('claude -p failed (exit 1)'); } });
  assert.ok(r2.id); assert.match(r2.fallback, /exit 1/, 'a failed model call still leaves the template draft');
  pr.close();
});

test('storyteller: threads are renumbered, articles keep their front matter, autopilot uses drafts.writer', async () => {
  const { pr } = setup({ drafts: { writer: 'claude' } });
  const arc = pr.engine.arcs().find((a) => a.moments.length > 1);
  const t = await N.writeStory(pr, 'arc:' + arc.id, { channel: 'x', ask: async () => JSON.stringify({ title: 'Back to the old way', text: 'The tests kept failing, 4 times in a row.\n---\nI stopped and went back to the earlier approach.' }) });
  assert.equal(t.writer, 'claude', JSON.stringify(t));
  assert.equal(pr.engine.drafts.get(t.id).text, '1/2 The tests kept failing, 4 times in a row.\n\n---\n\n2/2 I stopped and went back to the earlier approach.');
  const l = await N.writeStory(pr, 'arc:' + arc.id, { channel: 'blog', ask: async () => JSON.stringify({ title: 'Back to the old way', text: '## What happened\n\nThe tests kept failing, so I went back to the earlier approach.' }) });
  const lt = pr.engine.drafts.get(l.id).text;
  assert.match(lt, /^---\ntitle: "Back to the old way"\ndate: /); assert.match(lt, /## What happened/);
  let n = 0;
  const made = await N.autoStories(pr, { ask: async () => { n++; return JSON.stringify({ title: 'Shipped', text: 'I put the earlier approach back and shipped it.' }); } });
  assert.ok(made.length >= 2 && n === made.length, `${made.length} drafts, ${n} calls`);
  assert.ok(made.every((id) => pr.engine.drafts.get(id).writer === 'claude'));
  assert.equal((await N.autoStories(pr, { ask: async () => { throw new Error('not called'); } })).length, 0, 'nothing is asked twice');
  pr.close();
});
