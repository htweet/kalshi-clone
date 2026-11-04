// Perps (PERPS_SPEC_SECTION.md): market list (/perps, /perps/categories/:assetClass), market page (/perps/:ticker)
// and the Perps portfolio (/portfolio?perpsTab=positions|orders|history, also /portfolio/perps).
// Prices travel per contract in dollars (4 dp); the UI shows the underlying level = contract price / contract size, in the
// display currency (NGN: ×100, the same rule as event contracts, so nothing on a page mixes currencies; CLONE_SPEC.md §30).
// Price inputs (limit, take profit, stop loss) take display levels and convert back with assetToApi.
import { t as tx, te, ts } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/perps-strings.js';
import { t as T } from '../content/currency-strings.js'; // keyed wording (CLONE_SPEC.md §30)
import { vars } from '../dynstyle.js';
import { perpsApi as P } from '../perps-api.js';
import { session } from '../store.js';
import { socket } from '../ws.js';
import { esc, money, toast, assetPrice, assetDecimals, moneyCompact, sym, amountLabel, toApiDollars, validMoneyInput, moneyStep, moneyMin, moneyInputHint, isNgn, fmtTime, fmtDt } from '../lib.js';
import { assetToApi, assetFromApi } from '../currency.js'; // perps ×100 display rule under NGN (CLONE_SPEC.md §30)

const ASSET_ORDER = ['Crypto', 'Equities', 'Metals', 'FX', 'Energy', 'Indices', 'Rates', 'Compute', 'GPU', 'EventContracts'];
const RANGES = { '1H': { period: 1, span: 3600 }, '1D': { period: 15, span: 86400 }, '1W': { period: 60, span: 7 * 86400 } };
const PERPS_TABS = [['positions', ts('perps.perps_tabs.positions')], ['orders', ts('perps.perps_tabs.open_orders')], ['history', ts('perps.perps_tabs.history')]];

