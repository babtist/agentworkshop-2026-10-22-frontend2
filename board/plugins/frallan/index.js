'use strict';

const { analyze, validThresholds } = require('./risk');
const { Trend, WINDOW_MS } = require('./trend');

const CACHE_MS = 20000;
const MAX_DISPLAYS = 500;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const INVALID_ID_CHAR = /[^A-Za-z0-9_-]/;

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}

function createPlugin({
  controllerUrl = process.env.FRALLAN_CONTROLLER_URL || `http://127.0.0.1:${process.env.PORT || 8180}/t/babtist/`,
  fetchImpl = fetch, now = Date.now, log = message => console.error('[frallan]', message), timeoutMs = 5000,
} = {}) {
  const base = new URL(controllerUrl.endsWith('/') ? controllerUrl : controllerUrl + '/');
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('FRALLAN_CONTROLLER_URL must be an HTTP(S) base URL without credentials, query or fragment');
  }
  const snapshot = { at: -Infinity, value: null, pending: null, outcome: 'never', errorCode: null };
  const displays = new Map();

  async function readJson(route) {
    const response = await fetchImpl(new URL(route, base), { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!response.ok) throw new Error(`Controller ${route.split('?')[0]} HTTP ${response.status}`);
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Controller response is not JSON');
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Controller response exceeds 2 MiB');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  async function cached(entry, route, validate) {
    if (entry.pending) return entry.pending;
    if (now() - entry.at < CACHE_MS) return entry.value;
    entry.pending = (async () => {
      try {
        const value = await readJson(route);
        if (!validate(value)) throw new Error(`Invalid controller ${route.split('?')[0]} response`);
        entry.value = value;
        entry.outcome = 'ok';
        entry.errorCode = null;
      } catch (error) {
        entry.value = null;
        entry.outcome = 'error';
        entry.errorCode = 'CONTROLLER_FETCH_FAILED';
        log(error.message);
      } finally {
        entry.at = now();
        entry.pending = null;
      }
      return entry.value;
    })();
    return entry.pending;
  }

  function displayEntry(id) {
    const accessedAt = now();
    for (const [key, entry] of displays) {
      if (!entry.pending && accessedAt - entry.usedAt > WINDOW_MS) displays.delete(key);
      else entry.trend?.prune(accessedAt);
    }
    if (displays.has(id)) {
      const entry = displays.get(id);
      entry.usedAt = accessedAt;
      return entry;
    }
    if (displays.size >= MAX_DISPLAYS) {
      const evict = [...displays].find(([, entry]) => !entry.pending);
      if (!evict) {
        log('Display settings cache is busy');
        return null;
      }
      displays.delete(evict[0]);
    }
    const entry = { at: -Infinity, value: null, pending: null, outcome: 'never', errorCode: null, usedAt: accessedAt, trend: null };
    displays.set(id, entry);
    return entry;
  }

  function health() {
    const checkedAt = now();
    const source = analyze(snapshot.value, { trains: 1, minutes: 1 }, { now: checkedAt });
    const snapshotAvailability = snapshot.outcome === 'never' ? 'idle' : source.availability;
    const settings = [...displays.values()];
    const failedEntries = settings.filter(entry => entry.outcome === 'error' && checkedAt - entry.at < CACHE_MS).length;
    return {
      ok: snapshotAvailability === 'ready' && failedEntries === 0,
      checkedAt: source.evaluatedAt,
      snapshotAvailability,
      source: {
        upstream: source.upstream,
        updatedAt: source.sourceUpdatedAt,
        ageSeconds: source.sourceUpdatedAt === null ? null : (checkedAt - Date.parse(source.sourceUpdatedAt)) / 1000,
      },
      cache: {
        ageSeconds: Number.isFinite(snapshot.at) ? (checkedAt - snapshot.at) / 1000 : null,
        ttlSeconds: CACHE_MS / 1000,
        refreshInFlight: snapshot.pending !== null,
      },
      lastSnapshotFetch: {
        outcome: snapshot.outcome,
        completedAt: Number.isFinite(snapshot.at) ? new Date(snapshot.at).toISOString() : null,
        errorCode: snapshot.errorCode,
      },
      displaySettings: {
        entries: settings.length,
        refreshesInFlight: settings.filter(entry => entry.pending !== null).length,
        failedEntries,
      },
    };
  }

  return {
    async handle(req, res, ctx) {
      const path = ctx.path.replace(/\/+$/, '') || '/';
      if (req.method === 'GET' && path === '/api/health') {
        const body = health();
        return json(res, body.ok ? 200 : 503, body);
      }
      if (req.method !== 'GET' || !['/api/risk', '/api/trend'].includes(path)) return false;
      const id = ctx.url.searchParams.get('displayId') ?? 'default';
      if (!id.length || id.length > 40 || INVALID_ID_CHAR.test(id) || ctx.url.searchParams.getAll('displayId').length > 1) {
        return json(res, 400, { error: 'Invalid displayId' });
      }
      const entry = displayEntry(id);
      if (path === '/api/trend') {
        const settings = entry ? await cached(entry, `api/status?displayId=${encodeURIComponent(id)}`,
          value => value?.displayId === id && validThresholds(value.thresholds)) : null;
        if (entry && !entry.trend) entry.trend = new Trend();
        const body = (entry?.trend ?? new Trend()).read(settings, {
          displayId: id, now: now(), attemptAt: entry?.at ?? now(),
        });
        if (body.availability === 'unavailable' && settings) log('Trend status schema or source health is unavailable');
        return json(res, ['stale', 'unavailable'].includes(body.availability) ? 503 : 200, body);
      }
      const [source, settings] = await Promise.all([
        cached(snapshot, 'api/snapshot', value => value !== null && typeof value === 'object' && !Array.isArray(value)),
        entry ? cached(entry, `api/status?displayId=${encodeURIComponent(id)}`,
          value => value?.displayId === id && validThresholds(value.thresholds)) : null,
      ]);
      const body = analyze(source, settings?.thresholds, { displayId: id, now: now() });
      if (body.availability === 'unavailable' && source && settings) log('Snapshot schema or source health is unavailable');
      const code = ['unavailable', 'stale'].includes(body.availability) ? 503 : 200;
      return json(res, code, body);
    },
  };
}

module.exports = createPlugin();
module.exports.createPlugin = createPlugin;
