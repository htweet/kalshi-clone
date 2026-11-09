// Admin › Owner settings (PLAN.md ground rule 6, CLONE_SPEC.md §38.1): every owner choice that is a value — durations,
// rates, thresholds, amounts — with its recommended standard default, the CMS-managed explanation, the current value and
// its change history. A change needs a reason (and a step-up where it affects money or security), is audited and takes
// effect live. Below them, the switch catalogue: every feature flag with its explanation and recommended default; the
// switches themselves are changed in Admin › Feature flags.
import { t as tx, te } from '../../i18n.js';
import '../../content/admin.owner-strings.js';
import { esc, get, put, toast, dialog, formHtml, wireForm, section, badge, fmtTime } from './ui.js';

const valueText = (s, v) => (s.type === 'bool' ? tx(v ? 'admin.owner.on' : 'admin.owner.off') : s.type === 'cidrs' ? (v ? String(v) : tx('admin.owner.everyone')) : s.type === 'enum' ? String(v) : tx(`admin.owner.unit.${s.unit || 'count'}`, { value: v }));

export async function render({ el }) {
  let data = await get('/owner_settings');
  const draw = () => {
    const groups = data.groups.map((g) => {
      const items = data.settings.filter((s) => s.group === g.key);
      return `<section class="card panel" data-testid="owner-group" data-group="${esc(g.key)}"><h2>${esc(g.label)}</h2><div class="owner-list">${items.map((s) => `<div class="owner-row" data-testid="owner-setting" data-key="${esc(s.key)}" data-value="${esc(String(s.value))}">
        <div class="owner-main"><b>${esc(s.label)}</b> <code class="faint">${esc(s.key)}</code>
          <p class="owner-help" data-testid="owner-help">${esc(s.help)}</p>
          <div class="faint" data-testid="owner-recommended" data-default="${esc(String(s.default))}">${te('admin.owner.recommended', { value: esc(valueText(s, s.default)) })}${s.step_up ? ` · ${te('admin.owner.step_up')}` : ''}${s.env_cap != null ? ` · ${te('admin.owner.env_cap', { cap: esc(s.env_cap) })}` : ''}${s.where ? ` · <a href="${esc(s.where)}" data-link>${te('admin.owner.where')}</a>` : ''}</div></div>
        <div class="owner-side"><span class="owner-value num" data-testid="owner-value">${esc(valueText(s, s.value))}</span> ${s.is_default ? badge(tx('admin.owner.default'), '') : badge(tx('admin.owner.changed'), 'warn')}${s.override ? ` ${badge(tx('admin.owner.override'), 'brand')}` : ''}
          <button class="btn btn-sm" data-edit="${esc(s.key)}" data-testid="owner-edit">${te('admin.owner.edit')}</button></div></div>`).join('')}</div></section>`;
    }).join('');
    const sw = `<section class="card panel" data-testid="owner-switches"><h2>${te('admin.owner.switches_title')}</h2><p class="muted">${te('admin.owner.switches_intro')}</p>
      <div class="table-wrap"><table class="table"><thead><tr><th>${te('admin.owner.col.switch')}</th><th>${te('admin.owner.col.explanation')}</th><th>${te('admin.owner.col.recommended')}</th><th>${te('admin.owner.col.now')}</th></tr></thead><tbody>
      ${data.switches.map((f) => `<tr data-testid="owner-switch" data-key="${esc(f.key)}"><td><code>${esc(f.key)}</code></td><td>${esc(f.help)}</td><td>${esc(f.recommended)}</td><td>${f.effective ? badge(tx('admin.owner.on'), 'ok') : badge(tx('admin.owner.off'), 'warn')}</td></tr>`).join('')}</tbody></table></div>
      <a class="btn btn-sm" href="/admin/flags" data-link>${te('admin.owner.to_flags')}</a></section>`;
    el.innerHTML = section(tx('admin.owner.title'), te('admin.owner.intro')) + groups + sw;
  };
  draw();
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-edit]');
    if (!b) return;
    try { await edit(b.dataset.edit, async () => { data = await get('/owner_settings'); draw(); }); } catch (ex) { toast(ex.message, 'error'); }
  });
}

async function edit(key, done) {
  const { setting: s, history } = await get(`/owner_settings/${encodeURIComponent(key)}`);
  const fields = [
    s.type === 'bool' ? { name: 'value', label: s.label, type: 'checkbox', value: !!s.value }
      : s.type === 'enum' ? { name: 'value', label: s.label, type: 'select', value: s.value, options: s.values, required: true } // Phase 9A: e.g. the log level
        : s.type === 'cidrs' ? { name: 'value', label: s.label, value: s.value, hint: tx('admin.owner.cidrs_hint') } // Phase 9A: the admin IP allowlist
          : { name: 'value', label: `${s.label} (${tx(`admin.owner.unit_name.${s.unit || 'count'}`)})`, type: 'number', value: s.value, required: true, hint: tx('admin.owner.range', { min: s.min, max: s.max }) },
    { name: 'reason', label: tx('admin.owner.reason'), required: true, span: true },
  ];
  const hist = history.length ? `<ul class="adm-hist" data-testid="owner-history">${history.map((h) => `<li data-testid="owner-history-row">${te('admin.owner.history_row', { from: esc(String(h.before?.value)), to: esc(String(h.after?.value)), who: esc(h.actor_email || '—'), time: esc(fmtTime(h.time)) })}<div class="faint">${esc(h.reason)}</div></li>`).join('')}</ul>` : `<p class="faint">${te('admin.owner.no_history')}</p>`;
  const d = dialog(`<h3>${esc(s.label)}</h3><p>${esc(s.help)}</p><p class="faint">${te('admin.owner.recommended', { value: esc(valueText(s, s.default)) })}</p>${formHtml(fields, { submit: tx('admin.owner.save'), id: 'own', testid: 'owner-form' })}<h4>${te('admin.owner.history')}</h4>${hist}`, { wide: true, testid: 'owner-dialog' });
  wireForm(d.querySelector('form'), fields, async (v) => {
    await put(`/owner_settings/${encodeURIComponent(key)}`, { value: s.type === 'bool' ? !!v.value : s.type === 'enum' || s.type === 'cidrs' ? String(v.value || '') : Number(v.value), reason: v.reason });
    toast(tx('admin.owner.saved', { label: s.label }));
    d.close();
    await done();
  });
}
