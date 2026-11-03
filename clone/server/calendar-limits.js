'use strict';
// Calendar `event_limits` (Phase 5B; CLONE_SPEC.md §13.4 observed shape, §29.4). Each calendar section caps how many
// events of one recurring family it shows: `{event_tickers:[every event of the family in the section], max_count}`.
// Observed: 15-minute crypto / commodity / FX families capped at 3 and daily-temperature families at 2. Design choice
// (U16): a family is one series; 15-minute and hourly series are capped at 3, daily series at 2; sports games are
// separate fixtures, not a recurring family, and are never capped. The client shows the first `max_count` events in
// section order and a "+N more" control for the rest.
const CAPS = { fifteen_min: 3, hourly: 3, daily: 2 };

function eventLimits(events) {
  const fam = new Map();
  for (const e of events) {
    const cap = CAPS[e.frequency];
    if (!cap || e.category === 'Sports') continue;
    if (!fam.has(e.series_ticker)) fam.set(e.series_ticker, { cap, tickers: [] });
    fam.get(e.series_ticker).tickers.push(e.event_ticker);
  }
  return [...fam.values()].filter((f) => f.tickers.length > f.cap).map((f) => ({ event_tickers: f.tickers, max_count: f.cap }));
}

module.exports = { eventLimits, CAPS };
