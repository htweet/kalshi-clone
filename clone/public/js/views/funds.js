// Deposit / Withdraw (CLONE_SPEC.md §26.10). Parlance design: the original screens were not observed (the live site
// serves a bot checkpoint to automated browsers); the API surface they use is the observed one (§26.1).
//   /funds            balances (cash, non-withdrawable credits, settling, withdrawable, owed), recent transfers, credits
//   /funds/deposit    method → amount → review → status (cards incl. a sandbox verification step, banks, crypto address)
//   /funds/withdraw   method → amount → review → status (banks, cards you deposited with, crypto addresses)
// Status updates arrive over the private `payments` WebSocket channel (and a short poll as a fallback); the balance in the
// header updates over `user_balance`.
import { t as tx, te } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/funds-strings.js';
import { t as T } from '../content/currency-strings.js'; // keyed wording (CLONE_SPEC.md §30)
import { api, request } from '../api.js';
import { payApi } from '../payments-api.js';
import { session } from '../store.js';
import { socket } from '../ws.js';
import { esc, money, toast, relTime, currency, moneyStep, moneyMin, toApiDollars, validMoneyInput, moneyInputHint, fmtDate } from '../lib.js';
import { cardForm, bankLinkForm, walletForm, methodLabel, methodSub } from './payment-forms.js';
import { flagOn, playOn, playLabel, flagState, waitlistCta } from '../flags.js'; // feature flags, play mode, money controls (CLONE_SPEC.md §33)

const STATUS_KIND = { succeeded: 'ok', settled: 'ok', paid: 'ok', pending: 'info', processing: 'info', confirming: 'info', requires_action: 'warn', held: 'warn', failed: 'bad', returned: 'bad', reversed: 'bad' };
const badge = (t) => `<span class="pay-badge ${esc(STATUS_KIND[t.status] || '')}" data-testid="pay-status-badge">${esc(t.status_label)}</span>`;

export async function render({ el, params, navigate }) {
  if (!session.user) { navigate('/sign-in?next=' + encodeURIComponent(location.pathname), { replace: true }); return; }
  const mode = params.mode || 'overview';
  document.title = tx('funds.render.parlance', { value: mode === 'deposit' ? tx('funds.render.deposit') : mode === 'withdraw' ? tx('funds.render.withdraw') : tx('funds.render.transfers') });
  el.innerHTML = `<div class="pay" data-testid="funds" data-mode="${esc(mode)}"><div class="page-head pay-head"><h1 class="typ-title-x10">${mode === 'deposit' ? te('funds.render.deposit') : mode === 'withdraw' ? te('funds.render.withdraw') : te('funds.render.transfers')}</h1>
    <nav class="seg" aria-label="${te('funds.render.transfers')}"><a class="${mode === 'overview' ? 'on' : ''}" href="/funds" data-link>${te('funds.render.overview')}</a><a class="${mode === 'deposit' ? 'on' : ''}" href="/funds/deposit" data-link data-testid="nav-deposit">${te('funds.render.deposit')}</a><a class="${mode === 'withdraw' ? 'on' : ''}" href="/funds/withdraw" data-link data-testid="nav-withdraw">${te('funds.render.withdraw')}</a></nav></div>
    <p class="faint pay-sandbox" data-testid="sandbox-note">${playOn() ? te('funds.render.play_note') : te('funds.render.sandbox_test_cards_test_banks')}</p><div data-body></div></div>`;
  const body = el.querySelector('[data-body]');
  const unsubs = [];
  const onPayment = (fn) => unsubs.push(socket.subscribe({ channels: ['payments'] }, (m) => { if (m.type === 'payment') fn(m.msg); }));
  if (mode === 'challenge') await challengePage(body, params.id, navigate);
  else if (mode === 'deposit') await depositFlow(body, onPayment);
  else if (mode === 'withdraw') await withdrawFlow(body, onPayment);
  else await overview(body, onPayment);
  return () => unsubs.forEach((f) => f());
}

