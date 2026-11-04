// Catalog CMS: series / events / markets with a draft → published workflow, preview, CSV bulk import.
import { t as tx, te, ts } from '../../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../../content/admin.catalog-strings.js';
import { t as T } from '../../content/currency-strings.js'; // keyed wording (CLONE_SPEC.md §30)
import { priceUnit } from '../../currency.js'; // display currency (CLONE_SPEC.md §30)
import { vars } from '../../dynstyle.js';
import { esc, get, post, put, del, toast, dataTable, formHtml, wireForm, dialog, confirmAction, section, subTabs, statusBadge, badge, fmtTime, fmtQty, download, csvLine } from './ui.js';
import { eventCard } from '../components.js';
import { CATEGORIES, eventHref } from '../../lib.js';

const TABS = [['series', ts('admin.catalog.tabs.series')], ['events', ts('admin.catalog.tabs.events')], ['markets', ts('admin.catalog.tabs.markets')], ['import', ts('admin.catalog.tabs.csv_import')]];
const FREQ = [['one_off', ts('admin.catalog.freq.one_off')], ['daily', ts('admin.catalog.freq.daily')], ['weekly', ts('admin.catalog.freq.weekly')], ['monthly', ts('admin.catalog.freq.monthly')], ['annual', ts('admin.catalog.freq.annual')], ['fifteen_min', '15 min']];

