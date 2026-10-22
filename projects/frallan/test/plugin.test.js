'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createPlugin } = require('../../../board/plugins/frallan');
const { NOW, row, snapshot } = require('./fixtures');

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function harness(t, { timeoutMs = 1000 } = {}) {
  const state = { now: NOW, snapshotCalls: 0, settingsCalls: 0, logs: [], failure: false, settingsFailure: false, hang: false,
    malformed: false, thresholds: { trains: 1, minutes: 5 }, lateCount: 4, source: snapshot() };
  const controller = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const isSnapshot = url.pathname === '/t/babtist/api/snapshot';
    if (isSnapshot) state.snapshotCalls++;
    else state.settingsCalls++;
    if (state.hang) return;
    res.writeHead(state.failure || (!isSnapshot && state.settingsFailure) ? 503 : 200, { 'content-type': 'application/json' });
    res.end(state.malformed ? '{invalid' : JSON.stringify(isSnapshot ? state.source :
      { displayId: url.searchParams.get('displayId'), thresholds: state.thresholds,
        updatedAt: state.source.updatedAt, upstream: state.source.upstream,
        lateCount: state.lateCount, canceledCount: 0, trainsTracked: 20 }));
  });
  const controllerBase = await listen(controller);
  const plugin = createPlugin({ controllerUrl: controllerBase + '/t/babtist/',
    now: () => state.now, log: message => state.logs.push(message), timeoutMs });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!await plugin.handle(req, res, { path: url.pathname, url })) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"Not found"}');
    }
  });
  const base = await listen(server);
  t.after(async () => {
    await Promise.all([server, controller].map(s => new Promise(resolve => {
      s.closeAllConnections();
      s.close(resolve);
    })));
  });
  return { state, get: async (path = '/api/risk') => {
    const response = await fetch(base + path, { headers: { host: 'not-the-controller.invalid' } });
    return { code: response.status, body: await response.json(), headers: response.headers };
  } };
}

test('coalesces concurrent snapshot/settings reads and caches both successes and failures', async t => {
  const { state, get } = await harness(t);
  const results = await Promise.all(Array.from({ length: 20 }, () => get('/api/risk?displayId=hall-1')));
  assert.ok(results.every(result => result.code === 200 && result.body.level === 'warning'));
  assert.equal(state.snapshotCalls, 1);
  assert.equal(state.settingsCalls, 1);
  await Promise.all(Array.from({ length: 20 }, (_, i) => get(`/api/risk?displayId=d${i}`)));
  assert.equal(state.snapshotCalls, 1);
  assert.equal(state.settingsCalls, 21);
  state.now += 20001;
  state.failure = true;
  const failed = await Promise.all(Array.from({ length: 10 }, () => get('/api/risk?displayId=hall-1')));
  assert.ok(failed.every(result => result.code === 503 && result.body.availability === 'unavailable' && result.body.level === null));
  assert.equal(state.snapshotCalls, 2);
  assert.equal(state.settingsCalls, 22);
  assert.ok(state.logs.length);
  state.now += 20001;
  state.failure = false;
  state.source.updatedAt = new Date(state.now).toISOString();
  const recovered = await get('/api/risk?displayId=hall-1');
  assert.equal(recovered.code, 200);
  assert.equal(recovered.body.availability, 'ready');
  assert.equal(state.snapshotCalls, 3);
});

test('trend shares status cache with risk, not browser-specific history or extra snapshot reads', async t => {
  const { state, get } = await harness(t);
  assert.equal((await get('/api/trend?displayId=bad%20id')).code, 400);
  assert.equal(state.settingsCalls, 0);
  const clients = await Promise.all(Array.from({ length: 20 }, () => get('/api/trend?displayId=hall')));
  assert.ok(clients.every(result => result.code === 200 && result.body.availability === 'warming-up'));
  assert.ok(clients.every(result => result.body.points.length === 1 && result.body.delta === null));
  assert.equal(state.settingsCalls, 1);
  assert.equal(state.snapshotCalls, 0);
  await get('/api/risk?displayId=hall');
  assert.equal(state.settingsCalls, 1);
  assert.equal(state.snapshotCalls, 1);
  let result;
  for (let i = 1; i <= 10; i++) {
    state.now = NOW + i * 30000;
    state.source.updatedAt = new Date(state.now).toISOString();
    state.lateCount = 4 + i;
    result = await get('/api/trend?displayId=hall');
  }
  assert.equal(result.body.availability, 'ready');
  assert.equal(result.body.direction, 'worsening');
  assert.equal(result.body.delta, 10);
  assert.equal(result.body.points.length, 11);
  assert.equal(state.snapshotCalls, 1);
  assert.equal((await get('/api/trend?displayId=other')).body.points.length, 1);
  state.now += 30000;
  state.source.updatedAt = new Date(state.now).toISOString();
  state.thresholds = { trains: 2, minutes: 5 };
  const changed = await get('/api/trend?displayId=hall');
  assert.equal(changed.body.availability, 'warming-up');
  assert.equal(changed.body.points.length, 1);
});

