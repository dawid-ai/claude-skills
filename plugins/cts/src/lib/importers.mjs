// Imports: everything funnels through mergeEvents, which merges by event id (union) so re-importing is always safe.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ulid, serialize, parseLine, paths, ensureProject, pidAlive, readJson, SCHEMA } from './util.mjs';
import { readEvents } from './log.mjs';
import { readZip } from './zip.mjs';
import { scrubSecrets } from './secrets.mjs';

const sha = (s) => crypto.createHash('sha1').update(s).digest();
const SAFE_SID = /^[\w.-]{1,120}$/;
const ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** A running server holds offsets into files we are about to rewrite: stop it and drop the index; both rebuild lazily. */
export function invalidateIndex(root) {
  const p = paths(root);
  const s = readJson(p.server);
  if (s && s.pid && s.pid !== process.pid && pidAlive(s.pid)) { try { process.kill(s.pid); } catch { /* gone */ } }
  for (const f of [p.db, p.db + '-wal', p.db + '-shm', p.server]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
}

export function cleanEvent(e) {
  if (!e || typeof e !== 'object') return null;
  const { crc, _t, _off, _file, _seq, ...ev } = e;
  if (!ID_RE.test(ev.id || '') || !SAFE_SID.test(ev.sid || '') || !ev.kind || !ev.ts || Number.isNaN(Date.parse(ev.ts))) return null;
  if (typeof ev.v === 'number' && ev.v > SCHEMA) return null;
  ev.v = ev.v || SCHEMA; ev.actor = ev.actor || 'main'; ev.d = ev.d || {};
  return ev;
}

/** Union-merge events into .cts/sessions/<sid>.jsonl (kept sorted by id). Returns counts. */
export function mergeEvents(root, events, { rejected = 0 } = {}) {
  const p = ensureProject(root);
  fs.mkdirSync(p.sessions, { recursive: true });
  const bySid = new Map();
  let bad = rejected;
  for (const raw of events) { const e = cleanEvent(raw); if (!e) { bad++; continue; } (bySid.get(e.sid) || bySid.set(e.sid, []).get(e.sid)).push(e); }
  let added = 0, skipped = 0; const files = [];
  for (const [sid, list] of bySid) {
    const f = path.join(p.sessions, `${sid}.jsonl`);
    const have = new Map();
    for (const r of readEvents(f)) if (r.ev) have.set(r.ev.id, r.ev);
    let n = 0;
    for (const e of list) { if (have.has(e.id)) skipped++; else { have.set(e.id, e); n++; } }
    if (!n) continue;
    const sorted = [...have.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, sorted.map(serialize).join('')); fs.renameSync(tmp, f);
    added += n; files.push(`${sid}.jsonl`);
  }
  if (added) invalidateIndex(root);
  return { added, skipped, rejected: bad, files };
}

export function importBundle(root, file) {
  const p = ensureProject(root);
  const entries = readZip(fs.readFileSync(file));
  const man = entries.find((e) => e.name === 'manifest.json');
  if (!man) throw new Error('not a CTS bundle (no manifest.json)');
  const m = JSON.parse(man.data.toString('utf8'));
  if (m.format !== 'cts-bundle') throw new Error('not a CTS bundle');
  if (m.schema > SCHEMA) throw new Error(`bundle schema ${m.schema} is newer than this CTS (${SCHEMA}): update CTS first`);
  const events = []; let rejected = 0;
  for (const e of entries.filter((x) => /^sessions\/[^/]+\.jsonl$/.test(x.name))) {
    for (const line of e.data.toString('utf8').split('\n')) { if (!line.trim()) continue; const ev = parseLine(line); if (ev) events.push(ev); else rejected++; }
  }
  const r = mergeEvents(root, events, { rejected });
  let copied = 0;
  for (const e of entries) {
    const mm = /^(voice\.md|cts\.json|retention\.json|digests\/[^/]+|evidence\/[^/]+|drafts\/[^/]+)$/.exec(e.name);
    if (!mm) continue;
    const dest = path.join(p.cts, e.name);
    if (!path.resolve(dest).startsWith(path.resolve(p.cts) + path.sep) || fs.existsSync(dest)) continue;   // never overwrite local files
    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, e.name === 'voice.md' || e.name.endsWith('.md') ? scrubSecrets(e.data.toString('utf8')) : e.data); copied++;
  }
  return { ...r, copied, project: m.project, events: m.events };
}

