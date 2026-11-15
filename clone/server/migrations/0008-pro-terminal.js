'use strict';
// Migration 0008 — Pro trading terminal (owner design 2026-11-15, CLONE_SPEC.md §15.6). Self-contained: it references no
// other new migration.
//   pro_screens     a member's saved screener filters ("screens"), by name; at most 50 per member (server/pro.js)
//   pro_prefs       a member's terminal preferences: the panel layout (order, hidden panels, chart timeframe, screener
//                   sort), the active screen, and one-click trading (off by default; switching it on records when the
//                   member confirmed it)
//   market_candles  OHLC + volume per market, period and bucket, kept by triggers on `trades` the way migration 0004 keeps
//                   the running volume, so the candles endpoint reads a bounded index range and never the market's whole
//                   history: hourly (period_s 3600) and daily (86400) UTC buckets. Prices are YES prices in centi-cents,
//                   volume in units (hundredths of a contract). Open = the first trade of the bucket (time, then insert
//                   order), close = the last one.
// Every writer of `trades` is covered in the same transaction: an insert adds to its buckets (a row written without a cc
// price, by integer-cent writers such as seed data and simulated sports prints, is counted when the cc trigger fills the
// price in). An update or a delete takes the old row out of its bucket's volume and trade count in O(1) and marks the
// bucket `dirty`: its open / high / low / close can no longer be kept incrementally, so the candles reader recomputes a
// dirty bucket from `trades` (one hour or one day of one market, indexed) — a delete never rescans per deleted row.
// Existing trades are counted once, before the triggers exist.
const PERIODS = [[3600, 3600000], [86400, 86400000]];
const COLS = 'market_ticker, period_s, bucket_ts, open_cc, high_cc, low_cc, close_cc, open_ts, close_ts, volume_units, trades';

// Incremental: the row R (NEW) joins its bucket.
const addRow = (ps, p) => `
  INSERT INTO market_candles(${COLS}) VALUES (NEW.market_ticker, ${ps}, (NEW.created_ts / ${p}) * ${p}, NEW.yes_price_cc, NEW.yes_price_cc, NEW.yes_price_cc, NEW.yes_price_cc, NEW.created_ts, NEW.created_ts, NEW.count, 1)
    ON CONFLICT(market_ticker, period_s, bucket_ts) DO UPDATE SET
      open_cc = CASE WHEN excluded.open_ts < open_ts THEN excluded.open_cc ELSE open_cc END,
      open_ts = MIN(open_ts, excluded.open_ts),
      close_cc = CASE WHEN excluded.close_ts >= close_ts THEN excluded.close_cc ELSE close_cc END,
      close_ts = MAX(close_ts, excluded.close_ts),
      high_cc = MAX(high_cc, excluded.high_cc),
      low_cc = MIN(low_cc, excluded.low_cc),
      volume_units = volume_units + excluded.volume_units,
      trades = trades + 1;`;

// The row OLD leaves its bucket: volume and count drop, the bucket is marked dirty, an emptied bucket goes.
const removeRow = (ps, p) => {
  const where = `market_ticker = OLD.market_ticker AND period_s = ${ps} AND bucket_ts = (OLD.created_ts / ${p}) * ${p}`;
  return `
  UPDATE market_candles SET volume_units = volume_units - OLD.count, trades = trades - 1, dirty = 1 WHERE ${where};
  DELETE FROM market_candles WHERE ${where} AND trades <= 0;`;
};
// A changed row (not the cc fill of a new row) re-enters marked dirty.
const markNew = (ps, p) => `
  UPDATE market_candles SET dirty = 1 WHERE market_ticker = NEW.market_ticker AND period_s = ${ps} AND bucket_ts = (NEW.created_ts / ${p}) * ${p};`;

const backfill = (ps, p) => `
INSERT INTO market_candles(${COLS})
  SELECT market_ticker, ${ps}, b, MAX(o), MAX(px), MIN(px), MAX(c), MIN(ts), MAX(ts), SUM(n), COUNT(*) FROM (
    SELECT market_ticker, (created_ts / ${p}) * ${p} b, yes_price_cc px, created_ts ts, count n,
      FIRST_VALUE(yes_price_cc) OVER (PARTITION BY market_ticker, (created_ts / ${p}) * ${p} ORDER BY created_ts, rowid) o,
      FIRST_VALUE(yes_price_cc) OVER (PARTITION BY market_ticker, (created_ts / ${p}) * ${p} ORDER BY created_ts DESC, rowid DESC) c
    FROM trades WHERE yes_price_cc IS NOT NULL)
  GROUP BY market_ticker, b;`;

const SQL = `
CREATE TABLE IF NOT EXISTS pro_screens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  filters_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, name)
);
CREATE TABLE IF NOT EXISTS pro_prefs (
  user_id TEXT PRIMARY KEY,
  one_click INTEGER NOT NULL DEFAULT 0,
  one_click_confirmed_at TEXT,
  layout_json TEXT,
  active_screen_id TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS market_candles (
  market_ticker TEXT NOT NULL,
  period_s INTEGER NOT NULL,
  bucket_ts INTEGER NOT NULL,
  open_cc INTEGER NOT NULL,
  high_cc INTEGER NOT NULL,
  low_cc INTEGER NOT NULL,
  close_cc INTEGER NOT NULL,
  open_ts INTEGER NOT NULL,
  close_ts INTEGER NOT NULL,
  volume_units INTEGER NOT NULL DEFAULT 0,
  trades INTEGER NOT NULL DEFAULT 0,
  dirty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (market_ticker, period_s, bucket_ts)
) WITHOUT ROWID;
DELETE FROM market_candles;
${PERIODS.map(([ps, p]) => backfill(ps, p)).join('\n')}
DROP TRIGGER IF EXISTS trg_trades_candles_ins; DROP TRIGGER IF EXISTS trg_trades_candles_upd_old; DROP TRIGGER IF EXISTS trg_trades_candles_upd_new; DROP TRIGGER IF EXISTS trg_trades_candles_del;
CREATE TRIGGER trg_trades_candles_ins AFTER INSERT ON trades WHEN NEW.yes_price_cc IS NOT NULL BEGIN${PERIODS.map(([ps, p]) => addRow(ps, p)).join('')}
END;
CREATE TRIGGER trg_trades_candles_upd_old AFTER UPDATE OF yes_price_cc, count, created_ts, market_ticker ON trades WHEN OLD.yes_price_cc IS NOT NULL BEGIN${PERIODS.map(([ps, p]) => removeRow(ps, p)).join('')}
END;
CREATE TRIGGER trg_trades_candles_upd_new AFTER UPDATE OF yes_price_cc, count, created_ts, market_ticker ON trades WHEN NEW.yes_price_cc IS NOT NULL BEGIN${PERIODS.map(([ps, p]) => addRow(ps, p)).join('')}${PERIODS.map(([ps, p]) => markNew(ps, p).replace('WHERE', 'WHERE OLD.yes_price_cc IS NOT NULL AND')).join('')}
END;
CREATE TRIGGER trg_trades_candles_del AFTER DELETE ON trades WHEN OLD.yes_price_cc IS NOT NULL BEGIN${PERIODS.map(([ps, p]) => removeRow(ps, p)).join('')}
END;
`;

module.exports = {
  id: 8,
  name: 'pro-terminal',
  up(db) { db.exec(SQL); },
  SQL,
};
