// Admin panel shell (CLONE_SPEC §18): left sidebar, permission-gated sections, friendly 403 page.
// Sections live in ./admin/*.js and are loaded on demand.
import { t, te, ts } from '../i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import '../content/admin-strings.js';
import { session } from '../store.js';
import { esc } from '../lib.js';
import { get, AdminError } from './admin/ui.js';

export const SECTIONS = [
  ['catalog', ts('admin.sections.catalog'), 'catalog.read', './admin/catalog.js'],
  ['resolution', ts('admin.sections.resolution_desk'), 'catalog.read', './admin/resolution.js'],
  ['cms', ts('admin.sections.content_settings'), 'content.write', './admin/cms.js'], // CMS hub (CLONE_SPEC.md §32)
  ['content', ts('admin.sections.content'), 'content.write', './admin/content.js'],
  ['ops', ts('admin.sections.market_ops'), 'markets.ops', './admin/ops.js'],
  ['perps', ts('admin.sections.perps_ops'), 'perps.ops', './admin/ops.js'],
  ['users', ts('admin.sections.users'), 'users.read', './admin/users.js'],
  ['moderation', ts('admin.sections.moderation'), 'social.moderate', './admin/community.js'],
  ['chat', ts('admin.sections.chat'), 'social.moderate', './admin/chat.js'],
  ['community', ts('admin.sections.community'), 'social.moderate', './admin/community2.js'], // stickers, post history, group chats (CLONE_SPEC §24.9)
  ['outbox', ts('admin.sections.notification_outbox'), 'users.support', './admin/community2.js'],
  ['announcements', ts('admin.sections.announcements'), 'announce', './admin/community.js'],
  ['reports', ts('admin.sections.reports'), 'reports.read', './admin/reports.js'],
  ['roles', ts('admin.sections.roles'), 'roles.write', './admin/users.js'],
  ['audit', ts('admin.sections.audit_log'), 'audit.read', './admin/system.js'],
  ['settings', ts('admin.sections.settings_health'), 'settings.write', './admin/system.js'],
  ['security', ts('admin.sections.security'), 'audit.read', './admin/security.js'],
  ['identity', ts('admin.sections.sign_in_audit_integrity'), 'audit.read', './admin/identity.js'], // CLONE_SPEC §22
  // Phase 3 (CLONE_SPEC.md §25): identity reviews (masked, audited reveal and document view), fraud holds, compliance
  // settings (gating, blocked regions, IP table, SMS limits, retention) and promo codes.
  ['kyc', ts('admin.sections.identity_reviews'), 'users.read', './admin/compliance.js'],
  ['fraud', ts('admin.sections.fraud_holds'), 'users.read', './admin/compliance.js'],
  ['compliance', ts('admin.sections.compliance'), 'settings.write', './admin/compliance.js'],
  ['promos', ts('admin.sections.promo_codes'), 'users.money', './admin/compliance.js'],
  // Phase 4 (CLONE_SPEC.md §26): transactions, reconciliation, AML cases, ledger audit, provider settings, webhook log.
  ['payments', ts('admin.sections.payments'), 'users.read', './admin/payments.js'],
  // Phase 5B (CLONE_SPEC.md §29): AI news summaries (hide / regenerate / budget) and the Liquidity Incentive Program.
  ['ai_summaries', ts('admin.sections.ai_summaries'), 'content.write', './admin/content5b.js'],
  ['incentives', ts('admin.sections.liquidity_incentives'), 'markets.ops', './admin/content5b.js'],
  // Phase 5D (CLONE_SPEC.md §33): feature flags, play mode (switch to production) and the Central Bank / Vault Heist.
  ['flags', ts('admin.sections.feature_flags'), 'settings.write', './admin/flags.js'],
  ['play_mode', ts('admin.sections.play_mode'), 'settings.write', './admin/playmode.js'],
  ['central_bank', ts('admin.sections.central_bank'), 'users.read', './admin/playmode.js'],
  // Phase 7 (CLONE_SPEC.md §35): API keys (tiers, revoke, usage), FIX sessions, rate settings; status-page incidents.
  ['api_keys', ts('admin.sections.api_keys'), 'users.read', './admin/api-keys.js'],
  ['status', ts('admin.sections.status'), 'content.write', './admin/api-keys.js'],
  // Phase 7A (CLONE_SPEC.md §36): the real-money launch waitlist (target, survey, export, newsletter) and the Perps list.
  ['waitlists', ts('admin.sections.waitlists'), 'users.read', './admin/waitlists.js'],
];
// Literal import() per module so the production bundler (scripts/build.js) can split them into hashed chunks.
const LOADERS = {
  './admin/catalog.js': () => import('./admin/catalog.js'), './admin/resolution.js': () => import('./admin/resolution.js'),
  './admin/content.js': () => import('./admin/content.js'), './admin/ops.js': () => import('./admin/ops.js'), './admin/users.js': () => import('./admin/users.js'),
  './admin/community.js': () => import('./admin/community.js'), './admin/community2.js': () => import('./admin/community2.js'), './admin/chat.js': () => import('./admin/chat.js'), './admin/reports.js': () => import('./admin/reports.js'),
  './admin/system.js': () => import('./admin/system.js'), './admin/security.js': () => import('./admin/security.js'),
  './admin/identity.js': () => import('./admin/identity.js'), './admin/compliance.js': () => import('./admin/compliance.js'),
  './admin/payments.js': () => import('./admin/payments.js'), './admin/content5b.js': () => import('./admin/content5b.js'),
  './admin/cms.js': () => import('./admin/cms.js'), './admin/flags.js': () => import('./admin/flags.js'), './admin/playmode.js': () => import('./admin/playmode.js'),
  './admin/api-keys.js': () => import('./admin/api-keys.js'), './admin/waitlists.js': () => import('./admin/waitlists.js'),
};

