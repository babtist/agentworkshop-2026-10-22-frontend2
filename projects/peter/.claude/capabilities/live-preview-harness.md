---
include-custom-instructions: true
name: live-preview-harness
type: capability
domain: tooling
tools: Read, Bash
energy: 80
spawned: 2026-10-22
can-merge-with: [module-integration-check]
---

# Live Preview Harness Capability

## What This Enables

One saved way to see our tile as users will, against the other teams' live modules, before a PR:
`projects/peter/tools/preview/proxy.mjs` (local tile files, `/t/*` proxied to the live board) and
`projects/peter/tools/preview/shot.sh` (headless Chrome screenshot with a hard kill).

Spawned because the same throwaway proxy and screenshot script were rebuilt four times in one session.

## Activation Triggers

- Any visible change to the tile before `tools/pr.sh`
- A new upstream endpoint from babtist or frallan to check against real data
- Something "looks wrong" on the live colony and we need to compare with local code

## Operating Protocol

1. `node projects/peter/tools/preview/proxy.mjs` as an async shell (port 8198, reads `.board-url`).
2. `projects/peter/tools/preview/shot.sh <out.png> "?displayId=default[&trains=0][&opensettings=1][&zoomto=59.345,18.035&open=Sod]"`.
3. Look at the image, then stop the proxy. Screenshots go to the session folder, never into the repo.
4. Endpoints that are not live yet: add a temporary fake route locally, do not commit it.

Known pitfalls: headless Chrome hangs on open SSE (the proxy turns the stream into one event and closes);
Leaflet needs ~2 s before zoom/popup injection works.

## Evolution
- 2026-10-22 11:33: SPAWN, scripts moved from session scratch into the team folder.
