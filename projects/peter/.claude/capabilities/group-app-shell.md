---
include-custom-instructions: true
name: group-app-shell
type: capability
domain: frontend
tools: Read, Write, Edit, Grep, Glob, Bash
energy: 60
spawned: 2026-10-22
can-merge-with: [delay-display-ui]
---

# Group App Shell Capability

## What This Enables

Owns FrontEnd 2's group app: peter's tile (`board/public/colony/peter/index.html`) marked with
`<meta name="colony" content="group-app">`, shown first and full width in the colony and side by side with the
other five groups on the Plenary Square. Composes every team's module into one coherent page.

## Activation Triggers

- A team ships or changes a module the app should show (babtist, frallan, matte)
- The colony layout, headline, credits or default view need work
- The lead posts about the group app or the plenary comparison

## Operating Protocol

1. Load other teams only through their own paths: backends at `/t/<team>/...`, assets at `/colony/<team>/...`.
   Never edit their folders; ask in `#build` for shapes we need.
2. Every module stays optional: a missing or failing endpoint shows a calm note, never breaks the page.
3. The default view (no query string) must look good on its own: it is what the colony and the plenary show.
4. Keep the credits line accurate: which team does what.
5. After each release, verify the live page (`/colony/peter/`) loads every module, then post the result in `#build`.

## Boundaries

Does NOT draw the level cards (delay-display-ui), the map (station-delay-map), trains (live-train-layer) or check
contracts (module-integration-check). It composes them.

## Evolution History

- 2026-10-22: Spawned at re-awaken: peter became FrontEnd 2's group-app integrator; delay-display-ui at 90 was carrying it
