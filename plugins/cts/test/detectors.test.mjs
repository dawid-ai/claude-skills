import test from 'node:test';
import assert from 'node:assert/strict';
import { run, JEST_RED, JEST_GREEN } from './helpers.mjs';
import { testSegment, testInfo } from '../src/lib/parse.mjs';

const has = (r, k) => r.kinds.includes(k);

test('reversal fires on a correction prompt, not on a normal one', () => {
  assert.ok(has(run((s) => { s.start(); s.prompt('wait, go back to the old approach'); }), 'reversal'));
  assert.ok(has(run((s) => { s.start(); s.prompt('actually that is wrong'); }), 'reversal'));
  assert.ok(!has(run((s) => { s.start(); s.prompt('now add tests for the parser'); s.prompt('nothing to see, notable work'); }), 'reversal'));
});
test('reversal fires on git revert and hard reset, not on plain reset', () => {
  assert.ok(has(run((s) => { s.start(); s.bash('git revert HEAD'); }), 'reversal'));
  assert.ok(has(run((s) => { s.start(); s.bash('git reset --hard HEAD~1'); }), 'reversal'));
  assert.ok(!has(run((s) => { s.start(); s.bash('git reset src/a.js'); }), 'reversal'));
  assert.ok(!has(run((s) => { s.start(); s.bash('git reset -q --soft HEAD~1 && git reset -q && git add src/a.js'); }), 'reversal'), 'uncommitting to re-split keeps the work');
});

test('fight: 4 red runs then green gives one moment scored 40+5n; 2 reds do not', () => {
  const r = run((s) => {
    s.start();
    for (let i = 0; i < 4; i++) { s.bash('npm test', { ok: false, out: JEST_RED(2) }); s.adv(2); }
    s.bash('npm test', { out: JEST_GREEN });
  });
  const f = r.moments.filter((m) => m.kind === 'fight');
  assert.equal(f.length, 1);
  assert.equal(f[0].score, 60);
  assert.equal(f[0].evidence.attempts, 4);
  assert.equal(r.eng.sessions.get('s1').stats.redGreen, 1);
  const n = run((s) => { s.start(); s.bash('npm test', { ok: false, out: JEST_RED(1) }); s.bash('npm test', { ok: false, out: JEST_RED(1) }); s.bash('npm test', { out: JEST_GREEN }); });
  assert.ok(!has(n, 'fight'));
});
test('fight score caps at 90 and also fires on repeated edit failures', () => {
  const r = run((s) => {
    s.start();
    for (let i = 0; i < 14; i++) s.post('Edit', { file_path: 'a.js' }, { ok: false, out: 'old_string not found' });
    s.post('Edit', { file_path: 'a.js' });
  });
  assert.equal(r.moments.find((m) => m.kind === 'fight').score, 90);
});
test('fight: failures on different targets do not combine', () => {
  const r = run((s) => {
    s.start();
    s.bash('ls /nope1', { ok: false }); s.bash('ls /nope2', { ok: false }); s.bash('ls /nope3', { ok: false }); s.bash('ls /ok');
  });
  assert.ok(!has(r, 'fight'));
});

test('disagreement: evaluator says missing after planner said done; agreement does not fire', () => {
  const r = run((s) => {
    s.start();
    s.subStart('a1', 'planner', 'planner'); s.adv(3); s.subStop('a1', 'planner', 'The plan is complete and ready to implement.');
    s.adv(2); s.subStart('a2', 'evaluator', 'evaluator'); s.adv(3); s.subStop('a2', 'evaluator', 'Rejected: the rollback step is missing from the plan.');
  });
  const m = r.moments.find((x) => x.kind === 'disagreement');
  assert.ok(m); assert.equal(m.score, 70); assert.deepEqual(m.actors.sort(), ['agent:a1', 'agent:a2']);
  assert.match(m.headline, /evaluator pushed back on planner/);
  const n = run((s) => { s.start(); s.subStop('a1', 'planner', 'The plan is complete and ready.'); s.adv(1); s.subStop('a2', 'evaluator', 'Looks good, approved and ready.'); });
  assert.ok(!has(n, 'disagreement'));
});

