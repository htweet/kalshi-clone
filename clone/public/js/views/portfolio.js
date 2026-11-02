// Portfolio (spec §4.6): balance, funds, positions, resting orders, fills, settlements, CSV export.
import { api } from '../api.js';
import { session } from '../store.js';
import { socket } from '../ws.js';
import { esc, money, qty, cents, toast, relTime, secsLeft } from '../lib.js';
import { renderPerpsPortfolio } from './perps.js';

const TABS = [['positions', 'Positions'], ['orders', 'Resting orders'], ['combos', 'Combos'], ['rfqs', 'RFQs'], ['quotes', 'Quotes'], ['fills', 'Trade history'], ['settlements', 'Settlements'], ['transactions', 'Transactions']];
const QSTATUS = { open: 'Open', accepted: 'Accepted', confirmed: 'Confirmed', executed: 'Executed', expired: 'Expired', cancelled: 'Cancelled' };
const sizeLabel = (x) => (x.contracts_fp != null ? `${qty(x.contracts_fp)} contracts` : `${money(x.target_cost_dollars)} target`);
const legChips = (legs) => `<div class="leg-chips">${legs.map((l) => `<span class="leg-chip ${l.leg_status}" data-leg-status="${l.leg_status}"><b class="${l.side === 'yes' ? 'leg-yes' : 'leg-no'}">${l.side.toUpperCase()}</b> ${esc(l.outcome)}</span>`).join('')}</div>`;

