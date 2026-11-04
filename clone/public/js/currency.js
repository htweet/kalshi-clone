// Display currency, locale and time zone (CLONE_SPEC.md §30): the SPA half of the one formatting rule; the server half
// is server/currency.js. Both read the same configuration (Admin › Settings › Currency & defaults), which reaches the page
// in GET /v1/site_config (`display_currency`) and live on the public `display_currency` WebSocket channel.
//
// Display-only. The API keeps every field name and value (`*_dollars` included); this module converts at the edges:
//   NGN (default): a contract pays ₦100, 1 internal cent = ₦1. 64¢ → ₦64, 64.50¢ → ₦64.50, $25.00 → ₦2,500. Perps use the
//                  same ×100 rule for asset prices, notional, margin, funding and P&L. Money inputs take naira:
//                  naira ÷ 100 = the API's dollars (whole naira for deposits, withdrawals and order amounts).
//   USD:           the original display ($25.00, 64¢, 64.5¢); inputs take dollars.
// Only imports the keyed wording module (content/currency-strings.js), so lib.js and every view can use it without cycles.
import { t } from './content/currency-strings.js';
const DEFAULT = { code: 'NGN', symbol: '₦', name: 'Nigerian naira', minor_unit: 'kobo', contract_value: 100, contract_value_display: '₦100', per_internal_dollar: 100, locale: 'en-NG', timezone: 'Africa/Lagos' };
export const currency = { ...DEFAULT };
const listeners = new Set();

const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0); return true; } catch { return false; } };
// Apply a descriptor (site config or a WS push). Returns true when something changed.
export function setCurrency(d) {
  if (!d || typeof d !== 'object' || !['NGN', 'USD'].includes(d.code)) return false;
  const next = {
    ...DEFAULT, ...(d.code === 'USD' ? { symbol: '$', name: 'US dollar', minor_unit: 'cent', contract_value: 1, contract_value_display: '$1.00', per_internal_dollar: 1, locale: 'en-US' } : {}),
    code: d.code, locale: typeof d.locale === 'string' && d.locale ? d.locale : d.code === 'USD' ? 'en-US' : 'en-NG', timezone: typeof d.timezone === 'string' && validTz(d.timezone) ? d.timezone : DEFAULT.timezone,
  };
  const changed = ['code', 'locale', 'timezone'].some((k) => currency[k] !== next[k]);
  Object.assign(currency, next);
  document.documentElement.dataset.currency = currency.code;
  if (changed) for (const fn of listeners) { try { fn(currency); } catch { /* listener errors never block the update */ } }
  return changed;
}
export const onCurrency = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
// Format with another configuration without applying it (Admin › Currency & defaults live preview): swaps the state for
// the synchronous call and restores it; listeners are not told.
export function withCurrency(d, fn) {
  const saved = { ...currency };
  try {
    if (d && ['NGN', 'USD'].includes(d.code)) Object.assign(currency, d.code === 'USD' ? { symbol: '$', per_internal_dollar: 1, contract_value_display: '$1.00' } : { symbol: '₦', per_internal_dollar: 100, contract_value_display: '₦100' }, { code: d.code, locale: d.locale || currency.locale, timezone: validTz(d.timezone) ? d.timezone : currency.timezone });
    return fn();
  } finally { Object.assign(currency, saved); }
}
export const isNgn = () => currency.code !== 'USD';

// ------------------------------------------------------------------------------------------------ money
const num = (n, min, max) => Math.abs(n).toLocaleString(currency.locale, { minimumFractionDigits: min, maximumFractionDigits: max });
const signOf = (n, plus) => (n < 0 ? '-' : plus && n > 0 ? '+' : '');
// Internal cents (integer or fractional) → "₦2,500" / "₦12.35" (kobo only when present) or "$25.00".
export function moneyCents(cents, { plus = false, exact = 0 } = {}) {
  const c = Number(cents || 0);
  if (!isNgn()) { const d = c / 100; return `${signOf(d, plus)}$${num(d, 2, exact ? Math.max(2, exact) : 2)}`; }
  const n = Math.round(c * 10000) / 10000;
  const whole = Math.abs(n * 100 - Math.round(n) * 100) < 1e-6;
  return `${signOf(n, plus)}₦${whole ? num(n, 0, 0) : num(n, 2, Math.max(2, exact))}`;
}
// API dollar string → display money.
export const money = (dollarStr, opts) => moneyCents(Number(dollarStr || 0) * 100, opts);
// Rounded to the whole display unit (volume figures): "₦12,345" / "$123".
export const money0 = (dollars) => (isNgn() ? `₦${num(Math.round(Number(dollars || 0) * 100), 0, 0)}` : `$${num(Math.round(Number(dollars || 0)), 0, 0)}`);
// Compact (chart axes, tiles): "₦1.2M" / "$12K".
export const moneyCompact = (dollars) => { const v = Number(dollars || 0) * currency.per_internal_dollar; return `${signOf(v)}${currency.symbol}${Math.abs(v).toLocaleString(currency.locale, { notation: 'compact', maximumFractionDigits: 1 })}`; };