test('shipped: commit on main yes, commit on feature branch no, tag and deploy yes', () => {
  assert.ok(has(run((s) => { s.start(); s.bash('git commit -m "x"', { git: { branch: 'main', subject: 'x', files: ['a.js'], stat: { files: 1, ins: 3, del: 1 } } }); }), 'shipped'));
  assert.ok(has(run((s) => { s.start(); s.bash('git commit -m "x"', { git: { branch: 'release/1.2', subject: 'x' } }); }), 'shipped'));
  assert.ok(!has(run((s) => { s.start(); s.bash('git commit -m "x"', { git: { branch: 'feature/x', subject: 'x' } }); }), 'shipped'));
  assert.ok(has(run((s) => { s.start(); s.bash('git tag v1.0.0', { git: { branch: 'main', tag: 'v1.0.0' } }); }), 'shipped'));
  assert.ok(has(run((s) => { s.start(); s.bash('fly deploy --remote-only'); }), 'shipped'));
  assert.ok(!has(run((s) => { s.start(); s.bash('echo deployment notes'); }), 'shipped'));
});

test('broke: green to red fires once; red without prior green does not', () => {
  const r = run((s) => { s.start(); s.bash('pytest -q', { out: '5 passed in 0.1s' }); s.adv(5); s.bash('pytest -q', { ok: false, out: '1 failed, 4 passed' }); s.bash('pytest -q', { ok: false, out: '1 failed, 4 passed' }); });
  assert.equal(r.kinds.filter((k) => k === 'broke').length, 1);
  assert.ok(!has(run((s) => { s.start(); s.bash('pytest -q', { ok: false, out: '1 failed, 4 passed' }); }), 'broke'));
});

test('pivot: long branch then switch, worktree, dependency swap, deleting a just-written file', () => {
  assert.ok(has(run((s) => { s.start(); s.bash('git commit -m a', { git: { branch: 'feature/a', subject: 'a' } }); s.adv(60); s.bash('git checkout -b feature/b', { git: { branch: 'feature/b' } }); }), 'pivot'));
  assert.ok(!has(run((s) => { s.start(); s.bash('git commit -m a', { git: { branch: 'feature/a', subject: 'a' } }); s.adv(5); s.bash('git checkout -b feature/b', { git: { branch: 'feature/b' } }); }), 'pivot'));
  assert.ok(has(run((s) => { s.start(); s.bash('git worktree add ../try-2'); }), 'pivot'));
  assert.ok(has(run((s) => { s.start(); s.bash('npm uninstall moment'); s.adv(2); s.bash('npm install dayjs'); }), 'pivot'));
  assert.ok(!has(run((s) => { s.start(); s.bash('npm install dayjs'); }), 'pivot'));
  assert.ok(has(run((s) => { s.start(); s.post('Write', { file_path: '/work/app/src/old.js' }); s.adv(10); s.bash('rm src/old.js'); }), 'pivot'));
  assert.ok(!has(run((s) => { s.start(); s.post('Write', { file_path: '/work/app/src/old.js' }); s.adv(120); s.bash('rm src/old.js'); }), 'pivot'));
});

