'use strict';
// End-to-end browser tests for the Perps margin product (PERPS_SPEC_SECTION.md / CLONE_SPEC §14).
// Real server + real SQLite file + real Chromium. The simulated index is pinned through the engine hook
// (srv.engine.perps.setIndex, the same code path as POST /v1/perps/admin/markets/:ticker/index).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-perps-'));
const DB_FILE = path.join(TMP, 'perps.db');
const PORT = 4400 + Math.floor(Math.random() * 40);
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'correct-horse-9';
const BTC = 'PLXBTCPERP';
const ETH = 'PLXETHPERP';
const stamp = Date.now();
const alice = { email: `alice.perps.${stamp}@example.test`, name: 'Alice Perps' };
const bob = { email: `bob.perps.${stamp}@example.test`, name: 'Bob Perps' };

let srv; let browser; let pa; // pa = Alice's page, shared across the trading tests
const allPages = [];
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const one = (sql, ...a) => dbq(sql, ...a)[0];
const uid = (email) => one('SELECT id FROM users WHERE email=?', email).id;
// Expected display strings under the NGN default (CLONE_SPEC.md §30): ×100; asset levels drop two decimals; amounts show kobo only when present.
const usd = (v, d = 2) => `₦${(Number(v) * 100).toLocaleString('en-NG', { minimumFractionDigits: Math.max(0, d - 2), maximumFractionDigits: Math.max(0, d - 2) })}`;
const naira = (v) => { const n = Math.round(Number(v) * 10000) / 100; return `₦${n.toLocaleString('en-NG', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`; };
// BTC contract size is 0.0001, so an underlying BTC level in dollars equals the per-contract price in centicents.
const btcLevel = (cc) => usd(Math.round(cc));

