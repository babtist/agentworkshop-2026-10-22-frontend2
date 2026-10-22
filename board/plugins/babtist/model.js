'use strict';
// Model: in-memory commuter-train announcements inside a short time window, and the delay summary derived from them.

const WINDOW_PAST_MS = 60 * 60 * 1000;
const WINDOW_FUTURE_MS = 30 * 60 * 1000;
const DEFAULT_THRESHOLDS = { trains: 3, minutes: 5 };
// Rows of one ident further apart than this are different runs (the same ident recurs the next day).
const RUN_GAP_MS = 12 * 60 * 60 * 1000;

const toMs = v => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

const iso = ms => (ms == null ? null : new Date(ms).toISOString());
// Service date in Swedish local time of the earliest stop seen for the run, so a run keeps one id across 00:00.
const serviceDate = ms => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });

function parseResponse(json) {
  const result = json && json.RESPONSE && json.RESPONSE.RESULT && json.RESPONSE.RESULT[0];
  if (!result) throw new Error('unexpected response shape');
  if (result.ERROR) throw new Error('upstream error: ' + (result.ERROR.MESSAGE || 'unknown'));
  const info = result.INFO || {};
  return {
    items: Array.isArray(result.TrainAnnouncement) ? result.TrainAnnouncement : [],
    lastChangeId: info.LASTCHANGEID != null ? String(info.LASTCHANGEID) : null,
  };
}

// "POINT (18.0592 59.3307)" -> { lon, lat }, or null.
function parseWgs84(wkt) {
  const m = /^\s*POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)\s*$/i.exec(typeof wkt === 'string' ? wkt : '');
  if (!m) return null;
  const lon = Number(m[1]), lat = Number(m[2]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lon, lat };
}

// TrainStation response -> Map(signature -> { name, lat, lon }). Throws on an upstream error, like parseResponse.
function parseStations(json) {
  const result = json && json.RESPONSE && json.RESPONSE.RESULT && json.RESPONSE.RESULT[0];
  if (!result) throw new Error('unexpected response shape');
  if (result.ERROR) throw new Error('upstream error: ' + (result.ERROR.MESSAGE || 'unknown'));
  const out = new Map();
  for (const s of Array.isArray(result.TrainStation) ? result.TrainStation : []) {
    if (!s || typeof s.LocationSignature !== 'string' || !s.LocationSignature) continue;
    const p = parseWgs84(s.Geometry && s.Geometry.WGS84);
    out.set(s.LocationSignature, {
      name: typeof s.AdvertisedLocationName === 'string' && s.AdvertisedLocationName ? s.AdvertisedLocationName : s.LocationSignature,
      lat: p ? p.lat : null,
      lon: p ? p.lon : null,
    });
  }
  return out;
}

class Model {
  constructor() {
    this.rows = new Map();
    this.runStart = new Map(); // ident -> earliest advertised time seen for the current run
    this.delays = [];
    this.canceled = 0;
    this.summarize(Date.now());
  }

  static keyOf(a) {
    // Parsed time, so '...T10:00:00.000+02:00' and '...T08:00:00Z' are the same row.
    const adv = toMs(a.AdvertisedTimeAtLocation);
    return [a.AdvertisedTrainIdent, a.LocationSignature, a.ActivityType, adv == null ? a.AdvertisedTimeAtLocation : adv].join('|');
  }

  trainIdOf(r) {
    const start = this.runStart.get(r.train);
    return `${r.train}-${serviceDate(start != null && Math.abs(r.adv - start) <= RUN_GAP_MS ? start : r.adv)}`;
  }

  noteRun(train, adv) {
    const start = this.runStart.get(train);
    if (start == null || Math.abs(adv - start) > RUN_GAP_MS || adv < start) this.runStart.set(train, adv);
  }

  apply(items, { full = false, now = Date.now() } = {}) {
    if (full) this.rows.clear();
    for (const a of items) {
      if (!a || !a.AdvertisedTrainIdent) continue;
      const key = Model.keyOf(a);
      if (a.Deleted) { this.rows.delete(key); continue; }
      const adv = toMs(a.AdvertisedTimeAtLocation);
      if (adv == null) continue;
      this.noteRun(a.AdvertisedTrainIdent, adv);
      this.rows.set(key, {
        train: a.AdvertisedTrainIdent,
        loc: a.LocationSignature || null,
        activity: a.ActivityType || null,
        to: Array.isArray(a.ToLocation) ? a.ToLocation.map(l => l && l.LocationName).filter(Boolean) : [],
        adv,
        act: toMs(a.TimeAtLocation),
        est: toMs(a.EstimatedTimeAtLocation),
        canceled: !!a.Canceled,
      });
    }
    this.summarize(now);
  }

