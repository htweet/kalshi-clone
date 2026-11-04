// Portfolio (spec §4.6, §17.6, §17.9): balance, funds; tabs Positions (incl. open combos) | Resting | RFQs | Quotes |
// History (unified timeline + the trade / settlement / transaction tables as sub-views), CSV exports.
import { t as tx, te, ts } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import { slotImg } from '../content-live.js';
import '../content/portfolio-strings.js';
import { t as T } from '../content/currency-strings.js'; // keyed wording (CLONE_SPEC.md §30)
import { api } from '../api.js';
import { session } from '../store.js';
import { socket } from '../ws.js';
import { esc, money, qty, toast, relTime, secsLeft, validQty, px, ccOf, ccDollars, pxc, priceUnit, sym, amountLabel, moneyStep, moneyMin, toApiDollars, validMoneyInput, moneyInputHint, fmtDay, fmtDateTime } from '../lib.js';
import { renderPerpsPortfolio } from './perps.js';
import { ocAvatar } from './components.js';
import { uiPrefs } from '../prefs.js'; // Settings › Market preview price type (CLONE_SPEC.md §25.8)

// Observed tab set ["position","resting","rfqs","quotes","history"]; data-tab values keep the earlier names.
const TABS = [['positions', ts('portfolio.tabs.positions')], ['orders', ts('portfolio.tabs.resting')], ['rfqs', 'RFQs'], ['quotes', ts('portfolio.tabs.quotes')], ['history', ts('portfolio.tabs.history')]];
const HVIEWS = [['timeline', ts('portfolio.hviews.timeline')], ['fills', ts('portfolio.hviews.trade_history')], ['settlements', ts('portfolio.hviews.settlements')], ['transactions', ts('portfolio.hviews.transactions')]];
const HTYPES = [['all', ts('portfolio.htypes.all')], ['trades', ts('portfolio.htypes.trades')], ['orders', ts('portfolio.htypes.orders')], ['settlements', ts('portfolio.htypes.settlements')], ['combos', ts('portfolio.htypes.combos_rfq')], ['cash', ts('portfolio.htypes.cash')]];
const PSORTS = [['value', ts('portfolio.psorts.value')], ['pnl', 'P&L'], ['closing', ts('portfolio.psorts.closing_soon')]];
const PFILTERS = [['all', ts('portfolio.pfilters.all')], ['open', ts('portfolio.pfilters.open')], ['closing', ts('portfolio.pfilters.closing_soon')], ['combos', 'Combos']];
const signed = (d) => (d == null ? '' : `<span class="${Number(d) > 0 ? 'amt-pos' : Number(d) < 0 ? 'amt-neg' : ''}">${Number(d) > 0 ? '+' : ''}${money(d)}</span>`);
const QSTATUS = { open: 'Open', accepted: 'Accepted', confirmed: 'Confirmed', executed: 'Executed', expired: 'Expired', cancelled: 'Cancelled' };
const sizeLabel = (x) => (x.contracts_fp != null ? `${qty(x.contracts_fp)} contracts` : `${money(x.target_cost_dollars)} target`);
const legChips = (legs) => `<div class="leg-chips">${legs.map((l) => `<span class="leg-chip ${esc(l.leg_status)}" data-leg-status="${esc(l.leg_status)}"><b class="${l.side === 'yes' ? 'leg-yes' : 'leg-no'}">${esc(l.side.toUpperCase())}</b> ${esc(l.outcome)}</span>`).join('')}</div>`;

