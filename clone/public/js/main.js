// App shell: router, header (nav, live count, notifications, account menu), category strip (spec §3, §4.1, §13.1).
import { vars, watchVars } from './dynstyle.js';
import { session, queries, applyTheme, localTheme } from './store.js';
import { socket } from './ws.js';
import { api } from './api.js';
import { esc, money, CATEGORIES, catSlug, catLabel, relTime, ICON, toast } from './lib.js';
import * as home from './views/home.js';
import * as browse from './views/browse.js';
import * as eventView from './views/event.js';
import * as portfolio from './views/portfolio.js';
import * as watchlist from './views/watchlist.js';
import * as auth from './views/auth.js';
import * as calendar from './views/calendar.js';
import * as social from './views/social.js';
import * as account from './views/account.js';
import * as notifications from './views/notifications.js';
import * as pro from './views/pro.js';
import * as perps from './views/perps.js';
import * as combos from './views/combos.js';
import * as sports from './views/sports.js';
import { startLivePatcher } from './views/scoreboard.js';
import { site, loadSite, featureGate, helpView } from './views/admin/site.js';
import { initIdentityUi } from './views/onboarding.js'; // identity banner + compliance dialog (CLONE_SPEC.md §25)
import { menuHtml, wireMenu, guestMenuHtml, wireGuestMenu, categoryIndexButton, categoryIndexList } from './views/account-menu.js'; // ☰ menu, category index (§25.7)
import { initPwa, installMode, thisDevice } from './pwa.js'; // service worker, install, Web Push (CLONE_SPEC.md §31)
watchVars(); // strict style CSP (PLAN G13): data-vars -> CSS custom properties via the CSSOM (dynstyle.js)
// Admin panel is loaded on demand (public/js/views/admin.js).
const adminView = { render: (ctx) => import('./views/admin.js').then((m) => m.render(ctx)) };
// Phase 2 community pages (CLONE_SPEC.md §24), loaded on demand.
const groupsView = { render: (ctx) => import('./views/groups.js').then((m) => m.render(ctx)) };
const socialManageView = { render: (ctx) => import('./views/social-manage.js').then((m) => m.render(ctx)) };
const notifSettingsView = { render: (ctx) => import('./views/notification-settings.js').then((m) => m.render(ctx)) };
// Phase 3 views (CLONE_SPEC.md §25), loaded on demand; literal import()s so the bundler splits them.
const lazy = (load) => ({ render: (ctx) => load().then((m) => m.render(ctx)) });
const onboardingView = lazy(() => import('./views/onboarding.js'));
const docvPhoneView = lazy(() => import('./views/docv-phone.js'));
const identityPagesView = lazy(() => import('./views/identity-pages.js'));
const rewardsView = lazy(() => import('./views/rewards.js'));
const placeholderView = lazy(() => import('./views/placeholder.js'));
const fundsView = lazy(() => import('./views/funds.js')); // Phase 4 deposits / withdrawals, sandbox rails (CLONE_SPEC.md §26)
const hubsView = lazy(() => import('./views/hubs.js')); // Phase 5B hubs, Senate map, Fed outlook, ballot (CLONE_SPEC.md §29)
const incentivesView = lazy(() => import('./views/incentives.js')); // Phase 5B Liquidity Incentive Program (§29)

