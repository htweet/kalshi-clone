// Category pages (owner request 2026-11-15, CLONE_SPEC.md §42): the pieces around the main list — sidebar group icons,
// the Top-cities weather strip, the sports games strip, the category banner and the underlying-price panel of a
// featured card (strike line for a commodity ladder, "to beat" target for a short up/down window). Own SVG art only.
import { t, te } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/category-strings.js';
import { vars } from '../dynstyle.js';
import { esc, eventHref, prob, moneyCents, fmtDay, fmtTime, relTime } from '../lib.js';

// Sidebar glyphs (16×16 strokes). Admin › Category pages picks one per group, or a square image from the media library.
const G = {
  chart: '<path d="M2 13h12M4 10l3-3 2 2 4-5"/>', coin: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v6M6.5 6.5h2.5a1 1 0 010 2h-2a1 1 0 000 2h2.5"/>',
  drop: '<path d="M8 2.5s4 4.3 4 7a4 4 0 01-8 0c0-2.7 4-7 4-7z"/>', sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
  cloud: '<path d="M4.5 12.5h7a3 3 0 00.3-6A4 4 0 004 7.3a2.6 2.6 0 00.5 5.2z"/>', oil: '<path d="M4 2.5h8v11H4zM4 6h8M6.5 9h3"/>',
  bolt: '<path d="M9 1.5L4 9h4l-1 5.5L12 7H8z"/>', ballot: '<path d="M3 7h10v6.5H3zM5.5 7l2-4.5 3.5 1.5-1.5 3M6 10.5h4"/>',
  ball: '<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11M2.5 8h11"/>', film: '<path d="M2.5 3.5h11v9h-11zM5 3.5v9M11 3.5v9"/>',
  chip: '<path d="M4.5 4.5h7v7h-7zM6.5 2v2.5M9.5 2v2.5M6.5 11.5V14M9.5 11.5V14M2 6.5h2.5M2 9.5h2.5M11.5 6.5H14M11.5 9.5H14"/>', bank: '<path d="M2 6l6-3.5L14 6M3.5 6.5v5M6.5 6.5v5M9.5 6.5v5M12.5 6.5v5M2 13.5h12"/>',
  flag: '<path d="M3.5 14V2.5M3.5 3h8l-2 2.5 2 2.5h-8"/>', globe: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c2 2 2 9 0 11M8 2.5c-2 2-2 9 0 11"/>',
  star: '<path d="M8 2l1.8 3.7 4 .6-2.9 2.8.7 4L8 11.2 4.4 13l.7-4L2.2 6.3l4-.6z"/>', mic: '<path d="M6 3a2 2 0 014 0v4a2 2 0 01-4 0zM4 7a4 4 0 008 0M8 11v3"/>',
  rocket: '<path d="M8 1.5c3 2 3.5 6 2.5 9h-5c-1-3-.5-7 2.5-9zM5.5 10.5L3.5 13M10.5 10.5l2 2.5"/>', home: '<path d="M2.5 8L8 3l5.5 5M4 7v6.5h8V7"/>',
};
export function groupIcon(icon, label, color) {
  if (icon && icon.url) return `<span class="cp-gi cp-gi-img" aria-hidden="true"><img src="${esc(icon.url)}" alt="" width="20" height="20"></span>`;
  const c = (icon && icon.color) || color;
  if (icon && icon.glyph && G[icon.glyph]) return `<span class="cp-gi v-color"${vars({ '--color': c })} aria-hidden="true"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round">${G[icon.glyph]}</svg></span>`;
  return '';
}
const pctOf = (m) => { const p = prob(m); return p == null ? '—' : `${p}%`; };

// ---------------------------------------------------------------- Top cities (Climate)
export function citiesHtml(tc, day) {
  const list = tc[day] || [];
  return list.map((c) => `<a class="card cp-city" href="${eventHref(c)}?side=yes&amp;market=${esc(c.market.ticker)}" data-link data-event="${esc(c.event_ticker)}" data-testid="city-card">
      <span class="cp-city-name">${esc(c.city)}</span>
      <span class="cp-city-row"><span><span class="faint d-block">${te('category.cities.high')}</span><span class="cp-city-temp">${esc(c.market.yes_sub_title)}</span></span><span class="odds pill" data-ticker-pill="${esc(c.market.ticker)}">${pctOf(c.market)}</span></span>
      <span class="faint cp-city-sub">${c.rain ? te('category.cities.rain', { pct: esc(pctOf(c.rain.market)) }) : ''}</span></a>`).join('') || `<p class="faint">${te('category.cities.none')}</p>`;
}
export function citiesStrip(tc) {
  return `<section class="cp-strip" aria-labelledby="cp-cities-h" data-testid="top-cities">
    <div class="cp-strip-head"><h2 id="cp-cities-h">${te('category.cities.title')}</h2><span class="grow"></span>
      <div class="seg" role="group" aria-label="${te('category.cities.day')}"><button type="button" data-day="today" class="on" aria-pressed="true">${te('category.cities.today')}</button><button type="button" data-day="tomorrow" aria-pressed="false">${te('category.cities.tomorrow')}</button></div>
      <button class="icon-btn" type="button" data-strip="-1" aria-label="${te('category.strip.left')}">‹</button><button class="icon-btn" type="button" data-strip="1" aria-label="${te('category.strip.right')}">›</button></div>
    <div class="strip cp-cities" data-strip-body>${citiesHtml(tc, 'today')}</div></section>`;
}

