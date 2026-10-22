// Reading session logs: tolerant of truncated tails and corrupt lines, returns byte offsets.
import fs from 'node:fs';
import { parseLine } from './util.mjs';

/** Stream complete lines of a log from byte `from` in 1 MB chunks (bounded memory). Yields {ev|null, off, end}. */
export function* readEvents(file, from = 0, chunk = 1 << 20) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return; }
  try {
    let pos = from, carry = Buffer.alloc(0);
    const buf = Buffer.alloc(chunk);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, chunk, pos);
      if (!n) break;
      const base = pos - carry.length;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
      let start = 0;
      for (;;) {
        const nl = data.indexOf(10, start);
        if (nl < 0) break;
        const line = data.toString('utf8', start, nl);
        if (line.trim()) yield { ev: parseLine(line), off: base + start, end: base + nl + 1 };
        else yield { ev: null, off: base + start, end: base + nl + 1, blank: true };
        start = nl + 1;
      }
      carry = data.subarray(start);
      pos += n;
    }
  } finally { fs.closeSync(fd); }
}

/** Read complete, valid lines of `file` starting at byte `from`. Returns {events, end, bad}. */
export function readFrom(file, from = 0) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return { events: [], end: from, bad: 0 }; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= from) return { events: [], end: Math.min(from, size), bad: 0 };
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    const events = [];
    let bad = 0, pos = 0;
    for (;;) {
      const nl = buf.indexOf(10, pos);
      if (nl < 0) break; // incomplete tail: wait for the rest
      const line = buf.toString('utf8', pos, nl);
      if (line.trim()) {
        const ev = parseLine(line);
        if (ev) { ev._off = from + pos; events.push(ev); } else bad++;
      }
      pos = nl + 1;
    }
    return { events, end: from + pos, bad };
  } finally { fs.closeSync(fd); }
}

import path from 'node:path';
import { ulid, serialize, paths, ensureProject, SCHEMA } from './util.mjs';

/** Newest real session file (ignores imports) - where human actions made outside a hook get written. */
export function latestSession(root) {
  const p = paths(root);
  let best = null;
  try {
    for (const f of fs.readdirSync(p.sessions)) {
      if (!f.endsWith('.jsonl') || f.startsWith('git-import') || f.startsWith('import-')) continue;
      const st = fs.statSync(path.join(p.sessions, f));
      if (!best || st.mtimeMs > best.m) best = { sid: f.slice(0, -6), m: st.mtimeMs };
    }
  } catch { /* no sessions yet */ }
  return best ? best.sid : 'manual';
}

/** Append a human decision (mark, dismiss, confirm...) as an ordinary event. One write, no model, no server. */
export function writeHumanEvent(root, kind, d = {}, { sid, actor = 'human' } = {}) {
  const p = ensureProject(root);
  sid = sid || latestSession(root);
  const ev = { v: SCHEMA, id: ulid(), sid, ts: new Date().toISOString(), hook: 'cts', kind, actor, prompt_id: null, cwd: root, d };
  const fd = fs.openSync(path.join(p.sessions, `${sid}.jsonl`), 'a');
  fs.writeSync(fd, serialize(ev));
  fs.closeSync(fd);
  return ev;
}
