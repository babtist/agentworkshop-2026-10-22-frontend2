# frallan: ripple-effect detection

Status: **v1 implemented; deployment follows the implementation PR**.
Claim: #build post 26. Owner: frallan. Consumer: peter's presentation;
dependency: babtist's shared train model. Input confirmed in #build 34/41 and
deployed in PR #2. Presentation integration confirmed in #build 43.
The exact output vocabulary below is owned by frallan and announced before
implementation; peter's acknowledgement covers the integration behavior,
not a guarantee that the implementation has already deployed.

## Scope and boundaries

Offer an aggregated, advisory signal of possible knock-on disruption.
This is a heuristic, not a prediction of confirmed railway conflicts or causality.
Keep babtist's delay severity and per-display settings unchanged; the UI must
show ripple risk as a separate indicator.

No independent Trafikverket connection, API key, historical database, new npm
dependency, or replacement dashboard. Only babtist owns its upstream queries
and contract; only peter owns presentation changes.

## Input dependency: babtist's deployed snapshot

The published status API is insufficient: counts and maximum delay cannot
identify two trains potentially sharing a station or direction.

Read-only route: `GET /t/babtist/api/snapshot`. Source of truth:
`projects/babtist/CONTRACT.md`. Reuse its existing upstream polling; never
fetch Trafikverket per request. Field names below match the deployed endpoint.

Example response (illustrative values):

```json
{
  "generatedAt": "2026-10-22T08:10:02.000Z",
  "updatedAt": "2026-10-22T08:10:00.000Z",
  "upstream": "ok",
  "complete": true,
  "window": { "pastMinutes": 60, "futureMinutes": 30 },
  "count": 1,
  "announcements": [
    {
      "trainId": "1001-2026-10-22",
      "station": "Sci",
      "activity": "Avgang",
      "scheduled": "2026-10-22T08:12:00.000Z",
      "estimated": "2026-10-22T08:20:00.000Z",
      "actual": null,
      "canceled": false,
      "to": ["Nyc"]
    }
  ]
}
```

- `trainId` is train ident plus Swedish local service date. There is no
  announcement ID: deduplicate by trainId, station, activity and scheduled time.
  Conflicting duplicates are insufficient data, not an arbitrary winner.
- `activity` is `Ankomst` or `Avgang`, not translated arrival/departure strings.
  Timestamps are ISO 8601 with timezone. Missing estimates/actuals are null,
  never invented zero-delay observations. Actual takes precedence over estimate.
- `upstream`: `ok`, `error`, or `no-key`, matching babtist's current vocabulary.
  `updatedAt` is the last successful source update, not the request time.
- Window: 60 minutes back to 30 minutes ahead, at most 5000 rows, oldest first.
  Polling cadence: 20 seconds, with full refresh every 5 minutes.
- `complete` currently indicates source health (`upstream === "ok"`), not
  independently verified network-wide coverage. At the 5000-row cap, frallan
  must report insufficient data because truncation cannot be ruled out.
- `to` contains destination station signatures, `[]` if unknown. It is a
  grouping proxy, not an explicit direction, route, track or infrastructure ID.
  Compare only identical non-empty destination sets, never infer shared track.
- Replace our cached snapshot on refresh, rather than accumulating history.
  Enforce our own time-window expiry even if the controller retains old rows.

Observed against the deployed service: HTTP 200 with the documented fields,
`upstream: ok`, `complete: true`, and non-empty real announcements. Default
display thresholds also resolve through the real status endpoint. This verifies
the dependency shape, not the accuracy of any ripple heuristic.

## Output to peter: v1

`GET /t/frallan/api/risk?displayId=hall-1`

Omitted `displayId` uses `default`. Reuse babtist's display ID rule:
`^[A-Za-z0-9_-]{1,40}$`. Resolve existing
thresholds through its status API, including its default behavior for unknown
displays; do not create a second settings store. Agreed consumer polling:
every 15 seconds. No new SSE endpoint in the first increment.

Illustrative successful response:

```json
{
  "version": 1,
  "displayId": "hall-1",
  "availability": "ready",
  "level": "warning",
  "method": "station-destination-overlap-v1",
  "affectedTrainCount": 3,
  "canceledTrainCount": 1,
  "thresholds": { "trains": 3, "minutes": 5 },
  "reasons": ["POTENTIAL_HEADWAY_OVERLAP"],
  "sourceUpdatedAt": "2026-10-22T08:10:00.000Z",
  "evaluatedAt": "2026-10-22T08:10:02.000Z",
  "upstream": "ok"
}
```

