'use strict';
// End-to-end browser tests for the admin panel + CMS (ADMIN_SPEC §18): access control, roles, catalog drafts →
// publish (+ seeded liquidity), CSV import, resolution desk (settlement + reversal before finalize), content CMS
// (hero, promo, banner, navigation, news, help) persisting across a restart, user support actions (balance
// adjustment, lock / unlock), moderation (report → hide, posting ban, verified badge), announcements, reports
// dashboard vs. the database, settings (APY used by accrual, feature switches), audit log, and 390px layout.
// Real server + SQLite file + Chromium.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-admin-'));
const DB_FILE = path.join(TMP, 'admin.db');
const PORT = 4500 + Math.floor(Math.random() * 40);
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'correct-horse-9';
const ADMIN = { email: 'admin@parlance.local', password: 'parlance-admin' };
const stamp = Date.now();
const trader = { email: `trader.${stamp}@example.test`, name: 'Tess Trader', password: PW };
const editor = { email: `editor.${stamp}@example.test`, name: 'Eddie Editor', password: PW };
const moder = { email: `mod.${stamp}@example.test`, name: 'Mona Moderator', password: PW };
const OPTS = { port: PORT, dbFile: DB_FILE, tickMs: 300, rollingWindowSec: 5 };

let srv; let browser;
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const dbrun = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
const uidOf = (email) => dbq('SELECT id FROM users WHERE email=?', email)[0].id;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 200) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for condition'); await sleep(step); }
}

// Minimal cookie + CSRF HTTP client for test setup and API-level assertions.
function client() {
  let cookie = ''; let csrf = '';
  const call = async (method, p, body) => {
    const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
    if (json && json.csrf_token) csrf = json.csrf_token;
    return { status: r.status, body: json };
  };
  return { call, login: (u) => call('POST', '/v1/log_in', { email: u.email, password: u.password }), signup: (u) => call('POST', '/v1/users', { email: u.email, password: u.password, display_name: u.name }) };
}

