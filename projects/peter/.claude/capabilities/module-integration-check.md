---
include-custom-instructions: true
name: module-integration-check
type: capability
domain: meta
tools: Read, Grep, Glob, Bash
energy: 60
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
