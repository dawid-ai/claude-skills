// Classification of Bash commands: tests, git operations, deploys, dependency changes.
/**
 * The command as the shell would execute it: heredoc bodies and quoted strings removed, `bash -c '...'` unwrapped.
 * Classifiers run on this so `echo "git revert"` or a heredoc that writes a test file never counts as an action.
 */
export function skeleton(cmd) {
  let c = String(cmd || '');
  const wrap = /\b(?:bash|sh|zsh)\s+-l?c\s+(["'])([\s\S]*)\1\s*$/.exec(c);
  if (wrap) c = wrap[2];
  // The body goes; the rest of the opening line (`<<'EOF' && npx vitest`) and the newline after the delimiter stay.
  c = c.replace(/<<-?\s*(["']?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2(?=\n|$)/g, ' $3');
  c = c.replace(/<<-?\s*(["']?)(\w+)\1([^\n]*)\n[\s\S]*$/, ' $3');
  c = c.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'[^']*'/g, "''");
  return c;
}

// Anchored at the start of a shell segment: `ls vitest.config.*` or `cat jest.setup.js` is not a test run.
const TEST_RUNNERS = [
  ['pytest', /^(?:pytest|py\.test)\b/],
  ['vitest', /^vitest(?![.\w-])/],
  ['jest', /^jest(?![.\w-])/],
  ['go', /^go\s+test\b/],
  ['cargo', /^cargo\s+(?:test|nextest)\b/],
  ['rspec', /^rspec\b/],
  ['dotnet', /^dotnet\s+test\b/],
  ['node', /^node\s+(?:--[\w-]+(?:=\S+)?\s+)*--test\b/],
  ['npm-test', /^(?:npm|pnpm|yarn|bun)\s+(?:(?:-w|--workspace)\s+\S+\s+)?(?:run\s+)?test\b/],
  ['make-test', /^make\s+(?:test|check)\b/],
  ['tox', /^tox\b/],
];
const SEG_PREFIX = /^(?:(?:export\s+)?[A-Za-z_]\w*=\S*\s+|(?:time|nice|sudo)\s+|timeout\s+\S+\s+|env\s+)+/;
const RUNNER_PREFIX = /^(?:npx|bunx|pnpx|(?:pnpm|yarn)\s+(?:exec|dlx)|bundle\s+exec|python3?\s+-m|uv\s+run|poetry\s+run)\s+/;
/**
 * The test run inside a command: `{runner, seg, last}`, or null. `seg` is the runner's segment with env, `timeout` and
 * redirections stripped (`npx vitest run packages/cli`); `last` says whether the command's exit code is the runner's.
 */
export function testSegment(cmd) {
  if (!cmd) return null;
  const parts = skeleton(cmd).split(/\s*(&&|\|\||;|\n|\|)\s*/);
  for (let i = 0; i < parts.length; i += 2) {
    const seg = parts[i].trim().replace(SEG_PREFIX, '');
    const bare = seg.replace(RUNNER_PREFIX, '');
    for (const [runner, re] of TEST_RUNNERS) {
      if (re.test(seg) || re.test(bare)) return { runner, seg: seg.replace(/\s*\d?>>?\s*(?:&\d|\S+)/g, '').trim(), last: i === parts.length - 1 };
    }
  }
  return null;
}
export function testRunner(cmd) { const t = testSegment(cmd); return t ? t.runner : null; }
const FAIL_MARK = /^\s*(?:FAIL|FAILED|×|✗|✕)\s|^\s*Tests?:?\s+\d+ failed|AssertionError: expected|^--- FAIL/m;
/**
 * Red, green, or null when nothing tells: counts win, then a runner's failure line, then the exit code, but only when
 * it is the runner's own (not `| tail`, `| grep`, or a later `&& tsc`).
 */
export function testVerdict(ts, counts, out, ok) {
  if (counts && counts.total) return counts.fail > 0;
  if (FAIL_MARK.test(out || '')) return true;
  return ts.last ? !ok : null;
}
/** The `d.test` record for a Bash command and its output, or null when it runs no tests. */
export function testInfo(cmd, out, ok) {
  const ts = testSegment(cmd);
  if (!ts) return null;
  const c = parseCounts(out);
  return { ...ts, ...(c || {}), red: testVerdict(ts, c, out, ok) };
}

/** Pull pass/fail counts out of runner output. Returns {pass,fail,total} or null. */
export function parseCounts(text) {
  if (!text) return null;
  const num = (m, i) => (m && m[i] != null ? Number(m[i]) : 0);
  let m;
  // cargo
  if ((m = /test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed/.exec(text))) return mk(num(m, 1), num(m, 2));
  // node --test
  const np = /^# pass (\d+)/m.exec(text), nf = /^# fail (\d+)/m.exec(text);
  if (np && nf) return mk(num(np, 1), num(nf, 1));
  // rspec
  if ((m = /(\d+) examples?, (\d+) failures?/.exec(text))) return mk(num(m, 1) - num(m, 2), num(m, 2));
  // dotnet
  if ((m = /Failed:\s+(\d+),\s+Passed:\s+(\d+)/.exec(text))) return mk(num(m, 2), num(m, 1));
  if ((m = /Passed!.*?Passed:\s+(\d+)/.exec(text))) return mk(num(m, 1), 0);
  // jest
  if ((m = /Tests:\s+(?:(\d+) failed, )?(?:\d+ skipped, )?(?:(\d+) passed)/.exec(text))) return mk(num(m, 2), num(m, 1));
  // vitest
  if ((m = /Tests\s+(?:(\d+) failed \| )?(\d+) passed/.exec(text))) return mk(num(m, 2), num(m, 1));
  // pytest
  const pp = /(\d+) passed/.exec(text), pf = /(\d+) failed/.exec(text);
  if (pp || pf) return mk(num(pp, 1), num(pf, 1));
  // go
  if (/^--- FAIL|^FAIL\b/m.test(text)) return mk((text.match(/^ok\s/gm) || []).length, (text.match(/^--- FAIL/gm) || []).length || 1);
  if (/^ok\s/m.test(text)) return mk((text.match(/^ok\s/gm) || []).length, 0);
  return null;
  function mk(pass, fail) { return { pass, fail, total: pass + fail }; }
}

const GIT_RE = /(?:^|[;&|(]\s*|\s)git(?:\s+-C\s+\S+|\s+-c\s+\S+)*\s+(commit|revert|reset|checkout|switch|merge|stash|tag|rebase|push|worktree|cherry-pick|rm)\b([^;&|\n]*)/;
/** The name `git tag <args>` creates, or null when the command lists, deletes or verifies tags. */
export function tagName(args) {
  const a = String(args || '').trim().split(/\s+/).filter(Boolean);
  if (!a.length || a.some((x) => /^(-l|--list|-d|--delete|-v|--verify|-n\d*|--contains|--points-at|--merged|--no-merged|--sort.*|--format.*)$/.test(x))) return null;
  for (let i = 0; i < a.length; i++) {
    if (/^-(m|F|u|-message|-file|-local-user)$/.test(a[i])) { i++; continue; }
    if (a[i].startsWith('-')) continue;
    return a[i].replace(/^["']|["']$/g, '') || null;
  }
  return null;
}
export function gitOp(cmd) {
  if (!cmd) return null;
  const sk = skeleton(cmd);
  if (/\bgh\s+pr\s+merge\b/.test(sk)) return { op: 'pr-merge', args: '' };
  const m = GIT_RE.exec(sk);
  if (!m) return null;
  const args = m[2].trim();
  if (/(^|\s)(--help|-h)(\s|$)/.test(args)) return null;
  return { op: m[1], args };
}

// A deploy is a command segment that STARTS with a deploy tool. A command that merely mentions "deploy" (grep deploy,
// cat deploy.txt, LAST_DEPLOY=...) is not one: on a real project that alone made most "shipped" moments false.
export const DEPLOY_RE = /^(?:sudo\s+)?(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?deploy(?::[\w-]+)?\b|(?:npm|pnpm|yarn)\s+publish\b|make\s+deploy\b|(?:(?:bash|sh)\s+)?\.?\/?[\w./-]*deploy[\w-]*\.sh\b|railway\s+up\b|vercel\s+(?:deploy\s+)?(?:\S+\s+)*--prod\b|netlify\s+deploy\s+(?:\S+\s+)*--prod\b|fly(?:ctl)?\s+deploy\b|firebase\s+deploy\b|wrangler\s+(?:deploy|publish)\b|(?:serverless|sls)\s+deploy\b|gcloud\s+(?:[\w-]+\s+)*deploy\b|git\s+push\s+heroku\b|kubectl\s+apply\b|helm\s+(?:upgrade|install)\b|terraform\s+apply\b|cargo\s+publish\b|twine\s+upload\b|docker\s+push\b)/;
/** The deploy segment of a (skeleton) command, or null. Env assignments and `cd` before it are skipped. */
export function deploySegment(cmd) {
  for (let seg of String(cmd || '').split(/\s*(?:&&|\|\||;|\n|\|)\s*/)) {
    seg = seg.trim().replace(/^(?:(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');
    if (DEPLOY_RE.test(seg)) return seg;
  }
  return null;
}
export const DEP_REMOVE_RE = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:uninstall|remove|rm)|pip3?\s+uninstall|cargo\s+remove|poetry\s+remove|go\s+mod\s+edit\s+-droprequire)\b\s*(.*)/;
export const DEP_ADD_RE = /\b(?:(?:npm|pnpm|bun)\s+(?:install|add|i)|yarn\s+add|pip3?\s+install|cargo\s+add|poetry\s+add|go\s+get)\b\s*(.*)/;
export const RM_RE = /\b(?:git\s+rm|rm)\s+(?:-[a-zA-Z]+\s+)*([^;&|\n]+)/;

export const HEDGE_RE = /\b(for now|temporar(?:y|ily)|TODO|revisit|good enough|quick hack|placeholder|come back to|not sure yet|punt(?:ing)?|for the time being)\b/i;
export const DECISIVE_RE = /\b(decid(?:ed|e)|let'?s (?:go|use|keep|do)|go(?:ing)? with|final(?:ly)?|settled|resolved|permanent(?:ly)?|make it (?:real|permanent|proper)|not temporary|keep it)\b/i;

/** Sentence containing the hedge (<=200 chars), or null. Hedge words that are quoted or in code spans are discussion, not decisions. */
export function hedgeSentence(text) {
  const t = String(text || '');
  const re = new RegExp(HEDGE_RE.source, 'gi');
  let m;
  while ((m = re.exec(t))) {
    const before = t[m.index - 1], after = t[m.index + m[0].length];
    if (/["'`“‘]/.test(before || '') && /["'`”’]/.test(after || '')) continue;
    const sents = [];
    let pos = 0;
    for (const part of t.split(/(?<=[.!?])\s+|\n+/)) { const i = t.indexOf(part, pos); sents.push({ i, part }); pos = i + part.length; }
    const hit = sents.find((x) => m.index >= x.i && m.index < x.i + x.part.length);
    const sentence = (hit ? hit.part : t.slice(Math.max(0, m.index - 60), m.index + 100)).replace(/^[\s>*#-]+|\*\*/g, '').trim();
    if (sentence.length >= 15) return sentence.slice(0, 200);
  }
  return null;
}

const STOP = new Set(['the', 'this', 'that', 'with', 'for', 'now', 'and', 'will', 'use', 'using', 'used', 'temporary', 'temporarily', 'revisit', 'later', 'good', 'enough', 'todo', 'placeholder', 'quick', 'hack', 'come', 'back', 'sure', 'yet', 'time', 'being', 'have', 'from', 'into', 'just', 'here', 'there', 'then', 'than', 'also', 'need', 'needs', 'some', 'code', 'should', 'would', 'could']);
/** Topic tokens: file-like names and meaningful identifiers (>=4 chars). */
export function topicsOf(text) {
  const out = new Set();
  const t = String(text || '');
  for (const m of t.matchAll(/[\w./\\-]+\.[A-Za-z]{1,5}\b/g)) out.add(m[0].split(/[\\/]/).pop().toLowerCase());
  for (const m of t.matchAll(/\b[A-Za-z][A-Za-z0-9_]{3,}\b/g)) {
    const w = m[0].toLowerCase();
    if (!STOP.has(w)) out.add(w);
  }
  return [...out].slice(0, 12);
}
