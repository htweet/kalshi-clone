// App shell: router, header (nav, live count, notifications, account menu), category strip (spec §3, §4.1, §13.1).
import { t as tx, te } from './i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import './content/shell-strings.js';
import './content/errors-strings.js'; // error.<code> keys for API errors (CLONE_SPEC.md §32.3)
import { initContent, media } from './content-live.js'; // managed content: bundle, live updates, preview (§32.4)
import { vars, watchVars } from './dynstyle.js';
import { session, queries, applyTheme, localTheme } from './store.js';
import { socket } from './ws.js';
import { api } from './api.js';
import { esc, money, CATEGORIES, catSlug, catLabel, relTime, ICON, toast } from './lib.js';
import { setCurrency, onCurrency } from './currency.js'; // display currency (CLONE_SPEC.md §30)
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
import { menuHtml, wireMenu, guestMenuButton, guestMenuHtml, wireGuestMenu, categoryIndexButton, categoryIndexList } from './views/account-menu.js'; // ☰ menu, category index (§25.7)
import { initPwa, thisDevice } from './pwa.js'; // service worker, install, Web Push (CLONE_SPEC.md §31)
import { initFlags, loadFlags, routeFlagOff, unavailableHtml, renderPlayBanner, renderOpsBanner, onFlags, flagOn, playOn } from './flags.js'; // feature flags, play mode (CLONE_SPEC.md §33)
import { initLocale, flagsReady } from './locale.js'; // languages, Intl formatting, data saver, referral links (CLONE_SPEC.md §38)
import { initA11y } from './a11y.js'; // tab semantics on every tab list (WCAG 2.2 AA, CLONE_SPEC.md §38.6)
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
const heistView = lazy(() => import('./views/heist.js')); // Phase 5D Central Bank + Vault Heist (CLONE_SPEC.md §33)
const docsView = lazy(() => import('./views/docs.js')); // Phase 7 developer portal (CLONE_SPEC.md §35.9)
const statusView = lazy(() => import('./views/status.js')); // Phase 7 status page (CLONE_SPEC.md §35.10)
const waitlistView = lazy(() => import('./views/waitlist.js')); // Phase 7A real-money launch waitlist (CLONE_SPEC.md §36)
// Phase 7B elections hub v2 (CLONE_SPEC.md §37): /category/elections/<hub>; an unknown slug falls back to the category tag page.
const electionsView = { render: (ctx) => import('./views/elections.js').then((m) => m.render({ ...ctx, fallback: browse })) };

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
  [/^\/category\/elections\/([a-z0-9][a-z0-9-]{2,40})$/, electionsView, (m) => ({ hub: m[1] })],
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
  [/^\/heist$/, heistView],
  [/^\/incentives\/terms$/, incentivesView, () => ({ page: 'terms' })],
  [/^\/hubs\/([a-z]+)$/, hubsView, (m) => ({ hub: m[1] })],
  [/^\/ballot$/, hubsView, () => ({ hub: 'ballot' })],
  [/^\/docs$/, docsView],
  [/^\/docs\/reference\/([a-z0-9_]+)$/, docsView, (m) => ({ op: m[1] })],
  [/^\/docs\/([a-z-]+)$/, docsView, (m) => ({ page: m[1] })],
  [/^\/status$/, statusView],
  [/^\/waitlist$/, waitlistView, () => ({ page: 'main' })],
  [/^\/waitlist\/(confirm|unsubscribe|manage)$/, waitlistView, (m) => ({ page: m[1] })],
  [/^\/(trust|research|support|legal)\/([a-z0-9-]+)$/, placeholderView, (m) => ({ group: m[1], slug: m[2] })], // CMS pages (CLONE_SPEC.md §32.7)
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

