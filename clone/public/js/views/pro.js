// Pro trading terminal (owner design 2026-11-15, CLONE_SPEC.md §15.6). One page of arrangeable panels for active traders:
//   screener   open markets filtered by category, closing time, volume, spread and 24-hour move; sortable; live over the
//              ticker channel; the filters save as named screens per member (GET/POST/PUT/DELETE /v1/users/:uid/pro/screens)
//   chart      candlesticks with volume for 1H / 1D / 1W / ALL (GET /v1/pro/candles), with the shared hover readout
//   ladder     live depth at each YES price (YES bids, and NO bids shown at the YES price they offer); a click loads the
//              ticket at that price
//   ticket     quick ticket with keyboard shortcuts — B buy, S sell, Y / N side, Enter review, Esc cancel — never while
//              typing in a field; the review step of the event ticket, skipped only with one-click trading
//   orders / positions / tape / alerts   open orders (amend, cancel), positions (close at market or at the bid), the
//              selected market's trades, its price alerts
// Panels can be dragged (or moved with the layout menu) and shown / hidden; the layout is stored per member in the database
// (PUT /v1/users/:uid/pro/preferences) and follows the member to another browser. Signed-out visitors see the screener,
// charts, ladder and trades; the trading panels ask them to sign in.
// One-click safety rule: one-click trading is off by default, switching it on the first time asks the member to confirm, and the owner can
// switch it off for everyone (the `trading.one_click` flag; the preference is shared with the event ticket's 1-Click switch). An order placed without the review step says so to the server
// (X-Plx-One-Click), which refuses it unless both the flag and the member's preference are on (server/pro.js).
import { t as tx, te, ts } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/pro-strings.js';
import { t as T } from '../content/currency-strings.js';
import { vars } from '../dynstyle.js';
import { api } from '../api.js';
import { session } from '../store.js';
import { socket } from '../ws.js';
import { flagOn, ownerSetting } from '../flags.js';
import { hoverAttr, installChartHover } from '../chart-hover.js';
import { esc, ccOf, ccDollars, eventHref, qty, catLabel, CATEGORIES, pxc, px, money, priceUnit, onGrid, minTickCc, snapCc, feeDollars, validQty, fmtDt, toast, cents, prob, pxCents } from '../lib.js';

const PANELS = ['screener', 'chart', 'ladder', 'ticket', 'orders', 'positions', 'tape', 'alerts'];
const TRADING = new Set(['ticket', 'orders', 'positions', 'alerts']); // ask signed-out visitors to sign in
const TFS = ['1H', '1D', '1W', 'ALL'];
const COLS = [['title', ts('pro.cols.market')], ['bid', ts('pro.cols.bid')], ['ask', ts('pro.cols.ask')], ['last', ts('pro.cols.last')], ['chg', ts('pro.cols.change')], ['vol', ts('pro.cols.volume')], ['spread', ts('pro.cols.spread')], ['close', ts('pro.cols.closes')]];
const CLOSES = [['', ts('pro.filters.any_time')], ['24', ts('pro.filters.within_day')], ['168', ts('pro.filters.within_week')], ['720', ts('pro.filters.within_month')]];
const FILTER_KEYS = ['category', 'closes_within_hours', 'min_volume', 'max_spread_cents', 'min_move_cents'];
const typingIn = (el) => !!(el && el.closest && el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));

