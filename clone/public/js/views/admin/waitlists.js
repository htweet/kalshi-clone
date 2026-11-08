// Admin › Waitlists (CLONE_SPEC.md §36): per list the totals (confirmed vs pending), the daily growth chart, sources
// (where they joined, UTM, referral codes), the launch target (reason, audited; one alert when reached), the public
// progress-bar toggle (the waitlist.launch.public_count flag), survey results with the moderated free-text list and the
// question editor (CMS type `survey`), the consent CSV export (step-up, audited), the newsletter (template preview,
// test send, send now or scheduled, per-send stats, cancel) and the "We're live with real money" email offered after
// the production switch. The Perps list links to Perps ops, where approve / revoke / invite live as before.
import { t as tx, te } from '../../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../../content/admin.waitlists-strings.js';
import { csrf } from '../../api.js';
import { refreshClientToken } from '../../security.js';
import { toApiDollars, fromApiDollars } from '../../currency.js';
import { vars } from '../../dynstyle.js';
import { esc, get, put, post, toast, dialog, formHtml, wireForm, confirmAction, section, badge, fmtTime, barChart, wireCharts, download, subTabs, AdminError } from './ui.js';

const LISTS = ['real_money_launch', 'perps'];
let seq = 0; // only the latest load draws (tab switches and reloads can overlap)

export async function render(ctx) {
  const list = LISTS.includes(ctx.parts[0]) ? ctx.parts[0] : 'real_money_launch';
  const my = ++seq;
  const { el } = ctx;
  el.innerHTML = `${section(tx('admin.wl.page.title'), te('admin.wl.page.intro'))}${subTabs(LISTS.map((k) => [k, tx(`admin.wl.tab.${k}`)]), list, '/admin/waitlists')}<div id="wl-body" data-testid="wl-${esc(list)}"></div>`;
  const body = el.querySelector('#wl-body');
  const { waitlist: w } = await get(`/waitlists/${list}`);
  if (my !== seq) return;
  if (list === 'perps') return perpsList(body, w);
  return launchList({ ...ctx, el: body, w, reload: () => render(ctx) });
}

function perpsList(el, w) {
  const c = w.counts || {};
  el.innerHTML = `<section class="card adm-card" data-testid="wl-perps"><p>${w.gate_active ? badge(tx('admin.wl.perps.gate_on'), 'warn') : badge(tx('admin.wl.perps.gate_off'))} <span class="faint" data-testid="wl-perps-counts">${te('admin.wl.perps.counts', { waiting: esc(c.waiting || 0), approved: esc(c.approved || 0), revoked: esc(c.revoked || 0) })}</span></p>
    <p class="muted">${te('admin.wl.perps.intro')}</p><a class="btn" href="/admin/perps" data-link data-testid="wl-perps-open">${te('admin.wl.perps.open')}</a></section>`;
}

const n = (x) => Number(x || 0).toLocaleString('en-NG');
function bars(opts, total) {
  return `<ul class="adm-wl-bars">${opts.map((o) => `<li data-testid="wl-survey-option" data-option="${esc(o.id)}" data-count="${esc(o.count)}"><span>${esc(o.label)}</span><span class="num">${esc(n(o.count))}</span><div class="wl-bar"><span class="v-w"${vars({ '--w': `${total ? Math.round((o.count / total) * 100) : 0}%` })}></span></div></li>`).join('')}</ul>`;
}

