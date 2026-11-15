// Pieces shared by the layout variants (CLONE_SPEC.md §44): the visitor landing page (views/landing.js) and the new
// member home (views/home-new.js). Own artwork only: illustrations are drawn here as SVG (no photos, logos or brands).
import { t as tx, te } from '../i18n.js';
import '../content/landing-strings.js';
import { esc, cents, fmtDt, catSlug, catLabel } from '../lib.js';
import { slotImg } from '../content-live.js';
import { vars } from '../dynstyle.js';
import { money0 } from './components.js';

// Promo illustrations (Admin › Content › Promo cards › Illustration). Static markup.
export const ART = {
  candles: '<svg viewBox="0 0 88 64" aria-hidden="true"><g stroke="var(--yes)" stroke-width="1.6"><path d="M14 18v34M34 8v30M54 22v34M74 4v26"/></g><g fill="var(--yes)"><rect x="10" y="26" width="8" height="18" rx="2"/><rect x="30" y="14" width="8" height="16" rx="2" opacity=".55"/><rect x="50" y="30" width="8" height="18" rx="2"/><rect x="70" y="10" width="8" height="14" rx="2" opacity=".55"/></g></svg>',
  coins: '<svg viewBox="0 0 88 64" aria-hidden="true"><g fill="none" stroke="var(--brand)" stroke-width="2"><ellipse cx="36" cy="40" rx="20" ry="20" fill="var(--brand-x20)"/><ellipse cx="58" cy="26" rx="18" ry="18" fill="var(--surface-x30)"/></g><text x="36" y="47" text-anchor="middle" font-size="20" font-weight="700" fill="var(--brand)">₦</text><text x="58" y="33" text-anchor="middle" font-size="18" font-weight="700" fill="var(--brand)">%</text></svg>',
  map: '<svg viewBox="0 0 88 64" aria-hidden="true"><g stroke="var(--surface-x20)" stroke-width="1.5"><path d="M8 10h18v14H8z" fill="#3b6fd8"/><path d="M26 10h20v10H26z" fill="#d9485f"/><path d="M46 10h16v16H46z" fill="#3b6fd8"/><path d="M62 10h18v12H62z" fill="#d9485f"/><path d="M8 24h14v16H8z" fill="#d9485f"/><path d="M22 20h22v18H22z" fill="#3b6fd8"/><path d="M44 26h20v14H44z" fill="#d9485f"/><path d="M64 22h16v20H64z" fill="#3b6fd8"/><path d="M12 40h20v14H12z" fill="#3b6fd8"/><path d="M32 38h18v16H32z" fill="#d9485f"/><path d="M50 40h18v12H50z" fill="#3b6fd8"/></g></svg>',
  bars: '<svg viewBox="0 0 88 64" aria-hidden="true"><g fill="var(--brand)"><rect x="12" y="36" width="10" height="20" rx="2" opacity=".45"/><rect x="30" y="26" width="10" height="30" rx="2" opacity=".6"/><rect x="48" y="16" width="10" height="40" rx="2" opacity=".8"/><rect x="66" y="6" width="10" height="50" rx="2"/></g></svg>',
};
export const artHtml = (key) => (ART[key] ? `<span class="art lp-art-svg" aria-hidden="true">${ART[key]}</span>` : '');