test('memory-cut: re-reading files after compaction fires; reading new files does not', () => {
  const r = run((s) => {
    s.start(); s.post('Read', { file_path: 'a.js' }); s.post('Read', { file_path: 'b.js' });
    s.ev('compact.post', { trigger: 'auto' }); s.adv(2); s.post('Read', { file_path: 'a.js' }); s.post('Read', { file_path: 'b.js' });
  });
  assert.ok(has(r, 'memory-cut'));
  const n = run((s) => { s.start(); s.post('Read', { file_path: 'a.js' }); s.ev('compact.post', {}); s.adv(2); s.post('Read', { file_path: 'c.js' }); s.post('Read', { file_path: 'd.js' }); });
  assert.ok(!has(n, 'memory-cut'));
  const late = run((s) => { s.start(); s.post('Read', { file_path: 'a.js' }); s.post('Read', { file_path: 'b.js' }); s.ev('compact.post', {}); s.adv(30); s.post('Read', { file_path: 'a.js' }); s.post('Read', { file_path: 'b.js' }); });
  assert.ok(!has(late, 'memory-cut'));
});

test('refusal: permission denied and rejecting prompt fire; neutral prompt does not', () => {
  assert.ok(has(run((s) => { s.start(); s.ev('permission.denied', { tool: 'Bash', input: { command: 'rm -rf x' } }); }), 'refusal'));
  assert.ok(has(run((s) => { s.start(); s.prompt("don't touch the schema"); }), 'refusal'));
  assert.ok(!has(run((s) => { s.start(); s.prompt('please touch the schema'); }), 'refusal'));
});

test('wait: >30 min after asking the human fires; 5 min does not', () => {
  const mk = (gap) => run((s) => { s.start(); s.ev('permission.request', { tool: 'Bash' }); s.adv(gap); s.prompt('ok go ahead'); });
  assert.ok(has(mk(45), 'wait'));
  assert.ok(!has(mk(5), 'wait'));
  assert.equal(mk(45).moments.find((m) => m.kind === 'wait').score, 20);
});

test('escalation: switching up during a fight fires; switching up with no fight does not; down never', () => {
  const up = (fight, to = 'claude-opus-5-5') => run((s) => {
    s.start();
    if (fight) { s.bash('npm test', { ok: false, out: JEST_RED(1) }); s.bash('npm test', { ok: false, out: JEST_RED(1) }); }
    s.ev('model.post', { from: 'claude-sonnet-5-5', to });
  });
  assert.ok(has(up(true), 'escalation'));
  assert.ok(!has(up(false), 'escalation'));
  assert.ok(!has(up(true, 'claude-haiku-5-5'), 'escalation'));
});

test('mark: creates a 100-score moment, or confirms a fresh auto moment; dismiss lowers that detector weight', () => {
  const r = run((s) => { s.start(); s.prompt('hello'); s.ev('mark', { note: 'this is the bit' }, { actor: 'human' }); });
  const m = r.moments.find((x) => x.kind === 'mark');
  assert.equal(m.score, 100); assert.equal(m.headline, 'this is the bit');
  const c = run((s) => { s.start(); s.prompt('wait, undo that'); s.ev('mark', { note: 'good one' }, { actor: 'human' }); });
  assert.ok(!c.kinds.includes('mark')); assert.equal(c.moments.find((x) => x.kind === 'reversal').score, 100);
  const d = run((s) => { s.start(); s.prompt('wait, undo that'); s.ev('dismiss', {}, { actor: 'human' }); s.prompt('actually, no'); });
  assert.equal(d.moments.find((x) => x.kind === 'reversal' && x.status === 'dismissed').score, 0);
  assert.equal(d.eng.weight('reversal'), 0.9);
  assert.equal(d.moments.find((x) => x.kind === 'reversal' && x.status === 'auto').score, 54);
});

test('moment ids are deterministic across replays', () => {
  const f = (s) => { s.start(); s.prompt('wait no'); s.bash('git revert HEAD'); };
  const a = run(f), b = (() => { const { sim } = run(f); const { Engine } = a.eng.constructor ? { Engine: a.eng.constructor } : {}; const e = new Engine(); for (const ev of sim.events) e.push(structuredClone(ev)); return e; })();
  assert.deepEqual([...a.eng.moments.keys()], [...b.moments.keys()]);
});

