'use strict';
// Perimeter security E2E (PLAN Phase 1A; CLONE_SPEC.md §21): security headers + per-response CSP nonce, a strict
// style CSP with no violations in a real browser, self-hosted fonts, CORS allowlist, proof-of-work bot challenge, signed
// client tokens on writes and the WebSocket, honeypots, hashed immutable assets without source maps, tiered + persisted
// rate limits, runtime-editable taker fee / rolling window / limits (G7) with audit, Admin › Security, restart persistence.
// Runs against the production bundle (assets: 'dist'), built on demand when dist/ is missing or stale.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const WebSocket = require('ws');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const { DIST, sourceHash } = require('../scripts/build.js');
const { fetchClientToken, clientTokens, solvePow } = require('./helpers/client-token');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-perimeter-'));
const DB_FILE = path.join(TMP, 'perimeter.db');
// Ports are picked free at runtime: other suites (and other agents' servers) may run on this machine at the same time.
const net = require('node:net');
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
let PORT; let BASE;
const PARTNER = 'https://partner.example';
const ADMIN = { email: 'admin@parlance.local', password: 'Harbor-Signal-4417!' };
const DEMO_PW = 'Perimeter-Demo-2026';
const opts = () => ({ port: PORT, dbFile: DB_FILE, tickMs: 300, admin: ADMIN, demoPassword: DEMO_PW, quiet: true, assets: 'dist', security: { allowedOrigins: [PARTNER] } });
const EVENT_URL = '/markets/plxcup/northern-cup-final/plxcup-26final';
const RAV = 'PLXCUP-26FINAL-RAV';
// What a desktop Chrome navigation sends (Playwright's headless Chromium sends the same minus Accept-Language).
const BROWSER = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36', accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none', 'sec-ch-ua': '"Chromium";v="131"' };

let srv; let browser;
let ct; // signed client token for Node-side calls to the main server (set once the port is known)
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const events = (kind) => dbq('SELECT * FROM security_events WHERE kind=? ORDER BY id', kind);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cspOf = (r) => r.headers.get('content-security-policy') || '';
const nonceOf = (csp) => /'nonce-([^']+)'/.exec(csp)?.[1];

// Cookie-jar API client (Node fetch): login CSRF, session CSRF and the signed client token on every request.
function apiClient(base = BASE, tokens = ct) {
  const cookies = {}; let csrf = '';
  const jar = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie: jar(), 'x-csrf-token': csrf, 'x-client-token': await tokens(), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of r.headers.getSetCookie()) { const kv = sc.split(';')[0]; const i = kv.indexOf('='); cookies[kv.slice(0, i)] = kv.slice(i + 1); }
    const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
    if (json && json.csrf_token) csrf = json.csrf_token;
    return { status: r.status, body: json, headers: r.headers };
  };
  const c = { call, uid: null };
  c.login = async (u) => { await call('GET', '/v1/auth/csrf'); const r = await call('POST', '/v1/log_in', { email: u.email, password: u.password }); c.uid = r.body?.user?.user_id; return r; };
  c.signup = async (u) => { await call('GET', '/v1/auth/csrf'); const r = await call('POST', '/v1/users', { email: u.email, password: u.password, display_name: u.name }); c.uid = r.body?.user?.user_id; return r; };
  return c;
}

