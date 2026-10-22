'use strict';

const { timestamp, validThresholds } = require('./risk');
const WINDOW_MS = 30 * 60000;
const GAP_MS = 60000;

class Trend {
  constructor() {
    this.points = [];
    this.thresholdKey = null;
    this.lastSourceAt = -Infinity;
    this.lastGapAt = -Infinity;
  }

  prune(now) {
    this.points = this.points.filter(point => point.at >= now - WINDOW_MS).slice(-120);
  }

  read(status, { displayId, now, attemptAt }) {
    this.prune(now);
    const thresholds = validThresholds(status?.thresholds) ?
      { trains: status.thresholds.trains, minutes: status.thresholds.minutes } : null;
    const thresholdKey = thresholds ? JSON.stringify(thresholds) : null;
    if (thresholdKey && thresholdKey !== this.thresholdKey) {
      this.points = [];
      this.thresholdKey = thresholdKey;
      this.lastSourceAt = -Infinity;
      this.lastGapAt = -Infinity;
    }
    const sourceAt = timestamp(status?.updatedAt);
    let availability = 'unavailable';
    if (thresholds && status?.upstream === 'no-key') availability = 'demo';
    else if (thresholds && Number.isFinite(sourceAt) && sourceAt <= now + 60000) {
      if (status.upstream === 'ok') {
        if (now - sourceAt > 90000) availability = 'stale';
        else if (['lateCount', 'canceledCount', 'trainsTracked'].every(
          key => Number.isInteger(status[key]) && status[key] >= 0) && sourceAt >= this.lastSourceAt) {
          availability = 'warming-up';
        }
      }
    }
    if (availability === 'warming-up') {
      if (sourceAt > this.lastSourceAt && sourceAt > (this.points.at(-1)?.at ?? -Infinity)) {
        this.points.push({ at: sourceAt, lateCount: status.lateCount, canceledCount: status.canceledCount });
        this.lastSourceAt = sourceAt;
      }
    } else if (Number.isFinite(attemptAt) && attemptAt > this.lastGapAt) {
      this.points.push({ at: Math.max(attemptAt, this.points.at(-1)?.at ?? -Infinity), lateCount: null, canceledCount: null });
      this.lastGapAt = attemptAt;
    }
    this.prune(now);
    let direction = 'unknown', delta = null, observedMinutes = 0;
    const latest = this.points.at(-1);
    if (latest && latest.lateCount !== null) {
      let start = this.points.length - 1;
      while (start > 0 && this.points[start - 1].lateCount !== null &&
          this.points[start].at - this.points[start - 1].at <= GAP_MS) start--;
      const contiguous = this.points.slice(start);
      observedMinutes = (latest.at - contiguous[0].at) / 60000;
      const target = latest.at - 5 * 60000;
      const baseline = contiguous.findLast(point => point.at <= target);
      if (availability === 'warming-up' && baseline && target - baseline.at <= GAP_MS) {
        availability = 'ready';
        delta = latest.lateCount - baseline.lateCount;
        direction = delta < 0 ? 'improving' : delta > 0 ? 'worsening' : 'steady';
      }
    }
    const body = {
      version: 1, displayId, availability, direction, delta, comparisonMinutes: 5,
      windowMinutes: 30, observedMinutes, thresholds,
      updatedAt: Number.isFinite(sourceAt) ? new Date(sourceAt).toISOString() : null,
      evaluatedAt: new Date(now).toISOString(),
      points: this.points.map(point => ({ ...point, at: new Date(point.at).toISOString() })),
    };
    if (['stale', 'unavailable'].includes(availability)) body.error = 'Current controller status is unavailable or stale';
    return body;
  }
}

module.exports = { Trend, WINDOW_MS };
