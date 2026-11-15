'use strict';
// Help Center (owner request 2026-11-15, CLONE_SPEC.md §40), real server + SQLite file + Chromium:
//   • the guides are complete and wired: 25+ guides in six topics; every related guide, every /help/ link and every other
//     in-app link in a guide resolves (to a guide, or to a route the app serves); every screenshot exists and is served;
//   • a visitor opens the Help Center from the footer link, searches, opens a guide (breadcrumb, numbered steps, a loaded
//     screenshot, related guides) and votes "No" with a comment: stored in the database (a hashed browser token, no IP),
//     shown again after a reload; a topic page lists the whole topic; a mobile screen has no sideways scroll;
//   • a member's vote is stored as theirs and a changed vote replaces it (one row);
//   • Admin › Content › Pages: a publisher changes a guide's summary and topic and hides another guide (help fields in the
//     editor); the Help Center follows (hidden guide gone from lists and search, its page 404s); Admin › Content › Help
//     feedback shows the votes and comment; everything survives a restart;
//   • unsafe images in a guide body are dropped when saved; crawlers get the guide and the home server-rendered.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const { Client } = require('./lib/client');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-help-'));
const DB_FILE = path.join(TMP, 'help.db');
const PW = 'Ibadan-Copper-Harbour-6620';
const stamp = Date.now();
const ADMIN = { email: `root.${stamp}@example.test`, password: PW };
const HIGH = { burst: 1e6, per_second: 1e6 };
const OPTS = { port: 0, dbFile: DB_FILE, quiet: true, sports: false, tickMs: 500, admin: ADMIN, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH } };
const ROOT = path.join(__dirname, '..');
let srv; let BASE; let browser; let member;
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const json = async (p) => (await fetch(BASE + p)).json();

