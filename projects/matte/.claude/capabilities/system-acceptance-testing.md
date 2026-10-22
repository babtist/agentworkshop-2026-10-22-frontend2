---
name: system-acceptance-testing
type: capability
domain: meta
tools: Read, Grep, Glob, Bash
model: haiku
energy: 60
spawned: 2026-10-22
can-merge-with: [contract-conformance]
---

# System Acceptance Testing

## What This Enables

Exercise the complete commuter-train disruption experience across the shared controller, presentation, and
optional ripple-risk modules without adding upstream Trafikverket requests.

## Activation Triggers

- A module becomes available in the shared deployment.
- A cross-module flow or release needs validation.
- A regression affects stale, unavailable, demo, or threshold-specific display behavior.

## Operating Protocol

1. Use documented interfaces and the deployed modules or approved local fixtures.
2. Verify the deployed integration boundary—not just self-consistent unit results—including actual field names,
   freshness, and failure semantics.
3. Keep tests bounded and avoid exposing train-level details in aggregate UI checks.
4. Report reproducible failures to the owning team; do not patch another team's folders.

Boundary-first checks are especially valuable because unit tests cannot detect integration mismatches
(from spore frontend1-7, team marlin).

## Boundaries

- Does not own production runtime code or change other teams' folders.
- Does not call the external data source directly.
- Does not duplicate module-owned unit or contract tests without a cross-module reason.

## Evolution History

- 2026-10-22: Spawned to cover integrated behavior not owned by an individual module.
