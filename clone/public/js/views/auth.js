// Sign in / sign up (spec §4.7) with the two-factor step (spec §13.9): credentials → (code) → signed in.
import { session } from '../store.js';
import { toast } from '../lib.js';

export async function render({ el, params, query, navigate }) {
  const next = query.get('next') && query.get('next').startsWith('/') ? query.get('next') : '/';
  if (session.user) { navigate(next, { replace: true }); return; }
  const signUp = params.mode === 'sign-up';
  document.title = `${signUp ? 'Create your account' : 'Log in'} · Parlance`;
  el.innerHTML = `<form class="card auth-card" id="auth-form" novalidate>
    <h1>${signUp ? 'Create your account' : 'Log in'}</h1>
    <p class="muted">${signUp ? 'Trade on outcomes with simulated funds.' : 'Welcome back. Log in to trade and manage your portfolio.'}</p>
    ${signUp ? '<label class="field">Display name<input name="display_name" autocomplete="name" required minlength="2" maxlength="40"></label>' : ''}
    <label class="field">Email<input name="email" type="email" autocomplete="email" required></label>
    <label class="field">Password<input name="password" type="password" autocomplete="${signUp ? 'new-password' : 'current-password'}" required minlength="8"></label>
    <div class="form-error" id="auth-error" role="alert"></div>
    <button class="btn btn-primary" style="width:100%;height:44px" type="submit">${signUp ? 'Sign up' : 'Log in'}</button>
    <p class="faint" style="text-align:center;margin-top:14px">${signUp ? 'Already have an account? <a href="/sign-in" data-link style="color:var(--brand)">Log in</a>' : 'New here? <a href="/sign-up" data-link style="color:var(--brand)">Create an account</a>'}</p>
  </form>`;
  const form = el.querySelector('#auth-form');
  const done = () => { toast(signUp ? 'Account created' : 'Logged in'); navigate(next, { replace: true }); };

  function mfaStep(mfaToken) {
    form.innerHTML = `<h1>Two-factor login</h1><p class="muted">Enter the 6-digit code from your authenticator app.</p>
      <label class="field">Code<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required data-testid="mfa-code"></label>
      <div class="form-error" id="auth-error" role="alert"></div>
      <button class="btn btn-primary" style="width:100%;height:44px" type="submit">Verify</button>
      <p class="faint" style="text-align:center;margin-top:14px"><a href="/sign-in" data-link>Start over</a></p>`;
    form.querySelector('input').focus();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const err = form.querySelector('#auth-error');
      const btn = form.querySelector('button[type=submit]');
      err.textContent = ''; btn.disabled = true;
      try { await session.loginMfa(mfaToken, form.querySelector('input[name=code]').value.trim()); done(); } catch (ex) {
        err.textContent = ex.code === 'mfa_challenge_expired' ? `${ex.message}.` : 'That code is not valid. Try again.';
        btn.disabled = false;
      }
    };
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const err = el.querySelector('#auth-error');
    err.textContent = '';
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      if (signUp) { await session.signup({ display_name: f.get('display_name'), email: f.get('email'), password: f.get('password') }); done(); return; }
      const challenge = await session.login(f.get('email'), f.get('password'));
      if (challenge) mfaStep(challenge.mfa_token); else done();
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
    }
  };
}
