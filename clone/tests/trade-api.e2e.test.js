'use strict';
// Phase 7 P7.1 security gate + P7.2 API surface (CLONE_SPEC.md §35.3–§35.7): signed REST requests (headers, clock-skew
// window, replay, bad signatures, revoked / expired keys, locked and frozen owners, scopes, IP allowlist, environment,
// rate tiers with 429 + Retry-After, keys never on /v1 and cookies never on /trade-api), the same gates as the website
// (flags, trading limits), orders (create, amend, decrease, cancel, batch with partial failure, Idempotency-Key), order
// groups, history with cursors, Perps under /margin, and the public WebSocket (auth, public and private channels,
// contiguous seq, commands and errors, connection caps, the flag, revocation). The usage dashboard shows the 429s.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { harness, newPage, uiLogIn, sleep, eventually, PW } = require('./lib/api-helpers');
const { WebSocket } = require('ws');
const { SignedClient, headersFor, ed25519, wrapSocket } = require('./lib/signing');
const { Client } = require('./lib/client');

const H = harness('tradeapi');
let browser; let admin; let alice; let ak; let T;
const B = '/trade-api/v2';

before(async () => {
  await H.start();
  browser = await chromium.launch();
  admin = await H.adminClient();
  alice = await H.user('alice', { dollars: 2000 });
  ak = await H.key(alice, { kind: 'rsa', label: 'Alice trading' });
  T = H.openMarket();
  // Premier: these tests send bursts of orders well above Basic's write budget (the 429 test uses its own key).
  assert.equal((await admin.call('PUT', `/v1/admin/api_keys/${ak.id}/tier`, { tier: 'premier', reason: 'e2e burst headroom' })).status, 200);
});
after(async () => { await browser?.close(); await H.stop(); H.cleanup(); });
const setFlag = async (key, enabled) => { let r = await admin.call('PUT', `/v1/admin/flags/${key}`, { enabled, reason: `e2e ${key} ${enabled}` }); if (r.code === 'step_up_required') { await admin.call('POST', '/v1/step_up', { password: PW }); r = await admin.call('PUT', `/v1/admin/flags/${key}`, { enabled, reason: `e2e ${key} ${enabled}` }); } assert.equal(r.status, 200, r.text); };
const raw = (p, headers, init = {}) => fetch(H.BASE + p, { ...init, headers: { accept: 'application/json', ...headers } }).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json().catch(() => null) }));

