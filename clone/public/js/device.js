// Per-browser device ID and user-activity clock (PLAN P3.7 fraud signals, residual RS10; CLONE_SPEC §25).
// - Device ID: 128 random bits kept in localStorage and sent as X-Device-Id. The server stores only an HMAC of it. No
//   other fingerprinting (no canvas, fonts, plugins or hardware probing).
// - Activity: the time of the last real user interaction (pointer, key, touch, scroll, focus). Every API request sends
//   the seconds since then as X-Plx-Idle, so background polls do not keep an idle session alive.
const KEY = 'plx-device-id';
let id = null;
let lastActive = Date.now();

function randomId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function deviceId() {
  if (id) return id;
  try {
    id = localStorage.getItem(KEY);
    if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) { id = randomId(); localStorage.setItem(KEY, id); }
  } catch { id = id || randomId(); }
  return id;
}

export const idleSeconds = () => Math.max(0, Math.floor((Date.now() - lastActive) / 1000));
export function markActive() { lastActive = Date.now(); }

for (const ev of ['pointerdown', 'keydown', 'touchstart', 'wheel']) window.addEventListener(ev, markActive, { passive: true, capture: true });
window.addEventListener('focus', markActive);
document.addEventListener('visibilitychange', () => { if (!document.hidden) markActive(); });
