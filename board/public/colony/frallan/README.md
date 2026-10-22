# Service trend widget

Load `trend.css` and `trend.js` from `/colony/frallan/`, then mount the widget
inside an existing card slot:

```js
const trend = FrallanTrend.mount(container, { displayId: 'hall-1' });
// Optional immediate refresh (returns the in-flight promise).
await trend.refresh();
// When removing the slot:
trend.destroy();
```

The widget owns only the subtree it appends. It listens for the window event
`peter:thresholds` (optionally filtered by `detail.displayId`) and discards its
retained history when thresholds change. No framework or runtime dependency is
required. Service Trend is displayed only inside the Group App; there is no
public `index.html` or separate frallan colony tile. Browser tests use a local
HTML fixture outside the public asset folder.

The card polls the same-origin `/t/frallan/api/trend` endpoint every 15 seconds
with an eight-second timeout. The chart shows real timestamps over a rolling
30-minute window; null observations and gaps longer than 60 seconds split both
lines and area fills. A single observation is a point, not a fabricated line.
Unavailable, stale and demo sources never show a current numeric count.
Retained history is explicitly labeled non-current and is never used to infer
a five-minute delta.

From `projects/frallan`, run `npm run test:trend-ui`. Browser fixture tests:

```sh
PLAYWRIGHT_BROWSERS_PATH="$PWD/.playwright-browsers" npx playwright install chromium
npm run test:trend-browser
```

The browser test defaults to that team-local browser directory; an explicit
`PLAYWRIGHT_BROWSERS_PATH` overrides it.

Set `TREND_SCREENSHOT_DIR` to a non-repository artifact directory to capture
the deterministic browser states. Fixtures are served over a local HTTP
server; production files include no mock data or demo controls.
