'use strict';
// The text catalog (CLONE_SPEC.md §32.3): every key, its default, its declared variables and where it is used.
//   client keys  public/js/content/*-strings.js (one module per SPA area), read from their strict-JSON blocks, so no
//                ESM loader or eval is needed; `pwa-strings.js` keeps its own markers and is listed under `pwa.`.
//   server keys  server/content/*.js keyed modules, listed under `server.<module>.`.
// Declared variables are the `{name}` placeholders of the default; a template that uses any other name is refused when
// saved. Keys flagged `rich` in a module's META accept sanitised HTML (sanitize.js 'rich' profile); every other key is
// plain text.
const fs = require('node:fs');
const path = require('node:path');
const { sanitize, plainProblem } = require('./sanitize');

const CONTENT_DIR = path.join(__dirname, '..', '..', 'public', 'js', 'content');
const MARK = { begin: '/* CONTENT_JSON_BEGIN */', end: '/* CONTENT_JSON_END */', metaBegin: '/* CONTENT_META_BEGIN */', metaEnd: '/* CONTENT_META_END */' };
const PWA_MARK = { begin: '/* PWA_STRINGS_JSON_BEGIN */', end: '/* PWA_STRINGS_JSON_END */' };
const PH = /\{([a-z][a-z0-9_]*)\}/gi;
const varsOf = (s) => [...new Set([...String(s).matchAll(PH)].map((m) => m[1]))];

// Which SPA route shows an area (Admin › Texts "Preview in context").
const AREA_ROUTES = {
  home: '/', shell: '/', browse: '/browse', event: '/browse', portfolio: '/portfolio', watchlist: '/watchlist', calendar: '/calendar', pro: '/pro', perps: '/perps', perps2: '/perps',
  combos: '/combos', sports: '/sports', scoreboard: '/sports', social: '/social', social2: '/social', 'social-manage': '/social/circle', groups: '/messages', chat: '/browse',
  notifications: '/notifications', 'notification-settings': '/notifications/settings', account: '/account', 'account-settings': '/account/settings', 'account-identity': '/account/privacy',
  'account-activity': '/account/activity', 'account-documents': '/account/taxes', 'account-payments': '/account/payments', 'account-menu': '/', auth: '/sign-in', onboarding: '/sign-up/identity',
  'identity-pages': '/forgot-password', funds: '/funds', rewards: '/rewards', incentives: '/incentives', hubs: '/hubs/elections', placeholder: '/trust/about', currency: '/', pwa: '/',
  components: '/', lib: '/', errors: '/', stepup: '/account', 'payment-forms': '/funds/deposit', 'docv-phone': '/verify/m', 'ai-summary': '/browse', store: '/', security: '/', pages: '/',
  flags: '/', heist: '/heist', // Phase 5D (CLONE_SPEC.md §33)
  'api-keys': '/account/api-keys', docs: '/docs', status: '/status', // Phase 7 (CLONE_SPEC.md §35)
};

function block(src, b, e, file) {
  const a = src.indexOf(b); const z = src.indexOf(e);
  if (a < 0 || z < a) return null;
  try { return JSON.parse(src.slice(a + b.length, z)); } catch (err) { throw new Error(`${file}: invalid JSON between ${b} and ${e}: ${err.message}`); }
}

let memo = null;
function serverModules() {
  // Required lazily: these modules require server/content/catalog.js only.
  const cs = require('../content/currency-strings');
  const pwa = require('../content/pwa');
  const out = [['currency', cs.STRINGS], ['pwa', pwa.SERVER_STRINGS]];
  try { out.push(['messages', require('../content/messages').STRINGS]); } catch { /* optional */ }
  out.push(['playmode', require('../content/playmode').STRINGS]); // feature flags, play mode, Central Bank (CLONE_SPEC.md §33)
  out.push(['perps', require('../content/perps').STRINGS]); // Perps completion (CLONE_SPEC.md §34)
  out.push(['api', require('../content/api').STRINGS]); // public trading API (CLONE_SPEC.md §35)
  return out;
}

// Map key -> { key, area, section, scope, default, vars, types, rich }
function load() {
  const files = fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith('-strings.js')).sort();
  const stamp = files.map((f) => `${f}:${fs.statSync(path.join(CONTENT_DIR, f)).mtimeMs}`).join('|');
  if (memo && memo.stamp === stamp) return memo.map;
  const map = new Map();
  const add = (key, def, area, scope, meta = {}) => {
    const section = key.startsWith(`${area}.`) ? key.slice(area.length + 1).split('.').slice(0, -1).join('.') || 'common' : key.split('.').slice(1, -1).join('.') || 'common';
    map.set(key, { key, area, section, scope, default: String(def), vars: varsOf(def), types: meta.vars || {}, rich: !!meta.rich });
  };
  for (const f of files) {
    const src = fs.readFileSync(path.join(CONTENT_DIR, f), 'utf8');
    const area = f.replace(/-strings\.js$/, '');
    if (f === 'pwa-strings.js') {
      const s = block(src, PWA_MARK.begin, PWA_MARK.end, f) || {};
      for (const [k, v] of Object.entries(s)) add(`pwa.${k}`, v, 'pwa', 'client');
      continue;
    }
    const s = block(src, MARK.begin, MARK.end, f);
    if (!s) continue;
    const meta = block(src, MARK.metaBegin, MARK.metaEnd, f) || {};
    for (const [k, v] of Object.entries(s)) add(k, v, area, 'client', meta[k]);
  }
  for (const [mod, strings] of serverModules()) for (const [k, v] of Object.entries(strings)) add(`server.${mod}.${k}`, v, `server.${mod}`, 'server');
  memo = { stamp, map };
  return map;
}

// Validates a text override for `key`; returns the value to store, or throws {field: message}.
function validate(key, value) {
  const e = load().get(key);
  if (!e) throw { key: 'unknown text key' };
  if (typeof value !== 'string') throw { value: 'must be a string' };
  if (value.length > 5000) throw { value: 'must be at most 5000 characters' };
  const undeclared = varsOf(value).filter((v) => !e.vars.includes(v));
  if (undeclared.length) throw { value: `undeclared variable${undeclared.length > 1 ? 's' : ''} ${undeclared.map((v) => `{${v}}`).join(', ')}; this text can use ${e.vars.length ? e.vars.map((v) => `{${v}}`).join(', ') : 'no variables'}`, code: 'undeclared_variable' };
  if (e.rich) return sanitize(value, 'rich');
  const p = plainProblem(value);
  if (p) throw { value: p };
  return value;
}

module.exports = { load, validate, varsOf, AREA_ROUTES, CONTENT_DIR };
