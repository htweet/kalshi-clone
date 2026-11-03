'use strict';
// End-to-end tests for fractional contracts (COMBOS_FRACTIONAL_SPEC §16): quantities stored as units (hundredths),
// exact conserving cent rounding, fractional Contracts / Dollars / Sell in the ticket, whole-contract markets
// rejecting fractions, the "Hide fractional shares" order-book setting, fractional settlement, the one-time
// migration of an old whole-contract database, restart and the 390px layout. Real server + SQLite + Chromium.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-frac-'));
const DB_FILE = path.join(TMP, 'frac.db');
const OLD_DB = path.join(TMP, 'old.db');
const PORT = 4480 + Math.floor(Math.random() * 30);
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'correct-horse-9';
const RATE_URL = '/markets/plxrate/central-bank-decision/plxrate-26dec';
const SEN_URL = '/markets/plxstate/harbor-state-elections/plxstate-26sen';
const CUT = 'PLXRATE-26DEC-CUT';
const BLUE = 'PLXSTATE-26SEN-BLUE';
const user = { email: `fr.${Date.now()}@example.test`, name: 'Frankie Fraction' };

let srv; let browser;
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const uid = () => dbq('SELECT id FROM users WHERE email=?', user.email)[0].id;
const bal = () => dbq('SELECT balance_cents b FROM users WHERE id=?', uid())[0].b;
const pos = (t = CUT) => dbq('SELECT yes_count, no_count FROM positions WHERE user_id=? AND market_ticker=?', uid(), t)[0] || { yes_count: 0, no_count: 0 };
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
async function mode(page, m) { await page.click('#t-mode-btn'); await page.click(`[data-otype=${m}]`); }
const call = (page, method, url, body) => page.evaluate(async ([m, u, b]) => {
  const csrf = JSON.parse(localStorage.getItem('csrfToken')).value;
  const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: b ? JSON.stringify(b) : undefined });
  return { s: r.status, b: await r.json() };
}, [method, url, body]);
const bookRows = (page) => page.$$eval('[data-testid=orderbook] .book-row', (rs) => rs.map((r) => [r.children[1].textContent, r.children[2].textContent]));
// Cash a taker paid for an order: ceil(q·p/100) per fill plus the fee (COMBOS_FRACTIONAL_SPEC §16.2).
const takerCost = (orderId) => dbq('SELECT count c, price_cents p, fee_cents f FROM fills WHERE order_id=?', orderId).reduce((a, f) => a + Math.ceil((f.c * f.p) / 100) + f.f, 0);

