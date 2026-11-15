// Admin › Content queue (CLONE_SPEC.md §41): the news review queue (approve with an edited headline / excerpt, category
// and attached events; reject; bulk), auto-written market content (review, edit, approve, reject, regenerate, history and
// restore), the news sources (add, edit, switch on / off, fetch now, last fetch status) and the keyword rules that
// categorise news. Reading and rejecting pending items needs content.write; publishing, restoring, sources and rules need
// content.publish. Every change asks for a reason and is audited by the server.
import { t as tx, te } from '../../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../../content/admin.cq-strings.js';
import { esc, get, post, put, toast, dialog, formHtml, wireForm, confirmAction, section, subTabs, badge, fmtTime } from './ui.js';

const BASE = '/admin/content_queue';
const TABS = [['news', 'admin.cq.tabs.news'], ['content', 'admin.cq.tabs.content'], ['sources', 'admin.cq.tabs.sources'], ['rules', 'admin.cq.tabs.rules']];
const KIND = { pending: 'warn', approved: 'ok', rejected: 'bad', superseded: '', auto_published: 'ok', ok: 'ok', not_modified: 'ok' };
const ext = (url, text) => (/^https?:\/\//i.test(url || '') ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(text)}</a>` : esc(text));

export async function render({ el, parts, perms }) {
  const tab = TABS.some(([k]) => k === parts[0]) ? parts[0] : 'news';
  const canPublish = perms.has('content.publish');
  const ov = await get('/content_queue/overview');
  const sw = ov.switches;
  const on = (v) => badge(tx(v ? 'admin.cq.on' : 'admin.cq.off'), v ? 'ok' : 'warn');
  el.innerHTML = section(tx('admin.cq.title'), te('admin.cq.intro'))
    + `<p class="muted" data-testid="cq-status">${te('admin.cq.status_line', { ingest: on(sw.news_ingest), autogen: on(sw.autogen), review: on(sw.require_review), batch: esc(sw.batch_size), interval: esc(sw.interval_minutes),
      provider: esc(ov.provider ? ov.provider.label : tx('admin.cq.template_only')), requests: esc(ov.ai_usage.requests), cap: esc(sw.ai_daily_requests) })} <a href="/admin/owner_settings" data-link>${te('admin.cq.to_settings')}</a> · <a href="/admin/flags" data-link>${te('admin.cq.to_flags')}</a></p>`
    + subTabs(TABS.map(([k, key]) => [k, tx(key, { n: k === 'news' ? ov.counts.news_pending : k === 'content' ? ov.counts.content_pending : k === 'sources' ? ov.counts.sources : '' })]), tab, BASE)
    + '<div data-pane></div>';
  const pane = el.querySelector('[data-pane]');
  if (tab === 'news') return renderNews(pane, { canPublish, categories: ov.categories });
  if (tab === 'content') return renderContent(pane, { canPublish });
  if (tab === 'sources') return renderSources(pane, { canPublish, categories: ov.categories });
  return renderRules(pane, { canPublish, categories: ov.categories });
}

// ---------------------------------------------------------------- news review
async function renderNews(el, { canPublish, categories }) {
  const st = { status: 'pending', category: '' };
  const catOpts = (sel, all) => `${all ? `<option value="">${te('admin.cq.news.all_categories')}</option>` : ''}${categories.map((c) => `<option value="${esc(c)}" ${c === sel ? 'selected' : ''}>${esc(c)}</option>`).join('')}`;
  el.innerHTML = `<div class="adm-toolbar" data-testid="cq-news-toolbar">
      <label class="field"><span>${te('admin.cq.news.status')}</span><select data-status data-testid="cq-news-status">${['pending', 'approved', 'rejected'].map((s) => `<option value="${esc(s)}">${esc(tx(`admin.cq.state.${s}`))}</option>`).join('')}</select></label>
      <label class="field"><span>${te('admin.cq.news.category')}</span><select data-cat>${catOpts('', true)}</select></label>
      <span class="grow"></span>
      ${canPublish ? `<button class="btn" data-bulk="approve" data-testid="cq-bulk-approve">${te('admin.cq.news.approve_selected')}</button>` : ''}<button class="btn" data-bulk="reject" data-testid="cq-bulk-reject">${te('admin.cq.news.reject_selected')}</button></div>
    <p class="faint">${te('admin.cq.news.legal_note')}</p><div data-list></div>`;
  let items = [];
  const load = async () => {
    const r = await get(`/content_queue/news?status=${encodeURIComponent(st.status)}${st.category ? `&category=${encodeURIComponent(st.category)}` : ''}`);
    items = r.items;
    el.querySelector('[data-list]').innerHTML = items.length ? `<div class="adm-scroll"><table class="table adm-grid" data-testid="cq-news-table"><thead><tr><th><input type="checkbox" data-all aria-label="${te('admin.cq.news.select_all')}"></th><th>${te('admin.cq.news.headline')}</th><th>${te('admin.cq.news.publisher')}</th><th>${te('admin.cq.news.category')}</th><th>${te('admin.cq.news.events')}</th><th>${te('admin.cq.news.status')}</th><th></th></tr></thead><tbody>
      ${items.map((i) => `<tr data-testid="cq-news-row" data-id="${esc(i.id)}" data-status="${esc(i.status)}"><td><input type="checkbox" data-pick="${esc(i.id)}" aria-label="${te('admin.cq.news.select')}"></td>
        <td><div data-testid="cq-news-headline">${ext(i.url, i.headline)}</div>${i.excerpt ? `<div class="faint">${esc(i.excerpt)}</div>` : ''}${i.edited ? `<div class="faint">${te('admin.cq.news.original', { headline: esc(i.headline_orig) })}</div>` : ''}</td>
        <td>${esc(i.publisher)}<div class="faint">${esc(fmtTime(i.published_time))}</div></td>
        <td data-testid="cq-news-category">${badge(i.category)}<div class="faint">${esc(tx(`admin.cq.method.${i.category_method}`))}</div></td>
        <td>${(i.status === 'approved' ? i.events : i.suggested_events).map((e) => `<code>${esc(e.event_ticker)}</code>`).join(' ') || '<span class="faint">—</span>'}</td>
        <td>${badge(tx(`admin.cq.state.${i.status}`), KIND[i.status] || '')}${i.decided_by ? `<div class="faint">${esc(i.decided_by)}</div>` : ''}</td>
        <td class="adm-actions"><button class="btn btn-sm" data-review="${esc(i.id)}" data-testid="cq-news-review">${te('admin.cq.news.review')}</button></td></tr>`).join('')}</tbody></table></div>`
      : `<div class="card empty" data-testid="cq-news-empty">${te('admin.cq.news.empty')}</div>`;
  };
  const picked = () => [...el.querySelectorAll('[data-pick]:checked')].map((x) => x.dataset.pick);
  el.querySelector('[data-status]').onchange = (e) => { st.status = e.target.value; load(); };
  el.querySelector('[data-cat]').onchange = (e) => { st.category = e.target.value; load(); };
  el.addEventListener('change', (e) => { if (e.target.matches('[data-all]')) for (const c of el.querySelectorAll('[data-pick]')) c.checked = e.target.checked; });
  el.addEventListener('click', async (e) => {
    const bulk = e.target.closest('[data-bulk]');
    if (bulk) {
      const ids = picked();
      if (!ids.length) { toast(tx('admin.cq.news.pick_first'), 'error'); return; }
      const action = bulk.dataset.bulk;
      const ok = await confirmAction({ title: tx(action === 'approve' ? 'admin.cq.news.bulk_approve_title' : 'admin.cq.news.bulk_reject_title', { n: ids.length }), body: esc(tx(action === 'approve' ? 'admin.cq.news.bulk_approve_body' : 'admin.cq.news.bulk_reject_body')), confirm: tx(action === 'approve' ? 'admin.cq.news.approve' : 'admin.cq.news.reject'), reason: true, danger: action === 'reject' });
      if (!ok) return;
      try { const r = await post('/content_queue/news/bulk', { action, ids, reason: ok.reason }); toast(tx('admin.cq.news.bulk_done', { n: r.done })); load(); } catch (ex) { toast(ex.message, 'error'); }
      return;
    }
    const rb = e.target.closest('[data-review]');
    if (rb) reviewNews(items.find((i) => i.id === rb.dataset.review), { canPublish, categories, done: load });
  });
  await load();
}

function reviewNews(item, { canPublish, categories, done }) {
  const fields = [
    { name: 'headline', label: tx('admin.cq.news.headline'), value: item.headline, required: true, span: true },
    { name: 'excerpt', label: tx('admin.cq.news.excerpt'), type: 'textarea', value: item.excerpt, max: 300, span: true, hint: tx('admin.cq.news.excerpt_hint') },
    { name: 'category', label: tx('admin.cq.news.category'), type: 'select', value: item.category, options: categories },
    { name: 'events', label: tx('admin.cq.news.events_field'), value: (item.status === 'approved' ? item.events : []).map((e) => e.event_ticker).join(', '), hint: tx('admin.cq.news.events_hint') },
    { name: 'reason', label: tx('admin.cq.reason'), required: true, span: true },
  ];
  const sugg = item.suggested_events.length ? `<p class="faint">${te('admin.cq.news.suggestions')} ${item.suggested_events.map((s) => `<button type="button" class="btn btn-sm" data-add-event="${esc(s.event_ticker)}" data-testid="cq-suggestion">${esc(s.event_ticker)}</button> <span class="faint">${esc(s.title)}</span>`).join(' ')}</p>` : `<p class="faint">${te('admin.cq.news.no_suggestions')}</p>`;
  const d = dialog(`<h3>${te('admin.cq.news.review_title')}</h3><p class="faint">${te('admin.cq.news.from', { publisher: esc(item.publisher), time: esc(fmtTime(item.published_time)) })} · ${ext(item.url, tx('admin.cq.news.open_original'))}</p>
    <p class="faint">${te('admin.cq.news.original', { headline: esc(item.headline_orig) })}</p>${sugg}
    ${formHtml(fields, { submit: tx('admin.cq.news.approve_publish'), id: 'cqn', testid: 'cq-news-form', extra: `<button class="btn btn-danger" type="button" data-reject data-testid="cq-news-reject">${te('admin.cq.news.reject')}</button>` })}`, { wide: true, testid: 'cq-news-dialog' });
  const form = d.querySelector('form');
  if (!canPublish) form.querySelector('button[type=submit]').hidden = true;
  d.addEventListener('click', (e) => {
    const b = e.target.closest('[data-add-event]');
    if (!b) return;
    const f = form.elements.events; const list = f.value.split(',').map((x) => x.trim()).filter(Boolean);
    if (!list.includes(b.dataset.addEvent)) list.push(b.dataset.addEvent);
    f.value = list.join(', ');
  });
  const w = wireForm(form, fields, async (v) => {
    await post(`/content_queue/news/${encodeURIComponent(item.id)}/approve`, { headline: v.headline, excerpt: v.excerpt, category: v.category, events: String(v.events || '').split(',').map((x) => x.trim()).filter(Boolean), reason: v.reason });
    toast(tx('admin.cq.news.approved')); d.close(); done();
  });
  form.querySelector('[data-reject]').onclick = async () => {
    const reason = form.elements.reason.value.trim();
    if (reason.length < 3) { w.showErrors({ reason: tx('admin.cq.reason_needed') }); return; }
    try { await post(`/content_queue/news/${encodeURIComponent(item.id)}/reject`, { reason }); toast(tx('admin.cq.news.rejected')); d.close(); done(); } catch (ex) { form.querySelector('[data-form-error]').textContent = ex.message; }
  };
}

// ---------------------------------------------------------------- market content
async function renderContent(el, { canPublish }) {
  const st = { status: 'pending' };
  el.innerHTML = `<div class="adm-toolbar"><label class="field"><span>${te('admin.cq.content.status')}</span><select data-status data-testid="cq-content-status">${['pending', 'approved', 'auto_published', 'rejected', 'superseded', 'all'].map((s) => `<option value="${esc(s)}">${esc(tx(`admin.cq.state.${s}`))}</option>`).join('')}</select></label>
    <span class="grow"></span><span class="faint" data-cands></span><button class="btn btn-primary" data-run data-testid="cq-run">${te('admin.cq.content.generate_now')}</button></div><div data-list></div>`;
  let items = [];
  const load = async () => {
    const r = await get(`/content_queue/market_content?status=${encodeURIComponent(st.status)}`);
    items = r.items;
    el.querySelector('[data-cands]').textContent = tx('admin.cq.content.candidates', { n: r.candidates, last: r.last_generation ? fmtTime(new Date(r.last_generation.ts).toISOString()) : '—' });
    el.querySelector('[data-list]').innerHTML = items.length ? `<div class="adm-scroll"><table class="table adm-grid" data-testid="cq-content-table"><thead><tr><th>${te('admin.cq.content.event')}</th><th>${te('admin.cq.content.generator')}</th><th>${te('admin.cq.content.created')}</th><th>${te('admin.cq.content.status')}</th><th></th></tr></thead><tbody>
      ${items.map((i) => `<tr data-testid="cq-content-row" data-id="${esc(i.id)}" data-event="${esc(i.event_ticker)}" data-status="${esc(i.status)}"><td><code>${esc(i.event_ticker)}</code><div class="faint">${esc(i.event_title)}</div></td>
        <td>${badge(tx(`admin.cq.generator.${i.generator}`), i.generator === 'ai' ? 'ok' : '')}${i.fallback_reason ? `<div class="faint" data-testid="cq-fallback">${esc(i.fallback_reason)}</div>` : ''}</td>
        <td>${esc(fmtTime(i.created_time))}</td><td>${badge(tx(`admin.cq.state.${i.status}`), KIND[i.status] || '')}${i.decided_by ? `<div class="faint">${esc(i.decided_by)}</div>` : ''}</td>
        <td class="adm-actions">${i.status === 'pending' ? `<button class="btn btn-sm" data-review="${esc(i.id)}" data-testid="cq-content-review">${te('admin.cq.content.review')}</button>` : ''}<button class="btn btn-sm" data-history="${esc(i.event_ticker)}" data-testid="cq-history">${te('admin.cq.content.history')}</button><button class="btn btn-sm btn-ghost" data-regen="${esc(i.event_ticker)}" data-testid="cq-regenerate">${te('admin.cq.content.regenerate')}</button></td></tr>`).join('')}</tbody></table></div>`
      : `<div class="card empty" data-testid="cq-content-empty">${te('admin.cq.content.empty')}</div>`;
  };
  el.querySelector('[data-status]').onchange = (e) => { st.status = e.target.value; load(); };
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-run]')) {
      try { const r = await post('/content_queue/market_content/run', { reason: tx('admin.cq.content.run_reason') }); toast(tx('admin.cq.content.run_done', { n: r.queued, left: r.remaining })); load(); } catch (ex) { toast(ex.message, 'error'); }
      return;
    }
    const rv = e.target.closest('[data-review]');
    if (rv) { reviewContent(items.find((i) => i.id === rv.dataset.review), { canPublish, done: load }); return; }
    const h = e.target.closest('[data-history]');
    if (h) { history(h.dataset.history, { canPublish }); return; }
    const g = e.target.closest('[data-regen]');
    if (g) {
      const ok = await confirmAction({ title: tx('admin.cq.content.regenerate_title', { event: g.dataset.regen }), body: esc(tx('admin.cq.content.regenerate_body')), confirm: tx('admin.cq.content.regenerate'), reason: true });
      if (!ok) return;
      try { await post('/content_queue/market_content/regenerate', { event_ticker: g.dataset.regen, reason: ok.reason }); toast(tx('admin.cq.content.regenerated')); load(); } catch (ex) { toast(ex.message, 'error'); }
    }
  });
  await load();
}

