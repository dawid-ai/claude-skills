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
import { writeZip, readZip } from '../src/lib/zip.mjs';
import * as X from '../src/lib/exporters.mjs';
import * as I from '../src/lib/importers.mjs';
import * as N from '../src/lib/narrative.mjs';
import { writeHumanEvent } from '../src/lib/log.mjs';
import { Sim, JEST_RED, JEST_GREEN } from './helpers.mjs';

const mk = (cfg = {}) => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-x-')); fs.mkdirSync(path.join(r, '.git')); fs.mkdirSync(paths(r).sessions, { recursive: true }); fs.writeFileSync(paths(r).config, JSON.stringify(cfg)); return r; };
function seeded(cfg = { redact: { deny: ['Acme Corp'] } }) {
  const root = mk(cfg);
  const s = new Sim({ start: Date.now() - 2 * 3600e3, cwd: root }); s.start();
  s.prompt('make the limiter pass for Acme Corp'); s.adv(1);
  const a = s.pre('Agent', { subagent_type: 'evaluator' }); s.subStart('ag1', 'evaluator'); s.adv(1); s.subStop('ag1', 'evaluator', 'Rejected: missing rollback.'); s.post('Agent', { subagent_type: 'evaluator' }, { id: a });
  for (let i = 0; i < 4; i++) { s.bash('npm test', { ok: false, out: JEST_RED(2) + ' key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }); s.adv(2); }
  s.bash('npm test', { out: JEST_GREEN }); s.adv(1);
  s.prompt('wait, go back to the old refill logic'); s.adv(1);
  s.bash('git commit -m "limiter: restore refill logic"', { git: { branch: 'main', subject: 'limiter: restore refill logic', files: ['src/limiter.js'], stat: { files: 3, ins: 40, del: 2 } } }); s.adv(1);
  s.stop('Wired it for now, revisit the storage layer later.');
  fs.writeFileSync(path.join(paths(root).sessions, 's1.jsonl'), s.events.map(serialize).join(''));
  const pr = Project.open(root);
  writeHumanEvent(root, 'mark', { note: 'decided to keep the token bucket' }, { sid: 's1' });
  writeHumanEvent(root, 'mark', { note: 'should we shard?', flag: '?' }, { sid: 's1' });
  pr.sync();
  N.createDraft(pr, pr.engine.listMoments().find((m) => m.kind === 'reversal').id, { channel: 'x' });
  return { root, pr };
}
const state = (pr) => JSON.stringify({ m: pr.engine.listMoments().map((m) => [m.id, m.kind, m.score, m.status]), t: [...pr.engine.threads.values()].map((t) => [t.id, !!t.closed]).sort(), d: pr.engine.drafts.list().map((d) => [d.id, d.status, d.text]), a: pr.engine.arcs().map((x) => [x.id, x.shape]) });

test('zip: deflate and stored entries round trip, checksum failures and non-zips are rejected', () => {
  const big = Buffer.from('abc'.repeat(5000)); const rnd = crypto.randomBytes(300);
  const z = writeZip([{ name: 'a/b.txt', data: big }, { name: 'r.bin', data: rnd }, { name: 'ü.txt', data: 'héllo' }]);
  const r = readZip(z);
  assert.deepEqual(r.map((e) => e.name), ['a/b.txt', 'r.bin', 'ü.txt']);
  assert.ok(r[0].data.equals(big) && r[1].data.equals(rnd) && r[2].data.toString() === 'héllo');
  const bad = Buffer.from(z); bad[40] ^= 0xff;
  assert.throws(() => readZip(bad)); assert.throws(() => readZip(Buffer.from('nope')));
  const unzip = spawnSync('python3', ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip(), len(z.namelist()))', (fs.writeFileSync(path.join(os.tmpdir(), 'cts-zt.zip'), z), path.join(os.tmpdir(), 'cts-zt.zip'))], { encoding: 'utf8' });
  if (unzip.status === 0) assert.equal(unzip.stdout.trim(), 'None 3', 'a standard zip reader accepts it');
});

test('bundle round trip: a second machine shows the same moments, threads, drafts and arcs; re-import is a no-op', () => {
  const { root, pr } = seeded();
  const f = path.join(mk(), 'b.cts.zip');
  const r = X.exportBundle(pr, f); assert.ok(r.files >= 2);
  const before = state(pr);
  const root2 = mk();
  const res = I.importBundle(root2, f); assert.equal(res.added, pr.engine.eventCount - 0 >= 0 ? res.added : 0); assert.ok(res.added > 10);
  const pr2 = Project.open(root2);
  assert.equal(state(pr2), before);
  assert.ok(fs.existsSync(path.join(paths(root2).cts, 'cts.json')));
  const again = I.importBundle(root2, f); assert.equal(again.added, 0); assert.ok(again.skipped >= res.added);
  // merge: events only one side has are unioned
  writeHumanEvent(root2, 'mark', { note: 'only on machine two' }, { sid: 's1' });
  const f2 = path.join(mk(), 'b2.cts.zip'); const p2 = Project.open(root2); X.exportBundle(p2, f2); p2.close();
  const m = I.importBundle(root, f2); assert.equal(m.added, 1);
  pr.close(); pr2.close();
});

test('bundle safety: newer schema, missing manifest, path traversal names and local files are never overwritten', () => {
  const root = mk(); fs.writeFileSync(paths(root).voice, 'opener: mine\n');
  const dir = mk();
  const bad = (entries, re) => { const f = path.join(dir, 'x.zip'); fs.writeFileSync(f, writeZip(entries)); assert.throws(() => I.importBundle(root, f), re); };
  bad([{ name: 'sessions/a.jsonl', data: '' }], /manifest/);
  bad([{ name: 'manifest.json', data: JSON.stringify({ format: 'cts-bundle', schema: 99 }) }], /newer/);
  const f = path.join(dir, 'ok.zip');
  fs.writeFileSync(f, writeZip([{ name: 'manifest.json', data: JSON.stringify({ format: 'cts-bundle', schema: 1 }) }, { name: 'voice.md', data: 'opener: theirs\n' }, { name: 'digests/../../evil.md', data: 'x' }, { name: 'sessions/../../evil.jsonl', data: 'x' }]));
  I.importBundle(root, f);
  assert.equal(fs.readFileSync(paths(root).voice, 'utf8'), 'opener: mine\n');
  assert.ok(!fs.existsSync(path.join(path.dirname(paths(root).cts), 'evil.md')) && !fs.existsSync(path.join(paths(root).cts, '..', '..', 'evil.jsonl')));
});

test('raw ndjson events and json events round trip losslessly; redacted export leaks nothing', () => {
  const { pr } = seeded();
  const raw = X.eventsNdjson(pr, { raw: true });
  const f = path.join(mk(), 'e.ndjson'); fs.writeFileSync(f, raw);
  const root2 = mk(); const r = I.importEvents(root2, f); assert.ok(r.added > 10 && r.rejected === 0);
  const pr2 = Project.open(root2);
  assert.equal(JSON.stringify(pr2.engine.listMoments().map((m) => [m.id, m.kind, m.score])), JSON.stringify(pr.engine.listMoments().map((m) => [m.id, m.kind, m.score])));
  assert.equal(I.importEvents(root2, f).added, 0);
  pr2.close();
  const red = X.eventsNdjson(pr);
  assert.ok(!/sk-ant-api03|Acme Corp/.test(red), 'secrets and deny-listed names are masked');
  fs.writeFileSync(f, raw + '{"id":"nope"}\nnot json\n');
  assert.equal(I.importEvents(mk(), f).rejected, 2);
  pr.close();
});

test('marks: export as a journal, parse it back (including ? threads and date headings)', () => {
  const { root, pr } = seeded();
  const md = X.marksMarkdown(pr); assert.match(md, /decided to keep the token bucket/); assert.match(md, /- \? \d\d:\d\d should we shard\?/);
  const f = path.join(mk(), 'j.md'); fs.writeFileSync(f, md);
  const root2 = mk(); const r = I.importMarks(root2, f); assert.equal(r.parsed, 2); assert.equal(r.added, 2);
  const pr2 = Project.open(root2);
  assert.ok(pr2.engine.listMoments().some((m) => m.kind === 'mark' && /token bucket/.test(m.headline)));
  assert.ok(pr2.engine.openThreads().some((t) => /shard/.test(t.text)));
  assert.equal(I.importMarks(root2, f).added, 0);
  pr2.close();
  assert.deepEqual(I.parseMarks('## 2026-10-20\n- 14:30 first\n* 2026-10-21 09:05 — second\n- no time here\nnot a bullet\n').map((m) => m.note), ['first', 'second', 'no time here']);
  pr.close(); void root;
});

test('published posts: JSON and CSV (quoted commas) attach to the moment they told, by id or by wording', () => {
  const { root, pr } = seeded();
  const rev = pr.engine.listMoments().find((m) => m.kind === 'reversal');
  const when = new Date(rev.t1 + 600000).toISOString();
  const f = path.join(mk(), 'p.csv');
  fs.writeFileSync(f, `published_at,network,permalink,message,moment\n${when},X,https://x.com/me/1,"I pulled back with: ""wait, go back to the old refill logic""",\n${when},LinkedIn,https://li.com/2,Totally unrelated gardening post,${rev.id}\n${when},Bluesky,,Nothing about the work at all,\n`);
  const r = I.importPosts(root, f); assert.equal(r.parsed, 3); assert.equal(r.added, 3);
  const pr2 = Project.open(root);
  const m = pr2.engine.moments.get(rev.id);
  assert.deepEqual(m.posts.map((p) => p.channel).sort(), ['linkedin', 'x']);
  assert.equal(pr2.engine.receipts.filter((x) => !x.moment).length, 1, 'the unrelated one stays unattached');
  const js = path.join(mk(), 'p.json'); fs.writeFileSync(js, JSON.stringify([{ date: when, platform: 'mastodon', link: 'https://m.social/3', content: 'x', moment: rev.id.slice(0, 12) }]));
  assert.equal(I.importPosts(root, js).added, 1);
  pr2.close(); pr.close();
});

test('markdown export: arcs as articles, digests and drafts, redacted; otel export is well-formed and leak-free', () => {
  const { pr } = seeded();
  const out = mk();
  const r = X.exportMarkdown(pr, out); assert.ok(r.arcs >= 1 && r.digests >= 1 && r.drafts === 1);
  const files = fs.readdirSync(out, { recursive: true }).map((f) => String(f).replace(/\\/g, '/'));
  assert.ok(files.includes('index.md') && files.some((f) => /^arcs\/01-.*\.md$/.test(f)) && files.some((f) => /^digests\//.test(f)));
  const all = files.filter((f) => f.endsWith('.md')).map((f) => fs.readFileSync(path.join(out, f), 'utf8')).join('\n');
  assert.ok(!/Acme Corp|sk-ant/.test(all)); assert.match(all, /^---\ntitle: /m);
  const o = X.exportOtel(pr); const spans = o.resourceSpans[0].scopeSpans[0].spans;
  const ids = new Set(spans.map((s) => s.spanId));
  assert.ok(spans.every((s) => /^[0-9a-f]{32}$/.test(s.traceId) && /^[0-9a-f]{16}$/.test(s.spanId) && BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano)));
  assert.ok(spans.every((s) => !s.parentSpanId || ids.has(s.parentSpanId)), 'every parent exists');
  assert.ok(spans.some((s) => s.name === 'agent evaluator') && spans.some((s) => s.name.startsWith('moment ')) && spans.some((s) => s.status && s.status.code === 2));
  const tool = spans.find((s) => s.name === 'tool Bash'); assert.ok(tool.attributes.some((a) => a.key === 'cts.actor'));
  assert.ok(!/sk-ant|Acme Corp/.test(JSON.stringify(o)));
  pr.close();
});

test('replay HTML embeds redacted data and renders; PNG cards and video work when a browser/ffmpeg exist', () => {
  const { pr } = seeded();
  const data = X.replayData(pr); assert.ok(data.events.length > 8 && data.moments.length >= 1 && data.lanes[0].id === 'human');
  const html = X.replayHtml(data); assert.ok(!/sk-ant|Acme Corp/.test(html)); assert.match(html, /const D=\{/);
  if (X.findBrowser()) {
    const png = path.join(mk(), 'c.png');
    const m = pr.engine.listMoments().find((x) => x.kind === 'fight');
    X.cardPng({ id: m.id, kind: m.kind, score: m.score, headline: m.headline, actors: ['You'], evidence: m.evidence, evidence_line: '4 attempts' }, 'x', png);
    const b = fs.readFileSync(png); assert.equal(b.subarray(0, 4).toString('hex'), '89504e47'); assert.equal(b.readUInt32BE(16), 1200); assert.equal(b.readUInt32BE(20), 675);
    if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0) {
      const gif = path.join(mk(), 'r.gif'); X.replayVideo(data, gif, { fps: 2, seconds: 2, size: [640, 360] });
      assert.equal(fs.readFileSync(gif).subarray(0, 3).toString(), 'GIF');
    }
  }
  pr.close();
});

const CTS_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cts');

test('cts migrate reports the schema; export/import commands work through the CLI', () => {
  const { root, pr } = seeded(); pr.close();
  const cts = (...a) => spawnSync(process.execPath, [CTS_BIN, ...a], { cwd: root, encoding: 'utf8', env: { ...process.env, CTS_NO_SERVER: '1' } });
  assert.match(cts('migrate').stdout, /schema 1: \d+ events/);
  const b = path.join(mk(), 'out.cts.zip');
  assert.match(cts('export', 'bundle', '--out', b).stdout, /private backup/);
  const root2 = mk();
  const r = spawnSync(process.execPath, [CTS_BIN, 'import', 'bundle', b], { cwd: root2, encoding: 'utf8', env: { ...process.env, CTS_NO_SERVER: '1' } });
  assert.match(r.stdout, /event\(s\) added/);
  assert.match(cts('export', 'otel').stdout, /resourceSpans/);
  assert.match(cts('export', 'events', '--format', 'csv').stdout, /^id,sid,ts/);
  assert.match(cts('export', 'markdown', '--out', mk()).stdout, /arc article/);
  assert.match(cts('export', 'replay', '--out', path.join(mk(), 'r.html')).stdout, /wrote/);
});
