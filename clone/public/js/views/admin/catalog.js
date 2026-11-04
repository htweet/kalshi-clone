// Catalog CMS: series / events / markets with a draft → published workflow, preview, CSV bulk import.
import { money, pxc, pxCents, priceUnit, sym, currency, toApiDollars, moneyStep, moneyCompact, fmtDt } from '../../currency.js'; // display currency (CLONE_SPEC.md §30)
import { vars } from '../../dynstyle.js';
import { esc, get, post, put, del, toast, dataTable, formHtml, wireForm, dialog, confirmAction, section, subTabs, statusBadge, badge, fmtTime, fmtQty, download, csvLine } from './ui.js';
import { eventCard } from '../components.js';
import { CATEGORIES, eventHref } from '../../lib.js';

const TABS = [['series', 'Series'], ['events', 'Events'], ['markets', 'Markets'], ['import', 'CSV import']];
const FREQ = [['one_off', 'One-off'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['annual', 'Annual'], ['fifteen_min', '15 min']];

const seriesFields = (s = {}, isNew = true) => [
  ...(isNew ? [{ name: 'ticker', label: 'Ticker', required: true, placeholder: 'PLXNEW', hint: 'A-Z, 0-9, dot, dash, underscore' }] : []),
  { name: 'title', label: 'Title', required: true, value: s.title },
  { name: 'slug', label: 'URL slug', value: s.slug, hint: 'Lowercase words and dashes; defaults from the title', required: !isNew },
  { name: 'category', label: 'Category', type: 'select', options: CATEGORIES, value: s.category || CATEGORIES[0], required: true },
  { name: 'tags', label: 'Tags (comma separated)', value: (s.tags || []).join(', ') },
  { name: 'frequency', label: 'Frequency', type: 'select', options: FREQ, value: s.frequency || 'one_off' },
  { name: 'fee_type', label: 'Fee type', type: 'select', options: ['quadratic', 'flat', 'none'], value: s.fee_type || 'quadratic' },
  { name: 'fee_multiplier', label: 'Fee multiplier', type: 'number', step: '0.01', value: s.fee_multiplier ?? 1 },
  { name: 'settlement_sources', label: 'Settlement sources (one per line: name | https://url)', type: 'textarea', rows: 2, value: (s.settlement_sources || []).map((x) => `${x.name}${x.url ? ` | ${x.url}` : ''}`).join('\n'), span: true },
  { name: 'rules', label: 'Rules', type: 'textarea', value: s.rules, span: true },
];
const eventFields = (e = {}, isNew = true, series = []) => [
  ...(isNew ? [{ name: 'ticker', label: 'Ticker', required: true, placeholder: 'PLXNEW-27Q1' }] : []),
  ...(isNew || e.state === 'draft' ? [{ name: 'series_ticker', label: 'Series', type: 'select', required: true, value: e.series_ticker, options: series.map((s) => [s.ticker, `${s.ticker} — ${s.title}${s.state === 'draft' ? ' (draft)' : ''}`]) }] : []),
  { name: 'title', label: 'Title', required: true, value: e.title, span: true },
  { name: 'sub_title', label: 'Subtitle', value: e.sub_title },
  { name: 'category', label: 'Category', type: 'select', options: CATEGORIES, value: e.category || CATEGORIES[0] },
  { name: 'live_label', label: 'Live label', value: e.live_label, placeholder: '2nd half · 61’' },
  { name: 'icon_color', label: 'Icon colour', type: 'color', value: e.icon_color || '' },
  { name: 'news', label: 'News / update text', type: 'textarea', rows: 2, value: e.news, span: true },
  { name: 'mutually_exclusive', label: 'Mutually exclusive outcomes', type: 'checkbox', value: e.mutually_exclusive },
  { name: 'is_live', label: 'Live now', type: 'checkbox', value: e.is_live },
  { name: 'featured', label: 'Featured (home hero default)', type: 'checkbox', value: e.featured },
];
const marketFields = (m = {}, isNew = true, events = []) => {
  const now = Date.now();
  const pub = m.state === 'published';
  return [
    ...(isNew ? [{ name: 'ticker', label: 'Ticker', required: true, placeholder: 'PLXNEW-27Q1-YES' }] : []),
    ...(isNew || m.state === 'draft' ? [{ name: 'event_ticker', label: 'Event', type: 'select', required: true, value: m.event_ticker, options: events.map((e) => [e.ticker, `${e.ticker} — ${e.title}${e.state === 'draft' ? ' (draft)' : ''}`]) }] : []),
    { name: 'yes_sub_title', label: 'YES outcome label', required: true, value: m.yes_sub_title },
    { name: 'no_sub_title', label: 'NO outcome label', value: m.no_sub_title, placeholder: 'Not …' },
    { name: 'title', label: 'Market title (defaults from event)', value: m.title, span: true },
    { name: 'color', label: 'Colour', type: 'color', value: m.color || '#5b5bd6' },
    { name: 'settlement_timer_seconds', label: 'Settlement timer (s)', type: 'number', value: m.settlement_timer_seconds ?? 300, hint: 'Review window between result and payout' },
    ...(!pub || m.status === 'initialized' ? [{ name: 'open_time', label: 'Opens', type: 'datetime', value: m.open_time || new Date(now).toISOString() }] : []),
    ...(!pub || ['initialized', 'active', 'inactive'].includes(m.status) ? [
      { name: 'close_time', label: 'Closes', type: 'datetime', required: true, value: m.close_time || new Date(now + 30 * 86400000).toISOString() },
      { name: 'expected_expiration_time', label: 'Expected expiration', type: 'datetime', value: m.expected_expiration_time }] : []),
    ...(!pub ? [{ name: 'initial_price', label: `Starting price (${priceUnit()})`, type: 'number', value: m.initial_price ?? 50 },
      { name: 'fractional', label: 'Fractional contracts', type: 'checkbox', value: m.fractional ?? true },
      { name: 'seed_liquidity', label: 'Seed starting liquidity on publish', type: 'checkbox', value: m.seed_liquidity ?? true }] : []),
    { name: 'rules_primary', label: 'Rules', type: 'textarea', value: m.rules_primary, span: true },
  ];
};

function openForm({ title, fields, submit, onSubmit, testid }) {
  const d = dialog(`<h3>${esc(title)}</h3>${formHtml(fields, { submit, id: 'cat', extra: '<button class="btn" type="button" data-close>Cancel</button>', testid })}`, { wide: true });
  d.querySelector('[data-close]').onclick = () => d.close();
  wireForm(d.querySelector('form'), fields, async (v) => { await onSubmit(v); d.close(); });
  return d;
}
const actions = (row, kind) => `<span class="adm-actions">
  <button class="btn btn-sm" data-edit="${esc(row.ticker)}" data-kind="${esc(kind)}">Edit</button>
  ${kind === 'events' ? `<a class="btn btn-sm" href="/admin/preview/${encodeURIComponent(row.ticker)}" data-link data-preview="${esc(row.ticker)}">Preview</a>` : ''}
  ${kind === 'events' ? `<button class="btn btn-sm" data-add-market="${esc(row.ticker)}">+ Market</button>` : ''}
  ${row.state === 'draft' ? `<button class="btn btn-sm btn-primary" data-publish="${esc(row.ticker)}" data-kind="${esc(kind)}">Publish</button><button class="btn btn-sm btn-ghost btn-danger" data-discard="${esc(row.ticker)}" data-kind="${esc(kind)}">Discard</button>` : ''}
</span>`;

export async function render({ el, parts, perms, navigate }) {
  if (parts[0] === 'preview') return renderPreview(el, parts[1]);
  const tab = TABS.some(([k]) => k === parts[0]) ? parts[0] : 'series';
  const canWrite = perms.has('catalog.write');
  el.innerHTML = section('Catalog', 'Create series, events and markets as drafts, preview them, then publish. Drafts never appear in public APIs, search or the home page.',
    canWrite && tab !== 'import' ? `<button class="btn btn-primary" data-new data-testid="catalog-new">New ${tab === 'series' ? 'series' : tab === 'events' ? 'event' : 'market'}</button>` : '') + subTabs(TABS, tab, '/admin/catalog') + '<div class="adm-search-row"><input type="search" class="adm-input" placeholder="Search by ticker or title" data-q aria-label="Search catalog"></div><div id="cat-body"></div>';
  const body = el.querySelector('#cat-body');
  if (tab === 'import') { el.querySelector('.adm-search-row').remove(); return renderImport(body, canWrite); }
  let data = { series: [], events: [], markets: [] };
  async function load(q = '') {
    const qs = q ? `?q=${encodeURIComponent(q)}` : '';
    if (tab === 'series') data.series = (await get(`/catalog/series${qs}`)).series;
    if (tab === 'events') { data.events = (await get(`/catalog/events${qs}`)).events; }
    if (tab === 'markets') data.markets = (await get(`/catalog/markets${qs}`)).markets;
  }
  let table;
  const cols = {
    series: [
      { key: 'state', label: 'State', render: (r) => statusBadge(r.state) }, { key: 'ticker', label: 'Ticker', render: (r) => `<code>${esc(r.ticker)}</code>` }, { key: 'title', label: 'Title' },
      { key: 'category', label: 'Category' }, { key: 'frequency', label: 'Frequency' }, { key: 'fee_multiplier', label: 'Fee ×', num: true }, { key: 'events', label: 'Events', num: true },
      ...(canWrite ? [{ key: '_a', label: '', sort: false, render: (r) => actions(r, 'series') }] : [])],
    events: [
      { key: 'state', label: 'State', render: (r) => statusBadge(r.state) }, { key: 'ticker', label: 'Ticker', render: (r) => `<code>${esc(r.ticker)}</code>` },
      { key: 'title', label: 'Title', render: (r) => `${r.icon_color ? `<i class="adm-swatch v-bg"${vars({ '--bg': r.icon_color })}></i>` : ''}${esc(r.title)}${r.featured ? ' ' + badge('featured', 'brand') : ''}${r.is_live ? ' ' + badge('live', 'bad') : ''}` },
      { key: 'series_ticker', label: 'Series' }, { key: 'category', label: 'Category' }, { key: 'markets', label: 'Markets', num: true },
      ...(canWrite ? [{ key: '_a', label: '', sort: false, render: (r) => actions(r, 'events') }] : [{ key: '_p', label: '', sort: false, render: (r) => `<a class="btn btn-sm" href="/admin/preview/${encodeURIComponent(r.ticker)}" data-link>Preview</a>` }])],
    markets: [
      { key: 'state', label: 'State', render: (r) => statusBadge(r.state === 'draft' ? 'draft' : r.status) }, { key: 'ticker', label: 'Ticker', render: (r) => `<code>${esc(r.ticker)}</code>` },
      { key: 'yes_sub_title', label: 'Outcome', render: (r) => `<i class="adm-swatch v-bg"${vars({ '--bg': r.color })}></i>${esc(r.yes_sub_title)}` }, { key: 'event_ticker', label: 'Event' },
      { key: 'close_time', label: 'Closes', render: (r) => esc(fmtTime(r.close_time)) }, { key: 'volume_fp', label: 'Volume', num: true, render: (r) => (r.volume_fp == null ? '—' : fmtQty(r.volume_fp)) },
      ...(canWrite ? [{ key: '_a', label: '', sort: false, render: (r) => actions(r, 'markets') }] : [])],
  };
  async function refresh(q) { await load(q); table.setRows(data[tab]); }
  table = dataTable(body, { cols: cols[tab], rows: [], search: false, testid: `catalog-${tab}`, rowAttrs: (r) => `data-row="${esc(r.ticker)}" data-state="${esc(r.state)}"` });
  await refresh('');
  let t = null;
  el.querySelector('[data-q]').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => refresh(e.target.value.trim()).catch((ex) => toast(ex.message, 'error')), 200); });

  const seriesList = async () => (await get('/catalog/series')).series;
  const eventList = async () => (await get('/catalog/events')).events;
  async function openMarket(preset = {}, existing = null) {
    const evs = existing && existing.state === 'published' ? [] : await eventList();
    const f = marketFields(existing || { ...preset }, !existing, evs);
    openForm({ title: existing ? `Edit market ${existing.ticker}` : 'New market (draft)', fields: f, submit: existing ? 'Save' : 'Create draft', testid: 'market-form',
      onSubmit: async (v) => { if (existing) await put(`/catalog/markets/${encodeURIComponent(existing.ticker)}`, v); else await post('/catalog/markets', v); toast(existing ? 'Market saved' : 'Draft market created'); await refresh(el.querySelector('[data-q]')?.value.trim() || ''); } });
  }
  el.querySelector('[data-new]')?.addEventListener('click', async () => {
    if (tab === 'series') openForm({ title: 'New series (draft)', fields: seriesFields({}, true), submit: 'Create draft', testid: 'series-form', onSubmit: async (v) => { await post('/catalog/series', v); toast('Draft series created'); await refresh(''); } });
    if (tab === 'events') { const s = await seriesList(); openForm({ title: 'New event (draft)', fields: eventFields({}, true, s), submit: 'Create draft', testid: 'event-form', onSubmit: async (v) => { await post('/catalog/events', v); toast('Draft event created'); await refresh(''); } }); }
    if (tab === 'markets') openMarket();
  });
  body.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const q = () => el.querySelector('[data-q]')?.value.trim() || '';
    try {
      if (b.dataset.edit) {
        const row = data[tab].find((r) => r.ticker === b.dataset.edit);
        if (tab === 'series') openForm({ title: `Edit series ${row.ticker}`, fields: seriesFields(row, false), submit: 'Save', testid: 'series-form', onSubmit: async (v) => { await put(`/catalog/series/${encodeURIComponent(row.ticker)}`, v); toast('Series saved'); await refresh(q()); } });
        if (tab === 'events') { const s = row.state === 'draft' ? await seriesList() : []; openForm({ title: `Edit event ${row.ticker}`, fields: eventFields(row, false, s), submit: 'Save', testid: 'event-form', onSubmit: async (v) => { await put(`/catalog/events/${encodeURIComponent(row.ticker)}`, v); toast('Event saved'); await refresh(q()); } }); }
        if (tab === 'markets') openMarket({}, row);
      } else if (b.dataset.addMarket) {
        openMarket({ event_ticker: b.dataset.addMarket });
      } else if (b.dataset.publish) {
        const ok = await confirmAction({ title: `Publish ${b.dataset.publish}?`, body: tab === 'events' ? 'The event, its draft series (if any) and all of its draft markets go live. Markets whose open time has passed start trading immediately.' : 'This goes live on the public site and APIs.', confirm: 'Publish' });
        if (!ok) return;
        const r = await post(`/catalog/${tab}/${encodeURIComponent(b.dataset.publish)}/publish`);
        toast(`Published ${r.published.map((p) => p.ticker).join(', ')}`);
        await refresh(q());
      } else if (b.dataset.discard) {
        const ok = await confirmAction({ title: `Discard draft ${b.dataset.discard}?`, body: 'The draft is deleted. This cannot be undone.', confirm: 'Discard', danger: true });
        if (!ok) return;
        await del(`/catalog/${tab}/${encodeURIComponent(b.dataset.discard)}`);
        toast('Draft discarded'); await refresh(q());
      }
    } catch (ex) { toast(ex.message, 'error'); }
  });
  void navigate;
}

