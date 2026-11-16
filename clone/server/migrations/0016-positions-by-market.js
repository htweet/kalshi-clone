'use strict';
// Migration 0016 — positions by market (soak follow-up 2026-11-16, CLONE_SPEC.md §39.20 item 12). engine.quote() runs
// after every order and for every market a page lists (~1,400 times a second in the soak); its open interest,
// SUM(yes_count) FROM positions WHERE market_ticker=?, had no index to use — the primary key starts with user_id — so
// every call scanned the whole positions table, which grows with members × markets traded. Settlement's read of a
// market's holders (yes_count > 0 OR no_count > 0) had the same scan. The index covers both counts, so the open
// interest is read from the index alone, in proportion to the market's holders.
module.exports = {
  id: 16,
  name: 'positions-by-market',
  up(db) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='positions'").get()) return;
    db.exec('CREATE INDEX IF NOT EXISTS idx_positions_market ON positions(market_ticker, yes_count, no_count);');
  },
};