// ------------------------------------------------------------------ balances + overview
function balancesHtml(b, credits) {
  const exp = credits && credits.predictions.credits.length ? (' ' + te('funds.balances_html.expires_in_days', { expiry_days: esc(credits.predictions.expiry_days) })) : '';
  return `<div class="pay-balances" data-testid="balances">
    <div class="card pay-bal"><span class="faint">${te('funds.balances_html.cash_balance')}</span><strong data-testid="bal-total">${esc(money(b.balance_dollars))}</strong></div>
    <div class="card pay-bal"><span class="faint">${te('funds.balances_html.withdrawable')}</span><strong data-testid="bal-withdrawable">${esc(money(b.withdrawable_dollars))}</strong></div>
    <div class="card pay-bal"><span class="faint">${te('funds.balances_html.non_withdrawable_credits')}</span><strong data-testid="bal-credits">${esc(money(b.nonwithdrawable_credits_dollars))}</strong><span class="faint">${te('funds.balances_html.tradable_not_withdrawable', { exp })}</span></div>
    <div class="card pay-bal"><span class="faint">${te('funds.balances_html.settling')}</span><strong data-testid="bal-unsettled">${esc(money(b.unsettled_dollars))}</strong><span class="faint">${te('funds.balances_html.bank_deposits_tradable_now_withdrawable')}</span></div>
    ${Number(b.owed_dollars) > 0 ? `<div class="card pay-bal pay-owed" data-testid="bal-owed"><span>${te('funds.balances_html.you_owe')}</span><strong>${esc(money(b.owed_dollars))}</strong><span class="faint">${te('funds.balances_html.a_bank_returned_a_deposit')}</span></div>` : ''}
    ${Number(b.held_dollars) > 0 ? `<div class="card pay-bal"><span class="faint">${te('funds.balances_html.under_review')}</span><strong data-testid="bal-held">${esc(money(b.held_dollars))}</strong></div>` : ''}</div>`;
}
function txRow(t) {
  return `<tr data-testid="transfer-row" data-id="${esc(t.id)}" data-status="${esc(t.status)}" data-direction="${esc(t.direction)}"><td>${esc(relTime(t.created_time))}</td><td>${t.direction === 'deposit' ? te('funds.tx_row.deposit') : te('funds.tx_row.withdrawal')}</td>
    <td>${esc(t.label || t.rail)}${t.failure_message ? `<div class="faint">${esc(t.failure_message)}</div>` : ''}${t.rail === 'crypto' && t.direction === 'deposit' && !t.final ? `<div class="faint" data-testid="confirmations">${te('funds.tx_row.of_confirmations', { confirmations: esc(t.confirmations), confirmations_required: esc(t.confirmations_required) })}</div>` : ''}</td>
    <td class="num">${esc(money(t.amount_dollars))}${Number(t.fee_dollars) ? `<div class="faint">${te('funds.tx_row.fee', { money: esc(money(t.fee_dollars)) })}</div>` : ''}</td><td>${badge(t)}</td></tr>`;
}
const transfersTable = (rows) => (rows.length ? `<table class="table" data-testid="transfers"><thead><tr><th>${te('funds.transfers_table.when')}</th><th>${te('funds.transfers_table.type')}</th><th>${te('funds.transfers_table.method')}</th><th class="num">${te('funds.transfers_table.amount')}</th><th>${te('funds.transfers_table.status')}</th></tr></thead><tbody>${rows.map(txRow).join('')}</tbody></table>`
  : `<div class="empty" data-testid="transfers-empty">${te('funds.transfers_table.no_transfers_yet')}</div>`);
async function loadTransfers() {
  const [d, w] = await Promise.all([payApi.deposits(session.uid), payApi.withdrawals(session.uid)]);
  return [...d.deposits, ...w.withdrawals].sort((a, b) => Date.parse(b.created_time) - Date.parse(a.created_time)).slice(0, 30);
}

