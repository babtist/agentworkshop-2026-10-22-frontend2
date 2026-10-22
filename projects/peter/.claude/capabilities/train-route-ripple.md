---
name: train-route-ripple
description: Shows one train's stops and the expected delay per coming stop (babtist /api/snapshot) on the map and in the station panel.
energy: 60
spawned: 2026-10-22
---
# train-route-ripple
- Owns `board/public/colony/peter/train-route.js` and the `.tr-*` styles.
- Fetch snapshot only while a train is open; cache 20 s; never poll in the background.
- Passed = any actual time, matching babtist's nextStation rule. Delay never negative, coloured against `minutes`.
- Keep the long list out of the popup (it hides the route); the station panel holds it.
- Verify with `?train=<number>` deep link and a 40 s Chrome virtual-time budget when the live server is slow.
