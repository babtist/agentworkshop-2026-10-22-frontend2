'use strict';
// Station notices from TrainStationMessage: GET /api/notices and GET /api/stations/:station/notices.
// Run: node --test projects/babtist/test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { parseNotices, noticeActive, activeNotices } = require('../../../board/plugins/babtist/model.js');

const H = 3600000;
const NOW = Date.now();
const iso = ms => new Date(ms).toISOString();
const msg = (id, loc, text, extra = {}) => ({
  Id: id, LocationCode: loc, FreeText: text, Status: 'Normal', MediaType: 'Monitor',
  StartDateTime: iso(NOW - H), EndDateTime: iso(NOW + H), SplitActivationTime: false, ActiveDays: 'yyyyyyy', Deleted: false, ...extra,
});
const wrap = list => ({ RESPONSE: { RESULT: [{ TrainStationMessage: list }] } });

// Stockholm wall-clock instant for a local date and time, for the split-window tests.
function local(date, hhmm) {
  for (const off of ['+01:00', '+02:00']) {
    const ms = Date.parse(`${date}T${hhmm}:00${off}`);
    const s = new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', hourCycle: 'h23' });
    if (s.startsWith(`${date} ${hhmm}`)) return ms;
  }
  throw new Error('no such local time');
}

test('parseNotices: joins wrapped sign text, maps priority and media, drops deleted and empty', () => {
  const out = parseNotices(wrap([
    msg('a', 'Sci', 'Buss ersätter tåg \nmellan Älvsjö-Stuvsta-\nHuddinge den 19-\n23 oktober.', { Status: 'Hog', MediaType: 'Utrop' }),
    msg('b', 'Sci', 'x', { Deleted: true }),
    msg('c', 'Sci', '   '),
    msg('d', 'Sci', 'Plattform', { Status: 'Lag', MediaType: 'Plattformsskylt', ActiveDays: 'bad' }),
  ]));
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].text, 'Buss ersätter tåg mellan Älvsjö-Stuvsta-Huddinge den 19-23 oktober.');
  assert.strictEqual(out[0].priority, 'high');
  assert.strictEqual(out[0].media, 'announcement');
  assert.strictEqual(out[1].priority, 'low');
  assert.strictEqual(out[1].media, 'platform');
  assert.strictEqual(out[1].days, null);
  assert.throws(() => parseNotices({ RESPONSE: { RESULT: [{ ERROR: { MESSAGE: 'nope' } }] } }), /nope/);
});

test('noticeActive: plain window', () => {
  const [n] = parseNotices(wrap([msg('a', 'Sci', 't')]));
  assert.strictEqual(noticeActive(n, NOW), true);
  assert.strictEqual(noticeActive(n, NOW - 2 * H), false);
  assert.strictEqual(noticeActive(n, NOW + H), false, 'end is exclusive');
});

test('noticeActive: split window wrapping midnight, with ActiveDays', () => {
  const [n] = parseNotices(wrap([msg('a', 'Sci', 'night', {
    StartDateTime: iso(local('2026-10-18', '22:00')), EndDateTime: iso(local('2026-10-23', '05:00')),
    SplitActivationTime: true, ActiveDays: 'yyny',
  })]));
  assert.strictEqual(noticeActive(n, local('2026-10-18', '23:30')), true, 'first night, day 0');
  assert.strictEqual(noticeActive(n, local('2026-10-19', '04:59')), true, 'after midnight belongs to the night that started on day 0');
  assert.strictEqual(noticeActive(n, local('2026-10-19', '12:00')), false, 'not shown at noon');
  assert.strictEqual(noticeActive(n, local('2026-10-20', '23:00')), false, 'day 2 is n');
  assert.strictEqual(noticeActive(n, local('2026-10-21', '01:00')), false, 'still the night of day 2');
  assert.strictEqual(noticeActive(n, local('2026-10-21', '22:30')), true, 'day 3 is y');
  assert.strictEqual(noticeActive(n, local('2026-10-22', '22:30')), true, 'past ActiveDays: shown');
  assert.strictEqual(noticeActive(n, local('2026-10-23', '05:00')), false, 'after the end');
});

test('noticeActive: split window inside one day', () => {
  const [n] = parseNotices(wrap([msg('a', 'Sci', 'day', {
    StartDateTime: iso(local('2026-10-20', '09:00')), EndDateTime: iso(local('2026-10-24', '15:00')), SplitActivationTime: true, ActiveDays: null,
  })]));
  assert.strictEqual(noticeActive(n, local('2026-10-21', '10:00')), true);
  assert.strictEqual(noticeActive(n, local('2026-10-21', '16:00')), false);
  assert.strictEqual(noticeActive(n, local('2026-10-21', '08:00')), false);
});

test('activeNotices: one per text, media merged, highest priority, sorted', () => {
  const list = parseNotices(wrap([
    msg('a1', 'Sci', 'Same text', { MediaType: 'Monitor', Status: 'Lag', StartDateTime: iso(NOW - 2 * H) }),
    msg('a2', 'Sci', 'Same \ntext', { MediaType: 'Plattformsskylt', Status: 'Normal' }),
    msg('a3', 'Sod', 'Same text', { MediaType: 'Monitor' }),
    msg('b', 'Sci', 'Urgent', { Status: 'Hog' }),
    msg('c', 'Sci', 'Future', { StartDateTime: iso(NOW + 10 * 60000) }),
  ]));
  const out = activeNotices(list, NOW);
  assert.deepStrictEqual(out.map(n => n.text), ['Urgent', 'Same text']);
  const same = out[1];
  assert.strictEqual(same.priority, 'normal');
  assert.deepStrictEqual(same.media, ['monitor', 'platform']);
  assert.deepStrictEqual(same.stations, ['Sci', 'Sod']);
  assert.strictEqual(same.start, iso(NOW - 2 * H));
});

