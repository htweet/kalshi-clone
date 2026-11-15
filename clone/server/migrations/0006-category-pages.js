'use strict';
// Migration 0006 — category pages (owner request 2026-11-15, CLONE_SPEC.md §41). Self-contained:
//   category_page_config        one row per category: the admin's choices as validated JSON (sidebar groups, featured
//                               pins / exclusions, carousel size, Top-cities strip, docked ticket, banner, layout); a
//                               missing row means the recommended defaults. Changes are audited in admin_audit.
//   category_banner_dismissals  a member's dismissal of a category banner (per banner version); visitors keep theirs in
//                               the browser.
//   underlying_prices           price history of an invented underlying (a commodity series) for the featured card's
//                               underlying-price chart; bounded by the writer (30 days).
//   category_city_events        the daily city weather events (city, WAT day, kind) behind the Top-cities strip.
// Indexes: events and series by category, so a category page reads only its own rows.
const SQL = `
CREATE TABLE IF NOT EXISTS category_page_config (category TEXT PRIMARY KEY, config TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, updated_by TEXT);
CREATE TABLE IF NOT EXISTS category_banner_dismissals (user_id TEXT NOT NULL, category TEXT NOT NULL, banner_version INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, category));
CREATE TABLE IF NOT EXISTS underlying_prices (series_ticker TEXT NOT NULL, ts INTEGER NOT NULL, price REAL NOT NULL, PRIMARY KEY (series_ticker, ts));
CREATE TABLE IF NOT EXISTS category_city_events (event_ticker TEXT PRIMARY KEY, city TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_category_city_day ON category_city_events(day, city);
CREATE INDEX IF NOT EXISTS idx_events_category ON events(category, series_ticker);
CREATE INDEX IF NOT EXISTS idx_series_category ON series(category);
`;

module.exports = {
  id: 6,
  name: 'category-pages',
  up(db) { db.exec(SQL); },
};
