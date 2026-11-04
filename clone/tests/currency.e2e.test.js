'use strict';
// Display currency (NGN default) and admin defaults (CLONE_SPEC.md §30). Real server + SQLite file + Chromium:
//   the public descriptor (GET /v1/exchange/display_currency) and unchanged API fields;
//   NGN in the browser on home, the event ticket (Naira mode: whole-naira input, cost and payout), portfolio, /funds
//   deposit (₦ input → internal cents in the DB), perps (×100 rule), a notification (inbox + dev-mailbox email), the
//   CSV export and a document PDF;
//   kobo on a sub-cent grid (deci_cent market: ₦12.40 on the book, a ₦12.30 limit stored as 1,230 cc);
//   Admin › Settings › Currency & defaults: live preview, NGN → USD → NGN applied live over WebSocket to another open
//   page, a reason and step-up required, a hash-chained audit row, persisted across a restart;
//   new-account defaults applied to a new account and not to an existing one;
//   time zone: calendar sections are Lagos days (a close at 23:30 UTC belongs to the next Lagos day) and dates format
//   in the configured zone (the midnight edge in the preview and on the calendar).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { start } = require('../server/index.js');
const { Client } = require('./lib/client');
const H = require('./lib/identity-helpers');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-currency-'));
const DB_FILE = path.join(TMP, 'currency.db');
const PW = 'Quartz-Lantern-Meadow-7391';
const ADMIN = { email: 'root.currency@example.test', password: 'Ledger-Keeper-Copper-2026!' };
const HIGH = { burst: 1e6, per_second: 1e6 };
const stamp = Date.now();
const ADA = { name: 'Ada Naira', email: `ada.${stamp}@example.test` };
const BEA = { name: 'Bea Defaults', email: `bea.${stamp}@example.test` };
const SNOW = 'PLXSNOW-26DEC'; const SNOW_URL = '/markets/plxsnow/snow/plxsnow-26dec'; // deci_cent grid (0.1¢ = 10 kobo ticks)
const BTC = 'PLXBTCPERP';
const D = H.db(DB_FILE);
let PORT; let BASE; let srv; let browser; let admin; let ada; let adaUid;
const opts = (port) => ({ port, dbFile: DB_FILE, tickMs: 300, quiet: true, admin: ADMIN, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH }, identity: { kycRequired: false }, auth: { stepUpMs: 60000 } });
const naira = (cents) => `₦${Number(cents).toLocaleString('en-NG', { minimumFractionDigits: Number.isInteger(cents) ? 0 : 2, maximumFractionDigits: 2 })}`;
const uidOf = (email) => D.q('SELECT id FROM users WHERE email=?', email)[0].id;
const mainText = (page) => page.evaluate(() => document.querySelector('main').textContent);
const noUsd = (t) => !/[$¢]/.test(t);

// The staff API client confirms with its password when a write asks for step-up.
function withStepUp(c, pw) {
  const call = c.call.bind(c);
  c.call = async (...a) => {
    let r = await call(...a);
    if (r.status === 403 && r.code === 'step_up_required') { await call('POST', '/v1/step_up', { password: pw }); r = await call(...a); }
    return r;
  };
  return c;
}
async function signUp(page, u) {
  await H.signUpUi(page, BASE, u, PW);
  await page.waitForSelector('[data-testid=account-menu]');
}
// One single-market, whole-cent, open event for the ticket (URL built like lib.js eventHref).
function plainEvent() {
  const r = D.q(`SELECT m.ticker, m.event_ticker, s.ticker series, s.slug FROM markets m JOIN events e ON e.ticker=m.event_ticker JOIN series s ON s.ticker=e.series_ticker
    WHERE m.status='active' AND m.price_level_structure='linear_cent' AND m.fractional_trading_enabled=1 AND m.mve_collection_ticker IS NULL AND e.series_ticker NOT LIKE 'PLXFLASH%'
    AND (SELECT COUNT(*) FROM markets x WHERE x.event_ticker=m.event_ticker)=1 ORDER BY m.rowid LIMIT 1`)[0];
  return { ticker: r.ticker, url: `/markets/${r.series.toLowerCase()}/${r.slug}/${r.event_ticker.toLowerCase()}` };
}

