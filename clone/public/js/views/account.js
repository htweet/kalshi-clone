// Account area frame (CLONE_SPEC §13.16; CLONE_SPEC.md §25.7): content on the left, a right-hand card nav with icons —
// Account & security · Your activity · Documents · Settings. "Account & security" keeps the earlier sections (spec
// §13.6–13.9, CLONE_SPEC §22) as sub-tabs: Security (password, two-factor, devices, activity), Identity & privacy
// (verification status, sign-in methods, passkeys, data export, account closure), Social profile, Account limits and
// Price alerts. The old /account/appearance moved into Settings (theme).
import { t as tx, te, ts } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/account-strings.js';
import { t as T } from '../content/currency-strings.js'; // keyed wording (CLONE_SPEC.md §30)
import { api } from '../api.js';
import { session } from '../store.js';
import { esc, money, toast, relTime, pxCents, moneyStep, toApiDollars, amountLabel, fmtDateTime } from '../lib.js';
import { PASSWORD_RULES, authMessage } from './auth.js';

const NAV = [
  ['security', '/account', ts('account.nav.account_security'), '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 2.5l6 2.5v4.5c0 4-2.6 6.8-6 8-3.4-1.2-6-4-6-8V5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>'],
  ['activity', '/account/activity', ts('account.nav.your_activity'), '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M2.5 10h3l2-5 4 10 2-5h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'],
  ['taxes', '/account/taxes', ts('account.nav.documents'), '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 2.5h7l3 3v12H5zM12 2.5v3h3M7.5 10h5M7.5 13h5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>'],
  ['settings', '/account/settings', ts('account.nav.settings'), '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="2.5" stroke="currentColor" stroke-width="1.5"/><path d="M10 2v2.5M10 15.5V18M2 10h2.5M15.5 10H18M4.3 4.3l1.8 1.8M13.9 13.9l1.8 1.8M4.3 15.7l1.8-1.8M13.9 6.1l1.8-1.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'],
];
const SUB = [['security', '/account', ts('account.sub.security')], ['privacy', '/account/privacy', ts('account.sub.identity_privacy')], ['payments', '/account/payments', ts('account.sub.payment_methods')], ['profile', '/account/profile', ts('account.sub.social_profile')], ['limits', '/account/limits', ts('account.sub.account_limits')], ['alerts', '/account/alerts', ts('account.sub.price_alerts')], ['api-keys', '/account/api-keys', ts('account.sub.api_keys')]];
const lazyPanel = (load) => (panel, ctx) => load().then((m) => m.render(panel, ctx));
const PANELS = {
  activity: lazyPanel(() => import('./account-activity.js')),
  taxes: lazyPanel(() => import('./account-documents.js')),
  settings: lazyPanel(() => import('./account-settings.js')),
  privacy: lazyPanel(() => import('./account-identity.js')),
  payments: lazyPanel(() => import('./account-payments.js')), // Phase 4 (CLONE_SPEC.md §26)
  'api-keys': lazyPanel(() => import('./api-keys.js')), // Phase 7: API keys and usage (CLONE_SPEC.md §35.2)
};

