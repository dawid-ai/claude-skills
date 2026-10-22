// Draft state is a reducer over draft.* / publish.* / voice.* events, so it is rebuilt by replaying the log like everything else.
import crypto from 'node:crypto';

export const textHash = (t) => crypto.createHash('sha1').update(String(t), 'utf8').digest('hex');
export const POST_SEP = '\n\n---\n\n';
export const postsOf = (text) => String(text).split(/\n\s*---\s*\n/).map((x) => x.trim()).filter(Boolean);
const DAY = 86400000;

export class DraftStore {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.drafts = new Map();
    this.declined = new Set();          // source ids that were declined: never regenerated unless forced
    this.pubPaused = false;
    this.suggestions = new Map();       // id -> {id,key,value,why,status}
    this.removals = new Map();          // word -> distinct draft ids where the user deleted it
    this.version = 0;
  }
  isDraftKind(kind) { return kind.startsWith('draft.') || kind.startsWith('publish.') || kind.startsWith('voice.'); }

  apply(ev, t) {
    const d = ev.d || {};
    this.version++;
    switch (ev.kind) {
      case 'draft.create': {
        this.drafts.set(d.draft, {
          id: d.draft, source: d.source, channel: d.channel, format: d.format, text: d.text, original: d.text, claims: d.claims || { refs: [], extra: [] },
          redaction: d.redaction || { summary: {}, count: 0 }, card: d.card || null, status: 'pending', created_ts: ev.ts, created_t: t, sid: ev.sid,
          edits: [], approval: null, declined: null, receipts: [], fails: [], origin: d.origin || 'manual', score: d.score || 0, kind: d.kind || null,
          voice_rev: d.voice_rev || null, title: d.title || null, mode: d.mode || 'draft', notify: d.mode === 'notify', notified: null, writer: d.writer || 'template',
        });
        break;
      }
      case 'draft.edit': {
        const x = this.drafts.get(d.draft); if (!x || x.status === 'published' || x.status === 'declined') break;
        x.edits.push({ event: ev.id, ts: ev.ts, from: x.text, removed: d.removed || [] });
        x.text = d.text; x.redaction = d.redaction || x.redaction;
        x.approval = null; x.status = 'pending';       // an edit always voids a previous approval
        for (const w of d.removed || []) { if (!this.removals.has(w)) this.removals.set(w, new Set()); this.removals.get(w).add(x.id); }
        break;
      }
      case 'draft.approve': {
        const x = this.drafts.get(d.draft); if (!x || x.status === 'published' || x.status === 'declined') break;
        if (d.text_hash !== textHash(x.text)) break;   // approval of text that is no longer the draft: void
        x.status = 'approved'; x.approval = { event: ev.id, ts: ev.ts, t, actor: ev.actor, via: d.via || 'human', rule: d.rule || null, at: d.at || null, text_hash: d.text_hash };
        break;
      }
      case 'draft.decline': {
        const x = this.drafts.get(d.draft); if (!x || x.status === 'published') break;
        x.status = 'declined'; x.declined = { ts: ev.ts, reason: d.reason || null }; x.approval = null;
        this.declined.add(x.source.id);
        break;
      }
      case 'draft.publish': {
        const x = this.drafts.get(d.draft); if (!x) break;
        x.status = 'published'; x.receipts.push({ ts: ev.ts, t, channel: d.channel, receipt: d.receipt, request_id: d.request_id, event: ev.id });
        break;
      }
      case 'draft.notify': { const x = this.drafts.get(d.draft); if (x) x.notified = { ts: ev.ts, via: d.via || [] }; break; }
      case 'draft.fail': { const x = this.drafts.get(d.draft); if (x) x.fails.push({ ts: ev.ts, error: d.error }); break; }
      case 'publish.pause': this.pubPaused = true; break;
      case 'publish.resume': this.pubPaused = false; break;
      case 'voice.suggest': if (!this.suggestions.has(d.id)) this.suggestions.set(d.id, { id: d.id, key: d.key, value: d.value, why: d.why, draft: d.draft, status: 'offered', ts: ev.ts }); break;
      case 'voice.accept': { const s = this.suggestions.get(d.id); if (s) s.status = 'accepted'; break; }
      case 'voice.reject': { const s = this.suggestions.get(d.id); if (s) s.status = 'rejected'; break; }
      case 'voice.undo': { const s = this.suggestions.get(d.id); if (s) s.status = 'undone'; break; }
      default: break;
    }
  }

  expireMs() { return (this.cfg.expireDays ?? 7) * DAY; }
  /** status as the reader sees it: pending drafts past their expiry read as expired */
  statusOf(x, now = Date.now()) { return x.status === 'pending' && now - x.created_t > this.expireMs() ? 'expired' : x.status; }
  view(x, now = Date.now()) { return { ...x, status: this.statusOf(x, now), expires_t: x.created_t + this.expireMs() }; }
  list({ status, channel } = {}, now = Date.now()) {
    return [...this.drafts.values()].map((x) => this.view(x, now)).filter((x) => (!status || x.status === status) && (!channel || x.channel === channel)).sort((a, b) => b.created_t - a.created_t);
  }
  get(idOrPrefix) {
    if (this.drafts.has(idOrPrefix)) return this.drafts.get(idOrPrefix);
    const hit = [...this.drafts.values()].filter((x) => x.id.startsWith(idOrPrefix) || x.id.endsWith(idOrPrefix));
    return hit.length === 1 ? hit[0] : null;
  }
  existsFor(sourceId, channel, format) { return [...this.drafts.values()].some((x) => x.source.id === sourceId && x.channel === channel && x.format === format && x.status !== 'declined'); }
  publishedToday(channel, now = Date.now()) {
    const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
    let n = 0;
    for (const x of this.drafts.values()) for (const r of x.receipts) if (r.channel === channel && r.t >= d0.getTime()) n++;
    return n;
  }
  pendingCount() { return this.list({ status: 'pending' }).length; }
}