const seriesFields = (s = {}, isNew = true) => [
  ...(isNew ? [{ name: 'ticker', label: tx('admin.catalog.series_fields.ticker'), required: true, placeholder: 'PLXNEW', hint: tx('admin.catalog.series_fields.a_z_0_9_dot') }] : []),
  { name: 'title', label: tx('admin.catalog.series_fields.title'), required: true, value: s.title },
  { name: 'slug', label: tx('admin.catalog.series_fields.url_slug'), value: s.slug, hint: tx('admin.catalog.series_fields.lowercase_words_and_dashes_defaults'), required: !isNew },
  { name: 'category', label: tx('admin.catalog.series_fields.category'), type: 'select', options: CATEGORIES, value: s.category || CATEGORIES[0], required: true },
  { name: 'tags', label: tx('admin.catalog.series_fields.tags_comma_separated'), value: (s.tags || []).join(', ') },
  { name: 'frequency', label: tx('admin.catalog.series_fields.frequency'), type: 'select', options: FREQ, value: s.frequency || 'one_off' },
  { name: 'fee_type', label: tx('admin.catalog.series_fields.fee_type'), type: 'select', options: ['quadratic', 'flat', 'none'], value: s.fee_type || 'quadratic' },
  { name: 'fee_multiplier', label: tx('admin.catalog.series_fields.fee_multiplier'), type: 'number', step: '0.01', value: s.fee_multiplier ?? 1 },
  { name: 'settlement_sources', label: tx('admin.catalog.series_fields.settlement_sources_one_per_line'), type: 'textarea', rows: 2, value: (s.settlement_sources || []).map((x) => `${x.name}${x.url ? ` | ${x.url}` : ''}`).join('\n'), span: true },
  { name: 'rules', label: tx('admin.catalog.series_fields.rules'), type: 'textarea', value: s.rules, span: true },
];
const eventFields = (e = {}, isNew = true, series = []) => [
  ...(isNew ? [{ name: 'ticker', label: tx('admin.catalog.event_fields.ticker'), required: true, placeholder: 'PLXNEW-27Q1' }] : []),
  ...(isNew || e.state === 'draft' ? [{ name: 'series_ticker', label: tx('admin.catalog.event_fields.series'), type: 'select', required: true, value: e.series_ticker, options: series.map((s) => [s.ticker, `${s.ticker} — ${s.title}${s.state === 'draft' ? ' (draft)' : ''}`]) }] : []),
  { name: 'title', label: tx('admin.catalog.event_fields.title'), required: true, value: e.title, span: true },
  { name: 'sub_title', label: tx('admin.catalog.event_fields.subtitle'), value: e.sub_title },
  { name: 'category', label: tx('admin.catalog.event_fields.category'), type: 'select', options: CATEGORIES, value: e.category || CATEGORIES[0] },
  { name: 'live_label', label: tx('admin.catalog.event_fields.live_label'), value: e.live_label, placeholder: '2nd half · 61’' },
  { name: 'icon_color', label: tx('admin.catalog.event_fields.icon_colour'), type: 'color', value: e.icon_color || '' },
  { name: 'news', label: tx('admin.catalog.event_fields.news_update_text'), type: 'textarea', rows: 2, value: e.news, span: true },
  { name: 'mutually_exclusive', label: tx('admin.catalog.event_fields.mutually_exclusive_outcomes'), type: 'checkbox', value: e.mutually_exclusive },
  { name: 'is_live', label: tx('admin.catalog.event_fields.live_now'), type: 'checkbox', value: e.is_live },
  { name: 'featured', label: tx('admin.catalog.event_fields.featured_home_hero_default'), type: 'checkbox', value: e.featured },
];
const marketFields = (m = {}, isNew = true, events = []) => {
  const now = Date.now();
  const pub = m.state === 'published';
  return [
    ...(isNew ? [{ name: 'ticker', label: tx('admin.catalog.market_fields.ticker'), required: true, placeholder: 'PLXNEW-27Q1-YES' }] : []),
    ...(isNew || m.state === 'draft' ? [{ name: 'event_ticker', label: tx('admin.catalog.market_fields.event'), type: 'select', required: true, value: m.event_ticker, options: events.map((e) => [e.ticker, `${e.ticker} — ${e.title}${e.state === 'draft' ? ' (draft)' : ''}`]) }] : []),
    { name: 'yes_sub_title', label: tx('admin.catalog.market_fields.yes_outcome_label'), required: true, value: m.yes_sub_title },
    { name: 'no_sub_title', label: tx('admin.catalog.market_fields.no_outcome_label'), value: m.no_sub_title, placeholder: tx('admin.catalog.market_fields.not') },
    { name: 'title', label: tx('admin.catalog.market_fields.market_title_defaults_from_event'), value: m.title, span: true },
    { name: 'color', label: tx('admin.catalog.market_fields.colour'), type: 'color', value: m.color || '#5b5bd6' },
    { name: 'settlement_timer_seconds', label: tx('admin.catalog.market_fields.settlement_timer_s'), type: 'number', value: m.settlement_timer_seconds ?? 300, hint: tx('admin.catalog.market_fields.review_window_between_result_and') },
    ...(!pub || m.status === 'initialized' ? [{ name: 'open_time', label: tx('admin.catalog.market_fields.opens'), type: 'datetime', value: m.open_time || new Date(now).toISOString() }] : []),
    ...(!pub || ['initialized', 'active', 'inactive'].includes(m.status) ? [
      { name: 'close_time', label: tx('admin.catalog.market_fields.closes'), type: 'datetime', required: true, value: m.close_time || new Date(now + 30 * 86400000).toISOString() },
      { name: 'expected_expiration_time', label: tx('admin.catalog.market_fields.expected_expiration'), type: 'datetime', value: m.expected_expiration_time }] : []),
    ...(!pub ? [{ name: 'initial_price', label: T('admin.starting_price', { unit: priceUnit() }), type: 'number', value: m.initial_price ?? 50 },
      { name: 'fractional', label: tx('admin.catalog.market_fields.fractional_contracts'), type: 'checkbox', value: m.fractional ?? true },
      { name: 'seed_liquidity', label: tx('admin.catalog.market_fields.seed_starting_liquidity_on_publish'), type: 'checkbox', value: m.seed_liquidity ?? true }] : []),
    { name: 'rules_primary', label: tx('admin.catalog.market_fields.rules'), type: 'textarea', value: m.rules_primary, span: true },
  ];
};

function openForm({ title, fields, submit, onSubmit, testid }) {
  const d = dialog(`<h3>${esc(title)}</h3>${formHtml(fields, { submit, id: 'cat', extra: `<button class="btn" type="button" data-close>${te('admin.catalog.open_form.cancel')}</button>`, testid })}`, { wide: true });
  d.querySelector('[data-close]').onclick = () => d.close();
  wireForm(d.querySelector('form'), fields, async (v) => { await onSubmit(v); d.close(); });
  return d;
}
const actions = (row, kind) => `<span class="adm-actions">
  <button class="btn btn-sm" data-edit="${esc(row.ticker)}" data-kind="${esc(kind)}">${te('admin.catalog.actions.edit')}</button>
  ${kind === 'events' ? `<a class="btn btn-sm" href="/admin/preview/${encodeURIComponent(row.ticker)}" data-link data-preview="${esc(row.ticker)}">${te('admin.catalog.actions.preview')}</a>` : ''}
  ${kind === 'events' ? `<button class="btn btn-sm" data-add-market="${esc(row.ticker)}">${te('admin.catalog.actions.market')}</button>` : ''}
  ${row.state === 'draft' ? `<button class="btn btn-sm btn-primary" data-publish="${esc(row.ticker)}" data-kind="${esc(kind)}">${te('admin.catalog.actions.publish')}</button><button class="btn btn-sm btn-ghost btn-danger" data-discard="${esc(row.ticker)}" data-kind="${esc(kind)}">${te('admin.catalog.actions.discard')}</button>` : ''}
</span>`;

