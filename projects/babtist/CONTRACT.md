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
- Only **current** trains count in `/api/status` and the SSE stream (`lateCount`, `canceledCount`, `trainsTracked`,
  `maxDelayMinutes`): trains with at least one stop now, in the next 30 min, or in the last 15 min (time = actual,
  else estimated, else scheduled). Trains that passed longer ago stay in `/api/snapshot` but no longer drive the level.
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
  **Only stops that happen now or happened in the last 15 minutes count** (time = actual, else estimated, else
  scheduled), so the colour shows the situation now, not trains that passed an hour ago. `canceledCount` uses the
  same 15-minute rule. A station whose stops are all older still appears, as `ok`.
- `canceledCount` = distinct trains with a canceled row at the station. Canceled trains are never also counted as late.
- Per-station `level` uses the display's `trains` threshold X directly (not the `2 * X` of `/api/status`):
  - `ok`: `lateCount == 0`
  - `warning`: `1 <= lateCount < trains`
  - `severe`: `lateCount >= trains`
- `name`, `lat`, `lon` (WGS84 decimal degrees) come from Trafikverket `TrainStation`, loaded once at startup and
  refreshed at most every 24 h (retry at most every 10 min after a failure). A station with unknown coordinates still
  appears, with `lat` and `lon` `null` (and `name` = signature if the name is unknown too); map UIs can skip it.
- With `upstream: "no-key"` (demo data) only `Sci` appears, with hardcoded coordinates for Stockholm City.

### `GET /t/babtist/api/stations/:station/next?limit=<n>`

The next commuter trains at one station, for a station popup ("when do the next trains come, and are they late?").
Fetch it when the user opens a station (and refresh at most every 20 s while it is open). It never triggers an upstream
call. `:station` is the station signature from `/api/stations` (URL-encoded, e.g. `S%C3%B6c` for `Söc`); `limit` is
1 to 30, default 10.

```json
{
  "station": "Sci",
  "name": "Stockholm City",
  "updatedAt": "2026-10-22T11:12:10.000Z",
  "upstream": "ok",
  "count": 1,
  "trains": [
    {
      "trainId": "2231-2026-10-22",
      "train": "2231",
      "to": [{ "station": "Söc", "name": "Södertälje centrum" }],
      "arrival": { "scheduled": "2026-10-22T11:15:00.000Z", "estimated": "2026-10-22T11:19:00.000Z" },
      "departure": { "scheduled": "2026-10-22T11:16:00.000Z", "estimated": "2026-10-22T11:20:00.000Z" },
      "expected": "2026-10-22T11:20:00.000Z",
      "delayMinutes": 4,
      "canceled": false,
      "track": "2",
      "trackChanged": true,
      "deviations": [{ "code": "ANA055", "text": "Spårändrat" }, { "code": "ANA034", "text": "Fordonsfel" }],
      "notes": ["Stannar ej vid Jordbro."]
    }
  ]
}
```

- `track` (string, agreed with peter and frallan): the platform from Trafikverket `TrackAtLocation`, departure row
  first; `null` when unknown (never a guess). `trackChanged` is `true` when a deviation says the track changed
  (code `ANA055` / "Spårändrat").
- `deviations` `[{ code, text }]` (Trafikverket `Deviation`, `code` may be `null`) and `notes` `[text]`
  (`OtherInformation`, e.g. "Stannar ej vid Jordbro.", "Tågbyte vid Tumba."): service information for this stop,
  arrival and departure merged, deduplicated, whitespace collapsed, at most 300 characters each, empty arrays when
  there is none. Plain text from Trafikverket: render it as text, never as HTML. A deviation is service
  information, not a proven cause of the delay. Same shared query as before, no extra upstream calls.
- One entry per train run that has not yet left the station: its departure (or, at a terminus, its arrival) has no
  actual time yet. Only what is in the model window (up to 30 min ahead), so the list can be shorter than `limit`.
  Entries whose `expected` is more than 5 minutes in the past are dropped (canceled stops never get an actual time).
