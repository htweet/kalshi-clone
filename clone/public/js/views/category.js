// Category page, new layout (owner request 2026-11-15, CLONE_SPEC.md §41): sidebar (All markets and frequencies with
// counts, admin-managed groups, hub link), title with sort / frequency / ⋯ controls, featured carousel (outcome table
// with multipliers and % pills, multi-line chart or the underlying price), two columns of market cards, and per
// category the Top-cities strip, the sports games strip with kind chips and a docked ticket, and a dismissible banner.
// One request (GET /v1/bff/category/:slug); live prices over the shared `ticker` channel. When the owner setting
// "Category page layout" (or the category's own override) is "classic", the earlier Browse layout renders instead.
import { t, te } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/category-strings.js';
import { vars } from '../dynstyle.js';
import { api, request } from '../api.js';
import { session, queries } from '../store.js';
import { socket } from '../ws.js';
import { esc, cents, prob, multiplier, previewPct, eventHref, catFromSlug, catLabel, catColor, scrollMotion, toast } from '../lib.js';
import { eventCard, evIcon, ocAvatar, multiChart, seriesColor, money0 } from './components.js';
import { groupIcon, citiesStrip, citiesHtml, gamesStrip, bannerHtml, underlyingHtml } from './category-cards.js';

const FREQ_LABEL = { fifteen_min: 'category.freq.fifteen_min', hourly: 'category.freq.hourly', daily: 'category.freq.daily', weekly: 'category.freq.weekly', monthly: 'category.freq.monthly', annual: 'category.freq.annual', one_off: 'category.freq.one_off' };
const ORDERS = [['trending', 'category.order.trending'], ['event-volume', 'category.order.volume'], ['newest', 'category.order.newest'], ['closing-soon', 'category.order.closing_soon']];
const STATUSES = [['open', 'category.status.open'], ['unopened', 'category.status.upcoming'], ['closed', 'category.status.closed'], ['settled', 'category.status.settled'], ['all', 'category.status.all']];
const KIND_LABEL = { games: 'category.kind.games', lines: 'category.kind.lines', futures: 'category.kind.futures' };
const ROWS = 4;
const BANNER_KEY = (k) => `plx.cp-banner.${k}`;
const dockWide = () => typeof matchMedia === 'function' && matchMedia('(min-width: 1200px)').matches;

