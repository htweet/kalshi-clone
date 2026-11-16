'use strict';
// Long-lived in-memory state stays bounded (soak review 2026-11-15, CLONE_SPEC.md §39.20), real server + SQLite +
// Chromium. Each check fails on the code before the review:
//   • token buckets (community, chat, circle, chat reactions) drop their full entries by themselves: thousands of
//     distinct users / IPs leave one entry a minute later (the circle and reaction buckets were never pruned);
//   • session-time accounting keeps members active in the last ten minutes only (idle members' seconds are written and
//     their entries dropped; it kept one entry per member ever seen);
//   • a web WebSocket holds at most 200 subscriptions (error 13 beyond), and a closed socket leaves nothing behind;
//   • the web app releases a subscription it dropped before the server answered (navigating away within the round
//     trip left it on the server, published to, for the socket's lifetime);
//   • a FIX session keeps at most 500 finished orders in memory, and a logon loads only resting orders (it kept, and
//     reloaded, every order of the session key);
//   • every registered structure is reported on the metrics port;
//   • an order's own fills are read by order id (migration 0013): with 200,000 fills of one trader the read stays a
//     lookup (it scanned all of the trader's fills on every order, the order-latency drift of the soak).
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { harness, newPage, sleep, eventually, PW } = require('./lib/api-helpers');
const { Client } = require('./lib/client');
const { FixClient } = require('./lib/fix-client');
const { bucket } = require('../server/community-util');

const H = harness('memory');
let browser; let admin;
const mem = (name) => { const f = H.srv.engine.memory.get(name); assert.ok(f, `${name} is registered`); return f(); };
const stepped = async (c, m, p, b) => { let r = await c.call(m, p, b); if (r.code === 'step_up_required') { await c.call('POST', '/v1/step_up', { password: PW }); r = await c.call(m, p, b); } return r; };

before(async () => {
  await H.start({ sports: false });
  browser = await chromium.launch();
  admin = await H.adminClient();
});
after(async () => {
  try { await browser?.close(); } catch { /* closed */ }
  await H.stop(); H.cleanup();
});

test('token buckets drop full entries by themselves; the community and chat buckets are registered', () => {
  mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  try {
    const b = bucket(5, 1);
    for (let i = 0; i < 5000; i++) b.take(`203.0.113.${i % 250}/${i}`);
    assert.equal(b.size, 5000, 'one entry per key while it refills');
    assert.equal(b.take('203.0.113.1/1'), 0, 'a key with tokens left is allowed');
    for (let i = 0; i < 5; i++) b.take('busy');
    assert.ok(b.take('busy') > 0, 'an empty bucket refuses');
    mock.timers.tick(61000);
    assert.equal(b.take('fresh'), 0);
    assert.equal(b.size, 1, 'a minute later only the new key is left (full buckets are the default)');
  } finally { mock.timers.reset(); }
  for (const n of ['chat_buckets', 'circle_write_buckets', 'chat_reaction_buckets']) assert.equal(typeof mem(n), 'number', n);
});

test('session-time accounting keeps members active in the last ten minutes only; their seconds are written', async () => {
  const users = [];
  for (let i = 0; i < 12; i++) users.push(await H.user(`idle${i}`));
  for (const c of users) assert.equal((await c.call('GET', `/v1/users/${c.uid}/balance`)).status, 200);
  const before = mem('session_time');
  assert.ok(before >= users.length, `one entry per active member (${before})`);
  const rows = H.q1(`SELECT COUNT(*) n FROM session_usage WHERE user_id IN (${users.map(() => '?').join(',')})`, ...users.map((c) => c.uid)).n;
  assert.equal(rows, users.length, 'each member has a session_usage row');
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60000;
  try {
    assert.equal((await users[0].call('GET', `/v1/users/${users[0].uid}/balance`)).status, 200);
    assert.ok(mem('session_time') <= 1, `idle members dropped (${mem('session_time')} left)`);
    // A dropped member's next request starts again from the stored row (as after a restart).
    assert.equal((await users[1].call('GET', `/v1/users/${users[1].uid}/balance`)).status, 200);
    assert.equal(mem('session_time'), 2);
    const r = await users[1].call('GET', `/v1/users/${users[1].uid}/daily_session_time_limit`);
    assert.equal(r.status, 200);
  } finally { Date.now = realNow; }
});

test('a web WebSocket holds at most 200 subscriptions, and a closed socket leaves none behind', async () => {
  const base = mem('ws_subscriptions');
  const viewer = await new Client(H.BASE, 'viewer').boot();
  const s = viewer.socket();
  await s.opened;
  const ok = await s.subscribe(Array(200).fill('ticker'), { market_tickers: ['NOPE-1'] });
  assert.equal(ok.filter((m) => m.type === 'subscribed').length, 200);
  assert.equal(mem('ws_subscriptions'), base + 200);
  const [over] = await s.subscribe(['trade']);
  assert.equal(over.type, 'error'); assert.equal(over.msg.code, 13);
  assert.equal(mem('ws_subscriptions'), base + 200, 'the refused subscription was not added');
  s.ws.close();
  await eventually(() => mem('ws_subscriptions') === base);
});