// The % shown for a market: the last trade, else the bid/ask mid (as everywhere else, lib.js prob()).
export function pctOf(m) {
  if (m.last_price_dollars != null) return Math.round(Number(m.last_price_dollars) * 1000) / 10;
  if (m.yes_bid_dollars != null && m.yes_ask_dollars != null) return Math.round((Number(m.yes_bid_dollars) + Number(m.yes_ask_dollars)) * 500) / 10;
  return null;
}
export const pctText = (p) => (p == null ? '—' : `${Math.round(p)}%`);
// Scalar markets show their forecast: floor + price × (cap − floor), in the market's unit.
export const scalarValue = (m, price) => (price == null ? null : Number(m.floor_strike) + (Number(price) / 100) * (Number(m.cap_strike) - Number(m.floor_strike)));
export const isScalar = (m) => m && m.market_type === 'scalar' && m.floor_strike != null && m.cap_strike != null;
export const scalarText = (m, v) => (v == null ? '—' : `${v.toFixed(2)}${m.scalar_unit || ''}`);
// One-day change of a percentage (or of a scalar forecast), with its direction for colour and arrow.
export function changeOf(m) {
  if (m.last_price_dollars == null || m.previous_price_dollars == null) return { d: 0, dir: 'flat' };
  const a = cents(m.last_price_dollars); const b = cents(m.previous_price_dollars);
  if (isScalar(m)) { const d = Math.round((scalarValue(m, a) - scalarValue(m, b)) * 100) / 100; return { d, dir: d > 0 ? 'up' : d < 0 ? 'down' : 'flat', scalar: true }; }
  const d = a - b;
  return { d, dir: d > 0 ? 'up' : d < 0 ? 'down' : 'flat' };
}
export function changeHtml(m) {
  const c = changeOf(m);
  const n = c.scalar ? `${c.d > 0 ? '+' : c.d < 0 ? '−' : ''}${Math.abs(c.d).toFixed(2)}${m.scalar_unit || ''}` : `${c.d > 0 ? '+' : c.d < 0 ? '−' : ''}${Math.abs(c.d)}%`;
  const arrow = c.dir === 'up' ? ' ▲' : c.dir === 'down' ? ' ▼' : '';
  return `<span class="lp-chg ${esc(c.dir)}" data-chg>${te('landing.change_1d', { value: esc(n) })}${arrow}<span class="sr-only"> ${c.dir === 'up' ? te('landing.up') : c.dir === 'down' ? te('landing.down') : ''}</span></span>`;
}

// Multi-line chart: one line per series with an end-point dot, dotted gridlines and a right-hand % axis. `axis`:
// 'auto' (0 up to the next 25 above the highest point, at least 50) or 'full' (0 / 50 / 100). Values are percentages.
// `unit` (scalar forecasts) draws the axis in that unit over the data's own range instead.
export function lineChart(series, { w = 520, h = 220, axis = 'auto', unit = null, label = '' } = {}) {
  const pts = series.flatMap((s) => s.points);
  if (!pts.length) return `<p class="faint">${te('landing.no_trades_yet')}</p>`;
  const padR = 44; const padT = 8; const padB = 8;
  const xs = pts.map((p) => p[0]); const vs = pts.map((p) => p[1]);
  const x0 = Math.min(...xs); const x1 = Math.max(...xs, x0 + 1);
  let lo = 0; let hi;
  let ticks;
  if (unit != null) {
    lo = Math.min(...vs); hi = Math.max(...vs);
    if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.15; lo -= pad; hi += pad;
    ticks = [lo, (lo + hi) / 2, hi];
  } else if (axis === 'full') { hi = 100; ticks = [0, 50, 100]; } else {
    hi = Math.max(50, Math.ceil(Math.max(...vs) / 25) * 25);
    ticks = []; for (let v = 0; v <= hi; v += 25) ticks.push(v);
  }
  const sx = (t) => ((t - x0) / (x1 - x0)) * (w - padR - 8);
  const sy = (v) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);
  const fmt = (v) => (unit != null ? `${v.toFixed(1)}${unit}` : `${Math.round(v)}%`);
  const grid = ticks.map((g) => `<line x1="0" x2="${w - padR}" y1="${sy(g).toFixed(1)}" y2="${sy(g).toFixed(1)}" stroke="var(--fill-x50)" stroke-dasharray="1 5"/><text x="${w - 2}" y="${(sy(g) + 4).toFixed(1)}" text-anchor="end" font-size="12" fill="var(--text-x30)">${esc(fmt(g))}</text>`).join('');
  const lines = series.map((s) => {
    if (!s.points.length) return '';
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ');
    const l = s.points[s.points.length - 1];
    return `<path d="${d}" fill="none" stroke="${esc(s.color)}" stroke-width="2" stroke-linejoin="round"/><circle cx="${sx(l[0]).toFixed(1)}" cy="${sy(l[1]).toFixed(1)}" r="4" fill="${esc(s.color)}" data-end="${esc(s.key || '')}"/>`;
  }).join('');
  // Text alternative (WCAG 1.1.1): every line's latest value and the period.
  const sr = tx('landing.chart_sr', { label, lines: series.filter((s) => s.points.length).map((s) => `${s.name} ${fmt(s.points[s.points.length - 1][1])}`).join(', '), from: fmtDt(x0 * 1000, { day: 'numeric', month: 'short' }), to: fmtDt(x1 * 1000, { day: 'numeric', month: 'short' }) });
  return `<svg class="lp-chart-svg" viewBox="0 0 ${esc(w)} ${esc(h)}" role="img" aria-label="${esc(sr)}" data-testid="lp-chart">${grid}${lines}</svg>`;
}

