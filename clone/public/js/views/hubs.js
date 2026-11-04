// Hubs with data widgets (Phase 5B, PLAN A15 and P5.3; CLONE_SPEC.md §29.5, §29.8):
//   /hubs/elections  Senate map (invented states, driven by the Senate-race markets), expected-seat history, the
//                    governor race's forecast history and "What's on your ballot?"
//   /hubs/economics  Fed funds outlook from the central-bank decision markets, implied-change forecast history
//   /ballot          the ballot lookup on its own page
// Widgets re-read their endpoints when a price they depend on changes (`ticker` channel, debounced).
import { t as tx, te, ts } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/hubs-strings.js';
import { vars } from '../dynstyle.js';
import { request } from '../api.js';
import { socket } from '../ws.js';
import { session } from '../store.js';
import { esc, eventHref, toast, fmtDate as fmtD, fmtDay, fmtTime } from '../lib.js';
import { multiChart } from './components.js';

const get = (u) => request('GET', u);
const pct = (p) => `${Math.round(p * 100)}%`;
const bp = (x) => `${x > 0 ? '+' : ''}${Number(x).toFixed(1)} bp`;
const rate = (mid) => `${(mid / 100).toFixed(2)}%`;
const fmtDate = (iso) => fmtD(iso);
// Line chart for a value series ({t: seconds, v}) on its own scale (seats, basis points). SVG text uses user units.
function valueChart(points, { fmt = (v) => String(v), height = 200, label = 'Chart', refLine = null } = {}) {
  if (points.length < 2) return `<p class="faint">${te('hubs.value_chart.not_enough_history_yet')}</p>`;
  const W = 640; const H = height; const padR = 56; const padT = 10; const padB = 24;
  const xs = points.map((p) => p.t); const ys = points.map((p) => p.v).concat(refLine == null ? [] : [refLine]);
  const minX = Math.min(...xs); const maxX = Math.max(...xs);
  let lo = Math.min(...ys); let hi = Math.max(...ys); if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
  const padV = (hi - lo) * 0.12; lo -= padV; hi += padV;
  const sx = (t) => ((t - minX) / Math.max(1, maxX - minX)) * (W - padR - 8);
  const sy = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const ticks = [0, 1, 2, 3].map((i) => lo + ((hi - lo) * i) / 3);
  const grid = ticks.map((g) => `<line x1="0" x2="${W - padR}" y1="${sy(g)}" y2="${sy(g)}" stroke="var(--fill-x50)" stroke-dasharray="1 5"/><text x="${W - 4}" y="${sy(g) + 4}" text-anchor="end" font-size="12" fill="var(--text-x20)">${esc(fmt(g))}</text>`).join('');
  const days = [0, 1, 2].map((i) => minX + ((maxX - minX) * i) / 2).map((t, i) => `<text x="${Math.max(2, Math.min(W - padR - 40, sx(t) - (i ? 20 : 0)))}" y="${H - 6}" font-size="12" fill="var(--text-x20)">${esc(fmtDay(t * 1000))}</text>`).join('');
  const ref = refLine == null ? '' : `<line x1="0" x2="${W - padR}" y1="${sy(refLine)}" y2="${sy(refLine)}" stroke="var(--text-x30)" stroke-dasharray="4 4"/>`;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join(' ');
  const last = points[points.length - 1];
  return `<svg class="chart v-h" viewBox="0 0 ${esc(W)} ${esc(H)}"${vars({ '--h': `${H}px` })} role="img" aria-label="${esc(label)}">${grid}${days}${ref}<path d="${d}" fill="none" stroke="var(--brand)" stroke-width="2.2" stroke-linejoin="round"/><circle cx="${sx(last.t)}" cy="${sy(last.v)}" r="4.5" fill="var(--brand)"/></svg>`;
}

