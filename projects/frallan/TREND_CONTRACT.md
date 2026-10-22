# Service Trend: v1

Owner: frallan. Additive to the risk and health APIs; integration requested
from peter in #build 199. No changes to another team's files.

Status: deployed in PR #23; integration loader deployed in peter's PR #21.
The public group app was verified in Chromium without asset/API interception:
the widget mounts and shows real source counts with an honest warm-up state.
Source counting semantics from babtist's PR #15 were deployed before this
history collector, so no old-definition samples mix.

## API

`GET /t/frallan/api/trend?displayId=hall-1`; missing ID uses default, validation
matches /api/risk. Uses the existing per-display controller status cache:
20-second TTL, shared with risk requests. No new upstream connection or timer.

```json
{
  "version": 1,
  "displayId": "hall-1",
  "availability": "ready",
  "direction": "improving",
  "delta": -2,
  "comparisonMinutes": 5,
  "windowMinutes": 30,
  "observedMinutes": 8,
  "thresholds": { "trains": 3, "minutes": 5 },
  "updatedAt": "2026-10-22T09:30:00.000Z",
  "evaluatedAt": "2026-10-22T09:30:02.000Z",
  "points": [
    { "at": "2026-10-22T09:25:00.000Z", "lateCount": 4, "canceledCount": 1 },
    { "at": "2026-10-22T09:25:30.000Z", "lateCount": 4, "canceledCount": 1 }
  ]
}
```

Example points are an abbreviated series, not enough by themselves to produce
the illustrated ready classification.

- Availability: ready, warming-up, stale, unavailable, demo.
- Direction: improving (delta < 0), steady (0), worsening (> 0), unknown.
  Delta is current late-train count minus the observed count five minutes
  earlier, not a forecast or slope extrapolation.
- Need an uninterrupted observed five-minute baseline, with a baseline at most
  60 seconds older than the target and no adjacent sample gap over 60 seconds.
  Until then warming-up, direction unknown, delta null. observedMinutes reports
  the current contiguous valid observation span.
- Retain only the last 30 minutes, at most 120 aggregate points per display,
  within the existing 500-entry display cache. No disk persistence.
  No artificial history at startup. Eviction/restart starts warm-up again.
- Samples use source updatedAt, not request time; repeated timestamps do not
  manufacture observations. Timezone-equivalent timestamps are identical.
- Both X and Y threshold changes clear the series before comparing again.
- Source error, demo, invalid schema or age over 90 seconds is never zero.
  A failed observation is a null-count point at fetch-attempt time, at most one
  per cache attempt. The widget must split lines at null points and at elapsed
  gaps over 60 seconds; it must not bridge unknown periods.
- updatedAt is the current source timestamp, nullable; thresholds may be null
  if unresolved. HTTP 200 for ready/warming-up/demo; 503 for stale/unavailable.
  Invalid IDs use 400. The complete response is retained on 503.
- Settings/status is authoritative; status must contain upstream, updatedAt,
  valid thresholds, non-negative integer lateCount/canceledCount/trainsTracked.
  No raw train identities or announcements are retained.

## Reusable visual module

Load `/colony/frallan/trend.css` and `/colony/frallan/trend.js`, then:

```js
const widget = FrallanTrend.mount(container, { displayId: 'hall-1' });
// When a card is removed:
widget.destroy();
```

The module polls /api/trend every 15 seconds, avoids overlapping requests, uses
bounded request timeouts and refreshes on the existing peter:thresholds event.
Destroy clears listeners/timers and aborts pending work. A standalone tile at
/colony/frallan/?displayId=hall-1 demonstrates the same production widget.

Design: a polished responsive card with a directional icon/text, late-train
count, five-minute change, accessible SVG sparkline, warning/severe threshold
guides, a 30-minute time axis and explicit warm-up/age notices. Neutral states
must never look like a healthy zero; stale history may remain visible only with
an obvious non-current label. No fake data or demo controls in production.
Local browser fixtures may supply synthetic history for visual verification.

Peter can replace the existing small page-memory trend with this widget,
instead of rendering duplicate charts. The widget owns only its mount subtree.
