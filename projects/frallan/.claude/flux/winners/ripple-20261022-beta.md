---
generation: 3
status: selected-for-implementation
context: general
fitness: eligible-for-implementation
runtime-fitness: unmeasured
traits:
  analytical: 0.7
  defensive: 0.8
  methodical: 0.8
skills:
  api-design: 0.8
  testing: 0.8
---

# Final mutation: contract-first, deterministic implementation handoff

Implement only station-destination-overlap-v1 from CONTRACT.md.
Increase methodical/API-design emphasis to preserve the exact announced schema,
not introduce another endpoint shape during implementation.

The pure analyzer must receive evaluation time and thresholds explicitly.
Compare numeric instants, canonicalize destination sets without modifying input,
and treat service-date train IDs as opaque stable identifiers. Do not reconstruct
identities from dates or depend on a controller's private storage.

Preserve the distinction between advisory overlap and physical conflict.
Use the contract's conservative non-ready states, freshness/cap guards and
distinct follower count. Acceptance examples must become executable tests before
delivery; no passing tests or measured predictive accuracy are claimed now.

Final feasibility: meets the narrow advisory scope with available snapshot
fields, bounded processing and agreed presentation behavior. Eligible to select
for implementation, not certified operationally accurate.

Selected automatically at generation three: the only candidate that satisfies
both the narrow advisory scope and currently available data prerequisites.
Earlier generations remain as historical records under
evolution/ripple-20261022/timeline-beta/. Numeric runtime fitness is unavailable;
selection uses the explicit feasibility gates recorded in learnings.md.

## Implementation evidence

The selected method is now implemented in board/plugins/frallan/risk.js and
exposed by the plugin's /api/risk adapter. Fourteen focused Node tests passed,
including real-controller integration with a local fake upstream, shared
snapshot reads, per-display settings, outage/recovery, and advisory boundaries.
A local HTTP adapter also returned ready with upstream ok against babtist's
deployed real snapshot. These are functional observations, not evidence of
railway predictive accuracy or a retrospectively invented selection score.