function reviewContent(item, { canPublish, done }) {
  const fields = [
    { name: 'description', label: tx('admin.cq.content.description'), type: 'textarea', rows: 4, value: item.description, max: 1000, required: true, span: true },
    { name: 'background', label: tx('admin.cq.content.background'), type: 'textarea', rows: 5, value: item.background, max: 2000, required: true, span: true },
    { name: 'resolution_notes', label: tx('admin.cq.content.resolution_notes'), type: 'textarea', rows: 7, value: item.resolution_notes, max: 3000, required: true, span: true },
    { name: 'reason', label: tx('admin.cq.reason'), required: true, span: true },
  ];
  const d = dialog(`<h3>${te('admin.cq.content.review_title', { event: esc(item.event_ticker) })}</h3><p class="faint">${esc(item.event_title)} · ${esc(tx(`admin.cq.generator.${item.generator}`))}${item.fallback_reason ? ` · ${esc(item.fallback_reason)}` : ''}</p><p class="faint">${te('admin.cq.content.plain_text')}</p>
    ${formHtml(fields, { submit: tx('admin.cq.content.approve_publish'), id: 'cqc', testid: 'cq-content-form', extra: `<button class="btn btn-danger" type="button" data-reject data-testid="cq-content-reject">${te('admin.cq.content.reject')}</button>` })}`, { wide: true, testid: 'cq-content-dialog' });
  const form = d.querySelector('form');
  if (!canPublish) form.querySelector('button[type=submit]').hidden = true;
  const w = wireForm(form, fields, async (v) => {
    await post(`/content_queue/market_content/${encodeURIComponent(item.id)}/approve`, { description: v.description, background: v.background, resolution_notes: v.resolution_notes, reason: v.reason });
    toast(tx('admin.cq.content.approved')); d.close(); done();
  });
  form.querySelector('[data-reject]').onclick = async () => {
    const reason = form.elements.reason.value.trim();
    if (reason.length < 3) { w.showErrors({ reason: tx('admin.cq.reason_needed') }); return; }
    try { await post(`/content_queue/market_content/${encodeURIComponent(item.id)}/reject`, { reason }); toast(tx('admin.cq.content.rejected')); d.close(); done(); } catch (ex) { form.querySelector('[data-form-error]').textContent = ex.message; }
  };
}