const routes = [
  [/^\/$/, home],
  [/^\/browse$/, browse],
  [/^\/live$/, calendar, () => ({ live: true })],
  [/^\/pro$/, pro],
  [/^\/combos$/, combos],
  [/^\/sports$/, sports],
  [/^\/sports\/([A-Za-z0-9]+)$/, sports, (m) => ({ league: m[1] })],
  [/^\/perps$/, perps, () => ({ mode: 'list' })],
  [/^\/perps\/categories\/([^/]+)$/, perps, (m) => ({ mode: 'list', assetClass: decodeURIComponent(m[1]) })],
  [/^\/perps\/([A-Za-z0-9]+)$/, perps, (m) => ({ mode: 'market', ticker: m[1].toUpperCase() })],
  [/^\/search$/, browse],
  [/^\/category\/([^/]+)$/, browse, (m) => ({ category: m[1] })],
  [/^\/category\/([^/]+)\/([^/]+)$/, browse, (m) => ({ category: m[1], tag: decodeURIComponent(m[2]) })],
  [/^\/markets\/([^/]+)\/([^/]+)\/([^/]+)$/, eventView, (m) => ({ series: m[1], slug: m[2], event: m[3] })],
  [/^\/calendar$/, calendar],
  [/^\/social$/, social, () => ({ tab: 'feed' })],
  [/^\/social\/leaderboard$/, social, () => ({ tab: 'leaderboard' })],
  [/^\/social\/profile\/([^/]+)$/, social, (m) => ({ tab: 'profile', nickname: decodeURIComponent(m[1]) })],
  [/^\/social\/post\/([A-Za-z0-9_-]+)$/, social, (m) => ({ tab: 'post', id: m[1] })],
  [/^\/social\/(circle|settings)$/, socialManageView, (m) => ({ tab: m[1] })],
  [/^\/messages$/, groupsView],
  [/^\/messages\/([A-Za-z0-9_-]+)$/, groupsView, (m) => ({ id: m[1] })],
  [/^\/notifications\/settings$/, notifSettingsView],
  [/^\/portfolio$/, portfolio],
  [/^\/portfolio\/perps$/, perps, () => ({ mode: 'portfolio' })],
  [/^\/watchlist$/, watchlist],
  [/^\/notifications$/, notifications],
  [/^\/account$/, account, () => ({ section: 'security' })],
  [/^\/account\/([a-z-]+)$/, account, (m) => ({ section: m[1] })],
  // Identity onboarding and document verification (CLONE_SPEC §13.14–§13.15) — full-screen pages.
  [/^\/sign-up\/identity$/, onboardingView],
  [/^\/verify\/m$/, docvPhoneView],
  [/^\/verify-email$/, identityPagesView, () => ({ page: 'verify-email' })],
  [/^\/forgot-password$/, identityPagesView, () => ({ page: 'forgot' })],
  [/^\/reset-password$/, identityPagesView, () => ({ page: 'reset' })],
  [/^\/oauth-web\/([a-z]+)\/callback$/, identityPagesView, (m) => ({ page: 'oauth', provider: m[1] })],
  [/^\/dev\/mailbox$/, identityPagesView, () => ({ page: 'mailbox' })],
  [/^\/rewards$/, rewardsView],
  [/^\/funds$/, fundsView, () => ({ mode: 'overview' })],
  [/^\/funds\/(deposit|withdraw)$/, fundsView, (m) => ({ mode: m[1] })],
  [/^\/funds\/challenge\/([A-Za-z0-9_-]+)$/, fundsView, (m) => ({ mode: 'challenge', id: m[1] })],
  [/^\/incentives$/, incentivesView],
  [/^\/incentives\/terms$/, incentivesView, () => ({ page: 'terms' })],
  [/^\/hubs\/([a-z]+)$/, hubsView, (m) => ({ hub: m[1] })],
  [/^\/ballot$/, hubsView, () => ({ hub: 'ballot' })],
  [/^\/(docs)$/, placeholderView, (m) => ({ slug: m[1] })],
  [/^\/(trust|research|support)\/([a-z-]+)$/, placeholderView, (m) => ({ group: m[1], slug: m[2] })],
  [/^\/sign-in$/, auth, () => ({ mode: 'sign-in' })],
  [/^\/sign-up$/, auth, () => ({ mode: 'sign-up' })],
  [/^\/setup$/, auth, () => ({ mode: 'setup' })], // first-admin setup link (CLONE_SPEC §22.5)
  [/^\/admin(?:\/(.*))?$/, adminView, (m) => ({ path: m[1] || '' })],
  [/^\/help\/([a-z0-9-]+)$/, helpView, (m) => ({ slug: m[1] })],
];

let cleanup = null;
const view = document.getElementById('view');

export function navigate(href, { replace = false } = {}) {
  if (replace) history.replaceState({}, '', href); else history.pushState({}, '', href);
  render();
  window.scrollTo(0, 0);
}

