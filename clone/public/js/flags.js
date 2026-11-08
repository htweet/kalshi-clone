// Feature flags on the client (CLONE_SPEC.md §33). The server evaluates every flag for this visitor (rollout, allow /
// deny lists, region, schedule) and sends booleans only: GET /v1/feature_flags. The public `feature_flags` WebSocket
// channel nudges every open page when an admin changes a flag (and the per-user form when this account's deposit /
// withdrawal controls change); the page refetches its own bundle, re-applies the UI and re-renders the route.
//   flagOn(key)          the evaluated flag (true until the bundle has loaded: the server enforces it anyway)
//   [data-flag]          elements hidden while any of the space-separated flags listed is off (every inserted node)
//   routeFlagOff(path)   the flag that switches the page at `path` off, or null
//   unavailableHtml(key) the CMS-managed "not available" state
// The bundle also carries play mode ({on}) and this account's money controls (deposits / withdrawals allowed, reason).
import { t, te } from './i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import './content/flags-strings.js';
import { request } from './api.js';
import { esc } from './lib.js';

export const flagState = { flags: {}, play_mode: { on: false }, money: null, version: 0, loaded: false };
export const flagOn = (key) => flagState.flags[key] !== false;
export const playOn = () => !!flagState.play_mode?.on;
const listeners = new Set();
export const onFlags = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

// Pages per flag (the server answers feature_disabled for their API calls; this shows the managed state instead).
const ROUTE_FLAGS = [
  [/^\/(perps|portfolio\/perps)(\/|$)/, 'perps'], [/^\/combos$/, 'combos'], [/^\/sports(\/|$)/, 'sports'],
  [/^\/social(\/|$)/, 'social'], [/^\/messages(\/|$)/, 'social.group_chat'], [/^\/watchlist$/, 'watchlist'], [/^\/ballot$/, 'ballot'], [/^\/hubs\//, 'hubs'],
  [/^\/incentives(\/|$)/, 'incentives'], [/^\/rewards$/, 'rewards'], [/^\/sign-up$/, 'accounts.signup'], [/^\/sign-up\/identity$/, 'identity.kyc'], [/^\/verify\/m$/, 'identity.kyc'],
  [/^\/funds\/deposit$/, 'payments.deposits'], [/^\/funds\/withdraw$/, 'payments.withdrawals'], [/^\/heist$/, 'heist'],
  [/^\/docs(\/|$)/, 'developer_portal'], [/^\/status$/, 'status_page'], [/^\/account\/api-keys$/, 'api.keys'], // Phase 7 (CLONE_SPEC.md §35)
  [/^\/waitlist(\/confirm)?$/, 'waitlist.launch'], // Phase 7A (CLONE_SPEC.md §36); /waitlist/unsubscribe and /manage always work
  [/^\/category\/elections\/[a-z0-9][a-z0-9-]{2,40}$/, 'elections.hub'], // Phase 7B (CLONE_SPEC.md §37)
];
export function routeFlagOff(pathname) {
  const hit = ROUTE_FLAGS.find(([re, k]) => re.test(pathname) && !flagOn(k));
  return hit ? hit[1] : null;
}
const featureName = (key) => { const k = `flags.feature.${key}`; const v = t(k); return v === k ? t('flags.feature.default') : v; };
export function unavailableHtml(key) {
  return `<div class="card empty center-40" role="status" data-testid="feature-unavailable" data-feature="${esc(key)}"><h1 class="typ-title-x20 m-0">${te('flags.unavailable.title', { feature: esc(featureName(key)) })}</h1>
    <p class="muted m-0">${te('flags.unavailable.body')}</p><div><a class="btn" href="/" data-link>${te('flags.unavailable.home')}</a></div></div>`;
}

// Hide / show [data-flag] elements. A class (not the hidden attribute) so components with their own display rules hide too.
export function applyFlags(root = document) {
  const els = root.querySelectorAll ? root.querySelectorAll('[data-flag]') : [];
  const one = (el) => el.classList.toggle('flag-off', !String(el.dataset.flag).split(/\s+/).filter(Boolean).every(flagOn));
  if (root.dataset && root.dataset.flag) one(root);
  for (const el of els) one(el);
}
let observer = null;
function observe() {
  if (observer || typeof MutationObserver === 'undefined') return;
  observer = new MutationObserver((list) => { for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) applyFlags(n); });
  observer.observe(document.body, { childList: true, subtree: true });
}

let timer = null;
export async function loadFlags() {
  try {
    const r = await request('GET', '/v1/feature_flags');
    flagState.flags = r.flags || {}; flagState.version = r.version || 0;
    flagState.play_mode = r.play_mode || { on: false }; flagState.money = r.money || null;
    clearTimeout(timer);
    // A scheduled start or end changes the evaluation without an admin action: refetch at that moment.
    if (r.next_change_time) { const ms = Date.parse(r.next_change_time) - Date.now(); if (ms > 0 && ms < 2 ** 31 - 1) timer = setTimeout(() => refresh(), ms + 250); }
  } catch { /* keep the last bundle */ }
  flagState.loaded = true;
  document.documentElement.classList.toggle('play-mode', playOn());
  applyFlags(document);
}
async function refresh() {
  await loadFlags();
  for (const fn of listeners) { try { fn(flagState); } catch (e) { console.error(e); } }
}
export function initFlags({ socket, session }) {
  observe();
  socket.subscribe({ channels: ['feature_flags'] }, (m) => { if (m.type === 'feature_flags') refresh(); });
  let lastUid;
  session.subscribe(() => { if (!session.loaded) return; const uid = session.uid || null; if (uid !== lastUid) { const first = lastUid === undefined; lastUid = uid; if (!first) refresh(); } });
}
// Play-money banner (CMS texts), shown on every page while play mode is on.
export function renderPlayBanner() {
  document.querySelectorAll('.play-banner').forEach((b) => b.remove());
  if (!playOn()) return;
  const heist = flagOn('heist') ? ` <a href="/heist" data-link data-testid="play-banner-heist">${te('flags.play.banner_link')}</a>` : '';
  const wl = ` <a href="/waitlist?src=banner" data-link data-flag="waitlist.launch" data-testid="waitlist-cta-banner">${te('flags.waitlist.banner_cta')}</a>`; // Phase 7A (§36)
  document.querySelector('header.topbar')?.insertAdjacentHTML('afterend', `<div class="play-banner" role="status" data-testid="play-banner"><div class="container"><span class="play-chip">${te('flags.play.label')}</span> <span>${te('flags.play.banner')}</span>${heist}${wl}</div></div>`);
}
// "Join the real-money waitlist" card on Funds and Home (CLONE_SPEC.md §36): play mode only, hidden by its flag.
export const waitlistCta = (where) => (playOn() ? `<a class="card wl-cta" href="/waitlist?src=${where === 'home' ? 'home' : 'funds'}" data-link data-flag="waitlist.launch" data-testid="waitlist-cta-${where === 'home' ? 'home' : 'funds'}"><span class="overline">${te('flags.waitlist.cta_overline')}</span><b>${te('flags.waitlist.cta_title')}</b><span class="faint">${te('flags.waitlist.cta_body')}</span></a>` : '');
export const playLabel = () => (playOn() ? `<span class="play-chip" data-testid="play-label">${te('flags.play.label')}</span>` : '');
