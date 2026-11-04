'use strict';
// Authorization matrix (PLAN P1.7, §6 security gate). Every route registered on the running Express app is enumerated at
// runtime (router stack walk, mount table in app.locals.routers) and must be classified in EXPECT below; an unclassified
// route, or a classification for a route that no longer exists, fails the suite. For each route the test asserts:
//   anonymous            → 401 token_authentication_failure on anything not public;
//   signed-in user       → passes the gate on user routes and on its own /users/:uid routes; 403 on staff routes;
//   other user (IDOR)    → user B on /v1/users/<A>/… is refused 403 for every such route;
//   each admin role      → admin / editor / resolver / risk / support / moderator allowed exactly when the route's
//                          permission is in the role (ROLE_PERMS in server/admin.js), else 403.
// Object-level IDOR probes (B acting on A's orders, perps orders, RFQs, quotes, posts, comments, chat messages,
// notifications, price alerts and sessions through B's own paths) and WebSocket channel authorization (private channels
// refused without auth; another user's private events never delivered) complete the matrix.
// Real server + SQLite file; requests go through the perimeter (client token, CSRF) exactly as the SPA sends them.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const { Client } = require('./lib/client');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-authz-'));
const DB_FILE = path.join(TMP, 'authz.db');
// A port the OS reports free (a random pick could collide with another process on the CI machine).
const freePort = () => new Promise((res, rej) => { const s = require('node:net').createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
let PORT; let BASE;
const PW = 'Quartz-Lantern-Meadow-7391';
const stamp = Date.now();
const HIGH = { burst: 1e6, per_second: 1e6 };
const OPTS = {
  port: PORT, dbFile: DB_FILE, tickMs: 300, quiet: true, sports: { speed: 1 },
  rate: { burst: 1e6, perSec: 1e6 },
  security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH },
  admin: { email: `root.${stamp}@example.test`, password: PW },
};

let srv;
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const dbrun = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------- expectations table
// who:  'public'  anyone; never 401/403 from the auth gate
//       'user'    any signed-in user (no :uid in the path)
//       'owner'   signed-in user acting on its own /users/:uid path (other uid → 403)
//       'staff'   any admin role (GET /admin/me)
//       'perm:X'  admin permission X (server/admin.js ROLE_PERMS)
//       'self+perm:X' permission X and the path's :uid must be the caller (social-admin routes)
//       'legacy-admin' users.is_admin only (requireAdmin: the admin role)
// body: request body for the probes (default {} on writes); fresh: probe allowed principals with a throwaway session.
const P = { who: 'public' };
const U = { who: 'user' };
const O = { who: 'owner' };
const perm = (p, extra = {}) => ({ who: `perm:${p}`, ...extra });
const EXPECT = {
  // ---- public market data (Trade API v2)
  'GET /trade-api/v2/exchange/status': P,
  'GET /trade-api/v2/markets': P,
  'GET /trade-api/v2/markets/trades': P,
  'GET /trade-api/v2/markets/:ticker': P,
  'GET /trade-api/v2/markets/:ticker/orderbook': P,
  'GET /trade-api/v2/events': P,
  'GET /trade-api/v2/events/:ticker': P,
  'GET /trade-api/v2/series/:ticker': P,
  'GET /trade-api/v2/series/:s/markets/:ticker/candlesticks': P,
  // ---- public site data
  'GET /v1/site_config': P, 'GET /v1/help': P, 'GET /v1/help/:slug': P,
  'GET /v1/bff/home': P, 'GET /v1/events/:ticker/related': P, 'GET /v1/live_data/count': P, 'GET /v1/search/series': P,
  'GET /v1/categories': P, 'GET /v1/calendar': P, 'GET /v1/rolling/current': P, 'GET /v1/rolling/determined': P,
  'GET /v1/social/profile': P, 'GET /v1/social/profile/holdings': P, 'GET /v1/social/posts': P, 'GET /v1/social/posts/:pid': P,
  'GET /v1/social/posts/:pid/comments': P, 'GET /v1/social/leaderboard': P, 'GET /v1/social/trades': P, 'GET /v1/social/top_holders': P,
  'GET /v1/perps/enabled': P, 'GET /v1/perps/exchange/status': P, 'GET /v1/perps/asset_classes': P, 'GET /v1/perps/markets': P,
  'GET /v1/perps/markets/:ticker': P, 'GET /v1/perps/markets/:ticker/orderbook': P, 'GET /v1/perps/markets/:ticker/trades': P,
  'GET /v1/perps/markets/:ticker/candlesticks': P, 'GET /v1/perps/funding_rates/historical': P, 'GET /v1/perps/funding_rates/estimate': P,
  'GET /v1/perps/funding_schedule': P, 'GET /v1/perps/risk_parameters': P, 'GET /v1/perps/fee_tiers': P, 'GET /v1/perps/markets/:ticker/margin_tiers': P,
  'GET /v1/multivariate_event_collections': P, 'GET /v1/multivariate_event_collections/:collection': P, 'GET /v1/combos/:ticker': P,
  'GET /v1/sports/leagues': P, 'GET /v1/live_data/feed': P, 'GET /v1/live_data/batch': P, 'GET /v1/live_data/milestone/:id/game_stats': P,
  'GET /v1/live_data/:type/milestone/:id': P, 'GET /v1/milestones': P, 'GET /v1/milestones/:id': P, 'GET /v1/milestones/:id/plays': P,
  'GET /v1/sports/events/:ticker': P, 'GET /v1/events/:ticker/chat': P,
  // ---- identity: pre-session endpoints are public by design (login CSRF protects them)
  'GET /v1/session': P, 'GET /v1/auth/csrf': P, 'POST /v1/users': P, 'POST /v1/log_in': P, 'POST /v1/log_in_mfa': P,
  'POST /v1/auth/complete_password_change': P, 'POST /v1/log_out': P, 'GET /v1/auth/setup': P, 'POST /v1/auth/setup_admin': P,
  'POST /v1/step_up': U,
  // ---- signed-in user, no :uid in the path (objects are scoped to req.auth.user inside the handler)
  'GET /v1/perps/balance': U, 'POST /v1/perps/transfers': U, 'GET /v1/perps/transfers': U, 'POST /v1/perps/orders': U, 'GET /v1/perps/orders': U,
  'GET /v1/perps/orders/:id': U, 'DELETE /v1/perps/orders/:id': U, 'GET /v1/perps/positions': U, 'POST /v1/perps/positions/:ticker/close': U,
  'GET /v1/perps/fills': U, 'GET /v1/perps/funding_history': U, 'GET /v1/perps/liquidations': U, 'GET /v1/perps/ledger': U, 'GET /v1/perps/risk': U,
  'GET /v1/perps/exit_triggers': U, 'PUT /v1/perps/positions/:ticker/exit_trigger': U, 'DELETE /v1/perps/positions/:ticker/exit_trigger': U,
  // Phase 6 (CLONE_SPEC.md §34): subaccounts, amend / decrease, order groups, APY, waitlist, referrals — scoped to the caller.
  'GET /v1/perps/subaccounts': U, 'POST /v1/perps/subaccounts': U, 'PUT /v1/perps/subaccounts/:n': U, 'POST /v1/perps/subaccounts/transfers': U,
  'POST /v1/perps/orders/:id/amend': U, 'POST /v1/perps/orders/:id/decrease': U,
  'POST /v1/perps/order_groups': U, 'GET /v1/perps/order_groups': U, 'GET /v1/perps/order_groups/:id': U, 'DELETE /v1/perps/order_groups/:id': U, 'POST /v1/perps/order_groups/:id/reset': U,
  'GET /v1/perps/apy': U, 'GET /v1/perps/waitlist': U, 'POST /v1/perps/waitlist': U, 'GET /v1/perps/referrals': U, 'POST /v1/perps/referrals/apply': U,
  'POST /v1/multivariate_event_collections/:collection/markets': U, 'POST /v1/multivariate_event_collections/:collection': U,
  'GET /v1/communications/id': U, 'POST /v1/communications/rfqs': U, 'GET /v1/communications/rfqs': U, 'GET /v1/communications/rfqs/:id': U,
  'DELETE /v1/communications/rfqs/:id': U, 'POST /v1/communications/quotes': U, 'POST /v1/communications/rfqs/:id/quotes': U,
  'GET /v1/communications/quotes': U, 'GET /v1/communications/quotes/:qid': U, 'DELETE /v1/communications/quotes/:qid': U,
  'PUT /v1/communications/rfqs/:id/quotes/:qid/accept': U, 'PUT /v1/communications/quotes/:qid/accept': U,
  'PUT /v1/communications/quotes/:qid/confirm': U, 'PUT /v1/communications/rfqs/:id/quotes/:qid/confirm': U,
  // ---- the user's own resources (/v1/users/:uid/…)
  'GET /v1/users/:uid': O, 'GET /v1/users/:uid/properties': O, 'PUT /v1/users/:uid/properties': O, 'GET /v1/users/:uid/balance': O,
  'POST /v1/users/:uid/deposits': O, 'POST /v1/users/:uid/withdrawals': O, 'POST /v1/users/:uid/orders': O, 'GET /v1/users/:uid/orders': O,
  'DELETE /v1/users/:uid/orders/:oid': O, 'DELETE /v1/users/:uid/orders': O, 'GET /v1/users/:uid/orders/queue_positions': O,
  'GET /v1/users/:uid/orders/:oid/queue_position': O, 'GET /v1/users/:uid/orders/:oid': O, 'POST /v1/users/:uid/orders/:oid/amend': O,
  'POST /v1/users/:uid/orders/:oid/decrease': O, 'GET /v1/users/:uid/positions': O, 'GET /v1/users/:uid/portfolio/positions': O,
  'GET /v1/users/:uid/positions/:ticker/sell_quote': O, 'GET /v1/users/:uid/fills': O, 'GET /v1/users/:uid/settlement_history': O,
  'GET /v1/users/:uid/transactions': O, 'GET /v1/users/:uid/transactions.csv': O, 'GET /v1/users/:uid/history': O, 'GET /v1/users/:uid/history.csv': O,
  'GET /v1/users/:uid/watchlist': O, 'PUT /v1/users/:uid/watchlist/:event': O, 'DELETE /v1/users/:uid/watchlist/:event': O,
  'POST /v1/users/:uid/recently_visited': O, 'GET /v1/users/:uid/recently_visited': O, 'GET /v1/users/:uid/interest': O,
  'GET /v1/users/:uid/notifications': O, 'PUT /v1/users/:uid/notifications/read': O, 'PUT /v1/users/:uid/notifications/:nid/read': O,
  'GET /v1/users/:uid/notifications/custom_price_targets': O, 'POST /v1/users/:uid/notifications/custom_price_targets': O,
  'DELETE /v1/users/:uid/notifications/custom_price_targets': O,
  'GET /v1/users/:uid/deposit_limits': O, 'PUT /v1/users/:uid/deposit_limit': O, 'GET /v1/users/:uid/trading_limits': O, 'PUT /v1/users/:uid/trading_limits': O,
  'GET /v1/users/:uid/daily_session_time_limit': O, 'PUT /v1/users/:uid/daily_session_time_limit': O,
  'GET /v1/users/:uid/mfa': O, 'POST /v1/users/:uid/mfa/setup': O, 'POST /v1/users/:uid/mfa/enable': O, 'POST /v1/users/:uid/mfa/disable': O,
  'GET /v1/users/:uid/security': O, 'GET /v1/users/:uid/sessions': O, 'DELETE /v1/users/:uid/sessions/:sid': O,
  'DELETE /v1/users/:uid/sessions': { who: 'owner', fresh: true }, 'GET /v1/users/:uid/security_events': O,
  'PUT /v1/users/:uid/password': O, 'PUT /v1/users/:uid/email': O, 'PUT /v1/users/:uid/withdrawal_mfa': O,
  'GET /v1/users/:uid/social/profile': O, 'POST /v1/users/:uid/social/profile': O, 'POST /v1/users/:uid/social/posts': O,
  'DELETE /v1/users/:uid/social/posts/:pid': O, 'POST /v1/users/:uid/social/posts/:pid/like': O, 'DELETE /v1/users/:uid/social/posts/:pid/unlike': O,
  'POST /v1/users/:uid/social/posts/:pid/bookmark': O, 'DELETE /v1/users/:uid/social/posts/:pid/bookmark': O,
  'POST /v1/users/:uid/social/posts/:pid/comments': O, 'DELETE /v1/users/:uid/social/posts/:pid/comments/:cid': O,
  'POST /v1/users/:uid/social/follow': O, 'DELETE /v1/users/:uid/social/follow': O, 'POST /v1/users/:uid/social/reports': O,
  'GET /v1/users/:uid/combos': O, 'GET /v1/users/:uid/combo_slip': O, 'PUT /v1/users/:uid/combo_slip': O, 'DELETE /v1/users/:uid/combo_slip': O,
  'POST /v1/users/:uid/chat/:ticker/messages': O, 'DELETE /v1/users/:uid/chat/:ticker/messages/:id': O, 'POST /v1/users/:uid/chat/:ticker/messages/:id/report': O,
  // ---- staff
  'GET /v1/admin/me': { who: 'staff' },
  'GET /v1/admin/roles': perm('roles.write'), 'PUT /v1/admin/roles/:userId': perm('roles.write'),
  'GET /v1/admin/audit': perm('audit.read'), 'GET /v1/admin/audit/verify': perm('audit.read'), 'GET /v1/admin/identity/events': perm('audit.read'),
  'GET /v1/admin/security/events': perm('audit.read'), 'GET /v1/admin/identity/outbox': perm('users.support'),
  'GET /v1/admin/catalog/series': perm('catalog.read'), 'GET /v1/admin/catalog/events': perm('catalog.read'), 'GET /v1/admin/catalog/markets': perm('catalog.read'),
  'GET /v1/admin/catalog/preview/:ticker': perm('catalog.read'), 'GET /v1/admin/catalog/import/template.csv': perm('catalog.read'),
  'POST /v1/admin/catalog/series': perm('catalog.write'), 'POST /v1/admin/catalog/events': perm('catalog.write'), 'POST /v1/admin/catalog/markets': perm('catalog.write'),
  'PUT /v1/admin/catalog/series/:ticker': perm('catalog.write'), 'PUT /v1/admin/catalog/events/:ticker': perm('catalog.write'), 'PUT /v1/admin/catalog/markets/:ticker': perm('catalog.write'),
  'DELETE /v1/admin/catalog/:kind/:ticker': perm('catalog.write'), 'POST /v1/admin/catalog/:kind/:ticker/publish': perm('catalog.write'), 'POST /v1/admin/catalog/import': perm('catalog.write'),
  'GET /v1/admin/resolution/queue': perm('catalog.read'), 'GET /v1/admin/resolution/:ticker': perm('catalog.read'),
  'POST /v1/admin/resolution/:ticker/resolve': perm('resolution.write'), 'POST /v1/admin/resolution/:ticker/reverse': perm('resolution.write'),
  'POST /v1/admin/resolution/:ticker/finalize': perm('resolution.write'), 'POST /v1/admin/resolution/:ticker/close': perm('resolution.write'),
  'GET /v1/admin/content/:coll': perm('content.write'), 'POST /v1/admin/content/:coll': perm('content.write'), 'PUT /v1/admin/content/:coll/:id': perm('content.write'),
  'DELETE /v1/admin/content/:coll/:id': perm('content.write'), 'GET /v1/admin/hero': perm('content.write'), 'PUT /v1/admin/hero': perm('content.write'),
  'GET /v1/admin/nav': perm('content.write'), 'PUT /v1/admin/nav': perm('content.write'),
  'GET /v1/admin/ops': perm('markets.ops'), 'POST /v1/admin/ops/exchange': perm('markets.ops'), 'POST /v1/admin/ops/markets/:ticker/:action': perm('markets.ops'),
  'PUT /v1/admin/ops/series/:ticker/fee': perm('markets.ops'), 'PUT /v1/admin/ops/markets/:ticker/liquidity': perm('markets.ops'), 'PUT /v1/admin/ops/markets/:ticker/combo': perm('markets.ops'),
  'GET /v1/admin/perps': perm('perps.ops'), 'POST /v1/admin/perps/:ticker/:action': perm('perps.ops'), 'PUT /v1/admin/perps/:ticker/leverage': perm('perps.ops'),
  // Admin › Perps ops (Phase 6, CLONE_SPEC.md §34.10): tiers, risk limits, APY, waitlist, referral settings, the perps journal.
  'GET /v1/admin/perps_ops/margin_tiers': perm('perps.ops'), 'PUT /v1/admin/perps_ops/margin_tiers/:ticker': perm('perps.ops'),
  'GET /v1/admin/perps_ops/risk': perm('perps.ops'), 'PUT /v1/admin/perps_ops/risk': perm('perps.ops'),
  'GET /v1/admin/perps_ops/apy': perm('perps.ops'), 'PUT /v1/admin/perps_ops/apy': perm('perps.ops'), 'POST /v1/admin/perps_ops/apy/payout': perm('perps.ops'),
  'GET /v1/admin/perps_ops/waitlist': perm('perps.ops'), 'POST /v1/admin/perps_ops/waitlist/approve': perm('perps.ops'), 'POST /v1/admin/perps_ops/waitlist/revoke': perm('perps.ops'),
  'POST /v1/admin/perps_ops/waitlist/invite': perm('perps.ops'), 'GET /v1/admin/perps_ops/referrals': perm('perps.ops'), 'PUT /v1/admin/perps_ops/referrals': perm('perps.ops'),
  'GET /v1/admin/perps_ops/ledger': perm('perps.ops'),
  'GET /v1/admin/users': perm('users.read'), 'GET /v1/admin/users/:id': perm('users.read'),
  'POST /v1/admin/users/:id/adjust': perm('users.money'), 'PUT /v1/admin/users/:id/limits/:kind': perm('users.money'),
  'POST /v1/admin/users/:id/lock': perm('users.support'), 'POST /v1/admin/users/:id/unlock': perm('users.support'), 'POST /v1/admin/users/:id/reset_mfa': perm('users.support'),
  'POST /v1/admin/users/:id/clear_session_time': perm('users.support'), 'POST /v1/admin/users/:id/force_password_reset': perm('users.support'),
  'GET /v1/admin/moderation/reports': perm('social.moderate'), 'POST /v1/admin/moderation/reports/:id/:action': perm('social.moderate'),
  'POST /v1/admin/moderation/content/:kind/:id/:action': perm('social.moderate'), 'GET /v1/admin/moderation/hidden': perm('social.moderate'),
  'GET /v1/admin/moderation/profiles': perm('social.moderate'), 'POST /v1/admin/moderation/users/:id/:action': perm('social.moderate'),
  'GET /v1/admin/chat/rooms': perm('social.moderate'), 'GET /v1/admin/chat/rooms/:ticker': perm('social.moderate'), 'POST /v1/admin/chat/rooms/:ticker/:action': perm('social.moderate'),
  'DELETE /v1/users/:uid/social/social-admin/posts/:pid': { who: 'self+perm:social.moderate' },
  'DELETE /v1/users/:uid/social/social-admin/posts/:pid/comments/:cid': { who: 'self+perm:social.moderate' },
  'GET /v1/users/:uid/social/social-admin/profiles': { who: 'self+perm:social.moderate' },
  'GET /v1/admin/announcements': perm('announce'), 'POST /v1/admin/announcements': perm('announce'),
  'POST /v1/admin/announcements/templates': perm('announce'), 'DELETE /v1/admin/announcements/templates/:id': perm('announce'),
  'GET /v1/admin/reports': perm('reports.read'), 'GET /v1/admin/reports.csv': perm('reports.read'),
  'GET /v1/admin/settings': perm('settings.write'), 'PUT /v1/admin/settings': perm('settings.write'), 'GET /v1/admin/health': perm('settings.write'),
  // Display currency (NGN default) and new-account defaults (CLONE_SPEC.md §30): public descriptor, staff panel.
  'GET /v1/exchange/display_currency': P, 'GET /v1/admin/settings/currency': perm('settings.write'), 'PUT /v1/admin/settings/currency': perm('settings.write'),
  // Legacy lifecycle endpoints and perps simulation controls: users.is_admin (the admin role) only.
  'POST /v1/admin/markets/:ticker/:action': { who: 'legacy-admin' },
  'POST /v1/admin/exchange': { who: 'legacy-admin', body: { trading_active: true } },
  'POST /v1/perps/admin/markets/:ticker/index': { who: 'legacy-admin' },
  'POST /v1/perps/admin/markets/:ticker/simulation': { who: 'legacy-admin' },
  'POST /v1/perps/admin/markets/:ticker/funding': { who: 'legacy-admin' },
  // ---- Phase 2 social and community completion (CLONE_SPEC.md §24)
  'GET /v1/social/badges': P, 'GET /v1/search/social_profiles': P, 'GET /v1/social/timeline_count': P, 'GET /v1/social/stickers': P,
  'GET /v1/social/stickers/:file': P, 'GET /v1/promos': P, 'GET /v1/social/gifs/search': U,
  'GET /v1/users/:uid/social/position_tags': O, 'PUT /v1/users/:uid/social/profile/avatar': O, 'PUT /v1/users/:uid/social/posts/:pid': O,
  'GET /v1/users/:uid/social/mutes': O, 'POST /v1/users/:uid/social/mutes': O, 'DELETE /v1/users/:uid/social/mutes': O,
  'GET /v1/users/:uid/social/topics': O, 'POST /v1/users/:uid/social/topics': O, 'DELETE /v1/users/:uid/social/topics': O,
  'GET /v1/users/:uid/social/circle': O, 'POST /v1/users/:uid/social/circle/requests': O, 'POST /v1/users/:uid/social/circle/requests/:rid/accept': O,
  'POST /v1/users/:uid/social/circle/requests/:rid/decline': O, 'DELETE /v1/users/:uid/social/circle/requests/:rid': O, 'DELETE /v1/users/:uid/social/circle/members': O,
  'GET /v1/users/:uid/notifications/preferences': O, 'PUT /v1/users/:uid/notifications/preferences': O, 'PUT /v1/users/:uid/notifications/settings/:type': O,
  'GET /v1/users/:uid/notifications/push_devices': O, 'POST /v1/users/:uid/notifications/push_devices': O, 'DELETE /v1/users/:uid/notifications/push_devices/:id': O,
  'GET /v1/users/:uid/notifications/deliveries': O,
  // ---- Web Push (CLONE_SPEC.md §31): the VAPID public key is public; subscriptions are the owner's.
  'GET /v1/push/vapid_public_key': P, 'GET /manifest.webmanifest': P, 'GET /sw.js': P, 'GET /offline.html': P,
  'GET /v1/users/:uid/push_subscriptions': O, 'POST /v1/users/:uid/push_subscriptions': O, 'DELETE /v1/users/:uid/push_subscriptions': O,
  'DELETE /v1/users/:uid/push_subscriptions/:id': O, 'POST /v1/users/:uid/push_subscriptions/:id/test': O,
  'GET /v1/users/:uid/notifications/price_movement_subscriptions': O, 'POST /v1/users/:uid/notifications/price_movement_subscriptions': O, 'DELETE /v1/users/:uid/notifications/price_movement_subscriptions': O,
  'GET /v1/users/:uid/notifications/social_account_subscriptions': O, 'POST /v1/users/:uid/notifications/social_account_subscriptions': O, 'DELETE /v1/users/:uid/notifications/social_account_subscriptions': O,
  'GET /v1/users/:uid/groups': O, 'POST /v1/users/:uid/groups': O, 'GET /v1/users/:uid/groups/candidates': O, 'GET /v1/users/:uid/groups/:gid': O, 'PUT /v1/users/:uid/groups/:gid': O,
  'POST /v1/users/:uid/groups/:gid/members': O, 'POST /v1/users/:uid/groups/:gid/leave': O, 'DELETE /v1/users/:uid/groups/:gid/members/:nickname': O,
  'POST /v1/users/:uid/groups/:gid/messages': O, 'DELETE /v1/users/:uid/groups/:gid/messages/:mid': O, 'POST /v1/users/:uid/groups/:gid/messages/:mid/report': O, 'PUT /v1/users/:uid/groups/:gid/read': O,
  'PUT /v1/users/:uid/chat/:ticker/messages/:id/reactions/:reaction': O, 'DELETE /v1/users/:uid/chat/:ticker/messages/:id/reactions/:reaction': O, 'PUT /v1/users/:uid/chat/:ticker/messages/:id': O,
  'PUT /v1/users/:uid/social/social-admin/determine_profile_image/:id': { who: 'self+perm:social.moderate' },
  'PUT /v1/users/:uid/social/social-admin/posts/:pid/market_status': { who: 'self+perm:social.moderate' },
  'PUT /v1/users/:uid/social/social-admin/posts/:pid/post_subtype': { who: 'self+perm:social.moderate' },
  'PUT /v1/users/:uid/social/social-admin/posts/:pid/update': { who: 'self+perm:social.moderate' },
  'GET /v1/admin/moderation/posts/:pid': perm('social.moderate'), 'GET /v1/admin/stickers': perm('social.moderate'), 'PUT /v1/admin/stickers/:id': perm('social.moderate'),
  'GET /v1/admin/groups': perm('social.moderate'), 'GET /v1/admin/groups/:gid': perm('social.moderate'), 'POST /v1/admin/groups/:gid/:action': perm('social.moderate'),
  'GET /v1/admin/chat/messages/:id/edits': perm('social.moderate'), 'GET /v1/admin/notifications/deliveries': perm('users.support'),
  // ---- Phase 3: accounts, identity, compliance, account area (CLONE_SPEC.md §25)
  // Pre-session and handoff endpoints are public by design: login CSRF, signed single-use tokens, the docv capture
  // cookie + CSRF value, or the mock OIDC provider's own checks protect them. /v1/dev/* exists outside production only
  // and answers loopback clients only.
  'GET /v1/identity/config': P, 'GET /v1/identity/countries': P, 'POST /v1/verify_email': P,
  'POST /v1/passwords/reset': P, 'GET /v1/passwords/reset/:token': P, 'PUT /v1/passwords/reset/:token/confirm': P,
  'POST /v1/oauth/:provider/start': P, 'POST /v1/oauth/:provider/callback': P, 'POST /v1/oauth/link': P,
  'POST /v1/passkeys/authentication/options': P, 'POST /v1/passkeys/authentication': P,
  'POST /v1/docv/handoff/claim': P, 'GET /v1/docv/handoff': P, 'POST /v1/docv/handoff/documents': P, 'POST /v1/docv/handoff/submit': P,
  'GET /v1/dev/mailbox': P, 'GET /v1/dev/sms': P,
  'GET /mock-oidc/:provider/authorize': P, 'POST /mock-oidc/:provider/authorize': P, 'POST /mock-oidc/:provider/token': P, 'GET /mock-oidc/:provider/jwks': P,
  'POST /v1/resume_sign_up': U, 'GET /v1/address/suggest': U, 'POST /v1/passkeys/step_up/options': U, 'POST /v1/passkeys/step_up': U,
  'GET /v1/rewards/new_user_checklist': U,
  'GET /v1/users/:uid/sign_up': O, 'POST /v1/users/:uid/sign_up/skip': O, 'POST /v1/users/:uid/verify_phone/send': O, 'POST /v1/users/:uid/verify_phone': O,
  'PUT /v1/users/:uid/sign_up/name': O, 'PUT /v1/users/:uid/sign_up/birthday': O, 'PUT /v1/users/:uid/sign_up/address': O, 'POST /v1/users/:uid/sign_up/submit': O,
  'POST /v1/users/:uid/email_verification': O, 'GET /v1/users/:uid/identity': O, 'POST /v1/users/:uid/data_export': O, 'POST /v1/users/:uid/close_account': O,
  'GET /v1/users/:uid/sign_in_methods': O, 'GET /v1/users/:uid/api_keys': O, 'POST /v1/users/:uid/oauth/:provider/link': O, 'GET /v1/users/:uid/oauth': O,
  'DELETE /v1/users/:uid/oauth/:provider': O, 'POST /v1/users/:uid/passkeys/registration/options': O, 'POST /v1/users/:uid/passkeys/registration': O,
  'GET /v1/users/:uid/passkeys': O, 'DELETE /v1/users/:uid/passkeys/:id': O,
  'GET /v1/users/:uid/docv': O, 'POST /v1/users/:uid/docv/sessions': O, 'POST /v1/users/:uid/docv/documents': O, 'POST /v1/users/:uid/docv/submit': O,
  'POST /v1/users/:uid/docv/exit': O, 'GET /v1/users/:uid/geolocation': O, 'POST /v1/users/:uid/geolocation': O, 'GET /v1/users/:uid/withdrawal_holds': O,
  'GET /v1/users/:uid/preferences': O, 'PUT /v1/users/:uid/preferences': O, 'GET /v1/users/:uid/marketing_consent': O, 'POST /v1/users/:uid/marketing_consent': O,
  'GET /v1/users/:uid/connected_apps': O, 'DELETE /v1/users/:uid/connected_apps/:id': O, 'GET /v1/users/:uid/activity': O, 'GET /v1/users/:uid/activity.csv': O,
  'GET /v1/users/:uid/tax_documents': O, 'GET /v1/users/:uid/tax_documents/:year/transactions.csv': O, 'GET /v1/users/:uid/tax_documents/:year/:form.csv': O,
  'GET /v1/users/:uid/tax_documents/:year/:form.pdf': O, 'GET /v1/users/:uid/promo_codes': O, 'POST /v1/users/:uid/promo_codes': O,
  'GET /v1/admin/identity/users/:id': perm('users.read'), 'POST /v1/admin/identity/users/:id/unmask': perm('users.support'),
  'GET /v1/admin/compliance/settings': perm('settings.write'), 'PUT /v1/admin/compliance/settings': perm('settings.write'),
  'GET /v1/admin/kyc/queue': perm('users.read'), 'POST /v1/admin/kyc/:userId/decision': perm('users.support'),
  'GET /v1/admin/kyc/:userId/documents': perm('users.read'), 'POST /v1/admin/kyc/:userId/documents/:docId/view': perm('users.support'),
  'GET /v1/admin/fraud/overview': perm('users.read'), 'POST /v1/admin/fraud/holds/:id/:action': perm('users.money'),
  'GET /v1/admin/promo_codes': perm('users.money'), 'POST /v1/admin/promo_codes': perm('users.money'), 'PUT /v1/admin/promo_codes/:id': perm('users.money'),
  // ---- Phase 4: payments, sandbox only (CLONE_SPEC.md §26). Webhooks are public by design (HMAC signature, timestamp
  // window and event-id dedupe protect them); the isolated card tokenizer needs a session (its own handler answers 401).
  'POST /v1/payments/webhooks/:provider': P, 'GET /v1/payments/supported_networks': P, 'POST /v1/payments/tokenize/card': U,
  'GET /v1/users/:uid/payments/metadata': O, 'GET /v1/users/:uid/payments/sandbox/test_cards': O, 'GET /v1/users/:uid/withdrawal_times': O, 'GET /v1/users/:uid/credit_history': O,
  'GET /v1/users/:uid/deposits': O, 'GET /v1/users/:uid/withdrawals': O, 'GET /v1/users/:uid/withdrawal_addresses': O,
  'GET /v1/users/:uid/debit/cards': O, 'DELETE /v1/users/:uid/debit/cards/:id': O, 'POST /v1/users/:uid/debit/payment_session': O, 'POST /v1/users/:uid/debit/payment': O,
  'GET /v1/users/:uid/debit/payment_status_web': O, 'POST /v1/users/:uid/debit/payment/:id/challenge': O, 'POST /v1/users/:uid/debit/withdrawal': O,
  'POST /v1/users/:uid/bank_link/accounts': O, 'GET /v1/users/:uid/bank_link/accounts': O, 'DELETE /v1/users/:uid/bank_link/accounts/:id': O,
  'POST /v1/users/:uid/bank_link/deposit': O, 'POST /v1/users/:uid/bank_link/withdrawal': O, 'GET /v1/users/:uid/banks/all_accounts': O,
  'POST /v1/users/:uid/banks/linked_accounts': O, 'DELETE /v1/users/:uid/banks/linked_accounts/:id': O,
  'GET /v1/users/:uid/crypto/account': O, 'PUT /v1/users/:uid/crypto/account': O, 'GET /v1/users/:uid/crypto/wallets': O, 'POST /v1/users/:uid/crypto/wallets': O,
  'DELETE /v1/users/:uid/crypto/wallets/:id': O, 'POST /v1/users/:uid/crypto/withdrawal': O, 'POST /v1/users/:uid/crypto/simulate_deposit': O,
  'GET /v1/admin/payments/overview': perm('users.read'), 'GET /v1/admin/payments/transactions': perm('users.read'), 'GET /v1/admin/payments/reconciliation': perm('users.read'),
  'POST /v1/admin/payments/reconciliation/run': perm('users.money'), 'POST /v1/admin/payments/reconciliation/:id/resolve': perm('users.money'),
  'GET /v1/admin/payments/aml_cases': perm('users.read'), 'POST /v1/admin/payments/aml_cases/:id/:action': perm('users.money'),
  'GET /v1/admin/payments/ledger_audit': perm('users.read'), 'POST /v1/admin/payments/ledger_audit/run': perm('users.money'),
  'GET /v1/admin/payments/settings': perm('settings.write'), 'PUT /v1/admin/payments/settings': perm('settings.write'),
  'GET /v1/admin/payments/webhooks': perm('audit.read'), 'POST /v1/admin/payments/sandbox/crypto/mine': perm('users.money'),
  // ---- Phase 5A: trading core (CLONE_SPEC.md §28): collateral return, flip preview, settlement corrections, two-person rule
  'GET /v1/users/:uid/collateral_returns': O, 'POST /v1/users/:uid/collateral_returns/refresh': O, 'GET /v1/users/:uid/positions/:ticker/flip_preview': O,
  'GET /v1/admin/resolution/policy': perm('resolution.write'), 'PUT /v1/admin/resolution/policy': perm('settings.write'),
  'GET /v1/admin/resolution/approvals': perm('catalog.read'), 'POST /v1/admin/resolution/approvals/:id/approve': perm('resolution.write'),
  'POST /v1/admin/resolution/approvals/:id/reject': perm('resolution.write'), 'POST /v1/admin/resolution/:ticker/correct': perm('resolution.write'),
  'GET /v1/admin/resolution/:ticker/corrections': perm('catalog.read'),
  // ---- Phase 5B: markets and content (CLONE_SPEC.md §29). Ballot lookup and hub widgets are public reads (lookup is a
  // rate-limited POST so the address never sits in a URL); saved ballot areas and incentive enrolment are the owner's;
  // AI-summary moderation needs content.write (settings: settings.write); incentive programs markets.ops, payouts
  // users.money, eligibility settings settings.write.
  'POST /v1/ballot/lookup': P, 'GET /v1/ballot/jurisdictions/:id': P, 'GET /v1/users/:uid/ballot': O, 'PUT /v1/users/:uid/ballot': O, 'DELETE /v1/users/:uid/ballot': O,
  'GET /v1/events/:ticker/ai_summary': P, 'GET /v1/admin/ai_summaries': perm('content.write'), 'POST /v1/admin/ai_summaries/:ticker/hide': perm('content.write'),
  'POST /v1/admin/ai_summaries/:ticker/unhide': perm('content.write'), 'POST /v1/admin/ai_summaries/:ticker/regenerate': perm('content.write'),
  'GET /v1/admin/ai_summaries/settings': perm('settings.write'), 'PUT /v1/admin/ai_summaries/settings': perm('settings.write'),
  'GET /v1/incentive_programs': P, 'GET /v1/incentive_programs/terms': P, 'GET /v1/users/:uid/incentives': O, 'POST /v1/users/:uid/incentives/enrollment': O, 'DELETE /v1/users/:uid/incentives/enrollment': O,
  'GET /v1/admin/incentives/programs': perm('markets.ops'), 'POST /v1/admin/incentives/programs': perm('markets.ops'), 'PUT /v1/admin/incentives/programs/:id': perm('markets.ops'),
  'POST /v1/admin/incentives/programs/:id/payout': perm('users.money'), 'POST /v1/admin/incentives/snapshot': perm('markets.ops'),
  'GET /v1/admin/incentives/settings': perm('settings.write'), 'PUT /v1/admin/incentives/settings': perm('settings.write'),
  'GET /v1/hubs/senate_map': P, 'GET /v1/hubs/fed_funds_outlook': P, 'GET /v1/series/:s/events/:e/forecast_history': P,
  // ---- Phase 5C: content management (CLONE_SPEC.md §32). The published bundle, brand stylesheet and pages are public
  // reads (drafts never reach them: the preview bundle is staff-only); editors (content.write) save drafts, preview,
  // test-send, upload and export; publishing, scheduling and rollback need content.publish (legal pages also step-up).
  'GET /v1/content/bundle': P, 'GET /v1/pages': P, 'GET /v1/pages/:a': P, 'GET /v1/pages/:a/:b': P,
  'GET /content-bundle.js': P, 'GET /content-theme.css': P,
  'GET /v1/admin/cms/overview': perm('content.write'), 'GET /v1/admin/cms/texts': perm('content.write'), 'GET /v1/admin/cms/templates': perm('content.write'),
  'GET /v1/admin/cms/pages': perm('content.write'), 'GET /v1/admin/cms/media': perm('content.write'), 'POST /v1/admin/cms/media': perm('content.write'),
  'GET /v1/admin/cms/:type/entry': perm('content.write'), 'PUT /v1/admin/cms/:type/draft': perm('content.write'), 'DELETE /v1/admin/cms/:type/draft': perm('content.write'),
  'POST /v1/admin/cms/:type/publish': perm('content.publish'), 'POST /v1/admin/cms/:type/unschedule': perm('content.publish'), 'POST /v1/admin/cms/:type/rollback': perm('content.publish'),
  'GET /v1/admin/cms/preview_bundle': perm('content.write'), 'GET /v1/admin/cms/preview_theme.css': perm('content.write'),
  'POST /v1/admin/cms/templates/preview': perm('content.write'), 'POST /v1/admin/cms/templates/test_send': perm('content.write'),
  'GET /v1/admin/cms/export': perm('content.write'), 'POST /v1/admin/cms/import': perm('content.write'),
  'GET RE:^\\/media\\/([a-z0-9_]+)\\.(png|jpg)$': { who: 'public', probe: '/media/authz_nope.png' },
  // ---- Phase 5D: feature flags, play mode, money controls, Central Bank and the Vault Heist (CLONE_SPEC.md §33). The
  // evaluated flag bundle, the play-mode state and the Central Bank's public face are public reads (booleans and display
  // names only); heists, play-money info and money controls are the owner's; flag, play-mode and bank administration is
  // settings.write, funding and per-user money controls users.money, views users.read.
  'GET /v1/feature_flags': P, 'GET /v1/play_mode': P, 'GET /v1/central_bank': P, 'GET /v1/central_bank/feed': P, 'GET /v1/central_bank/most_wanted': P,
  'GET /v1/users/:uid/heists': O, 'POST /v1/users/:uid/heists': O, 'POST /v1/users/:uid/heists/:id/guesses': O, 'GET /v1/users/:uid/play_money': O, 'GET /v1/users/:uid/money_controls': O,
  'GET /v1/admin/flags': perm('settings.write'), 'GET /v1/admin/flags/:key': perm('settings.write'), 'PUT /v1/admin/flags/:key': perm('settings.write'), 'POST /v1/admin/flags/:key/kill': perm('settings.write'),
  'GET /v1/admin/play_mode': perm('settings.write'), 'GET /v1/admin/play_mode/preview': perm('settings.write'), 'PUT /v1/admin/play_mode': perm('settings.write'), 'PUT /v1/admin/play_mode/settings': perm('settings.write'),
  'POST /v1/admin/play_mode/production_switch': perm('settings.write'), 'POST /v1/admin/play_mode/approvals/:id/approve': perm('settings.write'), 'POST /v1/admin/play_mode/approvals/:id/reject': perm('settings.write'),
  'GET /v1/admin/users/:id/money_controls': perm('users.read'), 'PUT /v1/admin/users/:id/money_controls': perm('users.money'),
  'GET /v1/admin/central_bank': perm('users.read'), 'POST /v1/admin/central_bank/fund': perm('users.money'), 'POST /v1/admin/central_bank/defund': perm('users.money'),
  'PUT /v1/admin/central_bank/settings': perm('settings.write'), 'POST /v1/admin/central_bank/queue/process': perm('users.money'),
  // ---- static (regular-expression routes): probe path given explicitly
  'GET RE:^\\/[A-Za-z0-9_-]+\\.css$': { who: 'public', probe: '/fonts.css' },
};

// Role → permissions, mirroring server/admin.js ROLE_PERMS (asserted against the live module below).
const ROLE_PERMS = require('../server/admin').ROLE_PERMS;
const ROLES = Object.keys(ROLE_PERMS);

// ------------------------------------------------------------------------------------------- route enumeration
function enumerateRoutes(app) {
  const mounts = new Map((app.locals.routers || []).map(([prefix, router]) => [router, prefix]));
  const routes = []; const unmapped = [];
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        const p = layer.route.path;
        const pathKey = p instanceof RegExp ? `RE:${p.source}` : prefix + p;
        for (const m of Object.keys(layer.route.methods)) routes.push({ method: m === '_all' ? 'ALL' : m.toUpperCase(), path: pathKey });
      } else if (layer.handle && Array.isArray(layer.handle.stack)) {
        if (!mounts.has(layer.handle)) unmapped.push(layer.name || 'router');
        else walk(layer.handle.stack, mounts.get(layer.handle));
      }
    }
  };
  walk(app.router.stack, '');
  return { routes, unmapped };
}

