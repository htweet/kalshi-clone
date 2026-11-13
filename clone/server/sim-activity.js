'use strict';
// Simulated trading activity (owner setting `simulation.activity`, ground rule 6; database growth fix 2026-11-13,
// CLONE_SPEC.md §39.17). The built-in liquidity accounts re-quote the simulated sports markets around their live fair
// price: cancel the resting quotes, print one reference trade at the new fair price (the flow account against the
// liquidity account) and rest a bid and an offer again. Every one of those orders, fills, trades, journal entries and
// ledger rows is stored for good, so at "normal" (every 1¢ move, once a second per market) a running server wrote about
// 7,000 journal postings a minute — millions of rows a day — and the database grew by gigabytes in days.
//
// Levels (read live on every decision, so a change in Admin › Owner settings takes effect at once):
//   off     no re-quotes, no reference trades, no opening quotes for new fixtures; resting quotes stay;
//   low     (recommended) a market re-quotes only when its fair price moved at least 2¢ since its last quote (and that
//           quote is 15 s old) or moved at all and the quote is a minute old; at most 20 re-quotes a minute across the
//           exchange (a token bucket), each with its reference trade when the price changed — prices, charts and volume
//           keep moving with about a twentieth of the writes;
//   normal  the original behaviour: every 1¢ move, at most once a second per market.
const LOW = { minMove: 2, minGapMs: 15000, staleMs: 60000, perMinute: 20 };
const LEVELS = ['off', 'low', 'normal'];

function createActivity({ level, now = () => Date.now(), low = LOW } = {}) {
  let tokens = 0; let last = now();
  const current = () => { let v = 'low'; try { v = level(); } catch { /* settings not ready */ } return LEVELS.includes(v) ? v : 'low'; };
  return {
    level: current,
    // May a market quoted at `quoted` cents (null: never) at `quotedTs` re-quote to `fair` now? (Callers apply their own
    // per-market throttle and "unchanged price" rule first.)
    allow(quoted, quotedTs, fair, t = now()) {
      const lv = current();
      if (lv === 'normal') return true;
      if (lv === 'off') return false;
      const move = quoted == null ? Infinity : Math.abs(fair - quoted);
      const age = quotedTs ? t - quotedTs : Infinity;
      if (!((move >= low.minMove && age >= low.minGapMs) || (move >= 1 && age >= low.staleMs))) return false;
      tokens = Math.min(Math.max(1, low.perMinute / 6), tokens + (Math.max(0, t - last) / 60000) * low.perMinute);
      last = t;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

module.exports = { createActivity, LOW, LEVELS };
