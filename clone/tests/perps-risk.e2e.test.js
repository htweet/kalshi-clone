'use strict';
// End-to-end browser tests for Perps completion, P6.2 (CLONE_SPEC.md §34.4–§34.5): size-tiered margin (Admin › Perps
// ops edits a market's tiers; the ticket shows the tier and the maximum leverage at the size; requirements are bracketed),
// risk limits enforced at the API (max leverage, leverage per tier, max position incl. resting orders, open orders per
// market and in total, subaccounts, order groups), portfolio (cross) margin with liquidation on the portfolio
// maintenance margin (largest requirement first, no negative collateral, the journal balanced), and fractional contracts
// (0.01 granularity, whole-contract markets refuse fractions, the flag). Real server + SQLite + Chromium.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const journal = require('../server/journal.js');
const R = require('../server/perps-risk.js');
const { Client } = require('./lib/client');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-perps-risk-'));
const DB_FILE = path.join(TMP, 'perps-risk.db');
const PORT = 24000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'Harbor-Copper-Willow-6624';
const stamp = Date.now();
const ADMIN = { email: `root.${stamp}@example.test`, password: PW };
const HIGH = { burst: 1e6, per_second: 1e6 };
const OPTS = { port: PORT, dbFile: DB_FILE, tickMs: 250, quiet: true, admin: ADMIN, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH } };
const BTC = 'PLXBTCPERP'; const ETH = 'PLXETHPERP'; const SOL = 'PLXSOLPERP'; const US10Y = 'PLXUS10YPERP';
const email = (n) => `${n}.p62.${stamp}@example.test`;

