// Admin › Content › Languages (PLAN P8.4, CLONE_SPEC.md §38.5): every language with its coverage (published translations
// of the text catalog), review state and switch; a translation editor per language (English beside it, drafts, publish,
// per-key review), "publish all drafts", JSON export / import for translators, and adding a language as data.
// Switching a language on needs content.publish, a reason, a step-up, a "reviewed" mark and the minimum coverage (owner
// setting `i18n.min_coverage_pct`); every non-English language starts off (owner decision 2026-11-08).
import { t as tx, te } from '../../i18n.js';
import '../../content/admin.languages-strings.js';
import { esc, get, put, post, toast, dialog, formHtml, wireForm, badge, confirmAction, download } from './ui.js';

export async function render({ el, canPublish, query }) {
  const code = query && query.get('locale');
  if (code) return editor(el, code, canPublish, query);
  const d = await get('/i18n/locales');
  el.innerHTML = `<p class="muted">${te('admin.lang.intro', { min: esc(d.min_coverage_pct) })}</p>${d.flag_on ? '' : `<p class="adm-badge warn" data-testid="lang-flag-off">${te('admin.lang.flag_off')}</p>`}
    <div class="table-wrap"><table class="table" data-testid="lang-table"><thead><tr><th>${te('admin.lang.col.language')}</th><th>${te('admin.lang.col.dir')}</th><th class="num">${te('admin.lang.col.coverage')}</th><th>${te('admin.lang.col.review')}</th><th>${te('admin.lang.col.state')}</th><th></th></tr></thead><tbody>
    ${d.locales.map((l) => `<tr data-testid="lang-row" data-code="${esc(l.code)}" data-enabled="${l.enabled ? '1' : '0'}" data-reviewed="${l.reviewed ? '1' : '0'}"><td><b lang="${esc(l.code)}">${esc(l.native_name)}</b> <span class="faint">${esc(l.name)} · <code>${esc(l.code)}</code></span></td><td>${esc(l.dir)}</td>
      <td class="num" data-testid="lang-coverage" data-percent="${esc(l.coverage.percent)}">${te('admin.lang.coverage', { percent: esc(l.coverage.percent), translated: esc(l.coverage.translated), total: esc(l.coverage.total) })}${l.coverage.needs_review ? `<div class="faint" data-testid="lang-needs-review">${te('admin.lang.needs_review', { n: esc(l.coverage.needs_review) })}</div>` : ''}</td>
      <td>${l.reviewed ? badge(tx('admin.lang.reviewed'), 'ok') : badge(tx('admin.lang.not_reviewed'), 'warn')}</td><td>${l.enabled ? badge(tx('admin.lang.on'), 'ok') : badge(tx('admin.lang.off'), '')}</td>
      <td>${l.is_default ? `<span class="faint">${te('admin.lang.default')}</span>` : `<div class="adm-actions"><a class="btn btn-sm" href="/admin/cms/languages?locale=${esc(l.code)}" data-link data-testid="lang-translate">${te('admin.lang.translate')}</a>${canPublish ? `<button class="btn btn-sm" data-review="${esc(l.code)}" data-on="${l.reviewed ? '0' : '1'}" data-testid="lang-review-toggle">${te(l.reviewed ? 'admin.lang.unmark_reviewed' : 'admin.lang.mark_reviewed')}</button><button class="btn btn-sm ${l.enabled ? 'btn-danger' : 'btn-primary'}" data-switch="${esc(l.code)}" data-on="${l.enabled ? '0' : '1'}" data-testid="lang-switch">${te(l.enabled ? 'admin.lang.switch_off' : 'admin.lang.switch_on')}</button>` : ''}</div>`}</td></tr>`).join('')}</tbody></table></div>
    ${canPublish ? `<button class="btn" data-add data-testid="lang-add">${te('admin.lang.add')}</button>` : ''}`;
  el.onclick = async (e) => {
    const b = e.target.closest('[data-review],[data-switch],[data-add]');
    if (!b) return;
    try {
      if (b.dataset.add) return addLocale(el, () => render({ el, canPublish, query }));
      const on = b.dataset.on === '1';
      const isSwitch = !!b.dataset.switch;
      const r = await confirmAction({ title: tx(isSwitch ? (on ? 'admin.lang.switch_on_title' : 'admin.lang.switch_off_title') : (on ? 'admin.lang.mark_reviewed' : 'admin.lang.unmark_reviewed')), body: te(isSwitch ? 'admin.lang.switch_body' : 'admin.lang.review_body'), confirm: tx('admin.lang.confirm'), reason: true });
      if (!r) return;
      await put(`/i18n/locales/${encodeURIComponent(b.dataset.switch || b.dataset.review)}`, { [isSwitch ? 'enabled' : 'reviewed']: on, reason: r.reason });
      toast(tx('admin.lang.saved'));
      render({ el, canPublish, query });
    } catch (ex) { toast(ex.message, 'error'); }
  };
}