export async function render({ el, params, navigate, query }) {
  if (!session.user) { navigate('/sign-in?next=' + encodeURIComponent(location.pathname), { replace: true }); return; }
  if (params.section === 'appearance') { navigate('/account/settings', { replace: true }); return; }
  const known = [...SUB.map(([k]) => k), 'activity', 'taxes', 'settings'];
  const section = known.includes(params.section) ? params.section : 'security';
  const top = SUB.some(([k]) => k === section) ? 'security' : section;
  const title = NAV.find(([k]) => k === top)[2];
  document.title = tx('account.render.parlance', { title });
  el.innerHTML = `<div class="acct" data-testid="account-frame" data-section="${esc(section)}">
    <div class="acct-main"><h1 class="page-title acct-title" data-testid="account-title">${esc(title)}</h1>
      ${top === 'security' ? `<nav class="acct-sub chips" aria-label="${te('account.render.account_and_security_sections')}" data-testid="account-subnav">${SUB.map(([k, href, l]) => `<a class="chip ${k === section ? 'on' : ''}" href="${esc(href)}" data-link data-sub="${esc(k)}">${esc(l)}</a>`).join('')}</nav>` : ''}
      <div id="panel"></div></div>
    <nav class="acct-nav card" aria-label="${te('account.render.account')}" data-testid="account-nav">${NAV.map(([k, href, l, icon]) => `<a href="${esc(href)}" data-link class="${k === top ? 'on' : ''}" data-nav-item="${esc(k)}"${k === top ? ' aria-current="page"' : ''}><span class="acct-ic">${icon /* eslint-disable-line parlance/no-unescaped-html -- static SVG markup from this module's NAV table */}</span><span>${esc(l)}</span></a>`).join('')}</nav></div>`;
  const panel = el.querySelector('#panel');
  const fn = PANELS[section] || { security, profile, limits, alerts }[section];
  return fn(panel, { navigate, query });
}

async function profile(panel) {
  const { profile: p } = await api.myProfile(session.uid);
  panel.innerHTML = `<form class="card panel" id="profile-form"><h2>${te('account.profile.social_profile')}</h2><p class="muted">${te('account.profile.your_nickname_appears_on_posts')}</p>
    <label class="field">${te('account.profile.nickname')}<input name="nickname" value="${esc(p?.nickname || '')}" maxlength="20" pattern="[A-Za-z0-9_]{3,20}" required data-testid="nickname-input"></label>
    <label class="field">${te('account.profile.bio')}<textarea name="bio" maxlength="280">${esc(p?.bio || '')}</textarea></label>
    <label class="d-flex gap-8 ai-center m-12-0"><input type="checkbox" name="share_trades" ${!p || p.share_trades ? 'checked' : ''}> ${te('account.profile.show_my_nickname_on_my')}</label>
    <div class="form-error" id="p-error" role="alert"></div>
    <button class="btn btn-primary" type="submit">${p ? te('account.profile.save') : te('account.profile.create_profile')}</button>
    ${p ? ` <a class="btn btn-ghost" href="/social/profile/${encodeURIComponent(p.nickname)}" data-link>${te('account.profile.view_profile')}</a>` : ''}</form>`;
  const f = panel.querySelector('#profile-form');
  f.onsubmit = async (e) => {
    e.preventDefault();
    f.querySelector('#p-error').textContent = '';
    try {
      const r = await api.saveProfile(session.uid, { nickname: f.nickname.value.trim(), bio: f.bio.value, share_trades: f.share_trades.checked });
      session.nickname = r.profile.nickname; session.notify();
      toast(tx('account.profile.profile_saved'));
      await profile(panel);
    } catch (ex) { f.querySelector('#p-error').textContent = ex.message; }
  };
}

