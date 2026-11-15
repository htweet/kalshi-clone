// The landing page for visitors (owner request 2026-11-15, CLONE_SPEC.md §41.2): the "new" variant of the home for
// signed-out visitors (owner setting layout.home_visitors; layout.home_members shows it to nobody signed in — members get
// the classic or the new member home). Top to bottom: featured-market carousel, Weekly forecasts ticker, Markets to watch
// with the promo rail and the Monthly forecast, category lists. One bundled call (GET /v1/bff/landing); prices, chips and
// chart end points follow the public `ticker` channel.
import { t as tx, te, tr } from '../i18n.js';
import '../content/landing-strings.js';
import { slotImg } from '../content-live.js';
import { vars } from '../dynstyle.js';
import { api } from '../api.js';
import { queries } from '../store.js';
import { socket } from '../ws.js';
import { esc, eventHref, catSlug, catLabel, catColor, fmtDay, cents } from '../lib.js';
import { evIcon, money0 } from './components.js';
import { waitlistCta, ownerSetting } from '../flags.js';
import { promoCards, hubCard, pctOf, pctText, isScalar, scalarValue, scalarText, changeHtml, lineChart, sparkline } from './layout-parts.js';

const OC = ['#3a7bff', '#ff4d5e', '#2fd18b'];
const colorOf = (m, i) => (m.color_code && m.color_code !== '#5b5bd6' && m.color_code !== '#3a7bff' ? m.color_code : OC[i % OC.length]);
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
// Pause / play icons (SVG: the ⏸ glyph differs by system font).
const PAUSE = '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="1.5" width="3" height="9" rx="1" fill="currentColor"/><rect x="7" y="1.5" width="3" height="9" rx="1" fill="currentColor"/></svg>';
const PLAY = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.5l7 4.5-7 4.5z" fill="currentColor"/></svg>';
const saver = () => document.documentElement.dataset.saver === '1';

