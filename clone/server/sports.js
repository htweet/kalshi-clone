'use strict';
// Simulated live sports (CLONE_SPEC.md §19): invented leagues, fixtures ("milestones"), a deterministic game
// engine per sport driven by the engine tick, live win probability, a persisted play-by-play log and box scores,
// and winner markets that re-quote around the live probability and settle through the normal determine/finalize
// path at the final whistle. Every piece of state lives in SQLite, so a restart resumes each game from the DB.
//
// Evidence-shaped fields: live data mirrors the calendar `initialLiveData` payload (HAR3#10) — keyed by milestone
// id, `{type, details, milestone_id}` with `cricket_match` / `tennis_tournament_singles` / `esports_match` detail
// names. Everything else (sport models, rates, leagues, teams, players) is a Parlance design choice.
const CS = require('./content/currency-strings'); // keyed user-facing wording (CLONE_SPEC.md §30)
const C = require('./currency'); // display currency formatting (CLONE_SPEC.md §30)
const { tx } = require('./db');
const { nowIso, newId, hashPassword, slugify, E } = require('./util');
const Lines = require('./sports-lines'); // spreads and totals (Phase 5B, PLAN P5.2)

// Engine quantity unit: integer hundredths of a contract (engine.UNITS = 100) or whole contracts (1).
const UNITS = require('./engine').UNITS || 1;
const SIDES = ['home', 'away'];
const other = (s) => (s === 'home' ? 'away' : 'home');
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const r4 = (x) => Math.round(x * 10000) / 10000;
const mmss = (sec) => { const s = Math.max(0, Math.ceil(sec - 1e-9)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const ord = (n) => n + (({ 1: 'st', 2: 'nd', 3: 'rd' })[Math.floor(n / 10) % 10 === 1 ? 0 : n % 10] || 'th');
const oversStr = (balls) => `${Math.floor(balls / 6)}.${balls % 6}`;
const MAX_SIM_SEC = 6 * 3600; // longest game we allow before the markets' scheduled close (sim seconds)
const MAX_CATCHUP_MS = 5000; // never jump a clock more than this per tick (a restart resumes; it does not fast-forward)

// ---------- deterministic randomness (state persisted inside the game state as `r`) ----------
function rnd(st) {
  st.r = (st.r + 0x6D2B79F5) >>> 0;
  let t = st.r;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const chance = (st, p) => rnd(st) < p;
const between = (st, a, b) => a + (b - a) * rnd(st);
const pick = (st, arr) => arr[Math.floor(rnd(st) * arr.length)];
function weighted(st, pairs) {
  let x = rnd(st) * pairs.reduce((a, p) => a + p[1], 0);
  for (const [k, w] of pairs) { x -= w; if (x < 0) return k; }
  return pairs[pairs.length - 1][0];
}
function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

// ---------- probability helpers ----------
function erf(x) {
  const s = Math.sign(x); const a = Math.abs(x); const t = 1 / (1 + 0.3275911 * a);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
}
const Phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
function poisson(l, kMax = 12) { const out = []; let p = Math.exp(-l); for (let k = 0; k <= kMax; k++) { out.push(p); p = (p * l) / (k + 1); } return out; }
const finalProb = (st) => ({ home: st.winner === 'home' ? 1 : 0, away: st.winner === 'away' ? 1 : 0, draw: st.winner === 'draw' ? 1 : 0 });
const marginProb = (margin, sd) => (sd <= 0.01 ? (margin > 0 ? 1 : margin < 0 ? 0 : 0.5) : Phi(margin / sd));
const lastLine = (st, s) => st.lines[s].length - 1;
const lineObj = (arr) => Object.fromEntries(arr.map((v, i) => [`period_${i + 1}`, v]));

// =====================================================================================================
// Sport models. Interface: init(st, cfg) · next(st) → seconds of the next segment · resolve(st) → plays[]
// (resolves the segment that just ended) · view(st, part) → {period, clock, label} · prob(st) → {home, away, draw}
// · details(st, part) → sport-specific live-data details · start(st) → opening play text.
// =====================================================================================================

// ---- Soccer: 2 × 45 min, one segment per match minute, Poisson scoring, cards ----
const soccer = {
  type: 'soccer_match', label: 'Soccer', draw: true,
  init(st) {
    Object.assign(st, { half: 1, clock: 0, phase: 'play', reds: { home: 0, away: 0 }, lam: { home: (1.45 + st.edge * 0.7) / 90, away: (1.15 - st.edge * 0.7) / 90 } });
    for (const s of SIDES) Object.assign(st.stats[s], { goals: 0, shots: 0, shots_on_target: 0, corners: 0, fouls: 0, yellow_cards: 0, red_cards: 0, possession_sec: 0 });
    st.lines = { home: [0], away: [0] };
  },
  next: (st) => (st.phase === 'ht' ? 600 : 60),
  rate(st, s) { return st.lam[s] * 0.7 ** st.reds[s] * 1.15 ** st.reds[other(s)]; },
  resolve(st) {
    const plays = [];
    if (st.phase === 'ht') {
      st.phase = 'play'; st.half = 2; st.lines.home.push(0); st.lines.away.push(0);
      return [{ kind: 'period', text: 'Second half under way' }];
    }
    st.clock += 60;
    const ph = clamp(0.5 + st.edge * 0.12 + (rnd(st) - 0.5) * 0.3, 0.2, 0.8);
    st.stats.home.possession_sec += Math.round(60 * ph); st.stats.away.possession_sec += Math.round(60 * (1 - ph));
    for (const s of SIDES) {
      const S = st.stats[s]; const nm = st.names[s];
      if (chance(st, this.rate(st, s))) {
        st.score[s] += 1; S.goals += 1; S.shots += 1; S.shots_on_target += 1; st.lines[s][lastLine(st, s)] += 1;
        plays.push({ team: s, kind: 'goal', text: `GOAL! ${nm} score — ${st.names.home} ${st.score.home}-${st.score.away} ${st.names.away}` });
      } else if (chance(st, 0.12)) {
        S.shots += 1;
        if (chance(st, 0.35)) { S.shots_on_target += 1; plays.push({ team: s, kind: 'shot', text: `Shot on target from ${nm}, saved` }); } else if (chance(st, 0.3)) plays.push({ team: s, kind: 'shot', text: `${nm} shot goes wide` });
      }
      if (chance(st, 0.055)) { S.corners += 1; if (chance(st, 0.35)) plays.push({ team: s, kind: 'corner', text: `Corner to ${nm}` }); }
      if (chance(st, 0.12)) {
        S.fouls += 1;
        if (chance(st, 0.17)) { S.yellow_cards += 1; plays.push({ team: s, kind: 'yellow', text: `Yellow card · ${nm}` }); } else if (chance(st, 0.012)) { S.red_cards += 1; st.reds[s] += 1; plays.push({ team: s, kind: 'red', text: `Red card! ${nm} down to ${11 - st.reds[s]} men` }); }
      }
    }
    if (st.clock === 2700) { st.phase = 'ht'; plays.push({ kind: 'period', text: `Half-time: ${st.names.home} ${st.score.home}-${st.score.away} ${st.names.away}` }); }
    if (st.clock >= 5400) {
      st.done = true;
      st.winner = st.score.home > st.score.away ? 'home' : st.score.home < st.score.away ? 'away' : 'draw';
      plays.push({ kind: 'final', text: `Full-time: ${st.names.home} ${st.score.home}-${st.score.away} ${st.names.away}` });
    }
    return plays;
  },
  view(st, part) {
    if (st.done) return { period: st.half, clock: "90'", label: 'Final' };
    if (st.phase === 'ht') return { period: 1, clock: 'HT', label: 'Half-time' };
    const min = Math.min(st.half * 45, Math.floor((st.clock + part) / 60) + 1);
    return { period: st.half, clock: `${min}'`, label: `${st.half === 1 ? '1st' : '2nd'} half · ${min}'` };
  },
  prob(st) {
    if (st.done) return finalProb(st);
    const rem = Math.max(0, (5400 - st.clock) / 60);
    const ph = poisson(this.rate(st, 'home') * rem); const pa = poisson(this.rate(st, 'away') * rem);
    let h = 0; let a = 0; let d = 0;
    for (let i = 0; i < ph.length; i++) for (let j = 0; j < pa.length; j++) {
      const diff = st.score.home + i - (st.score.away + j); const p = ph[i] * pa[j];
      if (diff > 0) h += p; else if (diff < 0) a += p; else d += p;
    }
    const t = h + a + d;
    return { home: h / t, away: a / t, draw: d / t };
  },
  details(st, part) {
    const v = this.view(st, part);
    return { half: st.half, minute: v.clock, home_red_cards: st.stats.home.red_cards, away_red_cards: st.stats.away.red_cards, home_yellow_cards: st.stats.home.yellow_cards, away_yellow_cards: st.stats.away.yellow_cards };
  },
  start: () => 'Kick-off',
};

// ---- Basketball: 4 quarters (12 or 10 min), one segment per possession, overtime until decided ----
const qName = (q) => (q <= 4 ? `Q${q}` : q === 5 ? 'OT' : `${q - 4}OT`);
const basketball = {
  type: 'basketball_game', label: 'Basketball', draw: false,
  init(st, cfg) {
    const qLen = cfg.qLen || 720;
    Object.assign(st, { qLen, quarter: 1, remain: qLen, phase: 'play', poss: rnd(st) < 0.5 ? 'home' : 'away' });
    for (const s of SIDES) Object.assign(st.stats[s], { fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0, reb: 0, ast: 0, tov: 0, pf: 0 });
    st.lines = { home: [0], away: [0] };
  },
  next(st) { return st.phase === 'break' ? (st.quarter === 2 ? 600 : 120) : Math.min(st.remain, between(st, 6, 24)); },
  resolve(st) {
    if (st.phase === 'break') {
      st.quarter += 1; st.remain = st.quarter > 4 ? 300 : st.qLen; st.phase = 'play'; st.lines.home.push(0); st.lines.away.push(0);
      st.poss = st.quarter % 2 === 0 ? other(st.tip) : st.tip;
      return [{ kind: 'period', text: `Start of ${qName(st.quarter)}` }];
    }
    st.remain = Math.max(0, st.remain - st.segDur);
    const s = st.poss; const d = other(s); const S = st.stats[s]; const nm = st.names[s];
    const e = s === 'home' ? st.edge : -st.edge;
    let pts = 0; let keep = false; let text; let kind;
    const r = rnd(st);
    if (r < 0.13) { S.tov += 1; kind = 'turnover'; text = `${nm} ${pick(st, ['turnover', 'lose it out of bounds', 'travel', 'offensive foul'])}`; }
    else if (r < 0.23) {
      st.stats[d].pf += 1; S.fta += 2;
      for (let k = 0; k < 2; k++) if (chance(st, 0.77)) { S.ftm += 1; pts += 1; }
      kind = 'free_throw'; text = `${nm} make ${pts} of 2 free throws`;
    } else {
      const three = chance(st, 0.38);
      S.fga += 1; if (three) S.tpa += 1;
      if (chance(st, (three ? 0.355 : 0.515) + e * 0.03)) {
        pts = three ? 3 : 2; S.fgm += 1; if (three) S.tpm += 1; if (chance(st, 0.6)) S.ast += 1;
        kind = three ? 'three' : 'two'; text = `${nm} ${three ? 'three-pointer' : pick(st, ['layup', 'jumper', 'dunk', 'floater', 'hook shot'])} is good`;
      } else {
        keep = chance(st, 0.26); (keep ? S : st.stats[d]).reb += 1;
        kind = 'miss'; text = `${nm} miss ${three ? 'a three' : 'a jumper'}${keep ? ', offensive rebound' : `, ${st.names[d]} rebound`}`;
      }
    }
    if (pts) { st.score[s] += pts; st.lines[s][lastLine(st, s)] += pts; }
    if (!keep) st.poss = d;
    const plays = [{ team: s, kind, text, pts }];
    if (st.remain <= 0) {
      if (st.quarter >= 4 && st.score.home !== st.score.away) {
        st.done = true; st.winner = st.score.home > st.score.away ? 'home' : 'away';
        plays.push({ kind: 'final', text: `Final: ${st.names.home} ${st.score.home}, ${st.names.away} ${st.score.away}` });
      } else {
        st.phase = 'break';
        plays.push({ kind: 'period', text: st.quarter === 2 ? 'Half-time' : st.quarter >= 4 ? `End of ${qName(st.quarter)} — tied, overtime` : `End of ${qName(st.quarter)}` });
      }
    }
    return plays;
  },
  view(st, part) {
    if (st.done) return { period: st.quarter, clock: '0:00', label: 'Final' };
    if (st.phase === 'break') return { period: st.quarter, clock: '0:00', label: st.quarter === 2 ? 'Half-time' : `End of ${qName(st.quarter)}` };
    const c = mmss(Math.max(0, st.remain - part));
    return { period: st.quarter, clock: c, label: `${qName(st.quarter)} ${c}` };
  },
  remaining(st) {
    if (st.phase === 'break') return st.quarter >= 4 ? 300 : (4 - st.quarter) * st.qLen;
    return st.remain + Math.max(0, 4 - st.quarter) * st.qLen;
  },
  prob(st) {
    if (st.done) return finalProb(st);
    const R = this.remaining(st);
    const margin = st.score.home - st.score.away + st.edge * 6 * (R / (4 * st.qLen)) + (st.phase === 'play' ? (st.poss === 'home' ? 0.5 : -0.5) : 0);
    const h = marginProb(margin, 0.24 * Math.sqrt(R) + 0.4);
    return { home: h, away: 1 - h, draw: 0 };
  },
  details(st) { return { quarter: st.quarter, possession: st.poss, quarter_length_seconds: st.qLen }; },
  start(st) { st.tip = st.poss; return `Tip-off — ${st.names[st.poss]} win the jump ball`; },
};

// ---- American football: 4 × 15 min, one segment per play, downs & distance, OT periods until decided ----
const football = {
  type: 'football_game', label: 'Football', draw: false,
  init(st, cfg) {
    const recv = rnd(st) < 0.5 ? 'home' : 'away';
    Object.assign(st, { qLen: cfg.qLen || 900, quarter: 1, remain: cfg.qLen || 900, phase: 'play', opening: recv, poss: recv, ballOn: 25, down: 1, togo: 10 });
    for (const s of SIDES) Object.assign(st.stats[s], { total_yards: 0, passing_yards: 0, rushing_yards: 0, first_downs: 0, third_down_att: 0, third_down_conv: 0, turnovers: 0, sacks: 0 });
    st.lines = { home: [0], away: [0] };
  },
  next(st) { return st.phase === 'break' ? (st.quarter === 2 ? 900 : 120) : Math.min(st.remain, between(st, 18, 42)); },
  give(st, team, ballOn) { st.poss = team; st.ballOn = clamp(Math.round(ballOn), 1, 99); st.down = 1; st.togo = Math.min(10, 100 - st.ballOn); },
  add(st, s, pts) { st.score[s] += pts; st.lines[s][lastLine(st, s)] += pts; },
  spot(st) { return st.ballOn <= 50 ? `${st.abbr[st.poss]} ${st.ballOn}` : `${st.abbr[other(st.poss)]} ${100 - st.ballOn}`; },
  resolve(st) {
    if (st.phase === 'break') {
      st.quarter += 1; st.remain = st.quarter > 4 ? 600 : st.qLen; st.phase = 'play'; st.lines.home.push(0); st.lines.away.push(0);
      if (st.quarter === 3) this.give(st, other(st.opening), 25);
      if (st.quarter === 5) this.give(st, rnd(st) < 0.5 ? 'home' : 'away', 25);
      return [{ kind: 'period', text: `Start of ${qName(st.quarter)}` }];
    }
    st.remain = Math.max(0, st.remain - st.segDur);
    const s = st.poss; const d = other(s); const S = st.stats[s]; const nm = st.names[s];
    const e = s === 'home' ? st.edge : -st.edge;
    const plays = [];
    const wasDown = st.down;
    let play = 'normal';
    if (st.down === 4) {
      const dist = 100 - st.ballOn + 17;
      if (dist <= 55) play = 'fg'; else if (st.togo <= 2 && st.ballOn >= 40 && chance(st, 0.45)) play = 'normal'; else play = 'punt';
    }
    if (play === 'fg') {
      const dist = 100 - st.ballOn + 17;
      if (chance(st, clamp(1.02 - (dist - 18) * 0.017, 0.3, 0.98))) { this.add(st, s, 3); plays.push({ team: s, kind: 'field_goal', text: `${nm} ${dist}-yard field goal is GOOD`, pts: 3 }); this.give(st, d, 25); }
      else { plays.push({ team: s, kind: 'field_goal_miss', text: `${nm} ${dist}-yard field goal is NO GOOD` }); this.give(st, d, 100 - (st.ballOn - 7)); }
    } else if (play === 'punt') {
      const spot = st.ballOn + Math.round(between(st, 35, 50));
      plays.push({ team: s, kind: 'punt', text: `${nm} punt${spot >= 100 ? ', touchback' : ''}` });
      this.give(st, d, spot >= 100 ? 20 : 100 - spot);
    } else {
      const pass = chance(st, st.togo >= 7 ? 0.68 : 0.52);
      let gain = 0; let turnover = null; let text;
      if (pass) {
        if (chance(st, 0.065)) { gain = -Math.round(between(st, 4, 9)); S.sacks += 1; text = `${nm} QB sacked for a loss of ${-gain}`; }
        else if (chance(st, 0.025)) { turnover = 'interception'; text = `Intercepted! ${st.names[d]} take over`; }
        else if (chance(st, 0.63 + e * 0.04)) { gain = Math.round(2 + between(st, 0, 1) ** 2 * 30 + (chance(st, 0.05) ? between(st, 10, 40) : 0)); text = `${nm} pass complete for ${gain} yards`; S.passing_yards += gain; }
        else text = `${nm} pass incomplete`;
      } else if (chance(st, 0.012)) { turnover = 'fumble'; text = `Fumble! ${st.names[d]} recover`; }
      else { gain = Math.round(-2 + between(st, 0, 8) + (chance(st, 0.06) ? between(st, 8, 40) : 0) + e); text = `${nm} run for ${gain} yards`; S.rushing_yards += gain; }
      S.total_yards += gain;
      if (wasDown === 3) S.third_down_att += 1;
      if (turnover) { S.turnovers += 1; plays.push({ team: s, kind: turnover, text }); this.give(st, d, 100 - clamp(st.ballOn + Math.round(between(st, 0, 20)), 1, 99)); }
      else if (st.ballOn + gain >= 100) {
        const pat = chance(st, 0.94);
        this.add(st, s, pat ? 7 : 6);
        if (wasDown === 3) S.third_down_conv += 1;
        plays.push({ team: s, kind: 'touchdown', text: `TOUCHDOWN ${nm}! (${pat ? 'kick is good' : 'kick is no good'})`, pts: pat ? 7 : 6 });
        this.give(st, d, 25);
      } else if (st.ballOn + gain <= 0) {
        this.add(st, d, 2); plays.push({ team: d, kind: 'safety', text: `Safety! ${st.names[d]} score 2`, pts: 2 }); this.give(st, d, 35);
      } else {
        st.ballOn += gain;
        if (gain >= st.togo) { S.first_downs += 1; if (wasDown === 3) S.third_down_conv += 1; st.down = 1; st.togo = Math.min(10, 100 - st.ballOn); text += ' — first down'; }
        else { st.down += 1; st.togo -= gain; }
        plays.push({ team: s, kind: pass ? 'pass' : 'run', text });
        if (st.down > 4) { plays.push({ team: d, kind: 'downs', text: `Turnover on downs — ${st.names[d]} ball` }); this.give(st, d, 100 - st.ballOn); }
      }
    }
    if (st.remain <= 0) {
      if (st.quarter >= 4 && st.score.home !== st.score.away) {
        st.done = true; st.winner = st.score.home > st.score.away ? 'home' : 'away';
        plays.push({ kind: 'final', text: `Final: ${st.names.home} ${st.score.home}, ${st.names.away} ${st.score.away}` });
      } else {
        st.phase = 'break';
        plays.push({ kind: 'period', text: st.quarter === 2 ? 'Half-time' : st.quarter >= 4 ? `End of ${qName(st.quarter)} — tied, overtime` : `End of ${qName(st.quarter)}` });
      }
    }
    return plays;
  },
  view(st, part) {
    if (st.done) return { period: st.quarter, clock: '0:00', label: 'Final' };
    if (st.phase === 'break') return { period: st.quarter, clock: '0:00', label: st.quarter === 2 ? 'Half-time' : `End of ${qName(st.quarter)}` };
    const c = mmss(Math.max(0, st.remain - part));
    return { period: st.quarter, clock: c, label: `${qName(st.quarter)} ${c}` };
  },
  prob(st) {
    if (st.done) return finalProb(st);
    const R = st.phase === 'break' ? (st.quarter >= 4 ? 600 : (4 - st.quarter) * st.qLen) : st.remain + Math.max(0, 4 - st.quarter) * st.qLen;
    const ep = st.phase === 'play' ? ((st.ballOn - 30) / 22) * (st.poss === 'home' ? 1 : -1) : 0;
    const h = marginProb(st.score.home - st.score.away + st.edge * 5 * (R / 3600) + ep, 0.22 * Math.sqrt(R) + 0.6);
    return { home: h, away: 1 - h, draw: 0 };
  },
  details(st) {
    return { quarter: st.quarter, possession: st.poss, down: st.down, distance: st.togo, yard_line: st.ballOn,
      down_distance: st.done || st.phase === 'break' ? '' : `${ord(st.down)} & ${st.togo >= 100 - st.ballOn ? 'Goal' : st.togo} at ${this.spot(st)}` };
  },
  start(st) { return `Kickoff — ${st.names[st.poss]} receive`; },
};

// ---- Tennis: best of 3 sets, games to 6 with a tiebreak at 6-6, deuce/advantage, serve statistics ----
const PTS = ['0', '15', '30', '40'];
const tennisMath = {
  game(p, a, b) { // P(server wins the game) from points a:b
    const D = (p * p) / (p * p + (1 - p) * (1 - p));
    const f = (x, y) => {
      if (x >= 4 && x - y >= 2) return 1; if (y >= 4 && y - x >= 2) return 0;
      if (x >= 3 && y >= 3) return x === y ? D : x > y ? p + (1 - p) * D : p * D;
      return p * f(x + 1, y) + (1 - p) * f(x, y + 1);
    };
    return f(a, b);
  },
  // P(home wins a tiebreak) from a:b where `first` served the first tiebreak point.
  tiebreak(ph, pa, a, b, first) {
    const memo = new Map();
    const win = (srv) => (srv === 'home' ? ph : 1 - pa); // P(home wins the point)
    const f = (x, y) => {
      if (x >= 7 && x - y >= 2) return 1; if (y >= 7 && y - x >= 2) return 0;
      // From 6-6 (and every later tie) the next two points are served one each: win both or come back level.
      if (x >= 6 && y >= 6 && x === y) { const hw = ph * (1 - pa); const aw = (1 - ph) * pa; return hw + aw > 0 ? hw / (hw + aw) : 0.5; }
      const k = `${x}:${y}`; if (memo.has(k)) return memo.get(k);
      const n = x + y; const srv = Math.floor((n + 1) / 2) % 2 === 0 ? first : other(first);
      const q = win(srv); const v = q * f(x + 1, y) + (1 - q) * f(x, y + 1);
      memo.set(k, v); return v;
    };
    return f(a, b);
  },
  set(ph, pa, g1, g2, srv) { // P(home wins the set) at the start of a game served by srv
    const memo = new Map();
    const f = (x, y, s) => {
      if (x >= 6 && x - y >= 2) return 1; if (y >= 6 && y - x >= 2) return 0;
      if (x === 7) return 1; if (y === 7) return 0;
      if (x === 6 && y === 6) return this.tiebreak(ph, pa, 0, 0, s);
      const k = `${x}:${y}:${s}`; if (memo.has(k)) return memo.get(k);
      const g = s === 'home' ? this.game(ph, 0, 0) : 1 - this.game(pa, 0, 0);
      const v = g * f(x + 1, y, other(s)) + (1 - g) * f(x, y + 1, other(s));
      memo.set(k, v); return v;
    };
    return { f, v: f(g1, g2, srv) };
  },
};
const tennis = {
  type: 'tennis_tournament_singles', label: 'Tennis', draw: false,
  init(st) {
    Object.assign(st, { p: { home: 0.63 + st.edge * 0.05, away: 0.63 - st.edge * 0.05 }, sets: [{ home: 0, away: 0, winner: '' }], setsWon: { home: 0, away: 0 }, pts: { home: 0, away: 0 }, tb: false, tbFirst: '', server: rnd(st) < 0.5 ? 'home' : 'away', changeover: false, run: { side: '', n: 0 } });
    for (const s of SIDES) Object.assign(st.stats[s], { aces: 0, double_faults: 0, first_serve_attempts: 0, first_serve_successful: 0, first_serve_points_won: 0, second_serve_attempts: 0, second_serve_successful: 0, second_serve_points_won: 0, service_points_won: 0, service_points_lost: 0, breakpoints_won: 0, total_breakpoints: 0, points_won: 0, games_won: 0, service_games_won: 0, tiebreaks_won: 0, max_points_in_a_row: 0 });
    st.lines = { home: [], away: [] };
  },
  next(st) { const extra = st.changeover ? 90 : 0; st.changeover = false; return between(st, 25, 48) + extra; },
  cur(st) { return st.sets[st.sets.length - 1]; },
  resolve(st) {
    const srv = st.server; const rcv = other(srv); const p = st.p[srv]; const SS = st.stats[srv];
    const plays = [];
    const bp = !st.tb && st.pts[rcv] >= 3 && st.pts[rcv] - st.pts[srv] >= 1;
    let w;
    SS.first_serve_attempts += 1;
    if (chance(st, 0.62)) {
      SS.first_serve_successful += 1;
      if (chance(st, 0.08 + (p - 0.63) * 0.3)) { w = srv; SS.aces += 1; plays.push({ team: srv, kind: 'ace', text: `Ace — ${st.names[srv]}` }); }
      else w = chance(st, p + 0.07) ? srv : rcv;
      if (w === srv) SS.first_serve_points_won += 1;
    } else {
      SS.second_serve_attempts += 1;
      if (chance(st, 0.075)) { w = rcv; SS.double_faults += 1; plays.push({ team: srv, kind: 'double_fault', text: `Double fault — ${st.names[srv]}` }); }
      else { SS.second_serve_successful += 1; w = chance(st, p - 0.12) ? srv : rcv; if (w === srv) SS.second_serve_points_won += 1; }
    }
    if (w === srv) SS.service_points_won += 1; else SS.service_points_lost += 1;
    st.stats[w].points_won += 1;
    st.run = st.run.side === w ? { side: w, n: st.run.n + 1 } : { side: w, n: 1 };
    st.stats[w].max_points_in_a_row = Math.max(st.stats[w].max_points_in_a_row, st.run.n);
    if (bp) { st.stats[rcv].total_breakpoints += 1; if (w === rcv) st.stats[rcv].breakpoints_won += 1; else plays.push({ team: srv, kind: 'break_point_saved', text: `Break point saved by ${st.names[srv]}` }); }
    const set = this.cur(st);
    st.pts[w] += 1;
    if (st.tb) {
      if ((st.pts[w] - 1 + st.pts[other(w)]) % 2 === 0) st.server = other(st.server);
      if (st.pts[w] >= 7 && st.pts[w] - st.pts[other(w)] >= 2) {
        set[w] += 1; set.tb = { home: st.pts.home, away: st.pts.away }; st.stats[w].games_won += 1; st.stats[w].tiebreaks_won += 1;
        plays.push({ team: w, kind: 'tiebreak', text: `${st.names[w]} win the tiebreak ${Math.max(st.pts.home, st.pts.away)}-${Math.min(st.pts.home, st.pts.away)}` });
        st.tb = false; st.server = other(st.tbFirst);
        this.endSet(st, w, plays);
      }
      return plays;
    }
    if (st.pts[w] >= 4 && st.pts[w] - st.pts[other(w)] >= 2) {
      set[w] += 1; st.stats[w].games_won += 1;
      if (w === srv) { SS.service_games_won += 1; plays.push({ team: w, kind: 'hold', text: `${st.names[w]} hold serve (${set.home}-${set.away})` }); }
      else plays.push({ team: w, kind: 'break', text: `Break! ${st.names[w]} break ${st.names[srv]} (${set.home}-${set.away})` });
      st.pts = { home: 0, away: 0 }; st.server = other(st.server);
      if ((set.home >= 6 || set.away >= 6) && Math.abs(set.home - set.away) >= 2) this.endSet(st, w, plays);
      else if (set.home === 6 && set.away === 6) { st.tb = true; st.tbFirst = st.server; plays.push({ kind: 'tiebreak_start', text: 'Tiebreak' }); }
      else if ((set.home + set.away) % 2 === 1) st.changeover = true;
    }
    return plays;
  },
  endSet(st, w, plays) {
    const set = this.cur(st); set.winner = w; st.setsWon[w] += 1; st.score[w] = st.setsWon[w]; st.pts = { home: 0, away: 0 };
    st.lines.home.push(set.home); st.lines.away.push(set.away);
    plays.push({ team: w, kind: 'set', text: `${st.names[w]} take set ${st.sets.length} ${set[w]}-${set[other(w)]}` });
    if (st.setsWon[w] === 2) {
      st.done = true; st.winner = w;
      plays.push({ team: w, kind: 'final', text: `Game, set and match ${st.names[w]} (${st.sets.map((s) => `${s[w]}-${s[other(w)]}`).join(', ')})` });
    } else { st.sets.push({ home: 0, away: 0, winner: '' }); st.changeover = true; }
  },
  points(st) {
    if (st.tb) return { home: String(st.pts.home), away: String(st.pts.away), adv: '' };
    const { home: a, away: b } = st.pts;
    if (a >= 3 && b >= 3) return a === b ? { home: '40', away: '40', adv: '' } : a > b ? { home: 'A', away: '40', adv: 'home' } : { home: '40', away: 'A', adv: 'away' };
    return { home: PTS[Math.min(a, 3)], away: PTS[Math.min(b, 3)], adv: '' };
  },
  view(st) {
    const set = this.cur(st);
    if (st.done) return { period: st.sets.length, clock: `S${st.sets.length}`, label: 'Final' };
    return { period: st.sets.length, clock: `S${st.sets.length} ${set.home}-${set.away}`, label: `Set ${st.sets.length} · ${set.home}-${set.away}${st.tb ? ' · Tiebreak' : ''}` };
  },
  prob(st) {
    if (st.done) return finalProb(st);
    const ph = st.p.home; const pa = st.p.away; const set = this.cur(st);
    const { f } = tennisMath.set(ph, pa, 0, 0, 'home');
    let cur;
    if (st.tb) cur = tennisMath.tiebreak(ph, pa, st.pts.home, st.pts.away, st.tbFirst);
    else {
      const g = st.server === 'home' ? tennisMath.game(ph, st.pts.home, st.pts.away) : 1 - tennisMath.game(pa, st.pts.away, st.pts.home);
      const nx = other(st.server);
      cur = g * f(set.home + 1, set.away, nx) + (1 - g) * f(set.home, set.away + 1, nx);
    }
    const fresh = (tennisMath.set(ph, pa, 0, 0, 'home').v + tennisMath.set(ph, pa, 0, 0, 'away').v) / 2;
    const m = (a, b) => (a >= 2 ? 1 : b >= 2 ? 0 : fresh * m(a + 1, b) + (1 - fresh) * m(a, b + 1));
    const h = cur * m(st.setsWon.home + 1, st.setsWon.away) + (1 - cur) * m(st.setsWon.home, st.setsWon.away + 1);
    return { home: h, away: 1 - h, draw: 0 };
  },
  details(st) {
    const pts = this.points(st); const c = (s) => (s === 'home' ? 'competitor1' : 'competitor2');
    const rounds = (s) => st.sets.map((x) => ({ outcome: x.winner ? (x.winner === s ? 'winner' : 'loser') : 'ongoing', score: x[s], ...(x.tb ? { tiebreak_score: x.tb[s] } : {}) }));
    return {
      competitor1_is_home: true,
      competitor1_overall_score: st.setsWon.home, competitor2_overall_score: st.setsWon.away,
      home_overall_score: st.setsWon.home, away_overall_score: st.setsWon.away,
      competitor1_round_scores: rounds('home'), competitor2_round_scores: rounds('away'),
      competitor1_current_round_score: st.done ? '' : pts.home, competitor2_current_round_score: st.done ? '' : pts.away,
      advantage: pts.adv ? c(pts.adv) : '', server: st.done ? '' : c(st.server), in_tiebreak: st.tb,
      completed_rounds: st.sets.filter((x) => x.winner).length, match_status: st.done ? 'ended' : `${ord(st.sets.length)}_set`, best_of: 3,
      competitor1_statistics: st.stats.home, competitor2_statistics: st.stats.away,
      home_score: st.setsWon.home, away_score: st.setsWon.away,
    };
  },
  start(st) { return `${st.names[st.server]} to serve`; },
};

// ---- Cricket T20: two innings of 20 overs, one segment per delivery, target + required rate ----
const cricket = {
  type: 'cricket_match', label: 'Cricket', draw: false,
  init(st) {
    const first = rnd(st) < 0.5 ? 'home' : 'away';
    Object.assign(st, { first, batting: first, innings: 1, phase: 'play', target: null, recent: [], sf: { home: 1 + st.edge * 0.07, away: 1 - st.edge * 0.07 } });
    for (const s of SIDES) Object.assign(st.stats[s], { runs: 0, wickets: 0, balls: 0, fours: 0, sixes: 0, extras: 0, dots: 0 });
    st.lines = { home: [], away: [] };
  },
  next(st) { return st.phase === 'break' ? 600 : between(st, 28, 45); },
  resolve(st) {
    if (st.phase === 'break') {
      st.phase = 'play'; st.innings = 2; st.batting = other(st.first); st.recent = [];
      return [{ team: st.batting, kind: 'period', text: `${st.names[st.batting]} begin the chase — target ${st.target}` }];
    }
    const b = st.batting; const I = st.stats[b]; const over = Math.floor(I.balls / 6); const sf = st.sf[b];
    const pp = over < 6; const death = over >= 15;
    const out = weighted(st, [['wd', 0.035], ['W', (death ? 0.065 : 0.045) * (2 - sf)], ['0', 0.34], ['1', 0.36], ['2', 0.075], ['3', 0.006], ['4', (pp ? 0.135 : death ? 0.13 : 0.1) * sf], ['6', (pp ? 0.04 : death ? 0.075 : 0.045) * sf]]);
    const ballNo = out === 'wd' ? oversStr(I.balls) : oversStr(I.balls + 1);
    let text; let kind = 'ball'; let runs = 0;
    if (out === 'wd') { runs = 1; I.extras += 1; text = 'Wide, 1 extra'; kind = 'extra'; }
    else {
      I.balls += 1;
      if (out === 'W') { I.wickets += 1; kind = 'wicket'; text = `WICKET! ${st.names[b]} ${I.runs}/${I.wickets}`; }
      else { runs = Number(out); if (runs === 4) { I.fours += 1; kind = 'four'; text = 'FOUR!'; } else if (runs === 6) { I.sixes += 1; kind = 'six'; text = 'SIX!'; } else if (runs === 0) { I.dots += 1; text = 'No run'; } else text = `${runs} run${runs > 1 ? 's' : ''}`; }
    }
    I.runs += runs; st.score[b] = I.runs;
    st.recent = [...st.recent, out === '0' ? '•' : out].slice(-6);
    const plays = [{ team: b, kind, text: `${ballNo} · ${text}${kind === 'wicket' ? '' : ` (${st.names[b]} ${I.runs}/${I.wickets})`}`, pts: runs }];
    const allOut = I.wickets >= 10; const overs = I.balls >= 120;
    if (st.innings === 2 && I.runs >= st.target) return this.finish(st, plays);
    if (allOut || overs) {
      if (st.innings === 1) {
        st.target = I.runs + 1; st.phase = 'break'; st.lines[b].push(I.runs);
        plays.push({ kind: 'period', text: `Innings break — ${st.names[other(b)]} need ${st.target} to win` });
      } else return this.finish(st, plays);
    }
    return plays;
  },
  finish(st, plays) {
    const b = st.batting; const f = other(b); const I = st.stats[b];
    st.lines[b].push(I.runs); st.done = true;
    if (I.runs >= st.target) { st.winner = b; st.result_text = `${st.names[b]} won by ${10 - I.wickets} wicket${10 - I.wickets === 1 ? '' : 's'}`; }
    else if (I.runs === st.target - 1) {
      // Design choice: a tie is decided on boundary count, then fewer wickets lost, then the home side.
      const bd = (s) => st.stats[s].fours + st.stats[s].sixes;
      st.winner = bd(b) !== bd(f) ? (bd(b) > bd(f) ? b : f) : st.stats[b].wickets !== st.stats[f].wickets ? (st.stats[b].wickets < st.stats[f].wickets ? b : f) : 'home';
      st.result_text = `Match tied — ${st.names[st.winner]} win on boundary count`;
    } else { st.winner = f; st.result_text = `${st.names[f]} won by ${st.target - 1 - I.runs} runs`; }
    plays.push({ team: st.winner, kind: 'final', text: st.result_text });
    return plays;
  },
  view(st) {
    if (st.done) return { period: 2, clock: oversStr(st.stats[st.batting].balls), label: 'Final' };
    if (st.phase === 'break') return { period: 1, clock: 'Break', label: 'Innings break' };
    const ov = oversStr(st.stats[st.batting].balls);
    return { period: st.innings, clock: ov, label: `${st.innings === 1 ? '1st' : '2nd'} inns · ${ov} ov` };
  },
  expect(st, s, balls, wkts) {
    const res = (balls / 120) ** 0.85 * (1 - (wkts / 10) ** 1.6);
    return { e: 165 * st.sf[s] * res, sd: 22 * Math.sqrt(Math.max(res, 0)) + 3 };
  },
  prob(st) {
    if (st.done) return finalProb(st);
    const b = st.batting; const I = st.stats[b];
    let pb;
    if (st.innings === 2 && st.phase === 'play') {
      const need = st.target - I.runs; const { e, sd } = this.expect(st, b, 120 - I.balls, I.wickets);
      pb = need <= 0 ? 1 : 1 - Phi((need - 0.5 - e) / sd);
    } else {
      const first = st.first; const chase = other(first); const F = st.stats[first];
      const rem = st.phase === 'break' ? { e: 0, sd: 0 } : this.expect(st, first, 120 - F.balls, F.wickets);
      const full = this.expect(st, chase, 120, 0);
      const pc = Phi((full.e - (F.runs + rem.e)) / Math.sqrt(rem.sd ** 2 + full.sd ** 2));
      return chase === 'home' ? { home: pc, away: 1 - pc, draw: 0 } : { home: 1 - pc, away: pc, draw: 0 };
    }
    return b === 'home' ? { home: pb, away: 1 - pb, draw: 0 } : { home: 1 - pb, away: pb, draw: 0 };
  },
  details(st) {
    const b = st.batting; const I = st.stats[b]; const d = { allotted_overs: 20, current_inning: st.innings, batting: st.done ? '' : b, target: st.target, recent_balls: st.recent };
    for (const s of SIDES) {
      const S = st.stats[s];
      Object.assign(d, { [`${s}_total_runs`]: S.runs, [`${s}_wickets`]: S.wickets, [`${s}_overs`]: Number(oversStr(S.balls)), [`${s}_balls`]: S.balls, [`${s}_fours`]: S.fours, [`${s}_sixes`]: S.sixes, [`${s}_score`]: S.runs });
    }
    d.run_rate = I.balls ? Math.round((I.runs / (I.balls / 6)) * 100) / 100 : 0;
    if (st.innings === 2 && !st.done && st.phase === 'play') {
      const need = st.target - I.runs; const left = 120 - I.balls;
      d.required_run_rate = left ? Math.round((need / (left / 6)) * 100) / 100 : null; d.balls_remaining = left; d.runs_required = need;
      d.match_comment = `${st.names[b]} need ${need} run${need === 1 ? '' : 's'} from ${left} ball${left === 1 ? '' : 's'}.`;
    } else if (st.done) d.match_comment = st.result_text;
    else if (st.phase === 'break') d.match_comment = `${st.names[other(st.first)]} need ${st.target} to win.`;
    else d.match_comment = `${st.names[b]} are ${I.runs} for ${I.wickets} after ${oversStr(I.balls)} overs.`;
    return d;
  },
  start(st) { return `${st.names[st.first]} won the toss and will bat first`; },
};

// ---- Esports: best of 3 maps, first to 13 rounds (win by 2 from 12-12), one segment per round ----
const esports = {
  type: 'esports_match', label: 'Esports', draw: false,
  init(st) {
    Object.assign(st, { pBase: 0.5 + st.edge * 0.06, map: 1, maps: [{ home: 0, away: 0, winner: '', dur: 0 }], mapsWon: { home: 0, away: 0 }, phase: 'play', streak: { side: '', n: 0 } });
    st.pm = clamp(st.pBase + (rnd(st) - 0.5) * 0.08, 0.2, 0.8);
    for (const s of SIDES) Object.assign(st.stats[s], { maps_won: 0, rounds_won: 0, pistol_rounds_won: 0, max_rounds_in_a_row: 0 });
    st.lines = { home: [0], away: [0] };
  },
  next(st) { return st.phase === 'break' ? 300 : between(st, 80, 120); },
  mapDone: (a, b) => a >= 13 && a - b >= 2,
  resolve(st) {
    if (st.phase === 'break') {
      st.phase = 'play'; st.map += 1; st.maps.push({ home: 0, away: 0, winner: '', dur: 0 }); st.lines.home.push(0); st.lines.away.push(0);
      st.pm = clamp(st.pBase + (rnd(st) - 0.5) * 0.08, 0.2, 0.8);
      return [{ kind: 'period', text: `Map ${st.map} is live` }];
    }
    const m = st.maps[st.map - 1]; m.dur += st.segDur;
    const w = chance(st, st.pm) ? 'home' : 'away';
    const round = m.home + m.away + 1;
    m[w] += 1; st.lines[w][st.map - 1] = m[w];
    st.stats[w].rounds_won += 1; if (round === 1 || round === 13) st.stats[w].pistol_rounds_won += 1;
    st.streak = st.streak.side === w ? { side: w, n: st.streak.n + 1 } : { side: w, n: 1 };
    st.stats[w].max_rounds_in_a_row = Math.max(st.stats[w].max_rounds_in_a_row, st.streak.n);
    const plays = [{ team: w, kind: 'round', text: `Round ${round}: ${st.names[w]} win (${m.home}-${m.away})` }];
    if (this.mapDone(m[w], m[other(w)])) {
      m.winner = w; st.mapsWon[w] += 1; st.stats[w].maps_won += 1; st.score[w] = st.mapsWon[w];
      plays.push({ team: w, kind: 'map', text: `${st.names[w]} take map ${st.map} ${m[w]}-${m[other(w)]}` });
      if (st.mapsWon[w] === 2) { st.done = true; st.winner = w; plays.push({ team: w, kind: 'final', text: `${st.names[w]} win the series ${st.mapsWon[w]}-${st.mapsWon[other(w)]}` }); }
      else st.phase = 'break';
    }
    return plays;
  },
  view(st) {
    const m = st.maps[st.map - 1];
    if (st.done) return { period: st.map, clock: `M${st.map}`, label: 'Final' };
    if (st.phase === 'break') return { period: st.map, clock: `M${st.map}`, label: `Map ${st.map} complete` };
    return { period: st.map, clock: `M${st.map} R${m.home + m.away + 1}`, label: `Map ${st.map} · ${m.home}-${m.away}` };
  },
  mapProb(p, a, b) {
    const memo = new Map();
    const f = (x, y) => {
      if (this.mapDone(x, y)) return 1; if (this.mapDone(y, x)) return 0;
      if (x >= 12 && y >= 12 && x === y) return (p * p) / (p * p + (1 - p) * (1 - p));
      const k = `${x}:${y}`; if (memo.has(k)) return memo.get(k);
      const v = p * f(x + 1, y) + (1 - p) * f(x, y + 1); memo.set(k, v); return v;
    };
    return f(a, b);
  },
  prob(st) {
    if (st.done) return finalProb(st);
    const m = st.maps[st.map - 1];
    const cur = st.phase === 'break' ? null : this.mapProb(st.pm, m.home, m.away);
    const fresh = this.mapProb(st.pBase, 0, 0);
    const ser = (a, b) => (a >= 2 ? 1 : b >= 2 ? 0 : fresh * ser(a + 1, b) + (1 - fresh) * ser(a, b + 1));
    const h = cur == null ? ser(st.mapsWon.home, st.mapsWon.away) : cur * ser(st.mapsWon.home + 1, st.mapsWon.away) + (1 - cur) * ser(st.mapsWon.home, st.mapsWon.away + 1);
    return { home: h, away: 1 - h, draw: 0 };
  },
  details(st) {
    const per = (s) => Object.fromEntries(st.maps.map((m, i) => [`period_${i + 1}`, m[s]]));
    const done = (s) => st.maps.filter((m) => m.winner).map((m, i) => ({ period: `period_${i + 1}`, stats: { map_duration_seconds: Math.round(m.dur), map_forfeit: 0, winner: m.winner === s ? 1 : 0 } }));
    return { home_periods: per('home'), away_periods: per('away'), home_score: st.mapsWon.home, away_score: st.mapsWon.away, period_unit: 'map', score_format: 'series', current_period: st.map, best_of: 3, home_stats: done('home'), away_stats: done('away'), is_live: !st.done };
  },
  start(st) { return `Map 1 is live — ${st.names.home} vs ${st.names.away}`; },
};

// ---- Ice hockey (Phase 5B, PLAN G9): 3 × 20 min, one segment per 30-60 s of play, minor penalties → power plays
// (2:00, ended by a power-play goal), 5-min 3-on-3 sudden-death overtime, then a best-of-3 shootout (the winner is
// credited one goal, as in the common convention). Every rate and rule here is a Parlance design choice.
const pName = (p) => (p <= 3 ? `P${p}` : p === 4 ? 'OT' : 'SO');
const hockey = {
  type: 'hockey_game', label: 'Hockey', draw: false,
  init(st, cfg) {
    const pLen = cfg.pLen || 1200;
    Object.assign(st, { pLen, period: 1, remain: pLen, phase: 'play', pp: null, so: null, lam: { home: (3.05 + st.edge * 0.9) / 3600, away: (2.75 - st.edge * 0.9) / 3600 } });
    for (const s of SIDES) Object.assign(st.stats[s], { goals: 0, shots: 0, power_plays: 0, power_play_goals: 0, penalty_minutes: 0, hits: 0, faceoffs_won: 0, saves: 0 });
    st.lines = { home: [0], away: [0] };
  },
  next(st) { return st.phase === 'break' ? (st.period >= 3 ? 120 : 900) : st.phase === 'shootout' ? 45 : Math.min(st.remain, between(st, 30, 60)); },
  // Goals per second for side s: power play ×2.4, short-handed ×0.25, 3-on-3 overtime ×1.7.
  rate(st, s) {
    let r = st.lam[s];
    if (st.pp) r *= st.pp.team === s ? 2.4 : 0.25;
    if (st.period === 4) r *= 1.7;
    return r;
  },
  goal(st, s, plays, how) {
    st.score[s] += 1; st.stats[s].goals += 1; st.stats[s].shots += 1; st.lines[s][lastLine(st, s)] += 1;
    const ppg = st.pp && st.pp.team === s;
    if (ppg) { st.stats[s].power_play_goals += 1; st.pp = null; }
    plays.push({ team: s, kind: 'goal', text: `GOAL! ${st.names[s]}${ppg ? ' (power play)' : how ? ` (${how})` : ''} — ${st.names.home} ${st.score.home}-${st.score.away} ${st.names.away}` });
  },
  resolve(st) {
    const plays = [];
    if (st.phase === 'break') {
      st.period += 1; st.phase = 'play'; st.lines.home.push(0); st.lines.away.push(0);
      if (st.period === 4) { st.remain = 300; return [{ kind: 'period', text: 'Overtime: 3-on-3, next goal wins' }]; }
      if (st.period === 5) { st.phase = 'shootout'; st.so = { round: 0, home: 0, away: 0, shots: { home: 0, away: 0 } }; return [{ kind: 'period', text: 'Shootout' }]; }
      st.remain = st.pLen;
      return [{ kind: 'period', text: `Start of the ${ord(st.period)} period` }];
    }
    if (st.phase === 'shootout') {
      const so = st.so;
      for (const s of SIDES) { so.shots[s] += 1; if (chance(st, 0.32 + (s === 'home' ? st.edge : -st.edge) * 0.04)) { so[s] += 1; plays.push({ team: s, kind: 'shootout_goal', text: `Shootout: ${st.names[s]} score (${so.home}-${so.away})` }); } else plays.push({ team: s, kind: 'shootout_miss', text: `Shootout: ${st.names[s]} denied` }); }
      so.round += 1;
      const left = Math.max(0, 3 - so.round);
      const decided = so.round >= 3 ? so.home !== so.away : Math.abs(so.home - so.away) > left;
      st.lines.home[lastLine(st, 'home')] = so.home; st.lines.away[lastLine(st, 'away')] = so.away;
      if (decided) {
        const w = so.home > so.away ? 'home' : 'away';
        st.score[w] += 1; st.done = true; st.winner = w;
        plays.push({ team: w, kind: 'final', text: `Final (SO): ${st.names.home} ${st.score.home}, ${st.names.away} ${st.score.away}` });
      }
      return plays;
    }
    st.remain = Math.max(0, st.remain - st.segDur);
    const dur = st.segDur;
    if (st.pp) { st.pp.left -= dur; if (st.pp.left <= 0) { plays.push({ team: st.pp.team, kind: 'pp_end', text: `${st.names[other(st.pp.team)]} back to full strength` }); st.pp = null; } }
    for (const s of SIDES) {
      const S = st.stats[s];
      if (chance(st, 1 - Math.exp(-this.rate(st, s) * dur))) {
        this.goal(st, s, plays);
        if (st.period === 4) break;
      } else if (chance(st, dur / 120)) { S.shots += 1; st.stats[other(s)].saves += 1; if (chance(st, 0.12)) plays.push({ team: s, kind: 'shot', text: `Save! ${st.names[other(s)]} stop a shot from ${st.names[s]}` }); }
      if (chance(st, dur / 160)) S.hits += 1;
    }
    if (chance(st, dur / 70)) st.stats[chance(st, 0.5 + st.edge * 0.05) ? 'home' : 'away'].faceoffs_won += 1;
    if (!st.done && st.period <= 4 && !st.pp && chance(st, dur / 900)) {
      const off = chance(st, 0.5) ? 'home' : 'away'; const on = other(off);
      st.stats[off].penalty_minutes += 2; st.stats[on].power_plays += 1;
      st.pp = { team: on, left: 120 };
      plays.push({ team: off, kind: 'penalty', text: `Penalty ${st.names[off]}: ${pick(st, ['tripping', 'hooking', 'slashing', 'interference', 'holding'])} (2:00) — ${st.names[on]} power play` });
    }
    if (st.period === 4 && st.score.home !== st.score.away) {
      st.done = true; st.winner = st.score.home > st.score.away ? 'home' : 'away';
      plays.push({ kind: 'final', text: `Final (OT): ${st.names.home} ${st.score.home}, ${st.names.away} ${st.score.away}` });
      return plays;
    }
    if (st.remain <= 0) {
      if (st.period >= 3 && st.score.home !== st.score.away) {
        st.done = true; st.winner = st.score.home > st.score.away ? 'home' : 'away';
        plays.push({ kind: 'final', text: `Final: ${st.names.home} ${st.score.home}, ${st.names.away} ${st.score.away}` });
      } else {
        st.phase = 'break'; st.pp = st.period >= 3 ? null : st.pp;
        plays.push({ kind: 'period', text: st.period >= 3 ? (st.period === 3 ? 'End of regulation — tied, overtime' : 'End of overtime — shootout') : `End of the ${ord(st.period)} period` });
      }
    }
    return plays;
  },
  view(st, part) {
    if (st.done) return { period: st.period, clock: '0:00', label: 'Final' };
    if (st.phase === 'shootout') return { period: 5, clock: 'SO', label: `Shootout · ${st.so.home}-${st.so.away}` };
    if (st.phase === 'break') return { period: st.period, clock: '0:00', label: st.period >= 3 ? (st.period === 3 ? 'End of regulation' : 'End of overtime') : `${ord(st.period)} intermission` };
    const c = mmss(Math.max(0, st.remain - part));
    return { period: st.period, clock: c, label: `${pName(st.period)} ${c}` };
  },
  remaining(st) { return st.period > 3 ? 0 : (st.phase === 'break' ? 0 : st.remain) + (3 - st.period) * st.pLen; },
  prob(st) {
    if (st.done) return finalProb(st);
    const otHome = clamp(0.5 + st.edge * 0.08, 0.3, 0.7);
    if (st.phase === 'shootout') {
      const so = st.so; const lead = so.home - so.away; const left = Math.max(1, 3 - so.round);
      const h = clamp(0.5 + lead / (2 * left) * 0.8 + st.edge * 0.03, 0.02, 0.98);
      return { home: h, away: 1 - h, draw: 0 };
    }
    if (st.period === 4) {
      // Sudden death: next goal wins (rates over the time left), else the shootout.
      const T = st.phase === 'break' ? 0 : st.remain; const rh = this.rate(st, 'home'); const ra = this.rate(st, 'away');
      const any = 1 - Math.exp(-(rh + ra) * T);
      const h = any * (rh / (rh + ra)) + (1 - any) * otHome;
      return { home: h, away: 1 - h, draw: 0 };
    }
    const R = this.remaining(st);
    const ph = poisson(this.rate(st, 'home') * R, 14); const pa = poisson(this.rate(st, 'away') * R, 14);
    let h = 0; let a = 0; let d = 0;
    for (let i = 0; i < ph.length; i++) for (let j = 0; j < pa.length; j++) {
      const diff = st.score.home + i - (st.score.away + j); const p = ph[i] * pa[j];
      if (diff > 0) h += p; else if (diff < 0) a += p; else d += p;
    }
    const t = h + a + d;
    const home = (h + d * otHome) / t;
    return { home, away: 1 - home, draw: 0 };
  },
  details(st, part) {
    return { period: st.period, period_name: pName(st.period), power_play: st.pp ? { team: st.pp.team, remaining_seconds: Math.max(0, Math.ceil(st.pp.left - part)) } : null,
      home_shots: st.stats.home.shots, away_shots: st.stats.away.shots, shootout: st.so ? { round: st.so.round, home: st.so.home, away: st.so.away } : null, period_length_seconds: st.pLen };
  },
  start: (st) => `Puck drop — ${st.names.home} vs ${st.names.away}`,
};

const SPORT = { soccer, basketball, football, tennis, cricket, esports, hockey };

// Phase 5B (PLAN G9): the running game clock behind every live scoreboard and the event header label. `seconds` is the
// clock value at `updated_ts`; clients advance it by `rate` (game seconds per real second) while `running`.
// Countdown clocks (basketball, football, hockey), the match minute (soccer), the match time (tennis) and the map time
// (esports) run; cricket counts overs, not time.
function gameClock(sport, st, live, part) {
  const off = (name) => ({ name, seconds: null, running: false, direction: 'up', format: 'none' });
  if (!live || st.done) return off('');
  switch (sport) {
    case 'basketball': case 'football':
      if (st.phase !== 'play') return off(SPORT[sport].view(st, 0).label);
      return { name: qName(st.quarter), seconds: Math.max(0, st.remain - part), running: true, direction: 'down', format: 'mmss' };
    case 'hockey':
      if (st.phase !== 'play') return off(hockey.view(st, 0).label);
      return { name: pName(st.period), seconds: Math.max(0, st.remain - part), running: true, direction: 'down', format: 'mmss' };
    case 'soccer':
      if (st.phase === 'ht') return off('Half-time');
      return { name: st.half === 1 ? '1st half' : '2nd half', seconds: st.clock + part, running: true, direction: 'up', format: 'minute', cap: st.half * 2700 };
    case 'tennis': { const set = tennis.cur(st); return { name: `Set ${st.sets.length} · ${set.home}-${set.away}${st.tb ? ' · Tiebreak' : ''}`, seconds: st.t, running: true, direction: 'up', format: 'hmmss', label: 'Match time' }; }
    case 'esports': {
      const m = st.maps[st.map - 1];
      if (st.phase !== 'play') return off(`Map ${st.map} complete`);
      return { name: `Map ${st.map} · ${m.home}-${m.away}`, seconds: m.dur + part, running: true, direction: 'up', format: 'mmss', label: 'Map time' };
    }
    default: return off(SPORT[sport].view(st, part).label);
  }
}

// =====================================================================================================
// Invented leagues, teams and players (no real leagues, clubs, marks or people).
// =====================================================================================================
const LEAGUES = [
  { id: 'GPL', sport: 'football', name: 'Gridiron Pro League', short: 'GPL', featured: 1, cfg: { qLen: 900 }, homeAdv: 0.12,
    teams: [['Bayport Pilots', 'Pilots', 'BAY', '#2f6fed'], ['Ironwood Bison', 'Bison', 'IRW', '#9c6b3c'], ['Redrock Prospectors', 'Prospectors', 'RRP', '#d9480f'], ['Northwind Sentinels', 'Sentinels', 'NWS', '#2b8a3e']] },
  { id: 'CGA', sport: 'football', name: 'Collegiate Gridiron Association', short: 'College Gridiron', featured: 1, cfg: { qLen: 900 }, homeAdv: 0.15,
    teams: [['Alder State Foresters', 'Foresters', 'ALS', '#37b24d'], ['Marlow Tech Engineers', 'Engineers', 'MTE', '#f59f00'], ['Pinecrest Lynx', 'Lynx', 'PCL', '#7048e8'], ['Coldwater Herons', 'Herons', 'CWH', '#1c7ed6']] },
  { id: 'CHL', sport: 'basketball', name: 'Coast Hoops League', short: 'CHL', featured: 1, cfg: { qLen: 720 }, homeAdv: 0.1,
    teams: [['Seaside Hawks', 'Hawks', 'SEA', '#0b7285'], ['Granite Bears', 'Bears', 'GRB', '#5c940d'], ['Midnight Owls', 'Owls', 'MID', '#862e9c'], ['Desert Foxes', 'Foxes', 'DSF', '#c92a2a']] },
  { id: 'CHW', sport: 'basketball', name: 'Collegiate Hoops (W)', short: 'College Hoops (W)', featured: 1, cfg: { qLen: 600 }, homeAdv: 0.15,
    teams: [['Fairhaven Larks', 'Larks', 'FHL', '#e64980'], ['Holloway State Wrens', 'Wrens', 'HSW', '#1098ad'], ['Merritt Cardinals', 'Cardinals', 'MER', '#e03131'], ["St. Brigid's Belles", 'Belles', 'SBB', '#4c6ef5']] },
  { id: 'CPL', sport: 'soccer', name: 'Coastal Premier League', short: 'CPL', featured: 1, cfg: {}, homeAdv: 0.15,
    teams: [['Saltmarsh Rovers', 'Rovers', 'SAL', '#1971c2'], ['Ironbridge Athletic', 'Athletic', 'IRB', '#c2255c'], ['Lakeside Wanderers', 'Wanderers', 'LAK', '#2f9e44'], ['Port Alder', 'Port Alder', 'PAL', '#f08c00'], ['Northgate United', 'United', 'NGU', '#5f3dc4'], ['Kingsferry Town', 'Town', 'KFT', '#0ca678']] },
  { id: 'LHO', sport: 'tennis', name: 'Lighthouse Open', short: 'Lighthouse Open', featured: 0, cfg: {}, homeAdv: 0, competition: "Lighthouse Open · Women's Singles",
    teams: [['Ines Calloway', 'Calloway', 'CAL', '#d6336c'], ['Petra Vandermolen', 'Vandermolen', 'VDM', '#3b5bdb'], ['Ruth Okonjo', 'Okonjo', 'OKO', '#0c8599'], ['Lena Marchetti', 'Marchetti', 'MRC', '#e8590c'], ['Sofia Arrowsmith', 'Arrowsmith', 'ARR', '#6741d9'], ['Maren Holt', 'Holt', 'HLT', '#2b8a3e']] },
  { id: 'HTB', sport: 'cricket', name: 'Harbor T20 Bash', short: 'T20 Bash', featured: 0, cfg: {}, homeAdv: 0.08,
    teams: [['Harbor Mariners', 'Mariners', 'HMA', '#1864ab'], ['Ridgeback Kings', 'Kings', 'RBK', '#e67700'], ['Saltpan Strikers', 'Strikers', 'SPS', '#c2255c'], ['Emerald Falcons', 'Falcons', 'EMF', '#087f5b']] },
  { id: 'VXM', sport: 'esports', name: 'Vector Masters', short: 'Vector Masters', featured: 0, cfg: {}, homeAdv: 0, competition: 'Vector Masters · Playoffs',
    teams: [['Nullpoint', 'Nullpoint', 'NUL', '#7950f2'], ['Kite Theory', 'Kite Theory', 'KIT', '#15aabf'], ['Orbit Five', 'Orbit Five', 'OR5', '#fd7e14'], ['Static Bloom', 'Static Bloom', 'STB', '#e64980']] },
  // Phase 5B (PLAN G9): invented ice-hockey league.
  { id: 'IHL', sport: 'hockey', name: 'Icebound Hockey League', short: 'IHL', featured: 0, cfg: { pLen: 1200 }, homeAdv: 0.1,
    teams: [['Frostport Narwhals', 'Narwhals', 'FPN', '#1c7ed6'], ['Glacier Bay Lumberjacks', 'Lumberjacks', 'GBL', '#2b8a3e'], ['Northreach Lynx', 'Lynx', 'NRL', '#862e9c'], ['Kettle Falls Comets', 'Comets', 'KFC', '#e8590c']] },
];
const RATINGS = [0.25, 0.1, -0.05, -0.2, 0.15, -0.25];

// Seeded fixtures relative to boot: [league, home, away, mode, arg]. Times are game minutes (scaled by speed).
const FIXTURES = [
  ['CPL', 0, 1, 'live', { minute: 58 }], ['CPL', 2, 3, 'live', { minute: 84 }], ['CPL', 4, 5, 'upcoming', 30], ['CPL', 1, 2, 'final', 150],
  ['CHL', 0, 1, 'live', { quarter: 3, remain: 360 }], ['CHL', 2, 3, 'upcoming', 60], ['CHL', 3, 0, 'final', 120],
  ['CHW', 0, 1, 'live', { quarter: 2, remain: 300 }], ['CHW', 2, 3, 'upcoming', 120],
  ['GPL', 0, 1, 'live', { quarter: 2, remain: 500 }], ['GPL', 2, 3, 'upcoming', 40], ['GPL', 1, 2, 'final', 200],
  ['CGA', 0, 1, 'upcoming', 25], ['CGA', 2, 3, 'upcoming', 180],
  ['LHO', 0, 1, 'live', { set: 2, games: 3, tiebreakSet1: true }], ['LHO', 2, 3, 'upcoming', 45], ['LHO', 4, 5, 'final', 90],
  ['HTB', 0, 1, 'live', { innings: 2, overs: 8 }], ['HTB', 2, 3, 'upcoming', 90],
  ['VXM', 0, 1, 'live', { map: 2, round: 6 }], ['VXM', 2, 3, 'upcoming', 50],
  ['IHL', 0, 1, 'live', { period: 2, remain: 1000 }], ['IHL', 2, 3, 'upcoming', 35], ['IHL', 1, 2, 'final', 110],
];
const LIVE_AT = {
  soccer: (st, a) => st.clock / 60 >= a.minute,
  basketball: (st, a) => st.phase === 'play' && (st.quarter > a.quarter || (st.quarter === a.quarter && st.remain <= a.remain)),
  football: (st, a) => st.phase === 'play' && (st.quarter > a.quarter || (st.quarter === a.quarter && st.remain <= a.remain)),
  tennis: (st, a) => st.sets.length >= a.set && st.sets[a.set - 1].home + st.sets[a.set - 1].away >= a.games,
  cricket: (st, a) => st.innings >= a.innings && st.phase === 'play' && st.stats[st.batting].balls >= a.overs * 6,
  esports: (st, a) => st.map >= a.map && st.phase === 'play' && st.maps[st.map - 1].home + st.maps[st.map - 1].away >= a.round,
  hockey: (st, a) => st.phase === 'play' && (st.period > a.period || (st.period === a.period && st.remain <= a.remain)),
};
const LIVE_OK = { tennis: (st, a) => !a.tiebreakSet1 || !!st.sets[0].tb };

const SEED_KEY = 'sports_seed_v1';
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sports_leagues (id TEXT PRIMARY KEY, sport TEXT NOT NULL, name TEXT NOT NULL, short_name TEXT NOT NULL, series_ticker TEXT NOT NULL, featured INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS sports_teams (id TEXT PRIMARY KEY, league_id TEXT NOT NULL, name TEXT NOT NULL, short_name TEXT NOT NULL, abbr TEXT NOT NULL, color TEXT NOT NULL, rating REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sports_milestones (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, sport TEXT NOT NULL, league_id TEXT NOT NULL, title TEXT NOT NULL, competition TEXT NOT NULL,
  home_id TEXT NOT NULL, away_id TEXT NOT NULL, start_ts INTEGER NOT NULL, status TEXT NOT NULL,         -- scheduled|live|final
  seed INTEGER NOT NULL, state_json TEXT NOT NULL, home_score INTEGER NOT NULL DEFAULT 0, away_score INTEGER NOT NULL DEFAULT 0,
  win_home REAL NOT NULL DEFAULT 0.5, win_away REAL NOT NULL DEFAULT 0.5, win_draw REAL NOT NULL DEFAULT 0, winner TEXT NOT NULL DEFAULT '',
  live_label TEXT NOT NULL DEFAULT '', last_play TEXT NOT NULL DEFAULT '', play_seq INTEGER NOT NULL DEFAULT 0,
  started_ts INTEGER, ended_ts INTEGER, updated_ts INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_sports_ms_status ON sports_milestones(status, start_ts);
CREATE TABLE IF NOT EXISTS sports_plays (milestone_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, game_t REAL NOT NULL, period INTEGER NOT NULL, clock TEXT NOT NULL,
  team TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, text TEXT NOT NULL, home_score INTEGER NOT NULL, away_score INTEGER NOT NULL, win_home REAL NOT NULL, PRIMARY KEY (milestone_id, seq));
CREATE TABLE IF NOT EXISTS sports_stats (milestone_id TEXT NOT NULL, side TEXT NOT NULL, stat TEXT NOT NULL, value REAL NOT NULL, PRIMARY KEY (milestone_id, side, stat));
CREATE TABLE IF NOT EXISTS sports_event_links (event_ticker TEXT PRIMARY KEY, milestone_id TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS sports_markets (market_ticker TEXT PRIMARY KEY, milestone_id TEXT NOT NULL, outcome TEXT NOT NULL, quoted_cents INTEGER, quoted_ts INTEGER);
CREATE INDEX IF NOT EXISTS idx_sports_mk_ms ON sports_markets(milestone_id);
CREATE TABLE IF NOT EXISTS sports_line_events (event_ticker TEXT PRIMARY KEY, milestone_id TEXT NOT NULL UNIQUE, game_event_ticker TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sports_lines (market_ticker TEXT PRIMARY KEY, milestone_id TEXT NOT NULL, event_ticker TEXT NOT NULL, kind TEXT NOT NULL, side TEXT NOT NULL DEFAULT '', line REAL NOT NULL,
  fair REAL, quoted_cents INTEGER, quoted_ts INTEGER, priced_ts INTEGER);
CREATE INDEX IF NOT EXISTS idx_sports_lines_ms ON sports_lines(milestone_id);
`;

function mountSports({ v1, db, engine, eventFull, getEvent, options = {} }) {
  const speed = Math.max(0.01, Number(options.speed ?? process.env.SPORTS_SPEED ?? 1) || 1);
  const requoteMs = Number(options.requoteMs ?? 1000);
  const settleSec = Number(options.settlementSeconds ?? 5);
  const DEPTH = Number(options.depthContracts ?? 150) * UNITS; // resting liquidity per side
  const PRINT = 1 * UNITS; // reference print at the fair price when the probability moves
  const LINE_SIMS = Math.max(20, Number(options.lineSims ?? 120)); // Monte Carlo paths per spread/total price
  const LINES_MS = Number(options.linesMs ?? 4000); // re-price spreads/totals at most this often per game (real ms)
  db.exec(SCHEMA);

  // A full reset (`npm run seed`) wipes `meta`; our rows then point at deleted events, so start over.
  if (!db.prepare('SELECT 1 FROM meta WHERE key=?').get(SEED_KEY)) {
    db.exec('DELETE FROM sports_plays; DELETE FROM sports_stats; DELETE FROM sports_markets; DELETE FROM sports_event_links; DELETE FROM sports_lines; DELETE FROM sports_line_events; DELETE FROM sports_milestones; DELETE FROM sports_teams; DELETE FROM sports_leagues;');
  }
  const sysUser = (email, name, cents) => {
    const u = db.prepare('SELECT id FROM users WHERE email=?').get(email);
    if (u) return u.id;
    const id = newId('u_');
    db.prepare('INSERT INTO users(id,email,display_name,password_hash,is_admin,is_system,balance_cents,created_at) VALUES(?,?,?,?,0,1,?,?)').run(id, email, name, hashPassword(newId()), cents, nowIso());
    require('./journal').openUser(db, id, 'opening balance (system liquidity account)'); // double-entry journal (CLONE_SPEC.md §26.6)
    return id;
  };
  const LP = () => db.prepare("SELECT id FROM users WHERE email='liquidity@parlance.local'").get()?.id;
  const FLOW = sysUser('sportsflow@parlance.local', 'Parlance Sports Flow', 100_000_00);

  // ---------- reference data (cached; tiny and static once created) ----------
  // Leagues added in later releases (Phase 5B hockey) are inserted into existing databases too.
  if (LEAGUES.some((lg) => !db.prepare('SELECT 1 FROM sports_leagues WHERE id=?').get(lg.id))) {
    tx(db, () => {
      LEAGUES.forEach((lg, i) => {
        if (db.prepare('SELECT 1 FROM sports_leagues WHERE id=?').get(lg.id)) return;
        db.prepare('INSERT INTO sports_leagues(id,sport,name,short_name,series_ticker,featured,sort,config) VALUES(?,?,?,?,?,?,?,?)')
          .run(lg.id, lg.sport, lg.name, lg.short, `PLX${lg.id}`, lg.featured, i, JSON.stringify({ ...lg.cfg, homeAdv: lg.homeAdv, competition: lg.competition || lg.name }));
        lg.teams.forEach(([name, short, abbr, color], j) => db.prepare('INSERT INTO sports_teams(id,league_id,name,short_name,abbr,color,rating) VALUES(?,?,?,?,?,?,?)')
          .run(`${lg.id}-${abbr}`, lg.id, name, short, abbr, color, RATINGS[j % RATINGS.length]));
      });
    });
  }
  const leagues = new Map(db.prepare('SELECT * FROM sports_leagues ORDER BY sort').all().map((l) => [l.id, { ...l, cfg: JSON.parse(l.config) }]));
  const teams = new Map(db.prepare('SELECT * FROM sports_teams').all().map((t) => [t.id, t]));
  const linkByEvent = new Map(db.prepare('SELECT * FROM sports_event_links').all().map((r) => [r.event_ticker, r.milestone_id]));
  const eventByMs = new Map([...linkByEvent].map(([e, m]) => [m, e]));
  const outcomesCache = new Map();
  // Spread / total events (Phase 5B): line event ↔ milestone, and the line markets per milestone.
  const lineEventByMs = new Map(db.prepare('SELECT * FROM sports_line_events').all().map((r) => [r.milestone_id, r.event_ticker]));
  const msByLineEvent = new Map([...lineEventByMs].map(([m, e]) => [e, m]));
  const linesCache = new Map();
  const linesOf = (id) => {
    if (!linesCache.has(id)) linesCache.set(id, db.prepare('SELECT * FROM sports_lines WHERE milestone_id=? ORDER BY rowid').all(id));
    return linesCache.get(id);
  };
  const marketsOf = (id) => {
    if (!outcomesCache.has(id)) outcomesCache.set(id, db.prepare('SELECT * FROM sports_markets WHERE milestone_id=? ORDER BY rowid').all(id));
    return outcomesCache.get(id);
  };

  // Series per league under the existing Sports category; tags drive the Sports subcategory chips.
  for (const lg of leagues.values()) {
    if (db.prepare('SELECT 1 FROM series WHERE ticker=?').get(lg.series_ticker)) continue;
    db.prepare('INSERT INTO series(ticker,title,slug,category,tags,frequency,fee_type,fee_multiplier,settlement_sources,rules) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(lg.series_ticker, lg.name, slugify(lg.name), 'Sports', JSON.stringify([SPORT[lg.sport].label, lg.name]), 'daily', 'quadratic', 1,
        JSON.stringify([{ name: 'Parlance Sports Desk', url: 'https://example.org/sports-desk' }]),
        CS.t('rules.sports_contract_pays', { league: lg.name, value: C.contractValue(), zero: C.moneyCents(0) }));
  }

  // ---------- game state ----------
  function newState(lg, home, away, seed) {
    const edge = clamp(home.rating - away.rating + (lg.cfg.homeAdv || 0), -1, 1);
    const st = { r: seed >>> 0, t: 0, segStart: 0, segDur: 0, done: false, winner: '', edge, score: { home: 0, away: 0 }, stats: { home: {}, away: {} }, lines: { home: [], away: [] },
      names: { home: home.short_name, away: away.short_name }, abbr: { home: home.abbr, away: away.abbr } };
    SPORT[lg.sport].init(st, lg.cfg);
    return st;
  }
  const probOf = (st, sp) => { const p = sp.prob(st); return { home: clamp(p.home, 0, 1), away: clamp(p.away, 0, 1), draw: clamp(p.draw || 0, 0, 1) }; };
  // Resolve the segment that just ended; plays are stamped with the game time, clock and score after it.
  function stepOnce(st, sp, out) {
    st.t = Math.max(st.t, st.segStart + st.segDur);
    const plays = sp.resolve(st);
    st.segStart += st.segDur;
    if (!st.done) st.segDur = sp.next(st);
    if (!plays.length) return;
    const v = sp.view(st, 0); const wp = probOf(st, sp);
    for (const p of plays) out.push({ team: p.team || '', kind: p.kind, text: p.text, t: st.segStart, period: v.period, clock: v.clock, home: st.score.home, away: st.score.away, wp: wp.home, wpa: wp.away, wpd: wp.draw });
  }
  function begin(st, sp, out) {
    st.t = 0; st.segStart = 0; st.segDur = sp.next(st);
    const v = sp.view(st, 0); const wp = probOf(st, sp);
    out.push({ team: '', kind: 'start', text: sp.start(st), t: 0, period: v.period, clock: v.clock, home: 0, away: 0, wp: wp.home, wpa: wp.away, wpd: wp.draw });
  }

  // ---------- rows → API objects ----------
  const teamVo = (t) => ({ id: t.id, name: t.name, short_name: t.short_name, abbr: t.abbr, color: t.color });
  const getRow = (id) => db.prepare('SELECT * FROM sports_milestones WHERE id=?').get(id);
  function viewOf(row, st) {
    const sp = SPORT[row.sport];
    if (row.status === 'scheduled') return { period: 0, clock: '', label: '' };
    return sp.view(st, row.status === 'live' ? Math.max(0, st.t - st.segStart) : 0);
  }
  function liveVo(row, st = JSON.parse(row.state_json)) {
    const sp = SPORT[row.sport]; const lg = leagues.get(row.league_id);
    const v = viewOf(row, st); const part = row.status === 'live' ? Math.max(0, st.t - st.segStart) : 0;
    const status = row.status === 'final' ? 'complete' : row.status;
    const details = {
      home_score: st.score.home, away_score: st.score.away, home_periods: lineObj(st.lines.home), away_periods: lineObj(st.lines.away),
      ...sp.details(st, part),
      status, widget_status: { scheduled: 'pre', live: 'live', final: 'finished' }[row.status], winner: row.winner || '',
      home_win_probability: r4(row.win_home), away_win_probability: r4(row.win_away), ...(sp.draw ? { draw_probability: r4(row.win_draw) } : {}),
      last_play: row.last_play, period: v.period, clock: v.clock, period_label: v.label, side_orientation: 'milestone',
      // Running clock (Phase 5B, PLAN G9): value at updated_ts; clients advance it at `rate` game seconds per second.
      game_clock: { ...gameClock(row.sport, st, row.status === 'live', part), rate: speed, as_of: iso(row.updated_ts) },
    };
    const outcomes = Object.fromEntries(marketsOf(row.id).map((m) => [m.market_ticker, m.outcome]));
    return {
      milestone_id: row.id, type: row.type, sport: row.sport, sport_label: sp.label,
      league: { id: lg.id, name: lg.name, short_name: lg.short_name }, competition: row.competition, title: row.title,
      start_date: iso(row.start_ts), status: row.status, live_label: row.status === 'live' ? v.label : row.status === 'final' ? 'Final' : '',
      event_ticker: eventByMs.get(row.id) || null, home: teamVo(teams.get(row.home_id)), away: teamVo(teams.get(row.away_id)),
      outcomes, lines: st.lines, stats: st.stats, updated_ts: row.updated_ts, details, lines_event_ticker: lineEventByMs.get(row.id) || null,
    };
  }
  function milestoneVo(row) {
    const lg = leagues.get(row.league_id); const et = eventByMs.get(row.id);
    return {
      id: row.id, category: 'Sports', type: row.type, sport: row.sport, competition: row.competition, title: row.title,
      start_date: iso(row.start_ts), end_date: iso(row.ended_ts), status: row.status, league_id: lg.id, league: lg.name,
      related_event_tickers: et ? [et] : [], notification_message: 'The game is about to begin.',
      details: { league: lg.name, sport: row.sport, home_team_id: row.home_id, away_team_id: row.away_id, main_game_event_ticker: et || null },
      home: teamVo(teams.get(row.home_id)), away: teamVo(teams.get(row.away_id)), winner: row.winner || '', last_updated_ts: row.updated_ts,
    };
  }
  const playVo = (p) => ({ seq: p.seq, ts: iso(p.ts), game_time: Math.round(p.game_t), period: p.period, clock: p.clock, team: p.team, kind: p.kind, text: p.text, home_score: p.home_score, away_score: p.away_score, home_win_probability: r4(p.win_home) });

  // ---------- markets ----------
  const STAMP = (ms) => { const d = new Date(ms); return `${String(d.getUTCFullYear()).slice(2)}${['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][d.getUTCMonth()]}${String(d.getUTCDate()).padStart(2, '0')}`; };
  function createMarkets(row, lg, home, away, wpTimeline, startTs, now) {
    const sp = SPORT[lg.sport];
    let et = `${lg.series_ticker}-${STAMP(startTs)}${away.abbr}${home.abbr}`;
    for (let i = 2; db.prepare('SELECT 1 FROM events WHERE ticker=?').get(et); i++) et = `${lg.series_ticker}-${STAMP(startTs)}${away.abbr}${home.abbr}${i}`;
    const title = `${home.name} vs ${away.name}`;
    const ts = nowIso();
    db.prepare('INSERT INTO events(ticker,series_ticker,title,sub_title,category,mutually_exclusive,is_live,live_label,news,featured,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(et, lg.series_ticker, title, `${row.competition} · Winner`, 'Sports', 1, 0, '', '', 0, ts);
    const outs = [['home', home], ...(sp.draw ? [['draw', null]] : []), ['away', away]];
    const open = Math.min(now, startTs) - 3 * 3600 * 1000;
    const close = startTs + (MAX_SIM_SEC * 1000) / speed;
    for (const [side, t] of outs) {
      const mt = `${et}-${side === 'draw' ? 'TIE' : t.abbr}`;
      const yes = side === 'draw' ? 'Draw' : t.name;
      const rule = side === 'draw' ? `If the ${title} match ends level at full-time, as recorded by the Parlance Sports Desk, this market resolves YES. Otherwise it resolves NO.`
        : `If ${t.name} win the ${lg.name} game ${title} (including any overtime or tiebreak), as recorded by the Parlance Sports Desk, this market resolves YES. Otherwise it resolves NO.`;
      db.prepare('INSERT INTO markets(ticker,event_ticker,title,yes_sub_title,no_sub_title,color,status,open_time,close_time,expected_expiration_time,settlement_timer_seconds,rules_primary,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(mt, et, `${title} — ${yes}`, yes, side === 'draw' ? 'Not a draw' : `Not ${t.name}`, side === 'draw' ? '#868e96' : t.color, 'active', iso(open), iso(close), iso(close + 3600 * 1000), settleSec, rule, ts, ts);
      db.prepare('INSERT INTO sports_markets(market_ticker,milestone_id,outcome) VALUES(?,?,?)').run(mt, row.id, side);
      // Price history: a few pre-game prints, then the live probability path (sampled) for games already under way.
      const pts = wpTimeline.filter((_, i) => i % Math.max(1, Math.ceil(wpTimeline.length / 60)) === 0 || i === wpTimeline.length - 1);
      for (const p of pts) {
        const price = clamp(Math.round(100 * p[side]), 1, 99);
        db.prepare('INSERT INTO trades(id,market_ticker,yes_price_cents,count,taker_side,created_ts) VALUES(?,?,?,?,?,?)').run(newId('t_'), mt, price, (5 + (hash(mt + p.ts) % 60)) * UNITS, hash(p.ts + mt) % 2 ? 'yes' : 'no', Math.min(now - 1, Math.round(p.ts)));
      }
    }
    db.prepare('INSERT INTO sports_event_links(event_ticker,milestone_id) VALUES(?,?)').run(et, row.id);
    linkByEvent.set(et, row.id); eventByMs.set(row.id, et); outcomesCache.delete(row.id);
    return et;
  }

  // Re-quote the liquidity account around the live fair price: cancel, print one reference trade at the fair
  // price (system flow account vs liquidity account), then rest a bid one cent below and an offer one cent above.
  function requote(mk, p, now, force = false, table = 'sports_markets') {
    const f = clamp(Math.round(p * 100), 2, 98);
    if (!force && mk.quoted_cents === f) return;
    if (!force && mk.quoted_ts && now - mk.quoted_ts < requoteMs) return;
    const lp = LP();
    const m = db.prepare('SELECT status FROM markets WHERE ticker=?').get(mk.market_ticker);
    if (!lp || !m || m.status !== 'active' || !engine.tradingActive) return;
    const t = mk.market_ticker;
    const cancelOwn = (uid) => { for (const o of db.prepare("SELECT id FROM orders WHERE market_ticker=? AND status='resting' AND user_id=?").all(t, uid)) engine.cancelOrder(uid, o.id, 'requote'); };
    const attempt = (fn) => { try { fn(); } catch (e) { if (process.env.SPORTS_DEBUG) console.error('requote', t, e.message); } };
    attempt(() => { cancelOwn(lp); cancelOwn(FLOW); });
    if (mk.quoted_cents !== f) {
      attempt(() => engine.placeOrder(FLOW, { ticker: t, side: 'no', price: 100 - f, count: PRINT, source: 'liquidity' }));
      attempt(() => engine.placeOrder(lp, { ticker: t, side: 'yes', price: f, count: PRINT, time_in_force: 'ioc', source: 'liquidity' }));
      attempt(() => cancelOwn(FLOW));
    }
    attempt(() => engine.placeOrder(lp, { ticker: t, side: 'yes', price: f - 1, count: DEPTH, source: 'liquidity' }));
    attempt(() => engine.placeOrder(lp, { ticker: t, side: 'no', price: 99 - f, count: DEPTH, source: 'liquidity' }));
    mk.quoted_cents = f; mk.quoted_ts = now;
    db.prepare(`UPDATE ${table === 'sports_lines' ? 'sports_lines' : 'sports_markets'} SET quoted_cents=?, quoted_ts=? WHERE market_ticker=?`).run(f, now, t);
  }
  function requoteAll(id, wp, now, force = false) {
    for (const mk of marketsOf(id)) requote(mk, wp[mk.outcome] ?? 0, now, force);
  }
  // Final whistle: every winner market closes and is determined; the engine tick finalizes and pays out. Spread and
  // total markets resolve from the final score (Lines.covers on the final measures).
  function settle(id, winner, st) {
    for (const mk of marketsOf(id)) {
      try { engine.determine(mk.market_ticker, mk.outcome === winner ? 'yes' : 'no'); } catch (e) { if (process.env.SPORTS_DEBUG) console.error('settle', mk.market_ticker, e.message); }
    }
    if (!st) return;
    const row = getRow(id); const fin = Lines.measure(row.sport, st);
    for (const l of linesOf(id)) {
      try { engine.determine(l.market_ticker, Lines.covers(l, fin) ? 'yes' : 'no'); } catch (e) { if (process.env.SPORTS_DEBUG) console.error('settle line', l.market_ticker, e.message); }
    }
  }

  // ---------- spreads and totals (Phase 5B) ----------
  const linePrices = (row, st, fresh = false) => {
    const lines = linesOf(row.id);
    if (!lines.length) return [];
    const samples = Lines.simulate(SPORT[row.sport], row.sport, st, { n: LINE_SIMS, seed: hash(`${row.id}:${Math.floor(st.t || 0)}:${st.segStart || 0}`), fresh });
    return Lines.probs(lines, samples);
  };
  function createLines(row, lg, home, away, gameEt, pre, preState, now) {
    const sp = SPORT[lg.sport];
    const samples = Lines.simulate(sp, lg.sport, preState, { n: LINE_SIMS, seed: hash(`${row.id}:pre`), fresh: true });
    const fav = pre.home >= pre.away ? 'home' : 'away';
    const lines = Lines.pickLines(lg.sport, samples, fav);
    const fair = Lines.probs(lines, samples);
    const et = `${gameEt}-LINES`;
    const title = `${home.name} vs ${away.name}: Spread & Total`;
    const ts = nowIso();
    db.prepare('INSERT INTO events(ticker,series_ticker,title,sub_title,category,mutually_exclusive,is_live,live_label,news,featured,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(et, lg.series_ticker, title, `${row.competition} · Spread and total`, 'Sports', 0, 0, '', '', 0, ts);
    const open = Math.min(now, row.start_ts) - 3 * 3600 * 1000;
    const close = row.start_ts + (MAX_SIM_SEC * 1000) / speed;
    const teamsBySide = { home, away }; const abbr = { home: home.abbr, away: away.abbr };
    lines.forEach((l, i) => {
      const mt = `${et}-${Lines.suffix(l, abbr)}`;
      const d = Lines.describe(lg.sport, l, teamsBySide, `${home.name} vs ${away.name}`);
      const color = l.kind === 'spread' ? teamsBySide[l.side].color : '#5c7cfa';
      db.prepare('INSERT INTO markets(ticker,event_ticker,title,yes_sub_title,no_sub_title,color,status,open_time,close_time,expected_expiration_time,settlement_timer_seconds,rules_primary,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(mt, et, `${home.name} vs ${away.name} — ${d.yes}`, d.yes, d.no, color, 'active', iso(open), iso(close), iso(close + 3600 * 1000), settleSec, d.rule, ts, ts);
      db.prepare('INSERT INTO sports_lines(market_ticker,milestone_id,event_ticker,kind,side,line,fair,priced_ts) VALUES(?,?,?,?,?,?,?,?)').run(mt, row.id, et, l.kind, l.side, l.line, fair[i], now);
      // Pre-game price history: three prints at the pre-game fair value.
      const price = clamp(Math.round(100 * fair[i]), 1, 99);
      for (const k of [3, 2, 1]) db.prepare('INSERT INTO trades(id,market_ticker,yes_price_cents,count,taker_side,created_ts) VALUES(?,?,?,?,?,?)').run(newId('t_'), mt, price, (5 + (hash(mt + k) % 40)) * UNITS, k % 2 ? 'yes' : 'no', Math.min(now - 1, row.start_ts) - k * 40 * 60 * 1000);
    });
    db.prepare('INSERT INTO sports_line_events(event_ticker,milestone_id,game_event_ticker) VALUES(?,?,?)').run(et, row.id, gameEt);
    lineEventByMs.set(row.id, et); msByLineEvent.set(et, row.id); linesCache.delete(row.id);
    return et;
  }
  // Re-price a live game's lines (throttled per game) and re-quote the liquidity account around them.
  function requoteLines(row, st, now, force = false) {
    const lines = linesOf(row.id);
    if (!lines.length) return;
    if (!force && lines[0].priced_ts && now - lines[0].priced_ts < LINES_MS) return;
    if (!force && linesBudget <= 0) return; // at most two games re-priced per tick, so the simulation never stalls a tick
    if (!force) linesBudget -= 1;
    const fresh = row.status === 'scheduled';
    const ps = linePrices(row, st, fresh);
    lines.forEach((l, i) => { l.fair = ps[i]; l.priced_ts = now; });
    db.prepare('UPDATE sports_lines SET priced_ts=? WHERE milestone_id=?').run(now, row.id);
    for (const [i, l] of lines.entries()) {
      db.prepare('UPDATE sports_lines SET fair=? WHERE market_ticker=?').run(ps[i], l.market_ticker);
      requote(l, ps[i], now, force, 'sports_lines');
    }
  }

  // ---------- persistence of one game after a tick ----------
  const insPlay = db.prepare('INSERT INTO sports_plays(milestone_id,seq,ts,game_t,period,clock,team,kind,text,home_score,away_score,win_home) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  const upStat = db.prepare('INSERT INTO sports_stats(milestone_id,side,stat,value) VALUES(?,?,?,?) ON CONFLICT(milestone_id,side,stat) DO UPDATE SET value=excluded.value');
  const labels = new Map();
  function writeStats(id, st) {
    for (const s of SIDES) for (const [k, v] of Object.entries(st.stats[s])) if (typeof v === 'number') upStat.run(id, s, k, v);
  }
  function persist(row, st, plays, now, { emit = true } = {}) {
    const sp = SPORT[row.sport];
    const status = st.done ? 'final' : row.status;
    const wp = probOf(st, sp);
    const next = { ...row, status, state_json: JSON.stringify(st), home_score: st.score.home, away_score: st.score.away, win_home: wp.home, win_away: wp.away, win_draw: wp.draw, winner: st.done ? st.winner : '', updated_ts: now };
    const v = viewOf(next, st);
    next.live_label = status === 'live' ? v.label : status === 'final' ? 'Final' : '';
    if (plays.length) next.last_play = plays[plays.length - 1].text;
    if (status === 'final' && !row.ended_ts) next.ended_ts = now;
    const stored = [];
    tx(db, () => {
      let seq = row.play_seq;
      for (const p of plays) {
        seq += 1;
        const ts = Math.round(now - ((st.t - p.t) * 1000) / speed);
        insPlay.run(row.id, seq, Math.min(ts, now), p.t, p.period, p.clock, p.team, p.kind, p.text, p.home, p.away, p.wp);
        stored.push({ seq, ts: Math.min(ts, now), game_t: p.t, period: p.period, clock: p.clock, team: p.team, kind: p.kind, text: p.text, home_score: p.home, away_score: p.away, win_home: p.wp });
      }
      next.play_seq = seq;
      db.prepare('UPDATE sports_milestones SET status=?, state_json=?, home_score=?, away_score=?, win_home=?, win_away=?, win_draw=?, winner=?, live_label=?, last_play=?, play_seq=?, started_ts=?, ended_ts=?, updated_ts=? WHERE id=?')
        .run(next.status, next.state_json, next.home_score, next.away_score, next.win_home, next.win_away, next.win_draw, next.winner, next.live_label, next.last_play, next.play_seq, next.started_ts ?? null, next.ended_ts ?? null, now, row.id);
      if (plays.length || status !== row.status) writeStats(row.id, st);
      const et = eventByMs.get(row.id);
      const evLabel = status === 'live' ? next.live_label : status === 'final' ? `Final · ${st.score.home}-${st.score.away}` : '';
      if (et && labels.get(et) !== `${status}|${evLabel}`) {
        labels.set(et, `${status}|${evLabel}`);
        db.prepare('UPDATE events SET is_live=?, live_label=? WHERE ticker=?').run(status === 'live' ? 1 : 0, evLabel, et);
      }
    });
    if (emit) engine.emit('live_data', row.id, { ...liveVo(next, st), plays: stored.reverse().slice(0, 30).map(playVo) });
    if (status === 'final' && row.status !== 'final') settle(row.id, st.winner, st);
    else if (status !== 'final') { requoteAll(row.id, wp, now); requoteLines(next, st, now, !emit); }
    return next;
  }

  // ---------- fixtures ----------
  function createFixture(lg, home, away, { seed, mode, startTs, arg }, now) {
    const sp = SPORT[lg.sport];
    let st; let plays = []; let s = seed;
    if (mode === 'upcoming') st = newState(lg, home, away, s);
    else {
      // Live/final seeds: fast-forward the deterministic simulation; try successive seeds until the state fits.
      for (let tries = 0; tries < 300; tries++, s++) {
        st = newState(lg, home, away, s); plays = [];
        begin(st, sp, plays);
        if (mode === 'final') { while (!st.done) stepOnce(st, sp, plays); break; }
        while (!st.done && !LIVE_AT[lg.sport](st, arg)) stepOnce(st, sp, plays);
        if (!st.done && (!LIVE_OK[lg.sport] || LIVE_OK[lg.sport](st, arg))) break;
      }
    }
    const id = newId('');
    const comp = lg.cfg.competition || lg.name;
    const start = mode === 'upcoming' ? startTs : mode === 'live' ? now - (st.t * 1000) / speed : startTs - (st.t * 1000) / speed;
    const pre = probOf(newState(lg, home, away, s), sp);
    const toTs = (t) => start + (t * 1000) / speed;
    const timeline = [3, 2, 1].map((k) => ({ ...pre, ts: Math.min(now, start) - k * 40 * 60 * 1000 }));
    for (const p of plays) timeline.push({ home: p.wp, away: p.wpa, draw: p.wpd, ts: toTs(p.t) });
    const status = mode === 'upcoming' ? 'scheduled' : mode;
    const row = { id, type: sp.type, sport: lg.sport, league_id: lg.id, title: `${home.name} vs ${away.name}`, competition: comp, home_id: home.id, away_id: away.id,
      start_ts: Math.round(start), status: status === 'final' ? 'live' : status, seed: s, state_json: '{}', home_score: 0, away_score: 0, win_home: pre.home, win_away: pre.away, win_draw: pre.draw,
      winner: '', live_label: '', last_play: '', play_seq: 0, started_ts: mode === 'upcoming' ? null : Math.round(start), ended_ts: mode === 'final' ? startTs : null, updated_ts: now, created_at: nowIso() };
    tx(db, () => {
      db.prepare('INSERT INTO sports_milestones(id,type,sport,league_id,title,competition,home_id,away_id,start_ts,status,seed,state_json,home_score,away_score,win_home,win_away,win_draw,winner,live_label,last_play,play_seq,started_ts,ended_ts,updated_ts,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(row.id, row.type, row.sport, row.league_id, row.title, row.competition, row.home_id, row.away_id, row.start_ts, row.status, row.seed, JSON.stringify(st), 0, 0, row.win_home, row.win_away, row.win_draw, '', '', '', 0, row.started_ts, row.ended_ts, now, row.created_at);
      const gameEt = createMarkets(row, lg, home, away, timeline, row.start_ts, now);
      createLines(row, lg, home, away, gameEt, pre, newState(lg, home, away, s), now);
    });
    if (mode === 'upcoming') { writeStats(id, st); requoteAll(id, pre, now, true); requoteLines(row, st, now, true); return id; }
    // Persist the fast-forwarded history (backdated play timestamps) — a final game also settles here.
    const endNow = mode === 'final' ? startTs : now;
    persist(row, st, plays, endNow, { emit: false }); // live: also places the first quotes; final: determines the markets
    return id;
  }

  function seedFixtures(now) {
    FIXTURES.forEach(([lid, hi, ai, mode, arg], i) => {
      const lg = leagues.get(lid); const tl = [...teams.values()].filter((t) => t.league_id === lid);
      const startTs = mode === 'upcoming' ? now + (arg * 60000) / speed : mode === 'final' ? now - (arg * 60000) / speed : now;
      createFixture(lg, tl[hi], tl[ai], { seed: hash(`${lid}:${i}`), mode, startTs, arg }, now);
    });
    db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(SEED_KEY, nowIso());
  }
  // Keep every league stocked with at least one upcoming game (rematches between idle teams).
  function ensureFixtures(now) {
    for (const lg of leagues.values()) {
      if (db.prepare("SELECT 1 FROM sports_milestones WHERE league_id=? AND status='scheduled' LIMIT 1").get(lg.id)) continue;
      const busy = new Set(db.prepare("SELECT home_id, away_id FROM sports_milestones WHERE league_id=? AND status='live'").all(lg.id).flatMap((r) => [r.home_id, r.away_id]));
      const n = db.prepare('SELECT COUNT(*) c FROM sports_milestones WHERE league_id=?').get(lg.id).c;
      const pool = [...teams.values()].filter((t) => t.league_id === lg.id);
      const idle = pool.filter((t) => !busy.has(t.id));
      const list = idle.length >= 2 ? idle : pool;
      const L = list.length; const h = list[n % L];
      let a = list[(n + 1 + Math.floor(n / L)) % L]; if (a === h) a = list[(n + 1) % L];
      const seed = hash(`${lg.id}:auto:${n}`);
      const mins = 20 + (seed % 70);
      createFixture(lg, h, a, { seed, mode: 'upcoming', startTs: now + (mins * 60000) / speed }, now);
    }
  }

  // ---------- the clock: driven by the engine tick ----------
  let lastWall = null; let lastFixtures = 0; let linesBudget = 2;
  function startGame(row, now) {
    const sp = SPORT[row.sport]; const st = JSON.parse(row.state_json); const plays = [];
    begin(st, sp, plays);
    return persist({ ...row, status: 'live', started_ts: now }, st, plays, now);
  }
  function advance(row, now, dtMs) {
    const sp = SPORT[row.sport]; const st = JSON.parse(row.state_json); const plays = [];
    st.t += (dtMs * speed) / 1000;
    while (!st.done && st.segStart + st.segDur <= st.t) stepOnce(st, sp, plays);
    persist(row, st, plays, now);
  }
  function tick() {
    const now = Date.now();
    linesBudget = 2;
    // First tick after boot: dt = 0, so a restarted server resumes every clock exactly where the DB left it.
    const dt = lastWall == null ? 0 : clamp(now - lastWall, 0, MAX_CATCHUP_MS);
    lastWall = now;
    for (const row of db.prepare("SELECT * FROM sports_milestones WHERE status='scheduled' AND start_ts<=? ORDER BY start_ts").all(now)) startGame(row, now);
    for (const row of db.prepare("SELECT * FROM sports_milestones WHERE status='live' AND (started_ts IS NULL OR started_ts<?)").all(now)) advance(row, now, dt);
    if (now - lastFixtures > 3000) { lastFixtures = now; ensureFixtures(now); }
  }

  if (!db.prepare('SELECT 1 FROM sports_milestones LIMIT 1').get()) seedFixtures(Date.now());
  engine.on('tick', () => { try { tick(); } catch (e) { console.error('sports', e); } });

  // ======================= API (shapes follow the observed /v1/live_data/* and /milestones calls) =======================
  const leagueOf = (q) => (q ? String(q).toUpperCase() : '');
  const sportOf = (q) => (q ? String(q).toLowerCase() : '');
  const filterRows = (rows, q) => {
    const lg = leagueOf(q.league); const sp = sportOf(q.sport);
    if (lg && !leagues.has(lg)) throw E.badRequest('unknown league');
    if (sp && !SPORT[sp]) throw E.badRequest('unknown sport');
    return rows.filter((r) => (!lg || r.league_id === lg) && (!sp || r.sport === sp));
  };
  const counts = () => {
    const c = {};
    for (const r of db.prepare('SELECT league_id, status, COUNT(*) n FROM sports_milestones GROUP BY league_id, status').all()) {
      const x = (c[r.league_id] ||= { scheduled: 0, live: 0, final: 0 }); x[r.status] = r.n;
    }
    return c;
  };
  const leagueVo = (lg, c) => { const x = c[lg.id] || { scheduled: 0, live: 0, final: 0 }; return { id: lg.id, name: lg.name, short_name: lg.short_name, sport: lg.sport, sport_label: SPORT[lg.sport].label, series_ticker: lg.series_ticker, featured: !!lg.featured, count: x.scheduled + x.live, live_count: x.live, upcoming_count: x.scheduled, results_count: x.final }; };

  v1.get('/sports/leagues', (req, res) => {
    const c = counts(); const all = [...leagues.values()].map((lg) => leagueVo(lg, c));
    const sports = Object.keys(SPORT).map((s) => { const ls = all.filter((l) => l.sport === s); return { sport: s, label: SPORT[s].label, type: SPORT[s].type, count: ls.reduce((a, l) => a + l.count, 0), live_count: ls.reduce((a, l) => a + l.live_count, 0), leagues: ls }; }).filter((s) => s.leagues.length);
    res.json({ featured: all.filter((l) => l.featured), sports, leagues: all, totals: { count: all.reduce((a, l) => a + l.count, 0), live_count: all.reduce((a, l) => a + l.live_count, 0) } });
  });

  v1.get('/live_data/feed', (req, res) => {
    const rows = filterRows(db.prepare('SELECT * FROM sports_milestones ORDER BY start_ts').all(), req.query);
    const limit = clamp(Number(req.query.limit) || 24, 1, 100);
    const item = (r) => { const et = eventByMs.get(r.id); const e = et && getEvent(et); return { milestone: milestoneVo(r), live_data: liveVo(r), event: e ? eventFull(e) : null }; };
    res.json({
      live: rows.filter((r) => r.status === 'live').slice(0, limit).map(item),
      upcoming: rows.filter((r) => r.status === 'scheduled').slice(0, limit).map(item),
      results: rows.filter((r) => r.status === 'final').sort((a, b) => (b.ended_ts || 0) - (a.ended_ts || 0)).slice(0, Math.min(limit, 12)).map(item),
    });
  });
  v1.get('/live_data/batch', (req, res) => {
    const ids = String(req.query.milestone_ids || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!ids.length) throw E.badRequest('milestone_ids is required');
    if (ids.length > 100) throw E.badRequest('at most 100 milestone_ids');
    res.json({ live_datas: ids.map(getRow).filter(Boolean).map((r) => liveVo(r)) });
  });
  v1.get('/live_data/milestone/:id/game_stats', (req, res) => {
    const r = getRow(req.params.id); if (!r) throw E.notFound();
    const stats = { home: {}, away: {} };
    for (const s of db.prepare('SELECT side, stat, value FROM sports_stats WHERE milestone_id=?').all(r.id)) stats[s.side][s.stat] = s.value;
    const st = JSON.parse(r.state_json);
    res.json({ milestone_id: r.id, type: r.type, stats, periods: st.lines, plays_count: r.play_seq });
  });
  v1.get('/live_data/:type/milestone/:id', (req, res) => {
    const r = getRow(req.params.id);
    if (!r || r.type !== req.params.type) throw E.notFound();
    res.json({ live_data: liveVo(r) });
  });

  v1.get('/milestones', (req, res) => {
    const q = req.query;
    if (q.category && String(q.category).toLowerCase() !== 'sports') return res.json({ milestones: [], cursor: '' });
    let rows = filterRows(db.prepare('SELECT * FROM sports_milestones ORDER BY start_ts, id').all(), q);
    if (q.type) rows = rows.filter((r) => r.type === q.type);
    if (q.status) { const want = String(q.status).split(','); rows = rows.filter((r) => want.includes(r.status)); }
    if (q.related_event_ticker) { const id = linkByEvent.get(String(q.related_event_ticker).toUpperCase()); rows = rows.filter((r) => r.id === id); }
    if (q.min_start_date) { const t = Date.parse(q.min_start_date); if (Number.isNaN(t)) throw E.badRequest('invalid min_start_date'); rows = rows.filter((r) => r.start_ts >= t); }
    if (q.max_start_date) { const t = Date.parse(q.max_start_date); if (Number.isNaN(t)) throw E.badRequest('invalid max_start_date'); rows = rows.filter((r) => r.start_ts <= t); }
    const limit = clamp(Number(q.limit) || 50, 1, 200);
    let off = 0;
    if (q.cursor) { try { off = JSON.parse(Buffer.from(String(q.cursor), 'base64url').toString()).o || 0; } catch { throw E.badRequest('invalid cursor'); } }
    const page = rows.slice(off, off + limit);
    res.json({ milestones: page.map(milestoneVo), cursor: off + limit < rows.length ? Buffer.from(JSON.stringify({ o: off + limit })).toString('base64url') : '' });
  });
  v1.get('/milestones/:id', (req, res) => { const r = getRow(req.params.id); if (!r) throw E.notFound(); res.json({ milestone: milestoneVo(r) }); });
  v1.get('/milestones/:id/plays', (req, res) => {
    const r = getRow(req.params.id); if (!r) throw E.notFound();
    const limit = clamp(Number(req.query.limit) || 60, 1, 500);
    const before = req.query.before_seq ? Number(req.query.before_seq) : Number.MAX_SAFE_INTEGER;
    res.json({ plays: db.prepare('SELECT * FROM sports_plays WHERE milestone_id=? AND seq<? ORDER BY seq DESC LIMIT ?').all(r.id, before, limit).map(playVo) });
  });
  // Event page: the game behind a sports event (404 for other events).
  // Also answers for a game's spread / total event (Phase 5B), with the lines and their current fair values.
  v1.get('/sports/events/:ticker', (req, res) => {
    const t = String(req.params.ticker).toUpperCase();
    const id = linkByEvent.get(t) || msByLineEvent.get(t); const r = id && getRow(id);
    if (!r) throw E.notFound();
    const le = lineEventByMs.get(r.id);
    res.json({ milestone: milestoneVo(r), live_data: liveVo(r), plays: db.prepare('SELECT * FROM sports_plays WHERE milestone_id=? ORDER BY seq DESC LIMIT 80').all(r.id).map(playVo),
      lines: le ? { event_ticker: le, game_event_ticker: eventByMs.get(r.id) || null, markets: linesOf(r.id).map(lineVo) } : null });
  });

  // eventFull() hook: attach the live scoreboard to any event linked to a game.
  function decorate(vo) {
    const id = linkByEvent.get(vo.event_ticker);
    if (!id) {
      // A spread / total event points at its game (no live_data, so cards stay plain market cards).
      const lm = msByLineEvent.get(vo.event_ticker);
      if (lm) { const r = getRow(lm); if (r) vo.sports_lines = { milestone_id: lm, game_event_ticker: eventByMs.get(lm) || null, status: r.status, title: r.title }; }
      return vo;
    }
    const r = getRow(id);
    if (r) { vo.milestone_id = id; vo.live_data = liveVo(r); vo.lines_event_ticker = lineEventByMs.get(id) || null; }
    return vo;
  }
  const lineVo = (l) => ({ market_ticker: l.market_ticker, kind: l.kind, side: l.side, line: l.line, fair_probability: l.fair == null ? null : r4(l.fair) });
  return { decorate, tick, speed };
}

module.exports = { mountSports, SPORT, LEAGUES };
