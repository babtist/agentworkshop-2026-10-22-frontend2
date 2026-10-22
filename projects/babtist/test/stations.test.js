'use strict';
// GET /api/stations: per-station counts, coordinates from TrainStation, per-display thresholds.
// Run: node --test projects/babtist/test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const T0 = Math.floor(Date.now() / 60000) * 60000;
const minutesAgo = m => new Date(T0 - m * 60000).toISOString();
const row = (id, loc, activity, advMin, delayMin, extra = {}) => ({
  AdvertisedTrainIdent: id, LocationSignature: loc, ActivityType: activity,
  AdvertisedTimeAtLocation: minutesAgo(advMin), TimeAtLocation: minutesAgo(advMin - delayMin), ...extra,
});

const ANNOUNCEMENTS = [
  row('1', 'Sci', 'Ankomst', 20, 7),
  row('1', 'Sci', 'Avgang', 19, 9), // larger delay at the same station wins: 9
  row('2', 'Sci', 'Ankomst', 15, 3),
  row('3', 'Sci', 'Ankomst', 12, 20, { Canceled: true }), // canceled, not late
  row('4', 'Sci', 'Ankomst', 5, 0, { TimeAtLocation: undefined, EstimatedTimeAtLocation: minutesAgo(5 - 6) }), // estimate: 6
  row('1', 'Cst', 'Ankomst', 25, 2), // same train, only 2 min late here
  row('5', 'Cst', 'Ankomst', 10, 10),
  row('6', 'Xyz', 'Ankomst', 8, 0), // not in the station list
  row('7', 'Flb', 'Ankomst', 8, 1), // in the list, but with unparseable coordinates
];
const STATIONS = [
  { LocationSignature: 'Sci', AdvertisedLocationName: 'Stockholm City', Geometry: { WGS84: 'POINT (18.0592 59.3307)' } },
  { LocationSignature: 'Cst', AdvertisedLocationName: 'Stockholm C', Geometry: { WGS84: 'POINT (18.0575 59.3313)' } },
  { LocationSignature: 'Flb', AdvertisedLocationName: 'Flemingsberg', Geometry: { WGS84: 'garbage' } },
  { LocationSignature: 'Far', AdvertisedLocationName: 'Far away', Geometry: { WGS84: 'POINT (11 57)' } },
];

let announcementCalls = 0, stationCalls = 0, stationQuery = '';
const upstream = http.createServer((req, res) => {
  let b = '';
  req.on('data', c => { b += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (b.includes('objecttype="TrainPosition"')) return res.end(JSON.stringify({ RESPONSE: { RESULT: [{ TrainPosition: [] }] } }));
    if (b.includes('objecttype="TrainStation"')) {
      stationCalls++;
      stationQuery = b;
      return res.end(JSON.stringify({ RESPONSE: { RESULT: [{ TrainStation: STATIONS }] } }));
    }
    announcementCalls++;
    res.end(JSON.stringify({ RESPONSE: { RESULT: [{ TrainAnnouncement: ANNOUNCEMENTS, INFO: { LASTCHANGEID: 7 } }] } }));
  });
});

const dataDir = path.join(__dirname, '.data-stations-test');
let server, base, plugin;

