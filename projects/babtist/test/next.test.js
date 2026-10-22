'use strict';
// GET /api/stations/:station/next: the next train runs at one station that have not left it yet.
// Run: node --test projects/babtist/test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const T0 = Math.floor(Date.now() / 60000) * 60000;
const at = m => new Date(T0 + m * 60000).toISOString();
const row = (id, loc, activity, advMin, extra = {}) => ({
  AdvertisedTrainIdent: id, LocationSignature: loc, ActivityType: activity, AdvertisedTimeAtLocation: at(advMin), ...extra,
});
const to = (...sigs) => ({ ToLocation: sigs.map(s => ({ LocationName: s, Priority: 1, Order: 0 })) });

const ANNOUNCEMENTS = [
  // 10: estimates at Sci, 4 min late on departure.
  row('10', 'Sci', 'Ankomst', 5, { EstimatedTimeAtLocation: at(9), ...to('Söc') }),
  row('10', 'Sci', 'Avgang', 6, { EstimatedTimeAtLocation: at(10), ...to('Söc') }),
  // 11: arrived 2 min late, not departed yet, no departure estimate.
  row('11', 'Sci', 'Ankomst', 1, { TimeAtLocation: at(3), ...to('Xyz') }),
  row('11', 'Sci', 'Avgang', 2, to('Xyz')),
  // 12: already departed.
  row('12', 'Sci', 'Ankomst', -4, { TimeAtLocation: at(-3) }),
  row('12', 'Sci', 'Avgang', -3, { TimeAtLocation: at(-2) }),
  // 13: terminates at Sci, nothing reported here, 3 min late at its previous stop.
  row('13', 'Cst', 'Avgang', -5, { TimeAtLocation: at(-2), ...to('Sci') }),
  row('13', 'Sci', 'Ankomst', 4, to('Sci')),
  // 14: terminated at Sci already.
  row('14', 'Sci', 'Ankomst', -2, { TimeAtLocation: at(-1) }),
  // 15: nothing reported anywhere.
  row('15', 'Sci', 'Avgang', 8, to('Söc')),
  // 16: canceled here.
  row('16', 'Sci', 'Avgang', 12, { Canceled: true, ...to('Söc') }),
  // 17: estimated early: never negative.
  row('17', 'Sci', 'Avgang', 15, { EstimatedTimeAtLocation: at(14), ...to('Söc') }),
  // 18: at Södertälje centrum.
  row('18', 'Söc', 'Avgang', 3, to('Sci')),
];
const STATIONS = [
  { LocationSignature: 'Sci', AdvertisedLocationName: 'Stockholm City', Geometry: { WGS84: 'POINT (18.0592 59.3307)' } },
  { LocationSignature: 'Cst', AdvertisedLocationName: 'Stockholm C', Geometry: { WGS84: 'POINT (18.0575 59.3313)' } },
  { LocationSignature: 'Söc', AdvertisedLocationName: 'Södertälje centrum', Geometry: { WGS84: 'POINT (17.6253 59.1925)' } },
];

let calls = 0;
const upstream = http.createServer((req, res) => {
  let b = '';
  req.on('data', c => { b += c; });
  req.on('end', () => {
    calls++;
    res.setHeader('content-type', 'application/json');
    if (b.includes('objecttype="TrainPosition"')) return res.end(JSON.stringify({ RESPONSE: { RESULT: [{ TrainPosition: [] }] } }));
    if (b.includes('objecttype="TrainStation"')) return res.end(JSON.stringify({ RESPONSE: { RESULT: [{ TrainStation: STATIONS }] } }));
    res.end(JSON.stringify({ RESPONSE: { RESULT: [{ TrainAnnouncement: ANNOUNCEMENTS, INFO: { LASTCHANGEID: 7 } }] } }));
  });
});

const dataDir = path.join(__dirname, '.data-next-test');
let server, base, plugin;

