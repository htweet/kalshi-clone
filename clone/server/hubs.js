'use strict';
// Hub data widgets (Phase 5B, PLAN A15; CLONE_SPEC.md §13.19 observed `/api-app/midterms/senate-map`,
// `/api-app/fed-funds/outlook` and `GET /v1/series/{s}/events/{e}/forecast_history`; §29.8 design):
//   • Senate map: an invented 12-state tile grid (server/civic-data.js) driven by the platform's own Senate-race
//     markets — lean per state, expected and projected seats, and the expected-seat history.
//   • Fed funds outlook: the central-bank decision markets (series PLXRATE, outcomes Cut / Hold / Hike) turned into an
//     implied change per meeting (±25 bp steps) and an implied rate path from an invented current rate.
//   • Event forecast history: hourly implied outcome probabilities of one event (normalised for mutually exclusive
//     events), plus the implied rate change for central-bank events.
// `seedHubs` (on for `npm start`, off for programmatic test servers unless asked) adds invented demo data: seven more
// Senate races, two more central-bank meetings, a daily temperature family (for the calendar `event_limits` cap), news
// items and two incentive programs. All of it is invented.
const CS = require('./content/currency-strings'); // keyed user-facing wording (CLONE_SPEC.md §30)
const C = require('./currency'); // display currency formatting (CLONE_SPEC.md §30)
const { tx } = require('./db');
const { newId, nowIso, dollars, E, slugify, UNITS } = require('./util');
const { STATES } = require('./civic-data');

