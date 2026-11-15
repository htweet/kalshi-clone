// Admin › Content › All content, History and Trash (owner request 2026-11-15, CLONE_SPEC.md §43). One searchable index of
// every registered content type (server/content-admin): filters by type and status, each row opens its own editor (or
// the generic form built from the type's field definitions), bulk publish / unpublish / trash / restore with one reason.
// History shows each change as a field diff with "Restore this version"; Trash restores or deletes for good (deleting a
// legal page or market news for good asks for a fresh step-up, which ui.js call() handles).
//   /admin/content/all       the index (?q=&type=&status=)
//   /admin/content/history   newest changes, or one item's (?type=&key=)
//   /admin/content/trash     the Trash
import { t, te, hasText } from '../../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../../content/admin.content-index-strings.js';
import { get, post, put, esc, toast, dialog, confirmAction, badge, fmtTime, formHtml, wireForm } from './ui.js';

const API = '/content_index';
const STATUS_KIND = { draft: 'warn', published: 'ok', scheduled: 'brand', hidden: '', trashed: 'bad' };
const typeName = (type, fallback) => (hasText(`admin.content_index.type.${type}`) ? t(`admin.content_index.type.${type}`) : fallback || type);
const statusName = (s) => (hasText(`admin.content_index.status.${s}`) ? t(`admin.content_index.status.${s}`) : s);
const fieldName = (f) => (hasText(`admin.content_index.field.${f}`) ? t(`admin.content_index.field.${f}`) : f);
const actionName = (a) => (hasText(`admin.content_index.action.${a}`) ? t(`admin.content_index.action.${a}`) : a);
const statusBadge = (s) => `<span data-testid="ci-status-badge">${badge(statusName(s), STATUS_KIND[s] || '')}</span>`;
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();

export async function render({ el, tab, query, navigate }) {
  if (tab === 'history') return history({ el, query, navigate });
  if (tab === 'trash') return trash({ el });
  return index({ el, query, navigate });
}

// Summary of a bulk / per-item result list: toast, and the failures listed under the table.
function report(box, results) {
  const failed = results.filter((r) => !r.ok);
  const done = results.length - failed.length;
  toast(failed.length ? t('admin.content_index.bulk.partly', { done, failed: failed.length }) : t('admin.content_index.bulk.done', { done }), failed.length ? 'error' : undefined);
  box.innerHTML = failed.length ? `<ul class="ci-failures" data-testid="ci-bulk-result">${failed.map((r) => `<li><code>${esc(r.type || r.trash_id || '')}</code> <code>${esc(r.key || '')}</code>: ${esc(r.message || r.code || '')}${r.details ? ` · ${esc(r.details)}` : ''}</li>`).join('')}</ul>` : '';
}

