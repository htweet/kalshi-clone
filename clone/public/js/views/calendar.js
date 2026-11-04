// Live / Calendar (spec §13.4, §15.5): left rail (featured, "What's next", categories with counts),
// "LIVE · N" section with rolling Above/Below cards and live events, then dated sections; right rail with
// the most recently determined window.
import { t, te } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/calendar-strings.js';
import { vars } from '../dynstyle.js';
import { api } from '../api.js';
import { socket } from '../ws.js';
import { flagOn } from '../flags.js'; // feature flags (CLONE_SPEC.md §33)
import { esc, CATEGORIES, catLabel, eventHref, money, cents, currency, dayKey, fmtTime } from '../lib.js';
import { eventCard, evIcon } from './components.js';
import { applySportsFilter, drawSportsNav } from './sports.js'; // sports leagues sidebar + ?league= / ?sport= filter

// Sections are local days in the configured time zone (server/currency.js dayKey; CLONE_SPEC.md §30).
const fmtDate = (d) => {
  const today = dayKey();
  const tomorrow = new Date(Date.parse(today + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10); // the next calendar date
  if (d === today) return t('calendar.fmt_date.today');
  if (d === tomorrow) return t('calendar.fmt_date.tomorrow');
  return new Date(d + 'T12:00:00Z').toLocaleDateString(currency.locale, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }); // a calendar date: no zone shift
};
function spark(prices, target) {
  if (prices.length < 2) return '';
  const W = 380; const H = 70;
  const vs = prices.map((p) => Number(p.price_dollars));
  const lo = Math.min(...vs, target) - 0.01; const hi = Math.max(...vs, target) + 0.01;
  const x = (i) => (i / (prices.length - 1)) * W; const y = (v) => H - ((v - lo) / (hi - lo)) * H;
  const d = vs.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" class="w-full v-h"${vars({ '--h': `${H}px` })} aria-hidden="true"><line x1="0" x2="${W}" y1="${y(target)}" y2="${y(target)}" stroke="var(--text-x30)" stroke-dasharray="2 4"/><path d="${d}" fill="none" stroke="#f59f00" stroke-width="2"/><circle cx="${W}" cy="${y(vs[vs.length - 1])}" r="3.5" fill="#f59f00"/></svg>`;
}

// Recurring families capped per section (`event_limits`, CLONE_SPEC.md §13.4 / §29.4; U16 design choice): the first
// `max_count` events of a family are shown in section order, the rest sit behind a "+N more" toggle after the last
// shown one.
function cappedCards(sec, liveSection = false) {
  const evs = liveSection ? sec.events.filter((e) => !e.series_ticker.startsWith('PLXFLASH')) : sec.events;
  const hide = new Map(); const lastShown = new Map();
  for (const lim of sec.event_limits || []) {
    const fam = evs.filter((e) => lim.event_tickers.includes(e.event_ticker));
    if (fam.length <= lim.max_count) continue;
    const key = fam[0].series_ticker;
    fam.slice(lim.max_count).forEach((e) => hide.set(e.event_ticker, key));
    lastShown.set(fam[lim.max_count - 1].event_ticker, { key, n: fam.length - lim.max_count, title: fam[0].series_title || key });
  }
  return evs.map((e) => {
    const card = eventCard(e);
    const h = hide.get(e.event_ticker);
    const out = h ? `<div class="cal-capped" data-family="${esc(h)}" data-testid="cal-capped" hidden>${card}</div>` : card;
    const more = lastShown.get(e.event_ticker);
    return more ? `${out}<button class="card cal-more" data-more="${esc(more.key)}" data-testid="cal-more" aria-expanded="false" data-n="${esc(more.n)}" data-title="${esc(more.title)}">${te('calendar.capped_cards.more', { n: esc(more.n), title: esc(more.title) })}</button>` : out;
  }).join('');
}

