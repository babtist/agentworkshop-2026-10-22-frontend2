'use strict';

const MINUTE = 60000;
const METHOD = 'station-destination-overlap-v1';
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function timestamp(value) {
  return typeof value === 'string' && ISO_TIME.test(value) ? Date.parse(value) : NaN;
}

function validThresholds(value) {
  return value && Number.isInteger(value.trains) && value.trains >= 1 && value.trains <= 100 &&
    Number.isInteger(value.minutes) && value.minutes >= 1 && value.minutes <= 240;
}

function addLeader(leaders, id, end) {
  const existing = leaders.find(leader => leader.id === id);
  if (existing) existing.end = Math.max(existing.end, end);
  else leaders.push({ id, end });
  leaders.sort((a, b) => b.end - a.end);
  leaders.length = Math.min(leaders.length, 2);
}

function analyze(snapshot, thresholds, { displayId = 'default', now = Date.now() } = {}) {
  if (!Number.isFinite(now)) throw new TypeError('Invalid evaluation time');
  const sourceTime = timestamp(snapshot?.updatedAt);
  const upstream = ['ok', 'error', 'no-key'].includes(snapshot?.upstream) ? snapshot.upstream : null;
  const body = {
    version: 1, displayId, availability: null, level: null, method: METHOD,
    affectedTrainCount: null, canceledTrainCount: null,
    thresholds: validThresholds(thresholds) ? { trains: thresholds.trains, minutes: thresholds.minutes } : null,
    reasons: [], sourceUpdatedAt: Number.isFinite(sourceTime) ? new Date(sourceTime).toISOString() : null,
    evaluatedAt: new Date(now).toISOString(), upstream,
  };
  function nonReady(availability, reason, error) {
    body.availability = availability;
    body.reasons = [reason];
    if (error) body.error = error;
    return body;
  }
  const unavailable = () => nonReady('unavailable', 'SOURCE_UNAVAILABLE', 'Train snapshot or display settings are unavailable');
  if (!body.thresholds || !upstream || !Number.isFinite(sourceTime) || sourceTime > now + MINUTE) return unavailable();
  if (upstream === 'error') return unavailable();
  if (upstream === 'no-key') return nonReady('demo', 'DEMO_SOURCE');
  if (now - sourceTime > 90000) return nonReady('stale', 'STALE_SOURCE', 'Train snapshot is stale');
  if (!Array.isArray(snapshot.announcements) || !Number.isInteger(snapshot.count) ||
      snapshot.count !== snapshot.announcements.length || typeof snapshot.complete !== 'boolean' ||
      !Number.isFinite(snapshot.window?.pastMinutes) || !Number.isFinite(snapshot.window?.futureMinutes)) return unavailable();
  if (!snapshot.complete || snapshot.count === 0 || snapshot.count >= 5000 ||
      snapshot.window.pastMinutes < 10 || snapshot.window.futureMinutes < 30) {
    return nonReady('insufficient', 'INCOMPLETE_SNAPSHOT');
  }

  const rows = new Map();
  const canceled = new Set();
  for (const row of snapshot.announcements) {
    if (!row || typeof row !== 'object' || typeof row.canceled !== 'boolean') return unavailable();
    const scheduled = timestamp(row.scheduled);
    if (!Number.isFinite(scheduled)) return nonReady('insufficient', 'INSUFFICIENT_GROUPING_DATA');
    if (scheduled < now - 10 * MINUTE || scheduled > now + 30 * MINUTE) continue;
    if (typeof row.trainId !== 'string' || !row.trainId.trim()) return unavailable();
    if (!row.canceled && (typeof row.station !== 'string' || !row.station.trim() ||
        !['Ankomst', 'Avgang'].includes(row.activity) || !Array.isArray(row.to) ||
        !row.to.length || row.to.some(to => typeof to !== 'string' || !to.trim()))) {
      return nonReady('insufficient', 'INSUFFICIENT_GROUPING_DATA');
    }
    const actual = row.actual === null ? null : timestamp(row.actual);
    const estimated = row.estimated === null ? null : timestamp(row.estimated);
    if ((actual !== null && !Number.isFinite(actual)) || (estimated !== null && !Number.isFinite(estimated))) return unavailable();
    const destinations = Array.isArray(row.to) ? [...new Set(row.to)].sort() : [];
    const group = JSON.stringify([row.station, row.activity, destinations]);
    const key = JSON.stringify([row.trainId, row.station, row.activity, scheduled]);
    const normalized = { id: row.trainId, scheduled, actual, estimated, group, canceled: row.canceled };
    const previous = rows.get(key);
    if (previous && (previous.actual !== actual || previous.estimated !== estimated ||
        previous.group !== group || previous.canceled !== row.canceled)) {
      return nonReady('insufficient', 'INCOMPLETE_SNAPSHOT');
    }
    rows.set(key, normalized);
    if (row.canceled) canceled.add(row.trainId);
  }
  body.canceledTrainCount = canceled.size;
  const groups = new Map();
  for (const row of rows.values()) {
    if (canceled.has(row.id)) continue;
    if (!groups.has(row.group)) groups.set(row.group, []);
    groups.get(row.group).push(row);
  }

  const affected = new Set();
  let comparable = false;
  for (const group of groups.values()) {
    group.sort((a, b) => a.scheduled - b.scheduled);
    const observed = new Set();
    const leaders = [];
    for (let start = 0; start < group.length;) {
      let end = start + 1;
      while (end < group.length && group[end].scheduled === group[start].scheduled) end++;
      // Equal scheduled times are not a leader/follower relationship.
      for (let i = start; i < end; i++) {
        const row = group[i];
        if (row.scheduled < now || row.actual !== null) continue;
        if (observed.size > 1 || (observed.size === 1 && !observed.has(row.id))) comparable = true;
        if (leaders.some(leader => leader.id !== row.id && leader.end >= row.scheduled)) affected.add(row.id);
      }
      for (let i = start; i < end; i++) {
        const row = group[i];
        const event = row.actual ?? row.estimated;
        if (event === null) continue;
        observed.add(row.id);
        if (event - row.scheduled >= thresholds.minutes * MINUTE) addLeader(leaders, row.id, event);
      }
      start = end;
    }
  }
  if (!comparable) return nonReady('insufficient', 'INSUFFICIENT_GROUPING_DATA');
  body.availability = 'ready';
  body.affectedTrainCount = affected.size;
  body.level = affected.size < thresholds.trains ? 'ok' : affected.size < 2 * thresholds.trains ? 'warning' : 'severe';
  body.reasons = affected.size ? ['POTENTIAL_HEADWAY_OVERLAP'] : [];
  return body;
}

module.exports = { analyze, validThresholds, timestamp };
