// Performance check on a synthetic 100k-event project: cold index, tail latency, state payload, memory.
// usage: node scripts/bench.mjs [events] [--assert]   --assert exits 1 if a spec budget is missed:
// first paint (warm start + state payload) under 500 ms, live update (one tail tick) under 1 s, steady memory under 150 MB.
// CTS_BENCH_SLACK multiplies the time budgets for slow CI machines (memory is not scaled).
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { Sim, JEST_RED, JEST_GREEN } from '../test/helpers.mjs';
import { serialize, paths, SERVER_FLAGS } from '../src/lib/util.mjs';
import { Project } from '../src/lib/project.mjs';

const N = +process.argv.slice(2).find((a) => /^\d+$/.test(a)) || 100000;
const ASSERT = process.argv.includes('--assert'), SLACK = +process.env.CTS_BENCH_SLACK || 1;
const got = {};
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-bench-')); fs.mkdirSync(path.join(root, '.git'));
const p = paths(root); fs.mkdirSync(p.sessions, { recursive: true });
let total = 0, sessions = 0;
const t0 = Date.now();
while (total < N) {
  const sim = new Sim({ sid: 'b' + sessions, start: Date.now() - (60 - sessions) * 86400e3 / 2 });
  sim.start(); sim.prompt('add feature ' + sessions);
  for (let i = 0; i < 400; i++) {
    sim.call('Read', { file_path: `src/f${i % 40}.js` });
    sim.call('Edit', { file_path: `src/f${i % 40}.js` });
    if (i % 25 === 0) { for (let k = 0; k < 4; k++) sim.bash('npm test', { ok: false, out: JEST_RED(2) }); sim.bash('npm test', { out: JEST_GREEN }); }
    if (i % 80 === 0) sim.prompt('wait, actually go back on item ' + i);
    if (i % 90 === 0) sim.stop('Done for now, revisit src/f' + (i % 40) + '.js later.');
    sim.adv(0.3);
  }
  fs.writeFileSync(path.join(p.sessions, sim.sid + '.jsonl'), sim.events.map(serialize).join(''));
  total += sim.events.length; sessions++;
}
console.log(`generated ${total.toLocaleString()} events in ${sessions} sessions (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
let t = Date.now();
let pr = Project.open(root);
console.log(`cold index (replay + sqlite): ${Date.now() - t} ms · ${pr.engine.moments.size} moments · ${pr.engine.threads.size} threads · rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);
pr.close();
t = Date.now(); pr = Project.open(root);
got.warm = Date.now() - t;
console.log(`warm start (db present, engine replays log): ${got.warm} ms`);
t = Date.now(); const st = JSON.stringify({ moments: pr.engine.listMoments(), threads: [...pr.engine.threads.values()], sessions: pr.engine.sessionList(), arcs: pr.engine.arcs() });
got.payload = Date.now() - t;
console.log(`state payload: ${(st.length / 1e6).toFixed(2)} MB built in ${got.payload} ms`);
t = Date.now(); pr.events({ sid: 'b0', limit: 1500, order: 'desc' }); console.log(`one page of 1500 events: ${Date.now() - t} ms`);
const sim = new Sim({ sid: 'live', start: Date.now() });
sim.start(); sim.prompt('wait, undo'); fs.writeFileSync(path.join(p.sessions, 'live.jsonl'), sim.events.map(serialize).join(''));
t = process.hrtime.bigint(); const r = pr.sync(); console.log(`sync of 2 new events on a ${total.toLocaleString()}-event project: ${(Number(process.hrtime.bigint() - t) / 1e6).toFixed(1)} ms (${r.events.length} events, ${r.ch.moments.size} moment)`);
const more = new Sim({ sid: 'live', start: Date.now() }); more.prompt('another'); fs.appendFileSync(path.join(p.sessions, 'live.jsonl'), more.events.map(serialize).join(''));
t = process.hrtime.bigint(); pr.sync(); got.tick = Number(process.hrtime.bigint() - t) / 1e6; console.log(`tail tick, one appended event: ${got.tick.toFixed(1)} ms`);
{
  // Memory as the dashboard server sees it: a fresh process that opens the project, not this one that generated it.
  const child = `import('${new URL('../src/lib/project.mjs', import.meta.url).href}').then(({ Project }) => { const pr = Project.open(process.argv[1]); pr.sync(); global.gc(); setTimeout(() => { global.gc(); console.log(process.memoryUsage().rss); pr.close(); }, 50); });`; // file buffers are released on the second GC pass, as in a running server
  const r = spawnSync(process.execPath, [...SERVER_FLAGS, '--expose-gc', '-e', child, root], { encoding: 'utf8' });
  got.rss = +r.stdout.trim() / 1e6 || null;
  console.log(got.rss ? `steady memory, fresh process with the project open (after GC): rss ${got.rss.toFixed(0)} MB` : 'steady memory: not measured');
}
t = Date.now(); pr.reindex(); console.log(`reindex: ${Date.now() - t} ms · rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);
pr.close(); if (process.env.KEEP) console.log("kept " + root); else fs.rmSync(root, { recursive: true, force: true });
if (ASSERT) {
  const fails = [];
  if (got.warm + got.payload > 500 * SLACK) fails.push(`first paint ${got.warm + got.payload} ms > ${500 * SLACK} ms`);
  if (got.tick > 1000 * SLACK) fails.push(`live update ${got.tick.toFixed(0)} ms > ${1000 * SLACK} ms`);
  if (got.rss == null) fails.push('memory not measured');
  else if (got.rss > 150) fails.push(`steady memory ${got.rss.toFixed(0)} MB > 150 MB`);
  console.log(fails.length ? 'BUDGETS MISSED: ' + fails.join('; ') : `budgets hold (time slack x${SLACK})`);
  if (fails.length) process.exitCode = 1;
}
