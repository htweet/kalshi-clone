'use strict';
const path = require('node:path');
const express = require('express');
const { tx } = require('./db');
const { nowIso, newId, token, dollars, fp, usd, ApiError, E, hashPassword, verifyPassword, encCursor, decCursor } = require('./util');
const { marketVo, eventVo, seriesVo, orderVo, fillVo } = require('./serialize');

const SESSION_COOKIE = 'plx_session';
const SESSION_DAYS = 30;
const CATEGORIES = ['Politics', 'Sports', 'Culture', 'Crypto', 'Climate', 'Economics', 'Companies', 'Financials', 'Tech & Science'];
const STATUS_FILTER = { unopened: ['initialized'], open: ['active'], paused: ['inactive'], closed: ['closed', 'determined'], settled: ['finalized'] };
const SETTING_KEYS = new Set(['theme', 'orderbook_settings', 'event_market_tab', 'event_bottom_tab', 'browse_order_by', 'portfolio_view', 'chart_range']);

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Token bucket per client IP (spec §5.4: 429 too_many_requests).
function rateLimiter({ burst, perSec }) {
  const buckets = new Map();
  return (req, res, next) => {
    const key = req.ip || 'local';
    const now = Date.now();
    const b = buckets.get(key) || { tokens: burst, ts: now };
    b.tokens = Math.min(burst, b.tokens + ((now - b.ts) / 1000) * perSec);
    b.ts = now;
    if (b.tokens < 1) { buckets.set(key, b); return next(E.tooMany()); }
    b.tokens -= 1;
    buckets.set(key, b);
    next();
  };
}

// Observed quirk (spec §5.4): unparseable integer params use a {msg} envelope.
class ParamError extends Error { constructor(msg) { super(msg); this.status = 400; } }
function intParam(q, name, { def, min, max, op = 'GetMarkets' } = {}) {
  if (q[name] === undefined || q[name] === '') return def;
  const s = String(q[name]);
  if (!/^-?\d+$/.test(s)) throw new ParamError(`Invalid format for parameter ${name}: error binding string parameter: parsing "${s}": invalid syntax`);
  const n = Number(s);
  if ((min != null && n < min) || (max != null && n > max)) throw new ParamError(`Parameter validation failed for ${op}: Key: '${op}Params.${name[0].toUpperCase()}${name.slice(1)}' Error:Field validation for '${name}' failed on the '${n < min ? 'gte' : 'lte'}' tag`);
  return n;
}

