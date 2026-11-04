'use strict';
// End-to-end browser tests for live sports scoreboards (CLONE_SPEC.md §19): a game reaching the final whistle
// determines its winner markets and pays the holder (DB settlement + notification), the Live page sports sidebar
// and URL filters, compact card scoreboards that match the DB and advance live over the `live_data` WebSocket,
// odds that follow the live win probability, tennis sets/tiebreaks, cricket target and run rates, the event page
// scoreboard with play-by-play and box score, the /sports hub, existing pages unaffected, 390px layout and a
// restart that resumes every game clock from the DB. Real server + SQLite file + Chromium.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-sports-'));
const DB_FILE = path.join(TMP, 'sports.db');
const PORT = 4620 + Math.floor(Math.random() * 40);
const BASE = `http://127.0.0.1:${PORT}`;
const SPEED = 10; // game seconds per real second (tennis and cricket stay live for the whole file)
const OPTS = { port: PORT, dbFile: DB_FILE, tickMs: 250, sports: { speed: SPEED } };
const PW = 'correct-horse-9';
const fan = { email: `fan.${Date.now()}@example.test`, name: 'Sam Supporter' };

let srv; let browser;
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Retry an assertion until it passes (live data keeps moving between a DB read and a DOM read).
async function eventually(fn, { timeout = 15000, interval = 200, msg = 'condition' } = {}) {
  const end = Date.now() + timeout; let last;
  for (;;) {
    try { const v = await fn(); if (v !== false && v !== undefined && v !== null) return v; last = new Error(`${msg}: falsy`); } catch (e) { last = e; }
    if (Date.now() > end) throw new Error(`timed out waiting for ${msg}: ${last && last.message}`);
    await sleep(interval);
  }
}
async function newPage(viewport = { width: 1440, height: 1000 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  return page;
}
async function signUp(page, u) {
  await page.goto(BASE + '/sign-up');
  await page.fill('input[name=display_name]', u.name);
  await page.fill('input[name=email]', u.email);
  await page.fill('input[name=password]', PW);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=account-menu]');
}
const inPage = (page, method, url, body) => page.evaluate(async ([m, u, b]) => {
  const csrf = JSON.parse(localStorage.getItem('csrfToken') || '{}').value;
  const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: b ? JSON.stringify(b) : undefined });
  return { s: r.status, b: await r.json() };
}, [method, url, body]);
const ms = (id) => dbq('SELECT * FROM sports_milestones WHERE id=?', id)[0];
const stateOf = (id) => JSON.parse(ms(id).state_json);
const live = (sport) => dbq("SELECT * FROM sports_milestones WHERE status='live' AND sport=? ORDER BY start_ts", sport);
const eventOf = (id) => dbq('SELECT event_ticker e FROM sports_event_links WHERE milestone_id=?', id)[0].e;
const marketsOf = (id) => dbq('SELECT market_ticker t, outcome FROM sports_markets WHERE milestone_id=? ORDER BY rowid', id);
function evUrl(id) {
  const e = eventOf(id);
  const s = dbq('SELECT s.ticker, s.slug FROM events e JOIN series s ON s.ticker=e.series_ticker WHERE e.ticker=?', e)[0];
  return `/markets/${s.ticker.toLowerCase()}/${s.slug}/${e.toLowerCase()}`;
}
// Game-clock seconds left (team sports with a clock) — tests pick the game that stays live the longest.
function remaining(r) {
  const st = JSON.parse(r.state_json);
  if (r.sport === 'soccer') return 5400 - st.clock;
  return st.quarter > 4 ? st.remain : (4 - st.quarter) * st.qLen + st.remain;
}
const liveOf = (sports) => dbq(`SELECT * FROM sports_milestones WHERE status='live' AND sport IN (${sports.map(() => '?').join(',')})`, ...sports);
const longest = (...sports) => liveOf(sports).sort((a, b) => remaining(b) - remaining(a))[0];
// In play (not at a break) with at least 4 minutes of game clock left in the current period: plays keep coming.
// Sports are tried in the order given (basketball scores far more often than football). Breaks (half-time is
// 10-15 game minutes) produce no plays, so callers wait until some game is actually in play.
const inPlay = (...sports) => sports.map((sp) => liveOf([sp]).filter((r) => { const st = JSON.parse(r.state_json); return st.phase === 'play' && (r.sport === 'soccer' ? 5400 - st.clock > 600 && st.clock !== 2700 : st.remain > 240); })
  .sort((x, y) => remaining(y) - remaining(x))[0]).find(Boolean) || null;
