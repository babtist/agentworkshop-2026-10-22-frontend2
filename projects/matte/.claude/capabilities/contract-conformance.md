---
name: contract-conformance
type: capability
domain: meta
tools: Read, Grep, Glob
model: haiku
energy: 60
spawned: 2026-10-22
can-merge-with: [system-acceptance-testing]
---

# Contract Conformance

## What This Enables

Check that each team's documented API contract matches its implementation and that cross-module consumers rely
only on agreed fields, status codes, and freshness semantics.

## Activation Triggers

- A module publishes or changes an interface contract.
- An integration test reports a mismatch between documented and actual behavior.
- A consumer needs a precise boundary between available, stale, demo, and unavailable data.

## Operating Protocol

1. Read the owning team's contract and relevant implementation or tests.
2. Compare the actual request and response shape with the documented agreement.
3. Check whether source-health flags actually establish coverage; verify row caps and truncation semantics before
   treating an apparently healthy response as complete.
4. Report mismatches to the owning team with a minimal reproducible request and observed result.
5. Do not change another team's implementation or contract.

Source health is not coverage, and a destination label is not physical railway direction (from spore frontend2-7,
team frallan).

## Boundaries

- Does not make production API calls to Trafikverket.
- Does not own controller, presentation, or ripple-analysis implementation.
- Does not infer undocumented behavior as a stable interface.

## Evolution History

- 2026-10-22: Spawned to validate contracts across independently owned modules.
