'use strict';
// Seed data for the elections hub v2 (PLAN Phase 7B, CLONE_SPEC.md §37). Data only: server/elections.js loads it into the
// database once (idempotent) and from then on everything is admin-managed in Admin › Elections. Nothing here is read at
// runtime by the hub, the feed or the results desk, so a country is data, never code (ground rule 5, §30.0).
//
// Real public geography of Nigeria: the six geopolitical zones, the 36 states and the FCT (ISO 3166-2:NG codes), the
// number of local government areas per state (774 in total), three senatorial districts per state plus one for the FCT
// (109 seats) and the number of federal constituencies per state (360). LGA, ward and polling-unit NAMES and the ward and
// polling-unit COUNTS are invented demo values (LGA 01, Ward 01, …), as are the registered voters per polling unit.
// Parties and candidates are invented (clean room): no real party, politician, mark or photo is ever seeded.
//
// The second country, "Harbor" (code XH, from the ISO 3166 user-assigned range so it can never clash with a real
// country), is the invented 12-state map of Phase 5B (server/civic-data.js). It proves that nothing is Nigeria-specific.
const { STATES: HARBOR_STATES } = require('./civic-data');

// [code, name, zone, LGAs, federal constituencies, map row, map col, small (also listed beside the map)]
const NG_STATES = [
  ['SO', 'Sokoto', 'NW', 23, 11, 0, 0], ['ZA', 'Zamfara', 'NW', 14, 7, 0, 1], ['KT', 'Katsina', 'NW', 34, 15, 0, 2], ['KN', 'Kano', 'NW', 44, 24, 0, 3],
  ['JI', 'Jigawa', 'NW', 27, 11, 0, 4], ['YO', 'Yobe', 'NE', 17, 6, 0, 5], ['BO', 'Borno', 'NE', 27, 10, 0, 6],
  ['KE', 'Kebbi', 'NW', 21, 8, 1, 0], ['NI', 'Niger', 'NC', 25, 10, 1, 1], ['KD', 'Kaduna', 'NW', 23, 16, 1, 2], ['BA', 'Bauchi', 'NE', 20, 12, 1, 3],
  ['GO', 'Gombe', 'NE', 11, 6, 1, 4], ['AD', 'Adamawa', 'NE', 21, 8, 1, 5],
  ['KW', 'Kwara', 'NC', 16, 6, 2, 0], ['FC', 'Federal Capital Territory', 'NC', 6, 2, 2, 1, true], ['NA', 'Nasarawa', 'NC', 13, 5, 2, 2], ['PL', 'Plateau', 'NC', 17, 8, 2, 3],
  ['TA', 'Taraba', 'NE', 16, 6, 2, 4],
  ['OY', 'Oyo', 'SW', 33, 14, 3, 0], ['OS', 'Osun', 'SW', 30, 9, 3, 1], ['EK', 'Ekiti', 'SW', 16, 6, 3, 2, true], ['KO', 'Kogi', 'NC', 21, 9, 3, 3], ['BE', 'Benue', 'NC', 23, 11, 3, 4],
  ['OG', 'Ogun', 'SW', 20, 9, 4, 0], ['ON', 'Ondo', 'SW', 18, 9, 4, 1], ['ED', 'Edo', 'SS', 18, 9, 4, 2], ['EN', 'Enugu', 'SE', 17, 8, 4, 3], ['EB', 'Ebonyi', 'SE', 13, 6, 4, 4, true],
  ['CR', 'Cross River', 'SS', 18, 8, 4, 5],
  ['LA', 'Lagos', 'SW', 20, 24, 5, 0, true], ['DE', 'Delta', 'SS', 25, 10, 5, 1], ['AN', 'Anambra', 'SE', 21, 11, 5, 2, true], ['IM', 'Imo', 'SE', 27, 10, 5, 3], ['AB', 'Abia', 'SE', 17, 8, 5, 4, true],
  ['AK', 'Akwa Ibom', 'SS', 31, 10, 5, 5],
  ['BY', 'Bayelsa', 'SS', 8, 5, 6, 1, true], ['RI', 'Rivers', 'SS', 23, 13, 6, 2],
];
const NG_ZONES = [['NC', 'North Central'], ['NE', 'North East'], ['NW', 'North West'], ['SE', 'South East'], ['SS', 'South South'], ['SW', 'South West']];
// Off-cycle governorship states (their governorship elections are not held with the general election).
const NG_OFF_CYCLE = ['AN', 'BY', 'ED', 'EK', 'IM', 'KO', 'ON', 'OS'];

