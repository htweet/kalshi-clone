// Event detail (spec §4.3, §13.5, §15.4): header with actions (calendar file, social, share, CSV), head-to-head bar,
// multi-line chart with ranges, outcome table, series events, Social / Activity / Order book / Rules / Top holders,
// "People are also trading", news; ticket with BUY/SELL, Dollars / Contracts / Limit modes, interest, max payout.
import { t as tx, te, ts } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/event-strings.js';
import { t as T, tHtml } from '../content/currency-strings.js'; // keyed wording (CLONE_SPEC.md §30)
import { vars } from '../dynstyle.js';
import { api } from '../api.js';
import { session, queries } from '../store.js';
import { socket } from '../ws.js';
import { esc, cents, prob, multiplier, money, qty, validQty, shortDate, toast, eventHref, catSlug, catLabel, relTime, ICON, showShares, ccOf, pxc, px, ccDollars, onGrid, minTickCc, snapCc, feeDollars, priceUnit, pxCents, contractValue, amountLabel, toApiDollars, validMoneyInput, moneyStep, sym, fmtDay, fmtDateTime, isNgn } from '../lib.js';
import { postCard, ocAvatar, evIcon, multiChart, seriesColor, money0 } from './components.js';
import { wirePosts, composer, wireComposer } from './social.js';
import { newsItemsHtml } from './admin/site.js'; // CMS news items
import { mountGameBoard, mountLinesSection } from './sports.js'; // live scoreboard (§19.6); spread & total section (§29)
import { evLabelInner } from './scoreboard.js'; // live header label with the running game clock (§29, PLAN G9)
import { mountAiSummary } from './ai-summary.js'; // AI news summary + timeline (§29, PLAN P5.4)
import { mountChat } from './chat.js'; // "● Live chat" pill + panel (CLONE_SPEC §20)
import { mountEventExtras, renderPromos } from './social2.js'; // follow event, price-move alerts, targeted promos (CLONE_SPEC.md §24)