// The page (path + query) the view was last drawn for: a fragment-only history step does not redraw it (below).
let drawnFor = null;
async function render() {
  drawnFor = location.pathname + location.search;
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
  const flagOff = match && routeFlagOff(url.pathname); // feature flags (CLONE_SPEC.md §33): CMS-managed "not available" state
  if (flagOff) { view.innerHTML = unavailableHtml(flagOff); return; }
  if (!match) {
    view.innerHTML = `<div class="empty center-60"><h1 class="typ-title-x10 m-0">${te('shell.render.page_not_found')}</h1><p class="muted m-0">${te('shell.render.that_page_doesn_t_exist')}</p><div><a class="btn" href="/" data-link>${te('shell.render.go_home')}</a></div></div>`;
    document.title = tx('shell.render.not_found_parlance');
    return;
  }
  try {
    cleanup = await match.mod.render({ el: view, params: match.params, query: url.searchParams, navigate });
  } catch (e) {
    console.error(e);
    const limit = e.code === 'session_time_limit_reached';
    view.innerHTML = `<div class="card empty" role="alert" data-testid="${limit ? 'session-limit' : 'page-error'}"><h1 class="typ-title-x20">${limit ? te('shell.render.daily_session_limit_reached') : e.notFound ? te('shell.render.not_found') : te('shell.render.something_went_wrong')}</h1><p class="muted">${esc(e.message)}</p><a class="btn" href="/" data-link>${te('shell.render.go_home')}</a></div>`;
  }
}