export async function render({ el, navigate, query }) {
  if (query && query.get('perpsTab')) return renderPerpsPortfolio({ el, navigate, query }); // Perps product (PERPS_SPEC_SECTION.md)
  if (!session.user) { navigate('/sign-in?next=/portfolio', { replace: true }); return undefined; }
  document.title = tx('portfolio.render.portfolio_parlance');
  // portfolio_view holds the tab, or a History sub-view (fills / settlements / transactions) for older values.
  const isView = (v) => TABS.some(([k]) => k === v) || HVIEWS.some(([k]) => k === v && k !== 'timeline');
  const deep = query && query.get('tab');
  const view0 = isView(deep) ? deep : isView(session.props.portfolio_view) ? session.props.portfolio_view : 'positions';
  let tab = TABS.some(([k]) => k === view0) ? view0 : 'history';
  let hview = tab === 'history' && view0 !== 'history' ? view0 : 'timeline';
  if (deep && deep === view0 && deep !== session.props.portfolio_view) session.setProp('portfolio_view', deep).catch(() => {});
  const hf0 = session.props.history_filters || {};
  const hist = { type: HTYPES.some(([k]) => k === hf0.type) ? hf0.type : 'all', market: String(hf0.market || ''), from: hf0.from || '', to: hf0.to || '', cursor: '', ids: new Set() };
  let posSort = PSORTS.some(([k]) => k === session.props.positions_sort) ? session.props.positions_sort : 'value';
  let posFilter = PFILTERS.some(([k]) => k === session.props.positions_filter) ? session.props.positions_filter : 'all';
  let rfqScope = query && query.get('scope') === 'others' ? 'others' : 'mine'; // deep link /portfolio?tab=rfqs&scope=others
  const uid = session.uid;

  el.innerHTML = `<div class="page-head"><h1 class="page-title">${te('portfolio.render.portfolio')}</h1></div>
    <div class="stat-row">
      <div class="card stat"><div class="label">${te('portfolio.render.cash_available')}</div><div class="value" id="s-cash" data-testid="cash">—</div></div>
      <div class="card stat"><div class="label">${te('portfolio.render.positions_value')}</div><div class="value" id="s-value" data-testid="positions-value">—</div></div>
      <div class="card stat"><div class="label">${te('portfolio.render.held_for_open_orders')}</div><div class="value" id="s-reserved" data-testid="reserved">—</div></div>
      <form class="card stat" id="funds" aria-label="${te('portfolio.render.move_funds')}">
        <div class="label">${te('portfolio.render.demo_funds')} <a href="/funds" data-link data-testid="portfolio-transfers">${te('portfolio.render.deposit_or_withdraw')}</a></div>
        <div class="d-flex fw-wrap gap-6 mt-6"><input id="f-amount" class="amount-input" type="number" min="${esc(moneyMin())}" step="${esc(moneyStep())}" placeholder="${esc(T('input.amount_placeholder', { symbol: sym() }))}" aria-label="${esc(T('input.amount_aria', { mode: amountLabel().toLowerCase() }))}">
          <button class="btn btn-primary" data-act="deposit" type="submit">${te('portfolio.render.deposit')}</button><button class="btn" data-act="withdraw" type="button">${te('portfolio.render.withdraw')}</button></div>
        <div class="form-error" id="f-error" role="alert"></div>
      </form>
    </div>
    <div class="tabs" role="tablist" id="pf-tabs">${TABS.map(([k, l]) => `<button data-tab="${esc(k)}" class="${k === tab ? 'on' : ''}">${esc(l)}</button>`).join('')}
      <a class="btn btn-ghost ml-auto" href="/portfolio?perpsTab=positions" data-link data-testid="perps-portfolio-link">${te('portfolio.render.perps')}</a><a class="btn btn-ghost" href="${esc(api.csvUrl(uid))}" download data-testid="csv-link">${te('portfolio.render.export_csv')}</a></div>
    <div class="card p-4-12" id="panel"></div>`;

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
      await drawPositions(p);
    } else if (tab === 'orders') {
      await drawResting(p);
    } else if (tab === 'rfqs') {
      await drawRfqs(p);
    } else if (tab === 'quotes') {
      await drawQuotes(p);
    } else {
      await drawHistory(p);
    }
  }

  // ---------- Positions (spec §17.11): summary, grouped holdings, sort/filter, Sell sheet ----------
  async function drawPositions(p) {
    const [r, combos, coll] = await Promise.all([api.portfolioPositions(uid, { sort: posSort, filter: posFilter }), api.myCombos(uid), api.collateralReturns(uid).catch(() => null)]);
    const S = r.summary;
    const stat = (label, v, id, sign) => `<div><span class="label">${esc(label)}</span><strong data-testid="${esc(id)}">${sign ? signed(v) || money(0) : money(v)}</strong></div>`;
    const state = (x) => (x.state === 'open' ? `<span class="faint">${te('portfolio.render.closes', { fmt_day: esc(fmtDay(x.close_time)) })}</span>` : x.state === 'settling' ? `<span class="status-chip accepted">${te('portfolio.render.settling', { to_upper_case: esc(String(x.result).toUpperCase()) })}</span>` : `<span class="status-chip">${esc(x.market_status)}</span>`);
    const row = (x) => `<tr data-ticker="${esc(x.ticker)}" ${x.is_combo ? `data-combo="${esc(x.ticker)}"` : ''} data-state="${esc(x.state)}">
      <td><a class="pos-outcome" href="${esc(x.link)}" data-link>${ocAvatar({ yes_sub_title: x.is_combo ? '◇' : x.outcome, color_code: x.color_code }, 'sm')}<span>${esc(x.is_combo ? x.market_title : x.outcome)}</span></a>${x.legs ? legChips(x.legs) : ''}</td>
      <td><strong class="c-${esc(x.side)}">${esc(x.side.toUpperCase())}</strong></td><td class="num" data-testid="p-qty">${qty(x.position_fp)}</td>
      <td class="num">${esc(px(x.avg_price_dollars))}</td><td class="num" data-testid="p-cost">${money(x.cost_basis_dollars)}</td><td class="num" data-testid="p-mark" data-price-type="${esc(uiPrefs.market_price_type)}">${uiPrefs.market_price_type === 'current_buy' ? (x.buy_price_dollars == null ? '—' : esc(px(x.buy_price_dollars))) : esc(px(x.mark_price_dollars))}</td>
      <td class="num" data-testid="p-value">${money(x.market_value_dollars)}</td><td class="num" data-testid="p-upnl">${signed(x.unrealized_pnl_dollars) || money(0)}${x.unrealized_pnl_pct != null ? ` <span class="faint">${esc(x.unrealized_pnl_pct)}%</span>` : ''}</td>
      <td class="num" data-testid="p-rpnl">${signed(x.realized_pnl_dollars) || money(0)}</td><td class="num" data-testid="p-payout">${money(x.payout_if_win_dollars)}</td>
      <td class="num" data-testid="p-sell">${x.state === 'open' ? money(x.sell_value_dollars) : '—'}</td><td class="num" data-testid="p-orders">${esc(x.resting_orders || '')}</td><td>${state(x)}</td>
      <td class="row-actions">${x.market_status === 'active' ? `<button class="btn btn-sm" data-sell="${esc(x.ticker)}">${te('portfolio.render.sell')}</button><a class="btn btn-sm btn-ghost" data-link data-buy-more href="${esc(x.link)}?market=${encodeURIComponent(x.ticker)}&side=${esc(x.side)}">${te('portfolio.render.buy_more')}</a><button class="btn btn-sm" data-close="${esc(x.ticker)}" data-side="${x.side === 'yes' ? 'no' : 'yes'}" data-count="${Number(x.position_fp)}">${te('portfolio.render.close')}</button>` : ''}</td></tr>`;
    const empty = posFilter === 'all' ? `<div class="empty" data-testid="no-positions">${slotImg('empty.portfolio', 'empty-art')}${te('portfolio.render.no_open_positions')} <a href="/browse" data-link>${te('portfolio.render.find_a_market')}</a></div>` : `<div class="empty" data-testid="no-positions-filtered">${te('portfolio.render.no_positions_match_this_filter')}</div>`;
    p.innerHTML = `<div class="pos-summary" data-testid="pos-summary">${stat(tx('portfolio.render.total_value'), S.total_value_dollars, 'pos-total')}${stat(tx('portfolio.render.cash'), S.cash_dollars, 'pos-cash')}${stat(tx('portfolio.render.positions'), S.positions_value_dollars, 'pos-value')}${stat(tx('portfolio.render.today'), S.today_change_dollars, 'pos-today', true)}${stat(tx('portfolio.render.all_time_p_l'), S.all_time_pnl_dollars, 'pos-pnl', true)}${Number(S.collateral_returned_dollars) ? stat(tx('portfolio.render.collateral_returned'), S.collateral_returned_dollars, 'pos-collateral') : ''}</div>
      ${coll && coll.events.length ? `<section class="card collateral-card" data-testid="collateral-card"><h3>${te('portfolio.render.collateral_returned_early')}</h3><p class="faint">${te('portfolio.render.your_positions_across_these_mutually', { value: coll.enabled ? '' : (' ' + te('portfolio.render.collateral_return_is_off_in')) })}</p>
        ${coll.events.map((c) => `<div class="tkt-row" data-collateral-event="${esc(c.event_ticker)}"><span>${esc(c.title)} <span class="faint">· ${esc(c.positions.map((x) => `${x.side.toUpperCase()} ${x.outcome} ${qty(x.position_fp)}`).join(', '))}</span></span><strong class="num" data-testid="collateral-amount">${money(c.returned_dollars)}</strong></div>`).join('')}</section>` : ''}
      <div class="pf-sub"><div class="hist-chips">${PFILTERS.map(([k, l]) => `<button class="chip ${k === posFilter ? 'on' : ''}" data-pfilter="${esc(k)}" aria-pressed="${k === posFilter}">${esc(l)}</button>`).join('')}</div>
        <span class="faint">${te('portfolio.render.open_combos')} <span data-testid="open-combo-count">${esc(combos.total_open_combos)}</span></span>
        <label class="book-setting">${te('portfolio.render.sort')} <select id="pos-sort" data-testid="pos-sort">${PSORTS.map(([k, l]) => `<option value="${esc(k)}" ${k === posSort ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label></div>
      ${r.events.length ? `<table class="table positions-table" data-testid="positions-table"><thead><tr><th>${te('portfolio.render.outcome')}</th><th>${te('portfolio.render.side')}</th><th class="num">${te('portfolio.render.contracts')}</th><th class="num">${te('portfolio.render.avg')}</th><th class="num">${te('portfolio.render.cost_incl_fees')}</th><th class="num" data-testid="p-mark-head">${uiPrefs.market_price_type === 'current_buy' ? te('portfolio.render.buy_now') : te('portfolio.render.mark')}</th><th class="num">${te('portfolio.render.value')}</th><th class="num">${te('portfolio.render.unrealized')}</th><th class="num">${te('portfolio.render.realized')}</th><th class="num">${te('portfolio.render.payout_if_right')}</th><th class="num">${te('portfolio.render.sell_now')}</th><th class="num">${te('portfolio.render.orders')}</th><th>${te('portfolio.render.status')}</th><th></th></tr></thead><tbody>
        ${r.events.map((g) => `<tr class="group-row" data-event-group="${esc(g.event_ticker)}"><td colspan="14"><a href="${esc(g.link)}" data-link>${esc(g.title)}</a></td></tr>${g.positions.map(row).join('')}`).join('')}</tbody></table>` : empty}
      ${combos.settled_combos.length ? `<div class="pf-sub"><strong>${te('portfolio.render.settled_combos')}</strong></div><table class="table" data-testid="settled-combos"><thead><tr><th>${te('portfolio.render.combo')}</th><th>${te('portfolio.render.result')}</th><th class="num">${te('portfolio.render.cost')}</th><th class="num">${te('portfolio.render.payout')}</th></tr></thead><tbody>
      ${combos.settled_combos.map((c) => `<tr data-combo="${esc(c.market_ticker)}"><td><a href="${esc(c.link)}" data-link>${esc(c.title)}</a>${legChips(c.legs)}</td><td>${esc(c.result.toUpperCase())}</td><td class="num">${money(c.cost_dollars)}</td><td class="num">${money(c.payout_dollars)}</td></tr>`).join('')}</tbody></table>` : ''}`;
    for (const b of p.querySelectorAll('[data-pfilter]')) b.onclick = () => { posFilter = b.dataset.pfilter; session.setProp('positions_filter', posFilter).catch(() => {}); drawPanel(); };
    p.querySelector('#pos-sort').onchange = (e) => { posSort = e.target.value; session.setProp('positions_sort', posSort).catch(() => {}); drawPanel(); };
    for (const b of p.querySelectorAll('[data-close]')) {
      b.onclick = async () => {
        // Closing = buying the opposite side; netting returns $1 per pair (spec §4.3 book semantics).
        b.disabled = true;
        try { const res = await api.submitOrder(uid, { ticker: b.dataset.close, side: b.dataset.side, count: Number(b.dataset.count), type: 'market' }); toast(tx('portfolio.render.closed_contracts', { qty: qty(res.order.fill_count_fp) })); }
        catch (e) { toast(e.message, 'error'); }
        refresh();
      };
    }
    const byT = new Map(r.events.flatMap((g) => g.positions).map((x) => [x.ticker, x]));
    for (const b of p.querySelectorAll('[data-sell]')) b.onclick = () => openSellSheet(byT.get(b.dataset.sell));
  }
  // Sell sheet: partial or Max, market (walks the book; server estimate) or limit; goes through the normal sell path.
  let sheetOpen = false;
  function openSellSheet(x) {
    const step = x.fractional_trading_enabled ? '0.01' : '1';
    const held = Number(x.position_fp);
    const S = esc(x.side.toUpperCase());
    const wrap = document.createElement('div');
    wrap.className = 'sheet-backdrop';
    wrap.innerHTML = `<section class="card sheet" role="dialog" aria-label="${te('portfolio.render.sell_position')}" data-testid="sell-sheet"><div class="combo-mini-head"><h3>${te('portfolio.render.sell_2', { s: S, value: esc(x.is_combo ? x.market_title : x.outcome) })}</h3><button class="icon-btn" data-sheet-close aria-label="${te('portfolio.render.close')}">×</button></div>
      <div class="tkt-row"><span>${te('portfolio.render.you_hold')}</span><strong>${qty(x.position_fp)} ${S}</strong></div>
      <label class="tkt-input">${te('portfolio.render.contracts')}<input id="s-count" type="number" min="${step}" step="${step}" value="${held}" inputmode="decimal"></label><button class="btn btn-sm" data-testid="sell-max" type="button">${te('portfolio.render.max')}</button>
      <label class="tkt-input tkt-select">${te('portfolio.render.order')}<select id="s-type"><option value="market">${te('portfolio.render.market')}</option><option value="limit">${te('portfolio.render.limit')}</option></select></label>
      <label class="tkt-input" id="s-price-wrap" hidden>${esc(T('input.limit_price', { unit: priceUnit() }))}<input id="s-price" type="number" min="0.01" max="99.99" step="${x.price_level_structure && x.price_level_structure !== 'linear_cent' ? '0.01' : '1'}" value="${Math.max(1, ccOf(x.mark_price_dollars) / 100)}"></label>
      <div data-testid="sell-estimate" class="faint"></div><div class="form-error" id="s-error" role="alert"></div>
      <button class="cta" data-testid="sell-submit">${te('portfolio.render.sell_3', { s: S })}</button></section>`;
    el.appendChild(wrap); sheetOpen = true;
    const $s = (q) => wrap.querySelector(q);
    const close = () => { wrap.remove(); sheetOpen = false; };
    $s('[data-sheet-close]').onclick = close;
    wrap.onclick = (e) => { if (e.target === wrap) close(); };
    let seq = 0;
    const estimate = async () => {
      const c = Number($s('#s-count').value); const type = $s('#s-type').value; const pxv = Number($s('#s-price').value);
      $s('#s-price-wrap').hidden = type !== 'limit';
      const ok = c > 0 && c <= held && (/^\d+(\.\d{1,2})?$/.test($s('#s-count').value)) && (x.fractional_trading_enabled || Number.isInteger(c) || c === held);
      $s('[data-testid=sell-submit]').disabled = !ok || (type === 'limit' && !(pxv > 0 && pxv < 100 && Math.abs(Math.round(pxv * 100) - pxv * 100) < 1e-6));
      if (!ok) { $s('[data-testid=sell-estimate]').textContent = tx('portfolio.render.enter_up_to_contracts', { qty: qty(x.position_fp), value: x.fractional_trading_enabled ? (' ' + tx('portfolio.render.n2_decimals')) : '' }); return; }
      if (type === 'limit') { $s('[data-testid=sell-estimate]').textContent = T('portfolio.proceeds_at', { price: pxc(Math.round(pxv * 100)), amount: money((c * pxv) / 100) }); return; }
      const my = ++seq;
      try { const q = await api.sellQuote(uid, x.ticker, c.toFixed(2)); if (my === seq) $s('[data-testid=sell-estimate]').innerHTML = `${te('portfolio.render.est_proceeds')} <strong data-testid="sell-proceeds">${money(q.proceeds_dollars)}</strong> ${te('portfolio.render.fee', { money: money(q.fee_dollars), value: q.complete ? '' : (' ' + te('portfolio.render.only_can_fill_now', { qty: qty(q.fillable_fp) })) })}`; } catch (e) { $s('[data-testid=sell-estimate]').textContent = e.message; }
    };
    $s('#s-count').oninput = estimate; $s('#s-price').oninput = estimate; $s('#s-type').onchange = estimate;
    $s('[data-testid=sell-max]').onclick = () => { $s('#s-count').value = String(held); estimate(); };
    $s('[data-testid=sell-submit]').onclick = async () => {
      const btn = $s('[data-testid=sell-submit]'); btn.disabled = true; $s('#s-error').textContent = '';
      const type = $s('#s-type').value;
      try {
        const res = await api.submitOrder(uid, { ticker: x.ticker, side: x.side, action: 'sell', type, count: Number($s('#s-count').value), ...(type === 'limit' ? { price: Number($s('#s-price').value) } : {}) });
        toast(tx('portfolio.render.sold', { qty: qty(res.order.fill_count_fp), s: S, value: res.order.status === 'resting' ? tx('portfolio.render.listed', { qty: qty(res.order.remaining_count_fp) }) : '' }));
        close(); refresh();
      } catch (e) { $s('#s-error').textContent = e.message; btn.disabled = false; }
    };
    estimate();
  }

  // ---------- History (spec §17.9) ----------
  const histQs = () => new URLSearchParams(Object.entries({ type: hist.type, market: hist.market, from: hist.from, to: hist.to }).filter(([, v]) => v && v !== 'all')).toString();
  const histRow = (r) => `<tr data-hrow="${esc(r.id)}" data-type="${esc(r.type)}" data-group="${esc(r.group)}"><td class="faint" title="${esc(r.time)}">${esc(fmtDateTime(r.time))}</td>
    <td><span class="hist-badge ${esc(r.group)}">${esc(r.type_label)}</span></td>
    <td>${r.market_ticker ? (r.link ? `<a href="${esc(r.link)}" data-link>${esc(r.market_title || r.market_ticker)}</a>` : esc(r.market_title || r.market_ticker)) : '<span class="faint">—</span>'}<div class="faint hist-desc">${esc(r.description)}</div></td>
    <td>${r.side ? `<strong class="c-${esc(r.side)}">${esc(r.action ? r.action.toUpperCase() + ' ' : '')}${esc(r.side.toUpperCase())}</strong>` : ''}</td>
    <td class="num">${r.quantity_fp != null ? qty(r.quantity_fp) : ''}</td><td class="num">${r.price_dollars != null ? esc(px(r.price_dollars)) : ''}</td>
    <td class="num" data-amount="${esc(r.amount_dollars ?? '')}">${signed(r.amount_dollars)}</td><td class="num">${r.fee_dollars ? signed(r.fee_dollars) : ''}</td><td><span class="status-chip ${esc(r.status)}">${esc(r.status || '')}</span></td></tr>`;
  async function drawHistory(p) {
    const seg = `<div class="pf-sub"><div class="seg" role="tablist" aria-label="${te('portfolio.render.history_view')}">${HVIEWS.map(([k, l]) => `<button data-hview="${esc(k)}" ${k === 'timeline' ? '' : `data-tab="${esc(k)}"`} class="${k === hview ? 'on' : ''}">${esc(l)}</button>`).join('')}</div></div>`;
    if (hview === 'timeline') {
      const r = await api.history(uid, { ...Object.fromEntries(new URLSearchParams(histQs())), limit: 25 });
      hist.cursor = r.cursor; hist.ids = new Set(r.history.map((x) => x.id));
      p.innerHTML = `${seg}<div class="hist-filters" data-testid="history-filters"><div class="hist-chips">${HTYPES.map(([k, l]) => `<button class="chip ${k === hist.type ? 'on' : ''}" data-htype="${esc(k)}" aria-pressed="${k === hist.type}">${esc(l)}</button>`).join('')}</div>
        <div class="hist-inputs"><input type="search" id="h-market" placeholder="${te('portfolio.render.search_market')}" aria-label="${te('portfolio.render.search_market')}" value="${esc(hist.market)}"><label>${te('portfolio.render.from')} <input type="date" id="h-from" value="${esc(hist.from)}"></label><label>${te('portfolio.render.to')} <input type="date" id="h-to" value="${esc(hist.to)}"></label>
        <a class="btn btn-ghost" id="h-csv" data-testid="history-csv" href="${esc(api.historyCsvUrl(uid, histQs()))}" download>${te('portfolio.render.download_csv')}</a></div></div>
        ${r.history.length ? `<table class="table" data-testid="history-table"><thead><tr><th>${te('portfolio.render.time')}</th><th>${te('portfolio.render.type')}</th><th>${te('portfolio.render.market')}</th><th>${te('portfolio.render.side')}</th><th class="num">${te('portfolio.render.qty')}</th><th class="num">${te('portfolio.render.price')}</th><th class="num">${te('portfolio.render.amount')}</th><th class="num">${te('portfolio.render.fee_2')}</th><th>${te('portfolio.render.status')}</th></tr></thead><tbody id="h-rows">${r.history.map(histRow).join('')}</tbody></table>` : `<div class="empty" data-testid="history-empty">${te('portfolio.render.no_activity_matches_these_filters')}</div>`}
        ${r.cursor ? `<button class="btn mx-auto-12 d-block" id="h-more" data-testid="history-more">${te('portfolio.render.load_more')}</button>` : ''}`;
      const save = () => session.setProp('history_filters', { type: hist.type, market: hist.market, from: hist.from, to: hist.to }).catch(() => {});
      for (const b of p.querySelectorAll('[data-htype]')) b.onclick = () => { hist.type = b.dataset.htype; save(); drawPanel(); };
      let mt = null;
      p.querySelector('#h-market').oninput = (e) => { clearTimeout(mt); mt = setTimeout(() => { hist.market = e.target.value.trim(); save(); drawPanel().then(() => { const i = $('#h-market'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }); }, 350); };
      p.querySelector('#h-from').onchange = (e) => { hist.from = e.target.value; save(); drawPanel(); };
      p.querySelector('#h-to').onchange = (e) => { hist.to = e.target.value; save(); drawPanel(); };
      const more = p.querySelector('#h-more');
      if (more) {
        more.onclick = async () => {
          more.disabled = true;
          const n = await api.history(uid, { ...Object.fromEntries(new URLSearchParams(histQs())), limit: 25, cursor: hist.cursor });
          const fresh = n.history.filter((x) => !hist.ids.has(x.id));
          fresh.forEach((x) => hist.ids.add(x.id));
          p.querySelector('#h-rows').insertAdjacentHTML('beforeend', fresh.map(histRow).join(''));
          hist.cursor = n.cursor;
          if (n.cursor) more.disabled = false; else more.remove();
        };
      }
    } else {
      p.innerHTML = seg + '<div id="hview-body"></div>';
      await drawLegacy(p.querySelector('#hview-body'), hview);
    }
    for (const b of p.querySelectorAll('[data-hview]')) {
      b.onclick = () => { hview = b.dataset.hview; session.setProp('portfolio_view', hview === 'timeline' ? 'history' : hview).catch(() => {}); drawPanel(); };
    }
  }
  // Live: new activity is prepended to the first page without losing loaded pages or filters.
  async function liveHistory() {
    const rows = $('#h-rows');
    if (!rows) return drawPanel();
    const r = await api.history(uid, { ...Object.fromEntries(new URLSearchParams(histQs())), limit: 25 });
    const fresh = r.history.filter((x) => !hist.ids.has(x.id));
    fresh.forEach((x) => hist.ids.add(x.id));
    if (fresh.length) rows.insertAdjacentHTML('afterbegin', fresh.map(histRow).join(''));
    return undefined;
  }

  async function drawLegacy(p, view) {
    if (view === 'fills') {
      const { fills } = await api.fills(uid);
      p.innerHTML = fills.length ? `<table class="table" data-testid="fills-table"><thead><tr><th>${te('portfolio.render.time')}</th><th>${te('portfolio.render.market')}</th><th>${te('portfolio.render.side')}</th><th class="num">${te('portfolio.render.price')}</th><th class="num">${te('portfolio.render.contracts')}</th><th class="num">${te('portfolio.render.fee_2')}</th><th>${te('portfolio.render.role')}</th></tr></thead><tbody>
        ${fills.map((f) => `<tr><td>${esc(fmtDateTime(f.created_time))}</td><td>${esc(f.ticker)}</td><td>${esc(f.side.toUpperCase())}</td><td class="num">${esc(px(f.price_dollars))}</td><td class="num">${qty(f.count_fp)}</td><td class="num">${money(f.fee_dollars)}</td><td>${f.is_taker ? te('portfolio.render.taker') : te('portfolio.render.maker')}</td></tr>`).join('')}</tbody></table>`
        : `<div class="empty">${te('portfolio.render.no_trades_yet')}</div>`;
    } else if (view === 'settlements') {
      const { settlements } = await api.settlements(uid);
      p.innerHTML = settlements.length ? `<table class="table" data-testid="settlements-table"><thead><tr><th>${te('portfolio.render.settled')}</th><th>${te('portfolio.render.market')}</th><th>${te('portfolio.render.result')}</th><th class="num">${te('portfolio.render.yes')}</th><th class="num">${te('portfolio.render.no')}</th><th class="num">${te('portfolio.render.cost')}</th><th class="num">${te('portfolio.render.payout')}</th></tr></thead><tbody>
        ${settlements.map((s) => `<tr><td>${esc(fmtDateTime(s.settled_time))}</td><td>${esc(s.market_title)}</td><td>${esc(s.market_result.toUpperCase())}</td><td class="num">${qty(s.yes_count_fp)}</td><td class="num">${qty(s.no_count_fp)}</td><td class="num">${money(s.cost_dollars)}</td><td class="num">${money(s.revenue_dollars)}</td></tr>`).join('')}</tbody></table>`
        : `<div class="empty">${te('portfolio.render.no_settled_markets_yet')}</div>`;
    } else {
      const { transactions } = await api.transactions(uid);
      p.innerHTML = transactions.length ? `<table class="table" data-testid="transactions-table"><thead><tr><th>${te('portfolio.render.time')}</th><th>${te('portfolio.render.type')}</th><th>${te('portfolio.render.memo')}</th><th class="num">${te('portfolio.render.amount')}</th></tr></thead><tbody>
        ${transactions.map((t) => `<tr><td>${esc(fmtDateTime(t.created_time))}</td><td>${esc(t.kind)}</td><td>${esc(t.memo)}</td><td class="num">${money(t.amount_dollars)}</td></tr>`).join('')}</tbody></table>`
        : `<div class="empty">${te('portfolio.render.no_transactions_yet')}</div>`;
    }
  }

  // ---------- Resting (spec §17.10): grouped by event / market, amend, decrease, cancel, cancel all ----------
  const fp2 = (x) => Number(x || 0).toFixed(2);
  const endOfDay = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d.toISOString(); };
  async function drawResting(p) {
    const { orders } = await api.orders(uid, 'resting');
    if (!orders.length) { p.innerHTML = `<div class="empty" data-testid="no-orders">${te('portfolio.render.no_resting_orders')}</div>`; return; }
    const held = orders.reduce((a, o) => a + Number(o.reserved_dollars || 0), 0);
    const byEvent = new Map();
    for (const o of orders) {
      if (!byEvent.has(o.event_ticker)) byEvent.set(o.event_ticker, { title: o.event_title, link: o.link, markets: new Map() });
      const ev = byEvent.get(o.event_ticker);
      if (!ev.markets.has(o.ticker)) ev.markets.set(o.ticker, { outcome: o.outcome, orders: [] });
      ev.markets.get(o.ticker).orders.push(o);
    }
    const row = (o) => `<tr data-order="${esc(o.order_id)}" data-ticker="${esc(o.ticker)}"><td>${esc(o.outcome)}</td>
      <td><strong class="c-${esc(o.user_side)}">${esc(o.user_action.toUpperCase())} ${esc(o.user_side.toUpperCase())}</strong></td>
      <td class="num" data-testid="o-price">${esc(px(o.user_price_dollars))}</td><td class="num" data-testid="o-filled">${fp2(o.fill_count_fp)} / ${fp2(o.initial_count_fp)}</td>
      <td class="num" data-testid="o-remaining">${fp2(o.remaining_count_fp)}</td><td class="num">${money(o.reserved_dollars)}</td><td class="num" data-testid="o-queue">${fp2(o.queue_position_fp)}</td>
      <td class="faint">${relTime(o.created_time)}</td><td data-testid="o-expiry">${o.expiration_time ? countdown(o.expiration_time) : `<span class="faint">${te('portfolio.render.gtc')}</span>`}</td><td><span class="status-chip open">${esc(o.status)}</span></td>
      <td class="row-actions"><button class="btn btn-sm" data-edit="${esc(o.order_id)}">${te('portfolio.render.edit')}</button><button class="btn btn-sm" data-decrease="${esc(o.order_id)}">${te('portfolio.render.decrease')}</button><button class="btn btn-sm" data-cancel="${esc(o.order_id)}">${te('portfolio.render.cancel')}</button></td></tr>`;
    p.innerHTML = `<div class="pf-sub"><strong><span data-testid="resting-count">${orders.length}</span> ${te('portfolio.render.resting_held', { money: money(held) })}</strong><button class="btn" data-testid="cancel-all">${te('portfolio.render.cancel_all')}</button></div>
      <table class="table resting-table" data-testid="orders-table"><thead><tr><th>${te('portfolio.render.outcome')}</th><th>${te('portfolio.render.side')}</th><th class="num">${te('portfolio.render.limit')}</th><th class="num">${te('portfolio.render.filled_total')}</th><th class="num">${te('portfolio.render.remaining')}</th><th class="num">${te('portfolio.render.reserved')}</th><th class="num">${te('portfolio.render.queue')}</th><th>${te('portfolio.render.placed')}</th><th>${te('portfolio.render.expires')}</th><th>${te('portfolio.render.status')}</th><th></th></tr></thead><tbody>
      ${[...byEvent.entries()].map(([et, ev]) => `<tr class="group-row" data-event-group="${esc(et)}"><td colspan="11"><a href="${esc(ev.link)}" data-link>${esc(ev.title)}</a></td></tr>
        ${[...ev.markets.entries()].map(([t, mk]) => `<tr class="group-row sub" data-market-group="${esc(t)}"><td colspan="11"><span>${te('portfolio.render.order_2', { outcome: esc(mk.outcome), value: mk.orders.length, value_2: mk.orders.length > 1 ? 's' : '' })}</span> <button class="btn btn-sm btn-ghost" data-cancel-market="${esc(t)}">${te('portfolio.render.cancel_market')}</button></td></tr>${mk.orders.map(row).join('')}`).join('')}`).join('')}</tbody></table>`;
    const byId = new Map(orders.map((o) => [o.order_id, o]));
    const closeForms = () => p.querySelectorAll('.edit-row').forEach((r) => r.remove());
    for (const b of p.querySelectorAll('[data-cancel]')) {
      b.onclick = async () => { b.disabled = true; try { await api.cancelOrder(uid, b.dataset.cancel); toast(tx('portfolio.render.order_canceled')); } catch (e) { toast(e.message, 'error'); } refresh(); };
    }
    for (const b of p.querySelectorAll('[data-cancel-market]')) {
      b.onclick = async () => { b.disabled = true; try { const r = await api.cancelAllOrders(uid, { market_ticker: b.dataset.cancelMarket }); toast(tx('portfolio.render.canceled_order', { canceled_count: r.canceled_count, value: r.canceled_count === 1 ? '' : 's' })); } catch (e) { toast(e.message, 'error'); } refresh(); };
    }
    p.querySelector('[data-testid=cancel-all]').onclick = async () => {
      if (!window.confirm(tx('portfolio.render.cancel_all_resting_orders', { value: orders.length }))) return;
      try { const r = await api.cancelAllOrders(uid); toast(tx('portfolio.render.canceled_orders', { canceled_count: r.canceled_count })); } catch (e) { toast(e.message, 'error'); }
      refresh();
    };
    const formRow = (o, html) => { closeForms(); p.querySelector(`tr[data-order="${CSS.escape(o.order_id)}"]`).insertAdjacentHTML('afterend', `<tr class="edit-row" data-edit-row="${esc(o.order_id)}"><td colspan="11">${html /* eslint-disable-line parlance/no-unescaped-html -- form markup built by the amend/decrease callers from esc()'d values */}<div class="form-error" role="alert"></div></td></tr>`); return p.querySelector('.edit-row'); };
    for (const b of p.querySelectorAll('[data-edit]')) {
      b.onclick = () => {
        const o = byId.get(b.dataset.edit);
        const step = o.fractional_trading_enabled ? '0.01' : '1';
        const r = formRow(o, `<form novalidate class="quote-form edit-form" data-edit-form="${esc(o.order_id)}"><label>${esc(T('input.price', { unit: priceUnit() }))} <input name="price" type="number" min="0.01" max="99.99" step="any" value="${ccOf(o.user_price_dollars) / 100}"></label>
          <label>${te('portfolio.render.total_contracts')} <input name="count" type="number" min="${step}" step="${step}" value="${Number(o.initial_count_fp)}"></label>
          <label>${te('portfolio.render.expires')} <select name="exp"><option value="keep">${o.expiration_time ? te('portfolio.render.keep') : te('portfolio.render.never_gtc')}</option><option value="never">${te('portfolio.render.never')}</option><option value="eod">${te('portfolio.render.end_of_day')}</option><option value="custom">${te('portfolio.render.custom')}</option></select></label><input name="at" type="datetime-local" hidden aria-label="${te('portfolio.render.expiry_time')}">
          <button class="btn btn-sm btn-primary" type="submit">${te('portfolio.render.save')}</button><button class="btn btn-sm btn-ghost" type="button" data-close-edit>${te('portfolio.render.close')}</button><span class="faint">${te('portfolio.render.changing_the_price_or_adding')}</span></form>`);
        const f = r.querySelector('form'); const err = r.querySelector('.form-error');
        f.exp.onchange = () => { f.at.hidden = f.exp.value !== 'custom'; };
        r.querySelector('[data-close-edit]').onclick = closeForms;
        f.onsubmit = async (e) => {
          e.preventDefault(); err.textContent = '';
          const price = Number(f.price.value); const count = Number(f.count.value);
          const pcc = Math.round(price * 100); // sub-cent grids allow decimals; the server checks the market's ticks
          if (!(pcc >= 1 && pcc <= 9999) || Math.abs(pcc - price * 100) > 1e-6 || (price < 1 || price > 99) && Number.isInteger(price)) { err.textContent = T('error.price_between', { min: pxc(100), max: pxc(9900) }); return; }
          if (!validQty(count, o.fractional_trading_enabled) || count <= Number(o.fill_count_fp)) { err.textContent = tx('portfolio.render.total_must_be_more_than', { fp2: fp2(o.fill_count_fp), value: o.fractional_trading_enabled ? (' ' + tx('portfolio.render.up_to_2_decimals')) : (' ' + tx('portfolio.render.and_a_whole_number')) }); return; }
          const body = { price_dollars: ccDollars(pcc), count_fp: count.toFixed(2) };
          if (f.exp.value === 'never') body.expiration_time = null;
          if (f.exp.value === 'eod') body.expiration_time = endOfDay();
          if (f.exp.value === 'custom') { const t = Date.parse(f.at.value); if (!(t > Date.now())) { err.textContent = tx('portfolio.render.pick_an_expiry_time_in'); return; } body.expiration_time = new Date(t).toISOString(); }
          try { const res = await api.amendOrder(uid, o.order_id, body); toast(tx('portfolio.render.order_amended', { value: res.queue_priority_kept ? tx('portfolio.render.queue_position_kept') : tx('portfolio.render.moved_to_the_back_of') })); refresh(); } catch (ex) { err.textContent = ex.message; }
        };
      };
    }
    for (const b of p.querySelectorAll('[data-decrease]')) {
      b.onclick = () => {
        const o = byId.get(b.dataset.decrease);
        const step = o.fractional_trading_enabled ? '0.01' : '1';
        const r = formRow(o, `<form novalidate class="quote-form" data-decrease-form="${esc(o.order_id)}"><label>${te('portfolio.render.reduce_remaining_to')} <input name="to" type="number" min="0" step="${step}" value="${Math.max(0, Number(o.remaining_count_fp) - 1)}"></label><button class="btn btn-sm btn-primary" type="submit">${te('portfolio.render.decrease')}</button><button class="btn btn-sm btn-ghost" type="button" data-close-edit>${te('portfolio.render.close')}</button><span class="faint">${te('portfolio.render.decreasing_keeps_your_place_in')}</span></form>`);
        const f = r.querySelector('form'); const err = r.querySelector('.form-error');
        r.querySelector('[data-close-edit]').onclick = closeForms;
        f.onsubmit = async (e) => {
          e.preventDefault(); err.textContent = '';
          const to = Number(f.to.value);
          if (!(f.to.value !== '' && to >= 0 && to < Number(o.remaining_count_fp) && (to === 0 || validQty(to, o.fractional_trading_enabled)))) { err.textContent = tx('portfolio.render.enter_a_size_below', { fp2: fp2(o.remaining_count_fp), value: o.fractional_trading_enabled ? '' : (' ' + tx('portfolio.render.whole_contracts')) }); return; }
          try { await api.decreaseOrder(uid, o.order_id, { reduce_to: to.toFixed(2) }); toast(to ? tx('portfolio.render.order_decreased_queue_position_kept') : tx('portfolio.render.order_canceled')); refresh(); } catch (ex) { err.textContent = ex.message; }
        };
      };
    }
  }

  // ---------- RFQs (spec §17.6): yours vs other traders' ----------
  const fmtLeft = (n) => (n < 120 ? `${n}s` : n < 3600 ? `${Math.floor(n / 60)}m ${n % 60}s` : `${Math.floor(n / 3600)}h ${Math.floor((n % 3600) / 60)}m`);
  const countdown = (iso, prefix = '') => `<span class="countdown" data-countdown="${esc(iso)}" data-prefix="${esc(prefix)}">${esc(prefix)}${fmtLeft(secsLeft(iso))}</span>`;
  async function drawRfqs(p) {
    const r = await api.rfqs(rfqScope);
    const enabled = !!r.rfq_enabled;
    const head = `<div class="pf-sub rfq-head"><div class="seg" role="tablist" aria-label="${te('portfolio.render.rfq_scope')}"><button data-rfq-scope="mine" class="${rfqScope === 'mine' ? 'on' : ''}">${te('portfolio.render.yours')}</button><button data-rfq-scope="others" class="${rfqScope === 'others' ? 'on' : ''}" data-testid="rfq-others">${te('portfolio.render.other_rfqs')}</button></div>
      <label class="book-setting"><input type="checkbox" data-testid="rfq-enabled" id="rfq-enabled" ${enabled ? 'checked' : ''}> ${te('portfolio.render.answer_rfqs_from_other_traders')}</label></div>`;
    if (rfqScope === 'mine') {
      p.innerHTML = head + (r.rfqs.length ? `<table class="table" data-testid="rfqs-table"><thead><tr><th>${te('portfolio.render.market')}</th><th>${te('portfolio.render.size')}</th><th>${te('portfolio.render.status')}</th><th>${te('portfolio.render.age')}</th><th>${te('portfolio.render.quotes')}</th><th></th></tr></thead><tbody>
        ${r.rfqs.map((x) => {
          const open = x.quotes.filter((q) => q.status === 'open');
          const pending = x.quotes.find((q) => ['accepted', 'confirmed'].includes(q.status));
          const done = x.quotes.find((q) => q.status === 'executed');
          const quotes = x.status === 'open' ? open.map((q) => `<div class="rfq-quote" data-quote="${esc(q.id)}">${q.buy_yes_price_dollars ? `<button class="btn btn-sm yes-pill" data-accept="${esc(q.id)}" data-rfq-id="${esc(x.id)}" data-side="no">${te('portfolio.render.buy_yes', { px: esc(px(q.buy_yes_price_dollars)), qty: qty(q.no_contracts_fp), value: q.hvm ? (' ' + te('portfolio.render.hvm')) : '' })}</button>` : ''}
              ${q.buy_no_price_dollars ? `<button class="btn btn-sm no-pill" data-accept="${esc(q.id)}" data-rfq-id="${esc(x.id)}" data-side="yes">${te('portfolio.render.buy_no', { px: esc(px(q.buy_no_price_dollars)), qty: qty(q.yes_contracts_fp), value: q.hvm ? (' ' + te('portfolio.render.hvm')) : '' })}</button>` : ''}
              <span class="faint">${q.is_system_maker ? te('portfolio.render.parlance_maker') : te('portfolio.render.trader')} · ${countdown(q.expires_time)}</span></div>`).join('') || `<span class="faint">${te('portfolio.render.waiting_for_quotes')}</span>`
            : pending ? `<span data-testid="awaiting-confirm">${te('portfolio.render.accepted', { value: pending.status === 'confirmed' ? te('portfolio.render.confirming') : te('portfolio.render.waiting_for_maker', { countdown: countdown(pending.confirm_deadline_time) }) })}</span>`
              : done ? `<span>${te('portfolio.render.executed_contracts', { qty: qty(done.executed_contracts_fp) })}</span>` : '<span class="faint">—</span>';
          return `<tr data-rfq="${esc(x.id)}" data-status="${esc(x.status)}"><td><a href="${esc(x.link)}" data-link>${esc(x.market_title)}</a></td><td>${sizeLabel(x)}</td><td><span class="status-chip ${esc(x.status)}">${QSTATUS[x.status] || esc(x.status)}</span></td><td class="faint">${relTime(x.created_time)}</td><td>${quotes}</td>
            <td>${['open', 'accepted'].includes(x.status) ? `<button class="btn btn-sm" data-cancel-rfq="${esc(x.id)}">${te('portfolio.render.cancel')}</button>` : ''}</td></tr>`;
        }).join('')}</tbody></table>` : `<div class="empty" data-testid="no-rfqs">${te('portfolio.render.no_rfqs_yet_request_a')} <a href="/combos" data-link>${te('portfolio.render.combo_builder')}</a>.</div>`);
    } else if (!enabled) {
      p.innerHTML = head + `<div class="empty" data-testid="rfq-disabled">${te('portfolio.render.turn_on_answer_rfqs_from')}</div>`;
    } else {
      p.innerHTML = head + (r.rfqs.length ? `<table class="table" data-testid="other-rfqs-table"><thead><tr><th>${te('portfolio.render.market')}</th><th>${te('portfolio.render.size')}</th><th>${te('portfolio.render.age')}</th><th>${te('portfolio.render.your_quote')}</th><th>${esc(T('input.quote', { unit: priceUnit() }))}</th></tr></thead><tbody>
        ${r.rfqs.map((x) => `<tr data-rfq="${esc(x.id)}" data-status="${esc(x.status)}"><td><a href="${esc(x.link)}" data-link>${esc(x.market_title)}</a></td><td>${sizeLabel(x)}</td><td class="faint">${relTime(x.created_time)}</td>
          <td>${x.my_quote ? `<span class="status-chip ${esc(x.my_quote.status)}" data-testid="my-quote-status">${QSTATUS[x.my_quote.status]}</span> <span class="faint">${te('portfolio.render.yes_no', { px: esc(px(x.my_quote.yes_bid_dollars)), px_2: esc(px(x.my_quote.no_bid_dollars)), value: x.my_quote.hvm ? (' ' + te('portfolio.render.hvm_3_s')) : '' })}</span>` : '<span class="faint">—</span>'}</td>
          <td>${x.status === 'open' ? `<form novalidate class="quote-form" data-quote-form="${esc(x.id)}"><input name="yes" type="number" min="0" max="99.99" step="${x.is_combo ? '0.1' : '1'}" placeholder="${te('portfolio.render.yes_bid')}" aria-label="${esc(T('input.yes_bid', { unit: priceUnit() }))}" data-testid="quote-yes"><input name="no" type="number" min="0" max="99.99" step="${x.is_combo ? '0.1' : '1'}" placeholder="${te('portfolio.render.no_bid')}" aria-label="${esc(T('input.no_bid', { unit: priceUnit() }))}" data-testid="quote-no"><label class="book-setting" title="${te('portfolio.render.high_volume_maker_a_3')}"><input type="checkbox" name="hvm" data-testid="quote-hvm"> ${te('portfolio.render.hvm_3_s_2')}</label><button class="btn btn-sm btn-primary" type="submit">${te('portfolio.render.send_quote')}</button><div class="form-error" role="alert"></div></form>` : `<span class="faint">${te('portfolio.render.accepted_by_requester')}</span>`}</td></tr>`).join('')}</tbody></table>`
        : `<div class="empty" data-testid="no-other-rfqs">${te('portfolio.render.no_open_rfqs_from_other')}</div>`);
    }
    for (const b of p.querySelectorAll('[data-rfq-scope]')) b.onclick = () => { rfqScope = b.dataset.rfqScope; drawPanel(); };
    p.querySelector('#rfq-enabled').onchange = async (e) => { await session.setProp('rfq_enabled', e.target.checked).catch((x) => toast(x.message, 'error')); drawPanel(); };
    for (const b of p.querySelectorAll('[data-accept]')) {
      b.onclick = async () => {
        b.disabled = true;
        try { await api.acceptQuote(b.dataset.rfqId, b.dataset.accept, b.dataset.side); toast(tx('portfolio.render.quote_accepted_waiting_for_the')); } catch (e) { toast(e.message, 'error'); }
        drawPanel();
      };
    }
    for (const b of p.querySelectorAll('[data-cancel-rfq]')) b.onclick = async () => { b.disabled = true; try { await api.cancelRfq(b.dataset.cancelRfq); toast(tx('portfolio.render.rfq_cancelled')); } catch (e) { toast(e.message, 'error'); } drawPanel(); };
    for (const f of p.querySelectorAll('[data-quote-form]')) {
      f.onsubmit = async (e) => {
        e.preventDefault();
        const err = f.querySelector('.form-error');
        err.textContent = '';
        const y = f.yes.value === '' ? 0 : Number(f.yes.value); const n = f.no.value === '' ? 0 : Number(f.no.value);
        const fine = !!r.rfqs.find((x) => x.id === f.dataset.quoteForm)?.is_combo; // combos quote on the finer grid (G12)
        const okBid = (v) => v >= 0 && v < 100 && (fine ? Math.abs(Math.round(v * 100) - v * 100) < 1e-6 : Number.isInteger(v));
        if (![y, n].every(okBid)) { err.textContent = fine ? T('error.bids_fine', { min: pxc(0), max: pxc(9999), step: pxc(10), fine: pxc(1), edge: pxc(100) }) : T('error.bids_whole', { min: pxc(0), max: pxc(9900) }); return; }
        if (!y && !n) { err.textContent = tx('portfolio.render.quote_at_least_one_side'); return; }
        if (y + n > 100) { err.textContent = T('error.bids_exceed', { max: pxc(10000) }); return; }
        try { await api.createQuote({ rfq_id: f.dataset.quoteForm, yes_bid: ccDollars(Math.round(y * 100)), no_bid: ccDollars(Math.round(n * 100)), ...(f.hvm.checked ? { hvm: true } : {}) }); toast(f.hvm.checked ? tx('portfolio.render.hvm_quote_sent_3_s') : tx('portfolio.render.quote_sent')); drawPanel(); } catch (ex) { err.textContent = ex.message; }
      };
    }
  }
  // ---------- Quotes: ones you made and ones on your RFQs ----------
  async function drawQuotes(p) {
    const { quotes } = await api.quotes();
    p.innerHTML = quotes.length ? `<table class="table" data-testid="quotes-table"><thead><tr><th>${te('portfolio.render.role')}</th><th>${te('portfolio.render.market')}</th><th class="num">${te('portfolio.render.yes_bid')}</th><th class="num">${te('portfolio.render.no_bid')}</th><th>${te('portfolio.render.size')}</th><th>${te('portfolio.render.status')}</th><th></th></tr></thead><tbody>
      ${quotes.map((q) => {
        const mine = q.role === 'maker';
        const action = mine && q.status === 'accepted' ? `<button class="btn btn-sm btn-primary" data-confirm="${esc(q.id)}">${te('portfolio.render.confirm_order', { countdown: countdown(q.confirm_deadline_time) })}</button>`
          : mine && q.status === 'open' ? `<button class="btn btn-sm" data-delete-quote="${esc(q.id)}">${te('portfolio.render.delete')}</button> <span class="faint">${countdown(q.expires_time)}</span>`
            : q.status === 'executed' ? `<span class="faint">${te('portfolio.render.contracts_2', { qty: qty(q.executed_contracts_fp) })}</span>` : '';
        const size = q.rfq_contracts_fp != null ? `${qty(q.rfq_contracts_fp)} contracts` : `${money(q.rfq_target_cost_dollars)} target`;
        return `<tr data-quote-row="${esc(q.id)}" data-status="${esc(q.status)}"><td>${mine ? te('portfolio.render.you_quoted') : te('portfolio.render.on_your_rfq')}</td><td><a href="${esc(q.link)}" data-link>${esc(q.market_title)}</a></td><td class="num">${esc(px(q.yes_bid_dollars))}</td><td class="num">${esc(px(q.no_bid_dollars))}</td><td>${size}${q.hvm ? ` <span class="status-chip" data-testid="hvm-chip">${te('portfolio.render.hvm_3_s_2')}</span>` : ''}</td>
          <td><span class="status-chip ${esc(q.status)}">${QSTATUS[q.status]}</span>${q.accepted_side ? ` <span class="faint">${te('portfolio.render.side_2', { to_upper_case: esc(q.accepted_side.toUpperCase()) })}</span>` : ''}</td><td>${action}</td></tr>`;
      }).join('')}</tbody></table>` : `<div class="empty" data-testid="no-quotes">${te('portfolio.render.no_quotes_yet')}</div>`;
    for (const b of p.querySelectorAll('[data-confirm]')) {
      b.onclick = async () => {
        b.disabled = true; b.textContent = tx('portfolio.render.confirming');
        try { await api.confirmQuote(b.dataset.confirm); toast(tx('portfolio.render.quote_executed')); } catch (e) { toast(e.message, 'error'); }
        drawPanel(); drawStats();
      };
    }
    for (const b of p.querySelectorAll('[data-delete-quote]')) b.onclick = async () => { b.disabled = true; try { await api.deleteQuote(b.dataset.deleteQuote); toast(tx('portfolio.render.quote_deleted')); } catch (e) { toast(e.message, 'error'); } drawPanel(); };
  }

  async function drawPanelLive() {
    if (tab === 'history' && hview === 'timeline') return liveHistory();
    if (sheetOpen) return undefined;
    if (el.querySelector('#panel input:focus')) return undefined; // don't wipe a quote or search being typed
    return drawPanel();
  }
  async function refresh() { await Promise.all([drawStats(), drawPanelLive()]); }

  for (const b of el.querySelectorAll('#pf-tabs [data-tab]')) {
    b.onclick = () => {
      tab = b.dataset.tab;
      for (const x of el.querySelectorAll('#pf-tabs [data-tab]')) x.classList.toggle('on', x === b);
      session.setProp('portfolio_view', tab === 'history' && hview !== 'timeline' ? hview : tab).catch(() => {});
      drawPanel();
    };
  }
  const move = async (act) => {
    const err = $('#f-error');
    err.textContent = '';
    const raw = $('#f-amount').value;
    if (!validMoneyInput(raw)) { err.textContent = T('error.amount_positive', { zero: money(0), hint: moneyInputHint() }); return; }
    const amt = toApiDollars(raw); // naira ÷ 100 = the API's dollars (CLONE_SPEC.md §30)
    try {
      const r = await (act === 'deposit' ? api.deposit(uid, amt) : api.withdraw(uid, amt));
      // A withdrawal the risk score holds for review answers 202 {status: 'held'} (CLONE_SPEC.md §25.6).
      toast(r && r.status === 'held' ? tx('portfolio.render.withdrawal_of_is_under_review', { money: money(amt) }) : `${act === 'deposit' ? tx('portfolio.render.deposited') : tx('portfolio.render.withdrew')} ${money(amt)}`);
      $('#f-amount').value = '';
      refresh();
    } catch (e) { err.textContent = e.message; }
  };
  $('#funds').onsubmit = (e) => { e.preventDefault(); move('deposit'); };
  el.querySelector('[data-act="withdraw"]').onclick = () => move('withdraw');

  await refresh();
  let commsT = null;
  let tickT = null;
  const unsubs = [
    socket.subscribe({ channels: ['user_orders'] }, () => refresh().catch(() => {})),
    socket.subscribe({ channels: ['user_balance'] }, () => refresh().catch(() => {})),
    // RFQ / quote events update the RFQs, Quotes and Combos tabs live (spec §17.6).
    socket.subscribe({ channels: ['communications'] }, () => {
      if (!['rfqs', 'quotes', 'history', 'positions'].includes(tab)) return;
      clearTimeout(commsT); commsT = setTimeout(() => drawPanelLive().catch(() => {}), 120);
    }),
    // New fills and settlements reach History live (settlements arrive as notifications + balance updates).
    socket.subscribe({ channels: ['fill'] }, () => { if (tab === 'history') liveHistory().catch(() => {}); }),
    // Positions re-mark live on price moves (debounced).
    socket.subscribe({ channels: ['ticker'] }, () => { if (tab !== 'positions') return; clearTimeout(tickT); tickT = setTimeout(() => drawPanelLive().catch(() => {}), 400); }),
    socket.subscribe({ channels: ['notifications'] }, () => { if (tab === 'history') liveHistory().catch(() => {}); }),
  ];
  // Countdowns tick locally; an expired countdown triggers a refetch (the server sweep owns the status).
  const iv = setInterval(() => {
    let due = false;
    for (const c of el.querySelectorAll('[data-countdown]')) { const n = secsLeft(c.dataset.countdown); c.textContent = `${c.dataset.prefix || ''}${fmtLeft(n)}`; if (n === 0) due = true; }
    if (due) { clearTimeout(commsT); commsT = setTimeout(() => drawPanel().catch(() => {}), 900); }
  }, 1000);
  return () => { unsubs.forEach((u) => u()); clearInterval(iv); clearTimeout(commsT); clearTimeout(tickT); };
}
