# CTS: Capture The Struggle

CTS records every Claude Code session as a truthful, attributed event log, scores the moments that would
surprise a competent peer (reversals, long fights, disagreements between agents, things shipped or broken),
tracks the decisions you left open, and shows all of it on a live dashboard on localhost.
It captures the struggle, not the outcome: the dead ends are the part you cannot reconstruct from memory later.

Built: capture, signal layer (Tier 1 detectors and Tier 2 extraction), threads, live dashboard, terminal commands, MCP server,
redaction, consent, sharing, exports, drafts and the review queue. Publishing writes files only; direct posting is not built (see the end).

## Requirements

* Node.js **22.5 or newer** (uses the built-in `node:sqlite`; no npm install, no dependencies).
* Claude Code with plugin support.

## Install

```
claude plugin marketplace add dawid-ai/claude-skills
claude plugin install cts@claude-skills
```

For a quick local try: `claude --plugin-dir /path/to/claude-skills/plugins/cts`.

Then work as you always do. The first session start creates `.cts/` in your repo (or working directory) and starts the
dashboard server in the background. Open it with `/cts:open` (or `cts open` in a terminal, the plugin puts `cts` on PATH).
`cts init --demo` loads a sample two-session project so the first screen is never empty; `cts demo clear` removes it.

Uninstall with `claude plugin uninstall cts`. Hooks go with the plugin; `.cts/` stays (delete the folder to erase the record).

## What gets captured

Hooks (all command hooks, async except `SessionStart`) append one checksummed JSONL line per event to
`.cts/sessions/<session_id>.jsonl`. They never call a model, never block a tool and print nothing, except that
`SessionStart` injects a short note listing open threads and the last moment. A failing hook logs to `.cts/hooks.log`.

Registered: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, SubagentStart,
SubagentStop, Stop, StopFailure, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch, SessionEnd, Notification,
PermissionRequest, PermissionDenied, TaskCreated, TaskCompleted, TeammateIdle, CwdChanged, DirectoryAdded, Elicitation,
ElicitationResult. Not registered on purpose: `WorktreeCreate`/`WorktreeRemove` (as documented they take over Claude Code's
own worktree handling) and `FileChanged` (needs a watch list); worktrees and file writes are detected from `Bash`, `Write` and `Edit` events instead.

Bash commands are enriched in the hook: test runs (pytest, jest, vitest, go, cargo, rspec, dotnet, node --test, npm test)
get pass/fail counts; git operations get branch, subject, files and diff stat. Subagent events join to their own
transcript file. Every event stores a byte offset into its transcript so the dashboard can open the exact lines.
Event schema: `docs/events.md`.

## Moments, threads, arcs

Tier 1 detectors run deterministically as events arrive: `reversal` 60, `fight` 40+5/attempt (max 90), `disagreement` 70,
`shipped` 65, `broke` 65, `pivot` 55, `memory-cut` 50, `refusal` 50, `wait` 20, `escalation` 45, `mark` 100.
Scores, the fight threshold and the main-branch globs are configurable in `.cts/cts.json`:

```json
{ "threshold": 50, "detectors": { "fightMin": 3, "waitMinutes": 30, "mainBranches": ["main", "release*"], "weights": { "wait": 0.5 } } }
```

`/cts:dismiss` lowers that detector's weight for the project by 10% per dismissal (floor 50%).
Threads open on an unanswered question (`AskUserQuestion`, elicitations), a hedged decision ("for now", "TODO", "revisit"...)
or `/cts:mark ?`, survive session end, resume and compaction, and close when a later event decides them.
Arcs link moments sharing a file, a non-main branch or a thread across sessions and name their shape.

## Tier 2 extraction

Detectors are cheap and noisy; `cts extract` is where a model decides what would surprise a good peer. CTS never calls a model
in the capture path. Three ways to run it:

- `/cts:extract` runs the `cts:extractor` subagent in your own session (`cts extract prepare` builds a bounded packet: only the
  candidate spans, open threads and your confirmed/dismissed moments as few-shot examples; `cts extract apply` validates the answer).