async function render() {
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  closeMenus();
  const url = new URL(location.href);
  let match = null;
  for (const [re, mod, map] of routes) {
    const m = url.pathname.match(re);
    if (m) { match = { mod, params: map ? map(m) : {} }; break; }
  }
  renderCategoryStrip(url);
  markNav(url);
  const gated = match && featureGate(url.pathname); // admin feature switches (views/admin/site.js)
  if (gated) { view.innerHTML = gated; return; }
  if (!match) {
    view.innerHTML = `<div class="empty center-60"><h1 class="typ-title-x10 m-0">Page not found</h1><p class="muted m-0">That page doesn't exist.</p><div><a class="btn" href="/" data-link>Go home</a></div></div>`;
    document.title = 'Not found · Parlance';
    return;
  }
  try {
    cleanup = await match.mod.render({ el: view, params: match.params, query: url.searchParams, navigate });
  } catch (e) {
    console.error(e);
    const limit = e.code === 'session_time_limit_reached';
    view.innerHTML = `<div class="card empty" role="alert" data-testid="${limit ? 'session-limit' : 'page-error'}"><h1 class="typ-title-x20">${limit ? 'Daily session limit reached' : e.notFound ? 'Not found' : 'Something went wrong'}</h1><p class="muted">${esc(e.message)}</p><a class="btn" href="/" data-link>Go home</a></div>`;
  }
}

function renderCategoryStrip(url) {
  const strip = document.getElementById('category-strip');
  const p = url.pathname;
  const current = p.startsWith('/category/') ? p.split('/')[2] : p === '/' ? 'trending' : p === '/browse' && url.searchParams.get('order_by') === 'newest' ? 'new' : p === '/browse' ? 'all' : null;
  // Short labels on the strip; a featured hub sits after Trending (spec §15.1).
  strip.innerHTML = [
    categoryIndexButton(), // list icon → category index (CLONE_SPEC §13.16)
    `<a href="/" data-link class="${current === 'trending' ? 'active' : ''}">Trending</a>`,
    // Featured tab and category order / labels / visibility come from the CMS (defaults when unconfigured).
    `<a href="${esc(site.nav.featured.href)}" data-link class="featured ${site.nav.featured.color ? 'v-color ' : ''}${p === site.nav.featured.href || (current && site.nav.featured.href === `/category/${current}`) ? 'active' : ''}" data-testid="featured-tab"${vars({ '--color': site.nav.featured.color })}>${esc(site.nav.featured.label)}</a>`,
    `<a href="/browse?order_by=newest" data-link class="${current === 'new' ? 'active' : ''}">New</a>`,
    '<span class="sep" aria-hidden="true"></span>',
    ...(site.nav.categories || CATEGORIES.map((name) => ({ name }))).filter((c) => !c.hidden).map(({ name: c, label }) => `<a href="/category/${catSlug(c)}" data-link class="${current === catSlug(c) ? 'active' : ''}">${esc(label || catLabel(c))}</a>`),
  ].join('');
}

function markNav(url) {
  const p = url.pathname;
  const key = p === '/live' || p === '/calendar' || p === '/combos' ? 'live' : p.startsWith('/perps') ? 'invest' : p === '/pro' ? 'pro' : (p === '/browse' || p.startsWith('/category') || p.startsWith('/markets')) ? 'markets' : '';
  for (const a of document.querySelectorAll('.primary-nav a')) a.classList.toggle('active', a.dataset.nav === key);
}

