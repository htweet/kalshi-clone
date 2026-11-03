'use strict';
// End-to-end browser tests: real server + real SQLite file + real Chromium.
// Run: npm run test:e2e
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-e2e-'));
const DB_FILE = path.join(TMP, 'e2e.db');
const PORT = 3950 + Math.floor(Math.random() * 40);
const BASE = `http://127.0.0.1:${PORT}`;
const EVENT_URL = '/markets/plxcup/northern-cup-final/plxcup-26final';
const RAV = 'PLXCUP-26FINAL-RAV';
const PW = 'correct-horse-9';

let srv; let browser;
const alice = { email: `alice.${Date.now()}@example.test`, name: 'Alice Tester' };
const bob = { email: `bob.${Date.now()}@example.test`, name: 'Bob Tester' };

async function boot() { srv = await start({ port: PORT, dbFile: DB_FILE, tickMs: 300, admin: { email: 'admin@parlance.local', password: 'Ledger-Keeper-2026!' } }); } // no default admin password (CLONE_SPEC §22.5)
async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  return page;
}
const sess = (page) => page.evaluate(() => fetch('/v1/session').then((r) => r.json()));
const apiGet = (page, p) => page.evaluate((u) => fetch(u).then((r) => r.json()), p);
async function signUp(page, u) {
  await page.goto(BASE + '/sign-up');
  await page.fill('input[name=display_name]', u.name);
  await page.fill('input[name=email]', u.email);
  await page.fill('input[name=password]', PW);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
}
async function logIn(page, email, pw = PW) {
  await page.goto(BASE + '/sign-in');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', pw);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
}
// Exact price-row presence in the rendered order book (avoids "3¢" matching "53¢").
const bookHas = (page, label, present = true) => page.waitForFunction(([l, want]) => {
  const rows = [...document.querySelectorAll('[data-testid=orderbook] .book-row span:nth-child(2)')].map((e) => e.textContent);
  return rows.includes(l) === want;
}, [label, present], { timeout: 10000 });
async function mode(page, m) { await page.click('#t-mode-btn'); await page.click(`[data-otype=${m}]`); }
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };

before(async () => { await boot(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('public pages: home carousel, categories, search, 404, no console errors', async () => {
  const page = await newPage();
  await page.goto(BASE + '/');
  await page.waitForSelector('[data-testid=hero-title]');
  const first = await page.textContent('[data-testid=hero-title]');
  assert.match(await page.textContent('[data-testid=hero-pager]'), /^1 of \d+$/);
  await page.click('#hero-next');
  await page.waitForFunction((t) => document.querySelector('[data-testid=hero-title]').textContent !== t, first);
  assert.match(await page.textContent('[data-testid=hero-pager]'), /^2 of /);
  assert.ok((await page.locator('#top-markets [data-testid=event-card]').count()) >= 3);
  await page.waitForFunction(() => /^\d+$/.test(document.getElementById('live-count').textContent));

  await page.click('.category-strip >> text=Sports');
  await page.waitForURL(BASE + '/category/sports');
  // Wait for the category page itself (the previous page's cards stay in the DOM until it renders).
  await page.waitForSelector('[data-testid=subcategories]');
  await page.waitForSelector('[data-testid=event-card]');
  const cats = await page.$$eval('[data-testid=event-card] .ev-meta span:last-child', (els) => els.map((e) => e.textContent));
  assert.ok(cats.length >= 2 && cats.every((c) => c === 'Sports'), `sports only: ${cats}`);

  await page.fill('#search-input', 'hawks');
  await page.press('#search-input', 'Enter');
  await page.waitForURL(/\/search\?q=hawks/);
  await page.waitForSelector('[data-testid=event-card]');
  assert.equal(await page.locator('[data-testid=event-card]').count(), 1);
  assert.match(await page.textContent('[data-testid=event-card] .mcard-title'), /Pro hoops champion/);

  await page.goto(BASE + '/search?q=zzzz-nothing');
  await page.waitForSelector('[data-testid=empty-results]');
  await page.goto(BASE + '/definitely/not/here');
  await page.waitForSelector('text=Page not found');
  await page.goto(BASE + '/markets/plxcup/x/does-not-exist');
  await page.waitForSelector('text=Not found');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('auth: validation errors, sign up, log out, bad login, log in', async () => {
  const page = await newPage();
  await page.goto(BASE + '/sign-up');
  await page.fill('input[name=display_name]', 'Al');
  await page.fill('input[name=email]', alice.email);
  await page.fill('input[name=password]', 'short');
  await page.click('button[type=submit]');
  await page.waitForSelector('#auth-error:has-text("at least 12")'); // password policy (CLONE_SPEC §22.4)
  await signUp(page, alice);
  assert.equal((await sess(page)).user.display_name, alice.name);
  assert.equal(await page.textContent('[data-testid=header-balance]'), '$0.00');
  // duplicate email
  const p2 = await newPage();
  await p2.goto(BASE + '/sign-up');
  await p2.fill('input[name=display_name]', 'Dup');
  await p2.fill('input[name=email]', alice.email);
  await p2.fill('input[name=password]', PW);
  await p2.click('button[type=submit]');
  await p2.waitForSelector('#auth-error:has-text("already exists")');
  await p2.context().close();

  await page.click('[data-testid=account-menu]');
  await page.click('#logout-btn');
  await page.waitForSelector('a:has-text("Log in")');
  assert.equal((await sess(page)).user, null);
  await page.goto(BASE + '/sign-in');
  await page.fill('input[name=email]', alice.email);
  await page.fill('input[name=password]', 'wrong-password');
  await page.click('button[type=submit]');
  await page.waitForSelector('#auth-error:has-text("incorrect email or password")');
  await logIn(page, alice.email);
  assert.equal(dbq('SELECT COUNT(*) c FROM users WHERE email=?', alice.email)[0].c, 1);
  // CSRF token is kept in localStorage with an expiry wrapper (spec §8.2).
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('csrfToken')));
  assert.ok(stored.value && stored.expiry > Date.now());
  await page.context().close();
});

test('funds: deposit updates header live over WS; over-withdrawal is rejected', async () => {
  const page = await newPage();
  await logIn(page, alice.email);
  await page.goto(BASE + '/portfolio');
  await page.fill('#f-amount', '500');
  await page.click('[data-act=deposit]');
  await page.waitForSelector('[data-testid=cash]:has-text("$500.00")');
  await page.waitForSelector('[data-testid=header-balance]:has-text("$500.00")');
  await page.fill('#f-amount', '9999');
  await page.click('[data-act=withdraw]');
  await page.waitForSelector('#f-error:has-text("insufficient balance")');
  await page.fill('#f-amount', '50');
  await page.click('[data-act=withdraw]');
  await page.waitForSelector('[data-testid=cash]:has-text("$450.00")');
  assert.equal(dbq('SELECT balance_cents b FROM users WHERE email=?', alice.email)[0].b, 45000);
  assert.equal(dbq("SELECT COUNT(*) c FROM ledger l JOIN users u ON u.id=l.user_id WHERE u.email=? AND kind IN ('deposit','withdrawal')", alice.email)[0].c, 2);
  await page.context().close();
});

test('trading: market buy fills with exact cost + fee, position appears everywhere', async () => {
  const page = await newPage();
  await logIn(page, alice.email);
  await page.goto(BASE + EVENT_URL);
  await page.waitForSelector('[data-testid=submit-order]');
  const ask = (await apiGet(page, `/trade-api/v2/markets/${RAV}`)).market.yes_ask_dollars;
  const askC = Math.round(Number(ask) * 100);
  await mode(page, 'market');
  await page.fill('#t-count', '10');
  await page.click('[data-testid=submit-order]');
  await page.waitForSelector('.toast:has-text("Filled 10 YES")');
  await page.waitForSelector('[data-testid=my-position]:has-text("Ravens")');
  const fee = Math.ceil((7 * 10 * askC * (100 - askC)) / 10000);
  const expected = 45000 - 10 * askC - fee;
  assert.equal(dbq('SELECT balance_cents b FROM users WHERE email=?', alice.email)[0].b, expected);
  await page.waitForSelector(`[data-testid=header-balance]:has-text("$${(expected / 100).toFixed(2)}")`);
  await page.goto(BASE + '/portfolio');
  await page.click('[data-tab=positions]');
  await page.waitForSelector(`[data-testid=positions-table] tr[data-ticker="${RAV}"]`);
  assert.match(await page.textContent(`tr[data-ticker="${RAV}"]`), /YES\s*10/);
  // bad inputs: price 0 disables submit; huge size → insufficient balance from server
  await page.goto(BASE + EVENT_URL);
  await page.waitForSelector('#t-mode-btn');
  await mode(page, 'limit');
  await page.fill('#t-price', '0');
  assert.equal(await page.isDisabled('[data-testid=submit-order]'), true);
  await page.fill('#t-price', '50');
  await page.fill('#t-count', '90000');
  await page.click('[data-testid=submit-order]');
  await page.waitForSelector('#t-error:has-text("insufficient balance")');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('two users: resting order shows live in the other user\'s book, cross fills, live portfolio update, cancel', async () => {
  const pa = await newPage();
  await logIn(pa, alice.email);
  const pb = await newPage();
  await signUp(pb, bob);
  await pb.goto(BASE + '/portfolio');
  await pb.fill('#f-amount', '300');
  await pb.click('[data-act=deposit]');
  await pb.waitForSelector('[data-testid=cash]:has-text("$300.00")');

  // Bob watches the Comets book live.
  const COM = 'PLXCUP-26FINAL-COM';
  await pb.goto(BASE + EVENT_URL);
  await pb.click(`tr[data-ticker="${COM}"]`);
  await pb.click('[data-tab=book]');
  await pb.waitForSelector('[data-testid=orderbook]');

  // Alice rests the best YES bid (45¢; book is 41-44 bid / 46-49 ask) on Comets.
  await pa.goto(BASE + EVENT_URL);
  await pa.click(`tr[data-ticker="${COM}"] [data-pick=yes]`);
  await mode(pa, 'limit');
  await pa.fill('#t-price', '45');
  await pa.fill('#t-count', '7');
  await pa.click('[data-testid=submit-order]');
  await pa.waitForSelector('.toast:has-text("Order resting")');
  await bookHas(pb, '45¢'); // arrived via orderbook_delta

  // Alice opens her portfolio; Bob takes her order by buying NO at 88¢.
  await pa.goto(BASE + '/portfolio');
  await pa.click('[data-tab=orders]');
  await pa.waitForSelector('[data-testid=orders-table]:has-text("45¢")');
  await pb.click(`tr[data-ticker="${COM}"] [data-pick=no]`);
  await mode(pb, 'limit');
  await pb.fill('#t-price', '55');
  await pb.fill('#t-count', '7');
  await pb.click('[data-testid=submit-order]');
  await pb.waitForSelector('.toast:has-text("Filled 7 NO")');
  await bookHas(pb, '45¢', false);
  await pa.waitForSelector('[data-testid=no-orders]'); // live via user_orders channel
  const fills = dbq("SELECT f.side, f.price_cents p, f.is_taker t, f.count c FROM fills f JOIN users u ON u.id=f.user_id WHERE f.market_ticker=? AND u.email IN (?,?) ORDER BY f.is_taker", COM, alice.email, bob.email);
  // Quantities are stored in units (hundredths of a contract, spec §16): 7 contracts = 700 units.
  assert.deepEqual(fills.map((f) => [f.side, f.p, f.t, f.c]), [['yes', 45, 0, 700], ['no', 55, 1, 700]]);

  // A fresh resting order, then cancel it from the portfolio; reservation is returned.
  const before = dbq('SELECT balance_cents b FROM users WHERE email=?', alice.email)[0].b;
  await pa.goto(BASE + EVENT_URL);
  await pa.click(`tr[data-ticker="${COM}"] [data-pick=yes]`);
  await mode(pa, 'limit');
  await pa.fill('#t-price', '5');
  await pa.fill('#t-count', '20');
  await pa.click('[data-testid=submit-order]');
  await pa.waitForSelector('.toast:has-text("Order resting")');
  assert.equal(dbq('SELECT balance_cents b FROM users WHERE email=?', alice.email)[0].b, before - 20 * (5 + 1));
  await pa.goto(BASE + '/portfolio');
  await pa.click('[data-tab=orders]');
  await pa.click('[data-cancel]');
  await pa.waitForSelector('[data-testid=no-orders]');
  assert.equal(dbq('SELECT balance_cents b FROM users WHERE email=?', alice.email)[0].b, before);
  assert.equal(dbq("SELECT status FROM orders o JOIN users u ON u.id=o.user_id WHERE u.email=? ORDER BY seq DESC LIMIT 1", alice.email)[0].status, 'canceled');
  await pa.context().close(); await pb.context().close();
});

test('closing a position nets YES+NO pairs back to cash', async () => {
  const page = await newPage();
  await logIn(page, alice.email);
  await page.goto(BASE + '/portfolio');
  await page.click('[data-tab=positions]');
  await page.waitForSelector(`tr[data-ticker="${RAV}"] [data-close]`);
  const before = dbq('SELECT balance_cents b FROM users WHERE email=?', alice.email)[0].b;
  await page.click(`tr[data-ticker="${RAV}"] [data-close]`);
  await page.waitForSelector('.toast:has-text("Closed 10 contracts")');
  await page.waitForSelector(`[data-testid=positions-table]:not(:has(tr[data-ticker="${RAV}"]))`).catch(() => page.waitForSelector('[data-testid=no-positions]'));
  const pos = dbq("SELECT yes_count y, no_count n FROM positions p JOIN users u ON u.id=p.user_id WHERE u.email=? AND market_ticker=?", alice.email, RAV)[0];
  assert.deepEqual([pos.y, pos.n], [0, 0]);
  assert.ok(dbq('SELECT balance_cents b FROM users WHERE email=?', alice.email)[0].b > before, 'netting credited $1 per pair');
  assert.equal(dbq("SELECT COUNT(*) c FROM ledger l JOIN users u ON u.id=l.user_id WHERE u.email=? AND kind='netting'", alice.email)[0].c, 1);
  await page.context().close();
});

test('watchlist, recently viewed and settings persist in the DB across sessions', async () => {
  const page = await newPage();
  await logIn(page, alice.email);
  await page.goto(BASE + EVENT_URL);
  await page.click('[data-testid=watch-btn]');
  await page.waitForSelector('[data-testid=watch-btn][aria-pressed=true]');
  await page.click('[data-testid=account-menu]');
  await page.click('#theme-toggle');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.click('[data-range=all]');
  await page.click('[data-tab=trades]');
  await page.waitForSelector('[data-testid=trades]');
  await page.waitForTimeout(300);
  const props = dbq("SELECT key, value FROM user_settings s JOIN users u ON u.id=s.user_id WHERE u.email=? ORDER BY key", alice.email);
  const map = Object.fromEntries(props.map((p) => [p.key, JSON.parse(p.value)]));
  assert.equal(map.theme, 'light'); assert.equal(map.chart_range, 'all'); assert.equal(map.event_bottom_tab, 'trades');
  await page.context().close();

  // Brand-new browser context (no localStorage): settings come back from the server.
  const p2 = await newPage();
  await logIn(p2, alice.email);
  await p2.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await p2.goto(BASE + '/watchlist');
  await p2.waitForSelector('[data-testid=watchlist] [data-event="PLXCUP-26FINAL"]');
  assert.match(await p2.textContent('[data-testid=recent]'), /Northern Cup Final/);
  await p2.goto(BASE + EVENT_URL);
  await p2.waitForSelector('[data-testid=trades]');
  assert.equal(await p2.getAttribute('[data-range=all]', 'class'), 'on');
  await p2.click('[data-testid=watch-btn]');
  await p2.waitForSelector('[data-testid=watch-btn][aria-pressed=false]');
  await p2.goto(BASE + '/watchlist');
  await p2.waitForSelector('[data-testid=watchlist-empty]');
  await p2.click('[data-testid=account-menu]');
  await p2.click('#theme-toggle');
  await p2.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await p2.context().close();
});

test('lifecycle: admin pause/resume/resolve, MARKET_INACTIVE errors, automatic settlement payout', async () => {
  const TICK = 'PLXRATE-26DEC-CUT';
  const URL = '/markets/plxrate/central-bank-decision/plxrate-26dec';
  const pa = await newPage();
  await logIn(pa, alice.email);
  await pa.goto(BASE + URL);
  await pa.click(`tr[data-ticker="${TICK}"] [data-pick=yes]`);
  await mode(pa, 'market');
  await pa.fill('#t-count', '4');
  await pa.click('[data-testid=submit-order]');
  await pa.waitForSelector('.toast:has-text("Filled 4 YES")');

  const admin = await newPage();
  await logIn(admin, 'admin@parlance.local', 'Ledger-Keeper-2026!');
  await admin.goto(BASE + URL);
  await admin.click(`tr[data-ticker="${TICK}"]`);
  await admin.waitForSelector('[data-testid=admin-panel]');
  await admin.click('[data-admin=deactivate]');
  await admin.waitForSelector('[data-testid=admin-panel]:has-text("(inactive)")');
  // Alice's open page reacts to the lifecycle push.
  await pa.waitForSelector('[data-testid=ticket-closed]');
  const r = await pa.evaluate(async (t) => {
    const s = await (await fetch('/v1/session')).json();
    const res = await fetch(`/v1/users/${s.user.user_id}/orders`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': s.csrf_token }, body: JSON.stringify({ ticker: t, side: 'yes', price: 50, count: 1 }) });
    return { status: res.status, body: await res.json() };
  }, TICK);
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'market_inactive');
  await admin.click('[data-admin=activate]');
  await admin.waitForSelector('[data-testid=admin-panel]:has-text("(active)")');

  const before = dbq('SELECT balance_cents b FROM users WHERE email=?', alice.email)[0].b;
  await admin.click('[data-admin=determine][data-result=yes]');
  await admin.waitForSelector('[data-testid=admin-panel]:has-text("(determined)")');
  // settlement timer is 5 s; the lifecycle tick finalizes and pays out.
  await pa.waitForSelector('[data-testid=ticket-closed]:has-text("YES")', { timeout: 15000 });
  await pa.goto(BASE + '/portfolio');
  await pa.click('[data-tab=history]'); // Settlements moved into History (spec §17.9 tab set)
  await pa.click('[data-tab=settlements]');
  await pa.waitForSelector('[data-testid=settlements-table]:has-text("YES")', { timeout: 15000 });
  assert.equal(dbq('SELECT status FROM markets WHERE ticker=?', TICK)[0].status, 'finalized');
  assert.equal(dbq('SELECT balance_cents b FROM users WHERE email=?', alice.email)[0].b, before + 400);
  // non-admin cannot use admin endpoints
  const forbidden = await pa.evaluate(async () => { const s = await (await fetch('/v1/session')).json(); return (await fetch('/v1/admin/markets/PLXINDEX-26W45/close', { method: 'POST', headers: { 'x-csrf-token': s.csrf_token } })).status; });
  assert.equal(forbidden, 403);
  await pa.context().close(); await admin.context().close();
});

test('CSV export downloads the ledger', async () => {
  const page = await newPage();
  await logIn(page, alice.email);
  await page.goto(BASE + '/portfolio');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid=csv-link]')]);
  const text = fs.readFileSync(await dl.path(), 'utf8');
  const lines = text.trim().split('\n');
  assert.equal(lines[0], 'time,type,amount_usd,reference,memo');
  assert.ok(lines.some((l) => /,deposit,500\.00,/.test(l)));
  assert.ok(lines.some((l) => /,settlement,4\.00,PLXRATE-26DEC-CUT,/.test(l)));
  await page.context().close();
});

test('API error envelopes, CSRF enforcement and unauthenticated access', async () => {
  const page = await newPage();
  await page.goto(BASE + '/');
  const res = await page.evaluate(async () => {
    const j = async (u, o) => { const r = await fetch(u, o); return [r.status, await r.json()]; };
    return {
      nf: await j('/trade-api/v2/markets/NOPE'),
      badInt: await j('/trade-api/v2/markets?limit=abc'),
      big: await j('/trade-api/v2/markets?limit=100000'),
      badStatus: await j('/trade-api/v2/markets?status=bogus'),
      unauth: await j('/v1/users/u_x/balance'),
      page1: await j('/trade-api/v2/markets?limit=3&status=open'),
    };
  });
  assert.deepEqual(res.nf, [404, { error: { code: 'not_found', message: 'not found' } }]);
  assert.equal(res.badInt[0], 400); assert.match(res.badInt[1].msg, /Invalid format for parameter limit/);
  assert.equal(res.big[0], 400); assert.match(res.big[1].msg, /'lte' tag/);
  assert.deepEqual(res.badStatus, [400, { error: { code: 'bad_request', message: 'bad request', details: 'invalid status filter' } }]);
  assert.deepEqual(res.unauth, [401, { error: { code: 'token_authentication_failure', message: 'token authentication failure' } }]);
  assert.equal(res.page1[1].markets.length, 3); assert.ok(res.page1[1].cursor);
  const page2 = await apiGet(page, `/trade-api/v2/markets?limit=3&status=open&cursor=${res.page1[1].cursor}`);
  assert.notEqual(page2.markets[0].ticker, res.page1[1].markets[0].ticker);
  assert.match(res.page1[1].markets[0].yes_bid_dollars, /^0\.\d{4}$/);

  await logIn(page, alice.email);
  const csrf = await page.evaluate(async () => {
    const s = await (await fetch('/v1/session')).json();
    const r = await fetch(`/v1/users/${s.user.user_id}/deposits`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount_dollars: 1 }) });
    return [r.status, (await r.json()).error.details];
  });
  assert.deepEqual(csrf, [403, 'missing or invalid x-csrf-token']);
  await page.context().close();
});

test('rate limiting returns 429 too_many_requests', async () => {
  const limited = await start({ port: PORT + 100, dbFile: path.join(TMP, 'rl.db'), rate: { burst: 5, perSec: 0.01 } });
  try {
    const page = await newPage();
    await page.goto(`http://127.0.0.1:${PORT + 100}/sign-in`);
    const statuses = await page.evaluate(async () => {
      const out = [];
      for (let i = 0; i < 10; i++) out.push((await fetch('/trade-api/v2/exchange/status')).status);
      const last = await (await fetch('/trade-api/v2/exchange/status')).json();
      return { out, last };
    });
    assert.ok(statuses.out.includes(429));
    assert.deepEqual(statuses.last, { error: { code: 'too_many_requests', message: 'too many requests' } });
    await page.context().close();
  } finally { await limited.close(); }
});

test('server restart: data and sessions persist; open page reconnects WS and resubscribes', async () => {
  const page = await newPage();
  await logIn(page, alice.email);
  const balBefore = dbq('SELECT balance_cents b FROM users WHERE email=?', alice.email)[0].b;
  await page.goto(BASE + EVENT_URL);
  await page.click('[data-tab=book]');
  await page.waitForSelector('[data-testid=orderbook]');

  await srv.close();
  await page.waitForSelector('#conn-banner:not([hidden])', { timeout: 10000 });
  await boot();
  await page.waitForSelector('#conn-banner[hidden]', { state: 'attached', timeout: 20000 });

  // Same cookie session still valid after restart (sessions are in SQLite).
  const s = await sess(page);
  assert.equal(s.user.email, alice.email);
  assert.equal(dbq('SELECT balance_cents b FROM users WHERE email=?', alice.email)[0].b, balBefore);

  // Live updates resume after resubscribe: another user's resting order shows up in the book.
  const pb = await newPage();
  await logIn(pb, bob.email);
  await pb.goto(BASE + EVENT_URL);
  await pb.click(`tr[data-ticker="${RAV}"] [data-pick=yes]`);
  await mode(pb, 'limit');
  await pb.fill('#t-price', '3');
  await pb.fill('#t-count', '11');
  await pb.click('[data-testid=submit-order]');
  await pb.waitForSelector('.toast:has-text("Order resting")');
  await bookHas(page, '3¢');

  await page.goto(BASE + '/portfolio');
  await page.click('[data-tab=history]'); // Settlements / Transactions are History sub-views (spec §17.9)
  await page.click('[data-tab=settlements]');
  await page.waitForSelector('[data-testid=settlements-table]:has-text("YES")');
  await page.click('[data-tab=transactions]');
  await page.waitForSelector('[data-testid=transactions-table]:has-text("netting")');
  assert.deepEqual(page.errors, []);
  await page.context().close(); await pb.context().close();
});

test('port in use: auto-selects the next free port (CLI + browser); explicit PORT fails with a clear message', async () => {
  const net = require('node:net');
  const { spawn } = require('node:child_process');
  const occupy = (p) => new Promise((res, rej) => { const s = net.createServer().once('error', rej).listen(p, '127.0.0.1', () => res(s)); });
  const base = PORT + 200;
  const blockers = [await occupy(base), await occupy(base + 1)];
  const run = (env) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, ...env, DB_FILE: path.join(TMP, 'port.db') } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (/listening on/.test(out)) resolve({ child, out }); });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ child, out, code }));
  });
  try {
    // 1) Explicit busy PORT → exit 1 with guidance, no stack trace.
    const bad = await run({ PORT: String(base) });
    assert.equal(bad.code, 1);
    assert.match(bad.out, new RegExp(`Port ${base} is already in use`));
    assert.doesNotMatch(bad.out, /at Server\.|node:internal/);

    // 2) Library default port busy (and the next one) → binds base+2 and the app works in a browser.
    delete process.env.PORT;
    const s = await start({ defaultPort: base, dbFile: path.join(TMP, 'port2.db') });
    try {
      assert.equal(s.port, base + 2);
      const page = await newPage();
      await page.goto(`http://127.0.0.1:${s.port}/`);
      await page.waitForSelector('[data-testid=hero-title]');
      await page.waitForFunction(() => /^\d+$/.test(document.getElementById('live-count').textContent));
      assert.deepEqual(page.errors, []);
      await page.context().close();
    } finally { await s.close(); }
  } finally { for (const b of blockers) b.close(); }
});

