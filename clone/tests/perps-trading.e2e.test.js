'use strict';
// End-to-end browser tests for Perps completion, P6.1 (CLONE_SPEC.md §34.1–§34.3): subaccounts and transfers (between
// Predictions cash and a subaccount, and between subaccounts), order amend and decrease, order groups (limit, OCO,
// group-level cancel), trailing stops tracked on the server (watermark, a fast gap fires once), the feature flags of
// each capability, and persistence across a restart. Real server + SQLite file + Chromium; the simulated index is pinned
// through the engine hook (srv.engine.perps.setIndex, the code path of POST /v1/perps/admin/markets/:ticker/index).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const journal = require('../server/journal.js');
const { Client } = require('./lib/client');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-perps-trading-'));
const DB_FILE = path.join(TMP, 'perps-trading.db');
const PORT = 23000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'Ember-Quarry-Lattice-5182';
const stamp = Date.now();
const ADMIN = { email: `root.${stamp}@example.test`, password: PW };
const HIGH = { burst: 1e6, per_second: 1e6 };
// Perps open: the waitlist gate is on by default since Phase 7A (CLONE_SPEC.md §36.1); this suite trades Perps as new users.
const OPTS = { port: PORT, dbFile: DB_FILE, tickMs: 250, quiet: true, admin: ADMIN, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH }, flags: { defaults: { 'perps.waitlist': false } } };
const BTC = 'PLXBTCPERP';
const alice = { email: `alice.p61.${stamp}@example.test`, name: 'Alice Subaccounts' };

let srv; let browser; let admin; let pa;
const allPages = [];
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const one = (sql, ...a) => dbq(sql, ...a)[0];
const uid = (email) => one('SELECT id FROM users WHERE email=?', email).id;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(fn, { timeout = 10000, interval = 100 } = {}) {
  const end = Date.now() + timeout;
  for (;;) { try { return await fn(); } catch (e) { if (Date.now() > end) throw e; } await sleep(interval); }
}
// NGN display (CLONE_SPEC.md §30): BTC per-contract centicents = the underlying dollar level; ₦ = level x 100.
const btcNgn = (cc) => `₦${(Math.round(cc) * 100).toLocaleString('en-NG')}`;
const ledgerOk = () => { const a = journal.audit(srv.db); assert.ok(a.ok, JSON.stringify(a.problems.slice(0, 5))); };

