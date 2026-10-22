// Station notices (babtist GET /api/notices, Trafikverket TrainStationMessage): a strip under the header with the
// texts on station screens right now, and window.peterNotices for the station panel. 404 before release = not yet.
(() => {
  const API = '/t/babtist/api';
  const POLL_MS = 60000, SHOW = 3;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const strip = document.getElementById('noticeStrip');
  const state = window.peterNotices = { list: [], ok: false, forStation: (code) => state.list.filter((n) => (n.stations || []).some((s) => s.station === code)) };

  const where = (n) => {
    const names = (n.stations || []).map((s) => s.name || s.station);
    return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
  };
  const item = (n) => `<li class="ns-${esc(n.priority || 'normal')}"><span class="ns-where">${esc(where(n))}</span> ${esc(n.text)}</li>`;

  function render() {
    if (!strip) return;
    const list = state.list;
    strip.hidden = !list.length;
    if (!list.length) { strip.innerHTML = ''; return; }
    const html = `<span class="ns-label">Station notices</span><ul>${list.slice(0, SHOW).map(item).join('')}</ul>` +
      (list.length > SHOW ? `<details><summary>${list.length - SHOW} more</summary><ul>${list.slice(SHOW).map(item).join('')}</ul></details>` : '');
    if (strip.dataset.html !== html) { strip.dataset.html = html; strip.innerHTML = html; }
    strip.classList.toggle('ns-has-high', list.some((n) => n.priority === 'high'));
  }

  async function poll() {
    if (document.hidden) return;
    try {
      const r = await fetch(`${API}/notices`, { cache: 'no-store' });
      if (r.status === 404) { state.list = []; state.ok = false; }
      else if (r.ok) { const d = await r.json(); state.list = Array.isArray(d.notices) ? d.notices : []; state.ok = true; }
    } catch { /* keep the last list */ }
    render();
    window.dispatchEvent(new Event('peter:notices'));
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  poll();
  setInterval(poll, POLL_MS);
})();