before(async () => {
  PORT = await H.freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  srv = await start(opts(PORT));
  browser = await chromium.launch();
  admin = withStepUp(await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password), ADMIN.password);
});
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('descriptor endpoint: NGN by default, documented shape; the API keeps its *_dollars fields and values', async () => {
  const r = await (await fetch(`${BASE}/v1/exchange/display_currency`)).json();
  const d = r.display_currency;
  assert.deepEqual([d.code, d.symbol, d.minor_unit, d.contract_value, d.locale, d.timezone], ['NGN', '₦', 'kobo', 100, 'en-NG', 'Africa/Lagos']);
  assert.equal(d.per_internal_dollar, 100);
  assert.match(d.rule, /display-only/);
  assert.deepEqual(d.supported, ['NGN', 'USD']);
  const site = await (await fetch(`${BASE}/v1/site_config`)).json();
  assert.deepEqual(site.display_currency, d, 'the SPA boots from the same descriptor');
  // API values are unchanged: a price is still a 4-decimal dollar string.
  const m = (await (await fetch(`${BASE}/trade-api/v2/markets/${SNOW}`)).json()).market;
  assert.match(m.yes_ask_dollars, /^0\.\d{4}$/);
  assert.equal(m.price_level_structure, 'deci_cent');
});

test('NGN in the browser: home, ticket (Naira mode), /funds deposit, portfolio, notification + email, CSV and PDF', async () => {
  ada = await H.newPage(browser, BASE, { viewport: { width: 1600, height: 1100 } });
  await signUp(ada, ADA);
  adaUid = uidOf(ADA.email);
  assert.equal(await ada.textContent('[data-testid=header-balance]'), '₦0');
  // Deposit ₦2,500 through /funds: the input takes naira, the API gets $25.00, the DB stores 2,500 cents.
  await ada.goto(BASE + '/funds/deposit');
  await ada.click('[data-method=demo]');
  await ada.waitForSelector('[data-testid=fund-amount]');
  assert.match(await ada.textContent('[data-testid=fund-amount-form]'), /Amount \(NGN\)/);
  await ada.fill('[data-testid=fund-amount]', '2500.5');
  await ada.click('[data-testid=fund-continue]');
  assert.match(await ada.textContent('[data-testid=fund-amount-error]'), /whole naira/);
  await ada.fill('[data-testid=fund-amount]', '2500');
  await ada.click('[data-testid=fund-continue]');
  await ada.waitForSelector('[data-testid=fund-review]');
  assert.match(await ada.textContent('[data-testid=fund-review]'), /Amount₦2,500/);
  await ada.click('[data-testid=fund-confirm]');
  await ada.waitForSelector('[data-testid=header-balance]:has-text("₦2,500")');
  assert.deepEqual(D.q("SELECT amount_cents FROM ledger WHERE user_id=? AND kind='deposit'", adaUid).map((r) => r.amount_cents), [2500]);
  assert.equal(D.q('SELECT balance_cents b FROM users WHERE id=?', adaUid)[0].b, 2500);
  // The Transfers notification: inbox row, the bell, and the dev-mailbox email.
  await H.until(() => D.q("SELECT 1 FROM notifications WHERE user_id=? AND title='Deposit of ₦2,500 completed' AND body='Cash balance ₦2,500'", adaUid)[0]);
  await ada.click('[data-testid=bell]');
  await ada.waitForSelector('#notif-items .notif:has-text("Deposit of ₦2,500 completed")');
  const mail = await H.mailTo(BASE, ADA.email, /Deposit of ₦2,500 completed/);
  assert.match(mail.body, /Cash balance ₦2,500/);
  await ada.goto(BASE + '/dev/mailbox');
  await ada.waitForSelector('text=Parlance: Deposit of ₦2,500 completed');

  // Home: every price and volume in naira, no $ or ¢ anywhere in the page body.
  await ada.goto(BASE + '/');
  await ada.waitForSelector('.mcard-foot');
  await ada.waitForFunction(() => /₦[\d,]+ vol/.test(document.querySelector('main').textContent));
  assert.ok(noUsd(await mainText(ada)), 'home shows no $ or ¢');

  // Ticket in Naira mode: whole naira, contracts floored within the amount, payout = contracts × ₦100.
  const ev = plainEvent();
  const ask = Math.round(Number((await (await fetch(`${BASE}/trade-api/v2/markets/${ev.ticker}`)).json()).market.yes_ask_dollars) * 100);
  await ada.goto(BASE + ev.url);
  await ada.waitForSelector('[data-testid=submit-order]');
  assert.match(await ada.textContent('#t-mode-btn'), /NAIRA/);
  assert.match(await ada.textContent('#ticket'), new RegExp(`YES ₦${ask}`));
  await ada.fill('#t-amount', '10.5');
  await ada.waitForSelector('[data-testid=t-invalid]:has-text("whole number of naira")');
  assert.equal(await ada.isDisabled('[data-testid=submit-order]'), true);
  await ada.fill('#t-amount', '1000');
  await ada.waitForSelector('[data-testid=t-contracts]');
  const m = /^([\d.,]+) contracts at ₦(\d+)$/.exec((await ada.textContent('[data-testid=t-contracts]')).trim());
  assert.ok(m, 'contracts line');
  const contracts = Number(m[1].replace(/,/g, ''));
  assert.equal(Number(m[2]), ask);
  assert.ok(contracts > 0 && contracts * ask <= 1000, `${contracts} contracts at ₦${ask} fit ₦1,000`);
  assert.equal(await ada.textContent('[data-testid=t-payout]'), naira(Math.round(contracts * 100 * 100) / 100), 'max payout: ₦100 per contract');
  await ada.click('[data-testid=submit-order]');
  await ada.waitForSelector('[data-testid=review-price]');
  assert.match(await ada.textContent('[data-testid=review-price]'), new RegExp(`^Spend up to ₦1,000 at ₦${ask}$`));
  await ada.click('[data-testid=review-confirm]');
  await H.until(() => D.q("SELECT 1 FROM fills WHERE user_id=? AND market_ticker=?", adaUid, ev.ticker)[0]);
  const spent = 2500 - D.q('SELECT balance_cents b FROM users WHERE id=?', adaUid)[0].b;
  assert.ok(spent > 0 && spent <= 1000, `spent ${spent} cents (₦${spent}) of a ₦1,000 order`);
  assert.equal(D.q("SELECT order_type FROM orders WHERE user_id=? AND market_ticker=?", adaUid, ev.ticker)[0].order_type, 'dollars', 'the API order type is unchanged');

  // Portfolio: cash, positions and history in naira.
  await ada.goto(BASE + '/portfolio');
  await ada.waitForSelector(`[data-testid=cash]:has-text("${naira(2500 - spent)}")`);
  await ada.waitForFunction(() => /^₦[\d,]+(\.\d{2})?$/.test(document.querySelector('[data-testid=positions-value]').textContent));
  assert.ok(noUsd(await mainText(ada)), 'portfolio shows no $ or ¢');

  // CSV export: the amount column is named for the currency and holds naira.
  const [dl] = await Promise.all([ada.waitForEvent('download'), ada.click('[data-testid=csv-link]')]);
  const lines = fs.readFileSync(await dl.path(), 'utf8').trim().split('\n');
  assert.equal(lines[0], 'time,type,amount_ngn,reference,memo');
  assert.ok(lines.some((l) => /,deposit,2500\.00,/.test(l)), 'deposit of ₦2,500');
  assert.ok(lines.some((l) => new RegExp(`,trade,-\\d+\\.00,.*@ ₦${ask}`).test(l)), 'trade memo quotes the price in naira');

  // Document PDF (Account › Documents): naira written with its ISO code (the standard PDF fonts have no ₦ glyph).
  const year = new Date().getUTCFullYear();
  await ada.goto(BASE + '/account/taxes');
  await ada.waitForSelector(`[data-testid=statement-list] li[data-year="${year}"] [data-form=PNL] [data-testid=statement-pdf]`);
  const [pdfDl] = await Promise.all([ada.waitForEvent('download'), ada.click(`[data-testid=statement-list] li[data-year="${year}"] [data-form=PNL] [data-testid=statement-pdf]`)]);
  const pdf = fs.readFileSync(await pdfDl.path()).toString('latin1');
  assert.ok(pdf.startsWith('%PDF-'));
  assert.match(pdf, /Fees: NGN \d+/);
  assert.match(pdf, /Amounts in Nigerian naira \(NGN\)/);
  assert.ok(!/\$\d/.test(pdf), 'no dollar amounts in the statement text');
  assert.deepEqual(ada.errors, []);
});

