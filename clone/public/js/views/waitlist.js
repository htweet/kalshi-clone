// Real-money launch waitlist (CLONE_SPEC.md §36): /waitlist (CMS pitch, optional public progress bar, one-click join
// when signed in, email + double opt-in for guests, the member's status and the opinion survey), /waitlist/confirm
// (the double opt-in landing page) and /waitlist/unsubscribe (the one-click unsubscribe link in every email, with
// "delete my data"). Every string is a catalog key (content/waitlist-strings.js); the consent wording comes from the
// server (CMS text server.waitlists.consent.text) with its version, which the join request echoes back.
import { t, te, tr } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/waitlist-strings.js';
import { request } from '../api.js';
import { session } from '../store.js';
import { esc, toast, fmtDate } from '../lib.js';
import { vars } from '../dynstyle.js';
import { flagOn } from '../flags.js';

const API = '/v1/waitlists/real_money_launch';
let seq = 0; // only the latest render may draw (a flag or session change re-renders while a request is in flight)
const SOURCES = ['banner', 'funds', 'home', 'direct', 'email', 'social', 'referral', 'other'];

function attribution(query) {
  const g = (k) => (query && query.get(k)) || undefined;
  const src = g('src');
  return { source: SOURCES.includes(src) ? src : undefined, utm_source: g('utm_source'), utm_medium: g('utm_medium'), utm_campaign: g('utm_campaign'), ref: g('ref') };
}
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ''));

// ---------------------------------------------------------------- survey (shared by the page and the confirm landing)
function surveyHtml(sv) {
  if (!sv || !sv.enabled || !sv.questions.length) return '';
  const a = sv.answers || {};
  const dis = sv.locked ? ' disabled' : '';
  const q = (x) => {
    const name = esc(x.key);
    if (x.kind === 'text') return `<label class="field" data-testid="survey-q" data-key="${name}"><span>${esc(x.prompt)}</span><textarea name="${name}" rows="3" maxlength="${esc(x.max_len)}"${dis}>${esc(a[x.key] || '')}</textarea><small class="faint">${te('waitlist.survey.chars_left', { max: esc(x.max_len) })}</small></label>`;
    const opts = x.kind === 'naira_band' ? x.bands : x.options;
    const type = x.kind === 'multi' ? 'checkbox' : 'radio';
    const chosen = (id) => (x.kind === 'multi' ? (a[x.key] || []).includes(id) : a[x.key] === id);
    return `<fieldset class="wl-q" data-testid="survey-q" data-key="${name}"><legend>${esc(x.prompt)}</legend>${opts.map((o) => `<label class="wl-opt"><input type="${type}" name="${name}" value="${esc(o.id)}"${chosen(o.id) ? ' checked' : ''}${dis}> <span>${esc(o.label)}</span></label>`).join('')}</fieldset>`;
  };
  return `<section class="card panel wl-survey" data-testid="waitlist-survey" data-locked="${sv.locked ? '1' : '0'}"><h2>${te('waitlist.survey.title')}</h2>
    <p class="muted">${sv.locked ? te('waitlist.survey.locked') : te('waitlist.survey.intro')}</p>
    <form data-survey>${sv.questions.map(q).join('')}${sv.locked ? '' : `<button class="btn btn-primary" type="submit" data-testid="survey-save">${te('waitlist.survey.save')}</button>`}<p class="form-error" data-survey-err></p></form></section>`;
}
function wireSurvey(root, sv, { token = null } = {}) {
  const f = root.querySelector('[data-survey]');
  if (!f || sv.locked) return;
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const answers = {};
    for (const x of sv.questions) {
      if (x.kind === 'text') answers[x.key] = f.querySelector(`textarea[name="${CSS.escape(x.key)}"]`).value;
      else if (x.kind === 'multi') answers[x.key] = [...f.querySelectorAll(`input[name="${CSS.escape(x.key)}"]:checked`)].map((i) => i.value);
      else { const c = f.querySelector(`input[name="${CSS.escape(x.key)}"]:checked`); if (c) answers[x.key] = c.value; }
    }
    const btn = f.querySelector('[data-testid=survey-save]');
    btn.disabled = true;
    f.querySelector('[data-survey-err]').textContent = '';
    try {
      const r = await request('PUT', `${API}/survey`, clean({ answers, token }));
      sv.answers = r.survey.answers;
      toast(t('waitlist.survey.saved'));
      f.dataset.saved = '1';
    } catch (ex) { f.querySelector('[data-survey-err]').textContent = ex.message; } finally { btn.disabled = false; }
  });
}

