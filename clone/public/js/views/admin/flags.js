// Admin › Feature flags (CLONE_SPEC.md §33): every feature and module with its state, rollout, targeting and schedule;
// edit (reason + step-up, audited, with the change history), kill switch, live refresh when another admin changes one.
import { t as tx, te } from '../../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../../content/admin.flags-strings.js';
import { socket } from '../../ws.js';
import { esc, get, put, post, toast, dataTable, dialog, formHtml, wireForm, confirmAction, section, badge, fmtTime } from './ui.js';

const label = (k) => { const v = tx(`admin.flags.label.${k}`); return v === `admin.flags.label.${k}` ? k : v; };
const groupLabel = (g) => { const v = tx(`admin.flags.group.${g}`); return v === `admin.flags.group.${g}` ? g : v; };
const list = (a) => a.map((x) => (typeof x === 'string' ? x : x.email || x.id)).join(', ');

function stateHtml(f) {
  const st = f.kill ? badge(tx('admin.flags.state.killed'), 'bad') : f.effective ? badge(tx('admin.flags.state.on'), 'ok') : badge(tx('admin.flags.state.off'), 'warn');
  const why = !f.effective && !f.kill && f.effective_reason && f.effective_reason !== 'off' ? ` <span class="faint">${te('admin.flags.state.reason', { reason: esc(f.effective_reason) })}</span>` : '';
  const env = f.env_override != null ? ` ${badge(tx('admin.flags.state.env'), 'brand')}` : '';
  return `<span data-testid="flag-state" data-on="${f.effective ? '1' : '0'}">${st}</span>${why}${env}${f.job ? ` <span class="faint">${te('admin.flags.state.job')}</span>` : ''}`;
}
function targetingHtml(f) {
  const allow = [list(f.allow_users), f.allow_roles.join(', '), f.allow_regions.join(', ')].filter(Boolean);
  const deny = [list(f.deny_users), f.deny_roles.join(', '), f.deny_regions.join(', ')].filter(Boolean);
  if (!allow.length && !deny.length) return `<span class="faint">${te('admin.flags.targeting.none')}</span>`;
  return [allow.length ? te('admin.flags.targeting.allow', { list: esc(allow.join(' · ')) }) : '', deny.length ? te('admin.flags.targeting.deny', { list: esc(deny.join(' · ')) }) : ''].filter(Boolean).join('<br>');
}
function scheduleHtml(f) {
  if (!f.starts_time && !f.ends_time) return `<span class="faint">${te('admin.flags.schedule.none')}</span>`;
  return [f.starts_time ? te('admin.flags.schedule.from', { time: esc(fmtTime(f.starts_time)) }) : '', f.ends_time ? te('admin.flags.schedule.until', { time: esc(fmtTime(f.ends_time)) }) : ''].filter(Boolean).join('<br>');
}

export async function render({ el }) {
  let data = await get('/flags');
  let group = '';
  el.innerHTML = section(tx('admin.flags.page.title'), te('admin.flags.page.intro')) +
    `<div class="adm-toolbar"><select class="adm-input" data-group aria-label="${te('admin.flags.page.all_groups')}" data-testid="flag-group"><option value="">${te('admin.flags.page.all_groups')}</option>${data.groups.map((g) => `<option value="${esc(g)}">${esc(groupLabel(g))}</option>`).join('')}</select><span class="faint" data-version></span></div><div id="ft"></div>`;
  const table = dataTable(el.querySelector('#ft'), { testid: 'flags-table', pageSize: 100, rowAttrs: (f) => `data-flag-key="${esc(f.key)}"`,
    searchText: (f) => [f.key, label(f.key), groupLabel(f.group)].join(' '),
    cols: [
      // Ground rule 6 (CLONE_SPEC.md §38.1): the explanation and the recommended default next to every switch.
      { key: 'key', label: tx('admin.flags.col.flag'), render: (f) => `<b>${esc(label(f.key))}</b><div class="faint"><code>${esc(f.key)}</code>${f.parent ? ` · ${te('admin.flags.edit.parent', { parent: esc(f.parent) })}` : ''}</div>${f.help && f.help !== `flag.${f.key}` ? `<div class="flag-help" data-testid="flag-help">${esc(f.help)}</div>` : ''}<div class="faint" data-testid="flag-recommended" data-on="${f.recommended ? '1' : '0'}">${te(f.recommended ? 'admin.flags.recommended_on' : 'admin.flags.recommended_off')}</div>` },
      { key: 'effective', label: tx('admin.flags.col.state'), render: stateHtml },
      { key: 'rollout_pct', label: tx('admin.flags.col.rollout'), num: true, render: (f) => `<span data-testid="flag-rollout">${esc(f.rollout_pct)}%</span>` },
      { key: '_t', label: tx('admin.flags.col.targeting'), sort: false, render: targetingHtml },
      { key: '_s', label: tx('admin.flags.col.schedule'), sort: false, render: scheduleHtml },
      { key: '_a', label: tx('admin.flags.col.actions'), sort: false, render: (f) => `<div class="adm-actions"><button class="btn btn-sm" data-edit="${esc(f.key)}" data-testid="flag-edit">${te('admin.flags.action.edit')}</button>${f.kill
        ? `<button class="btn btn-sm" data-unkill="${esc(f.key)}" data-testid="flag-unkill">${te('admin.flags.action.unkill')}</button>`
        : `<button class="btn btn-sm btn-danger" data-kill="${esc(f.key)}" data-testid="flag-kill">${te('admin.flags.action.kill')}</button>`}</div>` },
    ] });
  const draw = () => {
    el.querySelector('[data-version]').textContent = tx('admin.flags.page.version', { version: data.version });
    table.setRows(data.flags.filter((f) => !group || f.group === group));
  };
  const reload = async () => { data = await get('/flags'); draw(); };
  el.querySelector('[data-group]').onchange = (e) => { group = e.target.value; draw(); };
  draw();
  el.addEventListener('click', async (e) => {
    const k = e.target.closest('[data-edit],[data-kill],[data-unkill]');
    if (!k) return;
    try {
      if (k.dataset.edit) await editFlag(k.dataset.edit, data.roles, reload);
      else if (k.dataset.kill) {
        const r = await confirmAction({ title: tx('admin.flags.kill.title', { flag: label(k.dataset.kill) }), body: te('admin.flags.kill.body'), confirm: tx('admin.flags.kill.confirm'), danger: true, reason: true });
        if (r) { await post(`/flags/${encodeURIComponent(k.dataset.kill)}/kill`, { reason: r.reason }); toast(tx('admin.flags.saved', { flag: label(k.dataset.kill) })); await reload(); }
      } else {
        const r = await confirmAction({ title: tx('admin.flags.unkill.title', { flag: label(k.dataset.unkill) }), body: te('admin.flags.unkill.body'), confirm: tx('admin.flags.unkill.confirm'), reason: true });
        if (r) { await put(`/flags/${encodeURIComponent(k.dataset.unkill)}`, { kill: false, reason: r.reason }); toast(tx('admin.flags.saved', { flag: label(k.dataset.unkill) })); await reload(); }
      }
    } catch (ex) { toast(ex.message, 'error'); }
  });
  // Another admin's change (or a schedule boundary) arrives live.
  const unsub = socket.subscribe({ channels: ['feature_flags'] }, (m) => { if (m.type === 'feature_flags' && m.msg && m.msg.version !== data.version) reload().catch(() => {}); });
  return () => unsub();
}

