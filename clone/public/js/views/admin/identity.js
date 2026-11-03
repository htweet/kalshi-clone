// Admin › Sign-in & audit integrity (CLONE_SPEC §22): verify the hash-chained audit log, the sign-in security
// log of every account (logins, failures, lockouts, MFA, step-up, password changes, session revocations), forced
// password resets, and the email outbox stub that stands in for security emails.
import { esc, get, post, toast, dataTable, section, fmtTime, badge, confirmAction } from './ui.js';

const BAD = new Set(['login_fail', 'lockout', 'mfa_fail', 'step_up_fail', 'password_change_fail']);

export async function render({ el, perms }) {
  el.innerHTML = section('Sign-in & audit integrity', 'Account security events for every user, the tamper-evident admin audit chain, and support tools.') +
    `<div class="adm-two"><div class="card adm-card" data-testid="audit-integrity"><h3>Audit log integrity</h3>
        <p class="faint">Each audit entry stores an HMAC of its contents and of the previous entry. Editing, deleting or re-ordering any entry breaks the chain from that point.</p>
        <button class="btn btn-primary" data-testid="audit-verify">Verify audit chain</button><p class="mt-12" data-testid="audit-verify-result"></p></div>
      ${perms.has('users.support') ? `<div class="card adm-card"><h3>Force a password reset</h3><p class="faint">Signs the account out everywhere; the user must choose a new password at the next sign-in.</p>
        <form class="adm-toolbar" data-testid="force-reset-form"><label class="field"><span>Account email</span><input name="email" type="email" class="adm-input" required></label><button class="btn" type="submit">Require new password</button></form></div>` : ''}</div>
     <h3 class="mt-16">Sign-in security log</h3>
     <form class="adm-toolbar adm-filters" data-f><label class="field"><span>Event type starts with</span><input name="type" class="adm-input" placeholder="login_"></label><label class="field"><span>User email</span><input name="user" class="adm-input"></label><button class="btn" type="submit">Filter</button></form>
     <div id="ev"></div>
     ${perms.has('users.support') ? '<h3 class="mt-16">Email outbox (stub)</h3><p class="faint">Security emails are recorded here instead of being sent.</p><div id="ob"></div>' : ''}`;

  const result = el.querySelector('[data-testid=audit-verify-result]');
  el.querySelector('[data-testid=audit-verify]').onclick = async () => {
    result.textContent = 'Verifying…';
    try {
      const r = await get('/audit/verify');
      result.dataset.ok = r.ok ? '1' : '0';
      result.innerHTML = r.ok ? `${badge('Chain intact', 'ok')} ${esc(r.checked)} entries verified · ${esc(fmtTime(r.verified_time))}`
        : `${badge('Tampering detected', 'bad')} ${r.problem.chain_seq != null ? `at entry #${esc(r.problem.chain_seq)}: ` : ''}${esc(r.problem.reason)}`;
    } catch (ex) { result.textContent = ex.message; }
  };

  const fr = el.querySelector('[data-testid=force-reset-form]');
  if (fr) fr.onsubmit = async (e) => {
    e.preventDefault();
    const email = fr.email.value.trim();
    const ok = await confirmAction({ title: `Require a new password for ${email}?`, body: 'All of this account’s sessions are signed out now.', confirm: 'Require new password', danger: true, reason: true });
    if (!ok) return;
    try { const r = await post(`/users/${encodeURIComponent(email)}/force_password_reset`, { reason: ok.reason }); toast(`Password reset required · ${r.sessions_signed_out} session(s) signed out`); fr.reset(); await load(); } catch (ex) { toast(ex.message, 'error'); }
  };

  const t = dataTable(el.querySelector('#ev'), { testid: 'identity-events', pageSize: 50, rowAttrs: (r) => `data-type="${esc(r.type)}"`,
    searchText: (r) => [r.type, r.email, r.ip_prefix, r.device, JSON.stringify(r.detail)].join(' '),
    cols: [{ key: 'time', label: 'Time', render: (r) => esc(fmtTime(r.time)) }, { key: 'email', label: 'Account', render: (r) => esc(r.email || r.detail?.email || '—') },
      { key: 'type', label: 'Event', render: (r) => badge(r.type.replace(/_/g, ' '), BAD.has(r.type) ? 'bad' : r.type === 'login_ok' ? 'ok' : '') },
      { key: 'device', label: 'Device' }, { key: 'ip_prefix', label: 'Network' },
      { key: '_d', label: 'Detail', sort: false, render: (r) => (Object.keys(r.detail || {}).length ? `<details><summary>details</summary><pre>${esc(JSON.stringify(r.detail, null, 1))}</pre></details>` : '') }] });
  const ob = el.querySelector('#ob') && dataTable(el.querySelector('#ob'), { testid: 'email-outbox', pageSize: 20, search: false,
    cols: [{ key: 'time', label: 'Time', render: (r) => esc(fmtTime(r.time)) }, { key: 'to', label: 'To' }, { key: 'subject', label: 'Subject' }, { key: 'body', label: 'Body', render: (r) => `<span class="faint">${esc(r.body)}</span>` }] });
  const form = el.querySelector('[data-f]');
  async function load() {
    const p = new URLSearchParams(Object.entries(Object.fromEntries(new FormData(form))).filter(([, v]) => v));
    t.setRows((await get(`/identity/events?limit=500&${p}`)).events);
    if (ob) ob.setRows((await get('/identity/outbox')).messages);
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); load().catch((ex) => toast(ex.message, 'error')); });
  await load();
}
