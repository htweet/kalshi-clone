// Scoreboard components (CLONE_SPEC.md §19.6): per-sport compact score columns for market cards, a richer game
// card for the /sports hub, the full event-page scoreboard, win-probability bar, play-by-play and box score, plus
// the page-wide live patcher that applies `live_data` WebSocket messages (polling fallback) to whatever is shown.
// Monograms and sport icons are generated here (no logos or photos).
import { t as tx, te, ts } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/scoreboard-strings.js';
import { vars } from '../dynstyle.js';
import { esc, cents, eventHref, dayKey, fmtDt, fmtDay } from '../lib.js';
import { socket } from '../ws.js';
import { request } from '../api.js';

export const SPORT_LABEL = { soccer: 'Soccer', basketball: 'Basketball', football: 'Football', tennis: 'Tennis', cricket: 'Cricket', esports: 'Esports', hockey: 'Hockey' };
const ICONS = {
  soccer: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.6l3.3 2.4-1.2 3.9H9.9L8.7 10z" fill="currentColor"/><path d="M12 3.2v4.4M20.4 9.4l-5.1.6M17.3 19.2l-3.2-5.3M6.7 19.2l3.2-5.3M3.6 9.4l5.1.6" stroke="currentColor" stroke-width="1.4" fill="none"/>',
  basketball: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 12h18M12 3v18M5.7 5.6c3 3.2 3 9.6 0 12.8M18.3 5.6c-3 3.2-3 9.6 0 12.8" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  football: '<ellipse cx="12" cy="12" rx="9.5" ry="5.6" transform="rotate(-35 12 12)" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9.4 14.6l5.2-5.2M10.2 11.4l2.4 2.4M11.6 10l2.4 2.4" stroke="currentColor" stroke-width="1.4" fill="none"/>',
  tennis: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4.8 6.3c3.6 2.9 3.6 8.5 0 11.4M19.2 6.3c-3.6 2.9-3.6 8.5 0 11.4" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  cricket: '<path d="M15.6 3.2l3.2 3.2-8.9 8.9-3.2-3.2z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M8.3 14.1l-4.6 4.6 1.6 1.6 4.6-4.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="17.6" cy="17.4" r="2.6" fill="currentColor"/>',
  esports: '<path d="M7.2 7.5h9.6a4.2 4.2 0 014.1 3.6l.8 5a2.1 2.1 0 01-3.6 1.8l-2.4-2.6H8.3l-2.4 2.6a2.1 2.1 0 01-3.6-1.8l.8-5a4.2 4.2 0 014.1-3.6z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M8.2 9.8v3.4M6.5 11.5h3.4" stroke="currentColor" stroke-width="1.5"/><circle cx="15.6" cy="10.6" r="1.1" fill="currentColor"/><circle cx="17.6" cy="12.6" r="1.1" fill="currentColor"/>',
 hockey: '<path d="M4.5 3.5l6.8 11.3a2 2 0 001.7 1h6.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><ellipse cx="9" cy="18.5" rx="3.6" ry="1.6" fill="currentColor"/>',
  all: '<circle cx="8" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="16" cy="16" r="4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M14 6h6M17 3v6M4 18h6" stroke="currentColor" stroke-width="1.7"/>',
};
export const sportIcon = (sport, size = 18) => `<svg class="sb-icon" width="${esc(size)}" height="${esc(size)}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[sport] || ICONS.all}</svg>`;
export const monogram = (t, cls = '') => `<span class="sb-mono ${esc(cls)}"${vars({ '--team': t.color })} aria-hidden="true">${esc(t.abbr)}</span>`;

const sideKey = (side) => (side === 'home' ? 'competitor1' : 'competitor2');
const isFinal = (ld) => ld.status === 'final';
const winnerCls = (ld, side) => (isFinal(ld) ? (ld.details.winner === side ? ' won' : ' lost') : '');
export function startText(isoStr) {
  const d = new Date(isoStr); const mins = Math.round((d - Date.now()) / 60000);
  if (mins <= 0) return tx('scoreboard.start_text.starting');
  if (mins < 60) return tx('scoreboard.start_text.starts_in_m', { mins });
  const t = fmtDt(d, { hour: 'numeric', minute: '2-digit' });
  return dayKey(d) === dayKey() ? `Today ${t}` : `${fmtDay(d)} · ${t}`;
}
export const statusText = (ld) => (ld.status === 'live' ? ld.live_label : isFinal(ld) ? 'Final' : startText(ld.start_date));