// Account › Security (CLONE_SPEC §22): password, two-factor, withdrawal verification, email, signed-in
// devices with "sign out" / "sign out everywhere", and the account's own security activity log.
const EVENT_LABELS = {
  signup: ts('account.event_labels_signup.account_created'), login_ok: ts('account.event_labels_login_ok.signed_in'), login_fail: ts('account.event_labels_login_fail.failed_sign_in_attempt'), lockout: ts('account.event_labels_lockout.sign_in_temporarily_blocked'), logout: ts('account.event_labels_logout.signed_out'),
  mfa_on: ts('account.event_labels_mfa_on.two_factor_login_turned_on'), mfa_off: ts('account.event_labels_mfa_off.two_factor_login_turned_off'), mfa_fail: ts('account.event_labels_mfa_fail.wrong_two_factor_code'), step_up: ts('account.event_labels_step_up.identity_confirmed'), step_up_fail: ts('account.event_labels_step_up_fail.identity_check_failed'),
  password_change: ts('account.event_labels_password_change.password_changed'), password_change_fail: ts('account.event_labels_password_change_fai.password_change_failed'), password_change_required: ts('account.event_labels_password_change_req.password_reset_required'), password_reset_forced: ts('account.event_labels_password_reset_forc.password_reset_required_by_support'),
  password_rehash: ts('account.event_labels_password_rehash.password_storage_upgraded'), email_change: ts('account.event_labels_email_change.email_address_changed'), session_revoke: ts('account.event_labels_session_revoke.device_signed_out'), sessions_revoke_all: ts('account.event_labels_sessions_revoke_all.signed_out_everywhere'),
  api_key_created: ts('account.event_labels_api.api_key_created'), api_key_rotated: ts('account.event_labels_api.api_key_rotated'), api_key_revoked: ts('account.event_labels_api.api_key_revoked'), demo_key_created: ts('account.event_labels_api.demo_key_created'), // Phase 7
  sessions_revoked: ts('account.event_labels_sessions_revoked.sessions_ended_role_change'), session_expired: ts('account.event_labels_session_expired.session_expired'), withdrawal_mfa_on: ts('account.event_labels_withdrawal_mfa_on.withdrawal_verification_on'), withdrawal_mfa_off: ts('account.event_labels_withdrawal_mfa_off.withdrawal_verification_off'),
  admin_bootstrap: ts('account.event_labels_admin_bootstrap.admin_account_set_up'), default_password_removed: ts('account.event_labels_default_password_re.default_password_removed'),
  // Phase 3 (CLONE_SPEC.md §25)
  phone_code_sent: ts('account.event_labels_phone_code_sent.phone_code_sent'), phone_verified: ts('account.event_labels_phone_verified.phone_number_verified'), phone_changed: ts('account.event_labels_phone_changed.phone_number_changed'), phone_verify_fail: ts('account.event_labels_phone_verify_fail.wrong_phone_code'), phone_code_limited: ts('account.event_labels_phone_code_limited.phone_code_request_limited'),
  email_verified: ts('account.event_labels_email_verified.email_verified'), password_reset_requested: ts('account.event_labels_password_reset_requ.password_reset_requested'), password_reset: ts('account.event_labels_password_reset.password_reset_by_email_link'), passkey_added: ts('account.event_labels_passkey_added.passkey_added'), passkey_removed: ts('account.event_labels_passkey_removed.passkey_removed'),
  passkey_used: ts('account.event_labels_passkey_used.signed_in_with_a_passkey'), passkey_fail: ts('account.event_labels_passkey_fail.passkey_check_failed'), passkey_counter_regression: ts('account.event_labels_passkey_counter_reg.passkey_refused_possible_copy'), oauth_linked: ts('account.event_labels_oauth_linked.sign_in_provider_linked'),
  oauth_unlinked: ts('account.event_labels_oauth_unlinked.sign_in_provider_unlinked'), oauth_fail: ts('account.event_labels_oauth_fail.provider_sign_in_failed'), identity_submitted: ts('account.event_labels_identity_submitted.identity_submitted'), identity_approved: ts('account.event_labels_identity_approved.identity_verified'), identity_review: ts('account.event_labels_identity_review.identity_under_review'),
  identity_rejected: ts('account.event_labels_identity_rejected.identity_not_verified'), identity_retry: ts('account.event_labels_identity_retry.identity_check_needs_another_try'), identity_documents_required: ts('account.event_labels_identity_documents_.id_photos_requested'), identity_viewed_by_staff: ts('account.event_labels_identity_viewed_by_.support_viewed_your_identity_details'),
  geo_blocked: ts('account.event_labels_geo_blocked.blocked_by_location'), withdrawal_held: ts('account.event_labels_withdrawal_held.withdrawal_held_for_review'), data_export: ts('account.event_labels_data_export.data_exported'), permission_denied: ts('account.event_labels_permission_denied.locked_setting_refused_verify_identity'),
  docv_handoff_created: ts('account.event_labels_docv_handoff_create.phone_verification_link_created'), docv_handoff_claimed: ts('account.event_labels_docv_handoff_claime.phone_verification_link_opened'), docv_handoff_refused: ts('account.event_labels_docv_handoff_refuse.phone_verification_link_refused'), docv_uploaded: ts('account.event_labels_docv_uploaded.id_photo_uploaded'),
  docv_exited: ts('account.event_labels_docv_exited.left_identity_verification'), documents_erased: ts('account.event_labels_documents_erased.id_photos_erased'), marketing_sms_opt_in: ts('account.event_labels_marketing_sms_opt_i.marketing_texts_on'), marketing_sms_opt_out: ts('account.event_labels_marketing_sms_opt_o.marketing_texts_off'),
  security_notifications_on: ts('account.event_labels_security_notificati.security_notifications_on'), security_notifications_off: ts('account.event_labels_security_notificati.security_notifications_off'), promo_redeemed: ts('account.event_labels_promo_redeemed.promo_code_redeemed'), connected_app_revoked: ts('account.event_labels_connected_app_revok.connected_app_removed'),
  // Phase 4 (CLONE_SPEC.md §26)
  payment_method_added: ts('account.event_labels_payment_method_adde.payment_method_added'), payment_method_removed: ts('account.event_labels_payment_method_remo.payment_method_removed'), bank_link_failed: ts('account.event_labels_bank_link_failed.bank_sign_in_failed'),
};
const BAD_EVENTS = new Set(['login_fail', 'lockout', 'mfa_fail', 'step_up_fail', 'password_change_fail', 'phone_verify_fail', 'passkey_fail', 'passkey_counter_regression', 'oauth_fail', 'geo_blocked', 'permission_denied', 'docv_handoff_refused']);
const dur = (sec) => (sec >= 86400 ? `${Math.round(sec / 86400)} days` : sec >= 3600 ? `${Math.round(sec / 3600)} hours` : `${Math.max(1, Math.round(sec / 60))} minutes`);

