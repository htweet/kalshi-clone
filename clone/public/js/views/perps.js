// Perps (PERPS_SPEC_SECTION.md): market list (/perps, /perps/categories/:assetClass), market page (/perps/:ticker)
// and the Perps portfolio (/portfolio?perpsTab=positions|orders|history, also /portfolio/perps).
// Prices travel per contract in dollars (4 dp); the UI shows the underlying level = contract price / contract size.
import { perpsApi as P } from '../perps-api.js';
import { session } from '../store.js';
import { socket } from '../ws.js';
import { esc, money, toast } from '../lib.js';

const ASSET_ORDER = ['Crypto', 'Equities', 'Metals', 'FX', 'Energy', 'Indices', 'Rates', 'Compute', 'GPU', 'EventContracts'];
const RANGES = { '1H': { period: 1, span: 3600 }, '1D': { period: 15, span: 86400 }, '1W': { period: 60, span: 7 * 86400 } };
const PERPS_TABS = [['positions', 'Positions'], ['orders', 'Open orders'], ['history', 'History']];

// ---------------------------------------------------------------- formatting
const n = (s) => Number(s ?? 0);
const dec = (m) => m.product_metadata?.decimal_count ?? 2;
const under = (m, contractDollars) => n(contractDollars) / n(m.contract_size);
function fmtLevel(m, v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = v.toLocaleString('en-US', { minimumFractionDigits: dec(m), maximumFractionDigits: dec(m) });
  return m.product_metadata?.unit === 'pct' ? `${s}%` : `$${s}`;
}
const fmtPx = (m, contractDollars) => (contractDollars == null ? '—' : fmtLevel(m, under(m, contractDollars)));
const toContract = (m, level) => (Number(level) * n(m.contract_size)).toFixed(4);
const signedUsd = (v, d = 2) => `${v > 0 ? '+' : v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const signedPct = (v, d = 2) => `${v > 0 ? '+' : ''}${v.toFixed(d)}%`;
const fundingPct = (r) => `${(n(r) * 100).toFixed(4)}%`;
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const compactUsd = (v) => `$${n(v).toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 })}`;
const lev = (x) => (x == null ? '—' : `${Number.isInteger(x) ? x : Number(x).toFixed(1)}x`);
const time = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateTime = (iso) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const icon = (m) => `<span class="perps-ico" style="--perps-accent:${esc(m.product_metadata?.color || 'var(--brand)')}" aria-hidden="true">${esc(m.title[0])}</span>`;
function countdown(ms) {
  const s = Math.max(0, Math.floor((ms - Date.now()) / 1000));
  const h = Math.floor(s / 3600); const mi = Math.floor((s % 3600) / 60); const se = s % 60;
  return `${h ? `${h}h ` : ''}${String(mi).padStart(2, '0')}m ${String(se).padStart(2, '0')}s`;
}
function debounce(fn, ms = 150) {
  let t = null;
  const d = () => { clearTimeout(t); t = setTimeout(() => { fn().catch(() => {}); }, ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export async function render(ctx) {
  if (ctx.params.mode === 'portfolio') return renderPerpsPortfolio(ctx);
  if (ctx.params.mode === 'market') return renderMarket(ctx);
  return renderList(ctx);
}

// ================================================================ list
async function renderList({ el, params }) {
  document.title = 'Perps · Parlance';
  const [{ markets }, { asset_classes: classes }] = await Promise.all([P.markets(), P.assetClasses()]);
  const want = params.assetClass ? classes.find((c) => c.slug === String(params.assetClass).toLowerCase()) : null;
  if (params.assetClass && !want) {
    el.innerHTML = '<div class="card empty" data-testid="page-error"><h1 class="typ-title-x20">Unknown category</h1><a class="btn" href="/perps" data-link>All perps</a></div>';
    return undefined;
  }
  const shown = markets.filter((m) => !want || m.asset_class === want.name).sort((a, b) => ASSET_ORDER.indexOf(a.asset_class) - ASSET_ORDER.indexOf(b.asset_class));
  el.innerHTML = `<div class="perps" data-testid="perps-list">
    <div class="perps-hero"><h1 class="typ-title-x10">Perps</h1>
      <p class="muted">Perpetual futures on simulated indices. Go long or short with leverage, no expiry. Funding payments keep each contract near its index.</p></div>
    <nav class="perps-chips" aria-label="Asset classes" data-testid="perps-chips">
      <a href="/perps" data-link class="${want ? '' : 'on'}" data-class="all">All <span>${markets.length}</span></a>
      ${classes.map((c) => `<a href="/perps/categories/${esc(c.slug)}" data-link class="${want && want.slug === c.slug ? 'on' : ''}" data-class="${esc(c.name)}">${esc(c.name)} <span>${c.count}</span></a>`).join('')}
    </nav>
    <div class="perps-table-wrap card"><table class="perps-table" data-testid="perps-table">
      <thead><tr><th>Market</th><th class="num">Price</th><th class="num">24h</th><th class="num perps-hide-sm">Funding</th><th class="num perps-hide-sm">Max leverage</th><th class="num perps-hide-md">24h volume</th></tr></thead>
      <tbody>${shown.map(rowHtml).join('')}</tbody></table></div>
  </div>`;
  const byT = new Map(shown.map((m) => [m.ticker, m]));
  const root = el.firstElementChild;
  el.querySelector('tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-ticker]');
    if (tr && !e.target.closest('a')) tr.querySelector('a').click();
  });
  const unsub = socket.subscribe({ channels: ['perp_ticker'] }, (msg) => {
    if (msg.type !== 'perp_ticker') return;
    const m = byT.get(msg.msg.market_ticker);
    const tr = m && root.isConnected && el.querySelector(`tr[data-ticker="${m.ticker}"]`);
    if (!tr) return;
    Object.assign(m, msg.msg);
    tr.outerHTML = rowHtml(m);
  });
  return unsub;
}
function rowHtml(m) {
  const chg = n(m.price_change_24h_pct);
  return `<tr data-ticker="${esc(m.ticker)}" data-testid="perp-row" data-class="${esc(m.asset_class)}">
    <td><a class="perps-mkt" href="/perps/${esc(m.ticker)}" data-link>${icon(m)}<span><strong>${esc(m.title)}</strong><span class="faint">${esc(m.product_metadata?.asset_name || '')}</span></span></a></td>
    <td class="num" data-f="price">${fmtPx(m, m.mark_price)}</td>
    <td class="num perps-chg ${cls(chg)}" data-f="chg">${signedPct(chg)}</td>
    <td class="num perps-hide-sm" data-f="funding">${fundingPct(m.funding_rate?.rate)}</td>
    <td class="num perps-hide-sm">${lev(m.max_leverage)}</td>
    <td class="num perps-hide-md">${compactUsd(m.volume_24h_notional_value_dollars)}</td></tr>`;
}

// ================================================================ shared: transfer box
function transferBox() {
  return `<section class="card perps-box perps-transfer" data-testid="perp-transfer">
    <h3 class="perps-box-title">Transfer funds</h3>
    <div class="perps-kv"><span>Predictions cash</span><strong data-testid="pred-cash">${session.balance != null ? money(session.balance) : '—'}</strong></div>
    <div class="perps-kv"><span>Perps available</span><strong data-testid="perps-available">—</strong></div>
    <form class="perps-xfer" data-testid="perp-transfer-form">
      <input id="px-amount" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="Amount $" aria-label="Transfer amount in dollars" data-testid="xfer-amount">
      <div class="perps-xfer-btns"><button class="btn btn-primary" type="submit" data-dir="to_perps" data-testid="xfer-to-perps">To Perps</button><button class="btn" type="button" data-dir="to_predictions" data-testid="xfer-to-predictions">To Predictions</button></div>
      <div class="form-error" role="alert" data-testid="xfer-error"></div>
    </form></section>`;
}
function wireTransfer(root, onDone) {
  const form = root.querySelector('[data-testid=perp-transfer-form]');
  if (!form) return () => {};
  const go = async (dir) => {
    const err = form.querySelector('[data-testid=xfer-error]');
    err.textContent = '';
    const amt = Number(form.querySelector('#px-amount').value);
    if (!(amt > 0)) { err.textContent = 'Enter an amount greater than $0.'; return; }
    try {
      await P.transfer(dir, amt);
      form.querySelector('#px-amount').value = '';
      toast(`Moved ${money(amt)} ${dir === 'to_perps' ? 'to Perps' : 'to Predictions'}`);
      await onDone();
    } catch (e) { err.textContent = e.message; }
  };
  form.onsubmit = (e) => { e.preventDefault(); go('to_perps'); };
  form.querySelector('[data-dir=to_predictions]').onclick = () => go('to_predictions');
  const cash = root.querySelector('[data-testid=pred-cash]');
  return session.subscribe(() => { if (cash && session.balance != null) cash.textContent = money(session.balance); });
}

// ================================================================ shared: account panels
// Positions table with live PnL recomputed from the mark on every perp_ticker message.
function positionsHtml(positions, metas, { showMarket = true } = {}) {
  if (!positions.length) return '<div class="empty" data-testid="perp-no-positions">No open perps positions.</div>';
  return `<div class="perps-scroll"><table class="table perps-pos-table" data-testid="perp-positions">
    <thead><tr>${showMarket ? '<th>Market</th>' : ''}<th>Side</th><th class="num">Size</th><th class="num">Entry</th><th class="num">Mark</th><th class="num">Liq. price</th><th class="num">Position value</th><th class="num">PnL (ROI)</th><th>TP / SL</th><th></th></tr></thead>
    <tbody>${positions.map((p) => {
      const m = metas.get(p.market_ticker);
      const long = n(p.position) > 0;
      const tr = p.exit_trigger;
      return `<tr data-testid="perp-position" data-ticker="${esc(p.market_ticker)}">
        ${showMarket ? `<td><a class="perps-mkt sm" href="/perps/${esc(p.market_ticker)}" data-link>${icon(m)}<strong>${esc(m.title)}</strong></a></td>` : ''}
        <td><span class="perps-side ${long ? 'long' : 'short'}" data-f="side">${long ? 'Long' : 'Short'}</span> <span class="faint" data-f="leverage">${lev(p.leverage)}</span></td>
        <td class="num"><span data-f="size">${Math.abs(n(p.position)).toLocaleString('en-US')}</span><div class="faint">${money(p.position_notional)}</div></td>
        <td class="num" data-f="entry">${fmtPx(m, p.entry_price)}</td>
        <td class="num" data-f="mark">${fmtPx(m, p.mark_price)}</td>
        <td class="num" data-f="liq">${fmtPx(m, p.estimated_liquidation_price)}</td>
        <td class="num" data-f="value">${money(p.position_value)}</td>
        <td class="num perps-pnl ${cls(n(p.unrealized_pnl))}" data-f="pnl" data-upnl="${n(p.unrealized_pnl)}">${pnlText(n(p.unrealized_pnl), p.roe)}</td>
        <td data-f="tpsl"><button class="btn btn-sm btn-ghost" data-tpsl="${esc(p.market_ticker)}" data-testid="tpsl-btn">${tr ? `${tr.take_profit_price ? `TP ${fmtPx(m, tr.take_profit_price)}` : ''}${tr.take_profit_price && tr.stop_loss_price ? ' · ' : ''}${tr.stop_loss_price ? `SL ${fmtPx(m, tr.stop_loss_price)}` : ''}` : 'Add TP/SL'}</button></td>
        <td><button class="btn btn-sm" data-close="${esc(p.market_ticker)}" data-testid="close-position">Close</button></td></tr>`;
    }).join('')}</tbody></table></div>`;
}
// Live refreshes must not wipe a TP/SL editor the user is typing in: keep the table while one is open.
function keepEditor(panel, positions) {
  const open = panel.querySelector('.perps-tpsl-row');
  if (!open) return false;
  const shown = [...panel.querySelectorAll('[data-testid=perp-position]')].map((r) => r.dataset.ticker).join();
  return shown === positions.map((p) => p.market_ticker).join();
}
const pnlText = (u, roe) => `${signedUsd(u)}${roe == null ? '' : ` <span class="faint">(${signedPct(n(roe))})</span>`}`;
function livePnl(root, positions, metas, ticker, markDollars) {
  for (const p of positions) {
    if (p.market_ticker !== ticker) continue;
    const m = metas.get(ticker);
    const q = n(p.position);
    const u = q * (n(markDollars) - n(p.entry_price));
    const margin = n(p.margin_used);
    const row = root.querySelector(`[data-testid=perp-position][data-ticker="${ticker}"]`);
    if (!row) continue;
    row.querySelector('[data-f=mark]').textContent = fmtPx(m, markDollars);
    const cell = row.querySelector('[data-f=pnl]');
    cell.dataset.upnl = String(Number(u.toFixed(4)));
    cell.className = `num perps-pnl ${cls(u)}`;
    cell.innerHTML = pnlText(u, margin > 0 ? (u / margin) * 100 : null);
    row.querySelector('[data-f=value]').textContent = money(margin + u);
  }
}
function wirePositions(root, positions, metas, refresh) {
  for (const b of root.querySelectorAll('[data-close]')) {
    b.onclick = async () => {
      b.disabled = true;
      try { const r = await P.closePosition(b.dataset.close); toast(`Closed ${n(r.order.fill_count)} contracts`); } catch (e) { toast(e.message, 'error'); }
      refresh();
    };
  }
  for (const b of root.querySelectorAll('[data-tpsl]')) {
    b.onclick = () => {
      const tr = b.closest('tr');
      const open = tr.nextElementSibling && tr.nextElementSibling.classList.contains('perps-tpsl-row');
      if (open) { tr.nextElementSibling.remove(); return; }
      const t = b.dataset.tpsl;
      const p = positions.find((x) => x.market_ticker === t);
      const m = metas.get(t);
      const x = p.exit_trigger;
      const long = n(p.position) > 0;
      const cols = tr.children.length;
      tr.insertAdjacentHTML('afterend', `<tr class="perps-tpsl-row"><td colspan="${cols}"><form class="perps-tpsl" data-testid="tpsl-form" data-ticker="${esc(t)}">
        <label>Take profit <input name="tp" type="number" step="any" inputmode="decimal" placeholder="${long ? 'above' : 'below'} ${esc(fmtPx(m, p.mark_price))}" value="${x && x.take_profit_price ? under(m, x.take_profit_price) : ''}" data-testid="tp-input"></label>
        <label>Stop loss <input name="sl" type="number" step="any" inputmode="decimal" placeholder="${long ? 'below' : 'above'} ${esc(fmtPx(m, p.mark_price))}" value="${x && x.stop_loss_price ? under(m, x.stop_loss_price) : ''}" data-testid="sl-input"></label>
        <button class="btn btn-sm btn-primary" type="submit" data-testid="tpsl-save">Save</button>
        ${x ? '<button class="btn btn-sm btn-ghost" type="button" data-clear data-testid="tpsl-clear">Remove</button>' : ''}
        <span class="form-error" role="alert" data-testid="tpsl-error"></span></form></td></tr>`);
      const f = tr.nextElementSibling.querySelector('form');
      f.onsubmit = async (e) => {
        e.preventDefault();
        const tp = f.tp.value.trim(); const sl = f.sl.value.trim();
        try {
          await P.setExitTrigger(t, { take_profit_price: tp ? toContract(m, tp) : null, stop_loss_price: sl ? toContract(m, sl) : null });
          toast('Exit trigger saved');
          f.closest('tr').remove();
          refresh();
        } catch (er) { f.querySelector('[data-testid=tpsl-error]').textContent = er.message; }
      };
      const clr = f.querySelector('[data-clear]');
      if (clr) clr.onclick = async () => { try { await P.clearExitTrigger(t); toast('Exit trigger removed'); f.closest('tr').remove(); refresh(); } catch (er) { toast(er.message, 'error'); } };
    };
  }
}
function ordersHtml(orders, metas, { showMarket = true } = {}) {
  if (!orders.length) return '<div class="empty" data-testid="perp-no-orders">No open orders.</div>';
  return `<div class="perps-scroll"><table class="table" data-testid="perp-orders"><thead><tr>${showMarket ? '<th>Market</th>' : ''}<th>Side</th><th>Type</th><th class="num">Price</th><th class="num">Filled / Size</th><th class="num">Leverage</th><th class="num">Margin held</th><th>Placed</th><th></th></tr></thead><tbody>
    ${orders.map((o) => { const m = metas.get(o.ticker); return `<tr data-testid="perp-order" data-order="${esc(o.order_id)}">${showMarket ? `<td>${esc(m.title)}</td>` : ''}<td><span class="perps-side ${o.side === 'bid' ? 'long' : 'short'}">${o.side === 'bid' ? 'Long' : 'Short'}</span></td><td>${o.type === 'market' ? 'Market' : 'Limit'}</td><td class="num" data-f="price">${fmtPx(m, o.price)}</td><td class="num">${n(o.fill_count)} / ${n(o.count)}</td><td class="num">${lev(o.leverage)}</td><td class="num">${money(o.reserved_margin)}</td><td>${dateTime(o.created_time)}</td><td><button class="btn btn-sm" data-cancel="${esc(o.order_id)}" data-testid="cancel-order">Cancel</button></td></tr>`; }).join('')}</tbody></table></div>`;
}
function wireOrders(root, refresh) {
  for (const b of root.querySelectorAll('[data-cancel]')) {
    b.onclick = async () => { b.disabled = true; try { await P.cancelOrder(b.dataset.cancel); toast('Order canceled'); } catch (e) { toast(e.message, 'error'); } refresh(); };
  }
}
function fundingHtml(rows, metas) {
  if (!rows.length) return '<div class="empty" data-testid="perp-no-funding">No funding payments yet. Funding is exchanged between longs and shorts on each market\'s schedule.</div>';
  return `<div class="perps-scroll"><table class="table" data-testid="perp-funding"><thead><tr><th>Time</th><th>Market</th><th class="num">Position</th><th class="num">Rate</th><th class="num">Mark</th><th class="num">Payment</th></tr></thead><tbody>
    ${rows.map((f) => { const m = metas.get(f.market_ticker); const a = n(f.funding_amount); return `<tr data-testid="perp-funding-row" data-amount="${a}" data-qty="${n(f.quantity)}"><td>${dateTime(f.funding_time)}</td><td>${esc(m ? m.title : f.market_ticker)}</td><td class="num">${n(f.quantity) > 0 ? 'Long' : 'Short'} ${Math.abs(n(f.quantity))}</td><td class="num">${fundingPct(f.funding_rate)}</td><td class="num">${m ? fmtPx(m, f.mark_price) : f.mark_price}</td><td class="num perps-pnl ${cls(a)}">${signedUsd(a, 4)}</td></tr>`; }).join('')}</tbody></table></div>`;
}
function fillsHtml(fills, metas) {
  if (!fills.length) return '<div class="empty">No perps trades yet.</div>';
  return `<div class="perps-scroll"><table class="table" data-testid="perp-fills"><thead><tr><th>Time</th><th>Market</th><th>Side</th><th class="num">Price</th><th class="num">Contracts</th><th class="num">Fee</th><th class="num">Realized PnL</th><th>Source</th></tr></thead><tbody>
    ${fills.map((f) => { const m = metas.get(f.ticker); const r = n(f.realized_pnl); return `<tr data-testid="perp-fill-row" data-source="${esc(f.source_detail)}"><td>${dateTime(f.created_time)}</td><td>${esc(m.title)}</td><td>${f.side === 'bid' ? 'Buy' : 'Sell'}</td><td class="num">${fmtPx(m, f.price)}</td><td class="num">${n(f.count)}</td><td class="num">${money(f.fees)}</td><td class="num perps-pnl ${cls(r)}">${r ? signedUsd(r) : '—'}</td><td>${{ user: 'You', exit_trigger: 'TP/SL', liquidation: 'Liquidation', liquidity: 'Maker' }[f.source_detail] || esc(f.source_detail)}</td></tr>`; }).join('')}</tbody></table></div>`;
}
function liquidationsHtml(rows, metas) {
  if (!rows.length) return '';
  return `<h4 class="perps-sub">Liquidations</h4><div class="perps-scroll"><table class="table" data-testid="perp-liquidations"><thead><tr><th>Time</th><th>Market</th><th>Side</th><th class="num">Contracts</th><th class="num">Entry</th><th class="num">Closed at</th><th class="num">Margin lost</th><th class="num">Returned</th></tr></thead><tbody>
    ${rows.map((l) => { const m = metas.get(l.ticker); return `<tr data-testid="perp-liquidation-row"><td>${dateTime(l.created_time)}</td><td>${esc(m.title)}</td><td>${l.side === 'long' ? 'Long' : 'Short'}</td><td class="num">${n(l.count)}</td><td class="num">${fmtPx(m, l.entry_price)}</td><td class="num">${fmtPx(m, l.mark_price)}</td><td class="num">${money(n(l.margin) - n(l.returned))}</td><td class="num">${money(l.returned)}</td></tr>`; }).join('')}</tbody></table></div>`;
}
function transfersHtml(rows) {
  if (!rows.length) return '';
  return `<h4 class="perps-sub">Transfers</h4><div class="perps-scroll"><table class="table" data-testid="perp-transfers"><thead><tr><th>Time</th><th>From</th><th>To</th><th class="num">Amount</th><th>Status</th></tr></thead><tbody>
    ${rows.map((t) => `<tr data-testid="perp-transfer-row"><td>${dateTime(t.created_time)}</td><td>${t.source === 'margined' ? 'Perps' : 'Predictions'}</td><td>${t.destination === 'margined' ? 'Perps' : 'Predictions'}</td><td class="num">${money(t.amount_dollars)}</td><td>${esc(t.status)}</td></tr>`).join('')}</tbody></table></div>`;
}

// ================================================================ market page
async function renderMarket({ el, params, navigate }) {
  const ticker = params.ticker;
  const [{ market }, ob, tr] = await Promise.all([P.market(ticker), P.orderbook(ticker), P.trades(ticker)]);
  let m = market;
  const metas = new Map([[m.ticker, m]]);
  document.title = `${m.title} perpetual · Parlance`;
  const authed = !!session.user;
  const maxLev = n(m.max_leverage);
  const t = { side: 'long', type: 'market', unit: 'usd', lev: Math.min(5, maxLev), reduce: false };
  let range = '1D';
  let series = [];
  let bal = null;
  let positions = [];
  let tab = 'positions';

  el.innerHTML = `<div class="perps perps-market" data-testid="perp-market" data-ticker="${esc(m.ticker)}">
    <a class="perps-back faint" href="/perps" data-link>← All perps</a>
    <header class="perps-head">
      ${icon(m)}
      <div class="perps-head-name"><h1 class="typ-title-x20">${esc(m.title)} <span class="faint">Perpetual</span></h1><div class="faint">${esc(m.product_metadata?.asset_name || '')} · ${esc(m.ticker)} · ${esc(m.asset_class)}</div></div>
      <div class="perps-head-price"><div class="perps-big" data-testid="perp-mark">${fmtPx(m, m.mark_price)}</div><div class="perps-chg" data-testid="perp-chg"></div></div>
    </header>
    <div class="perps-stats" data-testid="perp-stats">
      <div><span>Mark</span><strong data-s="mark"></strong></div>
      <div><span>Index</span><strong data-s="index"></strong></div>
      <div><span>Funding</span><strong data-s="funding"></strong><em class="faint" data-s="countdown"></em></div>
      <div><span>Open interest</span><strong data-s="oi"></strong></div>
      <div><span>24h volume</span><strong data-s="vol"></strong></div>
      <div><span>Max leverage</span><strong>${lev(maxLev)}</strong></div>
    </div>
    <div class="perps-layout">
      <div class="perps-main">
        <section class="card perps-box perps-chart-card">
          <div class="perps-chart-head"><span class="faint">Mark price</span><div class="perps-seg" role="tablist" data-testid="perp-ranges">${Object.keys(RANGES).map((k) => `<button data-range="${k}" class="${k === range ? 'on' : ''}">${k}</button>`).join('')}</div></div>
          <div class="perps-chart" data-testid="perp-chart"></div>
        </section>
        <div class="perps-duo">
          <section class="card perps-box"><h3 class="perps-box-title">Order book</h3><div class="perps-book" data-testid="perp-book"></div></section>
          <section class="card perps-box"><h3 class="perps-box-title">Recent trades</h3><div class="perps-trades" data-testid="perp-trades"></div></section>
        </div>
        ${authed ? `<section class="card perps-box perps-account" data-testid="perp-account">
          <div class="perps-tabs" role="tablist">${[['positions', 'Positions'], ['orders', 'Open orders'], ['funding', 'Funding'], ['history', 'History']].map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div>
          <div data-testid="perp-panel" class="perps-panel"></div></section>` : ''}
        <section class="card perps-box perps-about"><h3 class="perps-box-title">About ${esc(m.title)}</h3><p class="muted">${esc(m.product_metadata?.description || '')}</p>
          <dl class="perps-dl"><div><dt>Contract size</dt><dd>${n(m.contract_size)} ${esc(m.product_metadata?.unit === 'pct' ? 'index points' : 'units')}</dd></div><div><dt>Tick</dt><dd>$${m.tick_size} per contract</dd></div><div><dt>Initial / maintenance margin</dt><dd>${(m.initial_margin_rate * 100).toFixed(2)}% / ${(m.maintenance_margin_rate * 100).toFixed(2)}%</dd></div><div><dt>Fees (maker / taker)</dt><dd>${(m.maker_fee_rate * 100).toFixed(2)}% / ${(m.taker_fee_rate * 100).toFixed(2)}%</dd></div><div><dt>Funding schedule</dt><dd>every ${Math.round(m.funding_interval_ms / 3600000) || '<1'}h <span class="faint">(${esc(m.product_metadata?.funding_schedule || '')})</span></dd></div><div><dt>Index</dt><dd>${esc(m.product_metadata?.index_provider || '')}</dd></div></dl></section>
      </div>
      <aside class="perps-side-col">
        <section class="card perps-box perps-ticket" data-testid="perp-ticket">
          ${authed ? ticketHtml() : `<h3 class="perps-box-title">Trade ${esc(m.title)}</h3><p class="muted">Log in to go long or short.</p><a class="btn btn-primary perps-submit" href="/sign-in?next=/perps/${esc(m.ticker)}" data-link>Log in to trade</a>`}
        </section>
        ${authed ? transferBox() : ''}
      </aside>
    </div></div>`;
  const root = el.firstElementChild;
  const live = () => root.isConnected; // async work may finish after the user navigated away
  const $ = (s) => root.querySelector(s);

  function ticketHtml() {
    return `<div class="perps-seg perps-side-seg" data-testid="perp-side">${['long', 'short'].map((s) => `<button data-side="${s}" class="${s === t.side ? `on ${s}` : ''}">${s === 'long' ? 'Long' : 'Short'}</button>`).join('')}</div>
      <div class="perps-seg sm" data-testid="perp-type">${['market', 'limit'].map((s) => `<button data-type="${s}" class="${s === t.type ? 'on' : ''}">${s === 'market' ? 'Market' : 'Limit'}</button>`).join('')}</div>
      <label class="perps-field" data-limit hidden><span>Limit price</span><input id="pt-price" type="number" step="any" inputmode="decimal" data-testid="perp-limit-price" aria-label="Limit price"></label>
      <div class="perps-field"><span>Amount <span class="perps-unit" data-testid="perp-unit">${['usd', 'contracts'].map((u) => `<button type="button" data-unit="${u}" class="${u === t.unit ? 'on' : ''}">${u === 'usd' ? '$' : 'Contracts'}</button>`).join('')}</span></span>
        <input id="pt-amount" type="number" min="0" step="any" inputmode="decimal" placeholder="0" data-testid="perp-amount" aria-label="Amount"></div>
      <div class="perps-field"><span>Leverage <output id="pt-lev-out" data-testid="perp-leverage-out">${lev(t.lev)}</output></span>
        <input id="pt-lev" type="range" min="1" max="${maxLev}" step="1" value="${t.lev}" data-testid="perp-leverage" aria-label="Leverage">
        <div class="perps-lev-marks faint"><span>1x</span><span>${lev(Math.round(maxLev / 2))}</span><span>${lev(maxLev)}</span></div></div>
      <label class="perps-check" data-market-only><input type="checkbox" id="pt-reduce" data-testid="perp-reduce-only"> Reduce only</label>
      <dl class="perps-summary" data-testid="perp-summary">
        <div><dt>Contracts</dt><dd data-o="contracts">—</dd></div>
        <div><dt>Total size</dt><dd data-o="notional">—</dd></div>
        <div><dt>Cost (margin)</dt><dd data-o="cost">—</dd></div>
        <div><dt>Est. fees</dt><dd data-o="fees">—</dd></div>
        <div><dt>Est. liq. price</dt><dd data-o="liq" data-testid="perp-est-liq">—</dd></div>
        <div><dt>Perps available</dt><dd data-o="avail" data-testid="perp-available-ticket">—</dd></div>
      </dl>
      <button class="btn btn-primary perps-submit" id="pt-submit" data-testid="perp-submit" disabled>Long ${esc(m.title)}</button>
      <div class="form-error" role="alert" data-testid="perp-order-error"></div>`;
  }

  // ---- header stats
  function drawHead() {
    if (!live()) return;
    $('[data-testid=perp-mark]').textContent = fmtPx(m, m.mark_price);
    const chg = n(m.price_change_24h_pct);
    const c = $('[data-testid=perp-chg]');
    c.textContent = `${signedPct(chg)} 24h`;
    c.className = `perps-chg ${cls(chg)}`;
    const s = (k) => el.querySelector(`[data-s=${k}]`);
    s('mark').textContent = fmtPx(m, m.mark_price);
    s('index').textContent = fmtLevel(m, n(m.index_price));
    s('funding').textContent = fundingPct(m.funding_rate?.rate);
    s('funding').className = cls(n(m.funding_rate?.rate)) === 'down' ? 'down' : '';
    s('oi').textContent = `${n(m.open_interest).toLocaleString('en-US')} · ${compactUsd(m.open_interest_notional_value_dollars)}`;
    s('vol').textContent = compactUsd(m.volume_24h_notional_value_dollars);
    s('countdown').textContent = m.funding_rate?.next_funding_time_ms ? `in ${countdown(m.funding_rate.next_funding_time_ms)}` : '';
  }

  // ---- chart (SVG line of mark closes)
  async function loadChart() {
    const r = RANGES[range];
    const now = Math.floor(Date.now() / 1000);
    const { candlesticks } = await P.candles(m.ticker, { period_interval: r.period, start_ts: now - r.span, end_ts: now });
    series = candlesticks.filter((c) => c.price.close != null).map((c) => [c.end_period_ts * 1000, n(c.price.close)]);
    if (live()) drawChart();
  }
  function drawChart() {
    const box = $('[data-testid=perp-chart]');
    if (!series.length) { box.innerHTML = '<div class="empty faint">No price history yet.</div>'; return; }
    const W = 600; const H = 220; const pad = 6;
    const ys = series.map((p) => p[1]);
    const lo = Math.min(...ys); const hi = Math.max(...ys);
    const span = hi - lo || hi * 0.001 || 1;
    const x0 = series[0][0]; const x1 = series[series.length - 1][0] || x0 + 1;
    const X = (x) => pad + ((x - x0) / Math.max(1, x1 - x0)) * (W - 2 * pad);
    const Y = (y) => pad + (1 - (y - lo) / span) * (H - 2 * pad);
    const pts = series.map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(' ');
    const up = ys[ys.length - 1] >= ys[0];
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="perps-svg ${up ? 'up' : 'down'}" role="img" aria-label="${esc(m.title)} mark price chart">
      <polygon class="area" points="${pad},${H - pad} ${pts} ${W - pad},${H - pad}"/><polyline class="line" points="${pts}" vector-effect="non-scaling-stroke"/></svg>
      <div class="perps-axis faint"><span>${fmtPx(m, hi)}</span><span>${fmtPx(m, lo)}</span></div>`;
  }
  function chartTick(markDollars) {
    if (!series.length) return;
    const step = RANGES[range].period * 60000;
    const last = series[series.length - 1];
    if (Date.now() - last[0] >= step) series.push([Date.now(), n(markDollars)]);
    else last[1] = n(markDollars);
    drawChart();
  }

  // ---- book + trades
  function drawBook(b) {
    if (!live()) return;
    const asks = b.asks.slice(0, 8).reverse();
    const bids = b.bids.slice(0, 8);
    const maxQ = Math.max(1, ...[...asks, ...bids].map((l) => n(l[1])));
    const row = (l, side) => `<button type="button" class="perps-lvl ${side}" data-px="${l[0]}" style="--perps-depth:${((n(l[1]) / maxQ) * 100).toFixed(1)}%"><span>${fmtPx(m, l[0])}</span><span>${n(l[1]).toLocaleString('en-US')}</span></button>`;
    const spread = b.asks.length && b.bids.length ? n(b.asks[0][0]) - n(b.bids[0][0]) : null;
    $('[data-testid=perp-book]').innerHTML = `<div class="perps-lvl head faint"><span>Price</span><span>Contracts</span></div>
      <div data-testid="perp-asks">${asks.map((l) => row(l, 'ask')).join('') || '<div class="faint">No asks</div>'}</div>
      <div class="perps-spread faint">Mark ${fmtPx(m, m.mark_price)}${spread != null ? ` · spread ${fmtLevel(m, spread / n(m.contract_size))}` : ''}</div>
      <div data-testid="perp-bids">${bids.map((l) => row(l, 'bid')).join('') || '<div class="faint">No bids</div>'}</div>`;
  }
  let trades = tr.trades;
  function drawTrades() {
    $('[data-testid=perp-trades]').innerHTML = trades.length ? `<div class="perps-lvl trade head faint"><span>Price</span><span>Size</span><span>Time</span></div>${trades.slice(0, 18).map((x) => `<div class="perps-lvl trade ${x.taker_side === 'bid' ? 'bid' : 'ask'}"><span>${fmtPx(m, x.price)}${x.is_liquidation ? ' <em class="faint">liq</em>' : ''}</span><span>${n(x.count).toLocaleString('en-US')}</span><span class="faint">${time(x.created_time)}</span></div>`).join('')}` : '<div class="empty faint">No trades yet.</div>';
  }

  // ---- ticket
  function calc() {
    if (!authed) return null;
    const amount = n($('#pt-amount').value);
    const bb = m.bid != null ? n(m.bid) : n(m.mark_price);
    const ba = m.ask != null ? n(m.ask) : n(m.mark_price);
    const limitLevel = $('#pt-price').value;
    const px = t.type === 'limit' && limitLevel ? n(toContract(m, limitLevel)) : (t.side === 'long' ? ba : bb);
    const taker = n(m.taker_fee_rate);
    let contracts = 0;
    if (px > 0 && amount > 0) contracts = t.unit === 'usd' ? Math.floor((amount / (px / t.lev + px * taker)) + 1e-9) : Math.floor(amount);
    if (t.reduce && t.type === 'market') {
      const p = positions.find((x) => x.market_ticker === m.ticker);
      contracts = p ? Math.min(contracts || Math.abs(n(p.position)), Math.abs(n(p.position))) : 0;
    }
    const notional = contracts * px;
    const cost = t.reduce ? 0 : notional / t.lev;
    const fees = Math.ceil(notional * taker * 10000) / 10000;
    const r = n(m.maintenance_margin_rate);
    let liq = null;
    if (contracts > 0 && !t.reduce) liq = t.side === 'long' ? (contracts * px - cost) / (contracts * (1 - r)) : (cost + contracts * px) / (contracts * (1 + r));
    return { contracts, px, notional, cost, fees, liq };
  }
  function drawTicket() {
    if (!authed || !live()) return;
    const c = calc();
    const o = (k) => el.querySelector(`[data-o=${k}]`);
    o('contracts').textContent = c.contracts ? c.contracts.toLocaleString('en-US') : '—';
    o('notional').textContent = c.contracts ? money(c.notional) : '—';
    o('cost').textContent = c.contracts ? money(c.cost) : '—';
    o('fees').textContent = c.contracts ? `$${c.fees.toFixed(4)}` : '—';
    o('liq').textContent = c.liq && c.liq > 0 ? fmtPx(m, c.liq) : '—';
    o('avail').textContent = bal ? money(bal.available_dollars) : '—';
    const btn = $('#pt-submit');
    btn.disabled = !c.contracts;
    btn.textContent = `${t.reduce ? 'Reduce' : t.side === 'long' ? 'Long' : 'Short'} ${m.title}${c.contracts ? ` · ${c.contracts.toLocaleString('en-US')}` : ''}`;
    btn.className = `btn perps-submit ${t.side}`;
    el.querySelector('[data-limit]').hidden = t.type !== 'limit';
    el.querySelector('[data-market-only]').hidden = t.type !== 'market';
  }
  function wireTicket() {
    if (!authed) return;
    for (const b of el.querySelectorAll('[data-side]')) b.onclick = () => { t.side = b.dataset.side; for (const x of el.querySelectorAll('[data-side]')) x.className = x === b ? `on ${t.side}` : ''; drawTicket(); };
    for (const b of el.querySelectorAll('[data-type]')) b.onclick = () => {
      t.type = b.dataset.type; for (const x of el.querySelectorAll('[data-type]')) x.classList.toggle('on', x === b);
      if (t.type === 'limit') { t.reduce = false; $('#pt-reduce').checked = false; if (!$('#pt-price').value) $('#pt-price').value = under(m, m.mark_price).toFixed(dec(m)); }
      drawTicket();
    };
    for (const b of el.querySelectorAll('[data-unit]')) b.onclick = () => { t.unit = b.dataset.unit; for (const x of el.querySelectorAll('[data-unit]')) x.classList.toggle('on', x === b); drawTicket(); };
    $('#pt-lev').oninput = (e) => { t.lev = Number(e.target.value); $('#pt-lev-out').textContent = lev(t.lev); drawTicket(); };
    $('#pt-reduce').onchange = (e) => { t.reduce = e.target.checked; drawTicket(); };
    $('#pt-amount').oninput = drawTicket;
    $('#pt-price').oninput = drawTicket;
    $('[data-testid=perp-book]').addEventListener('click', (e) => {
      const b = e.target.closest('[data-px]');
      if (!b) return;
      el.querySelector('[data-type=limit]').click();
      $('#pt-price').value = under(m, b.dataset.px).toFixed(dec(m));
      drawTicket();
    });
    $('#pt-submit').onclick = async () => {
      const err = $('[data-testid=perp-order-error]');
      err.textContent = '';
      const c = calc();
      if (!c.contracts) return;
      const body = { ticker: m.ticker, side: t.side === 'long' ? 'bid' : 'ask', type: t.type, count: c.contracts, leverage: t.lev, reduce_only: t.reduce && t.type === 'market' };
      if (t.type === 'limit') { body.price = toContract(m, $('#pt-price').value); body.time_in_force = 'good_till_canceled'; }
      const btn = $('#pt-submit');
      btn.disabled = true;
      try {
        const r = await P.placeOrder(body);
        const o = r.order;
        toast(o.status === 'resting' ? `Limit order placed: ${n(o.remaining_count)} at ${fmtPx(m, o.price)}` : n(o.fill_count) ? `Filled ${n(o.fill_count)} at ${fmtPx(m, o.average_fill_price)}` : 'Order was not filled');
        $('#pt-amount').value = '';
        await refreshAccount();
      } catch (e) { err.textContent = e.message; toast(e.message, 'error'); }
      drawTicket();
    };
  }

  // ---- account
  async function refreshAccount() {
    if (!authed) return;
    const [b, ps] = await Promise.all([P.balance(), P.positions()]);
    bal = b;
    positions = ps.positions;
    for (const p of positions) if (!metas.has(p.market_ticker)) metas.set(p.market_ticker, (await P.market(p.market_ticker)).market);
    if (!live()) return;
    const av = el.querySelector('[data-testid=perps-available]');
    if (av) av.textContent = money(b.available_dollars);
    drawTicket();
    await drawPanel();
  }
  async function drawPanel() {
    const panel = live() && $('[data-testid=perp-panel]');
    if (!panel) return;
    if (tab === 'positions') {
      if (keepEditor(panel, positions)) return;
      panel.innerHTML = positionsHtml(positions, metas);
      wirePositions(panel, positions, metas, refreshAccount);
    } else if (tab === 'orders') {
      const { orders } = await P.orders({ status: 'resting' });
      for (const o of orders) if (!metas.has(o.ticker)) metas.set(o.ticker, (await P.market(o.ticker)).market);
      panel.innerHTML = ordersHtml(orders, metas);
      wireOrders(panel, refreshAccount);
    } else if (tab === 'funding') {
      const { funding_history: fh } = await P.fundingHistory({ ticker: m.ticker });
      panel.innerHTML = fundingHtml(fh, metas);
    } else {
      const [{ fills }, { liquidations }] = await Promise.all([P.fills({ ticker: m.ticker }), P.liquidations()]);
      panel.innerHTML = liquidationsHtml(liquidations.filter((l) => l.ticker === m.ticker), metas) + `<h4 class="perps-sub">Trades</h4>${fillsHtml(fills, metas)}`;
    }
  }
  for (const b of el.querySelectorAll('[data-tab]')) {
    b.onclick = () => { tab = b.dataset.tab; for (const x of el.querySelectorAll('[data-tab]')) x.classList.toggle('on', x === b); drawPanel().catch(() => {}); };
  }
  for (const b of el.querySelectorAll('[data-range]')) {
    b.onclick = () => { range = b.dataset.range; for (const x of el.querySelectorAll('[data-range]')) x.classList.toggle('on', x === b); loadChart().catch(() => {}); };
  }

  drawHead();
  drawBook(ob.orderbook);
  drawTrades();
  wireTicket();
  await Promise.all([loadChart(), refreshAccount()]);
  if (!live()) return undefined;
  const unsubXfer = authed ? wireTransfer(el, refreshAccount) : () => {};

  const refreshSoon = debounce(refreshAccount, 120);
  const unsubs = [
    socket.subscribe({ channels: ['perp_ticker'], market_tickers: [m.ticker] }, (msg) => {
      if (msg.type !== 'perp_ticker') return;
      m = { ...m, ...msg.msg };
      metas.set(m.ticker, m);
      drawHead();
      chartTick(m.mark_price);
      livePnl(el, positions, metas, m.ticker, m.mark_price);
      drawTicket();
    }),
    socket.subscribe({ channels: ['perp_orderbook'], market_tickers: [m.ticker] }, (msg) => { if (msg.type === 'perp_orderbook_snapshot') drawBook(msg.msg); }),
    socket.subscribe({ channels: ['perp_trade'], market_tickers: [m.ticker] }, (msg) => { if (msg.type === 'perp_trade' && live()) { trades = [msg.msg, ...trades].slice(0, 40); drawTrades(); } }),
  ];
  if (authed) {
    unsubs.push(socket.subscribe({ channels: ['perp_positions', 'perp_orders', 'perp_account'] }, (msg) => {
      if (msg.type === 'perp_account') { bal = msg.msg; const av = el.querySelector('[data-testid=perps-available]'); if (av) av.textContent = money(bal.available_dollars); }
      refreshSoon();
    }));
  }
  const clock = setInterval(() => { const c = el.querySelector('[data-s=countdown]'); if (c && m.funding_rate?.next_funding_time_ms) c.textContent = `in ${countdown(m.funding_rate.next_funding_time_ms)}`; }, 1000);
  void navigate;
  return () => { unsubs.forEach((u) => u()); unsubXfer(); refreshSoon.cancel(); clearInterval(clock); };
}