// ------------------------------------------------------------------------------------------- principals + fixtures
const principals = {}; // name -> Client
let anon; let A; let B; let C;
const fx = {}; // fixtures owned by A
const newEmail = (n) => `${n}.${stamp}@example.test`;

async function makeUser(name, roles = []) {
  const c = new Client(BASE, name);
  await c.signUp(newEmail(name), PW, `Tester ${name.replace(/[^a-z]/g, '')}`);
  if (roles.length) {
    for (const r of roles) dbrun('INSERT OR IGNORE INTO admin_roles(user_id,role,granted_by,granted_at) VALUES(?,?,?,?)', c.uid, r, null, new Date().toISOString());
    if (roles.includes('admin')) dbrun('UPDATE users SET is_admin=1 WHERE id=?', c.uid);
    await c.logIn(newEmail(name), PW); // a fresh session that carries the new roles
  }
  return c;
}

before(async () => {
  PORT = await freePort(); BASE = `http://127.0.0.1:${PORT}`; OPTS.port = PORT;
  srv = await start(OPTS);
  anon = await new Client(BASE, 'anonymous').boot();
  A = await makeUser('alice');
  B = await makeUser('bob');
  C = await makeUser('carol');
  for (const role of ROLES) principals[role] = await makeUser(`role-${role}`, [role]);
});
after(async () => { if (srv) await srv.close(); });

