'use strict';
// GET /api/trains: live TrainPosition joined with the delay model. Uses the test hooks instead of waiting for timers.
// Run: node --test projects/babtist/test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const T0 = Math.floor(Date.now() / 60000) * 60000;
const at = m => new Date(T0 + m * 60000).toISOString(); // minutes relative to T0, negative = past
const row = (id, loc, activity, advMin, extra = {}) => ({
  AdvertisedTrainIdent: id, LocationSignature: loc, ActivityType: activity, AdvertisedTimeAtLocation: at(advMin), ...extra,
});
const toSoc = { ToLocation: [{ LocationName: 'Söc', Priority: 1, Order: 0 }] };

const ANNOUNCEMENTS = [
  row('100', 'Sci', 'Ankomst', -10, { TimeAtLocation: at(-6), ...toSoc }),
  row('100', 'Sci', 'Avgang', -9, { TimeAtLocation: at(-5), ...toSoc }),
  row('100', 'Sst', 'Ankomst', 2, toSoc),
  row('100', 'Fle', 'Ankomst', 10, toSoc),
  // Arrived at Cst on time; its own departure row at Cst is not the "next station".
  row('101', 'Cst', 'Ankomst', -3, { TimeAtLocation: at(-3) }),
  row('101', 'Cst', 'Avgang', -2, { EstimatedTimeAtLocation: at(5) }),
  row('101', 'Sod', 'Ankomst', 5),
  row('200', 'Sci', 'Ankomst', 5, { EstimatedTimeAtLocation: at(8) }),
  row('300', 'Sci', 'Ankomst', 5),
  row('400', 'Sci', 'Ankomst', -5, { Canceled: true }),
  row('500', 'Sci', 'Ankomst', -5, { TimeAtLocation: at(-5) }),
  row('600', 'Sci', 'Ankomst', -5, { TimeAtLocation: at(-5) }),
  row('700', 'Sci', 'Ankomst', -5, { TimeAtLocation: at(-5) }),
  row('800', 'Sci', 'Ankomst', -5, { TimeAtLocation: at(-5) }),
];
const STATIONS = [
  { LocationSignature: 'Sci', AdvertisedLocationName: 'Stockholm City', Geometry: { WGS84: 'POINT (18.0592 59.3307)' } },
  { LocationSignature: 'Sst', AdvertisedLocationName: 'Stockholms södra', Geometry: { WGS84: 'POINT (18.0711 59.3134)' } },
  { LocationSignature: 'Cst', AdvertisedLocationName: 'Stockholm C', Geometry: { WGS84: 'POINT (18.0575 59.3313)' } },
];
const ago = s => new Date(Date.now() - s * 1000).toISOString();
const pos = (train, wkt, extra = {}) => ({ Train: { AdvertisedTrainNumber: train }, Position: { WGS84: wkt }, TimeStamp: ago(10), Bearing: 90, Deleted: false, ...extra });
const POSITIONS = () => [
  pos('100', 'POINT (18.0649 59.3324)', { Bearing: 169 }),
  pos('101', 'POINT (18.06 59.33)'),
  pos('200', 'POINT (17.9 59.4)'),
  pos('300', 'POINT (17.8 59.5)'),
  pos('400', 'POINT (17.7 59.6)'),
  pos('500', 'POINT (17.6 59.7)', { TimeStamp: ago(6 * 60) }), // older than 5 min
  pos('600', 'POINT (17.5 59.8)', { Bearing: undefined }),
  pos('800', 'POINT (17.4 59.9)', { Deleted: true }),
  pos('999', 'POINT (17.3 60.0)'), // not tracked
  pos('101', 'POINT (1 1)', { TimeStamp: ago(60) }), // older duplicate for 101 is ignored
];

let mode = 'ok';
const calls = { TrainAnnouncement: 0, TrainStation: 0, TrainPosition: 0 };
let positionQuery = '';
const upstream = http.createServer((req, res) => {
  let b = '';
  req.on('data', c => { b += c; });
  req.on('end', () => {
    const type = /objecttype="([^"]+)"/.exec(b)[1];
    calls[type]++;
    res.setHeader('content-type', 'application/json');
    if (type === 'TrainStation') return res.end(JSON.stringify({ RESPONSE: { RESULT: [{ TrainStation: STATIONS }] } }));
    if (type === 'TrainAnnouncement') return res.end(JSON.stringify({ RESPONSE: { RESULT: [{ TrainAnnouncement: ANNOUNCEMENTS, INFO: { LASTCHANGEID: 9 } }] } }));
    positionQuery = b;
    if (mode === '500') { res.writeHead(500); return res.end('boom'); }
    if (mode === 'apierror') return res.end(JSON.stringify({ RESPONSE: { RESULT: [{ ERROR: { MESSAGE: 'Invalid query' } }] } }));
    res.end(JSON.stringify({ RESPONSE: { RESULT: [{ TrainPosition: POSITIONS() }] } }));
  });
});

const dataDir = path.join(__dirname, '.data-trains-test');
let server, base, plugin;

test.before(async () => {
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  process.env.TRAFIKVERKET_URL = `http://127.0.0.1:${upstream.address().port}/v2/data.json`;
  process.env.TRAFIKVERKET_API_KEY = 'test-key-not-real';
  process.env.BABTIST_METRO = 'off';
  process.env.BABTIST_POLL_MS = '600000';
  process.env.BABTIST_POSITION_POLL_MS = '600000';
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
  await plugin._pollPositionsNow();
});

