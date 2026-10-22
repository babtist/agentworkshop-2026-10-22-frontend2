// Team peter's presentation tile. All data comes from babtist's controller (projects/babtist/CONTRACT.md).
// Modes (query string): ?displayId=a (one display, live via SSE), ?displays=a,b,c (wall overview, polled),
// ?kiosk=1 (no controls, large type). The trend lives only in this page's memory.
(() => {
  const API = '/t/babtist/api';
  const POLL_MS = 20000;
  const WALL_POLL_MS = 15000;
  const STALE_MS = 90000;
  const TREND_MS = 60 * 60 * 1000;
  const MAX_WALL = 12;
  const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
  const LABEL = { ok: 'Normal', warning: 'Delays', severe: 'Severe delays' };
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  const q = new URLSearchParams(location.search);
  const kiosk = q.get('kiosk') === '1';
  const parseIds = (s) => [...new Set((s || '').split(',').map((x) => x.trim()).filter((x) => ID_RE.test(x)))].slice(0, MAX_WALL);
  let ids = parseIds(q.get('displays'));
  if (!ids.length) ids = parseIds(q.get('displayId'));
  if (!ids.length) ids = ['default'];
  const wall = ids.length > 1;

  document.body.classList.toggle('kiosk', kiosk);
  document.body.classList.toggle('wall', wall);

  // ---------- one card per display ----------
  function makeCard(id) {
    const root = el('section', 'card lvl-unknown');
    root.setAttribute('aria-live', 'polite');
    const title = el('a', 'title', id);
    title.href = `?displayId=${encodeURIComponent(id)}${kiosk ? '&kiosk=1' : ''}`;
    const level = el('div', 'level', '…');
    const summary = el('div', 'summary', 'Connecting to the controller…');
    const stats = el('div', 'stats');
    const stat = (label) => { const d = el('div'); const b = el('b', null, '–'); d.append(b, el('span', null, label)); stats.append(d); return b; };
    const late = stat('late'), canceled = stat('canceled'), maxDelay = stat('max delay (min)'), tracked = stat('trains tracked');
    const trendBox = el('div', 'trend');
    const notice = el('div', 'notice'); notice.hidden = true;
    const meta = el('div', 'meta');
    root.append(title, level, summary, stats, trendBox, notice, meta);

    const card = { id, root, lastAt: 0, samples: [], minutes: null, thresholds: null };

    card.setNotice = (text) => { notice.hidden = !text; notice.textContent = text; };

    card.render = (s) => {
      card.lastAt = Date.now();
      const lvl = LABEL[s.level] ? s.level : 'unknown';
      const t = s.thresholds || {};
      card.thresholds = t;
      root.className = 'card lvl-' + lvl;
      level.textContent = LABEL[lvl] || '?';
      summary.textContent = `${s.lateCount} train${s.lateCount === 1 ? '' : 's'} ≥ ${t.minutes} min late · warning at ${t.trains}, severe at ${t.trains * 2}`;
      late.textContent = s.lateCount;
      canceled.textContent = s.canceledCount;
      maxDelay.textContent = s.maxDelayMinutes;
      tracked.textContent = s.trainsTracked;
      card.setNotice(s.upstream === 'no-key' ? 'Demo data: the controller has no Trafikverket API key.'
        : s.upstream === 'error' ? 'Trafikverket could not be reached: the numbers may be out of date.' : '');
      meta.textContent = `updated ${s.updatedAt ? new Date(s.updatedAt).toLocaleTimeString() : '–'}`;
      addSample(card, s, t);
      drawTrend(trendBox, card);
    };

    card.offline = (msg) => {
      root.className = 'card lvl-unknown';
      level.textContent = 'No data';
      summary.textContent = msg;
    };

    card.poll = async () => {
      try {
        const r = await fetch(`${API}/status?displayId=${encodeURIComponent(id)}`, { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        card.render(await r.json());
      } catch (e) {
        card.offline(`Controller not reachable (${e.message}). Retrying…`);
      }
    };
    return card;
  }

  // ---------- trend: late trains over the last hour, in memory only ----------
  function addSample(card, s, t) {
    // A new minutes threshold changes what "late" means, so the old curve no longer compares.
    if (card.minutes !== t.minutes) { card.samples = []; card.minutes = t.minutes; }
    const now = Date.now();
    const last = card.samples[card.samples.length - 1];
    if (last && now - last.t < 10000) last.v = s.lateCount;
    else card.samples.push({ t: now, v: s.lateCount });
    while (card.samples.length && now - card.samples[0].t > TREND_MS) card.samples.shift();
  }

  function drawTrend(box, card) {
    const pts = card.samples;
    const t = card.thresholds || {};
    const W = 300, H = 48, now = Date.now();
    const top = Math.max(2, (t.trains || 1) * 2 + 1, ...pts.map((p) => p.v));
    const x = (ts) => (W * (1 - (now - ts) / TREND_MS)).toFixed(1);
    const y = (v) => (H - 2 - (H - 4) * (v / top)).toFixed(1);
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Late trains over the last hour: ${pts.map((p) => p.v).join(', ')}`);
    const line = (v, cls) => {
      const l = document.createElementNS(ns, 'line');
      l.setAttribute('x1', 0); l.setAttribute('x2', W); l.setAttribute('y1', y(v)); l.setAttribute('y2', y(v));
      l.setAttribute('class', cls); svg.append(l);
    };
    if (t.trains) { line(t.trains, 'th-warning'); line(t.trains * 2, 'th-severe'); }
    if (pts.length) {
      const d = pts.map((p) => `${x(p.t)},${y(p.v)}`);
      if (pts.length === 1) d.unshift(`${x(pts[0].t) - 2},${y(pts[0].v)}`);
      const pl = document.createElementNS(ns, 'polyline');
      pl.setAttribute('points', d.join(' '));
      pl.setAttribute('class', 'curve');
      svg.append(pl);
      const lastPt = pts[pts.length - 1];
      const dot = document.createElementNS(ns, 'rect');
      dot.setAttribute('x', W - 5); dot.setAttribute('y', y(lastPt.v) - 2.5);
      dot.setAttribute('width', 5); dot.setAttribute('height', 5);
      dot.setAttribute('class', 'dot');
      svg.append(dot);
    }
    const span = Math.round((now - (pts[0]?.t ?? now)) / 60000);
    const cap = el('div', 'trend-cap', `late trains, last ${span < 1 ? '<1' : span} min (page memory only)`);
    box.replaceChildren(svg, cap);
  }

  // ---------- page ----------
  const grid = $('grid');
  const cards = ids.map(makeCard);
  grid.replaceChildren(...cards.map((c) => c.root));

  if (wall) {
    // Polling, not one SSE per display: browsers cap connections per origin and babtist caps streams.
    const tick = () => cards.forEach((c) => c.poll());
    tick();
    setInterval(tick, WALL_POLL_MS);
  } else {
    const c = cards[0];
    c.poll();
    setInterval(() => { if (Date.now() - c.lastAt >= POLL_MS) c.poll(); }, POLL_MS);
    if ('EventSource' in window) {
      const es = new EventSource(`${API}/stream?displayId=${encodeURIComponent(c.id)}`);
      es.addEventListener('status', (ev) => {
        try { c.render(JSON.parse(ev.data)); } catch {}
      });
    }
  }

  setInterval(() => cards.forEach((c) => {
    if (c.lastAt && Date.now() - c.lastAt > STALE_MS) c.setNotice('No update for over a minute: data may be stale.');
  }), 10000);

  // ---------- controls (hidden in kiosk mode) ----------
  $('displayIds').value = ids.join(',');
  $('pick').addEventListener('submit', (e) => {
    e.preventDefault();
    const list = parseIds($('displayIds').value);
    if (!list.length) return;
    const u = new URL(location.href);
    u.searchParams.delete('displayId');
    u.searchParams.delete('displays');
    u.searchParams.set(list.length > 1 ? 'displays' : 'displayId', list.join(','));
    location.href = u.toString();
  });
  $('kioskLink').href = (() => { const u = new URL(location.href); u.searchParams.set('kiosk', '1'); return u.toString(); })();

  function syncForm(c) {
    if (document.activeElement === $('trains') || document.activeElement === $('minutes')) return;
    $('trains').value = c.thresholds?.trains ?? '';
    $('minutes').value = c.thresholds?.minutes ?? '';
  }

  if (wall) {
    $('settings').hidden = true;
  } else {
    const c = cards[0];
    const origRender = c.render;
    c.render = (s) => { origRender(s); syncForm(c); };
    $('settingsFor').textContent = c.id;
    $('thresholds').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = { trains: Number($('trains').value), minutes: Number($('minutes').value) };
      $('saveMsg').textContent = 'Saving…';
      try {
        const r = await fetch(`${API}/displays/${encodeURIComponent(c.id)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        $('saveMsg').textContent = `Saved for "${j.id}".`;
        c.poll();
      } catch (err) {
        $('saveMsg').textContent = `Not saved: ${err.message}`;
      }
    });
  }
})();
