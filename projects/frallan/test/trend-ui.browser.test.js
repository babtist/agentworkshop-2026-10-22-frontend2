'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.resolve(__dirname, '../.playwright-browsers');
const { chromium, expect } = require('@playwright/test');

const assets = path.resolve(__dirname, '../../../board/public/colony/frallan');

function fixture(mode) {
  const now = Date.now() - 1500;
  let points = Array.from({ length: 60 }, (_, index) => {
    let value = index < 49 ? 9 - Math.floor(index / 10) : 6 - Math.floor((index - 49) / 5);
    if (mode === 'worsening') value = 14 - value;
    if (mode === 'steady') value = 4;
    if (mode === 'zero') value = 0;
    return { at: new Date(now - (59 - index) * 30000).toISOString(), lateCount: value, canceledCount: 1 };
  });
  let availability = 'ready';
  let delta = points.at(-1).lateCount - points.at(-11).lateCount;
  if (mode === 'warming-up') {
    points = points.slice(-1);
    availability = 'warming-up';
    delta = null;
  }
  if (mode === 'gaps') {
    points[30] = { ...points[30], lateCount: null, canceledCount: null };
    points = points.filter((_, index) => index < 39 || index > 44);
  }
  if (['stale', 'unavailable', 'demo', 'empty'].includes(mode)) {
    availability = mode === 'empty' ? 'unavailable' : mode;
    delta = null;
    if (mode === 'empty' || mode === 'demo' || mode === 'unavailable') points = [];
    if (mode === 'stale') points = points.map(point => ({
      ...point, at: new Date(Date.parse(point.at) - 5 * 60000).toISOString()
    }));
  }
  if (mode === 'old-ready') points = points.map(point => ({
    ...point, at: new Date(Date.parse(point.at) - 5 * 60000).toISOString()
  }));
  return {
    version: 1, displayId: 'hall-1', availability,
    direction: delta === null ? 'unknown' : delta < 0 ? 'improving' : delta > 0 ? 'worsening' : 'steady',
    delta, comparisonMinutes: 5, windowMinutes: 30, observedMinutes: mode === 'warming-up' ? 0 : 7,
    thresholds: { trains: 3, minutes: 5 }, updatedAt: points.length ? points.at(-1).at : null,
    evaluatedAt: new Date().toISOString(), points
  };
}

