'use strict';
// babtist: the controller. One shared poll loop against Trafikverket, an in-memory model, per-display thresholds.
// Contract: projects/babtist/CONTRACT.md

const fs = require('fs');
const path = require('path');
const { Model, parseResponse, parseStations, parsePositions, demoItems, validThresholds, DEFAULT_THRESHOLDS } = require('./model');

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_DISPLAYS = 500;
const MAX_STREAMS = 200;
const FULL_REFRESH_MS = 5 * 60 * 1000;
const POLL_MS = Math.max(5000, Number(process.env.BABTIST_POLL_MS) || 20000);
const POSITION_POLL_MS = Math.max(5000, Number(process.env.BABTIST_POSITION_POLL_MS) || 10000);
const POSITION_MAX_AGE_MS = 5 * 60 * 1000;
const TRAIN_RE = /^[A-Za-z0-9]{1,10}$/;
const STATION_RE = /^[A-Za-z0-9åäöÅÄÖ ]{1,10}$/;
const STATIONS_RETRY_MS = 10 * 60 * 1000;
const STATIONS_REFRESH_MS = 24 * 60 * 60 * 1000;
// Demo mode has no key, so no station list: keep one known marker so map UIs have something to draw.
const FALLBACK_STATIONS = new Map([['Sci', { name: 'Stockholm City', lat: 59.3307, lon: 18.0592 }]]);
const UPSTREAM_URL = process.env.TRAFIKVERKET_URL || 'https://api.trafikinfo.trafikverket.se/v2/data.json';

const model = new Model();
const displays = new Map();
const streams = new Set();
const stations = { coords: new Map(), loadedAt: 0, attemptAt: 0 };
// Latest position per tracked train number: train -> { lat, lon, bearing, at (ms) }.
const positions = new Map();
const posState = { upstream: 'no-key', updatedAt: null, timer: null };
const state = { upstream: 'no-key', lastPollAt: null, changeId: null, lastFullAt: 0, updatedAt: new Date().toISOString(), displaysFile: null, timer: null, ping: null };

