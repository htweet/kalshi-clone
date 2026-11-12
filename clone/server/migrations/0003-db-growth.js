'use strict';
// Migration 0003 — database growth (owner report 2026-11-13, CLONE_SPEC.md §39.17). On a long-running database (millions
// of orders, fills, trades and ledger rows) these queries scanned whole tables on the request thread; each index serves
// the query named beside it. The statements are measured in §39.17 (before / after). Plus the record of `npm run
// db:compact` runs (Admin › System shows the last one).
const SQL = `
-- engine.expireOrders, every engine tick (1 s): resting good-til-time orders that have expired.
CREATE INDEX IF NOT EXISTS idx_orders_expiring ON orders(expiration_ts) WHERE status='resting' AND expiration_ts IS NOT NULL;
-- resting orders by user (play mode preview / reset, Admin › Play mode; the production switch).
CREATE INDEX IF NOT EXISTS idx_orders_resting_user ON orders(user_id) WHERE status='resting';
-- the public trade tape and the Trade API trade list (newest first, no market filter); Admin › Reports by day / market.
CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(created_ts);
-- per-trade lookups: the social trade feed (who was the taker), referral first trades, compaction.
CREATE INDEX IF NOT EXISTS idx_fills_trade ON fills(trade_id);
-- Admin › Reports: deposits and withdrawals by day.
CREATE INDEX IF NOT EXISTS idx_ledger_kind_ts ON ledger(kind, created_at);
-- npm run db:compact runs (scripts/db-compact.js).
CREATE TABLE IF NOT EXISTS ops_compactions (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, finished_ts INTEGER, status TEXT NOT NULL, dry_run INTEGER NOT NULL DEFAULT 0,
  older_than_days INTEGER NOT NULL, cutoff_ts INTEGER NOT NULL, bytes_before INTEGER, bytes_after INTEGER, counts_json TEXT, backup_id TEXT, error TEXT);
`;

module.exports = {
  id: 3,
  name: 'db-growth',
  up(db) { db.exec(SQL); },
};
