'use strict';
// Price grids, fixed-point prices and the sub-cent taker-fee accumulator (Phase 5A; CLONE_SPEC.md §28).
//
// Prices of event contracts are integer **centi-cents** ("cc"): 1 cc = $0.0001, so $1.00 = 10,000 cc and a price is
// 1..9,999 cc. That is the resolution of the 4-decimal dollar strings on the wire (spec §5.1) and of the finest
// documented band (`center_deci_edge_centi_cent`, spec §17.5). A YES bid at p is a NO ask at 10,000 − p.
//
// Price level structures (the market's `price_level_structure` and `price_ranges`, spec §5.1 / openapi PriceRange):
//   linear_cent                 $0.01 ticks everywhere (every market before Phase 5A; observed HAR1#10)
//   deci_cent                   $0.001 ticks everywhere
//   tapered                     finer near 0 and 100: $0.0001 within 1¢ of either edge, $0.001 up to 10¢ from an edge,
//                               $0.01 in the middle (the band edges are a design choice; the live name/bands are UNKNOWN)
//   center_deci_edge_centi_cent $0.001 in the middle, $0.0001 within 1¢ of either edge (named in the RFQ docs for combos;
//                               band edges are a design choice)
// Every grid is symmetric (p is a tick ⇔ 10,000 − p is a tick) and contains every whole cent, so integer-cent callers
// (bots, simulated liquidity, older clients) stay valid on every grid.
const CC = 10000;          // cc per dollar
const CC_PER_CENT = 100;
const UNITS = 100;         // quantity units per contract (spec §16.1)
const MICRO_PER_CENT = 10000; // fee accumulator unit: $0.000001 = 1/10,000 cent (spec §5.1: "rounded up to $0.000001")

const GRIDS = {
  linear_cent: [[0, 10000, 100]],
  deci_cent: [[0, 10000, 10]],
  tapered: [[0, 100, 1], [100, 1000, 10], [1000, 9000, 100], [9000, 9900, 10], [9900, 10000, 1]],
  center_deci_edge_centi_cent: [[0, 100, 1], [100, 9900, 10], [9900, 10000, 1]],
};
const STRUCTURES = Object.keys(GRIDS);
const gridOf = (structure) => GRIDS[structure] || GRIDS.linear_cent;

function onGrid(structure, p) {
  if (!Number.isInteger(p) || p < 1 || p > CC - 1) return false;
  return gridOf(structure).some(([s, e, step]) => p >= s && p <= e && (p - s) % step === 0);
}
// Tick size at price p going up (dir 1) or down (dir -1).
function tickAt(structure, p, dir = 1) {
  const g = gridOf(structure);
  const band = dir > 0 ? g.find(([s, e]) => p >= s && p < e) : g.find(([s, e]) => p > s && p <= e);
  return band ? band[2] : g[0][2];
}
const minTick = (structure) => Math.min(...gridOf(structure).map((b) => b[2]));
const minPrice = (structure) => { for (let p = 1; p < CC; p++) if (onGrid(structure, p)) return p; return 100; };
const maxPrice = (structure) => CC - minPrice(structure);
// Largest tick ≤ p (and ≥ the minimum price).
function floorToGrid(structure, p) {
  let x = Math.max(minPrice(structure), Math.min(maxPrice(structure), Math.floor(p)));
  while (x > minPrice(structure) && !onGrid(structure, x)) x -= 1;
  return x;
}
const ccToDollars = (cc) => (cc == null ? null : (cc / CC).toFixed(4));
const priceRanges = (structure) => gridOf(structure).map(([s, e, step]) => ({ start: ccToDollars(s), end: ccToDollars(e), step: ccToDollars(step) }));

