'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPlugin } = require('../../../board/plugins/frallan');

test('integrates with the real controller: isolated display settings and shared upstream polling', async t => {
  let upstreamCalls = 0;
  const now = Date.now();
  const time = minutes => new Date(now + minutes * 60000).toISOString();
  const upstream = http.createServer((req, res) => {
    upstreamCalls++;
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ RESPONSE: { RESULT: [{ TrainAnnouncement: Array.from({ length: 6 }, (_, i) => ({
      AdvertisedTrainIdent: `${100 + i}`, LocationSignature: 'Sci', ActivityType: 'Avgang',
      AdvertisedTimeAtLocation: time(2 + i), EstimatedTimeAtLocation: i === 0 ? time(10) : undefined,
      Canceled: false, ToLocation: [{ LocationName: 'Nyc', Priority: 1, Order: 0 }],
    })), TrainStation: [{ LocationSignature: 'Sci', AdvertisedLocationName: 'Stockholm City',
      Geometry: { WGS84: 'POINT (18.0592 59.3307)' } }], INFO: { LASTCHANGEID: '42' } }] } }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  process.env.TRAFIKVERKET_URL = `http://127.0.0.1:${upstream.address().port}/`;
  process.env.TRAFIKVERKET_API_KEY = 'local-fixture-not-a-real-key';
  process.env.BABTIST_POLL_MS = '60000';
  const babtist = require('../../../board/plugins/babtist');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frallan-integration-'));
  let frallan;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const owner = url.pathname.startsWith('/t/babtist/') ? 'babtist' : 'frallan';
    const plugin = owner === 'babtist' ? babtist : frallan;
    if (!await plugin.handle(req, res, { path: url.pathname.replace(`/t/${owner}`, ''), url })) {
      res.writeHead(404); res.end('{}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.all([server, upstream].map(s => new Promise(resolve => {
      s.closeAllConnections();
      s.close(resolve);
    })));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  frallan = createPlugin({ controllerUrl: base + '/t/babtist/' });
  babtist.init({ dataDir });
  // Let the controller's initial scheduled poll finish before observing its counters.
  for (let i = 0; i < 100; i++) {
    const status = await (await fetch(base + '/t/babtist/api/status')).json();
    if (status.upstream === 'ok') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  for (const [id, trains] of [['strict', 1], ['relaxed', 10]]) {
    const response = await fetch(`${base}/t/babtist/api/displays/${id}`, {
      method: 'PUT', body: JSON.stringify({ trains, minutes: 5 }),
    });
    assert.equal(response.status, 200);
  }
  const before = upstreamCalls;
  const get = async id => {
    const response = await fetch(`${base}/t/frallan/api/risk?displayId=${id}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const strict = await get('strict');
  assert.equal(strict.upstream, 'ok');
  assert.equal(strict.availability, 'ready');
  assert.equal(strict.affectedTrainCount, 5);
  assert.equal(strict.level, 'severe');
  assert.equal((await get('relaxed')).level, 'ok');
  const defaults = await Promise.all(Array.from({ length: 20 }, (_, i) => get(`smoke-${i}`)));
  assert.ok(defaults.every(result => result.level === 'warning' && result.thresholds.trains === 3));
  const trends = await Promise.all(Array.from({ length: 20 }, () =>
    fetch(`${base}/t/frallan/api/trend?displayId=strict`).then(response => response.json())));
  assert.ok(trends.every(result => result.availability === 'warming-up' &&
    result.points.length === 1 && result.points[0].lateCount === 1 && result.delta === null));
  assert.equal((await get('strict')).level, 'severe');
  assert.equal(upstreamCalls, before);
  assert.ok(!JSON.stringify(strict).includes('local-fixture'));
});
