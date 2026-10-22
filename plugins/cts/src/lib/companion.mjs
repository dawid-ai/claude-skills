// The terminal companion (`cts watch`): last five moments, open threads, drafts waiting, and what each actor is doing,
// sized for a narrow split pane next to Claude Code. Pure: data in, lines out.
import { trunc, ago } from './util.mjs';

/** The payload the server returns at /api/companion. */
export function companionData(pr, now = Date.now()) {
  const e = pr.engine;
  const ms = e.listMoments({ min: pr.cfg.threshold });
  return {
    root: pr.root, now, summary: pr.summary(), header: e.header(), pending: e.drafts.pendingCount(),
    moments: ms.slice(-5).reverse().map((m) => ({ id: m.id, kind: m.kind, score: m.score, headline: m.headline, t1: m.t1, status: m.status })),
    threads: e.openThreads().slice(0, 3).map((t) => ({ id: t.id, text: t.text, opened_t: t.opened_t })),
  };
}

const C = { dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m', acc: '\x1b[38;5;209m', cyan: '\x1b[36m' };

export function renderCompanion(d, { width = 48, color = true, port = null } = {}) {
  const c = color ? C : { dim: '', bold: '', off: '', acc: '', cyan: '' };
  const w = Math.max(28, width);
  const line = (s = '') => trunc(s, w);
  const out = [];
  const sm = d.summary;
  out.push(`${c.bold}CTS${c.off} ${c.dim}${line(String(d.root).split(/[\\/]/).pop())}${c.off}${sm.paused ? `  ${c.acc}PAUSED${c.off}` : ''}`);
  const n = (k, one, many = one + 's') => `${k} ${k === 1 ? one : many}`;
  out.push(c.dim + line(`${n(sm.moments, 'moment')} · ${sm.openThreads} open · ${n(d.pending, 'draft')} to review`) + c.off);
  out.push('');
  if (!d.moments.length) out.push(c.dim + line('No moments yet. Work as usual; `cts mark` flags one.') + c.off);
  for (const m of d.moments) {
    const head = `${String(m.score).padStart(3)} ${m.kind}`;
    out.push(`${m.kind === 'mark' ? c.acc : c.cyan}${head}${c.off} ${c.dim}${ago(d.now - m.t1)} ago${c.off}`);
    out.push('    ' + trunc(m.headline, w - 4));
  }
  if (d.threads.length) {
    out.push('', `${c.bold}Open${c.off}`);
    for (const t of d.threads) out.push(line(`  ? ${t.text}`) + `${c.dim} ${ago(d.now - t.opened_t)}${c.off}`);
  }
  const h = d.header;
  if (h && !h.ended) {
    const busy = h.actors.filter((a) => a.status && a.id !== 'human' && a.status.glyph !== 'done');
    if (busy.length) {
      out.push('', `${c.bold}Now${c.off}`);
      for (const a of busy.slice(0, 4)) out.push(line(`  ${a.label}: ${a.status.text || a.status.glyph}`));
    }
  }
  if (port) out.push('', c.dim + line(`http://localhost:${port}`) + c.off);
  return out;
}
