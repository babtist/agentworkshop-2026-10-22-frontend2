'use strict';
// Run: node --test projects/babtist/test/
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const minutesAgo = m => new Date(Date.now() - m * 60000).toISOString();
const ann = (id, advMin, delayMin, extra = {}) => ({
  AdvertisedTrainIdent: id, LocationSignature: 'Sci', ActivityType: 'Ankomst',
  AdvertisedTimeAtLocation: minutesAgo(advMin), TimeAtLocation: minutesAgo(advMin - delayMin), ...extra,
});

let upstreamCalls = 0;
let lastBody = '';
const upstream = http.createServer((req, res) => {
  upstreamCalls++;
  let b = '';
  req.on('data', c => { b += c; });
  req.on('end', () => {
    lastBody = b;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ RESPONSE: { RESULT: [{ TrainAnnouncement: [
      ann('1', 20, 7), ann('2', 15, 9), ann('3', 10, 12), ann('4', 8, 0), ann('5', 5, 0, { Canceled: true, TimeAtLocation: undefined }),
    ], INFO: { LASTCHANGEID: '42' } }] } }));
  });
});

let server, base, plugin;

test.before(async () => {
  await new Promise(r => upstream.listen(0, r));
  process.env.TRAFIKVERKET_URL = `http://127.0.0.1:${upstream.address().port}/v2/data.json`;
  process.env.TRAFIKVERKET_API_KEY = 'test-key-not-real';
  process.env.BABTIST_POLL_MS = '60000';
  plugin = require('../../../board/plugins/babtist/index.js');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'babtist-'));
  plugin.init({ dataDir });
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    plugin.handle(req, res, { path: url.pathname.replace('/t/babtist', ''), url }).then(h => { if (!h) { res.writeHead(404); res.end('{}'); } });
  });
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/t/babtist`;
  await new Promise(r => setTimeout(r, 300));
});

test.after(() => { server.closeAllConnections(); server.close(); upstream.close(); });

const get = async p => { const r = await fetch(base + p); return { code: r.status, body: await r.json() }; };

test('status uses default thresholds and sends the key only upstream', async () => {
  const { code, body } = await get('/api/status?displayId=a');
  assert.strictEqual(code, 200);
  assert.strictEqual(body.upstream, 'ok');
  assert.strictEqual(body.trainsTracked, 5);
  assert.strictEqual(body.canceledCount, 1);
  assert.strictEqual(body.maxDelayMinutes, 12);
  assert.strictEqual(body.lateCount, 3);
  assert.strictEqual(body.level, 'warning');
  assert.ok(!JSON.stringify(body).includes('test-key'));
  assert.ok(lastBody.includes('SL Pendeltåg'));
});

test('thresholds are per display', async () => {
  let r = await fetch(base + '/api/displays/strict', { method: 'PUT', body: JSON.stringify({ trains: 1, minutes: 8 }) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await get('/api/status?displayId=strict')).body.level, 'severe');
  r = await fetch(base + '/api/displays/relaxed', { method: 'PUT', body: JSON.stringify({ trains: 10, minutes: 30 }) });
  assert.strictEqual((await get('/api/status?displayId=relaxed')).body.level, 'ok');
  assert.strictEqual((await get('/api/status?displayId=a')).body.level, 'warning');
  assert.strictEqual((await get('/api/displays/strict')).body.minutes, 8);
});

test('bad input is rejected', async () => {
  assert.strictEqual((await get('/api/status?displayId=bad%20id')).code, 400);
  const r = await fetch(base + '/api/displays/x', { method: 'PUT', body: JSON.stringify({ trains: 0, minutes: 5 }) });
  assert.strictEqual(r.status, 400);
  const r2 = await fetch(base + '/api/displays/x', { method: 'PUT', body: 'x'.repeat(5000) });
  assert.strictEqual(r2.status, 400);
  assert.strictEqual((await get('/api/displays/never')).code, 404);
});

test('many clients cause no extra upstream calls, and SSE delivers a status event', async () => {
  const before = upstreamCalls;
  await Promise.all(Array.from({ length: 20 }, (_, i) => get(`/api/status?displayId=d${i}`)));
  const ctl = new AbortController();
  const r = await fetch(base + '/api/stream?displayId=strict', { signal: ctl.signal });
  const reader = r.body.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  ctl.abort();
  assert.match(text, /^event: status\ndata: \{.*"displayId":"strict"/);
  assert.strictEqual(upstreamCalls, before);
});

test('health', async () => {
  const { body } = await get('/api/health');
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.trainsTracked, 5);
});