- `availability`: `ready`, `insufficient`, `stale`, `unavailable`, `demo`.
  `level`: `ok`, `warning`, `severe`, or null. All non-ready responses have
  null level and null affected count: they must not render as green/zero risk.
- Source HTTP/schema failures or `upstream: error` mean `unavailable`;
  `no-key` means `demo`, never live evidence. For otherwise healthy inputs,
  a source age greater than 90 seconds means `stale` (source cadence is 20s).
  A missing/invalid timestamp or one more than 60s in the future is unavailable.
  Only after these checks can incomplete coverage mean `insufficient`.
- `affectedTrainCount` counts distinct follower trains, not pairs or stations.
  `canceledTrainCount` is a separate observed count, not a propagation estimate.
- `reasons` is a unique list of stable codes, not train details. Initial codes:
  `POTENTIAL_HEADWAY_OVERLAP`, `INSUFFICIENT_GROUPING_DATA`,
  `INCOMPLETE_SNAPSHOT`, `STALE_SOURCE`, `SOURCE_UNAVAILABLE`, `DEMO_SOURCE`.
- Severity: `ok` below X affected trains, `warning` from X to below
  2X, `severe` from 2X, using the display's existing X and Y thresholds.
  This is advisory overlap severity, not babtist's observed-delay severity.
- No per-train identities, station lists, credentials or raw upstream payloads
  in the display response. The example's counts are illustrative.

Non-ready example: HTTP 503

```json
{
  "version": 1,
  "displayId": "hall-1",
  "availability": "unavailable",
  "level": null,
  "method": "station-destination-overlap-v1",
  "affectedTrainCount": null,
  "canceledTrainCount": null,
  "thresholds": null,
  "reasons": ["SOURCE_UNAVAILABLE"],
  "sourceUpdatedAt": null,
  "evaluatedAt": "2026-10-22T08:10:02.000Z",
  "upstream": null,
  "error": "Train snapshot is unavailable"
}
```

HTTP 200 for ready, demo, or insufficient data; HTTP 503 for stale/unavailable
source; HTTP 400 for invalid display ID (`{"error":"Invalid displayId"}`);
HTTP 404 for unknown route. All risk-response fields shown above are present,
nullable when unresolved;
`error` is added for 503 responses. `thresholds` may remain known on a
non-ready response. Consumers must branch on availability before counts.
`ready` without detected overlap uses `reasons: []`. `insufficient` uses
`INCOMPLETE_SNAPSHOT` or `INSUFFICIENT_GROUPING_DATA`; stale/demo/unavailable
use their matching reason codes. The UI renders every non-ready state grey
with explanatory text; an absent/failed risk endpoint never blocks the main UI.

## First-increment heuristic specification

For each station/activity/exact non-empty destination-set group, sort distinct
trains by schedule.
A delayed, non-canceled leader with delay >= Y is a potential risk to a later
follower when its actual-or-estimated event time reaches or exceeds the
follower's scheduled event time. Consider only followers scheduled from now
through 30 minutes ahead; use recent leader events within snapshot coverage.
Do not count canceled followers or followers already observed at that station.
Deduplicate affected followers across groups.

Different destination sets are never compared; directions are not inferred.
An empty snapshot, `complete: false`, 5000 or more rows, conflicting duplicates,
or missing station/activity/destination/scheduled time on relevant non-canceled
rows yields `insufficient`,
not an all-clear. Relevant rows are scheduled from 10 minutes before evaluation
through 30 minutes after it. Require at least two distinct non-canceled trains
with a shared group and at least one observed/estimated leader event before
returning ready. A follower without an estimate can still be evaluated against
its scheduled event; a leader without actual/estimate is not delay evidence.
Cancellations are reported separately: they do not prove train blocking.
Parallel tracks, routing and recovery are unknown, so overlaps remain advisory.
The exact-overlap boundary is inclusive; equal scheduled times are not a
leader/follower relationship. Y compares unrounded delay minutes. Cancellations
are distinct train counts within the relevant window. No chain propagation
or inferred downstream delays in v1.

## Implementation sequence and acceptance gates

1. Input availability/schema confirmed in #build 34/41; presentation behavior
   confirmed in #build 43. Announce this exact v1 vocabulary to peter and matte.
   Do not represent those confirmations as a deployed frallan endpoint.
2. Evaluate the three FLUX candidates against supplied real data structure.
   Use the supported destination grouping, not an unavailable direction ID.
   Apply the timestamped acceptance examples below. Do not claim measured
   predictive accuracy.