test('commands that merely mention git or test runners (heredocs, quoted strings) never fire detectors', () => {
  const r = run((s) => {
    s.start();
    s.bash('cat > t.mjs <<\'EOF\'\ntest("x", () => run("git revert HEAD && git reset --hard HEAD~1 && fly deploy"))\nEOF');
    s.bash('echo "git revert HEAD; npm test"');
    s.bash('git commit -m "revert the old limiter"', { git: { branch: 'feature/x', subject: 'revert the old limiter' } });
  });
  assert.deepEqual(r.kinds, []);
  const w = run((s) => { s.start(); s.bash('bash -c "git revert HEAD"'); });
  assert.ok(w.kinds.includes('reversal'), 'bash -c is unwrapped');
});
test('quoted hedge words and abbreviations do not open threads', async () => {
  const { hedgeSentence } = await import('../src/lib/parse.mjs');
  assert.equal(hedgeSentence('Do not register hooks e.g. the "for now" kind.'), null);
  assert.match(hedgeSentence('Done. We store it in memory for now, and will revisit later. Next.'), /^We store it in memory for now/);
  assert.equal(hedgeSentence('Fine. TODO'), null);
});

test('real-project regressions: a command that only mentions deploy is not a ship; a deploy segment is', () => {
  for (const cmd of ['grep -n "deploy" scripts/deploy-changes.ts', 'ls .claude/skills/lst-deploy', 'cat public/deploy.txt', 'LAST_DEPLOY=$(cat .last-deploy-date); echo $LAST_DEPLOY', 'sed -n 1,9p scripts/deploy-changes.ts'])
    assert.ok(!has(run((s) => { s.start(); s.bash(cmd); }), 'shipped'), cmd);
  const r = run((s) => { s.start(); s.bash('cd app && LOG=1 npm run deploy:changes'); });
  assert.equal(r.moments.find((m) => m.kind === 'shipped').headline, 'Deployed: npm run deploy:changes');
});

test('real-project regressions: a long report that mentions a problem later is not a pushback; a verdict that pushes back is', () => {
  const noise = run((s) => {
    s.start();
    s.stop('Done so far: the price fix and the draft guard are committed and ready.');
    s.adv(2); s.subStart('r1', 'researcher', 'researcher');
    s.subStop('r1', 'researcher', 'Batch 6 is done: 18 tools published.\nTwo logos may be missing a dark variant and 12 rows failed to scrape.');
  });
  assert.ok(!has(noise, 'disagreement'), 'the verdict is positive; problems later in a report do not count');
  const json = run((s) => { s.start(); s.stop('The plan is complete.'); s.subStop('r2', 'researcher', '{"plan": "missing", "status": "rejected"}'); });
  assert.ok(!has(json, 'disagreement'), 'structured output has no verdict');
  const unrelated = run((s) => { s.start(); s.stop('The deploy script is ready.'); s.subStop('r3', 'auditor', 'Rejected: the invoice template is missing a footer.'); });
  assert.ok(!has(unrelated, 'disagreement'), 'a pushback about something else is not a disagreement');
});

test('real-project regressions: a dependency swap names only packages, never shell plumbing', () => {
  const r = run((s) => { s.start(); s.bash('npm uninstall ai @ai-sdk/anthropic 2>&1 | tail -3'); s.adv(2); s.bash('npm i better-sqlite3@^11.0.0 && git diff package.json; grep -n "x" package.json | head'); });
  assert.equal(r.moments.find((m) => m.kind === 'pivot').headline, 'Swapped ai, @ai-sdk/anthropic for better-sqlite3');
  assert.ok(!has(run((s) => { s.start(); s.bash('npm uninstall 2>&1 | tail'); s.adv(1); s.bash('npm i dayjs'); }), 'pivot'), 'nothing removed, nothing swapped');
});