async function overview(body, onPayment) {
  const draw = async () => {
    const [meta, rows, ch] = await Promise.all([payApi.metadata(session.uid), loadTransfers(), payApi.creditHistory(session.uid)]);
    body.innerHTML = `${balancesHtml(meta.balances, meta.nonwithdrawable_credits)}
      ${moneyNotice()}${waitlistCta('funds')}<div class="d-flex gap-8 mt-12">${playLabel()}<a class="btn btn-primary" href="/funds/deposit" data-link data-testid="go-deposit" data-flag="payments.deposits">${te('funds.overview.deposit')}</a>${playOn() ? '' : `<a class="btn" href="/funds/withdraw" data-link data-testid="go-withdraw" data-flag="payments.withdrawals">${te('funds.overview.withdraw')}</a>`}<a class="btn btn-ghost" href="/account/payments" data-link>${te('funds.overview.payment_methods')}</a></div>
      <section class="card panel mt-16"><h2>${te('funds.overview.recent_transfers')}</h2>${transfersTable(rows)}</section>
      <section class="card panel" data-testid="credits"><h2>${te('funds.overview.credits')}</h2>${ch.credits.length ? `<table class="table"><thead><tr><th>${te('funds.overview.from')}</th><th class="num">${te('funds.overview.granted')}</th><th class="num">${te('funds.overview.left')}</th><th>${te('funds.overview.expires')}</th><th>${te('funds.overview.status')}</th></tr></thead><tbody>${ch.credits.map((c) => `<tr data-testid="credit-row" data-status="${esc(c.status)}"><td>${esc(c.source)}</td><td class="num">${esc(money(c.granted_dollars))}</td><td class="num">${esc(money(c.remaining_dollars))}</td><td>${esc(fmtDate(c.expires_time))}</td><td>${esc(c.status)}</td></tr>`).join('')}</tbody></table>` : `<p class="faint">${te('funds.overview.promotional_credits_you_receive_show')}</p>`}</section>`;
  };
  await draw();
  onPayment(() => draw().catch(() => {}));
}

// ------------------------------------------------------------------ shared flow pieces
function stepper(step) {
  const steps = [['method', tx('funds.stepper.method')], ['amount', tx('funds.stepper.amount')], ['review', tx('funds.stepper.review')], ['status', tx('funds.stepper.status')]];
  const i = steps.findIndex(([k]) => k === step);
  return `<ol class="pay-steps" aria-label="${te('funds.stepper.steps')}">${steps.map(([k, l], j) => `<li class="${j < i ? 'done' : j === i ? 'on' : ''}"${j === i ? ' aria-current="step"' : ''}>${esc(l)}</li>`).join('')}</ol>`;
}
const choice = (key, title, sub, cooling = false) => `<button type="button" class="pay-method" data-method="${esc(key)}" data-testid="fund-method"${cooling ? ' data-cooling="1"' : ''}><strong>${esc(title)}</strong><span class="faint">${esc(sub)}</span></button>`;

