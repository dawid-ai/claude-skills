// Automatic Tier 2 extraction, opt-in ("extraction": {"auto": "api" | "claude"}). The server asks this on every tick;
// it runs at session end, when a strong candidate lands, and every `everyMinutes` while there is new work. One run at
// a time, a minimum gap between runs, and exponential backoff on failure. Every attempt is an extract.auto event.
import fs from 'node:fs';
import { pending, extractNow } from './extract.mjs';
import { writeHumanEvent } from './log.mjs';

const MIN = 60000;

export class AutoExtractor {
  constructor(pr, { ask, now = () => Date.now() } = {}) {
    this.pr = pr; this.ask = ask; this.now = now;
    this.running = null; this.fails = 0; this.lastAttempt = 0;
    // Resume from the log so a server restart does not re-run immediately.
    const run = pr.engine.lastExtract, auto = pr.engine.lastAuto;
    this.lastRun = Math.max(run ? run.t : 0, auto && auto.ok ? auto.t : 0);
    if (auto) { this.lastAttempt = auto.t; this.fails = auto.fails; }
  }

  cfg() { return this.pr.cfg.extraction || {}; }
  enabled() { const a = this.cfg().auto; return (a === 'api' || a === 'claude') && !this.pr.cfg.private; }

  /** Why a run should start now, or null. Pure apart from reading the engine. */
  reason(t = this.now()) {
    if (!this.enabled() || this.running) return null;
    const c = this.cfg();
    const gap = (c.minGapMinutes ?? 5) * MIN * 2 ** Math.min(this.fails, 6);
    if (t - this.lastAttempt < gap) return null;
    const cands = pending(this.pr, { min: this.pr.cfg.threshold, limit: 1000 });
    if (!cands.length) return null;
    const ended = this.pr.engine.sessionList().filter((s) => s.ended && !s.demo).map((s) => s.end).reduce((a, b) => Math.max(a, b), 0);
    // Compared with the last good run, so a failed attempt at session end is retried once the backoff allows.
    if (ended > this.lastRun && cands.some((m) => m.t1 <= ended)) return 'session-end';
    if (cands.some((m) => m.score >= (c.urgentScore ?? 70))) return 'strong-candidate';
    if (t - Math.max(this.lastRun, this.lastAttempt) >= (c.everyMinutes ?? 30) * MIN) return 'interval';
    return null;
  }

  /** Start a run if one is due. Returns the promise of the run, or null. */
  maybeRun(t = this.now()) {
    const why = this.reason(t);
    return why ? this.run(why, t) : null;
  }

  run(trigger, t = this.now()) {
    const pr = this.pr, c = this.cfg();
    this.lastAttempt = t;
    const sid = (pr.engine.sessionList().filter((s) => !s.demo).pop() || {}).sid;
    this.running = extractNow(pr, { via: c.auto === 'claude' ? 'claude' : 'api', model: c.model, min: pr.cfg.threshold, limit: c.limit ?? 12, ask: this.ask })
      .then((r) => {
        this.fails = 0; this.lastRun = this.now();
        const a = r.accepted || {};
        writeHumanEvent(pr.root, 'extract.auto', { trigger, via: c.auto, ok: true, none: !!r.none, kept: a.moments || 0, merged: a.merges || 0, dropped: a.drops || 0, rejected: (r.rejected || []).length }, { sid, actor: 'extractor' });
        return r;
      })
      .catch((e) => {
        this.fails++;
        const error = String(e && e.message || e).slice(0, 300);
        writeHumanEvent(pr.root, 'extract.auto', { trigger, via: c.auto, ok: false, error }, { sid, actor: 'extractor' });
        try { fs.appendFileSync(pr.p.hooklog, `${new Date().toISOString()} auto-extraction (${trigger}): ${error}\n`); } catch { /* best effort */ }
        return { error };
      })
      .finally(() => { this.running = null; try { pr.sync(); } catch { /* next tick */ } });
    return this.running;
  }
}
