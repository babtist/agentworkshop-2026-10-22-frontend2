'use strict';
// Tunnelbanan (metro) from SL: parsing, the journey model, pacing/backoff and the /api/metro/... routes.
// Run: node --test projects/babtist/test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {
  createMetro, parseDepartures, parseDeviations, activeDeviations, metroSites, stockholmToMs, toStockholmLocal, lineColor,
} = require('../../../board/plugins/babtist/metro.js');

const M = 60000;
const T0 = Date.parse('2026-10-22T11:00:00Z'); // 13:00 in Stockholm (CEST)
const local = ms => toStockholmLocal(ms);

function dep({ journey, line = '14', group = 'Tunnelbanans röda linje', sched, delayS = 0, state = 'EXPECTED', dest = 'Mörby centrum', platform = '2', devs = [], mode = 'METRO', area = 1051 }) {
  return {
    destination: dest, direction_code: 1, direction: dest, state, display: 'x',
    scheduled: local(sched), expected: local(sched + delayS * 1000),
    journey: { id: journey, state: 'NORMALPROGRESS' },
    stop_area: { id: area, name: 'T-Centralen', type: 'METROSTN' },
    stop_point: { id: 2052, name: 'T-Centralen', designation: platform },
    line: { id: Number(line), designation: line, transport_mode: mode, group_of_lines: group },
    deviations: devs,
  };
}

const ok = body => ({ ok: true, status: 200, json: async () => body });
const fail = status => ({ ok: false, status, json: async () => ({}) });

const STOP_POINTS = [
  { id: 1, stop_area: { id: 1051, name: 'T-Centralen', type: 'METROSTN' } },
  { id: 2, stop_area: { id: 1011, name: 'Slussen', type: 'METROSTN' } },
  { id: 3, stop_area: { id: 1141, name: 'S:t Eriksplan', type: 'METROSTN' } },
  { id: 4, stop_area: { id: 5011, name: 'T-Centralen', type: 'BUSTERM' } },
];
const SITES = [
  { id: 9001, name: 'T-Centralen', lat: 59.33, lon: 18.06, stop_areas: [1051, 5011] },
  { id: 9002, name: 'Centralen buss', lat: 59.33, lon: 18.05, stop_areas: [1051] },
  { id: 9192, name: 'Slussen', lat: 59.32, lon: 18.07, stop_areas: [1011] },
  { id: 9116, name: 'Sankt Eriksplan', lat: 59.34, lon: 18.04, stop_areas: [1141] },
  { id: 9500, name: 'Bussplats', lat: 59.3, lon: 18.0, stop_areas: [5011] },
];

// A fake fetch with a controllable clock: routes by URL, records calls.
function fakeSl(handlers, clock) {
  const calls = [];
  const fetch = async url => {
    calls.push({ url: String(url), at: clock ? clock.t : Date.now() });
    const u = new URL(url);
    if (u.pathname === '/v1/stop-points') return handlers.stopPoints ? handlers.stopPoints() : ok(STOP_POINTS);
    if (u.pathname === '/v1/sites') return handlers.sites ? handlers.sites() : ok(SITES);
    if (u.pathname === '/v1/messages') return handlers.messages ? handlers.messages() : ok([]);
    const m = /^\/v1\/sites\/(\d+)\/departures$/.exec(u.pathname);
    if (m) return handlers.departures(Number(m[1]));
    return fail(404);
  };
  return { fetch, calls };
}

async function runSteps(metro, n) { for (let i = 0; i < n; i++) { try { await metro.step(); } catch {} } }

