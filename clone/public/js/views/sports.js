// Sports (SPORTS_SPEC.md §19.6): the /sports hub and /sports/:league pages (league tabs, sport chips, Live now /
// Upcoming / Results), the event-page scoreboard (full board, play-by-play, box score), and the Live page's sports
// sidebar (FEATURED leagues with icons, collapsible sports with counts) and URL filter (?sport= / ?league=).
// Live updates arrive on the `live_data` WebSocket channel; each view falls back to polling while it is down.
import { request } from '../api.js';
import { socket } from '../ws.js';
import { esc } from '../lib.js';
import { sportIcon, gameCard, fullBoard, playsList, playItem, boxScore, SPORT_LABEL } from './scoreboard.js';

const get = (url) => request('GET', url);
const qs = (o) => { const s = new URLSearchParams(Object.entries(o).filter(([, v]) => v)).toString(); return s ? `?${s}` : ''; };

// ======================= /sports and /sports/:league =======================
export async function render({ el, params, query }) {
  const league = (params.league || query.get('league') || '').toUpperCase();
  const sport = (query.get('sport') || '').toLowerCase();
  const nav = await get('/v1/sports/leagues');
  const lg = league ? nav.leagues.find((l) => l.id === league) : null;
  if (league && !lg) { const e = new Error('Unknown league'); e.notFound = true; throw e; }
  if (sport && !SPORT_LABEL[sport]) { const e = new Error('Unknown sport'); e.notFound = true; throw e; }
  const title = lg ? lg.name : sport ? SPORT_LABEL[sport] : 'Sports';
  document.title = `${title} · Parlance`;
  el.innerHTML = `<div class="sports-hub" data-testid="sports-hub" data-league="${esc(league)}" data-sport="${esc(sport)}">
    <div class="sb-hub-head"><div><div class="overline">Live scores</div><h1 class="page-title" data-testid="hub-title">${lg ? sportIcon(lg.sport, 28) + ' ' : ''}${esc(title)}</h1></div>
      <a class="btn btn-pill" href="/live" data-link>Live markets</a></div>
    <nav class="sb-tabs" data-testid="league-tabs" aria-label="Leagues"><a href="/sports" data-link class="${!league && !sport ? 'on' : ''}">${sportIcon('all', 16)}All</a>${nav.leagues.map((l) => `<a href="/sports/${l.id.toLowerCase()}" data-link data-league="${esc(l.id)}" class="${l.id === league ? 'on' : ''}">${sportIcon(l.sport, 16)}${esc(l.short_name)}${l.live_count ? `<span class="sb-tab-live" data-testid="tab-live-count">${l.live_count}</span>` : ''}</a>`).join('')}</nav>
    ${league ? '' : `<div class="chips sb-chips" data-testid="sport-chips"><a class="chip ${!sport ? 'on' : ''}" href="/sports" data-link>All sports</a>${nav.sports.map((s) => `<a class="chip ${s.sport === sport ? 'on' : ''}" href="/sports?sport=${s.sport}" data-link data-sport="${s.sport}">${sportIcon(s.sport, 14)}${esc(s.label)} <span class="n">${s.count}</span></a>`).join('')}</div>`}
    <div id="hub-body"></div></div>`;
  const body = el.querySelector('#hub-body');
  let gen = 0;
  async function draw() {
    const my = ++gen;
    let feed;
    try { feed = await get(`/v1/live_data/feed${qs({ league, sport })}`); } catch (e) { if (my === gen) body.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; return; }
    if (my !== gen || !body.isConnected) return;
    const sec = (key, name, items, empty) => `<section class="sb-section" data-testid="hub-${key}"><h2 class="sb-h">${name} <span class="n">${items.length}</span></h2>
      ${items.length ? `<div class="grid sb-grid">${items.map(gameCard).join('')}</div>` : `<div class="card empty faint">${empty}</div>`}</section>`;
    body.innerHTML = sec('live', 'Live now', feed.live, 'No games are live right now.') + sec('upcoming', 'Upcoming', feed.upcoming, 'Nothing scheduled.') + sec('results', 'Results', feed.results, 'No results yet.');
  }
  await draw();
  // Re-sort when a game changes state (scheduled → live → final); clocks/scores patch in place (scoreboard.js).
  let t = null;
  const onLive = (e) => {
    const card = body.querySelector(`[data-milestone="${CSS.escape(e.detail.milestone_id)}"]`);
    const shown = card ? card.closest('[data-testid^=hub-]')?.dataset.testid : null;
    const want = { live: 'hub-live', scheduled: 'hub-upcoming', final: 'hub-results' }[e.detail.status];
    if (shown && shown !== want) { clearTimeout(t); t = setTimeout(draw, 250); }
  };
  window.addEventListener('parlance:live_data', onLive);
  const iv = setInterval(() => { if (!document.hidden) draw(); }, 30000); // picks up newly scheduled fixtures
  return () => { window.removeEventListener('parlance:live_data', onLive); clearInterval(iv); clearTimeout(t); };
}

