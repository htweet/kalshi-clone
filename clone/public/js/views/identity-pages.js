// Identity pages (CLONE_SPEC §25): email verification link, forgot / reset password (signed single-use links), the OAuth
// callback route (spec §4.7 `/oauth-web/{provider}/callback`) and the local dev mailbox (never in production).
import { t, te } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/identity-pages-strings.js';
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
  document.title = t('identity-pages.verify_email.verify_email_parlance');
  el.innerHTML = card(`<h1>${te('identity-pages.verify_email.confirming_your_email')}</h1>`, 'verify-email');
  try {
    await idApi.verifyEmail(query.get('token') || '');
    el.innerHTML = card(`<h1>${te('identity-pages.verify_email.email_confirmed')}</h1><p class="muted" data-testid="verify-email-ok">${te('identity-pages.verify_email.thanks_your_email_address_is')}</p><p class="ta-c mt-16"><a class="btn btn-primary" href="${session.user ? '/account/privacy' : '/sign-in'}" data-link>${te('identity-pages.verify_email.continue')}</a></p>`, 'verify-email');
  } catch (ex) {
    el.innerHTML = card(`<h1>${te('identity-pages.verify_email.link_not_valid')}</h1><p class="muted" data-testid="verify-email-error">${esc(cap(ex.message))}.</p><p class="faint">${esc(ex.details || '')}</p><p class="ta-c mt-16"><a class="btn" href="/" data-link>${te('identity-pages.verify_email.go_home')}</a></p>`, 'verify-email');
  }
}

async function forgot({ el }) {
  document.title = t('identity-pages.forgot.reset_your_password_parlance');
  el.innerHTML = `<form class="card auth-card" id="forgot-form" novalidate data-testid="forgot-form"><h1>${te('identity-pages.forgot.reset_your_password')}</h1>
    <p class="muted">${te('identity-pages.forgot.enter_the_email_you_use')}</p>
    <label class="field">${te('identity-pages.forgot.email')}<input name="email" type="email" autocomplete="email" required data-testid="forgot-email"></label>
    <div class="form-error" role="alert" id="forgot-error"></div>
    <button class="btn btn-primary w-full h-48" type="submit">${te('identity-pages.forgot.send_reset_link')}</button>
    <p class="faint ta-c mt-16"><a href="/sign-in" data-link class="c-brand">${te('identity-pages.forgot.back_to_log_in')}</a></p></form>`;
  const f = el.querySelector('#forgot-form');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = f.querySelector('#forgot-error');
    err.textContent = '';
    try {
      await session.preAuth();
      const r = await idApi.requestReset(f.email.value.trim());
      f.outerHTML = card(`<h1>${te('identity-pages.forgot.check_your_email')}</h1><p class="muted" data-testid="forgot-sent">${esc(r.message)}</p><p class="faint">${te('identity-pages.forgot.the_link_works_once_and')}</p><p class="ta-c mt-16"><a class="btn" href="/sign-in" data-link>${te('identity-pages.forgot.back_to_log_in')}</a></p>`, 'forgot-done');
    } catch (ex) { err.textContent = cap(ex.fields ? Object.values(ex.fields).join('. ') : ex.message); }
  };
}