let srv; let browser; let admin; let bob; let carol;
const allPages = [];
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const one = (sql, ...a) => dbq(sql, ...a)[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(fn, { timeout = 10000, interval = 100 } = {}) {
  const end = Date.now() + timeout;
  for (;;) { try { return await fn(); } catch (e) { if (Date.now() > end) throw e; } await sleep(interval); }
}
const ledgerOk = () => { const a = journal.audit(srv.db); assert.ok(a.ok, JSON.stringify(a.problems.slice(0, 5))); };
async function newPage(viewport = { width: 1400, height: 1000 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('dialog', (d) => d.accept());
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
async function adminCall(method, p, body) {
  let r = await admin.call(method, p, body);
  if (r.code === 'step_up_required') { assert.equal((await admin.call('POST', '/v1/step_up', { password: ADMIN.password })).status, 200); r = await admin.call(method, p, body); }
  return r;
}
async function fundedUser(name, dollars, perpsDollars) {
  const c = await new Client(BASE, name).signUp(email(name), PW, `${name[0].toUpperCase()}${name.slice(1)} Risk`);
  assert.equal((await c.call('POST', `/v1/users/${c.uid}/deposits`, { amount_dollars: dollars })).status, 201);
  if (perpsDollars) assert.equal((await c.call('POST', '/v1/perps/transfers', { direction: 'to_perps', amount_dollars: perpsDollars })).status, 201);
  return c;
}
async function setLeverage(page, x) { await page.$eval('[data-testid=perp-leverage]', (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, String(x)); }
const pin = (t, level) => srv.engine.perps.setIndex(t, level, { freeze: true });
const err = (r, status, code) => { assert.equal(r.status, status, r.text); if (code) assert.equal(r.code, code, r.text); };

before(async () => {
  srv = await start(OPTS);
  browser = await chromium.launch();
  admin = await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password);
  pin(BTC, 100000); pin(ETH, 3500); pin(SOL, 200);
});
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('size tiers: the market page lists them, the ticket shows the tier and max leverage at the size, Admin › Perps ops edits them', async () => {
  // Default tiers from max leverage: $50k at 20x, $250k at 10x, $1M at 5x (BTC).
  const t0 = (await admin.call('GET', `/v1/perps/markets/${BTC}/margin_tiers`)).body.margin_tiers;
  assert.deepEqual(t0.map((t) => [t.max_notional_dollars, t.initial_margin_rate, t.maintenance_margin_rate]), [['50000.0000', 0.05, 0.025], ['250000.0000', 0.1, 0.05], ['1000000.0000', 0.2, 0.1]]);
  const page = await newPage();
  bob = await fundedUser('bob', 20000, 9000);
  await uiLogIn(page, { email: email('bob') });
  await page.goto(BASE + `/perps/${BTC}`);
  await page.waitForSelector('[data-testid=perp-tiers] [data-testid=perp-tier-row][data-tier="3"]');
  assert.match(await page.textContent('[data-testid=perp-tier-row][data-tier="2"]'), /₦5,000,000 to ₦25,000,000.*10\.00%.*5\.00%.*10\.0x/);
  // Small size: tier 1, 20x. A size that reaches tier 2 lowers the blended maximum leverage (marked when exceeded).
  await page.click('[data-testid=perp-unit] [data-unit=contracts]');
  await page.fill('[data-testid=perp-amount]', '100');
  await setLeverage(page, 20);
  await page.waitForFunction(() => document.querySelector('[data-testid=perp-tier]').textContent === '1' && document.querySelector('[data-testid=perp-max-lev]').textContent === '20x');
  await page.fill('[data-testid=perp-amount]', '8000'); // $80k notional: $50k at 5% + $30k at 10% = $5.5k → 14.5x blended
  await page.waitForFunction(() => document.querySelector('[data-testid=perp-tier]').textContent === '2' && document.querySelector('[data-testid=perp-max-lev]').textContent === '14.5x' && document.querySelector('[data-testid=perp-max-lev]').classList.contains('down'));
  // The server refuses the same size at 20x as a resting order (the whole size counts; a market order only reaches the
  // book's depth, and its risk check applies to what it can fill), before any collateral check.
  let r = await bob.call('POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'limit', price: '9.5000', count: 8000, leverage: 20 });
  err(r, 400, 'leverage_exceeds_tier');
  assert.match(r.body.error.details, /maximum leverage is 14\.54x/);
  // Admin › Perps ops: BTC tiers become $20k at 10x then $40k at 5x (the largest position $40k); reason recorded, audited.
  const ap = await newPage();
  await uiLogIn(ap, ADMIN);
  await ap.goto(BASE + '/admin/perps');
  await ap.waitForSelector('[data-testid=pops-tiers] [data-testid=pops-tier-row]');
  await ap.selectOption('[data-testid=pops-tier-market]', BTC);
  await ap.waitForFunction(() => document.querySelectorAll('[data-testid=pops-tier-row]').length === 3);
  const rows = ap.locator('[data-testid=pops-tier-row]');
  await rows.nth(2).locator('[data-tier-del]').click();
  await ap.waitForFunction(() => document.querySelectorAll('[data-testid=pops-tier-row]').length === 2);
  const fill = async (i, cap, im, mm) => { const row = rows.nth(i); await row.locator('[data-tier-input=cap]').fill(String(cap)); await row.locator('[data-tier-input=im]').fill(String(im)); await row.locator('[data-tier-input=mm]').fill(String(mm)); };
  await fill(0, 2000000, 10, 5); // ₦2,000,000 = $20,000
  await fill(1, 4000000, 20, 10);
  await ap.click('[data-testid=pops-tier-save]');
  await ap.fill('[data-testid=confirm-reason]', 'tighter BTC risk for the e2e suite');
  await ap.click('[data-testid=confirm-ok]');
  await ap.waitForFunction(() => /Max leverage 10x/.test(document.querySelector('[data-testid=pops-tier-summary]')?.textContent || ''));
  assert.deepEqual(dbq('SELECT tier, max_notional_cc, initial_rate, maintenance_rate FROM perp_margin_tiers WHERE ticker=? ORDER BY tier', BTC).map((t) => Object.values(t)), [[1, 200000000, 0.1, 0.05], [2, 400000000, 0.2, 0.1]]);
  assert.equal(one('SELECT max_leverage m FROM perp_markets WHERE ticker=?', BTC).m, 10);
  assert.equal(one("SELECT reason FROM admin_audit WHERE action='perps.margin_tiers' AND target_id=? ORDER BY ts DESC LIMIT 1", BTC).reason, 'tighter BTC risk for the e2e suite');
  // Bad tiers are refused (rates must not fall with size).
  r = await adminCall('PUT', `/v1/admin/perps_ops/margin_tiers/${BTC}`, { tiers: [{ max_notional_dollars: 100, initial_rate: 0.5, maintenance_rate: 0.2 }, { max_notional_dollars: 200, initial_rate: 0.1, maintenance_rate: 0.05 }], reason: 'bad tiers' });
  err(r, 400, 'validation_failed');
  assert.deepEqual(ap.errors, []);
  assert.deepEqual(page.errors, []);
});

test('risk limits at the API: max leverage, leverage per tier, max position with resting orders, open orders, subaccounts, order groups', async () => {
  // Max leverage (tier 1 is now 10x).
  err(await bob.call('POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'market', count: 1, leverage: 15 }), 400, 'bad_request');
  // Tier 2 starts at $20k: 3,000 contracts ($30k; a BTC contract is $10) at 10x is above the blended 7.5x
  // ($20k at 10% + $10k at 20% = $4k), as a resting order (the whole size counts).
  const r1 = await bob.call('POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'limit', price: '9.5000', count: 3000, leverage: 10 });
  err(r1, 400, 'leverage_exceeds_tier');
  assert.match(r1.body.error.details, /maximum leverage is 7\.5x/);
  assert.equal(R.maxLeverageAt([{ max_notional_cc: 2e8, initial_rate: 0.1 }, { max_notional_cc: 4e8, initial_rate: 0.2 }], 3e8), 7.5);
  // Max position $40k: an order that would reach $45k is refused, even split into a resting order plus a new one.
  err(await bob.call('POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'limit', price: '9.5000', count: 4500, leverage: 2 }), 409, 'position_limit');
  const rest = await bob.call('POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'limit', price: '9.0000', count: 3000, leverage: 5 });
  assert.equal(rest.status, 201, rest.text);
  err(await bob.call('POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'limit', price: '9.1000', count: 1500, leverage: 5 }), 409, 'position_limit');
  // Reducing exposure is always allowed: a short order is not counted against the long resting bids.
  assert.equal((await bob.call('POST', '/v1/perps/orders', { ticker: BTC, side: 'ask', type: 'limit', price: '11.0000', count: 1, leverage: 2 })).status, 201);
  // Open orders per market and in total (Admin › Perps ops › Risk limits, through the UI form).
  const ap = await newPage();
  await uiLogIn(ap, ADMIN);
  await ap.goto(BASE + '/admin/perps');
  await ap.waitForSelector('[data-testid=pops-risk-form]');
  await ap.fill('#f-prisk-max_open_orders_per_market', '3');
  await ap.fill('#f-prisk-max_open_orders_total', '4');
  await ap.fill('#f-prisk-max_subaccounts', '2');
  await ap.fill('#f-prisk-max_order_groups', '1');
  await ap.fill('#f-prisk-reason', 'tight limits for the e2e suite');
  await ap.click('[data-testid=pops-risk-form] button[type=submit]');
  await eventually(() => assert.equal(srv.engine.perps.riskSettings().max_open_orders_total, 4));
  assert.equal((await bob.call('POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'limit', price: '8.9000', count: 1, leverage: 2 })).status, 201); // 3rd in BTC
  const perMkt = await bob.call('POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'limit', price: '8.8000', count: 1, leverage: 2 });
  err(perMkt, 409, 'open_order_limit');
  assert.match(perMkt.body.error.message, /in this market/);
  assert.equal((await bob.call('POST', '/v1/perps/orders', { ticker: ETH, side: 'bid', type: 'limit', price: '3.3000', count: 1, leverage: 2 })).status, 201); // 4th in total
  const total = await bob.call('POST', '/v1/perps/orders', { ticker: SOL, side: 'bid', type: 'limit', price: '19.0000', count: 1, leverage: 2 });
  err(total, 409, 'open_order_limit');
  // Immediate orders do not rest, so they are not limited by the open-order count.
  assert.equal((await bob.call('POST', '/v1/perps/orders', { ticker: SOL, side: 'bid', type: 'market', count: 1, leverage: 2 })).status, 201);
  // Subaccounts and order groups.
  assert.equal((await bob.call('POST', '/v1/perps/subaccounts', { name: 'Second' })).status, 201);
  err(await bob.call('POST', '/v1/perps/subaccounts', { name: 'Third' }), 409, 'subaccount_limit');
  assert.equal((await bob.call('POST', '/v1/perps/order_groups', { kind: 'oco' })).status, 201);
  err(await bob.call('POST', '/v1/perps/order_groups', { kind: 'oco' }), 409, 'order_group_limit');
  // Validation of the limit settings themselves.
  err(await adminCall('PUT', '/v1/admin/perps_ops/risk', { max_open_orders_total: 0, reason: 'zero is not allowed' }), 400, 'validation_failed');
  err(await adminCall('PUT', '/v1/admin/perps_ops/risk', { max_open_orders_total: 4 }), 400, 'validation_failed'); // reason required
  // Back to roomy limits for the next tests.
  assert.equal((await adminCall('PUT', '/v1/admin/perps_ops/risk', { max_open_orders_per_market: 50, max_open_orders_total: 200, max_subaccounts: 10, max_order_groups: 20, reason: 'restore limits' })).status, 200);
  assert.equal((await bob.call('DELETE', `/v1/perps/orders/${rest.body.order_id}`)).status, 200);
  ledgerOk();
  assert.deepEqual(ap.errors, []);
});

test('tiered maintenance margin: a position across tiers needs the bracketed requirement and liquidates on it', async () => {
  // SOL: $1,000 at 10x then $2,000 at 4x (cap). Carol goes long 150 contracts ($3,000 notional) at 2.5x.
  assert.equal((await adminCall('PUT', `/v1/admin/perps_ops/margin_tiers/${SOL}`, { tiers: [{ max_notional_dollars: 1000, initial_rate: 0.1, maintenance_rate: 0.05 }, { max_notional_dollars: 4000, initial_rate: 0.25, maintenance_rate: 0.125 }], reason: 'tiers for the SOL scenario' })).status, 200);
  carol = await fundedUser('carol', 3000, 2000);
  pin(SOL, 200);
  const r = await carol.call('POST', '/v1/perps/orders', { ticker: SOL, side: 'bid', type: 'market', count: 150, leverage: 2.5 });
  assert.equal(r.status, 201, r.text);
  const pv = (await carol.call('GET', '/v1/perps/positions')).body.positions.find((p) => p.market_ticker === SOL);
  // MM = $1,000 x 5% + $2,000 x 12.5% = $300 (a flat tier-1 rate would say $150).
  assert.equal(Number(pv.maintenance_margin_required).toFixed(2), '300.00');
  assert.equal(pv.margin_tier, 2);
  const p = one('SELECT * FROM perp_positions WHERE user_id=? AND ticker=?', carol.uid, SOL);
  const tiers = srv.engine.perps.tiersOf(SOL);
  const liq = R.liqPrice(tiers, p.qty, p.margin_cc - p.cost_ucc / 100, 0);
  assert.equal(pv.estimated_liquidation_price, (liq / 10000).toFixed(4));
  // Equity at the liquidation price equals the bracketed requirement there.
  const eq = p.margin_cc + (p.qty * liq - p.cost_ucc) / 100;
  assert.ok(Math.abs(eq - R.mm(tiers, (Math.abs(p.qty) * liq) / 100)) < 20, `equity ${eq} vs MM`);
  // Just above the liquidation price: still open. Just below: liquidated, with no negative collateral.
  const level = (cc) => (cc / 10000) / 0.1;
  pin(SOL, level(liq) + 0.3);
  assert.notEqual(one('SELECT qty FROM perp_positions WHERE user_id=? AND ticker=?', carol.uid, SOL).qty, 0);
  pin(SOL, level(liq) - 0.3);
  await eventually(() => assert.equal(one('SELECT qty FROM perp_positions WHERE user_id=? AND ticker=?', carol.uid, SOL).qty, 0));
  const l = one('SELECT * FROM perp_liquidations WHERE user_id=?', carol.uid);
  assert.equal(l.margin_mode, 'isolated');
  assert.ok(one('SELECT available_cc c FROM perp_accounts WHERE user_id=?', carol.uid).c >= 0);
  ledgerOk();
});

test('portfolio margin: a cross subaccount survives a move that liquidates the same position in isolated margin, then liquidates on its portfolio MM', async () => {
  const dave = await fundedUser('dave', 2000, 500);
  pin(BTC, 100000); pin(ETH, 3500);
  // Restore BTC's default tiers (the first test tightened them).
  assert.equal((await adminCall('PUT', `/v1/admin/perps_ops/margin_tiers/${BTC}`, { tiers: R.defaultTiers(20).map((t) => ({ max_notional_dollars: t.max_notional_cc / 10000, initial_rate: t.initial_rate, maintenance_rate: t.maintenance_rate })), reason: 'default BTC tiers' })).status, 200);
  // A cross subaccount, created in the UI with the portfolio-margin choice, funded with $300 from the primary.
  const page = await newPage();
  await uiLogIn(page, { email: email('dave') });
  await page.goto(BASE + '/portfolio?perpsTab=accounts');
  await page.waitForSelector('[data-testid=sub-create-form]');
  await page.fill('[data-testid=sub-name]', 'Portfolio');
  await page.selectOption('[data-testid=sub-mode]', 'cross');
  await page.click('[data-testid=sub-create]');
  await page.waitForSelector('[data-testid=perp-sub-row][data-sub="1"]');
  assert.match(await page.textContent('[data-testid=perp-sub-row][data-sub="1"] [data-f=mode]'), /Portfolio margin/);
  assert.equal((await dave.call('POST', '/v1/perps/subaccounts/transfers', { from_subaccount: 0, to_subaccount: 1, amount_dollars: 300 })).status, 201);
  // The same BTC long (100 contracts, $1,000 at 10x) in the isolated primary and in the cross subaccount; ETH long in cross too.
  for (const sub of [0, 1]) assert.equal((await dave.call('POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'market', count: 100, leverage: 10, subaccount: sub })).status, 201);
  assert.equal((await dave.call('POST', '/v1/perps/orders', { ticker: ETH, side: 'bid', type: 'market', count: 100, leverage: 5, subaccount: 1 })).status, 201);
  const ps = (await dave.call('GET', '/v1/perps/positions')).body.positions;
  const iso = ps.find((p) => p.subaccount === 0 && p.market_ticker === BTC);
  const cross = ps.find((p) => p.subaccount === 1 && p.market_ticker === BTC);
  assert.equal(cross.margin_mode, 'cross');
  assert.ok(Number(cross.estimated_liquidation_price) < Number(iso.estimated_liquidation_price) * 0.85, `cross liq ${cross.estimated_liquidation_price} vs isolated ${iso.estimated_liquidation_price}`);
  const risk0 = (await dave.call('GET', '/v1/perps/risk')).body.subaccounts.find((x) => x.subaccount === 1);
  assert.equal(risk0.is_portfolio, true);
  // BTC to 90,000: below the isolated liquidation price, above the portfolio one.
  pin(BTC, 90000);
  await eventually(() => assert.equal(one('SELECT qty FROM perp_positions WHERE user_id=? AND subaccount=0 AND ticker=?', dave.uid, BTC).qty, 0));
  assert.ok(one('SELECT qty FROM perp_positions WHERE user_id=? AND subaccount=1 AND ticker=?', dave.uid, BTC).qty > 0, 'the cross position survives');
  // BTC to 73,000: portfolio equity below the portfolio maintenance margin → the largest requirement (BTC) goes first.
  pin(BTC, 73000);
  await eventually(() => assert.equal(one('SELECT qty FROM perp_positions WHERE user_id=? AND subaccount=1 AND ticker=?', dave.uid, BTC).qty, 0));
  const lq = one("SELECT * FROM perp_liquidations WHERE user_id=? AND subaccount=1 AND margin_mode='cross'", dave.uid);
  assert.equal(lq.ticker, BTC);
  assert.ok(one('SELECT qty FROM perp_positions WHERE user_id=? AND subaccount=1 AND ticker=?', dave.uid, ETH).qty > 0, 'ETH covers the rest and stays open');
  const sub1 = one('SELECT available_cc c FROM perp_subaccounts WHERE user_id=? AND subaccount=1', dave.uid).c;
  assert.ok(sub1 >= 0, `no negative collateral (${sub1})`);
  const r1 = (await dave.call('GET', '/v1/perps/risk')).body.subaccounts.find((x) => x.subaccount === 1);
  assert.ok(Number(r1.account_equity) >= Number(r1.maintenance_margin), JSON.stringify(r1));
  // The UI shows the liquidation in History and the surviving ETH position labelled as portfolio margin.
  await page.goto(BASE + '/portfolio?perpsTab=history');
  await page.waitForSelector('[data-testid=perp-liquidation-row]');
  assert.equal(await page.locator('[data-testid=perp-liquidation-row]').count(), 2);
  await page.goto(BASE + '/portfolio?perpsTab=positions');
  await page.waitForSelector(`[data-testid=perp-position][data-ticker=${ETH}][data-sub="1"]`);
  assert.match(await page.textContent(`[data-testid=perp-position][data-ticker=${ETH}][data-sub="1"] [data-f=sub]`), /Portfolio margin/);
  // Changing a busy subaccount's margin mode is refused.
  err(await dave.call('PUT', '/v1/perps/subaccounts/1', { margin_mode: 'isolated' }), 409, 'subaccount_busy');
  ledgerOk();
  assert.deepEqual(page.errors, []);
});

test('fractional perps: hundredths of a contract on fractional markets, refused on whole-contract markets and with the flag off', async () => {
  pin(BTC, 100000); pin(US10Y, 4.3);
  const erin = await fundedUser('erin', 2000, 1000);
  const page = await newPage();
  await uiLogIn(page, { email: email('erin') });
  await page.goto(BASE + `/perps/${BTC}`);
  await page.waitForSelector('[data-testid=perp-ticket] [data-testid=perp-amount]');
  await page.click('[data-testid=perp-unit] [data-unit=contracts]');
  await page.fill('[data-testid=perp-amount]', '2.57');
  await setLeverage(page, 5);
  await page.waitForFunction(() => document.querySelector('[data-o=contracts]').textContent === '2.57');
  await page.click('[data-testid=perp-submit]');
  const row = `[data-testid=perp-position][data-ticker=${BTC}][data-sub="0"]`;
  await page.waitForSelector(row);
  assert.equal(await page.textContent(`${row} [data-f=size]`), '2.57');
  const p = one('SELECT * FROM perp_positions WHERE user_id=? AND ticker=?', erin.uid, BTC);
  assert.equal(p.qty, 257);
  const f = one("SELECT * FROM perp_fills WHERE user_id=? AND source='user' ORDER BY created_ts DESC LIMIT 1", erin.uid);
  assert.equal(f.count, 257);
  assert.equal(f.fee_cc, Math.ceil((257 * f.price_cc * 0.0006) / 100 - 1e-9));
  assert.equal(p.margin_cc, Math.ceil((257 * f.price_cc) / (100 * 5) - 1e-9));
  // Money mode: ₦12,345 at 5x buys a fractional count, floored to 0.01.
  await page.click('[data-testid=perp-unit] [data-unit=usd]');
  await page.fill('[data-testid=perp-amount]', '12345');
  await page.waitForFunction(() => /^\d+\.\d{1,2}$|^\d+$/.test(document.querySelector('[data-o=contracts]').textContent));
  // API: count_fp, 2-decimal rule, partial close of a fractional position.
  let r = await erin.call('POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'market', count_fp: '0.01', leverage: 5 });
  assert.equal(r.status, 201, r.text); assert.equal(r.body.fill_count, '0.01');
  err(await erin.call('POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'market', count: 0.005, leverage: 5 }), 400, 'bad_request');
  err(await erin.call('POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'market', count: 1, count_fp: '1.5', leverage: 5 }), 400, 'bad_request');
  r = await erin.call('POST', `/v1/perps/positions/${BTC}/close`, { percent: 50 });
  assert.equal(r.status, 200, r.text); assert.equal(r.body.order.fill_count, '1.29');
  assert.equal(one('SELECT qty FROM perp_positions WHERE user_id=? AND ticker=?', erin.uid, BTC).qty, 129);
  // Whole-contract market: fractions refused, whole counts fine.
  const m10 = (await erin.call('GET', `/v1/perps/markets/${US10Y}`)).body.market;
  assert.deepEqual([m10.fractional_trading_enabled, m10.contract_decimals], [false, 0]);
  r = await erin.call('POST', '/v1/perps/orders', { ticker: US10Y, side: 'bid', type: 'market', count: 1.5, leverage: 5 });
  err(r, 400, 'fractional_not_enabled');
  assert.equal((await erin.call('POST', '/v1/perps/orders', { ticker: US10Y, side: 'bid', type: 'market', count: 2, leverage: 5 })).status, 201);
  await page.goto(BASE + `/perps/${US10Y}`);
  await page.waitForSelector('[data-testid=perp-ticket] [data-testid=perp-amount]');
  await page.click('[data-testid=perp-unit] [data-unit=contracts]');
  await page.fill('[data-testid=perp-amount]', '1.5');
  await page.waitForFunction(() => document.querySelector('[data-o=contracts]').textContent === '1', null, { timeout: 5000 });
  // Funding on a fractional position is exact to the unit.
  srv.engine.perps.runFunding(BTC);
  const fp = one('SELECT * FROM perp_funding_payments WHERE user_id=? AND ticker=? ORDER BY funding_ts DESC LIMIT 1', erin.uid, BTC);
  assert.equal(fp.qty, 129);
  assert.equal(fp.amount_cc, Math.round((-fp.qty * fp.mark_cc * fp.rate) / 100));
  // The flag off: fractional sizes are refused (feature_disabled), whole contracts still trade.
  assert.equal((await adminCall('PUT', '/v1/admin/flags/perps.fractional', { enabled: false, reason: 'fractional off for the e2e' })).status, 200);
  r = await erin.call('POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'market', count: 0.5, leverage: 5 });
  err(r, 403, 'feature_disabled');
  assert.equal((await erin.call('POST', '/v1/perps/orders', { ticker: BTC, side: 'bid', type: 'market', count: 1, leverage: 5 })).status, 201);
  // A held fractional position can still be closed in full.
  r = await erin.call('POST', `/v1/perps/positions/${BTC}/close`, {});
  assert.equal(r.status, 200, r.text);
  assert.equal(one('SELECT qty FROM perp_positions WHERE user_id=? AND ticker=?', erin.uid, BTC).qty, 0);
  assert.equal((await adminCall('PUT', '/v1/admin/flags/perps.fractional', { enabled: true, reason: 'fractional back on' })).status, 200);
  ledgerOk();
  assert.deepEqual(page.errors, []);
});

test('persistence: tiers, risk settings and portfolio subaccounts survive a restart', async () => {
  const tiers = dbq('SELECT * FROM perp_margin_tiers ORDER BY ticker, tier');
  const risk = srv.engine.perps.riskSettings();
  await srv.close();
  srv = await start(OPTS);
  admin = await new Client(BASE, 'admin').logIn(ADMIN.email, ADMIN.password);
  assert.deepEqual(dbq('SELECT * FROM perp_margin_tiers ORDER BY ticker, tier'), tiers);
  assert.deepEqual(srv.engine.perps.riskSettings(), risk);
  assert.equal(one("SELECT margin_mode FROM perp_subaccounts WHERE name='Portfolio'").margin_mode, 'cross');
  const m = (await admin.call('GET', `/v1/perps/markets/${SOL}`)).body.market;
  assert.equal(m.max_position_notional_dollars, '4000.0000');
  ledgerOk();
});

test('no page errors anywhere', () => {
  assert.deepEqual(allPages.flatMap((p) => p.errors), []);
});
