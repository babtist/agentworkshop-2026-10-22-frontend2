'use strict';
// babtist: Stockholm metro (Tunnelbanan) from SL's open Transport and Deviations APIs (no key, fair use).
// One shared, paced loop: exactly one SL call per step, round-robin over the metro stations. Clients never cause calls.
// Contract: projects/babtist/CONTRACT.md, section "Tunnelbanan (metro)".

const { DEFAULT_THRESHOLDS } = require('./model');

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const SITE_RE = /^\d{1,7}$/;
const PAST_KEEP_MS = 15 * 60 * 1000;
const NEXT_OVERDUE_MS = 60 * 1000;
const COVERED_MS = 5 * 60 * 1000;
const LISTS_REFRESH_MS = 24 * 60 * 60 * 1000;
const LISTS_RETRY_MS = 10 * 60 * 1000;
const DEVIATIONS_MS = 60 * 1000;
const BACKOFF_BASE_MS = 60 * 1000;
const BACKOFF_MAX_MS = 10 * 60 * 1000;
const CANCELED_STATES = new Set(['CANCELLED', 'INHIBITED', 'REPLACED']);
// The metro lines always listed by /api/metro/lines, even when no train is seen (night).
const KNOWN_LINES = [
  ['10', 'Tunnelbanans blå linje'], ['11', 'Tunnelbanans blå linje'],
  ['13', 'Tunnelbanans röda linje'], ['14', 'Tunnelbanans röda linje'],
  ['17', 'Tunnelbanans gröna linje'], ['18', 'Tunnelbanans gröna linje'], ['19', 'Tunnelbanans gröna linje'],
];
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };

const iso = ms => (ms == null ? null : new Date(ms).toISOString());

const wallFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