// ------------------------------------------------------------------ All content
async function index({ el, query, navigate }) {
  const st = { q: query.get('q') || '', type: query.get('type') || '', status: query.get('status') || '', offset: 0 };
  el.innerHTML = `<p class="muted">${te('admin.content_index.index.intro')}</p>
    <div class="cms-filters" data-testid="ci-filters"><input type="search" class="adm-input" data-testid="ci-search" placeholder="${te('admin.content_index.index.search')}" aria-label="${te('admin.content_index.index.search')}" value="${esc(st.q)}">
      <select class="adm-input" data-testid="ci-type" aria-label="${te('admin.content_index.index.type')}"><option value="">${te('admin.content_index.index.all_types')}</option></select>
      <select class="adm-input" data-testid="ci-status" aria-label="${te('admin.content_index.index.status')}"><option value="">${te('admin.content_index.index.any_status')}</option></select></div>
    <div class="ci-bulk" data-testid="ci-bulk"><span class="faint" data-selected>${te('admin.content_index.index.selected', { count: 0 })}</span>
      <button class="btn btn-sm" type="button" data-bulk="publish" data-testid="ci-bulk-publish" disabled>${te('admin.content_index.bulk.publish')}</button>
      <button class="btn btn-sm" type="button" data-bulk="unpublish" data-testid="ci-bulk-unpublish" disabled>${te('admin.content_index.bulk.unpublish')}</button>
      <button class="btn btn-sm" type="button" data-bulk="trash" data-testid="ci-bulk-trash" disabled>${te('admin.content_index.bulk.trash')}</button>
      <button class="btn btn-sm" type="button" data-bulk="restore" data-testid="ci-bulk-restore" disabled>${te('admin.content_index.bulk.restore')}</button></div>
    <div data-result></div><div data-list></div>`;
  const [qi, ti, si] = ['search', 'type', 'status'].map((k) => el.querySelector(`[data-testid=ci-${k}]`));
  const list = el.querySelector('[data-list]'); const resultBox = el.querySelector('[data-result]');
  const selected = new Map();
  let rows = [];
  const syncBulk = () => {
    el.querySelector('[data-selected]').textContent = t('admin.content_index.index.selected', { count: selected.size });
    for (const b of el.querySelectorAll('[data-bulk]')) b.disabled = !selected.size;
  };
  async function load() {
    const r = await get(`${API}?${qs({ q: st.q, type: st.type, status: st.status, offset: st.offset, limit: 100 })}`);
    if (ti.options.length <= 1) ti.insertAdjacentHTML('beforeend', r.types.map((x) => `<option value="${esc(x.type)}">${esc(typeName(x.type, x.label))}</option>`).join(''));
    if (si.options.length <= 1) si.insertAdjacentHTML('beforeend', r.statuses.map((s) => `<option value="${esc(s)}">${esc(statusName(s))}</option>`).join(''));
    ti.value = st.type; si.value = st.status;
    rows = r.items;
    const keyOf = (x) => `${x.type}\u0000${x.key}\u0000${x.trash_id || ''}`;
    list.innerHTML = `<p class="faint" data-testid="ci-total">${te('admin.content_index.index.total', { total: esc(r.total) })}</p>
      <div class="adm-scroll"><table class="table adm-grid" data-testid="ci-table"><thead><tr><th><input type="checkbox" data-all aria-label="${te('admin.content_index.index.select_all')}"></th><th>${te('admin.content_index.index.title')}</th><th>${te('admin.content_index.index.type')}</th><th>${te('admin.content_index.index.key')}</th><th>${te('admin.content_index.index.status')}</th><th>${te('admin.content_index.index.updated')}</th><th>${te('admin.content_index.index.by')}</th><th></th></tr></thead>
      <tbody>${rows.map((x, i) => `<tr data-testid="ci-row" data-i="${i}" data-type="${esc(x.type)}" data-key="${esc(x.key)}" data-status="${esc(x.status)}">
        <td><input type="checkbox" data-sel="${i}" data-testid="ci-select" aria-label="${te('admin.content_index.index.select', { title: esc(x.title) })}" ${selected.has(keyOf(x)) ? 'checked' : ''}></td>
        <td class="ci-title">${esc(x.title)}</td><td>${esc(typeName(x.type, x.type_label))}</td><td><code class="ci-key">${esc(x.key)}</code></td><td>${statusBadge(x.status)}</td>
        <td>${esc(fmtTime(x.updated_at))}</td><td class="faint">${esc(x.updated_by || '')}</td>
        <td><span class="adm-actions">${x.status === 'trashed' ? `<a class="btn btn-sm" href="/admin/content/trash" data-link>${te('admin.content_index.index.in_trash')}</a>`
    : `${x.can.edit ? `<button class="btn btn-sm" type="button" data-edit="${i}" data-testid="ci-edit">${te('admin.content_index.index.edit')}</button>` : ''}${x.edit_href ? `<a class="btn btn-sm" href="${esc(x.edit_href)}" data-link data-testid="ci-open">${te('admin.content_index.index.open_editor')}</a>` : ''}
          <a class="btn btn-sm btn-ghost" href="/admin/content/history?${esc(qs({ type: x.type, key: x.key }))}" data-link data-testid="ci-history-link">${te('admin.content_index.index.history')}</a>
          ${x.can.trash ? `<button class="btn btn-sm btn-ghost btn-danger" type="button" data-trash="${i}" data-testid="ci-trash">${te('admin.content_index.index.trash')}</button>` : ''}`}</span></td></tr>`).join('') || `<tr><td colspan="8" class="faint adm-empty">${te('admin.content_index.index.nothing')}</td></tr>`}</tbody></table></div>
      <div class="adm-pager"><button class="btn btn-sm" type="button" data-prev ${st.offset ? '' : 'disabled'}>${te('admin.content_index.index.prev')}</button><button class="btn btn-sm" type="button" data-next ${st.offset + 100 < r.total ? '' : 'disabled'}>${te('admin.content_index.index.next')}</button></div>`;
    list.querySelector('[data-prev]').onclick = () => { st.offset = Math.max(0, st.offset - 100); load(); };
    list.querySelector('[data-next]').onclick = () => { st.offset += 100; load(); };
    list.querySelector('[data-all]').onchange = (e) => { for (const x of rows) { if (e.target.checked) selected.set(keyOf(x), x); else selected.delete(keyOf(x)); } for (const c of list.querySelectorAll('[data-sel]')) c.checked = e.target.checked; syncBulk(); };
    for (const c of list.querySelectorAll('[data-sel]')) c.onchange = () => { const x = rows[Number(c.dataset.sel)]; if (c.checked) selected.set(keyOf(x), x); else selected.delete(keyOf(x)); syncBulk(); };
    for (const b of list.querySelectorAll('[data-edit]')) b.onclick = () => editItem(rows[Number(b.dataset.edit)], load);
    for (const b of list.querySelectorAll('[data-trash]')) b.onclick = async () => {
      const x = rows[Number(b.dataset.trash)];
      const ok = await confirmAction({ title: t('admin.content_index.trash.confirm_title'), body: `${esc(x.title)} <code>${esc(x.key)}</code><br>${te('admin.content_index.trash.confirm_body')}`, confirm: t('admin.content_index.trash.move'), danger: true, reason: true });
      if (!ok) return;
      try { report(resultBox, (await post(`${API}/trash`, { items: [{ type: x.type, key: x.key }], reason: ok.reason })).results); await load(); } catch (ex) { toast(ex.message, 'error'); }
    };
    syncBulk();
  }
  for (const b of el.querySelectorAll('[data-bulk]')) b.onclick = async () => {
    const action = b.dataset.bulk;
    const ok = await confirmAction({ title: t(`admin.content_index.bulk.confirm_${action}`, { count: selected.size }), body: te('admin.content_index.bulk.confirm_body'), confirm: t(`admin.content_index.bulk.${action}`), danger: action === 'trash', reason: true });
    if (!ok) return;
    try {
      const items = [...selected.values()].map((x) => ({ type: x.type, key: x.key, ...(x.trash_id ? { trash_id: x.trash_id } : {}) }));
      report(resultBox, (await post(`${API}/bulk`, { action, items, reason: ok.reason })).results);
      selected.clear(); await load();
    } catch (ex) { toast(ex.message, 'error'); }
  };
  let timer = null;
  const nav = () => navigate(`/admin/content/all?${qs({ q: st.q, type: st.type, status: st.status })}`, { replace: true });
  qi.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { st.q = qi.value.trim(); st.offset = 0; load(); }, 250); };
  qi.onchange = () => nav();
  ti.onchange = () => { st.type = ti.value; st.offset = 0; selected.clear(); load(); };
  si.onchange = () => { st.status = si.value; st.offset = 0; selected.clear(); load(); };
  await load();
}

