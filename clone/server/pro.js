'use strict';
// Pro trading terminal (owner design 2026-11-15, CLONE_SPEC.md §15.6). The terminal reuses the exchange's own endpoints
// (orders, amend / cancel, positions, order book, trades, price alerts, WebSocket channels); this module adds what it
// needs on top, behind the `pro` feature flag (server/flags.js):
//   GET    /v1/pro/screener                        open markets filtered by category, closing time, volume, spread and
//                                                  24-hour move (public: signed-out visitors see the screener)
//   GET    /v1/pro/candles?ticker=&tf=             OHLC + volume candles for 1H / 1D / 1W / ALL (public), read from the
//                                                  market_candles table that triggers on `trades` keep (migration 0005)
//   GET    /v1/users/:uid/pro/screens              the member's saved screens (named filters)
//   POST   /v1/users/:uid/pro/screens              save a screen   { name, filters }
//   PUT    /v1/users/:uid/pro/screens/:id          rename / change it
//   DELETE /v1/users/:uid/pro/screens/:id          delete it
//   GET    /v1/users/:uid/pro/preferences          layout, active screen, one-click state
//   PUT    /v1/users/:uid/pro/preferences          { layout?, active_screen_id?, one_click?, confirm? }
// One-click safety rule: one-click trading (an order placed without the review step) is off for every member until the
// member switches it on and confirms it (`confirm: true`); the owner can switch it off for everyone with the
// `pro.one_click` flag. An order the terminal places without review carries `X-Plx-One-Click: 1`; the flag gate refuses
// it while the flag is off (feature_disabled), and the check below refuses it unless the member has one-click on.
const { ApiError, E, nowIso, newId, ufp } = require('./util');
const P = require('./pricing');
const { s: S } = require('./content/pro');

const PANELS = ['screener', 'chart', 'ladder', 'ticket', 'orders', 'positions', 'tape', 'alerts'];
const SORT_KEYS = ['title', 'bid', 'ask', 'last', 'chg', 'vol', 'spread', 'close'];
const MAX_SCREENS = 50;
const MAX_ROWS = 300;
const H = 3600000; const D = 86400000;
// Timeframes: candle length, how many candles, and where they are read from (the last hour from `trades` itself, bounded
// to that hour; the rest from the hourly / daily candle table). ALL: one candle per UTC day, at most two years.
const TIMEFRAMES = {
  '1H': { period: 60000, count: 60, source: 'trades' },
  '1D': { period: H, count: 24, source: 3600 },
  '1W': { period: 4 * H, count: 42, source: 3600 },
  ALL: { period: D, count: 730, source: 86400, fromFirst: true },
};

function fieldError(field, message) {
  const e = new ApiError(400, 'validation_failed', 'validation failed', `${field}: ${message}`);
  e.toJSON = () => ({ error: { code: e.code, message: e.message, details: e.details, fields: { [field]: message } } });
  return e;
}
const numOrNull = (raw, field, { min, max, int = false }) => {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'string' ? Number(raw.trim()) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) throw fieldError(field, S('error.invalid', { detail: `${int ? 'a whole number' : 'a number'} from ${min} to ${max}` }));
  return n;
};

// Screener filters (query string or a saved screen). Unknown keys are refused so a screen never stores junk.
function normFilters(raw, categories) {
  const f = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const known = ['category', 'closes_within_hours', 'min_volume', 'max_spread_cents', 'min_move_cents', 'query'];
  const extra = Object.keys(f).filter((k) => !known.includes(k));
  if (extra.length) throw fieldError(extra[0], S('error.invalid', { detail: 'not a screener filter' }));
  let category = f.category == null || f.category === '' ? null : String(f.category);
  if (category) {
    const hit = categories.find((c) => c.toLowerCase() === category.toLowerCase());
    if (!hit) throw fieldError('category', S('error.invalid', { detail: 'unknown category' }));
    category = hit;
  }
  const query = f.query == null ? '' : String(f.query).trim();
  if (query.length > 60) throw fieldError('query', S('error.invalid', { detail: 'at most 60 characters' }));
  return {
    category,
    closes_within_hours: numOrNull(f.closes_within_hours, 'closes_within_hours', { min: 1, max: 8760, int: true }),
    min_volume: numOrNull(f.min_volume, 'min_volume', { min: 0, max: 1e9 }),
    max_spread_cents: numOrNull(f.max_spread_cents, 'max_spread_cents', { min: 0, max: 99 }),
    min_move_cents: numOrNull(f.min_move_cents, 'min_move_cents', { min: 0, max: 99 }),
    query,
  };
}

