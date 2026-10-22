// The settings page's model: a whitelist of editable cts.json fields, their types and where each value comes from.
// Saving merges only those fields into the project's .cts/cts.json; every other key in that file is kept as it was.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths, readJson, loadConfig, DEFAULT_CONFIG } from './util.mjs';
import { BASE } from './engine.mjs';

const KINDS = Object.keys(BASE);
const CHANNELS = Object.keys(DEFAULT_CONFIG.publishing.channels);
const MODES = ['draft', 'notify', 'auto'];

export const FIELDS = [
  { path: 'threshold', section: 'Signal', label: 'Feed threshold', type: 'int', min: 0, max: 100, help: 'Moments under this score stay out of the default feed.' },
  { path: 'detectors.fightMin', section: 'Signal', label: 'Failed attempts before a fight', type: 'int', min: 2, max: 20 },
  { path: 'detectors.waitMinutes', section: 'Signal', label: 'Minutes before a wait counts', type: 'int', min: 1, max: 600 },
  { path: 'detectors.mainBranches', section: 'Signal', label: 'Main branches (globs)', type: 'list', help: 'A commit on one of these is "shipped".' },
  ...KINDS.filter((k) => k !== 'mark').map((k) => ({ path: `detectors.weights.${k}`, section: 'Detector weights', label: k, type: 'number', min: 0, max: 2, step: 0.1, dflt: 1 })),
  { path: 'drafts.kinds', section: 'Autopilot', label: 'Kinds that draft automatically', type: 'set', options: KINDS },
  { path: 'drafts.min', section: 'Autopilot', label: 'Minimum score to draft', type: 'int', min: 0, max: 100 },
  { path: 'drafts.channels', section: 'Autopilot', label: 'Channels for moment drafts', type: 'set', options: CHANNELS },
  { path: 'drafts.arcChannels', section: 'Autopilot', label: 'Channels for finished arcs', type: 'set', options: CHANNELS },
  { path: 'drafts.modes', section: 'Autopilot', label: 'Rules (key = mode)', type: 'modes', help: 'One per line: kind:channel, kind or channel = draft | notify | auto. Auto still needs a clean guard and nothing masked.' },
  { path: 'drafts.writer', section: 'Autopilot', label: 'Who writes drafts', type: 'enum', options: ['off', 'claude', 'api'], help: 'off = plain templates. claude (your Claude Code login) or api (ANTHROPIC_API_KEY) tells each draft as a story from redacted material; a story that fails the checks falls back to the template.' },
  { path: 'drafts.model', section: 'Autopilot', label: 'Storyteller model', type: 'text', max: 100 },
  { path: 'drafts.expireDays', section: 'Autopilot', label: 'Pending drafts expire after (days)', type: 'int', min: 1, max: 90 },
  ...CHANNELS.flatMap((c) => [
    { path: `publishing.channels.${c}.cap`, section: 'Channels', label: `${c}: daily cap`, type: 'int', min: 0, max: 50 },
    ...(DEFAULT_CONFIG.publishing.channels[c].limit ? [{ path: `publishing.channels.${c}.limit`, section: 'Channels', label: `${c}: character limit`, type: 'int', min: 1, max: 100000 }] : []),
    { path: `publishing.channels.${c}.cadence.time`, section: 'Channels', label: `${c}: next-slot time (HH:MM)`, type: 'time', dflt: '09:00' },
  ]),
  { path: 'notify.desktop', section: 'Notifications', label: 'Desktop notification for notify-mode drafts', type: 'bool' },
  { path: 'notify.terminal', section: 'Notifications', label: 'Line at session start when drafts wait', type: 'bool' },
  { path: 'redact.deny', section: 'Privacy', label: 'Always mask these terms', type: 'list' },
  { path: 'redact.allow', section: 'Privacy', label: 'Never mask these terms', type: 'list' },
  { path: 'retentionDays', section: 'Privacy', label: 'Keep raw events for (days)', type: 'int', min: 0, max: 3650, help: '0 keeps everything. Sessions that ended longer ago lose their prompts and tool output; moments, threads, arcs, drafts and evidence stay. Runs daily while the dashboard server is up.' },
  { path: 'share.prompts', section: 'Privacy', label: 'Prompts in shared output (project default)', type: 'enum', options: ['verbatim', 'summary'], dflt: 'verbatim', help: 'Each person can override this for their own prompts with cts consent.' },
  { path: 'private', section: 'Privacy', label: 'Private project (no drafts, share or export)', type: 'bool' },
  { path: 'extraction.auto', section: 'Extraction', label: 'Run extraction automatically', type: 'enum', options: ['off', 'api', 'claude'], help: 'api uses ANTHROPIC_API_KEY; claude uses your Claude Code login (claude -p, no tools). Off by default: it sends the candidate spans to the model.' },
  { path: 'extraction.model', section: 'Extraction', label: 'Model', type: 'text', max: 100 },
  { path: 'extraction.everyMinutes', section: 'Extraction', label: 'While you work, at most every (minutes)', type: 'int', min: 5, max: 1440 },
  { path: 'extraction.urgentScore', section: 'Extraction', label: 'Run sooner for a candidate scoring at least', type: 'int', min: 0, max: 101 },
  { path: 'extraction.limit', section: 'Extraction', label: 'Candidates per run', type: 'int', min: 1, max: 40 },
  { path: 'port', section: 'Server', label: 'Dashboard port (next start)', type: 'int', min: 0, max: 65535 },
];
const BY_PATH = new Map(FIELDS.map((f) => [f.path, f]));

