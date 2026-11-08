'use strict';
// Elections hub v2, Nigeria first (PLAN Phase 7B, CLONE_SPEC.md §37; observed structure §13.20). Replaces the Phase 5B
// tile-map hub as the elections entry point; that hub's invented 12 states are the second country ("Harbor", XH) here.
//
// Country model (DB, Admin › Elections, every change audited with a reason): countries (currency, time zone, locale,
// division levels), divisions (NG: zone → state/FCT → LGA → ward, polling units as counts), offices and chambers with
// their win rule as configuration, parties (N, with coalitions), candidates (photo through the CMS media library or
// initials), elections and races. Each race links to markets created through the engine (winner per candidate, runoff,
// chamber control). Nothing below branches on a country: a country is data (ground rule 5, §30.0).
//
// Results feed (simulated, like sports §19): every race has counting units (LGAs for the presidency and governorships,
// the area for a legislative seat) with polling units reported and votes per candidate; state and national totals are
// collated from them. The simulator is deterministic (a function of the election's seed and its simulated clock), runs on
// the engine tick only while the `elections.simulator` flag is on (off by default) and the election is started, and
// persists every change, so a restart resumes exactly. Clients can never write the feed.
// Results desk: call / uncall with a role (resolution.write), a reason and step-up; offices marked two-person (the
// presidency) need a second person; a call proposes settlements through the resolution desk (res_approvals, §28.7).
// Snapshots of the compact hub state are persisted for the timeline. Live nudges go out on the public `elections`
// WebSocket channel. The hub chat is a §20 chat room (HUB-<SLUG>) through a chat.js room hook.
const { tx } = require('./db');
const { newId, nowIso, E, ApiError, UNITS } = require('./util');
const { check } = require('./validate');
const C = require('./currency');
const { s: S } = require('./content/elections');
const DATA = require('./elections-data');
const { ROLE_PERMS } = require('./admin');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS el_countries (code TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL, time_zone TEXT NOT NULL, locale TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1, created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS el_divisions (id TEXT PRIMARY KEY, country TEXT NOT NULL, level TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, parent_id TEXT, data_json TEXT NOT NULL DEFAULT '{}',
  sort INTEGER NOT NULL DEFAULT 0, updated_ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_el_divisions_parent ON el_divisions(parent_id, sort);
CREATE INDEX IF NOT EXISTS idx_el_divisions_level ON el_divisions(country, level);
CREATE TABLE IF NOT EXISTS el_offices (id TEXT PRIMARY KEY, country TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, level TEXT NOT NULL, seats INTEGER NOT NULL, chamber INTEGER NOT NULL DEFAULT 0,
  two_person INTEGER NOT NULL DEFAULT 0, rule_json TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, updated_ts INTEGER NOT NULL, UNIQUE (country, key));
CREATE TABLE IF NOT EXISTS el_parties (id TEXT PRIMARY KEY, country TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, short_name TEXT NOT NULL, color TEXT NOT NULL, logo_media_id TEXT,
  coalition TEXT, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, updated_ts INTEGER NOT NULL, UNIQUE (country, code));
CREATE TABLE IF NOT EXISTS el_elections (id TEXT PRIMARY KEY, country TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, kind TEXT NOT NULL, date TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}',
  sim_json TEXT NOT NULL DEFAULT '{}', active INTEGER NOT NULL DEFAULT 1, created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS el_races (id TEXT PRIMARY KEY, election_id TEXT NOT NULL, office_id TEXT NOT NULL, division_id TEXT NOT NULL, seat INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL,
  area_json TEXT NOT NULL DEFAULT '[]', prior_json TEXT NOT NULL DEFAULT '{}', date TEXT, status TEXT NOT NULL DEFAULT 'open', winner_candidate_id TEXT, called_ts INTEGER, called_by TEXT,
  featured INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0, updated_ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_el_races_election ON el_races(election_id, office_id, sort);
CREATE TABLE IF NOT EXISTS el_candidates (id TEXT PRIMARY KEY, race_id TEXT NOT NULL, party_id TEXT NOT NULL, name TEXT, photo_media_id TEXT, running_mate TEXT, sort INTEGER NOT NULL DEFAULT 0, updated_ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_el_candidates_race ON el_candidates(race_id, sort);
CREATE TABLE IF NOT EXISTS el_race_markets (race_id TEXT NOT NULL, market_ticker TEXT NOT NULL, kind TEXT NOT NULL, candidate_id TEXT, party_id TEXT, PRIMARY KEY (race_id, market_ticker));
CREATE TABLE IF NOT EXISTS el_office_markets (election_id TEXT NOT NULL, office_id TEXT NOT NULL, market_ticker TEXT NOT NULL, kind TEXT NOT NULL, party_id TEXT, PRIMARY KEY (election_id, office_id, market_ticker));
CREATE TABLE IF NOT EXISTS el_reporting (race_id TEXT NOT NULL, unit_id TEXT NOT NULL, pu_total INTEGER NOT NULL, pu_reported INTEGER NOT NULL DEFAULT 0, voters INTEGER NOT NULL, updated_ts INTEGER NOT NULL,
  PRIMARY KEY (race_id, unit_id));
CREATE TABLE IF NOT EXISTS el_tallies (race_id TEXT NOT NULL, unit_id TEXT NOT NULL, candidate_id TEXT NOT NULL, votes INTEGER NOT NULL, PRIMARY KEY (race_id, unit_id, candidate_id));
CREATE TABLE IF NOT EXISTS el_calls (id TEXT PRIMARY KEY, race_id TEXT NOT NULL, action TEXT NOT NULL, outcome TEXT, candidate_id TEXT, reason TEXT NOT NULL, status TEXT NOT NULL,
  requested_by TEXT NOT NULL, requested_ts INTEGER NOT NULL, decided_by TEXT, decided_ts INTEGER, note TEXT, proposals_json TEXT);
CREATE INDEX IF NOT EXISTS idx_el_calls_status ON el_calls(status, requested_ts);
CREATE TABLE IF NOT EXISTS el_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, election_id TEXT NOT NULL, ts INTEGER NOT NULL, minutes REAL NOT NULL, kind TEXT NOT NULL, label TEXT, data_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_el_snapshots_election ON el_snapshots(election_id, id);
CREATE TABLE IF NOT EXISTS el_ballot_saved (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, division_id TEXT NOT NULL, saved_ts INTEGER NOT NULL);
`;
const SEED_KEY = 'elections_seed_v1';
const DAY = 86400000;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const CALL_TTL_MS = DAY; // a pending two-person call lapses after a day (like resolution approvals, §28.7)
const ST = { none: 0, counting: 1, counted: 2, called: 3, runoff: 4 };
const BAND = (p) => (p >= 0.9 ? 'safe' : p >= 0.75 ? 'likely' : p >= 0.6 ? 'lean' : 'tossup');
const pm = (x) => Math.round(Math.max(0, Math.min(1, x)) * 1000); // probability / fraction → per mille
const KINDS = ['countries', 'divisions', 'offices', 'parties', 'candidates', 'elections', 'races'];
const PLAIN = /^[^<>\u0000-\u001f\u007f]*$/; // names are plain text (always escaped on output too)

// Deterministic helpers (the simulator is a pure function of seed and simulated time).
const h01 = DATA.h01;
const gauss = (u1, u2) => Math.sqrt(-2 * Math.log(Math.max(1e-9, u1))) * Math.cos(2 * Math.PI * u2);
const phi = (z) => 1 / (1 + Math.exp(-1.702 * z)); // logistic approximation of the normal CDF
const initials = (name) => String(name || '').split(/[\s-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function mountElections({ v1, db, engine, auth, admin, flags, feat, chat, options = {} }) {
  db.exec(SCHEMA);
  const can = admin.can;
  const production = process.env.NODE_ENV === 'production';
  const snapEveryMin = Math.max(1, Number(options.snapshotEveryMin || 30));
  const retain = Math.max(20, Number(options.retainSnapshots || 400));
  const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
  const now = () => Date.now();
  const emailOf = (uid) => (uid ? db.prepare('SELECT email FROM users WHERE id=?').get(uid)?.email || uid : null);
  const reasonOf = (b) => { const r = String((b && b.reason) || '').trim(); if (r.length < 3 || r.length > 500) throw new ApiError(400, 'validation_failed', 'validation failed', S('error.reason_required')); return r; };
  const fieldErr = (errs) => { const e = new ApiError(400, 'validation_failed', 'validation failed', Object.entries(errs).map(([k, m]) => `${k}: ${m}`).join('; ')); e.toJSON = () => ({ error: { code: e.code, message: e.message, details: e.details, fields: errs } }); return e; };
  const mediaUrl = (id) => { if (!id) return null; const m = db.prepare("SELECT id, ext FROM cms_media WHERE id=? AND variant='original' AND mime LIKE 'image/%'").get(String(id)); return m ? `/media/${m.id}.${m.ext}` : null; };

  // ---------------------------------------------------------------------------------------------- config caches
  const countryCache = new Map();
  function countryCfg(code) {
    let c = countryCache.get(code);
    if (c) return c;
    const row = db.prepare('SELECT * FROM el_countries WHERE code=?').get(code);
    if (!row) return null;
    const divs = new Map(); const children = new Map();
    for (const d of db.prepare('SELECT id, level, code, name, parent_id, data_json, sort FROM el_divisions WHERE country=? ORDER BY sort, id').all(code)) {
      const x = { id: d.id, level: d.level, code: d.code, name: d.name, parent: d.parent_id, data: J(d.data_json, {}), sort: d.sort };
      divs.set(d.id, x);
      if (d.parent_id) { if (!children.has(d.parent_id)) children.set(d.parent_id, []); children.get(d.parent_id).push(d.id); }
    }
    const config = { levels: [], map_level: 'state', ballot_levels: [], map_cols: 6, map_rows: 6, ...J(row.config_json, {}) };
    const anc = new Map();
    const ancestorAt = (id, level) => {
      const k = `${id}|${level}`;
      if (anc.has(k)) return anc.get(k);
      let d = divs.get(id); let g = 0;
      while (d && d.level !== level && g++ < 12) d = d.parent ? divs.get(d.parent) : null;
      const out = d && d.level === level ? d.id : null;
      anc.set(k, out);
      return out;
    };
    const ofLevel = (level) => [...divs.values()].filter((d) => d.level === level);
    c = { row, config, divs, children, ancestorAt, ofLevel, mapUnits: ofLevel(config.map_level) };
    countryCache.set(code, c);
    return c;
  }
  const invalidate = (code) => { if (code) countryCache.delete(code); else countryCache.clear(); modelCache.clear(); };
  const officesOf = (code) => db.prepare('SELECT * FROM el_offices WHERE country=? ORDER BY sort, id').all(code).map((o) => ({ ...o, rule: J(o.rule_json, { type: 'plurality' }), chamber: !!o.chamber, two_person: !!o.two_person }));
  const partiesOf = (code) => db.prepare('SELECT * FROM el_parties WHERE country=? ORDER BY sort, id').all(code);
  const partyVo = (p) => ({ id: p.id, code: p.code, name: p.name, short_name: p.short_name, color: COLOR.test(p.color) ? p.color : '#868e96', logo_url: mediaUrl(p.logo_media_id), coalition: p.coalition || null, active: !!p.active });
  const electionBySlug = (slug) => db.prepare('SELECT * FROM el_elections WHERE slug=? AND active=1').get(String(slug || '').toLowerCase());
  const electionById = (id) => db.prepare('SELECT * FROM el_elections WHERE id=?').get(String(id || ''));
  const simOf = (el) => ({ status: 'idle', minutes: 0, speed: Number(options.speed || 60), seed: 20270220, ...J(el.sim_json, {}) });
  const roomOf = (el) => `HUB-${el.slug.toUpperCase()}`;

  // ---------------------------------------------------------------------------------------------- market prices
  const lastCc = db.prepare('SELECT yes_price_cc p FROM trades WHERE market_ticker=? ORDER BY created_ts DESC, rowid DESC LIMIT 1');
  const bestBid = db.prepare("SELECT MAX(price_cc) p FROM orders WHERE market_ticker=? AND status='resting' AND side=?");
  const mktRow = db.prepare('SELECT ticker, event_ticker, status, result, yes_sub_title FROM markets WHERE ticker=?');
  const volCents = db.prepare('SELECT COALESCE(SUM(count*yes_price_cc),0) v FROM trades WHERE market_ticker=?');
  function marketInfo(t) {
    const m = mktRow.get(t);
    if (!m) return null;
    let price = null;
    if ((m.status === 'determined' || m.status === 'finalized') && (m.result === 'yes' || m.result === 'no')) price = m.result === 'yes' ? 100 : 0;
    else {
      const l = lastCc.get(t);
      if (l && l.p != null) price = l.p / 100;
      else { const y = bestBid.get(t, 'yes').p; const n = bestBid.get(t, 'no').p; if (y != null && n != null) price = (y + (10000 - n)) / 200; }
    }
    return { ticker: t, event_ticker: m.event_ticker, status: m.status, result: m.result || null, price, outcome: m.yes_sub_title, volume_cents: Math.round(volCents.get(t).v / (UNITS * 100)) };
  }
  const priceAt = db.prepare('SELECT yes_price_cc p FROM trades WHERE market_ticker=? AND created_ts<=? ORDER BY created_ts DESC, rowid DESC LIMIT 1');

  // ---------------------------------------------------------------------------------------------- the live model
  // One computation per election (cached briefly): every race with its candidates, collated counts, forecast, win-rule
  // evaluation, markets and, for races above the map level, the per-map-unit collation (state results of the presidency).
  const modelCache = new Map();
  function model(el) {
    const hit = modelCache.get(el.id);
    if (hit && now() - hit.at < 400) return hit.m;
    const m = computeModel(el);
    modelCache.set(el.id, { at: now(), m });
    return m;
  }
  function computeModel(el) {
    const cfg = countryCfg(el.country);
    const offices = new Map(officesOf(el.country).map((o) => [o.id, o]));
    const parties = new Map(partiesOf(el.country).map((p) => [p.id, partyVo(p)]));
    const races = db.prepare('SELECT * FROM el_races WHERE election_id=? ORDER BY sort, id').all(el.id);
    const byRace = (sql) => { const out = new Map(); for (const r of db.prepare(sql).all(el.id)) { if (!out.has(r.race_id)) out.set(r.race_id, []); out.get(r.race_id).push(r); } return out; };
    const cands = byRace('SELECT c.* FROM el_candidates c JOIN el_races r ON r.id=c.race_id WHERE r.election_id=? ORDER BY c.sort, c.id');
    const reps = byRace('SELECT p.* FROM el_reporting p JOIN el_races r ON r.id=p.race_id WHERE r.election_id=?');
    const tals = byRace('SELECT t.* FROM el_tallies t JOIN el_races r ON r.id=t.race_id WHERE r.election_id=?');
    const mks = byRace('SELECT rm.* FROM el_race_markets rm JOIN el_races r ON r.id=rm.race_id WHERE r.election_id=?');
    const out = [];
    for (const r of races) {
      const office = offices.get(r.office_id);
      if (!office) continue;
      const prior = J(r.prior_json, {});
      const cs = (cands.get(r.id) || []).map((c) => {
        const p = parties.get(c.party_id) || { id: c.party_id, code: '?', short_name: '?', name: '?', color: '#868e96' };
        const name = c.name || S('party.candidate', { party: p.short_name });
        return { id: c.id, party_id: c.party_id, party: p, name, is_party: !c.name, initials: c.name ? initials(c.name) : p.short_name.slice(0, 3), photo_url: mediaUrl(c.photo_media_id), running_mate: c.running_mate || null, votes: 0, share: 0, prob: 0 };
      });
      const byId = new Map(cs.map((c) => [c.id, c]));
      const units = new Map(); let puT = 0; let puR = 0;
      for (const u of reps.get(r.id) || []) { units.set(u.unit_id, { pu_total: u.pu_total, pu_reported: u.pu_reported, votes: {} }); puT += u.pu_total; puR += u.pu_reported; }
      for (const t of tals.get(r.id) || []) { const c = byId.get(t.candidate_id); if (c) c.votes += t.votes; const u = units.get(t.unit_id); if (u) u.votes[t.candidate_id] = t.votes; }
      const total = cs.reduce((a, c) => a + c.votes, 0);
      for (const c of cs) c.share = total ? c.votes / total : 0;
      const pct = puT ? puR / puT : 0;
      // Markets of the race.
      const markets = (mks.get(r.id) || []).map((x) => ({ ...marketInfo(x.market_ticker), kind: x.kind, candidate_id: x.candidate_id, party_id: x.party_id })).filter((x) => x.ticker);
      // Forecast: called → certain; otherwise markets (or the race prior) blended with the count model as it reports.
      const base = {};
      const wm = markets.filter((x) => x.kind === 'winner' && x.candidate_id && x.price != null);
      const sumM = wm.reduce((a, x) => a + x.price, 0);
      if (wm.length && sumM > 0) for (const x of wm) base[x.candidate_id] = x.price / sumM;
      else { const pr = prior.default || {}; const sp = cs.reduce((a, c) => a + (Number(pr[c.id]) || 0), 0); for (const c of cs) base[c.id] = sp > 0 ? (Number(pr[c.id]) || 0) / sp : 1 / Math.max(1, cs.length); }
      const ranked = [...cs].sort((a, b) => b.votes - a.votes || (base[b.id] || 0) - (base[a.id] || 0));
      let probs = { ...base };
      if (total > 0 && ranked.length > 1) {
        const f = 1 - pct; const sigma = 0.18 * Math.sqrt(f) + 1e-6;
        const pLead = f <= 0 ? 1 : phi((ranked[0].share - ranked[1].share) / sigma);
        const modelP = { [ranked[0].id]: pLead, [ranked[1].id]: 1 - pLead };
        const w = Math.sqrt(pct);
        probs = {};
        for (const c of cs) probs[c.id] = w * (modelP[c.id] || 0) + (1 - w) * (base[c.id] || 0);
      }
      if (r.status === 'called' && r.winner_candidate_id) { probs = {}; for (const c of cs) probs[c.id] = c.id === r.winner_candidate_id ? 1 : 0; }
      for (const c of cs) c.prob = probs[c.id] || 0;
      const byProb = [...cs].sort((a, b) => b.prob - a.prob || b.votes - a.votes);
      const lead = total > 0 ? ranked[0] : byProb[0];
      const second = total > 0 ? ranked[1] : byProb[1];
      const state = r.status === 'called' ? ST.called : r.status === 'runoff' ? ST.runoff : puT && puR >= puT ? ST.counted : puR > 0 ? ST.counting : ST.none;
      const rule = evalRule(cfg, office.rule, r, cs, units, ranked[0]);
      out.push({ race: r, id: r.id, office, cands: cs, byId, units, pu_total: puT, pu_reported: puR, pct, total, state, lead: lead || null, second: second || null,
        plead: lead ? (r.status === 'called' ? 1 : lead.prob) : 0, markets, volume_cents: markets.reduce((a, x) => a + (x.volume_cents || 0), 0), rule,
        margin: total > 0 && ranked[1] ? ranked[0].share - ranked[1].share : null });
    }
    const raceById = new Map(out.map((x) => [x.id, x]));
    const officeMarkets = new Map();
    for (const om of db.prepare('SELECT * FROM el_office_markets WHERE election_id=?').all(el.id)) {
      if (!officeMarkets.has(om.office_id)) officeMarkets.set(om.office_id, []);
      const mi = marketInfo(om.market_ticker);
      if (mi) officeMarkets.get(om.office_id).push({ ...mi, kind: om.kind, party_id: om.party_id });
    }
    return { el, cfg, offices, parties, races: out, raceById, officeMarkets, config: J(el.config_json, {}), at: now() };
  }

  // ---------------------------------------------------------------------------------------------- win rules
  // plurality: the most votes wins.  spread: the most votes AND at least `share` of the vote in at least
  // `fraction` of the race's `unit` divisions (territories excluded from that count; with territory_required each
  // territory in the area must reach the share too). Evaluated on reported votes; `meets` per candidate.
  function evalRule(cfg, rule, race, cands, units, leader) {
    const base = { type: rule.type || 'plurality', leader: leader ? leader.id : null };
    if (rule.type !== 'spread') return { ...base, candidates: cands.map((c) => ({ candidate_id: c.id, meets: !!leader && c.id === leader.id && c.votes > 0 })) };
    const agg = new Map(); // rule-unit division → votes per candidate
    for (const [uid, u] of units) {
      const at = cfg.ancestorAt(uid, rule.unit) || uid;
      if (!agg.has(at)) agg.set(at, {});
      const a = agg.get(at);
      for (const [cid, v] of Object.entries(u.votes)) a[cid] = (a[cid] || 0) + v;
    }
    // Every rule unit of the race's area counts, even before it reports.
    const area = J(race.area_json, []);
    const all = new Set();
    for (const id of area) { const d = cfg.divs.get(id); if (!d) continue; if (d.level === rule.unit) all.add(id); else for (const x of cfg.ofLevel(rule.unit)) if (cfg.ancestorAt(x.id, d.level) === id) all.add(x.id); }
    for (const k of agg.keys()) all.add(k);
    const plain = [...all].filter((id) => !cfg.divs.get(id)?.data?.territory);
    const terr = [...all].filter((id) => cfg.divs.get(id)?.data?.territory);
    const [n, d] = Array.isArray(rule.fraction) ? rule.fraction : [2, 3];
    const needed = Math.ceil((plain.length * n) / d - 1e-9);
    const share = Number(rule.share ?? 0.25);
    const shareIn = (id, cid) => { const a = agg.get(id); if (!a) return 0; const t = Object.values(a).reduce((x, y) => x + y, 0); return t ? (a[cid] || 0) / t : 0; };
    const rows = cands.map((c) => {
      const count = plain.filter((id) => shareIn(id, c.id) >= share).length;
      const territoryOk = !rule.territory_required || terr.every((id) => shareIn(id, c.id) >= share);
      const leading = !!leader && leader.id === c.id && c.votes > 0;
      return { candidate_id: c.id, count, territory_ok: territoryOk, meets: leading && count >= needed && territoryOk };
    });
    return { ...base, share, needed, units: plain.length, territories: terr.map((id) => cfg.divs.get(id).code), unit: rule.unit, on_fail: rule.on_fail || 'none', candidates: rows };
  }

  // ---------------------------------------------------------------------------------------------- compact state
  // The hub state at one moment, in a compact form: persisted as a timeline snapshot and the input of every view, so the
  // live page and a replay draw exactly the same way. races: id → [state, lead, ‰ reported, winner, ‰ lead chance,
  // second]; units (races above the map level): race → map unit → [lead, ‰ reported, done, ‰ lead chance, second];
  // ctrl: chamber office → party → ‰ chance of winning the most seats; pi: Power Index value.
  function compactOf(mdl) {
    const races = {}; const units = {};
    for (const x of mdl.races) {
      races[x.id] = [x.state, x.lead ? x.lead.id : null, pm(x.pct), x.race.status === 'called' ? x.race.winner_candidate_id : null, pm(x.plead), x.second ? x.second.id : null];
      const lvl = mdl.cfg.divs.get(x.race.division_id)?.level;
      if (lvl && lvl !== mdl.cfg.config.map_level && x.units.size) {
        const agg = new Map();
        for (const [uid, u] of x.units) {
          const at = mdl.cfg.ancestorAt(uid, mdl.cfg.config.map_level);
          if (!at) continue;
          if (!agg.has(at)) agg.set(at, { t: 0, r: 0, v: {} });
          const a = agg.get(at); a.t += u.pu_total; a.r += u.pu_reported;
          for (const [cid, v] of Object.entries(u.votes)) a.v[cid] = (a.v[cid] || 0) + v;
        }
        const per = {};
        for (const [id, a] of agg) {
          const tot = Object.values(a.v).reduce((p, q) => p + q, 0);
          const rk = Object.entries(a.v).sort((p, q) => q[1] - p[1]);
          const f = a.t ? a.r / a.t : 0;
          const done = a.t > 0 && a.r >= a.t;
          let pl = 0;
          if (tot > 0 && rk.length > 1) pl = done ? 1 : phi((rk[0][1] - rk[1][1]) / tot / (0.18 * Math.sqrt(1 - f) + 1e-6));
          else if (tot > 0) pl = 1;
          per[id] = [tot > 0 ? rk[0][0] : null, pm(f), done ? 1 : 0, pm(pl), rk[1] ? rk[1][0] : null];
        }
        units[x.id] = per;
      }
    }
    const ctrl = {};
    for (const o of mdl.offices.values()) if (o.chamber && mdl.races.some((x) => x.office.id === o.id)) ctrl[o.id] = controlChances(mdl, o);
    return { v: 1, minutes: simOf(mdl.el).minutes, races, units, ctrl, pi: powerValue(mdl.el.country) };
  }
  // P(each party wins the most seats): a seeded simulation over the races' forecasts (independent seats) blended with
  // the chamber-control markets while nothing has reported.
  function controlChances(mdl, office) {
    const rs = mdl.races.filter((x) => x.office.id === office.id);
    const hold = holdovers(mdl, office.id);
    const r = rng(7919);
    const wins = {}; const N = 300;
    for (let i = 0; i < N; i++) {
      const seats = { ...hold };
      for (const x of rs) {
        let u = r(); let pick = x.cands[x.cands.length - 1];
        for (const c of x.cands) { u -= c.prob; if (u <= 0) { pick = c; break; } }
        if (pick) seats[pick.party_id] = (seats[pick.party_id] || 0) + 1;
      }
      const best = Object.entries(seats).sort((a, b) => b[1] - a[1]);
      if (best.length && (!best[1] || best[0][1] > best[1][1])) wins[best[0][0]] = (wins[best[0][0]] || 0) + 1;
    }
    const model = {}; for (const [k, v] of Object.entries(wins)) model[k] = v / N;
    const mk = (mdl.officeMarkets.get(office.id) || []).filter((x) => x.kind === 'control' && x.price != null);
    const sum = mk.reduce((a, x) => a + x.price, 0);
    const w = rs.length ? rs.reduce((a, x) => a + (x.state >= ST.called ? 1 : x.pct), 0) / rs.length : 0;
    const out = {};
    const keys = new Set([...Object.keys(model), ...mk.map((x) => x.party_id)]);
    for (const k of keys) { const m = mk.length && sum > 0 ? (mk.find((x) => x.party_id === k)?.price || 0) / sum : model[k] || 0; out[k] = pm(Math.sqrt(w) * (model[k] || 0) + (1 - Math.sqrt(w)) * m); }
    return out;
  }
  const holdovers = (mdl, officeId) => ({ ...((mdl.config.holdovers || {})[officeId] || {}) });

  // ---------------------------------------------------------------------------------------------- views (live or replay)
  const callAllowed = (req, key) => flags.on(key, { req });
  function viewOf(mdl, compact, officeKey, { live, req }) {
    const offices = [...mdl.offices.values()].filter((o) => mdl.races.some((x) => x.office.id === o.id));
    const office = offices.find((o) => o.key === officeKey) || offices[0];
    if (!office) return { office: null, offices: [], gauges: [], seats: null, map: null, ratings: null };
    const party = (id) => mdl.parties.get(id) || null;
    const results = live && callAllowed(req, 'elections.results');
    // Per-race entries from the compact state (live or snapshot).
    const entry = (x) => { const c = compact.races[x.id]; return c ? { st: c[0], lead: c[1], pct: c[2] / 1000, win: c[3], pl: c[4] / 1000, second: c[5] } : { st: 0, lead: null, pct: 0, win: null, pl: 0, second: null }; };
    const candParty = (x, cid) => (cid ? x.byId.get(cid)?.party_id || null : null);
    const ors = mdl.races.filter((x) => x.office.id === office.id);
    // ---- seats (seat-bar offices: chambers and governorships)
    const hold = holdovers(mdl, office.id);
    const seatsBy = {}; const fc = {};
    for (const [k, v] of Object.entries(hold)) { seatsBy[k] = (seatsBy[k] || 0) + v; fc[k] = (fc[k] || 0) + v; }
    for (const x of ors) {
      const e = entry(x);
      if (e.st === ST.called && e.win) { const p = candParty(x, e.win); seatsBy[p] = (seatsBy[p] || 0) + 1; fc[p] = (fc[p] || 0) + 1; continue; }
      const lp = candParty(x, e.lead); const sp = candParty(x, e.second);
      if (lp) fc[lp] = (fc[lp] || 0) + e.pl;
      if (sp) fc[sp] = (fc[sp] || 0) + (1 - e.pl);
    }
    const totalSeats = Object.values(hold).reduce((a, b) => a + b, 0) + ors.length;
    const partyIds = [...new Set([...Object.keys(fc), ...Object.keys(seatsBy)])].filter(Boolean).sort((a, b) => (fc[b] || 0) - (fc[a] || 0));
    const seats = ors.length > 1 || office.chamber ? { office: office.key, total: totalSeats, majority: office.chamber ? Math.floor(totalSeats / 2) + 1 : null,
      parties: partyIds.map((id) => ({ party: party(id), forecast: Math.round((fc[id] || 0) * 10) / 10, current: seatsBy[id] || 0 })) } : null;
    // ---- map: one entry per map unit
    const cfg = mdl.cfg; const mapLevel = cfg.config.map_level;
    const national = ors.length === 1 && cfg.divs.get(ors[0].race.division_id)?.level !== mapLevel;
    const tipRows = (x, unitVotes) => {
      if (!results) return [];
      const votes = unitVotes || Object.fromEntries(x.cands.map((c) => [c.id, c.votes]));
      const tot = Object.values(votes).reduce((a, b) => a + b, 0);
      return x.cands.map((c) => ({ candidate_id: c.id, name: c.name, initials: c.initials, photo_url: c.photo_url, party: c.party.short_name, color: c.party.color, votes: votes[c.id] || 0, share: tot ? (votes[c.id] || 0) / tot : 0,
        result: x.race.status === 'called' && !unitVotes ? (x.race.winner_candidate_id === c.id ? 'yes' : 'no') : null })).sort((a, b) => b.votes - a.votes);
    };
    const kindOf = (st, pl, done) => (st === ST.called || done ? 'called' : st === ST.runoff ? 'runoff' : st === ST.counting || st === ST.counted ? (pl >= 0.9 ? 'projected' : 'leading') : 'pending');
    const states = cfg.mapUnits.map((d) => {
      const base = { id: d.id, code: d.code, name: d.name, row: d.data.row ?? 0, col: d.data.col ?? 0, small: !!d.data.small, territory: !!d.data.territory };
      if (national) {
        const x = ors[0]; const u = (compact.units[x.id] || {})[d.id];
        if (!u) return { ...base, kind: 'none', race_ids: [x.id] };
        const [lead, pct, done, pl] = u;
        const st = pct > 0 ? ST.counting : ST.none;
        const lp = candParty(x, lead);
        const unit = live && x.units.size ? aggUnit(cfg, x, d.id) : null;
        return { ...base, kind: kindOf(st, pl / 1000, !!done), party_id: lp, color: party(lp)?.color || null, pct: pct / 1000, label: done ? null : `${Math.round(pct / 10)}%`, race_ids: [x.id],
          tooltip: { title: x.race.name, pct_reported: pct / 1000, rows: unit ? tipRows(x, unit.votes) : [], volume_cents: x.volume_cents, chance: null } };
      }
      const here = ors.filter((x) => x.race.division_id === d.id);
      if (!here.length) return { ...base, kind: 'none', race_ids: [] };
      if (here.length === 1) {
        const x = here[0]; const e = entry(x); const lp = candParty(x, e.win || e.lead);
        return { ...base, kind: kindOf(e.st, e.pl, false), party_id: e.st === ST.none ? null : lp, forecast_party_id: lp, color: party(lp)?.color || null, pct: e.pct, label: e.st === ST.called || e.st === ST.none ? null : `${Math.round(e.pct * 100)}%`, race_ids: [x.id],
          tooltip: { title: x.race.name, pct_reported: e.pct, rows: live ? tipRows(x) : [], volume_cents: x.volume_cents, chance: { party_id: lp, p: e.pl } } };
      }
      // Several seats in one state: the party ahead on the most seats; ticked once every seat is called.
      const tally = {}; let called = 0; let pctSum = 0; let counting = 0; let minPl = 1;
      const seatsRows = here.map((x) => {
        const e = entry(x); const p = candParty(x, e.win || e.lead);
        if (e.st === ST.called) called += 1; if (e.st === ST.counting || e.st === ST.counted) { counting += 1; minPl = Math.min(minPl, e.pl); }
        if (e.st !== ST.none && p) tally[p] = (tally[p] || 0) + 1;
        pctSum += e.pct;
        return { race_id: x.id, name: x.race.name, party: party(p)?.short_name || null, color: party(p)?.color || null, pct: e.pct, called: e.st === ST.called };
      });
      const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
      const st = called === here.length ? ST.called : counting || called ? ST.counting : ST.none;
      return { ...base, kind: kindOf(st, minPl, false), party_id: top ? top[0] : null, color: top ? party(top[0])?.color : null, pct: pctSum / here.length, label: st === ST.called ? null : called ? `${called}/${here.length}` : st === ST.none ? null : `${Math.round((pctSum / here.length) * 100)}%`,
        race_ids: here.map((x) => x.id), tooltip: { title: `${d.name} · ${office.name}`, pct_reported: pctSum / here.length, rows: [], seats: seatsRows, volume_cents: here.reduce((a, x) => a + x.volume_cents, 0), chance: null } };
    });
    const map = callAllowed(req, 'elections.results_map') ? { office: office.key, cols: cfg.config.map_cols, rows: cfg.config.map_rows, states } : null;
    // ---- ratings: map units for a national race, races otherwise
    const items = national ? states.filter((s) => s.kind !== 'none').map((s) => { const u = (compact.units[ors[0].id] || {})[s.id]; return { id: s.id, code: s.code, party_id: s.party_id, p: u ? u[3] / 1000 : 0, settled: s.kind === 'called' }; })
      : ors.map((x) => { const e = entry(x); const lp = candParty(x, e.win || e.lead); const d = cfg.divs.get(x.race.division_id); return { id: x.id, code: d ? d.code : '', party_id: lp, p: e.pl, settled: e.st === ST.called, race_id: x.id }; });
    const ratings = ratingsOf(items, (id) => party(id));
    // ---- gauges: the presidency (race chance) and each chamber's control chance
    const gauges = [];
    for (const o of offices) {
      const rs = mdl.races.filter((x) => x.office.id === o.id);
      if (o.chamber && compact.ctrl[o.id]) {
        const top = Object.entries(compact.ctrl[o.id]).sort((a, b) => b[1] - a[1]);
        if (top.length) gauges.push({ office: o.key, name: o.name, kind: 'control', party: party(top[0][0]), runner_up: top[1] ? party(top[1][0]) : null, p: top[0][1] / 1000, band: BAND(top[0][1] / 1000) });
      } else if (rs.length === 1) {
        const x = rs[0]; const e = entry(x); const lead = x.byId.get(e.win || e.lead); const sec = x.byId.get(e.second);
        if (lead) gauges.push({ office: o.key, name: o.name, kind: 'race', race_id: x.id, party: lead.party, candidate: lead.name, runner_up: sec ? sec.party : null, p: e.pl, band: BAND(e.pl), called: e.st === ST.called, runoff: e.st === ST.runoff });
      }
    }
    return { office: office.key, offices: offices.map((o) => ({ key: o.key, name: o.name, chamber: o.chamber, seat_bar: o.chamber || mdl.races.filter((x) => x.office.id === o.id).length > 1 })), gauges, seats, map, ratings, minutes: compact.minutes, power_index: compact.pi };
  }
  function aggUnit(cfg, x, mapUnitId) {
    const v = {}; let t = 0; let r = 0;
    for (const [uid, u] of x.units) { if (cfg.ancestorAt(uid, cfg.config.map_level) !== mapUnitId) continue; t += u.pu_total; r += u.pu_reported; for (const [c, n] of Object.entries(u.votes)) v[c] = (v[c] || 0) + n; }
    return { votes: v, pu_total: t, pu_reported: r };
  }
  // Swingometer: the two parties ahead on most items take the sides (Safe · Likely · Lean), toss-ups in the middle,
  // settled counts at the ends; items led by any other party go to an "others" group (multi-party).
  function ratingsOf(items, party) {
    const byParty = {};
    for (const it of items) if (it.party_id) byParty[it.party_id] = (byParty[it.party_id] || 0) + 1;
    const sides = Object.entries(byParty).sort((a, b) => b[1] - a[1]).slice(0, 2).map((x) => x[0]);
    const col = (pid, band) => ({ party: pid ? party(pid) : null, band, items: [] });
    const left = sides[0] || null; const right = sides[1] || null;
    const cols = [col(left, 'safe'), col(left, 'likely'), col(left, 'lean'), col(null, 'tossup'), col(right, 'lean'), col(right, 'likely'), col(right, 'safe')];
    const settled = { [left || '-']: 0, [right || '-']: 0 }; const others = [];
    for (const it of items) {
      if (it.settled) { if (it.party_id === left || it.party_id === right) settled[it.party_id] += 1; else others.push({ ...it, band: 'settled' }); continue; }
      if (!it.party_id) continue;
      const band = BAND(it.p);
      if (band === 'tossup') { cols[3].items.push(it); continue; }
      if (it.party_id === left) cols[{ safe: 0, likely: 1, lean: 2 }[band]].items.push(it);
      else if (it.party_id === right) cols[{ lean: 4, likely: 5, safe: 6 }[band]].items.push(it);
      else others.push({ ...it, band });
    }
    return { left: left ? party(left) : null, right: right ? party(right) : null, settled_left: left ? settled[left] : 0, settled_right: right ? settled[right] : 0, columns: cols, others: others.map((o) => ({ ...o, party: party(o.party_id) })) };
  }

  // ---------------------------------------------------------------------------------------------- Power Index
  // An admin formula over market prices: value = offset + Σ weight × price (0-100). Positive leans to `label_pos`,
  // negative to `label_neg`. History is recomputed from persisted trades (hourly), so it survives restarts.
  const PI_KEY = (c) => `elections_power_index:${c}`;
  const piCfg = (country) => ({ enabled: false, label_pos: '', label_neg: '', offset: 0, scale: 20, terms: [], ...(admin.setting(PI_KEY(country)) || {}) });
  function powerValue(country, at = null) {
    const f = piCfg(country);
    if (!f.enabled || !f.terms.length) return null;
    let v = Number(f.offset) || 0;
    for (const t of f.terms) {
      let p;
      if (at == null) p = marketInfo(t.ticker)?.price;
      else { const r = priceAt.get(t.ticker, at); p = r && r.p != null ? r.p / 100 : null; }
      if (p == null) return null;
      v += Number(t.weight) * p;
    }
    return Math.round(v * 10) / 10;
  }
  function powerIndexVo(country, days = 30) {
    const f = piCfg(country);
    if (!f.enabled || !f.terms.length) return null;
    const value = powerValue(country);
    const t = now(); const H = 3600000;
    const history = [];
    for (let ts = t - days * DAY - ((t - days * DAY) % H) + H; ts < t; ts += H) { const v = powerValue(country, ts); if (v != null) history.push({ ts: Math.floor(ts / 1000), v }); }
    if (value != null) history.push({ ts: Math.floor(t / 1000), v: value });
    const prev = powerValue(country, t - DAY);
    return { country, label_pos: f.label_pos, label_neg: f.label_neg, scale: f.scale, value, change_24h: value != null && prev != null ? Math.round((value - prev) * 10) / 10 : null, history };
  }

  // ---------------------------------------------------------------------------------------------- serializers
  function raceSummary(mdl, x, req) {
    const results = callAllowed(req, 'elections.results');
    const d = mdl.cfg.divs.get(x.race.division_id);
    return { id: x.id, name: x.race.name, office: x.office.key, office_name: x.office.name, division: d ? { id: d.id, code: d.code, name: d.name, level: d.level } : null, seat: x.race.seat,
      status: x.race.status, state: Object.keys(ST).find((k) => ST[k] === x.state), pct_reported: x.pct, winner_candidate_id: x.race.winner_candidate_id, featured: !!x.race.featured, date: x.race.date || mdl.el.date,
      margin: results ? x.margin : null, leader_party: x.lead ? x.lead.party : null,
      candidates: x.cands.map((c) => ({ id: c.id, name: c.name, is_party: c.is_party, initials: c.initials, photo_url: c.photo_url, running_mate: c.running_mate, party: c.party, chance: Math.round(c.prob * 1000) / 1000,
        votes: results ? c.votes : null, share: results ? Math.round(c.share * 10000) / 10000 : null })).sort((a, b) => (results ? (b.votes - a.votes) : 0) || b.chance - a.chance),
      markets: x.markets.map((m) => ({ ticker: m.ticker, event_ticker: m.event_ticker, kind: m.kind, candidate_id: m.candidate_id, outcome: m.outcome, price: m.price, status: m.status, result: m.result, volume_cents: m.volume_cents })),
      event: eventLink(x.markets[0]?.event_ticker), volume_cents: x.volume_cents };
  }
  const eventLink = (et) => { if (!et) return null; const e = db.prepare('SELECT e.ticker, e.series_ticker, s.slug FROM events e JOIN series s ON s.ticker=e.series_ticker WHERE e.ticker=?').get(et); return e ? { event_ticker: e.ticker, series_ticker: e.series_ticker, series_slug: e.slug } : null; };
  function raceDetail(mdl, x, req) {
    const sum = raceSummary(mdl, x, req);
    const cfg = mdl.cfg;
    const lvl = x.office.rule.type === 'spread' ? x.office.rule.unit : cfg.config.map_level;
    const rows = new Map();
    for (const [uid, u] of x.units) {
      const at = cfg.ancestorAt(uid, lvl) || uid;
      if (!rows.has(at)) rows.set(at, { t: 0, r: 0, v: {} });
      const a = rows.get(at); a.t += u.pu_total; a.r += u.pu_reported;
      for (const [c, n] of Object.entries(u.votes)) a.v[c] = (a.v[c] || 0) + n;
    }
    const units = [...rows].map(([id, a]) => { const d = cfg.divs.get(id); const tot = Object.values(a.v).reduce((p, q) => p + q, 0); return { id, code: d?.code || id, name: d?.name || id, territory: !!d?.data?.territory, pct_reported: a.t ? a.r / a.t : 0, total: tot,
      shares: Object.fromEntries(x.cands.map((c) => [c.id, tot ? Math.round(((a.v[c.id] || 0) / tot) * 10000) / 10000 : 0])) }; }).sort((a, b) => (cfg.divs.get(a.id)?.sort ?? 0) - (cfg.divs.get(b.id)?.sort ?? 0) || a.name.localeCompare(b.name));
    return { ...sum, pu_total: x.pu_total, pu_reported: x.pu_reported, total_votes: x.total, rule: x.rule, unit_level: lvl, units,
      calls: db.prepare("SELECT * FROM el_calls WHERE race_id=? ORDER BY requested_ts DESC LIMIT 20").all(x.id).map(callVo) };
  }
  const callVo = (c) => ({ id: c.id, race_id: c.race_id, action: c.action, outcome: c.outcome, candidate_id: c.candidate_id, reason: c.reason, status: c.status, requested_by: emailOf(c.requested_by), requested_time: new Date(c.requested_ts).toISOString(),
    expires_time: new Date(c.requested_ts + CALL_TTL_MS).toISOString(), decided_by: emailOf(c.decided_by), decided_time: c.decided_ts ? new Date(c.decided_ts).toISOString() : null, note: c.note, proposals: J(c.proposals_json, []) });
  function hubVo(el, req) {
    const mdl = model(el);
    const country = mdl.cfg.row;
    const offices = [...mdl.offices.values()].filter((o) => mdl.races.some((x) => x.office.id === o.id));
    const feat = mdl.races.filter((x) => x.race.featured).slice(0, 8).map((x) => raceSummary(mdl, x, req));
    // More markets: every event linked to this election.
    const evs = new Map();
    for (const x of mdl.races) for (const m of x.markets) if (m.event_ticker) evs.set(m.event_ticker, true);
    for (const list of mdl.officeMarkets.values()) for (const m of list) if (m.event_ticker) evs.set(m.event_ticker, true);
    const more = [...evs.keys()].map((et) => {
      const e = db.prepare('SELECT e.ticker, e.title, e.series_ticker, s.slug FROM events e JOIN series s ON s.ticker=e.series_ticker WHERE e.ticker=?').get(et);
      if (!e) return null;
      const ms = db.prepare('SELECT ticker FROM markets WHERE event_ticker=? ORDER BY rowid').all(et).map((r) => marketInfo(r.ticker)).filter(Boolean);
      const lead = ms.filter((m) => m.price != null).sort((a, b) => b.price - a.price)[0] || null;
      return { event_ticker: e.ticker, series_ticker: e.series_ticker, series_slug: e.slug, title: e.title, markets: ms.length, volume_cents: ms.reduce((a, m) => a + m.volume_cents, 0), leader: lead ? { outcome: lead.outcome, price: lead.price } : null };
    }).filter(Boolean).sort((a, b) => b.volume_cents - a.volume_cents);
    const sim = simOf(el);
    const hubs = db.prepare('SELECT slug, title, kind, country FROM el_elections WHERE active=1 ORDER BY country, date').all();
    return {
      hub: { id: el.id, slug: el.slug, title: el.title, kind: el.kind, date: el.date, chat_room: roomOf(el), status: mdl.races.every((x) => x.state >= ST.called) ? 'final' : mdl.races.some((x) => x.pu_reported > 0) ? 'counting' : 'upcoming',
        sim: { status: sim.status, minutes: Math.round(sim.minutes) } },
      country: { code: country.code, name: country.name, currency: country.currency, time_zone: country.time_zone, locale: country.locale, ballot_levels: mdl.cfg.config.ballot_levels },
      hubs: hubs.map((h) => ({ slug: h.slug, title: h.title, kind: h.kind, country: h.country })),
      offices: offices.map((o) => ({ key: o.key, name: o.name, chamber: o.chamber, seats: o.seats, races: mdl.races.filter((x) => x.office.id === o.id).length, two_person: o.two_person, rule: o.rule })),
      parties: [...mdl.parties.values()].filter((p) => p.active),
      featured: callAllowed(req, 'elections.results') ? feat : [],
      more_markets: more,
      power_index: callAllowed(req, 'elections.power_index') ? powerIndexVo(el.country, 7) : null,
      timeline: callAllowed(req, 'elections.timeline') ? { points: db.prepare('SELECT COUNT(*) c FROM el_snapshots WHERE election_id=?').get(el.id).c } : null,
      updated_time: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------------------------------- public routes
  const hubParam = (req) => { const el = electionBySlug(req.params.slug); if (!el) throw E.notFound(S('error.unknown_hub')); return el; };
  v1.get('/elections/hubs', (req, res) => res.json({ hubs: db.prepare('SELECT slug, title, kind, date, country FROM el_elections WHERE active=1 ORDER BY country, date').all() }));
  v1.get('/elections/hubs/:slug', (req, res) => res.json(hubVo(hubParam(req), req)));
  v1.get('/elections/hubs/:slug/view', (req, res) => {
    const el = hubParam(req);
    const mdl = model(el);
    let compact; let at = null;
    if (req.query.at) {
      if (!flags.on('elections.timeline', { req })) throw flags.disabledError('elections.timeline');
      const snap = db.prepare('SELECT * FROM el_snapshots WHERE election_id=? AND id=?').get(el.id, Number(req.query.at) || 0);
      if (!snap) throw E.notFound();
      compact = J(snap.data_json, null); at = { id: snap.id, ts: new Date(snap.ts).toISOString(), minutes: snap.minutes, kind: snap.kind, label: snap.label };
    } else compact = compactOf(mdl);
    res.json({ ...viewOf(mdl, compact, String(req.query.office || ''), { live: !at, req }), live: !at, at });
  });
  v1.get('/elections/hubs/:slug/timeline', (req, res) => {
    const el = hubParam(req);
    const rows = db.prepare('SELECT id, ts, minutes, kind, label FROM el_snapshots WHERE election_id=? ORDER BY id').all(el.id);
    res.json({ points: rows.map((r) => ({ id: r.id, ts: new Date(r.ts).toISOString(), minutes: r.minutes, kind: r.kind, label: r.label })), sim: simOf(el) });
  });
  v1.get('/elections/hubs/:slug/races', (req, res) => {
    const el = hubParam(req); const mdl = model(el);
    const office = String(req.query.office || '');
    const div = String(req.query.division || '');
    const list = mdl.races.filter((x) => (!office || x.office.key === office) && (!div || x.race.division_id === div || J(x.race.area_json, []).includes(div)));
    res.json({ races: list.slice(0, 500).map((x) => raceSummary(mdl, x, req)) });
  });
  v1.get('/elections/hubs/:slug/search', (req, res) => {
    const el = hubParam(req); const mdl = model(el);
    const q = String(req.query.q || '').normalize('NFKC').toLowerCase().trim().slice(0, 60);
    if (q.length < 2) return res.json({ states: [], races: [] });
    const states = mdl.cfg.mapUnits.filter((d) => d.name.toLowerCase().includes(q) || d.code.toLowerCase() === q).slice(0, 8).map((d) => ({ id: d.id, code: d.code, name: d.name }));
    const races = mdl.races.filter((x) => x.race.name.toLowerCase().includes(q) || x.cands.some((c) => !c.is_party && c.name.toLowerCase().includes(q))).slice(0, 12)
      .map((x) => ({ id: x.id, name: x.race.name, office: x.office.key, candidates: x.cands.filter((c) => !c.is_party && c.name.toLowerCase().includes(q)).map((c) => ({ id: c.id, name: c.name, party: c.party.short_name })) }));
    res.json({ states, races });
  });
  v1.get('/elections/races/:id', (req, res) => {
    const r = db.prepare('SELECT election_id FROM el_races WHERE id=?').get(String(req.params.id));
    const el = r && electionById(r.election_id);
    if (!el || !el.active) throw E.notFound();
    const mdl = model(el);
    res.json({ race: raceDetail(mdl, mdl.raceById.get(String(req.params.id)), req) });
  });
  v1.get('/elections/power_index/:country', (req, res) => {
    const c = String(req.params.country).toUpperCase();
    if (!db.prepare('SELECT 1 FROM el_countries WHERE code=?').get(c)) throw E.notFound();
    res.json({ power_index: powerIndexVo(c, Math.min(60, Math.max(1, Number(req.query.days) || 30))) });
  });
  // My Ballot: state → LGA → ward pickers, and the contests of a ward. Nothing about the visitor is stored unless a
  // signed-in user saves the chosen division id (never an address).
  v1.get('/elections/countries/:code/divisions', (req, res) => {
    const cfg = countryCfg(String(req.params.code).toUpperCase());
    if (!cfg) throw E.notFound();
    const parent = String(req.query.parent || '');
    const lv = cfg.config.ballot_levels;
    let list;
    if (!parent) list = cfg.ofLevel(lv[0] || cfg.config.map_level);
    else { const p = cfg.divs.get(parent); if (!p) throw E.notFound(); list = (cfg.children.get(parent) || []).map((id) => cfg.divs.get(id)).filter((d) => lv.includes(d.level)); }
    res.json({ divisions: list.sort((a, b) => a.name.localeCompare(b.name, 'en')).map((d) => ({ id: d.id, level: d.level, code: d.code, name: d.name })) });
  });
  function ballotFor(divisionId, req) {
    const d = db.prepare('SELECT country FROM el_divisions WHERE id=?').get(divisionId);
    if (!d) throw E.notFound();
    const cfg = countryCfg(d.country);
    const chain = []; let x = cfg.divs.get(divisionId); let g = 0;
    while (x && g++ < 12) { chain.unshift(x); x = x.parent ? cfg.divs.get(x.parent) : null; }
    const ids = new Set(chain.map((c) => c.id));
    const contests = [];
    for (const el of db.prepare('SELECT * FROM el_elections WHERE country=? AND active=1 ORDER BY date').all(d.country)) {
      const mdl = model(el);
      for (const r of mdl.races) {
        const area = J(r.race.area_json, []);
        if (!area.some((a) => ids.has(a))) continue;
        const sum = raceSummary(mdl, r, req);
        contests.push({ election: { slug: el.slug, title: el.title }, race_id: r.id, name: r.race.name, office: r.office.key, office_name: r.office.name, status: r.race.status, pct_reported: r.pct, event: sum.event,
          leader: sum.candidates[0] ? { name: sum.candidates[0].name, party: sum.candidates[0].party, chance: sum.candidates[0].chance } : null });
      }
    }
    return { division: { id: divisionId, level: cfg.divs.get(divisionId).level, name: cfg.divs.get(divisionId).name, chain: chain.filter((c) => c.level !== 'country').map((c) => ({ id: c.id, level: c.level, name: c.name })) }, contests };
  }
  const DIV_ID = { type: 'string', maxLen: 40, pattern: /^[A-Z]{2}(-[A-Z0-9]{1,8}){0,4}$/, required: true };
  v1.get('/elections/ballot/:division', (req, res) => { const id = String(req.params.division).toUpperCase(); if (!DIV_ID.pattern.test(id)) throw E.notFound(); res.json(ballotFor(id, req)); });
  v1.get('/users/:uid/election_ballot', (req, res) => {
    if (!req.auth) throw E.unauthorized();
    if (req.params.uid !== req.auth.user.id) throw E.forbidden('cannot access another user');
    const s = db.prepare('SELECT * FROM el_ballot_saved WHERE user_id=?').get(req.auth.user.id);
    const ok = s && db.prepare('SELECT 1 FROM el_divisions WHERE id=?').get(s.division_id);
    res.json(ok ? { saved: { division_id: s.division_id, saved_time: new Date(s.saved_ts).toISOString() }, ...ballotFor(s.division_id, req) } : { saved: null });
  });
  v1.put('/users/:uid/election_ballot', (req, res) => {
    if (!req.auth) throw E.unauthorized();
    if (req.params.uid !== req.auth.user.id) throw E.forbidden('cannot access another user');
    const b = check(req.body, { division_id: DIV_ID }, { unknown: 'reject', maxKeys: 1 });
    if (!db.prepare('SELECT 1 FROM el_divisions WHERE id=?').get(b.division_id)) throw fieldErr({ division_id: 'unknown division' });
    const t = now();
    db.prepare('INSERT INTO el_ballot_saved(user_id,division_id,saved_ts) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET division_id=excluded.division_id, saved_ts=excluded.saved_ts').run(req.auth.user.id, b.division_id, t);
    res.json({ saved: { division_id: b.division_id, saved_time: new Date(t).toISOString() }, ...ballotFor(b.division_id, req) });
  });
  v1.delete('/users/:uid/election_ballot', (req, res) => {
    if (!req.auth) throw E.unauthorized();
    if (req.params.uid !== req.auth.user.id) throw E.forbidden('cannot access another user');
    db.prepare('DELETE FROM el_ballot_saved WHERE user_id=?').run(req.auth.user.id);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------------------------------------- live nudges
  const lastPush = new Map();
  function push(el, kind, force = false) {
    modelCache.delete(el.id);
    const t = now();
    if (!force && t - (lastPush.get(el.id) || 0) < 1000) return;
    lastPush.set(el.id, t);
    engine.emit('elections', el.slug, { hub: el.slug, kind, ts: t });
  }
  engine.on('ticker', (t) => {
    // A price move on a linked market nudges its hub (debounced by the client).
    const r = db.prepare('SELECT r.election_id FROM el_race_markets rm JOIN el_races r ON r.id=rm.race_id WHERE rm.market_ticker=? UNION SELECT election_id FROM el_office_markets WHERE market_ticker=? LIMIT 1').get(t, t);
    if (r) { const el = electionById(r.election_id); if (el) push(el, 'prices'); }
  });

  // ---------------------------------------------------------------------------------------------- snapshots
  function snapshot(el, kind, label = null) {
    modelCache.delete(el.id);
    const mdl = model(el);
    const c = compactOf(mdl);
    db.prepare('INSERT INTO el_snapshots(election_id,ts,minutes,kind,label,data_json) VALUES(?,?,?,?,?,?)').run(el.id, now(), c.minutes, kind, label, JSON.stringify(c));
    const n = db.prepare('SELECT COUNT(*) c FROM el_snapshots WHERE election_id=?').get(el.id).c;
    if (n > retain) db.prepare("DELETE FROM el_snapshots WHERE id IN (SELECT id FROM el_snapshots WHERE election_id=? AND kind='tick' ORDER BY id LIMIT ?)").run(el.id, n - retain);
  }

  // ---------------------------------------------------------------------------------------------- simulator
  // Each counting unit has a deterministic schedule: collation starts T0 simulated minutes after polls close and takes
  // DUR minutes; polling units report linearly in between. Votes = reported PUs × voters per PU × turnout × the unit's
  // vote shares, drawn around the race prior (per map unit when given) with seeded noise. Integer and monotonic.
  function simUnit(seed, race, unitId, cands, prior, cfg, rep, pu, voters) {
    const k = `${seed}:${race.id}:${unitId}`;
    const mapUnit = cfg.ancestorAt(unitId, cfg.config.map_level);
    const pr = (prior.by_division && mapUnit && prior.by_division[mapUnit]) || prior.default || {};
    const w = cands.map((c) => Math.max(0.001, Number(pr[c.id]) || 0.05) * Math.exp(0.35 * gauss(h01(`${k}:${c.id}:a`), h01(`${k}:${c.id}:b`))));
    const sw = w.reduce((a, b) => a + b, 0);
    const turnout = 0.28 + h01(`${k}:to`) * 0.2;
    const perPu = voters / Math.max(1, pu);
    return { rep, votes: cands.map((c, i) => Math.round(rep * perPu * turnout * (w[i] / sw))) };
  }
  function runSim(el, minutes) {
    const cfg = countryCfg(el.country);
    const sim = simOf(el);
    let changed = 0;
    tx(db, () => {
      // Only units still counting can change (the clock only moves forward; a reset zeroes them).
      const rows = db.prepare('SELECT p.race_id, p.unit_id, p.pu_total, p.pu_reported, p.voters, r.prior_json FROM el_reporting p JOIN el_races r ON r.id=p.race_id WHERE r.election_id=? AND p.pu_reported<p.pu_total').all(el.id);
      const candsOf = new Map(); const priors = new Map();
      const upRep = db.prepare('UPDATE el_reporting SET pu_reported=?, updated_ts=? WHERE race_id=? AND unit_id=?');
      const upTal = db.prepare('INSERT INTO el_tallies(race_id,unit_id,candidate_id,votes) VALUES(?,?,?,?) ON CONFLICT(race_id,unit_id,candidate_id) DO UPDATE SET votes=excluded.votes');
      for (const u of rows) {
        const k = `${sim.seed}:${u.race_id}:${u.unit_id}`;
        const t0 = 30 + h01(`${k}:t0`) * 300; const dur = 90 + h01(`${k}:d`) * 600;
        const f = Math.max(0, Math.min(1, (minutes - t0) / dur));
        const rep = f >= 1 ? u.pu_total : Math.floor(u.pu_total * f);
        if (rep === u.pu_reported) continue;
        if (!candsOf.has(u.race_id)) { candsOf.set(u.race_id, db.prepare('SELECT id FROM el_candidates WHERE race_id=? ORDER BY sort, id').all(u.race_id)); priors.set(u.race_id, J(u.prior_json, {})); }
        const cands = candsOf.get(u.race_id);
        if (!cands.length) continue;
        const r = simUnit(sim.seed, { id: u.race_id }, u.unit_id, cands, priors.get(u.race_id), cfg, rep, u.pu_total, u.voters);
        upRep.run(rep, now(), u.race_id, u.unit_id);
        cands.forEach((c, i) => upTal.run(u.race_id, u.unit_id, c.id, r.votes[i]));
        changed += 1;
      }
      const prevSnap = Math.floor(sim.minutes / snapEveryMin);
      db.prepare('UPDATE el_elections SET sim_json=?, updated_ts=? WHERE id=?').run(JSON.stringify({ ...sim, minutes, status: minutes >= 24 * 60 && sim.status === 'running' ? 'complete' : sim.status }), now(), el.id);
      sim.crossed = Math.floor(minutes / snapEveryMin) > prevSnap;
    });
    const fresh = electionById(el.id);
    if (changed) push(fresh, 'results');
    if (changed && sim.crossed) snapshot(fresh, 'tick');
    return changed;
  }
  let lastTick = 0;
  engine.on('tick', () => {
    const t = now(); const dt = lastTick ? Math.min(5000, t - lastTick) : 0; lastTick = t;
    if (!flags.jobOn('elections.simulator')) return;
    for (const el of db.prepare("SELECT * FROM el_elections WHERE active=1 AND json_extract(sim_json,'$.status')='running'").all()) {
      try { const sim = simOf(el); runSim(el, sim.minutes + (dt / 60000) * sim.speed); } catch (e) { console.error('elections sim', e); }
    }
  });

  // ---------------------------------------------------------------------------------------------- results desk
  const staffWith = (perm) => db.prepare('SELECT * FROM users WHERE is_admin=1 OR id IN (SELECT user_id FROM admin_roles)').all().filter((u) => admin.rolesOf(u).some((r) => (ROLE_PERMS[r] || []).includes(perm)));
  const raceRow = (id) => { const r = db.prepare('SELECT * FROM el_races WHERE id=?').get(String(id || '')); if (!r) throw E.notFound(); return r; };
  // Validates a call against the reported results and the office's win rule.
  function validateCall(r, b) {
    const el = electionById(r.election_id); const mdl = model(el); const x = mdl.raceById.get(r.id);
    if (b.action === 'uncall') { if (r.status === 'open') throw E.conflict('not_called', S('error.race_not_called')); return { el, x }; }
    if (r.status !== 'open') throw E.conflict('already_called', S('error.race_called'));
    if (b.outcome === 'runoff') {
      if (x.office.rule.on_fail !== 'runoff') throw E.conflict('no_runoff_rule', S('error.no_runoff_rule'));
      if (!(x.pu_total && x.pu_reported >= x.pu_total) || x.rule.candidates.some((c) => c.meets)) throw E.conflict('runoff_not_due', S('error.runoff_not_due'));
      return { el, x };
    }
    const c = x.byId.get(String(b.candidate_id || ''));
    if (!c) throw fieldErr({ candidate_id: 'choose a candidate of this race' });
    if (!x.total) throw E.conflict('no_results', S('error.no_results'));
    const rc = x.rule.candidates.find((k) => k.candidate_id === c.id);
    if (!rc || !rc.meets) {
      const detail = x.rule.leader !== c.id ? S('rule.not_leading') : rc && !rc.territory_ok ? S('rule.territory_short') : S('rule.spread_short', { count: rc ? rc.count : 0, needed: x.rule.needed });
      throw new ApiError(409, 'rule_not_met', S('error.rule_not_met', { candidate: c.name, detail }), detail);
    }
    return { el, x, c };
  }
  // A settlement proposal on the resolution desk (res_approvals, CLONE_SPEC.md §28.7): a second admin with
  // resolution.write approves it there; nothing resolves before that.
  function propose(uid, ticker, result, note, reason) {
    const m = db.prepare('SELECT ticker, status, settlement_timer_seconds FROM markets WHERE ticker=?').get(ticker);
    if (!m || !['active', 'inactive', 'closed'].includes(m.status)) return null;
    const t = now();
    db.prepare("UPDATE res_approvals SET status='rejected', decided_by=?, decided_ts=?, decision_note=? WHERE market_ticker=? AND status='pending'").run(uid, t, 'superseded by a results-desk call', ticker);
    const id = newId('ra_');
    db.prepare('INSERT INTO res_approvals(id,kind,market_ticker,payload,reason,status,requested_by,requested_ts) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, 'resolve', ticker, JSON.stringify({ result, expiration_value: null, source_note: note.slice(0, 1000), settlement_delay_sec: m.settlement_timer_seconds }), reason, 'pending', uid, t);
    return { approval_id: id, market_ticker: ticker, result };
  }
  function proposalsForCall(uid, x, outcome, winner, reason) {
    const note = S('source.note', { race: x.race.name, outcome: outcome === 'runoff' ? S('outcome.runoff') : winner.name, reason });
    const out = [];
    for (const m of x.markets) {
      if (m.kind === 'winner' && outcome !== 'runoff') { const p = propose(uid, m.ticker, m.candidate_id === winner.id ? 'yes' : 'no', note, reason); if (p) out.push(p); }
      if (m.kind === 'runoff') { const p = propose(uid, m.ticker, outcome === 'runoff' ? 'yes' : 'no', note, reason); if (p) out.push(p); }
    }
    return out;
  }
  // Chamber control: once every race of a chamber office in the election is called, propose its control markets.
  function controlProposals(uid, el, officeId, reason) {
    const mdl = model(el);
    const rs = mdl.races.filter((x) => x.office.id === officeId);
    if (!rs.length || rs.some((x) => x.race.status !== 'called')) return [];
    const seats = holdovers(mdl, officeId);
    for (const x of rs) { const p = x.byId.get(x.race.winner_candidate_id)?.party_id; if (p) seats[p] = (seats[p] || 0) + 1; }
    const top = Object.entries(seats).sort((a, b) => b[1] - a[1]);
    if (!top.length || (top[1] && top[1][1] === top[0][1])) return [];
    const out = [];
    for (const m of mdl.officeMarkets.get(officeId) || []) { if (m.kind !== 'control') continue; const p = propose(uid, m.ticker, m.party_id === top[0][0] ? 'yes' : 'no', S('source.note', { race: mdl.offices.get(officeId).name, outcome: mdl.parties.get(top[0][0])?.short_name || top[0][0], reason }), reason); if (p) out.push(p); }
    return out;
  }
  function executeCall(req, r, b, { approvedBy = null, callId = null } = {}) {
    const actor = callId ? db.prepare('SELECT requested_by FROM el_calls WHERE id=?').get(callId).requested_by : req.auth.user.id;
    const v = validateCall(r, b);
    const before = { status: r.status, winner_candidate_id: r.winner_candidate_id };
    let proposals = [];
    tx(db, () => {
      if (b.action === 'uncall') {
        const done = v.x.markets.find((m) => ['determined', 'finalized'].includes(m.status) && ['winner', 'runoff'].includes(m.kind));
        if (done) throw E.conflict('settlement_executed', S('error.settlement_executed'), done.ticker);
        for (const m of v.x.markets) db.prepare("UPDATE res_approvals SET status='rejected', decided_by=?, decided_ts=?, decision_note=? WHERE market_ticker=? AND status='pending'").run(req.auth.user.id, now(), `race uncalled: ${b.reason}`.slice(0, 500), m.ticker);
        for (const m of v.el ? (model(v.el).officeMarkets.get(r.office_id) || []) : []) db.prepare("UPDATE res_approvals SET status='rejected', decided_by=?, decided_ts=?, decision_note=? WHERE market_ticker=? AND status='pending'").run(req.auth.user.id, now(), `race uncalled: ${b.reason}`.slice(0, 500), m.ticker);
        db.prepare("UPDATE el_races SET status='open', winner_candidate_id=NULL, called_ts=NULL, called_by=NULL, updated_ts=? WHERE id=?").run(now(), r.id);
      } else {
        const status = b.outcome === 'runoff' ? 'runoff' : 'called';
        db.prepare('UPDATE el_races SET status=?, winner_candidate_id=?, called_ts=?, called_by=?, updated_ts=? WHERE id=?').run(status, v.c ? v.c.id : null, now(), actor, now(), r.id);
        proposals = proposalsForCall(actor, v.x, b.outcome, v.c, b.reason);
        modelCache.delete(v.el.id);
        if (v.x.office.chamber) proposals.push(...controlProposals(actor, v.el, r.office_id, b.reason));
      }
      if (callId) db.prepare("UPDATE el_calls SET status='done', decided_by=?, decided_ts=?, proposals_json=? WHERE id=?").run(approvedBy, now(), JSON.stringify(proposals), callId);
      else db.prepare('INSERT INTO el_calls(id,race_id,action,outcome,candidate_id,reason,status,requested_by,requested_ts,decided_by,decided_ts,proposals_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(newId('ec_'), r.id, b.action, b.outcome || null, v.c ? v.c.id : null, b.reason, 'done', actor, now(), actor, now(), JSON.stringify(proposals));
    });
    const after = db.prepare('SELECT status, winner_candidate_id FROM el_races WHERE id=?').get(r.id);
    admin.audit(req, b.action === 'uncall' ? 'elections.uncall' : 'elections.call', 'election_race', r.id, before, { ...after, outcome: b.outcome || null, proposals, approved_by: approvedBy ? emailOf(approvedBy) : null, requested_by: emailOf(actor) }, b.reason);
    if (proposals.length) for (const u of staffWith('resolution.write')) if (u.id !== actor) feat.notify(u.id, { type: 'admin_approval', title: S('notify.settlement.title', { race: r.name }), body: S('notify.settlement.body', { race: r.name, count: proposals.length }), link: '/admin/resolution' });
    const el = electionById(r.election_id);
    const label = b.action === 'uncall' ? `${r.name}` : b.outcome === 'runoff' ? `${r.name}` : `${r.name}: ${v.c.name}`;
    snapshot(el, b.action, label.slice(0, 120));
    push(el, 'call', true);
    return { race: raceDetail(model(el), model(el).raceById.get(r.id), req), proposals };
  }
  const CALL = { outcome: { type: 'string', enum: ['winner', 'runoff'] }, candidate_id: { type: 'string', maxLen: 64 }, reason: { type: 'string', maxLen: 500, required: true } };
  function callRoute(action) {
    return (req, res) => {
      const r = raceRow(req.params.id);
      const b = check(req.body || {}, action === 'call' ? CALL : { reason: CALL.reason }, { unknown: 'reject' });
      const body = { action, outcome: action === 'call' ? (b.outcome || 'winner') : null, candidate_id: b.candidate_id, reason: reasonOf(b) };
      validateCall(r, body);
      auth.assertFresh(req, 'election_call'); // step-up (CLONE_SPEC.md §22.6)
      const office = db.prepare('SELECT two_person FROM el_offices WHERE id=?').get(r.office_id);
      if (office && office.two_person) {
        if (db.prepare("SELECT 1 FROM el_calls WHERE race_id=? AND status='pending' AND requested_ts>?").get(r.id, now() - CALL_TTL_MS)) throw E.conflict('call_pending', S('error.call_pending'));
        const id = newId('ec_');
        db.prepare('INSERT INTO el_calls(id,race_id,action,outcome,candidate_id,reason,status,requested_by,requested_ts) VALUES(?,?,?,?,?,?,?,?,?)').run(id, r.id, action, body.outcome, body.candidate_id || null, body.reason, 'pending', req.auth.user.id, now());
        const c = db.prepare('SELECT * FROM el_calls WHERE id=?').get(id);
        admin.audit(req, `elections.${action}.requested`, 'election_race', r.id, null, callVo(c), body.reason);
        for (const u of staffWith('resolution.write')) if (u.id !== req.auth.user.id) feat.notify(u.id, { type: 'admin_approval', title: S('notify.call_pending.title', { race: r.name }), body: S('notify.call_pending.body', { who: req.auth.user.email, action: S(`action.${action}`), race: r.name }), link: '/admin/elections/desk' });
        push(electionById(r.election_id), 'call', true);
        return res.status(202).json({ status: 'pending_approval', call: callVo(c) });
      }
      res.json(executeCall(req, r, body));
    };
  }
  const A = '/admin/elections';
  v1.post(`${A}/races/:id/call`, can('resolution.write'), callRoute('call'));
  v1.post(`${A}/races/:id/uncall`, can('resolution.write'), callRoute('uncall'));
  v1.get(`${A}/calls`, can('catalog.read'), (req, res) => {
    db.prepare("UPDATE el_calls SET status='expired' WHERE status='pending' AND requested_ts<=?").run(now() - CALL_TTL_MS);
    const st = String(req.query.status || 'pending');
    if (!['pending', 'done', 'rejected', 'expired', 'all'].includes(st)) throw E.badRequest('status must be pending, done, rejected, expired or all');
    const rows = db.prepare(`SELECT c.*, r.name race_name FROM el_calls c JOIN el_races r ON r.id=c.race_id ${st === 'all' ? '' : 'WHERE c.status=?'} ORDER BY c.requested_ts DESC LIMIT 200`).all(...(st === 'all' ? [] : [st]));
    res.json({ calls: rows.map((c) => ({ ...callVo(c), race_name: c.race_name })) });
  });
  const pendingCall = (id) => {
    const c = db.prepare('SELECT * FROM el_calls WHERE id=?').get(String(id));
    if (!c) throw E.notFound();
    if (c.status === 'pending' && c.requested_ts <= now() - CALL_TTL_MS) { db.prepare("UPDATE el_calls SET status='expired' WHERE id=?").run(c.id); c.status = 'expired'; }
    if (c.status !== 'pending') throw E.conflict('call_closed', S('error.call_closed', { status: c.status }));
    return c;
  };
  v1.post(`${A}/calls/:id/approve`, can('resolution.write'), (req, res) => {
    const c = pendingCall(req.params.id);
    if (c.requested_by === req.auth.user.id) throw E.conflict('same_person', S('error.same_person'));
    const note = String((req.body || {}).note || '').trim().slice(0, 500);
    auth.assertFresh(req, 'election_call');
    const out = executeCall(req, raceRow(c.race_id), { action: c.action, outcome: c.outcome, candidate_id: c.candidate_id, reason: c.reason }, { approvedBy: req.auth.user.id, callId: c.id });
    if (note) db.prepare('UPDATE el_calls SET note=? WHERE id=?').run(note, c.id);
    res.json({ call: callVo(db.prepare('SELECT * FROM el_calls WHERE id=?').get(c.id)), ...out });
  });
  v1.post(`${A}/calls/:id/reject`, can('resolution.write'), (req, res) => {
    const c = pendingCall(req.params.id);
    const note = String((req.body || {}).note || '').trim();
    if (note.length < 3 || note.length > 500) throw new ApiError(400, 'validation_failed', 'validation failed', 'note: give a reason of 3-500 characters');
    db.prepare("UPDATE el_calls SET status='rejected', decided_by=?, decided_ts=?, note=? WHERE id=?").run(req.auth.user.id, now(), note, c.id);
    admin.audit(req, `elections.${c.action}.rejected`, 'election_race', c.race_id, callVo(c), null, note);
    feat.notify(c.requested_by, { type: 'admin_approval', title: S('notify.call_pending.title', { race: raceRow(c.race_id).name }), body: note, link: '/admin/elections/desk' });
    push(electionById(raceRow(c.race_id).election_id), 'call', true);
    res.json({ call: callVo(db.prepare('SELECT * FROM el_calls WHERE id=?').get(c.id)) });
  });

  // ---------------------------------------------------------------------------------------------- admin: overview + desk
  v1.get(A, can('catalog.read'), (req, res) => {
    const els = db.prepare('SELECT * FROM el_elections ORDER BY country, date').all();
    res.json({
      countries: db.prepare('SELECT * FROM el_countries ORDER BY code').all().map((c) => ({ code: c.code, name: c.name, currency: c.currency, time_zone: c.time_zone, locale: c.locale, active: !!c.active, config: J(c.config_json, {}),
        divisions: db.prepare('SELECT level, COUNT(*) n FROM el_divisions WHERE country=? GROUP BY level').all(c.code) })),
      elections: els.map((el) => ({ id: el.id, slug: el.slug, title: el.title, country: el.country, kind: el.kind, date: el.date, active: !!el.active, sim: simOf(el), config: J(el.config_json, {}),
        races: db.prepare('SELECT COUNT(*) c FROM el_races WHERE election_id=?').get(el.id).c, called: db.prepare("SELECT COUNT(*) c FROM el_races WHERE election_id=? AND status<>'open'").get(el.id).c,
        snapshots: db.prepare('SELECT COUNT(*) c FROM el_snapshots WHERE election_id=?').get(el.id).c })),
      simulator_flag: flags.jobOn('elections.simulator'), pending_calls: db.prepare("SELECT COUNT(*) c FROM el_calls WHERE status='pending' AND requested_ts>?").get(now() - CALL_TTL_MS).c,
    });
  });
  v1.get(`${A}/elections/:id/desk`, can('catalog.read'), (req, res) => {
    const el = electionById(req.params.id); if (!el) throw E.notFound();
    const mdl = model(el);
    const office = String(req.query.office || '');
    res.json({ election: { id: el.id, slug: el.slug, title: el.title }, races: mdl.races.filter((x) => !office || x.office.key === office).map((x) => ({ ...raceSummary(mdl, x, req), two_person: x.office.two_person, rule: x.rule,
      pending: db.prepare("SELECT id FROM el_calls WHERE race_id=? AND status='pending' AND requested_ts>?").get(x.id, now() - CALL_TTL_MS)?.id || null })) });
  });
  v1.put(`${A}/elections/:id/simulator`, can('markets.ops'), (req, res) => {
    const el = electionById(req.params.id); if (!el) throw E.notFound();
    const b = check(req.body || {}, { action: { type: 'string', enum: ['start', 'pause', 'advance', 'reset', 'speed'], required: true }, minutes: { type: 'number', min: 0, max: 2880 }, speed: { type: 'number', min: 1, max: 100000 }, reason: { type: 'string', maxLen: 500, required: true } }, { unknown: 'reject' });
    const reason = reasonOf(b);
    if (!flags.jobOn('elections.simulator')) throw new ApiError(403, 'feature_disabled', S('error.simulator_off'), 'elections.simulator');
    const before = simOf(el);
    let sim = { ...before };
    if (b.action === 'reset') {
      if (db.prepare("SELECT 1 FROM el_races WHERE election_id=? AND status<>'open'").get(el.id)) throw E.conflict('race_called', S('error.race_called'));
      tx(db, () => {
        db.prepare('UPDATE el_reporting SET pu_reported=0, updated_ts=? WHERE race_id IN (SELECT id FROM el_races WHERE election_id=?)').run(now(), el.id);
        db.prepare('DELETE FROM el_tallies WHERE race_id IN (SELECT id FROM el_races WHERE election_id=?)').run(el.id);
        db.prepare('DELETE FROM el_snapshots WHERE election_id=?').run(el.id);
      });
      sim = { ...sim, status: 'idle', minutes: 0 };
    }
    if (b.action === 'start') sim.status = 'running';
    if (b.action === 'pause') sim.status = 'paused';
    if (b.action === 'speed') { if (!b.speed) throw fieldErr({ speed: 'simulated minutes per real minute (1-100000)' }); sim.speed = b.speed; }
    db.prepare('UPDATE el_elections SET sim_json=?, updated_ts=? WHERE id=?').run(JSON.stringify(sim), now(), el.id);
    let fresh = electionById(el.id);
    if (b.action === 'start' && !db.prepare('SELECT 1 FROM el_snapshots WHERE election_id=?').get(el.id)) snapshot(fresh, 'start');
    if (b.action === 'advance') {
      if (!b.minutes) throw fieldErr({ minutes: 'simulated minutes to advance (1-2880)' });
      runSim(fresh, simOf(fresh).minutes + b.minutes);
      fresh = electionById(el.id);
      snapshot(fresh, 'tick');
    }
    admin.audit(req, `elections.simulator.${b.action}`, 'election', el.id, before, simOf(fresh), reason);
    push(fresh, 'results', true);
    res.json({ sim: simOf(fresh) });
  });
  v1.get(`${A}/power_index/:country`, can('catalog.read'), (req, res) => res.json({ formula: piCfg(String(req.params.country).toUpperCase()), power_index: powerIndexVo(String(req.params.country).toUpperCase(), 7) }));
  v1.put(`${A}/power_index/:country`, can('settings.write'), (req, res) => {
    const c = String(req.params.country).toUpperCase();
    if (!db.prepare('SELECT 1 FROM el_countries WHERE code=?').get(c)) throw E.notFound();
    const b = check(req.body || {}, { enabled: { type: 'boolean' }, label_pos: { type: 'string', maxLen: 60 }, label_neg: { type: 'string', maxLen: 60 }, offset: { type: 'number', min: -1000, max: 1000 }, scale: { type: 'number', min: 1, max: 100 },
      terms: { type: 'array', maxItems: 20 }, reason: { type: 'string', maxLen: 500, required: true } }, { unknown: 'reject' });
    const reason = reasonOf(b);
    const errs = {};
    const terms = b.terms === undefined ? undefined : b.terms.map((t, i) => {
      if (!t || typeof t !== 'object' || typeof t.ticker !== 'string' || !Number.isFinite(Number(t.weight)) || Math.abs(Number(t.weight)) > 100) { errs[`terms.${i}`] = 'ticker and a weight between -100 and 100'; return null; }
      if (!db.prepare('SELECT 1 FROM markets WHERE ticker=?').get(t.ticker.toUpperCase())) { errs[`terms.${i}`] = S('error.unknown_market', { ticker: t.ticker }); return null; }
      return { ticker: t.ticker.toUpperCase(), weight: Number(t.weight) };
    });
    for (const k of ['label_pos', 'label_neg']) if (b[k] !== undefined && !PLAIN.test(b[k])) errs[k] = 'plain text only';
    if (Object.keys(errs).length) throw fieldErr(errs);
    const before = piCfg(c);
    const after = { ...before, ...Object.fromEntries(Object.entries({ enabled: b.enabled, label_pos: b.label_pos, label_neg: b.label_neg, offset: b.offset, scale: b.scale, terms }).filter(([, v]) => v !== undefined)) };
    admin.putSetting(PI_KEY(c), after, req.auth.user.id);
    admin.audit(req, 'elections.power_index', 'settings', PI_KEY(c), before, after, reason);
    for (const el of db.prepare('SELECT * FROM el_elections WHERE country=?').all(c)) push(el, 'config', true);
    res.json({ formula: after, power_index: powerIndexVo(c, 7) });
  });

  // ---------------------------------------------------------------------------------------------- admin: data (CRUD)
  // One schema per entity kind; every change needs a reason and is audited (before / after). Admin-entered names are
  // plain text (rejected if they contain markup or control characters) and escaped wherever they are shown.
  const name = (max = 80) => ({ type: 'string', maxLen: max, pattern: PLAIN });
  const SCHEMAS = {
    countries: { code: { type: 'string', pattern: /^[A-Z]{2}$/ }, name: name(), currency: { type: 'string', pattern: /^[A-Z]{3}$/ }, time_zone: { type: 'string', maxLen: 60 }, locale: { type: 'string', pattern: /^[a-z]{2,3}(-[A-Z]{2})?$/ }, config: { type: 'object' }, active: { type: 'boolean' } },
    divisions: { country: { type: 'string', pattern: /^[A-Z]{2}$/ }, level: { type: 'string', pattern: /^[a-z_]{2,20}$/ }, code: { type: 'string', pattern: /^[A-Z0-9]{1,8}$/ }, name: name(), parent_id: { type: 'string', maxLen: 40 }, data: { type: 'object' }, sort: { type: 'integer', min: 0, max: 100000 } },
    offices: { country: { type: 'string', pattern: /^[A-Z]{2}$/ }, key: { type: 'string', pattern: /^[a-z_]{2,20}$/ }, name: name(), level: { type: 'string', pattern: /^[a-z_]{2,20}$/ }, seats: { type: 'integer', min: 1, max: 100000 }, chamber: { type: 'boolean' }, two_person: { type: 'boolean' }, rule: { type: 'object' }, sort: { type: 'integer', min: 0, max: 1000 } },
    parties: { country: { type: 'string', pattern: /^[A-Z]{2}$/ }, code: { type: 'string', pattern: /^[A-Z0-9]{2,6}$/ }, name: name(), short_name: name(12), color: { type: 'string', pattern: COLOR }, logo_media_id: { type: 'string', maxLen: 64, nullable: true }, coalition: { ...name(), nullable: true }, active: { type: 'boolean' }, sort: { type: 'integer', min: 0, max: 1000 } },
    candidates: { race_id: { type: 'string', maxLen: 64 }, party_id: { type: 'string', maxLen: 64 }, name: { ...name(), nullable: true }, photo_media_id: { type: 'string', maxLen: 64, nullable: true }, running_mate: { ...name(), nullable: true }, sort: { type: 'integer', min: 0, max: 1000 } },
    elections: { country: { type: 'string', pattern: /^[A-Z]{2}$/ }, slug: { type: 'string', pattern: /^[a-z0-9][a-z0-9-]{2,40}$/ }, title: name(120), kind: { type: 'string', enum: ['general', 'off_cycle', 'by_election', 'referendum'] }, date: { type: 'string', pattern: /^\d{4}-\d{2}-\d{2}$/ }, config: { type: 'object' }, active: { type: 'boolean' } },
    races: { election_id: { type: 'string', maxLen: 64 }, office_id: { type: 'string', maxLen: 64 }, division_id: { type: 'string', maxLen: 40 }, seat: { type: 'integer', min: 0, max: 1000 }, name: name(120), area: { type: 'array', maxItems: 20000 }, prior: { type: 'object' }, date: { type: 'string', pattern: /^\d{4}-\d{2}-\d{2}$/, nullable: true }, featured: { type: 'boolean' }, sort: { type: 'integer', min: 0, max: 100000 }, markets: { type: 'array', maxItems: 40 } },
  };
  const REQUIRED = { countries: ['code', 'name', 'currency', 'time_zone', 'locale'], divisions: ['country', 'level', 'code', 'name'], offices: ['country', 'key', 'name', 'level', 'seats'], parties: ['country', 'code', 'name', 'short_name', 'color'],
    candidates: ['race_id', 'party_id'], elections: ['country', 'slug', 'title', 'kind', 'date'], races: ['election_id', 'office_id', 'division_id', 'name'] };
  const IMMUTABLE = { countries: ['code'], divisions: ['country', 'level', 'code', 'parent_id'], offices: ['country', 'key'], parties: ['country', 'code'], candidates: ['race_id'], elections: ['country', 'slug'], races: ['election_id', 'office_id'] };
  const TABLE = { countries: ['el_countries', 'code'], divisions: ['el_divisions', 'id'], offices: ['el_offices', 'id'], parties: ['el_parties', 'id'], candidates: ['el_candidates', 'id'], elections: ['el_elections', 'id'], races: ['el_races', 'id'] };
  const kindParam = (k) => { if (!KINDS.includes(k)) throw E.notFound(); return k; };
  function validRule(rule) {
    if (!rule || typeof rule !== 'object') return 'a rule object';
    if (!['plurality', 'spread'].includes(rule.type)) return 'type must be plurality or spread';
    if (rule.type === 'spread') {
      if (!(Number(rule.share) > 0 && Number(rule.share) < 1)) return 'share must be between 0 and 1';
      if (!Array.isArray(rule.fraction) || rule.fraction.length !== 2 || !rule.fraction.every((n) => Number.isInteger(n) && n > 0) || rule.fraction[0] > rule.fraction[1]) return 'fraction must be [numerator, denominator]';
      if (typeof rule.unit !== 'string' || !/^[a-z_]{2,20}$/.test(rule.unit)) return 'unit must be a division level';
      if (rule.on_fail && !['runoff', 'none'].includes(rule.on_fail)) return 'on_fail must be runoff or none';
    }
    return null;
  }
  const rowVo = (kind, r) => {
    if (!r) return null;
    const o = { ...r };
    for (const k of Object.keys(o)) if (k.endsWith('_json')) { o[k.slice(0, -5)] = J(o[k], null); delete o[k]; }
    if (kind === 'parties') { o.logo_url = mediaUrl(r.logo_media_id); }
    if (kind === 'candidates') o.photo_url = mediaUrl(r.photo_media_id);
    if (kind === 'races') { o.markets = db.prepare('SELECT * FROM el_race_markets WHERE race_id=?').all(r.id); delete o.area; o.area_size = J(r.area_json, []).length; }
    if (kind === 'elections') o.sim = simOf(r);
    return o;
  };
  v1.get(`${A}/:kind`, can('catalog.read'), (req, res, next) => {
    if (!KINDS.includes(req.params.kind)) return next();
    const kind = req.params.kind; const [table] = TABLE[kind];
    const where = []; const args = [];
    for (const [qk, col] of [['country', 'country'], ['parent', 'parent_id'], ['level', 'level'], ['election', 'election_id'], ['race', 'race_id'], ['office', 'office_id']]) {
      if (req.query[qk] && ['country', 'parent_id', 'level', 'election_id', 'race_id', 'office_id'].includes(col) && db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name=?`).get(col)) { where.push(`${col}=?`); args.push(String(req.query[qk])); }
    }
    const q = String(req.query.q || '').trim();
    if (q) { where.push("name LIKE ? ESCAPE '\\'"); args.push(`%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`); }
    const rows = db.prepare(`SELECT * FROM ${table} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${kind === 'countries' ? 'code' : 'sort, rowid'} LIMIT 500`).all(...args);
    res.json({ [kind]: rows.map((r) => rowVo(kind, r)) });
  });
  function applyEntity(req, kind, id, b) {
    const errs = {};
    const media = (k) => { if (b[k] != null && !mediaUrl(b[k])) errs[k] = S('error.unknown_media'); };
    if (kind === 'countries') {
      if (b.time_zone !== undefined) { try { new Intl.DateTimeFormat('en', { timeZone: b.time_zone }); } catch { errs.time_zone = 'unknown time zone'; } }
      if (b.config !== undefined && (!Array.isArray(b.config.levels) || typeof b.config.map_level !== 'string')) errs.config = 'levels[] and map_level are required';
    }
    if (kind === 'offices' && b.rule !== undefined) { const p = validRule(b.rule); if (p) errs.rule = p; }
    if (kind === 'parties') media('logo_media_id');
    if (kind === 'candidates') {
      media('photo_media_id');
      const race = b.race_id ? db.prepare('SELECT r.id, e.country FROM el_races r JOIN el_elections e ON e.id=r.election_id WHERE r.id=?').get(b.race_id) : null;
      if (b.race_id !== undefined && !race) errs.race_id = 'unknown race';
      const rid = race ? race.id : id ? db.prepare('SELECT race_id FROM el_candidates WHERE id=?').get(id)?.race_id : null;
      const country = rid ? db.prepare('SELECT e.country FROM el_races r JOIN el_elections e ON e.id=r.election_id WHERE r.id=?').get(rid)?.country : null;
      if (b.party_id !== undefined && !db.prepare('SELECT 1 FROM el_parties WHERE id=? AND country=?').get(b.party_id, country)) errs.party_id = 'unknown party for this country';
    }
    if (kind === 'divisions' && b.parent_id !== undefined && b.parent_id !== null && !db.prepare('SELECT 1 FROM el_divisions WHERE id=? AND country=?').get(b.parent_id, b.country)) errs.parent_id = 'unknown parent division';
    if (['divisions', 'offices', 'parties', 'elections'].includes(kind) && b.country !== undefined && !db.prepare('SELECT 1 FROM el_countries WHERE code=?').get(b.country)) errs.country = 'unknown country';
    if (kind === 'races') {
      const el = b.election_id ? electionById(b.election_id) : id ? electionById(db.prepare('SELECT election_id FROM el_races WHERE id=?').get(id)?.election_id) : null;
      if (!el) errs.election_id = 'unknown election';
      if (b.office_id !== undefined && el && !db.prepare('SELECT 1 FROM el_offices WHERE id=? AND country=?').get(b.office_id, el.country)) errs.office_id = 'unknown office for this country';
      if (b.division_id !== undefined && el && !db.prepare('SELECT 1 FROM el_divisions WHERE id=? AND country=?').get(b.division_id, el.country)) errs.division_id = 'unknown division for this country';
      if (b.area !== undefined && (!b.area.every((a) => typeof a === 'string') || (el && b.area.some((a) => !countryCfg(el.country)?.divs.has(a))))) errs.area = 'division ids of this country';
      if (b.markets !== undefined) for (const [i, m] of b.markets.entries()) {
        if (!m || typeof m.ticker !== 'string' || !['winner', 'runoff'].includes(m.kind)) { errs[`markets.${i}`] = 'ticker and kind winner or runoff'; continue; }
        if (!db.prepare('SELECT 1 FROM markets WHERE ticker=?').get(m.ticker)) errs[`markets.${i}`] = S('error.unknown_market', { ticker: m.ticker });
      }
    }
    if (Object.keys(errs).length) throw fieldErr(errs);
  }
  const COLS = { countries: { name: 'name', currency: 'currency', time_zone: 'time_zone', locale: 'locale', config: 'config_json', active: 'active' },
    divisions: { name: 'name', data: 'data_json', sort: 'sort' }, offices: { name: 'name', level: 'level', seats: 'seats', chamber: 'chamber', two_person: 'two_person', rule: 'rule_json', sort: 'sort' },
    parties: { name: 'name', short_name: 'short_name', color: 'color', logo_media_id: 'logo_media_id', coalition: 'coalition', active: 'active', sort: 'sort' },
    candidates: { party_id: 'party_id', name: 'name', photo_media_id: 'photo_media_id', running_mate: 'running_mate', sort: 'sort' },
    elections: { title: 'title', kind: 'kind', date: 'date', config: 'config_json', active: 'active' },
    races: { division_id: 'division_id', seat: 'seat', name: 'name', area: 'area_json', prior: 'prior_json', date: 'date', featured: 'featured', sort: 'sort' } };
  const dbVal = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
  function afterChange(kind, row) {
    const country = row.country || (kind === 'candidates' || kind === 'races' ? db.prepare(`SELECT e.country FROM el_races r JOIN el_elections e ON e.id=r.election_id WHERE r.id=?`).get(kind === 'races' ? row.id : row.race_id)?.country : null);
    invalidate(kind === 'countries' ? row.code : country);
    for (const el of db.prepare('SELECT * FROM el_elections WHERE country=?').all(country || row.code || '')) push(el, 'config', true);
  }
  v1.post(`${A}/:kind`, can('catalog.write'), (req, res, next) => {
    if (!KINDS.includes(req.params.kind)) return next();
    const kind = kindParam(req.params.kind);
    const b = check(req.body || {}, { ...SCHEMAS[kind], reason: { type: 'string', maxLen: 500, required: true } }, { unknown: 'reject' });
    const reason = reasonOf(b);
    const miss = REQUIRED[kind].filter((k) => b[k] === undefined || b[k] === '');
    if (miss.length) throw fieldErr(Object.fromEntries(miss.map((k) => [k, 'is required'])));
    applyEntity(req, kind, null, b);
    const t = now(); const [table, pk] = TABLE[kind];
    let id;
    tx(db, () => {
      if (kind === 'countries') { id = b.code; if (db.prepare('SELECT 1 FROM el_countries WHERE code=?').get(id)) throw E.conflict('exists', 'country exists'); db.prepare('INSERT INTO el_countries(code,name,currency,time_zone,locale,config_json,active,created_ts,updated_ts) VALUES(?,?,?,?,?,?,?,?,?)').run(id, b.name, b.currency, b.time_zone, b.locale, JSON.stringify(b.config || { levels: [{ key: 'state' }], map_level: 'state', ballot_levels: ['state'] }), b.active === false ? 0 : 1, t, t); }
      if (kind === 'divisions') { id = b.parent_id ? `${b.parent_id}-${b.code}` : `${b.country}-${b.code}`; if (!id.startsWith(b.country)) id = `${b.country}-${b.code}`; db.prepare('INSERT INTO el_divisions(id,country,level,code,name,parent_id,data_json,sort,updated_ts) VALUES(?,?,?,?,?,?,?,?,?)').run(id, b.country, b.level, b.code, b.name, b.parent_id || null, JSON.stringify(b.data || {}), b.sort || 0, t); }
      if (kind === 'offices') { id = `${b.country}-${b.key}`; db.prepare('INSERT INTO el_offices(id,country,key,name,level,seats,chamber,two_person,rule_json,sort,updated_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, b.country, b.key, b.name, b.level, b.seats, b.chamber ? 1 : 0, b.two_person ? 1 : 0, JSON.stringify(b.rule || { type: 'plurality' }), b.sort || 0, t); }
      if (kind === 'parties') { id = `${b.country}-${b.code}`; db.prepare('INSERT INTO el_parties(id,country,code,name,short_name,color,logo_media_id,coalition,sort,active,updated_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, b.country, b.code, b.name, b.short_name, b.color, b.logo_media_id || null, b.coalition || null, b.sort || 0, b.active === false ? 0 : 1, t); }
      if (kind === 'candidates') { id = newId('elc_'); db.prepare('INSERT INTO el_candidates(id,race_id,party_id,name,photo_media_id,running_mate,sort,updated_ts) VALUES(?,?,?,?,?,?,?,?)').run(id, b.race_id, b.party_id, b.name || null, b.photo_media_id || null, b.running_mate || null, b.sort || 0, t); }
      if (kind === 'elections') { id = newId('ele_'); db.prepare('INSERT INTO el_elections(id,country,slug,title,kind,date,config_json,sim_json,active,created_ts,updated_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, b.country, b.slug, b.title, b.kind, b.date, JSON.stringify(b.config || {}), JSON.stringify({ status: 'idle', minutes: 0, seed: Math.floor(Math.random() * 1e9) }), b.active === false ? 0 : 1, t, t); }
      if (kind === 'races') {
        id = newId('elr_');
        const el = electionById(b.election_id);
        db.prepare('INSERT INTO el_races(id,election_id,office_id,division_id,seat,name,area_json,prior_json,date,status,featured,sort,updated_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, b.election_id, b.office_id, b.division_id, b.seat || 0, b.name, JSON.stringify(b.area || [b.division_id]), JSON.stringify(b.prior || {}), b.date || null, 'open', b.featured ? 1 : 0, b.sort || 0, t);
        for (const m of b.markets || []) db.prepare('INSERT OR REPLACE INTO el_race_markets(race_id,market_ticker,kind,candidate_id,party_id) VALUES(?,?,?,?,?)').run(id, m.ticker, m.kind, m.candidate_id || null, m.party_id || null);
        ensureReporting(el, db.prepare('SELECT * FROM el_races WHERE id=?').get(id));
      }
    });
    const row = db.prepare(`SELECT * FROM ${table} WHERE ${pk}=?`).get(id);
    admin.audit(req, `elections.${kind}.create`, `election_${kind}`, id, null, rowVo(kind, row), reason);
    afterChange(kind, row);
    res.status(201).json({ [kind.slice(0, -1)]: rowVo(kind, row) });
  });
  v1.put(`${A}/:kind/:id`, can('catalog.write'), (req, res, next) => {
    if (!KINDS.includes(req.params.kind)) return next();
    const kind = kindParam(req.params.kind); const [table, pk] = TABLE[kind];
    const before = db.prepare(`SELECT * FROM ${table} WHERE ${pk}=?`).get(String(req.params.id));
    if (!before) throw E.notFound();
    const b = check(req.body || {}, { ...SCHEMAS[kind], reason: { type: 'string', maxLen: 500, required: true } }, { unknown: 'reject' });
    const reason = reasonOf(b);
    const fixed = IMMUTABLE[kind].filter((k) => b[k] !== undefined && b[k] !== before[k]);
    if (fixed.length) throw fieldErr(Object.fromEntries(fixed.map((k) => [k, 'cannot be changed'])));
    applyEntity(req, kind, before[pk], { ...b, country: b.country ?? before.country });
    const sets = []; const args = [];
    for (const [k, col] of Object.entries(COLS[kind])) if (b[k] !== undefined) { sets.push(`${col}=?`); args.push(dbVal(b[k])); }
    tx(db, () => {
      if (sets.length) db.prepare(`UPDATE ${table} SET ${sets.join(', ')}, updated_ts=? WHERE ${pk}=?`).run(...args, now(), before[pk]);
      if (kind === 'races' && b.markets !== undefined) {
        db.prepare('DELETE FROM el_race_markets WHERE race_id=?').run(before.id);
        for (const m of b.markets) db.prepare('INSERT OR REPLACE INTO el_race_markets(race_id,market_ticker,kind,candidate_id,party_id) VALUES(?,?,?,?,?)').run(before.id, m.ticker, m.kind, m.candidate_id || null, m.party_id || null);
      }
      if (kind === 'races' && b.area !== undefined) ensureReporting(electionById(before.election_id), db.prepare('SELECT * FROM el_races WHERE id=?').get(before.id));
    });
    const row = db.prepare(`SELECT * FROM ${table} WHERE ${pk}=?`).get(before[pk]);
    admin.audit(req, `elections.${kind}.update`, `election_${kind}`, before[pk], rowVo(kind, before), rowVo(kind, row), reason);
    afterChange(kind, row);
    res.json({ [kind.slice(0, -1)]: rowVo(kind, row) });
  });

  // ---------------------------------------------------------------------------------------------- counting units
  // A race's counting units: for a race whose division is above the counting level (the presidency), every division of
  // `count_level` (country config, e.g. lga) inside its area; otherwise the race's area collated at its division.
  function ensureReporting(el, race) {
    const cfg = countryCfg(el.country);
    const area = J(race.area_json, [race.division_id]);
    const countLevel = cfg.config.count_level || cfg.config.map_level;
    const office = db.prepare('SELECT * FROM el_offices WHERE id=?').get(race.office_id);
    const rule = J(office?.rule_json, {});
    const puOf = (id) => { const d = cfg.divs.get(id); if (!d) return 0; if (d.data.pu_count) return d.data.pu_count; return (cfg.children.get(id) || []).reduce((a, c) => a + puOf(c), 0); };
    const units = [];
    const div = cfg.divs.get(race.division_id);
    const splitTo = div && div.level !== cfg.config.map_level ? countLevel : rule.type === 'spread' && div && rule.unit !== div.level ? rule.unit : null;
    if (splitTo) {
      // The units are the `splitTo` divisions inside the area (LGAs of a state, or of the whole country).
      const inArea = (id) => area.some((a) => a === id || cfg.ancestorAt(id, cfg.divs.get(a)?.level) === a);
      for (const d of cfg.ofLevel(splitTo)) if (inArea(d.id)) units.push({ id: d.id, pu: puOf(d.id) });
    }
    if (!units.length) units.push({ id: race.division_id, pu: area.reduce((a, id) => a + puOf(id), 0) });
    const have = new Set(db.prepare('SELECT unit_id FROM el_reporting WHERE race_id=?').all(race.id).map((r) => r.unit_id));
    const keep = new Set(units.map((u) => u.id));
    for (const u of units) {
      const pu = Math.max(1, u.pu);
      const voters = Math.round(pu * (420 + h01(`${race.id}:${u.id}:v`) * 180));
      if (have.has(u.id)) db.prepare('UPDATE el_reporting SET pu_total=?, voters=? WHERE race_id=? AND unit_id=?').run(pu, voters, race.id, u.id);
      else db.prepare('INSERT INTO el_reporting(race_id,unit_id,pu_total,pu_reported,voters,updated_ts) VALUES(?,?,?,?,?,?)').run(race.id, u.id, pu, 0, voters, now());
    }
    for (const id of have) if (!keep.has(id)) { db.prepare('DELETE FROM el_reporting WHERE race_id=? AND unit_id=?').run(race.id, id); db.prepare('DELETE FROM el_tallies WHERE race_id=? AND unit_id=?').run(race.id, id); }
  }

  // ---------------------------------------------------------------------------------------------- hub chat room
  // A §20 chat room per hub (rate limits, slow mode, moderation, reports as for events); open while the hub is active.
  if (chat && chat.hooks) chat.hooks.room = (t) => {
    if (!/^HUB-[A-Z0-9-]{3,60}$/.test(t)) return null;
    const el = electionBySlug(t.slice(4).toLowerCase());
    return el ? { ticker: t, title: el.title, series_ticker: 'HUB', active: true } : null;
  };

  // ---------------------------------------------------------------------------------------------- production switch
  // Election data is not money: the switch keeps every row; the simulator flag goes off (demo and test only).
  function previewCounts() {
    const q = (sql) => db.prepare(sql).get().c;
    return { kept_election_countries: q('SELECT COUNT(*) c FROM el_countries'), kept_election_races: q('SELECT COUNT(*) c FROM el_races'), kept_election_results: q('SELECT COUNT(*) c FROM el_tallies'), kept_election_snapshots: q('SELECT COUNT(*) c FROM el_snapshots') };
  }
  function afterProductionSwitch(batch) {
    if (flags.globalState('elections.simulator').on) flags.save('elections.simulator', { enabled: false }, { action: 'update', reason: `production switch ${batch}`, actor: null });
    for (const el of db.prepare("SELECT * FROM el_elections WHERE json_extract(sim_json,'$.status')='running'").all()) db.prepare('UPDATE el_elections SET sim_json=? WHERE id=?').run(JSON.stringify({ ...simOf(el), status: 'paused' }), el.id);
  }
  engine.electionsOps = { previewCounts, afterProductionSwitch };

  // ---------------------------------------------------------------------------------------------- seed (demo data)
  if (options.seed) seedAll();
  function seedAll() {
    if (db.prepare('SELECT 1 FROM meta WHERE key=?').get(SEED_KEY)) return;
    const lp = db.prepare("SELECT id FROM users WHERE email='liquidity@parlance.local'").get()?.id;
    const t = now();
    const created = [];
    const addCountry = (src) => {
      if (db.prepare('SELECT 1 FROM el_countries WHERE code=?').get(src.country.code)) return false;
      const c = src.country;
      db.prepare('INSERT INTO el_countries(code,name,currency,time_zone,locale,config_json,active,created_ts,updated_ts) VALUES(?,?,?,?,?,?,1,?,?)').run(c.code, c.name, c.currency, c.time_zone, c.locale, JSON.stringify(c.config), t, t);
      const ins = db.prepare('INSERT OR IGNORE INTO el_divisions(id,country,level,code,name,parent_id,data_json,sort,updated_ts) VALUES(?,?,?,?,?,?,?,?,?)');
      src.divisions.forEach((d, i) => ins.run(d.id, c.code, d.level, d.code, d.name, d.parent, JSON.stringify(d.data || {}), i, t));
      for (const o of src.offices) db.prepare('INSERT OR IGNORE INTO el_offices(id,country,key,name,level,seats,chamber,two_person,rule_json,sort,updated_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(`${c.code}-${o.key}`, c.code, o.key, o.name, o.level, o.seats, o.chamber ? 1 : 0, o.two_person ? 1 : 0, JSON.stringify(o.rule), o.sort, t);
      src.parties.forEach((p, i) => db.prepare('INSERT OR IGNORE INTO el_parties(id,country,code,name,short_name,color,coalition,sort,active,updated_ts) VALUES(?,?,?,?,?,?,?,?,1,?)').run(`${c.code}-${p.code}`, c.code, p.code, p.name, p.short, p.color, p.coalition || null, i, t));
      return true;
    };
    const series = (ticker, title, tags) => {
      if (db.prepare('SELECT 1 FROM series WHERE ticker=?').get(ticker)) return;
      db.prepare('INSERT INTO series(ticker,title,slug,category,tags,frequency,fee_type,fee_multiplier,settlement_sources,rules) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(ticker, title, title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), 'Elections', JSON.stringify(tags), 'one_off', 'quadratic', 1, JSON.stringify([{ name: 'Parlance Results Desk', url: 'https://example.org/results' }]), S('market.rules_control', { office: title, value: C.contractValue() }));
    };
    // An event with one market per outcome (mutually exclusive when several), hourly price history and liquidity.
    const event = (seriesTicker, ev) => {
      if (db.prepare('SELECT 1 FROM events WHERE ticker=?').get(ev.ticker)) return;
      const r = rng(Number.parseInt(ev.ticker.replace(/[^A-Z0-9]/g, '').slice(-6), 36) || 7);
      db.prepare('INSERT INTO events(ticker,series_ticker,title,sub_title,category,mutually_exclusive,is_live,live_label,news,featured,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(ev.ticker, seriesTicker, ev.title, ev.sub, 'Elections', ev.markets.length > 1 ? 1 : 0, 0, '', '', 0, new Date(t - 20 * DAY).toISOString());
      for (const m of ev.markets) {
        db.prepare('INSERT INTO markets(ticker,event_ticker,title,yes_sub_title,no_sub_title,color,status,open_time,close_time,expected_expiration_time,settlement_timer_seconds,rules_primary,created_at,updated_at,fractional_trading_enabled) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)')
          .run(m.ticker, ev.ticker, ev.markets.length > 1 ? `${ev.title} — ${m.yes}` : ev.title, m.yes, m.no, m.color, 'active', new Date(t - 14 * DAY).toISOString(), new Date(ev.close).toISOString(), new Date(ev.close + 3600000).toISOString(), 5, ev.rules, nowIso(), nowIso());
        let p = m.fair; const path = [];
        for (let i = 0; i < 72; i++) { path.unshift(p); p = Math.max(2, Math.min(98, p + Math.round((r() - 0.5) * 4))); }
        path.forEach((price, i) => db.prepare('INSERT INTO trades(id,market_ticker,yes_price_cents,count,taker_side,created_ts) VALUES(?,?,?,?,?,?)').run(newId('t_'), m.ticker, price, (5 + Math.floor(r() * 200)) * UNITS, r() > 0.5 ? 'yes' : 'no', t - (72 - i) * 3600000 + Math.floor(r() * 1800000)));
        created.push(m);
      }
    };
    const fair = (p) => Math.max(2, Math.min(98, Math.round(p * 100)));
    const norm = (o) => { const s = Object.values(o).reduce((a, b) => a + b, 0) || 1; return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round((v / s) * 1000) / 1000])); };
    const closeOf = (date) => Date.parse(`${date}T23:00:00Z`) + 14 * DAY;
    const addRace = (el, r) => {
      db.prepare('INSERT OR IGNORE INTO el_races(id,election_id,office_id,division_id,seat,name,area_json,prior_json,date,status,featured,sort,updated_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(r.id, el.id, r.office, r.division, r.seat || 0, r.name, JSON.stringify(r.area), JSON.stringify(r.prior), r.date || null, 'open', r.featured ? 1 : 0, r.sort || 0, t);
      r.cands.forEach((c, i) => db.prepare('INSERT OR IGNORE INTO el_candidates(id,race_id,party_id,name,running_mate,sort,updated_ts) VALUES(?,?,?,?,?,?,?)').run(c.id, r.id, c.party, c.name || null, c.mate || null, i, t));
      for (const m of r.markets || []) db.prepare('INSERT OR IGNORE INTO el_race_markets(race_id,market_ticker,kind,candidate_id,party_id) VALUES(?,?,?,?,?)').run(r.id, m.ticker, m.kind, m.candidate_id || null, m.party_id || null);
    };
    const addElection = (e) => {
      db.prepare('INSERT OR IGNORE INTO el_elections(id,country,slug,title,kind,date,config_json,sim_json,active,created_ts,updated_ts) VALUES(?,?,?,?,?,?,?,?,1,?,?)').run(e.id, e.country, e.slug, e.title, e.kind, e.date, JSON.stringify(e.config || {}), JSON.stringify({ status: 'idle', minutes: 0, seed: e.seed, speed: Number(options.speed || 60) }), t, t);
      return electionById(e.id);
    };
    // A winner event per candidate race (markets named after the candidate or party), and the race's market links.
    const winnerMarkets = (seriesTicker, el, r, extra = []) => {
      const et = `${seriesTicker}-${r.tick}`;
      event(seriesTicker, { ticker: et, title: S('market.winner_title', { race: r.name }), sub: S('market.winner_sub', { election: el.title }), close: closeOf(el.date), rules: S('market.rules_winner', { race: r.name, value: C.contractValue() }),
        markets: r.cands.map((c) => ({ ticker: `${et}-${c.code}`, yes: c.name || c.party_label, no: `Not ${c.name || c.party_label}`, color: c.color, fair: fair(r.prior.default[c.id] || 0.02) })) });
      r.markets = [...r.cands.map((c) => ({ ticker: `${et}-${c.code}`, kind: 'winner', candidate_id: c.id, party_id: c.party })), ...extra];
    };
    const controlMarkets = (seriesTicker, el, office, officeName, parties, probs) => {
      const et = `${seriesTicker}-${office.toUpperCase().slice(0, 3)}CTRL`;
      event(seriesTicker, { ticker: et, title: S('market.control_title', { office: officeName }), sub: el.title, close: closeOf(el.date), rules: S('market.rules_control', { office: officeName, value: C.contractValue() }),
        markets: parties.map((p) => ({ ticker: `${et}-${p.code}`, yes: p.name, no: `Not ${p.name}`, color: p.color, fair: fair(probs[p.code] || 0.02) })) });
      for (const p of parties) db.prepare('INSERT OR IGNORE INTO el_office_markets(election_id,office_id,market_ticker,kind,party_id) VALUES(?,?,?,?,?)').run(el.id, `${el.country}-${office}`, `${et}-${p.code}`, 'control', `${el.country}-${p.code}`);
    };
    tx(db, () => {
      // ------------------------------------------------ Nigeria
      const ng = DATA.nigeria();
      addCountry(ng);
      const P = Object.fromEntries(ng.parties.map((p) => [p.code, p]));
      const pid = (code) => `NG-${code}`;
      const stateStrength = (code) => norm(ng.strength(code));
      const gen = addElection({ id: 'NG27', country: 'NG', slug: 'nigeria-2027', title: 'Nigeria 2027 general election', kind: 'general', date: '2027-02-20', seed: 20270220,
        config: { holdovers: { 'NG-governor': { 'NG-LUP': 3, 'NG-HWA': 3, 'NG-FBC': 2 } } } });
      const off = addElection({ id: 'NGOC', country: 'NG', slug: 'nigeria-offcycle', title: 'Off-cycle governorship elections', kind: 'off_cycle', date: '2027-11-13', seed: 20271113 });
      series('PLXNG27', gen.title, ['Nigeria', 'President', 'Governor', 'Senate', 'House']);
      series('PLXNGOC', off.title, ['Nigeria', 'Governor']);
      // President: one national race, counted by LGA; the prior per state from the invented regional strength.
      const lgasBy = new Map(); const wardsBy = new Map();
      for (const d of ng.divisions) { if (d.level === 'lga') { if (!lgasBy.has(d.parent)) lgasBy.set(d.parent, []); lgasBy.get(d.parent).push(d); } if (d.level === 'ward') { const s = d.parent.split('-').slice(0, 2).join('-'); if (!wardsBy.has(s)) wardsBy.set(s, []); wardsBy.get(s).push(d); } }
      const presC = ng.presidential.map((c) => ({ id: `NG27-PRES-${c.party}`, code: c.party, party: pid(c.party), name: c.name, mate: c.mate, color: P[c.party].color }));
      const byDiv = {}; const nat = {};
      for (const s of ng.states) { const st = stateStrength(s.code); byDiv[s.id] = Object.fromEntries(presC.map((c) => [c.id, st[c.code] || 0.02])); for (const c of presC) nat[c.id] = (nat[c.id] || 0) + (st[c.code] || 0) * s.lgas; }
      const pres = { id: 'NG27-PRES', tick: 'PRES', office: 'NG-president', division: 'NG', name: S('race.president', { country: 'Nigeria' }), area: ['NG'], prior: { default: norm(nat), by_division: byDiv }, cands: presC, featured: true, sort: 0 };
      winnerMarkets('PLXNG27', gen, pres, [{ ticker: 'PLXNG27-RUNOFF', kind: 'runoff' }]);
      event('PLXNG27', { ticker: 'PLXNG27-RUNOFF', title: S('market.runoff_title', { race: pres.name }), sub: gen.title, close: closeOf(gen.date), rules: S('market.rules_runoff', { race: pres.name, value: C.contractValue() }),
        markets: [{ ticker: 'PLXNG27-RUNOFF', yes: S('market.runoff_yes'), no: S('market.runoff_no'), color: '#868e96', fair: 22 }] });
      addRace(gen, pres);
      // Governors: the 28 general-election states (no governor for the FCT) and the 8 off-cycle states.
      const top3 = (code) => Object.entries(ng.strength(code)).sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0]);
      let gi = 0;
      for (const s of ng.states) {
        if (s.code === 'FC') continue;
        const offCycle = DATA.NG_OFF_CYCLE.includes(s.code);
        const el = offCycle ? off : gen; const ser = offCycle ? 'PLXNGOC' : 'PLXNG27';
        const st = stateStrength(s.code);
        const cands = top3(s.code).map((code, i) => ({ id: `${el.id}-GOV-${s.code}-${code}`, code, party: pid(code), color: P[code].color,
          name: `${DATA.FIRST[Math.floor(DATA.h01(`${s.code}${code}f`) * DATA.FIRST.length)]} ${DATA.SUR[Math.floor(DATA.h01(`${s.code}${code}a`) * DATA.SUR.length)]}-${DATA.SUR[(Math.floor(DATA.h01(`${s.code}${code}b`) * DATA.SUR.length) + i + 1) % DATA.SUR.length]}` }));
        const prior = norm(Object.fromEntries(cands.map((c) => [c.id, st[c.code]])));
        const r = { id: `${el.id}-GOV-${s.code}`, tick: `GOV${s.code}`, office: 'NG-governor', division: s.id, name: S('race.governor', { state: s.name }), area: [s.id], prior: { default: prior }, cands, featured: ['LA', 'KN', 'RI', 'ED', 'AN'].includes(s.code), sort: 100 + gi++,
          date: offCycle ? { AN: '2029-11-10', BY: '2027-11-13', ED: '2028-09-16', EK: '2030-06-15', IM: '2027-11-13', KO: '2027-11-13', ON: '2028-11-18', OS: '2030-08-17' }[s.code] : null };
        winnerMarkets(ser, el, r);
        addRace(el, r);
      }
      // Senate (3 districts per state, 1 for the FCT; districts are groups of whole LGAs) and House (federal
      // constituencies as groups of wards): party-level contestants, counted at the state; chamber-control markets.
      let si = 0;
      for (const s of ng.states) {
        const st = stateStrength(s.code); const parties = top3(s.code);
        const lgas = lgasBy.get(s.id); const n = s.data.senate_seats;
        for (let k = 0; k < n; k++) {
          const area = lgas.filter((l, i) => Math.floor((i * n) / lgas.length) === k).map((l) => l.id);
          const cands = parties.map((code) => ({ id: `NG27-SEN-${s.code}-${k + 1}-${code}`, party: pid(code) }));
          addRace(gen, { id: `NG27-SEN-${s.code}-${k + 1}`, office: 'NG-senate', division: s.id, seat: k + 1, name: n === 1 ? S('race.senate_single', { state: s.name }) : S('race.senate', { state: s.name, n: k + 1 }), area,
            prior: { default: norm(Object.fromEntries(parties.map((code, i) => [cands[i].id, st[code]]))) }, cands, sort: 1000 + si++ });
        }
        const wards = wardsBy.get(s.id); const h = s.hor;
        for (let k = 0; k < h; k++) {
          const area = wards.filter((w, i) => Math.floor((i * h) / wards.length) === k).map((w) => w.id);
          const cands = parties.map((code) => ({ id: `NG27-HOR-${s.code}-${k + 1}-${code}`, party: pid(code) }));
          addRace(gen, { id: `NG27-HOR-${s.code}-${String(k + 1).padStart(2, '0')}`, office: 'NG-house', division: s.id, seat: k + 1, name: S('race.house', { state: s.name, n: k + 1 }), area,
            prior: { default: norm(Object.fromEntries(parties.map((code, i) => [cands[i].id, st[code]]))) }, cands, sort: 2000 + si++ });
        }
      }
      controlMarkets('PLXNG27', gen, 'senate', 'Senate', ng.parties, { LUP: 0.46, FBC: 0.28, HWA: 0.18, CTM: 0.06, SRP: 0.02 });
      controlMarkets('PLXNG27', gen, 'house', 'House of Representatives', ng.parties, { LUP: 0.43, FBC: 0.31, HWA: 0.19, CTM: 0.05, SRP: 0.02 });
      // ------------------------------------------------ Harbor (XH), the second country
      const xh = DATA.harbor();
      addCountry(xh);
      const XP = Object.fromEntries(xh.parties.map((p) => [p.code, p]));
      const hel = addElection({ id: 'XH26', country: 'XH', slug: 'harbor-2026', title: 'Harbor 2026 elections', kind: 'general', date: '2026-11-24', seed: 20261124,
        config: { holdovers: { 'XH-senate': { 'XH-BLU': DATA.HARBOR_STATES.reduce((a, s) => a + s.seated.blue, 0), 'XH-RED': DATA.HARBOR_STATES.reduce((a, s) => a + s.seated.red, 0) } } } });
      series('PLXXH26', hel.title, ['Harbor', 'Senate', 'Governor']);
      let xi = 0;
      for (const s of xh.states) {
        if (!s.src.senate) continue;
        const blue = [0.62, 0.38, 0.55, 0.47, 0.71, 0.33, 0.52, 0.5][xi % 8];
        const cands = ['BLU', 'RED', 'GLD'].map((code) => ({ id: `XH26-SEN-${s.code}-${code}`, party: `XH-${code}` }));
        addRace(hel, { id: `XH26-SEN-${s.code}`, office: 'XH-senate', division: s.id, seat: 1, name: S('race.senate_single', { state: s.name }), area: [s.id],
          prior: { default: norm({ [cands[0].id]: blue * 0.92, [cands[1].id]: (1 - blue) * 0.92, [cands[2].id]: 0.08 }) }, cands, sort: xi++ });
      }
      const hs = xh.states.find((s) => s.code === 'HS');
      const gc = DATA.XH_CANDIDATES.map((c) => ({ id: `XH26-GOV-HS-${c.party}`, code: c.party, party: `XH-${c.party}`, name: c.name, color: XP[c.party].color }));
      const gov = { id: 'XH26-GOV-HS', tick: 'GOVHS', office: 'XH-governor', division: hs.id, name: S('race.governor', { state: hs.name }), area: [hs.id], prior: { default: norm({ [gc[0].id]: 0.52, [gc[1].id]: 0.41, [gc[2].id]: 0.07 }) }, cands: gc, featured: true, sort: 100 };
      winnerMarkets('PLXXH26', hel, gov);
      addRace(hel, gov);
      controlMarkets('PLXXH26', hel, 'senate', 'Senate', xh.parties, { BLU: 0.44, RED: 0.5, GLD: 0.06 });
      // Counting units for every race.
      for (const el of [gen, off, hel]) for (const r of db.prepare('SELECT * FROM el_races WHERE election_id=?').all(el.id)) ensureReporting(el, r);
      // Power Index (NG): the invented "ruling" LUP against everyone else, from the presidential and chamber markets.
      if (!admin.setting(PI_KEY('NG'))) admin.putSetting(PI_KEY('NG'), { enabled: true, label_pos: 'LUP (ruling party)', label_neg: 'Opposition', offset: -50, scale: 20,
        terms: [{ ticker: 'PLXNG27-PRES-LUP', weight: 0.5 }, { ticker: 'PLXNG27-SENCTRL-LUP', weight: 0.25 }, { ticker: 'PLXNG27-HOUCTRL-LUP', weight: 0.25 }] }, null);
      db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(SEED_KEY, nowIso());
    });
    invalidate();
    // Liquidity through the engine (reservations are journaled), two levels a side.
    if (lp) for (const m of created) for (let lvl = 1; lvl <= 2; lvl++) for (const [side, price] of [['yes', m.fair - lvl], ['no', 100 - (m.fair + lvl)]]) {
      if (price < 1 || price > 99) continue;
      try { engine.placeOrder(lp, { ticker: m.ticker, side, price, count: 50 * lvl * UNITS, source: 'liquidity' }); } catch { /* a level that would cross: skipped */ }
    }
  }
  void production;
  return { model, compactOf, snapshot, runSim, countryCfg, invalidate, seedAll, ensureReporting, previewCounts };
}

module.exports = { mountElections, SCHEMA };
