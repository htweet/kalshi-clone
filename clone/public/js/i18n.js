// Text catalog runtime (CLONE_SPEC.md §32.3). Every user-facing string of the SPA is a key; the code holds only the
// defaults, in keyed content modules (public/js/content/*-strings.js, one per area), which register() themselves here.
// Admin overrides come from the database through the public content bundle:
//   - at page load, /content-bundle.js (a classic script loaded before the app modules) sets self.__PLX_CONTENT__,
//     so even strings read while a module is first evaluated see the published values;
//   - on a publish, the public `content` WebSocket channel tells every open page, which refetches
//     /v1/content/bundle (ETag) and re-renders (public/js/content-live.js).
// Staff preview mode swaps in a bundle that also holds the drafts (served only to staff, never cached).
//
//   t(key, vars)   plain text: `{name}` placeholders filled with vars.name (typed variables are formatted first).
//                  Callers escape it where it goes into HTML (esc(), textContent), as for any other string.
//   te(key, vars)  HTML: the template text is escaped, the variables are inserted as given (callers pass values that
//                  are already safe markup; parlance/no-unescaped-html checks them at the call site).
//   ts(key, vars)  t() for strings read once when a module is evaluated (tables, constants). Such keys are recorded,
//                  and a live change to one asks for a reload instead of re-rendering (content-live.js).
//   tr(key)        rich text (keys flagged rich): sanitised HTML — overrides were sanitised by the server's allowlist
//                  (bold, italic, lists, paragraphs, line breaks, https:/internal links); defaults are code.
const DEFAULTS = new Map(); // key -> default template
const META = new Map(); // key -> { rich?, vars?: { name: type } }
const STATIC = new Set(); // keys read at module evaluation (ts)
const boot = (typeof self !== 'undefined' && self.__PLX_CONTENT__) || {};
let overrides = boot.texts && typeof boot.texts === 'object' ? boot.texts : {};
let locale = typeof boot.locale === 'string' ? boot.locale : 'en-NG';
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escT = (x) => String(x).replace(/[&<>"']/g, (c) => ESC[c]);
const PH = /\{([a-z][a-z0-9_]*)\}/gi;
let formatters = {}; // typed variables: { money: (cents) => '₦1,000', … } (set by currency.js; no import cycle)

// Registers a content module's defaults (and optional per-key metadata). Later registrations of the same key win.
export function register(strings, meta = {}) {
  for (const [k, v] of Object.entries(strings)) DEFAULTS.set(k, String(v));
  for (const [k, m] of Object.entries(meta || {})) META.set(k, m);
}
export const setFormatters = (f) => { formatters = { ...formatters, ...f }; };
export const hasText = (key) => DEFAULTS.has(key) || own(overrides, key);
export const textLocale = () => locale;
export const staticKeys = () => STATIC;
export const defaultsTable = () => DEFAULTS; // admin in-context helpers
export const metaOf = (key) => META.get(key) || null;

function template(key) {
  if (own(overrides, key) && typeof overrides[key] === 'string') return overrides[key];
  return DEFAULTS.has(key) ? DEFAULTS.get(key) : key;
}
function value(key, name, vars) {
  const v = vars[name];
  const type = META.get(key)?.vars?.[name];
  if (type && formatters[type] && v != null && typeof v !== 'string') return formatters[type](v);
  return v;
}
export function t(key, vars) {
  const s = template(key);
  if (!vars) return s;
  return s.replace(PH, (m, k) => (own(vars, k) ? String(value(key, k, vars) ?? '') : m));
}
export function ts(key, vars) { STATIC.add(key); return t(key, vars); }
export function te(key, vars) {
  const s = template(key);
  let out = ''; let last = 0;
  for (const m of s.matchAll(PH)) {
    out += escT(s.slice(last, m.index));
    out += vars && own(vars, m[1]) ? String(value(key, m[1], vars) ?? '') : escT(m[0]);
    last = m.index + m[0].length;
  }
  return out + escT(s.slice(last));
}
export function tes(key, vars) { STATIC.add(key); return te(key, vars); } // te() read at module evaluation
// Rich text: the server sanitised overrides (allowlist) before publishing them; a key not flagged rich is escaped.
export function tr(key, vars) {
  if (!META.get(key)?.rich) return te(key, vars);
  const s = template(key);
  return vars ? s.replace(PH, (m, k) => (own(vars, k) ? escT(value(key, k, vars) ?? '') : m)) : s;
}

// Called by content-live.js with a newer bundle (published values, or the staff preview with drafts).
export function setTexts(texts, loc) {
  overrides = texts && typeof texts === 'object' ? texts : {};
  if (typeof loc === 'string') locale = loc;
}
export const currentTexts = () => overrides;

// Error messages from the API: error.<code> keys (default "{message}", the server's own message).
export function errorText(code, message, details) {
  const key = `error.${code}`;
  if (!code || !hasText(key)) return message;
  return t(key, { message, details: details ?? '', code });
}
