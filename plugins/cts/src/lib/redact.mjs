// The wall between the private log and anything public. Everything that leaves (cards, exports, drafts) passes through here.
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { SECRET_RULES } from './secrets.mjs';

const entropy = (s) => { const f = {}; for (const c of s) f[c] = (f[c] || 0) + 1; return -Object.values(f).reduce((a, n) => a + (n / s.length) * Math.log2(n / s.length), 0); };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const RULES = [
  ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
  ['internal-url', /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|[\w.-]+\.(?:internal|corp|local|lan|intranet))(?::\d+)?[^\s)>\]"']*/gi, '[internal-url]'],
  ['url', /\bhttps?:\/\/[^\s)>\]"']+/gi, '[url]'],
  ['private-ip', /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g, '[ip]'],
  ['hostname', /\b(?:[a-z0-9-]+\.)+(?:internal|corp|local|lan|intranet|dev|io|net|org|com)\b(?!\.\w)/gi, '[host]'],
  // Windows paths with \, \\ (inside JSON strings) or / separators: C:\Users\x, C:\\Users\\x, F:/88_CODE/x.
  ['abs-path-win', /\b[A-Za-z]:(?:\\{1,2}|\/)(?:[\w .$()@~+-]+(?:\\{1,2}|\/))*[\w.$()@~+-]*/g, '[path]'],
  ['abs-path', /(?<![\w:/.])\/(?:[\w.@~+-]+\/)+[\w.@~+-]*/g, '[path]'],
  ['rel-path', /(?<![\w/@.:-])(?:\.{1,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,6}\b/g, '[path]'],
];

// Account names too generic to mask as words (CI runners, containers).
const GENERIC_USERS = new Set(['root', 'user', 'users', 'admin', 'runner', 'ubuntu', 'vagrant', 'node', 'app', 'default', 'guest', 'owner']);

/** Names that identify this project and this person: directory name, git remote repo and owner, OS user. Masked unless allow-listed. */
export function projectNames(root) {
  const names = new Set([path.basename(root)]);
  for (const u of [(() => { try { return os.userInfo().username; } catch { return ''; } })(), path.basename(os.homedir())]) {
    if (u && u.length >= 4 && !GENERIC_USERS.has(u.toLowerCase())) names.add(u);
  }
  try {
    const url = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(url);
    if (m) { names.add(m[2]); names.add(m[1]); }
  } catch { /* no remote */ }
  return [...names].filter((n) => n.length >= 3);
}

/**
 * redact(text, {allow, deny, names}) -> {text, report:[{rule, kind, preview, length}]}
 * allow: strings that must survive. deny: extra terms to always mask.
 */
export function redact(text, { allow = [], deny = [], names = [] } = {}) {
  const report = [];
  if (typeof text !== 'string' || !text) return { text, report };
  // Protect allow-listed substrings with placeholders.
  const keep = [];
  let out = text;
  for (const a of allow) {
    if (!a) continue;
    out = out.replace(new RegExp(esc(a), 'g'), () => { keep.push(a); return `\u0001${keep.length - 1}\u0002`; });
  }
  const note = (rule, m) => report.push({ rule, kind: 'secret', preview: m.slice(0, 2) + '…', length: m.length });
  for (const [rule, re] of SECRET_RULES) {
    re.lastIndex = 0;
    if (rule === 'kv-secret') {
      out = out.replace(re, (m, k, sep, v) => { const q = /^["']/.test(v) ? v[0] : ''; if (/^\[redacted/.test(q ? v.slice(1) : v)) return m; note(rule, v); return k + sep + q + '[redacted]' + q; });
    } else out = out.replace(re, (m) => { note(rule, m); return '[redacted]'; });
  }
  // High-entropy tokens that no pattern named.
  out = out.replace(/(?<![\w\u0001])[A-Za-z0-9+/_=-]{24,}(?![\w\u0002])/g, (m) => {
    if (/^[0-9a-f]{40}$|^[0-9A-HJKMNP-TV-Z]{26}$/.test(m) || /^[a-z_-]+$/i.test(m) || !/\d/.test(m) || !/[A-Za-z]/.test(m)) return m;
    if (entropy(m) < 3.8) return m;
    note('entropy', m); return '[redacted]';
  });
  for (const [rule, re, mask] of RULES) {
    out = out.replace(re, (m) => { report.push({ rule, kind: 'identifier', preview: m.slice(0, 2) + '…', length: m.length }); return mask; });
  }
  const terms = [...new Set([...deny, ...names])].filter((t) => t && !allow.includes(t));
  terms.sort((a, b) => b.length - a.length);
  for (const term of terms) {
    const isDeny = deny.includes(term);
    // A multi-word name is still that name with another separator or none: `night owl 512`, `night-owl-512`, `night|owl|512`.
    const parts = term.split(/[\s._/|-]+/).filter(Boolean);
    const src = parts.length > 1 ? parts.map(esc).join('[\\s._/|-]?') : esc(term);
    out = out.replace(new RegExp(`(?<![\\w])${src}(?![\\w])`, 'gi'), (m) => { report.push({ rule: isDeny ? 'deny-list' : 'project-name', kind: 'name', preview: m.slice(0, 2) + '…', length: m.length }); return isDeny ? '[masked]' : '[repo]'; });
  }
  out = out.replace(/\u0001(\d+)\u0002/g, (_, i) => keep[+i]);
  return { text: out, report };
}

/** Redact every string inside a JSON-able value. Returns {value, report}. */
export function redactDeep(value, opts) {
  const report = [];
  const walk = (v) => {
    if (typeof v === 'string') { const r = redact(v, opts); report.push(...r.report); return r.text; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = walk(x); return o; }
    return v;
  };
  return { value: walk(value), report };
}

export function summarizeReport(report) {
  const by = {};
  for (const r of report) by[r.rule] = (by[r.rule] || 0) + 1;
  return by;
}
