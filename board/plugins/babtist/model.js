'use strict';
// Model: in-memory commuter-train announcements inside a short time window, and the delay summary derived from them.

const WINDOW_PAST_MS = 60 * 60 * 1000;
const WINDOW_FUTURE_MS = 30 * 60 * 1000;
const DEFAULT_THRESHOLDS = { trains: 3, minutes: 5 };

const toMs = v => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

const iso = ms => (ms == null ? null : new Date(ms).toISOString());
// Service date in Swedish local time, so a train keeps the same id across midnight UTC.
const serviceDate = ms => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });
const trainIdOf = r => `${r.train}-${serviceDate(r.adv)}`;

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

class Model {
  constructor() {
    this.rows = new Map();
    this.delays = [];
    this.canceled = 0;
    this.summarize(Date.now());
  }

  static keyOf(a) {
    return [a.AdvertisedTrainIdent, a.LocationSignature, a.ActivityType, a.AdvertisedTimeAtLocation].join('|');
  }

  apply(items, { full = false, now = Date.now() } = {}) {
    if (full) this.rows.clear();
    for (const a of items) {
      if (!a || !a.AdvertisedTrainIdent) continue;
      const key = Model.keyOf(a);
      if (a.Deleted) { this.rows.delete(key); continue; }
      const adv = toMs(a.AdvertisedTimeAtLocation);
      if (adv == null) continue;
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
    for (const [key, r] of this.rows) {
      if (r.adv < now - WINDOW_PAST_MS || r.adv > now + WINDOW_FUTURE_MS) { this.rows.delete(key); continue; }
      const id = trainIdOf(r);
      let t = trains.get(id);
      if (!t) { t = { canceled: false, lastActAdv: -1, actDelay: null, estDelay: null }; trains.set(id, t); }
      if (r.canceled) t.canceled = true;
      if (r.act != null && r.adv > t.lastActAdv) { t.lastActAdv = r.adv; t.actDelay = r.act - r.adv; }
      else if (r.est != null) t.estDelay = Math.max(t.estDelay == null ? -Infinity : t.estDelay, r.est - r.adv);
    }
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
        trainId: trainIdOf(r),
        station: r.loc,
        activity: r.activity,
        scheduled: iso(r.adv),
        estimated: iso(r.est),
        actual: iso(r.act),
        canceled: r.canceled,
        to: r.to,
      }));
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

module.exports = { Model, parseResponse, demoItems, levelThresholds, validThresholds, DEFAULT_THRESHOLDS };
