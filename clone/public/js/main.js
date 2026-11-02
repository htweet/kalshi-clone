// App shell: router, header (nav, live count, notifications, account menu), category strip (spec §3, §4.1, §13.1).
import { session, queries, applyTheme, localTheme } from './store.js';
import { socket } from './ws.js';
import { api } from './api.js';
import { esc, money, CATEGORIES, catSlug, catLabel, avatar, relTime, ICON, toast } from './lib.js';
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

const routes = [
  [/^\/$/, home],
  [/^\/browse$/, browse],
  [/^\/live$/, calendar, () => ({ live: true })],
  [/^\/pro$/, pro],
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
  [/^\/portfolio$/, portfolio],
  [/^\/portfolio\/perps$/, perps, () => ({ mode: 'portfolio' })],
  [/^\/watchlist$/, watchlist],
  [/^\/notifications$/, notifications],
  [/^\/account$/, account, () => ({ section: 'profile' })],
  [/^\/account\/([a-z-]+)$/, account, (m) => ({ section: m[1] })],
  [/^\/sign-in$/, auth, () => ({ mode: 'sign-in' })],
  [/^\/sign-up$/, auth, () => ({ mode: 'sign-up' })],
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
  if (!match) {
    view.innerHTML = `<div class="empty" style="min-height:60vh;display:grid;place-content:center;gap:8px"><h1 class="typ-title-x10" style="margin:0">Page not found</h1><p class="muted" style="margin:0">That page doesn't exist.</p><div><a class="btn" href="/" data-link>Go home</a></div></div>`;
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
    `<a href="/" data-link class="${current === 'trending' ? 'active' : ''}">Trending</a>`,
    `<a href="/category/elections" data-link class="featured ${current === 'elections' ? 'active' : ''}" data-testid="featured-tab">Harbor 2026</a>`,
    `<a href="/browse?order_by=newest" data-link class="${current === 'new' ? 'active' : ''}">New</a>`,
    '<span class="sep" aria-hidden="true"></span>',
    ...CATEGORIES.map((c) => `<a href="/category/${catSlug(c)}" data-link class="${current === catSlug(c) ? 'active' : ''}">${esc(catLabel(c))}</a>`),
  ].join('');
}

function markNav(url) {
  const p = url.pathname;
  const key = p === '/live' || p === '/calendar' ? 'live' : p.startsWith('/perps') ? 'invest' : p === '/pro' ? 'pro' : (p === '/browse' || p.startsWith('/category') || p.startsWith('/markets')) ? 'markets' : '';
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
    el.innerHTML = `<a class="btn btn-pill btn-outline-brand" href="/sign-in" data-link>Log in</a><a class="btn btn-pill btn-primary" href="/sign-up" data-link>Sign up</a>`;
    return;
  }
  const nick = session.nickname || session.user.display_name;
  el.innerHTML = `<a class="balance-chip" href="/portfolio" data-link title="Cash available"><span class="label">Cash</span><span class="value" data-testid="header-balance">${money(session.balance)}</span></a>
    <div class="menu-wrap"><button class="icon-btn" id="bell-btn" data-menu-btn aria-label="Notifications" data-testid="bell">${ICON.bell}</button></div>
    <div class="menu-wrap"><button class="icon-btn" id="me-btn" data-menu-btn aria-label="Account menu" data-testid="account-menu">${avatar(nick)}</button></div>
    <span class="faint" data-testid="header-user" hidden>${esc(session.user.display_name)}</span>`;
  drawBell();
  el.querySelector('#bell-btn').onclick = async (e) => {
    const m = toggleMenu(e.currentTarget, '<div class="menu-head" style="display:flex;justify-content:space-between;align-items:center"><strong>Notifications</strong><button class="btn btn-sm btn-ghost" id="read-all" style="width:auto">Mark all read</button></div><div id="notif-items"></div><a class="faint" href="/notifications" data-link style="justify-content:center">See all</a>', 'notif-menu');
    if (!m) return;
    await loadNotifications();
    m.querySelector('#notif-items').innerHTML = notifList(notif.items.slice(0, 8));
    m.querySelector('#read-all').onclick = async () => { await api.readAll(session.uid); await loadNotifications(); m.querySelector('#notif-items').innerHTML = notifList(notif.items.slice(0, 8)); };
    m.addEventListener('click', (ev) => { const a = ev.target.closest('[data-nid]'); if (a) api.readNotification(session.uid, a.dataset.nid).then(loadNotifications).catch(() => {}); });
  };
  el.querySelector('#me-btn').onclick = (e) => {
    const dark = document.documentElement.dataset.theme === 'dark';
    const m = toggleMenu(e.currentTarget, `<div class="menu-head"><strong>${esc(session.user.display_name)}</strong><div class="faint">${session.nickname ? '@' + esc(session.nickname) : esc(session.user.email)}</div></div><hr>
      <a href="/portfolio" data-link>Portfolio</a><a href="/watchlist" data-link>Watchlist</a>
      ${session.nickname ? `<a href="/social/profile/${encodeURIComponent(session.nickname)}" data-link>My profile</a>` : '<a href="/account/profile" data-link>Create social profile</a>'}
      <a href="/notifications" data-link>Notifications</a><a href="/account" data-link>Account &amp; security</a>
      <button id="theme-toggle" data-testid="theme-toggle">${dark ? 'Light mode' : 'Dark mode'}</button><hr>
      <button id="logout-btn">Log out</button>`);
    if (!m) return;
    m.querySelector('#theme-toggle').onclick = () => { session.setProp('theme', dark ? 'light' : 'dark'); closeMenus(); };
    m.querySelector('#logout-btn').onclick = async () => { closeMenus(); await session.logout(); navigate('/'); };
  };
}

// MORE menu (spec §15.1): secondary destinations.
document.getElementById('more-btn').addEventListener('click', (e) => {
  toggleMenu(e.currentTarget, `<a href="/calendar" data-link>Calendar</a><a href="/social" data-link>Social</a><a href="/social/leaderboard" data-link>Leaderboard</a>
    <a href="/watchlist" data-link>Watchlist</a><a href="/browse" data-link>Browse all markets</a><hr><a href="/account/limits" data-link>Responsible trading</a><button id="more-theme">Toggle light / dark</button>`);
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

// Notifications arrive live on the private channel.
let unsubNotif = null;
session.subscribe(() => {
  if (session.user && !unsubNotif) {
    loadNotifications();
    unsubNotif = socket.subscribe({ channels: ['notifications'] }, (m) => {
      if (m.type !== 'notification') return;
      notif.items.unshift(m.msg); notif.unread += 1; drawBell();
      toast(m.msg.title);
      window.dispatchEvent(new CustomEvent('parlance:notification', { detail: m.msg }));
    });
  } else if (!session.user && unsubNotif) { unsubNotif(); unsubNotif = null; notif.unread = 0; notif.items = []; }
});

applyTheme(localTheme());
session.subscribe(renderAccount);
renderAccount();
session.load().then(() => { socket.connect(); render(); });
