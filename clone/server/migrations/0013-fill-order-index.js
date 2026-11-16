'use strict';
// Migration 0013 — fills by order (soak review 2026-11-15, CLONE_SPEC.md §39.20). Self-contained (renumber freely at
// merge). Every order placement reads its own fills (`fills WHERE order_id=? AND user_id=?`, the average fill price in
// the response), as do the Trade API socket, FIX and the order history; `fills` was indexed by user and by trade only,
// so each of those reads scanned all of the trader's fills and every order got slower as the trader's history grew
// (order p50 ~70 ms → ~700 ms over a 20-minute soak; the CPU profile at the end showed that one read as the largest
// growing cost). With an index on order_id it is a lookup of the order's own fills.
module.exports = {
  id: 13,
  name: 'fill-order-index',
  up(db) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fills'").get()) db.exec('CREATE INDEX IF NOT EXISTS idx_fills_order ON fills(order_id)');
  },
};