const playing = (...sports) => eventually(() => inPlay(...sports), { timeout: 120000, interval: 500, msg: `a ${sports.join('/')} game in play` });
const BOX_STAT = { basketball: 'reb', football: 'total_yards', soccer: 'shots' };
const liveCountDb = () => dbq("SELECT COUNT(DISTINCT e.ticker) c FROM events e JOIN markets m ON m.event_ticker=e.ticker WHERE e.is_live=1 AND m.status='active'")[0].c;

before(async () => { srv = await start(OPTS); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await srv?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('final whistle: winner markets close and auto-resolve; the holder of the winning side is paid (DB + notification)', async () => {
  // Seeded state: several games live, some upcoming, some recently final — all persisted.
  const counts = Object.fromEntries(dbq('SELECT status, COUNT(*) n FROM sports_milestones GROUP BY status').map((r) => [r.status, r.n]));
  assert.ok(counts.live >= 8 && counts.scheduled >= 8 && counts.final >= 4, JSON.stringify(counts));
  assert.ok(dbq("SELECT COUNT(*) c FROM sports_plays")[0].c > 500, 'persisted play-by-play');
  // The soccer game closest to full-time (seeded at 84').
  const target = live('soccer').map((r) => ({ r, clock: JSON.parse(r.state_json).clock })).filter((x) => x.clock <= 87 * 60).sort((a, b) => b.clock - a.clock)[0].r;
  const mks = marketsOf(target.id);
  assert.deepEqual(mks.map((m) => m.outcome), ['home', 'draw', 'away'], 'three-way soccer market');

  const page = await newPage();
  await signUp(page, fan);
  const uid = dbq('SELECT id FROM users WHERE email=?', fan.email)[0].id;
  assert.equal((await inPage(page, 'POST', `/v1/users/${uid}/deposits`, { amount_dollars: 100 })).s, 201);
  // Buy the home side through the ticket (Dollars mode), the draw and away sides through the API: one of them wins.
  await page.goto(`${BASE}${evUrl(target.id)}?side=yes&market=${mks[0].t}`);
  await page.waitForSelector('[data-testid=scoreboard]');
  await page.waitForSelector('#t-amount');
  await page.fill('#t-amount', '5');
  await page.click('[data-testid=submit-order]'); await page.click('[data-testid=review-confirm]'); // order review step (Phase 5A, A7)
  await page.waitForSelector('.toast:has-text("Filled")');
  for (const m of mks.slice(1)) {
    const r = await inPage(page, 'POST', `/v1/users/${uid}/orders`, { ticker: m.t, side: 'yes', type: 'dollars', amount_dollars: 5 });
    assert.equal(r.s, 201, JSON.stringify(r.b));
  }
  const held = Object.fromEntries(dbq(`SELECT market_ticker t, yes_count c FROM positions WHERE user_id=? AND market_ticker IN (${mks.map(() => '?').join(',')})`, uid, ...mks.map((m) => m.t)).map((r) => [r.t, r.c]));
  for (const m of mks) assert.ok(held[m.t] > 0, `holds ${m.t}`);

  // Full-time arrives live (no reload): status, winner banner, final play.
  await eventually(() => ms(target.id).status === 'final', { timeout: 150000, interval: 500, msg: 'final whistle' });
  const fin = ms(target.id);
  assert.ok(['home', 'away', 'draw'].includes(fin.winner));
  await page.waitForSelector('[data-testid=sb-status]:has-text("Final")', { timeout: 10000 });
  await page.waitForSelector('[data-testid=sb-winner]');
  assert.match(await page.textContent('[data-testid=sb-winner]'), fin.winner === 'draw' ? /Draw/ : /won/);
  assert.equal(dbq("SELECT COUNT(*) c FROM sports_plays WHERE milestone_id=? AND kind='final'", target.id)[0].c, 1);
  const ev = dbq('SELECT is_live, live_label FROM events WHERE ticker=?', eventOf(target.id))[0];
  assert.equal(ev.is_live, 0); assert.match(ev.live_label, /^Final/);

  // Markets determined through the normal path, then finalized after the settlement timer.
  const winT = mks.find((m) => m.outcome === fin.winner).t;
  await eventually(() => dbq(`SELECT COUNT(*) c FROM markets WHERE status='finalized' AND ticker IN (${mks.map(() => '?').join(',')})`, ...mks.map((m) => m.t))[0].c === 3, { timeout: 20000, msg: 'finalized' });
  for (const m of mks) assert.equal(dbq('SELECT result FROM markets WHERE ticker=?', m.t)[0].result, m.t === winT ? 'yes' : 'no');
  const st = dbq('SELECT * FROM settlements WHERE user_id=? AND market_ticker=?', uid, winT)[0];
  assert.ok(st, 'settlement row for the winning market');
  assert.equal(st.result, 'yes'); assert.equal(st.payout_cents, held[winT]); // units of a contract pay one cent each
  for (const m of mks.filter((x) => x.t !== winT)) assert.equal(dbq('SELECT payout_cents p FROM settlements WHERE user_id=? AND market_ticker=?', uid, m.t)[0].p, 0);
  assert.ok(dbq("SELECT COUNT(*) c FROM ledger WHERE user_id=? AND kind='settlement' AND ref=? AND amount_cents=?", uid, winT, held[winT])[0].c === 1);
  assert.ok(dbq("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='settlement' AND title LIKE 'Market settled YES%'", uid)[0].c >= 1);
  await page.waitForSelector('[data-testid=ticket-closed]');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('Live page: FEATURED leagues + collapsible sports with counts, live cards with DB-matching compact scoreboards, URL filters', async () => {
  const page = await newPage();
  const loadedAt = Date.now();
  await page.goto(BASE + '/live');
  await page.waitForSelector('[data-testid=featured-league]');
  const feat = await page.$$eval('[data-testid=featured-league]', (els) => els.map((e) => ({ id: e.dataset.league, icon: !!e.querySelector('svg.sb-icon'), text: e.textContent })));
  assert.deepEqual(feat.map((f) => f.id), ['GPL', 'CGA', 'CHL', 'CHW', 'CPL']);
  assert.ok(feat.every((f) => f.icon), 'sport icons');
  const groups = await page.$$eval('[data-testid=sport-group]', (els) => els.map((e) => ({ sport: e.dataset.sport, text: e.querySelector('[data-testid=sport-count]').textContent, open: e.open })));
  assert.equal(groups.length, 7); // six sports + ice hockey (Phase 5B, PLAN G9)
  for (const g of groups) {
    const n = dbq("SELECT COUNT(*) c FROM sports_milestones WHERE sport=? AND status IN ('live','scheduled')", g.sport)[0].c;
    assert.match(g.text, new RegExp(`\\(${n}\\)$`), `${g.sport} count`);
    assert.equal(g.open, false);
  }
  // Every live game is a live card with a red LIVE marker, competition subtitle and a tinted border.
  for (const r of dbq("SELECT id, competition FROM sports_milestones WHERE status='live' AND started_ts<?", loadedAt - 1000)) {
    const card = page.locator(`[data-testid=cal-section][data-live=true] [data-testid=event-card][data-milestone="${r.id}"]`);
    await card.waitFor();
    assert.ok(await card.evaluate((e) => e.classList.contains('live')));
    assert.match(await card.locator('[data-testid=sb-sub]').textContent(), new RegExp(`Live${r.competition.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }
  // Compact scoreboard values equal the DB scores (soccer and basketball cards).
  for (const sport of ['soccer', 'basketball']) {
    const g = longest(sport);
    await eventually(async () => {
      const dom = await page.$$eval(`[data-milestone="${g.id}"] [data-testid=sb-cols]`, (els) => els.map((e) => ({ side: e.dataset.sbSide, v: Number(e.querySelector('[data-testid=sb-score]').textContent) })));
      const row = ms(g.id);
      assert.deepEqual(dom, [{ side: 'home', v: row.home_score }, { side: 'away', v: row.away_score }]);
      return true;
    }, { msg: `${sport} card matches DB` });
  }
  // Header live count matches the DB (events live with an open market).
  await eventually(async () => (await page.textContent('#live-count')) === String(liveCountDb()), { timeout: 35000, msg: 'live count' });
  // Featured league filter is URL-addressable.
  await page.click('[data-testid=featured-league][data-league=CPL]');
  await page.waitForURL(/\/live\?league=CPL$/);
  await page.waitForSelector('[data-testid=featured-league].on[data-league=CPL]');
  const evs = await page.$$eval('[data-testid=event-card]', (els) => els.map((e) => e.dataset.event));
  assert.ok(evs.length >= 1 && evs.every((e) => e.startsWith('PLXCPL-')), evs.join());
  assert.equal(await page.isVisible('[data-testid=flash-card]'), false);
  // Collapsible sport group → league link.
  await page.click('[data-testid=sport-group][data-sport=tennis] summary');
  await page.click('[data-testid=sport-group][data-sport=tennis] a[data-league=LHO]');
  await page.waitForURL(/league=LHO$/);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=event-card]')].every((c) => c.dataset.event.startsWith('PLXLHO-')) && document.querySelectorAll('[data-testid=event-card]').length > 0);
  await page.goto(BASE + '/calendar?sport=cricket');
  await page.waitForSelector('[data-testid=event-card]');
  assert.ok((await page.$$eval('[data-testid=event-card]', (els) => els.map((e) => e.dataset.event))).every((e) => e.startsWith('PLXHTB-')));
  assert.ok(await page.isVisible('[data-testid=sport-group][data-sport=cricket][open]'));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('clock and score advance live without a reload; odds follow the live win probability', async () => {
  const page = await newPage();
  const g = await playing('basketball', 'football');
  await page.goto(BASE + '/live');
  const card = `[data-milestone="${g.id}"]`;
  await page.waitForSelector(`${card} [data-testid=sb-sub]`);
  await page.evaluate(() => { window.__noReload = true; });
  const sub0 = await page.textContent(`${card} [data-testid=sb-sub]`);
  const score = async () => (await page.$$eval(`${card} [data-testid=sb-score]`, (els) => els.map((e) => Number(e.textContent)))).reduce((a, b) => a + b, 0);
  const s0 = await score();
  await page.waitForFunction(([sel, t]) => document.querySelector(sel).textContent !== t, [`${card} [data-testid=sb-sub]`, sub0], { timeout: 10000 });
  await eventually(async () => (await score()) > s0, { timeout: 60000, msg: 'score advances' });
  assert.equal(await page.evaluate(() => window.__noReload), true, 'no reload');
  assert.ok(stateOf(g.id).t > 0);

  // Event page: the YES price of the home market tracks the DB win probability as a competitive game moves.
  const ORDER = ['basketball', 'tennis', 'esports', 'cricket', 'football', 'soccer'];
  const close = await eventually(() => liveOf(ORDER).filter((r) => { const st = JSON.parse(r.state_json); return st.phase === 'play' && r.win_home > 0.12 && r.win_home < 0.88; })
    .sort((x, y) => ORDER.indexOf(x.sport) - ORDER.indexOf(y.sport))[0], { timeout: 60000, msg: 'a competitive game' });
  const home = marketsOf(close.id).find((m) => m.outcome === 'home').t;
  await page.goto(BASE + evUrl(close.id));
  const probSel = `[data-testid="prob-${home}"]`;
  await page.waitForSelector(probSel);
  const p0 = await page.textContent(probSel);
  await page.waitForFunction(([s, v]) => document.querySelector(s).textContent !== v, [probSel, p0], { timeout: 60000 });
  await eventually(async () => {
    const shown = Number((await page.textContent(probSel)).replace('%', ''));
    const wp = Math.min(98, Math.max(2, Math.round(ms(close.id).win_home * 100)));
    assert.ok(Math.abs(shown - wp) <= 3, `shown ${shown} vs win probability ${wp}`);
    return true;
  }, { msg: 'odds near win probability' });
  const q = dbq('SELECT quoted_cents q FROM sports_markets WHERE market_ticker=?', home)[0].q;
  assert.equal(dbq('SELECT yes_price_cents p FROM trades WHERE market_ticker=? ORDER BY created_ts DESC, rowid DESC LIMIT 1', home)[0].p, q, 'reference print at the quoted fair price');
  assert.ok(dbq("SELECT COUNT(*) c FROM orders WHERE market_ticker=? AND status='resting' AND source='liquidity'", home)[0].c >= 2, 'liquidity re-quoted around fair');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('tennis sets with tiebreak + serve + game points; cricket target, run rate and required rate', async () => {
  const page = await newPage();
  const t = live('tennis')[0];
  await page.goto(BASE + evUrl(t.id));
  await page.waitForSelector('[data-testid=sb-tennis]');
  await eventually(async () => {
    const st = stateOf(t.id);
    const rows = await page.$$eval('[data-testid=sb-tennis] tbody tr', (trs) => trs.map((tr) => ({ side: tr.dataset.side, sets: [...tr.querySelectorAll('[data-testid=sb-set]')].map((c) => ({ g: Number(c.childNodes[0].textContent), tb: c.querySelector('sup') ? Number(c.querySelector('sup').dataset.tb) : null })), pts: tr.querySelector('[data-testid=sb-pts]')?.textContent })));
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.deepEqual(r.sets.map((s) => s.g), st.sets.map((s) => s[r.side]), 'games per set');
      assert.deepEqual(r.sets.map((s) => s.tb), st.sets.map((s) => (s.tb ? s.tb[r.side] : null)), 'tiebreak points');
      assert.match(r.pts, st.tb ? /^\d+$/ : /^(0|15|30|40|A)$/);
    }
    assert.ok(st.sets[0].tb, 'seeded match had a first-set tiebreak');
    return true;
  }, { msg: 'tennis board matches DB' });
  assert.equal(await page.locator('[data-testid=sb-tennis] [data-testid=sb-serve]').count(), 1, 'one serve dot');
  await page.click('[data-testid=tab-box]');
  await page.waitForSelector('[data-testid=box-score] tr[data-stat=aces]');
  // Card on the Live page shows the per-set columns with the tiebreak superscript and current points.
  await page.goto(BASE + '/live?league=LHO');
  await page.waitForSelector(`[data-milestone="${t.id}"] [data-testid=sb-cols] sup[data-tb]`);
  assert.equal(await page.locator(`[data-milestone="${t.id}"] [data-testid=sb-pts]`).count(), 2);

  const c = live('cricket')[0];
  await page.goto(BASE + evUrl(c.id));
  await page.waitForSelector('[data-testid=sb-target]');
  await eventually(async () => {
    const st = stateOf(c.id); const I = st.stats[st.batting];
    assert.equal(st.innings, 2);
    assert.equal(await page.textContent('[data-testid=sb-target]'), `Target ${st.target}`);
    assert.equal(await page.textContent('[data-testid=sb-crr]'), `CRR ${(I.runs / (I.balls / 6)).toFixed(2)}`);
    assert.equal(await page.textContent('[data-testid=sb-rrr]'), `RRR ${((st.target - I.runs) / ((120 - I.balls) / 6)).toFixed(2)}`);
    assert.equal(await page.textContent(`[data-testid=sb-runs-${st.batting}]`), `${I.runs}/${I.wickets}`);
    assert.match(await page.textContent('[data-testid=sb-comment]'), new RegExp(`need ${st.target - I.runs} runs? from ${120 - I.balls} balls?`));
    return true;
  }, { msg: 'cricket board matches DB' });
  const api = await (await fetch(`${BASE}/v1/live_data/cricket_match/milestone/${c.id}`)).json();
  for (const k of ['home_score', 'away_score', 'home_total_runs', 'home_wickets', 'home_overs', 'allotted_overs', 'current_inning', 'batting', 'last_play', 'home_win_probability', 'status', 'winner', 'side_orientation', 'widget_status']) assert.ok(k in api.live_data.details, `cricket detail ${k}`);
  const tapi = await (await fetch(`${BASE}/v1/live_data/batch?milestone_ids=${t.id},${c.id}`)).json();
  assert.equal(tapi.live_datas.length, 2);
  for (const k of ['competitor1_overall_score', 'competitor1_round_scores', 'competitor1_current_round_score', 'advantage', 'competitor1_is_home', 'competitor1_statistics']) assert.ok(k in tapi.live_datas[0].details, `tennis detail ${k}`);
  assert.equal((await fetch(`${BASE}/v1/live_data/esports_match/milestone/${c.id}`)).status, 404);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('event page: full scoreboard above the chart, live play-by-play, box score from the DB stats', async () => {
  const page = await newPage();
  const g = await playing('basketball', 'football');
  const STAT = BOX_STAT[g.sport];
  await page.goto(BASE + evUrl(g.id));
  await page.waitForSelector('[data-testid=scoreboard] [data-testid=sb-score-home]');
  const [sb, chart] = await Promise.all([page.locator('[data-testid=scoreboard]').boundingBox(), page.locator('.chart-box').boundingBox()]);
  assert.ok(sb.y < chart.y, 'scoreboard above the chart');
  await eventually(async () => {
    const row = ms(g.id);
    assert.equal(Number(await page.textContent('[data-testid=sb-score-home]')), row.home_score);
    assert.equal(Number(await page.textContent('[data-testid=sb-score-away]')), row.away_score);
    return true;
  }, { msg: 'scoreboard matches DB' });
  await page.waitForSelector('[data-testid=line-score]');
  // Play-by-play: newest first, from the DB, and new plays stream in without a reload.
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=pbp-item]').length >= 10);
  const top = async () => Number(await page.getAttribute('[data-testid=pbp-item]:first-child', 'data-seq'));
  const seq0 = await top();
  await eventually(async () => (await top()) > seq0, { timeout: 45000, msg: 'new plays arrive' });
  const seqNow = await top();
  const dbPlay = dbq('SELECT text FROM sports_plays WHERE milestone_id=? AND seq=?', g.id, seqNow)[0];
  assert.ok(dbPlay, 'play persisted');
  assert.equal(await page.textContent(`[data-testid=pbp-item][data-seq="${seqNow}"] .sb-pbp-text`), dbPlay.text);
  // Box score tab: totals equal the persisted stats (rebounds / total yards).
  await page.click('[data-testid=tab-box]');
  await page.waitForSelector('[data-testid=box-score]');
  await eventually(async () => {
    const stat = Object.fromEntries(dbq('SELECT side, value FROM sports_stats WHERE milestone_id=? AND stat=?', g.id, STAT).map((r) => [r.side, r.value]));
    const cells = await page.$$eval(`[data-testid=box-score] tr[data-stat=${STAT}] td.num`, (tds) => tds.map((td) => Number(td.textContent)));
    assert.deepEqual(cells, [stat.home, stat.away]);
    return true;
  }, { msg: 'box score matches DB' });
  // A non-sports event has no scoreboard.
  await page.goto(BASE + '/markets/plxstate/harbor-state-elections/plxstate-26sen');
  await page.waitForSelector('[data-testid=event-title]');
  assert.equal(await page.locator('[data-testid=scoreboard]').count(), 0);
  const gs = await (await fetch(`${BASE}/v1/live_data/milestone/${g.id}/game_stats`)).json();
  assert.ok(Object.keys(gs.stats.home).length >= 7 && gs.stats.home[STAT] >= 0 && gs.periods.home.length >= 2);
  const m = await (await fetch(`${BASE}/v1/milestones?related_event_ticker=${eventOf(g.id)}`)).json();
  assert.equal(m.milestones[0].id, g.id); assert.deepEqual(m.milestones[0].related_event_tickers, [eventOf(g.id)]);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('/sports hub: MORE menu + Sports category links, league tabs, sport chips, live / upcoming / results', async () => {
  const page = await newPage();
  await page.goto(BASE + '/');
  await page.click('#more-btn');
  await page.click('[data-testid=more-sports]');
  await page.waitForURL(BASE + '/sports');
  await page.waitForSelector('[data-testid=hub-live] [data-testid=game-card]');
  const n = (st) => dbq('SELECT COUNT(*) c FROM sports_milestones WHERE status=?', st)[0].c;
  await eventually(async () => {
    const want = [n('live'), Math.min(24, n('scheduled')), Math.min(12, n('final'))];
    const got = [];
    for (const k of ['live', 'upcoming', 'results']) got.push(await page.locator(`[data-testid=hub-${k}] [data-testid=game-card]`).count());
    if (JSON.stringify(got) === JSON.stringify(want)) return true;
    await page.reload(); await page.waitForSelector('[data-testid=hub-live] [data-testid=game-card]'); // a fixture was added meanwhile
    return false;
  }, { msg: 'hub sections match the DB' });
  assert.ok(await page.locator('[data-testid=hub-live] [data-testid=win-bar]').first().isVisible());
  await page.click('[data-testid=league-tabs] a[data-league=CHL]');
  await page.waitForURL(BASE + '/sports/chl');
  await page.waitForSelector('[data-testid=hub-title]:has-text("Coast Hoops League")');
  await page.waitForSelector('[data-testid=game-card]');
  assert.ok((await page.$$eval('[data-testid=game-card]', (els) => els.map((e) => e.dataset.league))).every((l) => l === 'CHL'));
  await page.goto(BASE + '/sports?sport=tennis');
  await page.waitForSelector('[data-testid=game-card]');
  assert.ok((await page.$$eval('[data-testid=game-card]', (els) => els.map((e) => e.dataset.sport))).every((s) => s === 'tennis'));
  // A result card shows the final state.
  await page.waitForSelector('[data-testid=hub-results] [data-testid=game-card][data-status=final]');
  await page.goto(BASE + '/sports/nope');
  await page.waitForSelector('[data-testid=page-error]');
  await page.goto(BASE + '/category/sports');
  await page.waitForSelector('[data-testid=sports-hub-link]:not([hidden])');
  assert.ok((await page.$$eval('[data-testid=subcategories] a', (els) => els.map((e) => e.textContent))).includes('Soccer'));
  await page.click('[data-testid=sports-hub-link]');
  await page.waitForURL(BASE + '/sports');
  assert.equal(page.errors.filter((e) => !/Unknown league/.test(e)).length, 0, page.errors.join('\n'));
  await page.context().close();
});

test('existing pages unaffected, 390px without horizontal overflow, and a restart resumes every clock from the DB', async () => {
  const page = await newPage();
  await page.goto(BASE + '/');
  await page.waitForSelector('[data-testid=hero-title]');
  await page.goto(BASE + '/calendar?category=Elections');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=event-card]').length === 2 && [...document.querySelectorAll('[data-testid=event-card]')].every((c) => /PLXSTATE/.test(c.dataset.event)));
  await page.goto(BASE + '/live');
  await page.waitForSelector('[data-testid=flash-card]');
  await page.waitForSelector('[data-testid=event-card][data-event="PLXCUP-26FINAL"]');
  assert.equal(await page.locator('[data-testid=event-card][data-event="PLXCUP-26FINAL"] [data-testid=sb-cols]').count(), 0, 'non-game event keeps the plain card');
  await page.context().close();

  const mobile = await newPage({ width: 390, height: 844 });
  const pick = (sport) => evUrl((live(sport)[0] || dbq('SELECT id FROM sports_milestones WHERE sport=? ORDER BY start_ts DESC', sport)[0]).id);
  for (const p of ['/live', '/calendar', '/sports', '/sports/lho', '/category/sports', pick('tennis'), pick('cricket'), pick('basketball'), pick('football'), pick('soccer'), pick('esports')]) {
    await mobile.goto(BASE + p);
    await mobile.waitForSelector('main *');
    await mobile.waitForTimeout(500);
    const over = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(over <= 0, `${p} overflows by ${over}px`);
  }
  assert.deepEqual(mobile.errors, []);
  await mobile.context().close();

  // Restart: clocks, scores and plays resume from the persisted state (no reseed, no catch-up jump).
  const before = Object.fromEntries(dbq("SELECT id FROM sports_milestones WHERE status='live'").map((r) => [r.id, null]));
  const total = dbq('SELECT COUNT(*) c FROM sports_milestones')[0].c;
  await srv.close();
  for (const id of Object.keys(before)) { const r = ms(id); before[id] = { t: JSON.parse(r.state_json).t, seq: r.play_seq, h: r.home_score, a: r.away_score }; }
  await sleep(3000); // downtime: the games must not "catch up" these 60 game seconds
  for (const id of Object.keys(before)) assert.equal(JSON.parse(ms(id).state_json).t, before[id].t, 'nothing runs while stopped');
  const t0 = Date.now();
  srv = await start(OPTS);
  await sleep(1500);
  const elapsed = (Date.now() - t0) / 1000;
  assert.ok(dbq('SELECT COUNT(*) c FROM sports_milestones')[0].c >= total, 'no reseed');
  let advanced = 0;
  for (const [id, b] of Object.entries(before)) {
    const r = ms(id); const t = JSON.parse(r.state_json).t;
    assert.ok(t >= b.t, 'clock never goes back');
    assert.ok(t - b.t <= elapsed * SPEED + 1, `resumed, not caught up: +${(t - b.t).toFixed(1)}s in ${elapsed.toFixed(1)}s`);
    assert.ok(r.play_seq >= b.seq && r.home_score >= b.h && r.away_score >= b.a);
    if (t > b.t) advanced += 1;
  }
  assert.ok(advanced >= 1, 'clocks run again after the restart');
  const page2 = await newPage();
  const g = await playing('basketball', 'football', 'soccer');
  await page2.goto(BASE + evUrl(g.id));
  await page2.waitForSelector('[data-testid=scoreboard] [data-testid=sb-status]');
  const s1 = await page2.textContent('[data-testid=sb-status]');
  await page2.waitForFunction((s) => document.querySelector('[data-testid=sb-status]').textContent !== s, s1, { timeout: 15000 });
  assert.deepEqual(page2.errors, []);
  await page2.context().close();
});
