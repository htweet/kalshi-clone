'use strict';
// Phase 7 P7.4 (CLONE_SPEC.md §35.12): contract tests generated from the OpenAPI document. Every operation in
// GET /docs/openapi.json is called on the running server with a signed key (or unsigned when public), and the response
// is validated against the documented status and schema by the registry's own validator (server/api-registry.js). An
// operation without a call plan fails the suite, so a new endpoint cannot ship untested. The rendered reference in the
// developer portal (browser) lists exactly the documented operations: docs, validation and tests share one source.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { harness, newPage, eventually } = require('./lib/api-helpers');
const { validate } = require('../server/api-registry');

const H = harness('contract');
let browser; let doc; let alice; let ak; let maker; let mkey; let admin;
const F = {}; // fixtures

before(async () => {
  await H.start();
  browser = await chromium.launch();
  admin = await H.adminClient();
  alice = await H.user('alice', { dollars: 5000 });
  maker = await H.user('maker', { dollars: 5000 });
  ak = await H.key(alice, { label: 'contract' });
  mkey = await H.key(maker, { label: 'maker' });
  for (const id of [ak.id, mkey.id]) assert.equal((await admin.call('PUT', `/v1/admin/api_keys/${id}/tier`, { tier: 'prime', reason: 'contract test headroom' })).status, 200);
  for (const c of [alice, maker]) {
    assert.equal((await c.call('PUT', `/v1/users/${c.uid}/properties`, { properties: { rfq_enabled: true } })).status, 200);
    assert.equal((await c.call('POST', '/v1/perps/transfers', { direction: 'to_perps', amount_dollars: 1000 })).status, 201);
  }
  doc = await (await fetch(`${H.BASE}/docs/openapi.json`)).json();
  F.ticker = H.openMarket();
  const m = H.q1('SELECT m.event_ticker, e.series_ticker FROM markets m JOIN events e ON e.ticker=m.event_ticker WHERE m.ticker=?', F.ticker);
  F.event = m.event_ticker; F.series = m.series_ticker;
  F.perp = 'PLXBTCPERP';
  // Distinct markets for the RFQ fixtures: a user may have one open RFQ per market.
  [F.t2, F.t3, F.t4, F.t5] = H.q("SELECT ticker FROM markets WHERE status='active' AND ticker<>? AND mve_collection_ticker IS NULL AND market_type='binary' ORDER BY rowid LIMIT 4", F.ticker).map((x) => x.ticker);
  F.mark = Number((await ak.signed.call('GET', `/trade-api/v2/margin/markets/${F.perp}`)).body.market.mark_price);
  const s = ak.signed;
  const order = async (price = 2) => (await s.call('POST', '/trade-api/v2/portfolio/orders', { ticker: F.ticker, side: 'yes', action: 'buy', count: 2, yes_price: price })).body.order.order_id;
  F.o1 = await order(); F.o2 = await order(); F.o3 = await order(3);
  await s.call('POST', '/trade-api/v2/portfolio/orders', { ticker: F.ticker, side: 'yes', action: 'buy', type: 'market', count: 1 }); // a fill
  F.g1 = (await s.call('POST', '/trade-api/v2/portfolio/order_groups', { contracts_limit: 5 })).body.order_group_id;
  F.g2 = (await s.call('POST', '/trade-api/v2/portfolio/order_groups', { contracts_limit: 5 })).body.order_group_id;
  const rfq = async () => (await s.call('POST', '/trade-api/v2/communications/rfqs', { market_ticker: F.ticker, contracts_fp: '2.00' })).body.id;
  F.rfq1 = await rfq();
  F.q1 = (await maker.call('POST', '/v1/communications/quotes', { rfq_id: F.rfq1, yes_bid: '0.40', no_bid: '0.40' })).body.id;
  F.rfq2 = (await maker.call('POST', '/v1/communications/rfqs', { market_ticker: F.t2, contracts_fp: '1.00' })).body.id;
  F.q2 = (await s.call('POST', '/trade-api/v2/communications/quotes', { rfq_id: F.rfq2, yes_bid: '0.30', no_bid: '0.30' })).body.id;
  const po = async (k = ak) => (await k.signed.call('POST', '/trade-api/v2/margin/orders', { ticker: F.perp, side: 'bid', type: 'limit', price: (F.mark * 0.9).toFixed(4), count: 2, leverage: 2 })).body.order_id;
  F.p1 = await po(); F.p2 = await po();
  await s.call('POST', '/trade-api/v2/margin/orders', { ticker: F.perp, side: 'bid', type: 'market', count: 1, leverage: 2 }); // a position to close
  F.pg1 = (await s.call('POST', '/trade-api/v2/margin/order_groups', { kind: 'limit', contracts_limit: 5 })).body.order_group_id;
  F.pg2 = (await s.call('POST', '/trade-api/v2/margin/order_groups', { kind: 'limit', contracts_limit: 5 })).body.order_group_id;
  F.coll = 'PLXCOMBO';
});
after(async () => { await browser?.close(); await H.stop(); H.cleanup(); });

