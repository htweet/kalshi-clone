'use strict';
// End-to-end tests for the Phase 5A trading core (CLONE_SPEC.md §28), each against a real server, a real SQLite file and
// Chromium: sub-cent price grids with exact fee accounting (G1 accumulator), the order review step on and off (A7), the
// auto-sell prompt (A7), flip sell (A8), scalar settlement payouts (P5.2), collateral return on mutually exclusive
// events (A9), settlement correction with claw-back, step-up and the Phase 4 debt rule (G6), the two-person rule and
// market-creation permissions (security gate), combos on the finer grid with the HVM 3 s last look (G12), persistence
// across a restart, the ledger audit, and 390px layouts in light and dark.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const journal = require('../server/journal.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-trading-core-'));
const DB_FILE = path.join(TMP, 'trading-core.db');
const PORT = 4740 + Math.floor(Math.random() * 30);
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'correct-horse-9';
const ADMIN = { email: 'admin@parlance.local', password: 'Ledger-Keeper-2026!' };
const OPTS = { port: PORT, dbFile: DB_FILE, tickMs: 250, quiet: true, admin: ADMIN, combos: { makerDelayMs: 60000 } };
const SNOW = 'PLXSNOW-26DEC'; const SNOW_URL = '/markets/plxsnow/snow/plxsnow-26dec';
const GDP = 'PLXGDP-26Q4'; const GDP_URL = '/markets/plxgdp/gdp/plxgdp-26q4';
const COMET = 'PLXCOMET-26'; const COMET_URL = '/markets/plxcomet/comet/plxcomet-26';
const RATE = ['PLXRATE-26DEC-CUT', 'PLXRATE-26DEC-HOLD', 'PLXRATE-26DEC-HIKE'];
const LAUNCH = 'PLXLAUNCH-27Q1';
const stamp = Date.now();
const A = { email: `tca.${stamp}@example.test`, name: 'Ari Subcent' };
const B = { email: `tcb.${stamp}@example.test`, name: 'Bo Scalar' };
const C = { email: `tcc.${stamp}@example.test`, name: 'Cy Hedger' };
const D = { email: `tcd.${stamp}@example.test`, name: 'Dee Debtor' };
const ADMIN2 = { email: `tc2.${stamp}@example.test`, name: 'Second Admin' };

let srv; let browser;
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const dbrun = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
const uid = (u) => dbq('SELECT id FROM users WHERE email=?', u.email)[0].id;
const bal = (u) => dbq('SELECT balance_cents b FROM users WHERE id=?', uid(u))[0].b;
const pref = (u, k) => { const r = dbq('SELECT value FROM user_settings WHERE user_id=? AND key=?', uid(u), k)[0]; return r ? JSON.parse(r.value) : undefined; };
const acct = (a) => dbq('SELECT COALESCE(SUM(amount_cents),0) s FROM journal_postings WHERE account=?', a)[0].s;
const feeMicro = (q, p) => Number((7000000n * BigInt(q) * BigInt(p) * BigInt(10000 - p) + 10n ** 12n - 1n) / 10n ** 12n); // k=700, multiplier 1
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out waiting for a DB condition'); await new Promise((r) => setTimeout(r, 120)); } };
async function newPage(viewport = { width: 1600, height: 1100 }) {
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
  await page.fill('#f-amount', String(dollars * 100)); // naira (CLONE_SPEC.md §30)
  await page.click('[data-act=deposit]');
  await page.waitForSelector(`[data-testid=header-balance]:has-text("₦${(dollars * 100).toLocaleString('en-NG')}")`);
}
async function logIn(page, u, pw = PW) {
  await page.goto(BASE + '/sign-in');
  await page.fill('input[name=email]', u.email);
  await page.fill('input[name=password]', pw);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
}
const call = (page, method, url, body) => page.evaluate(async ([m, u, b]) => {
  const csrf = JSON.parse(localStorage.getItem('csrfToken')).value;
  const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: b ? JSON.stringify(b) : undefined });
  return { s: r.status, b: await r.json().catch(() => null) };
}, [method, url, body]);
async function mode(page, m) { await page.click('#t-mode-btn'); await page.click(`[data-otype=${m}]`); }
async function toggleSetting(page, u, key, want) {
  await page.goto(BASE + '/account/settings');
  const box = page.locator(`[data-testid=toggle-${key}]`);
  await box.waitFor();
  if ((await box.isChecked()) !== want) await box.click();
  await until(() => pref(u, key) === want);
}
const order = (page, u, b) => call(page, 'POST', `/v1/users/${uid(u)}/orders`, b);
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