async function launchList({ el, w, perms, reload }) {
  const c = w.counts;
  const canSettings = perms.has('settings.write'); const canAnnounce = perms.has('announce'); const canSupport = perms.has('users.support'); const canPublish = perms.has('content.publish');
  const targetFields = [{ name: 'target', label: tx('admin.wl.target.field'), type: 'number', value: w.target ?? '', hint: tx('admin.wl.target.hint') }, { name: 'reason', label: tx('admin.wl.target.reason'), required: true, span: true }];
  const nlFields = [{ name: 'send_at', label: tx('admin.wl.nl.send_at'), type: 'datetime' }, { name: 'reason', label: tx('admin.wl.nl.reason'), required: true, span: true }];
  const stat = (k, v) => `<div class="card pay-bal" data-testid="wl-stat-${esc(k)}" data-value="${esc(v)}"><span class="faint">${te(`admin.wl.stats.${k}`)}</span><strong>${esc(n(v))}</strong></div>`;
  const src = (k) => `<div><h4>${te(`admin.wl.sources.${k}`)}</h4><table class="table" data-testid="wl-sources-${esc(k)}"><tbody>${w.sources[k].map((r) => `<tr data-key="${esc(r.key)}"><td>${r.key ? esc(r.key) : te('admin.wl.sources.none')}</td><td class="num">${esc(n(r.count))}</td></tr>`).join('')}</tbody></table></div>`;
  const ta = w.target_alert;
  el.innerHTML = `<div class="pay-balances" data-testid="wl-stats">${stat('total', w.total)}${stat('confirmed', c.confirmed)}${stat('pending', c.pending)}${stat('unsubscribed', c.unsubscribed)}</div>
    <div class="adm-two mt-16"><section class="card adm-card" data-testid="wl-target"><h3>${te('admin.wl.target.title')}</h3>
        ${w.target ? `<p data-testid="wl-target-progress">${te('admin.wl.target.progress', { count: esc(n(c.confirmed)), target: esc(n(w.target)) })} ${w.target_reached ? badge(tx('admin.wl.target.reached'), 'ok') : ''}</p>` : `<p class="faint">${te('admin.wl.target.none')}</p>`}
        ${ta ? `<p class="faint" data-testid="wl-target-alerted">${te('admin.wl.target.alerted', { time: esc(fmtTime(ta.time)), count: esc(n(ta.count)), target: esc(n(ta.target)) })}</p>` : ''}
        ${canSettings ? formHtml(targetFields, { submit: tx('admin.wl.target.save'), id: 'wlt', testid: 'wl-target-form' }) : ''}</section>
      <section class="card adm-card" data-testid="wl-public"><h3>${te('admin.wl.public.title')}</h3><p data-testid="wl-public-state" data-on="${w.public_count ? '1' : '0'}">${w.public_count ? badge(tx('admin.wl.public.on'), 'ok') : badge(tx('admin.wl.public.off'))}</p>
        ${canSettings ? `<button class="btn" type="button" data-testid="wl-public-toggle">${w.public_count ? te('admin.wl.public.hide') : te('admin.wl.public.show')}</button>` : ''}</section></div>
    <section class="card adm-card" data-testid="wl-growth"><h3>${te('admin.wl.growth.title')}</h3>${barChart(w.growth.map((g) => ({ label: g.day, value: g.confirmed })), { label: tx('admin.wl.growth.chart') })}</section>
    <section class="card adm-card" data-testid="wl-sources"><h3>${te('admin.wl.sources.title')}</h3><div class="adm-two">${src('source')}${src('utm_source')}${src('utm_campaign')}${src('ref_code')}</div></section>
    <section class="card adm-card" data-testid="wl-survey"><h3>${te('admin.wl.survey.title')}</h3><p class="faint">${te('admin.wl.survey.intro')}</p>
      ${w.survey_locked_time ? `<p class="adm-wl-note" data-testid="wl-survey-locked">${te('admin.wl.survey.locked', { time: esc(fmtTime(w.survey_locked_time)) })}</p>` : ''}
      ${w.survey.map((q) => `<div class="mt-16" data-testid="wl-survey-q" data-key="${esc(q.key)}"><h4>${esc(q.prompt)} ${q.active ? '' : badge(tx('admin.wl.survey.inactive'), 'warn')} ${canPublish ? `<button class="btn btn-sm btn-ghost" type="button" data-edit-q="${esc(q.key)}">${te('admin.wl.survey.edit')}</button>` : ''}</h4>
        ${q.kind === 'text' ? `<p class="faint" data-testid="wl-survey-text-counts">${te('admin.wl.survey.text_counts', { count: esc(n(q.respondents)), pending: esc(n(q.pending)), approved: esc(n(q.approved)), hidden: esc(n(q.hidden)), flagged: esc(n(q.flagged)) })}</p>` : `<p class="faint">${te('admin.wl.survey.respondents', { count: esc(n(q.respondents)) })}</p>${bars(q.options, q.respondents)}`}</div>`).join('')}
      ${canPublish ? `<button class="btn mt-16" type="button" data-testid="wl-survey-add">${te('admin.wl.survey.add')}</button>` : ''}
      <h4 class="mt-16">${te('admin.wl.comments.title')}</h4><div data-testid="wl-comments"></div></section>
    ${canSupport ? `<section class="card adm-card" data-testid="wl-export"><h3>${te('admin.wl.export.title')}</h3><p class="faint">${te('admin.wl.export.intro')}</p><button class="btn" type="button" data-testid="wl-export-csv">${te('admin.wl.export.button')}</button><p class="adm-err" data-export-err></p></section>` : ''}
    ${canAnnounce ? `<section class="card adm-card" data-testid="wl-newsletter"><h3>${te('admin.wl.nl.title')}</h3><p class="faint">${te('admin.wl.nl.intro', { rate: esc(w.newsletter_per_minute) })}</p>
      ${w.newsletter_flag ? '' : `<p class="adm-wl-note" data-testid="wl-nl-off">${te('admin.wl.nl.off')}</p>`}
      <div class="d-flex gap-8 fw-wrap"><a class="btn btn-sm" href="/admin/cms/templates" data-link>${te('admin.wl.nl.edit_template')}</a><button class="btn btn-sm" type="button" data-testid="wl-nl-preview">${te('admin.wl.nl.preview')}</button><button class="btn btn-sm" type="button" data-testid="wl-nl-test">${te('admin.wl.nl.test')}</button></div>
      <div data-nl-preview></div><p class="faint mt-12" data-testid="wl-nl-recipients">${te('admin.wl.nl.recipients', { count: esc(n(c.confirmed)) })}</p>
      ${formHtml(nlFields, { submit: tx('admin.wl.nl.send'), id: 'wln', testid: 'wl-nl-form' })}
      <h4 class="mt-16">${te('admin.wl.nl.history')}</h4><div data-testid="wl-nl-list"></div>
      <h4 class="mt-16">${te('admin.wl.launch.title')}</h4><div data-testid="wl-launch">${launchHtml(w.launch_email)}</div></section>` : ''}`;
  wireCharts(el);
  const tf = el.querySelector('[data-testid=wl-target-form]');
  if (tf) wireForm(tf, targetFields, async (v) => { await put('/waitlists/real_money_launch/target', { target: v.target === '' ? null : Number(v.target), reason: v.reason }); toast(tx('admin.wl.target.saved')); await reload(); });
  const pt = el.querySelector('[data-testid=wl-public-toggle]');
  if (pt) pt.onclick = async () => {
    const r = await confirmAction({ title: tx('admin.wl.public.reason_title'), confirm: w.public_count ? tx('admin.wl.public.hide') : tx('admin.wl.public.show'), reason: true });
    if (!r) return;
    try { await put('/flags/waitlist.launch.public_count', { enabled: !w.public_count, reason: r.reason }); toast(tx('admin.wl.public.done')); await reload(); } catch (ex) { toast(ex.message, 'error'); }
  };
  await comments(el.querySelector('[data-testid=wl-comments]'), canSupport);
  el.querySelector('[data-testid=wl-survey]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-edit-q]');
    if (b) questionEditor(w.survey.find((q) => q.key === b.dataset.editQ) || { key: b.dataset.editQ }, reload);
    if (e.target.closest('[data-testid=wl-survey-add]')) questionEditor(null, reload);
  });
  const ex = el.querySelector('[data-testid=wl-export-csv]');
  if (ex) ex.onclick = async () => {
    el.querySelector('[data-export-err]').textContent = '';
    try { const text = await getCsv('/waitlists/real_money_launch/export.csv'); download(`parlance-waitlist-real_money_launch.csv`, text); toast(tx('admin.wl.export.done', { count: Math.max(0, text.trim().split(/\r?\n/).length - 1) })); } catch (x) { el.querySelector('[data-export-err]').textContent = x.message; }
  };
  if (canAnnounce) await newsletter(el, reload);
}

