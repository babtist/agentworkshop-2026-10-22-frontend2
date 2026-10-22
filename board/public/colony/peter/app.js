// Team peter's presentation tile. All data comes from babtist's controller (projects/babtist/CONTRACT.md).
(() => {
  const API = '/t/babtist/api';
  const POLL_MS = 20000;
  const STALE_MS = 90000;
  const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
  const LABEL = { ok: 'Normal', warning: 'Delays', severe: 'Severe delays' };
  const $ = (id) => document.getElementById(id);

  const fromUrl = new URLSearchParams(location.search).get('displayId') || '';
  let displayId = ID_RE.test(fromUrl) ? fromUrl : 'default';
  let es = null, pollTimer = null, lastAt = 0;

  function setNotice(text) {
    $('notice').hidden = !text;
    $('notice').textContent = text;
  }

  function render(s) {
    lastAt = Date.now();
    const level = LABEL[s.level] ? s.level : 'unknown';
    const t = s.thresholds || {};
    $('card').className = 'lvl-' + level;
    $('level').textContent = LABEL[level] || '?';
    $('summary').textContent = `${s.lateCount} train${s.lateCount === 1 ? '' : 's'} at least ${t.minutes} min late (warning at ${t.trains}, severe at ${t.trains * 2})`;
    $('lateCount').textContent = s.lateCount;
    $('canceledCount').textContent = s.canceledCount;
    $('maxDelay').textContent = s.maxDelayMinutes;
    $('tracked').textContent = s.trainsTracked;
    setNotice(s.upstream === 'no-key' ? 'Demo data: the controller has no Trafikverket API key.'
      : s.upstream === 'error' ? 'Trafikverket could not be reached: the numbers may be out of date.' : '');
    $('meta').textContent = `Display "${s.displayId}" · updated ${s.updatedAt ? new Date(s.updatedAt).toLocaleTimeString() : '–'}`;
    if (document.activeElement !== $('trains') && document.activeElement !== $('minutes')) {
      $('trains').value = t.trains ?? '';
      $('minutes').value = t.minutes ?? '';
    }
  }

  function offline(msg) {
    $('card').className = 'lvl-unknown';
    $('level').textContent = 'No data';
    $('summary').textContent = msg;
  }

  async function poll() {
    try {
      const r = await fetch(`${API}/status?displayId=${encodeURIComponent(displayId)}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      render(await r.json());
    } catch (e) {
      offline(`Controller not reachable (${e.message}). Retrying…`);
    }
  }

  function connect() {
    if (es) es.close();
    clearInterval(pollTimer);
    lastAt = 0;
    poll();
    // Polling is the safety net; SSE gives live updates while it is up.
    pollTimer = setInterval(() => { if (Date.now() - lastAt >= POLL_MS) poll(); }, POLL_MS);
    if (!('EventSource' in window)) return;
    es = new EventSource(`${API}/stream?displayId=${encodeURIComponent(displayId)}`);
    es.addEventListener('status', (ev) => { try { render(JSON.parse(ev.data)); } catch {} });
  }

  setInterval(() => {
    if (lastAt && Date.now() - lastAt > STALE_MS) setNotice('No update for over a minute: data may be stale.');
  }, 10000);

  $('displayId').value = displayId;
  $('pick').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('displayId').value.trim();
    if (!ID_RE.test(v)) return;
    displayId = v;
    const u = new URL(location.href);
    u.searchParams.set('displayId', v);
    history.replaceState(null, '', u);
    $('saveMsg').textContent = '';
    connect();
  });

  $('thresholds').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { trains: Number($('trains').value), minutes: Number($('minutes').value) };
    $('saveMsg').textContent = 'Saving…';
    try {
      const r = await fetch(`${API}/displays/${encodeURIComponent(displayId)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      $('saveMsg').textContent = `Saved for "${j.id}".`;
      poll();
    } catch (err) {
      $('saveMsg').textContent = `Not saved: ${err.message}`;
    }
  });

  connect();
})();
