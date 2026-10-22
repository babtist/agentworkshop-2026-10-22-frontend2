# Matte acceptance checks

Run the live checks from this folder with:

```sh
python3 -m unittest discover -s test -v
```

Set `MATTE_BASE_URL` to test another compatible deployment. The live suite reads status and UI assets, creates one
uniquely named disposable display to check threshold persistence and its SSE update event, then deletes it in a
`finally` cleanup. It does not contact Trafikverket directly.

## Browser checks

1. Open `/colony/peter/?displayId=hall-1`, save thresholds, reload, and verify the configured thresholds and
   aggregate level remain associated with `hall-1`.
2. Open `/colony/peter/?displays=hall-1,hall-2&kiosk=1`. Verify both cards render, kiosk controls are hidden,
   updates continue, and the wall does not create an SSE connection per card.
3. With browser DevTools Local Overrides, serve a status response with `upstream: "no-key"` and confirm the
   explicit demo notice. Repeat with `upstream: "error"` and an old `updatedAt`; confirm the stale/upstream warning
   is visible and the level is not presented as current. Blocking the controller requests should show the explicit
   “No data” state rather than a green level.
4. Confirm that only aggregate counts and levels appear; no train identifiers, station-level details, or timetable
   rows appear in the presentation.
5. On a single-display map, verify stations have usable coordinates, null-coordinate entries are skipped, polling
   reflects the display thresholds, and station API errors or upstream errors remain visible rather than looking
   current.
6. After the train-position endpoint is deployed, enable the Trains layer and verify position age, null bearing,
   unknown delay, canceled state, and missing next/last station information do not break station markers.
7. After the ripple-risk endpoint is deployed, verify ready, insufficient, stale, unavailable, and demo states;
   non-ready states must be visibly neutral and must not alter the main delay level.
8. After Babtist's station-next endpoint and Peter's popup are deployed, click a station marker. Verify the popup
   fetches its next-train list on open, shows up to eight trains with time, train, destination, and on-time/delay/
   canceled state, refreshes no more often than every 20 seconds while open, and stops refreshing when closed.
   Confirm an empty list and a 404 each show the documented neutral fallback without breaking the station summary.
9. After Frallan's health route is deployed, check its cached readiness fields and confirm source age is distinct
   from cache age. Health should report idle before risk has warmed the cache, and a health-only visit must not
   initiate a controller or Trafikverket fetch.

If the live API assertions fail, report the failing endpoint, expected value, observed response, and upstream
freshness to the owning team in `#build`. Do not alter their files.
