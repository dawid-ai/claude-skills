// The only part of CTS that writes prose. Deterministic templates over the log: every draft links to its source moment,
// every number and quote in it must trace to an event (checkDraft), and everything passes through the redactor first.
import fs from 'node:fs';
import path from 'node:path';
import { ulid, trunc, paths } from './util.mjs';
import { redact, redactDeep } from './redact.mjs';
import { redactOpts, evidenceLine, cardSvg } from './share.mjs';
import { writeHumanEvent } from './log.mjs';
import { claimProblems, askApi, askClaude, parseAnswer } from './extract.mjs';
import { summarize } from './summary.mjs';
import { loadVoice, suggestionId } from './voice.mjs';
import { textHash, postsOf, POST_SEP } from './drafts.mjs';
import { consentMoment, consentText, consentEvent } from './consent.mjs';

const MIN = 60000, DAY = 86400000;
export const SOCIAL = ['x', 'bluesky', 'mastodon', 'threads'];
const firstPerson = (s) => String(s || '').replace(/^You\b/, 'I').replace(/\bon you\b/gi, 'on me').replace(/\bYou\b/g, 'I');

export function quote(s, n = 110) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.length <= n) return `“${s}”`;
  const cut = s.slice(0, n).replace(/\s+\S*$/, '');
  return cut ? `“${cut}”…` : '';
}
// Runner summaries and banners (jest `Tests:`, vitest `Test Files  1 failed | 2 passed`, `⎯⎯ Failed Tests 1 ⎯⎯`) are counts, not errors.
const SUMMARY_LINE = /^(?:tests?|test (?:suites?|files)|duration|start at)\b:?\s|^[⎯─=-]+\s*failed tests\b|^\d+ (?:passed|failed)\b/i;
const errLine = (out) => {
  const ls = String(out || '').split('\n').map((l) => l.trim()).filter((l) => l && !SUMMARY_LINE.test(l));
  const hit = [...ls].reverse().find((l) => /^[×✗✕]\s|expected|received|error|assert|fail|cannot|undefined|not found|timeout/i.test(l)) || ls[ls.length - 1];
  return hit ? hit.replace(/\s+\d+ms$/, '').slice(0, 110) : '';
};
const numsIn = (v, acc = []) => {
  if (typeof v === 'number') acc.push(v);
  else if (typeof v === 'string') (v.match(/\d+/g) || []).forEach((x) => acc.push(+x));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => numsIn(x, acc));
  return acc;
};
const label = (pr, m, a) => { const S = pr.engine.sessions.get(m.sid); const x = S && S.actors.get(a); return x ? x.label : a; };

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const minsIn = (s) => { const x = /(\d+) min\b/.exec(String(s)); return x ? +x[1] : null; };
const actorWord = (pr, m, a) => (a === 'human' ? 'I' : a === 'main' ? 'the main agent' : `the ${label(pr, m, a)} agent`);

/**
 * What a moment was, told in plain first-person words. Posts are stories: the log's prompts, commands, branches, paths,
 * test names and error lines are material, never quoted (the dashboard keeps them as evidence). One number at most.
 */
function storyLines(pr, m) {
  const E = m.evidence || {}, h = String(m.headline || '');
  switch (m.kind) {
    case 'fight': return [E.attempts ? `It took ${E.attempts} failed attempts before it finally passed.` : 'I kept hitting the same failure before it finally passed.'];
    case 'broke': { const n = E.counts && E.counts.fail; return [n ? `A change broke ${plural(n, 'test')} that ${n === 1 ? 'was' : 'were'} passing before.` : 'A change broke something that was working before.']; }
    case 'reversal': return [E.prompt ? 'I stopped and pulled the work back to an earlier direction.' : 'I threw a change away and went back to the earlier version.'];
    case 'refusal': return [E.prompt ? 'I said no to what was proposed.' : 'I blocked a step before it ran.'];
    case 'disagreement': { const [b, a] = m.actors || []; return [`${actorWord(pr, m, a || 'main')} pushed back on ${actorWord(pr, m, b || 'main')}.`.replace(/^./, (c) => c.toUpperCase())]; }
    case 'shipped':
      if (E.tag) return [`I released version ${String(E.tag).replace(/^v(?=\d)/, '')}.`];
      if (E.stat) return [`Shipped it: ${plural(E.stat.ins + E.stat.del, 'line')} changed.`];
      if (/^Merged into/.test(h)) return ['I merged the work in.'];
      if (/^Pull request/.test(h)) return ['The pull request went in.'];
      if (/^Deployed again/.test(h)) return ['I deployed it again.'];
      if (/^Deployed/.test(h)) return ['I deployed it.'];
      return ['I shipped it.'];
    case 'pivot':
      if (E.minutes) return [`After ${E.minutes} minutes on one approach, I switched to another.`];
      if (/^Swapped/.test(h)) return ['I swapped one library for another.'];
      if (/^Deleted/.test(h)) { const n = minsIn(h); return [n ? `I deleted something ${plural(n, 'minute')} after writing it.` : 'I deleted something soon after writing it.']; }
      return ['I set the work aside and tried another path in parallel.'];
    case 'memory-cut': { const n = (E.files || []).length; return [n ? `After the context was compacted, the agent re-read ${plural(n, 'file')} it had already seen.` : 'After the context was compacted, the agent re-read files it had already seen.']; }
    case 'escalation': return ['I switched models to get unstuck.'];
    case 'wait': return [E.minutes ? `The agent sat waiting ${E.minutes} minutes for me.` : 'The agent sat waiting for me.'];
    default: return [m.note || firstPerson(h)];
  }
}

