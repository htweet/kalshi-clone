'use strict';
// Per-country rules for identity onboarding (PLAN P3.1/P3.2, CLONE_SPEC §13.14 / §25): dial codes and national
// number lengths for E.164 phone validation, region lists, postal-code formats and the country-specific national
// identification number (label, format, checksum, masking). Also the coarse geography used by the simulated
// geolocation provider (P3.6). Everything here is public reference data or invented sandbox rules; no personal data.

const US_STATES = [['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'],
  ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'],
  ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'],
  ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'],
  ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'],
  ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'], ['WV', 'West Virginia'],
  ['WI', 'Wisconsin'], ['WY', 'Wyoming']];
const CA_PROVINCES = [['AB', 'Alberta'], ['BC', 'British Columbia'], ['MB', 'Manitoba'], ['NB', 'New Brunswick'], ['NL', 'Newfoundland and Labrador'], ['NS', 'Nova Scotia'],
  ['NT', 'Northwest Territories'], ['NU', 'Nunavut'], ['ON', 'Ontario'], ['PE', 'Prince Edward Island'], ['QC', 'Quebec'], ['SK', 'Saskatchewan'], ['YT', 'Yukon']];
const NG_STATES = ['Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'Federal Capital Territory',
  'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto',
  'Taraba', 'Yobe', 'Zamfara'].map((n) => [n.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3), n]);
const AU_STATES = [['ACT', 'Australian Capital Territory'], ['NSW', 'New South Wales'], ['NT', 'Northern Territory'], ['QLD', 'Queensland'], ['SA', 'South Australia'],
  ['TAS', 'Tasmania'], ['VIC', 'Victoria'], ['WA', 'Western Australia']];
const GB_NATIONS = [['ENG', 'England'], ['SCT', 'Scotland'], ['WLS', 'Wales'], ['NIR', 'Northern Ireland']];
const DE_STATES = ['Baden-Württemberg', 'Bayern', 'Berlin', 'Brandenburg', 'Bremen', 'Hamburg', 'Hessen', 'Mecklenburg-Vorpommern', 'Niedersachsen', 'Nordrhein-Westfalen',
  'Rheinland-Pfalz', 'Saarland', 'Sachsen', 'Sachsen-Anhalt', 'Schleswig-Holstein', 'Thüringen'].map((n, i) => [`DE${String(i + 1).padStart(2, '0')}`, n]);

