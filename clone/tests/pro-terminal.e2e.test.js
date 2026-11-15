'use strict';
// Pro trading terminal (owner design 2026-11-15, CLONE_SPEC.md §15.6, migration 0005), real server + SQLite + Chromium:
//   • candles: the hourly / daily candle table kept by triggers on `trades` and the /v1/pro/candles answer equal a recount
//     of the trades for 1H / 1D / 1W / ALL, after inserts (incl. the integer-cent writer's cc fill), an update and a
//     delete; the reads are index searches (no scan of the market's history);
//   • screener: category and spread filters, a saved screen persisted in the database and restored after a reload;
//   • ladder: a click on a price loads the ticket at that price (YES side, and the NO price on the NO side);
//   • quick ticket: B / Y / Enter opens the review, Place order creates the order in the database; no shortcut fires
//     while typing in a field;
//   • one-click: off by default (review shown, an unreviewed order refused), on only after the confirmation, then Enter
//     places at once; the owner's switch in Admin › Feature flags turns it off for everyone (UI and API);
//   • open orders: amend price and size, cancel; positions: close at market and at the bid; price alerts: create, delete;
//   • layout: hide, move and drag panels, saved in the database, restored after a reload and in another browser;
//   • 1-Click in the event ticket: the same preference, asked once, persisted, owner switch hides it and forces review;
//   • first page after sign-in: the panels keep their place while the data loads (no layout jump);
//   • signed-out visitors: screener and chart, trading panels ask to sign in; 390px wide without horizontal scroll;
//   • owner setting pro.layout: the classic screener instead of the terminal, audited, kept across a restart;
//     no page errors or CSP violations anywhere.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { start } = require('../server/index.js');
const { Client } = require('./lib/client');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-pro-'));
const PW = 'Ikeja-Lantern-Orbit-5821';
const stamp = Date.now();
const ADMIN = { email: `root.pro.${stamp}@example.test`, password: PW };
const HIGH = { burst: 1e6, per_second: 1e6 };
const email = (n) => `${n}.pro.${stamp}@example.test`;
let srv; let browser; let BASE;
const OPTS = () => ({ port: 0, dbFile: path.join(TMP, 'pro.db'), quiet: true, sports: false, tickMs: 300, admin: ADMIN, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH } });
const pages = [];

