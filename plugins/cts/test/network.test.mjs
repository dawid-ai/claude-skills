import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { paths, serialize } from '../src/lib/util.mjs';
import { Sim, JEST_RED, JEST_GREEN } from './helpers.mjs';

// The privacy promise: nothing leaves the machine except to configured channels and the user's model provider.
// This runs every local surface (index, autopilot, publish to the outbox, share, every export, extraction packet,
// the dashboard server) with the network and process APIs patched, and fails on any non-loopback connection.
const require = createRequire(import.meta.url);
const net = require('node:net'), dns = require('node:dns'), cp = require('node:child_process');
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const seen = { connect: [], dns: [], fetch: [], spawn: [] };

function patch() {
  const orig = { connect: net.Socket.prototype.connect, lookup: dns.lookup, fetch: globalThis.fetch, spawn: cp.spawn, spawnSync: cp.spawnSync, execFileSync: cp.execFileSync, execFile: cp.execFile, exec: cp.exec, execSync: cp.execSync };
  net.Socket.prototype.connect = function (...a) {
    const o = typeof a[0] === 'object' && a[0] ? a[0] : { port: a[0], host: typeof a[1] === 'string' ? a[1] : undefined };
    if (!o.path) seen.connect.push(o.host || 'localhost');
    return orig.connect.apply(this, a);
  };
  dns.lookup = function (host, ...a) { seen.dns.push(host); return orig.lookup.call(this, host, ...a); };
  globalThis.fetch = function (u, ...a) { seen.fetch.push(new URL(String(u.url || u)).hostname); return orig.fetch.call(this, u, ...a); };
  for (const k of ['spawn', 'spawnSync', 'execFileSync', 'execFile', 'exec', 'execSync']) cp[k] = function (cmd, ...a) { seen.spawn.push(path.basename(String(cmd)).replace(/\.exe$/i, '')); return orig[k].call(this, cmd, ...a); };
  syncBuiltinESMExports();
  return () => { Object.assign(cp, { spawn: orig.spawn, spawnSync: orig.spawnSync, execFileSync: orig.execFileSync, execFile: orig.execFile, exec: orig.exec, execSync: orig.execSync }); net.Socket.prototype.connect = orig.connect; dns.lookup = orig.lookup; globalThis.fetch = orig.fetch; syncBuiltinESMExports(); };
}

function seed() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-net-')); fs.mkdirSync(path.join(root, '.git')); fs.mkdirSync(paths(root).sessions, { recursive: true });
  fs.writeFileSync(paths(root).config, JSON.stringify({ port: 0, drafts: { channels: ['x', 'bluesky'], modes: { 'shipped:x': 'notify' } }, publishing: { channels: { blog: { adapter: 'blog', dir: 'content/posts', cap: 2 } } } }));
  const s = new Sim({ start: Date.now() - 3 * 3600e3, cwd: root }); s.start();
  s.prompt('make the limiter pass for Acme Corp, key sk-ant-api03-' + 'x'.repeat(40)); s.adv(1);
  for (let i = 0; i < 4; i++) { s.bash('npm test', { ok: false, out: JEST_RED(2) }); s.adv(2); }
  s.bash('npm test', { out: JEST_GREEN }); s.adv(1);
  s.subStart('a1', 'planner', 'planner'); s.adv(2); s.subStop('a1', 'planner', 'The plan is complete and ready to implement.');
  s.subStart('a2', 'evaluator', 'evaluator'); s.adv(2); s.subStop('a2', 'evaluator', 'Rejected: the rollback step is missing.');
  s.prompt('wait, go back to the old refill logic; keep it for now and revisit later'); s.adv(1);
  s.bash('git commit -m "limiter: restore refill logic"', { git: { branch: 'main', subject: 'limiter: restore refill logic', files: ['src/limiter.js'], stat: { files: 3, ins: 40, del: 2 } } });
  s.stop('Done.');
  fs.writeFileSync(path.join(paths(root).sessions, 's1.jsonl'), s.events.map(serialize).join(''));
  return root;
}

test('no surface opens a non-loopback connection, resolves a hostname, or runs anything but git and node', async () => {
  const root = seed();
  const restore = patch();
  const stops = [];
  try {
    process.env.CTS_NO_NOTIFY = '1';
    const { Project } = await import('../src/lib/project.mjs');
    const N = await import('../src/lib/narrative.mjs');
    const PB = await import('../src/lib/publish.mjs');
    const X = await import('../src/lib/exporters.mjs');
    const SH = await import('../src/lib/share.mjs');
    const E = await import('../src/lib/extract.mjs');
    const { notifyDrafts } = await import('../src/lib/notify.mjs');
    const { startServer } = await import('../src/server.mjs');
    const pr = Project.open(root);
    assert.ok(pr.engine.listMoments().length >= 3, 'the fixture produces moments');
    const made = N.autoDrafts(pr);
    assert.ok(made.length >= 1, 'autopilot drafts');
    notifyDrafts(pr, { send: () => {} });
    const id = made[0];
    N.approve(pr, id);
    const pub = PB.publishDraft(pr, id);
    assert.ok(pub.ok, pub.reason);
    PB.runQueue(pr);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-net-out-'));
    fs.writeFileSync(path.join(out, 'story.html'), SH.buildStoryHtml(pr));
    for (const m of pr.engine.listMoments()) SH.cardSvg(m, 'x');
    SH.digestMarkdown(pr, { from: 0, to: Date.now() });
    X.exportMarkdown(pr, path.join(out, 'md'));
    X.exportOtel(pr);
    X.eventsNdjson(pr); X.eventsNdjson(pr, { raw: true }); X.marksMarkdown(pr);
    X.exportBundle(pr, path.join(out, 'b.cts.zip'));
    X.replayHtml(X.replayData(pr));
    E.prepare(pr);
    pr.close();
    const s = await startServer({ root, port: 0, quiet: true, tickMs: 50, notifySend: () => {} }); stops.push(s.stop);
    for (const p of ['/api/state', '/api/drafts', '/api/share/story.html', '/']) assert.equal((await fetch(`http://127.0.0.1:${s.port}${p}`)).status, 200, p);
    await new Promise((r) => setTimeout(r, 200));
  } finally {
    for (const f of stops) f();
    restore();
    delete process.env.CTS_NO_NOTIFY;
  }
  const off = (xs) => xs.filter((h) => !LOOPBACK.has(String(h)));
  assert.deepEqual(off(seen.connect), [], 'non-loopback socket connections');
  assert.deepEqual(off(seen.dns), [], 'hostname lookups');
  assert.deepEqual(off(seen.fetch), [], 'fetch to a non-loopback host');
  assert.deepEqual(seen.spawn.filter((c) => !['git', 'node'].includes(c) && c !== path.basename(process.execPath).replace(/\.exe$/i, '')), [], 'unexpected child processes');
  assert.ok(seen.connect.length >= 1, 'the probe saw the loopback requests (it is wired up)');
});