async function newPage(viewport = { width: 1440, height: 1000 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  return page;
}
async function logIn(page, u) {
  await page.goto(BASE + '/sign-in');
  await page.fill('input[name=email]', u.email);
  await page.fill('input[name=password]', u.password);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
}
// Fill the open admin dialog form: {name: value}; selects use selectOption, checkboxes setChecked.
async function fillForm(scope, values) {
  for (const [name, v] of Object.entries(values)) {
    const el = scope.locator(`[name="${name}"]`).first();
    const tag = await el.evaluate((n) => n.tagName + (n.type ? ':' + n.type : ''));
    if (tag.startsWith('SELECT')) await el.selectOption(String(v));
    else if (tag === 'INPUT:checkbox') await el.setChecked(!!v);
    else await el.fill(String(v));
  }
}
async function submitDialog(page) {
  await page.locator('dialog[open] form button[type=submit]').first().click();
  await page.waitForSelector('dialog[open]', { state: 'detached' });
}
async function confirm(page, reason) {
  const d = page.locator('[data-testid=confirm-dialog]');
  await d.waitFor();
  if (reason) await d.locator('[data-testid=confirm-reason]').fill(reason);
  await d.locator('[data-testid=confirm-ok]').click();
  await page.waitForSelector('[data-testid=confirm-dialog]', { state: 'detached' });
}

let adminPage; let traderPage;
const admin = client();
const traderApi = client();

before(async () => {
  srv = await start(OPTS);
  browser = await chromium.launch();
  await admin.login(ADMIN);
});
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('non-admins are blocked from /admin (UI 403 page, API 401/403, no menu link)', async () => {
  const anon = await newPage();
  await anon.goto(BASE + '/admin');
  await anon.locator('[data-testid=admin-forbidden]').waitFor();
  assert.match(await anon.locator('[data-testid=admin-forbidden]').textContent(), /Sign in/);
  traderPage = await newPage();
  await traderPage.goto(BASE + '/sign-up');
  await traderPage.fill('input[name=display_name]', trader.name);
  await traderPage.fill('input[name=email]', trader.email);
  await traderPage.fill('input[name=password]', PW);
  await traderPage.click('button[type=submit]');
  await traderPage.waitForSelector('[data-testid=account-menu]');
  await traderPage.click('[data-testid=account-menu]');
  assert.equal(await traderPage.locator('[data-testid=admin-link]').count(), 0);
  await traderPage.goto(BASE + '/admin/users');
  await traderPage.locator('[data-testid=admin-forbidden]').waitFor();
  assert.match(await traderPage.locator('[data-testid=admin-forbidden]').textContent(), /don.t have access/);
  await traderApi.login(trader);
  assert.equal((await traderApi.call('GET', '/v1/admin/me')).status, 403);
  assert.equal((await traderApi.call('GET', '/v1/admin/users')).status, 403);
  assert.equal((await traderApi.call('POST', '/v1/admin/catalog/series', { ticker: 'PLXNOPE', title: 'x', category: 'Politics' })).status, 403);
  assert.equal((await client().call('GET', '/v1/admin/reports')).status, 401);
  assert.deepEqual(traderPage.errors, []);
  assert.deepEqual(anon.errors, []);
  await anon.context().close();
});

test('catalog: series → event → market as drafts are hidden; preview; publish makes them public with seeded liquidity', async () => {
  adminPage = await newPage();
  const page = adminPage;
  await logIn(page, ADMIN);
  await page.click('[data-testid=account-menu]');
  await page.click('[data-testid=admin-link]');
  await page.waitForURL(/\/admin\/catalog$/);
  await page.goto(BASE + '/admin/catalog/series');
  await page.click('[data-testid=catalog-new]');
  // Inline validation: submitting empty shows field errors and keeps the dialog open.
  await page.locator('dialog[open] form button[type=submit]').click();
  assert.match(await page.locator('dialog[open] #e-cat-ticker').textContent(), /required/);
  await fillForm(page.locator('dialog[open]'), { ticker: 'PLXADM', title: 'Robot officiating', category: 'Science and Technology', tags: 'Robots, Sport', fee_multiplier: 1.5 });
  await submitDialog(page);
  await page.locator('[data-row=PLXADM][data-state=draft]').waitFor();

  await page.goto(BASE + '/admin/catalog/events');
  await page.click('[data-testid=catalog-new]');
  await fillForm(page.locator('dialog[open]'), { ticker: 'PLXADM-27ROBOT', series_ticker: 'PLXADM', title: 'Will a robot referee a cup final in 2027?', sub_title: 'Before 2028', category: 'Science and Technology', icon_color: '#e8590c', news: 'A trial league approved automated offside calls.' });
  await submitDialog(page);
  await page.locator('[data-row="PLXADM-27ROBOT"]').waitFor();
  await page.click('[data-add-market="PLXADM-27ROBOT"]');
  await fillForm(page.locator('dialog[open]'), { ticker: 'PLXADM-27ROBOT-YES', yes_sub_title: 'Robot referee', no_sub_title: 'Human referee', initial_price: 40 });
  await submitDialog(page);

  assert.equal(dbq('SELECT COUNT(*) c FROM cms_draft_series WHERE ticker=?', 'PLXADM')[0].c, 1);
  assert.equal(dbq('SELECT COUNT(*) c FROM cms_draft_events WHERE ticker=?', 'PLXADM-27ROBOT')[0].c, 1);
  assert.equal(dbq('SELECT COUNT(*) c FROM cms_draft_markets WHERE ticker=?', 'PLXADM-27ROBOT-YES')[0].c, 1);
  assert.equal(dbq('SELECT COUNT(*) c FROM events WHERE ticker=?', 'PLXADM-27ROBOT')[0].c, 0);
  // Not public: v2 API 404, search finds nothing, browse shows nothing.
  assert.equal((await fetch(`${BASE}/trade-api/v2/events/PLXADM-27ROBOT`)).status, 404);
  assert.equal((await (await fetch(`${BASE}/v1/search/series?query=robot%20referee`)).json()).total_results_count, 0);
  const pub = await newPage();
  await pub.goto(BASE + '/search?q=robot%20referee');
  await sleep(800);
  assert.equal(await pub.locator('[data-event="PLXADM-27ROBOT"]').count(), 0);

  // Preview link renders the draft card.
  await page.click('[data-preview="PLXADM-27ROBOT"]');
  await page.locator('[data-testid=catalog-preview][data-state=draft]').waitFor();
  assert.match(await page.locator('[data-testid=catalog-preview]').textContent(), /Will a robot referee a cup final in 2027\?/);
  assert.match(await page.locator('[data-testid=catalog-preview] .ev-icon').getAttribute('style'), /#e8590c/);

  // Publish the event: series + event + market go live.
  await page.goto(BASE + '/admin/catalog/events');
  await page.click('[data-publish="PLXADM-27ROBOT"]');
  await confirm(page);
  await page.locator('[data-row="PLXADM-27ROBOT"][data-state=published]').waitFor();
  assert.equal(dbq("SELECT status FROM markets WHERE ticker='PLXADM-27ROBOT-YES'")[0].status, 'active');
  assert.equal(dbq("SELECT fee_multiplier FROM series WHERE ticker='PLXADM'")[0].fee_multiplier, 1.5);
  assert.equal(dbq('SELECT COUNT(*) c FROM cms_draft_markets')[0].c, 0);
  const lp = uidOf('liquidity@parlance.local');
  await until(() => dbq("SELECT COUNT(*) c FROM orders WHERE user_id=? AND market_ticker='PLXADM-27ROBOT-YES' AND status='resting'", lp)[0].c >= 2);
  const book = await (await fetch(`${BASE}/trade-api/v2/markets/PLXADM-27ROBOT-YES/orderbook`)).json();
  assert.ok(book.orderbook_fp.yes_dollars.length && book.orderbook_fp.no_dollars.length, 'two-sided starting liquidity');
  assert.equal((await (await fetch(`${BASE}/v1/search/series?query=robot%20referee`)).json()).total_results_count, 1);
  await pub.goto(BASE + '/search?q=robot%20referee');
  await pub.locator('[data-event="PLXADM-27ROBOT"]').waitFor();
  assert.match(await pub.locator('[data-event="PLXADM-27ROBOT"] .ev-icon').getAttribute('style'), /#e8590c/);
  assert.deepEqual(page.errors, []);
  assert.deepEqual(pub.errors, []);
  await pub.context().close();
});

test('CSV bulk import: template download, valid rows become drafts, the bad row is reported', async () => {
  const page = adminPage;
  await page.goto(BASE + '/admin/catalog/import');
  const [tpl] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid=import-template]')]);
  const tplText = fs.readFileSync(await tpl.path(), 'utf8');
  assert.match(tplText.split('\n')[0], /^event_ticker,market_ticker,yes_sub_title/);
  const close = new Date(Date.now() + 40 * 86400000).toISOString();
  const csv = ['event_ticker,market_ticker,yes_sub_title,close_time,color,initial_price',
    `PLXADM-27ROBOT,PLXADM-27ROBOT-SEMI,"Semi-final only",${close},#2f6fed,30`,
    `PLXADM-27ROBOT,PLXADM-27ROBOT-NONE,No robots at all,${close},,`,
    'PLXADM-27ROBOT,bad ticker!,Broken row,not-a-date,#zzz,500'].join('\n');
  await page.fill('[data-testid=import-csv]', csv);
  await page.click('[data-testid=import-run]');
  await page.locator('[data-testid=import-result]').waitFor();
  assert.equal(await page.locator('[data-testid=import-created]').textContent(), '2');
  assert.equal(await page.locator('[data-testid=import-errors]').textContent(), '1');
  const errRow = await page.locator('[data-testid=import-error-table] tbody tr').textContent();
  assert.match(errRow, /^4/);
  assert.match(errRow, /close_time/);
  assert.match(errRow, /color/);
  const [rep] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid=import-error-csv]')]);
  assert.match(fs.readFileSync(await rep.path(), 'utf8'), /^row,market_ticker,errors\n4,bad ticker!,/);
  assert.deepEqual(dbq("SELECT ticker FROM cms_draft_markets WHERE import_batch IS NOT NULL ORDER BY ticker").map((r) => r.ticker), ['PLXADM-27ROBOT-NONE', 'PLXADM-27ROBOT-SEMI']);
  assert.equal(dbq("SELECT COUNT(*) c FROM markets WHERE ticker='PLXADM-27ROBOT-SEMI'")[0].c, 0);
  assert.deepEqual(page.errors, []);
});

test('roles: an editor can edit the catalog but not users (UI and API permission checks)', async () => {
  const ec = client();
  assert.equal((await ec.signup(editor)).status, 201);
  const page = adminPage;
  await page.goto(BASE + '/admin/roles');
  await page.fill('[data-testid=role-email]', editor.email);
  await page.selectOption('[data-testid=role-select]', 'editor');
  await page.click('[data-testid=role-grant] button[type=submit]');
  await page.locator(`[data-testid=staff] [data-email="${editor.email}"]`).waitFor();
  assert.deepEqual(dbq('SELECT role FROM admin_roles WHERE user_id=?', uidOf(editor.email)).map((r) => r.role), ['editor']);

  const ep = await newPage();
  await logIn(ep, editor);
  await ep.click('[data-testid=account-menu]');
  await ep.click('[data-testid=admin-link]');
  await ep.waitForURL(/\/admin\/catalog$/);
  assert.equal(await ep.locator('.adm-side [data-section=users]').count(), 0);
  assert.equal(await ep.locator('.adm-side [data-section=content]').count(), 1);
  await ep.goto(BASE + '/admin/catalog/events');
  await ep.fill('[data-q]', 'robot');
  await ep.locator('[data-row="PLXADM-27ROBOT"]').waitFor();
  await ep.click('[data-edit="PLXADM-27ROBOT"]');
  await fillForm(ep.locator('dialog[open]'), { title: 'Will a robot referee any cup final in 2027?', featured: true });
  await submitDialog(ep);
  assert.equal(dbq("SELECT title FROM events WHERE ticker='PLXADM-27ROBOT'")[0].title, 'Will a robot referee any cup final in 2027?');
  await ep.goto(BASE + '/admin/users');
  await ep.locator('[data-testid=section-forbidden]').waitFor();
  await ec.login(editor);
  assert.equal((await ec.call('GET', '/v1/admin/users')).status, 403);
  assert.equal((await ec.call('POST', `/v1/admin/users/${uidOf(trader.email)}/adjust`, { amount_dollars: 5, reason: 'not allowed' })).status, 403);
  assert.equal((await ec.call('GET', '/v1/admin/catalog/events')).status, 200);
  assert.deepEqual(ep.errors, []);
  await ep.context().close();
});

test('resolution desk: early close + resolve with a note pays the holder; a wrong result is reversed before settlement', async () => {
  await traderApi.call('POST', `/v1/users/${uidOf(trader.email)}/deposits`, { amount_dollars: 500 });
  const buy = (ticker) => traderApi.call('POST', `/v1/users/${uidOf(trader.email)}/orders`, { ticker, side: 'yes', action: 'buy', type: 'market', count: 10 });
  assert.equal((await buy('PLXLAUNCH-27Q1')).status, 201);
  assert.equal((await buy('PLXGADGET-27FOLD')).status, 201);
  const page = adminPage;
  await page.goto(BASE + '/admin/resolution');
  await page.locator('[data-testid=early-close-form]').waitFor();
  for (const t of ['PLXLAUNCH-27Q1', 'PLXGADGET-27FOLD']) {
    await page.selectOption('[data-testid=early-close-form] select', t);
    await page.click('[data-testid=early-close-form] button[type=submit]');
    await confirm(page, 'Event already decided by the launch provider');
    await page.locator(`[data-testid=resolution-queue] [data-row="${t}"][data-status=closed]`).waitFor();
  }
  // Resolve YES with a source note; the seeded 5 s settlement timer then pays out.
  await page.click('[data-resolve="PLXLAUNCH-27Q1"]');
  const d = page.locator('[data-testid=confirm-dialog]');
  await d.locator('input[value=yes]').check();
  await d.locator('[data-testid=resolve-note]').fill('Kestrel reached orbit per the operator mission log, 2026-11-02 14:05 UTC');
  await d.locator('[data-testid=resolve-delay]').fill('1');
  await d.locator('[data-testid=confirm-ok]').click();
  await page.locator('[data-row="PLXLAUNCH-27Q1"][data-status=determined], [data-row="PLXLAUNCH-27Q1"][data-status=finalized]').first().waitFor();
  assert.equal(dbq("SELECT source_note FROM res_resolutions WHERE market_ticker='PLXLAUNCH-27Q1'")[0].source_note, 'Kestrel reached orbit per the operator mission log, 2026-11-02 14:05 UTC');
  await until(() => dbq("SELECT status FROM markets WHERE ticker='PLXLAUNCH-27Q1'")[0].status === 'finalized');
  const st = (await traderApi.call('GET', `/v1/users/${uidOf(trader.email)}/settlement_history`)).body.settlements;
  const s1 = st.find((s) => s.ticker === 'PLXLAUNCH-27Q1');
  assert.equal(s1.market_result, 'yes');
  assert.equal(s1.revenue_dollars, '10.0000');
  assert.equal(dbq("SELECT COUNT(*) c FROM ledger WHERE user_id=? AND kind='settlement' AND ref='PLXLAUNCH-27Q1'", uidOf(trader.email))[0].c, 1);
  await until(() => dbq("SELECT status FROM res_resolutions WHERE market_ticker='PLXLAUNCH-27Q1'")[0].status === 'finalized');

  // Wrong result with a review hold → reverse → correct result settles immediately.
  await page.click('[data-resolve="PLXGADGET-27FOLD"]');
  await d.locator('input[value=no]').check();
  await d.locator('[data-testid=resolve-note]').fill('Nimbus statement (misread)');
  await d.locator('[data-testid=resolve-delay]').fill('3600');
  await d.locator('[data-testid=confirm-ok]').click();
  await page.locator('[data-row="PLXGADGET-27FOLD"][data-status=determined]').waitFor();
  await page.click('[data-reverse="PLXGADGET-27FOLD"]');
  await confirm(page, 'Statement was about a phone, not the tablet');
  await page.locator('[data-row="PLXGADGET-27FOLD"][data-status=closed]').waitFor();
  const m = dbq("SELECT status, result FROM markets WHERE ticker='PLXGADGET-27FOLD'")[0];
  assert.deepEqual({ ...m }, { status: 'closed', result: '' });
  assert.equal(dbq("SELECT COUNT(*) c FROM settlements WHERE market_ticker='PLXGADGET-27FOLD'")[0].c, 0);
  assert.equal(dbq("SELECT status FROM res_resolutions WHERE market_ticker='PLXGADGET-27FOLD'")[0].status, 'reversed');
  await page.click('[data-resolve="PLXGADGET-27FOLD"]');
  await d.locator('input[value=yes]').check();
  await d.locator('[data-testid=resolve-note]').fill('Nimbus tablet shipping notice, 2026-11-02');
  await d.locator('[data-testid=resolve-delay]').fill('0');
  await d.locator('[data-testid=confirm-ok]').click();
  await until(() => dbq("SELECT status FROM markets WHERE ticker='PLXGADGET-27FOLD'")[0].status === 'finalized');
  const s2 = (await traderApi.call('GET', `/v1/users/${uidOf(trader.email)}/settlement_history`)).body.settlements.find((s) => s.ticker === 'PLXGADGET-27FOLD');
  assert.equal(s2.revenue_dollars, '10.0000');
  // A settled market cannot be reversed.
  assert.equal((await admin.call('POST', '/v1/admin/resolution/PLXGADGET-27FOLD/reverse', { note: 'too late now' })).body.error.code, 'already_settled');
  assert.deepEqual(page.errors, []);
});

test('content CMS: hero, promo, banner, navigation, news and help show on the public site and survive a restart', async () => {
  const page = adminPage;
  // Hero carousel: a single selected event.
  await page.goto(BASE + '/admin/content/hero');
  await page.click('[data-add="PLXRATE-26DEC"]');
  await page.click('[data-testid=hero-save]');
  await until(() => dbq('SELECT COUNT(*) c FROM cms_hero')[0].c === 1);
  // Promo card.
  await page.goto(BASE + '/admin/content/promos');
  await page.click('[data-testid=content-new]');
  await fillForm(page.locator('dialog[open]'), { overline: 'Spotlight', title: 'Robot referees are coming', subtitle: 'New science markets', link: '/category/science-and-technology', color: '#e8590c' });
  await submitDialog(page);
  // Site banner (everyone).
  await page.goto(BASE + '/admin/content/banners');
  await page.click('[data-testid=content-new]');
  await fillForm(page.locator('dialog[open]'), { content: 'Scheduled maintenance Sunday 02:00 UTC', link: '/help/fees', visibility: 'all' });
  await submitDialog(page);
  // Navigation: relabel, hide, featured tab.
  await page.goto(BASE + '/admin/content/nav');
  await page.locator('tr[data-cat="Politics"] input[data-label]').fill('Civics');
  await page.locator('tr[data-cat="Sports"] input[data-hidden]').check();
  await page.fill('[data-testid=nav-form] [name=label]', 'Big Night');
  await page.fill('[data-testid=nav-form] [name=href]', '/category/politics');
  await page.click('[data-testid=nav-form] button[type=submit]');
  await until(() => dbq("SELECT hidden FROM cms_nav WHERE category='Sports'")[0]?.hidden === 1);
  // News item on an event.
  await page.goto(BASE + '/admin/content/news');
  await page.click('[data-testid=content-new]');
  await fillForm(page.locator('dialog[open]'), { event_ticker: 'PLXRATE-26DEC', source: 'Harbor Gazette', headline: 'Board signals patience ahead of December meeting', summary: 'Two members argued for waiting on one more inflation print.' });
  await submitDialog(page);
  // Help page with markup that must be rendered safely.
  await page.goto(BASE + '/admin/content/help');
  await page.click('[data-testid=content-new]');
  await fillForm(page.locator('dialog[open]'), { slug: 'fees', title: 'Fees explained', body: '# How fees work\nTakers pay a fee. **Makers pay nothing.**\n\n- Fees round up to the cent\n- Settlement is free\n\n<script>window.__pwned = 1</script>\n<img src=x onerror="window.__pwned=2">\nSee [all markets](/browse).' });
  await submitDialog(page);
  assert.equal(dbq("SELECT COUNT(*) c FROM cms_help WHERE slug='fees'")[0].c, 1);

  async function checkPublic(label) {
    const p = await newPage();
    await p.goto(BASE + '/');
    await p.locator('[data-testid=hero-title]').waitFor();
    assert.equal(await p.locator('[data-testid=hero-title]').textContent(), 'Central bank decision in December', label);
    assert.equal(await p.locator('[data-testid=hero-pager]').textContent(), '1 of 1', label);
    assert.match(await p.locator('[data-testid=promo-card]').textContent(), /Robot referees are coming/);
    assert.equal(await p.locator('[data-testid=perps-promo]').count(), 0);
    assert.match(await p.locator('[data-testid=site-banner]').textContent(), /Scheduled maintenance Sunday 02:00 UTC/);
    assert.equal(await p.locator('[data-testid=featured-tab]').textContent(), 'Big Night');
    assert.ok((await p.locator('#category-strip').textContent()).includes('Civics'), label);
    assert.equal(await p.locator('#category-strip a[href="/category/sports"]').count(), 0);
    await p.goto(BASE + '/markets/plxrate/central-bank-decision/plxrate-26dec');
    await p.locator('[data-testid=news-item]').waitFor();
    assert.match(await p.locator('[data-testid=news-item]').textContent(), /HARBOR GAZETTE.*Board signals patience ahead of December meeting/s);
    await p.goto(BASE + '/help/fees');
    await p.locator('[data-testid=help-page]').waitFor();
    assert.equal(await p.locator('[data-testid=help-page] h1').textContent(), 'Fees explained');
    assert.equal(await p.locator('[data-testid=help-body] h2').textContent(), 'How fees work');
    assert.equal(await p.locator('[data-testid=help-body] strong').textContent(), 'Makers pay nothing.');
    assert.equal(await p.locator('[data-testid=help-body] li').count(), 2);
    assert.equal(await p.locator('[data-testid=help-body] script, [data-testid=help-body] img').count(), 0);
    assert.match(await p.locator('[data-testid=help-body]').textContent(), /<script>window.__pwned = 1<\/script>/);
    assert.equal(await p.evaluate(() => window.__pwned), undefined);
    assert.equal(await p.locator('[data-testid=help-body] a[href="/browse"]').count(), 1);
    assert.deepEqual(p.errors, [], label);
    await p.context().close();
  }
  await checkPublic('before restart');
  await srv.close();
  srv = await start(OPTS);
  await checkPublic('after restart');
  assert.deepEqual(page.errors, []);
});

test('users: search, balance adjustment (ledger + live header balance), lock refuses login, unlock restores it', async () => {
  const tp = traderPage;
  await tp.goto(BASE + '/portfolio');
  await tp.locator('[data-testid=header-balance]').waitFor();
  const before = Number((await tp.locator('[data-testid=header-balance]').textContent()).replace(/[$,]/g, ''));
  const page = adminPage;
  await page.goto(BASE + '/admin/users');
  await page.fill('[data-testid=user-search]', 'tess');
  await page.press('[data-testid=user-search]', 'Enter');
  await page.locator(`[data-testid=user-results] [data-email="${trader.email}"] a`).click();
  await page.locator('[data-testid=user-detail]').waitFor();
  assert.equal(await page.locator('[data-testid=user-positions] tbody tr').count() >= 1, true);
  await page.click('[data-testid=user-adjust]');
  await fillForm(page.locator('dialog[open]'), { amount_dollars: 25, reason: 'Goodwill credit for the outage' });
  await submitDialog(page);
  const tid = uidOf(trader.email);
  const adj = dbq("SELECT amount_cents, memo FROM ledger WHERE user_id=? AND kind='adjustment'", tid);
  assert.deepEqual(adj.map((r) => ({ ...r })), [{ amount_cents: 2500, memo: 'Goodwill credit for the outage' }]);
  await until(async () => Number((await tp.locator('[data-testid=header-balance]').textContent()).replace(/[$,]/g, '')) === Math.round((before + 25) * 100) / 100);
  assert.match(await page.locator('[data-testid=user-cash]').textContent(), /\$/);

  // Lock: sessions are dropped and the password login is refused.
  await page.click('[data-testid=user-lock]');
  await confirm(page, 'Suspicious login from a new device');
  await page.locator('[data-testid=user-unlock]').waitFor();
  assert.equal(dbq('SELECT COUNT(*) c FROM acct_locks WHERE user_id=?', tid)[0].c, 1);
  assert.equal(dbq('SELECT COUNT(*) c FROM sessions WHERE user_id=?', tid)[0].c, 0);
  assert.equal((await traderApi.call('GET', `/v1/users/${tid}/balance`)).status, 401);
  assert.equal((await traderApi.login(trader)).body.error.code, 'account_locked');
  await tp.goto(BASE + '/sign-in');
  await tp.fill('input[name=email]', trader.email);
  await tp.fill('input[name=password]', PW);
  await tp.click('button[type=submit]');
  await tp.waitForFunction(() => /locked/.test(document.querySelector('#auth-error')?.textContent || ''));
  // Unlock → login works again.
  await page.click('[data-testid=user-unlock]');
  await confirm(page, 'Verified with the account holder');
  await page.locator('[data-testid=user-lock]').waitFor();
  await logIn(tp, trader);
  assert.equal((await traderApi.login(trader)).status, 200);
  assert.deepEqual(page.errors, []);
  assert.deepEqual(tp.errors, []);
});

test('moderation: report a post from its ⋯ menu → moderator hides it → gone from the feed; posting ban; verified badge', async () => {
  const tp = traderPage;
  await tp.goto(BASE + '/social');
  const post = tp.locator('[data-testid=post]', { hasText: 'Second reading is scheduled' });
  await post.waitFor();
  const pid = await post.getAttribute('data-post');
  await post.locator('[data-testid=post-menu]').click();
  await tp.click('[data-testid=report-post]');
  await tp.locator('[data-testid=report-dialog]').waitFor();
  await tp.fill('[data-testid=report-details]', 'Reads like an ad');
  await tp.click('[data-testid=report-submit]');
  await until(() => dbq("SELECT COUNT(*) c FROM mod_reports WHERE content_id=? AND status='open'", pid)[0].c === 1);

  const mc = client();
  await mc.signup(moder);
  assert.equal((await admin.call('PUT', `/v1/admin/roles/${uidOf(moder.email)}`, { roles: ['moderator'] })).status, 200);
  const mp = await newPage();
  await logIn(mp, moder);
  await mp.goto(BASE + '/admin');
  await mp.waitForURL(/\/admin\/moderation$/);
  const row = mp.locator(`[data-testid=mod-reports] [data-content="${pid}"]`);
  await row.waitFor();
  assert.match(await row.textContent(), /Reads like an ad/);
  await row.locator('[data-act=hide]').click();
  await until(() => dbq("SELECT COUNT(*) c FROM mod_hidden WHERE kind='post' AND content_id=?", pid)[0].c === 1);
  assert.equal(dbq('SELECT status FROM mod_reports WHERE content_id=?', pid)[0].status, 'actioned');
  await tp.goto(BASE + '/social');
  await tp.locator('[data-testid=post]').first().waitFor();
  assert.equal(await tp.locator('[data-testid=post]', { hasText: 'Second reading is scheduled' }).count(), 0);
  assert.ok(!(await (await fetch(`${BASE}/v1/social/posts`)).json()).posts.some((p) => p.id === pid));
  assert.equal((await fetch(`${BASE}/v1/social/posts/${pid}`)).status, 404);
  // The moderator cannot reach other sections.
  await mc.login(moder);
  assert.equal((await mc.call('GET', '/v1/admin/users')).status, 403);

  // Ban @harborwatch from posting; verify @maple_quant.
  await mp.goto(BASE + '/admin/moderation/profiles');
  const hw = mp.locator('[data-testid=mod-profiles] [data-nick=harborwatch]');
  await hw.waitFor();
  await hw.locator('[data-a=ban]').click();
  await confirm(mp, 'Repeated promotional posts');
  await mp.locator('[data-testid=mod-profiles] [data-nick=harborwatch] [data-a=unban]').waitFor();
  const hc = client();
  await hc.login({ email: 'harborwatch@parlance.local', password: 'parlance-demo' });
  const blocked = await hc.call('POST', `/v1/users/${uidOf('harborwatch@parlance.local')}/social/posts`, { body: 'Buy my newsletter' });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'posting_banned');
  await mp.locator('[data-testid=mod-profiles] [data-nick=maple_quant] [data-a=verify]').click();
  await mp.locator('[data-testid=mod-profiles] [data-nick=maple_quant] [data-a=unverify]').waitFor();
  await tp.goto(BASE + '/social');
  const mq = tp.locator('[data-testid=post]', { hasText: 'Cut is still the base case' });
  await mq.locator('[data-testid=verified-badge]').waitFor();
  assert.deepEqual(mp.errors, []);
  assert.deepEqual(tp.errors, []);
  await mp.context().close();
});

