// Event detail (spec §4.3, §13.5, §15.4): header with actions (calendar file, social, share, CSV), head-to-head bar,
// multi-line chart with ranges, outcome table, series events, Social / Activity / Order book / Rules / Top holders,
// "People are also trading", news; ticket with BUY/SELL, Dollars / Contracts / Limit modes, interest, max payout.
import { vars } from '../dynstyle.js';
import { api } from '../api.js';
import { session, queries } from '../store.js';
import { socket } from '../ws.js';
import { esc, cents, prob, multiplier, money, qty, validQty, shortDate, toast, eventHref, catSlug, catLabel, relTime, ICON, showShares } from '../lib.js';
import { postCard, ocAvatar, evIcon, multiChart, seriesColor, money0 } from './components.js';
import { wirePosts, composer, wireComposer } from './social.js';
import { newsItemsHtml } from './admin/site.js'; // CMS news items
import { mountEventScoreboard } from './sports.js'; // live scoreboard for sports events (CLONE_SPEC §19.6)
import { mountChat } from './chat.js'; // "● Live chat" pill + panel (CLONE_SPEC §20)
import { mountEventExtras, renderPromos } from './social2.js'; // follow event, price-move alerts, targeted promos (PHASE2_SPEC.md §24)

const RANGES = { '1d': [86400, 1], '1w': [7 * 86400, 60], '1m': [30 * 86400, 60], all: [365 * 86400, 1440] };
const FEE_RATE = 0.07; // display estimate; mirrors the server design choice
const TABS = [['ideas', 'Social'], ['trades', 'Activity'], ['book', 'Order book'], ['rules', 'Rules'], ['holders', 'Top holders']];
const MODES = [['dollars', 'Dollars'], ['market', 'Contracts'], ['limit', 'Limit order']];
const RFQ_MODE = ['rfq', 'Request quote']; // shown when the rfq_enabled user property is on (spec §17.6)
const COMBO_SERIES = 'PLXCOMBO';
const feeCents = (c, p) => Math.ceil((FEE_RATE * c * p * (100 - p)) / 100);
const SVG = {
  cal: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="3" y="4.5" width="14" height="12" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M3 8.5h14M7 2.5v4M13 2.5v4" stroke="currentColor" stroke-width="1.6"/></svg>',
  chat: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 3.5c4.1 0 7 2.6 7 5.8s-2.9 5.8-7 5.8c-.9 0-1.8-.1-2.6-.4L4 16l.9-3C3.7 12 3 10.7 3 9.3c0-3.2 2.9-5.8 7-5.8z" stroke="currentColor" stroke-width="1.6"/></svg>',
  share: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 13V3M6 6.5L10 2.5l4 4M4 11v5h12v-5" stroke="currentColor" stroke-width="1.6"/></svg>',
  dl: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 3v10M6 9.5l4 4 4-4M4 16.5h12" stroke="currentColor" stroke-width="1.6"/></svg>',
};
function download(name, type, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const icsDate = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

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
    action: 'buy',
    mode: MODES.some(([k]) => k === props.ticket_mode) || (props.ticket_mode === 'rfq' && props.rfq_enabled) ? props.ticket_mode : 'dollars',
    range: RANGES[props.chart_range] ? props.chart_range : '1w',
    bottomTab: TABS.some(([k]) => k === props.event_bottom_tab) ? props.event_bottom_tab : 'ideas',
    book: { yes: new Map(), no: new Map() },
    watching: false,
    held: { yes: 0, no: 0 },
    hideFrac: !!props.orderbook_hide_fractional_shares,
    comboMode: false,
    slip: null, // combo slip (server-persisted, spec §17.3)
  };
  const isCombo = ev.series_ticker === COMBO_SERIES;
  const comboEligible = !isCombo && !ev.series_ticker.startsWith('PLXFLASH');
  const modes = () => (session.props.rfq_enabled && !isCombo ? [...MODES, RFQ_MODE] : MODES);
  if (session.user) {
    try { state.watching = (await api.watchlist(session.uid)).events.some((e) => e.event_ticker === ev.event_ticker); } catch { /* ignore */ }
  }
  const market = () => state.ev.markets.find((m) => m.ticker === state.selected);
  const ranked = () => [...state.ev.markets].sort((a, b) => (prob(b) ?? 0) - (prob(a) ?? 0));
  const h2h = ev.markets.length === 2 && ev.mutually_exclusive;
  const closeIso = () => state.ev.markets.map((m) => m.close_time).sort()[0];

  el.innerHTML = `<div class="ev-layout">
    <div class="minw-0">
      <div class="ev-header">
        ${evIcon({ ...ev, series_title: series.title }, 'xl')}
        <div class="flex-1 minw-0"><div class="crumbs"><a href="${isCombo ? '/combos' : `/category/${catSlug(ev.category)}`}" data-link>${esc(catLabel(ev.category))}</a> &nbsp;/&nbsp; ${esc(series.title)}</div>
          <h1 data-testid="event-title">${esc(ev.title)}</h1><div class="muted fs-17">${esc(ev.sub_title)}</div>
          ${ev.is_live ? `<div class="live-dot mt-8">Live · ${esc(ev.live_label)}</div>` : ''}</div>
        <div class="ev-actions">
          <button class="icon-btn" id="ics-btn" data-testid="ics-btn" title="Add to calendar" aria-label="Add to calendar">${SVG.cal}</button>
          <button class="icon-btn" id="chat-btn" title="Discussion" aria-label="Go to discussion">${SVG.chat}</button>
          <button class="icon-btn" id="share-btn" title="Copy link" aria-label="Copy link">${SVG.share}</button>
          <button class="icon-btn" id="csv-btn" data-testid="csv-btn" title="Download price history" aria-label="Download price history">${SVG.dl}</button>
          <button class="btn btn-pill h-40" id="watch-btn" data-testid="watch-btn" aria-pressed="${state.watching}"></button>
        </div>
      </div>
      ${ev.live_data ? '<div id="sports-board" class="sb-mount"></div>' : ''}
      ${h2h ? `<div class="h2h" data-testid="h2h"></div>` : ''}
      ${isCombo ? '<section class="card combo-legs" id="combo-legs" data-testid="combo-legs" aria-label="Combo legs"></section>' : ''}
      <section class="chart-box">
        <div class="chart-head"><div class="legend" id="legend"></div><span class="watermark">Parlance</span></div>
        <div class="d-flex gap-14 ai-baseline mt-6"><span class="faint" id="chart-label"></span><span class="num" id="chart-prob" data-testid="chart-prob"></span><span class="change-chips" id="changes" data-testid="changes"></span></div>
        <div id="chart"></div>
        <div class="range-row"><span class="num" id="ev-vol"></span><div class="seg" role="tablist" aria-label="Chart range">${Object.keys(RANGES).map((r) => `<button data-range="${esc(r)}" class="${r === state.range ? 'on' : ''}">${esc(r.toUpperCase())}</button>`).join('')}</div></div>
      </section>
      <table class="mkt-table" aria-label="Outcomes"><thead><tr><th class="ta-l"></th><th>Chance</th><th></th><th></th></tr></thead><tbody id="mkt-rows"></tbody></table>
      <div id="series-events"></div>
      <div class="big-tabs" role="tablist">${TABS.map(([t, l]) => `<button data-tab="${t}" class="${t === state.bottomTab ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div id="bottom"></div>
      <div class="sec-head mt-44"><h2>People are also trading</h2></div><div id="also"></div>
      ${ev.news || ev.news_items ? `<div class="sec-head"><h2>News</h2></div>${newsItemsHtml(ev)}${ev.news ? `<div class="news-item" data-testid="news"><div class="src">${evIcon({ category: ev.category, title: 'P' }, 'sm')} PARLANCE NEWSROOM · ${new Date(Date.now() - 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div><b>${esc(ev.title)}</b><span class="muted">${esc(ev.news)}</span></div>` : ''}` : ''}
    </div>
    <aside>
      ${comboEligible ? '<button class="combo-btn ev-combo-btn" id="combo-toggle" data-testid="combo-toggle" aria-pressed="false">◇ COMBO</button><div id="combo-mini"></div>' : ''}
      <section class="card tkt ticket" id="ticket" aria-label="Trade ticket"></section>
      <div id="position"></div>
      <div id="alerts"></div>
      <div id="admin"></div>
    </aside>
  </div>`;

  const $ = (s) => el.querySelector(s);

  // ---------- header actions ----------
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
  // File formats (spec §9, §15.4): iCalendar reminder for the close time, CSV of the chart's price history.
  $('#ics-btn').onclick = () => {
    const close = closeIso();
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Parlance Exchange//Markets//EN', 'BEGIN:VEVENT', `UID:${ev.event_ticker}@parlance.local`, `DTSTAMP:${icsDate(new Date().toISOString())}`,
      `DTSTART:${icsDate(close)}`, `DTEND:${icsDate(new Date(Date.parse(close) + 1800000).toISOString())}`, `SUMMARY:${ev.title.replace(/[,;]/g, ' ')} closes`, `URL:${location.origin}${eventHref({ ...ev, series_slug: series.slug })}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    download(`${ev.event_ticker.toLowerCase()}.ics`, 'text/calendar', ics + '\r\n');
  };
  $('#csv-btn').onclick = async () => {
    const [span, period] = RANGES[state.range];
    const now = Math.floor(Date.now() / 1000);
    const rows = ['time,market,outcome,yes_price_dollars,volume_contracts'];
    for (const m of state.ev.markets) {
      const c = await api.candles(ev.series_ticker, m.ticker, { start_ts: now - span, end_ts: now, period_interval: period });
      for (const k of c.candlesticks) rows.push([new Date(k.end_period_ts * 1000).toISOString(), m.ticker, `"${m.yes_sub_title.replace(/"/g, '""')}"`, k.price.close_dollars, k.volume_fp].join(','));
    }
    download(`${ev.event_ticker.toLowerCase()}-prices.csv`, 'text/csv', rows.join('\n') + '\n');
  };
  $('#share-btn').onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); toast('Link copied'); } catch { toast(location.href); }
  };
  $('#chat-btn').onclick = () => { selectTab('ideas'); $('.big-tabs').scrollIntoView({ behavior: 'smooth' }); };

  // ---------- head-to-head, legend, rows ----------
  function drawH2H() {
    if (!h2h) return;
    const [a, b] = state.ev.markets;
    const pa = prob(a) ?? 50; const pb = prob(b) ?? 50;
    $('[data-testid=h2h]').innerHTML = `${ocAvatar(a, 'lg')}<b>${esc(a.yes_sub_title)}</b><div class="bar" aria-label="${esc(a.yes_sub_title)} ${pa}% vs ${esc(b.yes_sub_title)} ${pb}%"><span class="v-flex v-bg"${vars({ '--flex': pa, '--bg': seriesColor(a, 0) })}></span><span class="v-flex v-bg"${vars({ '--flex': pb, '--bg': seriesColor(b, 1) })}></span></div><b>${esc(b.yes_sub_title)}</b>${ocAvatar(b, 'lg')}<span class="date">${new Date(closeIso()).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>`;
  }
  function drawLegend() {
    $('#legend').innerHTML = ranked().slice(0, 3).map((m, i) => `<span><i class="v-bg"${vars({ '--bg': seriesColor(m, i) })}></i>${esc(m.yes_sub_title)} <b>${prob(m) ?? '—'}%</b></span>`).join('');
  }
  // In combo mode the Yes/No buttons add or remove combo legs instead of selecting the ticket.
  const legOf = (m) => state.slip && state.slip.legs.find((l) => l.market_ticker === m.ticker);
  const pickOn = (m, side) => (state.comboMode ? legOf(m)?.side === side : m.ticker === state.selected && state.side === side);
  function drawRows() {
    el.querySelector('.mkt-table').classList.toggle('combo-picking', state.comboMode);
    $('#mkt-rows').innerHTML = ranked().map((m) => {
      const p = prob(m);
      const tradable = m.status === 'active';
      const d = p != null && m.previous_day_price_dollars != null ? p - cents(m.previous_day_price_dollars) : 0;
      const yesAsk = cents(m.yes_ask_dollars); const noAsk = cents(m.no_ask_dollars);
      const statusNote = tradable ? '' : `<div class="faint">${m.status === 'finalized' || m.status === 'determined' ? 'Resolved ' + esc(m.result.toUpperCase()) : esc(m.status)}</div>`;
      return `<tr data-ticker="${esc(m.ticker)}" class="${m.ticker === state.selected ? 'selected' : ''}">
        <td><div class="d-flex gap-16 ai-center">${ocAvatar(m)}<div><div class="fs-18">${esc(m.yes_sub_title)}</div>${statusNote}<div class="faint">${qty(m.volume_fp)} traded · ${showShares() ? `Yes ${cents(m.yes_ask_dollars) ?? '—'}¢ · No ${cents(m.no_ask_dollars) ?? '—'}¢` : multiplier(m)}</div></div></div></td>
        <td class="ta-c nowrap"><span class="prob" data-testid="prob-${esc(m.ticker)}">${p == null ? '—' : p + '%'}</span>${d ? ` <span class="${d > 0 ? 'delta-up' : 'delta-down'}">${d > 0 ? '▲' : '▼'} ${Math.abs(d)}</span>` : ''}</td>
        <td class="ta-r"><button class="yes-btn ${pickOn(m, 'yes') ? 'on' : ''}" data-pick="yes" ${tradable ? '' : 'disabled'}>Yes ${yesAsk ? yesAsk + '¢' : '—'}</button></td>
        <td><button class="no-btn ${pickOn(m, 'no') ? 'on' : ''}" data-pick="no" ${tradable ? '' : 'disabled'}>No ${noAsk ? noAsk + '¢' : '—'}</button></td></tr>`;
    }).join('');
    for (const tr of el.querySelectorAll('#mkt-rows tr')) {
      tr.onclick = (e) => {
        const pick = e.target.closest('[data-pick]');
        if (state.comboMode && pick) { toggleLeg(tr.dataset.ticker, pick.dataset.pick); return; }
        const changed = state.selected !== tr.dataset.ticker;
        state.selected = tr.dataset.ticker;
        if (pick) { state.side = pick.dataset.pick; state.action = 'buy'; }
        drawRows(); drawTicket(pick ? defaultPrice() : null);
        if (changed) { subscribeBook(); drawHeadline(); drawBottom(); drawPosition(); drawAlerts(); }
      };
    }
    drawLegend(); drawH2H();
  }

  function drawHeadline() {
    const m = market();
    const p = prob(m);
    $('#chart-label').textContent = m.yes_sub_title;
    $('#chart-prob').textContent = p == null ? '' : `${p}% chance`;
    const chip = (label, prev) => {
      if (p == null || prev == null) return '';
      const d = p - cents(prev);
      return `<span>${esc(label)} <span class="${d >= 0 ? 'delta-up' : 'delta-down'}">${d >= 0 ? '▲' : '▼'}${Math.abs(d)}</span></span>`;
    };
    $('#changes').innerHTML = chip('1H', m.previous_hour_price_dollars) + chip('1D', m.previous_day_price_dollars) + chip('1W', m.previous_week_price_dollars);
    $('#ev-vol').textContent = `${money0(state.ev.markets.reduce((a, x) => a + Number(x.dollar_volume || 0), 0))} vol`;
  }

  async function drawChart() {
    const [span, period] = RANGES[state.range];
    const now = Math.floor(Date.now() / 1000);
    const ms = ranked().slice(0, 3);
    try {
      const series2 = await Promise.all(ms.map(async (m, i) => {
        const c = await api.candles(ev.series_ticker, m.ticker, { start_ts: now - span, end_ts: now, period_interval: period });
        return { name: m.yes_sub_title, color: seriesColor(m, i), points: c.candlesticks.map((k) => ({ t: k.end_period_ts, v: cents(k.price.close_dollars) })) };
      }));
      $('#chart').innerHTML = multiChart(series2, { height: 300, endLabels: ms.length > 1 });
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

  // ---------- ticket: idle → editing → submitting → confirmed | error ----------
  const defaultPrice = () => {
    const m = market();
    return state.side === 'yes' ? cents(m.yes_ask_dollars) || prob(m) || 50 : cents(m.no_ask_dollars) || (100 - (prob(m) || 50));
  };
  // When selling, the price shown is what the held side sells for (its bid).
  const sellPrice = () => {
    const m = market();
    return state.side === 'yes' ? cents(m.yes_bid_dollars) || 1 : cents(m.no_bid_dollars) || 1;
  };
  let ticketPrice = null;
  async function refreshHeld() {
    if (!session.user) { state.held = { yes: 0, no: 0 }; return; }
    try {
      const { positions } = await api.positions(session.uid);
      const p = positions.find((x) => x.ticker === state.selected);
      state.held = { yes: p && p.side === 'yes' ? Number(p.position_fp) : 0, no: p && p.side === 'no' ? Number(p.position_fp) : 0 };
    } catch { /* ignore */ }
  }
  function drawTicket(price) {
    const m = market();
    if (price != null) ticketPrice = price;
    if (ticketPrice == null) ticketPrice = defaultPrice();
    const t = $('#ticket');
    if (m.status !== 'active') {
      t.innerHTML = `<div class="tkt-body"><div class="tkt-out">${ocAvatar(m, 'sm')}<h3>${esc(m.yes_sub_title)}</h3></div><p class="muted" data-testid="ticket-closed">Trading is ${m.status === 'initialized' ? 'not open yet. Opens ' + shortDate(m.open_time) : 'closed for this market'}.${m.result ? ` Result: <strong>${esc(m.result.toUpperCase())}</strong>` : ''}</p></div>`;
      return;
    }
    const selling = state.action === 'sell';
    const MODE_LIST = modes();
    let mode = selling && (state.mode === 'dollars' || state.mode === 'rfq') ? 'market' : state.mode;
    if (!MODE_LIST.some(([k]) => k === mode)) mode = 'dollars';
    const frac = !!m.fractional_trading_enabled; // fractional contracts (spec §16.5)
    const step = frac ? '0.01' : '1';
    const yesAsk = cents(m.yes_ask_dollars); const noAsk = cents(m.no_ask_dollars);
    const held = state.held[state.side];
    t.innerHTML = `<div class="tkt-head"><button data-action="buy" class="${!selling ? 'on' : ''}">BUY</button><button data-action="sell" class="${selling ? 'on' : ''}" data-testid="sell-tab">SELL</button>
        <div class="mode"><button id="t-mode-btn" data-menu-btn class="on" aria-haspopup="true">${esc(MODE_LIST.find(([k]) => k === mode)[1].toUpperCase())} ▾</button>
        <div class="menu mode-menu" id="t-mode-menu" hidden>${MODE_LIST.map(([k, l]) => `<button data-otype="${esc(k)}" ${selling && (k === 'dollars' || k === 'rfq') ? 'disabled' : ''}>${esc(l)}</button>`).join('')}</div></div></div>
      <div class="tkt-body">
        <div class="tkt-q">${esc(state.ev.title)}</div>
        <div class="tkt-out">${ocAvatar(m, 'sm')}<h3>${esc(m.yes_sub_title)}</h3></div>
        <div class="d-flex ai-center jc-between gap-10 fw-wrap">
          <div class="yn-toggle side-toggle"><button data-side="yes" class="${state.side === 'yes' ? 'on-yes' : ''}">YES ${(selling ? cents(m.yes_bid_dollars) : yesAsk) || '—'}¢</button><button data-side="no" class="${state.side === 'no' ? 'on-no' : ''}">NO ${(selling ? cents(m.no_bid_dollars) : noAsk) || '—'}¢</button></div>
          <button class="interest-link" id="interest-btn" type="button">3.5% Interest</button>
        </div>
        ${selling ? `<div class="tkt-row" data-testid="held"><span>You hold</span><strong>${qty(held)} ${state.side.toUpperCase()}</strong></div>` : ''}
        ${mode === 'dollars' ? '<label class="tkt-input">Dollars<input id="t-amount" type="number" min="1" step="1" placeholder="$0" inputmode="decimal" aria-label="Dollars"></label>' : ''}
        ${mode === 'limit' ? `<label class="tkt-input">Limit price (¢)<input id="t-price" type="number" min="1" max="99" step="1" value="${esc(selling ? sellPrice() : ticketPrice)}" inputmode="numeric"></label>` : ''}
        ${mode === 'limit' ? `<label class="tkt-input tkt-select">Expires<select id="t-expiry" data-testid="t-expiry" aria-label="Order expiry"><option value="never">Never (GTC)</option><option value="eod">End of day</option><option value="custom">Custom</option></select></label>
          <input id="t-expiry-at" class="tkt-expiry-at" type="datetime-local" hidden aria-label="Expiry time">` : ''}
        ${mode !== 'dollars' ? `<label class="tkt-input">Contracts<input id="t-count" type="number" min="${step}" step="${step}" value="${esc(selling ? held || 1 : 10)}" inputmode="${frac ? 'decimal' : 'numeric'}" data-testid="t-count"></label>` : ''}
        <div id="t-summary"></div>
        <div class="form-error" id="t-error" role="alert"></div>
        <button class="cta" id="t-submit" data-testid="submit-order">${!session.user ? 'Sign up to trade' : mode === 'rfq' ? 'Request quote' : `${selling ? 'Sell' : 'Buy'} ${state.side === 'yes' ? 'Yes' : 'No'}`}</button>
      </div>`;
    for (const b of t.querySelectorAll('[data-side]')) b.onclick = () => { state.side = b.dataset.side; drawRows(); drawTicket(defaultPrice()); };
    for (const b of t.querySelectorAll('[data-action]')) b.onclick = async () => { state.action = b.dataset.action; if (state.action === 'sell') await refreshHeld(); drawTicket(); };
    const menu = t.querySelector('#t-mode-menu');
    t.querySelector('#t-mode-btn').onclick = () => { menu.hidden = !menu.hidden; };
    for (const b of t.querySelectorAll('[data-otype]')) {
      b.onclick = () => { state.mode = b.dataset.otype; menu.hidden = true; if (session.user) session.setProp('ticket_mode', state.mode).catch(() => {}); drawTicket(); };
    }
    t.querySelector('#interest-btn').onclick = async () => {
      if (!session.user) { toast('Cash and open positions earn 3.5% APY, credited daily.'); return; }
      try { const r = await api.interest(session.uid); toast(`3.5% APY on cash and positions, credited daily. Earned so far: ${money(r.total_dollars)}`); } catch (e) { toast(e.message, 'error'); }
    };
    const recalc = () => {
      const sum = t.querySelector('#t-summary');
      const closeLabel = `<span>Max payout<div class="faint">${shortDate(m.close_time)}</div></span>`;
      if (mode === 'dollars') {
        const amt = Number(t.querySelector('#t-amount').value || 0);
        const p = state.side === 'yes' ? yesAsk : noAsk;
        const per = p ? p + Math.ceil((FEE_RATE * p * (100 - p)) / 100) : 0;
        const c = p ? (frac ? Math.floor((amt * 10000) / per) / 100 : Math.floor((amt * 100) / per)) : 0; // floor to 0.01 where fractional
        sum.innerHTML = `<div class="tkt-row"><span>Odds</span><strong>${p ? (state.side === 'yes' ? p : 100 - p) : '—'}% chance</strong></div>
          <div class="tkt-row">${closeLabel}<span class="payout" data-testid="t-payout">${money(c)}</span></div><div class="faint" data-testid="t-contracts">${qty(c)} contracts at ${p || '—'}¢</div>`;
        t.querySelector('#t-submit').disabled = !!session.user && !(c > 0);
        return;
      }
      const c = Number(t.querySelector('#t-count').value);
      const sizeOk = validQty(c, frac || (selling && c === held));
      if (mode === 'rfq') {
        sum.innerHTML = sizeOk ? `<div class="faint" data-testid="rfq-hint">Makers reply with Yes and No prices for ${qty(c)} contracts. Accept one side in <a href="/portfolio?tab=rfqs" data-link>Portfolio → RFQs</a>.</div>`
          : `<span class="faint">Enter ${frac ? 'at least 0.01 contracts (2 decimals)' : 'a whole number of contracts'}.</span>`;
        t.querySelector('#t-submit').disabled = !!session.user && !sizeOk;
        return;
      }
      const p = mode === 'market' ? (selling ? sellPrice() : defaultPrice()) : Number(t.querySelector('#t-price').value);
      if (mode === 'limit' && !selling) ticketPrice = p;
      const exp = t.querySelector('#t-expiry');
      if (exp) {
        t.querySelector('#t-expiry-at').hidden = exp.value !== 'custom';
        if (exp.value === 'custom' && !(Date.parse(t.querySelector('#t-expiry-at').value) > Date.now())) { sum.innerHTML = '<span class="faint" data-testid="t-invalid">Pick an expiry time in the future.</span>'; t.querySelector('#t-submit').disabled = !!session.user; return; }
      }
      const ok = Number.isInteger(p) && p >= 1 && p <= 99 && sizeOk && (!selling || c <= held);
      if (!ok) { sum.innerHTML = `<span class="faint" data-testid="t-invalid">${selling && c > held ? `You hold ${qty(held)} contracts.` : `Enter a price between 1¢ and 99¢ and ${frac ? 'at least 0.01 contracts (up to 2 decimals)' : 'a whole number of contracts'}.`}</span>`; t.querySelector('#t-submit').disabled = !!session.user; return; }
      sum.innerHTML = selling
        ? `<div class="tkt-row"><span>${mode === 'market' ? 'Est. proceeds' : 'Proceeds at limit'}</span><strong class="num" data-testid="t-cost">${money((p * c) / 100)}</strong></div>`
        : `<div class="tkt-row"><span>${mode === 'market' ? 'Est. cost' : 'Max cost'}</span><strong class="num" data-testid="t-cost">${money((p * c) / 100)}</strong></div>
           <div class="tkt-row"><span>Est. fee (if taken)</span><strong class="num">${money(feeCents(c, p) / 100)}</strong></div>
           <div class="tkt-row">${closeLabel}<span class="payout" data-testid="t-payout">${money(c)}</span></div>`;
      t.querySelector('#t-submit').disabled = false;
    };
    t.querySelectorAll('input').forEach((i) => { i.oninput = recalc; });
    t.querySelector('#t-expiry')?.addEventListener('change', recalc);
    recalc();
    t.querySelector('#t-submit').onclick = async () => {
      if (!session.user) return navigate('/sign-up?next=' + encodeURIComponent(location.pathname));
      const btn = t.querySelector('#t-submit');
      const errEl = t.querySelector('#t-error');
      errEl.textContent = '';
      const label = btn.textContent;
      btn.disabled = true; btn.textContent = 'Submitting…';
      try {
        if (mode === 'rfq') {
          const r = await api.createRfq({ market_ticker: m.ticker, contracts_fp: Number(t.querySelector('#t-count').value).toFixed(2) });
          toast(`RFQ sent for ${qty(r.rfq.contracts_fp)} contracts`);
          return;
        }
        const body = { ticker: m.ticker, side: state.side, action: state.action, type: mode };
        if (mode === 'dollars') body.amount_dollars = Number(t.querySelector('#t-amount').value || 0);
        else body.count = Number(t.querySelector('#t-count').value);
        if (mode === 'limit') body.price = Number(t.querySelector('#t-price').value);
        // Good-til-time limit orders (spec §17.10): end of the local day or a custom time; Never = GTC.
        const exp = t.querySelector('#t-expiry')?.value;
        if (mode === 'limit' && exp === 'eod') { const d = new Date(); d.setHours(23, 59, 59, 999); body.expiration_time = d.toISOString(); }
        if (mode === 'limit' && exp === 'custom') body.expiration_time = new Date(Date.parse(t.querySelector('#t-expiry-at').value)).toISOString();
        const r = await api.submitOrder(session.uid, body);
        const o = r.order;
        if (selling) toast(`Sold ${qty(o.fill_count_fp)} ${state.side.toUpperCase()}${o.status === 'resting' ? `, ${qty(o.remaining_count_fp)} listed` : ''}`);
        else toast(o.status === 'executed' ? `Filled ${qty(o.fill_count_fp)} ${o.side.toUpperCase()}` : o.status === 'resting' ? `Order resting · ${qty(o.fill_count_fp)} filled, ${qty(o.remaining_count_fp)} open` : `Order ${o.status} · ${qty(o.fill_count_fp)} filled`);
        queries.invalidate(['home']);
        drawPosition();
        if (selling) { await refreshHeld(); drawTicket(); return; }
      } catch (e) {
        errEl.textContent = e.unauthorized ? 'Your session expired. Please log in again.' : e.message;
      } finally { if (btn.isConnected) { btn.disabled = false; btn.textContent = label; } }
    };
  }

  // ---------- order book ----------
  let unsubBook = null;
  function subscribeBook() {
    if (unsubBook) unsubBook();
    state.book = { yes: new Map(), no: new Map() };
    const ticker = state.selected;
    api.orderbook(ticker).then((ob) => {
      if (state.selected !== ticker) return;
      state.book = { yes: new Map(ob.orderbook_fp.yes_dollars.map(([p, c]) => [cents(p), Number(c)])), no: new Map(ob.orderbook_fp.no_dollars.map(([p, c]) => [cents(p), Number(c)])) };
      if (state.bottomTab === 'book') drawBottom();
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

  // Only the newest render may write the panel: a slow earlier fetch (e.g. the initial load racing a tab click)
  // must not replace newer content or wipe a post the user has started typing.
  let drawSeq = 0;
  async function drawBottom() {
    const seq = ++drawSeq;
    const box = $('#bottom');
    const m = market();
    const tab = state.bottomTab;
    const stale = () => seq !== drawSeq || state.bottomTab !== tab;
    box.dataset.tab = tab;
    if (tab === 'rules') {
      box.innerHTML = `<div class="card rules p-20" data-testid="rules"><p>${esc(m.rules_primary)}</p><p>${esc(series.rules)}</p>
        <p class="faint">Settlement source: ${series.settlement_sources.map((s) => esc(s.name)).join(', ')} · Closes ${shortDate(m.close_time)} · Market ${esc(m.ticker)}</p></div>`;
    } else if (tab === 'book') {
      // "Hide fractional shares" (order-book setting, DB-persisted): sizes round down to whole contracts for display.
      const shown = (entries) => (state.hideFrac ? entries.map(([p, c]) => [p, Math.floor(c + 1e-9)]).filter(([, c]) => c > 0) : entries);
      const asks = shown([...state.book.no.entries()].map(([p, c]) => [100 - p, c])).sort((a, b) => a[0] - b[0]).slice(0, 8).reverse();
      const bids = shown([...state.book.yes.entries()]).sort((a, b) => b[0] - a[0]).slice(0, 8);
      const max = Math.max(1, ...asks.map((a) => a[1]), ...bids.map((b) => b[1]));
      const row = (p, c, color) => `<div class="book-row"><span class="bar v-w v-bg"${vars({ '--w': `${(c / max) * 100}%`, '--bg': color })}></span><span>${esc(p)}¢</span><span class="ta-r">${qty(c)}</span></div>`;
      box.innerHTML = `<div class="card p-20" data-testid="orderbook"><div class="book-head"><span class="faint">${esc(m.yes_sub_title)}</span><label class="book-setting"><input type="checkbox" id="hide-frac" data-testid="hide-fractional" ${state.hideFrac ? 'checked' : ''}> Hide fractional shares</label></div><div class="book">
        <div><h4 class="c-no">Offers to sell YES</h4>${asks.map(([p, c]) => row(p, c, 'var(--no)')).join('') || '<p class="faint">None</p>'}</div>
        <div><h4 class="c-yes">Bids to buy YES</h4>${bids.map(([p, c]) => row(p, c, 'var(--yes)')).join('') || '<p class="faint">None</p>'}</div></div></div>`;
      box.querySelector('#hide-frac').onchange = (e) => {
        state.hideFrac = e.target.checked;
        if (session.user) session.setProp('orderbook_hide_fractional_shares', state.hideFrac).catch(() => {});
        drawBottom();
      };
    } else if (tab === 'trades') {
      try {
        const r = await api.socialTrades({ event_ticker: ev.event_ticker });
        if (stale()) return;
        box.innerHTML = `<div class="card p-4-18"><table class="table" data-testid="trades"><thead><tr><th>Trader</th><th>Outcome</th><th>Bought</th><th class="num">Price</th><th class="num">Contracts</th><th class="num">When</th></tr></thead><tbody>
          ${r.trades.slice(0, 25).map((t) => { const px = t.taker_side === 'yes' ? cents(t.price_dollars) : 100 - cents(t.price_dollars); return `<tr><td>${t.taker_nickname ? `<a href="/social/profile/${encodeURIComponent(t.taker_nickname)}" data-link><strong>@${esc(t.taker_nickname)}</strong></a>` : '<span class="faint">Anonymous</span>'}</td><td>${esc(t.outcome)}</td><td><strong class="c-${esc(t.taker_side)}">${esc(t.taker_side.toUpperCase())}</strong></td><td class="num">${px}¢</td><td class="num">${qty(t.count_fp)}</td><td class="num faint">${relTime(t.create_date)}</td></tr>`; }).join('') || '<tr><td colspan="6" class="faint">No trades yet</td></tr>'}</tbody></table></div>`;
      } catch (e) { box.innerHTML = `<p class="faint">${esc(e.tooManyRequests ? 'Too many requests, try again shortly.' : e.message)}</p>`; }
    } else if (tab === 'ideas') {
      const r = await api.posts({ event_ticker: ev.event_ticker });
      if (stale()) return;
      const draft = box.querySelector('#composer textarea')?.value || '';
      box.innerHTML = `${composer(ev.event_ticker)}<div class="card mt-10" id="ev-posts" data-testid="event-posts">${r.posts.map((p) => postCard(p, { showEvent: false })).join('') || '<div class="empty" data-testid="no-ideas">No posts yet. Be the first to share your view.</div>'}</div>`;
      wirePosts(box.querySelector('#ev-posts'), { navigate });
      wireComposer(box, (post) => { const list = box.querySelector('#ev-posts'); list.querySelector('[data-testid=no-ideas]')?.remove(); list.insertAdjacentHTML('afterbegin', postCard(post, { showEvent: false })); });
      const ta = box.querySelector('#composer textarea');
      if (ta && draft) { ta.value = draft; ta.dispatchEvent(new Event('input')); }
    } else {
      const r = await api.topHolders(m.ticker);
      if (stale()) return;
      const col = (title, rows, side) => `<div><h4 class="c-${esc(side)}">${esc(title)}</h4>${rows.map((h, i) => `<a class="rank-row rank-3" href="/social/profile/${encodeURIComponent(h.nickname)}" data-link><span class="faint">${i + 1}</span><span class="t">@${esc(h.nickname)}</span><span class="num">${qty(h.position_fp)}</span></a>`).join('') || '<p class="faint">No public holders yet.</p>'}</div>`;
      box.innerHTML = `<div class="card p-20" data-testid="holders"><div class="faint mb-8">${esc(m.yes_sub_title)}</div><div class="book">${col('Yes holders', r.yes, 'yes')}${col('No holders', r.no, 'no')}</div></div>`;
    }
  }
  function selectTab(tab) {
    if (tab === state.bottomTab && $('#bottom').dataset.tab === tab) return; // already showing (or loading) this tab
    state.bottomTab = tab;
    for (const x of el.querySelectorAll('[data-tab]')) x.classList.toggle('on', x.dataset.tab === tab);
    if (session.user) session.setProp('event_bottom_tab', tab).catch(() => {});
    drawBottom();
  }
  for (const b of el.querySelectorAll('[data-tab]')) b.onclick = () => selectTab(b.dataset.tab);

  // ---------- related ----------
  async function drawRelated() {
    try {
      const r = await api.related(ev.event_ticker);
      if (r.series_events.length) {
        $('#series-events').innerHTML = `<div class="sec-head"><h2>More in ${esc(series.title)}</h2></div>${r.series_events.map((x) => {
          const top = [...x.markets].sort((a, b) => (prob(b) ?? 0) - (prob(a) ?? 0))[0];
          return `<a class="list-row jc-between bb-line" href="${eventHref(x)}" data-link><span>${esc(x.title)}</span><span class="muted">${esc(top.yes_sub_title)} ${prob(top) ?? '—'}%</span></a>`;
        }).join('')}`;
      }
      const also = r.people_also_trading;
      const drawAlso = (n) => {
        $('#also').innerHTML = also.slice(0, n).map((x) => `<a class="list-row" href="${eventHref(x)}" data-link data-testid="also-row">${evIcon(x, 'sm')}<span>${esc(x.title)}</span></a>`).join('') + (also.length > n ? '<button class="btn btn-pill h-44 c-brand" id="also-more">Show more</button>' : '');
        const more = $('#also-more');
        if (more) more.onclick = () => drawAlso(also.length);
      };
      drawAlso(3);
    } catch { /* optional */ }
  }

  // ---------- side cards ----------
  async function drawPosition() {
    const box = $('#position');
    if (!session.user) { box.innerHTML = ''; return; }
    try {
      const [{ positions }, { orders }] = await Promise.all([api.positions(session.uid), api.orders(session.uid, 'resting')]);
      const mine = positions.filter((p) => p.event_ticker === ev.event_ticker && p.side);
      const resting = orders.filter((o) => state.ev.markets.some((m) => m.ticker === o.ticker));
      box.innerHTML = (mine.length || resting.length) ? `<section class="card side-card" data-testid="my-position"><h3>Your position</h3>
        ${mine.map((p) => `<div class="outcome-row"><span class="outcome-name">${esc(p.outcome)} · <strong>${esc(p.side.toUpperCase())}</strong></span><span class="num">${qty(p.position_fp)} @ ${cents(p.avg_price_dollars)}¢</span></div>`).join('')}
        ${resting.length ? `<div class="faint mt-6">${resting.length} resting order(s) — manage in <a href="/portfolio" data-link>Portfolio</a></div>` : ''}</section>` : '';
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
    box.innerHTML = `<section class="card side-card" data-testid="alert-card"><h3 class="d-flex ai-center gap-6">${ICON.bell.replace('<svg', '<svg width="16" height="16"')} Price alert</h3>
      <form class="inline-form" id="alert-form"><label class="field flex-90">When Yes is<select name="direction"><option value="above">above</option><option value="below">below</option></select></label>
      <label class="field flex-70">Price (¢)<input name="price" type="number" min="1" max="99" value="${Math.min(99, p + 5)}" required></label><button class="btn" type="submit">Add</button></form>
      <div class="form-error" id="alert-error" role="alert"></div>
      ${list.map((t) => `<div class="outcome-row" data-alert="${esc(t.id)}"><span class="outcome-name">${esc(t.direction)} ${cents(t.price_dollars)}¢ <span class="faint">${t.triggered_time ? '· triggered' : '· active'}</span></span><button class="btn btn-sm btn-ghost" data-del-alert>Remove</button></div>`).join('')}</section>`;
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
      <div class="d-flex gap-6 fw-wrap mt-8">
        <button class="btn" data-admin="deactivate">Pause</button><button class="btn" data-admin="activate">Resume</button>
        <button class="btn" data-admin="close">Close</button>
        <button class="btn" data-admin="determine" data-result="yes">Resolve YES</button><button class="btn" data-admin="determine" data-result="no">Resolve NO</button></div></section>`;
    for (const b of el.querySelectorAll('[data-admin]')) {
      b.onclick = async () => {
        try { await api.admin(m.ticker, b.dataset.admin, b.dataset.result ? { result: b.dataset.result } : {}); toast(`Market ${b.dataset.admin} ok`); await refreshEvent(); } catch (e) { toast(e.message, 'error'); }
      };
    }
  }

  // ---------- combos (spec §17.3): combo mode on outcome rows, legs of a combo market ----------
  async function loadSlip() {
    if (!session.user) { state.slip = { legs: [] }; return; }
    try { state.slip = (await api.comboSlip(session.uid)).slip; } catch { state.slip = { legs: [] }; }
  }
  const legRow = (l, right) => `<span class="combo-leg-name"><span><b class="${l.side === 'yes' ? 'leg-yes' : 'leg-no'}">${esc(l.side.toUpperCase())}</b> ${esc(l.outcome)}</span><span class="faint">${esc(l.event_title)}</span></span>${right /* eslint-disable-line parlance/no-unescaped-html -- `right` is markup built by the two callers below from esc()'d values */}`;
  function drawComboMini() {
    const box = $('#combo-mini');
    if (!box) return;
    const btn = $('#combo-toggle');
    btn.setAttribute('aria-pressed', String(state.comboMode));
    btn.classList.toggle('on', state.comboMode);
    if (!state.comboMode) { box.innerHTML = ''; return; }
    const legs = state.slip ? state.slip.legs : [];
    box.innerHTML = `<section class="card combo-mini" data-testid="combo-mini"><div class="combo-mini-head"><strong>Combo slip</strong><span class="faint" data-testid="combo-leg-count">${legs.length}/6 legs</span></div>
      ${legs.map((l) => `<div class="combo-leg-row" data-leg="${esc(l.market_ticker)}">${legRow(l, `<span class="num">${esc(l.prob)}%</span>`)}</div>`).join('') || '<p class="faint">Tap Yes or No on an outcome to add it as a leg.</p>'}
      ${legs.length ? `<div class="tkt-row"><span>Combined odds</span><strong data-testid="combo-odds">${esc(state.slip.combined_prob)}%</strong></div>` : ''}
      <a class="cta combo-open" href="/combos" data-link data-testid="combo-open">${legs.length >= 2 ? 'Get a quote' : 'Open combo builder'}</a></section>`;
  }
  async function toggleLeg(ticker, side) {
    if (!session.user) return navigate('/sign-in?next=' + encodeURIComponent(location.pathname));
    const m = state.ev.markets.find((x) => x.ticker === ticker);
    const legs = (state.slip?.legs || []).map((l) => ({ market_ticker: l.market_ticker, side: l.side, event_ticker: l.event_ticker }));
    const i = legs.findIndex((l) => l.market_ticker === ticker);
    let next;
    if (i >= 0 && legs[i].side === side) next = legs.filter((_, j) => j !== i);
    else {
      next = legs.filter((l) => l.event_ticker !== m.event_ticker); // one leg per event
      if (next.length >= 6) { toast('A combo can have at most 6 legs', 'error'); return; }
      next.push({ market_ticker: ticker, side, event_ticker: m.event_ticker });
    }
    try { state.slip = (await api.saveComboSlip(session.uid, { legs: next.map((l) => ({ market_ticker: l.market_ticker, side: l.side })), amount_dollars: state.slip?.amount_dollars ?? null })).slip; } catch (e) { toast(e.message, 'error'); }
    drawRows(); drawComboMini();
  }
  if (comboEligible) {
    $('#combo-toggle').onclick = async () => {
      state.comboMode = !state.comboMode;
      if (state.comboMode && !state.slip) await loadSlip();
      drawRows(); drawComboMini();
    };
  }
  async function drawComboLegs() {
    const box = $('#combo-legs');
    if (!box) return;
    try {
      const { combo } = await api.combo(state.ev.markets[0].ticker);
      const label = { pending: 'Pending', won: 'Won', lost: 'Lost' };
      box.innerHTML = `<div class="combo-mini-head"><h3>Combo legs</h3><span class="faint">${combo.legs.length} legs · combined odds ${esc(combo.combined_prob)}%</span></div>
        ${combo.legs.map((l) => `<a class="combo-leg-row" href="${esc(l.link)}" data-link data-testid="combo-leg" data-leg-status="${esc(l.leg_status)}">${legRow(l, `<span class="leg-status ${esc(l.leg_status)}">${label[l.leg_status]}</span>`)}</a>`).join('')}`;
    } catch (e) { box.innerHTML = `<p class="faint">${esc(e.message)}</p>`; }
  }

  async function refreshEvent() {
    const r = await api.event(eventTicker);
    state.ev = r.event;
    drawRows(); drawTicket(); drawAdmin(); drawPosition(); drawHeadline(); drawComboLegs();
  }

  // ---------- live updates ----------
  const tickers = ev.markets.map((m) => m.ticker);
  const unsubs = [];
  unsubs.push(mountEventScoreboard($('#sports-board'), ev));
  if (!isCombo) unsubs.push(mountChat({ el, ev }));
  if (!isCombo) { unsubs.push(mountEventExtras({ el, ev, market })); el.querySelector('.ev-header')?.insertAdjacentHTML('afterend', '<div class="targeted-promos" data-testid="event-promos"></div>'); renderPromos(el.querySelector('[data-testid=event-promos]'), { series_ticker: ev.series_ticker }); }
  let pending = null;
  let tradeT = null;
  unsubs.push(socket.subscribe({ channels: ['ticker'] }, (msg) => {
    const m = state.ev.markets.find((x) => x.ticker === msg.msg.market_ticker);
    if (!m) return;
    Object.assign(m, { yes_bid_dollars: msg.msg.yes_bid_dollars, yes_ask_dollars: msg.msg.yes_ask_dollars, no_bid_dollars: msg.msg.yes_ask_dollars == null ? null : (1 - Number(msg.msg.yes_ask_dollars)).toFixed(4), no_ask_dollars: msg.msg.yes_bid_dollars == null ? null : (1 - Number(msg.msg.yes_bid_dollars)).toFixed(4), last_price_dollars: msg.msg.last_price_dollars, volume_fp: msg.msg.volume_fp });
    clearTimeout(pending);
    pending = setTimeout(() => { drawRows(); drawHeadline(); }, 100);
  }));
  const legTickers = isCombo ? (ev.markets[0].mve_selected_legs || []).map((l) => l.market_ticker) : [];
  unsubs.push(socket.subscribe({ channels: ['market_lifecycle_v2'], market_tickers: [...tickers, ...legTickers] }, () => refreshEvent().catch(() => {})));
  unsubs.push(socket.subscribe({ channels: ['trade'], market_tickers: tickers }, () => { if (state.bottomTab === 'trades') { clearTimeout(tradeT); tradeT = setTimeout(() => drawBottom(), 150); } }));
  const onNotif = (e) => { if (e.detail.type === 'price_target') drawAlerts(); };
  window.addEventListener('parlance:notification', onNotif);
  unsubs.push(() => window.removeEventListener('parlance:notification', onNotif));
  if (session.user) unsubs.push(socket.subscribe({ channels: ['fill'] }, (msg) => { if (tickers.includes(msg.msg.ticker)) drawPosition(); }));

  await refreshHeld();
  drawWatch(); drawRows(); drawHeadline(); drawTicket(query && query.get('side') ? defaultPrice() : null); drawChart(); subscribeBook(); drawBottom(); drawPosition(); drawAlerts(); drawAdmin(); drawRelated(); drawComboLegs();
  // Keep canonical URL (slug is decorative, spec §3).
  const canonical = eventHref({ ...ev, series_slug: series.slug });
  if (location.pathname !== canonical) history.replaceState({}, '', canonical);
  return () => { if (unsubBook) unsubBook(); for (const u of unsubs) u(); clearTimeout(pending); clearTimeout(tradeT); };
}
