// Home (spec §4.2, §15.2): hero carousel (outcome table + multi-line chart + news), info cards, Upcoming strip,
// popular + per-category sections; right rail with Perps promo, hubs, Trending, Harbor 2026 and Top movers.
import { t as tx, te, ts, tr } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/home-strings.js';
import { slotImg } from '../content-live.js'; // CMS media slots (CLONE_SPEC.md §32.6)
import { vars } from '../dynstyle.js';
import { api } from '../api.js';
import { queries, session } from '../store.js';
import { socket } from '../ws.js';
import { esc, eventHref, cents, multiplier, prob, previewPct, catSlug, catLabel, toast, dayKey, fmtTime, fmtDay } from '../lib.js';
import { eventCard, rankList, ocAvatar, evIcon, multiChart, seriesColor, money0 } from './components.js';
import { waitlistCta } from '../flags.js'; // Phase 7A: "Join the real-money waitlist" while in play mode (CLONE_SPEC.md §36)

const INFO = [
  [ts('home.info.market_integrity'), ts('home.info.how_we_keep_markets_fair'), '/account/limits', '<path d="M8 1.5l5.5 2v4c0 3.5-2.4 6-5.5 7-3.1-1-5.5-3.5-5.5-7v-4z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 8l2 2 3-3.5" fill="none" stroke="currentColor" stroke-width="1.5"/>'],
  [ts('home.info.open_order_books'), ts('home.info.every_price_is_set_by'), '/browse', '<path d="M2 13h12M4 10v3M8 6v7M12 3v10" stroke="currentColor" stroke-width="1.6" fill="none"/>'],
  [ts('home.info.responsible_trading'), ts('home.info.limits_and_tools_to_trade'), '/account/limits', '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.5V8l2.5 1.5" stroke="currentColor" stroke-width="1.5" fill="none"/>'],
];
// CMS-managed info cards / promo cards (server/admin.js) replace the defaults when configured.
const INFO_ICON = { shield: INFO[0][3], bars: INFO[1][3], clock: INFO[2][3], star: '<path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill="none" stroke="currentColor" stroke-width="1.4"/>', info: '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 7v4M8 4.6v.2" stroke="currentColor" stroke-width="1.6"/>' };
const infoCards = (home) => (home.info_cards ? home.info_cards.map((c) => [c.title, c.subtitle, c.link, INFO_ICON[c.icon] || INFO_ICON.info]) /* escaped where rendered */ : INFO);
const promoCard = (p) => `<a class="card promo cms-promo" href="${esc(p.link)}" ${p.link.startsWith('/') ? 'data-link' : 'target="_blank" rel="noopener"'} data-testid="promo-card"${vars({ '--promo': p.color })}><span>${p.overline ? `<span class="overline">${esc(p.overline)}</span>` : ''}<b>${esc(p.title)}</b>${p.subtitle ? `<span class="sub">${esc(p.subtitle)}</span>` : ''}</span><span class="faint ml-auto">›</span></a>`;
const fmtWhen = (iso) => {
  const sameDay = dayKey(iso) === dayKey(); // the configured time zone (CLONE_SPEC.md §30)
  return sameDay ? fmtTime(iso) : fmtDay(iso);
};