async function newPage(viewport = { width: 1366, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('dialog', (d) => d.accept());
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
// Authenticated JSON call from inside the page (cookie session + CSRF header).
function apiCall(page, method, url, body) {
  return page.evaluate(async ({ method, url, body }) => {
    const csrf = JSON.parse(localStorage.getItem('csrfToken')).value;
    const r = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(j));
    return j;
  }, { method, url, body });
}
async function deposit(page, email, dollars) { await apiCall(page, 'POST', `/v1/users/${uid(email)}/deposits`, { amount_dollars: dollars }); }
async function setLeverage(page, x) {
  await page.$eval('[data-testid=perp-leverage]', (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, String(x));
}
async function eventually(fn, { timeout = 10000, interval = 100 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    try { return await fn(); } catch (e) { if (Date.now() > end) throw e; }
    await new Promise((r) => setTimeout(r, interval));
  }
}
const pos = (email, t) => one('SELECT * FROM perp_positions WHERE user_id=? AND ticker=?', uid(email), t);
const liqCc = (p, mmRate) => {
  const q = Math.abs(p.qty);
  return p.qty > 0 ? (q * p.entry_cc - p.margin_cc) / (q * (1 - mmRate)) : (p.margin_cc + q * p.entry_cc) / (q * (1 + mmRate));
};

before(async () => { srv = await start({ port: PORT, dbFile: DB_FILE, tickMs: 250 }); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('perps list: seeded markets, asset-class chips filter, live ticker updates', async () => {
  const page = await newPage();
  await page.goto(BASE + '/perps');
  await page.waitForSelector('[data-testid=perp-row]');
  assert.equal(await page.locator('[data-testid=perp-row]').count(), 7);
  assert.equal(dbq('SELECT COUNT(*) c FROM perp_markets')[0].c, 7);
  const chips = await page.textContent('[data-testid=perps-chips]');
  assert.match(chips, /All\s*7/);
  assert.match(chips, /Crypto\s*3/);
  assert.match(chips, /Metals\s*1/);
  assert.match(await page.textContent(`[data-ticker=${BTC}] [data-f=price]`), /^\$\d{2,3},\d{3}\.\d{2}$/);
  assert.match(await page.textContent(`[data-ticker=${BTC}] [data-f=funding]`), /^-?\d\.\d{4}%$/);
  // Category filter (route /perps/categories/{assetClass}, lower-cased).
  await page.click('[data-testid=perps-chips] a[data-class=Metals]');
  await page.waitForURL(BASE + '/perps/categories/metals');
  await page.waitForFunction(() => { const r = document.querySelectorAll('[data-testid=perp-row]'); return r.length === 1 && r[0].dataset.ticker === 'PLXGOLDPERP'; });
  await page.click('[data-testid=perps-chips] a[data-class=Crypto]');
  await page.waitForURL(BASE + '/perps/categories/crypto');
  await page.waitForFunction(() => { const r = [...document.querySelectorAll('[data-testid=perp-row]')]; return r.length === 3 && r.every((x) => x.dataset.class === 'Crypto'); });
  // Live: pin ETH and watch the row update over the perp_ticker channel.
  srv.engine.perps.setIndex(ETH, 3500, { freeze: true });
  await page.waitForFunction((t) => document.querySelector(`[data-ticker=${t}] [data-f=price]`)?.textContent === '₦350,000', ETH);
  // Clicking a row opens the market page.
  await page.click(`[data-ticker=${ETH}] td.num`);
  await page.waitForURL(BASE + `/perps/${ETH}`);
  await page.waitForSelector('[data-testid=perp-market]');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('market page: chart, order book, trades, stats and a logged-out ticket', async () => {
  const page = await newPage();
  await page.goto(BASE + `/perps/${BTC}`);
  await page.waitForSelector('[data-testid=perp-chart] svg polyline');
  const pts = await page.$eval('[data-testid=perp-chart] polyline', (e) => e.getAttribute('points').split(' ').length);
  assert.ok(pts > 20, `chart has ${pts} points`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=perp-asks] .perps-lvl').length >= 5 && document.querySelectorAll('[data-testid=perp-bids] .perps-lvl').length >= 5);
  // Best ask above best bid.
  const [ask, bid] = await page.evaluate(() => [document.querySelector('[data-testid=perp-asks] .perps-lvl:last-child span').textContent, document.querySelector('[data-testid=perp-bids] .perps-lvl span').textContent]);
  assert.ok(Number(ask.replace(/[₦,]/g, '')) > Number(bid.replace(/[₦,]/g, '')), `${ask} > ${bid}`);
  assert.ok(await page.locator('[data-testid=perp-trades] .perps-lvl.trade').count() >= 5);
  assert.match(await page.textContent('[data-s=funding]'), /%$/);
  assert.match(await page.textContent('[data-s=countdown]'), /^in /);
  await page.click('[data-range="1H"]');
  await page.waitForFunction(() => document.querySelector('[data-range="1H"]').classList.contains('on') && document.querySelector('[data-testid=perp-chart] polyline'));
  assert.match(await page.textContent('[data-testid=perp-ticket]'), /Log in to trade/);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('transfer prediction cash into perps and back (DB rows + both balances)', async () => {
  pa = await newPage();
  await signUp(pa, alice);
  await deposit(pa, alice.email, 1000);
  await pa.goto(BASE + `/perps/${BTC}`);
  await pa.waitForSelector('[data-testid=perp-transfer]');
  await pa.waitForFunction(() => document.querySelector('[data-testid=pred-cash]').textContent === '₦100,000');
  await pa.fill('[data-testid=xfer-amount]', '50000');
  await pa.click('[data-testid=xfer-to-perps]');
  await pa.waitForFunction(() => document.querySelector('[data-testid=perps-available]')?.textContent === '₦50,000');
  await pa.waitForFunction(() => document.querySelector('[data-testid=pred-cash]').textContent === '₦50,000');
  await pa.waitForFunction(() => document.querySelector('[data-testid=header-balance]').textContent === '₦50,000');
  const a = uid(alice.email);
  assert.equal(one('SELECT balance_cents c FROM users WHERE id=?', a).c, 50000);
  assert.equal(one('SELECT available_cc c FROM perp_accounts WHERE user_id=?', a).c, 5000000);
  const t1 = dbq('SELECT * FROM perp_transfers WHERE user_id=?', a);
  assert.equal(t1.length, 1);
  assert.deepEqual([t1[0].source, t1[0].destination, t1[0].amount_cc, t1[0].status], ['event_contract', 'margined', 5000000, 'completed']);
  assert.equal(one("SELECT amount_cents c FROM ledger WHERE user_id=? AND kind='perps_transfer'", a).c, -50000);
  // And back again.
  await pa.fill('[data-testid=xfer-amount]', '2000');
  await pa.click('[data-testid=xfer-to-predictions]');
  await pa.waitForFunction(() => document.querySelector('[data-testid=perps-available]')?.textContent === '₦48,000');
  await pa.waitForFunction(() => document.querySelector('[data-testid=header-balance]').textContent === '₦52,000');
  assert.equal(one('SELECT balance_cents c FROM users WHERE id=?', a).c, 52000);
  assert.equal(one('SELECT available_cc c FROM perp_accounts WHERE user_id=?', a).c, 4800000);
  assert.equal(dbq("SELECT * FROM perp_transfers WHERE user_id=? AND source='margined' AND destination='event_contract' AND amount_cc=200000", a).length, 1);
  // Over-withdrawal is refused with a visible error.
  await pa.fill('[data-testid=xfer-amount]', '500000');
  await pa.click('[data-testid=xfer-to-perps]');
  await pa.waitForFunction(() => /insufficient balance/.test(document.querySelector('[data-testid=xfer-error]').textContent));
  assert.deepEqual(pa.errors, []);
});

test('open a 10x long with a market order: entry, leverage and liquidation price shown', async () => {
  srv.engine.perps.setIndex(BTC, 100000, { freeze: true });
  await pa.waitForFunction(() => document.querySelector('[data-testid=perp-mark]')?.textContent === '₦10,000,000');
  await pa.fill('[data-testid=perp-amount]', '10000');
  await setLeverage(pa, 10);
  await pa.waitForFunction(() => document.querySelector('[data-testid=perp-leverage-out]').textContent === '10x');
  await pa.waitForFunction(() => /^₦\d,\d{3},\d{3}$/.test(document.querySelector('[data-testid=perp-est-liq]').textContent));
  const estLiq = Number((await pa.textContent('[data-testid=perp-est-liq]')).replace(/[₦,]/g, '')) / 100; // naira → dollars
  assert.ok(estLiq > 90000 && estLiq < 94000, `estimated liq ${estLiq}`);
  await pa.click('[data-testid=perp-submit]');
  await pa.waitForSelector(`[data-testid=perp-position][data-ticker=${BTC}]`);
  const p = pos(alice.email, BTC);
  assert.ok(p.qty >= 95 && p.qty <= 100, `qty ${p.qty}`);
  assert.ok(Math.abs(p.entry_cc - 100000) < 200, `entry ${p.entry_cc}`);
  assert.ok(Math.abs(p.leverage - 10) < 0.05, `leverage ${p.leverage}`);
  const row = `[data-testid=perp-position][data-ticker=${BTC}]`;
  assert.equal(await pa.textContent(`${row} [data-f=side]`), 'Long');
  assert.equal(await pa.textContent(`${row} [data-f=size]`), String(p.qty));
  assert.equal(await pa.textContent(`${row} [data-f=entry]`), btcLevel(p.entry_cc));
  assert.equal(await pa.textContent(`${row} [data-f=leverage]`), '10x');
  assert.equal(await pa.textContent(`${row} [data-f=liq]`), btcLevel(liqCc(p, 0.025)));
  // Fill persisted with a taker fee; margin came out of the perps collateral.
  const f = one("SELECT * FROM perp_fills WHERE user_id=? AND ticker=? AND source='user'", uid(alice.email), BTC);
  assert.ok(f.is_taker === 1 && f.fee_cc > 0 && f.count === p.qty);
  const avail = one('SELECT available_cc c FROM perp_accounts WHERE user_id=?', uid(alice.email)).c;
  assert.equal(avail, 4800000 - p.margin_cc - f.fee_cc);
  assert.deepEqual(pa.errors, []);
});

test('mark moves: unrealized PnL updates live', async () => {
  const p = pos(alice.email, BTC);
  srv.engine.perps.setIndex(BTC, 102000);
  const row = `[data-testid=perp-position][data-ticker=${BTC}]`;
  await pa.waitForFunction((r) => document.querySelector(`${r} [data-f=mark]`).textContent === '₦10,200,000', row);
  const want = (p.qty * (102000 - p.entry_cc)) / 10000;
  await eventually(async () => {
    const got = Number(await pa.getAttribute(`${row} [data-f=pnl]`, 'data-upnl'));
    assert.ok(Math.abs(got - want) < 0.005, `upnl ${got} vs ${want}`);
  });
  assert.match(await pa.textContent(`${row} [data-f=pnl]`), /^\+\$\d+\.\d{2} \(\+\d+\.\d{2}%\)$/);
  assert.match(await pa.textContent('[data-testid=perp-mark]'), /₦10,200,000/);
  assert.deepEqual(pa.errors, []);
});

test('take-profit trigger fires on the mark and closes the position', async () => {
  const row = `[data-testid=perp-position][data-ticker=${BTC}]`;
  await pa.click(`${row} [data-testid=tpsl-btn]`);
  await pa.fill('[data-testid=tp-input]', '10400000');
  await pa.fill('[data-testid=sl-input]', '9500000');
  await pa.click('[data-testid=tpsl-save]');
  await pa.waitForFunction((r) => /TP ₦10,400,000 · SL ₦9,500,000/.test(document.querySelector(`${r} [data-testid=tpsl-btn]`).textContent), row);
  const a = uid(alice.email);
  const tr = one("SELECT * FROM perp_exit_triggers WHERE user_id=? AND status='active'", a);
  assert.deepEqual([tr.take_profit_cc, tr.stop_loss_cc, tr.kind], [104000, 95000, 'bracket']);
  // A take-profit below the mark for a long is rejected.
  await pa.click(`${row} [data-testid=tpsl-btn]`);
  await pa.fill('[data-testid=tp-input]', '10100000');
  await pa.click('[data-testid=tpsl-save]');
  await pa.waitForFunction(() => /take profit must be above/.test(document.querySelector('[data-testid=tpsl-error]').textContent));
  srv.engine.perps.setIndex(BTC, 104500);
  await pa.waitForSelector('[data-testid=perp-no-positions]');
  const done = one('SELECT * FROM perp_exit_triggers WHERE id=?', tr.id);
  assert.deepEqual([done.status, done.triggered_leg], ['filled', 'take_profit']);
  assert.equal(pos(alice.email, BTC).qty, 0);
  const closing = one('SELECT * FROM perp_fills WHERE user_id=? AND source=?', a, 'exit_trigger');
  assert.ok(closing.realized_cc > 0, 'take profit realized a gain');
  assert.equal(dbq("SELECT * FROM notifications WHERE user_id=? AND type='perp_exit_trigger'", a).length, 1);
  assert.deepEqual(pa.errors, []);
});

test('price band rejects a limit far from the mark; a limit inside the band rests and can be canceled', async () => {
  const a = uid(alice.email);
  const before = dbq('SELECT COUNT(*) c FROM perp_orders WHERE user_id=?', a)[0].c;
  await pa.click('[data-testid=perp-type] [data-type=limit]');
  await pa.fill('[data-testid=perp-limit-price]', '5000000');
  await pa.fill('[data-testid=perp-amount]', '5000');
  await setLeverage(pa, 5);
  await pa.click('[data-testid=perp-submit]');
  await pa.waitForFunction(() => /outside the price band/.test(document.querySelector('[data-testid=perp-order-error]').textContent));
  assert.match(await pa.textContent('[data-testid=perp-order-error]'), /between ₦8,360,000 and ₦12,540,000/);
  assert.equal(dbq('SELECT COUNT(*) c FROM perp_orders WHERE user_id=?', a)[0].c, before);
  // Inside the band but below the bids: rests on the book with margin held.
  const availBefore = one('SELECT available_cc c FROM perp_accounts WHERE user_id=?', a).c;
  await pa.fill('[data-testid=perp-limit-price]', '9900000');
  await pa.click('[data-testid=perp-submit]');
  await pa.waitForFunction(() => document.querySelector('[data-testid=perp-order-error]').textContent === '');
  await pa.click('[data-testid=perp-account] [data-tab=orders]');
  await pa.waitForSelector('[data-testid=perp-order]');
  const o = one("SELECT * FROM perp_orders WHERE user_id=? AND status='resting'", a);
  assert.equal(o.price_cc, 99000);
  assert.ok(o.reserved_cc > 0);
  assert.equal(one('SELECT available_cc c FROM perp_accounts WHERE user_id=?', a).c, availBefore - o.reserved_cc);
  assert.equal(await pa.textContent('[data-testid=perp-order] [data-f=price]'), '₦9,900,000');
  // The order shows in the public (full-depth) book.
  const book = await pa.evaluate((t) => fetch(`/v1/perps/markets/${t}/orderbook`).then((r) => r.json()), BTC);
  assert.ok(book.orderbook.bids.some(([px, n]) => px === '9.9000' && Number(n) === o.remaining_count), JSON.stringify(book.orderbook.bids.slice(-3)));
  await pa.click('[data-testid=cancel-order]');
  await pa.waitForSelector('[data-testid=perp-no-orders]');
  assert.equal(one('SELECT status FROM perp_orders WHERE id=?', o.id).status, 'canceled');
  assert.equal(one('SELECT available_cc c FROM perp_accounts WHERE user_id=?', a).c, availBefore);
  await pa.click('[data-testid=perp-type] [data-type=market]');
  assert.deepEqual(pa.errors, []);
});

test('a 20x short is liquidated when the mark rises past its liquidation price', async () => {
  const a = uid(alice.email);
  await pa.click('[data-testid=perp-account] [data-tab=positions]');
  await pa.click('[data-testid=perp-side] [data-side=short]');
  await pa.fill('[data-testid=perp-amount]', '4000');
  await setLeverage(pa, 20);
  await pa.click('[data-testid=perp-submit]');
  const row = `[data-testid=perp-position][data-ticker=${BTC}]`;
  await pa.waitForSelector(row);
  assert.equal(await pa.textContent(`${row} [data-f=side]`), 'Short');
  const p = pos(alice.email, BTC);
  assert.ok(p.qty < 0);
  const liq = liqCc(p, 0.025);
  assert.equal(await pa.textContent(`${row} [data-f=liq]`), btcLevel(liq));
  assert.ok(liq > 104500 && liq < 108000, `liq ${liq}`);
  srv.engine.perps.setIndex(BTC, 111000);
  await pa.waitForSelector('[data-testid=perp-no-positions]');
  const l = one('SELECT * FROM perp_liquidations WHERE user_id=?', a);
  assert.deepEqual([l.ticker, l.side, l.count, l.mark_cc], [BTC, 'short', -p.qty, 111000]);
  assert.equal(pos(alice.email, BTC).qty, 0);
  assert.equal(dbq("SELECT * FROM notifications WHERE user_id=? AND type='perp_liquidation'", a).length, 1);
  assert.equal(one("SELECT COUNT(*) c FROM perp_fills WHERE user_id=? AND source='liquidation'", a).c, 1);
  // Notification arrives live in the header; the History tab lists the liquidation.
  await pa.waitForSelector('[data-testid=unread-count]');
  await pa.click('[data-testid=perp-account] [data-tab=history]');
  await pa.waitForSelector('[data-testid=perp-liquidation-row]');
  await pa.goto(BASE + '/notifications');
  await pa.waitForFunction(() => /Liquidated: Short/.test(document.querySelector('main').textContent));
  assert.deepEqual(pa.errors, []);
});

test('funding is paid on schedule: longs pay and shorts receive at a positive rate', async () => {
  // Alice goes long ETH, Bob goes short ETH (both through the UI).
  await pa.goto(BASE + `/perps/${ETH}`);
  await pa.waitForSelector('[data-testid=perp-ticket] [data-testid=perp-amount]');
  await pa.fill('[data-testid=perp-amount]', '10000');
  await setLeverage(pa, 5);
  await pa.click('[data-testid=perp-submit]');
  await pa.waitForSelector(`[data-testid=perp-position][data-ticker=${ETH}]`);
  const pb = await newPage();
  await signUp(pb, bob);
  await deposit(pb, bob.email, 300);
  await pb.goto(BASE + `/perps/${ETH}`);
  await pb.waitForSelector('[data-testid=perp-transfer]');
  await pb.fill('[data-testid=xfer-amount]', '20000');
  await pb.click('[data-testid=xfer-to-perps]');
  await pb.waitForFunction(() => document.querySelector('[data-testid=perps-available]')?.textContent === '₦20,000');
  await pb.click('[data-testid=perp-side] [data-side=short]');
  await pb.fill('[data-testid=perp-amount]', '10000');
  await setLeverage(pb, 5);
  await pb.click('[data-testid=perp-submit]');
  await pb.waitForSelector(`[data-testid=perp-position][data-ticker=${ETH}]`);
  await pb.context().close();
  const marginA = pos(alice.email, ETH).margin_cc;
  const marginB = pos(bob.email, ETH).margin_cc;
  assert.equal(dbq('SELECT COUNT(*) c FROM perp_funding_payments')[0].c, 0);

  // Restart with a short funding interval (start({ perps: { fundingIntervalMs } })).
  await srv.close();
  srv = await start({ port: PORT, dbFile: DB_FILE, tickMs: 250, perps: { fundingIntervalMs: 1500 } });
  const a = uid(alice.email); const b = uid(bob.email);
  await eventually(() => {
    const n = dbq('SELECT user_id, COUNT(*) c FROM perp_funding_payments WHERE ticker=? AND user_id IN (?,?) GROUP BY user_id', ETH, a, b);
    assert.ok(n.length === 2 && n.every((r) => r.c >= 2), JSON.stringify(n));
  }, { timeout: 15000 });
  const rates = dbq('SELECT * FROM perp_funding_rates WHERE ticker=? AND funding_ts>? ORDER BY funding_ts', ETH, Date.now() - 60000);
  assert.ok(rates.length >= 2);
  for (const r of rates) assert.ok(r.rate > 0, `rate ${r.rate} (pinned index, symmetric book: interest component only)`);
  for (const [who, sign] of [[a, -1], [b, 1]]) {
    const rows = dbq('SELECT * FROM perp_funding_payments WHERE ticker=? AND user_id=? ORDER BY funding_ts', ETH, who);
    for (const r of rows) {
      assert.equal(Math.sign(r.amount_cc), sign, `${who === a ? 'long pays' : 'short receives'}: ${r.amount_cc}`);
      assert.equal(r.amount_cc, Math.round(-r.qty * r.mark_cc * r.rate));
      assert.equal(r.mark_cc, 35000);
    }
  }
  // Payments were applied to each isolated position's margin.
  const sumA = one('SELECT SUM(amount_cc) s FROM perp_funding_payments WHERE ticker=? AND user_id=?', ETH, a).s;
  const sumB = one('SELECT SUM(amount_cc) s FROM perp_funding_payments WHERE ticker=? AND user_id=?', ETH, b).s;
  const now = [pos(alice.email, ETH), pos(bob.email, ETH)];
  assert.equal(now[0].margin_cc, marginA + one('SELECT SUM(amount_cc) s FROM perp_funding_payments WHERE ticker=? AND user_id=? ', ETH, a).s);
  assert.equal(now[1].margin_cc, marginB + one('SELECT SUM(amount_cc) s FROM perp_funding_payments WHERE ticker=? AND user_id=? ', ETH, b).s);
  assert.ok(sumA < 0 && sumB > 0);
  // The Funding tab shows the payments with the right sign.
  await pa.goto(BASE + `/perps/${ETH}`); // the session cookie survives the restart
  await pa.click('[data-testid=perp-account] [data-tab=funding]');
  await pa.waitForSelector('[data-testid=perp-funding-row]');
  const amounts = await pa.$$eval('[data-testid=perp-funding-row]', (els) => els.map((e) => Number(e.dataset.amount)));
  assert.ok(amounts.length >= 2 && amounts.every((x) => x < 0), `long payments ${amounts}`);
  assert.match(await pa.textContent('[data-testid=perp-funding-row]'), /Long \d+.*0\.0100%.*-₦\d+(\.\d{2})?/);
  assert.deepEqual(pa.errors, []);
});

test('everything persists across a restart; Perps portfolio tabs', async () => {
  const a = uid(alice.email);
  await srv.close();
  srv = await start({ port: PORT, dbFile: DB_FILE, tickMs: 250 });
  const page = await newPage();
  await logIn(page, alice.email);
  await page.goto(BASE + '/portfolio');
  await page.waitForLoadState('networkidle');
  await page.click('[data-testid=perps-portfolio-link]');
  await page.waitForURL(BASE + '/portfolio?perpsTab=positions');
  await page.waitForSelector(`[data-testid=perp-position][data-ticker=${ETH}]`);
  const p = pos(alice.email, ETH);
  assert.equal(await page.textContent(`[data-testid=perp-position][data-ticker=${ETH}] [data-f=size]`), String(p.qty));
  assert.equal(await page.textContent(`[data-testid=perp-position][data-ticker=${ETH}] [data-f=entry]`), usd(p.entry_cc / 10000 / 0.001));
  const avail = one('SELECT available_cc c FROM perp_accounts WHERE user_id=?', a).c;
  assert.equal(await page.textContent('[data-testid=perps-port-available]'), naira(avail / 10000));
  assert.equal(await page.textContent('[data-testid=header-balance]'), naira(one('SELECT balance_cents c FROM users WHERE id=?', a).c / 100));
  await page.click('[data-ptab=orders]');
  await page.waitForSelector('[data-testid=perp-no-orders]');
  await page.waitForURL(/perpsTab=orders/);
  await page.click('[data-ptab=history]');
  await page.waitForSelector('[data-testid=perp-liquidation-row]');
  assert.equal(await page.locator('[data-testid=perp-transfer-row]').count(), 2);
  assert.ok(await page.locator('[data-testid=perp-funding-row]').count() >= 2);
  assert.ok(await page.locator('[data-testid=perp-fill-row][data-source=exit_trigger]').count() === 1);
  assert.ok(await page.locator('[data-testid=perp-fill-row][data-source=liquidation]').count() === 1);
  // Reload keeps the tab (URL state) and the pinned simulation survived the restart.
  await page.reload();
  await page.waitForSelector('[data-testid=perp-liquidation-row]');
  assert.equal(one('SELECT sim_frozen f, index_price p FROM perp_markets WHERE ticker=?', BTC).f, 1);
  assert.equal(one('SELECT index_price p FROM perp_markets WHERE ticker=?', BTC).p, 111000);
  await page.goto(BASE + `/perps/${BTC}`);
  await page.waitForFunction(() => document.querySelector('[data-testid=perp-mark]')?.textContent === '₦11,100,000');
  // Back to the predictions portfolio.
  await page.goto(BASE + '/portfolio?perpsTab=positions');
  await page.click('[data-testid=product-predictions]');
  await page.waitForURL(BASE + '/portfolio');
  await page.waitForSelector('[data-testid=perps-portfolio-link]');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('mobile 390px: no horizontal overflow on perps pages (dark and light)', async () => {
  const page = await newPage({ width: 390, height: 844 });
  await logIn(page, alice.email);
  for (const theme of ['dark', 'light']) {
    await apiCall(page, 'PUT', `/v1/users/${uid(alice.email)}/properties`, { properties: { theme } });
    for (const p of ['/perps', '/perps/categories/crypto', `/perps/${BTC}`, `/perps/${ETH}`, '/portfolio?perpsTab=positions', '/portfolio?perpsTab=history']) {
      await page.goto(BASE + p);
      await page.waitForSelector('[data-testid=perps-list], [data-testid=perp-market], [data-testid=perps-portfolio]');
      await page.waitForTimeout(300);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(over <= 0, `${p} overflows by ${over}px in ${theme}`);
    }
  }
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('no page errors anywhere', () => {
  assert.deepEqual(allPages.flatMap((p) => p.errors), []);
});