// Fresh browser context that records CSP violations, console errors, page errors and every request URL.
async function newPage(b = browser, viewport = { width: 1440, height: 1000 }) {
  const ctx = await b.newContext({ viewport });
  await ctx.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.effectiveDirective} blocked=${e.blockedURI} at ${e.sourceFile}:${e.lineNumber} ${e.sample || ''}`));
  });
  const page = await ctx.newPage();
  page.errors = []; page.consoleErrors = []; page.urls = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') page.consoleErrors.push(m.text()); });
  page.on('request', (r) => page.urls.push(r.url()));
  return page;
}
const violations = (page) => page.evaluate(() => window.__csp);
async function logIn(page, u, base = BASE) {
  await page.goto(`${base}/sign-in`);
  await page.fill('input[name=email]', u.email);
  await page.fill('input[name=password]', u.password);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
}

before(async () => { PORT = await freePort(); BASE = `http://127.0.0.1:${PORT}`; ct = clientTokens(BASE); srv = await start(opts()); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('security headers on HTML, API and static responses; no-store on authenticated responses; HSTS only behind trusted https', async () => {
  const html = await fetch(`${BASE}/`, { headers: BROWSER });
  assert.equal(html.status, 200);
  const csp = cspOf(html);
  for (const d of ["default-src 'self'", "img-src 'self' data:", "font-src 'self'", "frame-ancestors 'self'", "base-uri 'none'", "form-action 'self'", "object-src 'none'", 'report-uri /v1/csp-report', 'report-to csp']) assert.ok(csp.includes(d), `site CSP has ${d}: ${csp}`);
  assert.match(csp, /script-src 'self' 'nonce-[A-Za-z0-9+/=]{24}'/);
  assert.match(csp, /style-src 'self' 'nonce-[A-Za-z0-9+/=]{24}'/);
  assert.ok(csp.includes(`connect-src 'self' ws://127.0.0.1:${PORT} wss://127.0.0.1:${PORT}`), csp);
  assert.ok(!/unsafe-inline|unsafe-eval|\*/.test(csp), 'no unsafe-inline / unsafe-eval / wildcards');
  assert.equal(html.headers.get('reporting-endpoints'), `csp="${BASE}/v1/csp-report"`);
  const common = (r, what) => {
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', what);
    assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', what);
    assert.match(r.headers.get('permissions-policy'), /camera=\(\).*geolocation=\(\).*microphone=\(\).*payment=\(\)/, what);
    assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin', what);
    assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin', what);
    assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN', what);
    assert.equal(r.headers.get('strict-transport-security'), null, `${what}: no HSTS on plain http`);
    assert.equal(r.headers.get('x-powered-by'), null, what);
  };
  common(html, 'html');
  assert.equal(html.headers.get('cache-control'), 'no-store', 'HTML carries a per-response nonce: never cached');

  const api = await fetch(`${BASE}/trade-api/v2/exchange/status`);
  assert.equal(cspOf(api), "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  common(api, 'api');
  const body = await html.text();
  const asset = /src="(\/assets\/main-[A-Z0-9]+\.js)"/.exec(body)[1];
  const st = await fetch(BASE + asset);
  assert.equal(st.status, 200);
  common(st, 'static');

  // Authenticated and /v1/users/* responses are no-store (S5).
  const c = apiClient();
  assert.equal((await c.login({ email: 'maple_quant@parlance.local', password: DEMO_PW })).status, 200);
  for (const p of ['/v1/session', `/v1/users/${c.uid}/balance`, '/trade-api/v2/exchange/status']) assert.equal((await c.call('GET', p)).headers.get('cache-control'), 'no-store', p);
  assert.equal((await fetch(`${BASE}/v1/users/u_nobody/balance`)).headers.get('cache-control'), 'no-store');

  // HSTS: only with NODE_ENV=production or a trusted proxy that says the client used https.
  const P1 = await freePort();
  const prox = await start({ port: P1, dbFile: path.join(TMP, 'proxy.db'), quiet: true, security: { trustProxy: 'loopback' } });
  try {
    const viaHttps = await fetch(`http://127.0.0.1:${P1}/trade-api/v2/exchange/status`, { headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(viaHttps.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
    assert.equal((await fetch(`http://127.0.0.1:${P1}/trade-api/v2/exchange/status`)).headers.get('strict-transport-security'), null);
  } finally { await prox.close(); }
  // Without trust configured, a spoofed X-Forwarded-Proto is ignored.
  assert.equal((await fetch(`${BASE}/trade-api/v2/exchange/status`, { headers: { 'x-forwarded-proto': 'https' } })).headers.get('strict-transport-security'), null);
});

test('CSP nonce rotates per response and is the one on the page\'s script and stylesheet tags', async () => {
  const seen = new Set();
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${BASE}${EVENT_URL}`, { headers: BROWSER });
    const n = nonceOf(cspOf(r));
    const html = await r.text();
    assert.ok(n && !seen.has(n), 'fresh nonce per response'); seen.add(n);
    const attrs = [...html.matchAll(/nonce="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(attrs.length >= 2, 'script + stylesheet carry the nonce');
    assert.ok(attrs.every((a) => a === n), 'every nonce attribute matches the header');
    assert.ok(!html.includes('__CSP_NONCE__') && !html.includes('__PLX_BOOT__'), 'template placeholders replaced');
    assert.match(html, /<meta name="plx-boot" content="[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+">/);
    assert.ok(!/ style="/.test(html), 'no inline style attributes in the page');
  }
});

test('no CSP violations across the main routes in a real browser; fonts are self-hosted; the detector itself works', async () => {
  const page = await newPage();
  // Positive control: an inline style attribute IS reported, so zero below means zero.
  await page.goto(`${BASE}/browse`);
  await page.waitForSelector('[data-testid=event-card]');
  await page.evaluate(() => { const d = document.createElement('div'); d.innerHTML = '<span style="color:red">x</span>'; document.body.append(d); });
  await page.waitForFunction(() => window.__csp.length > 0);
  assert.match((await violations(page))[0], /^style-src-attr/);

  const anon = ['/', '/browse', '/live', '/calendar', '/pro', '/perps', '/combos', '/sports', '/social', '/social/leaderboard', EVENT_URL, '/category/sports', '/search?q=cup', '/sign-in', '/sign-up', '/no-such-page'];
  for (const r of anon) {
    await page.goto(BASE + r);
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    assert.deepEqual(await violations(page), [], `CSP violations on ${r}`);
  }
  await page.goto(`${BASE}/`);
  await page.waitForSelector('[data-testid=hero-title]');
  const fonts = await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '')); });
  assert.ok(fonts.includes('Inter') && fonts.includes('Barlow Condensed'), `self-hosted fonts loaded: ${fonts}`);
  const foreign = page.urls.filter((u) => !u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith(`ws://127.0.0.1:${PORT}`));
  assert.deepEqual(foreign, [], 'every request is same-origin (no Google Fonts or other third parties)');
  assert.ok(page.urls.some((u) => /\/assets\/inter-latin-wght-normal-[A-Z0-9]+\.woff2$/.test(u)), 'Inter is served from /assets');
  assert.deepEqual(page.errors, []);
  await page.context().close();

  // Signed in (trader + admin views).
  const pa = await newPage();
  await logIn(pa, ADMIN);
  const authed = ['/portfolio', '/portfolio?perpsTab=positions', '/watchlist', '/notifications', '/account', '/account/security', '/account/limits', EVENT_URL, '/admin/catalog', '/admin/ops', '/admin/users', '/admin/reports', '/admin/audit', '/admin/settings', '/admin/security'];
  for (const r of authed) {
    await pa.goto(BASE + r);
    await pa.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    assert.deepEqual(await violations(pa), [], `CSP violations on ${r}`);
  }
  assert.deepEqual(pa.errors, []);
  assert.deepEqual(pa.consoleErrors.filter((e) => /Content Security Policy|Refused to/i.test(e)), []);
  await pa.context().close();
  assert.equal(events('csp_report').length, 0, 'no CSP reports reached the server');
});

test('CSP report endpoint stores size-capped reports and rate-limits them', async () => {
  const before0 = events('csp_report').length;
  const rep = { 'csp-report': { 'document-uri': `${BASE}/portfolio?secret=1`, 'blocked-uri': 'https://evil.example/x.js?q=1', 'violated-directive': 'script-src-elem', 'effective-directive': 'script-src-elem', 'original-policy': 'x'.repeat(500), 'source-file': `${BASE}/assets/x.js`, 'line-number': 3, 'script-sample': 'alert(1)'.repeat(50) } };
  const r = await fetch(`${BASE}/v1/csp-report`, { method: 'POST', headers: { 'content-type': 'application/csp-report' }, body: JSON.stringify(rep) });
  assert.equal(r.status, 204);
  const row = events('csp_report').at(-1);
  const d = JSON.parse(row.detail);
  assert.equal(d.document, `${BASE}/portfolio`, 'query strings stripped');
  assert.equal(d.blocked, 'https://evil.example/x.js');
  assert.equal(d.directive, 'script-src-elem');
  assert.ok(d.sample.length <= 80);
  // Reporting API batch format.
  const batch = [{ type: 'csp-violation', body: { documentURL: `${BASE}/`, blockedURL: 'inline', effectiveDirective: 'style-src-attr', disposition: 'enforce' } }];
  assert.equal((await fetch(`${BASE}/v1/csp-report`, { method: 'POST', headers: { 'content-type': 'application/reports+json' }, body: JSON.stringify(batch) })).status, 204);
  assert.equal(JSON.parse(events('csp_report').at(-1).detail).directive, 'style-src-attr');
  // Wrong type, oversized body.
  assert.equal((await fetch(`${BASE}/v1/csp-report`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })).status, 415);
  assert.equal((await fetch(`${BASE}/v1/csp-report`, { method: 'POST', headers: { 'content-type': 'application/csp-report' }, body: JSON.stringify({ 'csp-report': { x: 'y'.repeat(20000) } }) })).status, 413);
  // Rate limit: a flood is accepted (204) but only the first ~20 are stored.
  for (let i = 0; i < 40; i++) await fetch(`${BASE}/v1/csp-report`, { method: 'POST', headers: { 'content-type': 'application/csp-report' }, body: JSON.stringify(rep) });
  const stored = events('csp_report').length - before0;
  assert.ok(stored >= 2 && stored <= 22, `stored ${stored} of 42 reports`);
});

test('CORS: foreign preflight 403, allowlisted origin 204 with credentials and explicit headers, foreign writes refused', async () => {
  const pre = (origin, p = '/v1/log_in') => fetch(BASE + p, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-csrf-token,x-client-token' } });
  const bad = await pre('https://evil.example');
  assert.equal(bad.status, 403);
  assert.equal((await bad.json()).error.code, 'origin_not_allowed');
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
  assert.match(bad.headers.get('vary'), /Origin/);

  const ok = await pre(PARTNER);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), PARTNER);
  assert.equal(ok.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(ok.headers.get('access-control-allow-headers'), 'Content-Type, X-Csrf-Token, Idempotency-Key, X-Client-Token');
  assert.match(ok.headers.get('access-control-allow-methods'), /POST/);
  assert.match(ok.headers.get('vary'), /Origin/);
  // The server's own origin is always allowed.
  assert.equal((await pre(BASE)).status, 204);

  const get = await fetch(`${BASE}/trade-api/v2/exchange/status`, { headers: { origin: PARTNER } });
  assert.equal(get.headers.get('access-control-allow-origin'), PARTNER);
  assert.equal(get.headers.get('access-control-expose-headers'), 'X-Csrf-Token, Etag');
  assert.equal((await fetch(`${BASE}/trade-api/v2/exchange/status`, { headers: { origin: 'https://evil.example' } })).headers.get('access-control-allow-origin'), null);

  const n = events('cors_rejected').length;
  const post = await fetch(`${BASE}/v1/log_in`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(post.status, 403);
  assert.equal((await post.json()).error.code, 'origin_not_allowed');
  assert.ok(events('cors_rejected').length > n, 'logged');
});

test('bot challenge: curl-like requests get the 429 proof-of-work page; Chromium loads normally and solves a forced challenge', async () => {
  const before0 = events('challenge_served').length;
  for (const [ua, p] of [['curl/8.5.0', '/'], ['python-requests/2.32', EVENT_URL], ['', '/portfolio'], ['GPTBot/1.2', '/browse']]) {
    const r = await fetch(BASE + p, { headers: { 'user-agent': ua } });
    assert.equal(r.status, 429, `${ua || 'no UA'} ${p}`);
    assert.equal(r.headers.get('cache-control'), 'private, no-store');
    assert.equal(r.headers.get('x-plx-mitigated'), 'challenge');
    const html = await r.text();
    assert.match(html, /id="plx-challenge"/);
    assert.ok(!html.includes('plx-boot') && !html.includes('/assets/main-'), 'the app is not served to a challenged client');
    const n = nonceOf(cspOf(r));
    assert.ok(html.includes(`<script nonce="${n}">`), 'challenge script runs under the page nonce');
  }
  assert.equal(events('challenge_served').length - before0, 4);
  // A browser-like client is not challenged; robots.txt is never challenged and lists AI crawlers (advisory).
  assert.equal((await fetch(`${BASE}/`, { headers: BROWSER })).status, 200);
  const robots = await fetch(`${BASE}/robots.txt`, { headers: { 'user-agent': 'curl/8.5.0' } });
  assert.equal(robots.status, 200);
  const rt = await robots.text();
  assert.match(rt, /Advisory only/);
  for (const bot of ['GPTBot', 'ClaudeBot', 'CCBot', 'Google-Extended', 'PerplexityBot']) assert.match(rt, new RegExp(`User-agent: ${bot}\\n`));
  assert.match(rt, /User-agent: \*\nDisallow: \/v1\//);

  // Wrong proof of work, then a correct one, then a replay of the same challenge.
  const r = await fetch(`${BASE}/`, { headers: { 'user-agent': 'curl/8.5.0' } });
  const cfg = JSON.parse(/id="plx-challenge">([^<]+)</.exec(await r.text())[1]);
  const verify = (nonce, ua = 'curl/8.5.0') => fetch(`${BASE}${cfg.v}`, { method: 'POST', headers: { 'user-agent': ua, 'content-type': 'application/json' }, body: JSON.stringify({ token: cfg.t, nonce }) });
  const good = solvePow(cfg.id, cfg.d);
  let wrong = 0; while (String(wrong) === good) wrong++;
  const w = await verify(String(wrong));
  assert.equal(w.status, 403); assert.equal((await w.json()).error.code, 'challenge_failed');
  assert.equal((await verify(good, 'other-agent/1')).status, 403, 'bound to IP + User-Agent');
  const v = await verify(good);
  assert.equal(v.status, 200);
  const pass = v.headers.getSetCookie().find((c) => c.startsWith('plx_chk='));
  assert.match(pass, /HttpOnly; SameSite=Lax; Max-Age=1800/);
  assert.equal((await verify(good)).status, 403, 'single use');
  assert.ok(events('challenge_failed').some((e) => JSON.parse(e.detail).reason === 'replayed'));
  // With the pass cookie, the same curl client now gets the app.
  assert.equal((await fetch(`${BASE}/`, { headers: { 'user-agent': 'curl/8.5.0', cookie: pass.split(';')[0] } })).status, 200);
  // The shared Node helper earns a token the same way.
  const t = await fetchClientToken(BASE);
  assert.ok(t.challenged && t.token);

  // Real Chromium is not challenged in the default mode.
  const page = await newPage();
  const resp = await page.goto(`${BASE}/`);
  assert.equal(resp.status(), 200);
  await page.context().close();

  // Forced challenge (attack mode: every HTML request): Chromium solves it transparently and lands in the app.
  const P2 = await freePort();
  const forced = await start({ port: P2, dbFile: path.join(TMP, 'forced.db'), quiet: true, assets: 'dist', security: { challengeMode: 'all' } });
  try {
    const fp = await newPage();
    const first = await fp.goto(`http://127.0.0.1:${P2}${EVENT_URL}`);
    assert.equal(first.status(), 429);
    await fp.waitForSelector('[data-testid=event-title]', { timeout: 20000 });
    assert.ok((await fp.context().cookies()).some((c) => c.name === 'plx_chk' && c.httpOnly));
    // Within the pass lifetime the next navigation is not challenged.
    assert.equal((await fp.goto(`http://127.0.0.1:${P2}/browse`)).status(), 200);
    await fp.waitForSelector('[data-testid=event-card]');
    assert.deepEqual(await violations(fp), [], 'challenge page and app run under the CSP');
    assert.deepEqual(fp.errors, []);
    await fp.context().close();
    const d = new DatabaseSync(path.join(TMP, 'forced.db'));
    try {
      const kinds = d.prepare('SELECT kind, COUNT(*) c FROM security_events GROUP BY kind').all().reduce((a, x) => ({ ...a, [x.kind]: x.c }), {});
      assert.ok(kinds.challenge_served >= 1 && kinds.challenge_passed >= 1, JSON.stringify(kinds));
    } finally { d.close(); }
  } finally { await forced.close(); }
});

test('client token: required on writes, /v1/users/* reads and the WebSocket (missing / forged / expired / foreign-bound → 403); public reads stay open', async () => {
  const P3 = await freePort();
  const short = await start({ port: P3, dbFile: path.join(TMP, 'short.db'), quiet: true, assets: 'dist', security: { bot: { client_token_ttl_seconds: 2 } } });
  const B2 = `http://127.0.0.1:${P3}`;
  try {
    const write = (headers = {}) => fetch(`${B2}/v1/users/u_x/deposits`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"amount_dollars":1}' });
    const missing = await write();
    assert.equal(missing.status, 403);
    assert.equal((await missing.json()).error.code, 'client_token_required');
    const { token } = await fetchClientToken(B2);
    const ok = await write({ 'x-client-token': token });
    assert.equal(ok.status, 401, 'a valid token passes the perimeter (then the route says: not signed in)');
    // The HAR4 split: public unauthenticated reads need no token; /v1/users/* reads do.
    for (const p of ['/v1/live_data/count', '/v1/session', '/v1/bff/home', '/v1/social/posts', '/trade-api/v2/exchange/status', `/trade-api/v2/markets/${RAV}/orderbook`]) assert.equal((await fetch(B2 + p)).status, 200, `${p} is public`);
    const read = await fetch(`${B2}/v1/users/u_x/balance`);
    assert.equal(read.status, 403);
    assert.equal((await read.json()).error.code, 'client_token_required');
    assert.equal((await fetch(`${B2}/v1/users/u_x/balance`, { headers: { 'x-client-token': token } })).status, 401, 'with a token the read reaches the route');
    const [p, s] = token.split('.');
    const forged = `${p}.${s.slice(0, -2)}${s.endsWith('AA') ? 'BB' : 'AA'}`;
    assert.equal((await (await write({ 'x-client-token': forged })).json()).error.code, 'client_token_invalid');
    const tampered = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), e: Date.now() + 9e9 })).toString('base64url')}.${s}`;
    assert.equal((await write({ 'x-client-token': tampered })).status, 403, 'payload is signed');
    assert.equal((await write({ 'x-client-token': token, 'user-agent': 'another-agent/1.0' })).status, 403, 'bound to IP + User-Agent');

    // WebSocket: no token / forged → refused; valid → open; foreign Origin → refused.
    const ws = (q, headers = { 'user-agent': 'node' }) => new Promise((res) => {
      const w = new WebSocket(`ws://127.0.0.1:${P3}/v1/ws${q}`, { headers });
      w.on('open', () => { w.close(); res('open'); });
      w.on('unexpected-response', (req, r) => res(r.statusCode));
      w.on('error', () => res('error'));
    });
    assert.equal(await ws(''), 403);
    assert.equal(await ws(`?ct=${encodeURIComponent(forged)}`), 403);
    assert.equal(await ws(`?ct=${encodeURIComponent(token)}`), 'open');
    assert.equal(await ws(`?ct=${encodeURIComponent(token)}`, { 'user-agent': 'node', origin: 'https://evil.example' }), 403);

    // Expired (2 s lifetime): writes and the upgrade are refused; an expired token can still be traded for a new one.
    await sleep(2300);
    assert.equal((await (await write({ 'x-client-token': token })).json()).error.code, 'client_token_invalid');
    assert.equal(await ws(`?ct=${encodeURIComponent(token)}`), 403);
    const refresh = await fetch(`${B2}/v1/client_token`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-client-token': token }, body: '{}' });
    assert.equal(refresh.status, 200);
    const fresh = (await refresh.json()).token;
    assert.equal((await write({ 'x-client-token': fresh })).status, 401);
    // Bootstrap without a boot proof, token or challenge pass is refused.
    const none = await fetch(`${B2}/v1/client_token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"boot":"x.y"}' });
    assert.equal(none.status, 403);
    assert.equal((await none.json()).error.code, 'client_token_bootstrap_failed');

    const d = new DatabaseSync(path.join(TMP, 'short.db'));
    try {
      const kinds = d.prepare('SELECT kind, COUNT(*) c FROM security_events GROUP BY kind').all().reduce((a, x) => ({ ...a, [x.kind]: x.c }), {});
      assert.ok(kinds.client_token_rejected >= 5 && kinds.ws_rejected >= 4, JSON.stringify(kinds));
    } finally { d.close(); }
  } finally { await short.close(); }

  // A signed-in session does not replace the token on /v1/users/* reads.
  const c = apiClient();
  assert.equal((await c.login({ email: 'maple_quant@parlance.local', password: DEMO_PW })).status, 200);
  assert.equal((await c.call('GET', `/v1/users/${c.uid}/balance`)).status, 200);
  const noTok = await c.call('GET', `/v1/users/${c.uid}/balance`, undefined, { 'x-client-token': '' });
  assert.equal(noTok.status, 403);
  assert.equal(noTok.body.error.code, 'client_token_required');
  assert.equal((await c.call('GET', '/v1/session', undefined, { 'x-client-token': '' })).status, 200, 'public read');

  // In the browser the token is fetched after load and sent as X-Client-Token on every /v1 call (reads too, as in HAR4)
  // and as ?ct= on the socket; /trade-api/v2 public market data is fetched without it.
  const page = await newPage();
  const sent = []; const v1Reads = []; const v2 = [];
  page.on('request', (r) => {
    const u = r.url(); const h = r.headers()['x-client-token'];
    if (u.startsWith(`${BASE}/v1/`) && !u.includes('/v1/client_token')) (r.method() === 'GET' ? v1Reads : sent).push([u, h]);
    if (u.startsWith(`${BASE}/trade-api/`)) v2.push([u, h]);
  });
  const wsUrls = []; page.on('websocket', (w) => wsUrls.push(w.url()));
  await logIn(page, { email: 'harborwatch@parlance.local', password: DEMO_PW });
  await page.waitForFunction(() => document.getElementById('conn-banner').hidden);
  const login = sent.find(([u]) => u.endsWith('/v1/log_in'));
  assert.ok(login && login[1], 'log_in carries X-Client-Token');
  await page.goto(`${BASE}${EVENT_URL}`);
  await page.waitForSelector('[data-testid=event-title]');
  await page.waitForTimeout(500);
  assert.ok(v1Reads.length >= 5 && v1Reads.every(([, h]) => h), `every /v1 read carries the token: ${v1Reads.filter(([, h]) => !h).map(([u]) => u)}`);
  assert.ok(v1Reads.some(([u]) => u.includes('/v1/users/')), 'including /v1/users/* reads');
  assert.ok(v2.length >= 1, 'the event page reads /trade-api/v2');
  assert.ok(wsUrls.length && wsUrls.every((u) => /[?&]ct=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(u)), `WS URL carries ct: ${wsUrls}`);
  const cookie = (await page.context().cookies()).find((c) => c.name === 'plx_ct');
  assert.ok(cookie && cookie.httpOnly && cookie.sameSite === 'Strict', 'HttpOnly SameSite=Strict cookie copy');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('honeypot paths answer 404 (never the SPA) and are logged; sources and .map files are not served', async () => {
  const before0 = events('honeypot').length;
  const probes = ['/.env', '/.env.production', '/.git/config', '/.git/HEAD', '/wp-admin/', '/wp-login.php', '/server/app.js', '/data/parlance.db', '/node_modules/express/package.json', '/backup.sqlite', '/x.db', '/assets/main.js.map', '/js/main.js.map', '/%2e%65nv', '/package.json'];
  for (const p of probes) {
    const r = await fetch(BASE + p, { headers: BROWSER });
    assert.equal(r.status, 404, p);
    assert.match(r.headers.get('content-type'), /text\/plain/, p);
    const t = await r.text();
    assert.ok(!t.includes('<html') && !t.includes('plx-boot'), `${p} never returns the SPA`);
  }
  const hits = events('honeypot').slice(before0);
  assert.equal(hits.length, probes.length);
  assert.deepEqual(hits.map((h) => h.path), probes);
  assert.ok(hits.every((h) => h.ip && h.ua === BROWSER['user-agent']));
  // Production mode serves only the hashed bundle: no module sources, no per-file CSS, no maps; unknown extensions 404.
  for (const p of ['/js/main.js', '/js/api.js', '/app.css', '/index.html', '/manifest.json', '/assets/manifest.json', '/foo.png', '/markets/x/y/z.json']) assert.equal((await fetch(BASE + p, { headers: BROWSER })).status, 404, p);
  assert.equal((await fetch(`${BASE}/markets/x/y/z`, { headers: BROWSER })).status, 200, 'extension-less app route gets the SPA');
  assert.equal((await fetch(`${BASE}/fonts/OFL-Inter.txt`)).status, 200, 'font licence is published');
  const files = fs.readdirSync(path.join(DIST, 'assets'));
  assert.ok(!files.some((f) => f.endsWith('.map')), 'no source maps built');
  for (const f of files.filter((x) => /\.(js|css)$/.test(x))) assert.ok(!fs.readFileSync(path.join(DIST, 'assets', f), 'utf8').includes('sourceMappingURL'), f);
});

test('hashed, minified assets are immutable and referenced by the page; the build is fresh', async () => {
  const html = await (await fetch(`${BASE}/`, { headers: BROWSER })).text();
  const css = /href="(\/assets\/app-[A-Z0-9]{8}\.css)"/.exec(html)[1];
  const js = /src="(\/assets\/main-[A-Z0-9]{8}\.js)"/.exec(html)[1];
  // dist/manifest.json records the source hash it was built from (start() rebuilds when it differs) and the entries served.
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
  assert.equal(`/assets/${manifest.entry.js}`, js);
  assert.equal(`/assets/${manifest.entry.css}`, css);
  assert.match(manifest.source_hash, /^[0-9a-f]{64}$/);
  assert.match(sourceHash(), /^[0-9a-f]{64}$/);
  assert.ok(manifest.files.every((x) => /^assets\/[A-Za-z0-9-]+-[A-Z0-9]{8}\.(js|css|woff2)$/.test(x)), 'every built file is content-hashed');
  assert.equal((html.match(/rel="stylesheet"/g) || []).length, 1, 'one bundled stylesheet');
  for (const [p, type] of [[css, /text\/css/], [js, /javascript/]]) {
    const r = await fetch(BASE + p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), type);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable', p);
    const body = await r.text();
    assert.ok(!body.includes('App shell: router') && !body.includes('Parlance design tokens'), `${p} is minified (no source comments)`);
  }
  const cssBody = await (await fetch(BASE + css)).text();
  const font = /url\("?\.?\/?([a-z0-9-]+-[A-Z0-9]{8}\.woff2)"?\)/.exec(cssBody)[1];
  const f = await fetch(`${BASE}/assets/${font}`);
  assert.equal(f.status, 200);
  assert.equal(f.headers.get('content-type'), 'font/woff2');
  assert.equal(f.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.ok(!cssBody.includes('fonts.googleapis') && !html.includes('fonts.googleapis'));
});

test('rate-limit tiers: anonymous per IP vs signed-in per account, the stricter auth bucket, persisted across restart', async () => {
  const P = await freePort(); const B3 = `http://127.0.0.1:${P}`; const DB3 = path.join(TMP, 'rl.db');
  const opts = { port: P, dbFile: DB3, quiet: true, demoPassword: DEMO_PW, rate: { burst: 12, perSec: 0.01 }, security: { authRate: { burst: 5, per_second: 0.01 } } };
  let s = await start(opts);
  const tokens = clientTokens(B3);
  const tiers = () => { const d = new DatabaseSync(DB3); try { return d.prepare("SELECT detail FROM security_events WHERE kind='rate_limited'").all().map((r) => JSON.parse(r.detail).tier); } finally { d.close(); } };
  try {
    await tokens(); // bootstrap (anonymous bucket)
    const c = apiClient(B3, tokens);
    assert.equal((await c.login({ email: 'rainmaker@parlance.local', password: DEMO_PW })).status, 200);
    // Credential endpoint bucket (5 per IP; challenge verify, /v1/auth/csrf and /v1/log_in all count): 4 used so far,
    // one bad login still reaches the route (401), the next is refused by the auth tier (429).
    const bad = apiClient(B3, tokens);
    await bad.call('GET', '/v1/auth/csrf');
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await bad.call('POST', '/v1/log_in', { email: 'rainmaker@parlance.local', password: 'wrong-password-123' })).status);
    assert.equal(codes.at(-1), 429, `auth bucket: ${codes}`);
    assert.ok(tiers().includes('auth'));

    // Signed-in tier: 24 per account (2x anonymous) even though the IP's anonymous bucket is nearly empty.
    const seen = [];
    for (let i = 0; i < 26; i++) seen.push((await c.call('GET', '/v1/session')).status);
    const okCount = seen.filter((x) => x === 200).length;
    assert.ok(okCount >= 20 && okCount <= 24 && seen.at(-1) === 429, `user tier: ${seen}`);
    assert.ok(tiers().includes('user'));
    // Anonymous tier (12 per IP): already mostly spent by the anonymous calls above.
    const anon = [];
    for (let i = 0; i < 12; i++) anon.push((await fetch(`${B3}/trade-api/v2/exchange/status`)).status);
    assert.ok(anon.includes(429) && anon.filter((x) => x === 200).length < 12, `anonymous tier: ${anon}`);
    const limited = await fetch(`${B3}/trade-api/v2/exchange/status`);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    assert.deepEqual(await limited.json(), { error: { code: 'too_many_requests', message: 'too many requests' } });
    assert.ok(tiers().includes('anonymous'));

    // Buckets are persisted: a restart does not hand out a fresh allowance.
    await s.close();
    s = await start(opts);
    const once = async (fn) => { try { return await fn(); } catch { await sleep(200); return fn(); } }; // a pooled keep-alive socket to the old server may be stale
    assert.equal((await once(() => c.call('GET', '/v1/session'))).status, 429, 'user bucket still empty after restart');
    assert.equal((await fetch(`${B3}/trade-api/v2/exchange/status`)).status, 429, 'anonymous bucket still empty after restart');
    const rows = (() => { const d = new DatabaseSync(DB3); try { return d.prepare('SELECT key FROM rate_buckets').all().map((r) => r.key); } finally { d.close(); } })();
    assert.ok(rows.some((k) => k.startsWith('user:')) && rows.some((k) => k.startsWith('anonymous:')) && rows.some((k) => k.startsWith('auth:')), rows.join(','));
  } finally { await s.close(); }
});

