'use strict';
// A small deterministic property-testing harness (no dependency): a seeded PRNG, generators, and a runner that tries a
// property over many seeds and, on failure, reports the seed, the failing step and the recent actions so the case can
// be replayed exactly (PROPERTY_SEED=<seed> runs one seed; PROPERTY_RUNS=<n> runs more).
//
//   const { runProperty } = require('./lib/property');
//   await runProperty('name', { runs: 8 }, async (g, log) => { … log('action', detail) … throw on a broken invariant });
//
// g: { seed, int(lo, hi), float(lo, hi), pick(list), chance(p), weighted([[w, value], …]), next() }.

// mulberry32: small, fast, good enough for test-case generation; deterministic per seed.
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let r = Math.imul(s ^ (s >>> 15), 1 | s);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function gen(seed) {
  const next = prng(seed);
  const g = {
    seed, next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    float: (lo, hi) => lo + next() * (hi - lo),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
    weighted: (pairs) => { const total = pairs.reduce((a, [w]) => a + w, 0); let x = next() * total; for (const [w, v] of pairs) { x -= w; if (x < 0) return v; } return pairs[pairs.length - 1][1]; },
  };
  return g;
}

class PropertyFailure extends Error {}

// Runs `body(g, log)` once per seed. Seeds are derived from a base seed so a run is reproducible; a failure reports
// the seed and the last actions (the replay recipe).
async function runProperty(name, { runs = 8, base = 0x5eed } = {}, body) {
  const only = process.env.PROPERTY_SEED ? [Number(process.env.PROPERTY_SEED)] : null;
  const n = Number(process.env.PROPERTY_RUNS || runs);
  const seeds = only || Array.from({ length: n }, (_, i) => (Math.imul(base + i, 2654435761) >>> 0));
  const stats = { runs: 0, steps: 0 };
  for (const seed of seeds) {
    const actions = [];
    const log = (what, detail) => { actions.push(`${actions.length}: ${what} ${detail === undefined ? '' : JSON.stringify(detail)}`); stats.steps += 1; };
    try {
      await body(gen(seed), log);
    } catch (e) {
      const tail = actions.slice(-15).join('\n  ');
      throw new PropertyFailure(`${name}: failed for seed ${seed} after ${actions.length} actions (replay with PROPERTY_SEED=${seed}).\n${e.message}\nLast actions:\n  ${tail}`);
    }
    stats.runs += 1;
  }
  return stats;
}

module.exports = { runProperty, gen, prng, PropertyFailure };
