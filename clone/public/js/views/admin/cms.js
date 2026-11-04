// Admin › Content & settings (CLONE_SPEC.md §32): the CMS hub and its editors. Editors (content.write) save drafts
// and preview them; publishers (content.publish) publish, schedule and roll back. Every publish asks for a reason;
// legal pages also ask for a fresh step-up (the API answers step_up_required and ui.js shows the modal).
//   /admin/cms            hub: counts, scheduled publishes, recent changes, links to the settings panels
//   /admin/cms/texts      text catalog: search, page (area) and section filters, per-key history, in-context preview
//   /admin/cms/templates  notification, email and SMS templates: fields, sample preview, test send
//   /admin/cms/media      uploads (PNG/JPEG, re-encoded by the server) and usage slots
//   /admin/cms/pages      pages (legal, help, info) with SEO fields, and the footer
//   /admin/cms/branding   brand / YES colours per theme with the contrast check, app name and short name
//   /admin/cms/transfer   JSON export, and import with a dry-run diff
import { t, te, ts } from '../../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../../content/admin.cms-strings.js';
import { get, post, put, del, esc, toast, section, subTabs, dialog, confirmAction, badge, fmtTime, fromLocalInput, download } from './ui.js';

const TABS = [['hub', ts('admin.cms.tabs.overview')], ['texts', ts('admin.cms.tabs.texts')], ['templates', ts('admin.cms.tabs.templates')], ['media', ts('admin.cms.tabs.media')], ['pages', ts('admin.cms.tabs.pages_footer')], ['branding', ts('admin.cms.tabs.branding')], ['transfer', ts('admin.cms.tabs.import_export')]];
const BASE = '/admin/cms';

export async function render({ el, parts, perms, query }) {
  const tab = parts[0] || 'hub';
  const canPublish = perms.has('content.publish');
  el.innerHTML = `${section(t('admin.cms.render.content_settings'), t('admin.cms.render.every_user_facing_text_template'), `<a class="btn btn-sm" href="/?cms_preview=1" target="_blank" rel="noopener" data-testid="cms-preview-site">${te('admin.cms.render.preview_site_with_drafts')}</a>`)}${subTabs(TABS, tab, BASE)}<div id="cms-body" data-testid="cms-${esc(tab)}"></div>`;
  const body = el.querySelector('#cms-body');
  const ctx = { el: body, canPublish, perms, query };
  if (tab === 'texts') return texts(ctx);
  if (tab === 'templates') return templates(ctx);
  if (tab === 'media') return mediaTab(ctx);
  if (tab === 'pages') return pages(ctx);
  if (tab === 'branding') return branding(ctx);
  if (tab === 'transfer') return transfer(ctx);
  return hub(ctx);
}

// ------------------------------------------------------------------ shared workflow
// Publish (or schedule) the draft of an entry: asks for the reason and an optional time.
async function publishFlow(type, key, { reset = false, label = '' } = {}) {
  const r = await confirmAction({
    title: reset ? t('admin.cms.publish_flow.reset_to_the_default') : t('admin.cms.publish_flow.publish'),
    body: esc(label || key),
    confirm: reset ? t('admin.cms.publish_flow.reset') : t('admin.cms.publish_flow.publish'),
    reason: true,
    extraHtml: reset ? '' : `<label class="field"><span>${te('admin.cms.publish_flow.publish_at_optional_leave_empty')}</span><input type="datetime-local" name="at" class="adm-input" data-testid="publish-at"></label>`,
  });
  if (!r) return null;
  const at = r.form.at && r.form.at.value ? fromLocalInput(r.form.at.value) : null;
  const res = await post(`/cms/${type}/publish`, { key, reason: r.reason, ...(at ? { at } : {}), ...(reset ? { reset: true } : {}) });
  toast(at ? t('admin.cms.publish_flow.scheduled') : reset ? t('admin.cms.publish_flow.reset_to_the_default') : t('admin.cms.publish_flow.published'));
  return res.entry;
}
async function rollbackFlow(type, key, version) {
  const r = await confirmAction({ title: version ? t('admin.cms.rollback_flow.roll_back_to_version', { version }) : t('admin.cms.rollback_flow.roll_back_to_the_default'), body: esc(key), confirm: t('admin.cms.rollback_flow.roll_back'), reason: true });
  if (!r) return null;
  const res = await post(`/cms/${type}/rollback`, { key, version, reason: r.reason });
  toast(t('admin.cms.rollback_flow.rolled_back'));
  return res.entry;
}
function historyHtml(versions) {
  if (!versions.length) return `<p class="faint">${te('admin.cms.history_html.no_published_versions_yet_the')}</p>`;
  return `<div class="adm-scroll"><table class="table adm-grid" data-testid="cms-history"><thead><tr><th>${te('admin.cms.history_html.version')}</th><th>${te('admin.cms.history_html.action')}</th><th>${te('admin.cms.history_html.by')}</th><th>${te('admin.cms.history_html.when')}</th><th>${te('admin.cms.history_html.reason')}</th><th></th></tr></thead><tbody>${versions.map((v) => `<tr><td>${esc(v.version)}</td><td>${esc(v.action)}</td><td>${esc(v.author || '')}</td><td>${esc(fmtTime(v.time))}</td><td>${esc(v.reason)}</td><td><button class="btn btn-sm" data-rollback="${esc(v.version)}" data-testid="cms-rollback-${esc(v.version)}">${te('admin.cms.history_html.restore')}</button></td></tr>`).join('')}<tr><td>0</td><td colspan="4" class="faint">${te('admin.cms.history_html.code_default')}</td><td><button class="btn btn-sm" data-rollback="0" data-testid="cms-rollback-0">${te('admin.cms.history_html.restore')}</button></td></tr></tbody></table></div>`;
}
function stateBadges(e) {
  return [e.published != null ? badge('custom', 'ok') : badge('default'), e.draft != null ? badge('draft', 'warn') : '', e.scheduled ? badge(`scheduled ${fmtTime(e.scheduled.at)}`, 'warn') : ''].join(' ');
}
function fieldErrors(form, ex) {
  for (const n of form.querySelectorAll('[data-err-for]')) n.textContent = '';
  const box = form.querySelector('[data-form-error]');
  if (box) box.textContent = ex.message;
  if (ex.fields) for (const [k, v] of Object.entries(ex.fields)) { const n = form.querySelector(`[data-err-for="${CSS.escape(k)}"]`); if (n) n.textContent = v; }
}

