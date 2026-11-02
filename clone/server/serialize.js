'use strict';
const { dollars, fp } = require('./util');

function marketVo(m, q) {
  return {
    ticker: m.ticker,
    event_ticker: m.event_ticker,
    market_type: 'binary',
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
    yes_bid_dollars: dollars(q.yes_bid),
    yes_ask_dollars: dollars(q.yes_ask),
    no_bid_dollars: dollars(q.no_bid),
    no_ask_dollars: dollars(q.no_ask),
    yes_bid_size_fp: fp(q.yes_bid_size),
    yes_ask_size_fp: fp(q.yes_ask_size),
    last_price_dollars: dollars(q.last_price),
    previous_price_dollars: dollars(q.previous_price),
    previous_hour_price_dollars: dollars(q.previous_hour_price),
    previous_day_price_dollars: dollars(q.previous_price),
    previous_week_price_dollars: dollars(q.previous_week_price),
    volume_fp: fp(q.volume),
    volume_24h_fp: fp(q.volume_24h),
    open_interest_fp: fp(q.open_interest),
    notional_value_dollars: '1.0000',
    price_level_structure: 'linear_cent',
    price_ranges: [{ start: '0.0000', end: '1.0000', step: '0.0100' }],
    updated_time: m.updated_at,
    created_time: m.created_at,
  };
}

function eventVo(e, markets) {
  const vo = {
    event_ticker: e.ticker,
    series_ticker: e.series_ticker,
    title: e.title,
    sub_title: e.sub_title,
    category: e.category,
    mutually_exclusive: !!e.mutually_exclusive,
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
    price_dollars: dollars(o.price_cents),
    initial_count_fp: fp(o.initial_count),
    remaining_count_fp: fp(o.remaining_count),
    fill_count_fp: fp(o.filled_count),
    taker_fees_dollars: dollars(o.fees_cents),
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
    price_dollars: dollars(f.price_cents),
    count_fp: fp(f.count),
    is_taker: !!f.is_taker,
    fee_dollars: dollars(f.fee_cents),
    created_time: new Date(f.created_ts ?? f.ts).toISOString(),
  };
}

module.exports = { marketVo, eventVo, seriesVo, orderVo, fillVo };
