'use strict';
// Server-side wording of Perps completion (PLAN Phase 6, CLONE_SPEC.md §34): API errors, notification titles and
// bodies, statement memos. Keyed templates with named variables; Admin › Content › Texts overrides them as
// `server.perps.<key>` (server/cms/texts.js lists this module). Amounts are formatted by server/currency.js before
// substitution, so the display currency (CLONE_SPEC.md §30) applies.
const catalog = require('./catalog');

const STRINGS = {
  // orders and quantities (fractional rules of CLONE_SPEC.md §16.4)
  'error.count_required': 'count is required',
  'error.count_format': 'count must be a number of contracts with at most 2 decimal places',
  'error.count_min': 'count must be at least 0.01 contracts',
  'error.count_max': 'count must be at most {max} contracts',
  'error.count_mismatch': 'count and count_fp must match',
  'error.fractional': 'fractional contracts are not enabled on this market',
  'error.fractional_details': 'order a whole number of contracts',
  'error.leverage_range': 'leverage must be between 1x and {max}x for {market}',
  // risk limits and tiers
  'error.position_limit': 'this order would exceed the maximum position for {market}',
  'error.position_limit_details': 'the largest position allowed is {max} of notional; this order could reach {size}',
  'error.leverage_tier': 'leverage is above the maximum for this position size',
  'error.leverage_tier_details': 'at a position of {size} the maximum leverage is {max}x',
  'error.open_orders_market': 'you have too many open orders in this market',
  'error.open_orders_total': 'you have too many open perps orders',
  'error.open_orders_details': 'the limit is {limit} open orders; cancel some first',
  'error.portfolio_margin': 'insufficient portfolio margin',
  'error.portfolio_withdraw': 'you can move at most {amount} out of this portfolio subaccount',
  'error.portfolio_withdraw_details': 'the rest of its free collateral backs the initial margin of its open positions; close or reduce positions to free more than {amount}',
  'error.portfolio_margin_details': 'after this order your subaccount equity would be {equity}, below the {required} of initial margin its positions need',
  // amend / decrease
  'error.amend_not_resting': 'only resting orders can be amended or decreased',
  'error.amend_nothing': 'send a new price and/or count',
  'error.decrease_args': 'send reduce_by or reduce_to (contracts)',
  'error.decrease_more': 'an order can only be decreased; use amend to increase it',
  // subaccounts
  'error.sub_number': 'subaccount must be a whole number from 0 to {max}',
  'error.sub_not_found': 'subaccount not found',
  'error.sub_limit': 'you can have at most {limit} subaccounts',
  'error.sub_name': 'name must be 1-40 characters',
  'error.sub_mode': 'margin_mode must be isolated or cross',
  'error.sub_mode_busy': 'close every position and cancel every order in this subaccount before changing its margin mode',
  'error.sub_same': 'choose two different subaccounts',
  'error.sub_funds': 'you have {amount} available in this subaccount',
  'error.transfer_min': 'amount must be at least {min}, in whole {unit}',
  // order groups
  'error.group_not_found': 'order group not found',
  'error.group_inactive': 'this order group is {status}; reset it or use another group',
  'error.group_subaccount': 'this order group belongs to subaccount {sub}',
  'error.group_limit': 'you can have at most {limit} active order groups',
  'error.group_orders': 'an order group holds at most {limit} open orders',
  'error.group_kind': 'kind must be limit or oco',
  'error.group_contracts': 'contracts_limit must be a number of contracts with at most 2 decimals, at least 0.01',
  // exit triggers
  'error.trigger_kind': 'kind must be bracket or trailing',
  'error.trailing_args': 'send trail_percent (0.1 to 50) or trail_amount (a positive price distance per contract)',
  'error.trailing_percent': 'trail_percent must be between 0.1 and 50',
  // waitlist / referrals / apy
  'error.waitlist': 'Perps access is by invitation while the waitlist is on',
  'error.waitlist_details': 'join the waitlist on the Perps page; we will let you know when your access is unlocked',
  'error.referral_code': 'that referral code is not valid',
  'error.referral_self': 'you cannot use your own referral code',
  'error.referral_used': 'you already joined with a referral code',
  'error.referral_late': 'referral codes can only be added before your first Perps trade and within {days} days of signing up',
  'error.referral_off': 'the Perps referral program is not running right now',
  'error.referral_rate': 'too many attempts; try again in a minute',
  // notifications (titles and bodies; the CMS templates notify.<type> wrap them)
  'notify.waitlist_joined.title': 'You joined the Perps waitlist',
  'notify.waitlist_joined.body': 'You are number {position} in line. We will let you know as soon as your access is unlocked.',
  'notify.waitlist_approved.title': 'Your Perps access is unlocked',
  'notify.waitlist_approved.body': 'You can now move funds to Perps and trade perpetual futures.',
  'notify.apy.title': 'Perps interest: {amount}',
  'notify.apy.body': 'Interest on your Perps collateral at {rate}% a year.',
  'notify.apy.queued': 'Interest of {amount} is queued and will be paid when the rewards budget is funded.',
  'notify.referral.title': 'Referral reward: {amount}',
  'notify.referral.body_referrer': 'Someone you referred started trading Perps. {amount} is in your Perps balance.',
  'notify.referral.body_referee': 'Welcome to Perps: your referral bonus of {amount} is in your Perps balance.',
  'notify.referral.queued': 'Your referral reward of {amount} is queued and will be paid when the rewards budget is funded.',
  'notify.trailing.title': 'Trailing stop hit: closed {side} {count} {market} at {price}',
  'notify.group.title': 'Order group {kind} triggered: {count} orders canceled',
  // statement memos (perp_ledger)
  'memo.apy': 'Perps interest',
  'memo.referral_referrer': 'Perps referral reward',
  'memo.referral_referee': 'Perps referral bonus',
  'memo.sub_transfer_out': 'to subaccount {to}',
  'memo.sub_transfer_in': 'from subaccount {from}',
  'name.primary': 'Primary',
};
const s = catalog.scoped('server.perps.', STRINGS);

module.exports = { STRINGS, s };
