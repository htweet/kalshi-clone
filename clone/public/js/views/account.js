// Account area frame (CLONE_SPEC §13.16; CLONE_SPEC.md §25.7): content on the left, a right-hand card nav with icons —
// Account & security · Your activity · Documents · Settings. "Account & security" keeps the earlier sections (spec
// §13.6–13.9, CLONE_SPEC §22) as sub-tabs: Security (password, two-factor, devices, activity), Identity & privacy
// (verification status, sign-in methods, passkeys, data export, account closure), Social profile, Account limits and
// Price alerts. The old /account/appearance moved into Settings (theme).
import { t as T } from '../content/currency-strings.js'; // keyed wording (CLONE_SPEC.md §30)
import { api } from '../api.js';
import { session } from '../store.js';
import { esc, money, toast, relTime, pxCents, moneyStep, toApiDollars, amountLabel, fmtDateTime } from '../lib.js';
import { PASSWORD_RULES, authMessage } from './auth.js';

const NAV = [
  ['security', '/account', 'Account & security', '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 2.5l6 2.5v4.5c0 4-2.6 6.8-6 8-3.4-1.2-6-4-6-8V5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>'],
  ['activity', '/account/activity', 'Your activity', '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M2.5 10h3l2-5 4 10 2-5h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'],
  ['taxes', '/account/taxes', 'Documents', '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 2.5h7l3 3v12H5zM12 2.5v3h3M7.5 10h5M7.5 13h5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>'],
  ['settings', '/account/settings', 'Settings', '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="2.5" stroke="currentColor" stroke-width="1.5"/><path d="M10 2v2.5M10 15.5V18M2 10h2.5M15.5 10H18M4.3 4.3l1.8 1.8M13.9 13.9l1.8 1.8M4.3 15.7l1.8-1.8M13.9 6.1l1.8-1.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'],
];
const SUB = [['security', '/account', 'Security'], ['privacy', '/account/privacy', 'Identity & privacy'], ['payments', '/account/payments', 'Payment methods'], ['profile', '/account/profile', 'Social profile'], ['limits', '/account/limits', 'Account limits'], ['alerts', '/account/alerts', 'Price alerts']];
const lazyPanel = (load) => (panel, ctx) => load().then((m) => m.render(panel, ctx));
const PANELS = {
  activity: lazyPanel(() => import('./account-activity.js')),
  taxes: lazyPanel(() => import('./account-documents.js')),
  settings: lazyPanel(() => import('./account-settings.js')),
  privacy: lazyPanel(() => import('./account-identity.js')),
  payments: lazyPanel(() => import('./account-payments.js')), // Phase 4 (CLONE_SPEC.md §26)
};

export async function render({ el, params, navigate, query }) {
  if (!session.user) { navigate('/sign-in?next=' + encodeURIComponent(location.pathname), { replace: true }); return; }
  if (params.section === 'appearance') { navigate('/account/settings', { replace: true }); return; }
  const known = [...SUB.map(([k]) => k), 'activity', 'taxes', 'settings'];
  const section = known.includes(params.section) ? params.section : 'security';
  const top = SUB.some(([k]) => k === section) ? 'security' : section;
  const title = NAV.find(([k]) => k === top)[2];
  document.title = `${title} · Parlance`;
  el.innerHTML = `<div class="acct" data-testid="account-frame" data-section="${esc(section)}">
    <div class="acct-main"><h1 class="page-title acct-title" data-testid="account-title">${esc(title)}</h1>
      ${top === 'security' ? `<nav class="acct-sub chips" aria-label="Account and security sections" data-testid="account-subnav">${SUB.map(([k, href, l]) => `<a class="chip ${k === section ? 'on' : ''}" href="${href}" data-link data-sub="${esc(k)}">${esc(l)}</a>`).join('')}</nav>` : ''}
      <div id="panel"></div></div>
    <nav class="acct-nav card" aria-label="Account" data-testid="account-nav">${NAV.map(([k, href, l, icon]) => `<a href="${href}" data-link class="${k === top ? 'on' : ''}" data-nav-item="${esc(k)}"${k === top ? ' aria-current="page"' : ''}><span class="acct-ic">${icon}</span><span>${esc(l)}</span></a>`).join('')}</nav></div>`;
  const panel = el.querySelector('#panel');
  const fn = PANELS[section] || { security, profile, limits, alerts }[section];
  return fn(panel, { navigate, query });
}

