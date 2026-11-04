'use strict';
// Perpetual futures ("Perps") margin product (CLONE_SPEC §14; Phase 6 completion §34).
// Linear perps on simulated, persisted indices. Prices are per contract in centicents ($0.0001 = one tick, the documented
// perps tick); quantities are integer units, a hundredth of a contract (the fixed-point rule of CLONE_SPEC.md §16.1;
// fractional sizes per market, §34.5). A user has subaccounts (0 = primary); each is isolated (margin per position,
// as before) or cross (portfolio maintenance margin across its positions, §34.4). Initial and maintenance margin come
// from size tiers per market (server/perps-risk.js). Every money movement is journaled double-entry in centicents
// (server/perps-ledger.js) and the bridge to the main journal moves with it.
// Everything that matters lives in SQLite: markets + simulation state, price history, orders, order groups, fills,
// trades, positions, subaccounts, collateral, funding rates/payments, liquidations, exit triggers (bracket and
// trailing), transfers, margin tiers, the perps journal and a user-facing perps ledger.
const CS = require('./content/currency-strings'); // keyed user-facing wording (CLONE_SPEC.md §30)
const { s: PS } = require('./content/perps'); // keyed Perps wording (CLONE_SPEC.md §34)
const C = require('./currency'); // display currency formatting (CLONE_SPEC.md §30)
const { tx } = require('./db');
const { nowIso, newId, dollars, ufp, toUnits, E, ApiError, encCursor, decCursor } = require('./util');
const PL = require('./perps-ledger');
const R = require('./perps-risk');
const journal = require('./journal');

