// Station delay map: one marker per commuter station, coloured by its own level (babtist GET /api/stations).
// Optional layer: if Leaflet or the endpoint fails, the level card above keeps working.
(() => {
  const API = '/t/babtist/api';
  const POLL_MS = 30000;
  const COLOR = { ok: '#5fd7a7', warning: '#ffb454', severe: '#ff5c6c' };
  // Not colour alone: ring thickness and radius grow with level; tooltip names the level.
  const RING = { ok: ['#070b16', 1], warning: ['#070b16', 2.5], severe: ['#070b16', 5] };
  const LEVEL_TEXT = { ok: 'ok', warning: 'warning', severe: 'severe' };
  const box = document.getElementById('mapSection');
  const displayId = document.body.dataset.displayId;
  if (!box || !displayId || !window.L) { if (box) box.hidden = true; return; }

  const note = document.getElementById('mapNote');
  const map = L.map('map', { zoomSnap: 0.25, zoomControl: !document.body.classList.contains('kiosk'), attributionControl: true })
    .setView([59.33, 18.06], 9);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 15, minZoom: 7,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  const layer = L.layerGroup().addTo(map);
  let fitted = false;
  // Shared with trains.js: the map, a layer switch, and the display's thresholds once known.
  const layers = L.control.layers(null, { Stations: layer }, { collapsed: false, position: 'topright' }).addTo(map);
  window.peterMap = { map, layers, thresholds: null, names: new Map() };
  // The kiosk layout sizes the map with flex/grid after Leaflet measured it; re-measure on any resize.
  new ResizeObserver(() => map.invalidateSize()).observe(document.getElementById('map'));

  const legend = L.control({ position: 'bottomleft' });
  legend.onAdd = () => {
    const d = L.DomUtil.create('div', 'map-legend');
    d.innerHTML = Object.entries(COLOR).map(([k, c]) => `<span><i style="background:${c};box-shadow:0 0 0 ${RING[k][1] - 1}px ${RING[k][0]}"></i>${k}</span>`).join('');
    return d;
  };
  legend.addTo(map);

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function draw(data) {
    layer.clearLayers();
    const t = data.thresholds || {};
    window.peterMap.thresholds = data.thresholds || null;
    for (const s of data.stations || []) if (s.station && s.name) window.peterMap.names.set(s.station, s.name);
    const pts = [];
    // Severe last so it is drawn on top where markers overlap.
    const order = { ok: 0, warning: 1, severe: 2 };
    const stations = (data.stations || []).filter((s) => typeof s.lat === 'number' && typeof s.lon === 'number')
      .sort((a, b) => (order[a.level] ?? 0) - (order[b.level] ?? 0));
    for (const s of stations) {
      const color = COLOR[s.level] || '#8a98b3';
      const radius = 5 + Math.min(10, Math.sqrt(s.lateCount || 0) * 3);
      const [ring, weight] = RING[s.level] || RING.ok;
      L.circleMarker([s.lat, s.lon], { radius, color: ring, weight, fillColor: color, fillOpacity: .9 })
        .bindTooltip(`<b>${esc(s.name || s.station)}</b> · ${LEVEL_TEXT[s.level] || 'unknown'}<br>${s.lateCount} late (≥ ${t.minutes} min) · ${s.canceledCount} canceled`)
        .addTo(layer);
      pts.push([s.lat, s.lon]);
    }
    if (!fitted && pts.length > 1) { map.fitBounds(pts, { padding: [20, 20] }); fitted = true; }
    const counts = stations.reduce((a, s) => (a[s.level] = (a[s.level] || 0) + 1, a), {});
    const status = data.upstream === 'no-key' ? ' · demo data' : data.upstream === 'error' ? ' · upstream error, may be stale' : '';
    note.textContent = `${stations.length} stations · ${counts.severe || 0} severe, ${counts.warning || 0} warning` +
      ` · station warning from 1 late train, severe from ${t.trains}${status}`;
  }

  async function poll() {
    try {
      const r = await fetch(`${API}/stations?displayId=${encodeURIComponent(displayId)}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      draw(await r.json());
    } catch (e) {
      note.textContent = `Station data not available (${e.message}). Retrying…`;
    }
  }

  window.addEventListener('peter:thresholds', poll);
  poll();
  setInterval(poll, POLL_MS);
})();
