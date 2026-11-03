// Account › Account & security › Payment methods (CLONE_SPEC.md §26.10, Parlance design): saved debit cards, linked bank
// accounts, crypto withdrawal addresses and the crypto deposit address; add or remove each. Adding a bank account or a
// crypto address is a new payout destination: it asks for step-up (or the withdrawal two-factor code when that is on).
import { payApi } from '../payments-api.js';
import { session } from '../store.js';
import { esc, toast } from '../lib.js';
import { bankLinkForm, walletForm, methodLabel, methodSub } from './payment-forms.js';

export async function render(panel) {
  const [meta, { cards }, { accounts }, { wallets }, { account }, nets] = await Promise.all([payApi.metadata(session.uid), payApi.cards(session.uid), payApi.banks(session.uid), payApi.wallets(session.uid), payApi.cryptoAccount(session.uid), payApi.networks()]);
  const row = (m, del) => `<li class="pay-saved" data-testid="saved-method" data-type="${esc(m.type)}" data-id="${esc(m.id)}"><span><strong>${esc(methodLabel(m))}</strong><span class="faint">${esc(methodSub(m))}</span></span>
    ${m.cooling ? '<span class="pay-badge warn" data-testid="cooling">Cooling period</span>' : ''}<button class="btn btn-sm btn-ghost" data-del="${esc(del)}" data-id="${esc(m.id)}" data-testid="remove-method">Remove</button></li>`;
  const list = (items, del, empty) => (items.length ? `<ul class="pay-list">${items.map((m) => row(m, del)).join('')}</ul>` : `<p class="faint">${esc(empty)}</p>`);
  panel.innerHTML = `<div data-testid="payment-methods"><p class="faint">Sandbox payment methods only: test cards, test banks and a test chain. <a href="/funds" data-link>Transfers</a></p>
    <section class="card panel" data-testid="pm-cards"><div class="acct-row"><h2>Debit cards</h2><button class="btn btn-sm" data-add="card" data-testid="add-card">Add card</button></div>
      <p class="faint">We keep only a token, the card brand, the last 4 digits and the expiry date.</p>${list(cards, 'card', 'No saved cards.')}<div data-form="card"></div></section>
    <section class="card panel" data-testid="pm-banks"><div class="acct-row"><h2>Bank accounts</h2><button class="btn btn-sm" data-add="bank" data-testid="add-bank">Link bank</button></div>
      <p class="faint">We keep only the account's last 4 digits and a token from the bank.</p>${list(accounts, 'bank', 'No linked bank accounts.')}<div data-form="bank"></div></section>
    <section class="card panel" data-testid="pm-crypto"><div class="acct-row"><h2>Crypto</h2><button class="btn btn-sm" data-add="wallet" data-testid="add-wallet">Add address</button></div>
      <p class="muted">Deposit address: ${account.enabled ? `<span class="code pay-break" data-testid="pm-deposit-address">${esc(account.address)}</span>` : '<a href="/funds/deposit" data-link>open one under Deposit › Crypto</a>'}</p>
      <h3 class="typ-body-x10">Withdrawal addresses</h3>${list(wallets, 'wallet', 'No saved addresses.')}<div data-form="wallet"></div></section></div>`;
  const reload = () => render(panel);
  for (const b of panel.querySelectorAll('[data-add]')) {
    b.onclick = () => {
      const host = panel.querySelector(`[data-form="${b.dataset.add}"]`);
      // A card is saved with its first deposit (POST debit/payment, as on the observed API: cards are listed and removed,
      // never created on their own), so "Add card" opens the deposit flow.
      if (b.dataset.add === 'card') host.innerHTML = '<p class="muted" data-testid="card-add-note">Cards are saved when you first deposit with them.</p><a class="btn btn-primary" href="/funds/deposit" data-link>Deposit with a card</a>';
      else if (b.dataset.add === 'bank') bankLinkForm(host, { institutions: meta.institutions, onLinked: async () => { toast('Bank account linked'); await reload(); } });
      else walletForm(host, { example: nets.networks[0]?.example, onAdded: async () => { toast('Address saved'); await reload(); } });
    };
  }
  for (const b of panel.querySelectorAll('[data-del]')) {
    b.onclick = async () => {
      if (!confirm('Remove this payment method?')) return;
      const id = b.dataset.id;
      try {
        if (b.dataset.del === 'card') await payApi.removeCard(session.uid, id);
        else if (b.dataset.del === 'bank') await payApi.removeBank(session.uid, id);
        else await payApi.removeWallet(session.uid, id);
        toast('Removed');
        await reload();
      } catch (ex) { toast(ex.message, 'error'); }
    };
  }
}
