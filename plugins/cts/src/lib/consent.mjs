// Per-person consent for shared output. When .cts/ is committed by a team, each person decides whether their own prompts
// appear verbatim or withheld in anything shared (story page, cards, exports, replays, drafts). The local dashboard
// always shows everything. Prompts carry `d.who`, a short hash of the person, never the name itself.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const ctsHome = () => process.env.CTS_HOME || path.join(os.homedir(), '.cts');

let cached;
/** This person's id: hash of CTS_USER, else "me" in ~/.cts/config.json, else the OS user name. */
export function whoAmI() {
  if (cached && cached.env === process.env.CTS_USER && cached.home === ctsHome()) return cached.id;
  let name = process.env.CTS_USER;
  if (!name) { try { name = JSON.parse(fs.readFileSync(path.join(ctsHome(), 'config.json'), 'utf8')).me; } catch { /* optional */ } }
  if (!name) { try { name = os.userInfo().username; } catch { name = 'unknown'; } }
  const id = crypto.createHash('sha1').update('cts-person:' + String(name).trim().toLowerCase()).digest('hex').slice(0, 12);
  cached = { env: process.env.CTS_USER, home: ctsHome(), id };
  return id;
}

/** 'verbatim' or 'summary' for a person: their own entry in cts.json "people", else the project default "share.prompts". */
export function promptPolicy(pr, who) {
  const own = who && pr.cfg.people && pr.cfg.people[who];
  return (own && own.prompts) || (pr.cfg.share && pr.cfg.share.prompts) || 'verbatim';
}
export const withheld = (pr, who) => promptPolicy(pr, who) === 'summary';

const words = (t) => (String(t || '').trim().match(/\S+/g) || []).length;
const PLACEHOLDER = (t) => `[prompt withheld, ${words(t)} words]`;

/** A moment as it may be shared: a withheld person's prompt is removed from the headline, body and evidence. */
export function consentMoment(pr, m) {
  const prompt = m.evidence && m.evidence.prompt;
  if (!m.who || !prompt || !withheld(pr, m.who)) return m;
  const strip = (s) => {
    if (typeof s !== 'string') return s;
    let out = s;
    for (const q of [prompt, prompt.slice(0, 90)]) if (q && out.includes(q)) out = out.split(q).join('…');
    return out.replace(/[:\s]*[“"]…[”"]/g, '').replace(/[:\s]*[“"][^”"]*…[”"]/g, '');
  };
  const { prompt: _drop, ...evidence } = m.evidence;
  return { ...m, headline: `${strip(m.headline)} (prompt withheld)`.replace(/\s+\(prompt withheld\)$/, ' (prompt withheld)'), body: (m.body || []).map(strip), evidence, note: strip(m.note) };
}

/** Any derived text (an arc title is a moment's headline) with the withheld prompts of `moments` taken out. */
export function consentText(pr, text, moments) {
  let out = String(text ?? '');
  for (const m of moments) {
    const c = m && consentMoment(pr, m);
    if (!c || c === m) continue;
    if (out === m.headline) return c.headline;
    const p = m.evidence.prompt;
    for (const q of [p, p.slice(0, 90)]) if (q && out.includes(q)) out = out.split(q).join('…') + (out.endsWith(' (prompt withheld)') ? '' : ' (prompt withheld)');
  }
  return out;
}

/** An event as it may be shared: a withheld person's prompt text becomes a placeholder. */
export function consentEvent(pr, e) {
  if (e.kind !== 'prompt' || !e.d || !withheld(pr, e.d.who)) return e;
  return { ...e, d: { ...e.d, text: PLACEHOLDER(e.d.text) } };
}