test('Admin › Settings: taker fee, rolling window, rate limits and bot settings change live, are audited and apply to the next trade; Admin › Security lists events', async () => {
  const page = await newPage();
  await logIn(page, ADMIN);
  await page.goto(`${BASE}/admin/settings`);
  const form = page.locator('[data-testid=perimeter-form]');
  await form.waitFor();
  assert.equal(await form.locator('[name=taker_fee_coefficient]').inputValue(), '0.07');
  await form.locator('[name=taker_fee_coefficient]').fill('0.035');
  await form.locator('[name=rolling_window_seconds]').fill('600');
  await form.locator('[name=rl_user_burst]').fill('700');
  await form.locator('[name=pow_difficulty]').fill('12');
  await form.locator('button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=taker-fee-coefficient]').textContent === '0.035');
  // Validation is per field.
  await form.locator('[name=taker_fee_coefficient]').fill('0.9');
  await form.locator('button[type=submit]').click();
  await page.locator('#e-per-taker_fee_coefficient').filter({ hasText: /between 0 and 0.25/ }).waitFor();
  assert.deepEqual(await violations(page), []);

  const settings = Object.fromEntries(dbq("SELECT key, value FROM admin_settings WHERE key IN ('taker_fee','rolling_window','security.rate_limits','security.bot')").map((r) => [r.key, JSON.parse(r.value)]));
  assert.equal(settings.taker_fee.coefficient, 0.035);
  assert.equal(settings.rolling_window.seconds, 600);
  assert.equal(settings['security.rate_limits'].user.burst, 700);
  assert.equal(settings['security.bot'].pow_difficulty, 12);
  const audit = dbq("SELECT * FROM admin_audit WHERE action='settings.update' ORDER BY ts DESC LIMIT 1")[0];
  assert.equal(audit.actor_email, ADMIN.email);
  assert.equal(JSON.parse(audit.before_json).taker_fee.coefficient, 0.07);
  assert.equal(JSON.parse(audit.after_json).taker_fee.coefficient, 0.035);
  assert.equal(JSON.parse(audit.after_json).rolling_window_seconds, 600);
  assert.equal(JSON.parse(audit.after_json).rate_limits.user.burst, 700);

  // The next trade pays the new coefficient: 10 contracts bought at P → fee = ceil(0.035 × 10 × P × (1 − P)).
  const t = apiClient();
  const u = { email: `fee.${Date.now()}@example.test`, password: 'Perimeter-Trader-2026!', name: 'Fee Tester' }; // secret-scan:allow test-only fixture password
  assert.equal((await t.signup(u)).status, 201);
  assert.equal((await t.call('POST', `/v1/users/${t.uid}/deposits`, { amount_dollars: 100 })).status, 201);
  const o = await t.call('POST', `/v1/users/${t.uid}/orders`, { ticker: RAV, side: 'yes', type: 'market', count: 10 });
  assert.equal(o.status, 201, JSON.stringify(o.body));
  const fills = dbq('SELECT price_cents p, count, fee_cents FROM fills WHERE user_id=? AND is_taker=1', t.uid);
  assert.ok(fills.length >= 1);
  for (const f of fills) assert.equal(f.fee_cents, Math.ceil((350 * f.count * f.p * (100 - f.p)) / 1e8), `fee at 0.035 for ${f.count} units @ ${f.p}`);
  const paid = fills.reduce((a, f) => a + f.fee_cents, 0);
  assert.ok(paid < fills.reduce((a, f) => a + Math.ceil((700 * f.count * f.p * (100 - f.p)) / 1e8), 0), `less than the old 0.07 fee (${paid}¢)`);

  // Admin › Security shows the perimeter events recorded by the earlier tests.
  await page.goto(`${BASE}/admin/security`);
  await page.locator('[data-testid=security-events] tbody tr').first().waitFor();
  assert.ok(Number(await page.locator('[data-testid=count-honeypot]').textContent()) >= 15);
  await page.selectOption('[data-testid=security-filters] select[name=kind]', 'honeypot');
  await page.click('[data-testid=security-filters] button[type=submit]');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=security-events] tbody tr')].every((r) => r.dataset.kind === 'honeypot'));
  assert.match(await page.locator('[data-testid=security-events]').textContent(), /\/\.git\/config/);
  assert.deepEqual(await violations(page), []);
  assert.deepEqual(page.errors, []);
  // The Security view needs audit.read: a plain user is refused by the API.
  assert.equal((await t.call('GET', '/v1/admin/security/events')).status, 403);
  await page.context().close();
});

