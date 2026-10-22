#!/usr/bin/env node
// Local CTS server: static dashboard + JSON API + Server-Sent Events. Binds to 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Project } from './lib/project.mjs';
import { findRoot, paths, pidAlive, readJson, loadConfig, SERVER_FLAGS } from './lib/util.mjs';
import { writeHumanEvent } from './lib/log.mjs';
import { slim } from './lib/summary.mjs';
import { buildStoryHtml } from './lib/share.mjs';
import * as N from './lib/narrative.mjs';
import * as PB from './lib/publish.mjs';
import { loadVoice, acceptSuggestion, undoSuggestion } from './lib/voice.mjs';
import { postsOf } from './lib/drafts.mjs';
import { notifyDrafts } from './lib/notify.mjs';
import { companionData } from './lib/companion.mjs';
import { getSettings, applySettings } from './lib/settings.mjs';
import { AutoExtractor } from './lib/autoextract.mjs';
import { trim } from './lib/retention.mjs';
import { register, listProjects, projectSummaries } from './lib/registry.mjs';
import { DatabaseSync } from './lib/db.mjs';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DASH = path.join(HERE, '..', 'dashboard');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

export async function startServer({ root, port, quiet = false, idleMs = 3600e3, tickMs = 250, notifySend, extractAsk, storyAsk } = {}) {
  const pr = Project.open(root);
  const p = paths(root);
  const existing = readJson(p.server);
  if (existing && pidAlive(existing.pid) && existing.pid !== process.pid) return { already: existing };

  const clients = new Set();
  let lastActivity = Date.now();
  const state = () => ({
    summary: pr.summary(), header: pr.engine.header(), sessions: pr.engine.sessionList(), moments: pr.engine.listMoments(), threads: [...pr.engine.threads.values()],
    arcs: pr.engine.arcs(), threshold: pr.cfg.threshold, root: path.basename(root), now: Date.now(), kinds: Object.keys(pr.engine.cfg.detectors.weights).length ? undefined : undefined,
  });
  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (event, data) => { for (const c of clients) { try { send(c, event, data); } catch { clients.delete(c); } } };

  const draftsPayload = () => {
    const store = pr.engine.drafts;
    const list = store.list().map((d) => {
      const chk = N.checkDraft(pr, d);
      const ch = (pr.cfg.publishing.channels || {})[d.channel] || {};
      return { ...d, posts: postsOf(d.text).map((t) => ({ text: t, chars: t.length })), limit: ch.limit || null, guard: chk, mode: N.modeFor(pr, d.kind, d.channel), cap: ch.cap ?? null, publishedToday: store.publishedToday(d.channel) };
    });
    return { drafts: list, suggestions: [...store.suggestions.values()], paused: PB.isPaused(pr), counts: N.counts(pr), channels: Object.keys(pr.cfg.publishing.channels || {}), private: !!pr.cfg.private, version: store.version };
  };
  let sentVersion = -1, lastQueue = 0, actual = null, lastAutoCheck = 0;
  const auto = new AutoExtractor(pr, { ask: extractAsk });
  try { register(root); } catch { /* the registry is a convenience */ }
  const runTrim = (opts = {}) => {
    const r = trim(pr, Project, opts);
    if (r.applied) { sentVersion = -1; broadcast('reload', {}); }
    if (r.applied || r.problem) fs.appendFileSync(p.hooklog, `${new Date().toISOString()} retention: ${r.applied ? `removed ${r.plan.drop} raw events from ${r.plan.sids.length} session(s)` : r.problem}\n`);
    return r;
  };
  // Retention is opt-in (retentionDays > 0): a minute after start, then daily.
  const retention = () => { try { if (pr.cfg.retentionDays > 0) runTrim(); } catch (e) { fs.appendFileSync(p.hooklog, `${new Date().toISOString()} retention: ${e.stack}\n`); } };
  const retentionStart = setTimeout(retention, 60000); retentionStart.unref();
  const retentionDaily = setInterval(retention, 86400000); retentionDaily.unref();
  // Autopilot drafts: templates at once, or storyteller runs one at a time (a run asked for while one is busy follows it).
  let stories = null, again = false;
  const drafting = () => {
    const w = pr.cfg.drafts.writer;
    if (w !== 'claude' && w !== 'api') return N.autoDrafts(pr);
    if (stories) { again = true; return; }
    stories = N.autoStories(pr, { via: w, ask: storyAsk })
      .catch((e) => fs.appendFileSync(p.hooklog, `${new Date().toISOString()} storyteller: ${e.stack}\n`))
      .finally(() => { stories = null; if (again) { again = false; drafting(); } });
  };
  const tick = () => {
    try {
      const { events, ch, reset } = pr.sync();
      if (reset) broadcast('reload', {});
      if (ch.moments.size && !pr.cfg.private) drafting();
      if (Date.now() - lastQueue > 15000 || ch.drafts.size) { lastQueue = Date.now(); PB.runQueue(pr); }
      if (Date.now() - lastAutoCheck > 5000) { lastAutoCheck = Date.now(); auto.maybeRun(); }
      if (pr.engine.drafts.version !== sentVersion) {
        notifyDrafts(pr, { url: actual && `http://localhost:${actual}/`, send: notifySend });
        sentVersion = pr.engine.drafts.version;
        if (clients.size) broadcast('drafts', draftsPayload());
      }
      if (!events.length && !ch.moments.size) return;
      lastActivity = Date.now();
      if (clients.size) {
        broadcast('batch', {
          events: events.map(slim),
          moments: [...ch.moments].map((id) => pr.engine.moments.get(id)).filter(Boolean).map((m) => pr.engine.view(m)),
          threads: [...ch.threads].map((id) => pr.engine.threads.get(id)).filter(Boolean),
          sessions: pr.engine.sessionList().filter((s) => ch.sessions.has(s.sid)),
          arcs: ch.moments.size ? pr.engine.arcs() : undefined,
          header: pr.engine.header(), summary: pr.summary(),
        });
      }
    } catch (e) { fs.appendFileSync(p.hooklog, `${new Date().toISOString()} server tick: ${e.stack}\n`); }
  };
  try { if (!pr.cfg.private) drafting(); } catch (e) { fs.appendFileSync(p.hooklog, `${new Date().toISOString()} autopilot: ${e.stack}\n`); }
  const timer = setInterval(tick, tickMs);

  const json = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(b); };
  const body = (req) => new Promise((ok, no) => { let s = ''; req.on('data', (c) => { s += c; if (s.length > 1e6) no(new Error('too large')); }); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { no(e); } }); });

  const server = http.createServer(async (req, res) => {
    lastActivity = Date.now();
    const url = new URL(req.url, 'http://x');
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) { res.writeHead(403); return res.end('forbidden host'); }
    try {
      if (url.pathname === '/api/health') return json(res, 200, { ok: true, pid: process.pid, root, events: pr.engine.eventCount });
      if (url.pathname === '/api/summary') return json(res, 200, pr.summary());
      if (url.pathname === '/api/companion') { pr.sync(); return json(res, 200, companionData(pr)); }
      if (url.pathname === '/api/state') { pr.sync(); return json(res, 200, state()); }
      if (url.pathname === '/api/events') {
        const q = url.searchParams, list = (k) => (q.get(k) ? q.get(k).split(',') : undefined);
        const evs = pr.events({ sid: q.get('sid') || undefined, actors: list('actors'), kinds: list('kinds'), q: q.get('q') || undefined, from: +q.get('from') || undefined, to: +q.get('to') || undefined, before: q.get('before') || undefined, after: q.get('after') || undefined, limit: +q.get('limit') || 400, order: q.get('order') === 'asc' ? 'asc' : 'desc' });
        return json(res, 200, { events: evs.map(slim) });
      }
      if (url.pathname === '/api/activity') {
        const rows = pr.db.prepare('SELECT substr(ts,1,10) AS day, COUNT(*) AS n FROM events GROUP BY day ORDER BY day').all();
        return json(res, 200, { days: rows });
      }
      if (url.pathname === '/api/event') {
        const ev = pr.eventById(url.searchParams.get('id'));
        return ev ? json(res, 200, ev) : json(res, 404, { error: 'not found' });
      }
      if (url.pathname === '/api/transcript') {
        const ev = pr.eventById(url.searchParams.get('id'));
        if (!ev || !ev.tp) return json(res, 404, { error: 'event has no transcript reference' });
        let t;
        try { t = pr.transcript(ev.tp.path, ev.tp.off); } catch { t = null; }
        return t ? json(res, 200, { ...t, event: ev.id, actor: ev.actor }) : json(res, 410, { error: 'transcript no longer available', evidence: fs.existsSync(path.join(p.evidence)) });
      }
      if (url.pathname === '/api/evidence') {
        const f = path.join(p.evidence, path.basename(url.searchParams.get('moment') || '') + '.json');
        return fs.existsSync(f) ? json(res, 200, readJson(f)) : json(res, 404, { error: 'no evidence snapshot' });
      }
      if (url.pathname === '/api/drafts') { pr.sync(); return json(res, 200, draftsPayload()); }
      if (url.pathname === '/api/draft/card') {
        const d = pr.engine.drafts.get(url.searchParams.get('id') || '');
        const f = d && d.card ? path.join(p.cts, d.card) : null;
        if (!f || !f.startsWith(p.cts) || !fs.existsSync(f)) return json(res, 404, { error: 'no card' });
        res.writeHead(200, { 'content-type': MIME['.svg'], 'cache-control': 'no-store' }); return res.end(fs.readFileSync(f));
      }
      if (url.pathname === '/api/voice') return json(res, 200, { text: loadVoice(root).text });
      if (url.pathname === '/api/draft' && req.method === 'POST') {
        const origin = req.headers.origin;
        if (req.headers['x-cts'] !== '1' || (origin && new URL(origin).host !== req.headers.host)) return json(res, 403, { error: 'forbidden' });
        const b = await body(req);
        let r;
        switch (b.op) {
          case 'create': { const via = b.via || pr.cfg.drafts.writer; r = via === 'claude' || via === 'api' ? await N.writeStory(pr, b.source, { channel: b.channel, format: b.format, force: !!b.force, via, ask: storyAsk }) : N.createDraft(pr, b.source, { channel: b.channel, format: b.format, force: !!b.force }); break; }
          case 'approve': r = N.approve(pr, b.id, { at: b.at || undefined }); if (!r.error) { const pub = PB.publishDraft(pr, b.id); r.published = pub.ok ? pub.receipt : null; r.held = pub.ok ? null : pub.reason; } break;
          case 'edit': r = N.edit(pr, b.id, b.text); break;
          case 'decline': r = N.decline(pr, b.id, b.reason || ''); break;
          case 'publish': { const x = PB.publishDraft(pr, b.id); r = x.ok ? x : { error: x.reason }; break; }
          case 'kill': PB.setKillSwitch(pr, !!b.on); r = { ok: true }; break;
          case 'voice-accept': { const sg = pr.engine.drafts.suggestions.get(b.id); if (!sg) { r = { error: 'no such suggestion' }; break; } acceptSuggestion(root, sg); writeHumanEvent(root, 'voice.accept', { id: sg.id }, { actor: 'human' }); r = { ok: true }; break; }
          case 'voice-reject': writeHumanEvent(root, 'voice.reject', { id: b.id }, { actor: 'human' }); r = { ok: true }; break;
          case 'voice-undo': undoSuggestion(root, b.id); writeHumanEvent(root, 'voice.undo', { id: b.id }, { actor: 'human' }); r = { ok: true }; break;
          default: return json(res, 400, { error: 'unknown draft operation' });
        }
        pr.sync(); tick();
        return json(res, r.error ? 409 : 200, r);
      }
      if (url.pathname === '/api/settings' && req.method === 'GET') return json(res, 200, getSettings(root));
      if (url.pathname === '/api/settings' && req.method === 'POST') {
        const origin = req.headers.origin;
        if (req.headers['x-cts'] !== '1' || (origin && new URL(origin).host !== req.headers.host)) return json(res, 403, { error: 'forbidden' });
        const b = await body(req);
        const r = applySettings(root, b.changes);
        if (!r.ok) return json(res, 400, r);
        // Weights and thresholds change scores, so rebuild from the log with the new config.
        pr.cfg = loadConfig(root); pr.reindex(); sentVersion = -1; tick();
        broadcast('reload', {});
        return json(res, 200, { ...r, settings: getSettings(root) });
      }
      if (url.pathname === '/api/projects') return json(res, 200, { projects: projectSummaries(DatabaseSync, { current: root }) });
      if (url.pathname === '/api/project-open' && req.method === 'POST') {
        const origin = req.headers.origin;
        if (req.headers['x-cts'] !== '1' || (origin && new URL(origin).host !== req.headers.host)) return json(res, 403, { error: 'forbidden' });
        const b = await body(req);
        // Only projects already in the registry, never an arbitrary path from the request.
        const hit = listProjects().find((x) => path.resolve(x.root) === path.resolve(String(b.root || '')));
        if (!hit || !fs.existsSync(path.join(hit.root, '.cts'))) return json(res, 404, { error: 'not a registered CTS project' });
        const sf = path.join(hit.root, '.cts', 'server.json');
        const live = () => { const x = readJson(sf); return x && pidAlive(x.pid) ? x.port : null; };
        let port = live();
        if (!port) {
          spawn(process.execPath, [...SERVER_FLAGS, path.join(HERE, 'server.mjs'), '--root', hit.root, '--quiet'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
          for (let i = 0; i < 50 && !port; i++) { await new Promise((r) => setTimeout(r, 100)); port = live(); }
        }
        return port ? json(res, 200, { port }) : json(res, 504, { error: 'the other project\'s server did not start' });
      }
      if (url.pathname === '/api/trim' && req.method === 'POST') {
        const origin = req.headers.origin;
        if (req.headers['x-cts'] !== '1' || (origin && new URL(origin).host !== req.headers.host)) return json(res, 403, { error: 'forbidden' });
        const b = await body(req);
        const r = runTrim({ days: b.days, dryRun: !!b.dryRun });
        const { files, ...plan } = r.plan;
        return json(res, 200, { ...r, plan: { ...plan, files: (files || []).map((x) => ({ f: x.f, drop: x.drop, bytes: x.bytes })) } });
      }
      if (url.pathname === '/api/share/story.html') {
        const html = buildStoryHtml(pr, { range: url.searchParams.get('range') });
        res.writeHead(200, { 'content-type': MIME['.html'] }); return res.end(html);
      }
      if (url.pathname === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write('retry: 1000\n\n');
        clients.add(res);
        send(res, 'hello', { pid: process.pid });
        const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* closed */ } }, 15000);
        req.on('close', () => { clearInterval(ka); clients.delete(res); });
        return;
      }
      if (url.pathname === '/api/action' && req.method === 'POST') {
        const origin = req.headers.origin;
        if (req.headers['x-cts'] !== '1' || (origin && new URL(origin).host !== req.headers.host)) return json(res, 403, { error: 'forbidden' });
        const b = await body(req);
        const sid = b.sid || undefined;
        const map = { mark: 'mark', confirm: 'confirm', dismiss: 'dismiss', rescore: 'rescore', merge: 'merge', 'thread-close': 'thread.close' };
        if (!map[b.type]) return json(res, 400, { error: 'unknown action' });
        const d = { ...(b.data || {}) };
        const ev = writeHumanEvent(root, map[b.type], d, { sid });
        tick();
        return json(res, 200, { ok: true, event: ev.id });
      }
      // static
      let rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
      const f = path.normalize(path.join(DASH, rel));
      if (!f.startsWith(DASH) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      fs.createReadStream(f).pipe(res);
    } catch (e) {
      json(res, 500, { error: String(e.message || e) });
    }
  });

  const listen = (n) => new Promise((ok, no) => {
    server.once('error', (e) => (e.code === 'EADDRINUSE' ? ok(false) : no(e)));
    server.listen(n, '127.0.0.1', () => ok(true));
  });
  let chosen = port ?? pr.cfg.port;
  if (chosen === 0) await listen(0);
  else for (let i = 0; i < 100; i++) { if (await listen(chosen)) break; chosen++; server.removeAllListeners('error'); }
  actual = server.address().port;
  fs.writeFileSync(p.server, JSON.stringify({ pid: process.pid, port: actual, root, started: new Date().toISOString() }));
  const idle = setInterval(() => { if (!clients.size && Date.now() - lastActivity > idleMs) stop(); }, 30000);
  function stop() {
    clearInterval(timer); clearInterval(idle); clearTimeout(retentionStart); clearInterval(retentionDaily);
    for (const c of clients) { try { c.end(); } catch { /* gone */ } }
    server.close();
    try { const s = readJson(p.server); if (s && s.pid === process.pid) fs.rmSync(p.server); } catch { /* ignore */ }
    pr.close();
  }
  if (!quiet) process.stdout.write(`CTS dashboard: http://localhost:${actual}\n`);
  return { port: actual, stop, pr, server, tick, auto };
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const a = process.argv.slice(2);
  const get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const root = get('--root') || findRoot(process.cwd());
  const s = await startServer({ root, port: get('--port') ? +get('--port') : undefined, quiet: a.includes('--quiet') });
  if (s.already) process.exit(0);
  const bye = () => { s.stop(); process.exit(0); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
  process.on('exit', () => { try { fs.rmSync(paths(root).server, { force: true }); } catch { /* ignore */ } });
}