async function security(panel) {
  const [sec, { sessions }, { events }] = await Promise.all([api.security(session.uid), api.sessions(session.uid), api.securityEvents(session.uid)]);
  const enabled = sec.mfa_enabled;
  panel.innerHTML = `<form class="card panel" id="pw-form" data-testid="password-panel" novalidate><h2>${te('account.security.password')}</h2>
      <p class="muted">${te('account.security.changing_it_signs_out_your', { value: sec.password_changed_time ? te('account.security.last_changed', { rel_time: esc(relTime(sec.password_changed_time)) }) : te('account.security.use_a_long_password_you') })}</p>
      <label class="field">${te('account.security.current_password')}<input name="current_password" type="password" autocomplete="current-password" required data-testid="pw-current"></label>
      <label class="field">${te('account.security.new_password')}<input name="new_password" type="password" autocomplete="new-password" required data-testid="pw-new"></label>
      <label class="field">${te('account.security.confirm_new_password')}<input name="confirm" type="password" autocomplete="new-password" required data-testid="pw-confirm"></label>
      <p class="faint mt-6 mb-8">${esc(PASSWORD_RULES)}</p>
      <div class="form-error" id="pw-error" role="alert" data-testid="pw-error"></div><button class="btn btn-primary" type="submit" data-testid="pw-submit">${te('account.security.change_password')}</button></form>
    <section class="card panel" data-testid="mfa-panel"><h2>${te('account.security.two_factor_login')}</h2>
      <p class="muted">${te('account.security.ask_for_a_6_digit')}</p>
      <p>${te('account.security.status')} <strong data-testid="mfa-status">${enabled ? te('account.security.on') : te('account.security.off')}</strong></p><div id="mfa-body"></div></section>
    <section class="card panel" data-testid="withdrawal-mfa-panel"><h2>${te('account.security.withdrawal_verification')}</h2>
      <p class="muted">${te('account.security.ask_for_a_two_factor', { value: enabled ? '' : (' ' + te('account.security.turn_on_two_factor_login')) })}</p>
      <label class="d-flex gap-8 ai-center"><input type="checkbox" data-testid="withdrawal-mfa-toggle" ${enabled ? '' : 'disabled'} ${sec.withdrawal_mfa ? 'checked' : ''}> ${te('account.security.require_a_two_factor_code')}</label>
      <div class="form-error" id="wmfa-error" role="alert"></div></section>
    <form class="card panel" id="email-form" data-testid="email-panel" novalidate><h2>${te('account.security.email_address')}</h2>
      <p class="muted">${te('account.security.used_to_sign_in_and')}</p>
      <div class="inline-form"><label class="field">${te('account.security.email')}<input name="email" type="email" autocomplete="email" value="${esc(session.user.email)}" required data-testid="email-input"></label><button class="btn btn-primary" type="submit">${te('account.security.change_email')}</button></div>
      <div class="form-error" id="email-error" role="alert"></div></form>
    <section class="card panel" data-testid="sessions-panel"><h2>${te('account.security.signed_in_devices')}</h2>
      <p class="muted">${te('account.security.a_session_ends_after_without', { dur: esc(dur(sec.session.idle_timeout_seconds)) })}</p>
      <table class="table"><thead><tr><th>${te('account.security.device')}</th><th>${te('account.security.network')}</th><th>${te('account.security.signed_in')}</th><th>${te('account.security.last_active')}</th><th></th></tr></thead><tbody>
      ${sessions.map((x) => `<tr data-testid="session-row" data-sid="${esc(x.id)}"${x.current ? ' data-current="1"' : ''}><td>${esc(x.device)}${x.current ? ` <span class="sec-badge" data-testid="this-device">${te('account.security.this_device')}</span>` : ''}</td><td class="faint">${esc(x.ip_prefix)}</td><td>${esc(relTime(x.created_time))}</td><td>${esc(relTime(x.last_seen_time))}</td>
        <td><button class="btn btn-sm" data-revoke="${esc(x.id)}" data-testid="session-signout">${x.current ? te('account.security.sign_out') : te('account.security.sign_out_device')}</button></td></tr>`).join('')}</tbody></table>
      <div class="mt-12"><button class="btn" data-testid="signout-everywhere">${te('account.security.sign_out_everywhere')}</button></div></section>
    <section class="card panel" data-testid="security-activity"><h2>${te('account.security.security_activity')}</h2><p class="muted">${te('account.security.sign_ins_failed_attempts_and')}</p>
      <table class="table"><thead><tr><th>${te('account.security.when')}</th><th>${te('account.security.event')}</th><th>${te('account.security.device')}</th><th>${te('account.security.network')}</th></tr></thead><tbody>
      ${events.slice(0, 50).map((e) => `<tr data-event="${esc(e.type)}"${BAD_EVENTS.has(e.type) ? ' class="sec-bad"' : ''}><td>${esc(relTime(e.time))}</td><td>${esc(EVENT_LABELS[e.type] || e.type)}</td><td>${esc(e.device)}</td><td class="faint">${esc(e.ip_prefix)}</td></tr>`).join('') || `<tr><td colspan="4" class="faint">${te('account.security.no_activity_yet')}</td></tr>`}</tbody></table></section>`;

  const signedOut = () => { session.clearLocal(); toast(tx('account.security.signed_out')); location.assign('/sign-in'); };
  const pf = panel.querySelector('#pw-form');
  pf.onsubmit = async (e) => {
    e.preventDefault();
    const box = pf.querySelector('#pw-error');
    box.textContent = '';
    if (pf.new_password.value !== pf.confirm.value) { box.textContent = tx('account.security.the_new_passwords_do_not'); return; }
    try {
      const r = await api.changePassword(session.uid, { current_password: pf.current_password.value, new_password: pf.new_password.value });
      toast(r.other_sessions_signed_out ? tx('account.security.password_changed_other_device_s', { other_sessions_signed_out: r.other_sessions_signed_out }) : tx('account.security.password_changed'));
      security(panel);
    } catch (ex) { if (ex.code !== 'step_up_cancelled') box.textContent = ex.code === 'invalid_password' ? tx('account.security.your_current_password_is_not') : authMessage(ex); }
  };

  const body = panel.querySelector('#mfa-body');
  const codeForm = (label, onCode) => {
    body.insertAdjacentHTML('beforeend', `<form class="inline-form" id="mfa-form"><label class="field">${te('account.security.n6_digit_code')}<input name="code" inputmode="numeric" maxlength="6" required data-testid="mfa-input"></label><button class="btn btn-primary" type="submit">${esc(label)}</button></form><div class="form-error" id="mfa-error" role="alert"></div>`);
    const f = body.querySelector('#mfa-form');
    f.onsubmit = async (e) => { e.preventDefault(); try { await onCode(f.code.value.trim()); } catch (ex) { if (ex.code !== 'step_up_cancelled') body.querySelector('#mfa-error').textContent = ex.message; } };
  };
  if (enabled) {
    codeForm(tx('account.security.turn_off'), async (code) => { await api.mfaDisable(session.uid, code); toast(tx('account.security.two_factor_login_turned_off')); security(panel); });
  } else {
    body.innerHTML = `<button class="btn btn-primary" id="mfa-start">${te('account.security.set_up_two_factor_login')}</button>`;
    body.querySelector('#mfa-start').onclick = async () => {
      const s = await api.mfaSetup(session.uid);
      body.innerHTML = `<p>${te('account.security.n1_add_this_key_to')}</p>
        <div class="code" data-testid="mfa-secret">${esc(s.secret)}</div><p class="faint mt-6"><a href="${esc(s.otpauth_url)}" class="c-brand">${te('account.security.open_setup_link')}</a></p><p>${te('account.security.n2_enter_the_code_it')}</p>`;
      codeForm(tx('account.security.turn_on'), async (code) => { await api.mfaEnable(session.uid, code); toast(tx('account.security.two_factor_login_is_on')); security(panel); });
    };
  }

  const wt = panel.querySelector('[data-testid=withdrawal-mfa-toggle]');
  wt.onchange = async () => {
    const want = wt.checked;
    try { await api.setWithdrawalMfa(session.uid, want); toast(want ? tx('account.security.withdrawals_now_need_a_two') : tx('account.security.withdrawal_verification_off')); security(panel); } catch (ex) {
      wt.checked = !want;
      if (ex.code !== 'step_up_cancelled') panel.querySelector('#wmfa-error').textContent = ex.message;
    }
  };

  const ef = panel.querySelector('#email-form');
  ef.onsubmit = async (e) => {
    e.preventDefault();
    ef.querySelector('#email-error').textContent = '';
    try { const r = await api.changeEmail(session.uid, ef.email.value.trim()); session.user = { ...session.user, email: r.user.email }; session.notify(); toast(tx('account.security.email_address_changed')); security(panel); } catch (ex) {
      if (ex.code !== 'step_up_cancelled') ef.querySelector('#email-error').textContent = ex.message;
    }
  };

  for (const b of panel.querySelectorAll('[data-revoke]')) {
    b.onclick = async () => {
      const r = await api.revokeSession(session.uid, b.dataset.revoke);
      if (r.signed_out) { signedOut(); return; }
      toast(tx('account.security.device_signed_out'));
      security(panel);
    };
  }
  panel.querySelector('[data-testid=signout-everywhere]').onclick = async () => {
    if (!confirm(tx('account.security.sign_out_of_parlance_on'))) return;
    await api.revokeAllSessions(session.uid);
    signedOut();
  };
}

