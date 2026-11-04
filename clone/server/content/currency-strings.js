'use strict';
// Server-side user-facing wording added or changed with the display currency (CLONE_SPEC.md §30), as keyed templates
// with named variables ({amount}, {price}, …) so a later CMS phase can manage them without touching code. Amounts and
// prices are formatted by server/currency.js before they are substituted; this module holds words only.
const STRINGS = {
  // descriptor (GET /v1/exchange/display_currency)
  'currency.name.NGN': 'Nigerian naira',
  'currency.name.USD': 'US dollar',
  'currency.rule.NGN': 'display-only: 1 internal cent = ₦1 (a contract pays ₦100); sandbox display rule, not an FX rate',
  'currency.rule.USD': 'display-only: amounts as US dollars and cents',
  'currency.unit.whole.NGN': 'naira',
  'currency.unit.whole.USD': 'cents',

  // order and price validation
  'error.price_range': 'price must be between {min} and {max} (sub-cent ticks where the market allows them)',
  'error.price_range_cc': 'price must be between {min} and {max} ({minCent} to {maxCent} on whole-cent markets)',
  'error.amount_min': 'amount_dollars must be at least 0.01 ({min})',
  'error.order_reserve': 'order requires {amount} including max fees',
  'error.grid_ticks': "{name} must be on the market's price grid ({ticks})",
  'error.grid_ticks.linear': '{tick} ticks',
  'error.grid_ticks.other': '{grid} ticks',
  'error.bids_exceed': 'yes_bid + no_bid must not exceed {max}',
  'error.trade_cost': 'this trade costs {amount} including fees',
  'error.limit_per_day': 'limit {limit} per day',
  'error.promo_amount': 'a positive amount up to {max} with at most 2 decimals of amount_dollars',
  'error.reward_pool': 'must be between {min} and {max}',
  'error.adjust_amount': 'enter a non-zero amount with at most 2 decimals (up to {max})',
  'error.limit_override': 'an amount per day up to {max} (value is in dollars: up to 100,000), or empty to remove',
  'error.perps_tick': 'price must be a multiple of the {tick} tick',
  'error.perps_margin': 'this order needs {need} of margin and fees; you have {available} available in Perps',
  'error.perps_transfer_min': 'amount must be at least {min}, in whole {unit}',
  'error.perps_cash': 'you have {amount} of prediction cash',
  'error.perps_credits': 'you can move up to {amount} of cash',
  'error.perps_available': 'you have {amount} available in Perps',

  // ledger memos and history
  'memo.taker_fee': 'taker fee (exact {amount})',
  'memo.settled_scalar': 'settled at {price} per YES',
  'memo.correction_scalar': 'now {price} per YES',
  'history.settlement': 'Market settled {result} · cost {amount}',
  'history.rfq_target': 'RFQ for {amount} target',
  'resolution.scalar_label': '{price} per YES',

  // notifications (in-app, push and the dev-mailbox email share the title and body)
  'notify.settlement.title': 'Market settled {result} · paid {amount}',
  'notify.price_alert.title': 'Price alert: Yes is {price} ({direction} {target})',
  'notify.withdrawal_review.body': 'Your withdrawal of {amount} is being reviewed. This usually takes less than one business day.',
  'notify.withdrawal_released.body': 'Your withdrawal of {amount} was approved.',
  'notify.withdrawal_reversed.body': 'Your withdrawal of {amount} was returned to your balance.',
  'notify.correction_paid.body': 'You were paid {amount} more. Reason: {reason}',
  'notify.correction_clawback.body': '{amount} was taken back from your balance.{owed} Reason: {reason}',
  'notify.correction_clawback.owed': ' Your cash is now negative ({amount} owed); withdrawals are paused until a deposit repays it.',
  'notify.promo.title': 'Promo code applied: {amount} credit',
  'notify.market_reward.title': 'Liquidity reward paid · {amount}',
  'notify.balance_adjust.title': 'Balance {direction}: {amount}',
  'notify.balance_adjust.credit': 'credit',
  'notify.balance_adjust.debit': 'debit',
  'notify.order_done.title': 'Order {verb}: {count} {side} @ avg {price}',
  'notify.transfer.title': '{kind} of {amount} completed',
  'notify.transfer.body': 'Cash balance {amount}',
  'notify.price_move.title': '{market} moved {arrow} {move} in {window} (now {price})',
  'notify.trade_alert.title': '@{nickname} {verb} {count} {side} · {market} @ {price}',
  'notify.perps_liquidation.body': 'Equity fell below maintenance margin. Returned {amount} to your Perps balance.',
  'notify.perps_funding.title': 'Funding {direction}: {amount} on {market}',
  'notify.perps_transfer.title': 'Transferred {amount} {destination}',

  // statements (PDF)
  'statement.currency_line': 'Amounts in {name} ({code}); {rule}.',
  'statement.generated': 'Generated {local} ({iso})',

  // content written with prices (series rules, seeded and rolling markets, notification settings)
  'rules.contract_pays': 'Each contract pays {value} if its outcome occurs, otherwise {zero}.',
  'rules.series_contract_pays': 'Contracts in the {series} series resolve from the named settlement source. Each contract pays {value} if its outcome occurs, otherwise {zero}.',
  'rules.sports_contract_pays': 'Each {league} market resolves to the official final result recorded by the Parlance Sports Desk when the game ends. A contract pays {value} if its outcome occurs, otherwise {zero}.',
  'rules.scalar_contract_pays': 'Scalar contracts pay a fraction of {value} set by the reported value within the published floor and cap.',
  'combos.description': 'Pick 2 to 6 outcomes from different events. The combo pays {value} per contract only if every leg hits.',
  'rolling.event_title': 'PLX token above {target} at {time}?',
  'rolling.market_title': 'PLX token above {target}?',
  'rolling.closes': 'Closes {time}',
  'rolling.rules': 'Resolves YES if the PLX index at {time} is above {target}.',
  'seed.plxcoin.title': 'Will the PLX token close above {target} on Dec 31?',
  'seed.plxcoin.yes': 'Above {target}',
  'seed.plxcoin.no': 'At or below {target}',
  'seed.gdp.rules': 'Scalar market. At expiration the Harbor statistics office first estimate of Q4 2026 annualized GDP growth sets the payout: each YES contract pays (growth − (−2%)) ÷ 8% of {value}, clamped between {zero} and {value}; each NO contract pays the rest. Example: 1.8% growth pays {yes} per YES and {no} per NO.',
  'seed.snow.rules': 'If the harbor weather station records measurable snowfall before December 15, this market resolves YES. Otherwise it resolves NO. Prices move in {tick} steps.',
  'seed.comet.rules': 'If two observatories report Comet Ardent at magnitude 6 or brighter before December 31, 2026, this market resolves YES. Otherwise it resolves NO. Ticks are finer near {low} and {high} (tapered grid).',
  'notify_prefs.price_move_threshold': 'Alert when the price moves by at least ({unit})',
  'admin.segment.funded': 'Funded accounts (cash > {zero})',
};

// Fill a template: `{name}` → vars.name (left as is when the variable is missing). An admin override published in
// Admin › Content › Texts (key `server.currency.<key>`, CLONE_SPEC.md §32.3) replaces the default.
const catalog = require('./catalog');
function t(key, vars = {}) {
  const s = catalog.override(`server.currency.${key}`) ?? (Object.prototype.hasOwnProperty.call(STRINGS, key) ? STRINGS[key] : key);
  return s.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}

module.exports = { STRINGS, t };