// ---------------------------------------------------------------- Sports games strip
// Badge text in black or white, whichever reads better on the team colour (WCAG 1.4.3 at this small size).
const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const inkOn = (hex) => (/^#[0-9a-f]{6}$/i.test(hex) && (lum(hex) + 0.05) / 0.05 > 1.05 / (lum(hex) + 0.05) ? '#000000' : '#ffffff');
const badge = (o) => { const bg = o.color && o.color !== '#5b5bd6' ? o.color : '#3a7bff'; return `<span class="cp-badge v-bg v-color"${vars({ '--bg': bg, '--color': inkOn(bg) })} aria-hidden="true">${esc(String(o.name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase())}</span>`; };
export function gamesStrip(sp) {
  if (!sp || !sp.strip.length) return '';
  return `<section class="cp-strip cp-strip-games" aria-labelledby="cp-games-h" data-testid="sports-strip"><h2 id="cp-games-h" class="sr-only">${te('category.games.title')}</h2><div class="cp-strip-nav">
      <button class="icon-btn" type="button" data-strip="-1" aria-label="${te('category.strip.left')}">‹</button><button class="icon-btn" type="button" data-strip="1" aria-label="${te('category.strip.right')}">›</button></div>
    <div class="strip cp-games" data-strip-body>${sp.strip.map((g) => `<div class="cp-league" data-testid="league-group"><div class="cp-league-h overline">${esc(g.label)} <span class="faint">${te('category.games.of', { n: esc(g.games.length), total: esc(g.total) })}</span></div>
      <div class="cp-league-cards">${g.games.map((x) => `<a class="card cp-game" href="${eventHref(x)}" data-link data-event="${esc(x.event_ticker)}" data-testid="cp-game-card">
        <span class="cp-game-when">${x.status === 'live' ? `<span class="live-dot">${te('category.games.live')}</span>` : esc(t('category.games.when', { day: fmtDay(x.start_time), time: fmtTime(x.start_time) }))}</span>
        ${x.outcomes.map((o) => `<span class="cp-team">${badge(o)}<span class="cp-team-name">${esc(o.name)}</span><b class="num" data-ticker-pct="${esc(o.ticker)}">${o.prob == null ? '—' : `${esc(o.prob)}%`}</b></span>`).join('')}</a>`).join('')}</div></div>`).join('')}</div></section>`;
}

// ---------------------------------------------------------------- banner
export const bannerHtml = (b) => `<section class="card cp-banner" data-testid="cp-banner" aria-labelledby="cp-banner-h"><div class="minw-0"><h2 id="cp-banner-h">${esc(b.title)}</h2>${b.body ? `<p>${esc(b.body)}</p>` : ''}</div>
  <div class="cp-banner-actions">${b.cta_label && b.cta_href ? `<a class="btn btn-primary" href="${esc(b.cta_href)}" data-link>${esc(b.cta_label)}</a>` : ''}${b.link_label && b.link_href ? `<a class="btn" href="${esc(b.link_href)}" data-link>${esc(b.link_label)}</a>` : ''}
  <button class="icon-btn" type="button" data-banner-close aria-label="${te('category.banner.dismiss')}">×</button></div></section>`;

// ---------------------------------------------------------------- underlying price (featured card, right side)
function undChart(points, line, { area = false, color = 'var(--brand)' } = {}) {
  if (points.length < 2) return `<p class="faint">${te('category.und.no_history')}</p>`;
  const W = 520; const Hh = 230; const padR = 78; const padB = 24; const padT = 14;
  const vs = [...points.map((p) => p.v), ...(line && line.v != null ? [line.v] : [])];
  let lo = Math.min(...vs); let hi = Math.max(...vs);
  const pad = Math.max(1, (hi - lo) * 0.12); lo -= pad; hi += pad;
  const t0 = points[0].t; const t1 = points[points.length - 1].t;
  const sx = (x) => ((x - t0) / Math.max(1, t1 - t0)) * (W - padR - 10);
  const sy = (v) => padT + (1 - (v - lo) / (hi - lo)) * (Hh - padT - padB);
  const ticks = [0, 1, 2, 3, 4].map((i) => lo + ((hi - lo) * i) / 4);
  const grid = ticks.map((g) => `<line x1="0" x2="${W - padR}" y1="${sy(g).toFixed(1)}" y2="${sy(g).toFixed(1)}" stroke="var(--fill-x50)" stroke-dasharray="1 5"/><text x="${W - 4}" y="${(sy(g) + 4).toFixed(1)}" text-anchor="end" font-size="12" fill="var(--text-x20)">${esc(moneyCents(Math.round(g)))}</text>`).join('');
  const short = t1 - t0 < 2 * 86400000;
  const xl = [0, 1, 2, 3].map((i) => t0 + ((t1 - t0) * i) / 3).map((x, i) => `<text x="${Math.min(W - padR - 30, sx(x) + (i ? 0 : 2))}" y="${Hh - 4}" font-size="12" fill="var(--text-x20)" text-anchor="${i ? 'middle' : 'start'}">${esc(short ? fmtTime(x) : fmtDay(x))}</text>`).join('');
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join(' ');
  const last = points[points.length - 1];
  const fill = area ? `<path d="${d} L${sx(last.t).toFixed(1)},${Hh - padB} L0,${Hh - padB} Z" fill="${esc(color)}" opacity=".16"/>` : '';
  const ly = line && line.v != null ? sy(line.v) : null;
  const strike = ly == null ? '' : `<line x1="0" x2="${W - padR}" y1="${ly.toFixed(1)}" y2="${ly.toFixed(1)}" stroke="${esc(line.color)}" stroke-width="1.5" stroke-dasharray="5 4" data-testid="cp-strike-line"/><text x="${((W - padR) / 2).toFixed(1)}" y="${(ly - 6).toFixed(1)}" text-anchor="middle" font-size="13" font-weight="700" fill="${esc(line.color)}" data-testid="cp-strike-label">${esc(line.label)}</text>`;
  const sr = t('category.und.sr', { now: moneyCents(last.v), from: moneyCents(points[0].v), line: line ? line.label : '' });
  return `<svg class="chart cp-und-chart" viewBox="0 0 ${W} ${Hh}" role="img" aria-label="${esc(sr)}" data-testid="cp-und-chart">${grid}${xl}${fill}${strike}<path d="${d}" fill="none" stroke="${esc(color)}" stroke-width="2.2" stroke-linejoin="round"/><circle cx="${sx(last.t).toFixed(1)}" cy="${sy(last.v).toFixed(1)}" r="4.5" fill="${esc(color)}"/></svg>`;
}
const signed = (c) => moneyCents(c, { plus: true });
const pctTxt = (p) => `${p > 0 ? '+' : ''}${Number(p).toFixed(Math.abs(p) < 1 ? 3 : 1)}%`;
export function underlyingHtml(u) {
  const up = u.change_cents >= 0;
  if (u.kind === 'target') {
    const gap = u.target_cents ? ((u.now_cents - u.target_cents) / u.target_cents) * 100 : 0;
    return `<div class="cp-und" data-testid="cp-underlying" data-kind="target"><div class="cp-und-stats">
      <div><span class="overline">${te('category.und.to_beat')}</span><b class="num cp-und-big" data-testid="cp-und-target">${esc(moneyCents(u.target_cents))}</b><span class="faint">${esc(fmtTime(u.target_ts))}</span></div>
      <div class="cp-und-now"><span class="overline">${te('category.und.now')}</span><b class="num cp-und-big ${up ? 'c-yes' : 'c-no'}" data-testid="cp-und-price">${esc(moneyCents(u.now_cents))}</b><span class="${up ? 'c-yes' : 'c-no'}">${esc(signed(u.change_cents))} (${esc(pctTxt(u.change_pct))})</span></div>
      <span class="watermark ml-auto">${te('category.featured.brand')}</span></div>
      ${undChart(u.points, { v: u.target_cents, label: t('category.und.target', { gap: pctTxt(gap) }), color: 'var(--no)' }, { area: true, color: '#f59f00' })}</div>`;
  }
  return `<div class="cp-und" data-testid="cp-underlying" data-kind="strike"><div class="cp-und-stats"><div>
      <span class="d-flex gap-8 ai-baseline"><b class="num cp-und-big" data-testid="cp-und-price">${esc(moneyCents(u.now_cents))}</b><span class="${up ? 'c-yes' : 'c-no'}" data-testid="cp-und-change">${up ? '▲' : '▼'} ${esc(Math.abs(u.change_pct).toFixed(1))}%</span></span>
      <span class="faint">${esc(u.label)} · ${te('category.und.updated', { ago: esc(relTime(new Date(u.updated_ts).toISOString())) })}</span></div><span class="watermark ml-auto">${te('category.featured.brand')}</span></div>
    ${undChart(u.points, u.strike_cents == null ? null : { v: u.strike_cents, label: u.strike_label, color: 'var(--brand)' })}</div>`;
}