test('security gate: headers, skew window, signatures, replay, key state, owner state, scopes, IP, environment', async () => {
  const s = ak.signed;
  // Public data needs no key; private data does.
  assert.equal((await raw(`${B}/markets?limit=1`, {})).status, 200);
  const anon = await raw(`${B}/portfolio/balance`, {});
  assert.equal(anon.status, 401); assert.equal(anon.body.error.code, 'token_authentication_failure');
  // Missing / malformed headers.
  const part = await raw(`${B}/portfolio/balance`, { 'PARLANCE-ACCESS-KEY': ak.id });
  assert.equal(part.body.error.reason, 'missing_headers');
  const bad = await raw(`${B}/portfolio/balance`, { 'PARLANCE-ACCESS-KEY': 'nope', 'PARLANCE-ACCESS-TIMESTAMP': 'x', 'PARLANCE-ACCESS-SIGNATURE': 'y' });
  assert.equal(bad.body.error.reason, 'malformed');
  // Clock skew: 5 s past / 1 s future by default; the error says how far off and gives the server time.
  let r = await s.call('GET', `${B}/portfolio/balance`, undefined, { ts: Date.now() - 10000 });
  assert.equal(r.status, 401); assert.equal(r.reason, 'clock_skew'); assert.match(r.body.error.details, /10\.\d s in the past/); assert.ok(r.body.error.server_time_ms > 0);
  r = await s.call('GET', `${B}/portfolio/balance`, undefined, { ts: Date.now() + 3000 });
  assert.equal(r.reason, 'clock_skew'); assert.match(r.body.error.details, /in the future/);
  assert.equal((await s.call('GET', `${B}/portfolio/balance`, undefined, { ts: Date.now() - 3000 })).status, 200, 'inside the window');
  // Signatures: another key's, a different path, an unknown key; the query string is not signed.
  const other = ed25519();
  assert.equal((await new SignedClient(H.BASE, ak.id, other.privateKey).call('GET', `${B}/portfolio/balance`)).reason, 'invalid_signature');
  assert.equal((await s.call('GET', `${B}/portfolio/positions`, undefined, { sigPath: `${B}/portfolio/balance` })).reason, 'invalid_signature');
  assert.equal((await new SignedClient(H.BASE, 'plxk_00000000-0000-4000-8000-000000000000', ak.privateKey).call('GET', `${B}/portfolio/balance`)).reason, 'invalid_signature');
  assert.equal((await s.call('GET', `${B}/portfolio/orders?limit=1`)).status, 200);
  // Replay: the same signed POST twice is refused the second time; repeated GETs are fine.
  const body = { ticker: T, side: 'yes', action: 'buy', type: 'limit', count: 1, yes_price: 2 };
  const hdr = headersFor({ keyId: ak.id, privateKey: ak.privateKey, method: 'POST', path: `${B}/portfolio/orders` });
  assert.equal((await s.call('POST', `${B}/portfolio/orders`, body, { headers: hdr })).status, 201);
  r = await s.call('POST', `${B}/portfolio/orders`, body, { headers: hdr });
  assert.equal(r.status, 401); assert.equal(r.reason, 'replayed_request');
  const gh = headersFor({ keyId: ak.id, privateKey: ak.privateKey, method: 'GET', path: `${B}/portfolio/balance` });
  for (let i = 0; i < 2; i++) assert.equal((await s.call('GET', `${B}/portfolio/balance`, undefined, { headers: gh })).status, 200);
  // A demo key on production: the environment is named.
  assert.equal((await new SignedClient(H.BASE, `plxdemo_${ak.id.slice(5)}`, ak.privateKey).call('GET', `${B}/portfolio/balance`)).reason, 'wrong_environment');
  // Keys never authenticate /v1 (browser routes); cookies never authenticate /trade-api.
  const v1 = await s.call('GET', `/v1/users/${alice.uid}/balance`);
  assert.equal(v1.status, 403); assert.equal(v1.code, 'client_token_required', 'the perimeter refuses it before the route');
  const v1b = await s.call('GET', '/v1/perps/balance', undefined, { sigPath: '/v1/perps/balance' });
  assert.equal(v1b.status, 401); assert.equal(v1b.code, 'token_authentication_failure');
  const cookieOnly = await alice.call('POST', `${B}/portfolio/orders`, body);
  assert.equal(cookieOnly.status, 401); assert.equal(cookieOnly.code, 'token_authentication_failure');
  // Scopes: a read key cannot trade or reach Perps; perps needs the perps scope.
  const rk = await H.key(alice, { scopes: ['read'], label: 'read only' });
  r = await rk.signed.call('POST', `${B}/portfolio/orders`, body);
  assert.equal(r.status, 403); assert.equal(r.reason, 'insufficient_scope');
  assert.equal((await rk.signed.call('GET', `${B}/margin/balance`)).reason, 'insufficient_scope');
  assert.equal((await rk.signed.call('GET', `${B}/portfolio/balance`)).status, 200);
  // IP allowlist: loopback allowed, anything else refused (403).
  const ipk = await H.key(alice, { ip_allowlist: ['127.0.0.1/32'], label: 'loopback' });
  assert.equal((await ipk.signed.call('GET', `${B}/portfolio/balance`)).status, 200);
  // Owner state: locked, then frozen (both money directions switched off) → 401 account_unavailable.
  let lr = await admin.call('POST', `/v1/admin/users/${alice.uid}/lock`, { reason: 'e2e lock check' });
  if (lr.code === 'step_up_required') { await admin.call('POST', '/v1/step_up', { password: PW }); lr = await admin.call('POST', `/v1/admin/users/${alice.uid}/lock`, { reason: 'e2e lock check' }); }
  assert.equal(lr.status, 200, lr.text);
  assert.equal((await s.call('GET', `${B}/portfolio/balance`)).reason, 'account_unavailable');
  assert.equal((await admin.call('POST', `/v1/admin/users/${alice.uid}/unlock`, { reason: 'e2e unlock' })).status, 200);
  H.run('INSERT INTO money_controls(user_id,deposits_revoked,withdrawals_revoked,reason,updated_at) VALUES(?,1,1,?,?) ON CONFLICT(user_id) DO UPDATE SET deposits_revoked=1, withdrawals_revoked=1', alice.uid, 'frozen', new Date().toISOString());
  assert.equal((await s.call('GET', `${B}/portfolio/balance`)).reason, 'account_unavailable');
  H.run('DELETE FROM money_controls WHERE user_id=?', alice.uid);
  alice = await new Client(H.BASE, 'alice').logIn(H.email('alice'), PW); // the lock ended her web sessions
  assert.equal((await s.call('GET', `${B}/portfolio/balance`)).status, 200);
  // Expired and revoked keys.
  H.run('UPDATE api_keys SET expires_ts=? WHERE id=?', Date.now() - 1, rk.id);
  assert.equal((await rk.signed.call('GET', `${B}/portfolio/balance`)).reason, 'key_expired');
  assert.equal((await alice.call('DELETE', `/v1/users/${alice.uid}/api_keys/${ipk.id}`)).status, 200);
  assert.equal((await ipk.signed.call('GET', `${B}/portfolio/balance`)).reason, 'key_revoked');
  // Every refusal is in the security log, never with a signature.
  const ev = H.q("SELECT detail FROM security_events WHERE kind IN ('api_auth_failed','api_replay')");
  assert.ok(ev.length >= 5);
  assert.ok(!ev.some((e) => e.detail && e.detail.includes(hdr['PARLANCE-ACCESS-SIGNATURE'])), 'signatures are never logged');
});

