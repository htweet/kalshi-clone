// Account & security (spec §13.6–13.9, SEC_IDENTITY_SPEC §22): social profile, security (password, two-factor, devices,
// activity), account limits, price alerts, appearance.
import { api } from '../api.js';
import { session } from '../store.js';
import { esc, money, toast, relTime } from '../lib.js';
import { PASSWORD_RULES, authMessage } from './auth.js';

const SECTIONS = [['profile', 'Social profile'], ['security', 'Security'], ['limits', 'Account limits'], ['alerts', 'Price alerts'], ['appearance', 'Appearance']];

export async function render({ el, params, navigate }) {
  if (!session.user) { navigate('/sign-in?next=' + encodeURIComponent(location.pathname), { replace: true }); return; }
  const section = SECTIONS.some(([k]) => k === params.section) ? params.section : 'profile';
  document.title = 'Account · Parlance';
  el.innerHTML = `<div class="page-head"><h1 class="typ-title-x10">Account</h1></div>
    <div class="account-layout"><nav class="side-nav">${SECTIONS.map(([k, l]) => `<a href="/account/${k}" data-link class="${k === section ? 'on' : ''}">${l}</a>`).join('')}</nav><div id="panel"></div></div>`;
  const panel = el.querySelector('#panel');
  await ({ profile, security, limits, alerts, appearance })[section](panel);
}

async function profile(panel) {
  const { profile: p } = await api.myProfile(session.uid);
  panel.innerHTML = `<form class="card panel" id="profile-form"><h2>Social profile</h2><p class="muted">Your nickname appears on posts, replies, the leaderboard and (if you allow it) next to your trades.</p>
    <label class="field">Nickname<input name="nickname" value="${esc(p?.nickname || '')}" maxlength="20" pattern="[A-Za-z0-9_]{3,20}" required data-testid="nickname-input"></label>
    <label class="field">Bio<textarea name="bio" maxlength="280">${esc(p?.bio || '')}</textarea></label>
    <label class="d-flex gap-8 ai-center m-10-0"><input type="checkbox" name="share_trades" ${!p || p.share_trades ? 'checked' : ''}> Show my nickname on my trades and positions</label>
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

// Account › Security (SEC_IDENTITY_SPEC §22): password, two-factor, withdrawal verification, email, signed-in
// devices with "sign out" / "sign out everywhere", and the account's own security activity log.
const EVENT_LABELS = {
  signup: 'Account created', login_ok: 'Signed in', login_fail: 'Failed sign-in attempt', lockout: 'Sign-in temporarily blocked', logout: 'Signed out',
  mfa_on: 'Two-factor login turned on', mfa_off: 'Two-factor login turned off', mfa_fail: 'Wrong two-factor code', step_up: 'Identity confirmed', step_up_fail: 'Identity check failed',
  password_change: 'Password changed', password_change_fail: 'Password change failed', password_change_required: 'Password reset required', password_reset_forced: 'Password reset required by support',
  password_rehash: 'Password storage upgraded', email_change: 'Email address changed', session_revoke: 'Device signed out', sessions_revoke_all: 'Signed out everywhere',
  sessions_revoked: 'Sessions ended (role change)', session_expired: 'Session expired', withdrawal_mfa_on: 'Withdrawal verification on', withdrawal_mfa_off: 'Withdrawal verification off',
  admin_bootstrap: 'Admin account set up', default_password_removed: 'Default password removed',
};
const BAD_EVENTS = new Set(['login_fail', 'lockout', 'mfa_fail', 'step_up_fail', 'password_change_fail']);
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
  const pend = (l, unit) => (l.pending ? `<div class="faint" data-testid="pending">Change to ${esc(l.pending[unit] == null ? 'no limit' : unit === 'limit_minutes' ? l.pending[unit] + ' min' : money(l.pending[unit]))} takes effect ${new Date(l.pending.effective_time).toLocaleString()} (24-hour cooling-off for loosening a limit).</div>` : '');
  const box = (kind, title, l, unit, used, hint) => `<form class="card panel" data-limit="${esc(kind)}" data-testid="limit-${esc(kind)}"><h2>${esc(title)}</h2><p class="muted">${esc(hint)}</p>
    <p>Current: <strong data-testid="limit-value">${esc(l.limit[unit] == null ? 'No limit' : unit === 'limit_minutes' ? l.limit[unit] + ' minutes per day' : money(l.limit[unit]) + ' per day')}</strong> · <span class="faint">Used today: ${esc(used)}</span></p>${pend(l.limit, unit)}
    <div class="inline-form"><label class="field">${unit === 'limit_minutes' ? 'Minutes per day' : 'Dollars per day'}<input name="v" type="number" min="1" step="${unit === 'limit_minutes' ? 1 : 0.01}" placeholder="No limit"></label>
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
    f.onsubmit = (e) => { e.preventDefault(); if (f.v.value) save(Number(f.v.value)); };
    f.querySelector('[data-remove]').onclick = () => save(null);
  }
}

async function alerts(panel) {
  const { price_targets: list } = await api.priceTargets(session.uid);
  panel.innerHTML = `<section class="card panel" data-testid="alerts-panel"><h2>Price alerts</h2><p class="muted">Create alerts from any market page. You get a notification when the Yes price crosses your level.</p>
    <table class="table"><thead><tr><th>Market</th><th>When Yes is</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.map((t) => `<tr data-alert="${esc(t.id)}"><td>${esc(t.market_title)}</td><td>${esc(t.direction)} ${Math.round(Number(t.price_dollars) * 100)}¢</td><td>${t.triggered_time ? `Triggered ${relTime(t.triggered_time)}` : 'Active'}</td><td><button class="btn btn-sm" data-del>Delete</button></td></tr>`).join('') || '<tr><td colspan="4" class="faint">No price alerts yet.</td></tr>'}</tbody></table></section>`;
  for (const b of panel.querySelectorAll('[data-del]')) b.onclick = async () => { await api.deletePriceTarget(session.uid, b.closest('[data-alert]').dataset.alert); toast('Alert deleted'); alerts(panel); };
}

async function appearance(panel) {
  const cur = document.documentElement.dataset.theme;
  panel.innerHTML = `<section class="card panel"><h2>Appearance</h2><p class="muted">Saved to your account and applied on every device.</p>
    <div class="seg"><button data-theme-set="light" class="${cur === 'light' ? 'on' : ''}">Light</button><button data-theme-set="dark" class="${cur === 'dark' ? 'on' : ''}">Dark</button></div></section>`;
  for (const b of panel.querySelectorAll('[data-theme-set]')) b.onclick = async () => { await session.setProp('theme', b.dataset.themeSet); appearance(panel); };
}