// ---------------------------------------------------------------- /waitlist
function progressHtml(p) {
  if (!p) return '';
  const pct = p.target ? Math.min(100, Math.round((p.count / p.target) * 100)) : null;
  const n = Number(p.count).toLocaleString('en-NG');
  return `<div class="wl-progress" data-testid="waitlist-progress" data-count="${esc(p.count)}" data-target="${esc(p.target ?? '')}">
    <div class="wl-progress-label">${p.target ? te('waitlist.progress.label', { count: esc(n), target: esc(Number(p.target).toLocaleString('en-NG')) }) : te('waitlist.progress.count_only', { count: esc(n) })}</div>
    ${pct == null ? '' : `<div class="wl-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${esc(pct)}"><span class="v-w"${vars({ '--w': `${pct}%` })}></span></div>`}</div>`;
}
function joinHtml(d, state) {
  const consent = `<p class="faint wl-consent" data-testid="waitlist-consent-text" data-version="${esc(d.consent.version)}">${esc(d.consent.text)}</p>`;
  if (state.checkEmail) return `<section class="card panel" data-testid="waitlist-check-email"><h2>${te('waitlist.join.check_email_title')}</h2><p>${te('waitlist.join.check_email', { hours: esc(d.confirm_hours) })}</p></section>`;
  if (session.user) {
    return `<section class="card panel wl-join"><h2>${te('waitlist.join.title')}</h2><p class="faint">${te('waitlist.join.signed_in_as', { email: esc(session.user.email) })}</p>${consent}
      <button class="btn btn-primary btn-lg" type="button" data-testid="waitlist-join-one-click">${te('waitlist.join.one_click')}</button><p class="form-error" data-join-err></p></section>`;
  }
  return `<section class="card panel wl-join"><h2>${te('waitlist.join.title')}</h2><form data-guest novalidate>
    <label class="field"><span>${te('waitlist.join.email')}</span><input type="email" name="email" autocomplete="email" required maxlength="254" placeholder="${te('waitlist.join.email_placeholder')}" data-testid="waitlist-email"></label>
    <div class="wl-hp" aria-hidden="true"><label>${te('waitlist.join.honeypot')} <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
    ${consent}<label class="wl-opt"><input type="checkbox" name="agree" data-testid="waitlist-agree"> <span>${te('waitlist.join.agree')}</span></label>
    <button class="btn btn-primary btn-lg" type="submit" data-testid="waitlist-guest-submit">${te('waitlist.join.submit')}</button><p class="form-error" data-join-err data-testid="waitlist-join-error"></p></form>
    <div class="faint wl-signin">${tr('waitlist.join.or_sign_in')}</div></section>`;
}
function statusHtml(me) {
  if (me.entry_status === 'unsubscribed') return '';
  return `<section class="card panel wl-status" data-testid="waitlist-status" data-status="${esc(me.entry_status)}"><h2>${te('waitlist.status.title')}</h2>
    <p class="muted">${te('waitlist.status.since', { date: esc(fmtDate(me.confirmed_time || me.joined_time)) })}</p>
    <div class="d-flex gap-8 fw-wrap"><button class="btn" type="button" data-testid="waitlist-leave">${te('waitlist.status.leave')}</button><button class="btn btn-ghost" type="button" data-testid="waitlist-delete">${te('waitlist.status.delete')}</button></div></section>`;
}

