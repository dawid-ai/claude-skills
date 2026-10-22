// The voice profile: .cts/voice.md. Plain text, hand-editable. Nothing is learned into it without a yes (voice.accept),
// and every learned line carries its suggestion id so `cts voice undo <id>` removes exactly that line.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { paths } from './util.mjs';

export const VOICE_TEMPLATE = `# CTS voice

How my posts should sound. CTS drafts from this file on every post. Edit freely.
Lines look like \`key: value\`. Per-channel keys are prefixed, e.g. \`x.max: 240\`.

opener:
signoff:
max:
never: leverage, delve, game-changer, excited to announce
swears: no
emoji: no

## Samples

Paste posts you wrote and liked here (one per paragraph). The drafter uses them as a reference for length and rhythm.

## Learned

Lines CTS suggested and you accepted are added below, each tagged with its id.
`;

export function initVoice(root) {
  const f = paths(root).voice;
  if (!fs.existsSync(f)) { fs.mkdirSync(paths(root).cts, { recursive: true }); fs.writeFileSync(f, VOICE_TEMPLATE); return true; }
  return false;
}

export function parseVoice(text = '') {
  const kv = {};
  let section = '';
  const samples = [];
  for (const raw of text.split(/\r?\n/)) {
    const h = /^##\s+(.*)/.exec(raw);
    if (h) { section = h[1].trim().toLowerCase(); continue; }
    if (section === 'samples') { if (raw.trim()) samples.push(raw.trim()); continue; }
    const m = /^([a-z][\w.-]*):[ \t]*(.*?)\s*(?:<!--.*-->)?$/i.exec(raw);
    if (m) (kv[m[1].toLowerCase()] ||= []).push(m[2]);
  }
  const list = (k) => (kv[k] || []).flatMap((v) => v.split(',')).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const one = (k) => { const v = (kv[k] || []).filter(Boolean); return v.length ? v[v.length - 1] : ''; };
  return {
    text, samples,
    never: [...new Set([...list('never'), ...Object.keys(kv).filter((k) => k.endsWith('.never')).flatMap(list)])],
    swears: /^(yes|true|on)$/i.test(one('swears')), emoji: !/^(no|false|off)$/i.test(one('emoji') || 'no'),
    rev: crypto.createHash('sha1').update(text).digest('hex').slice(0, 8),
    for(channel) {
      const get = (k) => one(`${channel}.${k}`) || one(k);
      const max = parseInt(get('max'), 10);
      return { opener: get('opener'), signoff: get('signoff'), max: Number.isFinite(max) && max > 0 ? max : null };
    },
  };
}

export function loadVoice(root) {
  let text = '';
  try { text = fs.readFileSync(paths(root).voice, 'utf8'); } catch { /* none yet: defaults */ }
  return parseVoice(text);
}

const learnedLine = (s) => `${s.key}: ${s.value} <!-- s:${s.id} -->`;
export function acceptSuggestion(root, s) {
  initVoice(root);
  const f = paths(root).voice;
  let t = fs.readFileSync(f, 'utf8');
  if (t.includes(`s:${s.id} `)) return false;
  if (!/^##\s+Learned/mi.test(t)) t += '\n## Learned\n';
  t = t.replace(/\s*$/, '\n') + learnedLine(s) + '\n';
  fs.writeFileSync(f, t);
  return true;
}
export function undoSuggestion(root, id) {
  const f = paths(root).voice;
  let t; try { t = fs.readFileSync(f, 'utf8'); } catch { return false; }
  const lines = t.split('\n'); const keep = lines.filter((l) => !l.includes(`<!-- s:${id} -->`));
  if (keep.length === lines.length) return false;
  fs.writeFileSync(f, keep.join('\n'));
  return true;
}
export const suggestionId = (key, value) => crypto.createHash('sha1').update(`${key}=${value}`).digest('hex').slice(0, 8);
