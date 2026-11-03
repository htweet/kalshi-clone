'use strict';
// Account area E2E (PLAN A3–A6, A12; CLONE_SPEC §13.16, §13.19; CLONE_SPEC.md §25.7–§25.10): the /account/* frame with
// the right-hand card nav, the ☰ menu (observed items, placeholders for later phases), trophy and category index; Your
// activity (chips, CSV, empty state); Documents (/account/taxes: yearly P&L, transactions CSV, simulated statements as CSV
// and PDF, "not tax advice"); Settings in the observed order, each setting persisted and applied app-wide; marketing-text
// consent records; connected apps; promo codes (admin-created, single use, ledger credit) and the new-user checklist;
// restart persistence; 390 px layout; no page errors or CSP violations. Invented data only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { start } = require('../server/index.js');
const { Client } = require('./lib/client');
const H = require('./lib/identity-helpers');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-account-'));
const DB_FILE = path.join(TMP, 'account.db');
const PW = 'Copper-Meadow-Lantern-5530';
const ADMIN = { email: 'root.account@example.test', password: 'Ledger-Keeper-2026!' };
const stamp = Date.now();
const HIGH = { burst: 1e6, per_second: 1e6 };
let PORT; let BASE; let OPTS; let srv; let browser;
const D = H.db(DB_FILE);
const email = (k) => `${k}.${stamp}@example.test`;

