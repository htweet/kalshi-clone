'use strict';
// Migration 0004 — running market volume (soak finding 2026-11-13, CLONE_SPEC.md §39.20). engine.quote() runs after every
// order (the ticker message) and summed every trade of the market for its volume, dollar volume and 24-hour volume: the
// work per order grew with the market's history, and a one-hour soak at 40 orders/s slowed from 155 ms to 2.5 s per order.
// The totals are now kept as trades are written, by triggers on `trades` (every writer — the engine, simulations, seeds,
// hubs, elections, migrations — is covered in the same transaction):
//   market_volume         per market: units traded and dollar volume (count × YES price in centi-cents)
//   market_volume_hourly  per market and UTC hour: units traded, for the rolling 24-hour volume (the oldest, partial
//                         hour is read from `trades` itself, at most one hour of rows, so the figure stays exact)
// Existing trades are counted once, before the triggers exist.
const SQL = `
CREATE TABLE IF NOT EXISTS market_volume (market_ticker TEXT PRIMARY KEY, volume_units INTEGER NOT NULL DEFAULT 0, dollar_volume_cc INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS market_volume_hourly (market_ticker TEXT NOT NULL, hour_ts INTEGER NOT NULL, volume_units INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (market_ticker, hour_ts));
DELETE FROM market_volume; DELETE FROM market_volume_hourly;
INSERT INTO market_volume(market_ticker, volume_units, dollar_volume_cc)
  SELECT market_ticker, COALESCE(SUM(count),0), COALESCE(SUM(count * yes_price_cc),0) FROM trades GROUP BY market_ticker;
INSERT INTO market_volume_hourly(market_ticker, hour_ts, volume_units)
  SELECT market_ticker, (created_ts / 3600000) * 3600000, COALESCE(SUM(count),0) FROM trades GROUP BY market_ticker, (created_ts / 3600000) * 3600000;
DROP TRIGGER IF EXISTS trg_trades_volume_ins; DROP TRIGGER IF EXISTS trg_trades_volume_del; DROP TRIGGER IF EXISTS trg_trades_volume_upd;
CREATE TRIGGER trg_trades_volume_ins AFTER INSERT ON trades BEGIN
  INSERT INTO market_volume(market_ticker, volume_units, dollar_volume_cc) VALUES (NEW.market_ticker, NEW.count, NEW.count * COALESCE(NEW.yes_price_cc, 0))
    ON CONFLICT(market_ticker) DO UPDATE SET volume_units = volume_units + excluded.volume_units, dollar_volume_cc = dollar_volume_cc + excluded.dollar_volume_cc;
  INSERT INTO market_volume_hourly(market_ticker, hour_ts, volume_units) VALUES (NEW.market_ticker, (NEW.created_ts / 3600000) * 3600000, NEW.count)
    ON CONFLICT(market_ticker, hour_ts) DO UPDATE SET volume_units = volume_units + excluded.volume_units;
END;
CREATE TRIGGER trg_trades_volume_del AFTER DELETE ON trades BEGIN
  UPDATE market_volume SET volume_units = volume_units - OLD.count, dollar_volume_cc = dollar_volume_cc - OLD.count * COALESCE(OLD.yes_price_cc, 0) WHERE market_ticker = OLD.market_ticker;
  UPDATE market_volume_hourly SET volume_units = volume_units - OLD.count WHERE market_ticker = OLD.market_ticker AND hour_ts = (OLD.created_ts / 3600000) * 3600000;
END;
CREATE TRIGGER trg_trades_volume_upd AFTER UPDATE OF count, yes_price_cc, created_ts, market_ticker ON trades BEGIN
  UPDATE market_volume SET volume_units = volume_units - OLD.count, dollar_volume_cc = dollar_volume_cc - OLD.count * COALESCE(OLD.yes_price_cc, 0) WHERE market_ticker = OLD.market_ticker;
  UPDATE market_volume_hourly SET volume_units = volume_units - OLD.count WHERE market_ticker = OLD.market_ticker AND hour_ts = (OLD.created_ts / 3600000) * 3600000;
  INSERT INTO market_volume(market_ticker, volume_units, dollar_volume_cc) VALUES (NEW.market_ticker, NEW.count, NEW.count * COALESCE(NEW.yes_price_cc, 0))
    ON CONFLICT(market_ticker) DO UPDATE SET volume_units = volume_units + excluded.volume_units, dollar_volume_cc = dollar_volume_cc + excluded.dollar_volume_cc;
  INSERT INTO market_volume_hourly(market_ticker, hour_ts, volume_units) VALUES (NEW.market_ticker, (NEW.created_ts / 3600000) * 3600000, NEW.count)
    ON CONFLICT(market_ticker, hour_ts) DO UPDATE SET volume_units = volume_units + excluded.volume_units;
END;
`;

module.exports = {
  id: 4,
  name: 'market-volume',
  up(db) { db.exec(SQL); },
};