before(async () => {
  srv = await start(OPTS);
  BASE = `http://127.0.0.1:${srv.port}`;
  browser = await chromium.launch();
  member = await new Client(BASE, 'm').signUp(`help.${stamp}@example.test`, PW, 'Help Member');
});
after(async () => {
  try { await browser?.close(); } catch { /* closed */ }
  try { await srv?.close(); } catch { /* closed */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

// The SPA's route patterns, read from main.js, to check that every in-app link in a guide goes somewhere real.
const ROUTES = [...fs.readFileSync(path.join(ROOT, 'public/js/main.js'), 'utf8').matchAll(/^\s*\[(\/\^.*?\$\/),/gm)].map((m) => { const src = m[1]; return new RegExp(src.slice(1, src.lastIndexOf('/'))); });

test('the guides are complete and wired: topics, related guides, links and screenshots all resolve', async () => {
  const list = await json('/v1/help');
  const guides = list.pages.filter((p) => p.category !== 'more');
  assert.ok(guides.length >= 25, `guides: ${guides.length}`);
  const topics = ['getting-started', 'trading', 'money', 'account-security', 'features', 'troubleshooting'];
  for (const t of topics) assert.ok(guides.filter((g) => g.category === t).length >= 3, `topic ${t} has guides`);
  const slugs = new Set(list.pages.map((p) => p.slug));
  const images = new Set();
  for (const g of guides) {
    assert.ok(g.summary && g.summary.length <= 240, `${g.slug}: summary`);
    const r = await json(`/v1/help/${g.slug}`);
    const html = r.page.html;
    assert.ok(r.page.related.length >= 1, `${g.slug}: related guides`);
    for (const rel of r.page.related) assert.ok(slugs.has(rel.slug), `${g.slug}: related ${rel.slug} exists`);
    for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
      if (/^(https:|mailto:)/.test(href)) continue;
      const p = href.split(/[?#]/)[0];
      const m = /^\/help\/([a-z0-9-]+)$/.exec(p);
      if (m) assert.ok(slugs.has(m[1]), `${g.slug}: link to guide ${m[1]}`);
      else assert.ok(ROUTES.some((re) => re.test(p)), `${g.slug}: link ${p} is an app route`);
    }
    for (const [, src] of html.matchAll(/<img src="([^"]+)"/g)) images.add(src);
    if (/<ol>/.test(html)) assert.ok((html.match(/<li>/g) || []).length >= 3, `${g.slug}: numbered steps`);
  }
  assert.ok(images.size >= 15, `screenshots: ${images.size}`);
  for (const src of images) {
    assert.ok(fs.existsSync(path.join(ROOT, 'public', src)), `${src} is on disk`);
    const res = await fetch(BASE + src);
    assert.equal(res.status, 200, src); assert.equal(res.headers.get('content-type'), 'image/jpeg', src);
    assert.ok((await res.arrayBuffer()).byteLength > 3000, `${src} has content`);
  }
  assert.equal((await fetch(`${BASE}/help-img/../server/index.js`)).status, 404);
  const s = await json('/v1/help/search?q=two-factor');
  assert.equal(s.results[0].slug, 'two-factor-login');
});

test('visitor: footer → Help Center, search, guide with steps and screenshot, "No" vote with a comment persisted; topic page; mobile', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE + '/');
  await page.click('footer a[href="/support/help-center"]');
  await page.waitForSelector('[data-testid=help-topics]');
  assert.equal(await page.locator('[data-testid=help-topic]').count(), 6);
  assert.match(await page.textContent('[data-testid=help-intro]'), /Step-by-step guides/);
  await page.fill('[data-testid=help-search-input]', 'withdraw');
  await page.click('[data-testid=help-search-submit]');
  await page.waitForSelector('[data-testid=help-results]');
  assert.match(page.url(), /\/help\?q=withdraw/);
  await page.click('[data-testid=help-results] [data-slug=withdraw-funds]');
  await page.waitForSelector('[data-testid=help-page][data-slug=withdraw-funds]');
  assert.match(await page.textContent('[data-testid=help-crumbs]'), /Help center.*Money/);
  assert.ok(await page.locator('[data-testid=help-body] ol > li').count() >= 4);
  const img = page.locator('[data-testid=help-body] figure img').first();
  await img.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => { const i = document.querySelector('[data-testid=help-body] figure img'); return i && i.complete && i.naturalWidth > 200; });
  assert.ok(await page.locator('[data-testid=help-related] [data-testid=help-guide-link]').count() >= 1);
  assert.ok(await page.locator('[data-testid=help-contact] a[href="/support/contact"]').isVisible());
  // "No" with a comment.
  await page.click('[data-testid=help-no]');
  await page.waitForSelector('[data-testid=help-feedback][data-vote=no]');
  await page.fill('[data-testid=help-feedback-comment]', 'Say how long the review takes for crypto.');
  await page.click('[data-testid=help-feedback-send]');
  await page.waitForSelector('[data-testid=help-thanks]:has-text("Thanks for your feedback")');
  const rows = dbq("SELECT * FROM help_feedback WHERE slug='withdraw-funds'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].helpful, 0); assert.equal(rows[0].user_id, null);
  assert.match(rows[0].voter, /^a:[0-9a-f]{32}$/); assert.equal(rows[0].comment, 'Say how long the review takes for crypto.');
  await page.reload();
  await page.waitForSelector('[data-testid=help-feedback][data-vote=no]');
  assert.equal(await page.getAttribute('[data-testid=help-no]', 'aria-pressed'), 'true');
  // Topic page: the whole topic.
  await page.goto(BASE + '/help?topic=trading');
  await page.waitForSelector('[data-testid=help-topic-page][data-topic=trading]');
  const n = (await json('/v1/help')).pages.filter((p) => p.category === 'trading').length;
  assert.equal(await page.locator('[data-testid=help-topic-page] [data-testid=help-guide-link]').count(), n);
  // No results.
  await page.goto(BASE + '/help?q=zzqxv');
  await page.waitForSelector('[data-testid=help-no-results]');
  assert.deepEqual(errors, []);
  await ctx.close();
  // Phone width: no sideways scroll on the home or a guide.
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const mp = await m.newPage();
  for (const p of ['/help', '/help/place-your-first-trade']) {
    await mp.goto(BASE + p);
    await mp.waitForSelector(p === '/help' ? '[data-testid=help-topics]' : '[data-testid=help-page]');
    assert.ok(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${p}: no horizontal scroll`);
  }
  await m.close();
});

test('member: a vote is stored as theirs, and a changed vote replaces it', async () => {
  const yes = await member.call('POST', '/v1/help/place-your-first-trade/feedback', { helpful: true });
  assert.equal(yes.status, 201);
  const no = await member.call('POST', '/v1/help/place-your-first-trade/feedback', { helpful: false, comment: 'Add a phone screenshot.' });
  assert.equal(no.status, 200);
  const rows = dbq("SELECT * FROM help_feedback WHERE slug='place-your-first-trade'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].voter, `u:${member.uid}`); assert.equal(rows[0].user_id, member.uid); assert.equal(rows[0].helpful, 0);
  const g = await member.call('GET', '/v1/help/place-your-first-trade');
  assert.equal(g.body.page.your_vote, 'no');
  const bad = await member.call('POST', '/v1/help/place-your-first-trade/feedback', { helpful: 'maybe' });
  assert.equal(bad.status, 400);
  const markup = await member.call('POST', '/v1/help/place-your-first-trade/feedback', { helpful: false, comment: '<script>alert(1)</script>' });
  assert.equal(markup.status, 400);
  assert.equal((await member.call('POST', '/v1/help/no-such-guide/feedback', { helpful: true })).status, 404);
  const visitor = await new Client(BASE, 'v').boot();
  const noToken = await visitor.call('POST', '/v1/help/trading-fees/feedback', { helpful: true });
  assert.equal(noToken.status, 400, 'a signed-out vote needs the browser token');
});

test('admin: edit a guide (summary, topic), hide another, feedback report; unsafe images dropped; survives a restart', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 950 } });
  const ap = await ctx.newPage();
  const errors = []; ap.on('pageerror', (e) => errors.push(e.message));
  await ap.goto(BASE + '/sign-in');
  await ap.fill('input[name=email]', ADMIN.email);
  await ap.fill('input[name=password]', PW);
  await ap.click('button[type=submit]');
  await ap.waitForSelector('[data-testid=account-menu]');
  const publishDialog = async () => {
    await ap.click('[data-testid=cms-publish]');
    await ap.fill('[data-testid=confirm-reason]', 'Help Center update from the e2e suite');
    await ap.click('[data-testid=confirm-ok]');
    await ap.waitForSelector('[data-testid=cms-dialog]', { state: 'detached' });
  };
  // 1. Change the summary and topic of "Fees explained".
  await ap.goto(BASE + '/admin/cms/pages');
  await ap.click('[data-testid=cms-page-row][data-page="help/trading-fees"]');
  await ap.waitForSelector('[data-testid=cms-help-fields]:not([hidden])');
  await ap.fill('[data-testid=cms-help-summary]', 'What you pay to trade, in one minute.');
  await ap.selectOption('[data-testid=cms-help-category]', 'money');
  await ap.fill('[data-testid=cms-help-related]', 'add-funds, limit-orders');
  await publishDialog();
  // 2. Hide "Follow traders and share ideas".
  await ap.click('[data-testid=cms-page-row][data-page="help/social-profile"]');
  await ap.waitForSelector('[data-testid=cms-help-fields]:not([hidden])');
  await ap.check('[data-testid=cms-help-hidden]');
  await publishDialog();
  const list = await json('/v1/help');
  const fees = list.pages.find((p) => p.slug === 'trading-fees');
  assert.equal(fees.category, 'money'); assert.equal(fees.summary, 'What you pay to trade, in one minute.');
  assert.ok(!list.pages.some((p) => p.slug === 'social-profile'), 'hidden guide left out');
  assert.ok(!(await json('/v1/help/search?q=nickname')).results.some((r) => r.slug === 'social-profile'));
  assert.equal((await fetch(`${BASE}/v1/help/social-profile`)).status, 404);
  const g = await json('/v1/help/trading-fees');
  assert.deepEqual(g.page.related.slice(0, 2).map((r) => r.slug), ['add-funds', 'limit-orders']);
  // The visitor sees the change; the hidden guide shows "not found".
  const vp = await ctx.newPage();
  await vp.goto(BASE + '/help?topic=money');
  await vp.waitForSelector('[data-testid=help-topic-page] [data-slug=trading-fees]:has-text("What you pay to trade")');
  await vp.goto(BASE + '/help/social-profile');
  await vp.waitForSelector('[data-testid=help-missing]');
  // 3. Feedback report.
  await ap.goto(BASE + '/admin/cms/help');
  const row = ap.locator('[data-testid=help-feedback-row][data-slug=withdraw-funds]');
  await row.waitFor();
  assert.equal(await row.locator('[data-col=no]').textContent(), '1');
  assert.match(await ap.textContent('[data-testid=help-feedback-comments]'), /how long the review takes for crypto/);
  // 4. Unsafe images in a body are dropped when saved (API, publisher rights).
  const adminC = await new Client(BASE, 'a').logIn(ADMIN.email, PW);
  const put = await adminC.call('PUT', '/v1/admin/cms/page/draft', { key: 'help/test-images', value: { title: 'Images', section: 'help', category: 'troubleshooting', summary: 's', body: '<p>x</p><img src="https://evil.example/x.png"><img src="/help-img/deposit.jpg" onerror="alert(1)" alt="ok"><img src="javascript:alert(1)">' } });
  assert.ok(put.status < 300, JSON.stringify(put));
  const saved = dbq("SELECT draft_json FROM cms_entries WHERE type='page' AND key='help/test-images'")[0].draft_json;
  assert.ok(!/evil|onerror|javascript/.test(saved), saved);
  assert.match(saved, /<img src=\\"\/help-img\/deposit.jpg\\" alt=\\"ok\\" loading=\\"lazy\\"/);
  const badTopic = await adminC.call('PUT', '/v1/admin/cms/page/draft', { key: 'help/test-images', value: { title: 'Images', section: 'help', category: 'nope', body: '<p>x</p>' } });
  assert.equal(badTopic.status, 400);
  assert.deepEqual(errors, []);
  await ctx.close();
  // 5. Restart: published edits, hidden flag and votes are kept.
  await srv.close();
  srv = await start({ ...OPTS, port: 0 });
  BASE = `http://127.0.0.1:${srv.port}`;
  const after = await json('/v1/help');
  assert.equal(after.pages.find((p) => p.slug === 'trading-fees').category, 'money');
  assert.ok(!after.pages.some((p) => p.slug === 'social-profile'));
  assert.equal(dbq('SELECT COUNT(*) c FROM help_feedback')[0].c, 2);
});

test('crawlers get the Help Center home and a guide server-rendered, and the sitemap lists the guides', async () => {
  const ua = { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' } };
  const home = await (await fetch(`${BASE}/help`, ua)).text();
  assert.match(home, /<h1>Help center<\/h1>/); assert.match(home, /href="\/help\/place-your-first-trade"/);
  const guide = await (await fetch(`${BASE}/help/two-factor-login`, ua)).text();
  assert.match(guide, /<h1>Turn on two-factor login<\/h1>/); assert.match(guide, /BreadcrumbList/);
  const sm = await (await fetch(`${BASE}/sitemaps/pages.xml`)).text();
  assert.match(sm, /\/help\/place-your-first-trade<\/loc>/); assert.ok(!/\/help\/social-profile</.test(sm), 'hidden guide not in the sitemap');
});