// Layout: panel order (every panel once; missing ones are appended), hidden panels, chart timeframe, screener sort.
function normLayout(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw fieldError('layout', S('error.invalid', { detail: 'an object' }));
  const extra = Object.keys(raw).filter((k) => !['order', 'hidden', 'chart_tf', 'sort'].includes(k));
  if (extra.length) throw fieldError(`layout.${extra[0]}`, S('error.invalid', { detail: 'not a layout field' }));
  const list = (v, field) => {
    if (v == null) return [];
    if (!Array.isArray(v) || v.length > PANELS.length || v.some((x) => !PANELS.includes(x)) || new Set(v).size !== v.length) throw fieldError(`layout.${field}`, S('error.invalid', { detail: `distinct panels of ${PANELS.join(', ')}` }));
    return v;
  };
  const order = list(raw.order, 'order');
  const hidden = list(raw.hidden, 'hidden');
  const out = { order: [...order, ...PANELS.filter((p) => !order.includes(p))], hidden };
  if (raw.chart_tf != null) {
    if (!Object.prototype.hasOwnProperty.call(TIMEFRAMES, raw.chart_tf)) throw fieldError('layout.chart_tf', S('error.invalid', { detail: Object.keys(TIMEFRAMES).join(', ') }));
    out.chart_tf = raw.chart_tf;
  }
  if (raw.sort != null) {
    const s = raw.sort;
    if (!s || typeof s !== 'object' || !SORT_KEYS.includes(s.key) || ![1, -1].includes(s.dir)) throw fieldError('layout.sort', S('error.invalid', { detail: `{ key: ${SORT_KEYS.join('|')}, dir: 1|-1 }` }));
    out.sort = { key: s.key, dir: s.dir };
  }
  return out;
}