// The generic form built from the type's field definitions (server/content-admin/adapters.js), saved with a reason.
const KIND_INPUT = { text: 'text', textarea: 'textarea', bool: 'checkbox', int: 'number', select: 'select', datetime: 'datetime', color: 'color' };
async function editItem(x, reload) {
  const it = (await get(`${API}/item?${qs({ type: x.type, key: x.key })}`)).item;
  const fields = it.fields.map((f) => ({ name: f.name, label: fieldName(f.name), type: KIND_INPUT[f.kind] || 'text', options: f.options, max: f.max, value: f.kind === 'datetime' ? it.data[f.name] || '' : it.data[f.name], span: f.kind === 'textarea' }));
  const all = [...fields, { name: 'reason', label: t('admin.content_index.form.reason'), type: 'textarea', rows: 2, required: true, span: true }];
  const d = dialog(`<h3>${esc(it.title)} <code class="faint">${esc(typeName(it.type, it.type_label))}</code></h3>${formHtml(all, { submit: t('admin.content_index.form.save'), id: 'ci', testid: 'ci-form', extra: `<button class="btn" type="button" data-close>${te('admin.content_index.form.cancel')}</button>` })}`, { wide: true, testid: 'ci-dialog' });
  d.querySelector('[data-close]').onclick = () => d.close();
  wireForm(d.querySelector('form'), all, async (v) => {
    const { reason, ...data } = v;
    for (const f of it.fields) if (f.kind === 'int' && data[f.name] !== '') data[f.name] = Number(data[f.name]);
    await put(`${API}/item`, { type: it.type, key: it.key, data, reason });
    d.close(); toast(t('admin.content_index.form.saved')); await reload();
  });
}

