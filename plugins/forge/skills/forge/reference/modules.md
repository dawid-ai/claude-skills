# FORGE domain modules — splice only the ones matching the classified domain(s)

MODULE: CODE
Dimensions: Correctness (all acceptance + edge tests green) · Simplicity · Security · Robustness (failure modes, timeouts, malformed input, idempotency where relevant) · Readability (a stranger navigates the codebase in under 5 minutes) · Performance (numeric budget).
Gates: 100% of acceptance tests green · security checklist clean · zero secrets in code, client bundles, logs, or VCS history · lint clean · dependency audit clean · destructive operations default to dry-run.
Critics:
- CORRECTNESS CRITIC — writes and runs tests the builder didn't think of: edges, concurrency, malformed input, boundary values. Actively tries to break it. A review that attempts no new tests is invalid.
- SIMPLICITY CRITIC — for each unit asks: could this be 30% shorter without losing clarity? Is there a stdlib or well-known-library solution? Is any abstraction speculative (used once)? Can code be deleted? Can a dependency be dropped? Finding a simpler-but-equally-secure alternative is a MAJOR defect, filed with a sketch of the alternative.
- SECURITY CRITIC — assumes hostile input everywhere. Checklist: secrets management (nothing sensitive in code, bundles, logs, error messages, or history) · input validation and sanitization at every trust boundary · the injection family (SQL / command / template / path traversal) · XSS, CSRF, SSRF as applicable · authn + authz on every entry point, least privilege · unsafe deserialization · dependency CVEs · rate limiting and abuse handling where exposed · error messages leak nothing internal. Must attempt at least 3 concrete attacks appropriate to the artifact and document each outcome.

MODULE: VERSION CONTROL — splice whenever CODE or DATA is involved AND there is more than one workstream. For single-workstream builds, use only the LIGHT PROTOCOL line at the end.
Three jobs: parallel builders never touch the same tree · merge becomes the physical enforcement of the two-key rule · review stays uncontaminated by history.

ISOLATION
- One branch + one dedicated worktree per workstream (git worktree add ../ws-scanner ws/scanner). Builders write only inside their own worktree; nobody edits main directly. If worktrees are unavailable, workstreams run sequentially — never two builders in one tree.
- OWNERSHIP MAP — a Phase 0 deliverable: every path in the repo assigned to exactly one workstream. Shared surfaces (interface contracts, schemas, design tokens, the test harness) freeze on main when foundations pass and belong to the orchestrator thereafter.
- CONTRACT-CHANGE PROCEDURE — a builder needing a shared-surface change files a request; the orchestrator applies it on main in a dedicated commit; every affected workstream rebases and re-greens before its next review. No builder ever edits another workstream's files. A merge conflict on a file outside your ownership = contract drift = BLOCKER; escalate, never quietly resolve.

MERGE = THE GATE
- main is protected. Only the RELEASE MANAGER merges (or the orchestrator wearing that hat — never a builder), and only when the two keys are logged: builder evidence + independent critic verdict, all workstream gates green. Green = merge; anything else = no merge.
- Rebase onto latest main and re-run gates before requesting merge — integration surprises surface in the branch, not on main.
- STAGES for large builds: group workstreams into stages (e.g. foundation → core → features → polish). A stage closes only when every workstream in it has merged green AND the integration pass on the merged state is green. Tag it (stage-N-green); the next stage branches from the tag. Stage tags double as relay checkpoints — see ORCHESTRATION & CONTINUITY.
- Every loop iteration commits (a checkpoint); a failed approach is abandoned by branch, never by un-editing files — this is what makes the CHANGE-APPROACH trigger cheap. Ship candidates are tags; a failed integration is a revert of the merge plus a filed defect, never a hotfix on main.

CLEAN-ROOM REVIEW — protects the fresh-eyes rule from history
- Critics never review a branch, a PR, or a diff. For every review, export the candidate tree with no history: git archive <sha> | tar -x -C <fresh dir>. No .git, no log, no messages, no PR body, no visible iteration count. The critic judges that directory + rubric + references, and writes its full verdict before anyone shows it a diff.
- Diffs have exactly one sanctioned job, afterwards: the convergence check. Commit messages carry defect IDs and state what changed, never why it was hard ("group by pHash bucket; fixes D-12, D-14") — so "was every open defect addressed or contested?" is mechanical bookkeeping. Quality is judged from state; only convergence is judged from history.
- CI runs the gate suite on every push and on main (GitHub Actions if a remote exists; a local `make gates` script if not). CI output is machine-generated evidence — it satisfies the evidence rule for the gates it covers, and no one has to trust a pasted log. Critics may still re-run anything.
- If merging via GitHub PRs: the PR body is written by the RELEASE MANAGER after the verdict, as a record of the two keys and gate evidence — it is documentation of the decision, never input to it.

