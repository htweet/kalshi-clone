// Account › Account & security › Identity & privacy (PHASE3_SPEC.md §25): verification status with masked details,
// email verification, sign-in methods and passkeys (locked until verified — CLONE_SPEC §13.19 — and behind step-up),
// API keys (Phase 7), location check, withdrawal holds, the retention policy, data export and account closure.
import { session } from '../store.js';
import { idApi } from '../identity-api.js';
import { esc, toast, relTime, money } from '../lib.js';
import { passkeysSupported, createPasskey } from '../webauthn-client.js';

const STATUS_TEXT = { not_started: 'Not started', in_progress: 'In progress', pending: 'Checking', documents_required: 'ID photos needed', review: 'Under review', approved: 'Verified', rejected: 'Not verified', retry: 'Needs another try', closed: 'Closed' };
const locked = (what) => `<div class="a2-locked" data-testid="a2-locked"><strong>Locked until your identity is verified.</strong> <span class="faint">${esc(what)} unlock once verification is approved, and changes ask you to confirm it’s you.</span> <a class="c-brand" href="/sign-up/identity" data-link>Verify identity</a></div>`;

export async function render(panel, { navigate }) {
  const uid = session.uid;
  const [id, cfg, geo, holds] = await Promise.all([idApi.identity(uid), idApi.config(), idApi.geolocation(uid).catch(() => null), idApi.holds(uid).catch(() => ({ holds: [] }))]);
  const methods = await idApi.signInMethods(uid).catch((e) => (e.code === 'permission_denied' ? null : Promise.reject(e)));
  const passkeys = methods ? await idApi.passkeys(uid).catch(() => ({ passkeys: [] })) : null;
  const apiKeys = methods ? await idApi.apiKeys(uid).catch(() => null) : null;
  const links = methods ? await idApi.oauthLinks(uid).catch(() => ({ providers: [], linked: [] })) : null;
  const st = id.status;
  panel.innerHTML = `
    <section class="card panel" data-testid="identity-panel"><h2>Identity verification</h2>
      <p>Status: <strong data-testid="identity-status" data-status="${esc(st)}">${esc(STATUS_TEXT[st] || st)}</strong>${id.verification.reason_message ? ` <span class="faint">· ${esc(id.verification.reason_message)}</span>` : ''}</p>
      ${['approved', 'closed', 'pending', 'review', 'rejected'].includes(st) ? '' : `<a class="btn btn-primary" href="/sign-up/identity?next=/account/privacy" data-link data-testid="identity-continue">${st === 'not_started' ? 'Verify your identity' : 'Continue verification'}</a>`}
      <dl class="id-facts" data-testid="identity-masked"><dt>Legal name</dt><dd>${esc(id.name_masked || '—')}</dd><dt>Date of birth</dt><dd>${esc(id.dob_masked || '—')}</dd><dt>Address</dt><dd>${esc(id.address_masked || '—')}</dd>
        <dt>National ID</dt><dd data-testid="identity-nid">${esc(id.national_id?.masked || '—')}</dd><dt>Phone</dt><dd>${esc(id.phone?.masked || '—')}</dd>
        <dt>Email</dt><dd>${id.email_verified ? '<span data-testid="email-verified">Verified</span>' : '<span data-testid="email-unverified">Not verified</span> <button class="btn btn-sm" data-resend-email data-testid="resend-email">Send verification email</button>'}</dd></dl>
      <p class="faint">Your details are encrypted with a key unique to your account. Your ID number is never shown in full, not even to you.</p></section>

    <section class="card panel" data-testid="signin-methods"><h2>Sign-in methods</h2>
      ${methods ? `<ul class="set-apps"><li><div><strong>Password</strong><div class="faint">${methods.password ? 'Set' : 'Not set (use “Forgot password” to create one)'}</div></div></li>
        <li><div><strong>Two-factor login</strong><div class="faint">${methods.two_factor ? 'On' : 'Off'} · manage in Security</div></div></li>
        ${links.providers.map((p) => { const l = links.linked.find((x) => x.provider === p.id); return `<li data-provider="${esc(p.id)}"><div><strong>${esc(p.label)}${p.mock ? ' <span class="faint">(test provider)</span>' : ''}</strong><div class="faint">${l ? `Linked ${esc(relTime(l.linked_time))}` : 'Not linked'}</div></div>${l ? `<button class="btn btn-sm" data-unlink="${esc(p.id)}" data-testid="unlink-${esc(p.id)}">Unlink</button>` : `<button class="btn btn-sm" data-link-provider="${esc(p.id)}" data-testid="link-${esc(p.id)}">Link</button>`}</li>`; }).join('')}</ul>` : locked('Sign-in methods')}</section>

    <section class="card panel" data-testid="passkeys-panel"><h2>Passkeys</h2>
      ${passkeys ? `<p class="muted">Sign in with your device’s screen lock instead of a password. A passkey also confirms sensitive actions.</p>
        <ul class="set-apps">${passkeys.passkeys.map((k) => `<li data-testid="passkey-row" data-passkey="${esc(k.id)}"><div><strong>${esc(k.name)}</strong><div class="faint">Added ${esc(relTime(k.created_time))}${k.last_used_time ? ` · last used ${esc(relTime(k.last_used_time))}` : ''}</div></div><button class="btn btn-sm" data-remove-passkey="${esc(k.id)}" data-testid="passkey-remove">Remove</button></li>`).join('') || '<li class="faint">No passkeys yet.</li>'}</ul>
        ${passkeysSupported() ? '<button class="btn btn-primary mt-12" data-add-passkey data-testid="passkey-add">Add a passkey</button>' : '<p class="faint">This browser does not support passkeys.</p>'}<div class="form-error" role="alert" data-testid="passkey-error"></div>` : locked('Passkeys')}</section>

    <section class="card panel" data-testid="api-keys-panel"><h2>API keys</h2>${apiKeys ? `<p class="muted">${esc(apiKeys.note)}</p>` : locked('API keys')}</section>

    <section class="card panel" data-testid="location-panel"><h2>Location check</h2>
      ${geo ? `<p>Detected location: <strong data-testid="geo-country">${esc(geo.country_name)}</strong> <span class="faint">(${esc(geo.source === 'browser' ? 'browser' : 'network')})</span> · ${geo.allowed ? '<span data-testid="geo-allowed">trading allowed</span>' : '<span class="c-no" data-testid="geo-blocked">trading not available here</span>'}</p>` : ''}
      <p class="faint">Deposits, withdrawals and orders are checked against where you are. You can also share your browser’s location; only the country is kept, for 30 minutes.</p>
      <button class="btn" data-share-location data-testid="share-location">Share browser location</button></section>

    ${holds.holds.length ? `<section class="card panel" data-testid="holds-panel"><h2>Withdrawals under review</h2><ul class="set-apps">${holds.holds.map((h) => `<li data-hold="${esc(h.id)}"><div><strong>${esc(money(h.amount_dollars))}</strong><div class="faint">${esc(h.status)} · ${esc(relTime(h.created_time))}</div></div></li>`).join('')}</ul></section>` : ''}

    <section class="card panel" data-testid="privacy-panel"><h2>Your data</h2>
      <ul class="retention" data-testid="retention-policy">${(id.retention_policy || []).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      <div class="d-flex gap-8 flex-wrap"><button class="btn" data-export data-testid="data-export">Download my data</button><button class="btn btn-danger" data-close-account data-testid="close-account">Close account</button></div>
      <div class="form-error" role="alert" data-testid="privacy-error"></div></section>`;

  const err = panel.querySelector('[data-testid=privacy-error]');
  const again = () => render(panel, { navigate });
  panel.querySelector('[data-resend-email]')?.addEventListener('click', async (e) => {
    try { await idApi.sendVerification(uid); e.target.textContent = 'Sent — check your email'; e.target.disabled = true; } catch (ex) { toast(ex.message, 'error'); }
  });
  panel.querySelector('[data-add-passkey]')?.addEventListener('click', async () => {
    const box = panel.querySelector('[data-testid=passkey-error]');
    box.textContent = '';
    try {
      const opts = await idApi.passkeyRegOptions(uid); // step-up first when the last check is not recent
      const cred = await createPasskey(opts);
      await idApi.passkeyRegister(uid, cred, `${navigator.platform || 'This device'} passkey`.slice(0, 60));
      toast('Passkey added');
      again();
    } catch (ex) { if (ex.code !== 'step_up_cancelled') box.textContent = ex.name === 'NotAllowedError' ? 'Passkey setup was cancelled.' : ex.message; }
  });
  for (const b of panel.querySelectorAll('[data-remove-passkey]')) b.onclick = async () => { try { await idApi.passkeyRemove(uid, b.dataset.removePasskey); toast('Passkey removed'); again(); } catch (ex) { if (ex.code !== 'step_up_cancelled') toast(ex.message, 'error'); } };
  for (const b of panel.querySelectorAll('[data-link-provider]')) b.onclick = async () => { try { location.assign((await idApi.oauthLinkStart(uid, b.dataset.linkProvider)).authorization_url); } catch (ex) { if (ex.code !== 'step_up_cancelled') toast(ex.message, 'error'); } };
  for (const b of panel.querySelectorAll('[data-unlink]')) b.onclick = async () => { try { await idApi.oauthUnlink(uid, b.dataset.unlink); toast('Unlinked'); again(); } catch (ex) { if (ex.code !== 'step_up_cancelled') toast(ex.message, 'error'); } };
  panel.querySelector('[data-share-location]').onclick = () => {
    if (!navigator.geolocation) { toast('This browser cannot share its location', 'error'); return; }
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try { await idApi.reportLocation(uid, { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy }); toast('Location checked'); again(); } catch (ex) { toast(ex.message, 'error'); }
    }, () => toast('Location permission was not given', 'error'), { maximumAge: 60000, timeout: 10000 });
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
      toast('Your data was downloaded');
    } catch (ex) { if (ex.code !== 'step_up_cancelled') err.textContent = ex.message; }
  };
  panel.querySelector('[data-close-account]').onclick = () => closeDialog(uid, navigate);
  if (cfg.kyc_required === false && st === 'not_started') panel.querySelector('[data-testid=identity-panel]').insertAdjacentHTML('beforeend', '<p class="faint">Verification is optional on this server.</p>');
}

