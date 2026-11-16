'use strict';
// Migration 0014 — resting orders read in index order (one-hour soak 2026-11-16, CLONE_SPEC.md §39.20 item 10).
// Self-contained (renumber freely at merge). Per-statement timings over a 30-minute soak (40 orders/s) showed three
// reads of resting orders growing with the book while every other statement stayed flat:
//   • matching (`engine.placeOrder`): the crossing makers, `ORDER BY price_cc DESC, seq ASC` — the old index orders
//     seq the same way as price_cc, so SQLite read and sorted every crossing resting order before the first one was used
//     (209 → 418 ms a minute); price_cc DESC in the index makes the scan follow the matching order, so it stops after
//     the makers the order actually fills against;
//   • queue position (order views, Trade API, FIX): the contracts ahead of an order at its price, read from the index
//     alone (remaining_count is in it);
//   • the balance view's reserved amount (`SUM(reserved_cents)` of a member's resting orders, 1.7 → 4.6 ms a call): read
//     from the index alone; it replaces idx_orders_resting_user (user_id), which it covers.
module.exports = {
  id: 14,
  name: 'resting-order-indexes',
  up(db) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='orders'").get()) return;
    db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_resting_level ON orders(market_ticker, side, price_cc DESC, seq, remaining_count) WHERE status='resting';
CREATE INDEX IF NOT EXISTS idx_orders_resting_user_reserved ON orders(user_id, reserved_cents) WHERE status='resting';
DROP INDEX IF EXISTS idx_orders_resting_user;`);
  },
};
