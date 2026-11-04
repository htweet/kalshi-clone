'use strict';
// Positions tab data (spec §17.11): holdings grouped by event with mark, value, P&L, payout if it wins, the cash a
// full sell would return now (walking the book), resting-order counts, combo legs, and a portfolio summary.
const { dollars, ufp, toUnits, UNITS, E } = require('./util');
const { feeSequence, takerPrincipalCc } = require('./engine');
const P = require('./pricing'); // prices in centi-cents (CLONE_SPEC.md §28.1)

const SORTS = ['value', 'pnl', 'closing'];
const FILTERS = ['all', 'open', 'closing', 'combos'];
const CLOSING_SOON_MS = 7 * 86400000; // design choice: "closing soon" = closes within 7 days

function mountPositions({ v1, db, engine, requireUser }) {
  // Mark in cc: last trade, else the mid, else 50¢.
  const markOf = (q) => (q.last_price_cc != null ? q.last_price_cc : q.yes_bid_cc != null && q.yes_ask_cc != null ? Math.round((q.yes_bid_cc + q.yes_ask_cc) / 2) : q.yes_bid_cc ?? q.yes_ask_cc ?? P.CC / 2);
  // Selling `units` of `side` = buying the other side against resting bids for `side` (best first, own orders
  // excluded as the engine does); each pair nets back $1, so proceeds = q − (ceil(q·tp/10^4) + fee). Fees accrue through
  // the same per-order accumulator as the engine (G1), so the estimate equals what the sell is charged.
  function sellWalk(uid, ticker, side, units) {
    const m = engine.market(ticker);
    const bids = db.prepare("SELECT price_cc p, remaining_count n FROM orders WHERE market_ticker=? AND status='resting' AND side=? AND user_id<>? ORDER BY price_cc DESC, seq ASC").all(ticker, side, uid);
    const feeOf = feeSequence(m.fee_multiplier);
    let left = units; let proceeds = 0; let fee = 0; let filled = 0;
    for (const b of bids) {
      if (!left) break;
      const q = Math.min(left, b.n);
      const tp = P.CC - b.p;
      const f = feeOf(q, tp);
      proceeds += q - takerPrincipalCc(q, tp) - f;
      fee += f; filled += q; left -= q;
    }
    return { units: filled, proceeds_cents: proceeds, fee_cents: fee, complete: left === 0 };
  }
  const legsOf = (t) => db.prepare('SELECT cl.side, cl.market_ticker, lm.yes_sub_title outcome, lm.result, e.title event_title FROM combo_legs cl JOIN markets lm ON lm.ticker=cl.market_ticker JOIN events e ON e.ticker=lm.event_ticker WHERE cl.combo_ticker=? ORDER BY cl.leg_index').all(t)
    .map((l) => ({ market_ticker: l.market_ticker, side: l.side, outcome: l.outcome, event_title: l.event_title, leg_status: !l.result ? 'pending' : l.result === l.side ? 'won' : 'lost' }));

  function positionRows(uid) {
    const rows = db.prepare(`SELECT p.*, m.title, m.yes_sub_title, m.color, m.status, m.result, m.close_time, m.event_ticker, m.mve_collection_ticker, m.fractional_trading_enabled,
        m.market_type, m.price_level_structure, m.floor_strike, m.cap_strike, m.scalar_unit, m.settlement_value_cc,
        e.title event_title, e.category, s.ticker st, s.slug FROM positions p JOIN markets m ON m.ticker=p.market_ticker JOIN events e ON e.ticker=m.event_ticker JOIN series s ON s.ticker=e.series_ticker
        WHERE p.user_id=? AND (p.yes_count>0 OR p.no_count>0)`).all(uid);
    return rows.map((p) => {
      const side = p.yes_count > 0 ? 'yes' : 'no';
      const units = p.yes_count || p.no_count;
      const q = engine.quote(p.market_ticker);
      const yesMark = markOf(q);
      const mark = side === 'yes' ? yesMark : P.CC - yesMark;
      const prevYes = q.previous_price_cc ?? yesMark;
      const prev = side === 'yes' ? prevYes : P.CC - prevYes;
      const UC = UNITS * P.CC_PER_CENT; // units × cc → cents
      const cost = p.yes_cost_cents + p.no_cost_cents;
      const basis = cost + p.fees_paid_cents;
      const settleCc = p.settlement_value_cc ?? (p.result === 'yes' ? P.CC : p.result === 'no' ? 0 : null);
      const value = settleCc != null ? Math.floor((units * (side === 'yes' ? settleCc : P.CC - settleCc)) / P.CC) : Math.round((units * mark) / UC);
      const sell = p.status === 'active' ? sellWalk(uid, p.market_ticker, side, units) : { units: 0, proceeds_cents: 0, fee_cents: 0, complete: false };
      const resting = db.prepare("SELECT COUNT(*) c FROM orders WHERE user_id=? AND market_ticker=? AND status='resting'").get(uid, p.market_ticker).c;
      const state = p.status === 'active' ? 'open' : p.status === 'determined' ? 'settling' : p.status === 'finalized' ? 'settled' : p.status;
      return {
        ticker: p.market_ticker, event_ticker: p.event_ticker, event_title: p.event_title, category: p.category, market_title: p.title, outcome: p.yes_sub_title, color_code: p.color,
        link: `/markets/${p.st.toLowerCase()}/${p.slug}/${p.event_ticker.toLowerCase()}`, is_combo: !!p.mve_collection_ticker, legs: p.mve_collection_ticker ? legsOf(p.market_ticker) : null,
        fractional_trading_enabled: !!p.fractional_trading_enabled,
        side, position_fp: ufp(units), avg_price_dollars: P.ccToDollars(Math.round((cost * UC) / units)), total_cost_dollars: dollars(cost), fees_paid_dollars: dollars(p.fees_paid_cents),
        cost_basis_dollars: dollars(basis), mark_price_dollars: P.ccToDollars(mark), market_value_dollars: dollars(value),
        buy_price_dollars: P.ccToDollars(side === 'yes' ? q.yes_ask_cc : q.no_ask_cc),
        market_type: p.market_type || 'binary', price_level_structure: p.price_level_structure, ...(p.market_type === 'scalar' ? { floor_strike: p.floor_strike, cap_strike: p.cap_strike, scalar_unit: p.scalar_unit } : {}), // "Current buy" market preview price (Settings, CLONE_SPEC.md §25.8)
        unrealized_pnl_dollars: dollars(value - basis), unrealized_pnl_pct: basis ? Math.round(((value - basis) / basis) * 10000) / 100 : null,
        realized_pnl_dollars: dollars(p.realized_pnl_cents), payout_if_win_dollars: dollars(units),
        sell_value_dollars: dollars(sell.proceeds_cents), sell_fee_dollars: dollars(sell.fee_cents), sell_liquidity_fp: ufp(sell.units), sell_complete: sell.complete,
        day_change_dollars: dollars(p.result ? 0 : Math.round((units * (mark - prev)) / UC)),
        resting_orders: resting, market_status: p.status, state, result: p.result || null, close_time: p.close_time,
        _value: value, _pnl: value - basis, _close: Date.parse(p.close_time),
      };
    });
  }

  v1.get('/users/:uid/portfolio/positions', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const sort = SORTS.includes(req.query.sort) ? req.query.sort : 'value';
    const filter = FILTERS.includes(req.query.filter) ? req.query.filter : 'all';
    const all = positionRows(uid);
    let rows = all;
    if (filter === 'open') rows = rows.filter((r) => r.market_status === 'active');
    if (filter === 'closing') rows = rows.filter((r) => r.market_status === 'active' && r._close - Date.now() <= CLOSING_SOON_MS);
    if (filter === 'combos') rows = rows.filter((r) => r.is_combo);
    const key = { value: (r) => -r._value, pnl: (r) => -r._pnl, closing: (r) => r._close }[sort];
    rows.sort((a, b) => key(a) - key(b) || a.ticker.localeCompare(b.ticker));
    // Group by event, groups ordered by their first (best-ranked) position.
    const groups = new Map();
    for (const r of rows) {
      if (!groups.has(r.event_ticker)) groups.set(r.event_ticker, { event_ticker: r.event_ticker, title: r.event_title, category: r.category, link: r.link, is_combo: r.is_combo, positions: [] });
      groups.get(r.event_ticker).positions.push(r);
    }
    const strip = (r) => { const { _value, _pnl, _close, ...rest } = r; return rest; };
    const cash = engine.balance(uid);
    const reserved = db.prepare("SELECT COALESCE(SUM(reserved_cents),0) c FROM orders WHERE user_id=? AND status='resting'").get(uid).c;
    const posValue = all.reduce((a, r) => a + r._value, 0);
    const realized = db.prepare('SELECT COALESCE(SUM(realized_pnl_cents),0) c FROM positions WHERE user_id=?').get(uid).c;
    // A9: collateral returned early is already in cash and is repaid from the same positions' payouts, so it is not
    // counted twice in the total (CLONE_SPEC.md §28.6).
    const advanced = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='collateral_returns'").get() ? db.prepare('SELECT COALESCE(SUM(amount_cents),0) c FROM collateral_returns WHERE user_id=?').get(uid).c : 0;
    res.json({
      sort, filter,
      summary: {
        total_value_dollars: dollars(cash + reserved + posValue - advanced), cash_dollars: dollars(cash), collateral_returned_dollars: dollars(advanced), reserved_dollars: dollars(reserved), positions_value_dollars: dollars(posValue),
        today_change_dollars: dollars(all.reduce((a, r) => a + Math.round(Number(r.day_change_dollars) * 100), 0)),
        all_time_pnl_dollars: dollars(realized + all.reduce((a, r) => a + r._pnl, 0)), open_positions: all.length, open_combos: all.filter((r) => r.is_combo).length,
      },
      events: [...groups.values()].map((g) => ({ ...g, positions: g.positions.map(strip) })),
    });
  });

  // Estimated proceeds for selling `count` of a held position now (the Sell sheet; market sells walk the book).
  v1.get('/users/:uid/positions/:ticker/sell_quote', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const p = db.prepare('SELECT * FROM positions WHERE user_id=? AND market_ticker=?').get(uid, req.params.ticker);
    if (!p || !(p.yes_count || p.no_count)) throw E.notFound();
    const side = p.yes_count > 0 ? 'yes' : 'no';
    const held = p.yes_count || p.no_count;
    const units = req.query.count == null ? held : toUnits(req.query.count);
    if (units == null || units < 1 || units > held) throw E.badRequest('count must be between 0.01 and the held size');
    const w = sellWalk(uid, p.market_ticker, side, units);
    res.json({ side, count_fp: ufp(units), fillable_fp: ufp(w.units), proceeds_dollars: dollars(w.proceeds_cents), fee_dollars: dollars(w.fee_cents), complete: w.complete });
  });
  return { sellWalk };
}

module.exports = { mountPositions };
