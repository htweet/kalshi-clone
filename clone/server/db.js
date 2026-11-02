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
  if (!oc.has('order_type')) { db.exec("ALTER TABLE orders ADD COLUMN order_type TEXT NOT NULL DEFAULT 'limit'"); db.exec("UPDATE orders SET order_type='market' WHERE time_in_force='ioc'"); }
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

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  migrate(db);
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