// ---------------------------------------------------------------- Senate map
const LEAN_LABEL = { safe_blue: ts('hubs.lean_label_safe_blue.safe_blue'), lean_blue: ts('hubs.lean_label_lean_blue.lean_blue'), tossup: 'Toss-up', lean_red: ts('hubs.lean_label_lean_red.lean_red'), safe_red: ts('hubs.lean_label_safe_red.safe_red'), held_blue: ts('hubs.lean_label_held_blue.not_up_blue'), held_red: ts('hubs.lean_label_held_red.not_up_red'), held_split: ts('hubs.lean_label_held_split.not_up_split') };
function senateHtml(m) {
  const cols = Math.max(...m.states.map((s) => s.grid.col)) + 1;
  const tiles = [...m.states].sort((a, b) => a.grid.row - b.grid.row || a.grid.col - b.grid.col).map((s) => {
    const inner = `<span class="hub-tile-code">${esc(s.code)}</span><span class="hub-tile-name">${esc(s.name)}</span><span class="hub-tile-p num" data-testid="tile-p">${s.status === 'race' ? `${s.leader === 'blue' ? te('hubs.senate_html.blue') : te('hubs.senate_html.red')} ${pct(Math.max(s.blue.probability, s.red.probability))}` : te('hubs.senate_html.not_up')}</span><span class="hub-tile-lean">${esc(LEAN_LABEL[s.lean] || '')}</span>`;
    const attrs = `class="hub-tile lean-${esc(s.lean)}" data-testid="senate-tile" data-state="${esc(s.code)}" data-status="${esc(s.status)}" data-lean="${esc(s.lean)}"${vars({ '--row': s.grid.row + 1, '--col': s.grid.col + 1 })}`;
    return s.status === 'race' ? `<a ${attrs} href="${eventHref({ series_ticker: s.series_ticker, series_slug: s.series_slug, event_ticker: s.event_ticker })}" data-link>${inner}</a>` : `<div ${attrs}>${inner}</div>`;
  }).join('');
  const blueW = (m.seats.expected_blue / m.chamber_size) * 100;
  return `<div class="hub-seats" data-testid="senate-seats"><div class="hub-seat-n"><b class="c-blue" data-testid="exp-blue">${esc(m.seats.expected_blue.toFixed(1))}</b><span class="faint">${te('hubs.senate_html.expected_blue_seats')}</span></div>
      <div class="hub-seat-n ta-r"><b class="c-red" data-testid="exp-red">${esc(m.seats.expected_red.toFixed(1))}</b><span class="faint">${te('hubs.senate_html.expected_red_seats')}</span></div></div>
    <div class="hub-seatbar" role="img" aria-label="${te('hubs.senate_html.expected_seats_blue_red_of', { expected_blue: esc(m.seats.expected_blue), expected_red: esc(m.seats.expected_red), chamber_size: esc(m.chamber_size) })}"><span class="blue v-w"${vars({ '--w': `${blueW.toFixed(2)}%` })}></span><span class="red"></span><i class="maj v-left"${vars({ '--left': `${((m.majority - 0.5) / m.chamber_size) * 100}%` })}></i></div>
    <div class="faint hub-note">${te('hubs.senate_html.seats_for_a_majority_races', { chamber_size: esc(m.chamber_size), majority: esc(m.majority), races: esc(m.races), projected_blue: esc(m.seats.projected_blue), projected_red: esc(m.seats.projected_red) })}</div>
    <div class="hub-grid v-cols"${vars({ '--cols': cols })} data-testid="senate-grid">${tiles}</div>
    <div class="hub-legend">${['safe_blue', 'lean_blue', 'tossup', 'lean_red', 'safe_red'].map((k) => `<span><i class="lean-${k}"></i>${esc(LEAN_LABEL[k])}</span>`).join('')}</div>`;
}

