// frallan's shared service trend (FrallanTrend), mounted in each card instead of our own sparkline.
// Optional: if /colony/frallan/trend.js is missing or mount fails, our sparkline stays.
(() => {
  const cards = window.peterCards || [];
  if (!cards.length) return;
  const BASE = '/colony/frallan/';
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = BASE + 'trend.css';
  const js = document.createElement('script');
  js.src = BASE + 'trend.js';
  js.async = true;
  const handles = [];
  js.onload = () => {
    const FT = window.FrallanTrend;
    if (!FT || typeof FT.mount !== 'function') return;
    document.head.append(css);
    for (const c of cards) {
      const host = document.createElement('div');
      host.className = 'frallan-trend-host';
      c.trendBox.before(host);
      try {
        handles.push(FT.mount(host, { displayId: c.id }));
        c.trendBox.hidden = true;
      } catch (e) {
        host.remove();
        console.warn('FrallanTrend.mount failed, keeping our sparkline', e);
      }
    }
    document.body.classList.toggle('has-frallan-trend', handles.length > 0);
  };
  js.onerror = () => js.remove();
  document.body.append(js);
  addEventListener('pagehide', () => handles.forEach((h) => { try { h?.destroy?.(); } catch {} }));
})();
