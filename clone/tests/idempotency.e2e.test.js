'use strict';
// Money safety (PLAN P1.9 idempotency keys, P1.8 request validation, gap G2 cost-capped orders).
//   - `Idempotency-Key` on event-contract orders, deposits, withdrawals, perps orders/transfers/close, RFQ accept and
//     confirm: same key + same body replays the stored response (no second operation), same key + different body is
//     409 idempotency_key_conflict, concurrent duplicates execute once, keys are per user, persisted across a restart and
//     expire after 24 h; refusals before execution (step-up required) are not stored, so the retry with the same key
//     succeeds.
//   - The browser sends a fresh key per user action and reuses it on its automatic retry (api.js), so a retried deposit
//     or order executes once.
//   - Body schemas and per-route body size limits (server/validate.js).
//   - G2: a Dollars order filled across thousands of 0.01-contract makers never spends more than its amount.
// Real server + SQLite file + Chromium.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const { Client } = require('./lib/client');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-idem-'));
const DB_FILE = path.join(TMP, 'idem.db');
// A port the OS reports free (a random pick could collide with another process on the CI machine).
const freePort = () => new Promise((res, rej) => { const s = require('node:net').createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
let PORT; let BASE;
const PW = 'Copper-Harbor-Lantern-5182';
const stamp = Date.now();
const HIGH = { burst: 1e6, per_second: 1e6 };
const OPTS = { port: PORT, dbFile: DB_FILE, tickMs: 250, quiet: true, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH }, admin: { email: `root.${stamp}@example.test`, password: PW } };

let srv; let browser;
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const dbrun = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const email = (n) => `${n}.${stamp}@example.test`;
const key = (label) => `${label}-${stamp}-${Math.random().toString(36).slice(2)}`;
const H = (k) => ({ 'idempotency-key': k });
const show = (r) => `${r.status} ${r.text ? r.text.slice(0, 200) : ''}`;
const balance = (uid) => dbq('SELECT balance_cents b FROM users WHERE id=?', uid)[0].b;
async function user(name, depositDollars = 0) {
  const c = await new Client(BASE, name).signUp(email(name), PW, `Trader ${name.replace(/[^a-z]/g, '')}`);
  if (depositDollars) { const r = await c.call('POST', `/v1/users/${c.uid}/deposits`, { amount_dollars: depositDollars }); assert.equal(r.status, 201, show(r)); }
  return c;
}
// An open fractional event-contract market with liquidity on both sides.
const market = (offset = 0) => dbq(`SELECT m.ticker FROM markets m JOIN events e ON e.ticker=m.event_ticker WHERE m.status='active' AND m.fractional_trading_enabled=1 AND m.mve_collection_ticker IS NULL
  AND e.series_ticker NOT LIKE 'PLXFLASH%' AND EXISTS (SELECT 1 FROM orders o WHERE o.market_ticker=m.ticker AND o.status='resting' AND o.side='no') ORDER BY m.rowid LIMIT 1 OFFSET ?`, offset)[0].ticker;

before(async () => {
  PORT = await freePort(); BASE = `http://127.0.0.1:${PORT}`; OPTS.port = PORT; srv = await start(OPTS); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('orders: same Idempotency-Key + same body replays the first response; a different body is 409; keys are per user', async () => {
  const a = await user('ivy', 200);
  const b = await user('ike', 200);
  const t = market();
  const k = key('order');
  const body = { ticker: t, side: 'yes', type: 'limit', price: 2, count: 3 };
  const before = balance(a.uid);
  const r1 = await a.call('POST', `/v1/users/${a.uid}/orders`, body, H(k));
  assert.equal(r1.status, 201, show(r1));
  assert.equal(r1.headers.get('idempotent-replayed'), null);
  const afterFirst = balance(a.uid);
  assert.ok(afterFirst < before, 'the first request reserved funds');
  // Same key, same body (field order irrelevant): replayed, not re-executed.
  const r2 = await a.call('POST', `/v1/users/${a.uid}/orders`, { count: 3, price: 2, type: 'limit', side: 'yes', ticker: t }, H(k));
  assert.equal(r2.status, 201);
  assert.equal(r2.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(r2.body, r1.body);
  assert.equal(dbq('SELECT COUNT(*) c FROM orders WHERE user_id=?', a.uid)[0].c, 1);
  assert.equal(balance(a.uid), afterFirst);
  // Same key, different body: conflict, nothing placed.
  const r3 = await a.call('POST', `/v1/users/${a.uid}/orders`, { ...body, count: 4 }, H(k));
  assert.equal(r3.status, 409);
  assert.equal(r3.code, 'idempotency_key_conflict');
  // Same key on another idempotent route is a different request too.
  const r4 = await a.call('POST', `/v1/users/${a.uid}/deposits`, { amount_dollars: 1 }, H(k));
  assert.equal(r4.code, 'idempotency_key_conflict');
  assert.equal(dbq('SELECT COUNT(*) c FROM orders WHERE user_id=?', a.uid)[0].c, 1);
  // Keys are scoped per user: B may use the same key for its own order.
  const r5 = await b.call('POST', `/v1/users/${b.uid}/orders`, body, H(k));
  assert.equal(r5.status, 201, show(r5));
  assert.notEqual(r5.body.order.order_id, r1.body.order.order_id);
  // A business error is stored too: replaying it does not re-run the order.
  const kErr = key('err');
  const e1 = await a.call('POST', `/v1/users/${a.uid}/orders`, { ...body, count: 100000 }, H(kErr));
  assert.equal(e1.status, 409, show(e1));
  const e2 = await a.call('POST', `/v1/users/${a.uid}/orders`, { ...body, count: 100000 }, H(kErr));
  assert.deepEqual([e2.status, e2.headers.get('idempotent-replayed'), e2.code], [409, 'true', e1.code]);
  // Malformed keys are rejected; requests without a key behave as before.
  const bad = await a.call('POST', `/v1/users/${a.uid}/orders`, body, H('has spaces and !'));
  assert.deepEqual([bad.status, bad.code], [400, 'invalid_idempotency_key']);
  const plain1 = await a.call('POST', `/v1/users/${a.uid}/orders`, body);
  const plain2 = await a.call('POST', `/v1/users/${a.uid}/orders`, body);
  assert.notEqual(plain1.body.order.order_id, plain2.body.order.order_id);
  // Another user's key cannot be used to read A's stored response: B gets its own result for its own body.
  const r6 = await b.call('POST', `/v1/users/${b.uid}/orders`, { ...body, price: 3 }, H(k));
  assert.equal(r6.code, 'idempotency_key_conflict');
});

test('deposits, withdrawals, perps transfers/orders/close: one execution per key; concurrent duplicates execute once', async () => {
  const a = await user('jade');
  // Deposit replay: exactly one ledger entry.
  const kd = key('dep');
  for (let i = 0; i < 3; i++) assert.equal((await a.call('POST', `/v1/users/${a.uid}/deposits`, { amount_dollars: 300 }, H(kd))).status, 201);
  assert.equal(dbq("SELECT COUNT(*) c FROM ledger WHERE user_id=? AND kind='deposit'", a.uid)[0].c, 1);
  assert.equal(balance(a.uid), 30000);
  // Withdrawal replay (fresh sign-in satisfies step-up).
  const kw = key('wd');
  for (let i = 0; i < 2; i++) { const r = await a.call('POST', `/v1/users/${a.uid}/withdrawals`, { amount_dollars: 10 }, H(kw)); assert.equal(r.status, 201, show(r)); }
  assert.equal(dbq("SELECT COUNT(*) c FROM ledger WHERE user_id=? AND kind='withdrawal'", a.uid)[0].c, 1);
  assert.equal(balance(a.uid), 29000);
  // Perps transfer replay.
  const kt = key('tr');
  for (let i = 0; i < 2; i++) { const r = await a.call('POST', '/v1/perps/transfers', { direction: 'to_perps', amount_dollars: 100 }, H(kt)); assert.equal(r.status, 201, show(r)); }
  assert.equal(dbq('SELECT COUNT(*) c FROM perp_transfers WHERE user_id=?', a.uid)[0].c, 1);
  // Perps market order, then close the position: each once.
  const ko = key('perp');
  const po = { ticker: 'PLXETHPERP', side: 'bid', type: 'market', count: 1 };
  const p1 = await a.call('POST', '/v1/perps/orders', po, H(ko));
  assert.equal(p1.status, 201, show(p1));
  const p2 = await a.call('POST', '/v1/perps/orders', po, H(ko));
  assert.equal(p2.headers.get('idempotent-replayed'), 'true');
  assert.equal(p2.body.order_id, p1.body.order_id);
  assert.equal(dbq('SELECT COUNT(*) c FROM perp_orders WHERE user_id=?', a.uid)[0].c, 1);
  const kc = key('close');
  const c1 = await a.call('POST', '/v1/perps/positions/PLXETHPERP/close', { percent: 100 }, H(kc));
  assert.equal(c1.status, 200, show(c1));
  const c2 = await a.call('POST', '/v1/perps/positions/PLXETHPERP/close', { percent: 100 }, H(kc));
  assert.deepEqual([c2.status, c2.headers.get('idempotent-replayed')], [200, 'true']);
  assert.equal(dbq('SELECT COUNT(*) c FROM perp_orders WHERE user_id=?', a.uid)[0].c, 2);

  // Eight identical requests at once: one order; the rest replay it or are told the first is still in progress.
  const kp = key('burst');
  const t = market(1);
  const results = await Promise.all(Array.from({ length: 8 }, () => a.call('POST', `/v1/users/${a.uid}/orders`, { ticker: t, side: 'no', type: 'limit', price: 1, count: 1 }, H(kp))));
  assert.equal(dbq('SELECT COUNT(*) c FROM orders WHERE user_id=? AND market_ticker=?', a.uid, t)[0].c, 1);
  const ids = new Set(results.filter((r) => r.status === 201).map((r) => r.body.order.order_id));
  assert.equal(ids.size, 1);
  for (const r of results) assert.ok(r.status === 201 || (r.status === 409 && r.code === 'idempotency_key_in_progress'), show(r));
});

test('RFQ accept and quote confirm execute once per key', async () => {
  const req = await user('kira', 200);
  const mk = await user('kurt', 200);
  for (const c of [req, mk]) assert.equal((await c.call('PUT', `/v1/users/${c.uid}/properties`, { properties: { rfq_enabled: true } })).status, 200);
  const t = market(2);
  let r = await req.call('POST', '/v1/communications/rfqs', { market_ticker: t, contracts_fp: '2' });
  assert.equal(r.status, 201, show(r));
  const rfq = r.body.id;
  // Bids far below the book so the maker's post-only order never crosses resting liquidity.
  r = await mk.call('POST', '/v1/communications/quotes', { rfq_id: rfq, yes_bid: '0.02', no_bid: '0.02' });
  assert.equal(r.status, 201, show(r));
  const qid = r.body.id;
  const ka = key('accept');
  const a1 = await req.call('PUT', `/v1/communications/rfqs/${rfq}/quotes/${qid}/accept`, { accepted_side: 'yes' }, H(ka));
  assert.equal(a1.status, 200, show(a1));
  const a2 = await req.call('PUT', `/v1/communications/rfqs/${rfq}/quotes/${qid}/accept`, { accepted_side: 'yes' }, H(ka));
  assert.deepEqual([a2.status, a2.headers.get('idempotent-replayed')], [200, 'true']);
  const kc = key('confirm');
  const c1 = await mk.call('PUT', `/v1/communications/quotes/${qid}/confirm`, {}, H(kc));
  assert.equal(c1.status, 200, show(c1));
  assert.equal(c1.body.quote.status, 'executed');
  const c2 = await mk.call('PUT', `/v1/communications/quotes/${qid}/confirm`, {}, H(kc));
  assert.deepEqual([c2.status, c2.headers.get('idempotent-replayed'), c2.body.quote.status], [200, 'true', 'executed']);
  // Exactly one maker order and one requester order were created by the execution.
  assert.equal(dbq("SELECT COUNT(*) c FROM orders WHERE user_id=? AND source='rfq'", mk.uid)[0].c, 1);
  assert.equal(dbq("SELECT COUNT(*) c FROM orders WHERE user_id=? AND source='rfq'", req.uid)[0].c, 1);
  // Without the key, a second confirm is refused by the quote state machine (defence in depth).
  const c3 = await mk.call('PUT', `/v1/communications/quotes/${qid}/confirm`, {});
  assert.equal(c3.status, 409);
});

test('step-up refusals are not stored: after verifying, the retry with the same key succeeds once', async () => {
  const a = await user('lena', 100);
  dbrun('UPDATE sessions SET auth_at=0 WHERE user_id=?', a.uid); // the sign-in is no longer "recent"
  const k = key('stepup');
  const r1 = await a.call('POST', `/v1/users/${a.uid}/withdrawals`, { amount_dollars: 5 }, H(k));
  assert.equal(r1.status === 401 || r1.status === 403, true, show(r1));
  assert.equal(r1.code, 'step_up_required');
  assert.equal(dbq('SELECT COUNT(*) c FROM idempotency_keys WHERE user_id=?', a.uid)[0].c, 0);
  assert.equal((await a.call('POST', '/v1/step_up', { password: PW })).status, 200);
  const r2 = await a.call('POST', `/v1/users/${a.uid}/withdrawals`, { amount_dollars: 5 }, H(k));
  assert.equal(r2.status, 201, show(r2));
  const r3 = await a.call('POST', `/v1/users/${a.uid}/withdrawals`, { amount_dollars: 5 }, H(k));
  assert.equal(r3.headers.get('idempotent-replayed'), 'true');
  assert.equal(dbq("SELECT COUNT(*) c FROM ledger WHERE user_id=? AND kind='withdrawal'", a.uid)[0].c, 1);
});

test('keys persist across a restart and expire after 24 hours', async () => {
  const a = await user('mona', 100);
  const k = key('persist');
  const r1 = await a.call('POST', `/v1/users/${a.uid}/deposits`, { amount_dollars: 7 }, H(k));
  assert.equal(r1.status, 201);
  const row = dbq('SELECT route, request_hash, status FROM idempotency_keys WHERE user_id=? AND idem_key=?', a.uid, k)[0];
  assert.equal(row.route, `POST /users/${a.uid}/deposits`);
  assert.match(row.request_hash, /^[0-9a-f]{64}$/);
  assert.equal(row.status, 201);
  await srv.close();
  await sleep(200); // let pooled keep-alive sockets to the old server close
  srv = await start(OPTS);
  await a.logIn(email('mona'), PW);
  const r2 = await a.call('POST', `/v1/users/${a.uid}/deposits`, { amount_dollars: 7 }, H(k));
  assert.deepEqual([r2.status, r2.headers.get('idempotent-replayed')], [201, 'true']);
  assert.equal(dbq("SELECT COUNT(*) c FROM ledger WHERE user_id=? AND kind='deposit'", a.uid)[0].c, 2);
  // 25 hours later the key is free again (the stored record has expired).
  dbrun('UPDATE idempotency_keys SET created_ts=? WHERE user_id=? AND idem_key=?', Date.now() - 25 * 3600 * 1000, a.uid, k);
  const r3 = await a.call('POST', `/v1/users/${a.uid}/deposits`, { amount_dollars: 8 }, H(k));
  assert.equal(r3.status, 201, show(r3));
  assert.equal(r3.headers.get('idempotent-replayed'), null);
  assert.equal(dbq("SELECT COUNT(*) c FROM ledger WHERE user_id=? AND kind='deposit'", a.uid)[0].c, 3);
});

test('request validation: schemas reject type confusion and unknown money fields; bodies over the route limit get 413', async () => {
  const a = await user('nora', 50);
  let r = await a.call('POST', `/v1/users/${a.uid}/deposits`, { amount_dollars: { $gt: 0 } });
  assert.deepEqual([r.status, r.code], [400, 'validation_failed']);
  assert.ok(r.body.error.fields.amount_dollars);
  r = await a.call('POST', `/v1/users/${a.uid}/deposits`, { amount_dollars: 5, user_id: 'u_someone_else' });
  assert.deepEqual([r.status, r.code], [400, 'validation_failed']);
  assert.ok(r.body.error.fields.user_id);
  r = await a.call('POST', `/v1/users/${a.uid}/deposits`, '[1,2,3]');
  assert.equal(r.status, 400);
  r = await a.call('POST', `/v1/users/${a.uid}/orders`, { ticker: ['A', 'B'], side: 'yes', count: 1, price: 5 });
  assert.deepEqual([r.status, r.code], [400, 'validation_failed']);
  r = await a.call('POST', `/v1/users/${a.uid}/orders`, { ticker: market(), side: 'yes', type: 'limit', count: 1, price: 5, client_order_id: 'x'.repeat(65) });
  assert.deepEqual([r.status, r.code], [400, 'validation_failed']);
  // time_in_force is checked against the values the handlers accept (perps spells them out in full).
  r = await a.call('POST', '/v1/perps/orders', { ticker: 'PLXBTCPERP', side: 'bid', type: 'limit', price: '1.0000', count: 1, time_in_force: 'good_til_whenever' });
  assert.deepEqual([r.status, r.code], [400, 'validation_failed']);
  r = await a.call('POST', '/v1/perps/orders', { ticker: 'PLXBTCPERP', side: 'bid', type: 'limit', price: '1.0000', count: 1, time_in_force: 'good_till_canceled' });
  assert.notEqual(r.code, 'validation_failed', show(r));
  r = await a.call('POST', '/v1/perps/transfers', { direction: 'to_perps', amount_dollars: 1, client_transfer_id: '<script>' });
  assert.deepEqual([r.status, r.code], [400, 'validation_failed']);
  // Size limits: 1 KB on deposits, 4 KB on orders; the same padding is fine on a route with a larger limit.
  r = await a.call('POST', `/v1/users/${a.uid}/deposits`, JSON.stringify({ amount_dollars: 1, pad: 'x'.repeat(2000) }));
  assert.deepEqual([r.status, r.code], [413, 'payload_too_large']);
  r = await a.call('POST', `/v1/users/${a.uid}/orders`, JSON.stringify({ ticker: market(), side: 'yes', count: 1, price: 5, pad: 'x'.repeat(5000) }));
  assert.deepEqual([r.status, r.code], [413, 'payload_too_large']);
  r = await a.call('PUT', `/v1/users/${a.uid}/properties`, { properties: { theme: 'dark' }, pad: 'x'.repeat(5000) });
  assert.equal(r.status, 200, show(r));
  // Social posts must be text.
  assert.ok((await a.call('POST', `/v1/users/${a.uid}/social/profile`, { nickname: `nora_${String(stamp).slice(-6)}` })).status < 300);
  r = await a.call('POST', `/v1/users/${a.uid}/social/posts`, { body: { toString: 'x' } });
  assert.deepEqual([r.status, r.code], [400, 'validation_failed']);
  // Nothing above moved money.
  assert.equal(dbq("SELECT COUNT(*) c FROM ledger WHERE user_id=? AND kind='deposit'", a.uid)[0].c, 1);
});

test('G2: a Dollars order filled across thousands of 0.01-contract makers never spends more than its amount', async () => {
  const maker = await user('owen', 1000);
  const taker = await user('opal', 1000);
  const t = market(3);
  const best = dbq("SELECT MAX(price_cents) p FROM orders WHERE market_ticker=? AND status='resting' AND side='no'", t)[0].p;
  // 3,000 resting NO bids of 0.01 contracts at the best price, ahead of the existing queue. Each fill costs the taker
  // ceil(p/100) + ceil(fee) = 2 cents for 0.01 contracts, four times the nominal per-contract price: the per-fill rounding
  // the old sizing loop could not absorb (it spent $66.31 on this $15 order).
  const N = 3000;
  const d = new DatabaseSync(DB_FILE);
  try {
    d.exec('BEGIN');
    const ins = d.prepare("INSERT INTO orders(id,seq,user_id,market_ticker,side,price_cents,initial_count,remaining_count,reserved_cents,status,time_in_force,created_at,updated_at,source,action,order_type) VALUES(?,?,?,?,?,?,?,?,?,'resting','gtc',?,?,'user','buy','limit')");
    const now = new Date().toISOString();
    for (let i = 0; i < N; i++) ins.run(`o_g2_${stamp}_${i}`, -1000000 + i, maker.uid, t, 'no', best, 1, 1, 1, now, now);
    d.prepare('UPDATE users SET balance_cents=balance_cents-? WHERE id=?').run(N, maker.uid);
    d.exec('COMMIT');
  } finally { d.close(); }
  const cap = 1500;
  const before = balance(taker.uid);
  const r = await taker.call('POST', `/v1/users/${taker.uid}/orders`, { ticker: t, side: 'yes', type: 'dollars', amount_dollars: cap / 100 }, H(key('g2')));
  assert.equal(r.status, 201, show(r));
  const spent = before - balance(taker.uid);
  const fills = dbq('SELECT COALESCE(SUM(count),0) n, COALESCE(SUM(fee_cents),0) fee FROM fills WHERE order_id=?', r.body.order.order_id)[0];
  const principal = -dbq("SELECT COALESCE(SUM(amount_cents),0) s FROM ledger WHERE user_id=? AND kind='trade' AND ref IN (SELECT trade_id FROM fills WHERE order_id=?)", taker.uid, r.body.order.order_id)[0].s;
  assert.ok(spent <= cap, `spent ${spent}¢ on a ${cap}¢ Dollars order`);
  assert.equal(spent, principal + fills.fee, 'the spend is exactly the fills\' principal plus fees');
  assert.ok(fills.n >= 700, `the order should still buy as much as fits (bought ${fills.n} units)`);
  assert.ok(cap - spent <= 3, `left ${cap - spent}¢ unspent; at most one more fill's cost should remain`);
  assert.equal(dbq('SELECT reserved_cents FROM orders WHERE id=?', r.body.order.order_id)[0].reserved_cents, 0);
});

test('browser: each action sends a fresh Idempotency-Key and the automatic retry reuses it, so a retried deposit or order executes once', async () => {
  const name = 'pia';
  const c = await user(name, 100);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Carry the API session into the browser exactly as the SPA stores it: session cookie + CSRF mirror in localStorage.
  await ctx.addCookies([...c.jar].map(([n, v]) => ({ name: n, value: v, url: BASE })));
  await ctx.addInitScript((tok) => { try { localStorage.setItem('csrfToken', JSON.stringify({ value: tok, expiry: Date.now() + 864e5 })); } catch { /* ignore */ } }, c.csrf);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const seen = [];
  page.on('request', (rq) => { if (/\/(deposits|orders)$/.test(new URL(rq.url()).pathname) && rq.method() === 'POST') seen.push({ path: new URL(rq.url()).pathname, key: rq.headers()['idempotency-key'] }); });
  // The first deposit reaches the server, but the browser is told its client token was stale (as after a long idle):
  // api.js refreshes the token and retries the same action with the same key, and the server replays the result.
  let failedOnce = false;
  await page.route('**/v1/users/*/deposits', async (route) => {
    if (failedOnce) return route.continue();
    failedOnce = true;
    await route.fetch(); // executed on the server
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'client_token_invalid', message: 'client token invalid or expired' } }) });
  });
  await page.goto(BASE + '/portfolio');
  await page.waitForSelector('#f-amount');
  await page.fill('#f-amount', '2500');
  await page.click('#funds [data-act=deposit]');
  await page.waitForFunction(() => document.querySelector('#f-amount').value === '');
  // A second, separate click is a new action with a new key.
  await page.fill('#f-amount', '500');
  await page.click('#funds [data-act=deposit]');
  await page.waitForFunction(() => document.querySelector('#f-amount').value === '');
  const deps = seen.filter((s) => s.path.endsWith('/deposits'));
  assert.equal(deps.length, 3, JSON.stringify(deps));
  assert.ok(deps.every((s) => /^[A-Za-z0-9_.:-]{16,}$/.test(s.key || '')), JSON.stringify(deps));
  assert.equal(deps[0].key, deps[1].key, 'the automatic retry reuses the action\'s key');
  assert.notEqual(deps[1].key, deps[2].key, 'a new action gets a new key');
  const ledger = dbq("SELECT amount_cents FROM ledger WHERE user_id=? AND kind='deposit' ORDER BY rowid", c.uid).map((x) => x.amount_cents);
  assert.deepEqual(ledger, [10000, 2500, 500], 'the retried $25 deposit was credited once');

  // Orders from the trade ticket carry a key too, and the same retry path places one order.
  failedOnce = false;
  await page.route('**/v1/users/*/orders', async (route) => {
    if (route.request().method() !== 'POST' || failedOnce) return route.continue();
    failedOnce = true;
    await route.fetch();
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'client_token_invalid', message: 'client token invalid or expired' } }) });
  });
  const t = market(4);
  const ev = dbq('SELECT e.ticker et, s.ticker st, s.slug FROM markets m JOIN events e ON e.ticker=m.event_ticker JOIN series s ON s.ticker=e.series_ticker WHERE m.ticker=?', t)[0];
  await page.goto(`${BASE}/markets/${ev.st.toLowerCase()}/${ev.slug}/${ev.et.toLowerCase()}`);
  await page.waitForSelector('[data-testid=submit-order]');
  const ordersBefore = dbq('SELECT COUNT(*) c FROM orders WHERE user_id=?', c.uid)[0].c;
  await page.click('#t-mode-btn');
  await page.click('[data-otype=limit]');
  await page.fill('#t-count', '2');
  await page.fill('#t-price', '3');
  await page.click('[data-testid=submit-order]'); await page.click('[data-testid=review-confirm]'); // order review step (Phase 5A, A7)
  await page.waitForFunction(() => /Submitting/.test(document.querySelector('[data-testid=submit-order]')?.textContent || '') === false);
  await sleep(500);
  const ords = seen.filter((s) => s.path.endsWith('/orders'));
  assert.equal(ords.length, 2, JSON.stringify(ords));
  assert.equal(ords[0].key, ords[1].key);
  assert.equal(dbq('SELECT COUNT(*) c FROM orders WHERE user_id=?', c.uid)[0].c, ordersBefore + 1, 'one order despite the retry');
  assert.deepEqual(errors, []);
  await ctx.close();
});
