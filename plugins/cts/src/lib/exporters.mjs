// Exports. Everything except the bundle and raw ndjson passes the redactor; the bundle is a private backup and says so.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { paths, SCHEMA, crc32 } from './util.mjs';
import { readEvents } from './log.mjs';
import { writeZip } from './zip.mjs';
import { redact, redactDeep } from './redact.mjs';
import { redactOpts, digestMarkdown, publicData, cardSvg, CARD_SIZES } from './share.mjs';
import { consentMoment, consentEvent } from './consent.mjs';
import { summarize } from './summary.mjs';
import { resolveSource, compose } from './narrative.mjs';

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const slug = (s) => String(s || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'untitled';
const walk = (dir, base = dir) => { const out = []; try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) out.push(...walk(f, base)); else out.push(path.relative(base, f).replace(/\\/g, '/')); } } catch { /* absent */ } return out; };

// ---------- bundle (.cts.zip) ----------
export function exportBundle(pr, outFile) {
  const p = paths(pr.root);
  const names = [...walk(p.sessions).map((f) => 'sessions/' + f).filter((f) => f.endsWith('.jsonl')), ...['voice.md', 'cts.json', 'retention.json'].filter((f) => fs.existsSync(path.join(p.cts, f))), ...walk(p.digests).map((f) => 'digests/' + f), ...walk(p.evidence).map((f) => 'evidence/' + f), ...walk(path.join(p.cts, 'drafts')).map((f) => 'drafts/' + f)];
  const entries = names.map((n) => ({ name: n, data: fs.readFileSync(path.join(p.cts, n)) }));
  const manifest = { format: 'cts-bundle', schema: SCHEMA, created: new Date().toISOString(), project: path.basename(pr.root), events: pr.engine.eventCount, private_backup: true, files: entries.map((e) => ({ name: e.name, bytes: e.data.length, sha1: sha1(e.data) })) };
  const buf = writeZip([{ name: 'manifest.json', data: JSON.stringify(manifest, null, 1) }, ...entries]);
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, buf);
  return { file: outFile, files: entries.length, bytes: buf.length, events: manifest.events };
}

// ---------- events / moments / threads / marks as flat data ----------
export function* rawEvents(root) {
  const p = paths(root);
  let files = []; try { files = fs.readdirSync(p.sessions).filter((f) => f.endsWith('.jsonl')).sort(); } catch { /* none */ }
  for (const f of files) for (const r of readEvents(path.join(p.sessions, f))) if (r.ev) { const { crc, ...e } = r.ev; yield e; }
}
export function eventsNdjson(pr, { raw = false } = {}) {
  const opts = redactOpts(pr);
  const lines = [];
  for (const e0 of rawEvents(pr.root)) { const e = raw ? e0 : consentEvent(pr, e0); lines.push(JSON.stringify(raw ? e : { ...e, d: redactDeep(e.d, opts).value, cwd: undefined, tp: undefined })); }
  return lines.join('\n') + (lines.length ? '\n' : '');
}
export function marksMarkdown(pr) {
  const marks = [...rawEvents(pr.root)].filter((e) => e.kind === 'mark' && e.d && (e.d.note || e.d.flag));
  const opts = redactOpts(pr);
  const days = new Map();
  for (const e of marks) { const d = new Date(e.ts); const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; (days.get(day) || days.set(day, []).get(day)).push(e); }
  const out = ['# CTS marks', ''];
  for (const [day, list] of [...days].sort()) {
    out.push(`## ${day}`, '');
    for (const e of list) { const d = new Date(e.ts); out.push(`- ${e.d.flag === '?' ? '? ' : ''}${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${redact(e.d.note || 'open question', opts).text}`); }
    out.push('');
  }
  return out.join('\n');
}

