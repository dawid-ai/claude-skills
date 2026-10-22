---
name: queue
description: The CTS review queue. List drafts, then approve, edit or decline them. Nothing is published without an approval.
argument-hint: "[list|show <id>|approve <id>|decline <id> [reason]|edit <id> <file>|publish]"
disable-model-invocation: true
allowed-tools: Bash(cts:*)
---

Run exactly this command with the Bash tool and relay its output in a few lines. Never approve a draft the user did not name.

`cts queue $ARGUMENTS`

If the `cts` command is not found, say that the CTS plugin's bin directory is not on PATH and stop.