before(async () => {
  PORT = await H.freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  OPTS = { port: PORT, dbFile: DB_FILE, tickMs: 400, quiet: true, admin: ADMIN, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH },
    auth: { stepUpMs: 60000 }, identity: { kycRequired: false, kyc: { delayMs: 200, pollMs: 100 }, settings: { sms: { per_ip_hour: 1000, per_account_day: 50, per_number_hour: 50 } } } };
  srv = await start(OPTS);
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

async function user(k, viewport) {
  const page = await H.newPage(browser, BASE, { viewport });
  await H.signUpUi(page, BASE, { name: `Acct ${k}`, email: email(k) }, PW);
  await page.waitForSelector('[data-testid=account-menu]');
  const api = await new Client(BASE, k).logIn(email(k), PW);
  return { page, api, uid: api.uid };
}
const prop = (uid, key) => { const r = D.q('SELECT value FROM user_settings WHERE user_id=? AND key=?', uid, key)[0]; return r ? JSON.parse(r.value) : undefined; };
const activeMarket = () => D.q("SELECT m.ticker, m.event_ticker FROM markets m JOIN events e ON e.ticker=m.event_ticker WHERE m.status='active' AND m.mve_collection_ticker IS NULL AND e.series_ticker NOT LIKE 'PLXFLASH%' AND m.fractional_trading_enabled=0 ORDER BY m.rowid LIMIT 1")[0];

test('frame, ☰ menu, trophy and category index; placeholder pages; earlier account sections inside the frame; 390 px', async () => {
  const { page } = await user('frame');
  // Header: trophy (leaderboard) and the ☰ menu with the observed items in order.
  assert.equal(await page.getAttribute('[data-testid=trophy]', 'href'), '/social/leaderboard');
  await page.click('[data-testid=account-menu]');
  const items = await page.locator('.hamburger-menu > a, .hamburger-menu .menu-round a').allTextContents();
  const labels = items.map((t) => t.trim());
  for (const l of ['Leaderboard', 'Rewards', 'Account & security', 'Your activity', 'Invest', 'Liquidity Rewards', 'Documents', 'API Docs', 'Settings']) assert.ok(labels.includes(l), `menu has ${l}`);
  assert.ok(labels.indexOf('Account & security') < labels.indexOf('Your activity') && labels.indexOf('Your activity') < labels.indexOf('Invest') && labels.indexOf('Documents') < labels.indexOf('API Docs') && labels.indexOf('API Docs') < labels.indexOf('Settings'), 'observed order');
  for (const g of ['trust', 'research', 'support']) assert.ok(await page.locator(`[data-testid=menu-group-${g}]`).isVisible());
  assert.equal((await page.textContent('[data-testid=menu-group-trust] summary')).trim(), 'Trust');
  assert.ok(await page.locator('[data-testid=menu-promo]:has-text("Enter promo code")').isVisible());
  assert.ok(await page.locator('[data-testid=menu-logout]:has-text("Log out")').isVisible());
  // A later-phase destination opens a clear placeholder.
  await page.click('[data-testid=menu-api-docs]');
  await page.waitForSelector('[data-testid=placeholder-page][data-page=docs]');
  assert.match(await page.textContent('[data-testid=placeholder-page]'), /Phase 7/);
  await page.click('[data-testid=account-menu]');
  await page.click('[data-testid=menu-group-support] summary');
  await page.click('[data-testid=menu-group-support] a:has-text("Fee schedule")');
  await page.waitForSelector('[data-testid=placeholder-page][data-page="support/fees"]');
  // Category index (list icon at the start of the category strip).
  await page.click('[data-testid=category-index-btn]');
  await page.waitForSelector('[data-testid=category-index] .cat-index-head');
  assert.ok((await page.locator('[data-testid=category-index] .cat-index-head').count()) >= 8);
  await page.click('[data-testid=category-index] .cat-index-head >> nth=0');
  await page.waitForURL(/\/category\//);
  // Frame: content left, right-hand card nav with four items; the earlier sections are sub-tabs of Account & security.
  await page.click('[data-testid=account-menu]');
  await page.click('[data-testid=menu-account]');
  await page.waitForSelector('[data-testid=account-frame][data-section=security]');
  assert.deepEqual((await page.locator('[data-testid=account-nav] a').allTextContents()).map((t) => t.trim()), ['Account & security', 'Your activity', 'Documents', 'Settings']);
  const box = async (sel) => page.locator(sel).boundingBox();
  assert.ok((await box('[data-testid=account-nav]')).x > (await box('.acct-main')).x, 'card nav on the right');
  for (const sub of ['privacy', 'profile', 'limits', 'alerts']) {
    await page.click(`[data-testid=account-subnav] [data-sub=${sub}]`);
    await page.waitForSelector(`[data-testid=account-frame][data-section=${sub}]`);
    assert.equal(await page.getAttribute('[data-testid=account-nav] a.on', 'data-nav-item'), 'security');
  }
  await page.goto(BASE + '/account/appearance');
  await page.waitForURL(BASE + '/account/settings');
  await page.waitForSelector('[data-testid=settings]');
  // 390 px: frame, menu and every account page without horizontal scrolling.
  await page.setViewportSize({ width: 390, height: 844 });
  for (const p of ['/account', '/account/activity', '/account/taxes', '/account/settings', '/account/privacy', '/rewards']) {
    await page.goto(BASE + p);
    await page.waitForSelector('[data-testid=account-frame], [data-testid=checklist]');
    await page.waitForLoadState('networkidle');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${p}: no horizontal scroll at 390 px`);
  }
  await page.click('[data-testid=account-menu]');
  assert.ok(await page.evaluate(() => { const m = document.querySelector('.hamburger-menu').getBoundingClientRect(); return m.left >= 0 && m.right <= window.innerWidth; }), 'menu fits the phone screen');
  await H.assertClean(assert, page);
  await page.context().close();
});

test('Your activity: chips filter the timeline, CSV follows the chip, empty state, the chosen chip persists', async () => {
  const { page, api, uid } = await user('activity');
  assert.equal((await api.call('POST', `/v1/users/${uid}/deposits`, { amount_dollars: 300 })).status, 201);
  assert.equal((await api.call('POST', '/v1/step_up', { password: PW })).status, 200);
  assert.equal((await api.call('POST', `/v1/users/${uid}/withdrawals`, { amount_dollars: 40 })).status, 201);
  const mk = activeMarket();
  assert.equal((await api.call('POST', `/v1/users/${uid}/orders`, { ticker: mk.ticker, side: 'yes', type: 'market', count: 2 })).status, 201);
  await page.goto(BASE + '/account/activity');
  await page.waitForSelector('[data-testid=activity-table]');
  assert.deepEqual((await page.locator('[data-testid=activity-chips] .chip').allTextContents()).map((t) => t.trim()), ['All', 'Deposit', 'Withdrawal', 'Order', 'Trade', 'Settlement', 'Credit']);
  const types = async () => [...new Set(await page.locator('[data-testid=activity-row]').evaluateAll((rows) => rows.map((r) => r.dataset.type)))].sort();
  assert.deepEqual(await types(), ['deposit', 'fill', 'order', 'withdrawal'].filter((t) => true).sort());
  for (const [chip, want] of [['deposit', ['deposit']], ['withdrawal', ['withdrawal']], ['order', ['order']], ['trade', ['fill']]]) {
    await page.click(`[data-chip=${chip}]`);
    await page.waitForFunction((w) => { const r = [...document.querySelectorAll('[data-testid=activity-row]')]; return r.length && r.every((x) => w.includes(x.dataset.type)); }, want);
  }
  await page.click('[data-chip=settlement]');
  await page.waitForSelector('[data-testid=activity-empty]:has-text("No activity with these filters")');
  await page.click('[data-chip=deposit]');
  await page.waitForSelector('[data-testid=activity-row][data-type=deposit]');
  assert.match(await page.getAttribute('[data-testid=activity-download]', 'href'), /activity\.csv\?type=deposit$/);
  const dl = page.waitForEvent('download');
  await page.click('[data-testid=activity-download]');
  const csv = fs.readFileSync(await (await dl).path(), 'utf8');
  assert.match(csv.split('\n')[0], /^time,type,market,description/);
  assert.ok(csv.includes(',deposit,') && !csv.includes(',withdrawal,'), 'CSV follows the chip');
  await H.until(() => prop(uid, 'activity_filter') === 'deposit');
  await page.reload();
  await page.waitForSelector('[data-chip=deposit].on');
  await H.assertClean(assert, page);
  await page.context().close();
});

test('Documents (/account/taxes): yearly P&L with and without fees, transactions CSV, simulated statements (CSV + PDF), not tax advice', async () => {
  const { page, api, uid } = await user('docs');
  assert.equal((await api.call('POST', `/v1/users/${uid}/deposits`, { amount_dollars: 100 })).status, 201);
  const mk = activeMarket();
  assert.equal((await api.call('POST', `/v1/users/${uid}/orders`, { ticker: mk.ticker, side: 'yes', type: 'market', count: 3 })).status, 201);
  assert.equal((await api.call('POST', `/v1/users/${uid}/orders`, { ticker: mk.ticker, side: 'yes', action: 'sell', type: 'market', count: 3 })).status, 201);
  const year = new Date().getUTCFullYear();
  const docs = (await api.call('GET', `/v1/users/${uid}/tax_documents`)).body;
  const y = docs.years.find((x) => x.year === year);
  const fees = D.q('SELECT COALESCE(SUM(fee_cents),0) f FROM fills WHERE user_id=?', uid)[0].f;
  assert.equal(Math.round((Number(y.pnl_without_fees_dollars) - Number(y.pnl_with_fees_dollars)) * 100), fees, 'with fees = without fees − fees');
  assert.equal(Math.round(Number(y.fees_dollars) * 100), fees);
  // Round trip bought and sold: realized P&L equals the cash effect of the trades.
  const cashEffect = D.q('SELECT balance_cents FROM users WHERE id=?', uid)[0].balance_cents - 10000;
  assert.equal(Math.round(Number(y.pnl_with_fees_dollars) * 100), cashEffect, 'equals the cash effect of the closed round trip');
  assert.equal(Math.round(Number(y.pnl_with_fees_dollars) * 100), D.q('SELECT SUM(realized_pnl_cents) c FROM positions WHERE user_id=?', uid)[0].c, 'and the engine’s realized P&L');
  await page.goto(BASE + '/account/taxes');
  await page.waitForSelector(`[data-testid=pnl-table] tr[data-year="${year}"]`);
  assert.deepEqual((await page.locator('[data-testid=pnl-table] th').allTextContents()).map((t) => t.trim()), ['Year', 'PnL with fees', 'PnL without fees', 'Transactions']);
  assert.match(await page.textContent('[data-testid=documents-intro]'), /not tax advice/);
  assert.match(await page.textContent('[data-testid=not-tax-advice]'), /not tax advice/i);
  let dl = page.waitForEvent('download');
  await page.click(`[data-testid=pnl-table] tr[data-year="${year}"] [data-testid=transactions-download]`);
  const csv = fs.readFileSync(await (await dl).path(), 'utf8');
  assert.match(csv, /^time,type,amount_usd,reference,memo/); assert.ok(csv.includes(',deposit,100.00,'));
  dl = page.waitForEvent('download');
  await page.click(`[data-testid=statement-list] li[data-year="${year}"] [data-form=PNL] [data-testid=statement-pdf]`);
  const pdf = fs.readFileSync(await (await dl).path());
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-'); assert.ok(pdf.includes(Buffer.from('NOT TAX ADVICE'))); assert.ok(pdf.includes(Buffer.from('%%EOF')));
  const xref = Number(/startxref\n(\d+)/.exec(pdf.toString('latin1'))[1]);
  assert.equal(pdf.subarray(xref, xref + 4).toString(), 'xref', 'cross-reference offset is exact');
  const stmt = await api.call('GET', `/v1/users/${uid}/tax_documents/${year}/PNL.csv`);
  assert.match(stmt.text, /Realized P&L with fees/); assert.match(stmt.text, /not tax advice/);
  // Another user cannot read these statements.
  const other = await new Client(BASE, 'docs-other').signUp(email('docs-other'), PW, 'Oth Er');
  assert.equal((await other.call('GET', `/v1/users/${uid}/tax_documents/${year}/PNL.pdf`)).status, 403);
  await H.assertClean(assert, page);
  await page.context().close();
});

test('Settings: observed order; every setting persisted and applied app-wide; consent recorded; connected apps; notifications module mounted', async () => {
  const { page, api, uid } = await user('settings');
  await page.goto(BASE + '/account/settings');
  await page.waitForSelector('[data-testid=settings]');
  // Notifications: the Phase 2 module (or its placeholder) is mounted after Connected apps.
  await page.waitForSelector('[data-testid=set-notifications] h2');
  const order = await page.locator('[data-testid=settings] > section h2').allTextContents();
  assert.deepEqual(order.map((t) => t.replace('ⓘ', '').trim()), ['Browse and manage markets by', 'Connected apps', 'Notifications', 'Marketing text messages', 'Security notifications', 'Theme', 'Trade mechanics', 'Market preview price type']);

  // 1. Display mode: live preview, then the home page cards switch to share prices.
  assert.ok(await page.locator('[data-testid=display-preview] .mult').count() > 0, 'payout preview shows the multiplier');
  await page.check('[data-testid=display_mode-shares]');
  await page.waitForSelector('[data-testid=display-preview] [data-testid=share-prices]');
  await H.until(() => prop(uid, 'display_mode') === 'shares');
  await page.goto(BASE + '/');
  await page.waitForSelector('#top-markets [data-testid=share-prices]');
  assert.equal(await page.locator('#top-markets .mcard .odds.pill').count(), 0);

  // 2. Connected apps: empty state, then an authorized app (issued by Phase 7's API; inserted here) can be removed.
  await page.goto(BASE + '/account/settings');
  await page.waitForSelector('[data-testid=connected-apps-empty]');
  D.run("INSERT INTO oauth_grants(id,user_id,client_id,client_name,scopes,created_at) VALUES('grant_test1',?,'client_test','Sample Portfolio Tracker','[\"read\"]',?)", uid, new Date().toISOString());
  await page.reload();
  await page.waitForSelector('[data-testid=connected-app]:has-text("Sample Portfolio Tracker")');
  await page.click('[data-testid=app-revoke]');
  await page.waitForSelector('[data-testid=connected-apps-empty]');
  assert.ok(D.q("SELECT revoked_at FROM oauth_grants WHERE id='grant_test1'")[0].revoked_at);

  // 4. Marketing texts: needs a verified phone; the box must be ticked; consent and revocation are recorded.
  await page.click('[data-testid=consent-agree]');
  await page.click('[data-testid=consent-optin]');
  await page.waitForSelector('[data-testid=consent-error]:has-text("mobile number")');
  assert.equal((await H.apiOnboard(BASE, api, H.person())).status, 'approved');
  await page.reload();
  await page.waitForSelector('[data-testid=sms-disclosure]');
  assert.match(await page.textContent('[data-testid=sms-disclosure]'), /not a condition of any purchase[\s\S]*STOP[\s\S]*HELP/);
  await page.click('[data-testid=consent-optin]');
  await page.waitForSelector('[data-testid=consent-error]:has-text("Tick the box")');
  await page.click('[data-testid=consent-agree]');
  await page.click('[data-testid=consent-optin]');
  await page.waitForSelector('[data-testid=consent-status][data-status=opted_in]');
  const version = await page.getAttribute('[data-testid=sms-disclosure]', 'data-version');
  let rows = D.q('SELECT * FROM marketing_consents WHERE user_id=? ORDER BY created_ts', uid);
  assert.equal(rows.length, 1); assert.equal(rows[0].action, 'opt_in'); assert.equal(rows[0].text_version, version); assert.match(rows[0].text_sha256, /^[0-9a-f]{64}$/); assert.ok(rows[0].created_ts > 0);
  await page.click('[data-testid=consent-optout]');
  await page.waitForSelector('[data-testid=consent-status][data-status=opted_out]');
  rows = D.q('SELECT action FROM marketing_consents WHERE user_id=? ORDER BY created_ts, rowid', uid);
  assert.deepEqual(rows.map((r) => r.action), ['opt_in', 'opt_out'], 'revocation recorded; history append-only');

  // 5. Security notifications: the toggle comes from the notification-preferences module (Phase 2) in position 5 and
  // its change is saved server-side.
  const sec = page.locator('[data-testid=set-security-notifications] input[type=checkbox]');
  await sec.waitFor();
  await H.until(async () => !(await sec.isDisabled()));
  const was = await sec.isChecked();
  await sec.click();
  await H.until(async () => (await api.call('GET', `/v1/users/${uid}/notifications/preferences`)).body.security_notifications === !was);

  // 6. Theme System / Light / Dark and Accessible colors, applied to the whole page.
  await page.emulateMedia({ colorScheme: 'light' });
  await page.check('[data-testid=theme-system]');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light' && document.documentElement.dataset.themePref === 'system');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark', null, { timeout: 5000 });
  await page.check('[data-testid=theme-light]');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light' && document.documentElement.dataset.themePref === 'light');
  const yes0 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--yes').trim());
  await page.click('[data-testid=toggle-accessible_colors]');
  await page.waitForFunction(() => document.documentElement.dataset.palette === 'accessible');
  const yes1 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--yes').trim());
  assert.notEqual(yes1, yes0); assert.equal(yes1, '#1e5fd8', 'red-green safe Yes colour (light)');

  // 7. Trade mechanics: live since Phase 5A (no "takes effect in Phase 5" tags), RFQ opt-in is the existing rfq_enabled setting.
  assert.equal(await page.locator('[data-testid=set-trade-mechanics] [data-testid=phase5-tag]').count(), 0);
  for (const k of ['trade_flip_sell', 'trade_auto_sell_prompt', 'trade_skip_review', 'rfq_enabled']) await page.click(`[data-testid=toggle-${k}]`);
  await page.click('[data-testid=toggle-trade_collateral_return]'); // default on → off
  await H.until(() => prop(uid, 'rfq_enabled') === true && prop(uid, 'trade_collateral_return') === false);
  assert.deepEqual(['trade_flip_sell', 'trade_auto_sell_prompt', 'trade_skip_review'].map((k) => prop(uid, k)), [true, true, true]);
  const rfq = await api.call('POST', '/v1/communications/rfqs', { market_ticker: activeMarket().ticker, contracts_fp: '1' });
  assert.notEqual(rfq.body?.error?.code, 'rfq_not_enabled', 'RFQ opt-in is live');

  // 8. Market preview price type: the home cards show the current buy price; the portfolio column follows.
  await page.check('[data-testid=market_price_type-current_buy]');
  await H.until(() => prop(uid, 'market_price_type') === 'current_buy');
  await page.check('[data-testid=display_mode-payout]');
  await H.until(() => prop(uid, 'display_mode') === 'payout');
  await page.goto(BASE + '/');
  await page.waitForSelector('#top-markets .mcard .odds.pill');
  const cardCheck = await page.evaluate(async () => {
    const r = await fetch('/v1/bff/home').then((x) => x.json());
    const ev = r.home.top_markets[0];
    const card = document.querySelector(`#top-markets .mcard[data-event="${ev.event_ticker}"]`);
    const out = [];
    for (const row of card.querySelectorAll('.outcome-row')) {
      const m = ev.markets.find((x) => x.ticker === row.dataset.ticker);
      out.push({ shown: row.querySelector('.odds').textContent.trim(), ask: m.yes_ask_dollars == null ? null : `${Math.round(Number(m.yes_ask_dollars) * 100)}%` });
    }
    return out;
  });
  for (const c of cardCheck) if (c.ask) assert.equal(c.shown, c.ask, 'pill shows the current buy price');
  await api.call('POST', `/v1/users/${uid}/deposits`, { amount_dollars: 20 });
  await api.call('POST', `/v1/users/${uid}/orders`, { ticker: activeMarket().ticker, side: 'yes', type: 'market', count: 1 });
  await page.goto(BASE + '/portfolio');
  await page.waitForSelector('[data-testid=p-mark-head]:has-text("Buy now")');
  assert.equal(await page.getAttribute('[data-testid=p-mark]', 'data-price-type'), 'current_buy');
  // Strict server validation of preference values.
  const bad = await api.call('PUT', `/v1/users/${uid}/preferences`, { preferences: { theme: 'neon', display_mode: 'payout' } });
  assert.equal(bad.status, 400); assert.equal(bad.body.error.code, 'validation_failed');
  // Everything comes back in a fresh browser (DB-persisted) and is applied on load.
  await page.context().close();
  const p2 = await H.newPage(browser, BASE);
  await H.logInUi(p2, BASE, email('settings'), PW);
  await p2.waitForFunction(() => document.documentElement.dataset.theme === 'light' && document.documentElement.dataset.palette === 'accessible' && document.documentElement.dataset.pricePreview === 'current_buy');
  await p2.goto(BASE + '/account/settings');
  await p2.waitForSelector('[data-testid=settings]');
  for (const sel of ['[data-testid=theme-light]', '[data-testid=market_price_type-current_buy]', '[data-testid=display_mode-payout]', '[data-testid=toggle-accessible_colors]', '[data-testid=toggle-rfq_enabled]']) assert.equal(await p2.isChecked(sel), true, sel);
  await H.assertClean(assert, p2);
  await p2.context().close();
});

test('promo codes (admin-created, single use, ledger credit, exhaustion) and the 4-step new-user checklist; restart keeps it all', async () => {
  const admin = await H.newPage(browser, BASE);
  await H.logInUi(admin, BASE, ADMIN.email, ADMIN.password);
  await admin.waitForSelector('[data-testid=account-menu]');
  await admin.goto(BASE + '/admin/promos');
  await admin.fill('[data-testid=promo-code]', 'WELCOME-TEST5');
  await admin.fill('[data-testid=promo-amount]', '5');
  await admin.fill('[data-testid=promo-max]', '1');
  await admin.click('[data-testid=promo-create]');
  await admin.waitForSelector('[data-testid=promo-list] tr[data-promo="WELCOME-TEST5"]');
  await admin.fill('[data-testid=promo-code]', 'x');
  await admin.fill('[data-testid=promo-amount]', '5');
  await admin.click('[data-testid=promo-create]');
  await admin.waitForSelector('[data-testid=promo-error]:has-text("code")');
  assert.equal(D.q("SELECT COUNT(*) c FROM admin_audit WHERE action='promo.create'")[0].c, 1);

  const { page, api, uid } = await user('promo');
  // Checklist before: nothing done.
  await page.goto(BASE + '/rewards');
  await page.waitForSelector('[data-testid=checklist]');
  assert.equal(await page.textContent('[data-testid=checklist-progress]'), '0 of 4');
  assert.deepEqual(await page.locator('[data-testid=checklist] li').evaluateAll((l) => l.map((x) => x.dataset.step)), ['verify_identity', 'first_deposit', 'first_trade', 'complete_profile']);
  // Invalid code, then the real one through ☰ → Enter promo code; then "already used".
  await page.click('[data-testid=account-menu]');
  await page.click('[data-testid=menu-promo]');
  await page.fill('[data-testid=promo-input]', 'NOPE-0000');
  await page.click('[data-testid=promo-submit]');
  await page.waitForSelector('[data-testid=promo-error]:has-text("isn’t valid")');
  await page.fill('[data-testid=promo-input]', 'welcome-test5');
  await page.click('[data-testid=promo-submit]');
  await page.waitForSelector('.toast:has-text("Promo code applied: $5.00 credit")');
  await page.waitForSelector('[data-testid=header-balance]:has-text("$5.00")');
  const led = D.q("SELECT * FROM ledger WHERE user_id=? AND kind='credit'", uid);
  assert.equal(led.length, 1); assert.equal(led[0].amount_cents, 500); assert.match(led[0].memo, /WELCOME-TEST5/);
  let r = await api.call('POST', `/v1/users/${uid}/promo_codes`, { code: 'WELCOME-TEST5' });
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'promo_already_redeemed');
  // Max redemptions 1: a second account finds it exhausted.
  const second = await new Client(BASE, 'promo2').signUp(email('promo2'), PW, 'Pro Two');
  r = await second.call('POST', `/v1/users/${second.uid}/promo_codes`, { code: 'WELCOME-TEST5' });
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'promo_exhausted');
  assert.equal(D.q("SELECT redeemed_count FROM promo_codes WHERE code='WELCOME-TEST5'")[0].redeemed_count, 1);
  // Activity › Credit shows it.
  await page.goto(BASE + '/account/activity');
  await page.click('[data-chip=credit]');
  await page.waitForSelector('[data-testid=activity-row][data-type=credit]');
  // Finish the checklist: identity, deposit, trade, profile.
  assert.equal((await H.apiOnboard(BASE, api, H.person())).status, 'approved');
  assert.equal((await api.call('POST', `/v1/users/${uid}/deposits`, { amount_dollars: 10 })).status, 201);
  assert.equal((await api.call('POST', `/v1/users/${uid}/orders`, { ticker: activeMarket().ticker, side: 'yes', type: 'market', count: 1 })).status, 201);
  assert.equal((await api.call('POST', `/v1/users/${uid}/social/profile`, { nickname: `promo_${String(stamp).slice(-6)}` })).status, 201);
  const cl = (await api.call('GET', '/v1/rewards/new_user_checklist')).body;
  assert.equal(cl.steps.length, 4); assert.ok(cl.steps.every((s) => s.status === 'completed')); assert.equal(cl.revamp_enabled, false);
  // Restart: codes, redemptions, consent and preferences survive.
  await srv.close();
  srv = await start(OPTS);
  await page.goto(BASE + '/rewards');
  await page.waitForSelector('[data-testid=checklist-progress]:has-text("4 of 4")');
  await page.waitForSelector('[data-testid=promo-redemption]:has-text("WELCOME-TEST5")');
  r = await api.call('POST', `/v1/users/${uid}/promo_codes`, { code: 'WELCOME-TEST5' });
  assert.equal(r.body.error.code, 'promo_already_redeemed');
  await H.assertClean(assert, page); await H.assertClean(assert, admin);
  await page.context().close(); await admin.context().close();
});
