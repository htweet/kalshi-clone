// Identity pages (CLONE_SPEC §25): email verification link, forgot / reset password (signed single-use links), the OAuth
// callback route (spec §4.7 `/oauth-web/{provider}/callback`) and the local dev mailbox (never in production).
import { session } from '../store.js';
import { idApi } from '../identity-api.js';
import { esc, toast, relTime } from '../lib.js';
import { PASSWORD_RULES, authMessage } from './auth.js';

// card(inner) takes markup: every caller builds it from templates this file's lint rule checks.
const card = (inner, testid = '') => `<div class="card auth-card"${testid ? ` data-testid="${esc(testid)}"` : ''}>${inner /* eslint-disable-line parlance/no-unescaped-html -- markup by contract, see above */}</div>`;
const cap = (s) => (s ? `${String(s)[0].toUpperCase()}${String(s).slice(1)}` : '');

export async function render(ctx) {
  const { page } = ctx.params;
  if (page === 'verify-email') return verifyEmail(ctx);
  if (page === 'forgot') return forgot(ctx);
  if (page === 'reset') return reset(ctx);
  if (page === 'oauth') return oauthCallback(ctx);
  if (page === 'mailbox') return mailbox(ctx);
}

// After any sign-in: identity onboarding first when it gates trading and the user isn't verified yet.
export async function afterSignIn(navigate, next = '/') {
  try {
    const cfg = await idApi.config();
    // Staff accounts go straight to where they were going (the banner still offers verification).
    if (cfg.kyc_required && !session.user?.is_admin && !(session.user?.admin_roles || []).length) {
      const s = await idApi.state(session.uid);
      if (!['approved', 'pending', 'review', 'rejected', 'closed'].includes(s.status) && !s.skipped) { navigate(`/sign-up/identity?next=${encodeURIComponent(next)}`, { replace: true }); return; }
    }
  } catch { /* fall through */ }
  navigate(next, { replace: true });
}

async function verifyEmail({ el, query }) {
  document.title = 'Verify email · Parlance';
  el.innerHTML = card('<h1>Confirming your email…</h1>', 'verify-email');
  try {
    await idApi.verifyEmail(query.get('token') || '');
    el.innerHTML = card(`<h1>Email confirmed</h1><p class="muted" data-testid="verify-email-ok">Thanks — your email address is verified.</p><p class="ta-c mt-16"><a class="btn btn-primary" href="${session.user ? '/account/privacy' : '/sign-in'}" data-link>Continue</a></p>`, 'verify-email');
  } catch (ex) {
    el.innerHTML = card(`<h1>Link not valid</h1><p class="muted" data-testid="verify-email-error">${esc(cap(ex.message))}.</p><p class="faint">${esc(ex.details || '')}</p><p class="ta-c mt-16"><a class="btn" href="/" data-link>Go home</a></p>`, 'verify-email');
  }
}

async function forgot({ el }) {
  document.title = 'Reset your password · Parlance';
  el.innerHTML = `<form class="card auth-card" id="forgot-form" novalidate data-testid="forgot-form"><h1>Reset your password</h1>
    <p class="muted">Enter the email you use for Parlance. If it belongs to an account, we’ll send a link to choose a new password.</p>
    <label class="field">Email<input name="email" type="email" autocomplete="email" required data-testid="forgot-email"></label>
    <div class="form-error" role="alert" id="forgot-error"></div>
    <button class="btn btn-primary w-full h-48" type="submit">Send reset link</button>
    <p class="faint ta-c mt-16"><a href="/sign-in" data-link class="c-brand">Back to log in</a></p></form>`;
  const f = el.querySelector('#forgot-form');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = f.querySelector('#forgot-error');
    err.textContent = '';
    try {
      await session.preAuth();
      const r = await idApi.requestReset(f.email.value.trim());
      f.outerHTML = card(`<h1>Check your email</h1><p class="muted" data-testid="forgot-sent">${esc(r.message)}</p><p class="faint">The link works once and expires in 30 minutes.</p><p class="ta-c mt-16"><a class="btn" href="/sign-in" data-link>Back to log in</a></p>`, 'forgot-done');
    } catch (ex) { err.textContent = cap(ex.fields ? Object.values(ex.fields).join('. ') : ex.message); }
  };
}

async function reset({ el, query, navigate }) {
  document.title = 'Choose a new password · Parlance';
  const token = query.get('token') || '';
  const ok = await idApi.resetValid(token).then((r) => r.valid).catch(() => false);
  if (!ok) {
    el.innerHTML = card(`<h1>Reset link not valid</h1><p class="muted" data-testid="reset-invalid">This link is invalid, has expired or was already used.</p><p class="ta-c mt-16"><a class="btn btn-primary" href="/forgot-password" data-link>Request a new link</a></p>`, 'reset-invalid-card');
    return;
  }
  el.innerHTML = `<form class="card auth-card" id="reset-form" novalidate data-testid="reset-form"><h1>Choose a new password</h1>
    <p class="muted">Your other sessions will be signed out.</p>
    <label class="field">New password<input name="password" type="password" autocomplete="new-password" required data-testid="reset-password"></label>
    <label class="field">Confirm new password<input name="confirm" type="password" autocomplete="new-password" required data-testid="reset-confirm"></label>
    <p class="faint mt-6 mb-8">${esc(PASSWORD_RULES)}</p>
    <div class="form-error" role="alert" id="reset-error" data-testid="reset-error"></div>
    <button class="btn btn-primary w-full h-48" type="submit">Set new password</button></form>`;
  const f = el.querySelector('#reset-form');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = f.querySelector('#reset-error');
    err.textContent = '';
    if (f.password.value !== f.confirm.value) { err.textContent = 'The two passwords do not match.'; return; }
    try {
      await session.preAuth();
      await idApi.confirmReset(token, f.password.value);
      if (session.user) session.clearLocal();
      toast('Password changed. Log in with your new password.');
      navigate('/sign-in', { replace: true });
    } catch (ex) { err.textContent = authMessage(ex); }
  };
}