// Invented parties (names, short names and colours are made up; logos are added by admins through the CMS media library).
const NG_PARTIES = [
  { code: 'LUP', name: 'Lantern Unity Party', short: 'LUP', color: '#1f9d55' },
  { code: 'FBC', name: 'Forward Bridge Congress', short: 'FBC', color: '#e8590c' },
  { code: 'HWA', name: 'Harmony Wave Alliance', short: 'HWA', color: '#1c7ed6' },
  { code: 'CTM', name: 'Civic Torch Movement', short: 'CTM', color: '#9c36b5', coalition: 'Renewal Accord' },
  { code: 'SRP', name: 'Savannah Renewal Party', short: 'SRP', color: '#f08c00', coalition: 'Renewal Accord' },
];
// Invented regional strength per zone (relative weights before noise): the seed's priors and the simulator's "true"
// vote shares are drawn around these. Demo values only.
const NG_STRENGTH = {
  NW: { LUP: 46, FBC: 22, HWA: 8, CTM: 14, SRP: 10 }, NE: { LUP: 40, FBC: 20, HWA: 10, CTM: 12, SRP: 18 },
  NC: { LUP: 30, FBC: 28, HWA: 14, CTM: 22, SRP: 6 }, SW: { LUP: 26, FBC: 44, HWA: 12, CTM: 14, SRP: 4 },
  SE: { LUP: 10, FBC: 14, HWA: 58, CTM: 15, SRP: 3 }, SS: { LUP: 18, FBC: 24, HWA: 38, CTM: 17, SRP: 3 },
};
// Invented presidential candidates (one per party; hyphenated invented names, never real people).
const NG_PRESIDENTIAL = [
  { party: 'LUP', name: 'Ifeoma Danjuma-Alabi', mate: 'Garba Ekpo-Sanni' },
  { party: 'FBC', name: 'Tunde Okorie-Bawa', mate: 'Halima Udeh-Kolawole' },
  { party: 'HWA', name: 'Zainab Eze-Lawal', mate: 'Kunle Bassey-Musa' },
  { party: 'CTM', name: 'Chidi Abubakar-Cole', mate: 'Ronke Yusuf-Obi' },
];
// Name parts for invented governorship candidates: a first name and two surnames joined with a hyphen.
const FIRST = ['Amaka', 'Bello', 'Chioma', 'Dauda', 'Efe', 'Funmi', 'Gbenga', 'Hauwa', 'Ibrahim', 'Jumoke', 'Kelechi', 'Ladi', 'Musa', 'Nkechi', 'Obinna', 'Patience', 'Rotimi', 'Sadiq', 'Temitope', 'Uche', 'Wale', 'Yemi', 'Zara', 'Ebere'];
const SUR = ['Adeyemi', 'Bakare', 'Chukwu', 'Dikko', 'Ekanem', 'Fashola', 'Gwarzo', 'Ihejirika', 'Jaja', 'Kalu', 'Lawan', 'Mbah', 'Nwosu', 'Ogun', 'Pam', 'Shehu', 'Tamuno', 'Usman', 'Wike', 'Yakubu', 'Zubairu', 'Ojo', 'Ibe', 'Alamu'];

// Harbor (XH): the Phase 5B parties plus a third, to keep the second country multi-party.
const XH_PARTIES = [
  { code: 'BLU', name: 'Blue Party', short: 'BLU', color: '#1c7ed6' },
  { code: 'RED', name: 'Red Party', short: 'RED', color: '#e03131' },
  { code: 'GLD', name: 'Gold Party', short: 'GLD', color: '#f59f00' },
];
const XH_CANDIDATES = [{ party: 'BLU', name: 'Mara Quill' }, { party: 'RED', name: 'Tobin Ashgrove' }, { party: 'GLD', name: 'Juno Pell' }];

// Win rules (configuration, evaluated by server/elections.js; editable per office in Admin › Elections):
//   plurality  most votes wins (first past the post)
//   spread     most votes AND at least `share` of the votes in at least `fraction` of the `unit` divisions of the race's
//              area (territories excluded from the count and, with `territory_required`, needed on top), else a runoff
const RULES = {
  president: { type: 'spread', share: 0.25, fraction: [2, 3], unit: 'state', territory_required: true, on_fail: 'runoff' },
  governor: { type: 'spread', share: 0.25, fraction: [2, 3], unit: 'lga', territory_required: false, on_fail: 'runoff' },
  plurality: { type: 'plurality' },
};

// Deterministic hash → [0, 1) for invented counts (stable across restarts and machines).
function h01(s) { let x = 2166136261; for (const c of String(s)) { x ^= c.charCodeAt(0); x = Math.imul(x, 16777619); } x ^= x >>> 13; x = Math.imul(x, 0x5bd1e995); x ^= x >>> 15; return (x >>> 0) / 4294967296; }