- `arrival` / `departure` are `null` when the train has no such stop here (`departure: null` = the train terminates).
  `estimated` is `null` when Trafikverket has no estimate, which normally means the train runs to schedule.
- `expected` = departure estimated, else departure scheduled, else arrival estimated/scheduled. Sorted by `expected`.
- `delayMinutes` = the estimate at this station minus the schedule (departure first), else the train's current delay
  as in `/api/trains`, else `0`. Whole minutes, never negative. Colour it against the display's `minutes` threshold.
- `canceled` is `true` if the train's stop at this station is canceled. Canceled trains stay in the list.
- An unknown or quiet station gives `200` with an empty list (`name` falls back to the signature). A malformed
  signature gives `400`.

### `GET /t/babtist/api/trains`

Live positions of the SL commuter trains we track, joined with their delay, for a clickable train layer on a map.
One shared upstream loop polls Trafikverket `TrainPosition` every 10 s; requests never call upstream. Not per display:
colour by `delayMinutes` against the display's own `minutes` threshold on the client.

```json
{
  "updatedAt": "2026-10-22T10:55:10.000Z",
  "upstream": "ok",
  "count": 1,
  "trains": [
    {
      "trainId": "2219-2026-10-22",
      "train": "2219",
      "lat": 59.3324,
      "lon": 18.0649,
      "bearing": 169,
      "positionAt": "2026-10-22T10:55:02.000Z",
      "delayMinutes": 4,
      "canceled": false,
      "to": ["Söc"],
      "lastStation": { "station": "Sci", "name": "Stockholm City", "at": "2026-10-22T10:53:00.000Z" },
      "nextStation": { "station": "Sst", "name": "Stockholms södra", "scheduled": "2026-10-22T10:55:00.000Z", "estimated": null }
    }
  ]
}
```

- Only trains that have both a recent position and announcements in our window appear. `lat` and `lon` are never
  `null`. `bearing` (degrees, 0 = north, clockwise) can be `null`.
- A train is dropped when its `positionAt` is older than 5 minutes. Clients may grey out older positions earlier.
- `delayMinutes` uses the same rule as `/api/status` (latest actual, else largest estimate, never negative), and is
  `null` when nothing is reported yet. `canceled` is `true` if any of its announcements in the window is canceled.
- `lastStation`: the latest stop with an actual time (`null` if none). `nextStation`: the earliest stop without an
  actual time, scheduled after `lastStation` (`null` if none in the window). `name` falls back to the signature.
- `upstream` reflects the position feed: `ok`, `error` (positions may be stale) or `no-key` (empty list).
- Sorted by `train`.

### `GET /t/babtist/api/stations/:station/notices`

The notices Trafikverket shows at one station right now: on station monitors, platform signs and loudspeakers
(`TrainStationMessage`). One shared loop fetches them every 5 minutes for every station we track; requests never
call upstream.

```json
{
  "station": "Sci",
  "name": "Stockholm City",
  "updatedAt": "2026-10-22T10:40:00.000Z",
  "upstream": "ok",
  "count": 1,
  "notices": [
    {
      "id": "1500adde-1c5d-2523-08df-281d674c7cb7",
      "text": "Vissa pendeltåg mot Södertälje centrum stannar inte vid Stuvsta kl. 00:00-05:00 19-23 oktober. Se sl.se.",
      "priority": "low",
      "media": ["monitor", "platform"],
      "start": "2026-10-18T20:00:00.000Z",
      "end": "2026-10-23T03:00:00.000Z"
    }
  ]
}
```

- Only notices shown **right now**. Notices limited to certain hours (for example nights 22:00 to 05:00) and days are
  left out outside those hours, exactly as on the station's own screens. Expect an empty list for most of the day.
- One entry per text: the same text on monitor, platform sign and loudspeaker becomes one notice. `media` is any of
  `monitor`, `platform`, `announcement`. `start`/`end` are the widest span over the merged copies.
