// Live / Calendar (spec §13.4, §15.5): left rail (featured, "What's next", categories with counts),
// "LIVE · N" section with rolling Above/Below cards and live events, then dated sections; right rail with
// the most recently determined window.
import { vars } from '../dynstyle.js';
import { api } from '../api.js';
import { socket } from '../ws.js';
import { esc, CATEGORIES, catLabel, eventHref, money, cents } from '../lib.js';
import { eventCard, evIcon } from './components.js';
import { applySportsFilter, drawSportsNav } from './sports.js'; // sports leagues sidebar + ?league= / ?sport= filter

const fmtDate = (d) => {
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  if (d === today) return 'Today';
  if (d === tomorrow) return 'Tomorrow';
  return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
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

export async function render({ el, params, query, navigate }) {
  const liveOnly = !!params.live;
  document.title = liveOnly ? 'Live · Parlance' : 'Calendar · Parlance';
  const category = query.get('category') || '';
  const data = applySportsFilter(await api.calendar({ category }), query);
  const f = data.filters;
  const liveSec = data.sections.find((s) => s.is_live);
  const dated = data.sections.filter((s) => !s.is_live);
  const row = (name, c, on) => `<button data-cat="${esc(name)}" class="${on ? 'on' : ''}"><span>${esc(name ? catLabel(name) : 'All')}</span><span class="n">${esc(c ? c.count : 0)}${c && c.live_count ? ` · <span class="c-live">${esc(c.live_count)} live</span>` : ''}</span></button>`;
  el.innerHTML = `<div class="live-layout">
    <nav class="live-side" aria-label="Calendar categories" data-testid="cal-filters">
      <div class="overline">Featured</div>
      <div id="sports-featured" class="sb-featured" data-testid="sports-featured"></div><a href="/category/elections" data-link>Harbor 2026</a><a href="/category/crypto" data-link>Crypto · 15 min</a>
      <a href="/calendar" data-link class="next mt-10">What's next</a>
      <div id="sports-tree" class="sb-treebox" data-testid="sports-tree"></div>
      ${row('', f.all, !category)}${CATEGORIES.filter((c) => f.categories[c]).map((c) => row(c, f.categories[c], c === category)).join('')}
    </nav>
    <div class="minw-0">
      <h1 class="live-title" data-testid="live-title">LIVE · ${liveSec ? liveSec.events.length : 0}</h1>
      <div id="flash"></div>
      ${liveSec ? `<section class="cal-section" data-testid="cal-section" data-date="${esc(liveSec.date)}" data-live="true"><div class="grid grid-1col">${liveSec.events.filter((e) => !e.series_ticker.startsWith('PLXFLASH')).map(eventCard).join('')}</div></section>` : '<div class="card empty">Nothing is live right now.</div>'}
      ${liveOnly ? '' : dated.map((s) => `<section class="cal-section" data-testid="cal-section" data-date="${esc(s.date)}" data-live="false">
          <h2 class="cal-date">${esc(fmtDate(s.date))}<span class="faint">${s.events.length}</span></h2>
          <div class="grid">${s.events.map(eventCard).join('')}</div></section>`).join('')}
    </div>
    <aside class="live-rail"><a class="combo-btn" href="/combos" data-link data-testid="combo-rail-btn" aria-label="Build a combo">◇ COMBO</a><div id="determined"></div></aside>
  </div>`;
  drawSportsNav(el, query);
  for (const b of el.querySelectorAll('[data-cat]')) b.onclick = () => navigate(b.dataset.cat ? `${location.pathname}?category=${encodeURIComponent(b.dataset.cat)}` : location.pathname, { replace: true });

  // Rolling Above/Below card (observed "BTC 15 MIN" pattern; our underlying is the invented PLX index).
  const flashEvent = liveSec?.events.find((e) => e.series_ticker.startsWith('PLXFLASH'));
  async function drawFlash() {
    const box = el.querySelector('#flash');
    if (!box || (category && category !== 'Crypto')) return;
    try {
      const { window: w, prices } = await api.rollingCurrent();
      const ev = flashEvent && flashEvent.event_ticker === w.event_ticker ? flashEvent : (await api.event(w.event_ticker)).event;
      const m = ev.markets[0];
      const up = cents(m.last_price_dollars) ?? cents(m.yes_ask_dollars) ?? 50;
      const dist = Number(w.distance_dollars);
      const href = eventHref({ ...ev, series_slug: 'plx-token-price' });
      box.innerHTML = `<article class="card flash-card mb-16" data-testid="flash-card" data-event="${esc(w.event_ticker)}">
        <div><div class="d-flex gap-12 ai-center">${evIcon({ category: 'Crypto', title: 'P' }, 'sm')}<span class="overline">${esc(w.label)}</span></div>
          <div class="target" data-testid="flash-target">Target ${money(w.target_dollars)}</div><div class="dist ${dist < 0 ? 'down' : ''}">${dist < 0 ? '↓' : '↑'} ${money(Math.abs(dist))} ${dist < 0 ? 'Below' : 'Above'}</div></div>
        <div>${spark(prices, Number(w.target_dollars))}</div>
        <div class="ab"><a href="${href}?side=yes&amp;market=${esc(m.ticker)}" data-link>Above · ${up}%</a><a href="${href}?side=no&amp;market=${esc(m.ticker)}" data-link>Below · ${100 - up}%</a></div>
        <div class="faint col-full">${money(ev.dollar_volume || 0)} vol · closes ${new Date(w.end_time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div></article>`;
    } catch { /* no window yet */ }
  }
  async function drawDetermined() {
    const box = el.querySelector('#determined');
    if (!box) return;
    try {
      const { windows } = await api.rollingDetermined();
      const w = windows[0];
      box.innerHTML = w ? `<section class="card determined" data-testid="determined"><span class="overline">${esc(w.label)}</span><h3>Determined</h3><div class="muted">Outcome: <strong class="c-${w.result === 'yes' ? 'yes' : 'no'}">${w.result === 'yes' ? 'Up' : 'Down'}</strong></div>
        <div class="faint mt-6">Target ${money(w.target_dollars)} → close ${money(w.current_dollars)}</div><a href="/category/crypto" data-link class="d-block mt-16">Explore Crypto</a></section>` : '';
    } catch { /* optional */ }
  }
  drawFlash(); drawDetermined();
  const iv = setInterval(() => { if (!document.hidden) { drawFlash(); drawDetermined(); } }, 5000);
  const unsub = socket.subscribe({ channels: ['market_lifecycle_v2'] }, () => { drawDetermined(); });
  return () => { clearInterval(iv); unsub(); };
}