test('announcements reach a signed-in user live and are stored', async () => {
  const tp = traderPage;
  await tp.goto(BASE + '/');
  await tp.locator('[data-testid=hero-title]').waitFor();
  await sleep(500); // websocket subscribed
  const page = adminPage;
  await page.goto(BASE + '/admin/announcements');
  await fillForm(page.locator('[data-testid=ann-form]'), { segment: 'all', title: 'Exchange update: new science markets', body: 'Robot officiating markets are live.', link: '/category/science-and-technology' });
  await page.click('[data-testid=ann-form] button[type=submit]');
  await confirm(page);
  await page.locator('[data-testid=ann-history] tbody tr', { hasText: 'Exchange update: new science markets' }).waitFor();
  await tp.locator('.toast', { hasText: 'Exchange update: new science markets' }).waitFor();
  await tp.locator('[data-testid=unread-count]').waitFor();
  const n = dbq("SELECT title, link FROM notifications WHERE user_id=? AND type='announcement'", uidOf(trader.email));
  assert.deepEqual(n.map((r) => ({ ...r })), [{ title: 'Exchange update: new science markets', link: '/category/science-and-technology' }]);
  const nonSystem = dbq('SELECT COUNT(*) c FROM users WHERE is_system=0')[0].c;
  assert.equal(dbq("SELECT recipients FROM ann_announcements WHERE title='Exchange update: new science markets'")[0].recipients, nonSystem);
  assert.deepEqual(tp.errors, []);
});

