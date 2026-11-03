'use strict';
// Perpetual futures ("Perps") margin product (PERPS_SPEC_SECTION.md, merged as CLONE_SPEC §14).
// Linear perps on simulated, persisted indices. Isolated margin per (user, market); prices are per contract
// in centicents ($0.0001 = one tick, the documented perps tick); quantities are whole contracts.
// Everything that matters lives in SQLite: markets + simulation state, price history, orders, fills, trades,
// positions, collateral, funding rates/payments, liquidations, exit triggers, transfers and a perps ledger.
const { tx } = require('./db');
const { nowIso, newId, dollars, fp, E, ApiError, encCursor, decCursor } = require('./util');

const CC = 10000; // centicents per dollar
const cc$ = (cc) => (cc == null || !Number.isFinite(Number(cc)) ? null : dollars(Number(cc) / 100));
const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const MARKET_SLIPPAGE = 0.05;      // market orders = IOC limit at mark ± 5% (design choice)
const BAND_PCT = 0.2;              // price band (margin_price-banding.md): 20% or 1,000 ticks
const BAND_TICKS = 1000;
const LP_LEVELS = 8;
const LP_LEVEL_NOTIONAL_CC = 1500 * CC;
const FUNDING_INTEREST = 0.0001;   // per funding period (design choice)
const FUNDING_CAP = 0.0075;
const IM_MULTIPLIER = 2;           // initial margin = maintenance margin x 2 (risk_parameters shape)
const MAX_COUNT = 1000000;
const ASSET_CLASSES = ['Crypto', 'Equities', 'Metals', 'FX', 'Energy', 'Indices', 'Rates', 'Compute', 'GPU', 'EventContracts'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS perp_markets (
  ticker TEXT PRIMARY KEY, market_id TEXT NOT NULL, title TEXT NOT NULL, asset_name TEXT NOT NULL, asset_class TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', index_provider TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL DEFAULT 'usd', decimals INTEGER NOT NULL DEFAULT 2,
  color TEXT NOT NULL DEFAULT '#8f7fff', sort_order INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
  contract_size REAL NOT NULL, max_leverage REAL NOT NULL, im_multiplier REAL NOT NULL DEFAULT 2,
  maker_fee_rate REAL NOT NULL, taker_fee_rate REAL NOT NULL,
  funding_interval_ms INTEGER NOT NULL, funding_schedule TEXT NOT NULL, funding_cap REAL NOT NULL, funding_interest REAL NOT NULL,
  next_funding_ts INTEGER NOT NULL, last_funding_ts INTEGER, premium_sum REAL NOT NULL DEFAULT 0, premium_n INTEGER NOT NULL DEFAULT 0,
  anchor_price REAL NOT NULL, index_price REAL NOT NULL, daily_vol REAL NOT NULL, basis REAL NOT NULL DEFAULT 0,
  sim_state INTEGER NOT NULL, sim_frozen INTEGER NOT NULL DEFAULT 0, sim_ts INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS perp_price_history (
  ticker TEXT NOT NULL REFERENCES perp_markets(ticker), ts INTEGER NOT NULL, step_ms INTEGER NOT NULL DEFAULT 60000,
  open_cc INTEGER NOT NULL, high_cc INTEGER NOT NULL, low_cc INTEGER NOT NULL, close_cc INTEGER NOT NULL, PRIMARY KEY (ticker, ts)
);
CREATE TABLE IF NOT EXISTS perp_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, available_cc INTEGER NOT NULL DEFAULT 0,
  last_funding_notice_ts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS perp_orders (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), ticker TEXT NOT NULL REFERENCES perp_markets(ticker),
  side TEXT NOT NULL, type TEXT NOT NULL, price_cc INTEGER NOT NULL, initial_count INTEGER NOT NULL, remaining_count INTEGER NOT NULL,
  filled_count INTEGER NOT NULL DEFAULT 0, fill_cost_cc INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, time_in_force TEXT NOT NULL,
  reduce_only INTEGER NOT NULL DEFAULT 0, post_only INTEGER NOT NULL DEFAULT 0, leverage REAL NOT NULL DEFAULT 1,
  reserved_cc INTEGER NOT NULL DEFAULT 0, fees_cc INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'user',
  client_order_id TEXT, created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_perp_orders_book ON perp_orders(ticker, status, side, price_cc);
CREATE INDEX IF NOT EXISTS idx_perp_orders_user ON perp_orders(user_id, status, created_ts);
CREATE TABLE IF NOT EXISTS perp_trades (
  id TEXT PRIMARY KEY, ticker TEXT NOT NULL, price_cc INTEGER NOT NULL, count INTEGER NOT NULL, taker_side TEXT NOT NULL,
  is_liquidation INTEGER NOT NULL DEFAULT 0, created_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_perp_trades ON perp_trades(ticker, created_ts);
CREATE TABLE IF NOT EXISTS perp_fills (
  id TEXT PRIMARY KEY, trade_id TEXT NOT NULL, order_id TEXT, user_id TEXT NOT NULL, ticker TEXT NOT NULL, side TEXT NOT NULL,
  price_cc INTEGER NOT NULL, count INTEGER NOT NULL, is_taker INTEGER NOT NULL, fee_cc INTEGER NOT NULL, realized_cc INTEGER NOT NULL,
  entry_cc REAL NOT NULL, source TEXT NOT NULL, created_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_perp_fills_user ON perp_fills(user_id, created_ts);
CREATE TABLE IF NOT EXISTS perp_positions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, ticker TEXT NOT NULL REFERENCES perp_markets(ticker),
  qty INTEGER NOT NULL DEFAULT 0, entry_cc REAL NOT NULL DEFAULT 0, margin_cc INTEGER NOT NULL DEFAULT 0, leverage REAL NOT NULL DEFAULT 1,
  fees_cc INTEGER NOT NULL DEFAULT 0, realized_cc INTEGER NOT NULL DEFAULT 0, funding_cc INTEGER NOT NULL DEFAULT 0,
  opened_ts INTEGER, updated_ts INTEGER NOT NULL, PRIMARY KEY (user_id, ticker)
);
CREATE TABLE IF NOT EXISTS perp_funding_rates (
  id TEXT PRIMARY KEY, ticker TEXT NOT NULL, funding_ts INTEGER NOT NULL, rate REAL NOT NULL, mark_cc INTEGER NOT NULL, premium REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_perp_funding_rates ON perp_funding_rates(ticker, funding_ts);
CREATE TABLE IF NOT EXISTS perp_funding_payments (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ticker TEXT NOT NULL, funding_ts INTEGER NOT NULL, rate REAL NOT NULL,
  mark_cc INTEGER NOT NULL, qty INTEGER NOT NULL, amount_cc INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_perp_funding_pay ON perp_funding_payments(user_id, funding_ts);
CREATE TABLE IF NOT EXISTS perp_liquidations (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ticker TEXT NOT NULL, side TEXT NOT NULL, count INTEGER NOT NULL, entry_cc REAL NOT NULL,
  mark_cc INTEGER NOT NULL, liq_price_cc INTEGER, margin_cc INTEGER NOT NULL, realized_cc INTEGER NOT NULL, fee_cc INTEGER NOT NULL,
  returned_cc INTEGER NOT NULL, shortfall_cc INTEGER NOT NULL, created_ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS perp_exit_triggers (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ticker TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'bracket', status TEXT NOT NULL,
  status_reason TEXT, stop_loss_cc INTEGER, take_profit_cc INTEGER, triggered_leg TEXT, triggered_order_id TEXT,
  count INTEGER NOT NULL DEFAULT 0, filled_count INTEGER NOT NULL DEFAULT 0, created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_perp_triggers ON perp_exit_triggers(ticker, status);
CREATE TABLE IF NOT EXISTS perp_transfers (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, source TEXT NOT NULL, destination TEXT NOT NULL,
  amount_cc INTEGER NOT NULL, status TEXT NOT NULL, client_transfer_id TEXT, created_ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS perp_ledger (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, amount_cc INTEGER NOT NULL, ticker TEXT, ref TEXT, memo TEXT NOT NULL DEFAULT '', created_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_perp_ledger ON perp_ledger(user_id, created_ts);
CREATE TABLE IF NOT EXISTS perp_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

// Invented markets on simulated indices (no external feeds). price = underlying level; per-contract price = level x contract_size.
const MARKETS = [
  { ticker: 'PLXBTCPERP', title: 'BTC', asset_name: 'Bitcoin', asset_class: 'Crypto', contract_size: 0.0001, price: 96250, max_leverage: 20, daily_vol: 0.035, color: '#f2a900', description: 'Tracks a simulated Bitcoin reference index. The oldest and most widely held crypto asset, often used as the benchmark for crypto risk appetite.' },
  { ticker: 'PLXETHPERP', title: 'ETH', asset_name: 'Ether', asset_class: 'Crypto', contract_size: 0.001, price: 3420, max_leverage: 15, daily_vol: 0.045, color: '#7b8cde', description: 'Tracks a simulated Ether reference index, the native asset of a large smart-contract network.' },
  { ticker: 'PLXSOLPERP', title: 'SOL', asset_name: 'Solana', asset_class: 'Crypto', contract_size: 0.1, price: 182.4, max_leverage: 10, daily_vol: 0.06, color: '#14b8a6', description: 'Tracks a simulated Solana reference index, a high-throughput layer-1 network token.' },
  { ticker: 'PLXGOLDPERP', title: 'Gold', asset_name: 'Gold (troy ounce)', asset_class: 'Metals', contract_size: 0.001, price: 2634.5, max_leverage: 25, daily_vol: 0.012, color: '#d4a017', interval: DAY, schedule: '0 10 * * *', description: 'Tracks a simulated spot gold index in dollars per troy ounce.' },
  { ticker: 'PLXOILPERP', title: 'Crude Oil', asset_name: 'Light crude (barrel)', asset_class: 'Energy', contract_size: 0.1, price: 71.42, max_leverage: 10, daily_vol: 0.025, color: '#9ca3af', interval: DAY, schedule: '30 14 * * *', description: 'Tracks a simulated light crude oil index in dollars per barrel.' },
  { ticker: 'PLXUS10YPERP', title: 'US 10Y Yield', asset_name: 'US 10-year Treasury yield', asset_class: 'Rates', contract_size: 1, price: 4.312, unit: 'pct', decimals: 3, max_leverage: 20, daily_vol: 0.02, color: '#3b82f6', interval: DAY, schedule: '0 16 * * *', description: 'Tracks a simulated 10-year Treasury yield, quoted in percent. Long profits when the yield rises.' },
  { ticker: 'PLXGPUHRPERP', title: 'GPU Hour', asset_name: 'Cloud GPU compute-hour', asset_class: 'Compute', contract_size: 1, price: 2.184, decimals: 3, max_leverage: 5, daily_vol: 0.03, color: '#a855f7', description: 'Tracks a simulated index of the on-demand rental price of one data-center GPU for one hour.' },
];

// Deterministic PRNG (mulberry32) whose state is persisted per market.
function rnd(state) {
  const t = (state + 0x6d2b79f5) >>> 0;
  let r = Math.imul(t ^ (t >>> 15), 1 | t);
  r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
  return { state: t, u: ((r ^ (r >>> 14)) >>> 0) / 4294967296 };
}
function gauss(state) {
  const a = rnd(state); const b = rnd(a.state);
  const z = Math.sqrt(-2 * Math.log(Math.max(1e-12, a.u))) * Math.cos(2 * Math.PI * b.u);
  return { state: b.state, z };
}
const hash = (s) => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; return h; };
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function mountPerps({ v1, db, engine, requireUser, requireAdmin, notify = () => {}, options = {} }) {
  db.exec(SCHEMA);
  const fundingOverride = Number(options.fundingIntervalMs || process.env.PERPS_FUNDING_INTERVAL_MS || 0) || 0;
  const lpId = () => db.prepare("SELECT id FROM users WHERE email='liquidity@parlance.local'").get()?.id;

  // ---------------------------------------------------------------- seeding (idempotent)
  function seedMarkets() {
    const now = Date.now();
    MARKETS.forEach((d, i) => {
      if (db.prepare('SELECT 1 FROM perp_markets WHERE ticker=?').get(d.ticker)) return;
      const interval = d.interval || 8 * HOUR;
      tx(db, () => {
        db.prepare(`INSERT INTO perp_markets(ticker,market_id,title,asset_name,asset_class,description,index_provider,unit,decimals,color,sort_order,status,contract_size,max_leverage,im_multiplier,maker_fee_rate,taker_fee_rate,funding_interval_ms,funding_schedule,funding_cap,funding_interest,next_funding_ts,premium_sum,premium_n,anchor_price,index_price,daily_vol,basis,sim_state,sim_frozen,sim_ts,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(d.ticker, newId(), d.title, d.asset_name, d.asset_class, d.description, 'Parlance simulated reference index', d.unit || 'usd', d.decimals ?? 2, d.color, i,
            'active', d.contract_size, d.max_leverage, IM_MULTIPLIER, 0.0002, 0.0006, interval, d.schedule || '0 */8 * * *', FUNDING_CAP, FUNDING_INTEREST,
            Math.ceil((now + 1) / interval) * interval, 0, 0, d.price, d.price, d.daily_vol, 0, hash(d.ticker), 0, now, nowIso());
        backfill(d, now);
      });
    });
  }
  // History walks backwards from the seed price: 1-minute bars for 2 hours, 15-minute bars for 7 days.
  function backfill(d, now) {
    let st = hash(d.ticker + ':hist');
    const toCc = (px) => Math.max(1, Math.round(px * d.contract_size * CC));
    const ins = db.prepare('INSERT OR IGNORE INTO perp_price_history(ticker,ts,step_ms,open_cc,high_cc,low_cc,close_cc) VALUES(?,?,?,?,?,?,?)');
    let px = d.price;
    let t = Math.floor(now / MIN) * MIN;
    const closes = [];
    const step = (ms) => {
      const g = gauss(st); st = g.state;
      const sigma = d.daily_vol * Math.sqrt(ms / DAY);
      const drift = 1.5 * Math.log(px / d.price) * (ms / DAY);
      const prev = px * Math.exp(-sigma * g.z - drift);
      const w = rnd(st); st = w.state;
      const hi = Math.max(prev, px) * (1 + w.u * sigma * 0.5);
      const lo = Math.min(prev, px) * (1 - w.u * sigma * 0.5);
      ins.run(d.ticker, t - ms, ms, toCc(prev), toCc(hi), toCc(lo), toCc(px));
      closes.push([t - ms, px]);
      px = prev;
      t -= ms;
    };
    for (let k = 0; k < 120; k += 1) step(MIN);
    t = Math.floor(t / (15 * MIN)) * 15 * MIN;
    while (t > now - 7 * DAY) step(15 * MIN);
    // Seeded public tape for the last 24h (no counterparties; shown as market activity).
    const insT = db.prepare('INSERT INTO perp_trades(id,ticker,price_cc,count,taker_side,is_liquidation,created_ts) VALUES(?,?,?,?,?,0,?)');
    const recent = closes.filter(([ts]) => ts > now - DAY);
    for (let k = 0; k < 96 && recent.length; k += 1) {
      const a = rnd(st); st = a.state; const b = rnd(st); st = b.state;
      const [ts, p] = recent[Math.floor(a.u * recent.length)];
      const size = 1 + Math.floor(b.u * b.u * Math.max(20, 3000 / (d.price * d.contract_size)));
      insT.run(newId('pt_'), d.ticker, toCc(p * (1 + (a.u - 0.5) * 0.0004)), size, b.u > 0.5 ? 'bid' : 'ask', ts + Math.floor(a.u * 600000));
    }
    // Seeded funding-rate history on the schedule.
    const interval = d.interval || 8 * HOUR;
    const insF = db.prepare('INSERT INTO perp_funding_rates(id,ticker,funding_ts,rate,mark_cc,premium) VALUES(?,?,?,?,?,?)');
    for (let ft = Math.floor(now / interval) * interval; ft > now - 7 * DAY; ft -= interval) {
      const g = gauss(st); st = g.state;
      const near = closes.find(([ts]) => ts <= ft) || closes[closes.length - 1];
      const rate = clamp(FUNDING_INTEREST + g.z * 0.00015, -FUNDING_CAP, FUNDING_CAP);
      insF.run(newId('fr_'), d.ticker, ft, Number(rate.toFixed(8)), toCc(near ? near[1] : d.price), Number((rate - FUNDING_INTEREST).toFixed(8)));
    }
  }
  seedMarkets();
  const LP = lpId();
  function account(uid) {
    db.prepare('INSERT INTO perp_accounts(user_id,available_cc,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO NOTHING').run(uid, uid === LP ? 1e12 : 0, nowIso());
    return db.prepare('SELECT * FROM perp_accounts WHERE user_id=?').get(uid);
  }
  if (LP) account(LP);
  if (fundingOverride > 0) {
    const now = Date.now();
    db.prepare('UPDATE perp_markets SET next_funding_ts=? WHERE next_funding_ts>?').run(now + fundingOverride, now + fundingOverride);
  }
  const intervalOf = (m) => (fundingOverride > 0 ? fundingOverride : m.funding_interval_ms);

  // ---------------------------------------------------------------- math helpers
  const getMarket = (t) => db.prepare('SELECT * FROM perp_markets WHERE ticker=?').get(String(t || '').toUpperCase());
  const mustMarket = (t) => { const m = getMarket(t); if (!m) throw E.notFound(); return m; };
  const markCc = (m) => Math.max(1, Math.round(m.index_price * m.contract_size * CC));
  const mmRate = (m) => 1 / (m.max_leverage * m.im_multiplier);
  const imRate = (m) => 1 / m.max_leverage;
  const feeCc = (n, p, rate) => Math.ceil(n * p * rate - 1e-9);
  const reservePer = (m, price, lev) => Math.ceil(price / lev) + Math.ceil(price * m.taker_fee_rate);
  const fmtUnderlying = (m, cc) => {
    const v = cc / CC / m.contract_size;
    const s = v.toLocaleString('en-US', { minimumFractionDigits: m.decimals, maximumFractionDigits: m.decimals });
    return m.unit === 'pct' ? `${s}%` : `$${s}`;
  };
  function liqPriceCc(qty, entry, margin, r) {
    const q = Math.abs(qty);
    if (!q) return null;
    const p = qty > 0 ? (q * entry - margin) / (q * (1 - r)) : (margin + q * entry) / (q * (1 + r));
    return p > 0 ? Math.round(p) : null;
  }
  function leverageEstimates(m) {
    const out = {};
    for (const n of ['1000', '10000', '100000', '1000000']) out[n] = Number((m.max_leverage / (1 + Number(n) / 2e6)).toFixed(4));
    return out;
  }
  const meta = (k, def) => db.prepare('SELECT value FROM perp_meta WHERE key=?').get(k)?.value ?? def;
  const setMeta = (k, v) => db.prepare('INSERT INTO perp_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
  const ledger = (uid, kind, cc, ticker, ref, memo) => {
    if (!cc || uid === LP) return;
    db.prepare('INSERT INTO perp_ledger(id,user_id,kind,amount_cc,ticker,ref,memo,created_ts) VALUES(?,?,?,?,?,?,?,?)').run(newId('pl_'), uid, kind, Math.round(cc), ticker, ref, memo, Date.now());
  };
  const addAvail = (uid, cc) => db.prepare('UPDATE perp_accounts SET available_cc=available_cc+?, updated_at=? WHERE user_id=?').run(Math.round(cc), nowIso(), uid);

  // ---------------------------------------------------------------- book + quotes
  function best(t, side) {
    return db.prepare(`SELECT price_cc p, SUM(remaining_count) n FROM perp_orders WHERE ticker=? AND status='resting' AND side=? GROUP BY price_cc ORDER BY price_cc ${side === 'bid' ? 'DESC' : 'ASC'} LIMIT 1`).get(t, side) || null;
  }
  function book(t, depth = 0) {
    const lv = (side) => db.prepare(`SELECT price_cc p, SUM(remaining_count) n FROM perp_orders WHERE ticker=? AND status='resting' AND side=? GROUP BY price_cc ORDER BY price_cc ${side === 'bid' ? 'DESC' : 'ASC'}${depth > 0 ? ` LIMIT ${Number(depth)}` : ''}`).all(t, side).map((r) => [cc$(r.p), fp(r.n)]);
    return { bids: lv('bid'), asks: lv('ask') };
  }
  const bookMsg = (t) => ({ market_ticker: String(t).toUpperCase(), ...book(String(t).toUpperCase(), 20), ts_ms: Date.now() });

  function stats(m) {
    const now = Date.now();
    const t = m.ticker;
    const last = db.prepare('SELECT price_cc p, count n FROM perp_trades WHERE ticker=? ORDER BY created_ts DESC, rowid DESC LIMIT 1').get(t);
    const v = db.prepare('SELECT COALESCE(SUM(count),0) n, COALESCE(SUM(count*price_cc),0) d FROM perp_trades WHERE ticker=?').get(t);
    const v24 = db.prepare('SELECT COALESCE(SUM(count),0) n, COALESCE(SUM(count*price_cc),0) d FROM perp_trades WHERE ticker=? AND created_ts>?').get(t, now - DAY);
    const oi = db.prepare('SELECT COALESCE(SUM(qty),0) n FROM perp_positions WHERE ticker=? AND qty>0').get(t).n;
    const prev = db.prepare('SELECT close_cc p FROM perp_price_history WHERE ticker=? AND ts<=? ORDER BY ts DESC LIMIT 1').get(t, now - DAY)
      || db.prepare('SELECT open_cc p FROM perp_price_history WHERE ticker=? ORDER BY ts ASC LIMIT 1').get(t);
    return { last, v, v24, oi, prev: prev ? prev.p : null };
  }
  function fundingEstimate(m) {
    const avg = m.premium_n ? m.premium_sum / m.premium_n : 0;
    return { rate: Number(clamp(avg + m.funding_interest, -m.funding_cap, m.funding_cap).toFixed(8)), premium: avg };
  }
  function tickerMsg(m) {
    const mark = markCc(m);
    const s = stats(m);
    const bb = best(m.ticker, 'bid');
    const ba = best(m.ticker, 'ask');
    const now = Date.now();
    const tp = (p) => ({ price: cc$(p), ts_ms: now });
    return {
      market_ticker: m.ticker,
      price: cc$(s.last ? s.last.p : mark),
      bid: bb ? cc$(bb.p) : null, ask: ba ? cc$(ba.p) : null,
      bid_size_fp: fp(bb ? bb.n : 0), ask_size_fp: fp(ba ? ba.n : 0),
      last_trade_size_fp: fp(s.last ? s.last.n : 0),
      volume: fp(s.v.n), volume_notional_value_dollars: cc$(s.v.d),
      volume_24h: fp(s.v24.n), volume_24h_notional_value_dollars: cc$(s.v24.d),
      open_interest: fp(s.oi), open_interest_notional_value_dollars: cc$(s.oi * mark),
      reference_price: tp(mark), settlement_mark_price: tp(mark), liquidation_mark_price: tp(mark),
      mark_price: cc$(mark),
      index_price: (m.index_price).toFixed(Math.max(m.decimals, 4)),
      previous_price: cc$(s.prev ?? mark),
      price_change_24h_pct: s.prev ? Number((((mark - s.prev) / s.prev) * 100).toFixed(4)) : 0,
      funding_rate: { rate: fundingEstimate(m).rate, next_funding_time_ms: m.next_funding_ts, ts_ms: now },
      ts_ms: now,
    };
  }
  function marketVo(m) {
    const t = tickerMsg(m);
    const lev = leverageEstimates(m);
    return {
      market_id: m.market_id, ticker: m.ticker, title: m.title, status: m.status, market_version: 1, exchange_index: 0,
      contract_size: m.contract_size.toFixed(6), underlying_multiplier: '1.000000', tick_size: '0.0001', fractional_trading_enabled: false,
      ...t,
      leverage_estimate: lev['1000'], leverage_estimates: lev, long_leverage_estimates: lev, short_leverage_estimates: lev,
      max_leverage: m.max_leverage, initial_margin_rate: Number(imRate(m).toFixed(6)), maintenance_margin_rate: Number(mmRate(m).toFixed(6)),
      maker_fee_rate: m.maker_fee_rate, taker_fee_rate: m.taker_fee_rate,
      funding_deadband: 0, funding_cap: m.funding_cap * 100, funding_limit_unit: 'percentage', funding_invalid_premium_handling: 'dampen',
      funding_interval_ms: intervalOf(m), next_funding_time: new Date(m.next_funding_ts).toISOString(),
      halt_sources: [], schedule: null, asset_class: m.asset_class,
      product_metadata: { asset_name: m.asset_name, description: m.description, index_provider: m.index_provider, funding_schedule: m.funding_schedule, decimal_count: m.decimals, unit: m.unit, color: m.color, category: m.asset_class },
    };
  }

  // ---------------------------------------------------------------- VOs
  const position = (uid, t) => db.prepare('SELECT * FROM perp_positions WHERE user_id=? AND ticker=?').get(uid, t);
  const activeTrigger = (uid, t) => db.prepare("SELECT * FROM perp_exit_triggers WHERE user_id=? AND ticker=? AND status='active' ORDER BY created_ts DESC LIMIT 1").get(uid, t);
  const triggerVo = (x) => x && ({
    id: x.id, ticker: x.ticker, kind: x.kind, status: x.status, status_reason: x.status_reason, triggered_leg: x.triggered_leg, triggered_order_id: x.triggered_order_id,
    stop_loss_price: cc$(x.stop_loss_cc), take_profit_price: cc$(x.take_profit_cc), count: fp(x.count), filled_count: fp(x.filled_count),
    created_time: new Date(x.created_ts).toISOString(), updated_time: new Date(x.updated_ts).toISOString(),
  });
  function positionVo(p, m = getMarket(p.ticker)) {
    const mark = markCc(m);
    const q = p.qty;
    const aq = Math.abs(q);
    const upnl = q * (mark - p.entry_cc);
    const notional = aq * mark;
    const r = mmRate(m);
    const liq = liqPriceCc(q, p.entry_cc, p.margin_cc, r);
    return {
      market_ticker: p.ticker, title: m.title, subaccount: 0, subaccount_type: 'isolated', is_portfolio: false,
      side: q > 0 ? 'long' : q < 0 ? 'short' : 'flat', position: fp(q), contract_size: m.contract_size.toFixed(6),
      entry_price: cc$(p.entry_cc), mark_price: cc$(mark), unrealized_pnl: cc$(upnl),
      margin_used: cc$(p.margin_cc), position_value: cc$(p.margin_cc + upnl), position_notional: cc$(notional), total_size: cc$(aq * p.entry_cc),
      leverage: p.margin_cc > 0 ? Number(((aq * p.entry_cc) / p.margin_cc).toFixed(2)) : null,
      maintenance_margin_required: cc$(notional * r), maintenance_margin_rate: Number(r.toFixed(6)),
      estimated_liquidation_price: cc$(liq),
      roe: p.margin_cc > 0 ? Number(((upnl / p.margin_cc) * 100).toFixed(4)) : null,
      fees: cc$(p.fees_cc), realized_pnl: cc$(p.realized_cc), funding_paid: cc$(p.funding_cc),
      opened_time: p.opened_ts ? new Date(p.opened_ts).toISOString() : null, updated_time: new Date(p.updated_ts).toISOString(),
      exit_trigger: triggerVo(activeTrigger(p.user_id, p.ticker)) || null,
    };
  }
  const orderVo = (o) => ({
    order_id: o.id, client_order_id: o.client_order_id, ticker: o.ticker, side: o.side, action: o.side === 'bid' ? 'buy' : 'sell',
    direction: o.side === 'bid' ? 'long' : 'short', type: o.type, price: cc$(o.price_cc), count: fp(o.initial_count), fill_count: fp(o.filled_count),
    remaining_count: fp(o.remaining_count), status: o.status, time_in_force: { gtc: 'good_till_canceled', ioc: 'immediate_or_cancel', fok: 'fill_or_kill' }[o.time_in_force],
    reduce_only: !!o.reduce_only, post_only: !!o.post_only, leverage: o.leverage, reserved_margin: cc$(o.reserved_cc), fees: cc$(o.fees_cc),
    average_fill_price: o.filled_count ? cc$(o.fill_cost_cc / o.filled_count) : null, order_source: o.source === 'user' ? 'user' : 'system', source_detail: o.source,
    created_time: new Date(o.created_ts).toISOString(), last_update_time: new Date(o.updated_ts).toISOString(), created_ts_ms: o.created_ts, last_updated_ts_ms: o.updated_ts,
  });
  const fillVo = (f) => ({
    fill_id: f.id, order_id: f.order_id, trade_id: f.trade_id, ticker: f.ticker, side: f.side, count: fp(f.count), price: cc$(f.price_cc),
    entry_price: cc$(f.entry_cc), realized_pnl: cc$(f.realized_cc), fees: cc$(f.fee_cc), is_taker: !!f.is_taker,
    order_source: f.source === 'user' ? 'user' : 'system', source_detail: f.source, created_time: new Date(f.created_ts).toISOString(), ts_ms: f.created_ts,
  });
  const tradeVo = (tr) => ({ trade_id: tr.id, ticker: tr.ticker, market_ticker: tr.ticker, price: cc$(tr.price_cc), count: fp(tr.count), count_fp: fp(tr.count), taker_side: tr.taker_side, is_liquidation: !!tr.is_liquidation, created_time: new Date(tr.created_ts).toISOString(), ts_ms: tr.created_ts });
  const transferVo = (x) => ({ transfer_id: x.id, source: x.source, destination: x.destination, amount: x.amount_cc, amount_dollars: cc$(x.amount_cc), status: x.status, client_transfer_id: x.client_transfer_id, created_time: new Date(x.created_ts).toISOString() });
  const liqVo = (l) => ({ id: l.id, ticker: l.ticker, side: l.side, count: fp(l.count), entry_price: cc$(l.entry_cc), mark_price: cc$(l.mark_cc), liquidation_price: cc$(l.liq_price_cc), margin: cc$(l.margin_cc), realized_pnl: cc$(l.realized_cc), liquidation_fee: cc$(l.fee_cc), returned: cc$(l.returned_cc), shortfall: cc$(l.shortfall_cc), created_time: new Date(l.created_ts).toISOString() });
  const fundingPayVo = (x) => ({ id: x.id, market_ticker: x.ticker, funding_time: new Date(x.funding_ts).toISOString(), funding_rate: x.rate, mark_price: cc$(x.mark_cc), funding_amount: cc$(x.amount_cc), quantity: fp(x.qty), subaccount_number: 0, subaccount_type: 'isolated' });

  function balanceVo(uid) {
    const a = account(uid);
    let posValue = 0; let margin = 0; let upnl = 0; let mm = 0; let im = 0;
    for (const p of db.prepare('SELECT * FROM perp_positions WHERE user_id=? AND qty<>0').all(uid)) {
      const m = getMarket(p.ticker); const mark = markCc(m);
      const u = p.qty * (mark - p.entry_cc);
      posValue += p.margin_cc + u; margin += p.margin_cc; upnl += u;
      mm += Math.abs(p.qty) * mark * mmRate(m); im += Math.abs(p.qty) * mark * imRate(m);
    }
    const resting = db.prepare("SELECT COALESCE(SUM(reserved_cc),0) c FROM perp_orders WHERE user_id=? AND status='resting'").get(uid).c;
    const equity = a.available_cc + resting + posValue;
    const cents = db.prepare('SELECT balance_cents FROM users WHERE id=?').get(uid)?.balance_cents ?? 0;
    return {
      subaccount_balances: [{ subaccount: 0, subaccount_type: 'isolated', position_value: cc$(posValue), account_equity: cc$(equity), maintenance_margin: cc$(mm), initial_margin: cc$(im), resting_orders_margin: cc$(resting), available_balance: cc$(a.available_cc) }],
      settled_funds: cc$(a.available_cc + resting + margin),
      available_dollars: cc$(a.available_cc), account_equity: cc$(equity), position_value: cc$(posValue), margin_in_use: cc$(margin),
      unrealized_pnl: cc$(upnl), resting_orders_margin: cc$(resting), maintenance_margin: cc$(mm), predictions_cash_dollars: dollars(cents),
    };
  }

  // ---------------------------------------------------------------- events
  const lastTickerEmit = new Map();
  function emitTicker(m, force = false) {
    const now = Date.now();
    if (!force && now - (lastTickerEmit.get(m.ticker) || 0) < 1000) return;
    lastTickerEmit.set(m.ticker, now);
    engine.emit('perp_ticker', m.ticker, tickerMsg(m));
  }
  function emitUser(uid, tickers) {
    if (!uid || uid === LP) return;
    engine.emit('perp_account', uid, balanceVo(uid));
    for (const t of tickers || []) {
      const p = position(uid, t);
      if (p) engine.emit('perp_position', uid, positionVo(p));
    }
  }

  // ---------------------------------------------------------------- fills
  // Apply one fill to a user's isolated position. Returns realized PnL (centicents).
  function applyFill(uid, m, { order, side, n, p, isTaker, feeRate, tradeId, ts, lev, source }) {
    const sys = uid === LP;
    account(uid);
    db.prepare('INSERT INTO perp_positions(user_id,ticker,updated_ts) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(uid, m.ticker, ts);
    const pos = position(uid, m.ticker);
    let { qty: q, entry_cc: entry, margin_cc: margin } = pos;
    const s = side === 'bid' ? 1 : -1;
    const entryBefore = entry;
    const closing = q !== 0 && Math.sign(q) !== s ? Math.min(n, Math.abs(q)) : 0;
    const open = n - closing;
    let realized = 0;
    let availDelta = 0;
    if (closing) {
      const rel = sys ? 0 : Math.round((margin * closing) / Math.abs(q));
      realized = Math.round(closing * (p - entry) * Math.sign(q));
      availDelta += rel + realized;
      margin -= rel;
      q += s * closing;
      if (q === 0) { availDelta += margin; margin = 0; entry = 0; }
    }
    let leverage = pos.leverage;
    if (open) {
      const need = sys ? 0 : Math.ceil((open * p) / lev);
      availDelta -= need;
      margin += need;
      entry = (Math.abs(q) * entry + open * p) / (Math.abs(q) + open);
      if (q === 0) leverage = lev;
      q += s * open;
    }
    const fee = sys ? 0 : feeCc(n, p, feeRate);
    availDelta -= fee;
    if (q !== 0 && !sys && margin > 0) leverage = Number(((Math.abs(q) * entry) / margin).toFixed(2));
    db.prepare('UPDATE perp_positions SET qty=?, entry_cc=?, margin_cc=?, leverage=?, fees_cc=CASE WHEN ?=0 THEN 0 ELSE fees_cc+? END, realized_cc=realized_cc+?, funding_cc=CASE WHEN ?=0 THEN 0 ELSE funding_cc END, opened_ts=CASE WHEN ?=0 THEN NULL WHEN opened_ts IS NULL THEN ? ELSE opened_ts END, updated_ts=? WHERE user_id=? AND ticker=?')
      .run(q, entry, margin, leverage, q, fee, realized, q, q, ts, ts, uid, m.ticker);
    addAvail(uid, availDelta);
    if (!sys) {
      const a = account(uid);
      if (a.available_cc < 0) { // loss beyond the isolated margin: absorbed by the insurance fund
        setMeta('insurance_shortfall_cc', Number(meta('insurance_shortfall_cc', 0)) - a.available_cc);
        db.prepare('UPDATE perp_accounts SET available_cc=0 WHERE user_id=?').run(uid);
      }
    }
    db.prepare('INSERT INTO perp_fills(id,trade_id,order_id,user_id,ticker,side,price_cc,count,is_taker,fee_cc,realized_cc,entry_cc,source,created_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(newId('pf_'), tradeId, order ? order.id : null, uid, m.ticker, side, p, n, isTaker ? 1 : 0, fee, realized, entryBefore, source, ts);
    ledger(uid, 'realized_pnl', realized, m.ticker, tradeId, `${closing} contracts closed`);
    ledger(uid, 'fee', -fee, m.ticker, tradeId, isTaker ? 'taker fee' : 'maker fee');
    if (q === 0 && pos.qty !== 0) {
      db.prepare("UPDATE perp_exit_triggers SET status='canceled', status_reason='position_closed', updated_ts=? WHERE user_id=? AND ticker=? AND status='active'").run(ts, uid, m.ticker);
    } else if (pos.qty !== 0 && Math.sign(q) !== Math.sign(pos.qty)) {
      db.prepare("UPDATE perp_exit_triggers SET status='canceled', status_reason='position_flipped', updated_ts=? WHERE user_id=? AND ticker=? AND status='active'").run(ts, uid, m.ticker);
    }
    return { realized, fee };
  }

  // ---------------------------------------------------------------- orders
  const TIF = { gtc: 'gtc', good_till_canceled: 'gtc', ioc: 'ioc', immediate_or_cancel: 'ioc', fok: 'fok', fill_or_kill: 'fok' };
  function normSide(v) {
    const s = String(v || '').toLowerCase();
    if (['bid', 'buy', 'long'].includes(s)) return 'bid';
    if (['ask', 'sell', 'short'].includes(s)) return 'ask';
    throw E.badRequest('side must be bid (long) or ask (short)');
  }
  function bandCheck(m, side, price) {
    const mark = markCc(m);
    const lo = Math.min(Math.floor(mark * (1 - BAND_PCT)), mark - BAND_TICKS);
    const hi = Math.max(Math.ceil(mark * (1 + BAND_PCT)), mark + BAND_TICKS);
    const fail = (ref) => new ApiError(400, 'price_outside_band', 'order price is outside the price band',
      `${side === 'bid' ? 'buy' : 'sell'} price ${fmtUnderlying(m, price)} must be between ${fmtUnderlying(m, Math.max(1, ref[0]))} and ${fmtUnderlying(m, ref[1])}`);
    if (price < lo || price > hi) throw fail([lo, hi]);
    // Same-side band from the docs: bids >= min(80% of best bid, best bid - 1,000 ticks); asks <= max(120% of best ask, best ask + 1,000 ticks).
    const b = best(m.ticker, side);
    if (b && side === 'bid' && price < Math.min(Math.floor(b.p * (1 - BAND_PCT)), b.p - BAND_TICKS)) throw fail([Math.min(Math.floor(b.p * (1 - BAND_PCT)), b.p - BAND_TICKS), hi]);
    if (b && side === 'ask' && price > Math.max(Math.ceil(b.p * (1 + BAND_PCT)), b.p + BAND_TICKS)) throw fail([lo, Math.max(Math.ceil(b.p * (1 + BAND_PCT)), b.p + BAND_TICKS)]);
  }

  // Core placement. Runs inside a transaction; returns what happened so the caller can publish events.
  function placeCore(uid, body, { source = 'user', skipBand = false } = {}) {
    const sys = uid === LP;
    const m = mustMarket(body.ticker);
    if (m.status !== 'active') throw E.conflict('market_inactive', 'market is not open for trading', `market status is ${m.status}`);
    if (!engine.tradingActive) throw E.conflict('trading_paused', 'trading is paused');
    const side = normSide(body.side ?? body.direction ?? body.action);
    const type = body.type || 'limit';
    if (!['limit', 'market'].includes(type)) throw E.badRequest('type must be limit or market');
    let count = Number(body.count ?? body.count_fp);
    if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) throw E.badRequest(`count must be a whole number of contracts between 1 and ${MAX_COUNT.toLocaleString('en-US')}`);
    let tif = TIF[String(body.time_in_force || (type === 'market' ? 'ioc' : 'gtc'))];
    if (!tif) throw E.badRequest('time_in_force must be good_till_canceled, immediate_or_cancel or fill_or_kill');
    const reduceOnly = !!body.reduce_only;
    const postOnly = !!body.post_only;
    const mark = markCc(m);
    let price;
    if (type === 'market') {
      if (tif === 'gtc') tif = 'ioc';
      price = side === 'bid' ? Math.ceil(mark * (1 + MARKET_SLIPPAGE)) : Math.max(1, Math.floor(mark * (1 - MARKET_SLIPPAGE)));
    } else {
      const raw = body.price ?? body.price_dollars;
      const n = Number(raw);
      if (raw == null || raw === '' || !Number.isFinite(n) || n <= 0) throw E.badRequest('price is required for limit orders (dollars per contract)');
      price = Math.round(n * CC);
      if (Math.abs(n * CC - price) > 1e-6) throw E.badRequest('price must be a multiple of the $0.0001 tick');
    }
    let lev = Number(body.leverage ?? 1);
    if (!Number.isFinite(lev) || lev < 1 || lev > m.max_leverage) throw E.badRequest(`leverage must be between 1x and ${m.max_leverage}x for ${m.title}`);
    const pos = position(uid, m.ticker) || { qty: 0, leverage: 1 };
    if (reduceOnly) {
      if (tif === 'gtc') throw E.badRequest('reduce-only orders must be immediate_or_cancel or fill_or_kill');
      const s = side === 'bid' ? 1 : -1;
      if (pos.qty === 0 || Math.sign(pos.qty) === s) throw E.conflict('reduce_only_no_position', 'reduce-only order would not reduce a position');
      count = Math.min(count, Math.abs(pos.qty));
      lev = pos.leverage || 1;
    }
    if (!sys && !skipBand) bandCheck(m, side, price);

    // Plan the match (price-time priority; self-trade prevention = taker_at_cross).
    const makers = db.prepare(side === 'bid'
      ? "SELECT * FROM perp_orders WHERE ticker=? AND status='resting' AND side='ask' AND price_cc<=? ORDER BY price_cc ASC, rowid ASC"
      : "SELECT * FROM perp_orders WHERE ticker=? AND status='resting' AND side='bid' AND price_cc>=? ORDER BY price_cc DESC, rowid ASC").all(m.ticker, price);
    const plan = [];
    let rem = count;
    let stpHit = false;
    for (const mk of makers) {
      if (rem === 0) break;
      if (mk.user_id === uid) { stpHit = true; break; }
      const n = Math.min(rem, mk.remaining_count);
      plan.push({ mk, n, p: mk.price_cc });
      rem -= n;
    }
    if (postOnly && plan.length) throw E.conflict('post_only_cross', 'post-only order would cross the book');
    if (tif === 'fok' && rem > 0) throw E.conflict('fill_or_kill_unfilled', 'fill-or-kill order could not be filled in full');
    const willRest = tif === 'gtc' && rem > 0 && !stpHit;
    // Margin check: walk the planned fills against available collateral.
    let reserve = 0;
    if (!sys) {
      const a = account(uid);
      let avail = a.available_cc;
      let q = pos.qty; let entry = pos.entry_cc || 0; let margin = pos.margin_cc || 0;
      const s = side === 'bid' ? 1 : -1;
      for (const { n, p } of plan) {
        const closing = q !== 0 && Math.sign(q) !== s ? Math.min(n, Math.abs(q)) : 0;
        const open = n - closing;
        if (closing) { const rel = Math.round((margin * closing) / Math.abs(q)); avail += rel + Math.round(closing * (p - entry) * Math.sign(q)); margin -= rel; q += s * closing; if (q === 0) { avail += margin; margin = 0; entry = 0; } }
        if (open) { const need = Math.ceil((open * p) / lev); avail -= need; margin += need; entry = (Math.abs(q) * entry + open * p) / (Math.abs(q) + open); q += s * open; }
        avail -= feeCc(n, p, m.taker_fee_rate);
      }
      if (willRest) { reserve = rem * reservePer(m, price, lev); avail -= reserve; }
      if (avail < 0) {
        const need = a.available_cc - avail;
        throw E.conflict('insufficient_margin', 'insufficient perps collateral', `this order needs $${(need / CC).toFixed(2)} of margin and fees; you have $${(a.available_cc / CC).toFixed(2)} available in Perps`);
      }
    }

    const ts = Date.now();
    const id = newId('po_');
    db.prepare('INSERT INTO perp_orders(id,user_id,ticker,side,type,price_cc,initial_count,remaining_count,status,time_in_force,reduce_only,post_only,leverage,source,client_order_id,created_ts,updated_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, uid, m.ticker, side, type, price, count, count, 'resting', tif, reduceOnly ? 1 : 0, postOnly ? 1 : 0, lev, source, body.client_order_id ?? null, ts, ts);
    const order = { id };
    const trades = [];
    const touched = new Map([[uid, new Set([m.ticker])]]);
    const makerOrders = [];
    for (const { mk, n, p } of plan) {
      const tradeId = newId('pt_');
      db.prepare('INSERT INTO perp_trades(id,ticker,price_cc,count,taker_side,is_liquidation,created_ts) VALUES(?,?,?,?,?,0,?)').run(tradeId, m.ticker, p, n, side, ts);
      trades.push({ id: tradeId, ticker: m.ticker, price_cc: p, count: n, taker_side: side, is_liquidation: 0, created_ts: ts });
      // maker: release its reservation share, then book the fill
      const share = mk.remaining_count ? Math.round((mk.reserved_cc * n) / mk.remaining_count) : 0;
      if (share) addAvail(mk.user_id, share);
      const mkFill = applyFill(mk.user_id, m, { order: mk, side: mk.side, n, p, isTaker: false, feeRate: m.maker_fee_rate, tradeId, ts, lev: mk.leverage, source: mk.source });
      const left = mk.remaining_count - n;
      db.prepare('UPDATE perp_orders SET remaining_count=?, filled_count=filled_count+?, fill_cost_cc=fill_cost_cc+?, reserved_cc=reserved_cc-?, fees_cc=fees_cc+?, status=?, updated_ts=? WHERE id=?')
        .run(left, n, n * p, share, mkFill.fee, left === 0 ? 'executed' : 'resting', ts, mk.id);
      mk.remaining_count = left; mk.reserved_cc -= share;
      makerOrders.push(mk.id);
      if (!touched.has(mk.user_id)) touched.set(mk.user_id, new Set());
      touched.get(mk.user_id).add(m.ticker);
      const tk = applyFill(uid, m, { order, side, n, p, isTaker: true, feeRate: m.taker_fee_rate, tradeId, ts, lev, source });
      db.prepare('UPDATE perp_orders SET remaining_count=remaining_count-?, filled_count=filled_count+?, fill_cost_cc=fill_cost_cc+?, fees_cc=fees_cc+?, updated_ts=? WHERE id=?').run(n, n, n * p, tk.fee, ts, id);
    }
    if (rem === 0) db.prepare("UPDATE perp_orders SET status='executed' WHERE id=?").run(id);
    else if (willRest) {
      db.prepare('UPDATE perp_orders SET reserved_cc=? WHERE id=?').run(reserve, id);
      if (!sys) addAvail(uid, -reserve);
    } else db.prepare("UPDATE perp_orders SET status='canceled' WHERE id=?").run(id);
    return { m, order: db.prepare('SELECT * FROM perp_orders WHERE id=?').get(id), trades, touched, makerOrders };
  }

  function publishPlacement(res, { quiet = false } = {}) {
    const { m, order, trades, touched, makerOrders } = res;
    for (const tr of trades) engine.emit('perp_trade', m.ticker, tradeVo(tr));
    if (!quiet || trades.length) { engine.emit('perp_book', m.ticker, bookMsg(m.ticker)); emitTicker(getMarket(m.ticker), true); }
    if (order.user_id !== LP) engine.emit('perp_order', order.user_id, orderVo(order));
    for (const mid of makerOrders) {
      const mo = db.prepare('SELECT * FROM perp_orders WHERE id=?').get(mid);
      if (mo.user_id === LP) continue;
      engine.emit('perp_order', mo.user_id, orderVo(mo));
      notify(mo.user_id, { type: 'perp_fill', title: `Limit order filled: ${mo.side === 'bid' ? 'Long' : 'Short'} ${mo.filled_count} ${m.title} at ${fmtUnderlying(m, mo.price_cc)}`, body: `${m.title} perpetual`, link: `/perps/${m.ticker}` });
    }
    for (const [uid, ts] of touched) emitUser(uid, [...ts]);
    if (order.user_id !== LP && order.filled_count > 0 && order.source === 'user') {
      notify(order.user_id, { type: 'perp_fill', title: `${order.reduce_only ? 'Closed' : order.side === 'bid' ? 'Long' : 'Short'} ${order.filled_count} ${m.title} filled at ${fmtUnderlying(m, Math.round(order.fill_cost_cc / order.filled_count))}`, body: `${m.title} perpetual · ${order.leverage}x`, link: `/perps/${m.ticker}` });
    }
  }

  function placeOrder(uid, body, opts = {}) {
    const res = tx(db, () => placeCore(uid, body, opts));
    publishPlacement(res);
    return res.order;
  }

  function cancelOrder(uid, oid) {
    const res = tx(db, () => {
      const o = db.prepare('SELECT * FROM perp_orders WHERE id=?').get(oid);
      if (!o || o.user_id !== uid) throw E.notFound();
      if (o.status !== 'resting') throw E.conflict('order_not_resting', 'order is not resting', `order status is ${o.status}`);
      db.prepare("UPDATE perp_orders SET status='canceled', reserved_cc=0, updated_ts=? WHERE id=?").run(Date.now(), oid);
      if (o.reserved_cc && uid !== LP) addAvail(uid, o.reserved_cc);
      return db.prepare('SELECT * FROM perp_orders WHERE id=?').get(oid);
    });
    engine.emit('perp_book', res.ticker, bookMsg(res.ticker));
    engine.emit('perp_order', uid, orderVo(res));
    emitUser(uid, []);
    return res;
  }

  // ---------------------------------------------------------------- liquidity account
  const lastQuote = new Map();
  function requote(m, now, force = false) {
    if (!LP || m.status !== 'active' || !engine.tradingActive) return;
    const mark = markCc(m);
    const lpRest = db.prepare("SELECT COALESCE(SUM(remaining_count),0) r FROM perp_orders WHERE ticker=? AND user_id=? AND status='resting'").get(m.ticker, LP).r;
    const lq = lastQuote.get(m.ticker);
    const changed = !lq || lq.mark !== mark || lq.basis !== m.basis || lq.rest !== lpRest;
    if (!force && (!changed || (lq && now - lq.ts < 1000))) return;
    const results = [];
    tx(db, () => {
      db.prepare("DELETE FROM perp_orders WHERE ticker=? AND user_id=? AND status='resting' AND filled_count=0").run(m.ticker, LP);
      db.prepare("UPDATE perp_orders SET status='canceled', updated_ts=? WHERE ticker=? AND user_id=? AND status='resting'").run(now, m.ticker, LP);
      const center = mark * (1 + m.basis);
      const hs = Math.max(1, Math.round(center * 0.00015));
      const step = Math.max(1, Math.round(center * 0.0002));
      const base = Math.max(1, Math.round(LP_LEVEL_NOTIONAL_CC / center));
      for (let i = 0; i < LP_LEVELS; i += 1) {
        const size = Math.round(base * (1 + i * 0.35));
        const ask = Math.round(center + hs + i * step);
        const bid = Math.max(1, Math.round(center - hs - i * step));
        results.push(placeCore(LP, { ticker: m.ticker, side: 'ask', price: ask / CC, count: size, type: 'limit' }, { source: 'liquidity' }));
        results.push(placeCore(LP, { ticker: m.ticker, side: 'bid', price: bid / CC, count: size, type: 'limit' }, { source: 'liquidity' }));
      }
    });
    for (const r of results) if (r.trades.length) publishPlacement(r, { quiet: true });
    const rest = db.prepare("SELECT COALESCE(SUM(remaining_count),0) r FROM perp_orders WHERE ticker=? AND user_id=? AND status='resting'").get(m.ticker, LP).r;
    lastQuote.set(m.ticker, { mark, basis: m.basis, rest, ts: now });
    engine.emit('perp_book', m.ticker, bookMsg(m.ticker));
  }

  // ---------------------------------------------------------------- exit triggers (TP/SL on mark)
  function evalTriggers(m) {
    const mark = markCc(m);
    for (const t of db.prepare("SELECT * FROM perp_exit_triggers WHERE ticker=? AND status='active'").all(m.ticker)) {
      const p = position(t.user_id, m.ticker);
      const now = Date.now();
      if (!p || p.qty === 0) { db.prepare("UPDATE perp_exit_triggers SET status='canceled', status_reason='position_closed', updated_ts=? WHERE id=?").run(now, t.id); continue; }
      const long = p.qty > 0;
      let leg = null;
      if (t.take_profit_cc != null && (long ? mark >= t.take_profit_cc : mark <= t.take_profit_cc)) leg = 'take_profit';
      else if (t.stop_loss_cc != null && (long ? mark <= t.stop_loss_cc : mark >= t.stop_loss_cc)) leg = 'stop_loss';
      if (!leg) continue;
      const count = t.count > 0 ? Math.min(t.count, Math.abs(p.qty)) : Math.abs(p.qty);
      try {
        const o = placeOrder(t.user_id, { ticker: m.ticker, side: long ? 'ask' : 'bid', type: 'market', count, reduce_only: true }, { source: 'exit_trigger', skipBand: true });
        const after = position(t.user_id, m.ticker);
        db.prepare('UPDATE perp_exit_triggers SET status=?, status_reason=?, triggered_leg=?, triggered_order_id=?, filled_count=filled_count+?, updated_ts=? WHERE id=?')
          .run(!after || after.qty === 0 ? 'filled' : 'active', null, leg, o.id, o.filled_count, Date.now(), t.id);
        const px = o.filled_count ? Math.round(o.fill_cost_cc / o.filled_count) : mark;
        notify(t.user_id, { type: 'perp_exit_trigger', title: `${leg === 'take_profit' ? 'Take profit' : 'Stop loss'} hit: closed ${long ? 'Long' : 'Short'} ${o.filled_count} ${m.title} at ${fmtUnderlying(m, px)}`, body: `${m.title} perpetual`, link: `/perps/${m.ticker}` });
        emitUser(t.user_id, [m.ticker]);
      } catch (e) {
        db.prepare("UPDATE perp_exit_triggers SET status='failed', status_reason='order_rejected', triggered_leg=?, updated_ts=? WHERE id=?").run(leg, Date.now(), t.id);
        notify(t.user_id, { type: 'perp_exit_trigger', title: `${leg === 'take_profit' ? 'Take profit' : 'Stop loss'} could not close your ${m.title} position`, body: e.message, link: `/perps/${m.ticker}` });
      }
    }
  }

  // ---------------------------------------------------------------- liquidation (equity < maintenance margin)
  function checkLiquidations(m) {
    const mark = markCc(m);
    const r = mmRate(m);
    for (const p of db.prepare('SELECT * FROM perp_positions WHERE ticker=? AND qty<>0 AND user_id<>?').all(m.ticker, LP || '')) {
      const equity = p.margin_cc + p.qty * (mark - p.entry_cc);
      const mm = Math.abs(p.qty) * mark * r;
      if (equity >= mm) continue;
      liquidate(p, m, mark);
    }
  }
  function liquidate(p, m, mark) {
    const ts = Date.now();
    const q = p.qty;
    const n = Math.abs(q);
    const side = q > 0 ? 'ask' : 'bid';
    const realized = Math.round(q * (mark - p.entry_cc));
    const remaining = p.margin_cc + realized;
    const mmAmt = Math.round(n * mark * mmRate(m));
    const fee = remaining > 0 ? Math.min(remaining, Math.round(mmAmt / 2)) : 0;
    const returned = Math.max(0, remaining - fee);
    const shortfall = remaining < 0 ? -remaining : 0;
    const liqPx = liqPriceCc(q, p.entry_cc, p.margin_cc, mmRate(m));
    const tradeId = newId('pt_');
    tx(db, () => {
      db.prepare('INSERT INTO perp_trades(id,ticker,price_cc,count,taker_side,is_liquidation,created_ts) VALUES(?,?,?,?,?,1,?)').run(tradeId, m.ticker, mark, n, side, ts);
      db.prepare('UPDATE perp_positions SET qty=0, entry_cc=0, margin_cc=0, fees_cc=0, funding_cc=0, realized_cc=realized_cc+?, opened_ts=NULL, updated_ts=? WHERE user_id=? AND ticker=?').run(realized, ts, p.user_id, m.ticker);
      addAvail(p.user_id, returned);
      db.prepare('INSERT INTO perp_fills(id,trade_id,order_id,user_id,ticker,side,price_cc,count,is_taker,fee_cc,realized_cc,entry_cc,source,created_ts) VALUES(?,?,?,?,?,?,?,?,1,?,?,?,?,?)')
        .run(newId('pf_'), tradeId, null, p.user_id, m.ticker, side, mark, n, fee, realized, p.entry_cc, 'liquidation', ts);
      db.prepare('INSERT INTO perp_liquidations(id,user_id,ticker,side,count,entry_cc,mark_cc,liq_price_cc,margin_cc,realized_cc,fee_cc,returned_cc,shortfall_cc,created_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(newId('lq_'), p.user_id, m.ticker, q > 0 ? 'long' : 'short', n, p.entry_cc, mark, liqPx, p.margin_cc, realized, fee, returned, shortfall, ts);
      if (shortfall) setMeta('insurance_shortfall_cc', Number(meta('insurance_shortfall_cc', 0)) + shortfall);
      ledger(p.user_id, 'liquidation', realized, m.ticker, tradeId, `liquidated ${n} contracts at mark`);
      ledger(p.user_id, 'liquidation_fee', -fee, m.ticker, tradeId, 'liquidation fee');
      db.prepare("UPDATE perp_exit_triggers SET status='canceled', status_reason='position_closed', updated_ts=? WHERE user_id=? AND ticker=? AND status='active'").run(ts, p.user_id, m.ticker);
      // The liquidity account takes over the position at mark.
      if (LP) applyFill(LP, m, { order: null, side: q > 0 ? 'bid' : 'ask', n, p: mark, isTaker: false, feeRate: 0, tradeId, ts, lev: 1, source: 'liquidation' });
    });
    engine.emit('perp_trade', m.ticker, tradeVo({ id: tradeId, ticker: m.ticker, price_cc: mark, count: n, taker_side: side, is_liquidation: 1, created_ts: ts }));
    notify(p.user_id, { type: 'perp_liquidation', title: `Liquidated: ${q > 0 ? 'Long' : 'Short'} ${n} ${m.title} closed at ${fmtUnderlying(m, mark)}`, body: `Equity fell below maintenance margin. Returned $${(returned / CC).toFixed(2)} to your Perps balance.`, link: `/perps/${m.ticker}` });
    emitUser(p.user_id, [m.ticker]);
  }

  // ---------------------------------------------------------------- funding
  function runFunding(m, now = Date.now()) {
    const mark = markCc(m);
    const { rate, premium } = fundingEstimate(m);
    const interval = intervalOf(m);
    let next = m.next_funding_ts + interval;
    if (next <= now) next = now + interval;
    const paid = [];
    tx(db, () => {
      db.prepare('INSERT INTO perp_funding_rates(id,ticker,funding_ts,rate,mark_cc,premium) VALUES(?,?,?,?,?,?)').run(newId('fr_'), m.ticker, now, rate, mark, Number(premium.toFixed(8)));
      for (const p of db.prepare('SELECT * FROM perp_positions WHERE ticker=? AND qty<>0').all(m.ticker)) {
        const amount = Math.round(-p.qty * mark * rate); // positive rate: longs pay shorts
        if (p.user_id === LP) addAvail(LP, amount);
        else {
          const newMargin = p.margin_cc + amount;
          if (newMargin < 0) { addAvail(p.user_id, newMargin); }
          db.prepare('UPDATE perp_positions SET margin_cc=?, updated_ts=? WHERE user_id=? AND ticker=?').run(Math.max(0, newMargin), now, p.user_id, m.ticker);
        }
        db.prepare('UPDATE perp_positions SET funding_cc=funding_cc+? WHERE user_id=? AND ticker=?').run(amount, p.user_id, m.ticker);
        db.prepare('INSERT INTO perp_funding_payments(id,user_id,ticker,funding_ts,rate,mark_cc,qty,amount_cc) VALUES(?,?,?,?,?,?,?,?)').run(newId('fp_'), p.user_id, m.ticker, now, rate, mark, p.qty, amount);
        ledger(p.user_id, 'funding', amount, m.ticker, null, `funding at ${(rate * 100).toFixed(4)}%`);
        paid.push({ uid: p.user_id, amount, qty: p.qty });
      }
      db.prepare('UPDATE perp_markets SET premium_sum=0, premium_n=0, last_funding_ts=?, next_funding_ts=? WHERE ticker=?').run(now, next, m.ticker);
    });
    for (const x of paid) {
      if (x.uid === LP) continue;
      emitUser(x.uid, [m.ticker]);
      const a = account(x.uid);
      if (now - a.last_funding_notice_ts >= HOUR) { // at most one funding notification per user per hour
        db.prepare('UPDATE perp_accounts SET last_funding_notice_ts=? WHERE user_id=?').run(now, x.uid);
        notify(x.uid, { type: 'margin_funding_payment', title: `Funding ${x.amount >= 0 ? 'received' : 'paid'}: $${(Math.abs(x.amount) / CC).toFixed(4)} on ${m.title}`, body: `Rate ${(rate * 100).toFixed(4)}% on your ${x.qty > 0 ? 'long' : 'short'} position`, link: '/portfolio?perpsTab=history' });
      }
    }
    emitTicker(getMarket(m.ticker), true);
    return { rate, payments: paid.length };
  }

  // ---------------------------------------------------------------- simulation tick
  function simStep(m, now) {
    const dt = clamp(now - m.sim_ts, 0, 60000);
    if (dt <= 0) return m;
    const g1 = gauss(m.sim_state); const g2 = gauss(g1.state);
    const sigma = m.daily_vol * Math.sqrt(dt / DAY);
    const drift = -2 * Math.log(m.index_price / m.anchor_price) * (dt / DAY);
    const index = m.index_price * Math.exp(sigma * g1.z + drift);
    const basis = clamp(m.basis * 0.98 + 0.00004 * g2.z, -0.0005, 0.0005);
    return { ...m, index_price: Number(index.toPrecision(12)), basis: Number(basis.toFixed(8)), sim_state: g2.state, sim_ts: now };
  }
  function recordHistory(m, now) {
    const mark = markCc(m);
    db.prepare(`INSERT INTO perp_price_history(ticker,ts,step_ms,open_cc,high_cc,low_cc,close_cc) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(ticker,ts) DO UPDATE SET high_cc=max(high_cc,excluded.high_cc), low_cc=min(low_cc,excluded.low_cc), close_cc=excluded.close_cc`)
      .run(m.ticker, Math.floor(now / MIN) * MIN, MIN, mark, mark, mark, mark);
  }
  function samplePremium(m) {
    const bb = best(m.ticker, 'bid'); const ba = best(m.ticker, 'ask');
    if (!bb || !ba) return m;
    const mark = markCc(m);
    const prem = ((bb.p + ba.p) / 2 - mark) / mark;
    return { ...m, premium_sum: m.premium_sum + prem, premium_n: m.premium_n + 1 };
  }
  const saveSim = (m) => db.prepare('UPDATE perp_markets SET index_price=?, basis=?, sim_state=?, sim_ts=?, premium_sum=?, premium_n=? WHERE ticker=?').run(m.index_price, m.basis, m.sim_state, m.sim_ts, m.premium_sum, m.premium_n, m.ticker);

  let lastPrune = 0;
  function tick(now = Date.now()) {
    for (const m0 of db.prepare("SELECT * FROM perp_markets WHERE status='active' ORDER BY sort_order").all()) {
      let m = m0.sim_frozen ? { ...m0, sim_ts: now } : simStep(m0, now);
      recordHistory(m, now);
      m = samplePremium(m);
      saveSim(m);
      requote(m, now);
      evalTriggers(m);
      checkLiquidations(m);
      m = getMarket(m.ticker);
      if (now >= m.next_funding_ts) { runFunding(m, now); checkLiquidations(getMarket(m.ticker)); }
      emitTicker(getMarket(m.ticker));
    }
    if (now - lastPrune > HOUR) { lastPrune = now; db.prepare('DELETE FROM perp_price_history WHERE ts<?').run(now - 30 * DAY); }
  }
  engine.on('tick', () => { try { tick(); } catch (e) { console.error('perps tick', e); } });
  try { tick(); } catch (e) { console.error('perps boot tick', e); } // quote immediately on boot

  // Admin / test hook: set the simulated index (underlying units) and optionally freeze the simulation.
  function setIndex(ticker, price, { freeze } = {}) {
    const m0 = mustMarket(ticker);
    const px = Number(price);
    if (!(px > 0)) throw E.badRequest('price must be a positive number');
    const frozen = freeze == null ? m0.sim_frozen : (freeze ? 1 : 0);
    // Pinning (freezing) starts a fresh premium window with a flat basis, so the next funding rate is the interest component only.
    const pin = frozen && !m0.sim_frozen ? 1 : 0;
    db.prepare('UPDATE perp_markets SET index_price=?, sim_frozen=?, basis=CASE WHEN ?=1 THEN 0 ELSE basis END, premium_sum=CASE WHEN ?=1 THEN 0 ELSE premium_sum END, premium_n=CASE WHEN ?=1 THEN 0 ELSE premium_n END, sim_ts=? WHERE ticker=?').run(px, frozen, frozen, pin, pin, Date.now(), m0.ticker);
    let m = getMarket(m0.ticker);
    recordHistory(m, Date.now());
    requote(m, Date.now(), true);
    evalTriggers(m);
    checkLiquidations(m);
    m = getMarket(m0.ticker);
    emitTicker(m, true);
    return m;
  }

  // ======================================================== REST: public market data
  const P = '/perps';
  v1.get(`${P}/enabled`, (req, res) => res.json({ enabled: !!req.auth }));
  v1.get(`${P}/exchange/status`, (req, res) => res.json({ exchange_active: true, trading_active: engine.tradingActive }));
  v1.get(`${P}/asset_classes`, (req, res) => {
    const counts = Object.fromEntries(db.prepare('SELECT asset_class c, COUNT(*) n FROM perp_markets GROUP BY asset_class').all().map((r) => [r.c, r.n]));
    res.json({ asset_classes: ASSET_CLASSES.filter((c) => counts[c]).map((c) => ({ name: c, slug: c.toLowerCase(), count: counts[c] })) });
  });
  v1.get(`${P}/markets`, (req, res) => {
    const args = []; const where = [];
    if (req.query.asset_class) { where.push('lower(asset_class)=lower(?)'); args.push(String(req.query.asset_class)); }
    if (req.query.status) { where.push('status=?'); args.push(String(req.query.status)); }
    const rows = db.prepare(`SELECT * FROM perp_markets ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY sort_order`).all(...args);
    res.json({ markets: rows.map(marketVo), cursor: '' });
  });
  v1.get(`${P}/markets/:ticker`, (req, res) => res.json({ market: marketVo(mustMarket(req.params.ticker)) }));
  v1.get(`${P}/markets/:ticker/orderbook`, (req, res) => {
    const m = mustMarket(req.params.ticker);
    const depth = Math.max(0, Math.min(100, Number(req.query.depth || 0) | 0));
    res.json({ orderbook: book(m.ticker, depth) });
  });
  v1.get(`${P}/markets/:ticker/trades`, (req, res) => {
    const m = mustMarket(req.params.ticker);
    const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 50) | 0));
    res.json({ trades: db.prepare('SELECT * FROM perp_trades WHERE ticker=? ORDER BY created_ts DESC, rowid DESC LIMIT ?').all(m.ticker, limit).map(tradeVo), cursor: '' });
  });
  const PERIODS = new Set([1, 5, 15, 60, 1440]);
  v1.get(`${P}/markets/:ticker/candlesticks`, (req, res) => {
    const m = mustMarket(req.params.ticker);
    const period = Number(req.query.period_interval || 60);
    if (!PERIODS.has(period)) throw E.badRequest('period_interval must be one of 1, 5, 15, 60, 1440');
    const now = Date.now();
    const end = req.query.end_ts ? Number(req.query.end_ts) * 1000 : now;
    const start = req.query.start_ts ? Number(req.query.start_ts) * 1000 : end - DAY;
    if (!(end > start)) throw E.badRequest('end_ts must be after start_ts');
    const pms = period * MIN;
    const rows = db.prepare('SELECT * FROM perp_price_history WHERE ticker=? AND ts>=? AND ts<=? ORDER BY ts').all(m.ticker, Math.floor(start / pms) * pms, end);
    const trades = db.prepare('SELECT price_cc, count, created_ts FROM perp_trades WHERE ticker=? AND created_ts>=? AND created_ts<=?').all(m.ticker, start, end);
    const buckets = new Map();
    for (const r of rows) {
      const b = Math.floor(r.ts / pms) * pms;
      const c = buckets.get(b);
      if (!c) buckets.set(b, { o: r.open_cc, h: r.high_cc, l: r.low_cc, c: r.close_cc, v: 0, d: 0 });
      else { c.h = Math.max(c.h, r.high_cc); c.l = Math.min(c.l, r.low_cc); c.c = r.close_cc; }
    }
    for (const t of trades) { const c = buckets.get(Math.floor(t.created_ts / pms) * pms); if (c) { c.v += t.count; c.d += t.count * t.price_cc; } }
    let prev = null;
    const candles = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([b, c]) => {
      const out = { end_period_ts: Math.floor((b + pms) / 1000), price: { open: cc$(c.o), high: cc$(c.h), low: cc$(c.l), close: cc$(c.c), mean: c.v ? cc$(c.d / c.v) : null, previous: prev }, volume: fp(c.v), volume_notional_value_dollars: cc$(c.d), open_interest: fp(0), open_interest_notional_value_dollars: cc$(0) };
      prev = cc$(c.c);
      return out;
    });
    res.json({ ticker: m.ticker, candlesticks: candles });
  });
  v1.get(`${P}/funding_rates/historical`, (req, res) => {
    const args = []; const where = [];
    if (req.query.ticker) { where.push('ticker=?'); args.push(String(req.query.ticker).toUpperCase()); }
    if (req.query.start_ts) { where.push('funding_ts>=?'); args.push(Number(req.query.start_ts) * 1000); }
    if (req.query.end_ts) { where.push('funding_ts<=?'); args.push(Number(req.query.end_ts) * 1000); }
    const rows = db.prepare(`SELECT * FROM perp_funding_rates ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY funding_ts DESC LIMIT 500`).all(...args);
    res.json({ funding_rates: rows.map((r) => ({ market_ticker: r.ticker, funding_time: new Date(r.funding_ts).toISOString(), funding_rate: r.rate, mark_price: cc$(r.mark_cc) })) });
  });
  v1.get(`${P}/funding_rates/estimate`, (req, res) => {
    if (!req.query.ticker) throw E.badRequest('ticker is required');
    const m = mustMarket(req.query.ticker);
    const est = fundingEstimate(m);
    res.json({ market_ticker: m.ticker, computed_time: nowIso(), funding_rate: est.rate, mark_price: cc$(markCc(m)), next_funding_time: new Date(m.next_funding_ts).toISOString(), premium_index: est.premium.toFixed(8), premium_index_ts: nowIso(), funding_interval_ms: intervalOf(m) });
  });
  v1.get(`${P}/funding_schedule`, (req, res) => {
    const ac = String(req.query.asset_class || '');
    const m = db.prepare('SELECT funding_schedule FROM perp_markets WHERE lower(asset_class)=lower(?) LIMIT 1').get(ac);
    if (!m) throw E.badRequest('unknown asset_class');
    res.json({ schedule: m.funding_schedule, timezone: 'UTC' });
  });
  v1.get(`${P}/risk_parameters`, (req, res) => {
    const ms = db.prepare('SELECT * FROM perp_markets ORDER BY sort_order').all();
    res.json({
      liquidation_margin_ratio_threshold: 1.0, queue_entry_margin_ratio_threshold: 1.0,
      initial_margin_multiplier: Object.fromEntries(ms.map((m) => [m.ticker, m.im_multiplier])),
      maintenance_margin_rate: Object.fromEntries(ms.map((m) => [m.ticker, Number(mmRate(m).toFixed(6))])),
      max_leverage: Object.fromEntries(ms.map((m) => [m.ticker, m.max_leverage])),
      price_band: { percent: BAND_PCT, ticks: BAND_TICKS }, market_order_slippage: MARKET_SLIPPAGE,
    });
  });
  v1.get(`${P}/fee_tiers`, (req, res) => {
    const ms = db.prepare('SELECT ticker, maker_fee_rate, taker_fee_rate FROM perp_markets').all();
    res.json({ maker_fee_rates: Object.fromEntries(ms.map((m) => [m.ticker, m.maker_fee_rate])), taker_fee_rates: Object.fromEntries(ms.map((m) => [m.ticker, m.taker_fee_rate])) });
  });

  // ======================================================== REST: authenticated
  const uidOf = (req) => req.auth.user.id;
  v1.get(`${P}/balance`, requireUser, (req, res) => res.json(balanceVo(uidOf(req))));

  v1.post(`${P}/transfers`, requireUser, (req, res) => {
    const uid = uidOf(req);
    const b = req.body || {};
    let dir = b.direction;
    if (!dir && b.source && b.destination) dir = b.source === 'event_contract' && b.destination === 'margined' ? 'to_perps' : b.source === 'margined' && b.destination === 'event_contract' ? 'to_predictions' : null;
    if (!['to_perps', 'to_predictions'].includes(dir)) throw E.badRequest('direction must be to_perps or to_predictions (or source/destination event_contract|margined)');
    let cents;
    if (b.amount_dollars != null) cents = Math.round(Number(b.amount_dollars) * 100);
    else if (b.amount != null) { const ccAmt = Number(b.amount); if (!Number.isInteger(ccAmt) || ccAmt % 100 !== 0) throw E.badRequest('amount is in centicents and must be a whole number of cents'); cents = ccAmt / 100; }
    if (!Number.isInteger(cents) || cents < 1 || Math.abs(Number(b.amount_dollars ?? cents / 100) * 100 - cents) > 1e-6) throw E.badRequest('amount must be at least $0.01, in whole cents');
    if (b.client_transfer_id && db.prepare('SELECT 1 FROM perp_transfers WHERE user_id=? AND client_transfer_id=?').get(uid, String(b.client_transfer_id))) throw E.conflict('duplicate_transfer', 'a transfer with this client_transfer_id already exists');
    const ccAmt = cents * 100;
    const id = newId('tr_');
    const t = tx(db, () => {
      const a = account(uid);
      if (dir === 'to_perps') {
        if (engine.balance(uid) < cents) throw E.conflict('insufficient_balance', 'insufficient balance', `you have $${(engine.balance(uid) / 100).toFixed(2)} of prediction cash`);
        // Non-withdrawable promotional credits stay with predictions (server/payments.js, CLONE_SPEC.md §26.5).
        if (engine.transferableCents && engine.transferableCents(uid) < cents) throw E.conflict('credits_not_transferable', 'promotional credits cannot be moved to Perps', `you can move up to $${(engine.transferableCents(uid) / 100).toFixed(2)} of cash`);
        engine.credit(uid, -cents, 'perps_transfer', id, 'Transfer to Perps');
        addAvail(uid, ccAmt);
      } else {
        if (a.available_cc < ccAmt) throw E.conflict('insufficient_margin', 'insufficient perps collateral', `you have $${(a.available_cc / CC).toFixed(2)} available in Perps`);
        addAvail(uid, -ccAmt);
        engine.credit(uid, cents, 'perps_transfer', id, 'Transfer from Perps');
      }
      const src = dir === 'to_perps' ? 'event_contract' : 'margined';
      const dst = dir === 'to_perps' ? 'margined' : 'event_contract';
      db.prepare('INSERT INTO perp_transfers(id,user_id,source,destination,amount_cc,status,client_transfer_id,created_ts) VALUES(?,?,?,?,?,?,?,?)').run(id, uid, src, dst, ccAmt, 'completed', b.client_transfer_id ?? null, Date.now());
      ledger(uid, 'transfer', dir === 'to_perps' ? ccAmt : -ccAmt, null, id, dir === 'to_perps' ? 'from predictions cash' : 'to predictions cash');
      return db.prepare('SELECT * FROM perp_transfers WHERE id=?').get(id);
    });
    engine.emit('user_balance', uid, engine.balance(uid));
    emitUser(uid, []);
    notify(uid, { type: 'margin_transfer_completed', title: `Transferred $${(cents / 100).toFixed(2)} ${dir === 'to_perps' ? 'to Perps' : 'to Predictions'}`, body: 'Transfer completed', link: dir === 'to_perps' ? '/portfolio?perpsTab=positions' : '/portfolio' });
    res.status(201).json({ transfer_id: t.id, transfer: transferVo(t), balance: balanceVo(uid) });
  });
  v1.get(`${P}/transfers`, requireUser, (req, res) => res.json({ transfers: db.prepare('SELECT * FROM perp_transfers WHERE user_id=? ORDER BY created_ts DESC, rowid DESC LIMIT 200').all(uidOf(req)).map(transferVo) }));

  v1.post(`${P}/orders`, requireUser, (req, res) => {
    const o = placeOrder(uidOf(req), req.body || {}, { source: 'user' });
    const vo = orderVo(o);
    res.status(201).json({ order: vo, order_id: o.id, client_order_id: o.client_order_id, fill_count: vo.fill_count, remaining_count: vo.remaining_count, average_fill_price: vo.average_fill_price, average_fee_paid: o.filled_count ? cc$(o.fees_cc / o.filled_count) : null });
  });
  v1.get(`${P}/orders`, requireUser, (req, res) => {
    const args = [uidOf(req)]; const where = ['user_id=?'];
    if (req.query.status) { where.push('status=?'); args.push(String(req.query.status)); }
    if (req.query.ticker) { where.push('ticker=?'); args.push(String(req.query.ticker).toUpperCase()); }
    const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 100) | 0));
    const cur = decCursor(req.query.cursor);
    const off = cur ? cur.o : 0;
    const rows = db.prepare(`SELECT * FROM perp_orders WHERE ${where.join(' AND ')} ORDER BY created_ts DESC, rowid DESC LIMIT ? OFFSET ?`).all(...args, limit + 1, off);
    res.json({ orders: rows.slice(0, limit).map(orderVo), cursor: rows.length > limit ? encCursor({ o: off + limit }) : '' });
  });
  v1.get(`${P}/orders/:id`, requireUser, (req, res) => {
    const o = db.prepare('SELECT * FROM perp_orders WHERE id=? AND user_id=?').get(req.params.id, uidOf(req));
    if (!o) throw E.notFound();
    res.json({ order: orderVo(o) });
  });
  v1.delete(`${P}/orders/:id`, requireUser, (req, res) => res.json({ order: orderVo(cancelOrder(uidOf(req), req.params.id)) }));

  v1.get(`${P}/positions`, requireUser, (req, res) => {
    const args = [uidOf(req)]; let extra = '';
    if (req.query.ticker) { extra = ' AND ticker=?'; args.push(String(req.query.ticker).toUpperCase()); }
    res.json({ positions: db.prepare(`SELECT * FROM perp_positions WHERE user_id=? AND qty<>0${extra} ORDER BY updated_ts DESC`).all(...args).map((p) => positionVo(p)) });
  });
  v1.post(`${P}/positions/:ticker/close`, requireUser, (req, res) => {
    const uid = uidOf(req);
    const m = mustMarket(req.params.ticker);
    const p = position(uid, m.ticker);
    if (!p || p.qty === 0) throw E.conflict('no_position', 'no open position in this market');
    const pct = req.body && req.body.percent != null ? Number(req.body.percent) : 100;
    if (!(pct > 0 && pct <= 100)) throw E.badRequest('percent must be between 0 and 100');
    const count = Math.max(1, Math.floor((Math.abs(p.qty) * pct) / 100));
    const o = placeOrder(uid, { ticker: m.ticker, side: p.qty > 0 ? 'ask' : 'bid', type: 'market', count, reduce_only: true }, { source: 'user' });
    res.json({ order: orderVo(o) });
  });

  v1.get(`${P}/fills`, requireUser, (req, res) => {
    const args = [uidOf(req)]; let extra = '';
    if (req.query.ticker) { extra = ' AND ticker=?'; args.push(String(req.query.ticker).toUpperCase()); }
    const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 100) | 0));
    res.json({ fills: db.prepare(`SELECT * FROM perp_fills WHERE user_id=?${extra} ORDER BY created_ts DESC, rowid DESC LIMIT ?`).all(...args, limit).map(fillVo), cursor: '' });
  });
  v1.get(`${P}/funding_history`, requireUser, (req, res) => {
    const args = [uidOf(req)]; const where = ['user_id=?'];
    if (req.query.ticker) { where.push('ticker=?'); args.push(String(req.query.ticker).toUpperCase()); }
    if (req.query.start_date) { where.push('funding_ts>=?'); args.push(Date.parse(`${req.query.start_date}T00:00:00Z`)); }
    if (req.query.end_date) { where.push('funding_ts<?'); args.push(Date.parse(`${req.query.end_date}T00:00:00Z`) + DAY); }
    res.json({ funding_history: db.prepare(`SELECT * FROM perp_funding_payments WHERE ${where.join(' AND ')} ORDER BY funding_ts DESC, rowid DESC LIMIT 500`).all(...args).map(fundingPayVo) });
  });
  v1.get(`${P}/liquidations`, requireUser, (req, res) => res.json({ liquidations: db.prepare('SELECT * FROM perp_liquidations WHERE user_id=? ORDER BY created_ts DESC LIMIT 200').all(uidOf(req)).map(liqVo) }));
  v1.get(`${P}/ledger`, requireUser, (req, res) => res.json({ entries: db.prepare('SELECT * FROM perp_ledger WHERE user_id=? ORDER BY created_ts DESC, rowid DESC LIMIT 500').all(uidOf(req)).map((l) => ({ id: l.id, kind: l.kind, amount_dollars: cc$(l.amount_cc), ticker: l.ticker, memo: l.memo, created_time: new Date(l.created_ts).toISOString() })) }));
  v1.get(`${P}/risk`, requireUser, (req, res) => {
    let tn = 0; let tm = 0;
    const positions = db.prepare('SELECT * FROM perp_positions WHERE user_id=? AND qty<>0').all(uidOf(req)).map((p) => {
      const m = getMarket(p.ticker); const mark = markCc(m);
      const notional = Math.abs(p.qty) * mark; const mm = notional * mmRate(m);
      tn += notional; tm += mm;
      const upnl = p.qty * (mark - p.entry_cc);
      return { subaccount: 0, subaccount_type: 'isolated', market_ticker: p.ticker, position: fp(p.qty), mark_price: cc$(mark), position_notional: cc$(notional), maintenance_margin_required: cc$(mm), position_leverage: mm ? Number((notional / mm).toFixed(4)) : null, effective_leverage: p.margin_cc + upnl > 0 ? Number((notional / (p.margin_cc + upnl)).toFixed(4)) : null, margin_ratio: mm ? Number(((p.margin_cc + upnl) / mm).toFixed(4)) : null, estimated_liquidation_price: cc$(liqPriceCc(p.qty, p.entry_cc, p.margin_cc, mmRate(m))), is_portfolio: false };
    });
    res.json({ account_leverage: tm ? Number((tn / tm).toFixed(4)) : null, total_position_notional: cc$(tn), total_maintenance_margin: cc$(tm), positions });
  });

  // Exit triggers (bracket TP/SL on the isolated position; evaluated against the mark every tick).
  v1.get(`${P}/exit_triggers`, requireUser, (req, res) => {
    const args = [uidOf(req)]; let extra = '';
    if (req.query.status) { extra = ' AND status=?'; args.push(String(req.query.status)); }
    res.json({ exit_triggers: db.prepare(`SELECT * FROM perp_exit_triggers WHERE user_id=?${extra} ORDER BY created_ts DESC LIMIT 200`).all(...args).map(triggerVo) });
  });
  v1.put(`${P}/positions/:ticker/exit_trigger`, requireUser, (req, res) => {
    const uid = uidOf(req);
    const m = mustMarket(req.params.ticker);
    const p = position(uid, m.ticker);
    if (!p || p.qty === 0) throw E.conflict('no_position', 'exit triggers require an open position');
    const b = req.body || {};
    if (b.kind && String(b.kind).toLowerCase() !== 'bracket') throw E.badRequest('only bracket (take-profit / stop-loss) triggers are supported');
    const parse = (v, name) => { if (v == null || v === '') return null; const n = Number(v); if (!(n > 0)) throw E.badRequest(`${name} must be strictly positive`); return Math.round(n * CC); };
    const tp = parse(b.take_profit_price, 'take_profit_price');
    const sl = parse(b.stop_loss_price, 'stop_loss_price');
    if (tp == null && sl == null) throw E.badRequest('supply take_profit_price and/or stop_loss_price (use DELETE to cancel)');
    const mark = markCc(m); const long = p.qty > 0;
    if (tp != null && (long ? tp <= mark : tp >= mark)) throw E.badRequest(`take profit must be ${long ? 'above' : 'below'} the mark price (${fmtUnderlying(m, mark)})`);
    if (sl != null && (long ? sl >= mark : sl <= mark)) throw E.badRequest(`stop loss must be ${long ? 'below' : 'above'} the mark price (${fmtUnderlying(m, mark)})`);
    const now = Date.now();
    const t = tx(db, () => {
      db.prepare("UPDATE perp_exit_triggers SET status='canceled', status_reason='user_canceled', updated_ts=? WHERE user_id=? AND ticker=? AND status='active'").run(now, uid, m.ticker);
      const id = newId('xt_');
      db.prepare("INSERT INTO perp_exit_triggers(id,user_id,ticker,kind,status,stop_loss_cc,take_profit_cc,count,created_ts,updated_ts) VALUES(?,?,?,'bracket','active',?,?,?,?,?)").run(id, uid, m.ticker, sl, tp, Number(b.count) > 0 ? Math.floor(Number(b.count)) : 0, now, now);
      return db.prepare('SELECT * FROM perp_exit_triggers WHERE id=?').get(id);
    });
    emitUser(uid, [m.ticker]);
    res.json(triggerVo(t));
  });
  v1.delete(`${P}/positions/:ticker/exit_trigger`, requireUser, (req, res) => {
    const uid = uidOf(req);
    const m = mustMarket(req.params.ticker);
    const t = activeTrigger(uid, m.ticker);
    if (!t) throw E.notFound();
    db.prepare("UPDATE perp_exit_triggers SET status='canceled', status_reason='user_canceled', updated_ts=? WHERE id=?").run(Date.now(), t.id);
    emitUser(uid, [m.ticker]);
    res.json({ exit_trigger: triggerVo(db.prepare('SELECT * FROM perp_exit_triggers WHERE id=?').get(t.id)) });
  });

  // ======================================================== admin (simulation controls)
  v1.post(`${P}/admin/markets/:ticker/index`, requireAdmin, (req, res) => {
    const b = req.body || {};
    res.json({ market: marketVo(setIndex(req.params.ticker, b.price, { freeze: b.freeze })) });
  });
  v1.post(`${P}/admin/markets/:ticker/simulation`, requireAdmin, (req, res) => {
    const m = mustMarket(req.params.ticker);
    db.prepare('UPDATE perp_markets SET sim_frozen=?, sim_ts=? WHERE ticker=?').run(req.body && req.body.frozen ? 1 : 0, Date.now(), m.ticker);
    res.json({ market: marketVo(getMarket(m.ticker)) });
  });
  v1.post(`${P}/admin/markets/:ticker/funding`, requireAdmin, (req, res) => res.json(runFunding(mustMarket(req.params.ticker))));

  const api = { tick, setIndex, runFunding: (t) => runFunding(mustMarket(t)), bookMsg, placeOrder, cancelOrder, balanceVo, markCc: (t) => markCc(mustMarket(t)), market: (t) => getMarket(t) };
  engine.perps = api;
  return api;
}

module.exports = { mountPerps, MARKETS };
