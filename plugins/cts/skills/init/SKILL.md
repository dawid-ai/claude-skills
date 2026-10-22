---
name: init
description: Set up CTS in this project: create .cts/, optionally load a sample session and enable the status line.
argument-hint: "[--demo] [--statusline]"
disable-model-invocation: true
allowed-tools: Bash(cts:*)
---

Run exactly this command with the Bash tool and relay its output in one or two lines, without commentary:

`cts init $ARGUMENTS`

If the `cts` command is not found, say that the CTS plugin's bin directory is not on PATH and stop.