3. Implement a pure analyzer in `board/plugins/frallan/risk.js`, with injected
   evaluation time. Add focused cases in `projects/frallan/test/risk.test.js`:
   overlap/no overlap, exact Y boundary, duplicate events, opposite/unknown
   destinations, canceled or completed followers, date boundaries and invalid times.
4. Implement `board/plugins/frallan/index.js` using the plugin lifecycle.
   One bounded shared snapshot refresh, never one refresh per browser; coalesce
   concurrent refreshes, enforce timeouts, catch and log background errors.
   Read only our dependency's published HTTP API, not its private module state.
   Keep only the latest required snapshot/derived groups in memory, no disk.
   Cache display thresholds briefly and invalidate at the agreed refresh cadence.
5. Add route/integration cases for invalid IDs, default/custom thresholds,
   stale/error/no-key/partial data and concurrent displays. A local fake must
   show downstream client count does not multiply source refreshes. Confirm
   settings refresh and data expiry cannot keep old risk alive indefinitely.
6. Validate with `node --test projects/frallan/test/*.test.js` from the repo
   root once tests exist. Then exercise the real babtist service, not only
   mocks, and coordinate peter's rendering of every availability state.
7. Announce finalized contract before shipping; deliver only frallan folders
   with the workshop PR script. Verify the deployed endpoint, evolve and share
   a useful spore. PR #9 published specifications and team setup only; the
   implementation is a separate delivery.

## Runtime and operation

- Plain Node.js plugin at `board/plugins/frallan/index.js`; no dependencies,
  persistence, independent upstream fetcher or frontend tile.
- Controller base defaults to `http://127.0.0.1:${PORT || 8180}/t/babtist/`.
  `FRALLAN_CONTROLLER_URL` can override this trusted server-side setting for
  a separate controller or local integration. Never use a request Host header
  or visitor-supplied URL to choose the controller.
- Snapshot reads are on demand, shared and coalesced, at most once per 20
  seconds. No requests means no refresh activity. Successes and failures are
  cached for that interval; a failed refresh clears old data rather than serving
  it as ready. Display settings use the same 20-second cache per ID; settings
  changes become visible on the next request after that cache expires.
- Retain at most one snapshot and 500 display-settings entries in memory.
  Evict settled settings entries when full; if all entries are in flight,
  return unavailable instead of allocating unbounded state.
- Controller reads time out after 5 seconds, reject redirects/non-JSON, and
  cap response bodies at 2 MiB. Failures are logged with the frallan prefix;
  response errors remain generic and never expose raw upstream payloads.
- No new GET health or SSE route is offered. Unknown routes/methods return
  control to the board's standard 404 handler.
- Run `node --test projects/frallan/test/*.test.js` from the repository root.
  Cases include the pure analyzer, real HTTP failure/concurrency behavior,
  and the actual babtist plugin behind a local fake Trafikverket server.

## Acceptance examples for implementation

Evaluation time is `2026-10-22T08:10:00Z`; X=3, Y=5. Unless noted,
rows share station Sci, activity Avgang and destination set ["Nyc"].

| Scenario | Input events | Expected |
|---|---|---|
| Overlap | A scheduled 08:12, estimated 08:20; B scheduled 08:16, no actual | B affected once; one affected train is level ok for X=3 |
| No overlap | A scheduled 08:12, estimated 08:17; B scheduled 08:18 | No affected train |
| Inclusive boundaries | A scheduled 08:12, estimated 08:17; B scheduled 08:17 | B affected: delay equals Y and event equals follower schedule |
| Separate destination | Same overlap but B destination ["Mr"] | B not affected; insufficient if no other comparable group exists |
| Observed follower | B has actual 08:16 | B is no longer an upcoming affected follower |
| Cancellation | B canceled | B not affected; cancellation counted separately |
| Duplicate | Same B row twice | One affected train, not two |
| No live evidence | Source no-key, regardless of rows | Demo, null level and affected count |
| Stale | Source updated at 08:08:29 | HTTP 503, stale, null level |
| Saturated snapshot | 5000 rows, even with complete true | Insufficient; no claimed all-clear |

Times in table cells are UTC on the evaluation date. Add multi-group cases to
exercise distinct follower counting and the X/2X severity boundaries.

## Remaining limitations, not unacknowledged module claims

| Owner | Boundary or next action |
|---|---|
| babtist | No change required for v1; destination is not physical direction and complete is source health only |
| peter | Consumer integration is built in peter PR #8; verify against the deployed endpoint after release |
| frallan | Advisory implementation is available; no validated railway prediction accuracy exists |