async function profile(panel) {
  const { profile: p } = await api.myProfile(session.uid);
  panel.innerHTML = `<form class="card panel" id="profile-form"><h2>Social profile</h2><p class="muted">Your nickname appears on posts, replies, the leaderboard and (if you allow it) next to your trades.</p>
    <label class="field">Nickname<input name="nickname" value="${esc(p?.nickname || '')}" maxlength="20" pattern="[A-Za-z0-9_]{3,20}" required data-testid="nickname-input"></label>
    <label class="field">Bio<textarea name="bio" maxlength="280">${esc(p?.bio || '')}</textarea></label>
    <label class="d-flex gap-8 ai-center m-12-0"><input type="checkbox" name="share_trades" ${!p || p.share_trades ? 'checked' : ''}> Show my nickname on my trades and positions</label>
    <div class="form-error" id="p-error" role="alert"></div>
    <button class="btn btn-primary" type="submit">${p ? 'Save' : 'Create profile'}</button>
    ${p ? ` <a class="btn btn-ghost" href="/social/profile/${encodeURIComponent(p.nickname)}" data-link>View profile</a>` : ''}</form>`;
  const f = panel.querySelector('#profile-form');
  f.onsubmit = async (e) => {
    e.preventDefault();
    f.querySelector('#p-error').textContent = '';
    try {
      const r = await api.saveProfile(session.uid, { nickname: f.nickname.value.trim(), bio: f.bio.value, share_trades: f.share_trades.checked });
      session.nickname = r.profile.nickname; session.notify();
      toast('Profile saved');
      await profile(panel);
    } catch (ex) { f.querySelector('#p-error').textContent = ex.message; }
  };
}

// Account › Security (CLONE_SPEC §22): password, two-factor, withdrawal verification, email, signed-in
// devices with "sign out" / "sign out everywhere", and the account's own security activity log.
const EVENT_LABELS = {
  signup: 'Account created', login_ok: 'Signed in', login_fail: 'Failed sign-in attempt', lockout: 'Sign-in temporarily blocked', logout: 'Signed out',
  mfa_on: 'Two-factor login turned on', mfa_off: 'Two-factor login turned off', mfa_fail: 'Wrong two-factor code', step_up: 'Identity confirmed', step_up_fail: 'Identity check failed',
  password_change: 'Password changed', password_change_fail: 'Password change failed', password_change_required: 'Password reset required', password_reset_forced: 'Password reset required by support',
  password_rehash: 'Password storage upgraded', email_change: 'Email address changed', session_revoke: 'Device signed out', sessions_revoke_all: 'Signed out everywhere',
  sessions_revoked: 'Sessions ended (role change)', session_expired: 'Session expired', withdrawal_mfa_on: 'Withdrawal verification on', withdrawal_mfa_off: 'Withdrawal verification off',
  admin_bootstrap: 'Admin account set up', default_password_removed: 'Default password removed',
  // Phase 3 (CLONE_SPEC.md §25)
  phone_code_sent: 'Phone code sent', phone_verified: 'Phone number verified', phone_changed: 'Phone number changed', phone_verify_fail: 'Wrong phone code', phone_code_limited: 'Phone code request limited',
  email_verified: 'Email verified', password_reset_requested: 'Password reset requested', password_reset: 'Password reset by email link', passkey_added: 'Passkey added', passkey_removed: 'Passkey removed',
  passkey_used: 'Signed in with a passkey', passkey_fail: 'Passkey check failed', passkey_counter_regression: 'Passkey refused (possible copy)', oauth_linked: 'Sign-in provider linked',
  oauth_unlinked: 'Sign-in provider unlinked', oauth_fail: 'Provider sign-in failed', identity_submitted: 'Identity submitted', identity_approved: 'Identity verified', identity_review: 'Identity under review',
  identity_rejected: 'Identity not verified', identity_retry: 'Identity check needs another try', identity_documents_required: 'ID photos requested', identity_viewed_by_staff: 'Support viewed your identity details',
  geo_blocked: 'Blocked by location', withdrawal_held: 'Withdrawal held for review', data_export: 'Data exported', permission_denied: 'Locked setting refused (verify identity first)',
  docv_handoff_created: 'Phone verification link created', docv_handoff_claimed: 'Phone verification link opened', docv_handoff_refused: 'Phone verification link refused', docv_uploaded: 'ID photo uploaded',
  docv_exited: 'Left identity verification', documents_erased: 'ID photos erased', marketing_sms_opt_in: 'Marketing texts on', marketing_sms_opt_out: 'Marketing texts off',
  security_notifications_on: 'Security notifications on', security_notifications_off: 'Security notifications off', promo_redeemed: 'Promo code redeemed', connected_app_revoked: 'Connected app removed',
  // Phase 4 (CLONE_SPEC.md §26)
  payment_method_added: 'Payment method added', payment_method_removed: 'Payment method removed', bank_link_failed: 'Bank sign-in failed',
};
const BAD_EVENTS = new Set(['login_fail', 'lockout', 'mfa_fail', 'step_up_fail', 'password_change_fail', 'phone_verify_fail', 'passkey_fail', 'passkey_counter_regression', 'oauth_fail', 'geo_blocked', 'permission_denied', 'docv_handoff_refused']);
const dur = (sec) => (sec >= 86400 ? `${Math.round(sec / 86400)} days` : sec >= 3600 ? `${Math.round(sec / 3600)} hours` : `${Math.max(1, Math.round(sec / 60))} minutes`);