// Event artwork: the CMS image (Admin › Content › Landing page; lazy, skipped in data saver) or a generated panel in the
// category colour with the series initial.
function artFor(ev, cls) {
  if (ev.image && !saver()) return `<img class="${esc(cls)}" src="${esc(ev.image.url)}" alt="${esc(ev.image.alt || '')}" width="${esc(ev.image.width)}" height="${esc(ev.image.height)}" loading="lazy" decoding="async" data-testid="lp-image">`;
  const c = ev.icon_color || catColor(ev.category);
  return `<span class="${esc(cls)} lp-gen v-bg" aria-hidden="true"${vars({ '--bg': `linear-gradient(135deg, ${c}, color-mix(in srgb, ${c} 35%, #0d0e11))` })}><span>${esc(String(ev.series_title || ev.title || '?')[0])}</span></span>`;
}
const outcomeLabel = (m) => (isScalar(m) ? scalarText(m, scalarValue(m, pctOf(m))) : `${m.yes_sub_title} ${pctText(pctOf(m))}`);
const seriesOf = (ev) => ev.markets.map((m, i) => ({ key: m.ticker, name: m.yes_sub_title, color: colorOf(m, i), points: m.points.map((p) => [p[0], p[1]]) }));

function slideHtml(ev, i, n) {
  const ms = ev.markets;
  return `<article class="lp-slide" role="group" aria-roledescription="${te('landing.hero.slide')}" aria-label="${te('landing.hero.of', { value: esc(i + 1), total: esc(n) })}" data-i="${esc(i)}" data-event="${esc(ev.event_ticker)}">
    <div class="lp-pane">
      <div class="overline">${esc(catLabel(ev.category))} · ${esc(ev.series_title)}</div>
      <a href="${eventHref(ev)}" data-link><h2 class="lp-title" data-testid="hero-slide-title">${esc(ev.title)}</h2></a>
      <div class="lp-legend">${ms.map((m, k) => `<span><i class="v-bg"${vars({ '--bg': colorOf(m, k) })}></i>${esc(m.yes_sub_title)} <b data-lp-price="${esc(m.ticker)}">${pctText(pctOf(m))}</b></span>`).join('')}</div>
      <div class="lp-chart" data-chart="${esc(i)}">${lineChart(seriesOf(ev), { w: 560, h: 210, label: ev.title })}</div>
      <div class="faint lp-vol">${te('landing.volume', { money: esc(money0(ev.dollar_volume)) })}</div>
    </div>
    <div class="lp-pane lp-side">
      ${artFor(ev, 'lp-img')}
      ${ev.context ? `<p class="lp-ctx" id="lp-ctx-${esc(i)}" data-testid="hero-context">${esc(ev.context)}</p><button type="button" class="lp-more" aria-expanded="false" aria-controls="lp-ctx-${esc(i)}" data-testid="read-more" hidden>${te('landing.read_more')}</button>` : ''}
    </div></article>`;
}

function chipsHtml(chips) {
  return chips.map((c) => `<li><a class="lp-chip" href="${eventHref(c)}" data-link data-chip="${esc(c.market.ticker)}"><b>${esc(c.label)}</b><span class="v" data-chip-value>${esc(outcomeLabel(c.market))}</span>${changeHtml(c.market)}</a></li>`).join('');
}

function watchCard(ev) {
  return `<article class="card lp-card" data-testid="event-card" data-event="${esc(ev.event_ticker)}">
    <a class="lp-card-img" href="${eventHref(ev)}" data-link tabindex="-1" aria-hidden="true">${artFor(ev, 'lp-card-pic')}</a>
    <div class="lp-card-body"><a href="${eventHref(ev)}" data-link><h3 class="lp-card-title">${esc(ev.title)}</h3></a>
      ${ev.markets.map((m, k) => `<div class="lp-row"><i class="v-bg"${vars({ '--bg': colorOf(m, k) })}></i><span>${esc(m.yes_sub_title)}</span><b data-lp-price="${esc(m.ticker)}">${pctText(pctOf(m))}</b></div>`).join('')}
      <div class="lp-chart" data-wchart="${esc(ev.event_ticker)}">${lineChart(seriesOf(ev), { w: 360, h: 120, axis: 'full', label: ev.title })}</div>
      <div class="faint">${te('landing.volume', { money: esc(money0(ev.dollar_volume)) })}</div></div></article>`;
}

const promoHtml = (L) => promoCards(L.promos, { apy: L.apy, apyHref: '/sign-up' }) + (L.hub ? hubCard(L.hub) : '');

function monthlyHtml(mo) {
  if (!mo) return '';
  const m = mo.markets[0];
  if (!m) return '';
  const sc = isScalar(m);
  const big = sc ? scalarText(m, scalarValue(m, pctOf(m))) : `${m.yes_sub_title} ${pctText(pctOf(m))}`;
  const vals = m.points.map((p) => (sc ? scalarValue(m, p[1]) : p[1]));
  return `<div class="lp-monthly"><h2 class="lp-h3"><a href="/browse?order_by=closing-soon" data-link>${te('landing.monthly.heading')} <span aria-hidden="true">›</span></a></h2>
    <a class="card lp-fc" href="${eventHref(mo)}" data-link data-testid="monthly-forecast" data-ticker="${esc(m.ticker)}"><span class="lp-fc-t">${esc(mo.heading_title)}</span>
      <span class="lp-fc-v"><b data-fc-value>${esc(big)}</b> <span class="muted">${sc ? te('landing.monthly.forecasted') : te('landing.monthly.chance')}</span></span>${changeHtml(m)}
      ${sparkline(vals, { w: 280, h: 64, color: 'var(--yes)', area: true })}</a></div>`;
}

function categoriesHtml(cats) {
  return cats.map((c) => `<div class="lp-cat" data-testid="lp-category" data-category="${esc(c.category)}"><h2 class="lp-h2"><a href="/category/${catSlug(c.category)}" data-link>${esc(catLabel(c.category))} <span aria-hidden="true">›</span></a></h2>
    <ul class="lp-list">${c.events.map((ev) => `<li><a class="lp-li" href="${eventHref(ev)}" data-link>${evIcon(ev, 'sm')}<span class="lp-li-t"><span>${esc(ev.title)}</span><span class="faint">${ev.is_live ? esc(ev.live_label || tx('landing.live')) : ev.close_time ? te('landing.closes', { day: esc(fmtDay(ev.close_time)) }) : ''}</span></span>${ev.lead ? `<span class="lp-li-p"><b data-lp-price="${esc(ev.lead.ticker)}"${isScalar(ev.lead) ? ' data-scalar' : ''}>${esc(isScalar(ev.lead) ? scalarText(ev.lead, scalarValue(ev.lead, pctOf(ev.lead))) : pctText(pctOf(ev.lead)))}</b><span class="faint">${esc(isScalar(ev.lead) ? '' : ev.lead.yes_sub_title)}</span></span>` : ''}</a></li>`).join('')}</ul></div>`).join('');
}

export async function render({ el }) {
  document.title = tx('landing.title');
  el.classList.add('lp-main');
  el.innerHTML = '<div class="lp"><div class="skeleton minh-420"></div></div>';
  const { landing: L } = await queries.fetch(['landing'], api.landing, { staleTime: 10000 });
  const hero = L.sections.includes('hero') && L.hero.length ? L.hero : [];
  const n = hero.length;
  const S = {
    hero: () => (n ? `<section class="lp-hero" id="hero" aria-roledescription="${te('landing.hero.carousel')}" aria-label="${te('landing.hero.label')}" data-testid="lp-hero">
        <div class="lp-track" id="lp-track" aria-live="off">${hero.map((ev, i) => slideHtml(ev, i, n)).join('')}</div>
        ${n > 1 ? `<button type="button" class="lp-arrow prev" id="hero-prev" aria-label="${te('landing.hero.previous')}" aria-controls="lp-track">‹</button><button type="button" class="lp-arrow next" id="hero-next" aria-label="${te('landing.hero.next')}" aria-controls="lp-track">›</button>` : ''}
        <div class="lp-hero-ctl">${n > 1 ? `<button type="button" class="lp-play" id="hero-play" data-testid="hero-play" aria-pressed="false"></button>` : ''}<span class="lp-dots" aria-hidden="true">${hero.map((_, i) => `<i data-dot="${esc(i)}"></i>`).join('')}</span><span class="sr-only" data-testid="hero-pager"></span></div></section>` : ''),
    ticker: () => (L.chips.length ? `<section class="lp-ticker" aria-labelledby="lp-tk-label" data-testid="lp-ticker"><div class="lp-tk-head"><span class="lp-tk-label" id="lp-tk-label">${te('landing.ticker.label')}</span><button type="button" class="lp-tk-btn" data-testid="ticker-pause" aria-pressed="false"></button></div>
        <div class="lp-tk-view" data-testid="ticker-view"><div class="lp-tk-track" data-testid="ticker-track"><ul class="lp-tk-list">${chipsHtml(L.chips)}</ul></div></div></section>` : ''),
    watch: () => `<section class="lp-mid lp-wrap">${L.sections.includes('watch') && L.watch.length ? `<div class="lp-watch minw-0"><h2 class="lp-h2">${te('landing.watch.heading')}</h2><div class="lp-cards" id="top-markets" data-testid="markets-to-watch">${L.watch.map(watchCard).join('')}</div></div>` : '<div></div>'}
        <aside class="lp-rail" data-testid="lp-rail">${waitlistCta('home')}${promoHtml(L)}${monthlyHtml(L.monthly)}<div class="faint rail-note" data-testid="lp-note">${tr('landing.note')}</div></aside></section>`,
    categories: () => (L.categories.length ? `<section class="lp-cats lp-wrap" data-testid="lp-categories">${categoriesHtml(L.categories)}</section>` : ''),
  };
  // The promo rail travels with Markets to watch: hiding the cards keeps the rail.
  const order = [...L.sections, ...(L.sections.includes('watch') ? [] : ['watch'])];
  el.innerHTML = `<div class="lp" data-testid="landing"><h1 class="sr-only">${te('landing.h1')}</h1>${order.map((s) => S[s]()).join('') /* eslint-disable-line parlance/no-unescaped-html -- the section builders above escape every value */}</div>`;

  const stop = [];
  if (n) stop.push(mountCarousel(el.querySelector('#hero'), hero));
  const tk = el.querySelector('.lp-ticker');
  if (tk) stop.push(mountTicker(tk));
  stop.push(live(el, L));
  return () => { el.classList.remove('lp-main'); for (const f of stop) { try { f(); } catch { /* gone */ } } };
}

// ------------------------------------------------------------------ carousel
function mountCarousel(root, hero) {
  const n = hero.length;
  const track = root.querySelector('#lp-track');
  const slides = [...root.querySelectorAll('.lp-slide')];
  const pager = root.querySelector('[data-testid=hero-pager]');
  const play = root.querySelector('#hero-play');
  let idx = 0; let prevK = slides.map(() => 0);
  let playing = n > 1 && ownerSetting('layout.hero_autoadvance', true) !== false && !reduced();
  let hover = false; let focus = false;
  const interval = Math.max(4, Number(ownerSetting('layout.hero_interval_seconds', 7)) || 7) * 1000;
  function place() {
    slides.forEach((s, i) => {
      let k = ((i - idx) % n + n) % n;
      if (k > n / 2) k -= n;
      const far = Math.abs(k) > 1 || Math.abs(k - prevK[i]) > 1;
      s.classList.toggle('far', Math.abs(k) > 1);
      s.classList.toggle('jump', far);
      s.style.setProperty('--k', String(k));
      const cur = k === 0;
      s.classList.toggle('cur', cur);
      s.inert = !cur;
      if (cur) s.removeAttribute('aria-hidden'); else s.setAttribute('aria-hidden', 'true');
      const t = s.querySelector('h2');
      t.dataset.testid = cur ? 'hero-title' : 'hero-slide-title';
      prevK[i] = k;
    });
    pager.textContent = tx('landing.hero.of', { value: idx + 1, total: n });
    for (const d of root.querySelectorAll('[data-dot]')) d.classList.toggle('on', Number(d.dataset.dot) === idx);
  }
  function drawPlay() {
    if (!play) return;
    play.setAttribute('aria-pressed', String(!playing));
    play.setAttribute('aria-label', playing ? tx('landing.hero.pause') : tx('landing.hero.play'));
    play.innerHTML = playing ? PAUSE : PLAY;
    root.dataset.playing = playing ? '1' : '0';
  }
  // A visitor's own step stops the rotation (WCAG 2.2.2) and is announced; automatic steps are not (aria-live off).
  const go = (d, manual) => {
    idx = (idx + d + n) % n;
    if (manual) { playing = false; drawPlay(); track.setAttribute('aria-live', 'polite'); } else track.setAttribute('aria-live', 'off');
    place();
  };
  root.querySelector('#hero-prev')?.addEventListener('click', () => go(-1, true));
  root.querySelector('#hero-next')?.addEventListener('click', () => go(1, true));
  if (play) play.onclick = () => { playing = !playing && !reduced(); drawPlay(); };
  root.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1, true); } else if (e.key === 'ArrowRight') { e.preventDefault(); go(1, true); }
  });
  root.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') hover = true; });
  root.addEventListener('pointerleave', () => { hover = false; });
  root.addEventListener('focusin', () => { focus = true; });
  root.addEventListener('focusout', (e) => { if (!root.contains(e.relatedTarget)) focus = false; });
  // Swipe (phones): a horizontal drag of 40 px or more steps once.
  let sx = null; let sy = 0;
  root.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') { sx = e.clientX; sy = e.clientY; } });
  root.addEventListener('pointerup', (e) => { if (sx == null) return; const dx = e.clientX - sx; const dy = e.clientY - sy; sx = null; if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1, true); });
  // "Read more": only where the paragraph is cut off.
  for (const p of root.querySelectorAll('.lp-ctx')) {
    const b = p.nextElementSibling;
    b.hidden = !(p.scrollHeight > p.clientHeight + 1);
    b.onclick = () => { const open = b.getAttribute('aria-expanded') !== 'true'; p.classList.toggle('open', open); b.setAttribute('aria-expanded', String(open)); b.textContent = open ? tx('landing.read_less') : tx('landing.read_more'); };
  }
  place(); drawPlay();
  const timer = setInterval(() => { if (playing && !hover && !focus && !document.hidden) go(1, false); }, interval);
  return () => clearInterval(timer);
}

