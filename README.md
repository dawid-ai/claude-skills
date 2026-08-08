# claude-skills

Claude Code plugins by [Dawid Jozwiak](https://dawid.ai).

## Install

```
/plugin marketplace add dawid-ai/claude-skills
/plugin install forge@claude-skills
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

## License

MIT
