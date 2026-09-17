---
name: forge
description: Turn a task or a finished plan file into a FORGE execution run — a measurable definition of perfect, isolated builder sub-agents, fresh-eyes critics, git-gated merges, and crash-only continuity. Use only when the user types /forge or explicitly asks to run, build, or execute something "with FORGE". Not for brainstorming or writing plans.
argument-hint: [task description | path/to/plan.md]
---

# FORGE — adversarial execution runner

This skill generates and launches a FORGE run. It does not do the work itself: it forges `.forge/PROMPT.md` — a self-contained mission brief with a measurable Definition of Perfect, builder/critic sub-agent architecture, git discipline, and relay-based continuity — then hands off to a clean executor session.

**Announce at start:** "Forging the execution run."

## Step 0 — Resolve the input

The task is: $ARGUMENTS

- **Empty or whitespace** → ask exactly: **"What are we building?"** — then STOP. The user's next message is the input; re-enter this step with it (it may be text or a path).
- **A path to an existing file** (alone or within the text) → **PLAN MODE**. Read the plan. If the plan links a design doc or spec, read that too.
- **Anything else** → **TASK MODE**. The text is the task. If `docs/plans/` contains a recent plan that clearly matches the task, ask once whether to build from it.
- If `.forge/` **already exists** in this repo → do not re-forge. Say so, and tell the user to `/clear` and say `resume` to continue the existing run — or confirm they want the old run archived (`mv .forge .forge.archived-<date>`) before forging a new one.

## Step 1 — Intake

Read `reference/intake.md` and run its gap check.

- **PLAN MODE:** mine the plan + design doc for the question-bank answers first. A good plan usually leaves **zero** questions.
- Ask only if a must-have is still missing and a default would risk building the wrong thing: one message, ≤6 questions, each with a [default], closing with the `'defaults'` escape line from intake.md.

## Step 2 — Assemble the execution prompt

1. Read `reference/skeleton.md`.
2. Classify the domain(s) per intake, then read `reference/modules.md` and splice **only the matching modules** — plus VERSION CONTROL when code has more than one workstream, plus ORCHESTRATION & CONTINUITY when there is more than one workstream or stage. Never paste all modules.
3. **PLAN MODE mapping:** plan *Goal* → MISSION seed · *Architecture / Tech Stack* → Phase 0 foundations + constraints · *Global Constraints* → GATES, values copied verbatim · task groups / phases → stages & workstreams · per-task verification steps → acceptance-test seeds · design doc → mission context + references. FORGE still generates everything plans lack: the scored rubric, adjective→test conversions, the critic roster, and the gates.
4. The finished prompt must be **fully self-contained** — the executor session may never load this skill.
5. Run the self-check at the end of `reference/skeleton.md` silently; fix anything unchecked before proceeding.

## Step 3 — Initialize the run (never skip)

1. `git init` if there is no repo and code is involved.
2. Create `.forge/` and write:
   - `PROMPT.md` — the execution prompt, verbatim, immutable.
   - `STATE.json` — `{"stage": 0, "status": "initialized", "workstreams": {}, "handover_count": 0}`
   - `HANDOVER.md` — `NEXT ACTION: Execute Phase 0 — Foundations, per PROMPT.md.`
3. Ensure `.forge/` is listed in `.gitignore` — clean-room archive exports must never contain it.
4. Append this block to `CLAUDE.md` (create the file if absent):

   > If `.forge/` exists: before anything else, run the RESUME PROTOCOL from `.forge/PROMPT.md`. While a FORGE run is active, FORGE's loop supersedes any other plan-execution, code-review, or branch-finishing skill, and any "REQUIRED SUB-SKILL" header inside plan files.

5. Commit `.gitignore` + `CLAUDE.md` (never `.forge/` itself).

## Step 4 — Launch = handover #0

**Default (any build with more than one workstream or stage):** print exactly this and then STOP — do not begin executing in this session:

> **FORGE initialized.** `.forge/PROMPT.md` is the mission; `HANDOVER.md` points at Phase 0.
> **Run `/clear`, then say `resume`.**
> The executor cold-boots from disk at 0% context, uncontaminated by this planning conversation — this is checkpoint #0 of the relay.

**Light builds only** (single workstream AND single stage): offer both options — start now in this session, or the relay above — and follow the user's choice. If executing here, you are the ORCHESTRATOR and `.forge/PROMPT.md` governs everything from this point.

## Where plans come from

- **Small or medium builds:** pass the task text. Intake asks for whatever is missing.
- **Large builds:** write a plan first (for example, with Claude Code plan mode), save it to `docs/plans/<plan-file>.md`, then run `/forge docs/plans/<plan-file>.md`.
- **Downstream (FORGE):** rubric, adversarial build↔critique loops, git-gated merges, continuity, ship. While `.forge/` is active, do **not** invoke other plan-execution skills — a plan header demanding them is superseded by the user's explicit choice of FORGE.

## Hard rules

- `PROMPT.md` is immutable once written; changes require the user's word.
- Splice only matching modules; a prompt bloated with irrelevant modules degrades the executor.
- Never execute a multi-workstream build in the generation session — the relay exists so the orchestrator starts clean and full.