// ------------------------------------------------------------------ Weekly forecasts ticker
function mountTicker(sec) {
  const view = sec.querySelector('.lp-tk-view');
  const track = sec.querySelector('.lp-tk-track');
  const list = track.querySelector('ul');
  const btn = sec.querySelector('[data-testid=ticker-pause]');
  const auto = ownerSetting('layout.ticker_autoscroll', true) !== false && !reduced();
  let paused = false;
  if (auto) {
    // Fill one copy to at least the band's width, then a second, hidden copy makes the loop seamless (-50%).
    const one = list.innerHTML;
    const reps = Math.max(1, Math.ceil(view.clientWidth / Math.max(1, list.scrollWidth)));
    list.innerHTML = one.repeat(reps); // eslint-disable-line parlance/no-unescaped-html -- the chips' own markup (escaped by chipsHtml), repeated
    const copy = list.cloneNode(true);
    copy.setAttribute('aria-hidden', 'true');
    copy.inert = true;
    track.append(copy);
    // The repeats are decorative too: only the first set of chips is in the tab order and the accessibility tree.
    const items = [...list.children];
    const per = items.length / reps;
    items.forEach((li, i) => { if (i >= per) { li.setAttribute('aria-hidden', 'true'); li.inert = true; } });
    track.style.setProperty('--dur', `${Math.max(20, Math.round(list.scrollWidth / 40))}s`);
    track.classList.add('run');
  }
  sec.classList.toggle('static', !auto);
  const draw = () => {
    btn.hidden = !auto;
    btn.setAttribute('aria-pressed', String(paused));
    btn.setAttribute('aria-label', paused ? tx('landing.ticker.play') : tx('landing.ticker.pause'));
    btn.innerHTML = paused ? PLAY : PAUSE;
    track.classList.toggle('paused', paused);
    sec.dataset.paused = paused ? '1' : '0';
  };
  btn.onclick = () => { paused = !paused; draw(); };
  draw();
  return () => {};
}

