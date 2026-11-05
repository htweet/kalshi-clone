'use strict';
// One route registry for the public trading API (PLAN P7.3/P7.4, CLONE_SPEC.md §35.6). Every Trade API v2 operation is
// declared once — method, path, tag, product, auth (public or a signed key with scopes), token cost, query / body /
// response schemas and the handler — and from that single declaration come:
//   - the Express routes (server/trade-api.js mounts them on the /trade-api/v2 router),
//   - request checks (query parameter types and ranges with the observed {msg} envelope, body shape),
//   - the OpenAPI 3.1 document (GET /docs/openapi.json) and the reference pages of the developer portal,
//   - the contract tests (tests/api-contract.e2e.test.js validates live responses against the response schemas).
// The WebSocket channels (server/trade-ws.js) are declared the same way and give the AsyncAPI 2.6 document.
//
// Schemas are a JSON Schema subset that the small validator below understands: type (or a list of types), properties,
// required, additionalProperties (false only), items, enum, minimum, maximum, minLength, maxLength, pattern, $ref to
// #/components/schemas/*. No external validator dependency.

// ------------------------------------------------------------------------------------------------ schema helpers
const str = (extra = {}) => ({ type: 'string', ...extra });
const strN = (extra = {}) => ({ type: ['string', 'null'], ...extra });
const int = (extra = {}) => ({ type: 'integer', ...extra });
const num = (extra = {}) => ({ type: 'number', ...extra });
const numN = () => ({ type: ['number', 'null'] });
const bool = () => ({ type: 'boolean' });
const arr = (items, extra = {}) => ({ type: 'array', items, ...extra });
const obj = (properties, required = [], extra = {}) => ({ type: 'object', properties, required, ...extra });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const DOLLARS = '^-?\\d+\\.\\d{4}$';
const FP = '^-?\\d+\\.\\d{2}$';
const dollarsS = () => str({ pattern: DOLLARS, description: 'dollar amount, 4 decimals' });
const dollarsN = () => strN({ pattern: DOLLARS });
const fpS = () => str({ pattern: FP, description: 'contracts, 2 decimals (fixed point)' });
const fpN = () => strN({ pattern: FP });
const time = () => str({ format: 'date-time' });
const timeN = () => strN({ format: 'date-time' });
const cursor = () => str({ description: 'opaque cursor; empty when there are no more results' });

