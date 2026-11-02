'use strict';
// End-to-end tests for two-sided RFQs between real users (COMBOS_FRACTIONAL_SPEC §17.4-17.8): the rfq_enabled
// opt-in, an RFQ from the ticket's "Request quote" mode, the other user's live "Other RFQs" list and quote form
// (validation), live quotes for the requester, accept → maker confirm ("Confirming…") → execution through the
// engine with exact DB rows, an accepted quote lapsing unconfirmed, quote deletion, RFQ cancellation, a maker
// balance error, restart and 390px layouts. Two browser contexts, real server + SQLite + Chromium.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-rfq-'));
const DB_FILE = path.join(TMP, 'rfq.db');
const PORT = 4580 + Math.floor(Math.random() * 30);
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'correct-horse-9';
const OPTS = { port: PORT, dbFile: DB_FILE, tickMs: 250, combos: { quoteTtlMs: 120000, confirmWindowMs: 4000 } };
const RATE_URL = '/markets/plxrate/central-bank-decision/plxrate-26dec';
const CUT = 'PLXRATE-26DEC-CUT';
const TRAM = 'PLXCOUNCIL-27TRAM';
const A = { email: `ra.${Date.now()}@example.test`, name: 'Avery Asker' };
const B = { email: `rb.${Date.now()}@example.test`, name: 'Blake Maker' };

let srv; let browser;
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const uid = (u) => dbq('SELECT id FROM users WHERE email=?', u.email)[0].id;
const bal = (u) => dbq('SELECT balance_cents b FROM users WHERE id=?', uid(u))[0].b;
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
async function enableRfq(page) {
  await page.goto(BASE + '/portfolio?tab=rfqs');
  await page.check('[data-testid=rfq-enabled]');
  await page.waitForTimeout(300);
}