test('stockholmToMs: local SL time to UTC, summer, winter and both DST edges', () => {
  assert.strictEqual(new Date(stockholmToMs('2026-07-01T12:00:00')).toISOString(), '2026-07-01T10:00:00.000Z');
  assert.strictEqual(new Date(stockholmToMs('2026-01-15T12:00:00')).toISOString(), '2026-01-15T11:00:00.000Z');
  assert.strictEqual(new Date(stockholmToMs('2026-10-22T12:57:30')).toISOString(), '2026-10-22T10:57:30.000Z');
  // Autumn: 02:30 happens twice; the first (summer time) wins. 03:30 is unambiguous winter time.
  assert.strictEqual(new Date(stockholmToMs('2026-10-25T02:30:00')).toISOString(), '2026-10-25T00:30:00.000Z');
  assert.strictEqual(new Date(stockholmToMs('2026-10-25T03:30:00')).toISOString(), '2026-10-25T02:30:00.000Z');
  // Spring: 02:30 does not exist; read as winter time.
  assert.strictEqual(new Date(stockholmToMs('2026-03-29T02:30:00')).toISOString(), '2026-03-29T01:30:00.000Z');
  assert.strictEqual(new Date(stockholmToMs('2026-03-29T03:30:00')).toISOString(), '2026-03-29T01:30:00.000Z');
  assert.strictEqual(new Date(stockholmToMs('2026-09-07T13:42:01.63+02:00')).toISOString(), '2026-09-07T11:42:01.630Z');
  assert.strictEqual(stockholmToMs('nope'), null);
  assert.strictEqual(stockholmToMs(null), null);
  assert.strictEqual(local(T0), '2026-10-22T13:00:00');
});

test('parseDepartures: canceled states, platform, deviation texts, non-metro dropped', () => {
  const out = parseDepartures({ departures: [
    dep({ journey: 1, sched: T0, delayS: 90, devs: [{ importance_level: 5, message: '  Kort  tåg ' }, { message: 'Kort tåg' }] }),
    dep({ journey: 2, sched: T0, state: 'CANCELLED', platform: '' }),
    dep({ journey: 3, sched: T0, state: 'INHIBITED' }),
    dep({ journey: 4, sched: T0, state: 'REPLACED' }),
    dep({ journey: 5, sched: T0, mode: 'BUS' }),
  ], stop_deviations: [] });
  assert.strictEqual(out.length, 4);
  assert.deepStrictEqual(out[0], {
    journeyId: '1', line: '14', group: 'Tunnelbanans röda linje', destination: 'Mörby centrum',
    scheduled: T0, expected: T0 + 90000, state: 'EXPECTED', canceled: false, platform: '2', deviations: ['Kort tåg'],
  });
  assert.deepStrictEqual(out.slice(1).map(d => d.canceled), [true, true, true]);
  assert.strictEqual(out[1].platform, null);
  assert.throws(() => parseDepartures({}), /shape/);
});

test('metroSites: one site per METROSTN area, by name, else the only site holding it', () => {
  const sites = metroSites(STOP_POINTS, SITES);
  assert.deepStrictEqual(sites.map(s => [s.siteId, s.name]), [[9001, 'T-Centralen'], [9116, 'Sankt Eriksplan'], [9192, 'Slussen']]);
  assert.deepStrictEqual(sites[0], { siteId: 9001, name: 'T-Centralen', lat: 59.33, lon: 18.06 });
  assert.strictEqual(lineColor('tunnelbanans blå linje'), 'blue');
  assert.strictEqual(lineColor('Tunnelbanans gröna linje'), 'green');
  assert.strictEqual(lineColor('x'), null);
});