async function editFlag(key, roles, done) {
  const { flag: f, history } = await get(`/flags/${encodeURIComponent(key)}`);
  const fields = [
    { name: 'enabled', label: tx('admin.flags.edit.enabled'), type: 'checkbox', value: f.enabled },
    { name: 'kill', label: tx('admin.flags.edit.kill'), type: 'checkbox', value: f.kill },
    { name: 'rollout_pct', label: tx('admin.flags.edit.rollout'), type: 'number', value: f.rollout_pct, required: true },
    { name: 'allow_users', label: tx('admin.flags.edit.allow_users'), value: list(f.allow_users), span: true },
    { name: 'deny_users', label: tx('admin.flags.edit.deny_users'), value: list(f.deny_users), span: true },
    { name: 'allow_roles', label: tx('admin.flags.edit.allow_roles'), value: f.allow_roles.join(', '), hint: tx('admin.flags.edit.roles_hint', { roles: roles.join(', ') }) },
    { name: 'deny_roles', label: tx('admin.flags.edit.deny_roles'), value: f.deny_roles.join(', ') },
    { name: 'allow_regions', label: tx('admin.flags.edit.allow_regions'), value: f.allow_regions.join(', ') },
    { name: 'deny_regions', label: tx('admin.flags.edit.deny_regions'), value: f.deny_regions.join(', ') },
    { name: 'starts_at', label: tx('admin.flags.edit.starts_at'), type: 'datetime', value: f.starts_time },
    { name: 'ends_at', label: tx('admin.flags.edit.ends_at'), type: 'datetime', value: f.ends_time },
    { name: 'reason', label: tx('admin.flags.edit.reason'), required: true, span: true },
  ];
  const hist = history.length ? `<ul class="adm-hist" data-testid="flag-history">${history.map((h) => `<li data-testid="flag-history-row">${te('admin.flags.edit.history_row', { version: esc(h.version), action: esc(h.action), who: esc(h.actor_email || '—'), time: esc(fmtTime(h.time)) })}<div class="faint">${esc(h.reason)}</div></li>`).join('')}</ul>` : `<p class="faint">${te('admin.flags.edit.no_history')}</p>`;
  const d = dialog(`<h3>${te('admin.flags.edit.title', { flag: esc(label(key)) })}</h3><p class="faint"><code>${esc(key)}</code></p>${f.help ? `<p data-testid="flag-dialog-help">${esc(f.help)}</p>` : ''}<p class="faint">${te(f.recommended ? 'admin.flags.recommended_on' : 'admin.flags.recommended_off')}</p>
    ${formHtml(fields, { submit: tx('admin.flags.edit.save'), id: 'flag', testid: 'flag-form' })}
    ${f.routes.length ? `<details><summary>${te('admin.flags.edit.routes')}</summary><pre class="adm-pre">${esc(f.routes.join('\n'))}</pre></details>` : ''}
    <h4>${te('admin.flags.edit.history')}</h4>${hist}`, { wide: true, testid: 'flag-dialog' });
  const split = (s) => String(s || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  wireForm(d.querySelector('form'), fields, async (v) => {
    await put(`/flags/${encodeURIComponent(key)}`, {
      enabled: v.enabled, kill: v.kill, rollout_pct: v.rollout_pct,
      allow_users: split(v.allow_users), deny_users: split(v.deny_users), allow_roles: split(v.allow_roles), deny_roles: split(v.deny_roles),
      allow_regions: split(v.allow_regions), deny_regions: split(v.deny_regions), starts_at: v.starts_at || null, ends_at: v.ends_at || null, reason: v.reason,
    });
    toast(tx('admin.flags.saved', { flag: label(key) }));
    d.close();
    await done();
  });
}
