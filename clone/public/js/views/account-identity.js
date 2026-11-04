// Account › Account & security › Identity & privacy (CLONE_SPEC.md §25): verification status with masked details,
// email verification, sign-in methods and passkeys (locked until verified — CLONE_SPEC §13.19 — and behind step-up),
// API keys (Phase 7), location check, withdrawal holds, the retention policy, data export and account closure.
import { t as tx, te, ts } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/account-identity-strings.js';
import { session } from '../store.js';
import { idApi } from '../identity-api.js';
import { esc, toast, relTime, money } from '../lib.js';
import { passkeysSupported, createPasskey } from '../webauthn-client.js';

const STATUS_TEXT = { not_started: ts('account-identity.status_text_not_started.not_started'), in_progress: ts('account-identity.status_text_in_progress.in_progress'), pending: 'Checking', documents_required: ts('account-identity.status_text_documents_required.id_photos_needed'), review: ts('account-identity.status_text_review.under_review'), approved: 'Verified', rejected: ts('account-identity.status_text_rejected.not_verified'), retry: ts('account-identity.status_text_retry.needs_another_try'), closed: 'Closed' };
const locked = (what) => `<div class="a2-locked" data-testid="a2-locked"><strong>${te('account-identity.locked.locked_until_your_identity_is')}</strong> <span class="faint">${te('account-identity.locked.unlock_once_verification_is_approved', { what: esc(what) })}</span> <a class="c-brand" href="/sign-up/identity" data-link>${te('account-identity.locked.verify_identity')}</a></div>`;