test.before(async () => {
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  process.env.TRAFIKVERKET_URL = `http://127.0.0.1:${upstream.address().port}/v2/data.json`;
  process.env.TRAFIKVERKET_API_KEY = 'test-key-not-real';
  process.env.BABTIST_POSITION_POLL_MS = '600000'; // position rounds only via _pollPositionsNow
  process.env.BABTIST_POLL_MS = '600000';
  plugin = require('../../../board/plugins/babtist/index.js');
  fs.mkdirSync(dataDir, { recursive: true });
  plugin.init({ dataDir });
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    plugin.handle(req, res, { path: url.pathname.replace('/t/babtist', ''), url }).then(h => { if (!h) { res.writeHead(404); res.end('{}'); } });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/t/babtist`;
  await new Promise(r => setTimeout(r, 300));
});

test.after(() => {
  server.closeAllConnections(); server.close(); upstream.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const get = async p => { const r = await fetch(base + p); return { code: r.status, text: await r.clone().text(), body: await r.json() }; };
const put = (id, t) => fetch(`${base}/api/displays/${id}`, { method: 'PUT', body: JSON.stringify(t) });
const byStation = body => Object.fromEntries(body.stations.map(s => [s.station, s]));

test('shape, sorting and the station query', async () => {
  const { code, body } = await get('/api/stations?displayId=hall-1');
  assert.strictEqual(code, 200);
  assert.strictEqual(body.displayId, 'hall-1');
  assert.strictEqual(body.upstream, 'ok');
  assert.ok(Date.parse(body.updatedAt));
  assert.deepStrictEqual(body.thresholds, { trains: 3, minutes: 5 });
  assert.deepStrictEqual(body.stations.map(s => s.station), ['Cst', 'Flb', 'Sci', 'Xyz']);
  for (const s of body.stations) assert.deepStrictEqual(Object.keys(s), ['station', 'name', 'lat', 'lon', 'lateCount', 'canceledCount', 'level']);
  assert.match(stationQuery, /namespace="rail\.infrastructure" schemaversion="1\.5"/);
  assert.match(stationQuery, /<INCLUDE>Geometry\.WGS84<\/INCLUDE>/);
});

test('coordinates are parsed, unknown or broken coordinates are null', async () => {
  const s = byStation((await get('/api/stations')).body);
  assert.deepStrictEqual([s.Sci.name, s.Sci.lat, s.Sci.lon], ['Stockholm City', 59.3307, 18.0592]);
  assert.deepStrictEqual([s.Cst.name, s.Cst.lat, s.Cst.lon], ['Stockholm C', 59.3313, 18.0575]);
  assert.deepStrictEqual([s.Flb.name, s.Flb.lat, s.Flb.lon], ['Flemingsberg', null, null]);
  assert.deepStrictEqual([s.Xyz.name, s.Xyz.lat, s.Xyz.lon], ['Xyz', null, null]);
  assert.strictEqual(s.Far, undefined, 'stations without announcements are not listed');
});

test('per-station counting with default thresholds, canceled kept apart', async () => {
  const s = byStation((await get('/api/stations?displayId=default')).body);
  assert.deepStrictEqual([s.Sci.lateCount, s.Sci.canceledCount, s.Sci.level], [2, 1, 'warning']);
  assert.deepStrictEqual([s.Cst.lateCount, s.Cst.canceledCount, s.Cst.level], [1, 0, 'warning']);
  assert.deepStrictEqual([s.Xyz.lateCount, s.Xyz.level], [0, 'ok']);
  assert.deepStrictEqual([s.Flb.lateCount, s.Flb.level], [0, 'ok']);
});

test('display thresholds change lateCount and level', async () => {
  assert.strictEqual((await put('two-six', { trains: 2, minutes: 6 })).status, 200);
  let s = byStation((await get('/api/stations?displayId=two-six')).body);
  assert.deepStrictEqual([s.Sci.lateCount, s.Sci.level], [2, 'severe']);
  assert.deepStrictEqual([s.Cst.lateCount, s.Cst.level], [1, 'warning']);

  // 8 minutes: train 1 counts at Sci only because its departure (9) is later than its arrival (7).
  await put('one-eight', { trains: 1, minutes: 8 });
  s = byStation((await get('/api/stations?displayId=one-eight')).body);
  assert.deepStrictEqual([s.Sci.lateCount, s.Sci.level], [1, 'severe']);
  assert.deepStrictEqual([s.Cst.lateCount, s.Cst.level], [1, 'severe']);

  await put('relaxed', { trains: 5, minutes: 30 });
  const body = (await get('/api/stations?displayId=relaxed')).body;
  assert.deepStrictEqual(body.thresholds, { trains: 5, minutes: 30 });
  assert.ok(body.stations.every(x => x.lateCount === 0 && x.level === 'ok'));
  assert.strictEqual(byStation(body).Sci.canceledCount, 1);
});

test('bad displayId is rejected', async () => {
  assert.strictEqual((await get('/api/stations?displayId=bad%20id')).code, 400);
  assert.strictEqual((await get('/api/stations?displayId=' + 'x'.repeat(41))).code, 400);
});

test('many requests and later polls cause no extra station or announcement calls', async () => {
  assert.strictEqual(stationCalls, 1);
  const before = announcementCalls;
  await Promise.all(Array.from({ length: 30 }, (_, i) => get(`/api/stations?displayId=d${i}`)));
  assert.strictEqual(announcementCalls, before);
  await plugin._pollNow();
  assert.strictEqual(announcementCalls, before + 1);
  assert.strictEqual(stationCalls, 1, 'station list is not refetched within 24 h');
});

test('the API key never reaches the response', async () => {
  const { text } = await get('/api/stations?displayId=hall-1');
  assert.ok(!text.includes('test-key-not-real'));
});

test('station colour only counts stops within the last 15 min or later; older-only stations stay, as ok', () => {
  const { Model } = require('../../../board/plugins/babtist/model.js');
  const m = new Model();
  const now = Date.now();
  const at = min => new Date(now + min * 60000).toISOString();
  const row = (train, loc, schedMin, actMin) => ({ AdvertisedTrainIdent: train, LocationSignature: loc, ActivityType: 'Avgang',
    AdvertisedTimeAtLocation: at(schedMin), TimeAtLocation: actMin == null ? undefined : at(actMin) });
  m.apply([row('801', 'Sol', -55, -49), row('802', 'Sol', -48, -42), row('803', 'Sol', -20, -10), row('804', 'Old', -50, -40)], { now });
  const by = Object.fromEntries(m.stationsFor({ trains: 3, minutes: 5 }, now).map(s => [s.station, s]));
  assert.strictEqual(by.Sol.lateCount, 1);
  assert.strictEqual(by.Sol.level, 'warning');
  assert.strictEqual(by.Old.lateCount, 0);
  assert.strictEqual(by.Old.level, 'ok');
});