// --- HTTP, against a fake upstream ---

const T0 = Math.floor(NOW / 60000) * 60000;
const ANNOUNCEMENTS = [
  { AdvertisedTrainIdent: '10', LocationSignature: 'Sci', ActivityType: 'Avgang', AdvertisedTimeAtLocation: iso(T0 + 5 * 60000) },
  { AdvertisedTrainIdent: '10', LocationSignature: 'Sod', ActivityType: 'Ankomst', AdvertisedTimeAtLocation: iso(T0 + 25 * 60000) },
];
const STATIONS = [
  { LocationSignature: 'Sci', AdvertisedLocationName: 'Stockholm City', Geometry: { WGS84: 'POINT (18.0592 59.3307)' } },
  { LocationSignature: 'Sod', AdvertisedLocationName: 'Södertälje hamn', Geometry: { WGS84: 'POINT (17.64 59.18)' } },
];
const MESSAGES = [
  msg('m1', 'Sci', 'Hissen är ur funktion.', { MediaType: 'Monitor' }),
  msg('m2', 'Sci', 'Hissen är ur \nfunktion.', { MediaType: 'Plattformsskylt' }),
  msg('m3', 'Sod', 'Hissen är ur funktion.'),
  msg('m4', 'Sod', 'Spårändring.', { Status: 'Hog' }),
  msg('m5', 'Sci', 'Old', { EndDateTime: iso(NOW - 60000) }),
];

let noticeBody = '';
const upstream = http.createServer((req, res) => {
  let b = '';
  req.on('data', c => { b += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (b.includes('objecttype="TrainPosition"')) return res.end(JSON.stringify({ RESPONSE: { RESULT: [{ TrainPosition: [] }] } }));
    if (b.includes('objecttype="TrainStationMessage"')) { noticeBody = b; return res.end(JSON.stringify(wrap(MESSAGES))); }
    if (b.includes('objecttype="TrainStation"')) return res.end(JSON.stringify({ RESPONSE: { RESULT: [{ TrainStation: STATIONS }] } }));
    res.end(JSON.stringify({ RESPONSE: { RESULT: [{ TrainAnnouncement: ANNOUNCEMENTS, INFO: { LASTCHANGEID: 7 } }] } }));
  });
});

const dataDir = path.join(__dirname, '.data-notices-test');
let server, base;

test.before(async () => {
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  process.env.TRAFIKVERKET_URL = `http://127.0.0.1:${upstream.address().port}/v2/data.json`;
  process.env.TRAFIKVERKET_API_KEY = 'test-key-not-real';
  process.env.BABTIST_POSITION_POLL_MS = '600000';
  process.env.BABTIST_POLL_MS = '600000';
  const plugin = require('../../../board/plugins/babtist/index.js');
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

test('upstream query asks only for the stations the model knows, and only unexpired notices', () => {
  assert.match(noticeBody, /<IN name="LocationCode" value="Sci,Sod"\/>/);
  assert.match(noticeBody, /<GT name="EndDateTime" value="\$now"\/>/);
});

test('GET /api/stations/:station/notices: active notices at one station, one per text', async () => {
  const { code, body } = await get('/api/stations/Sci/notices');
  assert.strictEqual(code, 200);
  assert.deepStrictEqual(Object.keys(body), ['station', 'name', 'updatedAt', 'upstream', 'count', 'notices']);
  assert.strictEqual(body.name, 'Stockholm City');
  assert.strictEqual(body.upstream, 'ok');
  assert.strictEqual(body.count, 1);
  const [n] = body.notices;
  assert.deepStrictEqual(Object.keys(n), ['id', 'text', 'priority', 'media', 'start', 'end']);
  assert.strictEqual(n.text, 'Hissen är ur funktion.');
  assert.deepStrictEqual(n.media, ['monitor', 'platform']);
});

test('GET /api/stations/:station/notices: high priority first, unknown station is empty', async () => {
  const sod = (await get('/api/stations/Sod/notices')).body;
  assert.deepStrictEqual(sod.notices.map(n => n.priority), ['high', 'normal']);
  const none = await get('/api/stations/Xyz/notices');
  assert.strictEqual(none.code, 200);
  assert.strictEqual(none.body.count, 0);
  assert.strictEqual((await get('/api/stations/%3Cx%3E/notices')).code, 400);
});

test('GET /api/notices: all stations, the same text once with its stations', async () => {
  const { code, body } = await get('/api/notices');
  assert.strictEqual(code, 200);
  assert.deepStrictEqual(Object.keys(body), ['updatedAt', 'upstream', 'count', 'notices']);
  assert.deepStrictEqual(body.notices.map(n => n.text), ['Spårändring.', 'Hissen är ur funktion.']);
  assert.deepStrictEqual(body.notices[1].stations, [{ station: 'Sci', name: 'Stockholm City' }, { station: 'Sod', name: 'Södertälje hamn' }]);
  assert.ok(!JSON.stringify(body).includes('test-key'));
});
