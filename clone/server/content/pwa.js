'use strict';
// Progressive Web App content (CLONE_SPEC.md §31.12), kept as data so a later CMS phase can manage it.
//
//   PWA_CONFIG      the web app manifest's editable fields (name, colours, icons, shortcuts). GET /manifest.webmanifest
//                   is built from it by manifestOf(); nothing else holds these values.
//   SERVER_STRINGS  keyed server-side user-facing text of the PWA / Web Push features (the test notification, API
//                   error messages shown to the user).
//   clientStrings() the strings of the client module public/js/content/pwa-strings.js (the offline page, the service
//                   worker's fallback text and every view string), read from its strict-JSON block.
//   renderOffline() fills public/offline.html (a template with {{key}} placeholders, HTML-escaped) from the client
//                   strings; the build writes the result to dist/offline.html, the dev server serves it the same way.
// Push notification titles and bodies are not here: they are the notification's own text (features.notify callers),
// which the CMS's notification templates will drive.
const fs = require('node:fs');
const path = require('node:path');

const PWA_CONFIG = {
  id: '/',
  name: 'Parlance Exchange',
  short_name: 'Parlance',
  description: 'Trade yes/no contracts on real-world outcomes.',
  lang: 'en',
  dir: 'ltr',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  theme_color: '#008751', // brand green, light theme (CLONE_SPEC §27.6)
  background_color: '#0d0e11', // the dark surface
  categories: ['finance'],
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
  ],
  shortcut_icon: { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
  shortcuts: [
    { name: 'Markets', short_name: 'Markets', description: 'Browse every market', url: '/browse' },
    { name: 'Portfolio', short_name: 'Portfolio', description: 'Positions, orders and history', url: '/portfolio' },
    { name: 'Deposit', short_name: 'Deposit', description: 'Add funds to your account', url: '/funds/deposit' },
  ],
};

const SERVER_STRINGS = {
  // The test notification's title and body are the template push.test (server/content/notification-templates.js).
  'push.test_link': '/notifications/settings',
  'push.error_service_unsupported': 'this browser\'s push service is not supported',
  'push.error_too_many_devices': 'at most {max} devices can receive push notifications; remove one first',
};
// Admin overrides (Admin › Content › Texts, key `server.pwa.<key>`, CLONE_SPEC.md §32.3) replace the defaults.
const catalog = require('./catalog');
const s = (key, vars = {}) => String(catalog.override(`server.pwa.${key}`) ?? SERVER_STRINGS[key] ?? key).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

// The manifest served at /manifest.webmanifest, from a config object (defaults: PWA_CONFIG).
function manifestOf(cfg = PWA_CONFIG) {
  const { shortcut_icon: icon, shortcuts, ...rest } = cfg;
  return { ...rest, shortcuts: shortcuts.map((x) => ({ ...x, icons: icon ? [icon] : [] })) };
}

const STRINGS_FILE = path.join(__dirname, '..', '..', 'public', 'js', 'content', 'pwa-strings.js');
const BEGIN = '/* PWA_STRINGS_JSON_BEGIN */'; const END = '/* PWA_STRINGS_JSON_END */';
let loaded = null;
// The client strings object, read from the ES module's strict-JSON block (no eval, no ESM loader needed), memoised by
// file modification time so edits show in dev.
function clientStrings() {
  const mtime = fs.statSync(STRINGS_FILE).mtimeMs;
  if (loaded && loaded.mtime === mtime) return loaded.strings;
  const src = fs.readFileSync(STRINGS_FILE, 'utf8');
  const a = src.indexOf(BEGIN); const b = src.indexOf(END);
  if (a < 0 || b < a) throw new Error('public/js/content/pwa-strings.js: the JSON markers are missing');
  const strings = JSON.parse(src.slice(a + BEGIN.length, b));
  for (const [k, v] of Object.entries(strings)) if (typeof v !== 'string') throw new Error(`pwa-strings: ${k} is not a string`);
  loaded = { mtime, strings };
  return strings;
}

const escHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function renderOffline(template, strings) {
  const out = template.replace(/\{\{([a-z_.]+)\}\}/g, (m, k) => {
    if (!Object.prototype.hasOwnProperty.call(strings, k)) throw new Error(`offline.html uses an unknown string key: ${k}`);
    return escHtml(strings[k]);
  });
  return out;
}

module.exports = { PWA_CONFIG, SERVER_STRINGS, s, manifestOf, clientStrings, renderOffline, STRINGS_FILE, escHtml };
