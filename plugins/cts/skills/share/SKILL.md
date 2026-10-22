---
name: share
description: Write a redacted static Story page, and optionally SVG share cards, to .cts/share/.
argument-hint: "[--cards]"
disable-model-invocation: true
allowed-tools: Bash(cts:*)
---

Run exactly this command with the Bash tool and relay its output in one or two lines, without commentary:

`cts share $ARGUMENTS`

If the `cts` command is not found, say that the CTS plugin's bin directory is not on PATH and stop.
