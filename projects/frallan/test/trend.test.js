'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Trend } = require('../../../board/plugins/frallan/trend');
const { NOW } = require('./fixtures');
const status = (now, count, extra = {}) => ({
  updatedAt: new Date(now).toISOString(), upstream: 'ok',
  thresholds: { trains: 3, minutes: 5 }, lateCount: count, canceledCount: 1, trainsTracked: 30, ...extra,
});
const read = (trend, now, count, extra = {}) =>
  trend.read(status(now, count, extra), { now, attemptAt: now, displayId: 'hall' });

test('starts honestly empty and classifies real five-minute changes, not synthetic history', () => {
  for (const [count, direction, delta] of [
    [i => 10 - i, 'improving', -10], [i => i, 'worsening', 10], [() => 4, 'steady', 0],
  ]) {
    const trend = new Trend();
    const first = read(trend, NOW, count(0));
    assert.equal(first.availability, 'warming-up');
    assert.equal(first.delta, null);
    assert.equal(first.points.length, 1);
    let result;
    for (let i = 1; i <= 10; i++) result = read(trend, NOW + i * 30000, count(i));
    assert.equal(result.availability, 'ready');
    assert.equal(result.direction, direction);
    assert.equal(result.delta, delta);
    assert.equal(result.observedMinutes, 5);
  }
});

test('deduplicates source timestamps and resets comparisons on either threshold change', () => {
  const trend = new Trend();
  read(trend, NOW, 4);
  const duplicate = trend.read(status(NOW, 4, { updatedAt: '2026-10-22T10:10:00+02:00' }),
    { now: NOW + 10000, attemptAt: NOW + 10000, displayId: 'hall' });
  assert.equal(duplicate.points.length, 1);
  for (const thresholds of [{ trains: 4, minutes: 5 }, { trains: 4, minutes: 10 }]) {
    const result = read(trend, NOW + 30000, 1, { thresholds });
    assert.equal(result.points.length, 1);
    assert.equal(result.availability, 'warming-up');
    assert.equal(result.delta, null);
  }
});

test('outages, demo and stale observations are gaps rather than invented zeroes', () => {
  const trend = new Trend();
  read(trend, NOW, 4);
  const unavailable = read(trend, NOW + 30000, 0, { upstream: 'error' });
  assert.equal(unavailable.availability, 'unavailable');
  assert.equal(unavailable.points.at(-1).lateCount, null);
  assert.equal(read(trend, NOW + 30000, 0, { upstream: 'error' }).points.length, 2);
  const recovered = read(trend, NOW + 60000, 3);
  assert.equal(recovered.availability, 'warming-up');
  assert.equal(recovered.observedMinutes, 0);
  assert.equal(read(trend, NOW + 90000, 0, { upstream: 'no-key' }).availability, 'demo');
  const noKey = read(trend, NOW + 120000, 0, { upstream: 'no-key', updatedAt: null });
  assert.equal(noKey.availability, 'demo');
  assert.equal(noKey.updatedAt, null);
  assert.equal(noKey.points.at(-1).lateCount, null);
  assert.equal(read(trend, NOW + 180000, 0, { updatedAt: new Date(NOW).toISOString() }).availability, 'stale');
});

test('unobserved time gaps cannot produce a confident comparison', () => {
  const trend = new Trend();
  read(trend, NOW, 10);
  const result = read(trend, NOW + 300000, 1);
  assert.equal(result.availability, 'warming-up');
  assert.equal(result.direction, 'unknown');
  assert.equal(result.delta, null);
  assert.equal(result.observedMinutes, 0);
});

test('prunes the thirty-minute window and bounds memory even with very frequent samples', () => {
  const trend = new Trend();
  let result;
  for (let i = 0; i < 401; i++) result = read(trend, NOW + i * 10000, i % 5);
  assert.ok(result.points.length <= 120);
  assert.ok(result.points.every(point => Date.parse(point.at) >= NOW + 4000000 - 1800000));
  trend.prune(NOW + 6000000);
  assert.equal(trend.points.length, 0);
});

test('invalid data and regressing source clocks never become healthy zeroes', () => {
  const trend = new Trend();
  read(trend, NOW, 3);
  for (const extra of [{ lateCount: null }, { trainsTracked: -1 }, { updatedAt: 'invalid' },
    { updatedAt: new Date(NOW + 300000).toISOString() }, { updatedAt: new Date(NOW - 1000).toISOString() }]) {
    const result = read(trend, NOW + 30000, 0, extra);
    assert.equal(result.availability, 'unavailable');
    assert.equal(result.direction, 'unknown');
    assert.equal(result.delta, null);
  }
});

test('tolerated source clock skew cannot place an outage before its preceding sample', () => {
  const trend = new Trend();
  read(trend, NOW, 3, { updatedAt: new Date(NOW + 60000).toISOString() });
  const result = read(trend, NOW + 30000, 0, { upstream: 'error' });
  assert.equal(result.availability, 'unavailable');
  assert.equal(result.points.at(-1).lateCount, null);
  assert.ok(Date.parse(result.points[1].at) >= Date.parse(result.points[0].at));
});
