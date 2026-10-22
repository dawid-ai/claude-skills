---
name: draft
description: Draft posts from a moment or arc into the CTS review queue and print them. Nothing is published.
argument-hint: "[moment-id|arc:<id>|last|auto] [--channel x] [--format thread] [--via claude]"
disable-model-invocation: true
allowed-tools: Bash(cts:*)
---

Run exactly this command with the Bash tool and relay its output as it is, without rewriting the drafts:

`cts draft $ARGUMENTS`

If the `cts` command is not found, say that the CTS plugin's bin directory is not on PATH and stop.