function statusView(host, t, { onPayment, poll }) {
  let cur = t;
  // Updates arrive from three places (WS, the poll, the challenge answer) in any order: keep the newest.
  const update = (x) => {
    if (!x || x.id !== cur.id) return;
    if (cur.final && !x.final) return;
    if (Date.parse(x.updated_time) < Date.parse(cur.updated_time)) return;
    if (x.status === cur.status && x.confirmations === cur.confirmations && x !== t) return;
    cur = x; draw(x);
  };
  const draw = (x) => {
    host.innerHTML = `${stepper('status')}<section class="card panel" data-testid="fund-status" data-status="${esc(x.status)}" data-id="${esc(x.id)}"><h2>${te('funds.status_view.of', { value: x.direction === 'deposit' ? te('funds.status_view.deposit') : te('funds.status_view.withdrawal'), money: esc(money(x.amount_dollars)) })}</h2>
      <p>${badge(x)}</p><p class="muted" data-testid="fund-status-text">${esc(statusText(x))}</p>
      ${x.status === 'requires_action' ? '<div data-challenge></div>' : ''}
      <div class="d-flex gap-8 mt-12"><a class="btn" href="/funds" data-link data-testid="fund-done">${te('funds.status_view.back_to_transfers')}</a><a class="btn btn-ghost" href="/funds/${x.direction === 'deposit' ? 'deposit' : 'withdraw'}" data-link>${te('funds.status_view.new', { value: x.direction === 'deposit' ? te('funds.status_view.deposit_2') : te('funds.status_view.withdrawal_2') })}</a></div></section>`;
    if (x.status === 'requires_action') challengeBox(host.querySelector('[data-challenge]'), x, update);
  };
  draw(t);
  onPayment(update);
  // Fallback poll (card payment status, as the observed client polls payment_status_web after the challenge step).
  const iv = setInterval(async () => {
    if (cur.final || !document.body.contains(host)) { clearInterval(iv); return; }
    try { update(await poll(cur.id)); } catch { /* next tick */ }
  }, 700);
}
function statusText(t) {
  if (t.failure_message) return t.failure_message;
  const s = {
    processing: t.direction === 'deposit' ? tx('funds.status_text.waiting_for_the_provider_to') : tx('funds.status_text.sent_to_the_provider_it'),
    requires_action: tx('funds.status_text.your_card_issuer_asks_you'),
    pending: tx('funds.status_text.the_money_is_in_your'),
    settled: tx('funds.status_text.settled_the_money_can_now'), succeeded: tx('funds.status_text.done_the_money_is_in'), paid: tx('funds.status_text.sent_it_is_on_its'),
    held: tx('funds.status_text.we_review_this_withdrawal_before'), confirming: tx('funds.status_text.waiting_for_confirmations_on_the', { confirmations_required: t.confirmations_required }),
    returned: tx('funds.status_text.the_bank_returned_this_deposit'), reversed: tx('funds.status_text.the_withdrawal_was_returned_to'),
  };
  return s[t.status] || '';
}
// 3-D Secure-style sandbox challenge: the "issuer" page asks to approve or fail.
function challengeBox(host, t, done) {
  host.innerHTML = `<div class="pay-challenge" data-testid="challenge"><strong>${te('funds.challenge_box.sandbox_card_issuer')}</strong><p class="muted">${te('funds.challenge_box.confirm_a_payment_of_to', { money: esc(money(t.amount_dollars)) })}</p>
    <div class="d-flex gap-8"><button class="btn btn-primary" data-r="approve" data-testid="challenge-approve">${te('funds.challenge_box.approve')}</button><button class="btn" data-r="fail" data-testid="challenge-fail">${te('funds.challenge_box.fail_verification')}</button></div><div class="form-error" role="alert"></div></div>`;
  for (const b of host.querySelectorAll('[data-r]')) {
    b.onclick = async () => {
      for (const x of host.querySelectorAll('[data-r]')) x.disabled = true;
      try { const r = await payApi.challenge(session.uid, t.id, b.dataset.r); done(r.payment); } catch (ex) { host.querySelector('.form-error').textContent = ex.message; }
    };
  }
}
async function challengePage(body, id, navigate) {
  const r = await payApi.paymentStatus(session.uid, id);
  if (r.payment.status !== 'requires_action') { navigate('/funds', { replace: true }); return; }
  body.innerHTML = '<section class="card panel" data-c></section>';
  challengeBox(body.querySelector('[data-c]'), r.payment, () => navigate('/funds'));
}
function amountStep(host, { title, method, limits, balances = null, fee = 0, onNext, onBack }) {
  const note = balances ? `<p data-testid="withdrawable-note">${te('funds.amount_step.you_can_withdraw')} <strong>${esc(money(balances.withdrawable_dollars))}</strong>.${Number(balances.nonwithdrawable_credits_dollars) ? (' ' + te('funds.amount_step.of_credits_can_be_traded', { money: esc(money(balances.nonwithdrawable_credits_dollars)) })) : ''}${Number(balances.unsettled_dollars) ? (' ' + te('funds.amount_step.is_still_settling', { money: esc(money(balances.unsettled_dollars)) })) : ''}</p>` : '';
  host.innerHTML = `${stepper('amount')}<form class="card panel pay-form" data-testid="fund-amount-form" novalidate><h2>${esc(title)}</h2><p class="muted">${esc(method)}</p>${note}
    <label class="field">${esc(T('input.amount_code', { code: currency.code }))}<input name="amount" type="number" min="${esc(moneyMin())}" step="${esc(moneyStep())}" inputmode="decimal" required data-testid="fund-amount"></label>
    <p class="faint">${limits.min_dollars ? te('funds.amount_step.minimum', { money: esc(money(limits.min_dollars)) }) : ''}${limits.max_dollars ? (' ' + te('funds.amount_step.maximum', { money: esc(money(limits.max_dollars)) })) : ''}${fee ? (' ' + te('funds.amount_step.network_fee', { money: esc(money(fee)) })) : ''}${limits.eta ? ` · ${esc(limits.eta)}` : ''}</p>
    <div class="form-error" role="alert" data-testid="fund-amount-error"></div>
    <div class="d-flex gap-8"><button class="btn" type="button" data-back>${te('funds.amount_step.back')}</button><button class="btn btn-primary" type="submit" data-testid="fund-continue">${te('funds.amount_step.review')}</button></div></form>`;
  const f = host.querySelector('form');
  f.querySelector('[data-back]').onclick = onBack;
  f.onsubmit = (e) => {
    e.preventDefault();
    const err = f.querySelector('[data-testid=fund-amount-error]');
    // Naira in, dollars out: whole naira ÷ 100 = the API's amount_dollars (CLONE_SPEC.md §30).
    if (!validMoneyInput(f.amount.value)) { err.textContent = T('error.amount_in', { hint: moneyInputHint() }); return; }
    const a = toApiDollars(f.amount.value);
    if (limits.min_dollars && a < Number(limits.min_dollars)) { err.textContent = tx('funds.amount_step.the_minimum_is', { money: money(limits.min_dollars) }); return; }
    if (limits.max_dollars && a > Number(limits.max_dollars)) { err.textContent = tx('funds.amount_step.the_maximum_is', { money: money(limits.max_dollars) }); return; }
    onNext(a);
  };
}
function reviewStep(host, { title, lines, confirmLabel, onConfirm, onBack }) {
  host.innerHTML = `${stepper('review')}<section class="card panel" data-testid="fund-review"><h2>${esc(title)}</h2><dl class="pay-review">${lines.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    <div class="form-error" role="alert" data-testid="fund-error"></div>
    <div class="d-flex gap-8"><button class="btn" type="button" data-back>${te('funds.review_step.back')}</button><button class="btn btn-primary" type="button" data-testid="fund-confirm">${esc(confirmLabel)}</button></div></section>`;
  host.querySelector('[data-back]').onclick = onBack;
  const btn = host.querySelector('[data-testid=fund-confirm]');
  btn.onclick = async () => {
    btn.disabled = true;
    const err = host.querySelector('[data-testid=fund-error]'); err.textContent = '';
    try { await onConfirm(); } catch (ex) { if (ex.code !== 'step_up_cancelled') err.textContent = ex.message; btn.disabled = false; }
  };
}