/** One moment as 1-3 lines of first-person prose, plus the events and structural numbers its claims rest on. */
export function beat(pr, m) {
  m = consentMoment(pr, m);
  const E = m.evidence || {};
  const extra = [...numsIn(m.headline), ...numsIn(E.stat), E.stat ? E.stat.ins + E.stat.del : null, ...numsIn(E.counts), E.attempts, E.minutes, (E.files || []).length || null, ...Object.entries(E).filter(([k, v]) => k.endsWith('_ms') && typeof v === 'number').flatMap(([, v]) => [Math.max(1, Math.round(v / MIN)), Math.round(v / 1000)])].filter((x) => x != null);
  const lines = m.tier === 2 ? [m.headline, ...(m.body || []).filter(Boolean).slice(0, 2)] : storyLines(pr, m);
  return { lines: lines.filter(Boolean), refs: m.span.ids, extra, errLine: errLine(E.error) };
}

export function resolveSource(pr, id) {
  const e = pr.engine;
  if (String(id).startsWith('arc:')) {
    const want = String(id).slice(4);
    const arc = e.arcs().find((a) => want === a.id || want.startsWith(a.id + ':') || a.id.startsWith(want));
    return arc ? { type: 'arc', id: 'arc:' + arc.id + ':' + (arc.outcome || arc.status), arc, ms: arc.moments.map((x) => e.view(e.moments.get(x))) } : null;
  }
  const m = e.moments.get(id) || [...e.moments.values()].find((x) => x.id.endsWith(id) || x.id.startsWith(id));
  if (m) return { type: 'moment', id: m.id, m: e.view(m), ms: [e.view(m)] };
  return null;
}
export const formatFor = (src, channel) => (SOCIAL.includes(channel) ? (src.type === 'arc' && src.ms.length > 1 ? 'thread' : 'short') : channel === 'linkedin' ? 'linkedin' : channel === 'changelog' ? 'devlog' : 'long');

const lineFit = (lines, limit) => {
  lines = [...lines];
  const len = () => lines.join('\n').length;
  while (len() > limit && lines.length > 1) lines.pop();
  let t = lines.join('\n');
  if (t.length > limit) t = t.slice(0, limit - 1).replace(/\s+\S*$/, '') + '…';
  return t;
};
const dateOf = (t) => new Date(t).toISOString().slice(0, 10);