// Instant -> Stockholm wall clock "YYYY-MM-DDTHH:mm:ss" (the format SL uses for scheduled/expected).
function toStockholmLocal(ms) {
  const p = {};
  for (const x of wallFmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

// SL local time without zone -> epoch ms. Strings with a zone are parsed as is. In the autumn hour that occurs
// twice the earlier instant (summer time) wins; a spring-forward time that does not exist is read as winter time.
function stockholmToMs(s) {
  if (typeof s !== 'string') return null;
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(s)) { const ms = Date.parse(s); return Number.isNaN(ms) ? null : ms; }
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3})\d*)?$/.exec(s);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const want = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}`;
  const frac = m[7] ? Number(m[7].padEnd(3, '0')) : 0;
  for (const offH of [2, 1]) {
    const ms = wall - offH * 3600000;
    if (toStockholmLocal(ms) === want) return ms + frac;
  }
  return wall - 3600000 + frac;
}

function lineColor(group) {
  const g = String(group || '').toLowerCase();
  if (g.includes('blå')) return 'blue';
  if (g.includes('röd')) return 'red';
  if (g.includes('grön')) return 'green';
  return null;
}

const cleanText = s => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

// One SL departures response -> [{ journeyId, line, group, destination, scheduled, expected (ms), state, canceled,
// platform, deviations }]. Throws on a shape that is not a departures response.
function parseDepartures(json) {
  if (!json || !Array.isArray(json.departures)) throw new Error('unexpected departures shape');
  const out = [];
  for (const d of json.departures) {
    if (!d || !d.line || (d.line.transport_mode && d.line.transport_mode !== 'METRO')) continue;
    const scheduled = stockholmToMs(d.scheduled);
    const expected = stockholmToMs(d.expected);
    if (scheduled == null && expected == null) continue;
    const state = typeof d.state === 'string' ? d.state : null;
    out.push({
      journeyId: d.journey && d.journey.id != null ? String(d.journey.id) : null,
      line: d.line.designation != null ? String(d.line.designation) : null,
      group: typeof d.line.group_of_lines === 'string' ? d.line.group_of_lines : null,
      destination: typeof d.destination === 'string' ? d.destination : null,
      scheduled: scheduled != null ? scheduled : expected,
      expected: expected != null ? expected : scheduled,
      state,
      canceled: CANCELED_STATES.has(state),
      platform: d.stop_point && d.stop_point.designation != null && d.stop_point.designation !== '' ? String(d.stop_point.designation) : null,
      deviations: Array.isArray(d.deviations) ? [...new Set(d.deviations.map(v => cleanText(v && v.message)).filter(Boolean))] : [],
    });
  }
  return out;
}

const delayOf = d => {
  const s = Math.max(0, Math.round((d.expected - d.scheduled) / 1000));
  // Same rounding as the commuter routes (round to nearest minute), so "minutes" thresholds mean the same thing.
  return { delaySeconds: s, delayMinutes: Math.round(s / 60) };
};

// stop-points + sites?expand=true -> [{ siteId, name, lat, lon }], one site per METROSTN stop area: the site whose
// name equals the stop area's name; if none does, the only site that contains the stop area; else none.
function metroSites(stopPoints, sites) {
  if (!Array.isArray(stopPoints) || !Array.isArray(sites)) throw new Error('unexpected station list shape');
  const areas = new Map();
  for (const p of stopPoints) if (p && p.stop_area && p.stop_area.type === 'METROSTN') areas.set(p.stop_area.id, p.stop_area.name);
  const byArea = new Map();
  for (const s of sites) {
    if (!s || !Number.isInteger(s.id) || !Array.isArray(s.stop_areas)) continue;
    for (const a of s.stop_areas) if (areas.has(a)) { if (!byArea.has(a)) byArea.set(a, []); byArea.get(a).push(s); }
  }
  const norm = v => String(v || '').trim().toLowerCase();
  const out = new Map();
  for (const [area, name] of areas) {
    const cands = (byArea.get(area) || []).sort((a, b) => a.id - b.id);
    const pick = cands.find(s => norm(s.name) === norm(name)) || (cands.length === 1 ? cands[0] : null);
    if (!pick || out.has(pick.id)) continue;
    out.set(pick.id, { siteId: pick.id, name: pick.name, lat: typeof pick.lat === 'number' ? pick.lat : null, lon: typeof pick.lon === 'number' ? pick.lon : null });
  }
  return [...out.values()].sort((a, b) => a.siteId - b.siteId);
}

// SL importance_level (higher = more important): 7..9 high, 4..6 normal, 0..3 low. Missing -> normal.
function priorityOf(p) {
  const lvl = p && Number.isFinite(p.importance_level) ? p.importance_level : null;
  if (lvl == null) return 'normal';
  return lvl >= 7 ? 'high' : lvl >= 4 ? 'normal' : 'low';
}

// Deviations messages -> [{ id, header, text, priority, lines, stations, start, end (ms) }].
function parseDeviations(json) {
  if (!Array.isArray(json)) throw new Error('unexpected deviations shape');
  const out = [];
  for (const m of json) {
    if (!m || !Array.isArray(m.message_variants)) continue;
    const v = m.message_variants.find(x => x && x.language === 'sv') || m.message_variants[0];
    if (!v) continue;
    const header = cleanText(v.header), text = cleanText(v.details);
    if (!header && !text) continue;
    const scope = m.scope || {};
    const lines = [...new Set((scope.lines || []).filter(l => l && (!l.transport_mode || l.transport_mode === 'METRO')).map(l => String(l.designation)))]
      .sort((a, b) => Number(a) - Number(b) || (a < b ? -1 : 1));
    const stations = [...new Set((scope.stop_areas || []).map(a => a && a.name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'sv'));
    const publish = m.publish || {};
    out.push({
      id: m.deviation_case_id != null ? String(m.deviation_case_id) : null,
      header, text, priority: priorityOf(m.priority), lines, stations,
      start: stockholmToMs(publish.from), end: stockholmToMs(publish.upto),
    });
  }
  return out;
}

// Only notices shown now (start <= now < end), one per id (else per header+text), high first, then newest first.
function activeDeviations(list, now = Date.now()) {
  const seen = new Map();
  for (const n of list) {
    if (n.start != null && now < n.start) continue;
    if (n.end != null && now >= n.end) continue;
    const key = n.id || `${n.header}\n${n.text}`;
    const cur = seen.get(key);
    if (!cur || PRIORITY_RANK[n.priority] < PRIORITY_RANK[cur.priority]) seen.set(key, n);
  }
  return [...seen.values()]
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (b.start || 0) - (a.start || 0) || (a.header < b.header ? -1 : 1))
    .map(n => ({ ...n, start: iso(n.start), end: iso(n.end) }));
}

const levelFor = (lateCount, trains) => (lateCount >= 2 * trains ? 'severe' : lateCount >= trains ? 'warning' : 'ok');

class HttpError extends Error {
  constructor(status) { super('SL HTTP ' + status); this.status = status; }
}

function createMetro(opts = {}) {
  const fetchFn = opts.fetch || ((...a) => globalThis.fetch(...a));
  const now = opts.now || Date.now;
  const transportUrl = (opts.transportUrl || process.env.SL_TRANSPORT_URL || 'https://transport.integration.sl.se').replace(/\/+$/, '');
  const deviationsUrl = (opts.deviationsUrl || process.env.SL_DEVIATIONS_URL || 'https://deviations.integration.sl.se').replace(/\/+$/, '');
  const stepMs = opts.stepMs != null ? opts.stepMs : Math.max(250, Number(process.env.BABTIST_METRO_STEP_MS) || 1000);
  const backoffBase = opts.backoffBaseMs != null ? opts.backoffBaseMs : BACKOFF_BASE_MS;
  const backoffMax = opts.backoffMaxMs != null ? opts.backoffMaxMs : BACKOFF_MAX_MS;
  const log = opts.log || ((...a) => console.error('[babtist] metro:', ...a));

  const st = {
    sites: [], siteMap: new Map(), listsAt: 0, listsAttemptAt: 0, cursor: 0,
    data: new Map(), // siteId -> { fetchedAt, deps }
    anyFetched: false, lastFailed: false,
    deviations: [], devAttemptAt: 0, devUpstream: 'starting', devUpdatedAt: null,
    backoffMs: 0, pausedUntil: 0, timer: null, running: false, updatedAt: null,
  };

  async function getJson(url, timeoutMs) {
    const res = await fetchFn(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new HttpError(res.status);
    return res.json();
  }

  function onFail(err) {
    const s = err && err.status;
    if (s === 429 || (s >= 500 && s <= 599)) {
      st.backoffMs = st.backoffMs ? Math.min(backoffMax, st.backoffMs * 2) : backoffBase;
      st.pausedUntil = now() + st.backoffMs;
    }
  }
  const onOk = () => { st.backoffMs = 0; st.pausedUntil = 0; };

  async function loadLists() {
    st.listsAttemptAt = now();
    try {
      const stopPoints = await getJson(`${transportUrl}/v1/stop-points`, 60000);
      const sites = await getJson(`${transportUrl}/v1/sites?expand=true`, 60000);
      const list = metroSites(stopPoints, sites);
      if (list.length === 0) throw new Error('no metro stations found');
      st.sites = list;
      st.siteMap = new Map(list.map(s => [s.siteId, s]));
      for (const id of st.data.keys()) if (!st.siteMap.has(id)) st.data.delete(id);
      st.listsAt = now();
      st.cursor = 0;
      st.lastFailed = false;
      onOk();
    } catch (err) {
      st.lastFailed = true;
      onFail(err);
      throw err;
    }
  }

  async function loadDeviations() {
    st.devAttemptAt = now();
    try {
      st.deviations = parseDeviations(await getJson(`${deviationsUrl}/v1/messages?transport_mode=METRO`, 20000));
      st.devUpstream = 'ok';
      st.devUpdatedAt = iso(now());
      onOk();
    } catch (err) {
      st.devUpstream = 'error';
      onFail(err);
      throw err;
    }
  }

  async function loadSite(site) {
    try {
      const deps = parseDepartures(await getJson(`${transportUrl}/v1/sites/${site.siteId}/departures?transport=METRO&forecast=30`, 15000));
      const t = now();
      st.data.set(site.siteId, { fetchedAt: t, deps: deps.filter(d => d.expected >= t - PAST_KEEP_MS) });
      st.anyFetched = true;
      st.lastFailed = false;
      st.updatedAt = iso(t);
      onOk();
    } catch (err) {
      st.lastFailed = true;
      onFail(err);
      throw err;
    }
  }

  // Exactly one kind of SL work per step: station lists (when due), else deviations (when due), else the next station.
  async function step() {
    const t = now();
    if (t < st.pausedUntil) return 'paused';
    const listsDue = !st.listsAt || t - st.listsAt >= LISTS_REFRESH_MS;
    if (listsDue && (!st.listsAttemptAt || t - st.listsAttemptAt >= LISTS_RETRY_MS)) { await loadLists(); return 'lists'; }
    if (!st.devAttemptAt || t - st.devAttemptAt >= DEVIATIONS_MS) { await loadDeviations(); return 'deviations'; }
    if (st.sites.length === 0) return 'idle';
    const site = st.sites[st.cursor % st.sites.length];
    st.cursor = (st.cursor + 1) % st.sites.length;
    await loadSite(site);
    return 'site';
  }

  function schedule(ms) {
    if (!st.running) return;
    st.timer = setTimeout(async () => {
      try { await step(); } catch (err) { log(err && err.message); }
      try {
        const wait = Math.max(stepMs, st.pausedUntil - now());
        schedule(wait);
      } catch (err) { log(err && err.message); }
    }, ms);
    if (st.timer.unref) st.timer.unref();
  }

  function start(firstMs = stepMs) { if (st.running) return; st.running = true; schedule(firstMs); }
  function stop() { st.running = false; clearTimeout(st.timer); }

  function upstream() { return st.lastFailed || now() < st.pausedUntil ? 'error' : st.anyFetched ? 'ok' : 'starting'; }

  function liveDeps(t) {
    const out = [];
    for (const [siteId, s] of st.data) for (const d of s.deps) if (d.expected >= t - PAST_KEEP_MS) out.push({ ...d, siteId });
    return out;
  }

  // journey -> train: delay from its next stop (earliest upcoming, not departed), else its latest past observation.
  function trains(t = now()) {
    const map = new Map();
    for (const d of liveDeps(t)) {
      if (!d.journeyId) continue;
      const key = `${d.line}:${d.journeyId}`;
      let tr = map.get(key);
      if (!tr) { tr = { journeyId: d.journeyId, line: d.line, group: d.group, canceled: false, next: null, last: null }; map.set(key, tr); }
      if (d.canceled) tr.canceled = true;
      if (d.state !== 'DEPARTED' && d.expected >= t - NEXT_OVERDUE_MS) { if (!tr.next || d.expected < tr.next.expected) tr.next = d; }
      else if (!tr.last || d.expected > tr.last.expected) tr.last = d;
    }
    return [...map.values()].map(tr => {
      const obs = tr.next || tr.last;
      return { journeyId: tr.journeyId, line: tr.line, group: tr.group, canceled: tr.canceled, ...delayOf(obs) };
    });
  }

  function summarize(list, thresholds) {
    const { trains: n, minutes } = thresholds;
    let lateCount = 0, canceledCount = 0, maxDelay = 0;
    for (const tr of list) {
      if (tr.canceled) { canceledCount++; continue; }
      if (tr.delayMinutes >= minutes) lateCount++;
      if (tr.delayMinutes > maxDelay) maxDelay = tr.delayMinutes;
    }
    return { level: levelFor(lateCount, n), lateCount, canceledCount, maxDelayMinutes: maxDelay };
  }

  function stationsCovered(t) {
    let n = 0;
    for (const s of st.data.values()) if (t - s.fetchedAt <= COVERED_MS) n++;
    return n;
  }

  function statusBody(id, thresholds, t = now()) {
    const list = trains(t);
    const s = summarize(list, thresholds);
    return {
      displayId: id, mode: 'metro', level: s.level, lateCount: s.lateCount, canceledCount: s.canceledCount,
      trainsTracked: list.length, maxDelayMinutes: s.maxDelayMinutes, thresholds: { trains: thresholds.trains, minutes: thresholds.minutes },
      updatedAt: st.updatedAt, upstream: upstream(), stationsCovered: stationsCovered(t), stationsTotal: st.sites.length,
    };
  }

  function linesBody(id, thresholds, t = now()) {
    const byLine = new Map(KNOWN_LINES.map(([line, group]) => [line, { group, trains: [] }]));
    for (const tr of trains(t)) {
      if (!tr.line) continue;
      if (!byLine.has(tr.line)) byLine.set(tr.line, { group: tr.group, trains: [] });
      const l = byLine.get(tr.line);
      if (tr.group) l.group = tr.group;
      l.trains.push(tr);
    }
    const lines = [...byLine.entries()]
      .sort((a, b) => (Number(a[0]) - Number(b[0])) || (a[0] < b[0] ? -1 : 1))
      .map(([line, l]) => {
        const s = summarize(l.trains, thresholds);
        return { line, group: l.group, color: lineColor(l.group), trains: l.trains.length, lateCount: s.lateCount, canceledCount: s.canceledCount, maxDelayMinutes: s.maxDelayMinutes, level: s.level };
      });
    return { displayId: id, updatedAt: st.updatedAt, upstream: upstream(), thresholds: { trains: thresholds.trains, minutes: thresholds.minutes }, lines };
  }

  function stationsBody() {
    return {
      updatedAt: st.updatedAt,
      stations: st.sites.map(s => {
        const d = st.data.get(s.siteId);
        return { siteId: s.siteId, name: s.name, lat: s.lat, lon: s.lon, fetchedAt: d ? iso(d.fetchedAt) : null };
      }),
    };
  }

  function nextBody(siteId, limit, t = now()) {
    const site = st.siteMap.get(siteId);
    const d = st.data.get(siteId);
    const list = (d ? d.deps : [])
      .filter(x => x.state !== 'DEPARTED' && x.expected >= t - NEXT_OVERDUE_MS)
      .sort((a, b) => a.expected - b.expected || ((a.line || '') < (b.line || '') ? -1 : 1))
      .slice(0, limit)
      .map(x => ({
        journeyId: x.journeyId, line: x.line, group: x.group, destination: x.destination,
        scheduled: iso(x.scheduled), expected: iso(x.expected), ...delayOf(x),
        canceled: x.canceled, state: x.state, platform: x.platform, deviations: x.deviations,
      }));
    return { siteId, name: site ? site.name : String(siteId), updatedAt: d ? iso(d.fetchedAt) : null, upstream: upstream(), count: list.length, trains: list };
  }

  function noticesBody(t = now()) {
    const list = activeDeviations(st.deviations, t);
    return { updatedAt: st.devUpdatedAt, upstream: st.devUpstream, count: list.length, notices: list };
  }

  // GET /api/metro/... -> [code, body], or null when the path is not a metro route.
  function route(p, params, thresholdsOf) {
    if (p === '/api/metro/status' || p === '/api/metro/lines') {
      const id = params.get('displayId') || 'default';
      if (!ID_RE.test(id)) return [400, { error: 'displayId must match [A-Za-z0-9_-]{1,40}' }];
      const th = thresholdsOf ? thresholdsOf(id) : { ...DEFAULT_THRESHOLDS };
      return [200, p === '/api/metro/status' ? statusBody(id, th) : linesBody(id, th)];
    }
    if (p === '/api/metro/stations') return [200, stationsBody()];
    if (p === '/api/metro/notices') return [200, noticesBody()];
    const m = /^\/api\/metro\/stations\/([^/]+)\/next$/.exec(p);
    if (m) {
      if (!SITE_RE.test(m[1])) return [400, { error: 'siteId must be 1..7 digits' }];
      const raw = params.get('limit');
      const limit = raw == null || raw === '' ? 10 : /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(limit) || limit < 1 || limit > 30) return [400, { error: 'limit must be an integer 1..30' }];
      return [200, nextBody(Number(m[1]), limit)];
    }
    return null;
  }

  return { start, stop, step, route, trains, statusBody, linesBody, stationsBody, nextBody, noticesBody, upstream, state: st, stepMs };
}

module.exports = {
  createMetro, parseDepartures, parseDeviations, activeDeviations, metroSites, stockholmToMs, toStockholmLocal, lineColor, priorityOf,
};
