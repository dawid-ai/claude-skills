# Install, run, test, update

Requirements: Claude Code, Node.js 22.5 or newer (`node --version`), git. No `npm install` is needed: CTS has no dependencies.
Optional: Chrome or Edge (PNG cards, mp4/gif replay) and `ffmpeg` (mp4/gif only).

## 1. Try it without installing (fastest)

Clone https://github.com/dawid-ai/claude-skills, then from the project you want to record (not from the CTS folder):

    claude --plugin-dir <clone>\plugins\cts

This loads CTS for that one session only. Nothing is installed or changed.

## 2. Install it for every session

In a terminal (or the same commands as `/plugin ...` inside Claude Code):

    claude plugin marketplace add dawid-ai/claude-skills
    claude plugin install cts@claude-skills

To install from a local clone instead, pass its path: `claude plugin marketplace add <clone>`. The marketplace name is the same.

Restart Claude Code. Verify with `/plugin` or `claude plugin list`: `cts@claude-skills` should be enabled, with 25 hooks, 14 skills, 2 agents and 1 MCP server (`claude plugin details cts@claude-skills`).
Uninstall: `claude plugin uninstall cts@claude-skills` (hooks go with it; your `.cts/` folders stay).

## 3. First run, in any project

1. Start Claude Code in a project and work as usual. Events are written to `.cts/sessions/` in that project (the folder is created on first use; add it to git if you want it shared).
2. `/cts:init --demo` (optional) loads a sample session so the dashboard is not empty. `/cts:open` opens the dashboard at http://localhost:4848.
3. `/cts:status` shows event count and the last moment. `/cts:mark note` flags a moment.
4. `/cts:extract` runs the Tier 2 extractor. `/cts:draft last` drafts a post. `/cts:queue` lists drafts, `/cts:queue approve <id>` approves one (it is written to `.cts/outbox/`).
5. Without Claude Code, from a terminal in the project: `node <clone>\plugins\cts\bin\cts status` (or run `npm link` once in the CTS folder to get a plain `cts` command).
6. Past work: `cts import transcripts` rebuilds the log from your earlier Claude Code sessions in this project; `cts import git` adds merges, reverts and tags.

## 4. Check that it works

- In the CTS folder: `npm test` (108 tests, about 3 minutes). All should pass.
- `cts doctor` in a project: Node version, hooks log, server, paused state.
- Hook failures never show up in Claude Code; they go to `.cts/hooks.log`.

## 5. Exports and imports

    cts export bundle                  full private backup: <project>-<date>.cts.zip (not redacted)
    cts import bundle file.cts.zip     merge on another machine (by event id; never overwrites local files)
    cts export markdown                arcs as articles, digests, drafts -> .cts/export/markdown (redacted)
    cts export otel --out t.json       OpenTelemetry OTLP/JSON traces
    cts export events --format ndjson [--raw]   / cts import events file
    cts export marks > journal.md      / cts import marks journal.md
    cts import posts posts.csv         past posts (ts, channel, url, text[, moment]) attach to their moments
    cts share --cards --png            static Story page + SVG and PNG cards
    cts export replay --out r.html     animated replay; use r.mp4 or r.gif with Chrome/Edge + ffmpeg

## 6. How updates work

CTS is a plugin in the `claude-skills` marketplace (https://github.com/dawid-ai/claude-skills, folder `plugins/cts`), so Claude Code copies a versioned snapshot into its plugin cache. Editing the files does not change what Claude Code runs until you publish a new version:

1. Change the code and bump `version` in `.claude-plugin/plugin.json` (and `package.json`). Claude Code compares versions, so without a bump it keeps the old snapshot.
2. Push the commit to `main` of `dawid-ai/claude-skills`.
3. `claude plugin marketplace update claude-skills` (pulls the new commits).
4. `claude plugin update cts@claude-skills`
5. Restart Claude Code (the update applies on restart).

Everyone who added the marketplace gets the same flow. For quick iteration use `claude --plugin-dir <clone>\plugins\cts`, which always reads the folder as it is.

Your data is separate from the plugin. `.cts/` in each project is never touched by an update. The log format is versioned (`v` on every line); a future schema change ships with a migration and `cts migrate` reports anything old. Today there is only schema 1, so nothing needs migrating. A running dashboard server keeps the code it started with: after an update, `cts open` again (or kill the old server) to pick up the new dashboard.
