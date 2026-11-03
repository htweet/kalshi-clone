'use strict';
// End-to-end tests for the Positions portfolio tab (COMBOS_FRACTIONAL_SPEC §17.11): default tab, summary, holdings
// grouped by event with cost / mark / value / P&L / payout / sell value checked against the DB and the book, a live
// re-mark when another user trades, a partial sell from the Sell sheet returning exactly the estimated cash, a combo
// position with legs, sort/filter persisted across contexts, settlement moving a position out, restart and 390px.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-positions-'));
const DB_FILE = path.join(TMP, 'positions.db');
const PORT = 4660 + Math.floor(Math.random() * 30);
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'correct-horse-9';
const OPTS = { port: PORT, dbFile: DB_FILE, tickMs: 250, admin: { email: 'admin@parlance.local', password: 'Ledger-Keeper-2026!' }, combos: { makerDelayMs: 100, autoConfirmMs: 200 } };
const RAV = 'PLXCUP-26FINAL-RAV';
const CUT = 'PLXRATE-26DEC-CUT';
const BLUE = 'PLXSTATE-26SEN-BLUE';
const P = { email: `pp.${Date.now()}@example.test`, name: 'Pat Positions' };
const Q = { email: `pq.${Date.now()}@example.test`, name: 'Quin Mover' };