async function renderPreview(el, ticker) {
  const r = await get(`/catalog/preview/${encodeURIComponent(ticker)}`);
  const ev = r.event;
  el.innerHTML = section(`Preview: ${ev.title}`, r.state === 'draft' ? 'Draft — not visible to the public. This is how the card will look once published.' : 'Published event.',
    `<a class="btn" href="/admin/catalog/events" data-link>Back to events</a>${r.state === 'published' ? ` <a class="btn btn-primary" href="${esc(eventHref(ev))}" data-link>Open public page</a>` : ''}`) +
    `<div class="adm-preview" data-testid="catalog-preview" data-state="${esc(r.state)}">${r.state === 'draft' ? '<div class="adm-banner warn">DRAFT PREVIEW</div>' : ''}<div class="adm-preview-card">${eventCard(ev)}</div>
    <div class="card adm-card"><h3>Markets</h3><table class="table"><thead><tr><th>Outcome</th><th>Opens</th><th>Closes</th><th>Rules</th></tr></thead><tbody>${ev.markets.map((m) => `<tr><td><i class="adm-swatch v-bg"${vars({ '--bg': m.color_code })}></i>${esc(m.yes_sub_title)}</td><td>${esc(fmtTime(m.open_time))}</td><td>${esc(fmtTime(m.close_time))}</td><td class="muted">${esc(m.rules_primary)}</td></tr>`).join('') || '<tr><td colspan="4" class="faint">No markets yet — add one before publishing.</td></tr>'}</tbody></table>
    ${ev.news ? `<p><b>News:</b> ${esc(ev.news)}</p>` : ''}</div></div>`;
}

