'use strict';
// SQLite persistence layer (node:sqlite). Every piece of user-visible state lives here.
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_system INTEGER NOT NULL DEFAULT 0,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS series (
  ticker TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  category TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  frequency TEXT NOT NULL DEFAULT 'custom',
  fee_type TEXT NOT NULL DEFAULT 'quadratic',
  fee_multiplier REAL NOT NULL DEFAULT 1,
  settlement_sources TEXT NOT NULL DEFAULT '[]',
  rules TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS events (
  ticker TEXT PRIMARY KEY,
  series_ticker TEXT NOT NULL REFERENCES series(ticker),
  title TEXT NOT NULL,
  sub_title TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  mutually_exclusive INTEGER NOT NULL DEFAULT 0,
  is_live INTEGER NOT NULL DEFAULT 0,
  live_label TEXT NOT NULL DEFAULT '',
  news TEXT NOT NULL DEFAULT '',
  featured INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS markets (
  ticker TEXT PRIMARY KEY,
  event_ticker TEXT NOT NULL REFERENCES events(ticker),
  title TEXT NOT NULL,
  yes_sub_title TEXT NOT NULL,
  no_sub_title TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#5b5bd6',
  status TEXT NOT NULL,              -- initialized|active|inactive|closed|determined|finalized
  result TEXT NOT NULL DEFAULT '',   -- ''|yes|no
  open_time TEXT NOT NULL,
  close_time TEXT NOT NULL,
  expected_expiration_time TEXT NOT NULL,
  settlement_timer_seconds INTEGER NOT NULL DEFAULT 5,
  determined_at TEXT,
  settled_at TEXT,
  rules_primary TEXT NOT NULL DEFAULT '',
  can_close_early INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_markets_event ON markets(event_ticker);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  market_ticker TEXT NOT NULL REFERENCES markets(ticker),
  side TEXT NOT NULL,                -- yes|no  (always a buy of that side)
  price_cents INTEGER NOT NULL,      -- limit, 1..99
  initial_count INTEGER NOT NULL,
  remaining_count INTEGER NOT NULL,
  filled_count INTEGER NOT NULL DEFAULT 0,
  reserved_cents INTEGER NOT NULL DEFAULT 0,
  fees_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,              -- resting|executed|canceled
  time_in_force TEXT NOT NULL DEFAULT 'gtc',
  client_order_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_book ON orders(market_ticker, status, side, price_cents, seq);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, status);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  market_ticker TEXT NOT NULL REFERENCES markets(ticker),
  yes_price_cents INTEGER NOT NULL,
  count INTEGER NOT NULL,
  taker_side TEXT NOT NULL,
  created_ts INTEGER NOT NULL        -- unix ms
);
CREATE INDEX IF NOT EXISTS idx_trades_market ON trades(market_ticker, created_ts);

CREATE TABLE IF NOT EXISTS fills (
  id TEXT PRIMARY KEY,
  trade_id TEXT NOT NULL REFERENCES trades(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  market_ticker TEXT NOT NULL,
  side TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  count INTEGER NOT NULL,
  is_taker INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL,
  created_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fills_user ON fills(user_id, created_ts);

CREATE TABLE IF NOT EXISTS positions (
  user_id TEXT NOT NULL REFERENCES users(id),
  market_ticker TEXT NOT NULL REFERENCES markets(ticker),
  yes_count INTEGER NOT NULL DEFAULT 0,
  no_count INTEGER NOT NULL DEFAULT 0,
  yes_cost_cents INTEGER NOT NULL DEFAULT 0,
  no_cost_cents INTEGER NOT NULL DEFAULT 0,
  realized_pnl_cents INTEGER NOT NULL DEFAULT 0,
  fees_paid_cents INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, market_ticker)
);

CREATE TABLE IF NOT EXISTS settlements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  market_ticker TEXT NOT NULL,
  result TEXT NOT NULL,
  yes_count INTEGER NOT NULL,
  no_count INTEGER NOT NULL,
  payout_cents INTEGER NOT NULL,
  cost_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,                -- deposit|withdrawal|trade|fee|refund|netting|settlement
  amount_cents INTEGER NOT NULL,
  ref TEXT,
  memo TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, created_at);

CREATE TABLE IF NOT EXISTS watchlist (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_ticker TEXT NOT NULL REFERENCES events(ticker),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, event_ticker)
);

