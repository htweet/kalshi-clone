'use strict';
// Public Trade API v2 (PLAN P7.2, CLONE_SPEC.md §35.5): /trade-api/v2, mirroring the observed Kalshi v2 paths and the
// §5 envelopes, for Predictions and (under /margin) Perps. Every operation is declared once in the route registry
// (server/api-registry.js): that declaration mounts the route, checks the query, charges the key's rate tier, and
// generates the OpenAPI document and the contract tests.
//
// Authentication. `authGate` (mounted on /trade-api before the perimeter rate limiter) verifies a signed request
// (server/api-keys.js) and sets req.apiPrincipal. Session cookies are never credentials here (server/auth.js ignores
// them on /trade-api), so there is no ambient authority and no CSRF surface; and API keys are never credentials on /v1.
// Public market data needs no key (the per-IP perimeter limits apply); a signed request is charged to its key's tier.
//
// One engine, one rule set. State-changing operations do not call the engine directly: they are dispatched internally
// into the same /v1 pipeline the web app uses — step-up guard, feature-flag gate (with the play-mode money controls),
// responsible-trading session limits, body schemas, account locks, Idempotency-Key, identity / location / fraud gate,
// then the /v1 handler — as the key's owner, on an internal request object that external clients cannot construct
// (a fresh object from app.request; the `apiChannel` marker is never read from a client). Responses are mapped to the
// v2 shapes. Reads with cursors query the tables directly through the shared serializers. The FIX gateway
// (server/fix.js) and the batch endpoints use the same dispatch.
//
// Order groups (Predictions): a group has a contracts limit; when the fills of its orders reach the limit, every resting
// order in the group is canceled and the group is `triggered` until reset (no new orders into it). Evaluated after
// each fill (the fill that crosses the limit is not split; the engine is not forked).
const { EventEmitter } = require('node:events');
const { tx } = require('./db');
const { ufp, toUnits, UNITS, ApiError, E, encCursor, decCursor, newId, dollars } = require('./util');
const { marketVo, eventVo, seriesVo } = require('./serialize');
const P = require('./pricing');
const R = require('./api-registry');
const { s } = require('./content/api');

// Observed quirk (spec §5.4): unparseable integer params use a {msg} envelope.
class ParamError extends Error { constructor(msg) { super(msg); this.status = 400; } }
function intParam(q, name, { def, min, max, op = 'GetMarkets' } = {}) {
  if (q[name] === undefined || q[name] === '') return def;
  const s0 = String(q[name]);
  if (!/^-?\d+$/.test(s0)) throw new ParamError(`Invalid format for parameter ${name}: error binding string parameter: parsing "${s0}": invalid syntax`);
  const n = Number(s0);
  if ((min != null && n < min) || (max != null && n > max)) throw new ParamError(`Parameter validation failed for ${op}: Key: '${op}Params.${name[0].toUpperCase()}${name.slice(1)}' Error:Field validation for '${name}' failed on the '${n < min ? 'gte' : 'lte'}' tag`);
  return n;
}

