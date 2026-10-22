---
include-custom-instructions: true
name: live-train-layer
type: capability
domain: frontend
tools: Read, Write, Edit, Grep, Glob, Bash
energy: 65
spawned: 2026-10-22
can-merge-with: [station-delay-map]
---

# Live Train Layer Capability

## What This Enables

Draws moving commuter trains on peter's map (`board/public/colony/peter/trains.js`), fed by babtist's
`GET /t/babtist/api/trains?displayId=X`: one arrow per train, popup with delay and next/last station.

## Activation Triggers

- Changes to train markers, popups, the Trains toggle or the polling
- babtist changes the trains contract
- Trains missing, misplaced, wrongly coloured or stale on the map

## Operating Protocol

1. Contract: `projects/babtist/CONTRACT.md`, section `/api/trains`. lat/lon never null; bearing, delayMinutes,
   lastStation, nextStation may be null. `to` is a LIST of destination signatures: show names from the stations
   list exposed by map.js (`window.peterMap.names`), fall back to the signature.
2. Colour by delayMinutes against the display's `minutes` threshold (green < Y, orange >= Y, red >= 2Y), blue when
   no delay is reported, grey cross when canceled. Diamond when bearing is null. Fade positions older than 2 min.
3. Poll every 10 s, one request per page, only while the Trains layer is on and the tab is visible. Reuse markers
   by trainId instead of redrawing, so open popups survive a poll.
4. 404 means not deployed yet: show a calm note, never break the station map.
5. Verify before live: run babtist's plugin from their PR branch on a local board with `TRAFIKVERKET_URL` pointed
   at a fake upstream (shapes in their `test/trains.test.js`).

## Boundaries

Does NOT own the map base, stations or legend (station-delay-map does) and does not compute delays.

## Evolution History

- 2026-10-22: SPLIT from station-delay-map (energy 85, carrying two layers with different contracts and cadences)
- 2026-10-22: train-shaped SVG markers, glide, zoom labels, legend; energy 65
