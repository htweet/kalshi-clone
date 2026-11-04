'use strict';
// Progressive Web App (CLONE_SPEC.md §31; PLAN §9 "PWA"): web app manifest and icons, the service worker (registration,
// control, precache of the hashed production bundle, nothing user-specific or HTML in Cache Storage, offline page and
// recovery, the update toast and reload), the install entry (emulated beforeinstallprompt, iOS instructions, hidden when
// standalone), real Web Push (VAPID RFC 8292 + aes128gcm RFC 8291) to a local fake push service that verifies the JWT
// and decrypts the payload, 410 cleanup, the persisted outbox across a restart, sign-out clearing caches and the push
// subscription, the bot challenge through the service worker, and no CSP violations or page errors.
// Runs against the production bundle (assets: 'dist'), so the precached files are the real hashed assets.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const { build, readManifest } = require('../scripts/build.js');
const { Client } = require('./lib/client');
const content = require('../server/content/pwa'); // manifest config and keyed strings (CLONE_SPEC §31.12)

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-pwa-'));
const DB_FILE = path.join(TMP, 'pwa.db');
const PW = 'Quartz-Lantern-Meadow-7391'; // secret-scan:allow (throwaway E2E account password)
const stamp = Date.now();
const HIGH = { burst: 1e6, per_second: 1e6 };
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
let PORT; let BASE; let FAKE; let FAKE_ORIGIN;
let challengeMode = 'off';
const opts = () => ({
  port: PORT, dbFile: DB_FILE, tickMs: 200, quiet: true, assets: 'dist', rate: { burst: 1e6, perSec: 1e6 },
  security: { challengeMode, authRate: HIGH, writeRate: HIGH }, admin: { email: `root.${stamp}@example.test`, password: PW },
  push: { insecureEndpointHosts: [`127.0.0.1:${FAKE}`], retryBaseMs: 400, subject: 'mailto:ops@parlance.example' },
});