// ---------------------------------------------------------------- formatting
const n = (s) => Number(s ?? 0);
const dec = (m) => m.product_metadata?.decimal_count ?? 2;
const under = (m, contractDollars) => n(contractDollars) / n(m.contract_size);
function fmtLevel(m, v) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (m.product_metadata?.unit === 'pct') return `${v.toLocaleString('en-US', { minimumFractionDigits: dec(m), maximumFractionDigits: dec(m) })}%`;
  return assetPrice(v, dec(m));
}
const fmtPx = (m, contractDollars) => (contractDollars == null ? '—' : fmtLevel(m, under(m, contractDollars)));
const isPct = (m) => m.product_metadata?.unit === 'pct';
// Display level ↔ API level (dollars); percent markets are currency-free.
const lvlToApi = (m, v) => (isPct(m) ? Number(v) : assetToApi(v));
const lvlFromApi = (m, v) => (isPct(m) ? Number(v) : assetFromApi(v));
const lvlDec = (m) => (isPct(m) ? dec(m) : assetDecimals(dec(m)));
const toContract = (m, level) => (lvlToApi(m, level) * n(m.contract_size)).toFixed(4);
const signedUsd = (v, d = 2) => money(v, { plus: true, exact: isNgn() ? Math.max(2, d - 2) : d }); // signed P&L / funding in the display currency
const signedPct = (v, d = 2) => `${v > 0 ? '+' : ''}${v.toFixed(d)}%`;
const fundingPct = (r) => `${(n(r) * 100).toFixed(4)}%`;
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const compactUsd = (v) => moneyCompact(n(v));
const lev = (x) => (x == null ? '—' : `${Number.isInteger(x) ? x : Number(x).toFixed(1)}x`);
const time = (iso) => fmtTime(iso, true);
const dateTime = (iso) => fmtDt(iso, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const icon = (m) => `<span class="perps-ico"${vars({ '--perps-accent': m.product_metadata?.color || 'var(--brand)' })} aria-hidden="true">${esc(m.title[0])}</span>`;
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
  document.title = tx('perps.render_list.perps_parlance');
  const [{ markets }, { asset_classes: classes }] = await Promise.all([P.markets(), P.assetClasses()]);
  const want = params.assetClass ? classes.find((c) => c.slug === String(params.assetClass).toLowerCase()) : null;
  if (params.assetClass && !want) {
    el.innerHTML = `<div class="card empty" data-testid="page-error"><h1 class="typ-title-x20">${te('perps.render_list.unknown_category')}</h1><a class="btn" href="/perps" data-link>${te('perps.render_list.all_perps')}</a></div>`;
    return undefined;
  }
  const shown = markets.filter((m) => !want || m.asset_class === want.name).sort((a, b) => ASSET_ORDER.indexOf(a.asset_class) - ASSET_ORDER.indexOf(b.asset_class));
  el.innerHTML = `<div class="perps" data-testid="perps-list">
    <div class="perps-hero"><h1 class="page-title">${te('perps.render_list.perps')}</h1>
      <p class="muted">${te('perps.render_list.perpetual_futures_on_simulated_indices')}</p></div>
    <nav class="perps-chips" aria-label="${te('perps.render_list.asset_classes')}" data-testid="perps-chips">
      <a href="/perps" data-link class="${want ? '' : 'on'}" data-class="all">${te('perps.render_list.all')} <span>${markets.length}</span></a>
      ${classes.map((c) => `<a href="/perps/categories/${esc(c.slug)}" data-link class="${want && want.slug === c.slug ? 'on' : ''}" data-class="${esc(c.name)}">${esc(c.name)} <span>${esc(c.count)}</span></a>`).join('')}
    </nav>
    <div class="perps-table-wrap card"><table class="perps-table" data-testid="perps-table">
      <thead><tr><th>${te('perps.render_list.market')}</th><th class="num">${te('perps.render_list.price')}</th><th class="num">24h</th><th class="num perps-hide-sm">${te('perps.render_list.funding')}</th><th class="num perps-hide-sm">${te('perps.render_list.max_leverage')}</th><th class="num perps-hide-md">${te('perps.render_list.n24h_volume')}</th></tr></thead>
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
    <h3 class="perps-box-title">${te('perps.transfer_box.transfer_funds')}</h3>
    <div class="perps-kv"><span>${te('perps.transfer_box.predictions_cash')}</span><strong data-testid="pred-cash">${session.balance != null ? money(session.balance) : '—'}</strong></div>
    <div class="perps-kv"><span>${te('perps.transfer_box.perps_available')}</span><strong data-testid="perps-available">—</strong></div>
    <form class="perps-xfer" data-testid="perp-transfer-form">
      <input id="px-amount" type="number" min="${esc(moneyMin())}" step="${esc(moneyStep())}" inputmode="decimal" placeholder="${esc(T('input.amount_placeholder', { symbol: sym() }))}" aria-label="${esc(T('input.transfer_aria', { mode: amountLabel().toLowerCase() }))}" data-testid="xfer-amount">
      <div class="perps-xfer-btns"><button class="btn btn-primary" type="submit" data-dir="to_perps" data-testid="xfer-to-perps">${te('perps.transfer_box.to_perps')}</button><button class="btn" type="button" data-dir="to_predictions" data-testid="xfer-to-predictions">${te('perps.transfer_box.to_predictions')}</button></div>
      <div class="form-error" role="alert" data-testid="xfer-error"></div>
    </form></section>`;
}
function wireTransfer(root, onDone) {
  const form = root.querySelector('[data-testid=perp-transfer-form]');
  if (!form) return () => {};
  const go = async (dir) => {
    const err = form.querySelector('[data-testid=xfer-error]');
    err.textContent = '';
    const raw = form.querySelector('#px-amount').value;
    if (!validMoneyInput(raw)) { err.textContent = T('error.amount_positive', { zero: money(0), hint: moneyInputHint() }); return; }
    const amt = toApiDollars(raw); // naira ÷ 100 = the API's dollars
    try {
      await P.transfer(dir, amt);
      form.querySelector('#px-amount').value = '';
      toast(tx('perps.wire_transfer.moved', { money: money(amt), value: dir === 'to_perps' ? tx('perps.wire_transfer.to_perps') : tx('perps.wire_transfer.to_predictions') }));
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
  if (!positions.length) return `<div class="empty" data-testid="perp-no-positions">${te('perps.positions_html.no_open_perps_positions')}</div>`;
  return `<div class="perps-scroll"><table class="table perps-pos-table" data-testid="perp-positions">
    <thead><tr>${showMarket ? `<th>${te('perps.positions_html.market')}</th>` : ''}<th>${te('perps.positions_html.side')}</th><th class="num">${te('perps.positions_html.size')}</th><th class="num">${te('perps.positions_html.entry')}</th><th class="num">${te('perps.positions_html.mark')}</th><th class="num">${te('perps.positions_html.liq_price')}</th><th class="num">${te('perps.positions_html.position_value')}</th><th class="num">${te('perps.positions_html.pnl_roi')}</th><th>${te('perps.positions_html.tp_sl')}</th><th></th></tr></thead>
    <tbody>${positions.map((p) => {
      const m = metas.get(p.market_ticker);
      const long = n(p.position) > 0;
      const tr = p.exit_trigger;
      return `<tr data-testid="perp-position" data-ticker="${esc(p.market_ticker)}">
        ${showMarket ? `<td><a class="perps-mkt sm" href="/perps/${esc(p.market_ticker)}" data-link>${icon(m)}<strong>${esc(m.title)}</strong></a></td>` : ''}
        <td><span class="perps-side ${long ? 'long' : 'short'}" data-f="side">${long ? te('perps.positions_html.long') : te('perps.positions_html.short')}</span> <span class="faint" data-f="leverage">${lev(p.leverage)}</span></td>
        <td class="num"><span data-f="size">${Math.abs(n(p.position)).toLocaleString('en-US')}</span><div class="faint">${money(p.position_notional)}</div></td>
        <td class="num" data-f="entry">${fmtPx(m, p.entry_price)}</td>
        <td class="num" data-f="mark">${fmtPx(m, p.mark_price)}</td>
        <td class="num" data-f="liq">${fmtPx(m, p.estimated_liquidation_price)}</td>
        <td class="num" data-f="value">${money(p.position_value)}</td>
        <td class="num perps-pnl ${cls(n(p.unrealized_pnl))}" data-f="pnl" data-upnl="${n(p.unrealized_pnl)}">${pnlText(n(p.unrealized_pnl), p.roe)}</td>
        <td data-f="tpsl"><button class="btn btn-sm btn-ghost" data-tpsl="${esc(p.market_ticker)}" data-testid="tpsl-btn">${tr ? `${tr.take_profit_price ? te('perps.positions_html.tp', { fmt_px: fmtPx(m, tr.take_profit_price) }) : ''}${tr.take_profit_price && tr.stop_loss_price ? ' · ' : ''}${tr.stop_loss_price ? te('perps.positions_html.sl', { fmt_px: fmtPx(m, tr.stop_loss_price) }) : ''}` : te('perps.positions_html.add_tp_sl')}</button></td>
        <td><button class="btn btn-sm" data-close="${esc(p.market_ticker)}" data-testid="close-position">${te('perps.positions_html.close')}</button></td></tr>`;
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
      try { const r = await P.closePosition(b.dataset.close); toast(tx('perps.wire_positions.closed_contracts', { n: n(r.order.fill_count) })); } catch (e) { toast(e.message, 'error'); }
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
        <label>${te('perps.wire_positions.take_profit')} <input name="tp" type="number" step="any" inputmode="decimal" placeholder="${long ? te('perps.wire_positions.above') : te('perps.wire_positions.below')} ${esc(fmtPx(m, p.mark_price))}" value="${x && x.take_profit_price ? lvlFromApi(m, under(m, x.take_profit_price)) : ''}" data-testid="tp-input"></label>
        <label>${te('perps.wire_positions.stop_loss')} <input name="sl" type="number" step="any" inputmode="decimal" placeholder="${long ? te('perps.wire_positions.below') : te('perps.wire_positions.above')} ${esc(fmtPx(m, p.mark_price))}" value="${x && x.stop_loss_price ? lvlFromApi(m, under(m, x.stop_loss_price)) : ''}" data-testid="sl-input"></label>
        <button class="btn btn-sm btn-primary" type="submit" data-testid="tpsl-save">${te('perps.wire_positions.save')}</button>
        ${x ? `<button class="btn btn-sm btn-ghost" type="button" data-clear data-testid="tpsl-clear">${te('perps.wire_positions.remove')}</button>` : ''}
        <span class="form-error" role="alert" data-testid="tpsl-error"></span></form></td></tr>`);
      const f = tr.nextElementSibling.querySelector('form');
      f.onsubmit = async (e) => {
        e.preventDefault();
        const tp = f.tp.value.trim(); const sl = f.sl.value.trim();
        try {
          await P.setExitTrigger(t, { take_profit_price: tp ? toContract(m, tp) : null, stop_loss_price: sl ? toContract(m, sl) : null });
          toast(tx('perps.wire_positions.exit_trigger_saved'));
          f.closest('tr').remove();
          refresh();
        } catch (er) { f.querySelector('[data-testid=tpsl-error]').textContent = er.message; }
      };
      const clr = f.querySelector('[data-clear]');
      if (clr) clr.onclick = async () => { try { await P.clearExitTrigger(t); toast(tx('perps.wire_positions.exit_trigger_removed')); f.closest('tr').remove(); refresh(); } catch (er) { toast(er.message, 'error'); } };
    };
  }
}
function ordersHtml(orders, metas, { showMarket = true } = {}) {
  if (!orders.length) return `<div class="empty" data-testid="perp-no-orders">${te('perps.orders_html.no_open_orders')}</div>`;
  return `<div class="perps-scroll"><table class="table" data-testid="perp-orders"><thead><tr>${showMarket ? `<th>${te('perps.orders_html.market')}</th>` : ''}<th>${te('perps.orders_html.side')}</th><th>${te('perps.orders_html.type')}</th><th class="num">${te('perps.orders_html.price')}</th><th class="num">${te('perps.orders_html.filled_size')}</th><th class="num">${te('perps.orders_html.leverage')}</th><th class="num">${te('perps.orders_html.margin_held')}</th><th>${te('perps.orders_html.placed')}</th><th></th></tr></thead><tbody>
    ${orders.map((o) => { const m = metas.get(o.ticker); return `<tr data-testid="perp-order" data-order="${esc(o.order_id)}">${showMarket ? `<td>${esc(m.title)}</td>` : ''}<td><span class="perps-side ${o.side === 'bid' ? 'long' : 'short'}">${o.side === 'bid' ? te('perps.orders_html.long') : te('perps.orders_html.short')}</span></td><td>${o.type === 'market' ? te('perps.orders_html.market') : te('perps.orders_html.limit')}</td><td class="num" data-f="price">${fmtPx(m, o.price)}</td><td class="num">${n(o.fill_count)} / ${n(o.count)}</td><td class="num">${lev(o.leverage)}</td><td class="num">${money(o.reserved_margin)}</td><td>${dateTime(o.created_time)}</td><td><button class="btn btn-sm" data-cancel="${esc(o.order_id)}" data-testid="cancel-order">${te('perps.orders_html.cancel')}</button></td></tr>`; }).join('')}</tbody></table></div>`;
}
function wireOrders(root, refresh) {
  for (const b of root.querySelectorAll('[data-cancel]')) {
    b.onclick = async () => { b.disabled = true; try { await P.cancelOrder(b.dataset.cancel); toast(tx('perps.wire_orders.order_canceled')); } catch (e) { toast(e.message, 'error'); } refresh(); };
  }
}
function fundingHtml(rows, metas) {
  if (!rows.length) return `<div class="empty" data-testid="perp-no-funding">${te('perps.funding_html.no_funding_payments_yet_funding')}</div>`;
  return `<div class="perps-scroll"><table class="table" data-testid="perp-funding"><thead><tr><th>${te('perps.funding_html.time')}</th><th>${te('perps.funding_html.market')}</th><th class="num">${te('perps.funding_html.position')}</th><th class="num">${te('perps.funding_html.rate')}</th><th class="num">${te('perps.funding_html.mark')}</th><th class="num">${te('perps.funding_html.payment')}</th></tr></thead><tbody>
    ${rows.map((f) => { const m = metas.get(f.market_ticker); const a = n(f.funding_amount); return `<tr data-testid="perp-funding-row" data-amount="${a}" data-qty="${n(f.quantity)}"><td>${dateTime(f.funding_time)}</td><td>${esc(m ? m.title : f.market_ticker)}</td><td class="num">${n(f.quantity) > 0 ? te('perps.funding_html.long') : te('perps.funding_html.short')} ${Math.abs(n(f.quantity))}</td><td class="num">${fundingPct(f.funding_rate)}</td><td class="num">${esc(m ? fmtPx(m, f.mark_price) : f.mark_price)}</td><td class="num perps-pnl ${cls(a)}">${signedUsd(a, 4)}</td></tr>`; }).join('')}</tbody></table></div>`;
}
function fillsHtml(fills, metas) {
  if (!fills.length) return `<div class="empty">${te('perps.fills_html.no_perps_trades_yet')}</div>`;
  return `<div class="perps-scroll"><table class="table" data-testid="perp-fills"><thead><tr><th>${te('perps.fills_html.time')}</th><th>${te('perps.fills_html.market')}</th><th>${te('perps.fills_html.side')}</th><th class="num">${te('perps.fills_html.price')}</th><th class="num">${te('perps.fills_html.contracts')}</th><th class="num">${te('perps.fills_html.fee')}</th><th class="num">${te('perps.fills_html.realized_pnl')}</th><th>${te('perps.fills_html.source')}</th></tr></thead><tbody>
    ${fills.map((f) => { const m = metas.get(f.ticker); const r = n(f.realized_pnl); return `<tr data-testid="perp-fill-row" data-source="${esc(f.source_detail)}"><td>${dateTime(f.created_time)}</td><td>${esc(m.title)}</td><td>${f.side === 'bid' ? te('perps.fills_html.buy') : te('perps.fills_html.sell')}</td><td class="num">${fmtPx(m, f.price)}</td><td class="num">${n(f.count)}</td><td class="num">${money(f.fees)}</td><td class="num perps-pnl ${cls(r)}">${r ? signedUsd(r) : '—'}</td><td>${esc({ user: 'You', exit_trigger: 'TP/SL', liquidation: 'Liquidation', liquidity: 'Maker' }[f.source_detail] || f.source_detail)}</td></tr>`; }).join('')}</tbody></table></div>`;
}
function liquidationsHtml(rows, metas) {
  if (!rows.length) return '';
  return `<h4 class="perps-sub">${te('perps.liquidations_html.liquidations')}</h4><div class="perps-scroll"><table class="table" data-testid="perp-liquidations"><thead><tr><th>${te('perps.liquidations_html.time')}</th><th>${te('perps.liquidations_html.market')}</th><th>${te('perps.liquidations_html.side')}</th><th class="num">${te('perps.liquidations_html.contracts')}</th><th class="num">${te('perps.liquidations_html.entry')}</th><th class="num">${te('perps.liquidations_html.closed_at')}</th><th class="num">${te('perps.liquidations_html.margin_lost')}</th><th class="num">${te('perps.liquidations_html.returned')}</th></tr></thead><tbody>
    ${rows.map((l) => { const m = metas.get(l.ticker); return `<tr data-testid="perp-liquidation-row"><td>${dateTime(l.created_time)}</td><td>${esc(m.title)}</td><td>${l.side === 'long' ? te('perps.liquidations_html.long') : te('perps.liquidations_html.short')}</td><td class="num">${n(l.count)}</td><td class="num">${fmtPx(m, l.entry_price)}</td><td class="num">${fmtPx(m, l.mark_price)}</td><td class="num">${money(n(l.margin) - n(l.returned))}</td><td class="num">${money(l.returned)}</td></tr>`; }).join('')}</tbody></table></div>`;
}
function transfersHtml(rows) {
  if (!rows.length) return '';
  return `<h4 class="perps-sub">${te('perps.transfers_html.transfers')}</h4><div class="perps-scroll"><table class="table" data-testid="perp-transfers"><thead><tr><th>${te('perps.transfers_html.time')}</th><th>${te('perps.transfers_html.from')}</th><th>${te('perps.transfers_html.to')}</th><th class="num">${te('perps.transfers_html.amount')}</th><th>${te('perps.transfers_html.status')}</th></tr></thead><tbody>
    ${rows.map((t) => `<tr data-testid="perp-transfer-row"><td>${dateTime(t.created_time)}</td><td>${t.source === 'margined' ? te('perps.transfers_html.perps') : te('perps.transfers_html.predictions')}</td><td>${t.destination === 'margined' ? te('perps.transfers_html.perps') : te('perps.transfers_html.predictions')}</td><td class="num">${money(t.amount_dollars)}</td><td>${esc(t.status)}</td></tr>`).join('')}</tbody></table></div>`;
}