test('perps: asset prices, collateral and the ticket use the same ×100 rule', async () => {
  srv.engine.perps.setIndex(BTC, 100000, { freeze: true });
  await ada.goto(BASE + `/perps/${BTC}`);
  await ada.waitForFunction(() => document.querySelector('[data-testid=perp-mark]')?.textContent === '₦10,000,000');
  // Move ₦500 of cash to Perps: whole naira in, $5.00 to the API, 50,000 cc in the perps account.
  await ada.fill('[data-testid=xfer-amount]', '500');
  await ada.click('[data-testid=xfer-to-perps]');
  await ada.waitForFunction(() => document.querySelector('[data-testid=perps-available]')?.textContent === '₦500');
  assert.equal(D.q('SELECT available_cc c FROM perp_accounts WHERE user_id=?', adaUid)[0].c, 50000);
  // The limit-price input takes naira levels and prefills the mark in naira.
  await ada.click('[data-testid=perp-type] [data-type=limit]');
  assert.equal(await ada.inputValue('[data-testid=perp-limit-price]'), '10000000');
  assert.equal(await ada.textContent('[data-testid=perp-unit] [data-unit=usd]'), '₦');
  assert.ok(noUsd(await mainText(ada)), 'perps shows no $ or ¢');
  assert.deepEqual(ada.errors, []);
});

