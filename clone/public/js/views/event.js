// Event detail (spec §4.3): market list, chart, live order book, trade ticket, rules, admin lifecycle.
import { api } from '../api.js';
import { session, queries } from '../store.js';
import { socket } from '../ws.js';
import { esc, cents, prob, multiplier, money, qty, shortDate, toast, eventHref, catColor, catSlug, compact, relTime, ICON } from '../lib.js';
import { lineChart, postCard } from './components.js';
import { wirePosts, composer, wireComposer } from './social.js';

const RANGES = { '1d': [86400, 1], '1w': [7 * 86400, 60], 'all': [60 * 86400, 1440] };
const FEE_RATE = 0.07; // display estimate; mirrors the server design choice
const TABS = [['rules', 'Rules'], ['book', 'Order book'], ['trades', 'Activity'], ['ideas', 'Ideas'], ['holders', 'Top holders']];

export async function render({ el, params, query, navigate }) {
  const eventTicker = params.event.toUpperCase();
  const { event: ev } = await api.event(eventTicker);
  const { series } = await api.series(ev.series_ticker);
  document.title = `${ev.title} · Parlance`;
  if (session.user) api.visit(session.uid, ev.event_ticker).catch(() => {});

  const props = session.props;
  const state = {
    ev,
    selected: (query && ev.markets.find((m) => m.ticker === query.get('market'))?.ticker) || ev.markets.find((m) => m.status === 'active')?.ticker || ev.markets[0].ticker,
    side: query && query.get('side') === 'no' ? 'no' : 'yes',
    orderType: 'limit',
    range: props.chart_range || '1w',
    bottomTab: TABS.some(([k]) => k === props.event_bottom_tab) ? props.event_bottom_tab : 'rules',
    book: { yes: new Map(), no: new Map() },
    watching: false,
  };
  if (session.user) {
    try { state.watching = (await api.watchlist(session.uid)).events.some((e) => e.event_ticker === ev.event_ticker); } catch { /* ignore */ }
  }
  const market = () => state.ev.markets.find((m) => m.ticker === state.selected);

  el.innerHTML = `<div class="ev-layout">
    <div>
      <div class="ev-header">
        <span class="mcard-icon" style="width:56px;height:56px;font-size:22px;background:${catColor(ev.category)}" aria-hidden="true">${esc(series.title[0])}</span>
        <div style="flex:1;min-width:0"><div class="crumbs"><a href="/category/${catSlug(ev.category)}" data-link>${esc(ev.category)}</a><span>·</span><span>${esc(series.title)}</span></div>
          <h1 class="typ-title-x10" data-testid="event-title">${esc(ev.title)}</h1><div class="muted">${esc(ev.sub_title)}</div>
          ${ev.is_live ? `<div class="live-dot" style="margin-top:6px">Live · ${esc(ev.live_label)}</div>` : ''}
          <div class="ev-stats" id="ev-stats"></div></div>
        <button class="btn" id="watch-btn" data-testid="watch-btn" aria-pressed="${state.watching}"></button>
      </div>
      <section class="chart-box">
        <div class="chart-head"><div><div class="faint" id="chart-label"></div><span class="chart-prob" id="chart-prob" data-testid="chart-prob"></span> <span class="change-chips" id="changes" data-testid="changes"></span></div>
          <div class="seg" role="tablist" aria-label="Chart range">${Object.keys(RANGES).map((r) => `<button data-range="${r}" class="${r === state.range ? 'on' : ''}">${r.toUpperCase()}</button>`).join('')}</div></div>
        <div id="chart"></div>
      </section>
      <section class="card" style="padding:4px 12px">
        <table class="mkt-table" aria-label="Outcomes"><thead><tr><th>Outcome</th><th>Chance</th><th></th><th></th></tr></thead><tbody id="mkt-rows"></tbody></table>
      </section>
      <div class="tabs" role="tablist">
        ${TABS.map(([t, l]) => `<button data-tab="${t}" class="${t === state.bottomTab ? 'on' : ''}">${l}</button>`).join('')}
      </div>
      <div id="bottom"></div>
    </div>
    <aside>
      <section class="card ticket" id="ticket" aria-label="Trade ticket"></section>
      <div id="position"></div>
      <div id="alerts"></div>
      <div id="admin"></div>
    </aside>
  </div>`;

  const $ = (s) => el.querySelector(s);

  function drawWatch() {
    const b = $('#watch-btn');
    b.innerHTML = state.watching ? `${ICON.star} Watching` : '☆ Watch';
    b.setAttribute('aria-pressed', String(state.watching));
  }
  $('#watch-btn').onclick = async () => {
    if (!session.user) return navigate('/sign-in?next=' + encodeURIComponent(location.pathname));
    try {
      if (state.watching) await api.unwatch(session.uid, ev.event_ticker); else await api.watch(session.uid, ev.event_ticker);
      state.watching = !state.watching;
      drawWatch();
      toast(state.watching ? 'Added to watchlist' : 'Removed from watchlist');
    } catch (e) { toast(e.message, 'error'); }
  };

  function drawRows() {
    $('#mkt-rows').innerHTML = state.ev.markets.map((m) => {
      const p = prob(m);
      const tradable = m.status === 'active';
      const yesAsk = cents(m.yes_ask_dollars); const noAsk = cents(m.no_ask_dollars);
      const statusNote = tradable ? '' : `<div class="faint">${m.status === 'finalized' || m.status === 'determined' ? 'Resolved ' + esc(m.result.toUpperCase()) : esc(m.status)}</div>`;
      return `<tr data-ticker="${esc(m.ticker)}" class="${m.ticker === state.selected ? 'selected' : ''}">
        <td><span class="outcome-dot" style="display:inline-block;background:${esc(m.color_code)};margin-right:8px"></span>${esc(m.yes_sub_title)}${statusNote}<div class="faint">${qty(m.volume_fp)} traded · ${multiplier(m)}</div></td>
        <td class="num prob" data-testid="prob-${esc(m.ticker)}">${p == null ? '—' : p + '%'}</td>
        <td><button class="yes-btn ${m.ticker === state.selected && state.side === 'yes' ? 'on' : ''}" data-pick="yes" ${tradable ? '' : 'disabled'}>Yes ${yesAsk ? yesAsk + '¢' : '—'}</button></td>
        <td><button class="no-btn ${m.ticker === state.selected && state.side === 'no' ? 'on' : ''}" data-pick="no" ${tradable ? '' : 'disabled'}>No ${noAsk ? noAsk + '¢' : '—'}</button></td></tr>`;
    }).join('');
    for (const tr of el.querySelectorAll('#mkt-rows tr')) {
      tr.onclick = (e) => {
        const pick = e.target.closest('[data-pick]');
        const changed = state.selected !== tr.dataset.ticker;
        state.selected = tr.dataset.ticker;
        if (pick) state.side = pick.dataset.pick;
        drawRows(); drawTicket(pick ? defaultPrice() : null);
        if (changed) { subscribeBook(); drawChart(); drawBottom(); drawPosition(); drawAlerts(); }
      };
    }
  }

  function drawHeadline() {
    const m = market();
    const p = prob(m);
    $('#chart-prob').textContent = p == null ? '' : `${p}% chance`;
    const chip = (label, prev) => {
      if (p == null || prev == null) return '';
      const d = p - cents(prev);
      return `<span>${label} <span class="${d >= 0 ? 'delta-up' : 'delta-down'}">${d >= 0 ? '▲' : '▼'}${Math.abs(d)}</span></span>`;
    };
    $('#changes').innerHTML = chip('1H', m.previous_hour_price_dollars) + chip('1D', m.previous_day_price_dollars) + chip('1W', m.previous_week_price_dollars);
    const vol = state.ev.markets.reduce((a, x) => a + Number(x.volume_fp || 0), 0);
    const close = Math.min(...state.ev.markets.map((x) => Date.parse(x.close_time)));
    $('#ev-stats').innerHTML = `<span><strong>${compact(vol)}</strong> contracts traded</span><span>Closes <strong>${shortDate(new Date(close).toISOString())}</strong></span><span>${state.ev.markets.length} outcome${state.ev.markets.length > 1 ? 's' : ''}</span>`;
  }

  async function drawChart() {
    const m = market();
    $('#chart-label').textContent = m.yes_sub_title;
    drawHeadline();
    const [span, period] = RANGES[state.range];
    const now = Math.floor(Date.now() / 1000);
    try {
      const c = await api.candles(ev.series_ticker, m.ticker, { start_ts: now - span, end_ts: now, period_interval: period });
      if (market() !== m) return;
      $('#chart').innerHTML = lineChart(c.candlesticks.map((k) => ({ t: k.end_period_ts, v: cents(k.price.close_dollars) })), m.color_code);
    } catch (e) { $('#chart').innerHTML = `<p class="faint">Chart unavailable: ${esc(e.message)}</p>`; }
  }
  for (const b of el.querySelectorAll('[data-range]')) {
    b.onclick = () => {
      state.range = b.dataset.range;
      for (const x of el.querySelectorAll('[data-range]')) x.classList.toggle('on', x === b);
      if (session.user) session.setProp('chart_range', state.range).catch(() => {});
      drawChart();
    };
  }

  // ----- trade ticket state machine: idle → editing → submitting → confirmed | error -----
  const defaultPrice = () => {
    const m = market();
    return state.side === 'yes' ? cents(m.yes_ask_dollars) || prob(m) || 50 : cents(m.no_ask_dollars) || (100 - (prob(m) || 50));
  };
  let ticketPrice = null;
  function drawTicket(price) {
    const m = market();
    if (price != null) ticketPrice = price;
    if (ticketPrice == null) ticketPrice = defaultPrice();
    const t = $('#ticket');
    if (m.status !== 'active') {
      t.innerHTML = `<h3>${esc(m.yes_sub_title)}</h3><p class="muted" data-testid="ticket-closed">Trading is ${m.status === 'initialized' ? 'not open yet. Opens ' + shortDate(m.open_time) : 'closed for this market'}.${m.result ? ` Result: <strong>${esc(m.result.toUpperCase())}</strong>` : ''}</p>`;
      return;
    }
    t.innerHTML = `<div style="display:flex;gap:10px;align-items:center"><span class="outcome-dot" style="background:${esc(m.color_code)};width:12px;height:12px"></span><h3>${esc(m.yes_sub_title)}</h3></div><div class="faint">Closes ${shortDate(m.close_time)}</div>
      <div class="side-toggle"><button data-side="yes" class="${state.side === 'yes' ? 'on-yes' : ''}">Buy Yes ${cents(m.yes_ask_dollars) ? cents(m.yes_ask_dollars) + '¢' : ''}</button><button data-side="no" class="${state.side === 'no' ? 'on-no' : ''}">Buy No ${cents(m.no_ask_dollars) ? cents(m.no_ask_dollars) + '¢' : ''}</button></div>
      <div class="seg" style="width:100%"><button data-otype="limit" class="${state.orderType === 'limit' ? 'on' : ''}" style="flex:1">Limit</button><button data-otype="market" class="${state.orderType === 'market' ? 'on' : ''}" style="flex:1">Market</button></div>
      ${state.orderType === 'limit' ? `<label class="field">Limit price (¢)<input id="t-price" type="number" min="1" max="99" step="1" value="${ticketPrice}" inputmode="numeric"></label>` : ''}
      <label class="field">Contracts<input id="t-count" type="number" min="1" step="1" value="10" inputmode="numeric"></label>
      <div class="summary" id="t-summary"></div>
      <div class="form-error" id="t-error" role="alert"></div>
      <button class="btn btn-primary" style="width:100%;height:44px" id="t-submit" data-testid="submit-order">${session.user ? 'Place order' : 'Log in to trade'}</button>`;
    for (const b of t.querySelectorAll('[data-side]')) b.onclick = () => { state.side = b.dataset.side; drawRows(); drawTicket(defaultPrice()); };
    for (const b of t.querySelectorAll('[data-otype]')) b.onclick = () => { state.orderType = b.dataset.otype; drawTicket(); };
    const recalc = () => {
      const p = state.orderType === 'market' ? defaultPrice() : Number(t.querySelector('#t-price').value);
      const c = Number(t.querySelector('#t-count').value);
      if (state.orderType === 'limit') ticketPrice = p;
      const ok = Number.isInteger(p) && p >= 1 && p <= 99 && Number.isInteger(c) && c >= 1;
      const cost = ok ? (p * c) / 100 : 0;
      const fee = ok ? Math.ceil(FEE_RATE * c * p * (100 - p) / 100) / 100 : 0;
      t.querySelector('#t-summary').innerHTML = ok ? `<span>${state.orderType === 'market' ? 'Est. cost' : 'Max cost'}</span><span class="num" data-testid="t-cost">${money(cost)}</span>
        <span>Est. fee (if taken)</span><span class="num">${money(fee)}</span>
        <span>Payout if ${state.side.toUpperCase()}</span><span class="num" data-testid="t-payout">${money(c)}</span>` : '<span class="faint">Enter a price between 1¢ and 99¢ and a whole number of contracts.</span>';
      t.querySelector('#t-submit').disabled = !ok && !!session.user;
    };
    t.querySelectorAll('input').forEach((i) => { i.oninput = recalc; });
    recalc();
    t.querySelector('#t-submit').onclick = async () => {
      if (!session.user) return navigate('/sign-in?next=' + encodeURIComponent(location.pathname));
      const btn = t.querySelector('#t-submit');
      const errEl = t.querySelector('#t-error');
      errEl.textContent = '';
      btn.disabled = true; btn.textContent = 'Submitting…';
      try {
        const body = { ticker: m.ticker, side: state.side, count: Number(t.querySelector('#t-count').value), type: state.orderType };
        if (state.orderType === 'limit') body.price = Number(t.querySelector('#t-price').value);
        const r = await api.submitOrder(session.uid, body);
        const o = r.order;
        toast(o.status === 'executed' ? `Filled ${qty(o.fill_count_fp)} ${o.side.toUpperCase()}` : o.status === 'resting' ? `Order resting · ${qty(o.fill_count_fp)} filled, ${qty(o.remaining_count_fp)} open` : `Order ${o.status} · ${qty(o.fill_count_fp)} filled`);
        queries.invalidate(['home']);
        drawPosition();
      } catch (e) {
        errEl.textContent = e.unauthorized ? 'Your session expired. Please log in again.' : e.message;
      } finally { btn.disabled = false; btn.textContent = 'Place order'; }
    };
  }

  // ----- order book: REST snapshot then WS orderbook_snapshot / orderbook_delta -----
  let unsubBook = null;
  function subscribeBook() {
    if (unsubBook) unsubBook();
    state.book = { yes: new Map(), no: new Map() };
    const ticker = state.selected;
    api.orderbook(ticker).then((ob) => {
      if (state.selected !== ticker) return;
      state.book = { yes: new Map(ob.orderbook_fp.yes_dollars.map(([p, c]) => [cents(p), Number(c)])), no: new Map(ob.orderbook_fp.no_dollars.map(([p, c]) => [cents(p), Number(c)])) };
      drawBottom();
    }).catch(() => {});
    unsubBook = socket.subscribe({ channels: ['orderbook'], market_tickers: [ticker] }, (msg) => {
      if (msg.msg.market_ticker !== state.selected) return;
      if (msg.type === 'orderbook_snapshot') {
        state.book = { yes: new Map(msg.msg.yes_dollars.map(([p, c]) => [cents(p), Number(c)])), no: new Map(msg.msg.no_dollars.map(([p, c]) => [cents(p), Number(c)])) };
      } else if (msg.type === 'orderbook_delta') {
        const map = state.book[msg.msg.side];
        const p = cents(msg.msg.price_dollars);
        const n = (map.get(p) || 0) + Number(msg.msg.delta_fp);
        if (n <= 0) map.delete(p); else map.set(p, n);
      }
      if (state.bottomTab === 'book') drawBottom();
    });
  }

  async function drawBottom() {
    const box = $('#bottom');
    const m = market();
    if (state.bottomTab === 'rules') {
      box.innerHTML = `<div class="card rules" style="padding:16px" data-testid="rules"><p>${esc(m.rules_primary)}</p><p>${esc(series.rules)}</p>
        <p class="faint">Settlement source: ${series.settlement_sources.map((s) => esc(s.name)).join(', ')} · Closes ${shortDate(m.close_time)} · Market ${esc(m.ticker)}</p></div>`;
    } else if (state.bottomTab === 'book') {
      // YES asks are NO bids mirrored (100 - p).
      const asks = [...state.book.no.entries()].map(([p, c]) => [100 - p, c]).sort((a, b) => a[0] - b[0]).slice(0, 8).reverse();
      const bids = [...state.book.yes.entries()].sort((a, b) => b[0] - a[0]).slice(0, 8);
      const max = Math.max(1, ...asks.map((a) => a[1]), ...bids.map((b) => b[1]));
      const row = (p, c, color) => `<div class="book-row"><span class="bar" style="width:${(c / max) * 100}%;background:${color}"></span><span>${p}¢</span><span style="text-align:right">${qty(c)}</span></div>`;
      box.innerHTML = `<div class="card" style="padding:16px" data-testid="orderbook"><div class="book">
        <div><h4 style="color:var(--no)">Offers to sell YES</h4>${asks.map(([p, c]) => row(p, c, 'var(--no)')).join('') || '<p class="faint">None</p>'}</div>
        <div><h4 style="color:var(--yes)">Bids to buy YES</h4>${bids.map(([p, c]) => row(p, c, 'var(--yes)')).join('') || '<p class="faint">None</p>'}</div></div></div>`;
    } else if (state.bottomTab === 'trades') {
      try {
        const r = await api.socialTrades({ event_ticker: ev.event_ticker });
        if (state.bottomTab !== 'trades') return;
        box.innerHTML = `<div class="card" style="padding:4px 16px"><table class="table" data-testid="trades"><thead><tr><th>Trader</th><th>Outcome</th><th>Bought</th><th class="num">Price</th><th class="num">Contracts</th><th class="num">When</th></tr></thead><tbody>
          ${r.trades.slice(0, 25).map((t) => { const px = t.taker_side === 'yes' ? cents(t.price_dollars) : 100 - cents(t.price_dollars); return `<tr><td>${t.taker_nickname ? `<a href="/social/profile/${encodeURIComponent(t.taker_nickname)}" data-link><strong>@${esc(t.taker_nickname)}</strong></a>` : '<span class="faint">Anonymous</span>'}</td><td>${esc(t.outcome)}</td><td><strong style="color:var(--${t.taker_side})">${t.taker_side.toUpperCase()}</strong></td><td class="num">${px}¢</td><td class="num">${qty(t.count_fp)}</td><td class="num faint">${relTime(t.create_date)}</td></tr>`; }).join('') || '<tr><td colspan="6" class="faint">No trades yet</td></tr>'}</tbody></table></div>`;
      } catch (e) { box.innerHTML = `<p class="faint">${esc(e.tooManyRequests ? 'Too many requests, try again shortly.' : e.message)}</p>`; }
    } else if (state.bottomTab === 'ideas') {
      const r = await api.posts({ event_ticker: ev.event_ticker });
      if (state.bottomTab !== 'ideas') return;
      box.innerHTML = `${composer(ev.event_ticker)}<div class="card" style="margin-top:8px" id="ev-posts" data-testid="event-posts">${r.posts.map((p) => postCard(p, { showEvent: false })).join('') || '<div class="empty" data-testid="no-ideas">No ideas yet. Be the first to share your view.</div>'}</div>`;
      wirePosts(box.querySelector('#ev-posts'), { navigate });
      wireComposer(box, (post) => { const list = box.querySelector('#ev-posts'); list.querySelector('[data-testid=no-ideas]')?.remove(); list.insertAdjacentHTML('afterbegin', postCard(post, { showEvent: false })); });
    } else {
      const r = await api.topHolders(m.ticker);
      if (state.bottomTab !== 'holders') return;
      const col = (title, rows, side) => `<div><h4 style="color:var(--${side})">${title}</h4>${rows.map((h, i) => `<a class="rank-row" href="/social/profile/${encodeURIComponent(h.nickname)}" data-link style="grid-template-columns:18px 1fr auto"><span class="faint">${i + 1}</span><span class="t">@${esc(h.nickname)}</span><span class="num">${qty(h.position_fp)}</span></a>`).join('') || '<p class="faint">No public holders yet.</p>'}</div>`;
      box.innerHTML = `<div class="card" style="padding:16px" data-testid="holders"><div class="faint" style="margin-bottom:8px">${esc(m.yes_sub_title)}</div><div class="book">${col('Yes holders', r.yes, 'yes')}${col('No holders', r.no, 'no')}</div></div>`;
    }
  }
  for (const b of el.querySelectorAll('[data-tab]')) {
    b.onclick = () => {
      state.bottomTab = b.dataset.tab;
      for (const x of el.querySelectorAll('[data-tab]')) x.classList.toggle('on', x === b);
      if (session.user) session.setProp('event_bottom_tab', state.bottomTab).catch(() => {});
      drawBottom();
    };
  }

  async function drawPosition() {
    const box = $('#position');
    if (!session.user) { box.innerHTML = ''; return; }
    try {
      const [{ positions }, { orders }] = await Promise.all([api.positions(session.uid), api.orders(session.uid, 'resting')]);
      const mine = positions.filter((p) => p.event_ticker === ev.event_ticker && p.side);
      const resting = orders.filter((o) => state.ev.markets.some((m) => m.ticker === o.ticker));
      box.innerHTML = (mine.length || resting.length) ? `<section class="card side-card" data-testid="my-position"><h3>Your position</h3>
        ${mine.map((p) => `<div class="outcome-row"><span class="outcome-name">${esc(p.outcome)} · <strong>${p.side.toUpperCase()}</strong></span><span class="num">${qty(p.position_fp)} @ ${cents(p.avg_price_dollars)}¢</span></div>`).join('')}
        ${resting.length ? `<div class="faint" style="margin-top:6px">${resting.length} resting order(s) — manage in <a href="/portfolio" data-link>Portfolio</a></div>` : ''}</section>` : '';
    } catch { box.innerHTML = ''; }
  }

  async function drawAlerts() {
    const box = $('#alerts');
    if (!session.user) { box.innerHTML = ''; return; }
    const m = market();
    let list = [];
    try { list = (await api.priceTargets(session.uid, m.ticker)).price_targets; } catch { /* ignore */ }
    if (market() !== m) return;
    const p = prob(m) ?? 50;
    box.innerHTML = `<section class="card side-card" data-testid="alert-card"><h3 style="display:flex;align-items:center;gap:6px">${ICON.bell.replace('<svg', '<svg width="16" height="16"')} Price alert</h3>
      <form class="inline-form" id="alert-form"><label class="field" style="flex:1 1 90px">When Yes is<select name="direction"><option value="above">above</option><option value="below">below</option></select></label>
      <label class="field" style="flex:1 1 70px">Price (¢)<input name="price" type="number" min="1" max="99" value="${Math.min(99, p + 5)}" required></label><button class="btn" type="submit">Add</button></form>
      <div class="form-error" id="alert-error" role="alert"></div>
      ${list.map((t) => `<div class="outcome-row" data-alert="${esc(t.id)}"><span class="outcome-name">${t.direction} ${cents(t.price_dollars)}¢ <span class="faint">${t.triggered_time ? '· triggered' : '· active'}</span></span><button class="btn btn-sm btn-ghost" data-del-alert>Remove</button></div>`).join('')}</section>`;
    const f = box.querySelector('#alert-form');
    f.onsubmit = async (e) => {
      e.preventDefault();
      try { await api.addPriceTarget(session.uid, { market_ticker: m.ticker, direction: f.direction.value, price_cents: Number(f.price.value) }); toast('Price alert set'); drawAlerts(); } catch (ex) { box.querySelector('#alert-error').textContent = ex.message; }
    };
    for (const b of box.querySelectorAll('[data-del-alert]')) b.onclick = async () => { await api.deletePriceTarget(session.uid, b.closest('[data-alert]').dataset.alert); drawAlerts(); };
  }

  function drawAdmin() {
    if (!session.user || !session.user.is_admin) return;
    const m = market();
    $('#admin').innerHTML = `<section class="card admin-box" data-testid="admin-panel"><strong>Exchange admin · ${esc(m.ticker)}</strong> <span class="faint">(${esc(m.status)})</span>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
        <button class="btn" data-admin="deactivate">Pause</button><button class="btn" data-admin="activate">Resume</button>
        <button class="btn" data-admin="close">Close</button>
        <button class="btn" data-admin="determine" data-result="yes">Resolve YES</button><button class="btn" data-admin="determine" data-result="no">Resolve NO</button></div></section>`;
    for (const b of el.querySelectorAll('[data-admin]')) {
      b.onclick = async () => {
        try { await api.admin(m.ticker, b.dataset.admin, b.dataset.result ? { result: b.dataset.result } : {}); toast(`Market ${b.dataset.admin} ok`); await refreshEvent(); } catch (e) { toast(e.message, 'error'); }
      };
    }
  }

  async function refreshEvent() {
    const r = await api.event(eventTicker);
    state.ev = r.event;
    drawRows(); drawTicket(); drawAdmin(); drawPosition();
    drawHeadline();
  }

  // Live updates: tickers for every market of the event, lifecycle, my fills.
  const tickers = ev.markets.map((m) => m.ticker);
  const unsubs = [];
  let pending = null;
  let tradeT = null;
  unsubs.push(socket.subscribe({ channels: ['ticker'] }, (msg) => {
    const m = state.ev.markets.find((x) => x.ticker === msg.msg.market_ticker);
    if (!m) return;
    Object.assign(m, { yes_bid_dollars: msg.msg.yes_bid_dollars, yes_ask_dollars: msg.msg.yes_ask_dollars, no_bid_dollars: msg.msg.yes_ask_dollars == null ? null : (1 - Number(msg.msg.yes_ask_dollars)).toFixed(4), no_ask_dollars: msg.msg.yes_bid_dollars == null ? null : (1 - Number(msg.msg.yes_bid_dollars)).toFixed(4), last_price_dollars: msg.msg.last_price_dollars, volume_fp: msg.msg.volume_fp });
    clearTimeout(pending);
    pending = setTimeout(() => { drawRows(); drawHeadline(); }, 100);
  }));
  unsubs.push(socket.subscribe({ channels: ['market_lifecycle_v2'], market_tickers: tickers }, () => refreshEvent().catch(() => {})));
  unsubs.push(socket.subscribe({ channels: ['trade'], market_tickers: tickers }, () => { if (state.bottomTab === 'trades') { clearTimeout(tradeT); tradeT = setTimeout(() => drawBottom(), 150); } }));
  const onNotif = (e) => { if (e.detail.type === 'price_target') drawAlerts(); };
  window.addEventListener('parlance:notification', onNotif);
  unsubs.push(() => window.removeEventListener('parlance:notification', onNotif));
  if (session.user) unsubs.push(socket.subscribe({ channels: ['fill'] }, (msg) => { if (tickers.includes(msg.msg.ticker)) drawPosition(); }));

  drawWatch(); drawRows(); drawTicket(query && query.get('side') ? defaultPrice() : null); drawChart(); subscribeBook(); drawBottom(); drawPosition(); drawAlerts(); drawAdmin();
  // Keep canonical URL (slug is decorative, spec §3).
  const canonical = eventHref({ ...ev, series_slug: series.slug });
  if (location.pathname !== canonical) history.replaceState({}, '', canonical);
  return () => { if (unsubBook) unsubBook(); for (const u of unsubs) u(); clearTimeout(pending); };
}
