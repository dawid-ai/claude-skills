import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findRoot, paths, ensureProject, readJson, pidAlive, loadConfig, ago, trunc, SERVER_FLAGS } from './lib/util.mjs';
import { writeHumanEvent } from './lib/log.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const HELP = {
  _: `cts - Capture The Struggle

usage: cts <command> [options]      (in Claude Code: /cts:<command>)

  init [--demo] [--statusline]   create .cts/, optionally load the sample session / enable the status line
  open [--no-browser]            start the server if needed and open the dashboard
  watch [--once] [--plain]       terminal companion for a split pane: last five moments, open threads, drafts
  status                         server state, event count, last moment
  mark [note]                    flag the current moment (score 100); "mark ? note" opens a thread instead
  dismiss                        dismiss the latest auto-detected moment (lowers that detector's weight)
  confirm <moment-id>            confirm a moment
  threads [close <id>]           list open threads with age, or close one
  extract [status|prepare|apply|run]  Tier 2 extraction (see cts extract --help)
  draft [moment|arc:<id>|last|auto]  draft posts into the review queue (--channel x --format thread --force)
  queue [list|show|approve|decline|edit|publish] <id>   the review queue; nothing publishes without approval
  voice [init|show|suggestions|accept|reject|undo]   your voice profile (.cts/voice.md)
  pause publishing | resume publishing   the kill switch: stops every outgoing post
  digest [today|week|session]    run extraction now and print the digest (also writes .cts/digests/)
  pause | resume                 stop / restart capture; the gap is logged as a paused span
  reindex                        rebuild index.sqlite from the JSONL logs
  trim [--days N] [--yes]        retention: rehearse (default) or apply removing old sessions' raw events
  share [--cards] [--png] [--out dir]  redacted static Story page, optionally SVG (and PNG) share cards
  export <moments|threads|events|marks|markdown|otel|replay|bundle>   see cts export --help
  import git|transcripts|bundle|events|marks|posts   bring history, backups, journals and past posts in (cts import --help)
  migrate                        upgrade log files to the current schema (runs on server start too)
  demo [clear]                   load (or remove) a sample session
  statusline                     one-line status for Claude Code's statusLine setting
  subagent-statusline            per-subagent moment counts for the agent panel (set by the plugin)
  doctor                         check Node version, hooks log, server, paused state
  consent [verbatim|summary]     whether YOUR prompts appear verbatim or withheld in shared output (story, cards, exports, drafts)
  serve [--port N]               run the server in the foreground

Every command accepts --help.`,
  mark: 'cts mark [note]\n  Flag the current moment with an optional one-line note (score 100).\n  cts mark ? [note]   opens a thread instead (an undecided question).',
  dismiss: 'cts dismiss\n  Dismiss the most recent auto-detected moment and lower that detector\'s weight for this project.',
  watch: 'cts watch [--once] [--plain]\n  A slim live view for a terminal split next to Claude Code: the last five moments, open threads, drafts waiting and\n  what each actor is doing. Redraws on every new event. --once prints it once without the server; --plain drops colour.',
  open: 'cts open [--no-browser]\n  Start the dashboard server if it is not running and open it (default port 4848, +1 until free).',
  status: 'cts status\n  Server state, event count, open threads and the last moment.',
  threads: 'cts threads [close <id-prefix>]\n  List open threads with their age. "close" forces one closed.',
  digest: 'cts digest [today|week|session] [--extract|--no-extract]\n  Run extraction first (when "extraction.auto" is set, or with --extract), then print the digest and write it to .cts/digests/.',
  pause: 'cts pause\n  Stop capturing events. Nothing from the paused span is stored.',
  resume: 'cts resume\n  Resume capture.',
  share: 'cts share [--cards] [--out dir]\n  Write story.html (redacted) and, with --cards, SVG cards at X, LinkedIn, OG and square sizes for the top moments.',
  export: 'cts export <what> [--out path] [--format json|csv|ndjson] [--raw]\n  moments|threads|events   flat tables (json, csv; events also ndjson). Redacted by default; --raw is lossless and for local use.\n  marks                    your marks as a Markdown journal (cts import marks reads it back)\n  markdown                 arcs as articles, digests and drafts as .md files (redacted) into a folder\n  otel                     OpenTelemetry OTLP/JSON traces: sessions, tool calls, agents, moments\n  replay [--session id] [--out f]   animated replay: .html works anywhere; .mp4/.gif need Chrome/Edge and ffmpeg\n  bundle [--out f.cts.zip] full private backup of .cts/ (not redacted). Merge it elsewhere with cts import bundle',
  draft: 'cts draft [moment-id|arc:<arc-id>|last] [--channel x] [--format short|thread|linkedin|long|devlog] [--force] [--via template|claude|api]\n  Draft a post from a moment or arc into the review queue and print it. Drafts are redacted and honesty-checked.\n  --via claude (your Claude Code login) or api (ANTHROPIC_API_KEY) has a model tell it as a story from redacted material;\n  a story with a quote, a command, a path, a copied prompt or an untraceable number is dropped for the template. Default: drafts.writer.\n  cts draft auto   draft whatever your autopilot rules (cts.json "drafts") say to draft.',
  queue: 'cts queue [list|show <id>|approve <id> [--at ISO|--next]|decline <id> [reason]|edit <id> [file|-]|publish [id]]\n  The review queue. approve records your approval and publishes now (or at --at / the channel\'s next slot).\n  Published means: written to .cts/outbox/<channel>/ (social), or to the blog/newsletter/CHANGELOG file. Nothing is sent to a network.',
  voice: 'cts voice [init|show|suggestions|accept <id>|reject <id>|undo <id>]\n  Your voice profile. Suggestions come from your edits to drafts; nothing is saved without accept.',
  extract: 'cts extract status|prepare|apply|run\n  Tier 2 extraction. `prepare [--limit N] [--min S]` prints the packet (candidates + only the spans they need).\n  `apply [file]` validates a JSON answer (stdin if no file) and appends extract.* events; anything that cites a missing event, an untraceable number or a non-quote is rejected with the reason.\n  `run [--via api|claude] [--model M]` does both: --via api (default) uses ANTHROPIC_API_KEY; --via claude uses your Claude Code login through `claude -p` (no tools, no saved session).\n  Rejected items get one repair round. To run it automatically, set "extraction": {"auto": "api"} or {"auto": "claude"} in .cts/cts.json; the dashboard server then runs it\n  at session end, when a candidate scores over extraction.urgentScore, and every extraction.everyMinutes while there is new work.',
  import: 'cts import bundle <file.cts.zip>   merge a bundle by event id (never overwrites local files)\ncts import events <file.ndjson|json>   merge a raw events export\ncts import marks <journal.md>   dated notes become human marks ("## 2026-10-20" then "- 14:30 note", "- ? 15:10 question")\ncts import posts <file.json|csv>   past posts (ts, channel, url, text, optional moment) become receipts attached to their moments\ncts import git [--repo <path>]\n  Create shipped/revert events from merges, reverts and tags in git history (of --repo, read-only, or this project).\ncts import transcripts [--since <days>] [--dir <path>] [--dry-run]\n  Rebuild the log for sessions that ran before CTS from ~/.claude/projects/<project>/ (subagent transcripts included).',
  init: 'cts init [--demo] [--statusline]\n  Create .cts/. --demo loads the sample session. --statusline writes statusLine into .claude/settings.local.json.',
  demo: 'cts demo [clear]\n  Load a sample two-session project, or remove it.',
  reindex: 'cts reindex\n  Delete index.sqlite and rebuild it from .cts/sessions/*.jsonl.',
  'subagent-statusline': 'cts subagent-statusline\n  Reads Claude Code\'s agent-panel JSON on stdin and prints one row per subagent that has CTS moments.\n  The plugin\'s settings.json registers it; nothing to set up.',
  statusline: 'cts statusline\n  Prints "CTS ● 3 moments · 2 open threads · last: ..." or nothing if the server is down.',
  doctor: 'cts doctor\n  Environment check.',
  consent: 'cts consent [verbatim|summary]\n  Shows or sets how your own prompts appear in shared output: the story page, cards, exports, replays and drafts.\n  The setting is stored in .cts/cts.json under "people" by a hash of your name (CTS_USER, "me" in ~/.cts/config.json, or your OS user),\n  so teammates who commit .cts/ honour it in what they share. Your local dashboard always shows everything.',
  trim: 'cts trim [--days N] [--yes]\n  Retention. Sessions that ended more than N days ago (default: retentionDays in .cts/cts.json) lose their raw events:\n  prompts, tool calls and output. Moments, threads, arcs, drafts, decisions and every event they cite stay, and the derived\n  state is saved to .cts/retention.json so reindex reproduces the same dashboard. The trim is rehearsed on a copy first and\n  refused if the copy differs. Without --yes it only reports. With retentionDays > 0 the dashboard server runs it daily.',
  serve: 'cts serve [--port N]\n  Run the dashboard server in the foreground.',
  confirm: 'cts confirm <moment-id>\n  Confirm a moment (boosts its score to at least 80).',
};

