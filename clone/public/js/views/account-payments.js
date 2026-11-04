// Account › Account & security › Payment methods (CLONE_SPEC.md §26.10, Parlance design): saved debit cards, linked bank
// accounts, crypto withdrawal addresses and the crypto deposit address; add or remove each. Adding a bank account or a
// crypto address is a new payout destination: it asks for step-up (or the withdrawal two-factor code when that is on).
import { t, te } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/account-payments-strings.js';
import { payApi } from '../payments-api.js';
import { session } from '../store.js';
import { esc, toast } from '../lib.js';
import { bankLinkForm, walletForm, methodLabel, methodSub } from './payment-forms.js';

export async function render(panel) {
  const [meta, { cards }, { accounts }, { wallets }, { account }, nets] = await Promise.all([payApi.metadata(session.uid), payApi.cards(session.uid), payApi.banks(session.uid), payApi.wallets(session.uid), payApi.cryptoAccount(session.uid), payApi.networks()]);
  const row = (m, del) => `<li class="pay-saved" data-testid="saved-method" data-type="${esc(m.type)}" data-id="${esc(m.id)}"><span><strong>${esc(methodLabel(m))}</strong><span class="faint">${esc(methodSub(m))}</span></span>
    ${m.cooling ? `<span class="pay-badge warn" data-testid="cooling">${te('account-payments.render.cooling_period')}</span>` : ''}<button class="btn btn-sm btn-ghost" data-del="${esc(del)}" data-id="${esc(m.id)}" data-testid="remove-method">${te('account-payments.render.remove')}</button></li>`;
  const list = (items, del, empty) => (items.length ? `<ul class="pay-list">${items.map((m) => row(m, del)).join('')}</ul>` : `<p class="faint">${esc(empty)}</p>`);
  panel.innerHTML = `<div data-testid="payment-methods"><p class="faint">${te('account-payments.render.sandbox_payment_methods_only_test')} <a href="/funds" data-link>${te('account-payments.render.transfers')}</a></p>
    <section class="card panel" data-testid="pm-cards"><div class="acct-row"><h2>${te('account-payments.render.debit_cards')}</h2><button class="btn btn-sm" data-add="card" data-testid="add-card">${te('account-payments.render.add_card')}</button></div>
      <p class="faint">${te('account-payments.render.we_keep_only_a_token')}</p>${list(cards, 'card', t('account-payments.render.no_saved_cards'))}<div data-form="card"></div></section>
    <section class="card panel" data-testid="pm-banks"><div class="acct-row"><h2>${te('account-payments.render.bank_accounts')}</h2><button class="btn btn-sm" data-add="bank" data-testid="add-bank">${te('account-payments.render.link_bank')}</button></div>
      <p class="faint">${te('account-payments.render.we_keep_only_the_account')}</p>${list(accounts, 'bank', t('account-payments.render.no_linked_bank_accounts'))}<div data-form="bank"></div></section>
    <section class="card panel" data-testid="pm-crypto"><div class="acct-row"><h2>${te('account-payments.render.crypto')}</h2><button class="btn btn-sm" data-add="wallet" data-testid="add-wallet">${te('account-payments.render.add_address')}</button></div>
      <p class="muted">${te('account-payments.render.deposit_address', { value: account.enabled ? `<span class="code pay-break" data-testid="pm-deposit-address">${esc(account.address)}</span>` : `<a href="/funds/deposit" data-link>${te('account-payments.render.open_one_under_deposit_crypto')}</a>` })}</p>
      <h3 class="typ-body-x10">${te('account-payments.render.withdrawal_addresses')}</h3>${list(wallets, 'wallet', t('account-payments.render.no_saved_addresses'))}<div data-form="wallet"></div></section></div>`;
  const reload = () => render(panel);
  for (const b of panel.querySelectorAll('[data-add]')) {
    b.onclick = () => {
      const host = panel.querySelector(`[data-form="${b.dataset.add}"]`);
      // A card is saved with its first deposit (POST debit/payment, as on the observed API: cards are listed and removed,
      // never created on their own), so "Add card" opens the deposit flow.
      if (b.dataset.add === 'card') host.innerHTML = `<p class="muted" data-testid="card-add-note">${te('account-payments.render.cards_are_saved_when_you')}</p><a class="btn btn-primary" href="/funds/deposit" data-link>${te('account-payments.render.deposit_with_a_card')}</a>`;
      else if (b.dataset.add === 'bank') bankLinkForm(host, { institutions: meta.institutions, onLinked: async () => { toast(t('account-payments.render.bank_account_linked')); await reload(); } });
      else walletForm(host, { example: nets.networks[0]?.example, onAdded: async () => { toast(t('account-payments.render.address_saved')); await reload(); } });
    };
  }
  for (const b of panel.querySelectorAll('[data-del]')) {
    b.onclick = async () => {
      if (!confirm(t('account-payments.render.remove_this_payment_method'))) return;
      const id = b.dataset.id;
      try {
        if (b.dataset.del === 'card') await payApi.removeCard(session.uid, id);
        else if (b.dataset.del === 'bank') await payApi.removeBank(session.uid, id);
        else await payApi.removeWallet(session.uid, id);
        toast(t('account-payments.render.removed'));
        await reload();
      } catch (ex) { toast(ex.message, 'error'); }
    };
  }
}
