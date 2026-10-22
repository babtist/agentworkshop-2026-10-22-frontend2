'use strict';
// babtist: the controller. One shared poll loop against Trafikverket, an in-memory model, per-display thresholds.
// Contract: projects/babtist/CONTRACT.md

const fs = require('fs');
const path = require('path');
const { Model, parseResponse, demoItems, validThresholds, DEFAULT_THRESHOLDS } = require('./model');

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_DISPLAYS = 500;
const MAX_STREAMS = 200;
const FULL_REFRESH_MS = 5 * 60 * 1000;
const POLL_MS = Math.max(5000, Number(process.env.BABTIST_POLL_MS) || 20000);
const UPSTREAM_URL = process.env.TRAFIKVERKET_URL || 'https://api.trafikinfo.trafikverket.se/v2/data.json';

const model = new Model();
const displays = new Map();
const streams = new Set();
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
  </QUERY>
</REQUEST>`;
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

function schedule(ms) {
  state.timer = setTimeout(async () => {
    try { await poll(); }
    catch (err) {
      state.upstream = 'error';
      state.changeId = null;
      console.error('[babtist] poll failed:', err && err.message);
    }
    try { broadcast(); } catch (err) { console.error('[babtist] broadcast:', err && err.message); }
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
  init(ctx) {
    state.displaysFile = path.join(ctx.dataDir, 'displays.json');
    try {
      const saved = JSON.parse(fs.readFileSync(state.displaysFile, 'utf8'));
      for (const [id, v] of Object.entries(saved)) if (ID_RE.test(id) && validThresholds(v)) displays.set(id, { trains: v.trains, minutes: v.minutes });
    } catch {}
    schedule(0);
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
