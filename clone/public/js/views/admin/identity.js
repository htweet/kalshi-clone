// Admin › Sign-in & audit integrity (CLONE_SPEC §22): verify the hash-chained audit log, the sign-in security
// log of every account (logins, failures, lockouts, MFA, step-up, password changes, session revocations), forced
// password resets, and the email outbox stub that stands in for security emails.
import { t as tx, te } from '../../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../../content/admin.identity-strings.js';
import { esc, get, post, toast, dataTable, section, fmtTime, badge, confirmAction } from './ui.js';

const BAD = new Set(['login_fail', 'lockout', 'mfa_fail', 'step_up_fail', 'password_change_fail']);

export async function render({ el, perms }) {
  el.innerHTML = section(tx('admin.identity.render.sign_in_audit_integrity'), tx('admin.identity.render.account_security_events_for_every')) +
    `<div class="adm-two"><div class="card adm-card" data-testid="audit-integrity"><h3>${te('admin.identity.render.audit_log_integrity')}</h3>
        <p class="faint">${te('admin.identity.render.each_audit_entry_stores_an')}</p>
        <button class="btn btn-primary" data-testid="audit-verify">${te('admin.identity.render.verify_audit_chain')}</button><p class="mt-12" data-testid="audit-verify-result"></p></div>
      ${perms.has('users.support') ? `<div class="card adm-card"><h3>${te('admin.identity.render.force_a_password_reset')}</h3><p class="faint">${te('admin.identity.render.signs_the_account_out_everywhere')}</p>
        <form class="adm-toolbar" data-testid="force-reset-form"><label class="field"><span>${te('admin.identity.render.account_email')}</span><input name="email" type="email" class="adm-input" required></label><button class="btn" type="submit">${te('admin.identity.render.require_new_password')}</button></form></div>` : ''}</div>
     <h3 class="mt-16">${te('admin.identity.render.sign_in_security_log')}</h3>
     <form class="adm-toolbar adm-filters" data-f><label class="field"><span>${te('admin.identity.render.event_type_starts_with')}</span><input name="type" class="adm-input" placeholder="${te('admin.identity.render.login')}"></label><label class="field"><span>${te('admin.identity.render.user_email')}</span><input name="user" class="adm-input"></label><button class="btn" type="submit">${te('admin.identity.render.filter')}</button></form>
     <div id="ev"></div>
     ${perms.has('users.support') ? `<h3 class="mt-16">${te('admin.identity.render.email_outbox_stub')}</h3><p class="faint">${te('admin.identity.render.security_emails_are_recorded_here')}</p><div id="ob"></div>` : ''}`;

  const result = el.querySelector('[data-testid=audit-verify-result]');
  el.querySelector('[data-testid=audit-verify]').onclick = async () => {
    result.textContent = tx('admin.identity.render.verifying');
    try {
      const r = await get('/audit/verify');
      result.dataset.ok = r.ok ? '1' : '0';
      result.innerHTML = r.ok ? `${te('admin.identity.render.entries_verified', { badge: badge(tx('admin.identity.render.chain_intact'), 'ok'), checked: esc(r.checked), fmt_time: esc(fmtTime(r.verified_time)) })}`
        : `${badge(tx('admin.identity.render.tampering_detected'), 'bad')} ${r.problem.chain_seq != null ? (te('admin.identity.render.at_entry', { chain_seq: esc(r.problem.chain_seq) }) + ' ') : ''}${esc(r.problem.reason)}`;
    } catch (ex) { result.textContent = ex.message; }
  };

  const fr = el.querySelector('[data-testid=force-reset-form]');
  if (fr) fr.onsubmit = async (e) => {
    e.preventDefault();
    const email = fr.email.value.trim();
    const ok = await confirmAction({ title: tx('admin.identity.render.require_a_new_password_for', { email }), body: tx('admin.identity.render.all_of_this_account_s'), confirm: tx('admin.identity.render.require_new_password'), danger: true, reason: true });
    if (!ok) return;
    try { const r = await post(`/users/${encodeURIComponent(email)}/force_password_reset`, { reason: ok.reason }); toast(tx('admin.identity.render.password_reset_required_session_s', { sessions_signed_out: r.sessions_signed_out })); fr.reset(); await load(); } catch (ex) { toast(ex.message, 'error'); }
  };

  const t = dataTable(el.querySelector('#ev'), { testid: 'identity-events', pageSize: 50, rowAttrs: (r) => `data-type="${esc(r.type)}"`,
    searchText: (r) => [r.type, r.email, r.ip_prefix, r.device, JSON.stringify(r.detail)].join(' '),
    cols: [{ key: 'time', label: tx('admin.identity.render.time'), render: (r) => esc(fmtTime(r.time)) }, { key: 'email', label: 'Account', render: (r) => esc(r.email || r.detail?.email || '—') },
      { key: 'type', label: tx('admin.identity.render.event'), render: (r) => badge(r.type.replace(/_/g, ' '), BAD.has(r.type) ? 'bad' : r.type === 'login_ok' ? 'ok' : '') },
      { key: 'device', label: tx('admin.identity.render.device') }, { key: 'ip_prefix', label: tx('admin.identity.render.network') },
      { key: '_d', label: tx('admin.identity.render.detail'), sort: false, render: (r) => (Object.keys(r.detail || {}).length ? `<details><summary>${te('admin.identity.render.details')}</summary><pre>${esc(JSON.stringify(r.detail, null, 1))}</pre></details>` : '') }] });
  const ob = el.querySelector('#ob') && dataTable(el.querySelector('#ob'), { testid: 'email-outbox', pageSize: 20, search: false,
    cols: [{ key: 'time', label: tx('admin.identity.render.time'), render: (r) => esc(fmtTime(r.time)) }, { key: 'to', label: tx('admin.identity.render.to') }, { key: 'subject', label: tx('admin.identity.render.subject') }, { key: 'body', label: tx('admin.identity.render.body'), render: (r) => `<span class="faint">${esc(r.body)}</span>` }] });
  const form = el.querySelector('[data-f]');
  async function load() {
    const p = new URLSearchParams(Object.entries(Object.fromEntries(new FormData(form))).filter(([, v]) => v));
    t.setRows((await get(`/identity/events?limit=500&${p}`)).events);
    if (ob) ob.setRows((await get('/identity/outbox')).messages);
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); load().catch((ex) => toast(ex.message, 'error')); });
  await load();
}
