# Event schema (v1)

One JSON object per line in `.cts/sessions/<session_id>.jsonl`, followed by a per-line checksum:
`{..., "crc":"1a2b3c4d"}` (CRC-32 of the line without the `crc` field). Lines with a bad checksum or no trailing newline are skipped.
Events are immutable; later events supersede earlier ones. Merge conflicts resolve by union (ULIDs are time-ordered).

| field | meaning |
|---|---|
| `v` | schema version (1) |
| `id` | ULID |
| `sid` | Claude Code session id |
| `ts` | ISO timestamp |
| `hook` | hook name that produced it (`cts` for human actions from the CLI/dashboard, `import:git` for imports) |
| `kind` | normalized kind (below) |
| `actor` | `human`, `main`, or `agent:<agent_id>` |
| `agent_type` | present for subagent/teammate events |
| `prompt_id` | prompt this event belongs to |
| `tp` | `{path, off}`: transcript file and byte offset at the time of the event (subagent events point at their own transcript when it exists) |
| `d` | kind-specific data |

Order within a session is the line order (`seq` is assigned when indexing, so the hook needs only one append).

Kinds: `session.start` `session.end` `prompt` `tool.pre` `tool.post` `tool.fail` `batch` `subagent.start` `subagent.stop`
`turn.end` `turn.fail` `compact.pre` `compact.post` `model.pre` `model.post` `permission.request` `permission.denied`
`task.created` `task.completed` `teammate.idle` `cwd.changed` `dir.added` `elicitation` `elicitation.result` `notify`.
Human decisions are events too: `mark` `dismiss` `confirm` `rescore` `merge` `thread.close` `pause` `resume`.

`tool.post` / `tool.fail` data: `tool`, `tool_use_id`, `ok`, `input` (summarized), `out` (tail), optional `dur_ms`, `exit`,
`test` `{runner, pass, fail, total, red}`, `git` `{op, branch, sha, subject, files, stat}`.
Unrecognized payload fields are kept under `d.extra` (truncated, secret-scrubbed).

## Tier 2, drafts, publishing and voice events

Written by CTS itself (actor `extractor`, `cts`, `autopilot` or `human`); the engine reduces them like any other event and they never create a lane.

| kind | `d` |
|---|---|
| `extract.moment` | `{target?, kind, headline, body[≤3], score, evidence, cite[event ids], actors, files, t0, t1, tp}` refines a detector moment or adds a `theory` / `workaround` / `learned` one |
| `extract.drop` | `{target, reason}` |
| `extract.merge` | `{target, into}` |
| `extract.thread` | `{op: close\|open, thread?, text?, resolution?, cite}` |
| `extract.run` | `{n, rejected}` |
| `draft.create` | `{draft, source{type,id,moments}, channel, format, text, title, claims{refs,extra}, redaction{count,summary,items}, card, origin, score, kind, mode, voice_rev, writer}` (`writer`: `template`, `claude` or `api`) |
| `draft.edit` | `{draft, text, removed[], redaction}` voids any approval |
| `draft.approve` | `{draft, via: human\|autopilot, rule?, at?, text_hash}` only valid while `text_hash` matches the current text |
| `draft.decline` | `{draft, reason}` |
| `draft.publish` | `{draft, channel, receipt{kind,path}, request_id}` the receipt |
| `draft.fail` | `{draft, error}` |
| `publish.pause` / `publish.resume` | the kill switch |
| `voice.suggest` / `voice.accept` / `voice.reject` / `voice.undo` | `{id, key, value, why}` / `{id}` |
