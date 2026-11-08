// Admin › Growth (PLAN P8.1, P8.2, P8.6; CLONE_SPEC.md §38.2, §38.3, §38.7):
//   Referrals    the Predictions program settings (reward amounts in naira, goal, windows, caps; users.money, a reason and
//                a step-up), the fraud review queue (approve pays both sides, reject pays nothing; users.money, a note,
//                step-up to approve), every referral with how it was attributed.
//   Share links  totals, opens and sign-ups per link, revoke (users.support, a reason).
//   SMS          the notification outbox of the SMS channel (simulated provider): counts and the latest messages.
import { t as tx, te } from '../../i18n.js';
import '../../content/admin.growth-strings.js';
import { esc, get, put, post, toast, dialog, formHtml, wireForm, section, badge, fmtTime, fmtMoney, confirmAction } from './ui.js';

const naira = (cents) => fmtMoney((Number(cents) / 100).toFixed(2));
const SETTINGS = [['enabled', 'checkbox'], ['reward_referrer_cents', 'money'], ['reward_referee_cents', 'money'], ['threshold_cents', 'money'], ['expiry_days', 'number'], ['signup_window_days', 'number'], ['lifetime_cap_count', 'number'], ['lifetime_cap_cents', 'money']];

export async function render({ el, perms }) {
  const [ref, links, sms] = await Promise.all([get('/referrals'), get('/share_links'), perms.has('users.support') ? get('/sms/outbox').catch(() => null) : Promise.resolve(null)]);
  const s = ref.settings;
  const reviews = ref.reviews.filter((v) => v.status === 'pending');
  el.innerHTML = `${section(tx('admin.growth.title'), te('admin.growth.intro'))}
    <section class="card panel" data-testid="adm-ref-settings"><h2>${te('admin.growth.ref.title')}</h2>
      <p class="muted" data-testid="adm-ref-offer">${te('admin.growth.ref.offer', { referrer: esc(ref.offer.referrer_reward), referee: esc(ref.offer.referee_reward), threshold: esc(ref.offer.threshold) })}</p>
      <dl class="owner-dl">${SETTINGS.map(([k, type]) => `<div data-testid="adm-ref-setting" data-key="${esc(k)}" data-value="${esc(String(s[k]))}"><dt>${te(`admin.growth.ref.field.${k}`)}</dt><dd><b>${esc(type === 'money' ? naira(s[k]) : type === 'checkbox' ? tx(s[k] ? 'admin.growth.on' : 'admin.growth.off') : String(s[k]))}</b> <span class="faint">${te(`admin.growth.ref.help.${k}`)}</span></dd></div>`).join('')}</dl>
      ${perms.has('users.money') ? `<button class="btn" data-ref-edit data-testid="adm-ref-edit">${te('admin.growth.ref.edit')}</button>` : ''}
      <p class="faint">${te('admin.growth.ref.counts', { pending: esc(ref.counts.pending || 0), rewarded: esc(ref.counts.rewarded || 0), review: esc(ref.counts.review || 0), expired: esc(ref.counts.expired || 0), total: esc(naira(ref.rewards_total_cents)) })}</p></section>
    <section class="card panel" data-testid="adm-ref-reviews"><h2>${te('admin.growth.review.title')}</h2><p class="muted">${te('admin.growth.review.intro', { ip: esc(ref.ip_signups_review) })}</p>
      ${reviews.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>${te('admin.growth.review.col.referrer')}</th><th>${te('admin.growth.review.col.friend')}</th><th>${te('admin.growth.review.col.signals')}</th><th>${te('admin.growth.review.col.when')}</th><th></th></tr></thead><tbody>
      ${reviews.map((v) => `<tr data-testid="adm-ref-review" data-id="${esc(v.id)}"><td>${esc(v.referrer)}</td><td>${esc(v.referee)}</td><td><ul class="plain">${v.signals.map((x) => `<li data-signal="${esc(x.signal)}">${esc(x.detail)}</li>`).join('')}</ul></td><td>${esc(fmtTime(v.created_time))}</td>
        <td>${perms.has('users.money') ? `<div class="adm-actions"><button class="btn btn-sm btn-primary" data-approve="${esc(v.id)}" data-testid="adm-ref-approve">${te('admin.growth.review.approve')}</button><button class="btn btn-sm btn-danger" data-reject="${esc(v.id)}" data-testid="adm-ref-reject">${te('admin.growth.review.reject')}</button></div>` : ''}</td></tr>`).join('')}</tbody></table></div>` : `<p class="faint" data-testid="adm-ref-reviews-empty">${te('admin.growth.review.none')}</p>`}
      ${ref.reviews.filter((v) => v.status !== 'pending').length ? `<details><summary>${te('admin.growth.review.decided')}</summary><ul class="plain">${ref.reviews.filter((v) => v.status !== 'pending').map((v) => `<li data-testid="adm-ref-decided" data-status="${esc(v.status)}">${esc(v.referrer)} → ${esc(v.referee)}: ${badge(v.status, v.status === 'approved' ? 'ok' : 'warn')} ${esc(v.decided_by || '')} <span class="faint">${esc(v.note || '')}</span></li>`).join('')}</ul></details>` : ''}</section>
    <section class="card panel" data-testid="adm-ref-list"><h2>${te('admin.growth.list.title')}</h2><div class="table-wrap"><table class="table"><thead><tr><th>${te('admin.growth.list.referrer')}</th><th>${te('admin.growth.list.friend')}</th><th>${te('admin.growth.list.source')}</th><th>${te('admin.growth.list.status')}</th><th class="num">${te('admin.growth.list.progress')}</th></tr></thead><tbody>
      ${ref.referrals.map((r) => `<tr data-testid="adm-ref-row" data-status="${esc(r.status)}" data-source="${esc(r.source)}"><td>${esc(r.referrer)}</td><td>${esc(r.referee)}</td><td>${esc(r.source)}</td><td>${esc(r.status)}</td><td class="num">${esc(naira(r.progress_cents))} / ${esc(naira(r.threshold_cents))}</td></tr>`).join('') || `<tr><td colspan="5" class="faint">${te('admin.growth.list.none')}</td></tr>`}</tbody></table></div></section>
    <section class="card panel" data-testid="adm-share"><h2>${te('admin.growth.share.title')}</h2><p class="muted" data-testid="adm-share-totals">${te('admin.growth.share.totals', { links: esc(links.totals.n), active: esc(links.totals.active), clicks: esc(links.totals.clicks), signups: esc(links.totals.signups) })}</p>
      <div class="table-wrap"><table class="table"><thead><tr><th>${te('admin.growth.share.col.link')}</th><th>${te('admin.growth.share.col.by')}</th><th class="num">${te('admin.growth.share.col.opens')}</th><th class="num">${te('admin.growth.share.col.signups')}</th><th>${te('admin.growth.share.col.status')}</th><th></th></tr></thead><tbody>
      ${links.links.map((l) => `<tr data-testid="adm-share-row" data-id="${esc(l.id)}" data-status="${esc(l.status)}"><td>${esc(l.title)} <span class="faint">${esc(l.kind)}</span></td><td>${esc(l.user)}</td><td class="num">${esc(l.clicks)}</td><td class="num">${esc(l.signups)}</td><td>${esc(l.status)}</td><td>${l.status === 'active' && perms.has('users.support') ? `<button class="btn btn-sm" data-revoke="${esc(l.id)}" data-testid="adm-share-revoke">${te('admin.growth.share.revoke')}</button>` : ''}</td></tr>`).join('') || `<tr><td colspan="6" class="faint">${te('admin.growth.share.none')}</td></tr>`}</tbody></table></div></section>
    ${sms ? `<section class="card panel" data-testid="adm-sms"><h2>${te('admin.growth.sms.title')}</h2><p class="muted">${te('admin.growth.sms.intro', { provider: esc(sms.provider), state: esc(tx(sms.flag_on ? 'admin.growth.on' : 'admin.growth.off')), cap: esc(sms.per_user_per_day), opted: esc(sms.opted_in) })}</p>
      <p class="faint" data-testid="adm-sms-counts">${esc(Object.entries(sms.counts).map(([k, n]) => `${k}: ${n}`).join(' · ') || tx('admin.growth.sms.none'))}</p></section>` : ''}`;

  el.querySelector('[data-ref-edit]')?.addEventListener('click', () => {
    const fields = SETTINGS.map(([k, type]) => ({ name: k, label: tx(`admin.growth.ref.field.${k}`), type: type === 'checkbox' ? 'checkbox' : 'number', value: s[k], hint: tx(`admin.growth.ref.help.${k}`), ...(type === 'money' ? { step: '1' } : {}) }))
      .concat([{ name: 'reason', label: tx('admin.growth.reason'), required: true, span: true }]);
    const d = dialog(`<h3>${te('admin.growth.ref.edit')}</h3><p class="faint">${te('admin.growth.ref.money_note')}</p>${formHtml(fields, { submit: tx('admin.growth.save'), id: 'refs', testid: 'adm-ref-form' })}`, { wide: true });
    wireForm(d.querySelector('form'), fields, async (v) => {
      const body = { reason: v.reason };
      for (const [k, type] of SETTINGS) body[k] = type === 'checkbox' ? !!v[k] : Number(v[k]);
      await put('/referrals/settings', body);
      toast(tx('admin.growth.saved')); d.close(); render({ el, perms });
    });
  });
  if (el.dataset.growthWired) return;
  el.dataset.growthWired = '1';
  el.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-approve],[data-reject],[data-revoke]');
    if (!a) return;
    try {
      if (a.dataset.revoke) {
        const r = await confirmAction({ title: tx('admin.growth.share.revoke'), confirm: tx('admin.growth.share.revoke'), danger: true, reason: true });
        if (r) { await post(`/share_links/${encodeURIComponent(a.dataset.revoke)}/revoke`, { reason: r.reason }); toast(tx('admin.growth.saved')); render({ el, perms }); }
        return;
      }
      const approve = !!a.dataset.approve;
      const r = await confirmAction({ title: tx(approve ? 'admin.growth.review.approve_title' : 'admin.growth.review.reject_title'), body: te(approve ? 'admin.growth.review.approve_body' : 'admin.growth.review.reject_body'), confirm: tx(approve ? 'admin.growth.review.approve' : 'admin.growth.review.reject'), danger: !approve, reason: true });
      if (!r) return;
      await post(`/referrals/reviews/${encodeURIComponent(a.dataset.approve || a.dataset.reject)}/${approve ? 'approve' : 'reject'}`, { note: r.reason });
      toast(tx('admin.growth.saved')); render({ el, perms });
    } catch (ex) { toast(ex.message, 'error'); }
  });
}
