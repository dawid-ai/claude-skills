# FORGE intake — gap check and question banks

STEP 1 — ANALYZE THE TASK

1. Classify the domain(s): CODE · GAME/VISUAL · WEB/PRODUCT DESIGN · WRITING/CREATIVE · RESEARCH/PROBLEM-SOLVING · DATA/ANALYSIS · MIXED (combine modules; the union of gates applies).
2. Extract what is already given: goal, audience/user, platform/stack, references, constraints, non-goals, risk profile, deadline/budget.
3. Gap-check: can you write a *measurable* Definition of Perfect from what you have? Four universal must-haves:
   - QUALITY ANCHOR — a reference, exemplar, or comparison target that defines "great."
   - AUDIENCE & CONTEXT — who it's for, where it runs or lives.
   - HARD CONSTRAINTS — stack, scope, compliance, budget, deadline.
   - DONE MEANS — the observable end state.
4. If the user's message mentions runner-specific commands or conventions (e.g. /loop, a subagent syntax, a Task tool), adopt them verbatim in the execution prompt. Otherwise use generic "spawn a sub-agent" language.

STEP 2 — ASK ONLY WHAT CHANGES THE BUILD

Ask if — and only if — a must-have is missing AND a reasonable default would risk building the *wrong thing* (not merely a slightly different thing).

Rules for asking:
- ONE message. Maximum 6 questions, ordered by leverage.
- Every question ships with a smart default in [brackets].
- Convert vague desires into concrete choices. Not "what style do you want?" but "pick the closest vibe: (a) X, like [ref] · (b) Y, like [ref] · (c) Z, like [ref] [default: b]".
- Close with exactly: "Answer any subset — or reply 'defaults' and I'll proceed with the bracketed assumptions, logged in the prompt."
- Never ask about: things already stated, things that don't alter the plan, or anything you can decide well and log as an assumption.

Domain question banks (draw from these; don't recite them all):

CODE — Exposure: local tool / internal / public internet? [default: assume public and hostile]. Data sensitivity? [default: treat all data as sensitive]. Stack? [default: mainstream, boring, justified]. Performance target? [default: interactions <100ms, cold start <2s]. Test expectations? [default: acceptance tests written before code].

GAME/VISUAL — Reference works: name 2–3 you want this compared against? [default: FORGE names 3 best-in-class references itself and logs them]. Three adjectives for the feel? [default: derived from the references]. Platform + perf budget? [default: modern desktop browser, 60fps sustained]. Interaction scope? [default: the minimum set of interactions that makes it feel real].

WEB/PRODUCT DESIGN — Brand assets (colors/type/logo/voice), or invent? [default: invent from adjectives + references; deliver a mini brand kit]. 2–3 sites you love and 2–3 you hate, with why? [default: FORGE picks exemplars and anti-exemplars from the industry]. Who is the visitor and the ONE action they should take? [default: inferred from the product]. Real copy or placeholder? [default: write real, credible, specific copy; flag anything factual for correction].

WRITING/CREATIVE — Audience? Venue? Length? A voice exemplar (author/publication)? [defaults: educated general reader · standalone piece · the length the content earns · voice matched to 2 named exemplars].

RESEARCH/PROBLEM-SOLVING — What decision does this feed? Acceptable confidence level? Allowed sources? [defaults: decision-grade rigor; every load-bearing claim verified against primary sources].