test('IP allowlist refusal, unparseable params, endpoint costs, rate tier 429 with Retry-After shown in the usage dashboard', async () => {
  const far = await H.key(alice, { ip_allowlist: ['203.0.113.0/24'], label: 'office' });
  const r = await far.signed.call('GET', `${B}/portfolio/balance`);
  assert.equal(r.status, 403); assert.equal(r.reason, 'ip_not_allowed');
  // The observed {msg} envelope for unparseable / out-of-range integers.
  assert.match((await ak.signed.call('GET', `${B}/portfolio/fills?limit=abc`)).body.msg, /Invalid format for parameter limit/);
  assert.match((await ak.signed.call('GET', `${B}/markets?limit=100000`)).body.msg, /'lte' tag/);
  const costs = (await ak.signed.call('GET', `${B}/account/endpoint_costs`)).body;
  assert.equal(costs.default_cost, 10);
  assert.ok(costs.endpoint_costs.some((c) => c.path === '/trade-api/v2/portfolio/orders/{order_id}' && c.method === 'DELETE' && c.cost === 2));
  // A tight Basic write budget: 20 tokens a second = two orders, the third gets 429 with Retry-After.
  let st = await admin.call('PUT', '/v1/admin/api_keys/settings', { tiers: { basic: { write_per_sec: 20 } }, reason: 'e2e tight tier' });
  if (st.code === 'step_up_required') { await admin.call('POST', '/v1/step_up', { password: PW }); st = await admin.call('PUT', '/v1/admin/api_keys/settings', { tiers: { basic: { write_per_sec: 20 } }, reason: 'e2e tight tier' }); }
  assert.equal(st.status, 200, st.text);
  const rl = await H.key(alice, { label: 'rate test' });
  const order = { ticker: T, side: 'yes', action: 'buy', count: 1, yes_price: 2 };
  const out = [];
  for (let i = 0; i < 3; i++) out.push(await rl.signed.call('POST', `${B}/portfolio/orders`, order));
  assert.deepEqual(out.map((x) => x.status), [201, 201, 429]);
  assert.equal(out[2].code, 'too_many_requests'); assert.ok(Number(out[2].headers.get('retry-after')) >= 1);
  assert.equal(out[2].body.error.tier, 'basic');
  // A batch that costs more than the whole bucket is refused outright.
  const big = await rl.signed.call('POST', `${B}/portfolio/orders/batched`, { orders: [order, order, order] });
  assert.equal(big.status, 429);
  await admin.call('PUT', '/v1/admin/api_keys/settings', { tiers: { basic: { write_per_sec: 100 } }, reason: 'e2e restore tier' });
  // The usage dashboard shows the 429s.
  await sleep(2200);
  const page = await newPage(browser);
  await uiLogIn(page, H.BASE, H.email('alice'));
  await page.goto(`${H.BASE}/account/api-keys`);
  await page.waitForSelector(`[data-testid=usage-row][data-key="${rl.id}"]`);
  assert.ok(Number(await page.textContent(`[data-testid=usage-row][data-key="${rl.id}"] [data-f=throttled]`)) >= 2);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('orders through the website rules: create, amend, decrease, cancel, batch with partial failure, idempotency, flags and limits', async () => {
  const s = ak.signed;
  let r = await s.call('POST', `${B}/portfolio/orders`, { ticker: T, side: 'yes', action: 'buy', type: 'limit', count_fp: '2.00', yes_price_dollars: '0.0300', client_order_id: 'cl-1' });
  assert.equal(r.status, 201, r.text);
  const o = r.body.order;
  assert.equal(o.status, 'resting'); assert.equal(o.yes_price_dollars, '0.0300'); assert.equal(o.no_price_dollars, '0.9700'); assert.equal(o.source, 'api'); assert.equal(o.client_order_id, 'cl-1');
  assert.equal(H.q1('SELECT source FROM orders WHERE id=?', o.order_id).source, 'api');
  r = await s.call('POST', `${B}/portfolio/orders/${o.order_id}/amend`, { yes_price: 4, count: 3 });
  assert.equal(r.status, 200, r.text); assert.equal(r.body.order.yes_price_dollars, '0.0400'); assert.equal(r.body.order.initial_count_fp, '3.00');
  r = await s.call('POST', `${B}/portfolio/orders/${o.order_id}/decrease`, { reduce_by: 1 });
  assert.equal(r.status, 200); assert.equal(r.body.order.remaining_count_fp, '2.00'); assert.equal(r.body.reduced_by_fp, '1.00');
  assert.equal((await s.call('GET', `${B}/portfolio/orders/${o.order_id}/queue_position`)).status, 200);
  // A NO-side order priced in NO; and a sell needs a position (the website rule).
  r = await s.call('POST', `${B}/portfolio/orders`, { ticker: T, side: 'no', action: 'buy', count: 1, no_price: 3 });
  assert.equal(r.body.order.no_price_dollars, '0.0300');
  assert.equal((await s.call('POST', `${B}/portfolio/orders`, { ticker: T, side: 'yes', action: 'sell', count: 50, yes_price: 99 })).code, 'insufficient_position');
  // Batch: one bad ticker fails alone.
  r = await s.call('POST', `${B}/portfolio/orders/batched`, { orders: [{ ticker: T, side: 'yes', action: 'buy', count: 1, yes_price: 2, client_order_id: 'b1' }, { ticker: 'NOPE-NOPE', side: 'yes', action: 'buy', count: 1, yes_price: 2, client_order_id: 'b2' }, { ticker: T, side: 'maybe', action: 'buy', count: 1 }] });
  assert.equal(r.status, 201);
  assert.equal(r.body.orders[0].order.status, 'resting'); assert.equal(r.body.orders[0].error, null);
  assert.equal(r.body.orders[1].order, null); assert.equal(r.body.orders[1].error.error.code, 'not_found');
  assert.equal(r.body.orders[2].error.error.code, 'bad_request');
  // Batch cancel by ids (gap G5), with an unknown id failing alone.
  r = await s.call('DELETE', `${B}/portfolio/orders/batched`, { ids: [o.order_id, r.body.orders[0].order.order_id, 'o_nope'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.orders.map((x) => (x.order ? x.order.status : x.error.error.code)), ['canceled', 'canceled', 'not_found']);
  assert.equal(r.body.orders[0].reduced_by_fp, '2.00');
  // Idempotency-Key: the same key and body replays the first response (no second order).
  const before = H.q1('SELECT COUNT(*) c FROM orders WHERE user_id=?', alice.uid).c;
  const ib = { ticker: T, side: 'yes', action: 'buy', count: 1, yes_price: 2 };
  const a1 = await s.call('POST', `${B}/portfolio/orders`, ib, { headers: { 'Idempotency-Key': 'idem-e2e-1' } });
  const a2 = await s.call('POST', `${B}/portfolio/orders`, ib, { headers: { 'Idempotency-Key': 'idem-e2e-1' } });
  assert.equal(a2.body.order.order_id, a1.body.order.order_id); assert.equal(a2.headers.get('idempotent-replayed'), 'true');
  assert.equal(H.q1('SELECT COUNT(*) c FROM orders WHERE user_id=?', alice.uid).c, before + 1);
  // Same gates as the web app: the trading flag, api.trading, and the user's own daily trading limit.
  await setFlag('trading', false);
  r = await s.call('POST', `${B}/portfolio/orders`, ib);
  assert.equal(r.status, 403); assert.equal(r.code, 'feature_disabled');
  await setFlag('trading', true);
  await setFlag('api.trading', false);
  assert.equal((await s.call('POST', `${B}/portfolio/orders`, ib)).body.error.feature, 'api.trading');
  assert.equal((await s.call('GET', `${B}/portfolio/balance`)).status, 200, 'reads continue');
  await setFlag('api.trading', true);
  const lu = await H.user('limits', { dollars: 200 });
  const lk = await H.key(lu);
  assert.equal((await lu.call('PUT', `/v1/users/${lu.uid}/trading_limits`, { limit_dollars: 1 })).status, 200);
  assert.equal((await lk.signed.call('POST', `${B}/portfolio/orders`, { ticker: T, side: 'yes', action: 'buy', count: 100, yes_price: 50 })).code, 'trading_limit_exceeded');
  await setFlag('api.keys', false);
  assert.equal((await s.call('GET', `${B}/portfolio/balance`)).code, 'feature_disabled');
  await setFlag('api.keys', true);
});

test('order groups trigger on their contracts limit; history with cursors; Perps under /margin', async () => {
  const bob = await H.user('bob', { dollars: 2000 });
  const bk = await H.key(bob, { kind: 'rsa-pub' });
  const s = bk.signed;
  let r = await s.call('POST', `${B}/portfolio/order_groups`, { contracts_limit: 1 });
  assert.equal(r.status, 201, r.text);
  const gid = r.body.order_group_id;
  r = await s.call('POST', `${B}/portfolio/orders`, { ticker: T, side: 'yes', action: 'buy', count: 1, yes_price: 2, order_group_id: gid });
  const resting = r.body.order;
  assert.equal(resting.order_group_id, gid);
  // A market order in the group fills one contract: the limit is reached, the resting order is canceled, and the group
  // refuses new orders until reset.
  r = await s.call('POST', `${B}/portfolio/orders`, { ticker: T, side: 'yes', action: 'buy', type: 'market', count: 1, order_group_id: gid });
  assert.equal(r.status, 201, r.text);
  await eventually(() => assert.equal(H.q1('SELECT status FROM order_groups WHERE id=?', gid).status, 'triggered'));
  await eventually(() => assert.equal(H.q1('SELECT status, cancel_reason FROM orders WHERE id=?', resting.order_id).cancel_reason, 'order_group_triggered'));
  assert.equal((await s.call('POST', `${B}/portfolio/orders`, { ticker: T, side: 'yes', action: 'buy', count: 1, yes_price: 2, order_group_id: gid })).code, 'order_group_triggered');
  r = await s.call('PUT', `${B}/portfolio/order_groups/${gid}/reset`);
  assert.equal(r.body.order_group.status, 'active');
  assert.equal((await s.call('GET', `${B}/portfolio/order_groups/${gid}`)).body.orders.length, 2);
  // IDOR: Alice cannot see or delete Bob's group.
  assert.equal((await ak.signed.call('GET', `${B}/portfolio/order_groups/${gid}`)).status, 404);
  assert.equal((await ak.signed.call('DELETE', `${B}/portfolio/order_groups/${gid}`)).status, 404);
  assert.equal((await ak.signed.call('GET', `${B}/portfolio/orders/${resting.order_id}`)).status, 404);
  assert.equal((await ak.signed.call('DELETE', `${B}/portfolio/orders/${resting.order_id}`)).status, 404);
  // History with cursors.
  for (let i = 0; i < 2; i++) await s.call('POST', `${B}/portfolio/orders`, { ticker: T, side: 'yes', action: 'buy', type: 'market', count: 1 });
  const p1 = (await s.call('GET', `${B}/portfolio/fills?limit=1`)).body;
  assert.equal(p1.fills.length, 1); assert.ok(p1.cursor);
  const p2 = (await s.call('GET', `${B}/portfolio/fills?limit=1&cursor=${p1.cursor}`)).body;
  assert.notEqual(p2.fills[0].fill_id, p1.fills[0].fill_id);
  const now = Math.floor(Date.now() / 1000);
  assert.ok((await s.call('GET', `${B}/historical/trades?ticker=${T}&min_ts=${now - 600}&limit=2`)).body.trades.length >= 1);
  assert.equal((await s.call('GET', `${B}/historical/trades?ticker=${T}&min_ts=${now + 600}`)).body.trades.length, 0);
  assert.equal((await s.call('GET', `${B}/historical/markets/${T}/candlesticks?period_interval=1&start_ts=${now - 3600}`)).status, 200);
  const pos = (await s.call('GET', `${B}/portfolio/positions`)).body;
  assert.ok(pos.market_positions.some((p) => p.ticker === T && Number(p.position_fp) >= 3));
  assert.equal((await s.call('GET', `${B}/portfolio/settlements`)).status, 200);
  // Perps: collateral moved in the web app, then a signed order, position and cancel.
  assert.equal((await bob.call('POST', '/v1/perps/transfers', { direction: 'to_perps', amount_dollars: 500 })).status, 201);
  const pm = (await s.call('GET', `${B}/margin/markets/PLXBTCPERP`)).body.market;
  r = await s.call('POST', `${B}/margin/orders`, { ticker: 'PLXBTCPERP', side: 'bid', type: 'limit', price: (Number(pm.mark_price) * 0.9).toFixed(4), count: 1, leverage: 2 });
  assert.equal(r.status, 201, r.text);
  const po = r.body.order_id;
  assert.ok((await s.call('GET', `${B}/margin/orders?status=resting`)).body.orders.some((x) => x.order_id === po));
  assert.equal((await s.call('DELETE', `${B}/margin/orders/${po}`)).body.order.status, 'canceled');
  assert.ok(Number((await s.call('GET', `${B}/margin/balance`)).body.available_dollars) > 0);
});

test('public WebSocket: signed upgrade, public and private channels with contiguous seq, commands, caps, flag, revocation', async () => {
  const carol = await H.user('carol', { dollars: 1000 });
  const ck = await H.key(carol);
  // Upgrade auth: none, bad signature, skew.
  const none = wrapSocket(new WebSocket(`${H.BASE.replace('http', 'ws')}/trade-api/ws/v2`));
  await assert.rejects(none.opened, (e) => e.status === 401);
  const badWs = new SignedClient(H.BASE, ck.id, ed25519().privateKey).socket();
  await assert.rejects(badWs.opened, (e) => e.status === 401);
  const skewWs = ck.signed.socket('/trade-api/ws/v2', { ts: Date.now() - 20000 });
  await assert.rejects(skewWs.opened, (e) => e.status === 401);
  const ws = ck.signed.socket();
  await ws.opened;
  // Errors: bad JSON, unknown command, unknown channel, orderbook without a market.
  ws.ws.send('not json');
  await ws.waitFor((m) => m.type === 'error' && m.msg.code === 1);
  ws.cmd('dance');
  await ws.waitFor((m) => m.type === 'error' && m.msg.code === 5);
  assert.equal((await ws.subscribe(['telepathy']))[0].msg.code, 8);
  assert.equal((await ws.subscribe(['orderbook_delta']))[0].msg.code, 10);
  const reps = await ws.subscribe(['orderbook_delta', 'ticker', 'trade', 'market_lifecycle_v2', 'fill', 'user_orders', 'order_group_updates', 'market_positions'], { market_ticker: T });
  assert.ok(reps.every((x) => x.type === 'subscribed'), JSON.stringify(reps));
  const sid = (ch) => reps.find((x) => x.msg.channel === ch).msg.sid;
  const snap = await ws.waitFor((m) => m.type === 'orderbook_snapshot' && m.sid === sid('orderbook_delta'));
  assert.equal(snap.seq, 1); assert.equal(snap.msg.market_ticker, T);
  // Carol trades: private fill / order / position, public trade / ticker / deltas with contiguous seq.
  let r = await ck.signed.call('POST', `${B}/portfolio/orders`, { ticker: T, side: 'yes', action: 'buy', count: 1, yes_price: 2 });
  const oid = r.body.order.order_id;
  await ws.waitFor((m) => m.type === 'user_order' && m.msg.order_id === oid);
  r = await ck.signed.call('POST', `${B}/portfolio/orders`, { ticker: T, side: 'yes', action: 'buy', type: 'market', count: 1 });
  await ws.waitFor((m) => m.type === 'fill' && m.msg.order_id === r.body.order.order_id);
  await ws.waitFor((m) => m.type === 'trade' && m.msg.market_ticker === T);
  await ws.waitFor((m) => m.type === 'ticker');
  await ws.waitFor((m) => m.type === 'market_position' && m.msg.market_ticker === T);
  await ck.signed.call('DELETE', `${B}/portfolio/orders/${oid}`);
  await ws.waitFor((m) => m.type === 'orderbook_delta' && m.msg.delta_fp === '-1.00');
  const book = ws.messages.filter((m) => m.sid === sid('orderbook_delta')).map((m) => m.seq);
  assert.deepEqual(book, book.map((_, i) => i + 1), 'orderbook seq is contiguous from 1');
  r = await ck.signed.call('POST', `${B}/portfolio/order_groups`, { contracts_limit: 5 });
  await ws.waitFor((m) => m.type === 'order_group_update' && m.msg.order_group_id === r.body.order_group_id);
  // Another user's activity never reaches Carol's private channels.
  await ak.signed.call('POST', `${B}/portfolio/orders`, { ticker: T, side: 'yes', action: 'buy', count: 1, yes_price: 2, client_order_id: 'alice-private' });
  await sleep(400);
  assert.ok(!ws.messages.some((m) => m.type === 'user_order' && m.msg.client_order_id === 'alice-private'));
  // Lifecycle (admin pauses and reopens the market).
  assert.equal((await admin.call('POST', `/v1/admin/markets/${T}/deactivate`, {})).status, 200);
  await ws.waitFor((m) => m.type === 'market_lifecycle_v2' && m.msg.market_ticker === T);
  assert.equal((await admin.call('POST', `/v1/admin/markets/${T}/activate`, {})).status, 200);
  // update_subscription and list_subscriptions.
  const other = H.q1("SELECT ticker FROM markets WHERE status='active' AND ticker<>? AND mve_collection_ticker IS NULL ORDER BY rowid LIMIT 1", T).ticker;
  const uid = ws.cmd('update_subscription', { sids: [sid('orderbook_delta')], market_tickers: [other], action: 'add_markets' });
  await ws.waitFor((m) => m.id === uid && m.type === 'ok');
  await ws.waitFor((m) => m.type === 'orderbook_snapshot' && m.msg.market_ticker === other);
  const lid = ws.cmd('list_subscriptions');
  const list = await ws.waitFor((m) => m.id === lid && m.type === 'ok');
  assert.deepEqual(list.msg.subscriptions.find((x) => x.sid === sid('orderbook_delta')).market_tickers.sort(), [T, other].sort());
  const un = ws.cmd('unsubscribe', { sids: [sid('ticker')] });
  await ws.waitFor((m) => m.id === un && m.type === 'unsubscribed');
  // Perps on /margin: needs the perps scope.
  const mws = ck.signed.socket('/trade-api/ws/v2/margin');
  await mws.opened;
  assert.equal((await mws.subscribe(['orderbook_delta', 'ticker', 'account'], { market_ticker: 'PLXBTCPERP' })).length, 3);
  await mws.waitFor((m) => m.type === 'orderbook_snapshot' && m.msg.market_ticker === 'PLXBTCPERP');
  mws.close();
  const readKey = await H.key(carol, { scopes: ['read'] });
  await assert.rejects(readKey.signed.socket('/trade-api/ws/v2/margin').opened, (e) => e.status === 403);
  // Connection cap per tier (Basic: 5): the sixth is refused with 429.
  const extra = [];
  for (let i = 0; i < 4; i++) { const x = ck.signed.socket(); await x.opened; extra.push(x); }
  await assert.rejects(ck.signed.socket().opened, (e) => e.status === 429);
  for (const x of extra) x.close();
  // The flag: api.ws off refuses new connections and ends open ones.
  await setFlag('api.ws', false);
  const ended = await ws.closed;
  assert.equal(ended.code, 4401);
  await assert.rejects(ck.signed.socket().opened, (e) => e.status === 403);
  await setFlag('api.ws', true);
  // Revocation signs the key's sockets out at once.
  const w2 = ck.signed.socket(); await w2.opened;
  assert.equal((await carol.call('DELETE', `/v1/users/${carol.uid}/api_keys/${ck.id}`)).status, 200);
  const c2 = await w2.closed;
  assert.equal(c2.code, 4401);
  assert.ok(w2.messages.some((m) => m.type === 'session_revoked'));
});