// Per operation: path parameters, query, body, and who calls (default: Alice's key; 'maker'; 'public').
const plan = () => ({
  get_exchange_status: {}, get_exchange_schedule: {}, get_exchange_announcements: {},
  get_markets: { query: { limit: 3, status: 'open' } }, get_trades: { query: { ticker: F.ticker, limit: 5 } }, get_market: { params: { ticker: F.ticker } },
  get_market_orderbook: { params: { ticker: F.ticker }, query: { depth: 5 } }, get_events: { query: { limit: 3, with_nested_markets: 'true' } }, get_event: { params: { ticker: F.event } },
  get_series_list: {}, get_series: { params: { ticker: F.series } },
  get_market_candlesticks: { params: { series_ticker: F.series, ticker: F.ticker }, query: { period_interval: 60 } },
  get_historical_trades: { query: { ticker: F.ticker, min_ts: Math.floor(Date.now() / 1000) - 3600 } }, get_historical_market_candlesticks: { params: { ticker: F.ticker }, query: { period_interval: 1440 } },
  get_account_limits: {}, get_account_endpoint_costs: {},
  get_balance: {}, get_positions: {}, get_orders: { query: { limit: 2 } }, get_order_queue_positions: {},
  batch_create_orders: { body: { orders: [{ ticker: F.ticker, side: 'yes', action: 'buy', count: 1, yes_price: 2 }, { ticker: 'NOPE', side: 'yes', action: 'buy', count: 1, yes_price: 2 }] } },
  batch_cancel_orders: { body: { ids: [F.o3, 'o_missing'] } },
  create_order: { body: { ticker: F.ticker, side: 'no', action: 'buy', type: 'limit', count: 1, no_price: 3 } },
  get_order: { params: { order_id: F.o1 } }, get_order_queue_position: { params: { order_id: F.o1 } },
  cancel_order: { params: { order_id: F.o2 } }, amend_order: { params: { order_id: F.o1 }, body: { yes_price: 4 } }, decrease_order: { params: { order_id: F.o1 }, body: { reduce_by: 1 } },
  get_fills: { query: { limit: 5 } }, get_settlements: {},
  get_order_groups: {}, create_order_group: { body: { contracts_limit: 3 } }, get_order_group: { params: { order_group_id: F.g1 } },
  delete_order_group: { params: { order_group_id: F.g2 } }, reset_order_group: { params: { order_group_id: F.g1 } },
  get_communications_id: {}, get_rfqs: {}, create_rfq: { body: { market_ticker: F.t3, contracts_fp: '1.00' } }, get_rfq: { params: { rfq_id: F.rfq1 } },
  delete_rfq: { params: { rfq_id: 'LATER_RFQ' } }, get_quotes: {}, create_quote: { who: 'maker', body: { rfq_id: 'QUOTE_RFQ', yes_bid: '0.35', no_bid: '0.35' } },
  get_quote: { params: { quote_id: F.q1 } }, delete_quote: { params: { quote_id: F.q2 } },
  accept_quote: { params: { quote_id: F.q1 }, body: { accepted_side: 'yes' } }, confirm_quote: { who: 'maker', params: { quote_id: F.q1 }, body: {} },
  get_multivariate_event_collections: {}, get_multivariate_event_collection: { params: { collection_ticker: F.coll } },
  create_market_in_multivariate_event_collection: { params: { collection_ticker: F.coll }, body: { selected_markets: [{ market_ticker: 'PLXCOIN-26DEC-T5', side: 'yes' }, { market_ticker: 'PLXRATE-26DEC-CUT', side: 'yes' }] } },
  get_margin_markets: {}, get_margin_market: { params: { ticker: F.perp } }, get_margin_orderbook: { params: { ticker: F.perp } }, get_margin_trades: { params: { ticker: F.perp } },
  get_margin_balance: {}, get_margin_positions: {}, get_margin_orders: { query: { status: 'resting' } },
  create_margin_order: { body: { ticker: F.perp, side: 'bid', type: 'limit', price: (F.mark * 0.85).toFixed(4), count: 1, leverage: 2 } },
  get_margin_order: { params: { order_id: F.p1 } }, cancel_margin_order: { params: { order_id: F.p2 } },
  amend_margin_order: { params: { order_id: F.p1 }, body: { price: (F.mark * 0.88).toFixed(4) } }, decrease_margin_order: { params: { order_id: 'AMENDED_P1' }, body: { reduce_by: 1 } },
  close_margin_position: { params: { ticker: F.perp }, body: { percent: 100 } }, get_margin_fills: {}, get_margin_order_groups: {},
  create_margin_order_group: { body: { kind: 'oco' } }, delete_margin_order_group: { params: { order_group_id: F.pg2 } }, reset_margin_order_group: { params: { order_group_id: F.pg1 } },
});

