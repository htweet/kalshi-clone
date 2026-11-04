'use strict';
// End-to-end tests for combos (CLONE_SPEC §17): the /combos builder with a DB-persisted slip, the
// simulated maker's RFQ quote with countdown → Accept → Confirming… → executed through the engine, deterministic
// idempotent combo markets and leg validation, quote expiry / re-quote / cancel, combo mode on the event page,
// leg-driven resolution (NO as soon as a leg misses, YES when all hit) with normal settlement, order-book trading
// on a combo, portfolio open combos, restart and 390px layouts. Real server + SQLite + Chromium.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-combos-'));
const DB_FILE = path.join(TMP, 'combos.db');
const PORT = 4530 + Math.floor(Math.random() * 30);
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'correct-horse-9';
const OPTS = { port: PORT, dbFile: DB_FILE, tickMs: 250, admin: { email: 'admin@parlance.local', password: 'Ledger-Keeper-2026!' }, combos: { makerDelayMs: 150, autoConfirmMs: 400, quoteTtlMs: 4000 } };
const CUT = 'PLXRATE-26DEC-CUT';
const RAV = 'PLXCUP-26FINAL-RAV';
const HOLD = 'PLXRATE-26DEC-HOLD';
const user = { email: `cb.${Date.now()}@example.test`, name: 'Casey Combo' };

