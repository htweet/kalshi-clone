'use strict';
// Migration 0005 — order-book levels kept as running totals (soak finding 2026-11-15, CLONE_SPEC.md §39.20).
// engine.book() ran before and after every order and summed every resting order of the market by price
// (GROUP BY over the orders table): with thousands of resting orders per market each order got slower, and a soak at
// 40 orders/s ended with a saturated request thread and order p99 of tens of seconds. The book is now kept per market,
// side and price by triggers on `orders`, so every writer (matching, cancels, expiry, amendments, play-mode resets,
// migrations) is covered in its own transaction, and reading the book costs the same however many orders rest.
//   book_levels  market_ticker, side, price_cc → units resting (rows at 0 are removed)
// Existing resting orders are counted once, before the triggers exist. price_cc is filled by trg_orders_price_cc
// right after an insert that leaves it NULL; that UPDATE is what adds such an order to its level.
const SQL = `
CREATE TABLE IF NOT EXISTS book_levels (market_ticker TEXT NOT NULL, side TEXT NOT NULL, price_cc INTEGER NOT NULL, units INTEGER NOT NULL,
  PRIMARY KEY (market_ticker, side, price_cc)) WITHOUT ROWID;
DELETE FROM book_levels;
INSERT INTO book_levels(market_ticker, side, price_cc, units)
  SELECT market_ticker, side, price_cc, SUM(remaining_count) FROM orders WHERE status='resting' AND price_cc IS NOT NULL GROUP BY market_ticker, side, price_cc HAVING SUM(remaining_count) <> 0;
DROP TRIGGER IF EXISTS trg_orders_book_ins; DROP TRIGGER IF EXISTS trg_orders_book_del; DROP TRIGGER IF EXISTS trg_orders_book_upd;
CREATE TRIGGER trg_orders_book_ins AFTER INSERT ON orders WHEN NEW.status='resting' AND NEW.price_cc IS NOT NULL BEGIN
  INSERT INTO book_levels(market_ticker, side, price_cc, units) VALUES (NEW.market_ticker, NEW.side, NEW.price_cc, NEW.remaining_count)
    ON CONFLICT(market_ticker, side, price_cc) DO UPDATE SET units = units + excluded.units;
  DELETE FROM book_levels WHERE market_ticker=NEW.market_ticker AND side=NEW.side AND price_cc=NEW.price_cc AND units=0;
END;
CREATE TRIGGER trg_orders_book_del AFTER DELETE ON orders WHEN OLD.status='resting' AND OLD.price_cc IS NOT NULL BEGIN
  UPDATE book_levels SET units = units - OLD.remaining_count WHERE market_ticker=OLD.market_ticker AND side=OLD.side AND price_cc=OLD.price_cc;
  DELETE FROM book_levels WHERE market_ticker=OLD.market_ticker AND side=OLD.side AND price_cc=OLD.price_cc AND units=0;
END;
CREATE TRIGGER trg_orders_book_upd AFTER UPDATE OF status, remaining_count, price_cc, side, market_ticker ON orders
  WHEN (OLD.status='resting' AND OLD.price_cc IS NOT NULL) OR (NEW.status='resting' AND NEW.price_cc IS NOT NULL) BEGIN
  UPDATE book_levels SET units = units - OLD.remaining_count
    WHERE OLD.status='resting' AND OLD.price_cc IS NOT NULL AND market_ticker=OLD.market_ticker AND side=OLD.side AND price_cc=OLD.price_cc;
  INSERT INTO book_levels(market_ticker, side, price_cc, units) SELECT NEW.market_ticker, NEW.side, NEW.price_cc, NEW.remaining_count
    WHERE NEW.status='resting' AND NEW.price_cc IS NOT NULL
    ON CONFLICT(market_ticker, side, price_cc) DO UPDATE SET units = units + excluded.units;
  DELETE FROM book_levels WHERE market_ticker=OLD.market_ticker AND side=OLD.side AND price_cc=OLD.price_cc AND units=0;
  DELETE FROM book_levels WHERE market_ticker=NEW.market_ticker AND side=NEW.side AND price_cc=NEW.price_cc AND units=0;
END;
`;

module.exports = {
  id: 5,
  name: 'book-levels',
  up(db) { db.exec(SQL); },
};