test('database lock: a leftover lock naming a live unrelated process does not block; a real second server is refused; a crashed owner is taken over', async () => {
  const { spawn } = require('node:child_process');
  const fs = require('node:fs');
  const dbFile = path.join(TMP, 'lock.db');
  const serverJs = path.join(__dirname, '..', 'server', 'index.js');
  const runServer = (port) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings', serverJs], { env: { ...process.env, DB_FILE: dbFile, PORT: String(port), ASSETS: 'src', SPORTS: '0' } });
    let out = '';
    const done = (r) => { if (!child.__done) { child.__done = true; resolve({ child, ...r, out }); } };
    child.stdout.on('data', (d) => { out += d; if (/listening on/.test(out)) done({ listening: true }); });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => done({ code }));
  });
  const exited = (child) => new Promise((r) => (child.exitCode != null || child.signalCode ? r() : child.once('exit', r)));
  const homeRenders = async (port) => {
    const page = await newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector('[data-testid=hero-title]');
    assert.deepEqual(page.errors, []);
    await page.context().close();
  };
  // A live process that is not a Parlance server (the Windows case: the crashed server's pid now belongs to a service).
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const portA = PORT + 230;
  let a = null;
  try {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    fs.writeFileSync(`${dbFile}.lock`, String(bystander.pid));
    a = await runServer(portA);
    assert.equal(a.listening, true, `server must start despite the stale lock:\n${a.out}`);
    await homeRenders(portA);

    // A genuine second server on the same database is refused, naming the running one.
    const b = await runServer(portA + 1);
    assert.equal(b.code, 1);
    assert.match(b.out, new RegExp(`Another Parlance server \\(process ${a.child.pid}\\) is already using`));
    assert.doesNotMatch(b.out, /node:internal|at Object\./);

    // Hard crash of the owner (no clean shutdown, files left behind) → the next start takes over.
    a.child.kill('SIGKILL');
    await exited(a.child);
    assert.equal(fs.existsSync(`${dbFile}.lock`), true, 'the crash leaves the info file behind');
    const c = await runServer(portA + 2);
    assert.equal(c.listening, true, `server must take over after a crash:\n${c.out}`);
    await homeRenders(portA + 2);
    // Persistence across the crash: the same database file is in use (seeded data still there).
    const r = await fetch(`http://127.0.0.1:${portA + 2}/trade-api/v2/markets?limit=1`);
    assert.equal(r.status, 200);
    assert.ok((await r.json()).markets.length >= 1);
    c.child.kill('SIGINT');
    await exited(c.child);
    assert.equal(fs.existsSync(`${dbFile}.lock`), false, 'a clean shutdown removes the info file');
  } finally {
    bystander.kill();
    if (a && a.child.exitCode == null && !a.child.signalCode) a.child.kill('SIGKILL');
  }
});

