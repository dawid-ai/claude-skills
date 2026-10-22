// A project = .cts/ on disk + the engine + the SQLite index. Everything (server, CLI, MCP) goes through this.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, DDL } from './db.mjs';
import { Engine } from './engine.mjs';
import { readEvents } from './log.mjs';
import { paths, ensureProject, loadConfig, SCHEMA, trunc } from './util.mjs';
import { scrubSecrets } from './secrets.mjs';
import { loadSnapshot } from './retention.mjs';

const searchText = (ev) => {
  const d = ev.d || {}, i = d.input || {};
  return [d.text, i.command, i.file_path, i.pattern, i.description, d.git && d.git.subject, d.last, d.note, d.out && String(d.out).slice(-300)].filter(Boolean).join(' \n').slice(0, 4000);
};

export class Project {
  constructor(root) {
    this.root = root;
    this.p = ensureProject(root);
    this.cfg = loadConfig(root);
    this.db = null;
    this.engine = null;
    this.offsets = new Map();
    this.dbOffsets = new Map();
    this.seq = new Map();
    this.bad = 0;
    this.dirty = false;
  }

  static open(root) { const pr = new Project(root); pr.init(); return pr; }

  init() {
    this.db = new DatabaseSync(this.p.db);
    this.db.exec(DDL);
    const v = this.db.prepare("SELECT v FROM meta WHERE k='schema'").get();
    if (v && Number(v.v) !== SCHEMA) { this.db.close(); fs.rmSync(this.p.db, { force: true }); this.db = new DatabaseSync(this.p.db); this.db.exec(DDL); }
    this.db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('schema',?)").run(String(SCHEMA));
    for (const r of this.db.prepare('SELECT name, off FROM files').all()) this.dbOffsets.set(r.name, r.off);
    this.engine = new Engine(this.cfg);
    const snap = loadSnapshot(this.root);
    if (snap) this.engine.restore(snap);
    this.ins = this.db.prepare('INSERT OR IGNORE INTO events(id,sid,seq,ts,t,kind,actor,agent_type,prompt_id,file,byte,tp_path,tp_off,text,j) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    this.sync({ initial: true });
    return this;
  }

  close() { try { this.db.close(); } catch { /* already closed */ } }

  /** Delete the index and rebuild everything from the JSONL logs. */
  reindex() {
    this.close();
    try { for (const s of ['', '-wal', '-shm']) fs.rmSync(this.p.db + s, { force: true }); } catch {
      // Windows refuses to delete a file another process (the server, the MCP server) has open: empty it in place.
      const db = new DatabaseSync(this.p.db);
      for (const t of ['events', 'moments', 'threads', 'arcs', 'sessions', 'files', 'meta']) db.exec(`DROP TABLE IF EXISTS ${t}`);
      db.close();
    }
    this.offsets.clear(); this.dbOffsets.clear(); this.seq.clear();
    this.init();
    return this;
  }

  sessionFiles() {
    try { return fs.readdirSync(this.p.sessions).filter((f) => f.endsWith('.jsonl')).sort(); } catch { return []; }
  }

  /** Pull any new lines from every session file (k-way merge by event id, bounded memory); returns {events, ch} for what is new. */
  sync({ initial = false } = {}) {
    // A file that shrank or vanished (a retention trim, a demo clear, a git checkout) invalidates the offsets: rebuild.
    if (!initial) {
      const files = new Set(this.sessionFiles());
      for (const [f, off] of this.offsets) {
        let size = -1; try { size = fs.statSync(path.join(this.p.sessions, f)).size; } catch { /* gone */ }
        if (!files.has(f) || size < off) {
          this.reindex();
          const e = this.engine;
          return { events: [], reset: true, ch: { moments: new Set(e.moments.keys()), threads: new Set(e.threads.keys()), sessions: new Set(e.sessions.keys()), drafts: new Set(e.drafts.drafts.keys()) } };
        }
      }
    }
    const heads = [];
    for (const f of this.sessionFiles()) {
      const from = this.offsets.get(f) || 0;
      try { if (fs.statSync(path.join(this.p.sessions, f)).size <= from) continue; } catch { continue; }
      const it = readEvents(path.join(this.p.sessions, f), from);
      heads.push({ f, it, cur: null });
    }
    if (!heads.length) return { events: [], ch: { moments: new Set(), threads: new Set(), sessions: new Set() } };
    const advance = (h) => {
      for (;;) {
        const n = h.it.next();
        if (n.done) { h.cur = null; return; }
        const r = n.value;
        this.offsets.set(h.f, r.end);
        if (!r.ev) { if (!r.blank) this.bad++; continue; }
        r.ev._off = r.off; r.ev._file = h.f; r.ev._seq = (this.seq.get(h.f) || 0) + 1; this.seq.set(h.f, r.ev._seq);
        h.cur = r.ev; return;
      }
    };
    for (const h of heads) advance(h);
    const ch = { moments: new Set(), threads: new Set(), sessions: new Set(), drafts: new Set() };
    const fresh = [];
    let count = 0;
    this.db.exec('BEGIN');
    try {
      for (;;) {
        let best = null;
        for (const h of heads) if (h.cur && (!best || h.cur.id < best.cur.id)) best = h;
        if (!best) break;
        const ev = best.cur;
        advance(best);
        const c = this.engine.push(ev);
        for (const k of Object.keys(ch)) for (const x of c[k]) ch[k].add(x);
        count++;
        const dbOff = this.dbOffsets.get(ev._file) || 0;
        if (ev._off >= dbOff) {
          this.ins.run(ev.id, ev.sid, ev._seq, ev.ts, ev._t, ev.kind, ev.actor, ev.agent_type || null, ev.prompt_id || null, ev._file, ev._off, ev.tp ? ev.tp.path : null, ev.tp ? ev.tp.off : null, searchText(ev), JSON.stringify({ d: ev.d, tp: ev.tp, hook: ev.hook, cwd: ev.cwd }));
          if (!initial) fresh.push(ev);
        }
      }
      for (const [f, off] of this.offsets) { this.db.prepare('INSERT OR REPLACE INTO files(name, off) VALUES(?,?)').run(f, off); this.dbOffsets.set(f, off); }
      this.persistDerived(ch);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.snapshotEvidence(ch.moments);
    this.writeContext();
    return { events: fresh, ch, count };
  }

  persistDerived(ch) {
    const e = this.engine;
    const db = this.db;
    if (ch.moments.size) {
      const st = db.prepare('INSERT OR REPLACE INTO moments(id,sid,kind,score,t0,t1,status,j) VALUES(?,?,?,?,?,?,?,?)');
      for (const id of ch.moments) { const m = e.moments.get(id); if (m) { const v = e.view(m); st.run(v.id, v.sid, v.kind, v.score, v.t0, v.t1, v.status, JSON.stringify(v)); } }
    }
    if (ch.threads.size) {
      const st = db.prepare('INSERT OR REPLACE INTO threads(id,sid,closed,opened_t,j) VALUES(?,?,?,?,?)');
      for (const id of ch.threads) { const t = e.threads.get(id); if (t) st.run(t.id, t.sid, t.closed ? 1 : 0, t.opened_t, JSON.stringify(t)); }
    }
    if (ch.sessions.size) {
      const st = db.prepare('INSERT OR REPLACE INTO sessions(sid,start,j) VALUES(?,?,?)');
      for (const l of e.sessionList()) if (ch.sessions.has(l.sid)) st.run(l.sid, l.start, JSON.stringify(l));
    }
    if (ch.moments.size) {
      db.exec('DELETE FROM arcs');
      const st = db.prepare('INSERT INTO arcs(id,t0,j) VALUES(?,?,?)');
      for (const a of e.arcs()) st.run(a.id, a.t0, JSON.stringify(a));
    }
  }

  writeContext() {
    try { fs.writeFileSync(this.p.context, JSON.stringify(this.engine.context())); } catch { /* best effort */ }
  }

  /** Copy the transcript spans a moment cites into .cts/evidence/ so they outlive transcript cleanup. */
  snapshotEvidence(ids) {
    const thr = this.cfg.threshold;
    for (const id of ids) {
      const m = this.engine.moments.get(id);
      if (!m || m.demo || this.engine.score(m) < thr || !m.tp.length) continue;
      const out = path.join(this.p.evidence, id + '.json');
      if (fs.existsSync(out)) continue;
      const spans = [];
      for (const ref of [m.tp[0], m.tp[m.tp.length - 1]].filter((x, i, a) => a.indexOf(x) === i)) {
        try {
          const size = fs.statSync(ref.path).size;
          const from = Math.max(0, ref.off - 6000), to = Math.min(size, ref.off + 1500);
          const buf = Buffer.alloc(to - from);
          const fd = fs.openSync(ref.path, 'r'); fs.readSync(fd, buf, 0, buf.length, from); fs.closeSync(fd);
          spans.push({ event: ref.id, path: ref.path, from, to, text: scrubSecrets(buf.toString('utf8')) });
        } catch { /* transcript already gone */ }
      }
      if (!spans.length) continue;
      fs.mkdirSync(this.p.evidence, { recursive: true });
      fs.writeFileSync(out, JSON.stringify({ moment: id, headline: m.headline, spans }));
    }
  }

  // ---------- queries ----------
  rowToEvent(r) {
    const j = JSON.parse(r.j);
    return { id: r.id, sid: r.sid, seq: r.seq, ts: r.ts, t: r.t, kind: r.kind, actor: r.actor, agent_type: r.agent_type, prompt_id: r.prompt_id, d: j.d, tp: j.tp, hook: j.hook };
  }
  events({ sid, actors, kinds, q, from, to, before, after, limit = 500, order = 'desc' } = {}) {
    const w = [], a = [];
    if (sid) { w.push('sid=?'); a.push(sid); }
    if (actors && actors.length) { w.push(`actor IN (${actors.map(() => '?').join(',')})`); a.push(...actors); }
    if (kinds && kinds.length) { w.push(`kind IN (${kinds.map(() => '?').join(',')})`); a.push(...kinds); }
    if (q) { w.push('text LIKE ?'); a.push('%' + q.replace(/[%_]/g, '') + '%'); }
    if (from) { w.push('t>=?'); a.push(from); }
    if (to) { w.push('t<=?'); a.push(to); }
    if (before) { w.push('id<?'); a.push(before); }
    if (after) { w.push('id>?'); a.push(after); }
    const sql = `SELECT * FROM events ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id ${order === 'asc' ? 'ASC' : 'DESC'} LIMIT ${Math.min(5000, +limit || 500)}`;
    const rows = this.db.prepare(sql).all(...a).map((r) => this.rowToEvent(r));
    return order === 'asc' ? rows : rows.reverse();
  }
  eventById(id) { const r = this.db.prepare('SELECT * FROM events WHERE id=?').get(id); return r ? this.rowToEvent(r) : null; }
  eventCount() { return this.db.prepare('SELECT COUNT(*) AS n FROM events').get().n; }
  search(q, limit = 30) {
    const like = '%' + String(q).replace(/[%_]/g, '') + '%';
    const events = this.db.prepare('SELECT * FROM events WHERE text LIKE ? ORDER BY id DESC LIMIT ?').all(like, limit).map((r) => this.rowToEvent(r));
    const moments = this.engine.listMoments().filter((m) => (m.headline + ' ' + m.body.join(' ')).toLowerCase().includes(String(q).toLowerCase()));
    return { events, moments };
  }
  /** Transcript window around a recorded offset. Only paths the log itself recorded are readable. */
  transcript(tpPath, off, win = 6000) {
    const ok = this.db.prepare('SELECT 1 AS x FROM events WHERE tp_path=? LIMIT 1').get(tpPath);
    if (!ok) return null;
    const size = fs.statSync(tpPath).size;
    let from = Math.max(0, off - win), to = Math.min(size, off + Math.floor(win / 3));
    const buf = Buffer.alloc(to - from);
    const fd = fs.openSync(tpPath, 'r'); fs.readSync(fd, buf, 0, buf.length, from); fs.closeSync(fd);
    let text = buf.toString('utf8');
    let skipped = 0;
    if (from > 0) { const nl = text.indexOf('\n'); if (nl >= 0) { skipped = Buffer.byteLength(text.slice(0, nl + 1)); text = text.slice(nl + 1); from += skipped; } }
    const lines = []; let pos = from;
    for (const l of text.split('\n')) { if (l) lines.push({ off: pos, text: scrubSecrets(l).slice(0, 6000), hit: pos < off && pos + Buffer.byteLength(l) + 1 >= off }); pos += Buffer.byteLength(l) + 1; }
    return { path: tpPath, off, size, lines };
  }

  summary() {
    const e = this.engine;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const ms = e.listMoments({ min: this.cfg.threshold });
    const todays = ms.filter((m) => m.t1 >= today.getTime());
    const last = ms[ms.length - 1];
    return {
      events: e.eventCount, moments: ms.length, momentsToday: todays.length, openThreads: e.openThreads().length, sessions: e.sessions.size,
      last: last ? { id: last.id, headline: last.headline, kind: last.kind, score: last.score } : null, bad: this.bad, root: this.root,
      private: !!this.cfg.private, paused: fs.existsSync(this.p.paused),
    };
  }
}

export { trunc };
