// Progressive Web App client (CLONE_SPEC.md §31): service worker registration and the "New version available —
// Reload" toast, the install prompt ("Install app" in the ☰ menus; Add-to-Home-Screen steps on iOS Safari), Cache
// Storage cleared at sign-out, and the Web Push subscription of this browser (Settings › Notifications).
import { session, logoutHooks } from './store.js';
import { api } from './api.js';

const sw = typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? navigator.serviceWorker : null;
const PUSH_KEY = 'plx-webpush'; // {uid, id}: this browser's subscription row on the server
const local = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const safeLink = (v) => (typeof v === 'string' && /^\/(?!\/)[^\s\\]{0,300}$/.test(v) ? v : null);

// ------------------------------------------------------------------------------------------------ install
let deferredPrompt = null;
const standaloneMql = typeof matchMedia === 'function' ? matchMedia('(display-mode: standalone)') : null;
export const isStandalone = () => !!(standaloneMql && standaloneMql.matches) || navigator.standalone === true;
export function isIosSafari() {
  const ua = navigator.userAgent || '';
  const ios = /iP(hone|ad|od)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios && /Safari\//.test(ua) && !/(CriOS|FxiOS|EdgiOS|OPiOS|GSA)\//.test(ua);
}
// 'prompt' (the browser offered installation), 'ios' (manual Add to Home Screen) or null (installed / not possible).
export function installMode() {
  if (isStandalone()) return null;
  if (deferredPrompt) return 'prompt';
  return isIosSafari() ? 'ios' : null;
}
const installChanged = () => window.dispatchEvent(new CustomEvent('parlance:install-state', { detail: { mode: installMode() } }));
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; installChanged(); });
window.addEventListener('appinstalled', () => { deferredPrompt = null; installChanged(); });
standaloneMql?.addEventListener?.('change', installChanged);

export async function installApp() {
  if (deferredPrompt) {
    const p = deferredPrompt;
    deferredPrompt = null; // a prompt can be shown once; the browser fires beforeinstallprompt again if dismissed
    installChanged();
    try { await p.prompt(); const choice = await p.userChoice; return choice && choice.outcome; } catch { return 'dismissed'; }
  }
  if (isIosSafari()) { iosInstructions(); return 'instructions'; }
  return 'unavailable';
}

const SHARE_ICON = '<svg class="pwa-share-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 11H5v10h14V11h-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
export function iosInstructions() {
  const d = document.createElement('dialog');
  d.className = 'ob-dialog';
  d.dataset.testid = 'ios-install';
  d.innerHTML = `<h2>Install Parlance</h2><p class="muted">Add Parlance to your Home Screen to open it like an app.</p>
    <ol class="pwa-steps"><li>Tap ${SHARE_ICON} <b>Share</b> in Safari's toolbar.</li><li>Scroll down and tap <b>Add to Home Screen</b>.</li><li>Tap <b>Add</b>.</li></ol>
    <div class="ob-dialog-actions"><button type="button" class="btn btn-primary" data-close>Done</button></div>`;
  const close = () => { d.close(); d.remove(); };
  d.querySelector('[data-close]').onclick = close;
  d.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  document.body.appendChild(d);
  d.showModal();
}

// ------------------------------------------------------------------------------------------------ service worker
let registration = null;
let reloading = false;
function showUpdate(worker) {
  const host = document.getElementById('toasts');
  if (!host || host.querySelector('[data-testid=pwa-update]')) return;
  const el = document.createElement('div');
  el.className = 'toast pwa-update';
  el.setAttribute('role', 'status');
  el.dataset.testid = 'pwa-update';
  el.innerHTML = '<span>New version available</span><button type="button" class="btn" data-testid="pwa-reload">Reload</button>';
  el.querySelector('button').onclick = () => {
    reloading = true;
    el.querySelector('button').disabled = true;
    worker.postMessage({ type: 'SKIP_WAITING' }); // the new worker takes over; controllerchange reloads the page
    setTimeout(() => location.reload(), 4000); // fallback if the browser never reports the change
  };
  host.appendChild(el);
}

