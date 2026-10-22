# peter: interfaces

peter owns PRESENTATION: the tile at `/colony/peter`.

- Consumes babtist's controller (`projects/babtist/CONTRACT.md`):
  `GET /t/babtist/api/stream?displayId=X` (SSE, live), `GET /t/babtist/api/status?displayId=X` (polling fallback, 20 s),
  `PUT /t/babtist/api/displays/X` `{trains, minutes}` (threshold form).
- One display: `/colony/peter/?displayId=<id>` (id `[A-Za-z0-9_-]{1,40}`, default `default`), live via SSE.
  Each screen in a hall opens its own id and gets its own thresholds.
- Wall overview: `/colony/peter/?displays=a,b,c` (up to 12), polls `/api/status` every 15 s per display:
  no SSE per card, because browsers cap connections per origin and babtist caps streams.
- Kiosk: add `&kiosk=1` for a full-screen view without controls.
- Station map (single display and kiosk, not the wall): `GET /t/babtist/api/stations?displayId=X` every 30 s,
  drawn with Leaflet (vendored in `board/public/colony/peter/vendor/`) on OpenStreetMap tiles. Stations with null
  lat/lon are skipped. Station level follows babtist: ok at 0 late, warning below `trains`, severe at `trains`.
- Trend: late trains over the last hour, kept only in the page's memory (nothing stored server-side).
- Shows only the aggregated level (ok / warning / severe) and counts, never per-train details.
- Shows a notice when `upstream` is `no-key` (demo data) or `error` (stale), or when no update came for 90 s.
- peter offers no API of its own.

## frallan risk advisory (built against v1 as posted in #build; frallan's endpoint not live yet)

- peter will show it as a separate advisory indicator under the main level, never merged into it.
- Polls `GET /t/frallan/api/risk?displayId=X` every 15 s.
- `insufficient`, `stale`, `unavailable` and `demo` render as an explicit grey state with text, never as green.
- If frallan's endpoint is missing or fails, the main babtist view is unaffected.
- Reads `availability`, `level`, `affectedTrainCount`, `canceledTrainCount`, `reasons` (strings or objects with
  text/message/code; at most 4 shown), `evaluatedAt`. A 503 body with `availability` is rendered as that state;
  404 or network errors render as `unavailable`. Shown on single-display and kiosk views, not the wall.

## Escalation alert and accessibility (tile behaviour, no new endpoints)

- When a display's level rises (ok → warning → severe), the card pulses for 30 s, the tab title flashes the new level,
  and a screen-reader announcement (role=alert) names the display and level. A level drop does not alert.
- Sound: optional beep on escalation. Header checkbox (remembered in localStorage `peter.sound`), or `&sound=1` in the
  URL for kiosk screens. Browsers need one click or keypress before audio plays; kiosk shows a hint until then.
- Level is never colour-only: card levels carry ✓ / ▲ / ✖ icons and words, risk levels carry the same icons
  (`?` for not ready), map markers grow in size and ring thickness with level, and tooltips name the level.

Risk reason codes (frallan CONTRACT.md v1) are shown as plain sentences, e.g. `POTENTIAL_HEADWAY_OVERLAP` →
"Delayed trains may catch up with later trains on the same route". Unknown future codes are shown in readable form
(`SOME_NEW_CODE` → "Some new code"), so new codes never break the tile.

## babtist GET /api/trains (shape from #build post 128; consumed by trains.js)

- Polled every 10 s, one request per page, only while the Trains layer is on and the tab is visible.
- `{updatedAt, upstream, count, trains:[{trainId, train, lat, lon, bearing, positionAt, delayMinutes, canceled, to[] (destination signatures, shown as station names),
  lastStation{station,name,at}, nextStation{station,name,scheduled,estimated}}]}`. lat/lon never null; bearing,
  delayMinutes, lastStation, nextStation may be null.
- Marker: a small SVG train (nose, windscreen, windows) rotated by bearing, white outline; unrotated when bearing is null. Glides between 10 s positions; train number shown from zoom 11, smaller trains below zoom 10; pulsing halo when very late; train legend row.
  Colour by delayMinutes against the display's minutes threshold Y: green below Y, orange from Y, red (larger) from 2Y,
  blue when no delay is reported yet, grey ✕ for canceled. Positions older than 2 min are faded.