function renderCategoryStrip(url) {
  const strip = document.getElementById('category-strip');
  const p = url.pathname;
  const current = p.startsWith('/category/') ? p.split('/')[2] : p === '/' ? 'trending' : p === '/browse' && url.searchParams.get('order_by') === 'newest' ? 'new' : p === '/browse' ? 'all' : null;
  // Short labels on the strip; a featured hub sits after Trending (spec §15.1).
  strip.innerHTML = [
    categoryIndexButton(), // list icon → category index (CLONE_SPEC §13.16)
    `<a href="/" data-link class="${current === 'trending' ? 'active' : ''}">${te('shell.render_category_strip.trending')}</a>`,
    // Featured tab and category order / labels / visibility come from the CMS (defaults when unconfigured).
    `<a href="${esc(site.nav.featured.href)}" data-link class="featured ${site.nav.featured.color ? 'v-color ' : ''}${p === site.nav.featured.href || (current && site.nav.featured.href === `/category/${current}`) ? 'active' : ''}" data-testid="featured-tab"${vars({ '--color': site.nav.featured.color })}>${esc(site.nav.featured.label)}</a>`,
    `<a href="/browse?order_by=newest" data-link class="${current === 'new' ? 'active' : ''}">${te('shell.render_category_strip.new')}</a>`,
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
    : `<div class="empty faint">${te('shell.notif_list.no_notifications_yet')}</div>`;
}

// A full rebuild (content, currency or flag changes alter labels and which buttons show).
function rebuildAccount() { const el = document.getElementById('account-area'); if (el) el.dataset.sig = ''; renderAccount(); }
function renderAccount() {
  const el = document.getElementById('account-area');
  if (!session.loaded) { el.dataset.sig = ''; el.innerHTML = ''; return; }
  if (!session.user) {
    el.dataset.sig = '';
    el.innerHTML = `<a class="btn btn-pill btn-outline-brand" href="/sign-in" data-link>${te('shell.render_account.log_in')}</a><a class="btn btn-pill btn-primary" href="/sign-up" data-link>${te('shell.render_account.sign_up')}</a>${guestMenuButton()}`;
    const g = el.querySelector('#guest-btn'); // signed-out ☰, only while the app can be installed (CLONE_SPEC §31.6)
    if (g) g.onclick = (e) => { const m = toggleMenu(e.currentTarget, guestMenuHtml(), 'hamburger-menu'); if (m) wireGuestMenu(m, { close: closeMenus }); };
    return;
  }
  const nick = session.nickname || session.user.display_name;
  // Same user, name and mode: update the balance in place. Rebuilding the area on every session change (a balance push,
  // a profile load) would close an open bell or ☰ menu under the user's pointer.
  const sig = JSON.stringify([session.user.id, nick, session.user.display_name, playOn(), money(0)]);
  if (el.dataset.sig === sig && el.querySelector('[data-testid=header-balance]')) {
    el.querySelector('[data-testid=header-balance]').textContent = money(session.balance);
    drawBell();
    return;
  }
  el.dataset.sig = sig;
  el.innerHTML = `<a class="balance-chip${playOn() ? ' play' : ''}" href="/portfolio" data-link title="${te('shell.render_account.cash_available')}"><span class="label" data-testid="header-balance-label">${playOn() ? te('flags.play.cash') : te('shell.render_account.cash')}</span><span class="value" data-testid="header-balance">${money(session.balance)}</span></a>
    <div class="menu-wrap"><button class="icon-btn" id="bell-btn" data-menu-btn aria-label="${te('shell.render_account.notifications')}" data-testid="bell">${ICON.bell}</button></div>
    <a class="icon-btn messages-btn" href="/messages" data-link data-flag="social.group_chat" aria-label="${te('shell.render_account.group_chats')}" title="${te('shell.render_account.group_chats')}" data-testid="messages-btn">${ICON.chat}</a>
    <a class="icon-btn trophy-btn" href="/social/leaderboard" data-link data-flag="social" aria-label="${te('shell.render_account.leaderboard')}" title="${te('shell.render_account.leaderboard')}" data-testid="trophy">${ICON.trophy}</a>
    <div class="menu-wrap"><button class="icon-btn hamburger-btn" id="me-btn" data-menu-btn aria-label="${te('shell.render_account.menu')}" aria-haspopup="true" data-testid="account-menu">${ICON.menu}<span class="sr-only">${esc(nick)}</span></button></div>
    <span class="faint" data-testid="header-user" hidden>${esc(session.user.display_name)}</span>`;
  drawBell();
  el.querySelector('#bell-btn').onclick = async (e) => {
    const m = toggleMenu(e.currentTarget, `<div class="menu-head d-flex jc-between ai-center"><strong>${te('shell.render_account.notifications')}</strong><button class="btn btn-sm btn-ghost w-auto" id="read-all">${te('shell.render_account.mark_all_read')}</button></div><div id="notif-items"></div><a class="faint jc-center" href="/notifications" data-link>${te('shell.render_account.see_all')}</a>`, 'notif-menu');
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
    wireMenu(m, { close: closeMenus, navigate, logout: async () => { closeMenus(); if (await session.logout() !== false) navigate('/'); } });
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
  // [data-flag] entries hide while their feature flag is off (public/js/flags.js, CLONE_SPEC.md §33).
  toggleMenu(e.currentTarget, `<a href="/calendar" data-link>${te('shell.common.calendar')}</a><a href="/sports" data-link data-testid="more-sports" data-flag="sports">${te('shell.common.sports_scores')}</a><a href="/social" data-link data-flag="social" data-testid="more-social">${te('shell.common.social')}</a><a href="/messages" data-link data-testid="more-messages" data-flag="social.group_chat">${te('shell.common.group_chats')}</a><a href="/social/circle" data-link data-flag="social">${te('shell.common.inner_circle')}</a><a href="/social/leaderboard" data-link data-flag="social">${te('shell.common.leaderboard')}</a>
    <a href="/watchlist" data-link data-flag="watchlist" data-testid="more-watchlist">${te('shell.common.watchlist')}</a><a href="/browse" data-link>${te('shell.common.browse_all_markets')}</a><a href="/category/elections/nigeria-2027" data-link data-testid="more-election-hub" data-flag="elections.hub">${te('shell.common.elections_hub')}</a><a href="/hubs/economics" data-link data-testid="more-rates" data-flag="hubs">${te('shell.common.rates_outlook')}</a><a href="/incentives" data-link data-flag="incentives" data-testid="more-incentives">${te('shell.common.liquidity_rewards')}</a>${playOn() ? `<a href="/heist" data-link data-flag="heist" data-testid="more-heist">${te('shell.common.vault_heist')}</a>` : ''}<hr><a href="/account/limits" data-link>${te('shell.common.responsible_trading')}</a><button id="more-theme">${te('shell.common.toggle_light_dark')}</button>`);
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
// Back / forward re-renders the route. A step that changes only the #fragment (the "Skip to content" link, an in-page
// anchor) is the same page: the browser moves focus and scroll itself, and redrawing would wipe what the visitor has
// typed or opened (a half-filled deposit or a History filter would be lost; regression test in tests/a11y.e2e.test.js).
window.addEventListener('popstate', () => { if (location.pathname + location.search === drawnFor) return; render(); });

document.getElementById('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = document.getElementById('search-input').value.trim();
  navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/browse');
});

// Live count: poll every 30 s, paused while hidden (observed cadence, spec §13.5).
queries.poll(['live_count'], api.liveCount, { interval: 30000, onData: (d) => { document.getElementById('live-count').textContent = d.count; } });

const banner = document.getElementById('conn-banner');
// Data saver's polling fallback (ws.js, CLONE_SPEC.md §38.7) says so instead of "Reconnecting".
socket.onState((s) => {
  banner.hidden = s.connected && s.mode !== 'polling';
  banner.dataset.mode = s.mode || 'ws';
  banner.textContent = s.mode === 'polling' ? tx('shell.html.polling') : tx('shell.html.reconnecting');
});
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
  const m = toggleMenu(b, `<div class="cat-index" data-testid="category-index"><div class="faint">${te('shell.common.loading_categories')}</div></div>`, 'cat-index-menu');
  if (m) api.categories().then((r) => { m.innerHTML = categoryIndexList(r.categories); }).catch(() => { m.innerHTML = `<div class="faint">${te('shell.common.categories_are_unavailable')}</div>`; });
});
session.subscribe(renderAccount);
renderAccount();
// Admin › Currency & defaults: a change reaches every open page live and re-renders it (CLONE_SPEC.md §30).
socket.subscribe({ channels: ['display_currency'] }, (m) => { if (m.type === 'display_currency' && flagOn('currency_switch')) setCurrency(m.msg); });
let booted = false;
onCurrency(() => { rebuildAccount(); if (booted) render(); });
// Shell markup in index.html carries catalog keys (data-t / data-t-attr="attr:key;…"): filled from the catalog at boot
// and after every content change; the logo slot replaces the wordmark text when an admin sets one (CLONE_SPEC.md §32).
function applyShell() {
  for (const n of document.querySelectorAll('[data-t]')) n.textContent = tx(n.dataset.t);
  for (const n of document.querySelectorAll('[data-t-attr]')) for (const pair of n.dataset.tAttr.split(';')) { const [a, k] = pair.split(':'); if (a && k) n.setAttribute(a.trim(), tx(k.trim())); }
  const logo = media('logo'); const box = document.getElementById('brand-logo');
  if (box) {
    box.hidden = !logo;
    box.replaceChildren();
    if (logo) { const img = document.createElement('img'); img.src = logo.url; img.alt = logo.alt || ''; img.width = 28; img.height = 28; img.dataset.testid = 'brand-logo-img'; box.append(img); }
  }
}
applyShell();
initContent({ socket, onChange: () => { applyShell(); rebuildAccount(); if (booted) render(); } });
initPwa();
window.addEventListener('parlance:install-state', () => { if (!session.user) renderAccount(); }); // signed-out ☰ with "Install app"
initFlags({ socket, session });
initLocale();
initA11y();
onFlags(() => { renderPlayBanner(); renderOpsBanner(); rebuildAccount(); if (booted) render(); }); // a flag / play-mode / money-control change, live
Promise.all([session.load(), loadSite(), loadFlags()]).then(() => { booted = true; flagsReady(); renderPlayBanner(); renderOpsBanner(); renderAccount(); socket.connect(); render(); });
window.addEventListener('parlance:site-loaded', () => { if (session.loaded) renderCategoryStrip(new URL(location.href)); });
