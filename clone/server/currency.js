'use strict';
// Display currency and new-account defaults (CLONE_SPEC.md §30). The server half of the one formatting rule; the SPA
// half is public/js/currency.js, and both read the same configuration (admin_settings `display_currency`, served by
// GET /v1/exchange/display_currency and pushed on the public `display_currency` WebSocket channel when it changes).
//
// The rule is display-only. Engine, ledger, journal and database units never change: money columns stay integer
// cents, prices stay centi-cents (cc, 1¢ = 100 cc), API fields keep their names and values (`*_dollars` included).
//   NGN (default): a contract pays ₦100, so 1 internal cent = ₦1. 64¢ shows as ₦64, 64.50¢ (cc 6450) as ₦64.50,
//                  an internal $25.00 (2,500 cents) as ₦2,500. Perps use the same ×100 rule for asset prices, notional,
//                  margin, funding and P&L, so nothing on a page mixes currencies. A sandbox display rule, not an FX rate.
//   USD:           the original display: $25.00, 64¢, 64.5¢.
// Percent odds and payout multipliers are currency-free and unchanged. Words live in server/content/currency-strings.js.
const CS = require('./content/currency-strings');
const CURRENCIES = {
  NGN: { code: 'NGN', symbol: '₦', minor_unit: 'kobo', minor_units_per_major: 100, per_internal_dollar: 100, contract_value: 100, contract_value_display: '₦100', default_locale: 'en-NG' },
  USD: { code: 'USD', symbol: '$', minor_unit: 'cent', minor_units_per_major: 100, per_internal_dollar: 1, contract_value: 1, contract_value_display: '$1.00', default_locale: 'en-US' },
};
const CODES = Object.keys(CURRENCIES);
const DEFAULT_CONFIG = { code: 'NGN', locale: 'en-NG', timezone: 'Africa/Lagos' };
const LOCALES = ['en-NG', 'en-US', 'en-GB'];
const THEMES = ['system', 'light', 'dark'];
const CHANNELS = ['in_app', 'email', 'push'];
// Defaults applied to NEW accounts only (written to the account's settings when it is created; existing accounts keep
// whatever they saved, or the built-in defaults they already had).
const DEFAULT_ACCOUNT = { theme: 'dark', order_review: true, flip_sell: false, display_mode: 'payout', notification_channels: { in_app: true, email: true, push: true } };

const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0); return true; } catch { return false; } };

let cfg = { ...DEFAULT_CONFIG };
let acct = JSON.parse(JSON.stringify(DEFAULT_ACCOUNT));
const cur = () => CURRENCIES[cfg.code] || CURRENCIES.NGN;

// ------------------------------------------------------------------------------------------------ configuration
function normalizeConfig(v) {
  const o = v && typeof v === 'object' ? v : {};
  const code = CODES.includes(o.code) ? o.code : DEFAULT_CONFIG.code;
  return { code, locale: LOCALES.includes(o.locale) ? o.locale : CURRENCIES[code].default_locale, timezone: typeof o.timezone === 'string' && validTz(o.timezone) ? o.timezone : DEFAULT_CONFIG.timezone };
}
function normalizeAccount(v) {
  const o = v && typeof v === 'object' ? v : {};
  const ch = o.notification_channels && typeof o.notification_channels === 'object' ? o.notification_channels : {};
  return {
    theme: THEMES.includes(o.theme) ? o.theme : DEFAULT_ACCOUNT.theme,
    order_review: typeof o.order_review === 'boolean' ? o.order_review : DEFAULT_ACCOUNT.order_review,
    flip_sell: typeof o.flip_sell === 'boolean' ? o.flip_sell : DEFAULT_ACCOUNT.flip_sell,
    display_mode: ['payout', 'shares'].includes(o.display_mode) ? o.display_mode : DEFAULT_ACCOUNT.display_mode,
    notification_channels: Object.fromEntries(CHANNELS.map((c) => [c, typeof ch[c] === 'boolean' ? ch[c] : DEFAULT_ACCOUNT.notification_channels[c]])),
  };
}
const configure = (config, account) => { if (config !== undefined) cfg = normalizeConfig(config); if (account !== undefined) acct = normalizeAccount(account); };
const config = () => ({ ...cfg });
const accountDefaults = () => JSON.parse(JSON.stringify(acct));

// The public descriptor (GET /v1/exchange/display_currency, site config, WS `display_currency`).
function descriptor(c = cfg) {
  const x = CURRENCIES[c.code] || CURRENCIES.NGN;
  return {
    code: x.code, symbol: x.symbol, name: CS.t(`currency.name.${x.code}`), minor_unit: x.minor_unit, minor_units_per_major: x.minor_units_per_major,
    contract_value: x.contract_value, contract_value_display: x.contract_value_display, locale: c.locale, timezone: c.timezone,
    // How to read the API (field names and values are unchanged): display = *_dollars × per_internal_dollar.
    per_internal_dollar: x.per_internal_dollar, rule: CS.t(`currency.rule.${x.code}`),
    supported: CODES,
  };
}

