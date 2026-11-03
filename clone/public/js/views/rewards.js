// Rewards (CLONE_SPEC §13.19; PLAN A12, PHASE3_SPEC.md §25.10): the new-user checklist (4 steps tied to identity
// verification, the first deposit, the first trade and the profile), promo-code entry and the codes you used.
// Referrals and promotions with progress are Phase 8 (P8.1) and say so.
import { session } from '../store.js';
import { idApi } from '../identity-api.js';
import { esc, money, relTime } from '../lib.js';
import { promoDialog } from './account-menu.js';

export async function render({ el, navigate }) {
  if (!session.user) { navigate('/sign-in?next=/rewards', { replace: true }); return; }
  document.title = 'Rewards · Parlance';
  const [c, r] = await Promise.all([idApi.checklist(), idApi.promoRedemptions(session.uid)]);
  el.innerHTML = `<div class="page-head"><h1 class="typ-title-x10">Rewards</h1></div>
    <section class="card panel" data-testid="checklist"><h2>Get started</h2><p class="muted"><span data-testid="checklist-progress">${esc(c.completed)} of ${esc(c.steps.length)}</span> done</p>
      <ol class="checklist">${c.steps.map((s) => `<li class="${s.status === 'completed' ? 'done' : ''}" data-step="${esc(s.step)}" data-status="${esc(s.status)}"><span class="check" aria-hidden="true">${s.status === 'completed' ? '✓' : ''}</span>
        <span class="grow">${esc(s.title)}</span>${s.status === 'completed' ? '<span class="faint">Done</span>' : `<a class="btn btn-sm" href="${esc(s.link)}" data-link>Start</a>`}</li>`).join('')}</ol></section>
    <section class="card panel" data-testid="promo-panel"><h2>Promo codes</h2><p class="muted">Have a code? It adds a credit to your cash balance once.</p>
      <button class="btn btn-primary" data-promo data-testid="rewards-promo">Enter promo code</button>
      <table class="table mt-12"><thead><tr><th>Code</th><th class="num">Credit</th><th>Used</th></tr></thead><tbody>
      ${r.redemptions.map((x) => `<tr data-testid="promo-redemption"><td>${esc(x.code)}</td><td class="num">${esc(money(x.amount_dollars))}</td><td>${esc(relTime(x.redeemed_time))}</td></tr>`).join('') || '<tr><td colspan="3" class="faint">No codes used yet.</td></tr>'}</tbody></table></section>
    <section class="card panel"><h2>Referrals</h2><p class="muted">Referral offers and promotions with progress arrive in Phase 8 (PLAN P8.1).</p></section>`;
  el.querySelector('[data-promo]').onclick = () => { promoDialog(); };
}