export async function render({ el, parts, perms, navigate }) {
  if (parts[0] === 'preview') return renderPreview(el, parts[1]);
  const tab = TABS.some(([k]) => k === parts[0]) ? parts[0] : 'series';
  const canWrite = perms.has('catalog.write');
  el.innerHTML = section(tx('admin.catalog.render.catalog'), tx('admin.catalog.render.create_series_events_and_markets'),
    canWrite && tab !== 'import' ? `<button class="btn btn-primary" data-new data-testid="catalog-new">${te('admin.catalog.render.new', { value: tab === 'series' ? te('admin.catalog.render.series') : tab === 'events' ? te('admin.catalog.render.event') : te('admin.catalog.render.market') })}</button>` : '') + subTabs(TABS, tab, '/admin/catalog') + `<div class="adm-search-row"><input type="search" class="adm-input" placeholder="${te('admin.catalog.render.search_by_ticker_or_title')}" data-q aria-label="${te('admin.catalog.render.search_catalog')}"></div><div id="cat-body"></div>`;
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
      { key: 'state', label: 'State', render: (r) => statusBadge(r.state) }, { key: 'ticker', label: tx('admin.catalog.render.ticker'), render: (r) => `<code>${esc(r.ticker)}</code>` }, { key: 'title', label: tx('admin.catalog.render.title') },
      { key: 'category', label: tx('admin.catalog.render.category') }, { key: 'frequency', label: tx('admin.catalog.render.frequency') }, { key: 'fee_multiplier', label: tx('admin.catalog.render.fee'), num: true }, { key: 'events', label: tx('admin.catalog.render.events'), num: true },
      ...(canWrite ? [{ key: '_a', label: '', sort: false, render: (r) => actions(r, 'series') }] : [])],
    events: [
      { key: 'state', label: 'State', render: (r) => statusBadge(r.state) }, { key: 'ticker', label: tx('admin.catalog.render.ticker'), render: (r) => `<code>${esc(r.ticker)}</code>` },
      { key: 'title', label: tx('admin.catalog.render.title'), render: (r) => `${r.icon_color ? `<i class="adm-swatch v-bg"${vars({ '--bg': r.icon_color })}></i>` : ''}${esc(r.title)}${r.featured ? ' ' + badge('featured', 'brand') : ''}${r.is_live ? ' ' + badge('live', 'bad') : ''}` },
      { key: 'series_ticker', label: tx('admin.catalog.render.series_2') }, { key: 'category', label: tx('admin.catalog.render.category') }, { key: 'markets', label: tx('admin.catalog.render.markets'), num: true },
      ...(canWrite ? [{ key: '_a', label: '', sort: false, render: (r) => actions(r, 'events') }] : [{ key: '_p', label: '', sort: false, render: (r) => `<a class="btn btn-sm" href="/admin/preview/${encodeURIComponent(r.ticker)}" data-link>${te('admin.catalog.render.preview')}</a>` }])],
    markets: [
      { key: 'state', label: 'State', render: (r) => statusBadge(r.state === 'draft' ? 'draft' : r.status) }, { key: 'ticker', label: tx('admin.catalog.render.ticker'), render: (r) => `<code>${esc(r.ticker)}</code>` },
      { key: 'yes_sub_title', label: tx('admin.catalog.render.outcome'), render: (r) => `<i class="adm-swatch v-bg"${vars({ '--bg': r.color })}></i>${esc(r.yes_sub_title)}` }, { key: 'event_ticker', label: tx('admin.catalog.render.event_2') },
      { key: 'close_time', label: tx('admin.catalog.render.closes'), render: (r) => esc(fmtTime(r.close_time)) }, { key: 'volume_fp', label: tx('admin.catalog.render.volume'), num: true, render: (r) => (r.volume_fp == null ? '—' : fmtQty(r.volume_fp)) },
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
    openForm({ title: existing ? tx('admin.catalog.render.edit_market', { ticker: existing.ticker }) : tx('admin.catalog.render.new_market_draft'), fields: f, submit: existing ? 'Save' : tx('admin.catalog.render.create_draft'), testid: 'market-form',
      onSubmit: async (v) => { if (existing) await put(`/catalog/markets/${encodeURIComponent(existing.ticker)}`, v); else await post('/catalog/markets', v); toast(existing ? tx('admin.catalog.render.market_saved') : tx('admin.catalog.render.draft_market_created')); await refresh(el.querySelector('[data-q]')?.value.trim() || ''); } });
  }
  el.querySelector('[data-new]')?.addEventListener('click', async () => {
    if (tab === 'series') openForm({ title: tx('admin.catalog.render.new_series_draft'), fields: seriesFields({}, true), submit: tx('admin.catalog.render.create_draft'), testid: 'series-form', onSubmit: async (v) => { await post('/catalog/series', v); toast(tx('admin.catalog.render.draft_series_created')); await refresh(''); } });
    if (tab === 'events') { const s = await seriesList(); openForm({ title: tx('admin.catalog.render.new_event_draft'), fields: eventFields({}, true, s), submit: tx('admin.catalog.render.create_draft'), testid: 'event-form', onSubmit: async (v) => { await post('/catalog/events', v); toast(tx('admin.catalog.render.draft_event_created')); await refresh(''); } }); }
    if (tab === 'markets') openMarket();
  });
  body.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const q = () => el.querySelector('[data-q]')?.value.trim() || '';
    try {
      if (b.dataset.edit) {
        const row = data[tab].find((r) => r.ticker === b.dataset.edit);
        if (tab === 'series') openForm({ title: tx('admin.catalog.render.edit_series', { ticker: row.ticker }), fields: seriesFields(row, false), submit: 'Save', testid: 'series-form', onSubmit: async (v) => { await put(`/catalog/series/${encodeURIComponent(row.ticker)}`, v); toast(tx('admin.catalog.render.series_saved')); await refresh(q()); } });
        if (tab === 'events') { const s = row.state === 'draft' ? await seriesList() : []; openForm({ title: tx('admin.catalog.render.edit_event', { ticker: row.ticker }), fields: eventFields(row, false, s), submit: 'Save', testid: 'event-form', onSubmit: async (v) => { await put(`/catalog/events/${encodeURIComponent(row.ticker)}`, v); toast(tx('admin.catalog.render.event_saved')); await refresh(q()); } }); }
        if (tab === 'markets') openMarket({}, row);
      } else if (b.dataset.addMarket) {
        openMarket({ event_ticker: b.dataset.addMarket });
      } else if (b.dataset.publish) {
        const ok = await confirmAction({ title: tx('admin.catalog.render.publish', { publish: b.dataset.publish }), body: tab === 'events' ? tx('admin.catalog.render.the_event_its_draft_series') : tx('admin.catalog.render.this_goes_live_on_the'), confirm: tx('admin.catalog.render.publish_2') });
        if (!ok) return;
        const r = await post(`/catalog/${tab}/${encodeURIComponent(b.dataset.publish)}/publish`);
        toast(tx('admin.catalog.render.published', { value: r.published.map((p) => p.ticker).join(', ') }));
        await refresh(q());
      } else if (b.dataset.discard) {
        const ok = await confirmAction({ title: tx('admin.catalog.render.discard_draft', { discard: b.dataset.discard }), body: tx('admin.catalog.render.the_draft_is_deleted_this'), confirm: tx('admin.catalog.render.discard'), danger: true });
        if (!ok) return;
        await del(`/catalog/${tab}/${encodeURIComponent(b.dataset.discard)}`);
        toast(tx('admin.catalog.render.draft_discarded')); await refresh(q());
      }
    } catch (ex) { toast(ex.message, 'error'); }
  });
  void navigate;
}

