'use strict';
// End-to-end tests for the History portfolio tab (COMBOS_FRACTIONAL_SPEC §17.9): one timeline of deposits, orders,
// cancels, fills (whole + fractional, buys and sells), netting, a combo built and executed via RFQ, a settlement and
// interest, with signed amounts; type / market / date filters persisted in the DB across contexts; cursor
// pagination; CSV export; live prepend; restart. Real server + SQLite + Chromium.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-history-'));
const DB_FILE = path.join(TMP, 'history.db');
const PORT = 4700 + Math.floor(Math.random() * 30);
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'correct-horse-9';
const OPTS = { port: PORT, dbFile: DB_FILE, tickMs: 250, admin: { email: 'admin@parlance.local', password: 'Ledger-Keeper-2026!' }, combos: { makerDelayMs: 100, autoConfirmMs: 200 } };
const RAV = 'PLXCUP-26FINAL-RAV';
const CUT = 'PLXRATE-26DEC-CUT';
const ORCH = 'PLXFILM-27PIC-ORCHARD';
const H = { email: `hh.${Date.now()}@example.test`, name: 'Harper History' };

let srv; let browser;
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const dbrun = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
const uid = () => dbq('SELECT id FROM users WHERE email=?', H.email)[0].id;
async function newPage(viewport = { width: 1600, height: 1000 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  return page;
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
const rows = (page) => page.$$eval('[data-testid=history-table] tr[data-hrow]', (els) => els.map((e) => ({ id: e.dataset.hrow, type: e.dataset.type, group: e.dataset.group, amount: e.querySelector('[data-amount]').dataset.amount, text: e.textContent })));
async function allHistory(page, qs = '') {
  const out = []; let cursor = '';
  do { const r = await call(page, 'GET', `/v1/users/${uid()}/history?limit=200${qs}${cursor ? `&cursor=${cursor}` : ''}`); out.push(...r.b.history); cursor = r.b.cursor; } while (cursor);
  return out;
}

let ph;
before(async () => { srv = await start(OPTS); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('activity of every kind appears in History with correct signed amounts', async () => {
  ph = await newPage();
  await ph.goto(BASE + '/sign-up');
  await ph.fill('input[name=display_name]', H.name);
  await ph.fill('input[name=email]', H.email);
  await ph.fill('input[name=password]', PW);
  await ph.click('button[type=submit]');
  await ph.waitForSelector('[data-testid=account-menu]');
  await ph.goto(BASE + '/portfolio');
  await ph.fill('#f-amount', '150');
  await ph.click('[data-act=deposit]');
  await ph.waitForSelector('[data-testid=header-balance]:has-text("$150.00")');
  const U = `/v1/users/${uid()}/orders`;
  // limit order then cancel; 12 more place+cancel pairs for pagination
  for (let i = 0; i < 13; i++) {
    const r = await call(ph, 'POST', U, { ticker: RAV, side: 'yes', type: 'limit', price: 5 + i, count: 1 });
    assert.equal((await call(ph, 'DELETE', `${U}/${r.b.order.order_id}`)).s, 200);
  }
  assert.equal((await call(ph, 'POST', U, { ticker: RAV, side: 'yes', type: 'market', count: 2 })).s, 201);
  assert.equal((await call(ph, 'POST', U, { ticker: CUT, side: 'yes', type: 'market', count: 1.25 })).s, 201);
  assert.equal((await call(ph, 'POST', U, { ticker: CUT, side: 'yes', action: 'sell', type: 'market', count: 0.5 })).s, 201);
  assert.equal((await call(ph, 'POST', U, { ticker: ORCH, side: 'yes', type: 'market', count: 1 })).s, 201);
  // combo via RFQ (simulated maker)
  let r = await call(ph, 'POST', '/v1/multivariate_event_collections/PLXCOMBO/markets', { selected_markets: [{ market_ticker: RAV, side: 'no' }, { market_ticker: 'PLXRAIN-26NOV-B4', side: 'yes' }] });
  r = await call(ph, 'POST', '/v1/communications/rfqs', { market_ticker: r.b.market_ticker, target_cost_dollars: 3 });
  const rid = r.b.id;
  await until(ph, () => dbq("SELECT 1 FROM rfq_quotes WHERE rfq_id=? AND status='open'", rid).length === 1);
  const qid = dbq("SELECT id FROM rfq_quotes WHERE rfq_id=? AND status='open'", rid)[0].id;
  assert.equal((await call(ph, 'PUT', `/v1/communications/rfqs/${rid}/quotes/${qid}/accept`, { accepted_side: 'no' })).s, 200);
  await until(ph, () => dbq('SELECT status FROM rfqs WHERE id=?', rid)[0].status === 'executed');
  // settlement via admin resolve
  const admin = await newPage();
  await logIn(admin, { email: 'admin@parlance.local' }, 'Ledger-Keeper-2026!');
  assert.equal((await call(admin, 'POST', `/v1/admin/markets/${ORCH}/determine`, { result: 'yes' })).s, 200);
  await admin.context().close();
  await until(ph, () => dbq('SELECT 1 FROM settlements WHERE user_id=? AND market_ticker=?', uid(), ORCH).length === 1);
  // interest (account must be older than today)
  dbrun("UPDATE users SET created_at='2026-01-01T00:00:00.000Z' WHERE email=?", H.email);
  await until(ph, () => dbq('SELECT 1 FROM interest_accruals WHERE user_id=?', uid()).length === 1, 10000);

  await ph.goto(BASE + '/portfolio?tab=history');
  await ph.click('[data-htype=all]');
  await ph.waitForSelector('[data-testid=history-table] tr[data-hrow]');
  const all = await allHistory(ph);
  const types = new Set(all.map((x) => x.type));
  for (const t of ['deposit', 'order', 'cancel', 'fill', 'netting', 'settlement', 'combo', 'rfq', 'rfq_execution', 'interest']) assert.ok(types.has(t), `history has ${t}`);
  const dep = all.find((x) => x.type === 'deposit');
  assert.equal(dep.amount_dollars, '150.0000');
  const settle = all.find((x) => x.type === 'settlement');
  assert.deepEqual([settle.amount_dollars, settle.quantity_fp, settle.status], ['1.0000', '1.00', 'yes']);
  // Every fill's amount is minus the exact cash it cost; fees are listed separately (negative).
  for (const f of all.filter((x) => x.type === 'fill')) {
    const row = dbq('SELECT * FROM fills WHERE id=?', f.id.slice(5))[0];
    const cost = row.is_taker ? Math.ceil((row.count * row.price_cents) / 100) : Math.floor((row.count * row.price_cents) / 100);
    assert.equal(Math.round(Number(f.amount_dollars) * 100), -cost);
    assert.equal(f.fee_dollars, row.fee_cents ? (-row.fee_cents / 100).toFixed(4) : null);
  }
  const frac = all.find((x) => x.type === 'fill' && x.market_ticker === CUT && x.action === 'buy');
  assert.equal(frac.quantity_fp, '1.25');
  const sold = all.find((x) => x.type === 'fill' && x.action === 'sell');
  assert.deepEqual([sold.side, sold.quantity_fp], ['yes', '0.50']);
  assert.equal(all.find((x) => x.type === 'netting').amount_dollars, '0.5000');
  const interest = dbq('SELECT amount_cents a FROM interest_accruals WHERE user_id=?', uid())[0].a;
  assert.equal(Math.round(Number(all.find((x) => x.type === 'interest').amount_dollars) * 100), interest);
  // Sum of cash rows + trade rows + fees + settlements equals the cash balance (nothing resting).
  const cash = all.reduce((a, x) => a + (['order', 'cancel', 'rfq', 'quote', 'rfq_execution', 'combo'].includes(x.type) ? 0 : Math.round(Number(x.amount_dollars || 0) * 100) + Math.round(Number(x.fee_dollars || 0) * 100)), 0);
  assert.equal(cash, dbq('SELECT balance_cents b FROM users WHERE id=?', uid())[0].b);
  const ui = await rows(ph);
  assert.equal(ui.length, 25, 'first page');
  assert.ok(ui.find((x) => x.type === 'interest' || x.type === 'settlement'));
  assert.deepEqual(ph.errors, []);
});

test('pagination with Load more, CSV export of the filtered view, live prepend', async () => {
  await ph.click('[data-testid=history-more]');
  await ph.waitForFunction(() => document.querySelectorAll('[data-testid=history-table] tr[data-hrow]').length > 25);
  let ui = await rows(ph);
  assert.equal(new Set(ui.map((x) => x.id)).size, ui.length, 'no duplicates across pages');
  while (await ph.$('[data-testid=history-more]')) { await ph.click('[data-testid=history-more]'); await ph.waitForTimeout(300); }
  ui = await rows(ph);
  const all = await allHistory(ph);
  assert.deepEqual(ui.map((x) => x.id), all.map((x) => x.id), 'all pages, newest first');
  // Trades filter + CSV
  await ph.click('[data-htype=trades]');
  await ph.waitForSelector('[data-htype=trades][aria-pressed=true]');
  ui = await rows(ph);
  assert.ok(ui.length && ui.every((x) => x.group === 'trades'));
  const [dl] = await Promise.all([ph.waitForEvent('download'), ph.click('[data-testid=history-csv]')]);
  const lines = fs.readFileSync(await dl.path(), 'utf8').trim().split('\n');
  assert.equal(lines[0], 'time,type,market,description,side,action,quantity,price_dollars,amount_dollars,fee_dollars,status');
  const trades = await allHistory(ph, '&type=trades');
  assert.equal(lines.length - 1, trades.length);
  assert.ok(lines.slice(1).every((l) => /^\d{4}-\d{2}-\d{2}T[^,]+,(fill|netting),/.test(l)));
  assert.ok(lines.some((l) => l.includes('"Sold YES (bought NO @') || l.includes('Sold YES')), 'sell row exported');
  // Live: a new fill prepends without reloading.
  await ph.evaluate(() => { window.__marker = 1; });
  assert.equal((await call(ph, 'POST', `/v1/users/${uid()}/orders`, { ticker: RAV, side: 'yes', type: 'market', count: 0.75 })).s, 201);
  await ph.waitForFunction(() => document.querySelector('[data-testid=history-table] tr[data-hrow]').dataset.type === 'fill' && document.querySelector('[data-testid=history-table] tr[data-hrow]').textContent.includes('0.75'));
  assert.equal(await ph.evaluate(() => window.__marker), 1, 'no page reload');
  assert.deepEqual(ph.errors, []);
});

test('filters (type, market search, date range) persist in the DB and in a new browser context', async () => {
  await ph.click('[data-htype=cash]');
  await ph.waitForSelector('[data-htype=cash][aria-pressed=true]');
  let ui = await rows(ph);
  assert.ok(ui.length >= 2 && ui.every((x) => x.group === 'cash'));
  assert.ok(ui.find((x) => x.type === 'deposit' && x.text.includes('+$150.00')));
  await ph.click('[data-htype=all]');
  await ph.fill('#h-market', 'Cut');
  await ph.waitForFunction(() => { const r = [...document.querySelectorAll('[data-testid=history-table] tr[data-hrow]')]; return r.length && r.every((e) => e.textContent.includes('Cut')); });
  await ph.waitForTimeout(400);
  const saved = JSON.parse(dbq("SELECT value FROM user_settings WHERE user_id=? AND key='history_filters'", uid())[0].value);
  assert.deepEqual([saved.type, saved.market], ['all', 'Cut']);
  const p2 = await newPage();
  await logIn(p2, H);
  await p2.goto(BASE + '/portfolio?tab=history');
  await p2.waitForSelector('[data-htype=all][aria-pressed=true]');
  assert.equal(await p2.inputValue('#h-market'), 'Cut');
  // Date range in the future → empty; cleared → rows again.
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  await p2.fill('#h-from', tomorrow);
  await p2.dispatchEvent('#h-from', 'change');
  await p2.waitForSelector('[data-testid=history-empty]');
  await p2.fill('#h-from', '');
  await p2.dispatchEvent('#h-from', 'change');
  await p2.waitForSelector('[data-testid=history-table] tr[data-hrow]');
  await p2.fill('#h-market', '');
  await p2.waitForTimeout(800);
  assert.deepEqual(p2.errors, []);
  await p2.context().close();
});

test('History survives a restart; 390px has no horizontal overflow', async () => {
  const first = (await allHistory(ph)).slice(0, 5).map((x) => x.id);
  await ph.context().close();
  await srv.close();
  srv = await start(OPTS);
  const page = await newPage({ width: 390, height: 844 });
  await logIn(page, H);
  await page.goto(BASE + '/portfolio?tab=history');
  await page.waitForSelector('[data-testid=history-table] tr[data-hrow]');
  assert.deepEqual((await allHistory(page)).slice(0, 5).map((x) => x.id), first);
  assert.equal(await page.getAttribute('[data-testid=history-table] tr[data-hrow]', 'data-hrow'), first[0]);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(over <= 0, `History overflows by ${over}px`);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
