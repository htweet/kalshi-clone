// Admin › API keys and Admin › Status incidents (CLONE_SPEC.md §35.2, §35.8, §35.10).
//   api_keys   every user's keys (search), tier assignment and revocation with a reason (audited), per-key usage, the
//              rate-tier settings (settings.write, step-up), and the live FIX sessions with disconnect.
//   status     post and resolve status-page incidents: CMS entries of type `incident` (draft → publish with a reason).
import { t as tx, te } from '../../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../../content/admin.api-strings.js';
import { request } from '../../api.js';
import { esc, get, put, post, toast, dialog, formHtml, wireForm, confirmAction, section, badge, fmtTime } from './ui.js';

export async function render(ctx) {
  if (ctx.section === 'status') return renderStatus(ctx);
  return renderKeys(ctx);
}

// ---------------------------------------------------------------- keys
async function renderKeys({ el, perms, query }) {
  const q = query.get('q') || '';
  const data = await get(`/api_keys${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  el.innerHTML = section(tx('admin.api.keys.title'), te('admin.api.keys.intro')) +
    `<form class="adm-table-tools" data-search><input type="search" class="adm-input" name="q" value="${esc(q)}" placeholder="${te('admin.api.keys.search')}" aria-label="${te('admin.api.keys.search')}" data-testid="adm-key-search"><button class="btn btn-sm" type="submit">${te('admin.api.keys.find')}</button></form>
    <div class="card adm-card"><div class="adm-scroll"><table class="table adm-grid" data-testid="adm-key-list"><thead><tr><th>${te('admin.api.col.user')}</th><th>${te('admin.api.col.label')}</th><th>${te('admin.api.col.key')}</th><th>${te('admin.api.col.scopes')}</th><th>${te('admin.api.col.tier')}</th><th>${te('admin.api.col.status')}</th><th>${te('admin.api.col.today')}</th><th>${te('admin.api.col.last_used')}</th><th>${te('admin.api.col.actions')}</th></tr></thead>
      <tbody>${data.api_keys.length ? data.api_keys.map((k) => `<tr data-testid="adm-key-row" data-key="${esc(k.api_key_id)}" data-status="${esc(k.status)}"><td>${esc(k.user_email)}</td><td>${esc(k.label)}</td><td><code class="dev-mono">${esc(k.api_key_id)}</code></td><td>${esc(k.scopes.join(', '))}</td>
        <td><select class="adm-input" data-tier="${esc(k.api_key_id)}" data-testid="adm-key-tier" aria-label="${te('admin.api.col.tier')}">${data.tiers.map((x) => `<option value="${esc(x)}" ${x === k.tier ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></td>
        <td>${badge(k.status, k.status === 'active' ? 'ok' : 'bad')}</td><td data-f="today">${esc(k.today.requests)} / ${esc(k.today.throttled)}</td><td>${esc(fmtTime(k.last_used_time))}</td>
        <td><button class="btn btn-sm" data-usage="${esc(k.api_key_id)}" data-testid="adm-key-usage">${te('admin.api.action.usage')}</button>${k.status === 'active' ? ` <button class="btn btn-sm btn-danger" data-revoke="${esc(k.api_key_id)}" data-testid="adm-key-revoke">${te('admin.api.action.revoke')}</button>` : ''}</td></tr>`).join('') : `<tr><td colspan="9" class="faint">${te('admin.api.keys.empty')}</td></tr>`}</tbody></table></div></div>
    <div class="card adm-card" data-testid="adm-fix-sessions"><h3>${te('admin.api.fix.title')}</h3><div data-fix></div></div>
    ${perms.has('settings.write') ? `<div class="card adm-card"><h3>${te('admin.api.settings.title')}</h3><div data-settings></div></div>` : ''}`;
  el.querySelector('[data-search]').onsubmit = (e) => { e.preventDefault(); const v = e.target.q.value.trim(); history.replaceState({}, '', `/admin/api_keys${v ? `?q=${encodeURIComponent(v)}` : ''}`); renderKeys({ el, perms, query: new URLSearchParams(v ? { q: v } : {}) }); };
  for (const s of el.querySelectorAll('[data-tier]')) {
    const was = s.value;
    s.onchange = async () => {
      const ok = await confirmAction({ title: tx('admin.api.tier.title', { key: s.dataset.tier }), body: te('admin.api.tier.body', { tier: esc(s.value) }), confirm: tx('admin.api.tier.confirm'), reason: true });
      if (!ok) { s.value = was; return; }
      try { await put(`/api_keys/${encodeURIComponent(s.dataset.tier)}/tier`, { tier: s.value, reason: ok.reason }); toast(tx('admin.api.tier.done')); } catch (ex) { s.value = was; toast(ex.message, 'error'); }
    };
  }
  for (const b of el.querySelectorAll('[data-revoke]')) {
    b.onclick = async () => {
      const ok = await confirmAction({ title: tx('admin.api.revoke.title', { key: b.dataset.revoke }), body: te('admin.api.revoke.body'), confirm: tx('admin.api.revoke.confirm'), danger: true, reason: true });
      if (!ok) return;
      try { await post(`/api_keys/${encodeURIComponent(b.dataset.revoke)}/revoke`, { reason: ok.reason }); toast(tx('admin.api.revoke.done')); renderKeys({ el, perms, query }); } catch (ex) { toast(ex.message, 'error'); }
    };
  }
  for (const b of el.querySelectorAll('[data-usage]')) {
    b.onclick = async () => {
      const r = await get(`/api_keys/${encodeURIComponent(b.dataset.usage)}`);
      const d = dialog(`<div class="adm-confirm" data-testid="adm-usage-dialog"><h3>${te('admin.api.usage.title', { key: esc(b.dataset.usage) })}</h3>${r.usage.length ? `<table class="table adm-grid"><thead><tr><th>${te('admin.api.usage.day')}</th><th>${te('admin.api.usage.requests')}</th><th>${te('admin.api.usage.throttled')}</th><th>${te('admin.api.usage.errors')}</th></tr></thead><tbody>${r.usage.map((u) => `<tr data-testid="adm-usage-row"><td>${esc(u.day)}</td><td>${esc(u.requests)}</td><td>${esc(u.throttled)}</td><td>${esc(u.errors)}</td></tr>`).join('')}</tbody></table>` : `<p class="faint">${te('admin.api.usage.empty')}</p>`}
        <div class="adm-form-actions"><button class="btn" type="button" data-close>${te('admin.api.usage.close')}</button></div></div>`, { wide: true });
      d.querySelector('[data-close]').onclick = () => d.close();
    };
  }
  await drawFix(el.querySelector('[data-fix]'));
  if (perms.has('settings.write')) await drawSettings(el.querySelector('[data-settings]'));
}

async function drawFix(host) {
  const r = await get('/fix/sessions');
  host.innerHTML = `<p class="faint" data-testid="adm-fix-state" data-listening="${r.listening ? '1' : '0'}">${r.listening ? te('admin.api.fix.listening', { port: esc(r.port) }) : te('admin.api.fix.off')} <button class="btn btn-sm" type="button" data-refresh data-testid="adm-fix-refresh">${te('admin.api.fix.refresh')}</button></p>
    ${r.sessions.length ? `<div class="adm-scroll"><table class="table adm-grid"><thead><tr><th>${te('admin.api.fix.col.user')}</th><th>${te('admin.api.fix.col.comp')}</th><th>${te('admin.api.fix.col.type')}</th><th>${te('admin.api.fix.col.remote')}</th><th>${te('admin.api.fix.col.since')}</th><th>${te('admin.api.fix.col.seq')}</th><th></th></tr></thead>
      <tbody>${r.sessions.map((x) => `<tr data-testid="adm-fix-row" data-session="${esc(x.id)}" data-key="${esc(x.key_id)}"><td>${esc(x.user_email)}</td><td>${esc(x.sender_comp_id)} / ${esc(x.target_comp_id)}</td><td>${esc(x.type)}</td><td>${esc(x.remote)}</td><td>${esc(fmtTime(x.logged_on_time))}</td><td>${esc(x.in_seq)} / ${esc(x.out_seq)}</td><td><button class="btn btn-sm btn-danger" data-disconnect="${esc(x.id)}" data-testid="adm-fix-disconnect">${te('admin.api.fix.disconnect')}</button></td></tr>`).join('')}</tbody></table></div>` : `<p class="faint" data-testid="adm-fix-empty">${te('admin.api.fix.empty')}</p>`}`;
  host.querySelector('[data-refresh]').onclick = () => drawFix(host);
  for (const b of host.querySelectorAll('[data-disconnect]')) {
    b.onclick = async () => {
      const ok = await confirmAction({ title: tx('admin.api.fix.disconnect_title'), body: te('admin.api.fix.disconnect_body'), confirm: tx('admin.api.fix.disconnect'), danger: true, reason: true });
      if (!ok) return;
      try { await post(`/fix/sessions/${encodeURIComponent(b.dataset.disconnect)}/disconnect`, { reason: ok.reason }); toast(tx('admin.api.fix.disconnected')); setTimeout(() => drawFix(host), 400); } catch (ex) { toast(ex.message, 'error'); }
    };
  }
}

async function drawSettings(host) {
  const { settings } = await get('/api_keys/settings');
  const tiers = Object.keys(settings.tiers);
  const fields = [
    ...tiers.flatMap((k) => [['read_per_sec', 'read'], ['write_per_sec', 'write'], ['ws_connections', 'ws'], ['fix_sessions', 'fix']].map(([f, l]) => ({ name: `${k}__${f}`, label: tx(`admin.api.settings.${l}`, { tier: settings.tiers[k].label }), type: 'number', value: settings.tiers[k][f] }))),
    { name: 'rotation_grace_seconds', label: tx('admin.api.settings.grace'), type: 'number', value: settings.rotation_grace_seconds },
    { name: 'reason', label: tx('admin.api.settings.reason'), required: true, span: true },
  ];
  host.innerHTML = formHtml(fields, { submit: tx('admin.api.settings.save'), id: 'apis', testid: 'adm-api-settings' });
  wireForm(host.querySelector('form'), fields, async (v) => {
    const out = { tiers: {}, rotation_grace_seconds: v.rotation_grace_seconds, reason: v.reason };
    for (const k of tiers) out.tiers[k] = Object.fromEntries(['read_per_sec', 'write_per_sec', 'ws_connections', 'fix_sessions'].map((f) => [f, v[`${k}__${f}`]]));
    await put('/api_keys/settings', out);
    toast(tx('admin.api.settings.saved'));
  });
}

// ---------------------------------------------------------------- status incidents
const COMPONENTS = ['api', 'websocket', 'fix', 'demo', 'web'];
async function renderStatus({ el }) {
  const st = await request('GET', '/v1/status');
  const names = new Map(st.components.map((c) => [c.id, c.name]));
  const fields = [
    { name: 'title', label: tx('admin.api.status.f_title'), required: true, span: true },
    { name: 'body', label: tx('admin.api.status.f_body'), type: 'textarea', span: true, max: 4000 },
    { name: 'status', label: tx('admin.api.status.f_status'), type: 'select', value: 'investigating', options: ['investigating', 'identified', 'monitoring', 'resolved'] },
    { name: 'impact', label: tx('admin.api.status.f_impact'), type: 'select', value: 'degraded', options: ['maintenance', 'degraded', 'outage'] },
    ...COMPONENTS.map((c) => ({ name: `c_${c}`, label: tx('admin.api.status.f_component', { component: names.get(c) || c }), type: 'checkbox' })),
    { name: 'reason', label: tx('admin.api.status.f_reason'), required: true, span: true },
  ];
  el.innerHTML = section(tx('admin.api.status.title'), te('admin.api.status.intro')) +
    `<div class="card adm-card"><h3>${te('admin.api.status.new')}</h3>${formHtml(fields, { submit: tx('admin.api.status.post'), id: 'inc', testid: 'adm-incident-form' })}</div>
    <div class="card adm-card"><h3>${te('admin.api.status.list')}</h3>${st.incidents.length ? `<table class="table adm-grid" data-testid="adm-incidents"><tbody>${st.incidents.map((i) => `<tr data-testid="adm-incident-row" data-incident="${esc(i.id)}" data-status="${esc(i.status)}"><td>${esc(i.title)}</td><td>${badge(i.status, i.status === 'resolved' ? 'ok' : 'warn')}</td><td>${esc(i.impact)}</td><td>${esc(fmtTime(i.started_time))}</td><td>${i.status === 'resolved' ? '' : `<button class="btn btn-sm" data-resolve="${esc(i.id)}" data-testid="adm-incident-resolve">${te('admin.api.status.resolve')}</button>`}</td></tr>`).join('')}</tbody></table>` : `<p class="faint">${te('admin.api.status.empty')}</p>`}</div>`;
  const publish = async (key, value, reason) => {
    await put('/cms/incident/draft', { key, value });
    await post('/cms/incident/publish', { key, reason });
  };
  wireForm(el.querySelector('form'), fields, async (v) => {
    const components = COMPONENTS.filter((c) => v[`c_${c}`]);
    if (!components.length) throw Object.assign(new Error(tx('admin.api.status.need_component')), { fields: { c_api: tx('admin.api.status.need_component') } });
    await publish(`inc-${Date.now().toString(36)}`, { title: v.title, body: v.body, status: v.status, impact: v.impact, components }, v.reason);
    toast(tx('admin.api.status.posted'));
    renderStatus({ el });
  });
  for (const b of el.querySelectorAll('[data-resolve]')) {
    b.onclick = async () => {
      const i = st.incidents.find((x) => x.id === b.dataset.resolve);
      const ok = await confirmAction({ title: tx('admin.api.status.resolve_title'), confirm: tx('admin.api.status.resolve'), reason: true });
      if (!ok) return;
      try { await publish(i.id, { title: i.title, body: i.body, status: 'resolved', impact: i.impact, components: i.components, started_at: i.started_time }, ok.reason); toast(tx('admin.api.status.resolved')); renderStatus({ el }); } catch (ex) { toast(ex.message, 'error'); }
    };
  }
}