// ---------------------------------------------------------------- Fed funds outlook
function outlookHtml(o) {
  const rows = o.meetings.map((m) => `<tr data-testid="fed-meeting" data-event="${esc(m.event_ticker)}"><td><a href="${eventHref(m)}" data-link>${esc(fmtDate(m.meeting_date))}</a></td>
    <td class="num" data-k="cut">${pct(m.probabilities.cut)}</td><td class="num" data-k="hold">${pct(m.probabilities.hold)}</td><td class="num" data-k="hike">${pct(m.probabilities.hike)}</td>
    <td class="num" data-testid="implied-change">${esc(bp(m.implied_change_bps))}</td><td class="num" data-testid="implied-rate">${esc(rate(m.implied_midpoint_bps))}</td></tr>`).join('');
  return `<div class="faint hub-note">${te('hubs.outlook_html.current_target_range_invented_implied', { rate: esc(rate(o.current_range_bps.lower)), rate_2: esc(rate(o.current_range_bps.upper)) })}</div>
    <div class="table-wrap"><table class="table hub-table" data-testid="fed-table"><thead><tr><th>${te('hubs.outlook_html.meeting')}</th><th class="num">${te('hubs.outlook_html.cut')}</th><th class="num">${te('hubs.outlook_html.hold')}</th><th class="num">${te('hubs.outlook_html.hike')}</th><th class="num">${te('hubs.outlook_html.implied')}</th><th class="num">${te('hubs.outlook_html.rate_after')}</th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="faint">${te('hubs.outlook_html.no_open_meetings')}</td></tr>`}</tbody></table></div>
    <h3 class="hub-sub">${te('hubs.outlook_html.implied_rate_path')}</h3>${valueChart([{ t: Date.parse(o.updated_time) / 1000, v: o.current_midpoint_bps }, ...o.meetings.map((m) => ({ t: Date.parse(m.meeting_date) / 1000, v: m.implied_midpoint_bps }))], { fmt: (v) => rate(v), label: tx('hubs.outlook_html.implied_rate_path'), height: 180 })}`;
}

// ---------------------------------------------------------------- forecast history
async function drawForecast(box, seriesTicker, eventTicker) {
  let f;
  try { f = await get(`/v1/series/${encodeURIComponent(seriesTicker)}/events/${encodeURIComponent(eventTicker)}/forecast_history?days=7`); } catch { box.innerHTML = `<p class="faint">${te('hubs.draw_forecast.no_forecast_history')}</p>`; return; }
  if (f.kind === 'rate_decision') {
    box.innerHTML = `<div data-testid="forecast-history" data-kind="rate_decision">${valueChart(f.points.filter((p) => p.implied_change_bps != null).map((p) => ({ t: p.ts, v: p.implied_change_bps })), { fmt: (v) => bp(v), label: tx('hubs.draw_forecast.implied_change_history'), refLine: 0 })}</div>`;
    return;
  }
  const series = f.outcomes.map((o) => ({ name: o.name, color: o.color, points: f.points.filter((p) => p.values[o.ticker] != null).map((p) => ({ t: p.ts, v: Math.round(p.values[o.ticker]) })) }));
  box.innerHTML = `<div data-testid="forecast-history" data-kind="probability"><div class="legend">${series.map((s) => `<span><i class="v-bg"${vars({ '--bg': s.color })}></i>${esc(s.name)} <b>${s.points.length ? esc(s.points[s.points.length - 1].v) : '—'}%</b></span>`).join('')}</div>${multiChart(series, { height: 220, width: 640 })}</div>`;
}

// ---------------------------------------------------------------- ballot lookup (privacy: the address stays in the browser
// except for the one lookup request; the server keeps only a jurisdiction you choose to save)
function contestsHtml(r) {
  if (!r.jurisdiction) return `<p class="faint" data-testid="ballot-none">${te('hubs.contests_html.we_couldn_t_match_that')}</p>`;
  const chain = r.jurisdiction.chain.slice().reverse().map((x) => esc(x.name)).join(' · ');
  const items = r.contests.map((c) => `<a class="ballot-contest" href="${eventHref(c)}" data-link data-testid="ballot-contest" data-event="${esc(c.event_ticker)}"><span class="overline">${esc(c.kind === 'measure' ? tx('hubs.contests_html.ballot_measure') : c.office)} · ${esc(c.jurisdiction)}</span>
      <b>${esc(c.title)}</b><span class="ballot-lead">${c.leader ? `${esc(c.leader.name)} <span class="num">${c.leader.last_price_dollars != null ? Math.round(Number(c.leader.last_price_dollars) * 100) : '—'}%</span>` : ''}</span></a>`).join('');
  return `<div class="ballot-where" data-testid="ballot-jurisdiction" data-jurisdiction="${esc(r.jurisdiction.id)}">${chain}</div>${items || `<p class="faint">${te('hubs.contests_html.no_contests_with_markets_here')}</p>`}`;
}
function mountBallot(box) {
  box.innerHTML = `<section class="card ballot-card" data-testid="ballot"><h2>${te('hubs.mount_ballot.what_s_on_your_ballot')}</h2>
    <form class="ballot-form" data-testid="ballot-form" autocomplete="off"><label class="sr-only" for="ballot-address">${te('hubs.mount_ballot.address_or_5_digit_code')}</label>
      <input id="ballot-address" name="address" maxlength="200" placeholder="${te('hubs.mount_ballot.street_address_or_5_digit')}" autocomplete="off" required><button class="btn btn-primary" type="submit">${te('hubs.mount_ballot.look_up')}</button></form>
    <p class="faint ballot-privacy" data-testid="ballot-privacy">${te('hubs.mount_ballot.we_don_t_store_your')}</p>
    <div data-testid="ballot-saved" class="ballot-saved"></div><div data-testid="ballot-results" class="ballot-results"></div></section>`;
  const results = box.querySelector('[data-testid=ballot-results]'); const saved = box.querySelector('[data-testid=ballot-saved]');
  let current = null;
  const drawSaved = (s) => {
    saved.innerHTML = s ? `<span>${te('hubs.mount_ballot.saved_area')} <b data-testid="ballot-saved-name">${esc(s.jurisdiction.name)}</b></span> <button class="btn btn-sm btn-ghost" data-forget data-testid="ballot-forget">${te('hubs.mount_ballot.forget')}</button>` : '';
  };
  const showResult = (r, { savable }) => {
    current = r;
    results.innerHTML = contestsHtml(r) + (savable && r.jurisdiction && session.user ? `<button class="btn btn-sm" data-save data-testid="ballot-save">${te('hubs.mount_ballot.save', { name: esc(r.jurisdiction.name) })}</button>` : '');
  };
  if (session.user) get(`/v1/users/${encodeURIComponent(session.uid)}/ballot`).then((r) => { if (r.saved) { drawSaved(r); showResult(r, { savable: false }); } }).catch(() => {});
  box.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = e.target.elements.address;
    try { showResult(await request('POST', '/v1/ballot/lookup', { address: input.value }), { savable: true }); } catch (ex) { toast(ex.message, 'error'); }
  });
  box.addEventListener('click', async (e) => {
    if (e.target.closest('[data-save]') && current?.jurisdiction) {
      try { const r = await request('PUT', `/v1/users/${encodeURIComponent(session.uid)}/ballot`, { jurisdiction_id: current.jurisdiction.id }); drawSaved(r); e.target.closest('[data-save]').remove(); toast(tx('hubs.mount_ballot.ballot_area_saved')); } catch (ex) { toast(ex.message, 'error'); }
    }
    if (e.target.closest('[data-forget]')) {
      try { await request('DELETE', `/v1/users/${encodeURIComponent(session.uid)}/ballot`); drawSaved(null); toast(tx('hubs.mount_ballot.saved_area_removed')); } catch (ex) { toast(ex.message, 'error'); }
    }
  });
}

// ---------------------------------------------------------------- pages
export async function render({ el, params }) {
  const hub = params.hub || 'ballot';
  if (hub === 'ballot') {
    document.title = tx('hubs.render.your_ballot_parlance');
    el.innerHTML = `<div class="hub-page"><div class="overline">${te('hubs.render.elections')}</div><h1 class="page-title">${te('hubs.render.your_ballot')}</h1><div id="ballot-box" class="hub-narrow"></div></div>`;
    mountBallot(el.querySelector('#ballot-box'));
    return () => {};
  }
  if (hub !== 'elections' && hub !== 'economics') { const e = new Error(tx('hubs.render.unknown_hub')); e.notFound = true; throw e; }
  const elections = hub === 'elections';
  document.title = tx('hubs.render.parlance', { value: elections ? tx('hubs.render.harbor_2026_hub') : tx('hubs.render.rates_outlook') });
  el.innerHTML = `<div class="hub-page" data-testid="hub-page" data-hub="${esc(hub)}"><div class="overline">${elections ? te('hubs.render.elections') : te('hubs.render.economics')}</div><h1 class="page-title">${elections ? te('hubs.render.harbor_2026_hub') : te('hubs.render.rates_outlook')}</h1>
    <div class="hub-layout"><div class="minw-0">
      <section class="card hub-card" data-testid="${elections ? 'senate-map' : 'fed-outlook'}"><div class="hub-card-head"><h2>${elections ? te('hubs.render.senate_map') : te('hubs.render.fed_funds_outlook')}</h2><span class="faint" data-updated></span></div><div data-widget><div class="skeleton minh-260"></div></div></section>
      <section class="card hub-card"><div class="hub-card-head"><h2>${elections ? te('hubs.render.expected_blue_seats') : te('hubs.render.forecast_history')}</h2><span class="faint">${elections ? te('hubs.render.last_7_days') : te('hubs.render.next_meeting_implied_change')}</span></div><div data-history></div></section>
      <section class="card hub-card"><div class="hub-card-head"><h2>${elections ? te('hubs.render.forecast_history_governor') : te('hubs.render.next_meeting_outcome_odds')}</h2><span class="faint">${te('hubs.render.last_7_days')}</span></div><div data-forecast></div></section>
    </div><aside class="minw-0" data-rail></aside></div></div>`;
  const widget = el.querySelector('[data-widget]'); const history = el.querySelector('[data-history]'); const fc = el.querySelector('[data-forecast]');
  let tickers = new Set();
  async function draw() {
    try {
      if (elections) {
        const m = await get('/v1/hubs/senate_map');
        widget.innerHTML = senateHtml(m);
        history.innerHTML = valueChart(m.history.map((p) => ({ t: p.ts, v: p.expected_blue })), { fmt: (v) => v.toFixed(1), label: tx('hubs.render.expected_blue_seats'), refLine: m.majority - 0.5 });
        tickers = new Set(m.states.filter((s) => s.status === 'race').flatMap((s) => [s.blue.ticker, s.red.ticker]));
        await drawForecast(fc, 'PLXSTATE', 'PLXSTATE-26GOV');
      } else {
        const o = await get('/v1/hubs/fed_funds_outlook');
        widget.innerHTML = outlookHtml(o);
        tickers = new Set(o.meetings.flatMap((m) => ['CUT', 'HOLD', 'HIKE'].map((k) => `${m.event_ticker}-${k}`)));
        const next = o.meetings[0];
        if (next) await drawForecast(history, next.series_ticker, next.event_ticker); else history.innerHTML = `<p class="faint">${te('hubs.render.no_open_meetings')}</p>`;
        if (next) { const f = await get(`/v1/series/${encodeURIComponent(next.series_ticker)}/events/${encodeURIComponent(next.event_ticker)}/forecast_history?days=7`); fc.innerHTML = multiChart(f.outcomes.map((x) => ({ name: x.name, color: x.color, points: f.points.filter((p) => p.values[x.ticker] != null).map((p) => ({ t: p.ts, v: Math.round(p.values[x.ticker]) })) })), { height: 220, width: 640 }); }
      }
      el.querySelector('[data-updated]').textContent = tx('hubs.render.updated', { fmt_time: fmtTime(Date.now(), true) });
    } catch (e) { widget.innerHTML = `<p class="faint">${esc(e.message)}</p>`; }
  }
  await draw();
  if (elections) mountBallot(el.querySelector('[data-rail]'));
  else el.querySelector('[data-rail]').innerHTML = `<section class="card hub-card"><h2>${te('hubs.render.about_these_numbers')}</h2><p class="faint">${te('hubs.render.probabilities_are_the_last_traded')}</p></section>`;
  let t = null;
  const unsub = socket.subscribe({ channels: ['ticker'] }, (m) => { if (m.type === 'ticker' && tickers.has(m.msg.market_ticker)) { clearTimeout(t); t = setTimeout(draw, 800); } });
  return () => { unsub(); clearTimeout(t); };
}
