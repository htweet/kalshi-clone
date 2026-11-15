// The new member home (owner request 2026-11-15, CLONE_SPEC.md §41.3): the "new" variant of the home for signed-in
// members (owner setting layout.home_members; classic stays the recommended default until it is approved). Main column:
// featured-market carousel (Market · Pays out · Odds, "N more", news), the Get ready to trade card, 15 Min Markets with a
// countdown to the next close, Upcoming and the market sections. Rail: promo and hub cards, Customize your view
// (Prediction / Trader, also in Settings), Trending and Top movers.
import { t as tx, te, tr } from '../i18n.js';
import '../content/home-new-strings.js';
import { vars } from '../dynstyle.js';
import { api } from '../api.js';
import { queries, session } from '../store.js';
import { socket } from '../ws.js';
import { esc, eventHref, cents, money, toast } from '../lib.js';
import { rankList, evIcon } from './components.js';
import { waitlistCta, ownerSetting, flagOn } from '../flags.js';
import { mountHero, upcomingHtml, sectionsHtml, watchedSet, wireUpcoming, liveOdds } from './home.js';
import { sparkline, promoCards, hubCard } from './layout-parts.js';


function onboardingHtml(o) {
  if (!o || !o.current) return '';
  const step = o.steps.find((s) => s.step === o.current);
  return `<section class="card hn-ob" data-testid="onboarding-card" data-step="${esc(o.current)}" aria-labelledby="hn-ob-title">
    <div class="hn-ob-text"><span class="overline">${te('home-new.onboarding.overline')}</span><h2 class="hn-ob-title" id="hn-ob-title">${te(`home-new.onboarding.title.${o.current}`)}</h2></div>
    <div class="hn-ob-progress"><span class="hn-ob-bar" role="progressbar" aria-label="${te('home-new.onboarding.progress')}" aria-valuemin="0" aria-valuemax="${esc(o.total)}" aria-valuenow="${esc(o.completed)}"><i class="v-w"${vars({ '--w': `${Math.max(6, Math.round((o.completed / o.total) * 100))}%` })}></i></span><span class="muted" data-testid="onboarding-step">${te('home-new.onboarding.step', { n: esc(o.step_number), total: esc(o.total) })}</span></div>
    <div class="hn-ob-actions"><a class="btn btn-pill" href="/rewards" data-link>${te('home-new.onboarding.all_steps')}</a><a class="btn btn-pill btn-primary" href="${esc(step.href)}" data-link data-testid="onboarding-next">${te(`home-new.onboarding.action.${o.current}`)}</a>
      <button type="button" class="icon-btn" data-testid="onboarding-dismiss" aria-label="${te('home-new.onboarding.dismiss')}">✕</button></div></section>`;
}

const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const abovePct = (w) => cents(w.market.last_price_dollars) ?? cents(w.market.yes_ask_dollars) ?? 50;
function fifteenCard(w) {
  const href = eventHref({ series_ticker: w.series_ticker, series_slug: w.series_slug, event_ticker: w.event_ticker });
  const dist = Number(w.distance_dollars);
  const up = abovePct(w);
  return `<article class="card fm-card" data-testid="fifteen-card" data-event="${esc(w.event_ticker)}" data-underlying="${esc(w.underlying)}" data-market="${esc(w.market.ticker)}">
    <div class="fm-head">${evIcon({ category: 'Crypto', title: w.underlying, icon_color: w.color }, 'sm')}<span class="overline">${esc(w.label)}</span></div>
    <div class="fm-top"><div class="minw-0"><div class="fm-target" data-testid="fifteen-target">${te('home-new.fifteen.target', { money: esc(money(w.target_dollars)) })}</div>
      <div class="fm-dist ${dist < 0 ? 'down' : 'up'}">${dist < 0 ? '↓' : '↑'} ${dist < 0 ? te('home-new.fifteen.below', { money: esc(money(Math.abs(dist))) }) : te('home-new.fifteen.above', { money: esc(money(Math.abs(dist))) })}</div></div>
      <div class="fm-spark">${sparkline(w.prices.map((p) => Number(p[1])), { w: 200, h: 48, color: w.color, target: Number(w.target_dollars) })}</div></div>
    <div class="fm-ab"><a class="ab-btn up" href="${href}?side=yes&amp;market=${esc(w.market.ticker)}" data-link data-ab="up">${te('home-new.fifteen.buy_above', { pct: esc(up) })}</a><a class="ab-btn down" href="${href}?side=no&amp;market=${esc(w.market.ticker)}" data-link data-ab="down">${te('home-new.fifteen.buy_below', { pct: esc(100 - up) })}</a></div>
    <div class="faint">${te('home-new.fifteen.vol', { money: esc(money(w.market.dollar_volume || 0)) })}</div></article>`;
}