const COMPONENTS = {
  Error: obj({ error: obj({ code: str(), message: str(), details: {}, reason: str() }, ['code', 'message']) }, ['error']),
  ParamError: obj({ msg: str() }, ['msg']),
  ExchangeStatus: obj({ exchange_active: bool(), trading_active: bool() }, ['exchange_active', 'trading_active']),
  Market: obj({
    ticker: str(), event_ticker: str(), market_type: str({ enum: ['binary', 'scalar'] }), title: str(), yes_sub_title: str(), no_sub_title: str(),
    status: str({ enum: ['initialized', 'active', 'inactive', 'closed', 'determined', 'finalized'] }), result: strN(), open_time: time(), close_time: time(),
    yes_bid_dollars: dollarsN(), yes_ask_dollars: dollarsN(), no_bid_dollars: dollarsN(), no_ask_dollars: dollarsN(), last_price_dollars: dollarsN(),
    volume_fp: fpS(), open_interest_fp: fpS(), notional_value_dollars: dollarsS(), price_level_structure: str(), price_ranges: arr(obj({ start: str(), end: str(), step: str() })),
    tick_size_dollars: dollarsS(), fractional_trading_enabled: bool(),
  }, ['ticker', 'event_ticker', 'title', 'status', 'yes_bid_dollars', 'yes_ask_dollars', 'last_price_dollars', 'volume_fp', 'price_level_structure']),
  Event: obj({ event_ticker: str(), series_ticker: str(), title: str(), sub_title: str(), category: str(), mutually_exclusive: bool(), collateral_return_type: str(), markets: arr(ref('Market')) },
    ['event_ticker', 'series_ticker', 'title', 'category', 'mutually_exclusive']),
  Series: obj({ ticker: str(), title: str(), category: str(), tags: arr(str()), frequency: str(), fee_type: str(), fee_multiplier: num(), settlement_sources: arr({ type: 'object' }) },
    ['ticker', 'title', 'category', 'frequency', 'fee_type']),
  Trade: obj({ trade_id: str(), ticker: str(), yes_price_dollars: dollarsS(), no_price_dollars: dollarsS(), count_fp: fpS(), taker_side: str({ enum: ['yes', 'no'] }), created_time: time() },
    ['trade_id', 'ticker', 'yes_price_dollars', 'no_price_dollars', 'count_fp', 'taker_side', 'created_time']),
  Orderbook: obj({ orderbook_fp: obj({ yes_dollars: arr(arr(str(), { minItems: 2, maxItems: 2 })), no_dollars: arr(arr(str(), { minItems: 2, maxItems: 2 })) }, ['yes_dollars', 'no_dollars']), price_level_structure: str(), tick_size_dollars: dollarsS() },
    ['orderbook_fp', 'price_level_structure']),
  Candlestick: obj({ end_period_ts: int(), price: obj({ open_dollars: dollarsN(), high_dollars: dollarsN(), low_dollars: dollarsN(), close_dollars: dollarsN(), mean_dollars: dollarsN(), previous_dollars: dollarsN() }, ['open_dollars', 'close_dollars']), volume_fp: fpS() },
    ['end_period_ts', 'price', 'volume_fp']),
  Order: obj({
    order_id: str(), client_order_id: strN(), ticker: str(), side: str({ enum: ['yes', 'no'] }), action: str({ enum: ['buy', 'sell'] }), type: str({ enum: ['limit', 'market'] }),
    status: str({ enum: ['resting', 'executed', 'canceled'] }), yes_price_dollars: dollarsS(), no_price_dollars: dollarsS(), initial_count_fp: fpS(), fill_count_fp: fpS(), remaining_count_fp: fpS(),
    taker_fees_dollars: dollarsS(), expiration_time: timeN(), order_group_id: strN(), source: str(), cancel_reason: strN(), created_time: time(), last_update_time: time(),
  }, ['order_id', 'ticker', 'side', 'action', 'type', 'status', 'yes_price_dollars', 'no_price_dollars', 'initial_count_fp', 'fill_count_fp', 'remaining_count_fp', 'created_time']),
  Fill: obj({ fill_id: str(), order_id: str(), trade_id: str(), ticker: str(), side: str({ enum: ['yes', 'no'] }), action: str({ enum: ['buy', 'sell'] }), yes_price_dollars: dollarsS(), no_price_dollars: dollarsS(),
    count_fp: fpS(), is_taker: bool(), fee_dollars: dollarsS(), created_time: time() }, ['fill_id', 'order_id', 'ticker', 'side', 'action', 'yes_price_dollars', 'count_fp', 'is_taker', 'created_time']),
  MarketPosition: obj({ ticker: str(), position_fp: fpS(), side: strN(), market_exposure_dollars: dollarsS(), total_traded_dollars: dollarsS(), realized_pnl_dollars: dollarsS(), fees_paid_dollars: dollarsS(), resting_orders_count: int() },
    ['ticker', 'position_fp', 'market_exposure_dollars', 'realized_pnl_dollars']),
  Settlement: obj({ ticker: str(), market_result: str(), yes_count_fp: fpS(), no_count_fp: fpS(), revenue_dollars: dollarsS(), cost_dollars: dollarsS(), settled_time: time() },
    ['ticker', 'market_result', 'yes_count_fp', 'no_count_fp', 'revenue_dollars', 'settled_time']),
  OrderGroup: obj({ order_group_id: str(), contracts_limit_fp: fpS(), filled_count_fp: fpS(), status: str({ enum: ['active', 'triggered', 'deleted', 'reset'] }), is_auto_cancel_enabled: bool(), open_orders: int(), created_time: time() },
    ['order_group_id', 'contracts_limit_fp', 'status', 'is_auto_cancel_enabled']),
  BatchCreateResult: obj({ client_order_id: strN(), order: { anyOf: [ref('Order'), { type: 'null' }] }, error: { anyOf: [ref('Error'), { type: 'null' }] } }, ['order', 'error']),
  BatchCancelResult: obj({ order_id: str(), order: { type: ['object', 'null'] }, reduced_by_fp: fpN(), error: { type: ['object', 'null'] } }, ['order_id', 'order', 'error']),
  RateLimits: obj({ tier: str(), tier_label: str(), read: obj({ tokens_per_second: int(), bucket_capacity: int(), available_tokens: int() }, ['tokens_per_second', 'bucket_capacity']), write: obj({ tokens_per_second: int(), bucket_capacity: int(), available_tokens: int() }, ['tokens_per_second', 'bucket_capacity']), websocket_connections: int(), fix_sessions: int() },
    ['tier', 'read', 'write', 'websocket_connections']),
  Rfq: obj({ id: str(), market_ticker: str(), status: str(), contracts_fp: fpS(), created_ts: { type: ['integer', 'string'] } }, ['id', 'market_ticker', 'status']),
  Quote: obj({ id: str(), rfq_id: str(), status: str() }, ['id', 'rfq_id', 'status']),
  MultivariateCollection: obj({ collection_ticker: str(), title: str() }, ['collection_ticker']),
  PerpMarket: obj({ ticker: str(), title: str(), status: str(), contract_size: str(), max_leverage: num(), maker_fee_rate: num(), taker_fee_rate: num(), next_funding_time: time() }, ['ticker', 'title', 'status', 'contract_size', 'max_leverage']),
  PerpOrder: obj({ order_id: str(), ticker: str(), subaccount: int(), side: str({ enum: ['bid', 'ask'] }), type: str(), price: strN(), count: str(), fill_count: str(), remaining_count: str(), status: str(), leverage: numN(), order_group_id: strN(), created_time: time() },
    ['order_id', 'ticker', 'side', 'status', 'count', 'remaining_count', 'created_time']),
  PerpPosition: obj({ market_ticker: str(), subaccount: int(), side: str({ enum: ['long', 'short', 'flat'] }), position_fp: str(), entry_price: strN(), mark_price: strN(), unrealized_pnl: strN() }, ['market_ticker', 'subaccount', 'side', 'position_fp']),
  PerpFill: obj({ fill_id: str(), order_id: str(), ticker: str(), side: str(), count: str(), price: strN(), created_time: time() }, ['fill_id', 'order_id', 'ticker', 'side', 'count', 'created_time']),
  PerpOrderGroup: obj({ order_group_id: str(), kind: str(), status: str() }, ['order_group_id', 'kind', 'status']),
  PerpBalance: obj({ subaccount: int(), available_dollars: str(), account_equity: str(), subaccount_balances: arr({ type: 'object' }) }, ['subaccount', 'available_dollars', 'account_equity']),
};

