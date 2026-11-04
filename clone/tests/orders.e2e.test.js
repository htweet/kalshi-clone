'use strict';
// End-to-end tests for the Resting portfolio tab (CLONE_SPEC §17.10): limit orders with an Expires
// option, queue position, decrease (priority kept) and amend (priority lost) with exact reservations, a partial
// fill by a second user updating the row live, good-til-time expiry releasing the reservation, cancel / cancel
// market / cancel all, restart persistence and the 390px layout. Real server + SQLite + Chromium.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-orders-'));
const DB_FILE = path.join(TMP, 'orders.db');
const PORT = 4620 + Math.floor(Math.random() * 30);
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'correct-horse-9';
const RATE_URL = '/markets/plxrate/central-bank-decision/plxrate-26dec';
const CUT = 'PLXRATE-26DEC-CUT';
const HOLD = 'PLXRATE-26DEC-HOLD';
const R = { email: `or.${Date.now()}@example.test`, name: 'Robin Rester' };
const Q = { email: `oq.${Date.now()}@example.test`, name: 'Quinn Taker' };

let srv; let browser;
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const uid = (u) => dbq('SELECT id FROM users WHERE email=?', u.email)[0].id;
const bal = (u) => dbq('SELECT balance_cents b FROM users WHERE id=?', uid(u))[0].b;
const held = (u) => dbq("SELECT COALESCE(SUM(reserved_cents),0) c FROM orders WHERE user_id=? AND status='resting'", uid(u))[0].c;
const order = (id) => dbq('SELECT * FROM orders WHERE id=?', id)[0];
const ahead = (o) => dbq("SELECT COALESCE(SUM(remaining_count),0) n FROM orders WHERE market_ticker=? AND status='resting' AND side=? AND price_cents=? AND seq<?", o.market_ticker, o.side, o.price_cents, o.seq)[0].n;
async function newPage(viewport = { width: 1600, height: 1000 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  return page;
}
async function signUp(page, u, dollars) {
  await page.goto(BASE + '/sign-up');
  await page.fill('input[name=display_name]', u.name);
  await page.fill('input[name=email]', u.email);
  await page.fill('input[name=password]', PW);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
  await page.goto(BASE + '/portfolio');
  await page.fill('#f-amount', String(dollars));
  await page.click('[data-act=deposit]');
  await page.waitForSelector(`[data-testid=header-balance]:has-text("$${dollars}.00")`);
}
async function logIn(page, u) {
  await page.goto(BASE + '/sign-in');
  await page.fill('input[name=email]', u.email);
  await page.fill('input[name=password]', PW);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
}
const call = (page, method, url, body) => page.evaluate(async ([m, u, b]) => {
  const csrf = JSON.parse(localStorage.getItem('csrfToken')).value;
  const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: b ? JSON.stringify(b) : undefined });
  return { s: r.status, b: await r.json() };
}, [method, url, body]);
async function mode(page, m) { await page.click('#t-mode-btn'); await page.click(`[data-otype=${m}]`); }
const until = async (page, fn, ms = 15000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out waiting for DB condition'); await page.waitForTimeout(150); } };
const reserve = (units, p) => Math.ceil((units * (p + Math.ceil((7 * Math.min(p, 50) * (100 - Math.min(p, 50))) / 10000))) / 100);

let pr; let o55; let o20;
before(async () => { srv = await start({ port: PORT, dbFile: DB_FILE, tickMs: 250 }); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('limit orders from the ticket (GTC and custom expiry) show grouped in Resting with queue position and reserve', async () => {
  pr = await newPage();
  await signUp(pr, R, 100);
  await pr.goto(BASE + RATE_URL);
  await pr.click(`tr[data-ticker="${CUT}"] [data-pick=yes]`);
  await mode(pr, 'limit');
  assert.equal(await pr.inputValue('[data-testid=t-expiry]'), 'never');
  await pr.fill('#t-price', '55');
  await pr.fill('#t-count', '3');
  await pr.click('[data-testid=submit-order]'); await pr.click('[data-testid=review-confirm]'); // order review step (Phase 5A, A7)
  await pr.waitForSelector('.toast:has-text("Order resting")');
  o55 = dbq("SELECT * FROM orders WHERE user_id=? ORDER BY seq DESC LIMIT 1", uid(R))[0];
  assert.deepEqual([o55.price_cents, o55.remaining_count, o55.expiration_ts, o55.reserved_cents], [55, 300, null, reserve(300, 55)]);
  // A custom expiry two hours out, fractional size.
  await pr.fill('#t-price', '20');
  await pr.fill('#t-count', '2.5');
  await pr.selectOption('[data-testid=t-expiry]', 'custom');
  await pr.waitForSelector('[data-testid=t-invalid]:has-text("expiry time in the future")');
  const local = await pr.evaluate(() => { const d = new Date(Date.now() + 2 * 3600000); d.setSeconds(0, 0); const z = (n) => String(n).padStart(2, '0'); return { v: `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`, ms: d.getTime() }; });
  await pr.fill('#t-expiry-at', local.v);
  await pr.click('[data-testid=submit-order]'); await pr.click('[data-testid=review-confirm]'); // order review step (Phase 5A, A7)
  await pr.waitForSelector('.toast:has-text("Order resting")');
  o20 = dbq("SELECT * FROM orders WHERE user_id=? ORDER BY seq DESC LIMIT 1", uid(R))[0];
  assert.deepEqual([o20.price_cents, o20.remaining_count, o20.expiration_ts], [20, 250, local.ms]);

  await pr.goto(BASE + '/portfolio?tab=orders');
  await pr.waitForSelector(`[data-testid=orders-table] tr[data-order="${o55.id}"]`);
  assert.equal(await pr.locator('[data-testid=orders-table] tr[data-event-group="PLXRATE-26DEC"]').count(), 1);
  assert.equal(await pr.textContent('[data-testid=resting-count]'), '2');
  const row = `tr[data-order="${o55.id}"]`;
  assert.equal(await pr.textContent(`${row} [data-testid=o-queue]`), (ahead(o55) / 100).toFixed(2));
  assert.ok(ahead(o55) > 0, 'the seeded liquidity at 55¢ is ahead of us');
  assert.equal(await pr.textContent(`${row} [data-testid=o-filled]`), '0.00 / 3.00');
  assert.match(await pr.textContent(`tr[data-order="${o20.id}"] [data-testid=o-expiry]`), /^1h 5\dm|^2h 0m|^1h \d+m/);
  const qp = await call(pr, 'GET', `/v1/users/${uid(R)}/orders/queue_positions`);
  assert.equal(qp.b.queue_positions.find((x) => x.order_id === o55.id).queue_position_fp, (ahead(o55) / 100).toFixed(2));
  assert.deepEqual(pr.errors, []);
});

test('decrease keeps time priority; amend price loses it; reservations stay exact; validation', async () => {
  const row = `tr[data-order="${o55.id}"]`;
  const cash0 = bal(R) + held(R);
  await pr.click(`${row} [data-decrease]`);
  await pr.fill(`[data-decrease-form="${o55.id}"] input[name=to]`, '2');
  await pr.click(`[data-decrease-form="${o55.id}"] button[type=submit]`);
  await pr.waitForSelector('.toast:has-text("queue position kept")');
  let o = order(o55.id);
  assert.deepEqual([o.seq, o.remaining_count, o.initial_count, o.reserved_cents], [o55.seq, 200, 200, reserve(200, 55)]);
  assert.equal(bal(R) + held(R), cash0, 'freed reservation went back to cash exactly');
  await pr.waitForSelector(`${row} [data-testid=o-remaining]:has-text("2.00")`);
  // Edit validation, then a price change to 58¢: back of the queue (new seq) — and alone at the best bid.
  await pr.click(`${row} [data-edit]`);
  const form = `[data-edit-form="${o55.id}"]`;
  await pr.fill(`${form} input[name=price]`, '0');
  await pr.click(`${form} button[type=submit]`);
  await pr.waitForSelector(`[data-edit-row="${o55.id}"] .form-error:has-text("between 1¢ and 99¢")`);
  await pr.fill(`${form} input[name=price]`, '58');
  await pr.fill(`${form} input[name=count]`, '0');
  await pr.click(`${form} button[type=submit]`);
  await pr.waitForSelector(`[data-edit-row="${o55.id}"] .form-error:has-text("Total must be more")`);
  await pr.fill(`${form} input[name=count]`, '2');
  await pr.click(`${form} button[type=submit]`);
  await pr.waitForSelector('.toast:has-text("moved to the back of the queue")');
  o = order(o55.id);
  assert.ok(o.seq > o55.seq);
  assert.deepEqual([o.price_cents, o.remaining_count, o.reserved_cents, o.status], [58, 200, reserve(200, 58), 'resting']);
  assert.equal(bal(R) + held(R), cash0);
  await pr.waitForSelector(`${row} [data-testid=o-price]:has-text("58¢")`);
  assert.equal(await pr.textContent(`${row} [data-testid=o-queue]`), '0.00');
  // API: increasing size forfeits priority; decreasing via amend keeps it; decrease validation.
  const U = `/v1/users/${uid(R)}/orders/${o20.id}`;
  let r = await call(pr, 'POST', `${U}/amend`, { count_fp: '4' });
  assert.deepEqual([r.s, r.b.queue_priority_kept, order(o20.id).remaining_count], [200, false, 400]);
  const s1 = order(o20.id).seq;
  r = await call(pr, 'POST', `${U}/amend`, { count_fp: '3.5' });
  assert.deepEqual([r.s, r.b.queue_priority_kept, order(o20.id).seq, order(o20.id).remaining_count], [200, true, s1, 350]);
  r = await call(pr, 'POST', `${U}/decrease`, { reduce_by: '1', reduce_to: '1' });
  assert.equal(r.s, 400);
  r = await call(pr, 'POST', `${U}/decrease`, { reduce_to: '9' });
  assert.equal(r.s, 400);
  r = await call(pr, 'POST', `${U}/decrease`, { reduce_by: '0.25' });
  assert.deepEqual([r.s, r.b.order.remaining_count_fp, r.b.reduced_by_fp], [200, '3.25', '0.25']);
  assert.equal(order(o20.id).reserved_cents, reserve(325, 20));
  assert.equal(bal(R) + held(R), cash0);
  assert.deepEqual(pr.errors, []);
});

test('a partial fill by another user updates the Resting row live', async () => {
  const pq = await newPage();
  await signUp(pq, Q, 50);
  const r = await call(pq, 'POST', `/v1/users/${uid(Q)}/orders`, { ticker: CUT, side: 'no', type: 'market', count: 1.5 });
  assert.equal(r.s, 201);
  const f = dbq('SELECT * FROM fills WHERE order_id=?', o55.id)[0];
  assert.deepEqual([f.count, f.price_cents, f.is_taker], [150, 58, 0]);
  await pr.waitForSelector(`tr[data-order="${o55.id}"] [data-testid=o-filled]:has-text("1.50 / 2.00")`);
  assert.equal(await pr.textContent(`tr[data-order="${o55.id}"] [data-testid=o-remaining]`), '0.50');
  // Maker paid floor(150·58/100) = 87 cents and keeps exactly the reservation for 0.5 contracts.
  assert.equal(order(o55.id).reserved_cents, reserve(50, 58));
  await pq.context().close();
});

test('good-til-time expiry cancels the order on the tick, releases the reservation and notifies', async () => {
  const before = bal(R);
  const r = await call(pr, 'POST', `/v1/users/${uid(R)}/orders`, { ticker: HOLD, side: 'yes', type: 'limit', price: 10, count: 1, expiration_time: new Date(Date.now() + 2500).toISOString() });
  assert.equal(r.s, 201);
  assert.ok(r.b.order.expiration_time);
  const id = r.b.order.order_id;
  assert.equal(bal(R), before - reserve(100, 10));
  await pr.waitForSelector(`tr[data-order="${id}"]`);
  await until(pr, () => order(id).status === 'canceled', 8000);
  assert.deepEqual([order(id).cancel_reason, order(id).reserved_cents], ['expired', 0]);
  assert.equal(bal(R), before);
  assert.equal(dbq("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='order_expired'", uid(R))[0].c, 1);
  await pr.waitForSelector(`tr[data-order="${id}"]`, { state: 'detached' });
  const bad = await call(pr, 'POST', `/v1/users/${uid(R)}/orders`, { ticker: HOLD, side: 'yes', type: 'market', count: 1, expiration_time: new Date(Date.now() + 60000).toISOString() });
  assert.equal(bad.s, 400);
  const past = await call(pr, 'POST', `/v1/users/${uid(R)}/orders`, { ticker: HOLD, side: 'yes', type: 'limit', price: 10, count: 1, expiration_time: new Date(Date.now() - 1000).toISOString() });
  assert.equal(past.s, 400);
  await pr.goto(BASE + '/portfolio?tab=history');
  await pr.waitForSelector('[data-testid=history-table] tr[data-type=cancel]:has-text("expired")');
  assert.deepEqual(pr.errors, []);
});

test('restart keeps resting orders and expiries; cancel one, cancel per market, cancel all (confirm); 390px', async () => {
  const keep = dbq("SELECT id, seq, expiration_ts, reserved_cents FROM orders WHERE user_id=? AND status='resting' ORDER BY seq", uid(R));
  await pr.context().close();
  await srv.close();
  srv = await start({ port: PORT, dbFile: DB_FILE, tickMs: 250 });
  assert.deepEqual(dbq("SELECT id, seq, expiration_ts, reserved_cents FROM orders WHERE user_id=? AND status='resting' ORDER BY seq", uid(R)), keep);
  const page = await newPage({ width: 390, height: 844 });
  await logIn(page, R);
  await page.goto(BASE + '/portfolio?tab=orders');
  await page.waitForSelector('[data-testid=orders-table]');
  await page.waitForTimeout(300);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(over <= 0, `Resting overflows by ${over}px`);
  await page.setViewportSize({ width: 1600, height: 1000 });
  // three more orders on two markets
  for (const [t, p] of [[CUT, 30], [HOLD, 15], [HOLD, 16]]) assert.equal((await call(page, 'POST', `/v1/users/${uid(R)}/orders`, { ticker: t, side: 'yes', type: 'limit', price: p, count: 1 })).s, 201);
  await page.goto(BASE + '/portfolio?tab=orders');
  await page.waitForSelector(`[data-market-group="${HOLD}"]`);
  const cash0 = bal(R) + held(R);
  const one = dbq("SELECT id FROM orders WHERE user_id=? AND status='resting' AND price_cents=30", uid(R))[0].id;
  await page.click(`tr[data-order="${one}"] [data-cancel]`);
  await page.waitForSelector(`tr[data-order="${one}"]`, { state: 'detached' });
  assert.equal(order(one).cancel_reason, 'canceled_by_user');
  await page.click(`[data-cancel-market="${HOLD}"]`);
  await page.waitForSelector(`[data-market-group="${HOLD}"]`, { state: 'detached' });
  assert.equal(dbq("SELECT COUNT(*) c FROM orders WHERE user_id=? AND status='resting' AND market_ticker=?", uid(R), HOLD)[0].c, 0);
  page.once('dialog', (d) => d.accept());
  await page.click('[data-testid=cancel-all]');
  await page.waitForSelector('[data-testid=no-orders]');
  assert.equal(held(R), 0);
  assert.equal(bal(R), cash0, 'every reservation released exactly');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
