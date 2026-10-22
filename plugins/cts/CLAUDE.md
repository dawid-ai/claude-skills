# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

CTS (Capture The Struggle) is a Claude Code plugin. It records every session as an append-only, attributed event log, scores notable moments, tracks open decisions ("threads"), drafts posts from them, and serves a live dashboard on localhost. `README.md` is the feature spec; `INSTALL.md` covers install and update; `docs/events.md` is the event schema.

## Commands

No `npm install`: CTS has zero dependencies and needs Node.js 22.5 or newer (it uses the built-in `node:sqlite`).

```
npm test                                         # all tests, serial (--test-concurrency=1)
node --test test/hook.test.mjs                   # one test file
node --test --test-name-pattern="reversal" test/detectors.test.mjs   # one test by name
node scripts/bench.mjs 100000                    # synthetic 100k-event perf check
node scripts/shots.mjs <port> <outdir>           # screenshot every dashboard view (needs Playwright)
claude plugin validate .                         # validate the plugin manifest
node bin/cts <command> --help                    # run the CLI from this folder
claude --plugin-dir <path-to-this-folder>        # load the working copy into a session (from another project)
```

Tests run serially because several spawn the hook, the server, or the CLI as child processes. Set `CTS_NO_SERVER=1` when you invoke `src/hook.mjs` directly, or a `SessionStart` payload spawns a detached dashboard server. Other environment switches: `CTS_NO_NOTIFY=1` (no desktop notifications), `CTS_SKIP_CAPTURE=1` (the hook exits at once; set for CTS's own `claude -p` helper sessions), `CTS_HOME` (replaces `~/.cts` for the registry and personal config; projects under the OS temp dir are never registered unless it is set), `CTS_USER` (the person id for consent), `CTS_CLAUDE_BIN` (the `claude` used for extraction).

To check detectors against real history without touching the project, import into a scratch directory: `cts import transcripts --dir ~/.claude/projects/<encoded-path>` and `cts import git --repo <path>` from an empty temp dir. Both only read the source.

The installed plugin is a versioned snapshot in Claude Code's plugin cache. Editing files here changes nothing for installed users until you bump `version` in both `.claude-plugin/plugin.json` and `package.json` and run the marketplace update flow in `INSTALL.md` section 6. Use `--plugin-dir` for iteration.

## Architecture

### Data flow

1. **Capture (`src/hook.mjs`).** One script handles all 25 hooks registered in `hooks/hooks.json`. It reads the payload, runs `normalize()` (`src/lib/normalize.mjs`) to produce one event, and appends one CRC-checksummed JSONL line to `.cts/sessions/<sid>.jsonl`. It never calls a model, never blocks, never prints, and swallows errors into `.cts/hooks.log`. Only `SessionStart` is synchronous: it starts the server if needed and injects `additionalContext` from `.cts/context.json`.
2. **Index (`src/lib/project.mjs`).** `Project` owns `.cts/`, the `Engine`, and `index.sqlite`. `sync()` tails every session file from stored byte offsets, merges new events by ULID, feeds them to the engine, and writes the SQLite index. The server, CLI, and MCP server all go through `Project.open(root)`.
3. **Signal layer (`src/lib/engine.mjs`).** Tier 1 detectors, threads, sessions, and arcs. The engine is pure and replayable: the same ordered events always produce the same moments. `cts reindex` deletes the SQLite file and replays the logs, so it depends on that property.
4. **Surfaces.** `src/server.mjs` (HTTP on 127.0.0.1, JSON API, SSE, and the static `dashboard/` with no framework or build step), `src/cli.mjs` (every `cts` command, including the `cts watch` terminal pane), and `src/mcp.mjs` (a minimal stdio MCP server exposing read tools plus `cts_mark`). The server tick also runs autopilot, the publish queue, and draft notifications (`src/lib/notify.mjs`).

### Invariants to preserve

- **The JSONL logs (plus `.cts/retention.json` after a trim) are the source of truth.** `index.sqlite` is a disposable cache. Every state change, including human decisions (`mark`, `dismiss`, `confirm`, `thread.close`), drafts (`draft.*`, `publish.*`, `voice.*`), and Tier 2 results (`extract.*`), is written as an event. `DraftStore` in `src/lib/drafts.mjs` is a reducer over those events. Don't add state that lives only in SQLite or memory.
- **The hook path stays light.** `src/hook.mjs` imports only `util.mjs` and `normalize.mjs` (and what those import). Don't import `db.mjs`, `project.mjs`, or `engine.mjs` from it. `bin/cts` has a fast path for `mark` and `dismiss` that skips SQLite and the server.
- **No model calls in capture or indexing.** Tier 2 extraction (`src/lib/extract.mjs`) is explicit: `prepare` builds a bounded packet, the `cts:extractor` agent (`agents/extractor.md`) or `cts extract run` answers, and `apply` validates. `apply` rejects any item whose cited events don't exist, whose numbers don't appear in the cited events, or whose quotes aren't verbatim.
- **Redaction boundary.** `src/lib/secrets.mjs` scrubs high-confidence secrets at capture. Everything leaving the machine (share pages, cards, exports, drafts) must pass `src/lib/redact.mjs`. Only the private bundle and raw ndjson export skip it.
- **Publish gate.** `publishDraft()` in `src/lib/publish.mjs` is the only function that writes outside `.cts/` for a draft. It requires a `draft.approve` for the exact current text hash, or an `auto` mode rule with a clean guard and a redaction report with zero masks. Adapters write files only (`.cts/outbox/`, blog or newsletter Markdown, `CHANGELOG.md`); there are no network adapters. The MCP server deliberately has no approve or publish tool.
- **Drafts are stories, not log lines.** `src/lib/narrative.mjs` is the only prose writer. Post text never quotes prompts, commands, branches, paths, test names or error lines (the dashboard keeps those as evidence); the templates in `storyLines()` describe them in plain first-person words. The optional storyteller (`writeStory`, `drafts.writer`) is a model reading a redacted, consent-filtered `storyPacket`; `storyProblems()` drops its text for the template on any quote, code, path, copied prompt, placeholder or untraceable number. `checkDraft()` checks every stored draft the same way it checks an edit.
- **Retention snapshot.** `src/lib/retention.mjs` trims raw events of old sessions and writes the engine's derived state to `.cts/retention.json`; `Engine.restore()` loads it before replay, and `push()` skips what the snapshot already covers (events of trimmed sessions, decisions and `extract.*` before the snapshot time). Engine state that affects detection across events must go into `Engine.snapshot()`/`restore()`, and handlers must stay idempotent for restored moments and threads. A trim is rehearsed on a copy and refused if the state differs; `Project.sync()` rebuilds when a session file shrinks.
- **Consent at the sharing boundary.** Shared output (story, cards, Markdown, events export, replay, drafts) goes through `consentMoment`/`consentEvent`/`consentText` in `src/lib/consent.mjs` as well as the redactor. A new shared surface needs both, and `test/team.test.mjs` should cover it.
- **Classifiers read the shell as the shell runs it.** `src/lib/parse.mjs` works on `skeleton()` (heredoc bodies and quoted strings removed) split into segments: a runner, deploy tool or package manager counts only at the start of a segment, and test and failure keys use the segment, not the whole command. `Engine.testOf()` re-classifies events captured before `d.test.seg` existed, so `cts reindex` applies classifier fixes to old logs (from the stored command, which is capped at 2000 characters).
- **Logs tolerate damage.** Readers in `src/lib/log.mjs` skip bad-CRC lines and incomplete tails rather than failing. Imports (`src/lib/importers.mjs`) union-merge by event id, so re-importing is a no-op.

### Configuration

`DEFAULT_CONFIG` in `src/lib/util.mjs` is deep-merged with `~/.cts/config.json` and then the project's `.cts/cts.json`. The dashboard **Settings** view edits only the whitelist in `FIELDS` (`src/lib/settings.mjs`); add a field there to make a new setting editable. Detector base scores are `BASE` in `src/lib/engine.mjs`.

### Plugin wiring

- `skills/*/SKILL.md` become `/cts:<name>` commands. Each skill shells out to `cts …` with `allowed-tools: Bash(cts:*)` and `disable-model-invocation: true`. When you add a CLI command that should be a slash command, add a matching skill.
- `bin/` is put on PATH by the plugin; `bin/cts.cmd` is the Windows shim. `bin/cts` has fast paths that skip SQLite: `mark`, `dismiss`, and `subagent-statusline`.
- `.mcp.json` points at `${CLAUDE_PLUGIN_ROOT}/src/mcp.mjs`. When you open this repo itself in Claude Code, that file also loads as a project MCP server with `CLAUDE_PLUGIN_ROOT` unset, so the `cts` server fails to connect. That only affects development sessions.
- `settings.json` (plugin root) registers the subagent status line (`cts subagent-statusline`, a fast path in `bin/cts` that reads `.cts/context.json` only). A plugin can't set the main status line; `cts init --statusline` writes that into the user's project settings.

### Tests

`test/helpers.mjs` exposes `run(fn, cfg)`. It builds events with `Sim` (`src/lib/sim.mjs`, also used for the demo session), pushes them through a fresh `Engine`, and returns the detected moments, so detector tests need no files. `test/network.test.mjs` runs every surface with `net`, `dns`, `fetch`, and `child_process` patched and fails on any non-loopback connection. When you add a surface, add it there. Hook, CLI, and server tests create temporary project directories (with a `.git` folder so `findRoot` stops there) and spawn the real entry points.

### Code style

Plain ESM `.mjs`, no TypeScript, no build. Code is dense: short helpers, single-line guards, and a one- or two-line header comment per module stating its role and constraints. Match that density.