before(async () => {
  srv = await start(OPTS());
  BASE = `http://127.0.0.1:${srv.port}`;
  browser = await chromium.launch();
});
after(async () => {
  try { await browser?.close(); } catch { /* closed */ }
  try { await srv?.close(); } catch { /* closed */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

const q = (sql, ...a) => srv.db.prepare(sql).all(...a);
const q1 = (sql, ...a) => srv.db.prepare(sql).get(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(fn, { timeout = 10000, interval = 100, label = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    let v; let err;
    try { v = await fn(); } catch (e) { err = e; }
    if (!err && v) return v;
    if (Date.now() > end) throw err || new Error(`timed out waiting for ${label}`);
    await sleep(interval);
  }
}
// A member through the real sign-up route, identity approved (the trading lock), with play money.
async function member(n, dollars = 1000) {
  const c = await new Client(BASE, n).signUp(email(n), PW, `${n[0].toUpperCase()}${n.slice(1)} Okafor`);
  srv.db.prepare("UPDATE identity_profiles SET status='approved' WHERE user_id=?").run(c.uid);
  if (dollars) { const r = await c.call('POST', `/v1/users/${c.uid}/deposits`, { amount_dollars: dollars }); assert.equal(r.status, 201, r.text); }
  return c;
}
async function newPage(viewport = { width: 1500, height: 1100 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.effectiveDirective} ${e.blockedURI}`)); });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  pages.push(page);
  return page;
}
async function logIn(page, who, password = PW) {
  await page.goto(`${BASE}/sign-in`);
  await page.fill('input[name=email]', who);
  await page.fill('input[name=password]', password);
  await page.click('#auth-form button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
}
async function openPro(page, qs = '') {
  await page.goto(`${BASE}/pro${qs}`);
  await page.waitForSelector('[data-testid=pro-row]');
  await page.waitForSelector('[data-testid=pro-ladder]', { state: 'attached' });
}
async function clean(page, label) {
  assert.deepEqual(page.errors, [], `${label}: page errors`);
  assert.deepEqual(await page.evaluate(() => window.__csp || []), [], `${label}: CSP violations`);
}
const T0 = () => q1("SELECT m.ticker FROM markets m JOIN events e ON e.ticker=m.event_ticker WHERE m.status='active' AND e.series_ticker NOT LIKE 'PLXFLASH%' AND e.series_ticker<>'PLXCOMBO' AND m.market_type='binary' AND m.price_level_structure='linear_cent' ORDER BY m.rowid LIMIT 1").ticker;

// ------------------------------------------------------------------------------------------------ candles
// The candles of one timeframe recounted from `trades` the way the endpoint defines them (UTC buckets; open = first trade
// by time then insert order, close = the last; empty buckets carry the previous close once the market has traded).
function recount(ticker, tf, now) {
  const spec = { '1H': [60000, 60], '1D': [3600000, 24], '1W': [14400000, 42], ALL: [86400000, 730] }[tf];
  const [period, count] = spec;
  const last = Math.floor(now / period) * period;
  let first = last - (count - 1) * period;
  const all = q('SELECT yes_price_cc p, count c, created_ts ts FROM trades WHERE market_ticker=? AND yes_price_cc IS NOT NULL ORDER BY created_ts, rowid', ticker);
  if (tf === 'ALL') { if (!all.length) return []; first = Math.max(first, Math.floor(all[0].ts / period) * period); }
  const end = last + period;
  let prev = null;
  for (const t of all) if (t.ts < first) prev = t.p;
  const agg = new Map();
  for (const t of all.filter((x) => x.ts >= first && x.ts < end)) {
    const b = Math.floor(t.ts / period) * period; const a = agg.get(b);
    if (!a) agg.set(b, { o: t.p, h: t.p, l: t.p, c: t.p, v: t.c, n: 1 }); else { a.h = Math.max(a.h, t.p); a.l = Math.min(a.l, t.p); a.c = t.p; a.v += t.c; a.n += 1; }
  }
  const d = (cc) => (cc / 10000).toFixed(4);
  const out = [];
  for (let b = first; b < end; b += period) {
    const a = agg.get(b) || (prev != null ? { o: prev, h: prev, l: prev, c: prev, v: 0, n: 0 } : null);
    if (!a) continue;
    out.push({ start_ts: b / 1000, end_ts: (b + period) / 1000, open_dollars: d(a.o), high_dollars: d(a.h), low_dollars: d(a.l), close_dollars: d(a.c), volume_fp: (a.v / 100).toFixed(2), trades: a.n });
    prev = a.c;
  }
  return out;
}

test('candles: trigger-kept hourly / daily candles and /v1/pro/candles equal a recount of the trades (1H, 1D, 1W, ALL); bounded index reads', async () => {
  // A market of its own: a closed market gets no simulated trades, so only this test writes to it.
  const m = q1("SELECT ticker FROM markets WHERE status<>'active' ORDER BY rowid LIMIT 1") || { ticker: T0() };
  const t = m.ticker;
  const now = Date.now(); const H = 3600000;
  const ins = srv.db.prepare('INSERT INTO trades(id,market_ticker,yes_price_cents,yes_price_cc,count,taker_side,created_ts) VALUES(?,?,?,?,?,?,?)');
  const insCents = srv.db.prepare('INSERT INTO trades(id,market_ticker,yes_price_cents,count,taker_side,created_ts) VALUES(?,?,?,?,?,?)'); // integer-cent writer: the cc trigger fills the price
  srv.db.exec('BEGIN');
  for (let i = 0; i < 300; i++) ins.run(`pc_${i}`, t, 0, 1000 + ((i * 37) % 8000), 100 + (i % 9) * 50, i % 2 ? 'yes' : 'no', now - 20 * 86400000 + i * 97 * 60000);
  for (let i = 0; i < 120; i++) ins.run(`pr_${i}`, t, 0, 3000 + ((i * 53) % 4000), 100 + (i % 5) * 100, 'yes', now - 50 * 60000 + i * 20000);
  for (let i = 0; i < 6; i++) ins.run(`pt_${i}`, t, 0, 4000 + i * 100, 100, 'no', now - 2 * H); // equal timestamps: insert order decides open / close
  for (let i = 0; i < 20; i++) insCents.run(`pk_${i}`, t, 20 + i, 300, 'yes', now - 3 * H - i * 60000);
  srv.db.exec('COMMIT');
  // An update and deletes (one trade of a bucket, and every trade of another) mark buckets dirty; reads recompute them.
  srv.db.prepare("UPDATE trades SET yes_price_cc=9900, count=count*3 WHERE id IN ('pc_150','pr_60','pt_2')").run();
  srv.db.prepare("DELETE FROM trades WHERE id IN ('pc_151','pr_61','pt_0','pt_5')").run();
  const lone = q1("SELECT created_ts ts FROM trades WHERE id='pc_10'").ts;
  srv.db.prepare('DELETE FROM trades WHERE market_ticker=? AND created_ts>=? AND created_ts<?').run(t, Math.floor(lone / H) * H, Math.floor(lone / H) * H + H);
  // The stored hourly / daily rows hold exactly each bucket's volume and trade count.
  for (const [ps, p] of [[3600, H], [86400, 86400000]]) {
    const want = q(`SELECT (created_ts / ${p}) * ${p} b, SUM(count) v, COUNT(*) n FROM trades WHERE market_ticker=? AND yes_price_cc IS NOT NULL GROUP BY b ORDER BY b`, t);
    const got = q('SELECT bucket_ts b, volume_units v, trades n FROM market_candles WHERE market_ticker=? AND period_s=? ORDER BY bucket_ts', t, ps);
    assert.deepEqual(got.map((r) => ({ ...r })), want.map((r) => ({ ...r })), `period ${ps}: volume and count per bucket`);
  }
  const anon = await new Client(BASE, 'anon').boot();
  for (const tf of ['1H', '1D', '1W', 'ALL']) {
    // The endpoint and the recount use their own clocks: a minute boundary between them is retried.
    await eventually(async () => {
      const before = Date.now();
      const r = await anon.call('GET', `/v1/pro/candles?ticker=${encodeURIComponent(t)}&tf=${tf}`);
      assert.equal(r.status, 200, r.text);
      const want = recount(t, tf, before);
      if (Math.floor(Date.now() / 60000) !== Math.floor(before / 60000)) return false;
      assert.ok(r.body.candles.length > 0, `${tf}: candles`);
      assert.deepEqual(r.body.candles, want, `${tf}: candles equal the recount`);
      return true;
    }, { label: `${tf} candles` });
  }
  const bad = await anon.call('GET', `/v1/pro/candles?ticker=${encodeURIComponent(t)}&tf=5Y`);
  assert.equal(bad.status, 400);
  assert.equal((await anon.call('GET', '/v1/pro/candles?ticker=NOPE&tf=1D')).status, 404);
  // Bounded reads: every candle query is an index search, never a scan of the table.
  for (const [sql, args] of [['SELECT * FROM market_candles WHERE market_ticker=? AND period_s=? AND bucket_ts>=? AND bucket_ts<? ORDER BY bucket_ts', [t, 3600, 0, 1]], ['SELECT close_cc FROM market_candles WHERE market_ticker=? AND period_s=? AND bucket_ts<? ORDER BY bucket_ts DESC LIMIT 1', [t, 3600, 1]],
    ['SELECT yes_price_cc p FROM trades WHERE market_ticker=? AND created_ts>=? AND created_ts<? AND yes_price_cc IS NOT NULL ORDER BY created_ts, rowid', [t, 0, 1]]]) {
    const plan = q(`EXPLAIN QUERY PLAN ${sql}`, ...args).map((r) => r.detail).join(' | ');
    assert.match(plan, /SEARCH/, plan); assert.doesNotMatch(plan, /\bSCAN (market_candles|trades)\b/, plan);
  }
});

// ------------------------------------------------------------------------------------------------ screener + saved screens
test('screener: category and spread filters; a saved screen is stored in the database and restored after a reload', async () => {
  const ada = await member('ada');
  const page = await newPage();
  await logIn(page, email('ada'));
  await openPro(page);
  const all = await page.locator('[data-testid=pro-row]').count();
  assert.ok(all >= 20, `screener rows ${all}`);
  await page.selectOption('[data-testid=pro-filter-category]', 'Elections');
  await page.fill('[data-testid=pro-filter-spread]', '5');
  await page.click('[data-testid=pro-filter-apply]');
  const api = (await ada.call('GET', '/v1/pro/screener?category=Elections&max_spread_cents=5')).body;
  assert.ok(api.total_count > 0 && api.total_count < all, `filtered ${api.total_count} of ${all}`);
  assert.ok(api.markets.every((m) => m.category === 'Elections' && m.spread_cents <= 5));
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid=pro-row]').length === n, api.total_count);
  const cats = await page.$$eval('[data-testid=pro-row] td:first-child .faint', (els) => els.map((e) => e.textContent));
  assert.ok(cats.every((c) => c.endsWith('· Elections')), cats.join(' / '));
  await page.fill('[data-testid=pro-screen-name]', 'Tight elections');
  await page.click('[data-testid=pro-screen-save]');
  const row = await eventually(() => q1('SELECT s.*, p.active_screen_id FROM pro_screens s JOIN users u ON u.id=s.user_id LEFT JOIN pro_prefs p ON p.user_id=s.user_id WHERE u.email=?', email('ada')), { label: 'saved screen row' });
  assert.equal(row.name, 'Tight elections');
  assert.deepEqual(JSON.parse(row.filters_json), { category: 'Elections', closes_within_hours: null, min_volume: null, max_spread_cents: 5, min_move_cents: null, query: '' });
  await eventually(() => q1('SELECT active_screen_id a FROM pro_prefs WHERE user_id=?', ada.uid)?.a === row.id, { label: 'active screen' });
  // Reload: the screen is selected again, its filters are in the form and applied.
  await openPro(page);
  assert.equal(await page.inputValue('[data-testid=pro-screen-select]'), row.id);
  assert.equal(await page.inputValue('[data-testid=pro-filter-category]'), 'Elections');
  assert.equal(await page.inputValue('[data-testid=pro-filter-spread]'), '5');
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid=pro-row]').length === n, api.total_count);
  // Choosing "Unsaved filters" then the screen again restores it; the API refuses junk filters and duplicate names.
  await page.click('#pro-filter-clear');
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid=pro-row]').length > n, api.total_count);
  await page.selectOption('[data-testid=pro-screen-select]', row.id);
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid=pro-row]').length === n, api.total_count);
  assert.equal((await ada.call('POST', `/v1/users/${ada.uid}/pro/screens`, { name: 'Tight elections', filters: {} })).code, 'screen_name_taken');
  assert.equal((await ada.call('POST', `/v1/users/${ada.uid}/pro/screens`, { name: 'Bad', filters: { max_spread_cents: 'wide' } })).status, 400);
  assert.equal((await ada.call('POST', `/v1/users/${ada.uid}/pro/screens`, { name: 'Bad', filters: { owner: 'x' } })).status, 400);
  await clean(page, 'screener');
  await page.context().close();
});

// ------------------------------------------------------------------------------------------------ ladder + quick ticket
test('ladder click loads the ticket price; B / Y / Enter review and Place order creates the order; no shortcut while typing', async () => {
  const bo = await member('bo');
  const t = T0();
  const page = await newPage();
  await logIn(page, email('bo'));
  await openPro(page, `?market=${t}`);
  await page.waitForSelector('[data-testid=pro-ticket]');
  assert.equal(await page.textContent('[data-testid=pro-chart-market]').then((s) => s.length > 0), true);
  // A bid level: the YES price; on the NO side the same level loads the NO price (100 minus it).
  const lv = page.locator('[data-testid=ladder-level][data-kind=bid]').first();
  await lv.waitFor();
  const level = Number(await lv.getAttribute('data-level'));
  await lv.click();
  assert.equal(Number(await page.inputValue('[data-testid=pro-ticket-price]')), level / 100);
  await page.locator('body').press('n');
  await page.waitForSelector('[data-testid=pro-ticket][data-side=no]');
  await page.locator(`[data-testid=ladder-level][data-level="${level}"]`).click();
  assert.equal(Number(await page.inputValue('[data-testid=pro-ticket-price]')), (10000 - level) / 100);
  // Focus safety: letters typed into a field are text, not shortcuts.
  await page.click('[data-testid=pro-screen-name]');
  await page.keyboard.type('sbyn');
  assert.equal(await page.inputValue('[data-testid=pro-screen-name]'), 'sbyn');
  assert.equal(await page.getAttribute('[data-testid=pro-ticket]', 'data-side'), 'no');
  assert.equal(await page.getAttribute('[data-testid=pro-ticket]', 'data-action'), 'buy');
  await page.keyboard.press('Escape'); // leaves the field
  // S then B, Y: buy YES at the ask (the default price); 3 contracts; Enter opens the review.
  await page.keyboard.press('s');
  await page.waitForSelector('[data-testid=pro-ticket][data-action=sell]');
  await page.keyboard.press('b');
  await page.keyboard.press('y');
  await page.waitForSelector('[data-testid=pro-ticket][data-action=buy][data-side=yes]');
  await page.fill('[data-testid=pro-ticket-count]', '3');
  await page.keyboard.press('Escape');
  const before = q1('SELECT COUNT(*) c FROM orders WHERE user_id=?', bo.uid).c;
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-testid=pro-review]');
  assert.match(await page.textContent('[data-testid=pro-review-order]'), /3 YES/);
  // Esc cancels the review; Enter opens it again; nothing was placed.
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid=pro-review]', { state: 'detached' });
  await page.locator('body').press('Enter');
  await page.waitForSelector('[data-testid=pro-review]');
  assert.equal(q1('SELECT COUNT(*) c FROM orders WHERE user_id=?', bo.uid).c, before, 'nothing placed before the confirmation');
  await page.click('[data-testid=pro-review-confirm]');
  const o = await eventually(() => q1('SELECT * FROM orders WHERE user_id=? ORDER BY seq DESC LIMIT 1', bo.uid), { label: 'order row' });
  assert.equal(q1('SELECT COUNT(*) c FROM orders WHERE user_id=?', bo.uid).c, before + 1);
  assert.equal(o.market_ticker, t); assert.equal(o.side, 'yes'); assert.equal(o.initial_count, 300);
  await page.waitForSelector('[data-testid=pro-review]', { state: 'detached' });
  await clean(page, 'ticket');
  await page.context().close();
});

// ------------------------------------------------------------------------------------------------ one-click + owner switch
async function setFlagUi(ap, key, enabled) {
  await ap.goto(`${BASE}/admin/flags`);
  await ap.waitForSelector(`[data-flag-key="${key}"]`);
  await ap.click(`[data-flag-key="${key}"] [data-testid=flag-edit]`);
  await ap.waitForSelector('[data-testid=flag-form]');
  await ap.setChecked('[data-testid=flag-form] [name=enabled]', enabled);
  await ap.fill('[data-testid=flag-form] [name=reason]', `pro e2e: ${key} ${enabled ? 'on' : 'off'}`);
  await ap.click('[data-testid=flag-form] button[type=submit]');
  const which = await Promise.race([
    ap.waitForSelector('[data-testid=step-up-password]', { timeout: 15000 }).then(() => 'step_up').catch(() => null),
    ap.waitForSelector(`[data-flag-key="${key}"] [data-testid=flag-state][data-on="${enabled ? 1 : 0}"]`, { timeout: 15000 }).then(() => 'done').catch(() => null),
  ]);
  if (which === 'step_up') { await ap.fill('[data-testid=step-up-password]', PW); await ap.click('[data-testid=step-up-submit]'); }
  await ap.waitForSelector(`[data-flag-key="${key}"] [data-testid=flag-state][data-on="${enabled ? 1 : 0}"]`, { timeout: 15000 });
}

test('one-click (Pro): off by default, on only after confirming once, then Enter places at once; the owner switch in Admin turns it off for everyone', async () => {
  const cy = await member('cy');
  const t = T0();
  const page = await newPage();
  await logIn(page, email('cy'));
  await openPro(page, `?market=${t}`);
  await page.waitForSelector('[data-testid=pro-one-click]');
  // Off by default: unchecked, the button reviews, the server refuses an order marked as unreviewed.
  assert.equal(await page.isChecked('[data-testid=pro-one-click]'), false);
  assert.match(await page.textContent('[data-testid=pro-ticket-submit]'), /Review/);
  assert.equal(q1('SELECT one_click FROM pro_prefs WHERE user_id=?', cy.uid)?.one_click ?? 0, 0);
  const body = { ticker: t, side: 'yes', action: 'buy', type: 'limit', count: 1, price_dollars: '0.0100' };
  const refused = await cy.call('POST', `/v1/users/${cy.uid}/orders`, body, { 'x-plx-one-click': '1' });
  assert.equal(refused.status, 403); assert.equal(refused.code, 'one_click_not_enabled');
  assert.equal((await cy.call('PUT', `/v1/users/${cy.uid}/pro/preferences`, { one_click: true })).code, 'one_click_confirmation_required');
  // Switching it on asks first; "Keep reviewing" leaves it off.
  await page.click('[data-testid=pro-one-click]');
  await page.waitForSelector('[data-testid=pro-one-click-confirm]');
  await page.click('[data-testid=pro-one-click-cancel]');
  assert.equal(await page.isChecked('[data-testid=pro-one-click]'), false);
  await page.click('[data-testid=pro-one-click]');
  await page.click('[data-testid=pro-one-click-accept]');
  await page.waitForSelector('[data-testid=pro-one-click]:checked');
  const pref = q1('SELECT * FROM pro_prefs WHERE user_id=?', cy.uid);
  assert.equal(pref.one_click, 1); assert.ok(pref.one_click_confirmed_at);
  assert.doesNotMatch(await page.textContent('[data-testid=pro-ticket-submit]'), /Review/);
  // The confirmation is asked once: off and on again needs no second question.
  await page.click('[data-testid=pro-one-click]');
  await page.waitForSelector('[data-testid=pro-one-click]:not(:checked)');
  await eventually(() => q1('SELECT one_click FROM pro_prefs WHERE user_id=?', cy.uid).one_click === 0, { label: 'one-click off' });
  await page.click('[data-testid=pro-one-click]');
  await page.waitForSelector('[data-testid=pro-one-click]:checked');
  assert.equal(await page.locator('[data-testid=pro-one-click-confirm]').count(), 0, 'no second confirmation');
  assert.equal(q1('SELECT one_click_confirmed_at c FROM pro_prefs WHERE user_id=?', cy.uid).c, pref.one_click_confirmed_at, 'the first confirmation is kept');
  // Enter places the order at once (a resting limit buy at the lowest tick), with no review step.
  await page.click('[data-testid=pro-ticket] [data-otype=limit]');
  await page.fill('[data-testid=pro-ticket-price]', '1');
  await page.fill('[data-testid=pro-ticket-count]', '2');
  await page.keyboard.press('Escape');
  const n0 = q1('SELECT COUNT(*) c FROM orders WHERE user_id=?', cy.uid).c;
  await page.keyboard.press('Enter');
  await eventually(() => q1('SELECT COUNT(*) c FROM orders WHERE user_id=?', cy.uid).c === n0 + 1, { label: 'one-click order' });
  assert.equal(await page.locator('[data-testid=pro-review]').count(), 0, 'no review step');
  // The owner switches one-click off in Admin › Feature flags: the open page shows the review again (live), the member
  // cannot switch it on, and the API refuses unreviewed orders, although the member's own preference is still on.
  const ap = await newPage({ width: 1400, height: 1000 });
  await logIn(ap, ADMIN.email);
  await setFlagUi(ap, 'trading.one_click', false);
  await page.waitForSelector('[data-testid=pro-one-click]:disabled', { timeout: 15000 });
  assert.match(await page.textContent('[data-testid=pro-ticket-submit]'), /Review/);
  assert.match(await page.textContent('[data-testid=pro-one-click-state]'), /switched off by the exchange/);
  const off = await cy.call('POST', `/v1/users/${cy.uid}/orders`, body, { 'x-plx-one-click': '1' });
  assert.equal(off.status, 403); assert.equal(off.code, 'feature_disabled'); assert.equal(off.body.error.feature, 'trading.one_click');
  assert.equal((await cy.call('PUT', `/v1/users/${cy.uid}/pro/preferences`, { one_click: true, confirm: true })).code, 'feature_disabled');
  const prefs = (await cy.call('GET', `/v1/users/${cy.uid}/pro/preferences`)).body.preferences;
  assert.deepEqual([prefs.one_click, prefs.one_click_available, prefs.one_click_effective], [true, false, false]);
  // Enter now reviews.
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-testid=pro-review]');
  await page.keyboard.press('Escape');
  // Admin shows both Pro switches with their explanation and recommended default.
  await ap.goto(`${BASE}/admin/flags`);
  await ap.waitForSelector('[data-flag-key="pro"]');
  assert.match(await ap.textContent('[data-flag-key="trading.one_click"]'), /One-click/);
  const os2 = await (await new Client(BASE, 'admin').logIn(ADMIN.email, PW)).call('GET', '/v1/admin/owner_settings');
  const sw = os2.body.switches.filter((s) => ['pro', 'trading.one_click'].includes(s.key));
  assert.deepEqual(sw.map((s) => [s.key, s.default, s.effective]).sort(), [['pro', true, true], ['trading.one_click', true, false]]);
  assert.ok(sw.every((s) => s.help.length > 40 && /Recommended: on/.test(s.recommended)));
  await setFlagUi(ap, 'trading.one_click', true);
  await clean(page, 'one-click'); await clean(ap, 'admin');
  await page.context().close(); await ap.context().close();
});

// ------------------------------------------------------------------------------------------------ 1-Click in the event ticket
const eventUrl = (t) => { const r = q1('SELECT e.ticker ev, e.series_ticker st, s.slug FROM markets m JOIN events e ON e.ticker=m.event_ticker JOIN series s ON s.ticker=e.series_ticker WHERE m.ticker=?', t); return `${BASE}/markets/${r.st.toLowerCase()}/${r.slug}/${r.ev.toLowerCase()}?market=${encodeURIComponent(t)}`; };
async function openModeMenu(page) { await page.click('#t-mode-btn'); await page.waitForSelector('#t-mode-menu:not([hidden])'); }
test('1-Click in the event ticket: off by default, enabling asks once and persists (reload, another browser, shared with Pro), places without review; the owner switch hides it and forces review', async () => {
  const gi = await member('gi');
  const t = T0();
  const page = await newPage();
  await logIn(page, email('gi'));
  await page.goto(eventUrl(t));
  await page.waitForSelector('[data-testid=submit-order]');
  // Off by default: the switch sits under a divider in the mode menu, the button reviews.
  await openModeMenu(page);
  assert.equal(await page.getAttribute('[data-testid=one-click-toggle]', 'aria-checked'), 'false');
  assert.equal(await page.locator('#t-mode-menu hr.mode-sep').count(), 1);
  assert.match(await page.textContent('[data-testid=submit-order]'), /Review/);
  assert.equal(await page.getAttribute('[data-testid=submit-order]', 'data-one-click'), '0');
  // Enabling asks (Keep reviewing leaves it off), then turns it on.
  await page.click('[data-testid=one-click-toggle]');
  await page.waitForSelector('[data-testid=one-click-confirm]');
  await page.click('[data-testid=one-click-cancel]');
  await page.waitForSelector('[data-testid=one-click-confirm]', { state: 'detached' });
  assert.equal(q1('SELECT one_click FROM pro_prefs WHERE user_id=?', gi.uid)?.one_click ?? 0, 0);
  await openModeMenu(page);
  await page.click('[data-testid=one-click-toggle]');
  await page.click('[data-testid=one-click-accept]');
  await page.waitForSelector('[data-testid=submit-order][data-one-click="1"]');
  assert.equal(await page.textContent('[data-testid=submit-order]'), '⚡ Buy with 1-Click');
  assert.ok(await page.$eval('[data-testid=submit-order]', (b) => b.classList.contains('cta-oneclick')), 'outlined 1-Click style');
  const pref = q1('SELECT one_click, one_click_confirmed_at FROM pro_prefs WHERE user_id=?', gi.uid);
  assert.equal(pref.one_click, 1); assert.ok(pref.one_click_confirmed_at);
  // A 1-Click limit order (resting at the lowest tick) lands in the database without the review step.
  await openModeMenu(page);
  await page.click('[data-otype=limit]');
  await page.waitForSelector('[data-testid=t-price]');
  await page.fill('[data-testid=t-price]', '1');
  await page.fill('[data-testid=t-count]', '2');
  assert.equal(await page.textContent('[data-testid=submit-order]'), '⚡ Buy with 1-Click');
  const n0 = q1('SELECT COUNT(*) c FROM orders WHERE user_id=?', gi.uid).c;
  await page.click('[data-testid=submit-order]');
  const o = await eventually(() => q1('SELECT * FROM orders WHERE user_id=? ORDER BY seq DESC LIMIT 1', gi.uid), { label: '1-Click order' });
  assert.equal(q1('SELECT COUNT(*) c FROM orders WHERE user_id=?', gi.uid).c, n0 + 1);
  assert.deepEqual([o.market_ticker, o.side, o.price_cc, o.initial_count, o.status], [t, 'yes', 100, 200, 'resting']);
  assert.equal(await page.locator('[data-testid=order-review]').count(), 0, 'no review step');
  // Off and on again: no second question.
  await openModeMenu(page);
  await page.click('[data-testid=one-click-toggle]');
  await page.waitForSelector('[data-testid=submit-order][data-one-click="0"]');
  await openModeMenu(page);
  await page.click('[data-testid=one-click-toggle]');
  await page.waitForSelector('[data-testid=submit-order][data-one-click="1"]');
  assert.equal(await page.locator('[data-testid=one-click-confirm]').count(), 0, 'asked once only');
  // Persists after a reload, in another browser, and in the Pro terminal (one shared preference).
  await page.reload();
  await page.waitForSelector('[data-testid=submit-order][data-one-click="1"]');
  const other = await newPage({ width: 1300, height: 1000 });
  await logIn(other, email('gi'));
  await other.goto(eventUrl(t));
  await other.waitForSelector('[data-testid=submit-order][data-one-click="1"]');
  await openPro(other, `?market=${t}`);
  await other.waitForSelector('[data-testid=pro-one-click]:checked');
  // The owner switch off: the toggle disappears (live), the button reviews again, the API refuses unreviewed orders.
  const ap = await newPage({ width: 1400, height: 1000 });
  await logIn(ap, ADMIN.email);
  await setFlagUi(ap, 'trading.one_click', false);
  try {
    await page.waitForSelector('[data-testid=submit-order][data-one-click="0"]', { timeout: 15000 });
    await openModeMenu(page);
    assert.equal(await page.locator('[data-testid=one-click-toggle]').count(), 0, 'switch hidden');
    assert.match(await page.textContent('[data-testid=submit-order]'), /Review/);
    await page.click('[data-testid=submit-order]');
    await page.waitForSelector('[data-testid=order-review]');
    const off = await gi.call('POST', `/v1/users/${gi.uid}/orders`, { ticker: t, side: 'yes', action: 'buy', type: 'limit', count: 1, price_dollars: '0.0100' }, { 'x-plx-one-click': '1' });
    assert.equal(off.status, 403); assert.equal(off.body.error.feature, 'trading.one_click');
    assert.equal((await gi.call('GET', `/v1/users/${gi.uid}/one_click`)).code, 'feature_disabled');
    assert.equal((await gi.call('PUT', `/v1/users/${gi.uid}/one_click`, { one_click: false })).status, 200, 'switching off always works');
  } finally { await setFlagUi(ap, 'trading.one_click', true); }
  await clean(page, 'ticket 1-Click'); await clean(other, 'ticket 1-Click (other browser)'); await clean(ap, 'admin');
  await page.context().close(); await other.context().close(); await ap.context().close();
});

// ------------------------------------------------------------------------------------------------ orders, positions, alerts
test('open orders: amend price and size, cancel; positions: close at market and at the bid; price alerts: create and delete', async () => {
  const di = await member('di');
  const t = T0();
  const rest = await di.call('POST', `/v1/users/${di.uid}/orders`, { ticker: t, side: 'yes', action: 'buy', type: 'limit', count: 4, price_dollars: '0.0200' });
  assert.equal(rest.status, 201, rest.text);
  const oid = rest.body.order.order_id;
  const page = await newPage();
  await logIn(page, email('di'));
  await openPro(page, `?market=${t}`);
  const row = page.locator(`[data-testid=pro-order-row][data-order="${oid}"]`);
  await row.waitFor();
  await row.locator('[data-testid=pro-order-amend]').click();
  await page.fill('[data-testid=pro-amend-price]', '3');
  await page.fill('[data-testid=pro-amend-count]', '7');
  await page.click('[data-testid=pro-amend-save]');
  await eventually(() => { const o = q1('SELECT price_cc, remaining_count, status FROM orders WHERE id=?', oid); return o.price_cc === 300 && o.remaining_count === 700 && o.status === 'resting'; }, { label: 'amended order' });
  await page.waitForFunction((id) => document.querySelector(`[data-order="${id}"] [data-testid=pro-order-left]`)?.textContent === '7', oid);
  await page.locator(`[data-testid=pro-order-row][data-order="${oid}"] [data-testid=pro-order-cancel]`).click();
  await eventually(() => q1('SELECT status FROM orders WHERE id=?', oid).status === 'canceled', { label: 'canceled order' });
  await page.waitForSelector('[data-testid=pro-no-orders]');
  // Positions: buy 5 YES at market, close at market; buy again, close at the best bid.
  const pos = () => q1('SELECT yes_count, no_count FROM positions WHERE user_id=? AND market_ticker=?', di.uid, t) || { yes_count: 0, no_count: 0 };
  for (const how of ['market', 'bid']) {
    const b = await di.call('POST', `/v1/users/${di.uid}/orders`, { ticker: t, side: 'yes', action: 'buy', type: 'market', count: 5 });
    assert.equal(b.status, 201, b.text);
    await eventually(() => pos().yes_count > 0, { label: 'bought' });
    const pr = page.locator(`[data-testid=pro-position-row][data-position="${t}"]`);
    await pr.waitFor();
    await pr.locator(how === 'market' ? '[data-testid=pro-close-market]' : '[data-testid=pro-close-bid]').click();
    await eventually(() => pos().yes_count === 0, { label: `closed at ${how}` });
    await page.waitForSelector('[data-testid=pro-no-positions]');
  }
  assert.equal(q1("SELECT COUNT(*) c FROM orders WHERE user_id=? AND status='resting'", di.uid).c, 0, 'closing left no resting sell');
  // Price alerts on the selected market.
  await page.fill('[data-testid=pro-alert-price]', '77');
  await page.click('[data-testid=pro-alert-add]');
  const a = await eventually(() => q1('SELECT * FROM price_targets WHERE user_id=? AND market_ticker=?', di.uid, t), { label: 'alert row' });
  assert.equal(a.price_cents, 77); assert.equal(a.direction, 'above');
  await page.waitForSelector('[data-testid=pro-alert-row]');
  await page.click('[data-testid=pro-alert-delete]');
  await eventually(() => !q1('SELECT 1 x FROM price_targets WHERE id=?', a.id), { label: 'alert deleted' });
  await page.waitForSelector('[data-testid=pro-no-alerts]');
  await clean(page, 'orders / positions / alerts');
  await page.context().close();
});

// ------------------------------------------------------------------------------------------------ layout
const order = (page) => page.$$eval('#pro-grid > [data-panel]', (els) => els.filter((e) => !e.hidden).map((e) => e.dataset.panel));
test('layout: hide, move and drag panels; saved in the database, restored after a reload and in another browser', async () => {
  const ev = await member('ev', 0);
  const page = await newPage({ width: 1500, height: 2400 }); // every panel on screen: a native drag must not scroll
  await logIn(page, email('ev'));
  await openPro(page);
  assert.deepEqual(await order(page), ['screener', 'chart', 'ladder', 'ticket', 'orders', 'positions', 'tape', 'alerts']);
  await page.click('[data-testid=pro-layout-btn]');
  await page.uncheck('[data-layout-panel=tape] [data-show]');
  await page.click('[data-layout-panel=alerts] [data-move="-1"]');
  await page.click('[data-layout-panel=alerts] [data-move="-1"]');
  await page.click('[data-testid=panel-ladder] [data-hide]');
  // Drag the positions panel by its handle onto the chart panel: it takes the chart's place.
  await page.waitForSelector('[data-testid=pro-chart], [data-testid=pro-chart-empty]');
  await page.waitForSelector('[data-testid=pro-no-positions]');
  await page.locator('[data-testid=panel-positions] [data-grip]').dragTo(page.locator('[data-testid=panel-chart]'));
  const want = ['screener', 'positions', 'chart', 'ticket', 'orders', 'alerts'];
  await page.waitForFunction((w) => [...document.querySelectorAll('#pro-grid > [data-panel]')].filter((e) => !e.hidden).map((e) => e.dataset.panel).join() === w.join(), want);
  const stored = await eventually(() => { const r = q1('SELECT layout_json j FROM pro_prefs WHERE user_id=?', ev.uid); const l = r && JSON.parse(r.j); return l && l.order.filter((x) => !l.hidden.includes(x)).join() === want.join() && l; }, { label: 'stored layout' });
  assert.deepEqual([...stored.hidden].sort(), ['ladder', 'tape']);
  await openPro(page);
  assert.deepEqual(await order(page), want, 'after reload');
  assert.equal(await page.isHidden('[data-testid=panel-tape]'), true);
  // Another browser, same member: the same layout.
  const other = await newPage({ width: 1300, height: 1000 });
  await logIn(other, email('ev'));
  await other.goto(`${BASE}/pro`);
  await other.waitForSelector('[data-testid=pro-row]');
  assert.deepEqual(await order(other), want, 'in another browser');
  // Reset brings every panel back.
  await other.click('[data-testid=pro-layout-btn]');
  await other.click('[data-testid=pro-layout-reset]');
  await eventually(() => JSON.parse(q1('SELECT layout_json j FROM pro_prefs WHERE user_id=?', ev.uid).j).hidden.length === 0, { label: 'reset stored' });
  assert.equal((await ev.call('PUT', `/v1/users/${ev.uid}/pro/preferences`, { layout: { order: ['chart', 'chart'] } })).status, 400);
  assert.equal((await ev.call('PUT', `/v1/users/${ev.uid}/pro/preferences`, { layout: { hidden: ['nope'] } })).status, 400);
  await clean(page, 'layout'); await clean(other, 'layout (other browser)');
  await page.context().close(); await other.context().close();
});

// ------------------------------------------------------------------------------------------------ no layout jump
test('first page after sign-in: the panels keep their place while the data loads (no layout jump)', async () => {
  await member('hu');
  const page = await newPage();
  await logIn(page, email('hu'));
  const tops = () => page.$$eval('#pro-grid > [data-panel]', (els) => Object.fromEntries(els.map((e) => [e.dataset.panel, Math.round(e.getBoundingClientRect().top + window.scrollY)])));
  await page.goto(`${BASE}/pro`);
  await page.waitForSelector('#pro-grid');
  const first = await tops();
  await page.waitForSelector('[data-testid=pro-row]');
  await page.waitForSelector('[data-testid=pro-chart], [data-testid=pro-chart-empty]');
  await page.waitForSelector('[data-testid=ladder-level]');
  await page.waitForSelector('[data-testid=pro-ticket]');
  await page.waitForSelector('[data-testid=pro-no-orders], [data-testid=pro-orders]');
  await page.waitForTimeout(500);
  const loaded = await tops();
  for (const id of Object.keys(first)) assert.ok(Math.abs(loaded[id] - first[id]) <= 2, `${id} moved from ${first[id]} to ${loaded[id]}`);
  await clean(page, 'no layout jump');
  await page.context().close();
});

// ------------------------------------------------------------------------------------------------ signed out + mobile
test('signed-out visitors see the screener and chart, trading panels ask to sign in; 390px wide without horizontal scroll', async () => {
  const page = await newPage({ width: 390, height: 844 });
  await openPro(page);
  await page.waitForSelector('[data-testid=pro-chart], [data-testid=pro-chart-empty]');
  for (const id of ['ticket', 'orders', 'positions', 'alerts']) assert.equal(await page.locator(`[data-testid=panel-${id}] [data-testid=pro-sign-in]`).count(), 1, `${id} asks to sign in`);
  const anon = await new Client(BASE, 'anon').boot();
  assert.equal((await anon.call('GET', '/v1/pro/screener')).status, 200);
  assert.equal((await anon.call('GET', '/v1/users/x/pro/preferences')).status, 401);
  // Shortcuts do nothing for a visitor (no ticket to change, no error).
  await page.keyboard.press('b'); await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(over <= 0, `signed out: overflows by ${over}px`);
  await clean(page, 'signed out mobile');
  await page.context().close();
  // A member on a phone: panels stack, the ticket and tables stay inside the screen.
  await member('fe');
  const m = await newPage({ width: 390, height: 844 });
  await logIn(m, email('fe'));
  await openPro(m);
  await m.waitForSelector('[data-testid=pro-ticket]');
  const xs = await m.$$eval('#pro-grid > [data-panel]', (els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
  assert.equal(new Set(xs).size, 1, 'one column');
  const over2 = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(over2 <= 0, `member: overflows by ${over2}px`);
  await clean(m, 'member mobile');
  await m.context().close();
});

test('the pro flag off shows the managed "not available" page and refuses the Pro API; on again restores it', async () => {
  const admin = await new Client(BASE, 'admin').logIn(ADMIN.email, PW);
  const set = (enabled) => admin.call('PUT', '/v1/admin/flags/pro', { enabled, reason: `pro e2e flag ${enabled ? 'on' : 'off'}` });
  assert.equal((await set(false)).status, 200);
  try {
    const page = await newPage();
    await page.goto(`${BASE}/pro`);
    await page.waitForSelector('[data-testid=feature-unavailable][data-feature=pro]');
    assert.equal(await page.locator('.primary-nav [data-nav=pro]').evaluate((e) => getComputedStyle(e).display), 'none');
    const r = await (await new Client(BASE, 'anon').boot()).call('GET', '/v1/pro/screener');
    assert.equal(r.status, 403); assert.equal(r.code, 'feature_disabled');
    await clean(page, 'flag off');
    await page.context().close();
  } finally { assert.equal((await set(true)).status, 200); }
  assert.equal((await (await new Client(BASE, 'anon').boot()).call('GET', '/v1/pro/screener')).status, 200);
});

// ------------------------------------------------------------------------------------------------ owner setting pro.layout
test('owner setting pro.layout: Admin switches /pro to the classic screener (audited, live) and it stays after a restart; terminal again', async () => {
  await member('ix');
  const page = await newPage();
  await logIn(page, email('ix'));
  await openPro(page);
  const ap = await newPage({ width: 1400, height: 1000 });
  await logIn(ap, ADMIN.email);
  await ap.goto(`${BASE}/admin/owner_settings`);
  const row = '[data-testid=owner-setting][data-key="pro.layout"]';
  await ap.waitForSelector(`${row}[data-value="terminal"]`);
  assert.match(await ap.textContent(row), /Pro page layout/);
  await ap.click(`${row} [data-testid=owner-edit]`);
  await ap.waitForSelector('[data-testid=owner-form]');
  assert.match(await ap.textContent('[data-testid=owner-dialog]'), /Recommended: terminal/);
  await ap.selectOption('[data-testid=owner-form] [name=value]', 'classic');
  await ap.fill('[data-testid=owner-form] [name=reason]', 'pro e2e: classic screener');
  await ap.click('[data-testid=owner-form] button[type=submit]');
  await ap.waitForSelector(`${row}[data-value="classic"]`);
  // Live on the member's open page: the classic table replaces the terminal.
  await page.waitForSelector('[data-testid=pro-classic]', { timeout: 15000 });
  assert.equal(await page.locator('[data-testid=pro-terminal]').count(), 0);
  assert.ok(await page.locator('[data-testid=pro-table] tbody tr').count() >= 20);
  const audit = q1("SELECT * FROM admin_audit WHERE action='owner_settings.update' AND target_id='pro.layout' ORDER BY ts DESC LIMIT 1");
  assert.equal(audit.reason, 'pro e2e: classic screener'); assert.deepEqual(JSON.parse(audit.after_json), { value: 'classic' });
  await clean(page, 'classic'); await clean(ap, 'admin owner settings');
  await page.context().close(); await ap.context().close();
  // A restart keeps it.
  await srv.close();
  srv = await start(OPTS());
  BASE = `http://127.0.0.1:${srv.port}`;
  const p2 = await newPage();
  await p2.goto(`${BASE}/pro`);
  await p2.waitForSelector('[data-testid=pro-classic]');
  const admin = await new Client(BASE, 'admin').logIn(ADMIN.email, PW);
  assert.equal((await admin.call('PUT', '/v1/admin/owner_settings/pro.layout', { value: 'terminal', reason: 'pro e2e: back to the terminal' })).status, 200);
  await p2.goto(`${BASE}/pro`);
  await p2.waitForSelector('[data-testid=pro-terminal]');
  await clean(p2, 'after restart');
  await p2.context().close();
});
