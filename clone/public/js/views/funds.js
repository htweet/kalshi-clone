// Deposit / Withdraw (CLONE_SPEC.md §26.10). Parlance design: the original screens were not observed (the live site
// serves a bot checkpoint to automated browsers); the API surface they use is the observed one (§26.1).
//   /funds            balances (cash, non-withdrawable credits, settling, withdrawable, owed), recent transfers, credits
//   /funds/deposit    method → amount → review → status (cards incl. a sandbox verification step, banks, crypto address)
//   /funds/withdraw   method → amount → review → status (banks, cards you deposited with, crypto addresses)
// Status updates arrive over the private `payments` WebSocket channel (and a short poll as a fallback); the balance in the
// header updates over `user_balance`.
import { t as T } from '../content/currency-strings.js'; // keyed wording (CLONE_SPEC.md §30)
import { api } from '../api.js';
import { payApi } from '../payments-api.js';
import { session } from '../store.js';
import { socket } from '../ws.js';
import { esc, money, toast, relTime, currency, moneyStep, moneyMin, toApiDollars, validMoneyInput, moneyInputHint, fmtDate } from '../lib.js';
import { cardForm, bankLinkForm, walletForm, methodLabel, methodSub } from './payment-forms.js';

const STATUS_KIND = { succeeded: 'ok', settled: 'ok', paid: 'ok', pending: 'info', processing: 'info', confirming: 'info', requires_action: 'warn', held: 'warn', failed: 'bad', returned: 'bad', reversed: 'bad' };
const badge = (t) => `<span class="pay-badge ${esc(STATUS_KIND[t.status] || '')}" data-testid="pay-status-badge">${esc(t.status_label)}</span>`;

export async function render({ el, params, navigate }) {
  if (!session.user) { navigate('/sign-in?next=' + encodeURIComponent(location.pathname), { replace: true }); return; }
  const mode = params.mode || 'overview';
  document.title = `${mode === 'deposit' ? 'Deposit' : mode === 'withdraw' ? 'Withdraw' : 'Transfers'} · Parlance`;
  el.innerHTML = `<div class="pay" data-testid="funds" data-mode="${esc(mode)}"><div class="page-head pay-head"><h1 class="typ-title-x10">${mode === 'deposit' ? 'Deposit' : mode === 'withdraw' ? 'Withdraw' : 'Transfers'}</h1>
    <nav class="seg" aria-label="Transfers"><a class="${mode === 'overview' ? 'on' : ''}" href="/funds" data-link>Overview</a><a class="${mode === 'deposit' ? 'on' : ''}" href="/funds/deposit" data-link data-testid="nav-deposit">Deposit</a><a class="${mode === 'withdraw' ? 'on' : ''}" href="/funds/withdraw" data-link data-testid="nav-withdraw">Withdraw</a></nav></div>
    <p class="faint pay-sandbox" data-testid="sandbox-note">Sandbox: test cards, test banks and a test chain only. No real money moves.</p><div data-body></div></div>`;
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
  const exp = credits && credits.predictions.credits.length ? ` · expires in ${esc(credits.predictions.expiry_days)} days` : '';
  return `<div class="pay-balances" data-testid="balances">
    <div class="card pay-bal"><span class="faint">Cash balance</span><strong data-testid="bal-total">${esc(money(b.balance_dollars))}</strong></div>
    <div class="card pay-bal"><span class="faint">Withdrawable</span><strong data-testid="bal-withdrawable">${esc(money(b.withdrawable_dollars))}</strong></div>
    <div class="card pay-bal"><span class="faint">Non-withdrawable credits</span><strong data-testid="bal-credits">${esc(money(b.nonwithdrawable_credits_dollars))}</strong><span class="faint">Tradable, not withdrawable${exp}</span></div>
    <div class="card pay-bal"><span class="faint">Settling</span><strong data-testid="bal-unsettled">${esc(money(b.unsettled_dollars))}</strong><span class="faint">Bank deposits: tradable now, withdrawable once settled</span></div>
    ${Number(b.owed_dollars) > 0 ? `<div class="card pay-bal pay-owed" data-testid="bal-owed"><span>You owe</span><strong>${esc(money(b.owed_dollars))}</strong><span class="faint">A bank returned a deposit you had already used. Your next deposit repays it.</span></div>` : ''}
    ${Number(b.held_dollars) > 0 ? `<div class="card pay-bal"><span class="faint">Under review</span><strong data-testid="bal-held">${esc(money(b.held_dollars))}</strong></div>` : ''}</div>`;
}
function txRow(t) {
  return `<tr data-testid="transfer-row" data-id="${esc(t.id)}" data-status="${esc(t.status)}" data-direction="${esc(t.direction)}"><td>${esc(relTime(t.created_time))}</td><td>${t.direction === 'deposit' ? 'Deposit' : 'Withdrawal'}</td>
    <td>${esc(t.label || t.rail)}${t.failure_message ? `<div class="faint">${esc(t.failure_message)}</div>` : ''}${t.rail === 'crypto' && t.direction === 'deposit' && !t.final ? `<div class="faint" data-testid="confirmations">${esc(t.confirmations)} of ${esc(t.confirmations_required)} confirmations</div>` : ''}</td>
    <td class="num">${esc(money(t.amount_dollars))}${Number(t.fee_dollars) ? `<div class="faint">fee ${esc(money(t.fee_dollars))}</div>` : ''}</td><td>${badge(t)}</td></tr>`;
}
const transfersTable = (rows) => (rows.length ? `<table class="table" data-testid="transfers"><thead><tr><th>When</th><th>Type</th><th>Method</th><th class="num">Amount</th><th>Status</th></tr></thead><tbody>${rows.map(txRow).join('')}</tbody></table>`
  : '<div class="empty" data-testid="transfers-empty">No transfers yet.</div>');