// ---------- header: notifications + account menu ----------
const notif = { unread: 0, items: [], loaded: false };
let openMenu = null;
function closeMenus() { if (openMenu) { openMenu.remove(); openMenu = null; } }
document.addEventListener('click', (e) => { if (openMenu && !e.target.closest('.menu') && !e.target.closest('[data-menu-btn]')) closeMenus(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });

async function loadNotifications() {
  if (!session.user) return;
  try { const r = await api.notifications(session.uid); notif.items = r.notifications; notif.unread = r.unread_count; notif.loaded = true; drawBell(); } catch { /* ignore */ }
}
function drawBell() {
  const b = document.querySelector('#bell-btn');
  if (!b) return;
  b.querySelector('.dot-count')?.remove();
  if (notif.unread) b.insertAdjacentHTML('beforeend', `<span class="dot-count" data-testid="unread-count">${notif.unread > 99 ? '99+' : notif.unread}</span>`);
}
function toggleMenu(btn, html, cls = '') {
  if (openMenu && openMenu.dataset.owner === btn.id) { closeMenus(); return null; }
  closeMenus();
  const m = document.createElement('div');
  m.className = `menu ${cls}`;
  m.dataset.owner = btn.id;
  // eslint-disable-next-line parlance/no-unescaped-html -- menu markup comes from the header builders in this file (templates checked by this rule)
  m.innerHTML = html;
  btn.parentElement.appendChild(m);
  openMenu = m;
  return m;
}
function notifList(items) {
  return items.length ? items.map((n) => `<a class="notif ${n.read ? '' : 'unread'}" href="${esc(n.link || '/notifications')}" data-link data-nid="${esc(n.id)}"><span class="ind"></span><span><div class="t">${esc(n.title)}</div><div class="faint">${esc(n.body)}</div></span><span class="faint">${relTime(n.created_time)}</span></a>`).join('')
    : '<div class="empty faint">No notifications yet.</div>';
}

function renderAccount() {
  const el = document.getElementById('account-area');
  if (!session.loaded) { el.innerHTML = ''; return; }
  if (!session.user) {
    el.innerHTML = `<a class="btn btn-pill btn-outline-brand" href="/sign-in" data-link>Log in</a><a class="btn btn-pill btn-primary" href="/sign-up" data-link>Sign up</a>${installMode() ? `<div class="menu-wrap"><button class="icon-btn hamburger-btn" id="guest-btn" data-menu-btn aria-label="Menu" aria-haspopup="true" data-testid="guest-menu">${ICON.menu}</button></div>` : ''}`;
    const g = el.querySelector('#guest-btn');
    if (g) g.onclick = (e) => { const m = toggleMenu(e.currentTarget, guestMenuHtml(), 'hamburger-menu'); if (m) wireGuestMenu(m, { close: closeMenus, toggleTheme: () => { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; applyTheme(next); try { localStorage.setItem('parlance-theme', next); } catch { /* ignore */ } } }); };
    return;
  }
  const nick = session.nickname || session.user.display_name;
  el.innerHTML = `<a class="balance-chip" href="/portfolio" data-link title="Cash available"><span class="label">Cash</span><span class="value" data-testid="header-balance">${money(session.balance)}</span></a>
    <div class="menu-wrap"><button class="icon-btn" id="bell-btn" data-menu-btn aria-label="Notifications" data-testid="bell">${ICON.bell}</button></div>
    <a class="icon-btn messages-btn" href="/messages" data-link aria-label="Group chats" title="Group chats" data-testid="messages-btn">${ICON.chat}</a>
    <a class="icon-btn trophy-btn" href="/social/leaderboard" data-link aria-label="Leaderboard" title="Leaderboard" data-testid="trophy">${ICON.trophy}</a>
    <div class="menu-wrap"><button class="icon-btn hamburger-btn" id="me-btn" data-menu-btn aria-label="Menu" aria-haspopup="true" data-testid="account-menu">${ICON.menu}<span class="sr-only">${esc(nick)}</span></button></div>
    <span class="faint" data-testid="header-user" hidden>${esc(session.user.display_name)}</span>`;
  drawBell();
  el.querySelector('#bell-btn').onclick = async (e) => {
    const m = toggleMenu(e.currentTarget, '<div class="menu-head d-flex jc-between ai-center"><strong>Notifications</strong><button class="btn btn-sm btn-ghost w-auto" id="read-all">Mark all read</button></div><div id="notif-items"></div><a class="faint jc-center" href="/notifications" data-link>See all</a>', 'notif-menu');
    if (!m) return;
    await loadNotifications();
    m.querySelector('#notif-items').innerHTML = notifList(notif.items.slice(0, 8));
    m.querySelector('#read-all').onclick = async () => { await api.readAll(session.uid); await loadNotifications(); m.querySelector('#notif-items').innerHTML = notifList(notif.items.slice(0, 8)); };
    m.addEventListener('click', (ev) => { const a = ev.target.closest('[data-nid]'); if (a) api.readNotification(session.uid, a.dataset.nid).then(loadNotifications).catch(() => {}); });
  };
  // ☰ menu (CLONE_SPEC §13.16): Leaderboard / Rewards, the account destinations, Trust / Research / Support groups,
  // Enter promo code, Log out (views/account-menu.js).
  el.querySelector('#me-btn').onclick = (e) => {
    const m = toggleMenu(e.currentTarget, menuHtml(), 'hamburger-menu');
    if (!m) return;
    wireMenu(m, { close: closeMenus, navigate, logout: async () => { closeMenus(); await session.logout(); navigate('/'); } });
  };
}

// Push notifications in this browser (Settings › Notifications › "Push in this browser"): shown only when this browser
// registered as a push device and the user granted the Notification permission (views/notification-settings.js).
function showBrowserPush(p) {
  let id = null;
  try { id = localStorage.getItem('plx-push-device'); } catch { /* storage unavailable */ }
  if (!id || !Array.isArray(p.devices) || !p.devices.includes(id)) return;
  window.dispatchEvent(new CustomEvent('parlance:push', { detail: p }));
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || thisDevice()) return; // Web Push shows it instead
  try { const n = new Notification(String(p.title || 'Parlance'), { body: String(p.body || ''), tag: String(p.id || '') }); n.onclick = () => { window.focus(); if (p.link && String(p.link).startsWith('/')) navigate(p.link); }; } catch { /* not supported */ }
}