test('startup on an old Node: exits 1 with an install hint before touching the database, then the app still serves', async () => {
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const dbFile = path.join(TMP, 'oldnode.db');
  const r = spawnSync(process.execPath, ['--no-warnings', '-r', path.join(__dirname, 'lib', 'old-node-preload.js'), path.join(__dirname, '..', 'server', 'index.js')],
    { env: { ...process.env, DB_FILE: dbFile, PORT: '0' }, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Could not start Parlance Exchange: Node 20\.11\.1 is too old\. Install Node 22\.5 or newer/);
  assert.doesNotMatch(r.stderr, /node:sqlite|at Module\.|node:internal/);
  assert.equal(fs.existsSync(dbFile), false, 'no database or lock file is created');
  assert.equal(fs.existsSync(`${dbFile}.lock`), false);
  // On the real (supported) Node the same entry point starts and the browser renders the home page.
  // port 0 means "any free port": no misleading "Port 0 is in use" warning.
  const warns = []; const warn = console.warn; console.warn = (...a) => { warns.push(a.join(' ')); };
  let s;
  try { s = await start({ port: 0, dbFile }); } finally { console.warn = warn; }
  assert.ok(s.port > 0);
  assert.deepEqual(warns.filter((w) => /is in use/.test(w)), []);
  try {
    const page = await newPage();
    await page.goto(`http://127.0.0.1:${s.port}/`);
    await page.waitForSelector('[data-testid=hero-title]');
    assert.deepEqual(page.errors, []);
    await page.context().close();
  } finally { await s.close(); }
});