// ================================================================ portfolio (Perps product)
export async function renderPerpsPortfolio({ el, query, navigate }) {
  if (!session.user) { navigate(`/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`, { replace: true }); return undefined; }
  document.title = 'Perps portfolio · Parlance';
  let tab = PERPS_TABS.some(([k]) => k === query.get('perpsTab')) ? query.get('perpsTab') : 'positions';
  const { markets } = await P.markets();
  const metas = new Map(markets.map((m) => [m.ticker, m]));
  let positions = [];
  el.innerHTML = `<div class="perps perps-portfolio" data-testid="perps-portfolio">
    <div class="page-head"><h1 class="typ-title-x10">Portfolio</h1></div>
    <nav class="perps-product" aria-label="Product"><a href="/portfolio" data-link data-testid="product-predictions">Predictions</a><a href="/portfolio?perpsTab=positions" data-link class="on" data-testid="product-perps">Perps</a></nav>
    <div class="perps-stat-row">
      <div class="card perps-stat"><span>Account equity</span><strong data-testid="perps-equity">—</strong></div>
      <div class="card perps-stat"><span>Available</span><strong data-testid="perps-port-available">—</strong></div>
      <div class="card perps-stat"><span>Unrealized PnL</span><strong data-testid="perps-upnl">—</strong></div>
      <div class="card perps-stat"><span>Margin in use</span><strong data-testid="perps-margin">—</strong></div>
    </div>
    <div class="perps-layout">
      <div class="perps-main"><section class="card perps-box">
        <div class="perps-tabs" role="tablist" data-testid="perps-port-tabs">${PERPS_TABS.map(([k, l]) => `<button data-ptab="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}<a class="btn btn-sm btn-ghost perps-tabs-link" href="/perps" data-link>Browse perps</a></div>
        <div class="perps-panel" data-testid="perps-port-panel"></div></section></div>
      <aside class="perps-side-col">${transferBox()}</aside>
    </div></div>`;
  const root = el.firstElementChild;
  const $ = (s) => root.querySelector(s);

  async function drawStats() {
    const b = await P.balance();
    if (!root.isConnected) return;
    $('[data-testid=perps-equity]').textContent = money(b.account_equity);
    $('[data-testid=perps-port-available]').textContent = money(b.available_dollars);
    $('[data-testid=perps-available]').textContent = money(b.available_dollars);
    const u = n(b.unrealized_pnl);
    const up = $('[data-testid=perps-upnl]');
    up.textContent = signedUsd(u);
    up.className = `perps-pnl ${cls(u)}`;
    $('[data-testid=perps-margin]').textContent = money(b.margin_in_use);
  }
  async function drawPanel() {
    const p = $('[data-testid=perps-port-panel]');
    if (tab === 'positions') {
      positions = (await P.positions()).positions;
      if (!root.isConnected || keepEditor(p, positions)) return;
      p.innerHTML = positionsHtml(positions, metas);
      wirePositions(p, positions, metas, refresh);
    } else if (tab === 'orders') {
      const { orders } = await P.orders({ status: 'resting' });
      p.innerHTML = ordersHtml(orders, metas);
      wireOrders(p, refresh);
    } else {
      const [{ fills }, { funding_history: fh }, { liquidations }, { transfers }] = await Promise.all([P.fills(), P.fundingHistory(), P.liquidations(), P.transfers()]);
      p.innerHTML = `${liquidationsHtml(liquidations, metas)}<h4 class="perps-sub">Trades</h4>${fillsHtml(fills, metas)}<h4 class="perps-sub">Funding payments</h4>${fundingHtml(fh, metas)}${transfersHtml(transfers)}`;
    }
  }
  async function refresh() { await Promise.all([drawStats(), drawPanel()]); }
  for (const b of el.querySelectorAll('[data-ptab]')) {
    b.onclick = () => {
      tab = b.dataset.ptab;
      for (const x of el.querySelectorAll('[data-ptab]')) x.classList.toggle('on', x === b);
      const u = new URL(location.href); u.searchParams.set('perpsTab', tab); history.replaceState({}, '', u.pathname + u.search);
      drawPanel().catch(() => {});
    };
  }
  await refresh();
  if (!root.isConnected) return undefined;
  const unsubXfer = wireTransfer(el, refresh);
  const refreshSoon = debounce(refresh, 150);
  const unsubs = [
    socket.subscribe({ channels: ['perp_positions', 'perp_orders', 'perp_account'] }, () => refreshSoon()),
    socket.subscribe({ channels: ['perp_ticker'] }, (msg) => {
      if (msg.type !== 'perp_ticker' || tab !== 'positions') return;
      const mm = metas.get(msg.msg.market_ticker);
      if (mm) Object.assign(mm, msg.msg);
      livePnl(el, positions, metas, msg.msg.market_ticker, msg.msg.mark_price);
    }),
  ];
  return () => { unsubs.forEach((u) => u()); unsubXfer(); refreshSoon.cancel(); };
}

