(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FrallanTrend = Object.freeze({ mount: api.mount });
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  const WINDOW = 30 * 60 * 1000;
  const POLL = 15000;
  const TIMEOUT = 8000;
  const NS = 'http://www.w3.org/2000/svg';
  const states = new Set(['ready', 'warming-up', 'stale', 'unavailable', 'demo']);
  const directions = new Set(['improving', 'steady', 'worsening', 'unknown']);
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
  let nextId = 0;

  function validate(data) {
    if (!data || data.version !== 1 || typeof data.displayId !== 'string' || !states.has(data.availability) ||
        !directions.has(data.direction) || data.windowMinutes !== 30 ||
        data.comparisonMinutes !== 5 || !Number.isFinite(data.observedMinutes) ||
        data.observedMinutes < 0 || !timestamp(data.evaluatedAt) ||
        !(data.updatedAt === null || timestamp(data.updatedAt)) ||
        !Array.isArray(data.points) || data.points.length > 120 ||
        !(data.thresholds === null || (data.thresholds && count(data.thresholds.trains) &&
          data.thresholds.trains > 0 && count(data.thresholds.minutes) && data.thresholds.minutes > 0))) {
      return false;
    }
    if (!data.points.every(point => point && timestamp(point.at) &&
        ((point.lateCount === null && point.canceledCount === null) ||
          (count(point.lateCount) && count(point.canceledCount))))) return false;
    if (data.availability === 'ready') {
      if (!Number.isSafeInteger(data.delta) || !data.thresholds || !data.updatedAt ||
          data.observedMinutes < 5) return false;
      if (data.direction !== (data.delta < 0 ? 'improving' : data.delta > 0 ? 'worsening' : 'steady')) return false;
    } else if (data.delta !== null || data.direction !== 'unknown') return false;
    return true;
  }

  // Every segment is real observed time. Unknown samples and gaps are pen lifts.
  function geometry(points, end, threshold, width = 756) {
    const left = 26, right = width - 16, top = 14, bottom = 84;
    const start = end - WINDOW;
    const sorted = points.map(point => ({ ...point, time: Date.parse(point.at) }))
      .filter(point => Number.isFinite(point.time) && point.time >= start && point.time <= end)
      .sort((a, b) => a.time - b.time);
    const max = Math.max(4, (threshold || 0) * 2 * 1.2,
      ...sorted.filter(point => count(point.lateCount)).map(point => point.lateCount * 1.2));
    const x = time => left + (time - start) / WINDOW * (right - left);
    const y = value => bottom - value / max * (bottom - top);
    const segments = [];
    let active = [];
    let previous = null;
    for (const point of sorted) {
      if (!count(point.lateCount)) {
        if (active.length) segments.push(active);
        active = [];
        previous = null;
        continue;
      }
      if (previous !== null && point.time - previous > 60000) {
        if (active.length) segments.push(active);
        active = [];
      }
      active.push({ x: x(point.time), y: y(point.lateCount), ...point });
      previous = point.time;
    }
    if (active.length) segments.push(active);
    return { segments, max, x, y, left, right, top, bottom, start, end };
  }

  function mount(container, options = {}) {
    if (!container || !container.ownerDocument) throw new TypeError('A DOM container is required');
    const doc = container.ownerDocument;
    const win = doc.defaultView;
    const displayId = options.displayId == null ? 'default' : String(options.displayId);
    const id = 'frallan-trend-' + ++nextId;
    let destroyed = false, pending = null, controller = null, timer = null;
    let timeout = null, revision = 0, latest = null, history = null;
    let lastRender = { data: null, reason: null };
    let chartWidth = 756;

    function el(tag, className, text, parent) {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      if (parent) parent.append(node);
      return node;
    }
    function svg(tag, attributes, text, parent) {
      const node = doc.createElementNS(NS, tag);
      Object.entries(attributes || {}).forEach(([key, value]) => node.setAttribute(key, String(value)));
      if (text !== undefined) node.textContent = text;
      if (parent) parent.append(node);
      return node;
    }
    const card = el('section', 'frallan-trend');
    card.setAttribute('aria-labelledby', id + '-heading');
    container.append(card);

    function render(data, reason) {
      if (destroyed) return;
      const restoreFocus = card.contains(doc.activeElement) && doc.activeElement.classList.contains('frallan-trend-refresh');
      const restoreDetailsFocus = card.contains(doc.activeElement) && doc.activeElement.classList.contains('frallan-trend-details-toggle');
      const detailsOpen = card.querySelector('details')?.open ?? false;
      lastRender = { data, reason };
      const now = Date.now();
      let availability = data ? data.availability : 'loading';
      const currentPoint = data && data.points.findLast(point =>
        data.updatedAt && Date.parse(point.at) === Date.parse(data.updatedAt));
      const sourceAge = data && data.updatedAt ? Math.max(0, (now - Date.parse(data.updatedAt)) / 1000) : null;
      if (['ready', 'warming-up'].includes(availability) &&
          (sourceAge === null || sourceAge > 90)) {
        availability = 'stale';
        reason = 'source-too-old';
      }
      if (['ready', 'warming-up'].includes(availability) &&
          (!data.thresholds || !currentPoint || !count(currentPoint.lateCount))) {
        availability = 'unavailable';
        reason = 'missing-current-sample';
      }
      if (availability === 'stale' && !reason) reason = 'source-stale';
      if (availability === 'unavailable' && !reason) reason = 'source-unavailable';
      const current = ['ready', 'warming-up'].includes(availability);
      const direction = availability === 'ready' ? data.direction : 'unknown';
      const look = {
        improving: { icon: '↘', title: 'Improving', text: 'Fewer late trains than five minutes ago.' },
        worsening: { icon: '↗', title: 'Worsening', text: 'More late trains than five minutes ago.' },
        steady: { icon: '→', title: 'Steady', text: 'The late-train count is unchanged.' },
        unknown: { icon: '—', title: 'Not yet known', text: 'A five-minute comparison is not available.' }
      }[direction];
      const labels = {
        loading: 'Connecting', ready: 'Live', 'warming-up': 'Warming up',
        stale: 'Stale · not current', unavailable: 'Unavailable', demo: 'Demo · not live'
      };
      card.replaceChildren();
      card.dataset.direction = direction;
      card.dataset.availability = availability;
      const header = el('div', 'frallan-trend-header', undefined, card);
      const title = el('div', '', undefined, header);
      el('h2', 'frallan-trend-title', 'Service trend', title).id = id + '-heading';
      const status = el('span', 'frallan-trend-status', labels[availability], header);
      status.setAttribute('role', 'status');
      const details = el('details', 'frallan-trend-details');
      details.open = detailsOpen;
      const detailsToggle = el('summary', 'frallan-trend-details-toggle', 'Details', details);
      const detailsBody = el('div', 'frallan-trend-details-body', undefined, details);
      el('p', 'frallan-trend-display', 'Display · ' + displayId, detailsBody);

      const metrics = el('div', 'frallan-trend-metrics', undefined, detailsBody);
      const currentMetric = el('div', 'frallan-trend-current', undefined, metrics);
      const value = el('div', 'frallan-trend-value', current ? String(currentPoint.lateCount) : '—', currentMetric);
      value.setAttribute('aria-label', current ? currentPoint.lateCount + ' late trains currently' : 'Current late-train count unavailable');
      el('p', 'frallan-trend-metric-label', 'late trains now', currentMetric);
      el('p', 'frallan-trend-secondary', current && data.thresholds ?
        'At least ' + data.thresholds.minutes + ' minutes behind schedule' : 'Waiting for verified live observations', currentMetric);
      const comparison = el('div', 'frallan-trend-comparison', undefined, card);
      const badge = el('div', 'frallan-trend-direction', undefined, comparison);
      el('span', 'frallan-trend-direction-icon', look.icon, badge).setAttribute('aria-hidden', 'true');
      el('span', '', look.title, badge);
      const delta = availability === 'ready' ? (data.delta > 0 ? '+' : data.delta < 0 ? '−' : '') + Math.abs(data.delta) : '—';
      const change = el('p', 'frallan-trend-change', undefined, comparison);
      el('strong', '', delta, change);
      el('span', '', ' trains · 5 min', change);
      change.setAttribute('aria-label', availability === 'ready' ?
        delta + ' trains compared with five minutes ago' : 'Five-minute comparison not available');
      el('p', 'frallan-trend-secondary', look.text, metrics);
      if (data?.thresholds) el('p', 'frallan-trend-secondary',
        'Warning at ' + data.thresholds.trains + ' late trains; severe at ' + data.thresholds.trains * 2 + '.', detailsBody);

      const shown = data && data.points.some(point => count(point.lateCount)) ? data : history;
      const historical = !current && shown && shown.points.some(point => count(point.lateCount));
      const chartHeader = el('div', 'frallan-trend-chart-header', undefined, card);
      el('h3', '', 'Late trains · 30 min', chartHeader);
      el('span', 'frallan-trend-chart-note', historical ? 'HISTORICAL · NOT CURRENT' : 'OBSERVED, NOT PREDICTED', chartHeader);
      const chart = svg('svg', {
        viewBox: '0 0 ' + chartWidth + ' 116', role: 'img', 'aria-labelledby': id + '-chart-title',
        'aria-describedby': id + '-chart-desc',
        class: 'frallan-trend-chart', preserveAspectRatio: 'xMidYMid meet'
      }, undefined, card);
      svg('title', { id: id + '-chart-title' }, 'Late trains over the last 30 minutes', chart);
      svg('desc', { id: id + '-chart-desc' },
        (historical ? 'Historical, non-current observations. ' : '') +
        'Time runs from 30 minutes ago on the left to now on the right. Gaps mean missing observations. ' +
        (current ? 'Latest count: ' + currentPoint.lateCount + '. ' : 'No verified current count. ') +
        (shown && shown.thresholds ? 'Warning at ' + shown.thresholds.trains + ', severe at ' + shown.thresholds.trains * 2 + ' late trains.' : 'Thresholds are unavailable.'), chart);
      const threshold = shown && shown.thresholds ? shown.thresholds.trains : data && data.thresholds ? data.thresholds.trains : null;
      const g = geometry(shown ? shown.points : [], now, threshold, chartWidth);
      svg('line', { x1: g.left, x2: g.right, y1: g.bottom, y2: g.bottom, class: 'frallan-trend-baseline' }, undefined, chart);
      svg('text', { x: 21, y: g.bottom + 4, class: 'frallan-trend-axis', 'text-anchor': 'middle' }, '0', chart);
      if (threshold) {
        [[threshold, 'Warning', 'warning'], [threshold * 2, 'Severe', 'severe']].forEach(([n, label, level]) => {
          svg('line', { x1: g.left, x2: g.right, y1: g.y(n), y2: g.y(n), class: 'frallan-trend-guide frallan-trend-guide-' + level }, undefined, chart);
          if (Math.abs(g.y(threshold) - g.y(threshold * 2)) >= 16) {
            svg('text', { x: g.left + 4, y: g.y(n) - 7, class: 'frallan-trend-guide-label' }, label + ' · ' + n, chart);
          }
        });
      }
      const defs = svg('defs', {}, undefined, chart);
      const gradient = svg('linearGradient', { id: id + '-fill', x1: 0, x2: 0, y1: 0, y2: 1 }, undefined, defs);
      svg('stop', { offset: '0%', 'stop-color': 'currentColor', 'stop-opacity': '.17' }, undefined, gradient);
      svg('stop', { offset: '100%', 'stop-color': 'currentColor', 'stop-opacity': '.015' }, undefined, gradient);
      const paths = svg('g', { class: 'frallan-trend-series' + (historical ? ' frallan-trend-historical' : '') }, undefined, chart);
      g.segments.forEach(segment => {
        const path = segment.map((point, index) => (index ? 'L' : 'M') + point.x.toFixed(2) + ',' + point.y.toFixed(2)).join(' ');
        if (segment.length > 1) {
          svg('path', { d: path + ' L' + segment.at(-1).x.toFixed(2) + ',' + g.bottom + ' L' + segment[0].x.toFixed(2) + ',' + g.bottom + ' Z', fill: 'url(#' + id + '-fill)', class: 'frallan-trend-area' }, undefined, paths);
          svg('path', { d: path, class: 'frallan-trend-line' }, undefined, paths);
        } else {
          svg('circle', { cx: segment[0].x, cy: segment[0].y, r: 3, class: 'frallan-trend-sample' }, undefined, paths);
        }
      });
      if (current && currentPoint) {
        const point = { x: g.x(Date.parse(currentPoint.at)), y: g.y(currentPoint.lateCount) };
        if (point.x >= g.left && point.x <= g.right) {
          svg('circle', { cx: point.x, cy: point.y, r: 8, class: 'frallan-trend-current-halo' }, undefined, paths);
          svg('circle', { cx: point.x, cy: point.y, r: 4, class: 'frallan-trend-current-dot' }, undefined, paths);
        }
      }
      [['−30 min', g.left, 'start'], ['−15 min', (g.left + g.right) / 2, 'middle'], ['Now', g.right, 'end']].forEach(([label, x, anchor]) =>
        svg('text', { x, y: 108, 'text-anchor': anchor, class: 'frallan-trend-axis' }, label, chart));
      if (!g.segments.length) {
        svg('rect', { x: chartWidth / 2 - 91, y: 41, width: 182, height: 24, rx: 6, class: 'frallan-trend-empty-backdrop' }, undefined, chart);
        svg('text', { x: chartWidth / 2, y: 57, 'text-anchor': 'middle', class: 'frallan-trend-empty' }, 'No observed history yet', chart);
      }
      const notices = {
        loading: ['Connecting to live service', 'Only real observations will appear here.'],
        ready: ['A little perspective', 'Change compares now with an observed count five minutes earlier. Gaps are never filled in.'],
        'warming-up': ['Building a five-minute baseline', Math.min(5, data ? data.observedMinutes : 0).toFixed(1) + ' of 5 continuous minutes observed. The chart starts with the first real sample.'],
        stale: ['These observations are no longer current', 'Live counts and comparisons are paused. Any history shown is retained for context only.'],
        unavailable: ['Live service is unavailable', 'No verified current count. Any retained history is explicitly non-current. We will retry automatically.'],
        demo: ['Demo source · not live service', 'Demo data cannot establish a real service trend. Live counts and comparisons are hidden.']
      };
      if (availability !== 'ready') {
        const caption = availability === 'warming-up' ?
          'Building comparison · ' + Math.min(5, data ? data.observedMinutes : 0).toFixed(1) + '/5 min observed' :
          notices[availability][0];
        el('p', 'frallan-trend-caption', caption, card);
      }
      card.append(details);
      const notice = el('div', 'frallan-trend-notice', undefined, detailsBody);
      el('span', 'frallan-trend-notice-icon' + (current ? '' : ' frallan-trend-notice-icon-info'), current ? '◷' : 'i', notice).setAttribute('aria-hidden', 'true');
      const noticeText = el('div', '', undefined, notice);
      el('strong', '', notices[availability][0], noticeText);
      el('p', '', notices[availability][1], noticeText);
      const footer = el('div', 'frallan-trend-footer', undefined, detailsBody);
      const lastAt = data && data.updatedAt || shown && shown.updatedAt;
      const lastAge = lastAt ? Math.max(0, (now - Date.parse(lastAt)) / 1000) : null;
      const freshness = lastAt ? (current ? 'Source ' : 'Last observed ') + new Date(lastAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
        ' · ' + (lastAge < 60 ? Math.floor(lastAge) + 's' : Math.floor(lastAge / 60) + 'm') + ' ago' : 'No source timestamp';
      detailsToggle.textContent = 'Details · ' + (lastAt ?
        (current ? 'updated ' : 'last observed ') + (lastAge < 60 ? Math.floor(lastAge) + 's' : Math.floor(lastAge / 60) + 'm') + ' ago' :
        'no live timestamp');
      el('span', '', freshness + ' · checks every 15s', footer);
      const retry = el('button', 'frallan-trend-refresh', 'Refresh', footer);
      retry.type = 'button';
      retry.addEventListener('click', refresh);
      if (restoreFocus) retry.focus({ preventScroll: true });
      if (restoreDetailsFocus) detailsToggle.focus({ preventScroll: true });
      if (reason) el('p', 'frallan-trend-reason', 'Status: ' + reason, detailsBody);
    }

    function schedule() {
      if (!destroyed) timer = win.setTimeout(refresh, POLL);
    }
    function refresh() {
      if (destroyed) return Promise.resolve();
      if (pending) return pending;
      win.clearTimeout(timer);
      const requestRevision = revision;
      controller = new win.AbortController();
      let timedOut = false;
      timeout = win.setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT);
      pending = (async () => {
        try {
          const response = await win.fetch('/t/frallan/api/trend?displayId=' + encodeURIComponent(displayId), {
            signal: controller.signal, headers: { Accept: 'application/json' }, cache: 'no-store'
          });
          if (response.status !== 200 && response.status !== 503) {
            const error = new Error('http');
            error.reason = response.status === 400 ? 'invalid-display' : 'http-' + response.status;
            throw error;
          }
          const data = await response.json();
          if (!validate(data) || data.displayId !== displayId ||
              (response.status === 503 && !['stale', 'unavailable'].includes(data.availability))) {
            const error = new Error('schema');
            error.reason = 'invalid-response';
            throw error;
          }
          if (destroyed || revision !== requestRevision) return;
          latest = data;
          render(data);
          if (['ready', 'warming-up'].includes(card.dataset.availability)) history = data;
        } catch (error) {
          if (destroyed || revision !== requestRevision) return;
          latest = null;
          render({ availability: 'unavailable', direction: 'unknown', points: [], updatedAt: null, thresholds: null },
            timedOut ? 'request-timeout' : error.reason || (error instanceof SyntaxError ? 'invalid-response' : 'network-error'));
        } finally {
          win.clearTimeout(timeout);
          controller = null;
          pending = null;
          schedule();
        }
      })();
      return pending;
    }
    function thresholdsChanged(event) {
      if (event.detail && event.detail.displayId != null && String(event.detail.displayId) !== displayId) return;
      revision++;
      history = null;
      latest = null;
      render(null, 'thresholds-changed');
      if (pending) {
        controller.abort();
        pending.then(() => { if (!destroyed) refresh(); });
      } else refresh();
    }
    // Refresh visible age and expire live data even while a request is stalled.
    const ageTimer = win.setInterval(() => {
      if (latest) render(latest);
    }, 15000);
    const resizeObserver = new win.ResizeObserver(entries => {
      const width = Math.max(180, Math.round(entries[0].contentRect.width));
      if (width !== chartWidth) {
        chartWidth = width;
        render(lastRender.data, lastRender.reason);
      }
    });
    resizeObserver.observe(card);
    win.addEventListener('peter:thresholds', thresholdsChanged, true);
    render(null);
    refresh();
    return Object.freeze({
      refresh,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        win.clearTimeout(timer);
        win.clearTimeout(timeout);
        win.clearInterval(ageTimer);
        resizeObserver.disconnect();
        win.removeEventListener('peter:thresholds', thresholdsChanged, true);
        if (controller) controller.abort();
        card.remove();
        history = null;
        latest = null;
      }
    });
  }

  return { mount, geometry, validate };
});