export async function render(panel, { navigate }) {
  const uid = session.uid;
  const [id, cfg, geo, holds] = await Promise.all([idApi.identity(uid), idApi.config(), idApi.geolocation(uid).catch(() => null), idApi.holds(uid).catch(() => ({ holds: [] }))]);
  const methods = await idApi.signInMethods(uid).catch((e) => (e.code === 'permission_denied' ? null : Promise.reject(e)));
  const passkeys = methods ? await idApi.passkeys(uid).catch(() => ({ passkeys: [] })) : null;
  const apiKeys = methods ? await idApi.apiKeys(uid).catch(() => null) : null;
  const links = methods ? await idApi.oauthLinks(uid).catch(() => ({ providers: [], linked: [] })) : null;
  const st = id.status;
  panel.innerHTML = `
    <section class="card panel" data-testid="identity-panel"><h2>${te('account-identity.render.identity_verification')}</h2>
      <p>${te('account-identity.render.status')} <strong data-testid="identity-status" data-status="${esc(st)}">${esc(STATUS_TEXT[st] || st)}</strong>${id.verification.reason_message ? ` <span class="faint">· ${esc(id.verification.reason_message)}</span>` : ''}</p>
      ${['approved', 'closed', 'pending', 'review', 'rejected'].includes(st) ? '' : `<a class="btn btn-primary" href="/sign-up/identity?next=/account/privacy" data-link data-testid="identity-continue">${st === 'not_started' ? te('account-identity.render.verify_your_identity') : te('account-identity.render.continue_verification')}</a>`}
      <dl class="id-facts" data-testid="identity-masked"><dt>${te('account-identity.render.legal_name')}</dt><dd>${esc(id.name_masked || '—')}</dd><dt>${te('account-identity.render.date_of_birth')}</dt><dd>${esc(id.dob_masked || '—')}</dd><dt>${te('account-identity.render.address')}</dt><dd>${esc(id.address_masked || '—')}</dd>
        <dt>${te('account-identity.render.national_id')}</dt><dd data-testid="identity-nid">${esc(id.national_id?.masked || '—')}</dd><dt>${te('account-identity.render.phone')}</dt><dd>${esc(id.phone?.masked || '—')}</dd>
        <dt>${te('account-identity.render.email')}</dt><dd>${id.email_verified ? `<span data-testid="email-verified">${te('account-identity.render.verified')}</span>` : `<span data-testid="email-unverified">${te('account-identity.render.not_verified')}</span> <button class="btn btn-sm" data-resend-email data-testid="resend-email">${te('account-identity.render.send_verification_email')}</button>`}</dd></dl>
      <p class="faint">${te('account-identity.render.your_details_are_encrypted_with')}</p></section>

    <section class="card panel" data-testid="signin-methods"><h2>${te('account-identity.render.sign_in_methods')}</h2>
      ${methods ? `<ul class="set-apps"><li><div><strong>${te('account-identity.render.password')}</strong><div class="faint">${methods.password ? te('account-identity.render.set') : te('account-identity.render.not_set_use_forgot_password')}</div></div></li>
        <li><div><strong>${te('account-identity.render.two_factor_login')}</strong><div class="faint">${te('account-identity.render.manage_in_security', { value: methods.two_factor ? te('account-identity.render.on') : te('account-identity.render.off') })}</div></div></li>
        ${links.providers.map((p) => { const l = links.linked.find((x) => x.provider === p.id); return `<li data-provider="${esc(p.id)}"><div><strong>${esc(p.label)}${p.mock ? ` <span class="faint">${te('account-identity.render.test_provider')}</span>` : ''}</strong><div class="faint">${l ? te('account-identity.render.linked', { rel_time: esc(relTime(l.linked_time)) }) : te('account-identity.render.not_linked')}</div></div>${l ? `<button class="btn btn-sm" data-unlink="${esc(p.id)}" data-testid="unlink-${esc(p.id)}">${te('account-identity.render.unlink')}</button>` : `<button class="btn btn-sm" data-link-provider="${esc(p.id)}" data-testid="link-${esc(p.id)}">${te('account-identity.render.link')}</button>`}</li>`; }).join('')}</ul>` : locked(tx('account-identity.render.sign_in_methods'))}</section>

    <section class="card panel" data-testid="passkeys-panel"><h2>${te('account-identity.render.passkeys')}</h2>
      ${passkeys ? `<p class="muted">${te('account-identity.render.sign_in_with_your_device')}</p>
        <ul class="set-apps">${passkeys.passkeys.map((k) => `<li data-testid="passkey-row" data-passkey="${esc(k.id)}"><div><strong>${esc(k.name)}</strong><div class="faint">${te('account-identity.render.added', { rel_time: esc(relTime(k.created_time)), value: k.last_used_time ? (' ' + te('account-identity.render.last_used', { rel_time: esc(relTime(k.last_used_time)) })) : '' })}</div></div><button class="btn btn-sm" data-remove-passkey="${esc(k.id)}" data-testid="passkey-remove">${te('account-identity.render.remove')}</button></li>`).join('') || `<li class="faint">${te('account-identity.render.no_passkeys_yet')}</li>`}</ul>
        ${passkeysSupported() ? `<button class="btn btn-primary mt-12" data-add-passkey data-testid="passkey-add">${te('account-identity.render.add_a_passkey')}</button>` : `<p class="faint">${te('account-identity.render.this_browser_does_not_support')}</p>`}<div class="form-error" role="alert" data-testid="passkey-error"></div>` : locked(tx('account-identity.render.passkeys'))}</section>

    <section class="card panel" data-testid="api-keys-panel"><h2>${te('account-identity.render.api_keys')}</h2>${apiKeys ? `<p class="muted">${esc(apiKeys.note)}</p>` : locked(tx('account-identity.render.api_keys'))}</section>

    <section class="card panel" data-testid="location-panel"><h2>${te('account-identity.render.location_check')}</h2>
      ${geo ? `<p>${te('account-identity.render.detected_location')} <strong data-testid="geo-country">${esc(geo.country_name)}</strong> <span class="faint">(${esc(geo.source === 'browser' ? tx('account-identity.render.browser') : tx('account-identity.render.network'))})</span> · ${geo.allowed ? `<span data-testid="geo-allowed">${te('account-identity.render.trading_allowed')}</span>` : `<span class="c-no" data-testid="geo-blocked">${te('account-identity.render.trading_not_available_here')}</span>`}</p>` : ''}
      <p class="faint">${te('account-identity.render.deposits_withdrawals_and_orders_are')}</p>
      <button class="btn" data-share-location data-testid="share-location">${te('account-identity.render.share_browser_location')}</button></section>

    ${holds.holds.length ? `<section class="card panel" data-testid="holds-panel"><h2>${te('account-identity.render.withdrawals_under_review')}</h2><ul class="set-apps">${holds.holds.map((h) => `<li data-hold="${esc(h.id)}"><div><strong>${esc(money(h.amount_dollars))}</strong><div class="faint">${esc(h.status)} · ${esc(relTime(h.created_time))}</div></div></li>`).join('')}</ul></section>` : ''}

    <section class="card panel" data-testid="privacy-panel"><h2>${te('account-identity.render.your_data')}</h2>
      <ul class="retention" data-testid="retention-policy">${(id.retention_policy || []).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      <div class="d-flex gap-8 flex-wrap"><button class="btn" data-export data-testid="data-export">${te('account-identity.render.download_my_data')}</button><button class="btn btn-danger" data-close-account data-testid="close-account">${te('account-identity.render.close_account')}</button></div>
      <div class="form-error" role="alert" data-testid="privacy-error"></div></section>`;

  const err = panel.querySelector('[data-testid=privacy-error]');
  const again = () => render(panel, { navigate });
  panel.querySelector('[data-resend-email]')?.addEventListener('click', async (e) => {
    try { await idApi.sendVerification(uid); e.target.textContent = tx('account-identity.render.sent_check_your_email'); e.target.disabled = true; } catch (ex) { toast(ex.message, 'error'); }
  });
  panel.querySelector('[data-add-passkey]')?.addEventListener('click', async () => {
    const box = panel.querySelector('[data-testid=passkey-error]');
    box.textContent = '';
    try {
      const opts = await idApi.passkeyRegOptions(uid); // step-up first when the last check is not recent
      const cred = await createPasskey(opts);
      await idApi.passkeyRegister(uid, cred, `${navigator.platform || tx('account-identity.render.this_device')} passkey`.slice(0, 60));
      toast(tx('account-identity.render.passkey_added'));
      again();
    } catch (ex) { if (ex.code !== 'step_up_cancelled') box.textContent = ex.name === 'NotAllowedError' ? tx('account-identity.render.passkey_setup_was_cancelled') : ex.message; }
  });
  for (const b of panel.querySelectorAll('[data-remove-passkey]')) b.onclick = async () => { try { await idApi.passkeyRemove(uid, b.dataset.removePasskey); toast(tx('account-identity.render.passkey_removed')); again(); } catch (ex) { if (ex.code !== 'step_up_cancelled') toast(ex.message, 'error'); } };
  for (const b of panel.querySelectorAll('[data-link-provider]')) b.onclick = async () => { try { location.assign((await idApi.oauthLinkStart(uid, b.dataset.linkProvider)).authorization_url); } catch (ex) { if (ex.code !== 'step_up_cancelled') toast(ex.message, 'error'); } };
  for (const b of panel.querySelectorAll('[data-unlink]')) b.onclick = async () => { try { await idApi.oauthUnlink(uid, b.dataset.unlink); toast(tx('account-identity.render.unlinked')); again(); } catch (ex) { if (ex.code !== 'step_up_cancelled') toast(ex.message, 'error'); } };
  panel.querySelector('[data-share-location]').onclick = () => {
    if (!navigator.geolocation) { toast(tx('account-identity.render.this_browser_cannot_share_its'), 'error'); return; }
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try { await idApi.reportLocation(uid, { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy }); toast(tx('account-identity.render.location_checked')); again(); } catch (ex) { toast(ex.message, 'error'); }
    }, () => toast(tx('account-identity.render.location_permission_was_not_given'), 'error'), { maximumAge: 60000, timeout: 10000 });
  };
  panel.querySelector('[data-export]').onclick = async () => {
    err.textContent = '';
    try {
      const data = await idApi.dataExport(uid);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      a.download = `parlance-data-${uid.slice(-8)}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast(tx('account-identity.render.your_data_was_downloaded'));
    } catch (ex) { if (ex.code !== 'step_up_cancelled') err.textContent = ex.message; }
  };
  panel.querySelector('[data-close-account]').onclick = () => closeDialog(uid, navigate);
  if (cfg.kyc_required === false && st === 'not_started') panel.querySelector('[data-testid=identity-panel]').insertAdjacentHTML('beforeend', `<p class="faint">${te('account-identity.render.verification_is_optional_on_this')}</p>`);
}

function closeDialog(uid, navigate) {
  const d = document.createElement('dialog');
  d.className = 'ob-dialog';
  d.dataset.testid = 'close-account-dialog';
  d.innerHTML = `<form method="dialog" novalidate><h2>${te('account-identity.close_dialog.close_your_account')}</h2>
    <p class="muted">${te('account-identity.close_dialog.resting_orders_are_canceled_and')}</p>
    <label class="field">${te('account-identity.close_dialog.type_close_to_confirm')}<input name="confirm" autocomplete="off" data-testid="close-confirm"></label>
    <label class="field">${te('account-identity.close_dialog.why_are_you_leaving_optional')}<input name="reason" maxlength="200"></label>
    <div class="form-error" role="alert" data-testid="close-error"></div>
    <div class="ob-dialog-actions"><button type="button" class="btn" data-cancel>${te('account-identity.close_dialog.keep_my_account')}</button><button type="submit" class="btn btn-danger" data-testid="close-submit">${te('account-identity.close_dialog.close_account')}</button></div></form>`;
  const f = d.querySelector('form');
  const close = () => { d.close(); d.remove(); };
  d.querySelector('[data-cancel]').onclick = close;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const box = f.querySelector('[data-testid=close-error]');
    box.textContent = '';
    try {
      await idApi.closeAccount(uid, { confirm: f.confirm.value.trim(), reason: f.reason.value });
      close();
      session.clearLocal();
      toast(tx('account-identity.close_dialog.your_account_is_closed'));
      navigate('/', { replace: true });
    } catch (ex) { if (ex.code !== 'step_up_cancelled') box.textContent = ex.fields ? Object.values(ex.fields).join('. ') : ex.details ? `${ex.message}: ${ex.details}` : ex.message; }
  };
  document.body.appendChild(d);
  d.showModal();
}
