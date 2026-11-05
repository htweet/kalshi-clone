'use strict';
const CS = require('./content/currency-strings'); // keyed user-facing wording (CLONE_SPEC.md §30)
const C = require('./currency'); // display currency formatting (CLONE_SPEC.md §30)
const express = require('express');
const { tx } = require('./db');
const { nowIso, dollars, fp, ufp, ustr, toUnits, UNITS, usd, ApiError, E, encCursor, decCursor } = require('./util');
const { marketVo, eventVo, orderVo, fillVo } = require('./serialize');
const { mountFeatures, CATEGORIES } = require('./features');
const { perContractFeeCapCc } = require('./engine');
const P = require('./pricing'); // Phase 5A price grids and centi-cent prices (CLONE_SPEC.md §28)
const { mountRolling } = require('./rolling');
const { mountPerps } = require('./perps');
const { mountPerpsOps } = require('./perps-ops'); // Phase 6: Admin › Perps ops, waitlist, collateral APY, Perps referrals (§34)
const { mountCombos, COMBO_SERIES } = require('./combos');
const { mountHistory } = require('./history');
const { mountOrders, parseExpiry } = require('./orders');
const { mountPositions } = require('./positions');
const { mountTradingCore } = require('./trading-core'); // Phase 5A: collateral return, settlement corrections, two-person rule (CLONE_SPEC.md §28)
const { mountSports } = require('./sports');
const { mountAdmin } = require('./admin');
const { mountChat } = require('./chat');
const { mountCommunity } = require('./community'); // Phase 2: social and community completion (CLONE_SPEC.md §24)
const { mountWebPush } = require('./webpush'); // Web Push for the Push notification channel (CLONE_SPEC.md §31)
const { mountIdentity } = require('./identity'); // Phase 3: accounts, identity, compliance (CLONE_SPEC.md §25)
const { mountAccountArea } = require('./account-area'); // Phase 3: account area, settings, documents, rewards (§25)
const { mountPayments } = require('./payments'); // Phase 4: payments, sandbox only (CLONE_SPEC.md §26)
const journal = require('./journal'); // Phase 4: double-entry journal (CLONE_SPEC.md §26.6)
const { mountMarketsContent } = require('./markets-content'); // Phase 5B: ballot, AI summaries, incentives, hubs (§29)
const { mountCms } = require('./cms'); // Phase 5C: content management (CLONE_SPEC.md §32)
const { createFlags, mountFlags } = require('./flags'); // Phase 5D: feature flags (CLONE_SPEC.md §33)
const { mountPlayMode } = require('./play-mode'); // Phase 5D: play mode, money controls, production switch (§33)
const { mountCentralBank } = require('./central-bank'); // Phase 5D: Central Bank, promotions treasury, Vault Heist (§33)
const { jsonBody, validateRoutes } = require('./validate');
const { idempotency } = require('./idempotency');
const { createAuth } = require('./auth');
const { createSecurity } = require('./security');
const { createApiKeys, mountApiKeys } = require('./api-keys'); // Phase 7: API keys and signed requests (CLONE_SPEC.md §35)
const { mountTradeApi, ParamError, intParam, STATUS_FILTER } = require('./trade-api'); // Phase 7: public Trade API v2 (§35)
const { createRegistry } = require('./api-registry'); // Phase 7: one route registry → routes, OpenAPI, AsyncAPI, contract tests

// Session cookie name on plain-http localhost; over HTTPS / in production it is __Host-plx_session (server/auth.js).
const SESSION_COOKIE = 'plx_session';
const SETTING_KEYS = new Set(['theme', 'orderbook_settings', 'event_market_tab', 'event_bottom_tab', 'browse_order_by', 'browse_layout', 'portfolio_view', 'chart_range', 'social_feed', 'ticket_mode', 'orderbook_hide_fractional_shares', 'rfq_enabled', 'history_filters', 'positions_sort', 'positions_filter', 'activity_filter']);

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Rate limits (spec §5.4: 429 too_many_requests) are tiered and persisted: server/bot.js, wired by server/security.js.

// Observed quirk (spec §5.4): unparseable integer params use a {msg} envelope (ParamError / intParam, server/trade-api.js).

