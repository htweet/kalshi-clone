// Rewards (CLONE_SPEC §13.19; PLAN A12, CLONE_SPEC.md §25.10): the new-user checklist (4 steps tied to identity
// verification, the first deposit, the first trade and the profile), promo-code entry and the codes you used.
// Refer a friend (Phase 8 P8.1, CLONE_SPEC.md §38.2): the Predictions referral code and link (shared WhatsApp first), the
// offer in naira, progress, lifetime cap, the referrals and rewards, adding a friend's code; and "Your share links" (§38.3).
import { t, te } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/rewards-strings.js';
import { session } from '../store.js';
import { idApi } from '../identity-api.js';
import { esc, money, relTime } from '../lib.js';
import { promoDialog } from './account-menu.js';
import { request } from '../api.js';
import { flagOn } from '../flags.js';
import { tp } from '../locale.js';
import { shareDialog, shareLinksHtml, wireShareLinks } from './share.js';
import { vars } from '../dynstyle.js';

export async function render({ el, navigate }) {
  if (!session.user) { navigate('/sign-in?next=/rewards', { replace: true }); return; }
  document.title = t('rewards.render.rewards_parlance');
  const [c, r] = await Promise.all([idApi.checklist(), idApi.promoRedemptions(session.uid)]);
  el.innerHTML = `<div class="page-head"><h1 class="page-title">${te('rewards.render.rewards')}</h1></div>
    <section class="card panel" data-testid="checklist"><h2>${te('rewards.render.get_started')}</h2><p class="muted"><span data-testid="checklist-progress">${te('rewards.render.of', { completed: esc(c.completed), value: esc(c.steps.length) })}</span> ${te('rewards.render.done')}</p>
      <ol class="checklist">${c.steps.map((s) => `<li class="${s.status === 'completed' ? 'done' : ''}" data-step="${esc(s.step)}" data-status="${esc(s.status)}"><span class="check" aria-hidden="true">${s.status === 'completed' ? '✓' : ''}</span>
        <span class="grow">${esc(s.title)}</span>${s.status === 'completed' ? `<span class="faint">${te('rewards.render.done_2')}</span>` : `<a class="btn btn-sm" href="${esc(s.link)}" data-link>${te('rewards.render.start')}</a>`}</li>`).join('')}</ol></section>
    <section class="card panel" data-testid="promo-panel"><h2>${te('rewards.render.promo_codes')}</h2><p class="muted">${te('rewards.render.have_a_code_it_adds')}</p>
      <button class="btn btn-primary" data-promo data-testid="rewards-promo">${te('rewards.render.enter_promo_code')}</button>
      <table class="table mt-12"><thead><tr><th>${te('rewards.render.code')}</th><th class="num">${te('rewards.render.credit')}</th><th>${te('rewards.render.used')}</th></tr></thead><tbody>
      ${r.redemptions.map((x) => `<tr data-testid="promo-redemption"><td>${esc(x.code)}</td><td class="num">${esc(money(x.amount_dollars))}</td><td>${esc(relTime(x.redeemed_time))}</td></tr>`).join('') || `<tr><td colspan="3" class="faint">${te('rewards.render.no_codes_used_yet')}</td></tr>`}</tbody></table></section>
    <div data-referrals></div><div data-share-links></div>`;
  el.querySelector('[data-promo]').onclick = () => { promoDialog(); };
  const refBox = el.querySelector('[data-referrals]'); const linksBox = el.querySelector('[data-share-links]');
  const drawRefs = async () => {
    if (!flagOn('referrals.predictions')) { refBox.innerHTML = ''; return; }
    let r;
    try { r = (await request('GET', '/v1/referrals')).referrals; } catch { refBox.innerHTML = ''; return; }
    refBox.innerHTML = referralsHtml(r);
    refBox.querySelector('[data-invite]').onclick = () => { shareDialog({ kind: 'invite', url: `${location.origin}${r.link_path}`, title: t('rewards.ref.share_title'), text: t('rewards.ref.share_text', { amount: r.offer.referee_reward }) }).catch((e) => toast(e.message, 'error')); };
    const f = refBox.querySelector('[data-apply]');
    if (f) f.onsubmit = async (e) => {
      e.preventDefault();
      const err = f.querySelector('[data-testid=referral-apply-error]'); err.textContent = '';
      try { await request('POST', '/v1/referrals/apply', { code: f.elements.code.value }); toast(t('rewards.ref.applied')); drawRefs(); } catch (ex) { err.textContent = ex.message; }
    };
  };
  const drawLinks = async () => {
    let html = '';
    try { html = await shareLinksHtml(); } catch { html = ''; }
    // eslint-disable-next-line parlance/no-unescaped-html -- shareLinksHtml() builds its markup from te() / esc() templates this rule checks in views/share.js
    linksBox.innerHTML = html;
  };
  wireShareLinks(linksBox, drawLinks);
  await Promise.all([drawRefs(), drawLinks()]);
}