// ------------------------------------------------------------------ play mode and money controls (CLONE_SPEC.md §33)
// The server's message (CMS key server.playmode.money.*) and the admin's reason; the server refuses the request anyway.
function moneyNotice() {
  const m = flagState.money;
  if (!m) return '';
  const rows = [m.deposits, m.withdrawals].filter((x) => x && !x.allowed && x.code !== 'withdrawals_play_mode');
  return rows.map((x) => `<div class="pay-notice" role="status" data-testid="money-notice" data-code="${esc(x.code)}"><strong>${esc(x.message)}</strong>${x.reason ? ` <span>${te('funds.blocked.reason', { reason: esc(x.reason) })}</span>` : ''}</div>`).join('');
}
function blocked(body, kind) {
  const x = flagState.money && flagState.money[kind];
  if (!x || x.allowed) return false;
  body.innerHTML = `<section class="card panel pay-blocked" data-testid="money-blocked" data-code="${esc(x.code)}"><h2>${kind === 'deposits' ? te('funds.blocked.deposit_title') : te('funds.blocked.withdraw_title')}</h2>
    <p data-testid="money-blocked-message">${esc(x.message)}</p>${x.reason ? `<p class="muted" data-testid="money-blocked-reason">${te('funds.blocked.reason', { reason: esc(x.reason) })}</p>` : ''}
    <a class="btn" href="/funds" data-link>${te('funds.blocked.back')}</a></section>`;
  return true;
}
async function playDepositFlow(body) {
  const draw = async () => {
    const { play_money: pm } = await request('GET', `/v1/users/${encodeURIComponent(session.uid)}/play_money`);
    body.innerHTML = `<section class="card panel play-deposit" data-testid="play-deposit"><div class="d-flex ai-center gap-8 play-deposit-head" data-testid="play-deposit-head">${playLabel()}<h2 class="m-0">${te('funds.play.title')}</h2></div>
      <p class="muted">${te('funds.play.intro')}</p>
      <p class="faint" data-testid="play-cap">${pm.daily_cap_dollars == null ? te('funds.play.no_cap') : te('funds.play.cap', { cap: esc(money(pm.daily_cap_dollars)), left: esc(money(pm.left_today_dollars)) })}</p>
      <form class="pay-form" data-play novalidate><label class="field">${te('funds.play.amount')}<input name="amount" type="number" min="${esc(moneyMin())}" step="${esc(moneyStep())}" data-testid="play-amount" placeholder="${esc(T('input.amount_placeholder', { symbol: currency.symbol }))}"></label>
        <button class="btn btn-primary" type="submit" data-testid="play-submit">${te('funds.play.submit_plain')}</button><div class="form-error" role="alert" data-testid="play-error"></div></form></section>`;
    const f = body.querySelector('[data-play]');
    f.onsubmit = async (e) => {
      e.preventDefault();
      const raw = f.amount.value; const err = f.querySelector('.form-error'); err.textContent = '';
      if (!validMoneyInput(raw)) { err.textContent = tx('funds.play.invalid', { hint: moneyInputHint() }); return; }
      const a = toApiDollars(raw);
      try { await api.deposit(session.uid, a); toast(tx('funds.play.added', { money: money(a) })); await draw(); } catch (ex) { err.textContent = ex.message; }
    };
  };
  await draw();
}

