'use strict';
// Migration 0010 — perps order-book levels kept as running totals (follow-up to the 2026-11-15 soak finding,
// CLONE_SPEC.md §39.20). perps.js best() and book() summed the resting orders at each price on every order and on every
// order-book read (book updates after each order, the Trade API order book with full depth): the same pattern that made
// the event book slower as it filled. The levels are now kept by triggers on `perp_orders`, so every writer (matching,
// amendments, cancels, expiry, liquidation, deletes) is covered in its own transaction.
//   perp_book_levels  ticker, side (bid|ask), price_cc → contracts resting (rows at 0 are removed)
const SQL = `
CREATE TABLE IF NOT EXISTS perp_book_levels (ticker TEXT NOT NULL, side TEXT NOT NULL, price_cc INTEGER NOT NULL, units INTEGER NOT NULL,
  PRIMARY KEY (ticker, side, price_cc)) WITHOUT ROWID;
DELETE FROM perp_book_levels;
INSERT INTO perp_book_levels(ticker, side, price_cc, units)
  SELECT ticker, side, price_cc, SUM(remaining_count) FROM perp_orders WHERE status='resting' GROUP BY ticker, side, price_cc HAVING SUM(remaining_count) <> 0;
DROP TRIGGER IF EXISTS trg_perp_orders_book_ins; DROP TRIGGER IF EXISTS trg_perp_orders_book_del; DROP TRIGGER IF EXISTS trg_perp_orders_book_upd;
CREATE TRIGGER trg_perp_orders_book_ins AFTER INSERT ON perp_orders WHEN NEW.status='resting' BEGIN
  INSERT INTO perp_book_levels(ticker, side, price_cc, units) VALUES (NEW.ticker, NEW.side, NEW.price_cc, NEW.remaining_count)
    ON CONFLICT(ticker, side, price_cc) DO UPDATE SET units = units + excluded.units;
  DELETE FROM perp_book_levels WHERE ticker=NEW.ticker AND side=NEW.side AND price_cc=NEW.price_cc AND units=0;
END;
CREATE TRIGGER trg_perp_orders_book_del AFTER DELETE ON perp_orders WHEN OLD.status='resting' BEGIN
  UPDATE perp_book_levels SET units = units - OLD.remaining_count WHERE ticker=OLD.ticker AND side=OLD.side AND price_cc=OLD.price_cc;
  DELETE FROM perp_book_levels WHERE ticker=OLD.ticker AND side=OLD.side AND price_cc=OLD.price_cc AND units=0;
END;
CREATE TRIGGER trg_perp_orders_book_upd AFTER UPDATE OF status, remaining_count, price_cc, side, ticker ON perp_orders
  WHEN OLD.status='resting' OR NEW.status='resting' BEGIN
  UPDATE perp_book_levels SET units = units - OLD.remaining_count
    WHERE OLD.status='resting' AND ticker=OLD.ticker AND side=OLD.side AND price_cc=OLD.price_cc;
  INSERT INTO perp_book_levels(ticker, side, price_cc, units) SELECT NEW.ticker, NEW.side, NEW.price_cc, NEW.remaining_count
    WHERE NEW.status='resting'
    ON CONFLICT(ticker, side, price_cc) DO UPDATE SET units = units + excluded.units;
  DELETE FROM perp_book_levels WHERE ticker=OLD.ticker AND side=OLD.side AND price_cc=OLD.price_cc AND units=0;
  DELETE FROM perp_book_levels WHERE ticker=NEW.ticker AND side=NEW.side AND price_cc=NEW.price_cc AND units=0;
END;
`;

module.exports = {
  id: 10,
  name: 'perp-book-levels',
  up(db) { db.exec(SQL); },
};
