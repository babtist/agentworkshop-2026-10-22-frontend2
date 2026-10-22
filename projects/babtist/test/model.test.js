'use strict';
// Unit tests for board/plugins/babtist/model.js. No network.
// Run: node --test projects/babtist/test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const { Model, parseResponse, parseStations, parseWgs84, demoItems } = require('../../../board/plugins/babtist/model.js');

const MIN = 60000;
// 2026-10-22 00:10 Europe/Stockholm (CEST, UTC+2) = 2026-10-21 22:10 UTC.
const MIDNIGHT_NOW = Date.parse('2026-10-21T22:10:00Z');
const NOW = Date.parse('2026-10-22T08:00:00Z');
const at = (now, min) => new Date(now + min * MIN).toISOString();

const row = (id, now, advMin, extra = {}) => ({
  AdvertisedTrainIdent: id, LocationSignature: 'Sci', ActivityType: 'Ankomst',
  AdvertisedTimeAtLocation: at(now, advMin), ...extra,
});
const actual = (now, advMin, delayMin) => ({ TimeAtLocation: at(now, advMin + delayMin) });
const estimate = (now, advMin, delayMin) => ({ EstimatedTimeAtLocation: at(now, advMin + delayMin) });

const status = (m, minutes = 5) => m.statusFor({ trains: 3, minutes });

test('midnight rollover: one train run across 00:00 Stockholm keeps one trainId and counts once', () => {
  const m = new Model();
  m.apply([
    row('2801', MIDNIGHT_NOW, -20, { LocationSignature: 'Sod', ...actual(MIDNIGHT_NOW, -20, 6) }), // 23:50
    row('2801', MIDNIGHT_NOW, -5, { LocationSignature: 'Cst', ...actual(MIDNIGHT_NOW, -5, 7) }),   // 00:05
    row('2801', MIDNIGHT_NOW, 10, { LocationSignature: 'Sci', ...estimate(MIDNIGHT_NOW, 10, 7) }), // 00:20
  ], { now: MIDNIGHT_NOW });
  const ids = new Set(m.snapshot(MIDNIGHT_NOW).map(a => a.trainId));
  assert.deepStrictEqual([...ids], ['2801-2026-10-21'], 'service date is the date the run started');
  const s = status(m);
  assert.strictEqual(s.trainsTracked, 1);
  assert.strictEqual(s.lateCount, 1);
  assert.strictEqual(s.maxDelayMinutes, 7);
});

test('midnight rollover: trainId stays stable after the pre-midnight row leaves the window and on full refresh', () => {
  const m = new Model();
  m.apply([
    row('2801', MIDNIGHT_NOW, -20, actual(MIDNIGHT_NOW, -20, 6)),
    row('2801', MIDNIGHT_NOW, 10, { LocationSignature: 'Cst', ...actual(MIDNIGHT_NOW, 10, 3) }),
  ], { now: MIDNIGHT_NOW });
  const later = MIDNIGHT_NOW + 45 * MIN; // 00:55, the 23:50 row is now 65 min old
  const snap = m.snapshot(later);
  assert.strictEqual(snap.length, 1);
  assert.strictEqual(snap[0].trainId, '2801-2026-10-21');
  m.apply([row('2801', MIDNIGHT_NOW, 10, { LocationSignature: 'Cst', ...actual(MIDNIGHT_NOW, 10, 3) })], { full: true, now: later });
  assert.strictEqual(m.snapshot(later)[0].trainId, '2801-2026-10-21');
  assert.strictEqual(status(m).trainsTracked, 1);
});

test('midnight rollover: a run that starts after midnight gets the new date, and ids are forgotten when rows are gone', () => {
  const m = new Model();
  m.apply([row('2901', MIDNIGHT_NOW, 5, actual(MIDNIGHT_NOW, 5, 0))], { now: MIDNIGHT_NOW });
  assert.strictEqual(m.snapshot(MIDNIGHT_NOW)[0].trainId, '2901-2026-10-22');
  // The same ident a day later is a different run.
  const nextDay = MIDNIGHT_NOW + 24 * 60 * MIN;
  m.apply([row('2901', nextDay, 5, actual(nextDay, 5, 0))], { full: true, now: nextDay });
  assert.strictEqual(m.snapshot(nextDay)[0].trainId, '2901-2026-10-23');
});

