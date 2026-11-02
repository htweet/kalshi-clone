// Portfolio (spec §4.6): balance, funds, positions, resting orders, fills, settlements, CSV export.
import { api } from '../api.js';
import { session } from '../store.js';
import { socket } from '../ws.js';
import { esc, money, qty, cents, toast } from '../lib.js';

const TABS = [['positions', 'Positions'], ['orders', 'Resting orders'], ['fills', 'Trade history'], ['settlements', 'Settlements'], ['transactions', 'Transactions']];

export async function render({ el, navigate }) {
  if (!session.user) { navigate('/sign-in?next=/portfolio', { replace: true }); return undefined; }
  document.title = 'Portfolio · Parlance';
  let tab = session.props.portfolio_view || 'positions';
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
      <a class="btn btn-ghost" style="margin-left:auto" href="${api.csvUrl(uid)}" download data-testid="csv-link">Export CSV</a></div>
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
  const unsubs = [
    socket.subscribe({ channels: ['user_orders'] }, () => refresh().catch(() => {})),
    socket.subscribe({ channels: ['user_balance'] }, () => refresh().catch(() => {})),
  ];
  return () => unsubs.forEach((u) => u());
}
