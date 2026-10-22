// The project registry: ~/.cts/projects.json lists every project CTS has seen, so the dashboard can switch between them
// and show activity across all of them. The hook registers a project at session start (at most once an hour).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ctsHome } from './consent.mjs';
import { readJson, pidAlive } from './util.mjs';

const HOUR = 3600e3;
export const registryFile = () => path.join(ctsHome(), 'projects.json');

export function listProjects() {
  const r = readJson(registryFile(), {}) || {};
  return (Array.isArray(r.projects) ? r.projects : []).filter((p) => p && typeof p.root === 'string');
}

/** Add or refresh a project. Temp directories are skipped (they vanish) unless CTS_HOME points somewhere explicit. */
export function register(root, now = Date.now()) {
  const abs = path.resolve(root);
  if (!process.env.CTS_HOME && abs.startsWith(path.resolve(os.tmpdir()))) return false;
  const list = listProjects();
  const cur = list.find((p) => path.resolve(p.root) === abs);
  if (cur && now - (cur.lastSeen || 0) < HOUR) return false;
  const next = cur ? list.map((p) => (p === cur ? { ...p, lastSeen: now } : p)) : [...list, { root: abs, name: path.basename(abs), added: now, lastSeen: now }];
  fs.mkdirSync(ctsHome(), { recursive: true });
  const f = registryFile(), tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ projects: next }, null, 1)); fs.renameSync(tmp, f);
  return true;
}

/**
 * What the dashboard shows per project, read without opening its log: the context note, the server file, and the
 * per-day event counts from its index (read-only). `Db` is node:sqlite's DatabaseSync, passed in to keep the hook light.
 */
export function projectSummaries(Db, { current = null, days = 30 } = {}) {
  const since = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
  return listProjects().map((p) => {
    const cts = path.join(p.root, '.cts');
    if (!fs.existsSync(cts)) return { ...p, missing: true };
    const ctx = readJson(path.join(cts, 'context.json')) || {};
    const srv = readJson(path.join(cts, 'server.json'));
    let activity = [], sessions = null;
    try {
      const db = new Db(path.join(cts, 'index.sqlite'), { readOnly: true });
      try {
        activity = db.prepare('SELECT substr(ts,1,10) AS day, COUNT(*) AS n FROM events WHERE substr(ts,1,10) >= ? GROUP BY day ORDER BY day').all(since);
        sessions = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
      } finally { db.close(); }
    } catch { /* not indexed yet */ }
    return {
      root: p.root, name: p.name, lastSeen: p.lastSeen, current: current != null && path.resolve(current) === path.resolve(p.root),
      port: srv && pidAlive(srv.pid) ? srv.port : null, openThreads: (ctx.threads || []).length, last: ctx.last || null, pendingDrafts: ctx.pending_drafts || 0,
      sessions, activity,
    };
  }).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}