// ---------- Markdown: arcs as articles, digests, drafts ----------
export function exportMarkdown(pr, outDir) {
  const opts = redactOpts(pr);
  const w = (rel, text) => { const f = path.join(outDir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return rel; };
  const index = ['# CTS export', ''];
  const arcs = pr.engine.arcs().filter((a) => !a.demo && a.moments.length);
  arcs.forEach((a, i) => {
    const src = resolveSource(pr, 'arc:' + a.id); if (!src) return;
    const c = compose(pr, src, 'blog', 'long'); if (!c) return;
    const rel = w(`arcs/${String(i + 1).padStart(2, '0')}-${slug(c.title)}.md`, c.text);
    index.push(`- [${c.title}](${rel}) · ${a.shape} · ${a.status}`);
  });
  const days = new Map();
  for (const m of pr.engine.listMoments({ min: pr.cfg.threshold })) { if (m.demo) continue; const k = new Date(m.t0).toISOString().slice(0, 10); days.set(k, 1); }
  index.push('', '## Digests', '');
  for (const day of [...days.keys()].sort()) {
    const t0 = Date.parse(day + 'T00:00:00Z');
    const md = redact(digestMarkdown(pr, { from: t0, to: t0 + 86400000, title: `CTS digest, ${day}`, shared: true }), opts).text;
    index.push(`- [${day}](${w(`digests/${day}.md`, md)})`);
  }
  index.push('', '## Drafts', '');
  for (const d of pr.engine.drafts.list()) {
    const fm = ['---', `draft: ${d.id}`, `channel: ${d.channel}`, `format: ${d.format}`, `status: ${d.status}`, `source: ${d.source.id}`, '---', ''];
    index.push(`- [${d.channel} · ${d.status} · ${d.id.slice(-8)}](${w(`drafts/${d.id.slice(-8)}.md`, fm.join('\n') + d.text + '\n')})`);
  }
  w('index.md', index.join('\n') + '\n');
  return { dir: outDir, arcs: arcs.length, digests: days.size, drafts: pr.engine.drafts.list().length };
}

// ---------- OpenTelemetry (OTLP/JSON traces) ----------
export function exportOtel(pr) {
  const opts = redactOpts(pr);
  const ns = (t) => String(Math.round(t) * 1e6);
  const val = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : typeof v === 'boolean' ? { boolValue: v } : { stringValue: String(v) });
  const attrs = (o) => Object.entries(o).filter(([, v]) => v != null && v !== '').map(([key, v]) => ({ key, value: val(v) }));
  const spans = [];
  for (const S of pr.engine.sessionList()) {
    if (S.demo) continue;
    const traceId = sha1('trace:' + S.sid).slice(0, 32), rootId = sha1('root:' + S.sid).slice(0, 16);
    spans.push({ traceId, spanId: rootId, name: `session ${S.sid.slice(0, 8)}`, kind: 1, startTimeUnixNano: ns(S.start), endTimeUnixNano: ns(Math.max(S.end || S.start, S.start + 1)), attributes: attrs({ 'cts.session': S.sid, 'cts.source': S.source, 'gen_ai.request.model': S.model, 'cts.events': S.events }) });
    const evs = []; let after;
    for (;;) { const page = pr.events({ sid: S.sid, order: 'asc', limit: 5000, after }); if (!page.length) break; evs.push(...page.filter((e) => !INTERNAL(e))); after = page[page.length - 1].id; if (page.length < 5000) break; }
    const pre = new Map(), subs = new Map();
    const parentOf = (e) => (e.actor.startsWith('agent:') && subs.has(e.actor) ? subs.get(e.actor).spanId : rootId);
    for (const e of evs) {
      if (e.kind === 'subagent.start') subs.set(e.actor, { spanId: sha1('sub:' + e.id).slice(0, 16), start: e.t, e });
      else if (e.kind === 'subagent.stop' && subs.has(e.actor)) { const s = subs.get(e.actor); spans.push({ traceId, spanId: s.spanId, parentSpanId: rootId, name: `agent ${e.agent_type || e.actor}`, kind: 1, startTimeUnixNano: ns(s.start), endTimeUnixNano: ns(Math.max(e.t, s.start + 1)), attributes: attrs({ 'cts.actor': e.actor, 'cts.agent_type': e.agent_type }) }); }
      else if (e.kind === 'tool.pre') pre.set(e.d.tool_use_id, e);
      else if (e.kind === 'tool.post' || e.kind === 'tool.fail') {
        const a = pre.get(e.d.tool_use_id); const start = a ? a.t : e.t - (e.d.dur_ms || 0);
        const fail = e.kind === 'tool.fail';
        spans.push({ traceId, spanId: sha1('tool:' + e.id).slice(0, 16), parentSpanId: parentOf(e), name: `tool ${e.d.tool}`, kind: 1, startTimeUnixNano: ns(start), endTimeUnixNano: ns(Math.max(e.t, start + 1)), status: { code: fail ? 2 : 1 },
          attributes: attrs({ 'cts.actor': e.actor, 'cts.agent_type': e.agent_type, 'tool.name': e.d.tool, 'cts.summary': redact(summarize(e), opts).text, 'cts.test.red': e.d.test ? e.d.test.red : null, 'cts.test.fail': e.d.test ? e.d.test.fail : null, 'cts.git.op': e.d.git ? e.d.git.op : null }) });
      }
    }
    for (const m of pr.engine.listMoments()) {
      if (m.sid !== S.sid || m.score <= 0) continue;
      spans.push({ traceId, spanId: sha1('moment:' + m.id).slice(0, 16), parentSpanId: rootId, name: `moment ${m.kind}`, kind: 1, startTimeUnixNano: ns(m.t0), endTimeUnixNano: ns(Math.max(m.t1, m.t0 + 1)),
        attributes: attrs({ 'cts.moment.id': m.id, 'cts.moment.kind': m.kind, 'cts.moment.score': m.score, 'cts.moment.status': m.status, 'cts.moment.headline': redact(m.headline, opts).text, 'cts.actors': m.actors.join(',') }) });
    }
  }
  return { resourceSpans: [{ resource: { attributes: attrs({ 'service.name': 'claude-code', 'service.namespace': 'cts', 'cts.project': sha1(pr.root).slice(0, 12), 'cts.schema': SCHEMA }) }, scopeSpans: [{ scope: { name: 'cts', version: '1' }, spans }] }] };
}