// ------------------------------------------------------------------ live prices (public `ticker` channel)
function live(el, L) {
  const mk = new Map(); // ticker -> market objects to keep in step
  const add = (m) => { if (!m) return; if (!mk.has(m.ticker)) mk.set(m.ticker, []); mk.get(m.ticker).push(m); };
  for (const ev of [...L.hero, ...L.watch]) for (const m of ev.markets) add(m);
  for (const c of L.chips) add(c.market);
  if (L.monthly) add(L.monthly.markets[0]);
  for (const c of L.categories) for (const ev of c.events) add(ev.lead);
  const tickers = [...mk.keys()];
  if (!tickers.length) return () => {};
  let pending = new Set(); let raf = 0;
  const flush = () => {
    raf = 0;
    const done = pending; pending = new Set();
    for (const t of done) {
      const m = mk.get(t)[0];
      const p = pctOf(m);
      for (const b of el.querySelectorAll(`[data-lp-price="${CSS.escape(t)}"]`)) b.textContent = b.hasAttribute('data-scalar') ? scalarText(m, scalarValue(m, p)) : pctText(p);
      for (const a of el.querySelectorAll(`[data-chip="${CSS.escape(t)}"]`)) {
        a.querySelector('[data-chip-value]').textContent = outcomeLabel(m);
        a.querySelector('[data-chg]').outerHTML = changeHtml(m);
      }
      const fc = el.querySelector(`[data-testid=monthly-forecast][data-ticker="${CSS.escape(t)}"] [data-fc-value]`);
      if (fc) fc.textContent = isScalar(m) ? scalarText(m, scalarValue(m, p)) : `${m.yes_sub_title} ${pctText(p)}`;
    }
    // Chart end points: redraw the charts whose lines moved.
    L.hero.forEach((ev, i) => { if (ev.markets.some((m) => done.has(m.ticker))) { const box = el.querySelector(`[data-chart="${i}"]`); if (box) box.innerHTML = lineChart(seriesOf(ev), { w: 560, h: 210, label: ev.title }); } });
    for (const ev of L.watch) if (ev.markets.some((m) => done.has(m.ticker))) { const box = el.querySelector(`[data-wchart="${CSS.escape(ev.event_ticker)}"]`); if (box) box.innerHTML = lineChart(seriesOf(ev), { w: 360, h: 120, axis: 'full', label: ev.title }); }
  };
  const unsub = socket.subscribe({ channels: ['ticker'], market_tickers: tickers }, (msg) => {
    if (msg.type !== 'ticker' || !mk.has(msg.msg.market_ticker) || msg.msg.last_price_dollars == null) return;
    const now = Math.floor((msg.msg.ts || Date.now()) / 1000);
    for (const m of mk.get(msg.msg.market_ticker)) {
      m.last_price_dollars = msg.msg.last_price_dollars;
      if (msg.msg.previous_price_dollars != null) m.previous_price_dollars = msg.msg.previous_price_dollars;
      if (m.points) { const v = Math.round(cents(msg.msg.last_price_dollars) * 10) / 10; const last = m.points[m.points.length - 1]; if (last && now - last[0] < 60) last[1] = v; else m.points.push([now, v]); }
    }
    pending.add(msg.msg.market_ticker);
    if (!raf) raf = requestAnimationFrame(flush);
  });
  return () => { unsub(); if (raf) cancelAnimationFrame(raf); };
}