async function history(ticker, { canPublish }) {
  const r = await get(`/content_queue/market_content/events/${encodeURIComponent(ticker)}/history`);
  const cur = r.published ? r.published.version : 0;
  const d = dialog(`<h3>${te('admin.cq.history.title', { event: esc(ticker) })}</h3>${r.versions.length ? `<ol class="adm-hist" data-testid="cq-history-list">${r.versions.map((v) => `<li data-testid="cq-version" data-version="${esc(v.version)}"><b>${te('admin.cq.history.version', { n: esc(v.version) })}</b> ${v.version === cur ? badge(tx('admin.cq.history.current'), 'ok') : ''} <span class="faint">${esc(v.action)} · ${esc(v.author || tx('admin.cq.history.system'))} · ${esc(fmtTime(v.time))}</span>
      <div class="faint">${esc(v.reason)}</div>${v.value ? `<p>${esc(v.value.description)}</p>` : `<p class="faint">${te('admin.cq.history.empty_value')}</p>`}
      ${canPublish && v.version !== cur ? `<button class="btn btn-sm" data-restore="${esc(v.version)}" data-testid="cq-restore">${te('admin.cq.history.restore')}</button>` : ''}</li>`).join('')}</ol>` : `<p class="faint">${te('admin.cq.history.none')}</p>`}`, { wide: true, testid: 'cq-history-dialog' });
  d.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-restore]');
    if (!b) return;
    const ok = await confirmAction({ title: tx('admin.cq.history.restore_title', { n: b.dataset.restore }), confirm: tx('admin.cq.history.restore'), reason: true });
    if (!ok) return;
    try { await post(`/content_queue/market_content/events/${encodeURIComponent(ticker)}/restore`, { version: Number(b.dataset.restore), reason: ok.reason }); toast(tx('admin.cq.history.restored')); d.close(); } catch (ex) { toast(ex.message, 'error'); }
  });
}