async function reset({ el, query, navigate }) {
  document.title = t('identity-pages.reset.choose_a_new_password_parlance');
  const token = query.get('token') || '';
  const ok = await idApi.resetValid(token).then((r) => r.valid).catch(() => false);
  if (!ok) {
    el.innerHTML = card(`<h1>${te('identity-pages.reset.reset_link_not_valid')}</h1><p class="muted" data-testid="reset-invalid">${te('identity-pages.reset.this_link_is_invalid_has')}</p><p class="ta-c mt-16"><a class="btn btn-primary" href="/forgot-password" data-link>${te('identity-pages.reset.request_a_new_link')}</a></p>`, 'reset-invalid-card');
    return;
  }
  el.innerHTML = `<form class="card auth-card" id="reset-form" novalidate data-testid="reset-form"><h1>${te('identity-pages.reset.choose_a_new_password')}</h1>
    <p class="muted">${te('identity-pages.reset.your_other_sessions_will_be')}</p>
    <label class="field">${te('identity-pages.reset.new_password')}<input name="password" type="password" autocomplete="new-password" required data-testid="reset-password"></label>
    <label class="field">${te('identity-pages.reset.confirm_new_password')}<input name="confirm" type="password" autocomplete="new-password" required data-testid="reset-confirm"></label>
    <p class="faint mt-6 mb-8">${esc(PASSWORD_RULES)}</p>
    <div class="form-error" role="alert" id="reset-error" data-testid="reset-error"></div>
    <button class="btn btn-primary w-full h-48" type="submit">${te('identity-pages.reset.set_new_password')}</button></form>`;
  const f = el.querySelector('#reset-form');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = f.querySelector('#reset-error');
    err.textContent = '';
    if (f.password.value !== f.confirm.value) { err.textContent = t('identity-pages.reset.the_two_passwords_do_not'); return; }
    try {
      await session.preAuth();
      await idApi.confirmReset(token, f.password.value);
      if (session.user) session.clearLocal();
      toast(t('identity-pages.reset.password_changed_log_in_with'));
      navigate('/sign-in', { replace: true });
    } catch (ex) { err.textContent = authMessage(ex); }
  };
}

async function oauthCallback({ el, params, query, navigate }) {
  const provider = params.provider;
  document.title = t('identity-pages.oauth_callback.signing_in_parlance');
  el.innerHTML = card(`<h1>${te('identity-pages.oauth_callback.signing_you_in')}</h1>`, 'oauth-callback');
  const fail = (msg) => { el.innerHTML = card(`<h1>${te('identity-pages.oauth_callback.sign_in_didn_t_work')}</h1><p class="muted" data-testid="oauth-error">${esc(msg)}</p><p class="ta-c mt-16"><a class="btn btn-primary" href="/sign-in" data-link>${te('identity-pages.oauth_callback.back_to_log_in')}</a></p>`, 'oauth-callback'); };
  if (query.get('error')) { fail(query.get('error') === 'access_denied' ? t('identity-pages.oauth_callback.you_cancelled_signing_in') : t('identity-pages.oauth_callback.the_provider_reported_an_error')); return; }
  let r;
  try {
    await session.preAuth();
    r = await idApi.oauthCallback(provider, { code: query.get('code') || '', state: query.get('state') || '' });
  } catch (ex) { if (session.user) await session.load(); fail(ex.code === 'oauth_email_unverified' ? `${cap(ex.message)}. ${cap(ex.details || '')}.` : `${cap(ex.message)}.`); return; }
  if (r.linked) { await session.load(); toast(t('identity-pages.oauth_callback.is_linked_to_your_account', { cap: cap(provider) })); navigate('/account/privacy', { replace: true }); return; }
  const done = async (res) => { const out = await session.afterAuth(res); if (out && out.mfa_token) return mfa(out.mfa_token); toast(t('identity-pages.oauth_callback.logged_in')); return afterSignIn(navigate, '/'); };
  function mfa(mfaToken) {
    el.innerHTML = `<form class="card auth-card" id="oa-mfa" novalidate><h1>${te('identity-pages.oauth_callback.two_factor_login')}</h1><p class="muted">${te('identity-pages.oauth_callback.enter_the_6_digit_code')}</p>
      <label class="field">${te('identity-pages.oauth_callback.code')}<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required data-testid="mfa-code"></label><div class="form-error" role="alert" id="oa-err"></div>
      <button class="btn btn-primary w-full h-48" type="submit">${te('identity-pages.oauth_callback.verify')}</button></form>`;
    const f = el.querySelector('#oa-mfa');
    f.code.focus();
    f.onsubmit = async (e) => { e.preventDefault(); try { const out = await session.loginMfa(mfaToken, f.code.value.trim()); if (!out) { toast(t('identity-pages.oauth_callback.logged_in')); afterSignIn(navigate, '/'); } } catch { f.querySelector('#oa-err').textContent = t('identity-pages.oauth_callback.that_code_is_not_valid'); } };
  }
  if (r.link_required) {
    el.innerHTML = `<form class="card auth-card" id="oa-link" novalidate data-testid="oauth-link-form"><h1>${te('identity-pages.oauth_callback.link_your_account', { cap: esc(cap(provider)) })}</h1>
      <p class="muted">${te('identity-pages.oauth_callback.an_account_for')} <strong>${esc(r.email_masked)}</strong> ${te('identity-pages.oauth_callback.already_exists_enter_its_parlance', { cap: esc(cap(provider)) })}</p>
      <label class="field">${te('identity-pages.oauth_callback.parlance_password')}<input name="password" type="password" autocomplete="current-password" required data-testid="oauth-link-password"></label>
      <div class="form-error" role="alert" id="oa-err" data-testid="oauth-link-error"></div><button class="btn btn-primary w-full h-48" type="submit">${te('identity-pages.oauth_callback.link_and_log_in')}</button>
      <p class="faint ta-c mt-16"><a href="/sign-in" data-link>${te('identity-pages.oauth_callback.cancel')}</a></p></form>`;
    const f = el.querySelector('#oa-link');
    f.password.focus();
    f.onsubmit = async (e) => {
      e.preventDefault();
      try { await session.preAuth(); await done(await idApi.oauthLink({ link_token: r.link_token, password: f.password.value })); } catch (ex) { f.querySelector('#oa-err').textContent = ex.code === 'invalid_password' ? t('identity-pages.oauth_callback.that_password_is_not_correct') : authMessage(ex); }
    };
    return;
  }
  await done(r);
}