test('reports dashboard numbers match the database / public API and the CSV downloads', async () => {
  // Expected totals from the public market API (same serializers) and money columns.
  let vol = 0; let cursor = '';
  do {
    const r = await (await fetch(`${BASE}/trade-api/v2/markets?limit=1000${cursor ? `&cursor=${cursor}` : ''}`)).json();
    for (const m of r.markets) vol += Math.round(Number(m.volume_fp) * 100);
    cursor = r.cursor;
  } while (cursor);
  const fees = dbq('SELECT COALESCE(SUM(fee_cents),0) c FROM fills')[0].c;
  const deps = dbq("SELECT COALESCE(SUM(amount_cents),0) c FROM ledger WHERE kind='deposit'")[0].c;
  const signups = dbq('SELECT COUNT(*) c FROM users WHERE is_system=0')[0].c;
  const active = dbq('SELECT COUNT(DISTINCT f.user_id) c FROM fills f JOIN users u ON u.id=f.user_id WHERE u.is_system=0')[0].c;
  const page = adminPage;
  await page.goto(BASE + '/admin/reports');
  await page.locator('[data-testid=report-totals]').waitFor();
  const num = async (k) => Number((await page.locator(`[data-testid=metric-${k}]`).textContent()).replace(/[$,]/g, ''));
  assert.equal(Math.round((await num('volume_fp')) * 100), vol);
  assert.equal(Math.round((await num('fees_dollars')) * 100), fees);
  assert.ok(fees > 0, 'test trades paid taker fees');
  assert.equal(Math.round((await num('deposits_dollars')) * 100), deps);
  assert.equal(await num('signups'), signups);
  assert.equal(await num('active_users'), active);
  assert.ok(await page.locator('.adm-chart svg').count() >= 6);
  assert.ok(await page.locator('[data-testid=report-top] tbody tr').count() >= 1);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid=report-csv]')]);
  const lines = fs.readFileSync(await dl.path(), 'utf8').trim().split('\n');
  assert.equal(lines[0], 'day,trades,volume_fp,volume_dollars,fees_dollars,deposits_dollars,withdrawals_dollars,active_users,signups');
  const total = lines.at(-1).split(',');
  assert.equal(total[0], 'total');
  assert.equal(Math.round(Number(total[2]) * 100), vol);
  assert.equal(Math.round(Number(total[4]) * 100), fees);
  assert.equal(lines.length, 32); // header + 30 days + total
  assert.deepEqual(page.errors, []);
});

