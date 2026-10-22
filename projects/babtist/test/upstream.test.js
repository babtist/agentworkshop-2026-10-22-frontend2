'use strict';
// Upstream failure and recovery through the HTTP API. Uses the _pollNow test hook instead of waiting for the timer.
// Run: node --test projects/babtist/test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const T0 = Math.floor(Date.now() / 60000) * 60000; // fixed, so repeated polls send identical rows
const minutesAgo = m => new Date(T0 - m * 60000).toISOString();
const ann = (id, advMin, delayMin) => ({
  AdvertisedTrainIdent: id, LocationSignature: 'Sci', ActivityType: 'Ankomst',
  AdvertisedTimeAtLocation: minutesAgo(advMin), TimeAtLocation: minutesAgo(advMin - delayMin),
});

let mode = 'ok';
const bodies = [];
const upstream = http.createServer((req, res) => {
  let b = '';
  req.on('data', c => { b += c; });
  req.on('end', () => {
    if (b.includes('objecttype="TrainPosition"')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ RESPONSE: { RESULT: [{ TrainPosition: [] }] } }));
    }
    if (b.includes('objecttype="TrainStation"')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ RESPONSE: { RESULT: [{ TrainStation: [{ LocationSignature: 'Sci', AdvertisedLocationName: 'Stockholm City', Geometry: { WGS84: 'POINT (18.0592 59.3307)' } }] }] } }));
    }
    bodies.push(b);
    if (mode === '500') { res.writeHead(500); return res.end('boom'); }
    res.setHeader('content-type', 'application/json');
    if (mode === 'badjson') return res.end('{"RESPONSE": not json');
    if (mode === 'apierror') return res.end(JSON.stringify({ RESPONSE: { RESULT: [{ ERROR: { MESSAGE: 'Invalid query' } }] } }));
    res.end(JSON.stringify({ RESPONSE: { RESULT: [{ TrainAnnouncement: [ann('1', 20, 7), ann('2', 15, 9), ann('3', 10, 12)], INFO: { LASTCHANGEID: 1234 } }] } }));
  });
});

const dataDir = path.join(__dirname, '.data-upstream-test');
let server, base, plugin;

test.before(async () => {
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  process.env.TRAFIKVERKET_URL = `http://127.0.0.1:${upstream.address().port}/v2/data.json`;
  process.env.TRAFIKVERKET_API_KEY = 'test-key-not-real';
  process.env.BABTIST_POSITION_POLL_MS = '600000'; // position rounds only via _pollPositionsNow
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

const status = async () => { const r = await fetch(base + '/api/status?displayId=f'); return { code: r.status, body: await r.json() }; };
const changeIdOf = b => /changeid="([^"]*)"/.exec(b)[1];

test('first poll is a full refresh and the numeric LASTCHANGEID is used next', async () => {
  assert.strictEqual(changeIdOf(bodies[0]), '0');
  const { body } = await status();
  assert.strictEqual(body.upstream, 'ok');
  assert.strictEqual(body.trainsTracked, 3);
  await plugin._pollNow();
  assert.strictEqual(changeIdOf(bodies.at(-1)), '1234');
});

for (const failure of ['500', 'badjson', 'apierror']) {
  test(`upstream ${failure}: status still 200, upstream "error", last good numbers kept, full refresh after recovery`, async () => {
    const { body: good } = await status();
    mode = failure;
    await plugin._pollNow();
    const { code, body } = await status();
    assert.strictEqual(code, 200);
    assert.strictEqual(body.upstream, 'error');
    assert.strictEqual(body.trainsTracked, good.trainsTracked);
    assert.strictEqual(body.lateCount, good.lateCount);
    assert.strictEqual(body.maxDelayMinutes, good.maxDelayMinutes);
    const snap = await (await fetch(base + '/api/snapshot')).json();
    assert.strictEqual(snap.complete, false);
    assert.strictEqual(snap.count, 3);

    mode = 'ok';
    await plugin._pollNow();
    assert.strictEqual(changeIdOf(bodies.at(-1)), '0', 'recovery poll must use changeid 0');
    assert.strictEqual((await status()).body.upstream, 'ok');
    await plugin._pollNow();
    assert.strictEqual(changeIdOf(bodies.at(-1)), '1234');
  });
}

test('the API key never reaches a response', async () => {
  for (const p of ['/api/status', '/api/snapshot', '/api/health', '/api/stations']) {
    const text = await (await fetch(base + p)).text();
    assert.ok(!text.includes('test-key-not-real'), p);
  }
});
