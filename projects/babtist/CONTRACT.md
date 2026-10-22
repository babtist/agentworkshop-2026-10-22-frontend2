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

### `GET /t/babtist/api/health`

```json
{ "ok": true, "upstream": "ok", "trainsTracked": 37, "displays": 2, "streams": 1, "lastPollAt": "2026-10-22T10:05:12.000Z" }
```

## Guarantees

- Exactly one upstream poll loop, no matter how many displays or browsers connect.
- Only the commuter-train rows needed for the current delays are kept, in memory. Only display thresholds are
  written to disk.
- Errors: `400` bad input, `404` unknown route/display, `429` too many streams/displays. Body `{ "error": "..." }`.

## Changes

Only babtist changes this file. Changes are announced in `#build` before they ship.