test('real Chromium: visual states, honest history and widget lifecycle', { timeout: 120000 }, async t => {
  let mode = 'improving', calls = 0, active = 0, maxActive = 0, lastSearch = '';
  const activeById = new Map(), maxById = new Map(), callsById = new Map();
  let blockedResponse = null;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/t/frallan/api/trend') {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      const displayId = url.searchParams.get('displayId') || 'default';
      activeById.set(displayId, (activeById.get(displayId) || 0) + 1);
      maxById.set(displayId, Math.max(maxById.get(displayId) || 0, activeById.get(displayId)));
      callsById.set(displayId, (callsById.get(displayId) || 0) + 1);
      res.once('close', () => { active--; activeById.set(displayId, activeById.get(displayId) - 1); });
      lastSearch = url.search;
      if (mode === 'blocked') {
        blockedResponse = res;
        return;
      }
      if (mode === 'network') { res.destroy(); return; }
      if (mode === 'invalid') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"version":1}');
        return;
      }
      if (mode === 'bad-id') { res.writeHead(400).end('{}'); return; }
      const data = fixture(mode);
      data.displayId = displayId;
      res.writeHead(['stale', 'unavailable'].includes(data.availability) ? 503 : 200,
        { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
      return;
    }
    const file = {
      '/fixtures/trend.html': path.join(__dirname, 'fixtures/trend.html'),
      '/colony/frallan/trend.js': path.join(assets, 'trend.js'),
      '/colony/frallan/trend.css': path.join(assets, 'trend.css')
    }[url.pathname];
    if (!file) { res.writeHead(404).end(); return; }
    try {
      const content = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' :
        file.endsWith('.css') ? 'text/css' : 'text/html' }).end(content);
    } catch (error) { res.writeHead(500).end(error.code); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1100, height: 850 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const card = page.locator('section.frallan-trend');
  async function load(nextMode) {
    mode = nextMode;
    await page.goto(origin + '/fixtures/trend.html?displayId=hall-1');
    await expect(card).not.toHaveAttribute('data-availability', 'loading');
    await expect(card.locator('svg')).toBeVisible();
  }
  async function screenshot(name) {
    if (!process.env.TREND_SCREENSHOT_DIR) return;
    await fs.mkdir(process.env.TREND_SCREENSHOT_DIR, { recursive: true });
    const output = path.join(process.env.TREND_SCREENSHOT_DIR, 'trend-' + name + '.png');
    await page.screenshot({ path: output, fullPage: true });
    console.log('Screenshot: ' + output);
  }
  try {
    await t.test('improving / worsening / steady use distinct words and visual treatments', async () => {
      for (const state of ['improving', 'worsening', 'steady']) {
        await load(state);
        await expect(card).toHaveAttribute('data-direction', state);
        await expect(card.locator('.frallan-trend-current-dot')).toHaveCount(1);
        await expect(card.locator('.frallan-trend-guide')).toHaveCount(2);
        await expect(card.locator('.frallan-trend-change')).toContainText('trains · 5 min');
        await expect(card.getByRole('img')).toHaveAccessibleName('Late trains over the last 30 minutes');
        assert.match(lastSearch, /displayId=hall-1/);
        await screenshot(state);
      }
    });
    await t.test('one-point warm-up is a point at the right, not fabricated history', async () => {
      await load('warming-up');
      await expect(card.locator('.frallan-trend-value')).toHaveText('4');
      await expect(card.locator('.frallan-trend-line')).toHaveCount(0);
      await expect(card.locator('.frallan-trend-area')).toHaveCount(0);
      await expect(card.locator('.frallan-trend-current-dot')).toHaveCount(1);
      await expect(card.locator('.frallan-trend-change strong')).toHaveText('—');
      await expect(card.locator('.frallan-trend-caption')).toBeVisible();
      await expect(card.locator('.frallan-trend-caption')).toContainText('0.0/5 min observed');
      assert.ok((await card.boundingBox()).height < 310, 'warm-up stays compact without hiding baseline progress');
      await expect(card).toContainText('0.0 of 5 continuous minutes');
      await screenshot('warmup');
    });
    await t.test('stale, no-key demo and empty history never look like a healthy zero', async () => {
      for (const state of ['stale', 'demo', 'empty']) {
        await load(state);
        await expect(card.locator('.frallan-trend-value')).toHaveText('—');
        await expect(card.locator('.frallan-trend-current-dot')).toHaveCount(0);
        if (state === 'stale') await expect(card).toContainText('HISTORICAL · NOT CURRENT');
        else await expect(card).toContainText('No observed history yet');
        await screenshot(state);
      }
    });
    await t.test('null samples and 3-minute gaps do not connect across missing history', async () => {
      await load('gaps');
      await expect(card.locator('.frallan-trend-line')).toHaveCount(3);
      await expect(card.locator('.frallan-trend-area')).toHaveCount(3);
      await screenshot('gaps');
    });
    await t.test('aged ready payloads expire locally; only a real verified zero renders as zero', async () => {
      await load('old-ready');
      await expect(card).toHaveAttribute('data-availability', 'stale');
      await expect(card.locator('.frallan-trend-value')).toHaveText('—');
      await expect(card).toContainText('Status: source-too-old');
      await load('zero');
      await expect(card).toHaveAttribute('data-direction', 'steady');
      await expect(card.locator('.frallan-trend-value')).toHaveText('0');
      for (const [state, reason] of [['network', 'network-error'], ['bad-id', 'invalid-display']]) {
        await load(state);
        await expect(card.locator('.frallan-trend-value')).toHaveText('—');
        await expect(card).toContainText('Status: ' + reason);
      }
    });
    await t.test('narrow dark-mode card stays legible, within viewport and reduced-motion safe', async () => {
      await page.setViewportSize({ width: 320, height: 900 });
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      await load('worsening');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      const width = await card.locator('svg').evaluate(el => el.viewBox.baseVal.width);
      assert.ok(width < 320, 'chart labels are real CSS-sized text, not a shrunk desktop SVG');
      await screenshot('narrow-dark');
      await page.setViewportSize({ width: 1100, height: 850 });
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
    });
    await t.test('compact layout inherits a dark host even in light mode and keeps details accessible across refreshes', async () => {
      await load('improving');
      await page.addStyleTag({ content: 'details { padding:16px; border:1px solid #304050; background:#0c1424; }' });
      await page.evaluate(() => {
        const host = document.getElementById('service-trend');
        host.style.cssText = 'width:600px;max-width:100%;background:#10251f;color:#e3edef';
      });
      await expect(card.locator('.frallan-trend-value')).not.toBeVisible();
      await expect(card.locator('.frallan-trend-direction')).toBeVisible();
      await expect(card.locator('svg')).toBeVisible();
      await expect.poll(async () => (await card.boundingBox()).height).toBeLessThan(280);
      const colours = await card.evaluate(el => ({
        text: getComputedStyle(el).color,
        host: getComputedStyle(el.parentElement).color,
        background: getComputedStyle(el).backgroundColor
      }));
      assert.equal(colours.text, colours.host);
      assert.notEqual(colours.background, 'rgb(255, 255, 255)');
      const toggle = card.locator('summary');
      await toggle.focus();
      await page.keyboard.press('Enter');
      await expect(card.locator('.frallan-trend-value')).toBeVisible();
      const refresh = card.getByRole('button', { name: 'Refresh', exact: true });
      await refresh.click();
      await expect(refresh).toBeFocused();
      await expect(card.locator('.frallan-trend-value')).toBeVisible();
      const before = calls;
      await toggle.focus();
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('peter:thresholds', { detail: { displayId: 'hall-1' } })));
      await expect.poll(() => calls).toBeGreaterThan(before);
      await expect(card).toHaveAttribute('data-availability', 'ready');
      await expect(toggle).toBeFocused();
      await expect(card.locator('.frallan-trend-value')).toBeVisible();
      await page.keyboard.press('Enter');
      await expect(card.locator('.frallan-trend-value')).not.toBeVisible();
      await page.evaluate(() => { document.getElementById('service-trend').style.width = '290px'; });
      await expect.poll(async () => (await card.boundingBox()).height).toBeLessThan(310);
      await screenshot('compact-host');
    });
    await t.test('embedded mount is isolated, safe for external text and retains only labeled history on errors', async () => {
      await load('improving');
      await page.evaluate(() => {
        const host = document.createElement('div');
        host.id = 'embedded';
        host.style.width = '320px';
        host.append(document.createTextNode('outside widget'));
        document.body.append(host);
        window.testWidget = window.FrallanTrend.mount(host, { displayId: '<img src=x onerror=alert(1)>' });
      });
      const embedded = page.locator('#embedded section');
      await expect(embedded).toHaveAttribute('data-availability', 'ready');
      await expect(embedded.locator('.frallan-trend-display')).toHaveText('Display · <img src=x onerror=alert(1)>');
      await expect(embedded.locator('img')).toHaveCount(0);
      mode = 'invalid';
      await page.evaluate(() => window.testWidget.refresh());
      await expect(embedded).toHaveAttribute('data-availability', 'unavailable');
      await expect(embedded.locator('.frallan-trend-value')).toHaveText('—');
      await expect(embedded).toContainText('HISTORICAL · NOT CURRENT');
      await expect(embedded).toContainText('Status: invalid-response');
      await page.evaluate(() => window.testWidget.destroy());
      await expect(page.locator('#embedded')).toHaveText('outside widget');
    });
    await t.test('15s polls, no overlap, timeout, threshold reset, and destroy cleanup', async () => {
      await page.clock.install();
      await load('improving');
      await page.evaluate(() => {
        const host = document.createElement('div');
        host.id = 'lifecycle';
        document.body.append(host);
        window.testWidget = window.FrallanTrend.mount(host, { displayId: 'lifecycle' });
      });
      const widget = page.locator('#lifecycle section');
      await expect(widget).toHaveAttribute('data-availability', 'ready');
      const beforePoll = calls;
      await page.clock.runFor(15010);
      await expect.poll(() => calls).toBeGreaterThan(beforePoll);
      await page.evaluate(() => window.testWidget.refresh());
      mode = 'blocked';
      await page.evaluate(() => {
        window.testWidget.refresh();
        window.testWidget.refresh();
        window.testWidget.refresh();
      });
      await expect.poll(() => blockedResponse !== null).toBe(true);
      const beforeConcurrent = calls;
      await page.evaluate(() => { window.testWidget.refresh(); });
      assert.equal(calls, beforeConcurrent);
      await page.clock.runFor(8100);
      await expect(widget).toContainText('Status: request-timeout');
      assert.ok(maxActive <= 2, 'one in-flight request per mounted widget');
      assert.equal(maxById.get('lifecycle'), 1);
      mode = 'warming-up';
      await page.evaluate(() => document.dispatchEvent(new CustomEvent('peter:thresholds', { detail: { displayId: 'lifecycle' } })));
      await expect(widget).toHaveAttribute('data-availability', 'warming-up');
      await expect(widget.locator('.frallan-trend-line')).toHaveCount(0);
      const beforeUnrelated = callsById.get('lifecycle');
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('peter:thresholds', { detail: { displayId: 'other' } })));
      assert.equal(callsById.get('lifecycle'), beforeUnrelated);
      mode = 'blocked';
      blockedResponse = null;
      await page.evaluate(() => { window.testWidget.refresh(); });
      await expect.poll(() => blockedResponse !== null).toBe(true);
      mode = 'warming-up';
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('peter:thresholds', { detail: { displayId: 'lifecycle' } })));
      await expect(widget).toHaveAttribute('data-availability', 'warming-up');
      await expect.poll(() => activeById.get('lifecycle')).toBe(0);
      mode = 'blocked';
      blockedResponse = null;
      await page.evaluate(() => { window.testWidget.refresh(); });
      await expect.poll(() => blockedResponse !== null).toBe(true);
      await page.evaluate(() => window.testWidget.destroy());
      await expect.poll(() => activeById.get('lifecycle')).toBe(0);
      const beforeDestroy = callsById.get('lifecycle');
      await page.clock.runFor(16000);
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('peter:thresholds', { detail: { displayId: 'lifecycle' } })));
      assert.equal(callsById.get('lifecycle'), beforeDestroy);
      await expect(page.locator('#lifecycle')).toBeEmpty();
    });
    assert.deepEqual(errors, []);
  } finally {
    if (blockedResponse && !blockedResponse.destroyed) blockedResponse.destroy();
    await context.close();
  }
});
