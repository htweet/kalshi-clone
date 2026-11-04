// Sign in / sign up (spec §4.7) with the two-factor step (spec §13.9), the forced password change and first-admin
// setup (CLONE_SPEC §22): credentials → (code) → (new password) → signed in.
import { t, te, ts } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/auth-strings.js';
import { api } from '../api.js';
import { session } from '../store.js';
import { toast, esc, fmtTime } from '../lib.js';
import { idApi } from '../identity-api.js';
import { passkeysSupported } from '../webauthn-client.js';

export const PASSWORD_RULES = ts('auth.password_rules.at_least_12_characters_mixing');

// User-facing text for an auth error (policy errors show the specific rule; lockouts the wait).
export function authMessage(ex) {
  if (ex.code === 'weak_password' || ex.code === 'breached_password') { const d = String(ex.details || ex.message); return `${d[0].toUpperCase()}${d.slice(1)}.`; }
  if (ex.code === 'too_many_attempts') return t('auth.auth_message.too_many_sign_in_attempts', { value: ex.retryAfter || 'a few' });
  return ex.message;
}

const passwordField = (name, label, autocomplete, testid = '') => `<label class="field">${esc(label)}<input name="${esc(name)}" type="password" autocomplete="${esc(autocomplete)}" required${testid ? ` data-testid="${esc(testid)}"` : ''}></label>`;
const rules = '<p class="faint mt-6 mb-8" data-testid="password-rules">' + esc(PASSWORD_RULES) + '</p>';
const submit = (label) => `<button class="btn btn-primary w-full h-48" type="submit">${esc(label)}</button>`;

export async function render({ el, params, query, navigate }) {
  const next = query.get('next') && query.get('next').startsWith('/') ? query.get('next') : '/';
  if (params.mode === 'setup') return setup({ el, query, navigate });
  if (session.user) { navigate(next, { replace: true }); return; }
  const signUp = params.mode === 'sign-up';
  document.title = t('auth.render.parlance', { value: signUp ? t('auth.render.create_your_account') : t('auth.render.log_in') });
  el.innerHTML = `<form class="card auth-card" id="auth-form" novalidate>
    <h1>${signUp ? te('auth.render.create_your_account') : te('auth.render.log_in')}</h1>
    <p class="muted">${signUp ? te('auth.render.trade_on_outcomes_with_simulated') : te('auth.render.welcome_back_log_in_to')}</p>
    ${signUp ? `<label class="field">${te('auth.render.display_name')}<input name="display_name" autocomplete="name" required minlength="2" maxlength="40"></label>` : ''}
    <label class="field">${te('auth.render.email')}<input name="email" type="email" autocomplete="email" required></label>
    <label class="field">${te('auth.render.password')}<input name="password" type="password" autocomplete="${signUp ? 'new-password' : 'current-password'}" required${signUp ? ' minlength="12"' : ''}></label>
    ${signUp ? rules : ''}
    <div class="form-error" id="auth-error" role="alert"></div>
    ${submit(signUp ? t('auth.render.sign_up') : t('auth.render.log_in'))}
    ${signUp ? '' : `<p class="auth-forgot"><a href="/forgot-password" data-link class="c-brand" data-testid="forgot-link">${te('auth.render.forgot_password')}</a></p>`}
    <div class="auth-alt" data-auth-alt hidden></div>
    <p class="faint ta-c mt-16">${signUp ? `${te('auth.render.already_have_an_account')} <a href="/sign-in" data-link class="c-brand">${te('auth.render.log_in')}</a>` : `${te('auth.render.new_here')} <a href="/sign-up" data-link class="c-brand">${te('auth.render.create_an_account')}</a>`}</p>
  </form>`;
  const form = el.querySelector('#auth-form');
  // After sign-in or sign-up: identity onboarding first when verification gates trading (CLONE_SPEC §25).
  const done = async () => { toast(signUp ? t('auth.render.account_created') : t('auth.render.logged_in')); const { afterSignIn } = await import('./identity-pages.js'); await afterSignIn(navigate, next); };
  const run = (fn) => async (e) => {
    e.preventDefault();
    const err = form.querySelector('#auth-error');
    const btn = form.querySelector('button[type=submit]');
    err.textContent = ''; btn.disabled = true;
    try { await fn(); } catch (ex) { err.textContent = fn.errorText ? fn.errorText(ex) : authMessage(ex); btn.disabled = false; }
  };
  const after = (r) => { if (!r) done(); else if (r.mfa_token) mfaStep(r.mfa_token); else if (r.change_token) changeStep(r.change_token); };

  function mfaStep(mfaToken) {
    form.innerHTML = `<h1>${te('auth.render.two_factor_login')}</h1><p class="muted">${te('auth.render.enter_the_6_digit_code')}</p>
      <label class="field">${te('auth.render.code')}<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required data-testid="mfa-code"></label>
      <div class="form-error" id="auth-error" role="alert"></div>
      ${submit(t('auth.render.verify'))}
      <p class="faint ta-c mt-16"><a href="/sign-in" data-link>${te('auth.render.start_over')}</a></p>`;
    form.querySelector('input').focus();
    const step = async () => after(await session.loginMfa(mfaToken, form.querySelector('input[name=code]').value.trim()));
    step.errorText = (ex) => (ex.code === 'mfa_challenge_expired' || ex.code === 'account_locked' ? `${ex.message}.` : t('auth.render.that_code_is_not_valid'));
    form.onsubmit = run(step);
  }

  // An administrator required a new password (CLONE_SPEC §22.4): no session until it is set.
  function changeStep(changeToken) {
    form.innerHTML = `<h1>${te('auth.render.choose_a_new_password')}</h1><p class="muted">${te('auth.render.parlance_support_asked_you_to')}</p>
      ${passwordField('new_password', t('auth.render.new_password'), 'new-password', 'new-password')}${passwordField('confirm', t('auth.render.confirm_new_password'), 'new-password', 'confirm-password')}
      ${rules}<div class="form-error" id="auth-error" role="alert"></div>${submit(t('auth.render.set_password_and_continue'))}`;
    form.querySelector('input').focus();
    form.onsubmit = run(async () => {
      if (form.new_password.value !== form.confirm.value) throw Object.assign(new Error(t('auth.render.the_two_passwords_do_not')), { code: 'mismatch' });
      await session.completePasswordChange(changeToken, form.new_password.value);
      toast(t('auth.render.password_changed')); navigate(next, { replace: true });
    });
  }

  form.onsubmit = run(async () => {
    const f = new FormData(form);
    if (signUp) { await session.signup({ display_name: f.get('display_name'), email: f.get('email'), password: f.get('password') }); done(); return; }
    const err = form.querySelector('#auth-error');
    after(await session.login(f.get('email'), f.get('password'), { onCheck: (on) => { err.textContent = on ? t('auth.render.checking_your_browser') : ''; err.dataset.state = on ? 'checking' : ''; } }));
  });

  // Passkey and provider sign-in (CLONE_SPEC §25).
  const alt = form.querySelector('[data-auth-alt]');
  const cfg = await idApi.config().catch(() => null);
  const buttons = [];
  if (!signUp && passkeysSupported() && cfg?.passkeys) buttons.push(`<button type="button" class="btn w-full h-48" data-passkey data-testid="passkey-login">${te('auth.render.log_in_with_a_passkey')}</button>`);
  for (const p of cfg?.oauth_providers || []) buttons.push(`<button type="button" class="btn w-full h-48" data-oauth="${esc(p.id)}" data-testid="oauth-${esc(p.id)}">${te('auth.render.continue_with', { label: esc(p.label), value: p.mock ? ` <span class="faint">${te('auth.render.test')}</span>` : '' })}</button>`);
  if (buttons.length) {
    alt.innerHTML = `<div class="auth-or"><span>${te('auth.render.or')}</span></div>${buttons.join('')}`;
    alt.hidden = false;
    alt.querySelector('[data-passkey]')?.addEventListener('click', run(async () => after(await session.loginPasskey())));
    for (const b of alt.querySelectorAll('[data-oauth]')) b.addEventListener('click', run(async () => { await session.preAuth(); location.assign((await idApi.oauthStart(b.dataset.oauth)).authorization_url); }));
  }
}

