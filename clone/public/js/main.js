// App shell: router, header, category strip, live count polling (spec §3, §4.1).
import { session, queries, applyTheme, localTheme } from './store.js';
import { socket } from './ws.js';
import { api } from './api.js';
import { esc, money, CATEGORIES, catSlug } from './lib.js';
import * as home from './views/home.js';
import * as browse from './views/browse.js';
import * as eventView from './views/event.js';
import * as portfolio from './views/portfolio.js';
import * as watchlist from './views/watchlist.js';
import * as auth from './views/auth.js';


const routes = [
  [/^\/$/, home],
  [/^\/browse$/, browse],
  [/^\/search$/, browse],
  [/^\/category\/([^/]+)$/, browse, (m) => ({ category: m[1] })],
  [/^\/markets\/([^/]+)\/([^/]+)\/([^/]+)$/, eventView, (m) => ({ series: m[1], slug: m[2], event: m[3] })],
  [/^\/portfolio$/, portfolio],
  [/^\/watchlist$/, watchlist],
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
  const url = new URL(location.href);
  let match = null;
  for (const [re, mod, map] of routes) {
    const m = url.pathname.match(re);
    if (m) { match = { mod, params: map ? map(m) : {} }; break; }
  }
  renderCategoryStrip(url);
  markNav(url);
  if (!match) {
    view.innerHTML = `<div class="card empty"><h1>Page not found</h1><p class="muted">That page doesn't exist.</p><a class="btn" href="/" data-link>Go home</a></div>`;
    document.title = 'Not found · Parlance';
    return;
  }
  try {
    cleanup = await match.mod.render({ el: view, params: match.params, query: url.searchParams, navigate });
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="card empty" role="alert"><h1>${e.notFound ? 'Not found' : 'Something went wrong'}</h1><p class="muted">${esc(e.message)}</p><a class="btn" href="/" data-link>Go home</a></div>`;
  }
}

function renderCategoryStrip(url) {
  const strip = document.getElementById('category-strip');
  const current = url.pathname.startsWith('/category/') ? url.pathname.split('/')[2] : url.pathname === '/' ? 'trending' : null;
  strip.innerHTML = [`<a href="/" data-link class="${current === 'trending' ? 'active' : ''}">Trending</a>`,
    ...CATEGORIES.map((c) => `<a href="/category/${catSlug(c)}" data-link class="${current === catSlug(c) ? 'active' : ''}">${esc(c)}</a>`)].join('');
}

function markNav(url) {
  for (const a of document.querySelectorAll('.primary-nav a')) {
    const u = new URL(a.href);
    a.classList.toggle('active', u.pathname === url.pathname && u.search === url.search);
  }
}

function renderAccount() {
  const el = document.getElementById('account-area');
  const theme = document.documentElement.dataset.theme;
  const themeBtn = `<button class="icon-btn" id="theme-toggle" title="Toggle theme" aria-label="Toggle dark mode">${theme === 'dark' ? '☀' : '☾'}</button>`;
  if (!session.loaded) { el.innerHTML = themeBtn; }
  else if (!session.user) {
    el.innerHTML = `${themeBtn}<a class="btn" href="/sign-in" data-link>Log in</a><a class="btn btn-primary" href="/sign-up" data-link>Sign up</a>`;
  } else {
    el.innerHTML = `${themeBtn}<a class="balance-chip" href="/portfolio" data-link title="Available cash" data-testid="header-balance">${money(session.balance)}</a>
      <span class="faint" data-testid="header-user">${esc(session.user.display_name)}</span>
      <button class="btn btn-ghost" id="logout-btn">Log out</button>`;
  }
  el.querySelector('#theme-toggle').onclick = () => session.setProp('theme', document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  const lo = el.querySelector('#logout-btn');
  if (lo) lo.onclick = async () => { await session.logout(); navigate('/'); };
}

// Global link interception for client-side routing.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.target === '_blank') return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});
window.addEventListener('popstate', render);

document.getElementById('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = document.getElementById('search-input').value.trim();
  navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/browse');
});

// Live count: poll every 30 s, paused while hidden (spec §4.1).
queries.poll(['live_count'], api.liveCount, { interval: 30000, onData: (d) => { document.getElementById('live-count').textContent = d.count; } });

const banner = document.getElementById('conn-banner');
socket.onState((s) => { banner.hidden = s.connected; });

applyTheme(localTheme());
session.subscribe(renderAccount);
renderAccount();
session.load().then(() => { socket.connect(); render(); });