export async function render({ el, navigate }) {
  document.title = tx('home.render.parlance_exchange_trade_on_outcomes');
  el.innerHTML = '<div class="home"><div class="skeleton minh-420"></div><div class="skeleton"></div></div>';
  const { home } = await queries.fetch(['home'], api.home, { staleTime: 15000 });
  let idx = 0;
  const hl = home.highlights;
  let watching = new Set();
  if (session.user) { try { watching = new Set((await api.watchlist(session.uid)).events.map((e) => e.event_ticker)); } catch { /* ignore */ } }

  el.innerHTML = `<div class="home">
    <div class="minw-0">
      ${waitlistCta('home')}
      <section class="card hero" id="hero" aria-roledescription="${te('home.render.carousel')}"></section>
      <div class="info-cards">${infoCards(home).map(([t, s, href, icon]) => `<a class="card info-card" href="${esc(href)}" data-link><span class="ic"><svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true">${icon /* eslint-disable-line parlance/no-unescaped-html -- icon is an INFO_ICON constant (static SVG paths), selected by key */}</svg></span><span><b>${esc(t)}</b><span>${esc(s)}</span></span></a>`).join('')}</div>
      <div class="sec-head"><h2>${te('home.render.upcoming')}</h2><span class="spacer"></span><button class="icon-btn" id="up-prev" aria-label="${te('home.render.scroll_left')}">‹</button><button class="icon-btn" id="up-next" aria-label="${te('home.render.scroll_right')}">›</button></div>
      <div class="strip" id="upcoming" data-testid="upcoming">${home.upcoming.map((u) => `<a class="card up-card" href="${eventHref(u)}" data-link data-event="${esc(u.event_ticker)}">
          <div class="d-flex jc-between">${evIcon(u)}<button class="star-btn ${watching.has(u.event_ticker) ? 'on' : ''}" data-star="${esc(u.event_ticker)}" aria-label="${te('home.render.watch')}" aria-pressed="${watching.has(u.event_ticker)}">★</button></div>
          <div class="when">${esc(fmtWhen(u.close_time))}</div><div class="t">${esc(u.title)}</div><div class="tag">${esc(u.tag)}</div></a>`).join('')}</div>
      <div class="sec-head"><h2>${te('home.render.popular')}</h2><a class="arrow" href="/browse" data-link aria-label="${te('home.render.see_all_markets')}">›</a></div>
      <div class="cards2" id="top-markets">${home.top_markets.slice(0, 4).map(eventCard).join('')}</div>
      ${home.sections.slice(0, 6).map((s) => `<div class="sec-head"><h2>${esc(catLabel(s.category))}</h2><a class="arrow" href="/category/${catSlug(s.category)}" data-link aria-label="${te('home.render.more', { category: esc(s.category) })}">›</a></div>
        <div class="cards2">${s.events.slice(0, 2).map(eventCard).join('')}</div>`).join('')}
    </div>
    <aside class="rail">
      ${slotImg('hero.home', 'cms-slot-img card rail-art')}
      ${home.promos ? home.promos.map(promoCard).join('') : `<a class="card promo" href="/perps" data-link data-testid="perps-promo"><span><span class="overline">${te('home.render.perps')}</span><b>${te('home.render.trade_with_up_to_10x')}</b><span class="sub">${te('home.render.crypto_metals_and_rates_24')}</span></span>${slotImg('promo.perps', 'art art-img') || '<span class="art" aria-hidden="true"></span>'}<span class="faint">›</span></a>`}
      ${home.hubs.map((h, i) => `<a class="card promo ${i ? 'hub2' : 'hub'}" href="${esc(h.href || `/category/${catSlug(h.category)}`)}" data-link data-testid="home-hub"><span><b>${esc(h.title)}</b><span class="sub">${te('home.render.volume_events', { money0: money0(h.dollar_volume), events: esc(h.events) })}</span></span>${slotImg(h.category === 'Elections' ? 'hub.elections' : 'hub.economics', 'art art-img')}<span class="faint ml-auto">›</span></a>`).join('')}
      <div class="card rail-box"><h3>${te('home.render.trending')} <a href="/browse?order_by=trending" data-link>›</a></h3>${rankList(home.trending)}</div>
      <div class="card rail-box"><h3>${te('home.render.harbor_2026')} <a href="/category/elections" data-link>›</a></h3>${rankList(home.featured_list)}</div>
      <div class="card rail-box"><h3>${te('home.render.top_movers')} <a href="/browse?order_by=trending" data-link>›</a></h3>${rankList(home.top_movers)}</div>
      <div class="card rail-box"><h3>${te('home.render.new')} <a href="/browse?order_by=newest" data-link>›</a></h3>${rankList(home.new)}</div>
      <div class="faint rail-note" data-testid="home-rich-note">${tr('home.rail.note')}</div>
    </aside></div>`;

  const strip = el.querySelector('#upcoming');
  el.querySelector('#up-prev').onclick = () => strip.scrollBy({ left: -400, behavior: 'smooth' });
  el.querySelector('#up-next').onclick = () => strip.scrollBy({ left: 400, behavior: 'smooth' });
  strip.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-star]');
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    if (!session.user) { navigate('/sign-in?next=/'); return; }
    const on = b.classList.contains('on');
    try {
      if (on) await api.unwatch(session.uid, b.dataset.star); else await api.watch(session.uid, b.dataset.star);
      b.classList.toggle('on', !on); b.setAttribute('aria-pressed', String(!on));
      toast(on ? tx('home.render.removed_from_watchlist') : tx('home.render.added_to_watchlist'));
    } catch (ex) { toast(ex.message, 'error'); }
  });

  const hero = el.querySelector('#hero');
  async function drawHero() {
    if (!hl.length) { hero.innerHTML = `<p class="faint">${te('home.render.no_featured_markets')}</p>`; return; }
    const ev = hl[idx];
    const ms = [...ev.markets].sort((a, b) => (prob(b) ?? 0) - (prob(a) ?? 0)).slice(0, 3);
    hero.innerHTML = `<div class="hero-head"><div class="d-flex gap-12 ai-center">${evIcon(ev, 'sm')}<span class="overline">${esc(ev.category)}</span></div>
        <div class="pager"><button class="icon-btn" id="hero-prev" aria-label="${te('home.render.previous')}">‹</button><span data-testid="hero-pager">${te('home.render.of', { value: idx + 1, value_2: hl.length })}</span><button class="icon-btn" id="hero-next" aria-label="${te('home.render.next')}">›</button></div></div>
      <div class="minw-0"><a href="${eventHref(ev)}" data-link><h2 data-testid="hero-title">${esc(ev.title)}</h2></a>
        <div class="hero-table"><span class="h">${te('home.render.market')}</span><span class="h">${te('home.render.pays_out')}</span><span class="h ta-c">${te('home.render.odds')}</span>
        ${ms.map((m) => `<span class="outcome-row d-flex gap-16 ai-center minw-0" data-ticker="${esc(m.ticker)}">${ocAvatar(m)}<span class="oc-name"><span>${esc(m.yes_sub_title)}</span><span class="oc-bar v-w v-bg"${vars({ '--w': `${Math.max(8, prob(m) ?? 0)}%`, '--bg': seriesColor(m, ms.indexOf(m)) })}></span></span></span>
          <span class="mult">${multiplier(m)}</span><a class="odds pill" href="${eventHref(ev)}?side=yes&amp;market=${esc(m.ticker)}" data-link data-ticker-pill="${esc(m.ticker)}">${previewPct(m) == null ? '—' : previewPct(m) + '%'}</a>`).join('')}</div>
        <div class="d-flex jc-between mt-20"><span class="num muted">${te('home.render.vol', { money0: money0(ev.dollar_volume) })}</span><a href="${eventHref(ev)}" data-link class="muted">${te('home.render.trade')}</a></div>
        ${ev.news ? `<div class="news"><strong>${te('home.render.news')}</strong> · ${esc(ev.news)}</div>` : ''}</div>
      <div class="minw-0"><div class="legend">${ms.map((m, i) => `<span><i class="v-bg"${vars({ '--bg': seriesColor(m, i) })}></i>${esc(m.yes_sub_title)} <b>${prob(m) ?? '—'}%</b></span>`).join('')}<span class="watermark">${te('home.render.parlance')}</span></div>
        <div id="hero-chart"><div class="skeleton minh-260"></div></div></div>`;
    hero.querySelector('#hero-prev').onclick = () => { idx = (idx - 1 + hl.length) % hl.length; drawHero(); };
    hero.querySelector('#hero-next').onclick = () => { idx = (idx + 1) % hl.length; drawHero(); };
    const now = Math.floor(Date.now() / 1000);
    try {
      const series = await Promise.all(ms.map(async (m, i) => {
        const c = await queries.fetch(['candles', m.ticker, '1w'], () => api.candles(ev.series_ticker, m.ticker, { start_ts: now - 7 * 86400, end_ts: now, period_interval: 60 }), { staleTime: 60000 });
        return { name: m.yes_sub_title, color: seriesColor(m, i), points: c.candlesticks.map((k) => ({ t: k.end_period_ts, v: cents(k.price.close_dollars) })) };
      }));
      const box = hero.querySelector('#hero-chart');
      if (box && hl[idx] === ev) box.innerHTML = multiChart(series, { height: 280, width: 460 });
    } catch { /* chart optional */ }
  }
  drawHero();

  // Live odds on every card and the hero via the shared ticker channel.
  const unsub = socket.subscribe({ channels: ['ticker'] }, (m) => {
    if (m.type !== 'ticker' || m.msg.last_price_dollars == null) return;
    for (const row of el.querySelectorAll(`.outcome-row[data-ticker="${CSS.escape(m.msg.market_ticker)}"] .pill, [data-ticker-pill="${CSS.escape(m.msg.market_ticker)}"]`)) row.textContent = `${cents(m.msg.last_price_dollars)}%`;
  });
  return () => unsub();
}
