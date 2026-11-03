// Account › Identity & privacy (CLONE_SPEC §25): verification status, email verification, phone, passkeys, linked
// sign-in providers, location check, withdrawal reviews, data export and account closure, and the retention policy.
import { session } from '../store.js';
import { idApi } from '../identity-api.js';
import { esc, toast, relTime, money } from '../lib.js';
import { passkeysSupported, createPasskey } from '../webauthn-client.js';

const STATUS = { not_started: 'Not started', in_progress: 'In progress', pending: 'Verifying', review: 'Under review', approved: 'Verified', rejected: 'Not verified', retry: 'Action needed', closed: 'Closed' };
const cap = (s) => (s ? `${String(s)[0].toUpperCase()}${String(s).slice(1)}` : '');
const errText = (ex) => cap(ex.fields ? Object.values(ex.fields).join('. ') : ex.details && ex.code !== 'validation_failed' ? `${ex.message}: ${ex.details}` : ex.message);

export async function render(panel) {
  const uid = session.uid;
  const [id, links, pks, geo, holds] = await Promise.all([idApi.identity(uid), idApi.oauthLinks(uid), idApi.passkeys(uid), idApi.geolocation(uid), idApi.holds(uid)]);
  const verified = id.status === 'approved';
  panel.innerHTML = `<section class="card panel" data-testid="identity-panel"><h2>Identity verification</h2>
      <p>Status: <strong data-testid="identity-status" data-status="${esc(id.status)}">${esc(STATUS[id.status] || id.status)}</strong>${id.verification.reason_message && !verified ? ` <span class="faint">· ${esc(id.verification.reason_message)}</span>` : ''}</p>
      <dl class="id-facts"><dt>Legal name</dt><dd data-testid="masked-name">${esc(id.name_masked || '—')}</dd><dt>Date of birth</dt><dd>${esc(id.dob_masked || '—')}</dd>
        <dt>Address</dt><dd data-testid="masked-address">${esc(id.address_masked || '—')}</dd><dt>ID number</dt><dd data-testid="masked-national-id">${esc(id.national_id ? id.national_id.masked : '—')}</dd>
        <dt>Phone</dt><dd data-testid="masked-phone">${esc(id.phone ? id.phone.masked : 'Not verified')}</dd></dl>
      <p class="faint">Personal details are shown masked. Your ID number is never shown in full.</p>
      ${['approved', 'pending', 'review', 'rejected', 'closed'].includes(id.status) ? '' : '<a class="btn btn-primary" href="/sign-up/identity?next=/account/privacy" data-link data-testid="identity-continue">Continue verification</a>'}</section>
    <section class="card panel" data-testid="email-verify-panel"><h2>Email address</h2>
      <p>${esc(session.user.email)} · <strong data-testid="email-verified">${id.email_verified ? 'Verified' : 'Not verified'}</strong></p>
      ${id.email_verified ? '' : '<button class="btn" data-resend-email data-testid="resend-verification">Send verification email</button><div class="form-error" role="alert" data-email-error></div>'}</section>
    <section class="card panel" data-testid="passkeys-panel"><h2>Passkeys</h2>
      <p class="muted">Sign in with your device’s screen lock instead of a password. Passkeys can’t be phished and count as two-factor.</p>
      <table class="table"><thead><tr><th>Name</th><th>Added</th><th>Last used</th><th></th></tr></thead><tbody>
      ${pks.passkeys.map((p) => `<tr data-testid="passkey-row" data-id="${esc(p.id)}"><td>${esc(p.name)}</td><td>${esc(relTime(p.created_time))}</td><td>${esc(p.last_used_time ? relTime(p.last_used_time) : 'Never')}</td><td><button class="btn btn-sm" data-remove-passkey="${esc(p.id)}">Remove</button></td></tr>`).join('') || '<tr><td colspan="4" class="faint">No passkeys yet.</td></tr>'}</tbody></table>
      ${passkeysSupported() ? '<form class="inline-form mt-12" data-add-passkey><label class="field">Name<input name="name" maxlength="60" placeholder="e.g. Work laptop" data-testid="passkey-name"></label><button class="btn btn-primary" type="submit" data-testid="add-passkey">Add a passkey</button></form>' : '<p class="faint">This browser doesn’t support passkeys.</p>'}
      <div class="form-error" role="alert" data-passkey-error data-testid="passkey-error"></div></section>
    <section class="card panel" data-testid="linked-panel"><h2>Linked sign-in</h2>
      ${links.providers.map((p) => { const l = links.linked.find((x) => x.provider === p.id); return `<div class="id-row" data-provider="${esc(p.id)}"><span>${esc(p.label)}${p.mock ? ' <span class="faint">(test provider)</span>' : ''}</span>
        <span class="faint">${l ? `Linked ${esc(relTime(l.linked_time))}` : 'Not linked'}</span>${l ? `<button class="btn btn-sm" data-unlink="${esc(p.id)}">Unlink</button>` : `<button class="btn btn-sm" data-link-provider="${esc(p.id)}" data-testid="link-${esc(p.id)}">Link</button>`}</div>`; }).join('') || '<p class="faint">No sign-in providers are configured.</p>'}
      <div class="form-error" role="alert" data-link-error></div></section>
    <section class="card panel" data-testid="location-panel"><h2>Location check</h2>
      <p class="muted">Trading, deposits and withdrawals are only available in permitted regions. We use your network location and, if you allow it, your browser’s location. Only the country is kept, for 30 minutes.</p>
      <p>Network: <strong data-testid="geo-ip">${esc(geo.ip_country === 'ZZ' ? 'local network' : geo.ip_country)}</strong> · Browser: <strong data-testid="geo-browser">${esc(geo.browser_country || 'not checked')}</strong> · <span data-testid="geo-allowed" class="${geo.allowed ? 'c-yes' : 'c-no'}">${geo.allowed ? 'Permitted' : `Not permitted (${esc(geo.country_name)})`}</span></p>
      <button class="btn" data-geo-check data-testid="geo-check">Check my location</button><div class="form-error" role="alert" data-geo-error></div></section>
    ${holds.holds.length ? `<section class="card panel" data-testid="holds-panel"><h2>Withdrawal reviews</h2><table class="table"><thead><tr><th>Amount</th><th>Status</th><th>Requested</th></tr></thead><tbody>
      ${holds.holds.map((h) => `<tr data-testid="hold-row" data-status="${esc(h.status)}"><td>${esc(money(h.amount_dollars))}</td><td>${esc({ held: 'Under review', released: 'Sent', reversed: 'Returned to balance' }[h.status] || h.status)}</td><td>${esc(relTime(h.created_time))}</td></tr>`).join('')}</tbody></table></section>` : ''}
    <section class="card panel" data-testid="privacy-panel"><h2>Your data</h2>
      ${id.retention_policy.map((t) => `<p class="faint">${esc(t)}</p>`).join('')}
      <div class="d-flex gap-8 mt-12"><button class="btn" data-export data-testid="export-data">Download my data</button></div><div class="form-error" role="alert" data-export-error></div></section>
    <section class="card panel id-danger" data-testid="close-panel"><h2>Close account</h2>
      <p class="muted">Closing cancels your resting orders, pays out your cash balance and permanently erases your identity details. Open positions must be closed first. This can’t be undone.</p>
      <form class="inline-form" data-close-form><label class="field">Type CLOSE to confirm<input name="confirm" autocomplete="off" data-testid="close-confirm"></label><button class="btn btn-danger" type="submit" data-testid="close-account">Close my account</button></form>
      <div class="form-error" role="alert" data-close-error data-testid="close-error"></div></section>`;

  const reload = () => render(panel);
  panel.querySelector('[data-resend-email]')?.addEventListener('click', async () => {
    try { await idApi.resendVerification(uid); toast('Verification email sent'); } catch (ex) { panel.querySelector('[data-email-error]').textContent = errText(ex); }
  });
  const addForm = panel.querySelector('[data-add-passkey]');
  if (addForm) addForm.onsubmit = async (e) => {
    e.preventDefault();
    const box = panel.querySelector('[data-passkey-error]');
    box.textContent = '';
    try {
      const opts = await idApi.passkeyRegOptions(uid);
      const credential = await createPasskey(opts);
      await idApi.passkeyRegister(uid, { credential, name: addForm.name.value.trim() });
      toast('Passkey added');
      reload();
    } catch (ex) { if (ex.code !== 'step_up_cancelled') box.textContent = ex.name === 'NotAllowedError' ? 'Passkey creation was cancelled.' : errText(ex); }
  };
  for (const b of panel.querySelectorAll('[data-remove-passkey]')) b.onclick = async () => {
    try { await idApi.passkeyRemove(uid, b.dataset.removePasskey); toast('Passkey removed'); reload(); } catch (ex) { if (ex.code !== 'step_up_cancelled') panel.querySelector('[data-passkey-error]').textContent = errText(ex); }
  };
  for (const b of panel.querySelectorAll('[data-link-provider]')) b.onclick = async () => {
    try { const r = await idApi.oauthLinkStart(uid, b.dataset.linkProvider); location.assign(r.authorization_url); } catch (ex) { if (ex.code !== 'step_up_cancelled') panel.querySelector('[data-link-error]').textContent = errText(ex); }
  };
  for (const b of panel.querySelectorAll('[data-unlink]')) b.onclick = async () => {
    try { await idApi.oauthUnlink(uid, b.dataset.unlink); toast('Unlinked'); reload(); } catch (ex) { if (ex.code !== 'step_up_cancelled') panel.querySelector('[data-link-error]').textContent = errText(ex); }
  };
  panel.querySelector('[data-geo-check]').onclick = () => {
    const box = panel.querySelector('[data-geo-error]');
    box.textContent = '';
    if (!navigator.geolocation) { box.textContent = 'This browser can’t share its location.'; return; }
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try { const d = await idApi.reportLocation(uid, { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy }); toast(d.allowed ? 'Location confirmed' : `Not permitted in ${d.country_name}`); reload(); } catch (ex) { box.textContent = errText(ex); }
    }, () => { box.textContent = 'Location permission was denied. Your network location is used instead.'; }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
  };
  panel.querySelector('[data-export]').onclick = async () => {
    try {
      const data = await idApi.exportData(uid);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url; a.download = `parlance-data-${uid.slice(-8)}.json`; a.dataset.testid = 'export-link';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast('Your data was downloaded');
    } catch (ex) { if (ex.code !== 'step_up_cancelled') panel.querySelector('[data-export-error]').textContent = errText(ex); }
  };
  panel.querySelector('[data-close-form]').onsubmit = async (e) => {
    e.preventDefault();
    const box = panel.querySelector('[data-close-error]');
    box.textContent = '';
    try {
      await idApi.closeAccount(uid, { confirm: e.currentTarget.confirm.value.trim() });
      session.clearLocal();
      toast('Your account is closed');
      location.assign('/');
    } catch (ex) { if (ex.code !== 'step_up_cancelled') box.textContent = errText(ex); }
  };
}