function launchHtml(le) {
  if (!le || !le.offered) return `<p class="faint" data-testid="wl-launch-not-yet">${te('admin.wl.launch.not_yet')}</p>`;
  if (le.newsletter) return `<p data-testid="wl-launch-sent" data-status="${esc(le.newsletter.status)}">${te('admin.wl.launch.sent', { status: esc(le.newsletter.status) })}</p>`;
  return `<p data-testid="wl-launch-offer">${te('admin.wl.launch.offer', { count: esc(n(le.recipients)) })}</p><button class="btn btn-primary" type="button" data-testid="wl-launch-send">${te('admin.wl.launch.send')}</button>`;
}
// The launch email offer (also shown on Admin › Play mode after the switch): a reason, a password check, then the outbox.
export async function sendLaunchEmail() {
  const r = await confirmAction({ title: tx('admin.wl.launch.title'), confirm: tx('admin.wl.launch.send'), reason: true });
  if (!r) return false;
  await post('/waitlists/real_money_launch/launch_email', { reason: r.reason });
  toast(tx('admin.wl.launch.queued'));
  return true;
}

async function comments(box, canModerate) {
  const { comments: rows } = await get('/waitlists/real_money_launch/survey/comments');
  box.innerHTML = rows.length ? `<ul class="adm-hist">${rows.map((r) => `<li data-testid="wl-comment" data-id="${esc(r.id)}" data-status="${esc(r.status)}"><div>${esc(r.text)}</div>
      <div class="faint">${esc(tx(`admin.wl.comments.status.${r.status}`))} · ${esc(fmtTime(r.time))}${r.flag ? ` · ${te('admin.wl.comments.flag', { reason: esc(r.flag) })}` : ''}</div>
      ${canModerate ? `<div class="adm-actions"><button class="btn btn-sm" type="button" data-mod="approve" data-testid="wl-comment-approve">${te('admin.wl.comments.approve')}</button><button class="btn btn-sm" type="button" data-mod="hide" data-testid="wl-comment-hide">${te('admin.wl.comments.hide')}</button></div>` : ''}</li>`).join('')}</ul>`
    : `<p class="faint">${te('admin.wl.comments.empty')}</p>`;
  box.onclick = async (e) => {
    const b = e.target.closest('[data-mod]');
    if (!b) return;
    const li = b.closest('[data-id]');
    try { const r = await post(`/waitlists/real_money_launch/survey/comments/${encodeURIComponent(li.dataset.id)}/${b.dataset.mod}`, {}); li.dataset.status = r.status; await comments(box, canModerate); } catch (x) { toast(x.message, 'error'); }
  };
}