// ---------- headless browser: PNG cards, replay frames ----------
export function findBrowser() {
  const c = [process.env.CTS_BROWSER];
  if (process.platform === 'win32') { for (const b of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) if (b) c.push(path.join(b, 'Google/Chrome/Application/chrome.exe'), path.join(b, 'Microsoft/Edge/Application/msedge.exe')); }
  else if (process.platform === 'darwin') c.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  else { c.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'); try { for (const d of fs.readdirSync('/opt/pw-browsers')) c.push(`/opt/pw-browsers/${d}/chrome-linux/chrome`, `/opt/pw-browsers/${d}/chrome-linux64/chrome`); c.push('/opt/pw-browsers/chromium'); } catch { /* none */ } }
  return c.find((x) => x && fs.existsSync(x)) || null;
}
/** Decode the top `h` rows of an 8-bit non-interlaced PNG and re-encode them (Chrome's output). No dependencies. */
export function cropPng(buf, h) {
  let p = 8, ihdr = null; const idat = [];
  while (p < buf.length) { const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8); if (type === 'IHDR') ihdr = buf.subarray(p + 8, p + 8 + len); else if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len)); p += 12 + len; }
  const w = ihdr.readUInt32BE(0), H = ihdr.readUInt32BE(4), depth = ihdr[8], ct = ihdr[9], il = ihdr[12];
  if (h >= H) return buf;
  if (depth !== 8 || il !== 0 || ![2, 6].includes(ct)) return buf;
  const bpp = ct === 6 ? 4 : 3, stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(h * (stride + 1));
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let add = 0;
      if (f === 1) add = a; else if (f === 2) add = b; else if (f === 3) add = (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = (line[i] + add) & 255;
    }
    out[y * (stride + 1)] = 0; line.copy(out, y * (stride + 1) + 1); prev = line;
  }
  const chunk = (type, data) => { const t = Buffer.from(type, 'latin1'); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(parseInt(crc32(Buffer.concat([t, data])), 16)); return Buffer.concat([len, t, data, crc]); };
  const nh = Buffer.from(ihdr); nh.writeUInt32BE(h, 4);
  return Buffer.concat([buf.subarray(0, 8), chunk('IHDR', nh), chunk('IDAT', zlib.deflateSync(out)), chunk('IEND', Buffer.alloc(0))]);
}
let CHROME_OFFSET = null;
function runBrowser(b, args) {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-br-'));
  try { return spawnSync(b, ['--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=1', `--user-data-dir=${prof}`, ...args], { timeout: 60000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 24 }); }
  finally { fs.rmSync(prof, { recursive: true, force: true }); }
}
/** Headless Chrome hides part of the requested window behind its frame (~87 px at the bottom). Measure it once, then over-ask and crop. */
function chromeOffset(b) {
  if (CHROME_OFFSET != null) return CHROME_OFFSET;
  const probe = path.join(os.tmpdir(), `cts-probe-${process.pid}.html`);
  fs.writeFileSync(probe, '<!doctype html><body><script>document.body.textContent="H="+innerHeight</script>');
  try { const m = /H=(\d+)/.exec(runBrowser(b, ['--window-size=800,600', '--dump-dom', fileUrl(probe)]).stdout || ''); CHROME_OFFSET = m ? Math.max(0, 600 - +m[1]) : 0; } finally { fs.rmSync(probe, { force: true }); }
  return CHROME_OFFSET;
}
export function screenshot(url, png, w, h, { budget = 0 } = {}) {
  const b = findBrowser();
  if (!b) throw new Error('no Chrome/Edge/Chromium found. Install one or set CTS_BROWSER to its path (SVG cards and the replay HTML work without it).');
  const off = chromeOffset(b);
  const r = runBrowser(b, [`--window-size=${w},${h + off}`, ...(budget ? [`--virtual-time-budget=${budget}`] : []), `--screenshot=${png}`, url]);
  if (!fs.existsSync(png)) throw new Error('the browser did not produce a screenshot (exit ' + r.status + ')');
  if (off) fs.writeFileSync(png, cropPng(fs.readFileSync(png), h));
}
const fileUrl = (f) => 'file://' + (process.platform === 'win32' ? '/' : '') + path.resolve(f).replace(/\\/g, '/');
export function cardPng(m, size, outFile) {
  const [w, h] = CARD_SIZES[size] || CARD_SIZES.og;
  const tmp = path.join(os.tmpdir(), `cts-card-${process.pid}-${Date.now()}.html`);
  fs.writeFileSync(tmp, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#141413}svg{display:block}</style>${cardSvg(m, size)}`);
  try { screenshot(fileUrl(tmp), outFile, w, h); } finally { fs.rmSync(tmp, { force: true }); }
}

// ---------- replay (self-contained HTML; optional mp4/gif through the browser + ffmpeg) ----------
export function replayData(pr, { sid, from, to } = {}) {
  const opts = redactOpts(pr);
  const sessions = sid ? pr.engine.sessionList().filter((s) => s.sid === sid) : pr.engine.sessionList().filter((s) => !s.demo).slice(-1);
  const S = sessions[0]; if (!S) return null;
  const evs = []; let after;
  for (;;) { const page = pr.events({ sid: S.sid, order: 'asc', limit: 5000, after }); if (!page.length) break; evs.push(...page); after = page[page.length - 1].id; if (page.length < 5000) break; }
  const sel = evs.filter((e) => (!from || e.t >= from) && (!to || e.t <= to) && !['tool.pre', 'batch', 'compact.pre'].includes(e.kind) && !INTERNAL(e)).map((e) => consentEvent(pr, e));
  if (!sel.length) return null;
  const t0 = sel[0].t, t1 = sel[sel.length - 1].t;
  const lab = (a) => (S.actors.find((x) => x.id === a) || { label: a }).label;
  const lanes = [...new Set(sel.map((e) => e.actor))].sort((a, b) => (a === 'human' ? -1 : b === 'human' ? 1 : a === 'main' ? -1 : b === 'main' ? 1 : 0));
  const moments = pr.engine.listMoments({ min: pr.cfg.threshold }).filter((m) => m.sid === S.sid && m.t1 >= t0 && m.t0 <= t1).map((m) => consentMoment(pr, m));
  return {
    title: redact(S.title || 'Session replay', opts).text, t0, t1, lanes: lanes.map((a) => ({ id: a, label: lab(a) })),
    events: sel.map((e) => ({ t: e.t - t0, lane: lanes.indexOf(e.actor), kind: e.kind, text: redact(summarize(e), opts).text.slice(0, 120) })),
    moments: moments.map((m) => ({ t: m.t1 - t0, kind: m.kind, score: m.score, headline: redact(m.headline, opts).text, lanes: m.actors.map((a) => lanes.indexOf(a)).filter((i) => i >= 0), ev: redact(require_ev(m), opts).text })),
  };
}
const INTERNAL = (e) => /^(draft|extract|voice|publish|post)\./.test(e.kind) || ['cts', 'extractor', 'autopilot'].includes(e.actor);
const require_ev = (m) => { const E = m.evidence || {}; const parts = []; if (E.attempts) parts.push(`${E.attempts} attempts`); if (E.counts && E.counts.total) parts.push(`${E.counts.fail}/${E.counts.total} failing`); return parts.join(' · '); };

export function replayHtml(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${data.title.replace(/[<&]/g, '')} · CTS replay</title>
<style>:root{--bg:#141413;--ink:#ecebe6;--mut:#9b978f;--line:#2c2b28;--h:#f08a56;--k:#6b8e9e}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.4 "Segoe UI",Seravek,Ubuntu,sans-serif;height:100vh;display:flex;flex-direction:column}
header{padding:14px 22px;display:flex;gap:16px;align-items:baseline;border-bottom:1px solid var(--line)}header b{letter-spacing:.14em}header span{color:var(--mut);font:13px ui-monospace,Menlo,Consolas,monospace}
#clock{margin-left:auto}#lanes{flex:1;display:grid;gap:0;overflow:hidden;position:relative}
.lane{border-right:1px solid var(--line);padding:8px 10px;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;gap:3px}
.lane h3{margin:0 0 4px;font:600 12px ui-monospace,Menlo,Consolas,monospace;color:var(--mut);letter-spacing:.08em;text-transform:uppercase;position:sticky;top:0}
.ev{font:12px ui-monospace,Menlo,Consolas,monospace;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-left:3px solid var(--c);padding-left:7px;animation:in .25s}.ev.fail{color:#e06b6b}
.ev.cur{color:var(--ink)}@keyframes in{from{opacity:0;transform:translateY(8px)}}
#cards{position:absolute;left:0;right:0;top:14px;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none}
.card{pointer-events:none;background:#1d1d1b;border:1px solid var(--c);border-left:6px solid var(--c);border-radius:12px;padding:10px 16px;min-width:340px;max-width:70%;box-shadow:0 0 26px color-mix(in srgb,var(--c) 40%,transparent);animation:pop .35s}
.card small{display:block;font:11px ui-monospace,Menlo,Consolas,monospace;color:var(--c);letter-spacing:.12em;text-transform:uppercase}.card b{font-size:18px}.card i{font:12px ui-monospace,monospace;color:var(--mut);font-style:normal}
@keyframes pop{from{opacity:0;transform:scale(.94)}}
footer{padding:10px 22px;border-top:1px solid var(--line);display:flex;gap:12px;align-items:center}footer input[type=range]{flex:1}button,select{font:inherit;background:#1d1d1b;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:4px 12px}
body.still footer{display:none}.brandline{color:var(--mut);font:12px ui-monospace,monospace}
</style></head><body><header><b>CTS</b><span id="ttl"></span><span id="clock"></span></header><main id="lanes"><div id="cards" aria-live="polite"></div></main>
<footer><button id="pp" aria-label="Play or pause">Pause</button><input id="sc" type="range" min="0" max="1000" value="0" aria-label="Scrub"><select id="sp" aria-label="Speed"><option value="1">1×</option><option value="2" selected>2×</option><option value="4">4×</option></select><span class="brandline">captured with CTS · redacted</span></footer>
<script>const D=${json};
const K={fight:'#f08a56',reversal:'#d9b93a',disagreement:'#d07cb0',shipped:'#5fbf8a',broke:'#e06b6b',pivot:'#6e9be0','memory-cut':'#9d90e0',refusal:'#e0955f',wait:'#9aa4af',escalation:'#5fc0c0',mark:'#e8c547',theory:'#b99be0',workaround:'#6bb5d6',learned:'#9bcb6a'};
const LC=['#f08a56','#7fa3b3','#97b385','#b79bc7','#c9ae62','#6fb5ac'];
const $=s=>document.querySelector(s),dur=Math.max(1,D.t1-D.t0);let cur=0,playing=true,last=0;
$('#ttl').textContent=D.title;const L=$('#lanes');L.style.gridTemplateColumns='repeat('+D.lanes.length+',1fr)';
const cols=D.lanes.map((l,i)=>{const d=document.createElement('div');d.className='lane';d.style.setProperty('--c',LC[i%LC.length]);d.innerHTML='<h3></h3>';d.firstChild.textContent=l.label==='You'?'You':l.label;L.insertBefore(d,$('#cards'));return d});
const hash=new URLSearchParams(location.hash.slice(1));if(hash.has('still'))document.body.classList.add('still');if(hash.has('h'))document.body.style.height=hash.get('h')+'px';
function fmt(ms){const s=Math.round(ms/1000);return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}
function draw(){const t=cur*dur;$('#clock').textContent=fmt(t)+' / '+fmt(dur);$('#sc').value=Math.round(cur*1000);
 cols.forEach((c,i)=>{while(c.children.length>1)c.removeChild(c.lastChild);const mine=D.events.filter(e=>e.lane===i&&e.t<=t).slice(-14);mine.forEach((e,j)=>{const d=document.createElement('div');d.className='ev'+(e.kind==='tool.fail'?' fail':'')+(j===mine.length-1?' cur':'');d.textContent=e.text;c.append(d)})});
 const cards=$('#cards');cards.innerHTML='';D.moments.filter(m=>m.t<=t&&t-m.t<Math.max(6000,dur*0.07)).slice(-2).forEach(m=>{const d=document.createElement('div');d.className='card';d.style.setProperty('--c',K[m.kind]||'#f08a56');const a=document.createElement('small');a.textContent=m.kind+' · '+m.score;const b=document.createElement('b');b.textContent=m.headline;d.append(a,b);if(m.ev){const i=document.createElement('i');i.textContent=m.ev;d.append(i)}cards.append(d)})}
function tick(ts){if(playing){const dt=last?ts-last:0;cur=Math.min(1,cur+dt*(+$('#sp').value)*(dur>600000?30:8)/dur);if(cur>=1)playing=false;$('#pp').textContent=playing?'Pause':'Replay';draw()}last=ts;requestAnimationFrame(tick)}
$('#pp').onclick=()=>{if(cur>=1)cur=0;playing=!playing;$('#pp').textContent=playing?'Pause':'Replay'};$('#sc').oninput=e=>{cur=e.target.value/1000;playing=false;$('#pp').textContent='Play';draw()};
if(hash.has('t')){cur=Math.max(0,Math.min(1,+hash.get('t')));playing=false;draw()}else{draw();requestAnimationFrame(tick)}
</script></body></html>`;
}

export function replayVideo(data, outFile, { fps = 10, seconds = 14, size = [1280, 720] } = {}) {
  const ff = spawnSync(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg', ['-version'], { stdio: 'ignore' });
  if (ff.error || ff.status !== 0) throw new Error('ffmpeg not found on PATH (needed for .mp4/.gif). The replay .html works without it.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-replay-'));
  try {
    const html = path.join(dir, 'replay.html'); fs.writeFileSync(html, replayHtml(data));
    const n = fps * seconds;
    for (let i = 0; i < n; i++) screenshot(fileUrl(html) + `#still=1&w=${size[0]}&h=${size[1]}&t=${(i / (n - 1)).toFixed(4)}`, path.join(dir, `f${String(i).padStart(4, '0')}.png`), size[0], size[1], { budget: 400 });
    const gif = /\.gif$/i.test(outFile);
    const args = gif ? ['-y', '-framerate', String(fps), '-i', path.join(dir, 'f%04d.png'), '-vf', 'split[a][b];[a]palettegen[p];[b][p]paletteuse', outFile]
      : ['-y', '-framerate', String(fps), '-i', path.join(dir, 'f%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outFile];
    const r = spawnSync('ffmpeg', args, { stdio: 'ignore' });
    if (r.status !== 0) throw new Error('ffmpeg failed to encode the frames');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return outFile;
}
export { publicData };