async function renderMain({ el, query }) {
  const my = ++seq;
  document.title = t('waitlist.page.doc_title');
  const state = { checkEmail: false };
  const [d, p] = await Promise.all([request('GET', API), flagOn('waitlist.launch.public_count') ? request('GET', `${API}/progress`).then((r) => r.progress).catch(() => null) : null]);
  if (my !== seq) return;
  const draw = (data) => {
    const me = data.me;
    const member = me && me.entry_status === 'confirmed';
    el.innerHTML = `<div class="wl-page" data-testid="waitlist-page"><div class="wl-head"><span class="overline">${te('waitlist.page.overline')}</span><h1 class="page-title">${te('waitlist.page.title')}</h1></div>
      <div class="wl-grid"><div class="wl-main"><section class="card panel wl-pitch" data-testid="waitlist-pitch">${tr('waitlist.page.pitch')}${progressHtml(p)}</section>
      ${me && me.entry_status === 'unsubscribed' ? `<p class="muted" data-testid="waitlist-unsubscribed-note">${te('waitlist.status.unsubscribed', { date: esc(fmtDate(me.unsubscribed_time)) })}</p>` : ''}
      ${member ? statusHtml(me) : joinHtml(data, state)}</div>
      <div class="wl-side">${member ? surveyHtml(data.survey) : ''}</div></div></div>`;
    wire(data);
  };
  const wire = (data) => {
    const err = el.querySelector('[data-join-err]');
    const one = el.querySelector('[data-testid=waitlist-join-one-click]');
    if (one) one.onclick = async () => {
      one.disabled = true;
      try {
        const r = await request('POST', `${API}/join`, clean({ consent: true, consent_version: data.consent.version, ...attribution(query) }));
        if (my !== seq) return;
        if (r.status === 'check_email') { state.checkEmail = true; draw(data); return; } // an unverified account email: double opt-in
        toast(t('waitlist.join.joined_toast'));
        draw(r);
      } catch (ex) { err.textContent = ex.message; one.disabled = false; }
    };
    const g = el.querySelector('[data-guest]');
    if (g) g.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (!g.agree.checked) { err.textContent = t('waitlist.join.need_consent'); return; }
      const btn = g.querySelector('[data-testid=waitlist-guest-submit]');
      btn.disabled = true;
      try {
        await session.preAuth(); // login CSRF: the guest form is a pre-session endpoint
        await request('POST', `${API}/guest_join`, clean({ email: g.email.value.trim(), website: g.website.value, consent: true, consent_version: data.consent.version, ...attribution(query) }));
        state.checkEmail = true;
        if (my === seq) draw(data);
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
    const leave = el.querySelector('[data-testid=waitlist-leave]');
    if (leave) leave.onclick = async () => { try { const r = await request('POST', `${API}/unsubscribe`, {}); toast(t('waitlist.status.left_toast')); if (my === seq) draw(r); } catch (ex) { toast(ex.message, 'error'); } };
    const del = el.querySelector('[data-testid=waitlist-delete]');
    if (del) del.onclick = async () => {
      if (!window.confirm(t('waitlist.status.delete_confirm'))) return;
      try { const r = await request('DELETE', `${API}/me`); toast(t('waitlist.status.deleted_toast')); if (my === seq) draw(r); } catch (ex) { toast(ex.message, 'error'); }
    };
    if (data.survey && data.me && data.me.entry_status === 'confirmed') wireSurvey(el, data.survey);
  };
  draw(d);
}

// ---------------------------------------------------------------- /waitlist/confirm?token=…
async function renderConfirm({ el, query }) {
  const my = ++seq;
  document.title = t('waitlist.page.doc_title');
  const token = query.get('token') || '';
  if (!token) { el.innerHTML = `<div class="card empty center-40" data-testid="waitlist-confirm-error"><p>${te('waitlist.confirm.missing')}</p></div>`; return; }
  el.innerHTML = `<div class="wl-page wl-narrow"><section class="card panel" data-testid="waitlist-confirm"><h1 class="page-title">${te('waitlist.confirm.title')}</h1><p class="muted">${te('waitlist.confirm.body')}</p>
    <button class="btn btn-primary btn-lg" type="button" data-testid="waitlist-confirm-btn">${te('waitlist.confirm.button')}</button><p class="form-error" data-testid="waitlist-confirm-error"></p></section></div>`;
  const btn = el.querySelector('[data-testid=waitlist-confirm-btn]');
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const r = await request('POST', '/v1/waitlists/confirm', { token });
      if (my !== seq) return;
      el.innerHTML = `<div class="wl-page wl-narrow"><section class="card panel" data-testid="waitlist-confirmed"><h1 class="page-title">${te('waitlist.confirm.done_title')}</h1><p>${te('waitlist.confirm.done')}</p></section>${surveyHtml(r.survey)}</div>`;
      wireSurvey(el, r.survey, { token: r.manage_token });
    } catch (ex) { el.querySelector('[data-testid=waitlist-confirm-error]').textContent = ex.message; el.querySelector('[data-testid=waitlist-confirm-error]').dataset.code = ex.code || ''; btn.disabled = false; }
  };
}

