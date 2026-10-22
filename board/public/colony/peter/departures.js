// Full-screen departure board for one station, in the style of an SL platform sign.
// Data: babtist GET /api/stations/:station/next (every 15 s) and /api/stations (names, level, thresholds, every 60 s).
// URL: departures.html?station=Sod[&displayId=default]
(() => {
  const API = '/t/babtist/api';
  const NEXT_MS = 15000, STATIONS_MS = 60000, STALE_MS = 60000, ROWS = 8;
  const q = new URLSearchParams(location.search);
  const displayId = q.get('displayId') || 'default';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hhmm = (d) => d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };

  let code = q.get('station') || store.get('peter.station');
  let stations = new Map(), minutesY = 5, next = null, err = null, nextAt = 0;

  async function loadStations() {
    try {
      const r = await fetch(`${API}/stations?displayId=${encodeURIComponent(displayId)}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      stations = new Map((d.stations || []).map((s) => [s.station, s]));
      minutesY = d.thresholds?.minutes || minutesY;
      const names = [...stations.values()].sort((a, b) => a.name.localeCompare(b.name, 'sv'));
      $('pickList').innerHTML = names.map((s) => `<option value="${esc(s.name)}"></option>`).join('');
      if (!code || !stations.has(code)) openPicker();
    } catch { /* names fall back to /next */ }
    render();
  }

  async function loadNext() {
    if (!code || document.hidden) return;
    nextAt = Date.now();
    const want = code;
    try {
      const r = await fetch(`${API}/stations/${encodeURIComponent(want)}/next?limit=${ROWS + 4}`, { cache: 'no-store' });
      if (want !== code) return;
      if (r.status === 404) throw new Error('departures are not switched on yet');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      next = await r.json(); err = null;
    } catch (e) {
      if (want === code) err = e.message;
    }
    render();
  }

  // One readable line of service information for a train: track change first, then deviations and notes.
  function infoFor(t) {
    const out = [];
    if (t.trackChanged) out.push(`<b class="moved-badge">Track changed${t.track ? ` → ${esc(t.track)}` : ''}</b>`);
    for (const d of t.deviations || []) if (d && (d.text || d.code)) out.push(esc(d.text || d.code));
    for (const n of t.notes || []) if (n) out.push(esc(n));
    return out.join(' · ');
  }

  // What the right-hand column says: "Now", "N min", or the clock time when far away.
  function departs(t, now) {
    if (t.canceled) return { txt: 'Canceled', cls: 'can' };
    const at = new Date(t.expected || t.departure?.estimated || t.departure?.scheduled || t.arrival?.scheduled);
    const mins = Math.round((at - now) / 60000);
    const d = t.delayMinutes || 0;
    const cls = d >= 2 * minutesY ? 'sev' : d >= minutesY ? 'late' : '';
    if (mins <= 0) return { txt: 'Now', cls: cls || 'now' };
    return { txt: mins < 60 ? `${mins} min` : hhmm(at), cls };
  }

  function render() {
    const now = new Date();
    $('clock').textContent = now.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const s = stations.get(code);
    const name = s?.name || next?.name || code || 'Choose a station';
    $('station').textContent = name;
    document.title = `${name} · Departures`;

    const list = (next?.trains || []).slice(0, ROWS);
    // Track and service info are additive /next fields (babtist): the column appears once any train carries one.
    document.body.classList.toggle('has-track', list.some((t) => 'track' in t));
    const rows = $('rows');
    let html;
    if (!code) html = '';
    else if (!next && !err) html = '<li class="msg">Loading departures…</li>';
    else if (!list.length) {
      html = `<li class="msg">${err ? `No departures: ${esc(err)}` : next?.upstream && next.upstream !== 'ok' ? 'Train data is reconnecting…' : 'No trains in the next 30 minutes'}</li>`;
    } else {
      html = list.map((t, i) => {
        const when = t.departure || t.arrival || {};
        const sched = new Date(when.scheduled || t.expected);
        const to = (t.to || []).map((x) => x.name || x.station).join(' / ') || '–';
        const dep = departs(t, now);
        const d = t.delayMinutes || 0;
        const late = !t.canceled && d > 0 ? `<em class="${d >= 2 * minutesY ? 'sev' : d >= minutesY ? 'late' : 'minor'}">+${d}</em>` : '';
        const track = t.track == null || t.track === '' ? '–' : esc(t.track);
        const info = infoFor(t);
        return `<li class="row${i === 0 ? ' first' : ''}${t.canceled ? ' canceled' : ''}${t.trackChanged ? ' moved' : ''}">
          <span class="c-time">${hhmm(sched)}${late}</span>
          <span class="c-track" title="${t.trackChanged ? 'Track changed' : 'Track'}">${track}</span>
          <span class="c-train">${esc(t.train)}</span>
          <span class="c-to">${esc(to)}</span>
          <span class="c-dep ${dep.cls}">${dep.txt}</span>${info ? `
          <span class="c-info">${info}</span>` : ''}</li>`;
      }).join('');
    }
    // Only touch the DOM when something changed, so blinking cells keep their rhythm.
    if (rows.dataset.html !== html) { rows.dataset.html = html; rows.innerHTML = html; }

    const late = list.filter((t) => !t.canceled && (t.delayMinutes || 0) >= minutesY).length;
    const can = list.filter((t) => t.canceled).length;
    const age = next?.updatedAt ? now - new Date(next.updatedAt) : null;
    const parts = [];
    if (late || can) parts.push(`${late} late${can ? `, ${can} canceled` : ''} among the next ${list.length} departures`);
    else if (list.length) parts.push('All upcoming departures on time');
    if (s?.level === 'severe') parts.push('Severe delays at this station');
    else if (s?.level === 'warning') parts.push('Delays at this station');
    for (const t of list) {
      const to = (t.to || []).map((x) => x.name || x.station).join(' / ');
      if (t.trackChanged) parts.push(`Train ${t.train} to ${to}: track changed${t.track ? ` to ${t.track}` : ''}`);
      const msg = [...(t.deviations || []).map((x) => x.text || x.code), ...(t.notes || [])].filter(Boolean);
      if (msg.length) parts.push(`Train ${t.train} to ${to}: ${msg.join(', ')}`);
    }
    if (err && next) parts.push(`Could not refresh (${err}), showing the last list`);
    if (age != null) parts.push(`Updated ${new Date(next.updatedAt).toLocaleTimeString('sv-SE')}${age > STALE_MS ? ', may be out of date' : ''}`);
    parts.push(`"Late" means ${minutesY} min or more`);
    const tick = parts.join('   •   ');
    const el = $('ticker');
    if (el.dataset.txt !== tick) { el.dataset.txt = tick; el.textContent = tick; }
    document.body.classList.toggle('stale', age > STALE_MS);
    document.body.classList.toggle('alert', s?.level === 'severe');
  }

  function openPicker() {
    const dlg = $('picker');
    if (dlg.open) return;
    $('pick').value = stations.get(code)?.name || '';
    $('pickMiss').hidden = true;
    dlg.showModal();
  }

  function choose(text) {
    const t = text.trim().toLowerCase();
    const all = [...stations.values()];
    return all.find((s) => s.name.toLowerCase() === t || s.station.toLowerCase() === t)
      || all.find((s) => s.name.toLowerCase().startsWith(t))
      || all.find((s) => s.name.toLowerCase().includes(t));
  }

  $('station').addEventListener('click', openPicker);
  $('pickForm').addEventListener('submit', (e) => {
    const s = choose($('pick').value);
    if (!s) { e.preventDefault(); $('pickMiss').hidden = false; return; }
    code = s.station; next = null; err = null;
    store.set('peter.station', code);
    const u = new URL(location.href); u.searchParams.set('station', code); history.replaceState(null, '', u);
    render(); loadNext();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - nextAt > NEXT_MS) loadNext(); });

  loadStations(); loadNext();
  setInterval(loadStations, STATIONS_MS);
  setInterval(loadNext, NEXT_MS);
  setInterval(render, 1000);
})();