const digits = (s) => String(s || '').replace(/\D/g, '');
const luhn = (num) => {
  let sum = 0;
  for (let i = 0; i < num.length; i++) {
    let d = Number(num[num.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
};
const allSame = (s) => /^(\d)\1*$/.test(s);
// Brazilian CPF check digits.
function cpfOk(n) {
  if (n.length !== 11 || allSame(n)) return false;
  const dv = (len) => { let s = 0; for (let i = 0; i < len; i++) s += Number(n[i]) * (len + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(n[9]) && dv(10) === Number(n[10]);
}
// Australian TFN weighted checksum (8 or 9 digits).
function tfnOk(n) {
  const w = n.length === 9 ? [1, 4, 3, 7, 5, 8, 6, 9, 10] : [10, 7, 8, 4, 6, 3, 5, 1];
  if (n.length !== 8 && n.length !== 9) return false;
  return w.reduce((a, x, i) => a + x * Number(n[i]), 0) % 11 === 0;
}

// National identification numbers. `normalize` strips separators; `validate(n, {sandbox})` returns an error message or
// null (the message never contains the value); `display` formats the masked tail for the UI.
// Sandbox rule (non-production only): US SSNs in the never-issued 9xx area are accepted as obviously fake test numbers.
const NATIONAL_IDS = {
  US: { type: 'ssn', label: 'Social Security number (SSN)', short: 'SSN', hint: '9 digits', placeholder: '###-##-####', inputmode: 'numeric', maxLen: 11,
    normalize: digits,
    validate: (n, { sandbox }) => {
      if (!/^\d{9}$/.test(n)) return 'an SSN has 9 digits';
      const area = n.slice(0, 3); const group = n.slice(3, 5); const serial = n.slice(5);
      if (area === '000' || area === '666' || group === '00' || serial === '0000') return 'this is not a valid SSN';
      if (area[0] === '9' && !sandbox) return 'this is not a valid SSN';
      return null;
    } },
  CA: { type: 'sin', label: 'Social Insurance Number (SIN)', short: 'SIN', hint: '9 digits', placeholder: '### ### ###', inputmode: 'numeric', maxLen: 11,
    normalize: digits, validate: (n) => (!/^\d{9}$/.test(n) ? 'a SIN has 9 digits' : n[0] === '0' || !luhn(n) ? 'this is not a valid SIN' : null) },
  GB: { type: 'nino', label: 'National Insurance number', short: 'NINO', hint: '2 letters, 6 digits, 1 letter', placeholder: 'QQ 12 34 56 C', inputmode: 'text', maxLen: 13,
    normalize: (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
    validate: (n) => (!/^[A-CEGHJ-PR-TW-Z]{2}\d{6}[A-D]$/.test(n) || /^(BG|GB|NK|KN|TN|NT|ZZ)/.test(n) ? 'this is not a valid National Insurance number' : null) },
  NG: { type: 'nin', label: 'National Identification Number (NIN)', short: 'NIN', hint: '11 digits', placeholder: '###########', inputmode: 'numeric', maxLen: 11,
    normalize: digits, validate: (n) => (!/^\d{11}$/.test(n) ? 'a NIN has 11 digits' : allSame(n) ? 'this is not a valid NIN' : null) },
  AU: { type: 'tfn', label: 'Tax File Number (TFN)', short: 'TFN', hint: '8 or 9 digits', placeholder: '### ### ###', inputmode: 'numeric', maxLen: 11,
    normalize: digits, validate: (n) => (!/^\d{8,9}$/.test(n) ? 'a TFN has 8 or 9 digits' : !tfnOk(n) ? 'this is not a valid TFN' : null) },
  DE: { type: 'steuer_id', label: 'Tax identification number (Steuer-ID)', short: 'Steuer-ID', hint: '11 digits', placeholder: '###########', inputmode: 'numeric', maxLen: 14,
    normalize: digits, validate: (n) => (!/^[1-9]\d{10}$/.test(n) ? 'a Steuer-ID has 11 digits and does not start with 0' : null) },
  BR: { type: 'cpf', label: 'CPF', short: 'CPF', hint: '11 digits', placeholder: '###.###.###-##', inputmode: 'numeric', maxLen: 14,
    normalize: digits, validate: (n) => (!/^\d{11}$/.test(n) ? 'a CPF has 11 digits' : !cpfOk(n) ? 'this is not a valid CPF' : null) },
  KE: { type: 'national_id', label: 'National ID number', short: 'ID', hint: '7 or 8 digits', placeholder: '########', inputmode: 'numeric', maxLen: 8,
    normalize: digits, validate: (n) => (!/^\d{7,8}$/.test(n) ? 'a Kenyan ID number has 7 or 8 digits' : null) },
  IN: { type: 'aadhaar', label: 'Aadhaar number', short: 'Aadhaar', hint: '12 digits', placeholder: '#### #### ####', inputmode: 'numeric', maxLen: 14,
    normalize: digits, validate: (n) => (!/^[2-9]\d{11}$/.test(n) ? 'an Aadhaar number has 12 digits and does not start with 0 or 1' : null) },
  MX: { type: 'curp', label: 'CURP', short: 'CURP', hint: '18 characters', placeholder: 'AAAA000000AAAAAA00', inputmode: 'text', maxLen: 18,
    normalize: (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
    validate: (n) => (!/^[A-Z]{4}\d{6}[HMX][A-Z]{5}[A-Z0-9]\d$/.test(n) ? 'this is not a valid CURP' : null) },
};

// Countries offered in onboarding. phone: [dial code, min national digits, max national digits, national-number pattern,
// blocked premium-rate prefixes]. regions: list of [code, name] for a select, or null for a free-text field.
const COUNTRIES = {
  US: { name: 'United States', phone: ['1', 10, 10, /^[2-9]\d{2}[2-9]\d{6}$/, [/^(900|976)/]], regions: US_STATES, regionLabel: 'State', postal: /^\d{5}(-\d{4})?$/, postalLabel: 'ZIP code', postalHint: '5 digits' },
  CA: { name: 'Canada', phone: ['1', 10, 10, /^[2-9]\d{2}[2-9]\d{6}$/, [/^900/]], regions: CA_PROVINCES, regionLabel: 'Province or territory', postal: /^[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d$/, postalLabel: 'Postal code', postalHint: 'A1A 1A1' },
  GB: { name: 'United Kingdom', phone: ['44', 10, 10, /^[1-9]\d{9}$/, [/^9/, /^87[0-3]/]], regions: GB_NATIONS, regionLabel: 'Nation', postal: /^[A-Za-z]{1,2}\d[A-Za-z\d]? ?\d[A-Za-z]{2}$/, postalLabel: 'Postcode', postalHint: 'e.g. SW1A 1AA' },
  NG: { name: 'Nigeria', phone: ['234', 10, 10, /^[789][01]\d{8}$/, []], regions: NG_STATES, regionLabel: 'State', postal: /^\d{6}$/, postalLabel: 'Postal code', postalHint: '6 digits' },
  AU: { name: 'Australia', phone: ['61', 9, 9, /^[2-478]\d{8}$/, [/^19/]], regions: AU_STATES, regionLabel: 'State or territory', postal: /^\d{4}$/, postalLabel: 'Postcode', postalHint: '4 digits' },
  DE: { name: 'Germany', phone: ['49', 10, 11, /^[1-9]\d{9,10}$/, [/^900/, /^137/]], regions: DE_STATES, regionLabel: 'State', postal: /^\d{5}$/, postalLabel: 'Postleitzahl', postalHint: '5 digits' },
  BR: { name: 'Brazil', phone: ['55', 10, 11, /^[1-9]{2}9?\d{8}$/, []], regions: null, regionLabel: 'State', postal: /^\d{5}-?\d{3}$/, postalLabel: 'CEP', postalHint: '00000-000' },
  KE: { name: 'Kenya', phone: ['254', 9, 9, /^[17]\d{8}$/, [/^900/]], regions: null, regionLabel: 'County', postal: /^\d{5}$/, postalLabel: 'Postal code', postalHint: '5 digits' },
  IN: { name: 'India', phone: ['91', 10, 10, /^[6-9]\d{9}$/, []], regions: null, regionLabel: 'State or union territory', postal: /^[1-9]\d{5}$/, postalLabel: 'PIN code', postalHint: '6 digits' },
  MX: { name: 'Mexico', phone: ['52', 10, 10, /^[1-9]\d{9}$/, [/^900/]], regions: null, regionLabel: 'State', postal: /^\d{5}$/, postalLabel: 'Código postal', postalHint: '5 digits' },
};

// Names for countries that only appear in geography / policy lists (not offered in onboarding).
const OTHER_NAMES = { CU: 'Cuba', IR: 'Iran', KP: 'North Korea', SY: 'Syria', RU: 'Russia', FR: 'France', JP: 'Japan', ZZ: 'Unknown / local network' };
const countryName = (c) => (COUNTRIES[c] ? COUNTRIES[c].name : OTHER_NAMES[c] || c);

// Simulated IP-to-country table (P3.6). Uses the RFC 5737 documentation ranges so no real network is mapped; ops can
// add overrides in Admin › Compliance. Loopback / private / unknown addresses map to "ZZ" (local network).
const IP_TABLE = [['192.0.2.0/24', 'US'], ['198.51.100.0/25', 'GB'], ['198.51.100.128/25', 'NG'], ['203.0.113.0/26', 'CA'], ['203.0.113.64/26', 'DE'], ['203.0.113.128/26', 'CU'], ['203.0.113.192/26', 'IR']];

// Coarse bounding boxes [minLat, minLon, maxLat, maxLon] for browser-reported coordinates (P3.6). Blocked jurisdictions
// come first so a point near a border resolves conservatively.
const GEO_BOXES = [
  ['CU', [19.5, -85.2, 23.5, -74.0]], ['KP', [37.6, 124.1, 43.1, 130.8]], ['IR', [25.0, 44.0, 39.8, 63.4]], ['SY', [32.3, 35.6, 37.4, 42.4]],
  ['US', [24.4, -125.0, 49.4, -66.9]], ['US', [51.0, -179.9, 71.5, -129.9]], ['US', [18.8, -160.3, 22.3, -154.7]],
  ['CA', [41.6, -141.1, 83.2, -52.6]], ['MX', [14.5, -118.5, 32.8, -86.7]], ['GB', [49.8, -8.7, 60.9, 1.8]], ['FR', [41.3, -5.2, 51.1, 9.6]], ['DE', [47.2, 5.8, 55.1, 15.1]],
  ['NG', [4.2, 2.6, 13.9, 14.7]], ['KE', [-4.7, 33.9, 5.0, 41.9]], ['IN', [6.7, 68.1, 35.5, 97.4]], ['AU', [-43.7, 112.9, -10.6, 153.7]], ['BR', [-33.8, -74.0, 5.3, -34.8]],
  ['JP', [24.0, 122.9, 45.6, 145.9]], ['RU', [41.1, 27.3, 77.8, 180.0]],
];
function countryAt(lat, lon) {
  for (const [c, [a, b, x, y]] of GEO_BOXES) if (lat >= a && lat <= x && lon >= b && lon <= y) return c;
  return 'ZZ';
}

function ipToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function cidrMatch(ip, cidr) {
  const [base, bits] = String(cidr).split('/');
  const a = ipToInt(ip); const b = ipToInt(base); const n = Number(bits);
  if (a == null || b == null || !(n >= 0 && n <= 32)) return false;
  const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}
const validCidr = (c) => { const [b, n] = String(c).split('/'); return ipToInt(b) != null && /^\d{1,2}$/.test(n || '') && Number(n) <= 32; };
function countryOfIp(ip, overrides = []) {
  const v4 = String(ip || '').replace(/^::ffff:/, '');
  for (const o of overrides) if (cidrMatch(v4, o.cidr)) return o.country;
  for (const [cidr, c] of IP_TABLE) if (cidrMatch(v4, cidr)) return c;
  return 'ZZ';
}

// E.164 normalisation for a country + national number (P3.2). Returns {e164, national} or {error}.
function normalizePhone(country, number) {
  const c = COUNTRIES[String(country || '').toUpperCase()];
  if (!c) return { error: 'choose a supported country' };
  const [dial, min, max, pattern, premium] = c.phone;
  let n = String(number || '').trim();
  if (n.length > 32) return { error: 'enter a valid phone number' };
  if (n.startsWith('+')) {
    const d = digits(n);
    if (!d.startsWith(dial)) return { error: `numbers in ${c.name} start with +${dial}` };
    n = d.slice(dial.length);
  } else {
    n = digits(n);
    if (n.startsWith('00' + dial)) n = n.slice(2 + dial.length);
    else if (dial === '1' && n.length === 11 && n.startsWith('1')) n = n.slice(1);
    else if (dial !== '1' && n.startsWith('0')) n = n.slice(1); // national trunk prefix
  }
  if (n.length < min || n.length > max || !pattern.test(n)) return { error: `enter a valid ${c.name} phone number` };
  if (premium.some((re) => re.test(n))) return { error: 'premium-rate numbers cannot receive verification codes' };
  const e164 = `+${dial}${n}`;
  if (!/^\+[1-9]\d{6,14}$/.test(e164)) return { error: 'enter a valid phone number' };
  return { e164, national: n, dial };
}
// "+1 •••-•••-0142" style: country code and the last 4 digits only.
function maskPhone(e164, dial) {
  const s = String(e164 || '');
  const d = dial || (Object.values(COUNTRIES).map((c) => c.phone[0]).sort((a, b) => b.length - a.length).find((x) => s.startsWith(`+${x}`)) || '');
  const rest = s.slice(1 + d.length);
  return `+${d} ${'•'.repeat(Math.max(0, rest.length - 4))}${rest.slice(-4)}`;
}

// Public view of the table for the client (no functions, no regexes).
function publicTable() {
  return Object.entries(COUNTRIES).map(([code, c]) => {
    const id = NATIONAL_IDS[code];
    return {
      code, name: c.name, dial_code: `+${c.phone[0]}`, phone_digits: [c.phone[1], c.phone[2]],
      regions: c.regions ? c.regions.map(([v, n]) => ({ code: v, name: n })) : null, region_label: c.regionLabel,
      postal_label: c.postalLabel, postal_hint: c.postalHint, postal_pattern: c.postal.source,
      national_id: id ? { type: id.type, label: id.label, short: id.short, hint: id.hint, placeholder: id.placeholder, inputmode: id.inputmode, max_length: id.maxLen } : null,
    };
  });
}

const PO_BOX = /\b(p\.?\s*o\.?\s*b(ox)?|post\s*office\s*box|postfach|caixa\s*postal|apartado(\s*postal)?|pmb|private\s*mail\s*bag)\b/i;

module.exports = { COUNTRIES, NATIONAL_IDS, countryName, countryAt, countryOfIp, cidrMatch, validCidr, normalizePhone, maskPhone, publicTable, PO_BOX, IP_TABLE, GEO_BOXES };