// ------------------------------------------------------------------------------------------------ validator
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const typeOk = (want, v) => { const t = typeOf(v); return want === t || (want === 'number' && t === 'integer'); };
// Returns a list of "path: problem" strings (empty when valid).
function validate(schema, value, components = COMPONENTS, at = '$', out = [], depth = 0) {
  if (depth > 40 || !schema || typeof schema !== 'object') return out;
  if (schema.$ref) {
    const name = schema.$ref.replace('#/components/schemas/', '');
    if (!components[name]) { out.push(`${at}: unknown $ref ${schema.$ref}`); return out; }
    return validate(components[name], value, components, at, out, depth + 1);
  }
  const alts = schema.anyOf || schema.oneOf;
  if (alts) {
    const tries = alts.map((a) => validate(a, value, components, at, [], depth + 1));
    if (!tries.some((x) => !x.length)) out.push(...tries.sort((a, b) => a.length - b.length)[0]);
    return out;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(t, value))) { out.push(`${at}: expected ${types.join('|')}, got ${typeOf(value)}`); return out; }
  }
  if (value === null) return out;
  if (schema.enum && !schema.enum.includes(value)) out.push(`${at}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`);
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) out.push(`${at}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
    if (schema.minLength != null && value.length < schema.minLength) out.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength != null && value.length > schema.maxLength) out.push(`${at}: longer than ${schema.maxLength}`);
    if (schema.format === 'date-time' && !Number.isFinite(Date.parse(value))) out.push(`${at}: not a date-time`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) out.push(`${at}: below ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) out.push(`${at}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) out.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) out.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => validate(schema.items, v, components, `${at}[${i}]`, out, depth + 1));
  } else if (value && typeof value === 'object') {
    for (const k of schema.required || []) if (!(k in value)) out.push(`${at}: missing ${k}`);
    for (const [k, sub] of Object.entries(schema.properties || {})) if (k in value) validate(sub, value[k], components, `${at}.${k}`, out, depth + 1);
    if (schema.additionalProperties === false) for (const k of Object.keys(value)) if (!(schema.properties || {})[k]) out.push(`${at}: unexpected property ${k}`);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ registry
function createRegistry() {
  const ops = [];
  const channels = [];
  // def: { id, method, path ('/markets/{ticker}'), tag, product, summary, description, auth: 'public'|'key', scopes,
  //        bucket: 'read'|'write', cost, query: [{name, schema, description, required}], body, response, status, handler }
  function op(def) {
    const d = { product: 'predictions', auth: 'public', scopes: [], bucket: def.method === 'GET' ? 'read' : 'write', cost: 10, query: [], status: 200, ...def };
    if (d.auth === 'key' && !d.scopes.length) d.scopes = [d.bucket === 'write' ? 'trade' : 'read'];
    d.expressPath = d.path.replace(/\{([A-Za-z_]+)\}/g, ':$1');
    d.pathParams = [...d.path.matchAll(/\{([A-Za-z_]+)\}/g)].map((m) => m[1]);
    ops.push(d);
    return d;
  }
  const channel = (def) => { channels.push(def); return def; };

  function openapi({ servers = [], info = {} } = {}) {
    const paths = {};
    for (const d of ops) {
      const p = (paths[d.path] = paths[d.path] || {});
      const params = [
        ...d.pathParams.map((n) => ({ name: n, in: 'path', required: true, schema: { type: 'string' } })),
        ...d.query.map((q) => ({ name: q.name, in: 'query', required: !!q.required, description: q.description || undefined, schema: q.schema })),
      ];
      const responses = {
        [String(d.status)]: { description: 'OK', content: { 'application/json': { schema: d.response } } },
        400: { description: 'Bad request (`{error}`), or `{msg}` for an unparseable or out-of-range query parameter', content: { 'application/json': { schema: { oneOf: [ref('Error'), ref('ParamError')] } } } },
        404: { description: 'Not found', content: { 'application/json': { schema: ref('Error') } } },
        429: { description: 'Rate limited (Retry-After header)', content: { 'application/json': { schema: ref('Error') } } },
      };
      if (d.auth === 'key') {
        responses[401] = { description: 'token_authentication_failure (missing, malformed, skewed, replayed or invalid signature; revoked or expired key)', content: { 'application/json': { schema: ref('Error') } } };
        responses[403] = { description: 'Missing scope, IP not allowed, or feature_disabled', content: { 'application/json': { schema: ref('Error') } } };
      }
      p[d.method.toLowerCase()] = {
        operationId: d.id, tags: [d.tag], summary: d.summary, description: d.description || undefined, parameters: params.length ? params : undefined,
        requestBody: d.body ? { required: true, content: { 'application/json': { schema: d.body } } } : undefined,
        responses,
        security: d.auth === 'key' ? [{ ParlanceAccessKey: [], ParlanceAccessTimestamp: [], ParlanceAccessSignature: [] }] : [],
        'x-parlance-product': d.product, 'x-parlance-scopes': d.scopes, 'x-parlance-token-cost': d.cost, 'x-parlance-bucket': d.bucket,
      };
    }
    return {
      openapi: '3.1.0',
      info: { title: 'Parlance Exchange Trade API', version: '2.0.0', description: 'Public REST API for event contracts (Predictions) and perpetual futures (Perps). Generated from the server route registry.', ...info },
      servers,
      tags: [...new Set(ops.map((d) => d.tag))].map((name) => ({ name })),
      paths,
      components: {
        schemas: COMPONENTS,
        securitySchemes: {
          ParlanceAccessKey: { type: 'apiKey', in: 'header', name: 'PARLANCE-ACCESS-KEY', description: 'The API key id.' },
          ParlanceAccessTimestamp: { type: 'apiKey', in: 'header', name: 'PARLANCE-ACCESS-TIMESTAMP', description: 'Request time in unix milliseconds.' },
          ParlanceAccessSignature: { type: 'apiKey', in: 'header', name: 'PARLANCE-ACCESS-SIGNATURE', description: 'base64 signature over timestamp + METHOD + path (no query string): RSA-PSS SHA-256 (salt length 32) or Ed25519.' },
        },
      },
    };
  }

  function asyncapi({ servers = {} } = {}) {
    const ch = {};
    const messages = {};
    for (const c of channels) {
      const msgs = c.messages.map((m) => { messages[m.name] = { name: m.name, title: m.name, summary: m.summary, payload: obj({ type: str({ enum: [m.name] }), sid: int(), seq: int(), msg: m.payload }, ['type', 'sid', 'msg']) }; return { $ref: `#/components/messages/${m.name}` }; });
      ch[`${c.path}#${c.name}`] = {
        description: c.description,
        subscribe: { operationId: `${c.product}_${c.name}`, summary: c.summary, message: msgs.length === 1 ? msgs[0] : { oneOf: msgs } },
        bindings: { ws: { method: 'GET' } },
        'x-parlance-auth': c.private ? 'private (the connection key\'s own data)' : 'public', 'x-parlance-product': c.product, 'x-parlance-channel': c.name, 'x-parlance-params': c.params || [],
      };
    }
    messages.subscribe = { name: 'subscribe', payload: obj({ id: int(), cmd: str({ enum: ['subscribe'] }), params: obj({ channels: arr(str()), market_ticker: str(), market_tickers: arr(str()) }, ['channels']) }, ['id', 'cmd', 'params']) };
    messages.unsubscribe = { name: 'unsubscribe', payload: obj({ id: int(), cmd: str({ enum: ['unsubscribe'] }), params: obj({ sids: arr(int()) }, ['sids']) }, ['id', 'cmd', 'params']) };
    messages.update_subscription = { name: 'update_subscription', payload: obj({ id: int(), cmd: str({ enum: ['update_subscription'] }), params: obj({ sids: arr(int()), market_tickers: arr(str()), action: str({ enum: ['add_markets', 'delete_markets'] }) }, ['sids', 'action']) }, ['id', 'cmd', 'params']) };
    messages.list_subscriptions = { name: 'list_subscriptions', payload: obj({ id: int(), cmd: str({ enum: ['list_subscriptions'] }) }, ['id', 'cmd']) };
    messages.subscribed = { name: 'subscribed', payload: obj({ id: int(), type: str({ enum: ['subscribed'] }), msg: obj({ channel: str(), sid: int() }, ['channel', 'sid']) }, ['type', 'msg']) };
    messages.error = { name: 'error', payload: obj({ id: int(), type: str({ enum: ['error'] }), msg: obj({ code: int(), msg: str() }, ['code', 'msg']) }, ['type', 'msg']) };
    ch['/trade-api/ws/v2#commands'] = { description: 'Client commands (both paths) and their replies.', publish: { operationId: 'commands', message: { oneOf: ['subscribe', 'unsubscribe', 'update_subscription', 'list_subscriptions'].map((n) => ({ $ref: `#/components/messages/${n}` })) } }, subscribe: { operationId: 'replies', message: { oneOf: ['subscribed', 'error'].map((n) => ({ $ref: `#/components/messages/${n}` })) } } };
    return {
      asyncapi: '2.6.0',
      info: { title: 'Parlance Exchange WebSocket API', version: '2.0.0', description: 'Public WebSocket API. Connect to /trade-api/ws/v2 (Predictions) or /trade-api/ws/v2/margin (Perps) with the same signed headers as REST (method GET, the WebSocket path). Generated from the server channel registry.' },
      servers,
      defaultContentType: 'application/json',
      channels: ch,
      components: { messages, schemas: COMPONENTS },
    };
  }

  // Query parameter checks from the declaration. Integers that do not parse, or fall outside min/max, answer the
  // observed {msg} envelope (CLONE_SPEC.md §5.4); enums and other types answer the {error} envelope.
  function checkQuery(d, query, ParamError, badRequest) {
    const name = d.id.replace(/(^|_)([a-z])/g, (m, a, b) => b.toUpperCase());
    for (const q of d.query) {
      const v = query[q.name];
      if (v === undefined || v === '') { if (q.required) throw badRequest(`${q.name} is required`); continue; }
      if (Array.isArray(v)) throw badRequest(`${q.name} must be given once`);
      const sch = q.schema || {};
      if (sch.type === 'integer') {
        if (!/^-?\d+$/.test(String(v))) throw new ParamError(`Invalid format for parameter ${q.name}: error binding string parameter: parsing "${String(v).slice(0, 40)}": invalid syntax`);
        const n = Number(v);
        if ((sch.minimum != null && n < sch.minimum) || (sch.maximum != null && n > sch.maximum)) throw new ParamError(`Parameter validation failed for ${name}: Key: '${name}Params.${q.name[0].toUpperCase()}${q.name.slice(1)}' Error:Field validation for '${q.name}' failed on the '${sch.minimum != null && n < sch.minimum ? 'gte' : 'lte'}' tag`);
      } else if (sch.enum && !sch.enum.includes(String(v))) throw badRequest(`invalid ${q.name} filter`);
      else if (String(v).length > 2000) throw badRequest(`${q.name} is too long`);
    }
  }

  return { ops, channels, op, channel, openapi, asyncapi, checkQuery, components: COMPONENTS };
}

module.exports = { createRegistry, validate, COMPONENTS, str, strN, int, num, numN, bool, arr, obj, ref, dollarsS, dollarsN, fpS, fpN, time, timeN, cursor };
