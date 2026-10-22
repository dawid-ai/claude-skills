import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Project } from '../src/lib/project.mjs';
import { paths, serialize } from '../src/lib/util.mjs';
import * as ex from '../src/lib/extract.mjs';
import { AutoExtractor } from '../src/lib/autoextract.mjs';
import { Sim, JEST_RED, JEST_GREEN } from './helpers.mjs';

const MIN = 60000;
function proj(cfg = {}, { end = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-ax-')); fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(paths(root).sessions, { recursive: true });
  fs.writeFileSync(paths(root).config, JSON.stringify(cfg));
  const s = new Sim({ start: Date.now() - 3600e3 }); s.start();
  s.prompt('make the limiter pass its tests'); s.adv(1);
  for (let i = 0; i < 4; i++) { s.bash('npm test', { ok: false, out: JEST_RED(2) }); s.adv(2); }
  s.bash('npm test', { out: JEST_GREEN }); s.adv(1);
  s.stop('Done.');
  if (end) s.ev('session.end', { reason: 'prompt_input_exit' });
  fs.writeFileSync(path.join(paths(root).sessions, 's1.jsonl'), s.events.map(serialize).join(''));
  return root;
}
/** A fake model: keeps the fight, first with a number the log does not support, then fixed on the repair round. */
function fakeModel() {
  const calls = [];
  const ask = async (system, user) => {
    calls.push(user);
    const packet = JSON.parse(user.split('\n\nYour previous answer')[0]);
    const fight = packet.candidates.find((c) => c.kind === 'fight');
    const headline = calls.length === 1 ? 'Limiter test stayed red for 9 runs' : 'Limiter test stayed red for 4 runs, then one change fixed it';
    return 'Here you go:\n' + JSON.stringify({ moments: [{ target: fight.id, headline, body: [], score: 80, cite: fight.cite, evidence: {} }] });
  };
  return { ask, calls };
}

test('extractNow: an untraceable number is rejected, the repair round fixes exactly that item, the result replays', async () => {
  const root = proj(); const pr = Project.open(root);
  const { ask, calls } = fakeModel();
  const r = await ex.extractNow(pr, { ask });
  assert.equal(r.rounds, 2); assert.equal(calls.length, 2);
  assert.match(calls[1], /validator rejected/); assert.match(calls[1], /9 runs/);
  assert.equal(r.accepted.moments, 1); assert.equal(r.rejected.length, 0);
  const fight = pr.engine.listMoments().find((m) => m.kind === 'fight');
  assert.equal(fight.tier, 2); assert.match(fight.headline, /4 runs/);
  pr.reindex();
  assert.match(pr.engine.listMoments().find((m) => m.kind === 'fight').headline, /4 runs/);
  assert.ok((await ex.extractNow(pr, { ask: async () => { throw new Error('should not be called'); } })).none, 'nothing left to extract');
  pr.close();
});

test('auto-extraction: off by default; runs at session end; respects the gap; backs off on failure; survives a restart', async () => {
  const off = Project.open(proj());
  assert.equal(new AutoExtractor(off).reason(), null, 'off unless extraction.auto is set');
  off.close();

  const root = proj({ extraction: { auto: 'api', urgentScore: 101 } });
  let pr = Project.open(root);
  let t = Date.now();
  let failing = true;
  const { ask } = fakeModel();
  const flaky = async (s, u) => { if (failing) throw new Error('API 529: overloaded'); return ask(s, u); };
  const ax = new AutoExtractor(pr, { ask: flaky, now: () => t });
  assert.equal(ax.reason(), 'session-end');
  assert.ok((await ax.maybeRun()).error);
  assert.equal(ax.fails, 1);
  assert.match(fs.readFileSync(paths(root).hooklog, 'utf8'), /auto-extraction \(session-end\): API 529/);
  t += 6 * MIN; assert.equal(ax.reason(), null, 'backoff doubles the 5 minute gap after a failure');
  t += 5 * MIN; assert.equal(ax.reason(), 'session-end');

  // A restarted server picks up the failure count and the last attempt from the log.
  pr.close(); pr = Project.open(root);
  const ax2 = new AutoExtractor(pr, { ask: flaky, now: () => t });
  assert.equal(ax2.fails, 1); assert.equal(ax2.reason(), 'session-end');
  failing = false;
  const r = await ax2.maybeRun();
  assert.equal(r.accepted.moments, 1); assert.equal(ax2.fails, 0);
  t += 60 * MIN; assert.equal(ax2.reason(), null, 'nothing pending after a good run');
  const autos = pr.engine.listMoments().length && pr.events({ kinds: ['extract.auto'], limit: 10 });
  assert.deepEqual(autos.map((e) => e.d.ok).sort(), [false, true]);
  pr.close();
});

test('auto-extraction: a strong candidate triggers before session end; the interval covers the rest', () => {
  const pr = Project.open(proj({ extraction: { auto: 'claude', urgentScore: 50, everyMinutes: 30 } }, { end: false }));
  let t = Date.now();
  const ax = new AutoExtractor(pr, { ask: async () => '{}', now: () => t });
  assert.equal(ax.reason(), 'strong-candidate');
  pr.cfg.extraction.urgentScore = 101;
  ax.lastRun = t; ax.lastAttempt = t;
  t += 10 * MIN; assert.equal(ax.reason(), null);
  t += 25 * MIN; assert.equal(ax.reason(), 'interval');
  pr.cfg.private = true; assert.equal(ax.reason(), null, 'a private project never sends anything');
  pr.close();
});

test('askClaude: no tools or MCP servers, no saved session, prompt via file, capture skipped; works through a .cmd shim too', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-fakeclaude-'));
  const fake = path.join(dir, 'fake.mjs');
  // Echoes what it was given so the test can check the contract.
  fs.writeFileSync(fake, `import fs from 'node:fs';
const a = process.argv.slice(2), i = a.indexOf('--system-prompt-file');
const stdin = fs.readFileSync(0, 'utf8');
process.stdout.write(JSON.stringify([{ type: 'system', subtype: 'init' }, { type: 'result', is_error: false, result: JSON.stringify({ args: a, system: fs.readFileSync(a[i + 1], 'utf8'), stdin, skip: process.env.CTS_SKIP_CAPTURE, cwd: process.cwd() }) }]));`);
  const bins = [];
  if (process.platform === 'win32') {
    const cmd = path.join(dir, 'claude shim.cmd');
    fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`);
    bins.push(cmd);
  } else {
    const sh = path.join(dir, 'claude');
    fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`); fs.chmodSync(sh, 0o755);
    bins.push(sh);
  }
  const system = 'Rules:\n- quote "exactly"\n- 100% & <no> | pipes';
  for (const bin of bins) {
    const got = JSON.parse(await ex.askClaude(system, '{"packet":1}', { model: 'claude-haiku-5-5', bin }));
    assert.equal(got.system, system, 'system prompt arrives intact');
    assert.equal(got.stdin, '{"packet":1}');
    assert.equal(got.skip, '1');
    const tools = got.args.indexOf('--tools');
    assert.ok(tools >= 0 && got.args[tools + 1] === '', 'all tools disabled');
    assert.ok(got.args.includes('--no-session-persistence') && got.args.includes('-p'));
    assert.ok(got.args.includes('--restricted') && got.args.includes('--strict-mcp-config'), 'no MCP servers, plugins or settings');
    assert.equal(got.args[got.args.indexOf('--model') + 1], 'claude-haiku-5-5');
    assert.ok(!fs.existsSync(got.cwd), 'ran in a temp dir that is cleaned up');
  }
  await assert.rejects(ex.askClaude('s', 'u', { bin: path.join(dir, 'missing-claude.exe') }), /could not run|failed/);
});
