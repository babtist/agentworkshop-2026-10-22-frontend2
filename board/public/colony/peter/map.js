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

  // Station markers are reused across polls so an open "next trains" popup survives a refresh.
  const stationMarkers = new Map();
  const NEXT_MS = 20000;
  const hhmm = (iso) => { const d = iso && new Date(iso); return d && !isNaN(d) ? d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' }) : '–'; };
  function nextHtml(s, data, err) {
    const head = `<b>${esc(s.name || s.station)}</b><br><span class="np-sum">${LEVEL_TEXT[s.level] || 'unknown'} · ${s.lateCount} late · ${s.canceledCount} canceled</span>`;
    if (err) return `${head}<div class="np-note">${esc(err)}</div>`;
    if (!data) return `${head}<div class="np-note">Loading next trains…</div>`;
    const list = (data.trains || data.departures || []).slice(0, 8);
    if (!list.length) return `${head}<div class="np-note">${data.upstream && data.upstream !== 'ok' ? 'Train data is reconnecting, try again shortly.' : 'No trains in the next 30 minutes.'}</div>`;
    const rows = list.map((t) => {
      const when = t.departure || t.arrival || {};
      const to = (t.to || []).map((x) => (typeof x === 'string' ? window.peterMap.names.get(x) || x : x.name || x.station)).join(', ');
      const d = t.delayMinutes || 0;
      const y = window.peterMap.thresholds?.minutes || 5;
      const [cls, txt] = t.canceled ? ['np-can', 'canceled'] : d >= 2 * y ? ['np-sev', `+${d} min`]
        : d >= y ? ['np-late', `+${d} min`] : d > 0 ? ['np-minor', `+${d} min`] : ['np-ok', 'on time'];
      return `<tr><td>${hhmm(when.scheduled || t.expected)}</td><td>${esc(t.train || '')}</td><td>${esc(to)}</td><td class="${cls}">${txt}</td></tr>`;
    }).join('');
    return `${head}<table class="next-trains"><thead><tr><th>Time</th><th>Train</th><th>To</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  async function loadNext(m) {
    const s = m.station;
    if (m.nextAt && Date.now() - m.nextAt < NEXT_MS) return;
    m.nextAt = Date.now();
    try {
      const r = await fetch(`${API}/stations/${encodeURIComponent(s.station)}/next?limit=10`, { cache: 'no-store' });
      if (r.status === 404) { m.nextErr = 'Next-train list is not switched on yet.'; m.next = null; }
      else if (!r.ok) throw new Error(r.status);
      else { m.next = await r.json(); m.nextErr = null; }
    } catch { m.nextErr = 'Could not load next trains right now.'; }
    if (m.isPopupOpen()) m.setPopupContent(nextHtml(m.station, m.next, m.nextErr));
  }
  function stationMarker(s) {
    let m = stationMarkers.get(s.station);
    if (!m) {
      m = L.circleMarker([s.lat, s.lon]).bindTooltip('').bindPopup('', { maxWidth: 320, className: 'next-popup' }).addTo(layer);
      m.on('popupopen', () => {
        m.setPopupContent(nextHtml(m.station, m.next, m.nextErr));
        loadNext(m);
        m.timer = setInterval(() => loadNext(m), NEXT_MS);
      });
      m.on('popupclose', () => clearInterval(m.timer));
      stationMarkers.set(s.station, m);
    }
    m.station = s;
    return m;
  }

  function draw(data) {
    const t = data.thresholds || {};
    window.peterMap.thresholds = data.thresholds || null;
    for (const s of data.stations || []) if (s.station && s.name) window.peterMap.names.set(s.station, s.name);
    const pts = [];
    // Severe last so it is drawn on top where markers overlap.
    const order = { ok: 0, warning: 1, severe: 2 };
    const stations = (data.stations || []).filter((s) => typeof s.lat === 'number' && typeof s.lon === 'number')
      .sort((a, b) => (order[a.level] ?? 0) - (order[b.level] ?? 0));
    const seen = new Set();
    for (const s of stations) {
      const color = COLOR[s.level] || '#8a98b3';
      const radius = 5 + Math.min(10, Math.sqrt(s.lateCount || 0) * 3);
      const [ring, weight] = RING[s.level] || RING.ok;
      const m = stationMarker(s);
      seen.add(s.station);
      m.setLatLng([s.lat, s.lon]).setRadius(radius).setStyle({ color: ring, weight, fillColor: color, fillOpacity: .9 });
      m.setTooltipContent(`<b>${esc(s.name || s.station)}</b> · ${LEVEL_TEXT[s.level] || 'unknown'}<br>${s.lateCount} late (≥ ${t.minutes} min) · ${s.canceledCount} canceled<br><i>Click for next trains</i>`);
      m.bringToFront();
      if (m.isPopupOpen()) m.setPopupContent(nextHtml(s, m.next, m.nextErr));
      pts.push([s.lat, s.lon]);
    }
    for (const [id, m] of stationMarkers) if (!seen.has(id)) { clearInterval(m.timer); layer.removeLayer(m); stationMarkers.delete(id); }
    if (!fitted && pts.length > 1) { map.fitBounds(pts, { padding: [20, 20] }); fitted = true; }
    const counts = stations.reduce((a, s) => (a[s.level] = (a[s.level] || 0) + 1, a), {});
    const status = data.upstream === 'no-key' ? ' · demo data' : data.upstream === 'error' ? ' · upstream error, may be stale' : '';
    note.textContent = `${stations.length} stations · ${counts.severe || 0} severe, ${counts.warning || 0} warning` +
      ` · station warning from 1 late train, severe from ${t.trains} (stops in the last 15 min and ahead)${status}`;
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