test('settings: APY change is persisted and used by the next accrual; feature switch hides Social; health page', async () => {
  const page = adminPage;
  await page.goto(BASE + '/admin/settings');
  await page.locator('[data-testid=settings-form]').waitFor();
  await page.fill('[data-testid=settings-form] [name=interest_apy_pct]', '5');
  await page.click('[data-testid=settings-form] button[type=submit]');
  await until(() => dbq("SELECT value FROM meta WHERE key='setting_interest_apy'")[0]?.value === '0.05');
  const tid = uidOf(trader.email);
  assert.equal((await traderApi.call('GET', `/v1/users/${tid}/interest`)).body.apy, '0.05');
  // Make the trader eligible for today's accrual (accounts earn from the day after sign-up).
  dbrun("UPDATE users SET created_at=? WHERE id=?", new Date(Date.now() - 2 * 86400000).toISOString(), tid);
  dbrun('DELETE FROM interest_accruals WHERE user_id=?', tid);
  const acc = await until(() => dbq('SELECT base_cents, amount_cents FROM interest_accruals WHERE user_id=?', tid)[0]);
  assert.equal(acc.amount_cents, Math.round((acc.base_cents * 0.05) / 365));
  if (acc.amount_cents > 0) assert.match(dbq("SELECT memo FROM ledger WHERE user_id=? AND kind='interest'", tid)[0].memo, /5\.0% APY/);

  // Feature switch: Social off → route gated and server rejects posting; then back on.
  await page.locator('[data-testid=settings-form] [name=social]').uncheck();
  await page.click('[data-testid=settings-form] button[type=submit]');
  await until(() => JSON.parse(dbq("SELECT value FROM admin_settings WHERE key='features'")[0]?.value || '{}').social === false);
  const p = await newPage();
  await p.goto(BASE + '/social');
  await p.locator('[data-testid=feature-off]').waitFor();
  const hc = client(); await hc.login({ email: 'maple_quant@parlance.local', password: 'parlance-demo' });
  assert.equal((await hc.call('POST', `/v1/users/${uidOf('maple_quant@parlance.local')}/social/posts`, { body: 'hello' })).body.error.code, 'feature_disabled');
  await page.locator('[data-testid=settings-form] [name=social]').check();
  await page.click('[data-testid=settings-form] button[type=submit]');
  await until(() => JSON.parse(dbq("SELECT value FROM admin_settings WHERE key='features'")[0].value).social === true);
  await p.goto(BASE + '/social');
  await p.locator('[data-testid=post]').first().waitFor();
  // Health + rate limit view.
  await page.goto(BASE + '/admin/settings');
  await page.locator('[data-testid=health]').waitFor();
  assert.match(await page.locator('[data-testid=health-db]').textContent(), /MB/);
  assert.ok(Number(await page.locator('[data-testid=health-ws]').textContent()) >= 1);
  assert.match(await page.locator('[data-testid=rate-limit]').textContent(), /300 burst/);
  assert.deepEqual(page.errors, []);
  assert.deepEqual(p.errors, []);
  await p.context().close();
});