let srv; let browser; let comboTicker;
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const uid = (u) => dbq('SELECT id FROM users WHERE email=?', u.email)[0].id;
const bal = (u) => dbq('SELECT balance_cents b FROM users WHERE id=?', uid(u))[0].b;
const posRow = (t) => dbq('SELECT * FROM positions WHERE user_id=? AND market_ticker=?', uid(P), t)[0];
const usd = (c) => `$${(c / 100).toFixed(2)}`;
async function newPage(viewport = { width: 1700, height: 1000 }) {
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
  return { s: r.status, b: await r.json() };
}, [method, url, body]);
const until = async (page, fn, ms = 15000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out waiting for DB condition'); await page.waitForTimeout(150); } };
const lastPrice = (t) => dbq('SELECT yes_price_cents p FROM trades WHERE market_ticker=? ORDER BY created_ts DESC, rowid DESC LIMIT 1', t)[0].p;
// Independent sell-value walk: buy the other side against resting bids of the held side, pairs net to $1.
function sellValue(t, side, units, userId) {
  let left = units; let v = 0;
  for (const b of dbq("SELECT price_cents p, remaining_count n FROM orders WHERE market_ticker=? AND status='resting' AND side=? AND user_id<>? ORDER BY price_cents DESC, seq", t, side, userId)) {
    if (!left) break;
    const q = Math.min(left, b.n); const tp = 100 - b.p;
    v += q - Math.ceil((q * tp) / 100) - Math.ceil((7 * q * tp * (100 - tp)) / 1000000);
    left -= q;
  }
  return v;
}
const cell = (page, t, id) => page.textContent(`[data-testid=positions-table] tr[data-ticker="${t}"] [data-testid=${id}]`);

let pp;
before(async () => { srv = await start(OPTS); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('Positions is the default tab; whole + fractional holdings match the DB and the book', async () => {
  pp = await newPage();
  await signUp(pp, P, 200);
  for (const [t, side, count] of [[RAV, 'yes', 10], [CUT, 'yes', 2.37], [BLUE, 'no', 3]]) {
    const r = await call(pp, 'POST', `/v1/users/${uid(P)}/orders`, { ticker: t, side, type: 'market', count });
    assert.equal(r.s, 201, JSON.stringify(r.b));
  }
  await pp.goto(BASE + '/portfolio');
  await pp.waitForSelector('[data-testid=pos-summary]');
  assert.equal(await pp.getAttribute('[data-tab=positions]', 'class'), 'on');
  await pp.waitForSelector(`[data-testid=positions-table] tr[data-ticker="${CUT}"]`);
  assert.equal(await pp.locator('[data-testid=positions-table] tr[data-event-group]').count(), 3);
  for (const [t, side] of [[RAV, 'yes'], [CUT, 'yes'], [BLUE, 'no']]) {
    const p = posRow(t);
    const units = side === 'yes' ? p.yes_count : p.no_count;
    const mark = side === 'yes' ? lastPrice(t) : 100 - lastPrice(t);
    const value = Math.round((units * mark) / 100);
    const basis = p.yes_cost_cents + p.no_cost_cents + p.fees_paid_cents;
    assert.equal(await cell(pp, t, 'p-qty'), (units / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }));
    assert.equal(await cell(pp, t, 'p-cost'), usd(basis));
    assert.equal(await cell(pp, t, 'p-mark'), `${mark}¢`);
    assert.equal(await cell(pp, t, 'p-value'), usd(value));
    assert.equal(await cell(pp, t, 'p-payout'), usd(units));
    assert.equal(await cell(pp, t, 'p-sell'), usd(sellValue(t, side, units, uid(P))));
    assert.match(await cell(pp, t, 'p-upnl'), value - basis < 0 ? /^-\$/ : /^\+?\$/);
  }
  assert.match(await pp.textContent(`tr[data-ticker="${RAV}"]`), /YES\s*10/);
  assert.equal(await pp.textContent('[data-testid=pos-cash]'), usd(bal(P)));
  assert.deepEqual(pp.errors, []);
});

test('another user\'s trade re-marks the row live', async () => {
  const before = await cell(pp, RAV, 'p-mark');
  const pq = await newPage();
  await signUp(pq, Q, 50);
  assert.equal((await call(pq, 'POST', `/v1/users/${uid(Q)}/orders`, { ticker: RAV, side: 'no', type: 'market', count: 2 })).s, 201);
  const mark = lastPrice(RAV);
  assert.notEqual(`${mark}¢`, before);
  await pp.waitForSelector(`tr[data-ticker="${RAV}"] [data-testid=p-mark]:has-text("${mark}¢")`);
  await pp.waitForSelector(`tr[data-ticker="${RAV}"] [data-testid=p-value]:has-text("${usd(Math.round((posRow(RAV).yes_count * mark) / 100))}")`);
  await pq.context().close();
});

test('Sell sheet: partial market sell returns exactly the estimated cash; Max sells a fractional position', async () => {
  await pp.click(`tr[data-ticker="${RAV}"] [data-sell]`);
  await pp.waitForSelector('[data-testid=sell-sheet]');
  await pp.fill('#s-count', '4');
  await pp.waitForFunction(() => document.querySelector('[data-testid=sell-proceeds]') && document.querySelector('[data-testid=sell-estimate]').textContent.includes('fee'));
  await pp.waitForTimeout(300);
  const est = await pp.textContent('[data-testid=sell-proceeds]');
  assert.equal(est, usd(sellValue(RAV, 'yes', 400, uid(P))));
  const b0 = bal(P);
  await pp.click('[data-testid=sell-submit]');
  await pp.waitForSelector('.toast:has-text("Sold 4 YES")');
  assert.equal(posRow(RAV).yes_count, 600);
  assert.equal(usd(bal(P) - b0), est);
  await pp.waitForSelector(`tr[data-ticker="${RAV}"] [data-testid=p-qty]:has-text("6")`);
  // Over-size is refused in the sheet; Max fills the held size.
  await pp.click(`tr[data-ticker="${CUT}"] [data-sell]`);
  await pp.fill('#s-count', '9');
  await pp.waitForSelector('[data-testid=sell-estimate]:has-text("Enter up to 2.37")');
  assert.equal(await pp.isDisabled('[data-testid=sell-submit]'), true);
  await pp.click('[data-testid=sell-max]');
  await pp.waitForSelector('[data-testid=sell-proceeds]');
  await pp.click('[data-testid=sell-submit]');
  await pp.waitForSelector('.toast:has-text("Sold 2.37 YES")');
  await pp.waitForSelector(`[data-testid=positions-table] tr[data-ticker="${CUT}"]`, { state: 'detached' });
  assert.equal(posRow(CUT).yes_count, 0);
  assert.deepEqual(pp.errors, []);
});

test('combo position shows its legs; sort and filter persist in the DB and across contexts', async () => {
  let r = await call(pp, 'POST', '/v1/multivariate_event_collections/PLXCOMBO/markets', { selected_markets: [{ market_ticker: CUT, side: 'yes' }, { market_ticker: 'PLXFILM-27PIC-PAPER', side: 'no' }] });
  comboTicker = r.b.market_ticker;
  r = await call(pp, 'POST', '/v1/communications/rfqs', { market_ticker: comboTicker, contracts_fp: '3' });
  const id = r.b.id;
  await until(pp, () => dbq("SELECT 1 FROM rfq_quotes WHERE rfq_id=? AND status='open'", id).length === 1);
  const q = dbq("SELECT id FROM rfq_quotes WHERE rfq_id=? AND status='open'", id)[0];
  assert.equal((await call(pp, 'PUT', `/v1/communications/rfqs/${id}/quotes/${q.id}/accept`, { accepted_side: 'no' })).s, 200);
  await until(pp, () => dbq('SELECT status FROM rfqs WHERE id=?', id)[0].status === 'executed');
  await pp.goto(BASE + '/portfolio');
  await pp.click('[data-pfilter=combos]');
  await pp.waitForSelector(`[data-testid=positions-table] tr[data-combo="${comboTicker}"]`);
  assert.equal(await pp.locator('[data-testid=positions-table] tr[data-ticker]').count(), 1);
  assert.equal(await pp.locator(`tr[data-combo="${comboTicker}"] [data-leg-status=pending]`).count(), 2);
  assert.equal(await pp.textContent('[data-testid=open-combo-count]'), '1');
  await pp.click('[data-pfilter=all]');
  await pp.selectOption('[data-testid=pos-sort]', 'pnl');
  await pp.click('[data-pfilter=open]');
  await pp.waitForTimeout(300);
  const props = Object.fromEntries(dbq("SELECT key, value FROM user_settings WHERE user_id=? AND key IN ('positions_sort','positions_filter')", uid(P)).map((x) => [x.key, JSON.parse(x.value)]));
  assert.deepEqual(props, { positions_filter: 'open', positions_sort: 'pnl' });
  const p2 = await newPage();
  await logIn(p2, P);
  await p2.goto(BASE + '/portfolio');
  await p2.waitForSelector('[data-pfilter=open][aria-pressed=true]');
  assert.equal(await p2.inputValue('[data-testid=pos-sort]'), 'pnl');
  // P&L sort: rows ordered by unrealized P&L descending.
  const pnls = await p2.$$eval('[data-testid=positions-table] tr[data-ticker] [data-testid=p-upnl]', (els) => els.map((e) => Number(e.firstChild.textContent.replace(/[^0-9.-]/g, ''))));
  assert.deepEqual(pnls, [...pnls].sort((a, b) => b - a));
  assert.deepEqual(p2.errors, []);
  await p2.context().close();
});

test('settlement: determined shows "Settling", then the position leaves the open list; restart; 390px', async () => {
  const admin = await newPage();
  await logIn(admin, { email: 'admin@parlance.local' }, 'Ledger-Keeper-2026!');
  assert.equal((await call(admin, 'POST', `/v1/admin/markets/${BLUE}/determine`, { result: 'yes' })).s, 200);
  await pp.goto(BASE + '/portfolio');
  await pp.click('[data-pfilter=all]');
  await pp.waitForSelector(`tr[data-ticker="${BLUE}"][data-state=settling]:has-text("Settling · YES")`);
  assert.equal(await cell(pp, BLUE, 'p-value'), '$0.00');
  await pp.waitForSelector(`tr[data-ticker="${BLUE}"]`, { state: 'detached', timeout: 15000 });
  assert.equal(dbq('SELECT payout_cents p FROM settlements WHERE user_id=? AND market_ticker=?', uid(P), BLUE)[0].p, 0);
  await admin.context().close();
  const before = await pp.textContent('[data-testid=positions-table]');
  await pp.context().close();
  await srv.close();
  srv = await start(OPTS);
  const page = await newPage({ width: 390, height: 844 });
  await logIn(page, P);
  await page.goto(BASE + '/portfolio');
  await page.waitForSelector(`[data-testid=positions-table] tr[data-ticker="${RAV}"]`);
  assert.ok(before.includes('Ravens'));
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(over <= 0, `Positions overflows by ${over}px`);
  await page.click(`tr[data-ticker="${RAV}"] [data-sell]`);
  await page.waitForSelector('[data-testid=sell-sheet]');
  const over2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(over2 <= 0, `Sell sheet overflows by ${over2}px`);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