const flag = (args, name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const opt = (args, name) => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const out = (s = '') => process.stdout.write(s + '\n');

function httpGetJson(port, p, timeout = 400) {
  return new Promise((ok) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout }, (r) => { let s = ''; r.on('data', (c) => (s += c)); r.on('end', () => { try { ok(JSON.parse(s)); } catch { ok(null); } }); });
    req.on('error', () => ok(null)); req.on('timeout', () => { req.destroy(); ok(null); });
  });
}
async function liveServer(root) {
  const s = readJson(paths(root).server);
  if (!s || !pidAlive(s.pid)) return null;
  const h = await httpGetJson(s.port, '/api/health');
  return h && h.ok ? s : null;
}
async function ensureServer(root) {
  let s = await liveServer(root);
  if (s) return s;
  const child = spawn(process.execPath, [...SERVER_FLAGS, path.join(HERE, 'server.mjs'), '--root', root, '--quiet'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 100)); s = await liveServer(root); if (s) return s; }
  return null;
}
function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch { /* user can open the URL */ }
}
async function project(root) { const { Project } = await import('./lib/project.mjs'); return Project.open(root); }

async function killSwitch(root, on) {
  const pr = await project(root); const PB = await import('./lib/publish.mjs');
  try { PB.setKillSwitch(pr, on); } finally { pr.close(); }
  return out(on ? 'publishing paused: nothing goes out, scheduled posts included, until: cts resume publishing' : 'publishing resumed');
}
const showDraft = (x) => {
  out(`${x.id}  [${x.status}]  ${x.channel}/${x.format}  ${x.kind || ''} ${x.score || ''}`);
  out('─'.repeat(60)); out(x.text); out('─'.repeat(60));
};