let srv; let browser;
let comboTicker = null;
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const uid = () => dbq('SELECT id FROM users WHERE email=?', user.email)[0].id;
const bal = () => dbq('SELECT balance_cents b FROM users WHERE id=?', uid())[0].b;
async function newPage(viewport = { width: 1600, height: 1000 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  return page;
}
async function logIn(page, email = user.email, pw = PW) {
  await page.goto(BASE + '/sign-in');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', pw);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
}
const call = (page, method, url, body) => page.evaluate(async ([m, u, b]) => {
  const csrf = JSON.parse(localStorage.getItem('csrfToken')).value;
  const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: b ? JSON.stringify(b) : undefined });
  return { s: r.status, b: await r.json() };
}, [method, url, body]);
const until = async (page, fn, ms = 15000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out waiting for DB condition'); await page.waitForTimeout(150); } };
const legs2 = [{ market_ticker: CUT, side: 'yes' }, { market_ticker: RAV, side: 'no' }];

before(async () => { srv = await start(OPTS); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('Live rail ◇ COMBO opens the builder; the slip and amount persist in the DB across contexts', async () => {
  const page = await newPage();
  await page.goto(BASE + '/sign-up');
  await page.fill('input[name=display_name]', user.name);
  await page.fill('input[name=email]', user.email);
  await page.fill('input[name=password]', PW);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
  await page.goto(BASE + '/portfolio');
  await page.fill('#f-amount', '20000');
  await page.click('[data-act=deposit]');
  await page.waitForSelector('[data-testid=header-balance]:has-text("₦20,000")');
  await page.goto(BASE + '/live');
  await page.click('[data-testid=combo-rail-btn]');
  await page.waitForURL(BASE + '/combos');
  await page.waitForSelector('[data-testid=combos-title]:has-text("Build a combo")');
  assert.equal(await page.isDisabled('[data-testid=request-quote]'), true);
  await page.click(`[data-testid=combo-market][data-ticker="${CUT}"] [data-leg-side=yes]`);
  await page.waitForSelector('#combo-error:has-text("one more leg")');
  // Two legs from the same event: the second replaces the first.
  await page.click(`[data-testid=combo-market][data-ticker="${HOLD}"] [data-leg-side=yes]`);
  await page.waitForSelector(`[data-testid=slip-leg][data-leg="${HOLD}"]`);
  assert.equal(await page.locator('[data-testid=slip-leg]').count(), 1);
  await page.click(`[data-testid=combo-market][data-ticker="${CUT}"] [data-leg-side=yes]`);
  await page.click(`[data-testid=combo-market][data-ticker="${RAV}"] [data-leg-side=no]`);
  await page.waitForSelector('[data-testid=slip-count]:has-text("2/6")');
  const q = await call(page, 'GET', `/trade-api/v2/markets/${CUT}`);
  const r = await call(page, 'GET', `/trade-api/v2/markets/${RAV}`);
  const pc = Math.round(Number(q.b.market.last_price_dollars) * 100); const pr = Math.round(Number(r.b.market.last_price_dollars) * 100);
  assert.equal(await page.textContent('[data-testid=slip-odds]'), `${((pc / 100) * ((100 - pr) / 100) * 100).toFixed(1)}%`);
  await page.fill('#combo-amount', '1250');
  await page.locator('#combo-amount').blur();
  await page.waitForTimeout(500);
  const slip = dbq('SELECT * FROM combo_slips WHERE user_id=?', uid())[0];
  assert.deepEqual(JSON.parse(slip.legs).map((l) => [l.market_ticker, l.side]), [[CUT, 'yes'], [RAV, 'no']]);
  assert.equal(slip.amount_cents, 1250);
  await page.context().close();
  const p2 = await newPage();
  await logIn(p2);
  await p2.goto(BASE + '/combos');
  await p2.waitForSelector('[data-testid=slip-count]:has-text("2/6")');
  assert.equal(await p2.inputValue('#combo-amount'), '12.5');
  assert.deepEqual(p2.errors, []);
  await p2.context().close();
});

test('request quote → countdown → Accept → Confirming… → executed through the engine (fills, fees, positions)', async () => {
  const page = await newPage();
  await logIn(page);
  await page.goto(BASE + '/combos');
  await page.waitForSelector('[data-testid=slip-count]:has-text("2/6")');
  const before = bal();
  await page.click('[data-testid=request-quote]');
  await page.waitForSelector('[data-testid=accept-quote]', { timeout: 10000 });
  assert.match(await page.textContent('[data-testid=accept-quote]'), /Accept · \d+s/);
  const price = Number((await page.textContent('[data-testid=quote-price]')).match(/Yes ₦(\d+)/)[1]);
  const qtyShown = await page.textContent('[data-testid=quote-contracts]');
  const rfq = dbq('SELECT * FROM rfqs WHERE user_id=?', uid())[0];
  comboTicker = rfq.market_ticker;
  assert.equal(rfq.target_cost_cents, 1250);
  const quote = dbq('SELECT * FROM rfq_quotes WHERE rfq_id=?', rfq.id)[0];
  assert.equal(100 - quote.no_bid_cents, price);
  assert.ok(quote.yes_bid_cents + quote.no_bid_cents <= 100);
  await page.click('[data-testid=accept-quote]');
  await page.waitForSelector('[data-testid=quote-state]:has-text("Confirming…"), [data-testid=quote-executed]');
  await page.waitForSelector('[data-testid=quote-executed]', { timeout: 10000 });
  await page.waitForSelector('.toast:has-text("Combo executed")');
  const qx = dbq('SELECT * FROM rfq_quotes WHERE id=?', quote.id)[0];
  assert.deepEqual([qx.status, qx.accepted_side, dbq('SELECT status FROM rfqs WHERE id=?', rfq.id)[0].status], ['executed', 'no', 'executed']);
  assert.equal(qx.executed_units, Math.round(Number(qtyShown) * 100));
  const taker = dbq('SELECT * FROM orders WHERE id=?', qx.taker_order_id)[0];
  assert.deepEqual([taker.user_id, taker.side, taker.price_cents, taker.order_type, taker.status], [uid(), 'yes', price, 'rfq', 'executed']);
  const fills = dbq('SELECT * FROM fills WHERE order_id=?', taker.id);
  assert.equal(fills.length, 1);
  const cost = Math.ceil((fills[0].count * price) / 100) + fills[0].fee_cents;
  assert.equal(before - bal(), cost);
  assert.ok(cost <= 1250, 'target cost includes fees');
  assert.equal(fills[0].fee_cents, Math.ceil((7 * fills[0].count * price * (100 - price)) / 1000000));
  assert.equal(dbq('SELECT yes_count FROM positions WHERE user_id=? AND market_ticker=?', uid(), comboTicker)[0].yes_count, qx.executed_units);
  const m = dbq('SELECT * FROM markets WHERE ticker=?', comboTicker)[0];
  assert.deepEqual([m.fractional_trading_enabled, m.mve_collection_ticker, m.status], [1, 'PLXCOMBO', 'active']);
  assert.match(m.title, /Yes Cut/); assert.match(m.title, /No Ravens/);
  assert.equal(dbq('SELECT COUNT(*) c FROM combo_legs WHERE combo_ticker=?', comboTicker)[0].c, 2);
  assert.equal(JSON.parse(dbq('SELECT legs FROM combo_slips WHERE user_id=?', uid())[0]?.legs || '[]').length, 0, 'slip cleared after execution');
  assert.ok(dbq("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='rfq_executed'", uid())[0].c >= 1);
  // Portfolio → Positions lists the open combo with its legs.
  await page.goto(BASE + '/portfolio?tab=positions');
  await page.waitForSelector(`[data-testid=positions-table] tr[data-combo="${comboTicker}"]`);
  assert.equal(await page.textContent('[data-testid=open-combo-count]'), '1');
  assert.equal(await page.locator(`tr[data-combo="${comboTicker}"] [data-leg-status=pending]`).count(), 2);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('combo API: deterministic idempotent tickers and leg validation', async () => {
  const page = await newPage();
  await logIn(page);
  const U = '/v1/multivariate_event_collections/PLXCOMBO/markets';
  let r = await call(page, 'POST', U, { selected_markets: [...legs2].reverse() });
  assert.deepEqual([r.s, r.b.market_ticker, r.b.created], [200, comboTicker, false]);
  assert.equal(r.b.market.fractional_trading_enabled, true);
  assert.deepEqual(r.b.market.mve_selected_legs.map((l) => l.market_ticker), [RAV, CUT].sort());
  r = await call(page, 'POST', U, { selected_markets: [legs2[0]] });
  assert.deepEqual([r.s, r.b.error.code], [400, 'invalid_leg_count']);
  r = await call(page, 'POST', U, { selected_markets: [legs2[0], { market_ticker: HOLD, side: 'no' }] });
  assert.deepEqual([r.s, r.b.error.code], [400, 'duplicate_event']);
  r = await call(page, 'POST', U, { selected_markets: [legs2[0], { market_ticker: comboTicker, side: 'yes' }] });
  assert.deepEqual([r.s, r.b.error.code], [400, 'invalid_leg']);
  const flash = dbq("SELECT ticker FROM markets WHERE event_ticker LIKE 'PLXFLASH-%' AND status='active' LIMIT 1")[0].ticker;
  r = await call(page, 'POST', U, { selected_markets: [legs2[0], { market_ticker: flash, side: 'yes' }] });
  assert.deepEqual([r.s, r.b.error.code], [400, 'invalid_leg']);
  r = await call(page, 'POST', U, { selected_markets: [legs2[0], { market_ticker: 'PLXGADGET-27SOON', side: 'yes' }] });
  assert.deepEqual([r.s, r.b.error.code], [400, 'invalid_leg']); // not yet open
  r = await call(page, 'POST', U, { selected_markets: [legs2[0], { market_ticker: RAV, side: 'maybe' }] });
  assert.equal(r.s, 400);
  r = await call(page, 'POST', U, { selected_markets: [...legs2, { market_ticker: 'PLXFILM-27PIC-PAPER', side: 'yes' }] });
  assert.deepEqual([r.s, r.b.created], [201, true]);
  assert.notEqual(r.b.market_ticker, comboTicker);
  const coll = await call(page, 'GET', '/v1/multivariate_event_collections/PLXCOMBO');
  assert.ok(coll.b.multivariate_contract.events.every((e) => !e.series_ticker.startsWith('PLXCOMBO') && !e.series_ticker.startsWith('PLXFLASH')));
  // Combo events stay out of discovery lists.
  const home = await call(page, 'GET', '/v1/search/series?status=open&page_size=100');
  assert.ok(home.b.current_page.every((e) => e.series_ticker !== 'PLXCOMBO'));
  await page.context().close();
});

test('quote expiry: an unaccepted quote expires, the maker re-quotes, the requester cancels the RFQ', async () => {
  const page = await newPage();
  await logIn(page);
  let r = await call(page, 'POST', '/v1/communications/rfqs', { market_ticker: comboTicker, contracts_fp: '3.5' });
  assert.equal(r.s, 201);
  const id = r.b.id;
  assert.equal(dbq('SELECT contracts_units u FROM rfqs WHERE id=?', id)[0].u, 350);
  r = await call(page, 'POST', '/v1/communications/rfqs', { market_ticker: comboTicker, contracts_fp: '1' });
  assert.deepEqual([r.s, r.b.error.code], [409, 'rfq_exists']);
  await until(page, () => dbq('SELECT 1 FROM rfq_quotes WHERE rfq_id=?', id).length >= 1);
  const first = dbq('SELECT * FROM rfq_quotes WHERE rfq_id=? ORDER BY created_ts', id)[0];
  assert.deepEqual([first.yes_units, first.no_units], [350, 350]);
  await until(page, () => dbq("SELECT status FROM rfq_quotes WHERE id=?", first.id)[0].status === 'expired', 10000);
  assert.equal(dbq("SELECT closed_reason FROM rfq_quotes WHERE id=?", first.id)[0].closed_reason, 'quote_ttl');
  await until(page, () => dbq("SELECT 1 FROM rfq_quotes WHERE rfq_id=? AND status='open'", id).length === 1, 5000);
  r = await call(page, 'PUT', `/v1/communications/rfqs/${id}/quotes/${first.id}/accept`, { accepted_side: 'no' });
  assert.deepEqual([r.s, r.b.error.code], [409, 'quote_expired']);
  await page.goto(BASE + '/portfolio?tab=rfqs');
  await page.waitForSelector(`tr[data-rfq="${id}"] [data-accept]`);
  await page.click(`tr[data-rfq="${id}"] [data-cancel-rfq]`);
  await page.waitForSelector(`tr[data-rfq="${id}"][data-status=cancelled]`);
  assert.equal(dbq('SELECT status FROM rfqs WHERE id=?', id)[0].status, 'cancelled');
  assert.equal(dbq("SELECT COUNT(*) c FROM rfq_quotes WHERE rfq_id=? AND status='open'", id)[0].c, 0);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('event page combo mode: Yes/No on outcome rows add/remove legs in the persisted slip', async () => {
  const page = await newPage();
  await logIn(page);
  await page.goto(BASE + '/markets/plxrate/central-bank-decision/plxrate-26dec');
  await page.click('[data-testid=combo-toggle]');
  await page.waitForSelector('[data-testid=combo-mini]');
  await page.click(`tr[data-ticker="${HOLD}"] [data-pick=no]`);
  await page.waitForSelector(`[data-testid=combo-mini] [data-leg="${HOLD}"]`);
  assert.equal(await page.getAttribute(`tr[data-ticker="${HOLD}"] [data-pick=no]`, 'class'), 'no-btn on');
  assert.deepEqual(JSON.parse(dbq('SELECT legs FROM combo_slips WHERE user_id=?', uid())[0].legs).map((l) => [l.market_ticker, l.side]), [[HOLD, 'no']]);
  // The ticket did not change selection while picking legs; clicking again removes the leg.
  await page.click(`tr[data-ticker="${HOLD}"] [data-pick=no]`);
  await page.waitForSelector('[data-testid=combo-leg-count]:has-text("0/6")');
  await page.click(`tr[data-ticker="${HOLD}"] [data-pick=yes]`);
  await page.goto(BASE + '/markets/plxcup/northern-cup-final/plxcup-26final');
  await page.click('[data-testid=combo-toggle]');
  await page.click(`tr[data-ticker="${RAV}"] [data-pick=yes]`);
  await page.waitForSelector('[data-testid=combo-leg-count]:has-text("2/6")');
  await page.click('[data-testid=combo-open]');
  await page.waitForURL(BASE + '/combos');
  await page.waitForSelector(`[data-testid=slip-leg][data-leg="${RAV}"]`);
  assert.equal(await page.locator('[data-testid=slip-leg]').count(), 2);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('resolution: legs drive the combo (NO as soon as one misses, YES when all hit), normal settlement pays', async () => {
  const page = await newPage();
  await logIn(page);
  // Combo B (two other events) traded on its order book: a resting limit order, then a leg misses.
  let r = await call(page, 'POST', '/v1/multivariate_event_collections/PLXCOMBO/markets', { selected_markets: [{ market_ticker: 'PLXFILM-27PIC-LIGHTHOUSE', side: 'yes' }, { market_ticker: 'PLXHOOPS-27CHAMP-HAWKS', side: 'yes' }] });
  const comboB = r.b.market_ticker;
  r = await call(page, 'POST', `/v1/users/${uid()}/orders`, { ticker: comboB, side: 'yes', type: 'limit', price: 12, count: 2.5 });
  assert.deepEqual([r.s, r.b.order.status], [201, 'resting']);
  await page.goto(BASE + `/markets/plxcombo/combos/${comboTicker.toLowerCase()}`);
  await page.waitForSelector('[data-testid=combo-legs] [data-testid=combo-leg]');
  assert.equal(await page.locator('[data-testid=combo-leg][data-leg-status=pending]').count(), 2);
  const admin = await newPage();
  await logIn(admin, 'admin@parlance.local', 'Ledger-Keeper-2026!');
  const before = bal();
  const units = dbq('SELECT yes_count FROM positions WHERE user_id=? AND market_ticker=?', uid(), comboTicker)[0].yes_count;
  // Ravens lose → the "No Ravens" leg wins; the combo waits for the Cut leg.
  assert.equal((await call(admin, 'POST', `/v1/admin/markets/${RAV}/determine`, { result: 'no' })).s, 200);
  await page.waitForSelector('[data-testid=combo-leg][data-leg-status=won]');
  assert.equal(dbq('SELECT status FROM markets WHERE ticker=?', comboTicker)[0].status, 'active');
  // A leg of combo B misses → combo B is determined NO immediately even though its other leg is pending.
  assert.equal((await call(admin, 'POST', '/v1/admin/markets/PLXFILM-27PIC-LIGHTHOUSE/determine', { result: 'no' })).s, 200);
  await until(page, () => dbq('SELECT result FROM markets WHERE ticker=?', comboB)[0].result === 'no', 5000);
  assert.equal(dbq('SELECT status FROM orders WHERE user_id=? AND market_ticker=?', uid(), comboB)[0].status, 'canceled');
  // Cut resolves YES → every leg hit → combo YES → payout q cents per q units.
  assert.equal((await call(admin, 'POST', `/v1/admin/markets/${CUT}/determine`, { result: 'yes' })).s, 200);
  await page.waitForSelector('[data-testid=ticket-closed]:has-text("YES")', { timeout: 15000 });
  assert.equal(await page.locator('[data-testid=combo-leg][data-leg-status=won]').count(), 2);
  await until(page, () => dbq('SELECT 1 FROM settlements WHERE user_id=? AND market_ticker=?', uid(), comboTicker).length === 1, 15000);
  const s = dbq('SELECT * FROM settlements WHERE user_id=? AND market_ticker=?', uid(), comboTicker)[0];
  assert.deepEqual([s.result, s.yes_count, s.payout_cents], ['yes', units, units]);
  assert.ok(bal() >= before + units);
  await page.goto(BASE + '/portfolio?tab=positions');
  await page.waitForSelector(`[data-testid=settled-combos] tr[data-combo="${comboTicker}"]`);
  assert.deepEqual(page.errors, []);
  await page.context().close(); await admin.context().close();
});

test('restart keeps combos, RFQs and quotes; 390px layouts have no horizontal overflow', async () => {
  const before = dbq('SELECT status FROM rfq_quotes ORDER BY created_ts').map((r) => r.status);
  await srv.close();
  srv = await start(OPTS);
  assert.deepEqual(dbq('SELECT status FROM rfq_quotes ORDER BY created_ts').map((r) => r.status), before);
  const page = await newPage({ width: 390, height: 844 });
  await logIn(page);
  for (const p of ['/combos', `/markets/plxcombo/combos/${comboTicker.toLowerCase()}`, '/portfolio?tab=rfqs', '/portfolio?tab=positions', '/markets/plxrate/central-bank-decision/plxrate-26dec']) {
    await page.goto(BASE + p);
    await page.waitForSelector('main *');
    await page.waitForTimeout(500);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(over <= 0, `${p} overflows by ${over}px`);
  }
  await page.goto(BASE + '/portfolio?tab=rfqs');
  await page.waitForSelector('[data-testid=rfqs-table] tr[data-status=executed]');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
