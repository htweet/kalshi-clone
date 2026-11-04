/* Parlance service worker (CLONE_SPEC.md §31). Served at /sw.js with scope "/" by server/pwa-static.js; the build
 * (scripts/build.js) fills in the version and the precache list, the dev server a "dev" version with no hashed assets.
 *
 * What it does, and only this:
 *   - precaches the public, content-hashed static assets of this build plus /offline.html and the icons, fetched
 *     without credentials (no cookies, so nothing user-specific), and serves exactly those paths cache-first;
 *   - navigations go to the network (navigation preload) and are never cached: every HTML response carries its own
 *     per-response CSP nonce and boot proof. When the network fails it shows /offline.html;
 *   - every other request (all of /v1/*, /trade-api/*, the WebSocket, uploads, anything cross-origin) is not handled
 *     at all, so the browser sends it unchanged: client-token signing, CSRF and the bot challenge keep working;
 *   - waits for the page to ask before taking over (the "New version available — Reload" toast);
 *   - shows Web Push notifications and opens their same-origin deep link on click.
 */
'use strict';

const VERSION = '__PLX_SW_VERSION__';
const PRECACHE = /* __PLX_PRECACHE__ */ ['/offline.html'];
// Keyed text from public/js/content/pwa-strings.js, filled in by the build and the dev server (never served empty).
const STRINGS = /* __PLX_STRINGS__ */ {};
const PREFIX = 'plx-static-';
const CACHE = PREFIX + VERSION;
const OFFLINE = '/offline.html';
const PRECACHED = new Set(PRECACHE);
const NEVER = /^\/(v1|trade-api)(\/|$)/;

// A response may be stored only if it is a plain same-origin 200 that the server did not mark private or no-store.
// (Set-Cookie is never visible to a service worker; the check is kept as a second line of defence.)
function cacheable(res) {
  if (!res || res.status !== 200 || res.type !== 'basic' || res.redirected) return false;
  if (res.headers.has('set-cookie')) return false;
  return !/no-store|private/i.test(res.headers.get('cache-control') || '');
}

async function precache() {
  const cache = await caches.open(CACHE);
  await Promise.all(PRECACHE.map(async (path) => {
    if (NEVER.test(path)) return;
    const res = await fetch(new Request(path, { cache: 'reload', credentials: 'omit', redirect: 'error' }));
    if (!cacheable(res)) throw new Error(`precache failed for ${path} (${res.status})`);
    await cache.put(path, res);
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
  // No skipWaiting() here: a new version waits until the user clicks "Reload" (message SKIP_WAITING).
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith(PREFIX) && k !== CACHE) await caches.delete(k);
    if (self.registration.navigationPreload) { try { await self.registration.navigationPreload.enable(); } catch { /* unsupported */ } }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const d = event.data;
  if (d && d.type === 'SKIP_WAITING') self.skipWaiting();
});

// Precache again when the page cleared Cache Storage (sign-out) and the next page load finds it empty.
async function refill() {
  try { if (!(await caches.match(OFFLINE, { cacheName: CACHE }))) await precache(); } catch { /* next navigation retries */ }
}

async function offlinePage() {
  const hit = (await caches.match(OFFLINE, { cacheName: CACHE })) || (await caches.match(OFFLINE));
  if (hit) return hit;
  return new Response(STRINGS['offline.fallback_text'], { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function navigate(event) {
  try {
    const pre = await event.preloadResponse;
    const res = pre || (await fetch(event.request));
    event.waitUntil(refill());
    return res; // never stored
  } catch {
    return offlinePage();
  }
}

async function fromPrecache(request, path) {
  const hit = await caches.match(path, { cacheName: CACHE });
  return hit || fetch(request); // a miss goes to the network and is not stored
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') { event.respondWith(navigate(event)); return; }
  if (NEVER.test(url.pathname) || url.search) return;
  if (PRECACHED.has(url.pathname)) event.respondWith(fromPrecache(req, url.pathname));
  // Anything else: no respondWith, so the browser performs the request itself, untouched.
});

// ------------------------------------------------------------------------------------------------ Web Push
// The payload is what the in-app notification shows (title, body, deep link); nothing else is sent or displayed.
const text = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const safeLink = (v) => (typeof v === 'string' && /^\/(?!\/)[^\s\\]{0,300}$/.test(v) ? v : '/');

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = {}; }
  const title = text(d.title, 120) || STRINGS['push.default_title'];
  const options = { body: text(d.body, 300), icon: '/icons/icon-192.png', badge: '/icons/badge-72.png', data: { link: safeLink(d.link) }, lang: 'en' };
  if (text(d.tag, 64)) options.tag = text(d.tag, 64);
  if (Number.isFinite(d.ts)) options.timestamp = d.ts;
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = safeLink(event.notification.data && event.notification.data.link);
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((c) => new URL(c.url).origin === self.location.origin);
    if (win) {
      try { await win.focus(); } catch { /* focusing needs a user gesture; routing still happens */ }
      win.postMessage({ type: 'NAVIGATE', link }); // the page routes it client-side (public/js/pwa.js)
      return;
    }
    await self.clients.openWindow(link);
  })());
});

// The push service rotated the subscription: subscribe again with the same key. The page re-registers the new
// subscription with the server on its next load (it needs the session, which a service worker does not hold).
self.addEventListener('pushsubscriptionchange', (event) => {
  const opts = event.oldSubscription && event.oldSubscription.options;
  if (!opts || !opts.applicationServerKey) return;
  event.waitUntil(self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: opts.applicationServerKey }).catch(() => {}));
});
