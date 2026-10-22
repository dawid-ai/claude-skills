---
name: open
description: Start the CTS dashboard server if needed and open the live dashboard in the browser.
argument-hint: ""
disable-model-invocation: true
allowed-tools: Bash(cts:*)
---

Run exactly this command with the Bash tool and relay its output in one or two lines, without commentary:

`cts open $ARGUMENTS`

If the `cts` command is not found, say that the CTS plugin's bin directory is not on PATH and stop.