// ------------------------------------------------------------------ deposit
async function depositFlow(body, onPayment) {
  if (blocked(body, 'deposits')) return;
  if (playOn()) { await playDepositFlow(body); return; } // play mode: free play money, no payment rail (§33)
  const meta = await payApi.metadata(session.uid);
  const M = Object.fromEntries(meta.methods.map((m) => [m.type, m]));
  for (const [k, f] of [['card', 'payments.card'], ['bank', 'payments.bank'], ['crypto', 'payments.crypto']]) if (M[k] && !flagOn(f)) M[k] = { ...M[k], available: false }; // per-rail flags
  const pick = async () => {
    const [{ cards }, { accounts }] = await Promise.all([flagOn('payments.card') ? payApi.cards(session.uid) : { cards: [] }, flagOn('payments.bank') ? payApi.banks(session.uid) : { accounts: [] }]);
    body.innerHTML = `${stepper('method')}<section class="card panel"><h2>${te('funds.deposit_flow.how_do_you_want_to')}</h2><div class="pay-methods">
      ${M.card?.available ? cards.map((c) => choice(`card:${c.id}`, methodLabel(c), tx('funds.deposit_flow.debit_card', { eta: M.card.deposit.eta }))).join('') + choice('new-card', tx('funds.deposit_flow.add_a_debit_card'), (tx('funds.deposit_flow.instant_up_to') + ' ') + money(M.card.deposit.max_dollars)) : ''}
      ${M.bank?.available ? accounts.map((a) => choice(`bank:${a.id}`, methodLabel(a), tx('funds.deposit_flow.bank_transfer_usable_at_once'))).join('') + choice('new-bank', tx('funds.deposit_flow.link_a_bank_account'), tx('funds.deposit_flow.free_settles_in_1_3')) : ''}
      ${M.crypto?.available ? choice('crypto', 'Crypto', tx('funds.deposit_flow.send_test_tokens_on_the', { confirmations: meta.crypto.confirmations })) : ''}
      ${M.demo ? choice('demo', tx('funds.deposit_flow.demo_funds'), tx('funds.deposit_flow.simulated_instant_not_available_in')) : ''}</div><div data-sub></div></section>`;
    const sub = body.querySelector('[data-sub]');
    for (const b of body.querySelectorAll('[data-method]')) {
      b.onclick = () => {
        const k = b.dataset.method;
        if (k === 'new-card') cardForm(sub, { submitLabel: 'Continue', onToken: (t) => amount({ kind: 'token', token: t.token, label: `${t.card.brand === 'mastercard' ? 'Mastercard' : 'Visa'} •••• ${t.card.last4}`, limits: M.card.deposit }) });
        else if (k === 'new-bank') bankLinkForm(sub, { institutions: meta.institutions, onLinked: (a) => { toast(tx('funds.deposit_flow.bank_account_linked')); amount({ kind: 'method', id: a.id, label: methodLabel(a), limits: M.bank.deposit }); } });
        else if (k === 'crypto') cryptoDeposit(body, meta, onPayment);
        else if (k === 'demo') amount({ kind: 'demo', label: tx('funds.deposit_flow.demo_funds'), limits: M.demo.deposit });
        else { const [type, id] = k.split(':'); amount({ kind: 'method', id, label: b.querySelector('strong').textContent, limits: M[type].deposit }); }
      };
    }
  };
  const amount = (sel) => amountStep(body, { title: tx('funds.deposit_flow.how_much'), method: sel.label, limits: sel.limits, onBack: pick,
    onNext: (a) => reviewStep(body, { title: tx('funds.deposit_flow.review_your_deposit'), lines: [[tx('funds.deposit_flow.from'), sel.label], [tx('funds.deposit_flow.amount'), money(a)], [tx('funds.deposit_flow.fee'), money(0)], [tx('funds.deposit_flow.arrives'), sel.limits.eta]], confirmLabel: `Deposit ${money(a)}`, onBack: () => amount(sel),
      onConfirm: async () => {
        if (sel.kind === 'demo') { await api.deposit(session.uid, a); toast(tx('funds.deposit_flow.deposited', { money: money(a) })); location.assign('/funds'); return; }
        const r = sel.kind === 'token' ? await payApi.cardPayment(session.uid, { token: sel.token, amount_dollars: a }) : await payApi.deposit(session.uid, sel.id, a);
        statusView(body, r.transaction, { onPayment, poll: async (id) => (await payApi.paymentStatus(session.uid, id)).payment });
      } }) });
  await pick();
}