const get = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
function set(o, p, v) {
  const ks = p.split('.'); let x = o;
  for (const k of ks.slice(0, -1)) { if (!x[k] || typeof x[k] !== 'object' || Array.isArray(x[k])) x[k] = {}; x = x[k]; }
  if (v === undefined) delete x[ks.at(-1)]; else x[ks.at(-1)] = v;
}

/** Every field with its effective value and where that value comes from: project, global (~/.cts/config.json) or default. */
export function getSettings(root) {
  const proj = readJson(paths(root).config, {}) || {};
  const glob = readJson(path.join(os.homedir(), '.cts', 'config.json'), {}) || {};
  const eff = loadConfig(root);
  return {
    file: path.relative(root, paths(root).config).replace(/\\/g, '/'),
    fields: FIELDS.map((f) => {
      let value = get(eff, f.path);
      if (value === undefined) value = f.dflt ?? null;
      if (f.type === 'enum' && value === false) value = 'off';
      return { ...f, value, source: get(proj, f.path) !== undefined ? 'project' : get(glob, f.path) !== undefined ? 'global' : 'default' };
    }),
  };
}

/** Parse and check one value. Returns [value] or [undefined, error]. `null` means "remove from the project file". */
export function coerce(f, v) {
  if (v === null) return [undefined];
  const bad = (m) => [undefined, `${f.label}: ${m}`];
  switch (f.type) {
    case 'int': case 'number': {
      const n = Number(v);
      if (!Number.isFinite(n) || (f.type === 'int' && !Number.isInteger(n))) return bad('not a number');
      if ((f.min != null && n < f.min) || (f.max != null && n > f.max)) return bad(`must be ${f.min}–${f.max}`);
      return [n];
    }
    case 'bool': return typeof v === 'boolean' ? [v] : bad('must be on or off');
    case 'enum': { const x = v === false ? 'off' : String(v); return f.options.includes(x) ? [x === 'off' ? false : x] : bad(`must be one of ${f.options.join(', ')}`); }
    case 'text': return typeof v === 'string' && v.trim() && v.length <= (f.max || 500) ? [v.trim()] : bad('must be non-empty text');
    case 'time': return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? [String(v)] : bad('must be HH:MM');
    case 'list': {
      const xs = (Array.isArray(v) ? v : String(v).split(/[\n,]/)).map((s) => String(s).trim()).filter(Boolean);
      return xs.every((s) => s.length <= 200) ? [[...new Set(xs)]] : bad('an entry is too long');
    }
    case 'set': {
      const xs = Array.isArray(v) ? v.map(String) : [];
      const unknown = xs.filter((x) => !f.options.includes(x));
      return unknown.length ? bad(`unknown: ${unknown.join(', ')}`) : [[...new Set(xs)]];
    }
    case 'modes': {
      const out = {};
      const lines = typeof v === 'string' ? v.split('\n') : Object.entries(v || {}).map(([k, m]) => `${k} = ${m}`);
      for (const raw of lines) {
        const line = raw.trim(); if (!line) continue;
        const [key, mode] = line.split('=').map((s) => s.trim());
        if (!key || !MODES.includes(mode)) return bad(`"${line}": mode must be ${MODES.join(', ')}`);
        const [a, b] = key.split(':');
        if (b ? !(KINDS.includes(a) && CHANNELS.includes(b)) : !(KINDS.includes(a) || CHANNELS.includes(a))) return bad(`"${key}" is not a kind, channel or kind:channel`);
        out[key] = mode;
      }
      return [out];
    }
    default: return bad('not editable');
  }
}

/** Apply `changes` ({path: value|null}) to the project config. All or nothing: any error and the file is untouched. */
export function applySettings(root, changes) {
  const errors = [], next = readJson(paths(root).config, {}) || {};
  for (const [p, v] of Object.entries(changes || {})) {
    const f = BY_PATH.get(p);
    if (!f) { errors.push(`${p}: not an editable setting`); continue; }
    const [val, err] = coerce(f, v);
    if (err) errors.push(err); else set(next, p, val);
  }
  if (errors.length) return { ok: false, errors };
  const file = paths(root).config, tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n'); fs.renameSync(tmp, file);
  return { ok: true, changed: Object.keys(changes || {}).length };
}
