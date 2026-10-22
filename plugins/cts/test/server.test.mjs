import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer } from '../src/server.mjs';
import { serialize, paths } from '../src/lib/util.mjs';
import { Sim, JEST_RED, JEST_GREEN } from './helpers.mjs';

const get = (port, p, headers = {}) => new Promise((ok, no) => http.get({ port, path: p, host: '127.0.0.1', headers }, (r) => { let s = ''; r.on('data', (c) => (s += c)); r.on('end', () => ok({ status: r.statusCode, body: s })); }).on('error', no));
const post = (port, p, obj, headers = {}) => new Promise((ok, no) => { const r = http.request({ port, path: p, host: '127.0.0.1', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => { let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => ok({ status: res.statusCode, body: s })); }); r.on('error', no); r.end(JSON.stringify(obj)); });

test('server: state API, SSE push within 1s of an append, guarded actions, host check', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-srv-')); fs.mkdirSync(path.join(root, '.git'));
  const p = paths(root); fs.mkdirSync(p.sessions, { recursive: true });
  const sim = new Sim({ sid: 'srv', start: Date.now() - 20000 }); sim.start(); sim.prompt('hello');
  fs.writeFileSync(path.join(p.sessions, 'srv.jsonl'), sim.events.map(serialize).join(''));
  const s = await startServer({ root, port: 0, quiet: true, tickMs: 50 });
  try {
    const st = JSON.parse((await get(s.port, '/api/state')).body);
    assert.equal(st.summary.events, 2); assert.equal(st.sessions.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(p.server, 'utf8')).port, s.port);

    const got = new Promise((ok) => {
      http.get({ port: s.port, path: '/api/stream', host: '127.0.0.1' }, (r) => {
        let buf = '';
        r.on('data', (c) => { buf += c; if (buf.includes('event: batch') && buf.includes('wait, undo')) ok(Date.now()); });
      });
    });
    await new Promise((r) => setTimeout(r, 150));
    const t0 = Date.now();
    sim.prompt('wait, undo that');
    fs.appendFileSync(path.join(p.sessions, 'srv.jsonl'), serialize(sim.events[sim.events.length - 1]));
    const t1 = await got;
    assert.ok(t1 - t0 < 1000, `event reached the browser in ${t1 - t0} ms`);

    const idx = (await get(s.port, '/')).body; assert.match(idx, /<title>CTS/);
    assert.equal((await get(s.port, '/api/state', { host: 'evil.example.com' })).status, 403);
    assert.equal((await post(s.port, '/api/action', { type: 'mark' })).status, 403, 'no x-cts header');
    assert.equal((await post(s.port, '/api/action', { type: 'mark' }, { 'x-cts': '1', origin: 'http://evil.example.com' })).status, 403);
    const ok = await post(s.port, '/api/action', { type: 'mark', sid: 'srv', data: { note: 'this one' } }, { 'x-cts': '1' });
    assert.equal(ok.status, 200);
    await new Promise((r) => setTimeout(r, 200));
    const st2 = JSON.parse((await get(s.port, '/api/state')).body);
    assert.ok(st2.moments.some((m) => m.kind === 'reversal' && m.score === 100), 'mark confirmed the fresh reversal');
    assert.equal((await get(s.port, '/api/events?q=undo')).status, 200);
    assert.equal((await get(s.port, '/../package.json')).status, 404);
    const story = (await get(s.port, '/api/share/story.html')).body; assert.match(story, /<html/);
  } finally { s.stop(); }
});


