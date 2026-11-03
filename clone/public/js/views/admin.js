// Admin panel shell (CLONE_SPEC §18): left sidebar, permission-gated sections, friendly 403 page.
// Sections live in ./admin/*.js and are loaded on demand.
import { session } from '../store.js';
import { esc } from '../lib.js';
import { get, AdminError } from './admin/ui.js';

export const SECTIONS = [
  ['catalog', 'Catalog', 'catalog.read', './admin/catalog.js'],
  ['resolution', 'Resolution desk', 'catalog.read', './admin/resolution.js'],
  ['content', 'Content', 'content.write', './admin/content.js'],
  ['ops', 'Market ops', 'markets.ops', './admin/ops.js'],
  ['perps', 'Perps ops', 'perps.ops', './admin/ops.js'],
  ['users', 'Users', 'users.read', './admin/users.js'],
  ['moderation', 'Moderation', 'social.moderate', './admin/community.js'],
  ['chat', 'Chat', 'social.moderate', './admin/chat.js'],
  ['announcements', 'Announcements', 'announce', './admin/community.js'],
  ['reports', 'Reports', 'reports.read', './admin/reports.js'],
  ['roles', 'Roles', 'roles.write', './admin/users.js'],
  ['audit', 'Audit log', 'audit.read', './admin/system.js'],
  ['settings', 'Settings & health', 'settings.write', './admin/system.js'],
  ['security', 'Security', 'audit.read', './admin/security.js'],
  ['identity', 'Sign-in & audit integrity', 'audit.read', './admin/identity.js'], // CLONE_SPEC §22
];
// Literal import() per module so the production bundler (scripts/build.js) can split them into hashed chunks.
const LOADERS = {
  './admin/catalog.js': () => import('./admin/catalog.js'), './admin/resolution.js': () => import('./admin/resolution.js'),
  './admin/content.js': () => import('./admin/content.js'), './admin/ops.js': () => import('./admin/ops.js'), './admin/users.js': () => import('./admin/users.js'),
  './admin/community.js': () => import('./admin/community.js'), './admin/chat.js': () => import('./admin/chat.js'), './admin/reports.js': () => import('./admin/reports.js'),
  './admin/system.js': () => import('./admin/system.js'), './admin/security.js': () => import('./admin/security.js'),
  './admin/identity.js': () => import('./admin/identity.js'),
};

function forbidden(el, signedIn) {
  document.title = 'Admin · Parlance';
  el.innerHTML = `<div class="card empty adm-forbidden" role="alert" data-testid="admin-forbidden"><h1 class="typ-title-x20">${signedIn ? 'You don’t have access to the admin panel' : 'Sign in to continue'}</h1>
    <p class="muted">${signedIn ? 'This area is for exchange staff. If you think you should have access, ask an administrator to grant you a role.' : 'The admin panel is only available to signed-in staff accounts.'}</p>
    <div class="d-flex gap-8 jc-center">${signedIn ? '' : '<a class="btn btn-primary" href="/sign-in?next=/admin" data-link>Log in</a>'}<a class="btn" href="/" data-link>Go home</a></div></div>`;
}

export async function render({ el, params, query, navigate }) {
  if (!session.user) { forbidden(el, false); return; }
  let me;
  try { me = await get('/me'); } catch (e) { if (e instanceof AdminError && (e.status === 403 || e.status === 401)) { forbidden(el, e.status === 403); return; } throw e; }
  const perms = new Set(me.permissions);
  const allowed = SECTIONS.filter(([, , p]) => perms.has(p));
  const parts = String(params.path || '').split('/').filter(Boolean).map(decodeURIComponent);
  let key = parts[0] || '';
  if (key === 'preview') key = 'catalog';
  if (!key) { navigate(`/admin/${allowed[0][0]}`, { replace: true }); return; }
  const sec = SECTIONS.find(([k]) => k === key);
  el.innerHTML = `<div class="adm" data-testid="admin">
    <aside class="adm-side" aria-label="Admin sections"><div class="adm-brand"><span>Parlance</span> Admin</div>
      <nav>${allowed.map(([k, l]) => `<a href="/admin/${esc(k)}" data-link class="${k === key ? 'on' : ''}" data-section="${esc(k)}">${esc(l)}</a>`).join('')}</nav>
      <div class="adm-who faint"><div>${esc(me.user.email)}</div><div data-testid="admin-roles">${me.roles.map(esc).join(', ')}</div></div></aside>
    <section class="adm-main" id="adm-main" data-testid="admin-main"></section></div>`;
  const main = el.querySelector('#adm-main');
  if (!sec) { main.innerHTML = '<div class="empty">Unknown admin section.</div>'; return; }
  if (!perms.has(sec[2])) {
    main.innerHTML = `<div class="card empty" role="alert" data-testid="section-forbidden"><h2 class="typ-title-x20">Not available for your role</h2><p class="muted">${esc(sec[1])} needs the <code>${esc(sec[2])}</code> permission. Your roles: ${me.roles.map(esc).join(', ')}.</p></div>`;
    document.title = `${sec[1]} · Admin`;
    return;
  }
  document.title = `${sec[1]} · Admin · Parlance`;
  const mod = await LOADERS[sec[3]]();
  return mod.render({ el: main, section: key, parts: parts[0] === 'preview' ? ['preview', ...parts.slice(1)] : parts.slice(1), query, me, perms, navigate });
}
