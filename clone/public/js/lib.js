// Shared helpers: escaping, formatting, local storage with expiry (spec §8.2 pattern).
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const cents = (dollarStr) => (dollarStr == null ? null : Math.round(Number(dollarStr) * 100));
export const pct = (dollarStr) => (dollarStr == null ? '—' : `${cents(dollarStr)}%`);
export const money = (dollarStr) => {
  const n = Number(dollarStr || 0);
  return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
export const qty = (fpStr) => Number(fpStr || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
// Odds display (U2 design choice): YES probability = last trade, else mid of bid/ask.
export function prob(m) {
  if (m.last_price_dollars != null) return cents(m.last_price_dollars);
  if (m.yes_bid_dollars != null && m.yes_ask_dollars != null) return Math.round((cents(m.yes_bid_dollars) + cents(m.yes_ask_dollars)) / 2);
  return null;
}
// Payout multiplier (U2 design choice): 1 / yes_ask.
export function multiplier(m) {
  const a = cents(m.yes_ask_dollars);
  return a ? `${(100 / a).toFixed(2)}x` : '—';
}
export const deltaCents = (m) => (m.last_price_dollars != null && m.previous_price_dollars != null ? cents(m.last_price_dollars) - cents(m.previous_price_dollars) : 0);
export const eventHref = (e) => `/markets/${(e.series_ticker || '').toLowerCase()}/${e.series_slug || 'event'}/${(e.event_ticker || '').toLowerCase()}`;
export const shortDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

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

export const CATEGORIES = ['Politics', 'Sports', 'Culture', 'Crypto', 'Climate', 'Economics', 'Companies', 'Financials', 'Tech & Science'];
export const catSlug = (c) => c.toLowerCase().replace(/[^a-z0-9]+/g, '-');
export const catFromSlug = (s) => CATEGORIES.find((c) => catSlug(c) === s) || null;