function createApp({ db, engine, hub, rate = { burst: 300, perSec: 150 }, rollingWindowSec, perps, combos, sports, auth: authOptions, keyDir, security: securityOptions, identity: identityOptions, payments: paymentsOptions, marketsContent, push: pushOptions, cms: cmsOptions, flags: flagsOptions, playMode: playModeOptions, centralBank: centralBankOptions, api: apiOptions = {}, env = 'main' }) {
  journal.migrate(db); // opening balances for databases (or seeded accounts) that predate the journal
  const app = express();
  app.set('trust proxy', false);
  app.disable('x-powered-by');
  // Perimeter (server/security.js, CLONE_SPEC §21): headers + CSP nonce, CORS, honeypots, robots.txt, CSP reports,
  // bot challenge verify and client-token bootstrap — before body parsing and the session / CSRF middleware.
  const security = createSecurity({ app, db, rate, parseCookies, options: { ...(securityOptions || {}), dataDir: keyDir } });
  app.locals.security = security;
  app.use(security.early);
  app.use(jsonBody()); // JSON bodies with per-route size limits (server/validate.js, PLAN P1.8)
  // Payment provider webhooks (server/payments.js): server-to-server, authenticated by their HMAC signature over the raw
  // body, so they run before the session, CSRF and client-token middleware.
  app.post('/v1/payments/webhooks/:provider', (req, res, next) => (app.locals.payments ? app.locals.payments.webhookRoute(req, res, next) : next(E.notFound())));

  // ---------- helpers ----------
  const q = engine.quote.bind(engine);
  const marketsOf = (eventTicker) => db.prepare('SELECT * FROM markets WHERE event_ticker=? ORDER BY rowid').all(eventTicker).map((m) => marketVo(m, q(m.ticker)));
  const getEvent = (t) => db.prepare('SELECT * FROM events WHERE ticker=?').get(t);
  const getSeries = (t) => db.prepare('SELECT * FROM series WHERE ticker=?').get(t);
  let sportsApi = null; // live sports scoreboards (server/sports.js), mounted below
  const eventFull = (e) => {
    const s = getSeries(e.series_ticker);
    const vo = eventVo(e, marketsOf(e.ticker));
    vo.series_title = s.title;
    vo.series_slug = s.slug;
    vo.tags = JSON.parse(s.tags);
    vo.frequency = s.frequency;
    admin.decorateEvent(vo); // CMS: icon colour + news items (server/admin.js)
    vo.dollar_volume = vo.markets.reduce((a, m) => a + Number(m.dollar_volume || 0), 0);
    vo.close_time = vo.markets.filter((m) => m.status !== 'finalized').map((m) => m.close_time).sort()[0] || vo.markets[0]?.close_time;
    vo.total_volume_fp = fp(vo.markets.reduce((a, m) => a + Number(m.volume_fp), 0));
    if (sportsApi) sportsApi.decorate(vo); // live_data for events linked to a game (server/sports.js)
    return vo;
  };

  const publicUser = (u) => ({ user_id: u.id, email: u.email, display_name: u.display_name, is_admin: !!u.is_admin, created_at: u.created_at });

  // Sessions, login CSRF, step-up, login hardening, two-factor, first-admin setup (server/auth.js, CLONE_SPEC §22).
  const auth = createAuth({ db, engine, options: authOptions, keyDir });
  app.locals.auth = auth;
  // Feature flags (server/flags.js, CLONE_SPEC.md §33): evaluated per request; modules ask engine.flags.on()/jobOn().
  const flags = createFlags({ db, engine, options: flagsOptions || {} });
  app.locals.flags = flags; engine.flags = flags;
  app.use(auth.attach); // req.auth from the session cookie; session CSRF on writes, login CSRF on pre-session endpoints
  app.use('/v1', auth.guard); // step-up verification for sensitive actions; privilege-change session rotation
  // Public Trade API (CLONE_SPEC.md §35): a signed request is verified first (req.apiPrincipal), so the perimeter limiter
  // below charges the key's own rate tier instead of the per-IP budget. The gate exists once server/trade-api.js is mounted.
  const apiKeys = createApiKeys({ db, env, options: apiOptions, security, flags });
  app.locals.apiKeys = apiKeys;
  let tradeApi = null;
  app.use('/trade-api', (req, res, next) => (tradeApi ? tradeApi.authGate(req, res, next) : next()));
  app.use(['/v1', '/trade-api'], security.apiGuard); // tiered rate limits; signed client token on /v1 writes (server/bot.js)
  // Feature flags + money controls: 403 feature_disabled / deposits_revoked / … before any route runs (CLONE_SPEC.md §33).
  app.use('/v1', flags.gate);
  // Isolated card tokenizer (server/payments.js): its own raw-body parser, outside the /v1 router and its middleware.
  app.post('/v1/payments/tokenize/card', (req, res, next) => (app.locals.payments ? app.locals.payments.tokenizeRoute(req, res) : next(E.notFound())));

  const requireUser = (req, res, next) => {
    if (!req.auth) return next(E.unauthorized());
    if (req.params.uid && req.params.uid !== req.auth.user.id) return next(E.forbidden('cannot access another user'));
    next();
  };
  const requireAdmin = (req, res, next) => (req.auth && req.auth.user.is_admin ? next() : next(req.auth ? E.forbidden('admin only') : E.unauthorized()));

  const v2 = express.Router();
  const v1 = express.Router();
  // Body schemas for high-risk writes (server/validate.js, PLAN P1.8). Registered first so admin-mounted routes are covered.
  v1.use(validateRoutes({ rolesOf: (u) => admin.rolesOf(u) }));
  // Admin + CMS first: its v1 middleware (locks, bans, feature switches, CMS decorators) must run before later routes.
  const admin = mountAdmin({ v1, app, db, engine, notify: (...a) => feat.notify(...a), eventFull, rate, rollingWindowSec });
  security.mountAdminRoutes({ v1, can: admin.can }); // Admin › Security event log
  auth.initAuditChain(); // admin_audit exists now: add chain columns, seal pre-chain rows (server/audit-chain.js)
  // Idempotency-Key replay for orders, deposits, withdrawals, transfers, RFQ accept (server/idempotency.js, PLAN P1.9).
  v1.use(idempotency({ db }).middleware);
  // Identity, onboarding, KYC and compliance (server/identity.js, CLONE_SPEC.md §25): its gate on trading, deposits and
  // withdrawals (identity verification, location, fraud holds) runs here, after idempotency; its routes follow.
  app.locals.identity = mountIdentity({ v1, app, db, engine, auth, admin, security, keyDir, notify: (...a) => feat.notify(...a), options: identityOptions });
  const feat = mountFeatures({ v1, db, engine, requireUser, eventFull, getEvent });
  app.use('/v1', feat.sessionMiddleware);
  // Payments, sandbox only (CLONE_SPEC.md §26): rails, webhooks, limits, AML, reconciliation, ledger audit, Admin › Payments.
  app.locals.payments = mountPayments({ v1, db, engine, auth, admin, identity: app.locals.identity, security, feat, keyDir, options: paymentsOptions || {} });
  // Phase 2 community: post extras, stickers, mutes, topics, Inner Circle, group chats, notification matrix (§24).
  // Web Push (CLONE_SPEC.md §31): VAPID keys, browser subscriptions, encrypted outbox; the Push channel delivers through it.
  app.locals.webpush = mountWebPush({ v1, db, engine, requireUser, keyDir, options: pushOptions || {}, template: (k, v) => app.locals.cms?.renderSystem(k, v) });
  const community = mountCommunity({ v1, app, db, engine, feat, admin, requireUser, getEvent, webpush: app.locals.webpush });
  app.locals.rolling = mountRolling({ v1, db, engine, windowSec: admin.rollingWindowSec() ?? rollingWindowSec }); // window editable live (G7)
  mountPerps({ v1, db, engine, requireUser, requireAdmin, notify: feat.notify, options: perps });
  mountCombos({ v1, db, engine, requireUser, notify: feat.notify, eventFull, checkTrading: feat.checkTrading, options: combos });
  const historyApi = mountHistory({ v1, db, requireUser });
  // Account area: preferences, consent, connected apps, activity, documents, rewards, promo codes (server/account-area.js).
  app.locals.accountArea = mountAccountArea({ v1, db, engine, auth, admin, identity: app.locals.identity, history: historyApi, requireUser, notify: (...a) => feat.notify(...a), keyDir });
  const ordersApi = mountOrders({ v1, db, engine, requireUser, notify: feat.notify });
  mountPositions({ v1, db, engine, requireUser });
  app.locals.marketsContent = mountMarketsContent({ v1, db, engine, auth, admin, identity: app.locals.identity, feat, security, requireUser, eventFull, getEvent, options: marketsContent || {} });
  app.locals.tradingCore = mountTradingCore({ v1, db, engine, auth, admin, requireUser, notify: feat.notify });
  app.locals.cms = mountCms({ v1, app, db, engine, admin, auth, options: cmsOptions || {} }); // texts, templates, media, pages, branding (§32)
  // Phase 5D (CLONE_SPEC.md §33): flag admin + bundle, play mode and money controls, Central Bank and the Vault Heist.
  mountFlags({ v1, db, flags, admin, auth, identity: app.locals.identity });
  app.locals.centralBank = mountCentralBank({ v1, db, engine, auth, admin, flags, feat, keyDir, options: centralBankOptions || {} });
  app.locals.playMode = mountPlayMode({ v1, app, db, engine, auth, admin, flags, feat, payments: app.locals.payments, centralBank: app.locals.centralBank, keyDir, options: playModeOptions || {} });
  // Phase 6 (CLONE_SPEC.md §34): margin tiers / risk limits / APY / waitlist / referral settings, the user side of the
  // waitlist, APY and referrals. After the Central Bank (the treasury pays APY and rewards in production) and play mode.
  app.locals.perpsOps = mountPerpsOps({ v1, db, engine, auth, admin, flags, feat, centralBank: app.locals.centralBank, cms: app.locals.cms, security, options: perps || {} });
  // Every send goes through the templates (CLONE_SPEC.md §32.5): in-app (features.notify), email and push (notify-prefs),
  // account emails (auth, identity), the phone code SMS and the push test (identity, webpush).
  feat.hooks.notifyTemplate = (type, msg) => app.locals.cms.renderNotification(type, msg);
  auth.hooks.template = (k, v) => app.locals.cms.renderSystem(k, v);
  // Simulated live sports (CLONE_SPEC.md §19): on with `sports: {speed,…}`, SPORTS=1, or by default from the CLI.
  const sportsOpts = sports ?? (process.env.SPORTS === '1' ? {} : null);
  if (sportsOpts) sportsApi = mountSports({ v1, db, engine, eventFull, getEvent, options: sportsOpts });
  // Phase 7 (CLONE_SPEC.md §35): Account › API keys, Admin › API keys (tiers, revoke, usage), key notifications.
  mountApiKeys({ v1, db, engine, auth, admin, flags, feat, cms: app.locals.cms, apiKeys, security });
  community.attachChat(mountChat({ v1, app, db, engine, requireUser, rolesOf: admin.rolesOf, notify: feat.notify })); // event live chat (CLONE_SPEC.md §20) + reactions / edits (§24)

  // Trade API v2 (CLONE_SPEC.md §35): market data, portfolio, orders (batch, amend, decrease), order groups, history,
  // RFQ, multivariate collections and Perps under /margin — one registry for routes, OpenAPI and contract tests.
  const registry = createRegistry();
  app.locals.apiRegistry = registry;
  tradeApi = mountTradeApi({ app, v2, v1, db, engine, auth, flags, feat, admin, security, apiKeys, ordersApi, eventFull, registry, env });
  app.locals.tradeApi = tradeApi;
  engine.apiOps = { resetForProduction: () => tradeApi.resetForProduction(), afterReset: () => apiKeys.events.emit('production_reset') };

  // ======================= Web client API v1 =======================
  // /session, /users (sign-up), /log_in, /log_in_mfa, /log_out, two-factor, sessions, step-up (server/auth.js).
  auth.mountRoutes({ v1, requireUser, notify: feat.notify, rolesOf: admin.rolesOf, publicUser });

  v1.get('/users/:uid', requireUser, (req, res) => res.json({ user: publicUser(req.auth.user) }));

  // Settings (spec §8.2 keys, persisted server-side).
  v1.get('/users/:uid/properties', requireUser, (req, res) => {
    const props = {};
    for (const r of db.prepare('SELECT key,value FROM user_settings WHERE user_id=?').all(req.auth.user.id)) props[r.key] = JSON.parse(r.value);
    res.json({ properties: props });
  });
  v1.put('/users/:uid/properties', requireUser, (req, res) => {
    const body = req.body && req.body.properties;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw E.badRequest('properties object required');
    tx(db, () => {
      for (const [k, v] of Object.entries(body)) {
        if (!SETTING_KEYS.has(k)) throw E.badRequest(`unknown property ${k}`);
        const s = JSON.stringify(v);
        if (s.length > 2000) throw E.badRequest(`property ${k} too large`);
        db.prepare('INSERT INTO user_settings(user_id,key,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(req.auth.user.id, k, s, nowIso());
      }
    });
    res.json({ ok: true });
  });

  function portfolioValueCents(uid) {
    let v = 0;
    for (const p of db.prepare('SELECT * FROM positions WHERE user_id=? AND (yes_count>0 OR no_count>0)').all(uid)) {
      const qq = q(p.market_ticker);
      const mark = qq.last_price_cc ?? P.CC / 2;
      v += p.yes_count * mark + p.no_count * (P.CC - mark); // units × cc
    }
    return Math.round(v / (UNITS * P.CC_PER_CENT));
  }

  v1.get('/users/:uid/balance', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const resting = db.prepare("SELECT COALESCE(SUM(reserved_cents),0) c FROM orders WHERE user_id=? AND status='resting'").get(uid).c;
    res.json({ balance_dollars: dollars(engine.balance(uid)), reserved_dollars: dollars(resting), portfolio_value_dollars: dollars(portfolioValueCents(uid)) });
  });

  // POST deposits / withdrawals: with method_id a payment rail, without it the demo-funds method (server/payments.js).
  v1.post('/users/:uid/deposits', requireUser, (req, res) => app.locals.payments.generic.deposit(req, res));
  v1.post('/users/:uid/withdrawals', requireUser, (req, res) => app.locals.payments.generic.withdraw(req, res));

  // Contract sizes (spec §16.4): `count` (number, ≤2 decimals) or `count_fp` (string); stored as units.
  function parseCount(b) {
    const raw = b.count_fp != null ? b.count_fp : b.count;
    if (raw == null || raw === '') throw E.badRequest('count is required');
    const u = toUnits(raw);
    if (u == null) throw E.badRequest('count must be a number of contracts with at most 2 decimal places');
    if (u < 1) throw E.badRequest('count must be at least 0.01 contracts');
    if (b.count_fp != null && b.count != null && toUnits(b.count) !== u) throw E.badRequest('count and count_fp must match');
    return u;
  }
  // Limit price (spec §5.1, CLONE_SPEC.md §28.1): `price_dollars` (4-decimal dollar string) or `price` in cents (a whole
  // number, or with decimals on sub-cent grids, e.g. 45.3). Returns cc, or null when absent.
  function parsePrice(b) {
    if (b.price_dollars != null && b.price_dollars !== '') {
      const cc = P.ccFromDollars(b.price_dollars);
      if (cc == null) throw E.badRequest('price_dollars must be a dollar amount with at most 4 decimals');
      return cc;
    }
    if (b.price == null || b.price === '') return null;
    const cc = P.ccFromCents(b.price);
    if (cc == null) throw E.badRequest('price must be a number of cents (up to 2 decimals on sub-cent markets)');
    return cc;
  }
  const tradePref = (uid, key) => { const r = db.prepare('SELECT value FROM user_settings WHERE user_id=? AND key=?').get(uid, key); try { return r ? JSON.parse(r.value) === true : false; } catch { return false; } };
  app.locals.tradePref = tradePref;
  v1.post('/users/:uid/orders', requireUser, (req, res) => {
    const b = { ...(req.body || {}) };
    const uid = req.auth.user.id;
    const type = b.type || 'limit';
    if (!['limit', 'market', 'dollars'].includes(type)) throw E.badRequest('type must be limit, market or dollars');
    const action = b.action || 'buy';
    if (!['buy', 'sell'].includes(action)) throw E.badRequest('action must be buy or sell');
    if (!['yes', 'no'].includes(b.side)) throw E.badRequest('side must be yes or no');
    const ticker = String(b.ticker || '');
    const mk = db.prepare('SELECT fractional_trading_enabled f, price_level_structure pls FROM markets WHERE ticker=?').get(ticker);
    if (!mk) throw E.notFound();
    if (!flags.on('trading.fractional', { req })) mk.f = 0; // fractional trading flag off: whole contracts only (§33)
    let pcc = parsePrice(b);
    let units = type === 'dollars' ? null : parseCount(b);
    let allowFractional = false;
    let flipUnits = 0;
    const wholeOnly = (u) => { if (u % UNITS !== 0 && !mk.f && !allowFractional) throw new ApiError(400, 'fractional_not_enabled', 'fractional contracts are not enabled on this market', 'order a whole number of contracts'); };
    // Selling YES at p is buying NO at 100-p; the bought contracts net against the held ones for $1 a pair (spec §15.4).
    let side = b.side;
    if (action === 'sell') {
      const pos = db.prepare('SELECT yes_count, no_count FROM positions WHERE user_id=? AND market_ticker=?').get(uid, ticker) || { yes_count: 0, no_count: 0 };
      const held = b.side === 'yes' ? pos.yes_count : pos.no_count;
      if (type === 'dollars') throw E.badRequest('sell orders take a contract count, not a dollar amount');
      if (units > held) {
        // A8 flip sell (Settings › Trade mechanics, CLONE_SPEC.md §28.5): selling more than held closes the position and
        // buys the other side for the remainder — the same single order, since the bought contracts net against the held
        // ones first. Without the setting the old rule stands.
        if (!flags.on('trading.flip_sell', { req })) throw flags.disabledError('trading.flip_sell'); // flag (§33)
        if (!tradePref(uid, 'trade_flip_sell')) throw E.conflict('insufficient_position', 'you cannot sell more contracts than you hold', `you hold ${ustr(held)} ${b.side.toUpperCase()}; turn on Flip sell in Settings to sell more and buy the other side`);
        flipUnits = units - held;
        allowFractional = !!mk.f || flipUnits % UNITS === 0;
      } else allowFractional = units === held; // a held fractional position can always be closed in full
      side = b.side === 'yes' ? 'no' : 'yes';
      if (type === 'limit') { if (pcc == null || pcc < 1 || pcc >= P.CC) throw E.badRequest(CS.t('error.price_range', { min: C.priceCents(1), max: C.priceCents(99) })); pcc = P.CC - pcc; }
    }
    if (units != null) wholeOnly(units);
    let tif = type === 'limit' ? 'gtc' : 'ioc';
    // Good-til-time (spec §17.10): limit orders may carry expiration_time; IOC types may not.
    const expiration = parseExpiry(b.expiration_time);
    if (expiration != null && type !== 'limit') throw E.badRequest('expiration_time is only valid on limit orders');
    if (type === 'limit' && pcc == null) throw E.badRequest('a limit order needs price or price_dollars');
    if (type === 'market') pcc = P.maxPrice(mk.pls); // protective limit at the top of the grid (99¢ on whole-cent markets)
    let maxCost = null;
    if (type === 'dollars') {
      // Spend up to amount_dollars at the current best ask (fee included), immediate-or-cancel.
      // Fractional markets buy down to 0.01 contracts; whole-contract markets round down to whole contracts.
      const amt = Math.round(Number(b.amount_dollars) * 100);
      if (!Number.isFinite(amt) || amt < 1) throw E.badRequest(CS.t('error.amount_min', { min: C.moneyCents(1) }));
      const qq = engine.quote(ticker);
      const ask = side === 'yes' ? qq.yes_ask_cc : qq.no_ask_cc;
      if (ask == null) throw E.conflict('no_liquidity', 'there are no offers to buy from right now');
      const m = engine.market(ticker);
      const per = ask + perContractFeeCapCc(ask, m.fee_multiplier) * P.CC_PER_CENT; // cc per contract, fee bound included
      units = Math.floor((amt * P.CC) / per);
      if (!mk.f) units -= units % UNITS;
      if (units < 1) throw E.badRequest(`amount is below the price of ${mk.f ? '0.01 contracts' : 'one contract'} (${P.centsLabel(ask)} plus fee)`);
      pcc = ask;
      maxCost = amt;
    }
    if (Number.isInteger(pcc) && units > 0) feat.checkTrading(uid, Math.ceil((units * pcc) / P.CC));
    const order = engine.placeOrder(uid, { ticker, side, price_cc: pcc, count: units, time_in_force: tif, client_order_id: b.client_order_id, max_cost_cents: maxCost, allow_fractional: allowFractional, action, order_type: type, expiration_ts: expiration ?? null, flip_units: flipUnits,
      post_only: b.post_only === true, source: req.apiChannel || 'user' }); // apiChannel: the public API / FIX dispatch (server/trade-api.js), never a client value
    const fa = db.prepare('SELECT COALESCE(SUM(count),0) n, COALESCE(SUM(count*price_cc),0) v FROM fills WHERE order_id=? AND user_id=?').get(order.id, uid);
    res.status(201).json({ order: orderVo(order), status: order.status, fill_avg_price_dollars: fa.n ? P.ccToDollars(Math.round(fa.v / fa.n)) : null, ...(flipUnits ? { flip: { closed_fp: ufp(units - flipUnits), opened_side: side, opened_fp: ufp(flipUnits) } } : {}) });
  });
  v1.delete('/users/:uid/orders/:oid', requireUser, (req, res) => res.json({ order: orderVo(engine.cancelOrder(req.auth.user.id, req.params.oid)) }));
  v1.get('/users/:uid/orders', requireUser, (req, res) => {
    const st = req.query.status;
    if (st && !['resting', 'executed', 'canceled'].includes(st)) throw E.badRequest('invalid status filter');
    const rows = db.prepare(`SELECT o.*, m.title mt FROM orders o JOIN markets m ON m.ticker=o.market_ticker WHERE o.user_id=? ${st ? 'AND o.status=?' : ''} ORDER BY o.seq DESC LIMIT 500`).all(...[req.auth.user.id, ...(st ? [st] : [])]);
    res.json({ orders: rows.map((o) => ordersApi.richVo(o)) });
  });

  v1.get('/users/:uid/positions', requireUser, (req, res) => {
    const rows = db.prepare('SELECT p.*, m.title, m.yes_sub_title, m.status, m.event_ticker, m.mve_collection_ticker FROM positions p JOIN markets m ON m.ticker=p.market_ticker WHERE p.user_id=? ORDER BY p.updated_at DESC').all(req.auth.user.id);
    res.json({ positions: rows.map((p) => {
      const qq = q(p.market_ticker);
      const mark = qq.last_price_cc ?? P.CC / 2;
      const held = p.yes_count > 0 ? 'yes' : p.no_count > 0 ? 'no' : null;
      const count = p.yes_count || p.no_count; // units
      const cost = p.yes_cost_cents + p.no_cost_cents;
      const value = Math.round((p.yes_count * mark + p.no_count * (P.CC - mark)) / (UNITS * P.CC_PER_CENT));
      return { ticker: p.market_ticker, event_ticker: p.event_ticker, market_title: p.title, outcome: p.yes_sub_title, market_status: p.status, is_combo: !!p.mve_collection_ticker, side: held, position_fp: ufp(count), total_cost_dollars: dollars(cost), avg_price_dollars: count ? P.ccToDollars(Math.round((cost * UNITS * P.CC_PER_CENT) / count)) : null, market_value_dollars: dollars(value), unrealized_pnl_dollars: dollars(value - cost), realized_pnl_dollars: dollars(p.realized_pnl_cents), fees_paid_dollars: dollars(p.fees_paid_cents) };
    }) });
  });

  v1.get('/users/:uid/fills', requireUser, (req, res) => {
    const rows = db.prepare('SELECT * FROM fills WHERE user_id=? ORDER BY created_ts DESC, rowid DESC LIMIT 500').all(req.auth.user.id);
    res.json({ fills: rows.map(fillVo) });
  });
  v1.get('/users/:uid/settlement_history', requireUser, (req, res) => {
    const rows = db.prepare('SELECT s.*, m.title FROM settlements s JOIN markets m ON m.ticker=s.market_ticker WHERE s.user_id=? ORDER BY s.created_at DESC').all(req.auth.user.id);
    res.json({ settlements: rows.map((s) => ({ ticker: s.market_ticker, market_title: s.title, market_result: s.result, yes_count_fp: ufp(s.yes_count), no_count_fp: ufp(s.no_count), revenue_dollars: dollars(s.effective_payout_cents ?? s.payout_cents), cost_dollars: dollars(s.cost_cents), settled_time: s.created_at,
      settlement_value_dollars: P.ccToDollars(s.settlement_value_cc), original_revenue_dollars: dollars(s.payout_cents), corrected_time: s.corrected_at || null })) }); // G6 corrections (CLONE_SPEC.md §28.7)
  });
  const ledgerRows = (uid) => db.prepare('SELECT * FROM ledger WHERE user_id=? ORDER BY created_at DESC, rowid DESC').all(uid);
  v1.get('/users/:uid/transactions', requireUser, (req, res) => res.json({ transactions: ledgerRows(req.auth.user.id).map((l) => ({ id: l.id, kind: l.kind, amount_dollars: dollars(l.amount_cents), ref: l.ref, memo: l.memo, created_time: l.created_at })) }));
  // File format (spec §9, U8 design choice): CSV of ledger entries.
  v1.get('/users/:uid/transactions.csv', requireUser, (req, res) => {
    const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const lines = [`time,type,${C.csvCol('amount', 'amount_usd')},reference,memo`, ...ledgerRows(req.auth.user.id).map((l) => [l.created_at, l.kind, C.csvCents(l.amount_cents), l.ref || '', l.memo].map(esc).join(','))];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="parlance-transactions.csv"');
    res.send(lines.join('\n') + '\n');
  });

  // Watchlist (U14: server-persisted).
  v1.get('/users/:uid/watchlist', requireUser, (req, res) => {
    const rows = db.prepare('SELECT e.* FROM watchlist w JOIN events e ON e.ticker=w.event_ticker WHERE w.user_id=? ORDER BY w.created_at DESC').all(req.auth.user.id);
    res.json({ events: rows.map(eventFull) });
  });
  v1.put('/users/:uid/watchlist/:event', requireUser, (req, res) => {
    if (!getEvent(req.params.event)) throw E.notFound();
    db.prepare('INSERT INTO watchlist(user_id,event_ticker,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(req.auth.user.id, req.params.event, nowIso());
    res.json({ ok: true });
  });
  v1.delete('/users/:uid/watchlist/:event', requireUser, (req, res) => {
    db.prepare('DELETE FROM watchlist WHERE user_id=? AND event_ticker=?').run(req.auth.user.id, req.params.event);
    res.json({ ok: true });
  });
  v1.post('/users/:uid/recently_visited', requireUser, (req, res) => {
    const t = String((req.body && req.body.event_ticker) || '');
    if (!getEvent(t)) throw E.notFound();
    db.prepare('INSERT INTO recently_visited(user_id,event_ticker,visited_at) VALUES(?,?,?) ON CONFLICT(user_id,event_ticker) DO UPDATE SET visited_at=excluded.visited_at').run(req.auth.user.id, t, nowIso());
    res.json({ ok: true });
  });
  v1.get('/users/:uid/recently_visited', requireUser, (req, res) => {
    const rows = db.prepare('SELECT e.* FROM recently_visited r JOIN events e ON e.ticker=r.event_ticker WHERE r.user_id=? ORDER BY r.visited_at DESC LIMIT 10').all(req.auth.user.id);
    res.json({ events: rows.map((e) => eventVo(e)) });
  });

  // BFF home (spec §4.2 / HAR2#1 structure, own fields).
  function eventCards() {
    // Combo (multivariate) events are reached through /combos and portfolios, not discovery lists (spec §17.2).
    return db.prepare('SELECT * FROM events WHERE series_ticker<>? ORDER BY rowid').all(COMBO_SERIES).map(eventFull);
  }
  const lead = (ev) => ev.markets.reduce((a, m) => (Number(m.last_price_dollars || 0) > Number(a.last_price_dollars || 0) ? m : a), ev.markets[0]);
  const delta = (m) => Math.round((Number(m.last_price_dollars || 0) - Number(m.previous_price_dollars || 0)) * 100);
  v1.get('/bff/home', (req, res) => {
    const evs = eventCards();
    const open = evs.filter((e) => e.markets.some((m) => m.status === 'active'));
    const rows = open.map((e) => ({ event: e, market: lead(e) }));
    const byVol = [...rows].sort((a, b) => Number(b.event.total_volume_fp) - Number(a.event.total_volume_fp));
    const movers = [...rows].sort((a, b) => Math.abs(delta(b.market)) - Math.abs(delta(a.market)));
    const brief = (r) => ({ event_ticker: r.event.event_ticker, series_ticker: r.event.series_ticker, series_slug: r.event.series_slug, title: r.event.title, sub_title: r.market.yes_sub_title, price_dollars: r.market.last_price_dollars, delta_cents: delta(r.market) });
    res.json({
      home: {
        highlights: open.filter((e) => e.featured),
        top_markets: byVol.slice(0, 6).map((r) => r.event),
        trending: byVol.slice(0, 3).map(brief),
        top_movers: movers.slice(0, 3).map(brief),
        new: [...open].reverse().slice(0, 3).map((e) => brief({ event: e, market: lead(e) })),
        top_categories: CATEGORIES,
        // Redesigned home (spec §15.2): upcoming strip, hubs, per-category sections, featured list.
        upcoming: [...open].filter((e) => !e.series_ticker.startsWith('PLXFLASH')).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time)).slice(0, 8)
          .map((e) => ({ event_ticker: e.event_ticker, series_ticker: e.series_ticker, series_slug: e.series_slug, title: e.title, category: e.category, tag: e.tags[0] || e.category, close_time: e.close_time })),
        hubs: [['Elections', 'Harbor Elections Hub'], ['Companies', 'Public Companies Hub']].map(([cat, title]) => ({ category: cat, title, dollar_volume: evs.filter((e) => e.category === cat).reduce((a, e) => a + e.dollar_volume, 0), events: evs.filter((e) => e.category === cat).length })),
        sections: CATEGORIES.map((c) => ({ category: c, events: byVol.filter((r) => r.event.category === c).slice(0, 4).map((r) => r.event) })).filter((s) => s.events.length),
        featured_list: byVol.filter((r) => r.event.category === 'Elections').slice(0, 3).map(brief),
      },
    });
  });

  // Related events for the event page (spec §15.4: series tabs, "People are also trading").
  v1.get('/events/:ticker/related', (req, res) => {
    const e = getEvent(req.params.ticker);
    if (!e) throw E.notFound();
    const all = eventCards().filter((x) => x.event_ticker !== e.ticker && x.markets.some((m) => m.status === 'active'));
    const series = all.filter((x) => x.series_ticker === e.series_ticker && !x.series_ticker.startsWith('PLXFLASH'));
    const also = all.filter((x) => x.category === e.category && x.series_ticker !== e.series_ticker).sort((a, b) => b.dollar_volume - a.dollar_volume);
    const rest = all.filter((x) => x.category !== e.category && !x.series_ticker.startsWith('PLXFLASH')).sort((a, b) => b.dollar_volume - a.dollar_volume);
    res.json({ series_events: series, people_also_trading: [...also, ...rest].slice(0, 6).map((x) => ({ event_ticker: x.event_ticker, series_ticker: x.series_ticker, series_slug: x.series_slug, title: x.title, category: x.category })) });
  });

  v1.get('/live_data/count', (req, res) => res.json({ count: db.prepare("SELECT COUNT(DISTINCT e.ticker) c FROM events e JOIN markets m ON m.event_ticker=e.ticker WHERE e.is_live=1 AND m.status='active'").get().c }));

  // Search / browse (spec §4.5).
  v1.get('/search/series', (req, res) => {
    const pageSize = intParam(req.query, 'page_size', { def: 24, min: 1, max: 100, op: 'SearchSeries' });
    const order = req.query.order_by || 'event-volume';
    if (!['event-volume', 'newest', 'closing-soon', 'trending'].includes(order)) throw E.badRequest('invalid order_by');
    const status = req.query.status || 'open';
    if (!['open', 'closed', 'settled', 'unopened', 'all'].includes(status)) throw E.badRequest('invalid status filter');
    const cur = decCursor(req.query.cursor);
    const query = String(req.query.query || '').trim().toLowerCase();
    const cat = req.query.category ? String(req.query.category) : null;
    if (cat && !CATEGORIES.some((c) => c.toLowerCase() === cat.toLowerCase())) throw E.badRequest('unknown category');
    let evs = eventCards();
    if (cat) evs = evs.filter((e) => e.category.toLowerCase() === cat.toLowerCase());
    if (req.query.frequency) { const fq = String(req.query.frequency); evs = evs.filter((e) => e.frequency === fq); }
    if (req.query.tag) { const tg = String(req.query.tag).toLowerCase(); evs = evs.filter((e) => e.tags.some((x) => x.toLowerCase() === tg)); }
    if (status !== 'all') {
      const st = STATUS_FILTER[status];
      evs = evs.filter((e) => e.markets.some((m) => st.includes(m.status)));
    }
    if (query) evs = evs.filter((e) => [e.title, e.sub_title, e.series_title, e.category, ...e.markets.map((m) => m.yes_sub_title)].join(' ').toLowerCase().includes(query));
    const closeOf = (e) => Math.min(...e.markets.map((m) => Date.parse(m.close_time)));
    const sorters = {
      'event-volume': (a, b) => Number(b.total_volume_fp) - Number(a.total_volume_fp),
      newest: (a, b) => b.event_ticker.localeCompare(a.event_ticker),
      'closing-soon': (a, b) => closeOf(a) - closeOf(b),
      trending: (a, b) => Math.abs(delta(lead(b))) - Math.abs(delta(lead(a))),
    };
    evs.sort(sorters[order]);
    const offset = cur ? cur.o : 0;
    const page = evs.slice(offset, offset + pageSize);
    res.json({ total_results_count: evs.length, current_page: page, next_cursor: offset + pageSize < evs.length ? encCursor({ o: offset + pageSize }) : '' });
  });

  // Admin lifecycle controls (spec §4.4).
  v1.post('/admin/markets/:ticker/:action', requireAdmin, (req, res) => {
    const t = req.params.ticker;
    switch (req.params.action) {
      case 'determine': engine.determine(t, req.body && req.body.result, { expiration_value: req.body && req.body.expiration_value }); break;
      case 'close': engine.close(t); break;
      case 'deactivate': engine.deactivate(t); break;
      case 'activate': engine.activate(t); break;
      default: throw E.notFound();
    }
    const m = db.prepare('SELECT * FROM markets WHERE ticker=?').get(t);
    res.json({ market: marketVo(m, q(t)) });
  });
  v1.post('/admin/exchange', requireAdmin, (req, res) => {
    engine.tradingActive = !!(req.body && req.body.trading_active);
    db.prepare("INSERT INTO meta(key,value) VALUES('trading_active',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(engine.tradingActive ? '1' : '0');
    res.json({ trading_active: engine.tradingActive });
  });

  // Internal dispatch for the public API and FIX (server/trade-api.js): the same gates as a web request, then the router.
  tradeApi.setChain([auth.guard, flags.gate, feat.sessionMiddleware, v1]);
  app.locals.routers = [['/trade-api/v2', v2], ['/v1', v1]]; // mount table for route enumeration (tests/authz.e2e.test.js)
  app.use('/trade-api/v2', v2);
  app.use('/v1', v1);
  app.use(['/v1', '/trade-api'], (req, res, next) => next(E.notFound()));

  // Static SPA: explicit allowlist, hashed immutable assets (dist) or sources (dev), page template with the CSP nonce and
  // boot proof, bot challenge for suspicious HTML requests; everything else 404 (server/security.js, P1.11/P1.12).
  app.locals.cms.mountStatic(app); // /content-bundle.js and /media/* (CLONE_SPEC.md §32.4, §32.6)
  security.mountStatic(app);

  // Error envelopes (spec §5.4).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    if (err instanceof ParamError) return res.status(400).json({ msg: err.message });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json(E.badRequest('malformed JSON body').toJSON());
    console.error(err);
    res.status(500).json({ error: { code: 'internal_server_error', message: 'internal server error' } });
  });

  return app;
}

module.exports = { createApp, parseCookies, SESSION_COOKIE };
