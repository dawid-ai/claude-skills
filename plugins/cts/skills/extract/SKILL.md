---
name: extract
description: Run CTS Tier 2 extraction now. Rewrites detector candidates into headlines with evidence, using the cts:extractor subagent.
disable-model-invocation: true
allowed-tools: Bash(cts:*), Agent
---
Run `cts extract status`. If nothing awaits extraction, say so and stop.
Otherwise launch the `cts:extractor` subagent with the prompt "Extract the pending CTS moments", wait for its one-line result, then run `cts extract status` and report both lines. Do not summarise anything yourself.