async function oauthCallback({ el, params, query, navigate }) {
  const provider = params.provider;
  document.title = 'Signing in · Parlance';
  el.innerHTML = card('<h1>Signing you in…</h1>', 'oauth-callback');
  const fail = (msg) => { el.innerHTML = card(`<h1>Sign-in didn’t work</h1><p class="muted" data-testid="oauth-error">${esc(msg)}</p><p class="ta-c mt-16"><a class="btn btn-primary" href="/sign-in" data-link>Back to log in</a></p>`, 'oauth-callback'); };
  if (query.get('error')) { fail(query.get('error') === 'access_denied' ? 'You cancelled signing in.' : 'The provider reported an error.'); return; }
  let r;
  try {
    await session.preAuth();
    r = await idApi.oauthCallback(provider, { code: query.get('code') || '', state: query.get('state') || '' });
  } catch (ex) { if (session.user) await session.load(); fail(ex.code === 'oauth_email_unverified' ? `${cap(ex.message)}. ${cap(ex.details || '')}.` : `${cap(ex.message)}.`); return; }
  if (r.linked) { await session.load(); toast(`${cap(provider)} is linked to your account`); navigate('/account/privacy', { replace: true }); return; }
  const done = async (res) => { const out = await session.afterAuth(res); if (out && out.mfa_token) return mfa(out.mfa_token); toast('Logged in'); return afterSignIn(navigate, '/'); };
  function mfa(mfaToken) {
    el.innerHTML = `<form class="card auth-card" id="oa-mfa" novalidate><h1>Two-factor login</h1><p class="muted">Enter the 6-digit code from your authenticator app.</p>
      <label class="field">Code<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required data-testid="mfa-code"></label><div class="form-error" role="alert" id="oa-err"></div>
      <button class="btn btn-primary w-full h-48" type="submit">Verify</button></form>`;
    const f = el.querySelector('#oa-mfa');
    f.code.focus();
    f.onsubmit = async (e) => { e.preventDefault(); try { const out = await session.loginMfa(mfaToken, f.code.value.trim()); if (!out) { toast('Logged in'); afterSignIn(navigate, '/'); } } catch { f.querySelector('#oa-err').textContent = 'That code is not valid. Try again.'; } };
  }
  if (r.link_required) {
    el.innerHTML = `<form class="card auth-card" id="oa-link" novalidate data-testid="oauth-link-form"><h1>Link your ${esc(cap(provider))} account</h1>
      <p class="muted">An account for <strong>${esc(r.email_masked)}</strong> already exists. Enter its Parlance password once to link ${esc(cap(provider))} sign-in to it.</p>
      <label class="field">Parlance password<input name="password" type="password" autocomplete="current-password" required data-testid="oauth-link-password"></label>
      <div class="form-error" role="alert" id="oa-err" data-testid="oauth-link-error"></div><button class="btn btn-primary w-full h-48" type="submit">Link and log in</button>
      <p class="faint ta-c mt-16"><a href="/sign-in" data-link>Cancel</a></p></form>`;
    const f = el.querySelector('#oa-link');
    f.password.focus();
    f.onsubmit = async (e) => {
      e.preventDefault();
      try { await session.preAuth(); await done(await idApi.oauthLink({ link_token: r.link_token, password: f.password.value })); } catch (ex) { f.querySelector('#oa-err').textContent = ex.code === 'invalid_password' ? 'That password is not correct.' : authMessage(ex); }
    };
    return;
  }
  await done(r);
}

async function mailbox({ el }) {
  document.title = 'Dev mailbox · Parlance';
  let mail; let sms;
  try { [mail, sms] = await Promise.all([idApi.devMailbox(), idApi.devSms()]); } catch {
    el.innerHTML = '<div class="card empty" data-testid="mailbox-unavailable"><h1 class="typ-title-x20">Not available</h1><p class="muted">The dev mailbox only exists in development builds.</p></div>';
    return;
  }
  // The body is escaped first; the URLs found in that escaped text are wrapped as they are (already escaped).
  // eslint-disable-next-line parlance/no-unescaped-html -- m is a substring of esc(body), matched as an http(s) URL
  const linkify = (body) => esc(body).replace(/(https?:\/\/[^\s<"]+)/g, (m) => `<a href="${m}" class="c-brand" data-testid="mail-link">${m}</a>`);
  el.innerHTML = `<div class="page-head"><h1 class="page-title">Dev mailbox</h1><p class="muted">Emails and text messages the server would have sent (transport: ${esc(mail.transport)} / ${esc(sms.transport)}). Development only.</p></div>
    <div class="dev-mailbox"><section class="card panel" data-testid="mailbox-emails"><h2>Email</h2>${mail.messages.map((m) => `<article class="dev-mail" data-testid="mail-item"><div class="faint">${esc(relTime(m.time))} · to ${esc(m.to)}</div><h3>${esc(m.subject)}</h3>
      <pre class="dev-mail-body">${linkify(m.body)}</pre></article>`).join('') || '<p class="faint">No emails yet.</p>'}</section>
    <section class="card panel" data-testid="mailbox-sms"><h2>Text messages</h2>${sms.messages.map((m) => `<article class="dev-mail" data-testid="sms-item"><div class="faint">${esc(relTime(m.time))} · to ${esc(m.to)}</div><p>${esc(m.body)}</p></article>`).join('') || '<p class="faint">No text messages yet.</p>'}</section></div>`;
}
