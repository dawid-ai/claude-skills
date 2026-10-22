---
name: digest
description: Run extraction now and print the digest for today, this week or the current session.
argument-hint: "[today|week|session]"
disable-model-invocation: true
allowed-tools: Bash(cts:*)
---

Run exactly this command with the Bash tool and relay its output in one or two lines, without commentary:

`cts digest $ARGUMENTS`

If the `cts` command is not found, say that the CTS plugin's bin directory is not on PATH and stop.