function createCandles(db) {
  const st = {
    market: db.prepare('SELECT ticker FROM markets WHERE ticker=?'),
    trades: db.prepare('SELECT yes_price_cc p, count c, created_ts ts FROM trades WHERE market_ticker=? AND created_ts>=? AND created_ts<? AND yes_price_cc IS NOT NULL ORDER BY created_ts, rowid'),
    prevTrade: db.prepare('SELECT yes_price_cc p FROM trades WHERE market_ticker=? AND created_ts<? AND yes_price_cc IS NOT NULL ORDER BY created_ts DESC, rowid DESC LIMIT 1'),
    rows: db.prepare('SELECT bucket_ts, open_cc, high_cc, low_cc, close_cc, volume_units, trades, dirty FROM market_candles WHERE market_ticker=? AND period_s=? AND bucket_ts>=? AND bucket_ts<? ORDER BY bucket_ts'),
    prevRow: db.prepare('SELECT bucket_ts, open_cc, high_cc, low_cc, close_cc, volume_units, trades, dirty FROM market_candles WHERE market_ticker=? AND period_s=? AND bucket_ts<? ORDER BY bucket_ts DESC LIMIT 1'),
    // A dirty bucket (a trade in it was updated or deleted, migration 0005) rebuilt from its trades: one bucket, indexed.
    recount: db.prepare(`SELECT (SELECT yes_price_cc FROM trades WHERE market_ticker=$t AND created_ts>=$a AND created_ts<$b AND yes_price_cc IS NOT NULL ORDER BY created_ts, rowid LIMIT 1) open_cc,
      MAX(yes_price_cc) high_cc, MIN(yes_price_cc) low_cc,
      (SELECT yes_price_cc FROM trades WHERE market_ticker=$t AND created_ts>=$a AND created_ts<$b AND yes_price_cc IS NOT NULL ORDER BY created_ts DESC, rowid DESC LIMIT 1) close_cc,
      COALESCE(SUM(count),0) volume_units, COUNT(*) trades FROM trades WHERE market_ticker=$t AND created_ts>=$a AND created_ts<$b AND yes_price_cc IS NOT NULL`),
    firstRow: db.prepare('SELECT bucket_ts FROM market_candles WHERE market_ticker=? AND period_s=? ORDER BY bucket_ts LIMIT 1'),
  };
  const exact = (ticker, ps, r) => {
    if (!r || !r.dirty) return r;
    const x = st.recount.get({ t: ticker, a: r.bucket_ts, b: r.bucket_ts + ps * 1000 });
    return x.trades ? { ...r, ...x } : null;
  };
  // Candles of one market. Buckets without trades carry the previous close (flat, volume 0) once the market has traded.
  return function candles(ticker, tf, now = Date.now()) {
    const spec = TIMEFRAMES[tf];
    if (!spec) throw fieldError('tf', S('error.invalid', { detail: Object.keys(TIMEFRAMES).join(', ') }));
    if (!st.market.get(String(ticker))) throw E.notFound();
    const { period } = spec;
    const last = Math.floor(now / period) * period;
    let first = last - (spec.count - 1) * period;
    if (spec.fromFirst) {
      const f = st.firstRow.get(ticker, spec.source);
      if (!f) return [];
      first = Math.max(first, Math.floor(f.bucket_ts / period) * period);
    }
    const end = last + period;
    // Aggregates per bucket from time-ordered pieces (trades, or hourly rows inside a 4-hour candle).
    const agg = new Map();
    const add = (b, o, h, l, c, v, n) => {
      const a = agg.get(b);
      if (!a) agg.set(b, { o, h, l, c, v, n });
      else { a.h = Math.max(a.h, h); a.l = Math.min(a.l, l); a.c = c; a.v += v; a.n += n; }
    };
    let prev;
    if (spec.source === 'trades') {
      for (const t of st.trades.all(ticker, first, end)) add(Math.floor(t.ts / period) * period, t.p, t.p, t.p, t.p, t.c, 1);
      prev = st.prevTrade.get(ticker, first)?.p ?? null;
    } else {
      for (const raw of st.rows.all(ticker, spec.source, first, end)) {
        const r = exact(ticker, spec.source, raw);
        if (r) add(Math.floor(r.bucket_ts / period) * period, r.open_cc, r.high_cc, r.low_cc, r.close_cc, r.volume_units, r.trades);
      }
      prev = exact(ticker, spec.source, st.prevRow.get(ticker, spec.source, first))?.close_cc ?? null;
    }
    const out = [];
    const d$ = P.ccToDollars;
    for (let b = first; b < end; b += period) {
      const a = agg.get(b) || (prev != null ? { o: prev, h: prev, l: prev, c: prev, v: 0, n: 0 } : null);
      if (!a) continue;
      out.push({ start_ts: b / 1000, end_ts: (b + period) / 1000, open_dollars: d$(a.o), high_dollars: d$(a.h), low_dollars: d$(a.l), close_dollars: d$(a.c), volume_fp: ufp(a.v), trades: a.n });
      prev = a.c;
    }
    return out;
  };
}