test('persistence across restart: settings, fee, events, used challenges and the signing secret survive', async () => {
  const counts = dbq('SELECT kind, COUNT(*) c FROM security_events GROUP BY kind');
  const used = dbq('SELECT COUNT(*) c FROM security_challenges_used')[0].c;
  assert.ok(used >= 1);
  const token = await ct(); // issued before the restart
  await srv.close();
  srv = await start(opts());
  assert.deepEqual(dbq('SELECT kind, COUNT(*) c FROM security_events GROUP BY kind'), counts, 'event log persisted');
  assert.equal(dbq('SELECT COUNT(*) c FROM security_challenges_used')[0].c, used);
  // The persisted secret (0600, next to the database) keeps earlier tokens valid.
  const key = path.join(TMP, 'secret.key');
  if (process.platform !== 'win32') assert.equal(fs.statSync(key).mode & 0o777, 0o600);
  const w = await fetch(`${BASE}/v1/users/u_x/deposits`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-client-token': token }, body: '{"amount_dollars":1}' });
  assert.equal(w.status, 401, 'token from before the restart still passes the perimeter');
  // Settings survived and are live again: the fee and the rolling window are applied at boot.
  const a = apiClient();
  assert.equal((await a.login(ADMIN)).status, 200);
  const s = (await a.call('GET', '/v1/admin/settings')).body.settings;
  assert.equal(s.taker_fee.coefficient, 0.035);
  assert.equal(s.rolling_window_seconds, 600);
  assert.equal(s.rate_limits.user.burst, 700);
  assert.equal(s.bot.pow_difficulty, 12);
  // Put the defaults back through the same audited endpoint.
  const r = await a.call('PUT', '/v1/admin/settings', { taker_fee_coefficient: 0.07, rolling_window_seconds: 900 });
  assert.equal(r.status, 200);
  assert.equal(r.body.settings.taker_fee.coefficient, 0.07);
  const bad = await a.call('PUT', '/v1/admin/settings', { rate_limits: { user: { burst: 0 } }, bot: { challenge_mode: 'sometimes' } });
  assert.equal(bad.status, 400);
  assert.ok(JSON.stringify(bad.body).includes('rate_limits.user.burst') && JSON.stringify(bad.body).includes('bot.challenge_mode'));
});