// First-admin setup from the one-time URL printed at start-up (no default admin password exists).
async function setup({ el, query, navigate }) {
  document.title = t('auth.setup.set_up_parlance_parlance');
  const tok = query.get('token') || '';
  const st = await api.setupStatus(tok).catch(() => ({ valid: false }));
  if (!st.valid) {
    el.innerHTML = `<div class="card auth-card" role="alert" data-testid="setup-invalid"><h1>${te('auth.setup.setup_link_not_valid')}</h1>
      <p class="muted">${te('auth.setup.this_setup_link_is_invalid')} <code>${te('auth.setup.npm_run_create_admin')}</code>.</p>
      <p class="ta-c mt-16"><a class="btn" href="/" data-link>${te('auth.setup.go_home')}</a></p></div>`;
    return;
  }
  el.innerHTML = `<form class="card auth-card" id="auth-form" novalidate data-testid="setup-form">
    <h1>${te('auth.setup.create_the_first_admin')}</h1><p class="muted">${te('auth.setup.this_single_use_link_expires', { fmt_time: esc(fmtTime(st.expires_time)) })}</p>
    <label class="field">${te('auth.setup.display_name')}<input name="display_name" autocomplete="name" required minlength="2" maxlength="40"></label>
    <label class="field">${te('auth.setup.email')}<input name="email" type="email" autocomplete="email" required></label>
    ${passwordField('password', t('auth.setup.password'), 'new-password')}${rules}
    <div class="form-error" id="auth-error" role="alert"></div>${submit(t('auth.setup.create_admin_account'))}</form>`;
  const form = el.querySelector('#auth-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = form.querySelector('#auth-error');
    const btn = form.querySelector('button[type=submit]');
    err.textContent = ''; btn.disabled = true;
    try {
      await session.setupAdmin({ token: tok, display_name: form.display_name.value, email: form.email.value, password: form.password.value });
      toast(t('auth.setup.admin_account_created'));
      navigate('/admin', { replace: true });
    } catch (ex) { err.textContent = authMessage(ex); btn.disabled = false; }
  };
}