CREATE TABLE IF NOT EXISTS recently_visited (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_ticker TEXT NOT NULL REFERENCES events(ticker),
  visited_at TEXT NOT NULL,
  PRIMARY KEY (user_id, event_ticker)
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Social (spec §13.6): public profile, posts, comments, likes, bookmarks, follows.
CREATE TABLE IF NOT EXISTS social_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  nickname TEXT NOT NULL UNIQUE COLLATE NOCASE,
  bio TEXT NOT NULL DEFAULT '',
  share_trades INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_ticker TEXT REFERENCES events(ticker),
  body TEXT NOT NULL,
  created_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_ts ON posts(created_ts);
CREATE TABLE IF NOT EXISTS post_likes (post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY (post_id, user_id));
CREATE TABLE IF NOT EXISTS post_bookmarks (post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY (post_id, user_id));
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS follows (follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, followee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY (follower_id, followee_id));

-- Notifications and custom price targets (spec §13.7).
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  read_at TEXT,
  created_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_ts);
CREATE TABLE IF NOT EXISTS price_targets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  market_ticker TEXT NOT NULL REFERENCES markets(ticker),
  direction TEXT NOT NULL,           -- above|below (YES price)
  price_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  triggered_at TEXT
);

-- Account controls (spec §13.8): limits with a 24 h cooling-off period for loosening.
CREATE TABLE IF NOT EXISTS user_limits (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                -- deposit|trading|session
  value INTEGER,                     -- cents per day (deposit/trading) or minutes per day (session); NULL = none
  pending_value INTEGER,
  pending_set INTEGER NOT NULL DEFAULT 0,
  pending_effective_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, kind)
);
CREATE TABLE IF NOT EXISTS session_usage (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,
  last_seen_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);

