// Sign in / sign up (spec §4.7) with the two-factor step (spec §13.9), the forced password change and first-admin
// setup (SEC_IDENTITY_SPEC §22): credentials → (code) → (new password) → signed in.
import { api } from '../api.js';
import { session } from '../store.js';
import { toast, esc } from '../lib.js';

export const PASSWORD_RULES = 'At least 12 characters, mixing at least two of: lowercase, uppercase, digits, symbols. Not your name or email, and not a common breached password.';

// User-facing text for an auth error (policy errors show the specific rule; lockouts the wait).
export function authMessage(ex) {
  if (ex.code === 'weak_password' || ex.code === 'breached_password') { const d = String(ex.details || ex.message); return `${d[0].toUpperCase()}${d.slice(1)}.`; }
  if (ex.code === 'too_many_attempts') return `Too many sign-in attempts. Try again in ${ex.retryAfter || 'a few'} seconds.`;
  return ex.message;
}

const passwordField = (name, label, autocomplete, testid = '') => `<label class="field">${esc(label)}<input name="${esc(name)}" type="password" autocomplete="${esc(autocomplete)}" required${testid ? ` data-testid="${esc(testid)}"` : ''}></label>`;
const rules = '<p class="faint mt-6 mb-8" data-testid="password-rules">' + PASSWORD_RULES + '</p>';
const submit = (label) => `<button class="btn btn-primary w-full h-44" type="submit">${esc(label)}</button>`;

export async function render({ el, params, query, navigate }) {
  const next = query.get('next') && query.get('next').startsWith('/') ? query.get('next') : '/';
  if (params.mode === 'setup') return setup({ el, query, navigate });
  if (session.user) { navigate(next, { replace: true }); return; }
  const signUp = params.mode === 'sign-up';
  document.title = `${signUp ? 'Create your account' : 'Log in'} · Parlance`;
  el.innerHTML = `<form class="card auth-card" id="auth-form" novalidate>
    <h1>${signUp ? 'Create your account' : 'Log in'}</h1>
    <p class="muted">${signUp ? 'Trade on outcomes with simulated funds.' : 'Welcome back. Log in to trade and manage your portfolio.'}</p>
    ${signUp ? '<label class="field">Display name<input name="display_name" autocomplete="name" required minlength="2" maxlength="40"></label>' : ''}
    <label class="field">Email<input name="email" type="email" autocomplete="email" required></label>
    <label class="field">Password<input name="password" type="password" autocomplete="${signUp ? 'new-password' : 'current-password'}" required${signUp ? ' minlength="12"' : ''}></label>
    ${signUp ? rules : ''}
    <div class="form-error" id="auth-error" role="alert"></div>
    ${submit(signUp ? 'Sign up' : 'Log in')}
    <p class="faint ta-c mt-14">${signUp ? 'Already have an account? <a href="/sign-in" data-link class="c-brand">Log in</a>' : 'New here? <a href="/sign-up" data-link class="c-brand">Create an account</a>'}</p>
  </form>`;
  const form = el.querySelector('#auth-form');
  const done = () => { toast(signUp ? 'Account created' : 'Logged in'); navigate(next, { replace: true }); };
  const run = (fn) => async (e) => {
    e.preventDefault();
    const err = form.querySelector('#auth-error');
    const btn = form.querySelector('button[type=submit]');
    err.textContent = ''; btn.disabled = true;
    try { await fn(); } catch (ex) { err.textContent = fn.errorText ? fn.errorText(ex) : authMessage(ex); btn.disabled = false; }
  };
  const after = (r) => { if (!r) done(); else if (r.mfa_token) mfaStep(r.mfa_token); else if (r.change_token) changeStep(r.change_token); };

  function mfaStep(mfaToken) {
    form.innerHTML = `<h1>Two-factor login</h1><p class="muted">Enter the 6-digit code from your authenticator app.</p>
      <label class="field">Code<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required data-testid="mfa-code"></label>
      <div class="form-error" id="auth-error" role="alert"></div>
      ${submit('Verify')}
      <p class="faint ta-c mt-14"><a href="/sign-in" data-link>Start over</a></p>`;
    form.querySelector('input').focus();
    const step = async () => after(await session.loginMfa(mfaToken, form.querySelector('input[name=code]').value.trim()));
    step.errorText = (ex) => (ex.code === 'mfa_challenge_expired' || ex.code === 'account_locked' ? `${ex.message}.` : 'That code is not valid. Try again.');
    form.onsubmit = run(step);
  }

  // An administrator required a new password (SEC_IDENTITY_SPEC §22.4): no session until it is set.
  function changeStep(changeToken) {
    form.innerHTML = `<h1>Choose a new password</h1><p class="muted">Parlance support asked you to set a new password before continuing.</p>
      ${passwordField('new_password', 'New password', 'new-password', 'new-password')}${passwordField('confirm', 'Confirm new password', 'new-password', 'confirm-password')}
      ${rules}<div class="form-error" id="auth-error" role="alert"></div>${submit('Set password and continue')}`;
    form.querySelector('input').focus();
    form.onsubmit = run(async () => {
      if (form.new_password.value !== form.confirm.value) throw Object.assign(new Error('The two passwords do not match.'), { code: 'mismatch' });
      await session.completePasswordChange(changeToken, form.new_password.value);
      toast('Password changed'); navigate(next, { replace: true });
    });
  }

  form.onsubmit = run(async () => {
    const f = new FormData(form);
    if (signUp) { await session.signup({ display_name: f.get('display_name'), email: f.get('email'), password: f.get('password') }); done(); return; }
    after(await session.login(f.get('email'), f.get('password')));
  });
}

// First-admin setup from the one-time URL printed at start-up (no default admin password exists).
async function setup({ el, query, navigate }) {
  document.title = 'Set up Parlance · Parlance';
  const tok = query.get('token') || '';
  const st = await api.setupStatus(tok).catch(() => ({ valid: false }));
  if (!st.valid) {
    el.innerHTML = `<div class="card auth-card" role="alert" data-testid="setup-invalid"><h1>Setup link not valid</h1>
      <p class="muted">This setup link is invalid, has expired or was already used. Restart the server for a new link, set ADMIN_EMAIL and ADMIN_PASSWORD, or run <code>npm run create-admin</code>.</p>
      <p class="ta-c mt-14"><a class="btn" href="/" data-link>Go home</a></p></div>`;
    return;
  }
  el.innerHTML = `<form class="card auth-card" id="auth-form" novalidate data-testid="setup-form">
    <h1>Create the first admin</h1><p class="muted">This single-use link expires ${new Date(st.expires_time).toLocaleTimeString()}.</p>
    <label class="field">Display name<input name="display_name" autocomplete="name" required minlength="2" maxlength="40"></label>
    <label class="field">Email<input name="email" type="email" autocomplete="email" required></label>
    ${passwordField('password', 'Password', 'new-password')}${rules}
    <div class="form-error" id="auth-error" role="alert"></div>${submit('Create admin account')}</form>`;
  const form = el.querySelector('#auth-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = form.querySelector('#auth-error');
    const btn = form.querySelector('button[type=submit]');
    err.textContent = ''; btn.disabled = true;
    try {
      await session.setupAdmin({ token: tok, display_name: form.display_name.value, email: form.email.value, password: form.password.value });
      toast('Admin account created');
      navigate('/admin', { replace: true });
    } catch (ex) { err.textContent = authMessage(ex); btn.disabled = false; }
  };
}
