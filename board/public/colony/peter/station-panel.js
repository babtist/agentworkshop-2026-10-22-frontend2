// Station panel beside the map: the selected station (map click or search) and its next trains
// (babtist GET /api/stations/:station/next). Selection survives refreshes and reloads (?station=Sod or localStorage).
(() => {
  const API = '/t/babtist/api';
  const NEXT_MS = 20000;
  const STALE_MS = 60000;
  const pm = window.peterMap;
  const panel = document.getElementById('stationPanel');
  if (!pm || !panel) { if (panel) panel.hidden = true; return; }

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };
  const hhmm = (iso) => { const d = iso && new Date(iso); return d && !isNaN(d) ? d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' }) : '–'; };
  const LEVEL = { ok: 'Normal', warning: 'Delays', severe: 'Severe delays' };

  const search = $('stationSearch'), list = $('stationList'), body = $('stationBody'), fresh = $('stationFresh');
  let current = null, next = null, nextErr = null, nextAt = 0, timer = null, restored = false;

  function fillList() {
    const names = [...pm.stations.values()].sort((a, b) => a.name.localeCompare(b.name, 'sv'));
    const sig = names.map((s) => s.station).join(',');
    if (list.dataset.sig === sig) return;
    list.dataset.sig = sig;
    list.innerHTML = names.map((s) => `<option value="${esc(s.name)}"></option>`).join('');
  }

  function find(text) {
    const q = text.trim().toLowerCase();
    if (!q) return null;
    const all = [...pm.stations.values()];
    return all.find((s) => s.name.toLowerCase() === q || s.station.toLowerCase() === q)
      || all.find((s) => s.name.toLowerCase().startsWith(q))
      || all.find((s) => s.name.toLowerCase().includes(q)) || null;
  }

  function rows(data) {
    const list = (data.trains || []).slice(0, 10);
    if (!list.length) {
      return `<p class="sp-note">${data.upstream && data.upstream !== 'ok' ? 'Train data is reconnecting, try again shortly.' : 'No trains here in the next 30 minutes.'}</p>`;
    }
    const y = pm.thresholds?.minutes || 5;
    // Track and service info are additive /next fields (babtist); the column shows once any train carries one.
    const hasTrack = list.some((t) => 'track' in t);
    const cols = hasTrack ? 5 : 4;
    return `<table class="next-trains sp-table"><thead><tr><th>Time</th>${hasTrack ? '<th title="Track">Tr.</th>' : ''}<th>Train</th><th>To</th><th>Status</th></tr></thead><tbody>${list.map((t) => {
      const when = t.departure || t.arrival || {};
      const to = (t.to || []).map((x) => (typeof x === 'string' ? pm.names.get(x) || x : x.name || x.station)).join(', ');
      const d = t.delayMinutes || 0;
      const [cls, txt] = t.canceled ? ['np-can', 'canceled'] : d >= 2 * y ? ['np-sev', `+${d} min`]
        : d >= y ? ['np-late', `+${d} min`] : d > 0 ? ['np-minor', `+${d} min`] : ['np-ok', 'on time'];
      const est = !t.canceled && when.estimated && when.estimated !== when.scheduled ? ` <s>${hhmm(when.scheduled)}</s> ${hhmm(when.estimated)}` : hhmm(when.scheduled || t.expected);
      const track = hasTrack ? `<td class="sp-track${t.trackChanged ? ' sp-moved' : ''}" title="${t.trackChanged ? 'Track changed' : 'Track'}">${t.track == null || t.track === '' ? '–' : esc(t.track)}</td>` : '';
      const info = [
        t.trackChanged ? `<b class="sp-moved-badge">Track changed${t.track ? ` → ${esc(t.track)}` : ''}</b>` : '',
        ...(t.deviations || []).map((x) => esc(x?.text || x?.code || '')),
        ...(t.notes || []).map((x) => esc(x || '')),
      ].filter(Boolean).join(' · ');
      return `<tr${info ? ' class="sp-has-info"' : ''}><td>${est}</td>${track}<td>${esc(t.train)}</td><td>${esc(to)}</td><td class="${cls}">${txt}</td></tr>` +
        (info ? `<tr class="sp-info"><td colspan="${cols}">${info}</td></tr>` : '');
    }).join('')}</tbody></table>`;
  }

  function render() {
    if (!current) {
      body.innerHTML = '<p class="sp-note">Click a station on the map, or search for one above.</p>';
      fresh.textContent = '';
      return;
    }
    const s = pm.stations.get(current) || { station: current, name: pm.names.get(current) || current };
    const lvl = s.level in LEVEL ? s.level : 'unknown';
    const head = `<div class="sp-head"><h3>${esc(s.name)}</h3><span class="sp-badge sp-${lvl}">${LEVEL[lvl] || 'No data'}</span></div>` +
      `<a class="sp-board" href="departures.html?station=${encodeURIComponent(s.station)}" target="_blank" rel="noopener">Open as departure board ↗</a>` +
      (s.lateCount != null ? `<p class="sp-sum">${s.lateCount} late, ${s.canceledCount} canceled right now</p>` : '');
    body.innerHTML = head + (nextErr ? `<p class="sp-note sp-err">${esc(nextErr)}</p>` : next ? rows(next) : '<p class="sp-note">Loading next trains…</p>');
    const age = next?.updatedAt ? Date.now() - new Date(next.updatedAt).getTime() : null;
    fresh.textContent = next?.updatedAt ? `Updated ${new Date(next.updatedAt).toLocaleTimeString('sv-SE')}` + (age > STALE_MS ? ', may be out of date' : '') : '';
    fresh.classList.toggle('stale', age > STALE_MS);
  }

  async function load(force) {
    if (!current || document.hidden) return;
    if (!force && Date.now() - nextAt < NEXT_MS) return;
    nextAt = Date.now();
    const code = current;
    try {
      const r = await fetch(`${API}/stations/${encodeURIComponent(code)}/next?limit=10`, { cache: 'no-store' });
      if (code !== current) return;
      if (r.status === 404) { next = null; nextErr = 'Next-train list is not switched on yet.'; }
      else if (!r.ok) throw new Error(`HTTP ${r.status}`);
      else { next = await r.json(); nextErr = null; }
    } catch (e) {
      if (code !== current) return;
      nextErr = next ? `Could not refresh (${e.message}), showing the last list.` : `Could not load next trains (${e.message}).`;
    }
    render();
  }

  window.addEventListener('peter:station', (e) => {
    const code = e.detail.code;
    if (code === current) return;
    current = code; next = null; nextErr = null;
    store.set('peter.station', code);
    const s = pm.stations.get(code);
    if (s && document.activeElement !== search) search.value = s.name;
    render();
    load(true);
    clearInterval(timer);
    timer = setInterval(load, NEXT_MS);
    if (window.matchMedia('(max-width: 999px)').matches && e.detail.fromMap !== false) {
      const r = panel.getBoundingClientRect();
      if (r.top > innerHeight || r.bottom < 0) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });

  window.addEventListener('peter:stations', () => {
    fillList();
    if (!restored) {
      restored = true;
      const want = new URLSearchParams(location.search).get('station') || store.get('peter.station');
      if (want && pm.stations.has(want)) pm.select(want);
      else render();
    } else if (current) render();
  });
  window.addEventListener('peter:thresholds', () => render());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

  $('stationForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const s = find(search.value);
    $('stationMiss').hidden = !!s;
    if (s) { search.value = s.name; pm.select(s.station, { pan: true }); }
  });
  // Picking a suggestion from the list selects right away.
  search.addEventListener('input', () => {
    $('stationMiss').hidden = true;
    const s = [...pm.stations.values()].find((x) => x.name === search.value);
    if (s) pm.select(s.station, { pan: true });
  });
  render();
})();
