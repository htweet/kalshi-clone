// Step-up verification modal (CLONE_SPEC §22.6, mirrors action_verification_mfa): a sensitive request
// answered with 403 step_up_required opens this dialog; after a successful password / two-factor check the
// original request is retried once by api.request(). Cancelling rejects with code step_up_cancelled.
import { t, te } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/stepup-strings.js';
import { api, ApiError } from '../api.js';
import { esc } from '../lib.js';

const LABELS = {
  mfa_disable: 'turn off two-factor login', password_change: 'change your password', email_change: 'change your email address',
  withdrawal_mfa: 'change withdrawal verification', withdrawal: 'withdraw funds', large_deposit: 'make a large deposit',
  large_transfer: 'make a large transfer', admin_role_change: 'change staff roles', admin_force_password_reset: 'force a password reset',
  // Phase 3 (CLONE_SPEC §25)
  data_export: 'download your data', account_closure: 'close your account', phone_change: 'change your phone number', passkey_add: 'add a passkey',
  passkey_remove: 'remove a passkey', oauth_link: 'link a sign-in provider', oauth_unlink: 'unlink a sign-in provider', kyc_decision: 'decide an identity verification',
  withdrawal_hold_decision: 'decide a held withdrawal',
  // Phase 4 (CLONE_SPEC.md §26)
  payout_destination: 'add a withdrawal destination',
  // Phase 5A (CLONE_SPEC.md §28.7)
  settlement_correction: 'correct a settled market', resolution_policy: 'change the resolution approval rule', payments_settings: 'change payment settings', payments_recon_resolve: 'resolve a reconciliation item', aml_case_decision: 'decide an AML case',
};

let open = null; // one dialog at a time; concurrent callers share it

export function stepUp(err) {
  if (open) return open;
  const all = Array.isArray(err.methods) && err.methods.length ? err.methods : ['password'];
  const methods = all.filter((m) => m !== 'passkey').length ? all.filter((m) => m !== 'passkey') : ['password'];
  const passkey = all.includes('passkey'); // a user-verified passkey assertion also confirms it's you (CLONE_SPEC §25)
  const action = LABELS[err.action] || 'continue';
  open = new Promise((resolve, reject) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'stepup-dialog';
    dlg.dataset.testid = 'step-up-dialog';
    let mode = methods[0];
    const draw = () => {
      dlg.innerHTML = `<form method="dialog" class="stepup-form" novalidate>
        <h2>${te('stepup.step_up.confirm_it_s_you')}</h2>
        <p class="muted">${te('stepup.step_up.to', { action: esc(action), value: mode === 'totp' ? te('stepup.step_up.enter_the_6_digit_code') : te('stepup.step_up.enter_your_password') })}</p>
        ${mode === 'totp'
    ? `<label class="field">${te('stepup.step_up.two_factor_code')}<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required data-testid="step-up-code"></label>`
    : `<label class="field">${te('stepup.step_up.password')}<input name="password" type="password" autocomplete="current-password" required data-testid="step-up-password"></label>`}
        ${methods.length > 1 ? `<button type="button" class="btn btn-ghost btn-sm" data-switch data-testid="step-up-switch">${mode === 'totp' ? te('stepup.step_up.use_your_password_instead') : te('stepup.step_up.use_a_two_factor_code')}</button>` : ''}
        ${passkey ? `<button type="button" class="btn btn-sm" data-passkey data-testid="step-up-passkey">${te('stepup.step_up.use_a_passkey')}</button>` : ''}
        <div class="form-error" role="alert" data-testid="step-up-error"></div>
        <div class="stepup-actions"><button type="button" class="btn" data-cancel data-testid="step-up-cancel">${te('stepup.step_up.cancel')}</button><button type="submit" class="btn btn-primary" data-testid="step-up-submit">${te('stepup.step_up.confirm')}</button></div>
      </form>`;
      dlg.querySelector('input').focus();
      dlg.querySelector('[data-switch]')?.addEventListener('click', () => { mode = mode === 'totp' ? 'password' : 'totp'; draw(); });
      dlg.querySelector('[data-cancel]').addEventListener('click', () => finish(false));
      dlg.querySelector('[data-passkey]')?.addEventListener('click', async () => {
        const box = dlg.querySelector('[data-testid=step-up-error]');
        box.textContent = '';
        try {
          const [{ idApi }, { getPasskey }] = await Promise.all([import('../identity-api.js'), import('../webauthn-client.js')]);
          await idApi.passkeyStepUp(await getPasskey(await idApi.passkeyStepUpOptions()));
          finish(true);
        } catch (ex) { box.textContent = ex.name === 'NotAllowedError' ? t('stepup.step_up.passkey_check_was_cancelled') : ex.message; }
      });
      dlg.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.currentTarget;
        const btn = f.querySelector('[type=submit]');
        const box = f.querySelector('[data-testid=step-up-error]');
        box.textContent = ''; btn.disabled = true;
        try {
          await api.stepUp(mode === 'totp' ? { code: f.code.value.trim() } : { password: f.password.value });
          finish(true);
        } catch (ex) {
          box.textContent = ex.code === 'too_many_attempts' ? t('stepup.step_up.too_many_attempts_try_again', { value: ex.retryAfter || t('stepup.step_up.a_few') }) : ex.code === 'invalid_mfa_code' ? t('stepup.step_up.that_code_is_not_valid') : ex.code === 'invalid_password' ? t('stepup.step_up.that_password_is_not_correct') : ex.message;
          btn.disabled = false;
        }
      });
    };
    let done = false;
    function finish(ok) {
      if (done) return;
      done = true;
      dlg.close(); dlg.remove(); open = null;
      if (ok) resolve(); else reject(new ApiError(403, { error: { code: 'step_up_cancelled', message: 'verification cancelled' } }));
    }
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(false); });
    document.body.appendChild(dlg);
    draw();
    dlg.showModal();
  });
  return open;
}