test('trend exposes cached failures, recovery and stale/demo source state without zero fallbacks', async t => {
  const { state, get } = await harness(t);
  await get('/api/trend');
  state.now += 30000;
  state.settingsFailure = true;
  const failed = await get('/api/trend');
  assert.equal(failed.code, 503);
  assert.equal(failed.body.availability, 'unavailable');
  assert.equal(failed.body.points.at(-1).lateCount, null);
  await get('/api/trend');
  assert.equal(state.settingsCalls, 2);
  state.settingsFailure = false;
  state.now += 30000;
  state.source.updatedAt = new Date(state.now).toISOString();
  const recovered = await get('/api/trend');
  assert.equal(recovered.body.availability, 'warming-up');
  assert.equal(recovered.body.observedMinutes, 0);
  state.now += 100000;
  const stale = await get('/api/trend');
  assert.equal(stale.code, 503);
  assert.equal(stale.body.availability, 'stale');
  state.now += 30000;
  state.source.upstream = 'no-key';
  state.source.updatedAt = new Date(state.now).toISOString();
  const demo = await get('/api/trend');
  assert.equal(demo.code, 200);
  assert.equal(demo.body.availability, 'demo');
  assert.equal(demo.body.direction, 'unknown');
  assert.equal(state.snapshotCalls, 0);
  assert.ok(state.logs.length);
});

test('refreshes authoritative thresholds, and rejects invalid IDs before reading the source', async t => {
  const { state, get } = await harness(t);
  for (const id of ['bad%20id', '', 'x'.repeat(41), 'a&displayId=b', 'bad%0A']) {
    assert.equal((await get(`/api/risk?displayId=${id}`)).code, 400);
  }
  assert.equal(state.snapshotCalls, 0);
  const initial = await get();
  assert.equal(initial.body.displayId, 'default');
  assert.equal(initial.headers.get('cache-control'), 'no-store');
  assert.equal(initial.body.level, 'warning');
  state.thresholds = { trains: 10, minutes: 5 };
  state.now += 20001;
  const next = await get();
  assert.equal(next.body.level, 'ok');
  assert.deepEqual(next.body.thresholds, state.thresholds);
  assert.equal((await get('/unknown')).code, 404);
});

test('keeps stale, demo, partial and malformed input distinct from a ready all-clear', async t => {
  const { state, get } = await harness(t);
  state.source.updatedAt = new Date(NOW - 90001).toISOString();
  assert.equal((await get()).body.availability, 'stale');
  state.now += 20001;
  state.source = snapshot([], { upstream: 'no-key', complete: false, updatedAt: new Date(state.now).toISOString() });
  const demo = await get();
  assert.equal(demo.code, 200);
  assert.equal(demo.body.availability, 'demo');
  assert.equal(demo.body.level, null);
  state.now += 20001;
  state.source = snapshot([row('a', 2)], { complete: false, updatedAt: new Date(state.now).toISOString() });
  assert.equal((await get()).body.availability, 'insufficient');
  state.now += 20001;
  state.malformed = true;
  const malformed = await get();
  assert.equal(malformed.code, 503);
  assert.equal(malformed.body.availability, 'unavailable');
  assert.ok(state.logs.length);
});

test('a hung dependency times out and never serves cached ready risk', async t => {
  const { state, get } = await harness(t, { timeoutMs: 50 });
  assert.equal((await get()).body.availability, 'ready');
  state.now += 20001;
  state.hang = true;
  const result = await get();
  assert.equal(result.code, 503);
  assert.equal(result.body.level, null);
  assert.equal(result.body.availability, 'unavailable');
  assert.ok(state.logs.length);
});