test('kobo on a sub-cent grid: the book shows ₦12.40, a ₦12.30 limit is stored as 1,230 cc', async () => {
  await ada.goto(BASE + SNOW_URL);
  await ada.waitForSelector('[data-testid=submit-order]');
  await ada.click('#t-mode-btn'); await ada.click('[data-otype=limit]');
  assert.match(await ada.textContent('#ticket'), /Limit price \(₦\)/);
  assert.match(await ada.textContent('[data-testid=t-grid]'), /₦0\.10 from ₦0/);
  await ada.click('.big-tabs [data-tab=book]');
  await ada.waitForSelector('[data-testid=book-price]');
  const prices = await ada.$$eval('[data-testid=book-price]', (els) => els.map((e) => e.textContent));
  assert.ok(prices.length && prices.every((p) => /^₦\d+(\.\d{2})?$/.test(p)), prices.join(' '));
  assert.ok(prices.some((p) => /\.\d0$/.test(p) && !/\.00$/.test(p)), `a kobo level on the book: ${prices.join(' ')}`);
  await ada.fill('#t-price', '12.3');
  await ada.fill('#t-count', '2');
  await ada.click('[data-testid=submit-order]');
  await ada.waitForSelector('[data-testid=review-price]');
  assert.match(await ada.textContent('[data-testid=review-price]'), /^Limit ₦12\.30/);
  await ada.click('[data-testid=review-confirm]');
  await H.until(() => D.q("SELECT 1 FROM orders WHERE user_id=? AND market_ticker=? AND price_cc=1230", adaUid, SNOW)[0]);
  await ada.goto(BASE + '/portfolio?tab=orders');
  await ada.waitForSelector('[data-testid=o-price]:has-text("₦12.30")');
  assert.deepEqual(ada.errors, []);
});