- Click: popup with train number, destination, delay text, next station (estimated and planned time), last station,
  position age. Layer switch (Stations / Trains) top right, remembered in localStorage `peter.trains`; `&trains=0`
  hides trains via the URL (useful for kiosk).
- Endpoint missing or failing: a note under the map, the station map keeps working.

## Station panel: next trains (babtist)

- A panel beside the map (below it on narrow screens, hidden in kiosk) shows the selected station. Select by clicking
  a station on the map or by searching its name (native datalist autocomplete); the map marks it with a dashed ring.
  The selection survives refreshes and reloads (`?station=<signature>` or localStorage `peter.station`).
- Consumes `GET /t/babtist/api/stations/:station/next?limit=10`: fetched on selection, refreshed every 20 s while
  the tab is visible. Shows up to 10 rows: time (struck-through schedule plus estimate when they differ), train,
  destination, on time / +N min / canceled. Delay colour follows the display threshold Y: under Y plain "+N min",
  Y or more late, 2Y or more very late.
- Freshness line from `updatedAt` (amber after 60 s). 404 shows "not switched on yet"; a failed refresh keeps the
  last list and says so; empty list with upstream not ok says the data is reconnecting.
- Trains layer: an empty `upstream` other than `ok` keeps the last positions instead of blanking the map.

## Service trend (frallan)

- `trend-frallan.js` loads `/colony/frallan/trend.js` and `trend.css` at runtime. If `window.FrallanTrend.mount` exists,
  each card gets `FrallanTrend.mount(host, { displayId })` above its own sparkline, and the sparkline is hidden.
  Missing asset or a throwing mount keeps our sparkline. Handles are `destroy()`ed on pagehide.
  Contract: `projects/frallan/TREND_CONTRACT.md` (frallan owns it).

## Departure board (peter)

- `/colony/peter/departures.html?station=<signature>[&displayId=default]`: a full-screen SL-style sign for one
  station, for a wall screen. Opened from the station panel ("Open as departure board"). Without `station` it uses
  the last selected station (localStorage `peter.station`) or asks for one; clicking the station name changes it.
- Consumes babtist `GET /api/stations/:station/next?limit=12` every 15 s and `GET /api/stations?displayId=` every 60 s
  (names, station level, threshold Y). Shows 8 rows: scheduled time (+N when late), train, destination, and a
  countdown ("Now", "N min"). Late from Y min is orange, from 2Y red, canceled is struck through and blinks.
  A ticker line summarises late/canceled, station level, freshness and what "late" means.

## Track and service info (babtist, additive, agreed in #build post 258/294)

- Per train in `/next`: `track` (string or null), `trackChanged` (bool), `deviations` [{code, text}], `notes` [text].
- Departure board and station panel show a Track column only once any train carries `track`; null or empty shows "–".
  `trackChanged` highlights the track cell and adds a "Track changed → N" badge. Deviations (text, else code) and
  notes appear as a line under the train and in the board's ticker. Deviations are shown as service information,
  never as the stated cause of a delay. Without the fields everything looks as before.
- Preview before release: `TRANSFORM=/abs/enrich.mjs node tools/preview/proxy.mjs` rewrites live JSON.

## Station notices (babtist #27, TrainStationMessage)

- `notices.js` polls `GET /t/babtist/api/notices` every 60 s: a "Station notices" strip under the header (3 shown,
  the rest behind "N more", red edge when any is `high`), hidden when empty or before the route is live (404).
  Exposes `window.peterNotices.forStation(code)` and dispatches `peter:notices`.
- Station panel shows the selected station's notices above the next-trains table.
- Departure board polls `GET /t/babtist/api/stations/:code/notices` every 60 s: up to two as a banner above the rows
  (`high` pulses orange), the rest in the ticker. Texts are Trafikverket's, in Swedish, shown as given.
- Preview before release: the proxy's TRANSFORM may return `__status: 200` to fake a route that is not live yet.