test('model: same journey merged across stations, delay from its next stop, canceled wins', async () => {
  const clock = { t: T0 };
  const deps = {
    9001: [
      dep({ journey: 100, sched: T0 - 2 * M, delayS: 400, state: 'DEPARTED' }), // past stop: ignored for delay
      dep({ journey: 100, sched: T0 + 3 * M, delayS: 130 }),                   // next stop
      dep({ journey: 200, sched: T0 + 5 * M, delayS: 10, line: '10', group: 'Tunnelbanans blå linje' }),
      dep({ journey: 300, sched: T0 + 1 * M, delayS: 600, line: '17', group: 'Tunnelbanans gröna linje' }),
    ],
    9192: [
      dep({ journey: 100, sched: T0 + 6 * M, delayS: 200 }), // later stop of the same journey
      dep({ journey: 200, sched: T0 + 8 * M, state: 'CANCELLED', line: '10', group: 'Tunnelbanans blå linje' }),
      dep({ journey: 400, sched: T0 - 30 * M }),             // more than 15 min past: dropped
    ],
  };
  const sl = fakeSl({ departures: id => ok({ departures: deps[id] || [] }) }, clock);
  const metro = createMetro({ fetch: sl.fetch, now: () => clock.t, transportUrl: 'http://sl', deviationsUrl: 'http://dev' });
  assert.strictEqual(metro.upstream(), 'starting');
  await runSteps(metro, 5); // lists, deviations, 9001, 9116, 9192
  assert.strictEqual(metro.upstream(), 'ok');
  const trains = metro.trains().sort((a, b) => a.journeyId.localeCompare(b.journeyId));
  assert.deepStrictEqual(trains.map(t => [t.journeyId, t.line, t.delaySeconds, t.delayMinutes, t.canceled]), [
    ['100', '14', 130, 2, false],
    ['200', '10', 10, 0, true],
    ['300', '17', 600, 10, false],
  ]);

  const th = { trains: 1, minutes: 2 };
  const s = metro.statusBody('d', th);
  assert.deepStrictEqual(s, {
    displayId: 'd', mode: 'metro', level: 'severe', lateCount: 2, canceledCount: 1, trainsTracked: 3, maxDelayMinutes: 10,
    thresholds: th, updatedAt: new Date(T0).toISOString(), upstream: 'ok', stationsCovered: 3, stationsTotal: 3,
  });
  assert.strictEqual(metro.statusBody('d', { trains: 3, minutes: 5 }).level, 'ok');
  assert.strictEqual(metro.statusBody('d', { trains: 1, minutes: 5 }).level, 'warning');

  const lines = metro.linesBody('d', { trains: 1, minutes: 5 }).lines;
  assert.deepStrictEqual(lines.map(l => l.line), ['10', '11', '13', '14', '17', '18', '19']);
  const l17 = lines.find(l => l.line === '17'), l10 = lines.find(l => l.line === '10'), l14 = lines.find(l => l.line === '14');
  assert.deepStrictEqual(l17, { line: '17', group: 'Tunnelbanans gröna linje', color: 'green', trains: 1, lateCount: 1, canceledCount: 0, maxDelayMinutes: 10, level: 'warning' });
  assert.deepStrictEqual([l10.trains, l10.canceledCount, l10.level, l10.color], [1, 1, 'ok', 'blue']);
  assert.deepStrictEqual([l14.trains, l14.lateCount, l14.level, l14.color], [1, 0, 'ok', 'red']);

  // Freshness: after 5 min without fetches a station no longer counts as covered.
  clock.t = T0 + 6 * M;
  assert.strictEqual(metro.statusBody('d', th).stationsCovered, 0);
});

test('backoff: 429/5xx pause the loop, doubling up to the max, reset on success', async () => {
  const clock = { t: T0 };
  let mode = 429;
  const sl = fakeSl({ departures: () => (mode ? fail(mode) : ok({ departures: [] })) }, clock);
  const metro = createMetro({ fetch: sl.fetch, now: () => clock.t, transportUrl: 'http://sl', deviationsUrl: 'http://dev', backoffBaseMs: 1000, backoffMaxMs: 3000 });
  await runSteps(metro, 2); // lists + deviations
  await assert.rejects(metro.step(), /429/);
  assert.strictEqual(metro.state.backoffMs, 1000);
  assert.strictEqual(metro.upstream(), 'error');
  const n = sl.calls.length;
  assert.strictEqual(await metro.step(), 'paused');
  assert.strictEqual(sl.calls.length, n, 'no call while paused');
  clock.t += 1000; mode = 503;
  await assert.rejects(metro.step(), /503/);
  assert.strictEqual(metro.state.backoffMs, 2000);
  clock.t += 2000;
  await assert.rejects(metro.step(), /503/);
  assert.strictEqual(metro.state.backoffMs, 3000, 'capped');
  clock.t += 3000; mode = 0;
  assert.strictEqual(await metro.step(), 'site');
  assert.strictEqual(metro.state.backoffMs, 0);
  assert.strictEqual(metro.upstream(), 'ok');
  // A 404 is an error, but no pause.
  mode = 404;
  await assert.rejects(metro.step(), /404/);
  assert.strictEqual(metro.state.backoffMs, 0);
  assert.strictEqual(metro.upstream(), 'error');
});