test('health reports idle without fetching and derives readiness/ages from cached state', async t => {
  const { state, get } = await harness(t);
  const idle = await get('/api/health');
  assert.equal(idle.code, 503);
  assert.equal(idle.body.ok, false);
  assert.equal(idle.body.snapshotAvailability, 'idle');
  assert.deepEqual(idle.body.source, { upstream: null, updatedAt: null, ageSeconds: null });
  assert.equal(idle.body.cache.ageSeconds, null);
  assert.deepEqual(idle.body.lastSnapshotFetch, { outcome: 'never', completedAt: null, errorCode: null });
  assert.equal(state.snapshotCalls, 0);
  assert.equal(state.settingsCalls, 0);

  state.source.updatedAt = new Date(NOW - 5000).toISOString();
  await get('/api/risk?displayId=private-display');
  state.now += 2500;
  const ready = await get('/api/health');
  assert.equal(ready.code, 200);
  assert.equal(ready.headers.get('cache-control'), 'no-store');
  assert.equal(ready.body.snapshotAvailability, 'ready');
  assert.equal(ready.body.source.ageSeconds, 7.5);
  assert.equal(ready.body.cache.ageSeconds, 2.5);
  assert.equal(ready.body.lastSnapshotFetch.outcome, 'ok');
  assert.equal(ready.body.displaySettings.entries, 1);
  assert.equal(state.snapshotCalls, 1);
  assert.equal(state.settingsCalls, 1);
  assert.ok(!JSON.stringify(ready.body).includes('private-display'));
  assert.ok(!JSON.stringify(ready.body).includes('"trainId"'));

  state.now = NOW + 90001;
  const stale = await get('/api/health');
  assert.equal(stale.code, 503);
  assert.equal(stale.body.snapshotAvailability, 'stale');
  assert.equal(stale.body.lastSnapshotFetch.outcome, 'ok');
  assert.equal(state.snapshotCalls, 1);
  assert.equal(state.settingsCalls, 1);
});

test('health distinguishes failed fetches from source quality and clears failures after recovery', async t => {
  const { state, get } = await harness(t);
  await get();
  state.now += 20001;
  state.failure = true;
  await get();
  const failed = await get('/api/health');
  assert.equal(failed.code, 503);
  assert.equal(failed.body.snapshotAvailability, 'unavailable');
  assert.equal(failed.body.lastSnapshotFetch.outcome, 'error');
  assert.equal(failed.body.lastSnapshotFetch.errorCode, 'CONTROLLER_FETCH_FAILED');
  assert.equal(failed.body.lastSnapshotFetch.completedAt, new Date(state.now).toISOString());
  assert.equal(failed.body.displaySettings.failedEntries, 1);
  assert.equal(state.snapshotCalls, 2);
  assert.equal(state.settingsCalls, 2);

  state.now += 20001;
  state.failure = false;
  state.source.updatedAt = new Date(state.now).toISOString();
  await get();
  const recovered = await get('/api/health');
  assert.equal(recovered.code, 200);
  assert.equal(recovered.body.lastSnapshotFetch.errorCode, null);
  assert.equal(recovered.body.displaySettings.failedEntries, 0);

  for (const [extra, availability] of [
    [{ upstream: 'no-key', complete: false }, 'demo'],
    [{ complete: false }, 'insufficient'],
    [{ upstream: 'error' }, 'unavailable'],
  ]) {
    state.now += 20001;
    state.source = snapshot(undefined, { ...extra, updatedAt: new Date(state.now).toISOString() });
    await get();
    const health = await get('/api/health');
    assert.equal(health.code, 503);
    assert.equal(health.body.snapshotAvailability, availability);
    assert.equal(health.body.lastSnapshotFetch.outcome, 'ok');
  }
});

test('health exposes an in-flight refresh without joining it or creating more requests', async t => {
  const { state, get } = await harness(t, { timeoutMs: 500 });
  state.hang = true;
  const risk = get();
  for (let i = 0; i < 100 && (state.snapshotCalls === 0 || state.settingsCalls === 0); i++) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(state.snapshotCalls, 1);
  assert.equal(state.settingsCalls, 1);
  const pending = await get('/api/health');
  assert.equal(pending.body.cache.refreshInFlight, true);
  assert.equal(pending.body.displaySettings.refreshesInFlight, 1);
  assert.equal(pending.body.snapshotAvailability, 'idle');
  assert.equal(state.snapshotCalls, 1);
  assert.equal(state.settingsCalls, 1);
  assert.equal((await risk).code, 503);
});

test('a settings-only failure is visible even with a healthy snapshot', async t => {
  const { state, get } = await harness(t);
  state.settingsFailure = true;
  await get();
  const failed = await get('/api/health');
  assert.equal(failed.code, 503);
  assert.equal(failed.body.snapshotAvailability, 'ready');
  assert.equal(failed.body.displaySettings.failedEntries, 1);
  assert.equal(failed.body.lastSnapshotFetch.outcome, 'ok');
  state.now += 20001;
  state.settingsFailure = false;
  state.source.updatedAt = new Date(state.now).toISOString();
  await get();
  assert.equal((await get('/api/health')).code, 200);
});
