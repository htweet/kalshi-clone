'use strict';
// Server side of the text catalog (CLONE_SPEC.md §32.3). Keyed content modules (server/content/*.js) hold the
// defaults; published admin overrides (Admin › Content › Texts, server/cms/) are installed here, so every server t()
// sees them without restart. No dependencies: any module can require it.
//
//   t(key, vars, def)  the published override of `key`, else `def` (the module's default), with {name} filled in.
//                      Typed variables (declared `money`, `number`) are formatted through the registered formatters
//                      (server/currency.js registers money).
const overrides = new Map(); // key -> template (published, default locale)
const types = new Map(); // key -> { name: type }
let formatters = {};
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function setOverrides(entries) { overrides.clear(); for (const [k, v] of entries) if (typeof v === 'string') overrides.set(k, v); }
const setOverride = (key, value) => { if (typeof value === 'string') overrides.set(key, value); else overrides.delete(key); };
const setTypes = (key, vars) => types.set(key, vars || {});
const setFormatters = (f) => { formatters = { ...formatters, ...f }; };
const override = (key) => (overrides.has(key) ? overrides.get(key) : undefined);

function fill(key, s, vars) {
  if (!vars) return s;
  const ty = types.get(key) || {};
  return String(s).replace(/\{([a-z][a-z0-9_]*)\}/gi, (m, k) => {
    if (!own(vars, k)) return m;
    const v = vars[k];
    const f = ty[k] && formatters[ty[k]];
    return String(f && v != null && typeof v !== 'string' ? f(v) : v ?? '');
  });
}
function t(key, vars, def) {
  const s = overrides.has(key) ? overrides.get(key) : def !== undefined ? def : key;
  return fill(key, s, vars);
}
// A keyed module's lookup function: `const s = catalog.scoped('server.pwa.', STRINGS)` then s('push.test_title').
const scoped = (prefix, strings) => (key, vars = {}) => t(prefix + key, vars, own(strings, key) ? strings[key] : key);

module.exports = { t, scoped, setOverrides, setOverride, setTypes, setFormatters, override, fill };