test('pacing: the loop makes one call per step, never a burst', async () => {
  const sl = fakeSl({ departures: () => ok({ departures: [] }) });
  const metro = createMetro({ fetch: sl.fetch, transportUrl: 'http://sl', deviationsUrl: 'http://dev', stepMs: 60 });
  metro.start(0);
  await new Promise(r => setTimeout(r, 700));
  metro.stop();
  const steps = sl.calls.filter(c => !c.url.includes('/v1/sites?')); // lists = stop-points + sites in one step
  assert.ok(steps.length >= 5 && steps.length <= 13, `calls: ${steps.length}`);
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i].at - steps[i - 1].at >= 55, `gap ${steps[i].at - steps[i - 1].at}`);
  const sites = sl.calls.filter(c => c.url.includes('/departures')).map(c => /sites\/(\d+)/.exec(c.url)[1]);
  assert.deepStrictEqual(sites.slice(0, 4), ['9001', '9116', '9192', '9001'], 'round-robin');
});

test('station lists: retry at most every 10 min on failure, deviations at most once a minute', async () => {
  const clock = { t: T0 };
  let listsOk = false;
  const sl = fakeSl({ stopPoints: () => (listsOk ? ok(STOP_POINTS) : fail(404)), departures: () => ok({ departures: [] }) }, clock);
  const metro = createMetro({ fetch: sl.fetch, now: () => clock.t, transportUrl: 'http://sl', deviationsUrl: 'http://dev' });
  await assert.rejects(metro.step(), /404/);
  assert.strictEqual(await metro.step(), 'deviations');
  assert.strictEqual(await metro.step(), 'idle');
  clock.t += 61000;
  assert.strictEqual(await metro.step(), 'deviations');
  listsOk = true;
  clock.t = T0 + 10 * M;
  assert.strictEqual(await metro.step(), 'lists');
  assert.strictEqual(metro.state.sites.length, 3);
  assert.strictEqual(await metro.step(), 'deviations');
  assert.strictEqual(await metro.step(), 'site');
});

const NOW = Date.now();
const isoZ = ms => new Date(ms).toISOString();
const msg = (id, header, extra = {}) => ({
  version: 1, deviation_case_id: id,
  publish: { from: isoZ(NOW - 3600000), upto: isoZ(NOW + 3600000) },
  priority: { importance_level: 2, influence_level: 3, urgency_level: 1 },
  message_variants: [{ header, details: `${header}:\n\n detaljer. `, language: 'sv' }, { header: 'EN ' + header, details: 'en', language: 'en' }],
  scope: {
    stop_areas: [{ id: 2101, name: 'Östermalmstorg', type: 'METROSTN' }],
    lines: [{ id: 14, designation: '14', transport_mode: 'METRO' }, { id: 13, designation: '13', transport_mode: 'METRO' }],
  },
  ...extra,
});

test('notices: active only, deduped, Swedish text, priority from importance_level', () => {
  const list = parseDeviations([
    msg(1, 'Hiss'),
    msg(1, 'Hiss'),
    msg(2, 'Framtida', { publish: { from: isoZ(NOW + 3600000), upto: isoZ(NOW + 7200000) } }),
    msg(3, 'Slut', { publish: { from: isoZ(NOW - 7200000), upto: isoZ(NOW - 1) } }),
    msg(4, 'Viktig', { priority: { importance_level: 8 } }),
    msg(5, 'Mellan', { priority: { importance_level: 5 }, publish: { from: isoZ(NOW - 1000) } }),
  ]);
  const active = activeDeviations(list, NOW);
  assert.deepStrictEqual(active.map(n => [n.id, n.priority]), [['4', 'high'], ['5', 'normal'], ['1', 'low']]);
  assert.deepStrictEqual(active[2], {
    id: '1', header: 'Hiss', text: 'Hiss: detaljer.', priority: 'low', lines: ['13', '14'], stations: ['Östermalmstorg'],
    start: isoZ(NOW - 3600000), end: isoZ(NOW + 3600000),
  });
  assert.strictEqual(active[1].end, null);
  assert.throws(() => parseDeviations({}), /shape/);
});

