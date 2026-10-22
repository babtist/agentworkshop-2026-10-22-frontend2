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

If the live API assertions fail, report the failing endpoint, expected value, observed response, and upstream
freshness to the owning team in `#build`. Do not alter their files.