// ------------------------------------------------------------------ hub
async function hub({ el, perms }) {
  const o = await get('/cms/overview');
  const link = (href, title, sub, perm) => (perm && !perms.has(perm) ? '' : `<a class="card cms-hub-card" href="${esc(href)}" data-link><b>${esc(title)}</b><span class="faint">${esc(sub)}</span></a>`);
  el.innerHTML = `<div class="cms-hub" data-testid="cms-hub">
    ${link(`${BASE}/texts`, t('admin.cms.hub.texts'), `${o.counts.texts} keys · ${o.counts.text_overrides} customised`)}
    ${link(`${BASE}/templates`, t('admin.cms.hub.notification_email_templates'), `${o.counts.templates} templates`)}
    ${link(`${BASE}/media`, t('admin.cms.hub.media_library'), `${o.counts.media} images`)}
    ${link(`${BASE}/pages`, t('admin.cms.hub.pages_footer'), `${o.counts.pages} pages`)}
    ${link(`${BASE}/branding`, t('admin.cms.hub.branding'), t('admin.cms.hub.colours_logo_app_name'))}
    ${link(`${BASE}/transfer`, t('admin.cms.hub.import_export'), t('admin.cms.hub.json_backup_of_all_content'))}
    ${link('/admin/settings', t('admin.cms.hub.fees_limits_features'), t('admin.cms.hub.settings_health'), 'settings.write')}
    ${link('/admin/settings', t('admin.cms.hub.currency_defaults'), t('admin.cms.hub.display_currency_locale_new_account'), 'settings.write')}
    ${link('/admin/payments', t('admin.cms.hub.payments'), t('admin.cms.hub.rails_limits_and_providers'), 'users.read')}
    ${link('/admin/content', t('admin.cms.hub.home_banners_navigation'), t('admin.cms.hub.hero_promos_info_cards_news'), 'content.write')}
  </div>
  <h3 class="mt-16">${te('admin.cms.hub.scheduled')}</h3>${o.scheduled.length ? `<ul class="cms-list" data-testid="cms-scheduled">${o.scheduled.map((s) => `<li>${esc(s.type)} · <code>${esc(s.key)}</code> ${te('admin.cms.hub.at_by', { fmt_time: esc(fmtTime(s.at)), value: esc(s.by || '') })}</li>`).join('')}</ul>` : `<p class="faint">${te('admin.cms.hub.nothing_is_scheduled')}</p>`}
  <h3 class="mt-16">${te('admin.cms.hub.recent_changes')}</h3>${o.recent.length ? `<ul class="cms-list">${o.recent.map((r) => `<li>${esc(r.action)} · ${esc(r.type)} <code>${esc(r.key)}</code> ${te('admin.cms.hub.v_by', { version: esc(r.version), value: esc(r.author_email || ''), reason: esc(r.reason) })}</li>`).join('')}</ul>` : `<p class="faint">${te('admin.cms.hub.no_changes_yet')}</p>`}
  ${o.can_publish ? '' : `<p class="faint" data-testid="cms-editor-note">${te('admin.cms.hub.you_can_save_drafts_and')}</p>`}`;
}

