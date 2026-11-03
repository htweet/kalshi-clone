'use strict';
const { dollars, ufp } = require('./util');
const P = require('./pricing');
// Quantity fields (`*_fp`) are fixed-point contract strings: stored units / 100 with 2 decimals (spec §16.1).
// Prices are 4-decimal dollar strings from centi-cents (Phase 5A, CLONE_SPEC.md §28.1); `q` is engine.quote().
const qcc = (q, k) => (q[`${k}_cc`] !== undefined ? q[`${k}_cc`] : q[k] == null ? null : q[k] * P.CC_PER_CENT);
const ccD = P.ccToDollars;
const orderCc = (o) => (o.price_cc != null ? o.price_cc : o.price_cents * P.CC_PER_CENT);

function marketVo(m, q) {
  return {
    ticker: m.ticker,
    event_ticker: m.event_ticker,
    market_type: m.market_type || 'binary',
    title: m.title,
    yes_sub_title: m.yes_sub_title,
    no_sub_title: m.no_sub_title,
    color_code: m.color,
    status: m.status,
    result: m.result,
    open_time: m.open_time,
    close_time: m.close_time,
    expected_expiration_time: m.expected_expiration_time,
    settlement_timer_seconds: m.settlement_timer_seconds,
    can_close_early: !!m.can_close_early,
    rules_primary: m.rules_primary,
    yes_bid_dollars: ccD(qcc(q, 'yes_bid')),
    yes_ask_dollars: ccD(qcc(q, 'yes_ask')),
    no_bid_dollars: ccD(qcc(q, 'no_bid')),
    no_ask_dollars: ccD(qcc(q, 'no_ask')),
    yes_bid_size_fp: ufp(q.yes_bid_size),
    yes_ask_size_fp: ufp(q.yes_ask_size),
    last_price_dollars: ccD(qcc(q, 'last_price')),
    previous_price_dollars: ccD(qcc(q, 'previous_price')),
    previous_hour_price_dollars: ccD(qcc(q, 'previous_hour_price')),
    previous_day_price_dollars: ccD(qcc(q, 'previous_price')),
    previous_week_price_dollars: ccD(qcc(q, 'previous_week_price')),
    volume_fp: ufp(q.volume),
    dollar_volume: q.dollar_volume_cents == null ? null : Math.round(q.dollar_volume_cents / 100),
    volume_24h_fp: ufp(q.volume_24h),
    open_interest_fp: ufp(q.open_interest),
    notional_value_dollars: '1.0000',
    price_level_structure: m.price_level_structure || 'linear_cent',
    price_ranges: P.priceRanges(m.price_level_structure),
    tick_size_dollars: ccD(P.minTick(m.price_level_structure)),
    ...scalarVo(m),
    fractional_trading_enabled: !!m.fractional_trading_enabled,
    contract_decimals: m.fractional_trading_enabled ? 2 : 0,
    ...(m.mve_collection_ticker ? { mve_collection_ticker: m.mve_collection_ticker, mve_selected_legs: JSON.parse(m.mve_selected_legs || '[]') } : {}),
    updated_time: m.updated_at,
    created_time: m.created_at,
  };
}

// Scalar markets (CLONE_SPEC.md §28.4): YES pays (value − floor) / (cap − floor) of $1, clamped to [0, 1].
function scalarVo(m) {
  const out = {};
  if (m.market_type === 'scalar') Object.assign(out, { floor_strike: m.floor_strike, cap_strike: m.cap_strike, scalar_unit: m.scalar_unit || '', settlement_bounds_type: 'floor_cap' });
  if (m.settlement_value_cc != null && ['determined', 'finalized'].includes(m.status)) {
    out.settlement_value_dollars = ccD(m.settlement_value_cc);
    out.yes_settlement_value_dollars = ccD(m.settlement_value_cc);
    if (m.market_type === 'scalar') out.expiration_value = m.expiration_value == null ? null : String(m.expiration_value);
  }
  return out;
}

function eventVo(e, markets) {
  const vo = {
    event_ticker: e.ticker,
    series_ticker: e.series_ticker,
    title: e.title,
    sub_title: e.sub_title,
    category: e.category,
    mutually_exclusive: !!e.mutually_exclusive,
    collateral_return_type: e.mutually_exclusive ? 'MECNET' : '', // A9: collateral-return netting (openapi EventData)
    is_live: !!e.is_live,
    live_label: e.live_label,
    news: e.news,
    featured: !!e.featured,
  };
  if (markets) vo.markets = markets;
  return vo;
}

function seriesVo(s) {
  return {
    ticker: s.ticker,
    title: s.title,
    slug: s.slug,
    category: s.category,
    tags: JSON.parse(s.tags),
    frequency: s.frequency,
    fee_type: s.fee_type,
    fee_multiplier: s.fee_multiplier,
    settlement_sources: JSON.parse(s.settlement_sources),
    rules: s.rules,
  };
}

function orderVo(o) {
  return {
    order_id: o.id,
    client_order_id: o.client_order_id,
    ticker: o.market_ticker,
    side: o.side,
    action: 'buy',
    type: o.time_in_force === 'ioc' ? 'market' : 'limit',
    order_type: o.order_type || (o.time_in_force === 'ioc' ? 'market' : 'limit'),
    // The user's intent: a sell of YES at p is stored and matched as a buy of NO at 100−p (spec §15.4).
    user_action: o.action || 'buy',
    user_side: o.action === 'sell' ? (o.side === 'yes' ? 'no' : 'yes') : o.side,
    user_price_dollars: ccD(o.action === 'sell' ? P.CC - orderCc(o) : orderCc(o)),
    price_dollars: ccD(orderCc(o)),
    initial_count_fp: ufp(o.initial_count),
    remaining_count_fp: ufp(o.remaining_count),
    fill_count_fp: ufp(o.filled_count),
    taker_fees_dollars: dollars(o.fees_cents),
    // G1: exact fee accrued by the accumulator ($0.000001) and the rounding fee charged on top of it (< $0.01 per order).
    taker_fees_exact_dollars: o.fee_micro == null ? null : (o.fee_micro / 1e6).toFixed(6),
    taker_fees_rounding_dollars: o.fee_micro == null ? null : ((o.fees_cents * 10000 - o.fee_micro) / 1e6).toFixed(6),
    flip_count_fp: o.flip_units ? ufp(o.flip_units) : null, // A8: the part of a flip sell that opens the other side
    reserved_dollars: dollars(o.reserved_cents),
    expiration_time: o.expiration_ts ? new Date(o.expiration_ts).toISOString() : null,
    cancel_reason: o.cancel_reason || null,
    status: o.status,
    created_time: o.created_at,
    last_update_time: o.updated_at,
  };
}

function fillVo(f) {
  return {
    fill_id: f.id ?? f.fill_id,
    order_id: f.order_id,
    trade_id: f.trade_id,
    ticker: f.market_ticker,
    side: f.side,
    action: 'buy',
    price_dollars: ccD(f.price_cc != null ? f.price_cc : f.price_cents * P.CC_PER_CENT),
    count_fp: ufp(f.count),
    is_taker: !!f.is_taker,
    fee_dollars: dollars(f.fee_cents),
    fee_exact_dollars: f.fee_micro == null ? null : (f.fee_micro / 1e6).toFixed(6),
    created_time: new Date(f.created_ts ?? f.ts).toISOString(),
  };
}

module.exports = { marketVo, eventVo, seriesVo, orderVo, fillVo, scalarVo };
