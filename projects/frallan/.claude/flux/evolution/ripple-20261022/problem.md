# Ripple-effect detection: initial exploration

Context: general/backend advisory analysis, with correctness and bounded-memory
constraints. Claim: #build 26. Input and output proposals: `CONTRACT.md`.

No agreed train snapshot exists yet; babtist currently publishes aggregates.
Do not implement, invent a dependency contract or infer physical track conflicts.
The first generation consists of solver specifications, not executed solvers.
No measured fitness, test results, causal accuracy or winner exists.
The flux-core invocation failed on unsupported `model: opus`; removed that
override to use harness defaults. Initial state was prepared in the parent.
Graveyard currently contains no recorded failed genomes.

## Shared evaluation rubric

Evaluate against the agreed input before selection: supported data prerequisites
(30%), explainable conservative output (30%), bounded shared processing (20%),
and executable acceptance cases (20%). Scores remain unevaluated until evidence
exists. Prefer no answer over an unsupported all-clear.

All candidates require defensive >= 0.5 and testing >= 0.6. No risky high-weight
traits. Testing includes non-ready, stale, demo and incomplete data states.
Do not build three runtime implementations: compare prerequisites first.

## Candidates

- alpha: observed station/time-window disruption clustering.
- beta: same-direction station headway overlap heuristic.
- gamma: route/network propagation graph.

Initial state above records the original uncertainty. After specification-only
PR #9, gen-002 incorporates the deployed snapshot: destination grouping is
available, explicit direction and network topology are not. The parent executed
the evolution step because this session's registered flux-core still retains
the unsupported model override despite the file repair. No runtime scores exist.

Select by generation three at
latest, or earlier if an evidence-backed winner is clear; archive rejected
approaches with their contextual limitations rather than invented scores.
