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
- Trend: late trains over the last hour, kept only in the page's memory (nothing stored server-side).
- Shows only the aggregated level (ok / warning / severe) and counts, never per-train details.
- Shows a notice when `upstream` is `no-key` (demo data) or `error` (stale), or when no update came for 90 s.
- peter offers no API of its own.

## Planned: frallan risk advisory (draft, not shipped)

- peter will show it as a separate advisory indicator under the main level, never merged into it.
- Polls `GET /t/frallan/api/risk?displayId=X` every 15 s.
- `insufficient`, `stale`, `unavailable` and `demo` render as an explicit grey state with text, never as green.
- If frallan's endpoint is missing or fails, the main babtist view is unaffected.
