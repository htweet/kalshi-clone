// Shared helpers: escaping, formatting, local storage with expiry (spec §8.2 pattern).
import { ts } from './i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import './content/lib-strings.js';
import { vars } from './dynstyle.js';
import { uiPrefs } from './prefs.js';
import { fmtDate } from './currency.js'; // display currency, locale and time zone (CLONE_SPEC.md §30)
// Money and contract prices are formatted by currency.js only (₦ by default, $ / ¢ when an admin switches to USD).
export { money, pxc, px, money0, moneyCents, moneyCompact, pxCents, priceUnit, sym, contractValue, amountLabel, toApiDollars, fromApiDollars, moneyStep, moneyMin, validMoneyInput, moneyInputHint, assetPrice, assetDecimals, fmtDt, fmtDate, fmtDay, fmtDateTime, fmtTime, dayKey, currency, isNgn } from './currency.js';
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const cents = (dollarStr) => (dollarStr == null ? null : Math.round(Number(dollarStr) * 100));
// Phase 5A (CLONE_SPEC.md §28.1): prices are 4-decimal dollar strings on the market's grid; cc = $0.0001 (1¢ = 100 cc).
export const ccOf = (dollarStr) => (dollarStr == null ? null : Math.round(Number(dollarStr) * 10000));
export const ccDollars = (cc) => (cc / 10000).toFixed(4);
const LINEAR = [{ start: '0.0000', end: '1.0000', step: '0.0100' }];
export const gridBands = (m) => (m && m.price_ranges ? m.price_ranges : LINEAR).map((r) => [ccOf(r.start), ccOf(r.end), ccOf(r.step)]);
export const onGrid = (m, cc) => Number.isInteger(cc) && cc >= 1 && cc <= 9999 && gridBands(m).some(([s, e, st]) => cc >= s && cc <= e && (cc - s) % st === 0);
export const minTickCc = (m) => Math.min(...gridBands(m).map((b) => b[2]));
export function snapCc(m, cc) { // nearest tick at or below cc (within the tradable range)
  let x = Math.max(1, Math.min(9999, Math.round(cc)));
  while (x > 1 && !onGrid(m, x)) x -= 1;
  return onGrid(m, x) ? x : minTickCc(m);
}
// Display estimate of the taker fee (dollars) for c contracts at cc: ceil(0.07·C·P·(1−P)) to the cent, as the server's
// accumulator charges a single fill.
export const feeDollars = (c, cc) => Math.ceil(0.07 * c * (cc / 10000) * (1 - cc / 10000) * 100 - 1e-9) / 100;
export const pct = (dollarStr) => (dollarStr == null ? '—' : `${cents(dollarStr)}%`);
export const qty = (fpStr) => Number(fpStr || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
// Contract quantities: hundredths of a contract (spec §16). Valid when > 0 with at most 2 decimals.
export const validQty = (n, fractional = true) => Number.isFinite(n) && n > 0 && Math.abs(Math.round(n * 100) - n * 100) < 1e-6 && (fractional || Number.isInteger(n));
// Seconds left until an ISO time (countdowns for RFQ quotes).
export const secsLeft = (iso) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 1000));
// Odds display (U2 design choice): YES probability = last trade, else mid of bid/ask.
export function prob(m) {
  if (m.last_price_dollars != null) return cents(m.last_price_dollars);
  if (m.yes_bid_dollars != null && m.yes_ask_dollars != null) return Math.round((cents(m.yes_bid_dollars) + cents(m.yes_ask_dollars)) / 2);
  return null;
}
// Market preview price (Settings › Market preview price type, CLONE_SPEC.md §25.8): the last traded price (default) or
// the current price to buy Yes (best ask). Used for the % pill on cards and the home hero.
export function previewPct(m) {
  if (uiPrefs.market_price_type === 'current_buy') { const a = cents(m.yes_ask_dollars); return a == null ? prob(m) : a; }
  return prob(m);
}
export const showShares = () => uiPrefs.display_mode === 'shares';
// Payout multiplier (U2 design choice): 1 / yes_ask.
export function multiplier(m) {
  const a = cents(m.yes_ask_dollars);
  return a ? `${(100 / a).toFixed(2)}x` : '—';
}
export const deltaCents = (m) => (m.last_price_dollars != null && m.previous_price_dollars != null ? cents(m.last_price_dollars) - cents(m.previous_price_dollars) : 0);
export const eventHref = (e) => `/markets/${(e.series_ticker || '').toLowerCase()}/${e.series_slug || 'event'}/${(e.event_ticker || '').toLowerCase()}`;
export const shortDate = (iso) => fmtDate(iso);