async function loadTransfers() {
  const [d, w] = await Promise.all([payApi.deposits(session.uid), payApi.withdrawals(session.uid)]);
  return [...d.deposits, ...w.withdrawals].sort((a, b) => Date.parse(b.created_time) - Date.parse(a.created_time)).slice(0, 30);
}

async function overview(body, onPayment) {
  const draw = async () => {
    const [meta, rows, ch] = await Promise.all([payApi.metadata(session.uid), loadTransfers(), payApi.creditHistory(session.uid)]);
    body.innerHTML = `${balancesHtml(meta.balances, meta.nonwithdrawable_credits)}
      <div class="d-flex gap-8 mt-12"><a class="btn btn-primary" href="/funds/deposit" data-link data-testid="go-deposit">Deposit</a><a class="btn" href="/funds/withdraw" data-link data-testid="go-withdraw">Withdraw</a><a class="btn btn-ghost" href="/account/payments" data-link>Payment methods</a></div>
      <section class="card panel mt-16"><h2>Recent transfers</h2>${transfersTable(rows)}</section>
      <section class="card panel" data-testid="credits"><h2>Credits</h2>${ch.credits.length ? `<table class="table"><thead><tr><th>From</th><th class="num">Granted</th><th class="num">Left</th><th>Expires</th><th>Status</th></tr></thead><tbody>${ch.credits.map((c) => `<tr data-testid="credit-row" data-status="${esc(c.status)}"><td>${esc(c.source)}</td><td class="num">${esc(money(c.granted_dollars))}</td><td class="num">${esc(money(c.remaining_dollars))}</td><td>${esc(fmtDate(c.expires_time))}</td><td>${esc(c.status)}</td></tr>`).join('')}</tbody></table>` : '<p class="faint">Promotional credits you receive show here. They can be traded, not withdrawn, and they expire.</p>'}</section>`;
  };
  await draw();
  onPayment(() => draw().catch(() => {}));
}