// MORE menu (spec §15.1): secondary destinations.
document.getElementById('more-btn').addEventListener('click', (e) => {
  toggleMenu(e.currentTarget, `<a href="/calendar" data-link>Calendar</a><a href="/sports" data-link data-testid="more-sports">Sports scores</a><a href="/social" data-link>Social</a><a href="/messages" data-link data-testid="more-messages">Group chats</a><a href="/social/circle" data-link>Inner Circle</a><a href="/social/leaderboard" data-link>Leaderboard</a>
    <a href="/watchlist" data-link>Watchlist</a><a href="/browse" data-link>Browse all markets</a><a href="/hubs/elections" data-link data-testid="more-election-hub">Harbor 2026 hub</a><a href="/hubs/economics" data-link data-testid="more-rates">Rates outlook</a><a href="/incentives" data-link>Liquidity rewards</a><hr><a href="/account/limits" data-link>Responsible trading</a><button id="more-theme">Toggle light / dark</button>`);
  const t = document.getElementById('more-theme');
  if (t) t.onclick = () => { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; if (session.user) session.setProp('theme', next); else { applyTheme(next); try { localStorage.setItem('parlance-theme', next); } catch { /* ignore */ } } closeMenus(); };
});

// Global link interception for client-side routing.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.target === '_blank') return;
  e.preventDefault();
  closeMenus();
  navigate(a.getAttribute('href'));
});
window.addEventListener('popstate', render);

document.getElementById('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = document.getElementById('search-input').value.trim();
  navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/browse');
});

// Live count: poll every 30 s, paused while hidden (observed cadence, spec §13.5).
queries.poll(['live_count'], api.liveCount, { interval: 30000, onData: (d) => { document.getElementById('live-count').textContent = d.count; } });

const banner = document.getElementById('conn-banner');
socket.onState((s) => { banner.hidden = s.connected; });
startLivePatcher(view); // live sports scores on every page (views/scoreboard.js)

// Notifications arrive live on the private channel.
let unsubNotif = null;
session.subscribe(() => {
  if (session.user && !unsubNotif) {
    loadNotifications();
    unsubNotif = socket.subscribe({ channels: ['notifications'] }, (m) => {
      if (m.type !== 'notification' && m.type !== 'push') return;
      if (m.type === 'push') { showBrowserPush(m.msg); return; } // push channel (server/notify-prefs.js)
      notif.items.unshift(m.msg); notif.unread += 1; drawBell();
      if (!m.msg.quiet) toast(m.msg.title); // quiet hours: stored in the inbox without a toast
      window.dispatchEvent(new CustomEvent('parlance:notification', { detail: m.msg }));
    });
  } else if (!session.user && unsubNotif) { unsubNotif(); unsubNotif = null; notif.unread = 0; notif.items = []; }
});

applyTheme(localTheme());
initIdentityUi();
document.getElementById('category-strip').addEventListener('click', (e) => {
  const b = e.target.closest('[data-category-index]');
  if (!b) return;
  e.preventDefault();
  const m = toggleMenu(b, '<div class="cat-index" data-testid="category-index"><div class="faint">Loading categories…</div></div>', 'cat-index-menu');
  if (m) api.categories().then((r) => { m.innerHTML = categoryIndexList(r.categories); }).catch(() => { m.innerHTML = '<div class="faint">Categories are unavailable.</div>'; });
});
session.subscribe(renderAccount);
renderAccount();
initPwa();
window.addEventListener('parlance:install-state', () => { if (!session.user) renderAccount(); }); // signed-out ☰ with "Install app"
Promise.all([session.load(), loadSite()]).then(() => { socket.connect(); render(); });
window.addEventListener('parlance:site-loaded', () => { if (session.loaded) renderCategoryStrip(new URL(location.href)); });