test('admin switch NGN → USD → NGN: preview, reason and step-up, audited, live on open pages, persisted across a restart', async () => {
  const ap = await H.newPage(browser, BASE);
  await H.logInUi(ap, BASE, ADMIN.email, ADMIN.password);
  await ap.waitForSelector('[data-testid=account-menu]');
  await ap.goto(BASE + '/admin/settings');
  await ap.waitForSelector('[data-testid=currency-panel] [data-testid=currency-preview]');
  const prev = async (k) => (await ap.textContent(`[data-testid=currency-preview] [data-preview="${k}"]`)).trim();
  assert.equal(await prev('Price (64¢ internal)'), '₦64');
  assert.equal(await prev('Fine-grid price (64.50¢)'), '₦64.50');
  assert.equal(await prev('Balance ($25.00 internal)'), '₦2,500');
  assert.equal(await prev('Perps BTC level ($96,250)'), '₦9,625,000');
  // The preview follows the form before anything is saved.
  await ap.selectOption('[data-testid=currency-form] [name=code]', 'USD');
  await ap.selectOption('[data-testid=currency-form] [name=locale]', 'en-US');
  await ap.waitForFunction(() => document.querySelector('[data-testid=currency-preview] [data-preview="Balance ($25.00 internal)"]').textContent === '$25.00');
  assert.equal(await prev('Fine-grid price (64.50¢)'), '64.5¢');
  assert.equal(await prev('Price input unit'), '¢');
  assert.equal(D.q("SELECT COUNT(*) c FROM admin_settings WHERE key='display_currency'")[0].c, 0, 'nothing saved yet');
  // A reason is required.
  await ap.click('[data-testid=currency-form] button[type=submit]');
  await ap.waitForSelector('[data-testid=currency-form] #e-cur-reason:has-text("required")');
  // Saving with a stale sign-in asks for step-up.
  D.run('UPDATE sessions SET auth_at=0 WHERE user_id=?', uidOf(ADMIN.email));
  await ap.fill('[data-testid=currency-form] [name=reason]', 'Owner demo for US visitors');
  await ada.goto(BASE + '/portfolio'); // another user's open page
  await ada.waitForSelector('[data-testid=header-balance]:has-text("₦")');
  await ada.evaluate(() => { window.__noReload = 1; });
  await ap.click('[data-testid=currency-form] button[type=submit]');
  await ap.waitForSelector('[data-testid=step-up-dialog]');
  await ap.fill('[data-testid=step-up-password]', ADMIN.password);
  await ap.click('[data-testid=step-up-submit]');
  await ap.waitForSelector('.toast:has-text("Currency & defaults saved · USD")');
  // Live on the other open page (WebSocket push), without a reload.
  const cash = D.q('SELECT balance_cents b FROM users WHERE id=?', adaUid)[0].b;
  await ada.waitForSelector(`[data-testid=header-balance]:has-text("$${(cash / 100).toFixed(2)}")`);
  await ada.waitForFunction(() => /^\$[\d,]+\.\d{2}$/.test(document.querySelector('[data-testid=cash]').textContent));
  assert.equal(await ada.evaluate(() => window.__noReload), 1, 'updated in place');
  // Stored, audited (hash chain intact), step-up logged.
  assert.deepEqual(JSON.parse(D.q("SELECT value FROM admin_settings WHERE key='display_currency'")[0].value), { code: 'USD', locale: 'en-US', timezone: 'Africa/Lagos' });
  const au = D.q("SELECT * FROM admin_audit WHERE action='settings.currency' ORDER BY chain_seq")[0];
  assert.equal(au.reason, 'Owner demo for US visitors');
  assert.equal(JSON.parse(au.before_json).display_currency.code, 'NGN');
  assert.equal(JSON.parse(au.after_json).display_currency.code, 'USD');
  assert.ok(au.hash && au.prev_hash, 'hash-chained');
  assert.equal((await admin.call('GET', '/v1/admin/audit/verify')).body.ok, true, 'audit chain verifies');
  assert.ok(D.q("SELECT 1 FROM auth_events WHERE user_id=? AND type='step_up'", uidOf(ADMIN.email))[0], 'the step-up is logged');
  // The API refuses without a reason, a non-staff user, and a bad time zone.
  assert.equal((await admin.call('PUT', '/v1/admin/settings/currency', { display_currency: { code: 'NGN' } })).body.error.code, 'validation_failed');
  assert.equal((await admin.call('PUT', '/v1/admin/settings/currency', { display_currency: { timezone: 'Mars/Olympus' }, reason: 'bad zone' })).body.error.fields['display_currency.timezone'] != null, true);
  assert.equal((await ada.evaluate(async () => (await fetch('/v1/admin/settings/currency')).status)), 403);
  // USD display and descriptor survive a restart.
  await srv.close();
  srv = await start(opts(PORT));
  const d = (await (await fetch(`${BASE}/v1/exchange/display_currency`)).json()).display_currency;
  assert.deepEqual([d.code, d.symbol, d.locale, d.contract_value], ['USD', '$', 'en-US', 1]);
  await ada.goto(BASE + '/portfolio');
  await ada.waitForSelector(`[data-testid=header-balance]:has-text("$${(cash / 100).toFixed(2)}")`);
  // Back to NGN through the API (step-up again): the open page switches live.
  await ada.evaluate(() => { window.__noReload = 2; });
  admin = withStepUp(await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password), ADMIN.password);
  D.run('UPDATE sessions SET auth_at=0 WHERE user_id=?', uidOf(ADMIN.email));
  const r = await admin.call('PUT', '/v1/admin/settings/currency', { display_currency: { code: 'NGN', locale: 'en-NG', timezone: 'Africa/Lagos' }, reason: 'Back to the naira default' });
  assert.equal(r.status, 200, r.text);
  await ada.waitForSelector(`[data-testid=header-balance]:has-text("${naira(cash)}")`);
  assert.equal(await ada.evaluate(() => window.__noReload), 2);
  assert.equal(D.q("SELECT COUNT(*) c FROM admin_audit WHERE action='settings.currency'")[0].c, 2);
  await ap.context().close();
  assert.deepEqual(ada.errors, []);
});