function addLocale(el, done) {
  const fields = [{ name: 'code', label: tx('admin.lang.f.code'), required: true, hint: tx('admin.lang.f.code_hint') }, { name: 'name', label: tx('admin.lang.f.name'), required: true }, { name: 'native_name', label: tx('admin.lang.f.native_name'), required: true },
    { name: 'dir', label: tx('admin.lang.f.dir'), type: 'select', options: [['ltr', tx('admin.lang.f.ltr')], ['rtl', tx('admin.lang.f.rtl')]], value: 'ltr' }, { name: 'reason', label: tx('admin.lang.reason'), required: true, span: true }];
  const d = dialog(`<h3>${te('admin.lang.add')}</h3><p class="faint">${te('admin.lang.add_note')}</p>${formHtml(fields, { submit: tx('admin.lang.save'), id: 'lang', testid: 'lang-add-form' })}`);
  wireForm(d.querySelector('form'), fields, async (v) => { await post('/i18n/locales', v); d.close(); toast(tx('admin.lang.saved')); done(); });
}

async function editor(el, code, canPublish, query) {
  const q = query.get('q') || ''; const state = query.get('state') || ''; const offset = Number(query.get('offset') || 0);
  const r = await get(`/i18n/locales/${encodeURIComponent(code)}/texts?${new URLSearchParams({ q, state, offset: String(offset), limit: '50' })}`);
  const l = r.locale;
  el.innerHTML = `<p><a href="/admin/cms/languages" data-link>${te('admin.lang.back')}</a></p><h2 lang="${esc(l.code)}">${esc(l.native_name)} <span class="faint">${esc(l.name)}</span></h2>
    <p data-testid="lang-editor-coverage">${te('admin.lang.coverage', { percent: esc(l.coverage.percent), translated: esc(l.coverage.translated), total: esc(l.coverage.total) })} · ${l.reviewed ? badge(tx('admin.lang.reviewed'), 'ok') : badge(tx('admin.lang.not_reviewed'), 'warn')} · ${l.enabled ? badge(tx('admin.lang.on'), 'ok') : badge(tx('admin.lang.off'), '')}</p>
    <form class="d-flex gap-8 fw-wrap" data-testid="lang-filter"><label class="field"><span>${te('admin.lang.search')}</span><input name="q" value="${esc(q)}" maxlength="100"></label>
      <label class="field"><span>${te('admin.lang.state')}</span><select name="state">${['', 'missing', 'translated', 'needs_review', 'draft'].map((s) => `<option value="${esc(s)}"${s === state ? ' selected' : ''}>${te(`admin.lang.state.${s || 'all'}`)}</option>`).join('')}</select></label><button class="btn btn-sm" type="submit">${te('admin.lang.apply')}</button>
      <button class="btn btn-sm" type="button" data-export data-testid="lang-export">${te('admin.lang.export')}</button><button class="btn btn-sm" type="button" data-import data-testid="lang-import">${te('admin.lang.import')}</button>
      ${canPublish && l.coverage.drafts ? `<button class="btn btn-sm btn-primary" type="button" data-publish-all data-testid="lang-publish-all">${te('admin.lang.publish_all', { n: esc(l.coverage.drafts) })}</button>` : ''}</form>
    <div class="table-wrap"><table class="table" data-testid="lang-texts"><thead><tr><th>${te('admin.lang.col.key')}</th><th>${te('admin.lang.col.english')}</th><th>${te('admin.lang.col.translation')}</th><th></th></tr></thead><tbody>
    ${r.items.map((x) => `<tr data-testid="lang-text" data-key="${esc(x.key)}" data-review="${esc(x.review || '')}"><td><code>${esc(x.key)}</code>${x.vars.length ? `<div class="faint">${esc(x.vars.map((v) => `{${v}}`).join(' '))}</div>` : ''}</td><td>${esc(x.english)}</td>
      <td lang="${esc(l.code)}" dir="${esc(l.dir)}">${x.translation != null ? esc(x.translation) : `<span class="faint">${te('admin.lang.missing')}</span>`}${x.draft != null ? `<div class="faint">${te('admin.lang.draft', { text: esc(x.draft) })}</div>` : ''}${x.review === 'needs_review' ? ` ${badge(tx('admin.lang.needs_review_one'), 'warn')}${x.note ? `<div class="faint" data-testid="lang-note">${esc(x.note)}</div>` : ''}` : x.review === 'reviewed' ? ` ${badge(tx('admin.lang.reviewed'), 'ok')}` : ''}</td>
      <td><div class="adm-actions"><button class="btn btn-sm" data-edit="${esc(x.key)}" data-testid="lang-edit">${te('admin.lang.edit')}</button>${canPublish && x.translation != null ? `<button class="btn btn-sm" data-mark="${esc(x.key)}" data-status="${x.review === 'reviewed' ? 'needs_review' : 'reviewed'}" data-testid="lang-mark">${te(x.review === 'reviewed' ? 'admin.lang.mark_needs_review' : 'admin.lang.mark_ok')}</button>` : ''}</div></td></tr>`).join('')}</tbody></table></div>
    <p class="faint">${te('admin.lang.paging', { from: esc(r.total ? offset + 1 : 0), to: esc(Math.min(r.total, offset + r.items.length)), total: esc(r.total) })}</p>
    ${offset + 50 < r.total ? `<a class="btn btn-sm" href="/admin/cms/languages?${esc(new URLSearchParams({ locale: code, q, state, offset: String(offset + 50) }).toString())}" data-link>${te('admin.lang.next')}</a>` : ''}`;
  const reload = () => editor(el, code, canPublish, query);
  el.querySelector('[data-testid=lang-filter]').onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target); history.replaceState({}, '', `/admin/cms/languages?${new URLSearchParams({ locale: code, q: f.get('q') || '', state: f.get('state') || '' })}`); query.set('q', f.get('q') || ''); query.set('state', f.get('state') || ''); query.set('offset', '0'); reload(); };
  el.onclick = async (e) => {
    const b = e.target.closest('[data-edit],[data-mark],[data-export],[data-import],[data-publish-all]');
    if (!b) return;
    try {
      if (b.dataset.edit) {
        const x = r.items.find((i) => i.key === b.dataset.edit);
        const fields = [{ name: 'value', label: tx('admin.lang.translation_for', { english: x.english.slice(0, 120) }), type: 'textarea', value: x.draft ?? x.translation ?? '', required: true, span: true, hint: x.vars.length ? tx('admin.lang.vars_hint', { vars: x.vars.map((v) => `{${v}}`).join(' ') }) : '' }];
        const d = dialog(`<h3><code>${esc(x.key)}</code></h3>${formHtml(fields, { submit: tx('admin.lang.save_draft'), id: 'ltx', testid: 'lang-text-form' })}${canPublish ? `<button class="btn btn-primary" data-pub data-testid="lang-text-publish">${te('admin.lang.save_publish')}</button>` : ''}`, { wide: true });
        const saveDraft = async (v) => { await put('/cms/text/draft', { key: x.key, value: v.value, locale: code }); };
        wireForm(d.querySelector('form'), fields, async (v) => { await saveDraft(v); d.close(); toast(tx('admin.lang.saved')); reload(); });
        d.querySelector('[data-pub]')?.addEventListener('click', async () => {
          try {
            await saveDraft({ value: d.querySelector('textarea').value });
            const c = await confirmAction({ title: tx('admin.lang.save_publish'), confirm: tx('admin.lang.save_publish'), reason: true });
            if (!c) return;
            await post('/cms/text/publish', { key: x.key, reason: c.reason, locale: code });
            d.close(); toast(tx('admin.lang.saved')); reload();
          } catch (ex) { toast(ex.message, 'error'); }
        });
        return;
      }
      if (b.dataset.mark) { await put(`/i18n/locales/${encodeURIComponent(code)}/review`, { key: b.dataset.mark, status: b.dataset.status }); toast(tx('admin.lang.saved')); return reload(); }
      if (b.dataset.export !== undefined) { const j = await get(`/i18n/locales/${encodeURIComponent(code)}/export`); download(`parlance-${code}.json`, JSON.stringify(j, null, 2), 'application/json'); return; }
      if (b.dataset.publishAll !== undefined) { const c = await confirmAction({ title: tx('admin.lang.publish_all_title'), confirm: tx('admin.lang.confirm'), reason: true }); if (!c) return; await post(`/i18n/locales/${encodeURIComponent(code)}/publish_drafts`, { reason: c.reason }); toast(tx('admin.lang.saved')); return reload(); }
      if (b.dataset.import !== undefined) {
        const fields = [{ name: 'file', label: tx('admin.lang.import_file'), type: 'textarea', required: true, span: true, hint: tx('admin.lang.import_hint') }, { name: 'reason', label: tx('admin.lang.reason'), span: true }];
        const d = dialog(`<h3>${te('admin.lang.import')}</h3>${formHtml(fields, { submit: tx('admin.lang.dry_run'), id: 'limp', testid: 'lang-import-form' })}<div data-testid="lang-import-result"></div>${canPublish ? `<button class="btn btn-primary" data-apply data-testid="lang-import-apply" disabled>${te('admin.lang.apply_import')}</button>` : ''}`, { wide: true });
        let parsed = null;
        wireForm(d.querySelector('form'), fields, async (v) => {
          try { parsed = JSON.parse(v.file); } catch { throw new Error(tx('admin.lang.bad_json')); }
          const res = await post(`/i18n/locales/${encodeURIComponent(code)}/import`, { data: parsed, dry_run: true });
          d.querySelector('[data-testid=lang-import-result]').textContent = tx('admin.lang.dry_result', { n: res.changes });
          const ap = d.querySelector('[data-apply]'); if (ap) ap.disabled = false;
        });
        d.querySelector('[data-apply]')?.addEventListener('click', async () => {
          try { const res = await post(`/i18n/locales/${encodeURIComponent(code)}/import`, { data: parsed, dry_run: false, reason: d.querySelector('[name=reason]').value }); d.close(); toast(tx('admin.lang.imported', { n: res.changes })); reload(); } catch (ex) { toast(ex.message, 'error'); }
        });
      }
    } catch (ex) { toast(ex.message, 'error'); }
  };
}