const STATUS_FILTER = { unopened: ['initialized'], open: ['active'], paused: ['inactive'], closed: ['closed', 'determined'], settled: ['finalized'] };
const MAX_BATCH = 20;
const CANCEL_COST = 2;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS order_groups (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, contracts_limit INTEGER NOT NULL, filled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, status_reason TEXT, created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL, triggered_ts INTEGER);
CREATE INDEX IF NOT EXISTS idx_order_groups_user ON order_groups(user_id, status);
CREATE TABLE IF NOT EXISTS order_group_orders (order_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, user_id TEXT NOT NULL, created_ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_order_group_orders_group ON order_group_orders(group_id);
`;

// ------------------------------------------------------------------------------------------------ capture response
// A response object for internal dispatch: the /v1 handlers write to it as they would to Express's res.
function captureRes() {
  const r = new EventEmitter();
  Object.assign(r, {
    statusCode: 200, headers: {}, locals: {}, headersSent: false, done: false, body: undefined, onDone: null,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
    getHeader(k) { return this.headers[String(k).toLowerCase()]; },
    removeHeader(k) { delete this.headers[String(k).toLowerCase()]; return this; },
    set(k, v) { if (k && typeof k === 'object') { for (const [a, b] of Object.entries(k)) this.setHeader(a, b); } else this.setHeader(k, v); return this; },
    header(k, v) { return this.set(k, v); },
    append() { return this; }, vary() { return this; }, cookie() { return this; }, clearCookie() { return this; },
    type(t) { this.setHeader('content-type', t); return this; },
    json(b) { this.body = b; this.finish(); return this; },
    send(b) { if (typeof b === 'string') { try { this.body = JSON.parse(b); } catch { this.body = b; } } else if (Buffer.isBuffer(b)) { try { this.body = JSON.parse(b.toString()); } catch { this.body = null; } } else this.body = b; this.finish(); return this; },
    end(b) { if (b !== undefined && this.body === undefined) this.send(b); else this.finish(); return this; },
    writeHead(c) { this.statusCode = c; return this; },
    finish() { if (this.done) return; this.done = true; this.headersSent = true; if (this.onDone) this.onDone(); this.emit('finish'); this.emit('close'); },
  });
  return r;
}

function mountTradeApi({ app, v2, v1, db, engine, auth, flags, feat, admin, security, apiKeys, ordersApi, eventFull, registry, env = 'main' }) {
  db.exec(SCHEMA);
  const reg = registry;
  const q = engine.quote.bind(engine);
  const getEvent = (t) => db.prepare('SELECT * FROM events WHERE ticker=?').get(t);
  const getSeries = (t) => db.prepare('SELECT * FROM series WHERE ticker=?').get(t);

  // ---------------------------------------------------------------- authentication gate (app.use('/trade-api'))
  // The demo environment also accepts the signature over its public path behind the main site's /demo-api proxy.
  const signedPaths = (req) => { const p = String(req.originalUrl || req.url).split('?')[0]; return env === 'demo' ? [p, `/demo-api${p}`] : [p]; };
  function authGate(req, res, next) {
    if (!/^\/trade-api\/v2(\/|$)/.test(req.originalUrl)) return next();
    try {
      const p = apiKeys.authenticate(req, { paths: signedPaths(req) });
      if (p) { req.apiPrincipal = p; apiKeys.bumpUsage(p.key.id, 'requests', 1, p.ip); }
      next();
    } catch (e) { next(e); }
  }

  // ---------------------------------------------------------------- internal dispatch into the /v1 pipeline
  let chain = null; // [auth.guard, flags.gate, feat.sessionMiddleware, v1] — set by app.js once every module is mounted
  const setChain = (fns) => { chain = fns; };
  // `who`: { user, key? } (a key principal, a FIX session, or null for public reads); `ip`, `headers` from the caller.
  function dispatch(who, method, path, body, { ip = '127.0.0.1', headers = {}, channel = 'api' } = {}) {
    return new Promise((resolve) => {
      const req = Object.create(app.request);
      const hdrs = { 'user-agent': 'parlance-api', ...Object.fromEntries(Object.entries(headers).filter(([, v]) => v != null).map(([k, v]) => [k.toLowerCase(), String(v)])) };
      if (body !== undefined) hdrs['content-type'] = 'application/json';
      const sock = { remoteAddress: ip, encrypted: false };
      Object.assign(req, {
        app, method, url: path, originalUrl: `/v1${path}`, baseUrl: '', headers: hdrs, rawHeaders: [], socket: sock, connection: sock, body: body === undefined ? {} : body, params: {},
        auth: who ? { user: who.user, session: { sid: who.key ? `api:${who.key.id}` : `fix:${who.sessionId || 'x'}`, csrf_token: '', auth_at: 0, totp_at: 0, privileged: 0 }, apiKey: who.key || null } : null,
        apiChannel: channel,
      });
      const res = captureRes();
      req.res = res; res.req = req;
      let settled = false;
      const done = (err) => {
        if (settled) return; settled = true;
        if (err) {
          const e = err instanceof ApiError ? err : err instanceof ParamError ? null : err && err.type === 'entity.parse.failed' ? E.badRequest('malformed JSON body') : null;
          if (err instanceof ParamError) return resolve({ status: 400, body: { msg: err.message }, headers: res.headers });
          if (!e) { console.error('api dispatch', err); return resolve({ status: 500, body: { error: { code: 'internal_server_error', message: 'internal server error' } }, headers: res.headers }); }
          return resolve({ status: e.status, body: e.toJSON(), headers: res.headers });
        }
        resolve({ status: res.statusCode, body: res.body, headers: res.headers });
      };
      res.onDone = () => done();
      let i = 0;
      const step = (err) => {
        if (err) return done(err);
        if (res.done) return undefined;
        const f = chain[i++];
        if (!f) return done(E.notFound());
        try { const r = f(req, res, step); if (r && typeof r.then === 'function') r.catch(step); } catch (e) { done(e); }
        return undefined;
      };
      step();
    });
  }
  const send = (res, r, map = (b) => b) => {
    for (const h of ['retry-after', 'idempotent-replayed']) if (r.headers && r.headers[h]) res.setHeader(h, r.headers[h]);
    res.status(r.status).json(r.status < 400 ? map(r.body) : r.body);
  };

  // ---------------------------------------------------------------- v2 shapes
  const ccOf = (o) => (o.price_cc != null ? o.price_cc : o.price_cents * P.CC_PER_CENT);
  const flip = (side) => (side === 'yes' ? 'no' : 'yes');
  const groupOf = (oid) => db.prepare('SELECT group_id FROM order_group_orders WHERE order_id=?').get(oid)?.group_id || null;
  function orderV2(o) {
    const cc = ccOf(o);
    const yesCc = o.side === 'yes' ? cc : P.CC - cc;
    return {
      order_id: o.id, client_order_id: o.client_order_id || null, ticker: o.market_ticker,
      side: o.action === 'sell' ? flip(o.side) : o.side, action: o.action || 'buy',
      type: o.order_type === 'limit' || (!o.order_type && o.time_in_force !== 'ioc') ? 'limit' : 'market',
      status: o.status, yes_price_dollars: P.ccToDollars(yesCc), no_price_dollars: P.ccToDollars(P.CC - yesCc),
      initial_count_fp: ufp(o.initial_count), fill_count_fp: ufp(o.filled_count), remaining_count_fp: ufp(o.remaining_count),
      taker_fees_dollars: dollars(o.fees_cents), expiration_time: o.expiration_ts ? new Date(o.expiration_ts).toISOString() : null,
      order_group_id: groupOf(o.id), source: o.source || 'user', cancel_reason: o.cancel_reason || null, created_time: o.created_at, last_update_time: o.updated_at,
      ...(o.status === 'resting' ? { queue_position_fp: ufp(engine.queuePosition(o)) } : {}),
    };
  }
  const orderById = (id) => db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  function fillV2(f) {
    const action = f.action || 'buy';
    const cc = f.price_cc != null ? f.price_cc : f.price_cents * P.CC_PER_CENT;
    const yesCc = f.side === 'yes' ? cc : P.CC - cc;
    return { fill_id: f.id, order_id: f.order_id, trade_id: f.trade_id, ticker: f.market_ticker, side: action === 'sell' ? flip(f.side) : f.side, action,
      yes_price_dollars: P.ccToDollars(yesCc), no_price_dollars: P.ccToDollars(P.CC - yesCc), count_fp: ufp(f.count), is_taker: !!f.is_taker, fee_dollars: dollars(f.fee_cents), created_time: new Date(f.created_ts).toISOString() };
  }
  const tradeV2 = (t) => ({ trade_id: t.id, ticker: t.market_ticker, yes_price_dollars: P.ccToDollars(t.yes_price_cc), no_price_dollars: P.ccToDollars(P.CC - t.yes_price_cc), count_fp: ufp(t.count), taker_side: t.taker_side, created_time: new Date(t.created_ts).toISOString() });
  const page = (rows, limit, off) => ({ items: rows.slice(0, limit), cursor: rows.length > limit ? encCursor({ o: off + limit }) : '' });
  const tsRange = (query, col, where, args, unit = 1) => {
    for (const [k, op] of [['min_ts', '>='], ['max_ts', '<=']]) if (query[k] !== undefined && query[k] !== '') { where.push(`${col}${op}?`); args.push(Number(query[k]) * unit); }
  };

  // ---------------------------------------------------------------- order groups (Predictions)
  const groupRow = (id) => db.prepare('SELECT * FROM order_groups WHERE id=?').get(id);
  const groupVo = (g) => ({ order_group_id: g.id, contracts_limit_fp: ufp(g.contracts_limit), filled_count_fp: ufp(g.filled), status: g.status, status_reason: g.status_reason || null,
    is_auto_cancel_enabled: g.status === 'active', open_orders: db.prepare("SELECT COUNT(*) c FROM order_group_orders x JOIN orders o ON o.id=x.order_id WHERE x.group_id=? AND o.status='resting'").get(g.id).c,
    created_time: new Date(g.created_ts).toISOString(), triggered_time: g.triggered_ts ? new Date(g.triggered_ts).toISOString() : null });
  const ownGroup = (uid, id) => { const g = groupRow(String(id || '')); if (!g || g.user_id !== uid || g.status === 'deleted') throw new ApiError(404, 'order_group_not_found', s('group.not_found')); return g; };
  const emitGroup = (g) => engine.emit('api_order_group', g.user_id, groupVo(g));
  const pendingGroup = new Map(); // uid -> group id, while that user's order is being placed (links it before its first fill)
  function link(orderId, uid) {
    const gid = pendingGroup.get(uid);
    if (!gid || db.prepare('SELECT 1 FROM order_group_orders WHERE order_id=?').get(orderId)) return;
    db.prepare('INSERT INTO order_group_orders(order_id,group_id,user_id,created_ts) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(orderId, gid, uid, Date.now());
  }
  function triggerGroup(g, reason) {
    db.prepare("UPDATE order_groups SET status='triggered', status_reason=?, triggered_ts=?, updated_ts=? WHERE id=? AND status='active'").run(reason, Date.now(), Date.now(), g.id);
    for (const o of db.prepare("SELECT o.id FROM order_group_orders x JOIN orders o ON o.id=x.order_id WHERE x.group_id=? AND o.status='resting'").all(g.id)) {
      try { engine.cancelOrder(g.user_id, o.id, 'order_group_triggered'); } catch (e) { void e; }
    }
    emitGroup(groupRow(g.id));
  }
  engine.on('user_order', (uid, o) => { if (pendingGroup.has(uid)) { try { link(o.id, uid); } catch { /* db closed */ } } });
  engine.on('fill', (uid, f) => {
    try {
      if (pendingGroup.has(uid)) link(f.order_id, uid);
      const gid = groupOf(f.order_id);
      if (!gid) return;
      db.prepare("UPDATE order_groups SET filled=filled+?, updated_ts=? WHERE id=? AND status='active'").run(f.count, Date.now(), gid);
      const g = groupRow(gid);
      if (g.status === 'active' && g.filled >= g.contracts_limit) setImmediate(() => { try { triggerGroup(g, 'contracts_limit'); } catch (e) { if (!/not open|closed/i.test(e.message)) console.error('order group', e.message); } });
      else emitGroup(g);
    } catch (e) { if (!/not open|closed/i.test(e.message)) console.error('order group fill', e.message); }
  });

  // ---------------------------------------------------------------- shared order operations (REST, batch, FIX)
  // v2 create-order body → the /v1 order body. Returns { status, body: { order } | error }.
  function v1OrderBody(b) {
    const side = b.side;
    const action = b.action || 'buy';
    if (!['yes', 'no'].includes(side)) throw E.badRequest('side must be yes or no');
    if (!['buy', 'sell'].includes(action)) throw E.badRequest('action must be buy or sell');
    const type = b.type || 'limit';
    if (!['limit', 'market'].includes(type)) throw E.badRequest('type must be limit or market');
    if (b.time_in_force != null && !['good_till_canceled', 'gtc'].includes(b.time_in_force)) throw E.badRequest('time_in_force: only good_till_canceled is supported (use expiration_ts for good-til-time; market orders are immediate-or-cancel)');
    const out = { ticker: String(b.ticker || ''), side, action, type, client_order_id: b.client_order_id == null ? undefined : String(b.client_order_id).slice(0, 64) };
    if (b.count_fp != null) out.count_fp = b.count_fp; else if (b.count != null) out.count = b.count;
    const pick = (dKey, cKey) => (b[dKey] != null && b[dKey] !== '' ? { d: String(b[dKey]) } : b[cKey] != null && b[cKey] !== '' ? { c: b[cKey] } : null);
    const own = side === 'yes' ? pick('yes_price_dollars', 'yes_price') : pick('no_price_dollars', 'no_price');
    const other = side === 'yes' ? pick('no_price_dollars', 'no_price') : pick('yes_price_dollars', 'yes_price');
    if (own && own.d) out.price_dollars = own.d;
    else if (own) out.price = own.c;
    else if (other) {
      const cc = other.d ? P.ccFromDollars(other.d) : P.ccFromCents(other.c);
      if (cc == null) throw E.badRequest('price must be a dollar amount with at most 4 decimals or a number of cents');
      out.price_dollars = P.ccToDollars(P.CC - cc);
    }
    if (type === 'market' && b.buy_max_cost != null && action === 'buy') {
      const cents = Number(b.buy_max_cost);
      if (!Number.isInteger(cents) || cents < 1) throw E.badRequest('buy_max_cost must be a whole number of cents');
      out.type = 'dollars'; out.amount_dollars = (cents / 100).toFixed(2); delete out.count; delete out.count_fp;
    }
    if (b.expiration_ts != null) {
      const t = Number(b.expiration_ts);
      if (!Number.isFinite(t) || t <= 0) throw E.badRequest('expiration_ts must be a unix time in seconds');
      out.expiration_time = new Date(t * 1000).toISOString();
    }
    if (b.post_only === true) out.post_only = true;
    return out;
  }
  async function createOrder(who, b, opts = {}) {
    let body;
    try { body = v1OrderBody(b || {}); } catch (e) { return { status: e.status, body: e.toJSON() }; }
    let gid = null;
    if (b.order_group_id != null) {
      const g = groupRow(String(b.order_group_id));
      if (!g || g.user_id !== who.user.id || g.status === 'deleted') return { status: 404, body: new ApiError(404, 'order_group_not_found', s('group.not_found')).toJSON() };
      if (g.status !== 'active') return { status: 409, body: new ApiError(409, 'order_group_triggered', s('group.triggered')).toJSON() };
      gid = g.id;
    }
    if (gid) pendingGroup.set(who.user.id, gid);
    let r;
    try { r = await dispatch(who, 'POST', `/users/${who.user.id}/orders`, body, opts); } finally { if (gid) pendingGroup.delete(who.user.id); }
    if (r.status >= 400) return r;
    const o = orderById(r.body.order.order_id);
    if (gid && !groupOf(o.id)) db.prepare('INSERT INTO order_group_orders(order_id,group_id,user_id,created_ts) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(o.id, gid, who.user.id, Date.now());
    return { status: 201, body: { order: orderV2(o) }, headers: r.headers };
  }
  async function cancelOrder(who, id, opts = {}) {
    const r = await dispatch(who, 'DELETE', `/users/${who.user.id}/orders/${encodeURIComponent(id)}`, undefined, opts);
    if (r.status >= 400) return r;
    const o = orderById(r.body.order.order_id);
    return { status: 200, body: { order: orderV2(o) } };
  }
  async function amendOrder(who, id, b, opts = {}) {
    const o0 = db.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(String(id), who.user.id);
    if (!o0) return { status: 404, body: E.notFound().toJSON() };
    const body = {};
    const userSide = o0.action === 'sell' ? flip(o0.side) : o0.side;
    const dKey = `${userSide}_price_dollars`; const cKey = `${userSide}_price`;
    if (b[dKey] != null) body.price_dollars = String(b[dKey]); else if (b[cKey] != null) body.price = b[cKey];
    else if (b[`${flip(userSide)}_price_dollars`] != null || b[`${flip(userSide)}_price`] != null) {
      const x = b[`${flip(userSide)}_price_dollars`] != null ? P.ccFromDollars(String(b[`${flip(userSide)}_price_dollars`])) : P.ccFromCents(b[`${flip(userSide)}_price`]);
      if (x == null) return { status: 400, body: E.badRequest('price must be a dollar amount with at most 4 decimals or a number of cents').toJSON() };
      body.price_dollars = P.ccToDollars(P.CC - x);
    }
    if (b.count_fp != null) body.count_fp = b.count_fp; else if (b.count != null) body.count = b.count;
    if (b.expiration_ts !== undefined) body.expiration_time = b.expiration_ts == null ? null : new Date(Number(b.expiration_ts) * 1000).toISOString();
    const r = await dispatch(who, 'POST', `/users/${who.user.id}/orders/${encodeURIComponent(id)}/amend`, body, opts);
    if (r.status >= 400) return r;
    return { status: 200, body: { old_order: orderV2(o0), order: orderV2(orderById(r.body.order.order_id)), queue_priority_kept: !!r.body.queue_priority_kept } };
  }
  async function decreaseOrder(who, id, b, opts = {}) {
    const body = {};
    for (const k of ['reduce_by', 'reduce_to']) if (b[`${k}_fp`] != null) body[k] = b[`${k}_fp`]; else if (b[k] != null) body[k] = b[k];
    const r = await dispatch(who, 'POST', `/users/${who.user.id}/orders/${encodeURIComponent(id)}/decrease`, body, opts);
    if (r.status >= 400) return r;
    return { status: 200, body: { order: orderV2(orderById(r.body.order.order_id)), reduced_by_fp: r.body.reduced_by_fp } };
  }

  // ---------------------------------------------------------------- route wrapper
  const principalOf = (req) => req.apiPrincipal || null;
  const ctxOf = (req) => ({ ip: security ? security.clientIp(req) : req.ip, headers: { 'idempotency-key': req.get('idempotency-key'), 'user-agent': req.get('user-agent') }, channel: 'api' });
  function wrap(d) {
    return async (req, res, next) => {
      const p = principalOf(req);
      try {
        reg.checkQuery(d, req.query, ParamError, E.badRequest);
        if (d.auth === 'key') {
          if (!p) { const e = new ApiError(401, 'token_authentication_failure', 'token authentication failure', s('auth.required')); throw e; }
          apiKeys.requireScopes(p, d.scopes);
          if (d.bucket === 'write' && !flags.on('api.trading', { uid: p.user.id })) throw flags.disabledError('api.trading');
        }
        if (p) apiKeys.charge(p, d.bucket, typeof d.cost === 'function' ? d.cost(req) : d.cost, res);
        await d.handler(req, res, p, ctxOf(req));
        if (p && res.statusCode >= 400) apiKeys.bumpUsage(p.key.id, 'errors');
      } catch (e) { if (p) apiKeys.bumpUsage(p.key.id, 'errors'); next(e); }
    };
  }
  const op = (def) => reg.op(def);
  const who = (p) => ({ user: p.user, key: p.key });
  const passthrough = (method, v1Path) => async (req, res, p, ctx) => send(res, await dispatch(p ? who(p) : null, method, typeof v1Path === 'function' ? v1Path(req, p) : v1Path, method === 'GET' || method === 'DELETE' ? undefined : (req.body || {}), ctx));
  const withQuery = (req, path) => { const i = req.originalUrl.indexOf('?'); return i >= 0 ? `${path}${req.originalUrl.slice(i)}` : path; };
  const qLimit = (desc = 'page size', max = 1000, def = 100) => ({ name: 'limit', schema: R.int({ minimum: 1, maximum: max }), description: `${desc} (1-${max}, default ${def})` });
  const qCursor = { name: 'cursor', schema: R.str(), description: 'cursor from the previous page' };
  const qMinTs = { name: 'min_ts', schema: R.int({ minimum: 0 }), description: 'from this unix time (seconds)' };
  const qMaxTs = { name: 'max_ts', schema: R.int({ minimum: 0 }), description: 'up to this unix time (seconds)' };
  const ok = (props, required) => R.obj(props, required);

  // ================================================================= Exchange (public)
  op({ id: 'get_exchange_status', method: 'GET', path: '/exchange/status', tag: 'exchange', summary: 'Exchange status', response: R.ref('ExchangeStatus'),
    handler: (req, res) => res.json({ exchange_active: true, trading_active: engine.tradingActive }) });
  op({ id: 'get_exchange_schedule', method: 'GET', path: '/exchange/schedule', tag: 'exchange', summary: 'Trading hours and maintenance windows', response: ok({ schedule: ok({ standard_hours: R.arr({ type: 'object' }), maintenance_windows: R.arr({ type: 'object' }) }, ['standard_hours', 'maintenance_windows']) }, ['schedule']),
    handler: (req, res) => {
      const day = [{ open_time: '00:00', close_time: '23:59' }];
      res.json({ schedule: { standard_hours: [{ start_time: '2026-01-01T00:00:00Z', end_time: '2099-12-31T23:59:59Z', ...Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d2) => [d2, day])) }], maintenance_windows: [] } });
    } });
  op({ id: 'get_exchange_announcements', method: 'GET', path: '/exchange/announcements', tag: 'exchange', summary: 'Open incidents from the status page', response: ok({ announcements: R.arr(ok({ id: R.str(), type: R.str(), message: R.str(), status: R.str(), delivery_time: R.str() }, ['id', 'message', 'status'])) }, ['announcements']),
    handler: (req, res) => res.json({ announcements: (app.locals.statusIncidents ? app.locals.statusIncidents() : []).filter((x) => x.status !== 'resolved').map((x) => ({ id: x.id, type: x.impact === 'outage' ? 'error' : 'warning', message: x.title, status: x.status, delivery_time: x.started_time })) }) });

  // ================================================================= Markets, events, series (public)
  op({ id: 'get_markets', method: 'GET', path: '/markets', tag: 'market', summary: 'List markets', query: [qLimit('markets per page', 1000), qCursor, { name: 'status', schema: R.str({ enum: Object.keys(STATUS_FILTER) }) }, { name: 'event_ticker', schema: R.str() }, { name: 'series_ticker', schema: R.str() }],
    response: ok({ cursor: R.cursor(), markets: R.arr(R.ref('Market')) }, ['cursor', 'markets']),
    handler: (req, res) => {
      const limit = intParam(req.query, 'limit', { def: 100, min: 1, max: 1000 });
      const cur = decCursor(req.query.cursor);
      const where = []; const args = [];
      if (req.query.status) { const st = STATUS_FILTER[req.query.status]; if (!st) throw E.badRequest('invalid status filter'); where.push(`status IN (${st.map(() => '?').join(',')})`); args.push(...st); }
      if (req.query.event_ticker) { where.push('event_ticker=?'); args.push(req.query.event_ticker); }
      if (req.query.series_ticker) { where.push('event_ticker IN (SELECT ticker FROM events WHERE series_ticker=?)'); args.push(req.query.series_ticker); }
      const offset = cur ? cur.o : 0;
      const rows = db.prepare(`SELECT * FROM markets ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY rowid LIMIT ? OFFSET ?`).all(...args, limit + 1, offset);
      res.json({ cursor: rows.length > limit ? encCursor({ o: offset + limit }) : '', markets: rows.slice(0, limit).map((m) => marketVo(m, q(m.ticker))) });
    } });
  const tradesHandler = (req, res) => {
    const limit = intParam(req.query, 'limit', { def: 100, min: 1, max: 1000, op: 'GetTrades' });
    const cur = decCursor(req.query.cursor); const off = cur ? cur.o : 0;
    const where = []; const args = [];
    if (req.query.ticker) { where.push('market_ticker=?'); args.push(String(req.query.ticker)); }
    tsRange(req.query, 'created_ts', where, args, 1000);
    const rows = db.prepare(`SELECT * FROM trades ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_ts DESC, rowid DESC LIMIT ? OFFSET ?`).all(...args, limit + 1, off);
    const pg = page(rows, limit, off);
    res.json({ cursor: pg.cursor, trades: pg.items.map(tradeV2) });
  };
  const tradesQuery = [qLimit('trades per page'), qCursor, { name: 'ticker', schema: R.str() }, qMinTs, qMaxTs];
  op({ id: 'get_trades', method: 'GET', path: '/markets/trades', tag: 'market', summary: 'Public trades (newest first, cursor)', query: tradesQuery, response: ok({ cursor: R.cursor(), trades: R.arr(R.ref('Trade')) }, ['cursor', 'trades']), handler: tradesHandler });
  op({ id: 'get_market', method: 'GET', path: '/markets/{ticker}', tag: 'market', summary: 'One market', response: ok({ market: R.ref('Market') }, ['market']),
    handler: (req, res) => { const m = db.prepare('SELECT * FROM markets WHERE ticker=?').get(req.params.ticker); if (!m) throw E.notFound(); res.json({ market: marketVo(m, q(m.ticker)) }); } });
  op({ id: 'get_market_orderbook', method: 'GET', path: '/markets/{ticker}/orderbook', tag: 'market', summary: 'Order book (YES and NO bids)', query: [{ name: 'depth', schema: R.int({ minimum: 0, maximum: 100 }), description: 'levels per side (0 = all)' }], response: R.ref('Orderbook'),
    handler: (req, res) => {
      if (!db.prepare('SELECT 1 FROM markets WHERE ticker=?').get(req.params.ticker)) throw E.notFound();
      const depth = intParam(req.query, 'depth', { def: 0, min: 0, max: 100, op: 'GetMarketOrderbook' });
      const b = engine.book(req.params.ticker);
      const lv = (map) => { let a = [...map.entries()].sort((x, y) => x[0] - y[0]); if (depth) a = a.slice(-depth); return a.map(([p, c]) => [P.ccToDollars(p), ufp(c)]); };
      const m = db.prepare('SELECT price_level_structure s FROM markets WHERE ticker=?').get(req.params.ticker);
      res.json({ orderbook_fp: { yes_dollars: lv(b.yes), no_dollars: lv(b.no) }, price_level_structure: m.s, price_ranges: P.priceRanges(m.s), tick_size_dollars: P.ccToDollars(P.minTick(m.s)) });
    } });
  op({ id: 'get_events', method: 'GET', path: '/events', tag: 'events', summary: 'List events', query: [qLimit('events per page', 200), qCursor, { name: 'series_ticker', schema: R.str() }, { name: 'status', schema: R.str({ enum: Object.keys(STATUS_FILTER) }) }, { name: 'with_nested_markets', schema: R.str({ enum: ['true', 'false'] }) }],
    response: ok({ cursor: R.cursor(), events: R.arr(R.ref('Event')) }, ['cursor', 'events']),
    handler: (req, res) => {
      const limit = intParam(req.query, 'limit', { def: 100, min: 1, max: 200, op: 'GetEvents' });
      const cur = decCursor(req.query.cursor); const offset = cur ? cur.o : 0;
      const args = []; const where = [];
      if (req.query.series_ticker) { where.push('series_ticker=?'); args.push(req.query.series_ticker); }
      if (req.query.status) { const st = STATUS_FILTER[req.query.status]; if (!st) throw E.badRequest('invalid status filter'); where.push(`ticker IN (SELECT event_ticker FROM markets WHERE status IN (${st.map(() => '?').join(',')}))`); args.push(...st); }
      const rows = db.prepare(`SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY rowid LIMIT ? OFFSET ?`).all(...args, limit + 1, offset);
      const nested = req.query.with_nested_markets === 'true';
      res.json({ cursor: rows.length > limit ? encCursor({ o: offset + limit }) : '', events: rows.slice(0, limit).map((e) => (nested ? eventFull(e) : eventVo(e))) });
    } });
  op({ id: 'get_event', method: 'GET', path: '/events/{ticker}', tag: 'events', summary: 'One event with its markets', response: ok({ event: R.ref('Event') }, ['event']),
    handler: (req, res) => { const e = getEvent(req.params.ticker); if (!e) throw E.notFound(); res.json({ event: eventFull(e) }); } });
  op({ id: 'get_series_list', method: 'GET', path: '/series', tag: 'series', summary: 'List series', query: [{ name: 'category', schema: R.str() }], response: ok({ series: R.arr(R.ref('Series')) }, ['series']),
    handler: (req, res) => {
      const rows = req.query.category ? db.prepare('SELECT * FROM series WHERE lower(category)=lower(?) ORDER BY rowid').all(String(req.query.category)) : db.prepare('SELECT * FROM series ORDER BY rowid').all();
      res.json({ series: rows.map(seriesVo) });
    } });
  op({ id: 'get_series', method: 'GET', path: '/series/{ticker}', tag: 'series', summary: 'One series', response: ok({ series: R.ref('Series') }, ['series']),
    handler: (req, res) => { const x = getSeries(req.params.ticker); if (!x) throw E.notFound(); res.json({ series: seriesVo(x) }); } });
  // Candlesticks built from persisted trades (spec §4.3 / HAR1#13 shape).
  function candles(req, res, ticker) {
    const m = db.prepare('SELECT * FROM markets WHERE ticker=?').get(ticker);
    if (!m) throw E.notFound();
    const period = intParam(req.query, 'period_interval', { def: 60, op: 'GetMarketCandlesticks' });
    if (![1, 60, 1440].includes(period)) throw E.badRequest('period_interval must be one of 1, 60, 1440');
    const now = Math.floor(Date.now() / 1000);
    const end = intParam(req.query, 'end_ts', { def: now, op: 'GetMarketCandlesticks' });
    const start = intParam(req.query, 'start_ts', { def: end - 7 * 86400, op: 'GetMarketCandlesticks' });
    if (start >= end) throw E.badRequest('start_ts must be before end_ts');
    const step = period * 60;
    if ((end - start) / step > 5000) throw E.badRequest('too many candlesticks requested');
    const trades = db.prepare('SELECT yes_price_cc p, count c, created_ts ts FROM trades WHERE market_ticker=? AND created_ts>=? AND created_ts<? ORDER BY created_ts').all(m.ticker, start * 1000, end * 1000);
    const prevRow = db.prepare('SELECT yes_price_cc p FROM trades WHERE market_ticker=? AND created_ts<? ORDER BY created_ts DESC LIMIT 1').get(m.ticker, start * 1000);
    const d$ = P.ccToDollars;
    let prev = prevRow ? prevRow.p : null;
    const out = []; let i = 0;
    for (let t = start - (start % step) + step; t <= end - (end % step) + step; t += step) {
      const bucket = [];
      while (i < trades.length && trades[i].ts < t * 1000) bucket.push(trades[i++]);
      if (!bucket.length && prev == null) continue;
      const ps = bucket.map((b) => b.p); const vol = bucket.reduce((a, b) => a + b.c, 0);
      const o = ps.length ? ps[0] : prev; const c = ps.length ? ps[ps.length - 1] : prev;
      out.push({ end_period_ts: t, price: { open_dollars: d$(o), high_dollars: d$(ps.length ? Math.max(...ps) : prev), low_dollars: d$(ps.length ? Math.min(...ps) : prev), close_dollars: d$(c), mean_dollars: d$(ps.length ? Math.round(ps.reduce((a, b) => a + b, 0) / ps.length) : prev), previous_dollars: d$(prev) }, volume_fp: ufp(vol) });
      prev = c;
    }
    res.json({ ticker: m.ticker, candlesticks: out });
  }
  const candleQuery = [{ name: 'period_interval', schema: R.int(), description: 'minutes per candle: 1, 60 or 1440' }, { name: 'start_ts', schema: R.int(), description: 'unix seconds' }, { name: 'end_ts', schema: R.int(), description: 'unix seconds' }];
  const candleResp = ok({ ticker: R.str(), candlesticks: R.arr(R.ref('Candlestick')) }, ['ticker', 'candlesticks']);
  op({ id: 'get_market_candlesticks', method: 'GET', path: '/series/{series_ticker}/markets/{ticker}/candlesticks', tag: 'market', summary: 'Candlesticks of a market', query: candleQuery, response: candleResp, handler: (req, res) => candles(req, res, req.params.ticker) });

  // ================================================================= Historical (public, cursors)
  op({ id: 'get_historical_trades', method: 'GET', path: '/historical/trades', tag: 'historical', summary: 'Trade history with time filters and a cursor', query: tradesQuery, response: ok({ cursor: R.cursor(), trades: R.arr(R.ref('Trade')) }, ['cursor', 'trades']), handler: tradesHandler });
  op({ id: 'get_historical_market_candlesticks', method: 'GET', path: '/historical/markets/{ticker}/candlesticks', tag: 'historical', summary: 'Candlesticks of a market (any status, including settled)', query: candleQuery, response: candleResp, handler: (req, res) => candles(req, res, req.params.ticker) });

  // ================================================================= Account (key)
  op({ id: 'get_account_limits', method: 'GET', path: '/account/limits', tag: 'account', auth: 'key', scopes: ['read'], cost: 1, summary: 'This key\'s rate tier and budgets', response: R.ref('RateLimits'),
    handler: (req, res, p) => res.json(apiKeys.limitsVo(p)) });
  op({ id: 'get_account_endpoint_costs', method: 'GET', path: '/account/endpoint_costs', tag: 'account', auth: 'key', scopes: ['read'], cost: 1, summary: 'Token cost of every endpoint',
    response: ok({ default_cost: R.int(), endpoint_costs: R.arr(ok({ method: R.str(), path: R.str(), cost: R.int(), bucket: R.str({ enum: ['read', 'write'] }), per_item: R.bool() }, ['method', 'path', 'cost', 'bucket'])) }, ['default_cost', 'endpoint_costs']),
    handler: (req, res) => res.json({ default_cost: 10, endpoint_costs: reg.ops.map((d) => ({ method: d.method, path: `/trade-api/v2${d.path}`, cost: typeof d.cost === 'function' ? d.perItem : d.cost, bucket: d.bucket, per_item: typeof d.cost === 'function' })) }) });

  // ================================================================= Portfolio (key)
  const uidP = (p) => p.user.id;
  op({ id: 'get_balance', method: 'GET', path: '/portfolio/balance', tag: 'portfolio', auth: 'key', summary: 'Cash balance and portfolio value',
    response: ok({ balance: R.int(), balance_dollars: R.dollarsS(), portfolio_value: R.int(), portfolio_value_dollars: R.dollarsS(), reserved_dollars: R.dollarsS(), updated_ts: R.int() }, ['balance', 'balance_dollars', 'portfolio_value']),
    handler: async (req, res, p, ctx) => {
      const r = await dispatch(who(p), 'GET', `/users/${uidP(p)}/balance`, undefined, ctx);
      send(res, r, (b) => { const c = (d) => Math.round(Number(d) * 100); return { balance: c(b.balance_dollars), balance_dollars: b.balance_dollars, portfolio_value: c(b.portfolio_value_dollars), portfolio_value_dollars: b.portfolio_value_dollars, reserved_dollars: b.reserved_dollars, updated_ts: Math.floor(Date.now() / 1000) }; });
    } });
  op({ id: 'get_positions', method: 'GET', path: '/portfolio/positions', tag: 'portfolio', auth: 'key', summary: 'Market and event positions', query: [qLimit('positions per page'), qCursor, { name: 'ticker', schema: R.str() }, { name: 'event_ticker', schema: R.str() }, { name: 'count_filter', schema: R.str({ enum: ['position', 'total_traded'] }) }],
    response: ok({ cursor: R.cursor(), market_positions: R.arr(R.ref('MarketPosition')), event_positions: R.arr(ok({ event_ticker: R.str(), event_exposure_dollars: R.dollarsS(), realized_pnl_dollars: R.dollarsS(), fees_paid_dollars: R.dollarsS() }, ['event_ticker', 'event_exposure_dollars'])) }, ['cursor', 'market_positions', 'event_positions']),
    handler: (req, res, p) => {
      const limit = intParam(req.query, 'limit', { def: 100, min: 1, max: 1000, op: 'GetPositions' });
      const cur = decCursor(req.query.cursor); const off = cur ? cur.o : 0;
      const where = ['p.user_id=?']; const args = [uidP(p)];
      if (req.query.ticker) { where.push('p.market_ticker=?'); args.push(String(req.query.ticker)); }
      if (req.query.event_ticker) { where.push('m.event_ticker=?'); args.push(String(req.query.event_ticker)); }
      if (req.query.count_filter !== 'total_traded') where.push('(p.yes_count>0 OR p.no_count>0)');
      const rows = db.prepare(`SELECT p.*, m.event_ticker FROM positions p JOIN markets m ON m.ticker=p.market_ticker WHERE ${where.join(' AND ')} ORDER BY p.updated_at DESC, p.market_ticker LIMIT ? OFFSET ?`).all(...args, limit + 1, off);
      const pg = page(rows, limit, off);
      const resting = (t) => db.prepare("SELECT COUNT(*) c FROM orders WHERE user_id=? AND market_ticker=? AND status='resting'").get(uidP(p), t).c;
      const mp = pg.items.map((x) => ({ ticker: x.market_ticker, event_ticker: x.event_ticker, position_fp: ufp(x.yes_count > 0 ? x.yes_count : -x.no_count), side: x.yes_count > 0 ? 'yes' : x.no_count > 0 ? 'no' : null,
        market_exposure_dollars: dollars(x.yes_cost_cents + x.no_cost_cents), total_traded_dollars: dollars(x.yes_cost_cents + x.no_cost_cents), realized_pnl_dollars: dollars(x.realized_pnl_cents), fees_paid_dollars: dollars(x.fees_paid_cents), resting_orders_count: resting(x.market_ticker), last_updated_ts: x.updated_at }));
      const ev = new Map();
      for (const x of pg.items) { const e = ev.get(x.event_ticker) || { event_ticker: x.event_ticker, c: 0, r: 0, f: 0 }; e.c += x.yes_cost_cents + x.no_cost_cents; e.r += x.realized_pnl_cents; e.f += x.fees_paid_cents; ev.set(x.event_ticker, e); }
      res.json({ cursor: pg.cursor, market_positions: mp, event_positions: [...ev.values()].map((e) => ({ event_ticker: e.event_ticker, event_exposure_dollars: dollars(e.c), realized_pnl_dollars: dollars(e.r), fees_paid_dollars: dollars(e.f) })) });
    } });
  const ordersQuery = [qLimit('orders per page'), qCursor, { name: 'ticker', schema: R.str() }, { name: 'event_ticker', schema: R.str() }, { name: 'status', schema: R.str({ enum: ['resting', 'executed', 'canceled'] }) }, qMinTs, qMaxTs];
  op({ id: 'get_orders', method: 'GET', path: '/portfolio/orders', tag: 'orders', auth: 'key', summary: 'Your orders (newest first, cursor)', query: ordersQuery, response: ok({ cursor: R.cursor(), orders: R.arr(R.ref('Order')) }, ['cursor', 'orders']),
    handler: (req, res, p) => {
      const limit = intParam(req.query, 'limit', { def: 100, min: 1, max: 1000, op: 'GetOrders' });
      const cur = decCursor(req.query.cursor); const off = cur ? cur.o : 0;
      const where = ['user_id=?']; const args = [uidP(p)];
      if (req.query.ticker) { where.push('market_ticker=?'); args.push(String(req.query.ticker)); }
      if (req.query.event_ticker) { where.push('market_ticker IN (SELECT ticker FROM markets WHERE event_ticker=?)'); args.push(String(req.query.event_ticker)); }
      if (req.query.status) { where.push('status=?'); args.push(String(req.query.status)); }
      for (const [k, opx] of [['min_ts', '>='], ['max_ts', '<=']]) if (req.query[k]) { where.push(`created_at${opx}?`); args.push(new Date(Number(req.query[k]) * 1000).toISOString()); }
      const rows = db.prepare(`SELECT * FROM orders WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ? OFFSET ?`).all(...args, limit + 1, off);
      const pg = page(rows, limit, off);
      res.json({ cursor: pg.cursor, orders: pg.items.map(orderV2) });
    } });
  op({ id: 'get_order_queue_positions', method: 'GET', path: '/portfolio/orders/queue_positions', tag: 'orders', auth: 'key', summary: 'Queue positions of your resting orders', query: [{ name: 'market_tickers', schema: R.str(), description: 'comma-separated tickers' }],
    response: ok({ queue_positions: R.arr(ok({ order_id: R.str(), market_ticker: R.str(), queue_position_fp: R.fpS() }, ['order_id', 'market_ticker', 'queue_position_fp'])) }, ['queue_positions']),
    handler: (req, res, p) => {
      const want = req.query.market_tickers ? new Set(String(req.query.market_tickers).split(',').map((x) => x.trim()).filter(Boolean)) : null;
      const rows = db.prepare("SELECT * FROM orders WHERE user_id=? AND status='resting' ORDER BY seq").all(uidP(p)).filter((o) => !want || want.has(o.market_ticker));
      res.json({ queue_positions: rows.map((o) => ({ order_id: o.id, market_ticker: o.market_ticker, queue_position_fp: ufp(engine.queuePosition(o)) })) });
    } });
  // Batch endpoints are registered before /portfolio/orders/{order_id}.
  op({ id: 'batch_create_orders', method: 'POST', path: '/portfolio/orders/batched', tag: 'orders', auth: 'key', summary: `Create up to ${MAX_BATCH} orders; per-order results (partial success)`, cost: (req) => 10 * Math.max(1, Array.isArray(req.body?.orders) ? req.body.orders.length : 1), perItem: 10, status: 201,
    body: R.obj({ orders: R.arr({ type: 'object' }, { minItems: 1, maxItems: MAX_BATCH }) }, ['orders']),
    response: ok({ orders: R.arr(R.ref('BatchCreateResult')) }, ['orders']),
    handler: async (req, res, p, ctx) => {
      const list = req.body && req.body.orders;
      if (!Array.isArray(list) || !list.length || list.length > MAX_BATCH) throw E.badRequest(s('batch.size', { max: MAX_BATCH }));
      const out = [];
      for (const item of list) {
        const r = await createOrder(who(p), item && typeof item === 'object' ? item : {}, { ...ctx, headers: { ...ctx.headers, 'idempotency-key': undefined } });
        out.push({ client_order_id: item?.client_order_id ?? null, order: r.status < 400 ? r.body.order : null, error: r.status < 400 ? null : r.body.error ? r.body : { error: { code: 'bad_request', message: 'bad request', details: r.body.msg } } });
      }
      res.status(201).json({ orders: out });
    } });
  op({ id: 'batch_cancel_orders', method: 'DELETE', path: '/portfolio/orders/batched', tag: 'orders', auth: 'key', summary: `Cancel up to ${MAX_BATCH} orders by id; per-order results`, cost: (req) => CANCEL_COST * Math.max(1, Array.isArray(req.body?.ids) ? req.body.ids.length : 1), perItem: CANCEL_COST,
    body: R.obj({ ids: R.arr(R.str(), { minItems: 1, maxItems: MAX_BATCH }) }, ['ids']),
    response: ok({ orders: R.arr(R.ref('BatchCancelResult')) }, ['orders']),
    handler: async (req, res, p, ctx) => {
      const ids = req.body && req.body.ids;
      if (!Array.isArray(ids) || !ids.length || ids.length > MAX_BATCH || ids.some((x) => typeof x !== 'string' || x.length > 100)) throw E.badRequest(s('batch.ids', { max: MAX_BATCH }));
      const out = [];
      for (const id of ids) {
        const before = db.prepare('SELECT remaining_count FROM orders WHERE id=? AND user_id=?').get(id, uidP(p));
        const r = await cancelOrder(who(p), id, ctx);
        out.push({ order_id: id, order: r.status < 400 ? r.body.order : null, reduced_by_fp: r.status < 400 && before ? ufp(before.remaining_count) : null, error: r.status < 400 ? null : r.body });
      }
      res.json({ orders: out });
    } });
  op({ id: 'create_order', method: 'POST', path: '/portfolio/orders', tag: 'orders', auth: 'key', summary: 'Create an order', status: 201,
    body: R.obj({ ticker: R.str(), side: R.str({ enum: ['yes', 'no'] }), action: R.str({ enum: ['buy', 'sell'] }), type: R.str({ enum: ['limit', 'market'] }), count: R.num(), count_fp: R.str(), yes_price: R.num(), no_price: R.num(), yes_price_dollars: R.str(), no_price_dollars: R.str(), client_order_id: R.str(), expiration_ts: R.int(), buy_max_cost: R.int(), post_only: R.bool(), order_group_id: R.str(), time_in_force: R.str() }, ['ticker', 'side', 'action']),
    response: ok({ order: R.ref('Order') }, ['order']),
    handler: async (req, res, p, ctx) => send(res, await createOrder(who(p), req.body || {}, ctx)) });
  op({ id: 'get_order', method: 'GET', path: '/portfolio/orders/{order_id}', tag: 'orders', auth: 'key', summary: 'One of your orders', response: ok({ order: R.ref('Order') }, ['order']),
    handler: (req, res, p) => { const o = db.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(req.params.order_id, uidP(p)); if (!o) throw E.notFound(); res.json({ order: orderV2(o) }); } });
  op({ id: 'get_order_queue_position', method: 'GET', path: '/portfolio/orders/{order_id}/queue_position', tag: 'orders', auth: 'key', summary: 'Queue position of one resting order', response: ok({ queue_position_fp: R.fpS() }, ['queue_position_fp']),
    handler: (req, res, p) => { const o = db.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(req.params.order_id, uidP(p)); if (!o) throw E.notFound(); res.json({ queue_position_fp: ufp(engine.queuePosition(o)) }); } });
  op({ id: 'cancel_order', method: 'DELETE', path: '/portfolio/orders/{order_id}', tag: 'orders', auth: 'key', cost: CANCEL_COST, summary: 'Cancel an order', response: ok({ order: R.ref('Order'), reduced_by_fp: R.fpN() }, ['order']),
    handler: async (req, res, p, ctx) => {
      const before = db.prepare('SELECT remaining_count FROM orders WHERE id=? AND user_id=?').get(req.params.order_id, uidP(p));
      const r = await cancelOrder(who(p), req.params.order_id, ctx);
      send(res, r, (b) => ({ ...b, reduced_by_fp: before ? ufp(before.remaining_count) : null }));
    } });
  op({ id: 'amend_order', method: 'POST', path: '/portfolio/orders/{order_id}/amend', tag: 'orders', auth: 'key', summary: 'Amend price and/or count (keeps queue priority when only the count shrinks)',
    body: R.obj({ yes_price: R.num(), no_price: R.num(), yes_price_dollars: R.str(), no_price_dollars: R.str(), count: R.num(), count_fp: R.str(), expiration_ts: R.int() }),
    response: ok({ old_order: R.ref('Order'), order: R.ref('Order'), queue_priority_kept: R.bool() }, ['order']),
    handler: async (req, res, p, ctx) => send(res, await amendOrder(who(p), req.params.order_id, req.body || {}, ctx)) });
  op({ id: 'decrease_order', method: 'POST', path: '/portfolio/orders/{order_id}/decrease', tag: 'orders', auth: 'key', summary: 'Decrease the remaining count in place (keeps queue priority)',
    body: R.obj({ reduce_by: R.num(), reduce_to: R.num(), reduce_by_fp: R.str(), reduce_to_fp: R.str() }),
    response: ok({ order: R.ref('Order'), reduced_by_fp: R.fpS() }, ['order']),
    handler: async (req, res, p, ctx) => send(res, await decreaseOrder(who(p), req.params.order_id, req.body || {}, ctx)) });
  op({ id: 'get_fills', method: 'GET', path: '/portfolio/fills', tag: 'portfolio', auth: 'key', summary: 'Your fills (newest first, cursor)', query: [qLimit('fills per page'), qCursor, { name: 'ticker', schema: R.str() }, { name: 'order_id', schema: R.str() }, qMinTs, qMaxTs],
    response: ok({ cursor: R.cursor(), fills: R.arr(R.ref('Fill')) }, ['cursor', 'fills']),
    handler: (req, res, p) => {
      const limit = intParam(req.query, 'limit', { def: 100, min: 1, max: 1000, op: 'GetFills' });
      const cur = decCursor(req.query.cursor); const off = cur ? cur.o : 0;
      const where = ['f.user_id=?']; const args = [uidP(p)];
      if (req.query.ticker) { where.push('f.market_ticker=?'); args.push(String(req.query.ticker)); }
      if (req.query.order_id) { where.push('f.order_id=?'); args.push(String(req.query.order_id)); }
      tsRange(req.query, 'f.created_ts', where, args, 1000);
      const rows = db.prepare(`SELECT f.*, o.action FROM fills f LEFT JOIN orders o ON o.id=f.order_id WHERE ${where.join(' AND ')} ORDER BY f.created_ts DESC, f.rowid DESC LIMIT ? OFFSET ?`).all(...args, limit + 1, off);
      const pg = page(rows, limit, off);
      res.json({ cursor: pg.cursor, fills: pg.items.map(fillV2) });
    } });
  op({ id: 'get_settlements', method: 'GET', path: '/portfolio/settlements', tag: 'portfolio', auth: 'key', summary: 'Your settlement history (newest first, cursor)', query: [qLimit('settlements per page'), qCursor, qMinTs, qMaxTs],
    response: ok({ cursor: R.cursor(), settlements: R.arr(R.ref('Settlement')) }, ['cursor', 'settlements']),
    handler: (req, res, p) => {
      const limit = intParam(req.query, 'limit', { def: 100, min: 1, max: 1000, op: 'GetSettlements' });
      const cur = decCursor(req.query.cursor); const off = cur ? cur.o : 0;
      const where = ['user_id=?']; const args = [uidP(p)];
      for (const [k, opx] of [['min_ts', '>='], ['max_ts', '<=']]) if (req.query[k]) { where.push(`created_at${opx}?`); args.push(new Date(Number(req.query[k]) * 1000).toISOString()); }
      const rows = db.prepare(`SELECT * FROM settlements WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`).all(...args, limit + 1, off);
      const pg = page(rows, limit, off);
      res.json({ cursor: pg.cursor, settlements: pg.items.map((x) => ({ ticker: x.market_ticker, market_result: x.result, yes_count_fp: ufp(x.yes_count), no_count_fp: ufp(x.no_count), revenue_dollars: dollars(x.effective_payout_cents ?? x.payout_cents), cost_dollars: dollars(x.cost_cents), settled_time: x.created_at })) });
    } });

  // ---- order groups
  op({ id: 'get_order_groups', method: 'GET', path: '/portfolio/order_groups', tag: 'order-groups', auth: 'key', summary: 'Your order groups', response: ok({ order_groups: R.arr(R.ref('OrderGroup')) }, ['order_groups']),
    handler: (req, res, p) => res.json({ order_groups: db.prepare("SELECT * FROM order_groups WHERE user_id=? AND status<>'deleted' ORDER BY created_ts DESC LIMIT 200").all(uidP(p)).map(groupVo) }) });
  op({ id: 'create_order_group', method: 'POST', path: '/portfolio/order_groups', tag: 'order-groups', auth: 'key', summary: 'Create an order group with a contracts limit', status: 201,
    body: R.obj({ contracts_limit: R.num(), contracts_limit_fp: R.str() }), response: ok({ order_group_id: R.str(), order_group: R.ref('OrderGroup') }, ['order_group_id', 'order_group']),
    handler: (req, res, p) => {
      if (!flags.on('trading', { uid: uidP(p) })) throw flags.disabledError('trading');
      const b = req.body || {};
      const u = toUnits(b.contracts_limit_fp ?? b.contracts_limit);
      if (u == null || u < UNITS) throw E.badRequest(s('group.limit'));
      const g = tx(db, () => {
        if (db.prepare("SELECT COUNT(*) c FROM order_groups WHERE user_id=? AND status IN ('active','triggered')").get(uidP(p)).c >= 50) throw new ApiError(409, 'order_group_limit', s('group.max', { max: 50 }));
        const id = newId('ogp_'); const now = Date.now();
        db.prepare('INSERT INTO order_groups(id,user_id,contracts_limit,filled,status,created_ts,updated_ts) VALUES(?,?,?,0,?,?,?)').run(id, uidP(p), u, 'active', now, now);
        return groupRow(id);
      });
      emitGroup(g);
      res.status(201).json({ order_group_id: g.id, order_group: groupVo(g) });
    } });
  op({ id: 'get_order_group', method: 'GET', path: '/portfolio/order_groups/{order_group_id}', tag: 'order-groups', auth: 'key', summary: 'One order group and its orders', response: ok({ order_group: R.ref('OrderGroup'), orders: R.arr(R.ref('Order')) }, ['order_group', 'orders']),
    handler: (req, res, p) => {
      const g = ownGroup(uidP(p), req.params.order_group_id);
      res.json({ order_group: groupVo(g), orders: db.prepare('SELECT o.* FROM order_group_orders x JOIN orders o ON o.id=x.order_id WHERE x.group_id=? ORDER BY o.seq DESC LIMIT 200').all(g.id).map(orderV2) });
    } });
  op({ id: 'delete_order_group', method: 'DELETE', path: '/portfolio/order_groups/{order_group_id}', tag: 'order-groups', auth: 'key', summary: 'Delete a group and cancel its resting orders', response: ok({ order_group: R.ref('OrderGroup'), canceled_count: R.int() }, ['order_group', 'canceled_count']),
    handler: (req, res, p) => {
      const g = ownGroup(uidP(p), req.params.order_group_id);
      let n = 0;
      for (const o of db.prepare("SELECT o.id FROM order_group_orders x JOIN orders o ON o.id=x.order_id WHERE x.group_id=? AND o.status='resting'").all(g.id)) { try { engine.cancelOrder(g.user_id, o.id, 'order_group_deleted'); n += 1; } catch { /* market closed */ } }
      db.prepare("UPDATE order_groups SET status='deleted', status_reason='user_deleted', updated_ts=? WHERE id=?").run(Date.now(), g.id);
      const after = groupRow(g.id);
      emitGroup(after);
      res.json({ order_group: groupVo(after), canceled_count: n });
    } });
  op({ id: 'reset_order_group', method: 'PUT', path: '/portfolio/order_groups/{order_group_id}/reset', tag: 'order-groups', auth: 'key', summary: 'Reset the filled count and re-enable a triggered group', response: ok({ order_group: R.ref('OrderGroup') }, ['order_group']),
    handler: (req, res, p) => {
      const g = ownGroup(uidP(p), req.params.order_group_id);
      db.prepare("UPDATE order_groups SET filled=0, status='active', status_reason=NULL, triggered_ts=NULL, updated_ts=? WHERE id=?").run(Date.now(), g.id);
      const after = groupRow(g.id);
      emitGroup(after);
      res.json({ order_group: groupVo(after) });
    } });

  // ================================================================= Communications: RFQs and quotes (key)
  const commsGet = (path, id, summary, resp) => op({ id, method: 'GET', path, tag: 'communications', auth: 'key', summary, response: resp, handler: passthrough('GET', (req) => withQuery(req, path)) });
  commsGet('/communications/id', 'get_communications_id', 'Your communications id', ok({ communications_id: R.str() }, ['communications_id']));
  commsGet('/communications/rfqs', 'get_rfqs', 'Open RFQs', ok({ rfqs: R.arr(R.ref('Rfq')) }, ['rfqs']));
  op({ id: 'create_rfq', method: 'POST', path: '/communications/rfqs', tag: 'communications', auth: 'key', summary: 'Create an RFQ', status: 201, body: R.obj({ market_ticker: R.str(), contracts_fp: R.str(), contracts: R.num() }, ['market_ticker']),
    response: { type: 'object' }, handler: passthrough('POST', '/communications/rfqs') });
  op({ id: 'get_rfq', method: 'GET', path: '/communications/rfqs/{rfq_id}', tag: 'communications', auth: 'key', summary: 'One RFQ', response: { type: 'object' }, handler: passthrough('GET', (req) => `/communications/rfqs/${encodeURIComponent(req.params.rfq_id)}`) });
  op({ id: 'delete_rfq', method: 'DELETE', path: '/communications/rfqs/{rfq_id}', tag: 'communications', auth: 'key', summary: 'Delete your RFQ', response: { type: 'object' }, handler: passthrough('DELETE', (req) => `/communications/rfqs/${encodeURIComponent(req.params.rfq_id)}`) });
  commsGet('/communications/quotes', 'get_quotes', 'Quotes on your RFQs and quotes you made', ok({ quotes: R.arr(R.ref('Quote')) }, ['quotes']));
  op({ id: 'create_quote', method: 'POST', path: '/communications/quotes', tag: 'communications', auth: 'key', summary: 'Quote on an RFQ', status: 201, body: R.obj({ rfq_id: R.str(), yes_bid: R.str(), no_bid: R.str() }, ['rfq_id']), response: { type: 'object' }, handler: passthrough('POST', '/communications/quotes') });
  op({ id: 'get_quote', method: 'GET', path: '/communications/quotes/{quote_id}', tag: 'communications', auth: 'key', summary: 'One quote', response: { type: 'object' }, handler: passthrough('GET', (req) => `/communications/quotes/${encodeURIComponent(req.params.quote_id)}`) });
  op({ id: 'delete_quote', method: 'DELETE', path: '/communications/quotes/{quote_id}', tag: 'communications', auth: 'key', summary: 'Delete your quote', response: { type: 'object' }, handler: passthrough('DELETE', (req) => `/communications/quotes/${encodeURIComponent(req.params.quote_id)}`) });
  op({ id: 'accept_quote', method: 'PUT', path: '/communications/quotes/{quote_id}/accept', tag: 'communications', auth: 'key', summary: 'Accept a quote on your RFQ', body: R.obj({ accepted_side: R.str({ enum: ['yes', 'no'] }) }, ['accepted_side']), response: { type: 'object' }, handler: passthrough('PUT', (req) => `/communications/quotes/${encodeURIComponent(req.params.quote_id)}/accept`) });
  op({ id: 'confirm_quote', method: 'PUT', path: '/communications/quotes/{quote_id}/confirm', tag: 'communications', auth: 'key', summary: 'Confirm your accepted quote (executes)', body: R.obj({}), response: { type: 'object' }, handler: passthrough('PUT', (req) => `/communications/quotes/${encodeURIComponent(req.params.quote_id)}/confirm`) });

  // ================================================================= Multivariate collections
  op({ id: 'get_multivariate_event_collections', method: 'GET', path: '/multivariate_event_collections', tag: 'multivariate', summary: 'Combo collections', response: ok({ multivariate_contracts: R.arr({ type: 'object' }) }, ['multivariate_contracts']), handler: passthrough('GET', '/multivariate_event_collections') });
  op({ id: 'get_multivariate_event_collection', method: 'GET', path: '/multivariate_event_collections/{collection_ticker}', tag: 'multivariate', summary: 'One combo collection', response: { type: 'object' }, handler: passthrough('GET', (req) => `/multivariate_event_collections/${encodeURIComponent(req.params.collection_ticker)}`) });
  op({ id: 'create_market_in_multivariate_event_collection', method: 'POST', path: '/multivariate_event_collections/{collection_ticker}', tag: 'multivariate', auth: 'key', status: 201, summary: 'Create the combo market for a set of legs (201; an existing combo answers 200)', body: R.obj({ selected_markets: R.arr({ type: 'object' }) }, ['selected_markets']), response: { type: 'object' },
    handler: passthrough('POST', (req) => `/multivariate_event_collections/${encodeURIComponent(req.params.collection_ticker)}`) });

  // ================================================================= Perps (/margin; the perps scope)
  const PM = { product: 'perps' };
  const perpsKey = (bucket) => ({ ...PM, auth: 'key', scopes: bucket === 'write' ? ['trade', 'perps'] : ['read', 'perps'] });
  op({ ...PM, id: 'get_margin_markets', method: 'GET', path: '/margin/markets', tag: 'perps', summary: 'Perps markets', query: [{ name: 'asset_class', schema: R.str() }], response: ok({ markets: R.arr(R.ref('PerpMarket')), cursor: R.cursor() }, ['markets']), handler: passthrough('GET', (req) => withQuery(req, '/perps/markets')) });
  op({ ...PM, id: 'get_margin_market', method: 'GET', path: '/margin/markets/{ticker}', tag: 'perps', summary: 'One perps market', response: ok({ market: R.ref('PerpMarket') }, ['market']), handler: passthrough('GET', (req) => `/perps/markets/${encodeURIComponent(req.params.ticker)}`) });
  op({ ...PM, id: 'get_margin_orderbook', method: 'GET', path: '/margin/markets/{ticker}/orderbook', tag: 'perps', summary: 'Perps order book', query: [{ name: 'depth', schema: R.int({ minimum: 0, maximum: 100 }) }], response: ok({ orderbook: { type: 'object' } }, ['orderbook']), handler: passthrough('GET', (req) => withQuery(req, `/perps/markets/${encodeURIComponent(req.params.ticker)}/orderbook`)) });
  op({ ...PM, id: 'get_margin_trades', method: 'GET', path: '/margin/markets/{ticker}/trades', tag: 'perps', summary: 'Perps trades', query: [qLimit('trades', 1000, 50)], response: ok({ trades: R.arr({ type: 'object' }) }, ['trades']), handler: passthrough('GET', (req) => withQuery(req, `/perps/markets/${encodeURIComponent(req.params.ticker)}/trades`)) });
  op({ ...perpsKey('read'), id: 'get_margin_balance', method: 'GET', path: '/margin/balance', tag: 'perps', summary: 'Perps collateral and margin', query: [{ name: 'subaccount', schema: R.int({ minimum: 0, maximum: 32 }) }], response: R.ref('PerpBalance'), handler: passthrough('GET', (req) => withQuery(req, '/perps/balance')) });
  op({ ...perpsKey('read'), id: 'get_margin_positions', method: 'GET', path: '/margin/positions', tag: 'perps', summary: 'Open perps positions', query: [{ name: 'ticker', schema: R.str() }, { name: 'subaccount', schema: R.int({ minimum: 0, maximum: 32 }) }], response: ok({ positions: R.arr(R.ref('PerpPosition')) }, ['positions']), handler: passthrough('GET', (req) => withQuery(req, '/perps/positions')) });
  op({ ...perpsKey('read'), id: 'get_margin_orders', method: 'GET', path: '/margin/orders', tag: 'perps', summary: 'Your perps orders (cursor)', query: [qLimit('orders'), qCursor, { name: 'status', schema: R.str() }, { name: 'ticker', schema: R.str() }], response: ok({ orders: R.arr(R.ref('PerpOrder')), cursor: R.cursor() }, ['orders', 'cursor']), handler: passthrough('GET', (req) => withQuery(req, '/perps/orders')) });
  op({ ...perpsKey('write'), id: 'create_margin_order', method: 'POST', path: '/margin/orders', tag: 'perps', summary: 'Create a perps order', status: 201,
    body: R.obj({ ticker: R.str(), side: R.str({ enum: ['bid', 'ask'] }), type: R.str({ enum: ['limit', 'market'] }), price: R.str(), count: R.num(), leverage: R.num(), subaccount: R.int(), reduce_only: R.bool(), post_only: R.bool(), order_group_id: R.str(), client_order_id: R.str() }, ['ticker', 'side']),
    response: ok({ order: R.ref('PerpOrder'), order_id: R.str() }, ['order', 'order_id']), handler: passthrough('POST', '/perps/orders') });
  op({ ...perpsKey('read'), id: 'get_margin_order', method: 'GET', path: '/margin/orders/{order_id}', tag: 'perps', summary: 'One perps order', response: ok({ order: R.ref('PerpOrder') }, ['order']), handler: passthrough('GET', (req) => `/perps/orders/${encodeURIComponent(req.params.order_id)}`) });
  op({ ...perpsKey('write'), id: 'cancel_margin_order', method: 'DELETE', path: '/margin/orders/{order_id}', tag: 'perps', cost: CANCEL_COST, summary: 'Cancel a perps order', response: ok({ order: R.ref('PerpOrder') }, ['order']), handler: passthrough('DELETE', (req) => `/perps/orders/${encodeURIComponent(req.params.order_id)}`) });
  op({ ...perpsKey('write'), id: 'amend_margin_order', method: 'POST', path: '/margin/orders/{order_id}/amend', tag: 'perps', summary: 'Amend a perps order', body: R.obj({ price: R.str(), count: R.num() }), response: ok({ order: R.ref('PerpOrder') }, ['order']), handler: passthrough('POST', (req) => `/perps/orders/${encodeURIComponent(req.params.order_id)}/amend`) });
  op({ ...perpsKey('write'), id: 'decrease_margin_order', method: 'POST', path: '/margin/orders/{order_id}/decrease', tag: 'perps', summary: 'Decrease a perps order', body: R.obj({ reduce_by: R.num(), reduce_to: R.num() }), response: ok({ order: R.ref('PerpOrder') }, ['order']), handler: passthrough('POST', (req) => `/perps/orders/${encodeURIComponent(req.params.order_id)}/decrease`) });
  op({ ...perpsKey('write'), id: 'close_margin_position', method: 'POST', path: '/margin/positions/{ticker}/close', tag: 'perps', summary: 'Close (part of) a position at market', body: R.obj({ percent: R.num(), subaccount: R.int() }), response: ok({ order: R.ref('PerpOrder') }, ['order']), handler: passthrough('POST', (req) => `/perps/positions/${encodeURIComponent(req.params.ticker)}/close`) });
  op({ ...perpsKey('read'), id: 'get_margin_fills', method: 'GET', path: '/margin/fills', tag: 'perps', summary: 'Your perps fills', query: [{ name: 'ticker', schema: R.str() }, qLimit('fills')], response: ok({ fills: R.arr(R.ref('PerpFill')) }, ['fills']), handler: passthrough('GET', (req) => withQuery(req, '/perps/fills')) });
  op({ ...perpsKey('read'), id: 'get_margin_order_groups', method: 'GET', path: '/margin/order_groups', tag: 'perps', summary: 'Your perps order groups', response: ok({ order_groups: R.arr(R.ref('PerpOrderGroup')) }, ['order_groups']), handler: passthrough('GET', '/perps/order_groups') });
  op({ ...perpsKey('write'), id: 'create_margin_order_group', method: 'POST', path: '/margin/order_groups', tag: 'perps', summary: 'Create a perps order group (limit or OCO)', status: 201, body: R.obj({ kind: R.str({ enum: ['limit', 'oco'] }), contracts_limit: R.num(), subaccount: R.int() }), response: ok({ order_group_id: R.str(), order_group: R.ref('PerpOrderGroup') }, ['order_group_id']), handler: passthrough('POST', '/perps/order_groups') });
  op({ ...perpsKey('write'), id: 'delete_margin_order_group', method: 'DELETE', path: '/margin/order_groups/{order_group_id}', tag: 'perps', summary: 'Cancel a perps order group', response: ok({ order_group: R.ref('PerpOrderGroup') }, ['order_group']), handler: passthrough('DELETE', (req) => `/perps/order_groups/${encodeURIComponent(req.params.order_group_id)}`) });
  op({ ...perpsKey('write'), id: 'reset_margin_order_group', method: 'POST', path: '/margin/order_groups/{order_group_id}/reset', tag: 'perps', summary: 'Reset a perps order group', response: ok({ order_group: R.ref('PerpOrderGroup') }, ['order_group']), handler: passthrough('POST', (req) => `/perps/order_groups/${encodeURIComponent(req.params.order_group_id)}/reset`) });

  for (const d of reg.ops) v2[d.method.toLowerCase()](d.expressPath, wrap(d));

  // ---------------------------------------------------------------- production switch (play mode → real money)
  // Keys survive (they are credentials, not money); the reset cancels resting orders like every other order, and the
  // groups that held them are closed. FIX sessions are disconnected after the reset (server/fix.js listens).
  const resetForProduction = () => ({ api_order_groups: db.prepare("UPDATE order_groups SET status='deleted', status_reason='production_reset', updated_ts=? WHERE status IN ('active','triggered')").run(Date.now()).changes,
    api_keys_kept: db.prepare("SELECT COUNT(*) c FROM api_keys WHERE status='active'").get().c });

  return { authGate, setChain, dispatch, createOrder, cancelOrder, amendOrder, decreaseOrder, orderV2, fillV2, groupVo, resetForProduction, ParamError, intParam, STATUS_FILTER, registry: reg };
}

module.exports = { mountTradeApi, ParamError, intParam, captureRes, STATUS_FILTER, MAX_BATCH };
