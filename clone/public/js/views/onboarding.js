// Identity onboarding (CLONE_SPEC §13.14–§13.15, observed; CLONE_SPEC.md §25): a full-screen page with only the wordmark
// and a segmented progress bar. Steps: phone number → 4-digit code → legal name → birthday (18+) → address with a
// country-specific national ID → "Verifying info…" → document verification ("Let's get you verified" → QR "Continue on
// your phone" → "Stay on this page" while the phone uploads, or the same-device fallback) → "Verifying info…" → outcome
// (approved / manual review / rejected / retry — design choice, not captured).
// Every step is saved on Continue; "Not now" / "Exit identity verification" leave the flow and a banner on every page
// invites the user back. Also: the identity banner and the shared compliance dialog (verification required / location).
import { t as tx, te, ts, tes } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/onboarding-strings.js';
import { session } from '../store.js';
import { idApi } from '../identity-api.js';
import { flagOn } from '../flags.js'; // feature flags (CLONE_SPEC.md §33)
import { esc, toast } from '../lib.js';
import { vars } from '../dynstyle.js';
import { qrSvg } from '../qr.js';
import { reencodeImage, DOC_KINDS } from './docv-phone.js';

const WORDMARK = `<span class="ob-wordmark" aria-label="${tes('onboarding.wordmark.parlance')}">${tes('onboarding.wordmark.parlance')}</span>`;
const STEP_ORDER = ['phone', 'code', 'name', 'birthday', 'address', 'verifying', 'documents', 'outcome'];
const DIGITS = /^\d$/;

// ------------------------------------------------------------------ progress bar: 3 segments (phone · about you · verify)
function progress(step) {
  const fill = { phone: [40, 0, 0], code: [80, 0, 0], name: [100, 15, 0], birthday: [100, 45, 0], address: [100, 75, 0], verifying: [100, 100, 15], documents: [100, 100, 30], 'doc-qr': [100, 100, 45], 'doc-wait': [100, 100, 70], 'doc-device': [100, 100, 60], outcome: [100, 100, 100] }[step] || [0, 0, 0];
  return `<div class="ob-progress" role="progressbar" aria-label="${te('onboarding.progress.verification_progress')}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round((fill[0] + fill[1] + fill[2]) / 3)}" data-testid="ob-progress">
    ${fill.map((f, i) => `<span class="ob-seg" data-seg="${i}" data-fill="${esc(f)}"><i class="v-w"${vars({ '--w': `${f}%` })}></i></span>`).join('')}</div>`;
}
const frame = (step, inner) => `<div class="ob" data-testid="onboarding" data-step="${esc(step)}"><header class="ob-top">${progress(step)}<div class="ob-brand">${WORDMARK}</div></header>
  <section class="ob-body">${inner /* eslint-disable-line parlance/no-unescaped-html -- frame(step, inner): inner is markup built by the step templates below (checked where written) */}</section></div>`;
const learnMore = (topic) => `<button type="button" class="ob-learn" data-learn="${esc(topic)}" data-testid="learn-more">${te('onboarding.learn_more.learn_more')}</button>`;
const LEARN = {
  phone: [ts('onboarding.learn_phone.why_we_verify_your_phone'), ts('onboarding.learn_phone.we_text_a_4_digit')],
  name: [ts('onboarding.learn_name.why_we_ask_for_your'), ts('onboarding.learn_name.regulated_exchanges_must_verify_who')],
  identity: [ts('onboarding.learn_identity.how_we_protect_your_details'), ts('onboarding.learn_identity.your_name_date_of_birth')],
};

// Own line art for the document-verification screens (no vendor artwork).
const ID_ICON = '<svg viewBox="0 0 48 36" width="48" height="36" fill="none" aria-hidden="true"><rect x="2" y="2" width="44" height="32" rx="4" stroke="currentColor" stroke-width="2"/><circle cx="15" cy="16" r="5" stroke="currentColor" stroke-width="2"/><path d="M7 28c1.5-4 4.5-6 8-6s6.5 2 8 6M28 12h12M28 18h12M28 24h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const PHONE_ICON = '<svg viewBox="0 0 30 44" width="30" height="44" fill="none" aria-hidden="true"><rect x="2" y="2" width="26" height="40" rx="5" stroke="currentColor" stroke-width="2"/><path d="M11 37h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const FACE_ICON = '<svg viewBox="0 0 40 40" width="40" height="40" fill="none" aria-hidden="true"><circle cx="20" cy="20" r="17" stroke="currentColor" stroke-width="2"/><circle cx="14" cy="16" r="2" fill="currentColor"/><circle cx="26" cy="16" r="2" fill="currentColor"/><path d="M13 26c2 3 4.5 4 7 4s5-1 7-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

function learnDialog(topic) {
  const [title, body] = LEARN[topic] || LEARN.identity;
  const d = document.createElement('dialog');
  d.className = 'ob-dialog';
  d.dataset.testid = 'learn-more-dialog';
  d.innerHTML = `<h2>${esc(title)}</h2><p class="muted">${esc(body)}</p><div class="ob-dialog-actions"><button class="btn btn-primary" data-close>${te('onboarding.learn_dialog.got_it')}</button></div>`;
  d.querySelector('[data-close]').onclick = () => { d.close(); d.remove(); };
  d.addEventListener('cancel', () => d.remove());
  document.body.appendChild(d);
  d.showModal();
}

const fieldErr = (ex) => (ex.fields ? Object.values(ex.fields).join('. ') : ex.details && ex.code !== 'validation_failed' ? `${ex.message}: ${ex.details}` : ex.message);
const cap = (s) => (s ? `${s[0].toUpperCase()}${s.slice(1)}` : s);