before(async () => { srv = await start({ port: PORT, dbFile: DB_FILE, tickMs: 300, admin: { email: 'admin@parlance.local', password: 'Ledger-Keeper-2026!' } }); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('fractional buy in Contracts mode: 2.55 contracts, exact conserving cents, stored as 255 units', async () => {
  const page = await newPage();
  await page.goto(BASE + '/sign-up');
  await page.fill('input[name=display_name]', user.name);
  await page.fill('input[name=email]', user.email);
  await page.fill('input[name=password]', PW);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
  await page.goto(BASE + '/portfolio');
  await page.fill('#f-amount', '100');
  await page.click('[data-act=deposit]');
  await page.waitForSelector('[data-testid=header-balance]:has-text("$100.00")');

  const mk = (await call(page, 'GET', `/trade-api/v2/markets/${CUT}`)).b.market;
  assert.equal(mk.fractional_trading_enabled, true);
  assert.equal((await call(page, 'GET', `/trade-api/v2/markets/${BLUE}`)).b.market.fractional_trading_enabled, false);
  const ask = Math.round(Number(mk.yes_ask_dollars) * 100);
  await page.goto(BASE + RATE_URL);
  await page.click(`tr[data-ticker="${CUT}"] [data-pick=yes]`);
  await mode(page, 'market');
  assert.equal(await page.getAttribute('#t-count', 'step'), '0.01');
  await page.fill('#t-count', '2.55');
  await page.click('[data-testid=submit-order]');
  await page.waitForSelector('.toast:has-text("Filled 2.55 YES")');
  assert.equal(pos().yes_count, 255);
  const o = dbq("SELECT * FROM orders WHERE user_id=? ORDER BY seq DESC LIMIT 1", uid())[0];
  assert.deepEqual([o.initial_count, o.filled_count, o.status, o.order_type, o.action], [255, 255, 'executed', 'market', 'buy']);
  const f = dbq('SELECT * FROM fills WHERE order_id=?', o.id);
  assert.equal(f.length, 1); assert.equal(f[0].count, 255); assert.equal(f[0].price_cents, ask);
  const principal = Math.ceil((255 * ask) / 100);
  const fee = Math.ceil((7 * 255 * ask * (100 - ask)) / 1000000);
  assert.equal(f[0].fee_cents, fee);
  assert.equal(bal(), 10000 - principal - fee);
  // Conservation: taker ceil share + maker remainder = 255 cents for 2.55 pairs-worth of contracts.
  const legs = dbq("SELECT amount_cents a FROM ledger WHERE ref=? AND kind='trade'", f[0].trade_id).map((r) => r.a);
  assert.equal(legs.length, 2); assert.equal(legs.reduce((a, b) => a + b, 0), -255);
  // API surface: fixed-point strings with 2 decimals.
  const fills = (await call(page, 'GET', `/v1/users/${uid()}/fills`)).b.fills;
  assert.equal(fills[0].count_fp, '2.55');
  const p = (await call(page, 'GET', `/v1/users/${uid()}/positions`)).b.positions.find((x) => x.ticker === CUT);
  assert.equal(p.position_fp, '2.55');
  await page.waitForSelector('[data-testid=my-position]:has-text("2.55")');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('Dollars mode buys fractional contracts (floored to 0.01) within the amount, then fractional sells net to cash', async () => {
  const page = await newPage();
  await logIn(page);
  await page.goto(BASE + RATE_URL);
  await page.click(`tr[data-ticker="${CUT}"] [data-pick=yes]`);
  await mode(page, 'dollars');
  await page.fill('#t-amount', '5');
  const shown = (await page.textContent('[data-testid=t-contracts]')).match(/^([\d.]+) contracts/)[1];
  assert.match(shown, /^\d+\.\d{1,2}$/, `fractional estimate ${shown}`);
  const before = bal();
  const held0 = pos().yes_count;
  await page.click('[data-testid=submit-order]');
  await page.waitForSelector(`.toast:has-text("Filled ${shown} YES")`);
  const o = dbq("SELECT * FROM orders WHERE user_id=? ORDER BY seq DESC LIMIT 1", uid())[0];
  assert.equal(o.order_type, 'dollars');
  assert.equal(o.filled_count, Math.round(Number(shown) * 100));
  assert.notEqual(o.filled_count % 100, 0, 'a fractional fill');
  assert.equal(pos().yes_count, held0 + o.filled_count);
  const spent = before - bal();
  assert.equal(spent, takerCost(o.id));
  assert.ok(spent <= 500, `spent ${spent} <= $5`);

  // SELL tab shows the fractional holding and sells part of it, then the rest.
  const heldStr = ((held0 + o.filled_count) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
  await page.click('[data-testid=sell-tab]');
  await page.waitForSelector(`[data-testid=held]:has-text("${heldStr} YES")`);
  await mode(page, 'market');
  await page.fill('#t-count', '1.25');
  const b1 = bal();
  await page.click('[data-testid=submit-order]');
  await page.waitForSelector('.toast:has-text("Sold 1.25 YES")');
  assert.equal(pos().yes_count, held0 + o.filled_count - 125);
  assert.ok(bal() > b1, 'selling returns cash (netting)');
  const rest = ((held0 + o.filled_count - 125) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
  await page.waitForSelector(`[data-testid=held]:has-text("${rest} YES")`);
  await page.fill('#t-count', rest);
  await page.click('[data-testid=submit-order]');
  await page.waitForSelector(`.toast:has-text("Sold ${rest} YES")`);
  assert.deepEqual([pos().yes_count, pos().no_count], [0, 0]);
  const sold = dbq("SELECT action, order_type FROM orders WHERE user_id=? ORDER BY seq DESC LIMIT 1", uid())[0];
  assert.deepEqual([sold.action, sold.order_type], ['sell', 'market']);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('validation: >2 decimals and fractions on whole-contract markets are refused in the UI and the API', async () => {
  const page = await newPage();
  await logIn(page);
  await page.goto(BASE + RATE_URL);
  await page.click(`tr[data-ticker="${CUT}"] [data-pick=yes]`);
  await mode(page, 'market');
  await page.fill('#t-count', '1.555');
  await page.waitForSelector('[data-testid=t-invalid]:has-text("0.01 contracts")');
  assert.equal(await page.isDisabled('[data-testid=submit-order]'), true);
  await page.goto(BASE + SEN_URL);
  await page.click(`tr[data-ticker="${BLUE}"] [data-pick=yes]`);
  await mode(page, 'market');
  assert.equal(await page.getAttribute('#t-count', 'step'), '1');
  await page.fill('#t-count', '1.5');
  await page.waitForSelector('[data-testid=t-invalid]:has-text("whole number")');
  assert.equal(await page.isDisabled('[data-testid=submit-order]'), true);
  const U = `/v1/users/${uid()}/orders`;
  let r = await call(page, 'POST', U, { ticker: BLUE, side: 'yes', type: 'market', count: 1.5 });
  assert.equal(r.s, 400); assert.equal(r.b.error.code, 'fractional_not_enabled');
  r = await call(page, 'POST', U, { ticker: CUT, side: 'yes', type: 'market', count: 0.001 });
  assert.equal(r.s, 400); assert.match(r.b.error.details, /at most 2 decimal/);
  r = await call(page, 'POST', U, { ticker: CUT, side: 'yes', type: 'market', count_fp: '1.555' });
  assert.equal(r.s, 400);
  r = await call(page, 'POST', U, { ticker: CUT, side: 'yes', type: 'market', count: 0 });
  assert.equal(r.s, 400); assert.match(r.b.error.details, /at least 0.01/);
  r = await call(page, 'POST', U, { ticker: CUT, side: 'yes', type: 'market', count: 1, count_fp: '2.00' });
  assert.equal(r.s, 400); assert.match(r.b.error.details, /must match/);
  r = await call(page, 'POST', U, { ticker: CUT, side: 'yes', type: 'market', count_fp: '0.01' });
  assert.equal(r.s, 201); assert.equal(r.b.order.fill_count_fp, '0.01');
  r = await call(page, 'POST', U, { ticker: BLUE, side: 'yes', type: 'market', count_fp: '2' });
  assert.equal(r.s, 201); assert.equal(r.b.order.fill_count_fp, '2.00');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('order book: a 0.5-contract level shows, "Hide fractional shares" hides it and persists in the DB', async () => {
  const page = await newPage();
  await logIn(page);
  await page.goto(BASE + RATE_URL);
  await page.click(`tr[data-ticker="${CUT}"] [data-pick=yes]`);
  await mode(page, 'limit');
  await page.fill('#t-price', '30');
  await page.fill('#t-count', '0.5');
  await page.click('[data-testid=submit-order]');
  await page.waitForSelector('.toast:has-text("Order resting")');
  const o = dbq("SELECT * FROM orders WHERE user_id=? AND status='resting'", uid())[0];
  assert.deepEqual([o.initial_count, o.price_cents], [50, 30]);
  assert.equal(o.reserved_cents, Math.ceil((50 * (30 + 2)) / 100)); // ceil(q·(p + per-contract fee cap)/100)
  await page.click('[data-tab=book]');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=orderbook] .book-row')].some((r) => r.children[1].textContent === '30¢'));
  assert.deepEqual((await bookRows(page)).find(([p]) => p === '30¢'), ['30¢', '0.5']);
  await page.check('[data-testid=hide-fractional]');
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-testid=orderbook] .book-row')].some((r) => r.children[1].textContent === '30¢'));
  assert.ok((await bookRows(page)).every(([, n]) => !n.includes('.')), 'sizes rounded down to whole contracts');
  await page.waitForTimeout(300);
  assert.equal(JSON.parse(dbq("SELECT value FROM user_settings WHERE user_id=? AND key='orderbook_hide_fractional_shares'", uid())[0].value), true);
  await page.context().close();
  // A fresh browser context gets the setting back from the server.
  const p2 = await newPage();
  await logIn(p2);
  await p2.goto(BASE + RATE_URL);
  await p2.click(`tr[data-ticker="${CUT}"]`);
  await p2.click('[data-tab=book]');
  await p2.waitForSelector('[data-testid=hide-fractional]:checked');
  await p2.waitForSelector('[data-testid=orderbook] .book-row');
  assert.ok(!(await bookRows(p2)).some(([p]) => p === '30¢'));
  assert.deepEqual(p2.errors, []);
  await p2.context().close();
});

test('fractional settlement pays exactly q cents per q units; the resting fractional order is refunded', async () => {
  const page = await newPage();
  await logIn(page);
  const r = await call(page, 'POST', `/v1/users/${uid()}/orders`, { ticker: CUT, side: 'yes', type: 'market', count: 1.37 });
  assert.equal(r.s, 201);
  const held = pos().yes_count;
  assert.equal(held % 100 !== 0, true);
  const admin = await newPage();
  await logIn(admin, 'admin@parlance.local', 'Ledger-Keeper-2026!');
  const before = bal();
  const reserved = dbq("SELECT COALESCE(SUM(reserved_cents),0) c FROM orders WHERE user_id=? AND status='resting' AND market_ticker=?", uid(), CUT)[0].c;
  assert.equal((await call(admin, 'POST', `/v1/admin/markets/${CUT}/determine`, { result: 'yes' })).s, 200);
  const deadline = Date.now() + 15000;
  while (!dbq('SELECT 1 FROM settlements WHERE user_id=? AND market_ticker=?', uid(), CUT).length && Date.now() < deadline) await page.waitForTimeout(200);
  const s = dbq('SELECT * FROM settlements WHERE user_id=? AND market_ticker=?', uid(), CUT)[0];
  assert.deepEqual([s.yes_count, s.payout_cents], [held, held]);
  assert.equal(bal(), before + reserved + held);
  await page.goto(BASE + '/portfolio');
  await page.click('[data-tab=history]');
  await page.click('[data-tab=settlements]');
  await page.waitForSelector(`[data-testid=settlements-table]:has-text("${(held / 100).toFixed(2)}")`);
  await page.context().close(); await admin.context().close();
});

test('restart keeps unit quantities; 390px layouts have no horizontal overflow', async () => {
  const before = dbq('SELECT SUM(count) c FROM fills WHERE user_id=?', uid())[0].c;
  await srv.close();
  srv = await start({ port: PORT, dbFile: DB_FILE, tickMs: 300, admin: { email: 'admin@parlance.local', password: 'Ledger-Keeper-2026!' } });
  assert.equal(dbq('SELECT SUM(count) c FROM fills WHERE user_id=?', uid())[0].c, before, 'migration does not run twice');
  const page = await newPage({ width: 390, height: 844 });
  await logIn(page);
  for (const p of [RATE_URL, SEN_URL, '/portfolio']) {
    await page.goto(BASE + p);
    await page.waitForSelector('main *');
    await page.waitForTimeout(400);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(over <= 0, `${p} overflows by ${over}px`);
  }
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('one-time migration upgrades a whole-contract database (×100) and is idempotent', async () => {
  const PORT2 = PORT + 40;
  let s2 = await start({ port: PORT2, dbFile: OLD_DB, tickMs: 60000 });
  await s2.close();
  // Rewrite the fresh DB into the pre-fractional shape: whole-contract counts, no new columns, no meta key.
  let d = new DatabaseSync(OLD_DB);
  const lp = d.prepare("SELECT id FROM users WHERE email='liquidity@parlance.local'").get().id;
  d.exec(`UPDATE orders SET initial_count=initial_count/100, remaining_count=remaining_count/100, filled_count=filled_count/100;
    UPDATE trades SET count=count/100; UPDATE fills SET count=count/100;
    UPDATE positions SET yes_count=yes_count/100, no_count=no_count/100; UPDATE settlements SET yes_count=yes_count/100, no_count=no_count/100;
    DELETE FROM meta WHERE key='qty_units_v1';
    ALTER TABLE markets DROP COLUMN fractional_trading_enabled; ALTER TABLE markets DROP COLUMN mve_collection_ticker; ALTER TABLE markets DROP COLUMN mve_selected_legs;
    ALTER TABLE orders DROP COLUMN source; ALTER TABLE orders DROP COLUMN action; ALTER TABLE orders DROP COLUMN order_type;`);
  d.prepare("INSERT INTO positions(user_id,market_ticker,yes_count,yes_cost_cents,updated_at) VALUES(?,?,7,406,'2026-01-01T00:00:00.000Z') ON CONFLICT(user_id,market_ticker) DO UPDATE SET yes_count=7").run(lp, CUT);
  d.prepare("INSERT INTO settlements(id,user_id,market_ticker,result,yes_count,no_count,payout_cents,cost_cents,created_at) VALUES('s_old',?,?,'yes',3,0,300,150,'2026-01-01T00:00:00.000Z')").run(lp, BLUE);
  d.prepare("UPDATE orders SET time_in_force='ioc' WHERE rowid=(SELECT MIN(rowid) FROM orders)").run();
  const oldTrades = d.prepare('SELECT SUM(count) c FROM trades').get().c;
  const oldOrders = d.prepare('SELECT SUM(initial_count) c FROM orders').get().c;
  d.close();

  for (let i = 0; i < 2; i++) { // second boot must not multiply again
    s2 = await start({ port: PORT2, dbFile: OLD_DB, tickMs: 60000 });
    await s2.close();
    d = new DatabaseSync(OLD_DB);
    assert.equal(d.prepare('SELECT SUM(count) c FROM trades').get().c, oldTrades * 100);
    assert.equal(d.prepare('SELECT SUM(initial_count) c FROM orders').get().c >= oldOrders * 100, true);
    assert.equal(d.prepare('SELECT yes_count c FROM positions WHERE user_id=? AND market_ticker=?').get(lp, CUT).c, 700);
    assert.deepEqual({ ...d.prepare("SELECT yes_count, payout_cents FROM settlements WHERE id='s_old'").get() }, { yes_count: 300, payout_cents: 300 });
    assert.equal(d.prepare("SELECT fractional_trading_enabled f FROM markets WHERE ticker=?").get(BLUE).f, 0);
    assert.equal(d.prepare("SELECT fractional_trading_enabled f FROM markets WHERE ticker=?").get(CUT).f, 1);
    assert.equal(d.prepare("SELECT order_type FROM orders WHERE rowid=(SELECT MIN(rowid) FROM orders)").get().order_type, 'market');
    assert.ok(d.prepare("SELECT 1 FROM meta WHERE key='qty_units_v1'").get());
    d.close();
  }
});