const CC = 10000; // centicents per dollar
const UNITS = 100; // units per contract
const cc$ = (cc) => (cc == null || !Number.isFinite(Number(cc)) ? null : dollars(Number(cc) / 100));
const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const MARKET_SLIPPAGE = 0.05;      // market orders = IOC limit at mark ± 5% (design choice)
const BAND_PCT = 0.2;              // price band (margin_price-banding.md): 20% or 1,000 ticks
const BAND_TICKS = 1000;
const LP_LEVELS = 8;
const LP_LEVEL_NOTIONAL_CC = 1500 * CC;
const LP_FLOAT_CC = 1e12;          // the liquidity account's float (journaled against perps:lp_capital)
const FUNDING_INTEREST = 0.0001;   // per funding period (design choice)
const FUNDING_CAP = 0.0075;
const IM_MULTIPLIER = 2;           // initial margin = maintenance margin x 2 (risk_parameters shape)
const MAX_UNITS = 1000000 * UNITS;
const MAX_SUB = 31;                // subaccount numbers 0..31 (the admin limit caps how many exist)
const ASSET_CLASSES = ['Crypto', 'Equities', 'Metals', 'FX', 'Energy', 'Indices', 'Rates', 'Compute', 'GPU', 'EventContracts'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS perp_markets (
  ticker TEXT PRIMARY KEY, market_id TEXT NOT NULL, title TEXT NOT NULL, asset_name TEXT NOT NULL, asset_class TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', index_provider TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL DEFAULT 'usd', decimals INTEGER NOT NULL DEFAULT 2,
  color TEXT NOT NULL DEFAULT '#008751', sort_order INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
  contract_size REAL NOT NULL, max_leverage REAL NOT NULL, im_multiplier REAL NOT NULL DEFAULT 2,
  maker_fee_rate REAL NOT NULL, taker_fee_rate REAL NOT NULL,
  funding_interval_ms INTEGER NOT NULL, funding_schedule TEXT NOT NULL, funding_cap REAL NOT NULL, funding_interest REAL NOT NULL,
  next_funding_ts INTEGER NOT NULL, last_funding_ts INTEGER, premium_sum REAL NOT NULL DEFAULT 0, premium_n INTEGER NOT NULL DEFAULT 0,
  anchor_price REAL NOT NULL, index_price REAL NOT NULL, daily_vol REAL NOT NULL, basis REAL NOT NULL DEFAULT 0,
  sim_state INTEGER NOT NULL, sim_frozen INTEGER NOT NULL DEFAULT 0, sim_ts INTEGER NOT NULL, created_at TEXT NOT NULL,
  fractional_trading_enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS perp_price_history (
  ticker TEXT NOT NULL REFERENCES perp_markets(ticker), ts INTEGER NOT NULL, step_ms INTEGER NOT NULL DEFAULT 60000,
  open_cc INTEGER NOT NULL, high_cc INTEGER NOT NULL, low_cc INTEGER NOT NULL, close_cc INTEGER NOT NULL, PRIMARY KEY (ticker, ts)
);
CREATE TABLE IF NOT EXISTS perp_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, available_cc INTEGER NOT NULL DEFAULT 0,
  last_funding_notice_ts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS perp_subaccounts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, subaccount INTEGER NOT NULL, name TEXT NOT NULL, margin_mode TEXT NOT NULL DEFAULT 'isolated',
  available_cc INTEGER NOT NULL DEFAULT 0, created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL, PRIMARY KEY (user_id, subaccount)
);
CREATE TABLE IF NOT EXISTS perp_orders (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), ticker TEXT NOT NULL REFERENCES perp_markets(ticker),
  side TEXT NOT NULL, type TEXT NOT NULL, price_cc INTEGER NOT NULL, initial_count INTEGER NOT NULL, remaining_count INTEGER NOT NULL,
  filled_count INTEGER NOT NULL DEFAULT 0, fill_cost_cc INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, time_in_force TEXT NOT NULL,
  reduce_only INTEGER NOT NULL DEFAULT 0, post_only INTEGER NOT NULL DEFAULT 0, leverage REAL NOT NULL DEFAULT 1,
  reserved_cc INTEGER NOT NULL DEFAULT 0, fees_cc INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'user',
  client_order_id TEXT, created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL,
  subaccount INTEGER NOT NULL DEFAULT 0, order_group_id TEXT, amended_from TEXT, cancel_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_perp_orders_book ON perp_orders(ticker, status, side, price_cc);
CREATE INDEX IF NOT EXISTS idx_perp_orders_user ON perp_orders(user_id, status, created_ts);
CREATE TABLE IF NOT EXISTS perp_order_groups (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, subaccount INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL,
  contracts_limit INTEGER NOT NULL DEFAULT 0, filled INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, status_reason TEXT,
  created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL, triggered_ts INTEGER
);
CREATE INDEX IF NOT EXISTS idx_perp_groups_user ON perp_order_groups(user_id, status);
CREATE TABLE IF NOT EXISTS perp_trades (
  id TEXT PRIMARY KEY, ticker TEXT NOT NULL, price_cc INTEGER NOT NULL, count INTEGER NOT NULL, taker_side TEXT NOT NULL,
  is_liquidation INTEGER NOT NULL DEFAULT 0, created_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_perp_trades ON perp_trades(ticker, created_ts);
CREATE TABLE IF NOT EXISTS perp_fills (
  id TEXT PRIMARY KEY, trade_id TEXT NOT NULL, order_id TEXT, user_id TEXT NOT NULL, ticker TEXT NOT NULL, side TEXT NOT NULL,
  price_cc INTEGER NOT NULL, count INTEGER NOT NULL, is_taker INTEGER NOT NULL, fee_cc INTEGER NOT NULL, realized_cc INTEGER NOT NULL,
  entry_cc REAL NOT NULL, source TEXT NOT NULL, created_ts INTEGER NOT NULL, subaccount INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_perp_fills_user ON perp_fills(user_id, created_ts);
CREATE TABLE IF NOT EXISTS perp_positions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, subaccount INTEGER NOT NULL DEFAULT 0, ticker TEXT NOT NULL REFERENCES perp_markets(ticker),
  qty INTEGER NOT NULL DEFAULT 0, entry_cc REAL NOT NULL DEFAULT 0, cost_ucc INTEGER NOT NULL DEFAULT 0, margin_cc INTEGER NOT NULL DEFAULT 0, leverage REAL NOT NULL DEFAULT 1,
  fees_cc INTEGER NOT NULL DEFAULT 0, realized_cc INTEGER NOT NULL DEFAULT 0, funding_cc INTEGER NOT NULL DEFAULT 0,
  opened_ts INTEGER, updated_ts INTEGER NOT NULL, PRIMARY KEY (user_id, subaccount, ticker)
);
CREATE TABLE IF NOT EXISTS perp_funding_rates (
  id TEXT PRIMARY KEY, ticker TEXT NOT NULL, funding_ts INTEGER NOT NULL, rate REAL NOT NULL, mark_cc INTEGER NOT NULL, premium REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_perp_funding_rates ON perp_funding_rates(ticker, funding_ts);
CREATE TABLE IF NOT EXISTS perp_funding_payments (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ticker TEXT NOT NULL, funding_ts INTEGER NOT NULL, rate REAL NOT NULL,
  mark_cc INTEGER NOT NULL, qty INTEGER NOT NULL, amount_cc INTEGER NOT NULL, subaccount INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_perp_funding_pay ON perp_funding_payments(user_id, funding_ts);
CREATE TABLE IF NOT EXISTS perp_liquidations (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ticker TEXT NOT NULL, side TEXT NOT NULL, count INTEGER NOT NULL, entry_cc REAL NOT NULL,
  mark_cc INTEGER NOT NULL, liq_price_cc INTEGER, margin_cc INTEGER NOT NULL, realized_cc INTEGER NOT NULL, fee_cc INTEGER NOT NULL,
  returned_cc INTEGER NOT NULL, shortfall_cc INTEGER NOT NULL, created_ts INTEGER NOT NULL, subaccount INTEGER NOT NULL DEFAULT 0, margin_mode TEXT NOT NULL DEFAULT 'isolated'
);
CREATE TABLE IF NOT EXISTS perp_exit_triggers (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ticker TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'bracket', status TEXT NOT NULL,
  status_reason TEXT, stop_loss_cc INTEGER, take_profit_cc INTEGER, triggered_leg TEXT, triggered_order_id TEXT,
  count INTEGER NOT NULL DEFAULT 0, filled_count INTEGER NOT NULL DEFAULT 0, created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL,
  subaccount INTEGER NOT NULL DEFAULT 0, trail_cc INTEGER, trail_bps INTEGER, watermark_cc INTEGER, stop_cc INTEGER, fired_mark_cc INTEGER
);
CREATE INDEX IF NOT EXISTS idx_perp_triggers ON perp_exit_triggers(ticker, status);
CREATE TABLE IF NOT EXISTS perp_transfers (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, source TEXT NOT NULL, destination TEXT NOT NULL,
  amount_cc INTEGER NOT NULL, status TEXT NOT NULL, client_transfer_id TEXT, created_ts INTEGER NOT NULL, from_subaccount INTEGER, to_subaccount INTEGER
);
CREATE TABLE IF NOT EXISTS perp_ledger (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, amount_cc INTEGER NOT NULL, ticker TEXT, ref TEXT, memo TEXT NOT NULL DEFAULT '', created_ts INTEGER NOT NULL,
  subaccount INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_perp_ledger ON perp_ledger(user_id, created_ts);
CREATE TABLE IF NOT EXISTS perp_margin_tiers (
  ticker TEXT NOT NULL REFERENCES perp_markets(ticker), tier INTEGER NOT NULL, max_notional_cc INTEGER NOT NULL, initial_rate REAL NOT NULL, maintenance_rate REAL NOT NULL,
  PRIMARY KEY (ticker, tier)
);
CREATE TABLE IF NOT EXISTS perp_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

// Invented markets on simulated indices (no external feeds). price = underlying level; per-contract price = level x contract_size.
const MARKETS = [
  { ticker: 'PLXBTCPERP', title: 'BTC', asset_name: 'Bitcoin', asset_class: 'Crypto', contract_size: 0.0001, price: 96250, max_leverage: 20, daily_vol: 0.035, color: '#f2a900', description: 'Tracks a simulated Bitcoin reference index. The oldest and most widely held crypto asset, often used as the benchmark for crypto risk appetite.' },
  { ticker: 'PLXETHPERP', title: 'ETH', asset_name: 'Ether', asset_class: 'Crypto', contract_size: 0.001, price: 3420, max_leverage: 15, daily_vol: 0.045, color: '#7b8cde', description: 'Tracks a simulated Ether reference index, the native asset of a large smart-contract network.' },
  { ticker: 'PLXSOLPERP', title: 'SOL', asset_name: 'Solana', asset_class: 'Crypto', contract_size: 0.1, price: 182.4, max_leverage: 10, daily_vol: 0.06, color: '#14b8a6', description: 'Tracks a simulated Solana reference index, a high-throughput layer-1 network token.' },
  { ticker: 'PLXGOLDPERP', title: 'Gold', asset_name: 'Gold (troy ounce)', asset_class: 'Metals', contract_size: 0.001, price: 2634.5, max_leverage: 25, daily_vol: 0.012, color: '#d4a017', interval: DAY, schedule: '0 10 * * *', description: 'Tracks a simulated spot gold index, quoted per troy ounce.' },
  { ticker: 'PLXOILPERP', title: 'Crude Oil', asset_name: 'Light crude (barrel)', asset_class: 'Energy', contract_size: 0.1, price: 71.42, max_leverage: 10, daily_vol: 0.025, color: '#9ca3af', interval: DAY, schedule: '30 14 * * *', description: 'Tracks a simulated light crude oil index, quoted per barrel.' },
  // Whole contracts only (exercises the fractional rejection path, as PLXSTATE does for event contracts, §16.3).
  { ticker: 'PLXUS10YPERP', title: 'US 10Y Yield', asset_name: 'US 10-year Treasury yield', asset_class: 'Rates', contract_size: 1, price: 4.312, unit: 'pct', decimals: 3, max_leverage: 20, daily_vol: 0.02, color: '#3b82f6', interval: DAY, schedule: '0 16 * * *', fractional: false, description: 'Tracks a simulated 10-year Treasury yield, quoted in percent. Long profits when the yield rises.' },
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
const ceilI = (x) => Math.ceil(x - 1e-9);
const signedCost = (p) => (p.qty > 0 ? p.cost_ucc : p.qty < 0 ? -p.cost_ucc : 0);

// One fill against a position, as pure arithmetic (the order placement dry run and applyFill share it).
// st: { q (units), cost (ucc, magnitude), margin (cc), avail (cc) }; n units at p cc per contract.
function fillMath(st, { side, n, p, lev, feeRate, sys, shrink = true }) {
  let { q, cost, margin } = st;
  const s = side === 'bid' ? 1 : -1;
  const closing = q !== 0 && Math.sign(q) !== s ? Math.min(n, Math.abs(q)) : 0;
  const open = n - closing;
  let realizedUcc = 0; let rel = 0; let lockWanted = 0;
  if (closing) {
    const relCost = Math.round((cost * closing) / Math.abs(q));
    realizedUcc = q > 0 ? closing * p - relCost : relCost - closing * p;
    rel = sys ? 0 : Math.round((margin * closing) / Math.abs(q));
    cost -= relCost; margin -= rel; q += s * closing;
    if (q === 0) { rel += margin; margin = 0; cost = 0; }
  }
  if (open) {
    lockWanted = sys ? 0 : ceilI((open * p) / (UNITS * lev));
    cost += open * p; q += s * open;
  }
  const fee = sys ? 0 : ceilI((n * p * feeRate) / UNITS);
  const paid = Math.floor(realizedUcc / UNITS); // the user side is paid whole centicents, rounded down
  const dust = realizedUcc - UNITS * paid;
  let lock = lockWanted;
  let avail = st.avail + rel + paid - fee - lock;
  if (shrink && !sys && avail < 0 && lock > 0) { const cut = Math.min(lock, -avail); lock -= cut; avail += cut; } // a margin lock never overdraws
  margin += lock;
  return { q, cost, margin, avail, closing, open, rel, lock, fee, paid, dust, realizedUcc };
}

function mountPerps({ v1, db, engine, requireUser, requireAdmin, notify = () => {}, options = {} }) {
  db.exec(SCHEMA);
  PL.init(db);
  const fundingOverride = Number(options.fundingIntervalMs || process.env.PERPS_FUNDING_INTERVAL_MS || 0) || 0;
  const lpId = () => db.prepare("SELECT id FROM users WHERE email='liquidity@parlance.local'").get()?.id;
  const hasTable = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const meta = (k, def) => db.prepare('SELECT value FROM perp_meta WHERE key=?').get(k)?.value ?? def;
  const setMeta = (k, v) => db.prepare('INSERT INTO perp_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

  // ---------------------------------------------------------------- schema migrations (idempotent, forward-only)
  (function migrateSchema() {
    const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
    const add = (t, c, def) => { if (!cols(t).has(c)) { db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); return true; } return false; };
    if (add('perp_markets', 'fractional_trading_enabled', 'INTEGER NOT NULL DEFAULT 1')) db.prepare("UPDATE perp_markets SET fractional_trading_enabled=0 WHERE ticker='PLXUS10YPERP'").run();
    for (const c of [['subaccount', 'INTEGER NOT NULL DEFAULT 0'], ['order_group_id', 'TEXT'], ['amended_from', 'TEXT'], ['cancel_reason', 'TEXT']]) add('perp_orders', ...c);
    add('perp_fills', 'subaccount', 'INTEGER NOT NULL DEFAULT 0');
    add('perp_funding_payments', 'subaccount', 'INTEGER NOT NULL DEFAULT 0');
    add('perp_liquidations', 'subaccount', 'INTEGER NOT NULL DEFAULT 0');
    add('perp_liquidations', 'margin_mode', "TEXT NOT NULL DEFAULT 'isolated'");
    for (const c of [['subaccount', 'INTEGER NOT NULL DEFAULT 0'], ['trail_cc', 'INTEGER'], ['trail_bps', 'INTEGER'], ['watermark_cc', 'INTEGER'], ['stop_cc', 'INTEGER'], ['fired_mark_cc', 'INTEGER']]) add('perp_exit_triggers', ...c);
    add('perp_transfers', 'from_subaccount', 'INTEGER');
    add('perp_transfers', 'to_subaccount', 'INTEGER');
    add('perp_ledger', 'subaccount', 'INTEGER NOT NULL DEFAULT 0');
    // Positions gain a subaccount in the key and an integer cost basis: the table is rebuilt once.
    if (!cols('perp_positions').has('subaccount')) {
      tx(db, () => {
        db.exec(`CREATE TABLE perp_positions_v2 (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, subaccount INTEGER NOT NULL DEFAULT 0, ticker TEXT NOT NULL REFERENCES perp_markets(ticker),
          qty INTEGER NOT NULL DEFAULT 0, entry_cc REAL NOT NULL DEFAULT 0, cost_ucc INTEGER NOT NULL DEFAULT 0, margin_cc INTEGER NOT NULL DEFAULT 0, leverage REAL NOT NULL DEFAULT 1,
          fees_cc INTEGER NOT NULL DEFAULT 0, realized_cc INTEGER NOT NULL DEFAULT 0, funding_cc INTEGER NOT NULL DEFAULT 0,
          opened_ts INTEGER, updated_ts INTEGER NOT NULL, PRIMARY KEY (user_id, subaccount, ticker));
          INSERT INTO perp_positions_v2(user_id,subaccount,ticker,qty,entry_cc,cost_ucc,margin_cc,leverage,fees_cc,realized_cc,funding_cc,opened_ts,updated_ts)
            SELECT user_id,0,ticker,qty,entry_cc,0,margin_cc,leverage,fees_cc,realized_cc,funding_cc,opened_ts,updated_ts FROM perp_positions;
          DROP TABLE perp_positions;
          ALTER TABLE perp_positions_v2 RENAME TO perp_positions;`);
      });
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_perp_positions_ticker ON perp_positions(ticker, qty);
      CREATE INDEX IF NOT EXISTS idx_perp_orders_group ON perp_orders(order_group_id, status);`);
    // Quantities become units (hundredths of a contract, CLONE_SPEC.md §16.1): every count column x100, once.
    if (!meta('units_v1')) {
      tx(db, () => {
        if (db.prepare('SELECT 1 FROM perp_markets LIMIT 1').get()) {
          db.exec(`UPDATE perp_orders SET initial_count=initial_count*100, remaining_count=remaining_count*100, filled_count=filled_count*100, fill_cost_cc=fill_cost_cc*100;
            UPDATE perp_trades SET count=count*100; UPDATE perp_fills SET count=count*100; UPDATE perp_positions SET qty=qty*100;
            UPDATE perp_funding_payments SET qty=qty*100; UPDATE perp_liquidations SET count=count*100;
            UPDATE perp_exit_triggers SET count=count*100, filled_count=filled_count*100;`);
          if (hasTable('pm_archive_perps')) db.exec('UPDATE pm_archive_perps SET qty=qty*100');
          if (hasTable('pm_archive_orders')) db.exec("UPDATE pm_archive_orders SET remaining_count=remaining_count*100 WHERE kind='perp_order'");
          db.exec('UPDATE perp_positions SET cost_ucc=CAST(ROUND(ABS(qty)*entry_cc) AS INTEGER) WHERE qty<>0');
        }
        setMeta('units_v1', nowIso());
      });
    }
  })();

  // ---------------------------------------------------------------- seeding (idempotent)
  function seedMarkets() {
    const now = Date.now();
    MARKETS.forEach((d, i) => {
      if (db.prepare('SELECT 1 FROM perp_markets WHERE ticker=?').get(d.ticker)) return;
      const interval = d.interval || 8 * HOUR;
      tx(db, () => {
        db.prepare(`INSERT INTO perp_markets(ticker,market_id,title,asset_name,asset_class,description,index_provider,unit,decimals,color,sort_order,status,contract_size,max_leverage,im_multiplier,maker_fee_rate,taker_fee_rate,funding_interval_ms,funding_schedule,funding_cap,funding_interest,next_funding_ts,premium_sum,premium_n,anchor_price,index_price,daily_vol,basis,sim_state,sim_frozen,sim_ts,created_at,fractional_trading_enabled)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(d.ticker, newId(), d.title, d.asset_name, d.asset_class, d.description, 'Parlance simulated reference index', d.unit || 'usd', d.decimals ?? 2, d.color, i,
            'active', d.contract_size, d.max_leverage, IM_MULTIPLIER, 0.0002, 0.0006, interval, d.schedule || '0 */8 * * *', FUNDING_CAP, FUNDING_INTEREST,
            Math.ceil((now + 1) / interval) * interval, 0, 0, d.price, d.price, d.daily_vol, 0, hash(d.ticker), 0, now, nowIso(), d.fractional === false ? 0 : 1);
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
    // Seeded public tape for the last 24h (no counterparties; shown as market activity). Sizes in units.
    const insT = db.prepare('INSERT INTO perp_trades(id,ticker,price_cc,count,taker_side,is_liquidation,created_ts) VALUES(?,?,?,?,?,0,?)');
    const recent = closes.filter(([ts]) => ts > now - DAY);
    for (let k = 0; k < 96 && recent.length; k += 1) {
      const a = rnd(st); st = a.state; const b = rnd(st); st = b.state;
      const [ts, p] = recent[Math.floor(a.u * recent.length)];
      const size = 1 + Math.floor(b.u * b.u * Math.max(20, 3000 / (d.price * d.contract_size)));
      insT.run(newId('pt_'), d.ticker, toCc(p * (1 + (a.u - 0.5) * 0.0004)), size * UNITS, b.u > 0.5 ? 'bid' : 'ask', ts + Math.floor(a.u * 600000));
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
  // Default size tiers for markets that have none (CLONE_SPEC.md §34.4).
  for (const m of db.prepare('SELECT ticker, max_leverage, im_multiplier FROM perp_markets').all()) {
    if (db.prepare('SELECT 1 FROM perp_margin_tiers WHERE ticker=?').get(m.ticker)) continue;
    const ins = db.prepare('INSERT INTO perp_margin_tiers(ticker,tier,max_notional_cc,initial_rate,maintenance_rate) VALUES(?,?,?,?,?)');
    for (const t of R.defaultTiers(m.max_leverage, m.im_multiplier)) ins.run(m.ticker, t.tier, t.max_notional_cc, t.initial_rate, t.maintenance_rate);
  }
  const LP = lpId();
  function account(uid) {
    const r = db.prepare('INSERT INTO perp_accounts(user_id,available_cc,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO NOTHING').run(uid, uid === LP ? LP_FLOAT_CC : 0, nowIso());
    if (r.changes && uid === LP && meta('journal_v1')) PL.post(db, { kind: 'lp_float', userId: uid, memo: 'liquidity account float' }, [[PL.A.avail(uid, 0), LP_FLOAT_CC], [PL.H.lp, -LP_FLOAT_CC]]);
    return db.prepare('SELECT * FROM perp_accounts WHERE user_id=?').get(uid);
  }
  if (LP) account(LP);
  // Journal opening (once): balances that predate the perps journal are opened against perps:opening, the liquidity
  // float against perps:lp_capital, the bridge from the main journal, and the PnL bucket so that conservation holds.
  if (!meta('journal_v1')) {
    tx(db, () => {
      const P = [];
      for (const r of db.prepare('SELECT user_id, available_cc c FROM perp_accounts WHERE available_cc<>0').all()) P.push([PL.A.avail(r.user_id, 0), r.c, r.user_id === LP ? PL.H.lp : PL.H.opening]);
      for (const r of db.prepare('SELECT user_id, subaccount, available_cc c FROM perp_subaccounts WHERE subaccount>0 AND available_cc<>0').all()) P.push([PL.A.avail(r.user_id, r.subaccount), r.c, PL.H.opening]);
      for (const r of db.prepare('SELECT user_id, subaccount, SUM(reserved_cc) c FROM perp_orders WHERE reserved_cc<>0 GROUP BY user_id, subaccount').all()) P.push([PL.A.reserved(r.user_id, r.subaccount), r.c, PL.H.opening]);
      for (const r of db.prepare('SELECT user_id, subaccount, SUM(margin_cc) c FROM perp_positions WHERE margin_cc<>0 GROUP BY user_id, subaccount').all()) P.push([PL.A.margin(r.user_id, r.subaccount), r.c, PL.H.opening]);
      const bridge = -100 * journal.balanceOf(db, 'perps:collateral');
      const signed = db.prepare('SELECT COALESCE(SUM(CASE WHEN qty>0 THEN cost_ucc WHEN qty<0 THEN -cost_ucc ELSE 0 END),0) s FROM perp_positions').get().s;
      const pnl = -Math.floor(signed / UNITS);
      const postings = [];
      for (const [a, c, contra] of P) { postings.push([a, c]); postings.push([contra, -c]); }
      postings.push([PL.H.bridge, bridge], [PL.H.opening, -bridge], [PL.H.pnl, pnl], [PL.H.opening, -pnl]);
      PL.post(db, { kind: 'opening_balance', memo: 'perps journal opening balances' }, postings);
      setMeta('rounding_ucc', signed - UNITS * Math.floor(signed / UNITS));
      setMeta('journal_v1', nowIso());
    });
  }
  if (fundingOverride > 0) {
    const now = Date.now();
    db.prepare('UPDATE perp_markets SET next_funding_ts=? WHERE next_funding_ts>?').run(now + fundingOverride, now + fundingOverride);
  }
  const intervalOf = (m) => (fundingOverride > 0 ? fundingOverride : m.funding_interval_ms);

  // ---------------------------------------------------------------- settings
  const riskSettings = () => { const r = db.prepare("SELECT value FROM admin_settings WHERE key='perps_risk'").get(); return { ...R.RISK_DEFAULTS, ...(r ? JSON.parse(r.value) : {}) }; };

  // ---------------------------------------------------------------- math helpers
  const getMarket = (t) => db.prepare('SELECT * FROM perp_markets WHERE ticker=?').get(String(t || '').toUpperCase());
  const mustMarket = (t) => { const m = getMarket(t); if (!m) throw E.notFound(); return m; };
  const markCc = (m) => Math.max(1, Math.round(m.index_price * m.contract_size * CC));
  const tierCache = new Map();
  const tiersOf = (t) => {
    if (!tierCache.has(t)) tierCache.set(t, db.prepare('SELECT * FROM perp_margin_tiers WHERE ticker=? ORDER BY tier').all(t));
    return tierCache.get(t);
  };
  const notionalCc = (units, price) => (Math.abs(units) * price) / UNITS;
  const mmOf = (m, units, mark = markCc(m)) => R.mm(tiersOf(m.ticker), notionalCc(units, mark));
  const imOf = (m, units, mark = markCc(m)) => R.im(tiersOf(m.ticker), notionalCc(units, mark));
  const mmRate = (m) => tiersOf(m.ticker)[0].maintenance_rate; // tier 1 (the CLONE_SPEC §14.3 flat rate)
  const imRate = (m) => tiersOf(m.ticker)[0].initial_rate;
  const reserveFor = (m, units, price, lev) => (units > 0 ? ceilI((units * price) / (UNITS * lev)) + ceilI((units * price * m.taker_fee_rate) / UNITS) : 0);
  const upnlCc = (p, mark) => (p.qty * mark - signedCost(p)) / UNITS;
  const entryOf = (p) => (p.qty ? p.cost_ucc / Math.abs(p.qty) : 0);
  const fmtUnderlying = (m, cc) => {
    const v = cc / CC / m.contract_size;
    const s = v.toLocaleString('en-US', { minimumFractionDigits: m.decimals, maximumFractionDigits: m.decimals });
    return m.unit === 'pct' ? `${s}%` : C.assetPrice(v, m.decimals); // ×100 under NGN (CLONE_SPEC.md §30)
  };
  const qtyText = (units) => (Math.abs(units) / UNITS).toLocaleString('en-US', { maximumFractionDigits: 2 });
  function leverageEstimates(m) {
    const out = {};
    for (const n of ['1000', '10000', '100000', '1000000']) out[n] = Number(R.maxLeverageAt(tiersOf(m.ticker), Number(n) * CC).toFixed(4));
    return out;
  }
  const ledger = (uid, sub, kind, cc, ticker, ref, memo) => {
    if (!cc || uid === LP) return;
    db.prepare('INSERT INTO perp_ledger(id,user_id,kind,amount_cc,ticker,ref,memo,created_ts,subaccount) VALUES(?,?,?,?,?,?,?,?,?)').run(newId('pl_'), uid, kind, Math.round(cc), ticker, ref, memo, Date.now(), sub);
  };
  const addDust = (ucc) => { if (ucc) setMeta('rounding_ucc', Number(meta('rounding_ucc', 0)) + ucc); };

  // ---------------------------------------------------------------- subaccounts
  function parseSub(v) {
    if (v == null || v === '') return 0;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > MAX_SUB) throw E.badRequest(PS('error.sub_number', { max: MAX_SUB }));
    return n;
  }
  const subRowRaw = (uid, sub) => db.prepare('SELECT * FROM perp_subaccounts WHERE user_id=? AND subaccount=?').get(uid, sub);
  function subInfo(uid, sub) {
    const r = subRowRaw(uid, sub);
    if (sub === 0) return { subaccount: 0, name: r ? r.name : PS('name.primary'), margin_mode: r ? r.margin_mode : 'isolated', created_ts: r ? r.created_ts : null };
    return r ? { subaccount: r.subaccount, name: r.name, margin_mode: r.margin_mode, created_ts: r.created_ts } : null;
  }
  function mustSub(uid, sub) {
    const s = subInfo(uid, sub);
    if (!s) throw new ApiError(404, 'subaccount_not_found', PS('error.sub_not_found'));
    return s;
  }
  const modeOf = (uid, sub) => (uid === LP ? 'isolated' : subRowRaw(uid, sub)?.margin_mode || 'isolated');
  function availOf(uid, sub) {
    if (sub === 0) return account(uid).available_cc;
    return subRowRaw(uid, sub)?.available_cc ?? 0;
  }
  function addAvail(uid, sub, cc) {
    const v = Math.round(cc);
    if (!v) return;
    if (sub === 0) db.prepare('UPDATE perp_accounts SET available_cc=available_cc+?, updated_at=? WHERE user_id=?').run(v, nowIso(), uid);
    else db.prepare('UPDATE perp_subaccounts SET available_cc=available_cc+?, updated_ts=? WHERE user_id=? AND subaccount=?').run(v, Date.now(), uid, sub);
  }
  const subsOf = (uid) => {
    const rows = db.prepare('SELECT subaccount FROM perp_subaccounts WHERE user_id=? ORDER BY subaccount').all(uid).map((r) => r.subaccount);
    return [...new Set([0, ...rows])];
  };

  // Money postings: J(kind, ref, uid, memo, postings) — the table changes are made by the caller in the same transaction.
  const J = (kind, ref, uid, memo, postings) => PL.post(db, { kind, ref, userId: uid, memo }, postings);
  const reserveMove = (uid, sub, cc, ref) => { // avail → reserved (cc > 0) or back (cc < 0)
    if (!cc || uid === LP) return;
    J(cc > 0 ? 'order_reserve' : 'order_release', ref, uid, cc > 0 ? 'held for order' : 'released from order', [[PL.A.avail(uid, sub), -cc], [PL.A.reserved(uid, sub), cc]]);
  };
  // A negative free balance: cross subaccounts draw on their other positions' margins first; what is left is covered by
  // the insurance fund, then the backstop (journaled). Returns the amount the fund covered.
  function coverDeficit(uid, sub) {
    if (uid === LP) return 0;
    let a = availOf(uid, sub);
    if (a >= 0) return 0;
    if (modeOf(uid, sub) === 'cross') {
      for (const p of db.prepare('SELECT * FROM perp_positions WHERE user_id=? AND subaccount=? AND margin_cc>0 ORDER BY margin_cc DESC').all(uid, sub)) {
        const take = Math.min(p.margin_cc, -a);
        db.prepare('UPDATE perp_positions SET margin_cc=margin_cc-?, updated_ts=? WHERE user_id=? AND subaccount=? AND ticker=?').run(take, Date.now(), uid, sub, p.ticker);
        addAvail(uid, sub, take);
        J('cross_margin_draw', p.ticker, uid, 'portfolio margin covers a loss', [[PL.A.margin(uid, sub), -take], [PL.A.avail(uid, sub), take]]);
        a += take;
        if (a >= 0) return 0;
      }
    }
    const x = -a;
    const ins = Math.max(0, PL.balanceOf(db, PL.H.insurance));
    const fromIns = Math.min(ins, x);
    addAvail(uid, sub, x);
    J('shortfall', null, uid, 'loss beyond collateral covered', [[PL.H.insurance, -fromIns], [PL.H.backstop, -(x - fromIns)], [PL.A.avail(uid, sub), x]]);
    setMeta('insurance_shortfall_cc', Number(meta('insurance_shortfall_cc', 0)) + x); // the §14.3 tally, kept for reports
    return x;
  }

  // ---------------------------------------------------------------- book + quotes
  function best(t, side) {
    return db.prepare(`SELECT price_cc p, SUM(remaining_count) n FROM perp_orders WHERE ticker=? AND status='resting' AND side=? GROUP BY price_cc ORDER BY price_cc ${side === 'bid' ? 'DESC' : 'ASC'} LIMIT 1`).get(t, side) || null;
  }
  function book(t, depth = 0) {
    const lv = (side) => db.prepare(`SELECT price_cc p, SUM(remaining_count) n FROM perp_orders WHERE ticker=? AND status='resting' AND side=? GROUP BY price_cc ORDER BY price_cc ${side === 'bid' ? 'DESC' : 'ASC'}${depth > 0 ? ` LIMIT ${Number(depth)}` : ''}`).all(t, side).map((r) => [cc$(r.p), ufp(r.n)]);
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
      bid_size_fp: ufp(bb ? bb.n : 0), ask_size_fp: ufp(ba ? ba.n : 0),
      last_trade_size_fp: ufp(s.last ? s.last.n : 0),
      volume: ufp(s.v.n), volume_notional_value_dollars: cc$(s.v.d / UNITS),
      volume_24h: ufp(s.v24.n), volume_24h_notional_value_dollars: cc$(s.v24.d / UNITS),
      open_interest: ufp(s.oi), open_interest_notional_value_dollars: cc$((s.oi * mark) / UNITS),
      reference_price: tp(mark), settlement_mark_price: tp(mark), liquidation_mark_price: tp(mark),
      mark_price: cc$(mark),
      index_price: (m.index_price).toFixed(Math.max(m.decimals, 4)),
      previous_price: cc$(s.prev ?? mark),
      price_change_24h_pct: s.prev ? Number((((mark - s.prev) / s.prev) * 100).toFixed(4)) : 0,
      funding_rate: { rate: fundingEstimate(m).rate, next_funding_time_ms: m.next_funding_ts, ts_ms: now },
      ts_ms: now,
    };
  }
  const tierVo = (t) => ({ tier: t.tier, max_notional_dollars: cc$(t.max_notional_cc), initial_margin_rate: t.initial_rate, maintenance_margin_rate: t.maintenance_rate, max_leverage: Number((1 / t.initial_rate).toFixed(4)) });
  function marketVo(m) {
    const t = tickerMsg(m);
    const lev = leverageEstimates(m);
    return {
      market_id: m.market_id, ticker: m.ticker, title: m.title, status: m.status, market_version: 1, exchange_index: 0,
      contract_size: m.contract_size.toFixed(6), underlying_multiplier: '1.000000', tick_size: '0.0001', fractional_trading_enabled: !!m.fractional_trading_enabled, contract_decimals: m.fractional_trading_enabled ? 2 : 0,
      ...t,
      leverage_estimate: lev['1000'], leverage_estimates: lev, long_leverage_estimates: lev, short_leverage_estimates: lev,
      max_leverage: m.max_leverage, initial_margin_rate: Number(imRate(m).toFixed(6)), maintenance_margin_rate: Number(mmRate(m).toFixed(6)),
      margin_tiers: tiersOf(m.ticker).map(tierVo), max_position_notional_dollars: cc$(R.maxNotional(tiersOf(m.ticker))),
      maker_fee_rate: m.maker_fee_rate, taker_fee_rate: m.taker_fee_rate,
      funding_deadband: 0, funding_cap: m.funding_cap * 100, funding_limit_unit: 'percentage', funding_invalid_premium_handling: 'dampen',
      funding_interval_ms: intervalOf(m), next_funding_time: new Date(m.next_funding_ts).toISOString(),
      halt_sources: [], schedule: null, asset_class: m.asset_class,
      product_metadata: { asset_name: m.asset_name, description: m.description, index_provider: m.index_provider, funding_schedule: m.funding_schedule, decimal_count: m.decimals, unit: m.unit, color: m.color, category: m.asset_class },
    };
  }

  // ---------------------------------------------------------------- risk views
  const position = (uid, sub, t) => db.prepare('SELECT * FROM perp_positions WHERE user_id=? AND subaccount=? AND ticker=?').get(uid, sub, t);
  // Portfolio view of one subaccount at the current marks: equity, maintenance and initial requirements.
  function subRisk(uid, sub, { skip = null } = {}) {
    const avail = availOf(uid, sub);
    const reserved = db.prepare("SELECT COALESCE(SUM(reserved_cc),0) c FROM perp_orders WHERE user_id=? AND subaccount=? AND status='resting'").get(uid, sub).c;
    let equity = avail + reserved; let mm = 0; let im = 0; let margin = 0; let upnl = 0;
    const rows = [];
    for (const p of db.prepare('SELECT * FROM perp_positions WHERE user_id=? AND subaccount=? AND qty<>0').all(uid, sub)) {
      if (skip && p.ticker === skip) { equity += p.margin_cc; margin += p.margin_cc; rows.push({ p, skipped: true }); continue; }
      const m = getMarket(p.ticker); const mark = markCc(m);
      const u = upnlCc(p, mark);
      const pm = mmOf(m, p.qty, mark); const pi = imOf(m, p.qty, mark);
      equity += p.margin_cc + u; mm += pm; im += pi; margin += p.margin_cc; upnl += u;
      rows.push({ p, m, mark, upnl: u, mm: pm, im: pi });
    }
    return { avail, reserved, equity, mm, im, margin, upnl, rows };
  }
  // Estimated liquidation mark of a position: isolated → its own margin; cross → the subaccount's equity and the other
  // positions' requirements held at their current marks (CLONE_SPEC.md §34.4).
  function liqPriceOf(p, m = getMarket(p.ticker), mode = modeOf(p.user_id, p.subaccount)) {
    if (!p.qty) return null;
    if (mode !== 'cross' || p.user_id === LP) return R.liqPrice(tiersOf(m.ticker), p.qty, p.margin_cc - signedCost(p) / UNITS, 0);
    const r = subRisk(p.user_id, p.subaccount, { skip: p.ticker });
    const A = r.equity - signedCost(p) / UNITS; // r.equity already holds this position's margin (skipped: margin only)
    return R.liqPrice(tiersOf(m.ticker), p.qty, A, r.mm);
  }

  // ---------------------------------------------------------------- VOs
  const activeTrigger = (uid, sub, t, kind = 'bracket') => db.prepare("SELECT * FROM perp_exit_triggers WHERE user_id=? AND subaccount=? AND ticker=? AND kind=? AND status='active' ORDER BY created_ts DESC LIMIT 1").get(uid, sub, t, kind);
  const triggerVo = (x) => x && ({
    id: x.id, ticker: x.ticker, subaccount: x.subaccount, kind: x.kind, status: x.status, status_reason: x.status_reason, triggered_leg: x.triggered_leg, triggered_order_id: x.triggered_order_id,
    stop_loss_price: cc$(x.stop_loss_cc), take_profit_price: cc$(x.take_profit_cc), count: ufp(x.count), filled_count: ufp(x.filled_count),
    trail_percent: x.trail_bps != null ? x.trail_bps / 100 : null, trail_amount: cc$(x.trail_cc), watermark_price: cc$(x.watermark_cc), stop_price: cc$(x.stop_cc), fired_mark_price: cc$(x.fired_mark_cc),
    created_time: new Date(x.created_ts).toISOString(), updated_time: new Date(x.updated_ts).toISOString(),
  });
  function positionVo(p, m = getMarket(p.ticker)) {
    const mark = markCc(m);
    const q = p.qty;
    const upnl = upnlCc(p, mark);
    const notional = notionalCc(q, mark);
    const mode = modeOf(p.user_id, p.subaccount);
    const mm = mmOf(m, q, mark);
    const entry = entryOf(p);
    const liq = liqPriceOf(p, m, mode);
    const tiers = tiersOf(m.ticker);
    return {
      market_ticker: p.ticker, title: m.title, subaccount: p.subaccount, subaccount_type: mode, margin_mode: mode, is_portfolio: mode === 'cross',
      side: q > 0 ? 'long' : q < 0 ? 'short' : 'flat', position: ufp(q), position_fp: ufp(q), contract_size: m.contract_size.toFixed(6),
      entry_price: cc$(entry), mark_price: cc$(mark), unrealized_pnl: cc$(upnl),
      margin_used: cc$(p.margin_cc), position_value: cc$(p.margin_cc + upnl), position_notional: cc$(notional), total_size: cc$(p.cost_ucc / UNITS),
      leverage: p.margin_cc > 0 ? Number((p.cost_ucc / UNITS / p.margin_cc).toFixed(2)) : null,
      maintenance_margin_required: cc$(mm), maintenance_margin_rate: notional ? Number((mm / notional).toFixed(6)) : Number(mmRate(m).toFixed(6)),
      initial_margin_required: cc$(imOf(m, q, mark)), margin_tier: R.tierOf(tiers, notional), max_leverage_at_size: Number(R.maxLeverageAt(tiers, notional).toFixed(2)),
      estimated_liquidation_price: cc$(liq),
      roe: p.margin_cc > 0 ? Number(((upnl / p.margin_cc) * 100).toFixed(4)) : null,
      fees: cc$(p.fees_cc), realized_pnl: cc$(p.realized_cc), funding_paid: cc$(p.funding_cc),
      opened_time: p.opened_ts ? new Date(p.opened_ts).toISOString() : null, updated_time: new Date(p.updated_ts).toISOString(),
      exit_trigger: triggerVo(activeTrigger(p.user_id, p.subaccount, p.ticker, 'bracket')) || null,
      trailing_stop: triggerVo(activeTrigger(p.user_id, p.subaccount, p.ticker, 'trailing')) || null,
    };
  }
  const TIFS = { gtc: 'good_till_canceled', ioc: 'immediate_or_cancel', fok: 'fill_or_kill' };
  const orderVo = (o) => ({
    order_id: o.id, client_order_id: o.client_order_id, ticker: o.ticker, subaccount: o.subaccount, side: o.side, action: o.side === 'bid' ? 'buy' : 'sell',
    direction: o.side === 'bid' ? 'long' : 'short', type: o.type, price: cc$(o.price_cc), count: ufp(o.initial_count), fill_count: ufp(o.filled_count),
    remaining_count: ufp(o.remaining_count), status: o.status, time_in_force: TIFS[o.time_in_force],
    reduce_only: !!o.reduce_only, post_only: !!o.post_only, leverage: o.leverage, reserved_margin: cc$(o.reserved_cc), fees: cc$(o.fees_cc),
    average_fill_price: o.filled_count ? cc$(o.fill_cost_cc / o.filled_count) : null, order_source: o.source === 'user' ? 'user' : 'system', source_detail: o.source,
    order_group_id: o.order_group_id || null, amended_from: o.amended_from || null, cancel_reason: o.cancel_reason || null,
    created_time: new Date(o.created_ts).toISOString(), last_update_time: new Date(o.updated_ts).toISOString(), created_ts_ms: o.created_ts, last_updated_ts_ms: o.updated_ts,
  });
  const fillVo = (f) => ({
    fill_id: f.id, order_id: f.order_id, trade_id: f.trade_id, ticker: f.ticker, subaccount: f.subaccount, side: f.side, count: ufp(f.count), price: cc$(f.price_cc),
    entry_price: cc$(f.entry_cc), realized_pnl: cc$(f.realized_cc), fees: cc$(f.fee_cc), is_taker: !!f.is_taker,
    order_source: f.source === 'user' ? 'user' : 'system', source_detail: f.source, created_time: new Date(f.created_ts).toISOString(), ts_ms: f.created_ts,
  });
  const tradeVo = (tr) => ({ trade_id: tr.id, ticker: tr.ticker, market_ticker: tr.ticker, price: cc$(tr.price_cc), count: ufp(tr.count), count_fp: ufp(tr.count), taker_side: tr.taker_side, is_liquidation: !!tr.is_liquidation, created_time: new Date(tr.created_ts).toISOString(), ts_ms: tr.created_ts });
  const transferVo = (x) => ({ transfer_id: x.id, source: x.source, destination: x.destination, from_subaccount: x.from_subaccount, to_subaccount: x.to_subaccount, amount: x.amount_cc, amount_dollars: cc$(x.amount_cc), status: x.status, client_transfer_id: x.client_transfer_id, created_time: new Date(x.created_ts).toISOString() });
  const liqVo = (l) => ({ id: l.id, ticker: l.ticker, subaccount: l.subaccount, margin_mode: l.margin_mode, side: l.side, count: ufp(l.count), entry_price: cc$(l.entry_cc), mark_price: cc$(l.mark_cc), liquidation_price: cc$(l.liq_price_cc), margin: cc$(l.margin_cc), realized_pnl: cc$(l.realized_cc), liquidation_fee: cc$(l.fee_cc), returned: cc$(l.returned_cc), shortfall: cc$(l.shortfall_cc), created_time: new Date(l.created_ts).toISOString() });
  const fundingPayVo = (x) => ({ id: x.id, market_ticker: x.ticker, funding_time: new Date(x.funding_ts).toISOString(), funding_rate: x.rate, mark_price: cc$(x.mark_cc), funding_amount: cc$(x.amount_cc), quantity: ufp(x.qty), subaccount_number: x.subaccount, subaccount_type: modeOf(x.user_id, x.subaccount) });
  const groupVo = (g) => {
    const open = db.prepare("SELECT COUNT(*) c FROM perp_orders WHERE order_group_id=? AND status='resting'").get(g.id).c;
    return { order_group_id: g.id, subaccount: g.subaccount, kind: g.kind, contracts_limit: ufp(g.contracts_limit), contracts_limit_fp: ufp(g.contracts_limit), filled_count: ufp(g.filled), status: g.status, status_reason: g.status_reason, is_auto_cancel_enabled: g.status === 'active', open_orders: open, created_time: new Date(g.created_ts).toISOString(), triggered_time: g.triggered_ts ? new Date(g.triggered_ts).toISOString() : null };
  };

  function subBalance(uid, sub) {
    const info = subInfo(uid, sub) || { subaccount: sub, name: '', margin_mode: 'isolated' };
    const r = subRisk(uid, sub);
    const posValue = r.margin + r.upnl;
    return {
      subaccount: sub, name: info.name, subaccount_type: info.margin_mode, margin_mode: info.margin_mode, position_value: cc$(posValue), account_equity: cc$(r.equity),
      maintenance_margin: cc$(r.mm), initial_margin: cc$(r.im), resting_orders_margin: cc$(r.reserved), available_balance: cc$(r.avail), margin_in_use: cc$(r.margin), unrealized_pnl: cc$(r.upnl),
      margin_ratio: r.mm ? Number((r.equity / r.mm).toFixed(4)) : null,
      _r: r,
    };
  }
  function balanceVo(uid, sub = 0) {
    account(uid);
    const subs = subsOf(uid).map((n) => subBalance(uid, n));
    const cur = subs.find((x) => x.subaccount === sub) || subBalance(uid, sub);
    const sum = (k) => subs.reduce((a, x) => a + x._r[k], 0);
    const cents = db.prepare('SELECT balance_cents FROM users WHERE id=?').get(uid)?.balance_cents ?? 0;
    const r = cur._r;
    const strip = (x) => { const { _r, ...rest } = x; void _r; return rest; };
    return {
      subaccount: sub, subaccount_balances: subs.map(strip),
      settled_funds: cc$(r.avail + r.reserved + r.margin),
      available_dollars: cc$(r.avail), account_equity: cc$(r.equity), position_value: cc$(r.margin + r.upnl), margin_in_use: cc$(r.margin),
      unrealized_pnl: cc$(r.upnl), resting_orders_margin: cc$(r.reserved), maintenance_margin: cc$(r.mm), initial_margin: cc$(r.im), margin_mode: cur.margin_mode,
      totals: { available_dollars: cc$(sum('avail')), account_equity: cc$(sum('equity')), margin_in_use: cc$(sum('margin')), unrealized_pnl: cc$(sum('upnl')), maintenance_margin: cc$(sum('mm')) },
      predictions_cash_dollars: dollars(cents),
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
      for (const p of db.prepare('SELECT * FROM perp_positions WHERE user_id=? AND ticker=?').all(uid, t)) engine.emit('perp_position', uid, positionVo(p));
    }
  }
  const emitEvent = (uid, type, msg) => { if (uid && uid !== LP) engine.emit('perp_event', uid, type, msg); };

  // ---------------------------------------------------------------- fills
  // Apply one fill to a user's position in a subaccount. Returns { realized (cc paid), fee, fillId }.
  function applyFill(uid, sub, m, { order, side, n, p, isTaker, feeRate, tradeId, ts, lev, source, cover = true }) {
    const sys = uid === LP;
    account(uid);
    db.prepare('INSERT INTO perp_positions(user_id,subaccount,ticker,updated_ts) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(uid, sub, m.ticker, ts);
    const pos = position(uid, sub, m.ticker);
    const entryBefore = entryOf(pos);
    const f = fillMath({ q: pos.qty, cost: pos.cost_ucc, margin: pos.margin_cc, avail: sys ? 0 : availOf(uid, sub) }, { side, n, p, lev, feeRate, sys });
    let leverage = pos.leverage;
    if (f.open && pos.qty === 0) leverage = lev;
    if (f.q !== 0 && !sys && f.margin > 0) leverage = Number((f.cost / UNITS / f.margin).toFixed(2));
    const entry = f.q ? f.cost / Math.abs(f.q) : 0;
    db.prepare('UPDATE perp_positions SET qty=?, entry_cc=?, cost_ucc=?, margin_cc=?, leverage=?, fees_cc=CASE WHEN ?=0 THEN 0 ELSE fees_cc+? END, realized_cc=realized_cc+?, funding_cc=CASE WHEN ?=0 THEN 0 ELSE funding_cc END, opened_ts=CASE WHEN ?=0 THEN NULL WHEN opened_ts IS NULL THEN ? ELSE opened_ts END, updated_ts=? WHERE user_id=? AND subaccount=? AND ticker=?')
      .run(f.q, entry, f.cost, f.margin, leverage, f.q, f.fee, f.paid, f.q, f.q, ts, ts, uid, sub, m.ticker);
    const availDelta = f.rel + f.paid - f.fee - f.lock;
    addAvail(uid, sub, availDelta);
    J('fill', tradeId, uid, `${source} fill`, [[PL.A.avail(uid, sub), availDelta], [PL.A.margin(uid, sub), f.lock - f.rel], [PL.H.fees, f.fee], [PL.H.pnl, -f.paid]]);
    addDust(f.dust);
    const fillId = newId('pf_');
    db.prepare('INSERT INTO perp_fills(id,trade_id,order_id,user_id,ticker,side,price_cc,count,is_taker,fee_cc,realized_cc,entry_cc,source,created_ts,subaccount) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(fillId, tradeId, order ? order.id : null, uid, m.ticker, side, p, n, isTaker ? 1 : 0, f.fee, f.paid, entryBefore, source, ts, sub);
    ledger(uid, sub, 'realized_pnl', f.paid, m.ticker, tradeId, `${qtyText(f.closing)} contracts closed`);
    ledger(uid, sub, 'fee', -f.fee, m.ticker, tradeId, isTaker ? 'taker fee' : 'maker fee');
    if (f.q === 0 && pos.qty !== 0) {
      db.prepare("UPDATE perp_exit_triggers SET status='canceled', status_reason='position_closed', updated_ts=? WHERE user_id=? AND subaccount=? AND ticker=? AND status='active'").run(ts, uid, sub, m.ticker);
    } else if (pos.qty !== 0 && Math.sign(f.q) !== Math.sign(pos.qty)) {
      db.prepare("UPDATE perp_exit_triggers SET status='canceled', status_reason='position_flipped', updated_ts=? WHERE user_id=? AND subaccount=? AND ticker=? AND status='active'").run(ts, uid, sub, m.ticker);
    }
    if (!sys && cover && availOf(uid, sub) < 0) coverDeficit(uid, sub);
    return { realized: f.paid, fee: f.fee, fillId };
  }

  // ---------------------------------------------------------------- order groups
  const groupRow = (id) => (id ? db.prepare('SELECT * FROM perp_order_groups WHERE id=?').get(String(id)) : null);
  // Cancels a resting order inside the caller's transaction: its reservation goes back (journaled).
  function cancelInTx(o, reason, ts = Date.now()) {
    db.prepare("UPDATE perp_orders SET status='canceled', reserved_cc=0, cancel_reason=?, updated_ts=? WHERE id=? AND status='resting'").run(reason, ts, o.id);
    if (o.reserved_cc && o.user_id !== LP) { addAvail(o.user_id, o.subaccount, o.reserved_cc); reserveMove(o.user_id, o.subaccount, -o.reserved_cc, o.id); }
    return db.prepare('SELECT * FROM perp_orders WHERE id=?').get(o.id);
  }
  // After fills: count the fills of each group and trigger it (limit reached, or OCO filled) by canceling its other orders.
  function settleGroups(groupFills, filledOrders, ts) {
    const canceled = []; const triggered = [];
    for (const [gid, units] of groupFills) {
      db.prepare('UPDATE perp_order_groups SET filled=filled+?, updated_ts=? WHERE id=?').run(units, ts, gid);
      const g = groupRow(gid);
      if (g.status !== 'active') continue;
      const hit = g.kind === 'oco' ? g.filled > 0 : g.filled >= g.contracts_limit;
      if (!hit) continue;
      for (const o of db.prepare("SELECT * FROM perp_orders WHERE order_group_id=? AND status='resting'").all(gid)) {
        if (g.kind === 'oco' && filledOrders.has(o.id)) continue; // OCO: the order that filled keeps its remainder
        canceled.push(cancelInTx(o, g.kind === 'oco' ? 'order_group_oco' : 'order_group_limit', ts));
      }
      db.prepare("UPDATE perp_order_groups SET status='triggered', status_reason=?, triggered_ts=?, updated_ts=? WHERE id=?").run(g.kind === 'oco' ? 'one_filled' : 'limit_reached', ts, ts, gid);
      triggered.push(groupRow(gid));
    }
    return { canceled, triggered };
  }

  // ---------------------------------------------------------------- orders
  const TIF = { gtc: 'gtc', good_till_canceled: 'gtc', ioc: 'ioc', immediate_or_cancel: 'ioc', fok: 'fok', fill_or_kill: 'fok' };
  function normSide(v) {
    const s = String(v || '').toLowerCase();
    if (['bid', 'buy', 'long'].includes(s)) return 'bid';
    if (['ask', 'sell', 'short'].includes(s)) return 'ask';
    throw E.badRequest('side must be bid (long) or ask (short)');
  }
  // Contract count → units (fixed-point rules of CLONE_SPEC.md §16.4). `field` names the body keys (count / count_fp).
  function parseUnits(b, field = 'count', { required = true } = {}) {
    const raw = b[`${field}_fp`] != null && b[`${field}_fp`] !== '' ? b[`${field}_fp`] : b[field];
    if (raw == null || raw === '') { if (required) throw E.badRequest(PS('error.count_required')); return null; }
    const u = toUnits(raw);
    if (u == null) throw E.badRequest(PS('error.count_format'));
    if (b[`${field}_fp`] != null && b[field] != null && toUnits(b[field]) !== u) throw E.badRequest(PS('error.count_mismatch'));
    if (u < 1) throw E.badRequest(PS('error.count_min'));
    if (u > MAX_UNITS) throw E.badRequest(PS('error.count_max', { max: (MAX_UNITS / UNITS).toLocaleString('en-US') }));
    return u;
  }
  const fractionalErr = () => new ApiError(400, 'fractional_not_enabled', PS('error.fractional'), PS('error.fractional_details'));
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
  // opts: source, skipBand, units (a count already in units), fractional (false: the caller's flag says whole contracts only).
  function placeCore(uid, body, { source = 'user', skipBand = false, units = null, fractional = true } = {}) {
    const sys = uid === LP;
    const m = mustMarket(body.ticker);
    if (m.status !== 'active') throw E.conflict('market_inactive', 'market is not open for trading', `market status is ${m.status}`);
    if (!engine.tradingActive) throw E.conflict('trading_paused', 'trading is paused');
    const side = normSide(body.side ?? body.direction ?? body.action);
    const s = side === 'bid' ? 1 : -1;
    const type = body.type || 'limit';
    if (!['limit', 'market'].includes(type)) throw E.badRequest('type must be limit or market');
    const sub = sys ? 0 : parseSub(body.subaccount);
    if (!sys && sub) mustSub(uid, sub);
    let count = units != null ? units : parseUnits(body);
    // Order groups (CLONE_SPEC.md §34.2): the caller's active group in the same subaccount; a limit group caps the count.
    let group = null;
    if (!sys && body.order_group_id) {
      group = groupRow(body.order_group_id);
      if (!group || group.user_id !== uid) throw new ApiError(404, 'order_group_not_found', PS('error.group_not_found'));
      if (group.status !== 'active') throw E.conflict('order_group_inactive', PS('error.group_inactive', { status: group.status }));
      if (group.subaccount !== sub) throw E.conflict('order_group_subaccount', PS('error.group_subaccount', { sub: group.subaccount }));
      if (group.kind === 'limit') count = Math.min(count, group.contracts_limit - group.filled);
    }
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
      if (Math.abs(n * CC - price) > 1e-6) throw E.badRequest(CS.t('error.perps_tick', { tick: C.moneyCents(0.01, { exact: 4 }) }));
    }
    let lev = Number(body.leverage ?? 1);
    if (!Number.isFinite(lev) || lev < 1 || lev > m.max_leverage) throw E.badRequest(PS('error.leverage_range', { max: m.max_leverage, market: m.title }));
    const pos = position(uid, sub, m.ticker) || { qty: 0, leverage: 1, cost_ucc: 0, margin_cc: 0 };
    if (reduceOnly) {
      if (tif === 'gtc') throw E.badRequest('reduce-only orders must be immediate_or_cancel or fill_or_kill');
      if (pos.qty === 0 || Math.sign(pos.qty) === s) throw E.conflict('reduce_only_no_position', 'reduce-only order would not reduce a position');
      count = Math.min(count, Math.abs(pos.qty));
      lev = pos.leverage || 1;
    }
    // Whole contracts on a whole-contract market (or with the fractional flag off); a held fractional position can always
    // be closed in full (the §16.4 selling rule).
    if (!sys && count % UNITS && (!m.fractional_trading_enabled || !fractional) && !(reduceOnly && Math.abs(pos.qty) % UNITS)) throw fractionalErr();
    if (!sys && !skipBand) bandCheck(m, side, price);
    const risk = riskSettings();
    // Open-order limits (risk limits, §34.4): only orders that can rest count.
    if (!sys && tif === 'gtc') {
      const perMkt = db.prepare("SELECT COUNT(*) c FROM perp_orders WHERE user_id=? AND ticker=? AND status='resting'").get(uid, m.ticker).c;
      if (perMkt >= risk.max_open_orders_per_market) throw E.conflict('open_order_limit', PS('error.open_orders_market'), PS('error.open_orders_details', { limit: risk.max_open_orders_per_market }));
      const total = db.prepare("SELECT COUNT(*) c FROM perp_orders WHERE user_id=? AND status='resting'").get(uid).c;
      if (total >= risk.max_open_orders_total) throw E.conflict('open_order_limit', PS('error.open_orders_total'), PS('error.open_orders_details', { limit: risk.max_open_orders_total }));
      if (group && db.prepare("SELECT COUNT(*) c FROM perp_orders WHERE order_group_id=? AND status='resting'").get(group.id).c >= risk.max_orders_per_group) throw E.conflict('open_order_limit', PS('error.group_orders', { limit: risk.max_orders_per_group }));
    }

    // Plan the match (price-time priority; self-trade prevention = taker_at_cross across all of the user's subaccounts;
    // makers in a triggered group or at their group's limit are skipped and canceled).
    const makers = db.prepare(side === 'bid'
      ? "SELECT * FROM perp_orders WHERE ticker=? AND status='resting' AND side='ask' AND price_cc<=? ORDER BY price_cc ASC, rowid ASC"
      : "SELECT * FROM perp_orders WHERE ticker=? AND status='resting' AND side='bid' AND price_cc>=? ORDER BY price_cc DESC, rowid ASC").all(m.ticker, price);
    const plan = []; const stale = [];
    const capLeft = new Map(); const ocoTaken = new Set();
    let rem = count;
    let stpHit = false;
    for (const mk of makers) {
      if (rem === 0) break;
      if (mk.user_id === uid) { stpHit = true; break; }
      let n = Math.min(rem, mk.remaining_count);
      if (mk.order_group_id) {
        const g = groupRow(mk.order_group_id);
        if (!g || g.status !== 'active' || (g.kind === 'oco' && ocoTaken.has(g.id))) { stale.push(mk); continue; }
        if (g.kind === 'limit') {
          const left = capLeft.has(g.id) ? capLeft.get(g.id) : g.contracts_limit - g.filled;
          if (left <= 0) { stale.push(mk); continue; }
          n = Math.min(n, left);
          capLeft.set(g.id, left - n);
        } else ocoTaken.add(g.id);
      }
      plan.push({ mk, n, p: mk.price_cc });
      rem -= n;
    }
    if (postOnly && plan.length) throw E.conflict('post_only_cross', 'post-only order would cross the book');
    if (tif === 'fok' && rem > 0) throw E.conflict('fill_or_kill_unfilled', 'fill-or-kill order could not be filled in full');
    const willRest = tif === 'gtc' && rem > 0 && !stpHit;
    let reserve = 0;
    if (!sys) {
      // Dry run of the planned fills against the subaccount's free collateral (fees at the taker rate).
      const a0 = availOf(uid, sub);
      let st = { q: pos.qty, cost: pos.cost_ucc || 0, margin: pos.margin_cc || 0, avail: a0 };
      for (const { n, p } of plan) st = fillMath(st, { side, n, p, lev, feeRate: m.taker_fee_rate, sys: false, shrink: false });
      if (willRest) { reserve = reserveFor(m, rem, price, lev); st = { ...st, avail: st.avail - reserve }; }
      if (st.avail < 0) {
        const need = a0 - st.avail;
        throw E.conflict('insufficient_margin', 'insufficient perps collateral', CS.t('error.perps_margin', { need: C.moneyCents(Math.max(0, need) / 100), available: C.moneyCents(a0 / 100) }));
      }
      // Risk limits on the worst case: this order's fills and remainder plus the subaccount's other same-side resting orders.
      if (!reduceOnly) {
        const restingSame = db.prepare("SELECT COALESCE(SUM(remaining_count),0) n FROM perp_orders WHERE user_id=? AND subaccount=? AND ticker=? AND status='resting' AND side=?").get(uid, sub, m.ticker, side).n;
        const worst = st.q + s * ((willRest ? rem : 0) + restingSame);
        if (Math.abs(worst) > Math.abs(pos.qty)) {
          const tiers = tiersOf(m.ticker);
          const N = notionalCc(worst, mark);
          const cap = R.maxNotional(tiers);
          if (N > cap) throw E.conflict('position_limit', PS('error.position_limit', { market: m.title }), PS('error.position_limit_details', { max: C.moneyCents(cap / 100), size: C.moneyCents(N / 100) }));
          const maxLev = R.maxLeverageAt(tiers, N);
          if (lev > maxLev + 1e-9) throw new ApiError(400, 'leverage_exceeds_tier', PS('error.leverage_tier'), PS('error.leverage_tier_details', { size: C.moneyCents(N / 100), max: Math.floor(maxLev * 100) / 100 }));
          // Portfolio (cross) subaccounts: equity after the order must cover the initial margin of every position.
          if (modeOf(uid, sub) === 'cross') {
            // r.equity = free + reserved + the other positions' margin and PnL + this position's margin (skipped).
            const r = subRisk(uid, sub, { skip: m.ticker });
            const imOther = r.rows.filter((x) => !x.skipped).reduce((a, x) => a + x.im, 0);
            const signedAfter = st.q > 0 ? st.cost : st.q < 0 ? -st.cost : 0;
            const equityAfter = r.equity - a0 - (pos.margin_cc || 0) + st.avail + reserve + st.margin + (st.q * mark - signedAfter) / UNITS;
            const imAfter = imOther + imOf(m, worst, mark);
            if (equityAfter < imAfter) throw E.conflict('insufficient_margin', PS('error.portfolio_margin'), PS('error.portfolio_margin_details', { equity: C.moneyCents(Math.max(0, equityAfter) / 100), required: C.moneyCents(imAfter / 100) }));
          }
        }
      }
    }

    const ts = Date.now();
    const id = newId('po_');
    db.prepare('INSERT INTO perp_orders(id,user_id,ticker,side,type,price_cc,initial_count,remaining_count,status,time_in_force,reduce_only,post_only,leverage,source,client_order_id,created_ts,updated_ts,subaccount,order_group_id,amended_from) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, uid, m.ticker, side, type, price, count, count, 'resting', tif, reduceOnly ? 1 : 0, postOnly ? 1 : 0, lev, source, body.client_order_id ?? null, ts, ts, sub, group ? group.id : null, body.amended_from ?? null);
    const order = { id };
    const trades = [];
    const touched = new Map([[uid, new Set([m.ticker])]]);
    const makerOrders = [];
    const groupFills = new Map(); const filledOrders = new Set();
    const addGroupFill = (gid, oid, n) => { if (!gid) return; groupFills.set(gid, (groupFills.get(gid) || 0) + n); filledOrders.add(oid); };
    const canceledOrders = stale.map((mk) => cancelInTx(mk, 'order_group_triggered', ts));
    for (const { mk, n, p } of plan) {
      const tradeId = newId('pt_');
      db.prepare('INSERT INTO perp_trades(id,ticker,price_cc,count,taker_side,is_liquidation,created_ts) VALUES(?,?,?,?,?,0,?)').run(tradeId, m.ticker, p, n, side, ts);
      trades.push({ id: tradeId, ticker: m.ticker, price_cc: p, count: n, taker_side: side, is_liquidation: 0, created_ts: ts, maker: mk.user_id, taker: uid });
      // maker: release its reservation share, then book the fill
      const left = mk.remaining_count - n;
      const share = left === 0 ? mk.reserved_cc : mk.remaining_count ? Math.round((mk.reserved_cc * n) / mk.remaining_count) : 0;
      if (share && mk.user_id !== LP) { addAvail(mk.user_id, mk.subaccount, share); reserveMove(mk.user_id, mk.subaccount, -share, mk.id); }
      const mkFill = applyFill(mk.user_id, mk.subaccount, m, { order: mk, side: mk.side, n, p, isTaker: false, feeRate: m.maker_fee_rate, tradeId, ts, lev: mk.leverage, source: mk.source });
      db.prepare('UPDATE perp_orders SET remaining_count=?, filled_count=filled_count+?, fill_cost_cc=fill_cost_cc+?, reserved_cc=reserved_cc-?, fees_cc=fees_cc+?, status=?, updated_ts=? WHERE id=?')
        .run(left, n, n * p, share, mkFill.fee, left === 0 ? 'executed' : 'resting', ts, mk.id);
      mk.remaining_count = left; mk.reserved_cc -= share;
      makerOrders.push(mk.id);
      addGroupFill(mk.order_group_id, mk.id, n);
      if (!touched.has(mk.user_id)) touched.set(mk.user_id, new Set());
      touched.get(mk.user_id).add(m.ticker);
      const tk = applyFill(uid, sub, m, { order, side, n, p, isTaker: true, feeRate: m.taker_fee_rate, tradeId, ts, lev, source });
      db.prepare('UPDATE perp_orders SET remaining_count=remaining_count-?, filled_count=filled_count+?, fill_cost_cc=fill_cost_cc+?, fees_cc=fees_cc+?, updated_ts=? WHERE id=?').run(n, n, n * p, tk.fee, ts, id);
      if (group) addGroupFill(group.id, id, n);
    }
    if (rem === 0) db.prepare("UPDATE perp_orders SET status='executed' WHERE id=?").run(id);
    else if (willRest) {
      const a = sys ? Infinity : availOf(uid, sub);
      const r = Math.min(reserve, Math.max(0, a)); // never more than is free (a fill may have shrunk it by rounding)
      db.prepare('UPDATE perp_orders SET reserved_cc=? WHERE id=?').run(r, id);
      if (!sys && r) { addAvail(uid, sub, -r); reserveMove(uid, sub, r, id); }
    } else db.prepare("UPDATE perp_orders SET status='canceled', cancel_reason=? WHERE id=?").run(stpHit ? 'self_trade_prevented' : 'unfilled', id);
    const g = settleGroups(groupFills, filledOrders, ts);
    canceledOrders.push(...g.canceled);
    return { m, order: db.prepare('SELECT * FROM perp_orders WHERE id=?').get(id), trades, touched, makerOrders, canceledOrders, triggeredGroups: g.triggered };
  }

  const fillHooks = []; // (uid, notional_cc, { ticker, source }) — Perps referrals (server/perps-ops.js)
  function publishPlacement(res, { quiet = false } = {}) {
    const { m, order, trades, touched, makerOrders, canceledOrders = [], triggeredGroups = [] } = res;
    for (const tr of trades) engine.emit('perp_trade', m.ticker, tradeVo(tr));
    if (!quiet || trades.length || canceledOrders.length) { engine.emit('perp_book', m.ticker, bookMsg(m.ticker)); emitTicker(getMarket(m.ticker), true); }
    if (order.user_id !== LP) engine.emit('perp_order', order.user_id, orderVo(order));
    for (const mid of makerOrders) {
      const mo = db.prepare('SELECT * FROM perp_orders WHERE id=?').get(mid);
      if (mo.user_id === LP) continue;
      engine.emit('perp_order', mo.user_id, orderVo(mo));
      notify(mo.user_id, { type: 'perp_fill', title: `Limit order filled: ${mo.side === 'bid' ? 'Long' : 'Short'} ${qtyText(mo.filled_count)} ${m.title} at ${fmtUnderlying(m, mo.price_cc)}`, body: `${m.title} perpetual`, link: `/perps/${m.ticker}` });
    }
    for (const o of canceledOrders) {
      if (o.user_id === LP) continue;
      engine.emit('perp_order', o.user_id, orderVo(o));
      if (!touched.has(o.user_id)) touched.set(o.user_id, new Set());
    }
    for (const g of triggeredGroups) {
      emitEvent(g.user_id, 'perp_order_group', groupVo(g));
      const n = db.prepare("SELECT COUNT(*) c FROM perp_orders WHERE order_group_id=? AND cancel_reason IN ('order_group_oco','order_group_limit')").get(g.id).c;
      notify(g.user_id, { type: 'perp_fill', title: PS('notify.group.title', { kind: g.kind === 'oco' ? 'OCO' : 'limit', count: n }), body: `${m.title} perpetual`, link: '/portfolio?perpsTab=orders' });
    }
    for (const [uid, ts] of touched) emitUser(uid, [...ts]);
    if (order.user_id !== LP && order.filled_count > 0 && order.source === 'user') {
      notify(order.user_id, { type: 'perp_fill', title: `${order.reduce_only ? 'Closed' : order.side === 'bid' ? 'Long' : 'Short'} ${qtyText(order.filled_count)} ${m.title} filled at ${fmtUnderlying(m, Math.round(order.fill_cost_cc / order.filled_count))}`, body: `${m.title} perpetual · ${order.leverage}x`, link: `/perps/${m.ticker}` });
    }
    for (const tr of trades) {
      for (const who of [tr.maker, tr.taker]) {
        if (!who || who === LP) continue;
        for (const fn of fillHooks) { try { fn(who, notionalCc(tr.count, tr.price_cc), { ticker: m.ticker }); } catch (e) { console.error('perps fill hook', e.message); } }
      }
    }
  }

  function placeOrder(uid, body, opts = {}) {
    const res = tx(db, () => placeCore(uid, body, opts));
    publishPlacement(res);
    return res.order;
  }

  function cancelOrder(uid, oid, reason = 'user_canceled') {
    const res = tx(db, () => {
      const o = db.prepare('SELECT * FROM perp_orders WHERE id=?').get(oid);
      if (!o || o.user_id !== uid) throw E.notFound();
      if (o.status !== 'resting') throw E.conflict('order_not_resting', 'order is not resting', `order status is ${o.status}`);
      return cancelInTx(o, reason);
    });
    engine.emit('perp_book', res.ticker, bookMsg(res.ticker));
    engine.emit('perp_order', uid, orderVo(res));
    emitUser(uid, []);
    return res;
  }

  // Decrease in place (keeps time priority): the reservation shrinks pro rata.
  function decreaseCore(o, newRem, reason = 'decreased') {
    if (newRem >= o.remaining_count) throw E.badRequest(PS('error.decrease_more'));
    if (newRem <= 0) return cancelInTx(o, reason);
    const keep = Math.round((o.reserved_cc * newRem) / o.remaining_count);
    const release = o.reserved_cc - keep;
    db.prepare('UPDATE perp_orders SET remaining_count=?, initial_count=initial_count-?, reserved_cc=?, updated_ts=? WHERE id=?').run(newRem, o.remaining_count - newRem, keep, Date.now(), o.id);
    if (release) { addAvail(o.user_id, o.subaccount, release); reserveMove(o.user_id, o.subaccount, -release, o.id); }
    return db.prepare('SELECT * FROM perp_orders WHERE id=?').get(o.id);
  }
  const ownResting = (uid, oid) => {
    const o = db.prepare('SELECT * FROM perp_orders WHERE id=?').get(String(oid));
    if (!o || o.user_id !== uid) throw E.notFound();
    if (o.status !== 'resting') throw E.conflict('order_not_resting', PS('error.amend_not_resting'), `order status is ${o.status}`);
    return o;
  };
  function decreaseOrder(uid, oid, b) {
    const res = tx(db, () => {
      const o = ownResting(uid, oid);
      const by = parseUnits(b, 'reduce_by', { required: false });
      const to = by == null ? (b.reduce_to === 0 || b.reduce_to === '0' || b.reduce_to_fp === '0' || b.reduce_to_fp === '0.00' ? 0 : parseUnits(b, 'reduce_to', { required: false })) : null;
      if (by == null && to == null) throw E.badRequest(PS('error.decrease_args'));
      const m = getMarket(o.ticker);
      const newRem = by != null ? o.remaining_count - by : to;
      if (newRem % UNITS && !m.fractional_trading_enabled) throw fractionalErr();
      return decreaseCore(o, Math.max(0, newRem));
    });
    engine.emit('perp_book', res.ticker, bookMsg(res.ticker));
    engine.emit('perp_order', uid, orderVo(res));
    emitUser(uid, []);
    return res;
  }
  // Amend: a smaller count at the same price decreases in place; a new price or a larger count cancels the order and
  // places its replacement (new id, `amended_from`) in one transaction — all the usual checks apply, and on any refusal
  // the original order is untouched.
  function amendOrder(uid, oid, b, opts = {}) {
    let old = null;
    const out = tx(db, () => {
      const o = ownResting(uid, oid);
      const m = getMarket(o.ticker);
      const priceRaw = b.price ?? b.price_dollars;
      let price = o.price_cc;
      if (priceRaw != null && priceRaw !== '') {
        const n = Number(priceRaw);
        if (!Number.isFinite(n) || n <= 0) throw E.badRequest('price must be a positive number (dollars per contract)');
        price = Math.round(n * CC);
        if (Math.abs(n * CC - price) > 1e-6) throw E.badRequest(CS.t('error.perps_tick', { tick: C.moneyCents(0.01, { exact: 4 }) }));
      }
      const units = parseUnits(b, 'count', { required: false }) ?? o.remaining_count;
      if (price === o.price_cc && units === o.remaining_count && b.client_order_id === undefined) throw E.badRequest(PS('error.amend_nothing'));
      if (units % UNITS && (!m.fractional_trading_enabled || opts.fractional === false)) throw fractionalErr();
      if (price === o.price_cc && units < o.remaining_count) return { order: decreaseCore(o, units), inPlace: true, m };
      old = cancelInTx(o, 'amended');
      const res = placeCore(uid, { ticker: o.ticker, side: o.side, type: 'limit', price: price / CC, time_in_force: 'gtc', leverage: o.leverage, subaccount: o.subaccount, order_group_id: o.order_group_id, post_only: !!o.post_only, client_order_id: b.client_order_id ?? o.client_order_id, amended_from: o.id }, { source: o.source, units, fractional: opts.fractional !== false });
      return { res, m };
    });
    if (out.inPlace) {
      engine.emit('perp_book', out.order.ticker, bookMsg(out.order.ticker));
      engine.emit('perp_order', uid, orderVo(out.order));
      emitUser(uid, []);
      return { old_order: null, order: out.order };
    }
    engine.emit('perp_order', uid, orderVo(old));
    publishPlacement(out.res);
    return { old_order: old, order: out.res.order };
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
        const size = Math.round(base * (1 + i * 0.35)) * UNITS;
        const ask = Math.round(center + hs + i * step);
        const bid = Math.max(1, Math.round(center - hs - i * step));
        results.push(placeCore(LP, { ticker: m.ticker, side: 'ask', price: ask / CC, type: 'limit' }, { source: 'liquidity', units: size }));
        results.push(placeCore(LP, { ticker: m.ticker, side: 'bid', price: bid / CC, type: 'limit' }, { source: 'liquidity', units: size }));
      }
    });
    for (const r of results) if (r.trades.length) publishPlacement(r, { quiet: true });
    const rest = db.prepare("SELECT COALESCE(SUM(remaining_count),0) r FROM perp_orders WHERE ticker=? AND user_id=? AND status='resting'").get(m.ticker, LP).r;
    lastQuote.set(m.ticker, { mark, basis: m.basis, rest, ts: now });
    engine.emit('perp_book', m.ticker, bookMsg(m.ticker));
  }

  // ---------------------------------------------------------------- exit triggers (TP/SL and trailing stops on the mark)
  // Trailing stops (CLONE_SPEC.md §34.3): the server keeps a persisted watermark (the best mark since the stop was set:
  // the highest for a long, the lowest for a short), updates it first on every evaluation, then fires when the mark has
  // retraced by the trail distance. A gap through the stop fires once, at the next evaluation, with a reduce-only market
  // order; the trigger row is updated in the same transaction as the order, so it can never fire twice.
  function evalTriggers(m) {
    const mark = markCc(m);
    for (const t of db.prepare("SELECT * FROM perp_exit_triggers WHERE ticker=? AND status='active' ORDER BY created_ts").all(m.ticker)) {
      const cur = db.prepare('SELECT status FROM perp_exit_triggers WHERE id=?').get(t.id);
      if (!cur || cur.status !== 'active') continue; // an earlier trigger closed this position in this pass
      const p = position(t.user_id, t.subaccount, m.ticker);
      const now = Date.now();
      if (!p || p.qty === 0) { db.prepare("UPDATE perp_exit_triggers SET status='canceled', status_reason='position_closed', updated_ts=? WHERE id=?").run(now, t.id); continue; }
      const long = p.qty > 0;
      let leg = null;
      if (t.kind === 'trailing') {
        let wm = t.watermark_cc ?? mark;
        if (long ? mark > wm : mark < wm) wm = mark;
        const dist = t.trail_cc != null ? t.trail_cc : Math.max(1, Math.round((wm * t.trail_bps) / 10000));
        const stop = long ? wm - dist : wm + dist;
        if (wm !== t.watermark_cc || stop !== t.stop_cc) {
          db.prepare('UPDATE perp_exit_triggers SET watermark_cc=?, stop_cc=?, updated_ts=? WHERE id=?').run(wm, stop, now, t.id);
          emitUser(t.user_id, [m.ticker]);
        }
        if (long ? mark <= stop : mark >= stop) leg = 'trailing_stop';
      } else if (t.take_profit_cc != null && (long ? mark >= t.take_profit_cc : mark <= t.take_profit_cc)) leg = 'take_profit';
      else if (t.stop_loss_cc != null && (long ? mark <= t.stop_loss_cc : mark >= t.stop_loss_cc)) leg = 'stop_loss';
      if (!leg) continue;
      const count = t.count > 0 ? Math.min(t.count, Math.abs(p.qty)) : Math.abs(p.qty);
      try {
        const res = tx(db, () => {
          const r = placeCore(t.user_id, { ticker: m.ticker, side: long ? 'ask' : 'bid', type: 'market', reduce_only: true, subaccount: t.subaccount }, { source: t.kind === 'trailing' ? 'trailing_stop' : 'exit_trigger', skipBand: true, units: count });
          const after = position(t.user_id, t.subaccount, m.ticker);
          db.prepare('UPDATE perp_exit_triggers SET status=?, status_reason=?, triggered_leg=?, triggered_order_id=?, filled_count=filled_count+?, fired_mark_cc=?, updated_ts=? WHERE id=?')
            .run(!after || after.qty === 0 ? 'filled' : 'active', null, leg, r.order.id, r.order.filled_count, mark, Date.now(), t.id);
          return r;
        });
        publishPlacement(res);
        const o = res.order;
        const px = o.filled_count ? Math.round(o.fill_cost_cc / o.filled_count) : mark;
        const title = leg === 'trailing_stop'
          ? PS('notify.trailing.title', { side: long ? 'Long' : 'Short', count: qtyText(o.filled_count), market: m.title, price: fmtUnderlying(m, px) })
          : `${leg === 'take_profit' ? 'Take profit' : 'Stop loss'} hit: closed ${long ? 'Long' : 'Short'} ${qtyText(o.filled_count)} ${m.title} at ${fmtUnderlying(m, px)}`;
        notify(t.user_id, { type: 'perp_exit_trigger', title, body: `${m.title} perpetual`, link: `/perps/${m.ticker}` });
        emitUser(t.user_id, [m.ticker]);
      } catch (e) {
        db.prepare("UPDATE perp_exit_triggers SET status='failed', status_reason='order_rejected', triggered_leg=?, fired_mark_cc=?, updated_ts=? WHERE id=?").run(leg, mark, Date.now(), t.id);
        notify(t.user_id, { type: 'perp_exit_trigger', title: `${leg === 'take_profit' ? 'Take profit' : leg === 'trailing_stop' ? 'Trailing stop' : 'Stop loss'} could not close your ${m.title} position`, body: e.message, link: `/perps/${m.ticker}` });
      }
    }
  }

  // ---------------------------------------------------------------- liquidation
  // Isolated positions: equity (margin + unrealized PnL) below the position's tiered maintenance margin.
  function checkIsolated(m) {
    const mark = markCc(m);
    for (const p of db.prepare('SELECT * FROM perp_positions WHERE ticker=? AND qty<>0 AND user_id<>?').all(m.ticker, LP || '')) {
      if (modeOf(p.user_id, p.subaccount) === 'cross') continue;
      const equity = p.margin_cc + upnlCc(p, mark);
      if (equity >= mmOf(m, p.qty, mark)) continue;
      liquidate(p, m, mark, 'isolated');
    }
  }
  // Portfolio (cross) subaccounts: the subaccount's equity below the sum of its positions' maintenance margins. Its
  // resting orders are canceled first; then positions are closed largest requirement first until the equity covers
  // what is left.
  function checkCross() {
    const subs = db.prepare("SELECT DISTINCT p.user_id, p.subaccount FROM perp_positions p JOIN perp_subaccounts s ON s.user_id=p.user_id AND s.subaccount=p.subaccount WHERE p.qty<>0 AND s.margin_mode='cross'").all();
    for (const { user_id: uid, subaccount: sub } of subs) {
      let r = subRisk(uid, sub);
      if (r.equity >= r.mm) continue;
      const canceled = tx(db, () => db.prepare("SELECT * FROM perp_orders WHERE user_id=? AND subaccount=? AND status='resting'").all(uid, sub).map((o) => cancelInTx(o, 'liquidation')));
      for (const o of canceled) { engine.emit('perp_order', uid, orderVo(o)); engine.emit('perp_book', o.ticker, bookMsg(o.ticker)); }
      for (let guard = 0; guard < 64; guard += 1) {
        r = subRisk(uid, sub);
        if (r.equity >= r.mm || !r.rows.length) break;
        const worst = r.rows.filter((x) => !x.skipped).sort((a, b) => b.mm - a.mm)[0];
        liquidate(worst.p, worst.m, worst.mark, 'cross');
      }
    }
  }
  function liquidate(p, m, mark, mode) {
    const ts = Date.now();
    const uid = p.user_id; const sub = p.subaccount;
    const q = p.qty;
    const n = Math.abs(q);
    const side = q > 0 ? 'ask' : 'bid';
    const mmAmt = Math.round(mmOf(m, q, mark));
    const liqPx = liqPriceOf(p, m, mode);
    const tradeId = newId('pt_');
    let fee = 0; let returned = 0; let shortfall = 0; let realized = 0;
    tx(db, () => {
      db.prepare('INSERT INTO perp_trades(id,ticker,price_cc,count,taker_side,is_liquidation,created_ts) VALUES(?,?,?,?,?,1,?)').run(tradeId, m.ticker, mark, n, side, ts);
      const sim = fillMath({ q, cost: p.cost_ucc, margin: p.margin_cc, avail: 0 }, { side, n, p: mark, lev: 1, feeRate: 0, sys: false });
      const remaining = p.margin_cc + sim.paid;
      if (mode === 'isolated' && remaining < 0) {
        // Isolated margin: the loss beyond the position's margin never touches other collateral; the fund covers it.
        shortfall = -remaining;
        const ins = Math.max(0, PL.balanceOf(db, PL.H.insurance));
        const fromIns = Math.min(ins, shortfall);
        db.prepare('UPDATE perp_positions SET margin_cc=margin_cc+? WHERE user_id=? AND subaccount=? AND ticker=?').run(shortfall, uid, sub, m.ticker);
        J('shortfall', tradeId, uid, 'liquidation shortfall covered', [[PL.H.insurance, -fromIns], [PL.H.backstop, -(shortfall - fromIns)], [PL.A.margin(uid, sub), shortfall]]);
        setMeta('insurance_shortfall_cc', Number(meta('insurance_shortfall_cc', 0)) + shortfall);
      }
      const before = availOf(uid, sub);
      const fr = applyFill(uid, sub, m, { order: null, side, n, p: mark, isTaker: true, feeRate: 0, tradeId, ts, lev: 1, source: 'liquidation', cover: false });
      realized = fr.realized;
      if (mode === 'cross') shortfall += coverDeficit(uid, sub);
      const room = mode === 'isolated' ? Math.max(0, remaining) : Math.max(0, availOf(uid, sub));
      fee = Math.min(room, Math.round(mmAmt / 2));
      if (fee) {
        addAvail(uid, sub, -fee);
        J('liquidation_fee', tradeId, uid, 'liquidation fee', [[PL.A.avail(uid, sub), -fee], [PL.H.insurance, fee]]);
        db.prepare('UPDATE perp_fills SET fee_cc=? WHERE id=?').run(fee, fr.fillId);
      }
      returned = Math.max(0, availOf(uid, sub) - before);
      db.prepare('INSERT INTO perp_liquidations(id,user_id,ticker,side,count,entry_cc,mark_cc,liq_price_cc,margin_cc,realized_cc,fee_cc,returned_cc,shortfall_cc,created_ts,subaccount,margin_mode) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(newId('lq_'), uid, m.ticker, q > 0 ? 'long' : 'short', n, entryOf(p), mark, liqPx, p.margin_cc, realized, fee, returned, shortfall, ts, sub, mode);
      ledger(uid, sub, 'liquidation', realized, m.ticker, tradeId, `liquidated ${qtyText(n)} contracts at mark`);
      ledger(uid, sub, 'liquidation_fee', -fee, m.ticker, tradeId, 'liquidation fee');
      db.prepare("UPDATE perp_exit_triggers SET status='canceled', status_reason='position_closed', updated_ts=? WHERE user_id=? AND subaccount=? AND ticker=? AND status='active'").run(ts, uid, sub, m.ticker);
      // The liquidity account takes over the position at mark.
      if (LP) applyFill(LP, 0, m, { order: null, side: q > 0 ? 'bid' : 'ask', n, p: mark, isTaker: false, feeRate: 0, tradeId, ts, lev: 1, source: 'liquidation' });
    });
    engine.emit('perp_trade', m.ticker, tradeVo({ id: tradeId, ticker: m.ticker, price_cc: mark, count: n, taker_side: side, is_liquidation: 1, created_ts: ts }));
    notify(uid, { type: 'perp_liquidation', title: `Liquidated: ${q > 0 ? 'Long' : 'Short'} ${qtyText(n)} ${m.title} closed at ${fmtUnderlying(m, mark)}`, body: CS.t('notify.perps_liquidation.body', { amount: C.moneyCents(returned / 100) }), link: `/perps/${m.ticker}` });
    emitUser(uid, [m.ticker]);
  }

  // ---------------------------------------------------------------- funding
  // Zero-sum by construction: every user position pays or receives round(-q x mark x rate) and the liquidity account
  // takes the exact opposite of their sum (it absorbs the rounding), so each funding event nets to zero.
  function runFunding(m, now = Date.now()) {
    const mark = markCc(m);
    const { rate, premium } = fundingEstimate(m);
    const interval = intervalOf(m);
    let next = m.next_funding_ts + interval;
    if (next <= now) next = now + interval;
    const paid = [];
    tx(db, () => {
      db.prepare('INSERT INTO perp_funding_rates(id,ticker,funding_ts,rate,mark_cc,premium) VALUES(?,?,?,?,?,?)').run(newId('fr_'), m.ticker, now, rate, mark, Number(premium.toFixed(8)));
      const rows = db.prepare('SELECT * FROM perp_positions WHERE ticker=? AND qty<>0 ORDER BY user_id, subaccount').all(m.ticker);
      const postings = [];
      let sum = 0;
      const deficits = [];
      for (const p of rows) {
        if (p.user_id === LP) continue;
        const amount = Math.round((-p.qty * mark * rate) / UNITS); // positive rate: longs pay shorts
        sum += amount;
        const newMargin = p.margin_cc + amount;
        if (newMargin >= 0) {
          db.prepare('UPDATE perp_positions SET margin_cc=?, funding_cc=funding_cc+?, updated_ts=? WHERE user_id=? AND subaccount=? AND ticker=?').run(newMargin, amount, now, p.user_id, p.subaccount, m.ticker);
          postings.push([PL.A.margin(p.user_id, p.subaccount), amount]);
        } else {
          db.prepare('UPDATE perp_positions SET margin_cc=0, funding_cc=funding_cc+?, updated_ts=? WHERE user_id=? AND subaccount=? AND ticker=?').run(amount, now, p.user_id, p.subaccount, m.ticker);
          addAvail(p.user_id, p.subaccount, newMargin);
          postings.push([PL.A.margin(p.user_id, p.subaccount), -p.margin_cc], [PL.A.avail(p.user_id, p.subaccount), newMargin]);
          deficits.push([p.user_id, p.subaccount]);
        }
        postings.push([PL.H.funding, -amount]);
        db.prepare('INSERT INTO perp_funding_payments(id,user_id,ticker,funding_ts,rate,mark_cc,qty,amount_cc,subaccount) VALUES(?,?,?,?,?,?,?,?,?)').run(newId('fp_'), p.user_id, m.ticker, now, rate, mark, p.qty, amount, p.subaccount);
        ledger(p.user_id, p.subaccount, 'funding', amount, m.ticker, null, `funding at ${(rate * 100).toFixed(4)}%`);
        paid.push({ uid: p.user_id, amount, qty: p.qty });
      }
      if (LP && (sum !== 0 || rows.some((p) => p.user_id === LP))) {
        const lpPos = rows.find((p) => p.user_id === LP);
        const amount = -sum;
        account(LP);
        addAvail(LP, 0, amount);
        postings.push([PL.A.avail(LP, 0), amount], [PL.H.funding, -amount]);
        if (lpPos) db.prepare('UPDATE perp_positions SET funding_cc=funding_cc+? WHERE user_id=? AND subaccount=0 AND ticker=?').run(amount, LP, m.ticker);
        db.prepare('INSERT INTO perp_funding_payments(id,user_id,ticker,funding_ts,rate,mark_cc,qty,amount_cc,subaccount) VALUES(?,?,?,?,?,?,?,?,0)').run(newId('fp_'), LP, m.ticker, now, rate, mark, lpPos ? lpPos.qty : 0, amount);
      }
      J('funding', m.ticker, null, `funding at ${(rate * 100).toFixed(4)}%`, postings);
      for (const [uid, sub] of deficits) coverDeficit(uid, sub);
      db.prepare('UPDATE perp_markets SET premium_sum=0, premium_n=0, last_funding_ts=?, next_funding_ts=? WHERE ticker=?').run(now, next, m.ticker);
    });
    for (const x of paid) {
      emitUser(x.uid, [m.ticker]);
      const a = account(x.uid);
      if (now - a.last_funding_notice_ts >= HOUR) { // at most one funding notification per user per hour
        db.prepare('UPDATE perp_accounts SET last_funding_notice_ts=? WHERE user_id=?').run(now, x.uid);
        notify(x.uid, { type: 'margin_funding_payment', title: CS.t('notify.perps_funding.title', { direction: x.amount >= 0 ? 'received' : 'paid', amount: C.moneyCents(Math.abs(x.amount) / 100, { exact: 4 }), market: m.title }), body: `Rate ${(rate * 100).toFixed(4)}% on your ${x.qty > 0 ? 'long' : 'short'} position`, link: '/portfolio?perpsTab=history' });
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
  const tickHooks = []; // (now) — Perps APY accrual (server/perps-ops.js)
  function tick(now = Date.now()) {
    for (const m0 of db.prepare("SELECT * FROM perp_markets WHERE status='active' ORDER BY sort_order").all()) {
      let m = m0.sim_frozen ? { ...m0, sim_ts: now } : simStep(m0, now);
      recordHistory(m, now);
      m = samplePremium(m);
      saveSim(m);
      requote(m, now);
      evalTriggers(m);
      checkIsolated(m);
      m = getMarket(m.ticker);
      if (now >= m.next_funding_ts) { runFunding(m, now); checkIsolated(getMarket(m.ticker)); }
      emitTicker(getMarket(m.ticker));
    }
    checkCross();
    for (const fn of tickHooks) { try { fn(now); } catch (e) { console.error('perps tick hook', e); } }
    if (now - lastPrune > HOUR) { lastPrune = now; db.prepare('DELETE FROM perp_price_history WHERE ts<?').run(now - 30 * DAY); }
  }
  engine.on('tick', () => { if (engine.flags && !engine.flags.jobOn('perps')) return; try { tick(); } catch (e) { console.error('perps tick', e); } }); // paused while the flag is off (§33)
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
    checkIsolated(m);
    checkCross();
    m = getMarket(m0.ticker);
    emitTicker(m, true);
    return m;
  }

  // ---------------------------------------------------------------- collateral in and out (main journal bridge)
  // Moves `cents` between the main journal and a subaccount's free collateral, both journals in one transaction.
  // contra: the main-journal account the money comes from (bank:vault, play:mint, …). Returns the ledger amount (cc).
  function creditCollateral(uid, sub, cents, { kind, ref = null, memo = '', contra }) {
    if (!(Number.isInteger(cents) && cents > 0)) throw new Error('creditCollateral: positive whole cents');
    if (!contra) throw new Error('creditCollateral: contra account required');
    return tx(db, () => {
      account(uid);
      if (sub) mustSub(uid, sub);
      journal.post(db, { kind, ref, userId: uid, memo }, [[contra, -cents], ['perps:collateral', cents]]);
      addAvail(uid, sub, cents * 100);
      J(kind, ref, uid, memo, [[PL.H.bridge, -cents * 100], [PL.A.avail(uid, sub), cents * 100]]);
      ledger(uid, sub, kind, cents * 100, null, ref, memo);
      return cents * 100;
    });
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
  v1.get(`${P}/markets/:ticker/margin_tiers`, (req, res) => { const m = mustMarket(req.params.ticker); res.json({ market_ticker: m.ticker, margin_tiers: tiersOf(m.ticker).map(tierVo), max_position_notional_dollars: cc$(R.maxNotional(tiersOf(m.ticker))) }); });
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
    for (const t of trades) { const c = buckets.get(Math.floor(t.created_ts / pms) * pms); if (c) { c.v += t.count; c.d += (t.count * t.price_cc) / UNITS; } }
    let prev = null;
    const candles = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([b, c]) => {
      const out = { end_period_ts: Math.floor((b + pms) / 1000), price: { open: cc$(c.o), high: cc$(c.h), low: cc$(c.l), close: cc$(c.c), mean: c.v ? cc$((c.d * UNITS) / c.v) : null, previous: prev }, volume: ufp(c.v), volume_notional_value_dollars: cc$(c.d), open_interest: ufp(0), open_interest_notional_value_dollars: cc$(0) };
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
    const rs = riskSettings();
    res.json({
      liquidation_margin_ratio_threshold: 1.0, queue_entry_margin_ratio_threshold: 1.0,
      initial_margin_multiplier: Object.fromEntries(ms.map((m) => [m.ticker, m.im_multiplier])),
      maintenance_margin_rate: Object.fromEntries(ms.map((m) => [m.ticker, Number(mmRate(m).toFixed(6))])),
      max_leverage: Object.fromEntries(ms.map((m) => [m.ticker, m.max_leverage])),
      margin_tiers: Object.fromEntries(ms.map((m) => [m.ticker, tiersOf(m.ticker).map(tierVo)])),
      max_position_notional_dollars: Object.fromEntries(ms.map((m) => [m.ticker, cc$(R.maxNotional(tiersOf(m.ticker)))])),
      price_band: { percent: BAND_PCT, ticks: BAND_TICKS }, market_order_slippage: MARKET_SLIPPAGE,
      limits: { max_open_orders_per_market: rs.max_open_orders_per_market, max_open_orders_total: rs.max_open_orders_total, max_subaccounts: rs.max_subaccounts, max_order_groups: rs.max_order_groups, max_orders_per_group: rs.max_orders_per_group },
    });
  });
  v1.get(`${P}/fee_tiers`, (req, res) => {
    const ms = db.prepare('SELECT ticker, maker_fee_rate, taker_fee_rate FROM perp_markets').all();
    res.json({ maker_fee_rates: Object.fromEntries(ms.map((m) => [m.ticker, m.maker_fee_rate])), taker_fee_rates: Object.fromEntries(ms.map((m) => [m.ticker, m.taker_fee_rate])) });
  });

  // ======================================================== REST: authenticated
  const uidOf = (req) => req.auth.user.id;
  const fracOn = (req) => !engine.flags || engine.flags.on('perps.fractional', { req });
  const qSub = (req) => (req.query.subaccount == null || req.query.subaccount === '' ? null : parseSub(req.query.subaccount));
  v1.get(`${P}/balance`, requireUser, (req, res) => {
    const sub = qSub(req) ?? 0;
    if (sub) mustSub(uidOf(req), sub);
    res.json(balanceVo(uidOf(req), sub));
  });

  const parseCents = (b) => {
    let cents;
    if (b.amount_dollars != null) cents = Math.round(Number(b.amount_dollars) * 100);
    else if (b.amount != null) { const ccAmt = Number(b.amount); if (!Number.isInteger(ccAmt) || ccAmt % 100 !== 0) throw E.badRequest('amount is in centicents and must be a whole number of cents'); cents = ccAmt / 100; }
    if (!Number.isInteger(cents) || cents < 1 || Math.abs(Number(b.amount_dollars ?? cents / 100) * 100 - cents) > 1e-6) throw E.badRequest(CS.t('error.perps_transfer_min', { min: C.moneyCents(1), unit: CS.t(`currency.unit.whole.${C.config().code}`) }));
    return cents;
  };
  v1.post(`${P}/transfers`, requireUser, (req, res) => {
    const uid = uidOf(req);
    const b = req.body || {};
    let dir = b.direction;
    if (!dir && b.source && b.destination) dir = b.source === 'event_contract' && b.destination === 'margined' ? 'to_perps' : b.source === 'margined' && b.destination === 'event_contract' ? 'to_predictions' : null;
    if (!['to_perps', 'to_predictions'].includes(dir)) throw E.badRequest('direction must be to_perps or to_predictions (or source/destination event_contract|margined)');
    const sub = parseSub(b.subaccount);
    const cents = parseCents(b);
    if (b.client_transfer_id && db.prepare('SELECT 1 FROM perp_transfers WHERE user_id=? AND client_transfer_id=?').get(uid, String(b.client_transfer_id))) throw E.conflict('duplicate_transfer', 'a transfer with this client_transfer_id already exists');
    const ccAmt = cents * 100;
    const id = newId('tr_');
    const t = tx(db, () => {
      account(uid);
      if (sub) mustSub(uid, sub);
      if (dir === 'to_perps') {
        if (engine.balance(uid) < cents) throw E.conflict('insufficient_balance', 'insufficient balance', CS.t('error.perps_cash', { amount: C.moneyCents(engine.balance(uid)) }));
        // Non-withdrawable promotional credits stay with predictions (server/payments.js, CLONE_SPEC.md §26.5).
        if (engine.transferableCents && engine.transferableCents(uid) < cents) throw E.conflict('credits_not_transferable', 'promotional credits cannot be moved to Perps', CS.t('error.perps_credits', { amount: C.moneyCents(engine.transferableCents(uid)) }));
        engine.credit(uid, -cents, 'perps_transfer', id, 'Transfer to Perps');
        addAvail(uid, sub, ccAmt);
        J('transfer_in', id, uid, 'from predictions cash', [[PL.H.bridge, -ccAmt], [PL.A.avail(uid, sub), ccAmt]]);
      } else {
        const a = availOf(uid, sub);
        if (a < ccAmt) throw E.conflict('insufficient_margin', 'insufficient perps collateral', CS.t('error.perps_available', { amount: C.moneyCents(a / 100) }));
        addAvail(uid, sub, -ccAmt);
        J('transfer_out', id, uid, 'to predictions cash', [[PL.A.avail(uid, sub), -ccAmt], [PL.H.bridge, ccAmt]]);
        engine.credit(uid, cents, 'perps_transfer', id, 'Transfer from Perps');
      }
      const src = dir === 'to_perps' ? 'event_contract' : 'margined';
      const dst = dir === 'to_perps' ? 'margined' : 'event_contract';
      db.prepare('INSERT INTO perp_transfers(id,user_id,source,destination,amount_cc,status,client_transfer_id,created_ts,from_subaccount,to_subaccount) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, uid, src, dst, ccAmt, 'completed', b.client_transfer_id ?? null, Date.now(), dir === 'to_perps' ? null : sub, dir === 'to_perps' ? sub : null);
      ledger(uid, sub, 'transfer', dir === 'to_perps' ? ccAmt : -ccAmt, null, id, dir === 'to_perps' ? 'from predictions cash' : 'to predictions cash');
      return db.prepare('SELECT * FROM perp_transfers WHERE id=?').get(id);
    });
    engine.emit('user_balance', uid, engine.balance(uid));
    emitUser(uid, []);
    notify(uid, { type: 'margin_transfer_completed', title: CS.t('notify.perps_transfer.title', { amount: C.moneyCents(cents), destination: dir === 'to_perps' ? 'to Perps' : 'to Predictions' }), body: 'Transfer completed', link: dir === 'to_perps' ? '/portfolio?perpsTab=positions' : '/portfolio' });
    res.status(201).json({ transfer_id: t.id, transfer: transferVo(t), balance: balanceVo(uid, sub) });
  });
  v1.get(`${P}/transfers`, requireUser, (req, res) => res.json({ transfers: db.prepare('SELECT * FROM perp_transfers WHERE user_id=? ORDER BY created_ts DESC, rowid DESC LIMIT 200').all(uidOf(req)).map(transferVo) }));

  // ---- subaccounts (CLONE_SPEC.md §34.1)
  const subName = (v) => { const s = String(v ?? '').trim(); if (s.length < 1 || s.length > 40 || /[<>]/.test(s)) throw E.badRequest(PS('error.sub_name')); return s; };
  const subMode = (v) => { if (v == null) return null; if (!['isolated', 'cross'].includes(v)) throw E.badRequest(PS('error.sub_mode')); return v; };
  const subsVo = (uid) => ({ subaccounts: subsOf(uid).map((n) => { const x = subBalance(uid, n); delete x._r; return x; }), max_subaccounts: riskSettings().max_subaccounts });
  v1.get(`${P}/subaccounts`, requireUser, (req, res) => res.json(subsVo(uidOf(req))));
  v1.post(`${P}/subaccounts`, requireUser, (req, res) => {
    const uid = uidOf(req);
    const b = req.body || {};
    const name = subName(b.name);
    const mode = subMode(b.margin_mode) || 'isolated';
    const n = tx(db, () => {
      account(uid);
      const used = new Set(subsOf(uid));
      const limit = riskSettings().max_subaccounts;
      if (used.size >= limit) throw E.conflict('subaccount_limit', PS('error.sub_limit', { limit }));
      let k = 1; while (used.has(k) && k <= MAX_SUB) k += 1;
      if (k > MAX_SUB) throw E.conflict('subaccount_limit', PS('error.sub_limit', { limit }));
      const now = Date.now();
      db.prepare('INSERT INTO perp_subaccounts(user_id,subaccount,name,margin_mode,available_cc,created_ts,updated_ts) VALUES(?,?,?,?,0,?,?)').run(uid, k, name, mode, now, now);
      return k;
    });
    emitUser(uid, []);
    emitEvent(uid, 'perp_subaccounts', subsVo(uid));
    res.status(201).json({ subaccount: n, ...subsVo(uid) });
  });
  v1.put(`${P}/subaccounts/:n`, requireUser, (req, res) => {
    const uid = uidOf(req);
    const sub = parseSub(req.params.n);
    const b = req.body || {};
    const name = b.name != null ? subName(b.name) : null;
    const mode = subMode(b.margin_mode);
    if (name == null && mode == null) throw E.badRequest(PS('error.sub_name'));
    tx(db, () => {
      const cur = mustSub(uid, sub);
      if (mode && mode !== cur.margin_mode) {
        const busy = db.prepare('SELECT 1 FROM perp_positions WHERE user_id=? AND subaccount=? AND qty<>0').get(uid, sub) || db.prepare("SELECT 1 FROM perp_orders WHERE user_id=? AND subaccount=? AND status='resting'").get(uid, sub);
        if (busy) throw E.conflict('subaccount_busy', PS('error.sub_mode_busy'));
      }
      const now = Date.now();
      db.prepare('INSERT INTO perp_subaccounts(user_id,subaccount,name,margin_mode,available_cc,created_ts,updated_ts) VALUES(?,?,?,?,0,?,?) ON CONFLICT(user_id,subaccount) DO UPDATE SET name=excluded.name, margin_mode=excluded.margin_mode, updated_ts=excluded.updated_ts')
        .run(uid, sub, name ?? cur.name, mode ?? cur.margin_mode, now, now);
    });
    emitUser(uid, []);
    emitEvent(uid, 'perp_subaccounts', subsVo(uid));
    res.json({ subaccount: sub, ...subsVo(uid) });
  });
  v1.post(`${P}/subaccounts/transfers`, requireUser, (req, res) => {
    const uid = uidOf(req);
    const b = req.body || {};
    const from = parseSub(b.from_subaccount); const to = parseSub(b.to_subaccount);
    if (from === to) throw E.badRequest(PS('error.sub_same'));
    const cents = parseCents(b);
    if (b.client_transfer_id && db.prepare('SELECT 1 FROM perp_transfers WHERE user_id=? AND client_transfer_id=?').get(uid, String(b.client_transfer_id))) throw E.conflict('duplicate_transfer', 'a transfer with this client_transfer_id already exists');
    const ccAmt = cents * 100;
    const id = newId('tr_');
    const t = tx(db, () => {
      account(uid);
      mustSub(uid, from); mustSub(uid, to);
      const a = availOf(uid, from);
      if (a < ccAmt) throw E.conflict('insufficient_margin', 'insufficient perps collateral', PS('error.sub_funds', { amount: C.moneyCents(a / 100) }));
      addAvail(uid, from, -ccAmt); addAvail(uid, to, ccAmt);
      J('subaccount_transfer', id, uid, `subaccount ${from} to ${to}`, [[PL.A.avail(uid, from), -ccAmt], [PL.A.avail(uid, to), ccAmt]]);
      db.prepare('INSERT INTO perp_transfers(id,user_id,source,destination,amount_cc,status,client_transfer_id,created_ts,from_subaccount,to_subaccount) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, uid, 'margined', 'margined', ccAmt, 'completed', b.client_transfer_id ?? null, Date.now(), from, to);
      ledger(uid, from, 'subaccount_transfer', -ccAmt, null, id, PS('memo.sub_transfer_out', { to }));
      ledger(uid, to, 'subaccount_transfer', ccAmt, null, id, PS('memo.sub_transfer_in', { from }));
      return db.prepare('SELECT * FROM perp_transfers WHERE id=?').get(id);
    });
    emitUser(uid, []);
    emitEvent(uid, 'perp_subaccounts', subsVo(uid));
    res.status(201).json({ transfer_id: t.id, transfer: transferVo(t), ...subsVo(uid) });
  });

  // ---- orders
  v1.post(`${P}/orders`, requireUser, (req, res) => {
    const o = placeOrder(uidOf(req), req.body || {}, { source: 'user', fractional: fracOn(req) });
    const vo = orderVo(o);
    res.status(201).json({ order: vo, order_id: o.id, client_order_id: o.client_order_id, fill_count: vo.fill_count, remaining_count: vo.remaining_count, average_fill_price: vo.average_fill_price, average_fee_paid: o.filled_count ? cc$((o.fees_cc * UNITS) / o.filled_count) : null });
  });
  v1.get(`${P}/orders`, requireUser, (req, res) => {
    const args = [uidOf(req)]; const where = ['user_id=?'];
    if (req.query.status) { where.push('status=?'); args.push(String(req.query.status)); }
    if (req.query.ticker) { where.push('ticker=?'); args.push(String(req.query.ticker).toUpperCase()); }
    if (qSub(req) != null) { where.push('subaccount=?'); args.push(qSub(req)); }
    if (req.query.order_group_id) { where.push('order_group_id=?'); args.push(String(req.query.order_group_id)); }
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
  v1.post(`${P}/orders/:id/amend`, requireUser, (req, res) => {
    const r = amendOrder(uidOf(req), req.params.id, req.body || {}, { fractional: fracOn(req) });
    res.json({ old_order: r.old_order ? orderVo(r.old_order) : null, order: orderVo(r.order) });
  });
  v1.post(`${P}/orders/:id/decrease`, requireUser, (req, res) => res.json({ order: orderVo(decreaseOrder(uidOf(req), req.params.id, req.body || {})) }));

  // ---- order groups (CLONE_SPEC.md §34.2)
  v1.post(`${P}/order_groups`, requireUser, (req, res) => {
    const uid = uidOf(req);
    const b = req.body || {};
    const kind = b.kind == null ? 'limit' : String(b.kind);
    if (!['limit', 'oco'].includes(kind)) throw E.badRequest(PS('error.group_kind'));
    const sub = parseSub(b.subaccount);
    let limit = 0;
    if (kind === 'limit') { try { limit = parseUnits(b, 'contracts_limit'); } catch { throw E.badRequest(PS('error.group_contracts')); } }
    const g = tx(db, () => {
      if (sub) mustSub(uid, sub);
      const max = riskSettings().max_order_groups;
      if (db.prepare("SELECT COUNT(*) c FROM perp_order_groups WHERE user_id=? AND status='active'").get(uid).c >= max) throw E.conflict('order_group_limit', PS('error.group_limit', { limit: max }));
      const id = newId('og_'); const now = Date.now();
      db.prepare('INSERT INTO perp_order_groups(id,user_id,subaccount,kind,contracts_limit,filled,status,created_ts,updated_ts) VALUES(?,?,?,?,?,0,?,?,?)').run(id, uid, sub, kind, limit, 'active', now, now);
      return groupRow(id);
    });
    emitEvent(uid, 'perp_order_group', groupVo(g));
    res.status(201).json({ order_group_id: g.id, order_group: groupVo(g) });
  });
  v1.get(`${P}/order_groups`, requireUser, (req, res) => res.json({ order_groups: db.prepare("SELECT * FROM perp_order_groups WHERE user_id=? AND status<>'deleted' ORDER BY created_ts DESC LIMIT 100").all(uidOf(req)).map(groupVo) }));
  const ownGroup = (uid, id) => { const g = groupRow(id); if (!g || g.user_id !== uid || g.status === 'deleted') throw new ApiError(404, 'order_group_not_found', PS('error.group_not_found')); return g; };
  v1.get(`${P}/order_groups/:id`, requireUser, (req, res) => {
    const g = ownGroup(uidOf(req), req.params.id);
    res.json({ order_group: groupVo(g), orders: db.prepare('SELECT * FROM perp_orders WHERE order_group_id=? ORDER BY created_ts DESC LIMIT 200').all(g.id).map(orderVo) });
  });
  // Group-level cancel: every resting order of the group, then the group is closed.
  v1.delete(`${P}/order_groups/:id`, requireUser, (req, res) => {
    const uid = uidOf(req);
    const out = tx(db, () => {
      const g = ownGroup(uid, req.params.id);
      const canceled = db.prepare("SELECT * FROM perp_orders WHERE order_group_id=? AND status='resting'").all(g.id).map((o) => cancelInTx(o, 'order_group_canceled'));
      db.prepare("UPDATE perp_order_groups SET status='canceled', status_reason='user_canceled', updated_ts=? WHERE id=?").run(Date.now(), g.id);
      return { g: groupRow(g.id), canceled };
    });
    for (const o of out.canceled) { engine.emit('perp_order', uid, orderVo(o)); engine.emit('perp_book', o.ticker, bookMsg(o.ticker)); }
    emitUser(uid, []);
    emitEvent(uid, 'perp_order_group', groupVo(out.g));
    res.json({ order_group: groupVo(out.g), canceled_count: out.canceled.length });
  });
  v1.post(`${P}/order_groups/:id/reset`, requireUser, (req, res) => {
    const uid = uidOf(req);
    const g = tx(db, () => {
      const x = ownGroup(uid, req.params.id);
      if (x.status === 'canceled') throw E.conflict('order_group_inactive', PS('error.group_inactive', { status: x.status }));
      db.prepare("UPDATE perp_order_groups SET filled=0, status='active', status_reason=NULL, triggered_ts=NULL, updated_ts=? WHERE id=?").run(Date.now(), x.id);
      return groupRow(x.id);
    });
    emitEvent(uid, 'perp_order_group', groupVo(g));
    res.json({ order_group: groupVo(g) });
  });

  // ---- positions
  v1.get(`${P}/positions`, requireUser, (req, res) => {
    const args = [uidOf(req)]; let extra = '';
    if (req.query.ticker) { extra += ' AND ticker=?'; args.push(String(req.query.ticker).toUpperCase()); }
    if (qSub(req) != null) { extra += ' AND subaccount=?'; args.push(qSub(req)); }
    res.json({ positions: db.prepare(`SELECT * FROM perp_positions WHERE user_id=? AND qty<>0${extra} ORDER BY updated_ts DESC`).all(...args).map((p) => positionVo(p)) });
  });
  v1.post(`${P}/positions/:ticker/close`, requireUser, (req, res) => {
    const uid = uidOf(req);
    const m = mustMarket(req.params.ticker);
    const sub = parseSub(req.body && req.body.subaccount);
    const p = position(uid, sub, m.ticker);
    if (!p || p.qty === 0) throw E.conflict('no_position', 'no open position in this market');
    const pct = req.body && req.body.percent != null ? Number(req.body.percent) : 100;
    if (!(pct > 0 && pct <= 100)) throw E.badRequest('percent must be between 0 and 100');
    const aq = Math.abs(p.qty);
    let count = pct >= 100 ? aq : Math.floor((aq * pct) / 100);
    if (pct < 100 && !m.fractional_trading_enabled) count = Math.floor(count / UNITS) * UNITS;
    count = Math.max(Math.min(aq, m.fractional_trading_enabled ? 1 : UNITS), count);
    const o = placeOrder(uid, { ticker: m.ticker, side: p.qty > 0 ? 'ask' : 'bid', type: 'market', reduce_only: true, subaccount: sub }, { source: 'user', units: count });
    res.json({ order: orderVo(o) });
  });

  v1.get(`${P}/fills`, requireUser, (req, res) => {
    const args = [uidOf(req)]; let extra = '';
    if (req.query.ticker) { extra += ' AND ticker=?'; args.push(String(req.query.ticker).toUpperCase()); }
    if (qSub(req) != null) { extra += ' AND subaccount=?'; args.push(qSub(req)); }
    const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 100) | 0));
    res.json({ fills: db.prepare(`SELECT * FROM perp_fills WHERE user_id=?${extra} ORDER BY created_ts DESC, rowid DESC LIMIT ?`).all(...args, limit).map(fillVo), cursor: '' });
  });
  v1.get(`${P}/funding_history`, requireUser, (req, res) => {
    const args = [uidOf(req)]; const where = ['user_id=?'];
    if (req.query.ticker) { where.push('ticker=?'); args.push(String(req.query.ticker).toUpperCase()); }
    if (req.query.start_date) { where.push('funding_ts>=?'); args.push(Date.parse(`${req.query.start_date}T00:00:00Z`)); }
    if (req.query.end_date) { where.push('funding_ts<?'); args.push(Date.parse(`${req.query.end_date}T00:00:00Z`) + DAY); }
    if (qSub(req) != null) { where.push('subaccount=?'); args.push(qSub(req)); }
    res.json({ funding_history: db.prepare(`SELECT * FROM perp_funding_payments WHERE ${where.join(' AND ')} ORDER BY funding_ts DESC, rowid DESC LIMIT 500`).all(...args).map(fundingPayVo) });
  });
  v1.get(`${P}/liquidations`, requireUser, (req, res) => res.json({ liquidations: db.prepare('SELECT * FROM perp_liquidations WHERE user_id=? ORDER BY created_ts DESC LIMIT 200').all(uidOf(req)).map(liqVo) }));
  v1.get(`${P}/ledger`, requireUser, (req, res) => res.json({ entries: db.prepare('SELECT * FROM perp_ledger WHERE user_id=? ORDER BY created_ts DESC, rowid DESC LIMIT 500').all(uidOf(req)).map((l) => ({ id: l.id, kind: l.kind, subaccount: l.subaccount, amount_dollars: cc$(l.amount_cc), ticker: l.ticker, memo: l.memo, created_time: new Date(l.created_ts).toISOString() })) }));
  v1.get(`${P}/risk`, requireUser, (req, res) => {
    const uid = uidOf(req);
    let tn = 0; let tm = 0;
    const subs = subsOf(uid).map((n) => {
      const r = subRisk(uid, n);
      const mode = modeOf(uid, n);
      return { subaccount: n, subaccount_type: mode, is_portfolio: mode === 'cross', account_equity: cc$(r.equity), maintenance_margin: cc$(r.mm), initial_margin: cc$(r.im), margin_ratio: r.mm ? Number((r.equity / r.mm).toFixed(4)) : null };
    });
    const positions = db.prepare('SELECT * FROM perp_positions WHERE user_id=? AND qty<>0').all(uid).map((p) => {
      const m = getMarket(p.ticker); const mark = markCc(m);
      const notional = notionalCc(p.qty, mark); const mm = mmOf(m, p.qty, mark);
      tn += notional; tm += mm;
      const upnl = upnlCc(p, mark);
      const mode = modeOf(uid, p.subaccount);
      return { subaccount: p.subaccount, subaccount_type: mode, market_ticker: p.ticker, position: ufp(p.qty), mark_price: cc$(mark), position_notional: cc$(notional), maintenance_margin_required: cc$(mm), initial_margin_required: cc$(imOf(m, p.qty, mark)), margin_tier: R.tierOf(tiersOf(m.ticker), notional), position_leverage: mm ? Number((notional / mm).toFixed(4)) : null, effective_leverage: p.margin_cc + upnl > 0 ? Number((notional / (p.margin_cc + upnl)).toFixed(4)) : null, margin_ratio: mm ? Number(((p.margin_cc + upnl) / mm).toFixed(4)) : null, estimated_liquidation_price: cc$(liqPriceOf(p, m, mode)), is_portfolio: mode === 'cross' };
    });
    res.json({ account_leverage: tm ? Number((tn / tm).toFixed(4)) : null, total_position_notional: cc$(tn), total_maintenance_margin: cc$(tm), subaccounts: subs, positions });
  });

  // Exit triggers: bracket TP/SL and trailing stops, per position; evaluated against the mark every tick.
  v1.get(`${P}/exit_triggers`, requireUser, (req, res) => {
    const args = [uidOf(req)]; let extra = '';
    if (req.query.status) { extra = ' AND status=?'; args.push(String(req.query.status)); }
    res.json({ exit_triggers: db.prepare(`SELECT * FROM perp_exit_triggers WHERE user_id=?${extra} ORDER BY created_ts DESC LIMIT 200`).all(...args).map(triggerVo) });
  });
  v1.put(`${P}/positions/:ticker/exit_trigger`, requireUser, (req, res) => {
    const uid = uidOf(req);
    const m = mustMarket(req.params.ticker);
    const b = req.body || {};
    const sub = parseSub(b.subaccount);
    const p = position(uid, sub, m.ticker);
    if (!p || p.qty === 0) throw E.conflict('no_position', 'exit triggers require an open position');
    const kind = b.kind == null ? 'bracket' : String(b.kind).toLowerCase();
    if (!['bracket', 'trailing'].includes(kind)) throw E.badRequest(PS('error.trigger_kind'));
    const mark = markCc(m); const long = p.qty > 0;
    const count = b.count != null && b.count !== '' ? Math.min(Math.abs(p.qty), parseUnits(b, 'count')) : 0;
    let cols;
    if (kind === 'trailing') {
      let bps = null; let trail = null;
      if (b.trail_percent != null && b.trail_percent !== '') {
        const pct = Number(b.trail_percent);
        if (!(pct >= 0.1 && pct <= 50)) throw E.badRequest(PS('error.trailing_percent'));
        bps = Math.round(pct * 100);
      } else if (b.trail_amount != null && b.trail_amount !== '') {
        const n = Number(b.trail_amount);
        if (!(n > 0)) throw E.badRequest(PS('error.trailing_args'));
        trail = Math.max(1, Math.round(n * CC));
        if (trail >= mark) throw E.badRequest(PS('error.trailing_args'));
      } else throw E.badRequest(PS('error.trailing_args'));
      const dist = trail != null ? trail : Math.max(1, Math.round((mark * bps) / 10000));
      cols = { trail_cc: trail, trail_bps: bps, watermark_cc: mark, stop_cc: long ? mark - dist : mark + dist };
    } else {
      const parse = (v, name) => { if (v == null || v === '') return null; const n = Number(v); if (!(n > 0)) throw E.badRequest(`${name} must be strictly positive`); return Math.round(n * CC); };
      const tp = parse(b.take_profit_price, 'take_profit_price');
      const sl = parse(b.stop_loss_price, 'stop_loss_price');
      if (tp == null && sl == null) throw E.badRequest('supply take_profit_price and/or stop_loss_price (use DELETE to cancel)');
      if (tp != null && (long ? tp <= mark : tp >= mark)) throw E.badRequest(`take profit must be ${long ? 'above' : 'below'} the mark price (${fmtUnderlying(m, mark)})`);
      if (sl != null && (long ? sl >= mark : sl <= mark)) throw E.badRequest(`stop loss must be ${long ? 'below' : 'above'} the mark price (${fmtUnderlying(m, mark)})`);
      cols = { take_profit_cc: tp, stop_loss_cc: sl };
    }
    const now = Date.now();
    const t = tx(db, () => {
      db.prepare("UPDATE perp_exit_triggers SET status='canceled', status_reason='user_canceled', updated_ts=? WHERE user_id=? AND subaccount=? AND ticker=? AND kind=? AND status='active'").run(now, uid, sub, m.ticker, kind);
      const id = newId('xt_');
      db.prepare("INSERT INTO perp_exit_triggers(id,user_id,ticker,kind,status,stop_loss_cc,take_profit_cc,count,created_ts,updated_ts,subaccount,trail_cc,trail_bps,watermark_cc,stop_cc) VALUES(?,?,?,?,'active',?,?,?,?,?,?,?,?,?,?)")
        .run(id, uid, m.ticker, kind, cols.stop_loss_cc ?? null, cols.take_profit_cc ?? null, count, now, now, sub, cols.trail_cc ?? null, cols.trail_bps ?? null, cols.watermark_cc ?? null, cols.stop_cc ?? null);
      return db.prepare('SELECT * FROM perp_exit_triggers WHERE id=?').get(id);
    });
    emitUser(uid, [m.ticker]);
    res.json(triggerVo(t));
  });
  v1.delete(`${P}/positions/:ticker/exit_trigger`, requireUser, (req, res) => {
    const uid = uidOf(req);
    const m = mustMarket(req.params.ticker);
    const kind = req.query.kind ? String(req.query.kind) : 'bracket';
    const t = activeTrigger(uid, qSub(req) ?? 0, m.ticker, kind);
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

  // Margin tiers (Admin › Perps ops, server/perps-ops.js): replaces a market's tiers; tier 1 sets max leverage.
  function setTiers(ticker, tiers) {
    const m = mustMarket(ticker);
    tx(db, () => {
      db.prepare('DELETE FROM perp_margin_tiers WHERE ticker=?').run(m.ticker);
      const ins = db.prepare('INSERT INTO perp_margin_tiers(ticker,tier,max_notional_cc,initial_rate,maintenance_rate) VALUES(?,?,?,?,?)');
      for (const t of tiers) ins.run(m.ticker, t.tier, t.max_notional_cc, t.initial_rate, t.maintenance_rate);
      db.prepare('UPDATE perp_markets SET max_leverage=?, im_multiplier=? WHERE ticker=?').run(Number((1 / tiers[0].initial_rate).toFixed(4)), Number((tiers[0].initial_rate / tiers[0].maintenance_rate).toFixed(6)), m.ticker);
    });
    tierCache.delete(m.ticker);
    emitTicker(getMarket(m.ticker), true);
    return tiersOf(m.ticker);
  }
  // The legacy max-leverage control (Admin › Perps ops) rescales the tiers so tier 1 matches.
  function setMaxLeverage(ticker, lev) {
    const m = mustMarket(ticker);
    const k = m.max_leverage / lev;
    const scaled = tiersOf(m.ticker).map((t) => ({ ...t, initial_rate: Number(Math.min(1, t.initial_rate * k).toFixed(6)), maintenance_rate: Number(Math.min(0.999, t.maintenance_rate * k).toFixed(6)) }));
    return setTiers(m.ticker, scaled);
  }

  const api = {
    tick, setIndex, runFunding: (t) => runFunding(mustMarket(t)), bookMsg, placeOrder, cancelOrder, amendOrder, decreaseOrder, balanceVo, markCc: (t) => markCc(mustMarket(t)), market: (t) => getMarket(t),
    creditCollateral, account, subsOf, availOf, subInfo, tiersOf, setTiers, setMaxLeverage, tierVo, riskSettings, emitUser, emitEvent, fillHooks, tickHooks, positionVo, orderVo,
    lpId: () => LP, audit: (mainGot) => PL.audit(db, { mainGot, lpId: LP }), checkCross, UNITS, CC,
  };
  engine.perps = api;
  INSTANCES.set(db, api);
  installAuditHook();
  return api;
}

// The perps journal audit joins the main ledger audit (journal.audit → Admin › Payments, the audit job, tests). One
// registration per process; each call is routed to the instance of its database (a test may restart on the same file).
const INSTANCES = new WeakMap();
let auditHooked = false;
function installAuditHook() {
  if (auditHooked) return;
  auditHooked = true;
  journal.hooks.auditChecks.push((db, got) => {
    if (!INSTANCES.has(db)) return [];
    const r = PL.audit(db, { mainGot: got });
    return r.problems.map((p) => ({ ...p, expected_cents: p.expected_cc != null ? p.expected_cc / 100 : p.expected_ucc != null ? p.expected_ucc / 10000 : 0, actual_cents: p.actual_cc != null ? p.actual_cc / 100 : p.actual_ucc != null ? p.actual_ucc / 10000 : 0 }));
  });
}

module.exports = { mountPerps, MARKETS, fillMath };