async function renderPreview(el, ticker) {
  const r = await get(`/catalog/preview/${encodeURIComponent(ticker)}`);
  const ev = r.event;
  el.innerHTML = section(`Preview: ${ev.title}`, r.state === 'draft' ? tx('admin.catalog.render_preview.draft_not_visible_to_the') : tx('admin.catalog.render_preview.published_event'),
    `<a class="btn" href="/admin/catalog/events" data-link>${te('admin.catalog.render_preview.back_to_events')}</a>${r.state === 'published' ? ` <a class="btn btn-primary" href="${esc(eventHref(ev))}" data-link>${te('admin.catalog.render_preview.open_public_page')}</a>` : ''}`) +
    `<div class="adm-preview" data-testid="catalog-preview" data-state="${esc(r.state)}">${r.state === 'draft' ? `<div class="adm-banner warn">${te('admin.catalog.render_preview.draft_preview')}</div>` : ''}<div class="adm-preview-card">${eventCard(ev)}</div>
    <div class="card adm-card"><h3>${te('admin.catalog.render_preview.markets')}</h3><table class="table"><thead><tr><th>${te('admin.catalog.render_preview.outcome')}</th><th>${te('admin.catalog.render_preview.opens')}</th><th>${te('admin.catalog.render_preview.closes')}</th><th>${te('admin.catalog.render_preview.rules')}</th></tr></thead><tbody>${ev.markets.map((m) => `<tr><td><i class="adm-swatch v-bg"${vars({ '--bg': m.color_code })}></i>${esc(m.yes_sub_title)}</td><td>${esc(fmtTime(m.open_time))}</td><td>${esc(fmtTime(m.close_time))}</td><td class="muted">${esc(m.rules_primary)}</td></tr>`).join('') || `<tr><td colspan="4" class="faint">${te('admin.catalog.render_preview.no_markets_yet_add_one')}</td></tr>`}</tbody></table>
    ${ev.news ? `<p><b>${te('admin.catalog.render_preview.news')}</b> ${esc(ev.news)}</p>` : ''}</div></div>`;
}