- `text` is the sign text as one line (the sign's line breaks removed), at most 500 characters. Trafikverket's text,
  in Swedish.
- `priority`: `high`, `normal` or `low` (Trafikverket's `Hog`/`Normal`/`Lag`). Sorted high to low, then newest first.
- `upstream` reflects the notice feed: `ok`, `error` (the last list is kept) or `no-key` (empty list).
- An unknown station gives `200` with an empty list. A malformed signature gives `400`.

### `GET /t/babtist/api/notices`

The same notices for all stations at once, for a ticker. The same text at several stations appears once, with
`stations: [{ "station": "Sci", "name": "Stockholm City" }, ...]` (sorted) added to each notice.
Body: `{ updatedAt, upstream, count, notices }`.

### `GET /t/babtist/api/health`

```json
{ "ok": true, "upstream": "ok", "trainsTracked": 37, "displays": 2, "streams": 1, "lastPollAt": "2026-10-22T10:05:12.000Z" }
```

## Tunnelbanan (metro)

A second, independent source: the Stockholm metro from SL's open Transport and Deviations APIs (no key). Metro lives
only under `/api/metro/...`; the commuter routes above, their fields and their meaning are unchanged, and metro
trains never show up in them (or the other way round). Thresholds are the same per-display thresholds
(`PUT /api/displays/:id`), with the same level rule.

### Metro model

- A metro **train** is one SL `journey.id` on one line. The same journey seen at several stations is one train.
- Its **delay** comes from its next stop: of all its departures (across stations) that are not `DEPARTED` and not more
  than 1 min overdue, the one with the earliest expected time. If it has none, its latest past departure.
  `delaySeconds = max(0, expected - scheduled)` in whole seconds; `delayMinutes = round(delaySeconds / 60)`, the same
  rounding as the commuter routes, so a `minutes` threshold means the same for both sources.
- A train is **canceled** when any of its departures has `state` `CANCELLED`, `INHIBITED` or `REPLACED`. Canceled trains
  count in `canceledCount`, never as late.
- Late and level: as in the delay model above (`late` = `delayMinutes >= minutes`; `ok` / `warning` / `severe` from
  `lateCount` vs `trains` and `2 * trains`).
- Freshness: each station keeps only its latest fetched departures (≤ 30 min ahead); departures more than 15 min in the
  past are dropped. A train counts while it has any kept departure.
- `upstream` for transport data: `starting` until the first station has been fetched; then `ok` while the latest SL
  call succeeded; `error` when the latest call failed or the loop is backing off. Never `no-key`.
  For `/api/metro/notices` it is the state of the latest deviations call (`starting` / `ok` / `error`).
- SL times are Stockholm local time without zone; the controller converts them, every time here is ISO UTC.

### Polling (fair use)

- One shared loop, one SL call per step, about one step per second (`BABTIST_METRO_STEP_MS`, default 1000, min 250).
  Steps go round-robin over the ~100 metro stations, so each station is refreshed about every 100 s. Client requests
  never cause SL calls.
- Station list (`/v1/stop-points` + `/v1/sites`): at start, then once per 24 h; retried at most every 10 min.
  One site per metro stop area (105 sites on 2026-10-22). Deviations: at most once a minute.
- On HTTP 429 or 5xx the loop pauses 60 s, doubling up to 10 min, and resets after a successful call.
- `BABTIST_METRO=off` turns the metro loop off (routes then answer `starting` with empty lists).

### `GET /t/babtist/api/metro/status?displayId=<id>`

Like `/api/status`, plus `mode`, `stationsCovered` (stations fetched in the last 5 min) and `stationsTotal`.

```json
{
  "displayId": "default", "mode": "metro", "level": "ok", "lateCount": 0, "canceledCount": 1, "trainsTracked": 97,
  "maxDelayMinutes": 2, "thresholds": { "trains": 3, "minutes": 5 }, "updatedAt": "2026-10-22T11:10:56.205Z",
  "upstream": "ok", "stationsCovered": 105, "stationsTotal": 105
}
```

### `GET /t/babtist/api/metro/lines?displayId=<id>`

Per metro line, sorted by line number. The seven lines 10, 11, 13, 14, 17, 18, 19 are always listed (`trains: 0` at
night). `color` is `blue`, `red`, `green` (from SL's line group), else `null`. `level` uses the display's thresholds
for that line's trains alone.

```json
{
  "displayId": "default", "updatedAt": "2026-10-22T11:10:56.205Z", "upstream": "ok",
  "thresholds": { "trains": 3, "minutes": 5 },
  "lines": [
    { "line": "10", "group": "Tunnelbanans blå linje", "color": "blue", "trains": 10, "lateCount": 0, "canceledCount": 0, "maxDelayMinutes": 0, "level": "ok" },
    { "line": "17", "group": "Tunnelbanans gröna linje", "color": "green", "trains": 13, "lateCount": 0, "canceledCount": 1, "maxDelayMinutes": 1, "level": "ok" }
  ]
}
```

### `GET /t/babtist/api/metro/stations`

The metro stations (SL sites), sorted by `siteId`. `fetchedAt` is when that station's departures were last fetched
(`null` = not yet).

```json
{
  "updatedAt": "2026-10-22T11:10:56.205Z",
  "stations": [ { "siteId": 9001, "name": "T-Centralen", "lat": 59.3313754, "lon": 18.0604334, "fetchedAt": "2026-10-22T11:10:31.002Z" } ]
}
```

### `GET /t/babtist/api/metro/stations/:siteId/next?limit=<n>`

The next metro departures at one station, sorted by expected time; departed ones and ones more than 1 min overdue
are left out. `siteId`: 1..7 digits, else `400`. `limit`: 1..30, default 10, else `400`. Unknown site: `200`, empty
list, `name` = the id as a string, `updatedAt: null`. `updatedAt` is that station's fetch time. Delay and `canceled`
are for this departure. `platform` is SL's platform designation or `null`; `deviations` are SL's texts for this
departure.

```json
{
  "siteId": 9001, "name": "T-Centralen", "updatedAt": "2026-10-22T11:10:31.002Z", "upstream": "ok", "count": 1,
  "trains": [
    { "journeyId": "2026102220437", "line": "13", "group": "Tunnelbanans röda linje", "destination": "Ropsten",
      "scheduled": "2026-10-22T11:10:30.000Z", "expected": "2026-10-22T11:10:58.000Z", "delaySeconds": 28,
      "delayMinutes": 0, "canceled": false, "state": "ATSTOP", "platform": "3", "deviations": [] }
  ]
}
```

### `GET /t/babtist/api/metro/notices`

SL's current metro disruption messages: only those active now (`start <= now < end`), one per SL case id, Swedish
text (whitespace collapsed). `priority` from SL `importance_level`: 7..9 `high`, 4..6 `normal`, 0..3 `low`. Sorted
high first, then newest first. `lines` are line designations, `stations` stop-area names; `end` may be `null`.

```json
{
  "updatedAt": "2026-10-22T11:10:12.000Z", "upstream": "ok", "count": 1,
  "notices": [
    { "id": "12990563", "header": "Avstängd hiss vid Odenplan", "text": "Odenplan: Hissen ... är avstängd.",
      "priority": "low", "lines": ["17", "18", "19"], "stations": ["Odenplan"],
      "start": "2026-10-16T10:35:15.630Z", "end": "2026-10-23T11:34:00.000Z" }
  ]
}
```

## Guarantees

- Two sources, each with exactly one shared poll loop, no matter how many displays or browsers connect: Trafikverket
  (commuter trains, `/api/...`) and SL (metro, `/api/metro/...`). They are independent: one failing never changes the
  other's routes or `upstream`.
- Right after a restart (deploy), `upstream` is `error` until the first poll answers (a few seconds), never `no-key`
  when a key is configured. Metro routes say `starting` instead until the first station is fetched. Clients should
  keep their last data while `upstream` is not `ok`.
- Only the commuter-train rows needed for the current delays, a station list (signature, name, coordinates), the
  current station notices and the latest position per tracked train are kept, in memory; for the metro only the
  station list (id, name, coordinates), each station's latest departures and the current SL messages. Only display
  thresholds are written to disk.
- Errors: `400` bad input, `404` unknown route/display, `429` too many streams/displays. Body `{ "error": "..." }`.

## Changes

Only babtist changes this file. Changes are announced in `#build` before they ship.
