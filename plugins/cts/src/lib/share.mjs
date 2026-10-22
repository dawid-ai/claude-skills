// Everything that leaves the machine is built here, and every string goes through the redactor first.
import { redact, redactDeep, projectNames, summarizeReport } from './redact.mjs';
import { trunc } from './util.mjs';
import { consentMoment, consentText } from './consent.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDur = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? '<1 min' : m < 90 ? m + ' min' : m < 2880 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' days'; };
const fmtDate = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');

export function redactOpts(pr) {
  return { allow: pr.cfg.redact.allow, deny: pr.cfg.redact.deny, names: projectNames(pr.root) };
}

function actorLabel(pr, m, a) {
  const S = pr.engine.sessions.get(m.sid);
  const x = S && S.actors.get(a);
  return x ? x.label : a;
}

/** Evidence line for a moment: the one number a post would use. */
export function evidenceLine(m) {
  const e = m.evidence || {};
  const parts = [];
  if (e.attempts) parts.push(`${e.attempts} attempts`);
  if (e.elapsed_ms) parts.push(fmtDur(e.elapsed_ms));
  if (e.stat) parts.push(`${e.stat.files} files, +${e.stat.ins}/−${e.stat.del}`);
  if (e.counts && e.counts.total) parts.push(`${e.counts.fail}/${e.counts.total} failing`);
  if (e.minutes) parts.push(`${e.minutes} min`);
  return parts.join(' · ');
}

/** Redacted, export-ready view of moments and arcs. */
export function publicData(pr, { min } = {}) {
  const thr = min ?? pr.cfg.threshold;
  const opts = redactOpts(pr);
  const moments = pr.engine.listMoments({ min: thr }).filter((m) => !m.demo || pr.engine.listMoments().every((x) => x.demo)).map((m) => consentMoment(pr, m));
  const ids = new Set(moments.map((m) => m.id));
  const pub = moments.map((m) => ({
    id: m.id, kind: m.kind, score: m.score, sid: m.sid, t0: m.t0, t1: m.t1, headline: m.headline, body: m.body,
    actors: m.actors.map((a) => actorLabel(pr, m, a)), branch: m.branch, evidence: m.evidence, evidence_line: evidenceLine(m), note: m.note,
  }));
  const arcs = pr.engine.arcs().filter((a) => a.moments.some((id) => ids.has(id))).map((a) => ({
    id: a.id, shape: a.shape, status: a.status, t0: a.t0, t1: a.t1, duration_ms: a.duration_ms, title: consentText(pr, a.title, a.moments.map((id) => pr.engine.moments.get(id))), sessions: a.sessions.length,
    moments: a.moments.filter((id) => ids.has(id)),
    actors: [...new Set(a.moments.flatMap((id) => (pub.find((m) => m.id === id) || { actors: [] }).actors))],
    outcome: a.outcome,
  }));
  const r = redactDeep({ moments: pub, arcs }, opts);
  return { ...r.value, report: r.report };
}

export function buildStoryHtml(pr, { title } = {}) {
  const data = publicData(pr);
  const opts = redactOpts(pr);
  const T = redact(title || `${pr.root.split(/[\\/]/).pop()} — the struggle`, opts).text;
  const byId = new Map(data.moments.map((m) => [m.id, m]));
  const chapters = data.arcs.map((a, i) => `
  <section class="arc">
    <header><span class="n">Chapter ${i + 1}</span><h2>${esc(a.title)}</h2>
      <p class="meta"><b>${esc(a.shape)}</b> · ${esc(fmtDur(a.duration_ms))} · ${a.sessions} session${a.sessions === 1 ? '' : 's'} · ${esc(a.actors.join(', '))} · ${a.status === 'closed' ? 'shipped' : esc(a.status)}</p></header>
    <ol>${a.moments.map((id) => byId.get(id)).filter(Boolean).map((m) => `
      <li class="k-${esc(m.kind)}"><time>${esc(fmtDate(m.t0))}</time><span class="chip">${esc(m.kind)}</span>
        <strong>${esc(m.headline)}</strong>${m.body.filter(Boolean).map((b) => `<p>${esc(b)}</p>`).join('')}
        ${m.evidence_line ? `<code>${esc(m.evidence_line)}</code>` : ''}</li>`).join('')}
    </ol>
  </section>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(T)}</title>
<style>
:root{--bg:#fbfaf8;--fg:#1d1c1a;--mut:#6b6761;--line:#e4e0d8;--card:#fff;--acc:#d9622b}
@media(prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--mut:#9b978f;--line:#2b2a27;--card:#1b1b19;--acc:#f08a56}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 "Segoe UI",Seravek,"Gill Sans Nova",Ubuntu,Calibri,sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px 80px}h1{font-size:clamp(1.8rem,5vw,2.6rem);line-height:1.1;margin:0 0 6px}.lede{color:var(--mut);margin:0 0 32px}
.arc{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin:0 0 20px}.n{font:600 .72rem ui-monospace,Menlo,Consolas,monospace;color:var(--acc);text-transform:uppercase;letter-spacing:.08em}
h2{margin:4px 0 4px;font-size:1.3rem;line-height:1.25}.meta{margin:0 0 12px;color:var(--mut);font-size:.9rem}ol{list-style:none;margin:0;padding:0;border-left:2px solid var(--line)}
li{padding:2px 0 14px 16px;position:relative}li:before{content:"";position:absolute;left:-6px;top:8px;width:10px;height:10px;border-radius:50%;background:var(--acc)}
time{display:block;font:.75rem ui-monospace,Menlo,Consolas,monospace;color:var(--mut)}.chip{font:600 .68rem ui-monospace,Menlo,Consolas,monospace;border:1px solid var(--line);border-radius:99px;padding:1px 8px;margin-right:6px;color:var(--mut)}
li p{margin:.25rem 0;color:var(--mut);font-size:.92rem}code{display:inline-block;margin-top:4px;font:.8rem ui-monospace,Menlo,Consolas,monospace;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:2px 8px}
footer{color:var(--mut);font-size:.8rem;margin-top:32px}
</style></head><body><main>
<h1>${esc(T)}</h1><p class="lede">${data.arcs.length} chapter${data.arcs.length === 1 ? '' : 's'} · ${data.moments.length} moments · captured by CTS, redacted before export.</p>
${chapters || '<p class="lede">No moments above the score threshold yet.</p>'}
<footer>Redaction: ${Object.entries(summarizeReport(data.report)).map(([k, v]) => `${esc(k)} ×${v}`).join(', ') || 'nothing needed masking'}.</footer>
</main></body></html>`;
}

export const CARD_SIZES = { x: [1200, 675], linkedin: [1200, 627], og: [1200, 630], square: [1080, 1080] };
const KIND_HUE = { fight: '#d9622b', reversal: '#c9a227', disagreement: '#b0508f', shipped: '#4a9d6f', broke: '#c94a4a', pivot: '#4a82c9', 'memory-cut': '#8a7bc4', refusal: '#c97a4a', wait: '#7d8590', escalation: '#4aa6a6', mark: '#e8c547' };

function wrap(text, n) {
  const words = String(text).split(/\s+/); const lines = []; let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > n) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) lines.push(cur);
  return lines;
}