/** Assemble the draft text. Returns { text, refs, extra, title, lead }. */
export function compose(pr, src, channel, format) {
  const voice = loadVoice(pr.root);
  const v = voice.for(channel);
  const chcfg = (pr.cfg.publishing.channels || {})[channel] || {};
  const limit = Math.min(v.max || Infinity, chcfg.limit || Infinity);
  const ms = src.ms.slice().sort((a, b) => a.t0 - b.t0);
  const beats = ms.map((m) => ({ m: consentMoment(pr, m), b: beat(pr, m) }));
  const refs = [...new Set(beats.flatMap((x) => x.b.refs))].slice(0, 200);
  const extra = [...new Set(beats.flatMap((x) => x.b.extra))];
  // The title is the top moment told as a story, not its dashboard headline.
  const top = (src.type === 'arc' && beats.find((x) => x.m.headline === consentText(pr, src.arc.title, [x.m]))) || beats[0];
  const title = top.b.lines[0].replace(/\.$/, '');
  const report = [];
  const red = (s) => { const r = redact(s, redactOpts(pr)); report.push(...r.report); return r.text; };
  let text;
  if (src.unfinished) {
    const days = Math.max(1, Math.round((pr.engine.lastTs - src.arc.t0) / DAY));
    extra.push(days, ms.length);
    const lines = [`Still unfinished after ${days} days. ${top.b.lines[0]}`, `${ms.length} moments so far, no outcome yet.`];
    text = lineFit(lines.map(red), limit);
  } else if (format === 'short') {
    const lines = beats[0].b.lines.map(red);
    if (!lines.length) return null;
    let t = lineFit(lines, limit);
    if (v.opener && (v.opener + '\n' + t).length <= limit) t = v.opener + '\n' + t;
    if (v.signoff && (t + '\n' + v.signoff).length <= limit) t += '\n' + v.signoff;
    text = t;
  } else if (format === 'thread') {
    const picks = beats.filter((x) => x.m.score >= 50).slice(0, 8);
    const use = picks.length ? picks : beats.slice(0, 8);
    const N = use.length;
    const posts = use.map((x, i) => `${i + 1}/${N} ` + lineFit(x.b.lines.map(red), Math.max(40, limit - `${i + 1}/${N} `.length)));
    if (v.signoff && (posts[N - 1] + '\n' + v.signoff).length <= limit) posts[N - 1] += '\n' + v.signoff;
    text = posts.join(POST_SEP);
  } else if (format === 'linkedin') {
    const paras = beats.map((x) => red(x.b.lines.join(' ')));
    const lesson = ms.find((m) => m.kind === 'learned') || ms.find((m) => m.note);
    let tail = lesson ? `What I took from it: ${red(lesson.note || lesson.headline)}` : '';
    const head = v.opener ? [v.opener] : [];
    const foot = [tail, v.signoff].filter(Boolean);
    let body = [...paras];
    const join = () => [...head, ...body, ...foot].join('\n\n');
    while (join().length > limit && body.length > 1) body.splice(Math.floor(body.length / 2), 1);
    text = join();
    if (text.length > limit) text = text.slice(0, limit - 1).replace(/\s+\S*$/, '') + '…';
  } else if (format === 'long') {
    const tags = [...new Set(ms.map((m) => m.kind))];
    const fm = ['---', `title: "${red(title).replace(/"/g, '\\"')}"`, `date: ${dateOf(ms[ms.length - 1].t1)}`, 'draft: true', `tags: [${tags.join(', ')}]`, 'source: cts', '---', ''];
    text = [...fm, ...beats.flatMap((x) => [red(x.b.lines.join(' ')), ''])].join('\n');
  } else if (format === 'devlog') {
    text = beats.map((x) => `- ${dateOf(x.m.t1)}: ${red(x.b.lines[0])}${evidenceLine(x.m) ? ` (${evidenceLine(x.m)})` : ''}`).join('\n');
  } else return null;
  return { text, refs, extra, title: red(title), voiceRev: voice.rev, ms, report };
}

