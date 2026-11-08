'use strict';
// Performance on Nigerian networks (PLAN P8.6, CLONE_SPEC.md §38.7), real server on the production bundle + Chromium:
//   • budgets: the compressed size of the scripts needed before the first render, the stylesheet, any lazy chunk and all
//     scripts stay within scripts/perf-budget.js (CI runs the same script after the build);
//   • scripts and stylesheets are served pre-compressed (Brotli, else gzip) to browsers that accept it, with
//     `Vary: Accept-Encoding`; `q=0` and no Accept-Encoding get the plain file;
//   • a low-end Android phone on 3G (390 px, 4× CPU slowdown, 1.44 Mbit/s down, 562 ms round trip, cold cache): the
//     Largest Contentful Paint of the home, an event and the browse page stays within 2.5 s; the slowest interaction
//     (INP) on the event page — switching tabs, picking a side, typing an amount — stays within 200 ms.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { chromium } = require('playwright');
const { start } = require('../server/index.js');
const budget = require('../scripts/perf-budget.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-perf-'));
const LCP_MS = 2500; // "good" Largest Contentful Paint
const INP_MS = 200; // "good" Interaction to Next Paint
const PHONE_3G = { offline: false, latency: 562.5, downloadThroughput: ((1.6 * 1024 * 1024) / 8) * 0.9, uploadThroughput: ((750 * 1024) / 8) * 0.9 };
let srv; let browser; let BASE; let EV;

before(async () => {
  srv = await start({ port: 0, dbFile: path.join(TMP, 'perf.db'), quiet: true, tickMs: 500, assets: 'dist', security: { challengeMode: 'off' }, rate: { burst: 1e6, perSec: 1e6 } });
  BASE = `http://127.0.0.1:${srv.port}`;
  browser = await chromium.launch();
  const home = await (await fetch(`${BASE}/v1/bff/home`)).json();
  const e = home.home.top_markets[0];
  EV = `/markets/${e.series_ticker.toLowerCase()}/${e.series_slug}/${e.event_ticker.toLowerCase()}`;
});
after(async () => {
  try { await browser?.close(); } catch { /* ignore */ }
  try { await srv?.close(); } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

// A phone context with the 3G link and the slow CPU, no service worker (a first visit), metrics observed from the start.
async function phone() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', PHONE_3G);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.addInitScript(() => {
    window.__perf = { lcp: 0, lcpNode: '', inp: 0, events: [] };
    new PerformanceObserver((l) => { for (const x of l.getEntries()) { window.__perf.lcp = Math.max(window.__perf.lcp, x.startTime); window.__perf.lcpNode = x.element ? x.element.tagName : String(x.url || ''); } }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => { for (const x of l.getEntries()) if (x.interactionId) { window.__perf.inp = Math.max(window.__perf.inp, x.duration); window.__perf.events.push(`${x.name}:${Math.round(x.duration)}`); } }).observe({ type: 'event', durationThreshold: 16, buffered: true });
  });
  return page;
}