function nigeria() {
  const country = { code: 'NG', name: 'Nigeria', currency: 'NGN', time_zone: 'Africa/Lagos', locale: 'en-NG',
    config: { levels: [{ key: 'zone' }, { key: 'state' }, { key: 'lga' }, { key: 'ward' }, { key: 'pu' }], map_level: 'state', ballot_levels: ['state', 'lga', 'ward'], count_level: 'lga', map_cols: 7, map_rows: 7 } };
  const divisions = [{ id: 'NG', level: 'country', code: 'NG', name: 'Nigeria', parent: null, data: {} }];
  for (const [z, n] of NG_ZONES) divisions.push({ id: `NG-${z}`, level: 'zone', code: z, name: n, parent: 'NG', data: {} });
  const states = [];
  for (const [code, name, zone, lgas, hor, row, col, small] of NG_STATES) {
    const sid = `NG-${code}`;
    const st = { id: sid, level: 'state', code, name, parent: `NG-${zone}`, data: { row, col, small: !!small, territory: code === 'FC', lga_count: lgas, senate_seats: code === 'FC' ? 1 : 3, house_seats: hor, assembly_seats: code === 'FC' ? 0 : Math.max(24, Math.min(40, hor * 3)) } };
    divisions.push(st); states.push({ ...st, zone, lgas, hor });
    for (let i = 1; i <= lgas; i++) {
      const lid = `${sid}-${String(i).padStart(2, '0')}`;
      const wards = 8 + Math.floor(h01(`${lid}:wards`) * 7); // invented: 8-14 wards per LGA
      let pus = 0;
      const wardRows = [];
      for (let w = 1; w <= wards; w++) {
        const n = 15 + Math.floor(h01(`${lid}-${w}:pus`) * 11); // invented: 15-25 polling units per ward
        pus += n;
        wardRows.push({ id: `${lid}-${String(w).padStart(2, '0')}`, level: 'ward', code: String(w).padStart(2, '0'), name: `Ward ${String(w).padStart(2, '0')}`, parent: lid, data: { pu_count: n } });
      }
      divisions.push({ id: lid, level: 'lga', code: String(i).padStart(2, '0'), name: `LGA ${String(i).padStart(2, '0')}`, parent: sid, data: { ward_count: wards, pu_count: pus } });
      divisions.push(...wardRows);
    }
  }
  const offices = [
    { key: 'president', name: 'President', level: 'national', seats: 1, chamber: false, two_person: true, rule: RULES.president, sort: 1 },
    { key: 'senate', name: 'Senate', level: 'state', seats: 109, chamber: true, two_person: false, rule: RULES.plurality, sort: 2 },
    { key: 'house', name: 'House of Representatives', level: 'state', seats: 360, chamber: true, two_person: false, rule: RULES.plurality, sort: 3 },
    { key: 'governor', name: 'Governor', level: 'state', seats: 36, chamber: false, two_person: false, rule: RULES.governor, sort: 4 },
    { key: 'assembly', name: 'State Houses of Assembly', level: 'state', seats: 990, chamber: true, two_person: false, rule: RULES.plurality, sort: 5 },
  ];
  const strength = (stateCode) => NG_STRENGTH[NG_STATES.find((s) => s[0] === stateCode)[2]];
  return { country, divisions, states, offices, parties: NG_PARTIES, strength, presidential: NG_PRESIDENTIAL };
}

function harbor() {
  const country = { code: 'XH', name: 'Harbor (demo country)', currency: 'NGN', time_zone: 'Africa/Lagos', locale: 'en-NG',
    config: { levels: [{ key: 'state' }, { key: 'district' }, { key: 'precinct' }], map_level: 'state', ballot_levels: ['state', 'district', 'precinct'], count_level: 'district', map_cols: 4, map_rows: 3 } };
  const divisions = [{ id: 'XH', level: 'country', code: 'XH', name: 'Harbor', parent: null, data: {} }];
  const states = [];
  for (const s of HARBOR_STATES) {
    const sid = `XH-${s.code}`;
    const st = { id: sid, level: 'state', code: s.code, name: s.name, parent: 'XH', data: { row: s.row, col: s.col, small: false, territory: false, senate_seats: 2 } };
    divisions.push(st); states.push({ ...st, src: s });
    for (let d = 1; d <= 2; d++) {
      const did = `${sid}-${d}`;
      let pus = 0; const prec = [];
      for (let p = 1; p <= 3; p++) { const n = 12 + Math.floor(h01(`${did}-${p}`) * 9); pus += n; prec.push({ id: `${did}-${p}`, level: 'precinct', code: String(p), name: `Precinct ${p}`, parent: did, data: { pu_count: n } }); }
      divisions.push({ id: did, level: 'district', code: String(d), name: `District ${d}`, parent: sid, data: { pu_count: pus } }, ...prec);
    }
  }
  const offices = [
    { key: 'senate', name: 'Senate', level: 'state', seats: HARBOR_STATES.length * 2, chamber: true, two_person: false, rule: RULES.plurality, sort: 1 },
    { key: 'governor', name: 'Governor', level: 'state', seats: 1, chamber: false, two_person: false, rule: RULES.plurality, sort: 2 },
  ];
  return { country, divisions, states, offices, parties: XH_PARTIES };
}

module.exports = { nigeria, harbor, h01, NG_OFF_CYCLE, FIRST, SUR, XH_CANDIDATES, RULES, HARBOR_STATES };
