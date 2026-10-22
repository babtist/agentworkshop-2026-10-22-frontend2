'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('../../../board/plugins/frallan/risk');
const { NOW, time, row, snapshot } = require('./fixtures');

const run = (source = snapshot(), thresholds = { trains: 3, minutes: 5 }, now = NOW) =>
  analyze(source, thresholds, { displayId: 'hall-1', now });

test('counts distinct followers across leaders and stations, using each display threshold', () => {
  const rows = [
    row('a', -2, { estimated: time(10) }), row('b', -1, { estimated: time(11) }),
    ...[4, 5, 6, 7, 8, 9].map((minute, i) => row(`f${i}`, minute)),
    row('a', -2, { station: 'Odp', estimated: time(10) }), row('f0', 4, { station: 'Odp' }),
  ];
  const result = run(snapshot(rows));
  assert.equal(result.availability, 'ready');
  assert.equal(result.affectedTrainCount, 6);
  assert.equal(result.level, 'severe');
  assert.deepEqual(result.reasons, ['POTENTIAL_HEADWAY_OVERLAP']);
  assert.equal(run(snapshot(rows), { trains: 6, minutes: 5 }).level, 'warning');
  assert.equal(run(snapshot(rows), { trains: 7, minutes: 5 }).level, 'ok');
  assert.equal(run(snapshot(rows), { trains: 3, minutes: 20 }).affectedTrainCount, 0);
  assert.ok(!JSON.stringify(result).includes('"trainId"'));
});

test('compares unrounded Y and inclusive overlap boundaries; actual wins over estimate', () => {
  const rows = [row('a', 2, { estimated: time(7) }), row('b', 7)];
  assert.equal(run(snapshot(rows)).affectedTrainCount, 1);
  rows[0].estimated = new Date(Date.parse(time(7)) - 1).toISOString();
  assert.equal(run(snapshot(rows)).affectedTrainCount, 0);
  rows[0].actual = time(3);
  rows[0].estimated = time(12);
  assert.equal(run(snapshot(rows)).affectedTrainCount, 0);
  assert.deepEqual(run(snapshot(rows)).reasons, []);
});

test('does not compare different activities or destinations, or infer unknown grouping', () => {
  for (const extra of [{ to: ['Mr'] }, { activity: 'Ankomst' }, { station: 'Odp' }]) {
    const result = run(snapshot([row('a', 2, { estimated: time(10) }), row('b', 6, extra)]));
    assert.equal(result.availability, 'insufficient');
    assert.equal(result.level, null);
  }
  assert.equal(run(snapshot([row('a', 2, { to: [] }), row('b', 6)])).availability, 'insufficient');
});

test('canonicalizes destination sets and equivalent timestamps without mutating source', () => {
  const a = row('a', 2, { to: ['Nyc', 'Mr', 'Nyc'], estimated: time(10) });
  const b = row('b', 6, { to: ['Mr', 'Nyc'] });
  const duplicate = { ...a, scheduled: '2026-10-22T10:12:00+02:00', estimated: '2026-10-22T10:20:00+02:00' };
  const source = snapshot([a, b, duplicate]);
  const before = JSON.stringify(source);
  assert.equal(run(source).affectedTrainCount, 1);
  assert.equal(JSON.stringify(source), before);
  duplicate.estimated = time(11);
  assert.equal(run(source).availability, 'insufficient');
  assert.equal(run(snapshot([a, b, { ...a, canceled: true }])).availability, 'insufficient');
});

test('excludes canceled trains and observed followers, and keeps cancellation count distinct', () => {
  const rows = [row('a', 2, { estimated: time(10) }), row('b', 6),
    row('c', 7, { canceled: true }), row('c', 8, { canceled: true, station: 'Odp' }),
    row('done', 8, { actual: time(9) })];
  const result = run(snapshot(rows));
  assert.equal(result.affectedTrainCount, 1);
  assert.equal(result.canceledTrainCount, 1);
});

test('equal schedules and repeated events of the same train never create self-conflicts', () => {
  const rows = [row('a', 2, { estimated: time(10) }), row('a', 3),
    row('follower', 6)];
  assert.equal(run(snapshot(rows)).affectedTrainCount, 1);
  rows.push(row('b', 2, { estimated: time(10) }));
  assert.equal(run(snapshot(rows)).affectedTrainCount, 2);
  assert.equal(run(snapshot([row('a', 2, { estimated: time(10) }), row('b', 2)])).availability, 'insufficient');
});

test('preserves opaque train identities across UTC/Swedish midnight', () => {
  const now = Date.parse('2026-10-22T21:59:00Z');
  const rows = [
    row('100-2026-10-22', 2, { scheduled: '2026-10-22T23:58:00+02:00', estimated: '2026-10-23T00:06:00+02:00' }),
    row('200-2026-10-22', 6, { scheduled: '2026-10-23T00:03:00+02:00' }),
  ];
  assert.equal(run(snapshot(rows, { updatedAt: new Date(now).toISOString() }), undefined, now).affectedTrainCount, 1);
});

test('expires old/future rows on evaluation, not request/cache timestamps', () => {
  const source = snapshot([row('a', -11, { estimated: time(10) }), row('b', 6)]);
  assert.equal(run(source).availability, 'insufficient');
  const outside = snapshot([row('a', 2, { estimated: time(40) }), row('b', 31)]);
  assert.equal(run(outside).availability, 'insufficient');
});

test('all source-health and coverage failures remain explicitly non-ready', () => {
  const cases = [
    [null, 'unavailable'],
    [snapshot([], { upstream: 'error' }), 'unavailable'],
    [snapshot([], { upstream: 'no-key', complete: false }), 'demo'],
    [snapshot(undefined, { updatedAt: 'not a date' }), 'unavailable'],
    [snapshot(undefined, { updatedAt: time(2) }), 'unavailable'],
    [snapshot(undefined, { updatedAt: time(-2) }), 'stale'],
    [snapshot([], {}), 'insufficient'],
    [snapshot(undefined, { complete: false }), 'insufficient'],
    [snapshot(undefined, { count: 99 }), 'unavailable'],
    [snapshot(Array.from({ length: 5000 }, () => row('a', 2))), 'insufficient'],
    [snapshot(undefined, { window: { pastMinutes: 60, futureMinutes: 5 } }), 'insufficient'],
    [snapshot([row('a', 2, { actual: 'invalid' }), row('b', 6)]), 'unavailable'],
    [snapshot([row('a', 2, { scheduled: null }), row('b', 6)]), 'insufficient'],
  ];
  for (const [source, expected] of cases) {
    const result = run(source);
    assert.equal(result.availability, expected);
    assert.equal(result.level, null);
    assert.equal(result.affectedTrainCount, null);
    assert.ok(result.reasons.length);
  }
  assert.equal(run(snapshot(), { trains: 0, minutes: 5 }).availability, 'unavailable');
});