// ------------------------------------------------------------------ shared flow pieces
function stepper(step) {
  const steps = [['method', 'Method'], ['amount', 'Amount'], ['review', 'Review'], ['status', 'Status']];
  const i = steps.findIndex(([k]) => k === step);
  return `<ol class="pay-steps" aria-label="Steps">${steps.map(([k, l], j) => `<li class="${j < i ? 'done' : j === i ? 'on' : ''}"${j === i ? ' aria-current="step"' : ''}>${esc(l)}</li>`).join('')}</ol>`;
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
    host.innerHTML = `${stepper('status')}<section class="card panel" data-testid="fund-status" data-status="${esc(x.status)}" data-id="${esc(x.id)}"><h2>${x.direction === 'deposit' ? 'Deposit' : 'Withdrawal'} of ${esc(money(x.amount_dollars))}</h2>
      <p>${badge(x)}</p><p class="muted" data-testid="fund-status-text">${esc(statusText(x))}</p>
      ${x.status === 'requires_action' ? '<div data-challenge></div>' : ''}
      <div class="d-flex gap-8 mt-12"><a class="btn" href="/funds" data-link data-testid="fund-done">Back to transfers</a><a class="btn btn-ghost" href="/funds/${x.direction === 'deposit' ? 'deposit' : 'withdraw'}" data-link>New ${x.direction === 'deposit' ? 'deposit' : 'withdrawal'}</a></div></section>`;
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
    processing: t.direction === 'deposit' ? 'Waiting for the provider to confirm…' : 'Sent to the provider. It arrives as estimated.',
    requires_action: 'Your card issuer asks you to confirm this payment.',
    pending: 'The money is in your balance and can be traded now. It can be withdrawn once the bank settles it.',
    settled: 'Settled: the money can now be withdrawn.', succeeded: 'Done. The money is in your balance.', paid: 'Sent. It is on its way to you.',
    held: 'We review this withdrawal before it is sent, usually within one business day.', confirming: `Waiting for ${t.confirmations_required} confirmations on the sandbox chain.`,
    returned: 'The bank returned this deposit.', reversed: 'The withdrawal was returned to your balance.',
  };
  return s[t.status] || '';
}
// 3-D Secure-style sandbox challenge: the "issuer" page asks to approve or fail.
function challengeBox(host, t, done) {
  host.innerHTML = `<div class="pay-challenge" data-testid="challenge"><strong>Sandbox card issuer</strong><p class="muted">Confirm a payment of ${esc(money(t.amount_dollars))} to Parlance Exchange.</p>
    <div class="d-flex gap-8"><button class="btn btn-primary" data-r="approve" data-testid="challenge-approve">Approve</button><button class="btn" data-r="fail" data-testid="challenge-fail">Fail verification</button></div><div class="form-error" role="alert"></div></div>`;
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
  const note = balances ? `<p data-testid="withdrawable-note">You can withdraw <strong>${esc(money(balances.withdrawable_dollars))}</strong>.${Number(balances.nonwithdrawable_credits_dollars) ? ` ${esc(money(balances.nonwithdrawable_credits_dollars))} of credits can be traded but not withdrawn.` : ''}${Number(balances.unsettled_dollars) ? ` ${esc(money(balances.unsettled_dollars))} is still settling.` : ''}</p>` : '';
  host.innerHTML = `${stepper('amount')}<form class="card panel pay-form" data-testid="fund-amount-form" novalidate><h2>${esc(title)}</h2><p class="muted">${esc(method)}</p>${note}
    <label class="field">${esc(T('input.amount_code', { code: currency.code }))}<input name="amount" type="number" min="${esc(moneyMin())}" step="${esc(moneyStep())}" inputmode="decimal" required data-testid="fund-amount"></label>
    <p class="faint">${limits.min_dollars ? `Minimum ${esc(money(limits.min_dollars))}` : ''}${limits.max_dollars ? ` · maximum ${esc(money(limits.max_dollars))}` : ''}${fee ? ` · network fee ${esc(money(fee))}` : ''}${limits.eta ? ` · ${esc(limits.eta)}` : ''}</p>
    <div class="form-error" role="alert" data-testid="fund-amount-error"></div>
    <div class="d-flex gap-8"><button class="btn" type="button" data-back>Back</button><button class="btn btn-primary" type="submit" data-testid="fund-continue">Review</button></div></form>`;
  const f = host.querySelector('form');
  f.querySelector('[data-back]').onclick = onBack;
  f.onsubmit = (e) => {
    e.preventDefault();
    const err = f.querySelector('[data-testid=fund-amount-error]');
    // Naira in, dollars out: whole naira ÷ 100 = the API's amount_dollars (CLONE_SPEC.md §30).
    if (!validMoneyInput(f.amount.value)) { err.textContent = T('error.amount_in', { hint: moneyInputHint() }); return; }
    const a = toApiDollars(f.amount.value);
    if (limits.min_dollars && a < Number(limits.min_dollars)) { err.textContent = `The minimum is ${money(limits.min_dollars)}.`; return; }
    if (limits.max_dollars && a > Number(limits.max_dollars)) { err.textContent = `The maximum is ${money(limits.max_dollars)}.`; return; }
    onNext(a);
  };
}
function reviewStep(host, { title, lines, confirmLabel, onConfirm, onBack }) {
  host.innerHTML = `${stepper('review')}<section class="card panel" data-testid="fund-review"><h2>${esc(title)}</h2><dl class="pay-review">${lines.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    <div class="form-error" role="alert" data-testid="fund-error"></div>
    <div class="d-flex gap-8"><button class="btn" type="button" data-back>Back</button><button class="btn btn-primary" type="button" data-testid="fund-confirm">${esc(confirmLabel)}</button></div></section>`;
  host.querySelector('[data-back]').onclick = onBack;
  const btn = host.querySelector('[data-testid=fund-confirm]');
  btn.onclick = async () => {
    btn.disabled = true;
    const err = host.querySelector('[data-testid=fund-error]'); err.textContent = '';
    try { await onConfirm(); } catch (ex) { if (ex.code !== 'step_up_cancelled') err.textContent = ex.message; btn.disabled = false; }
  };
}