test('budgets: the compressed bundle stays within scripts/perf-budget.js; assets go out pre-compressed', async () => {
  const r = budget.check();
  assert.deepEqual(r.over, [], `over budget: ${JSON.stringify(r.measured)}`);
  assert.ok(r.measured.initial_files >= 1 && r.measured.initial_js > 0, JSON.stringify(r.measured));
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dist', 'manifest.json'), 'utf8'));
  const raw = fs.readFileSync(path.join(__dirname, '..', 'dist', 'assets', manifest.entry.js));
  const get = (p, ae) => fetch(BASE + p, { headers: ae === null ? {} : { 'accept-encoding': ae } });
  for (const p of [`/assets/${manifest.entry.js}`, `/assets/${manifest.entry.css}`]) {
    const br = await get(p, 'gzip, deflate, br');
    assert.equal(br.status, 200);
    assert.equal(br.headers.get('content-encoding'), 'br', p);
    assert.match(br.headers.get('vary') || '', /Accept-Encoding/i);
    assert.match(br.headers.get('content-type'), p.endsWith('.css') ? /^text\/css/ : /^text\/javascript/);
    assert.match(br.headers.get('cache-control'), /immutable/);
    const gz = await get(p, 'gzip');
    assert.equal(gz.headers.get('content-encoding'), 'gzip', p);
    const none = await get(p, 'br;q=0, gzip;q=0');
    assert.equal(none.headers.get('content-encoding'), null, 'q=0 means not acceptable');
    assert.match(none.headers.get('vary') || '', /Accept-Encoding/i);
  }
  // The decoded bytes are the file itself (fetch decodes); a raw request without Accept-Encoding gets the plain file.
  assert.ok(Buffer.from(await (await get(`/assets/${manifest.entry.js}`, 'br')).arrayBuffer()).equals(raw));
  const plain = await new Promise((res, rej) => { require('node:http').get(`${BASE}/assets/${manifest.entry.js}`, (x) => { const b = []; x.on('data', (c) => b.push(c)); x.on('end', () => res({ enc: x.headers['content-encoding'], body: Buffer.concat(b) })); }).on('error', rej); });
  assert.equal(plain.enc, undefined);
  assert.ok(plain.body.equals(raw));
  assert.ok(zlib.brotliDecompressSync(fs.readFileSync(path.join(__dirname, '..', 'dist', 'assets', `${manifest.entry.js}.br`))).equals(raw));
  // The compressed copies are not URLs of their own, and names outside the hashed pattern are not looked up.
  for (const p of [`/assets/${manifest.entry.js}.br`, `/assets/${manifest.entry.js}.gz`, '/assets/..%2Fmanifest.json', '/assets/%2e%2e/manifest.json']) assert.equal((await get(p, 'br')).status, 404, p);
});

test('a low-end Android phone on 3G: LCP within 2.5 s on the home, an event and the browse page', async (t) => {
  for (const p of ['/', EV, '/browse']) {
    const page = await phone();
    await page.goto(BASE + p, { waitUntil: 'load', timeout: 120000 });
    // The app took over from the server-rendered content (it replaces the .ssr block in <main>).
    await page.waitForFunction(() => { const m = document.querySelector('main#view'); return m && m.children.length && !m.querySelector(':scope > .ssr'); }, null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    const perf = await page.evaluate(() => window.__perf);
    t.diagnostic(`${p}: LCP ${Math.round(perf.lcp)} ms (${perf.lcpNode})`);
    assert.ok(perf.lcp > 0, `${p}: an LCP entry was recorded`);
    assert.ok(perf.lcp <= LCP_MS, `${p}: LCP ${Math.round(perf.lcp)} ms (element ${perf.lcpNode}) exceeds ${LCP_MS} ms`);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  }
});

test('a low-end Android phone on 3G: INP within 200 ms on the event page (tabs, side, amount)', async (t) => {
  const page = await phone();
  await page.goto(BASE + EV, { waitUntil: 'load', timeout: 120000 });
  await page.waitForSelector('[data-testid=submit-order]', { timeout: 60000 });
  await page.waitForTimeout(1500);
  const tabs = await page.$$('.big-tabs [data-tab]');
  assert.ok(tabs.length >= 2);
  for (const t of tabs.slice(0, 3)) { await t.tap(); await page.waitForTimeout(600); }
  await page.tap('[data-side=no]'); await page.waitForTimeout(400);
  await page.tap('[data-side=yes]'); await page.waitForTimeout(400);
  const input = (await page.$('#t-amount:visible')) || (await page.$('#t-count:visible'));
  await input.tap();
  await page.keyboard.type('25', { delay: 120 });
  await page.waitForTimeout(800);
  const perf = await page.evaluate(() => window.__perf);
  t.diagnostic(`INP ${perf.inp} ms: ${perf.events.join(' ')}`);
  assert.ok(perf.events.length >= 5, `interactions were observed: ${perf.events.join(' ')}`);
  assert.ok(perf.inp <= INP_MS, `INP ${perf.inp} ms exceeds ${INP_MS} ms (${perf.events.join(' ')})`);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