test('market + perps ops: exchange switch, pause/resume, liquidity bot re-quote, fee multiplier, combo eligibility, halt/leverage/funding', async () => {
  const page = adminPage;
  const tid = uidOf(trader.email);
  const order = (ticker) => traderApi.call('POST', `/v1/users/${tid}/orders`, { ticker, side: 'yes', action: 'buy', type: 'limit', price: 5, count: 1 });
  await page.goto(BASE + '/admin/ops');
  await page.locator('[data-testid=exchange-toggle]').click();
  await confirm(page, 'Incident drill');
  await page.locator('[data-testid=exchange-state]', { hasText: 'Trading paused' }).waitFor();
  assert.equal((await order('PLXCOIN-26DEC-T5')).body.error.code, 'trading_paused');
  await page.locator('[data-testid=exchange-toggle]').click();
  await confirm(page, 'Drill over');
  await page.locator('[data-testid=exchange-state]', { hasText: 'Trading on' }).waitFor();
  assert.equal((await order('PLXCOIN-26DEC-T5')).status, 201);
  // Pause / resume one market.
  const row = page.locator('[data-testid=ops-markets] [data-row="PLXCOIN-26DEC-T5"]');
  await page.fill('[data-testid=ops-markets] [data-filter]', 'PLXCOIN');
  await row.locator('button', { hasText: 'Pause' }).click();
  await confirm(page, 'Index provider outage');
  await row.locator('button', { hasText: 'Resume' }).waitFor();
  assert.equal(dbq("SELECT status FROM markets WHERE ticker='PLXCOIN-26DEC-T5'")[0].status, 'inactive');
  assert.equal((await order('PLXCOIN-26DEC-T5')).body.error.code, 'market_inactive');
  await row.locator('button', { hasText: 'Resume' }).click();
  await confirm(page, 'Provider back');
  await row.locator('button', { hasText: 'Pause' }).waitFor();
  assert.equal(dbq("SELECT status FROM markets WHERE ticker='PLXCOIN-26DEC-T5'")[0].status, 'active');
  // Liquidity bot: 3 levels per side → 6 resting liquidity orders after the re-quote.
  await row.locator('button', { hasText: 'Liquidity' }).click();
  await fillForm(page.locator('dialog[open]'), { enabled: true, spread_cents: 6, size_contracts: 50, levels: 3 });
  await submitDialog(page);
  const lp = uidOf('liquidity@parlance.local');
  await until(() => dbq("SELECT COUNT(*) c FROM orders WHERE user_id=? AND market_ticker='PLXCOIN-26DEC-T5' AND status='resting'", lp)[0].c === 6);
  const ob = (await (await fetch(`${BASE}/trade-api/v2/markets/PLXCOIN-26DEC-T5/orderbook`)).json()).orderbook_fp;
  assert.ok(ob.yes_dollars.some(([, q]) => q === '50.00') && ob.no_dollars.some(([, q]) => q === '50.00'));
  // Series fee multiplier.
  await page.locator('[data-testid=ops-series] [data-fee=PLXCOIN]').click();
  await fillForm(page.locator('dialog[open]'), { fee_multiplier: 2, reason: 'Promo ended' });
  await submitDialog(page);
  assert.equal(dbq("SELECT fee_multiplier FROM series WHERE ticker='PLXCOIN'")[0].fee_multiplier, 2);
  // Combo eligibility: excluded markets cannot be legs.
  await row.locator('[data-combo]').uncheck();
  await until(() => dbq("SELECT combo_eligible FROM ops_market_flags WHERE market_ticker='PLXCOIN-26DEC-T5'")[0]?.combo_eligible === 0);
  const combo = await traderApi.call('POST', '/v1/multivariate_event_collections/PLXCOMBO/markets', { selected_markets: [{ market_ticker: 'PLXCOIN-26DEC-T5', side: 'yes' }, { market_ticker: 'PLXRATE-26DEC-CUT', side: 'yes' }] });
  assert.equal(combo.status, 400);
  assert.equal(combo.body.error.code, 'invalid_leg');
  const coll = (await (await fetch(`${BASE}/v1/multivariate_event_collections/PLXCOMBO`)).json()).multivariate_contract;
  assert.ok(!coll.events.some((e) => e.markets.some((m) => m.ticker === 'PLXCOIN-26DEC-T5')));
  await row.locator('[data-combo]').check();
  await until(() => dbq("SELECT combo_eligible FROM ops_market_flags WHERE market_ticker='PLXCOIN-26DEC-T5'")[0].combo_eligible === 1);
  // Perps: halt, leverage, funding run, resume.
  await page.goto(BASE + '/admin/perps');
  const pr = page.locator('[data-testid=perps-ops] [data-row=PLXSOLPERP]');
  await pr.locator('button', { hasText: 'Halt' }).click();
  await confirm(page, 'Index feed stale');
  await pr.locator('button', { hasText: 'Resume' }).waitFor();
  assert.equal(dbq("SELECT status FROM perp_markets WHERE ticker='PLXSOLPERP'")[0].status, 'halted');
  await pr.locator('button', { hasText: 'Leverage' }).click();
  await fillForm(page.locator('dialog[open]'), { max_leverage: 4, reason: 'Volatility' });
  await submitDialog(page);
  assert.equal(dbq("SELECT max_leverage FROM perp_markets WHERE ticker='PLXSOLPERP'")[0].max_leverage, 4);
  await pr.locator('button', { hasText: 'Resume' }).click();
  await pr.locator('button', { hasText: 'Halt' }).waitFor();
  const fundingBefore = dbq("SELECT COUNT(*) c FROM perp_funding_rates WHERE ticker='PLXSOLPERP'")[0].c;
  await pr.locator('button', { hasText: 'Run funding' }).click();
  await confirm(page);
  await until(() => dbq("SELECT COUNT(*) c FROM perp_funding_rates WHERE ticker='PLXSOLPERP'")[0].c === fundingBefore + 1);
  assert.deepEqual(page.errors, []);
});