// ---------------------------------------------------------------- sources
async function renderSources(el, { canPublish, categories }) {
  const fieldsFor = (s = {}) => [
    { name: 'name', label: tx('admin.cq.sources.name'), value: s.name || '', required: true },
    { name: 'feed_url', label: tx('admin.cq.sources.feed_url'), value: s.feed_url || '', required: true, placeholder: 'https://', hint: tx('admin.cq.sources.feed_hint') },
    { name: 'default_category', label: tx('admin.cq.sources.default_category'), type: 'select', value: s.default_category || categories[0], options: categories },
    { name: 'interval_minutes', label: tx('admin.cq.sources.interval'), type: 'number', value: s.interval_minutes || 30, required: true },
    { name: 'enabled', label: tx('admin.cq.sources.enabled'), type: 'checkbox', value: s.enabled !== false },
    { name: 'reason', label: tx('admin.cq.reason'), required: true, span: true },
  ];
  const body = (v) => ({ name: v.name, feed_url: v.feed_url, default_category: v.default_category, interval_minutes: Number(v.interval_minutes), enabled: !!v.enabled, reason: v.reason });
  el.innerHTML = `<p class="faint">${te('admin.cq.sources.intro')}</p>${canPublish ? `<details class="card panel" data-testid="cq-source-add"><summary>${te('admin.cq.sources.add')}</summary>${formHtml(fieldsFor(), { submit: tx('admin.cq.sources.add'), id: 'cqs', testid: 'cq-source-form' })}</details>` : ''}<div data-list></div>`;
  let sources = [];
  const load = async () => {
    const r = await get('/content_queue/sources');
    sources = r.sources;
    el.querySelector('[data-list]').innerHTML = `<div class="adm-scroll"><table class="table adm-grid" data-testid="cq-sources-table"><thead><tr><th>${te('admin.cq.sources.name')}</th><th>${te('admin.cq.sources.default_category')}</th><th>${te('admin.cq.sources.interval')}</th><th>${te('admin.cq.sources.state')}</th><th>${te('admin.cq.sources.last_fetch')}</th><th></th></tr></thead><tbody>
      ${sources.map((s) => `<tr data-testid="cq-source-row" data-id="${esc(s.id)}" data-name="${esc(s.name)}" data-enabled="${s.enabled ? '1' : '0'}" data-last-status="${esc(s.last_status || '')}"><td><b>${esc(s.name)}</b><div class="faint"><code>${esc(s.feed_url)}</code></div></td>
        <td>${esc(s.default_category)}</td><td class="num">${esc(tx('admin.cq.sources.minutes', { n: s.interval_minutes }))}</td><td>${badge(tx(s.enabled ? 'admin.cq.on' : 'admin.cq.off'), s.enabled ? 'ok' : 'warn')}</td>
        <td data-testid="cq-source-status">${s.last_status ? `${badge(s.last_status, KIND[s.last_status] || 'bad')} <span class="faint">${esc(fmtTime(s.last_fetch_time))}</span><div class="faint">${esc(tx('admin.cq.sources.counts', { items: s.last_items, added: s.last_new, dups: s.last_duplicates, pending: s.pending }))}</div>${s.last_error ? `<div class="faint" data-testid="cq-source-error">${esc(s.last_error)}</div>` : ''}` : `<span class="faint">${te('admin.cq.sources.never')}</span>`}</td>
        <td class="adm-actions"><button class="btn btn-sm" data-fetch="${esc(s.id)}" data-testid="cq-fetch" ${s.enabled ? '' : 'disabled'}>${te('admin.cq.sources.fetch_now')}</button>${canPublish ? `<button class="btn btn-sm" data-toggle="${esc(s.id)}" data-testid="cq-toggle">${te(s.enabled ? 'admin.cq.sources.switch_off' : 'admin.cq.sources.switch_on')}</button><button class="btn btn-sm" data-edit="${esc(s.id)}">${te('admin.cq.sources.edit')}</button><button class="btn btn-sm btn-ghost" data-delete="${esc(s.id)}">${te('admin.cq.sources.delete')}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  };
  const addForm = el.querySelector('[data-testid=cq-source-form]');
  if (addForm) {
    const f = fieldsFor();
    wireForm(addForm, f, async (v) => { await post('/content_queue/sources', body(v)); toast(tx('admin.cq.sources.added')); addForm.reset(); load(); });
  }
  el.addEventListener('click', async (e) => {
    const fb = e.target.closest('[data-fetch]');
    if (fb) {
      fb.disabled = true;
      try { const r = await post(`/content_queue/sources/${encodeURIComponent(fb.dataset.fetch)}/fetch`, {}); toast(tx('admin.cq.sources.fetched', { status: r.result.status, n: r.result.new_items, dups: r.result.duplicates }), r.result.status === 'ok' || r.result.status === 'not_modified' ? '' : 'error'); } catch (ex) { toast(ex.message, 'error'); }
      load();
      return;
    }
    const tb = e.target.closest('[data-toggle]');
    if (tb) {
      const s = sources.find((x) => x.id === tb.dataset.toggle);
      const ok = await confirmAction({ title: tx(s.enabled ? 'admin.cq.sources.switch_off_title' : 'admin.cq.sources.switch_on_title', { name: s.name }), confirm: tx(s.enabled ? 'admin.cq.sources.switch_off' : 'admin.cq.sources.switch_on'), reason: true });
      if (!ok) return;
      try { await put(`/content_queue/sources/${encodeURIComponent(s.id)}`, { enabled: !s.enabled, reason: ok.reason }); load(); } catch (ex) { toast(ex.message, 'error'); }
      return;
    }
    const eb = e.target.closest('[data-edit]');
    if (eb) {
      const s = sources.find((x) => x.id === eb.dataset.edit);
      const f = fieldsFor(s);
      const d = dialog(`<h3>${te('admin.cq.sources.edit_title', { name: esc(s.name) })}</h3>${formHtml(f, { submit: tx('admin.cq.save'), id: 'cqse', testid: 'cq-source-edit' })}`, { testid: 'cq-source-dialog' });
      wireForm(d.querySelector('form'), f, async (v) => { await put(`/content_queue/sources/${encodeURIComponent(s.id)}`, body(v)); toast(tx('admin.cq.saved')); d.close(); load(); });
      return;
    }
    const db = e.target.closest('[data-delete]');
    if (db) {
      const s = sources.find((x) => x.id === db.dataset.delete);
      const ok = await confirmAction({ title: tx('admin.cq.sources.delete_title', { name: s.name }), body: esc(tx('admin.cq.sources.delete_body')), confirm: tx('admin.cq.sources.delete'), reason: true, danger: true });
      if (!ok) return;
      try { await post(`/content_queue/sources/${encodeURIComponent(s.id)}/delete`, { reason: ok.reason }); load(); } catch (ex) { toast(ex.message, 'error'); }
    }
  });
  await load();
}

// ---------------------------------------------------------------- keyword rules
async function renderRules(el, { canPublish, categories }) {
  const fields = [{ name: 'category', label: tx('admin.cq.rules.category'), type: 'select', options: categories, value: categories[0] }, { name: 'keyword', label: tx('admin.cq.rules.keyword'), required: true },
    { name: 'weight', label: tx('admin.cq.rules.weight'), type: 'number', value: 1, required: true }, { name: 'reason', label: tx('admin.cq.reason'), required: true, span: true }];
  el.innerHTML = `<p class="faint">${te('admin.cq.rules.intro')}</p>${canPublish ? formHtml(fields, { submit: tx('admin.cq.rules.add'), id: 'cqr', testid: 'cq-rule-form' }) : ''}<div data-list></div>`;
  let rules = [];
  const load = async () => {
    rules = (await get('/content_queue/rules')).rules;
    el.querySelector('[data-list]').innerHTML = `<div class="adm-scroll"><table class="table adm-grid" data-testid="cq-rules-table"><thead><tr><th>${te('admin.cq.rules.category')}</th><th>${te('admin.cq.rules.keyword')}</th><th>${te('admin.cq.rules.weight')}</th><th>${te('admin.cq.sources.state')}</th><th></th></tr></thead><tbody>
      ${rules.map((r) => `<tr data-testid="cq-rule-row" data-id="${esc(r.id)}"><td>${esc(r.category)}</td><td><code>${esc(r.keyword)}</code></td><td class="num">${esc(r.weight)}</td><td>${badge(tx(r.active ? 'admin.cq.on' : 'admin.cq.off'), r.active ? 'ok' : 'warn')}</td>
        <td class="adm-actions">${canPublish ? `<button class="btn btn-sm" data-rtoggle="${esc(r.id)}">${te(r.active ? 'admin.cq.sources.switch_off' : 'admin.cq.sources.switch_on')}</button><button class="btn btn-sm btn-ghost" data-rdelete="${esc(r.id)}">${te('admin.cq.sources.delete')}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  };
  const form = el.querySelector('[data-testid=cq-rule-form]');
  if (form) wireForm(form, fields, async (v) => { await post('/content_queue/rules', { category: v.category, keyword: v.keyword, weight: Number(v.weight), reason: v.reason }); toast(tx('admin.cq.rules.added')); form.elements.keyword.value = ''; load(); });
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-rtoggle]'); const d = e.target.closest('[data-rdelete]');
    if (!t && !d) return;
    const r = rules.find((x) => x.id === (t ? t.dataset.rtoggle : d.dataset.rdelete));
    const ok = await confirmAction({ title: tx(d ? 'admin.cq.rules.delete_title' : 'admin.cq.rules.toggle_title', { keyword: r.keyword }), confirm: d ? tx('admin.cq.sources.delete') : tx('admin.cq.save'), reason: true, danger: !!d });
    if (!ok) return;
    try { if (d) await post(`/content_queue/rules/${encodeURIComponent(r.id)}/delete`, { reason: ok.reason }); else await put(`/content_queue/rules/${encodeURIComponent(r.id)}`, { active: !r.active, reason: ok.reason }); load(); } catch (ex) { toast(ex.message, 'error'); }
  });
  await load();
}