export async function render({ el, query, navigate }) {
  if (!session.user) { navigate(`/sign-in?next=${encodeURIComponent('/sign-up/identity')}`, { replace: true }); return; }
  document.title = tx('onboarding.render.verify_your_identity_parlance');
  document.body.classList.add('ob-mode');
  const next = query.get('next') && query.get('next').startsWith('/') && !query.get('next').startsWith('//') ? query.get('next') : '/';
  const uid = session.uid;
  const timers = new Set();
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
  const cleanup = () => { for (const t of timers) { clearTimeout(t); clearInterval(t); } timers.clear(); document.body.classList.remove('ob-mode'); refreshIdentityBanner(); };
  let [state, countries] = await Promise.all([idApi.resume(), idApi.countries()]);
  const byCode = Object.fromEntries(countries.map((c) => [c.code, c]));
  let typedPhone = null; // the number as typed this session, in international format, for "We've sent a code to …"
  let draft = state.details || {};

  const go = (step) => { for (const t of [...timers]) { clearTimeout(t); clearInterval(t); } timers.clear(); el.innerHTML = ''; ({ phone, code, name, birthday, address, verifying, documents, outcome })[step](); window.scrollTo(0, 0); };
  const notNow = async () => { try { await idApi.skip(uid); } catch { /* still leave */ } toast(tx('onboarding.render.you_can_finish_verifying_any')); navigate(next, { replace: true }); };
  const wire = (root) => {
    for (const b of root.querySelectorAll('[data-learn]')) b.onclick = () => learnDialog(b.dataset.learn);
    root.querySelector('[data-not-now]')?.addEventListener('click', notNow);
  };
  const start = () => {
    const s = state.next_step;
    if (s === 'phone') return go(state.pending_phone ? 'code' : 'phone');
    if (s === 'submit') return go('address');
    return go(STEP_ORDER.includes(s) ? s : 'outcome');
  };
  const busy = (form, on) => { for (const b of form.querySelectorAll('button[type=submit]')) b.disabled = on || b.dataset.ready === '0'; };

  // ---------------------------------------------------------------- phone number
  function phone() {
    const cur = byCode[state.pending_phone?.country || state.country || 'US'] || countries[0];
    el.innerHTML = frame('phone', `<form class="ob-form" id="ob-phone" novalidate data-testid="ob-phone-form">
      <h1 class="ob-title">${te('onboarding.render.what_s_your_phone_number')}</h1><p class="ob-sub">${te('onboarding.render.we_ll_text_you_a', { learn_more: learnMore('phone') })}</p>
      <div class="ob-phone-row"><label class="ob-float ob-cc"><select name="country" data-testid="phone-country" aria-label="${te('onboarding.render.country_code')}">${countries.map((c) => `<option value="${esc(c.code)}"${c.code === cur.code ? ' selected' : ''}>${esc(c.name)} (${esc(c.dial_code)})</option>`).join('')}</select><span>${te('onboarding.render.country')}</span></label>
      <label class="ob-float grow"><input name="number" type="tel" inputmode="tel" autocomplete="tel-national" placeholder=" " required maxlength="20" data-testid="phone-number"><span>${te('onboarding.render.phone_number')}</span></label></div>
      <p class="ob-fine">${te('onboarding.render.message_and_data_rates_may')}</p>
      <div class="form-error" role="alert" data-testid="ob-error"></div>
      <div class="ob-actions"><button class="btn btn-primary ob-cta" type="submit" data-testid="ob-continue">${te('onboarding.render.continue')}</button><button class="btn btn-ghost ob-cta" type="button" data-not-now data-testid="not-now">${te('onboarding.render.not_now')}</button></div></form>`);
    const f = el.querySelector('#ob-phone');
    wire(el);
    f.number.focus();
    f.onsubmit = async (e) => {
      e.preventDefault();
      const err = f.querySelector('[data-testid=ob-error]');
      err.textContent = '';
      busy(f, true);
      try {
        const r = await idApi.sendCode(uid, { country: f.country.value, number: f.number.value });
        typedPhone = `${byCode[f.country.value].dial_code} ${f.number.value.replace(/[^\d ]/g, '').trim()}`;
        state = { ...state, pending_phone: { masked: r.masked, country: f.country.value, resend_available_time: r.resend_available_time, attempts_left: r.attempts_left, expires_time: r.expires_time } };
        go('code');
      } catch (ex) {
        err.textContent = ex.code === 'sms_cooldown' || ex.code === 'sms_rate_limited' ? tx('onboarding.render.try_again_in_seconds', { cap: cap(ex.message), value: ex.retryAfter || tx('onboarding.render.a_few') }) : cap(fieldErr(ex));
        busy(f, false);
      }
    };
  }

  // ---------------------------------------------------------------- 4-digit code (four single-digit boxes)
  function code() {
    const p = state.pending_phone || {};
    el.innerHTML = frame('code', `<form class="ob-form" id="ob-code" novalidate data-testid="ob-code-form">
      <h1 class="ob-title">${te('onboarding.render.enter_your_4_digit_code')}</h1>
      <p class="ob-sub">${te('onboarding.render.we_ve_sent_a_code')} <strong data-testid="code-destination">${esc(typedPhone || p.masked || '')}</strong></p>
      <p class="ob-fine">${te('onboarding.render.can_t_find_it_check')}</p>
      <div class="ob-code" role="group" aria-label="${te('onboarding.render.n4_digit_code')}">${[0, 1, 2, 3].map((i) => `<input class="ob-digit" inputmode="numeric" pattern="[0-9]*" maxlength="1" aria-label="${te('onboarding.render.digit', { value: i + 1 })}" autocomplete="${i === 0 ? 'one-time-code' : 'off'}" data-testid="code-digit">`).join('')}</div>
      <div class="form-error" role="alert" data-testid="ob-error"></div>
      <div class="ob-actions"><button class="btn btn-primary ob-cta" type="submit" disabled data-ready="0" data-testid="ob-continue">${te('onboarding.render.continue')}</button>
        <button class="btn ob-pill" type="button" data-resend data-testid="resend-code">${te('onboarding.render.resend_code')}</button></div>
      <p class="ob-links">${learnMore('phone')} · <button type="button" class="ob-learn" data-change-number data-testid="change-number">${te('onboarding.render.use_a_different_number')}</button></p></form>`);
    const f = el.querySelector('#ob-code');
    wire(el);
    const boxes = [...f.querySelectorAll('.ob-digit')];
    const submitBtn = f.querySelector('[type=submit]');
    const value = () => boxes.map((b) => b.value).join('');
    const sync = () => { const ok = /^\d{4}$/.test(value()); submitBtn.dataset.ready = ok ? '1' : '0'; submitBtn.disabled = !ok; };
    boxes.forEach((b, i) => {
      b.addEventListener('input', () => {
        const d = b.value.replace(/\D/g, '');
        if (d.length > 1) { // paste or autofill of the whole code into one box
          d.slice(0, 4).split('').forEach((x, j) => { if (boxes[i + j]) boxes[i + j].value = x; });
          boxes[Math.min(3, i + d.length - 1)].focus();
        } else { b.value = d; if (d && boxes[i + 1]) boxes[i + 1].focus(); }
        sync();
      });
      b.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !b.value && boxes[i - 1]) { boxes[i - 1].focus(); boxes[i - 1].value = ''; sync(); e.preventDefault(); }
        else if (e.key === 'ArrowLeft' && boxes[i - 1]) boxes[i - 1].focus();
        else if (e.key === 'ArrowRight' && boxes[i + 1]) boxes[i + 1].focus();
        else if (e.key.length === 1 && !DIGITS.test(e.key) && !e.metaKey && !e.ctrlKey) e.preventDefault();
      });
      b.addEventListener('paste', (e) => {
        const t = (e.clipboardData?.getData('text') || '').replace(/\D/g, '').slice(0, 4);
        if (!t) return;
        e.preventDefault();
        t.split('').forEach((x, j) => { if (boxes[j]) boxes[j].value = x; });
        boxes[Math.min(3, t.length - 1)].focus();
        sync();
      });
    });
    boxes[0].focus();
    // Resend with a visible countdown.
    const resend = f.querySelector('[data-resend]');
    let until = Date.parse(p.resend_available_time || 0) || 0;
    const tickResend = () => {
      const left = Math.ceil((until - Date.now()) / 1000);
      resend.disabled = left > 0;
      resend.textContent = left > 0 ? tx('onboarding.render.resend_code_in', { floor: Math.floor(left / 60), pad_start: String(left % 60).padStart(2, '0') }) : tx('onboarding.render.resend_code');
      resend.dataset.wait = left > 0 ? String(left) : '0';
    };
    tickResend();
    const iv = setInterval(tickResend, 500); timers.add(iv);
    resend.onclick = async () => {
      const err = f.querySelector('[data-testid=ob-error]');
      err.textContent = '';
      resend.disabled = true;
      try {
        const country = p.country || 'US';
        const number = typedPhone ? typedPhone.replace(/^\+\d+\s*/, '') : null;
        if (!number) { go('phone'); return; }
        const r = await idApi.sendCode(uid, { country, number });
        until = Date.parse(r.resend_available_time);
        state.pending_phone = { ...p, resend_available_time: r.resend_available_time, attempts_left: r.attempts_left };
        boxes.forEach((b) => { b.value = ''; }); boxes[0].focus(); sync();
        toast(tx('onboarding.render.we_sent_you_a_new'));
      } catch (ex) {
        err.textContent = ex.code === 'sms_cooldown' || ex.code === 'sms_rate_limited' ? tx('onboarding.render.try_again_in_seconds', { cap: cap(ex.message), value: ex.retryAfter || tx('onboarding.render.a_few') }) : cap(fieldErr(ex));
        if (ex.retryAfter) until = Date.now() + ex.retryAfter * 1000;
      }
      tickResend();
    };
    f.querySelector('[data-change-number]').onclick = () => go('phone');
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (!/^\d{4}$/.test(value())) return;
      const err = f.querySelector('[data-testid=ob-error]');
      err.textContent = ''; busy(f, true);
      try { state = await idApi.verifyCode(uid, value()); draft = (await idApi.state(uid, true)).details || draft; go('name'); } catch (ex) {
        err.textContent = ex.code === 'invalid_code' ? tx('onboarding.render.that_code_isn_t_right', { cap: cap(ex.details || '') }) : ex.code === 'code_expired' || ex.code === 'too_many_code_attempts' ? tx('onboarding.render.tap_resend_code_for_a', { cap: cap(ex.message) }) : cap(fieldErr(ex));
        boxes.forEach((b) => { b.value = ''; }); boxes[0].focus(); sync();
        busy(f, false); sync();
      }
    };
  }

  // ---------------------------------------------------------------- legal name
  function name() {
    el.innerHTML = frame('name', `<form class="ob-form" id="ob-name" novalidate data-testid="ob-name-form">
      ${state.status === 'retry' ? `<div class="ob-note warn" data-testid="retry-note">${esc(state.verification.reason_message || tx('onboarding.render.check_your_details_and_try'))}</div>` : ''}
      <h1 class="ob-title">${te('onboarding.render.what_s_your_name')}</h1><p class="ob-sub">${te('onboarding.render.it_helps_us_verify_your', { learn_more: learnMore('name') })}</p>
      <label class="ob-float"><input name="first_name" autocomplete="given-name" placeholder=" " maxlength="50" required value="${esc(draft.first_name || '')}" data-testid="first-name"><span>${te('onboarding.render.legal_first_name')}</span></label>
      <label class="ob-float"><input name="last_name" autocomplete="family-name" placeholder=" " maxlength="50" required value="${esc(draft.last_name || '')}" data-testid="last-name"><span>${te('onboarding.render.legal_last_name')}</span></label>
      <div class="form-error" role="alert" data-testid="ob-error"></div>
      <div class="ob-actions"><button class="btn btn-primary ob-cta" type="submit" data-testid="ob-continue">${te('onboarding.render.continue')}</button><button class="btn btn-ghost ob-cta" type="button" data-not-now data-testid="not-now">${te('onboarding.render.not_now')}</button></div></form>`);
    const f = el.querySelector('#ob-name');
    wire(el);
    f.first_name.focus();
    f.onsubmit = async (e) => {
      e.preventDefault();
      const err = f.querySelector('[data-testid=ob-error]');
      err.textContent = '';
      if (!f.first_name.value.trim() || !f.last_name.value.trim()) { err.textContent = tx('onboarding.render.enter_your_legal_first_and'); return; }
      busy(f, true);
      try { state = await idApi.saveName(uid, { first_name: f.first_name.value, last_name: f.last_name.value }); draft = { ...draft, first_name: f.first_name.value.trim(), last_name: f.last_name.value.trim() }; go('birthday'); } catch (ex) { err.textContent = cap(fieldErr(ex)); busy(f, false); }
    };
  }

  // ---------------------------------------------------------------- birthday (MM · DD · Year, auto-advance)
  function birthday() {
    const d = draft.dob || {};
    el.innerHTML = frame('birthday', `<form class="ob-form" id="ob-dob" novalidate data-testid="ob-dob-form">
      <h1 class="ob-title">${te('onboarding.render.when_s_your_birthday')}</h1>
      <div class="ob-dob">
        <label class="ob-float"><input name="month" inputmode="numeric" maxlength="2" placeholder=" " autocomplete="bday-month" value="${esc(d.month ? String(d.month).padStart(2, '0') : '')}" data-testid="dob-month"><span>${te('onboarding.render.mm')}</span></label>
        <label class="ob-float"><input name="day" inputmode="numeric" maxlength="2" placeholder=" " autocomplete="bday-day" value="${esc(d.day ? String(d.day).padStart(2, '0') : '')}" data-testid="dob-day"><span>${te('onboarding.render.dd')}</span></label>
        <label class="ob-float ob-year"><input name="year" inputmode="numeric" maxlength="4" placeholder=" " autocomplete="bday-year" value="${esc(d.year || '')}" data-testid="dob-year"><span>${te('onboarding.render.year')}</span></label></div>
      <ul class="ob-notices"><li>${te('onboarding.render.you_must_be_18_or')}</li><li>${te('onboarding.render.federal_law_requires_submitting_truthful')}</li></ul>
      <div class="form-error" role="alert" data-testid="ob-error"></div>
      <div class="ob-actions"><button class="btn btn-primary ob-cta" type="submit" disabled data-ready="0" data-testid="ob-continue">${te('onboarding.render.continue')}</button><button class="btn btn-ghost ob-cta" type="button" data-not-now data-testid="not-now">${te('onboarding.render.not_now')}</button></div></form>`);
    const f = el.querySelector('#ob-dob');
    wire(el);
    const inputs = [f.month, f.day, f.year];
    const btn = f.querySelector('[type=submit]');
    const valid = () => {
      const [m, dd, y] = inputs.map((i) => Number(i.value));
      if (!/^\d{1,2}$/.test(f.month.value) || !/^\d{1,2}$/.test(f.day.value) || !/^\d{4}$/.test(f.year.value)) return false;
      const dt = new Date(Date.UTC(y, m - 1, dd));
      return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === dd && y >= 1900 && dt < new Date();
    };
    const sync = () => { const ok = valid(); btn.dataset.ready = ok ? '1' : '0'; btn.disabled = !ok; };
    inputs.forEach((inp, i) => {
      inp.addEventListener('input', () => {
        inp.value = inp.value.replace(/\D/g, '');
        if (inputs[i + 1] && inp.value.length === Number(inp.getAttribute('maxlength'))) inputs[i + 1].focus();
        sync();
      });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Backspace' && !inp.value && inputs[i - 1]) inputs[i - 1].focus(); });
    });
    (inputs.find((i) => !i.value) || f.month).focus();
    sync();
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (!valid()) return;
      const err = f.querySelector('[data-testid=ob-error]');
      err.textContent = ''; busy(f, true);
      try {
        state = await idApi.saveBirthday(uid, { month: Number(f.month.value), day: Number(f.day.value), year: Number(f.year.value) });
        draft = { ...draft, dob: { month: Number(f.month.value), day: Number(f.day.value), year: Number(f.year.value) } };
        go('address');
      } catch (ex) { err.textContent = ex.code === 'age_requirement' ? tx('onboarding.render.you_must_be_18_or') : cap(fieldErr(ex)); busy(f, false); sync(); }
    };
  }

  // ---------------------------------------------------------------- address + national ID
  function address() {
    const a = draft.address || {};
    const initial = byCode[a.country || state.country || state.pending_phone?.country || state.phone?.country || 'US'] || countries[0];
    el.innerHTML = frame('address', `<form class="ob-form" id="ob-addr" novalidate autocomplete="on" data-testid="ob-address-form">
      <h1 class="ob-title">${te('onboarding.render.what_s_your_address')}</h1><p class="ob-sub">${te('onboarding.render.we_won_t_send_you')}</p>
      <label class="ob-float"><select name="country" autocomplete="country" data-testid="addr-country">${countries.map((c) => `<option value="${esc(c.code)}"${c.code === initial.code ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select><span>${te('onboarding.render.country')}</span></label>
      <div class="ob-suggest-wrap"><label class="ob-float"><input name="line1" autocomplete="address-line1" placeholder=" " maxlength="100" required value="${esc(a.line1 || '')}" data-testid="addr-line1" aria-autocomplete="list" aria-controls="ob-suggest"><span>${te('onboarding.render.residential_address')}</span></label>
        <ul class="ob-suggest" id="ob-suggest" role="listbox" hidden data-testid="addr-suggestions"></ul></div>
      <label class="ob-float"><input name="line2" autocomplete="address-line2" placeholder=" " maxlength="60" value="${esc(a.line2 || '')}" data-testid="addr-line2"><span>${te('onboarding.render.apt_suite_other')}</span></label>
      <label class="ob-float"><input name="city" autocomplete="address-level2" placeholder=" " maxlength="60" required value="${esc(a.city || '')}" data-testid="addr-city"><span>${te('onboarding.render.city')}</span></label>
      <div class="ob-two"><div data-region-slot></div>
        <label class="ob-float"><input name="postal_code" autocomplete="postal-code" placeholder=" " maxlength="12" required value="${esc(a.postal_code || '')}" data-testid="addr-postal"><span data-postal-label>${te('onboarding.render.postal_code')}</span></label></div>
      <label class="ob-float"><input name="national_id" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder=" " maxlength="24" required data-testid="national-id"><span data-nid-label>${te('onboarding.render.national_id')}</span></label>
      <p class="ob-fine" data-nid-hint></p>
      <div class="ob-note" data-testid="address-rule">${te('onboarding.render.use_the_same_address_as')}</div>
      <p class="ob-fine">${learnMore('identity')}</p>
      <div class="form-error" role="alert" data-testid="ob-error"></div>
      <div class="ob-actions"><button class="btn btn-primary ob-cta" type="submit" data-testid="ob-continue">${te('onboarding.render.continue')}</button><button class="btn btn-ghost ob-cta" type="button" data-not-now data-testid="not-now">${te('onboarding.render.not_now')}</button></div></form>`);
    const f = el.querySelector('#ob-addr');
    wire(el);
    const applyCountry = (keepRegion) => {
      const c = byCode[f.country.value];
      const slot = f.querySelector('[data-region-slot]');
      const cur = keepRegion ? (a.region || '') : '';
      slot.innerHTML = c.regions
        ? `<label class="ob-float"><select name="region" autocomplete="address-level1" required data-testid="addr-region"><option value="">${te('onboarding.render.select')}</option>${c.regions.map((r) => `<option value="${esc(r.code)}"${r.code === cur ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select><span>${esc(c.region_label)}</span></label>`
        : `<label class="ob-float"><input name="region" autocomplete="address-level1" placeholder=" " maxlength="60" required value="${esc(cur)}" data-testid="addr-region"><span>${esc(c.region_label)}</span></label>`;
      f.querySelector('[data-postal-label]').textContent = c.postal_label;
      f.postal_code.placeholder = ' ';
      const id = c.national_id;
      f.querySelector('[data-nid-label]').textContent = id ? `${id.label} · ${id.hint}` : tx('onboarding.render.national_id');
      f.national_id.setAttribute('inputmode', id?.inputmode || 'text');
      f.national_id.setAttribute('maxlength', String(id?.max_length || 24));
      f.national_id.value = '';
      f.querySelector('[data-nid-hint]').textContent = state.national_id && keepRegion ? tx('onboarding.render.on_file_enter_it_again', { masked: state.national_id.masked }) : tx('onboarding.render.we_encrypt_this_number_and');
    };
    applyCountry(true);
    f.country.onchange = () => applyCountry(false);
    // Address autocomplete (simulated lookup provider with invented addresses).
    const list = f.querySelector('#ob-suggest');
    let seq = 0;
    f.line1.addEventListener('input', () => {
      const q = f.line1.value.trim();
      const mine = ++seq;
      if (q.length < 2) { list.hidden = true; return; }
      const t = setTimeout(async () => {
        timers.delete(t);
        try {
          const r = await idApi.suggest(f.country.value, q);
          if (mine !== seq) return;
          list.innerHTML = r.suggestions.map((s, i) => `<li role="option" tabindex="-1" data-i="${i}" data-testid="addr-suggestion">${esc(s.line1)}, ${esc(s.city)} ${esc(s.region)} ${esc(s.postal_code)}</li>`).join('');
          list.hidden = !r.suggestions.length;
          for (const li of list.querySelectorAll('li')) {
            li.onmousedown = (ev) => {
              ev.preventDefault();
              const s = r.suggestions[Number(li.dataset.i)];
              f.line1.value = s.line1; f.city.value = s.city; f.postal_code.value = s.postal_code;
              if (f.region) f.region.value = s.region;
              list.hidden = true;
              f.line2.focus();
            };
          }
        } catch { list.hidden = true; }
      }, 200);
      timers.add(t);
    });
    f.line1.addEventListener('blur', () => { const t = setTimeout(() => { list.hidden = true; }, 150); timers.add(t); });
    f.onsubmit = async (e) => {
      e.preventDefault();
      const err = f.querySelector('[data-testid=ob-error]');
      err.textContent = ''; busy(f, true);
      const body = { country: f.country.value, line1: f.line1.value, line2: f.line2.value, city: f.city.value, region: f.region.value, postal_code: f.postal_code.value, national_id: f.national_id.value };
      try {
        state = await idApi.saveAddress(uid, body);
        draft = { ...draft, address: { ...body, national_id: undefined } };
        f.national_id.value = ''; // never kept in the page after it was sent
        state = await idApi.submit(uid);
        go('verifying');
      } catch (ex) { err.textContent = cap(fieldErr(ex)); busy(f, false); }
    };
  }

  // ---------------------------------------------------------------- verifying (spinner around the wordmark)
  function verifying() {
    el.innerHTML = frame('verifying', `<div class="ob-verifying" role="status" aria-live="polite" data-testid="ob-verifying"><div class="ob-spin">${WORDMARK}</div><p>${te('onboarding.render.verifying_info')}</p></div>`);
    const poll = async () => {
      try {
        state = await idApi.state(uid);
        if (state.status === 'pending') { later(poll, 800); return; }
        session.notify();
        go(state.status === 'documents_required' ? 'documents' : 'outcome');
      } catch { later(poll, 2000); }
    };
    later(poll, 800);
  }

  // ---------------------------------------------------------------- document verification (CLONE_SPEC §13.15)
  const VENDOR = `<footer class="ob-vendor" data-testid="docv-vendor">${te('onboarding.render.powered_by')} <strong>${te('onboarding.render.parlance_verify')}</strong> <span class="faint">${te('onboarding.render.sandbox')}</span></footer>`;
  const closeX = `<button type="button" class="ob-x" data-exit aria-label="${te('onboarding.render.close_identity_verification')}" data-testid="docv-close">✕</button>`;
  const exitDocs = async () => {
    try { await idApi.docvExit(uid); } catch { /* still leave */ }
    toast(tx('onboarding.render.your_progress_is_saved_finish'));
    navigate(next, { replace: true });
  };
  const wireExit = (root) => { for (const b of root.querySelectorAll('[data-exit]')) b.onclick = exitDocs; };
  // Intro: "Let's get you verified" (§13.15 kyc-intro).
  function documents() {
    el.innerHTML = frame('documents', `<div class="ob-docv" data-testid="docv-intro">${closeX}
      <h1 class="ob-title">${te('onboarding.render.let_s_get_you_verified')}</h1><p class="ob-sub">${te('onboarding.render.it_will_only_take_2')}</p>
      <p class="ob-need">${te('onboarding.render.what_you_will_need')}</p>
      <ul class="ob-needs"><li><span class="ob-ic">${ID_ICON}</span>${te('onboarding.render.government_issued_id')}</li><li><span class="ob-ic">${PHONE_ICON}</span>${te('onboarding.render.smartphone')}</li></ul>
      <div class="ob-actions"><button class="btn btn-primary ob-cta" data-start data-testid="docv-start">${te('onboarding.render.get_started')}</button>
        <button class="btn btn-ghost ob-cta" data-device data-testid="docv-same-device">${te('onboarding.render.continue_on_this_device_instead')}</button></div>${VENDOR}</div>`);
    wireExit(el);
    el.querySelector('[data-start]').onclick = () => qrStep();
    el.querySelector('[data-device]').onclick = () => deviceStep();
  }
  // "Continue on your phone" (§13.15 kyc-qr): a locally generated QR for a single-use, 10-minute, session-bound link.
  async function qrStep() {
    let r;
    try { r = await idApi.docvStart(uid); } catch (ex) { toast(cap(fieldErr(ex)), 'error'); return; }
    el.innerHTML = frame('doc-qr', `<div class="ob-docv" data-testid="docv-qr-step">${closeX}
      <h1 class="ob-title">${te('onboarding.render.continue_on_your_phone')}</h1><p class="ob-sub">${te('onboarding.render.here_s_how_you_do')}</p>
      <div class="ob-qr" data-testid="docv-qr">${qrSvg(r.handoff_url, { px: 5, label: tx('onboarding.render.qr_code_to_continue_identity') })}</div>
      <p class="ob-fine" data-testid="docv-qr-expiry">${te('onboarding.render.the_code_works_once_and')}</p>
      <div class="ob-actions"><button class="btn btn-ghost ob-cta" data-device data-testid="docv-same-device">${te('onboarding.render.can_t_scan_it_continue')}</button></div>${VENDOR}</div>`);
    wireExit(el);
    el.querySelector('[data-device]').onclick = () => deviceStep();
    watch('qr');
  }
  // Desktop waiting screen (§13.15 kyc-wait): "Stay on this page" while the phone uploads; follows the upload live.
  function waitStep(st) {
    el.innerHTML = frame('doc-wait', `<div class="ob-docv" data-testid="docv-wait">${closeX}
      <div class="ob-scan" aria-hidden="true"><span class="ob-scan-id">${ID_ICON}</span><span class="ob-scan-face">${FACE_ICON}</span><i class="ob-scan-line"></i></div>
      <h1 class="ob-title">${te('onboarding.render.stay_on_this_page')}</h1><p class="ob-sub">${te('onboarding.render.check_back_here_to_complete')}</p>
      <p class="ob-status" role="status" aria-live="polite" data-testid="docv-status">${te('onboarding.render.uploading_your_documents')}</p>
      <ul class="ob-doclist" data-testid="docv-doclist">${docList(st)}</ul>
      <div class="ob-actions"><button class="btn ob-pill" data-exit data-testid="docv-exit">${te('onboarding.render.exit_identity_verification')}</button></div>${VENDOR}</div>`);
    wireExit(el);
  }
  const docList = (st) => st.documents.map((d) => `<li data-kind="${esc(d.kind)}" data-uploaded="${d.uploaded ? '1' : '0'}">${d.uploaded ? '✓' : '○'} ${esc(d.label)}</li>`).join('');
  // Poll the verification state (1.5 s): phone connected → waiting screen; documents submitted → verifying → outcome.
  function watch(mode) {
    let shown = mode;
    const tick = async () => {
      let st;
      try { st = await idApi.docv(uid); } catch { later(tick, 3000); return; }
      if (st.identity_status === 'pending' || ['approved', 'review', 'rejected', 'retry'].includes(st.identity_status)) { state = await idApi.state(uid).catch(() => state); go(state.status === 'pending' ? 'verifying' : 'outcome'); return; }
      if (shown === 'qr' && st.session && st.session.phone_connected && st.session.status === 'claimed') { shown = 'wait'; waitStep(st); }
      else if (shown === 'wait') { const ul = el.querySelector('[data-testid=docv-doclist]'); if (ul) ul.innerHTML = docList(st); }
      if (shown === 'qr' && st.session && ['expired', 'exited', 'replaced', 'closed'].includes(st.session.status)) {
        const q = el.querySelector('[data-testid=docv-qr]');
        if (q) q.innerHTML = `<p class="ob-note warn" data-testid="docv-qr-expired">${te('onboarding.render.this_code_expired')} <button class="btn btn-sm" data-new-code>${te('onboarding.render.show_a_new_code')}</button></p>`;
        el.querySelector('[data-new-code]')?.addEventListener('click', () => qrStep());
        return;
      }
      if (shown === 'wait' && st.session && st.session.status !== 'claimed') {
        const s2 = el.querySelector('[data-testid=docv-status]');
        if (s2) s2.textContent = tx('onboarding.render.your_phone_disconnected_exit_and');
      }
      later(tick, 1500);
    };
    later(tick, 1000);
  }
  // Same-device fallback (accessibility): file inputs here, same checks and encryption as the phone flow.
  async function deviceStep() {
    const st = await idApi.docv(uid);
    el.innerHTML = frame('doc-device', `<div class="ob-docv" data-testid="docv-device">${closeX}
      <h1 class="ob-title">${te('onboarding.render.add_photos_of_your_id')}</h1><p class="ob-sub">${te('onboarding.render.take_or_choose_clear_photos')}</p>
      <ul class="ob-capture">${DOC_KINDS.map(([k, label, hint, cap2]) => `<li data-kind="${esc(k)}"><label class="ob-capture-btn"><input type="file" accept="image/*" capture="${esc(cap2)}" data-capture="${esc(k)}" data-testid="device-capture-${esc(k)}"><span>${esc(label)}</span><small class="faint">${esc(hint)}</small></label>
        <span class="ob-capture-state" data-state="${esc(k)}">${st.documents.find((d) => d.kind === k)?.uploaded ? te('onboarding.render.added') : ''}</span></li>`).join('')}</ul>
      <div class="form-error" role="alert" data-testid="ob-error"></div>
      <div class="ob-actions"><button class="btn btn-primary ob-cta" data-submit data-testid="docv-device-submit" ${st.complete ? '' : 'disabled'}>${te('onboarding.render.submit_photos')}</button>
        <button class="btn ob-pill" data-exit data-testid="docv-exit">${te('onboarding.render.exit_identity_verification')}</button></div>${VENDOR}</div>`);
    wireExit(el);
    const err = el.querySelector('[data-testid=ob-error]');
    const btn = el.querySelector('[data-submit]');
    for (const inp of el.querySelectorAll('[data-capture]')) {
      inp.onchange = async () => {
        const kind = inp.dataset.capture; const file = inp.files && inp.files[0];
        if (!file) return;
        const out = el.querySelector(`[data-state="${CSS.escape(kind)}"]`);
        err.textContent = ''; out.textContent = tx('onboarding.render.uploading');
        try {
          const r = await idApi.docvUpload(uid, kind, await reencodeImage(file));
          out.textContent = tx('onboarding.render.added');
          btn.disabled = !r.complete;
        } catch (ex) { out.textContent = ''; err.textContent = cap(ex.details || ex.message); }
        inp.value = '';
      };
    }
    btn.onclick = async () => {
      btn.disabled = true;
      try { state = await idApi.docvSubmit(uid).then(() => idApi.state(uid)); go('verifying'); } catch (ex) { err.textContent = cap(ex.details || ex.message); btn.disabled = false; }
    };
  }

  // ---------------------------------------------------------------- outcome screens (design choice: not captured, §13.14)
  function outcome() {
    const st = state.status;
    const v = state.verification || {};
    const view = {
      approved: ['ok', tx('onboarding.render.you_re_verified'), tx('onboarding.render.your_identity_is_confirmed_you'), `<a class="btn btn-primary ob-cta" href="${esc(next === '/' ? '/portfolio' : next)}" data-link data-testid="outcome-continue">${te('onboarding.render.start_trading')}</a>`],
      review: ['wait', tx('onboarding.render.we_re_reviewing_your_info'), v.reason_message || tx('onboarding.render.our_team_is_reviewing_your'), `<a class="btn btn-primary ob-cta" href="${esc(next)}" data-link data-testid="outcome-continue">${te('onboarding.render.continue_browsing')}</a>`],
      rejected: ['bad', tx('onboarding.render.we_couldn_t_verify_your'), `${v.reason_message || tx('onboarding.render.contact_support_for_help')} Support: support@parlance.example`, `<a class="btn btn-primary ob-cta" href="/" data-link data-testid="outcome-continue">${te('onboarding.render.back_to_parlance')}</a>`],
      retry: ['warn', tx('onboarding.render.let_s_try_that_again'), v.reason_message || tx('onboarding.render.we_couldn_t_verify_your_2'), `<button class="btn btn-primary ob-cta" data-retry data-testid="outcome-retry">${te('onboarding.render.check_my_details')}</button>`],
      closed: ['bad', tx('onboarding.render.this_account_is_closed'), tx('onboarding.render.closed_accounts_cannot_be_verified'), `<a class="btn btn-primary ob-cta" href="/" data-link>${te('onboarding.render.back_to_parlance')}</a>`],
    }[st] || ['wait', tx('onboarding.render.verification'), '', `<a class="btn btn-primary ob-cta" href="${esc(next)}" data-link>${te('onboarding.render.continue')}</a>`];
    el.innerHTML = frame('outcome', `<div class="ob-outcome ${esc(view[0])}" data-testid="ob-outcome" data-status="${esc(st)}" data-reason="${esc(v.reason_category || '')}">
      <div class="ob-badge" aria-hidden="true"></div><h1 class="ob-title" data-testid="outcome-title">${esc(view[1])}</h1><p class="ob-sub" data-testid="outcome-message">${esc(view[2])}</p>
      ${st === 'retry' ? `<p class="ob-fine">${te('onboarding.render.attempt_left', { attempts_left: esc(String(v.attempts_left)), value: v.attempts_left === 1 ? '' : 's' })}</p>` : ''}
      <div class="ob-actions">${view[3] /* eslint-disable-line parlance/no-unescaped-html -- action buttons: static markup from the table above with esc()'d hrefs */}</div></div>`);
    el.querySelector('[data-retry]')?.addEventListener('click', async () => { draft = (await idApi.state(uid, true)).details || draft; go('name'); });
  }

  start();
  return cleanup;
}

// ------------------------------------------------------------------ banner ("Not now" → finish later) + compliance dialog
let bannerEl = null;
let bannerSeq = 0;
export async function refreshIdentityBanner() {
  const mine = ++bannerSeq;
  if (!bannerEl) {
    bannerEl = document.createElement('div');
    bannerEl.className = 'id-banner';
    bannerEl.dataset.testid = 'identity-banner';
    bannerEl.setAttribute('role', 'status');
    bannerEl.hidden = true;
    document.getElementById('conn-banner')?.after(bannerEl);
  }
  if (!session.user || location.pathname.startsWith('/sign-up/identity')) { bannerEl.hidden = true; return; }
  try {
    // Region banner (like CLONE_SPEC §13.17 "not available in your region"): the location check comes first.
    const geo = await idApi.geolocation(session.uid).catch(() => null);
    if (mine !== bannerSeq) return;
    if (geo && !geo.allowed) {
      bannerEl.dataset.status = 'geo_blocked';
      bannerEl.innerHTML = `<span data-testid="region-banner">${esc(tx('onboarding.refresh_identity_banner.trading_deposits_and_withdrawals_aren', { country_name: geo.country_name }))}</span> <a href="/account/privacy" data-link data-testid="identity-banner-cta">${te('onboarding.refresh_identity_banner.location_details')}</a>`;
      bannerEl.hidden = false;
      return;
    }
    if (!flagOn('identity.kyc')) { bannerEl.hidden = true; return; } // identity verification flag off (CLONE_SPEC.md §33)
    const cfg = await idApi.config();
    if (!cfg.kyc_required) { bannerEl.hidden = true; return; }
    const s = await idApi.state(session.uid);
    if (mine !== bannerSeq) return;
    if (!s.kyc_required || ['approved', 'closed'].includes(s.status)) { bannerEl.hidden = true; return; }
    const text = s.status === 'pending' || s.status === 'review' ? tx('onboarding.refresh_identity_banner.we_re_verifying_your_identity')
      : s.status === 'rejected' ? tx('onboarding.refresh_identity_banner.we_couldn_t_verify_your') : tx('onboarding.refresh_identity_banner.verify_your_identity_to_start');
    const cta = s.status === 'pending' || s.status === 'review' ? tx('onboarding.refresh_identity_banner.view_status') : s.status === 'rejected' ? tx('onboarding.refresh_identity_banner.see_details') : s.status === 'not_started' ? tx('onboarding.refresh_identity_banner.get_started') : tx('onboarding.refresh_identity_banner.finish_verification');
    bannerEl.dataset.status = s.status;
    bannerEl.innerHTML = `<span>${esc(text)}</span> <a href="/sign-up/identity?next=${encodeURIComponent(location.pathname)}" data-link data-testid="identity-banner-cta">${esc(cta)}</a>`;
    bannerEl.hidden = false;
  } catch { bannerEl.hidden = true; }
}

let dialogOpen = false;
function complianceDialog(err) {
  if (dialogOpen) return;
  dialogOpen = true;
  const d = document.createElement('dialog');
  d.className = 'ob-dialog';
  d.dataset.testid = 'compliance-dialog';
  d.dataset.code = err.code;
  const close = () => { d.close(); d.remove(); dialogOpen = false; };
  if (err.code === 'identity_verification_required') {
    const pending = err.identity_status === 'pending' || err.identity_status === 'review';
    d.innerHTML = `<h2>${pending ? te('onboarding.compliance_dialog.verification_in_progress') : te('onboarding.compliance_dialog.verify_your_identity_first')}</h2><p class="muted">${esc(pending ? tx('onboarding.compliance_dialog.we_re_still_verifying_your') : tx('onboarding.compliance_dialog.to_finish_identity_verification_it', { value: err.action === 'withdrawal' ? 'withdraw' : err.action === 'trade' ? 'trade' : err.action === 'deposit' ? 'deposit' : 'continue' }))}</p>
      <div class="ob-dialog-actions"><button class="btn" data-close>${te('onboarding.compliance_dialog.not_now')}</button><a class="btn btn-primary" href="/sign-up/identity?next=${encodeURIComponent(location.pathname)}" data-link data-go data-testid="compliance-verify">${pending ? te('onboarding.compliance_dialog.view_status') : te('onboarding.compliance_dialog.verify_identity')}</a></div>`;
  } else if (err.code === 'geo_restricted') {
    d.innerHTML = `<h2>${te('onboarding.compliance_dialog.not_available_in_your_location')}</h2><p class="muted" data-testid="geo-message">${esc(tx('onboarding.compliance_dialog.trading_deposits_and_withdrawals_aren', { value: err.country_name || 'your current location' }))}</p>
      <p class="faint">${te('onboarding.compliance_dialog.we_check_your_location_using')}</p>
      <div class="ob-dialog-actions"><button class="btn btn-primary" data-close data-testid="compliance-close">${te('onboarding.compliance_dialog.ok')}</button></div>`;
  } else {
    d.innerHTML = `<h2>${te('onboarding.compliance_dialog.passkey_required')}</h2><p class="muted">${esc(err.details || tx('onboarding.compliance_dialog.confirm_with_your_passkey_to'))}</p><div class="ob-dialog-actions"><button class="btn btn-primary" data-close>${te('onboarding.compliance_dialog.ok')}</button></div>`;
  }
  for (const b of d.querySelectorAll('[data-close]')) b.onclick = close;
  d.querySelector('[data-go]')?.addEventListener('click', close);
  d.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  document.body.appendChild(d);
  d.showModal();
}

export function initIdentityUi() {
  window.addEventListener('parlance:compliance', (e) => { complianceDialog(e.detail || {}); if (e.detail && e.detail.code === 'geo_restricted') refreshIdentityBanner(); });
  window.addEventListener('parlance:notification', (e) => { if (e.detail && e.detail.type === 'identity') refreshIdentityBanner(); });
  let lastUid; // refresh on sign-in / sign-out only, not on every balance update
  session.subscribe(() => { if (session.uid !== lastUid) { lastUid = session.uid; refreshIdentityBanner(); } });
}