// ================================================================ market page
async function renderMarket({ el, params, navigate }) {
  const ticker = params.ticker;
  const [{ market }, ob, tr] = await Promise.all([P.market(ticker), P.orderbook(ticker), P.trades(ticker)]);
  let m = market;
  const metas = new Map([[m.ticker, m]]);
  document.title = tx('perps.render_market.perpetual_parlance', { title: m.title });
  const authed = !!session.user;
  const maxLev = n(m.max_leverage);
  const t = { side: 'long', type: 'market', unit: 'usd', lev: Math.min(5, maxLev), reduce: false };
  let range = '1D';
  let series = [];
  let bal = null;
  let positions = [];
  let tab = 'positions';

  el.innerHTML = `<div class="perps perps-market" data-testid="perp-market" data-ticker="${esc(m.ticker)}">
    <a class="perps-back faint" href="/perps" data-link>${te('perps.render_market.all_perps')}</a>
    <header class="perps-head">
      ${icon(m)}
      <div class="perps-head-name"><h1 class="typ-title-x20">${esc(m.title)} <span class="faint">${te('perps.render_market.perpetual')}</span></h1><div class="faint">${esc(m.product_metadata?.asset_name || '')} · ${esc(m.ticker)} · ${esc(m.asset_class)}</div></div>
      <div class="perps-head-price"><div class="perps-big" data-testid="perp-mark">${fmtPx(m, m.mark_price)}</div><div class="perps-chg" data-testid="perp-chg"></div></div>
    </header>
    <div class="perps-stats" data-testid="perp-stats">
      <div><span>${te('perps.render_market.mark')}</span><strong data-s="mark"></strong></div>
      <div><span>${te('perps.render_market.index')}</span><strong data-s="index"></strong></div>
      <div><span>${te('perps.render_market.funding')}</span><strong data-s="funding"></strong><em class="faint" data-s="countdown"></em></div>
      <div><span>${te('perps.render_market.open_interest')}</span><strong data-s="oi"></strong></div>
      <div><span>${te('perps.render_market.n24h_volume')}</span><strong data-s="vol"></strong></div>
      <div><span>${te('perps.render_market.max_leverage')}</span><strong>${lev(maxLev)}</strong></div>
    </div>
    <div class="perps-layout">
      <div class="perps-main">
        <section class="card perps-box perps-chart-card">
          <div class="perps-chart-head"><span class="faint">${te('perps.render_market.mark_price')}</span><div class="perps-seg" role="tablist" data-testid="perp-ranges">${Object.keys(RANGES).map((k) => `<button data-range="${esc(k)}" class="${k === range ? 'on' : ''}">${esc(k)}</button>`).join('')}</div></div>
          <div class="perps-chart" data-testid="perp-chart"></div>
        </section>
        <div class="perps-duo">
          <section class="card perps-box"><h3 class="perps-box-title">${te('perps.render_market.order_book')}</h3><div class="perps-book" data-testid="perp-book"></div></section>
          <section class="card perps-box"><h3 class="perps-box-title">${te('perps.render_market.recent_trades')}</h3><div class="perps-trades" data-testid="perp-trades"></div></section>
        </div>
        ${authed ? `<section class="card perps-box perps-account" data-testid="perp-account">
          <div class="perps-tabs" role="tablist">${[['positions', tx('perps.render_market.positions')], ['orders', tx('perps.render_market.open_orders')], ['funding', tx('perps.render_market.funding')], ['history', tx('perps.render_market.history')]].map(([k, l]) => `<button data-tab="${esc(k)}" class="${k === tab ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>
          <div data-testid="perp-panel" class="perps-panel"></div></section>` : ''}
        <section class="card perps-box perps-about"><h3 class="perps-box-title">${te('perps.render_market.about', { title: esc(m.title) })}</h3><p class="muted">${esc(m.product_metadata?.description || '')}</p>
          <dl class="perps-dl"><div><dt>${te('perps.render_market.contract_size')}</dt><dd>${n(m.contract_size)} ${esc(m.product_metadata?.unit === 'pct' ? tx('perps.render_market.index_points') : tx('perps.render_market.units'))}</dd></div><div><dt>${te('perps.render_market.tick')}</dt><dd>${te('perps.render_market.per_contract', { money: esc(money(m.tick_size, { exact: 4 })) })}</dd></div><div><dt>${te('perps.render_market.initial_maintenance_margin')}</dt><dd>${(m.initial_margin_rate * 100).toFixed(2)}% / ${(m.maintenance_margin_rate * 100).toFixed(2)}%</dd></div><div><dt>${te('perps.render_market.fees_maker_taker')}</dt><dd>${(m.maker_fee_rate * 100).toFixed(2)}% / ${(m.taker_fee_rate * 100).toFixed(2)}%</dd></div><div><dt>${te('perps.render_market.funding_schedule')}</dt><dd>${te('perps.render_market.every_h', { value: Math.round(m.funding_interval_ms / 3600000) || '<1' })} <span class="faint">(${esc(m.product_metadata?.funding_schedule || '')})</span></dd></div><div><dt>${te('perps.render_market.index')}</dt><dd>${esc(m.product_metadata?.index_provider || '')}</dd></div></dl></section>
      </div>
      <aside class="perps-side-col">
        <section class="card perps-box perps-ticket" data-testid="perp-ticket">
          ${authed ? ticketHtml() : `<h3 class="perps-box-title">${te('perps.render_market.trade', { title: esc(m.title) })}</h3><p class="muted">${te('perps.render_market.log_in_to_go_long')}</p><a class="btn btn-primary perps-submit" href="/sign-in?next=/perps/${esc(m.ticker)}" data-link>${te('perps.render_market.log_in_to_trade')}</a>`}
        </section>
        ${authed ? transferBox() : ''}
      </aside>
    </div></div>`;
  const root = el.firstElementChild;
  const live = () => root.isConnected; // async work may finish after the user navigated away
  const $ = (s) => root.querySelector(s);

  function ticketHtml() {
    return `<div class="perps-seg perps-side-seg" data-testid="perp-side">${['long', 'short'].map((s) => `<button data-side="${s}" class="${s === t.side ? `on ${s}` : ''}">${s === 'long' ? te('perps.render_market.long_2') : te('perps.render_market.short')}</button>`).join('')}</div>
      <div class="perps-seg sm" data-testid="perp-type">${['market', 'limit'].map((s) => `<button data-type="${s}" class="${s === t.type ? 'on' : ''}">${s === 'market' ? te('perps.render_market.market') : te('perps.render_market.limit')}</button>`).join('')}</div>
      <label class="perps-field" data-limit hidden><span>${te('perps.render_market.limit_price')}</span><input id="pt-price" type="number" step="any" inputmode="decimal" data-testid="perp-limit-price" aria-label="${te('perps.render_market.limit_price')}"></label>
      <div class="perps-field"><span>${te('perps.render_market.amount')} <span class="perps-unit" data-testid="perp-unit">${['usd', 'contracts'].map((u) => `<button type="button" data-unit="${u}" class="${u === t.unit ? 'on' : ''}">${u === 'usd' ? esc(sym()) : te('perps.render_market.contracts')}</button>`).join('')}</span></span>
        <input id="pt-amount" type="number" min="0" step="any" inputmode="decimal" placeholder="0" data-testid="perp-amount" aria-label="${te('perps.render_market.amount')}"></div>
      <div class="perps-field"><span>${te('perps.render_market.leverage')} <output id="pt-lev-out" data-testid="perp-leverage-out">${lev(t.lev)}</output></span>
        <input id="pt-lev" type="range" min="1" max="${maxLev}" step="1" value="${t.lev}" data-testid="perp-leverage" aria-label="${te('perps.render_market.leverage')}">
        <div class="perps-lev-marks faint"><span>1x</span><span>${lev(Math.round(maxLev / 2))}</span><span>${lev(maxLev)}</span></div></div>
      <label class="perps-check" data-market-only><input type="checkbox" id="pt-reduce" data-testid="perp-reduce-only"> ${te('perps.render_market.reduce_only')}</label>
      <dl class="perps-summary" data-testid="perp-summary">
        <div><dt>${te('perps.render_market.contracts')}</dt><dd data-o="contracts">—</dd></div>
        <div><dt>${te('perps.render_market.total_size')}</dt><dd data-o="notional">—</dd></div>
        <div><dt>${te('perps.render_market.cost_margin')}</dt><dd data-o="cost">—</dd></div>
        <div><dt>${te('perps.render_market.est_fees')}</dt><dd data-o="fees">—</dd></div>
        <div><dt>${te('perps.render_market.est_liq_price')}</dt><dd data-o="liq" data-testid="perp-est-liq">—</dd></div>
        <div><dt>${te('perps.render_market.perps_available')}</dt><dd data-o="avail" data-testid="perp-available-ticket">—</dd></div>
      </dl>
      <button class="btn btn-primary perps-submit" id="pt-submit" data-testid="perp-submit" disabled>${te('perps.render_market.long', { title: esc(m.title) })}</button>
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
    s('countdown').textContent = m.funding_rate?.next_funding_time_ms ? tx('perps.render_market.in', { countdown: countdown(m.funding_rate.next_funding_time_ms) }) : '';
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
    if (!series.length) { box.innerHTML = `<div class="empty faint">${te('perps.render_market.no_price_history_yet')}</div>`; return; }
    const W = 600; const H = 220; const pad = 6;
    const ys = series.map((p) => p[1]);
    const lo = Math.min(...ys); const hi = Math.max(...ys);
    const span = hi - lo || hi * 0.001 || 1;
    const x0 = series[0][0]; const x1 = series[series.length - 1][0] || x0 + 1;
    const X = (x) => pad + ((x - x0) / Math.max(1, x1 - x0)) * (W - 2 * pad);
    const Y = (y) => pad + (1 - (y - lo) / span) * (H - 2 * pad);
    const pts = series.map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(' ');
    const up = ys[ys.length - 1] >= ys[0];
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="perps-svg ${up ? 'up' : 'down'}" role="img" aria-label="${te('perps.render_market.mark_price_chart', { title: esc(m.title) })}">
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
    const row = (l, side) => `<button type="button" class="perps-lvl ${esc(side)}" data-px="${esc(l[0])}"${vars({ '--perps-depth': `${((n(l[1]) / maxQ) * 100).toFixed(1)}%` })}><span>${fmtPx(m, l[0])}</span><span>${n(l[1]).toLocaleString('en-US')}</span></button>`;
    const spread = b.asks.length && b.bids.length ? n(b.asks[0][0]) - n(b.bids[0][0]) : null;
    $('[data-testid=perp-book]').innerHTML = `<div class="perps-lvl head faint"><span>${te('perps.render_market.price')}</span><span>${te('perps.render_market.contracts')}</span></div>
      <div data-testid="perp-asks">${asks.map((l) => row(l, 'ask')).join('') || `<div class="faint">${te('perps.render_market.no_asks')}</div>`}</div>
      <div class="perps-spread faint">${te('perps.render_market.mark_2', { fmt_px: fmtPx(m, m.mark_price), value: spread != null ? (' ' + te('perps.render_market.spread', { fmt_level: fmtLevel(m, spread / n(m.contract_size)) })) : '' })}</div>
      <div data-testid="perp-bids">${bids.map((l) => row(l, 'bid')).join('') || `<div class="faint">${te('perps.render_market.no_bids')}</div>`}</div>`;
  }
  let trades = tr.trades;
  function drawTrades() {
    $('[data-testid=perp-trades]').innerHTML = trades.length ? `<div class="perps-lvl trade head faint"><span>${te('perps.render_market.price')}</span><span>${te('perps.render_market.size')}</span><span>${te('perps.render_market.time')}</span></div>${trades.slice(0, 18).map((x) => `<div class="perps-lvl trade ${x.taker_side === 'bid' ? 'bid' : 'ask'}"><span>${fmtPx(m, x.price)}${x.is_liquidation ? ` <em class="faint">${te('perps.render_market.liq')}</em>` : ''}</span><span>${n(x.count).toLocaleString('en-US')}</span><span class="faint">${time(x.created_time)}</span></div>`).join('')}` : `<div class="empty faint">${te('perps.render_market.no_trades_yet')}</div>`;
  }

  // ---- ticket
  function calc() {
    if (!authed) return null;
    const amount = t.unit === 'usd' ? assetToApi(n($('#pt-amount').value)) : n($('#pt-amount').value); // display money → API dollars
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
    o('fees').textContent = c.contracts ? money(c.fees, { exact: isNgn() ? 2 : 4 }) : '—';
    o('liq').textContent = c.liq && c.liq > 0 ? fmtPx(m, c.liq) : '—';
    o('avail').textContent = bal ? money(bal.available_dollars) : '—';
    const btn = $('#pt-submit');
    btn.disabled = !c.contracts;
    btn.textContent = `${t.reduce ? tx('perps.render_market.reduce') : t.side === 'long' ? tx('perps.render_market.long_2') : tx('perps.render_market.short')} ${m.title}${c.contracts ? ` · ${c.contracts.toLocaleString('en-US')}` : ''}`;
    btn.className = `btn perps-submit ${t.side}`;
    el.querySelector('[data-limit]').hidden = t.type !== 'limit';
    el.querySelector('[data-market-only]').hidden = t.type !== 'market';
  }
  function wireTicket() {
    if (!authed) return;
    for (const b of el.querySelectorAll('[data-side]')) b.onclick = () => { t.side = b.dataset.side; for (const x of el.querySelectorAll('[data-side]')) x.className = x === b ? `on ${t.side}` : ''; drawTicket(); };
    for (const b of el.querySelectorAll('[data-type]')) b.onclick = () => {
      t.type = b.dataset.type; for (const x of el.querySelectorAll('[data-type]')) x.classList.toggle('on', x === b);
      if (t.type === 'limit') { t.reduce = false; $('#pt-reduce').checked = false; if (!$('#pt-price').value) $('#pt-price').value = lvlFromApi(m, under(m, m.mark_price)).toFixed(lvlDec(m)); }
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
      $('#pt-price').value = lvlFromApi(m, under(m, b.dataset.px)).toFixed(lvlDec(m));
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
        toast(o.status === 'resting' ? tx('perps.render_market.limit_order_placed_at', { n: n(o.remaining_count), fmt_px: fmtPx(m, o.price) }) : n(o.fill_count) ? tx('perps.render_market.filled_at', { n: n(o.fill_count), fmt_px: fmtPx(m, o.average_fill_price) }) : tx('perps.render_market.order_was_not_filled'));
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
      panel.innerHTML = liquidationsHtml(liquidations.filter((l) => l.ticker === m.ticker), metas) + `<h4 class="perps-sub">${te('perps.render_market.trades')}</h4>${fillsHtml(fills, metas)}`;
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
  const clock = setInterval(() => { const c = el.querySelector('[data-s=countdown]'); if (c && m.funding_rate?.next_funding_time_ms) c.textContent = tx('perps.render_market.in', { countdown: countdown(m.funding_rate.next_funding_time_ms) }); }, 1000);
  void navigate;
  return () => { unsubs.forEach((u) => u()); unsubXfer(); refreshSoon.cancel(); clearInterval(clock); };
}

// ================================================================ portfolio (Perps product)
export async function renderPerpsPortfolio({ el, query, navigate }) {
  if (!session.user) { navigate(`/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`, { replace: true }); return undefined; }
  document.title = tx('perps.render_perps_portfolio.perps_portfolio_parlance');
  let tab = PERPS_TABS.some(([k]) => k === query.get('perpsTab')) ? query.get('perpsTab') : 'positions';
  const { markets } = await P.markets();
  const metas = new Map(markets.map((m) => [m.ticker, m]));
  let positions = [];
  el.innerHTML = `<div class="perps perps-portfolio" data-testid="perps-portfolio">
    <div class="page-head"><h1 class="page-title">${te('perps.render_perps_portfolio.portfolio')}</h1></div>
    <nav class="perps-product" aria-label="${te('perps.render_perps_portfolio.product')}"><a href="/portfolio" data-link data-testid="product-predictions">${te('perps.render_perps_portfolio.predictions')}</a><a href="/portfolio?perpsTab=positions" data-link class="on" data-testid="product-perps">${te('perps.render_perps_portfolio.perps')}</a></nav>
    <div class="perps-stat-row">
      <div class="card perps-stat"><span>${te('perps.render_perps_portfolio.account_equity')}</span><strong data-testid="perps-equity">—</strong></div>
      <div class="card perps-stat"><span>${te('perps.render_perps_portfolio.available')}</span><strong data-testid="perps-port-available">—</strong></div>
      <div class="card perps-stat"><span>${te('perps.render_perps_portfolio.unrealized_pnl')}</span><strong data-testid="perps-upnl">—</strong></div>
      <div class="card perps-stat"><span>${te('perps.render_perps_portfolio.margin_in_use')}</span><strong data-testid="perps-margin">—</strong></div>
    </div>
    <div class="perps-layout">
      <div class="perps-main"><section class="card perps-box">
        <div class="perps-tabs" role="tablist" data-testid="perps-port-tabs">${PERPS_TABS.map(([k, l]) => `<button data-ptab="${esc(k)}" class="${k === tab ? 'on' : ''}">${esc(l)}</button>`).join('')}<a class="btn btn-sm btn-ghost perps-tabs-link" href="/perps" data-link>${te('perps.render_perps_portfolio.browse_perps')}</a></div>
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
      p.innerHTML = `${liquidationsHtml(liquidations, metas)}<h4 class="perps-sub">${te('perps.render_perps_portfolio.trades')}</h4>${fillsHtml(fills, metas)}<h4 class="perps-sub">${te('perps.render_perps_portfolio.funding_payments')}</h4>${fundingHtml(fh, metas)}${transfersHtml(transfers)}`;
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