async function cryptoDeposit(body, meta, onPayment) {
  let { account } = await payApi.cryptoAccount(session.uid);
  const draw = async () => {
    const { deposits } = await payApi.deposits(session.uid);
    const incoming = deposits.filter((d) => d.rail === 'crypto').slice(0, 10);
    body.innerHTML = `${stepper('method')}<section class="card panel" data-testid="crypto-deposit"><h2>${te('funds.crypto_deposit.deposit_crypto')}</h2>
      ${account.enabled ? `<p class="muted">${te('funds.crypto_deposit.send_test_tokens_tusd_on', { confirmations_required: esc(account.confirmations_required) })}</p>
        <div class="code pay-break" data-testid="crypto-address">${esc(account.address)}</div>
        <form class="pay-form mt-12" data-sim novalidate><p class="faint">${te('funds.crypto_deposit.sandbox_simulate_an_incoming_transfer')}</p><div class="inline-form"><label class="field">${esc(T('input.amount_code', { code: currency.code }))}<input name="amount" type="number" min="${esc(moneyMin())}" step="${esc(moneyStep())}" data-testid="crypto-sim-amount"></label><button class="btn" type="submit" data-testid="crypto-sim">${te('funds.crypto_deposit.simulate_transfer')}</button></div><div class="form-error" role="alert"></div></form>
        ${incoming.length ? transfersTable(incoming) : ''}`
    : `<p class="muted">${esc(account.terms)}</p><label class="d-flex gap-8 ai-center"><input type="checkbox" data-terms data-testid="crypto-terms"> ${te('funds.crypto_deposit.i_understand_and_accept')}</label><div class="form-error" role="alert"></div><button class="btn btn-primary mt-12" data-open data-testid="crypto-open">${te('funds.crypto_deposit.get_my_deposit_address')}</button>`}
      <div class="mt-12"><a class="btn btn-ghost" href="/funds/deposit" data-link>${te('funds.crypto_deposit.back')}</a></div></section>`;
    const open = body.querySelector('[data-open]');
    if (open) {
      open.onclick = async () => {
        if (!body.querySelector('[data-terms]').checked) { body.querySelector('.form-error').textContent = tx('funds.crypto_deposit.accept_the_terms_to_continue'); return; }
        try { account = (await payApi.openCrypto(session.uid)).account; await draw(); } catch (ex) { body.querySelector('.form-error').textContent = ex.message; }
      };
    }
    const sim = body.querySelector('[data-sim]');
    if (sim) {
      sim.onsubmit = async (e) => {
        e.preventDefault();
        try { await payApi.simulateCrypto(session.uid, toApiDollars(sim.amount.value)); toast(tx('funds.crypto_deposit.transfer_broadcast_on_the_sandbox')); setTimeout(() => draw().catch(() => {}), 300); } catch (ex) { sim.querySelector('.form-error').textContent = ex.message; }
      };
    }
  };
  await draw();
  onPayment((m) => { if (m.rail === 'crypto' && body.querySelector('[data-testid=crypto-deposit]')) draw().catch(() => {}); });
}