// ------------------------------------------------------------------ texts
async function texts({ el, canPublish, query }) {
  const st = { q: query.get('q') || '', area: query.get('area') || '', section: '', state: '', offset: 0 };
  el.innerHTML = `<div class="adm-table-tools cms-filters"><input type="search" class="adm-input" placeholder="${te('admin.cms.texts.search_keys_and_text')}" aria-label="${te('admin.cms.texts.search_texts')}" data-testid="cms-text-search" value="${esc(st.q)}">
    <select class="adm-input" aria-label="${te('admin.cms.texts.page')}" data-testid="cms-text-area"><option value="">${te('admin.cms.texts.all_pages')}</option></select>
    <select class="adm-input" aria-label="${te('admin.cms.texts.section')}" data-testid="cms-text-section"><option value="">${te('admin.cms.texts.all_sections')}</option></select>
    <select class="adm-input" aria-label="${te('admin.cms.texts.state')}" data-testid="cms-text-state"><option value="">${te('admin.cms.texts.any_state')}</option><option value="overridden">${te('admin.cms.texts.customised')}</option><option value="draft">${te('admin.cms.texts.has_a_draft')}</option><option value="scheduled">${te('admin.cms.texts.scheduled')}</option></select></div>
    <div id="cms-text-list"></div>`;
  const [qi, ai, si, sti] = ['search', 'area', 'section', 'state'].map((k) => el.querySelector(`[data-testid=cms-text-${k}]`));
  const list = el.querySelector('#cms-text-list');
  async function load() {
    const p = new URLSearchParams({ q: st.q, area: st.area, section: st.section, state: st.state, offset: String(st.offset), limit: '50' });
    const r = await get(`/cms/texts?${p}`);
    if (ai.options.length <= 1) ai.insertAdjacentHTML('beforeend', r.areas.map((a) => `<option value="${esc(a.name)}">${esc(a.name)} (${esc(a.count)})</option>`).join(''));
    ai.value = st.area;
    si.innerHTML = `<option value="">${te('admin.cms.texts.all_sections')}</option>${r.sections.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}`;
    si.value = st.section;
    list.innerHTML = `<p class="faint">${te('admin.cms.texts.keys', { total: esc(r.total) })}</p><div class="adm-scroll"><table class="table adm-grid" data-testid="cms-text-table"><thead><tr><th>${te('admin.cms.texts.key')}</th><th>${te('admin.cms.texts.text')}</th><th>${te('admin.cms.texts.state')}</th></tr></thead><tbody>${r.items.map((x) => `<tr data-key="${esc(x.key)}" data-testid="cms-text-row" class="cms-row"><td><code>${esc(x.key)}</code></td><td>${esc(x.draft ?? x.published ?? x.default)}</td><td>${stateBadges(x)}</td></tr>`).join('')}</tbody></table></div>
      <div class="adm-pager"><button class="btn btn-sm" data-prev ${st.offset ? '' : 'disabled'}>${te('admin.cms.texts.prev')}</button><button class="btn btn-sm" data-next ${st.offset + 50 < r.total ? '' : 'disabled'}>${te('admin.cms.texts.next')}</button></div>`;
    list.querySelector('[data-prev]').onclick = () => { st.offset = Math.max(0, st.offset - 50); load(); };
    list.querySelector('[data-next]').onclick = () => { st.offset += 50; load(); };
    for (const tr of list.querySelectorAll('[data-key]')) tr.onclick = () => textEditor(tr.dataset.key, canPublish, load);
  }
  let timer = null;
  qi.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { st.q = qi.value; st.offset = 0; load(); }, 250); };
  ai.onchange = () => { st.area = ai.value; st.section = ''; st.offset = 0; load(); };
  si.onchange = () => { st.section = si.value; st.offset = 0; load(); };
  sti.onchange = () => { st.state = sti.value; st.offset = 0; load(); };
  await load();
}
async function textEditor(key, canPublish, reload) {
  const r = await get(`/cms/text/entry?key=${encodeURIComponent(key)}`);
  const c = r.catalog; const e = r.entry;
  const value = e.draft ?? e.published ?? c.default;
  const preview = `${(c.area.startsWith('admin') ? '/admin' : '/')}?cms_preview=1`;
  const d = dialog(`<form class="cms-editor" data-testid="cms-text-editor"><h3><code>${esc(key)}</code></h3>
    <p class="faint">${te('admin.cms.text_editor.page')} <b>${esc(c.area)}</b> ${te('admin.cms.text_editor.section')} <b>${esc(c.section)}</b> · ${c.rich ? te('admin.cms.text_editor.rich_text_bold_italic_lists') : te('admin.cms.text_editor.plain_text')}${c.vars.length ? (' ' + te('admin.cms.text_editor.variables', { value: c.vars.map((v) => `<code>{${esc(v)}}</code>`).join(' ') })) : (' ' + te('admin.cms.text_editor.no_variables'))}</p>
    <label class="field"><span>${te('admin.cms.text_editor.default_in_code')}</span><textarea rows="2" readonly class="adm-input">${esc(c.default)}</textarea></label>
    <label class="field"><span>${te('admin.cms.text_editor.text')}</span><textarea name="value" rows="4" class="adm-input" data-testid="cms-text-value">${esc(value)}</textarea><small class="adm-err" data-err-for="value" role="alert"></small></label>
    <p class="form-error" data-form-error role="alert"></p>
    <div class="adm-form-actions"><button class="btn" type="button" data-close>${te('admin.cms.text_editor.close')}</button><a class="btn" href="${esc(preview)}" target="_blank" rel="noopener" data-testid="cms-text-preview">${te('admin.cms.text_editor.preview_in_context')}</a>
      ${e.draft != null ? `<button class="btn" type="button" data-discard>${te('admin.cms.text_editor.discard_draft')}</button>` : ''}<button class="btn" type="submit" data-testid="cms-save-draft">${te('admin.cms.text_editor.save_draft')}</button>
      ${canPublish ? `<button class="btn btn-primary" type="button" data-publish data-testid="cms-publish">${te('admin.cms.text_editor.publish')}</button>` : ''}</div>
    <h4 class="mt-16">${te('admin.cms.text_editor.history')}</h4>${historyHtml(r.versions)}</form>`, { wide: true, testid: 'cms-dialog' });
  const f = d.querySelector('form');
  const save = async () => { try { await put('/cms/text/draft', { key, value: f.value.value }); toast(t('admin.cms.text_editor.draft_saved')); return true; } catch (ex) { fieldErrors(f, ex); return false; } };
  f.onsubmit = async (ev) => { ev.preventDefault(); if (await save()) { reload(); } };
  d.querySelector('[data-close]').onclick = () => d.close();
  d.querySelector('[data-discard]')?.addEventListener('click', async () => { await del(`/cms/text/draft?key=${encodeURIComponent(key)}`); toast(t('admin.cms.text_editor.draft_discarded')); d.close(); reload(); });
  d.querySelector('[data-publish]')?.addEventListener('click', async () => {
    if (f.value.value !== (e.published ?? c.default) && !(await save())) return;
    try { if (await publishFlow('text', key)) { d.close(); reload(); } } catch (ex) { fieldErrors(f, ex); }
  });
  for (const b of d.querySelectorAll('[data-rollback]')) b.onclick = async () => { try { if (await rollbackFlow('text', key, Number(b.dataset.rollback))) { d.close(); reload(); } } catch (ex) { fieldErrors(f, ex); } };
}