function createApp({ db, engine, hub, rate = { burst: 300, perSec: 150 } }) {
  const app = express();
  app.set('trust proxy', false);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  // ---------- helpers ----------
  const q = engine.quote.bind(engine);
  const marketsOf = (eventTicker) => db.prepare('SELECT * FROM markets WHERE event_ticker=? ORDER BY rowid').all(eventTicker).map((m) => marketVo(m, q(m.ticker)));
  const getEvent = (t) => db.prepare('SELECT * FROM events WHERE ticker=?').get(t);
  const getSeries = (t) => db.prepare('SELECT * FROM series WHERE ticker=?').get(t);
  const eventFull = (e) => {
    const s = getSeries(e.series_ticker);
    const vo = eventVo(e, marketsOf(e.ticker));
    vo.series_title = s.title;
    vo.series_slug = s.slug;
    vo.total_volume_fp = fp(vo.markets.reduce((a, m) => a + Number(m.volume_fp), 0));
    return vo;
  };

  function sessionFrom(req) {
    const tok = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!tok) return null;
    const s = db.prepare('SELECT * FROM sessions WHERE token=?').get(tok);
    if (!s || Date.parse(s.expires_at) < Date.now()) return null;
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id);
    return u ? { session: s, user: u } : null;
  }

  const publicUser = (u) => ({ user_id: u.id, email: u.email, display_name: u.display_name, is_admin: !!u.is_admin, created_at: u.created_at });

  function startSession(res, user) {
    const s = { token: token(), csrf: token(18) };
    db.prepare('INSERT INTO sessions(token,user_id,csrf_token,created_at,expires_at) VALUES(?,?,?,?,?)')
      .run(s.token, user.id, s.csrf, nowIso(), new Date(Date.now() + SESSION_DAYS * 86400000).toISOString());
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${s.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
    return s.csrf;
  }

  // Attach auth; enforce CSRF header on mutating requests made with a session.
  app.use((req, res, next) => {
    req.auth = sessionFrom(req);
    if (req.auth && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.get('x-csrf-token') !== req.auth.session.csrf_token) return next(E.forbidden('missing or invalid x-csrf-token'));
    }
    next();
  });
  const limiter = rateLimiter(rate);
  app.use(['/v1', '/trade-api'], limiter);

  const requireUser = (req, res, next) => {
    if (!req.auth) return next(E.unauthorized());
    if (req.params.uid && req.params.uid !== req.auth.user.id) return next(E.forbidden('cannot access another user'));
    next();
  };
  const requireAdmin = (req, res, next) => (req.auth && req.auth.user.is_admin ? next() : next(req.auth ? E.forbidden('admin only') : E.unauthorized()));

  const v2 = express.Router();
  const v1 = express.Router();

  // ======================= Trade API v2 (public market data) =======================
  v2.get('/exchange/status', (req, res) => res.json({ exchange_active: true, trading_active: engine.tradingActive }));

  v2.get('/markets', (req, res) => {
    const limit = intParam(req.query, 'limit', { def: 100, min: 1, max: 1000 });
    const cur = decCursor(req.query.cursor);
    const where = [];
    const args = [];
    if (req.query.status) {
      const st = STATUS_FILTER[req.query.status];
      if (!st) throw E.badRequest('invalid status filter');
      where.push(`status IN (${st.map(() => '?').join(',')})`);
      args.push(...st);
    }
    if (req.query.event_ticker) { where.push('event_ticker=?'); args.push(req.query.event_ticker); }
    if (req.query.series_ticker) { where.push('event_ticker IN (SELECT ticker FROM events WHERE series_ticker=?)'); args.push(req.query.series_ticker); }
    const offset = cur ? cur.o : 0;
    const rows = db.prepare(`SELECT * FROM markets ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY rowid LIMIT ? OFFSET ?`).all(...args, limit + 1, offset);
    const more = rows.length > limit;
    res.json({ cursor: more ? encCursor({ o: offset + limit }) : '', markets: rows.slice(0, limit).map((m) => marketVo(m, q(m.ticker))) });
  });

  v2.get('/markets/trades', (req, res) => {
    const limit = intParam(req.query, 'limit', { def: 100, min: 1, max: 1000, op: 'GetTrades' });
    const args = [];
    let where = '';
    if (req.query.ticker) { where = 'WHERE market_ticker=?'; args.push(req.query.ticker); }
    const rows = db.prepare(`SELECT * FROM trades ${where} ORDER BY created_ts DESC LIMIT ?`).all(...args, limit);
    res.json({ cursor: '', trades: rows.map((t) => ({ trade_id: t.id, ticker: t.market_ticker, yes_price_dollars: dollars(t.yes_price_cents), no_price_dollars: dollars(100 - t.yes_price_cents), count_fp: fp(t.count), taker_side: t.taker_side, created_time: new Date(t.created_ts).toISOString() })) });
  });

  v2.get('/markets/:ticker', (req, res) => {
    const m = db.prepare('SELECT * FROM markets WHERE ticker=?').get(req.params.ticker);
    if (!m) throw E.notFound();
    res.json({ market: marketVo(m, q(m.ticker)) });
  });

  v2.get('/markets/:ticker/orderbook', (req, res) => {
    if (!db.prepare('SELECT 1 FROM markets WHERE ticker=?').get(req.params.ticker)) throw E.notFound();
    const depth = intParam(req.query, 'depth', { def: 0, min: 0, max: 100, op: 'GetMarketOrderbook' });
    const b = engine.book(req.params.ticker);
    const lv = (map) => {
      let a = [...map.entries()].sort((x, y) => x[0] - y[0]);
      if (depth) a = a.slice(-depth);
      return a.map(([p, c]) => [dollars(p), fp(c)]);
    };
    res.json({ orderbook_fp: { yes_dollars: lv(b.yes), no_dollars: lv(b.no) } });
  });

  v2.get('/events', (req, res) => {
    const limit = intParam(req.query, 'limit', { def: 100, min: 1, max: 200, op: 'GetEvents' });
    const cur = decCursor(req.query.cursor);
    const offset = cur ? cur.o : 0;
    const args = [];
    const where = [];
    if (req.query.series_ticker) { where.push('series_ticker=?'); args.push(req.query.series_ticker); }
    if (req.query.status) {
      const st = STATUS_FILTER[req.query.status];
      if (!st) throw E.badRequest('invalid status filter');
      where.push(`ticker IN (SELECT event_ticker FROM markets WHERE status IN (${st.map(() => '?').join(',')}))`);
      args.push(...st);
    }
    const rows = db.prepare(`SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY rowid LIMIT ? OFFSET ?`).all(...args, limit + 1, offset);
    const nested = req.query.with_nested_markets === 'true';
    res.json({ cursor: rows.length > limit ? encCursor({ o: offset + limit }) : '', events: rows.slice(0, limit).map((e) => (nested ? eventFull(e) : eventVo(e))) });
  });

  v2.get('/events/:ticker', (req, res) => {
    const e = getEvent(req.params.ticker);
    if (!e) throw E.notFound();
    res.json({ event: eventFull(e) });
  });

  v2.get('/series/:ticker', (req, res) => {
    const s = getSeries(req.params.ticker);
    if (!s) throw E.notFound();
    res.json({ series: seriesVo(s) });
  });

  // Candlesticks built from persisted trades (spec §4.3 / HAR1#13 shape).
  v2.get('/series/:s/markets/:ticker/candlesticks', (req, res) => {
    const m = db.prepare('SELECT * FROM markets WHERE ticker=?').get(req.params.ticker);
    if (!m) throw E.notFound();
    const period = intParam(req.query, 'period_interval', { def: 60, op: 'GetMarketCandlesticks' });
    if (![1, 60, 1440].includes(period)) throw E.badRequest('period_interval must be one of 1, 60, 1440');
    const now = Math.floor(Date.now() / 1000);
    const end = intParam(req.query, 'end_ts', { def: now, op: 'GetMarketCandlesticks' });
    const start = intParam(req.query, 'start_ts', { def: end - 7 * 86400, op: 'GetMarketCandlesticks' });
    if (start >= end) throw E.badRequest('start_ts must be before end_ts');
    const step = period * 60;
    if ((end - start) / step > 5000) throw E.badRequest('too many candlesticks requested');
    const trades = db.prepare('SELECT yes_price_cents p, count c, created_ts ts FROM trades WHERE market_ticker=? AND created_ts>=? AND created_ts<? ORDER BY created_ts').all(m.ticker, start * 1000, end * 1000);
    const prevRow = db.prepare('SELECT yes_price_cents p FROM trades WHERE market_ticker=? AND created_ts<? ORDER BY created_ts DESC LIMIT 1').get(m.ticker, start * 1000);
    let prev = prevRow ? prevRow.p : null;
    const out = [];
    let i = 0;
    for (let t = start - (start % step) + step; t <= end - (end % step) + step; t += step) {
      const bucket = [];
      while (i < trades.length && trades[i].ts < t * 1000) bucket.push(trades[i++]);
      if (!bucket.length && prev == null) continue;
      const ps = bucket.map((b) => b.p);
      const vol = bucket.reduce((a, b) => a + b.c, 0);
      const o = ps.length ? ps[0] : prev;
      const c = ps.length ? ps[ps.length - 1] : prev;
      out.push({ end_period_ts: t, price: { open_dollars: dollars(o), high_dollars: dollars(ps.length ? Math.max(...ps) : prev), low_dollars: dollars(ps.length ? Math.min(...ps) : prev), close_dollars: dollars(c), mean_dollars: dollars(ps.length ? Math.round(ps.reduce((a, b) => a + b, 0) / ps.length) : prev), previous_dollars: dollars(prev) }, volume_fp: fp(vol) });
      prev = c;
    }
    res.json({ ticker: m.ticker, candlesticks: out });
  });

  // ======================= Web client API v1 =======================
  v1.get('/session', (req, res) => {
    if (!req.auth) return res.json({ user: null });
    res.json({ user: publicUser(req.auth.user), csrf_token: req.auth.session.csrf_token, balance_dollars: dollars(req.auth.user.balance_cents) });
  });

  v1.post('/users', (req, res) => {
    const { email, password, display_name } = req.body || {};
    const em = String(email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) throw E.badRequest('a valid email is required');
    if (typeof password !== 'string' || password.length < 8) throw E.badRequest('password must be at least 8 characters');
    const name = String(display_name || '').trim();
    if (name.length < 2 || name.length > 40) throw E.badRequest('display name must be 2-40 characters');
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(em)) throw E.conflict('email_taken', 'an account with this email already exists');
    const user = { id: newId('u_'), email: em, display_name: name };
    db.prepare('INSERT INTO users(id,email,display_name,password_hash,balance_cents,created_at) VALUES(?,?,?,?,0,?)').run(user.id, em, name, hashPassword(password), nowIso());
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    const csrf = startSession(res, u);
    res.status(201).json({ user: publicUser(u), csrf_token: csrf });
  });

  v1.post('/log_in', (req, res) => {
    const { email, password } = req.body || {};
    const u = db.prepare('SELECT * FROM users WHERE email=? AND is_system=0').get(String(email || '').trim().toLowerCase());
    if (!u || !verifyPassword(String(password || ''), u.password_hash)) throw new ApiError(401, 'invalid_credentials', 'incorrect email or password');
    const csrf = startSession(res, u);
    res.json({ user: publicUser(u), csrf_token: csrf });
  });

  v1.post('/log_out', (req, res) => {
    if (req.auth) db.prepare('DELETE FROM sessions WHERE token=?').run(req.auth.session.token);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({});
  });

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
      const mark = qq.last_price ?? 50;
      v += p.yes_count * mark + p.no_count * (100 - mark);
    }
    return v;
  }

  v1.get('/users/:uid/balance', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const resting = db.prepare("SELECT COALESCE(SUM(reserved_cents),0) c FROM orders WHERE user_id=? AND status='resting'").get(uid).c;
    res.json({ balance_dollars: dollars(engine.balance(uid)), reserved_dollars: dollars(resting), portfolio_value_dollars: dollars(portfolioValueCents(uid)) });
  });

  const moneyBody = (b) => {
    const a = Number(b && b.amount_dollars);
    if (!Number.isFinite(a) || a <= 0 || a > 100000 || Math.round(a * 100) !== a * 100) throw E.badRequest('amount_dollars must be a positive amount with at most 2 decimals, up to 100000');
    return Math.round(a * 100);
  };
  v1.post('/users/:uid/deposits', requireUser, (req, res) => {
    const cents = moneyBody(req.body);
    tx(db, () => engine.credit(req.auth.user.id, cents, 'deposit', null, 'simulated deposit'));
    engine.emit('user_balance', req.auth.user.id, engine.balance(req.auth.user.id));
    res.status(201).json({ balance_dollars: dollars(engine.balance(req.auth.user.id)) });
  });
  v1.post('/users/:uid/withdrawals', requireUser, (req, res) => {
    const cents = moneyBody(req.body);
    tx(db, () => {
      if (engine.balance(req.auth.user.id) < cents) throw E.conflict('insufficient_balance', 'insufficient balance');
      engine.credit(req.auth.user.id, -cents, 'withdrawal', null, 'simulated withdrawal');
    });
    engine.emit('user_balance', req.auth.user.id, engine.balance(req.auth.user.id));
    res.status(201).json({ balance_dollars: dollars(engine.balance(req.auth.user.id)) });
  });

  v1.post('/users/:uid/orders', requireUser, (req, res) => {
    const b = req.body || {};
    const type = b.type || 'limit';
    if (!['limit', 'market'].includes(type)) throw E.badRequest('type must be limit or market');
    let price = b.price;
    if (b.price_dollars != null) price = Math.round(Number(b.price_dollars) * 100);
    if (type === 'market') price = 99;
    const order = engine.placeOrder(req.auth.user.id, { ticker: String(b.ticker || ''), side: b.side, price, count: b.count, time_in_force: type === 'market' ? 'ioc' : 'gtc', client_order_id: b.client_order_id });
    res.status(201).json({ order: orderVo(order), status: order.status });
  });
  v1.delete('/users/:uid/orders/:oid', requireUser, (req, res) => res.json({ order: orderVo(engine.cancelOrder(req.auth.user.id, req.params.oid)) }));
  v1.get('/users/:uid/orders', requireUser, (req, res) => {
    const st = req.query.status;
    if (st && !['resting', 'executed', 'canceled'].includes(st)) throw E.badRequest('invalid status filter');
    const rows = db.prepare(`SELECT o.*, m.title mt FROM orders o JOIN markets m ON m.ticker=o.market_ticker WHERE o.user_id=? ${st ? 'AND o.status=?' : ''} ORDER BY o.seq DESC LIMIT 500`).all(...[req.auth.user.id, ...(st ? [st] : [])]);
    res.json({ orders: rows.map((o) => ({ ...orderVo(o), market_title: o.mt })) });
  });

  v1.get('/users/:uid/positions', requireUser, (req, res) => {
    const rows = db.prepare('SELECT p.*, m.title, m.yes_sub_title, m.status, m.event_ticker FROM positions p JOIN markets m ON m.ticker=p.market_ticker WHERE p.user_id=? ORDER BY p.updated_at DESC').all(req.auth.user.id);
    res.json({ positions: rows.map((p) => {
      const qq = q(p.market_ticker);
      const mark = qq.last_price ?? 50;
      const held = p.yes_count > 0 ? 'yes' : p.no_count > 0 ? 'no' : null;
      const count = p.yes_count || p.no_count;
      const cost = p.yes_cost_cents + p.no_cost_cents;
      const value = p.yes_count * mark + p.no_count * (100 - mark);
      return { ticker: p.market_ticker, event_ticker: p.event_ticker, market_title: p.title, outcome: p.yes_sub_title, market_status: p.status, side: held, position_fp: fp(count), total_cost_dollars: dollars(cost), avg_price_dollars: count ? dollars(Math.round(cost / count)) : null, market_value_dollars: dollars(value), unrealized_pnl_dollars: dollars(value - cost), realized_pnl_dollars: dollars(p.realized_pnl_cents), fees_paid_dollars: dollars(p.fees_paid_cents) };
    }) });
  });

  v1.get('/users/:uid/fills', requireUser, (req, res) => {
    const rows = db.prepare('SELECT * FROM fills WHERE user_id=? ORDER BY created_ts DESC, rowid DESC LIMIT 500').all(req.auth.user.id);
    res.json({ fills: rows.map(fillVo) });
  });
  v1.get('/users/:uid/settlement_history', requireUser, (req, res) => {
    const rows = db.prepare('SELECT s.*, m.title FROM settlements s JOIN markets m ON m.ticker=s.market_ticker WHERE s.user_id=? ORDER BY s.created_at DESC').all(req.auth.user.id);
    res.json({ settlements: rows.map((s) => ({ ticker: s.market_ticker, market_title: s.title, market_result: s.result, yes_count_fp: fp(s.yes_count), no_count_fp: fp(s.no_count), revenue_dollars: dollars(s.payout_cents), cost_dollars: dollars(s.cost_cents), settled_time: s.created_at })) });
  });
  const ledgerRows = (uid) => db.prepare('SELECT * FROM ledger WHERE user_id=? ORDER BY created_at DESC, rowid DESC').all(uid);
  v1.get('/users/:uid/transactions', requireUser, (req, res) => res.json({ transactions: ledgerRows(req.auth.user.id).map((l) => ({ id: l.id, kind: l.kind, amount_dollars: dollars(l.amount_cents), ref: l.ref, memo: l.memo, created_time: l.created_at })) }));
  // File format (spec §9, U8 design choice): CSV of ledger entries.
  v1.get('/users/:uid/transactions.csv', requireUser, (req, res) => {
    const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const lines = ['time,type,amount_usd,reference,memo', ...ledgerRows(req.auth.user.id).map((l) => [l.created_at, l.kind, usd(l.amount_cents), l.ref || '', l.memo].map(esc).join(','))];
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
    return db.prepare('SELECT * FROM events ORDER BY rowid').all().map(eventFull);
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
      },
    });
  });

  v1.get('/live_data/count', (req, res) => res.json({ count: db.prepare("SELECT COUNT(DISTINCT e.ticker) c FROM events e JOIN markets m ON m.event_ticker=e.ticker WHERE e.is_live=1 AND m.status='active'").get().c }));
  v1.get('/categories', (req, res) => res.json({ categories: CATEGORIES }));

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
      case 'determine': engine.determine(t, req.body && req.body.result); break;
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

  app.use('/trade-api/v2', v2);
  app.use('/v1', v1);
  app.use(['/v1', '/trade-api'], (req, res, next) => next(E.notFound()));

  // Static SPA.
  const pub = path.join(__dirname, '..', 'public');
  app.use(express.static(pub, { index: false, maxAge: 0 }));
  app.get(/^\/(?!v1\/|trade-api\/).*/, (req, res) => res.sendFile(path.join(pub, 'index.html')));

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