test('new-account defaults apply to a new account, not to an existing one', async () => {
  const r = await admin.call('PUT', '/v1/admin/settings/currency', {
    account_defaults: { theme: 'light', order_review: false, flip_sell: true, display_mode: 'shares', notification_channels: { email: false } }, reason: 'Defaults for the launch cohort' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.account_defaults, { theme: 'light', order_review: false, flip_sell: true, display_mode: 'shares', notification_channels: { in_app: true, email: false, push: true } });
  // Existing account (Ada): unchanged.
  const pa = (await ada.evaluate(async (u) => (await fetch(`/v1/users/${u}/preferences`)).json(), adaUid)).preferences;
  assert.deepEqual([pa.theme, pa.trade_skip_review, pa.trade_flip_sell, pa.display_mode], ['dark', false, false, 'payout']);
  // New account (Bea): signs up in the browser and gets the defaults.
  const bea = await H.newPage(browser, BASE);
  await signUp(bea, BEA);
  await bea.waitForFunction(() => document.documentElement.dataset.theme === 'light' && document.documentElement.dataset.display === 'shares');
  const beaUid = uidOf(BEA.email);
  const pb = (await bea.evaluate(async (u) => (await fetch(`/v1/users/${u}/preferences`)).json(), beaUid)).preferences;
  assert.deepEqual([pb.theme, pb.trade_skip_review, pb.trade_flip_sell, pb.display_mode], ['light', true, true, 'shares']);
  const np = await bea.evaluate(async (u) => (await fetch(`/v1/users/${u}/notifications/preferences`)).json(), beaUid);
  const rows = np.groups.flatMap((g) => g.types);
  assert.ok(rows.filter((t) => t.offered.includes('email')).every((t) => t.channels.email === false), 'email off on every type that offers it');
  assert.ok(rows.find((t) => t.type === 'transfers').channels.push, 'other channels keep their defaults');
  // Order review off: the ticket places directly (no "Review ·").
  await bea.goto(BASE + plainEvent().url);
  await bea.waitForSelector('[data-testid=submit-order]');
  assert.match(await bea.textContent('[data-testid=submit-order]'), /^Buy Yes$/);
  // Restore the built-in defaults for anything that runs later.
  assert.equal((await admin.call('PUT', '/v1/admin/settings/currency', { account_defaults: { theme: 'dark', order_review: true, flip_sell: false, display_mode: 'payout', notification_channels: { email: true } }, reason: 'Restore defaults' })).status, 200);
  await bea.context().close();
});

test('time zone: calendar days are Lagos days (23:30 UTC is tomorrow in Lagos) and dates format in the configured zone', async () => {
  // A single-market event closing at 23:30 UTC the day after tomorrow (UTC): 00:30 the next day in Lagos.
  const ev = plainEvent();
  const day = new Date(); day.setUTCHours(0, 0, 0, 0);
  const close = new Date(day.getTime() + 2 * 86400000 + (23 * 60 + 30) * 60000);
  D.run('UPDATE markets SET close_time=? WHERE ticker=?', close.toISOString(), ev.ticker);
  const evTicker = D.q('SELECT event_ticker e FROM markets WHERE ticker=?', ev.ticker)[0].e;
  const utcDay = close.toISOString().slice(0, 10);
  const lagosDay = new Date(close.getTime() + 86400000).toISOString().slice(0, 10);
  const sectionOf = async () => (await (await fetch(`${BASE}/v1/calendar`)).json()).sections.find((s) => !s.is_live && s.events.some((e) => e.event_ticker === evTicker))?.date;
  assert.equal(await sectionOf(), lagosDay, 'grouped under the Lagos day');
  await ada.goto(BASE + '/calendar');
  await ada.waitForSelector(`[data-testid=cal-section][data-date="${lagosDay}"]`);
  // The same instant formats across midnight in the admin preview: Lagos vs UTC.
  const ap = await H.newPage(browser, BASE);
  await H.logInUi(ap, BASE, ADMIN.email, ADMIN.password);
  await ap.waitForSelector('[data-testid=account-menu]');
  await ap.goto(BASE + '/admin/settings');
  const k = 'Date and time (23:30 UTC)';
  await ap.waitForSelector(`[data-testid=currency-preview] [data-preview="${k}"]`);
  assert.match(await ap.textContent(`[data-preview="${k}"]`), /^5 Nov 2026, 00:30 WAT$/);
  await ap.selectOption('[data-testid=currency-form] [name=timezone]', 'UTC');
  await ap.waitForFunction((x) => /^4 Nov 2026, 23:30 UTC$/.test(document.querySelector(`[data-preview="${x}"]`).textContent), k);
  // Saved: the server regroups by UTC days.
  D.run('UPDATE sessions SET auth_at=0 WHERE user_id=?', uidOf(ADMIN.email));
  const r = await admin.call('PUT', '/v1/admin/settings/currency', { display_currency: { timezone: 'UTC' }, reason: 'Compare day boundaries' });
  assert.equal(r.status, 200, r.text);
  assert.equal(await sectionOf(), utcDay, 'grouped under the UTC day');
  assert.equal((await admin.call('PUT', '/v1/admin/settings/currency', { display_currency: { timezone: 'Africa/Lagos' }, reason: 'Back to Lagos time' })).status, 200);
  assert.equal(await sectionOf(), lagosDay);
  await ap.context().close();
});
