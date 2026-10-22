# babtist contract: the controller

babtist owns the **controller** of the train-delay warning: one shared connection to Trafikverket, an in-memory
model of the Stockholm commuter trains, and per-display thresholds. UI teams (presentation) read from here.

Base URL (same origin as The Square): `/t/babtist/`. All answers are JSON (`application/json`) unless noted.

## Delay model

- Scope: `SL Pendeltåg` trains, `TrainAnnouncement` from Trafikverket.
- Delay of a train = last known actual (`TimeAtLocation`, else `EstimatedTimeAtLocation`) minus
  `AdvertisedTimeAtLocation`, in whole minutes (never negative).
- A train counts as **late** for a display when its delay >= that display's `minutes`.
- A train is **canceled** when any of its announcements has `Canceled: true`.
- Level for a display, with `trains` = X and `lateCount` = number of late trains:
  - `ok`: `lateCount < trains`
  - `warning`: `trains <= lateCount < 2 * trains`
  - `severe`: `lateCount >= 2 * trains`

## Endpoints

### `GET /t/babtist/api/status?displayId=<id>`

Aggregated level for one display (no per-train details). Unknown display ids get the defaults
(`trains: 3`, `minutes: 5`) and are not stored.

```json
{
  "displayId": "hall-1",
  "level": "warning",
  "lateCount": 4,
  "canceledCount": 1,
  "trainsTracked": 37,
  "maxDelayMinutes": 12,
  "thresholds": { "trains": 3, "minutes": 5 },
  "updatedAt": "2026-10-22T10:05:12.000Z",
  "upstream": "ok"
}
```

`upstream` is one of `ok`, `error` (last poll failed, data may be stale) or `no-key` (the server has no API key,
so the numbers are synthetic demo data).

### `GET /t/babtist/api/displays/:id`  /  `PUT`  /  `DELETE`

Per-display thresholds. `id` matches `^[A-Za-z0-9_-]{1,40}$`.

```
PUT /t/babtist/api/displays/hall-1
{ "trains": 3, "minutes": 5 }        trains: integer 1..100, minutes: integer 1..240
-> 200 { "id": "hall-1", "trains": 3, "minutes": 5 }
```

`GET` answers the same shape (404 if the display was never set), `DELETE` answers `{ "deleted": true }`.

### `GET /t/babtist/api/stream?displayId=<id>`

Server-Sent Events. One `status` event per update (same body as `/api/status`), sent right on connect and then
whenever upstream data or the display's thresholds change. A `: ping` comment keeps the connection alive.

```
event: status
data: {"displayId":"hall-1","level":"ok", ...}
```

### `GET /t/babtist/api/snapshot`

Read-only copy of the announcements the model retains, for analysis modules (for example ripple effects). It never
triggers an upstream call. Window: `SL Pendeltåg` rows with scheduled time from 60 min ago to 30 min ahead, at most
5000, oldest scheduled time first. Refreshed every 20 s (full refresh every 5 min).

```json
{
  "generatedAt": "2026-10-22T10:20:01.000Z",
  "updatedAt": "2026-10-22T10:19:52.000Z",
  "upstream": "ok",
  "complete": true,
  "window": { "pastMinutes": 60, "futureMinutes": 30 },
  "count": 1,
  "announcements": [
    {
      "trainId": "2043-2026-10-22",
      "station": "Sci",
      "activity": "Ankomst",
      "scheduled": "2026-10-22T08:15:00.000Z",
      "estimated": null,
      "actual": "2026-10-22T08:21:00.000Z",
      "canceled": false,
      "to": ["Söc"]
    }
  ]
}
```

- `trainId` = Trafikverket train ident + `-` + service date (Swedish local date), stable across polls.
- `station`: station signature. `activity`: `Ankomst` or `Avgang`. `to`: destination signatures (direction), `[]` if unknown.
- `estimated` / `actual` are `null` until Trafikverket reports them.
- `complete` is `true` only when `upstream` is `ok`. With `no-key` the data is synthetic demo data (always station `Sci`, no destination).
- Routes are not included: the controller does not store a train's full timetable, only the announcements above.

### `GET /t/babtist/api/stations?displayId=<id>`

Per-station delay counts for one display, with coordinates, for map markers (agreed with team peter, polled every
30 s). It never triggers an upstream call. `displayId` as in `/api/status` (default `default`, unknown ids get the
default thresholds, a bad id gets `400`).

```json
{
  "displayId": "hall-1",
  "updatedAt": "2026-10-22T10:05:12.000Z",
  "upstream": "ok",
  "thresholds": { "trains": 3, "minutes": 5 },
  "stations": [
    { "station": "Sci", "name": "Stockholm City", "lat": 59.3324, "lon": 18.0649, "lateCount": 2, "canceledCount": 0, "level": "warning" }
  ]
}
```

- `updatedAt` and `upstream` mean the same as in `/api/status`.
- One entry per station signature with at least one retained announcement in the model window (60 min back,
  30 min ahead), sorted by `station`.
- **Delay at a station** = actual (`TimeAtLocation`, else `EstimatedTimeAtLocation`) minus scheduled time for that
  station's rows, in whole minutes, never negative. If a train has both an arrival and a departure row at the station,
  the larger delay counts. A train with neither actual nor estimate at the station has no delay there.
- `lateCount` = distinct trains (by `trainId`) whose delay at that station is >= the display's `minutes`.
- `canceledCount` = distinct trains with a canceled row at the station. Canceled trains are never also counted as late.
- Per-station `level` uses the display's `trains` threshold X directly (not the `2 * X` of `/api/status`):
  - `ok`: `lateCount == 0`
  - `warning`: `1 <= lateCount < trains`
  - `severe`: `lateCount >= trains`
- `name`, `lat`, `lon` (WGS84 decimal degrees) come from Trafikverket `TrainStation`, loaded once at startup and
  refreshed at most every 24 h (retry at most every 10 min after a failure). A station with unknown coordinates still
  appears, with `lat` and `lon` `null` (and `name` = signature if the name is unknown too); map UIs can skip it.
- With `upstream: "no-key"` (demo data) only `Sci` appears, with hardcoded coordinates for Stockholm City.

### `GET /t/babtist/api/health`

```json
{ "ok": true, "upstream": "ok", "trainsTracked": 37, "displays": 2, "streams": 1, "lastPollAt": "2026-10-22T10:05:12.000Z" }
```

## Guarantees

- Exactly one upstream poll loop, no matter how many displays or browsers connect.
- Only the commuter-train rows needed for the current delays, and a station list (signature, name, coordinates),
  are kept, in memory. Only display thresholds are
  written to disk.
- Errors: `400` bad input, `404` unknown route/display, `429` too many streams/displays. Body `{ "error": "..." }`.

## Changes

Only babtist changes this file. Changes are announced in `#build` before they ship.
