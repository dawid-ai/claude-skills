# FORGE execution-prompt skeleton

Assemble the prompt from this skeleton, splicing matching modules from modules.md. Keep every section; adapt content, never structure. Address the executing agent in second person; make the mission vivid and the bars numeric. The result must be fully self-contained.

[BEGIN SKELETON]

# MISSION
One paragraph: what to build, for whom, and the single sentence that defines victory. Include the emotional bar ("a stranger seeing this cold should stop and ask who made it") AND point to the measurable bar below. Close with: "Do not stop while any gate is red. Do not ask the user anything you can decide and log."

# DEFINITION OF PERFECT
Score every dimension 0–10. SHIP BAR: every dimension ≥ 9, verified by an independent critic with evidence. Binary GATES must all be green — one red gate blocks ship regardless of scores.
Dimensions: [from the domain module — each with one line describing what a 10 looks like, anchored to the references]
Gates: [from the domain module]
ADJECTIVE→TEST RULE: every adjective in the mission is converted here into a test. "Beautiful" = wins or draws the blind A/B against the named references on a majority of canonical shots. "Fast" = the numeric budget. "Clean" = survives the 30%-cut review. "Secure" = the checklist, clean. An adjective without a test is not part of the spec.

# REFERENCES & ANTI-REFERENCES
What great looks like: [2–4 named references, each with the specific thing to steal: composition, physics feel, tone, information density…]
What failure looks like: [2–3 anti-references or anti-patterns, each with the specific sin to avoid]

# OPERATING RULES — non-negotiable
1. EVIDENCE RULE — no agent claims anything works, looks right, or reads well without an artifact: test run, screenshot, benchmark, rendered output, quoted line. "It works" without proof is treated as false.
2. TWO-KEY RULE — nothing is DONE until (key 1) its builder declares done with evidence and (key 2) an independent critic verifies with evidence it generated itself. A critic that only re-reads the builder's evidence has verified nothing.
3. FRESH-EYES RULE — critics receive ONLY the artifact, the rubric, and the references. Never the builder's reasoning, effort story, or excuses — and history counts as reasoning: commit messages, PR descriptions, branch names, and raw diffs are contaminated context (see the VERSION CONTROL module's clean-room review). Judge the work, not the journey. (If parallel sub-agents are unavailable, simulate: switch into the critic role in a clean context that excludes builder rationale.)
4. HARSH-BY-DEFAULT — every review lists concrete defects with severity (BLOCKER / MAJOR / MINOR), each mapped to the dimension or gate it violates, plus the top 3 weaknesses even when passing. A review with zero findings is invalid — a different critic redoes it. A finding that maps to no dimension or gate is taste, not a defect; log it as OPTIONAL.
5. CONVERGENCE RULE — each iteration must resolve or explicitly contest (with reasoning) every open defect. Re-reviews check the defect ledger first, then do a fresh sweep. No defect is silently dropped.
6. CHANGE-APPROACH TRIGGER — if the same dimension fails 3 consecutive reviews, stop polishing: the approach is wrong. Redesign that component from a different angle before iterating again.
7. LOOP CAP & ESCALATION — maximum 5 build↔critique loops per work item (2 for trivial items). Hitting the cap does NOT mean shipping the failure: write an ESCALATION block (best attempt · precise blocker · 2–3 options with trade-offs) into the ledger and final report. Never loop forever; never hide a miss.
8. DISK IS TRUTH, CONTEXT IS CACHE — all process state lives in the .forge/ files (see the ORCHESTRATION & CONTINUITY module), written BEFORE the next action is taken; the orchestrator's context is a disposable cache of them. An action not recorded on disk did not happen. Sub-agents write their full output to files and return only a bounded receipt (≤10 lines, fixed schema); the orchestrator never holds full artifacts, logs, or reports in context — it dispatches by file path and consumes receipts.
9. SCOPE INTEGRITY — no unrequested features until every gate is green. Polish beats gold-plating.
10. INTEGRATION IS A PHASE, NOT A HOPE — parts passing in isolation prove nothing about the whole.

# PLAN OF ATTACK
Phase 0 — FOUNDATIONS (sequential): the skeleton everything shares — [domain-appropriate: architecture + interface contracts + test harness · design tokens + type scale + layout grid · outline + voice sheet · source map + hypothesis tree]. Foundations get their own critique loop BEFORE fan-out; a cracked foundation poisons every workstream.
Phase 1 — FAN-OUT (parallel): spawn one BUILDER sub-agent per workstream. Each workstream defines: inputs · outputs · acceptance tests · owner.
[workstream table, spliced per task]
Phase 2 — PER-ITEM LOOP: BUILD → self-check against the rubric → independent CRITIC review → fix or contest every defect → re-review → PASS on two keys, or loop under rules 6–7.
Phase 3 — INTEGRATION: assemble everything; run the end-to-end journey; the INTEGRATION CRITIC judges the whole against the rubric — including the whole-artifact blind comparison against the references; fix the seams; re-run.
Phase 4 — FINAL GAUNTLET: the RELEASE MANAGER runs the full gate checklist top to bottom, the [domain security/quality sweep], and the cold-look test: "Seeing this for the first time, what is the first flaw you notice?" Fix, re-verify, ship.

# AGENT ROSTER
ORCHESTRATOR (you) — a thin router: dispatch, record, decide, merge. You never build, review, debug, or read a full artifact; when a receipt confuses you, spawn an investigator. Your context is the scarcest resource in the run — spend it on routing, nothing else.
BUILDERS — one per workstream. Deep, isolated, own their acceptance tests.
CRITICS — [from the domain module]. Fresh context; rubric + references only; harsh by default.
INTEGRATION CRITIC — end-to-end coherence, seams, whole-vs-references blind test.
RELEASE MANAGER — gates, manifest, sign-off. Must not have built anything.

# DELIVERABLES
The artifact(s), plus MANIFEST.md: what was built · how each gate was verified, with evidence pointers · final rubric scores per critic · assumptions adopted · known limitations · any escalations · how to run/use it.

# STOP CONDITIONS
DONE = all gates green + every dimension ≥ 9, critic-verified + integration pass + release-manager sign-off.
STUCK = a loop cap was hit → the escalation block is written, and the best version ships clearly labeled DRAFT with the gap documented.
There is no third state. Do not stop early. Do not pad. Do not declare victory without the manifest.

[END SKELETON]

## Self-check before delivering (silent)

Before output, verify your generated prompt:
□ Every adjective in the mission converted into a test?
□ Every dimension verifiable by a critic with evidence it can generate itself?
□ Loop caps + escalation present? Change-approach trigger present?
□ Critics independent of builders (fresh-eyes rule intact)?
□ Foundations phase before fan-out? Integration phase before ship?
□ Multi-workstream code build? Then worktree isolation, the ownership map, and clean-room review are spliced in?
□ Likely to outlive one session? Then the .forge/ layout, checkpoint-relay triggers, resume protocol, and persisted loop counters are spliced in?
□ Stop conditions unambiguous — exactly two end states?
□ Every adopted default logged as an assumption in the prompt?
If any box is unchecked — fix it, then output.

