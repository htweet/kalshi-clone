'use strict';
// End-to-end browser tests for the screenshot-driven redesign (CLONE_SPEC §15): header + MORE menu, dark default,
// home (hero, info cards, Upcoming with watch stars, sections, rail), Browse frequency filter, event page
// (head-to-head, .ics + CSV downloads, related, BUY/SELL ticket with Dollars mode), daily interest, rolling
// Above/Below markets on the Live page, Pro table, mobile layout. Real server + SQLite file + Chromium.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-redesign-'));
const DB_FILE = path.join(TMP, 'redesign.db');
const PORT = 4400 + Math.floor(Math.random() * 40);
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'correct-horse-9';
const SEN_URL = '/markets/plxstate/harbor-state-elections/plxstate-26sen';
const BLUE = 'PLXSTATE-26SEN-BLUE';
const user = { email: `rd.${Date.now()}@example.test`, name: 'Riley Design' };

let srv; let browser;
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const dbrun = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
async function newPage(viewport = { width: 1600, height: 1000 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  return page;
}
async function logIn(page) {
  await page.goto(BASE + '/sign-in');
  await page.fill('input[name=email]', user.email);
  await page.fill('input[name=password]', PW);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
}
async function mode(page, m) { await page.click('#t-mode-btn'); await page.click(`[data-otype=${m}]`); }
const uid = () => dbq('SELECT id FROM users WHERE email=?', user.email)[0].id;
const pos = () => dbq('SELECT yes_count, no_count FROM positions WHERE user_id=? AND market_ticker=?', uid(), BLUE)[0] || { yes_count: 0, no_count: 0 };

before(async () => { srv = await start({ port: PORT, dbFile: DB_FILE, tickMs: 300, rollingWindowSec: 5 }); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('shell + home: dark default, nav, MORE menu, hero, info cards, Upcoming star persists, sections, rail', async () => {
  const page = await newPage();
  await page.goto(BASE + '/sign-up');
  await page.fill('input[name=display_name]', user.name);
  await page.fill('input[name=email]', user.email);
  await page.fill('input[name=password]', PW);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
  await page.goto(BASE + '/');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  for (const l of ['Markets', 'Invest', 'Live', 'Pro']) assert.ok(await page.locator(`.primary-nav a:has-text("${l}")`).isVisible(), l);
  assert.match(await page.evaluate(() => getComputedStyle(document.querySelector('.hero h2') || document.body).fontFamily), /Barlow Condensed|Inter/);
  await page.click('#more-btn');
  await page.click('.menu a:has-text("Calendar")');
  await page.waitForURL(BASE + '/calendar');
  await page.goto(BASE + '/');
  await page.waitForSelector('[data-testid=hero-title]');
  assert.equal(await page.locator('.info-card').count(), 3);
  assert.ok(await page.locator('[data-testid=perps-promo]').isVisible());
  assert.ok((await page.locator('.sec-head h2').allTextContents()).includes('Politics'));
  // Star an Upcoming card → watchlist row in the DB.
  const card = page.locator('[data-testid=upcoming] .up-card').first();
  const ev = await card.getAttribute('data-event');
  await card.locator('[data-star]').click();
  await card.locator('[data-star][aria-pressed=true]').waitFor();
  assert.equal(dbq('SELECT COUNT(*) c FROM watchlist WHERE user_id=? AND event_ticker=?', uid(), ev)[0].c, 1);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('browse frequency filter and the Pro table (sortable, links to the ticket)', async () => {
  const page = await newPage();
  await page.goto(BASE + '/browse');
  await page.waitForSelector('#results [data-testid=event-card]');
  await page.selectOption('#frequency', 'monthly');
  await page.waitForURL(/frequency=monthly/);
  await page.waitForFunction(() => document.querySelectorAll('#results [data-testid=event-card]').length === 2);
  const evs = await page.$$eval('#results [data-testid=event-card]', (els) => els.map((e) => e.dataset.event).sort());
  assert.deepEqual(evs, ['PLXRAIN-26NOV', 'PLXRATE-26DEC']);
  await page.goto(BASE + '/pro');
  await page.waitForSelector('[data-testid=pro-table] tbody tr');
  const n = await page.locator('[data-testid=pro-table] tbody tr').count();
  assert.ok(n >= 20, `pro rows ${n}`);
  await page.click('[data-sort=last]');
  const lasts = await page.$$eval('[data-testid=pro-table] tbody tr td:nth-child(4)', (els) => els.map((e) => parseInt(e.textContent, 10)).filter((x) => !Number.isNaN(x)));
  assert.deepEqual(lasts, [...lasts].sort((a, b) => b - a));
  await page.click('[data-testid=pro-table] tbody tr:first-child a:has-text("Trade")');
  await page.waitForSelector('#ticket .side-toggle button.on-yes');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('event page: head-to-head, .ics + CSV downloads, related events, Show more', async () => {
  const page = await newPage();
  await page.goto(BASE + SEN_URL);
  await page.waitForSelector('[data-testid=h2h] .bar');
  assert.match(await page.textContent('[data-testid=h2h]'), /Blue Party.*Red Party/);
  const [ics] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid=ics-btn]')]);
  const icsText = fs.readFileSync(await ics.path(), 'utf8');
  assert.match(icsText, /^BEGIN:VCALENDAR\r\n/); assert.match(icsText, /SUMMARY:Harbor State senate seat closes/); assert.match(icsText, /DTSTART:\d{8}T\d{6}Z/);
  const [csv] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid=csv-btn]')]);
  const lines = fs.readFileSync(await csv.path(), 'utf8').trim().split('\n');
  assert.equal(lines[0], 'time,market,outcome,yes_price_dollars,volume_contracts');
  assert.ok(lines.length > 20 && lines.some((l) => l.includes(BLUE)));
  await page.waitForSelector('#series-events a.list-row:has-text("governor")');
  assert.equal(await page.locator('[data-testid=also-row]').count(), 3);
  await page.click('#also-more');
  assert.ok((await page.locator('[data-testid=also-row]').count()) > 3);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('ticket: Dollars buy, SELL tab sells held contracts (netting to cash), mode persisted, oversell rejected', async () => {
  const page = await newPage();
  await logIn(page);
  await page.goto(BASE + '/portfolio');
  await page.fill('#f-amount', '100');
  await page.click('[data-act=deposit]');
  await page.waitForSelector('[data-testid=header-balance]:has-text("$100.00")');
  await page.goto(BASE + SEN_URL);
  await page.waitForSelector('#t-amount');
  await page.fill('#t-amount', '10');
  const expect = Number((await page.textContent('[data-testid=t-contracts]')).match(/^(\d+)/)[1]);
  assert.ok(expect >= 15 && expect <= 20, `contracts for $10: ${expect}`);
  await page.click('[data-testid=submit-order]');
  await page.waitForSelector(`.toast:has-text("Filled ${expect} YES")`);
  assert.equal(pos().yes_count, expect * 100); // stored in units (hundredths of a contract, spec §16)
  await mode(page, 'market');
  assert.equal(JSON.parse(dbq("SELECT value FROM user_settings WHERE user_id=? AND key='ticket_mode'", uid())[0].value), 'market');
  await page.click('[data-testid=sell-tab]');
  await page.waitForSelector(`[data-testid=held]:has-text("${expect} YES")`);
  await page.fill('#t-count', String(expect + 5));
  assert.equal(await page.isDisabled('[data-testid=submit-order]'), true);
  const before = dbq('SELECT balance_cents b FROM users WHERE id=?', uid())[0].b;
  await page.fill('#t-count', '5');
  await page.click('[data-testid=submit-order]');
  await page.waitForSelector('.toast:has-text("Sold 5 YES")');
  await page.waitForSelector(`[data-testid=held]:has-text("${expect - 5} YES")`);
  assert.equal(pos().yes_count, (expect - 5) * 100);
  assert.ok(dbq('SELECT balance_cents b FROM users WHERE id=?', uid())[0].b > before, 'selling returns cash');
  // Server also refuses overselling.
  const r = await page.evaluate(async ([u, t]) => {
    const csrf = JSON.parse(localStorage.getItem('csrfToken')).value;
    const x = await fetch(`/v1/users/${u}/orders`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ ticker: t, side: 'yes', action: 'sell', type: 'market', count: 999 }) });
    return { s: x.status, b: await x.json() };
  }, [uid(), BLUE]);
  assert.equal(r.s, 409); assert.equal(r.b.error.code, 'insufficient_position');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('daily interest: 3.5% APY credited once per day to cash + positions, shown from the ticket', async () => {
  dbrun("UPDATE users SET created_at='2026-01-01T00:00:00.000Z' WHERE email=?", user.email);
  dbrun('DELETE FROM interest_accruals WHERE user_id=?', uid());
  const page = await newPage();
  await logIn(page);
  await page.waitForFunction(() => true);
  const deadline = Date.now() + 8000;
  while (!dbq('SELECT 1 FROM interest_accruals WHERE user_id=?', uid()).length && Date.now() < deadline) await page.waitForTimeout(200);
  const acc = dbq('SELECT * FROM interest_accruals WHERE user_id=?', uid());
  assert.equal(acc.length, 1);
  assert.equal(acc[0].amount_cents, Math.round((acc[0].base_cents * 0.035) / 365));
  assert.ok(acc[0].amount_cents >= 1);
  assert.equal(dbq("SELECT COUNT(*) c FROM ledger WHERE user_id=? AND kind='interest'", uid())[0].c, 1);
  await page.waitForTimeout(800);
  assert.equal(dbq('SELECT COUNT(*) c FROM interest_accruals WHERE user_id=?', uid())[0].c, 1, 'only once per day');
  await page.goto(BASE + SEN_URL);
  await page.click('#interest-btn');
  await page.waitForSelector(`.toast:has-text("Earned so far: $${(acc[0].amount_cents / 100).toFixed(2)}")`);
  await page.context().close();
});

test('rolling Above/Below markets: live card, trade Above, window settles, Determined card, payout', async () => {
  const page = await newPage();
  await logIn(page);
  await page.goto(BASE + '/live');
  await page.waitForSelector('[data-testid=flash-card] [data-testid=flash-target]');
  assert.match(await page.textContent('[data-testid=flash-target]'), /^Target \$\d+\.\d{2}$/);
  const ev = await page.getAttribute('[data-testid=flash-card]', 'data-event');
  await page.click('[data-testid=flash-card] .ab a:first-child');
  await page.waitForSelector('#ticket .side-toggle button.on-yes');
  await mode(page, 'market');
  await page.fill('#t-count', '3');
  await page.click('[data-testid=submit-order]');
  await page.waitForSelector('.toast:has-text("Filled 3 YES")');
  const w = () => dbq('SELECT * FROM flash_windows WHERE event_ticker=?', ev)[0];
  const deadline = Date.now() + 20000;
  while (dbq("SELECT status FROM markets WHERE ticker=?", w().market_ticker)[0].status !== 'finalized' && Date.now() < deadline) await page.waitForTimeout(300);
  const win = w();
  assert.ok(['yes', 'no'].includes(win.result));
  assert.equal(win.result, win.close_cents > win.target_cents ? 'yes' : 'no');
  const st = dbq('SELECT * FROM settlements WHERE user_id=? AND market_ticker=?', uid(), win.market_ticker)[0];
  assert.equal(st.payout_cents, win.result === 'yes' ? 300 : 0);
  await page.goto(BASE + '/live');
  await page.waitForSelector('[data-testid=determined]:has-text("Outcome")');
  assert.ok(dbq('SELECT COUNT(*) c FROM flash_windows')[0].c >= 2, 'a new window opened');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('mobile 390px: new pages have no horizontal overflow; restart keeps rolling history', async () => {
  await srv.close();
  srv = await start({ port: PORT, dbFile: DB_FILE, tickMs: 300, rollingWindowSec: 5 });
  assert.ok(dbq('SELECT COUNT(*) c FROM flash_windows WHERE result IS NOT NULL')[0].c >= 1);
  const page = await newPage({ width: 390, height: 844 });
  for (const p of ['/', '/browse', SEN_URL, '/live', '/calendar', '/pro']) {
    await page.goto(BASE + p);
    await page.waitForSelector('main *');
    await page.waitForTimeout(400);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(over <= 0, `${p} overflows by ${over}px`);
  }
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