// Survey questions are CMS entries (type `survey`): saved as a draft, then published with a reason (versioned, audited).
function questionEditor(q, reload) {
  const kinds = ['single', 'multi', 'naira_band', 'text'];
  const lines = !q ? '' : q.kind === 'naira_band' ? (q.bands || []).map((b) => `${b.id}: ${fromApiDollars(b.min_cents / 100)}-${b.max_cents == null ? '' : fromApiDollars(b.max_cents / 100)}`).join('\n') : (q.options || []).map((o) => `${o.id}: ${o.label}`).join('\n');
  const fields = [
    { name: 'key', label: tx('admin.wl.survey.key'), required: true, value: q ? q.key : 'real_money_launch.' },
    { name: 'kind', label: tx('admin.wl.survey.kind'), type: 'select', value: q ? q.kind : 'single', options: kinds.map((k) => [k, tx(`admin.wl.survey.kind.${k}`)]) },
    { name: 'prompt', label: tx('admin.wl.survey.prompt'), required: true, value: q ? q.prompt : '', span: true },
    { name: 'options', label: tx('admin.wl.survey.options'), type: 'textarea', rows: 6, value: lines, span: true },
    { name: 'max_len', label: tx('admin.wl.survey.max_len'), type: 'number', value: q && q.max_len ? q.max_len : 500 },
    { name: 'sort', label: tx('admin.wl.survey.sort'), type: 'number', value: q && q.sort != null ? q.sort : 100 },
    { name: 'active', label: tx('admin.wl.survey.active'), type: 'checkbox', value: q ? q.active !== false : true },
    { name: 'required', label: tx('admin.wl.survey.required'), type: 'checkbox', value: q ? !!q.required : false },
    { name: 'reason', label: tx('admin.wl.survey.reason'), required: true, span: true },
  ];
  const d = dialog(`<h3>${te('admin.wl.survey.editor_title')}</h3>${formHtml(fields, { submit: tx('admin.wl.survey.publish'), id: 'wlq', testid: 'wl-question-form' })}`, { wide: true, testid: 'wl-question-dialog' });
  wireForm(d.querySelector('form'), fields, async (v) => {
    const pairs = String(v.options || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(':'); return i < 0 ? [l, ''] : [l.slice(0, i).trim(), l.slice(i + 1).trim()]; });
    const value = { kind: v.kind, prompt: v.prompt, sort: Number(v.sort) || 0, active: v.active, required: v.required };
    if (v.kind === 'single' || v.kind === 'multi') value.options = pairs.map(([id, label]) => ({ id, label }));
    if (v.kind === 'naira_band') value.bands = pairs.map(([id, range]) => { const [a, b] = range.split('-').map((x) => x.trim()); return { id, min_cents: Math.round(toApiDollars(a || 0) * 100), max_cents: b ? Math.round(toApiDollars(b) * 100) : null }; });
    if (v.kind === 'text') value.max_len = Number(v.max_len) || 500;
    await put('/cms/survey/draft', { key: v.key, value });
    await post('/cms/survey/publish', { key: v.key, reason: v.reason });
    toast(tx('admin.wl.survey.published'));
    d.close();
    await reload();
  });
}

