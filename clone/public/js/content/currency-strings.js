// SPA user-facing wording added or changed with the display currency (CLONE_SPEC.md §30), keyed so a later CMS phase
// can manage it without touching views. Templates take named variables ({unit}, {amount}, …); amounts and prices are
// formatted by currency.js before they are substituted. No imports (any module can use it).
export const STRINGS = {
  // amount modes and units
  'currency.mode.NGN': 'Naira',
  'currency.mode.USD': 'Dollars',
  'currency.hint.NGN': 'whole naira',
  'currency.hint.USD': 'dollars and cents',
  'currency.per_day': '{mode} per day',
  // inputs and labels
  'input.amount_placeholder': 'Amount {symbol}',
  'input.amount_aria': 'Amount in {mode}',
  'input.transfer_aria': 'Transfer amount in {mode}',
  'input.amount_code': 'Amount ({code})',
  'input.amount_symbol': 'Amount ({symbol})',
  'input.limit_price': 'Limit price ({unit})',
  'input.sell_at': 'Sell at ({unit})',
  'input.price': 'Price ({unit})',
  'input.quote': 'Quote ({unit})',
  'input.yes_bid': 'Yes bid ({unit})',
  'input.no_bid': 'No bid ({unit})',
  'input.move_threshold': 'Notify me when the price moves by at least ({unit})',
  // validation
  'error.amount_whole': 'Enter a whole number of naira.',
  'error.amount_cents': 'Enter an amount with at most 2 decimals.',
  'error.amount_positive': 'Enter an amount greater than {zero} ({hint}).',
  'error.amount_in': 'Enter an amount in {hint}.',
  'error.amount_at_least': 'Enter at least {min} ({hint}).',
  'error.price_between': 'Enter a price between {min} and {max} (sub-cent ticks where the market allows them).',
  'error.bids_fine': 'Bids are prices from {min} to {max} ({step} steps; {fine} within {edge} of the edges).',
  'error.bids_whole': 'Bids are whole prices from {min} to {max}.',
  'error.bids_exceed': 'Yes bid + No bid cannot exceed {max}.',
  // ticket and portfolio copy
  'ticket.scalar_note_tail': 'of {value}, NO the rest.',
  'ticket.scalar_card': 'YES pays a share of {value} set by the reported value between {floor} (pays {zero}) and {cap} (pays {value}):',
  'ticket.payout_range': '{zero} to {max}',
  'portfolio.proceeds_at': 'Proceeds if filled at {price}: {amount} before fees',
  'settings.shares_example': 'Yes and No share prices, e.g. Yes {price}',
  // admin labels
  'admin.spread': 'Spread ({unit}, 2-40)',
  'admin.volume': 'Volume ({symbol})',
  'admin.volume_per_day': 'Volume ({symbol}) per day',
  'admin.adjust_amount': 'Amount in {mode} (negative = debit)',
  'admin.limit_deposit': 'Deposit ({symbol}/day)',
  'admin.limit_trading': 'Trading ({symbol}/day)',
  'admin.promo_credit': 'Credit ({code})',
  'admin.reward_pool': 'Reward pool ({symbol})',
  'admin.spread_window': 'Spread window ({unit})',
  'admin.discount': 'Discount per {price} behind best',
  'admin.seed_spread': 'Seed spread ({unit})',
  'admin.starting_price': 'Starting price ({unit})',
  // Admin › Settings › Currency & defaults
  'currency.panel.title': 'Currency & defaults',
  'currency.panel.intro': 'Display only: balances, prices and the API keep their internal units and field names. Under NGN 1 internal cent shows as ₦1 (a contract pays ₦100); perps use the same rule. Existing accounts keep their saved settings; the defaults apply to accounts created from now on.',
  'currency.panel.preview': 'Preview',
  'currency.panel.submit': 'Save currency & defaults',
  'currency.panel.saved': 'Currency & defaults saved · {code} · {timezone}',
  'currency.field.code': 'Display currency',
  'currency.field.code.NGN': 'NGN · Nigerian naira (₦, a contract pays ₦100)',
  'currency.field.code.USD': 'USD · US dollar ($, cents)',
  'currency.field.locale': 'Locale (numbers and dates)',
  'currency.field.timezone': 'Time zone (dates, calendar days, exports, notifications)',
  'currency.field.theme': 'New accounts: theme',
  'currency.field.display_mode': 'New accounts: market preview',
  'currency.field.display_mode.payout': 'Payout and odds',
  'currency.field.display_mode.shares': 'Shares and prices',
  'currency.field.order_review': 'New accounts: review orders before placing',
  'currency.field.flip_sell': 'New accounts: flip sell on',
  'currency.field.channel': 'New accounts: {channel} notifications',
  'currency.field.channel.in_app': 'in-app',
  'currency.field.channel.email': 'email',
  'currency.field.channel.push': 'push',
  'currency.field.reason': 'Reason (required, recorded in the audit log)',
  'currency.locale.en-NG': 'English (Nigeria)',
  'currency.locale.en-US': 'English (United States)',
  'currency.locale.en-GB': 'English (United Kingdom)',
  'currency.preview.price': 'Price (64¢ internal)',
  'currency.preview.fine': 'Fine-grid price (64.50¢)',
  'currency.preview.balance': 'Balance ($25.00 internal)',
  'currency.preview.payout': 'Max payout, 10 contracts',
  'currency.preview.perps': 'Perps BTC level ($96,250)',
  'currency.preview.funding': 'Funding ($0.0123)',
  'currency.preview.datetime': 'Date and time (23:30 UTC)',
  'currency.preview.unit': 'Price input unit',
};

// Fill a template: `{name}` → vars.name (left as is when the variable is missing).
export function t(key, vars = {}) {
  const s = Object.prototype.hasOwnProperty.call(STRINGS, key) ? STRINGS[key] : key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}

// HTML version: the template text is escaped, the variables are inserted as given (callers pass escaped markup).
const escT = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function tHtml(key, vars = {}) {
  const s = Object.prototype.hasOwnProperty.call(STRINGS, key) ? STRINGS[key] : key;
  return escT(s).replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}