// ------------------------------------------------------------------ templates
async function templates({ el, canPublish }) {
  const r = await get('/cms/templates');
  const groups = [...new Set(r.templates.map((x) => x.group))];
  el.innerHTML = groups.map((g) => `<h3 class="mt-16">${esc(g)}</h3><div class="adm-scroll"><table class="table adm-grid"><tbody>${r.templates.filter((x) => x.group === g).map((x) => `<tr class="cms-row" data-tpl="${esc(x.key)}" data-testid="cms-template-row"><td><code>${esc(x.key)}</code></td><td>${esc(x.label)}</td><td>${stateBadges(x)}</td></tr>`).join('')}</tbody></table></div>`).join('');
  for (const tr of el.querySelectorAll('[data-tpl]')) tr.onclick = () => templateEditor(tr.dataset.tpl, canPublish, () => templates({ el, canPublish }));
}
async function templateEditor(key, canPublish, reload) {
  const r = await get(`/cms/template/entry?key=${encodeURIComponent(key)}`);
  const d0 = r.definition; const e = r.entry;
  const cur = { ...d0.defaults, ...(e.published || {}), ...(e.draft || {}) };
  const d = dialog(`<form class="cms-editor" data-testid="cms-template-editor"><h3>${esc(d0.label)} <code>${esc(key)}</code></h3>
    <p class="faint">${te('admin.cms.template_editor.logic_free_only')} <code>{{variable}}</code> ${te('admin.cms.template_editor.placeholders_variables_email_html_is', { value: d0.vars.map((v) => `<code>{{${esc(v)}}}</code>`).join(' ') })}</p>
    ${d0.fields.map((f) => `<label class="field"><span>${esc(f)}</span><textarea name="${esc(f)}" rows="${f.endsWith('html') || f === 'email_text' ? 5 : 2}" class="adm-input" data-testid="cms-tpl-${esc(f)}">${esc(cur[f] || '')}</textarea><small class="adm-err" data-err-for="${esc(f)}" role="alert"></small></label>`).join('')}
    <p class="form-error" data-form-error role="alert"></p>
    <div class="adm-form-actions"><button class="btn" type="button" data-close>${te('admin.cms.template_editor.close')}</button><button class="btn" type="button" data-preview data-testid="cms-tpl-preview">${te('admin.cms.template_editor.preview_with_sample_data')}</button>
      <button class="btn" type="button" data-test data-testid="cms-tpl-test-send">${te('admin.cms.template_editor.send_a_test_to_me')}</button><button class="btn" type="submit" data-testid="cms-save-draft">${te('admin.cms.template_editor.save_draft')}</button>
      ${canPublish ? `<button class="btn btn-primary" type="button" data-publish data-testid="cms-publish">${te('admin.cms.template_editor.publish')}</button>` : ''}</div>
    <div class="cms-preview" data-testid="cms-tpl-preview-out"></div>
    <h4 class="mt-16">${te('admin.cms.template_editor.history')}</h4>${historyHtml(r.versions)}</form>`, { wide: true, testid: 'cms-dialog' });
  const f = d.querySelector('form');
  const value = () => Object.fromEntries(d0.fields.map((x) => [x, f[x].value]));
  const save = async () => { try { await put('/cms/template/draft', { key, value: value() }); toast(t('admin.cms.template_editor.draft_saved')); return true; } catch (ex) { fieldErrors(f, ex); return false; } };
  f.onsubmit = async (ev) => { ev.preventDefault(); if (await save()) reload(); };
  d.querySelector('[data-close]').onclick = () => d.close();
  d.querySelector('[data-preview]').onclick = async () => {
    try {
      const p = (await post('/cms/templates/preview', { key, value: value() })).preview;
      const out = d.querySelector('.cms-preview');
      out.innerHTML = `${p.email ? `<p><b>${te('admin.cms.template_editor.subject')}</b> ${esc(p.email.subject)}</p><pre class="cms-pre" data-testid="cms-tpl-preview-text">${esc(p.email.text)}</pre><p class="faint">${te('admin.cms.template_editor.html_version_as_sent_shown')}</p><pre class="cms-pre">${esc(p.email.html)}</pre>` : ''}${Object.entries(p).filter(([k]) => k !== 'email').map(([k, v]) => `<p><b>${esc(k)}:</b> <span data-testid="cms-tpl-preview-${esc(k)}">${esc(v)}</span></p>`).join('')}`;
    } catch (ex) { fieldErrors(f, ex); }
  };
  d.querySelector('[data-test]').onclick = async () => { try { const s = await post('/cms/templates/test_send', { key, value: value() }); toast(t('admin.cms.template_editor.test_sent', { value: s.sent.join(', ') })); } catch (ex) { fieldErrors(f, ex); } };
  d.querySelector('[data-publish]')?.addEventListener('click', async () => { if (!(await save())) return; try { if (await publishFlow('template', key, { label: d0.label })) { d.close(); reload(); } } catch (ex) { fieldErrors(f, ex); } });
  for (const b of d.querySelectorAll('[data-rollback]')) b.onclick = async () => { try { if (await rollbackFlow('template', key, Number(b.dataset.rollback))) { d.close(); reload(); } } catch (ex) { fieldErrors(f, ex); } };
}