// ======================= event page scoreboard =======================
// Mounted by event.js above the chart; renders nothing for events without a linked game.
export function mountEventScoreboard(box, ev) {
  if (!box || !ev.live_data) return () => {};
  let ld = ev.live_data;
  const id = ld.milestone_id;
  let plays = [];
  let tab = 'pbp';
  box.innerHTML = `<section class="card sb-full ${esc(ld.sport)}" data-testid="scoreboard" data-milestone-id="${esc(id)}" aria-label="Scoreboard"><div id="sb-board"></div></section>
    <div class="sb-panel"><div class="seg sb-subtabs" role="tablist"><button data-sbtab="pbp" class="on" data-testid="tab-pbp">Play-by-play</button><button data-sbtab="box" data-testid="tab-box">Box score</button></div><div id="sb-tab"></div></div>`;
  const $ = (s) => box.querySelector(s);
  const drawBoard = () => { $('#sb-board').innerHTML = fullBoard(ld); box.querySelector('.sb-full').dataset.status = ld.status; };
  const drawTab = () => { $('#sb-tab').innerHTML = tab === 'pbp' ? playsList(plays.slice(0, 60), ld) : boxScore(ld); };
  for (const b of box.querySelectorAll('[data-sbtab]')) b.onclick = () => { tab = b.dataset.sbtab; for (const x of box.querySelectorAll('[data-sbtab]')) x.classList.toggle('on', x === b); drawTab(); };
  drawBoard(); drawTab();
  const merge = (fresh) => {
    const top = plays.length ? plays[0].seq : 0;
    const add = fresh.filter((p) => p.seq > top).sort((a, b) => b.seq - a.seq);
    if (!add.length) return;
    plays = [...add, ...plays].slice(0, 200);
    const list = $('[data-testid=pbp]');
    if (tab === 'pbp' && list && plays.length > add.length) { list.insertAdjacentHTML('afterbegin', add.map((p) => playItem(p, ld)).join('')); while (list.children.length > 60) list.lastElementChild.remove(); } else drawTab();
  };
  get(`/v1/milestones/${encodeURIComponent(id)}/plays?limit=80`).then((r) => { plays = []; merge(r.plays); drawTab(); }).catch(() => {});
  const unsub = socket.subscribe({ channels: ['live_data'], milestone_ids: [id] }, (m) => {
    if (m.type !== 'live_data' || m.msg.milestone_id !== id) return;
    ld = m.msg; drawBoard(); merge(m.msg.plays || []);
    if (tab === 'box') drawTab();
  });
  // Polling fallback (5 s) while the socket is down.
  const iv = setInterval(async () => {
    if (socket.connected || document.hidden) return;
    try { const r = await get(`/v1/sports/events/${encodeURIComponent(ev.event_ticker)}`); ld = r.live_data; drawBoard(); merge(r.plays); if (tab === 'box') drawTab(); } catch { /* keep trying */ }
  }, 5000);
  return () => { unsub(); clearInterval(iv); };
}

// Sports category page: show the hidden "Live scores" chip when the sports engine is running.
export function revealSportsLink(root) {
  const a = root.querySelector('[data-testid=sports-hub-link]');
  if (a) get('/v1/sports/leagues').then((r) => { if (r.leagues.length) a.hidden = false; }).catch(() => {});
}

// ======================= Live page (calendar.js) sidebar + filter =======================
const sportsQuery = (query) => ({ league: (query.get('league') || '').toUpperCase(), sport: (query.get('sport') || '').toLowerCase() });
// Keep only events of the chosen league / sport (`/live?league=CPL`, `/calendar?sport=tennis`).
export function applySportsFilter(data, query) {
  const { league, sport } = sportsQuery(query);
  if (!league && !sport) return data;
  const keep = (e) => !!e.live_data && (!league || e.live_data.league.id === league) && (!sport || e.live_data.sport === sport);
  data.sections = data.sections.map((s) => ({ ...s, events: s.events.filter(keep) })).filter((s) => s.events.length);
  return data;
}
// Fills #sports-featured (FEATURED leagues with sport icons) and #sports-tree (collapsible sports with counts).
export async function drawSportsNav(root, query) {
  const fb = root.querySelector('#sports-featured'); const tb = root.querySelector('#sports-tree');
  if (!fb && !tb) return;
  const { league, sport } = sportsQuery(query);
  if (league || sport) root.querySelector('#flash')?.setAttribute('hidden', '');
  let r;
  try { r = await get('/v1/sports/leagues'); } catch { if (fb) fb.innerHTML = '<a href="/category/sports" data-link>Sports</a>'; return; } // sports engine off
  if (!root.isConnected) return;
  const base = location.pathname;
  const n = (x) => (x.live_count ? `<span class="n"><span class="sb-live-n">${x.live_count} live</span></span>` : `<span class="n">${x.count}</span>`);
  if (fb) fb.innerHTML = r.featured.map((l) => `<a href="${base}?league=${l.id}" data-link data-league="${esc(l.id)}" class="sb-feat ${l.id === league ? 'on' : ''}" data-testid="featured-league"><span class="sb-feat-name">${sportIcon(l.sport)}${esc(l.short_name)}</span>${n(l)}</a>`).join('');
  if (tb) {
    tb.innerHTML = `<div class="overline sb-tree-head">Sports</div>${r.sports.map((s) => `<details class="sb-tree" data-sport="${s.sport}" data-testid="sport-group" ${s.sport === sport || s.leagues.some((l) => l.id === league) ? 'open' : ''}>
      <summary><span class="sb-feat-name">${sportIcon(s.sport)}<span data-testid="sport-count">${esc(s.label)} (${s.count})</span></span>${s.live_count ? `<span class="sb-live-n">${s.live_count} live</span>` : ''}</summary>
      <a href="${base}?sport=${s.sport}" data-link class="${s.sport === sport && !league ? 'on' : ''}">All ${esc(s.label)}</a>
      ${s.leagues.map((l) => `<a href="${base}?league=${l.id}" data-link data-league="${esc(l.id)}" class="${l.id === league ? 'on' : ''}"><span>${esc(l.name)}</span>${n(l)}</a>`).join('')}</details>`).join('')}
      ${league || sport ? `<a href="${base}" data-link class="sb-clear" data-testid="sports-clear">Clear sports filter</a>` : ''}<a href="/sports" data-link class="sb-hub-link">All scores ›</a>`;
  }
}