test('every documented operation answers its documented status with a body that matches its schema', async () => {
  const P = plan();
  const ops = [];
  for (const [path, item] of Object.entries(doc.paths)) for (const [m, o] of Object.entries(item)) ops.push({ path, method: m.toUpperCase(), o });
  const ids = ops.map((x) => x.o.operationId);
  assert.deepEqual(ids.filter((id) => !P[id]), [], 'operations without a contract-test plan');
  assert.deepEqual(Object.keys(P).filter((id) => !ids.includes(id)), [], 'plans for operations that are not documented');
  // Order: reads first, then writes in declaration order (a cancel / delete only touches its own fixture).
  const later = { LATER_RFQ: null, QUOTE_RFQ: null, AMENDED_P1: null };
  const failures = [];
  const results = [];
  for (const x of [...ops.filter((y) => y.method === 'GET'), ...ops.filter((y) => y.method !== 'GET')]) {
    const id = x.o.operationId; const spec = P[id];
    if (spec.params && Object.values(spec.params).includes('LATER_RFQ')) later.LATER_RFQ = later.LATER_RFQ || (await ak.signed.call('POST', '/trade-api/v2/communications/rfqs', { market_ticker: F.t4, contracts_fp: '1.00' })).body.id;
    if (spec.body && spec.body.rfq_id === 'QUOTE_RFQ') later.QUOTE_RFQ = (await ak.signed.call('POST', '/trade-api/v2/communications/rfqs', { market_ticker: F.t5, contracts_fp: '1.00' })).body.id;
    if (spec.params && Object.values(spec.params).includes('AMENDED_P1')) later.AMENDED_P1 = H.q1("SELECT id FROM perp_orders WHERE user_id=? AND status='resting' ORDER BY created_ts DESC LIMIT 1", alice.uid).id;
    const fill = (v) => (typeof v === 'string' && v in later ? later[v] : v);
    let p = x.path;
    for (const [k, v] of Object.entries(spec.params || {})) p = p.replace(`{${k}}`, encodeURIComponent(fill(v)));
    assert.ok(!/\{/.test(p), `${id}: unfilled path parameter in ${p}`);
    const qs = new URLSearchParams(Object.entries(spec.query || {}).map(([k, v]) => [k, String(v)])).toString();
    const url = `/trade-api/v2${p}${qs ? `?${qs}` : ''}`;
    const body = spec.body ? JSON.parse(JSON.stringify(spec.body, (k, v) => fill(v))) : undefined;
    const keyed = (x.o.security || []).length > 0;
    const client = spec.who === 'maker' ? mkey.signed : ak.signed;
    const r = keyed || spec.who !== 'public' ? await client.call(x.method, url, body) : await fetch(H.BASE + url).then(async (z) => ({ status: z.status, body: await z.json() }));
    const want = Object.keys(x.o.responses).find((c) => Number(c) < 300);
    const schema = x.o.responses[want].content['application/json'].schema;
    results.push(id);
    if (String(r.status) !== want) { failures.push(`${id} ${x.method} ${url}: status ${r.status}, documented ${want}: ${JSON.stringify(r.body).slice(0, 300)}`); continue; }
    const errs = validate(schema, r.body, doc.components.schemas);
    if (errs.length) failures.push(`${id}: ${errs.slice(0, 5).join('; ')}`);
  }
  assert.deepEqual(failures, [], `${failures.length} contract failure(s)`);
  assert.equal(results.length, ids.length);
  // Error envelopes are documented too: an unsigned private call and an unknown market.
  const unauth = await fetch(`${H.BASE}/trade-api/v2/portfolio/balance`).then((z) => z.json());
  assert.deepEqual(validate({ $ref: '#/components/schemas/Error' }, unauth, doc.components.schemas), []);
  const pe = await fetch(`${H.BASE}/trade-api/v2/markets?limit=abc`).then((z) => z.json());
  assert.deepEqual(validate({ $ref: '#/components/schemas/ParamError' }, pe, doc.components.schemas), []);
});

test('the validator rejects responses that break the schema (it is not vacuous)', () => {
  const S = doc.components.schemas;
  assert.ok(validate({ $ref: '#/components/schemas/Order' }, { order_id: 'x' }, S).length > 0);
  assert.ok(validate({ $ref: '#/components/schemas/Market' }, { ticker: 'X', event_ticker: 'E', title: 't', status: 'weird', yes_bid_dollars: null, yes_ask_dollars: null, last_price_dollars: null, volume_fp: '1.00', price_level_structure: 'linear_cent' }, S).some((e) => /status/.test(e)));
  assert.ok(validate({ $ref: '#/components/schemas/Trade' }, { trade_id: 't', ticker: 'X', yes_price_dollars: '0.5', no_price_dollars: '0.5000', count_fp: '1.00', taker_side: 'yes', created_time: 'now' }, S).length >= 2);
});

test('the portal\'s rendered reference lists exactly the documented operations (browser)', async () => {
  const page = await newPage(browser);
  const shown = new Set();
  for (const tab of ['predictions', 'perps']) {
    await page.goto(`${H.BASE}/docs/${tab}`);
    await page.waitForSelector(`[data-testid=docs-reference][data-product=${tab}]`);
    for (const id of await page.locator('[data-testid=ref-op]').evaluateAll((els) => els.map((e) => e.dataset.op))) shown.add(id);
  }
  const ids = Object.values(doc.paths).flatMap((pp) => Object.values(pp).map((o) => o.operationId));
  assert.deepEqual([...shown].sort(), [...ids].sort());
  await page.goto(`${H.BASE}/docs/reference/get_markets`);
  await eventually(async () => assert.match(await page.textContent('[data-testid=ref-path]'), /\/trade-api\/v2\/markets/));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