export function setLocalWithExpiry(key, value, ttlMs) {
  try { localStorage.setItem(key, JSON.stringify({ value, expiry: Date.now() + ttlMs })); } catch { /* storage unavailable */ }
}
export function getLocalWithExpiry(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { value, expiry } = JSON.parse(raw);
    if (Date.now() > expiry) { localStorage.removeItem(key); return null; }
    return value;
  } catch { return null; }
}
export function removeLocal(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } }

export function toast(msg, kind = '') {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

export const CATEGORIES = ['Politics', 'Sports', 'Elections', 'Crypto', 'Climate and Weather', 'Economics', 'Entertainment', 'Companies', 'Financials', 'Science and Technology'];
// Short display labels used in navigation (spec §15.1); data keeps the full names.
const CAT_LABELS = { 'Climate and Weather': 'Climate', Entertainment: 'Culture', Financials: 'Finance', 'Science and Technology': ts('lib.cat_labels.tech_science') };
export const catLabel = (c) => CAT_LABELS[c] || c;
export const catSlug = (c) => c.toLowerCase().replace(/[^a-z0-9]+/g, '-');
export const catFromSlug = (s) => CATEGORIES.find((c) => catSlug(c) === s) || null;

// Relative time ("3m ago") for feeds and notifications.
export function relTime(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
// Deterministic avatar colour + initial from a nickname (own generated art, no images).
const AV = ['#4b3fe0', '#0a875c', '#cf2f4b', '#d9480f', '#1c7ed6', '#862e9c', '#2b8a3e', '#c2255c'];
export function avatar(nick, cls = '') {
  const n = String(nick || '?');
  let h = 0; for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `<span class="avatar ${esc(cls)} v-bg"${vars({ '--bg': AV[h % AV.length] })} aria-hidden="true">${esc(n[0].toUpperCase())}</span>`;
}
// Category colour for card icons.
const CAT_COLORS = { politics: '#1c7ed6', sports: '#0a875c', elections: '#4b3fe0', crypto: '#d9480f', 'climate-and-weather': '#0b7285', economics: '#5f3dc4', entertainment: '#c2255c', companies: '#495057', financials: '#2b8a3e', 'science-and-technology': '#1864ab' };
export const catColor = (c) => CAT_COLORS[catSlug(c || '')] || '#4b3fe0';
export const compact = (n) => Number(n || 0).toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });
export const ICON = {
  bell: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 8a5 5 0 0110 0v3.5l1.5 2.5h-13L5 11.5V8z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 16.5a2 2 0 004 0" stroke="currentColor" stroke-width="1.6"/></svg>',
  heart: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M8 14s-5.5-3.3-5.5-7.2A3 3 0 018 5a3 3 0 015.5 1.8C13.5 10.7 8 14 8 14z" fill="currentColor"/></svg>',
  reply: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  bookmark: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M4 2.5h8v11l-4-3-4 3z" fill="currentColor"/></svg>',
  share: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M8 2v8M5 4.8L8 2l3 2.8M3 8.5V13h10V8.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chat: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3.5 4.5h13v8h-7l-4 3v-3h-2z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  star: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill="currentColor"/></svg>',
  grid: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z" fill="currentColor"/></svg>',
  list: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 3h12v2H2zM2 7h12v2H2zM2 11h12v2H2z" fill="currentColor"/></svg>',
  // Header icons (CLONE_SPEC §13.16): trophy (leaderboard), ☰ menu, category index; own line art.
  trophy: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M6 3h8v4a4 4 0 01-8 0V3zM6 5H3.5v1a3 3 0 003 3M14 5h2.5v1a3 3 0 01-3 3M10 11v3M7 17h6M8 14h4v3H8z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  menu: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 5.5h14M3 10h14M3 14.5h14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  catIndex: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true"><path d="M2 3.5h1.5M2 8h1.5M2 12.5h1.5M5.5 3.5H14M5.5 8H14M5.5 12.5H14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  gift: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 8h14v3H3zM4 11h12v6H4zM10 8v9M10 8c-1-3-5-4-5-1.5S8 8 10 8zm0 0c1-3 5-4 5-1.5S12 8 10 8z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
};
