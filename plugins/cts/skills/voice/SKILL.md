---
name: voice
description: Show or manage your CTS voice profile and the changes CTS suggested from your draft edits.
argument-hint: "[show|suggestions|accept <id>|reject <id>|undo <id>]"
disable-model-invocation: true
allowed-tools: Bash(cts:*)
---

Run exactly this command with the Bash tool and relay its output without commentary. Never accept a suggestion the user did not name.

`cts voice $ARGUMENTS`

If the `cts` command is not found, say that the CTS plugin's bin directory is not on PATH and stop.