// ------------------------------------------------------------------------------------------- assertions
const ctxCode = (r) => `${r.status} ${r.code || ''} ${r.text ? r.text.slice(0, 160) : ''}`;
function assertPassedGate(r, label) {
  assert.ok(!(r.status === 401 && r.code === 'token_authentication_failure'), `${label}: expected to pass the auth gate, got ${ctxCode(r)}`);
  assert.ok(!(r.status === 403 && r.code === 'forbidden'), `${label}: expected to pass the auth gate, got ${ctxCode(r)}`);
  assert.ok(!(r.status === 403 && /^client_token_/.test(r.code || '')), `${label}: perimeter refused the test client (${ctxCode(r)})`);
  assert.notEqual(r.status, 429, `${label}: rate limited (${ctxCode(r)})`);
  assert.ok(r.status < 500, `${label}: server error ${ctxCode(r)}`);
}
const assertUnauth = (r, label) => assert.ok(r.status === 401 && r.code === 'token_authentication_failure', `${label}: expected 401 token_authentication_failure, got ${ctxCode(r)}`);
const assertForbidden = (r, label) => assert.ok(r.status === 403 && r.code === 'forbidden', `${label}: expected 403 forbidden, got ${ctxCode(r)}`);

const DUMMY = { ticker: 'AUTHZ-NOPE', s: 'AUTHZ-NOPE', event: 'AUTHZ-NOPE', collection: 'PLXCOMBO', kind: 'series', action: 'noop', coll: 'banners', type: 'football', slug: 'authz-nope', userId: 'u_authz-nope' };
function fill(route, uid) {
  if (route.path.startsWith('RE:')) return EXPECT[`${route.method} ${route.path}`].probe;
  return route.path.replace(/:([A-Za-z_]+)/g, (_, name) => (name === 'uid' ? encodeURIComponent(uid) : encodeURIComponent(DUMMY[name] || `authz-nope-${name}`)));
}
async function probe(client, route, uid) {
  const spec = EXPECT[`${route.method} ${route.path}`];
  const body = ['GET', 'HEAD', 'DELETE'].includes(route.method) ? undefined : (spec.body || {});
  return client.call(route.method, fill(route, uid), body);
}
// A disposable principal of the same kind (same roles), for probes that end the caller's sessions (log out everywhere).
let freshN = 0;
async function throwaway(base) { return makeUser(`${base.name}x${++freshN}`, dbq('SELECT role FROM admin_roles WHERE user_id=?', base.uid).map((r) => r.role)); }