test('real-project regressions: the same deploy repeated within hours is one ship, not six', () => {
  const r = run((s) => { s.start(); for (let i = 0; i < 5; i++) { s.bash('npm run deploy:changes'); s.adv(60); } s.adv(60 * 7); s.bash('npm run deploy:changes'); });
  const ships = r.moments.filter((m) => m.kind === 'shipped');
  assert.equal(ships.filter((m) => m.score >= 50).length, 2, 'the first, and the next one after a 6-hour gap');
  assert.equal(ships.length, 6, 'repeats are still recorded, under the feed threshold');
});

const VT = (pass, fail = 0) => ` Test Files  1 passed (1)\n      Tests  ${fail ? `${fail} failed | ` : ''}${pass} passed (${pass + fail})`;
test('real-project regressions: tests are keyed on the run itself, not on a shared `cd "<project>" &&` prefix', () => {
  const cd = 'cd "/c/Users/me/projects/app one" && ';
  const across = run((s) => { s.start(); s.bash(cd + 'npx vitest run packages/cli 2>&1 | tail -30', { out: VT(13) }); s.adv(1); s.bash(cd + 'npx vitest run packages/analysis 2>&1 | tail -40', { out: VT(17, 2) }); });
  assert.ok(!has(across, 'broke'), 'a green run of one package and a red run of another are different targets');
  const same = run((s) => { s.start(); s.bash(cd + 'npm test 2>&1 | tail -6', { out: VT(313) }); s.adv(5); s.bash(cd + 'npx tsc -b && npm test 2>&1 | grep -E "Tests"', { out: VT(312, 1) }); });
  assert.equal(same.moments.find((m) => m.kind === 'broke').headline, 'Tests went red: npm test');
});

test('real-project regressions: new tests failing on their first run are not a regression', () => {
  const r = run((s) => { s.start(); s.bash('npx vitest run packages/cli', { out: VT(13) }); s.adv(1); s.bash('npx vitest run packages/cli', { ok: false, out: VT(44, 1) }); });
  assert.ok(!has(r, 'broke'), '13 green, then 45 with 1 failing: a new test, not a break');
  const reg = run((s) => { s.start(); s.bash('npx vitest run packages/cli', { out: VT(313) }); s.adv(1); s.bash('npx vitest run packages/cli', { ok: false, out: VT(312, 2) }); });
  assert.ok(has(reg, 'broke'), 'one test added, two failing: something that passed broke');
});

test('real-project regressions: only a runner at the start of a segment is a test run; a pipe owns the exit code', () => {
  for (const c of ['ls vitest.config.* apps/web', 'cat jest.config.js && head -40 src/a.test.ts', 'grep -n vitest package.json']) assert.equal(testSegment(c), null, c);
  const hd = testSegment(`cd "/p" && python - <<'EOF'\nopen('x').write('npx vitest run nope')\nEOF\nnpx vitest run packages/video 2>&1 | tail -4`);
  assert.deepEqual(hd, { runner: 'vitest', seg: 'npx vitest run packages/video', last: false });
  assert.deepEqual(testSegment("cat > x.test.ts <<'EOF' && timeout 300 npx vitest run x\nit('a')\nEOF"), { runner: 'vitest', seg: 'npx vitest run x', last: true }, 'the rest of the heredoc line is still a command');
  assert.equal(testSegment('CI=1 pnpm exec jest --ci').runner, 'jest');
  assert.equal(testSegment('python -m pytest -q').runner, 'pytest');
  assert.equal(testInfo('npx vitest run 2>&1 | grep FAIL', '', false).red, null, 'grep found nothing: unknown, not red');
  assert.equal(testInfo('npx vitest run 2>&1 | grep FAIL', ' FAIL  src/a.test.ts > adds', true).red, true);
  assert.equal(testInfo('npx vitest run 2>&1 | tail -3', 'Tests  9 passed (9)', false).red, false, 'counts win over the exit code');
  assert.equal(testInfo('npx vitest run', '', false).red, true, 'the runner alone: its exit code counts');
});