  // Drops rows outside the window and recomputes one delay value per train.
  summarize(now) {
    const trains = new Map();
    const live = new Set();
    for (const [key, r] of this.rows) {
      if (r.adv < now - WINDOW_PAST_MS || r.adv > now + WINDOW_FUTURE_MS) { this.rows.delete(key); continue; }
      live.add(r.train);
      const id = this.trainIdOf(r);
      let t = trains.get(id);
      if (!t) { t = { canceled: false, lastActAdv: -1, actDelay: null, estDelay: null }; trains.set(id, t); }
      if (r.canceled) t.canceled = true;
      if (r.act != null) { if (r.adv > t.lastActAdv) { t.lastActAdv = r.adv; t.actDelay = r.act - r.adv; } }
      else if (r.est != null) t.estDelay = Math.max(t.estDelay == null ? -Infinity : t.estDelay, r.est - r.adv);
    }
    for (const train of this.runStart.keys()) if (!live.has(train)) this.runStart.delete(train);
    const delays = [];
    let canceled = 0;
    for (const t of trains.values()) {
      if (t.canceled) { canceled++; continue; }
      const ms = t.actDelay != null ? t.actDelay : t.estDelay;
      if (ms == null) continue;
      delays.push(Math.max(0, Math.round(ms / 60000)));
    }
    this.delays = delays;
    this.canceled = canceled;
  }

  // Read-only copy of the retained announcements, oldest first.
  snapshot(now = Date.now()) {
    this.summarize(now);
    return [...this.rows.values()]
      .sort((a, b) => a.adv - b.adv)
      .map(r => ({
        trainId: this.trainIdOf(r),
        station: r.loc,
        activity: r.activity,
        scheduled: iso(r.adv),
        estimated: iso(r.est),
        actual: iso(r.act),
        canceled: r.canceled,
        to: r.to,
      }));
  }

  // Per-station delay counts for one display. A train is counted at a station by its delay at that station only
  // (the larger of arrival and departure). Canceled trains are counted as canceled, not as late.
  stationsFor(thresholds, now = Date.now()) {
    this.summarize(now);
    const { trains, minutes } = thresholds;
    const stations = new Map();
    for (const r of this.rows.values()) {
      if (!r.loc) continue;
      let s = stations.get(r.loc);
      if (!s) { s = new Map(); stations.set(r.loc, s); }
      const id = this.trainIdOf(r);
      let t = s.get(id);
      if (!t) { t = { canceled: false, delay: null }; s.set(id, t); }
      if (r.canceled) t.canceled = true;
      const seen = r.act != null ? r.act : r.est;
      if (seen != null) {
        const d = Math.max(0, Math.round((seen - r.adv) / 60000));
        if (t.delay == null || d > t.delay) t.delay = d;
      }
    }
    return [...stations.keys()].sort().map(station => {
      let lateCount = 0, canceledCount = 0;
      for (const t of stations.get(station).values()) {
        if (t.canceled) canceledCount++;
        else if (t.delay != null && t.delay >= minutes) lateCount++;
      }
      const level = lateCount === 0 ? 'ok' : lateCount < trains ? 'warning' : 'severe';
      return { station, lateCount, canceledCount, level };
    });
  }

  statusFor(thresholds) {
    const { trains, minutes } = thresholds;
    let lateCount = 0, maxDelay = 0;
    for (const d of this.delays) {
      if (d >= minutes) lateCount++;
      if (d > maxDelay) maxDelay = d;
    }
    const level = lateCount >= 2 * trains ? 'severe' : lateCount >= trains ? 'warning' : 'ok';
    return {
      level,
      lateCount,
      canceledCount: this.canceled,
      trainsTracked: this.delays.length + this.canceled,
      maxDelayMinutes: maxDelay,
      thresholds: { trains, minutes },
    };
  }
}

// Deterministic fake data for when there is no API key, so UI teams can build against the API.
function demoItems(now = Date.now()) {
  const bucket = Math.floor(now / (5 * 60000));
  const items = [];
  for (let i = 0; i < 24; i++) {
    const adv = new Date(Math.floor(now / 60000) * 60000 - ((i * 7) % 50) * 60000);
    const h = ((bucket * 31 + i * 17) % 23);
    const delay = h > 15 ? h - 12 : h > 9 ? 2 : 0;
    const base = { AdvertisedTrainIdent: String(2000 + i), LocationSignature: 'Sci', ActivityType: 'Ankomst', AdvertisedTimeAtLocation: adv.toISOString() };
    if (i % 11 === 5) items.push({ ...base, Canceled: true });
    else items.push({ ...base, TimeAtLocation: new Date(adv.getTime() + delay * 60000).toISOString() });
  }
  return items;
}

function levelThresholds(input) {
  const out = { ...DEFAULT_THRESHOLDS };
  if (input && Number.isInteger(input.trains)) out.trains = input.trains;
  if (input && Number.isInteger(input.minutes)) out.minutes = input.minutes;
  return out;
}

function validThresholds(b) {
  return b && typeof b === 'object' &&
    Number.isInteger(b.trains) && b.trains >= 1 && b.trains <= 100 &&
    Number.isInteger(b.minutes) && b.minutes >= 1 && b.minutes <= 240;
}

module.exports = { Model, parseResponse, parseStations, parseWgs84, demoItems, levelThresholds, validThresholds, DEFAULT_THRESHOLDS };
