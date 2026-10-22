// Retention: drop the raw events (prompts, tool calls, outputs) of sessions that ended more than `retentionDays` ago,
// keep moments, threads, arcs, drafts and evidence forever. The derived state goes into .cts/retention.json, which
// the engine restores before replaying the log, so `cts reindex` still reproduces the same dashboard.
// A trim is rehearsed on a copy first and refused if the copy does not reproduce the current state exactly.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLine, readJson } from './util.mjs';

const DAY = 86400000;
/** Everything that is not raw capture: boundaries, decisions, drafts, extraction, receipts. These are never trimmed. */
const KEEP_KINDS = new Set(['session.start', 'session.end', 'mark', 'confirm', 'dismiss', 'rescore', 'merge', 'thread.close', 'pause', 'resume', 'post.receipt']);
const keepKind = (k) => KEEP_KINDS.has(k) || /^(draft|publish|voice|extract)\./.test(k);

export const snapshotFile = (root) => path.join(root, '.cts', 'retention.json');
export const loadSnapshot = (root) => readJson(snapshotFile(root));

/** Every event id that something derived points at: those stay so evidence and the honesty guard keep working. */
function citedIds(pr) {
  const keep = new Set();
  const add = (x) => { if (x) keep.add(x); };
  for (const m of pr.engine.moments.values()) {
    add(m.span.first); add(m.span.last); (m.span.ids || []).forEach(add); (m.tp || []).forEach((r) => add(r.id));
    if (m.evidence && Array.isArray(m.evidence.ring)) m.evidence.ring.forEach(add);
  }
  for (const th of pr.engine.threads.values()) { add(th.id); if (th.closed) add(th.closed.event); }
  for (const d of pr.engine.drafts.drafts.values()) {
    const c = d.claims || {};
    for (const r of c.refs || []) add(typeof r === 'string' ? r : r && (r.id || r.event));
  }
  return keep;
}

/** What a trim would remove. Pure: reads the project, writes nothing. */
export function planTrim(pr, { days = pr.cfg.retentionDays, now = Date.now() } = {}) {
  if (!(days > 0)) return { days, sids: [], drop: 0, files: [], note: 'retentionDays is 0: retention is off' };
  const cutoff = now - days * DAY;
  const sids = pr.engine.sessionList().filter((s) => !s.demo && s.end != null && s.end < cutoff).map((s) => s.sid);
  const trimmed = new Set(sids);
  const keep = citedIds(pr);
  const files = [];
  let drop = 0, bytes = 0;
  for (const f of pr.sessionFiles()) {
    const file = path.join(pr.p.sessions, f);
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    const tail = lines.pop(); // '' when the file ends with a newline; a partial line otherwise (kept as is)
    let n = 0, b = 0;
    const out = [];
    for (const line of lines) {
      const ev = line.trim() ? parseLine(line) : null;
      // Unparseable lines are kept: a trim never destroys what it cannot read.
      if (ev && trimmed.has(ev.sid) && !keepKind(ev.kind) && !keep.has(ev.id) && Date.parse(ev.ts) < cutoff) { n++; b += line.length + 1; continue; }
      out.push(line);
    }
    if (n) { files.push({ f, file, drop: n, bytes: b, text: out.join('\n') + '\n' + tail }); drop += n; bytes += b; }
  }
  return { days, cutoff, sids, drop, bytes, files };
}

const fingerprint = (pr) => {
  const e = pr.engine;
  return JSON.stringify({
    moments: e.listMoments().map((m) => [m.id, m.kind, m.status, m.score, m.headline, m.t0, m.t1, [...m.actors].sort(), m.thread, m.tier]),
    threads: [...e.threads.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map((t) => [t.id, t.text, t.closed && t.closed.event, t.closed && t.closed.how, t.moment]),
    arcs: e.arcs().map((a) => [a.id, a.shape, a.status, a.moments]),
    sessions: e.sessionList().map((s) => [s.sid, s.start, s.end, s.parent, s.stats.moments, s.ended]),
    drafts: e.drafts.list().map((d) => [d.id, d.status]),
    threadsOpen: e.openThreads().length,
  });
};

/**
 * Rehearse on a copy, then apply. `Project` is passed in to avoid an import cycle.
 * Returns { applied, plan, problem? }. With dryRun nothing is written anywhere in the project.
 */
export function trim(pr, Project, { days, now = Date.now(), dryRun = false } = {}) {
  const plan = planTrim(pr, { days, now });
  if (!plan.drop) return { applied: false, plan };
  const snap = pr.engine.snapshot(plan.sids, now);

  // Rehearsal: the trimmed log plus the snapshot, in a temp copy, must reproduce today's state exactly.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-trim-'));
  try {
    fs.mkdirSync(path.join(tmp, '.git'));
    fs.mkdirSync(path.join(tmp, '.cts', 'sessions'), { recursive: true });
    for (const f of pr.sessionFiles()) fs.copyFileSync(path.join(pr.p.sessions, f), path.join(tmp, '.cts', 'sessions', f));
    for (const x of plan.files) fs.writeFileSync(path.join(tmp, '.cts', 'sessions', x.f), x.text);
    fs.copyFileSync(pr.p.config, path.join(tmp, '.cts', 'cts.json'));
    fs.writeFileSync(snapshotFile(tmp), JSON.stringify(snap));
    const copy = Project.open(tmp);
    // The rehearsal must not run autopilot side effects; compare state only.
    const same = fingerprint(copy) === fingerprint(pr);
    copy.close();
    if (!same) return { applied: false, plan, problem: 'the rehearsal on a copy did not reproduce the current moments, threads and arcs exactly; nothing was changed' };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  if (dryRun) return { applied: false, plan, rehearsed: true };

  // Apply: snapshot first (atomic), then each file (atomic, original mtime kept so "latest session" logic is unchanged).
  const sf = snapshotFile(pr.root);
  fs.writeFileSync(sf + '.tmp', JSON.stringify(snap)); fs.renameSync(sf + '.tmp', sf);
  for (const x of plan.files) {
    const st = fs.statSync(x.file);
    fs.writeFileSync(x.file + '.tmp', x.text); fs.renameSync(x.file + '.tmp', x.file);
    fs.utimesSync(x.file, st.atime, st.mtime);
  }
  pr.reindex();
  return { applied: true, plan };
}