// ---------------------------------------------------------------- /waitlist/unsubscribe?token=… (one click from the email)
async function renderUnsubscribe({ el, query }) {
  const my = ++seq;
  document.title = t('waitlist.unsub.title');
  const token = query.get('token') || '';
  el.innerHTML = `<div class="wl-page wl-narrow"><section class="card panel" data-testid="waitlist-unsub-working"><p class="muted">${te('waitlist.unsub.working')}</p></section></div>`;
  let r;
  try { r = await request('POST', '/v1/waitlists/unsubscribe', { token }); } catch (ex) {
    if (my !== seq) return;
    el.innerHTML = `<div class="card empty center-40" data-testid="waitlist-unsub-error" data-code="${esc(ex.code || '')}"><p>${esc(ex.message)}</p></div>`;
    return;
  }
  if (my !== seq) return;
  const m = await request('POST', '/v1/waitlists/manage', { token }).catch(() => null);
  if (my !== seq) return;
  el.innerHTML = `<div class="wl-page wl-narrow"><section class="card panel" data-testid="waitlist-unsubscribed" data-status="${esc(r.me.entry_status)}"><h1 class="page-title">${te('waitlist.unsub.done_title')}</h1>
    <p>${te('waitlist.unsub.done', { email: esc((m && m.email_masked) || '') })}</p><p class="muted">${te('waitlist.unsub.delete_hint')}</p>
    <button class="btn btn-danger" type="button" data-testid="waitlist-unsub-delete">${te('waitlist.unsub.delete')}</button><div class="faint mt-12">${tr('waitlist.unsub.rejoin')}</div></section></div>`;
  el.querySelector('[data-testid=waitlist-unsub-delete]').onclick = async () => {
    try {
      await request('POST', '/v1/waitlists/delete', { token });
      if (my !== seq) return;
      el.innerHTML = `<div class="wl-page wl-narrow"><section class="card panel" data-testid="waitlist-deleted"><h1 class="page-title">${te('waitlist.unsub.deleted_title')}</h1><p>${te('waitlist.unsub.deleted')}</p><div class="faint">${tr('waitlist.unsub.rejoin')}</div></section></div>`;
    } catch (ex) { toast(ex.message || t('waitlist.error.generic'), 'error'); }
  };
}

// ---------------------------------------------------------------- /waitlist/manage?token=… (a guest's place and survey)
// The "your place and survey" link of the welcome emails: it only reads until the member chooses to leave or delete.
async function renderManage({ el, query }) {
  const my = ++seq;
  document.title = t('waitlist.page.doc_title');
  const token = query.get('token') || '';
  let m;
  try { m = await request('POST', '/v1/waitlists/manage', { token }); } catch (ex) {
    if (my !== seq) return;
    el.innerHTML = `<div class="card empty center-40" data-testid="waitlist-manage-error" data-code="${esc(ex.code || '')}"><p>${esc(ex.message)}</p></div>`;
    return;
  }
  if (my !== seq) return;
  const st = m.me.entry_status;
  const date = esc(fmtDate(st === 'unsubscribed' ? m.me.unsubscribed_time : m.me.confirmed_time || m.me.joined_time));
  el.innerHTML = `<div class="wl-page wl-narrow"><section class="card panel" data-testid="waitlist-manage" data-status="${esc(st)}"><h1 class="page-title">${te('waitlist.manage.title')}</h1>
    <p>${te(`waitlist.manage.status_${st === 'confirmed' || st === 'unsubscribed' ? st : 'pending'}`, { email: esc(m.email_masked || ''), date })}</p>
    <div class="d-flex gap-8 fw-wrap">${st === 'unsubscribed' ? '' : `<a class="btn" href="/waitlist/unsubscribe?token=${encodeURIComponent(token)}" data-link data-testid="waitlist-manage-unsubscribe">${te('waitlist.manage.unsubscribe')}</a>`}</div></section>${st === 'confirmed' ? surveyHtml(m.survey) : ''}</div>`;
  if (st === 'confirmed') wireSurvey(el, m.survey, { token });
}

export async function render(ctx) {
  if (ctx.params.page === 'confirm') return renderConfirm(ctx);
  if (ctx.params.page === 'unsubscribe') return renderUnsubscribe(ctx);
  if (ctx.params.page === 'manage') return renderManage(ctx);
  return renderMain(ctx);
}
