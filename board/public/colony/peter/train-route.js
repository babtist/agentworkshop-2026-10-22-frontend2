// Click a train: its stops from babtist GET /api/snapshot (window -60..+30 min) as a list in the popup and as a route
// on the map. Passed stops grey, coming stops ringed and labelled with the expected delay ("+N"), so you see where the
// delay is heading. Optional: if the snapshot is missing or fails, the train popup stays as it was.
(() => {
  const API = '/t/babtist/api/snapshot';
  const CACHE_MS = 20000;
  const pm = window.peterMap;
  if (!pm || !window.L) return;
  const { map } = pm;
  const layer = L.layerGroup().addTo(map);

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ms = (iso) => { const t = iso ? Date.parse(iso) : NaN; return isNaN(t) ? null : t; };
  const hm = (t) => t == null ? '–' : new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  let snap = null; let snapAt = 0; let pending = null;
  async function snapshot() {
    if (snap && Date.now() - snapAt < CACHE_MS) return snap;
    if (!pending) {
      pending = fetch(API, { cache: 'no-store' })
        .then((r) => { if (r.status === 404) return { missing: true }; if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .then((j) => { snap = j; snapAt = Date.now(); return j; })
        .finally(() => { pending = null; });
    }
    return pending;
  }

  // One stop per station: departure when there is one, else arrival (the end station). Passed = has an actual time.
  function stops(data, trainId) {
    const by = new Map();
    for (const a of data.announcements || []) {
      if (a.trainId !== trainId) continue;
      const s = by.get(a.station) || { station: a.station };
      s[a.activity === 'Avgang' ? 'dep' : 'arr'] = a;
      by.set(a.station, s);
    }
    const now = Date.now();
    const list = [...by.values()].map((s) => {
      const a = s.dep || s.arr;
      const sched = ms(a.scheduled);
      const actual = ms(s.dep?.actual) ?? ms(s.arr?.actual);
      const passed = actual != null;
      const est = ms(s.dep?.actual) ?? ms(a.estimated) ?? (s.dep ? null : ms(s.arr?.actual));
      const delay = sched != null && est != null ? Math.max(0, Math.round((est - sched) / 60000)) : null;
      const st = pm.stations?.get(s.station);
      return { station: s.station, name: pm.names.get(s.station) || s.station, sched, est, actual, passed,
        delay, canceled: !!(s.dep?.canceled || s.arr?.canceled), end: !s.dep, lat: st?.lat, lon: st?.lon };
    }).filter((s) => s.sched != null).sort((x, y) => x.sched - y.sched);
    // A stop scheduled before a passed stop is passed too (Trafikverket sometimes skips the actual time).
    let lastPassed = -1;
    list.forEach((s, i) => { if (s.passed) lastPassed = i; });
    list.forEach((s, i) => { if (i < lastPassed) s.passed = true; });
    const next = list.find((s) => !s.passed && !s.canceled);
    if (next) next.next = true;
    return { list, now };
  }

  const level = (d, canceled) => {
    const y = pm.thresholds?.minutes || 5;
    if (canceled) return 'canceled';
    if (d == null) return 'unknown';
    return d >= 2 * y ? 'severe' : d >= y ? 'warning' : 'ok';
  };
  const COLOR = { ok: '#2fbf8a', warning: '#f59f2a', severe: '#ff4757', unknown: '#8a93a6', canceled: '#8a93a6' };

  const state = { id: null, html: '', t: null, close: null };
  // The full stop list lives in the station panel beside the map, so the popup does not cover the route.
  const box = document.createElement('section');
  box.className = 'tr-panel'; box.hidden = true; box.setAttribute('aria-live', 'polite');
  const host = document.getElementById('stationPanel');
  const anchor = document.getElementById('stationMiss');
  if (host && anchor) anchor.before(box); else box.remove();
  const showPanel = (inner) => {
    if (!box.isConnected) return;
    if (!inner) { box.hidden = true; box.innerHTML = ''; return; }
    const t = state.t;
    box.innerHTML = `<header><b>Train ${esc(t.train || t.trainId)}</b>${t.to?.length ? ` → ${esc(t.to.map((x) => pm.names.get(x) || x).join(' / '))}` : ''}` +
      `<button type="button" class="tr-close" aria-label="Close train route">×</button></header>${inner}`;
    box.hidden = false;
  };
  box.addEventListener('click', (e) => { if (e.target.closest('.tr-close')) state.close?.(); });

  function render(list) {
    if (!list.length) return { pop: '<div class="tr-route tr-empty">No stops for this train in the last hour or next 30 minutes.</div>', panel: '' };
    // Keep the popup short: the two last passed stops, then everything coming.
    const firstShown = Math.max(0, list.findIndex((s) => !s.passed) - 2);
    const shown = list.findIndex((s) => !s.passed) === -1 ? list.slice(-3) : list.slice(firstShown);
    const hidden = list.length - shown.length;
    const rows = shown.map((s) => {
      const lv = level(s.delay, s.canceled);
      const when = s.canceled ? '<s>' + hm(s.sched) + '</s>'
        : s.est != null && s.delay > 0 ? `<s>${hm(s.sched)}</s> ${hm(s.est)}` : hm(s.sched);
      const tag = s.canceled ? 'canceled' : s.delay > 0 ? `+${s.delay}` : s.delay === 0 ? 'on time' : '';
      return `<li class="tr-stop tr-${lv}${s.passed ? ' tr-passed' : ''}${s.next ? ' tr-next' : ''}">` +
        `<i></i><button type="button" class="tr-name" data-station="${esc(s.station)}">${esc(s.name)}</button>` +
        `<span class="tr-when">${when}</span><span class="tr-tag">${tag}</span></li>`;
    }).join('');
    const coming = list.filter((s) => !s.passed && !s.canceled && s.delay != null);
    const worst = coming.reduce((a, s) => Math.max(a, s.delay), 0);
    const y = pm.thresholds?.minutes || 5;
    const late = coming.filter((s) => s.delay >= y).length;
    const summary = !coming.length ? 'No coming stops in the window'
      : worst === 0 ? `On time at all ${coming.length} coming stops`
      : late ? `Late (≥ ${y} min) at ${late} of ${coming.length} coming stops, up to +${worst} min`
      : `Up to +${worst} min at the coming stops, below the ${y}-min threshold`;
    const panel = `<div class="tr-route"><div class="tr-sum">${esc(summary)}</div>` +
      (hidden ? `<div class="tr-more">${hidden} earlier stop${hidden > 1 ? 's' : ''} not shown</div>` : '') +
      `<ol>${rows}</ol><small>Stops from the last hour and the next 30 min · click a station to open it</small></div>`;
    if (!box.isConnected) return { pop: panel, panel: '' };
    return { pop: `<div class="tr-route"><div class="tr-sum">${esc(summary)}</div><small>Route on the map, all stops in the panel →</small></div>`, panel };
  }

  function draw(list, cls) {
    pm.routeOpen = true;
    layer.clearLayers();
    const pts = list.filter((s) => typeof s.lat === 'number' && typeof s.lon === 'number');
    if (pts.length < 1) return;
    const idx = pts.findIndex((s) => !s.passed);
    const past = idx === -1 ? pts : pts.slice(0, idx + 1);
    const coming = idx === -1 ? [] : pts.slice(Math.max(0, idx - 1));
    const halo = { color: '#070b16', weight: 9, opacity: 0.55, interactive: false };
    if (past.length > 1) {
      L.polyline(past.map((s) => [s.lat, s.lon]), halo).addTo(layer);
      L.polyline(past.map((s) => [s.lat, s.lon]), { color: '#8a93a6', weight: 4, dashArray: '2 7', interactive: false }).addTo(layer);
    }
    if (coming.length > 1) {
      L.polyline(coming.map((s) => [s.lat, s.lon]), halo).addTo(layer);
      L.polyline(coming.map((s) => [s.lat, s.lon]), { color: COLOR[cls] || COLOR.unknown, weight: 5, interactive: false }).addTo(layer);
    }
    for (const s of pts) {
      const lv = level(s.delay, s.canceled);
      if (s.passed) {
        L.circleMarker([s.lat, s.lon], { radius: 4, color: '#8a93a6', weight: 2, fillColor: '#070b16', fillOpacity: 1, interactive: false }).addTo(layer);
        continue;
      }
      L.circleMarker([s.lat, s.lon], { radius: s.next ? 11 : 8, color: COLOR[lv], weight: s.next ? 4 : 3, fill: false, interactive: false,
        className: s.next ? 'tr-ring-next' : '' }).addTo(layer);
      const tag = s.canceled ? '✕' : s.delay > 0 ? `+${s.delay}` : s.delay === 0 ? '0' : '?';
      L.marker([s.lat, s.lon], { interactive: false, keyboard: false,
        icon: L.divIcon({ className: `tr-label tr-${lv}`, html: `<span>${tag}</span>`, iconSize: [34, 18], iconAnchor: [-8, 22] }) }).addTo(layer);
    }
  }

  function apply(r) { state.html = r.pop; showPanel(r.panel); }
  async function open(t, refresh, cls, fit, close) {
    state.id = String(t.trainId); state.t = t; state.close = close;
    state.html = '<div class="tr-route tr-loading">Loading the train’s stops…</div>';
    refresh();
    try {
      const data = await snapshot();
      if (state.id !== String(t.trainId)) return;
      if (data.missing) { state.html = ''; showPanel(''); refresh(); return; }
      const { list } = stops(data, state.id);
      apply(render(list));
      draw(list, cls);
      const pts = list.filter((s) => typeof s.lat === 'number').map((s) => [s.lat, s.lon]);
      if (fit && pts.length > 1) fitTo = L.latLngBounds(pts).extend([t.lat, t.lon]);
    } catch (e) {
      if (state.id !== String(t.trainId)) return;
      state.html = `<div class="tr-route tr-empty">Stops not available (${esc(e.message)})</div>`;
    }
    refresh();
    if (fitTo) { const b = fitTo; fitTo = null; setTimeout(() => map.fitBounds(b, { padding: [30, 30], maxZoom: 12 }), 300); }
  }
  let fitTo = null;
  function close(id) {
    if (state.id !== String(id)) return;
    state.id = null; state.html = ''; state.close = null; showPanel(''); layer.clearLayers(); pm.routeOpen = false;
  }
  // Re-draw on the train poll while open, so the route follows new actual times.
  async function update(t, refresh, cls) {
    if (state.id !== String(t.trainId)) return;
    state.t = t;
    try {
      const data = await snapshot();
      if (state.id !== String(t.trainId) || data.missing) return;
      const { list } = stops(data, state.id);
      apply(render(list));
      draw(list, cls);
      refresh();
    } catch {}
  }

  [map.getContainer(), box].forEach((el) => el.addEventListener('click', (e) => {
    const b = e.target.closest?.('.tr-name');
    if (b) { e.preventDefault(); pm.select(b.dataset.station, { pan: true }); }
  }));

  window.peterRoute = { open, close, update, html: (id) => (state.id === String(id) ? state.html : '') };
})();
