// Sign in / sign up (spec §4.7; reduced wizard: account → profile).
import { session } from '../store.js';
import { toast } from '../lib.js';

export async function render({ el, params, query, navigate }) {
  const next = query.get('next') && query.get('next').startsWith('/') ? query.get('next') : '/';
  if (session.user) { navigate(next, { replace: true }); return; }
  const signUp = params.mode === 'sign-up';
  document.title = `${signUp ? 'Create your account' : 'Log in'} · Parlance`;
  el.innerHTML = `<form class="card auth-card" id="auth-form" novalidate>
    <h1>${signUp ? 'Create your account' : 'Welcome back'}</h1>
    <p class="muted">${signUp ? 'Trade on outcomes with simulated funds.' : 'Log in to trade and manage your portfolio.'}</p>
    ${signUp ? '<label class="field">Display name<input name="display_name" autocomplete="nickname" required minlength="2" maxlength="40"></label>' : ''}
    <label class="field">Email<input name="email" type="email" autocomplete="email" required></label>
    <label class="field">Password<input name="password" type="password" autocomplete="${signUp ? 'new-password' : 'current-password'}" required minlength="8"></label>
    <div class="form-error" id="auth-error" role="alert"></div>
    <button class="btn btn-primary" style="width:100%" type="submit">${signUp ? 'Sign up' : 'Log in'}</button>
    <p class="faint" style="text-align:center">${signUp ? 'Already have an account? <a href="/sign-in" data-link>Log in</a>' : 'New here? <a href="/sign-up" data-link>Create an account</a>'}</p>
  </form>`;
  const form = el.querySelector('#auth-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const err = el.querySelector('#auth-error');
    err.textContent = '';
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      if (signUp) await session.signup({ display_name: f.get('display_name'), email: f.get('email'), password: f.get('password') });
      else await session.login(f.get('email'), f.get('password'));
      toast(signUp ? 'Account created' : 'Logged in');
      navigate(next, { replace: true });
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
    }
  };
}