// ------------------------------------------------------------------------------------------- tests
test('every registered route is classified in the authorization table (and the table has no stale entries)', () => {
  const app = srv.server.listeners('request')[0];
  const { routes, unmapped } = enumerateRoutes(app);
  assert.deepEqual(unmapped, [], 'a router is mounted that app.locals.routers does not describe; add it to the mount table');
  assert.ok(routes.length > 200, `expected the full route set, found ${routes.length}`);
  const keys = new Set(routes.map((r) => `${r.method} ${r.path}`));
  const missing = [...keys].filter((k) => !EXPECT[k]);
  assert.deepEqual(missing, [], 'routes missing from EXPECT in tests/authz.e2e.test.js — classify every new route');
  const stale = Object.keys(EXPECT).filter((k) => !keys.has(k));
  assert.deepEqual(stale, [], 'EXPECT lists routes that are no longer registered');
  // The role model used for expectations is the live one.
  assert.deepEqual(ROLES.sort(), ['admin', 'editor', 'moderator', 'publisher', 'resolver', 'risk', 'support']); // publisher: CMS (CLONE_SPEC.md §32.2)
});

test('object-level IDOR: user B cannot read or change user A\'s orders, perps orders, RFQs, quotes, posts, chat, alerts or sessions', async () => {
  // ---- A's fixtures
  let r = await A.call('POST', `/v1/users/${A.uid}/deposits`, { amount_dollars: 500 });
  assert.equal(r.status, 201, ctxCode(r));
  r = await C.call('POST', `/v1/users/${C.uid}/deposits`, { amount_dollars: 500 });
  assert.equal(r.status, 201, ctxCode(r));
  const mk = dbq("SELECT m.ticker, m.event_ticker FROM markets m JOIN events e ON e.ticker=m.event_ticker WHERE m.status='active' AND m.fractional_trading_enabled=1 AND e.series_ticker NOT LIKE 'PLXFLASH%' AND m.mve_collection_ticker IS NULL ORDER BY m.rowid LIMIT 1")[0];
  fx.ticker = mk.ticker; fx.event = mk.event_ticker;
  r = await A.call('POST', `/v1/users/${A.uid}/orders`, { ticker: fx.ticker, side: 'yes', type: 'limit', price: 1, count: 2 });
  assert.equal(r.status, 201, ctxCode(r));
  fx.oid = r.body.order.order_id;
  // Perps: collateral, then a resting bid below the mark.
  r = await A.call('POST', '/v1/perps/transfers', { direction: 'to_perps', amount_dollars: 100 });
  assert.equal(r.status, 201, ctxCode(r));
  const pm = (await A.call('GET', '/v1/perps/markets/PLXBTCPERP')).body.market;
  r = await A.call('POST', '/v1/perps/orders', { ticker: 'PLXBTCPERP', side: 'bid', type: 'limit', price: (Number(pm.mark_price) * 0.95).toFixed(4), count: 1 });
  assert.equal(r.status, 201, ctxCode(r));
  fx.perpOid = r.body.order_id;
  // Phase 6: A's order group (with the resting order in it) and a funded subaccount.
  r = await A.call('POST', '/v1/perps/order_groups', { kind: 'limit', contracts_limit: 5 });
  assert.equal(r.status, 201, ctxCode(r));
  fx.groupId = r.body.order_group_id;
  r = await A.call('POST', '/v1/perps/orders', { ticker: 'PLXBTCPERP', side: 'bid', type: 'limit', price: (Number(pm.mark_price) * 0.94).toFixed(4), count: 1, order_group_id: fx.groupId });
  assert.equal(r.status, 201, ctxCode(r));
  fx.groupOid = r.body.order_id;
  r = await A.call('POST', '/v1/perps/subaccounts', { name: 'Hedge' });
  assert.equal(r.status, 201, ctxCode(r));
  fx.sub = r.body.subaccount;
  assert.equal((await A.call('POST', '/v1/perps/subaccounts/transfers', { from_subaccount: 0, to_subaccount: fx.sub, amount_dollars: 5 })).status, 201);
  // RFQ by A, quote by C.
  for (const c of [A, C]) assert.equal((await c.call('PUT', `/v1/users/${c.uid}/properties`, { properties: { rfq_enabled: true } })).status, 200);
  r = await A.call('POST', '/v1/communications/rfqs', { market_ticker: fx.ticker, contracts_fp: '1' });
  assert.equal(r.status, 201, ctxCode(r));
  fx.rfq = r.body.id;
  r = await C.call('POST', '/v1/communications/quotes', { rfq_id: fx.rfq, yes_bid: '0.40', no_bid: '0.40' });
  assert.equal(r.status, 201, ctxCode(r));
  fx.qid = r.body.id;
  // Social + chat.
  assert.equal((await A.call('POST', `/v1/users/${A.uid}/social/profile`, { nickname: `alice_${String(stamp).slice(-6)}` })).status < 300, true);
  r = await A.call('POST', `/v1/users/${A.uid}/social/posts`, { body: 'authz fixture post' });
  assert.equal(r.status, 201, ctxCode(r));
  fx.pid = r.body.post.id;
  r = await A.call('POST', `/v1/users/${A.uid}/social/posts/${fx.pid}/comments`, { body: 'authz fixture comment' });
  assert.equal(r.status, 201, ctxCode(r));
  fx.cid = r.body.comment.id;
  r = await A.call('POST', `/v1/users/${A.uid}/chat/${fx.event}/messages`, { body: 'authz fixture chat' });
  assert.equal(r.status, 201, ctxCode(r));
  fx.chatId = r.body.message.id;
  r = await A.call('POST', `/v1/users/${A.uid}/notifications/custom_price_targets`, { market_ticker: fx.ticker, direction: 'above', price_cents: 99 });
  assert.equal(r.status, 201, ctxCode(r));
  fx.target = r.body.price_target.id;
  fx.nid = (await until(() => dbq('SELECT id FROM notifications WHERE user_id=? ORDER BY created_ts DESC LIMIT 1', A.uid)[0]))?.id; // C's quote notified A
  fx.sid = (await A.call('GET', `/v1/users/${A.uid}/sessions`)).body?.sessions?.find((s) => s.current)?.id;

  // ---- B attacks through its own paths with A's object ids: every attempt is refused (404 or 403) ...
  const refused = (res, label) => assert.ok([403, 404].includes(res.status), `${label}: expected 403/404, got ${ctxCode(res)}`);
  for (const [m, p, body] of [
    ['GET', `/v1/users/${B.uid}/orders/${fx.oid}`], ['GET', `/v1/users/${B.uid}/orders/${fx.oid}/queue_position`],
    ['POST', `/v1/users/${B.uid}/orders/${fx.oid}/amend`, { price: 2 }], ['POST', `/v1/users/${B.uid}/orders/${fx.oid}/decrease`, { reduce_by: 1 }],
    ['DELETE', `/v1/users/${B.uid}/orders/${fx.oid}`],
    ['GET', `/v1/perps/orders/${fx.perpOid}`], ['DELETE', `/v1/perps/orders/${fx.perpOid}`],
    ['POST', `/v1/perps/orders/${fx.perpOid}/amend`, { price: '1.0000' }], ['POST', `/v1/perps/orders/${fx.perpOid}/decrease`, { reduce_to: 0 }],
    ['GET', `/v1/perps/order_groups/${fx.groupId}`], ['DELETE', `/v1/perps/order_groups/${fx.groupId}`], ['POST', `/v1/perps/order_groups/${fx.groupId}/reset`, {}],
    ['POST', '/v1/perps/orders', { ticker: 'PLXBTCPERP', side: 'bid', type: 'limit', price: '1.0000', count: 1, order_group_id: fx.groupId }],
    ['GET', `/v1/communications/rfqs/${fx.rfq}`], ['DELETE', `/v1/communications/rfqs/${fx.rfq}`],
    ['GET', `/v1/communications/quotes/${fx.qid}`], ['DELETE', `/v1/communications/quotes/${fx.qid}`],
    ['PUT', `/v1/communications/rfqs/${fx.rfq}/quotes/${fx.qid}/accept`, { accepted_side: 'yes' }], ['PUT', `/v1/communications/quotes/${fx.qid}/accept`, { accepted_side: 'yes' }],
    ['PUT', `/v1/communications/quotes/${fx.qid}/confirm`, {}],
    ['DELETE', `/v1/users/${B.uid}/social/posts/${fx.pid}`], ['DELETE', `/v1/users/${B.uid}/social/posts/${fx.pid}/comments/${fx.cid}`],
    ['DELETE', `/v1/users/${B.uid}/chat/${fx.event}/messages/${fx.chatId}`],
    ['DELETE', `/v1/users/${B.uid}/notifications/custom_price_targets?id=${encodeURIComponent(fx.target)}`],
    ...(fx.nid ? [['PUT', `/v1/users/${B.uid}/notifications/${fx.nid}/read`, {}]] : []),
    ...(fx.sid ? [['DELETE', `/v1/users/${B.uid}/sessions/${encodeURIComponent(fx.sid)}`]] : []),
  ]) refused(await B.call(m, p, body), `B ${m} ${p}`);
  // ... and B's "cancel all" and "read all" touch only B's own rows.
  assert.equal((await B.call('DELETE', `/v1/users/${B.uid}/orders`)).body.canceled_count, 0);
  assert.equal((await B.call('PUT', `/v1/users/${B.uid}/notifications/read`, {})).status, 200);

  // ---- A's objects are untouched.
  assert.equal(dbq('SELECT status FROM orders WHERE id=?', fx.oid)[0].status, 'resting');
  assert.equal(dbq('SELECT status FROM perp_orders WHERE id=?', fx.perpOid)[0].status, 'resting');
  assert.equal(dbq('SELECT status FROM perp_orders WHERE id=?', fx.groupOid)[0].status, 'resting');
  assert.equal(dbq('SELECT status FROM perp_order_groups WHERE id=?', fx.groupId)[0].status, 'active');
  // B's subaccount ids are B's own: subaccount 1 of B does not exist, and B's transfer from it is refused (A's stays funded).
  assert.equal((await B.call('POST', '/v1/perps/subaccounts/transfers', { from_subaccount: fx.sub, to_subaccount: 0, amount_dollars: 5 })).status, 404);
  assert.equal(dbq('SELECT available_cc c FROM perp_subaccounts WHERE user_id=? AND subaccount=?', A.uid, fx.sub)[0].c, 50000);
  assert.ok(!(await B.call('GET', '/v1/perps/subaccounts')).body.subaccounts.some((x) => x.subaccount === fx.sub), 'B does not see A\'s subaccount');
  assert.equal(dbq('SELECT status FROM rfqs WHERE id=?', fx.rfq)[0].status, 'open');
  assert.equal(dbq('SELECT status FROM rfq_quotes WHERE id=?', fx.qid)[0].status, 'open');
  assert.equal(dbq('SELECT COUNT(*) c FROM posts WHERE id=?', fx.pid)[0].c, 1);
  assert.equal(dbq('SELECT COUNT(*) c FROM comments WHERE id=?', fx.cid)[0].c, 1);
  assert.equal(dbq('SELECT deleted FROM chat_messages WHERE id=?', fx.chatId)[0].deleted, 0);
  assert.equal(dbq('SELECT COUNT(*) c FROM price_targets WHERE id=?', fx.target)[0].c, 1);
  if (fx.nid) assert.equal(dbq('SELECT read_at FROM notifications WHERE id=?', fx.nid)[0].read_at, null);
  // A's session still works, and A can act on its own objects.
  assert.equal((await A.call('GET', `/v1/users/${A.uid}/orders/${fx.oid}`)).status, 200);
  // B reading A's /users/:uid paths directly is refused (the route-level check; the matrix below covers every route).
  assertForbidden(await B.call('GET', `/v1/users/${A.uid}/balance`), 'B GET A balance');
});

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(100); }
}