function loadKey() {
  if (process.env.TRAFIKVERKET_API_KEY) return process.env.TRAFIKVERKET_API_KEY.trim();
  const roots = [path.join(__dirname, '..', '..', '..'), path.join(__dirname, '..', '..', '..', 'projects', 'babtist')];
  for (const root of roots) {
    try {
      const m = /^\s*TRAFIKVERKET_API_KEY\s*=\s*(.+?)\s*$/m.exec(fs.readFileSync(path.join(root, '.env'), 'utf8'));
      if (m) return m[1].replace(/^["']|["']$/g, '');
    } catch {}
  }
  return null;
}

function buildQuery(key, changeId) {
  return `<REQUEST>
  <LOGIN authenticationkey="${key}"/>
  <QUERY objecttype="TrainAnnouncement" namespace="Rail.TrafficInfo" schemaversion="2.0" changeid="${changeId || '0'}" limit="5000">
    <FILTER>
      <AND>
        <EQ name="ProductInformation.Description" value="SL Pendeltåg"/>
        <GT name="AdvertisedTimeAtLocation" value="$dateadd(-0.01:00)"/>
        <LT name="AdvertisedTimeAtLocation" value="$dateadd(0.00:30)"/>
      </AND>
    </FILTER>
    <INCLUDE>AdvertisedTrainIdent</INCLUDE>
    <INCLUDE>LocationSignature</INCLUDE>
    <INCLUDE>ActivityType</INCLUDE>
    <INCLUDE>AdvertisedTimeAtLocation</INCLUDE>
    <INCLUDE>EstimatedTimeAtLocation</INCLUDE>
    <INCLUDE>TimeAtLocation</INCLUDE>
    <INCLUDE>Canceled</INCLUDE>
    <INCLUDE>ToLocation</INCLUDE>
  </QUERY>
</REQUEST>`;
}

function buildStationQuery(key) {
  return `<REQUEST>
  <LOGIN authenticationkey="${key}"/>
  <QUERY objecttype="TrainStation" namespace="rail.infrastructure" schemaversion="1.5">
    <FILTER>
      <EQ name="Advertised" value="true"/>
    </FILTER>
    <INCLUDE>LocationSignature</INCLUDE>
    <INCLUDE>AdvertisedLocationName</INCLUDE>
    <INCLUDE>Geometry.WGS84</INCLUDE>
  </QUERY>
</REQUEST>`;
}

function buildPositionQuery(key, trains) {
  return `<REQUEST>
  <LOGIN authenticationkey="${key}"/>
  <QUERY objecttype="TrainPosition" namespace="järnväg.trafikinfo" schemaversion="1.1">
    <FILTER>
      <AND>
        <IN name="Train.AdvertisedTrainNumber" value="${trains.join(',')}"/>
        <GT name="TimeStamp" value="$dateadd(-0.00:05)"/>
      </AND>
    </FILTER>
    <INCLUDE>Train.AdvertisedTrainNumber</INCLUDE>
    <INCLUDE>Position.WGS84</INCLUDE>
    <INCLUDE>TimeStamp</INCLUDE>
    <INCLUDE>Bearing</INCLUDE>
    <INCLUDE>Deleted</INCLUDE>
  </QUERY>
</REQUEST>`;
}

function prunePositions(tracked, now = Date.now()) {
  for (const [train, p] of positions) {
    if (now - p.at > POSITION_MAX_AGE_MS || !tracked.has(train)) positions.delete(train);
  }
}

// Only the trains the model tracks are asked for; no tracked trains means no upstream call.
async function pollPositions() {
  const key = loadKey();
  if (!key) {
    positions.clear();
    posState.upstream = 'no-key';
    posState.updatedAt = new Date().toISOString();
    return;
  }
  const tracked = model.trackedTrains();
  const trains = [...tracked].filter(t => TRAIN_RE.test(t)).sort();
  if (trains.length === 0) {
    prunePositions(tracked);
    posState.upstream = 'ok';
    posState.updatedAt = new Date().toISOString();
    return;
  }
  const res = await fetch(UPSTREAM_URL, {
    method: 'POST',
    headers: { 'content-type': 'text/xml' },
    body: buildPositionQuery(key, trains),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('upstream HTTP ' + res.status);
  for (const p of parsePositions(await res.json())) {
    const cur = positions.get(p.train);
    if (cur && cur.at > p.at) continue;
    if (p.deleted) positions.delete(p.train);
    else positions.set(p.train, { lat: p.lat, lon: p.lon, bearing: p.bearing, at: p.at });
  }
  prunePositions(tracked);
  posState.upstream = 'ok';
  posState.updatedAt = new Date().toISOString();
}

// One position round. Never throws: a failed round keeps the last positions (they age out after 5 min).
async function positionTick() {
  try { await pollPositions(); }
  catch (err) {
    posState.upstream = 'error';
    console.error('[babtist] position poll failed:', err && err.message);
  }
}

function schedulePositions(ms) {
  posState.timer = setTimeout(async () => {
    try { await positionTick(); } catch (err) { console.error('[babtist] position tick:', err && err.message); }
    schedulePositions(POSITION_POLL_MS);
  }, ms);
  if (posState.timer.unref) posState.timer.unref();
}

function trainsBody(now = Date.now()) {
  const info = model.trainsInfo(now);
  const trains = [];
  for (const train of [...positions.keys()].sort()) {
    const p = positions.get(train);
    const t = info.get(train);
    if (!t || now - p.at > POSITION_MAX_AGE_MS) continue;
    const last = t.lastStation, next = t.nextStation;
    trains.push({
      trainId: t.trainId,
      train,
      lat: p.lat,
      lon: p.lon,
      bearing: p.bearing,
      positionAt: new Date(p.at).toISOString(),
      delayMinutes: t.delayMinutes,
      canceled: t.canceled,
      to: t.to,
      lastStation: last ? { station: last.station, name: stationInfo(last.station).name, at: last.at } : null,
      nextStation: next ? { station: next.station, name: stationInfo(next.station).name, scheduled: next.scheduled, estimated: next.estimated } : null,
    });
  }
  return { updatedAt: posState.updatedAt || state.updatedAt, upstream: posState.upstream, count: trains.length, trains };
}

// Station names and coordinates change rarely: fetch once, retry at most every 10 min, refresh at most every 24 h.
async function refreshStations(now = Date.now()) {
  const key = loadKey();
  if (!key) return;
  if (stations.loadedAt && now - stations.loadedAt < STATIONS_REFRESH_MS) return;
  if (stations.attemptAt && now - stations.attemptAt < STATIONS_RETRY_MS) return;
  stations.attemptAt = now;
  const res = await fetch(UPSTREAM_URL, {
    method: 'POST',
    headers: { 'content-type': 'text/xml' },
    body: buildStationQuery(key),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('upstream HTTP ' + res.status);
  const coords = parseStations(await res.json());
  if (coords.size === 0) throw new Error('empty station list');
  stations.coords = coords;
  stations.loadedAt = Date.now();
}

function stationInfo(sig) {
  return stations.coords.get(sig) || FALLBACK_STATIONS.get(sig) || { name: sig, lat: null, lon: null };
}

function stationsBody(id) {
  const thresholds = thresholdsOf(id);
  return {
    displayId: id,
    updatedAt: state.updatedAt,
    upstream: state.upstream,
    thresholds,
    stations: model.stationsFor(thresholds).map(s => {
      const info = stationInfo(s.station);
      return { station: s.station, name: info.name, lat: info.lat, lon: info.lon, lateCount: s.lateCount, canceledCount: s.canceledCount, level: s.level };
    }),
  };
}

function nextBody(sig, limit, now = Date.now()) {
  const trains = model.nextAt(sig, now, limit).map(t => ({
    ...t,
    to: t.to.map(s => ({ station: s, name: stationInfo(s).name })),
  }));
  return { station: sig, name: stationInfo(sig).name, updatedAt: state.updatedAt, upstream: state.upstream, count: trains.length, trains };
}

async function poll() {
  const key = loadKey();
  if (!key) {
    model.apply(demoItems(), { full: true });
    state.upstream = 'no-key';
  } else {
    const full = !state.changeId || Date.now() - state.lastFullAt > FULL_REFRESH_MS;
    const res = await fetch(UPSTREAM_URL, {
      method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: buildQuery(key, full ? '0' : state.changeId),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error('upstream HTTP ' + res.status);
    const { items, lastChangeId } = parseResponse(await res.json());
    model.apply(items, { full });
    if (lastChangeId) state.changeId = lastChangeId;
    if (full) state.lastFullAt = Date.now();
    state.upstream = 'ok';
  }
  state.lastPollAt = new Date().toISOString();
  state.updatedAt = state.lastPollAt;
}

// One poll round. Never throws: a failed poll keeps the last good model and forces a full refresh next time.
async function tick() {
  try { await poll(); }
  catch (err) {
    state.upstream = 'error';
    state.changeId = null;
    console.error('[babtist] poll failed:', err && err.message);
  }
  try { broadcast(); } catch (err) { console.error('[babtist] broadcast:', err && err.message); }
  try { await refreshStations(); } catch (err) { console.error('[babtist] station list failed:', err && err.message); }
}

function schedule(ms) {
  state.timer = setTimeout(async () => {
    try { await tick(); } catch (err) { console.error('[babtist] tick:', err && err.message); }
    schedule(POLL_MS);
  }, ms);
  if (state.timer.unref) state.timer.unref();
}

function thresholdsOf(id) {
  const d = displays.get(id);
  return d ? { trains: d.trains, minutes: d.minutes } : { ...DEFAULT_THRESHOLDS };
}

function statusBody(id) {
  return { displayId: id, ...model.statusFor(thresholdsOf(id)), updatedAt: state.updatedAt, upstream: state.upstream };
}

function sendEvent(s, id) {
  s.res.write(`event: status\ndata: ${JSON.stringify(statusBody(id))}\n\n`);
}

function broadcast(onlyId) {
  for (const s of streams) {
    if (onlyId && s.id !== onlyId) continue;
    try { sendEvent(s, s.id); } catch { streams.delete(s); }
  }
}

function persistDisplays() {
  if (!state.displaysFile) return;
  try {
    const tmp = state.displaysFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(displays)));
    fs.renameSync(tmp, state.displaysFile);
  } catch (err) { console.error('[babtist] could not save displays:', err.message); }
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}

function readBody(req, limit = 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on('end', () => (size > limit ? reject(new Error('body too large')) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

module.exports = {
  // Test hook: run one poll round now. Not part of the HTTP contract.
  _pollNow: tick,
  // Test hook: run one position round now. Not part of the HTTP contract.
  _pollPositionsNow: positionTick,

  init(ctx) {
    state.displaysFile = path.join(ctx.dataDir, 'displays.json');
    try {
      const saved = JSON.parse(fs.readFileSync(state.displaysFile, 'utf8'));
      for (const [id, v] of Object.entries(saved)) if (ID_RE.test(id) && validThresholds(v)) displays.set(id, { trains: v.trains, minutes: v.minutes });
    } catch {}
    schedule(0);
    schedulePositions(POSITION_POLL_MS);
    state.ping = setInterval(() => {
      for (const s of streams) { try { s.res.write(': ping\n\n'); } catch { streams.delete(s); } }
    }, 25000);
    if (state.ping.unref) state.ping.unref();
  },

  async handle(req, res, ctx) {
    const p = ctx.path.replace(/\/+$/, '') || '/';
    const params = ctx.url.searchParams;

    if (req.method === 'GET' && p === '/api/health') {
      return json(res, 200, { ok: true, upstream: state.upstream, trainsTracked: model.statusFor(DEFAULT_THRESHOLDS).trainsTracked, displays: displays.size, streams: streams.size, lastPollAt: state.lastPollAt });
    }

    if (req.method === 'GET' && p === '/api/snapshot') {
      const announcements = model.snapshot();
      return json(res, 200, {
        generatedAt: new Date().toISOString(),
        updatedAt: state.updatedAt,
        upstream: state.upstream,
        complete: state.upstream === 'ok',
        window: { pastMinutes: 60, futureMinutes: 30 },
        count: announcements.length,
        announcements,
      });
    }

    if (req.method === 'GET' && p === '/api/trains') return json(res, 200, trainsBody());

    if (req.method === 'GET' && p === '/api/stations') {
      const id = params.get('displayId') || 'default';
      if (!ID_RE.test(id)) return json(res, 400, { error: 'displayId must match [A-Za-z0-9_-]{1,40}' });
      return json(res, 200, stationsBody(id));
    }

    const sm = /^\/api\/stations\/([^/]+)\/next$/.exec(p);
    if (req.method === 'GET' && sm) {
      let sig;
      try { sig = decodeURIComponent(sm[1]); } catch { sig = null; }
      if (!sig || !STATION_RE.test(sig)) return json(res, 400, { error: 'station must be a station signature (letters, digits, space; at most 10)' });
      const raw = params.get('limit');
      const limit = raw == null || raw === '' ? 10 : /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(limit) || limit < 1 || limit > 30) return json(res, 400, { error: 'limit must be an integer 1..30' });
      return json(res, 200, nextBody(sig, limit));
    }

    if (req.method === 'GET' && (p === '/api/status' || p === '/api/stream')) {
      const id = params.get('displayId') || 'default';
      if (!ID_RE.test(id)) return json(res, 400, { error: 'displayId must match [A-Za-z0-9_-]{1,40}' });
      if (p === '/api/status') return json(res, 200, statusBody(id));
      if (streams.size >= MAX_STREAMS) return json(res, 429, { error: 'too many streams' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      const s = { res, id };
      streams.add(s);
      req.on('close', () => streams.delete(s));
      sendEvent(s, id);
      return true;
    }

    const m = /^\/api\/displays\/([^/]+)$/.exec(p);
    if (m) {
      const id = m[1];
      if (!ID_RE.test(id)) return json(res, 400, { error: 'id must match [A-Za-z0-9_-]{1,40}' });
      if (req.method === 'GET') {
        const d = displays.get(id);
        return d ? json(res, 200, { id, ...d }) : json(res, 404, { error: 'unknown display' });
      }
      if (req.method === 'DELETE') {
        const existed = displays.delete(id);
        if (existed) { persistDisplays(); broadcast(id); }
        return json(res, 200, { deleted: existed });
      }
      if (req.method === 'PUT') {
        let body;
        try { body = JSON.parse(await readBody(req)); }
        catch { return json(res, 400, { error: 'body must be JSON, at most 1 KB' }); }
        if (!validThresholds(body)) return json(res, 400, { error: 'trains: integer 1..100, minutes: integer 1..240' });
        if (!displays.has(id) && displays.size >= MAX_DISPLAYS) return json(res, 429, { error: 'too many displays' });
        displays.set(id, { trains: body.trains, minutes: body.minutes });
        persistDisplays();
        broadcast(id);
        return json(res, 200, { id, trains: body.trains, minutes: body.minutes });
      }
    }
    return false;
  },
};
