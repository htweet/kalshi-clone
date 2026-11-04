'use strict';
// Size-tiered margin and risk limits for Perps (PLAN P6.2, CLONE_SPEC.md §34.4). Pure functions; server/perps.js keeps
// the tiers in `perp_margin_tiers` (admin-editable per market, Admin › Perps ops).
//
// A market's tiers are notional brackets [0, cap1), [cap1, cap2), … with an initial and a maintenance rate each. The
// requirement of a position of notional N is bracketed (marginal), like income-tax bands:
//   MM(N) = SUM over tiers of rate_k x (the part of N inside tier k)
// so it is continuous and rises faster than linearly with size; the blended maximum leverage at N is N / IM(N). The
// last tier's cap is the market's maximum position (risk limit). Tier 1's initial rate is 1 / max_leverage.
const CC = 10000; // centicents per dollar

// Default tiers from a market's max leverage: $50k at the full leverage, then half and a quarter of it; the
// maintenance rate is the initial rate / im_multiplier (2), as in CLONE_SPEC.md §14.3.
function defaultTiers(maxLev, imMult = 2) {
  return [[50000, 1], [250000, 2], [1000000, 4]].map(([cap, k], i) => {
    const im = Math.min(1, k / maxLev);
    return { tier: i + 1, max_notional_cc: cap * CC, initial_rate: Number(im.toFixed(6)), maintenance_rate: Number((im / imMult).toFixed(6)) };
  });
}

// Validates an admin tier list → normalised tiers, or throws a message.
function validateTiers(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > 10) throw new Error('send 1 to 10 tiers');
  const out = []; let prevCap = 0; let prevIm = 0; let prevMm = 0;
  list.forEach((t, i) => {
    const cap = Number(t.max_notional_dollars ?? (t.max_notional_cc != null ? t.max_notional_cc / CC : NaN));
    const im = Number(t.initial_rate); const mm = Number(t.maintenance_rate);
    if (!Number.isFinite(cap) || cap <= 0 || cap > 1e9) throw new Error(`tier ${i + 1}: max notional must be a positive amount`);
    if (Math.round(cap * CC) <= prevCap) throw new Error(`tier ${i + 1}: caps must increase`);
    if (!(im > 0 && im <= 1)) throw new Error(`tier ${i + 1}: initial rate must be above 0 and at most 1`);
    if (!(mm > 0 && mm < im)) throw new Error(`tier ${i + 1}: maintenance rate must be above 0 and below the initial rate`);
    if (im < prevIm || mm < prevMm) throw new Error(`tier ${i + 1}: rates must not fall as size grows`);
    prevCap = Math.round(cap * CC); prevIm = im; prevMm = mm;
    out.push({ tier: i + 1, max_notional_cc: prevCap, initial_rate: Number(im.toFixed(6)), maintenance_rate: Number(mm.toFixed(6)) });
  });
  return out;
}

// Bracketed requirement for notional N (cc) with the rate `key`.
function bracket(tiers, N, key) {
  let lo = 0; let sum = 0;
  for (const t of tiers) {
    if (N <= lo) break;
    sum += (Math.min(N, t.max_notional_cc) - lo) * t[key];
    lo = t.max_notional_cc;
  }
  if (N > lo && tiers.length) sum += (N - lo) * tiers[tiers.length - 1][key];
  return sum;
}
const mm = (tiers, N) => bracket(tiers, Math.abs(N), 'maintenance_rate');
const im = (tiers, N) => bracket(tiers, Math.abs(N), 'initial_rate');
const maxNotional = (tiers) => (tiers.length ? tiers[tiers.length - 1].max_notional_cc : Infinity);
const maxLeverageAt = (tiers, N) => (N > 0 ? N / im(tiers, N) : 1 / tiers[0].initial_rate);
function tierOf(tiers, N) { const i = tiers.findIndex((t) => Math.abs(N) <= t.max_notional_cc); return i < 0 ? tiers.length : i + 1; }

// Liquidation mark price (per contract, cc) of a position of q units: the m where
//   A + q·m/100 = B + MM(|q|·m/100)
// A = everything else in the equity (isolated: margin − q·entry/100; portfolio: the subaccount's other equity too),
// B = the maintenance margin of the other positions (0 when isolated). MM is piecewise linear in m, so each tier is
// solved in closed form and the root that falls inside its tier is the answer (equity − MM is monotone in m).
function liqPrice(tiers, q, A, B = 0) {
  if (!q) return null;
  const a = Math.abs(q) / 100;
  let lo = 0; let fixed = 0; // fixed = MM of the tiers fully below
  for (let k = 0; k < tiers.length; k++) {
    const t = tiers[k];
    const last = k === tiers.length - 1;
    const r = t.maintenance_rate;
    const d = fixed - r * lo; // MM(N) = d + r·N inside this tier
    const m = q > 0 ? (B + d - A) / (a * (1 - r)) : (B + d - A) / (-a * (1 + r));
    const N = a * m;
    if (m > 0 && N >= lo - 1e-6 && (last || N <= t.max_notional_cc + 1e-6)) return Math.round(m);
    fixed += r * (t.max_notional_cc - lo);
    lo = t.max_notional_cc;
  }
  return null;
}

// Risk limits (Admin › Perps ops › Risk limits; admin_settings key `perps_risk`).
const RISK_DEFAULTS = { max_open_orders_per_market: 50, max_open_orders_total: 200, max_subaccounts: 10, max_order_groups: 20, max_orders_per_group: 25 };
const RISK_SPEC = {
  max_open_orders_per_market: { type: 'integer', min: 1, max: 1000 }, max_open_orders_total: { type: 'integer', min: 1, max: 5000 },
  max_subaccounts: { type: 'integer', min: 1, max: 32 }, max_order_groups: { type: 'integer', min: 1, max: 200 }, max_orders_per_group: { type: 'integer', min: 2, max: 200 },
};

module.exports = { CC, defaultTiers, validateTiers, mm, im, maxNotional, maxLeverageAt, tierOf, liqPrice, RISK_DEFAULTS, RISK_SPEC };
