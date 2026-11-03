// Browse / Live / Category (+ subcategory) / Search (spec §4.5, §13.2): 24-card pages, grid|list layout,
// sort + status filters, cursor "load more". Layout and sort are persisted per user.
import { api } from '../api.js';
import { session, queries } from '../store.js';
import { esc, catFromSlug, catSlug, catLabel, CATEGORIES, ICON } from '../lib.js';
import { eventCard } from './components.js';
import { revealSportsLink } from './sports.js'; // "Live scores" link on the Sports category (CLONE_SPEC §19.6)

const ORDERS = [['trending', 'Trending'], ['event-volume', 'Volume'], ['newest', 'New'], ['closing-soon', 'Closing soon']];
const FREQS = [['', 'Frequency'], ['fifteen_min', '15 min'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['one_off', 'One-off']];
const STATUSES = [['open', 'Open'], ['unopened', 'Upcoming'], ['closed', 'Closed'], ['settled', 'Settled'], ['all', 'All']];
const PAGE = 24;

export async function render({ el, params, query, navigate }) {
  const category = params.category ? catFromSlug(params.category) : (query.get('category') || null);
  if (params.category && !category) { const e = new Error('Unknown category'); e.notFound = true; throw e; }
  const tag = params.tag || null;
  const q = query.get('q') || '';
  const live = !!params.live || query.get('live') === '1';
  const orderBy = query.get('order_by') || session.props.browse_order_by || 'trending';
  const status = query.get('status') || 'open';
  const frequency = query.get('frequency') || '';
  let layout = session.props.browse_layout || 'grid';
  const title = q ? `Results for “${q}”` : live ? 'Live' : tag || (category && catLabel(category)) || 'Browse Markets';
  document.title = `${title} · Parlance`;
  if (q) document.getElementById('search-input').value = q;

  let subs = [];
  if (category) {
    try { subs = (await queries.fetch(['categories'], api.categories, { staleTime: 300000 })).categories.find((c) => c.name === category)?.subcategories || []; } catch { /* optional */ }
  }

  el.innerHTML = `<div class="page-head pt-0"><h1 class="page-title">${esc(title)}</h1>
      <div class="toolbar m-0">
        <select class="pill-select" id="order-by" aria-label="Sort by">${ORDERS.map(([v, l]) => `<option value="${v}" ${v === orderBy ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select class="pill-select" id="frequency" aria-label="Frequency">${FREQS.map(([v, l]) => `<option value="${v}" ${v === frequency ? 'selected' : ''}>${v ? l : 'Frequency'}</option>`).join('')}</select>
        ${!category ? `<select class="pill-select" id="category" aria-label="Category"><option value="">All categories</option>${CATEGORIES.map((c) => `<option value="${esc(c)}" ${c === category ? 'selected' : ''}>${esc(catLabel(c))}</option>`).join('')}</select>` : ''}
        <select class="pill-select" id="status" aria-label="Status">${STATUSES.map(([v, l]) => `<option value="${v}" ${v === status ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <div class="seg" role="group" aria-label="Layout"><button data-layout="grid" aria-label="Grid">${ICON.grid}</button><button data-layout="list" aria-label="List">${ICON.list}</button></div>
      </div></div>
    <div class="faint m-count" id="result-count"></div>
    ${category ? `<div class="chips mb-16" data-testid="subcategories"><a class="chip ${!tag ? 'on' : ''}" href="/category/${catSlug(category)}" data-link>All ${esc(catLabel(category))}</a>${subs.map((s) => `<a class="chip ${s === tag ? 'on' : ''}" href="/category/${catSlug(category)}/${encodeURIComponent(s)}" data-link>${esc(s)}</a>`).join('')}${category === 'Sports' ? '<a class="chip sb-hub-chip" href="/sports" data-link data-testid="sports-hub-link" hidden>Live scores ›</a>' : ''}</div>` : ''}
    <div class="grid" id="results">${'<div class="skeleton"></div>'.repeat(6)}</div>
    <div class="ta-c mt-16"><button class="btn" id="more" hidden>Load more</button></div>`;

  const results = el.querySelector('#results');
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
    else results.innerHTML = html || `<div class="card empty" data-testid="empty-results">${live ? 'Nothing is live right now. Check the <a href="/calendar" data-link class="c-brand">calendar</a>.' : 'No markets match these filters.'}</div>`;
    el.querySelector('#result-count').textContent = `${live ? page.length : r.total_results_count} events`;
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