async function limits(panel) {
  const [d, t, s] = await Promise.all(['deposit', 'trading', 'session'].map((k) => api.limit(session.uid, k)));
  const pend = (l, unit) => (l.pending ? `<div class="faint" data-testid="pending">${te('account.limits.change_to_takes_effect_24', { value: esc(l.pending[unit] == null ? 'no limit' : unit === 'limit_minutes' ? l.pending[unit] + ' min' : money(l.pending[unit])), fmt_date_time: esc(fmtDateTime(l.pending.effective_time)) })}</div>` : '');
  const box = (kind, title, l, unit, used, hint) => `<form class="card panel" data-limit="${esc(kind)}" data-testid="limit-${esc(kind)}"><h2>${esc(title)}</h2><p class="muted">${esc(hint)}</p>
    <p>${te('account.limits.current')} <strong data-testid="limit-value">${esc(l.limit[unit] == null ? tx('account.limits.no_limit') : unit === 'limit_minutes' ? l.limit[unit] + (' ' + tx('account.limits.minutes_per_day')) : money(l.limit[unit]) + (' ' + tx('account.limits.per_day')))}</strong> · <span class="faint">${te('account.limits.used_today', { used: esc(used) })}</span></p>${pend(l.limit, unit)}
    <div class="inline-form"><label class="field">${unit === 'limit_minutes' ? te('account.limits.minutes_per_day') : esc(T('currency.per_day', { mode: amountLabel() }))}<input name="v" type="number" min="1" step="${unit === 'limit_minutes' ? 1 : esc(moneyStep())}" placeholder="${te('account.limits.no_limit')}"></label>
    <button class="btn btn-primary" type="submit">${te('account.limits.set_limit')}</button><button class="btn" type="button" data-remove>${te('account.limits.remove_limit')}</button></div><div class="form-error" role="alert"></div></form>`;
  panel.innerHTML = box('deposit', tx('account.limits.deposit_limit'), d, 'limit_dollars', money(d.limit.used_today_dollars), tx('account.limits.caps_how_much_you_can'))
    + box('trading', tx('account.limits.trading_limit'), t, 'limit_dollars', money(t.limit.used_today_dollars), tx('account.limits.caps_the_total_cost_of'))
    + box('session', tx('account.limits.daily_session_time'), s, 'limit_minutes', `${Math.floor(s.limit.used_today_seconds / 60)} min`, tx('account.limits.locks_trading_and_browsing_in'));
  for (const f of panel.querySelectorAll('[data-limit]')) {
    const kind = f.dataset.limit;
    const key = kind === 'session' ? 'limit_minutes' : 'limit_dollars';
    const save = async (v) => {
      try { await api.setLimit(session.uid, kind, { [key]: v }); toast(tx('account.limits.limit_updated')); limits(panel); } catch (ex) { f.querySelector('.form-error').textContent = ex.message; }
    };
    f.onsubmit = (e) => { e.preventDefault(); if (f.v.value) save(kind === 'session' ? Number(f.v.value) : toApiDollars(f.v.value)); }; // naira ÷ 100 = limit_dollars
    f.querySelector('[data-remove]').onclick = () => save(null);
  }
}