export async function main(argv) {
  const args = argv.slice();
  const cmd = args.shift();
  const root = findRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return out(HELP._);
  if (args.includes('--help') || args.includes('-h')) return out(HELP[cmd] || HELP._);
  const cfg = loadConfig(root);

  switch (cmd) {
    case 'mark': {
      let flagQ = null;
      if (args[0] === '?') { flagQ = '?'; args.shift(); }
      const note = args.join(' ').trim();
      const ev = writeHumanEvent(root, 'mark', { note, flag: flagQ });
      return out(flagQ ? `opened a thread${note ? ': ' + note : ''}` : `marked${note ? ': ' + note : ''} (${ev.id.slice(-6)})`);
    }
    case 'dismiss': writeHumanEvent(root, 'dismiss', {}); return out('dismissed the latest auto-detected moment');
    case 'confirm': { if (!args[0]) return out(HELP.confirm); writeHumanEvent(root, 'confirm', { target: args[0] }); return out('confirmed ' + args[0]); }
    case 'pause': { if (args[0] === 'publishing') return killSwitch(root, true); const p = paths(root); fs.mkdirSync(p.cts, { recursive: true }); if (fs.existsSync(p.paused)) return out('already paused'); writeHumanEvent(root, 'pause', {}); fs.writeFileSync(p.paused, new Date().toISOString()); return out('capture paused. nothing is recorded until: cts resume'); }
    case 'resume': { if (args[0] === 'publishing') return killSwitch(root, false); const p = paths(root); if (!fs.existsSync(p.paused)) return out('not paused'); fs.rmSync(p.paused); writeHumanEvent(root, 'resume', {}); return out('capture resumed'); }
    case 'init': {
      ensureProject(root);
      try { (await import('./lib/registry.mjs')).register(root); } catch { /* the registry is a convenience */ }
      if (flag(args, '--demo')) { const { writeDemo } = await import('./lib/sample.mjs'); writeDemo(root); out('loaded the sample session (cts demo clear removes it)'); }
      if (flag(args, '--statusline')) {
        const f = path.join(root, '.claude', 'settings.local.json');
        const cur = readJson(f, {});
        cur.statusLine = { type: 'command', command: `node "${path.join(HERE, '..', 'bin', 'cts')}" statusline` };
        fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(cur, null, 2) + '\n');
        out('status line enabled in ' + path.relative(root, f));
      } else out('tip: cts init --statusline adds a CTS segment to this project\'s Claude Code status line');
      return out(`ready: ${paths(root).cts}\nnext: cts open`);
    }
    case 'demo': {
      const { writeDemo, clearDemo } = await import('./lib/sample.mjs');
      if (args[0] === 'clear') { const n = clearDemo(root); const p = paths(root); for (const s of ['', '-wal', '-shm']) fs.rmSync(p.db + s, { force: true }); return out(`removed ${n} demo session file(s); index will rebuild on next start`); }
      writeDemo(root); return out('loaded the sample session. cts open');
    }
    case 'open': {
      const nb = flag(args, '--no-browser');
      const s = await ensureServer(root);
      if (!s) return out('could not start the server; run `cts serve` to see why');
      const url = `http://localhost:${s.port}`;
      out(url); if (!nb) openBrowser(url); return;
    }
    case 'watch': {
      const once = flag(args, '--once'), plain = flag(args, '--plain') || !process.stdout.isTTY;
      const { renderCompanion, companionData } = await import('./lib/companion.mjs');
      const width = () => Math.min(process.stdout.columns || 48, 72);
      if (once) { const pr = await project(root); const lines = renderCompanion(companionData(pr), { width: width(), color: !plain }); pr.close(); return out(lines.join('\n')); }
      const s = await ensureServer(root);
      if (!s) return out('could not start the server; run `cts serve` to see why');
      const draw = async () => {
        const d = await httpGetJson(s.port, '/api/companion', 2000);
        if (d) process.stdout.write('\x1b[2J\x1b[H' + renderCompanion(d, { width: width(), color: !plain, port: s.port }).join('\n') + '\n');
      };
      let pending = null;
      const soon = () => { clearTimeout(pending); pending = setTimeout(draw, 300); };
      const listen = () => {
        const req = http.get({ host: '127.0.0.1', port: s.port, path: '/api/stream' }, (r) => {
          r.setEncoding('utf8');
          r.on('data', (chunk) => { if (/event: (batch|drafts)/.test(chunk)) soon(); });
          r.on('end', () => setTimeout(listen, 2000));
        });
        req.on('error', () => setTimeout(listen, 2000));
      };
      await draw(); listen();
      setInterval(draw, 30000); // keeps the "ago" times honest when nothing happens
      process.stdout.on('resize', soon);
      process.on('SIGINT', () => { process.stdout.write('\n'); process.exit(0); });
      return new Promise(() => {});
    }
    case 'serve': {
      const { startServer } = await import('./server.mjs');
      const port = opt(args, '--port');
      const s = await startServer({ root, port: port ? +port : undefined });
      if (s.already) return out(`already running: http://localhost:${s.already.port}`);
      process.on('SIGINT', () => { s.stop(); process.exit(0); }); process.on('SIGTERM', () => { s.stop(); process.exit(0); });
      return;
    }
    case 'status': {
      const s = await liveServer(root);
      const pr = await project(root);
      const sm = pr.summary();
      out(`server:   ${s ? `running on http://localhost:${s.port} (pid ${s.pid})` : 'not running (capture does not need it)'}`);
      out(`capture:  ${sm.paused ? 'PAUSED' : 'on'}`);
      out(`events:   ${sm.events}   sessions: ${sm.sessions}   corrupt/truncated lines skipped: ${sm.bad}`);
      out(`moments:  ${sm.moments} above ${pr.cfg.threshold}   open threads: ${sm.openThreads}`);
      out(`last:     ${sm.last ? `${sm.last.kind} · ${sm.last.headline}` : 'none yet'}`);
      pr.close(); return;
    }
    case 'threads': {
      const pr = await project(root);
      if (args[0] === 'close') {
        const id = args[1]; if (!id) { pr.close(); return out(HELP.threads); }
        const th = [...pr.engine.threads.values()].find((t) => !t.closed && t.id.startsWith(id));
        if (!th) { pr.close(); return out('no open thread with that id'); }
        writeHumanEvent(root, 'thread.close', { target: th.id }, { sid: th.sid }); pr.close(); return out('closed: ' + th.text);
      }
      const open = pr.engine.openThreads();
      out(open.length ? `${open.length} open thread${open.length === 1 ? '' : 's'}:` : 'no open threads');
      for (const t of open.slice().reverse()) out(`  ${String(ago(Date.now() - t.opened_t)).padStart(4)}  ${t.kind.padEnd(10)} ${t.text}   [${t.opened_by}] ${t.id.slice(-8)}`);
      pr.close(); return;
    }
    case 'digest': {
      const { digestMarkdown } = await import('./lib/share.mjs');
      const pr = await project(root);
      const wantX = flag(args, '--extract'), noX = flag(args, '--no-extract');
      if (!noX && (wantX || pr.cfg.extraction.auto)) {
        const ex = await import('./lib/extract.mjs');
        try {
          const r = await ex.extractNow(pr, { via: pr.cfg.extraction.auto === 'claude' ? 'claude' : 'api', min: pr.cfg.threshold, limit: pr.cfg.extraction.limit });
          if (!r.none) process.stderr.write(`extraction: kept ${r.accepted.moments}, merged ${r.accepted.merges}, dropped ${r.accepted.drops}, rejected ${r.rejected.length}\n`);
        } catch (e) { process.stderr.write(`extraction skipped: ${e.message}\n`); }
      }
      const which = args[0] || 'today';
      const day = new Date(); day.setHours(0, 0, 0, 0);
      let from = day.getTime(), title = `CTS digest, ${day.toISOString().slice(0, 10)}`, file = day.toISOString().slice(0, 10);
      if (which === 'week') { from = day.getTime() - 6 * 86400e3; title = `CTS weekly digest, week to ${day.toISOString().slice(0, 10)}`; file = 'week-' + file; }
      if (which === 'session') { const sl = pr.engine.sessionList().filter((s) => !s.demo); const s = sl[sl.length - 1] || pr.engine.sessionList().pop(); from = s ? s.start : 0; title = 'CTS digest, latest session'; file = 'session-' + file; }
      const md = digestMarkdown(pr, { from, title });
      fs.mkdirSync(pr.p.digests, { recursive: true });
      fs.writeFileSync(path.join(pr.p.digests, file + '.md'), md);
      out(md); pr.close(); return;
    }
    case 'trim': {
      const days = opt(args, '--days'), yes = flag(args, '--yes');
      const body = { days: days != null ? +days : undefined, dryRun: !yes };
      const s = await liveServer(root);
      let r;
      if (s) r = await new Promise((ok) => {
        // The running server owns the index and the file offsets, so it does the trim.
        const req = http.request({ host: '127.0.0.1', port: s.port, path: '/api/trim', method: 'POST', headers: { 'content-type': 'application/json', 'x-cts': '1' }, timeout: 600000 }, (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => { try { ok(JSON.parse(t)); } catch { ok({ problem: 'bad reply from the server' }); } }); });
        req.on('error', (e) => ok({ problem: e.message })); req.end(JSON.stringify(body));
      });
      else {
        const pr = await project(root); const { trim } = await import('./lib/retention.mjs'); const { Project } = await import('./lib/project.mjs');
        try { r = trim(pr, Project, { days: body.days, dryRun: body.dryRun }); } finally { pr.close(); }
      }
      const pl = r.plan || {};
      if (r.problem && !pl.drop) return out('trim failed: ' + r.problem);
      if (!(pl.days > 0)) return out('retention is off: set "retentionDays" in .cts/cts.json, or pass --days N');
      if (!pl.drop) return out(`nothing to trim: no raw events older than ${pl.days} days outside what moments, threads and drafts cite`);
      out(`${r.applied ? 'removed' : 'would remove'} ${pl.drop} raw events (${Math.round(pl.bytes / 1024)} KB) from ${pl.sids.length} session(s) that ended before ${new Date(pl.cutoff).toISOString().slice(0, 10)}`);
      out('kept: moments, threads, arcs, drafts, decisions, session boundaries and every event they cite');
      if (r.problem) { process.exitCode = 2; return out('refused: ' + r.problem); }
      if (!r.applied) out('rehearsal on a copy: reproduces the dashboard exactly. Run `cts trim --yes` to apply.');
      return;
    }
    case 'consent': {
      const { whoAmI, promptPolicy } = await import('./lib/consent.mjs');
      const me = whoAmI(), choice = args[0];
      if (choice && !['verbatim', 'summary'].includes(choice)) return out(HELP.consent);
      if (choice) {
        const p = paths(root); const cur = readJson(p.config, {}) || {};
        cur.people = { ...(cur.people || {}), [me]: { ...((cur.people || {})[me] || {}), prompts: choice } };
        fs.writeFileSync(p.config + '.tmp', JSON.stringify(cur, null, 2) + '\n'); fs.renameSync(p.config + '.tmp', p.config);
      }
      const policy = promptPolicy({ cfg: loadConfig(root) }, me);
      return out(`your prompts in shared output: ${policy}${policy === 'summary' ? ' (withheld, replaced by a word count)' : ''} · you are ${me} in .cts/cts.json`);
    }
    case 'reindex': { const pr = await project(root); const t = Date.now(); pr.reindex(); out(`reindexed ${pr.eventCount()} events in ${Date.now() - t} ms`); pr.close(); return; }
    case 'share': {
      const { buildStoryHtml, publicData, cardSvg, CARD_SIZES } = await import('./lib/share.mjs');
      if (cfg.private) return out('this project is marked private in cts.json: sharing and export are disabled');
      const dir = path.resolve(opt(args, '--out') || path.join(paths(root).cts, 'share'));
      const cards = flag(args, '--cards'); const png = flag(args, '--png');
      const pr = await project(root);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'story.html'), buildStoryHtml(pr));
      out('wrote ' + path.join(dir, 'story.html'));
      if (cards) {
        const data = publicData(pr);
        const top = data.moments.slice().sort((a, b) => b.score - a.score).slice(0, 5);
        for (const m of top) for (const size of Object.keys(CARD_SIZES)) { const f = path.join(dir, `card-${m.kind}-${m.id.slice(0, 8)}-${size}.svg`); fs.writeFileSync(f, cardSvg(m, size)); }
        out(`wrote ${top.length * Object.keys(CARD_SIZES).length} SVG cards`);
        if (png) {
          const X = await import('./lib/exporters.mjs'); let n = 0;
          try { for (const m of top) for (const size of Object.keys(CARD_SIZES)) { X.cardPng(m, size, path.join(dir, `card-${m.kind}-${m.id.slice(0, 8)}-${size}.png`)); n++; } out(`wrote ${n} PNG cards`); }
          catch (e) { process.exitCode = 1; out('PNG: ' + e.message); }
        }
      }
      const rep = publicData(pr).report; out(`redaction: ${rep.length} item(s) masked`);
      pr.close(); return;
    }
    case 'export': {
      const what = args.shift();
      const KINDS_OUT = ['moments', 'threads', 'events', 'bundle', 'markdown', 'otel', 'marks', 'replay'];
      if (!KINDS_OUT.includes(what)) return out(HELP.export);
      const X = await import('./lib/exporters.mjs');
      const fmt = opt(args, '--format') || 'json'; const raw = flag(args, '--raw'); const outOpt = opt(args, '--out');
      const pr = await project(root);
      try {
        if (what === 'bundle') {
          const f = path.resolve(outOpt || `${path.basename(root)}-${new Date().toISOString().slice(0, 10)}.cts.zip`);
          const r = X.exportBundle(pr, f);
          return out(`wrote ${f}: ${r.files} files, ${r.events.toLocaleString()} events, ${(r.bytes / 1024).toFixed(0)} KB\nthis is a private backup (raw prompts and paths, not redacted). Restore or merge with: cts import bundle <file>`);
        }
        if (cfg.private) return out('this project is marked private in cts.json: sharing and export are disabled (bundle backups still work)');
        const { publicData, redactOpts } = await import('./lib/share.mjs');
        const { redactDeep } = await import('./lib/redact.mjs');
        const write = (text, def) => { if (outOpt) { fs.mkdirSync(path.dirname(path.resolve(outOpt)), { recursive: true }); fs.writeFileSync(outOpt, text); return out(`wrote ${path.resolve(outOpt)}`); } return def ? out(text) : process.stdout.write(text); };
        if (what === 'markdown') { const r = X.exportMarkdown(pr, path.resolve(outOpt || path.join(paths(root).cts, 'export', 'markdown'))); return out(`wrote ${r.arcs} arc article(s), ${r.digests} digest(s), ${r.drafts} draft(s) to ${r.dir} (redacted)`); }
        if (what === 'otel') return write(JSON.stringify(X.exportOtel(pr)), false);
        if (what === 'marks') return write(X.marksMarkdown(pr), false);
        if (what === 'replay') {
          const sid = opt(args, '--session'); const data = X.replayData(pr, { sid });
          if (!data) return out('nothing to replay yet');
          const target = path.resolve(outOpt || path.join(paths(root).cts, 'export', 'replay.html'));
          fs.mkdirSync(path.dirname(target), { recursive: true });
          if (/\.(mp4|gif)$/i.test(target)) { try { X.replayVideo(data, target); } catch (e) { process.exitCode = 1; return out('cannot render video: ' + e.message); } }
          else fs.writeFileSync(target, X.replayHtml(data));
          return out(`wrote ${target} (${data.events.length} events, ${data.moments.length} moments, redacted)`);
        }
        if (what === 'events' && (fmt === 'ndjson' || raw)) return write(X.eventsNdjson(pr, { raw }), false);
        const opts = redactOpts(pr);
        let rows;
        if (what === 'moments') rows = raw ? pr.engine.listMoments() : publicData(pr).moments;
        else if (what === 'threads') { rows = [...pr.engine.threads.values()].map((t) => ({ id: t.id, kind: t.kind, text: t.text, opened_by: t.opened_by, opened_ts: t.opened_ts, closed: t.closed })); if (!raw) rows = redactDeep(rows, opts).value; }
        else { rows = [...X.rawEvents(root)].map((e) => ({ id: e.id, sid: e.sid, ts: e.ts, kind: e.kind, actor: e.actor, d: e.d })); if (!raw) rows = redactDeep(rows, opts).value; }
        if (fmt === 'csv') {
          const flat = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'object' && v !== null ? JSON.stringify(v) : v])));
          const cols = [...new Set(flat.flatMap((r) => Object.keys(r)))];
          const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
          return write([cols.join(','), ...flat.map((r) => cols.map((c) => q(r[c])).join(','))].join('\n') + '\n', false);
        }
        return write(JSON.stringify(rows, null, 2) + '\n', false);
      } finally { pr.close(); }
    }
    case 'draft': case 'queue': case 'voice': case 'approve': case 'decline': case 'publish': {
      const N = await import('./lib/narrative.mjs'); const PB = await import('./lib/publish.mjs'); const V = await import('./lib/voice.mjs');
      let sub = cmd === 'draft' || cmd === 'voice' ? null : (cmd === 'queue' ? args.shift() || 'list' : cmd);
      const pr = await project(root);
      try {
        const store = pr.engine.drafts;
        const need = (id) => { const x = id && store.get(id); if (!x) { out(`no draft matches "${id || ''}". See: cts queue`); process.exitCode = 1; return null; } return x; };
        if (cmd === 'voice') {
          const v = args.shift() || 'show';
          if (v === 'init') return out(V.initVoice(root) ? 'created ' + paths(root).voice : 'voice.md already exists');
          if (v === 'show') { V.initVoice(root); return out(fs.readFileSync(paths(root).voice, 'utf8')); }
          if (v === 'suggestions') { const l = [...store.suggestions.values()].filter((s) => s.status === 'offered'); return out(l.length ? l.map((s) => `${s.id}  ${s.key}: ${s.value}   (${s.why})`).join('\n') + '\n\naccept with: cts voice accept <id>' : 'no suggestions'); }
          const sg = store.suggestions.get(args[0]);
          if (!sg) return out('no such suggestion. See: cts voice suggestions');
          if (v === 'accept') { V.acceptSuggestion(root, sg); writeHumanEvent(root, 'voice.accept', { id: sg.id }, { actor: 'human' }); return out(`saved to voice.md: ${sg.key}: ${sg.value}`); }
          if (v === 'reject') { writeHumanEvent(root, 'voice.reject', { id: sg.id }, { actor: 'human' }); return out('ok, will not offer that again'); }
          if (v === 'undo') { V.undoSuggestion(root, sg.id); writeHumanEvent(root, 'voice.undo', { id: sg.id }, { actor: 'human' }); return out('removed from voice.md'); }
          return out(HELP.voice);
        }
        if (cmd === 'draft') {
          const channel = opt(args, '--channel'), format = opt(args, '--format'), force = flag(args, '--force'), via = opt(args, '--via') || pr.cfg.drafts.writer || 'template', model = opt(args, '--model');
          const which = args[0] || 'last';
          if (which === 'auto') { const made = N.autoDrafts(pr); return out(made.length ? `drafted ${made.length}: ` + made.map((i) => i.slice(-6)).join(', ') + '\nreview: cts queue' : 'nothing new to draft under your autopilot rules'); }
          if (which === 'show') { const x = need(args[1]); if (!x) return; return flag(args, '--json') ? out(JSON.stringify(x, null, 1)) : showDraft(x); }
          let id = which;
          if (which === 'last') { const l = pr.engine.listMoments({ min: pr.cfg.threshold }).filter((m) => m.kind !== 'wait'); if (!l.length) return out('no moments above the threshold yet'); id = l[l.length - 1].id; }
          const chans = channel ? channel.split(',') : pr.cfg.drafts.channels;
          if (!['template', 'claude', 'api'].includes(via)) { process.exitCode = 1; return out('--via must be template, claude or api'); }
          for (const ch of chans) {
            const r = via === 'template' ? N.createDraft(pr, id, { channel: ch, format, force }) : await N.writeStory(pr, id, { channel: ch, format, force, via, model });
            if (r.error) { out(`${ch}: ${r.error}`); process.exitCode = 1; continue; }
            if (r.fallback) out(`${ch}: the storyteller's text was not used (${r.fallback}); this is the template draft`);
            showDraft(store.get(r.id));
            const x = store.get(r.id); const chk = N.checkDraft(pr, x);
            out(chk.ok ? 'honesty guard: ok' : 'honesty guard: ' + chk.problems.join('; '));
            if (x.redaction.count) out(`redaction masked ${x.redaction.count} item(s)`);
          }
          return out('review: cts queue   ·   approve: cts queue approve <id>');
        }
        // queue family
        if (sub === 'list') {
          const l = store.list().filter((x) => ['pending', 'approved'].includes(x.status));
          const all = flag(args, '--all'); const rows = all ? store.list() : l;
          if (!rows.length) return out('the queue is empty');
          for (const x of rows) out(`${x.id.slice(-8)}  ${x.status.padEnd(9)} ${x.channel}/${x.format}  ${x.kind || ''}  ${trunc(x.text.replace(/\s+/g, ' '), 70)}`);
          return out(`\n${store.pendingCount()} pending${PB.isPaused(pr) ? ' · PUBLISHING PAUSED' : ''}`);
        }
        if (sub === 'show') { const x = need(args[0]); return x && showDraft(x); }
        if (sub === 'approve') {
          const next = flag(args, '--next'); let at = opt(args, '--at');
          const x = need(args[0]); if (!x) return;
          if (next) at = new Date(N.nextSlot((pr.cfg.publishing.channels[x.channel] || {}).cadence)).toISOString();
          const chk = N.checkDraft(pr, x);
          if (!chk.ok) out('warning, honesty guard: ' + chk.problems.join('; ') + '\n(approving anyway: you are the gate)');
          const r = N.approve(pr, x.id, { at }); if (r.error) { process.exitCode = 1; return out(r.error); }
          if (at) return out(`approved, goes out at ${at} (cts publish runs the queue; the dashboard server does it automatically)`);
          const p = PB.publishDraft(pr, x.id);
          return out(p.ok ? `published: ${p.receipt.path}` : `approved, but not published: ${p.reason}`);
        }
        if (sub === 'decline') { const x = need(args[0]); if (!x) return; const r = N.decline(pr, x.id, args.slice(1).join(' ')); return out(r.error || 'declined; it will not be drafted again unless you pass --force'); }
        if (sub === 'edit') {
          const x = need(args[0]); if (!x) return;
          const file = args[1];
          if (!file) { out('pass the new text as a file, or - for stdin. Current text:'); return showDraft(x); }
          const r = N.edit(pr, x.id, fs.readFileSync(file === '-' ? 0 : file, 'utf8').replace(/\r?\n$/, ''));
          if (r.error) { process.exitCode = 1; return out(r.error); }
          out('saved (approval, if any, is void until you approve again)');
          for (const s of r.suggestions) out(`voice suggestion ${s.id}: save "${s.key}: ${s.value}"? ${s.why}. cts voice accept ${s.id}`);
          return;
        }
        if (sub === 'publish') {
          if (args[0]) { const x = need(args[0]); if (!x) return; const r = PB.publishDraft(pr, x.id); return out(r.ok ? `published: ${r.receipt.path}` : 'not published: ' + r.reason); }
          const r = PB.runQueue(pr); return out(r.length ? r.map((x) => `${x.id.slice(-8)} ${x.ok ? 'published ' + x.receipt.path : 'held: ' + x.reason}`).join('\n') : 'nothing due');
        }
        return out(HELP.queue);
      } finally { pr.close(); }
    }
    case 'migrate': { const I = await import('./lib/importers.mjs'); const r = I.migrate(root); return out(`schema ${r.schema}: ${r.events} events in ${r.files} file(s), ${r.old} older than the current schema${r.old ? '' : ' - nothing to migrate'}`); }
    case 'extract': {
      const ex = await import('./lib/extract.mjs');
      const sub = args.shift() || 'status';
      const pr = await project(root);
      try {
        const min = +(opt(args, '--min') || 30), limit = +(opt(args, '--limit') || 12);
        if (sub === 'status') {
          const p = ex.pending(pr, { min, limit: 1000 });
          const la = pr.engine.lastAuto, mode = pr.cfg.extraction.auto;
          out(p.length ? `${p.length} moment(s) await extraction (best: "${trunc(p[0].headline, 70)}", ${p[0].score}). Run /cts:extract` : 'nothing awaiting extraction');
          return out(`automatic: ${mode ? `on (${mode})` : 'off'}${la ? ` · last run ${ago(Date.now() - la.t)} ago (${la.trigger}): ${la.ok ? 'ok' : 'failed: ' + trunc(la.error || '', 80)}` : ''}`);
        }
        if (sub === 'prepare') return out(JSON.stringify(ex.prepare(pr, { min, limit }), null, 1));
        const report = (r) => {
          out(`accepted: ${r.accepted.moments} moment(s), ${r.accepted.merges} merge(s), ${r.accepted.drops} drop(s), ${r.accepted.threads} thread change(s)`);
          for (const x of r.rejected) out(`REJECTED "${x.what}": ${x.reason}`);
          if (r.rejected.length) process.exitCode = 2;
        };
        if (sub === 'apply') {
          const file = args[0];
          const text = file && file !== '-' ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
          return report(ex.apply(pr, ex.parseAnswer(text)));
        }
        if (sub === 'run') {
          const model = opt(args, '--model'), via = opt(args, '--via') || (pr.cfg.extraction.auto === 'claude' ? 'claude' : 'api');
          const r = await ex.extractNow(pr, { via, model, min, limit });
          if (r.none) return out('nothing awaiting extraction');
          if (r.rounds > 1) out('(one repair round for rejected items)');
          return report(r);
        }
        return out(HELP.extract);
      } finally { pr.close(); }
    }
    case 'import': {
      if (args[0] === 'transcripts') {
        args.shift();
        const { importTranscripts } = await import('./lib/transcripts.mjs');
        const since = opt(args, '--since'); const dir = opt(args, '--dir'); const dry = flag(args, '--dry-run');
        const ms = since ? Date.now() - (+since.replace(/\D/g, '') || 0) * 86400e3 : 0;
        const t = Date.now();
        const r = importTranscripts(root, { dir, since: ms, dryRun: dry });
        if (r.missing) return out(`no transcripts found at ${r.dir}`);
        return out(`${dry ? 'would import' : 'imported'} ${r.events} events from ${r.sessions} session(s) (${r.subagents} subagent transcript(s)); skipped ${r.skippedLive} already captured live, ${r.skippedOld} older than --since; ${Date.now() - t} ms`);
      }
      if (['bundle', 'events', 'marks', 'posts'].includes(args[0])) {
        const kind = args.shift(); const file = args[0];
        if (!file || !fs.existsSync(file)) return out(`give me a file: cts import ${kind} <file>`);
        const I = await import('./lib/importers.mjs');
        try {
          const r = kind === 'bundle' ? I.importBundle(root, file) : kind === 'events' ? I.importEvents(root, file) : kind === 'marks' ? I.importMarks(root, file) : I.importPosts(root, file);
          return out(`${kind}: ${r.parsed != null ? r.parsed + ' parsed, ' : ''}${r.added} event(s) added, ${r.skipped} already present${r.rejected ? `, ${r.rejected} rejected (corrupt or invalid)` : ''}${r.copied ? `, ${r.copied} file(s) copied` : ''}${r.added ? '\nthe index was dropped and rebuilds on next use (a running dashboard server was stopped; cts open restarts it)' : ''}`);
        } catch (e) { process.exitCode = 1; return out(`import failed: ${e.message}`); }
      }
      if (args[0] !== 'git') return out(HELP.import);
      const { importGit } = await import('./lib/gitimport.mjs');
      const repo = opt(args, '--repo');
      const r = importGit(root, { repo: repo ? path.resolve(repo) : root }); return out(`imported ${r.events} merge/revert/tag event(s) from ${r.branch}`);
    }
    case 'statusline': {
      const s = readJson(paths(root).server);
      if (!s || !pidAlive(s.pid)) return;
      const sm = await httpGetJson(s.port, '/api/summary', 300);
      if (!sm) return;
      process.stdout.write(`CTS ● ${sm.momentsToday} moment${sm.momentsToday === 1 ? '' : 's'} · ${sm.openThreads} open thread${sm.openThreads === 1 ? '' : 's'}${sm.last ? ` · last: "${trunc(sm.last.headline, 48)}"` : ''}`);
      return;
    }
    case 'doctor': {
      const major = +process.versions.node.split('.')[0], minor = +process.versions.node.split('.')[1];
      out(`node ${process.versions.node}: ${major > 22 || (major === 22 && minor >= 5) ? 'ok' : 'TOO OLD (need >= 22.5 for node:sqlite)'}`);
      const p = paths(root);
      out(`project root: ${root}`); out(`.cts present: ${fs.existsSync(p.cts)}`); out(`paused: ${fs.existsSync(p.paused)}`);
      let n = 0; try { n = fs.readdirSync(p.sessions).length; } catch { /* none */ }
      out(`session files: ${n}`);
      const s = await liveServer(root); out(`server: ${s ? 'running on ' + s.port : 'not running'}`);
      try { const l = fs.readFileSync(p.hooklog, 'utf8').trim().split('\n'); out(`hooks.log: ${l.length} line(s), last: ${trunc(l[l.length - 1], 200)}`); } catch { out('hooks.log: empty (good)'); }
      return;
    }
    default: out(`unknown command "${cmd}"\n`); out(HELP._); process.exitCode = 1;
  }
}