async function security(panel) {
  const [sec, { sessions }, { events }] = await Promise.all([api.security(session.uid), api.sessions(session.uid), api.securityEvents(session.uid)]);
  const enabled = sec.mfa_enabled;
  panel.innerHTML = `<form class="card panel" id="pw-form" data-testid="password-panel" novalidate><h2>Password</h2>
      <p class="muted">${sec.password_changed_time ? `Last changed ${esc(relTime(sec.password_changed_time))}.` : 'Use a long password you don’t use anywhere else.'} Changing it signs out your other devices.</p>
      <label class="field">Current password<input name="current_password" type="password" autocomplete="current-password" required data-testid="pw-current"></label>
      <label class="field">New password<input name="new_password" type="password" autocomplete="new-password" required data-testid="pw-new"></label>
      <label class="field">Confirm new password<input name="confirm" type="password" autocomplete="new-password" required data-testid="pw-confirm"></label>
      <p class="faint mt-6 mb-8">${esc(PASSWORD_RULES)}</p>
      <div class="form-error" id="pw-error" role="alert" data-testid="pw-error"></div><button class="btn btn-primary" type="submit" data-testid="pw-submit">Change password</button></form>
    <section class="card panel" data-testid="mfa-panel"><h2>Two-factor login</h2>
      <p class="muted">Ask for a 6-digit code from an authenticator app every time you log in.</p>
      <p>Status: <strong data-testid="mfa-status">${enabled ? 'On' : 'Off'}</strong></p><div id="mfa-body"></div></section>
    <section class="card panel" data-testid="withdrawal-mfa-panel"><h2>Withdrawal verification</h2>
      <p class="muted">Ask for a two-factor code for every withdrawal, even right after you sign in.${enabled ? '' : ' Turn on two-factor login first.'}</p>
      <label class="d-flex gap-8 ai-center"><input type="checkbox" data-testid="withdrawal-mfa-toggle" ${enabled ? '' : 'disabled'} ${sec.withdrawal_mfa ? 'checked' : ''}> Require a two-factor code to withdraw</label>
      <div class="form-error" id="wmfa-error" role="alert"></div></section>
    <form class="card panel" id="email-form" data-testid="email-panel" novalidate><h2>Email address</h2>
      <p class="muted">Used to sign in and for security alerts. We notify the old address when it changes.</p>
      <div class="inline-form"><label class="field">Email<input name="email" type="email" autocomplete="email" value="${esc(session.user.email)}" required data-testid="email-input"></label><button class="btn btn-primary" type="submit">Change email</button></div>
      <div class="form-error" id="email-error" role="alert"></div></form>
    <section class="card panel" data-testid="sessions-panel"><h2>Signed-in devices</h2>
      <p class="muted">A session ends after ${esc(dur(sec.session.idle_timeout_seconds))} without activity and 30 days after sign-in at the latest.</p>
      <table class="table"><thead><tr><th>Device</th><th>Network</th><th>Signed in</th><th>Last active</th><th></th></tr></thead><tbody>
      ${sessions.map((x) => `<tr data-testid="session-row" data-sid="${esc(x.id)}"${x.current ? ' data-current="1"' : ''}><td>${esc(x.device)}${x.current ? ' <span class="sec-badge" data-testid="this-device">This device</span>' : ''}</td><td class="faint">${esc(x.ip_prefix)}</td><td>${esc(relTime(x.created_time))}</td><td>${esc(relTime(x.last_seen_time))}</td>
        <td><button class="btn btn-sm" data-revoke="${esc(x.id)}" data-testid="session-signout">${x.current ? 'Sign out' : 'Sign out device'}</button></td></tr>`).join('')}</tbody></table>
      <div class="mt-12"><button class="btn" data-testid="signout-everywhere">Sign out everywhere</button></div></section>
    <section class="card panel" data-testid="security-activity"><h2>Security activity</h2><p class="muted">Sign-ins, failed attempts and security changes on your account (newest first).</p>
      <table class="table"><thead><tr><th>When</th><th>Event</th><th>Device</th><th>Network</th></tr></thead><tbody>
      ${events.slice(0, 50).map((e) => `<tr data-event="${esc(e.type)}"${BAD_EVENTS.has(e.type) ? ' class="sec-bad"' : ''}><td>${esc(relTime(e.time))}</td><td>${esc(EVENT_LABELS[e.type] || e.type)}</td><td>${esc(e.device)}</td><td class="faint">${esc(e.ip_prefix)}</td></tr>`).join('') || '<tr><td colspan="4" class="faint">No activity yet.</td></tr>'}</tbody></table></section>`;

  const signedOut = () => { session.clearLocal(); toast('Signed out'); location.assign('/sign-in'); };
  const pf = panel.querySelector('#pw-form');
  pf.onsubmit = async (e) => {
    e.preventDefault();
    const box = pf.querySelector('#pw-error');
    box.textContent = '';
    if (pf.new_password.value !== pf.confirm.value) { box.textContent = 'The new passwords do not match.'; return; }
    try {
      const r = await api.changePassword(session.uid, { current_password: pf.current_password.value, new_password: pf.new_password.value });
      toast(r.other_sessions_signed_out ? `Password changed · ${r.other_sessions_signed_out} other device(s) signed out` : 'Password changed');
      security(panel);
    } catch (ex) { if (ex.code !== 'step_up_cancelled') box.textContent = ex.code === 'invalid_password' ? 'Your current password is not correct.' : authMessage(ex); }
  };

  const body = panel.querySelector('#mfa-body');
  const codeForm = (label, onCode) => {
    body.insertAdjacentHTML('beforeend', `<form class="inline-form" id="mfa-form"><label class="field">6-digit code<input name="code" inputmode="numeric" maxlength="6" required data-testid="mfa-input"></label><button class="btn btn-primary" type="submit">${esc(label)}</button></form><div class="form-error" id="mfa-error" role="alert"></div>`);
    const f = body.querySelector('#mfa-form');
    f.onsubmit = async (e) => { e.preventDefault(); try { await onCode(f.code.value.trim()); } catch (ex) { if (ex.code !== 'step_up_cancelled') body.querySelector('#mfa-error').textContent = ex.message; } };
  };
  if (enabled) {
    codeForm('Turn off', async (code) => { await api.mfaDisable(session.uid, code); toast('Two-factor login turned off'); security(panel); });
  } else {
    body.innerHTML = '<button class="btn btn-primary" id="mfa-start">Set up two-factor login</button>';
    body.querySelector('#mfa-start').onclick = async () => {
      const s = await api.mfaSetup(session.uid);
      body.innerHTML = `<p>1. Add this key to your authenticator app (or open the setup link on your phone):</p>
        <div class="code" data-testid="mfa-secret">${esc(s.secret)}</div><p class="faint mt-6"><a href="${esc(s.otpauth_url)}" class="c-brand">Open setup link</a></p><p>2. Enter the code it shows:</p>`;
      codeForm('Turn on', async (code) => { await api.mfaEnable(session.uid, code); toast('Two-factor login is on'); security(panel); });
    };
  }

  const wt = panel.querySelector('[data-testid=withdrawal-mfa-toggle]');
  wt.onchange = async () => {
    const want = wt.checked;
    try { await api.setWithdrawalMfa(session.uid, want); toast(want ? 'Withdrawals now need a two-factor code' : 'Withdrawal verification off'); security(panel); } catch (ex) {
      wt.checked = !want;
      if (ex.code !== 'step_up_cancelled') panel.querySelector('#wmfa-error').textContent = ex.message;
    }
  };

  const ef = panel.querySelector('#email-form');
  ef.onsubmit = async (e) => {
    e.preventDefault();
    ef.querySelector('#email-error').textContent = '';
    try { const r = await api.changeEmail(session.uid, ef.email.value.trim()); session.user = { ...session.user, email: r.user.email }; session.notify(); toast('Email address changed'); security(panel); } catch (ex) {
      if (ex.code !== 'step_up_cancelled') ef.querySelector('#email-error').textContent = ex.message;
    }
  };

  for (const b of panel.querySelectorAll('[data-revoke]')) {
    b.onclick = async () => {
      const r = await api.revokeSession(session.uid, b.dataset.revoke);
      if (r.signed_out) { signedOut(); return; }
      toast('Device signed out');
      security(panel);
    };
  }
  panel.querySelector('[data-testid=signout-everywhere]').onclick = async () => {
    if (!confirm('Sign out of Parlance on every device, including this one?')) return;
    await api.revokeAllSessions(session.uid);
    signedOut();
  };
}