let pa; let pb; let rfqId;
before(async () => { srv = await start(OPTS); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('opt-in: RFQs on single markets need rfq_enabled; B sees A\'s RFQ appear live in "Other RFQs"', async () => {
  pa = await newPage(); pb = await newPage();
  await signUp(pa, A, 300);
  await signUp(pb, B, 100);
  // Without the opt-in A cannot request on a single market, and B sees the disabled notice.
  let r = await call(pa, 'POST', '/v1/communications/rfqs', { market_ticker: CUT, contracts_fp: '5' });
  assert.deepEqual([r.s, r.b.error.code], [403, 'rfq_not_enabled']);
  await pb.goto(BASE + '/portfolio?tab=rfqs');
  await pb.click('[data-testid=rfq-others]');
  await pb.waitForSelector('[data-testid=rfq-disabled]');
  await pb.check('[data-testid=rfq-enabled]');
  await pb.waitForSelector('[data-testid=no-other-rfqs]');
  assert.equal(JSON.parse(dbq("SELECT value FROM user_settings WHERE user_id=? AND key='rfq_enabled'", uid(B))[0].value), true);

  await enableRfq(pa);
  await pa.goto(BASE + RATE_URL);
  await pa.click(`tr[data-ticker="${CUT}"] [data-pick=yes]`);
  await mode(pa, 'rfq');
  await pa.fill('#t-count', '5');
  await pa.waitForSelector('[data-testid=rfq-hint]');
  await pa.click('[data-testid=submit-order]');
  await pa.waitForSelector('.toast:has-text("RFQ sent for 5 contracts")');
  const row = dbq('SELECT * FROM rfqs WHERE user_id=?', uid(A))[0];
  rfqId = row.id;
  assert.deepEqual([row.market_ticker, row.contracts_units, row.status], [CUT, 500, 'open']);
  await pb.waitForSelector(`[data-testid=other-rfqs-table] tr[data-rfq="${rfqId}"]`); // via rfq_created on the communications channel
  assert.deepEqual(pa.errors, []); assert.deepEqual(pb.errors, []);
});

test('B quotes (UI validation first); A sees it live and accepts; B confirms; execution is exact in the DB', async () => {
  const form = `[data-quote-form="${rfqId}"]`;
  await pb.fill(`${form} input[name=yes]`, '60');
  await pb.fill(`${form} input[name=no]`, '50');
  await pb.click(`${form} button[type=submit]`);
  await pb.waitForSelector(`${form} .form-error:has-text("cannot exceed 100")`);
  await pb.fill(`${form} input[name=yes]`, '0');
  await pb.fill(`${form} input[name=no]`, '0');
  await pb.click(`${form} button[type=submit]`);
  await pb.waitForSelector(`${form} .form-error:has-text("at least one side")`);
  // Server-side checks too.
  let r = await call(pb, 'POST', '/v1/communications/quotes', { rfq_id: rfqId, yes_bid: '0.555', no_bid: '0.40' });
  assert.deepEqual([r.s, r.b.error.code], [400, 'invalid_parameters']);
  r = await call(pa, 'POST', '/v1/communications/quotes', { rfq_id: rfqId, yes_bid: '0.50', no_bid: '0.40' });
  assert.equal(r.s, 400, 'cannot quote your own RFQ');

  await pa.goto(BASE + '/portfolio?tab=rfqs');
  await pa.waitForSelector(`tr[data-rfq="${rfqId}"]:has-text("Waiting for quotes")`);
  await pb.fill(`${form} input[name=yes]`, '55');
  await pb.fill(`${form} input[name=no]`, '40');
  await pb.click(`${form} button[type=submit]`);
  await pb.waitForSelector(`tr[data-rfq="${rfqId}"] [data-testid=my-quote-status]:has-text("Open")`);
  const q = dbq('SELECT * FROM rfq_quotes WHERE rfq_id=?', rfqId)[0];
  assert.deepEqual([q.maker_id, q.yes_bid_cents, q.no_bid_cents, q.yes_units, q.no_units, q.status], [uid(B), 55, 40, 500, 500, 'open']);
  // Live on A's side: "Buy YES 60¢" (accepting the 40¢ NO bid) and "Buy NO 45¢" (accepting the 55¢ YES bid).
  await pa.waitForSelector(`tr[data-rfq="${rfqId}"] [data-accept][data-side=no]:has-text("Buy YES 60¢")`);
  assert.match(await pa.textContent(`tr[data-rfq="${rfqId}"] [data-accept][data-side=yes]`), /Buy NO 45¢/);
  assert.equal(dbq("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='rfq_quote'", uid(A))[0].c, 1);
  const aBefore = bal(A); const bBefore = bal(B);
  await pa.click(`tr[data-rfq="${rfqId}"] [data-accept][data-side=no]`);
  await pa.waitForSelector(`tr[data-rfq="${rfqId}"] [data-testid=awaiting-confirm]`);
  assert.deepEqual(Object.values(dbq('SELECT status, accepted_side FROM rfq_quotes WHERE id=?', q.id)[0]), ['accepted', 'no']);
  assert.equal(dbq('SELECT status FROM rfqs WHERE id=?', rfqId)[0].status, 'accepted');

  await pb.goto(BASE + '/portfolio?tab=quotes');
  await pb.waitForSelector(`tr[data-quote-row="${q.id}"] [data-confirm]:has-text("Confirm order")`);
  assert.equal(dbq("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='rfq_accepted'", uid(B))[0].c, 1);
  await pb.click(`tr[data-quote-row="${q.id}"] [data-confirm]`);
  await pb.waitForSelector(`tr[data-quote-row="${q.id}"][data-status=executed]`);
  const qx = dbq('SELECT * FROM rfq_quotes WHERE id=?', q.id)[0];
  assert.deepEqual([qx.status, qx.executed_units, dbq('SELECT status FROM rfqs WHERE id=?', rfqId)[0].status], ['executed', 500, 'executed']);
  const fills = dbq('SELECT user_id u, side, price_cents p, count c, is_taker t, fee_cents f FROM fills WHERE market_ticker=? AND user_id IN (?,?) ORDER BY is_taker', CUT, uid(A), uid(B));
  const fee = Math.ceil((7 * 500 * 60 * 40) / 1000000);
  assert.deepEqual(fills.map((f) => [f.u, f.side, f.p, f.c, f.t, f.f]), [[uid(B), 'no', 40, 500, 0, 0], [uid(A), 'yes', 60, 500, 1, fee]]);
  assert.equal(bal(A), aBefore - 300 - fee); // 5 contracts × 60¢ + taker fee
  assert.equal(bal(B), bBefore - 200); // 5 contracts × 40¢, makers pay no fee
  assert.equal(dbq('SELECT yes_count c FROM positions WHERE user_id=? AND market_ticker=?', uid(A), CUT)[0].c, 500);
  assert.equal(dbq('SELECT no_count c FROM positions WHERE user_id=? AND market_ticker=?', uid(B), CUT)[0].c, 500);
  assert.deepEqual(dbq('SELECT DISTINCT order_type o FROM orders WHERE id IN (?,?)', qx.maker_order_id, qx.taker_order_id).map((x) => x.o), ['rfq']);
  for (const u of [A, B]) assert.ok(dbq("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='rfq_executed'", uid(u))[0].c >= 1);
  // Both portfolios show the trade.
  await pa.waitForSelector(`tr[data-rfq="${rfqId}"][data-status=executed]`);
  await pa.goto(BASE + '/portfolio?tab=positions');
  await pa.waitForSelector(`[data-testid=positions-table] tr[data-ticker="${CUT}"]:has-text("YES")`);
  await pb.goto(BASE + '/portfolio?tab=positions');
  await pb.waitForSelector(`[data-testid=positions-table] tr[data-ticker="${CUT}"]:has-text("NO")`);
  await pa.goto(BASE + '/portfolio?tab=history');
  await pa.waitForSelector('[data-testid=history-table] tr[data-type=rfq_execution]:has-text("BUY YES")');
  assert.deepEqual(pa.errors, []); assert.deepEqual(pb.errors, []);
});

test('an accepted quote that the maker does not confirm lapses; the RFQ reopens; quote delete; RFQ cancel', async () => {
  let r = await call(pa, 'POST', '/v1/communications/rfqs', { market_ticker: TRAM, contracts_fp: '2' });
  assert.equal(r.s, 201);
  const id = r.b.id;
  await pb.goto(BASE + '/portfolio?tab=rfqs&scope=others');
  await pb.waitForSelector(`[data-testid=other-rfqs-table] tr[data-rfq="${id}"]`);
  const form = `[data-quote-form="${id}"]`;
  await pb.fill(`${form} input[name=yes]`, '50');
  await pb.fill(`${form} input[name=no]`, '30');
  await pb.click(`${form} button[type=submit]`);
  await pb.waitForSelector(`tr[data-rfq="${id}"] [data-testid=my-quote-status]`);
  const q1 = dbq("SELECT * FROM rfq_quotes WHERE rfq_id=? AND status='open'", id)[0];
  r = await call(pa, 'PUT', `/v1/communications/rfqs/${id}/quotes/${q1.id}/accept`, { accepted_side: 'no' });
  assert.equal(r.s, 200);
  // B's Quotes tab shows the countdown; B lets it lapse.
  await pb.goto(BASE + '/portfolio?tab=quotes');
  await pb.waitForSelector(`tr[data-quote-row="${q1.id}"] [data-confirm]`);
  await until(pb, () => dbq('SELECT status FROM rfq_quotes WHERE id=?', q1.id)[0].status === 'expired', 10000);
  assert.equal(dbq('SELECT closed_reason FROM rfq_quotes WHERE id=?', q1.id)[0].closed_reason, 'not_confirmed');
  assert.equal(dbq('SELECT status FROM rfqs WHERE id=?', id)[0].status, 'open');
  await pb.waitForSelector(`tr[data-quote-row="${q1.id}"][data-status=expired]`);
  r = await call(pb, 'PUT', `/v1/communications/quotes/${q1.id}/confirm`, {});
  assert.deepEqual([r.s, r.b.error.code], [409, 'quote_not_accepted']);
  // A new quote from B, which B then deletes from the Quotes tab.
  r = await call(pb, 'POST', '/v1/communications/quotes', { rfq_id: id, yes_bid: '0.45', no_bid: '0.35' });
  assert.equal(r.s, 201);
  const q2 = r.b.id;
  r = await call(pb, 'POST', `/v1/communications/rfqs/${id}/quotes`, { yes_bid: '0.46', no_bid: '0.35' }); // replaces q2
  const q3 = r.b.id;
  assert.equal(dbq('SELECT closed_reason FROM rfq_quotes WHERE id=?', q2)[0].closed_reason, 'replaced');
  await pb.goto(BASE + '/portfolio?tab=quotes');
  await pb.click(`tr[data-quote-row="${q3}"] [data-delete-quote]`);
  await pb.waitForSelector(`tr[data-quote-row="${q3}"][data-status=cancelled]`);
  assert.equal(dbq('SELECT closed_reason FROM rfq_quotes WHERE id=?', q3)[0].closed_reason, 'deleted_by_maker');
  // A cancels the RFQ; it disappears live from B's Other RFQs.
  await pb.goto(BASE + '/portfolio?tab=rfqs&scope=others');
  await pb.waitForSelector(`[data-testid=other-rfqs-table] tr[data-rfq="${id}"]`);
  await pa.goto(BASE + '/portfolio?tab=rfqs');
  await pa.click(`tr[data-rfq="${id}"] [data-cancel-rfq]`);
  await pa.waitForSelector(`tr[data-rfq="${id}"][data-status=cancelled]`);
  await pb.waitForSelector(`tr[data-rfq="${id}"]`, { state: 'detached' });
  assert.equal(dbq('SELECT status FROM rfqs WHERE id=?', id)[0].status, 'cancelled');
  r = await call(pb, 'POST', '/v1/communications/quotes', { rfq_id: id, yes_bid: '0.45', no_bid: '0.35' });
  assert.deepEqual([r.s, r.b.error.code], [409, 'rfq_closed']);
  assert.deepEqual(pa.errors, []); assert.deepEqual(pb.errors, []);
});

test('balance checks: a maker without funds gets a clear error on confirm and the quote stays accepted', async () => {
  let r = await call(pa, 'POST', '/v1/communications/rfqs', { market_ticker: TRAM, contracts_fp: '300' });
  const id = r.b.id;
  r = await call(pb, 'POST', '/v1/communications/quotes', { rfq_id: id, yes_bid: '0', no_bid: '0.37' }); // 300 × 37¢ > B's cash; below the book (best YES bid 62¢) so post-only rests
  const qid = r.b.id;
  r = await call(pa, 'PUT', `/v1/communications/rfqs/${id}/quotes/${qid}/accept`, { accepted_side: 'yes' });
  assert.equal(r.s, 400, 'declined side cannot be accepted');
  r = await call(pa, 'PUT', `/v1/communications/rfqs/${id}/quotes/${qid}/accept`, { accepted_side: 'no' });
  assert.equal(r.s, 200);
  await pb.goto(BASE + '/portfolio?tab=quotes');
  await pb.click(`tr[data-quote-row="${qid}"] [data-confirm]`);
  await pb.waitForSelector('.toast.error:has-text("insufficient balance")');
  assert.equal(dbq('SELECT status FROM rfq_quotes WHERE id=?', qid)[0].status, 'accepted');
  assert.equal(dbq("SELECT COUNT(*) c FROM orders WHERE user_id=? AND market_ticker=?", uid(B), TRAM)[0].c, 0);
  await until(pb, () => dbq('SELECT status FROM rfq_quotes WHERE id=?', qid)[0].status === 'expired', 10000);
  r = await call(pa, 'DELETE', `/v1/communications/rfqs/${id}`);
  assert.equal(r.s, 200);
  // Requester balance is checked at accept time.
  r = await call(pa, 'POST', '/v1/communications/rfqs', { market_ticker: TRAM, contracts_fp: '5000' });
  const id2 = r.b.id;
  r = await call(pb, 'POST', '/v1/communications/quotes', { rfq_id: id2, yes_bid: '0.30', no_bid: '0.30' });
  r = await call(pa, 'PUT', `/v1/communications/rfqs/${id2}/quotes/${r.b.id}/accept`, { accepted_side: 'no' });
  assert.deepEqual([r.s, r.b.error.code], [409, 'insufficient_balance']);
  await call(pa, 'DELETE', `/v1/communications/rfqs/${id2}`);
});

test('restart keeps RFQ / quote state; 390px RFQ and Quotes tabs have no horizontal overflow', async () => {
  await pa.context().close(); await pb.context().close();
  const snapshot = dbq('SELECT id, status FROM rfq_quotes ORDER BY id');
  await srv.close();
  srv = await start(OPTS);
  assert.deepEqual(dbq('SELECT id, status FROM rfq_quotes ORDER BY id'), snapshot);
  const page = await newPage({ width: 390, height: 844 });
  await logIn(page, B);
  for (const p of ['/portfolio?tab=rfqs', '/portfolio?tab=quotes']) {
    await page.goto(BASE + p);
    await page.waitForSelector('#panel *');
    await page.waitForTimeout(400);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(over <= 0, `${p} overflows by ${over}px`);
  }
  await page.waitForSelector('[data-testid=quotes-table] tr[data-status=executed]');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