let srv; let browser; let fake;
// Notifications need the full Chromium build in its new headless mode (the headless shell denies the permission).
let fullBrowser;
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const dbrun = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = 'condition') {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${label}`); await sleep(100); }
}

// ------------------------------------------------------------------------------------------------ fake push service
// A push service in miniature: accepts POST /push/<id>, verifies the VAPID JWT (ES256 over the server's public key,
// aud = this origin, exp ≤ 24 h, sub), and decrypts the aes128gcm body with the subscription's private key. This is an
// independent implementation of RFC 8291 decryption, not the server's code.
function b64uJson(s) { return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); }
function verifyVapid(headers, expectedKey) {
  const m = /^vapid t=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(headers.authorization || '');
  if (!m) throw new Error(`no VAPID authorization: ${headers.authorization}`);
  const [, h, p, s, k] = m;
  const head = b64uJson(h); const claims = b64uJson(p);
  if (head.alg !== 'ES256' || head.typ !== 'JWT') throw new Error('JWT header');
  const now = Math.floor(Date.now() / 1000);
  if (claims.aud !== FAKE_ORIGIN) throw new Error(`aud ${claims.aud}`);
  if (!(claims.exp > now && claims.exp <= now + 86400)) throw new Error(`exp ${claims.exp}`);
  if (!/^(mailto:|https:)/.test(claims.sub || '')) throw new Error(`sub ${claims.sub}`);
  const key = Buffer.from(k, 'base64url');
  if (expectedKey && k !== expectedKey) throw new Error('k is not the server VAPID public key');
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: key.subarray(1, 33).toString('base64url'), y: key.subarray(33, 65).toString('base64url') }, format: 'jwk' });
  if (!crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))) throw new Error('JWT signature does not verify');
  return claims;
}
function hkdf(ikm, salt, info, len) { // RFC 5869 by hand (extract + one expand block)
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  return crypto.createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, len);
}
function decrypt(body, sub) {
  const salt = body.subarray(0, 16); const rs = body.readUInt32BE(16); const idlen = body[20];
  const asPub = body.subarray(21, 21 + idlen); const ct = body.subarray(21 + idlen);
  if (rs < 18 || idlen !== 65) throw new Error('aes128gcm header');
  const shared = sub.ecdh.computeSecret(asPub);
  const ikm = hkdf(shared, sub.auth, Buffer.concat([Buffer.from('WebPush: info\0'), sub.pub, asPub]), 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const rec = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let i = rec.length - 1; while (i >= 0 && rec[i] === 0) i--;
  if (rec[i] !== 2) throw new Error('missing last-record delimiter');
  return { payload: JSON.parse(rec.subarray(0, i).toString('utf8')), recordLength: rec.length };
}
function startFake() {
  const subs = new Map(); const modes = new Map(); const received = [];
  let vapidKey = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const id = decodeURIComponent(req.url.split('/').pop());
      const rec = { id, method: req.method, headers: req.headers, at: Date.now() };
      try {
        rec.claims = verifyVapid(req.headers, vapidKey);
        if (req.headers['content-encoding'] !== 'aes128gcm') throw new Error('content-encoding');
        if (!(Number(req.headers.ttl) > 0)) throw new Error('TTL');
        if (!['very-low', 'low', 'normal', 'high'].includes(req.headers.urgency)) throw new Error('Urgency');
        const sub = subs.get(id);
        if (!sub) throw new Error(`unknown subscription ${id}`);
        Object.assign(rec, decrypt(Buffer.concat(chunks), sub));
        rec.ok = true;
      } catch (e) { rec.error = e.message; }
      received.push(rec);
      const status = modes.get(id) || 201;
      res.writeHead(status, status === 503 ? { 'retry-after': '0' } : {});
      res.end();
    });
  });
  const newSub = (id) => {
    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
    const s = { id, ecdh, pub: ecdh.getPublicKey(), auth: crypto.randomBytes(16) };
    subs.set(id, s);
    return { endpoint: `${FAKE_ORIGIN}/push/${id}`, keys: { p256dh: s.pub.toString('base64url'), auth: s.auth.toString('base64url') } };
  };
  return { server, received, modes, newSub, setKey: (k) => { vapidKey = k; }, of: (id) => received.filter((r) => r.id === id) };
}

// ------------------------------------------------------------------------------------------------ browser helpers
async function newContext(o = {}, b = browser) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, ...o });
  await ctx.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.effectiveDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`));
  });
  ctx.errors = [];
  return ctx;
}
async function newPage(ctx) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => ctx.errors.push(e.message));
  return page;
}
// The browser's PushManager is replaced with one that hands out a subscription to the fake push service (a headless
// browser has no real push service, and the tests must not use the network). Everything else is the real code path.
async function stubPushManager(ctx, sub) {
  await ctx.addInitScript((s) => {
    let current = null;
    const make = (key) => ({ endpoint: s.endpoint, expirationTime: null, options: { applicationServerKey: key, userVisibleOnly: true },
      toJSON: () => ({ endpoint: s.endpoint, expirationTime: null, keys: s.keys }),
      unsubscribe() { current = null; window.__unsubscribed = (window.__unsubscribed || 0) + 1; return Promise.resolve(true); } });
    PushManager.prototype.subscribe = function subscribe(o) {
      window.__subscribeKey = btoa(String.fromCharCode(...new Uint8Array(o.applicationServerKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      current = make(o.applicationServerKey);
      return Promise.resolve(current);
    };
    PushManager.prototype.getSubscription = function getSubscription() { return Promise.resolve(current); };
  }, sub);
}
const clean = async (page) => {
  const csp = await page.evaluate(() => window.__csp || []).catch(() => []);
  assert.deepEqual(csp, [], 'no CSP violations');
  assert.deepEqual(page.context().errors, [], 'no page errors');
};
async function logIn(page, email) {
  await page.goto(BASE + '/sign-in');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', PW);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
}
async function controlled(page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await until(() => page.evaluate(() => !!navigator.serviceWorker.controller), 10000, 'service worker controls the page');
  const version = readManifest().pwa.version;
  await until(() => page.evaluate((v) => caches.keys().then((k) => k.includes(`plx-static-${v}`)), version), 10000, 'precache');
  return version;
}
const cacheEntries = (page) => page.evaluate(async () => {
  const out = [];
  for (const name of await caches.keys()) {
    const c = await caches.open(name);
    for (const req of await c.keys()) {
      const res = await c.match(req);
      out.push({ cache: name, path: new URL(req.url).pathname, search: new URL(req.url).search, type: res.headers.get('content-type') || '', cc: res.headers.get('cache-control') || '', text: /html/.test(res.headers.get('content-type') || '') ? await res.clone().text() : '' });
    }
  }
  return out;
});
async function signUp(name) {
  const email = `pwa.${name}.${stamp}@example.test`;
  const c = await new Client(BASE, name).signUp(email, PW, `PWA ${name}`);
  return { email, c, uid: c.uid };
}
const activeMarket = () => dbq("SELECT m.ticker FROM markets m JOIN events e ON e.ticker=m.event_ticker WHERE m.status='active' AND m.mve_collection_ticker IS NULL AND e.series_ticker NOT LIKE 'PLXFLASH%' AND m.fractional_trading_enabled=0 ORDER BY m.rowid LIMIT 1")[0];

before(async () => {
  PORT = await freePort(); FAKE = await freePort();
  BASE = `http://127.0.0.1:${PORT}`; FAKE_ORIGIN = `http://127.0.0.1:${FAKE}`;
  fake = startFake();
  await new Promise((r) => fake.server.listen(FAKE, '127.0.0.1', r));
  srv = await start(opts());
  fake.setKey((await (await fetch(`${BASE}/v1/push/vapid_public_key`)).json()).public_key);
  browser = await chromium.launch();
  fullBrowser = await chromium.launch({ channel: 'chromium' });
});
after(async () => {
  await browser?.close(); await fullBrowser?.close(); await srv?.close();
  await new Promise((r) => (fake ? fake.server.close(r) : r()));
  await build({ quiet: true }); // the update test built a salted version; leave dist/ as a plain build
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ------------------------------------------------------------------------------------------------ tests
test('manifest: valid, served as application/manifest+json, icons load at their declared sizes; page links and meta tags', async () => {
  const r = await fetch(`${BASE}/manifest.webmanifest`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^application\/manifest\+json/);
  const m = await r.json();
  assert.equal(m.name, 'Parlance Exchange'); assert.equal(m.short_name, 'Parlance');
  assert.equal(m.start_url, '/'); assert.equal(m.scope, '/'); assert.equal(m.display, 'standalone');
  assert.equal(m.theme_color, '#008751', 'brand green'); assert.equal(m.background_color, '#0d0e11', 'dark surface');
  assert.deepEqual(m.shortcuts.map((s) => [s.name, s.url]), [['Markets', '/browse'], ['Portfolio', '/portfolio'], ['Deposit', '/funds/deposit']]);
  assert.deepEqual(m, content.manifestOf(content.PWA_CONFIG), 'the manifest is built from the one config object');
  // Every {{key}} of the offline template exists in the keyed strings, and the served page carries their text.
  const strings = content.clientStrings();
  const off = await (await fetch(`${BASE}/offline.html`)).text();
  for (const k of ['offline.heading', 'offline.retry', 'offline.home']) assert.ok(off.includes(content.escHtml(strings[k])), k);
  assert.ok(!/\{\{/.test(off), 'no unfilled placeholder');
  const swText = await (await fetch(`${BASE}/sw.js`)).text();
  assert.ok(swText.includes(JSON.stringify(strings['offline.fallback_text'])), 'service worker fallback text from the keyed strings');
  const want = [['/icons/icon-192.png', 192, 'any'], ['/icons/icon-512.png', 512, 'any'], ['/icons/icon-maskable-512.png', 512, 'maskable']];
  for (const [src, size, purpose] of want) {
    const icon = m.icons.find((i) => i.src === src);
    assert.ok(icon, src); assert.equal(icon.sizes, `${size}x${size}`); assert.equal(icon.purpose, purpose); assert.equal(icon.type, 'image/png');
  }
  for (const [src, size] of [...want, ['/icons/apple-touch-icon.png', 180], ['/icons/badge-72.png', 72]]) {
    const ir = await fetch(BASE + src);
    assert.equal(ir.status, 200, src); assert.equal(ir.headers.get('content-type'), 'image/png');
    const b = Buffer.from(await ir.arrayBuffer());
    assert.equal(b.subarray(1, 4).toString('latin1'), 'PNG');
    assert.deepEqual([b.readUInt32BE(16), b.readUInt32BE(20)], [size, size], `${src} dimensions`);
  }
  const svg = await fetch(`${BASE}/icons/icon.svg`);
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
  assert.match(svg.headers.get('content-security-policy'), /default-src 'none'/, 'SVG served with the locked-down API policy');
  for (const p of ['/v1/push/vapid_public_key', '/manifest.webmanifest']) assert.equal((await fetch(BASE + p)).status, 200);
  assert.equal((await fetch(`${BASE}/icons/../server/app.js`)).status, 404);
  assert.equal((await fetch(`${BASE}/icons/nope.gif`)).status, 404);

  const ctx = await newContext();
  const page = await newPage(ctx);
  await page.goto(BASE + '/');
  await page.waitForSelector('#account-area a');
  const head = await page.evaluate(() => ({
    manifest: document.querySelector('link[rel=manifest]')?.getAttribute('href'),
    theme: [...document.querySelectorAll('meta[name=theme-color]')].map((x) => [x.content, x.media]),
    apple: document.querySelector('link[rel=apple-touch-icon]')?.getAttribute('href'),
    capable: document.querySelector('meta[name=apple-mobile-web-app-capable]')?.content,
    title: document.querySelector('meta[name=apple-mobile-web-app-title]')?.content,
  }));
  assert.deepEqual(head, { manifest: '/manifest.webmanifest', theme: [['#008751', '(prefers-color-scheme: light)'], ['#13a866', '(prefers-color-scheme: dark)']], apple: '/icons/apple-touch-icon.png', capable: 'yes', title: 'Parlance' });
  // The browser parses the manifest without errors and every icon decodes in the page.
  const cdp = await ctx.newCDPSession(page);
  const am = await cdp.send('Page.getAppManifest');
  assert.equal(am.url, `${BASE}/manifest.webmanifest`);
  assert.deepEqual(am.errors, [], 'manifest parse errors');
  const sizes = await page.evaluate((list) => Promise.all(list.map((src) => new Promise((res) => { const i = new Image(); i.onload = () => res([src, i.naturalWidth]); i.onerror = () => res([src, 0]); i.src = src; }))), [...m.icons.map((i) => i.src), '/icons/apple-touch-icon.png']);
  for (const [src, w] of sizes) assert.ok(w > 0, `${src} decodes`);
  await clean(page);
  await ctx.close();
});

test('service worker registers and controls the page; precached hashed assets come from the cache; no HTML or /v1 response is ever cached', async () => {
  const { email } = await signUp('cache');
  const ctx = await newContext();
  const page = await newPage(ctx);
  await logIn(page, email);
  const version = await controlled(page);
  const reg = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration('/'); return { scope: r.scope, script: r.active.scriptURL, preload: r.navigationPreload ? (await r.navigationPreload.getState()).enabled : null }; });
  assert.deepEqual(reg, { scope: `${BASE}/`, script: `${BASE}/sw.js`, preload: true });
  const swr = await fetch(`${BASE}/sw.js`);
  assert.equal(swr.headers.get('cache-control'), 'no-cache');
  assert.match(swr.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.ok((await swr.text()).includes(JSON.stringify(version)), 'the service worker carries the build version');

  // Reload and browse signed-in pages: hashed assets are answered by the service worker from its cache.
  const fromSw = new Map();
  page.on('response', (res) => { const u = new URL(res.url()); if (u.origin === BASE) fromSw.set(u.pathname, res.fromServiceWorker()); });
  const navCsp = [];
  for (const p of ['/', '/portfolio', '/browse', '/notifications/settings', '/account']) {
    const res = await page.goto(BASE + p);
    navCsp.push(/'nonce-([^']+)'/.exec(res.headers()['content-security-policy'])[1]);
    await page.waitForSelector('[data-testid=account-menu]');
    await page.waitForLoadState('networkidle');
  }
  const m = readManifest();
  assert.equal(fromSw.get(`/assets/${m.entry.js}`), true, 'entry module from the service worker cache');
  assert.equal(fromSw.get(`/assets/${m.entry.css}`), true, 'stylesheet from the service worker cache');
  assert.equal(new Set(navCsp).size, navCsp.length, 'every navigation got a fresh CSP nonce from the network');

  const entries = await cacheEntries(page);
  const precache = new Set(m.pwa.precache);
  assert.equal(entries.length, precache.size, 'exactly the precache list is stored');
  for (const e of entries) {
    assert.equal(e.cache, `plx-static-${version}`);
    assert.ok(precache.has(e.path) && !e.search, `${e.path} is a precached path`);
    assert.ok(!/^\/(v1|trade-api)(\/|$)/.test(e.path), `${e.path}: no API response is cached`);
    assert.ok(!/no-store|private/.test(e.cc), `${e.path}: nothing marked no-store or private`);
    if (/text\/html/.test(e.type)) {
      assert.equal(e.path, '/offline.html', 'the only HTML in the cache is the static offline page');
      assert.ok(!/nonce=|plx-boot|<script/i.test(e.text), 'the offline page has no nonce, boot proof or script');
    }
  }
  assert.ok(!entries.some((e) => ['/', '/portfolio', '/browse', '/sw.js'].includes(e.path)));
  await clean(page);
  await ctx.close();
});

test('offline: a navigation shows the static offline page (styled from the cache, strict CSP); back online, Retry recovers', async () => {
  const ctx = await newContext();
  const page = await newPage(ctx);
  await page.goto(BASE + '/');
  await controlled(page);
  await ctx.setOffline(true);
  await page.goto(BASE + '/browse').catch(() => {});
  await page.waitForSelector('[data-testid=offline-page]');
  assert.equal(await page.title(), 'Offline · Parlance');
  assert.equal(new URL(page.url()).pathname, '/browse', 'the address stays the page the user asked for');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.offline-page')).display), 'grid', 'stylesheet served from the cache');
  assert.equal(await page.evaluate(() => document.querySelectorAll('script').length), 0);
  assert.equal(await page.getAttribute('[data-testid=offline-retry]', 'href'), '');
  await ctx.setOffline(false);
  await page.click('[data-testid=offline-retry]');
  await page.waitForSelector('[data-testid=market-card], .market-card, #view h1', { timeout: 15000 });
  assert.equal(new URL(page.url()).pathname, '/browse');
  assert.equal(await page.locator('[data-testid=offline-page]').count(), 0);
  await clean(page);
  await ctx.close();
});

test('update: a rebuilt version shows "New version available — Reload"; the click activates it and reloads', async () => {
  const ctx = await newContext();
  const page = await newPage(ctx);
  await page.goto(BASE + '/');
  const v1 = await controlled(page);
  assert.equal(await page.locator('[data-testid=pwa-update]').count(), 0, 'no toast for the first install');
  const m2 = await build({ quiet: true, salt: `update-${stamp}` });
  assert.notEqual(m2.pwa.version, v1);
  await page.evaluate(() => navigator.serviceWorker.getRegistration('/').then((r) => r.update()));
  await page.waitForSelector('[data-testid=pwa-update]', { timeout: 15000 });
  assert.equal(await page.textContent('[data-testid=pwa-update]'), `${content.clientStrings()['update.message']}${content.clientStrings()['update.reload']}`);
  // The new worker waits: the old one still controls the page and its cache is intact until the user agrees.
  assert.equal(await page.evaluate(() => navigator.serviceWorker.getRegistration('/').then((r) => !!r.waiting)), true);
  await Promise.all([page.waitForNavigation(), page.click('[data-testid=pwa-reload]')]);
  await page.waitForSelector('#account-area a');
  await until(() => page.evaluate((v) => caches.keys().then((k) => k.includes(`plx-static-${v}`)), m2.pwa.version), 10000, 'new cache');
  const keys = await page.evaluate(() => caches.keys());
  assert.ok(!keys.includes(`plx-static-${v1}`), 'the previous version\'s cache is deleted on activation');
  assert.equal(await page.evaluate(() => navigator.serviceWorker.getRegistration('/').then((r) => !r.waiting && !!r.active)), true);
  assert.equal(await page.locator('[data-testid=pwa-update]').count(), 0);
  await clean(page);
  await ctx.close();
});

test('install: "Install app" appears with beforeinstallprompt (signed out and in the ☰ menu), iOS Safari gets instructions, hidden when standalone', async () => {
  const fire = (page) => page.evaluate(() => {
    const e = new Event('beforeinstallprompt', { cancelable: true });
    e.prompt = () => { window.__prompted = true; return Promise.resolve(); };
    e.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
  // Signed out.
  let ctx = await newContext();
  let page = await newPage(ctx);
  await page.goto(BASE + '/');
  await page.waitForSelector('#account-area a');
  assert.equal(await page.locator('[data-testid=guest-menu]').count(), 0, 'no menu while installation is not offered');
  assert.equal(await fire(page), true, 'the browser mini-infobar is suppressed (preventDefault)');
  await page.click('[data-testid=guest-menu]');
  await page.click('[data-testid=menu-install]');
  assert.equal(await page.evaluate(() => window.__prompted), true, 'the deferred prompt is shown');
  await until(() => page.locator('[data-testid=guest-menu]').count().then((n) => n === 0), 5000, 'used prompt removes the entry');
  // Signed in: the ☰ account menu.
  const { email } = await signUp('install');
  await logIn(page, email);
  await fire(page);
  await page.click('[data-testid=account-menu]');
  await page.waitForSelector('.hamburger-menu [data-testid=menu-install]');
  await page.click('[data-testid=menu-install]');
  await clean(page);
  await ctx.close();

  // 390 px: the signed-out header still fits with the extra button.
  ctx = await newContext({ viewport: { width: 390, height: 844 } });
  page = await newPage(ctx);
  await page.goto(BASE + '/');
  await page.waitForSelector('#account-area a');
  await fire(page);
  await page.waitForSelector('[data-testid=guest-menu]');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll at 390 px');
  await ctx.close();

  // iOS Safari: no beforeinstallprompt; the entry opens Add-to-Home-Screen steps.
  ctx = await newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page = await newPage(ctx);
  await page.goto(BASE + '/');
  await page.click('[data-testid=guest-menu]');
  await page.click('[data-testid=menu-install]');
  await page.waitForSelector('[data-testid=ios-install]');
  assert.match(await page.textContent('[data-testid=ios-install]'), /Share.*Add to Home Screen.*Add/s);
  await page.click('[data-testid=ios-install] [data-close]');
  await ctx.close();

  // Already installed (display-mode: standalone): never offered.
  ctx = await newContext();
  await ctx.addInitScript(() => { const mm = window.matchMedia.bind(window); window.matchMedia = (q) => (/display-mode:\s*standalone/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : mm(q)); });
  page = await newPage(ctx);
  await page.goto(BASE + '/');
  await page.waitForSelector('#account-area a');
  await fire(page);
  await sleep(300);
  assert.equal(await page.locator('[data-testid=guest-menu]').count(), 0, 'installed: no install entry');
  await clean(page);
  await ctx.close();
});

test('Web Push: subscribe in the browser, a fill is delivered to the fake push service (VAPID verified, aes128gcm decrypted), the service worker shows it, test send, 410 removes the subscription', async () => {
  const { email, c, uid } = await signUp('push');
  const sub = fake.newSub(`dev-${stamp}`);
  const ctx = await newContext({ permissions: ['notifications'] }, fullBrowser);
  await stubPushManager(ctx, sub);
  const page = await newPage(ctx);
  await logIn(page, email);
  await controlled(page);
  await page.goto(BASE + '/notifications/settings');
  await page.click('[data-testid=webpush-enable]');
  await page.waitForSelector('[data-testid=webpush-on]');
  await page.waitForSelector('[data-testid=webpush-device]');
  assert.match(await page.textContent('[data-testid=webpush-device]'), /This device/);
  assert.equal(await page.evaluate(() => window.__subscribeKey), (await (await fetch(`${BASE}/v1/push/vapid_public_key`)).json()).public_key, 'subscribed with the server\'s VAPID key');
  const row = dbq('SELECT * FROM push_subscriptions WHERE user_id=?', uid)[0];
  assert.ok(row, 'one subscription row');
  assert.ok(row.endpoint_enc.startsWith('enc:v1:') && row.keys_enc.startsWith('enc:v1:') && !row.endpoint_enc.includes('push/'), 'endpoint and keys encrypted at rest');

  // A real app event: the taker-side trade confirmation with Push on, then a market order that fills.
  assert.equal((await c.call('PUT', `/v1/users/${uid}/notifications/settings/taker_trade`, { push: true })).status, 200);
  assert.equal((await c.call('POST', `/v1/users/${uid}/deposits`, { amount_dollars: 200 })).status, 201);
  assert.equal((await c.call('POST', `/v1/users/${uid}/orders`, { ticker: activeMarket().ticker, side: 'yes', type: 'market', count: 2 })).status, 201);
  const got = await until(() => fake.of(`dev-${stamp}`).find((r) => r.ok && /Order filled/.test(r.payload.title)), 15000, 'fill push at the fake push service');
  assert.equal(got.headers.urgency, 'normal');
  assert.equal(got.claims.sub, 'mailto:ops@parlance.example');
  assert.equal(got.recordLength % 128, 0, 'padded to a 128-byte boundary');
  assert.deepEqual(Object.keys(got.payload).sort(), ['body', 'link', 'tag', 'title', 'ts'], 'payload holds only what the notification shows');
  const inbox = dbq("SELECT title, body, link FROM notifications WHERE user_id=? AND type='fill' ORDER BY created_ts DESC LIMIT 1", uid)[0];
  assert.deepEqual([got.payload.title, got.payload.body, got.payload.link], [inbox.title, inbox.body, inbox.link], 'same text as the in-app notification');
  assert.equal(dbq("SELECT status FROM push_outbox WHERE sub_id=? AND delivery_id=?", row.id, got.payload.tag)[0].status, 'sent');
  assert.ok(!dbq('SELECT payload_enc FROM push_outbox WHERE sub_id=?', row.id).some((r) => r.payload_enc.includes('Order')), 'outbox payloads encrypted at rest');

  // The service worker turns the decrypted message into a system notification; a click routes to the deep link.
  const cdp = await ctx.newCDPSession(page);
  const regs = [];
  cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => regs.push(...e.registrations));
  await cdp.send('ServiceWorker.enable');
  const swReg = await until(() => regs.find((r) => r.scopeURL === `${BASE}/` && !r.isDeleted), 5000, 'registration id');
  await cdp.send('ServiceWorker.deliverPushMessage', { origin: BASE, registrationId: swReg.registrationId, data: JSON.stringify(got.payload) });
  const shown = await until(() => page.evaluate(() => navigator.serviceWorker.ready.then((r) => r.getNotifications()).then((ns) => ns.map((n) => ({ title: n.title, body: n.body, icon: n.icon, link: n.data && n.data.link, tag: n.tag })))).then((ns) => ns.length && ns), 8000, 'notification shown');
  assert.deepEqual(shown[0], { title: got.payload.title, body: got.payload.body, icon: `${BASE}/icons/icon-192.png`, link: got.payload.link, tag: got.payload.tag });
  const worker = ctx.serviceWorkers().find((w) => w.url() === `${BASE}/sw.js`);
  await worker.evaluate(async () => { const [n] = await self.registration.getNotifications(); try { self.dispatchEvent(new NotificationEvent('notificationclick', { notification: n })); } catch { /* untrusted event: waitUntil throws after routing starts */ } });
  await until(() => new URL(page.url()).pathname === got.payload.link, 8000, 'deep link opened');
  // A hostile payload cannot point the click anywhere else.
  await cdp.send('ServiceWorker.deliverPushMessage', { origin: BASE, registrationId: swReg.registrationId, data: JSON.stringify({ title: 'x', body: 'y', link: '//evil.example/phish', tag: 'evil' }) });
  const evil = await until(() => page.evaluate(() => navigator.serviceWorker.ready.then((r) => r.getNotifications({ tag: 'evil' }))).then((ns) => ns.length && ns), 8000, 'hostile notification');
  assert.equal(evil.length, 1);
  assert.equal(await page.evaluate(() => navigator.serviceWorker.ready.then((r) => r.getNotifications({ tag: 'evil' })).then((ns) => ns[0].data.link)), '/');

  // "Send test notification" from the device list.
  await page.goto(BASE + '/notifications/settings');
  await page.click('[data-testid=webpush-test]');
  await until(() => fake.of(`dev-${stamp}`).find((r) => r.ok && r.payload.title === 'Test notification'), 10000, 'test notification');
  await page.waitForSelector('[data-testid=webpush-device]:has-text("last delivered")');

  // Validation: http outside the test allowlist, unknown push services, IP literals, bad keys, unknown fields.
  const ok = fake.newSub('spare');
  for (const [body, code] of [
    [{ ...ok, endpoint: 'http://push.example.com/x' }, 'validation_failed'], [{ ...ok, endpoint: 'https://evil.example/push' }, 'push_service_not_supported'],
    [{ ...ok, endpoint: 'https://10.0.0.1/push' }, 'validation_failed'], [{ ...ok, endpoint: 'https://fcm.googleapis.com:8443/x' }, 'validation_failed'],
    [{ ...ok, keys: { p256dh: 'AAAA', auth: ok.keys.auth } }, 'validation_failed'], [{ ...ok, keys: { p256dh: ok.keys.p256dh, auth: 'AAAA' } }, 'validation_failed'],
    [{ ...ok, extra: 1 }, 'validation_failed'], [{ ...ok, keys: 'x' }, 'validation_failed'],
  ]) {
    const r = await c.call('POST', `/v1/users/${uid}/push_subscriptions`, body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 120)); assert.equal(r.code, code);
  }
  const other = await signUp('push-other');
  assert.equal((await other.c.call('POST', `/v1/users/${uid}/push_subscriptions`, ok)).status, 403, 'another user\'s path');
  assert.equal((await other.c.call('DELETE', `/v1/users/${other.uid}/push_subscriptions/${row.id}`)).status, 404, 'another user\'s subscription id');

  // The push service reports the subscription gone: the row is deleted and the device list empties.
  fake.modes.set(`dev-${stamp}`, 410);
  await page.click('[data-testid=webpush-test]');
  await until(() => dbq('SELECT COUNT(*) n FROM push_subscriptions WHERE id=?', row.id)[0].n === 0, 10000, 'subscription deleted after 410');
  assert.deepEqual((await c.call('GET', `/v1/users/${uid}/push_subscriptions`)).body.subscriptions, []);
  // (A page load would re-subscribe a browser that still has permission and its opt-in; here the browser forgets it.)
  await page.evaluate(() => localStorage.removeItem('plx-webpush'));
  await page.goto(BASE + '/notifications/settings');
  await page.waitForSelector('[data-testid=webpush-none]');
  await clean(page);
  await ctx.close();
});

test('outbox: a delivery that failed with 503 is retried with backoff and survives a restart (rows caught mid-send resume)', async () => {
  const { c, uid } = await signUp('outbox');
  const subA = fake.newSub(`retry-${stamp}`); const subB = fake.newSub(`mid-${stamp}`);
  fake.modes.set(`retry-${stamp}`, 503);
  const a = (await c.call('POST', `/v1/users/${uid}/push_subscriptions`, { ...subA, label: 'Phone' })).body.subscription;
  const b = (await c.call('POST', `/v1/users/${uid}/push_subscriptions`, { ...subB, label: 'Tablet' })).body.subscription;
  assert.ok(a && b);
  fake.modes.set(`mid-${stamp}`, 503);
  assert.equal((await c.call('POST', `/v1/users/${uid}/push_subscriptions/${a.id}/test`, {})).status, 202);
  assert.equal((await c.call('POST', `/v1/users/${uid}/push_subscriptions/${b.id}/test`, {})).status, 202);
  await until(() => dbq("SELECT * FROM push_outbox WHERE sub_id=? AND attempts>=2 AND status='pending' AND last_status=503", a.id)[0], 10000, 'retried with backoff');
  await until(() => dbq("SELECT * FROM push_outbox WHERE sub_id=? AND attempts>=1 AND last_status=503", b.id)[0], 10000, 'second row attempted');
  await srv.close();
  const before = dbq('SELECT * FROM push_outbox WHERE sub_id IN (?,?)', a.id, b.id);
  assert.ok(before.every((r) => ['pending', 'sending'].includes(r.status)), JSON.stringify(before.map((r) => r.status)));
  dbrun("UPDATE push_outbox SET status='sending' WHERE sub_id=?", b.id); // as if the process died mid-request
  fake.modes.set(`retry-${stamp}`, 201); fake.modes.set(`mid-${stamp}`, 202);
  srv = await start(opts());
  await until(() => fake.of(`retry-${stamp}`).find((r) => r.ok && r.headers && r.at > Date.now() - 20000 && r.payload.title === 'Test notification') && dbq("SELECT status FROM push_outbox WHERE sub_id=?", a.id)[0].status === 'sent', 15000, 'delivered after restart');
  await until(() => dbq('SELECT status FROM push_outbox WHERE sub_id=?', b.id)[0].status === 'sent', 15000, 'mid-send row resumed');
  const ra = dbq('SELECT * FROM push_outbox WHERE sub_id=?', a.id)[0];
  assert.ok(ra.attempts >= 3, `attempts ${ra.attempts}`);
  assert.equal(fake.of(`retry-${stamp}`).filter((r) => r.error).length, 0, 'every attempt carried a valid JWT and payload');
  const subs = (await c.call('GET', `/v1/users/${uid}/push_subscriptions`)).body.subscriptions;
  assert.ok(subs.find((s) => s.id === a.id).last_success_time, 'last delivery shown');
  assert.ok(!JSON.stringify(subs).includes('/push/'), 'endpoints never leave the server');
});

test('sign-out clears Cache Storage and removes this browser\'s push subscription; the next page load precaches again', async () => {
  const { email, uid } = await signUp('signout');
  const sub = fake.newSub(`so-${stamp}`);
  const ctx = await newContext({ permissions: ['notifications'] }, fullBrowser);
  await stubPushManager(ctx, sub);
  const page = await newPage(ctx);
  await logIn(page, email);
  await controlled(page);
  await page.goto(BASE + '/notifications/settings');
  await page.click('[data-testid=webpush-enable]');
  await page.waitForSelector('[data-testid=webpush-on]');
  assert.equal(dbq('SELECT COUNT(*) n FROM push_subscriptions WHERE user_id=?', uid)[0].n, 1);
  assert.ok((await page.evaluate(() => caches.keys())).length >= 1);
  await page.click('[data-testid=account-menu]');
  await page.click('[data-testid=menu-logout]');
  await page.waitForSelector('#account-area a[href="/sign-in"]');
  await until(() => page.evaluate(() => caches.keys().then((k) => k.length === 0)), 5000, 'caches cleared');
  assert.equal(dbq('SELECT COUNT(*) n FROM push_subscriptions WHERE user_id=?', uid)[0].n, 0, 'server row removed before the session ended');
  assert.equal(await page.evaluate(() => window.__unsubscribed), 1, 'browser subscription unsubscribed');
  assert.equal(await page.evaluate(() => localStorage.getItem('plx-webpush')), null);
  await page.reload();
  await controlled(page);
  await clean(page);
  await ctx.close();
});

test('bot challenge and client tokens keep working through the service worker (navigation preload, untouched API requests)', async () => {
  const ctx = await newContext();
  const page = await newPage(ctx);
  await page.goto(BASE + '/');
  await controlled(page);
  await srv.close();
  challengeMode = 'all';
  try {
    srv = await start(opts());
    await ctx.clearCookies();
    const seen = [];
    page.on('response', (r) => { if (r.request().isNavigationRequest()) seen.push([r.status(), r.fromServiceWorker()]); });
    await page.goto(BASE + '/browse');
    await page.waitForSelector('[data-link][href="/sign-in"]', { timeout: 20000 });
    assert.ok(seen.some(([s, sw]) => s === 429 && sw), `challenge page passed through the service worker: ${JSON.stringify(seen)}`);
    assert.ok(seen.some(([s]) => s === 200), 'reloaded after solving');
    // Writes still carry the signed client token: a sign-up from this controlled page works.
    const email = `pwa.chk.${stamp}@example.test`;
    await page.goto(BASE + '/sign-up');
    await page.fill('input[name=email]', email);
    await page.fill('input[name=password]', PW);
    await page.fill('input[name=display_name]', 'PWA Challenge');
    await page.click('button[type=submit]');
    await until(() => dbq('SELECT COUNT(*) n FROM users WHERE email=?', email)[0].n === 1, 15000, 'sign-up through the controlled page');
    await clean(page);
  } finally {
    await ctx.close();
    await srv.close();
    challengeMode = 'off';
    srv = await start(opts());
  }
});
