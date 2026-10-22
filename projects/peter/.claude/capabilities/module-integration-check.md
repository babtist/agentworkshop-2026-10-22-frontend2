---
include-custom-instructions: true
name: module-integration-check
type: capability
domain: meta
tools: Read, Grep, Glob, Bash
energy: 70
spawned: 2026-10-22
can-merge-with: [delay-display-ui]
---

# Module Integration Check Capability

## What This Enables

Keeps team peter's tile honest against the other teams' REAL modules: babtist's controller
(`/t/babtist/api/*`) today, frallan's risk advisory (`/t/frallan/api/risk`) when it ships. Negotiates the
consumer side of contracts in `#build` and reports faults to the owning team.

## Activation Triggers

- A team announces a contract or contract change in `#build` that peter consumes
- A release puts a module we depend on live (colony / release posts)
- The tile shows "No data", stale or wrong levels

## Operating Protocol

1. Read the owner's `projects/<team>/CONTRACT.md` (from main, or from their PR branch if not merged).
2. Hit the live endpoints on The Square's origin with curl: status, displays PUT/GET, stream (curl -sN -m 3), health.
3. Compare field by field with the contract and with what `board/public/colony/peter/app.js` reads.
4. On mismatch: post in `#build` as `@<team>` with what was sent, expected and received. Never edit their folders.
5. Agree consumer-side choices (polling interval, how unavailable/demo states render) in `#build`
   and record them in `projects/peter/INTERFACES.md`.

## Boundaries

Does NOT build the tile (delay-display-ui does) and never changes another team's module or contract.

## Evolution History

- 2026-10-22: Spawned at awaken: babtist live with real data, frallan proposing a risk contract to peter

## Live proxy check (from spore backend-7)
Before delivering UI that reads another team: serve our tile files locally and proxy /t/* to the live board (turn SSE into one event plus retry and end, so headless Chrome finishes). Screenshot against real data, not only mocks. Fake only endpoints that are not live yet.

## Activate on release (spore frontend2-14)
When another team's asset or route is not live yet, write consumer code that treats only the exact 404/missing
asset as "not yet" (keep the fallback) and runs the real path the moment it ships. No manual flag. Test the real
path early by serving a fake of their asset with the preview harness (OVERRIDE_DIR).

## Prove the consumer read the field (spore backend-11)
A 200 or a passing test does not prove the field is used. After a producer releases a field, screenshot the real
deployed path with live data and check the visible output changes (track column appears, notices strip fills).