/** The honesty guard for a draft: numbers, number-words and quotes must trace to the cited events or the voice file. */
export function checkDraft(pr, d) {
  const problems = [];
  const evs = (d.claims.refs || []).map((id) => pr.eventById(id)).filter(Boolean);
  if (!evs.length) problems.push('no cited events');
  const voice = loadVoice(pr.root);
  let body = String(d.text);
  body = body.replace(/^---\n[\s\S]*?\n---\n/, '');                                   // front matter is metadata
  body = body.replace(/\d{4}-\d\d-\d\d(?:[ T]\d\d:\d\d)?|\b\d\d:\d\d\b/g, ' ');       // dates and clock times
  body = postsOf(body).map((p) => p.replace(/^\d+\/\d+\s/, '')).join('\n');          // thread numbering
  body = body.replace(/\[redacted\]|\[repo\]|\[masked\]/g, ' ');
  const quotes = [...body.matchAll(/“([^”]+)”/g)].map((m) => m[1]);
  const opts = redactOpts(pr);
  const pm = claimProblems(body.replace(/“[^”]*”/g, ' '), evs, { quotes, extra: d.claims.extra || [], voiceText: voice.text, redactFn: (t) => redact(t, opts).text });
  if (pm) problems.push(pm);
  const low = d.text.toLowerCase();
  for (const w of voice.never) if (w && new RegExp(`(?<![\\w])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'i').test(low)) problems.push(`uses "${w}", which your voice profile says to never use`);
  const lim = ((pr.cfg.publishing.channels || {})[d.channel] || {}).limit;
  if (lim && ['short', 'thread'].includes(d.format)) for (const p of postsOf(d.text)) if (p.length > lim) problems.push(`a post is ${p.length} characters; ${d.channel} allows ${lim}`);
  const red = redact(d.text, opts);
  const items = red.report.length + ((d.redaction && d.redaction.count) || 0);
  return { ok: problems.length === 0, problems, redactionClean: items === 0, redactionItems: items };
}

function cardFor(pr, m, channel, id) {
  try {
    const opts = redactOpts(pr);
    const pub = { id: m.id, kind: m.kind, score: m.score, headline: redact(firstPerson(m.headline), opts).text, actors: m.actors.map((a) => label(pr, m, a)), evidence: m.evidence, evidence_line: redact(evidenceLine(m), opts).text };
    const dir = path.join(paths(pr.root).cts, 'drafts');
    fs.mkdirSync(dir, { recursive: true });
    const rel = path.join('drafts', `${id}.svg`);
    fs.writeFileSync(path.join(paths(pr.root).cts, rel), cardSvg(pub, channel === 'linkedin' ? 'linkedin' : SOCIAL.includes(channel) ? 'x' : 'og'));
    return rel.replace(/\\/g, '/');
  } catch { return null; }
}

export function modeFor(pr, kind, channel) {
  const m = pr.cfg.drafts.modes || {};
  return m[`${kind}:${channel}`] || m[kind] || m[channel] || 'draft';
}

/** Create one draft (as a draft.create event). Returns the draft id, or null with a reason. */
/** The checks every draft passes before anything is written: private project, source, channel, declined, duplicate. */
function gate(pr, id, { channel, format, force }) {
  if (pr.cfg.private) return { error: 'this project is marked private in cts.json: drafting is disabled' };
  const src = resolveSource(pr, id);
  if (!src) return { error: `no moment or arc matches "${id}"` };
  if (String(src.id).endsWith(':unfinished')) src.unfinished = true;
  const chs = pr.cfg.publishing.channels || {};
  if (!chs[channel]) return { error: `unknown channel "${channel}" (configured: ${Object.keys(chs).join(', ')})` };
  format = format || formatFor(src, channel);
  const store = pr.engine.drafts;
  if (!force && store.declined.has(src.id)) return { error: 'you declined a draft of this earlier; pass --force to draft it again' };
  if (store.existsFor(src.id, channel, format)) return { error: 'a draft for this already exists' };
  return { src, format };
}

/** Create one draft (as a draft.create event). `story` is a storyteller text that already passed storyProblems. */
export function createDraft(pr, id, { channel = 'x', format, origin = 'manual', force = false, mode, story } = {}) {
  const g = gate(pr, id, { channel, format, force });
  if (g.error) return g;
  const { src } = g; format = g.format;
  const c = compose(pr, src, channel, format);
  if (!c) return { error: 'nothing to say about this one' };
  const opts = redactOpts(pr);
  const st = story && { ...story, text: redact(story.text, opts).text, title: redact(story.title, opts).text };
  const last = redact(st ? st.text : c.text, opts);
  const red = { report: [...(st ? [] : c.report), ...last.report] };
  const draft = ulid();
  const top = src.type === 'arc' ? src.ms.slice().sort((a, b) => b.score - a.score)[0] : src.m;
  const card = ['short', 'linkedin', 'thread', 'long'].includes(format) ? cardFor(pr, top, channel, draft) : null;
  const sid = top.sid;
  writeHumanEvent(pr.root, 'draft.create', {
    draft, source: { type: src.type, id: src.id, moments: src.ms.map((m) => m.id) }, channel, format, text: st ? st.text : c.text, title: st ? st.title : c.title,
    claims: { refs: st ? st.refs : c.refs, extra: c.extra }, redaction: { count: red.report.length, summary: Object.entries(red.report.reduce((a, r) => (a[r.rule] = (a[r.rule] || 0) + 1, a), {})).map(([rule, n]) => ({ rule, n })), items: red.report.slice(0, 20) },
    card, origin, score: top.score, kind: top.kind, voice_rev: c.voiceRev, mode: mode || modeFor(pr, top.kind, channel), writer: st ? st.writer : 'template',
  }, { sid, actor: 'cts' });
  pr.sync();
  return { id: draft };
}

// The storyteller: the same draft told by a model as a story, through the user's Claude Code login or API key. It only
// sees redacted, consent-filtered material, and its text is kept only if storyProblems finds nothing; else the template stays.
export const STORY_RULES = `You are the CTS storyteller. You write one post in the author's own voice, first person, about what happened in their coding sessions.
Tell it as a story a peer would read: what I was trying to do, what got in the way, what I decided and why. The tone is like
"I decided to do X instead of Y, because it seems like a better solution for now" or "I skipped the suggested Q and went with W instead. Will fix it later."
The material is the log: prompts, agent messages and actions. It is what you tell the story from, not what you show.
The post is about the listed moments ("what" says what each one was); the events before a moment are background that explains it.
HARD RULES (a validator rejects violations):
- Never quote. No quotation marks, no prompts or messages repeated word for word, no commands, code, flags, file names, paths, branch names, test names or error messages. Say in plain words what they were.
- Never name a person, a company or the project. Masked text such as [repo], [path] or [masked] stays out entirely; never guess what it was.
- Every number you write must appear in the material. One number at most per post.
- A reason, cause, outcome or lesson must be stated in the material, by me or by an agent. If none is, tell what happened and leave the why out. Never invent drama.
- Stay within max_characters for each post. For a thread, write 2 to 8 posts separated by a line with only --- on it.
- For an article, write Markdown paragraphs (## headings allowed), no front matter.
- Write as the author: the agents are my tools, so what my session did is what I did, unless an agent's part is the point.
- No filler and no drama the material does not show ("back to the drawing board", "what a day"), and never write about the material itself or how little it says. If there is little to tell, write one or two plain sentences.
Follow the voice profile when it has one. Reply with ONLY a JSON object: {"title":"<a short title, no quotes>","text":"<the post>"}`;

const ctxEvent = (pr, e) => {
  const c = consentEvent(pr, e), d = c.d || {};
  if (c.kind === 'prompt') return { type: 'prompt', who: c.actor, text: trunc(d.text, 600) };
  if (c.kind === 'turn.end' || c.kind === 'subagent.stop') return { type: 'agent said', who: c.actor, text: trunc(d.last, 600) };
  const o = { type: 'action', who: c.actor, text: trunc(summarize(c), 200) };
  if (c.kind === 'tool.fail' || (d.test && d.test.red)) { const r = errLine(d.out); if (r) o.result = r; }
  return o;
};
const HOUR = 3600000;

/** The packet a storyteller reads: per moment, the prompts before it, its own events and what the agents said right after. */
export function storyPacket(pr, src, c, channel, format) {
  const voice = loadVoice(pr.root), v = voice.for(channel);
  const limit = Math.min(v.max || Infinity, ((pr.cfg.publishing.channels || {})[channel] || {}).limit || Infinity);
  const seen = new Set();
  const once = (e) => e && !seen.has(e.id) && seen.add(e.id);
  const moments = c.ms.slice(0, 8).map((m) => {
    const ids = m.span.ids.length > 12 ? [...m.span.ids.slice(0, 6), ...m.span.ids.slice(-6)] : m.span.ids;
    // What led up to it: the session's last prompts and agent reports in the 3 hours before. A moment from `cts import git`
    // has no session of its own, so it reads every session in that window.
    const S = pr.engine.sessions.get(m.sid), sid = S && S.events > 5 ? m.sid : undefined;
    const lead = (kinds, limit) => pr.events({ sid, kinds, actors: ['human', 'main'], from: m.t0 - 3 * HOUR, to: m.t0 - 1, limit });
    const evs = [
      ...lead(['prompt'], 3), ...lead(['turn.end'], 2).filter((e) => e.d.last && e.d.last.length > 200),
      ...ids.map((x) => pr.eventById(x)),
      ...pr.events({ sid: m.sid, kinds: ['turn.end', 'subagent.stop'], from: m.t0, to: m.t1 + 10 * MIN, limit: 3, order: 'asc' }),
    ].filter(once);
    return { kind: m.kind, when: new Date(m.t0).toISOString().slice(0, 16), what: beat(pr, m).lines, events: evs.map((e) => ctxEvent(pr, e)) };
  });
  const material = redactDeep(moments, redactOpts(pr)).value;
  const user = JSON.stringify({
    channel, format: format === 'long' ? 'article' : format, max_characters: Number.isFinite(limit) ? limit : null,
    voice_profile: trunc(voice.text, 3000) || null, plain_draft: c.text, moments: material,
  });
  const verbatim = material.flatMap((m) => m.events.filter((e) => e.type !== 'agent said').flatMap((e) => [e.text, e.result || '']));
  return { system: STORY_RULES, user, refs: [...new Set([...c.refs, ...seen])].slice(0, 300), verbatim, limit };
}

const words = (s) => String(s).toLowerCase().match(/[a-z0-9']+/g) || [];
/** Why a storyteller text cannot be used, as a list (empty = usable). */
export function storyProblems(pr, text, { refs = [], extra = [], verbatim = [], limit = Infinity, format = 'short' } = {}) {
  const t = String(text || '').trim().replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  if (t.length < 20) return ['the story is empty'];
  const p = [];
  const plain = (format === 'thread' ? postsOf(t) : [t]).map((x) => x.replace(/^\d+\/\d+\s/, '')).join('\n');
  if (/[“”"`]/.test(t)) p.push('it quotes or shows code; tell it in plain words');
  if (/\[(?:repo|path|masked|redacted|url|internal-url|email|host|ip)\]|\[prompt withheld/.test(t)) p.push('it uses a masked placeholder');
  if (/(?:^|\s)--?[a-z][\w-]*|\b[\w-]+\.(?:[mc]js|jsx|tsx?|py|json|md|ya?ml|sh|toml|css|html|lock)\b|\b(?!(?:node|next|vue|nuxt|deno|three)\.js\b)[\w-]+\.js\b|\b[\w.-]+\/[\w.-]+\/[\w.-]+/i.test(plain)) p.push('it names a command flag, a file or a path');
  if (Number.isFinite(limit) && (format === 'thread' ? postsOf(t) : [t]).some((x) => x.length > limit)) p.push(`a post is longer than ${limit} characters`);
  const grams = new Set();
  for (const s of verbatim) { const w = words(s); for (let i = 0; i + 6 <= w.length; i++) grams.add(w.slice(i, i + 6).join(' ')); }
  const w = words(plain);
  for (let i = 0; i + 6 <= w.length; i++) if (grams.has(w.slice(i, i + 6).join(' '))) { p.push('it repeats a prompt or a command word for word'); break; }
  const pm = claimProblems(plain, refs.map((id) => pr.eventById(id)).filter(Boolean), { extra, voiceText: loadVoice(pr.root).text });
  if (pm) p.push(pm);
  return p;
}

/** Put the storyteller's answer in the draft's shape: thread numbering, article front matter. */
// A story over the limit loses whole sentences from the end, never words from the middle.
const fitSentences = (t, limit) => {
  if (!Number.isFinite(limit) || t.length <= limit) return t;
  let o = '';
  for (const s of t.match(/[^.!?]+(?:[.!?]+|$)\s*/g) || []) { if ((o + s).trim().length > limit) break; o += s; }
  return o.trim() || t;
};
function shapeStory(a, c, format, limit) {
  let text = String(a.text || '').trim();
  if (format === 'short' || format === 'linkedin') text = fitSentences(text, limit);
  const title = String(a.title || '').replace(/["“”]/g, '').trim().slice(0, 100) || c.title;
  if (format === 'thread') { const ps = postsOf(text).map((x) => x.replace(/^\d+\/\d+\s+/, '')); text = ps.map((x, i) => `${i + 1}/${ps.length} ` + fitSentences(x, limit - `${i + 1}/${ps.length} `.length)).join(POST_SEP); }
  if (format === 'long') { const fm = (/^---\n[\s\S]*?\n---\n/.exec(c.text) || [''])[0].replace(/^title: .*$/m, `title: "${title}"`); text = fm + '\n' + text.replace(/^---\n[\s\S]*?\n---\n/, '') + '\n'; }
  return { text, title };
}

/**
 * Draft through the storyteller. One repair round if the validator objects; if the story still fails (or the model call
 * does), the template draft is written instead and `fallback` says why. `ask(system, user)` returns the reply text.
 */
export async function writeStory(pr, id, { channel = 'x', format, via = 'claude', model, ask, force = false, origin = 'manual', mode } = {}) {
  const g = gate(pr, id, { channel, format, force });
  if (g.error) return g;
  format = g.format;
  const c = compose(pr, g.src, channel, format);
  if (!c) return { error: 'nothing to say about this one' };
  const pk = storyPacket(pr, g.src, c, channel, format);
  model = model || pr.cfg.drafts.model || 'claude-sonnet-5-5';
  ask = ask || (via === 'api' ? (s, u) => askApi(s, u, { model }) : (s, u) => askClaude(s, u, { model }));
  const opts = redactOpts(pr);
  const check = (a) => { const s = shapeStory(a, c, format, pk.limit); return { s, probs: storyProblems(pr, redact(s.text, opts).text, { ...pk, extra: c.extra, format }) }; };
  let why;
  try {
    let r = check(parseAnswer(await ask(pk.system, pk.user)));
    if (r.probs.length) r = check(parseAnswer(await ask(pk.system, `${pk.user}\n\nThe validator rejected your story:\n${r.probs.map((x) => '- ' + x).join('\n')}\nWrite it again and follow every rule. Reply with the JSON object only.`)));
    if (!r.probs.length) return { ...createDraft(pr, id, { channel, format, force, origin, mode, story: { ...r.s, refs: pk.refs, writer: via } }), writer: via };
    why = r.probs.join('; ');
  } catch (e) { why = String((e && e.message) || e); }
  return { ...createDraft(pr, id, { channel, format, force, origin, mode }), writer: 'template', fallback: why };
}

const effMin = (pr, kind) => {
  const base = pr.cfg.drafts.min;
  let n = 0;
  for (const x of pr.engine.drafts.drafts.values()) if (x.status === 'declined' && x.kind === kind) n++;
  return base + Math.min(20, 5 * n);   // each decline of a kind raises its autopilot bar by 5 points (max +20)
};

/** Autopilot: draft what the user's rules say to draft. Runs in the server tick or `cts draft auto`; never in a hook. */
/** What the autopilot rules want drafted: [{ id, channel }]. Already-drafted and declined sources are filtered by the gate. */
export function autoWanted(pr, now = Date.now()) {
  const out = [];
  if (pr.cfg.private) return out;
  const e = pr.engine, D = pr.cfg.drafts;
  const fresh = (t) => now - t <= D.expireDays * DAY;
  for (const m of e.listMoments()) {
    if (m.demo || m.status === 'dismissed' || m.status === 'merged' || m.status === 'dropped' || !fresh(m.t1)) continue;
    const wanted = m.status === 'confirmed' || m.kind === 'mark' || (D.kinds.includes(m.kind) && m.score >= effMin(pr, m.kind));
    if (wanted) for (const ch of D.channels) out.push({ id: m.id, channel: ch });
  }
  for (const a of e.arcs()) {
    if (a.demo || !fresh(a.t1)) continue;
    if (a.status === 'closed' && a.moments.length > 1 && a.score >= effMin(pr, e.moments.get(a.outcome).kind)) for (const ch of D.arcChannels) out.push({ id: 'arc:' + a.id, channel: ch });
    else if (a.status === 'unfinished' && a.score >= D.min) for (const ch of D.channels) out.push({ id: 'arc:' + a.id, channel: ch });
  }
  return out;
}
export function autoDrafts(pr, now = Date.now()) {
  const made = [];
  for (const w of autoWanted(pr, now)) { const r = createDraft(pr, w.id, { channel: w.channel, origin: 'autopilot' }); if (r.id) made.push(r.id); }
  for (const id of made) maybeAutoApprove(pr, id);
  return made;
}
/** Autopilot with "drafts.writer": "claude" | "api": one storyteller call at a time, the template when it fails. */
export async function autoStories(pr, { via = pr.cfg.drafts.writer, ask, now = Date.now() } = {}) {
  const made = [];
  for (const w of autoWanted(pr, now)) {
    if (gate(pr, w.id, { channel: w.channel }).error) continue;
    const r = await writeStory(pr, w.id, { channel: w.channel, via, ask, origin: 'autopilot' });
    if (r.id) { made.push(r.id); maybeAutoApprove(pr, r.id); }
  }
  return made;
}

/** mode:auto drafts are approved by rule, but only if the guard and the redaction report are both clean. */
export function maybeAutoApprove(pr, id) {
  const x = pr.engine.drafts.get(id);
  if (!x || x.status !== 'pending' || x.mode !== 'auto') return false;
  const chk = checkDraft(pr, x);
  const D = pr.cfg.drafts;
  if (!chk.ok || !chk.redactionClean || x.score < effMin(pr, x.kind)) return false;
  approve(pr, id, { via: 'autopilot', rule: `${x.kind}:${x.channel}` });
  return true;
}

export function approve(pr, id, { at, via = 'human', rule } = {}) {
  const x = pr.engine.drafts.get(id);
  if (!x) return { error: 'no such draft' };
  if (!['pending', 'approved'].includes(x.status)) return { error: `draft is ${x.status}` };
  if (pr.engine.drafts.statusOf(x) === 'expired') return { error: 'draft expired; ask for a fresh one with cts draft --force' };
  writeHumanEvent(pr.root, 'draft.approve', { draft: x.id, via, rule: rule || null, at: at || null, text_hash: textHash(x.text) }, { sid: x.sid, actor: via === 'autopilot' ? 'autopilot' : 'human' });
  pr.sync();
  return { id: x.id };
}
export function decline(pr, id, reason = '') {
  const x = pr.engine.drafts.get(id);
  if (!x) return { error: 'no such draft' };
  writeHumanEvent(pr.root, 'draft.decline', { draft: x.id, reason: trunc(reason, 300) }, { sid: x.sid, actor: 'human' });
  pr.sync();
  return { id: x.id };
}
export function edit(pr, id, text) {
  const x = pr.engine.drafts.get(id);
  if (!x) return { error: 'no such draft' };
  if (['published', 'declined'].includes(x.status)) return { error: `draft is ${x.status}` };
  if (typeof text !== 'string' || !text.trim()) return { error: 'empty text' };
  const oldLen = x.text.length;
  const red = redact(text, redactOpts(pr));
  const words = (s) => new Set((String(s).toLowerCase().match(/[a-z][a-z'-]{3,}/g) || []));
  const had = words(x.text), now = words(red.text);
  const removed = [...had].filter((w) => !now.has(w)).slice(0, 20);
  writeHumanEvent(pr.root, 'draft.edit', {
    draft: x.id, text: red.text, removed,
    redaction: { count: red.report.length, summary: Object.entries(red.report.reduce((a, r) => (a[r.rule] = (a[r.rule] || 0) + 1, a), {})).map(([rule, n]) => ({ rule, n })), items: red.report.slice(0, 20) },
  }, { sid: x.sid, actor: 'human' });
  pr.sync();
  const sug = suggestFromEdit(pr, x.id, oldLen);
  return { id: x.id, text: red.text, suggestions: sug };
}

/** Offer a voice change, exactly once per distinct (key, value), never for something already in the profile or rejected. */
export function suggestFromEdit(pr, id, oldLen) {
  const x = pr.engine.drafts.get(id); const store = pr.engine.drafts;
  const voice = loadVoice(pr.root);
  const out = [];
  const offer = (key, value, why) => {
    const sid = suggestionId(key, value);
    if (store.suggestions.has(sid)) return;
    writeHumanEvent(pr.root, 'voice.suggest', { id: sid, key, value: String(value), why, draft: x.id }, { sid: x.sid, actor: 'cts' });
    out.push({ id: sid, key, value: String(value), why });
  };
  if (x.text.length <= oldLen * 0.8 && postsOf(x.text).length === 1) {
    const v = Math.max(40, Math.ceil(x.text.length / 10) * 10);
    const cur = voice.for(x.channel).max;
    if (!cur || v < cur) offer(`${x.channel}.max`, v, `you shortened this ${x.channel} draft from ${oldLen} to ${x.text.length} characters`);
  }
  for (const [w, ids] of store.removals) if (ids.size >= 2 && !voice.never.includes(w)) offer('never', w, `you deleted "${w}" from ${ids.size} different drafts`);
  if (out.length) pr.sync();
  return out;
}

export function counts(pr) {
  const l = pr.engine.drafts.list();
  const by = {};
  for (const x of l) by[x.status] = (by[x.status] || 0) + 1;
  return by;
}
export const nextSlot = (cad = { days: [1, 2, 3, 4, 5], time: '09:00' }, now = Date.now()) => {
  const [hh, mm] = String(cad.time || '09:00').split(':').map(Number);
  for (let i = 0; i < 9; i++) {
    const d = new Date(now); d.setDate(d.getDate() + i); d.setHours(hh, mm || 0, 0, 0);
    if (d.getTime() > now && (cad.days || [1, 2, 3, 4, 5]).includes(d.getDay())) return d.getTime();
  }
  return now + DAY;
};