// ------------------------------------------------------------------ withdraw
async function withdrawFlow(body, onPayment) {
  if (blocked(body, 'withdrawals')) return; // play mode, a per-user revocation or the site-wide switch (§33)
  const [meta, times] = await Promise.all([payApi.metadata(session.uid), payApi.withdrawalTimes(session.uid)]);
  const M = Object.fromEntries(meta.methods.map((m) => [m.type, m]));
  for (const [k, f] of [['card', 'payments.card'], ['bank', 'payments.bank'], ['crypto', 'payments.crypto']]) if (M[k] && !flagOn(f)) M[k] = { ...M[k], available: false }; // per-rail flags
  const eta = (k) => times.withdrawal_times.find((t) => t.method === k)?.estimate || '';
  const pick = async () => {
    const [{ cards }, { accounts }, { wallets }, fresh] = await Promise.all([flagOn('payments.card') ? payApi.cards(session.uid) : { cards: [] }, flagOn('payments.bank') ? payApi.banks(session.uid) : { accounts: [] }, flagOn('payments.crypto') ? payApi.wallets(session.uid) : { wallets: [] }, payApi.metadata(session.uid)]);
    body.innerHTML = `${balancesHtml(fresh.balances, fresh.nonwithdrawable_credits)}${stepper('method')}<section class="card panel"><h2>${te('funds.withdraw_flow.where_should_we_send_it')}</h2><div class="pay-methods">
      ${M.bank?.available ? accounts.map((a) => choice(`bank:${a.id}`, methodLabel(a), tx('funds.withdraw_flow.bank', { eta: eta('bank') }))).join('') + choice('new-bank', tx('funds.withdraw_flow.link_a_bank_account'), tx('funds.withdraw_flow.needs_a_quick_identity_check')) : ''}
      ${M.card?.available ? cards.filter((c) => c.can_withdraw).map((c) => choice(`card:${c.id}`, methodLabel(c), tx('funds.withdraw_flow.debit_card', { eta: eta('card') }))).join('') : ''}
      ${M.crypto?.available ? wallets.map((w) => choice(`crypto:${w.id}`, methodLabel(w), w.cooling ? methodSub(w) : tx('funds.withdraw_flow.crypto_fee', { eta: eta('crypto'), money: money(M.crypto.withdrawal.fee_dollars) }), w.cooling)).join('') + choice('new-wallet', tx('funds.withdraw_flow.add_a_crypto_address'), tx('funds.withdraw_flow.sandbox_chain')) : ''}
      ${M.demo ? choice('demo', tx('funds.withdraw_flow.demo_funds'), tx('funds.withdraw_flow.simulated_instant')) : ''}</div><div data-sub></div></section>`;
    const sub = body.querySelector('[data-sub]');
    for (const b of body.querySelectorAll('[data-method]')) {
      b.onclick = () => {
        const k = b.dataset.method;
        if (k === 'new-bank') bankLinkForm(sub, { institutions: meta.institutions, onLinked: () => { toast(tx('funds.withdraw_flow.bank_account_linked')); pick(); } });
        else if (k === 'new-wallet') walletForm(sub, { example: null, onAdded: () => { toast(tx('funds.withdraw_flow.address_saved')); pick(); } });
        else if (k === 'demo') amount({ kind: 'demo', label: tx('funds.withdraw_flow.demo_funds'), limits: { ...M.demo.withdrawal, eta: 'instant' }, fee: 0, balances: fresh.balances });
        else { const [type, id] = k.split(':'); amount({ kind: 'method', id, label: b.querySelector('strong').textContent, limits: { ...M[type].withdrawal, eta: eta(type) }, fee: type === 'crypto' ? Number(M.crypto.withdrawal.fee_dollars) : 0, balances: fresh.balances }); }
      };
    }
  };
  const amount = (sel) => amountStep(body, { title: tx('funds.withdraw_flow.how_much'), method: sel.label, limits: { ...sel.limits, max_dollars: sel.limits.max_dollars && Number(sel.limits.max_dollars) < Number(sel.balances.withdrawable_dollars) ? sel.limits.max_dollars : sel.balances.withdrawable_dollars }, fee: sel.fee, onBack: pick,
    balances: sel.balances,
    onNext: (a) => reviewStep(body, { title: tx('funds.withdraw_flow.review_your_withdrawal'), lines: [[tx('funds.withdraw_flow.to'), sel.label], [tx('funds.withdraw_flow.amount'), money(a)], ...(sel.fee ? [[tx('funds.withdraw_flow.network_fee'), money(sel.fee)], [tx('funds.withdraw_flow.you_receive'), money(a - sel.fee)]] : []), [tx('funds.withdraw_flow.arrives'), sel.limits.eta]], confirmLabel: `Withdraw ${money(a)}`, onBack: () => amount(sel),
      onConfirm: async () => {
        if (sel.kind === 'demo') { const r = await api.withdraw(session.uid, a); toast(r && r.status === 'held' ? tx('funds.withdraw_flow.withdrawal_of_is_under_review', { money: money(a) }) : tx('funds.withdraw_flow.withdrew', { money: money(a) })); location.assign('/funds'); return; }
        const r = await payApi.withdraw(session.uid, sel.id, a);
        statusView(body, r.transaction, { onPayment, poll: async (id) => (await payApi.withdrawals(session.uid)).withdrawals.find((x) => x.id === id) });
      } }) });
  await pick();
}