let pa; let pb; let pc; let padm; let dLeft = 0;
before(async () => { srv = await start(OPTS); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('sub-cent grid: 0.1¢ limit from the ticket matches two makers; fees accrue exactly and round once per order (G1)', async () => {
  pa = await newPage();
  await signUp(pa, A, 500);
  // Market JSON carries the grid and tick size.
  const mk = (await call(pa, 'GET', `/trade-api/v2/markets/${SNOW}`)).b.market;
  assert.equal(mk.price_level_structure, 'deci_cent');
  assert.equal(mk.tick_size_dollars, '0.0010');
  assert.deepEqual(mk.price_ranges, [{ start: '0.0000', end: '1.0000', step: '0.0010' }]);
  const comet = (await call(pa, 'GET', `/trade-api/v2/markets/${COMET}`)).b.market;
  assert.equal(comet.price_level_structure, 'tapered');
  assert.deepEqual(comet.price_ranges.map((r) => r.step), ['0.0001', '0.0010', '0.0100', '0.0010', '0.0001']);
  const book0 = (await call(pa, 'GET', `/trade-api/v2/markets/${SNOW}/orderbook`)).b;
  assert.ok(book0.orderbook_fp.no_dollars.some(([p]) => p === '0.8740'), 'a 0.1¢ ask level (YES 12.6¢) is on the book');

  await pa.goto(BASE + SNOW_URL);
  await pa.waitForSelector('[data-testid=submit-order]');
  await mode(pa, 'limit');
  await pa.waitForSelector('[data-testid=t-grid]');
  assert.equal(await pa.getAttribute('#t-price', 'step'), '0.1');
  await pa.fill('#t-price', '12.75');
  await pa.fill('#t-count', '150');
  await pa.waitForSelector('[data-testid=t-invalid]:has-text("grid")');
  assert.equal(await pa.isDisabled('[data-testid=submit-order]'), true);
  await pa.fill('#t-price', '12.9');
  await pa.waitForSelector('[data-testid=t-fee]');
  assert.match(await pa.textContent('[data-testid=submit-order]'), /Review · Buy Yes/);
  await pa.click('[data-testid=submit-order]');
  await pa.waitForSelector('[data-testid=order-review]');
  assert.match(await pa.textContent('[data-testid=review-price]'), /Limit ₦12\.90/);
  assert.equal(await pa.textContent('[data-testid=review-cost]'), '₦1,935');
  await pa.click('[data-testid=review-confirm]');
  await until(() => dbq("SELECT 1 FROM orders WHERE user_id=? AND market_ticker=? AND status='executed'", uid(A), SNOW).length === 1);
  const o = dbq('SELECT * FROM orders WHERE user_id=? AND market_ticker=?', uid(A), SNOW)[0];
  assert.deepEqual([o.price_cc, o.filled_count, o.reserved_cents], [1290, 15000, 0]);
  const fills = dbq('SELECT price_cc, count, fee_cents, fee_micro FROM fills WHERE order_id=? ORDER BY rowid', o.id);
  assert.deepEqual(fills.map((f) => [f.price_cc, f.count]), [[1260, 10000], [1290, 5000]], 'price improvement: best 0.1¢ level first');
  assert.deepEqual(fills.map((f) => f.fee_micro), [feeMicro(10000, 1260), feeMicro(5000, 1290)]);
  const exact = feeMicro(10000, 1260) + feeMicro(5000, 1290);
  assert.equal(o.fee_micro, exact);
  assert.equal(o.fees_cents, Math.ceil(exact / 10000), 'the order pays ceil(Σ exact fees): one rounding per order');
  assert.ok(o.fees_cents < fills.reduce((a, f) => a + Math.ceil(f.fee_micro / 10000), 0), 'cheaper than rounding every fill up');
  assert.equal(fills.reduce((a, f) => a + f.fee_cents, 0), o.fees_cents);
  const principal = Math.ceil((10000 * 1260) / 10000) + Math.ceil((5000 * 1290) / 10000);
  assert.equal(bal(A), 50000 - principal - o.fees_cents, 'cash moved by exactly principal + fee');
  // Journal: whole cents only; the rounding cent sits in house:fees:rounding and both sides balance.
  const legs = dbq("SELECT p.account, p.amount_cents FROM journal_postings p JOIN journal_entries e ON e.id=p.entry_id WHERE e.kind='fee' AND e.user_id=?", uid(A));
  assert.equal(legs.filter((l) => l.account === 'house:fees:rounding').reduce((a, l) => a + l.amount_cents, 0), o.fees_cents - Math.floor(exact / 10000));
  assert.equal(legs.reduce((a, l) => a + l.amount_cents, 0), 0);
  // REST order view and the order book / trades tab show the sub-cent prices.
  const vo = (await call(pa, 'GET', `/v1/users/${uid(A)}/orders/${o.id}`)).b.order;
  assert.equal(vo.price_dollars, '0.1290');
  assert.equal(vo.taker_fees_exact_dollars, (exact / 1e6).toFixed(6));
  await pa.click('[data-tab=book]');
  await pa.waitForSelector('[data-testid=orderbook] [data-testid=book-grid]:has-text("deci cent")');
  await pa.waitForSelector('[data-testid=book-price]:has-text("₦12.90")');
  const candles = (await call(pa, 'GET', `/trade-api/v2/series/PLXSNOW/markets/${SNOW}/candlesticks?period_interval=1&start_ts=${Math.floor(Date.now() / 1000) - 3600}&end_ts=${Math.floor(Date.now() / 1000) + 120}`)).b.candlesticks; // end past the fills (end_ts is whole seconds)
  assert.equal(candles.at(-1).price.close_dollars, '0.1290');
  // API validation: more precision than the grid, or a price between ticks, is refused.
  assert.equal((await order(pa, A, { ticker: SNOW, side: 'yes', type: 'limit', count: 1, price_dollars: '0.12345' })).s, 400);
  const off = await order(pa, A, { ticker: SNOW, side: 'yes', type: 'limit', count: 1, price_dollars: '0.1235' });
  assert.deepEqual([off.s, off.b.error.code], [400, 'invalid_price']);
  // Tapered grid: 0.01¢ ticks within 1¢ of the edge — a 0.55¢ bid rests from the ticket.
  await pa.goto(BASE + COMET_URL);
  await pa.waitForSelector('[data-testid=submit-order]');
  await mode(pa, 'limit');
  assert.equal(await pa.getAttribute('#t-price', 'step'), '0.01');
  await pa.fill('#t-price', '0.55');
  await pa.fill('#t-count', '20');
  await pa.click('[data-testid=submit-order]');
  await pa.click('[data-testid=review-confirm]');
  await until(() => dbq("SELECT 1 FROM orders WHERE user_id=? AND market_ticker=? AND status='resting' AND price_cc=55", uid(A), COMET).length === 1);
  await pa.click('[data-tab=book]');
  await pa.waitForSelector('[data-testid=book-price]:has-text("₦0.55")');
  assert.deepEqual(pa.errors, []);
});

test('order review: Edit returns to the ticket; Skip order review places at once (Settings › Trade mechanics)', async () => {
  await pa.goto(BASE + SNOW_URL);
  await pa.waitForSelector('[data-testid=submit-order]');
  await mode(pa, 'market');
  await pa.fill('#t-count', '5');
  await pa.click('[data-testid=submit-order]');
  await pa.waitForSelector('[data-testid=order-review]');
  assert.equal(await pa.isVisible('#t-count'), false, 'the review takes the ticket over');
  await pa.click('[data-testid=review-edit]');
  await pa.waitForSelector('#t-count', { state: 'visible' });
  assert.equal(await pa.locator('[data-testid=order-review]').count(), 0);
  const before = dbq('SELECT COUNT(*) c FROM orders WHERE user_id=?', uid(A))[0].c;
  await toggleSetting(pa, A, 'trade_skip_review', true);
  await pa.goto(BASE + SNOW_URL);
  await pa.waitForSelector('[data-testid=submit-order]');
  assert.doesNotMatch(await pa.textContent('[data-testid=submit-order]'), /Review/);
  await pa.fill('#t-count', '5');
  await pa.click('[data-testid=submit-order]');
  await until(() => dbq('SELECT COUNT(*) c FROM orders WHERE user_id=?', uid(A))[0].c === before + 1);
  assert.equal(await pa.locator('[data-testid=order-review]').count(), 0, 'no review step when skipped');
  assert.deepEqual(pa.errors, []);
});

test('auto-sell prompt after a buy places a resting take-profit sell on the grid', async () => {
  await toggleSetting(pa, A, 'trade_auto_sell_prompt', true);
  await pa.goto(BASE + SNOW_URL);
  await pa.waitForSelector('[data-testid=submit-order]');
  await pa.fill('#t-count', '10');
  await pa.click('[data-testid=submit-order]');
  await pa.waitForSelector('[data-testid=auto-sell-prompt]');
  assert.match(await pa.textContent('[data-testid=auto-sell-prompt]'), /Filled 10 YES/);
  await pa.fill('[data-testid=auto-sell-price]', '20.5');
  await pa.click('[data-testid=auto-sell-place]');
  await pa.waitForSelector('.toast:has-text("Auto-sell placed")');
  const s = dbq("SELECT * FROM orders WHERE user_id=? AND market_ticker=? AND action='sell' AND status='resting'", uid(A), SNOW);
  assert.equal(s.length, 1);
  assert.deepEqual([s[0].side, s[0].price_cc, s[0].remaining_count], ['no', 10000 - 2050, 1000], 'sell YES at 20.5¢ = buy NO at 79.5¢');
  const vo = (await call(pa, 'GET', `/v1/users/${uid(A)}/orders/${s[0].id}`)).b.order;
  assert.deepEqual([vo.user_action, vo.user_side, vo.user_price_dollars], ['sell', 'yes', '0.2050']);
  await toggleSetting(pa, A, 'trade_auto_sell_prompt', false);
  assert.deepEqual(pa.errors, []);
});

test('flip sell: off refuses selling more than held; on closes the YES and buys NO for the rest, with a review line', async () => {
  const held = dbq('SELECT yes_count FROM positions WHERE user_id=? AND market_ticker=?', uid(A), SNOW)[0].yes_count;
  assert.equal(held, 16500); // 150 (grid test) + 5 (review skipped) + 10 (auto-sell buy); the auto-sell itself rests
  const over = String(held / 100 + 10);
  await pa.goto(BASE + SNOW_URL);
  await pa.waitForSelector('[data-testid=submit-order]');
  await pa.click('[data-testid=sell-tab]');
  await pa.waitForSelector('[data-testid=held]');
  await pa.fill('#t-count', over);
  await pa.waitForSelector('[data-testid=t-invalid]:has-text("Flip sell")');
  const refused = await order(pa, A, { ticker: SNOW, side: 'yes', action: 'sell', type: 'market', count: Number(over) });
  assert.deepEqual([refused.s, refused.b.error.code], [409, 'insufficient_position']);
  await toggleSetting(pa, A, 'trade_flip_sell', true);
  await pa.goto(BASE + SNOW_URL);
  await pa.waitForSelector('[data-testid=submit-order]');
  await pa.click('[data-testid=sell-tab]');
  await pa.waitForSelector('[data-testid=held]');
  await pa.fill('#t-count', over);
  await pa.waitForSelector('[data-testid=flip-line]:has-text("Sells 165 YES you hold and buys 10 NO")');
  await pa.click('[data-testid=submit-order]');
  await pa.waitForSelector('[data-testid=review-flip]'); // a flip always asks, even with review skipped
  await pa.click('[data-testid=review-confirm]');
  await pa.waitForSelector('.toast:has-text("Flip sell")');
  const p = dbq('SELECT yes_count, no_count FROM positions WHERE user_id=? AND market_ticker=?', uid(A), SNOW)[0];
  assert.deepEqual([p.yes_count, p.no_count], [0, 1000]);
  const fo = dbq("SELECT * FROM orders WHERE user_id=? AND market_ticker=? AND flip_units>0", uid(A), SNOW)[0];
  assert.deepEqual([fo.action, fo.side, fo.flip_units, fo.initial_count], ['sell', 'no', 1000, held + 1000]);
  assert.deepEqual(pa.errors, []);
});

test('scalar market: resolve at a value from the desk; YES and NO holders are paid their fractions; rounding to the house', async () => {
  pb = await newPage();
  await signUp(pb, B, 200);
  await toggleSetting(pb, B, 'trade_skip_review', true);
  await pa.goto(BASE + GDP_URL);
  await pa.waitForSelector('[data-testid=scalar-card]');
  assert.match(await pa.textContent('[data-testid=scalar-range]'), /-2% to 6%/);
  await mode(pa, 'market');
  await pa.fill('#t-count', '20');
  await pa.waitForSelector('[data-testid=t-scalar-note]');
  await pa.click('[data-testid=submit-order]');
  await until(() => (dbq('SELECT yes_count FROM positions WHERE user_id=? AND market_ticker=?', uid(A), GDP)[0]?.yes_count || 0) === 2000);
  await pb.goto(BASE + GDP_URL);
  await pb.waitForSelector('[data-testid=submit-order]');
  await pb.click('[data-side=no]');
  await mode(pb, 'market');
  await pb.fill('#t-count', '30');
  await pb.click('[data-testid=submit-order]');
  await until(() => (dbq('SELECT no_count FROM positions WHERE user_id=? AND market_ticker=?', uid(B), GDP)[0]?.no_count || 0) === 3000);
  const balA = bal(A); const balB = bal(B);
  const oi = dbq('SELECT SUM(yes_count) y FROM positions WHERE market_ticker=?', GDP)[0].y;
  const holders = dbq('SELECT user_id, yes_count, no_count FROM positions WHERE market_ticker=? AND (yes_count>0 OR no_count>0)', GDP);
  // Admin: close early, then resolve at 3.1% with no settlement delay.
  padm = await newPage();
  await logIn(padm, ADMIN, ADMIN.password);
  await padm.goto(BASE + '/admin/resolution');
  await padm.locator('[data-testid=early-close-form]').waitFor();
  await padm.selectOption('[data-testid=early-close-form] select', GDP);
  await padm.click('[data-testid=early-close-form] button[type=submit]');
  await padm.locator('[data-testid=confirm-reason]').fill('Statistics office published the first estimate');
  await padm.click('[data-testid=confirm-ok]');
  await padm.locator(`[data-row="${GDP}"][data-status=closed]`).waitFor();
  await padm.click(`[data-resolve="${GDP}"]`);
  await padm.locator('[data-testid=resolve-value]').fill('3.1');
  await padm.locator('[data-testid=resolve-note]').fill('Harbor statistics office first estimate, 3.1% annualized');
  await padm.locator('[data-testid=resolve-delay]').fill('0');
  await padm.click('[data-testid=confirm-ok]');
  await until(() => dbq('SELECT status FROM markets WHERE ticker=?', GDP)[0].status === 'finalized');
  const m = dbq('SELECT result, expiration_value, settlement_value_cc FROM markets WHERE ticker=?', GDP)[0];
  assert.deepEqual([m.result, m.expiration_value, m.settlement_value_cc], ['scalar', 3.1, 6375], '(3.1 + 2) / 8 = 0.6375');
  assert.equal(bal(A) - balA, Math.floor((2000 * 6375) / 10000), 'YES: 20 × $0.6375');
  assert.equal(bal(B) - balB, Math.floor((3000 * 3625) / 10000), 'NO: 30 × $0.3625, floored to the cent');
  const paid = holders.reduce((a, h) => a + Math.floor((h.yes_count * 6375) / 10000) + Math.floor((h.no_count * 3625) / 10000), 0);
  assert.equal(acct(`escrow:${GDP}`), 0, 'escrow ends at zero');
  assert.equal(acct('house:settlement_rounding'), oi - paid);
  await padm.locator(`[data-row="${GDP}"] [data-testid=desk-result]:has-text("3.1")`).waitFor();
  await pa.goto(BASE + GDP_URL);
  await pa.waitForSelector('[data-testid=scalar-result]:has-text("Settled at 3.1%")');
  assert.match(await pa.textContent('[data-testid=scalar-result]'), /YES ₦63\.75 · NO ₦36\.25/);
  assert.match(await pa.textContent('[data-testid=ticket-closed]'), /YES pays ₦63\.75/);
  const hist = (await call(pa, 'GET', `/v1/users/${uid(A)}/history?type=settlements`)).b.history;
  assert.ok(hist.some((h) => h.type === 'settlement' && h.amount_dollars === '12.7500'));
  assert.deepEqual([pa.errors, pb.errors, padm.errors], [[], [], []]);
});

test('collateral return (MECNET): NO on every outcome releases the guaranteed payout early; Portfolio shows it; journaled', async () => {
  pc = await newPage();
  await signUp(pc, C, 300);
  for (const t of RATE) assert.equal((await order(pc, C, { ticker: t, side: 'no', type: 'market', count: 10 })).s, 201);
  // Σ NO 30 contracts − worst case 10 = $20 guaranteed whatever single outcome wins.
  await until(() => dbq('SELECT amount_cents a FROM collateral_returns WHERE user_id=?', uid(C))[0]?.a === 2000);
  assert.equal((await call(pc, 'GET', `/trade-api/v2/events/PLXRATE-26DEC`)).b.event.collateral_return_type, 'MECNET');
  assert.equal(acct('house:collateral_advance'), -dbq('SELECT SUM(amount_cents) s FROM collateral_returns')[0].s);
  assert.equal(dbq("SELECT SUM(amount_cents) s FROM ledger WHERE user_id=? AND kind='collateral_return'", uid(C))[0].s, 2000);
  await pc.goto(BASE + '/portfolio?tab=positions');
  await pc.waitForSelector('[data-testid=collateral-card] [data-testid=collateral-amount]:has-text("₦2,000")');
  assert.equal(await pc.textContent('[data-testid=pos-collateral]'), '₦2,000');
  // Turned off: nothing new is released, but a smaller guarantee still claws the excess back.
  await toggleSetting(pc, C, 'trade_collateral_return', false);
  assert.equal(dbq('SELECT amount_cents a FROM collateral_returns WHERE user_id=?', uid(C))[0].a, 2000);
  const sell = await order(pc, C, { ticker: RATE[2], side: 'no', action: 'sell', type: 'market', count: 5 });
  assert.equal(sell.s, 201);
  await until(() => dbq('SELECT amount_cents a FROM collateral_returns WHERE user_id=?', uid(C))[0]?.a === 1500); // 25 − 10
  await toggleSetting(pc, C, 'trade_collateral_return', true);
  // Settlement repays the advance from the payouts; the advance ends at zero and the books balance.
  for (const [t, r] of [[RATE[2], 'no'], [RATE[0], 'yes'], [RATE[1], 'no']]) {
    const res = await call(padm, 'POST', `/v1/admin/resolution/${t}/resolve`, { result: r, source_note: 'Central bank statement, December meeting', settlement_delay_sec: 0 });
    assert.equal(res.s, 200, JSON.stringify(res.b));
  }
  await until(() => dbq('SELECT COUNT(*) c FROM collateral_returns WHERE user_id=?', uid(C))[0].c === 0);
  assert.equal(dbq("SELECT SUM(amount_cents) s FROM ledger WHERE user_id=? AND kind='collateral_return'", uid(C))[0].s, 0);
  // A hedge that stays open (two of three film outcomes) keeps its advance for the restart test.
  for (const t of ['PLXFILM-27PIC-LIGHTHOUSE', 'PLXFILM-27PIC-PAPER']) assert.equal((await order(pc, C, { ticker: t, side: 'no', type: 'market', count: 5 })).s, 201);
  await until(() => dbq("SELECT amount_cents a FROM collateral_returns WHERE user_id=? AND event_ticker='PLXFILM-27PIC'", uid(C))[0]?.a === 500);
  assert.equal(journal.audit(srv.db).ok, true);
  assert.deepEqual(pc.errors, []);
});

test('settlement correction: claw-back through the ledger, step-up, debt rule, notifications and the audit chain (G6)', async () => {
  const pd = await newPage();
  await signUp(pd, D, 20);
  assert.equal((await order(pd, D, { ticker: LAUNCH, side: 'yes', type: 'market', count: 10 })).s, 201);
  assert.equal((await order(pb, B, { ticker: LAUNCH, side: 'no', type: 'market', count: 10 })).s, 201);
  assert.equal((await call(padm, 'POST', `/v1/admin/resolution/${LAUNCH}/resolve`, { result: 'yes', source_note: 'Operator mission log: orbit reached', settlement_delay_sec: 0 })).s, 200);
  await until(() => dbq('SELECT status FROM markets WHERE ticker=?', LAUNCH)[0].status === 'finalized');
  // D commits its cash to a resting 1¢ bid (2¢ reserved per contract with the fee bound), so the claw-back leaves cash negative.
  const free = bal(D);
  assert.equal((await order(pd, D, { ticker: 'PLXCOIN-26DEC-T5', side: 'yes', type: 'limit', price: 1, count: Math.floor(free / 2) })).s, 201);
  dLeft = bal(D);
  assert.ok(dLeft >= 0 && dLeft < 2);
  const balB = bal(B);
  // The desk: Correct settlement… → reason → step-up (the admin's verification is stale) → claw-back.
  dbrun('UPDATE sessions SET auth_at=0 WHERE user_id=?', uid(ADMIN));
  await padm.goto(BASE + '/admin/resolution');
  await padm.click(`[data-correct="${LAUNCH}"]`);
  await padm.locator('[data-testid=correct-choice] input[value=no]').check();
  await padm.locator('[data-testid=confirm-reason]').fill('The operator retracted the orbit claim: second stage failed');
  await padm.click('[data-testid=confirm-ok]');
  await padm.waitForSelector('[data-testid=step-up-dialog]');
  await padm.fill('[data-testid=step-up-password]', ADMIN.password);
  await padm.click('[data-testid=step-up-submit]');
  await padm.waitForSelector('.toast:has-text("Settlement corrected")');
  const m = dbq('SELECT result, settlement_value_cc FROM markets WHERE ticker=?', LAUNCH)[0];
  assert.deepEqual([m.result, m.settlement_value_cc], ['no', 0]);
  assert.equal(bal(D), dLeft - 1000, 'D owes the $10 clawed back');
  assert.equal(journal.balanceOf(srv.db, journal.accounts.cash(uid(D))), dLeft - 1000);
  assert.equal(bal(B) - balB, 1000, 'NO holder re-paid');
  const sc = dbq('SELECT * FROM settlement_corrections WHERE market_ticker=?', LAUNCH)[0];
  assert.ok(sc.clawback_cents >= 1000 && sc.repaid_cents >= 1000);
  assert.equal(sc.clawback_cents, sc.repaid_cents, 'binary correction moves money between holders only');
  assert.equal(acct(`escrow:${LAUNCH}`), 0);
  assert.equal(dbq('SELECT effective_payout_cents e, payout_cents p FROM settlements WHERE user_id=? AND market_ticker=?', uid(D), LAUNCH)[0].e, 0);
  const n = dbq("SELECT title, body FROM notifications WHERE user_id=? AND type='settlement_correction'", uid(D))[0];
  assert.match(n.title, /now resolves NO/); assert.match(n.body, /owed/);
  const au = dbq("SELECT * FROM admin_audit WHERE action='resolution.correct' AND target_id=?", LAUNCH)[0];
  assert.equal(au.reason, 'The operator retracted the orbit claim: second stage failed');
  assert.equal((await call(padm, 'GET', '/v1/admin/audit/verify')).b.ok, true, 'audit chain intact');
  // Debt rule: withdrawals stop while cash is negative; History shows the correction.
  const w = await call(pd, 'POST', `/v1/users/${uid(D)}/withdrawals`, { amount_dollars: 1 });
  assert.equal(w.s, 409);
  const hist = (await call(pd, 'GET', `/v1/users/${uid(D)}/history?type=settlements`)).b.history;
  assert.ok(hist.some((h) => h.type === 'settlement_correction' && h.amount_dollars === '-10.0000'));
  // Before settlement the old reverse path still applies; after it, reverse points at correct.
  assert.equal((await call(padm, 'POST', `/v1/admin/resolution/${LAUNCH}/reverse`, { note: 'too late now' })).b.error.code, 'already_settled');
  assert.equal(journal.audit(srv.db).ok, true);
  assert.deepEqual([pd.errors, padm.errors], [[], []]);
  await pd.context().close();
});

test('two-person rule: a correction waits for a second admin (not the requester); a rejected resolution changes nothing', async () => {
  await padm.goto(BASE + '/admin/resolution');
  await padm.click('[data-testid=two-person-toggle]');
  await padm.waitForSelector('[data-testid=two-person-policy] .adm-badge:has-text("on")');
  assert.equal(JSON.parse(dbq("SELECT value FROM admin_settings WHERE key='resolution_policy'")[0].value).two_person_rule, true);
  await padm.click(`[data-correct="${LAUNCH}"]`);
  await padm.locator('[data-testid=correct-choice] input[value=yes]').check();
  await padm.locator('[data-testid=confirm-reason]').fill('Retraction itself was retracted: orbit confirmed by tracking');
  await padm.click('[data-testid=confirm-ok]');
  await padm.waitForSelector('.toast:has-text("second admin")');
  await padm.waitForSelector('[data-testid=approvals-table] [data-approve]');
  assert.equal(dbq('SELECT result FROM markets WHERE ticker=?', LAUNCH)[0].result, 'no', 'nothing changes until approved');
  const ap = dbq("SELECT * FROM res_approvals WHERE status='pending'")[0];
  const self = await call(padm, 'POST', `/v1/admin/resolution/approvals/${ap.id}/approve`, {});
  assert.deepEqual([self.s, self.b.error.code], [409, 'same_admin']);
  // A second admin approves from the desk.
  const p2 = await newPage();
  await signUp(p2, ADMIN2, 1);
  dbrun('UPDATE users SET is_admin=1 WHERE id=?', uid(ADMIN2));
  await p2.goto(BASE + '/admin/resolution');
  await p2.click(`[data-approve="${ap.id}"]`);
  await p2.click('[data-testid=confirm-ok]');
  await p2.waitForSelector('.toast:has-text("Approved")');
  await until(() => dbq('SELECT result FROM markets WHERE ticker=?', LAUNCH)[0].result === 'yes');
  const done = dbq('SELECT * FROM res_approvals WHERE id=?', ap.id)[0];
  assert.deepEqual([done.status, done.decided_by, done.requested_by], ['approved', uid(ADMIN2), uid(ADMIN)]);
  assert.equal(bal(D), dLeft, 'the re-pay covers the debt');
  assert.ok(dbq("SELECT 1 FROM admin_audit WHERE action='resolution.correct.approved' AND actor_email=?", ADMIN2.email).length);
  // A resolution request under the rule: 202, then rejected → the market is untouched.
  const t = 'PLXINDEX-26W45';
  const req = await call(padm, 'POST', `/v1/admin/resolution/${t}/resolve`, { result: 'yes', source_note: 'Index closed up on the week', settlement_delay_sec: 0 });
  assert.deepEqual([req.s, req.b.status], [202, 'pending_approval']);
  assert.equal(dbq('SELECT status FROM markets WHERE ticker=?', t)[0].status, 'active');
  const rej = await call(p2, 'POST', `/v1/admin/resolution/approvals/${req.b.approval.id}/reject`, { note: 'Week has not ended yet' });
  assert.equal(rej.b.approval.status, 'rejected');
  assert.equal(dbq('SELECT status FROM markets WHERE ticker=?', t)[0].status, 'active');
  // Market creation permissions: an editor may draft a scalar market; a resolver may not; bounds are validated.
  dbrun("INSERT INTO admin_roles(user_id, role, granted_at) VALUES(?, 'editor', ?)", uid(B), new Date().toISOString());
  dbrun("INSERT INTO admin_roles(user_id, role, granted_at) VALUES(?, 'resolver', ?)", uid(C), new Date().toISOString());
  const draft = { event_ticker: 'PLXGDP-26Q4', ticker: 'PLXGDP-26Q4-ALT', yes_sub_title: 'Alt growth', close_time: new Date(Date.now() + 9 * 86400000).toISOString(), market_type: 'scalar', floor_strike: 0, cap_strike: 4, scalar_unit: '%', price_level_structure: 'tapered' };
  assert.equal((await call(pc, 'POST', '/v1/admin/catalog/markets', draft)).s, 403);
  assert.equal((await call(pb, 'POST', '/v1/admin/catalog/markets', { ...draft, cap_strike: -1 })).s, 400);
  const ok = await call(pb, 'POST', '/v1/admin/catalog/markets', draft);
  assert.equal(ok.s, 201, JSON.stringify(ok.b));
  assert.deepEqual([ok.b.market.market_type, ok.b.market.price_level_structure, ok.b.market.cap_strike], ['scalar', 'tapered', 4]);
  await padm.goto(BASE + '/admin/resolution');
  await padm.click('[data-testid=two-person-toggle]');
  await padm.waitForSelector('[data-testid=two-person-policy] .adm-badge:has-text("off")');
  assert.deepEqual([padm.errors, p2.errors], [[], []]);
  await p2.context().close();
});

test('combos on the finer grid with the HVM 3 s last look: lapses unconfirmed, then executes when confirmed in time (G12)', async () => {
  for (const [p, u] of [[pa, A], [pb, B]]) assert.equal((await call(p, 'PUT', `/v1/users/${uid(u)}/properties`, { properties: { rfq_enabled: true } })).s, 200);
  const combo = await call(pa, 'POST', '/v1/multivariate_event_collections/PLXCOMBO/markets', { selected_markets: [{ market_ticker: 'PLXCOUNCIL-27TRAM', side: 'yes' }, { market_ticker: 'PLXHOOPS-27CHAMP-HAWKS', side: 'yes' }] });
  assert.ok([200, 201].includes(combo.s), JSON.stringify(combo.b));
  const ct = combo.b.market_ticker;
  assert.equal(combo.b.market.price_level_structure, 'center_deci_edge_centi_cent');
  const rfq = await call(pa, 'POST', '/v1/communications/rfqs', { market_ticker: ct, contracts_fp: '10' });
  assert.equal(rfq.s, 201);
  const rid = rfq.b.id;
  // Off the combo grid (0.01¢ is only allowed within 1¢ of the edges).
  assert.equal((await call(pb, 'POST', '/v1/communications/quotes', { rfq_id: rid, yes_bid: '0.3055', no_bid: '0.6000' })).b.error.code, 'invalid_parameters');
  // B quotes 0.1¢ prices with HVM from Portfolio → Other RFQs.
  await pb.goto(BASE + '/portfolio?tab=rfqs&scope=others');
  await pb.waitForSelector(`[data-quote-form="${rid}"]`);
  await pb.fill(`[data-quote-form="${rid}"] [data-testid=quote-yes]`, '30.5');
  await pb.fill(`[data-quote-form="${rid}"] [data-testid=quote-no]`, '60.3');
  await pb.check(`[data-quote-form="${rid}"] [data-testid=quote-hvm]`);
  await pb.click(`[data-quote-form="${rid}"] button[type=submit]`);
  await pb.waitForSelector('.toast:has-text("HVM quote sent")');
  let q = dbq('SELECT * FROM rfq_quotes WHERE rfq_id=? AND maker_id=?', rid, uid(B))[0];
  assert.deepEqual([q.yes_bid_cc, q.no_bid_cc, q.hvm, q.confirm_window_ms], [3050, 6030, 1, 3000]);
  // Accept, do not confirm: the 3 s window lapses and the RFQ reopens.
  let acc = await call(pa, 'PUT', `/v1/communications/quotes/${q.id}/accept`, { accepted_side: 'no' });
  assert.equal(acc.s, 200);
  q = dbq('SELECT * FROM rfq_quotes WHERE id=?', q.id)[0];
  assert.equal(q.confirm_deadline_ts - q.accepted_ts, 3000);
  await until(() => dbq('SELECT status FROM rfq_quotes WHERE id=?', q.id)[0].status === 'expired', 8000);
  assert.equal(dbq('SELECT closed_reason FROM rfq_quotes WHERE id=?', q.id)[0].closed_reason, 'not_confirmed');
  assert.equal(dbq('SELECT status FROM rfqs WHERE id=?', rid)[0].status, 'open');
  // Second round: B watches Quotes, A accepts, B confirms within the window → executed at 39.7¢ (100 − 60.3).
  const q2 = await call(pb, 'POST', '/v1/communications/quotes', { rfq_id: rid, yes_bid: '0.3050', no_bid: '0.6030', hvm: true });
  assert.equal(q2.s, 201);
  await pb.goto(BASE + '/portfolio?tab=quotes');
  await pb.waitForSelector(`[data-quote-row="${q2.b.id}"] [data-testid=hvm-chip]`);
  acc = await call(pa, 'PUT', `/v1/communications/quotes/${q2.b.id}/accept`, { accepted_side: 'no' });
  assert.equal(acc.s, 200);
  try { await pb.waitForSelector(`[data-confirm="${q2.b.id}"]`, { timeout: 1500 }); } catch { await pb.reload(); }
  await pb.click(`[data-confirm="${q2.b.id}"]`);
  await until(() => dbq('SELECT status FROM rfq_quotes WHERE id=?', q2.b.id)[0].status === 'executed', 4000);
  const qx = dbq('SELECT * FROM rfq_quotes WHERE id=?', q2.b.id)[0];
  assert.ok(qx.executed_ts - qx.accepted_ts <= 3000);
  const taker = dbq('SELECT * FROM orders WHERE id=?', qx.taker_order_id)[0];
  assert.deepEqual([taker.side, taker.price_cc, taker.filled_count], ['yes', 3970, 1000]);
  const f = dbq('SELECT * FROM fills WHERE order_id=?', taker.id)[0];
  assert.deepEqual([f.price_cc, f.fee_micro, f.fee_cents], [3970, feeMicro(1000, 3970), Math.ceil(feeMicro(1000, 3970) / 10000)]);
  assert.deepEqual([pa.errors, pb.errors], [[], []]);
});

test('restart keeps prices, advances, corrections and policy; ledger audit balances; 390px light and dark', async () => {
  await srv.close();
  srv = await start(OPTS);
  assert.equal(dbq("SELECT COUNT(*) c FROM orders WHERE market_ticker=? AND price_cc % 100 <> 0", SNOW)[0].c > 0, true);
  assert.equal(dbq("SELECT amount_cents a FROM collateral_returns WHERE user_id=? AND event_ticker='PLXFILM-27PIC'", uid(C))[0].a, 500);
  assert.equal(dbq('SELECT COUNT(*) c FROM settlement_corrections WHERE market_ticker=?', LAUNCH)[0].c, 2);
  assert.equal(dbq("SELECT COUNT(*) c FROM res_approvals WHERE status IN ('approved','rejected')")[0].c, 2);
  const audit = journal.audit(srv.db);
  assert.equal(audit.ok, true, JSON.stringify(audit.problems));
  assert.equal(acct('house:collateral_advance'), -500);
  // The admin ledger audit (Admin › Payments) agrees.
  await padm.goto(BASE + '/admin/resolution');
  await padm.waitForSelector('[data-testid=two-person-policy]');
  const run = await call(padm, 'POST', '/v1/admin/payments/ledger_audit/run', {});
  assert.equal(run.s, 200, JSON.stringify(run.b));
  assert.equal(run.b.audit ? run.b.audit.ok : run.b.ok, true);
  // Browser after restart: sub-cent book, collateral card, scalar result.
  const page = await newPage();
  await logIn(page, C);
  await page.goto(BASE + '/portfolio?tab=positions');
  await page.waitForSelector('[data-testid=collateral-card] [data-collateral-event="PLXFILM-27PIC"]');
  await page.goto(BASE + SNOW_URL);
  await page.click('[data-tab=book]');
  await page.waitForSelector('[data-testid=book-price]:has-text("₦12.90")');
  for (const theme of ['dark', 'light']) {
    assert.equal((await call(page, 'PUT', `/v1/users/${uid(C)}/properties`, { properties: { theme } })).s, 200);
    const phone = await newPage({ width: 390, height: 844 });
    await logIn(phone, C);
    await phone.goto(BASE + SNOW_URL);
    await phone.waitForSelector('[data-testid=submit-order]');
    await mode(phone, 'limit');
    await phone.fill('#t-price', '12.2');
    await phone.fill('#t-count', '3');
    await phone.click('[data-testid=submit-order]');
    await phone.waitForSelector('[data-testid=order-review]');
    assert.equal(await phone.evaluate(() => document.documentElement.dataset.theme || 'dark'), theme);
    assert.ok(await noOverflow(phone), `event page with review at 390px (${theme})`);
    await phone.goto(BASE + GDP_URL);
    await phone.waitForSelector('[data-testid=scalar-result]');
    assert.ok(await noOverflow(phone), `scalar page at 390px (${theme})`);
    await phone.goto(BASE + '/portfolio?tab=positions');
    await phone.waitForSelector('[data-testid=collateral-card]');
    assert.ok(await noOverflow(phone), `portfolio collateral at 390px (${theme})`);
    assert.deepEqual(phone.errors, []);
    await phone.context().close();
  }
  assert.deepEqual(page.errors, []);
});