test.before(async () => {
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  process.env.TRAFIKVERKET_URL = `http://127.0.0.1:${upstream.address().port}/v2/data.json`;
  process.env.TRAFIKVERKET_API_KEY = 'test-key-not-real';
  process.env.BABTIST_METRO = 'off';
  process.env.BABTIST_POSITION_POLL_MS = '600000';
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

const get = async p => { const r = await fetch(base + p); return { code: r.status, body: await r.json() }; };
const byTrain = body => Object.fromEntries(body.trains.map(t => [t.train, t]));

test('shape, names and sorting by expected', async () => {
  const { code, body } = await get('/api/stations/Sci/next');
  assert.strictEqual(code, 200);
  assert.deepStrictEqual(Object.keys(body), ['station', 'name', 'updatedAt', 'upstream', 'count', 'trains']);
  assert.strictEqual(body.station, 'Sci');
  assert.strictEqual(body.name, 'Stockholm City');
  assert.strictEqual(body.upstream, 'ok');
  assert.ok(Date.parse(body.updatedAt));
  assert.deepStrictEqual(body.trains.map(t => t.train), ['11', '13', '15', '10', '16', '17']);
  assert.strictEqual(body.count, 6);
  for (const t of body.trains) {
    assert.deepStrictEqual(Object.keys(t), ['trainId', 'train', 'to', 'arrival', 'departure', 'expected', 'delayMinutes', 'canceled', 'track', 'trackChanged', 'deviations', 'notes']);
    assert.match(t.trainId, new RegExp(`^${t.train}-\\d{4}-\\d{2}-\\d{2}$`));
  }
  const ex = body.trains.map(t => Date.parse(t.expected));
  assert.deepStrictEqual(ex, [...ex].sort((a, b) => a - b));
  const t10 = byTrain(body)['10'];
  assert.deepStrictEqual(t10.to, [{ station: 'Söc', name: 'Södertälje centrum' }]);
  assert.deepStrictEqual(t10.arrival, { scheduled: at(5), estimated: at(9) });
  assert.deepStrictEqual(t10.departure, { scheduled: at(6), estimated: at(10) });
  assert.strictEqual(t10.expected, at(10));
  assert.deepStrictEqual(byTrain(body)['11'].to, [{ station: 'Xyz', name: 'Xyz' }], 'unknown destination falls back to signature');
});

test('departed and terminated trains are excluded, an arrived train is kept until it leaves', async () => {
  const t = byTrain((await get('/api/stations/Sci/next')).body);
  assert.strictEqual(t['12'], undefined);
  assert.strictEqual(t['14'], undefined);
  assert.ok(t['11']);
  assert.strictEqual(t['11'].expected, at(2), 'expected uses the departure schedule when there is no estimate');
});

test('terminating train has departure null and expected from the arrival', async () => {
  const t = byTrain((await get('/api/stations/Sci/next')).body)['13'];
  assert.strictEqual(t.departure, null);
  assert.deepStrictEqual(t.arrival, { scheduled: at(4), estimated: null });
  assert.strictEqual(t.expected, at(4));
});

test('delayMinutes: station estimate, arrival actual, train delay, 0, never negative', async () => {
  const t = byTrain((await get('/api/stations/Sci/next')).body);
  assert.strictEqual(t['10'].delayMinutes, 4);
  assert.strictEqual(t['11'].delayMinutes, 2);
  assert.strictEqual(t['13'].delayMinutes, 3);
  assert.strictEqual(t['15'].delayMinutes, 0);
  assert.strictEqual(t['17'].delayMinutes, 0);
});

test('canceled trains stay in the list', async () => {
  const t = byTrain((await get('/api/stations/Sci/next')).body);
  assert.strictEqual(t['16'].canceled, true);
  assert.strictEqual(t['10'].canceled, false);
});

test('limit: default 10, explicit value, 400 on bad values', async () => {
  const two = (await get('/api/stations/Sci/next?limit=2')).body;
  assert.deepStrictEqual(two.trains.map(t => t.train), ['11', '13']);
  assert.strictEqual(two.count, 2);
  assert.strictEqual((await get('/api/stations/Sci/next?limit=30')).body.count, 6);
  for (const bad of ['0', '31', 'abc', '2.5', '-1', '1e1']) {
    const { code, body } = await get('/api/stations/Sci/next?limit=' + bad);
    assert.strictEqual(code, 400, bad);
    assert.ok(body.error);
  }
});

test('URL-encoded signature with åäö works', async () => {
  const { code, body } = await get('/api/stations/S%C3%B6c/next');
  assert.strictEqual(code, 200);
  assert.strictEqual(body.station, 'Söc');
  assert.strictEqual(body.name, 'Södertälje centrum');
  assert.deepStrictEqual(body.trains.map(t => t.train), ['18']);
  assert.deepStrictEqual(body.trains[0].to, [{ station: 'Sci', name: 'Stockholm City' }]);
});

test('malformed signature gives 400', async () => {
  for (const bad of ['%E0%A4%A', 'S%3Cb%3E', 'ABCDEFGHIJK', '%2F..', '%20%22x']) {
    const { code, body } = await get(`/api/stations/${bad}/next`);
    assert.strictEqual(code, 400, bad);
    assert.ok(body.error);
  }
});

test('unknown station gives 200, empty list, name falls back to the signature', async () => {
  const { code, body } = await get('/api/stations/Zzz/next');
  assert.strictEqual(code, 200);
  assert.deepStrictEqual([body.station, body.name, body.count, body.trains], ['Zzz', 'Zzz', 0, []]);
});

test('the station list route is unaffected and requests never call upstream', async () => {
  const before = calls;
  const s = await get('/api/stations');
  assert.strictEqual(s.code, 200);
  assert.ok(Array.isArray(s.body.stations));
  for (let i = 0; i < 5; i++) await get('/api/stations/Sci/next?limit=3');
  assert.strictEqual(calls, before);
});

test('entries more than 5 minutes overdue are dropped (canceled stops never get an actual)', () => {
  const { Model } = require('../../../board/plugins/babtist/model.js');
  const m = new Model();
  const now = Date.now();
  const row = (train, minAgo, canceled) => ({ AdvertisedTrainIdent: train, LocationSignature: 'Xyz', ActivityType: 'Avgang',
    AdvertisedTimeAtLocation: new Date(now - minAgo * 60000).toISOString(), Canceled: canceled, ToLocation: [{ LocationName: 'Abc' }] });
  m.apply([row('901', 20, true), row('902', 3, true), row('903', -5, false)], { now });
  assert.deepStrictEqual(m.nextAt('Xyz', now, 10).map(t => t.train), ['902', '903']);
});

test('track, trackChanged, deviations and notes: departure first, deduplicated, honest when missing', () => {
  const { Model } = require('../../../board/plugins/babtist/model.js');
  const m = new Model();
  const now = Date.now();
  const t = min => new Date(now + min * 60000).toISOString();
  m.apply([
    { AdvertisedTrainIdent: '911', LocationSignature: 'Xyz', ActivityType: 'Ankomst', AdvertisedTimeAtLocation: t(5), TrackAtLocation: '1',
      Deviation: [{ Code: 'ANA034', Description: 'Fordonsfel' }], OtherInformation: [{ Code: 'ONA', Description: 'Stannar ej vid  Jordbro.' }] },
    { AdvertisedTrainIdent: '911', LocationSignature: 'Xyz', ActivityType: 'Avgang', AdvertisedTimeAtLocation: t(6), TrackAtLocation: '2',
      Deviation: [{ Code: 'ANA055', Description: 'Spårändrat' }, { Code: 'ANA034', Description: 'Fordonsfel' }], OtherInformation: [{ Description: 'Stannar ej vid  Jordbro.' }] },
    { AdvertisedTrainIdent: '912', LocationSignature: 'Xyz', ActivityType: 'Avgang', AdvertisedTimeAtLocation: t(8) },
  ], { now });
  const [a, b] = m.nextAt('Xyz', now, 10);
  assert.strictEqual(a.track, '2');
  assert.strictEqual(a.trackChanged, true);
  assert.deepStrictEqual(a.deviations, [{ code: 'ANA055', text: 'Spårändrat' }, { code: 'ANA034', text: 'Fordonsfel' }]);
  assert.deepStrictEqual(a.notes, ['Stannar ej vid Jordbro.']);
  assert.deepStrictEqual([b.track, b.trackChanged, b.deviations, b.notes], [null, false, [], []]);
});