export async function render({ el, navigate, query }) {
  if (query && query.get('perpsTab')) return renderPerpsPortfolio({ el, navigate, query }); // Perps product (PERPS_SPEC_SECTION.md)
  if (!session.user) { navigate('/sign-in?next=/portfolio', { replace: true }); return undefined; }
  document.title = 'Portfolio · Parlance';
  const deep = query && query.get('tab');
  let tab = TABS.some(([k]) => k === deep) ? deep : TABS.some(([k]) => k === session.props.portfolio_view) ? session.props.portfolio_view : 'positions';
  if (deep && deep === tab && deep !== session.props.portfolio_view) session.setProp('portfolio_view', tab).catch(() => {});
  let rfqScope = 'mine';
  const uid = session.uid;

  el.innerHTML = `<div class="page-head"><h1 class="typ-title-x10">Portfolio</h1></div>
    <div class="stat-row">
      <div class="card stat"><div class="label">Cash available</div><div class="value" id="s-cash" data-testid="cash">—</div></div>
      <div class="card stat"><div class="label">Positions value</div><div class="value" id="s-value" data-testid="positions-value">—</div></div>
      <div class="card stat"><div class="label">Held for open orders</div><div class="value" id="s-reserved" data-testid="reserved">—</div></div>
      <form class="card stat" id="funds" aria-label="Move funds">
        <div class="label">Simulated funds</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px"><input id="f-amount" type="number" min="0.01" step="0.01" placeholder="Amount $" aria-label="Amount in dollars" style="flex:1 1 90px;min-width:0;padding:7px 10px;border-radius:10px;border:1px solid var(--line);background:var(--surface-x10)">
          <button class="btn btn-primary" data-act="deposit" type="submit">Deposit</button><button class="btn" data-act="withdraw" type="button">Withdraw</button></div>
        <div class="form-error" id="f-error" role="alert"></div>
      </form>
    </div>
    <div class="tabs" role="tablist">${TABS.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}
      <a class="btn btn-ghost" style="margin-left:auto" href="/portfolio?perpsTab=positions" data-link data-testid="perps-portfolio-link">Perps</a><a class="btn btn-ghost" href="${api.csvUrl(uid)}" download data-testid="csv-link">Export CSV</a></div>
    <div class="card" style="padding:4px 12px" id="panel"></div>`;

  const $ = (s) => el.querySelector(s);
  async function drawStats() {
    const b = await api.balance(uid);
    $('#s-cash').textContent = money(b.balance_dollars);
    $('#s-value').textContent = money(b.portfolio_value_dollars);
    $('#s-reserved').textContent = money(b.reserved_dollars);
  }

  async function drawPanel() {
    const p = $('#panel');
    if (tab === 'positions') {
      const { positions } = await api.positions(uid);
      const open = positions.filter((x) => x.side);
      p.innerHTML = open.length ? `<table class="table" data-testid="positions-table"><thead><tr><th>Market</th><th>Side</th><th class="num">Contracts</th><th class="num">Avg price</th><th class="num">Cost</th><th class="num">Value</th><th class="num">Unrealized</th><th></th></tr></thead><tbody>
        ${open.map((x) => `<tr data-ticker="${esc(x.ticker)}"><td>${esc(x.market_title)}</td><td><strong style="color:var(--${x.side === 'yes' ? 'yes' : 'no'})">${x.side.toUpperCase()}</strong></td><td class="num">${qty(x.position_fp)}</td><td class="num">${cents(x.avg_price_dollars)}¢</td><td class="num">${money(x.total_cost_dollars)}</td><td class="num">${money(x.market_value_dollars)}</td><td class="num">${money(x.unrealized_pnl_dollars)}</td>
        <td>${x.market_status === 'active' ? `<button class="btn" data-close="${esc(x.ticker)}" data-side="${x.side === 'yes' ? 'no' : 'yes'}" data-count="${Number(x.position_fp)}">Close</button>` : `<span class="faint">${esc(x.market_status)}</span>`}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty" data-testid="no-positions">No open positions. <a href="/browse" data-link>Find a market</a></div>';
      for (const b of p.querySelectorAll('[data-close]')) {
        b.onclick = async () => {
          // Closing = buying the opposite side; netting returns $1 per pair (spec §4.3 book semantics).
          b.disabled = true;
          try { const r = await api.submitOrder(uid, { ticker: b.dataset.close, side: b.dataset.side, count: Number(b.dataset.count), type: 'market' }); toast(`Closed ${qty(r.order.fill_count_fp)} contracts`); }
          catch (e) { toast(e.message, 'error'); }
          refresh();
        };
      }
    } else if (tab === 'orders') {
      const { orders } = await api.orders(uid, 'resting');
      p.innerHTML = orders.length ? `<table class="table" data-testid="orders-table"><thead><tr><th>Market</th><th>Side</th><th class="num">Limit</th><th class="num">Filled</th><th class="num">Open</th><th>Placed</th><th></th></tr></thead><tbody>
        ${orders.map((o) => `<tr data-order="${esc(o.order_id)}"><td>${esc(o.market_title)}</td><td>${o.side.toUpperCase()}</td><td class="num">${cents(o.price_dollars)}¢</td><td class="num">${qty(o.fill_count_fp)}</td><td class="num">${qty(o.remaining_count_fp)}</td><td>${new Date(o.created_time).toLocaleString()}</td><td><button class="btn" data-cancel="${esc(o.order_id)}">Cancel</button></td></tr>`).join('')}</tbody></table>`
        : '<div class="empty" data-testid="no-orders">No resting orders.</div>';
      for (const b of p.querySelectorAll('[data-cancel]')) {
        b.onclick = async () => { b.disabled = true; try { await api.cancelOrder(uid, b.dataset.cancel); toast('Order canceled'); } catch (e) { toast(e.message, 'error'); } refresh(); };
      }
    } else if (tab === 'combos') {
      const r = await api.myCombos(uid);
      p.innerHTML = `<div class="pf-sub"><strong>Open combos · <span data-testid="open-combo-count">${r.total_open_combos}</span></strong><a class="btn btn-ghost" href="/combos" data-link>Build a combo</a></div>
        ${r.open_combos.length ? `<table class="table" data-testid="combos-table"><thead><tr><th>Combo</th><th>Side</th><th class="num">Contracts</th><th class="num">Cost</th><th>Status</th></tr></thead><tbody>
        ${r.open_combos.map((c) => `<tr data-combo="${esc(c.market_ticker)}"><td><a href="${esc(c.link)}" data-link>${esc(c.title)}</a>${legChips(c.legs)}</td><td>${c.side.toUpperCase()}</td><td class="num">${qty(c.position_fp)}</td><td class="num">${money(c.cost_dollars)}</td><td>${esc(c.status)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty" data-testid="no-combos">No open combos.</div>'}
        ${r.settled_combos.length ? `<div class="pf-sub"><strong>Settled combos</strong></div><table class="table" data-testid="settled-combos"><thead><tr><th>Combo</th><th>Result</th><th class="num">Cost</th><th class="num">Payout</th></tr></thead><tbody>
        ${r.settled_combos.map((c) => `<tr><td><a href="${esc(c.link)}" data-link>${esc(c.title)}</a>${legChips(c.legs)}</td><td>${c.result.toUpperCase()}</td><td class="num">${money(c.cost_dollars)}</td><td class="num">${money(c.payout_dollars)}</td></tr>`).join('')}</tbody></table>` : ''}`;
    } else if (tab === 'rfqs') {
      await drawRfqs(p);
    } else if (tab === 'quotes') {
      await drawQuotes(p);
    } else if (tab === 'fills') {
      const { fills } = await api.fills(uid);
      p.innerHTML = fills.length ? `<table class="table" data-testid="fills-table"><thead><tr><th>Time</th><th>Market</th><th>Side</th><th class="num">Price</th><th class="num">Contracts</th><th class="num">Fee</th><th>Role</th></tr></thead><tbody>
        ${fills.map((f) => `<tr><td>${new Date(f.created_time).toLocaleString()}</td><td>${esc(f.ticker)}</td><td>${f.side.toUpperCase()}</td><td class="num">${cents(f.price_dollars)}¢</td><td class="num">${qty(f.count_fp)}</td><td class="num">${money(f.fee_dollars)}</td><td>${f.is_taker ? 'Taker' : 'Maker'}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">No trades yet.</div>';
    } else if (tab === 'settlements') {
      const { settlements } = await api.settlements(uid);
      p.innerHTML = settlements.length ? `<table class="table" data-testid="settlements-table"><thead><tr><th>Settled</th><th>Market</th><th>Result</th><th class="num">Yes</th><th class="num">No</th><th class="num">Cost</th><th class="num">Payout</th></tr></thead><tbody>
        ${settlements.map((s) => `<tr><td>${new Date(s.settled_time).toLocaleString()}</td><td>${esc(s.market_title)}</td><td>${s.market_result.toUpperCase()}</td><td class="num">${qty(s.yes_count_fp)}</td><td class="num">${qty(s.no_count_fp)}</td><td class="num">${money(s.cost_dollars)}</td><td class="num">${money(s.revenue_dollars)}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">No settled markets yet.</div>';
    } else {
      const { transactions } = await api.transactions(uid);
      p.innerHTML = transactions.length ? `<table class="table" data-testid="transactions-table"><thead><tr><th>Time</th><th>Type</th><th>Memo</th><th class="num">Amount</th></tr></thead><tbody>
        ${transactions.map((t) => `<tr><td>${new Date(t.created_time).toLocaleString()}</td><td>${esc(t.kind)}</td><td>${esc(t.memo)}</td><td class="num">${money(t.amount_dollars)}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">No transactions yet.</div>';
    }
  }

  // ---------- RFQs (spec §17.6): yours vs other traders' ----------
  const countdown = (iso, prefix = '') => `<span class="countdown" data-countdown="${esc(iso)}" data-prefix="${esc(prefix)}">${prefix}${secsLeft(iso)}s</span>`;
  async function drawRfqs(p) {
    const r = await api.rfqs(rfqScope);
    const enabled = !!r.rfq_enabled;
    const head = `<div class="pf-sub rfq-head"><div class="seg" role="tablist" aria-label="RFQ scope"><button data-rfq-scope="mine" class="${rfqScope === 'mine' ? 'on' : ''}">Yours</button><button data-rfq-scope="others" class="${rfqScope === 'others' ? 'on' : ''}" data-testid="rfq-others">Other RFQs</button></div>
      <label class="book-setting"><input type="checkbox" data-testid="rfq-enabled" id="rfq-enabled" ${enabled ? 'checked' : ''}> Answer RFQs from other traders</label></div>`;
    if (rfqScope === 'mine') {
      p.innerHTML = head + (r.rfqs.length ? `<table class="table" data-testid="rfqs-table"><thead><tr><th>Market</th><th>Size</th><th>Status</th><th>Age</th><th>Quotes</th><th></th></tr></thead><tbody>
        ${r.rfqs.map((x) => {
          const open = x.quotes.filter((q) => q.status === 'open');
          const pending = x.quotes.find((q) => ['accepted', 'confirmed'].includes(q.status));
          const done = x.quotes.find((q) => q.status === 'executed');
          const quotes = x.status === 'open' ? open.map((q) => `<div class="rfq-quote" data-quote="${esc(q.id)}">${q.buy_yes_price_dollars ? `<button class="btn btn-sm yes-pill" data-accept="${esc(q.id)}" data-rfq-id="${esc(x.id)}" data-side="no">Buy YES ${cents(q.buy_yes_price_dollars)}¢ · ${qty(q.no_contracts_fp)}</button>` : ''}
              ${q.buy_no_price_dollars ? `<button class="btn btn-sm no-pill" data-accept="${esc(q.id)}" data-rfq-id="${esc(x.id)}" data-side="yes">Buy NO ${cents(q.buy_no_price_dollars)}¢ · ${qty(q.yes_contracts_fp)}</button>` : ''}
              <span class="faint">${q.is_system_maker ? 'Parlance maker' : 'Trader'} · ${countdown(q.expires_time)}</span></div>`).join('') || '<span class="faint">Waiting for quotes…</span>'
            : pending ? `<span data-testid="awaiting-confirm">Accepted · ${pending.status === 'confirmed' ? 'Confirming…' : `waiting for maker ${countdown(pending.confirm_deadline_time)}`}</span>`
              : done ? `<span>Executed ${qty(done.executed_contracts_fp)} contracts</span>` : '<span class="faint">—</span>';
          return `<tr data-rfq="${esc(x.id)}" data-status="${esc(x.status)}"><td><a href="${esc(x.link)}" data-link>${esc(x.market_title)}</a></td><td>${sizeLabel(x)}</td><td><span class="status-chip ${esc(x.status)}">${QSTATUS[x.status] || esc(x.status)}</span></td><td class="faint">${relTime(x.created_time)}</td><td>${quotes}</td>
            <td>${['open', 'accepted'].includes(x.status) ? `<button class="btn btn-sm" data-cancel-rfq="${esc(x.id)}">Cancel</button>` : ''}</td></tr>`;
        }).join('')}</tbody></table>` : '<div class="empty" data-testid="no-rfqs">No RFQs yet. Request a quote from a market ticket (Request quote) or the <a href="/combos" data-link>combo builder</a>.</div>');
    } else if (!enabled) {
      p.innerHTML = head + '<div class="empty" data-testid="rfq-disabled">Turn on “Answer RFQs from other traders” to see and quote other traders\' requests.</div>';
    } else {
      p.innerHTML = head + (r.rfqs.length ? `<table class="table" data-testid="other-rfqs-table"><thead><tr><th>Market</th><th>Size</th><th>Age</th><th>Your quote</th><th>Quote (¢)</th></tr></thead><tbody>
        ${r.rfqs.map((x) => `<tr data-rfq="${esc(x.id)}" data-status="${esc(x.status)}"><td><a href="${esc(x.link)}" data-link>${esc(x.market_title)}</a></td><td>${sizeLabel(x)}</td><td class="faint">${relTime(x.created_time)}</td>
          <td>${x.my_quote ? `<span class="status-chip ${esc(x.my_quote.status)}" data-testid="my-quote-status">${QSTATUS[x.my_quote.status]}</span> <span class="faint">Yes ${cents(x.my_quote.yes_bid_dollars)}¢ / No ${cents(x.my_quote.no_bid_dollars)}¢</span>` : '<span class="faint">—</span>'}</td>
          <td>${x.status === 'open' ? `<form class="quote-form" data-quote-form="${esc(x.id)}"><input name="yes" type="number" min="0" max="99" step="1" placeholder="Yes bid" aria-label="Yes bid in cents"><input name="no" type="number" min="0" max="99" step="1" placeholder="No bid" aria-label="No bid in cents"><button class="btn btn-sm btn-primary" type="submit">Send quote</button><div class="form-error" role="alert"></div></form>` : '<span class="faint">Accepted by requester</span>'}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty" data-testid="no-other-rfqs">No open RFQs from other traders right now.</div>');
    }
    for (const b of p.querySelectorAll('[data-rfq-scope]')) b.onclick = () => { rfqScope = b.dataset.rfqScope; drawPanel(); };
    p.querySelector('#rfq-enabled').onchange = async (e) => { await session.setProp('rfq_enabled', e.target.checked).catch((x) => toast(x.message, 'error')); drawPanel(); };
    for (const b of p.querySelectorAll('[data-accept]')) {
      b.onclick = async () => {
        b.disabled = true;
        try { await api.acceptQuote(b.dataset.rfqId, b.dataset.accept, b.dataset.side); toast('Quote accepted · waiting for the maker to confirm'); } catch (e) { toast(e.message, 'error'); }
        drawPanel();
      };
    }
    for (const b of p.querySelectorAll('[data-cancel-rfq]')) b.onclick = async () => { b.disabled = true; try { await api.cancelRfq(b.dataset.cancelRfq); toast('RFQ cancelled'); } catch (e) { toast(e.message, 'error'); } drawPanel(); };
    for (const f of p.querySelectorAll('[data-quote-form]')) {
      f.onsubmit = async (e) => {
        e.preventDefault();
        const err = f.querySelector('.form-error');
        err.textContent = '';
        const y = f.yes.value === '' ? 0 : Number(f.yes.value); const n = f.no.value === '' ? 0 : Number(f.no.value);
        if (![y, n].every((v) => Number.isInteger(v) && v >= 0 && v <= 99)) { err.textContent = 'Bids are whole cents from 0 to 99.'; return; }
        if (!y && !n) { err.textContent = 'Quote at least one side.'; return; }
        if (y + n > 100) { err.textContent = 'Yes bid + No bid cannot exceed 100¢.'; return; }
        try { await api.createQuote({ rfq_id: f.dataset.quoteForm, yes_bid: (y / 100).toFixed(2), no_bid: (n / 100).toFixed(2) }); toast('Quote sent'); drawPanel(); } catch (ex) { err.textContent = ex.message; }
      };
    }
  }
  // ---------- Quotes: ones you made and ones on your RFQs ----------
  async function drawQuotes(p) {
    const { quotes } = await api.quotes();
    p.innerHTML = quotes.length ? `<table class="table" data-testid="quotes-table"><thead><tr><th>Role</th><th>Market</th><th class="num">Yes bid</th><th class="num">No bid</th><th>Size</th><th>Status</th><th></th></tr></thead><tbody>
      ${quotes.map((q) => {
        const mine = q.role === 'maker';
        const action = mine && q.status === 'accepted' ? `<button class="btn btn-sm btn-primary" data-confirm="${esc(q.id)}">Confirm order · ${countdown(q.confirm_deadline_time)}</button>`
          : mine && q.status === 'open' ? `<button class="btn btn-sm" data-delete-quote="${esc(q.id)}">Delete</button> <span class="faint">${countdown(q.expires_time)}</span>`
            : q.status === 'executed' ? `<span class="faint">${qty(q.executed_contracts_fp)} contracts</span>` : '';
        const size = q.rfq_contracts_fp != null ? `${qty(q.rfq_contracts_fp)} contracts` : `${money(q.rfq_target_cost_dollars)} target`;
        return `<tr data-quote-row="${esc(q.id)}" data-status="${esc(q.status)}"><td>${mine ? 'You quoted' : 'On your RFQ'}</td><td><a href="${esc(q.link)}" data-link>${esc(q.market_title)}</a></td><td class="num">${cents(q.yes_bid_dollars)}¢</td><td class="num">${cents(q.no_bid_dollars)}¢</td><td>${size}</td>
          <td><span class="status-chip ${esc(q.status)}">${QSTATUS[q.status]}</span>${q.accepted_side ? ` <span class="faint">(${q.accepted_side.toUpperCase()} side)</span>` : ''}</td><td>${action}</td></tr>`;
      }).join('')}</tbody></table>` : '<div class="empty" data-testid="no-quotes">No quotes yet.</div>';
    for (const b of p.querySelectorAll('[data-confirm]')) {
      b.onclick = async () => {
        b.disabled = true; b.textContent = 'Confirming…';
        try { await api.confirmQuote(b.dataset.confirm); toast('Quote executed'); } catch (e) { toast(e.message, 'error'); }
        drawPanel(); drawStats();
      };
    }
    for (const b of p.querySelectorAll('[data-delete-quote]')) b.onclick = async () => { b.disabled = true; try { await api.deleteQuote(b.dataset.deleteQuote); toast('Quote deleted'); } catch (e) { toast(e.message, 'error'); } drawPanel(); };
  }

  async function refresh() { await Promise.all([drawStats(), drawPanel()]); }

  for (const b of el.querySelectorAll('[data-tab]')) {
    b.onclick = () => {
      tab = b.dataset.tab;
      for (const x of el.querySelectorAll('[data-tab]')) x.classList.toggle('on', x === b);
      session.setProp('portfolio_view', tab).catch(() => {});
      drawPanel();
    };
  }
  const move = async (act) => {
    const err = $('#f-error');
    err.textContent = '';
    const amt = Number($('#f-amount').value);
    if (!(amt > 0)) { err.textContent = 'Enter an amount greater than $0.'; return; }
    try {
      await (act === 'deposit' ? api.deposit(uid, amt) : api.withdraw(uid, amt));
      toast(`${act === 'deposit' ? 'Deposited' : 'Withdrew'} ${money(amt)}`);
      $('#f-amount').value = '';
      refresh();
    } catch (e) { err.textContent = e.message; }
  };
  $('#funds').onsubmit = (e) => { e.preventDefault(); move('deposit'); };
  el.querySelector('[data-act="withdraw"]').onclick = () => move('withdraw');

  await refresh();
  let commsT = null;
  const unsubs = [
    socket.subscribe({ channels: ['user_orders'] }, () => refresh().catch(() => {})),
    socket.subscribe({ channels: ['user_balance'] }, () => refresh().catch(() => {})),
    // RFQ / quote events update the RFQs, Quotes and Combos tabs live (spec §17.6).
    socket.subscribe({ channels: ['communications'] }, () => {
      if (!['rfqs', 'quotes', 'combos'].includes(tab)) return;
      if (el.querySelector('#panel input:focus')) return; // don't wipe a quote being typed
      clearTimeout(commsT); commsT = setTimeout(() => drawPanel().catch(() => {}), 120);
    }),
  ];
  // Countdowns tick locally; an expired countdown triggers a refetch (the server sweep owns the status).
  const iv = setInterval(() => {
    let due = false;
    for (const c of el.querySelectorAll('[data-countdown]')) { const n = secsLeft(c.dataset.countdown); c.textContent = `${c.dataset.prefix || ''}${n}s`; if (n === 0) due = true; }
    if (due) { clearTimeout(commsT); commsT = setTimeout(() => drawPanel().catch(() => {}), 900); }
  }, 1000);
  return () => { unsubs.forEach((u) => u()); clearInterval(iv); clearTimeout(commsT); };
}
