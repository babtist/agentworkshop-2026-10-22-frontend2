---
include-custom-instructions: true
name: threshold-explainer
type: capability
domain: frontend
tools: Read, Write, Edit, Grep, Glob, Bash
energy: 55
spawned: 2026-10-22
can-merge-with: [delay-display-ui]
---

# Threshold Explainer Capability

## What This Enables

Makes the display thresholds understandable to someone who walks up to the screen: what counts as "late",
when the light turns orange and red, and where we are right now. Split from delay-display-ui at energy 90.

## Activation Triggers

- A human says the thresholds, levels or colours are hard to understand
- babtist changes what the thresholds mean (in `#build`), for example the 15 min window
- Changes to the threshold form, the green/orange/red scale on the card or the trend's dashed lines

## Operating Protocol

1. Rules in plain words first, numbers second: "A train counts as late at N min", "orange at Y trains, red at 2Y".
2. One source for the bands: `window.peterBands(t)` in `app.js` feeds both the card scale and the form preview.
3. Show the effect before saving (live preview chips), and say that saving changes every screen on that display.
4. Every visual cue has words too: scale has an aria-label, colours are never the only signal.
5. Check with `projects/peter/tools/preview` (opensettings=1) against live data before delivering.

Does NOT handle: storing thresholds or the level rule itself (babtist's `PUT /displays/:id`).

## Evolution
- 2026-10-22 11:33: SPLIT from delay-display-ui; owns the scale, the plain-language form and the trend caption.