async function alerts(panel) {
  const { price_targets: list } = await api.priceTargets(session.uid);
  panel.innerHTML = `<section class="card panel" data-testid="alerts-panel"><h2>${te('account.alerts.price_alerts')}</h2><p class="muted">${te('account.alerts.create_alerts_from_any_market')}</p>
    <table class="table"><thead><tr><th>${te('account.alerts.market')}</th><th>${te('account.alerts.when_yes_is')}</th><th>${te('account.alerts.status')}</th><th></th></tr></thead><tbody>
    ${list.map((t) => `<tr data-alert="${esc(t.id)}"><td>${esc(t.market_title)}</td><td>${esc(t.direction)} ${esc(pxCents(Math.round(Number(t.price_dollars) * 100)))}</td><td>${t.triggered_time ? te('account.alerts.triggered', { rel_time: relTime(t.triggered_time) }) : te('account.alerts.active')}</td><td><button class="btn btn-sm" data-del>${te('account.alerts.delete')}</button></td></tr>`).join('') || `<tr><td colspan="4" class="faint">${te('account.alerts.no_price_alerts_yet')}</td></tr>`}</tbody></table></section>`;
  for (const b of panel.querySelectorAll('[data-del]')) b.onclick = async () => { await api.deletePriceTarget(session.uid, b.closest('[data-alert]').dataset.alert); toast(tx('account.alerts.alert_deleted')); alerts(panel); };
}
