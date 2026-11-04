// Rewards (CLONE_SPEC §13.19; PLAN A12, CLONE_SPEC.md §25.10): the new-user checklist (4 steps tied to identity
// verification, the first deposit, the first trade and the profile), promo-code entry and the codes you used.
// Referrals and promotions with progress are Phase 8 (P8.1) and say so.
import { t, te } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/rewards-strings.js';
import { session } from '../store.js';
import { idApi } from '../identity-api.js';
import { esc, money, relTime } from '../lib.js';
import { promoDialog } from './account-menu.js';

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
    <section class="card panel"><h2>${te('rewards.render.referrals')}</h2><p class="muted">${te('rewards.render.referral_offers_and_promotions_with')}</p></section>`;
  el.querySelector('[data-promo]').onclick = () => { promoDialog(); };
}