-- Two-factor login (spec §13.9): TOTP authenticator codes.
CREATE TABLE IF NOT EXISTS mfa (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mfa_challenges (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL
);
`;

// Idempotent upgrades for databases created by earlier builds (spec §16.6).
const QTY_UNITS_KEY = 'qty_units_v1';
function migrate(db) {
  const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
  const m = cols('markets');
  if (!m.has('fractional_trading_enabled')) {
    db.exec('ALTER TABLE markets ADD COLUMN fractional_trading_enabled INTEGER NOT NULL DEFAULT 1');
    // Design choice (spec §16.3): Harbor State election markets stay whole-contract.
    db.exec("UPDATE markets SET fractional_trading_enabled=0 WHERE event_ticker IN (SELECT ticker FROM events WHERE series_ticker='PLXSTATE')");
  }
  if (!m.has('mve_collection_ticker')) db.exec('ALTER TABLE markets ADD COLUMN mve_collection_ticker TEXT');
  if (!m.has('mve_selected_legs')) db.exec('ALTER TABLE markets ADD COLUMN mve_selected_legs TEXT');
  const oc = cols('orders');
  if (!oc.has('source')) db.exec("ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT 'user'");
  // What the user asked for (History, spec §17.9): sells are stored as buys of the other side.
  if (!oc.has('action')) db.exec("ALTER TABLE orders ADD COLUMN action TEXT NOT NULL DEFAULT 'buy'");
  if (!oc.has('expiration_ts')) db.exec('ALTER TABLE orders ADD COLUMN expiration_ts INTEGER'); // good-til-time (unix ms), NULL = GTC
  if (!oc.has('cancel_reason')) db.exec('ALTER TABLE orders ADD COLUMN cancel_reason TEXT');
  if (!oc.has('order_type')) { db.exec("ALTER TABLE orders ADD COLUMN order_type TEXT NOT NULL DEFAULT 'limit'"); db.exec("UPDATE orders SET order_type='market' WHERE time_in_force='ioc'"); }
  migratePhase5a(db, cols);
  // One-time switch of every event-contract quantity from whole contracts to hundredths ("units").
  if (!db.prepare('SELECT 1 FROM meta WHERE key=?').get(QTY_UNITS_KEY)) {
    tx(db, () => {
      db.exec(`UPDATE orders SET initial_count=initial_count*100, remaining_count=remaining_count*100, filled_count=filled_count*100;
        UPDATE trades SET count=count*100; UPDATE fills SET count=count*100;
        UPDATE positions SET yes_count=yes_count*100, no_count=no_count*100;
        UPDATE settlements SET yes_count=yes_count*100, no_count=no_count*100;`);
      db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(QTY_UNITS_KEY, new Date().toISOString());
    });
  }
}

// Phase 5A (CLONE_SPEC.md §28.9): price grids, centi-cent prices, the fee accumulator, scalar markets, settlement
// corrections and flip sells. Additive columns only; `price_cents` columns stay as the whole-cent view of `price_cc`
// (rounded) for readers that only need a label, and triggers fill `*_cc` for rows written by integer-cent writers
// (seed data, simulated sports prints).
const PRICE_CC_KEY = 'price_cc_v1';
function migratePhase5a(db, cols) {
  const add = (t, c, def) => { if (!cols(t).has(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
  add('markets', 'price_level_structure', "TEXT NOT NULL DEFAULT 'linear_cent'");
  add('markets', 'market_type', "TEXT NOT NULL DEFAULT 'binary'");
  add('markets', 'floor_strike', 'REAL');
  add('markets', 'cap_strike', 'REAL');
  add('markets', 'scalar_unit', "TEXT NOT NULL DEFAULT ''");
  add('markets', 'expiration_value', 'REAL');
  add('markets', 'settlement_value_cc', 'INTEGER');
  add('orders', 'price_cc', 'INTEGER');
  add('orders', 'fee_micro', 'INTEGER NOT NULL DEFAULT 0');
  add('orders', 'flip_units', 'INTEGER NOT NULL DEFAULT 0');
  add('trades', 'yes_price_cc', 'INTEGER');
  add('fills', 'price_cc', 'INTEGER');
  add('fills', 'fee_micro', 'INTEGER NOT NULL DEFAULT 0');
  add('settlements', 'settlement_value_cc', 'INTEGER');
  add('settlements', 'effective_payout_cents', 'INTEGER');
  add('settlements', 'corrected_at', 'TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_book_cc ON orders(market_ticker, status, side, price_cc, seq);
    CREATE TRIGGER IF NOT EXISTS trg_orders_price_cc AFTER INSERT ON orders WHEN NEW.price_cc IS NULL BEGIN UPDATE orders SET price_cc = NEW.price_cents * 100 WHERE id = NEW.id; END;
    CREATE TRIGGER IF NOT EXISTS trg_trades_price_cc AFTER INSERT ON trades WHEN NEW.yes_price_cc IS NULL BEGIN UPDATE trades SET yes_price_cc = NEW.yes_price_cents * 100 WHERE id = NEW.id; END;
    CREATE TRIGGER IF NOT EXISTS trg_fills_price_cc AFTER INSERT ON fills WHEN NEW.price_cc IS NULL BEGIN UPDATE fills SET price_cc = NEW.price_cents * 100 WHERE id = NEW.id; END;
    CREATE TRIGGER IF NOT EXISTS trg_settlements_eff AFTER INSERT ON settlements WHEN NEW.effective_payout_cents IS NULL BEGIN UPDATE settlements SET effective_payout_cents = NEW.payout_cents WHERE id = NEW.id; END;`);
  // Backfill rows written before this build (idempotent: only NULLs are filled).
  db.exec(`UPDATE orders SET price_cc = price_cents * 100 WHERE price_cc IS NULL;
    UPDATE trades SET yes_price_cc = yes_price_cents * 100 WHERE yes_price_cc IS NULL;
    UPDATE fills SET price_cc = price_cents * 100 WHERE price_cc IS NULL;
    UPDATE settlements SET effective_payout_cents = payout_cents WHERE effective_payout_cents IS NULL;
    UPDATE markets SET settlement_value_cc = CASE result WHEN 'yes' THEN 10000 WHEN 'no' THEN 0 END WHERE settlement_value_cc IS NULL AND result IN ('yes','no');`);
  // Fees charged before the accumulator existed count as exact (no rounding residual to carry).
  if (!db.prepare('SELECT 1 FROM meta WHERE key=?').get(PRICE_CC_KEY)) {
    db.exec('UPDATE orders SET fee_micro = fees_cents * 10000 WHERE fee_micro = 0 AND fees_cents > 0; UPDATE fills SET fee_micro = fee_cents * 10000 WHERE fee_micro = 0 AND fee_cents > 0;');
    db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING').run(PRICE_CC_KEY, new Date().toISOString());
  }
}