- `cts extract run` does both: `--via api` (default) with `ANTHROPIC_API_KEY`, or `--via claude` through your Claude Code login
  (`claude -p --restricted --strict-mcp-config --tools ""`: no tools, no MCP servers, no plugins, no saved session, run from an empty
  temp dir, and CTS's own hooks skip it). Model from `extraction.model`, default `claude-haiku-5-5`. Rejected items get one repair round.
- Automatically, opt-in: `"extraction": { "auto": "api" | "claude" }`. The dashboard server runs it at session end, when a candidate
  scores at least `urgentScore` (70), and every `everyMinutes` (30) while there is new work; at most every `minGapMinutes` (5), one run
  at a time, exponential backoff on failure (logged to `.cts/hooks.log`), `limit` (12) candidates per run. Every attempt is an
  `extract.auto` event, so a restart does not re-run it; `cts extract status` shows the last one. `cts digest` extracts first when it is on.

`apply` is the honesty guard: every cited event must exist in the log, every number (and number-word) in a headline or body must
appear in the cited events (or be the elapsed time between them), and `evidence.prompt` / `evidence.error` must be verbatim quotes.
Rejected items are reported with the reason and nothing from them is written. Accepted items become `extract.*` events, so
`cts reindex` reproduces them. A moment you confirmed or marked cannot be dropped by the extractor.

`cts import transcripts` rebuilds the log from `~/.claude/projects/<project>/` (subagent transcripts included, ids deterministic,
re-import is a no-op, sessions already captured live are never overwritten).

## Drafts, the review queue and publishing

`cts draft <moment|arc:<id>|last>` writes a post from a moment or arc, in your voice (`.cts/voice.md`, `cts voice`). Posts are
first-person stories, not log lines: the log's prompts, commands, branches, paths, test names and error lines are what the story is told
from, never what it quotes (the dashboard keeps them as evidence). One number per post, name the actors, no lesson unless you marked one
or an extractor-confirmed `learned` moment exists.

Two writers. The default is plain templates ("It took 4 failed attempts before it finally passed."), which need no model. With
`--via claude` (your Claude Code login through `claude -p`, no tools) or `--via api` (`ANTHROPIC_API_KEY`), or `"drafts": {"writer":
"claude"}` for autopilot, the storyteller tells it: what you were doing, what got in the way, what you decided and why, from the prompts
before the moment, its events and what the agents reported. It sees only redacted, consent-filtered material. Its text is kept only if
it has no quotation marks, no code, flags, file names or paths, no run of six words copied from a prompt or command, no masked
placeholder, every number traces to the cited events, and it fits the channel (long text loses whole sentences from the end). One
repair round, then the template draft is written instead and the CLI says why. The model is `drafts.model` (`claude-sonnet-5-5`; on real
history Haiku added lessons and asides the log did not support). Whether a stated reason is true is not checked by code: that is what you
review, or the `cts:reviewer` agent. Formats: short post, thread
(arcs), LinkedIn, long Markdown with front matter, dev-log line, each with an optional SVG share card. Everything passes the redactor first
and the preview shows masked text highlighted; the draft carries a redaction report and an honesty-guard result (numbers and quotes must trace
to the cited events; your edits are checked too).

The gate: nothing is published without a recorded `draft.approve` for the exact current text (an edit voids it), or an explicit
`drafts.modes` auto rule with a clean guard and a clean redaction report (nothing masked at all). `cts pause publishing` (or the dashboard button)
stops everything including scheduled posts; each channel has a daily cap; a declined source is never re-drafted unless you pass `--force`;
declining a kind raises that kind's autopilot bar by 5 points (max 20); pending drafts expire after `drafts.expireDays` (7).

**What "published" means in this version.** There are no network adapters yet. Approving writes the exact text to
`.cts/outbox/<channel>/*.txt` (X, Bluesky, Mastodon, Threads, LinkedIn: you or a scheduler take it from there), to a Markdown file with front
matter (`blog`, `newsletter`) or to the top of `CHANGELOG.md`. The receipt says so; the dashboard says "queued in the outbox".
Edits you make are offered to the voice profile once each (shorter than before: `x.max`; the same word deleted from two drafts: `never`);
nothing is saved without `cts voice accept <id>`, and `cts voice undo <id>` removes exactly that line.

```json
{ "drafts": { "kinds": ["shipped", "broke", "reversal", "disagreement"], "min": 60, "channels": ["x"], "arcChannels": ["linkedin"],
              "modes": { "shipped:x": "auto" } },
  "publishing": { "channels": { "x": { "adapter": "outbox", "limit": 280, "cap": 3 } } } }
```

The server runs autopilot (draft-only by default) while it is up; hooks never do. The dashboard has a **Drafts** view: preview with
character counters, share card, redaction and guard reports, Approve (or schedule), inline Edit, Decline with a reason, and the voice suggestions.

**Notifications.** A draft made under a `notify` rule (for example `"modes": { "shipped:x": "notify" }`) is announced once: a desktop
notification (Windows toast, macOS Notification Center or `notify-send`, nothing to install) linking to the Drafts view, and a
`draft.notify` event so a restart never repeats it. Whatever the mode, the first turn of a session shows you one line when drafts
are waiting. Turn either off with `"notify": { "desktop": false, "terminal": false }`.

## Commands

In Claude Code they are namespaced: `/cts:mark`, `/cts:open`, `/cts:threads`, `/cts:digest`, `/cts:dismiss`, `/cts:status`,
`/cts:pause`, `/cts:resume`, `/cts:share`, `/cts:init`, `/cts:extract`, `/cts:draft`, `/cts:queue`, `/cts:voice`. The same commands exist as `cts <command>` and all take `--help`.
`cts doctor`, `cts reindex`, `cts trim`, `cts consent`, `cts export`, `cts import git`, `cts statusline`, `cts watch`, `cts serve` are CLI-only.

`mark` and `dismiss` take a fast path (about 50 ms, no database, no server). Note that a slash command is itself a turn, so
to mark during a running turn use the dashboard (`Shift+M`, or `m` on a card) or run `cts mark` from a second terminal.

**Status line**: Claude Code does not let a plugin set the main status line. `cts init --statusline` writes it into
`.claude/settings.local.json` for this project. It prints nothing when the server is down.
The plugin does set the **subagent status line** (its `settings.json`): each subagent with moments shows
`CTS ● 2 moments: "<latest headline>"` in the agent panel; the others keep Claude Code's default row. It reads `.cts/context.json` only.

**Companion pane**: `cts watch` in a terminal split next to Claude Code shows the last five moments, open threads, drafts to review
and what each actor is doing, redrawn on every event. `cts watch --once` prints it once without the server.

**MCP**: the plugin registers a stdio server exposing `cts_moments`, `cts_threads`, `cts_search`, `cts_mark` and a read-only `cts_drafts` (there is deliberately no tool that approves or publishes), so you can ask
"what did we leave undecided?" in plain language.

## Dashboard

`http://localhost:4848` (4849, 4850... if taken), static files served by the same process, live over Server-Sent Events.
Views: **Live** (lanes per actor, human leftmost, moments as cards spanning the lanes they involve), **Story** (arcs as
chapters, plus a redacted shareable page), **Threads**, **Sessions** (heat map, resume/fork links, per-session stats), **Drafts** (the review queue),
**Settings** (edits the common `cts.json` fields, keeps every other key, and rescores the project on save), and a
**Transcript** drawer that opens the raw lines behind any event. Filters compose and live in the URL hash. Keyboard: `?`.
It binds to 127.0.0.1 only, checks the Host header, and requires a custom header on every write.

## Privacy

Nothing leaves your machine from this tool (`test/network.test.mjs` runs every surface with the network patched and fails on
any non-loopback connection). Capture scrubs high-confidence secrets (keys, tokens, connection strings,
private keys) before they are written, so they never enter the log or git. Everything that crosses to a share page, card or
export goes through the redactor: secrets, entropy tokens, emails, internal URLs, hostnames, IPs, file paths, your repo and
remote names, your OS user name, plus your `redact.deny` terms; `redact.allow` keeps what you whitelist. Reports list every mask by rule.
Windows paths are masked in every form found in real logs (`C:\x`, `C:\\x` inside JSON, `F:/x`). A multi-word repo name is masked
with any separator or none (`my app`, `my-app`, `my_app`, `my/app`, `myapp`). Your own name is not on the list: add it to
`redact.deny` if your posts should not carry it.
`/cts:pause` stops capture entirely (the gap is logged with no content). `"private": true` in `.cts/cts.json` disables share and export.

**Per-person consent.** Prompts carry `d.who`, a short hash of the person (`CTS_USER`, `"me"` in `~/.cts/config.json`, or the OS user),
never the name. `cts consent summary` stores your choice in `.cts/cts.json` under `people`, so teammates who commit `.cts/` honour it:
your prompts are withheld (replaced by a word count) from the story page, cards, Markdown export, events export, replay and drafts.
`"share": { "prompts": "summary" }` sets the project default. Your local dashboard always shows everything.
A prompt given to `claude -p` or the SDKs (an app's own agent calls, a script) belongs to its caller: it sits in a **claude -p** lane,
carries no `d.who`, and never counts as you saying no, pulling back, or deciding. The session is marked `headless`.

**Retention.** `"retentionDays": N` (0 by default: keep everything). Sessions that ended more than N days ago lose their raw events:
prompts, tool calls, output. Moments, threads, arcs, drafts, decisions, session boundaries and every event they cite stay. The derived
state goes to `.cts/retention.json`, which the engine restores before replaying, so `cts reindex` reproduces the same dashboard. Each
trim is rehearsed on a temp copy and refused if the copy differs. `cts trim` reports, `cts trim --yes` applies (through the running
server if there is one), and the server runs it daily. Trimmed sessions keep the moments they had: a later detector improvement cannot
re-score them, because their raw events are gone.

## Storage

`.cts/` is meant to be committed: `sessions/*.jsonl` (plus `retention.json` after a trim) is the source of truth, `index.sqlite` is git-ignored and rebuilt with
`cts reindex` (verified to reproduce the dashboard exactly), `evidence/` holds transcript spans copied when a moment is
extracted so evidence outlives transcript cleanup, `digests/` holds Markdown digests, `cts.json` holds config.
Truncated or corrupt lines are skipped, never fatal. A session file that shrinks or disappears (a trim, `cts demo clear`, a git
checkout) makes every running process rebuild its index. `~/.cts/projects.json` lists the projects CTS has seen; the Sessions view
shows all of them with 30 days of activity and opens another project's dashboard.

## Develop

```
npm test                                # 108 tests: detectors, redaction, hooks, CLI, MCP, server, settings, reindex, retention, transcripts, extraction (manual and automatic), drafts, publish gate, notifications, consent, registry, exports/imports, network isolation
node scripts/bench.mjs 100000 --assert  # 100k-event project; fails if first paint > 500 ms, live update > 1 s or steady memory > 150 MB
node scripts/shots.mjs <port>  # screenshots every dashboard view in light and dark (needs Playwright)
claude plugin validate .
```

## Exports and imports

`cts export bundle` (private `.cts.zip` backup) with `cts import bundle` (union merge by event id), Markdown (arcs as articles, digests, drafts),
OpenTelemetry OTLP/JSON, events as json/csv/ndjson (raw ndjson is lossless and re-imports), marks as a Markdown journal, SVG and PNG cards
(`cts share --cards --png`, needs Chrome/Edge), and an animated replay (`.html` anywhere; `.mp4`/`.gif` need Chrome/Edge and ffmpeg).
Also in: `cts import marks|posts|events`, and `cts import git --repo <path>` to read another repository's history (read-only). All exports except the bundle and `--raw` pass the redactor. See INSTALL.md for commands and updates.

## Not built yet

Direct posting (Vista Social MCP, X, LinkedIn, Bluesky, Mastodon, Threads): publishing is files and an outbox only, and is deliberately last.
Engagement pull-back. Phone push for new drafts (Claude Code has no plugin API for it). CI runs on Linux, macOS and Windows
(`.github/workflows/test.yml`) once the folder is on GitHub; it has not run yet.
Weekly digests are concatenated dailies, not model-written. The `cts:reviewer` agent is defined but the claim guard is code: a
storyteller's reasons and causes are not checked against the log by code, only its numbers, quotes, code and copied prompts.
Hook latency is about 20-30 ms above Node's own startup (Node itself takes 60-200 ms on Windows), inside the agreed 100 ms budget;
the tests check what CTS adds, not Node's startup.

## Decisions taken

- Autopilot default `drafts.min` is 60, not the spec's 70: Tier 1 base scores are 60-65, so 70 would draft almost nothing before extraction or a mark.
- Auto-publish needs a clean redaction report, read strictly: nothing had to be masked.
- The approval gate checks actor, text hash and rule, not identity; this is an internal tool and the log is a local file.
- An edited draft is stored redacted: if the redactor changes your text, the masked version is what ships.
- Checked against a real project's history (9 sessions, 740 subagents, 30k events). That led to: a deploy is a command that starts with a
  deploy tool, not one that mentions "deploy"; the same deploy within 6 hours counts once; injected `<task-notification>` turns are not
  your prompts; a pushback is judged on the opening sentence and needs a shared topic; agent reports open a thread only on an explicit
  deferral ("for now", "revisit", "come back to"); three or more subagents of a type share one dashboard lane.
- Checked against a second project (9 sessions, 6 of them the app's own `claude -p` calls, 4k events). That led to: a test run is keyed
  on its own segment (`npx vitest run packages/cli`), not on the command, so a shared `cd "<project>" &&` prefix no longer makes every
  run one target; a runner counts only at the start of a segment (`ls vitest.config.*` is not a test run); a pipe or a later command
  owns the exit code, so without counts or a failure line the verdict is unknown, not red; more tests than the green run with no more
  failures than were added is new tests failing, not a regression; `git reset --soft` or a mixed reset keeps the work and is not a
  reversal; headless sessions are the caller's. 16 "Tests went red" moments became 3, all real.
- The dashboard server runs with `--max-semi-space-size=1`: steady memory on a 100k-event project goes from about 170 MB to about 100 MB
  for about 5% slower startup.