LIGHT PROTOCOL (single-workstream builds): one branch · commit per loop · tag the ship candidate · clean-room export for reviews · run the gates script before ship. Skip worktrees, stages, and PRs.

MODULE: ORCHESTRATION & CONTINUITY — splice into every build with more than one workstream or more than one stage, any domain. The orchestrator's context WILL fill, and models degrade well before hard limits. Design crash-only: the run must survive losing its orchestrator at any moment.

THE ORCHESTRATOR IS A THIN ROUTER
- Dispatch, record, decide, merge — nothing else. Never build, review, debug, or read full artifacts, logs, or reports. When judgment on content is needed, spawn a reader or investigator sub-agent and consume its receipt.
- RECEIPTS — every sub-agent writes its full output to files and returns at most 10 lines: {agent · item · loop # · verdict PASS/FAIL/ESCALATE · defect counts by severity · files written · next need}. Agents exchange file paths, never pasted content.

STATE ON DISK — a .forge/ directory at repo root, gitignored (so clean-room archive exports physically cannot contain it, and critics never learn the iteration count):
- PROMPT.md — this execution prompt, written verbatim at boot, immutable. The mission must never exist only in a context window.
- STATE.json — the machine snapshot, current-state only: stage · per-workstream {status, loop_count, scores, open defect IDs} · handover count. Loop counters live here and MUST survive handover — a fresh orchestrator with reset counters silently re-arms the infinite loops rule 7 exists to kill.
- HANDOVER.md — overwritten at every checkpoint: NEXT ACTION (imperative, specific) · in-flight nuance not yet in structured files · active warnings. Must pass the stranger test: a stranger holding only PROMPT.md + STATE.json + HANDOVER.md can take the next action without asking anything.
- LEDGER/ (per-workstream defect ledgers) · DECISIONS.md (append-only: decision + rationale) · reviews/ (full critic verdicts, builder evidence). History lives here and is read per-item on demand — never wholesale on boot.
- Writes are atomic (write .tmp, rename) and happen before acting on the change. Resume-packet budget: STATE.json + HANDOVER.md ≤ 150 lines combined; if it keeps growing, detail is leaking out of LEDGER/.

CHECKPOINT & RELAY — retire the orchestrator before it degrades; never rely on emergency compaction.
- Checkpoint triggers: every stage close (the stage-N-green tag IS a checkpoint) · every ~10 dispatches within a stage · any sign of drift, fuzziness, or an auto-compact event. Aim to retire each orchestrator by roughly half its capacity — well before the 60–70% degradation cliff.
- A checkpoint = finish the current atomic operation (never hand over mid-merge or mid-dispatch) → flush STATE.json → write HANDOVER.md → hand the baton: announce "CHECKPOINT — start a fresh session and say resume." A fresh orchestrator cold-booting from disk beats a tired one dragging a clogged transcript, and beats any auto-compacted summary — which is lossy paraphrase performed by an already-degraded model that cannot tell which defect IDs, counters, and thresholds are load-bearing.

RESUME PROTOCOL — the first moves of any orchestrator that finds .forge/ present:
1. Read PROMPT.md, then STATE.json, then HANDOVER.md. Nothing else yet.
2. Reconcile against reality: git tags and commit messages (which carry defect IDs) are ground truth for artifacts; .forge/ is ground truth for process. Work in git but not in state → update state from git. State claiming work git doesn't show → distrust state, re-verify before proceeding.
3. Restate the situation in ≤10 lines: stage, per-workstream status, next action. Any mismatch with HANDOVER.md is resolved before acting.
4. Execute NEXT ACTION. Do not re-plan what is already planned; do not re-review what is already two-keyed.

BOOTSTRAP (Claude Code) — at Phase 0, write CLAUDE.md containing: "If .forge/ exists: run the RESUME PROTOCOL from .forge/PROMPT.md before anything else." Any fresh session in the repo then self-orients, even if the human only types "continue." Do not depend on --resume, /compact, or auto-compact for continuity: they restore or summarize the transcript, and the transcript is exactly the thing being retired. (Optional, headless: a supervisor script can re-invoke a fresh session on the resume packet after each checkpoint until STATE.json reads DONE.)

LIGHT PROTOCOL (single-workstream, single-stage builds): one STATE.md holding a status block + next action + assumptions, updated every loop; PROMPT.md saved at boot; resume = read both. Skip the rest.

MODULE: GAME / VISUAL
Dimensions: Composition & art direction · Lighting & materials · Motion & physics feel · Detail density (textures, particles, micro-animation) · Cohesion (nothing breaks the world) · Performance (fps budget on target hardware) · Sound, if in scope.
Gates: 60fps sustained on target · no visual artifacts at the defined resolutions · every interactive element responds <100ms · blind test passed (below).
Protocols:
- SCREENSHOT PROTOCOL — define 6–10 canonical shots (states × angles × resolutions) up front. Every visual review uses the same shots, so progress is comparable across loops.
- RENDERED-ONLY RULE — visual critics judge rendered screenshots and recordings ONLY. Reviewing the code and imagining the pixels is not a review.
- BLIND A/B — the VISUAL CRITIC receives unlabeled pairs: each canonical shot next to its matching reference. It must pick the better one per pair and say why. SHIP BAR: the build wins or draws the majority of pairs, its losing reasons are filed as defects, and the bar holds across two consecutive reviews.
- FEEL PASS — the MOTION CRITIC judges recordings of interaction only: weight, easing, responsiveness, physicality. Verdicts like "floaty" or "stiff" must cite the exact interaction and timing.

MODULE: WEB / PRODUCT DESIGN
Dimensions: Brand distinctiveness (cover the logo — is it still recognizably this brand?) · Visual hierarchy & typographic rhythm · Copy quality (real, credible, specific) · Responsiveness (360 / 768 / 1440 defined states) · Accessibility (AA contrast, keyboard, focus states) · Conversion clarity (the one action is unmissable) · Craft details (consistent spacing scale; hover, loading, empty, and error states).
Gates: WCAG AA contrast · fully keyboard-navigable · screenshots at all three widths, clean · zero console errors · brand kit applied consistently · the critic's template-smell verdict: "could this be mistaken for a purchased template?" must be NO.
Protocols: SCREENSHOT PROTOCOL and RENDERED-ONLY RULE as in GAME/VISUAL. EXEMPLAR REVIEW — the critic scores against the loved list ("does this earn a place next to these?") and the hated list ("does it share any sin with these?"), naming specifics.

MODULE: WRITING / CREATIVE
Dimensions: Audience fit · Structure & momentum · Voice consistency against the exemplars · Precision (every claim true, every word earning its place) · Freshness (cliché sweep clean) · Opening & closing strength.
Gates: load-bearing claims fact-checked · the 15%-cut test performed (cut 15%, compare, keep the better version) · read-aloud pass with every stumble fixed.
Critics: AUDIENCE CRITIC — reads as the target reader and marks every point of confusion or boredom with the exact line · LINE EDITOR — harsh, line-level, quotes what it cuts · FACT CHECKER — verifies claims against sources, not vibes.

MODULE: RESEARCH / PROBLEM-SOLVING
Dimensions: Problem framing · Coverage of the solution space (≥3 distinct approaches steelmanned before choosing) · Evidence quality (primary sources for load-bearing claims) · Reasoning validity · Actionability.
Gates: red-team pass — a critic attempts to falsify the conclusion and either fails or the conclusion updates · assumptions ledger complete · sensitivity check — the single assumption that would flip the answer if wrong is identified and flagged.
Critics: RED TEAM — argues the strongest opposite case as if paid to win · SOURCE AUDITOR — verifies every citation actually says what is claimed · PRACTITIONER — "would someone who does this daily wince?"

DATA/ANALYSIS — use RESEARCH plus CODE modules; add gates: raw data untouched (transformations scripted and reproducible) · every chart's claim survives the "so what?" test · uncertainty stated, never hidden.