// ------------------------------------------------------------------ History (field diff, restore this version)
const asObj = (v) => (v != null && typeof v === 'object' && !Array.isArray(v) ? v : v == null ? {} : { value: v });
const show = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
export function diffRows(before, after) {
  const b = asObj(before); const a = asObj(after);
  return [...new Set([...Object.keys(b), ...Object.keys(a)])].map((k) => ({ field: k, before: show(b[k]), after: show(a[k]), changed: show(b[k]) !== show(a[k]) }));
}
function diffHtml(r) {
  const rows = diffRows(r.before, r.after);
  const changed = rows.filter((x) => x.changed);
  if (!changed.length) return `<p class="faint m-0">${te('admin.content_index.history.no_field_changes')}</p>`;
  return `<table class="table ci-diff" data-testid="ci-diff"><thead><tr><th>${te('admin.content_index.history.field')}</th><th>${te('admin.content_index.history.before')}</th><th>${te('admin.content_index.history.after')}</th></tr></thead>
    <tbody>${changed.map((x) => `<tr data-field="${esc(x.field)}"><td><code>${esc(fieldName(x.field))}</code></td><td class="ci-del" data-testid="ci-before">${esc(x.before)}</td><td class="ci-add" data-testid="ci-after">${esc(x.after)}</td></tr>`).join('')}</tbody></table>`;
}
async function history({ el, query, navigate }) {
  const type = query.get('type') || ''; const key = query.get('key') || '';
  const r = await get(`${API}/history?${qs({ type, key, limit: 100 })}`);
  el.innerHTML = `${type ? `<div class="adm-toolbar"><p><b>${esc(typeName(type))}</b> <code data-testid="ci-history-key">${esc(key)}</code></p><a class="btn btn-sm" href="/admin/content/history" data-link>${te('admin.content_index.history.all_changes')}</a></div>` : `<p class="muted">${te('admin.content_index.history.intro')}</p>`}
    <div class="ci-revs" data-testid="ci-history">${r.revisions.map((x, i) => `<section class="card adm-card ci-rev" data-testid="ci-rev" data-id="${esc(x.id)}" data-action="${esc(x.action)}" data-version="${esc(x.version)}" data-type="${esc(x.type)}" data-key="${esc(x.key)}">
      <div class="ci-rev-head"><span>${badge(actionName(x.action))} <b>${esc(typeName(x.type, x.type_label))}</b> <code>${esc(x.key)}</code> · ${te('admin.content_index.history.version', { version: esc(x.version) })}</span>
      <span class="faint">${esc(fmtTime(x.time))} · ${esc(x.actor || t('admin.content_index.history.system'))}</span></div>
      ${x.reason ? `<p class="faint m-0">${te('admin.content_index.history.reason', { reason: esc(x.reason) })}</p>` : ''}
      ${diffHtml(x)}
      <div class="adm-actions">${type ? '' : `<a class="btn btn-sm btn-ghost" href="/admin/content/history?${esc(qs({ type: x.type, key: x.key }))}" data-link>${te('admin.content_index.history.item_history')}</a>`}${x.restorable ? `<button class="btn btn-sm" type="button" data-restore="${i}" data-testid="ci-restore-version">${te('admin.content_index.history.restore')}</button>` : ''}</div></section>`).join('') || `<p class="faint">${te('admin.content_index.history.nothing')}</p>`}</div>`;
  for (const b of el.querySelectorAll('[data-restore]')) b.onclick = async () => {
    const x = r.revisions[Number(b.dataset.restore)];
    const ok = await confirmAction({ title: t('admin.content_index.history.restore_title', { version: x.version }), body: `${esc(typeName(x.type, x.type_label))} <code>${esc(x.key)}</code>`, confirm: t('admin.content_index.history.restore'), reason: true });
    if (!ok) return;
    try { await post(`${API}/history/restore`, { revision: x.id, reason: ok.reason }); toast(t('admin.content_index.history.restored')); await history({ el, query, navigate }); } catch (ex) { toast(ex.message, 'error'); }
  };
}

