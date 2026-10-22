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
  const state = { now: NOW, snapshotCalls: 0, settingsCalls: 0, logs: [], failure: false, hang: false,
    malformed: false, thresholds: { trains: 1, minutes: 5 }, source: snapshot() };
  const controller = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const isSnapshot = url.pathname === '/t/babtist/api/snapshot';
    if (isSnapshot) state.snapshotCalls++;
    else state.settingsCalls++;
    if (state.hang) return;
    res.writeHead(state.failure ? 503 : 200, { 'content-type': 'application/json' });
    res.end(state.malformed ? '{invalid' : JSON.stringify(isSnapshot ? state.source :
      { displayId: url.searchParams.get('displayId'), thresholds: state.thresholds }));
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
