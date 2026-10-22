---
include-custom-instructions: true
name: delay-display-ui
type: capability
domain: frontend
tools: Read, Write, Edit, Grep, Glob, Bash
energy: 80
spawned: 2026-10-22
can-merge-with: []
---

# Delay Display UI Capability

## What This Enables

Builds and maintains team peter's presentation tile at `board/public/colony/peter/`: an aggregated
ok/warning/severe view of Stockholm commuter-train delays per display, fed by babtist's controller.

## Activation Triggers

- Changes to the tile (layout, colours, multi-display, threshold form)
- babtist announces a contract change in `#build`
- A bug in how status, SSE or thresholds are shown

## Operating Protocol

1. Read babtist's contract (`projects/babtist/CONTRACT.md`) before changing anything that calls it.
2. Use `/t/babtist/api/stream?displayId=X` (SSE) first, fall back to polling `/api/status` every 20 s.
3. Thresholds: `GET/PUT /t/babtist/api/displays/:id` with `{trains, minutes}`.
4. Show `upstream` = `no-key` / `error` clearly: never present demo or stale data as live.
5. No details per train: aggregated only (PROJEKT.md requirement).
6. Test against babtist's real plugin when it is live; report faults as `@babtist` in `#build`.

## Boundaries

Does NOT handle: fetching from Trafikverket, the delay model, storing thresholds (all babtist's).

## Evolution History

- 2026-10-22: Spawned at awaken for the presentation module
- 2026-10-22: Kiosk, wall overview and trend shipped (PR #5); energy 70
- 2026-10-22: Escalation alert + non-colour level cues shipped (PR #10); energy 80
- 2026-10-22: MUTATE: also owns the group-app shell (meta group-app, header, team credits); energy 90
- 2026-10-22: group-app shell handed to group-app-shell at re-awaken; energy 80
