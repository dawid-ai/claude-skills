// node:sqlite behind a tiny seam. Needs Node >= 22.5. Capture (the hook) never loads this.
const orig = process.emitWarning;
process.emitWarning = function (w, ...a) { if (a[0] === 'ExperimentalWarning' || /SQLite/i.test(String(w))) return; return orig.call(process, w, ...a); };
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = orig;
export { DatabaseSync };

export const DDL = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS files(name TEXT PRIMARY KEY, off INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events(
  id TEXT PRIMARY KEY, sid TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL, t INTEGER NOT NULL, kind TEXT NOT NULL,
  actor TEXT NOT NULL, agent_type TEXT, prompt_id TEXT, file TEXT, byte INTEGER, tp_path TEXT, tp_off INTEGER, text TEXT, j TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ev_t ON events(t);
CREATE INDEX IF NOT EXISTS ev_sid ON events(sid, seq);
CREATE INDEX IF NOT EXISTS ev_kind ON events(kind);
CREATE TABLE IF NOT EXISTS moments(id TEXT PRIMARY KEY, sid TEXT, kind TEXT, score INTEGER, t0 INTEGER, t1 INTEGER, status TEXT, j TEXT);
CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, sid TEXT, closed INTEGER, opened_t INTEGER, j TEXT);
CREATE TABLE IF NOT EXISTS arcs(id TEXT PRIMARY KEY, t0 INTEGER, j TEXT);
CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY, start INTEGER, j TEXT);
`;