/** Raw event export (ndjson or a JSON array) back in. */
export function importEvents(root, file) {
  const text = fs.readFileSync(file, 'utf8').trim();
  let list;
  if (text.startsWith('[')) list = JSON.parse(text);
  else list = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
  const rejected = list.filter((x) => !x).length;
  return mergeEvents(root, list.filter(Boolean), { rejected });
}

// ---------- marks from a hand-kept journal ----------
const when = (day, hm) => { const [y, mo, d] = day.split('-').map(Number); const [h, mi] = (hm || '12:00').split(':').map(Number); return new Date(y, mo - 1, d, h, mi || 0, 0).getTime(); };
export function parseMarks(md) {
  const out = []; let day = null;
  for (const raw of String(md).split(/\r?\n/)) {
    const h = /^#{1,6}\s*(\d{4}-\d\d-\d\d)\b/.exec(raw);
    if (h) { day = h[1]; continue; }
    const m = /^\s*[-*]\s+(\?\s+)?(?:(\d{4}-\d\d-\d\d)[ T])?(\d{1,2}:\d\d)?\s*[—:–-]?\s*(.+?)\s*$/.exec(raw);
    if (!m) continue;
    const d = m[2] || day;
    if (!d) continue;
    const note = m[4].replace(/^\?\s*/, '');
    if (!note) continue;
    out.push({ t: when(d, m[3]), note, flag: m[1] || /^\?/.test(m[4]) ? '?' : null });
  }
  return out;
}
export function importMarks(root, file) {
  const marks = parseMarks(fs.readFileSync(file, 'utf8'));
  const events = marks.map((k) => ({ v: SCHEMA, id: ulid(k.t, sha(k.t + '|' + k.note).subarray(0, 10)), sid: 'import-marks', ts: new Date(k.t).toISOString(), hook: 'import:marks', kind: 'mark', actor: 'human', prompt_id: null, cwd: root, d: { note: scrubSecrets(k.note), flag: k.flag, imported: true } }));
  return { parsed: marks.length, ...mergeEvents(root, events) };
}

// ---------- published posts (Vista Social / platform archive: JSON array or CSV) ----------
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const head = (rows.shift() || []).map((h) => h.trim().toLowerCase());
  return rows.filter((r) => r.some(Boolean)).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
export function parsePosts(text) {
  const t = String(text).trim();
  const rows = t.startsWith('[') || t.startsWith('{') ? [].concat(JSON.parse(t)) : parseCsv(t);
  const pick = (r, ...k) => { for (const x of k) for (const key of Object.keys(r)) if (key.toLowerCase() === x && r[key]) return String(r[key]); return ''; };
  return rows.map((r) => ({ ts: pick(r, 'ts', 'published_at', 'date', 'time', 'created_at', 'timestamp'), channel: (pick(r, 'channel', 'network', 'platform', 'profile') || 'unknown').toLowerCase(), url: pick(r, 'url', 'permalink', 'link'), text: pick(r, 'text', 'content', 'message', 'caption', 'post'), moment: pick(r, 'moment') }))
    .filter((r) => r.ts && !Number.isNaN(Date.parse(r.ts)));
}
export function importPosts(root, file) {
  const posts = parsePosts(fs.readFileSync(file, 'utf8'));
  const events = posts.map((x) => { const t = Date.parse(x.ts); return { v: SCHEMA, id: ulid(t, sha(x.channel + '|' + (x.url || x.text)).subarray(0, 10)), sid: 'import-posts', ts: new Date(t).toISOString(), hook: 'import:posts', kind: 'post.receipt', actor: 'human', prompt_id: null, cwd: root, d: { channel: x.channel, url: x.url, text: scrubSecrets(x.text).slice(0, 2000), moment: x.moment || null, imported: true } }; });
  return { parsed: posts.length, ...mergeEvents(root, events) };
}

// ---------- schema migrations ----------
export const MIGRATIONS = {};   // { fromVersion: (event) => event }. v1 is the first schema, so there is nothing to migrate yet.
export function migrate(root) {
  const p = paths(root);
  let files = 0, events = 0, old = 0;
  try {
    for (const f of fs.readdirSync(p.sessions).filter((x) => x.endsWith('.jsonl'))) {
      files++;
      for (const r of readEvents(path.join(p.sessions, f))) if (r.ev) { events++; if ((r.ev.v || 1) < SCHEMA) old++; }
    }
  } catch { /* no sessions yet */ }
  return { schema: SCHEMA, files, events, old, migrated: 0 };
}