function closeDialog(uid, navigate) {
  const d = document.createElement('dialog');
  d.className = 'ob-dialog';
  d.dataset.testid = 'close-account-dialog';
  d.innerHTML = `<form method="dialog" novalidate><h2>Close your account?</h2>
    <p class="muted">Resting orders are canceled and your remaining cash is paid out. You need to close open positions first. Your personal details are destroyed (the key that encrypts them is deleted); records the law requires us to keep stay, without your personal data.</p>
    <label class="field">Type CLOSE to confirm<input name="confirm" autocomplete="off" data-testid="close-confirm"></label>
    <label class="field">Why are you leaving? (optional)<input name="reason" maxlength="200"></label>
    <div class="form-error" role="alert" data-testid="close-error"></div>
    <div class="ob-dialog-actions"><button type="button" class="btn" data-cancel>Keep my account</button><button type="submit" class="btn btn-danger" data-testid="close-submit">Close account</button></div></form>`;
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
      toast('Your account is closed');
      navigate('/', { replace: true });
    } catch (ex) { if (ex.code !== 'step_up_cancelled') box.textContent = ex.fields ? Object.values(ex.fields).join('. ') : ex.details ? `${ex.message}: ${ex.details}` : ex.message; }
  };
  document.body.appendChild(d);
  d.showModal();
}
