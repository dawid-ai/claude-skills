// CTS dashboard: one static bundle, no framework, no build step. Everything renders from the same log via /api + SSE.
const $ = (s, r = document) => r.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};

const KINDS = ['fight', 'reversal', 'disagreement', 'shipped', 'broke', 'pivot', 'memory-cut', 'refusal', 'wait', 'escalation', 'mark', 'theory', 'workaround', 'learned'];
const STRUGGLE_NOT = new Set(['shipped']);
const VIEWS = [['live', 'Live'], ['story', 'Story'], ['threads', 'Threads'], ['sessions', 'Sessions'], ['drafts', 'Drafts'], ['settings', 'Settings']];
const GLYPH = { thinking: '◐', running: '▶', waiting: '⏸', done: '✓', failed: '✕' };

const S = {
  moments: new Map(), threads: new Map(), arcs: [], sessions: [], header: null, summary: null, threshold: 50, root: '',
  drafts: null, settings: null, sChanges: {}, events: new Map(), sid: null, sel: null, seen: new Set(), limit: 400, stick: true, newBelow: 0, activity: null, results: null, connected: false, loaded: false,
};

// ---------- URL state ----------
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [view, qs = ''] = raw.split('?');
  const p = new URLSearchParams(qs);
  const list = (k) => (p.get(k) ? p.get(k).split(',').filter(Boolean) : []);
  return {
    view: VIEWS.some(([v]) => v === view) ? view : 'live',
    sid: p.get('sid') || '', hide: new Set(list('hide')), kinds: new Set(list('kinds')), min: p.has('min') ? +p.get('min') : null,
    q: p.get('q') || '', struggle: p.get('struggle') === '1', all: p.get('all') === '1', from: +p.get('from') || 0, to: +p.get('to') || 0,
  };
}
let F = parseHash();
function setF(patch) {
  const n = { ...F, ...patch };
  const p = new URLSearchParams();
  if (n.sid) p.set('sid', n.sid);
  if (n.hide.size) p.set('hide', [...n.hide].join(','));
  if (n.kinds.size) p.set('kinds', [...n.kinds].join(','));
  if (n.min != null) p.set('min', n.min);
  if (n.q) p.set('q', n.q);
  if (n.struggle) p.set('struggle', '1');
  if (n.all) p.set('all', '1');
  if (n.from) p.set('from', n.from);
  if (n.to) p.set('to', n.to);
  const s = p.toString();
  location.hash = `/${n.view}${s ? '?' + s : ''}`;
}
window.addEventListener('hashchange', () => { const prevSid = F.sid; F = parseHash(); if (F.sid !== prevSid) loadSession(); schedule(); });

// ---------- helpers ----------
const minScore = () => (F.all ? 0 : F.min ?? S.threshold);
const fmtT = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const fmtD = (t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
const fmtDT = (t) => `${fmtD(t)} ${fmtT(t).slice(0, 5)}`;
const dur = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? '<1 min' : m < 90 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`; };
const trunc = (x, n) => (String(x).length > n ? String(x).slice(0, n - 1) + '…' : String(x));
const ago = (ms) => dur(ms);
const ageOf = (t) => { const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 60 ? [m, 'min'] : m < 2880 ? [Math.round(m / 60), 'hours'] : [Math.round(m / 1440), 'days']; };
const sessionOf = (sid) => S.sessions.find((s) => s.sid === sid);
// A pipeline can run dozens of subagents of one type. Three or more of a type share one lane ("researcher ×58"),
// so lanes stay readable; the lane, its chip and its filter act on the whole group.
const GROUP_AT = 3;
const laneCache = new Map();
function lanesOf(sid) {
  const s = sessionOf(sid);
  const raw = s ? s.actors : [{ id: 'human', label: 'You' }, { id: 'main', label: 'main' }];
  const key = sid + ':' + raw.length;
  if (laneCache.has(key)) return laneCache.get(key);
  const typeOf = (a) => a.agent_type || a.label;
  const count = new Map();
  for (const a of raw) if (a.id.startsWith('agent:')) count.set(typeOf(a), (count.get(typeOf(a)) || 0) + 1);
  const lanes = [], of = new Map(), groups = new Map();
  for (const a of raw) {
    if (!a.id.startsWith('agent:') || count.get(typeOf(a)) < GROUP_AT) { lanes.push(a); of.set(a.id, a.id); continue; }
    const gid = 'group:' + typeOf(a);
    if (!groups.has(gid)) { const g = { id: gid, label: `${typeOf(a)} ×${count.get(typeOf(a))}`, type: 'group', members: [] }; groups.set(gid, g); lanes.push(g); }
    groups.get(gid).members.push(a.id); of.set(a.id, gid);
  }
  const r = { lanes, of };
  laneCache.set(key, r);
  return r;
}
function actorsOf(sid) { return lanesOf(sid).lanes; }
/** The lane an actor is drawn in: itself, or its type's group. */
const laneId = (sid, id) => lanesOf(sid).of.get(id) || id;
const label = (sid, id) => {
  const a = actorsOf(sid).find((x) => x.id === id) || S.sessions.flatMap((x) => x.actors).find((x) => x.id === id);
  return a ? a.label : id.replace('agent:', '').slice(0, 8);
};
function laneColor(sid, id) {
  if (id === 'human') return 'var(--human)';
  if (id === 'main') return 'var(--l1)';
  const lane = laneId(sid, id);
  const subs = actorsOf(sid).filter((a) => a.id !== 'human' && a.id !== 'main');
  return `var(--l${2 + (Math.max(0, subs.findIndex((a) => a.id === lane)) % 5)})`;
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 1800); }
async function api(path, opts) { const r = await fetch(path, opts); if (!r.ok) throw Object.assign(new Error(r.statusText), { status: r.status, body: await r.json().catch(() => ({})) }); return r.json(); }
async function act(type, data = {}, sid) {
  try { await api('/api/action', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cts': '1' }, body: JSON.stringify({ type, data, sid: sid || S.sid || undefined }) }); toast({ confirm: 'Confirmed as a moment', dismiss: 'Dismissed', mark: 'Marked', merge: 'Merged', 'thread-close': 'Thread closed', rescore: 'Re-scored' }[type] || 'Done'); }
  catch (e) { toast('Action failed: ' + e.message); }
}

// ---------- data ----------
async function loadState() {
  const st = await api('/api/state');
  S.moments = new Map(st.moments.map((m) => [m.id, m]));
  S.threads = new Map(st.threads.map((t) => [t.id, t]));
  S.arcs = st.arcs; S.sessions = st.sessions; S.header = st.header; S.summary = st.summary; S.threshold = st.threshold; S.root = st.root;
  $('#proj').textContent = '· ' + st.root;
  document.title = `CTS — ${st.root}`;
  await loadSession();
  S.loaded = true;
  api('/api/drafts').then((d) => { S.drafts = d; schedule(); }).catch(() => {});
  schedule();
}
async function loadSession() {
  const sid = F.sid || (S.header && S.header.sid) || (S.sessions.length ? S.sessions[S.sessions.length - 1].sid : '');
  if (S.sid !== sid) { S.events = new Map(); S.seen = new Set(); S.limit = 400; S.stick = true; }
  S.sid = sid;
  if (!sid) return;
  const r = await api(`/api/events?sid=${encodeURIComponent(sid)}&limit=1500&order=desc`);
  for (const e of r.events) S.events.set(e.id, e);
  S.hasMore = r.events.length >= 1500;
  schedule();
}
async function loadEarlier() {
  const first = [...S.events.values()].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
  S.limit += 400;
  if (first && S.hasMore) {
    const r = await api(`/api/events?sid=${encodeURIComponent(S.sid)}&limit=1500&before=${first.id}&order=desc`);
    for (const e of r.events) S.events.set(e.id, e);
    S.hasMore = r.events.length >= 1500;
  }
  schedule();
}

function connect() {
  const es = new EventSource('/api/stream');
  const set = (on) => { S.connected = on; const c = $('#conn'); c.className = 'conn ' + (on ? 'on' : 'off'); c.lastChild.textContent = on ? 'live' : 'reconnecting'; };
  es.onopen = () => { set(true); if (S.loaded) loadState().catch(() => {}); };
  es.onerror = () => set(false);
  es.addEventListener('drafts', (ev) => { S.drafts = JSON.parse(ev.data); schedule(); });
  es.addEventListener('reload', () => { loadState().catch(() => {}); if (F.view === 'settings' && !Object.keys(S.sChanges).length) loadSettings(); });
  es.addEventListener('batch', (ev) => {
    const b = JSON.parse(ev.data);
    for (const m of b.moments) S.moments.set(m.id, m);
    for (const t of b.threads) S.threads.set(t.id, t);
    for (const s of b.sessions) { const i = S.sessions.findIndex((x) => x.sid === s.sid); if (i >= 0) S.sessions[i] = s; else S.sessions.push(s); }
    S.sessions.sort((a, b) => a.start - b.start);
    if (b.arcs) S.arcs = b.arcs;
    S.header = b.header; S.summary = b.summary;
    const follow = !F.sid && b.header && b.header.sid !== S.sid;
    if (follow) { loadSession(); return; }
    let added = 0;
    for (const e of b.events) if (e.sid === S.sid && !S.events.has(e.id)) { S.events.set(e.id, e); added++; }
    if (added && !S.stick) S.newBelow += added;
    schedule();
  });
}

// ---------- filters ----------
function passMoment(m) {
  if (m.score < minScore() || m.status === 'merged') return false;
  if (F.kinds.size && !F.kinds.has(m.kind)) return false;
  if (m.actors.length && m.actors.every((a) => F.hide.has(laneId(m.sid, a)))) return false;
  if (F.struggle && STRUGGLE_NOT.has(m.kind)) return false;
  if (F.from && m.t1 < F.from) return false;
  if (F.to && m.t0 > F.to) return false;
  if (F.q) { const q = F.q.toLowerCase(); if (!(m.headline + ' ' + m.body.join(' ') + ' ' + JSON.stringify(m.evidence)).toLowerCase().includes(q)) return false; }
  return true;
}
function passEvent(e) {
  if (F.hide.has(laneId(e.sid, e.actor))) return false;
  if (F.from && e.t < F.from) return false;
  if (F.to && e.t > F.to) return false;
  if (F.struggle && e.kind === 'tool.post' && !(e.d.test && e.d.test.red)) return false;
  if (F.q && !e.sum.toLowerCase().includes(F.q.toLowerCase())) return false;
  return true;
}

// ---------- render scheduling ----------
let raf = 0;
function schedule() { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; render(); }); }

function render() {
  renderTabs(); renderStrip(); renderFilters();
  const main = $('#main');
  const keep = main.querySelector('.lanewrap');
  const scroll = keep ? { top: keep.scrollTop, left: keep.scrollLeft } : null;
  main.replaceChildren();
  if (!S.loaded) { main.append(h('div', { class: 'empty' }, h('b', {}, 'Loading the project log…'))); return; }
  ({ live: viewLive, story: viewStory, threads: viewThreads, sessions: viewSessions, drafts: viewDrafts, settings: viewSettings }[F.view])(main, scroll);
}

function renderTabs() {
  const nav = $('#tabs');
  const openN = [...S.threads.values()].filter((t) => !t.closed).length;
  nav.replaceChildren(...VIEWS.map(([v, name]) => h('a', { href: `#/${v}${location.hash.includes('?') ? '?' + location.hash.split('?')[1] : ''}`, 'aria-current': F.view === v ? 'page' : null }, name, v === 'threads' ? h('span', { class: 'n' }, openN) : v === 'drafts' && S.drafts && S.drafts.counts.pending ? h('span', { class: 'n' }, S.drafts.counts.pending) : null)));
}

