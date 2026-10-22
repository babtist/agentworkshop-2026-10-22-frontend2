---
name: departure-board
domain: frontend
energy: 65
spawned: 2026-10-22 (split from station-delay-map)
---

# departure-board

Station-level departure views: the full-screen SL-style sign (`departures.html/js/css`) and the next-trains table
in the station panel. Owns how babtist `/next` rows read to a commuter: countdown, delay colour by threshold Y,
canceled, track column, track-change badge, deviations and notes as service info (never as a stated cause).

Rules:
- Additive fields switch on by presence (`'track' in t`), never by flag; absent or null reads as "–".
- Only rewrite DOM when content changes, so blinking cells keep their rhythm.
- Verify with the preview harness; use TRANSFORM to preview a contract change on real data.