const H = 3600 * 1000; const D = 24 * H;
const CURRENT_RATE_BPS = { lower: 425, upper: 450 }; // invented current target range 4.25%–4.50%
const RATE_SERIES = 'PLXRATE';
const SEED_KEY = 'hubs_seed_v1';
const CHAMBER = STATES.length * 2;

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function mountHubs({ v1, db, engine, eventFull, getEvent, incentives, options = {} }) {
  const lp = () => db.prepare("SELECT id FROM users WHERE email='liquidity@parlance.local'").get()?.id;
  const q = (t) => engine.quote(t);
  const priceOf = (t) => { const x = q(t); return x.last_price ?? (x.yes_bid != null && x.yes_ask != null ? (x.yes_bid + x.yes_ask) / 2 : null); };

  // ------------------------------------------------------------------ demo seed (invented)
  function addSeries(ticker, title, category, tags, frequency) {
    if (db.prepare('SELECT 1 FROM series WHERE ticker=?').get(ticker)) return;
    db.prepare('INSERT INTO series(ticker,title,slug,category,tags,frequency,fee_type,fee_multiplier,settlement_sources,rules) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(ticker, title, slugify(title), category, JSON.stringify(tags), frequency, 'quadratic', 1, JSON.stringify([{ name: 'Parlance Resolution Desk', url: 'https://example.org/resolution' }]),
        CS.t('rules.series_contract_pays', { series: title, value: C.contractValue(), zero: C.moneyCents(0) }));
  }
  function addEvent(series, category, ev, r, now) {
    if (db.prepare('SELECT 1 FROM events WHERE ticker=?').get(ev.e)) return;
    db.prepare('INSERT INTO events(ticker,series_ticker,title,sub_title,category,mutually_exclusive,is_live,live_label,news,featured,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(ev.e, series, ev.title, ev.sub || '', category, ev.mutually ? 1 : 0, 0, '', '', 0, new Date(now - 20 * D).toISOString());
    for (const m of ev.markets) {
      const close = ev.close;
      db.prepare('INSERT INTO markets(ticker,event_ticker,title,yes_sub_title,no_sub_title,color,status,open_time,close_time,expected_expiration_time,settlement_timer_seconds,rules_primary,created_at,updated_at,fractional_trading_enabled) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)')
        .run(m.t, ev.e, ev.markets.length > 1 ? `${ev.title} — ${m.yes}` : ev.title, m.yes, m.no || `Not ${m.yes}`, m.color || '#5b5bd6', 'active', new Date(now - 14 * D).toISOString(), new Date(close).toISOString(), new Date(close + H).toISOString(), 5,
          `If "${m.yes}" is confirmed by the settlement source, this market resolves YES. Otherwise it resolves NO.`, nowIso(), nowIso());
      let p = m.fair; const path = [];
      for (let i = 0; i < 168; i++) { path.unshift(p); p = Math.max(2, Math.min(98, p + Math.round((r() - 0.5) * 6))); }
      path.forEach((price, i) => db.prepare('INSERT INTO trades(id,market_ticker,yes_price_cents,count,taker_side,created_ts) VALUES(?,?,?,?,?,?)')
        .run(newId('t_'), m.t, price, (5 + Math.floor(r() * 300)) * UNITS, r() > 0.5 ? 'yes' : 'no', Math.min(now - 1, now - (168 - i) * H + Math.floor(r() * 50 * 60000))));
    }
  }
  function addLiquidity(markets) {
    const id = lp(); if (!id) return;
    for (const m of markets) for (let lvl = 1; lvl <= 2; lvl++) {
      for (const [side, price] of [['yes', m.fair - lvl], ['no', 100 - (m.fair + lvl)]]) {
        if (price < 1 || price > 99) continue;
        try { engine.placeOrder(id, { ticker: m.t, side, price, count: (60 * lvl) * UNITS, source: 'liquidity' }); } catch (e) { if (process.env.SPORTS_DEBUG) console.error('hub liquidity', m.t, e.message); }
      }
    }
  }
  function seed() {
    const now = Date.now(); const r = rng(20261103);
    const created = [];
    tx(db, () => {
      addSeries('PLXSENATE', '2026 Senate races', 'Elections', ['Senate'], 'one_off');
      STATES.filter((s) => s.senate && s.senate.startsWith('PLXSENATE')).forEach((s, i) => {
        const blue = [62, 38, 55, 47, 71, 33, 52][i % 7];
        const ev = { e: s.senate, title: `${s.name} Senate seat`, sub: 'Which party wins?', mutually: 1, close: now + (20 + i) * D,
          markets: [{ t: `${s.senate}-BLUE`, yes: 'Blue Party', fair: blue, color: '#1c7ed6' }, { t: `${s.senate}-RED`, yes: 'Red Party', fair: 100 - blue, color: '#e03131' }] };
        addEvent('PLXSENATE', 'Elections', ev, r, now); created.push(...ev.markets);
      });
      if (db.prepare('SELECT 1 FROM series WHERE ticker=?').get(RATE_SERIES)) {
        for (const [e, title, close, cut, hold] of [['PLXRATE-27JAN', 'Central bank decision in January', now + 70 * D, 41, 52], ['PLXRATE-27MAR', 'Central bank decision in March', now + 125 * D, 47, 44]]) {
          const ev = { e, title, sub: 'Policy meeting', mutually: 1, close,
            markets: [{ t: `${e}-CUT`, yes: 'Cut', fair: cut, color: '#1971c2' }, { t: `${e}-HOLD`, yes: 'Hold', fair: hold, color: '#868e96' }, { t: `${e}-HIKE`, yes: 'Hike', fair: 100 - cut - hold, color: '#e03131' }] };
          addEvent(RATE_SERIES, 'Economics', ev, r, now); created.push(...ev.markets);
        }
      }
      addSeries('PLXTEMP', 'Daily high temperature', 'Climate and Weather', ['Temperature'], 'daily');
      // News items for the AI summaries (invented outlets and copy).
      const news = [
        ['PLXRATE-26DEC', 'Harbor Ledger', 6, 'Inflation cools for a third month', 'Consumer prices rose 0.1% last month, the third soft reading in a row. Several policymakers said a December cut is on the table.'],
        ['PLXRATE-26DEC', 'Coastline Wire', 3, 'Jobs report beats forecasts', 'Employers added more jobs than expected in October. Analysts said the strong report makes a December cut less certain.'],
        ['PLXRATE-26DEC', 'Parlance Newsroom', 1, 'Markets split on December decision', 'Traders now see a December cut as slightly more likely than a hold. The central bank meets on December 17.'],
        ['PLXSTATE-26GOV', 'Harbor Gazette', 4, 'Alvarez leads in new poll', 'A new statewide poll shows Rosa Alvarez ahead of Martin Huang by four points. The margin is within the poll\'s error.'],
        ['PLXSTATE-26GOV', 'Coastline Wire', 2, 'Huang outraises Alvarez in October', 'Martin Huang reported raising more money than Rosa Alvarez in October. Both campaigns plan a final week of rallies.'],
      ];
      for (const [et, source, daysAgo, headline, summary] of news) {
        if (!getEvent(et) || db.prepare('SELECT 1 FROM cms_news WHERE event_ticker=? AND headline=?').get(et, headline)) continue;
        db.prepare('INSERT INTO cms_news(id,event_ticker,source,published_at,headline,summary,position,active,created_at,updated_at) VALUES(?,?,?,?,?,?,0,1,?,?)').run(newId('new_'), et, source, new Date(now - daysAgo * D).toISOString(), headline, summary, nowIso(), nowIso());
      }
      db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(SEED_KEY, nowIso());
    });
    addLiquidity(created);
    if (incentives && getEvent('PLXRATE-26DEC')) {
      incentives.createProgram({ event_ticker: 'PLXRATE-26DEC', title: 'Central bank decision in December', start_ts: now - D, end_ts: now + 30 * D, reward_pool_cents: 500_00, competition: 'auto', target_size_units: 200 * UNITS });
      if (getEvent('PLXSTATE-26SEN')) incentives.createProgram({ event_ticker: 'PLXSTATE-26SEN', title: 'Harbor State senate seat', start_ts: now + 3 * D, end_ts: now + 24 * D, reward_pool_cents: 250_00, competition: 'low', payout_mode: 'credits' });
    }
  }
  // A daily family: five invented cities, one "high above X°F" market each, closing at the end of the UTC day.
  function ensureTemperatureDay(now = Date.now()) {
    if (!db.prepare('SELECT 1 FROM series WHERE ticker=?').get('PLXTEMP')) return;
    const end = new Date(now); end.setUTCHours(23, 59, 0, 0);
    let close = end.getTime(); if (close - now < 2 * H) close += D;
    const d = new Date(close); const stamp = `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    const r = rng(Number(stamp));
    const made = [];
    tx(db, () => {
      for (const [code, city, f] of [['HBR', 'Harbor City', 58], ['SVW', 'Seaview', 61], ['RGC', 'Ridge Crossing', 49], ['PCR', 'Pinecrest', 44], ['CWT', 'Coldwater', 39]]) {
        const e = `PLXTEMP-${stamp}-${code}`;
        if (getEvent(e)) continue;
        const fair = 35 + Math.floor(r() * 30);
        const ev = { e, title: `${city} high above ${f}°F today?`, sub: `Daily high · ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`, close, markets: [{ t: e, yes: `Above ${f}°F`, no: `${f}°F or below`, fair }] };
        addEvent('PLXTEMP', 'Climate and Weather', ev, r, now); made.push(...ev.markets);
      }
    });
    addLiquidity(made);
  }
  if (options.seedHubs) {
    if (!db.prepare('SELECT 1 FROM meta WHERE key=?').get(SEED_KEY)) seed();
    ensureTemperatureDay();
    let lastDay = 0;
    engine.on('tick', () => { const now = Date.now(); if (now - lastDay > 10 * 60000) { lastDay = now; try { ensureTemperatureDay(now); } catch (e) { console.error('hubs', e); } } });
  }

  // ------------------------------------------------------------------ Senate map
  const outcomeOf = (ev, re) => ev.markets.find((m) => re.test(m.yes_sub_title));
  const lean = (p) => (p >= 0.8 ? 'safe_blue' : p >= 0.6 ? 'lean_blue' : p > 0.4 ? 'tossup' : p > 0.2 ? 'lean_red' : 'safe_red');
  function raceOf(s) {
    const e = s.senate && getEvent(s.senate);
    if (!e) return null;
    const ev = eventFull(e);
    const b = outcomeOf(ev, /blue/i); const r = outcomeOf(ev, /red/i);
    if (!b || !r || !ev.markets.some((m) => m.status === 'active')) return null;
    const pb = priceOf(b.ticker); const pr = priceOf(r.ticker);
    if (pb == null || pr == null || pb + pr <= 0) return null;
    return { ev, blue: b, red: r, p: pb / (pb + pr) };
  }
  // Expected Blue seats per hour over `days`, from each race's last trade at that time (normalised Blue/Red).
  function seatHistory(races, days = 7) {
    const now = Date.now(); const from = now - days * D; const step = H;
    const base = STATES.reduce((a, s) => a + s.seated.blue, 0);
    const series = races.map((x) => ({ x, b: tradesOf(x.blue.ticker, from), r: tradesOf(x.red.ticker, from) }));
    const pts = [];
    for (let t = from - (from % step) + step; t <= now + step; t += step) {
      let exp = base; let ok = true;
      for (const s of series) { const pb = at(s.b, t); const pr = at(s.r, t); if (pb == null || pr == null) { ok = false; break; } exp += pb / (pb + pr); }
      if (ok) pts.push({ ts: Math.floor(Math.min(t, now) / 1000), expected_blue: Math.round(exp * 100) / 100 });
    }
    return pts;
  }
  v1.get('/hubs/senate_map', (req, res) => {
    const states = STATES.map((s) => {
      const race = raceOf(s);
      const base = { code: s.code, name: s.name, grid: { row: s.row, col: s.col }, seated: s.seated };
      if (!race) return { ...base, status: 'not_up', lean: s.seated.blue > s.seated.red ? 'held_blue' : s.seated.red > s.seated.blue ? 'held_red' : 'held_split', event_ticker: null };
      return { ...base, status: 'race', event_ticker: race.ev.event_ticker, series_ticker: race.ev.series_ticker, series_slug: race.ev.series_slug, title: race.ev.title,
        blue: { ticker: race.blue.ticker, probability: Math.round(race.p * 1000) / 1000 }, red: { ticker: race.red.ticker, probability: Math.round((1 - race.p) * 1000) / 1000 }, lean: lean(race.p), leader: race.p >= 0.5 ? 'blue' : 'red' };
    });
    const races = STATES.map(raceOf).filter(Boolean);
    const heldBlue = STATES.reduce((a, s) => a + s.seated.blue, 0); const heldRed = STATES.reduce((a, s) => a + s.seated.red, 0);
    const expBlue = heldBlue + races.reduce((a, r) => a + r.p, 0);
    const projBlue = heldBlue + races.filter((r) => r.p >= 0.5).length;
    res.json({
      chamber_size: CHAMBER, majority: Math.floor(CHAMBER / 2) + 1, races: races.length,
      seats: { held_blue: heldBlue, held_red: heldRed, expected_blue: Math.round(expBlue * 100) / 100, expected_red: Math.round((CHAMBER - expBlue) * 100) / 100, projected_blue: projBlue, projected_red: CHAMBER - projBlue },
      states, history: seatHistory(races, Math.min(30, Math.max(1, Number(req.query.days) || 7))), updated_time: new Date().toISOString(),
    });
  });

  // ------------------------------------------------------------------ Fed funds outlook
  const decision = (ev) => ({ cut: outcomeOf(ev, /^cut/i), hold: outcomeOf(ev, /^hold/i), hike: outcomeOf(ev, /^hike/i) });
  const impliedChange = (p) => Math.round(25 * (p.hike - p.cut) * 10) / 10;
  function meetingProbs(ev, priceFn) {
    const d = decision(ev); if (!d.cut || !d.hold || !d.hike) return null;
    const raw = { cut: priceFn(d.cut.ticker), hold: priceFn(d.hold.ticker), hike: priceFn(d.hike.ticker) };
    if (Object.values(raw).some((v) => v == null)) return null;
    const sum = raw.cut + raw.hold + raw.hike; if (sum <= 0) return null;
    return { cut: raw.cut / sum, hold: raw.hold / sum, hike: raw.hike / sum };
  }
  v1.get('/hubs/fed_funds_outlook', (req, res) => {
    const evs = db.prepare('SELECT * FROM events WHERE series_ticker=? ORDER BY rowid').all(RATE_SERIES).map(eventFull)
      .filter((e) => e.markets.some((m) => m.status === 'active')).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
    let mid = (CURRENT_RATE_BPS.lower + CURRENT_RATE_BPS.upper) / 2;
    const meetings = [];
    for (const ev of evs) {
      const p = meetingProbs(ev, priceOf); if (!p) continue;
      const ch = impliedChange(p); mid += ch;
      meetings.push({ event_ticker: ev.event_ticker, series_ticker: ev.series_ticker, series_slug: ev.series_slug, title: ev.title, meeting_date: ev.close_time,
        probabilities: { cut: Math.round(p.cut * 1000) / 1000, hold: Math.round(p.hold * 1000) / 1000, hike: Math.round(p.hike * 1000) / 1000 },
        most_likely: Object.entries(p).sort((a, b) => b[1] - a[1])[0][0], implied_change_bps: ch, implied_midpoint_bps: Math.round(mid * 10) / 10 });
    }
    res.json({ current_range_bps: CURRENT_RATE_BPS, current_midpoint_bps: (CURRENT_RATE_BPS.lower + CURRENT_RATE_BPS.upper) / 2, step_bps: 25, meetings, updated_time: new Date().toISOString() });
  });

  // ------------------------------------------------------------------ event forecast history
  const tradesOf = (t, from) => {
    const prev = db.prepare('SELECT yes_price_cents p, created_ts ts FROM trades WHERE market_ticker=? AND created_ts<? ORDER BY created_ts DESC LIMIT 1').get(t, from);
    return [...(prev ? [prev] : []), ...db.prepare('SELECT yes_price_cents p, created_ts ts FROM trades WHERE market_ticker=? AND created_ts>=? ORDER BY created_ts').all(t, from)];
  };
  const at = (list, t) => { let v = null; for (const x of list) { if (x.ts > t) break; v = x.p; } return v; };
  v1.get('/series/:s/events/:e/forecast_history', (req, res) => {
    const e = getEvent(String(req.params.e).toUpperCase());
    if (!e || e.series_ticker !== String(req.params.s).toUpperCase()) throw E.notFound();
    const ev = eventFull(e);
    const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
    const period = [60, 240, 1440].includes(Number(req.query.period)) ? Number(req.query.period) : 60;
    const now = Date.now(); const from = now - days * D; const step = period * 60000;
    const ms = ev.markets.filter((m) => m.status !== 'finalized' || ev.markets.length === 1);
    const tr = new Map(ms.map((m) => [m.ticker, tradesOf(m.ticker, from)]));
    const isRate = ev.series_ticker === RATE_SERIES && !!meetingProbs(ev, () => 1);
    const points = [];
    for (let t = from - (from % step) + step; t <= now + step; t += step) {
      const tt = Math.min(t, now);
      const vals = {}; let sum = 0;
      for (const m of ms) { const v = at(tr.get(m.ticker), tt); if (v != null) { vals[m.ticker] = v; sum += v; } }
      if (!Object.keys(vals).length) continue;
      if (ev.mutually_exclusive && sum > 0) for (const k of Object.keys(vals)) vals[k] = Math.round((vals[k] / sum) * 1000) / 10;
      const pt = { ts: Math.floor(tt / 1000), values: vals };
      if (isRate) { const p = meetingProbs(ev, (tk) => at(tr.get(tk), tt)); if (p) pt.implied_change_bps = impliedChange(p); }
      points.push(pt);
    }
    res.json({ event_ticker: ev.event_ticker, series_ticker: ev.series_ticker, kind: isRate ? 'rate_decision' : 'probability', normalized: !!ev.mutually_exclusive, period_minutes: period,
      outcomes: ms.map((m) => ({ ticker: m.ticker, name: m.yes_sub_title, color: m.color })), points });
  });
  void dollars;
  return { ensureTemperatureDay };
}

module.exports = { mountHubs, CURRENT_RATE_BPS };
