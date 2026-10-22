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
  // Shape + text, not only colour, so the level reads without colour vision.
  const ICON = { ok: '✓', warning: '▲', severe: '✖', unknown: '?' };
  const RANK = { ok: 0, warning: 1, severe: 2 };
  const FLASH_MS = 30000;
  const BASE_TITLE = document.title;
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
  if (!wall) document.body.dataset.displayId = ids[0];

  // ---------- one card per display ----------
  function makeCard(id) {
    const root = el('section', 'card lvl-unknown');
    root.setAttribute('aria-live', 'polite');
    const title = el('a', 'title', id);
    title.href = `?displayId=${encodeURIComponent(id)}${kiosk ? '&kiosk=1' : ''}`;
    const level = el('div', 'level', '…');
    const summary = el('div', 'summary', 'Connecting to the controller…');
    const scale = el('div', 'scale'); scale.hidden = true;
    const stats = el('div', 'stats');
    const stat = (label) => { const d = el('div'); const b = el('b', null, '–'); d.append(b, el('span', null, label)); stats.append(d); return b; };
    const late = stat('late'), canceled = stat('canceled'), maxDelay = stat('max delay (min)'), tracked = stat('trains tracked');
    const trendBox = el('div', 'trend');
    const notice = el('div', 'notice'); notice.hidden = true;
    const meta = el('div', 'meta');
    root.append(title, level, summary, scale, stats, trendBox, notice, meta);

    const card = { id, root, trendBox, lastAt: 0, samples: [], minutes: null, thresholds: null, level: null, flashUntil: 0 };

    card.setNotice = (text) => { notice.hidden = !text; notice.textContent = text; };

    const setLevel = (lvl, text) => {
      level.replaceChildren(el('span', 'icon', ICON[lvl] || ICON.unknown), document.createTextNode(text));
      level.firstChild.setAttribute('aria-hidden', 'true');
    };

    card.render = (s) => {
      card.lastAt = Date.now();
      const lvl = LABEL[s.level] ? s.level : 'unknown';
      const t = s.thresholds || {};
      card.thresholds = t;
      if (card.level in RANK && lvl in RANK && RANK[lvl] > RANK[card.level]) escalate(card, lvl);
      card.level = lvl;
      root.className = 'card lvl-' + lvl + (Date.now() < card.flashUntil ? ' escalated' : '');
      setLevel(lvl, LABEL[lvl] || '?');
      summary.textContent = `${s.lateCount} train${s.lateCount === 1 ? ' is' : 's are'} ${t.minutes} min or more late`;
      drawScale(scale, s.lateCount, t);
      late.textContent = s.lateCount;
      canceled.textContent = s.canceledCount;
      maxDelay.textContent = s.maxDelayMinutes;
      tracked.textContent = s.trainsTracked;
      card.setNotice(s.upstream === 'no-key' ? 'Demo data: the controller has no Trafikverket API key.'
        : s.upstream === 'error' ? 'Trafikverket could not be reached: the numbers may be out of date.' : '');
      meta.textContent = `updated ${s.updatedAt ? new Date(s.updatedAt).toLocaleTimeString() : '–'}`;
      addSample(card, s, t);
      drawTrend(trendBox, card);
      updateTitle();
    };

    card.offline = (msg) => {
      root.className = 'card lvl-unknown';
      setLevel('unknown', 'No data');
      summary.textContent = msg;
      scale.hidden = true;
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

  // ---------- scale: where the late count sits between green, orange and red ----------
  const range = (a, b) => (b <= a ? `${a}` : `${a}–${b}`);
  function bands(t) {
    const y = t.trains;
    return [
      ['ok', y > 1 ? `${range(0, y - 1)} late` : '0 late'],
      ['warning', `${range(y, 2 * y - 1)} late`],
      ['severe', `${2 * y}+ late`],
    ];
  }
  function drawScale(box, n, t) {
    if (!t.trains) { box.hidden = true; return; }
    box.hidden = false;
    const y = t.trains, top = 3 * y;
    const pos = Math.min(100, (Math.min(n, top) / top) * 100);
    const segs = bands(t).map(([cls, txt]) => `<div class="seg seg-${cls}"><span>${txt}</span></div>`).join('');
    box.innerHTML = `<div class="segs">${segs}<div class="marker" style="left:${pos}%"><b>${n}</b></div></div>`;
    box.setAttribute('role', 'img');
    box.setAttribute('aria-label', `${n} late trains. Green below ${y}, orange from ${y}, red from ${2 * y}.`);
  }
  window.peterBands = bands;

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
    const cap = el('div', 'trend-cap', `Late trains, last ${span < 1 ? '<1' : span} min. Dashed lines: orange at ${card.thresholds?.trains ?? '–'}, red at ${card.thresholds?.trains ? card.thresholds.trains * 2 : '–'}.`);
    box.replaceChildren(svg, cap);
  }

  // ---------- escalation alert: tab title, card flash, screen-reader message, optional sound ----------
  let cards = [];
  let flashTimer = null;
  let audio = null;
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  let soundOn = q.get('sound') === '1' || store.get('peter.sound') === '1';

  function worst() {
    return cards.reduce((w, c) => (c.level in RANK && (!(w in RANK) || RANK[c.level] > RANK[w]) ? c.level : w), null);
  }

  function updateTitle(flashOn) {
    const w = worst();
    const base = w && w !== 'ok' ? `${ICON[w]} ${LABEL[w]} · ${BASE_TITLE}` : BASE_TITLE;
    document.title = flashOn && LABEL[w] ? `‼ ${LABEL[w].toUpperCase()} ‼` : base;
  }

  function escalate(card, lvl) {
    card.flashUntil = Date.now() + FLASH_MS;
    setTimeout(() => card.root.classList.remove('escalated'), FLASH_MS);
    $('announcer').textContent = `Display ${card.id} escalated to ${LABEL[lvl]}.`;
    clearInterval(flashTimer);
    let on = false;
    const end = Date.now() + FLASH_MS;
    flashTimer = setInterval(() => {
      on = !on && Date.now() < end;
      updateTitle(on);
      if (Date.now() >= end) clearInterval(flashTimer);
    }, 1000);
    if (soundOn) beep(lvl === 'severe' ? 3 : 1, lvl === 'severe' ? 880 : 660);
  }

  function ensureAudio() {
    if (!audio && (window.AudioContext || window.webkitAudioContext)) audio = new (window.AudioContext || window.webkitAudioContext)();
    if (audio && audio.state === 'suspended') audio.resume().catch(() => {});
    return audio;
  }

  function beep(times, freq) {
    const ctx = ensureAudio();
    if (!ctx) return;
    for (let i = 0; i < times; i++) {
      const o = ctx.createOscillator(), g = ctx.createGain(), t0 = ctx.currentTime + i * 0.35;
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.25);
      o.connect(g).connect(ctx.destination);
      o.start(t0); o.stop(t0 + 0.3);
    }
  }

  // Browsers only allow sound after a user gesture; one click or key press on the page unlocks it (kiosk too).
  const unlock = () => { if (soundOn) ensureAudio(); $('soundHint').hidden = true; };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
  $('sound').checked = soundOn;
  $('soundHint').hidden = !(soundOn && kiosk);
  $('sound').addEventListener('change', () => {
    soundOn = $('sound').checked;
    store.set('peter.sound', soundOn ? '1' : '0');
    if (soundOn) beep(1, 660);
  });

  // ---------- page ----------
  const grid = $('grid');
  cards = ids.map(makeCard);
  window.peterCards = cards;
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

  function preview() {
    const y = Number($('trains').value), m = Number($('minutes').value);
    if (!(y >= 1) || !(m >= 1)) { $('preview').textContent = ''; return; }
    const lbl = { ok: 'Green', warning: 'Orange', severe: 'Red' };
    $('preview').innerHTML = window.peterBands({ trains: y }).map(([cls, txt]) =>
      `<span class="pv pv-${cls}"><b>${lbl[cls]}</b> ${txt.replace('late', `trains ${m}+ min late`)}</span>`).join('');
  }
  $('trains').addEventListener('input', preview);
  $('minutes').addEventListener('input', preview);

  function syncForm(c) {
    if (document.activeElement === $('trains') || document.activeElement === $('minutes')) return;
    $('trains').value = c.thresholds?.trains ?? '';
    $('minutes').value = c.thresholds?.minutes ?? '';
    preview();
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
        window.dispatchEvent(new Event('peter:thresholds'));
      } catch (err) {
        $('saveMsg').textContent = `Not saved: ${err.message}`;
      }
    });
  }
})();