// Small sparkline (15-minute cards and the Monthly forecast) with an optional dotted target line.
export function sparkline(values, { w = 220, h = 56, color = 'var(--brand)', target = null, area = false } = {}) {
  if (!values.length) return '';
  const all = target == null ? values : [...values, target];
  let lo = Math.min(...all); let hi = Math.max(...all);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const sx = (i) => (values.length < 2 ? w - 4 : (i / (values.length - 1)) * (w - 8) + 2);
  const sy = (v) => 4 + (1 - (v - lo) / (hi - lo)) * (h - 8);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(' ');
  const last = values.length - 1;
  return `<svg class="lp-spark" viewBox="0 0 ${esc(w)} ${esc(h)}" aria-hidden="true">${target == null ? '' : `<line x1="0" x2="${esc(w)}" y1="${sy(target).toFixed(1)}" y2="${sy(target).toFixed(1)}" stroke="var(--text-x30)" stroke-dasharray="2 4"/>`}${area ? `<path d="${d} L${sx(last).toFixed(1)},${esc(h)} L${sx(0).toFixed(1)},${esc(h)} Z" fill="${esc(color)}" opacity=".12"/>` : ''}<path d="${d}" fill="none" stroke="${esc(color)}" stroke-width="2" stroke-linejoin="round"/><circle cx="${sx(last).toFixed(1)}" cy="${sy(values[last]).toFixed(1)}" r="3.5" fill="${esc(color)}"/></svg>`;
}

// Promo rail cards: the CMS promo cards when an admin made any (Admin › Content › Promo cards, with their illustration),
// else the two built-in Invest cards (Perps, the cash APY), each hidden while its feature flag is off ([data-flag]).
export function promoCards(promos, { apy = 0.035, apyHref = '/sign-up' } = {}) {
  const chev = '<span class="lp-chev" aria-hidden="true">›</span>';
  if (promos && promos.length) return promos.map((p) => `<a class="card promo lp-promo cms-promo" href="${esc(p.link)}" ${p.link.startsWith('/') ? 'data-link' : 'target="_blank" rel="noopener"'} data-testid="promo-card"${vars({ '--promo': p.color })}><span>${p.overline ? `<span class="overline">${esc(p.overline)}</span>` : ''}<b>${esc(p.title)}</b>${p.subtitle ? `<span class="sub">${esc(p.subtitle)}</span>` : ''}</span>${artHtml(p.art)}${chev}</a>`).join('');
  return `<a class="card promo lp-promo" href="/perps" data-link data-testid="perps-promo" data-flag="perps"><span><span class="overline lp-ov">${te('landing.promo.invest')}</span><b>${te('landing.promo.perps')}</b></span>${slotImg('promo.perps', 'art art-img') || artHtml('candles')}${chev}</a>
    <a class="card promo lp-promo" href="${esc(apyHref)}" data-link data-testid="apy-promo" data-flag="interest"><span><span class="overline lp-ov">${te('landing.promo.invest')}</span><b>${te('landing.promo.apy', { apy: esc(Math.round(apy * 1000) / 10) })}</b></span>${artHtml('coins')}${chev}</a>`;
}
// A hub card (elections hub by default, else the CMS hubs) with its volume and a small illustration.
export const hubCard = (h) => `<a class="card promo lp-promo lp-hub" href="${esc(h.href || `/category/${catSlug(h.category)}`)}" data-link data-testid="landing-hub"><span><b>${esc(h.title || tx('landing.hub.default', { category: catLabel(h.category) }))}</b><span class="sub">${te('landing.volume', { money: esc(money0(h.dollar_volume)) })}</span></span>${slotImg(h.category === 'Elections' ? 'hub.elections' : 'hub.economics', 'art art-img') || artHtml(h.category === 'Elections' ? 'map' : 'bars')}<span class="lp-chev" aria-hidden="true">›</span></a>`;