export async function render({ el, query }) {
  document.title = tx('pro.render.pro_parlance');
  // Owner setting `pro.layout` (Admin › Owner settings, recommended "terminal"): the classic screener table instead.
  if (ownerSetting('pro.layout', 'terminal') === 'classic') return renderClassic({ el });
  const uid = session.user ? session.uid : null;
  const state = {
    filters: { category: '', closes_within_hours: '', min_volume: '', max_spread_cents: '', min_move_cents: '' },
    rows: [], total: 0, sort: ['vol', -1],
    selected: null, market: null,
    layout: { order: [...PANELS], hidden: [], chart_tf: '1D' },
    screens: [], activeScreen: null, prefs: null,
    book: { yes: new Map(), no: new Map() },
    tkt: { action: 'buy', side: 'yes', type: 'limit', price: null, count: 10 },
    review: null, trades: [], amending: null,
  };
  if (uid) {
    const [p, s] = await Promise.all([api.proPrefs(uid).catch(() => null), api.proScreens(uid).catch(() => ({ screens: [] }))]);
    state.prefs = p ? p.preferences : null;
    state.screens = s.screens || [];
    if (state.prefs && state.prefs.layout) state.layout = { chart_tf: '1D', ...state.prefs.layout };
    if (state.prefs && state.prefs.layout && state.prefs.layout.sort) state.sort = [state.prefs.layout.sort.key, state.prefs.layout.sort.dir];
    const active = state.prefs && state.screens.find((x) => x.id === state.prefs.active_screen_id);
    if (active) { state.activeScreen = active.id; state.filters = filtersForm(active.filters); }
  }
  const oneClickOn = () => !!(uid && state.prefs && state.prefs.one_click && state.prefs.one_click_available && flagOn('trading.one_click'));
  const reviewOn = () => flagOn('trading.order_review') && !oneClickOn();

  el.innerHTML = `<div class="pro" data-testid="pro-terminal">
    <div class="page-head pt-0 pro-head"><h1 class="page-title">${te('pro.render.pro')}</h1><span class="faint" data-testid="pro-count" id="pro-count"></span>
      <div class="pro-head-actions"><span class="faint pro-keys" data-testid="pro-shortcuts">${te('pro.render.shortcuts')}</span>
        <button class="btn btn-sm" type="button" id="pro-layout-btn" data-testid="pro-layout-btn" aria-expanded="false" aria-controls="pro-layout-menu">${te('pro.layout.button')}</button></div></div>
    <section class="card pro-layout-menu" id="pro-layout-menu" data-testid="pro-layout-menu" hidden aria-label="${te('pro.layout.title')}"></section>
    <div class="pro-grid" id="pro-grid">${PANELS.map(panelHtml).join('')}</div>
  </div>`;
  const $ = (s) => el.querySelector(s);
  const body = (id) => el.querySelector(`[data-panel="${id}"] .pro-panel-body`);
  const unsubs = [];
  const timers = new Set();
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
  const debounced = (fn, ms) => { let t = null; return () => { if (t) { clearTimeout(t); timers.delete(t); } t = later(fn, ms); }; };

  function panelHtml(id) {
    return `<section class="card pro-panel pro-p-${esc(id)}" data-panel="${esc(id)}" data-testid="panel-${esc(id)}" aria-label="${te(`pro.panel.${id}`)}">
      <header class="pro-panel-head"><span class="pro-grip" draggable="true" data-grip="${esc(id)}" title="${te('pro.layout.drag')}" aria-hidden="true">⋮⋮</span><h2>${te(`pro.panel.${id}`)}</h2><span class="pro-panel-tools" data-tools="${esc(id)}"></span>
        <button class="icon-btn pro-hide" type="button" data-hide="${esc(id)}" aria-label="${te('pro.layout.hide_panel', { panel: te(`pro.panel.${id}`) })}" title="${te('pro.layout.hide')}">×</button></header>
      <div class="pro-panel-body"></div></section>`;
  }
  const signInHtml = () => `<div class="pro-signin" data-testid="pro-sign-in"><p class="muted">${te('pro.render.sign_in_body')}</p><a class="btn btn-primary btn-sm" href="/sign-in?next=%2Fpro" data-link>${te('pro.render.sign_in')}</a></div>`;
  for (const id of TRADING) if (!uid) body(id).innerHTML = signInHtml();

  // ------------------------------------------------------------------------------------------ layout
  const saveLayout = debounced(() => {
    if (!uid) return;
    api.proSetPrefs(uid, { layout: { order: state.layout.order, hidden: state.layout.hidden, chart_tf: state.layout.chart_tf, sort: { key: state.sort[0], dir: state.sort[1] } } }).catch((e) => toast(e.message, 'error'));
  }, 250);
  function applyLayout() {
    const grid = $('#pro-grid');
    for (const id of state.layout.order) { const p = grid.querySelector(`[data-panel="${id}"]`); if (p) { grid.append(p); p.hidden = state.layout.hidden.includes(id); } }
    drawLayoutMenu();
  }
  function drawLayoutMenu() {
    const box = $('#pro-layout-menu');
    box.innerHTML = `<div class="pro-layout-head"><strong>${te('pro.layout.title')}</strong><span class="faint">${te('pro.layout.help')}</span></div>
      <ol class="pro-layout-list">${state.layout.order.map((id, i) => `<li data-layout-panel="${esc(id)}"><label class="pro-check"><input type="checkbox" data-show="${esc(id)}" ${state.layout.hidden.includes(id) ? '' : 'checked'}> ${te(`pro.panel.${id}`)}</label>
        <span class="pro-layout-moves"><button class="btn btn-sm btn-ghost" type="button" data-move="-1" data-id="${esc(id)}" ${i === 0 ? 'disabled' : ''} aria-label="${te('pro.layout.move_up', { panel: te(`pro.panel.${id}`) })}">↑</button><button class="btn btn-sm btn-ghost" type="button" data-move="1" data-id="${esc(id)}" ${i === state.layout.order.length - 1 ? 'disabled' : ''} aria-label="${te('pro.layout.move_down', { panel: te(`pro.panel.${id}`) })}">↓</button></span></li>`).join('')}</ol>
      <div class="pro-layout-foot"><button class="btn btn-sm" type="button" data-testid="pro-layout-reset" id="pro-layout-reset">${te('pro.layout.reset')}</button>${uid ? '' : `<span class="faint">${te('pro.layout.signed_out')}</span>`}</div>`;
  }
  const setLayout = (next) => { state.layout = { ...state.layout, ...next }; applyLayout(); saveLayout(); };
  const move = (id, to) => { const order = state.layout.order.filter((x) => x !== id); order.splice(Math.max(0, Math.min(order.length, to)), 0, id); setLayout({ order }); };
  $('#pro-layout-btn').onclick = () => { const m = $('#pro-layout-menu'); m.hidden = !m.hidden; $('#pro-layout-btn').setAttribute('aria-expanded', String(!m.hidden)); };
  $('#pro-layout-menu').addEventListener('click', (e) => {
    const b = e.target.closest('[data-move]');
    if (b) { const i = state.layout.order.indexOf(b.dataset.id); move(b.dataset.id, i + Number(b.dataset.move)); return; }
    if (e.target.closest('#pro-layout-reset')) setLayout({ order: [...PANELS], hidden: [] });
  });
  $('#pro-layout-menu').addEventListener('change', (e) => {
    const c = e.target.closest('[data-show]');
    if (!c) return;
    const hidden = state.layout.hidden.filter((x) => x !== c.dataset.show);
    if (!c.checked) hidden.push(c.dataset.show);
    setLayout({ hidden });
  });
  $('#pro-grid').addEventListener('click', (e) => { const h = e.target.closest('[data-hide]'); if (h) setLayout({ hidden: [...state.layout.hidden.filter((x) => x !== h.dataset.hide), h.dataset.hide] }); });
  // Drag a panel by its grip onto another panel: it takes that panel's place (HTML5 drag and drop).
  let dragId = null;
  $('#pro-grid').addEventListener('dragstart', (e) => { const g = e.target.closest('[data-grip]'); if (!g) return; dragId = g.dataset.grip; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); g.closest('[data-panel]').classList.add('pro-dragging'); });
  $('#pro-grid').addEventListener('dragend', () => { dragId = null; for (const p of el.querySelectorAll('.pro-dragging, .pro-drop')) p.classList.remove('pro-dragging', 'pro-drop'); });
  $('#pro-grid').addEventListener('dragover', (e) => { const p = e.target.closest('[data-panel]'); if (!dragId || !p) return; e.preventDefault(); for (const x of el.querySelectorAll('.pro-drop')) if (x !== p) x.classList.remove('pro-drop'); if (p.dataset.panel !== dragId) p.classList.add('pro-drop'); });
  $('#pro-grid').addEventListener('drop', (e) => {
    const p = e.target.closest('[data-panel]');
    const id = dragId || e.dataTransfer.getData('text/plain');
    if (!p || !PANELS.includes(id) || p.dataset.panel === id) return;
    e.preventDefault();
    const from = state.layout.order.indexOf(id); const to = state.layout.order.indexOf(p.dataset.panel);
    const order = state.layout.order.filter((x) => x !== id);
    order.splice(order.indexOf(p.dataset.panel) + (from < to ? 1 : 0), 0, id);
    setLayout({ order });
  });

  // ------------------------------------------------------------------------------------------ screener
  function filtersForm(f) { return Object.fromEntries(FILTER_KEYS.map((k) => [k, f && f[k] != null ? String(f[k]) : ''])); }
  const filtersApi = () => Object.fromEntries(FILTER_KEYS.filter((k) => state.filters[k] !== '').map((k) => [k, k === 'category' ? state.filters[k] : Number(state.filters[k])]));
  body('screener').innerHTML = `<form class="pro-filters" id="pro-filters" data-testid="pro-filters" novalidate>
      <label class="pro-field">${te('pro.filters.category')}<select name="category" data-testid="pro-filter-category"><option value="">${te('pro.filters.all_categories')}</option>${CATEGORIES.map((c) => `<option value="${esc(c)}">${esc(catLabel(c))}</option>`).join('')}</select></label>
      <label class="pro-field">${te('pro.filters.closes')}<select name="closes_within_hours" data-testid="pro-filter-closes">${CLOSES.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select></label>
      <label class="pro-field">${te('pro.filters.min_volume')}<input name="min_volume" type="number" min="0" step="1" inputmode="numeric" data-testid="pro-filter-volume"></label>
      <label class="pro-field">${te('pro.filters.max_spread', { unit: esc(priceUnit()) })}<input name="max_spread_cents" type="number" min="0" max="99" step="any" inputmode="decimal" data-testid="pro-filter-spread"></label>
      <label class="pro-field">${te('pro.filters.min_move', { unit: esc(priceUnit()) })}<input name="min_move_cents" type="number" min="0" max="99" step="any" inputmode="decimal" data-testid="pro-filter-move"></label>
      <button class="btn btn-sm btn-primary" type="submit" data-testid="pro-filter-apply">${te('pro.filters.apply')}</button>
      <button class="btn btn-sm btn-ghost" type="button" id="pro-filter-clear">${te('pro.filters.clear')}</button>
    </form>
    <div class="pro-screens" id="pro-screens"></div>
    <div class="form-error" id="pro-screener-error" role="alert"></div>
    <div class="pro-scroll"><table class="table pro-table" data-testid="pro-table"><thead><tr>${COLS.map(([k, l]) => `<th class="${k === 'title' ? '' : 'num'}"><button class="btn btn-ghost btn-sm" type="button" data-sort="${esc(k)}">${esc(l)}</button></th>`).join('')}<th></th></tr></thead><tbody id="pro-rows"></tbody></table></div>`;
  const form = $('#pro-filters');
  const fillForm = () => { for (const k of FILTER_KEYS) form.elements[k].value = state.filters[k]; };
  const readForm = () => { for (const k of FILTER_KEYS) state.filters[k] = String(form.elements[k].value || '').trim(); };
  fillForm();
  function drawScreens() {
    const box = $('#pro-screens');
    if (!uid) { box.innerHTML = `<span class="faint">${te('pro.screens.signed_out')}</span>`; return; }
    const act = state.screens.find((s) => s.id === state.activeScreen);
    box.innerHTML = `<label class="pro-field pro-field-inline">${te('pro.screens.saved')}<select id="pro-screen" data-testid="pro-screen-select"><option value="">${te('pro.screens.none')}</option>${state.screens.map((s) => `<option value="${esc(s.id)}" ${s.id === state.activeScreen ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
      <input id="pro-screen-name" class="pro-input" maxlength="60" placeholder="${te('pro.screens.name_placeholder')}" aria-label="${te('pro.screens.name')}" data-testid="pro-screen-name">
      <button class="btn btn-sm" type="button" id="pro-screen-save" data-testid="pro-screen-save">${te('pro.screens.save_new')}</button>
      ${act ? `<button class="btn btn-sm btn-ghost" type="button" id="pro-screen-update" data-testid="pro-screen-update">${te('pro.screens.update', { name: esc(act.name) })}</button><button class="btn btn-sm btn-ghost" type="button" id="pro-screen-delete" data-testid="pro-screen-delete">${te('pro.screens.delete')}</button>` : ''}`;
    $('#pro-screen').onchange = async (e) => {
      const s = state.screens.find((x) => x.id === e.target.value);
      state.activeScreen = s ? s.id : null;
      if (s) { state.filters = filtersForm(s.filters); fillForm(); }
      api.proSetPrefs(uid, { active_screen_id: state.activeScreen }).catch(() => {});
      drawScreens(); await loadRows();
    };
    $('#pro-screen-save').onclick = async () => {
      const name = $('#pro-screen-name').value.trim();
      const err = $('#pro-screener-error'); err.textContent = '';
      if (!name) { err.textContent = tx('pro.screens.name_required'); return; }
      readForm();
      try {
        const r = await api.proSaveScreen(uid, { name, filters: filtersApi() });
        state.screens = (await api.proScreens(uid)).screens; state.activeScreen = r.screen.id;
        await api.proSetPrefs(uid, { active_screen_id: r.screen.id });
        toast(tx('pro.screens.saved_toast', { name: r.screen.name })); drawScreens();
      } catch (ex) { err.textContent = ex.message; }
    };
    const up = $('#pro-screen-update');
    if (up) up.onclick = async () => { readForm(); try { await api.proUpdateScreen(uid, act.id, { filters: filtersApi() }); state.screens = (await api.proScreens(uid)).screens; toast(tx('pro.screens.updated_toast', { name: act.name })); drawScreens(); } catch (ex) { $('#pro-screener-error').textContent = ex.message; } };
    const del = $('#pro-screen-delete');
    if (del) del.onclick = async () => { try { await api.proDeleteScreen(uid, act.id); state.screens = state.screens.filter((s) => s.id !== act.id); state.activeScreen = null; toast(tx('pro.screens.deleted_toast', { name: act.name })); drawScreens(); } catch (ex) { $('#pro-screener-error').textContent = ex.message; } };
  }
  const cc = (d) => (d == null ? null : Math.round(Number(d) * 10000));
  const val = (r, k) => ({ title: `${r.yes_sub_title} ${r.event_title}`, bid: cc(r.yes_bid_dollars) ?? -1, ask: cc(r.yes_ask_dollars) ?? 99999, last: cc(r.last_price_dollars) ?? -1, chg: r.move_24h_cents ?? 0, vol: Number(r.volume_fp), spread: r.spread_cents ?? 999, close: Date.parse(r.close_time) }[k]);
  const lastPct = (r) => (r.last_price_dollars == null ? '—' : `${Math.round(Number(r.last_price_dollars) * 100)}%`);
  const sortedRows = () => { const [k, dir] = state.sort; return [...state.rows].sort((a, b) => { const x = val(a, k); const y = val(b, k); return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir; }); };
  function drawRows() {
    const k = state.sort[0];
    const list = sortedRows();
    $('#pro-count').textContent = tx('pro.render.open_markets_live', { value: state.total });
    for (const b of el.querySelectorAll('[data-sort]')) b.setAttribute('aria-pressed', String(b.dataset.sort === k));
    $('#pro-rows').innerHTML = list.map((r) => {
      const chg = Math.round((r.move_24h_cents ?? 0) * 100) / 100;
      return `<tr data-ticker="${esc(r.ticker)}" class="${r.ticker === state.selected ? 'selected' : ''}" data-testid="pro-row"><td><a href="${eventHref(r)}?market=${esc(r.ticker)}" data-link><strong>${esc(r.yes_sub_title)}</strong> <span class="faint">${esc(r.event_title)} · ${esc(catLabel(r.category))}</span></a></td>
        <td class="num c-yes">${esc(px(r.yes_bid_dollars))}</td><td class="num c-no">${esc(px(r.yes_ask_dollars))}</td><td class="num"><strong>${esc(lastPct(r))}</strong></td>
        <td class="num ${chg >= 0 ? 'delta-up' : 'delta-down'}">${chg ? (chg > 0 ? '+' : '') + chg : '0'}</td><td class="num">${qty(r.volume_fp)}</td>
        <td class="num" data-testid="pro-spread">${r.spread_cents == null ? '—' : esc(pxc(r.spread_cents * 100))}</td><td class="num faint">${esc(fmtDt(r.close_time, { day: 'numeric', month: 'short' }))}</td>
        <td><a class="btn btn-sm" href="${eventHref(r)}?side=yes&amp;market=${esc(r.ticker)}" data-link>${te('pro.render.trade')}</a></td></tr>`;
    }).join('') || `<tr><td colspan="9" class="faint" data-testid="pro-no-rows">${te('pro.render.no_markets')}</td></tr>`;
  }
  let rowsSeq = 0;
  async function loadRows() {
    const my = ++rowsSeq;
    const err = $('#pro-screener-error');
    try {
      const r = await api.proScreener(filtersApi());
      if (my !== rowsSeq) return;
      err.textContent = '';
      state.rows = r.markets; state.total = r.total_count;
      drawRows();
    } catch (ex) { if (my === rowsSeq) err.textContent = ex.message; }
  }
  form.onsubmit = (e) => { e.preventDefault(); readForm(); loadRows(); };
  form.addEventListener('change', (e) => { if (e.target.tagName === 'SELECT') { readForm(); loadRows(); } });
  $('#pro-filter-clear').onclick = () => { state.filters = filtersForm({}); fillForm(); loadRows(); };
  for (const b of el.querySelectorAll('[data-sort]')) b.onclick = () => { state.sort = [b.dataset.sort, state.sort[0] === b.dataset.sort ? -state.sort[1] : -1]; drawRows(); saveLayout(); };
  $('#pro-rows').addEventListener('click', (e) => { if (e.target.closest('a')) return; const tr = e.target.closest('tr[data-ticker]'); if (tr) select(tr.dataset.ticker); });

  // ------------------------------------------------------------------------------------------ selected market
  let unsubMarket = [];
  async function select(ticker) {
    if (!ticker || ticker === state.selected) return;
    state.selected = ticker; state.review = null; state.tkt.price = null; state.book = { yes: new Map(), no: new Map() }; state.trades = [];
    for (const tr of el.querySelectorAll('#pro-rows tr[data-ticker]')) tr.classList.toggle('selected', tr.dataset.ticker === ticker);
    const u = new URL(location.href); u.searchParams.set('market', ticker); history.replaceState(history.state, '', u.pathname + u.search);
    for (const f of unsubMarket) f();
    unsubMarket = [];
    try { state.market = (await api.market(ticker)).market; } catch (ex) { state.market = null; toast(ex.message, 'error'); }
    if (state.selected !== ticker) return;
    unsubMarket.push(socket.subscribe({ channels: ['orderbook'], market_tickers: [ticker] }, (msg) => {
      if (msg.msg.market_ticker !== state.selected) return;
      if (msg.type === 'orderbook_snapshot') state.book = { yes: new Map(msg.msg.yes_dollars.map(([p, c]) => [ccOf(p), Number(c)])), no: new Map(msg.msg.no_dollars.map(([p, c]) => [ccOf(p), Number(c)])) };
      else if (msg.type === 'orderbook_delta') {
        const map = state.book[msg.msg.side]; const p = ccOf(msg.msg.price_dollars);
        const n = (map.get(p) || 0) + Number(msg.msg.delta_fp);
        if (n <= 1e-9) map.delete(p); else map.set(p, n);
      }
      drawLadderSoon();
    }));
    unsubMarket.push(socket.subscribe({ channels: ['trade'], market_tickers: [ticker] }, (msg) => {
      if (msg.msg.market_ticker !== state.selected) return;
      state.trades.unshift({ ticker, yes_price_dollars: msg.msg.yes_price_dollars, count_fp: msg.msg.count_fp, taker_side: msg.msg.taker_side, created_time: new Date(msg.msg.ts || Date.now()).toISOString() });
      state.trades = state.trades.slice(0, 40);
      drawTape(); chartSoon();
    }));
    api.orderbook(ticker).then((ob) => { if (state.selected !== ticker) return; state.book = { yes: new Map(ob.orderbook_fp.yes_dollars.map(([p, c]) => [ccOf(p), Number(c)])), no: new Map(ob.orderbook_fp.no_dollars.map(([p, c]) => [ccOf(p), Number(c)])) }; drawLadder(); }).catch(() => {});
    api.trades(ticker).then((r) => { if (state.selected !== ticker) return; state.trades = r.trades.slice(0, 40); drawTape(); }).catch(() => {});
    drawMarketHead(); drawChart(); drawLadder(); drawTicket(); drawAlerts();
  }
  const rowOf = (t) => state.rows.find((r) => r.ticker === t);
  function drawMarketHead() {
    const m = state.market; const r = rowOf(state.selected);
    for (const id of ['chart', 'ladder']) {
      const tools = el.querySelector(`[data-tools="${id}"]`);
      if (id === 'chart') tools.innerHTML = `<span class="pro-mkt" data-testid="pro-chart-market">${esc(m ? m.yes_sub_title : '')}${r ? ` <span class="faint">${esc(r.event_title)}</span>` : ''}</span><span class="seg" role="group" aria-label="${te('pro.chart.timeframe')}">${TFS.map((t) => `<button type="button" data-tf="${esc(t)}" class="${t === state.layout.chart_tf ? 'on' : ''}" aria-pressed="${t === state.layout.chart_tf}">${esc(t)}</button>`).join('')}</span>`;
      else tools.innerHTML = `<span class="pro-mkt faint">${esc(m ? m.yes_sub_title : '')}</span>`;
    }
  }
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tf]');
    if (!b) return;
    state.layout.chart_tf = b.dataset.tf;
    for (const x of el.querySelectorAll('[data-tf]')) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); }
    saveLayout(); drawChart();
  });

  // ------------------------------------------------------------------------------------------ chart
  let chartSeq = 0;
  async function drawChart() {
    const my = ++chartSeq; const box = body('chart');
    if (!state.selected) { box.innerHTML = `<p class="faint">${te('pro.render.select_market')}</p>`; return; }
    try {
      const r = await api.proCandles(state.selected, state.layout.chart_tf);
      if (my !== chartSeq) return;
      box.innerHTML = candleSvg(r.candles, state.layout.chart_tf);
    } catch (ex) { if (my === chartSeq) box.innerHTML = `<p class="faint">${te('pro.chart.unavailable', { message: esc(ex.message) })}</p>`; }
  }
  const chartSoon = debounced(drawChart, 3000);

  // ------------------------------------------------------------------------------------------ ladder
  function drawLadder() {
    const box = body('ladder');
    if (!state.selected) { box.innerHTML = `<p class="faint">${te('pro.render.select_market')}</p>`; return; }
    const asks = [...state.book.no.entries()].map(([p, c]) => [10000 - p, c]).sort((a, b) => a[0] - b[0]).slice(0, 8).reverse();
    const bids = [...state.book.yes.entries()].sort((a, b) => b[0] - a[0]).slice(0, 8);
    const max = Math.max(1, ...asks.map((a) => a[1]), ...bids.map((b) => b[1]));
    const bar = (c, kind) => `<i class="pro-bar pro-bar-${esc(kind)} v-w"${vars({ '--w': `${Math.round((c / max) * 100)}%` })}></i>`;
    const row = (p, c, kind) => `<button type="button" class="pro-lv pro-lv-${esc(kind)}" data-level="${esc(p)}" data-kind="${esc(kind)}" data-testid="ladder-level" aria-label="${te('pro.ladder.load_price', { price: esc(pxc(p)) })}">
      <span class="pro-lv-size num">${kind === 'bid' ? `${bar(c, 'bid')}<b>${qty(c)}</b>` : ''}</span><span class="pro-lv-px num c-yes">${esc(pxc(p))}</span><span class="pro-lv-px num c-no">${esc(pxc(10000 - p))}</span><span class="pro-lv-size num">${kind === 'ask' ? `${bar(c, 'ask')}<b>${qty(c)}</b>` : ''}</span></button>`;
    const spread = asks.length && bids.length ? asks[asks.length - 1][0] - bids[0][0] : null;
    box.innerHTML = `<div class="pro-ladder" data-testid="pro-ladder"><div class="pro-lv pro-lv-head"><span>${te('pro.ladder.yes_bids')}</span><span>${te('pro.ladder.yes_price')}</span><span>${te('pro.ladder.no_price')}</span><span>${te('pro.ladder.no_bids')}</span></div>
      ${asks.map(([p, c]) => row(p, c, 'ask')).join('') || `<p class="faint pro-lv-empty">${te('pro.ladder.no_offers')}</p>`}
      <div class="pro-lv-spread" data-testid="ladder-spread">${spread == null ? te('pro.ladder.no_spread') : te('pro.ladder.spread', { value: esc(pxc(spread)) })}</div>
      ${bids.map(([p, c]) => row(p, c, 'bid')).join('') || `<p class="faint pro-lv-empty">${te('pro.ladder.no_bids_yet')}</p>`}
      <p class="faint pro-lv-help">${te('pro.ladder.help')}</p></div>`;
  }
  const drawLadderSoon = debounced(drawLadder, 120);
  body('ladder').addEventListener('click', (e) => {
    const b = e.target.closest('[data-level]');
    if (!b) return;
    const p = Number(b.dataset.level);
    state.tkt.type = 'limit'; state.review = null;
    state.tkt.price = state.tkt.side === 'yes' ? p : 10000 - p;
    drawTicket();
    const inp = body('ticket').querySelector('#pt-price');
    if (inp) { inp.classList.add('pro-flash'); later(() => inp.classList.remove('pro-flash'), 600); }
  });

  // ------------------------------------------------------------------------------------------ quick ticket
  const m0 = () => state.market;
  const askOf = (side) => { const m = m0(); return side === 'yes' ? ccOf(m.yes_ask_dollars) : ccOf(m.no_ask_dollars); };
  const bidOf = (side) => { const m = m0(); return side === 'yes' ? ccOf(m.yes_bid_dollars) : ccOf(m.no_bid_dollars); };
  const defaultPrice = () => {
    const m = m0(); const { side, action } = state.tkt;
    const last = ccOf(m.last_price_dollars); const lastSide = last == null ? null : side === 'yes' ? last : 10000 - last;
    return snapCc(m, (action === 'sell' ? bidOf(side) : askOf(side)) || lastSide || 5000);
  };
  function drawTicket() {
    const box = body('ticket');
    if (!uid) { box.innerHTML = signInHtml(); return; }
    const m = m0();
    if (!m) { box.innerHTML = `<p class="faint">${te('pro.render.select_market')}</p>`; return; }
    if (!flagOn('trading')) { box.innerHTML = `<p class="muted" data-testid="pro-ticket-unavailable">${te('pro.ticket.unavailable')}</p>`; return; }
    if (m.status !== 'active') { box.innerHTML = `<p class="muted" data-testid="pro-ticket-closed">${te('pro.ticket.closed')}</p>`; return; }
    const k = state.tkt;
    if (k.price == null || !onGrid(m, k.price)) k.price = defaultPrice();
    const tick = minTickCc(m); const frac = !!m.fractional_trading_enabled;
    box.innerHTML = `<div class="pro-ticket" data-testid="pro-ticket" data-action="${esc(k.action)}" data-side="${esc(k.side)}">
      <div class="pro-tkt-mkt"><strong>${esc(m.yes_sub_title)}</strong> <span class="faint">${esc(rowOf(m.ticker)?.event_title || m.title || '')}</span></div>
      <div class="pro-tkt-row"><span class="seg" role="group" aria-label="${te('pro.ticket.action')}"><button type="button" data-act="buy" class="${k.action === 'buy' ? 'on' : ''}" aria-pressed="${k.action === 'buy'}" data-testid="pro-buy">${te('pro.ticket.buy')} <kbd>B</kbd></button><button type="button" data-act="sell" class="${k.action === 'sell' ? 'on' : ''}" aria-pressed="${k.action === 'sell'}" data-testid="pro-sell">${te('pro.ticket.sell')} <kbd>S</kbd></button></span>
        <span class="seg" role="group" aria-label="${te('pro.ticket.type')}"><button type="button" data-otype="limit" class="${k.type === 'limit' ? 'on' : ''}" aria-pressed="${k.type === 'limit'}" ${flagOn('trading.limit_orders') ? '' : 'disabled'}>${te('pro.ticket.limit')}</button><button type="button" data-otype="market" class="${k.type === 'market' ? 'on' : ''}" aria-pressed="${k.type === 'market'}" ${flagOn('trading.market_orders') ? '' : 'disabled'}>${te('pro.ticket.market')}</button></span></div>
      <div class="yn-toggle side-toggle"><button type="button" data-side="yes" class="${k.side === 'yes' ? 'on-yes' : ''}" aria-pressed="${k.side === 'yes'}" data-testid="pro-side-yes">${te('pro.ticket.yes', { price: esc(pxc(k.action === 'sell' ? bidOf('yes') : askOf('yes'))) })} <kbd>Y</kbd></button><button type="button" data-side="no" class="${k.side === 'no' ? 'on-no' : ''}" aria-pressed="${k.side === 'no'}" data-testid="pro-side-no">${te('pro.ticket.no', { price: esc(pxc(k.action === 'sell' ? bidOf('no') : askOf('no'))) })} <kbd>N</kbd></button></div>
      ${k.type === 'limit' ? `<label class="tkt-input">${esc(T('input.limit_price', { unit: priceUnit() }))}<input id="pt-price" type="number" min="${esc(tick / 100)}" max="${esc(100 - tick / 100)}" step="${esc(tick / 100)}" value="${esc(k.price / 100)}" inputmode="decimal" data-testid="pro-ticket-price"></label>` : ''}
      <label class="tkt-input">${te('pro.ticket.contracts')}<input id="pt-count" type="number" min="${frac ? '0.01' : '1'}" step="${frac ? '0.01' : '1'}" value="${esc(k.count)}" inputmode="${frac ? 'decimal' : 'numeric'}" data-testid="pro-ticket-count"></label>
      <div id="pt-summary" class="pro-tkt-sum"></div>
      <div class="form-error" id="pt-error" role="alert" data-testid="pro-ticket-error"></div>
      <div id="pt-review"></div>
      <button class="cta" type="button" id="pt-submit" data-testid="pro-ticket-submit"></button>
      <div class="pro-oneclick" id="pt-oneclick"></div></div>`;
    const t = box.querySelector('.pro-ticket');
    for (const b of t.querySelectorAll('[data-act]')) b.onclick = () => setTkt({ action: b.dataset.act, price: null });
    for (const b of t.querySelectorAll('[data-side]')) b.onclick = () => setTkt({ side: b.dataset.side, price: null });
    for (const b of t.querySelectorAll('[data-otype]')) b.onclick = () => setTkt({ type: b.dataset.otype });
    t.querySelectorAll('input').forEach((i) => { i.oninput = () => { readTkt(); state.review = null; t.querySelector('#pt-review').innerHTML = ''; recalc(); }; });
    t.querySelector('#pt-submit').onclick = () => submit();
    recalc(); drawReview(); drawOneClick();
  }
  function setTkt(next) { Object.assign(state.tkt, next); state.review = null; drawTicket(); }
  function readTkt() {
    const t = body('ticket'); const p = t.querySelector('#pt-price'); const c = t.querySelector('#pt-count');
    if (p) state.tkt.price = Math.round(Number(p.value) * 100);
    if (c) state.tkt.count = c.value === '' ? '' : Number(c.value);
  }
  // The order this ticket would place, or the reason it cannot (shown under the inputs).
  function order() {
    const m = m0(); const k = state.tkt;
    if (!validQty(Number(k.count), !!m.fractional_trading_enabled)) return { why: tx('pro.ticket.bad_count') };
    const body = { ticker: m.ticker, side: k.side, action: k.action, type: k.type, count: Number(k.count) };
    let p;
    if (k.type === 'limit') {
      if (!onGrid(m, k.price)) return { why: tx('pro.ticket.bad_price', { min: pxc(minTickCc(m)), max: pxc(10000 - minTickCc(m)) }) };
      body.price_dollars = ccDollars(k.price); p = k.price;
    } else p = k.action === 'sell' ? bidOf(k.side) : askOf(k.side);
    return { body, p };
  }
  function recalc() {
    const t = body('ticket'); const sum = t.querySelector('#pt-summary'); const btn = t.querySelector('#pt-submit');
    if (!sum) return;
    const o = order(); const k = state.tkt;
    const label = `${k.action === 'sell' ? tx('pro.ticket.sell') : tx('pro.ticket.buy')} ${k.side === 'yes' ? tx('pro.ticket.yes_word') : tx('pro.ticket.no_word')}`;
    btn.textContent = reviewOn() ? tx('pro.ticket.review_btn', { order: label }) : tx('pro.ticket.place_btn', { order: label });
    btn.disabled = !!o.why;
    if (o.why) { sum.innerHTML = `<span class="faint" data-testid="pro-ticket-invalid">${esc(o.why)}</span>`; return; }
    const c = o.body.count;
    sum.innerHTML = o.p == null ? `<span class="faint">${te('pro.ticket.no_price_now')}</span>`
      : k.action === 'sell' ? `<div class="tkt-row"><span>${te('pro.ticket.est_proceeds')}</span><strong class="num" data-testid="pro-ticket-cost">${money((o.p * c) / 10000)}</strong></div>`
        : `<div class="tkt-row"><span>${k.type === 'market' ? te('pro.ticket.est_cost') : te('pro.ticket.max_cost')}</span><strong class="num" data-testid="pro-ticket-cost">${money((o.p * c) / 10000)}</strong></div>
           <div class="tkt-row"><span>${te('pro.ticket.fee')}</span><strong class="num">${money(feeDollars(c, o.p))}</strong></div>
           <div class="tkt-row"><span>${te('pro.ticket.payout')}</span><strong class="num">${money(c)}</strong></div>`;
  }
  function drawReview() {
    const t = body('ticket'); const box = t.querySelector('#pt-review');
    if (!box) return;
    t.querySelector('.pro-ticket')?.classList.toggle('pro-reviewing', !!state.review);
    if (!state.review) { box.innerHTML = ''; return; }
    const { body: b, p } = state.review; const m = m0();
    const priceLine = b.type === 'market' ? tx('pro.review.market_price', { price: pxc(p) }) : tx('pro.review.limit_price', { price: px(b.price_dollars) });
    box.innerHTML = `<section class="tkt-review" data-testid="pro-review" aria-label="${te('pro.review.title')}"><h4>${te('pro.review.title')}</h4>
      <div class="tkt-row"><span>${te('pro.review.order')}</span><strong data-testid="pro-review-order">${esc(b.action === 'sell' ? tx('pro.ticket.sell') : tx('pro.ticket.buy'))} ${esc(qty(b.count))} ${esc(b.side.toUpperCase())} · ${esc(m.yes_sub_title)}</strong></div>
      <div class="tkt-row"><span>${te('pro.review.price')}</span><strong data-testid="pro-review-price">${esc(priceLine)}</strong></div>
      ${b.action === 'buy' && p != null ? `<div class="tkt-row"><span>${b.type === 'market' ? te('pro.ticket.est_cost') : te('pro.ticket.max_cost')}</span><strong class="num">${money((p * b.count) / 10000)}</strong></div><div class="tkt-row"><span>${te('pro.ticket.fee')}</span><strong class="num">${money(feeDollars(b.count, p))}</strong></div>` : ''}
      <div class="tkt-review-actions"><button class="btn" type="button" data-testid="pro-review-cancel" id="pt-review-cancel">${te('pro.review.edit')} <kbd>${te('pro.keys.esc')}</kbd></button><button class="btn btn-primary" type="button" data-testid="pro-review-confirm" id="pt-review-confirm">${te('pro.review.place')}</button></div></section>`;
    box.querySelector('#pt-review-cancel').onclick = () => cancelReview();
    box.querySelector('#pt-review-confirm').onclick = (e) => { e.target.disabled = true; const r = state.review; state.review = null; drawReview(); place(r.body, false); };
  }
  function cancelReview() { if (!state.review) return false; state.review = null; drawReview(); body('ticket').querySelector('#pt-submit')?.focus(); return true; }
  // Enter / the ticket button: the review step (or, with one-click on, the order itself).
  function submit() {
    if (!uid || !m0() || m0().status !== 'active') return;
    readTkt();
    const o = order();
    const err = body('ticket').querySelector('#pt-error');
    if (o.why) { if (err) err.textContent = o.why; return; }
    if (err) err.textContent = '';
    if (reviewOn()) { state.review = o; drawReview(); body('ticket').querySelector('#pt-review-confirm')?.focus(); return; }
    place(o.body, oneClickOn());
  }
  async function place(b, oneClick) {
    const t = body('ticket'); const btn = t.querySelector('#pt-submit'); const err = t.querySelector('#pt-error');
    if (btn) { btn.disabled = true; btn.textContent = tx('pro.ticket.submitting'); }
    try {
      const r = await api.submitOrder(uid, b, { oneClick });
      const o = r.order;
      toast(o.status === 'resting' ? tx('pro.ticket.resting', { filled: qty(o.fill_count_fp), left: qty(o.remaining_count_fp) }) : tx('pro.ticket.filled', { filled: qty(o.fill_count_fp), side: b.side.toUpperCase() }));
      refreshAccount();
    } catch (ex) {
      if (err && err.isConnected) err.textContent = ex.unauthorized ? tx('pro.ticket.session_expired') : ex.message;
    } finally { if (btn && btn.isConnected) recalc(); }
  }
  function drawOneClick() {
    const box = body('ticket').querySelector('#pt-oneclick');
    if (!box) return;
    const p = state.prefs || {};
    const avail = !!p.one_click_available && flagOn('trading.one_click');
    box.innerHTML = `<label class="pro-check"><input type="checkbox" id="pt-oneclick-box" data-testid="pro-one-click" ${p.one_click && avail ? 'checked' : ''} ${avail ? '' : 'disabled'}> ${te('pro.oneclick.label')}</label>
      <span class="faint" data-testid="pro-one-click-state">${!avail ? te('pro.oneclick.off_by_owner') : p.one_click ? te('pro.oneclick.on_help') : te('pro.oneclick.off_help')}</span><div id="pt-oneclick-confirm"></div>`;
    const cb = box.querySelector('#pt-oneclick-box');
    cb.onchange = async () => {
      if (!cb.checked) {
        try { state.prefs = (await api.proSetPrefs(uid, { one_click: false })).preferences; toast(tx('pro.oneclick.turned_off')); } catch (ex) { toast(ex.message, 'error'); }
        drawTicket(); return;
      }
      if (p.one_click_confirmed_time) { // confirmed once before (here or in the event ticket): no second question
        try { state.prefs = (await api.proSetPrefs(uid, { one_click: true })).preferences; toast(tx('pro.oneclick.turned_on')); } catch (ex) { toast(ex.message, 'error'); }
        drawTicket(); return;
      }
      cb.checked = false;
      const c = box.querySelector('#pt-oneclick-confirm');
      c.innerHTML = `<div class="pro-confirm" role="dialog" aria-modal="false" aria-labelledby="pt-oc-title" data-testid="pro-one-click-confirm"><h4 id="pt-oc-title">${te('pro.oneclick.confirm_title')}</h4><p>${te('pro.oneclick.confirm_body')}</p>
        <div class="tkt-review-actions"><button class="btn" type="button" data-testid="pro-one-click-cancel">${te('pro.oneclick.cancel')}</button><button class="btn btn-primary" type="button" data-testid="pro-one-click-accept">${te('pro.oneclick.accept')}</button></div></div>`;
      c.querySelector('[data-testid=pro-one-click-cancel]').onclick = () => { c.innerHTML = ''; };
      c.querySelector('[data-testid=pro-one-click-accept]').onclick = async () => {
        try { state.prefs = (await api.proSetPrefs(uid, { one_click: true, confirm: true })).preferences; toast(tx('pro.oneclick.turned_on')); } catch (ex) { toast(ex.message, 'error'); }
        drawTicket();
      };
      c.querySelector('[data-testid=pro-one-click-accept]').focus();
    };
  }

  // Keyboard shortcuts (focus-safe: never while typing in a field, never with a modifier or a dialog open).
  const onKey = (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || !el.isConnected) return;
    if (typingIn(e.target)) { if (e.key === 'Escape') e.target.blur(); return; }
    if (document.querySelector('[data-testid=step-up-dialog], .sheet-backdrop, [data-testid=pro-one-click-confirm]')) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === 'Escape') { if (cancelReview()) e.preventDefault(); return; }
    if (!uid || !m0() || body('ticket').closest('[data-panel]').hidden) return;
    if (key === 'b' || key === 's') { e.preventDefault(); setTkt({ action: key === 'b' ? 'buy' : 'sell', price: null }); return; }
    if (key === 'y' || key === 'n') { e.preventDefault(); setTkt({ side: key === 'y' ? 'yes' : 'no', price: null }); return; }
    if (key === 'Enter') {
      if (e.target.closest && e.target.closest('button, a, [role=button]')) return; // the focused control acts itself
      if (state.review) return; // placing needs the Place order button (a deliberate second step)
      e.preventDefault(); submit();
    }
  };
  document.addEventListener('keydown', onKey);
  unsubs.push(() => document.removeEventListener('keydown', onKey));

  // ------------------------------------------------------------------------------------------ open orders
  let ordersSeq = 0;
  async function drawOrders() {
    if (!uid) return;
    const my = ++ordersSeq; const box = body('orders');
    let orders;
    try { orders = (await api.orders(uid, 'resting')).orders; } catch (ex) { if (my === ordersSeq) box.innerHTML = `<p class="faint">${esc(ex.message)}</p>`; return; }
    if (my !== ordersSeq || box.querySelector('[data-amend-form] input:focus')) return;
    box.innerHTML = orders.length ? `<div class="pro-scroll"><table class="table pro-small" data-testid="pro-orders"><thead><tr><th>${te('pro.orders.market')}</th><th>${te('pro.orders.side')}</th><th class="num">${te('pro.orders.price')}</th><th class="num">${te('pro.orders.filled')}</th><th class="num">${te('pro.orders.left')}</th><th></th></tr></thead><tbody>
      ${orders.map((o) => `<tr data-order="${esc(o.order_id)}" data-testid="pro-order-row"><td><button type="button" class="link-btn" data-pick="${esc(o.ticker)}">${esc(o.outcome)}</button></td><td><strong class="c-${esc(o.user_side)}">${esc(o.user_action.toUpperCase())} ${esc(o.user_side.toUpperCase())}</strong></td>
        <td class="num" data-testid="pro-order-price">${esc(px(o.user_price_dollars))}</td><td class="num">${qty(o.fill_count_fp)} / <span data-testid="pro-order-total">${qty(o.initial_count_fp)}</span></td><td class="num" data-testid="pro-order-left">${qty(o.remaining_count_fp)}</td>
        <td class="row-actions"><button class="btn btn-sm" type="button" data-amend="${esc(o.order_id)}" data-testid="pro-order-amend">${te('pro.orders.amend')}</button><button class="btn btn-sm" type="button" data-cancel="${esc(o.order_id)}" data-testid="pro-order-cancel">${te('pro.orders.cancel')}</button></td></tr>
        ${state.amending === o.order_id ? `<tr class="edit-row"><td colspan="6"><form class="pro-amend" data-amend-form="${esc(o.order_id)}" novalidate><label class="pro-field pro-field-inline">${esc(T('input.price', { unit: priceUnit() }))}<input name="price" type="number" step="any" min="0.01" max="99.99" value="${esc(ccOf(o.user_price_dollars) / 100)}" data-testid="pro-amend-price"></label>
          <label class="pro-field pro-field-inline">${te('pro.orders.total')}<input name="count" type="number" step="${o.fractional_trading_enabled ? '0.01' : '1'}" min="0.01" value="${esc(Number(o.initial_count_fp))}" data-testid="pro-amend-count"></label>
          <button class="btn btn-sm btn-primary" type="submit" data-testid="pro-amend-save">${te('pro.orders.save')}</button><button class="btn btn-sm btn-ghost" type="button" data-amend-close>${te('pro.orders.close')}</button><span class="form-error" role="alert"></span></form></td></tr>` : ''}`).join('')}</tbody></table></div>`
      : `<p class="faint" data-testid="pro-no-orders">${te('pro.orders.none')}</p>`;
    const byId = new Map(orders.map((o) => [o.order_id, o]));
    for (const b of box.querySelectorAll('[data-cancel]')) b.onclick = async () => { b.disabled = true; try { await api.cancelOrder(uid, b.dataset.cancel); toast(tx('pro.orders.canceled')); } catch (ex) { toast(ex.message, 'error'); } refreshAccount(); };
    for (const b of box.querySelectorAll('[data-amend]')) b.onclick = () => { state.amending = state.amending === b.dataset.amend ? null : b.dataset.amend; drawOrders(); };
    const f = box.querySelector('[data-amend-form]');
    if (f) {
      const o = byId.get(f.dataset.amendForm);
      f.querySelector('[data-amend-close]').onclick = () => { state.amending = null; drawOrders(); };
      f.onsubmit = async (e) => {
        e.preventDefault();
        const err = f.querySelector('.form-error'); err.textContent = '';
        const pcc = Math.round(Number(f.price.value) * 100); const count = Number(f.count.value);
        if (!(pcc >= 1 && pcc <= 9999)) { err.textContent = tx('pro.orders.bad_price'); return; }
        if (!validQty(count, o.fractional_trading_enabled) || count <= Number(o.fill_count_fp)) { err.textContent = tx('pro.orders.bad_total', { filled: qty(o.fill_count_fp) }); return; }
        try { await api.amendOrder(uid, o.order_id, { price_dollars: ccDollars(pcc), count_fp: count.toFixed(2) }); state.amending = null; toast(tx('pro.orders.amended')); refreshAccount(); } catch (ex) { err.textContent = ex.message; }
      };
    }
  }

  // ------------------------------------------------------------------------------------------ positions
  let posSeq = 0;
  async function drawPositions() {
    if (!uid) return;
    const my = ++posSeq; const box = body('positions');
    let list;
    try { list = (await api.positions(uid)).positions.filter((p) => p.side && Number(p.position_fp) > 0); } catch (ex) { if (my === posSeq) box.innerHTML = `<p class="faint">${esc(ex.message)}</p>`; return; }
    if (my !== posSeq) return;
    box.innerHTML = list.length ? `<div class="pro-scroll"><table class="table pro-small" data-testid="pro-positions"><thead><tr><th>${te('pro.positions.market')}</th><th>${te('pro.positions.side')}</th><th class="num">${te('pro.positions.qty')}</th><th class="num">${te('pro.positions.avg')}</th><th class="num">${te('pro.positions.value')}</th><th></th></tr></thead><tbody>
      ${list.map((p) => `<tr data-position="${esc(p.ticker)}" data-testid="pro-position-row"><td><button type="button" class="link-btn" data-pick="${esc(p.ticker)}">${esc(p.outcome)}</button></td><td><strong class="c-${esc(p.side)}">${esc(p.side.toUpperCase())}</strong></td><td class="num" data-testid="pro-position-qty">${qty(p.position_fp)}</td>
        <td class="num">${esc(px(p.avg_price_dollars))}</td><td class="num">${money(p.market_value_dollars)}</td>
        <td class="row-actions">${p.market_status === 'active' ? `<button class="btn btn-sm" type="button" data-close-market="${esc(p.ticker)}" data-testid="pro-close-market">${te('pro.positions.close_market')}</button><button class="btn btn-sm" type="button" data-close-bid="${esc(p.ticker)}" data-testid="pro-close-bid">${te('pro.positions.close_bid')}</button>` : `<span class="faint">${esc(p.market_status)}</span>`}</td></tr>`).join('')}</tbody></table></div>`
      : `<p class="faint" data-testid="pro-no-positions">${te('pro.positions.none')}</p>`;
    const byT = new Map(list.map((p) => [p.ticker, p]));
    // Closing sells the whole position of the held side: at market, or as a limit at the current best bid for that side.
    const close = async (b, p, atBid) => {
      b.disabled = true;
      try {
        const body = { ticker: p.ticker, side: p.side, action: 'sell', count: Number(p.position_fp), type: atBid ? 'limit' : 'market' };
        if (atBid) {
          const ob = await api.orderbook(p.ticker);
          const bids = (p.side === 'yes' ? ob.orderbook_fp.yes_dollars : ob.orderbook_fp.no_dollars).map(([x]) => ccOf(x));
          if (!bids.length) throw new Error(tx('pro.positions.no_bid'));
          body.price_dollars = ccDollars(Math.max(...bids));
        }
        const r = await api.submitOrder(uid, body);
        toast(tx('pro.positions.closed', { filled: qty(r.order.fill_count_fp), side: p.side.toUpperCase(), left: qty(r.order.remaining_count_fp) }));
      } catch (ex) { toast(ex.message, 'error'); }
      refreshAccount();
    };
    for (const b of box.querySelectorAll('[data-close-market]')) b.onclick = () => close(b, byT.get(b.dataset.closeMarket), false);
    for (const b of box.querySelectorAll('[data-close-bid]')) b.onclick = () => close(b, byT.get(b.dataset.closeBid), true);
  }
  el.addEventListener('click', (e) => { const b = e.target.closest('[data-pick]'); if (b) select(b.dataset.pick); });

  // ------------------------------------------------------------------------------------------ tape
  function drawTape() {
    const box = body('tape');
    if (!state.selected) { box.innerHTML = `<p class="faint">${te('pro.render.select_market')}</p>`; return; }
    box.innerHTML = state.trades.length ? `<div class="pro-scroll pro-tape"><table class="table pro-small" data-testid="pro-tape"><thead><tr><th>${te('pro.tape.time')}</th><th>${te('pro.tape.taker')}</th><th class="num">${te('pro.tape.yes_price')}</th><th class="num">${te('pro.tape.qty')}</th></tr></thead><tbody>
      ${state.trades.map((t) => `<tr data-testid="pro-tape-row"><td class="faint">${esc(fmtDt(t.created_time, { hour: 'numeric', minute: '2-digit', second: '2-digit' }))}</td><td><strong class="c-${esc(t.taker_side)}">${esc(String(t.taker_side).toUpperCase())}</strong></td><td class="num">${esc(px(t.yes_price_dollars))}</td><td class="num">${qty(t.count_fp)}</td></tr>`).join('')}</tbody></table></div>`
      : `<p class="faint" data-testid="pro-no-trades">${te('pro.tape.none')}</p>`;
  }

  // ------------------------------------------------------------------------------------------ price alerts
  let alertSeq = 0;
  async function drawAlerts() {
    if (!uid) return;
    const box = body('alerts');
    if (!flagOn('price_alerts')) { box.innerHTML = `<p class="faint" data-testid="pro-alerts-off">${te('pro.alerts.off')}</p>`; return; }
    if (!state.selected) { box.innerHTML = `<p class="faint">${te('pro.render.select_market')}</p>`; return; }
    const my = ++alertSeq; const ticker = state.selected;
    let list = [];
    try { list = (await api.priceTargets(uid, ticker)).price_targets; } catch { /* shown empty */ }
    if (my !== alertSeq) return;
    const last = state.market && state.market.last_price_dollars != null ? Math.round(Number(state.market.last_price_dollars) * 100) : 50;
    box.innerHTML = `<form class="pro-alert-form" id="pro-alert-form" data-testid="pro-alert-form" novalidate><label class="pro-field pro-field-inline">${te('pro.alerts.when_yes')}<select name="direction"><option value="above">${te('pro.alerts.above')}</option><option value="below">${te('pro.alerts.below')}</option></select></label>
      <label class="pro-field pro-field-inline">${esc(T('input.price', { unit: priceUnit() }))}<input name="price" type="number" min="1" max="99" step="1" value="${Math.min(99, Math.max(1, last + 5))}" data-testid="pro-alert-price"></label><button class="btn btn-sm" type="submit" data-testid="pro-alert-add">${te('pro.alerts.add')}</button></form>
      <div class="form-error" role="alert" id="pro-alert-error"></div>
      ${list.length ? `<ul class="pro-alerts" data-testid="pro-alerts">${list.map((a) => `<li data-alert="${esc(a.id)}" data-testid="pro-alert-row"><span>${esc(a.direction === 'above' ? tx('pro.alerts.above') : tx('pro.alerts.below'))} ${esc(px(a.price_dollars))} <span class="faint">${a.triggered_time ? te('pro.alerts.triggered') : te('pro.alerts.active')}</span></span><button class="btn btn-sm btn-ghost" type="button" data-del-alert="${esc(a.id)}" data-testid="pro-alert-delete">${te('pro.alerts.delete')}</button></li>`).join('')}</ul>` : `<p class="faint" data-testid="pro-no-alerts">${te('pro.alerts.none')}</p>`}`;
    const f = box.querySelector('#pro-alert-form');
    f.onsubmit = async (e) => {
      e.preventDefault();
      const p = Number(f.price.value);
      if (!(Number.isInteger(p) && p >= 1 && p <= 99)) { box.querySelector('#pro-alert-error').textContent = tx('pro.alerts.bad_price'); return; }
      try { await api.addPriceTarget(uid, { market_ticker: ticker, direction: f.direction.value, price_cents: p }); toast(tx('pro.alerts.added')); drawAlerts(); } catch (ex) { box.querySelector('#pro-alert-error').textContent = ex.message; }
    };
    for (const b of box.querySelectorAll('[data-del-alert]')) b.onclick = async () => { b.disabled = true; try { await api.deletePriceTarget(uid, b.dataset.delAlert); toast(tx('pro.alerts.deleted')); } catch (ex) { toast(ex.message, 'error'); } drawAlerts(); };
  }

  // ------------------------------------------------------------------------------------------ live updates
  const refreshAccount = debounced(() => { drawOrders(); drawPositions(); }, 250);
  const drawRowsSoon = debounced(drawRows, 200);
  unsubs.push(socket.subscribe({ channels: ['ticker'] }, (msg) => {
    const x = msg.msg;
    const r = rowOf(x.market_ticker);
    if (r) {
      Object.assign(r, { yes_bid_dollars: x.yes_bid_dollars, yes_ask_dollars: x.yes_ask_dollars, last_price_dollars: x.last_price_dollars, volume_fp: x.volume_fp });
      const b = cc(r.yes_bid_dollars); const a = cc(r.yes_ask_dollars); const l = cc(r.last_price_dollars); const pv = cc(r.previous_day_price_dollars);
      r.spread_cents = b != null && a != null ? (a - b) / 100 : null;
      r.move_24h_cents = l != null && pv != null ? (l - pv) / 100 : r.move_24h_cents;
      drawRowsSoon();
    }
    const m = state.market;
    if (m && m.ticker === x.market_ticker) {
      Object.assign(m, { yes_bid_dollars: x.yes_bid_dollars, yes_ask_dollars: x.yes_ask_dollars, last_price_dollars: x.last_price_dollars,
        no_bid_dollars: x.yes_ask_dollars == null ? null : (1 - Number(x.yes_ask_dollars)).toFixed(4), no_ask_dollars: x.yes_bid_dollars == null ? null : (1 - Number(x.yes_bid_dollars)).toFixed(4) });
    }
  }));
  if (uid) {
    unsubs.push(socket.subscribe({ channels: ['user_orders'] }, refreshAccount));
    unsubs.push(socket.subscribe({ channels: ['fill'] }, refreshAccount));
  }
  unsubs.push(socket.onPoll(() => { loadRows(); refreshAccount(); if (state.selected) drawChart(); }));
  const onNotif = (e) => { if (e.detail && e.detail.type === 'price_target') drawAlerts(); };
  window.addEventListener('parlance:notification', onNotif);
  unsubs.push(() => window.removeEventListener('parlance:notification', onNotif));

  // ------------------------------------------------------------------------------------------ first draw
  applyLayout(); drawScreens();
  await loadRows();
  drawOrders(); drawPositions(); drawTape(); drawChart(); drawLadder(); drawTicket(); drawAlerts();
  const want = query && query.get('market');
  await select(want || sortedRows()[0]?.ticker);
  return () => { for (const f of unsubMarket) f(); for (const u of unsubs) u(); for (const t of timers) clearTimeout(t); timers.clear(); };
}

// Candlesticks (YES price) over volume bars, with the shared hover readout (open / high / low / close and volume).
function candleSvg(list, tf) {
  installChartHover();
  if (!list.length) return `<p class="faint" data-testid="pro-chart-empty">${te('pro.chart.no_trades')}</p>`;
  const W = 720; const H = 320; const padR = 50; const padT = 10; const padB = 22; const volH = 56; const gap = 10;
  const priceH = H - padT - padB - volH - gap;
  const ks = list.map((k) => ({ o: ccOf(k.open_dollars) / 100, h: ccOf(k.high_dollars) / 100, l: ccOf(k.low_dollars) / 100, c: ccOf(k.close_dollars) / 100, v: Number(k.volume_fp), t: k.start_ts * 1000 }));
  let lo = Math.min(...ks.map((k) => k.l)); let hi = Math.max(...ks.map((k) => k.h));
  if (hi - lo < 4) { lo -= 2; hi += 2; }
  lo = Math.max(0, Math.floor(lo - 1)); hi = Math.min(100, Math.ceil(hi + 1));
  const plotW = W - padR - 8; const cw = plotW / ks.length; const bw = Math.max(1, Math.min(14, cw * 0.66));
  const x = (i) => i * cw + cw / 2;
  const sy = (v) => padT + (1 - (v - lo) / Math.max(1e-9, hi - lo)) * priceH;
  const vmax = Math.max(1e-9, ...ks.map((k) => k.v)); const vy0 = H - padB;
  const sv = (v) => (v / vmax) * volH;
  const grid = [0, 1, 2, 3, 4].map((i) => lo + ((hi - lo) * i) / 4).map((g) => `<line x1="0" x2="${plotW}" y1="${sy(g).toFixed(1)}" y2="${sy(g).toFixed(1)}" stroke="var(--fill-x50)" stroke-dasharray="1 5"/><text x="${W - 4}" y="${(sy(g) + 4).toFixed(1)}" text-anchor="end" font-size="12" fill="var(--text-x20)">${esc(pxc(Math.round(g * 100)))}</text>`).join('');
  const fmt = tf === '1H' || tf === '1D' ? { hour: 'numeric', minute: '2-digit' } : tf === '1W' ? { day: 'numeric', month: 'short', hour: 'numeric' } : { day: 'numeric', month: 'short' };
  const ticks = [0, 0.33, 0.66, 1].map((f) => Math.min(ks.length - 1, Math.round(f * (ks.length - 1)))).filter((v, i, a) => a.indexOf(v) === i)
    .map((i, j, a) => `<text x="${x(i).toFixed(1)}" y="${H - 6}" font-size="12" fill="var(--text-x20)" text-anchor="${j === 0 ? 'start' : j === a.length - 1 ? 'end' : 'middle'}">${esc(fmtDt(ks[i].t, fmt))}</text>`).join('');
  const bars = ks.map((k, i) => {
    const up = k.c >= k.o; const col = up ? 'var(--yes)' : 'var(--no)';
    const top = sy(Math.max(k.o, k.c)); const h = Math.max(1, Math.abs(sy(k.o) - sy(k.c)));
    return `<g data-testid="pro-candle" data-up="${up ? 1 : 0}"><line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${sy(k.h).toFixed(1)}" y2="${sy(k.l).toFixed(1)}" stroke="${col}" stroke-width="1"/><rect x="${(x(i) - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${col}"/>`
      + `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${(vy0 - sv(k.v)).toFixed(1)}" width="${bw.toFixed(1)}" height="${sv(k.v).toFixed(1)}" fill="${col}" opacity=".35"/></g>`;
  }).join('');
  const hover = hoverAttr([{ name: tx('pro.chart.candle'), color: 'var(--text-x10)', points: ks.map((k, i) => ({ x: x(i), y: sy(k.c), t: k.t, label: tx('pro.chart.ohlc', { o: pxc(Math.round(k.o * 100)), h: pxc(Math.round(k.h * 100)), l: pxc(Math.round(k.l * 100)), c: pxc(Math.round(k.c * 100)), v: qty(k.v) }) })) }], { x0: 0, x1: plotW });
  const lastK = ks[ks.length - 1];
  const sr = tx('pro.chart.sr', { count: ks.length, close: pxc(Math.round(lastK.c * 100)), high: pxc(Math.round(Math.max(...ks.map((k) => k.h)) * 100)), low: pxc(Math.round(Math.min(...ks.map((k) => k.l)) * 100)) });
  return `<svg class="chart pro-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(sr)}" data-testid="pro-chart" data-count="${ks.length}"${hover}>${grid}<line x1="0" x2="${plotW}" y1="${vy0}" y2="${vy0}" stroke="var(--line)"/>${bars}${ticks}</svg>`;
}

// The classic Pro page (before 2026-11-15, owner setting pro.layout = classic): one sortable, live table of the open
// markets of the top 100 events, each row linking to the event ticket.
const CLASSIC_COLS = [['title', ts('pro.cols.market')], ['bid', ts('pro.cols.bid')], ['ask', ts('pro.cols.ask')], ['last', ts('pro.cols.last')], ['chg', ts('pro.cols.change')], ['vol', ts('pro.cols.volume')]];
async function renderClassic({ el }) {
  const r = await api.search({ status: 'open', page_size: 100, order_by: 'event-volume' });
  const rows = [];
  for (const ev of r.current_page) for (const m of ev.markets.filter((x) => x.status === 'active')) rows.push({ ev, m });
  let sort = ['vol', -1];
  const val = ({ ev, m }, k) => ({ title: `${ev.title} ${m.yes_sub_title}`, bid: cents(m.yes_bid_dollars) ?? -1, ask: cents(m.yes_ask_dollars) ?? 999, last: prob(m) ?? -1, chg: (prob(m) ?? 0) - (cents(m.previous_price_dollars) ?? prob(m) ?? 0), vol: Number(m.volume_fp) }[k]);
  el.innerHTML = `<div class="page-head pt-0" data-testid="pro-classic"><h1 class="page-title">${te('pro.render.pro')}</h1><span class="faint">${te('pro.render.open_markets_live', { value: rows.length })}</span></div>
    <div class="card p-4-16"><table class="table pro-table" data-testid="pro-table"><thead><tr>${CLASSIC_COLS.map(([k, l]) => `<th class="${k === 'title' ? '' : 'num'}"><button class="btn btn-ghost btn-sm" data-sort="${esc(k)}">${esc(l)}</button></th>`).join('')}<th></th></tr></thead><tbody id="pro-rows"></tbody></table></div>`;
  const draw = () => {
    const [k, dir] = sort;
    const list = [...rows].sort((a, b) => { const x = val(a, k); const y = val(b, k); return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir; });
    el.querySelector('#pro-rows').innerHTML = list.map(({ ev, m }) => {
      const chg = val({ ev, m }, 'chg');
      return `<tr data-ticker="${esc(m.ticker)}"><td><a href="${eventHref(ev)}?market=${esc(m.ticker)}" data-link><strong>${esc(m.yes_sub_title)}</strong> <span class="faint">${esc(ev.title)} · ${esc(catLabel(ev.category))}</span></a></td>
        <td class="num c-yes">${esc(pxCents(cents(m.yes_bid_dollars)))}</td><td class="num c-no">${esc(pxCents(cents(m.yes_ask_dollars)))}</td><td class="num"><strong>${prob(m) ?? '—'}%</strong></td>
        <td class="num ${chg >= 0 ? 'delta-up' : 'delta-down'}">${chg ? (chg > 0 ? '+' : '') + chg : '0'}</td><td class="num">${qty(m.volume_fp)}</td>
        <td><a class="btn btn-sm" href="${eventHref(ev)}?side=yes&amp;market=${esc(m.ticker)}" data-link>${te('pro.render.trade')}</a></td></tr>`;
    }).join('');
  };
  for (const b of el.querySelectorAll('[data-sort]')) b.onclick = () => { sort = [b.dataset.sort, sort[0] === b.dataset.sort ? -sort[1] : -1]; draw(); };
  draw();
  let t = null;
  const unsub = socket.subscribe({ channels: ['ticker'] }, (msg) => {
    const row = rows.find((x) => x.m.ticker === msg.msg.market_ticker);
    if (!row) return;
    Object.assign(row.m, { yes_bid_dollars: msg.msg.yes_bid_dollars, yes_ask_dollars: msg.msg.yes_ask_dollars, last_price_dollars: msg.msg.last_price_dollars, volume_fp: msg.msg.volume_fp });
    clearTimeout(t); t = setTimeout(draw, 150);
  });
  return () => { unsub(); clearTimeout(t); };
}