// ------------------------------------------------------------------------------------------------ formatting
const num = (n, min, max) => Math.abs(n).toLocaleString(cfg.locale, { minimumFractionDigits: min, maximumFractionDigits: max });
const signOf = (n, plus) => (n < 0 ? '-' : plus && n > 0 ? '+' : '');
// Money from internal cents (integer or fractional). NGN: whole naira, kobo only when the amount has them
// (`exact` keeps up to that many naira decimals for sub-kobo values such as exact fee accruals). USD: 2 decimals.
function moneyCents(cents, { plus = false, exact = 0 } = {}) {
  const c = Number(cents || 0);
  if (cfg.code === 'USD') { const d = c / 100; const dec = exact ? Math.max(2, exact) : 2; return `${signOf(d, plus)}$${num(d, 2, dec)}`; }
  const n = Math.round(c * 10000) / 10000;
  const whole = Math.abs(n * 100 - Math.round(n) * 100) < 1e-6;
  return `${signOf(n, plus)}₦${whole ? num(n, 0, 0) : num(n, 2, Math.max(2, exact))}`;
}
const moneyDollars = (d, opts) => moneyCents(Number(d || 0) * 100, opts);
// Contract price from centi-cents (cc). USD keeps the cent display (45¢, 45.3¢); NGN shows naira with kobo when the
// grid has them (₦45, ₦45.30).
function priceCc(cc) {
  if (cc == null || !Number.isFinite(Number(cc))) return '—';
  const v = Number(cc) / 100;
  if (cfg.code === 'USD') return `${v.toFixed(2).replace(/\.?0+$/, '')}¢`;
  return `₦${Number.isInteger(v) ? num(v, 0, 0) : num(v, 2, 2)}`;
}
const priceCents = (c) => priceCc(c == null ? null : Number(c) * 100);
const priceDollars = (d) => priceCc(d == null ? null : Math.round(Number(d) * 10000));
const priceUnit = () => (cfg.code === 'USD' ? '¢' : '₦'); // input labels: "Price (₦)"
const symbol = () => cur().symbol;
const contractValue = () => cur().contract_value_display; // "₦100" / "$1.00"
// Perps underlying asset prices (internal dollars) with the market's decimals; NGN scales ×100 and drops two decimals.
function assetPrice(dollars, decimals = 2) {
  const d = Number(dollars || 0);
  if (cfg.code === 'USD') return `${signOf(d)}$${num(d, decimals, decimals)}`;
  const dec = Math.max(0, decimals - 2);
  return `${signOf(d)}₦${num(d * 100, dec, dec)}`;
}

// CSV exports: plain numbers in the display unit (no symbol, no grouping) so spreadsheets read them, and the column
// named after the currency. USD keeps the original column names (`amount_usd`, `price_dollars`, …) and values.
const csvCents = (cents) => (cents == null || cents === '' ? '' : cfg.code === 'USD' ? (Number(cents) / 100).toFixed(2) : Number(cents).toFixed(2));
const csvDollars = (d) => (d == null || d === '' ? '' : csvCents(Number(d) * 100));
const csvCol = (base, usdName) => (cfg.code === 'USD' ? usdName : `${base}_${cfg.code.toLowerCase()}`);

// ------------------------------------------------------------------------------------------------ dates (locale + zone)
const dt = (ms, opts) => new Intl.DateTimeFormat(cfg.locale, { timeZone: cfg.timezone, ...opts }).format(new Date(ms));
const dateLabel = (ms) => dt(ms, { day: 'numeric', month: 'short', year: 'numeric' });
const dateTimeLabel = (ms) => dt(ms, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
const timeLabel = (ms) => dt(ms, { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
// YYYY-MM-DD of `ms` in the configured zone (calendar sections are local days).
function dayKey(ms = Date.now(), tz = cfg.timezone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// ------------------------------------------------------------------------------------------------ new accounts
// Called right after a user row is inserted (sign-up, OAuth sign-up): writes the configured defaults as the account's
// own settings and notification channels. Never touches an existing account.
function applyAccountDefaults(db, uid, nowIso = new Date().toISOString()) {
  const a = acct;
  const put = db.prepare('INSERT INTO user_settings(user_id,key,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,key) DO NOTHING');
  put.run(uid, 'theme', JSON.stringify(a.theme), nowIso);
  put.run(uid, 'display_mode', JSON.stringify(a.display_mode), nowIso);
  put.run(uid, 'trade_skip_review', JSON.stringify(!a.order_review), nowIso);
  put.run(uid, 'trade_flip_sell', JSON.stringify(a.flip_sell), nowIso);
  const off = CHANNELS.filter((c) => a.notification_channels[c] === false);
  const hasPrefs = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notif_prefs'").get();
  if (off.length && hasPrefs && hooks.channelTypes) {
    const types = {};
    for (const t of hooks.channelTypes()) for (const c of off) if (t.offered.includes(c)) (types[t.key] ||= {})[c] = false;
    db.prepare("INSERT INTO notif_prefs(user_id,types,quiet,security,pm_held,updated_at) VALUES(?,?,'{}',1,0,?) ON CONFLICT(user_id) DO NOTHING").run(uid, JSON.stringify(types), nowIso);
  }
}
const hooks = { channelTypes: null }; // set by server/notify-prefs.js: the matrix rows and the channels each offers

module.exports = {
  CURRENCIES, CODES, LOCALES, THEMES, CHANNELS, DEFAULT_CONFIG, DEFAULT_ACCOUNT, validTz, normalizeConfig, normalizeAccount,
  configure, config, accountDefaults, descriptor, moneyCents, moneyDollars, priceCc, priceCents, priceDollars, priceUnit, symbol, contractValue,
  assetPrice, csvCents, csvDollars, csvCol, dt, dateLabel, dateTimeLabel, timeLabel, dayKey, applyAccountDefaults, hooks,
};
