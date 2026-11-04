// Phone side of document verification (CLONE_SPEC §13.15; CLONE_SPEC.md §25.4), opened by scanning the desktop's QR
// code: /verify/m#t=<single-use token>. The token is read from the fragment (never sent in a URL, never logged), removed
// from the address bar, and exchanged once for a short capture session (HttpOnly cookie + CSRF value). The phone then
// captures the ID front, back and a selfie with the camera (<input type="file" accept="image/*" capture>), re-encodes
// each photo through a canvas (drops EXIF/GPS metadata, caps the size) and uploads it. The server strips metadata again,
// checks it and encrypts it at rest. No account session is needed on the phone.
import { t, te, ts } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/docv-phone-strings.js';
import { csrf } from '../api.js';
import { refreshClientToken } from '../security.js';
import { esc } from '../lib.js';

export const DOC_KINDS = [
  ['id_front', ts('docv-phone.doc_kinds.front_of_your_id'), ts('docv-phone.doc_kinds.fit_the_whole_card_in'), 'environment'],
  ['id_back', ts('docv-phone.doc_kinds.back_of_your_id'), ts('docv-phone.doc_kinds.turn_the_card_over'), 'environment'],
  ['selfie', 'Selfie', ts('docv-phone.doc_kinds.face_the_camera_remove_sunglasses'), 'user'],
];
const MAX_SIDE = 1600;

// Re-encode any image the browser can decode to a JPEG data URL (≤1600 px a side). Drawing to a canvas drops all
// metadata (EXIF orientation is applied first, so the picture stays upright).
export async function reencodeImage(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  if (!bmp) throw Object.assign(new Error(t('docv-phone.reencode_image.this_file_is_not_a')), { details: t('docv-phone.reencode_image.choose_a_jpeg_or_png') });
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * scale)); c.height = Math.max(1, Math.round(bmp.height * scale));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
  return new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result)); fr.onerror = () => reject(new Error(t('docv-phone.reencode_image.could_not_read_the_photo'))); fr.readAsDataURL(blob); });
}

// Calls carrying the capture session's CSRF value (the HttpOnly capture cookie travels by itself, path /v1/docv).
async function call(method, url, body, docvCsrf) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const ct = await refreshClientToken(); if (ct) headers['X-Client-Token'] = ct;
  const sc = csrf.get(); if (sc) headers['x-csrf-token'] = sc; // a signed-in phone browser still needs its session CSRF
  if (docvCsrf) headers['X-Docv-Csrf'] = docvCsrf;
  const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j?.error?.message || t('docv-phone.call.http', { status: r.status })), { code: j?.error?.code, details: j?.error?.details, status: r.status });
  return j;
}

const page = (inner) => `<div class="ob ob-phone" data-testid="docv-phone"><header class="ob-top"><div class="ob-brand"><span class="ob-wordmark" aria-label="${te('docv-phone.page.parlance')}">${te('docv-phone.page.parlance')}</span></div></header>
  <section class="ob-body">${inner /* eslint-disable-line parlance/no-unescaped-html -- page(inner): markup from the templates in this file */}</section>
  <footer class="ob-vendor">${te('docv-phone.page.powered_by')} <strong>${te('docv-phone.page.parlance_verify')}</strong> <span class="faint">${te('docv-phone.page.sandbox')}</span></footer></div>`;

export async function render({ el }) {
  document.title = t('docv-phone.render.verify_your_identity_parlance');
  document.body.classList.add('ob-mode');
  const token = new URLSearchParams(location.hash.slice(1)).get('t') || '';
  history.replaceState(null, '', '/verify/m'); // the token leaves the address bar (and history) at once
  const cleanup = () => document.body.classList.remove('ob-mode');
  const fail = (code, msg) => {
    el.innerHTML = page(`<div class="ob-outcome bad" data-testid="handoff-error" data-code="${esc(code || 'error')}"><div class="ob-badge" aria-hidden="true"></div>
      <h1 class="ob-title">${te('docv-phone.render.this_link_can_t_be')}</h1><p class="ob-sub">${esc(msg)}</p><p class="ob-fine">${te('docv-phone.render.go_back_to_your_computer')}</p></div>`);
  };
  if (!token) { fail('handoff_invalid', t('docv-phone.render.scan_the_qr_code_on')); return cleanup; }
  let s;
  try { s = await call('POST', '/v1/docv/handoff/claim', { token }); } catch (ex) {
    fail(ex.code, ex.code === 'handoff_used' ? t('docv-phone.render.this_verification_link_was_already') : ex.code === 'handoff_expired' ? t('docv-phone.render.this_verification_link_has_expired') : t('docv-phone.render.this_verification_link_isn_t'));
    return cleanup;
  }
  const docCsrf = s.capture_csrf;
  const done = new Set(s.documents.filter((d) => d.uploaded).map((d) => d.kind));
  el.innerHTML = page(`<div class="ob-form" data-testid="phone-capture"><h1 class="ob-title">${te('docv-phone.render.take_photos_of_your_id')}</h1>
    <p class="ob-sub">${te('docv-phone.render.three_photos_the_front_and')}</p>
    <ul class="ob-capture">${DOC_KINDS.map(([k, label, hint, cap]) => `<li data-kind="${esc(k)}"><label class="ob-capture-btn"><input type="file" accept="image/*" capture="${esc(cap)}" data-capture="${esc(k)}" data-testid="capture-${esc(k)}"><span>${esc(label)}</span><small class="faint">${esc(hint)}</small></label>
      <span class="ob-capture-state" data-state="${esc(k)}" data-testid="state-${esc(k)}">${done.has(k) ? te('docv-phone.render.added') : ''}</span></li>`).join('')}</ul>
    <div class="form-error" role="alert" data-testid="phone-error"></div>
    <div class="ob-actions"><button class="btn btn-primary ob-cta" data-submit data-testid="phone-submit" ${done.size === 3 ? '' : 'disabled'}>${te('docv-phone.render.send_photos')}</button></div></div>`);
  const err = el.querySelector('[data-testid=phone-error]');
  const btn = el.querySelector('[data-submit]');
  for (const inp of el.querySelectorAll('[data-capture]')) {
    inp.onchange = async () => {
      const kind = inp.dataset.capture; const file = inp.files && inp.files[0];
      if (!file) return;
      const out = el.querySelector(`[data-state="${CSS.escape(kind)}"]`);
      err.textContent = ''; out.textContent = t('docv-phone.render.uploading');
      try {
        const r = await call('POST', '/v1/docv/handoff/documents', { kind, image: await reencodeImage(file) }, docCsrf);
        out.textContent = t('docv-phone.render.added');
        btn.disabled = !r.complete;
      } catch (ex) {
        out.textContent = '';
        err.textContent = ex.code === 'handoff_expired' ? t('docv-phone.render.this_session_ended_start_again') : `${ex.message}${ex.details ? `: ${ex.details}` : ''}`;
      }
      inp.value = '';
    };
  }
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await call('POST', '/v1/docv/handoff/submit', {}, docCsrf);
      el.innerHTML = page(`<div class="ob-outcome ok" data-testid="phone-done"><div class="ob-badge" aria-hidden="true"></div><h1 class="ob-title">${te('docv-phone.render.all_done')}</h1><p class="ob-sub">${te('docv-phone.render.your_photos_were_sent_go')}</p></div>`);
    } catch (ex) { err.textContent = `${ex.message}${ex.details ? `: ${ex.details}` : ''}`; btn.disabled = false; }
  };
  return cleanup;
}