// ------------------------------------------------------------------ deposit
async function depositFlow(body, onPayment) {
  const meta = await payApi.metadata(session.uid);
  const M = Object.fromEntries(meta.methods.map((m) => [m.type, m]));
  const pick = async () => {
    const [{ cards }, { accounts }] = await Promise.all([payApi.cards(session.uid), payApi.banks(session.uid)]);
    body.innerHTML = `${stepper('method')}<section class="card panel"><h2>How do you want to deposit?</h2><div class="pay-methods">
      ${M.card?.available ? cards.map((c) => choice(`card:${c.id}`, methodLabel(c), `Debit card · ${M.card.deposit.eta}`)).join('') + choice('new-card', 'Add a debit card', 'Instant · up to ' + money(M.card.deposit.max_dollars)) : ''}
      ${M.bank?.available ? accounts.map((a) => choice(`bank:${a.id}`, methodLabel(a), 'Bank transfer · usable at once, settles in 1–3 business days')).join('') + choice('new-bank', 'Link a bank account', 'Free · settles in 1–3 business days') : ''}
      ${M.crypto?.available ? choice('crypto', 'Crypto', `Send test tokens on the sandbox chain · ${meta.crypto.confirmations} confirmations`) : ''}
      ${M.demo ? choice('demo', 'Demo funds', 'Simulated, instant (not available in production)') : ''}</div><div data-sub></div></section>`;
    const sub = body.querySelector('[data-sub]');
    for (const b of body.querySelectorAll('[data-method]')) {
      b.onclick = () => {
        const k = b.dataset.method;
        if (k === 'new-card') cardForm(sub, { submitLabel: 'Continue', onToken: (t) => amount({ kind: 'token', token: t.token, label: `${t.card.brand === 'mastercard' ? 'Mastercard' : 'Visa'} •••• ${t.card.last4}`, limits: M.card.deposit }) });
        else if (k === 'new-bank') bankLinkForm(sub, { institutions: meta.institutions, onLinked: (a) => { toast('Bank account linked'); amount({ kind: 'method', id: a.id, label: methodLabel(a), limits: M.bank.deposit }); } });
        else if (k === 'crypto') cryptoDeposit(body, meta, onPayment);
        else if (k === 'demo') amount({ kind: 'demo', label: 'Demo funds', limits: M.demo.deposit });
        else { const [type, id] = k.split(':'); amount({ kind: 'method', id, label: b.querySelector('strong').textContent, limits: M[type].deposit }); }
      };
    }
  };
  const amount = (sel) => amountStep(body, { title: 'How much?', method: sel.label, limits: sel.limits, onBack: pick,
    onNext: (a) => reviewStep(body, { title: 'Review your deposit', lines: [['From', sel.label], ['Amount', money(a)], ['Fee', money(0)], ['Arrives', sel.limits.eta]], confirmLabel: `Deposit ${money(a)}`, onBack: () => amount(sel),
      onConfirm: async () => {
        if (sel.kind === 'demo') { await api.deposit(session.uid, a); toast(`Deposited ${money(a)}`); location.assign('/funds'); return; }
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
    body.innerHTML = `${stepper('method')}<section class="card panel" data-testid="crypto-deposit"><h2>Deposit crypto</h2>
      ${account.enabled ? `<p class="muted">Send test tokens (tUSD) on the sandbox chain to your deposit address. They are credited after ${esc(account.confirmations_required)} confirmations.</p>
        <div class="code pay-break" data-testid="crypto-address">${esc(account.address)}</div>
        <form class="pay-form mt-12" data-sim novalidate><p class="faint">Sandbox: simulate an incoming transfer from an outside wallet.</p><div class="inline-form"><label class="field">${esc(T('input.amount_code', { code: currency.code }))}<input name="amount" type="number" min="${esc(moneyMin())}" step="${esc(moneyStep())}" data-testid="crypto-sim-amount"></label><button class="btn" type="submit" data-testid="crypto-sim">Simulate transfer</button></div><div class="form-error" role="alert"></div></form>
        ${incoming.length ? transfersTable(incoming) : ''}`
    : `<p class="muted">${esc(account.terms)}</p><label class="d-flex gap-8 ai-center"><input type="checkbox" data-terms data-testid="crypto-terms"> I understand and accept</label><div class="form-error" role="alert"></div><button class="btn btn-primary mt-12" data-open data-testid="crypto-open">Get my deposit address</button>`}
      <div class="mt-12"><a class="btn btn-ghost" href="/funds/deposit" data-link>Back</a></div></section>`;
    const open = body.querySelector('[data-open]');
    if (open) {
      open.onclick = async () => {
        if (!body.querySelector('[data-terms]').checked) { body.querySelector('.form-error').textContent = 'Accept the terms to continue.'; return; }
        try { account = (await payApi.openCrypto(session.uid)).account; await draw(); } catch (ex) { body.querySelector('.form-error').textContent = ex.message; }
      };
    }
    const sim = body.querySelector('[data-sim]');
    if (sim) {
      sim.onsubmit = async (e) => {
        e.preventDefault();
        try { await payApi.simulateCrypto(session.uid, toApiDollars(sim.amount.value)); toast('Transfer broadcast on the sandbox chain'); setTimeout(() => draw().catch(() => {}), 300); } catch (ex) { sim.querySelector('.form-error').textContent = ex.message; }
      };
    }
  };
  await draw();
  onPayment((m) => { if (m.rail === 'crypto' && body.querySelector('[data-testid=crypto-deposit]')) draw().catch(() => {}); });
}

// ------------------------------------------------------------------ withdraw
async function withdrawFlow(body, onPayment) {
  const [meta, times] = await Promise.all([payApi.metadata(session.uid), payApi.withdrawalTimes(session.uid)]);
  const M = Object.fromEntries(meta.methods.map((m) => [m.type, m]));
  const eta = (k) => times.withdrawal_times.find((t) => t.method === k)?.estimate || '';
  const pick = async () => {
    const [{ cards }, { accounts }, { wallets }, fresh] = await Promise.all([payApi.cards(session.uid), payApi.banks(session.uid), payApi.wallets(session.uid), payApi.metadata(session.uid)]);
    body.innerHTML = `${balancesHtml(fresh.balances, fresh.nonwithdrawable_credits)}${stepper('method')}<section class="card panel"><h2>Where should we send it?</h2><div class="pay-methods">
      ${M.bank?.available ? accounts.map((a) => choice(`bank:${a.id}`, methodLabel(a), `Bank · ${eta('bank')}`)).join('') + choice('new-bank', 'Link a bank account', 'Needs a quick identity check') : ''}
      ${M.card?.available ? cards.filter((c) => c.can_withdraw).map((c) => choice(`card:${c.id}`, methodLabel(c), `Debit card · ${eta('card')}`)).join('') : ''}
      ${M.crypto?.available ? wallets.map((w) => choice(`crypto:${w.id}`, methodLabel(w), w.cooling ? methodSub(w) : `Crypto · ${eta('crypto')} · fee ${money(M.crypto.withdrawal.fee_dollars)}`, w.cooling)).join('') + choice('new-wallet', 'Add a crypto address', 'Sandbox chain') : ''}
      ${M.demo ? choice('demo', 'Demo funds', 'Simulated, instant') : ''}</div><div data-sub></div></section>`;
    const sub = body.querySelector('[data-sub]');
    for (const b of body.querySelectorAll('[data-method]')) {
      b.onclick = () => {
        const k = b.dataset.method;
        if (k === 'new-bank') bankLinkForm(sub, { institutions: meta.institutions, onLinked: () => { toast('Bank account linked'); pick(); } });
        else if (k === 'new-wallet') walletForm(sub, { example: null, onAdded: () => { toast('Address saved'); pick(); } });
        else if (k === 'demo') amount({ kind: 'demo', label: 'Demo funds', limits: { ...M.demo.withdrawal, eta: 'instant' }, fee: 0, balances: fresh.balances });
        else { const [type, id] = k.split(':'); amount({ kind: 'method', id, label: b.querySelector('strong').textContent, limits: { ...M[type].withdrawal, eta: eta(type) }, fee: type === 'crypto' ? Number(M.crypto.withdrawal.fee_dollars) : 0, balances: fresh.balances }); }
      };
    }
  };
  const amount = (sel) => amountStep(body, { title: 'How much?', method: sel.label, limits: { ...sel.limits, max_dollars: sel.limits.max_dollars && Number(sel.limits.max_dollars) < Number(sel.balances.withdrawable_dollars) ? sel.limits.max_dollars : sel.balances.withdrawable_dollars }, fee: sel.fee, onBack: pick,
    balances: sel.balances,
    onNext: (a) => reviewStep(body, { title: 'Review your withdrawal', lines: [['To', sel.label], ['Amount', money(a)], ...(sel.fee ? [['Network fee', money(sel.fee)], ['You receive', money(a - sel.fee)]] : []), ['Arrives', sel.limits.eta]], confirmLabel: `Withdraw ${money(a)}`, onBack: () => amount(sel),
      onConfirm: async () => {
        if (sel.kind === 'demo') { const r = await api.withdraw(session.uid, a); toast(r && r.status === 'held' ? `Withdrawal of ${money(a)} is under review` : `Withdrew ${money(a)}`); location.assign('/funds'); return; }
        const r = await payApi.withdraw(session.uid, sel.id, a);
        statusView(body, r.transaction, { onPayment, poll: async (id) => (await payApi.withdrawals(session.uid)).withdrawals.find((x) => x.id === id) });
      } }) });
  await pick();
}
