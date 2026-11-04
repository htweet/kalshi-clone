// Payment-method forms shared by the transfer flows (views/funds.js) and Account › Payment methods
// (views/account-payments.js). Parlance design (CLONE_SPEC.md §26.10): the original deposit / withdraw screens were not
// observed. The card number and security code go only to the isolated tokenizer and are cleared from the form at once.
import { payApi } from '../payments-api.js';
import { session } from '../store.js';
import { esc, fmtDateTime } from '../lib.js';

// Sandbox test cards (invented, Luhn-valid; clone/README.md). The numbers come from the server, signed in and only while
// the sandbox rails are on, so none ship in public JavaScript. What each behaviour means is keyed copy (CMS-ready).
export const CARD_HINT_TEXT = { approve: 'approves', decline: 'is declined', insufficient_funds: 'has insufficient funds', challenge: 'asks for a verification step' };

export const methodLabel = (m) => (m.type === 'card' ? `${m.brand === 'mastercard' ? 'Mastercard' : 'Visa'} •••• ${m.last4}` : m.type === 'bank' ? `${m.institution} •••• ${m.mask}` : `${m.label} · ${m.address_masked}`);
export const methodSub = (m) => (m.type === 'card' ? `Expires ${String(m.exp_month).padStart(2, '0')}/${String(m.exp_year).slice(-2)}` : m.type === 'bank' ? `${m.label} · ${m.subtype}` : m.cooling ? `New address: withdrawals open ${fmtDateTime(m.cooling_until)}` : 'Sandbox chain');

// Card entry → {token, card}. onToken receives the token; the number never leaves this function except to the tokenizer.
export function cardForm(host, { onToken, submitLabel = 'Use this card' }) {
  host.innerHTML = `<form class="pay-form" data-testid="card-form" autocomplete="on" novalidate>
    <label class="field">Card number<input name="number" inputmode="numeric" autocomplete="cc-number" maxlength="23" placeholder="0000 0000 0000 0000" data-testid="card-number" required></label>
    <div class="pay-row"><label class="field">Month<input name="exp_month" inputmode="numeric" autocomplete="cc-exp-month" maxlength="2" placeholder="MM" data-testid="card-exp-month" required></label>
      <label class="field">Year<input name="exp_year" inputmode="numeric" autocomplete="cc-exp-year" maxlength="4" placeholder="YY" data-testid="card-exp-year" required></label>
      <label class="field">Security code<input name="cvc" inputmode="numeric" autocomplete="cc-csc" maxlength="4" placeholder="123" data-testid="card-cvc" required></label></div>
    <details class="pay-hint" data-testid="test-card-hints" hidden><summary>Sandbox test cards</summary><ul></ul><p class="faint">Any future expiry date and any 3 digits. Other numbers are refused; never enter a real card.</p></details>
    <div class="form-error" role="alert" data-testid="card-error"></div>
    <button class="btn btn-primary" type="submit" data-testid="card-submit">${esc(submitLabel)}</button></form>`;
  const f = host.querySelector('form');
  const hints = f.querySelector('[data-testid=test-card-hints]');
  payApi.testCards(session.uid).then((r) => {
    hints.querySelector('ul').innerHTML = r.test_cards.map((c) => `<li><span class="code">${esc(c.number)}</span> ${esc(CARD_HINT_TEXT[c.behavior] || c.behavior)}</li>`).join('');
    hints.hidden = false;
  }).catch(() => {}); // no sandbox (production): no hint
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = f.querySelector('[data-testid=card-error]');
    err.textContent = '';
    const btn = f.querySelector('[type=submit]'); btn.disabled = true;
    const input = { number: f.number.value.replace(/\D/g, ''), exp_month: Number(f.exp_month.value), exp_year: Number(f.exp_year.value), cvc: f.cvc.value.trim() };
    f.number.value = ''; f.cvc.value = ''; // the form never keeps the number or code
    try {
      const s = await payApi.paymentSession(session.uid);
      const t = await payApi.tokenize({ session_id: s.session_id, ...input });
      input.number = ''; input.cvc = '';
      await onToken(t);
    } catch (ex) { err.textContent = ex.message; } finally { input.number = ''; input.cvc = ''; btn.disabled = false; }
  };
}

