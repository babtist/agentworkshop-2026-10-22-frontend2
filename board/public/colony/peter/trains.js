// Live commuter trains on the map (babtist GET /api/trains, shape agreed in #build post 128).
// One arrow per train, rotated by bearing (dot when bearing is null), coloured by delay; click for details.
// Optional layer: if the endpoint is missing or fails, the station map keeps working.
(() => {
  const API = '/t/babtist/api/trains';
  const POLL_MS = 10000;
  const STALE_MS = 2 * 60 * 1000;
  const pm = window.peterMap;
  if (!pm || !window.L) return;
  const { map, layers } = pm;

  const layer = L.layerGroup();
  layers.addOverlay(layer, 'Trains');
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  const q = new URLSearchParams(location.search);
  const want = q.has('trains') ? q.get('trains') !== '0' : store.get('peter.trains') !== '0';
  if (want) layer.addTo(map);
  map.on('overlayadd', (e) => { if (e.layer === layer) { store.set('peter.trains', '1'); poll(); } });
  map.on('overlayremove', (e) => { if (e.layer === layer) store.set('peter.trains', '0'); });

  const note = document.getElementById('mapNote');
  const trainNote = document.createElement('div');
  trainNote.className = 'map-note';
  note.after(trainNote);

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const time = (iso) => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '–'; };
  const age = (ms) => ms < 60000 ? `${Math.max(0, Math.round(ms / 1000))} s` : `${Math.round(ms / 60000)} min`;

  // Delay class against the display's minutes threshold Y: on time below Y, late from Y, very late from 2Y.
  function classify(t, minutes) {
    if (t.canceled) return ['canceled', 'Canceled'];
    if (typeof t.delayMinutes !== 'number') return ['unknown', 'No delay reported yet'];
    if (t.delayMinutes >= 2 * minutes) return ['severe', `${t.delayMinutes} min late`];
    if (t.delayMinutes >= minutes) return ['warning', `${t.delayMinutes} min late`];
    return ['ok', t.delayMinutes > 0 ? `${t.delayMinutes} min late` : 'On time'];
  }

  // A small commuter-train body seen from above, nose pointing up (rotated by bearing). Canceled: grey with a cross.
  const BODY = 'M12 2C17 2 20 6 20 11V36a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V11C4 6 7 2 12 2Z';
  const trainSvg = (cls) => `<svg class="tm-body" viewBox="0 0 24 41" aria-hidden="true">
      <path d="${BODY}" />
      <path class="tm-glass" d="M7.5 10.5Q12 6.5 16.5 10.5V13.5H7.5Z" />
      <rect class="tm-win" x="8" y="17" width="8" height="2.6" rx="1.2" /><rect class="tm-win" x="8" y="22.5" width="8" height="2.6" rx="1.2" />
      <rect class="tm-win" x="8" y="28" width="8" height="2.6" rx="1.2" />
      ${cls === 'canceled' ? '<path class="tm-cross" d="M5 15L19 35M19 15L5 35" />' : ''}</svg>`;

  function icon(cls, bearing, stale, label) {
    const dir = typeof bearing === 'number';
    const body = dir ? `<span class="tm-rot" style="transform:rotate(${bearing}deg)">${trainSvg(cls)}</span>`
      : `<span class="tm-rot tm-nodir">${trainSvg(cls)}</span>`;
    return L.divIcon({
      className: `train-marker tm-${cls}${stale ? ' tm-stale' : ''}`,
      html: `${cls === 'severe' ? '<span class="tm-halo"></span>' : ''}${body}<span class="tm-label">${esc(label)}</span>`,
      iconSize: [42, 42], iconAnchor: [21, 21], popupAnchor: [0, -18],
    });
  }

  // Train legend row, shown only while the Trains layer is on.
  const legendRow = document.createElement('div');
  legendRow.className = 'lg-trains';
  legendRow.innerHTML = 'Trains: ' + [['ok', 'on time'], ['warning', 'late'], ['severe', 'very late'], ['unknown', 'no data'], ['canceled', 'canceled']]
    .map(([c, t]) => `<span class="tm-${c}"><i class="lg-train"></i>${t}</span>`).join('');
  const showLegend = () => { const lg = document.querySelector('.map-legend'); if (lg && !legendRow.isConnected) lg.append(legendRow); legendRow.hidden = !map.hasLayer(layer); };
  map.on('overlayadd overlayremove', showLegend); showLegend();

  // Train numbers only when zoomed in; no glide while Leaflet re-positions markers on zoom.
  const box = map.getContainer();
  const labels = () => { box.classList.toggle('show-train-labels', map.getZoom() >= 11); box.classList.toggle('small-trains', map.getZoom() < 10); };
  map.on('zoomend', labels); labels();
  map.on('zoomstart', () => box.classList.add('no-glide'));
  map.on('zoomend', () => setTimeout(() => box.classList.remove('no-glide'), 50));

  // `to` is a list of destination station signatures (babtist CONTRACT.md); show names where the station list knows them.
  const dest = (to) => (Array.isArray(to) ? to : to ? [to] : []).map((sig) => pm.names.get(sig) || sig).join(' / ');

  function popup(t, label, ageMs) {
    const next = t.nextStation;
    const last = t.lastStation;
    return `<div class="train-pop"><b>Train ${esc(t.train || t.trainId)}</b>${dest(t.to) ? ` → ${esc(dest(t.to))}` : ''}<br>` +
      `<span class="tp-delay">${esc(label)}</span><br>` +
      (next ? `Next: ${esc(next.name || next.station)} ${time(next.estimated || next.scheduled)}` +
        (next.estimated && next.scheduled && next.estimated !== next.scheduled ? ` (planned ${time(next.scheduled)})` : '') + '<br>' : '') +
      (last ? `Last: ${esc(last.name || last.station)} ${time(last.at)}<br>` : '') +
      `<small>Position ${age(ageMs)} old${ageMs > STALE_MS ? ' – may be out of date' : ''}</small></div>`;
  }

  const markers = new Map();
  function draw(data) {
    const minutes = pm.thresholds?.minutes || 5;
    // A backend restart briefly answers "no-key" with no trains: keep the last positions instead of blanking the map.
    if (data.upstream !== 'ok' && !(data.trains || []).length && markers.size) {
      trainNote.textContent = `${markers.size} trains from the last update, the train feed is reconnecting`;
      return;
    }
    const now = Date.now();
    const seen = new Set();
    const counts = { late: 0, canceled: 0 };
    for (const t of data.trains || []) {
      if (typeof t.lat !== 'number' || typeof t.lon !== 'number' || !t.trainId) continue;
      const id = String(t.trainId);
      seen.add(id);
      const [cls, label] = classify(t, minutes);
      if (cls === 'warning' || cls === 'severe') counts.late++;
      if (cls === 'canceled') counts.canceled++;
      const ageMs = now - new Date(t.positionAt).getTime();
      const stale = !(ageMs <= STALE_MS);
      let m = markers.get(id);
      if (!m) {
        m = L.marker([t.lat, t.lon], { keyboard: true, riseOnHover: true }).bindPopup('').addTo(layer);
        markers.set(id, m);
      } else {
        m.setLatLng([t.lat, t.lon]);
      }
      const key = `${cls}|${t.bearing}|${stale}`;
      if (m.iconKey !== key) { m.setIcon(icon(cls, t.bearing, stale, t.train || id)); m.iconKey = key; }
      m.setZIndexOffset(cls === 'severe' ? 300 : cls === 'warning' ? 200 : 0);
      m.options.title = `Train ${t.train || id}: ${label}`;
      m.getElement()?.setAttribute('title', m.options.title);
      m.setPopupContent(popup(t, label, isNaN(ageMs) ? Infinity : ageMs));
    }
    for (const [id, m] of markers) if (!seen.has(id)) { layer.removeLayer(m); markers.delete(id); }
    const status = data.upstream === 'no-key' ? ' (demo data)' : data.upstream === 'error' ? ' (upstream error, may be stale)' : '';
    trainNote.textContent = `${markers.size} trains on the map, pointing the way they run, ${counts.late} late ≥ ${minutes} min, ${counts.canceled} canceled${status}`;
  }

  async function poll() {
    if (!map.hasLayer(layer) || document.hidden) return;
    try {
      const r = await fetch(`${API}?displayId=${encodeURIComponent(document.body.dataset.displayId || '')}`, { cache: 'no-store' });
      if (r.status === 404) { trainNote.textContent = 'Live train positions are not switched on yet'; return; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      draw(await r.json());
    } catch (e) {
      trainNote.textContent = `Train positions not available (${e.message})`;
    }
  }

  document.addEventListener('visibilitychange', poll);
  poll();
  setInterval(poll, POLL_MS);
})();
