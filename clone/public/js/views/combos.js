// Combo builder (spec §17.3, §17.7): pick outcomes from open markets into a slip (DB-persisted per user), see the
// combined odds, request a quote (RFQ), accept it before it expires, then follow Confirming… → executed.
import { api } from '../api.js';
import { session } from '../store.js';
import { socket } from '../ws.js';
import { esc, prob, money, qty, cents, toast, secsLeft, catLabel } from '../lib.js';
import { evIcon } from './components.js';

const MAX_LEGS = 6;

export async function render({ el, navigate }) {
  document.title = 'Build a combo · Parlance';
  const { multivariate_contract: coll } = await api.comboCollection();
  const events = coll.events;
  const marketBy = new Map();
  for (const e of events) for (const m of e.markets) marketBy.set(m.ticker, { m, e });
  const legProb = (l) => { const x = marketBy.get(l.market_ticker); const p = x ? prob(x.m) ?? 50 : l.prob ?? 50; return l.side === 'yes' ? p : 100 - p; };

  const state = { legs: [], amount: '10', filter: '', rfq: null, quote: null, phase: 'idle', executed: null };
  if (session.user) {
    try {
      const { slip } = await api.comboSlip(session.uid);
      state.legs = slip.legs.filter((l) => marketBy.has(l.market_ticker)).map((l) => ({ market_ticker: l.market_ticker, event_ticker: l.event_ticker, side: l.side }));
      if (slip.amount_dollars != null) state.amount = String(Number(slip.amount_dollars));
    } catch { /* empty slip */ }
  }

  el.innerHTML = `<div class="page-head"><h1 class="typ-title-x10" data-testid="combos-title">${esc(coll.title)}</h1><p class="muted">${esc(coll.description)}</p></div>
    <div class="combos-layout">
      <section class="combo-picker" aria-label="Outcomes">
        <input class="combo-search" id="combo-search" type="search" placeholder="Filter events" aria-label="Filter events">
        <div id="combo-events"></div>
      </section>
      <aside class="combo-side"><section class="card combo-slip" data-testid="combo-slip" aria-label="Combo slip"></section></aside>
    </div>`;
  const $ = (s) => el.querySelector(s);

  const combined = () => state.legs.reduce((a, l) => a * (legProb(l) / 100), 1) * 100;
  async function persist() {
    if (!session.user) return;
    try { await api.saveComboSlip(session.uid, { legs: state.legs.map(({ market_ticker, side }) => ({ market_ticker, side })), amount_dollars: Number(state.amount) > 0 ? Number(Number(state.amount).toFixed(2)) : null }); } catch (e) { toast(e.message, 'error'); }
  }

  function drawEvents() {
    const f = state.filter.toLowerCase();
    const shown = events.filter((e) => !f || [e.title, e.category, ...e.markets.map((m) => m.yes_sub_title)].join(' ').toLowerCase().includes(f));
    $('#combo-events').innerHTML = shown.map((e) => `<article class="card combo-ev" data-event="${esc(e.event_ticker)}">
      <header>${evIcon(e, 'sm')}<div><div class="faint">${esc(catLabel(e.category))}</div><h3>${esc(e.title)}</h3></div></header>
      ${e.markets.map((m) => {
        const p = prob(m) ?? 50;
        const leg = state.legs.find((l) => l.market_ticker === m.ticker);
        return `<div class="combo-mkt" data-testid="combo-market" data-ticker="${esc(m.ticker)}"><span class="combo-mkt-name">${esc(m.yes_sub_title)}<span class="faint">${p}%</span></span>
          <button class="yes-btn ${leg?.side === 'yes' ? 'on' : ''}" data-leg-side="yes" aria-pressed="${leg?.side === 'yes'}">Yes ${p}%</button><button class="no-btn ${leg?.side === 'no' ? 'on' : ''}" data-leg-side="no" aria-pressed="${leg?.side === 'no'}">No ${100 - p}%</button></div>`;
      }).join('')}</article>`).join('') || '<div class="card empty">No open markets match.</div>';
  }

  function toggle(ticker, side) {
    const { e } = marketBy.get(ticker);
    const i = state.legs.findIndex((l) => l.market_ticker === ticker);
    if (i >= 0 && state.legs[i].side === side) state.legs.splice(i, 1);
    else {
      const rest = state.legs.filter((l) => l.event_ticker !== e.event_ticker); // one leg per event
      if (rest.length >= MAX_LEGS) { toast(`A combo can have at most ${MAX_LEGS} legs`, 'error'); return; }
      state.legs = [...rest, { market_ticker: ticker, event_ticker: e.event_ticker, side }];
    }
    resetQuote();
    drawEvents(); drawSlip(); persist();
  }
  $('#combo-events').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-leg-side]');
    if (b) toggle(b.closest('[data-ticker]').dataset.ticker, b.dataset.legSide);
  });
  $('#combo-search').oninput = (e) => { state.filter = e.target.value; drawEvents(); };

  function resetQuote() { if (!['accepting', 'confirming'].includes(state.phase)) { state.rfq = null; state.quote = null; state.phase = 'idle'; } }

  function quoteBox() {
    const q = state.quote;
    if (state.phase === 'requesting' || (state.phase === 'waiting' && !q)) return '<div class="combo-quote" data-testid="quote-state">Requesting a quote…</div>';
    if (state.phase === 'quoted' && q) {
      const px = cents(q.buy_yes_price_dollars);
      return `<div class="combo-quote" data-testid="combo-quote"><div class="tkt-row"><span>Quote</span><strong data-testid="quote-price">Yes ${px}¢</strong></div>
        <div class="tkt-row"><span>Contracts</span><strong class="num" data-testid="quote-contracts">${qty(q.no_contracts_fp)}</strong></div>
        <div class="tkt-row"><span>Pays if every leg hits</span><strong class="payout">${money(q.no_contracts_fp)}</strong></div>
        <button class="cta" data-testid="accept-quote" id="accept-quote">Accept · <span data-countdown="${esc(q.expires_time)}">${secsLeft(q.expires_time)}s</span></button></div>`;
    }
    if (state.phase === 'expired') return '<div class="combo-quote" data-testid="quote-state">Quote expired · fetching a new one…</div>';
    if (state.phase === 'accepting' || state.phase === 'confirming') return `<div class="combo-quote"><button class="cta" disabled data-testid="quote-state">${state.phase === 'accepting' ? 'Accepting…' : 'Confirming…'}</button></div>`;
    if (state.phase === 'executed' && state.executed) return `<div class="combo-quote done" data-testid="quote-executed">Executed: ${qty(state.executed.executed_contracts_fp)} contracts at ${cents(state.executed.buy_yes_price_dollars)}¢ · <a href="${esc(state.executed.link)}" data-link data-testid="combo-link">View combo</a></div>`;
    return '';
  }

  function drawSlip() {
    const n = state.legs.length;
    const odds = n ? combined() : null;
    const amt = Number(state.amount);
    const amountOk = Number.isFinite(amt) && amt >= 1 && Math.abs(Math.round(amt * 100) - amt * 100) < 1e-6;
    const busy = ['requesting', 'accepting', 'confirming'].includes(state.phase);
    $('[data-testid=combo-slip]').innerHTML = `<div class="combo-mini-head"><h2>Combo slip</h2><span class="faint" data-testid="slip-count">${n}/${MAX_LEGS} legs</span></div>
      ${n ? state.legs.map((l) => { const x = marketBy.get(l.market_ticker); return `<div class="combo-leg-row" data-testid="slip-leg" data-leg="${esc(l.market_ticker)}"><span class="combo-leg-name"><b class="${l.side === 'yes' ? 'leg-yes' : 'leg-no'}">${l.side.toUpperCase()}</b> ${esc(x.m.yes_sub_title)}<span class="faint">${esc(x.e.title)}</span></span><span class="num">${Math.round(legProb(l))}%</span><button class="icon-btn sm" data-remove-leg="${esc(l.market_ticker)}" aria-label="Remove leg">×</button></div>`; }).join('')
        : '<p class="faint">Pick Yes or No on at least two outcomes from different events.</p>'}
      ${n ? `<div class="tkt-row"><span>Combined odds</span><strong data-testid="slip-odds">${odds.toFixed(odds < 10 ? 2 : 1)}%</strong></div><div class="tkt-row"><span>Payout</span><strong>${odds > 0 ? (100 / odds).toFixed(2) : '—'}x</strong></div>` : ''}
      <label class="tkt-input">Amount ($)<input id="combo-amount" type="number" min="1" step="0.01" value="${esc(state.amount)}" inputmode="decimal" aria-label="Amount in dollars"></label>
      <div class="form-error" id="combo-error" role="alert">${n && n < 2 ? 'Add at least one more leg.' : !amountOk && state.amount !== '' ? 'Enter at least $1.00 (cents allowed).' : ''}</div>
      <button class="cta" data-testid="request-quote" id="request-quote" ${n >= 2 && amountOk && !busy ? '' : 'disabled'}>${session.user ? 'Request quote' : 'Sign up to request a quote'}</button>
      <div id="combo-quote-box">${quoteBox()}</div>
      ${n ? '<button class="btn btn-ghost" id="clear-slip" data-testid="clear-slip" style="width:100%;margin-top:8px">Clear slip</button>' : ''}`;
    const amountEl = $('#combo-amount');
    amountEl.oninput = () => { state.amount = amountEl.value; resetQuote(); drawSlipSoon(); };
    amountEl.onchange = () => persist();
    for (const b of el.querySelectorAll('[data-remove-leg]')) b.onclick = () => { const l = state.legs.find((x) => x.market_ticker === b.dataset.removeLeg); toggle(l.market_ticker, l.side); };
    const clear = $('#clear-slip');
    if (clear) clear.onclick = async () => { state.legs = []; resetQuote(); drawEvents(); drawSlip(); if (session.user) await api.clearComboSlip(session.uid).catch(() => {}); };
    $('#request-quote').onclick = requestQuote;
    const acc = $('#accept-quote');
    if (acc) acc.onclick = accept;
  }
  let slipT = null;
  // Re-render after typing without stealing focus from the amount field.
  function drawSlipSoon() {
    clearTimeout(slipT);
    slipT = setTimeout(() => { const pos = $('#combo-amount')?.selectionStart; drawSlip(); const a = $('#combo-amount'); a.focus(); try { a.setSelectionRange(pos, pos); } catch { /* number inputs */ } }, 250);
  }

  async function requestQuote() {
    if (!session.user) return navigate('/sign-up?next=/combos');
    state.phase = 'requesting'; state.quote = null; drawSlip();
    try {
      await persist();
      const c = await api.createCombo(state.legs.map(({ market_ticker, event_ticker, side }) => ({ market_ticker, event_ticker, side })));
      const r = await api.createRfq({ market_ticker: c.market_ticker, target_cost_dollars: Number(Number(state.amount).toFixed(2)), replace_existing: true });
      state.rfq = r.rfq; state.phase = 'waiting';
      drawSlip();
      await poll();
    } catch (e) { state.phase = 'idle'; drawSlip(); $('#combo-error').textContent = e.message; }
  }

  async function accept() {
    const q = state.quote;
    state.phase = 'accepting'; drawSlip();
    try {
      await api.acceptQuote(state.rfq.id, q.id, 'no'); // accepting the NO bid = buying YES on the combo
      state.phase = 'confirming'; drawSlip();
      await poll();
    } catch (e) { state.phase = 'quoted'; drawSlip(); $('#combo-error').textContent = e.message; }
  }

  // Derive the phase from the persisted RFQ + quotes (WS events and a 1 s timer both call this).
  async function poll() {
    if (!state.rfq) return;
    let r;
    try { r = (await api.rfq(state.rfq.id)).rfq; } catch { return; }
    if (!state.rfq || r.id !== state.rfq.id) return;
    const done = r.quotes.find((q) => q.status === 'executed');
    const pending = r.quotes.find((q) => ['accepted', 'confirmed'].includes(q.status));
    const open = r.quotes.find((q) => q.status === 'open' && Date.parse(q.expires_time) > Date.now());
    const prev = state.phase;
    const prevQ = state.quote && state.quote.id;
    if (done) {
      state.phase = 'executed'; state.executed = done; state.rfq = null;
      if (prev !== 'executed') {
        toast(`Combo executed: ${qty(done.executed_contracts_fp)} contracts`);
        state.legs = []; drawEvents();
        if (session.user) api.clearComboSlip(session.uid).catch(() => {});
      }
    } else if (pending) state.phase = 'confirming';
    else if (open) { state.phase = 'quoted'; state.quote = open; } else if (['cancelled', 'expired'].includes(r.status)) { state.phase = 'idle'; state.rfq = null; $('#combo-error') && ($('#combo-error').textContent = 'The request closed. Request a new quote.'); } else state.phase = r.quotes.length ? 'expired' : 'waiting';
    if (prev !== state.phase || (state.quote && state.quote.id) !== prevQ) drawSlip();
  }

  drawEvents(); drawSlip();
  const unsub = session.user ? socket.subscribe({ channels: ['communications'] }, (m) => { if (state.rfq && m.msg && m.msg.rfq_id === state.rfq.id) poll(); }) : () => {};
  const iv = setInterval(() => {
    for (const c of el.querySelectorAll('[data-countdown]')) c.textContent = `${secsLeft(c.dataset.countdown)}s`;
    if (state.rfq) poll();
  }, 1000);
  return () => { unsub(); clearInterval(iv); clearTimeout(slipT); };
}