// Bank link: sandbox institution sign-in → choose an account → linked (a new payout destination: step-up).
export function bankLinkForm(host, { institutions, onLinked }) {
  host.innerHTML = `<form class="pay-form" data-testid="bank-form" novalidate>
    <label class="field">Bank<select name="institution_id" data-testid="bank-institution">${institutions.map((i) => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join('')}</select></label>
    <div class="pay-row"><label class="field">Online banking username<input name="username" autocomplete="off" data-testid="bank-username" required></label>
      <label class="field">Password<input name="password" type="password" autocomplete="off" data-testid="bank-password" required></label></div>
    <p class="faint">Sandbox banks only. Sign in with <span class="code">sandbox</span> / <span class="code">sandbox-pass</span>; Parlance never stores these.</p>
    <div class="form-error" role="alert" data-testid="bank-error"></div>
    <button class="btn btn-primary" type="submit" data-testid="bank-login">Continue</button></form><div data-accounts></div>`;
  const f = host.querySelector('form');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = f.querySelector('[data-testid=bank-error]'); err.textContent = '';
    try {
      const r = await payApi.bankLogin(session.uid, { institution_id: f.institution_id.value, username: f.username.value, password: f.password.value });
      f.password.value = '';
      const box = host.querySelector('[data-accounts]');
      box.innerHTML = `<form class="pay-form" data-testid="bank-accounts"><p class="muted">Choose the account to link at ${esc(r.institution.name)}:</p>
        ${r.accounts.map((a, i) => `<label class="pay-choice"><input type="radio" name="account" value="${esc(a.account_id)}" ${i === 0 ? 'checked' : ''} data-testid="bank-account" data-mask="${esc(a.mask)}"><span><strong>${esc(a.name)} •••• ${esc(a.mask)}</strong><span class="faint">${esc(a.hint)}</span></span></label>`).join('')}
        <div class="form-error" role="alert"></div><button class="btn btn-primary" type="submit" data-testid="bank-link">Link account</button></form>`;
      f.hidden = true;
      const af = box.querySelector('form');
      af.onsubmit = async (ev) => {
        ev.preventDefault();
        try { const out = await payApi.linkBank(session.uid, { link_id: r.link_id, account_id: af.account.value }); await onLinked(out.account); } catch (ex) { if (ex.code !== 'step_up_cancelled') af.querySelector('.form-error').textContent = ex.message; }
      };
    } catch (ex) { err.textContent = ex.message; }
  };
}

// Crypto withdrawal address (a new payout destination: step-up, then a cooling period).
export function walletForm(host, { onAdded, example }) {
  host.innerHTML = `<form class="pay-form" data-testid="wallet-form" novalidate>
    <label class="field">Address (sandbox chain)<input name="address" autocomplete="off" spellcheck="false" maxlength="80" placeholder="tpx1…" data-testid="wallet-address" required></label>
    <label class="field">Name (optional)<input name="label" maxlength="40" placeholder="My wallet" data-testid="wallet-label"></label>
    ${example ? `<p class="faint">Sandbox example: <span class="code pay-break">${esc(example)}</span></p>` : ''}
    <p class="faint">For your security, withdrawals to a new address open after a cooling period, and the first one is reviewed.</p>
    <div class="form-error" role="alert" data-testid="wallet-error"></div><button class="btn btn-primary" type="submit" data-testid="wallet-add">Save address</button></form>`;
  const f = host.querySelector('form');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = f.querySelector('[data-testid=wallet-error]'); err.textContent = '';
    try { const r = await payApi.addWallet(session.uid, { address: f.address.value.trim(), label: f.label.value.trim() || undefined }); await onAdded(r.wallet); } catch (ex) { if (ex.code !== 'step_up_cancelled') err.textContent = ex.message; }
  };
}