// Admin passkey policy (CLONE_SPEC.md §25.3): when on, the session must have been signed in, or confirmed, with a passkey.
function passkeyRequired(el, e, retry) {
  document.title = t('admin.passkey_required.admin_parlance');
  el.innerHTML = `<div class="card empty adm-forbidden" role="alert" data-testid="admin-passkey-required"><h1 class="typ-title-x20">${te('admin.passkey_required.confirm_with_your_passkey')}</h1>
    <p class="muted">${te('admin.passkey_required.staff_must_use_a_passkey', { value: esc(e.details || '') })}</p><p class="form-error" data-err></p>
    <div class="d-flex gap-8 jc-center"><button class="btn btn-primary" data-pk data-testid="admin-passkey-confirm">${te('admin.passkey_required.use_my_passkey')}</button><a class="btn" href="/account/privacy" data-link>${te('admin.passkey_required.manage_passkeys')}</a></div></div>`;
  el.querySelector('[data-pk]').onclick = async () => {
    try {
      const [{ idApi }, { getPasskey }] = await Promise.all([import('../identity-api.js'), import('../webauthn-client.js')]);
      await idApi.passkeyStepUp(await getPasskey(await idApi.passkeyStepUpOptions()));
      retry();
    } catch (ex) { el.querySelector('[data-err]').textContent = ex.message; }
  };
}

function forbidden(el, signedIn) {
  document.title = t('admin.forbidden.admin_parlance');
  el.innerHTML = `<div class="card empty adm-forbidden" role="alert" data-testid="admin-forbidden"><h1 class="typ-title-x20">${signedIn ? te('admin.forbidden.you_don_t_have_access') : te('admin.forbidden.sign_in_to_continue')}</h1>
    <p class="muted">${signedIn ? te('admin.forbidden.this_area_is_for_exchange') : te('admin.forbidden.the_admin_panel_is_only')}</p>
    <div class="d-flex gap-8 jc-center">${signedIn ? '' : `<a class="btn btn-primary" href="/sign-in?next=/admin" data-link>${te('admin.forbidden.log_in')}</a>`}<a class="btn" href="/" data-link>${te('admin.forbidden.go_home')}</a></div></div>`;
}

export async function render({ el, params, query, navigate }) {
  if (!session.user) { forbidden(el, false); return; }
  let me;
  try { me = await get('/me'); } catch (e) {
    if (e instanceof AdminError && e.code === 'passkey_required') { passkeyRequired(el, e, () => render({ el, params, query, navigate })); return; }
    if (e instanceof AdminError && (e.status === 403 || e.status === 401)) { forbidden(el, e.status === 403); return; }
    throw e;
  }
  const perms = new Set(me.permissions);
  const allowed = SECTIONS.filter(([, , p]) => perms.has(p));
  const parts = String(params.path || '').split('/').filter(Boolean).map(decodeURIComponent);
  let key = parts[0] || '';
  if (key === 'preview') key = 'catalog';
  if (!key) { navigate(`/admin/${allowed[0][0]}`, { replace: true }); return; }
  const sec = SECTIONS.find(([k]) => k === key);
  el.innerHTML = `<div class="adm" data-testid="admin">
    <aside class="adm-side" aria-label="${te('admin.render.admin_sections')}"><div class="adm-brand"><span>${te('admin.render.parlance')}</span> ${te('admin.render.admin')}</div>
      <nav>${allowed.map(([k, l]) => `<a href="/admin/${esc(k)}" data-link class="${k === key ? 'on' : ''}" data-section="${esc(k)}">${esc(l)}</a>`).join('')}</nav>
      <div class="adm-who faint"><div>${esc(me.user.email)}</div><div data-testid="admin-roles">${me.roles.map(esc).join(', ')}</div></div></aside>
    <section class="adm-main" id="adm-main" data-testid="admin-main"></section></div>`;
  const main = el.querySelector('#adm-main');
  if (!sec) { main.innerHTML = `<div class="empty">${te('admin.render.unknown_admin_section')}</div>`; return; }
  if (!perms.has(sec[2])) {
    main.innerHTML = `<div class="card empty" role="alert" data-testid="section-forbidden"><h2 class="typ-title-x20">${te('admin.render.not_available_for_your_role')}</h2><p class="muted">${te('admin.render.needs_the', { value: esc(sec[1]) })} <code>${esc(sec[2])}</code> ${te('admin.render.permission_your_roles', { value: me.roles.map(esc).join(', ') })}</p></div>`;
    document.title = t('admin.render.admin_2', { value: sec[1] });
    return;
  }
  document.title = t('admin.render.admin_parlance', { value: sec[1] });
  const mod = await LOADERS[sec[3]]();
  return mod.render({ el: main, section: key, parts: parts[0] === 'preview' ? ['preview', ...parts.slice(1)] : parts.slice(1), query, me, perms, navigate });
}