async function newsletter(el, reload) {
  const sec = el.querySelector('[data-testid=wl-newsletter]');
  const { newsletters } = await get('/waitlists/real_money_launch/newsletters').catch(() => ({ newsletters: [] }));
  const list = sec.querySelector('[data-testid=wl-nl-list]');
  list.innerHTML = newsletters.length ? `<table class="table"><thead><tr><th>${te('admin.wl.nl.col.subject')}</th><th>${te('admin.wl.nl.col.status')}</th><th>${te('admin.wl.nl.col.when')}</th><th>${te('admin.wl.nl.col.stats')}</th><th></th></tr></thead><tbody>${newsletters.map((x) => `<tr data-testid="wl-nl-row" data-id="${esc(x.id)}" data-status="${esc(x.status)}" data-kind="${esc(x.kind)}" data-sent="${esc(x.stats.sent)}" data-skipped-unsubscribed="${esc(x.stats.skipped_unsubscribed)}" data-skipped-unconfirmed="${esc(x.stats.skipped_unconfirmed)}">
      <td>${esc(x.subject)}</td><td>${badge(x.status, x.status === 'sent' ? 'ok' : x.status === 'canceled' ? '' : 'warn')}</td><td>${esc(fmtTime(x.finished_time || x.started_time || x.scheduled_time))}</td>
      <td class="faint">${te('admin.wl.nl.stats', { sent: esc(x.stats.sent), queued: esc(x.stats.queued), skipped_unconfirmed: esc(x.stats.skipped_unconfirmed), skipped_unsubscribed: esc(x.stats.skipped_unsubscribed), failed: esc(x.stats.failed) })}</td>
      <td>${['scheduled', 'sending'].includes(x.status) ? `<button class="btn btn-sm" type="button" data-cancel="${esc(x.id)}">${te('admin.wl.nl.cancel')}</button>` : ''}</td></tr>`).join('')}</tbody></table>` : `<p class="faint">${te('admin.wl.nl.empty')}</p>`;
  list.onclick = async (e) => {
    const b = e.target.closest('[data-cancel]');
    if (!b) return;
    const r = await confirmAction({ title: tx('admin.wl.nl.cancel_title'), confirm: tx('admin.wl.nl.cancel'), reason: true, danger: true });
    if (!r) return;
    try { await post(`/waitlists/real_money_launch/newsletters/${encodeURIComponent(b.dataset.cancel)}/cancel`, { reason: r.reason }); toast(tx('admin.wl.nl.canceled')); await reload(); } catch (x) { toast(x.message, 'error'); }
  };
  sec.querySelector('[data-testid=wl-nl-preview]').onclick = async () => {
    try { const { preview: p } = await post('/waitlists/real_money_launch/newsletters/preview', { kind: 'newsletter' }); sec.querySelector('[data-nl-preview]').innerHTML = `<div class="card adm-card mt-12" data-testid="wl-nl-preview-box"><strong data-testid="wl-nl-preview-subject">${esc(p.subject)}</strong><pre class="adm-pre">${esc(p.text)}</pre></div>`; } catch (x) { toast(x.message, 'error'); }
  };
  sec.querySelector('[data-testid=wl-nl-test]').onclick = async () => {
    try { const r = await post('/waitlists/real_money_launch/newsletters/test', { kind: 'newsletter' }); toast(tx('admin.wl.nl.test_sent', { email: r.to })); } catch (x) { toast(x.message, 'error'); }
  };
  const fields = [{ name: 'send_at', type: 'datetime' }, { name: 'reason', required: true }];
  wireForm(sec.querySelector('[data-testid=wl-nl-form]'), fields, async (v) => {
    await post('/waitlists/real_money_launch/newsletters', { send_at: v.send_at || null, reason: v.reason });
    toast(tx('admin.wl.nl.sent'));
    await reload();
  });
  const ls = sec.querySelector('[data-testid=wl-launch-send]');
  if (ls) ls.onclick = async () => { try { if (await sendLaunchEmail()) await reload(); } catch (x) { toast(x.message, 'error'); } };
}

// The CSV export is not JSON: a raw fetch with the same headers as admin calls, and the step-up dialog when asked.
async function getCsv(path, stepUpDone = false) {
  const headers = { Accept: 'text/csv, application/json' };
  const t = csrf.get(); if (t) headers['x-csrf-token'] = t;
  const ct = await refreshClientToken(); if (ct) headers['X-Client-Token'] = ct;
  const res = await fetch(`/v1/admin${path}`, { headers, credentials: 'same-origin' });
  if (res.ok) return res.text();
  const data = await res.json().catch(() => ({}));
  if (data?.error?.code === 'step_up_required' && !stepUpDone) {
    const { stepUp } = await import('../stepup.js');
    await stepUp({ methods: data.error.methods, action: data.error.action });
    return getCsv(path, true);
  }
  throw new AdminError(res.status, data);
}
