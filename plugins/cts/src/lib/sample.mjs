// A believable sample session so the first screen is never empty (`cts demo`). Every event is flagged demo.
import fs from 'node:fs';
import path from 'node:path';
import { Sim, JEST_RED, JEST_GREEN } from './sim.mjs';
import { serialize, paths, ensureProject } from './util.mjs';

export function buildDemo(now = Date.now()) {
  // Yesterday: the first, rushed pass.
  const a = new Sim({ sid: 'demo-day1', start: now - 27 * 3600e3, demo: true, cwd: '/work/shopfront' });
  a.start('startup'); a.adv(0.3);
  a.prompt('Add a rate limiter to the login endpoint. Keep it simple.');
  a.call('Read', { file_path: 'src/routes/login.js' }); a.call('Write', { file_path: 'src/limiter.js' }, { dur: 0.5 });
  a.stop('Added a fixed-window limiter in src/limiter.js, in-memory for now. I will revisit limiter.js when we know the traffic pattern.');
  a.adv(6); a.prompt('ok, commit it');
  a.bash('git commit -am "login rate limiter"', { git: { branch: 'main', subject: 'login rate limiter', files: ['src/limiter.js', 'src/routes/login.js'], stat: { files: 2, ins: 64, del: 3 } } });
  a.ev('session.end', { reason: 'prompt_input_exit' });

  // Today: resumed, and it goes sideways.
  const s = new Sim({ sid: 'demo-live', start: now - 44 * 60000, demo: true, cwd: '/work/shopfront' });
  s.start('resume'); s.adv(0.3);
  s.prompt('The limiter lets bursts through. Switch to a token bucket and make the refill test pass.');
  s.call('Read', { file_path: 'src/limiter.js' }); s.call('Read', { file_path: 'test/limiter.test.js' }); s.call('Read', { file_path: 'src/routes/login.js' });
  const q = s.pre('AskUserQuestion', { questions: ['Should the bucket live in Redis or in memory?'] }); s.adv(2.5);
  s.post('AskUserQuestion', {}, { id: q, out: 'In memory' }); s.adv(0.2);

  // planner vs evaluator, in parallel with a reviewer
  s.subStart('a1', 'planner', 'planner'); s.subStart('a3', 'cts:reviewer', 'reviewer'); s.adv(2.5);
  s.subStop('a1', 'planner', 'Plan complete: token bucket per IP, 5 requests per minute, refill every 12 seconds. Ready to implement.'); s.adv(0.6);
  s.subStart('a2', 'evaluator', 'evaluator'); s.adv(3);
  s.subStop('a2', 'evaluator', 'Rejected: the plan is missing a rollback path, and the refill assertion in the test is wrong.'); s.adv(1.2);
  s.subStop('a3', 'cts:reviewer', 'Reviewed: login.js touches the limiter in two places. TODO decide whether register.js should share this limiter.'); s.adv(1);

  s.call('Write', { file_path: 'src/limiter.js' }, { dur: 0.6 });
  for (let i = 0; i < 5; i++) {
    s.bash('npm test -- limiter', { ok: false, out: JEST_RED(3 - Math.min(2, i)) }, { dur: 0.4 }); s.adv(1.4);
    s.call('Edit', { file_path: 'src/limiter.js' }, { dur: 0.2 });
    if (i === 3) s.ev('model.post', { from: 'claude-sonnet-5-5', to: 'claude-opus-5-5' });
    s.adv(0.8);
  }
  s.bash('npm test -- limiter', { out: JEST_GREEN }); s.adv(1.5);
  s.prompt('wait, go back. The evaluator is right, add the rollback path first.');
  s.ev('permission.denied', { tool: 'Bash', input: { command: 'rm -rf node_modules' }, reason: 'destructive command' }); s.adv(2);
  s.call('Write', { file_path: 'src/rollback.js' }, { dur: 0.5 });
  s.ev('compact.post', { trigger: 'auto' }); s.adv(1.5);
  s.call('Read', { file_path: 'src/limiter.js' }); s.call('Read', { file_path: 'src/routes/login.js' }); s.adv(1);
  s.bash('npm test', { out: 'Tests: 14 passed, 14 total' }); s.adv(4);
  s.call('Edit', { file_path: 'src/routes/login.js' }, { dur: 0.3 }); s.adv(0.5);
  s.bash('npm test', { ok: false, out: 'FAIL test/login.test.js\nTests: 2 failed, 12 passed, 14 total' }); s.adv(2);
  s.prompt('fix login.test.js, then commit'); s.adv(0.6);
  s.call('Edit', { file_path: 'src/routes/login.js' }); s.bash('npm test', { out: 'Tests: 14 passed, 14 total' }); s.adv(1);
  s.stop('Token bucket is in with a rollback path. I used an in-memory store for now; revisit Redis in limiter.js once load tests exist.'); s.adv(0.8);
  s.prompt('good. commit it'); s.adv(0.3);
  s.bash('git commit -am "token bucket limiter with rollback"', { git: { branch: 'main', subject: 'token bucket limiter with rollback', files: ['src/limiter.js', 'src/rollback.js', 'src/routes/login.js'], stat: { files: 3, ins: 118, del: 41 } } });
  s.adv(0.4);
  s.pre('Bash', { command: 'npm run lint' });
  return [a, s];
}

export function writeDemo(root, now) {
  const p = ensureProject(root);
  for (const sim of buildDemo(now)) fs.writeFileSync(path.join(p.sessions, `${sim.sid}.jsonl`), sim.events.map(serialize).join(''));
  return paths(root);
}
export function clearDemo(root) {
  const p = paths(root);
  let n = 0;
  try { for (const f of fs.readdirSync(p.sessions)) if (f.startsWith('demo-')) { fs.rmSync(path.join(p.sessions, f)); n++; } } catch { /* nothing */ }
  return n;
}