// One server per database file. A second process (e.g. a second `npm start` that fell back to port 3001)
// would otherwise contend for SQLite's write lock and fail with "database is locked".
//
// Ownership is an operating-system file lock, not a process id: `<db>.instance` is a small SQLite file on which the
// owner holds an EXCLUSIVE transaction for its whole life. The OS drops that lock when the process ends for any
// reason (Ctrl+C, crash, closed terminal, reboot), so a leftover file never blocks the next start. A pid check alone
// misfires after a crash because process ids are reused (on Windows a low id such as 492 is soon a system service).
// `<db>.lock` only records the owner's pid for the error message; it never decides anything.
const lockBusy = (e) => e && (e.errcode === 5 || e.errcode === 6 || /database is locked|database table is locked|SQLITE_BUSY/i.test(e.message || ''));
function acquireLock(file) {
  const info = `${file}.lock`;
  const instFile = `${file}.instance`;
  let inst = null;
  for (let attempt = 0; ; attempt++) {
    try {
      inst = new DatabaseSync(instFile); // no busy timeout: a held lock answers at once
      inst.exec('PRAGMA locking_mode = EXCLUSIVE');
      inst.exec('BEGIN EXCLUSIVE');
      break;
    } catch (e) {
      try { inst?.close(); } catch { /* ignore */ }
      inst = null;
      if (lockBusy(e)) {
        let other = 0;
        try { other = Number(fs.readFileSync(info, 'utf8').trim()) || 0; } catch { /* no info file */ }
        const who = other ? `Another Parlance server (process ${other})` : 'Another Parlance server';
        const err = new Error(`${who} is already using ${file}. Stop it first (Ctrl+C in its terminal, or end that node process), or start this one with a different DB_FILE.`);
        err.code = 'DB_IN_USE';
        throw err;
      }
      // Not a lock file we can use (e.g. damaged): replace it once, then give up with the real error.
      if (attempt === 0) { try { fs.unlinkSync(instFile); } catch { /* ignore */ } continue; }
      throw e;
    }
  }
  try { fs.writeFileSync(info, String(process.pid)); } catch { /* informational only */ }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener('exit', release);
    try { if (Number(fs.readFileSync(info, 'utf8').trim()) === process.pid) fs.unlinkSync(info); } catch { /* already gone */ }
    // The instance file stays: deleting it would let a waiting process lock a different file than the next one.
    try { inst.exec('ROLLBACK'); } catch { /* ignore */ }
    try { inst.close(); } catch { /* ignore */ }
  };
  process.once('exit', release);
  return release;
}

function open(file) {
  let release = null;
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    release = acquireLock(file);
  }
  let db;
  try {
    db = new DatabaseSync(file);
    // Wait up to 5 s for a competing writer instead of failing immediately with SQLITE_BUSY.
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(SCHEMA);
    migrate(db);
  } catch (e) {
    try { db?.close(); } catch { /* ignore */ }
    if (release) release();
    throw e;
  }
  if (release) {
    const close = db.close.bind(db);
    db.close = () => { try { close(); } finally { release(); } };
  }
  return db;
}

// Run fn inside a single IMMEDIATE transaction; nested calls join the outer one.
function tx(db, fn) {
  if (db.__inTx) return fn();
  db.exec('BEGIN IMMEDIATE');
  db.__inTx = true;
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    db.__inTx = false;
  }
}

module.exports = { open, tx, migrate, QTY_UNITS_KEY };