// ------------------------------------------------------------------ media
async function mediaTab({ el, canPublish }) {
  const r = await get('/cms/media');
  el.innerHTML = `<form class="cms-upload" data-testid="cms-upload-form"><label class="field"><span>${te('admin.cms.media_tab.upload_an_image_png_or')}</span><input type="file" name="file" accept="image/png,image/jpeg" data-testid="cms-upload-file"></label><p class="form-error" data-form-error role="alert" data-testid="cms-upload-error"></p></form>
    <div class="cms-assets" data-testid="cms-assets">${r.assets.map((a) => `<figure class="card cms-asset" data-asset="${esc(a.id)}"><img src="${esc(a.url)}" alt="" width="96" height="96" class="cms-thumb"><figcaption class="faint">${esc(a.original_name || a.id)} · ${esc(a.width)}×${esc(a.height)}</figcaption></figure>`).join('') || `<p class="faint">${te('admin.cms.media_tab.no_uploads_yet')}</p>`}</div>
    <h3 class="mt-16">${te('admin.cms.media_tab.usage_slots')}</h3><div class="adm-scroll"><table class="table adm-grid" data-testid="cms-slots"><thead><tr><th>${te('admin.cms.media_tab.slot')}</th><th>${te('admin.cms.media_tab.image')}</th><th>${te('admin.cms.media_tab.assign')}</th><th></th></tr></thead><tbody>${r.slots.map((s) => `<tr data-slot="${esc(s.key)}"><td>${esc(s.label)} <code>${esc(s.key)}</code>${s.square ? ` <span class="faint">${te('admin.cms.media_tab.square')}</span>` : ''}</td><td>${s.url ? `<img src="${esc(s.url)}" alt="" width="48" height="48" class="cms-thumb">` : `<span class="faint">${te('admin.cms.media_tab.built_in')}</span>`} ${s.draft ? badge('draft', 'warn') : ''}</td>
      <td><select class="adm-input" aria-label="${te('admin.cms.media_tab.image')}" data-slot-asset><option value="">${te('admin.cms.media_tab.choose_an_upload')}</option>${r.assets.map((a) => `<option value="${esc(a.id)}" ${s.draft?.asset_id === a.id ? 'selected' : ''}>${esc(a.original_name || a.id)} (${esc(a.width)}×${esc(a.height)})</option>`).join('')}</select><small class="adm-err" role="alert" data-slot-err></small></td>
      <td><button class="btn btn-sm" data-slot-save data-testid="cms-slot-save-${esc(s.key)}">${te('admin.cms.media_tab.save_draft')}</button>${canPublish ? ` <button class="btn btn-sm btn-primary" data-slot-publish data-testid="cms-slot-publish-${esc(s.key)}">${te('admin.cms.media_tab.publish')}</button>` : ''}${s.published && canPublish ? ` <button class="btn btn-sm" data-slot-reset>${te('admin.cms.media_tab.use_built_in')}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  const form = el.querySelector('[data-testid=cms-upload-form]');
  form.file.onchange = () => {
    const file = form.file.files[0];
    if (!file) return;
    const rd = new FileReader();
    rd.onload = async () => {
      try { await post('/cms/media', { filename: file.name, data: String(rd.result) }); toast(t('admin.cms.media_tab.uploaded')); mediaTab({ el, canPublish }); } catch (ex) { form.querySelector('[data-form-error]').textContent = ex.message; }
    };
    rd.readAsDataURL(file);
  };
  for (const tr of el.querySelectorAll('[data-slot]')) {
    const slot = tr.dataset.slot; const sel = tr.querySelector('[data-slot-asset]'); const err = tr.querySelector('[data-slot-err]');
    const save = async () => { err.textContent = ''; try { await put('/cms/media/draft', { key: slot, value: { asset_id: sel.value, alt: '' } }); return true; } catch (ex) { err.textContent = ex.fields ? Object.values(ex.fields).join(' ') : ex.message; return false; } };
    tr.querySelector('[data-slot-save]').onclick = async () => { if (await save()) { toast(t('admin.cms.media_tab.draft_saved')); mediaTab({ el, canPublish }); } };
    tr.querySelector('[data-slot-publish]')?.addEventListener('click', async () => { if (sel.value && !(await save())) return; try { if (await publishFlow('media', slot)) mediaTab({ el, canPublish }); } catch (ex) { err.textContent = ex.message; } });
    tr.querySelector('[data-slot-reset]')?.addEventListener('click', async () => { try { if (await publishFlow('media', slot, { reset: true })) mediaTab({ el, canPublish }); } catch (ex) { err.textContent = ex.message; } });
  }
}

// ------------------------------------------------------------------ pages + footer
const footerToText = (f) => f.columns.map((c) => [c.title, ...c.links.map((l) => `- ${l.label} | ${l.href}`)].join('\n')).join('\n\n');
function footerFromText(s) {
  const columns = [];
  for (const line of String(s).split('\n').map((x) => x.trim()).filter(Boolean)) {
    if (line.startsWith('-')) { const [label, href] = line.slice(1).split('|').map((x) => x.trim()); if (columns.length) columns[columns.length - 1].links.push({ label, href: href || '' }); } else columns.push({ title: line, links: [] });
  }
  return columns;
}
async function pages({ el, canPublish }) {
  const r = await get('/cms/pages');
  el.innerHTML = `<div class="adm-head-actions mb-8"><button class="btn btn-sm" data-new-page data-testid="cms-new-page">${te('admin.cms.pages.new_page')}</button></div>
    <div class="adm-scroll"><table class="table adm-grid" data-testid="cms-pages"><thead><tr><th>${te('admin.cms.pages.slug')}</th><th>${te('admin.cms.pages.title')}</th><th>${te('admin.cms.pages.section')}</th><th>${te('admin.cms.pages.state')}</th></tr></thead><tbody>${r.pages.map((p) => `<tr class="cms-row" data-page="${esc(p.slug)}" data-testid="cms-page-row"><td><code>${esc(p.slug)}</code></td><td>${esc(p.effective?.title || p.draft?.title || '')}</td><td>${esc(p.effective?.section || p.draft?.section || '')}${p.legal ? ` ${badge('legal')}` : ''}</td><td>${p.effective?.customised ? badge('custom', 'ok') : badge('default')} ${p.draft ? badge('draft', 'warn') : ''} ${p.scheduled ? badge(`scheduled ${fmtTime(p.scheduled.at)}`, 'warn') : ''}</td></tr>`).join('')}</tbody></table></div>
    <h3 class="mt-16">${te('admin.cms.pages.footer')}</h3><form class="cms-editor" data-testid="cms-footer-form"><label class="field"><span>${te('admin.cms.pages.tagline')}</span><input name="tagline" class="adm-input" value="${esc((r.footer.draft || r.footer.effective).tagline)}"></label>
      <label class="field"><span>${te('admin.cms.pages.columns_a_title_line_then')}</span><textarea name="columns" rows="10" class="adm-input" data-testid="cms-footer-columns">${esc(footerToText(r.footer.draft || r.footer.effective))}</textarea></label>
      <p class="form-error" data-form-error role="alert"></p><div class="adm-form-actions"><button class="btn" type="submit" data-testid="cms-footer-save">${te('admin.cms.pages.save_draft')}</button>${canPublish ? `<button class="btn btn-primary" type="button" data-publish data-testid="cms-footer-publish">${te('admin.cms.pages.publish')}</button>` : ''}</div></form>`;
  const reload = () => pages({ el, canPublish });
  for (const tr of el.querySelectorAll('[data-page]')) tr.onclick = () => pageEditor(tr.dataset.page, canPublish, reload);
  el.querySelector('[data-new-page]').onclick = () => pageEditor(null, canPublish, reload);
  const ff = el.querySelector('[data-testid=cms-footer-form]');
  const saveFooter = async () => { try { await put('/cms/footer/draft', { key: 'links', value: { tagline: ff.tagline.value, columns: footerFromText(ff.columns.value) } }); toast(t('admin.cms.pages.draft_saved')); return true; } catch (ex) { fieldErrors(ff, ex); return false; } };
  ff.onsubmit = async (ev) => { ev.preventDefault(); await saveFooter(); };
  ff.querySelector('[data-publish]')?.addEventListener('click', async () => { if (!(await saveFooter())) return; try { if (await publishFlow('footer', 'links', { label: t('admin.cms.pages.footer') })) reload(); } catch (ex) { fieldErrors(ff, ex); } });
}
async function pageEditor(slug, canPublish, reload) {
  const r = slug ? await get(`/cms/page/entry?key=${encodeURIComponent(slug)}`) : { entry: {}, versions: [], default: null };
  const e = r.entry;
  const p = e.draft || e.published || r.default || { title: '', body: '', seo_title: '', seo_description: '', section: 'info' };
  const d = dialog(`<form class="cms-editor" data-testid="cms-page-editor"><h3>${slug ? `<code>${esc(slug)}</code>` : te('admin.cms.page_editor.new_page')}</h3>
    ${slug ? '' : `<label class="field"><span>${te('admin.cms.page_editor.slug_group_slug_e_g')}</span><input name="slug" class="adm-input" data-testid="cms-page-slug" required><small class="adm-err" data-err-for="key" role="alert"></small></label>`}
    <label class="field"><span>${te('admin.cms.page_editor.title')}</span><input name="title" class="adm-input" value="${esc(p.title)}" data-testid="cms-page-title"><small class="adm-err" data-err-for="title" role="alert"></small></label>
    <label class="field"><span>${te('admin.cms.page_editor.section')}</span><select name="section" class="adm-input" data-testid="cms-page-section">${['info', 'help', 'legal'].map((s) => `<option value="${esc(s)}" ${p.section === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
    <label class="field"><span>${te('admin.cms.page_editor.seo_title')}</span><input name="seo_title" class="adm-input" value="${esc(p.seo_title || '')}" data-testid="cms-page-seo-title"></label>
    <label class="field"><span>${te('admin.cms.page_editor.seo_description')}</span><input name="seo_description" class="adm-input" value="${esc(p.seo_description || '')}" data-testid="cms-page-seo-description"></label>
    <label class="field"><span>${te('admin.cms.page_editor.body_headings_paragraphs_lists_bold')}</span><textarea name="body" rows="10" class="adm-input" data-testid="cms-page-body">${esc(p.body || '')}</textarea><small class="adm-err" data-err-for="body" role="alert"></small></label>
    <p class="form-error" data-form-error role="alert"></p>
    <div class="adm-form-actions"><button class="btn" type="button" data-close>${te('admin.cms.page_editor.close')}</button>${slug ? `<a class="btn" href="/${esc(slug)}?cms_preview=1" target="_blank" rel="noopener">${te('admin.cms.page_editor.preview')}</a>` : ''}<button class="btn" type="submit" data-testid="cms-save-draft">${te('admin.cms.page_editor.save_draft')}</button>
      ${canPublish ? `<button class="btn btn-primary" type="button" data-publish data-testid="cms-publish">${te('admin.cms.page_editor.publish')}</button>` : ''}</div>
    ${slug ? `<h4 class="mt-16">${te('admin.cms.page_editor.history')}</h4>${historyHtml(r.versions)}` : ''}</form>`, { wide: true, testid: 'cms-dialog' });
  const f = d.querySelector('form');
  const key = () => slug || f.slug.value.trim();
  const save = async () => { try { await put('/cms/page/draft', { key: key(), value: { title: f.title.value, section: f.section.value, seo_title: f.seo_title.value, seo_description: f.seo_description.value, body: f.body.value } }); toast(t('admin.cms.page_editor.draft_saved')); return true; } catch (ex) { fieldErrors(f, ex); return false; } };
  f.onsubmit = async (ev) => { ev.preventDefault(); if (await save()) { d.close(); reload(); } };
  d.querySelector('[data-close]').onclick = () => d.close();
  d.querySelector('[data-publish]')?.addEventListener('click', async () => { if (!(await save())) return; try { if (await publishFlow('page', key())) { d.close(); reload(); } } catch (ex) { fieldErrors(f, ex); } });
  for (const b of d.querySelectorAll('[data-rollback]')) b.onclick = async () => { try { if (await rollbackFlow('page', key(), Number(b.dataset.rollback))) { d.close(); reload(); } } catch (ex) { fieldErrors(f, ex); } };
}

// ------------------------------------------------------------------ branding
const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { if (!/^#[0-9a-f]{6}$/i.test(a)) return 0; const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const SURF = { light: '#ffffff', dark: '#0d0e11' };
async function branding({ el, canPublish }) {
  const r = await get('/cms/brand/entry?key=theme');
  const def = r.defaults; // the code defaults come from the server (server/cms/index.js BRAND_DEFAULT)
  const b = { ...def, ...(r.entry.published || {}), ...(r.entry.draft || {}) };
  const colour = (theme, tok) => `<label class="field cms-colour"><span>${esc(theme)} · ${tok === 'brand' ? 'brand' : te('admin.cms.branding.yes')}</span><span class="d-flex gap-8 ai-center"><input type="text" class="adm-input" name="${esc(theme)}_${esc(tok)}" value="${esc(b[theme][tok])}" data-testid="cms-brand-${esc(theme)}-${esc(tok)}" pattern="#[0-9a-fA-F]{6}"><span class="faint" data-ratio="${esc(theme)}_${esc(tok)}"></span></span><small class="adm-err" data-err-for="${esc(theme)}.${esc(tok)}" role="alert"></small></label>`;
  el.innerHTML = `<form class="cms-editor" data-testid="cms-brand-form"><p class="muted">${te('admin.cms.branding.colours_are_checked_against_each')}</p>
    <div class="cms-colours">${colour('light', 'brand')}${colour('light', 'yes')}${colour('dark', 'brand')}${colour('dark', 'yes')}</div>
    <label class="field"><span>${te('admin.cms.branding.app_name_manifest_page_title')}</span><input name="app_name" class="adm-input" value="${esc(b.app_name)}" data-testid="cms-brand-app-name"><small class="adm-err" data-err-for="app_name" role="alert"></small></label>
    <label class="field"><span>${te('admin.cms.branding.short_name_home_screen')}</span><input name="short_name" class="adm-input" value="${esc(b.short_name)}" data-testid="cms-brand-short-name"><small class="adm-err" data-err-for="short_name" role="alert"></small></label>
    <label class="field"><span>${te('admin.cms.branding.description')}</span><input name="description" class="adm-input" value="${esc(b.description)}"></label>
    <p class="faint">${te('admin.cms.branding.the_logo_favicon_and_app')} <a href="${BASE}/media" data-link>${te('admin.cms.branding.media_library')}</a>.</p>
    <p class="form-error" data-form-error role="alert" data-testid="cms-brand-error"></p>
    <div class="adm-form-actions"><button class="btn" type="submit" data-testid="cms-brand-save">${te('admin.cms.branding.save_draft')}</button>${canPublish ? `<button class="btn btn-primary" type="button" data-publish data-testid="cms-brand-publish">${te('admin.cms.branding.publish')}</button>` : ''}</div>
    <h4 class="mt-16">${te('admin.cms.branding.history')}</h4>${historyHtml(r.versions)}</form>`;
  const f = el.querySelector('form');
  const sync = () => { for (const n of f.querySelectorAll('[data-ratio]')) { const [theme] = n.dataset.ratio.split('_'); const v = ratio(f[n.dataset.ratio].value.trim(), SURF[theme]); n.textContent = `${v.toFixed(2)}:1 ${v >= 4.5 ? '✓' : '✗'}`; } };
  f.addEventListener('input', sync); sync();
  const value = () => ({ light: { brand: f.light_brand.value.trim(), yes: f.light_yes.value.trim() }, dark: { brand: f.dark_brand.value.trim(), yes: f.dark_yes.value.trim() }, app_name: f.app_name.value, short_name: f.short_name.value, description: f.description.value });
  const save = async () => { try { await put('/cms/brand/draft', { key: 'theme', value: value() }); toast(t('admin.cms.branding.draft_saved')); return true; } catch (ex) { fieldErrors(f, ex); return false; } };
  f.onsubmit = async (ev) => { ev.preventDefault(); await save(); };
  f.querySelector('[data-publish]')?.addEventListener('click', async () => { if (!(await save())) return; try { if (await publishFlow('brand', 'theme', { label: t('admin.cms.branding.branding') })) branding({ el, canPublish }); } catch (ex) { fieldErrors(f, ex); } });
  for (const btn of f.querySelectorAll('[data-rollback]')) btn.onclick = async (ev) => { ev.preventDefault(); try { if (await rollbackFlow('brand', 'theme', Number(btn.dataset.rollback))) branding({ el, canPublish }); } catch (ex) { fieldErrors(f, ex); } };
}

// ------------------------------------------------------------------ import / export
async function transfer({ el, canPublish }) {
  el.innerHTML = `<div class="adm-head-actions mb-8"><button class="btn" data-export data-testid="cms-export">${te('admin.cms.transfer.download_export_json')}</button></div>
    <form class="cms-editor" data-testid="cms-import-form"><label class="field"><span>${te('admin.cms.transfer.import_file')}</span><input type="file" name="file" accept="application/json,.json" data-testid="cms-import-file"></label>
      <p class="faint">${te('admin.cms.transfer.the_import_is_checked_first')}</p><p class="form-error" data-form-error role="alert"></p>
      <div data-testid="cms-import-diff"></div>
      <div class="adm-form-actions">${canPublish ? `<button class="btn btn-primary" type="button" data-apply disabled data-testid="cms-import-apply">${te('admin.cms.transfer.apply')}</button>` : ''}</div></form>`;
  el.querySelector('[data-export]').onclick = async () => { const data = await get('/cms/export'); download(`parlance-content-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json'); };
  const f = el.querySelector('form'); let data = null;
  const out = el.querySelector('[data-testid=cms-import-diff]');
  f.file.onchange = () => {
    const file = f.file.files[0]; if (!file) return;
    const rd = new FileReader();
    rd.onload = async () => {
      try {
        data = JSON.parse(String(rd.result));
        const r = await post('/cms/import', { data, dry_run: true });
        out.innerHTML = `<p data-testid="cms-import-summary">${te('admin.cms.transfer.change_s', { changes: esc(r.changes) })}</p><table class="table adm-grid"><thead><tr><th>${te('admin.cms.transfer.type')}</th><th>${te('admin.cms.transfer.key')}</th><th>${te('admin.cms.transfer.change')}</th></tr></thead><tbody>${r.diff.map((x) => `<tr data-testid="cms-import-row"><td>${esc(x.type)}</td><td><code>${esc(x.key)}</code></td><td>${esc(x.change)}</td></tr>`).join('')}</tbody></table>`;
        const ap = f.querySelector('[data-apply]'); if (ap) ap.disabled = !r.changes;
      } catch (ex) { f.querySelector('[data-form-error]').textContent = ex.fields ? JSON.stringify(ex.fields) : ex.message; }
    };
    rd.readAsText(file);
  };
  f.querySelector('[data-apply]')?.addEventListener('click', async () => {
    const r = await confirmAction({ title: t('admin.cms.transfer.apply_the_import'), body: t('admin.cms.transfer.each_changed_entry_is_published'), confirm: t('admin.cms.transfer.apply_2'), reason: true });
    if (!r) return;
    try { const res = await post('/cms/import', { data, dry_run: false, reason: r.reason }); toast(t('admin.cms.transfer.imported_change_s', { changes: res.changes })); out.innerHTML = ''; } catch (ex) { f.querySelector('[data-form-error]').textContent = ex.message; }
  });
}