// ---------- running game clocks (Phase 5B, PLAN G9) ----------
// details.game_clock = {name, seconds, running, direction, format, cap?, rate}: the value when the server sent it. The
// page advances every [data-gclock] element locally (tickClocks, 4 times a second) until the next update replaces it.
const two = (n) => String(n).padStart(2, '0');
export function clockText(fmt, sec, cap) {
  const s = Math.max(0, Math.floor(sec));
  if (fmt === 'minute') { const m = Math.floor(s / 60) + 1; return `${cap ? Math.min(m, Math.round(cap / 60)) : m}'`; }
  if (fmt === 'hmmss') return `${Math.floor(s / 3600)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
  return `${Math.floor(s / 60)}:${two(s % 60)}`;
}
const clockNow = (n) => {
  const base = Number(n.dataset.gcS); const rate = Number(n.dataset.gcRate) || 1; const at = Number(n.dataset.gcAt) || Date.now();
  const d = n.dataset.gcRun === '1' ? ((Date.now() - at) / 1000) * rate : 0;
  return n.dataset.gcDir === 'down' ? Math.max(0, base - d) : base + d;
};
export function clockSpan(gc, testid = 'game-clock') {
  if (!gc || gc.seconds == null || gc.format === 'none') return '';
  const cap = gc.cap || '';
  return `<span class="sb-gclock" data-testid="${esc(testid)}" data-gclock data-gc-s="${esc(gc.seconds)}" data-gc-dir="${esc(gc.direction)}" data-gc-rate="${esc(gc.rate || 1)}" data-gc-fmt="${esc(gc.format)}" data-gc-cap="${esc(cap)}" data-gc-run="${gc.running ? '1' : '0'}" data-gc-at="${Date.now()}">${esc(clockText(gc.format, gc.seconds, gc.cap))}</span>`;
}
export function tickClocks(root = document) {
  for (const n of root.querySelectorAll('[data-gclock][data-gc-run="1"]')) {
    const t = clockText(n.dataset.gcFmt, clockNow(n), Number(n.dataset.gcCap) || 0);
    if (n.textContent !== t) n.textContent = t;
  }
}
// "Q3 4:12" (countdown) or "Set 2 · 3-2 · 1:12:05" (elapsed): the period name plus a running clock when there is one.
export function runLabel(ld) {
  const gc = ld.details && ld.details.game_clock;
  if (!gc || ld.status !== 'live') return esc(statusText(ld));
  if (gc.seconds == null || gc.format === 'none') return esc(gc.name || ld.live_label);
  return `${esc(gc.name)}${gc.direction === 'down' ? ' ' : ' · '}${clockSpan(gc)}`;
}
// Event header label (event.js): live state with the running clock, the final score, or the start time.
export const evLabelInner = (ld) => (ld.status === 'live' ? `<span class="live-dot">${te('scoreboard.ev_label_inner.live')}</span><span>${runLabel(ld)}</span>`
  : isFinal(ld) ? `<span class="sb-final-tag">${te('scoreboard.ev_label_inner.final')}</span><span>${esc(ld.details.home_score)}-${esc(ld.details.away_score)}</span>` : `<span>${esc(startText(ld.start_date))}</span>`);

// ---------- compact score columns (cards) ----------
export function sideCols(ld, side) {
  const d = ld.details;
  if (ld.status === 'scheduled') return '';
  if (ld.sport === 'tennis') {
    const c = sideKey(side);
    const serve = ld.status === 'live' && d.server === c;
    return `<i class="sb-serve${serve ? ' on' : ''}" ${serve ? 'data-testid="sb-serve" title="Serving"' : ''}></i>${(d[`${c}_round_scores`] || []).map((s) => `<span class="sb-set${s.outcome === 'winner' ? ' won' : ''}" data-testid="sb-set">${esc(s.score)}${s.tiebreak_score != null ? `<sup data-tb="${esc(s.tiebreak_score)}">${esc(s.tiebreak_score)}</sup>` : ''}</span>`).join('')}${ld.status === 'live' ? `<span class="sb-pts" data-testid="sb-pts">${esc(d[`${c}_current_round_score`])}</span>` : ''}`;
  }
  if (ld.sport === 'cricket') {
    const batted = d[`${side}_balls`] > 0 || d.batting === side;
    return batted ? `<span class="sb-runs" data-testid="sb-runs">${esc(d[`${side}_total_runs`])}/${esc(d[`${side}_wickets`])}</span><span class="sb-ov">${esc(d[`${side}_overs`])}</span>` : `<span class="sb-ov">${te('scoreboard.side_cols.yet_to_bat')}</span>`;
  }
  if (ld.sport === 'esports') return `<span class="sb-set" title="${te('scoreboard.side_cols.rounds_on_the_current_map')}">${esc(d[`${side}_periods`]?.[`period_${d.current_period}`] ?? 0)}</span><span class="sb-big" data-testid="sb-score">${esc(d[`${side}_score`])}</span>`;
  return `<span class="sb-big" data-testid="sb-score">${esc(d[`${side}_score`])}</span>`;
}
// Card rows for a game: home then away (the draw market stays on the event page and the hub card).
export function cardMarkets(ev) {
  const o = ev.live_data.outcomes || {}; const rank = (m) => ({ home: 0, away: 1 }[o[m.ticker]] ?? 2);
  return [...ev.markets].sort((a, b) => rank(a) - rank(b)).slice(0, 2);
}
// Score columns beside the odds pill of an event card row (components.js eventCard).
export function scoreCols(ev, m) {
  const ld = ev.live_data;
  if (!ld) return '';
  const side = ld.outcomes?.[m.ticker];
  if (side !== 'home' && side !== 'away') return '<span class="sb-cols"></span>';
  return `<span class="sb-cols${winnerCls(ld, side)}" data-testid="sb-cols" data-live-ms="${esc(ld.milestone_id)}" data-sb-part="cols" data-sb-side="${esc(side)}">${sideCols(ld, side)}</span>`;
}
const subInner = (ld) => (ld.status === 'live' ? `<span class="live-dot">${te('scoreboard.sub_inner.live')}</span><span>${esc(ld.competition)} · ${runLabel(ld)}</span>`
  : isFinal(ld) ? `<span class="sb-final-tag">${te('scoreboard.sub_inner.final')}</span><span>${esc(ld.competition)}</span>` : `<span>${esc(ld.competition)} · ${esc(startText(ld.start_date))}</span>`);
// Card subtitle: red LIVE + competition + game state (observed browse pattern, CLONE_SPEC §15.3).
export const liveSub = (ev) => `<span class="sb-sub" data-testid="sb-sub" data-live-ms="${esc(ev.live_data.milestone_id)}" data-sb-part="sub">${subInner(ev.live_data)}</span>`;

// ---------- win probability ----------
function winBarInner(ld) {
  const d = ld.details;
  const h = Math.round(d.home_win_probability * 100); const a = Math.round(d.away_win_probability * 100);
  const dr = d.draw_probability != null ? Math.max(0, 100 - h - a) : 0;
  return `<div class="sb-wp-labels"><span><b>${esc(ld.home.abbr)}</b> ${h}%</span>${d.draw_probability != null ? `<span>${te('scoreboard.win_bar_inner.draw', { dr })}</span>` : ''}<span>${a}% <b>${esc(ld.away.abbr)}</b></span></div>
    <div class="sb-wp-bar" role="img" aria-label="${te('scoreboard.win_bar_inner.win_probability', { name: esc(ld.home.name), h, name_2: esc(ld.away.name), a })}"><span class="v-flex v-bg"${vars({ '--flex': Math.max(h, 0.5), '--bg': ld.home.color })}></span>${dr ? `<span class="draw v-flex"${vars({ '--flex': dr })}></span>` : ''}<span class="v-flex v-bg"${vars({ '--flex': Math.max(a, 0.5), '--bg': ld.away.color })}></span></div>`;
}
export const winBar = (ld, attrs = '') => `<div class="sb-wp" data-testid="win-bar" ${attrs /* eslint-disable-line parlance/no-unescaped-html -- attribute markup from callers, built with esc() */}>${winBarInner(ld)}</div>`;

// ---------- hub game card (compact scoreboard + odds per side) ----------
function oddsOf(m) {
  if (!m) return null;
  if (m.last_price_dollars != null) return cents(m.last_price_dollars);
  if (m.yes_bid_dollars != null && m.yes_ask_dollars != null) return Math.round((cents(m.yes_bid_dollars) + cents(m.yes_ask_dollars)) / 2);
  return null;
}
export function gameCard({ live_data: ld, event: ev }) {
  const href = ev ? eventHref(ev) : '#';
  const mk = (side) => ev && ev.markets.find((m) => ld.outcomes[m.ticker] === side);
  const row = (side) => {
    const t = ld[side]; const m = mk(side); const p = oddsOf(m);
    return `<div class="sb-row${winnerCls(ld, side)}">${monogram(t)}<span class="sb-name">${esc(t.name)}</span>
      <span class="sb-cols${winnerCls(ld, side)}" data-live-ms="${esc(ld.milestone_id)}" data-sb-part="cols" data-sb-side="${esc(side)}">${sideCols(ld, side)}</span>
      ${m && m.status === 'active' ? `<a class="odds pill sb-odds" href="${href}?side=yes&amp;market=${esc(m.ticker)}" data-link data-odds-ticker="${esc(m.ticker)}">${p == null ? '—' : p + '%'}</a>` : `<span class="sb-odds-ph">${m && m.result ? (m.result === 'yes' ? te('scoreboard.game_card.won') : '') : ''}</span>`}</div>`;
  };
  const draw = ev && ev.markets.find((m) => ld.outcomes[m.ticker] === 'draw');
  return `<article class="card sb-game ${esc(ld.status)}" data-testid="game-card" data-milestone="${esc(ld.milestone_id)}" data-status="${esc(ld.status)}" data-sport="${esc(ld.sport)}" data-league="${esc(ld.league.id)}">
    <a class="sb-game-head" href="${href}" data-link>${sportIcon(ld.sport, 16)}<span class="sb-league">${esc(ld.league.short_name)}</span><span class="sb-state" data-live-ms="${esc(ld.milestone_id)}" data-sb-part="state">${stateInner(ld)}</span></a>
    ${row('home')}${row('away')}
    ${draw && draw.status === 'active' ? `<div class="sb-draw-row"><span>${te('scoreboard.game_card.draw')}</span><a class="odds pill sb-odds" href="${href}?side=yes&amp;market=${esc(draw.ticker)}" data-link data-odds-ticker="${esc(draw.ticker)}">${oddsOf(draw) ?? '—'}%</a></div>` : ''}
    <div class="sb-last" data-live-ms="${esc(ld.milestone_id)}" data-sb-part="lastplay">${esc(lastLine(ld))}</div>
    ${ld.status === 'scheduled' ? '' : winBar(ld, `data-live-ms="${esc(ld.milestone_id)}" data-sb-part="winbar"`)}
  </article>`;
}
const stateInner = (ld) => (ld.status === 'live' ? `<span class="live-dot">${te('scoreboard.state_inner.live')}</span> ${runLabel(ld)}` : esc(statusText(ld)));
const lastLine = (ld) => (ld.status === 'scheduled' ? `${ld.competition}` : ld.sport === 'cricket' && ld.details.match_comment ? ld.details.match_comment : ld.details.last_play || '');

// ---------- full scoreboard (event page) ----------
function teamBlock(ld, side) {
  const t = ld[side];
  return `<div class="sb-team sb-${esc(side)}${winnerCls(ld, side)}">${monogram(t, 'lg')}<div class="sb-team-name">${esc(t.name)}</div></div>`;
}
function lineScore(ld, heads) {
  const L = ld.lines || { home: [], away: [] };
  const n = Math.max(L.home.length, L.away.length);
  if (!n) return '';
  const cols = Array.from({ length: n }, (_, i) => heads(i));
  return `<table class="sb-line" data-testid="line-score"><thead><tr><th></th>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}<th>T</th></tr></thead><tbody>
    ${['home', 'away'].map((s) => `<tr class="${winnerCls(ld, s)}"><td>${esc(ld[s].abbr)}</td>${cols.map((_, i) => `<td>${esc(L[s][i] ?? '–')}</td>`).join('')}<td><b>${esc(ld.details[`${s}_score`])}</b></td></tr>`).join('')}</tbody></table>`;
}
function fullBody(ld) {
  const d = ld.details;
  if (ld.sport === 'tennis') {
    const sets = Math.max(d.competitor1_round_scores.length, 1);
    const head = `<tr><th></th>${Array.from({ length: sets }, (_, i) => `<th>${te('scoreboard.full_body.set', { value: i + 1 })}</th>`).join('')}${ld.status === 'live' ? `<th>${te('scoreboard.full_body.pts')}</th>` : ''}</tr>`;
    const row = (side) => { const c = sideKey(side); const serve = ld.status === 'live' && d.server === c;
      return `<tr class="${winnerCls(ld, side)}" data-side="${esc(side)}"><td class="sb-who">${monogram(ld[side])}<i class="sb-serve${serve ? ' on' : ''}" ${serve ? 'data-testid="sb-serve" title="Serving"' : ''}></i><span>${esc(ld[side].name)}</span></td>
        ${d[`${c}_round_scores`].map((s) => `<td class="sb-set${s.outcome === 'winner' ? ' won' : ''}" data-testid="sb-set">${esc(s.score)}${s.tiebreak_score != null ? `<sup data-tb="${esc(s.tiebreak_score)}">${esc(s.tiebreak_score)}</sup>` : ''}</td>`).join('')}
        ${ld.status === 'live' ? `<td class="sb-pts" data-testid="sb-pts">${esc(d[`${c}_current_round_score`])}</td>` : ''}</tr>`; };
    return `<table class="sb-tennis" data-testid="sb-tennis"><thead>${head}</thead><tbody>${row('home')}${row('away')}</tbody></table>
      ${d.in_tiebreak ? `<div class="sb-note">${te('scoreboard.full_body.tiebreak')}</div>` : d.advantage ? `<div class="sb-note">${te('scoreboard.full_body.advantage', { name: esc(ld[d.advantage === 'competitor1' ? 'home' : 'away'].name) })}</div>` : ''}`;
  }
  if (ld.sport === 'cricket') {
    const row = (side) => { const batted = d[`${side}_balls`] > 0 || d.batting === side;
      return `<tr class="${winnerCls(ld, side)}"><td class="sb-who">${monogram(ld[side])}<span>${esc(ld[side].name)}</span>${d.batting === side ? `<i class="sb-bat" title="${te('scoreboard.full_body.batting')}">${te('scoreboard.full_body.bat')}</i>` : ''}</td><td class="sb-runs" data-testid="sb-runs-${esc(side)}">${batted ? `${esc(d[`${side}_total_runs`])}/${esc(d[`${side}_wickets`])}` : '–'}</td><td class="sb-ov">${batted ? te('scoreboard.full_body.ov', { value: esc(d[`${side}_overs`]) }) : te('scoreboard.full_body.yet_to_bat')}</td></tr>`; };
    const info = [d.target ? `<span data-testid="sb-target">${te('scoreboard.full_body.target')} <b>${esc(d.target)}</b></span>` : '', `<span data-testid="sb-crr">${te('scoreboard.full_body.crr')} <b>${Number(d.run_rate || 0).toFixed(2)}</b></span>`, d.required_run_rate != null ? `<span data-testid="sb-rrr">${te('scoreboard.full_body.rrr')} <b>${Number(d.required_run_rate).toFixed(2)}</b></span>` : ''].filter(Boolean).join('');
    return `<table class="sb-cricket"><tbody>${row('home')}${row('away')}</tbody></table><div class="sb-info">${info}<span class="sb-allotted">${te('scoreboard.full_body.overs', { allotted_overs: esc(d.allotted_overs) })}</span></div>
      ${d.match_comment ? `<div class="sb-note" data-testid="sb-comment">${esc(d.match_comment)}</div>` : ''}${(d.recent_balls || []).length && ld.status === 'live' ? `<div class="sb-balls" aria-label="${te('scoreboard.full_body.recent_deliveries')}">${d.recent_balls.map((b) => `<span class="b b-${esc(b)}">${esc(b)}</span>`).join('')}</div>` : ''}`;
  }
  const mid = `<div class="sb-mid"><div class="sb-scoreline"><span data-testid="sb-score-home">${esc(d.home_score)}</span><span class="dash">–</span><span data-testid="sb-score-away">${esc(d.away_score)}</span></div>
    <div class="sb-clock" data-testid="sb-clock">${ld.status === 'live' ? runLabel(ld) : esc(statusText(ld))}</div>
    ${ld.sport === 'hockey' && ld.status === 'live' && d.power_play ? `<div class="sb-note sb-pp" data-testid="sb-power-play">${te('scoreboard.full_body.power_play', { abbr: esc(ld[d.power_play.team].abbr), clock_text: esc(clockText('mmss', d.power_play.remaining_seconds)) })}</div>` : ''}
    ${ld.sport === 'hockey' ? `<div class="sb-note">${te('scoreboard.full_body.shots', { home_shots: esc(d.home_shots), away_shots: esc(d.away_shots) })}</div>` : ''}
    ${ld.sport === 'football' && d.down_distance ? `<div class="sb-note" data-testid="sb-downs">${te('scoreboard.full_body.ball', { down_distance: esc(d.down_distance), abbr: esc(ld[d.possession].abbr) })}</div>` : ''}
    ${ld.sport === 'basketball' && ld.status === 'live' ? `<div class="sb-note">${te('scoreboard.full_body.possession', { abbr: esc(ld[d.possession].abbr) })}</div>` : ''}
    ${ld.sport === 'soccer' && (d.home_red_cards || d.away_red_cards) ? `<div class="sb-note">${te('scoreboard.full_body.red_cards', { home_red_cards: esc(d.home_red_cards), away_red_cards: esc(d.away_red_cards) })}</div>` : ''}
    ${ld.sport === 'esports' ? `<div class="sb-note">${te('scoreboard.full_body.best_of_maps_won', { best_of: esc(d.best_of) })}</div>` : ''}</div>`;
  const head = { soccer: (i) => `${i === 0 ? '1st' : '2nd'}`, basketball: (i) => (i < 4 ? `Q${i + 1}` : i === 4 ? 'OT' : `${i - 3}OT`), football: (i) => (i < 4 ? `Q${i + 1}` : 'OT'), esports: (i) => `Map ${i + 1}`, hockey: (i) => (i < 3 ? `P${i + 1}` : i === 3 ? 'OT' : 'SO') }[ld.sport];
  return `<div class="sb-teams">${teamBlock(ld, 'home')}${mid}${teamBlock(ld, 'away')}</div>${head ? lineScore(ld, head) : ''}`;
}
export function fullBoard(ld) {
  const d = ld.details;
  const winner = isFinal(ld) && d.winner ? (d.winner === 'draw' ? 'Draw' : `${ld[d.winner].name} won`) : '';
  return `<div class="sb-full-head"><span class="sb-full-league">${sportIcon(ld.sport, 16)} ${esc(ld.competition.startsWith(ld.league.name) ? ld.competition : `${ld.league.name} · ${ld.competition}`)} · ${esc(ld.sport_label)}</span>
      <span class="sb-status ${esc(ld.status)}" data-testid="sb-status">${ld.status === 'live' ? `<span class="live-dot">${te('scoreboard.full_board.live')}</span> ${esc(ld.live_label)}` : esc(statusText(ld))}</span></div>
    ${winner ? `<div class="sb-winner" data-testid="sb-winner">${esc(winner)}</div>` : ''}
    <div class="sb-full-body">${fullBody(ld)}</div>
    ${(ld.sport === 'tennis' || ld.sport === 'esports') && ld.status === 'live' && d.game_clock && d.game_clock.seconds != null ? `<div class="sb-matchtime" data-testid="sb-match-time"><span class="faint">${esc(d.game_clock.label || tx('scoreboard.full_board.time'))}</span> ${clockSpan(d.game_clock, 'match-clock')}</div>` : ''}
    ${ld.status === 'scheduled' ? `<div class="sb-last">${te('scoreboard.full_board.pre_game_win_probability')}</div>` : `<div class="sb-last" data-testid="last-play"><span class="faint">${te('scoreboard.full_board.last_play')}</span> ${esc(d.last_play || '')}</div>`}
    ${winBar(ld)}`;
}

// ---------- play-by-play + box score ----------
export function playItem(p, ld) {
  const t = p.team === 'home' || p.team === 'away' ? ld[p.team] : null;
  return `<li data-testid="pbp-item" data-seq="${esc(p.seq)}" class="k-${esc(p.kind)}"><span class="sb-pbp-clock">${esc(p.clock)}</span>${t ? monogram(t, 'sm') : '<span class="sb-mono sm none"></span>'}<span class="sb-pbp-text">${esc(p.text)}</span><span class="sb-pbp-score num">${esc(p.home_score)}-${esc(p.away_score)}</span></li>`;
}
export const playsList = (plays, ld) => `<ol class="sb-pbp" data-testid="pbp">${plays.map((p) => playItem(p, ld)).join('') || `<li class="faint">${te('scoreboard.plays_list.no_plays_yet')}</li>`}</ol>`;
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');
const ovs = (balls) => `${Math.floor(balls / 6)}.${balls % 6}`;
const BOX = {
  soccer: [[ts('scoreboard.box_soccer.possession'), (s, o) => pct(s.possession_sec, s.possession_sec + o.possession_sec)], [ts('scoreboard.box_soccer.shots'), 'shots'], [ts('scoreboard.box_soccer.shots_on_target'), 'shots_on_target'], [ts('scoreboard.box_soccer.corners'), 'corners'], [ts('scoreboard.box_soccer.fouls'), 'fouls'], [ts('scoreboard.box_soccer.yellow_cards'), 'yellow_cards'], [ts('scoreboard.box_soccer.red_cards'), 'red_cards']],
  basketball: [[ts('scoreboard.box_basketball.field_goals'), (s) => `${s.fgm}-${s.fga}`], ['FG%', (s) => pct(s.fgm, s.fga)], ['3-pointers', (s) => `${s.tpm}-${s.tpa}`], [ts('scoreboard.box_basketball.free_throws'), (s) => `${s.ftm}-${s.fta}`], [ts('scoreboard.box_basketball.rebounds'), 'reb'], [ts('scoreboard.box_basketball.assists'), 'ast'], [ts('scoreboard.box_basketball.turnovers'), 'tov'], [ts('scoreboard.box_basketball.fouls'), 'pf']],
  football: [[ts('scoreboard.box_football.total_yards'), 'total_yards'], [ts('scoreboard.box_football.passing_yards'), 'passing_yards'], [ts('scoreboard.box_football.rushing_yards'), 'rushing_yards'], [ts('scoreboard.box_football.first_downs'), 'first_downs'], ['3rd down', (s) => `${s.third_down_conv}-${s.third_down_att}`], [ts('scoreboard.box_football.turnovers'), 'turnovers'], [ts('scoreboard.box_football.sacks_taken'), 'sacks']],
  tennis: [[ts('scoreboard.box_tennis.aces'), 'aces'], [ts('scoreboard.box_tennis.double_faults'), 'double_faults'], ['1st serve in', (s) => pct(s.first_serve_successful, s.first_serve_attempts)], ['1st serve points won', (s) => pct(s.first_serve_points_won, s.first_serve_successful)], ['2nd serve points won', (s) => pct(s.second_serve_points_won, s.second_serve_attempts)], [ts('scoreboard.box_tennis.break_points_won'), (s) => `${s.breakpoints_won}/${s.total_breakpoints}`], [ts('scoreboard.box_tennis.points_won'), 'points_won'], [ts('scoreboard.box_tennis.games_won'), 'games_won'], [ts('scoreboard.box_tennis.tiebreaks_won'), 'tiebreaks_won']],
  cricket: [[ts('scoreboard.box_cricket.runs'), 'runs'], [ts('scoreboard.box_cricket.wickets_lost'), 'wickets'], [ts('scoreboard.box_cricket.overs'), (s) => ovs(s.balls)], [ts('scoreboard.box_cricket.run_rate'), (s) => (s.balls ? (s.runs / (s.balls / 6)).toFixed(2) : '–')], [ts('scoreboard.box_cricket.fours'), 'fours'], [ts('scoreboard.box_cricket.sixes'), 'sixes'], [ts('scoreboard.box_cricket.extras'), 'extras'], [ts('scoreboard.box_cricket.dot_balls'), 'dots']],
  esports: [[ts('scoreboard.box_esports.maps_won'), 'maps_won'], [ts('scoreboard.box_esports.rounds_won'), 'rounds_won'], [ts('scoreboard.box_esports.pistol_rounds'), 'pistol_rounds_won'], [ts('scoreboard.box_esports.longest_round_streak'), 'max_rounds_in_a_row']],
  hockey: [[ts('scoreboard.box_hockey.shots'), 'shots'], [ts('scoreboard.box_hockey.power_plays'), (s) => `${s.power_play_goals}/${s.power_plays}`], [ts('scoreboard.box_hockey.penalty_minutes'), 'penalty_minutes'], [ts('scoreboard.box_hockey.hits'), 'hits'], [ts('scoreboard.box_hockey.faceoffs_won'), 'faceoffs_won'], [ts('scoreboard.box_hockey.saves'), 'saves']],
};
export function boxScore(ld) {
  const rows = BOX[ld.sport] || [];
  const S = ld.stats || { home: {}, away: {} };
  const val = (f, s, o) => (typeof f === 'function' ? f(s, o) : s[f] ?? 0);
  return `<table class="table sb-box" data-testid="box-score"><thead><tr><th>${esc(ld.sport_label)}</th><th class="num">${monogram(ld.home, 'sm')} ${esc(ld.home.abbr)}</th><th class="num">${monogram(ld.away, 'sm')} ${esc(ld.away.abbr)}</th></tr></thead><tbody>
    ${rows.map(([label, f]) => `<tr data-stat="${esc(typeof f === 'string' ? f : label)}"><td>${esc(label)}</td><td class="num">${esc(val(f, S.home, S.away))}</td><td class="num">${esc(val(f, S.away, S.home))}</td></tr>`).join('')}</tbody></table>`;
}

// ---------- live patcher: one subscription for every page (started from main.js) ----------
function renderPart(n, ld) {
  switch (n.dataset.sbPart) {
    case 'cols': n.innerHTML = sideCols(ld, n.dataset.sbSide); n.classList.toggle('won', isFinal(ld) && ld.details.winner === n.dataset.sbSide); n.classList.toggle('lost', isFinal(ld) && ld.details.winner !== n.dataset.sbSide); break;
    case 'sub': n.innerHTML = subInner(ld); break;
    case 'state': n.innerHTML = stateInner(ld); break;
    case 'lastplay': n.textContent = lastLine(ld); break;
    case 'winbar': n.innerHTML = winBarInner(ld); break;
    case 'evlabel': n.innerHTML = evLabelInner(ld); n.dataset.status = ld.status; break; // event header (Phase 5B)
    default: break;
  }
}
export function applyLive(root, ld) {
  for (const n of root.querySelectorAll(`[data-live-ms="${CSS.escape(ld.milestone_id)}"]`)) renderPart(n, ld);
  for (const c of root.querySelectorAll(`[data-milestone="${CSS.escape(ld.milestone_id)}"]`)) {
    c.classList.toggle('live', ld.status === 'live');
    if (c.dataset.status && c.dataset.status !== ld.status) { c.dataset.status = ld.status; c.classList.remove('scheduled', 'live', 'final'); c.classList.add(ld.status); }
  }
  window.dispatchEvent(new CustomEvent('parlance:live_data', { detail: ld }));
}
let started = false;
export function startLivePatcher(root) {
  if (started) return; started = true;
  let tickerOn = false;
  setInterval(() => { if (!document.hidden) tickClocks(root); }, 250); // running game clocks (Phase 5B)
  socket.subscribe({ channels: ['live_data'] }, (m) => {
    if (m.type !== 'live_data') return;
    if (!tickerOn) { tickerOn = true; subscribeTicker(); } // only once a sports engine is actually running
    applyLive(root, m.msg);
  });
  // Odds pills on sports cards follow the ticker channel (the price is the live win probability, re-quoted).
  const subscribeTicker = () => socket.subscribe({ channels: ['ticker'] }, (m) => {
    if (m.type !== 'ticker') return;
    const t = CSS.escape(m.msg.market_ticker);
    const nodes = root.querySelectorAll(`[data-milestone] .mrow[data-ticker="${t}"] .odds, [data-odds-ticker="${t}"]`);
    if (!nodes.length) return;
    const p = m.msg.last_price_dollars != null ? cents(m.msg.last_price_dollars) : m.msg.yes_bid_dollars != null && m.msg.yes_ask_dollars != null ? Math.round((cents(m.msg.yes_bid_dollars) + cents(m.msg.yes_ask_dollars)) / 2) : null;
    if (p != null) for (const n of nodes) n.textContent = `${p}%`;
  });
  // Polling fallback while the socket is down (5 s, paused while hidden).
  setInterval(async () => {
    if (socket.connected || document.hidden) return;
    const ids = [...new Set([...root.querySelectorAll('[data-live-ms]')].map((n) => n.dataset.liveMs))].slice(0, 100);
    if (!ids.length) return;
    try { const r = await request('GET', `/v1/live_data/batch?milestone_ids=${ids.map(encodeURIComponent).join(',')}`); for (const ld of r.live_datas) applyLive(root, ld); } catch { /* keep polling */ }
  }, 5000);
}
