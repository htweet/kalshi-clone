'use strict';
// End-to-end tests for Phase 8 reach (CLONE_SPEC.md §38.4–§38.8, PLAN P8.3, P8.4, P8.6, P8.7), real server + SQLite +
// Chromium:
//   • server-rendered public pages: metadata (title, description, canonical, hreflang, Open Graph, X card, JSON-LD), the
//     content in <main> until the SPA takes over, `noindex` on private routes, share-card PNGs, sitemaps with lastmod,
//     robots.txt; crawlers through the browser check (search and link-preview yes, AI no); cache poisoning (a session, a
//     forged Host, X-Forwarded-Host, query strings, cookies and hostile paths never change what others are served);
//   • languages: every non-English language off and unreviewed by default with flagged samples; switching on refused until
//     reviewed and covered; import for translators; the footer switcher and Settings; fallback to English; an RTL
//     language added as data; translated templates; the sanitizer on translations;
//   • data saver: the admin default live, the member setting, lighter pages, the polling fallback on an unstable socket;
//   • SMS notifications through the simulated adapter: off by default, opt-in with a verified phone and consent, the
//     daily cap, opt-out always;
//   • footer and help centre: Product / Company / Help columns, social links, Nigerian support hours, 24 px targets;
//   • persistence across a restart.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const { Client, UA } = require('./lib/client');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-reach-'));
const DB_FILE = path.join(TMP, 'reach.db');
const PW = 'Sahel-Lantern-Cowrie-3917';
const stamp = Date.now();
const ADMIN = { email: `root.${stamp}@example.test`, password: PW };
const HIGH = { burst: 1e6, per_second: 1e6 };
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const opts = (port, extra = {}) => ({ port, dbFile: DB_FILE, tickMs: 250, quiet: true, admin: ADMIN, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH }, elections: { seed: true }, ...extra });
let BASE; let PORT; let srv; let browser; let admin;
const allPages = [];
const email = (n) => `${n}.${stamp}@example.test`;
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const q1 = (sql, ...a) => dbq(sql, ...a)[0];
const dbrun = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(fn, { timeout = 15000, interval = 150 } = {}) {
  const end = Date.now() + timeout;
  for (;;) { try { const v = await fn(); if (v !== false && v !== undefined && v !== null) return v; } catch (e) { if (Date.now() > end) throw e; } if (Date.now() > end) throw new Error('eventually: condition not met'); await sleep(interval); }
}
async function newPage(viewport = { width: 1280, height: 900 }, ctxOpts = {}) {
  const ctx = await browser.newContext({ viewport, ...ctxOpts });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  allPages.push(page);
  return page;
}
async function uiLogIn(page, u) {
  await page.goto(BASE + '/sign-in');
  await page.fill('input[name=email]', u.email);
  await page.fill('input[name=password]', u.password || PW);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
}
const stepUp = (c) => async (method, p, body) => {
  let r = await c.call(method, p, body);
  if (r.code === 'step_up_required') { assert.equal((await c.call('POST', '/v1/step_up', { password: PW })).status, 200); r = await c.call(method, p, body); }
  return r;
};
const adminCall = (...a) => stepUp(admin)(...a);
const setFlag = async (key, enabled) => { const r = await adminCall('PUT', `/v1/admin/flags/${key}`, { enabled, reason: 'reach e2e' }); assert.equal(r.status, 200, r.text); };
const setOwner = async (key, value) => { const r = await adminCall('PUT', `/v1/admin/owner_settings/${key}`, { value, reason: 'reach e2e owner setting' }); assert.equal(r.status, 200, r.text); };
const html = (p, headers = {}) => fetch(BASE + p, { headers: { 'user-agent': UA, accept: 'text/html', 'accept-language': 'en-NG', ...headers }, redirect: 'manual' }).then(async (r) => ({ status: r.status, headers: r.headers, text: await r.text() }));
const meta = (h, attr, name) => { const m = new RegExp(`<meta ${attr}="${name.replace(/[:.]/g, (c) => `\\${c}`)}" content="([^"]*)">`).exec(h); return m ? m[1] : null; };
const link = (h, rel, extra = '') => { const m = new RegExp(`<link rel="${rel}"${extra} href="([^"]*)">`).exec(h); return m ? m[1] : null; };
// A raw request with arbitrary headers (fetch refuses to set Host).
const raw = (p, headers) => new Promise((res, rej) => { const r = http.request({ host: '127.0.0.1', port: PORT, path: p, headers: { 'user-agent': UA, accept: 'text/html', ...headers } }, (x) => { let b = ''; x.setEncoding('utf8'); x.on('data', (c) => { b += c; }); x.on('end', () => res({ status: x.statusCode, headers: x.headers, text: b })); }); r.on('error', rej); r.end(); });
const pngSize = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)];
const overflow = (page) => page.evaluate((w) => Math.max(document.documentElement.scrollWidth, window.innerWidth) - w, page.viewportSize().width);
let EV;

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  srv = await start(opts(PORT));
  browser = await chromium.launch();
  admin = await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password);
  EV = q1("SELECT e.ticker, e.title, e.series_ticker, s.slug FROM events e JOIN series s ON s.ticker=e.series_ticker WHERE e.series_ticker NOT IN ('PLXCOMBO') AND e.series_ticker NOT LIKE 'PLXFLASH%' AND EXISTS (SELECT 1 FROM markets m WHERE m.event_ticker=e.ticker AND m.status='active') ORDER BY e.rowid LIMIT 1");
  EV.url = `/markets/${EV.series_ticker.toLowerCase()}/${EV.slug}/${EV.ticker.toLowerCase()}`;
  // These tests read the server-rendered body as a plain visitor, so the owner switch `ssr.visitors` (off by default,
  // owner decision 2026-11-09) is turned on here; the default (visitors get no body, crawlers do) has its own test.
  await setFlag('ssr.visitors', true);
});
after(async () => {
  try { await browser?.close(); } catch { /* ignore */ }
  try { await srv?.close(); } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('server-rendered public pages: metadata, canonical, hreflang, Open Graph / X cards with PNG images, JSON-LD, content until the SPA takes over; noindex on private pages; sitemaps and robots.txt', async () => {
  const home = await html('/');
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('cache-control'), 'no-store', 'the page itself is never cached (per-response CSP nonce)');
  assert.match(home.text, /<title>Parlance · Trade on what happens next in Nigeria<\/title>/);
  assert.equal(link(home.text, 'canonical'), `${BASE}/`);
  assert.equal(link(home.text, 'alternate', ' hreflang="x-default"'), `${BASE}/`);
  assert.equal(link(home.text, 'alternate', ' hreflang="en-NG"'), `${BASE}/`);
  assert.equal(meta(home.text, 'property', 'og:image'), `${BASE}/og/site.png`);
  assert.equal(meta(home.text, 'name', 'twitter:card'), 'summary_large_image');
  const ld = [...home.text.matchAll(/<script type="application\/ld\+json" nonce="[^"]+">([^<]*)<\/script>/g)].map((m) => JSON.parse(m[1]));
  assert.deepEqual(ld.map((x) => x['@type']).sort(), ['Organization', 'WebSite']);
  assert.match(home.text, /<main id="view" tabindex="-1" data-ssr="1"><div class="ssr" data-testid="ssr">/);
  assert.match(home.text, /<html lang="en-NG" dir="ltr">/);
  // An event page: its own title, description with the leading chance, a share card of the event, a breadcrumb.
  const ev = await html(EV.url);
  assert.ok(ev.text.includes(`<title>${EV.title} · Parlance Exchange</title>`), 'event title');
  assert.match(meta(ev.text, 'name', 'description'), /% chance\. Trade yes or no on Parlance\./);
  assert.equal(meta(ev.text, 'property', 'og:image'), `${BASE}/og/event/${EV.ticker}.png`);
  assert.equal(meta(ev.text, 'property', 'og:type'), 'article');
  assert.ok(JSON.parse(/<script type="application\/ld\+json" nonce="[^"]+">([^<]*)<\/script>/.exec(ev.text)[1]).itemListElement.length === 2);
  const png = await fetch(`${BASE}/og/event/${EV.ticker}.png`);
  const buf = Buffer.from(await png.arrayBuffer());
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.deepEqual([...buf.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(pngSize(buf), [1200, 630]);
  assert.equal((await fetch(`${BASE}/og/event/NOPE-NOPE.png`)).status, 404);
  // The elections hub and a CMS help page are rendered too.
  const hub = await html('/category/elections/nigeria-2027');
  assert.match(hub.text, /<h1>Nigeria 2027[^<]*<\/h1>/);
  assert.equal(meta(hub.text, 'property', 'og:image'), `${BASE}/og/hub/nigeria-2027.png`);
  const faq = await html('/support/faq');
  assert.match(faq.text, /<title>FAQ · Parlance<\/title>/);
  assert.match(faq.text, /<article class="ssr-page"><h1>Frequently asked questions<\/h1>/);
  // Private routes: no content, no index.
  const pf = await html('/portfolio');
  assert.match(pf.text, /<meta name="robots" content="noindex">/);
  assert.ok(!pf.text.includes('data-ssr'));
  // In the browser the SPA takes over from the server-rendered content.
  const page = await newPage();
  await page.goto(BASE + EV.url);
  await page.waitForSelector('[data-testid=event-title]');
  assert.equal(await page.locator('[data-testid=ssr]').count(), 0);
  // Sitemaps: an index of four sections, each with absolute URLs and a lastmod date; robots.txt names the index.
  const idx = await (await fetch(`${BASE}/sitemap.xml`)).text();
  const sections = [...idx.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(sections, ['pages', 'categories', 'markets', 'hubs'].map((s) => `${BASE}/sitemaps/${s}.xml`));
  const markets = await (await fetch(`${BASE}/sitemaps/markets.xml`)).text();
  assert.ok(markets.includes(`<loc>${BASE}${EV.url}</loc><lastmod>`));
  assert.ok([...markets.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].every((m) => /^\d{4}-\d{2}-\d{2}$/.test(m[1])));
  assert.ok((await (await fetch(`${BASE}/sitemaps/pages.xml`)).text()).includes(`<loc>${BASE}/support/faq</loc>`));
  assert.ok((await (await fetch(`${BASE}/sitemaps/hubs.xml`)).text()).includes(`<loc>${BASE}/category/elections/nigeria-2027</loc>`));
  const robots = await (await fetch(`${BASE}/robots.txt`)).text();
  assert.match(robots, new RegExp(`Sitemap: ${BASE}/sitemap.xml`));
  assert.match(robots, /User-agent: GPTBot\nUser-agent: ChatGPT-User/);
  // The ssr flag off: no rendering, no sitemaps, no Sitemap line; on again.
  await setFlag('ssr', false);
  assert.ok(!(await html('/')).text.includes('data-ssr'));
  assert.equal((await fetch(`${BASE}/sitemap.xml`)).status, 404);
  assert.ok(!(await (await fetch(`${BASE}/robots.txt`)).text()).includes('Sitemap:'));
  await setFlag('ssr', true);
  assert.deepEqual(page.errors, []);
});

// Owner decision 2026-11-09: visitors are not shown the server-rendered market list (it flashed before the app took over);
// search and link-preview crawlers still get it. The switch `ssr.visitors` (off by default) brings it back for visitors.
test('quick-loading page: off by default for visitors (head metadata only), always for crawlers; the switch in Admin › Feature flags turns it on live', async () => {
  const GOOGLE = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
  await setFlag('ssr.visitors', false);
  try {
    for (const p of ['/', '/browse', EV.url, '/category/elections/nigeria-2027', '/support/faq']) {
      const v = await html(p);
      assert.equal(v.status, 200, p);
      assert.ok(!v.text.includes('data-ssr'), `${p}: no server-rendered body for a visitor`);
      assert.ok(link(v.text, 'canonical') && meta(v.text, 'property', 'og:image'), `${p}: the head metadata stays (share cards, canonical)`);
      const c = await html(p, { 'user-agent': GOOGLE });
      assert.match(c.text, /<main id="view" tabindex="-1" data-ssr="1">/, `${p}: a crawler gets the body`);
    }
    // In the browser: the first document has an empty <main>; the app draws the home page, the market list never shows.
    const page = await newPage();
    const resp = await page.goto(BASE + '/');
    assert.ok(!(await resp.text()).includes('data-testid="ssr"'), 'the served document has no market list');
    await page.waitForSelector('main#view > *');
    assert.equal(await page.locator('[data-testid=ssr]').count(), 0);
    // The owner switch, from the admin UI: on, visitors get the body again.
    const ap = await newPage();
    await uiLogIn(ap, { email: ADMIN.email, password: ADMIN.password });
    await ap.goto(BASE + '/admin/flags');
    const row = ap.locator('[data-flag-key="ssr.visitors"]');
    await row.waitFor();
    assert.ok((await row.textContent()).includes('Show the quick-loading page to visitors'));
    await ap.click('[data-flag-key="ssr.visitors"] [data-testid=flag-edit]');
    await ap.waitForSelector('[data-testid=flag-form]');
    await ap.setChecked('[data-testid=flag-form] [name=enabled]', true);
    await ap.fill('[data-testid=flag-form] [name=reason]', 'show the quick-loading page to visitors');
    await ap.click('[data-testid=flag-form] button[type=submit]');
    await ap.waitForSelector('[data-flag-key="ssr.visitors"] [data-testid=flag-state][data-on="1"]');
    await eventually(async () => /data-ssr="1"/.test((await html('/')).text));
    assert.deepEqual([...page.errors, ...ap.errors], []);
  } finally { await setFlag('ssr.visitors', true); }
});

test('cache poisoning: sessions, forged Host / X-Forwarded-Host, query strings, cookies and hostile paths never change what others are served', async () => {
  // A signed-in member's request is rendered from public data only: no name, email or balance, the same body as anyone's.
  const m = await new Client(BASE, 'member').signUp(email('member'), PW, 'Mariam Member');
  assert.equal((await m.call('POST', `/v1/users/${m.uid}/deposits`, { amount_dollars: 123.45 })).status, 201);
  const mine = await m.call('GET', '/browse', undefined, { accept: 'text/html' });
  const anon = await html('/browse');
  const ssrOf = (t) => /<main id="view"[^>]*>([\s\S]*?)<\/main>/.exec(t)[1];
  assert.equal(ssrOf(mine.text), ssrOf(anon.text));
  for (const secret of [email('member'), 'Mariam Member', '123.45', '12,345', m.uid]) assert.ok(!mine.text.includes(secret) && !anon.text.includes(secret), secret);
  // A forged Host cannot poison the cached page of the real origin; X-Forwarded-Host is ignored (no trusted proxy).
  const forged = await raw('/browse', { host: 'evil.example' });
  assert.ok(!forged.text.includes(`${BASE}/browse`));
  const xfh = await raw('/browse', { host: `127.0.0.1:${PORT}`, 'x-forwarded-host': 'evil.example' });
  assert.ok(!xfh.text.includes('evil.example'), 'X-Forwarded-Host is not used');
  const after = await html('/browse');
  assert.ok(!after.text.includes('evil.example'), 'the real origin never sees the forged host');
  assert.equal(link(after.text, 'canonical'), `${BASE}/browse`);
  // Query strings are neither reflected nor part of the canonical URL; ?lang of a language that is off is ignored.
  const q = await html('/browse?utm_source=%3Cscript%3Ealert(1)%3C%2Fscript%3E&lang=pcm&x=%22%3E%3Cimg');
  assert.ok(!/<script>alert|"><img/.test(q.text));
  assert.equal(link(q.text, 'canonical'), `${BASE}/browse`);
  assert.match(q.text, /<html lang="en-NG"/);
  // Cookies: a hostile locale cookie or an off language changes nothing.
  for (const c of ['plx_locale=pcm', 'plx_locale=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E', 'plx_session=forged; plx_ref=EVIL']) {
    const r = await html('/browse', { cookie: c });
    assert.match(r.text, /<html lang="en-NG" dir="ltr">/, c);
    assert.ok(!r.text.includes('alert(1)'), c);
    assert.equal(ssrOf(r.text), ssrOf(anon.text), c);
  }
  // Hostile and unknown paths are not rendered and not reflected.
  for (const p of ['/category/%3Cscript%3Ealert(1)%3C%2Fscript%3E', '/markets/x/y/%3Cimg%20src%3Dx%3E', '/category/elections/nope-nope']) {
    const r = await html(p);
    assert.ok(!r.text.includes('data-ssr'), p);
    assert.ok(!/<script>alert|<img src=x>/.test(r.text), p);
  }
  // The cache is shared by everyone (per path, language, currency, origin): a second anonymous request is a hit.
  const s0 = srv.app.locals.seo.stats.hits;
  await html('/browse');
  assert.ok(srv.app.locals.seo.stats.hits > s0);
});

test('crawlers: search and link-preview crawlers get public pages past the browser check, AI crawlers and private pages do not; the switch turns it off', async () => {
  // A second server with the browser check on for every HTML request.
  const port2 = await freePort();
  const srv2 = await start(opts(port2, { dbFile: path.join(TMP, 'crawl.db'), security: { challengeMode: 'all', authRate: HIGH, writeRate: HIGH } }));
  const get = (p, ua) => fetch(`http://127.0.0.1:${port2}${p}`, { headers: { 'user-agent': ua, accept: 'text/html' } }).then(async (r) => ({ status: r.status, text: await r.text() }));
  try {
    for (const ua of ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'WhatsApp/2.23.20.0 A', 'facebookexternalhit/1.1', 'Twitterbot/1.0', 'TelegramBot (like TwitterBot)']) {
      const r = await get('/', ua);
      assert.equal(r.status, 200, ua); assert.match(r.text, /data-ssr="1"/, ua);
    }
    for (const ua of ['Mozilla/5.0 (compatible; GPTBot/1.0)', 'ClaudeBot/1.0', 'CCBot/2.0']) assert.equal((await get('/', ua)).status, 429, ua);
    assert.equal((await get('/portfolio', 'Googlebot/2.1')).status, 429, 'private pages keep the check');
    assert.equal((await get('/', UA)).status, 429, 'a browser without a pass still gets the check (mode: all)');
  } finally { await srv2.close(); }
  // The switch off (a database where ssr.crawlers starts off): crawlers get the check like anyone.
  const port3 = await freePort();
  const srv3 = await start(opts(port3, { dbFile: path.join(TMP, 'crawl-off.db'), security: { challengeMode: 'all', authRate: HIGH, writeRate: HIGH }, flags: { defaults: { 'ssr.crawlers': false } } }));
  try {
    const r = await fetch(`http://127.0.0.1:${port3}/`, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)', accept: 'text/html' } });
    assert.equal(r.status, 429);
  } finally { await srv3.close(); }
});

test('languages: all non-English languages off and unreviewed with flagged samples; switching on needs review and coverage; import; the switcher; English fallback; an RTL language as data; translated templates; sanitizer', async () => {
  const pub = (await (await new Client(BASE, 'g').boot()).call('GET', '/v1/i18n/locales')).body;
  assert.deepEqual(pub.locales.map((l) => l.code), ['en-NG'], 'only English is on');
  const ap = await newPage();
  await uiLogIn(ap, ADMIN);
  dbrun('UPDATE sessions SET auth_at=0 WHERE user_id=(SELECT id FROM users WHERE email=?)', ADMIN.email);
  await ap.goto(BASE + '/admin/cms/languages');
  await ap.waitForSelector('[data-testid=lang-row][data-code=pcm]');
  const rows = await ap.$$eval('[data-testid=lang-row]', (els) => els.map((e) => [e.dataset.code, e.dataset.enabled, e.dataset.reviewed]));
  assert.deepEqual(rows, [['en-NG', '1', '1'], ['pcm', '0', '0'], ['ha', '0', '0'], ['yo', '0', '0'], ['ig', '0', '0']]);
  assert.match(await ap.textContent('[data-testid=lang-row][data-code=yo] [data-testid=lang-needs-review]'), /3 need review/);
  assert.equal(q1("SELECT COUNT(*) c FROM i18n_text_review WHERE status='needs_review'").c, 12, 'the seeded samples are flagged');
  // Switching Pidgin on: refused while not reviewed (the UI shows the reason).
  await ap.click('[data-testid=lang-row][data-code=pcm] [data-testid=lang-switch]');
  await ap.fill('[data-testid=confirm-reason]', 'try Pidgin');
  await ap.click('[data-testid=confirm-ok]');
  await ap.waitForSelector('.toast:has-text("Mark the language reviewed")');
  // Marked reviewed but under the minimum coverage (owner setting, 95 % by default): refused with the numbers.
  assert.equal((await adminCall('PUT', '/v1/admin/i18n/locales/pcm', { reviewed: true, reason: 'reviewed by our Pidgin translator' })).status, 200);
  let r = await adminCall('PUT', '/v1/admin/i18n/locales/pcm', { enabled: true, reason: 'go live' });
  assert.equal(r.code, 'locale_coverage'); assert.match(r.body.error.message, /at least 95% is needed/);
  // Translators' round trip: export, fill 120 texts (about 2 % of the catalog), dry run (nothing changes), apply (marked
  // needs review).
  const exp = (await admin.call('GET', '/v1/admin/i18n/locales/pcm/export')).body;
  assert.equal(exp.format, 'parlance-translations');
  const plain = exp.entries.filter((e) => !e.rich && !e.vars.length && e.translation == null).slice(0, 120);
  for (const e of plain) e.translation = `${e.english} (pcm)`;
  r = await admin.call('POST', '/v1/admin/i18n/locales/pcm/import', { data: exp, dry_run: true });
  assert.equal(r.status, 200, r.text); assert.equal(r.body.changes, 120);
  assert.equal(q1("SELECT COUNT(*) c FROM cms_entries WHERE locale='pcm' AND published_json IS NOT NULL").c, 3, 'a dry run changes nothing');
  const bad = JSON.parse(JSON.stringify(exp)); bad.entries.find((e) => e.key === plain[0].key).translation = '<script>alert(1)</script>';
  assert.equal((await admin.call('POST', '/v1/admin/i18n/locales/pcm/import', { data: bad, dry_run: true })).status, 400, 'markup in a plain text is refused');
  r = await adminCall('POST', '/v1/admin/i18n/locales/pcm/import', { data: exp, dry_run: false, reason: 'first batch from the translator' });
  assert.equal(r.status, 200, r.text);
  assert.equal(q1("SELECT COUNT(*) c FROM i18n_text_review WHERE locale='pcm' AND status='needs_review'").c, 123);
  // The sanitizer applies to translations in the editor too.
  assert.equal((await admin.call('PUT', '/v1/admin/cms/text/draft', { key: 'shell.html.nav_pro', value: '<img src=x onerror=alert(1)>', locale: 'pcm' })).status, 400);
  // With the minimum lowered to 1 % (owner setting, live), Pidgin can be switched on from the UI (step-up, audited).
  await setOwner('i18n.min_coverage_pct', 1);
  await ap.reload();
  await ap.waitForSelector('[data-testid=lang-row][data-code=pcm][data-reviewed="1"]');
  await ap.click('[data-testid=lang-row][data-code=pcm] [data-testid=lang-switch]');
  await ap.fill('[data-testid=confirm-reason]', 'Pidgin launch for the beta');
  await ap.click('[data-testid=confirm-ok]');
  await ap.waitForSelector('[data-testid=step-up-password]');
  await ap.fill('[data-testid=step-up-password]', PW);
  await ap.click('[data-testid=step-up-submit]');
  await ap.waitForSelector('[data-testid=lang-row][data-code=pcm][data-enabled="1"]');
  assert.equal(q1("SELECT reason FROM admin_audit WHERE action='i18n.locale.switch' ORDER BY ts DESC LIMIT 1").reason, 'Pidgin launch for the beta');
  // A guest picks Naijá in the footer: <html lang>, the sample nav label, and English for what is not translated.
  const g = await newPage({ width: 390, height: 844 });
  await g.goto(BASE + '/');
  await g.waitForSelector('[data-testid=locale-select]');
  await Promise.all([g.waitForNavigation(), g.selectOption('[data-testid=locale-select]', 'pcm')]);
  await g.waitForSelector('#view > *');
  assert.equal(await g.getAttribute('html', 'lang'), 'pcm');
  assert.ok((await g.context().cookies()).some((c) => c.name === 'plx_locale' && c.value === 'pcm'));
  assert.equal((await g.textContent('[data-t="shell.html.nav_markets"]')).trim(), 'Market dem');
  assert.equal((await g.textContent('[data-t="shell.html.nav_pro"]')).trim(), 'Pro', 'not translated: English');
  assert.ok(await overflow(g) <= 0);
  // The server-rendered page and its hreflang follow the enabled languages.
  const pc = await html('/browse', { cookie: 'plx_locale=pcm' });
  assert.match(pc.text, /<html lang="pcm" dir="ltr">/);
  assert.match(pc.text, /src="\/content-bundle\.js\?locale=pcm"/);
  assert.equal(link((await html('/browse')).text, 'alternate', ' hreflang="pcm"'), `${BASE}/browse?lang=pcm`);
  // A member saves the language on the account (Settings) and gets notifications in the template of that language.
  const mem = await new Client(BASE, 'pidgin').signUp(email('pidgin'), PW, 'Peju Pidgin');
  const mp = await newPage();
  await uiLogIn(mp, { email: email('pidgin') });
  await mp.goto(BASE + '/account/settings');
  await mp.waitForSelector('[data-testid=settings-locale]');
  await Promise.all([mp.waitForNavigation(), mp.selectOption('[data-testid=settings-locale]', 'pcm')]);
  assert.equal(JSON.parse(q1("SELECT value FROM user_settings WHERE user_id=? AND key='locale'", mem.uid).value), 'pcm');
  assert.equal((await admin.call('PUT', '/v1/admin/cms/template/draft', { key: 'notify.account', locale: 'pcm', value: { inapp_title: 'Naija: {{title}}', inapp_body: '{{body}}' } })).status, 200);
  assert.equal((await adminCall('POST', '/v1/admin/cms/template/publish', { key: 'notify.account', locale: 'pcm', reason: 'Pidgin notification wording' })).status, 200);
  const uid = mem.uid;
  assert.equal((await adminCall('POST', `/v1/admin/users/${uid}/adjust`, { amount_dollars: 1, reason: 'goodwill credit test' })).status, 200);
  await eventually(() => q1("SELECT title FROM notifications WHERE user_id=? ORDER BY created_ts DESC LIMIT 1", uid).title.startsWith('Naija: '));
  const other = await new Client(BASE, 'english').signUp(email('english'), PW, 'Ebun English');
  assert.equal((await adminCall('POST', `/v1/admin/users/${other.uid}/adjust`, { amount_dollars: 1, reason: 'goodwill credit test' })).status, 200);
  await eventually(() => !q1("SELECT title FROM notifications WHERE user_id=? ORDER BY created_ts DESC LIMIT 1", other.uid).title.startsWith('Naija'));
  // An RTL language is data: added, translated, reviewed and switched on; the page turns right-to-left without overflow.
  r = await adminCall('POST', '/v1/admin/i18n/locales', { code: 'ar', name: 'Arabic', native_name: 'العربية', dir: 'rtl', reason: 'RTL readiness test' });
  assert.equal(r.status, 201, r.text);
  const ex2 = (await admin.call('GET', '/v1/admin/i18n/locales/ar/export')).body;
  for (const e of ex2.entries.filter((x) => !x.rich && !x.vars.length).slice(0, 120)) e.translation = `${e.english} ع`;
  assert.equal((await adminCall('POST', '/v1/admin/i18n/locales/ar/import', { data: ex2, dry_run: false, reason: 'RTL test strings' })).status, 200);
  assert.equal((await adminCall('PUT', '/v1/admin/i18n/locales/ar', { reviewed: true, reason: 'RTL test review' })).status, 200);
  r = await adminCall('PUT', '/v1/admin/i18n/locales/ar', { enabled: true, reason: 'RTL test on' });
  assert.equal(r.status, 200, r.text);
  const rtl = await newPage({ width: 390, height: 844 });
  await rtl.context().addCookies([{ name: 'plx_locale', value: 'ar', url: BASE }]);
  await rtl.goto(BASE + '/');
  await rtl.waitForSelector('#view > *');
  assert.deepEqual([await rtl.getAttribute('html', 'lang'), await rtl.getAttribute('html', 'dir')], ['ar', 'rtl']);
  assert.ok(await overflow(rtl) <= 0, 'no horizontal overflow right-to-left at 390 px');
  // Switching a language off returns its readers to English; the flag i18n off hides the switcher.
  assert.equal((await adminCall('PUT', '/v1/admin/i18n/locales/ar', { enabled: false, reason: 'RTL test off' })).status, 200);
  await rtl.reload(); await rtl.waitForSelector('#view > *');
  assert.equal(await rtl.getAttribute('html', 'lang'), 'en-NG');
  await setFlag('i18n', false);
  await g.reload(); await g.waitForSelector('footer [data-testid=footer-tools]');
  assert.equal(await g.getAttribute('html', 'lang'), 'en-NG');
  assert.equal(await g.locator('[data-testid=locale-select]').count(), 0);
  await setFlag('i18n', true);
  assert.deepEqual([...ap.errors, ...g.errors, ...mp.errors, ...rtl.errors], []);
});

test('data saver: the admin default reaches visitors live; a member switches it in Settings; lighter pages; the polling fallback keeps prices fresh on an unstable connection', async () => {
  const g = await newPage();
  await g.goto(BASE + '/');
  await g.waitForSelector('[data-testid=saver-toggle]');
  assert.equal(await g.getAttribute('html', 'data-saver'), '0', 'off by default (owner setting)');
  await setOwner('data_saver.default_on', true);
  await g.waitForFunction(() => document.documentElement.dataset.saver === '1');
  await setOwner('data_saver.default_on', false);
  await g.waitForFunction(() => document.documentElement.dataset.saver === '0');
  // A guest's own choice is kept in the browser and wins over the default.
  await g.check('[data-testid=saver-toggle]');
  await g.waitForFunction(() => document.documentElement.dataset.saver === '1');
  await g.reload(); await g.waitForSelector('[data-testid=saver-toggle]');
  assert.equal(await g.getAttribute('html', 'data-saver'), '1');
  // A member switches it on in Settings: saved on the account.
  const m = await new Client(BASE, 'saver').signUp(email('saver'), PW, 'Sade Saver');
  const p = await newPage({ width: 390, height: 844 });
  await uiLogIn(p, { email: email('saver') });
  await p.goto(BASE + '/account/settings');
  await p.waitForSelector('[data-testid=toggle-data_saver]');
  await p.check('[data-testid=toggle-data_saver]');
  await eventually(() => JSON.parse(q1("SELECT value FROM user_settings WHERE user_id=? AND key='data_saver'", m.uid).value) === true);
  await p.waitForFunction(() => document.documentElement.dataset.saver === '1');
  // Polling fallback: the live connection keeps dropping; the page says it is refreshing instead, and a trade made
  // elsewhere still reaches the open event page (re-read every 15 s).
  await p.routeWebSocket(/\/v1\/ws/, (ws) => { ws.close(); });
  await p.goto(BASE + EV.url);
  await p.waitForSelector('[data-testid=event-title]');
  await p.waitForSelector('#conn-banner[data-mode=polling]:not([hidden])', { timeout: 25000 });
  const mk = q1("SELECT ticker FROM markets WHERE event_ticker=? AND status='active' ORDER BY rowid LIMIT 1", EV.ticker).ticker;
  const before = await p.textContent('[data-testid=chart-prob]');
  const t = await new Client(BASE, 'trader').signUp(email('trader'), PW, 'Tunde Trader');
  assert.equal((await t.call('POST', `/v1/users/${t.uid}/deposits`, { amount_dollars: 300 })).status, 201);
  assert.equal((await t.call('POST', `/v1/users/${t.uid}/orders`, { ticker: mk, side: 'no', type: 'market', count: 180 })).status, 201);
  const lastPct = () => { const r = q1('SELECT yes_price_cents p FROM trades WHERE market_ticker=? ORDER BY created_ts DESC, rowid DESC LIMIT 1', mk); return r.p; };
  await p.waitForFunction(([b]) => document.querySelector('[data-testid=chart-prob]')?.textContent !== b, [before], { timeout: 25000 });
  assert.match(await p.textContent('[data-testid=chart-prob]'), new RegExp(`${lastPct()}%`));
  // The flag off: no toggle, the page is not lightened.
  await setFlag('data_saver', false);
  await g.waitForFunction(() => document.documentElement.dataset.saver === '0');
  assert.equal(await g.locator('[data-testid=saver-toggle]').count(), 0);
  await setFlag('data_saver', true);
  assert.deepEqual([...g.errors, ...p.errors], []);
});

test('SMS notifications: off by default; opt-in needs a verified phone and the consent wording; money and security notices go through the simulated adapter; daily cap; opt-out always works', async () => {
  const m = await new Client(BASE, 'texter').signUp(email('texter'), PW, 'Tobi Texter');
  assert.equal((await m.call('PUT', `/v1/users/${m.uid}/sms_notifications`, { enabled: true, consent_version: 'x' })).code, 'feature_disabled', 'off by default (no real provider yet)');
  const p = await newPage();
  await uiLogIn(p, { email: email('texter') });
  await p.goto(BASE + '/account/settings');
  await p.waitForSelector('[data-testid=set-reach] h2');
  assert.equal(await p.locator('[data-testid=sms-settings]').count(), 0);
  await setFlag('sms', true);
  await p.reload();
  await p.waitForSelector('[data-testid=sms-phone-needed]');
  // Verify a phone (an invented 555 number; the code arrives in the development SMS outbox).
  const t0 = Date.now() - 1000;
  assert.equal((await m.call('POST', `/v1/users/${m.uid}/verify_phone/send`, { country: 'US', number: '202 555 0144' })).status, 201);
  const code = await eventually(async () => { const r = await (await fetch(`${BASE}/v1/dev/sms`)).json(); const x = r.messages.find((y) => y.to.endsWith('0144') && Date.parse(y.time) >= t0); return x && /code is (\d{4})/.exec(x.body)[1]; });
  assert.equal((await m.call('POST', `/v1/users/${m.uid}/verify_phone`, { code })).status, 200);
  await p.reload();
  await p.waitForSelector('[data-testid=sms-consent]');
  await p.click('[data-testid=sms-on]');
  await p.waitForSelector('[data-testid=sms-error]:has-text("Tick the box")');
  await p.check('[data-testid=sms-agree]');
  await p.click('[data-testid=sms-on]');
  await p.waitForSelector('[data-testid=sms-settings][data-enabled="1"]');
  const c = q1('SELECT * FROM sms_consents WHERE user_id=?', m.uid);
  assert.equal(c.enabled, 1); assert.match(c.consent_version, /^cms0-[0-9a-f]{12}$/); assert.equal(c.consent_text_sha256.length, 64);
  // A money notice goes out by SMS through the simulated adapter (development outbox only, never a network).
  const sent = () => q1("SELECT COUNT(*) c FROM sms_notify_outbox WHERE user_id=? AND status='sent'", m.uid).c;
  assert.equal((await adminCall('POST', `/v1/admin/users/${m.uid}/adjust`, { amount_dollars: 5, reason: 'sms channel test' })).status, 200);
  await eventually(() => sent() === 1);
  const out = await eventually(async () => (await (await fetch(`${BASE}/v1/dev/sms`)).json()).messages.find((x) => x.to.endsWith('0144') && x.kind === 'notification'));
  assert.match(out.body, /^Parlance: .*Reply STOP/);
  assert.equal(q1("SELECT provider FROM sms_notify_outbox WHERE user_id=? AND status='sent'", m.uid).provider, 'simulated');
  // Social or marketing notices never go by SMS.
  assert.equal(q1("SELECT COUNT(*) c FROM sms_notify_outbox WHERE user_id=? AND type NOT IN ('account','security','fill','money_controls','price_movement','price_target','trade_alert','referral_reward','reward','bonus_credited','deposit','withdrawal','withdrawal_hold','settlement')", m.uid).c, 0);
  // The daily cap (owner setting, live): at 1 a day the next one is skipped.
  await setOwner('sms.per_user_per_day', 1);
  assert.equal((await adminCall('POST', `/v1/admin/users/${m.uid}/adjust`, { amount_dollars: 5, reason: 'sms cap test' })).status, 200);
  await eventually(() => q1("SELECT COUNT(*) c FROM sms_notify_outbox WHERE user_id=? AND status='skipped_cap'", m.uid).c === 1);
  assert.equal(sent(), 1);
  await setOwner('sms.per_user_per_day', 10);
  // Opting out works even with the switch off.
  await setFlag('sms', false);
  assert.equal((await m.call('PUT', `/v1/users/${m.uid}/sms_notifications`, { enabled: false })).status, 200);
  assert.equal(q1('SELECT enabled FROM sms_consents WHERE user_id=?', m.uid).enabled, 0);
  assert.deepEqual(p.errors, []);
});

test('footer and help centre: Product / Company / Help columns, social links, Nigerian support hours, the accessibility statement, CMS pages behind the menu; 24 px targets at 390 px', async () => {
  const p = await newPage({ width: 390, height: 844 });
  await p.goto(BASE + '/');
  await p.waitForSelector('[data-testid=footer-cols]');
  const cols = await p.$$eval('[data-testid=footer-cols] .footer-col', (els) => els.map((c) => [c.querySelector('b').textContent, [...c.querySelectorAll('a')].map((a) => a.getAttribute('href'))]));
  assert.deepEqual(cols.map((c) => c[0]), ['Product', 'Company', 'Help']);
  for (const h of ['/trust/security', '/trust/privacy', '/legal/terms', '/trust/regulation', '/research/papers']) assert.ok(cols[1][1].includes(h), `${h} in ${JSON.stringify(cols)}`);
  for (const h of ['/support/help-center', '/support/faq', '/support/contact', '/support/fees', '/support/accessibility']) assert.ok(cols[2][1].includes(h), h);
  const social = await p.$$eval('[data-testid=footer-social] a', (els) => els.map((a) => [a.dataset.network, a.getAttribute('rel'), a.getAttribute('target'), a.getAttribute('aria-label')]));
  assert.deepEqual(social.map((s) => s[0]), ['whatsapp', 'x', 'facebook', 'instagram', 'telegram']);
  assert.ok(social.every((s) => s[1] === 'noopener noreferrer' && s[2] === '_blank' && /opens in a new tab/.test(s[3])));
  const small = await p.$$eval('footer a, footer select, footer input', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [e.textContent.trim() || e.tagName, r.width, r.height]; }).filter(([, w, h]) => w > 0 && (w < 24 || h < 24)));
  assert.deepEqual(small, [], 'every footer target is at least 24 × 24 px');
  await p.click('[data-testid=footer-cols] a[href="/support/contact"]');
  await p.waitForSelector('[data-testid=cms-page][data-page="support/contact"]');
  const body = await p.textContent('[data-testid=cms-page-body]');
  assert.match(body, /West Africa Time, WAT/); assert.match(body, /Monday to Friday: 8:00 to 20:00/); assert.match(body, /Nigerian public holidays/); assert.match(body, /support@example\.test/);
  for (const [path2, h1] of [['/support/accessibility', 'Accessibility statement'], ['/support/faq', 'Frequently asked questions'], ['/trust/security', 'Security'], ['/trust/regulation', 'Regulation'], ['/research/blog', 'Blog']]) {
    await p.goto(BASE + path2);
    await p.waitForSelector(`[data-testid=cms-page] h1:has-text("${h1}")`);
    assert.ok(await overflow(p) <= 0, path2);
  }
  assert.match(await p.textContent('[data-testid=cms-page-body]'), /./);
  await p.goto(BASE + '/support/accessibility');
  await p.waitForSelector('[data-testid=cms-page-body]');
  assert.match(await p.textContent('[data-testid=cms-page-body]'), /WCAG\) 2\.2 at level AA/);
  // The footer is CMS data: social links must be https and a known network.
  let r = await admin.call('PUT', '/v1/admin/cms/footer/draft', { key: 'links', value: { tagline: 'x', columns: [{ title: 'A', links: [{ label: 'B', href: '/b' }] }], social: [{ network: 'x', label: 'X', href: ['java', 'script:alert(1)'].join('') }] } });
  assert.equal(r.status, 400);
  r = await admin.call('PUT', '/v1/admin/cms/footer/draft', { key: 'links', value: { tagline: 'x', columns: [{ title: 'A', links: [{ label: 'B', href: '/b' }] }], social: [{ network: 'myspace', label: 'M', href: 'https://example.org/' }] } });
  assert.equal(r.status, 400);
  assert.deepEqual(p.errors, []);
});

// Regression (lead review): admin-written text was spliced into the page with String.replace, which treats `$&`, `$'`,
// `` $` `` and `$$` in the replacement as patterns, so a CMS page mentioning them was served mangled (the rest of the
// document pasted into the title, or the matched tag repeated). Both the CMS head (title, description) and the server
// rendering (title, description, Open Graph, the page body) must carry the text exactly as written.
test('server-rendered pages keep admin text with dollar patterns exactly as written (title, description, Open Graph, body), served and in the browser', async () => {
  const title = "Fees $& rebates $' and $` with $$5";
  const desc = "Pay $& now, $' later";
  const bodyText = "Tiers: $& first, $' then $` and $$10 last";
  let r = await adminCall('PUT', '/v1/admin/cms/page/draft', { key: 'support/press', value: { title, section: 'info', seo_title: title, seo_description: desc, body: `<p>${bodyText}</p>` } });
  assert.equal(r.status, 200, r.text);
  r = await adminCall('POST', '/v1/admin/cms/page/publish', { key: 'support/press', reason: 'dollar pattern regression' });
  assert.equal(r.status, 200, r.text);
  const dec = (s) => String(s).replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  for (const ssr of [true, false]) {
    await setFlag('ssr', ssr);
    const pg = await html('/support/press');
    assert.equal(pg.status, 200);
    const titles = [...pg.text.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1]);
    assert.equal(titles.length, 1, `one <title> (ssr ${ssr})`);
    assert.equal(dec(titles[0]), title, `title as written (ssr ${ssr})`);
    assert.equal(dec(meta(pg.text, 'name', 'description')), desc, `description as written (ssr ${ssr})`);
    assert.equal((pg.text.match(/<\/html>/g) || []).length, 1, `the document is not duplicated (ssr ${ssr})`);
    assert.equal((pg.text.match(/<main id="view"/g) || []).length, 1, `one main (ssr ${ssr})`);
    if (ssr) {
      assert.equal(dec(meta(pg.text, 'property', 'og:title')), title, 'og:title as written');
      const main = /<main id="view" tabindex="-1" data-ssr="1">([\s\S]*?)<\/main>/.exec(pg.text);
      assert.ok(main, 'server-rendered main');
      assert.ok(dec(main[1]).includes(bodyText), `body as written: ${main[1].slice(0, 300)}`);
    }
  }
  await setFlag('ssr', true);
  // In the browser: the tab title and the rendered page read exactly as written.
  const p = await newPage();
  await p.goto(BASE + '/support/press');
  await p.waitForSelector('[data-testid=cms-page][data-page="support/press"] [data-testid=cms-page-body]');
  assert.equal(await p.textContent('[data-testid=cms-page] h1'), title);
  assert.equal((await p.textContent('[data-testid=cms-page-body]')).trim(), bodyText);
  await eventually(async () => (await p.title()).includes(title));
  assert.deepEqual(p.errors, []);
});

test('persistence across a restart: languages and their switches, translations and review states, data saver and SMS choices, owner settings', async () => {
  const snap = () => ({ locales: dbq('SELECT code, enabled, reviewed, dir FROM i18n_locales ORDER BY code'), review: q1('SELECT COUNT(*) c FROM i18n_text_review').c, pcm: q1("SELECT COUNT(*) c FROM cms_entries WHERE locale='pcm' AND published_json IS NOT NULL").c,
    saver: dbq("SELECT user_id, value FROM user_settings WHERE key IN ('data_saver','locale') ORDER BY user_id, key"), sms: dbq('SELECT user_id, enabled, consent_version FROM sms_consents ORDER BY user_id'), owner: dbq("SELECT key, value FROM admin_settings WHERE key LIKE 'owner:%' ORDER BY key") });
  const s0 = snap();
  await srv.close();
  srv = await start(opts(PORT));
  admin = await new Client(BASE, 'admin2').logIn(ADMIN.email, ADMIN.password);
  assert.deepEqual(snap(), s0);
  const g = await newPage();
  await g.context().addCookies([{ name: 'plx_locale', value: 'pcm', url: BASE }]);
  await g.goto(BASE + '/');
  await g.waitForSelector('#view > *');
  assert.equal(await g.getAttribute('html', 'lang'), 'pcm');
  assert.equal((await admin.call('GET', '/v1/admin/owner_settings/i18n.min_coverage_pct')).body.setting.value, 1);
  assert.deepEqual(g.errors, []);
});