async function mailbox({ el }) {
  document.title = t('identity-pages.mailbox.dev_mailbox_parlance');
  let mail; let sms;
  try { [mail, sms] = await Promise.all([idApi.devMailbox(), idApi.devSms()]); } catch {
    el.innerHTML = `<div class="card empty" data-testid="mailbox-unavailable"><h1 class="typ-title-x20">${te('identity-pages.mailbox.not_available')}</h1><p class="muted">${te('identity-pages.mailbox.the_dev_mailbox_only_exists')}</p></div>`;
    return;
  }
  // The body is escaped first; the URLs found in that escaped text are wrapped as they are (already escaped).
  // eslint-disable-next-line parlance/no-unescaped-html -- m is a substring of esc(body), matched as an http(s) URL
  const linkify = (body) => esc(body).replace(/(https?:\/\/[^\s<"]+)/g, (m) => `<a href="${m}" class="c-brand" data-testid="mail-link">${m}</a>`);
  el.innerHTML = `<div class="page-head"><h1 class="page-title">${te('identity-pages.mailbox.dev_mailbox')}</h1><p class="muted">${te('identity-pages.mailbox.emails_and_text_messages_the', { transport: esc(mail.transport), transport_2: esc(sms.transport) })}</p></div>
    <div class="dev-mailbox"><section class="card panel" data-testid="mailbox-emails"><h2>${te('identity-pages.mailbox.email')}</h2>${mail.messages.map((m) => `<article class="dev-mail" data-testid="mail-item"><div class="faint">${te('identity-pages.mailbox.to', { rel_time: esc(relTime(m.time)), to: esc(m.to) })}</div><h3>${esc(m.subject)}</h3>
      <pre class="dev-mail-body">${linkify(m.body)}</pre></article>`).join('') || `<p class="faint">${te('identity-pages.mailbox.no_emails_yet')}</p>`}</section>
    <section class="card panel" data-testid="mailbox-sms"><h2>${te('identity-pages.mailbox.text_messages')}</h2>${sms.messages.map((m) => `<article class="dev-mail" data-testid="sms-item"><div class="faint">${te('identity-pages.mailbox.to', { rel_time: esc(relTime(m.time)), to: esc(m.to) })}</div><p>${esc(m.body)}</p></article>`).join('') || `<p class="faint">${te('identity-pages.mailbox.no_text_messages_yet')}</p>`}</section></div>`;
}