// Parse a price given as dollars (number or string, at most 4 decimals) into cc; null when malformed.
function ccFromDollars(v) {
  if (v == null || v === '') return null;
  const s = typeof v === 'number' ? (Number.isFinite(v) ? v.toFixed(10).replace(/0+$/, '').replace(/\.$/, '') : '') : String(v).trim();
  if (!/^\d*(\.\d{0,4}\d*)?$/.test(s) || s === '' || s === '.') return null;
  const [w, f = ''] = s.split('.');
  if (f.length > 4 && /[1-9]/.test(f.slice(4))) return null; // more precision than the grid can hold
  return Number(w || 0) * CC + Number((f + '0000').slice(0, 4));
}
// A price given in cents (integer cents, or a cents value with up to two decimals such as 45.3) → cc; null if malformed.
function ccFromCents(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const cc = Math.round(n * CC_PER_CENT);
  return Math.abs(cc - n * CC_PER_CENT) < 1e-6 ? cc : null;
}
// Human label: "45¢", "45.3¢", "0.05¢" (trailing zeros dropped).
const centsLabel = (cc) => (cc == null ? '—' : `${(cc / CC_PER_CENT).toFixed(2).replace(/\.?0+$/, '')}¢`);

// ------------------------------------------------------------------------------------------- money for a fill
// q units at taker price p cc: the YES/NO pair costs exactly q cents; the taker pays ceil(q·p/10,000) and the maker the
// rest (spec §16.2, generalised from cents to cc). For p = 100·cents this is the old ceil(q·cents/100).
const takerPrincipal = (units, pcc) => Math.ceil((units * pcc) / CC);
const makerPrincipal = (units, makerPcc) => Math.floor((units * makerPcc) / CC);

// Exact taker fee of one fill in micro-units ($0.000001), rounded up: coefficient × C × P × (1 − P) × multiplier dollars
// with C = units/100 and P = p/10,000. BigInt keeps it exact for every size (the product exceeds 2^53).
// k = coefficient·10^4, mk = multiplier·10^4: micro = ceil(k·mk·q·p·(10^4 − p) / 10^12).
function feeMicro(units, pcc, k, mk) {
  if (!units || !k || !mk) return 0;
  const num = BigInt(k) * BigInt(mk) * BigInt(units) * BigInt(pcc) * BigInt(CC - pcc);
  const den = 1000000000000n;
  return Number((num + den - 1n) / den);
}
const multK = (multiplier) => Math.round(Number(multiplier ?? 1) * 10000);
// Upper bound, in whole cents, on the fee of one contract at any price at or below `limitCc` (P(1−P) peaks at 50¢).
function feeCapPerContract(limitCc, k, mk) {
  const p = Math.min(limitCc, CC / 2);
  if (!k || !mk) return 0;
  const num = BigInt(k) * BigInt(mk) * BigInt(p) * BigInt(CC - p);
  const den = 100000000000000n; // 10^14: fee cents per contract = k·mk·p·(10^4−p)/10^14
  return Number((num + den - 1n) / den);
}

// G1 fee accumulator (spec §5.1 DOC:fee_rounding; CLONE_SPEC.md §28.3). Each fill's exact fee (micro-units) adds to the
// order's accumulator; the order is charged whole cents so that, after every fill, the total charged is
// ceil(accumulated exact fee). The sub-cent overpayment (< 1¢ per order) is the rounding fee: it never exceeds one cent
// over the life of an order instead of up to one cent per fill. The journal stays in whole cents: house:fees receives
// floor(accumulated)/cent increments and house:fees:rounding the difference, so both always balance.
// state: {micro, cents} (the order's accumulator and cents charged so far). Returns the fill's charge.
function chargeFill(state, micro) {
  const before = state.micro;
  const after = before + micro;
  const cents = Math.ceil(after / MICRO_PER_CENT) - state.cents;
  const toFees = Math.floor(after / MICRO_PER_CENT) - Math.floor(before / MICRO_PER_CENT);
  return { cents, micro, toFees, toRounding: cents - toFees, next: { micro: after, cents: state.cents + cents } };
}

module.exports = {
  CC, CC_PER_CENT, UNITS, MICRO_PER_CENT, GRIDS, STRUCTURES, gridOf, onGrid, tickAt, minTick, minPrice, maxPrice, floorToGrid,
  ccToDollars, priceRanges, ccFromDollars, ccFromCents, centsLabel, takerPrincipal, makerPrincipal, feeMicro, multK, feeCapPerContract, chargeFill,
};