export async function render({ el, params, query, navigate }) {
  const liveOnly = !!params.live;
  document.title = liveOnly ? t('calendar.render.live_parlance') : t('calendar.render.calendar_parlance');
  const category = query.get('category') || '';
  const data = applySportsFilter(await api.calendar({ category }), query);
  const f = data.filters;
  const liveSec = data.sections.find((s) => s.is_live);
  const dated = data.sections.filter((s) => !s.is_live);
  const row = (name, c, on) => `<button data-cat="${esc(name)}" class="${on ? 'on' : ''}"><span>${esc(name ? catLabel(name) : t('calendar.render.all'))}</span><span class="n">${esc(c ? c.count : 0)}${c && c.live_count ? ` · <span class="c-live">${te('calendar.render.live', { live_count: esc(c.live_count) })}</span>` : ''}</span></button>`;
  el.innerHTML = `<div class="live-layout">
    <nav class="live-side" aria-label="${te('calendar.render.calendar_categories')}" data-testid="cal-filters">
      <div class="overline">${te('calendar.render.featured')}</div>
      <div id="sports-featured" class="sb-featured" data-testid="sports-featured"></div><a href="/category/elections" data-link>${te('calendar.render.harbor_2026')}</a><a href="/category/crypto" data-link>${te('calendar.render.crypto_15_min')}</a>
      <a href="/calendar" data-link class="next mt-12">${te('calendar.render.what_s_next')}</a>
      <div id="sports-tree" class="sb-treebox" data-testid="sports-tree"></div>
      ${row('', f.all, !category)}${CATEGORIES.filter((c) => f.categories[c]).map((c) => row(c, f.categories[c], c === category)).join('')}
    </nav>
    <div class="minw-0">
      <h1 class="live-title" data-testid="live-title">${te('calendar.render.live_2', { value: liveSec ? liveSec.events.length : 0 })}</h1>
      <div id="flash" data-flag="trading.rolling"></div>
      ${liveSec ? `<section class="cal-section" data-testid="cal-section" data-date="${esc(liveSec.date)}" data-live="true"><div class="grid grid-1col">${cappedCards(liveSec, true)}</div></section>` : `<div class="card empty">${te('calendar.render.nothing_is_live_right_now')}</div>`}
      ${liveOnly ? '' : dated.map((s) => `<section class="cal-section" data-testid="cal-section" data-date="${esc(s.date)}" data-live="false">
          <h2 class="cal-date">${esc(fmtDate(s.date))}<span class="faint">${s.events.length}</span></h2>
          <div class="grid">${cappedCards(s)}</div></section>`).join('')}
    </div>
    <aside class="live-rail"><a class="combo-btn" href="/combos" data-link data-testid="combo-rail-btn" aria-label="${te('calendar.render.build_a_combo')}">${te('calendar.render.combo')}</a><div id="determined"></div></aside>
  </div>`;
  drawSportsNav(el, query);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-more]');
    if (!b) return;
    const sec = b.closest('[data-testid=cal-section]');
    const open = b.getAttribute('aria-expanded') !== 'true';
    for (const c of sec.querySelectorAll(`[data-family="${CSS.escape(b.dataset.more)}"]`)) c.hidden = !open;
    b.setAttribute('aria-expanded', String(open));
    b.textContent = open ? t('calendar.render.show_less') : t('calendar.render.more', { n: b.dataset.n, title: b.dataset.title });
  });
  for (const b of el.querySelectorAll('[data-cat]')) b.onclick = () => navigate(b.dataset.cat ? `${location.pathname}?category=${encodeURIComponent(b.dataset.cat)}` : location.pathname, { replace: true });

  // Rolling Above/Below card (observed "BTC 15 MIN" pattern; our underlying is the invented PLX index).
  const flashEvent = liveSec?.events.find((e) => e.series_ticker.startsWith('PLXFLASH'));
  async function drawFlash() {
    const box = el.querySelector('#flash');
    if (!box || (category && category !== 'Crypto') || !flagOn('trading.rolling')) return; // rolling-markets flag (§33)
    try {
      const { window: w, prices } = await api.rollingCurrent();
      const ev = flashEvent && flashEvent.event_ticker === w.event_ticker ? flashEvent : (await api.event(w.event_ticker)).event;
      const m = ev.markets[0];
      const up = cents(m.last_price_dollars) ?? cents(m.yes_ask_dollars) ?? 50;
      const dist = Number(w.distance_dollars);
      const href = eventHref({ ...ev, series_slug: 'plx-token-price' });
      box.innerHTML = `<article class="card flash-card mb-16" data-testid="flash-card" data-event="${esc(w.event_ticker)}">
        <div><div class="d-flex gap-12 ai-center">${evIcon({ category: 'Crypto', title: 'P' }, 'sm')}<span class="overline">${esc(w.label)}</span></div>
          <div class="target" data-testid="flash-target">${te('calendar.render.target', { money: money(w.target_dollars) })}</div><div class="dist ${dist < 0 ? 'down' : ''}">${dist < 0 ? '↓' : '↑'} ${money(Math.abs(dist))} ${dist < 0 ? te('calendar.render.below') : te('calendar.render.above')}</div></div>
        <div>${spark(prices, Number(w.target_dollars))}</div>
        <div class="ab"><a href="${href}?side=yes&amp;market=${esc(m.ticker)}" data-link>${te('calendar.render.above_2', { up })}</a><a href="${href}?side=no&amp;market=${esc(m.ticker)}" data-link>${te('calendar.render.below_2', { value: 100 - up })}</a></div>
        <div class="faint col-full">${te('calendar.render.vol_closes', { money: money(ev.dollar_volume || 0), fmt_time: esc(fmtTime(w.end_time, true)) })}</div></article>`;
    } catch { /* no window yet */ }
  }
  async function drawDetermined() {
    const box = el.querySelector('#determined');
    if (!box) return;
    try {
      const { windows } = await api.rollingDetermined();
      const w = windows[0];
      box.innerHTML = w ? `<section class="card determined" data-testid="determined"><span class="overline">${esc(w.label)}</span><h3>${te('calendar.render.determined')}</h3><div class="muted">${te('calendar.render.outcome')} <strong class="c-${w.result === 'yes' ? 'yes' : 'no'}">${w.result === 'yes' ? te('calendar.render.up') : te('calendar.render.down')}</strong></div>
        <div class="faint mt-6">${te('calendar.render.target_close', { money: money(w.target_dollars), money_2: money(w.current_dollars) })}</div><a href="/category/crypto" data-link class="d-block mt-16">${te('calendar.render.explore_crypto')}</a></section>` : '';
    } catch { /* optional */ }
  }
  drawFlash(); drawDetermined();
  const iv = setInterval(() => { if (!document.hidden) { drawFlash(); drawDetermined(); } }, 5000);
  const unsub = socket.subscribe({ channels: ['market_lifecycle_v2'] }, () => { drawDetermined(); });
  return () => { clearInterval(iv); unsub(); };
}