function customizeHtml(mode) {
  return `<section class="card rail-box cv-card" data-testid="customize-card" aria-labelledby="cv-title"><h3 id="cv-title">${te('home-new.customize.title')} <button type="button" class="icon-btn" data-testid="customize-dismiss" aria-label="${te('home-new.customize.close')}">✕</button></h3>
    <div class="cv-toggle" role="radiogroup" aria-label="${te('home-new.customize.mode_label')}">${['prediction', 'trader'].map((m) => `<button type="button" role="radio" aria-checked="${mode === m}" data-mode="${m}" data-testid="view-${m}">${te(`home-new.customize.${m}`)}</button>`).join('')}</div>
    <p class="faint" data-testid="customize-help">${te(`home-new.customize.help_${mode}`)}</p></section>`;
}

export async function render({ el, navigate }) {
  document.title = tx('home.render.parlance_exchange_trade_on_outcomes');
  el.innerHTML = '<div class="home"><div class="skeleton minh-420"></div><div class="skeleton"></div></div>';
  const [{ home }, mh, watching] = await Promise.all([queries.fetch(['home'], api.home, { staleTime: 15000 }), api.memberHome().catch(() => ({ fifteen_min: { windows: [] }, me: null })), watchedSet()]);
  const me = mh.me || { onboarding: null, view_mode: 'prediction' };
  let mode = me.view_mode || 'prediction';
  const showOnboarding = ownerSetting('layout.member_onboarding_card', true) !== false && !me.onboarding_dismissed;
  const showCustomize = ownerSetting('layout.member_customize_card', true) !== false && !me.customize_dismissed;
  const showFifteen = ownerSetting('layout.member_fifteen_min', true) !== false && flagOn('trading.rolling');

  el.innerHTML = `<div class="home home-new" data-testid="home-new">
    <div class="minw-0">
      ${waitlistCta('home')}
      <section class="card hero" id="hero" aria-roledescription="${te('home.render.carousel')}"></section>
      ${showOnboarding ? onboardingHtml(me.onboarding) : ''}
      ${showFifteen ? `<section class="fm-sec" data-testid="fifteen-min"><div class="sec-head"><h2 class="fm-h"><a href="/category/crypto" data-link>${te('home-new.fifteen.heading')} <span aria-hidden="true">›</span></a></h2><span class="spacer"></span><span class="cd-pill" role="timer" data-testid="fifteen-countdown"></span></div><div class="fm-grid" data-fm-grid></div></section>` : ''}
      ${upcomingHtml(home, watching)}
      ${sectionsHtml(home)}
    </div>
    <aside class="rail">
      ${promoCards(home.promos, { apy: mh.apy ?? 0.035, apyHref: '/funds' })}${home.hubs.slice(0, 1).map(hubCard).join('')}
      ${showCustomize ? customizeHtml(mode) : ''}
      <div class="card rail-box"><h3>${te('home.render.trending')} <a href="/browse?order_by=trending" data-link aria-label="${te('home.render.trending')}">›</a></h3>${rankList(home.trending)}</div>
      <div class="card rail-box"><h3>${te('home.render.top_movers')} <a href="/browse?order_by=trending" data-link aria-label="${te('home.render.top_movers')}">›</a></h3>${rankList(home.top_movers)}</div>
      <div class="faint rail-note" data-testid="home-rich-note">${tr('home.rail.note')}</div>
    </aside></div>`;

  wireUpcoming(el, navigate);
  mountHero(el.querySelector('#hero'), home.highlights, { more: true });
  const stops = [liveOdds(el)];

  el.querySelector('[data-testid=onboarding-dismiss]')?.addEventListener('click', async () => {
    try { await session.setPreferences({ home_onboarding_dismissed: true }); el.querySelector('[data-testid=onboarding-card]')?.remove(); } catch (ex) { toast(ex.message, 'error'); }
  });
  const cv = el.querySelector('[data-testid=customize-card]');
  if (cv) {
    cv.addEventListener('click', async (e) => {
      if (e.target.closest('[data-testid=customize-dismiss]')) {
        try { await session.setPreferences({ home_customize_dismissed: true }); cv.remove(); } catch (ex) { toast(ex.message, 'error'); }
        return;
      }
      const b = e.target.closest('[data-mode]');
      if (!b || b.dataset.mode === mode) return;
      try {
        await session.setPreferences({ view_mode: b.dataset.mode });
        mode = b.dataset.mode;
        for (const x of cv.querySelectorAll('[data-mode]')) x.setAttribute('aria-checked', String(x.dataset.mode === mode));
        cv.querySelector('[data-testid=customize-help]').textContent = tx(`home-new.customize.help_${mode}`);
        toast(tx(`home-new.customize.saved_${mode}`));
      } catch (ex) { toast(ex.message, 'error'); }
    });
    cv.addEventListener('keydown', (e) => { // radio group: arrow keys move the choice
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) || !e.target.closest('[data-mode]')) return;
      e.preventDefault();
      const next = cv.querySelector(`[data-mode="${mode === 'prediction' ? 'trader' : 'prediction'}"]`);
      next.focus(); next.click();
    });
  }
  if (showFifteen) stops.push(mountFifteen(el.querySelector('[data-testid=fifteen-min]'), mh.fifteen_min));
  return () => { for (const f of stops) { try { f(); } catch { /* gone */ } } };
}

