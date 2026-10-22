// Small shared helpers. Keep imports light: the capture hook loads this file on every event.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const SCHEMA = 1;
/** Node flags for the long-running dashboard server: a small young generation keeps steady memory near the live data. */
export const SERVER_FLAGS = ['--max-semi-space-size=1'];
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Crockford-base32 ULID. `rnd` (10 bytes) makes it deterministic for imports. */
export function ulid(t = Date.now(), rnd) {
  let s = '';
  let n = t;
  for (let i = 0; i < 10; i++) { s = B32[n % 32] + s; n = Math.floor(n / 32); }
  const r = rnd || crypto.randomBytes(10);
  let bits = 0n;
  for (const b of r) bits = (bits << 8n) | BigInt(b);
  let tail = '';
  for (let i = 0; i < 16; i++) { tail = B32[Number(bits & 31n)] + tail; bits >>= 5n; }
  return s + tail;
}

const T = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; T[i] = c >>> 0; }
// Native CRC-32 (Node >= 22.2) is the same IEEE polynomial as the table below, several times faster on replay.
const nativeCrc = typeof zlib.crc32 === 'function' ? zlib.crc32 : null;
export function crc32(s) {
  if (nativeCrc) return nativeCrc(s).toString(16).padStart(8, '0');
  const b = Buffer.from(s);
  let c = ~0;
  for (let i = 0; i < b.length; i++) c = T[(c ^ b[i]) & 255] ^ (c >>> 8);
  return ((~c) >>> 0).toString(16).padStart(8, '0');
}

/** One event -> one JSONL line with a trailing per-line checksum. */
export function serialize(ev) {
  const body = JSON.stringify(ev);
  return body.slice(0, -1) + ',"crc":"' + crc32(body) + '"}\n';
}
/** Parse and verify one line. Returns null for anything truncated or corrupt. */
export function parseLine(line) {
  const m = /,"crc":"([0-9a-f]{8})"\}$/.exec(line);
  if (!m) return null;
  const body = line.slice(0, m.index) + '}';
  if (crc32(body) !== m[1]) return null;
  try { return JSON.parse(body); } catch { return null; }
}

const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };

/** Walk up from cwd: nearest dir with .cts (never the home dir, which holds global ~/.cts) or .git. */
export function findRoot(cwd) {
  const home = os.homedir();
  let d = path.resolve(cwd);
  for (;;) {
    if (d !== home && exists(path.join(d, '.cts'))) return d;
    if (exists(path.join(d, '.git'))) return d;
    const p = path.dirname(d);
    if (p === d) break;
    d = p;
  }
  return path.resolve(cwd);
}

export function paths(root) {
  const cts = path.join(root, '.cts');
  return {
    root, cts,
    sessions: path.join(cts, 'sessions'),
    db: path.join(cts, 'index.sqlite'),
    config: path.join(cts, 'cts.json'),
    server: path.join(cts, 'server.json'),
    paused: path.join(cts, 'paused'),
    pubPaused: path.join(cts, 'publishing-paused'),
    context: path.join(cts, 'context.json'),
    digests: path.join(cts, 'digests'),
    evidence: path.join(cts, 'evidence'),
    hooklog: path.join(cts, 'hooks.log'),
    voice: path.join(cts, 'voice.md'),
  };
}

export const DEFAULT_CONFIG = {
  schema: SCHEMA,
  private: false,
  port: 4848,
  threshold: 50,
  arcOpenDays: 5,
  retentionDays: 0,
  detectors: {
    fightMin: 3,
    waitMinutes: 30,
    mainBranches: ['main', 'master', 'trunk', 'release*'],
    weights: {},
  },
  redact: { allow: [], deny: [] },
  extraction: {
    model: 'claude-haiku-5-5',
    auto: false,        // false | 'api' (ANTHROPIC_API_KEY) | 'claude' (your Claude Code login, via claude -p)
    everyMinutes: 30,   // while you work, at most this often
    urgentScore: 70,    // a candidate this strong runs it sooner (still at most every minGapMinutes)
    minGapMinutes: 5,
    limit: 12,          // candidates per run: bounds what one run reads and costs
  },
  drafts: {
    expireDays: 7,
    channels: ['x'],            // channels a moment draft is made for
    arcChannels: ['linkedin'],  // channels a finished arc draft is made for
    kinds: ['shipped', 'broke', 'reversal', 'disagreement'],
    min: 60,
    unfinishedDays: 5,
    writer: false,              // false = templates | 'claude' (your login, claude -p) | 'api' (ANTHROPIC_API_KEY): a model tells the story
    model: 'claude-sonnet-5-5', // the storyteller's model (Haiku invents lessons and asides more often)
    modes: {},                  // 'draft' (default) | 'notify' | 'auto', keyed 'kind:channel', 'kind' or 'channel'
  },
  notify: { desktop: true, terminal: true }, // where 'notify'-mode drafts are announced; terminal = a line at session start
  publishing: {
    paused: false,
    channels: {
      x: { adapter: 'outbox', limit: 280, cap: 3 },
      bluesky: { adapter: 'outbox', limit: 300, cap: 3 },
      mastodon: { adapter: 'outbox', limit: 500, cap: 3 },
      threads: { adapter: 'outbox', limit: 500, cap: 3 },
      linkedin: { adapter: 'outbox', limit: 3000, cap: 1 },
      blog: { adapter: 'blog', dir: 'content/posts', cap: 2 },
      newsletter: { adapter: 'newsletter', dir: 'content/newsletter', cap: 1 },
      changelog: { adapter: 'changelog', file: 'CHANGELOG.md', cap: 5 },
    },
  },
};

export function loadConfig(root) {
  const p = paths(root);
  let cfg = structuredClone(DEFAULT_CONFIG);
  for (const f of [path.join(os.homedir(), '.cts', 'config.json'), p.config]) {
    try { cfg = deepMerge(cfg, JSON.parse(fs.readFileSync(f, 'utf8'))); } catch { /* optional */ }
  }
  return cfg;
}
function deepMerge(a, b) {
  for (const [k, v] of Object.entries(b || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object') a[k] = deepMerge(a[k], v);
    else a[k] = v;
  }
  return a;
}

export function ensureProject(root) {
  const p = paths(root);
  fs.mkdirSync(p.sessions, { recursive: true });
  if (!exists(p.config)) fs.writeFileSync(p.config, JSON.stringify({ schema: SCHEMA }, null, 2) + '\n');
  const gi = path.join(p.cts, '.gitignore');
  if (!exists(gi)) fs.writeFileSync(gi, 'index.sqlite*\nserver.json\npaused\nhooks.log\ncontext.json\n');
  return p;
}

export function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
export function readJson(f, dflt = null) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } }
export const trunc = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
export const ago = (ms) => {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm';
  const h = Math.round(m / 60);
  if (h < 48) return h + 'h';
  return Math.round(h / 24) + 'd';
};