// ------------------------------------------------------------------------------------------------ contract prices
// Centi-cents (1¢ = 100 cc) → "₦45" / "₦45.30" or "45¢" / "45.3¢".
export function pxc(cc) {
  if (cc == null || !Number.isFinite(Number(cc))) return '—';
  const v = Number(cc) / 100;
  if (!isNgn()) return `${v.toFixed(2).replace(/\.?0+$/, '')}¢`;
  return `₦${Number.isInteger(v) ? num(v, 0, 0) : num(v, 2, 2)}`;
}
export const px = (dollarStr) => (dollarStr == null ? '—' : pxc(Math.round(Number(dollarStr) * 10000)));
export const pxCents = (c) => (c == null ? '—' : pxc(Number(c) * 100)); // whole-cent integers (alerts, thresholds)
export const priceUnit = () => (isNgn() ? '₦' : '¢'); // price inputs: the number is the same in both (64 = ₦64 = 64¢)
export const sym = () => currency.symbol;
export const contractValue = () => currency.contract_value_display; // "₦100" / "$1.00"
export const amountLabel = () => t(`currency.mode.${isNgn() ? 'NGN' : 'USD'}`); // the ticket's amount mode: Naira / Dollars

// ------------------------------------------------------------------------------------------------ money inputs
// A money input holds display units (naira or dollars); the API takes dollars with at most 2 decimals.
export const toApiDollars = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round((isNgn() ? n / 100 : n) * 100) / 100 : NaN; };
export const fromApiDollars = (d) => (d == null || d === '' ? '' : String(Math.round(Number(d) * currency.per_internal_dollar * 100) / 100));
export const moneyStep = () => (isNgn() ? '1' : '0.01');
export const moneyMin = () => (isNgn() ? '1' : '0.01');
// Whole naira (NGN) or at most 2 dollar decimals (USD), and positive.
export const validMoneyInput = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 && (isNgn() ? Number.isInteger(n) : Math.abs(Math.round(n * 100) - n * 100) < 1e-6); };
export const moneyInputHint = () => t(`currency.hint.${isNgn() ? 'NGN' : 'USD'}`);

// ------------------------------------------------------------------------------------------------ perps (asset prices)
// Internal dollars with the market's decimals; NGN scales ×100 and drops two decimals (BTC $96,250.00 → ₦9,625,000).
export const assetDecimals = (decimals = 2) => (isNgn() ? Math.max(0, decimals - 2) : decimals);
export function assetPrice(dollars, decimals = 2, { plus = false } = {}) {
  const d = Number(dollars || 0);
  const dec = assetDecimals(decimals);
  return `${signOf(d, plus)}${currency.symbol}${num(d * currency.per_internal_dollar, dec, dec)}`;
}
// Display units ↔ API dollars for perps price inputs (a $0.0001 tick is ₦0.01).
export const assetToApi = (v) => Number(v) / currency.per_internal_dollar;
export const assetFromApi = (d) => Number(d) * currency.per_internal_dollar;

// ------------------------------------------------------------------------------------------------ dates (locale + zone)
export const fmtDt = (x, opts = {}) => { try { return new Intl.DateTimeFormat(currency.locale, { timeZone: currency.timezone, ...opts }).format(new Date(x)); } catch { return ''; } };
export const fmtDate = (x) => fmtDt(x, { day: 'numeric', month: 'short', year: 'numeric' });
export const fmtDay = (x) => fmtDt(x, { day: 'numeric', month: 'short' });
export const fmtDateTime = (x) => fmtDt(x, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const fmtTime = (x, seconds = false) => fmtDt(x, { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) });
// YYYY-MM-DD of an instant in the configured zone (calendar sections are local days, server/currency.js dayKey).
export function dayKey(x = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: currency.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(x)).map((q) => [q.type, q.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