test('delay comes from EstimatedTimeAtLocation when there is no TimeAtLocation', () => {
  const m = new Model();
  m.apply([row('100', NOW, 10, estimate(NOW, 10, 8))], { now: NOW });
  const s = status(m);
  assert.strictEqual(s.trainsTracked, 1);
  assert.strictEqual(s.maxDelayMinutes, 8);
  assert.strictEqual(s.lateCount, 1);
});

test('actual at the latest station with an actual wins over estimates and earlier actuals', () => {
  const m = new Model();
  // Inserted out of order on purpose: Map order must not matter.
  m.apply([
    row('200', NOW, 15, { LocationSignature: 'C', ...estimate(NOW, 15, 12) }),
    row('200', NOW, 0, { LocationSignature: 'B', ...actual(NOW, 0, 2), ...estimate(NOW, 0, 9) }),
    row('200', NOW, -10, { LocationSignature: 'A', ...actual(NOW, -10, 6) }),
  ], { now: NOW });
  const s = status(m);
  assert.strictEqual(s.trainsTracked, 1);
  assert.strictEqual(s.maxDelayMinutes, 2);
  assert.strictEqual(s.lateCount, 0);
});

test('early trains count as 0 delay, not late', () => {
  const m = new Model();
  m.apply([
    row('300', NOW, -5, actual(NOW, -5, -3)),
    row('301', NOW, 5, estimate(NOW, 5, -2)),
  ], { now: NOW });
  const s = status(m, 1);
  assert.strictEqual(s.trainsTracked, 2);
  assert.strictEqual(s.lateCount, 0);
  assert.strictEqual(s.maxDelayMinutes, 0);
  assert.deepStrictEqual(m.delays, [0, 0]);
});

test('Deleted rows in an incremental update remove the row, even if the timestamp is formatted differently', () => {
  const m = new Model();
  m.apply([row('400', NOW, -5, actual(NOW, -5, 10)), row('401', NOW, -5, actual(NOW, -5, 10))], { full: true, now: NOW });
  assert.strictEqual(status(m).trainsTracked, 2);
  m.apply([{ ...row('400', NOW, -5), Deleted: true }], { now: NOW });
  assert.strictEqual(status(m).trainsTracked, 1);
  // Same instant, written with a +02:00 offset as Trafikverket does.
  const local = new Date(NOW - 5 * MIN + 2 * 60 * MIN).toISOString().replace('Z', '').replace(/\.\d+$/, '') + '+02:00';
  m.apply([{ ...row('401', NOW, -5), AdvertisedTimeAtLocation: local, Deleted: true }], { now: NOW });
  assert.strictEqual(status(m).trainsTracked, 0);
  assert.strictEqual(m.snapshot(NOW).length, 0);
});

test('incremental update replaces an existing row instead of adding a second one', () => {
  const m = new Model();
  m.apply([row('450', NOW, 5, estimate(NOW, 5, 3))], { full: true, now: NOW });
  m.apply([row('450', NOW, 5, estimate(NOW, 5, 9))], { now: NOW });
  assert.strictEqual(m.snapshot(NOW).length, 1);
  assert.strictEqual(status(m).maxDelayMinutes, 9);
});

test('rows outside the 60 min back / 30 min ahead window are dropped on summarize', () => {
  const m = new Model();
  m.apply([
    row('500', NOW, -61, actual(NOW, -61, 20)),
    row('501', NOW, -59, actual(NOW, -59, 6)),
    row('502', NOW, 29, estimate(NOW, 29, 0)),
    row('503', NOW, 31, estimate(NOW, 31, 20)),
  ], { now: NOW });
  assert.deepStrictEqual(m.snapshot(NOW).map(a => a.trainId.split('-')[0]), ['501', '502']);
  assert.strictEqual(status(m).maxDelayMinutes, 6);
  m.summarize(NOW + 2 * MIN);
  assert.strictEqual(status(m).trainsTracked, 1);
});

