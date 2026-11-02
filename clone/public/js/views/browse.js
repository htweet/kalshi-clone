// Browse / Category / Search (spec §4.5).
import { api } from '../api.js';
import { session } from '../store.js';
import { esc, catFromSlug, CATEGORIES } from '../lib.js';
import { eventCard } from './components.js';

const ORDERS = [['event-volume', 'Most traded'], ['trending', 'Biggest movers'], ['closing-soon', 'Closing soon'], ['newest', 'Newest']];
const STATUSES = [['open', 'Open'], ['unopened', 'Upcoming'], ['closed', 'Closed'], ['settled', 'Settled'], ['all', 'All']];

export async function render({ el, params, query, navigate }) {
  const category = params.category ? catFromSlug(params.category) : (query.get('category') || null);
  if (params.category && !category) { const e = new Error('Unknown category'); e.notFound = true; throw e; }
  const q = query.get('q') || '';
  const live = query.get('live') === '1';
  const orderBy = query.get('order_by') || session.props.browse_order_by || 'event-volume';
  const status = query.get('status') || 'open';
  const title = q ? `Results for “${q}”` : live ? 'Live now' : category || 'All markets';
  document.title = `${title} · Parlance`;
  if (q) document.getElementById('search-input').value = q;

  el.innerHTML = `<h1 class="section-title" style="margin-top:0">${esc(title)}</h1>
    <div class="toolbar">
      <label class="faint">Sort <select id="order-by" aria-label="Sort by">${ORDERS.map(([v, l]) => `<option value="${v}" ${v === orderBy ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="faint">Status <select id="status" aria-label="Status">${STATUSES.map(([v, l]) => `<option value="${v}" ${v === status ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${!params.category ? `<label class="faint">Category <select id="category" aria-label="Category"><option value="">All</option>${CATEGORIES.map((c) => `<option ${c === category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>` : ''}
      <span class="faint" id="result-count"></span>
    </div>
    <div class="cards" id="results"></div>
    <div style="text-align:center;margin-top:16px"><button class="btn" id="more" hidden>Load more</button></div>`;

  const results = el.querySelector('#results');
  let cursor = '';
  async function load(append) {
    const r = await api.search({ query: q, category, order_by: orderBy, status, cursor: append ? cursor : '', page_size: 12 });
    let page = r.current_page;
    if (live) page = page.filter((e) => e.is_live);
    cursor = r.next_cursor;
    const html = page.map(eventCard).join('');
    results.innerHTML = append ? results.innerHTML + html : (html || '<div class="card empty" data-testid="empty-results">No markets match these filters.</div>');
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
  const cs = el.querySelector('#category');
  if (cs) cs.onchange = (e) => go({ category: e.target.value });
  el.querySelector('#more').onclick = () => load(true);
}