function renderStrip() {
  const strip = $('#strip');
  const hd = S.header && (S.sid === S.header.sid ? S.header : null);
  const sess = sessionOf(S.sid);
  const start = sess ? sess.start : 0;
  const live = hd && !hd.ended && Date.now() - hd.end < 15 * 60000;
  const openN = [...S.threads.values()].filter((t) => !t.closed).length;
  const kv = (k, v, id) => h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('b', { id }, v));
  strip.replaceChildren(
    kv('session', start ? clock(start, live ? Date.now() : sess.end) : '—', 'clock'),
    kv('model', (hd && hd.model) || (sess && sess.model) || '—'),
    kv('events', (sess ? sess.events : 0).toLocaleString()),
    kv('moments', [...S.moments.values()].filter((m) => m.score >= S.threshold).length),
    kv('open threads', openN),
    h('div', { class: 'actors-now', role: 'list' }, stripActors(hd).map((a) =>
      h('span', { class: 'who', role: 'listitem' }, h('span', { class: `g g-${a.status ? a.status.glyph : 'done'}`, 'aria-hidden': 'true' }, GLYPH[a.status ? a.status.glyph : 'done']),
        h('span', { class: 'nm', style: `color:${laneColor(S.sid, a.id)}` }, a.label), h('span', { class: 'tx' }, a.status ? a.status.text : 'idle')))),
  );
  strip.dataset.live = live ? '1' : '';
}
function stripActors(hd) {
  const list = (hd ? hd.actors : actorsOf(S.sid).map((a) => ({ ...a, status: null }))).filter((a) => a.type !== 'human' && a.type !== 'caller');
  const out = [], groups = new Map();
  for (const a of list) {
    const lane = laneId(S.sid, a.id);
    if (lane === a.id) { out.push(a); continue; }
    if (!groups.has(lane)) { const g = { id: lane, label: actorsOf(S.sid).find((x) => x.id === lane).label, n: {}, status: null }; groups.set(lane, g); out.push(g); }
    const g = groups.get(lane), glyph = a.status ? a.status.glyph : 'done';
    g.n[glyph] = (g.n[glyph] || 0) + 1;
  }
  for (const g of groups.values()) {
    const order = ['running', 'thinking', 'waiting', 'failed', 'done'];
    const glyph = order.find((k) => g.n[k]) || 'done';
    g.status = { glyph, text: order.filter((k) => g.n[k]).map((k) => `${g.n[k]} ${k === 'done' ? 'finished' : k}`).join(' · ') };
  }
  return out;
}
function clock(a, b) { const s = Math.max(0, Math.round((b - a) / 1000)); const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60; return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`; }
setInterval(() => { const c = $('#clock'); const s = sessionOf(S.sid); if (c && s && $('#strip').dataset.live) c.textContent = clock(s.start, Date.now()); }, 1000);

function chip(text, pressed, onclick, color, title) {
  return h('button', { class: 'chip', type: 'button', 'aria-pressed': String(pressed), onclick, style: color ? `--c:${color}` : null, title }, color ? h('i') : null, text);
}
const phone = window.matchMedia('(max-width:640px)');
function renderFilters() {
  const f = $('#filters');
  const off = F.view === 'drafts' || F.view === 'settings'; f.style.display = off ? 'none' : ''; $('#ftoggle').style.display = off ? 'none' : '';
  if (off) return;
  if (S.filtersOpen === undefined) S.filtersOpen = !phone.matches;
  f.classList.toggle('collapsed', !S.filtersOpen);
  const ft = $('#ftoggle'); ft.setAttribute('aria-expanded', String(S.filtersOpen));
  const acts = actorsOf(S.sid);
  const toggleSet = (set, v) => { const n = new Set(set); n.has(v) ? n.delete(v) : n.add(v); return n; };
  const sessSel = h('select', { 'aria-label': 'Session', onchange: (e) => setF({ sid: e.target.value === (S.header && S.header.sid) ? '' : e.target.value, from: 0, to: 0 }) },
    ...S.sessions.slice().reverse().map((s) => h('option', { value: s.sid, selected: s.sid === S.sid }, `${fmtDT(s.start)} · ${s.events} ev${s.demo ? ' · demo' : ''}${s.headless ? ' · claude -p' : ''}`)));
  const q = h('input', { type: 'search', id: 'q', placeholder: 'Search prompts, commands, headlines  (/)', value: F.q, 'aria-label': 'Search', onkeydown: (e) => { if (e.key === 'Enter') setF({ q: e.target.value.trim() }); }, onchange: (e) => setF({ q: e.target.value.trim() }) });
  const slider = h('input', { type: 'range', min: 0, max: 100, step: 5, value: minScore(), 'aria-label': 'Minimum score', oninput: (e) => { e.target.nextSibling.textContent = e.target.value; }, onchange: (e) => setF({ min: +e.target.value, all: false }) });
  f.replaceChildren(...[
    F.view === 'live' ? h('div', { class: 'grp' }, sessSel) : null,
    h('div', { class: 'grp', role: 'group', 'aria-label': 'Actors' }, h('label', { class: 't' }, 'Actors'), ...acts.map((a) => chip(a.label, !F.hide.has(a.id), () => setF({ hide: toggleSet(F.hide, a.id) }), laneColor(S.sid, a.id)))),
    h('div', { class: 'grp', role: 'group', 'aria-label': 'Moment kinds' }, h('label', { class: 't' }, 'Kinds'), ...KINDS.map((k) => chip(k, F.kinds.size === 0 || F.kinds.has(k), () => setF({ kinds: toggleSet(F.kinds.size ? F.kinds : new Set(KINDS), k).size === KINDS.length ? new Set() : toggleSet(F.kinds.size ? F.kinds : new Set(KINDS), k) }), `var(--k-${k})`))),
    h('div', { class: 'grp' }, h('label', { class: 't', for: 'minr' }, 'Score ≥'), slider, h('b', { class: 'mono' }, minScore())),
    h('label', { class: 'sw' }, h('input', { type: 'checkbox', checked: F.struggle, onchange: (e) => setF({ struggle: e.target.checked }) }), 'Struggle only'),
    h('label', { class: 'sw' }, h('input', { type: 'checkbox', checked: F.all, onchange: (e) => setF({ all: e.target.checked }) }), 'Show all events'),
    q,
    F.view === 'live' ? h('div', { id: 'brushwrap' }, h('canvas', { id: 'brush', tabindex: 0, role: 'slider', 'aria-label': 'Time range brush. Arrow keys move the window, plus and minus resize it, Escape clears.', 'aria-valuetext': F.from || F.to ? `${fmtT(F.from || 0)} to ${fmtT(F.to || 0)}` : 'whole session' })) : null,
  ].filter(Boolean));
  if (F.view === 'live') drawBrush();
}

// ---------- brush ----------
function drawBrush() {
  const cv = $('#brush'); if (!cv) return;
  const sess = sessionOf(S.sid); if (!sess) return;
  const w = cv.clientWidth, hgt = cv.clientHeight, dpr = window.devicePixelRatio || 1;
  cv.width = w * dpr; cv.height = hgt * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const t0 = sess.start, t1 = Math.max(sess.end, t0 + 60000), span = t1 - t0;
  const css = getComputedStyle(document.documentElement);
  const bins = new Array(Math.max(20, Math.floor(w / 4))).fill(0);
  for (const e of S.events.values()) bins[Math.min(bins.length - 1, Math.floor(((e.t - t0) / span) * bins.length))]++;
  const mx = Math.max(1, ...bins);
  g.fillStyle = css.getPropertyValue('--mut'); g.globalAlpha = 0.5;
  bins.forEach((n, i) => { const bh = (n / mx) * (hgt - 8); g.fillRect((i / bins.length) * w, hgt - bh - 2, w / bins.length - 1, bh); });
  g.globalAlpha = 1;
  for (const m of S.moments.values()) if (m.sid === S.sid && m.score >= S.threshold) { g.fillStyle = css.getPropertyValue(`--k-${m.kind}`) || '#d60'; g.fillRect(((m.t0 - t0) / span) * w - 1, 2, 3, 8); }
  if (F.from || F.to) {
    const a = ((F.from || t0) - t0) / span * w, b = ((F.to || t1) - t0) / span * w;
    g.fillStyle = css.getPropertyValue('--human'); g.globalAlpha = 0.22; g.fillRect(a, 0, b - a, hgt); g.globalAlpha = 1; g.fillRect(a, 0, 2, hgt); g.fillRect(b - 2, 0, 2, hgt);
  }
  let drag = null;
  const tAt = (ev) => { const r = cv.getBoundingClientRect(); return t0 + Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * span; };
  cv.onpointerdown = (ev) => { cv.setPointerCapture(ev.pointerId); drag = tAt(ev); };
  cv.onpointermove = (ev) => { if (drag == null) return; const t = tAt(ev); F = { ...F, from: Math.round(Math.min(drag, t)), to: Math.round(Math.max(drag, t)) }; schedule(); };
  cv.onpointerup = (ev) => { if (drag == null) return; const t = tAt(ev); const a = Math.min(drag, t), b = Math.max(drag, t); drag = null; if (b - a < span * 0.01) setF({ from: 0, to: 0 }); else setF({ from: Math.round(a), to: Math.round(b) }); };
  cv.onkeydown = (ev) => {
    const a = F.from || t0, b = F.to || t1, wd = b - a, step = wd * 0.1;
    if (ev.key === 'ArrowLeft') setF({ from: Math.max(t0, a - step), to: Math.max(t0 + wd, b - step) });
    else if (ev.key === 'ArrowRight') setF({ from: Math.min(t1 - wd, a + step), to: Math.min(t1, b + step) });
    else if (ev.key === '-' || ev.key === '_') setF({ from: Math.max(t0, a - step), to: Math.min(t1, b + step) });
    else if (ev.key === '+' || ev.key === '=') setF({ from: a + step, to: b - step });
    else if (ev.key === 'Escape') setF({ from: 0, to: 0 });
    else return;
    ev.preventDefault();
  };
}

// ---------- moment card ----------
function cardEl(m, { inline = false } = {}) {
  const glow = Math.max(0, (m.score - 40) / 60);
  const el = h('article', {
    class: `card st-${m.status}${m.id === S.sel ? ' sel' : ''}${m.status !== 'dismissed' && S.sid === m.sid && Date.now() - m.t1 < 45000 && $('#strip').dataset.live ? ' pulse' : ''}`,
    style: `--c:var(--k-${m.kind});--glow:${inline ? 0 : glow.toFixed(2)}`, tabindex: -1, draggable: 'true', dataset: { id: m.id, kind: 'm' },
    'aria-label': `${m.kind} moment, score ${m.score}: ${m.headline}`,
    onclick: (e) => { if (e.target.closest('button,a')) return; S.sel = m.id; el.classList.toggle('open'); document.querySelectorAll('.sel').forEach((x) => x.classList.remove('sel')); el.classList.add('sel'); },
    ondragstart: (e) => { e.dataTransfer.setData('text/cts-moment', m.id); },
    ondragover: (e) => { if (e.dataTransfer.types.includes('text/cts-moment')) e.preventDefault(); },
    ondrop: (e) => { const from = e.dataTransfer.getData('text/cts-moment'); if (from && from !== m.id) { e.preventDefault(); act('merge', { target: from, into: m.id }, m.sid); } },
  },
  h('div', { class: 'hd' }, m.kind, h('span', {}, '· ' + m.actors.map((a) => label(m.sid, a)).join(' + ')), h('span', { class: 'score' }, `${fmtT(m.t0).slice(0, 5)} · ${m.score}`)),
  h('h3', {}, m.headline),
  m.note ? h('div', { class: 'bd' }, h('p', {}, '“' + m.note + '”')) : null,
  m.body.filter(Boolean).length ? h('div', { class: 'bd' }, m.body.filter(Boolean).slice(0, 3).map((b) => h('p', {}, b))) : null,
  evLine(m) ? h('span', { class: 'ev' }, evLine(m)) : null,
  m.posts && m.posts.length ? h('div', { class: 'told' }, 'Told on ', m.posts.map((x, i) => [i ? ', ' : '', x.url ? h('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer' }, x.channel) : x.channel])) : null,
  h('div', { class: 'more' }, moreFor(m)),
  );
  return el;
}
function evLine(m) {
  const e = m.evidence || {}; const p = [];
  if (e.attempts) p.push(`${e.attempts} attempts`);
  if (e.elapsed_ms) p.push(dur(e.elapsed_ms));
  if (e.stat) p.push(`${e.stat.files} files +${e.stat.ins}/−${e.stat.del}`);
  if (e.counts && e.counts.total) p.push(`${e.counts.fail}/${e.counts.total} failing`);
  if (e.minutes) p.push(`${e.minutes} min`);
  return p.join(' · ');
}
function moreFor(m) {
  const e = m.evidence || {}, out = [];
  if (e.prompt) out.push(h('div', { class: 'mut' }, 'Your prompt'), h('pre', { class: 'out' }, e.prompt));
  if (e.a && e.b) out.push(h('div', { class: 'mut' }, label(m.sid, e.actors[0])), h('pre', { class: 'out' }, e.a), h('div', { class: 'mut' }, label(m.sid, e.actors[1])), h('pre', { class: 'out' }, e.b));
  if (e.error) out.push(h('div', { class: 'mut' }, 'Last error'), h('pre', { class: 'out' }, e.error));
  if (e.command && !e.error) out.push(h('pre', { class: 'out' }, e.command));
  if (e.sha) out.push(h('div', { class: 'mono mut' }, `${e.sha.slice(0, 10)} ${e.subject || ''}`));
  const th = m.thread && S.threads.get(m.thread);
  if (th) out.push(h('div', { class: 'mut' }, `Thread: ${th.text}${th.closed ? ' (closed)' : ''}`));
  const acts = h('div', { class: 'acts' },
    h('button', { class: 'btn', onclick: () => act('confirm', { target: m.id }, m.sid) }, 'Confirm', h('kbd', {}, 'm')),
    h('button', { class: 'btn', onclick: () => act('dismiss', { target: m.id }, m.sid) }, 'Dismiss', h('kbd', {}, 'x')),
    ...(m.span.ids.length ? [h('button', { class: 'btn', onclick: () => openTranscript(m.tp.length ? m.tp[0].id : m.span.first) }, 'Transcript', h('kbd', {}, 't'))] : []),
    h('button', { class: 'btn', onclick: () => showEvidence(m.id) }, 'Saved evidence'),
  );
  out.push(h('div', { class: 'mut mono', style: 'margin-top:6px' }, `${m.span.count} events · ${m.detector} · id ${m.id.slice(-10)}`), acts);
  return out;
}

// ---------- Live ----------
function viewLive(main, scroll) {
  if (F.q) return viewSearch(main);
  const sid = S.sid;
  if (!sid) return emptyState(main);
  const lanesAll = actorsOf(sid).filter((a) => !F.hide.has(a.id));
  const lanes = lanesAll.length ? lanesAll : actorsOf(sid).slice(0, 1);
  const idx = new Map(lanes.map((a, i) => [a.id, i]));
  const posts = new Set([...S.events.values()].filter((e) => e.kind === 'tool.post' || e.kind === 'tool.fail').map((e) => e.d.tool_use_id));
  const moments = [...S.moments.values()].filter((m) => m.sid === sid && passMoment(m));
  const inSpan = new Set(moments.flatMap((m) => m.span.ids));
  let evs = [...S.events.values()].filter((e) => passEvent(e) && !(e.kind === 'tool.pre' && posts.has(e.d.tool_use_id)));
  if (!F.all) evs = evs.filter((e) => inSpan.has(e.id));
  const items = [
    ...evs.map((e) => ({ t: e.t, k: 0, e })),
    ...moments.map((m) => ({ t: m.t1, k: 1, m })),
  ].sort((a, b) => a.t - b.t || a.k - b.k || ((a.e || a.m).id < (b.e || b.m).id ? -1 : 1));
  if (!items.length) {
    main.append(h('div', { class: 'empty' }, h('b', {}, 'Nothing above the score floor yet'), F.all ? 'No events match these filters.' : 'Moments appear here as they happen. Turn on “Show all events” to see every tick.'));
    return;
  }
  const shown = items.slice(-S.limit);
  const wrap = h('div', { class: 'lanewrap', id: 'lanewrap', onscroll: (e) => { const el = e.target; S.stick = el.scrollHeight - el.scrollTop - el.clientHeight < 60; if (S.stick) { S.newBelow = 0; $('.pill') && $('.pill').classList.remove('show'); } } });
  const grid = h('div', { class: 'lanes', style: `--n:${lanes.length}` });
  grid.append(h('div', { class: 'lhead spacer' }), ...lanes.map((a, i) => h('div', { class: 'lhead' + (a.id === 'human' ? ' me' : ''), style: `--lc:${laneColor(sid, a.id)}`, oncontextmenu: (e) => { e.preventDefault(); setF({ hide: new Set([...F.hide, a.id]) }); toast(`Hid lane ${a.label}. Toggle it back in Actors.`); }, title: 'Right-click to hide this lane' }, a.label, a.agent_type && a.agent_type !== a.label ? h('small', {}, a.agent_type) : null)));
  if (shown.length < items.length || S.hasMore) grid.append(h('div', { style: 'grid-column:1/-1;text-align:center' }, h('button', { class: 'btn', onclick: loadEarlier }, 'Show earlier')));
  const fresh = [];
  for (const it of shown) {
    if (it.e) {
      const e = it.e; const ln = laneId(sid, e.actor); const li = idx.has(ln) ? idx.get(ln) : Math.min(1, lanes.length - 1);
      const cls = `tick${e.kind === 'tool.fail' ? ' fail' : ''}${e.kind === 'prompt' ? ' prompt' : ''}${e.id === S.sel ? ' sel' : ''}`;
      const isNew = S.loaded && !S.seen.has(e.id) && S.seen.size > 0;
      grid.append(h('div', { class: 'tcell' + (isNew ? ' row-new' : ''), style: 'grid-column:1' }, fmtT(e.t)),
        h('div', { class: `${cls}${isNew ? ' row-new' : ''}`, style: `grid-column:${2 + li};--lc:${laneColor(sid, e.actor)}`, tabindex: -1, dataset: { id: e.id, kind: 'e' }, title: e.sum, onclick: () => { S.sel = e.id; openTranscript(e.id); } }, h('span', { class: 's' }, e.sum)));
      fresh.push(e.id);
    } else {
      const m = it.m;
      const ls = m.actors.map((a) => laneId(sid, a)).map((a) => (idx.has(a) ? idx.get(a) : -1)).filter((x) => x >= 0);
      const lo = ls.length ? Math.min(...ls) : 0, hi = ls.length ? Math.max(...ls) : Math.min(1, lanes.length - 1);
      const isNew = S.seen.size > 0 && !S.seen.has(m.id);
      const card = cardEl(m);
      if (isNew) card.classList.add('row-new');
      if (S.open && S.open.has(m.id)) card.classList.add('open');
      grid.append(h('div', { class: 'tcell', style: 'grid-column:1' }, fmtT(m.t0)), h('div', { style: `grid-column:${2 + lo} / span ${hi - lo + 1};min-width:0` }, card));
      fresh.push(m.id);
    }
  }
  wrap.append(grid);
  main.append(wrap, h('button', { class: 'pill' + (!S.stick && S.newBelow ? ' show' : ''), onclick: () => { S.stick = true; S.newBelow = 0; wrap.scrollTop = wrap.scrollHeight; $('.pill').classList.remove('show'); } }, S.newBelow ? `↓ ${S.newBelow} new · jump to now` : '↓ jump to now'));
  for (const id of fresh) S.seen.add(id);
  if (S.stick || !scroll) wrap.scrollTop = wrap.scrollHeight; else { wrap.scrollTop = scroll.top; wrap.scrollLeft = scroll.left; }
  if (!S.stick) $('.pill').classList.add('show');
}

async function viewSearch(main) {
  main.append(h('h2', { class: 'sec' }, `Search: “${F.q}”`));
  const box = h('div', { class: 'threads' }, h('div', { class: 'empty' }, 'Searching…'));
  main.append(box);
  const my = F.q;
  const r = await api(`/api/events?q=${encodeURIComponent(F.q)}&limit=200`).catch(() => ({ events: [] }));
  if (F.q !== my) return;
  const ms = [...S.moments.values()].filter((m) => passMoment({ ...m, score: 100 }) || (m.headline + m.body.join(' ')).toLowerCase().includes(my.toLowerCase())).filter((m) => (m.headline + ' ' + m.body.join(' ')).toLowerCase().includes(my.toLowerCase()));
  box.replaceChildren(
    ms.length ? h('h2', { class: 'sec' }, `Moments (${ms.length})`) : null, ...ms.map((m) => cardEl(m, { inline: true })),
    h('h2', { class: 'sec' }, `Events (${r.events.length})`),
    ...r.events.reverse().map((e) => h('div', { class: 'tick', style: `--lc:${laneColor(e.sid, e.actor)};margin:2px 0`, onclick: () => openTranscript(e.id) }, h('span', { class: 'mono' }, fmtDT(e.t)), h('span', { class: 's' }, e.sum))),
    !r.events.length && !ms.length ? h('div', { class: 'empty' }, h('b', {}, 'No matches'), 'Search covers prompts, tool inputs, commit messages, assistant messages and headlines.') : null,
  );
}

function emptyState(main) {
  main.append(h('div', { class: 'empty' }, h('b', {}, 'No sessions captured yet'), 'Start a Claude Code session in this project and events will appear here, or run ', h('code', {}, 'cts demo'), ' to load a sample session.'));
}

// ---------- Story ----------
function viewStory(main) {
  const arcs = S.arcs.map((a) => ({ ...a, ms: a.moments.map((id) => S.moments.get(id)).filter((m) => m && passMoment(m)) })).filter((a) => a.ms.length).sort((a, b) => a.t0 - b.t0);
  if (!arcs.length) { main.append(h('div', { class: 'empty' }, h('b', {}, 'No story yet'), 'Arcs appear once moments above the score floor link up. Lower “Score ≥” to see more.')); return; }
  const wrap = h('div', { class: 'story' });
  wrap.append(h('div', { class: 'pager' }, h('a', { class: 'btn', href: '/api/share/story.html', target: '_blank', rel: 'noopener' }, 'Open the redacted, shareable Story ↗')));
  arcs.forEach((a, i) => {
    const sidFor = a.ms[0].sid;
    wrap.append(h('section', { class: 'arc' },
      h('div', { class: 'kick' }, `Chapter ${i + 1}`),
      h('h3', {}, a.title),
      h('div', { class: 'meta' }, h('span', { class: 'shape' }, a.shape), h('span', {}, dur(a.duration_ms) + ' · ' + fmtD(a.t0)), h('span', {}, `${a.sessions.length} session${a.sessions.length === 1 ? '' : 's'}`), h('span', {}, a.actors.map((x) => label(sidFor, x)).join(', ')), h('span', { style: a.status === 'closed' ? 'color:var(--ok)' : '' }, a.status === 'closed' ? 'shipped' : a.status === 'unfinished' ? 'unfinished business' : 'still open')),
      h('ol', {}, a.ms.map((m) => h('li', { style: `--c:var(--k-${m.kind})` }, cardEl(m, { inline: true }))))));
  });
  main.append(wrap);
}

// ---------- Threads ----------
function viewThreads(main) {
  const all = [...S.threads.values()].filter((t) => !F.q || t.text.toLowerCase().includes(F.q.toLowerCase()));
  const open = all.filter((t) => !t.closed).sort((a, b) => a.opened_t - b.opened_t);
  const closed = all.filter((t) => t.closed).sort((a, b) => b.closed.t - a.closed.t);
  const arcOf = (mid) => S.arcs.find((a) => a.moments.includes(mid));
  const row = (t) => {
    const [n, u] = t.closed ? ageOf(t.opened_t + 0) : ageOf(t.opened_t);
    const m = t.moment && S.moments.get(t.moment); const arc = m && arcOf(m.id);
    return h('div', { class: 'th' + (t.closed ? ' closed' : '') },
      h('div', { class: 'age' }, n, h('small', {}, u)),
      h('div', {}, h('div', { class: 'txt' }, t.text),
        h('div', { class: 'sub' }, h('span', { class: 'tag' }, t.kind), h('span', {}, `opened by ${t.opened_by} · ${fmtDT(t.opened_t)}`), arc ? h('span', {}, `arc: ${arc.shape}`) : null, h('span', {}, m ? `moment: ${m.headline}` : 'no moment yet'),
          t.closed ? h('span', { style: 'color:var(--ok)' }, `closed (${t.closed.how}) by ${t.closed.by}${t.closed.text ? ': “' + t.closed.text + '”' : ''}`) : null)),
      h('div', { class: 'acts' }, t.tp ? h('button', { class: 'btn', onclick: () => openTranscript(t.id) }, 'Transcript') : null, !t.closed ? h('button', { class: 'btn', onclick: () => act('thread-close', { target: t.id }, t.sid) }, 'Close') : null));
  };
  const wrap = h('div', { class: 'threads' }, h('h2', { class: 'sec' }, `Open (${open.length})`));
  if (!open.length) wrap.append(h('div', { class: 'empty' }, h('b', {}, 'Nothing is hanging'), 'Hedged decisions (“for now”, “revisit”) and unanswered questions land here and close themselves when decided.'));
  wrap.append(...open.map(row));
  if (closed.length) wrap.append(h('details', { class: 'closed' }, h('summary', {}, `Closed (${closed.length})`), ...closed.map(row)));
  main.append(wrap);
}

// ---------- Sessions ----------
async function viewSessions(main) {
  const wrap = h('div', { class: 'sessions' });
  main.append(wrap);
  if (!S.activity) S.activity = (await api('/api/activity').catch(() => ({ days: [] }))).days;
  const byDay = new Map(S.activity.map((d) => [d.day, d.n]));
  const mx = Math.max(1, ...S.activity.map((d) => d.n));
  const end = new Date(); end.setHours(0, 0, 0, 0);
  const start = new Date(end); start.setDate(start.getDate() - (26 * 7 - 1) - ((end.getDay() + 6) % 7 - 6 + 6) % 7);
  const cells = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = d.toISOString().slice(0, 10); const n = byDay.get(key) || 0;
    cells.push(h('i', { 'data-v': n ? 1 : 0, style: `--v:${n ? (0.25 + 0.75 * Math.sqrt(n / mx)).toFixed(2) : 0}`, title: `${key}: ${n} events`, role: 'img', 'aria-label': `${key}: ${n} events` }));
  }
  const dayShift = (start.getDay() + 6) % 7;
  if (!S.projects) S.projects = (await api('/api/projects').catch(() => ({ projects: [] }))).projects;
  if (S.projects.filter((p) => !p.missing).length > 1) wrap.append(h('h2', { class: 'sec' }, 'All projects'), projectsTable(S.projects));
  wrap.append(h('h2', { class: 'sec' }, 'Activity, last 26 weeks'), h('div', { class: 'heat', style: 'min-height:110px' }, ...Array.from({ length: dayShift }, () => h('i', { style: 'visibility:hidden' })), ...cells), h('h2', { class: 'sec' }, `Sessions (${S.sessions.length})`));
  const rail = h('div', { class: 'srail' });
  const list = S.sessions.slice().reverse();
  for (const s of list) {
    const ms = [...S.moments.values()].filter((m) => m.sid === s.sid && m.score >= S.threshold && m.status !== 'dismissed').length;
    const par = s.parent && sessionOf(s.parent);
    rail.append(h('div', { class: 'sc' + (par ? ' child' : ''), id: 's-' + s.sid },
      h('div', {}, h('a', { href: `#/live?sid=${encodeURIComponent(s.sid)}` }, h('b', {}, fmtDT(s.start))), ' ', h('span', { class: 'mut' }, `${dur((s.end || s.start) - s.start)} · ${s.source || 'session'}${s.model ? ' · ' + s.model : ''}${s.demo ? ' · demo' : ''}${s.headless ? ' · claude -p' : ''}`)),
      par ? h('div', { class: 'mut' }, '↳ continues ', h('a', { href: `#/sessions`, onclick: (e) => { e.preventDefault(); document.getElementById('s-' + par.sid).scrollIntoView({ block: 'center' }); } }, fmtDT(par.start))) : null,
      h('div', { class: 'stats' }, h('span', {}, h('b', {}, s.events), ' events'), h('span', {}, h('b', {}, ms), ms === 1 ? ' moment' : ' moments'), h('span', {}, h('b', {}, s.stats.attempts), ' failed attempts'), h('span', {}, h('b', {}, s.stats.redGreen), ' red→green'), h('span', {}, h('b', {}, s.actors.length - 1), s.actors.length === 2 ? ' agent' : ' agents'))));
  }
  wrap.append(rail);
}


