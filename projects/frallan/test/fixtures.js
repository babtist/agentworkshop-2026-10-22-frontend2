'use strict';

const NOW = Date.parse('2026-10-22T08:10:00Z');
const time = minutes => new Date(NOW + minutes * 60000).toISOString();
const row = (trainId, scheduled, extra = {}) => ({
  trainId, station: 'Sci', activity: 'Avgang', scheduled: time(scheduled),
  estimated: null, actual: null, canceled: false, to: ['Nyc'], ...extra,
});
const snapshot = (announcements = [row('leader', 2, { estimated: time(10) }), row('follower', 6)], extra = {}) => ({
  generatedAt: time(0), updatedAt: time(0), upstream: 'ok', complete: true,
  window: { pastMinutes: 60, futureMinutes: 30 }, count: announcements.length, announcements, ...extra,
});

module.exports = { NOW, time, row, snapshot };
