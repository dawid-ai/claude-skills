---
name: dismiss
description: Dismiss the most recent auto-detected moment and lower that detector's weight for this project.
argument-hint: ""
disable-model-invocation: true
allowed-tools: Bash(cts:*)
---

Run exactly this command with the Bash tool and relay its output in one or two lines, without commentary:

`cts dismiss $ARGUMENTS`

If the `cts` command is not found, say that the CTS plugin's bin directory is not on PATH and stop.
