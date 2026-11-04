// Browse / Live / Category (+ subcategory) / Search (spec §4.5, §13.2): 24-card pages, grid|list layout,
// sort + status filters, cursor "load more". Layout and sort are persisted per user.
import { t, te, ts } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/browse-strings.js';
import { api } from '../api.js';
import { session, queries } from '../store.js';
import { esc, catFromSlug, catSlug, catLabel, CATEGORIES, ICON } from '../lib.js';
import { eventCard } from './components.js';
import { revealSportsLink } from './sports.js'; // "Live scores" link on the Sports category (CLONE_SPEC §19.6)

const ORDERS = [['trending', ts('browse.orders.trending')], ['event-volume', ts('browse.orders.volume')], ['newest', ts('browse.orders.new')], ['closing-soon', ts('browse.orders.closing_soon')]];
const FREQS = [['', ts('browse.freqs.frequency')], ['fifteen_min', '15 min'], ['daily', ts('browse.freqs.daily')], ['weekly', ts('browse.freqs.weekly')], ['monthly', ts('browse.freqs.monthly')], ['one_off', ts('browse.freqs.one_off')]];
const STATUSES = [['open', ts('browse.statuses.open')], ['unopened', ts('browse.statuses.upcoming')], ['closed', 'Closed'], ['settled', 'Settled'], ['all', ts('browse.statuses.all')]];
const PAGE = 24;

export async function render({ el, params, query, navigate }) {
  const category = params.category ? catFromSlug(params.category) : (query.get('category') || null);
  if (params.category && !category) { const e = new Error(t('browse.render.unknown_category')); e.notFound = true; throw e; }
  const tag = params.tag || null;
  const q = query.get('q') || '';
  const live = !!params.live || query.get('live') === '1';
  const orderBy = query.get('order_by') || session.props.browse_order_by || 'trending';
  const status = query.get('status') || 'open';
  const frequency = query.get('frequency') || '';
  let layout = session.props.browse_layout || 'grid';
  const title = q ? t('browse.render.results_for', { q }) : live ? 'Live' : tag || (category && catLabel(category)) || t('browse.render.browse_markets');
  document.title = t('browse.render.parlance', { title });
  if (q) document.getElementById('search-input').value = q;

  let subs = [];
  if (category) {
    try { subs = (await queries.fetch(['categories'], api.categories, { staleTime: 300000 })).categories.find((c) => c.name === category)?.subcategories || []; } catch { /* optional */ }
  }

  el.innerHTML = `<div class="page-head pt-0"><h1 class="page-title">${esc(title)}</h1>
      <div class="toolbar m-0">
        <select class="pill-select" id="order-by" aria-label="${te('browse.render.sort_by')}">${ORDERS.map(([v, l]) => `<option value="${esc(v)}" ${v === orderBy ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        <select class="pill-select" id="frequency" aria-label="${te('browse.render.frequency')}">${FREQS.map(([v, l]) => `<option value="${esc(v)}" ${v === frequency ? 'selected' : ''}>${v ? esc(l) : te('browse.render.frequency')}</option>`).join('')}</select>
        ${!category ? `<select class="pill-select" id="category" aria-label="${te('browse.render.category')}"><option value="">${te('browse.render.all_categories')}</option>${CATEGORIES.map((c) => `<option value="${esc(c)}" ${c === category ? 'selected' : ''}>${esc(catLabel(c))}</option>`).join('')}</select>` : ''}
        <select class="pill-select" id="status" aria-label="${te('browse.render.status')}">${STATUSES.map(([v, l]) => `<option value="${esc(v)}" ${v === status ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        <div class="seg" role="group" aria-label="${te('browse.render.layout')}"><button data-layout="grid" aria-label="${te('browse.render.grid')}">${ICON.grid}</button><button data-layout="list" aria-label="${te('browse.render.list')}">${ICON.list}</button></div>
      </div></div>
    ${category ? '<div class="targeted-promos" data-testid="category-promos"></div>' : ''}<div class="faint m-count" id="result-count"></div>
    ${category ? `<div class="chips mb-16" data-testid="subcategories"><a class="chip ${!tag ? 'on' : ''}" href="/category/${catSlug(category)}" data-link>${te('browse.render.all', { cat_label: esc(catLabel(category)) })}</a>${subs.map((s) => `<a class="chip ${s === tag ? 'on' : ''}" href="/category/${catSlug(category)}/${encodeURIComponent(s)}" data-link>${esc(s)}</a>`).join('')}${category === 'Sports' ? `<a class="chip sb-hub-chip" href="/sports" data-link data-testid="sports-hub-link" hidden>${te('browse.render.live_scores')}</a>` : ''}</div>` : ''}
    <div class="grid" id="results">${'<div class="skeleton"></div>'.repeat(6)}</div>
    <div class="ta-c mt-16"><button class="btn" id="more" hidden>${te('browse.render.load_more')}</button></div>`;

  const results = el.querySelector('#results');
  if (category) import('./social2.js').then((m) => m.renderPromos(el.querySelector('[data-testid=category-promos]'), { category })).catch(() => {}); // targeted promos (G8)
  revealSportsLink(el);
  const drawLayout = () => {
    results.classList.toggle('list', layout === 'list');
    for (const b of el.querySelectorAll('[data-layout]')) b.classList.toggle('on', b.dataset.layout === layout);
  };
  drawLayout();
  let cursor = '';
  async function load(append) {
    const r = await api.search({ query: q, category, tag, frequency, order_by: orderBy, status, cursor: append ? cursor : '', page_size: PAGE });
    let page = r.current_page;
    if (live) page = page.filter((e) => e.is_live);
    cursor = r.next_cursor;
    const html = page.map(eventCard).join('');
    if (append) results.insertAdjacentHTML('beforeend', html);
    else results.innerHTML = html || `<div class="card empty" data-testid="empty-results">${live ? `${te('browse.render.nothing_is_live_right_now')} <a href="/calendar" data-link class="c-brand">${te('browse.render.calendar')}</a>.` : te('browse.render.no_markets_match_these_filters')}</div>`;
    el.querySelector('#result-count').textContent = t('browse.render.events', { value: live ? page.length : r.total_results_count });
    el.querySelector('#more').hidden = !cursor || live;
  }
  await load(false);

  const go = (patch) => {
    const u = new URL(location.href);
    for (const [k, v] of Object.entries(patch)) { if (v) u.searchParams.set(k, v); else u.searchParams.delete(k); }
    navigate(u.pathname + u.search, { replace: true });
  };
  el.querySelector('#order-by').onchange = async (e) => {
    if (session.user) await session.setProp('browse_order_by', e.target.value);
    go({ order_by: e.target.value });
  };
  el.querySelector('#status').onchange = (e) => go({ status: e.target.value });
  el.querySelector('#frequency').onchange = (e) => go({ frequency: e.target.value });
  const cs = el.querySelector('#category');
  if (cs) cs.onchange = (e) => go({ category: e.target.value });
  el.querySelector('#more').onclick = () => load(true);
  for (const b of el.querySelectorAll('[data-layout]')) {
    b.onclick = () => { layout = b.dataset.layout; drawLayout(); if (session.user) session.setProp('browse_layout', layout).catch(() => {}); };
  }
}
