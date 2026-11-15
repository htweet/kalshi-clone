'use strict';
// Migration 0006 — layout variants: the new landing page for visitors and the new member home (owner requests
// 2026-11-15, CLONE_SPEC.md §41). Self-contained (renumber freely at merge):
//   landing_content   per event or series (kind): the hero context paragraph, an image from the CMS media library
//                     (cms_media id + alt text) and "keep out of the automatic hero slides". One row per item the admin
//                     touched; a missing row means the automatic defaults (news text, generated artwork).
//   cms_promos        + art (the illustration drawn on the card: '', candles, coins, map, bars) and placement (where an
//                     untargeted card shows: all, home = the member home, landing = the visitor landing page).
//   flash_prices_x    the simulated reference prices of the extra rolling 15-minute underlyings (server/rolling.js; the
//                     original PLX token keeps flash_prices), one row per underlying and 5 s, kept for 2 hours.
const SQL = `
CREATE TABLE IF NOT EXISTS landing_content (ref TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('event', 'series')), hero_exclude INTEGER NOT NULL DEFAULT 0,
  context TEXT NOT NULL DEFAULT '', image_asset_id TEXT, image_alt TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, updated_by TEXT, PRIMARY KEY (kind, ref));
CREATE TABLE IF NOT EXISTS flash_prices_x (underlying TEXT NOT NULL, ts INTEGER NOT NULL, price_cents INTEGER NOT NULL, PRIMARY KEY (underlying, ts));
`;

module.exports = {
  id: 6,
  name: 'landing',
  up(db) {
    db.exec(SQL);
    const cols = new Set(db.prepare('PRAGMA table_info(cms_promos)').all().map((c) => c.name));
    if (cols.size) {
      if (!cols.has('art')) db.exec("ALTER TABLE cms_promos ADD COLUMN art TEXT NOT NULL DEFAULT ''");
      if (!cols.has('placement')) db.exec("ALTER TABLE cms_promos ADD COLUMN placement TEXT NOT NULL DEFAULT 'all'");
    }
  },
};