export function registerServiceWorker() {
  if (!sw || !window.isSecureContext) return;
  sw.addEventListener('controllerchange', () => { if (reloading) location.reload(); });
  // A notification click in the service worker asks an open window to route to its deep link.
  sw.addEventListener('message', (e) => {
    const link = e.data && e.data.type === 'NAVIGATE' ? safeLink(e.data.link) : null;
    if (link) { history.pushState({}, '', link); window.dispatchEvent(new PopStateEvent('popstate')); }
  });
  sw.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then((reg) => {
    registration = reg;
    if (reg.waiting && sw.controller) showUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (w) w.addEventListener('statechange', () => { if (w.state === 'installed' && sw.controller) showUpdate(w); });
    });
    const check = () => reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    setInterval(check, 30 * 60000);
  }).catch(() => { /* service workers unavailable (private mode, blocked): the site works without one */ });
}

// Cache Storage holds only public static assets, but a shared device should keep nothing after sign-out.
export async function clearCaches() {
  if (typeof caches === 'undefined') return;
  try { for (const k of await caches.keys()) await caches.delete(k); } catch { /* storage unavailable */ }
}

// ------------------------------------------------------------------------------------------------ Web Push
export const webPushSupported = () => !!sw && typeof window.PushManager !== 'undefined' && typeof window.Notification !== 'undefined' && window.isSecureContext;
const b64uToBytes = (s) => { const t = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)); return Uint8Array.from(t, (c) => c.charCodeAt(0)); };
const sameKey = (a, b) => { if (!a) return false; const x = new Uint8Array(a); return x.length === b.length && x.every((v, i) => v === b[i]); };
async function swRegistration() {
  if (registration && registration.active) return registration;
  return Promise.race([sw.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('The service worker is not ready yet. Reload the page and try again.')), 10000))]);
}
export async function currentSubscription() {
  if (!webPushSupported()) return null;
  try { const reg = await sw.getRegistration('/'); return reg ? await reg.pushManager.getSubscription() : null; } catch { return null; }
}
export const thisDevice = () => { const v = local.get(PUSH_KEY); return v && v.uid === session.uid ? v.id : null; };
export function deviceLabel() {
  const ua = navigator.userAgent || '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iP(hone|ad|od)/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'this device';
  return `${browser} on ${os}`;
}
async function register(sub) {
  const j = sub.toJSON();
  const r = await api.addPushSubscription(session.uid, { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth }, expiration_time: j.expirationTime ?? null, label: deviceLabel() });
  local.set(PUSH_KEY, { uid: session.uid, id: r.subscription.id });
  return r.subscription;
}
export async function enableWebPush() {
  if (!webPushSupported()) throw new Error('This browser does not support push notifications.');
  const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications are blocked for this site. Allow them in your browser settings, then try again.');
  const reg = await swRegistration();
  const key = b64uToBytes((await api.pushPublicKey()).public_key);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options && sub.options.applicationServerKey, key)) { await sub.unsubscribe().catch(() => {}); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  return register(sub);
}
export async function disableWebPush() {
  const sub = await currentSubscription();
  if (sub && session.uid) { try { await api.removePushEndpoint(session.uid, sub.endpoint); } catch { /* already gone */ } }
  if (sub) await sub.unsubscribe().catch(() => {});
  local.set(PUSH_KEY, null);
}
// On each sign-in: re-send this browser's subscription (the push service may have rotated it), or drop one that
// belongs to another account so its notifications can never reach this user (the push service then answers 410 and
// the server deletes the old row).
async function syncPush() {
  if (!webPushSupported() || !session.uid) return;
  const mine = local.get(PUSH_KEY);
  const sub = await currentSubscription();
  if (!mine) return;
  if (mine.uid !== session.uid) { if (sub) await sub.unsubscribe().catch(() => {}); local.set(PUSH_KEY, null); return; }
  if (Notification.permission !== 'granted') { local.set(PUSH_KEY, null); return; }
  try { if (sub) await register(sub); else await enableWebPush(); } catch { /* retried on the next load */ }
}

// ------------------------------------------------------------------------------------------------ wiring
let lastUid = null;
export function initPwa() {
  registerServiceWorker();
  logoutHooks.push(() => disableWebPush());
  session.subscribe(() => {
    if (!session.loaded) return;
    const uid = session.uid || null;
    if (uid === lastUid) return;
    if (lastUid && !uid) clearCaches(); // signed out (here or elsewhere)
    lastUid = uid;
    if (uid) syncPush();
  });
}

// "Install app" entry for the ☰ menus (views/account-menu.js); '' when installation is not possible.
export const installMenuItem = () => (installMode() ? '<button type="button" data-install-app data-testid="menu-install">Install app</button>' : '');