test('WebSocket channel authorization: private channels need a session; another user\'s private events are never delivered', async () => {
  const PRIVATE = ['user_balance', 'user_orders', 'fill', 'notifications', 'perp_positions', 'perp_orders', 'perp_account', 'communications', 'groups'];
  // Anonymous socket: every private channel refused (code 9); public channels allowed.
  const a0 = anon.socket();
  await a0.opened;
  for (const ch of PRIVATE) {
    const [rep] = await a0.subscribe([ch]);
    assert.equal(rep.type, 'error', `anonymous subscribe ${ch} must be refused`);
    assert.equal(rep.msg.code, 9);
  }
  assert.equal((await a0.subscribe(['ticker']))[0].type, 'subscribed');
  a0.close();

  // A's cookie with a wrong CSRF token is treated as anonymous (cross-site WebSocket hijacking defence).
  const forged = A.socket({ csrf: 'not-the-token' });
  await forged.opened;
  const [fr] = await forged.subscribe(['fill']);
  assert.equal(fr.type, 'error');
  assert.equal(fr.msg.code, 9);
  forged.close();

  // A foreign Origin is refused at the upgrade.
  const foreign = A.socket({ origin: 'https://evil.example' });
  await assert.rejects(foreign.opened, /refused|403|Unexpected/i);

  // B and A subscribe to all private channels; A trades, deposits and gets a notification.
  const sb = B.socket(); const sa = A.socket();
  await Promise.all([sb.opened, sa.opened]);
  for (const s of [sb, sa]) { const reps = await s.subscribe(PRIVATE); assert.ok(reps.every((x) => x.type === 'subscribed'), JSON.stringify(reps)); }
  const beforeB = sb.messages.length;
  let r = await A.call('POST', `/v1/users/${A.uid}/orders`, { ticker: fx.ticker, side: 'yes', type: 'market', count: 1 });
  assert.equal(r.status, 201, ctxCode(r));
  const filledId = r.body.order.order_id;
  r = await A.call('POST', `/v1/users/${A.uid}/deposits`, { amount_dollars: 3 });
  assert.equal(r.status, 201);
  await sa.waitFor((m) => m.type === 'fill' && m.msg && m.msg.order_id === filledId);
  await sa.waitFor((m) => m.type === 'user_order' && m.msg && m.msg.order_id === filledId);
  await sa.waitFor((m) => m.type === 'user_balance');
  await sleep(600);
  const leaked = sb.messages.slice(beforeB).filter((m) => m.type !== 'subscribed' && JSON.stringify(m).includes(filledId));
  assert.deepEqual(leaked, [], 'B received A\'s order/fill events');
  assert.equal(sb.messages.slice(beforeB).filter((m) => ['fill', 'user_order', 'user_balance', 'perp_account', 'notification'].includes(m.type)).length, 0, 'B received private events while B did nothing');
  // Broadcast RFQ events (communications) carry no user ids or emails.
  r = await A.call('DELETE', `/v1/communications/rfqs/${fx.rfq}`);
  assert.equal(r.status, 200);
  await sb.waitFor((m) => m.type === 'rfq_deleted');
  for (const m of sb.messages) {
    const s = JSON.stringify(m);
    assert.ok(!s.includes(A.uid) && !s.includes(A.user.email), `B's socket saw A's identity: ${s.slice(0, 200)}`);
  }
  sa.close(); sb.close();
});

