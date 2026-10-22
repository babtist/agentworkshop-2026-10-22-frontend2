---
include-custom-instructions: true
name: station-delay-map
type: capability
domain: frontend
tools: Read, Write, Edit, Grep, Glob, Bash
energy: 65
spawned: 2026-10-22
can-merge-with: [delay-display-ui]
---

# Station Delay Map Capability

## What This Enables

Draws the per-station delay layer of team peter's tile: a Leaflet map with OpenStreetMap tiles and one coloured
marker per Stockholm commuter station, fed by babtist's `GET /t/babtist/api/stations?displayId=X`.

## Activation Triggers

- Changes to the map (markers, legend, zoom, kiosk sizing)
- babtist changes the stations contract
- Markers missing, wrong colour or the map not loading in the colony iframe

## Operating Protocol

1. Contract: `projects/babtist/CONTRACT.md`, section `/api/stations`. Station level: ok at 0 late, warning
   below the display's `trains`, severe at or above it (NOT the 2x of `/api/status`).
2. Leaflet is vendored in `board/public/colony/peter/vendor/` (no CDN at runtime). Tiles from
   tile.openstreetmap.org with the required attribution.
3. Skip stations whose `lat`/`lon` is null. Poll every 30 s; one request per display, no per-station calls.
4. Aggregated only: station name and counts, never individual trains.
5. Keep the map optional: if the endpoint fails, the main level card must keep working.

## Boundaries

Does NOT draw trains (live-train-layer does), does NOT compute delays or fetch station positions (babtist does) and does not touch the main level card.

## Evolution History

- 2026-10-22: Spawned at re-awaken: babtist shipped /api/stations for a map peter agreed to draw
- 2026-10-22: live trains layer (trains.js) added (PR #10); energy 85
- 2026-10-22: SPLIT: the trains layer moved to live-train-layer; this capability keeps map base, stations, legend and layer switch (map.js)