test.after(() => {
  server.closeAllConnections(); server.close(); upstream.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const get = async p => { const r = await fetch(base + p); const text = await r.text(); return { code: r.status, text, body: JSON.parse(text) }; };
const byTrain = body => Object.fromEntries(body.trains.map(t => [t.train, t]));

test('shape, sorting and the join with the delay model', async () => {
  const { code, body } = await get('/api/trains');
  assert.strictEqual(code, 200);
  assert.strictEqual(body.upstream, 'ok');
  assert.ok(Date.parse(body.updatedAt));
  assert.deepStrictEqual(Object.keys(body), ['updatedAt', 'upstream', 'count', 'trains']);
  assert.deepStrictEqual(body.trains.map(t => t.train), ['100', '101', '200', '300', '400', '600']);
  assert.strictEqual(body.count, 6);
  for (const t of body.trains) {
    assert.deepStrictEqual(Object.keys(t), ['trainId', 'train', 'lat', 'lon', 'bearing', 'positionAt', 'delayMinutes', 'canceled', 'to', 'lastStation', 'nextStation']);
    assert.match(t.trainId, new RegExp(`^${t.train}-\\d{4}-\\d{2}-\\d{2}$`));
    assert.ok(typeof t.lat === 'number' && typeof t.lon === 'number');
    assert.ok(Date.parse(t.positionAt));
  }
  const t = byTrain(body)['100'];
  assert.deepStrictEqual([t.lat, t.lon, t.bearing], [59.3324, 18.0649, 169]);
  assert.strictEqual(t.delayMinutes, 4);
  assert.strictEqual(t.canceled, false);
  assert.deepStrictEqual(t.to, ['Söc']);
  assert.deepStrictEqual(t.lastStation, { station: 'Sci', name: 'Stockholm City', at: at(-5) });
  assert.deepStrictEqual(t.nextStation, { station: 'Sst', name: 'Stockholms södra', scheduled: at(2), estimated: null });
});

test('lastStation/nextStation: departure at the same station is skipped, names fall back to the signature', async () => {
  const t = byTrain((await get('/api/trains')).body);
  assert.deepStrictEqual(t['101'].lastStation, { station: 'Cst', name: 'Stockholm C', at: at(-3) });
  assert.deepStrictEqual(t['101'].nextStation, { station: 'Sod', name: 'Sod', scheduled: at(5), estimated: null });
  assert.deepStrictEqual([t['101'].lat, t['101'].lon], [59.33, 18.06], 'newest position per train wins');
  assert.strictEqual(t['101'].delayMinutes, 0, 'latest actual wins over a later estimate');
  assert.strictEqual(t['200'].lastStation, null);
  assert.deepStrictEqual(t['200'].nextStation, { station: 'Sci', name: 'Stockholm City', scheduled: at(5), estimated: at(8) });
  assert.strictEqual(t['200'].delayMinutes, 3, 'estimate is used when there is no actual');
});

test('delayMinutes null when nothing reported, canceled, null bearing', async () => {
  const t = byTrain((await get('/api/trains')).body);
  assert.strictEqual(t['300'].delayMinutes, null);
  assert.strictEqual(t['400'].canceled, true);
  assert.strictEqual(t['600'].bearing, null);
  assert.deepStrictEqual(t['600'].to, []);
});

test('old, deleted, untracked and position-less trains are excluded', async () => {
  const t = byTrain((await get('/api/trains')).body);
  for (const id of ['500', '700', '800', '999']) assert.strictEqual(t[id], undefined, id);
});

test('the position query asks only for tracked trains, with a 5 minute TimeStamp filter', () => {
  const m = /<IN name="Train\.AdvertisedTrainNumber" value="([^"]*)"\/>/.exec(positionQuery);
  assert.ok(m, 'IN filter present');
  assert.deepStrictEqual(m[1].split(','), ['100', '101', '200', '300', '400', '500', '600', '700', '800']);
  assert.match(positionQuery, /namespace="järnväg\.trafikinfo" schemaversion="1\.1"/);
  assert.match(positionQuery, /<GT name="TimeStamp" value="\$dateadd\(-0\.00:05\)"\/>/);
  assert.ok(!positionQuery.includes('999'));
});

test('many requests cause no upstream calls', async () => {
  const before = { ...calls };
  await Promise.all(Array.from({ length: 30 }, () => get('/api/trains')));
  assert.deepStrictEqual(calls, before);
});

for (const failure of ['500', 'apierror']) {
  test(`upstream ${failure}: still 200, upstream "error", last positions kept, recovers`, async () => {
    mode = failure;
    await plugin._pollPositionsNow();
    const { code, body } = await get('/api/trains');
    assert.strictEqual(code, 200);
    assert.strictEqual(body.upstream, 'error');
    assert.strictEqual(body.count, 6);
    mode = 'ok';
    await plugin._pollPositionsNow();
    assert.strictEqual((await get('/api/trains')).body.upstream, 'ok');
  });
}

test('the API key never reaches the response', async () => {
  const { text } = await get('/api/trains');
  assert.ok(!text.includes('test-key-not-real'));
});