const RANGES = { '1d': [86400, 1], '1w': [7 * 86400, 60], '1m': [30 * 86400, 60], all: [365 * 86400, 1440] };
const FEE_RATE = 0.07; // display estimate; mirrors the server design choice
// Scalar markets (CLONE_SPEC.md §28.4): YES pays (value − floor) / (cap − floor) of $1, clamped to [0, 1].
const isScalar = (m) => m.market_type === 'scalar';
const unitOf = (m) => m.scalar_unit || '';
const fmtVal = (m, v) => `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 4 })}${unitOf(m)}`;
const scalarRange = (m) => `${fmtVal(m, m.floor_strike)} to ${fmtVal(m, m.cap_strike)}`;
const TABS = [['ideas', 'Social'], ['trades', ts('event.tabs.activity')], ['book', ts('event.tabs.order_book')], ['rules', ts('event.tabs.rules')], ['holders', ts('event.tabs.top_holders')]];
// The amount mode keeps its key (`dollars`, the API order type) and is labelled in the display currency: Naira / Dollars.
const MODES = [['dollars', 'Dollars'], ['market', ts('event.modes.contracts')], ['limit', ts('event.modes.limit_order')]];
const modeLabel = (k, l) => (k === 'dollars' ? amountLabel() : l);
const RFQ_MODE = ['rfq', ts('event.rfq_mode.request_quote')]; // shown when the rfq_enabled user property is on (spec §17.6)
const COMBO_SERIES = 'PLXCOMBO';
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
  document.title = tx('event.render.parlance_2', { title: ev.title });
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
          <h1 data-testid="event-title">${esc(ev.title)}</h1><div class="muted fs-lg">${esc(ev.sub_title)}</div>
          ${ev.live_data ? `<div class="ev-live-label mt-8" data-testid="ev-live-label" data-live-ms="${esc(ev.live_data.milestone_id)}" data-sb-part="evlabel" data-status="${esc(ev.live_data.status)}">${evLabelInner(ev.live_data)}</div>`
    : ev.sports_lines ? `<div class="ev-live-label mt-8" data-testid="ev-live-label" data-live-ms="${esc(ev.sports_lines.milestone_id)}" data-sb-part="evlabel"></div>`
      : ev.is_live ? `<div class="live-dot mt-8">${te('event.render.live', { live_label: esc(ev.live_label) })}</div>` : ''}
          ${ev.sports_lines && ev.sports_lines.game_event_ticker ? `<a class="faint d-block mt-8" data-testid="moneyline-link" href="/markets/${esc(ev.series_ticker.toLowerCase())}/${esc(series.slug)}/${esc(ev.sports_lines.game_event_ticker.toLowerCase())}" data-link>${te('event.render.moneyline', { title: esc(ev.sports_lines.title) })}</a>` : ''}</div>
        <div class="ev-actions">
          <button class="icon-btn" id="ics-btn" data-testid="ics-btn" title="${te('event.render.add_to_calendar')}" aria-label="${te('event.render.add_to_calendar')}">${SVG.cal}</button>
          <button class="icon-btn" id="chat-btn" title="${te('event.render.discussion')}" aria-label="${te('event.render.go_to_discussion')}">${SVG.chat}</button>
          <button class="icon-btn" id="share-btn" title="${te('event.render.copy_link')}" aria-label="${te('event.render.copy_link')}">${SVG.share}</button>
          <button class="icon-btn" id="csv-btn" data-testid="csv-btn" title="${te('event.render.download_price_history')}" aria-label="${te('event.render.download_price_history')}">${SVG.dl}</button>
          <button class="btn btn-pill" id="watch-btn" data-testid="watch-btn" aria-pressed="${state.watching}"></button>
        </div>
      </div>
      ${ev.live_data || ev.sports_lines ? '<div id="sports-board" class="sb-mount"></div>' : ''}
      ${ev.lines_event_ticker ? `<section class="card sb-lines" id="sb-lines" data-testid="lines-section" aria-label="${te('event.render.spread_and_total')}"></section>` : ''}
      ${h2h ? `<div class="h2h" data-testid="h2h"></div>` : ''}
      ${isCombo ? `<section class="card combo-legs" id="combo-legs" data-testid="combo-legs" aria-label="${te('event.render.combo_legs')}"></section>` : ''}
      <section class="chart-box">
        <div class="chart-head"><div class="legend" id="legend"></div><span class="watermark">${te('event.render.parlance')}</span></div>
        <div class="d-flex gap-16 ai-baseline mt-6"><span class="faint" id="chart-label"></span><span class="num" id="chart-prob" data-testid="chart-prob"></span><span class="change-chips" id="changes" data-testid="changes"></span></div>
        <div id="chart"></div>
        <div class="range-row"><span class="num" id="ev-vol"></span><div class="seg" role="tablist" aria-label="${te('event.render.chart_range')}">${Object.keys(RANGES).map((r) => `<button data-range="${esc(r)}" class="${r === state.range ? 'on' : ''}">${esc(r.toUpperCase())}</button>`).join('')}</div></div>
      </section>
      <div id="scalar-card"></div>
      <table class="mkt-table" aria-label="${te('event.render.outcomes')}"><thead><tr><th class="ta-l"></th><th>${te('event.render.chance')}</th><th></th><th></th></tr></thead><tbody id="mkt-rows"></tbody></table>
      <div id="series-events"></div>
      <div class="big-tabs" role="tablist">${TABS.map(([t, l]) => `<button data-tab="${esc(t)}" class="${t === state.bottomTab ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>
      <div id="bottom"></div>
      <div class="sec-head mt-48"><h2>${te('event.render.people_are_also_trading')}</h2></div><div id="also"></div>
      ${ev.news_items ? '<div id="ai-summary" class="ai-mount"></div>' : ''}
      ${ev.news || ev.news_items ? `<div class="sec-head"><h2>${te('event.render.news')}</h2></div>${newsItemsHtml(ev)}${ev.news ? `<div class="news-item" data-testid="news"><div class="src">${te('event.render.parlance_newsroom', { ev_icon: evIcon({ category: ev.category, title: 'P' }, 'sm'), fmt_day: fmtDay(Date.now() - 86400000) })}</div><b>${esc(ev.title)}</b><span class="muted">${esc(ev.news)}</span></div>` : ''}` : ''}
    </div>
    <aside>
      ${comboEligible ? `<button class="combo-btn ev-combo-btn" id="combo-toggle" data-testid="combo-toggle" aria-pressed="false">${te('event.render.combo')}</button><div id="combo-mini"></div>` : ''}
      <section class="card tkt ticket" id="ticket" aria-label="${te('event.render.trade_ticket')}"></section>
      <div id="position"></div>
      <div id="alerts"></div>
      <div id="admin"></div>
    </aside>
  </div>`;

  const $ = (s) => el.querySelector(s);

  // ---------- header actions ----------
  function drawWatch() {
    const b = $('#watch-btn');
    b.innerHTML = state.watching ? `${te('event.render.watching', { star: ICON.star })}` : te('event.render.watch');
    b.setAttribute('aria-pressed', String(state.watching));
  }
  $('#watch-btn').onclick = async () => {
    if (!session.user) return navigate('/sign-in?next=' + encodeURIComponent(location.pathname));
    try {
      if (state.watching) await api.unwatch(session.uid, ev.event_ticker); else await api.watch(session.uid, ev.event_ticker);
      state.watching = !state.watching;
      drawWatch();
      toast(state.watching ? tx('event.render.added_to_watchlist') : tx('event.render.removed_from_watchlist'));
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
    const ngn = isNgn(); // price column in the display currency (CLONE_SPEC.md §30): yes_price_ngn (naira) or yes_price_dollars
    const rows = [`time,market,outcome,${ngn ? 'yes_price_ngn' : 'yes_price_dollars'},volume_contracts`];
    for (const m of state.ev.markets) {
      const c = await api.candles(ev.series_ticker, m.ticker, { start_ts: now - span, end_ts: now, period_interval: period });
      for (const k of c.candlesticks) rows.push([new Date(k.end_period_ts * 1000).toISOString(), m.ticker, `"${m.yes_sub_title.replace(/"/g, '""')}"`, ngn && k.price.close_dollars != null ? (ccOf(k.price.close_dollars) / 100).toFixed(2) : k.price.close_dollars, k.volume_fp].join(','));
    }
    download(`${ev.event_ticker.toLowerCase()}-prices.csv`, 'text/csv', rows.join('\n') + '\n');
  };
  $('#share-btn').onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); toast(tx('event.render.link_copied')); } catch { toast(location.href); }
  };
  $('#chat-btn').onclick = () => { selectTab('ideas'); $('.big-tabs').scrollIntoView({ behavior: 'smooth' }); };

  // ---------- head-to-head, legend, rows ----------
  function drawH2H() {
    if (!h2h) return;
    const [a, b] = state.ev.markets;
    const pa = prob(a) ?? 50; const pb = prob(b) ?? 50;
    $('[data-testid=h2h]').innerHTML = `${ocAvatar(a, 'lg')}<b>${esc(a.yes_sub_title)}</b><div class="bar" aria-label="${te('event.render.vs', { yes_sub_title: esc(a.yes_sub_title), pa, yes_sub_title_2: esc(b.yes_sub_title), pb })}"><span class="v-flex v-bg"${vars({ '--flex': pa, '--bg': seriesColor(a, 0) })}></span><span class="v-flex v-bg"${vars({ '--flex': pb, '--bg': seriesColor(b, 1) })}></span></div><b>${esc(b.yes_sub_title)}</b>${ocAvatar(b, 'lg')}<span class="date">${new Date(closeIso()).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>`;
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
      const statusNote = tradable ? (isScalar(m) ? `<div class="faint" data-testid="scalar-range">${te('event.render.scalar_pays_by_value', { scalar_range: esc(scalarRange(m)) })}</div>` : '')
        : `<div class="faint">${m.status === 'finalized' || m.status === 'determined' ? (isScalar(m) ? te('event.render.settled_at_yes', { fmt_val: esc(fmtVal(m, m.expiration_value)), px: esc(px(m.settlement_value_dollars)) }) : (te('event.render.resolved') + ' ') + esc(m.result.toUpperCase())) : esc(m.status)}</div>`;
      return `<tr data-ticker="${esc(m.ticker)}" class="${m.ticker === state.selected ? 'selected' : ''}">
        <td><div class="d-flex gap-16 ai-center">${ocAvatar(m)}<div><div class="fs-xl">${esc(m.yes_sub_title)}</div>${statusNote}<div class="faint">${te('event.render.traded', { qty: qty(m.volume_fp), value: showShares() ? te('event.render.yes_no', { px: esc(px(m.yes_ask_dollars)), px_2: esc(px(m.no_ask_dollars)) }) : multiplier(m) })}</div></div></div></td>
        <td class="ta-c nowrap"><span class="prob" data-testid="prob-${esc(m.ticker)}">${p == null ? '—' : p + '%'}</span>${d ? ` <span class="${d > 0 ? 'delta-up' : 'delta-down'}">${d > 0 ? '▲' : '▼'} ${Math.abs(d)}</span>` : ''}</td>
        <td class="ta-r"><button class="yes-btn ${pickOn(m, 'yes') ? 'on' : ''}" data-pick="yes" ${tradable ? '' : 'disabled'}>${te('event.render.yes', { px: esc(px(m.yes_ask_dollars)) })}</button></td>
        <td><button class="no-btn ${pickOn(m, 'no') ? 'on' : ''}" data-pick="no" ${tradable ? '' : 'disabled'}>${te('event.render.no', { px: esc(px(m.no_ask_dollars)) })}</button></td></tr>`;
    }).join('');
    for (const tr of el.querySelectorAll('#mkt-rows tr')) {
      tr.onclick = (e) => {
        const pick = e.target.closest('[data-pick]');
        if (state.comboMode && pick) { toggleLeg(tr.dataset.ticker, pick.dataset.pick); return; }
        const changed = state.selected !== tr.dataset.ticker;
        state.selected = tr.dataset.ticker;
        if (pick) { state.side = pick.dataset.pick; state.action = 'buy'; }
        drawRows(); drawTicket(pick ? defaultPrice() : null);
        if (changed) { subscribeBook(); drawHeadline(); drawScalar(); drawBottom(); drawPosition(); drawAlerts(); }
      };
    }
    drawLegend(); drawH2H();
  }

  // Scalar payout explanation (CLONE_SPEC.md §28.4): range, formula, a worked example and, once settled, the payout.
  function drawScalar() {
    const box = $('#scalar-card');
    const m = market();
    if (!isScalar(m)) { box.innerHTML = ''; return; }
    const span = m.cap_strike - m.floor_strike;
    const mid = m.floor_strike + span / 2;
    const settled = ['determined', 'finalized'].includes(m.status) && m.settlement_value_dollars != null;
    box.innerHTML = `<section class="card scalar-card" data-testid="scalar-card"><h3>${te('event.render.how_this_market_pays')}</h3>
      <p class="muted">${te('event.render.value_no_pays_the_rest', { t_html: tHtml('ticket.scalar_card', { value: esc(contractValue()), floor: `<b>${esc(fmtVal(m, m.floor_strike))}</b>`, zero: esc(money(0)), cap: `<b>${esc(fmtVal(m, m.cap_strike))}</b>` }), fmt_val: esc(fmtVal(m, m.floor_strike)), fmt_val_2: esc(fmtVal(m, span)) })}</p>
      <div class="tkt-row"><span>${te('event.render.example_value', { fmt_val: esc(fmtVal(m, mid)) })}</span><strong class="num">${te('event.render.yes_no_2', { money: esc(money(0.5)), money_2: esc(money(0.5)) })}</strong></div>
      ${settled ? `<div class="tkt-row" data-testid="scalar-result"><span>${te('event.render.settled_at', { fmt_val: esc(fmtVal(m, m.expiration_value)) })}</span><strong class="num">${te('event.render.yes_no_2', { money: esc(money(m.settlement_value_dollars)), money_2: esc(money(1 - Number(m.settlement_value_dollars))) })}</strong></div>` : ''}</section>`;
  }

  function drawHeadline() {
    const m = market();
    const p = prob(m);
    $('#chart-label').textContent = m.yes_sub_title;
    $('#chart-prob').textContent = p == null ? '' : tx('event.render.chance_3', { p });
    const chip = (label, prev) => {
      if (p == null || prev == null) return '';
      const d = p - cents(prev);
      return `<span>${esc(label)} <span class="${d >= 0 ? 'delta-up' : 'delta-down'}">${d >= 0 ? '▲' : '▼'}${Math.abs(d)}</span></span>`;
    };
    $('#changes').innerHTML = chip('1H', m.previous_hour_price_dollars) + chip('1D', m.previous_day_price_dollars) + chip('1W', m.previous_week_price_dollars);
    $('#ev-vol').textContent = tx('event.render.vol', { money0: money0(state.ev.markets.reduce((a, x) => a + Number(x.dollar_volume || 0), 0)) });
  }

  async function drawChart() {
    const [span, period] = RANGES[state.range];
    const now = Math.floor(Date.now() / 1000);
    const ms = ranked().slice(0, 3);
    try {
      const series2 = await Promise.all(ms.map(async (m, i) => {
        const c = await api.candles(ev.series_ticker, m.ticker, { start_ts: now - span, end_ts: now, period_interval: period });
        return { name: m.yes_sub_title, color: seriesColor(m, i), points: c.candlesticks.map((k) => ({ t: k.end_period_ts, v: ccOf(k.price.close_dollars) / 100 })) }; // sub-cent prices keep their decimals
      }));
      $('#chart').innerHTML = multiChart(series2, { height: 300, endLabels: ms.length > 1 });
    } catch (e) { $('#chart').innerHTML = `<p class="faint">${te('event.render.chart_unavailable', { message: esc(e.message) })}</p>`; }
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
  // Prices in the ticket are centi-cents on the market's grid (CLONE_SPEC.md §28.1); the inputs show cents with decimals.
  const defaultPrice = () => {
    const m = market();
    const last = ccOf(m.last_price_dollars);
    return snapCc(m, state.side === 'yes' ? ccOf(m.yes_ask_dollars) || last || 5000 : ccOf(m.no_ask_dollars) || (last ? 10000 - last : 5000));
  };
  // When selling, the price shown is what the held side sells for (its bid).
  const sellPrice = () => {
    const m = market();
    return (state.side === 'yes' ? ccOf(m.yes_bid_dollars) : ccOf(m.no_bid_dollars)) || minTickCc(m);
  };
  const tp = () => session.props || {}; // trade mechanics (Settings, CLONE_SPEC.md §28.5)
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
      const res = !m.result ? '' : isScalar(m) ? ` ${te('event.render.settled_at_2')} <strong data-testid="scalar-settled">${esc(fmtVal(m, m.expiration_value))}</strong>${te('event.render.yes_pays_no_pays', { px: esc(px(m.settlement_value_dollars)), pxc: esc(pxc(10000 - ccOf(m.settlement_value_dollars))) })}` : ` ${te('event.render.result')} <strong>${esc(m.result.toUpperCase())}</strong>`;
      t.innerHTML = `<div class="tkt-body"><div class="tkt-out">${ocAvatar(m, 'sm')}<h3>${esc(m.yes_sub_title)}</h3></div><p class="muted" data-testid="ticket-closed">${te('event.render.trading_is', { value: m.status === 'initialized' ? (te('event.render.not_open_yet_opens') + ' ') + shortDate(m.open_time) : te('event.render.closed_for_this_market'), res })}</p></div>`;
      return;
    }
    const selling = state.action === 'sell';
    const MODE_LIST = modes();
    let mode = selling && (state.mode === 'dollars' || state.mode === 'rfq') ? 'market' : state.mode;
    if (!MODE_LIST.some(([k]) => k === mode)) mode = 'dollars';
    const frac = !!m.fractional_trading_enabled; // fractional contracts (spec §16.5)
    const step = frac ? '0.01' : '1';
    const yesAsk = ccOf(m.yes_ask_dollars); const noAsk = ccOf(m.no_ask_dollars);
    const tick = minTickCc(m); // price input step in cents: 1, 0.1 or 0.01
    const held = state.held[state.side];
    t.innerHTML = `<div class="tkt-head"><button data-action="buy" class="${!selling ? 'on' : ''}">${te('event.render.buy_2')}</button><button data-action="sell" class="${selling ? 'on' : ''}" data-testid="sell-tab">${te('event.render.sell_2')}</button>
        <div class="mode"><button id="t-mode-btn" data-menu-btn class="on" aria-haspopup="true">${esc(modeLabel(mode, MODE_LIST.find(([k]) => k === mode)[1]).toUpperCase())} ▾</button>
        <div class="menu mode-menu" id="t-mode-menu" hidden>${MODE_LIST.map(([k, l]) => `<button data-otype="${esc(k)}" ${selling && (k === 'dollars' || k === 'rfq') ? 'disabled' : ''}>${esc(modeLabel(k, l))}</button>`).join('')}</div></div></div>
      <div class="tkt-body">
        <div class="tkt-q">${esc(state.ev.title)}</div>
        <div class="tkt-out">${ocAvatar(m, 'sm')}<h3>${esc(m.yes_sub_title)}</h3></div>
        <div class="d-flex ai-center jc-between gap-12 fw-wrap">
          <div class="yn-toggle side-toggle"><button data-side="yes" class="${state.side === 'yes' ? 'on-yes' : ''}">${te('event.render.yes_3', { pxc: esc(pxc(selling ? ccOf(m.yes_bid_dollars) : yesAsk)) })}</button><button data-side="no" class="${state.side === 'no' ? 'on-no' : ''}">${te('event.render.no_3', { pxc: esc(pxc(selling ? ccOf(m.no_bid_dollars) : noAsk)) })}</button></div>
          <button class="interest-link" id="interest-btn" type="button">${te('event.render.n3_5_interest')}</button>
        </div>
        ${selling ? `<div class="tkt-row" data-testid="held"><span>${te('event.render.you_hold')}</span><strong>${qty(held)} ${state.side.toUpperCase()}</strong></div>` : ''}
        ${mode === 'dollars' ? `<label class="tkt-input">${esc(amountLabel())}<input id="t-amount" type="number" min="1" step="${esc(moneyStep())}" placeholder="${esc(sym())}0" inputmode="decimal" aria-label="${esc(amountLabel())}" data-testid="t-amount"></label>` : ''}
        ${mode === 'limit' ? `<label class="tkt-input">${esc(T('input.limit_price', { unit: priceUnit() }))}<input id="t-price" type="number" min="${esc(tick / 100)}" max="${esc(100 - tick / 100)}" step="${esc(tick / 100)}" value="${esc((selling ? sellPrice() : ticketPrice) / 100)}" inputmode="decimal" data-testid="t-price"></label>
          ${tick < 100 ? `<div class="faint tkt-grid" data-testid="t-grid">${te('event.render.ticks', { value: esc(m.price_ranges.map((r) => `${pxc(ccOf(r.step))} from ${pxc(ccOf(r.start))}`).join(' · ')) })}</div>` : ''}` : ''}
        ${mode === 'limit' ? `<label class="tkt-input tkt-select">${te('event.render.expires')}<select id="t-expiry" data-testid="t-expiry" aria-label="${te('event.render.order_expiry')}"><option value="never">${te('event.render.never_gtc')}</option><option value="eod">${te('event.render.end_of_day')}</option><option value="custom">${te('event.render.custom')}</option></select></label>
          <input id="t-expiry-at" class="tkt-expiry-at" type="datetime-local" hidden aria-label="${te('event.render.expiry_time')}">` : ''}
        ${mode !== 'dollars' ? `<label class="tkt-input">${te('event.render.contracts')}<input id="t-count" type="number" min="${step}" step="${step}" value="${esc(selling ? held || 1 : 10)}" inputmode="${frac ? 'decimal' : 'numeric'}" data-testid="t-count"></label>` : ''}
        ${isScalar(m) ? `<div class="tkt-scalar faint" data-testid="t-scalar-note">${te('event.render.scalar_yes_pays_value', { fmt_val: esc(fmtVal(m, m.floor_strike)), fmt_val_2: esc(fmtVal(m, m.cap_strike - m.floor_strike)), t: esc(T('ticket.scalar_note_tail', { value: contractValue() })) })}</div>` : ''}
        <div id="t-summary"></div>
        <div class="form-error" id="t-error" role="alert"></div>
        <div id="t-review"></div>
        <button class="cta" id="t-submit" data-testid="submit-order">${!session.user ? te('event.render.sign_up_to_trade') : mode === 'rfq' ? te('event.render.request_quote') : `${!tp().trade_skip_review ? (te('event.render.review') + ' ') : ''}${selling ? te('event.render.sell') : te('event.render.buy')} ${state.side === 'yes' ? te('event.render.yes_2') : te('event.render.no_2')}`}</button>
        <div id="t-after"></div>
      </div>`;
    for (const b of t.querySelectorAll('[data-side]')) b.onclick = () => { state.side = b.dataset.side; drawRows(); drawTicket(defaultPrice()); };
    for (const b of t.querySelectorAll('[data-action]')) b.onclick = async () => { state.action = b.dataset.action; if (state.action === 'sell') await refreshHeld(); drawTicket(); };
    const menu = t.querySelector('#t-mode-menu');
    t.querySelector('#t-mode-btn').onclick = () => { menu.hidden = !menu.hidden; };
    for (const b of t.querySelectorAll('[data-otype]')) {
      b.onclick = () => { state.mode = b.dataset.otype; menu.hidden = true; if (session.user) session.setProp('ticket_mode', state.mode).catch(() => {}); drawTicket(); };
    }
    t.querySelector('#interest-btn').onclick = async () => {
      if (!session.user) { toast(tx('event.render.cash_and_open_positions_earn')); return; }
      try { const r = await api.interest(session.uid); toast(tx('event.render.n3_5_apy_on_cash', { money: money(r.total_dollars) })); } catch (e) { toast(e.message, 'error'); }
    };
    const recalc = () => {
      const sum = t.querySelector('#t-summary');
      const closeLabel = `<span>${te('event.render.max_payout')}<div class="faint">${shortDate(m.close_time)}</div></span>`;
      if (mode === 'dollars') {
        const raw = t.querySelector('#t-amount').value;
        const amt = raw === '' ? 0 : validMoneyInput(raw) ? toApiDollars(raw) : NaN; // naira ÷ 100 = the API's dollars (whole naira)
        const p = state.side === 'yes' ? yesAsk : noAsk; // cc
        const pc = p ? p / 100 : 0; // cents, may have decimals
        const per = p ? pc + Math.ceil((FEE_RATE * pc * (100 - pc)) / 100) : 0;
        const c = p && amt > 0 ? (frac ? Math.floor((amt * 10000) / per) / 100 : Math.floor((amt * 100) / per)) : 0; // floor to 0.01 where fractional
        if (Number.isNaN(amt)) { sum.innerHTML = `<span class="faint" data-testid="t-invalid">${esc(T(isNgn() ? 'error.amount_whole' : 'error.amount_cents'))}</span>`; t.querySelector('#t-submit').disabled = !!session.user; return; }
        sum.innerHTML = `<div class="tkt-row"><span>${te('event.render.odds')}</span><strong>${te('event.render.chance_2', { value: p ? Math.round(state.side === 'yes' ? pc : 100 - pc) : '—' })}</strong></div>
          <div class="tkt-row">${closeLabel}<span class="payout" data-testid="t-payout">${money(c)}</span></div><div class="faint" data-testid="t-contracts">${te('event.render.contracts_at', { qty: qty(c), pxc: esc(pxc(p)) })}</div>`;
        t.querySelector('#t-submit').disabled = !!session.user && !(c > 0);
        return;
      }
      const c = Number(t.querySelector('#t-count').value);
      const flipOn = !!tp().trade_flip_sell;
      const flip = selling && flipOn && c > held ? Math.round((c - held) * 100) / 100 : 0; // A8: the part that buys the other side
      const sizeOk = validQty(c, frac || (selling && c === held)) && (!flip || frac || Number.isInteger(flip));
      if (mode === 'rfq') {
        sum.innerHTML = sizeOk ? `<div class="faint" data-testid="rfq-hint">${te('event.render.makers_reply_with_yes_and', { qty: qty(c) })} <a href="/portfolio?tab=rfqs" data-link>${te('event.render.portfolio_rfqs')}</a>.</div>`
          : `<span class="faint">${te('event.render.enter', { value: frac ? te('event.render.at_least_0_01_contracts') : te('event.render.a_whole_number_of_contracts') })}</span>`;
        t.querySelector('#t-submit').disabled = !!session.user && !sizeOk;
        return;
      }
      const p = mode === 'market' ? (selling ? sellPrice() : defaultPrice()) : Math.round(Number(t.querySelector('#t-price').value) * 100); // cc
      if (mode === 'limit' && !selling) ticketPrice = p;
      const exp = t.querySelector('#t-expiry');
      if (exp) {
        t.querySelector('#t-expiry-at').hidden = exp.value !== 'custom';
        if (exp.value === 'custom' && !(Date.parse(t.querySelector('#t-expiry-at').value) > Date.now())) { sum.innerHTML = `<span class="faint" data-testid="t-invalid">${te('event.render.pick_an_expiry_time_in')}</span>`; t.querySelector('#t-submit').disabled = !!session.user; return; }
      }
      const ok = onGrid(m, p) && sizeOk && (!selling || c <= held || flip > 0);
      if (!ok) {
        const why = selling && c > held && !flipOn ? tx('event.render.you_hold_contracts_turn_on', { qty: qty(held) })
          : !onGrid(m, p) ? tx('event.render.enter_a_price_on_this', { pxc: pxc(minTickCc(m)), pxc_2: pxc(minTickCc(m)), pxc_3: pxc(10000 - minTickCc(m)) })
            : `Enter ${frac ? 'at least 0.01 contracts (up to 2 decimals)' : 'a whole number of contracts'}.`;
        sum.innerHTML = `<span class="faint" data-testid="t-invalid">${esc(why)}</span>`; t.querySelector('#t-submit').disabled = !!session.user; return;
      }
      const other = state.side === 'yes' ? 'NO' : 'YES';
      const flipLine = flip ? tx('event.render.sells_you_hold_and_buys', { qty: qty(held), to_upper_case: state.side.toUpperCase(), qty_2: qty(flip), other, pxc: pxc(10000 - p) }) : '';
      sum.innerHTML = selling
        ? `<div class="tkt-row"><span>${mode === 'market' ? te('event.render.est_proceeds') : te('event.render.proceeds_at_limit')}</span><strong class="num" data-testid="t-cost">${money((p * Math.min(c, held)) / 10000)}</strong></div>
           ${flip ? `<div class="tkt-flip" data-testid="flip-line">${te('event.render.flip_sell', { flip_line: esc(flipLine) })}</div>` : ''}`
        : `<div class="tkt-row"><span>${mode === 'market' ? te('event.render.est_cost') : te('event.render.max_cost')}</span><strong class="num" data-testid="t-cost">${money((p * c) / 10000)}</strong></div>
           <div class="tkt-row"><span>${te('event.render.est_fee_if_taken')}</span><strong class="num" data-testid="t-fee">${money(feeDollars(c, p))}</strong></div>
           <div class="tkt-row">${closeLabel}<span class="payout" data-testid="t-payout">${money(c)}</span></div>`;
      state.review = { c, p, flip, flipLine, fee: selling ? null : feeDollars(c, p) };
      t.querySelector('#t-submit').disabled = false;
    };
    t.querySelectorAll('input').forEach((i) => { i.oninput = recalc; });
    t.querySelector('#t-expiry')?.addEventListener('change', recalc);
    recalc();
    // Build the order body from the inputs (prices as 4-decimal dollar strings on the market grid).
    const buildBody = () => {
      const body = { ticker: m.ticker, side: state.side, action: state.action, type: mode };
      if (mode === 'dollars') body.amount_dollars = toApiDollars(t.querySelector('#t-amount').value || 0);
      else body.count = Number(t.querySelector('#t-count').value);
      if (mode === 'limit') body.price_dollars = ccDollars(Math.round(Number(t.querySelector('#t-price').value) * 100));
      // Good-til-time limit orders (spec §17.10): end of the local day or a custom time; Never = GTC.
      const exp = t.querySelector('#t-expiry')?.value;
      if (mode === 'limit' && exp === 'eod') { const d = new Date(); d.setHours(23, 59, 59, 999); body.expiration_time = d.toISOString(); }
      if (mode === 'limit' && exp === 'custom') body.expiration_time = new Date(Date.parse(t.querySelector('#t-expiry-at').value)).toISOString();
      return body;
    };
    // A7 order review (Settings › Trade mechanics › Skip order review, off by default): what will be placed, its cost and
    // fee, and any warning (a flip sell always asks, even with review skipped).
    // While reviewing (or answering the auto-sell prompt) the ticket shows only that panel, so a sticky ticket never
    // grows past the viewport.
    const focusPanel = (id) => { t.classList.toggle('tkt-focus', !!id); for (const x of t.querySelectorAll('.tkt-keep')) x.classList.remove('tkt-keep'); if (id) t.querySelector(id).classList.add('tkt-keep'); };
    const showReview = (body) => {
      const r = state.review || {};
      const box = t.querySelector('#t-review');
      const c = mode === 'dollars' ? null : body.count;
      const priceLine = mode === 'dollars' ? tx('event.render.spend_up_to_at', { money: money(body.amount_dollars), pxc: pxc(selling ? sellPrice() : defaultPrice()) }) : mode === 'market' ? tx('event.render.market_order_best_available_now', { pxc: pxc(r.p) }) : tx('event.render.limit_line', { px: px(body.price_dollars), expiry: body.expiration_time ? tx('event.render.limit_expires', { time: fmtDateTime(body.expiration_time) }) : tx('event.render.limit_gtc') });
      box.innerHTML = `<section class="tkt-review" data-testid="order-review" aria-label="${te('event.render.review_order')}"><h4>${te('event.render.review_order')}</h4>
        <div class="tkt-row"><span>${te('event.render.order')}</span><strong>${esc(selling ? tx('event.render.sell') : tx('event.render.buy'))} ${c != null ? `${esc(qty(c))} ` : ''}${esc(state.side.toUpperCase())} · ${esc(m.yes_sub_title)}</strong></div>
        <div class="tkt-row"><span>${te('event.render.price')}</span><strong data-testid="review-price">${esc(priceLine)}</strong></div>
        ${c != null && !selling ? `<div class="tkt-row"><span>${mode === 'market' ? te('event.render.est_cost') : te('event.render.max_cost')}</span><strong class="num" data-testid="review-cost">${money((r.p * c) / 10000)}</strong></div><div class="tkt-row"><span>${te('event.render.est_fee_if_taken')}</span><strong class="num" data-testid="review-fee">${money(r.fee || 0)}</strong></div>` : ''}
        ${c != null && !selling ? `<div class="tkt-row"><span>${isScalar(m) ? te('event.render.payout_range') : te('event.render.payout_if_right')}</span><strong class="num">${isScalar(m) ? esc(T('ticket.payout_range', { zero: money(0), max: money(c) })) : money(c)}</strong></div>` : ''}
        ${r.flip ? `<p class="tkt-flip" data-testid="review-flip">${te('event.render.flip_sell_2', { flip_line: esc(r.flipLine) })}</p>` : ''}
        <div class="tkt-review-actions"><button class="btn" type="button" data-testid="review-edit">${te('event.render.edit')}</button><button class="btn btn-primary" type="button" data-testid="review-confirm">${te('event.render.place_order')}</button></div></section>`;
      focusPanel('#t-review');
      box.querySelector('[data-testid=review-edit]').onclick = () => { box.innerHTML = ''; focusPanel(null); };
      box.querySelector('[data-testid=review-confirm]').onclick = async (e) => { e.target.disabled = true; focusPanel(null); box.innerHTML = ''; await place(body); };
    };
    // A7 auto-sell prompt (Settings › Auto-sell prompt after buy): after a buy fills, offer a resting take-profit sell.
    const showAutoSell = (o, avgDollars) => {
      const box = t.querySelector('#t-after');
      if (!box) return;
      const filled = Number(o.fill_count_fp);
      const avg = ccOf(avgDollars) || defaultPrice();
      const target = snapCc(m, Math.min(10000 - minTickCc(m), avg + Math.max(minTickCc(m), 1000)));
      box.innerHTML = `<section class="tkt-autosell" data-testid="auto-sell-prompt" aria-label="${te('event.render.auto_sell')}"><h4>${te('event.render.set_an_automatic_sell')}</h4>
        <p class="faint">${te('event.render.filled_at_on_average_a', { qty: esc(qty(filled)), to_upper_case: esc(o.side.toUpperCase()), pxc: esc(pxc(avg)) })}</p>
        <label class="tkt-input">${esc(T('input.sell_at', { unit: priceUnit() }))}<input type="number" data-testid="auto-sell-price" step="${esc(minTickCc(m) / 100)}" min="${esc(minTickCc(m) / 100)}" max="${esc(100 - minTickCc(m) / 100)}" value="${esc(target / 100)}" inputmode="decimal"></label>
        <div class="form-error" role="alert" data-testid="auto-sell-error"></div>
        <div class="tkt-review-actions"><button class="btn" type="button" data-testid="auto-sell-dismiss">${te('event.render.no_thanks')}</button><button class="btn btn-primary" type="button" data-testid="auto-sell-place">${te('event.render.place_sell_for', { qty: esc(qty(filled)) })}</button></div></section>`;
      focusPanel('#t-after');
      box.querySelector('[data-testid=auto-sell-dismiss]').onclick = () => { box.innerHTML = ''; focusPanel(null); };
      box.querySelector('[data-testid=auto-sell-place]').onclick = async () => {
        const cc = Math.round(Number(box.querySelector('[data-testid=auto-sell-price]').value) * 100);
        const err = box.querySelector('[data-testid=auto-sell-error]');
        if (!onGrid(m, cc)) { err.textContent = tx('event.render.pick_a_price_on_the', { pxc: pxc(minTickCc(m)) }); return; }
        try {
          const r = await api.submitOrder(session.uid, { ticker: m.ticker, side: o.side, action: 'sell', type: 'limit', count: filled, price_dollars: ccDollars(cc) });
          toast(tx('event.render.auto_sell_placed_at', { qty: qty(r.order.remaining_count_fp), to_upper_case: o.side.toUpperCase(), pxc: pxc(cc), value: Number(r.order.fill_count_fp) ? (' ' + tx('event.render.sold_now', { qty: qty(r.order.fill_count_fp) })) : '' }));
          box.innerHTML = ''; focusPanel(null);
          drawPosition();
        } catch (ex) { err.textContent = ex.message; }
      };
    };
    const place = async (body) => {
      const btn = t.querySelector('#t-submit');
      const errEl = t.querySelector('#t-error');
      errEl.textContent = '';
      const label = btn.textContent;
      btn.disabled = true; btn.textContent = tx('event.render.submitting');
      try {
        const r = await api.submitOrder(session.uid, body);
        const o = r.order;
        if (selling) toast(r.flip ? tx('event.render.flip_sell_closed_opening', { qty: qty(r.flip.closed_fp), qty_2: qty(r.flip.opened_fp), to_upper_case: r.flip.opened_side.toUpperCase(), value: o.status === 'resting' ? tx('event.render.resting', { qty: qty(o.remaining_count_fp) }) : 'filled' }) : tx('event.render.sold', { qty: qty(o.fill_count_fp), to_upper_case: state.side.toUpperCase(), value: o.status === 'resting' ? tx('event.render.listed', { qty: qty(o.remaining_count_fp) }) : '' }));
        else toast(o.status === 'executed' ? tx('event.render.filled', { qty: qty(o.fill_count_fp), to_upper_case: o.side.toUpperCase() }) : o.status === 'resting' ? tx('event.render.order_resting_filled_open', { qty: qty(o.fill_count_fp), qty_2: qty(o.remaining_count_fp) }) : tx('event.render.order_filled', { status: o.status, qty: qty(o.fill_count_fp) }));
        queries.invalidate(['home']);
        drawPosition();
        if (selling) { await refreshHeld(); drawTicket(); return; }
        if (tp().trade_auto_sell_prompt && Number(o.fill_count_fp) > 0) showAutoSell(o, r.fill_avg_price_dollars);
      } catch (e) {
        errEl.textContent = e.unauthorized ? tx('event.render.your_session_expired_please_log') : e.message;
      } finally { if (btn.isConnected) { btn.disabled = false; btn.textContent = label; } }
    };
    t.querySelector('#t-submit').onclick = async () => {
      if (!session.user) return navigate('/sign-up?next=' + encodeURIComponent(location.pathname));
      if (mode === 'rfq') {
        const errEl = t.querySelector('#t-error');
        try {
          const r = await api.createRfq({ market_ticker: m.ticker, contracts_fp: Number(t.querySelector('#t-count').value).toFixed(2) });
          toast(tx('event.render.rfq_sent_for_contracts', { qty: qty(r.rfq.contracts_fp) }));
        } catch (e) { errEl.textContent = e.message; }
        return;
      }
      const body = buildBody();
      if (!tp().trade_skip_review || (state.review && state.review.flip && mode !== 'dollars')) { showReview(body); return; }
      await place(body);
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
      state.book = { yes: new Map(ob.orderbook_fp.yes_dollars.map(([p, c]) => [ccOf(p), Number(c)])), no: new Map(ob.orderbook_fp.no_dollars.map(([p, c]) => [ccOf(p), Number(c)])) }; // keys in cc
      if (state.bottomTab === 'book') drawBottom();
    }).catch(() => {});
    unsubBook = socket.subscribe({ channels: ['orderbook'], market_tickers: [ticker] }, (msg) => {
      if (msg.msg.market_ticker !== state.selected) return;
      if (msg.type === 'orderbook_snapshot') {
        state.book = { yes: new Map(msg.msg.yes_dollars.map(([p, c]) => [ccOf(p), Number(c)])), no: new Map(msg.msg.no_dollars.map(([p, c]) => [ccOf(p), Number(c)])) };
      } else if (msg.type === 'orderbook_delta') {
        const map = state.book[msg.msg.side];
        const p = ccOf(msg.msg.price_dollars);
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
        <p class="faint">${te('event.render.settlement_source_closes_market', { value: series.settlement_sources.map((s) => esc(s.name)).join(', '), short_date: shortDate(m.close_time), ticker: esc(m.ticker) })}</p></div>`;
    } else if (tab === 'book') {
      // "Hide fractional shares" (order-book setting, DB-persisted): sizes round down to whole contracts for display.
      const shown = (entries) => (state.hideFrac ? entries.map(([p, c]) => [p, Math.floor(c + 1e-9)]).filter(([, c]) => c > 0) : entries);
      const asks = shown([...state.book.no.entries()].map(([p, c]) => [10000 - p, c])).sort((a, b) => a[0] - b[0]).slice(0, 8).reverse();
      const bids = shown([...state.book.yes.entries()]).sort((a, b) => b[0] - a[0]).slice(0, 8);
      const max = Math.max(1, ...asks.map((a) => a[1]), ...bids.map((b) => b[1]));
      const row = (p, c, color) => `<div class="book-row"><span class="bar v-w v-bg"${vars({ '--w': `${(c / max) * 100}%`, '--bg': color })}></span><span data-testid="book-price">${esc(pxc(p))}</span><span class="ta-r">${qty(c)}</span></div>`;
      box.innerHTML = `<div class="card p-20" data-testid="orderbook"><div class="book-head"><span class="faint">${esc(m.yes_sub_title)}${m.price_level_structure && m.price_level_structure !== 'linear_cent' ? ` · <span data-testid="book-grid">${te('event.render.ticks_2', { replace: esc(m.price_level_structure.replace(/_/g, ' ')) })}</span>` : ''}</span><label class="book-setting"><input type="checkbox" id="hide-frac" data-testid="hide-fractional" ${state.hideFrac ? 'checked' : ''}> ${te('event.render.hide_fractional_shares')}</label></div><div class="book">
        <div><h4 class="c-no">${te('event.render.offers_to_sell_yes')}</h4>${asks.map(([p, c]) => row(p, c, 'var(--no)')).join('') || `<p class="faint">${te('event.render.none')}</p>`}</div>
        <div><h4 class="c-yes">${te('event.render.bids_to_buy_yes')}</h4>${bids.map(([p, c]) => row(p, c, 'var(--yes)')).join('') || `<p class="faint">${te('event.render.none')}</p>`}</div></div></div>`;
      box.querySelector('#hide-frac').onchange = (e) => {
        state.hideFrac = e.target.checked;
        if (session.user) session.setProp('orderbook_hide_fractional_shares', state.hideFrac).catch(() => {});
        drawBottom();
      };
    } else if (tab === 'trades') {
      try {
        const r = await api.socialTrades({ event_ticker: ev.event_ticker });
        if (stale()) return;
        box.innerHTML = `<div class="card p-4-20"><table class="table" data-testid="trades"><thead><tr><th>${te('event.render.trader')}</th><th>${te('event.render.outcome')}</th><th>${te('event.render.bought')}</th><th class="num">${te('event.render.price')}</th><th class="num">${te('event.render.contracts')}</th><th class="num">${te('event.render.when')}</th></tr></thead><tbody>
          ${r.trades.slice(0, 25).map((t) => { const tpx = pxc(t.taker_side === 'yes' ? ccOf(t.price_dollars) : 10000 - ccOf(t.price_dollars)); return `<tr><td>${t.taker_nickname ? `<a href="/social/profile/${encodeURIComponent(t.taker_nickname)}" data-link><strong>@${esc(t.taker_nickname)}</strong></a>` : `<span class="faint">${te('event.render.anonymous')}</span>`}</td><td>${esc(t.outcome)}</td><td><strong class="c-${esc(t.taker_side)}">${esc(t.taker_side.toUpperCase())}</strong></td><td class="num">${esc(tpx)}</td><td class="num">${qty(t.count_fp)}</td><td class="num faint">${relTime(t.create_date)}</td></tr>`; }).join('') || `<tr><td colspan="6" class="faint">${te('event.render.no_trades_yet')}</td></tr>`}</tbody></table></div>`;
      } catch (e) { box.innerHTML = `<p class="faint">${esc(e.tooManyRequests ? tx('event.render.too_many_requests_try_again') : e.message)}</p>`; }
    } else if (tab === 'ideas') {
      const r = await api.posts({ event_ticker: ev.event_ticker });
      if (stale()) return;
      const draft = box.querySelector('#composer textarea')?.value || '';
      box.innerHTML = `${composer(ev.event_ticker)}<div class="card mt-12" id="ev-posts" data-testid="event-posts">${r.posts.map((p) => postCard(p, { showEvent: false })).join('') || `<div class="empty" data-testid="no-ideas">${te('event.render.no_posts_yet_be_the')}</div>`}</div>`;
      wirePosts(box.querySelector('#ev-posts'), { navigate });
      wireComposer(box, (post) => { const list = box.querySelector('#ev-posts'); list.querySelector('[data-testid=no-ideas]')?.remove(); list.insertAdjacentHTML('afterbegin', postCard(post, { showEvent: false })); });
      const ta = box.querySelector('#composer textarea');
      if (ta && draft) { ta.value = draft; ta.dispatchEvent(new Event('input')); }
    } else {
      const r = await api.topHolders(m.ticker);
      if (stale()) return;
      const col = (title, rows, side) => `<div><h4 class="c-${esc(side)}">${esc(title)}</h4>${rows.map((h, i) => `<a class="rank-row rank-3" href="/social/profile/${encodeURIComponent(h.nickname)}" data-link><span class="faint">${i + 1}</span><span class="t">@${esc(h.nickname)}</span><span class="num">${qty(h.position_fp)}</span></a>`).join('') || `<p class="faint">${te('event.render.no_public_holders_yet')}</p>`}</div>`;
      box.innerHTML = `<div class="card p-20" data-testid="holders"><div class="faint mb-8">${esc(m.yes_sub_title)}</div><div class="book">${col(tx('event.render.yes_holders'), r.yes, 'yes')}${col(tx('event.render.no_holders'), r.no, 'no')}</div></div>`;
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
        $('#series-events').innerHTML = `<div class="sec-head"><h2>${te('event.render.more_in', { title: esc(series.title) })}</h2></div>${r.series_events.map((x) => {
          const top = [...x.markets].sort((a, b) => (prob(b) ?? 0) - (prob(a) ?? 0))[0];
          return `<a class="list-row jc-between bb-line" href="${eventHref(x)}" data-link><span>${esc(x.title)}</span><span class="muted">${esc(top.yes_sub_title)} ${prob(top) ?? '—'}%</span></a>`;
        }).join('')}`;
      }
      const also = r.people_also_trading;
      const drawAlso = (n) => {
        $('#also').innerHTML = also.slice(0, n).map((x) => `<a class="list-row" href="${eventHref(x)}" data-link data-testid="also-row">${evIcon(x, 'sm')}<span>${esc(x.title)}</span></a>`).join('') + (also.length > n ? `<button class="btn btn-pill h-48 c-brand" id="also-more">${te('event.render.show_more')}</button>` : '');
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
      box.innerHTML = (mine.length || resting.length) ? `<section class="card side-card" data-testid="my-position"><h3>${te('event.render.your_position')}</h3>
        ${mine.map((p) => `<div class="outcome-row"><span class="outcome-name">${esc(p.outcome)} · <strong>${esc(p.side.toUpperCase())}</strong></span><span class="num">${qty(p.position_fp)} @ ${esc(px(p.avg_price_dollars))}</span></div>`).join('')}
        ${resting.length ? `<div class="faint mt-6">${te('event.render.resting_order_s_manage_in', { value: resting.length })} <a href="/portfolio" data-link>${te('event.render.portfolio')}</a></div>` : ''}</section>` : '';
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
    box.innerHTML = `<section class="card side-card" data-testid="alert-card"><h3 class="d-flex ai-center gap-6">${te('event.render.price_alert', { replace: ICON.bell.replace('<svg', '<svg width="16" height="16"') })}</h3>
      <form class="inline-form" id="alert-form"><label class="field flex-90">${te('event.render.when_yes_is')}<select name="direction"><option value="above">${te('event.render.above')}</option><option value="below">${te('event.render.below')}</option></select></label>
      <label class="field flex-70">${esc(T('input.price', { unit: priceUnit() }))}<input name="price" type="number" min="1" max="99" value="${Math.min(99, p + 5)}" required></label><button class="btn" type="submit">${te('event.render.add')}</button></form>
      <div class="form-error" id="alert-error" role="alert"></div>
      ${list.map((t) => `<div class="outcome-row" data-alert="${esc(t.id)}"><span class="outcome-name">${esc(t.direction)} ${esc(pxCents(cents(t.price_dollars)))} <span class="faint">${t.triggered_time ? te('event.render.triggered') : te('event.render.active')}</span></span><button class="btn btn-sm btn-ghost" data-del-alert>${te('event.render.remove')}</button></div>`).join('')}</section>`;
    const f = box.querySelector('#alert-form');
    f.onsubmit = async (e) => {
      e.preventDefault();
      try { await api.addPriceTarget(session.uid, { market_ticker: m.ticker, direction: f.direction.value, price_cents: Number(f.price.value) }); toast(tx('event.render.price_alert_set')); drawAlerts(); } catch (ex) { box.querySelector('#alert-error').textContent = ex.message; }
    };
    for (const b of box.querySelectorAll('[data-del-alert]')) b.onclick = async () => { await api.deletePriceTarget(session.uid, b.closest('[data-alert]').dataset.alert); drawAlerts(); };
  }

  function drawAdmin() {
    if (!session.user || !session.user.is_admin) return;
    const m = market();
    $('#admin').innerHTML = `<section class="card admin-box" data-testid="admin-panel"><strong>${te('event.render.exchange_admin', { ticker: esc(m.ticker) })}</strong> <span class="faint">(${esc(m.status)})</span>
      <div class="d-flex gap-6 fw-wrap mt-8">
        <button class="btn" data-admin="deactivate">${te('event.render.pause')}</button><button class="btn" data-admin="activate">${te('event.render.resume')}</button>
        <button class="btn" data-admin="close">${te('event.render.close')}</button>
        ${isScalar(m) ? `<label class="field">${te('event.render.value', { value: esc(unitOf(m) || 'units') })}<input type="number" step="any" data-testid="admin-scalar-value" id="admin-scalar-value"></label><button class="btn" data-admin="determine" data-scalar="1">${te('event.render.resolve_at_value')}</button>`
    : `<button class="btn" data-admin="determine" data-result="yes">${te('event.render.resolve_yes')}</button><button class="btn" data-admin="determine" data-result="no">${te('event.render.resolve_no')}</button>`}</div></section>`;
    for (const b of el.querySelectorAll('[data-admin]')) {
      b.onclick = async () => {
        const body = b.dataset.result ? { result: b.dataset.result } : b.dataset.scalar ? { expiration_value: Number($('#admin-scalar-value').value) } : {};
        try { await api.admin(m.ticker, b.dataset.admin, body); toast(tx('event.render.market_ok', { admin: b.dataset.admin })); await refreshEvent(); } catch (e) { toast(e.message, 'error'); }
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
    box.innerHTML = `<section class="card combo-mini" data-testid="combo-mini"><div class="combo-mini-head"><strong>${te('event.render.combo_slip')}</strong><span class="faint" data-testid="combo-leg-count">${te('event.render.n6_legs', { value: legs.length })}</span></div>
      ${legs.map((l) => `<div class="combo-leg-row" data-leg="${esc(l.market_ticker)}">${legRow(l, `<span class="num">${esc(l.prob)}%</span>`)}</div>`).join('') || `<p class="faint">${te('event.render.tap_yes_or_no_on')}</p>`}
      ${legs.length ? `<div class="tkt-row"><span>${te('event.render.combined_odds')}</span><strong data-testid="combo-odds">${esc(state.slip.combined_prob)}%</strong></div>` : ''}
      <a class="cta combo-open" href="/combos" data-link data-testid="combo-open">${legs.length >= 2 ? te('event.render.get_a_quote') : te('event.render.open_combo_builder')}</a></section>`;
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
      if (next.length >= 6) { toast(tx('event.render.a_combo_can_have_at'), 'error'); return; }
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
      box.innerHTML = `<div class="combo-mini-head"><h3>${te('event.render.combo_legs')}</h3><span class="faint">${te('event.render.legs_combined_odds', { value: combo.legs.length, combined_prob: esc(combo.combined_prob) })}</span></div>
        ${combo.legs.map((l) => `<a class="combo-leg-row" href="${esc(l.link)}" data-link data-testid="combo-leg" data-leg-status="${esc(l.leg_status)}">${legRow(l, `<span class="leg-status ${esc(l.leg_status)}">${label[l.leg_status]}</span>`)}</a>`).join('')}`;
    } catch (e) { box.innerHTML = `<p class="faint">${esc(e.message)}</p>`; }
  }

  async function refreshEvent() {
    const r = await api.event(eventTicker);
    state.ev = r.event;
    drawRows(); drawTicket(); drawAdmin(); drawPosition(); drawHeadline(); drawScalar(); drawComboLegs();
  }

  // ---------- live updates ----------
  const tickers = ev.markets.map((m) => m.ticker);
  const unsubs = [];
  unsubs.push(mountGameBoard($('#sports-board'), ev));
  unsubs.push(mountLinesSection($('#sb-lines'), ev));
  unsubs.push(mountAiSummary($('#ai-summary'), ev));
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
  drawWatch(); drawRows(); drawHeadline(); drawScalar(); drawTicket(query && query.get('side') ? defaultPrice() : null); drawChart(); subscribeBook(); drawBottom(); drawPosition(); drawAlerts(); drawAdmin(); drawRelated(); drawComboLegs();
  // Keep canonical URL (slug is decorative, spec §3).
  const canonical = eventHref({ ...ev, series_slug: series.slug });
  if (location.pathname !== canonical) history.replaceState({}, '', canonical);
  return () => { if (unsubBook) unsubBook(); for (const u of unsubs) u(); clearTimeout(pending); clearTimeout(tradeT); };
}