// ---- HTTP routes through the plugin, with a fake SL server on 127.0.0.1 ----

const httpDeps = () => {
  const t = Date.now();
  return {
    9001: [dep({ journey: 1, sched: t + 2 * M, delayS: 400 }), dep({ journey: 2, sched: t + 4 * M, line: '10', group: 'Tunnelbanans blå linje', dest: 'Kungsträdgården', platform: '5' }),
      dep({ journey: 3, sched: t - 5 * M, state: 'DEPARTED' })],
    9192: [dep({ journey: 1, sched: t + 5 * M, delayS: 380 })],
  };
};
let slCalls = 0;
const sl = http.createServer((req, res) => {
  slCalls++;
  const u = new URL(req.url, 'http://x');
  const send = b => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (u.pathname === '/v1/stop-points') return send(STOP_POINTS);
  if (u.pathname === '/v1/sites') return send(SITES);
  if (u.pathname === '/v1/messages') return send([msg(7, 'Avstängd hiss')]);
  const m = /^\/v1\/sites\/(\d+)\/departures$/.exec(u.pathname);
  if (m) return send({ departures: httpDeps()[m[1]] || [], stop_deviations: [] });
  res.writeHead(404); res.end('{}');
});
const tv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ RESPONSE: { RESULT: [{ TrainAnnouncement: [] }] } })); });

const dataDir = path.join(__dirname, '.data-metro-test');
let server, base, plugin;