function renderImport(body, canWrite) {
  body.innerHTML = `<div class="card adm-card" data-testid="catalog-import">
    <p class="muted">Upload a CSV of markets. Each valid row becomes a <b>draft</b> market under an existing (draft or published) event; invalid rows are reported and skipped.
    Required columns: <code>event_ticker</code>, <code>market_ticker</code>, <code>yes_sub_title</code>, <code>close_time</code>.</p>
    <p><a class="btn btn-sm" href="/v1/admin/catalog/import/template.csv" download data-testid="import-template">Download template</a></p>
    ${canWrite ? `<label class="field"><span>CSV file</span><input type="file" accept=".csv,text/csv" data-file></label>
    <label class="field"><span>…or paste CSV</span><textarea rows="8" data-csv data-testid="import-csv" spellcheck="false"></textarea></label>
    <div class="adm-form-actions"><button class="btn btn-primary" data-run data-testid="import-run">Import as drafts</button></div>` : '<p class="faint">Your role can view but not import.</p>'}
    <div data-result></div></div>`;
  const ta = body.querySelector('[data-csv]');
  body.querySelector('[data-file]')?.addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) ta.value = await f.text(); });
  body.querySelector('[data-run]')?.addEventListener('click', async () => {
    const out = body.querySelector('[data-result]');
    try {
      const r = await post('/catalog/import', { csv: ta.value });
      out.innerHTML = `<div class="adm-import-result" data-testid="import-result"><p><b data-testid="import-created">${r.created.length}</b> draft market(s) created from ${esc(r.rows)} row(s); <b data-testid="import-errors">${r.errors.length}</b> row(s) rejected.</p>
        ${r.created.length ? `<p class="faint">Created: ${r.created.map((t) => `<code>${esc(t)}</code>`).join(' ')}</p>` : ''}
        ${r.errors.length ? `<table class="table" data-testid="import-error-table"><thead><tr><th class="num">Row</th><th>Market ticker</th><th>Problems</th></tr></thead><tbody>${r.errors.map((x) => `<tr><td class="num">${esc(x.row)}</td><td><code>${esc(x.market_ticker)}</code></td><td>${x.errors.map(esc).join('<br>')}</td></tr>`).join('')}</tbody></table>
        <button class="btn btn-sm" data-errcsv data-testid="import-error-csv">Download error report</button>` : ''}</div>`;
      out.querySelector('[data-errcsv]')?.addEventListener('click', () => download('import-errors.csv', [csvLine(['row', 'market_ticker', 'errors']), ...r.errors.map((x) => csvLine([x.row, x.market_ticker, x.errors.join('; ')]))].join('\n') + '\n'));
      toast(`${r.created.length} created, ${r.errors.length} rejected`);
    } catch (ex) { out.innerHTML = `<p class="adm-err" role="alert">${esc(ex.message)}${ex.fields ? ': ' + esc(Object.values(ex.fields).join('; ')) : ''}</p>`; }
  });
}
