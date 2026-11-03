'use strict';
// Invented civic geography for Parlance (Phase 5B, PLAN P5.3 ballot lookup and A15 Senate map). None of these places,
// postcodes or districts exist: "ZIP-like" codes are five-digit numbers in invented ranges (90100–98999) that map to
// invented states, districts and cities. Contests point at the platform's own election markets (event tickers); a
// contest whose event does not exist in the database is simply not shown.

// States on the Senate map grid (row, col on a 3 × 4 tile map). `seated` = seats not up this cycle (invented holdovers);
// `senate` = the event ticker of this cycle's race, if any. The chamber has two seats per state.
const STATES = [
  { code: 'NG', name: 'Northgate', row: 0, col: 0, zips: ['97000-97499'], seated: { blue: 2, red: 0 } },
  { code: 'HS', name: 'Harbor State', row: 0, col: 1, zips: ['90100-90599'], seated: { blue: 1, red: 0 }, senate: 'PLXSTATE-26SEN', governor: 'PLXSTATE-26GOV' },
  { code: 'RB', name: 'Ridgeback', row: 0, col: 2, zips: ['92000-92499'], seated: { blue: 0, red: 1 }, senate: 'PLXSENATE-26RB' },
  { code: 'KF', name: 'Kingsferry', row: 0, col: 3, zips: ['97500-97999'], seated: { blue: 0, red: 2 } },
  { code: 'SM', name: 'Saltmarsh', row: 1, col: 0, zips: ['93000-93499'], seated: { blue: 1, red: 0 }, senate: 'PLXSENATE-26SM' },
  { code: 'PC', name: 'Pinecrest', row: 1, col: 1, zips: ['94000-94499'], seated: { blue: 0, red: 1 }, senate: 'PLXSENATE-26PC' },
  { code: 'CW', name: 'Coldwater', row: 1, col: 2, zips: ['95000-95499'], seated: { blue: 1, red: 0 }, senate: 'PLXSENATE-26CW' },
  { code: 'LK', name: 'Lakeside', row: 1, col: 3, zips: ['98000-98499'], seated: { blue: 1, red: 1 } },
  { code: 'AL', name: 'Alder', row: 2, col: 0, zips: ['96000-96299'], seated: { blue: 0, red: 1 }, senate: 'PLXSENATE-26AL' },
  { code: 'MW', name: 'Marlow', row: 2, col: 1, zips: ['96300-96599'], seated: { blue: 1, red: 0 }, senate: 'PLXSENATE-26MW' },
  { code: 'EM', name: 'Emerald', row: 2, col: 2, zips: ['96600-96999'], seated: { blue: 0, red: 1 }, senate: 'PLXSENATE-26EM' },
  { code: 'IB', name: 'Ironbridge', row: 2, col: 3, zips: ['98500-98999'], seated: { blue: 0, red: 2 } },
];

// Ballot jurisdictions: states, districts within Harbor State, and cities. A lookup returns the most specific match and
// its ancestors; contests are collected along that chain (state races first, then district, then city).
const PLACES = [
  ...STATES.map((s) => ({ id: s.code, kind: 'state', name: s.name, parent: null, zips: s.zips, names: [s.name],
    contests: [...(s.governor ? [{ event: s.governor, office: 'Governor', kind: 'race' }] : []), ...(s.senate ? [{ event: s.senate, office: 'Senate seat', kind: 'race' }] : [])] })),
  { id: 'HS-1', kind: 'district', name: 'Harbor State District 1', parent: 'HS', zips: ['90100-90299'], names: [], contests: [] },
  { id: 'HS-2', kind: 'district', name: 'Harbor State District 2', parent: 'HS', zips: ['90300-90599'], names: [], contests: [] },
  { id: 'HS-HC', kind: 'city', name: 'Harbor City', parent: 'HS-1', zips: ['90100-90189'], names: ['Harbor City'],
    contests: [{ event: 'PLXCOUNCIL-27MAYOR', office: 'Mayor of Harbor City', kind: 'race' }, { event: 'PLXCOUNCIL-27TRAM', office: 'Measure T: waterfront tram', kind: 'measure' }] },
  { id: 'HS-SV', kind: 'city', name: 'Seaview', parent: 'HS-2', zips: ['90300-90349'], names: ['Seaview'], contests: [] },
  { id: 'RB-RC', kind: 'city', name: 'Ridge Crossing', parent: 'RB', zips: ['92000-92099'], names: ['Ridge Crossing'], contests: [] },
];

module.exports = { STATES, PLACES };