function projectsTable(list) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const strip = (p) => {
    const by = new Map((p.activity || []).map((d) => [d.day, d.n])); const mx = Math.max(1, ...(p.activity || []).map((d) => d.n));
    const cells = [];
    for (let i = 29; i >= 0; i--) { const d = new Date(today); d.setDate(d.getDate() - i); const k = d.toISOString().slice(0, 10); const n = by.get(k) || 0; cells.push(h('i', { 'data-v': n ? 1 : 0, style: `--v:${n ? (0.25 + 0.75 * Math.sqrt(n / mx)).toFixed(2) : 0}`, title: `${k}: ${n} events` })); }
    return h('div', { class: 'pstrip', role: 'img', 'aria-label': `${p.name}: activity over the last 30 days` }, cells);
  };
  const open = async (p) => {
    try { const r = await api('/api/project-open', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cts': '1' }, body: JSON.stringify({ root: p.root }) }); location.href = `http://localhost:${r.port}/#/sessions`; }
    catch (e) { toast((e.body && e.body.error) || 'Could not open ' + p.name); }
  };
  return h('div', { class: 'projects' }, list.filter((p) => !p.missing).map((p) => h('div', { class: 'prow' + (p.current ? ' cur' : '') },
    h('div', { class: 'pname' }, h('b', {}, p.name), h('span', { class: 'mut mono', title: p.root }, trunc(p.root, 48))),
    strip(p),
    h('div', { class: 'mut pmeta' }, `${p.sessions ?? '?'} sessions · ${p.openThreads} open`, p.pendingDrafts ? ` · ${p.pendingDrafts} drafts` : '', p.last ? h('div', {}, trunc(p.last.headline, 60)) : null),
    p.current ? h('span', { class: 'tag' }, 'this project') : h('button', { class: 'btn', onclick: () => open(p) }, p.port ? 'Switch' : 'Open'))));
}

// ---------- Drafts (the review queue) ----------
async function dpost(body) {
  try {
    const r = await api('/api/draft', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cts': '1' }, body: JSON.stringify(body) });
    S.drafts = await api('/api/drafts'); schedule();
    return r;
  } catch (e) { toast((e.body && e.body.error) || e.message); return null; }
}
const maskedText = (t) => { const out = []; let last = 0; for (const m of t.matchAll(/\[(?:redacted|repo|masked|email|path|host|url|internal-url|ip)\]/g)) { out.push(t.slice(last, m.index), h('mark', { title: 'masked by the redactor' }, m[0])); last = m.index + m[0].length; } out.push(t.slice(last)); return out; };
function draftCard(d) {
  const m0 = d.source.moments && S.moments.get(d.source.moments[0]);
  const bad = d.guard && !d.guard.ok;
  const editing = S.editing === d.id;
  const open = d.status === 'pending' || d.status === 'approved';
  const posts = d.posts.map((p, i) => h('div', { class: 'post' }, d.posts.length > 1 ? h('div', { class: 'pn' }, `post ${i + 1} of ${d.posts.length}`) : null, h('div', { class: 'pt' }, maskedText(p.text)), d.limit ? h('div', { class: 'cc' + (p.chars > d.limit ? ' over' : '') }, `${p.chars}/${d.limit}`) : h('div', { class: 'cc' }, `${p.chars} chars`)));
  const rcount = d.redaction ? d.redaction.count : 0;
  let when;
  const ta = editing ? h('textarea', { id: 'ed-' + d.id, rows: Math.min(18, 3 + d.text.split('\n').length), 'aria-label': 'Edit draft text' }, d.text) : null;
  const dec = S.declining === d.id ? h('input', { id: 'dr-' + d.id, placeholder: 'Why? (optional, feeds the drafter)', 'aria-label': 'Reason for declining', onkeydown: (e) => { if (e.key === 'Enter') { dpost({ op: 'decline', id: d.id, reason: e.target.value }); S.declining = null; } if (e.key === 'Escape') { S.declining = null; schedule(); } } }) : null;
  return h('article', { class: 'draft st-' + d.status, style: `--c:var(--k-${d.kind || 'mark'})`, 'data-id': d.id, 'data-kind': 'd' },
    h('header', {},
      h('span', { class: 'ch' }, d.channel), d.format !== d.channel ? h('span', { class: 'tag' }, d.format) : null, h('span', { class: 'tag', style: 'color:var(--c)' }, d.kind || ''), h('span', { class: 'mut mono' }, d.score ? `score ${d.score}` : ''),
      h('span', { class: 'badge b-' + d.status }, d.status === 'approved' && d.approval && d.approval.at ? 'scheduled' : d.status), d.origin === 'autopilot' ? h('span', { class: 'tag' }, `autopilot · ${d.mode}`) : null,
      h('span', { class: 'grow' }), h('span', { class: 'mut' }, ago((Date.now() - d.created_t)) + ' ago' + (d.status === 'pending' ? ` · expires ${fmtD(d.expires_t)}` : ''))),
    m0 ? h('div', { class: 'src' }, 'from ', h('a', { href: `#/story`, onclick: (e) => { e.preventDefault(); S.sel = m0.id; setF({ view: 'story' }); } }, d.source.type === 'arc' ? `arc “${trunc(d.title || m0.headline, 80)}”` : `“${trunc(m0.headline, 90)}”`), m0.tp && m0.tp[0] ? [' · ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); openTranscript(m0.tp[0].id); } }, 'transcript')] : null) : null,
    editing ? ta : h('div', { class: 'preview', 'aria-label': 'Preview exactly as it will be published' }, posts),
    d.card ? h('img', { class: 'card-img', src: `/api/draft/card?id=${d.id}`, alt: 'Share card attached to this draft', loading: 'lazy' }) : null,
    h('div', { class: 'reports' },
      h('div', { class: rcount ? 'rep warn' : 'rep ok' }, rcount ? `Redaction masked ${rcount} item${rcount === 1 ? '' : 's'}: ${d.redaction.summary.map((x) => `${x.rule} ×${x.n}`).join(', ')}` : 'Redaction: nothing needed masking'),
      bad ? h('div', { class: 'rep warn' }, 'Honesty guard: ', d.guard.problems.join(' · ')) : h('div', { class: 'rep ok' }, 'Honesty guard: every number and quote traces to the log')),
    d.status === 'published' ? h('div', { class: 'rep ok' }, d.receipts.map((r) => `${r.receipt.kind === 'outbox' ? 'queued in the outbox' : 'written'}: ${r.receipt.path}`).join(' · ')) : null,
    d.status === 'declined' && d.declined.reason ? h('div', { class: 'mut' }, `Declined: ${d.declined.reason}`) : null,
    d.status === 'approved' && d.approval ? h('div', { class: 'mut' }, d.approval.at ? `Approved, goes out at ${fmtDT(Date.parse(d.approval.at))}` : 'Approved, waiting for the publish queue') : null,
    open && !S.drafts.private ? h('footer', { class: 'acts' },
      editing ? [h('button', { class: 'btn prim', onclick: async () => { const r = await dpost({ op: 'edit', id: d.id, text: $('#ed-' + d.id).value }); S.editing = null; if (r && r.suggestions && r.suggestions.length) toast('Voice suggestion waiting below'); schedule(); } }, 'Save edit'), h('button', { class: 'btn', onclick: () => { S.editing = null; schedule(); } }, 'Cancel')]
        : [h('button', { class: 'btn prim', onclick: async () => { const r = await dpost({ op: 'approve', id: d.id }); if (r && r.held) toast('Approved. Held: ' + r.held); else if (r && r.published) toast('Published'); } }, bad ? 'Approve anyway' : 'Approve'),
          h('label', { class: 'sched' }, 'or at ', h('input', { type: 'datetime-local', 'aria-label': 'Publish at', onchange: (e) => { if (e.target.value) dpost({ op: 'approve', id: d.id, at: new Date(e.target.value).toISOString() }); } })),
          h('button', { class: 'btn', onclick: () => { S.editing = d.id; schedule(); setTimeout(() => { const t = $('#ed-' + d.id); if (t) t.focus(); }, 30); } }, 'Edit'),
          dec || h('button', { class: 'btn', onclick: () => { S.declining = d.id; schedule(); setTimeout(() => { const t = $('#dr-' + d.id); if (t) t.focus(); }, 30); } }, 'Decline')]) : null);
}
function viewDrafts(main) {
  const D = S.drafts;
  if (!D) { main.append(h('div', { class: 'empty' }, h('b', {}, 'Loading drafts…'))); return; }
  const wrap = h('div', { class: 'drafts' });
  const top = h('div', { class: 'dtop' },
    h('div', {}, h('h2', { class: 'sec', style: 'margin:0' }, `Review queue (${D.counts.pending || 0})`), h('div', { class: 'mut' }, 'Nothing goes out without your approval or an auto-publish rule you set. Approved posts are written to your outbox and files, not to social networks.')),
    h('button', { class: 'btn' + (D.paused ? ' on' : ''), 'aria-pressed': String(D.paused), onclick: () => dpost({ op: 'kill', on: !D.paused }) }, D.paused ? 'Publishing paused — resume' : 'Pause publishing'));
  wrap.append(top);
  if (D.private) wrap.append(h('div', { class: 'rep warn' }, 'This project is marked private in cts.json: drafting and publishing are disabled.'));
  if (D.suggestions.some((s) => s.status === 'offered' || s.status === 'accepted')) {
    wrap.append(h('div', { class: 'voice' }, h('b', {}, 'Voice profile'), ...D.suggestions.filter((s) => ['offered', 'accepted'].includes(s.status)).map((s) =>
      h('div', { class: 'vs' }, h('span', {}, s.status === 'accepted' ? `Saved: ${s.key}: ${s.value}` : `Save “${s.key}: ${s.value}” to your voice? (${s.why})`),
        s.status === 'offered' ? [h('button', { class: 'btn', onclick: () => dpost({ op: 'voice-accept', id: s.id }) }, 'Save'), h('button', { class: 'btn', onclick: () => dpost({ op: 'voice-reject', id: s.id }) }, 'No')] : h('button', { class: 'btn', onclick: () => dpost({ op: 'voice-undo', id: s.id }) }, 'Undo'))
    )));
  }
  const open = D.drafts.filter((d) => d.status === 'pending' || d.status === 'approved');
  const done = D.drafts.filter((d) => !['pending', 'approved'].includes(d.status));
  if (!open.length) wrap.append(h('div', { class: 'empty' }, h('b', {}, 'No drafts waiting'), 'Drafts appear here when a moment crosses your autopilot bar. Draft one by hand with ', h('code', {}, 'cts draft <moment-id>'), '.'));
  wrap.append(...open.map(draftCard));
  if (done.length) wrap.append(h('details', { class: 'closed' }, h('summary', {}, `Published, declined, expired (${done.length})`), ...done.map(draftCard)));
  main.append(wrap);
}

// ---------- Settings ----------
async function loadSettings() { try { S.settings = await api('/api/settings'); S.sChanges = {}; schedule(); } catch (e) { toast('Settings failed to load: ' + e.message); } }
function settingInput(f) {
  const id = 'set-' + f.path.replace(/\W/g, '-');
  const changed = Object.prototype.hasOwnProperty.call(S.sChanges, f.path);
  const v = changed ? S.sChanges[f.path] : f.value;
  const put = (x) => { S.sChanges[f.path] = x; schedule(); };
  let input;
  if (f.type === 'bool') input = h('input', { id, type: 'checkbox', checked: !!v, onchange: (e) => put(e.target.checked) });
  else if (f.type === 'int' || f.type === 'number') input = h('input', { id, type: 'number', value: v ?? '', min: f.min, max: f.max, step: f.step || 1, onchange: (e) => put(e.target.value === '' ? null : +e.target.value) });
  else if (f.type === 'enum') input = h('select', { id, onchange: (e) => put(e.target.value) }, f.options.map((o) => h('option', { value: o, selected: o === v }, o)));
  else if (f.type === 'time') input = h('input', { id, type: 'time', value: v || '', onchange: (e) => put(e.target.value || null) });
  else if (f.type === 'text') input = h('input', { id, type: 'text', value: v || '', onchange: (e) => put(e.target.value) });
  else if (f.type === 'list') input = h('textarea', { id, rows: Math.max(2, Math.min(6, (Array.isArray(v) ? v.length : 1) + 1)), onchange: (e) => put(e.target.value) }, (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).filter(Boolean).join('\n'));
  else if (f.type === 'modes') input = h('textarea', { id, rows: 3, placeholder: 'shipped:x = notify', onchange: (e) => put(e.target.value) }, typeof v === 'string' ? v : Object.entries(v || {}).map(([k, m]) => `${k} = ${m}`).join('\n'));
  else if (f.type === 'set') {
    const cur = new Set(v || []);
    input = h('div', { class: 'chips', role: 'group', 'aria-labelledby': id + '-l' }, f.options.map((o) => chip(o, cur.has(o), () => { const n = new Set(cur); if (n.has(o)) n.delete(o); else n.add(o); put([...n]); })));
  }
  const where = f.source === 'project' ? 'Set in this project\'s cts.json' : f.source === 'global' ? 'Set in ~/.cts/config.json' : 'Built-in default';
  return h('div', { class: 'srow' + (changed ? ' changed' : '') },
    h('label', { for: f.type === 'set' ? null : id, id: id + '-l' }, f.label, f.help ? h('span', { class: 'mut shelp' }, f.help) : null),
    input,
    h('span', { class: 'ssrc', title: where }, changed ? 'unsaved' : f.source,
      f.source === 'project' && !changed ? h('button', { class: 'btn', title: 'Remove from cts.json and use the default', onclick: () => { S.sChanges[f.path] = null; saveSettings(); } }, 'Reset') : null));
}
async function saveSettings() {
  try {
    const r = await api('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cts': '1' }, body: JSON.stringify({ changes: S.sChanges }) });
    S.settings = r.settings; S.sChanges = {}; toast(`Saved ${r.changed} setting${r.changed === 1 ? '' : 's'}; the project was rescored`);
    await loadState();
  } catch (e) { toast(e.body && e.body.errors ? e.body.errors.join(' · ') : 'Save failed: ' + e.message); }
}
function viewSettings(main) {
  if (!S.settings) { main.append(h('div', { class: 'empty' }, h('b', {}, 'Loading settings…'))); if (!S.settingsLoading) { S.settingsLoading = true; loadSettings().finally(() => { S.settingsLoading = false; }); } return; }
  const n = Object.keys(S.sChanges).length;
  const wrap = h('div', { class: 'drafts settings' },
    h('div', { class: 'dtop' },
      h('div', {}, h('h2', { class: 'sec', style: 'margin:0' }, 'Settings'), h('div', { class: 'mut' }, 'Saved to ', h('code', {}, S.settings.file), '. Other keys in that file are kept. Saving rescores the project from the log.')),
      h('div', { class: 'acts' }, n ? h('button', { class: 'btn', onclick: () => { S.sChanges = {}; schedule(); } }, 'Discard') : null,
        h('button', { class: 'btn prim', disabled: !n, onclick: saveSettings }, n ? `Save ${n} change${n === 1 ? '' : 's'}` : 'No changes'))));
  for (const sec of [...new Set(S.settings.fields.map((f) => f.section))]) {
    const fold = sec === 'Detector weights' || sec === 'Channels';
    wrap.append(h(fold ? 'details' : 'section', { class: 'sbox' }, h(fold ? 'summary' : 'h3', {}, sec), ...S.settings.fields.filter((f) => f.section === sec).map(settingInput)));
  }
  main.append(wrap);
}

// ---------- Transcript drawer ----------
async function openTranscript(id) {
  const dr = $('#drawer');
  dr.hidden = false;
  dr.replaceChildren(h('header', {}, h('b', {}, 'Transcript'), h('button', { class: 'btn', onclick: closeDrawer, 'aria-label': 'Close transcript' }, 'Close', h('kbd', {}, 'Esc'))), h('div', { class: 'body' }, 'Loading…'));
  dr.querySelector('.btn').focus();
  const body = dr.querySelector('.body');
  let ev = S.events.get(id);
  try { ev = ev || (await api('/api/event?id=' + id)); } catch { /* handled below */ }
  const head = ev ? h('div', { class: 'tl', style: `--lc:${laneColor(ev.sid, ev.actor)}` }, h('div', { class: 'role' }, `${label(ev.sid, ev.actor)} · ${fmtDT(Date.parse(ev.ts))} · ${ev.kind}`), h('div', { class: 'tx' }, ev.sum || JSON.stringify(ev.d).slice(0, 400))) : null;
  try {
    const t = await api('/api/transcript?id=' + id);
    body.replaceChildren(head, h('div', { class: 'mut mono', style: 'margin:6px 0 10px' }, `byte offset ${t.off.toLocaleString()} of ${t.size.toLocaleString()} · lines before the offset justify this event`),
      ...t.lines.map((l) => { const v = lineView(l.text); return h('div', { class: 'tl' + (l.hit ? ' hit' : ''), style: `--lc:${v.role === 'user' ? 'var(--human)' : laneColor(ev ? ev.sid : '', t.actor)}`, tabindex: 0 }, h('div', { class: 'role' }, v.role), h('div', { class: 'tx' }, v.text)); }));
    const hit = body.querySelector('.hit'); if (hit) hit.scrollIntoView({ block: 'center' });
  } catch (e) {
    body.replaceChildren(head, h('div', { class: 'empty' }, h('b', {}, e.status === 410 ? 'Transcript file is gone' : 'No transcript reference'), e.status === 410 ? 'Claude Code cleaned it up. Moments keep a saved evidence snapshot under .cts/evidence/ — use “Saved evidence” on the card.' : 'This event was not tied to a transcript position.'));
  }
}
function lineView(text) {
  let o; try { o = JSON.parse(text); } catch { return { role: 'raw', text: text.slice(0, 600) }; }
  const msg = o.message || {}; const c = msg.content;
  const parts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.map((x) => (x.type === 'text' ? x.text : x.type === 'tool_use' ? `▶ ${x.name} ${JSON.stringify(x.input).slice(0, 300)}` : x.type === 'tool_result' ? '◀ ' + (typeof x.content === 'string' ? x.content : JSON.stringify(x.content)).slice(0, 600) : x.type === 'thinking' ? '(thinking)' : x.type)) : [o.summary || o.type || ''];
  return { role: o.type || msg.role || '?', text: parts.join('\n').slice(0, 1500) };
}
async function showEvidence(mid) {
  const dr = $('#drawer'); dr.hidden = false;
  dr.replaceChildren(h('header', {}, h('b', {}, 'Saved evidence'), h('button', { class: 'btn', onclick: closeDrawer }, 'Close', h('kbd', {}, 'Esc'))), h('div', { class: 'body' }, 'Loading…'));
  const body = dr.querySelector('.body');
  try {
    const ev = await api('/api/evidence?moment=' + encodeURIComponent(mid));
    body.replaceChildren(h('div', { class: 'mut' }, 'Copied from the transcript when the moment was extracted. Survives transcript cleanup.'), ...ev.spans.flatMap((sp) => sp.text.split('\n').filter(Boolean).map((l) => { const v = lineView(l); return h('div', { class: 'tl' }, h('div', { class: 'role' }, v.role), h('div', { class: 'tx' }, v.text)); })));
  } catch { body.replaceChildren(h('div', { class: 'empty' }, h('b', {}, 'No snapshot for this moment'), 'Snapshots are written for moments above the score floor when the transcript was readable (demo sessions have none).')); }
}
function closeDrawer() { $('#drawer').hidden = true; }

// ---------- keyboard ----------
const HELP = [['1–6', 'Live, Story, Threads, Sessions, Drafts, Settings'], ['/', 'Focus search'], ['j / k', 'Next / previous item'], ['Enter', 'Expand card or open transcript'], ['m', 'Confirm selected moment'], ['x', 'Dismiss selected moment'], ['t', 'Open transcript for selection'], ['Shift+M', 'Mark the current moment'], ['g', 'Jump to now (Live)'], ['Esc', 'Close drawer / clear brush'], ['?', 'This map']];
$('#help').append(h('h2', { style: 'margin-top:0' }, 'Keyboard map'), h('table', {}, ...HELP.map(([k, d]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, d)))), h('p', { class: 'mut' }, 'Drag a card onto another to merge. Right-click a lane header to hide it. Drag across the brush to select a time range.'), h('form', { method: 'dialog' }, h('button', { class: 'btn' }, 'Close')));
$('#helpbtn').addEventListener('click', () => $('#help').showModal());
$('#ftoggle').addEventListener('click', () => { S.filtersOpen = !S.filtersOpen; schedule(); });
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.target.id === 'brush') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const items = [...document.querySelectorAll('[data-id]')];
  const cur = items.findIndex((x) => x.dataset.id === S.sel);
  const select = (i) => { const el = items[Math.max(0, Math.min(items.length - 1, i))]; if (!el) return; document.querySelectorAll('.sel').forEach((x) => x.classList.remove('sel')); el.classList.add('sel'); S.sel = el.dataset.id; el.scrollIntoView({ block: 'nearest' }); };
  const k = e.key;
  if (k === '?') { $('#help').showModal(); }
  else if (k === 'Escape') { closeDrawer(); if (F.from || F.to) setF({ from: 0, to: 0 }); }
  else if (['1', '2', '3', '4', '5', '6'].includes(k)) setF({ view: VIEWS[+k - 1][0] });
  else if (k === '/') { e.preventDefault(); $('#q').focus(); }
  else if (k === 'j') select(cur < 0 ? items.length - 1 : cur + 1);
  else if (k === 'k') select(cur < 0 ? items.length - 1 : cur - 1);
  else if (k === 'g') { const w = $('#lanewrap'); if (w) { S.stick = true; w.scrollTop = w.scrollHeight; } }
  else if (k === 'M') act('mark', { note: '' });
  else if (k === 'Enter' && S.sel) { const el = items[cur]; if (!el) return; if (el.dataset.kind === 'm') el.classList.toggle('open'); else openTranscript(S.sel); }
  else if (k === 'm' && S.sel && S.moments.has(S.sel)) act('confirm', { target: S.sel }, S.moments.get(S.sel).sid);
  else if (k === 'x' && S.sel && S.moments.has(S.sel)) act('dismiss', { target: S.sel }, S.moments.get(S.sel).sid);
  else if (k === 't' && S.sel) { const m = S.moments.get(S.sel); openTranscript(m ? (m.tp[0] ? m.tp[0].id : m.span.first) : S.sel); }
});

loadState().then(connect).catch((e) => { $('#main').replaceChildren(h('div', { class: 'empty' }, h('b', {}, 'Cannot reach the CTS server'), String(e.message))); });