test.before(async () => {
  await new Promise(r => sl.listen(0, '127.0.0.1', r));
  await new Promise(r => tv.listen(0, '127.0.0.1', r));
  process.env.TRAFIKVERKET_URL = `http://127.0.0.1:${tv.address().port}/v2/data.json`;
  process.env.TRAFIKVERKET_API_KEY = 'test-key-not-real';
  process.env.BABTIST_POSITION_POLL_MS = '600000';
  process.env.BABTIST_POLL_MS = '600000';
  process.env.SL_TRANSPORT_URL = `http://127.0.0.1:${sl.address().port}`;
  process.env.SL_DEVIATIONS_URL = `http://127.0.0.1:${sl.address().port}/`;
  process.env.BABTIST_METRO_STEP_MS = '100'; // clamped to 250
  delete process.env.BABTIST_METRO;
  plugin = require('../../../board/plugins/babtist/index.js');
  fs.mkdirSync(dataDir, { recursive: true });
  plugin.init({ dataDir });
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    plugin.handle(req, res, { path: url.pathname.replace('/t/babtist', ''), url }).then(h => { if (!h) { res.writeHead(404); res.end('{}'); } });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/t/babtist`;
});

test.after(() => {
  plugin._metro.stop();
  server.closeAllConnections(); server.close(); sl.close(); tv.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const get = async p => { const r = await fetch(base + p); return { code: r.status, body: await r.json() }; };

test('GET /api/metro/*: shapes, per-display thresholds, 400s', async () => {
  assert.strictEqual(plugin._metro.stepMs, 250, 'step is clamped to 250 ms');
  const first = (await get('/api/metro/status')).body;
  assert.strictEqual(first.upstream, 'starting');
  // lists, deviations, 3 stations: 5 steps of 250 ms.
  for (let i = 0; i < 40; i++) {
    if ((await get('/api/metro/status')).body.stationsCovered === 3) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const callsBefore = slCalls;

  const put = await fetch(base + '/api/displays/m1', { method: 'PUT', body: JSON.stringify({ trains: 1, minutes: 6 }) });
  assert.strictEqual(put.status, 200);
  const s = await get('/api/metro/status?displayId=m1');
  assert.strictEqual(s.code, 200);
  assert.deepStrictEqual(Object.keys(s.body), ['displayId', 'mode', 'level', 'lateCount', 'canceledCount', 'trainsTracked', 'maxDelayMinutes', 'thresholds', 'updatedAt', 'upstream', 'stationsCovered', 'stationsTotal']);
  assert.deepStrictEqual([s.body.mode, s.body.upstream, s.body.trainsTracked, s.body.lateCount, s.body.maxDelayMinutes, s.body.level, s.body.stationsTotal],
    ['metro', 'ok', 3, 1, 7, 'warning', 3], 'departed journey 3 still tracked (seen < 15 min ago)');
  assert.deepStrictEqual(s.body.thresholds, { trains: 1, minutes: 6 });
  assert.strictEqual((await get('/api/metro/status')).body.level, 'ok', 'default thresholds 3/5');

  const l = await get('/api/metro/lines?displayId=m1');
  assert.deepStrictEqual(Object.keys(l.body), ['displayId', 'updatedAt', 'upstream', 'thresholds', 'lines']);
  const l14 = l.body.lines.find(x => x.line === '14');
  assert.deepStrictEqual(l14, { line: '14', group: 'Tunnelbanans röda linje', color: 'red', trains: 2, lateCount: 1, canceledCount: 0, maxDelayMinutes: 7, level: 'warning' });

  const st = await get('/api/metro/stations');
  assert.deepStrictEqual(Object.keys(st.body), ['updatedAt', 'stations']);
  assert.deepStrictEqual(st.body.stations.map(x => x.siteId), [9001, 9116, 9192]);
  assert.deepStrictEqual(Object.keys(st.body.stations[0]), ['siteId', 'name', 'lat', 'lon', 'fetchedAt']);

  const n = await get('/api/metro/stations/9001/next?limit=5');
  assert.deepStrictEqual(Object.keys(n.body), ['siteId', 'name', 'updatedAt', 'upstream', 'count', 'trains']);
  assert.deepStrictEqual([n.body.siteId, n.body.name, n.body.count], [9001, 'T-Centralen', 2], 'departed train left out');
  assert.deepStrictEqual(Object.keys(n.body.trains[0]), ['journeyId', 'line', 'group', 'destination', 'scheduled', 'expected', 'delaySeconds', 'delayMinutes', 'canceled', 'state', 'platform', 'deviations']);
  assert.deepStrictEqual(n.body.trains.map(t => [t.journeyId, t.line, t.delaySeconds, t.delayMinutes, t.platform]), [['2', '10', 0, 0, '5'], ['1', '14', 400, 7, '2']], 'sorted by expected time');
  assert.match(n.body.trains[1].expected, /Z$/);
  assert.strictEqual((await get('/api/metro/stations/9001/next?limit=1')).body.count, 1);
  const unknown = await get('/api/metro/stations/1234567/next');
  assert.deepStrictEqual([unknown.code, unknown.body.name, unknown.body.count, unknown.body.updatedAt], [200, '1234567', 0, null]);

  const no = await get('/api/metro/notices');
  assert.deepStrictEqual(Object.keys(no.body), ['updatedAt', 'upstream', 'count', 'notices']);
  assert.deepStrictEqual([no.body.upstream, no.body.count, no.body.notices[0].header], ['ok', 1, 'Avstängd hiss']);

  for (const bad of ['/api/metro/stations/abc/next', '/api/metro/stations/12345678/next', '/api/metro/stations/9001/next?limit=0',
    '/api/metro/stations/9001/next?limit=31', '/api/metro/stations/9001/next?limit=x', '/api/metro/status?displayId=bad!', '/api/metro/lines?displayId=bad!']) {
    const r = await get(bad);
    assert.strictEqual(r.code, 400, bad);
    assert.ok(r.body.error, bad);
  }
  assert.strictEqual((await fetch(base + '/api/metro/nope')).status, 404);
  assert.ok(slCalls - callsBefore <= 2, 'client requests never cause SL calls');
});