function renderImport(body, canWrite) {
  body.innerHTML = `<div class="card adm-card" data-testid="catalog-import">
    <p class="muted">${te('admin.catalog.render_import.upload_a_csv_of_markets')} <b>${te('admin.catalog.render_import.draft')}</b> ${te('admin.catalog.render_import.market_under_an_existing_draft')} <code>${te('admin.catalog.render_import.event_ticker')}</code>, <code>${te('admin.catalog.render_import.market_ticker')}</code>, <code>${te('admin.catalog.render_import.yes_sub_title')}</code>, <code>${te('admin.catalog.render_import.close_time')}</code>.</p>
    <p><a class="btn btn-sm" href="/v1/admin/catalog/import/template.csv" download data-testid="import-template">${te('admin.catalog.render_import.download_template')}</a></p>
    ${canWrite ? `<label class="field"><span>${te('admin.catalog.render_import.csv_file')}</span><input type="file" accept=".csv,text/csv" data-file></label>
    <label class="field"><span>${te('admin.catalog.render_import.or_paste_csv')}</span><textarea rows="8" data-csv data-testid="import-csv" spellcheck="false"></textarea></label>
    <div class="adm-form-actions"><button class="btn btn-primary" data-run data-testid="import-run">${te('admin.catalog.render_import.import_as_drafts')}</button></div>` : `<p class="faint">${te('admin.catalog.render_import.your_role_can_view_but')}</p>`}
    <div data-result></div></div>`;
  const ta = body.querySelector('[data-csv]');
  body.querySelector('[data-file]')?.addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) ta.value = await f.text(); });
  body.querySelector('[data-run]')?.addEventListener('click', async () => {
    const out = body.querySelector('[data-result]');
    try {
      const r = await post('/catalog/import', { csv: ta.value });
      out.innerHTML = `<div class="adm-import-result" data-testid="import-result"><p><b data-testid="import-created">${r.created.length}</b> ${te('admin.catalog.render_import.draft_market_s_created_from', { rows: esc(r.rows) })} <b data-testid="import-errors">${r.errors.length}</b> ${te('admin.catalog.render_import.row_s_rejected')}</p>
        ${r.created.length ? `<p class="faint">${te('admin.catalog.render_import.created', { value: r.created.map((t) => `<code>${esc(t)}</code>`).join(' ') })}</p>` : ''}
        ${r.errors.length ? `<table class="table" data-testid="import-error-table"><thead><tr><th class="num">${te('admin.catalog.render_import.row')}</th><th>${te('admin.catalog.render_import.market_ticker_2')}</th><th>${te('admin.catalog.render_import.problems')}</th></tr></thead><tbody>${r.errors.map((x) => `<tr><td class="num">${esc(x.row)}</td><td><code>${esc(x.market_ticker)}</code></td><td>${x.errors.map(esc).join('<br>')}</td></tr>`).join('')}</tbody></table>
        <button class="btn btn-sm" data-errcsv data-testid="import-error-csv">${te('admin.catalog.render_import.download_error_report')}</button>` : ''}</div>`;
      out.querySelector('[data-errcsv]')?.addEventListener('click', () => download('import-errors.csv', [csvLine(['row', 'market_ticker', 'errors']), ...r.errors.map((x) => csvLine([x.row, x.market_ticker, x.errors.join('; ')]))].join('\n') + '\n'));
      toast(tx('admin.catalog.render_import.created_rejected', { value: r.created.length, value_2: r.errors.length }));
    } catch (ex) { out.innerHTML = `<p class="adm-err" role="alert">${esc(ex.message)}${ex.fields ? ': ' + esc(Object.values(ex.fields).join('; ')) : ''}</p>`; }
  });
}