// 15 Min Markets: cards for every open window, a countdown to the next close (every second), the window data refreshed
// every 15 s while the page is visible and right after a close, Above / Below odds live from the `ticker` channel.
function mountFifteen(sec, first) {
  const grid = sec.querySelector('[data-fm-grid]');
  const pill = sec.querySelector('[data-testid=fifteen-countdown]');
  let data = first; let unsub = () => {}; let refreshing = false;
  const draw = () => {
    grid.innerHTML = data.windows.length ? data.windows.slice(0, 4).map(fifteenCard).join('') : `<p class="faint">${te('home-new.fifteen.none')}</p>`;
    unsub();
    const tickers = data.windows.map((w) => w.market.ticker);
    unsub = tickers.length ? socket.subscribe({ channels: ['ticker'], market_tickers: tickers }, (m) => {
      if (m.type !== 'ticker' || m.msg.last_price_dollars == null) return;
      const card = grid.querySelector(`[data-market="${CSS.escape(m.msg.market_ticker)}"]`);
      if (!card) return;
      const up = cents(m.msg.last_price_dollars);
      card.querySelector('[data-ab=up]').textContent = tx('home-new.fifteen.buy_above', { pct: up });
      card.querySelector('[data-ab=down]').textContent = tx('home-new.fifteen.buy_below', { pct: 100 - up });
    }) : () => {};
  };
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try { const r = await api.memberHome(); data = r.fifteen_min; draw(); } catch { /* keep the last view */ } finally { refreshing = false; }
  };
  const tick = () => {
    if (!data.next_close_time) { pill.hidden = true; return; }
    const left = Date.parse(data.next_close_time) - Date.now();
    pill.hidden = false;
    pill.textContent = `● ${mmss(left)}`;
    pill.setAttribute('aria-label', tx('home-new.fifteen.countdown', { time: mmss(left) }));
    if (left <= -2000) { data = { ...data, next_close_time: null }; refresh(); }
  };
  draw(); tick();
  const t1 = setInterval(tick, 1000);
  const t2 = setInterval(() => { if (!document.hidden) refresh(); }, 15000);
  return () => { clearInterval(t1); clearInterval(t2); unsub(); };
}
