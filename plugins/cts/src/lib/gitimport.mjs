// `cts import git`: merges, reverts and tags from history become events, so the Story has a prologue.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ulid, serialize, ensureProject, SCHEMA } from './util.mjs';

const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
const rnd = (key) => crypto.createHash('sha1').update(key).digest().subarray(0, 10);

/** Reads history from `repo` (default: the project itself, read-only either way) and writes events into `root`'s log. */
export function importGit(root, { repo = root } = {}) {
  const p = ensureProject(root);
  let def = 'main';
  try { def = git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim().replace(/^origin\//, ''); } catch { try { def = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() || 'main'; } catch { /* keep main */ } }
  const events = [];
  const mk = (sha, iso, op, subject, extra = {}) => {
    const t = Date.parse(iso);
    const cmd = op === 'tag' ? `git tag ${extra.tag}` : op === 'merge' ? `git merge ${subject}` : `git ${op} ${sha.slice(0, 8)}`;
    events.push({ v: SCHEMA, id: ulid(t, rnd(op + sha)), sid: 'git-import', ts: new Date(t).toISOString(), hook: 'import:git', kind: 'tool.post', actor: 'human', prompt_id: null, cwd: root,
      d: { tool: 'Bash', tool_use_id: 'git-' + sha.slice(0, 12), ok: true, input: { command: cmd }, out: '', imported: true, git: { op, args: subject, branch: def, subject, sha, ...extra } } });
  };
  const log = git(repo, ['log', '--first-parent', def, '--format=%H%x09%aI%x09%P%x09%s']).split('\n').filter(Boolean);
  for (const line of log) {
    const [sha, iso, parents, ...rest] = line.split('\t');
    const subject = rest.join('\t');
    if (/^Revert "/.test(subject)) mk(sha, iso, 'revert', subject);
    else if (parents.trim().split(' ').length > 1) mk(sha, iso, 'merge', subject);
  }
  try {
    for (const line of git(repo, ['for-each-ref', 'refs/tags', '--format=%(refname:short)%09%(creatordate:iso-strict)%09%(objectname)']).split('\n').filter(Boolean)) {
      const [tag, iso, sha] = line.split('\t');
      mk(sha, iso, 'tag', tag, { tag });
    }
  } catch { /* no tags */ }
  events.sort((a, b) => (a.id < b.id ? -1 : 1));
  fs.writeFileSync(path.join(p.sessions, 'git-import.jsonl'), events.map(serialize).join(''));
  return { events: events.length, branch: def };
}