test('server: drafts API — list, approve/publish over HTTP with the CSRF guard, kill switch, card', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-srvd-')); fs.mkdirSync(path.join(root, '.git'));
  const p = paths(root); fs.mkdirSync(p.sessions, { recursive: true });
  const sim = new Sim({ sid: 'd1', start: Date.now() - 600000 }); sim.start(); sim.prompt('add a limiter'); sim.adv(1); sim.prompt('wait, go back to the old logic'); sim.stop('ok');
  fs.writeFileSync(path.join(p.sessions, 'd1.jsonl'), sim.events.map(serialize).join(''));
  const s = await startServer({ root, port: 0, quiet: true, tickMs: 50 });
  try {
    await new Promise((r) => setTimeout(r, 300));
    let d = JSON.parse((await get(s.port, '/api/drafts')).body);
    assert.equal(d.drafts.length, 1, 'autopilot drafted the reversal'); assert.equal(d.drafts[0].status, 'pending'); assert.equal(d.drafts[0].guard.ok, true);
    const id = d.drafts[0].id;
    assert.equal((await post(s.port, '/api/draft', { op: 'approve', id })).status, 403, 'no x-cts header');
    assert.equal((await get(s.port, '/api/draft/card?id=' + id)).status, 200);
    const H = { 'x-cts': '1' };
    assert.equal((await post(s.port, '/api/draft', { op: 'kill', on: true }, H)).status, 200);
    let r = JSON.parse((await post(s.port, '/api/draft', { op: 'approve', id }, H)).body);
    assert.match(r.held, /paused/);
    await post(s.port, '/api/draft', { op: 'kill', on: false }, H);
    await new Promise((r2) => setTimeout(r2, 200));
    await post(s.port, '/api/draft', { op: 'publish', id }, H);
    d = JSON.parse((await get(s.port, '/api/drafts')).body);
    assert.equal(d.drafts[0].status, 'published'); assert.equal(d.paused, false);
    assert.equal((await post(s.port, '/api/draft', { op: 'nonsense' }, H)).status, 400);
  } finally { s.stop(); }
});

test('settings: whitelisted fields only, all-or-nothing, other cts.json keys kept, saving rescores; the write is guarded', async () => {
  const { coerce, applySettings, getSettings, FIELDS } = await import('../src/lib/settings.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-set-')); fs.mkdirSync(path.join(root, '.git'));
  const p = paths(root); fs.mkdirSync(p.sessions, { recursive: true });
  fs.writeFileSync(p.config, JSON.stringify({ port: 0, myNote: 'keep me', redact: { deny: ['Acme'] } }));
  const sim = new Sim({ sid: 'st', start: Date.now() - 60000 }); sim.start(); sim.prompt('wait, go back to the old approach');
  fs.writeFileSync(path.join(p.sessions, 'st.jsonl'), sim.events.map(serialize).join(''));
  const f = (k) => FIELDS.find((x) => x.path === k);
  assert.deepEqual(coerce(f('drafts.modes'), 'shipped:x = notify\nbroke = auto'), [{ 'shipped:x': 'notify', broke: 'auto' }]);
  assert.ok(coerce(f('drafts.modes'), 'shipped:fax = auto')[1]); assert.ok(coerce(f('threshold'), 101)[1]); assert.ok(coerce(f('drafts.kinds'), ['nope'])[1]);
  assert.deepEqual(coerce(f('redact.deny'), 'Acme, Globex\nInitech'), [['Acme', 'Globex', 'Initech']]);
  const bad = applySettings(root, { threshold: 40, 'publishing.channels.x.adapter': 'http' });
  assert.equal(bad.ok, false); assert.match(bad.errors[0], /not an editable setting/);
  assert.equal(JSON.parse(fs.readFileSync(p.config, 'utf8')).threshold, undefined, 'nothing written on error');
  assert.equal(getSettings(root).fields.find((x) => x.path === 'redact.deny').source, 'project');

  const s = await startServer({ root, port: 0, quiet: true, tickMs: 50 });
  try {
    const score = async () => JSON.parse((await get(s.port, '/api/state')).body).moments.find((m) => m.kind === 'reversal').score;
    assert.equal(await score(), 60);
    assert.equal((await post(s.port, '/api/settings', { changes: { 'detectors.weights.reversal': 0.5 } })).status, 403, 'needs the x-cts header');
    const r = await post(s.port, '/api/settings', { changes: { 'detectors.weights.reversal': 0.5, 'notify.desktop': false } }, { 'x-cts': '1' });
    assert.equal(r.status, 200);
    assert.equal(await score(), 30, 'rescored with the new weight');
    const cfg = JSON.parse(fs.readFileSync(p.config, 'utf8'));
    assert.equal(cfg.myNote, 'keep me'); assert.deepEqual(cfg.redact.deny, ['Acme']); assert.equal(cfg.notify.desktop, false);
    assert.equal((await post(s.port, '/api/settings', { changes: { 'detectors.weights.reversal': null } }, { 'x-cts': '1' })).status, 200);
    assert.equal(await score(), 60, 'reset to default');
    assert.equal(JSON.parse(fs.readFileSync(p.config, 'utf8')).detectors.weights.reversal, undefined);
  } finally { s.stop(); }
});
