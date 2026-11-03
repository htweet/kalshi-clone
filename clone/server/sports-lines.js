'use strict';
// Sports derivatives (Phase 5B, PLAN P5.2): spread and total lines for simulated games. Pure helpers used by
// server/sports.js — no DB access here.
//
// Fair value is Monte Carlo over the game's own deterministic model: the persisted game state is cloned `n` times,
// each clone gets its own PRNG stream (derived from the game id and current game time, so a price is reproducible)
// and is played to the end with the same resolve()/next() code that drives the live game. The final measures (points,
// goals, games, runs or rounds per side) give P(spread covers) and P(total over). Lines are set once, before the game,
// from the pre-game distribution (median margin of the favourite, median total), always at a half point so no
// market can push. Every line, step and minimum below is a Parlance design choice (CLONE_SPEC.md §29).

const LINE = {
  //            minimum spread, alternate-total step, unit (singular, plural)
  soccer: { min: 0.5, step: 1, unit: ['goal', 'goals'] },
  hockey: { min: 1.5, step: 1, unit: ['goal', 'goals'] },
  basketball: { min: 1.5, step: 10, unit: ['point', 'points'] },
  football: { min: 1.5, step: 7, unit: ['point', 'points'] },
  tennis: { min: 1.5, step: 3, unit: ['game', 'games'] },
  cricket: { min: 4.5, step: 20, unit: ['run', 'runs'] },
  esports: { min: 2.5, step: 6, unit: ['round', 'rounds'] },
};

// What a spread or total counts, per side, from a game state.
function measure(sport, st) {
  switch (sport) {
    case 'tennis': { const g = (s) => st.sets.reduce((a, x) => a + (x[s] || 0), 0); return { home: g('home'), away: g('away') }; }
    case 'cricket': return { home: st.stats.home.runs || 0, away: st.stats.away.runs || 0 };
    case 'esports': { const r = (s) => st.maps.reduce((a, m) => a + (m[s] || 0), 0); return { home: r('home'), away: r('away') }; }
    default: return { home: st.score.home, away: st.score.away };
  }
}

// Play `n` copies of the game to the end. `fresh` = the game has not started (begin() not run yet).
function simulate(sp, sport, st0, { n = 120, seed = 1, fresh = false } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = structuredClone(st0);
    c.r = (seed + Math.imul(i + 1, 0x9E3779B1)) >>> 0;
    if (fresh) { c.segStart = 0; c.segDur = sp.next(c); sp.start(c); }
    let guard = 0;
    while (!c.done && guard++ < 50000) {
      sp.resolve(c);
      c.segStart += c.segDur;
      if (!c.done) c.segDur = sp.next(c);
    }
    out.push(measure(sport, c));
  }
  return out;
}

const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
const half = (x) => Math.floor(x) + 0.5;

// Lines for a game from pre-game samples: favourite's spread at the median margin, the underdog at the minimum, a main
// total at the median and an alternate one step higher.
function pickLines(sport, samples, fav) {
  const cfg = LINE[sport];
  const dog = fav === 'home' ? 'away' : 'home';
  const margin = median(samples.map((m) => m[fav] - m[dog]));
  const total = median(samples.map((m) => m.home + m.away));
  const favLine = Math.max(cfg.min, half(margin));
  const t = Math.max(0.5, half(total - 0.5));
  return [
    { kind: 'spread', side: fav, line: favLine },
    { kind: 'spread', side: dog, line: cfg.min },
    { kind: 'total', side: '', line: t },
    { kind: 'total', side: '', line: t + cfg.step },
  ];
}

// YES outcome of a line given final measures.
function covers(l, m) {
  if (l.kind === 'spread') { const o = l.side === 'home' ? 'away' : 'home'; return m[l.side] - m[o] > l.line; }
  return m.home + m.away > l.line;
}
// P(YES) for each line from samples (Laplace-smoothed so a sample of 0 or n never prices at exactly 0 or 1).
function probs(lines, samples) {
  return lines.map((l) => (samples.filter((m) => covers(l, m)).length + 0.5) / (samples.length + 1));
}

const fmtLine = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
// Market copy for a line.
function describe(sport, l, teams, title) {
  const [one, many] = LINE[sport].unit;
  const u = l.line === 1 ? one : many;
  if (l.kind === 'spread') {
    const t = teams[l.side];
    return { yes: `${t.name} by over ${fmtLine(l.line)}`, no: `${t.name} not by over ${fmtLine(l.line)}`,
      rule: `If ${t.name} finish the ${title} game more than ${fmtLine(l.line)} ${u} ahead (${many} as recorded in the official final score by the Parlance Sports Desk, including any overtime, tiebreak or shootout credit), this market resolves YES. Otherwise it resolves NO.` };
  }
  return { yes: `Over ${fmtLine(l.line)} ${many}`, no: `Under ${fmtLine(l.line)} ${many}`,
    rule: `If both sides together record more than ${fmtLine(l.line)} ${many} in the ${title} game (official final score from the Parlance Sports Desk, including any overtime, tiebreak or shootout credit), this market resolves YES. Otherwise it resolves NO.` };
}
// Ticker suffix: SP{ABBR}{line×10} or TOT{line×10} (e.g. -SPFPN15, -TOT55).
const suffix = (l, abbr) => (l.kind === 'spread' ? `SP${abbr[l.side]}${Math.round(l.line * 10)}` : `TOT${Math.round(l.line * 10)}`);

module.exports = { LINE, measure, simulate, pickLines, covers, probs, describe, suffix, fmtLine };