test('authorization matrix: anonymous, user, other user (IDOR) and every admin role, for every route', async () => {
  const app = srv.server.listeners('request')[0];
  const { routes } = enumerateRoutes(app);
  const failures = [];
  const check = async (label, fn) => { try { await fn(); } catch (e) { failures.push(`${label}: ${e.message.split('\n')[0]}`); } };
  let probes = 0;
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    const spec = EXPECT[key];
    if (!spec) continue; // reported by the classification test
    const who = spec.who;
    const run = async (client, uid) => { probes++; return probe(client, route, uid); };
    // Anonymous.
    await check(`${key} as anonymous`, async () => {
      const r = await run(anon, B.uid);
      if (who === 'public') assertPassedGate(r, key); else assertUnauth(r, key);
    });
    if (who === 'public') continue;
    // Signed-in regular user on its own resources.
    await check(`${key} as user`, async () => {
      const who2 = spec.fresh ? await throwaway(B) : B;
      const r = await run(who2, who2.uid);
      if (who === 'user' || who === 'owner') assertPassedGate(r, key); else assertForbidden(r, key);
    });
    // IDOR: B on A's /users/:uid path.
    if (route.path.includes('/users/:uid')) {
      await check(`${key} as other user (IDOR)`, async () => assertForbidden(await run(B, A.uid), `${key} B→A`));
    }
    // Admin roles.
    if (who === 'staff' || who.startsWith('perm:') || who.startsWith('self+perm:') || who === 'legacy-admin') {
      for (const role of ROLES) {
        await check(`${key} as ${role}`, async () => {
          const c = principals[role];
          const p = who.replace(/^self\+perm:|^perm:/, '');
          const allowed = who === 'staff' ? true : who === 'legacy-admin' ? role === 'admin' : ROLE_PERMS[role].includes(p);
          const c2 = spec.fresh ? await throwaway(c) : c;
          const r = await run(c2, c2.uid);
          if (allowed) assertPassedGate(r, `${key} (${role})`); else assertForbidden(r, `${key} (${role})`);
        });
        if (who.startsWith('self+perm:') && ROLE_PERMS[role].includes(who.slice('self+perm:'.length))) {
          await check(`${key} as ${role} on another uid`, async () => assertForbidden(await run(principals[role], A.uid), `${key} (${role}) on A's uid`));
        }
      }
    }
  }
  assert.deepEqual(failures, [], `${failures.length} authorization expectation(s) failed out of ${probes} probes`);
  assert.ok(probes > 600, `expected a full matrix, ran ${probes} probes`);
});