/** SVG share card for one public moment (already redacted). */
export function cardSvg(m, size = 'og') {
  const [w, h] = CARD_SIZES[size] || CARD_SIZES.og;
  const col = KIND_HUE[m.kind] || '#d9622b';
  const lines = wrap(m.headline, w > 1100 && h < 800 ? 38 : 26).slice(0, 4);
  const fs = h > 900 ? 76 : 60;
  const lanes = m.actors.slice(0, 4);
  const pad = 72;
  const big = m.evidence && (m.evidence.attempts ? [m.evidence.attempts, 'attempts'] : m.evidence.minutes ? [m.evidence.minutes, 'minutes'] : m.evidence.stat ? [m.evidence.stat.ins + m.evidence.stat.del, 'lines'] : null);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(m.headline)}">
<rect width="${w}" height="${h}" fill="#141413"/>
<rect x="0" y="0" width="14" height="${h}" fill="${col}"/>
<text x="${pad}" y="${pad + 20}" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="26" fill="${col}" letter-spacing="3">${esc(m.kind.toUpperCase())} · ${m.score}</text>
${lines.map((l, i) => `<text x="${pad}" y="${pad + 120 + i * (fs * 1.2)}" font-family="'Segoe UI',Seravek,Ubuntu,Calibri,sans-serif" font-weight="700" font-size="${fs}" fill="#ecebe6">${esc(l)}</text>`).join('\n')}
${big ? `<text x="${w - pad}" y="${h - pad - 70}" text-anchor="end" font-family="'Segoe UI',Seravek,Ubuntu,sans-serif" font-weight="800" font-size="150" fill="${col}">${esc(big[0])}</text><text x="${w - pad}" y="${h - pad - 30}" text-anchor="end" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="28" fill="#9b978f">${esc(big[1])}</text>` : ''}
${lanes.map((a, i) => `<rect x="${pad}" y="${h - pad - 30 - i * 0}" width="0" height="0"/><g transform="translate(${pad + i * 190},${h - pad - 36})"><rect width="170" height="8" rx="4" fill="${i === 0 && a === 'You' ? '#f08a56' : ['#6b8e9e', '#8e8e6b', '#8a6b9e', '#6b9e7d'][i % 4]}"/><text y="34" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="20" fill="#9b978f">${esc(trunc(a, 16))}</text></g>`).join('\n')}
<text x="${pad}" y="${h - 22}" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="18" fill="#6b6761">${esc(m.evidence_line || '')}${m.evidence_line ? '  ·  ' : ''}captured with CTS</text>
</svg>`;
}

export function digestMarkdown(pr, { from, to, title, shared = false } = {}) {
  const e = pr.engine;
  const thr = pr.cfg.threshold;
  const ms = e.listMoments({ min: thr }).filter((m) => (!from || m.t0 >= from) && (!to || m.t0 < to)).map((m) => (shared ? consentMoment(pr, m) : m));
  const lines = [`# ${title || 'CTS digest'}`, ''];
  if (!ms.length) lines.push('_No moments above the threshold in this range._', '');
  for (const m of ms) {
    const labels = m.actors.map((a) => actorLabel(pr, m, a)).join(', ');
    lines.push(`- **${fmtDate(m.t0)}** · \`${m.kind}\` · ${m.score} — ${m.headline}`);
    lines.push(`  - actors: ${labels}${m.branch ? ` · branch: ${m.branch}` : ''}`);
    for (const b of m.body.filter(Boolean)) lines.push(`  - ${b}`);
    const ev = evidenceLine(m); if (ev) lines.push(`  - evidence: ${ev}`);
    lines.push(`  - id: \`${m.id}\``);
  }
  const open = e.openThreads();
  lines.push('', `## Open threads (${open.length})`, '');
  for (const t of open) lines.push(`- ${t.text} — opened by ${t.opened_by}, ${fmtDate(t.opened_t)} (\`${t.id}\`)`);
  const closed = [...e.threads.values()].filter((t) => t.closed && (!from || t.closed.t >= from) && (!to || t.closed.t < to));
  if (closed.length) { lines.push('', '## Closed in this range', ''); for (const t of closed) lines.push(`- ${t.text} — closed by ${t.closed.by} (${t.closed.how})`); }
  return lines.join('\n') + '\n';
}
