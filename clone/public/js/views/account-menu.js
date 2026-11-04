// Header ☰ menu and category index (CLONE_SPEC §13.16; CLONE_SPEC.md §25.7). Menu order follows the observed one:
// two round icon buttons (Leaderboard, Rewards), the account destinations, collapsible Trust / Research / Support
// groups, "Enter promo code" and "Log out". Destinations whose feature belongs to a later phase open a placeholder page
// that says so (views/placeholder.js). Staff also get "Admin"; a quick light/dark switch stays for convenience.
import { session, applyTheme } from '../store.js';
import { idApi } from '../identity-api.js';
import { esc, toast, money, catSlug, catLabel, ICON } from '../lib.js';
import { installMenuItem, installApp, installMode } from '../pwa.js'; // "Install app" (CLONE_SPEC.md §31)
import { t } from '../content/pwa-strings.js';

const ITEMS = [
  ['/account', 'Account & security', 'menu-account'], ['/account/activity', 'Your activity', 'menu-activity'], ['/perps', 'Invest', 'menu-invest'],
  ['/incentives', 'Liquidity Rewards', 'menu-incentives'], ['/account/taxes', 'Documents', 'menu-documents'], ['/docs', 'API Docs', 'menu-api-docs'],
  ['/account/settings', 'Settings', 'menu-settings'],
];
export const GROUPS = [
  ['trust', 'Trust', [['security', 'Security'], ['privacy', 'Privacy'], ['regulation', 'Regulation']]],
  ['research', 'Research', [['blog', 'Blog'], ['data', 'Market data'], ['papers', 'Papers']]],
  ['support', 'Support', [['help-center', 'Help center'], ['contact', 'Contact support'], ['fees', 'Fee schedule']]],
];

export function menuHtml() {
  const u = session.user;
  const staff = u.is_admin || (u.admin_roles || []).length;
  const dark = document.documentElement.dataset.theme === 'dark';
  return `<div class="menu-head"><strong>${esc(u.display_name)}</strong><div class="faint">${session.nickname ? '@' + esc(session.nickname) : esc(u.email)}</div></div>
    <div class="menu-round"><a href="/social/leaderboard" data-link data-testid="menu-leaderboard"><span class="round-ic">${ICON.trophy}</span>Leaderboard</a><a href="/rewards" data-link data-testid="menu-rewards"><span class="round-ic">${ICON.gift}</span>Rewards</a></div>
    ${ITEMS.map(([href, label, id]) => `<a href="${href}" data-link data-testid="${id}">${esc(label)}</a>`).join('')}
    <a href="/portfolio" data-link>Portfolio</a>
    <a href="/funds" data-link data-testid="menu-transfers">Deposit &amp; withdraw</a>
    ${staff ? '<a href="/admin" data-link data-testid="admin-link">Admin</a>' : ''}
    <hr>
    ${GROUPS.map(([key, label, links]) => `<details class="menu-group" data-testid="menu-group-${key}"><summary>${esc(label)}</summary>${links.map(([slug, l]) => `<a href="/${esc(key)}/${esc(slug)}" data-link>${esc(l)}</a>`).join('')}</details>`).join('')}
    <hr>
    <button id="promo-btn" data-testid="menu-promo">Enter promo code</button>
    ${installMenuItem()}
    <button id="theme-toggle" data-testid="theme-toggle">${dark ? 'Light mode' : 'Dark mode'}</button>
    <button id="logout-btn" data-testid="menu-logout">Log out</button>`;
}

export function wireMenu(m, { close, logout }) {
  const dark = document.documentElement.dataset.theme === 'dark';
  m.querySelector('#theme-toggle').onclick = () => { session.setProp('theme', dark ? 'light' : 'dark'); close(); };
  m.querySelector('#logout-btn').onclick = logout;
  m.querySelector('#promo-btn').onclick = () => { close(); promoDialog(); };
  wireInstall(m, close);
}
const wireInstall = (m, close) => { const b = m.querySelector('[data-install-app]'); if (b) b.onclick = () => { close(); installApp(); }; };