async function limits(panel) {
  const [d, t, s] = await Promise.all(['deposit', 'trading', 'session'].map((k) => api.limit(session.uid, k)));
  const pend = (l, unit) => (l.pending ? `<div class="faint" data-testid="pending">Change to ${esc(l.pending[unit] == null ? 'no limit' : unit === 'limit_minutes' ? l.pending[unit] + ' min' : money(l.pending[unit]))} takes effect ${esc(fmtDateTime(l.pending.effective_time))} (24-hour cooling-off for loosening a limit).</div>` : '');
  const box = (kind, title, l, unit, used, hint) => `<form class="card panel" data-limit="${esc(kind)}" data-testid="limit-${esc(kind)}"><h2>${esc(title)}</h2><p class="muted">${esc(hint)}</p>
    <p>Current: <strong data-testid="limit-value">${esc(l.limit[unit] == null ? 'No limit' : unit === 'limit_minutes' ? l.limit[unit] + ' minutes per day' : money(l.limit[unit]) + ' per day')}</strong> · <span class="faint">Used today: ${esc(used)}</span></p>${pend(l.limit, unit)}
    <div class="inline-form"><label class="field">${unit === 'limit_minutes' ? 'Minutes per day' : esc(T('currency.per_day', { mode: amountLabel() }))}<input name="v" type="number" min="1" step="${unit === 'limit_minutes' ? 1 : esc(moneyStep())}" placeholder="No limit"></label>
    <button class="btn btn-primary" type="submit">Set limit</button><button class="btn" type="button" data-remove>Remove limit</button></div><div class="form-error" role="alert"></div></form>`;
  panel.innerHTML = box('deposit', 'Deposit limit', d, 'limit_dollars', money(d.limit.used_today_dollars), 'Caps how much you can deposit per day (UTC).')
    + box('trading', 'Trading limit', t, 'limit_dollars', money(t.limit.used_today_dollars), 'Caps the total cost of orders you can place per day (UTC).')
    + box('session', 'Daily session time', s, 'limit_minutes', `${Math.floor(s.limit.used_today_seconds / 60)} min`, 'Locks trading and browsing in your account after this much active time per day.');
  for (const f of panel.querySelectorAll('[data-limit]')) {
    const kind = f.dataset.limit;
    const key = kind === 'session' ? 'limit_minutes' : 'limit_dollars';
    const save = async (v) => {
      try { await api.setLimit(session.uid, kind, { [key]: v }); toast('Limit updated'); limits(panel); } catch (ex) { f.querySelector('.form-error').textContent = ex.message; }
    };
    f.onsubmit = (e) => { e.preventDefault(); if (f.v.value) save(kind === 'session' ? Number(f.v.value) : toApiDollars(f.v.value)); }; // naira ÷ 100 = limit_dollars
    f.querySelector('[data-remove]').onclick = () => save(null);
  }
}

async function alerts(panel) {
  const { price_targets: list } = await api.priceTargets(session.uid);
  panel.innerHTML = `<section class="card panel" data-testid="alerts-panel"><h2>Price alerts</h2><p class="muted">Create alerts from any market page. You get a notification when the Yes price crosses your level.</p>
    <table class="table"><thead><tr><th>Market</th><th>When Yes is</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.map((t) => `<tr data-alert="${esc(t.id)}"><td>${esc(t.market_title)}</td><td>${esc(t.direction)} ${esc(pxCents(Math.round(Number(t.price_dollars) * 100)))}</td><td>${t.triggered_time ? `Triggered ${relTime(t.triggered_time)}` : 'Active'}</td><td><button class="btn btn-sm" data-del>Delete</button></td></tr>`).join('') || '<tr><td colspan="4" class="faint">No price alerts yet.</td></tr>'}</tbody></table></section>`;
  for (const b of panel.querySelectorAll('[data-del]')) b.onclick = async () => { await api.deletePriceTarget(session.uid, b.closest('[data-alert]').dataset.alert); toast('Alert deleted'); alerts(panel); };
}
