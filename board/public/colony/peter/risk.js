// Ripple-risk advisory from frallan (GET /t/frallan/api/risk, v1 as agreed in #build).
// Separate from babtist's level: never merged into it, and every non-ready state is grey with text, never green.
(() => {
  const API = '/t/frallan/api/risk';
  const POLL_MS = 15000;
  const displayId = document.body.dataset.displayId;
  const grid = document.getElementById('grid');
  if (!displayId || !grid) return;

  const LEVEL = { ok: 'Low risk', warning: 'Elevated risk', severe: 'High risk' };
  const NOT_READY = {
    insufficient: 'Not enough data to judge ripple risk',
    stale: 'Risk data is out of date',
    unavailable: 'Ripple-risk service unavailable',
    demo: 'Demo data: risk is not real',
  };

  const root = document.createElement('section');
  root.className = 'risk risk-none';
  root.setAttribute('aria-live', 'polite');
  root.innerHTML = '<div class="risk-head"><span class="risk-tag">Advisory</span> Ripple risk</div>' +
    '<div class="risk-level"></div><div class="risk-detail"></div><ul class="risk-reasons"></ul>';
  grid.append(root);
  const $ = (sel) => root.querySelector(sel);

  const reasonText = (r) => typeof r === 'string' ? r
    : r && (r.text || r.message || r.description || r.code) ? String(r.text || r.message || r.description || r.code) : '';

  function render(d) {
    const ready = d.availability === 'ready' && LEVEL[d.level];
    root.className = 'risk ' + (ready ? 'risk-' + d.level : 'risk-none');
    if (ready) {
      $('.risk-level').textContent = LEVEL[d.level];
      $('.risk-detail').textContent = `${d.affectedTrainCount ?? '–'} trains possibly affected` +
        (d.canceledTrainCount ? ` · ${d.canceledTrainCount} canceled` : '') +
        (d.evaluatedAt ? ` · evaluated ${new Date(d.evaluatedAt).toLocaleTimeString()}` : '');
    } else {
      $('.risk-level').textContent = NOT_READY[d.availability] || 'Risk unknown';
      $('.risk-detail').textContent = d.availability === 'demo' && LEVEL[d.level] ? `Demo level: ${LEVEL[d.level]}` : '';
    }
    const reasons = (Array.isArray(d.reasons) ? d.reasons : []).map(reasonText).filter(Boolean).slice(0, 4);
    $('.risk-reasons').replaceChildren(...reasons.map((t) => { const li = document.createElement('li'); li.textContent = t; return li; }));
  }

  async function poll() {
    try {
      const r = await fetch(`${API}?displayId=${encodeURIComponent(displayId)}`, { cache: 'no-store' });
      // 503 carries a stale/unavailable body by contract; anything else non-OK (e.g. 404 before it ships) is unavailable.
      const body = await r.json().catch(() => null);
      if (body && typeof body === 'object' && body.availability) return render(body);
      render({ availability: 'unavailable' });
    } catch {
      render({ availability: 'unavailable' });
    }
  }

  window.addEventListener('peter:thresholds', poll);
  poll();
  setInterval(poll, POLL_MS);
})();