function mountPro({ v1, db, flags, requireUser, eventCards, categories }) {
  const candles = createCandles(db);
  const prefRow = (uid) => db.prepare('SELECT * FROM pro_prefs WHERE user_id=?').get(uid);
  const screenVo = (r) => ({ id: r.id, name: r.name, filters: JSON.parse(r.filters_json), created_time: r.created_at, updated_time: r.updated_at });
  const screensOf = (uid) => db.prepare('SELECT * FROM pro_screens WHERE user_id=? ORDER BY name COLLATE NOCASE, created_at').all(uid).map(screenVo);
  const ownScreen = (uid, id) => { const r = db.prepare('SELECT * FROM pro_screens WHERE id=? AND user_id=?').get(String(id), uid); if (!r) throw new ApiError(404, 'not_found', S('error.unknown_screen')); return r; };
  const prefsVo = (req) => {
    const r = prefRow(req.auth.user.id);
    const available = flags.on('pro.one_click', { req });
    let layout = null;
    if (r && r.layout_json) { try { layout = normLayout(JSON.parse(r.layout_json)); } catch { layout = null; } }
    return { one_click: !!(r && r.one_click), one_click_available: available, one_click_effective: !!(r && r.one_click) && available, one_click_confirmed_time: r ? r.one_click_confirmed_at : null,
      layout, active_screen_id: r ? r.active_screen_id : null, panels: PANELS, timeframes: Object.keys(TIMEFRAMES) };
  };
  const upsertPrefs = (uid, set) => {
    const cur = prefRow(uid) || { one_click: 0, one_click_confirmed_at: null, layout_json: null, active_screen_id: null };
    const next = { ...cur, ...set };
    db.prepare(`INSERT INTO pro_prefs(user_id, one_click, one_click_confirmed_at, layout_json, active_screen_id, updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET one_click=excluded.one_click, one_click_confirmed_at=excluded.one_click_confirmed_at, layout_json=excluded.layout_json, active_screen_id=excluded.active_screen_id, updated_at=excluded.updated_at`)
      .run(uid, next.one_click ? 1 : 0, next.one_click_confirmed_at, next.layout_json, next.active_screen_id, nowIso());
  };
  const nameOf = (raw) => {
    const n = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
    if (n.length < 1 || n.length > 60) throw fieldError('name', S('error.invalid', { detail: '1-60 characters' }));
    return n;
  };
  const onlyKeys = (b, keys) => { const extra = Object.keys(b).filter((k) => !keys.includes(k)); if (extra.length) throw fieldError(extra[0], S('error.invalid', { detail: 'not a field of this request' })); };

  // ---------------------------------------------------------------- one-click enforcement (before the order route)
  v1.post('/users/:uid/orders', (req, res, next) => {
    if (!req.auth || req.get('x-plx-one-click') !== '1') return next();
    const r = prefRow(req.auth.user.id);
    if (!r || !r.one_click) return next(new ApiError(403, 'one_click_not_enabled', S('error.one_click_off')));
    next();
  });

  // ---------------------------------------------------------------- screener (public)
  v1.get('/pro/screener', (req, res) => {
    const f = normFilters({ ...req.query }, categories);
    const now = Date.now();
    const q = f.query.toLowerCase();
    const rows = [];
    for (const ev of eventCards()) {
      if (f.category && ev.category !== f.category) continue;
      for (const m of ev.markets) {
        if (m.status !== 'active') continue;
        if (q && ![ev.title, ev.sub_title, m.yes_sub_title, m.ticker].join(' ').toLowerCase().includes(q)) continue;
        const cc = (d) => (d == null ? null : Math.round(Number(d) * P.CC));
        const bid = cc(m.yes_bid_dollars); const ask = cc(m.yes_ask_dollars); const lastP = cc(m.last_price_dollars); const prevP = cc(m.previous_day_price_dollars);
        const spread = bid != null && ask != null ? (ask - bid) / P.CC_PER_CENT : null;
        const move = lastP != null && prevP != null ? (lastP - prevP) / P.CC_PER_CENT : null;
        const vol = Number(m.volume_fp);
        const closeMs = Date.parse(m.close_time);
        if (f.closes_within_hours != null && !(closeMs >= now && closeMs <= now + f.closes_within_hours * H)) continue;
        if (f.min_volume != null && !(vol >= f.min_volume)) continue;
        if (f.max_spread_cents != null && !(spread != null && spread <= f.max_spread_cents)) continue;
        if (f.min_move_cents != null && !(move != null && Math.abs(move) >= f.min_move_cents)) continue;
        rows.push({ ticker: m.ticker, event_ticker: ev.event_ticker, series_ticker: ev.series_ticker, series_slug: ev.series_slug, event_title: ev.title, category: ev.category, yes_sub_title: m.yes_sub_title,
          close_time: m.close_time, yes_bid_dollars: m.yes_bid_dollars, yes_ask_dollars: m.yes_ask_dollars, last_price_dollars: m.last_price_dollars, previous_day_price_dollars: m.previous_day_price_dollars,
          volume_fp: m.volume_fp, volume_24h_fp: m.volume_24h_fp, spread_cents: spread, move_24h_cents: move, price_level_structure: m.price_level_structure, fractional_trading_enabled: m.fractional_trading_enabled });
      }
    }
    rows.sort((a, b) => Number(b.volume_fp) - Number(a.volume_fp) || a.ticker.localeCompare(b.ticker));
    res.json({ filters: f, total_count: rows.length, markets: rows.slice(0, MAX_ROWS) });
  });

  // ---------------------------------------------------------------- candles (public)
  v1.get('/pro/candles', (req, res) => {
    const ticker = String(req.query.ticker || '');
    const tf = String(req.query.tf || '1D').toUpperCase();
    const list = candles(ticker, tf);
    res.json({ ticker, tf, period_seconds: TIMEFRAMES[tf].period / 1000, candles: list });
  });

  // ---------------------------------------------------------------- saved screens
  v1.get('/users/:uid/pro/screens', requireUser, (req, res) => res.json({ screens: screensOf(req.auth.user.id), max: MAX_SCREENS }));
  v1.post('/users/:uid/pro/screens', requireUser, (req, res) => {
    const uid = req.auth.user.id; const b = req.body || {};
    onlyKeys(b, ['name', 'filters']);
    const name = nameOf(b.name); const filters = normFilters(b.filters, categories);
    if (db.prepare('SELECT COUNT(*) c FROM pro_screens WHERE user_id=?').get(uid).c >= MAX_SCREENS) throw E.conflict('too_many_screens', S('error.too_many_screens', { max: MAX_SCREENS }));
    if (db.prepare('SELECT 1 FROM pro_screens WHERE user_id=? AND name=?').get(uid, name)) throw E.conflict('screen_name_taken', S('error.screen_name_taken'));
    const id = newId('scr_'); const ts = nowIso();
    db.prepare('INSERT INTO pro_screens(id,user_id,name,filters_json,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, uid, name, JSON.stringify(filters), ts, ts);
    res.status(201).json({ screen: screenVo(ownScreen(uid, id)) });
  });
  v1.put('/users/:uid/pro/screens/:id', requireUser, (req, res) => {
    const uid = req.auth.user.id; const b = req.body || {};
    onlyKeys(b, ['name', 'filters']);
    const cur = ownScreen(uid, req.params.id);
    const name = b.name != null ? nameOf(b.name) : cur.name;
    const filters = b.filters != null ? normFilters(b.filters, categories) : JSON.parse(cur.filters_json);
    if (name !== cur.name && db.prepare('SELECT 1 FROM pro_screens WHERE user_id=? AND name=? AND id<>?').get(uid, name, cur.id)) throw E.conflict('screen_name_taken', S('error.screen_name_taken'));
    db.prepare('UPDATE pro_screens SET name=?, filters_json=?, updated_at=? WHERE id=?').run(name, JSON.stringify(filters), nowIso(), cur.id);
    res.json({ screen: screenVo(ownScreen(uid, cur.id)) });
  });
  v1.delete('/users/:uid/pro/screens/:id', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const cur = ownScreen(uid, req.params.id);
    db.prepare('DELETE FROM pro_screens WHERE id=?').run(cur.id);
    db.prepare('UPDATE pro_prefs SET active_screen_id=NULL, updated_at=? WHERE user_id=? AND active_screen_id=?').run(nowIso(), uid, cur.id);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- preferences (layout, active screen, one-click)
  v1.get('/users/:uid/pro/preferences', requireUser, (req, res) => res.json({ preferences: prefsVo(req) }));
  v1.put('/users/:uid/pro/preferences', requireUser, (req, res) => {
    const uid = req.auth.user.id; const b = req.body || {};
    onlyKeys(b, ['layout', 'active_screen_id', 'one_click', 'confirm']);
    const set = {};
    if (Object.prototype.hasOwnProperty.call(b, 'layout')) { const l = normLayout(b.layout); set.layout_json = l ? JSON.stringify(l) : null; }
    if (Object.prototype.hasOwnProperty.call(b, 'active_screen_id')) set.active_screen_id = b.active_screen_id == null || b.active_screen_id === '' ? null : ownScreen(uid, b.active_screen_id).id;
    if (Object.prototype.hasOwnProperty.call(b, 'one_click')) {
      if (typeof b.one_click !== 'boolean') throw fieldError('one_click', S('error.invalid', { detail: 'true or false' }));
      if (b.one_click) {
        // The flag gate already refused this while pro.one_click is off (ROUTE_RULES); the confirmation is asked every time it is switched on.
        if (!flags.on('pro.one_click', { req })) throw flags.disabledError('pro.one_click');
        if (b.confirm !== true) throw new ApiError(400, 'one_click_confirmation_required', S('error.one_click_confirm'));
        set.one_click = 1; set.one_click_confirmed_at = nowIso();
      } else set.one_click = 0;
    } else if (Object.prototype.hasOwnProperty.call(b, 'confirm')) throw fieldError('confirm', S('error.invalid', { detail: 'only with one_click' }));
    upsertPrefs(uid, set);
    res.json({ preferences: prefsVo(req) });
  });

  // The member's terminal data for the account data export (server/identity.js).
  const exportFor = (uid) => ({ preferences: prefRow(uid) || null, screens: screensOf(uid) });
  return { candles, exportFor, PANELS, TIMEFRAMES };
}

module.exports = { mountPro, createCandles, normFilters, normLayout, PANELS, TIMEFRAMES };