// Signed-out ☰ menu: shown only while the app can be installed (CLONE_SPEC.md §31); Log in / Sign up stay in the header.
export const guestMenuButton = () => (installMode() ? `<div class="menu-wrap"><button class="icon-btn hamburger-btn" id="guest-btn" data-menu-btn aria-label="${esc(t('install.menu_label'))}" aria-haspopup="true" data-testid="guest-menu">${ICON.menu}</button></div>` : '');
export function guestMenuHtml() {
  const dark = document.documentElement.dataset.theme === 'dark';
  return `${installMenuItem()}<a href="/sign-in" data-link>${esc(t('install.guest_log_in'))}</a><a href="/sign-up" data-link>${esc(t('install.guest_sign_up'))}</a><hr><button id="guest-theme" data-testid="guest-theme">${esc(t(dark ? 'install.guest_light' : 'install.guest_dark'))}</button>`;
}
export function wireGuestMenu(m, { close }) {
  wireInstall(m, close);
  m.querySelector('#guest-theme').onclick = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('parlance-theme', next); } catch { /* storage unavailable */ }
    close();
  };
}

// "Enter promo code" (A12): server-validated, single use per account, credited to the balance as a ledger credit.
export function promoDialog() {
  const d = document.createElement('dialog');
  d.className = 'ob-dialog';
  d.dataset.testid = 'promo-dialog';
  d.innerHTML = `<form method="dialog" novalidate><h2>Enter promo code</h2><p class="muted">Codes add a credit to your cash balance. Each code works once per account.</p>
    <label class="field">Promo code<input name="code" maxlength="32" autocomplete="off" autocapitalize="characters" spellcheck="false" required data-testid="promo-input"></label>
    <div class="form-error" role="alert" data-testid="promo-error"></div>
    <div class="ob-dialog-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn btn-primary" data-testid="promo-submit">Apply</button></div></form>`;
  const f = d.querySelector('form');
  const close = () => { d.close(); d.remove(); };
  d.querySelector('[data-close]').onclick = close;
  d.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = f.querySelector('[data-testid=promo-error]');
    const btn = f.querySelector('[type=submit]');
    err.textContent = ''; btn.disabled = true;
    try {
      const r = await idApi.redeemPromo(session.uid, f.code.value.trim());
      session.balance = r.balance_dollars; session.notify();
      toast(`Promo code applied: ${money(r.amount_dollars)} credit`);
      close();
    } catch (ex) {
      if (ex.code === 'identity_verification_required') { close(); return; } // the compliance dialog explains
      err.textContent = ex.code === 'promo_invalid' ? 'That code isn’t valid. Check it and try again.' : ex.code === 'promo_already_redeemed' ? 'You already used this code.' : ex.code === 'promo_exhausted' ? 'This code has been fully redeemed.' : ex.message;
      btn.disabled = false;
    }
  };
  document.body.appendChild(d);
  d.showModal();
  f.code.focus();
}

// Category index (list icon at the start of the category strip).
export const categoryIndexButton = () => `<span class="menu-wrap cat-index-wrap"><button class="cat-index-btn" id="cat-index-btn" data-category-index data-menu-btn aria-label="All categories" aria-haspopup="true" data-testid="category-index-btn">${ICON.catIndex}</button></span>`;
export function categoryIndexList(cats = []) {
  return `<div class="cat-index" data-testid="category-index"><h3>All categories</h3><div class="cat-index-grid">${cats.map((c) => `<div class="cat-index-col"><a class="cat-index-head" href="/category/${esc(catSlug(c.name))}" data-link>${esc(catLabel(c.name))}</a>
    ${c.subcategories.slice(0, 8).map((t) => `<a href="/category/${esc(catSlug(c.name))}/${encodeURIComponent(t)}" data-link>${esc(t)}</a>`).join('')}</div>`).join('')}</div></div>`;
}