test('the web app releases a subscription it dropped before the server answered', async () => {
  const page = await newPage(browser);
  await page.goto(`${H.BASE}/`);
  await page.waitForFunction(async () => (await import('/js/ws.js')).socket.connected === true, null, { timeout: 15000 });
  await sleep(1500); // the page's own subscriptions settle
  const settled = mem('ws_subscriptions');
  await page.evaluate(async () => {
    const { socket } = await import('/js/ws.js');
    // Subscribe and leave at once (as a view torn down within the round trip), five times.
    for (let i = 0; i < 5; i++) { const off = socket.subscribe({ channels: ['trade'], market_tickers: [`GONE-${i}`] }, () => {}); off(); }
    // A subscription kept is answered normally and stays.
    window.__kept = socket.subscribe({ channels: ['trade'], market_tickers: ['KEPT-1'] }, () => {});
  });
  await eventually(() => mem('ws_subscriptions') === settled + 1, { timeout: 5000 });
  await sleep(500);
  assert.equal(mem('ws_subscriptions'), settled + 1, 'only the kept subscription is left on the server');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('a FIX session keeps at most 500 finished orders in memory; a logon loads only resting orders', async () => {
  assert.equal((await stepped(admin, 'PUT', '/v1/admin/flags/api.fix', { enabled: true, reason: 'e2e memory fix on' })).status, 200);
  const port = await eventually(() => H.srv.fix.port() || false, { timeout: 8000 });
  const fred = await H.user('fixfred', { dollars: 500 });
  const k = await H.key(fred, { kind: 'rsa', label: 'FIX memory' });
  const T = H.openMarket();
  // A drop copy session sees every order of its owner: 600 orders, then all canceled.
  const dc = new FixClient(port, { sender: 'MEMDC', target: 'PARLANCEDC', keyId: k.id, privateKey: k.privateKey });
  await dc.connect(); dc.logon();
  await dc.waitFor((m) => m.type === 'A');
  const ids = [];
  for (let i = 0; i < 600; i++) ids.push(H.srv.engine.placeOrder(fred.uid, { ticker: T, side: 'yes', price: 2, count: 100 }).id);
  await eventually(() => mem('fix_session_orders') === 600, { timeout: 8000 });
  for (const id of ids) H.srv.engine.cancelOrder(fred.uid, id);
  await eventually(() => dc.messages.filter((m) => m.type === '8' && m.get(150) === '4').length === 600, { timeout: 15000 });
  assert.ok(mem('fix_session_orders') <= 500, `finished orders retired (${mem('fix_session_orders')} kept)`);
  dc.close(); await dc.closedP;
  await eventually(() => mem('fix_session_orders') === 0);
  // Order entry: three orders, one canceled; the next logon of the same session key loads the two resting ones.
  const fx = new FixClient(port, { sender: 'MEMFIRM', keyId: k.id, privateKey: k.privateKey });
  await fx.connect(); fx.logon();
  await fx.waitFor((m) => m.type === 'A');
  for (let i = 1; i <= 3; i++) {
    fx.send('D', [[11, `M-${i}`], [55, T], [54, '1'], [38, '1'], [40, '2'], [44, '0.0200']]);
    await fx.waitFor((m) => m.type === '8' && m.get(11) === `M-${i}` && m.get(150) === '0');
  }
  assert.equal(mem('fix_session_orders'), 3, 'three tracked orders, no ClOrdIDs left over');
  fx.send('F', [[11, 'M-4'], [41, 'M-1']]);
  await fx.waitFor((m) => m.type === '8' && m.get(150) === '4');
  // A ClOrdID already used in this session is still refused after its order was canceled (the used ones are kept in
  // fix_session_clordids, not in memory).
  fx.send('D', [[11, 'M-1'], [55, T], [54, '1'], [38, '1'], [40, '2'], [44, '0.0200']]);
  await fx.waitFor((m) => m.type === '8' && m.get(150) === '8' && m.get(58) === 'duplicate ClOrdID');
  assert.equal(mem('fix_session_orders'), 3);
  fx.send('5', []); fx.close(); await fx.closedP;
  await eventually(() => mem('fix_session_orders') === 0);
  const again = new FixClient(port, { sender: 'MEMFIRM', keyId: k.id, privateKey: k.privateKey });
  await again.connect(); again.logon();
  await again.waitFor((m) => m.type === 'A');
  assert.equal(mem('fix_session_orders'), 2, 'only the resting orders were loaded');
  again.close(); await again.closedP;
});

test('every registered structure is reported on the metrics port', async () => {
  const body = await H.srv.app.locals.obs.registry.render(); // what the private metrics port serves
  for (const n of H.srv.engine.memory.keys()) assert.match(body, new RegExp(`parlance_status\\{name="entries_${n}"\\} \\d+`), n);
});

test('an order reads its own fills by index, however many fills its trader has (migration 0013)', async () => {
  const u = await H.user('heavyfills');
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(H.DB_FILE);
  try {
    d.exec('PRAGMA foreign_keys = OFF'); d.exec('BEGIN');
    const ins = d.prepare('INSERT INTO fills(id,trade_id,order_id,user_id,market_ticker,side,price_cents,count,is_taker,fee_cents,created_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    const t0 = Date.now() - 86400000;
    for (let i = 0; i < 200000; i++) ins.run(`hf_${i}`, `ht_${i}`, `ho_${i >> 1}`, u.uid, 'HEAVY-1', 'yes', 40, 100, 1, 1, t0 + i);
    d.exec('COMMIT');
  } finally { d.close(); }
  const sql = 'SELECT COALESCE(SUM(count),0) n, COALESCE(SUM(count*price_cc),0) v FROM fills WHERE order_id=? AND user_id=?';
  const plan = H.srv.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('x', u.uid).map((r) => r.detail).join(' | ');
  assert.match(plan, /idx_fills_order/, plan);
  const st = H.srv.db.prepare(sql);
  const t = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) assert.equal(st.get(`ho_${i * 50}`, u.uid).n, 200);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.ok(ms < 500, `200 reads took ${ms.toFixed(0)} ms (a scan of the trader's 200,000 fills each time takes seconds)`);
});