test('audit log records every admin mutation with before/after and filters by action', async () => {
  const page = adminPage;
  await page.goto(BASE + '/admin/audit');
  await page.locator('[data-testid=audit-log] tbody tr').first().waitFor();
  const actions = new Set(dbq('SELECT action FROM admin_audit').map((r) => r.action));
  for (const a of ['catalog.series.create', 'catalog.events.publish', 'catalog.import', 'roles.set', 'catalog.event.update', 'resolution.close_early', 'resolution.resolve', 'resolution.reverse',
    'content.hero.set', 'content.promos.create', 'content.banners.create', 'content.nav.set', 'content.news.create', 'content.help.create', 'users.adjust_balance', 'users.lock', 'users.unlock',
    'moderation.hide', 'moderation.ban', 'moderation.verify', 'announcements.send', 'settings.update',
    'ops.exchange', 'ops.market.pause', 'ops.market.resume', 'ops.market.liquidity', 'ops.series.fee', 'ops.market.combo', 'perps.halt', 'perps.leverage', 'perps.resume', 'perps.funding']) assert.ok(actions.has(a), `audit has ${a}`);
  const adj = dbq("SELECT * FROM admin_audit WHERE action='users.adjust_balance'")[0];
  assert.equal(adj.actor_email, ADMIN.email);
  assert.equal(adj.reason, 'Goodwill credit for the outage');
  assert.ok(JSON.parse(adj.before_json).balance_dollars && JSON.parse(adj.after_json).amount_dollars === '25.0000');
  const shown = await page.locator('[data-testid=audit-log] tbody tr').count();
  assert.ok(shown >= 20);
  await page.fill('[data-testid=audit-filters] [name=action]', 'users.');
  await page.click('[data-testid=audit-filters] button[type=submit]');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=audit-log] tbody tr')].every((tr) => (tr.dataset.action || '').startsWith('users.')));
  assert.equal(await page.locator('[data-testid=audit-log] tbody tr').count(), dbq("SELECT COUNT(*) c FROM admin_audit WHERE action LIKE 'users.%'")[0].c);
  assert.deepEqual(page.errors, []);
});

test('mobile 390px: admin and CMS-driven pages have no horizontal overflow in dark and light themes', async () => {
  const page = await newPage({ width: 390, height: 844 });
  const overflows = [];
  await logIn(page, ADMIN);
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; localStorage.setItem('parlance-theme', t); }, theme);
    for (const p of ['/admin/catalog/events', '/admin/resolution', '/admin/content/nav', '/admin/ops', '/admin/users', `/admin/users/${uidOf(trader.email)}`, '/admin/moderation', '/admin/reports', '/admin/roles', '/admin/audit', '/admin/settings', '/', '/help/fees']) {
      await page.goto(BASE + p);
      await page.waitForSelector(p.startsWith('/admin') ? '.adm-head' : '#view > *');
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
      await sleep(250);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (over > 0) overflows.push(`${p} (${theme}) overflows by ${over}px`);
    }
  }
  assert.deepEqual(overflows, []);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