async function newPage(viewport = { width: 1400, height: 1000 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  allPages.push(page);
  return page;
}
async function signUp(page, u) {
  await page.goto(BASE + '/sign-up');
  await page.fill('input[name=display_name]', u.name);
  await page.fill('input[name=email]', u.email);
  await page.fill('input[name=password]', PW);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
}
async function logIn(page, email) {
  await page.goto(BASE + '/sign-in');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', PW);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
}
function apiCall(page, method, url, body) {
  return page.evaluate(async ({ method, url, body }) => {
    const csrf = JSON.parse(localStorage.getItem('csrfToken')).value;
    const r = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  }, { method, url, body });
}
async function adminCall(method, p, body) {
  let r = await admin.call(method, p, body);
  if (r.code === 'step_up_required') { assert.equal((await admin.call('POST', '/v1/step_up', { password: ADMIN.password })).status, 200); r = await admin.call(method, p, body); }
  return r;
}
async function setFlag(key, enabled) {
  const r = await adminCall('PUT', `/v1/admin/flags/${key}`, { enabled, reason: 'perps e2e flag change' });
  assert.equal(r.status, 200, r.text);
}
async function setLeverage(page, x) { await page.$eval('[data-testid=perp-leverage]', (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, String(x)); }
const pinBtc = (level) => srv.engine.perps.setIndex(BTC, level, { freeze: true });

before(async () => {
  srv = await start(OPTS);
  browser = await chromium.launch();
  admin = await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password);
  pinBtc(100000);
});
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('subaccounts: create in the portfolio, fund one from Predictions cash, move funds between subaccounts, trade in a subaccount', async () => {
  pa = await newPage();
  await signUp(pa, alice);
  const a = uid(alice.email);
  assert.equal((await apiCall(pa, 'POST', `/v1/users/${a}/deposits`, { amount_dollars: 1500 })).status, 201);
  await pa.goto(BASE + '/portfolio?perpsTab=accounts');
  await pa.waitForSelector('[data-testid=perp-subaccounts] [data-testid=perp-sub-row][data-sub="0"]');
  await pa.fill('[data-testid=sub-name]', 'Hedge book');
  await pa.click('[data-testid=sub-create]');
  await pa.waitForSelector('[data-testid=perp-sub-row][data-sub="1"]');
  assert.match(await pa.textContent('[data-testid=perp-sub-row][data-sub="1"]'), /#1 · Hedge book.*Isolated margin/);
  assert.equal(one('SELECT name, margin_mode FROM perp_subaccounts WHERE user_id=? AND subaccount=1', a).name, 'Hedge book');
  // Predictions → subaccount 1 through the transfer box (the picker appears once there are two subaccounts).
  await pa.goto(BASE + `/perps/${BTC}`);
  await pa.waitForSelector('[data-testid=xfer-sub]');
  await pa.selectOption('[data-testid=xfer-sub]', '1');
  await pa.fill('[data-testid=xfer-amount]', '30000');
  await pa.click('[data-testid=xfer-to-perps]');
  await eventually(() => assert.equal(one('SELECT available_cc c FROM perp_subaccounts WHERE user_id=? AND subaccount=1', a).c, 3000000));
  const t1 = one('SELECT * FROM perp_transfers WHERE user_id=? ORDER BY created_ts DESC LIMIT 1', a);
  assert.deepEqual([t1.source, t1.destination, t1.to_subaccount, t1.amount_cc], ['event_contract', 'margined', 1, 3000000]);
  await pa.selectOption('[data-testid=xfer-sub]', '0');
  await pa.fill('[data-testid=xfer-amount]', '20000');
  await pa.click('[data-testid=xfer-to-perps]');
  await eventually(() => assert.equal(one('SELECT available_cc c FROM perp_accounts WHERE user_id=?', a).c, 2000000));
  assert.equal(one('SELECT balance_cents c FROM users WHERE id=?', a).c, 100000);
  // Between subaccounts (portfolio › Subaccounts): ₦5,000 from #1 to Primary.
  await pa.goto(BASE + '/portfolio?perpsTab=accounts');
  await pa.waitForSelector('[data-testid=subx-form]');
  await pa.selectOption('[data-testid=subx-from]', '1');
  await pa.selectOption('[data-testid=subx-to]', '0');
  await pa.fill('[data-testid=subx-amount]', '5000');
  await pa.click('[data-testid=subx-submit]');
  await pa.waitForFunction(() => document.querySelector('[data-testid=perp-sub-row][data-sub="1"] [data-f=available]')?.textContent === '₦25,000');
  assert.equal(one('SELECT available_cc c FROM perp_subaccounts WHERE user_id=? AND subaccount=1', a).c, 2500000);
  assert.equal(one('SELECT available_cc c FROM perp_accounts WHERE user_id=?', a).c, 2500000);
  const sx = one("SELECT * FROM perp_transfers WHERE user_id=? AND source='margined' AND destination='margined'", a);
  assert.deepEqual([sx.from_subaccount, sx.to_subaccount, sx.amount_cc], [1, 0, 500000]);
  // Refusals: more than the subaccount holds, the same subaccount, a subaccount that does not exist.
  let r = await apiCall(pa, 'POST', '/v1/perps/subaccounts/transfers', { from_subaccount: 1, to_subaccount: 0, amount_dollars: 1000 });
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'insufficient_margin');
  r = await apiCall(pa, 'POST', '/v1/perps/subaccounts/transfers', { from_subaccount: 1, to_subaccount: 1, amount_dollars: 1 });
  assert.equal(r.status, 400);
  r = await apiCall(pa, 'POST', '/v1/perps/subaccounts/transfers', { from_subaccount: 7, to_subaccount: 0, amount_dollars: 1 });
  assert.equal(r.status, 404); assert.equal(r.body.error.code, 'subaccount_not_found');
  r = await apiCall(pa, 'POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'market', count: 1, subaccount: 9 });
  assert.equal(r.status, 404);
  // Trade in subaccount #1 from the ticket; the position is labelled with its subaccount.
  await pa.goto(BASE + `/perps/${BTC}`);
  await pa.waitForSelector('[data-testid=perp-sub]');
  await pa.selectOption('[data-testid=perp-sub]', '1');
  await pa.fill('[data-testid=perp-amount]', '5000');
  await setLeverage(pa, 5);
  await pa.click('[data-testid=perp-submit]');
  await pa.waitForSelector(`[data-testid=perp-position][data-ticker=${BTC}][data-sub="1"]`);
  assert.match(await pa.textContent(`[data-testid=perp-position][data-sub="1"] [data-f=sub]`), /#1 · Hedge book/);
  const p1 = one('SELECT * FROM perp_positions WHERE user_id=? AND subaccount=1 AND ticker=?', a, BTC);
  assert.ok(p1.qty > 0 && p1.margin_cc > 0);
  assert.equal(one('SELECT available_cc c FROM perp_accounts WHERE user_id=?', a).c, 2500000, 'the primary subaccount is untouched');
  assert.equal(one('SELECT COUNT(*) c FROM perp_positions WHERE user_id=? AND subaccount=0 AND qty<>0', a).c, 0);
  // Every move journaled: the perps journal and the main journal still balance (bridge, subaccounts, fees, PnL).
  ledgerOk();
  assert.ok(one("SELECT COUNT(*) c FROM perp_journal_entries WHERE kind='subaccount_transfer' AND user_id=?", a).c >= 1);
  assert.deepEqual(pa.errors, []);
});

test('amend and decrease a resting order from the Open orders tab', async () => {
  const a = uid(alice.email);
  await pa.goto(BASE + `/perps/${BTC}`);
  await pa.waitForSelector('[data-testid=perp-sub]');
  await pa.selectOption('[data-testid=perp-sub]', '0');
  await pa.click('[data-testid=perp-type] [data-type=limit]');
  await pa.click('[data-testid=perp-unit] [data-unit=contracts]');
  await pa.fill('[data-testid=perp-limit-price]', '9900000');
  await pa.fill('[data-testid=perp-amount]', '3');
  await setLeverage(pa, 5);
  await pa.click('[data-testid=perp-submit]');
  await eventually(() => assert.ok(one("SELECT 1 FROM perp_orders WHERE user_id=? AND status='resting' AND price_cc=99000", a)));
  const o0 = one("SELECT * FROM perp_orders WHERE user_id=? AND status='resting' AND price_cc=99000", a);
  assert.equal(o0.remaining_count, 300);
  const avail0 = one('SELECT available_cc c FROM perp_accounts WHERE user_id=?', a).c;
  // Decrease (same price, fewer contracts): the same order keeps its place; the reservation shrinks pro rata.
  await pa.click('[data-testid=perp-account] [data-tab=orders]');
  await pa.waitForSelector(`[data-testid=perp-order][data-order="${o0.id}"]`);
  await pa.click(`[data-testid=perp-order][data-order="${o0.id}"] [data-testid=amend-order]`);
  await pa.fill('[data-testid=amend-count]', '2');
  await pa.click('[data-testid=amend-save]');
  await eventually(() => assert.equal(one('SELECT remaining_count r FROM perp_orders WHERE id=?', o0.id).r, 200));
  const o1 = one('SELECT * FROM perp_orders WHERE id=?', o0.id);
  assert.equal(o1.status, 'resting');
  assert.equal(o1.reserved_cc, Math.round((o0.reserved_cc * 200) / 300));
  assert.equal(one('SELECT available_cc c FROM perp_accounts WHERE user_id=?', a).c, avail0 + (o0.reserved_cc - o1.reserved_cc));
  await pa.waitForFunction((id) => /2 \/ 2|0 \/ 2/.test(document.querySelector(`[data-testid=perp-order][data-order="${id}"] [data-f=size]`)?.textContent || ''), o0.id);
  // Amend the price: the order is replaced (new id, amended_from), the old one canceled as `amended`.
  await pa.click(`[data-testid=perp-order][data-order="${o0.id}"] [data-testid=amend-order]`);
  await pa.fill('[data-testid=amend-price]', '9850000');
  await pa.click('[data-testid=amend-save]');
  await eventually(() => assert.equal(one('SELECT status FROM perp_orders WHERE id=?', o0.id).status, 'canceled'));
  assert.equal(one('SELECT cancel_reason r FROM perp_orders WHERE id=?', o0.id).r, 'amended');
  const o2 = one('SELECT * FROM perp_orders WHERE amended_from=?', o0.id);
  assert.deepEqual([o2.status, o2.price_cc, o2.remaining_count, o2.subaccount], ['resting', 98500, 200, 0]);
  await pa.waitForSelector(`[data-testid=perp-order][data-order="${o2.id}"]`);
  assert.equal(await pa.textContent(`[data-testid=perp-order][data-order="${o2.id}"] [data-f=price]`), btcNgn(98500));
  // A price outside the band leaves the order untouched (one transaction); a decrease to zero cancels it.
  let r = await apiCall(pa, 'POST', `/v1/perps/orders/${o2.id}/amend`, { price: '1.0000' });
  assert.equal(r.status, 400); assert.equal(r.body.error.code, 'price_outside_band');
  assert.equal(one('SELECT status FROM perp_orders WHERE id=?', o2.id).status, 'resting');
  r = await apiCall(pa, 'POST', `/v1/perps/orders/${o2.id}/decrease`, { reduce_to: 0 });
  assert.equal(r.status, 200); assert.equal(r.body.order.status, 'canceled');
  r = await apiCall(pa, 'POST', `/v1/perps/orders/${o2.id}/amend`, { price: '9.8000' });
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'order_not_resting');
  await pa.waitForSelector('[data-testid=perp-no-orders]');
  assert.equal(one("SELECT COALESCE(SUM(reserved_cc),0) c FROM perp_orders WHERE user_id=? AND status='resting'", a).c, 0);
  ledgerOk();
  assert.deepEqual(pa.errors, []);
});

test('order groups: a limit group cancels its other orders at the limit, OCO cancels the rest after one fill, group-level cancel', async () => {
  const a = uid(alice.email);
  pinBtc(100000);
  // A limit group of 1 contract, created in the portfolio.
  await pa.goto(BASE + '/portfolio?perpsTab=groups');
  await pa.waitForSelector('[data-testid=og-form]');
  await pa.fill('[data-testid=og-limit]', '1');
  await pa.click('[data-testid=og-create]');
  await pa.waitForSelector('[data-testid=perp-group-row]');
  const g1 = one("SELECT * FROM perp_order_groups WHERE user_id=? AND kind='limit'", a);
  assert.equal(g1.contracts_limit, 100);
  // Two resting bids in the group, placed from the ticket.
  await pa.goto(BASE + `/perps/${BTC}`);
  await pa.waitForSelector('[data-testid=perp-group]:not([hidden])', { state: 'attached' });
  await pa.waitForFunction(() => !document.querySelector('[data-group-field]').hidden);
  await pa.selectOption('[data-testid=perp-sub]', '0');
  await pa.click('[data-testid=perp-type] [data-type=limit]');
  await pa.click('[data-testid=perp-unit] [data-unit=contracts]');
  await setLeverage(pa, 5);
  for (const lvl of ['9980000', '9970000']) {
    await pa.selectOption('[data-testid=perp-group]', g1.id);
    await pa.fill('[data-testid=perp-limit-price]', lvl);
    await pa.fill('[data-testid=perp-amount]', '1');
    await pa.click('[data-testid=perp-submit]');
    await eventually(() => assert.ok(one("SELECT 1 FROM perp_orders WHERE order_group_id=? AND status='resting' AND price_cc=?", g1.id, Number(lvl) / 100)));
  }
  // The mark drops: the liquidity account's asks cross both bids, but only 1 contract may fill in the group.
  pinBtc(99500);
  await eventually(() => assert.equal(one('SELECT status FROM perp_order_groups WHERE id=?', g1.id).status, 'triggered'));
  const go = dbq('SELECT * FROM perp_orders WHERE order_group_id=? ORDER BY price_cc DESC', g1.id);
  assert.deepEqual(go.map((o) => [o.status, o.filled_count]), [['executed', 100], ['canceled', 0]]);
  assert.match(go[1].cancel_reason, /^order_group_/);
  assert.equal(one('SELECT filled FROM perp_order_groups WHERE id=?', g1.id).filled, 100);
  // A triggered group takes no new orders until reset.
  let r = await apiCall(pa, 'POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'limit', price: '9.8000', count: 1, leverage: 5, order_group_id: g1.id });
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'order_group_inactive');
  // OCO group (API create, orders from the API): one fill cancels the other order.
  r = await apiCall(pa, 'POST', '/v1/perps/order_groups', { kind: 'oco' });
  assert.equal(r.status, 201);
  const oco = r.body.order_group_id;
  assert.equal((await apiCall(pa, 'POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'limit', price: '9.9300', count: 1, leverage: 5, order_group_id: oco })).status, 201);
  assert.equal((await apiCall(pa, 'POST', '/v1/perps/orders', { ticker: BTC, side: 'ask', type: 'limit', price: '9.9700', count: 1, leverage: 5, order_group_id: oco })).status, 201);
  pinBtc(99000);
  await eventually(() => assert.equal(one('SELECT status FROM perp_order_groups WHERE id=?', oco).status, 'triggered'));
  const oo = dbq('SELECT side, status, cancel_reason FROM perp_orders WHERE order_group_id=? ORDER BY side', oco);
  assert.deepEqual(oo.map((o) => [o.side, o.status]), [['ask', 'canceled'], ['bid', 'executed']]);
  assert.equal(oo[0].cancel_reason, 'order_group_oco');
  // An order group of another subaccount is refused for subaccount 0.
  r = await apiCall(pa, 'POST', '/v1/perps/order_groups', { kind: 'limit', contracts_limit: 5, subaccount: 1 });
  assert.equal(r.status, 201);
  r = await apiCall(pa, 'POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'limit', price: '9.8000', count: 1, leverage: 5, order_group_id: r.body.order_group_id });
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'order_group_subaccount');
  // Group-level cancel from the portfolio: every open order of the group at once.
  r = await apiCall(pa, 'POST', '/v1/perps/order_groups', { kind: 'limit', contracts_limit: 10 });
  const g3 = r.body.order_group_id;
  for (const px of ['9.7000', '9.6500']) assert.equal((await apiCall(pa, 'POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'limit', price: px, count: 1, leverage: 5, order_group_id: g3 })).status, 201);
  await pa.goto(BASE + '/portfolio?perpsTab=groups');
  await pa.waitForSelector(`[data-testid=perp-group-row][data-group="${g3}"] [data-testid=og-cancel]`);
  assert.equal(await pa.textContent(`[data-testid=perp-group-row][data-group="${g3}"] [data-f=open]`), '2');
  await pa.click(`[data-testid=perp-group-row][data-group="${g3}"] [data-testid=og-cancel]`);
  await pa.waitForSelector(`[data-testid=perp-group-row][data-group="${g3}"][data-status=canceled]`);
  assert.deepEqual(dbq('SELECT status, cancel_reason FROM perp_orders WHERE order_group_id=?', g3).map((o) => [o.status, o.cancel_reason]), [['canceled', 'order_group_canceled'], ['canceled', 'order_group_canceled']]);
  // Reset the triggered limit group from the UI: active again with nothing filled.
  await pa.click(`[data-testid=perp-group-row][data-group="${g1.id}"] [data-testid=og-reset]`);
  await pa.waitForSelector(`[data-testid=perp-group-row][data-group="${g1.id}"][data-status=active]`);
  assert.equal(one('SELECT filled FROM perp_order_groups WHERE id=?', g1.id).filled, 0);
  ledgerOk();
  assert.deepEqual(pa.errors, []);
});

test('trailing stop: the server keeps the watermark; a fast gap through the stop fires exactly once', async () => {
  const a = uid(alice.email);
  pinBtc(100000);
  // Close what the groups left open in subaccount 0, then open a fresh long.
  for (const p of dbq('SELECT ticker FROM perp_positions WHERE user_id=? AND subaccount=0 AND qty<>0', a)) assert.equal((await apiCall(pa, 'POST', `/v1/perps/positions/${p.ticker}/close`, {})).status, 200);
  assert.equal((await apiCall(pa, 'POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'market', count: 2, leverage: 5 })).status, 201);
  await pa.goto(BASE + `/perps/${BTC}`);
  const row = `[data-testid=perp-position][data-ticker=${BTC}][data-sub="0"]`;
  await pa.waitForSelector(row);
  await pa.click(`${row} [data-testid=trail-btn]`);
  await pa.fill('[data-testid=trail-input]', '2');
  await pa.click('[data-testid=trail-save]');
  await pa.waitForFunction((r) => /Trail 2% · stop ₦9,800,000/.test(document.querySelector(`${r} [data-testid=trail-btn]`)?.textContent || ''), row);
  const t0 = one("SELECT * FROM perp_exit_triggers WHERE user_id=? AND kind='trailing' AND status='active'", a);
  assert.deepEqual([t0.trail_bps, t0.watermark_cc, t0.stop_cc, t0.subaccount], [200, 100000, 98000, 0]);
  // The mark rises: the watermark follows (persisted) and the stop moves up, live on the page.
  pinBtc(104000);
  await pa.waitForFunction((r) => /stop ₦10,192,000/.test(document.querySelector(`${r} [data-testid=trail-btn]`)?.textContent || ''), row);
  assert.deepEqual([one('SELECT watermark_cc w FROM perp_exit_triggers WHERE id=?', t0.id).w, one('SELECT stop_cc s FROM perp_exit_triggers WHERE id=?', t0.id).s], [104000, 101920]);
  // A dip that stays above the stop does nothing; the watermark never moves down.
  pinBtc(102500);
  assert.equal(one('SELECT status FROM perp_exit_triggers WHERE id=?', t0.id).status, 'active');
  assert.equal(one('SELECT watermark_cc w FROM perp_exit_triggers WHERE id=?', t0.id).w, 104000);
  // Fast market: a spike and a gap far through the stop, back to back (no tick in between).
  pinBtc(106000);
  pinBtc(97000);
  await pa.waitForSelector(row, { state: 'detached' }); // subaccount #1's position stays open
  const t1 = one('SELECT * FROM perp_exit_triggers WHERE id=?', t0.id);
  assert.deepEqual([t1.status, t1.triggered_leg, t1.watermark_cc, t1.stop_cc, t1.fired_mark_cc], ['filled', 'trailing_stop', 106000, 103880, 97000]);
  assert.equal(one("SELECT COUNT(*) c FROM perp_fills WHERE user_id=? AND source='trailing_stop'", a).c, 1, 'fired exactly once');
  // Ticks after the fill change nothing.
  await sleep(800);
  pinBtc(96000);
  assert.equal(one("SELECT COUNT(*) c FROM perp_fills WHERE user_id=? AND source='trailing_stop'", a).c, 1);
  assert.equal(one('SELECT qty FROM perp_positions WHERE user_id=? AND subaccount=0 AND ticker=?', a, BTC).qty, 0);
  assert.equal(one("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='perp_exit_trigger' AND title LIKE 'Trailing stop hit%'", a).c, 1);
  // A short's trailing stop follows the low; validation of the trail.
  pinBtc(100000);
  assert.equal((await apiCall(pa, 'POST', '/v1/perps/orders', { ticker: BTC, side: 'ask', type: 'market', count: 1, leverage: 5 })).status, 201);
  let r = await apiCall(pa, 'PUT', `/v1/perps/positions/${BTC}/exit_trigger`, { kind: 'trailing', trail_percent: 80 });
  assert.equal(r.status, 400);
  r = await apiCall(pa, 'PUT', `/v1/perps/positions/${BTC}/exit_trigger`, { kind: 'trailing', trail_amount: '0.1000' });
  assert.equal(r.status, 200); assert.equal(r.body.stop_price, '10.1000');
  pinBtc(95000);
  assert.deepEqual(Object.values(one("SELECT watermark_cc, stop_cc FROM perp_exit_triggers WHERE user_id=? AND kind='trailing' AND status='active'", a)), [95000, 96000]);
  assert.deepEqual(pa.errors, []);
});

test('feature flags: each capability switches its UI and API off and back on', async () => {
  const a = uid(alice.email);
  await setFlag('perps.subaccounts', false);
  let r = await apiCall(pa, 'GET', '/v1/perps/subaccounts');
  assert.equal(r.status, 403); assert.equal(r.body.error.feature, 'perps.subaccounts');
  r = await apiCall(pa, 'POST', '/v1/perps/transfers', { direction: 'to_perps', amount_dollars: 1, subaccount: 1 });
  assert.equal(r.status, 403);
  await pa.goto(BASE + '/portfolio?perpsTab=positions');
  await pa.waitForSelector('[data-testid=perps-port-tabs]');
  assert.equal(await pa.locator('[data-ptab=accounts]').count(), 0, 'Subaccounts tab hidden');
  await setFlag('perps.subaccounts', true);
  await setFlag('perps.amend', false);
  const id = (await apiCall(pa, 'POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'limit', price: '8.5000', count: 1, leverage: 2 })).body.order_id;
  r = await apiCall(pa, 'POST', `/v1/perps/orders/${id}/amend`, { price: '8.6000' });
  assert.equal(r.status, 403); assert.equal(r.body.error.feature, 'perps.amend');
  await pa.goto(BASE + '/portfolio?perpsTab=orders');
  await pa.waitForSelector(`[data-testid=perp-order][data-order="${id}"]`);
  await pa.waitForFunction((x) => { const b = document.querySelector(`[data-order="${x}"] [data-testid=amend-order]`); return b && getComputedStyle(b).display === 'none'; }, id);
  await setFlag('perps.amend', true);
  assert.equal((await apiCall(pa, 'POST', `/v1/perps/orders/${id}/decrease`, { reduce_to: 0 })).status, 200);
  await setFlag('perps.order_groups', false);
  assert.equal((await apiCall(pa, 'POST', '/v1/perps/order_groups', { kind: 'oco' })).status, 403);
  await setFlag('perps.order_groups', true);
  await setFlag('perps.trailing_stops', false);
  r = await apiCall(pa, 'PUT', `/v1/perps/positions/${BTC}/exit_trigger`, { kind: 'trailing', trail_percent: 2 });
  assert.equal(r.status, 403); assert.equal(r.body.error.feature, 'perps.trailing_stops');
  // The bracket TP/SL still works with trailing stops off; an active trailing stop keeps protecting the position.
  assert.equal((await apiCall(pa, 'PUT', `/v1/perps/positions/${BTC}/exit_trigger`, { take_profit_price: '9.0000' })).status, 200);
  assert.equal(one("SELECT COUNT(*) c FROM perp_exit_triggers WHERE user_id=? AND kind='trailing' AND status='active'", a).c, 1);
  await setFlag('perps.trailing_stops', true);
  assert.deepEqual(pa.errors, []);
});

test('persistence: subaccounts, groups, amended orders and a live trailing watermark survive a restart', async () => {
  const a = uid(alice.email);
  const before = {
    subs: dbq('SELECT subaccount, name, margin_mode, available_cc FROM perp_subaccounts WHERE user_id=? ORDER BY subaccount', a),
    groups: dbq('SELECT id, status, filled FROM perp_order_groups WHERE user_id=? ORDER BY id', a),
    trail: one("SELECT * FROM perp_exit_triggers WHERE user_id=? AND kind='trailing' AND status='active'", a),
    amended: dbq('SELECT id, amended_from FROM perp_orders WHERE user_id=? AND amended_from IS NOT NULL', a),
  };
  await srv.close();
  srv = await start(OPTS);
  admin = await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password);
  assert.deepEqual(dbq('SELECT subaccount, name, margin_mode, available_cc FROM perp_subaccounts WHERE user_id=? ORDER BY subaccount', a), before.subs);
  assert.deepEqual(dbq('SELECT id, status, filled FROM perp_order_groups WHERE user_id=? ORDER BY id', a), before.groups);
  assert.deepEqual(dbq('SELECT id, amended_from FROM perp_orders WHERE user_id=? AND amended_from IS NOT NULL', a), before.amended);
  const t = one('SELECT * FROM perp_exit_triggers WHERE id=?', before.trail.id);
  assert.deepEqual([t.status, t.watermark_cc, t.stop_cc], ['active', 95000, 96000]);
  // The persisted watermark keeps working after the restart: the short's stop fires on the rise.
  const page = await newPage();
  await logIn(page, alice.email);
  await page.goto(BASE + '/portfolio?perpsTab=accounts');
  await page.waitForSelector('[data-testid=perp-sub-row][data-sub="1"]');
  assert.match(await page.textContent('[data-testid=perp-sub-row][data-sub="1"]'), /Hedge book/);
  srv.engine.perps.setIndex(BTC, 96500, { freeze: true });
  await eventually(() => assert.equal(one('SELECT status FROM perp_exit_triggers WHERE id=?', before.trail.id).status, 'filled'));
  ledgerOk();
  assert.deepEqual(page.errors, []);
});

test('phone width 390px: the new Perps tabs fit without horizontal overflow', async () => {
  const page = await newPage({ width: 390, height: 844 });
  await logIn(page, alice.email);
  for (const tab of ['accounts', 'groups', 'rewards', 'orders']) {
    await page.goto(BASE + `/portfolio?perpsTab=${tab}`);
    await page.waitForSelector('[data-testid=perps-portfolio]');
    await page.waitForTimeout(300);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(over <= 0, `${tab} overflows by ${over}px`);
  }
  await page.goto(BASE + `/perps/${BTC}`);
  await page.waitForSelector('[data-testid=perp-tiers]');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0);
  assert.deepEqual(page.errors, []);
});

test('no page errors anywhere', () => {
  assert.deepEqual(allPages.flatMap((p) => p.errors), []);
});
