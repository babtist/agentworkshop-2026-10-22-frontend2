'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { geometry, validate } = require('../../../board/public/colony/frallan/trend.js');

const end = Date.parse('2026-10-22T09:30:00Z');
const point = (seconds, lateCount = 4) => ({
  at: new Date(end + seconds * 1000).toISOString(), lateCount, canceledCount: lateCount === null ? null : 0
});
const ready = () => ({
  version: 1, displayId: 'hall-1', availability: 'ready', direction: 'improving', delta: -2,
  comparisonMinutes: 5, windowMinutes: 30, observedMinutes: 6, thresholds: { trains: 3, minutes: 5 },
  updatedAt: new Date(end).toISOString(), evaluatedAt: new Date(end).toISOString(),
  points: [point(-30), point(0)]
});

test('time geometry keeps startup observations on the right without backfilling', () => {
  const g = geometry([point(0)], end, 3);
  assert.equal(g.segments.length, 1);
  assert.equal(g.segments[0].length, 1);
  assert.equal(g.segments[0][0].x, g.right);
  assert.equal(g.x(end - 30 * 60 * 1000), g.left);
  assert.equal(g.x(end - 15 * 60 * 1000), (g.left + g.right) / 2);
  assert.equal(geometry([point(-1801), point(1)], end, 3).segments.length, 0);
});

test('null samples and gaps over 60 seconds split both line and area segments', () => {
  const g = geometry([point(-240), point(-180), point(-150, null), point(-120), point(-59), point(0)], end, 3);
  assert.deepEqual(g.segments.map(segment => segment.length), [2, 1, 2]);
  const wide = geometry([point(-180), point(0)], end, 3, 320);
  assert.equal(wide.segments.length, 2);
  assert.equal(wide.right, 304);
});

test('threshold guides fit even when counts are all zero', () => {
  const g = geometry([point(0, 0)], end, 10);
  assert.ok(g.y(20) > g.top);
  assert.equal(g.y(0), g.bottom);
  assert.ok(g.y(10) < g.bottom);
});

test('schema rejects fabricated healthy counts and inconsistent direction', () => {
  assert.equal(validate(ready()), true);
  assert.equal(validate({ ...ready(), delta: null }), false);
  assert.equal(validate({ ...ready(), direction: 'worsening' }), false);
  assert.equal(validate({ ...ready(), points: [point(0, -1)] }), false);
  assert.equal(validate({ ...ready(), thresholds: { trains: 0, minutes: 5 } }), false);
  assert.equal(validate({ ...ready(), evaluatedAt: 'not a date' }), false);
  assert.equal(validate({ ...ready(), points: [{ at: 'bad', lateCount: 0, canceledCount: 0 }] }), false);
});

test('warm-up, stale, unavailable and no-key demo accept honest null observations', () => {
  for (const availability of ['warming-up', 'stale', 'unavailable', 'demo']) {
    assert.equal(validate({
      ...ready(), availability, direction: 'unknown', delta: null, observedMinutes: 0,
      updatedAt: null, thresholds: null, points: [point(0, null)]
    }), true, availability);
  }
});