export async function render(ctx) {
  const { el, params, query, navigate } = ctx;
  const slug = String(params.category || '');
  const category = catFromSlug(slug);
  if (!category) { const e = new Error(t('category.unknown')); e.notFound = true; throw e; }
  const tag = params.tag || '';
  const f = { order_by: query.get('order_by') || session.props.browse_order_by || 'trending', frequency: query.get('frequency') || '', status: query.get('status') || 'open', series: query.get('series') || '', group: query.get('group') || '', kind: query.get('kind') || '', tag };
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
  const data = await request('GET', `/v1/bff/category/${encodeURIComponent(slug)}?${qs}`);
  if (data.layout === 'classic') return ctx.browse.render(ctx); // owner setting / category override (CLONE_SPEC.md §41.6)
  const label = catLabel(category);
  document.title = t('category.title', { label });
  let layout = session.props.browse_layout || 'grid';
  const base = `/category/${slug}`;
  const href = (patch) => { const u = new URLSearchParams(); for (const k of ['order_by', 'status']) if (query.get(k)) u.set(k, query.get(k)); for (const [k, v] of Object.entries(patch)) if (v) u.set(k, v); const s = u.toString(); return `${patch.tag ? `${base}/${encodeURIComponent(patch.tag)}` : base}${s && !patch.tag ? `?${s}` : ''}`; };
  const filtered = !!(f.frequency || f.series || f.group || f.kind || f.tag);
  const sb = data.sidebar;
  const dock = data.docked_ticket;
  const cnt = (n) => `<span class="cnt">(${esc(n)})</span>`;
  // `inner` and `extra` are markup built here from escaped values and catalog text.
  const link = (h, inner, on, extra = '') => `<a class="cp-side-link${on ? ' on' : ''}" href="${esc(h)}" data-link${on ? ' aria-current="page"' : ''}${extra}>${inner /* eslint-disable-line parlance/no-unescaped-html -- markup built from escaped values */}</a>`;

  const groupHref = (g) => (g.type === 'tag' ? href({ tag: g.tag }) : g.series ? href({ series: g.series }) : href({ group: g.id }));
  const groupOn = (g) => (g.type === 'tag' ? f.tag && f.tag.toLowerCase() === String(g.tag).toLowerCase() : g.series ? f.series === g.series : f.group === g.id);
  const sideHtml = `<nav class="cp-side" aria-label="${te('category.side.label', { label: esc(label) })}" data-testid="cat-sidebar">
      ${link(base, `${te('category.side.all')} ${cnt(sb.all)}`, !filtered, ' data-testid="side-all"')}
      ${sb.frequencies.map((x) => link(href({ frequency: x.key }), `${te(FREQ_LABEL[x.key])} ${cnt(x.count)}`, f.frequency === x.key, ` data-freq="${esc(x.key)}"`)).join('')}
      ${data.sports && data.sports.featured_leagues.length ? `<div class="cp-side-h overline">${te('category.side.featured')}</div>${data.sports.featured_leagues.map((l) => link(href({ series: l.series_ticker }), `${groupIcon({ glyph: 'ball' }, l.name, catColor(category))}${esc(l.name)}`, f.series === l.series_ticker)).join('')}` : ''}
      ${sb.groups.length ? '<hr class="cp-side-hr">' : ''}
      ${sb.groups.map((g) => {
        const open = !g.collapsed || g.children.some((c) => c.ticker === f.series);
        return `<div class="cp-group" data-group="${esc(g.id)}"><div class="cp-group-row">${link(groupHref(g), `${groupIcon(g.icon, g.label, catColor(category))}<span class="cp-lbl">${esc(g.label)} ${cnt(g.count)}</span>`, groupOn(g), ` data-testid="side-group" data-count="${esc(g.count)}"`)}
          ${g.children.length ? `<button class="cp-exp" type="button" aria-expanded="${open}" aria-controls="cpg-${esc(g.id)}" aria-label="${te('category.side.expand', { label: esc(g.label) })}">▾</button>` : ''}</div>
          ${g.children.length ? `<div class="cp-children" id="cpg-${esc(g.id)}"${open ? '' : ' hidden'}>${g.children.map((c) => link(href({ series: c.ticker }), `<span class="cp-lbl">${esc(c.title)} ${cnt(c.count)}</span>`, f.series === c.ticker, ` data-series="${esc(c.ticker)}" data-count="${esc(c.count)}"`)).join('')}</div>` : ''}</div>`;
      }).join('')}
      ${sb.hub ? `<hr class="cp-side-hr">${link(sb.hub.href, `${esc(sb.hub.label)}${sb.hub.external ? ' ↗' : ''}`, false, ` data-testid="${esc(sb.hub.testid || 'cat-hub-link')}"`)}` : ''}
    </nav>`;

  const sel = (id, list, cur, lbl) => `<select class="pill-select" id="${esc(id)}" aria-label="${te(lbl)}">${list.map(([v, k]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${te(k)}</option>`).join('')}</select>`;
  const freqOpts = [['', 'category.tools.frequency'], ...Object.entries(FREQ_LABEL)];
  const tools = `<div class="cp-tools">
      ${sel('order-by', ORDERS, f.order_by, 'category.tools.sort')}
      ${sel('frequency', freqOpts, f.frequency, 'category.tools.frequency')}
      ${category === 'Sports' ? `<a class="icon-btn" href="/account/settings" data-link aria-label="${te('category.tools.settings')}" data-testid="cp-settings">⚙</a>` : ''}
      <details class="cp-more"><summary class="icon-btn" aria-label="${te('category.tools.more')}">⋯</summary><div class="cp-more-menu card"><label class="field">${te('category.tools.status')}${sel('status', STATUSES, f.status, 'category.tools.status')}</label></div></details>
      <div class="seg" role="group" aria-label="${te('category.tools.layout')}"><button type="button" data-layout="grid" aria-label="${te('category.tools.grid')}">▦</button><button type="button" data-layout="list" aria-label="${te('category.tools.list')}">☰</button></div></div>`;
  const kinds = data.sports ? `<div class="chips cp-kinds" data-testid="kind-chips">${data.sports.kinds.map((k) => `<a class="chip${f.kind === k.key ? ' on' : ''}" href="${esc(href({ kind: f.kind === k.key ? '' : k.key }))}" data-link data-kind="${esc(k.key)}">${te(KIND_LABEL[k.key])} <span class="cnt">(${esc(k.count)})</span></a>`).join('')}</div>` : '';
  let banner = data.banner;
  if (banner && !session.user) { try { if (Number(localStorage.getItem(BANNER_KEY(banner.key))) >= banner.version) banner = null; } catch { /* storage unavailable */ } }

  el.innerHTML = `<div class="cp" data-testid="category-page" data-category="${esc(slug)}">
    ${data.top_cities ? citiesStrip(data.top_cities) : ''}${data.sports ? gamesStrip(data.sports) : ''}
    <div class="cp-body${dock ? ' has-dock' : ''}">
      ${sideHtml}
      <div class="cp-main minw-0">
        ${banner ? bannerHtml(banner) : ''}
        <div class="cp-head"><h1 class="page-title" data-testid="cp-title">${esc(label)}</h1>${tools}</div>
        <div class="targeted-promos" data-testid="category-promos"></div>
        ${kinds}
        ${data.featured.length ? `<section class="card cp-feat" id="cp-feat" aria-roledescription="${te('category.featured.carousel')}" aria-label="${te('category.featured.label')}" data-testid="cp-featured"></section>` : ''}
        <div class="faint m-count" id="result-count" data-testid="cp-count">${te('category.count', { n: esc(data.total) })}</div>
        <div class="grid cp-grid" id="results">${data.events.map(eventCard).join('') || `<div class="card empty" data-testid="empty-results">${te('category.empty')}</div>`}</div>
        <div class="ta-c mt-16"><button class="btn" id="more" type="button"${data.next_cursor ? '' : ' hidden'}>${te('category.load_more')}</button></div>
      </div>
      ${dock ? `<aside class="cp-dock-col" aria-label="${te('category.dock.label')}"><a class="combo-btn cp-combo" href="/combos" data-link data-flag="combos" data-testid="cp-combo">${te('category.dock.combo')}</a><div id="cp-dock" class="cp-dock" data-testid="cp-dock"></div></aside>` : ''}
    </div></div>`;
  const $ = (s) => el.querySelector(s);
  const cleanups = [];
  import('./social2.js').then((m) => m.renderPromos($('[data-testid=category-promos]'), { category })).catch(() => {}); // targeted promos (G8)

  // ---------- sidebar, tools, layout, load more ----------
  for (const b of el.querySelectorAll('.cp-exp')) b.onclick = () => { const box = document.getElementById(b.getAttribute('aria-controls')); const open = b.getAttribute('aria-expanded') !== 'true'; b.setAttribute('aria-expanded', String(open)); box.hidden = !open; };
  const go = (patch) => { const u = new URL(location.href); for (const [k, v] of Object.entries(patch)) { if (v) u.searchParams.set(k, v); else u.searchParams.delete(k); } navigate(u.pathname + u.search, { replace: true }); };
  $('#order-by').onchange = async (e) => { if (session.user) await session.setProp('browse_order_by', e.target.value).catch(() => {}); go({ order_by: e.target.value }); };
  $('#frequency').onchange = (e) => go({ frequency: e.target.value });
  $('#status').onchange = (e) => go({ status: e.target.value });
  const results = $('#results');
  const drawLayout = () => { results.classList.toggle('list', layout === 'list'); for (const b of el.querySelectorAll('[data-layout]')) { b.classList.toggle('on', b.dataset.layout === layout); b.setAttribute('aria-pressed', String(b.dataset.layout === layout)); } };
  drawLayout();
  for (const b of el.querySelectorAll('[data-layout]')) b.onclick = () => { layout = b.dataset.layout; drawLayout(); if (session.user) session.setProp('browse_layout', layout).catch(() => {}); };
  let cursor = data.next_cursor;
  $('#more').onclick = async () => {
    const r = await request('GET', `/v1/bff/category/${encodeURIComponent(slug)}?${new URLSearchParams([...qs, ['cursor', cursor]])}`);
    results.insertAdjacentHTML('beforeend', r.events.map(eventCard).join(''));
    cursor = r.next_cursor; $('#more').hidden = !cursor;
  };

  // ---------- strips and banner ----------
  for (const s of el.querySelectorAll('.cp-strip')) {
    const body = s.querySelector('[data-strip-body]');
    for (const b of s.querySelectorAll('[data-strip]')) b.onclick = () => body.scrollBy({ left: Number(b.dataset.strip) * 420, behavior: scrollMotion() });
    for (const b of s.querySelectorAll('[data-day]')) {
      b.onclick = () => {
        for (const x of s.querySelectorAll('[data-day]')) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); }
        body.innerHTML = citiesHtml(data.top_cities, b.dataset.day);
      };
    }
  }
  const bannerEl = $('[data-testid=cp-banner]');
  if (bannerEl) {
    bannerEl.querySelector('[data-banner-close]').onclick = async () => {
      bannerEl.remove();
      if (session.user) { try { await request('POST', `/v1/bff/category/${encodeURIComponent(slug)}/banner/dismiss`, {}); } catch (e) { toast(e.message, 'error'); } } else { try { localStorage.setItem(BANNER_KEY(banner.key), String(banner.version)); } catch { /* storage unavailable */ } }
    };
  }

  // ---------- featured carousel ----------
  const feat = data.featured;
  let idx = 0;
  let chartState = null; // { ev, series: [{ticker, name, color, points}] }
  const featBox = $('#cp-feat');
  const rowsOf = (ev) => {
    if (ev.underlying && ev.underlying.kind === 'target' && ev.markets.length === 1) {
      const m = ev.markets[0]; const p = previewPct(m);
      const noAsk = cents(m.no_ask_dollars);
      return [{ m, name: t('category.featured.up'), side: 'yes', pct: p, mult: multiplier(m), color: 'var(--yes)' }, { m, name: t('category.featured.down'), side: 'no', pct: p == null ? null : 100 - p, mult: noAsk ? `${(100 / noAsk).toFixed(2)}x` : '—', color: 'var(--no)' }];
    }
    return [...ev.markets].filter((m) => m.status === 'active').sort((a, b) => (prob(b) ?? 0) - (prob(a) ?? 0)).slice(0, ROWS).map((m, i) => ({ m, name: m.yes_sub_title, side: 'yes', pct: previewPct(m), mult: multiplier(m), color: seriesColor(m, i) }));
  };
  function drawFeat() {
    if (!featBox) return;
    const ev = feat[idx];
    const rows = rowsOf(ev);
    const more = ev.markets.filter((m) => m.status === 'active').length - rows.length;
    const h = eventHref(ev);
    const avatars = data.outcome_avatars && ev.markets.length > 1;
    featBox.dataset.event = ev.event_ticker;
    featBox.innerHTML = `<div class="hero-head"><div class="d-flex gap-12 ai-center">${evIcon(ev, 'sm')}<span class="overline">${esc(ev.series_title || label)}</span>${ev.pinned ? `<span class="sr-only">${te('category.featured.pinned')}</span>` : ''}</div>
        ${feat.length > 1 ? `<div class="pager"><button class="icon-btn" type="button" data-feat="-1" aria-label="${te('category.featured.prev')}">‹</button><span data-testid="cp-pager" aria-live="polite">${te('category.featured.of', { n: idx + 1, total: feat.length })}</span><button class="icon-btn" type="button" data-feat="1" aria-label="${te('category.featured.next')}">›</button></div>` : ''}</div>
      <div class="minw-0"><a href="${h}" data-link><h2 data-testid="cp-feat-title">${esc(ev.title)}</h2></a>
        <div class="hero-table cp-table" data-testid="cp-table"><span class="h">${te('category.featured.market')}</span><span class="h">${te('category.featured.pays_out')}</span><span class="h ta-c">${te('category.featured.odds')}</span>
        ${rows.map((r) => `<span class="outcome-row d-flex gap-16 ai-center minw-0" data-ticker="${esc(r.m.ticker)}" data-side="${esc(r.side)}">${avatars ? ocAvatar(r.m) : ''}<span class="oc-name"><span>${esc(r.name)}</span><span class="oc-bar v-w v-bg"${vars({ '--w': `${Math.max(6, r.pct ?? 0)}%`, '--bg': r.color })}></span></span></span>
          <span class="mult" data-testid="cp-mult" data-ask="${esc(r.side === 'yes' ? r.m.yes_ask_dollars ?? '' : r.m.no_ask_dollars ?? '')}">${esc(r.mult)}</span><a class="odds pill" href="${h}?side=${esc(r.side)}&amp;market=${esc(r.m.ticker)}" data-link data-testid="cp-pill" data-ticker-pill${r.side === 'no' ? '-no' : ''}="${esc(r.m.ticker)}" aria-label="${te('category.featured.pill', { name: esc(r.name), pct: r.pct == null ? '—' : esc(r.pct) })}">${r.pct == null ? '—' : `${esc(r.pct)}%`}</a>`).join('')}</div>
        <div class="d-flex jc-between mt-20"><span class="num muted" data-testid="cp-vol">${te('category.featured.vol', { money0: esc(money0(ev.dollar_volume ?? 0)) })}</span><a href="${h}" data-link class="muted" data-testid="cp-more">${more > 0 ? te('category.featured.more', { n: more }) : te('category.featured.trade')}</a></div></div>
      <div class="minw-0 cp-feat-right">${ev.underlying ? underlyingHtml(ev.underlying) : `<div class="legend" data-testid="cp-legend">${rows.slice(0, 3).map((r) => `<span data-legend="${esc(r.m.ticker)}"><i class="v-bg"${vars({ '--bg': r.color })}></i>${esc(r.name)} <b>${esc(r.pct ?? '—')}%</b></span>`).join('')}<span class="watermark">${te('category.featured.brand')}</span></div>
        <div class="cp-chart" data-testid="cp-chart"><div class="skeleton minh-260"></div></div>`}</div>`;
    for (const b of featBox.querySelectorAll('[data-feat]')) b.onclick = () => { idx = (idx + Number(b.dataset.feat) + feat.length) % feat.length; drawFeat(); };
    chartState = null;
    if (!ev.underlying) loadChart(ev, rows.slice(0, 3));
  }
  async function loadChart(ev, rows) {
    const now = Math.floor(Date.now() / 1000);
    try {
      const series = await Promise.all(rows.map(async (r) => {
        const c = await queries.fetch(['candles', r.m.ticker, '1w'], () => api.candles(ev.series_ticker, r.m.ticker, { start_ts: now - 7 * 86400, end_ts: now, period_interval: 60 }), { staleTime: 60000 });
        return { ticker: r.m.ticker, name: r.name, color: r.color, points: c.candlesticks.map((k) => ({ t: k.end_period_ts, v: cents(k.price.close_dollars) })).filter((p) => p.v != null) };
      }));
      if (feat[idx] !== ev) return;
      chartState = { ev, series };
      drawChart();
    } catch { const box = featBox.querySelector('[data-testid=cp-chart]'); if (box) box.innerHTML = ''; }
  }
  const drawChart = () => { const box = featBox && featBox.querySelector('[data-testid=cp-chart]'); if (box && chartState) box.innerHTML = multiChart(chartState.series, { height: 260, width: 520 }); };
  if (feat.length) drawFeat();
  // Underlying price: refreshed every 15 s while the card shows it (the index has no WebSocket channel).
  const undTimer = setInterval(async () => {
    const ev = feat[idx];
    if (!ev || !ev.underlying || document.hidden || !featBox?.isConnected) return;
    try { const r = await request('GET', `/v1/bff/category/${encodeURIComponent(slug)}/underlying/${encodeURIComponent(ev.event_ticker)}`); if (feat[idx] === ev && r.underlying) { ev.underlying = r.underlying; const box = featBox.querySelector('.cp-feat-right'); if (box) box.innerHTML = underlyingHtml(r.underlying); } } catch { /* next round */ }
  }, 15000);
  cleanups.push(() => clearInterval(undTimer));

  // ---------- docked ticket (the event page's own ticket, CLONE_SPEC.md §41.4) ----------
  let dockCleanup = null; let dockSeq = 0;
  async function mountDock(eventTicker, market, side) {
    const box = $('#cp-dock');
    if (!box) return;
    const seq = ++dockSeq;
    try {
      const ev = ctx.eventView;
      if (seq !== dockSeq) return;
      if (typeof dockCleanup === 'function') dockCleanup();
      box.dataset.event = eventTicker; box.dataset.market = market || '';
      dockCleanup = await ev.render({ el: box, params: { event: eventTicker, dock: true }, query: new URLSearchParams({ ...(market ? { market } : {}), side: side || 'yes' }), navigate });
    } catch { box.innerHTML = ''; }
  }
  if (dock && dockWide()) {
    const first = feat[0] || data.events[0];
    if (first) { const m = [...first.markets].sort((a, b) => (prob(b) ?? 0) - (prob(a) ?? 0))[0]; mountDock(first.event_ticker, m && m.ticker, 'yes'); }
  }
  el.addEventListener('click', (e) => {
    const a = e.target.closest('a[href*="market="]');
    if (!a || a.closest('#cp-dock') || !dock || !dockWide() || !$('#cp-dock')) return;
    const u = new URL(a.href, location.origin);
    const evT = u.pathname.split('/').pop().toUpperCase();
    e.preventDefault(); e.stopPropagation();
    mountDock(evT, u.searchParams.get('market'), u.searchParams.get('side'));
  }, true);
  cleanups.push(() => { if (typeof dockCleanup === 'function') dockCleanup(); });

  // ---------- live prices (pills, multipliers, legend, chart end points) ----------
  const allMarkets = new Map();
  for (const ev of [...feat, ...data.events]) for (const m of ev.markets) allMarkets.set(m.ticker, m);
  let chartT = null;
  cleanups.push(socket.subscribe({ channels: ['ticker'] }, (msg) => {
    if (msg.type !== 'ticker') return;
    const x = msg.msg; const T = x.market_ticker;
    const m = allMarkets.get(T);
    if (m) Object.assign(m, { last_price_dollars: x.last_price_dollars ?? m.last_price_dollars, yes_ask_dollars: x.yes_ask_dollars ?? m.yes_ask_dollars, yes_bid_dollars: x.yes_bid_dollars ?? m.yes_bid_dollars, no_ask_dollars: x.yes_bid_dollars == null ? m.no_ask_dollars : (1 - Number(x.yes_bid_dollars)).toFixed(4) });
    if (x.last_price_dollars == null) return;
    const p = cents(x.last_price_dollars);
    const sel = CSS.escape(T);
    for (const n of el.querySelectorAll(`[data-ticker-pill="${sel}"], .outcome-row[data-ticker="${sel}"]:not([data-side]) .pill`)) n.textContent = `${p}%`;
    for (const n of el.querySelectorAll(`[data-ticker-pill-no="${sel}"]`)) n.textContent = `${100 - p}%`;
    for (const n of el.querySelectorAll(`[data-ticker-pct="${sel}"]`)) n.textContent = `${p}%`;
    for (const n of el.querySelectorAll(`[data-legend="${sel}"] b`)) n.textContent = `${p}%`;
    if (m) for (const n of el.querySelectorAll(`.cp-table .outcome-row[data-ticker="${sel}"][data-side="yes"] + .mult`)) { n.textContent = multiplier(m); n.dataset.ask = m.yes_ask_dollars ?? ''; }
    if (chartState && chartState.series.some((s) => s.ticker === T)) {
      const s = chartState.series.find((y) => y.ticker === T);
      s.points.push({ t: Math.floor(Date.now() / 1000), v: p });
      clearTimeout(chartT); chartT = setTimeout(drawChart, 500);
    }
  }));
  cleanups.push(() => clearTimeout(chartT));
  return () => { for (const c of cleanups) { try { c(); } catch { /* ignore */ } } };
}
