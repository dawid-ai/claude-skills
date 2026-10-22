# claude-skills

Claude Code plugins by [Dawid Jozwiak](https://dawid.ai).

## Install

```
/plugin marketplace add dawid-ai/claude-skills
/plugin install forge@claude-skills
/plugin install cts@claude-skills
```

## Plugins

### forge

Adversarial execution runner. Give it a task or a finished plan and it forges
`.forge/PROMPT.md` — a self-contained mission brief with a measurable Definition
of Perfect, builder/critic sub-agent architecture, git discipline, and
relay-based continuity — then hands off to a clean executor session.

```
/forge <task description>
/forge path/to/plan.md
```

It does not brainstorm or plan; it runs what you already decided to build.

### cts

Capture The Struggle. Records every Claude Code session as an append-only,
attributed event log in `.cts/` of your project, scores the moments that
matter (reversals, long fights, disagreements between agents, things shipped
or broken), tracks the decisions you left open, and shows it all on a live
dashboard on localhost. It drafts first-person posts from those moments for
you to review; publishing writes files only.

```
/cts:open
/cts:draft last
```

Needs Node.js 22.5 or newer; no dependencies. See
[plugins/cts/INSTALL.md](plugins/cts/INSTALL.md).

## License

MIT