function referralsHtml(r) {
  const pctOf = (a, b) => (Number(b) > 0 ? Math.min(100, Math.round((Number(a) / Number(b)) * 100)) : 0);
  const by = r.referred_by;
  const progress = by ? `<div class="ref-progress" data-testid="referral-progress" data-status="${esc(by.status)}"><div>${te('rewards.ref.your_goal', { traded: esc(money(by.progress_dollars)), goal: esc(money(by.threshold_dollars)), bonus: esc(money(by.bonus_dollars)) })}</div>
      <div class="ref-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pctOf(by.progress_dollars, by.threshold_dollars)}" aria-label="${te('rewards.ref.progress_label')}"><span class="v-w"${vars({ '--w': `${pctOf(by.progress_dollars, by.threshold_dollars)}%` })}></span></div>
      <div class="faint">${te(`rewards.ref.status.${by.status}`)}</div></div>` : '';
  const cap = r.lifetime_cap.number_of_referrals ? `<span class="faint" data-testid="referral-cap">${te('rewards.ref.cap', { n: esc(r.total_credited_referrals), max: esc(r.lifetime_cap.number_of_referrals) })}</span>` : '';
  const rows = r.referrals.map((x) => `<tr data-testid="referral-row" data-status="${esc(x.status)}"><td>${esc(relTime(x.created_time))}</td><td>${te(`rewards.ref.status.${x.status}`)}</td><td class="num">${esc(money(x.progress_dollars))} / ${esc(money(x.threshold_dollars))}</td></tr>`).join('');
  return `<section class="card panel" data-testid="referrals" data-flag="referrals.predictions"><h2>${te('rewards.ref.title')}</h2>
    <p class="muted" data-testid="referral-offer">${te('rewards.ref.offer', { referrer: esc(r.offer.referrer_reward), referee: esc(r.offer.referee_reward), threshold: esc(r.offer.threshold), days: esc(r.offer.expiry_days) })}</p>
    <div class="ref-code"><span>${te('rewards.ref.your_code')}</span> <b class="num" data-testid="referral-code">${esc(r.referral_code)}</b> <button class="btn btn-primary" data-invite data-testid="referral-invite">${te('rewards.ref.invite')}</button></div>
    <div class="ref-stats"><span data-testid="referral-earned">${te('rewards.ref.earned', { amount: esc(money(r.total_earned_dollars)) })}</span>
      <span data-testid="referral-counts">${esc(tp('rewards.ref.friends', r.completed_count))} · ${esc(tp('rewards.ref.pending', r.pending_count))}${r.review_count ? ` · ${esc(tp('rewards.ref.review', r.review_count))}` : ''}</span>${cap}</div>
    ${progress}
    ${r.can_apply ? `<form class="inline-form" data-apply data-testid="referral-apply"><label class="field"><span>${te('rewards.ref.have_code')}</span><input name="code" maxlength="16" autocomplete="off" required data-testid="referral-apply-code"></label><button class="btn" type="submit">${te('rewards.ref.apply')}</button><div class="form-error" role="alert" data-testid="referral-apply-error"></div></form>` : ''}
    ${rows ? `<div class="table-wrap"><table class="table" data-testid="referral-table"><thead><tr><th>${te('rewards.ref.col_when')}</th><th>${te('rewards.ref.col_status')}</th><th class="num">${te('rewards.ref.col_progress')}</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
  </section>`;
}