test('canceled trains are counted once and not as late', () => {
  const m = new Model();
  m.apply([
    row('600', NOW, -5, { Canceled: true }),
    row('600', NOW, 5, { LocationSignature: 'Cst', Canceled: true }),
  ], { now: NOW });
  const s = status(m);
  assert.strictEqual(s.canceledCount, 1);
  assert.strictEqual(s.trainsTracked, 1);
  assert.strictEqual(s.lateCount, 0);
});

test('rows without ident or with a bad time are ignored', () => {
  const m = new Model();
  m.apply([null, {}, { AdvertisedTrainIdent: '700', AdvertisedTimeAtLocation: 'not a date' }], { now: NOW });
  assert.strictEqual(m.snapshot(NOW).length, 0);
});

test('parseResponse: ERROR throws, missing TrainAnnouncement is empty, LASTCHANGEID is a string', () => {
  assert.throws(() => parseResponse({ RESPONSE: { RESULT: [{ ERROR: { SOURCE: 'x', MESSAGE: 'Invalid key' } }] } }), /Invalid key/);
  assert.throws(() => parseResponse({}), /unexpected response shape/);
  assert.throws(() => parseResponse(null), /unexpected response shape/);
  assert.deepStrictEqual(parseResponse({ RESPONSE: { RESULT: [{}] } }), { items: [], lastChangeId: null });
  assert.deepStrictEqual(parseResponse({ RESPONSE: { RESULT: [{ INFO: { LASTCHANGEID: 7462384927 } }] } }), { items: [], lastChangeId: '7462384927' });
  const r = parseResponse({ RESPONSE: { RESULT: [{ TrainAnnouncement: [{ AdvertisedTrainIdent: '1' }], INFO: { LASTCHANGEID: '42' } }] } });
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.lastChangeId, '42');
});

test('demoItems produce a stable, valid status', () => {
  const m = new Model();
  m.apply(demoItems(NOW), { full: true, now: NOW });
  const s = status(m);
  assert.ok(s.trainsTracked > 0);
  assert.ok(s.canceledCount > 0);
  assert.deepStrictEqual(demoItems(NOW), demoItems(NOW));
});

test('parseWgs84 reads lon then lat and rejects junk', () => {
  assert.deepStrictEqual(parseWgs84('POINT (18.064852006540633 59.332371649822775)'), { lon: 18.064852006540633, lat: 59.332371649822775 });
  for (const bad of [null, '', 'POINT (18.06)', 'LINESTRING (1 2, 3 4)', 'POINT (18 999)']) assert.strictEqual(parseWgs84(bad), null);
});

test('parseStations keeps signature, name and coordinates only, and throws on upstream errors', () => {
  const m = parseStations({ RESPONSE: { RESULT: [{ TrainStation: [
    { LocationSignature: 'Sci', AdvertisedLocationName: 'Stockholm City', Geometry: { WGS84: 'POINT (18.0592 59.3307)' }, Extra: 1 },
    { LocationSignature: 'Nog' },
    { AdvertisedLocationName: 'no signature' },
  ] }] } });
  assert.deepStrictEqual([...m], [['Sci', { name: 'Stockholm City', lat: 59.3307, lon: 18.0592 }], ['Nog', { name: 'Nog', lat: null, lon: null }]]);
  assert.throws(() => parseStations({ RESPONSE: { RESULT: [{ ERROR: { MESSAGE: 'x' } }] } }), /upstream error/);
});

test('stationsFor: demo data gives one station, Sci', () => {
  const m = new Model();
  m.apply(demoItems(NOW), { full: true, now: NOW });
  const s = m.stationsFor({ trains: 3, minutes: 5 }, NOW);
  assert.deepStrictEqual(s.map(x => x.station), ['Sci']);
  assert.ok(s[0].canceledCount > 0);
});