// ------------------------------------------------------------------ Trash
async function trash({ el }) {
  const r = await get(`${API}/trash`);
  const selected = new Set();
  el.innerHTML = `<p class="muted" data-testid="ci-trash-intro">${te('admin.content_index.trash.intro', { days: esc(r.retention_days) })}</p>
    <div class="ci-bulk"><span class="faint" data-selected>${te('admin.content_index.index.selected', { count: 0 })}</span>
      <button class="btn btn-sm" type="button" data-many="restore" data-testid="ci-trash-restore-selected" disabled>${te('admin.content_index.trash.restore')}</button>
      <button class="btn btn-sm btn-ghost btn-danger" type="button" data-many="purge" data-testid="ci-trash-purge-selected" disabled>${te('admin.content_index.trash.purge')}</button></div>
    <div data-result></div>
    <div class="adm-scroll"><table class="table adm-grid" data-testid="ci-trash"><thead><tr><th></th><th>${te('admin.content_index.index.title')}</th><th>${te('admin.content_index.index.type')}</th><th>${te('admin.content_index.index.key')}</th><th>${te('admin.content_index.trash.deleted')}</th><th>${te('admin.content_index.index.by')}</th><th>${te('admin.content_index.trash.reason')}</th><th>${te('admin.content_index.trash.purge_at')}</th><th></th></tr></thead>
    <tbody>${r.items.map((x, i) => `<tr data-testid="ci-trash-row" data-id="${esc(x.id)}" data-type="${esc(x.type)}" data-key="${esc(x.key)}">
      <td><input type="checkbox" data-sel="${i}" aria-label="${te('admin.content_index.index.select', { title: esc(x.title) })}"></td><td>${esc(x.title)}</td><td>${esc(typeName(x.type, x.type_label))}</td><td><code>${esc(x.key)}</code></td>
      <td>${esc(fmtTime(x.deleted_at))}</td><td class="faint">${esc(x.deleted_by || '')}</td><td>${esc(x.reason)}</td><td>${esc(fmtTime(x.purge_at))}</td>
      <td><span class="adm-actions">${x.can_restore ? `<button class="btn btn-sm" type="button" data-restore="${i}" data-testid="ci-trash-restore">${te('admin.content_index.trash.restore')}</button>` : ''}
        ${x.can_purge ? `<button class="btn btn-sm btn-ghost btn-danger" type="button" data-purge="${i}" data-testid="ci-trash-purge">${te('admin.content_index.trash.purge')}</button>${x.step_up ? ` ${badge(t('admin.content_index.trash.step_up'), 'warn')}` : ''}` : ''}</span></td></tr>`).join('') || `<tr><td colspan="9" class="faint adm-empty" data-testid="ci-trash-empty">${te('admin.content_index.trash.empty')}</td></tr>`}</tbody></table></div>`;
  const sync = () => { el.querySelector('[data-selected]').textContent = t('admin.content_index.index.selected', { count: selected.size }); for (const b of el.querySelectorAll('[data-many]')) b.disabled = !selected.size; };
  for (const c of el.querySelectorAll('[data-sel]')) c.onchange = () => { const id = r.items[Number(c.dataset.sel)].id; if (c.checked) selected.add(id); else selected.delete(id); sync(); };
  const run = async (action, ids) => {
    const purge = action === 'purge';
    const ok = await confirmAction({ title: purge ? t('admin.content_index.trash.purge_title', { count: ids.length }) : t('admin.content_index.trash.restore_title', { count: ids.length }), body: purge ? te('admin.content_index.trash.purge_body') : '', confirm: purge ? t('admin.content_index.trash.purge') : t('admin.content_index.trash.restore'), danger: purge, reason: true });
    if (!ok) return;
    try { const res = await post(`${API}/trash/${purge ? 'purge' : 'restore'}`, { ids, reason: ok.reason }); await trash({ el }); report(el.querySelector('[data-result]'), res.results); } catch (ex) { toast(ex.message, 'error'); }
  };
  for (const b of el.querySelectorAll('[data-restore]')) b.onclick = () => run('restore', [r.items[Number(b.dataset.restore)].id]);
  for (const b of el.querySelectorAll('[data-purge]')) b.onclick = () => run('purge', [r.items[Number(b.dataset.purge)].id]);
  for (const b of el.querySelectorAll('[data-many]')) b.onclick = () => run(b.dataset.many, [...selected]);
}
