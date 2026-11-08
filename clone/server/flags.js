'use strict';
// Feature flags (PLAN Phase 5D, CLONE_SPEC.md §33). One DB-backed flag per feature and module, evaluated on the server
// for every request; the client gets its own evaluated booleans (GET /v1/feature_flags) and a live nudge on the public
// `feature_flags` WebSocket channel when anything changes.
//
// A flag has: on/off (`enabled`), a kill switch (`kill`), a percentage rollout (stable hash of flag key + user id),
// allow / deny lists by user, role and region, and a schedule (`starts_at` / `ends_at`). Evaluation order:
//   1. technical override: FEATURE_FLAGS env (`perps=off,sports=on`) or start({ flags: { overrides } }) — wins over the DB
//   2. kill switch → off;  3. enabled = false → off;  4. outside the schedule → off;  5. parent flag off → off
//   6. deny user / role / region → off;  7. allow user / role → on (skips the rollout);  8. allow regions set and the
//      request's region not in it → off;  9. rollout: bucket(key, uid) < rollout_pct (anonymous: on only at 100 %)
// Jobs of a feature (simulations, pumps, accruals) run while the flag is globally on (`jobOn`, steps 1-5): a rollout
// or targeting list never pauses a shared job, a kill switch or "off" does.
//
// Server enforcement: ROUTE_RULES map request paths (relative to /v1) to flag keys; the gate (mounted on /v1 before
// every router, server/app.js) answers 403 `feature_disabled` when one of the matching flags is off for the caller.
// Pipeline features without routes (notification channels, CMS live updates, play-mode features) check `on()` where
// they act. CORE_ROUTES lists the platform core that has no flag (session, account, market data, admin); the
// enforcement test (tests/flags.e2e.test.js) fails when a mounted route matches neither, or a mount* module of
// server/app.js is missing from MODULE_FLAGS.
const crypto = require('node:crypto');
const { tx } = require('./db');
const { ApiError, E, nowIso, newId } = require('./util');
const S = require('./content/playmode'); // keyed server wording (CLONE_SPEC.md §33, §32.3)

// ------------------------------------------------------------------------------------------------ registry
// [key, group, parent, scope, default]  scope: 'both' (server routes + UI), 'server' (pipeline / job only), 'client' (UI
// only); default: the state a new database starts with (on unless false). The Central Bank starts off: once on it is
// the promotions treasury, so incentive payouts would draw from an unfunded budget.
const REGISTRY = [
  ['trading', 'trading', null, 'both'],
  ['trading.limit_orders', 'trading', 'trading', 'both'],
  ['trading.market_orders', 'trading', 'trading', 'both'],
  ['trading.dollars_orders', 'trading', 'trading', 'both'],
  ['trading.order_review', 'trading', 'trading', 'client'],
  ['trading.flip_sell', 'trading', 'trading', 'both'],
  ['trading.fractional', 'trading', 'trading', 'both'],
  ['trading.scalar', 'trading', 'trading', 'both'],
  ['trading.collateral_return', 'trading', 'trading', 'both'],
  ['trading.rolling', 'trading', null, 'both'],
  ['combos', 'markets', null, 'both'],
  ['combos.rfq', 'markets', 'combos', 'both'],
  ['perps', 'markets', null, 'both'],
  // Phase 6 (CLONE_SPEC.md §34). perps.waitlist on = the waitlist gate is active (access by invitation). On by default since
  // the owner decision of 2026-11-08 (CLONE_SPEC.md §36.1); an existing database is switched on once by an audited migration.
  ['perps.subaccounts', 'markets', 'perps', 'both'],
  ['perps.portfolio_margin', 'markets', 'perps', 'both'],
  ['perps.order_groups', 'markets', 'perps', 'both'],
  ['perps.amend', 'markets', 'perps', 'both'],
  ['perps.trailing_stops', 'markets', 'perps', 'both'],
  ['perps.fractional', 'markets', 'perps', 'both'],
  ['perps.apy', 'markets', 'perps', 'both'],
  ['perps.referrals', 'markets', 'perps', 'both'],
  ['perps.waitlist', 'markets', 'perps', 'both'],
  ['sports', 'sports', null, 'both'],
  ['sports.lines', 'sports', 'sports', 'both'],
  ['sports.live_clocks', 'sports', 'sports', 'client'],
  ['social', 'social', null, 'both'],
  ['social.chat', 'social', 'social', 'both'],
  ['social.group_chat', 'social', 'social', 'both'],
  ['watchlist', 'social', null, 'both'],
  ['price_alerts', 'notifications', null, 'both'],
  ['payments.deposits', 'payments', null, 'both'],
  ['payments.withdrawals', 'payments', null, 'both'],
  ['payments.card', 'payments', null, 'both'],
  ['payments.bank', 'payments', null, 'both'],
  ['payments.crypto', 'payments', null, 'both'],
  ['interest', 'payments', null, 'both'],
  ['identity.kyc', 'identity', null, 'both'],
  ['accounts.signup', 'identity', null, 'both'],
  ['signin.password', 'identity', null, 'both'],
  ['signin.oauth', 'identity', null, 'both'],
  ['signin.google', 'identity', 'signin.oauth', 'both'],
  ['signin.apple', 'identity', 'signin.oauth', 'both'],
  ['signin.passkey', 'identity', null, 'both'],
  ['ai_summaries', 'content', null, 'both'],
  ['ballot', 'content', null, 'both'],
  ['incentives', 'content', null, 'both'],
  ['rewards', 'content', null, 'both'],
  ['hubs', 'content', null, 'client'],
  ['hubs.widgets', 'content', 'hubs', 'both'],
  ['notify.inapp', 'notifications', null, 'server'],
  ['notify.email', 'notifications', null, 'server'],
  ['notify.push', 'notifications', null, 'server'],
  ['pwa.install', 'pwa', null, 'client'],
  ['pwa.push', 'pwa', null, 'both'],
  ['currency_switch', 'platform', null, 'both'],
  ['cms.live_updates', 'platform', null, 'both'],
  ['play.signup_bonus', 'play', null, 'server'],
  ['play.free_deposits', 'play', null, 'both'],
  ['central_bank', 'play', null, 'both', false],
  ['heist', 'play', 'central_bank', 'both'],
  // Phase 7 (CLONE_SPEC.md §35): the public trading API. api.keys switches key management and signed authentication;
  // its children switch order entry, the public WebSocket and the FIX gateway (off by default: a TCP listener).
  ['api.keys', 'api', null, 'both'],
  ['api.trading', 'api', 'api.keys', 'server'],
  ['api.ws', 'api', 'api.keys', 'server'],
  ['api.fix', 'api', 'api.keys', 'server', false],
  ['api.demo', 'api', null, 'both'],
  ['developer_portal', 'api', null, 'both'],
  ['status_page', 'api', null, 'both'],
  // Phase 7A (CLONE_SPEC.md §36): the real-money launch waitlist, its public progress bar (off until an admin shows it),
  // its opinion survey, and the waitlist newsletter (routes and the outbox job).
  ['waitlist.launch', 'growth', null, 'both'],
  ['waitlist.launch.public_count', 'growth', 'waitlist.launch', 'both', false],
  ['waitlist.launch.survey', 'growth', 'waitlist.launch', 'both'],
  ['newsletter', 'growth', null, 'both'],
];
const FLAGS = new Map(REGISTRY.map(([key, group, parent, scope, def = true]) => [key, { key, group, parent, scope, default: def }]));
const GROUPS = [...new Set(REGISTRY.map((r) => r[1]))];

// ------------------------------------------------------------------------------------------------ route rules
const ORDERS = /^\/users\/[^/]+\/orders$/;
const R = (method, re, opts = {}) => ({ method, re, ...opts });
const typeIs = (t) => (req) => (req.body && typeof req.body === 'object' ? (req.body.type || 'limit') : 'limit') === t;
const fractionalCount = (req) => { const b = req.body || {}; const raw = b.count_fp ?? b.count; return raw != null && /\.\d*[1-9]/.test(String(raw)); };
const bodyOf = (req) => (req.body && typeof req.body === 'object' ? req.body : {});
const nonZeroSub = (req) => { const v = bodyOf(req).subaccount; return v != null && v !== '' && Number(v) !== 0; };
const PERPS_ORDERS = /^\/perps\/orders$/;
const ROUTE_RULES = {
  trading: [R('POST', ORDERS), R('POST', /^\/users\/[^/]+\/orders\/[^/]+\/(amend|decrease)$/)],
  'trading.limit_orders': [R('POST', ORDERS, { when: typeIs('limit') })],
  'trading.market_orders': [R('POST', ORDERS, { when: typeIs('market') })],
  'trading.dollars_orders': [R('POST', ORDERS, { when: typeIs('dollars') })],
  'trading.flip_sell': [R('GET', /^\/users\/[^/]+\/positions\/[^/]+\/flip_preview$/)],
  'trading.fractional': [R('POST', ORDERS, { when: fractionalCount })],
  'trading.scalar': [R('POST', ORDERS, { when: (req, ctx) => ctx.marketType(req.body && req.body.ticker) === 'scalar' })],
  'trading.collateral_return': [R('*', /^\/users\/[^/]+\/collateral_returns(\/refresh)?$/)],
  'trading.rolling': [R('GET', /^\/rolling\//)],
  combos: [R('*', /^\/multivariate_event_collections(\/|$)/), R('GET', /^\/combos\//), R('*', /^\/users\/[^/]+\/(combos|combo_slip)$/)],
  'combos.rfq': [R('*', /^\/communications\//)],
  perps: [R('*', /^\/perps\/(?!admin\/)/)],
  'perps.subaccounts': [R('*', /^\/perps\/subaccounts(\/|$)/, { user: true }), R('POST', /^\/perps\/(orders|transfers|order_groups)$/, { when: nonZeroSub })],
  'perps.portfolio_margin': [R('*', /^\/perps\/subaccounts(\/[^/]+)?$/, { when: (req) => bodyOf(req).margin_mode === 'cross' })],
  'perps.order_groups': [R('*', /^\/perps\/order_groups(\/|$)/, { user: true }), R('POST', PERPS_ORDERS, { when: (req) => !!bodyOf(req).order_group_id })],
  'perps.amend': [R('POST', /^\/perps\/orders\/[^/]+\/(amend|decrease)$/)],
  'perps.trailing_stops': [R('PUT', /^\/perps\/positions\/[^/]+\/exit_trigger$/, { when: (req) => String(bodyOf(req).kind || '').toLowerCase() === 'trailing' })],
  'perps.fractional': [R('POST', PERPS_ORDERS, { when: fractionalCount })],
  'perps.apy': [R('GET', /^\/perps\/apy$/, { user: true })],
  'perps.referrals': [R('*', /^\/perps\/referrals(\/|$)/, { user: true })],
  'perps.waitlist': [R('*', /^\/perps\/waitlist$/, { user: true })],
  sports: [R('GET', /^\/sports\//), R('GET', /^\/live_data\/(feed|batch|milestone\/|[a-z_]+\/milestone\/)/), R('GET', /^\/milestones(\/|$)/)],
  'sports.lines': [R('POST', ORDERS, { when: (req, ctx) => ctx.isLinesMarket(req.body && req.body.ticker) })],
  social: [R('*', /^\/social\//), R('*', /^\/users\/[^/]+\/social\//), R('GET', /^\/search\/social_profiles$/), R('*', /^\/users\/[^/]+\/notifications\/social_account_subscriptions$/)],
  'social.chat': [R('GET', /^\/events\/[^/]+\/chat$/), R('*', /^\/users\/[^/]+\/chat\//)],
  'social.group_chat': [R('*', /^\/users\/[^/]+\/groups(\/|$)/)],
  watchlist: [R('*', /^\/users\/[^/]+\/watchlist(\/|$)/)],
  price_alerts: [R('*', /^\/users\/[^/]+\/notifications\/(custom_price_targets|price_movement_subscriptions)$/)],
  'payments.deposits': [R('POST', /^\/users\/[^/]+\/deposits$/), R('POST', /^\/users\/[^/]+\/(debit\/payment|debit\/payment_session|bank_link\/deposit|crypto\/simulate_deposit)$/), R('PUT', /^\/users\/[^/]+\/crypto\/account$/), R('POST', /^\/payments\/tokenize\/card$/)],
  'payments.withdrawals': [R('POST', /^\/users\/[^/]+\/withdrawals$/), R('POST', /^\/users\/[^/]+\/(debit|bank_link|crypto)\/withdrawal$/)],
  'payments.card': [R('*', /^\/users\/[^/]+\/debit\//), R('POST', /^\/payments\/tokenize\/card$/)],
  'payments.bank': [R('*', /^\/users\/[^/]+\/(bank_link|banks)\//)],
  'payments.crypto': [R('*', /^\/users\/[^/]+\/crypto\//), R('GET', /^\/payments\/supported_networks$/), R('GET', /^\/users\/[^/]+\/withdrawal_addresses$/)],
  interest: [R('GET', /^\/users\/[^/]+\/interest$/)],
  'identity.kyc': [R('*', /^\/users\/[^/]+\/(sign_up|docv|verify_phone)(\/|$)/), R('*', /^\/docv\//, { public: true }), R('POST', /^\/resume_sign_up$/), R('GET', /^\/address\/suggest$/)],
  'accounts.signup': [R('POST', /^\/users$/, { public: true })],
  'signin.password': [R('POST', /^\/log_in$/, { public: true, staffBypass: true }), R('*', /^\/passwords\/reset/, { public: true })],
  'signin.oauth': [R('POST', /^\/oauth\//, { public: true }), R('*', /^\/users\/[^/]+\/oauth(\/|$)/)],
  'signin.google': [R('POST', /^\/oauth\/google\//, { public: true }), R('*', /^\/users\/[^/]+\/oauth\/google(\/|$)/)],
  'signin.apple': [R('POST', /^\/oauth\/apple\//, { public: true }), R('*', /^\/users\/[^/]+\/oauth\/apple(\/|$)/)],
  'signin.passkey': [R('POST', /^\/passkeys\/authentication/, { public: true }), R('POST', /^\/passkeys\/step_up/), R('*', /^\/users\/[^/]+\/passkeys(\/|$)/)],
  ai_summaries: [R('GET', /^\/events\/[^/]+\/ai_summary$/)],
  ballot: [R('*', /^\/ballot\//, { public: true }), R('*', /^\/users\/[^/]+\/ballot$/)],
  incentives: [R('GET', /^\/incentive_programs(\/|$)/), R('*', /^\/users\/[^/]+\/incentives(\/|$)/)],
  rewards: [R('GET', /^\/rewards\//), R('*', /^\/users\/[^/]+\/promo_codes$/)],
  'hubs.widgets': [R('GET', /^\/hubs\//), R('GET', /^\/series\/[^/]+\/events\/[^/]+\/forecast_history$/)],
  'pwa.push': [R('GET', /^\/push\/vapid_public_key$/), R('*', /^\/users\/[^/]+\/push_subscriptions(\/|$)/), R('*', /^\/users\/[^/]+\/notifications\/push_devices(\/|$)/)],
  currency_switch: [R('PUT', /^\/admin\/settings\/currency$/, { admin: true, when: (req) => !!(req.body && req.body.display_currency) })],
  'play.free_deposits': [R('GET', /^\/users\/[^/]+\/play_money$/)],
  central_bank: [R('GET', /^\/central_bank(\/|$)/)],
  heist: [R('*', /^\/users\/[^/]+\/heists(\/|$)/), R('GET', /^\/central_bank\/(feed|most_wanted)$/)],
  // Phase 7 (CLONE_SPEC.md §35). /trade-api is gated by server/trade-api.js (api.keys / api.trading per key owner).
  'api.keys': [R('*', /^\/users\/[^/]+\/api_keys(\/|$)/, { user: true })],
  'api.demo': [R('*', /^\/developer\/demo_credentials$/, { user: true })],
  developer_portal: [R('GET', /^\/developer\/portal$/)],
  status_page: [R('GET', /^\/status$/)],
  // Phase 7A (CLONE_SPEC.md §36). Leaving (unsubscribe, delete, manage by token) is core: it works with every flag off.
  'waitlist.launch': [R('*', /^\/waitlists\/real_money_launch(\/(join|guest_join))?$/, { public: true }), R('POST', /^\/waitlists\/confirm$/, { public: true })],
  'waitlist.launch.public_count': [R('GET', /^\/waitlists\/real_money_launch\/progress$/, { public: true })],
  'waitlist.launch.survey': [R('PUT', /^\/waitlists\/real_money_launch\/survey$/, { public: true })],
  newsletter: [R('*', /^\/admin\/waitlists\/[^/]+\/(newsletters|launch_email)(\/|$)/, { admin: true })],
};
// Platform core without a flag: sessions and sign-out, the account and its security, market data and portfolio reads,
// cancelling orders (always possible), responsible-trading limits, notifications inbox, content, admin. Used by the
// enforcement test; the gate itself only needs ROUTE_RULES.
const CORE_ROUTES = [
  /^\/trade-api\//, /^\/v1\/(site_config|help|promos|bff|live_data\/count|search\/series|categories|calendar|events\/[^/]+(\/related)?|exchange\/|content\/|pages(\/|$)|session|auth\/|log_out|log_in_mfa|step_up|feature_flags|play_mode|identity\/(config|countries)|verify_email|dev\/|payments\/webhooks\/)/,
  /^\/v1\/users\/[^/]+$/, /^\/v1\/users\/[^/]+\/(properties|balance|positions|portfolio|fills|settlement_history|transactions|history|recently_visited|orders(\/[^/]+)?$|orders\/(queue_positions|[^/]+\/queue_position)$)/,
  /^\/v1\/users\/[^/]+\/(notifications(\/read|\/[^/]+\/read|\/preferences|\/settings\/[^/]+|\/deliveries)?$|deposit_limit|trading_limits|daily_session_time_limit|mfa|security|sessions|password|email|withdrawal_mfa|identity$|email_verification|data_export|close_account|sign_in_methods|api_keys|geolocation|withdrawal_holds|preferences|marketing_consent|connected_apps|activity|tax_documents|payments\/|withdrawal_times|credit_history|deposits$|withdrawals$|money_controls)/,
  /^\/v1\/admin\//, /^\/v1\/perps\/admin\//, /^\/v1\/push\//, /^\/v1\/oauth\/link$/,
  /^\/mock-oidc\//, /^\/(manifest\.webmanifest|sw\.js|offline\.html|content-bundle\.js|content-theme\.css)$/, /^RE:/,
  /^\/docs\/(openapi|asyncapi|fix)\.json$/, // Phase 7: generated API documents (flag developer_portal, checked in server/dev-portal.js)
  /^\/v1\/waitlists\/(manage|unsubscribe|delete|one_click_unsubscribe)$/, /^\/v1\/waitlists\/real_money_launch\/(unsubscribe|me)$/, // Phase 7A: leaving a list always works (§36)
];
// Every mount* module wired in server/app.js → the flag that switches it (or 'core'). Checked by the enforcement test.
const MODULE_FLAGS = {
  mountFeatures: 'core', mountRolling: 'trading.rolling', mountPerps: 'perps', mountPerpsOps: 'perps', mountCombos: 'combos', mountHistory: 'core', mountOrders: 'core', mountPositions: 'core',
  mountTradingCore: 'trading', mountSports: 'sports', mountAdmin: 'core', mountChat: 'social.chat', mountCommunity: 'social', mountWebPush: 'pwa.push', mountIdentity: 'identity.kyc',
  mountAccountArea: 'core', mountPayments: 'payments.deposits', mountMarketsContent: 'incentives', mountCms: 'core', mountFlags: 'core', mountPlayMode: 'play.free_deposits', mountCentralBank: 'central_bank',
  mountApiKeys: 'api.keys', mountTradeApi: 'core', mountDeveloperPortal: 'developer_portal', mountFixAdmin: 'api.fix', // Phase 7 (CLONE_SPEC.md §35); /trade-api/v2 public data is core
  mountWaitlists: 'waitlist.launch', // Phase 7A (CLONE_SPEC.md §36); the Perps list is switched by perps.waitlist
};
// Background jobs per flag (paused while the flag is globally off). The modules ask jobOn(key) in their tick handlers.
const JOB_FLAGS = ['trading.rolling', 'combos', 'perps', 'perps.apy', 'perps.referrals', 'sports', 'social', 'social.chat', 'interest', 'incentives', 'notify.email', 'notify.push', 'pwa.push', 'heist', 'central_bank',
  'api.keys', 'api.ws', 'api.fix', // Phase 7: key expiry sweep, public WebSocket sessions, the FIX acceptor
  'newsletter']; // Phase 7A: the waitlist newsletter outbox

// One-time, audited flag migrations for databases that existed before a default changed. Each runs once per database
// (a meta marker), so a later admin "off" is never switched back on; a new database starts with the new default (or the
// `defaults` start option) and only records the marker.
const MIGRATIONS = [
  { id: 'perps_waitlist_on_2026_11_08', key: 'perps.waitlist', enabled: true, reason: 'owner decision 2026-11-08' }, // CLONE_SPEC.md §36.1
];
const PERCENT = (n) => Number.isInteger(n) && n >= 0 && n <= 100;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS feature_flags (key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, kill INTEGER NOT NULL DEFAULT 0, rollout_pct INTEGER NOT NULL DEFAULT 100,
  allow_users TEXT NOT NULL DEFAULT '[]', deny_users TEXT NOT NULL DEFAULT '[]', allow_roles TEXT NOT NULL DEFAULT '[]', deny_roles TEXT NOT NULL DEFAULT '[]',
  allow_regions TEXT NOT NULL DEFAULT '[]', deny_regions TEXT NOT NULL DEFAULT '[]', starts_at INTEGER, ends_at INTEGER, version INTEGER NOT NULL DEFAULT 0, updated_at TEXT, updated_by TEXT);
CREATE TABLE IF NOT EXISTS feature_flag_history (id TEXT PRIMARY KEY, flag_key TEXT NOT NULL, version INTEGER NOT NULL, action TEXT NOT NULL, before_json TEXT, after_json TEXT NOT NULL,
  reason TEXT NOT NULL, actor_id TEXT, actor_email TEXT, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_flag_history_key ON feature_flag_history(flag_key, ts);
`;
const LISTS = ['allow_users', 'deny_users', 'allow_roles', 'deny_roles', 'allow_regions', 'deny_regions'];
const EXTRA_ROLES = ['guest', 'user', 'staff'];

// Stable rollout bucket 0-99 for (flag, user): SHA-256 of "<key>:<uid>", first 4 bytes, mod 100.
const bucket = (key, uid) => crypto.createHash('sha256').update(`${key}:${uid}`).digest().readUInt32BE(0) % 100;

function parseEnvOverrides(s) {
  const out = {};
  for (const part of String(s || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^([a-z0-9_.]+)\s*=\s*(on|off|1|0|true|false)$/i.exec(part);
    if (m && FLAGS.has(m[1])) out[m[1]] = /^(on|1|true)$/i.test(m[2]);
  }
  return out;
}

function createFlags({ db, engine, options = {} }) {
  db.exec(SCHEMA);
  engine.setMaxListeners(Math.max(engine.getMaxListeners(), 64)); // one tick listener per module and job
  // A database that already had flags predates this build: one-time migrations below apply to it (MIGRATIONS).
  const existing = db.prepare('SELECT COUNT(*) c FROM feature_flags').get().c > 0;
  const hadRow = new Set(db.prepare('SELECT key FROM feature_flags').all().map((r) => r.key));
  // `defaults` (start option): the state a NEW row starts with, for test servers that need e.g. open Perps
  // (`flags: { defaults: { 'perps.waitlist': false } }`); unlike `overrides` an admin can still change it afterwards.
  const defaults = options.defaults || {};
  const ins = db.prepare('INSERT INTO feature_flags(key,enabled,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING');
  for (const f of FLAGS.values()) {
    let on = Object.prototype.hasOwnProperty.call(defaults, f.key) ? !!defaults[f.key] : f.default;
    // An existing database without the row gets the state it had before (off): its migration switches it on, audited.
    if (existing && !hadRow.has(f.key) && MIGRATIONS.some((m) => m.key === f.key)) on = false;
    ins.run(f.key, on ? 1 : 0, nowIso());
  }
  const overrides = { ...parseEnvOverrides(process.env.FEATURE_FLAGS), ...(options.overrides || {}) };
  const rowVo = (r) => ({ key: r.key, enabled: !!r.enabled, kill: !!r.kill, rollout_pct: r.rollout_pct, ...Object.fromEntries(LISTS.map((k) => [k, JSON.parse(r[k] || '[]')])), starts_at: r.starts_at, ends_at: r.ends_at, version: r.version, updated_at: r.updated_at, updated_by: r.updated_by });
  const state = new Map();
  const reload = () => { state.clear(); for (const r of db.prepare('SELECT * FROM feature_flags').all()) if (FLAGS.has(r.key)) state.set(r.key, rowVo(r)); };
  reload();
  const meta = (k) => db.prepare('SELECT value FROM meta WHERE key=?').get(k)?.value;
  let version = Number(meta('flags_version') || 0);
  const bump = () => { version += 1; db.prepare("INSERT INTO meta(key,value) VALUES('flags_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(version)); return version; };
  // Late-bound context (set by mountFlags once admin / identity exist).
  const ctx = { rolesOf: () => [], regionOf: () => null, legacy: () => ({}), userById: (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id) };
  // Legacy Admin › Settings feature switches (social / perps / combos, CLONE_SPEC §18) stay in force: both must be on.
  const LEGACY = { social: 'social', perps: 'perps', combos: 'combos' };

  function inSchedule(f, now) { return !(f.starts_at && now < f.starts_at) && !(f.ends_at && now >= f.ends_at); }
  // Global part of the evaluation (no user): override, kill, enabled, schedule, parent, legacy switch.
  function globalState(key, now = Date.now(), seen = new Set()) {
    const f = state.get(key);
    if (!f) return { on: false, reason: 'unknown_flag' };
    if (Object.prototype.hasOwnProperty.call(overrides, key)) return { on: !!overrides[key], reason: 'env_override', forced: true };
    if (f.kill) return { on: false, reason: 'kill_switch' };
    if (!f.enabled) return { on: false, reason: 'off' };
    if (!inSchedule(f, now)) return { on: false, reason: 'schedule' };
    if (LEGACY[key] && ctx.legacy()[LEGACY[key]] === false) return { on: false, reason: 'legacy_switch' };
    const parent = FLAGS.get(key).parent;
    if (parent && !seen.has(parent)) { seen.add(parent); const p = globalState(parent, now, seen); if (!p.on) return { on: false, reason: `parent:${parent}` }; }
    return { on: true, reason: 'on' };
  }
  // Full evaluation for one principal: { uid?, roles?, region? }.
  function evaluate(key, who = {}, now = Date.now()) {
    const g = globalState(key, now);
    if (!g.on || g.forced) return g;
    const chain = [];
    for (let k = key; k; k = FLAGS.get(k).parent) chain.unshift(k);
    const roles = who.uid ? ['user', ...(who.roles || [])] : ['guest'];
    if (who.roles && who.roles.length) roles.push('staff');
    for (const k of chain) {
      const f = state.get(k);
      if (who.uid && f.deny_users.includes(who.uid)) return { on: false, reason: `deny_user:${k}` };
      if (f.deny_roles.some((r) => roles.includes(r))) return { on: false, reason: `deny_role:${k}` };
      if (who.region && f.deny_regions.includes(who.region)) return { on: false, reason: `deny_region:${k}` };
      const allowed = (who.uid && f.allow_users.includes(who.uid)) || f.allow_roles.some((r) => roles.includes(r));
      if (allowed) continue;
      if (f.allow_regions.length && !(who.region && f.allow_regions.includes(who.region))) return { on: false, reason: `region:${k}` };
      if (f.rollout_pct < 100 && !(who.uid && bucket(k, who.uid) < f.rollout_pct)) return { on: false, reason: `rollout:${k}` };
    }
    return { on: true, reason: 'on' };
  }
  const whoOf = (req) => (req && req.auth ? { uid: req.auth.user.id, roles: ctx.rolesOf(req.auth.user), region: ctx.regionOf(req) } : { region: req ? ctx.regionOf(req) : null });
  const whoOfUid = (uid) => { const u = uid ? ctx.userById(uid) : null; return u ? { uid: u.id, roles: ctx.rolesOf(u), region: null } : {}; };
  // on(key, {req}) / on(key, {uid}) / on(key): the request's caller, a user without a request, or the global state.
  function on(key, { req, uid } = {}) {
    if (req) return evaluate(key, whoOf(req)).on;
    if (uid) return evaluate(key, whoOfUid(uid)).on;
    return globalState(key).on;
  }
  const jobOn = (key) => globalState(key).on;
  // The bundle for one principal: booleans only (no targeting lists), plus when it may change next (schedules).
  // bundleExtras (server/play-mode.js) add the caller's play-mode and money-control state.
  const bundleExtras = [];
  function bundle(req) {
    const who = whoOf(req); const now = Date.now();
    const flags = {};
    for (const k of FLAGS.keys()) flags[k] = evaluate(k, who, now).on;
    let next = null;
    for (const f of state.values()) for (const t of [f.starts_at, f.ends_at]) if (t && t > now && (next == null || t < next)) next = t;
    const out = { flags, version, next_change_time: next ? new Date(next).toISOString() : null };
    for (const fn of bundleExtras) Object.assign(out, fn(req));
    return out;
  }
  function disabledError(key) {
    const e = new ApiError(403, 'feature_disabled', S.s('flag.disabled'), key);
    e.toJSON = () => ({ error: { code: 'feature_disabled', message: e.message, details: key, feature: key } });
    return e;
  }

  // ---------------------------------------------------------------- the gate (app.use('/v1', …) in server/app.js)
  const gates = []; // extra gates (money controls, play mode): (req) => ApiError | null
  const gctx = {
    marketType: (t) => (t ? db.prepare('SELECT market_type FROM markets WHERE ticker=?').get(String(t))?.market_type : null),
    isLinesMarket: (t) => { if (!t) return false; try { return !!db.prepare('SELECT 1 FROM sports_lines WHERE market_ticker=?').get(String(t)); } catch { return false; } },
  };
  const staffEmail = (email) => { const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(email || '').trim().toLowerCase()); return !!(u && ctx.rolesOf(u).length); };
  function matchRules(req) {
    const hits = [];
    for (const [key, rules] of Object.entries(ROUTE_RULES)) {
      for (const r of rules) {
        if (r.method !== '*' && r.method !== req.method) continue;
        if (!r.re.test(req.path)) continue;
        if (r.when && !r.when(req, gctx)) continue;
        hits.push([key, r]);
        break;
      }
    }
    return hits;
  }
  function gate(req, res, next) {
    try {
      // Requests the route will refuse on authorization grounds are left to it: those errors come first.
      const own = /^\/users\/([^/]+)\//.exec(req.path);
      if (own && (!req.auth || own[1] !== req.auth.user.id)) return next();
      const isAdminPath = /^\/admin\//.test(req.path);
      for (const [key, r] of matchRules(req)) {
        if (isAdminPath && !r.admin) continue;
        if (!req.auth && !r.public && (req.method !== 'GET' || r.user)) continue; // the route answers 401 first (r.user: signed-in reads too)
        if (r.staffBypass && staffEmail(req.body && req.body.email)) continue; // staff can always sign in to fix a flag
        if (!on(key, { req })) return next(disabledError(key));
      }
      for (const g of gates) { const err = g(req); if (err) return next(err); }
      next();
    } catch (e) { next(e); }
  }

  // ---------------------------------------------------------------- changes
  const listeners = [];
  function emitChange(keys) {
    const v = bump();
    for (const fn of listeners) { try { fn(keys); } catch (e) { console.error('flags listener', e); } }
    engine.emit('feature_flags', { version: v, keys });
  }
  // Schedule boundaries reached without an admin change: tell the clients (checked every engine tick).
  let lastTick = Date.now();
  engine.on('tick', () => {
    const now = Date.now();
    const crossed = [...state.values()].filter((f) => [f.starts_at, f.ends_at].some((t) => t && t > lastTick && t <= now)).map((f) => f.key);
    lastTick = now;
    if (crossed.length) emitChange(crossed);
  });
  function save(key, next, { action, reason, actor }) {
    const before = state.get(key);
    const after = { ...before, ...next, version: before.version + 1, updated_at: nowIso(), updated_by: actor?.id || null };
    tx(db, () => {
      db.prepare(`UPDATE feature_flags SET enabled=?, kill=?, rollout_pct=?, ${LISTS.map((k) => `${k}=?`).join(', ')}, starts_at=?, ends_at=?, version=?, updated_at=?, updated_by=? WHERE key=?`)
        .run(after.enabled ? 1 : 0, after.kill ? 1 : 0, after.rollout_pct, ...LISTS.map((k) => JSON.stringify(after[k])), after.starts_at ?? null, after.ends_at ?? null, after.version, after.updated_at, after.updated_by, key);
      db.prepare('INSERT INTO feature_flag_history(id,flag_key,version,action,before_json,after_json,reason,actor_id,actor_email,ts) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(newId('ffh_'), key, after.version, action, JSON.stringify(before), JSON.stringify(after), reason, actor?.id || null, actor?.email || null, Date.now());
    });
    reload();
    emitChange([key]);
    return { before, after: state.get(key) };
  }

  return {
    REGISTRY, FLAGS, GROUPS, ROUTE_RULES, CORE_ROUTES, MODULE_FLAGS, JOB_FLAGS, LISTS, EXTRA_ROLES, existingDb: existing, defaultsOption: defaults,
    on, jobOn, evaluate, globalState, bundle, bundleExtras, gate, gates, disabledError, save, reload, state, ctx, listeners, overrides, bucket, changed: emitChange,
    get version() { return version; },
  };
}

// Runs each pending migration once: on an existing database it sets the flag (history row with the reason, hash-chained
// admin audit row, live nudge); on a new one it only records the marker. Idempotent across restarts.
function runMigrations({ db, flags, admin }) {
  const marker = (id) => `flag_migration:${id}`;
  for (const m of MIGRATIONS) {
    if (db.prepare('SELECT 1 FROM meta WHERE key=?').get(marker(m.id))) continue;
    const before = flags.state.get(m.key);
    let result = 'new_database';
    if (flags.existingDb && !Object.prototype.hasOwnProperty.call(flags.defaultsOption, m.key)) {
      if (before && before.enabled !== m.enabled) {
        const r = flags.save(m.key, { enabled: m.enabled }, { action: 'migration', reason: m.reason, actor: null });
        admin.audit({}, 'flags.migration', 'feature_flag', m.key, r.before, r.after, m.reason);
        result = 'applied';
      } else result = 'already_set';
    }
    db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING').run(marker(m.id), JSON.stringify({ result, time: nowIso() }));
  }
}

// ------------------------------------------------------------------------------------------------ routes
function mountFlags({ v1, db, flags, admin, auth, identity }) {
  flags.ctx.rolesOf = (u) => admin.rolesOf(u);
  flags.ctx.regionOf = (req) => { try { return identity.compliance.geoDecision(req).country; } catch { return null; } };
  flags.ctx.legacy = () => { try { return admin.setting('features') || {}; } catch { return {}; } }; // a timer may outlive the database
  runMigrations({ db, flags, admin });
  const can = admin.can;
  const reasonOf = (b) => { const r = String((b && b.reason) || '').trim(); if (r.length < 3 || r.length > 500) throw new ApiError(400, 'validation_failed', 'validation failed', 'reason: a reason of 3-500 characters is required'); return r; };
  const emailOf = (id) => db.prepare('SELECT email FROM users WHERE id=?').get(id)?.email || id;
  const flagVo = (k) => {
    const f = flags.state.get(k); const def = flags.FLAGS.get(k); const g = flags.globalState(k);
    return { ...f, group: def.group, parent: def.parent, scope: def.scope, allow_users: f.allow_users.map((id) => ({ id, email: emailOf(id) })), deny_users: f.deny_users.map((id) => ({ id, email: emailOf(id) })),
      starts_time: f.starts_at ? new Date(f.starts_at).toISOString() : null, ends_time: f.ends_at ? new Date(f.ends_at).toISOString() : null,
      effective: g.on, effective_reason: g.reason, env_override: Object.prototype.hasOwnProperty.call(flags.overrides, k) ? flags.overrides[k] : null,
      routes: (flags.ROUTE_RULES[k] || []).map((r) => `${r.method} ${r.re.source}`), job: flags.JOB_FLAGS.includes(k) };
  };
  // Public: the caller's evaluated flags (booleans only).
  v1.get('/feature_flags', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(flags.bundle(req)); });
  v1.get('/admin/flags', can('settings.write'), (req, res) => res.json({ flags: [...flags.FLAGS.keys()].map(flagVo), groups: flags.GROUPS, roles: [...flags.EXTRA_ROLES, ...Object.keys(require('./admin').ROLE_PERMS)], version: flags.version }));
  v1.get('/admin/flags/:key', can('settings.write'), (req, res) => {
    const k = String(req.params.key);
    if (!flags.FLAGS.has(k)) throw E.notFound();
    const hist = db.prepare('SELECT * FROM feature_flag_history WHERE flag_key=? ORDER BY ts DESC LIMIT 200').all(k).map((h) => ({ id: h.id, version: h.version, action: h.action, before: JSON.parse(h.before_json || 'null'), after: JSON.parse(h.after_json), reason: h.reason, actor_email: h.actor_email, time: new Date(h.ts).toISOString() }));
    res.json({ flag: flagVo(k), history: hist });
  });
  // Resolve user references (ids or emails) to ids; unknown ones are a validation error.
  const resolveUsers = (list, field, errs) => {
    const out = [];
    for (const x of list) {
      const s = String(x || '').trim();
      const u = db.prepare('SELECT id FROM users WHERE id=? OR email=?').get(s, s.toLowerCase());
      if (!u) { errs[field] = `unknown user ${s.slice(0, 80)}`; continue; }
      if (!out.includes(u.id)) out.push(u.id);
    }
    return out;
  };
  function parseChange(b) {
    const errs = {}; const next = {};
    if (b.enabled !== undefined) { if (typeof b.enabled !== 'boolean') errs.enabled = 'must be true or false'; else next.enabled = b.enabled; }
    if (b.kill !== undefined) { if (typeof b.kill !== 'boolean') errs.kill = 'must be true or false'; else next.kill = b.kill; }
    if (b.rollout_pct !== undefined) { const n = Number(b.rollout_pct); if (b.rollout_pct === '' || !PERCENT(n)) errs.rollout_pct = 'must be a whole number from 0 to 100'; else next.rollout_pct = n; }
    for (const k of LISTS) {
      if (b[k] === undefined) continue;
      const raw = typeof b[k] === 'string' ? b[k].split(/[\s,]+/).filter(Boolean) : b[k];
      if (!Array.isArray(raw) || raw.length > 500 || raw.some((x) => typeof x !== 'string' || x.length > 254)) { errs[k] = 'must be a list of at most 500 entries'; continue; }
      if (k.endsWith('_users')) next[k] = resolveUsers(raw, k, errs);
      else if (k.endsWith('_roles')) { const roles = [...flags.EXTRA_ROLES, ...Object.keys(require('./admin').ROLE_PERMS)]; const bad = raw.filter((r) => !roles.includes(r)); if (bad.length) errs[k] = `unknown role ${bad[0]}`; else next[k] = [...new Set(raw)]; }
      else { const up = raw.map((r) => r.toUpperCase()); if (up.some((r) => !/^[A-Z]{2}$/.test(r))) errs[k] = 'use 2-letter country codes'; else next[k] = [...new Set(up)]; }
    }
    for (const [k, col] of [['starts_at', 'starts_at'], ['ends_at', 'ends_at']]) {
      if (b[k] === undefined) continue;
      if (b[k] === null || b[k] === '') { next[col] = null; continue; }
      const t = typeof b[k] === 'number' ? b[k] : Date.parse(String(b[k]));
      if (!Number.isFinite(t) || t < 0 || t > Date.now() + 5 * 366 * 86400000) errs[k] = 'must be a date and time (ISO 8601) or empty';
      else next[col] = Math.round(t);
    }
    return { errs, next };
  }
  v1.put('/admin/flags/:key', can('settings.write'), (req, res) => {
    const k = String(req.params.key);
    if (!flags.FLAGS.has(k)) throw E.notFound();
    const b = req.body || {};
    const known = new Set(['enabled', 'kill', 'rollout_pct', ...LISTS, 'starts_at', 'ends_at', 'reason']);
    const unknown = Object.keys(b).filter((x) => !known.has(x));
    const { errs, next } = parseChange(b);
    if (unknown.length) errs[unknown[0]] = 'is not a flag field';
    const reason = (() => { try { return reasonOf(b); } catch (e) { errs.reason = 'a reason of 3-500 characters is required'; return null; } })();
    if (!Object.keys(next).length && !errs.reason && !unknown.length) errs.body = 'nothing to change';
    const merged = { ...flags.state.get(k), ...next };
    if (merged.starts_at && merged.ends_at && merged.ends_at <= merged.starts_at) errs.ends_at = 'must be after the start';
    if (Object.keys(errs).length) { const e = new ApiError(400, 'validation_failed', 'validation failed', Object.entries(errs).map(([a, m]) => `${a}: ${m}`).join('; ')); e.toJSON = () => ({ error: { code: e.code, message: e.message, details: e.details, fields: errs } }); throw e; }
    auth.assertFresh(req, 'feature_flag_change'); // step-up (CLONE_SPEC.md §22.6)
    const was = flags.state.get(k);
    const action = next.kill === true && !was.kill ? 'kill' : next.kill === false && was.kill ? 'unkill' : 'update';
    const r = flags.save(k, next, { action, reason, actor: req.auth.user });
    admin.audit(req, `flags.${action}`, 'feature_flag', k, r.before, r.after, reason);
    res.json({ flag: flagVo(k) });
  });
  // Kill switch: one call, same reason / step-up / audit rules.
  v1.post('/admin/flags/:key/kill', can('settings.write'), (req, res) => {
    const k = String(req.params.key);
    if (!flags.FLAGS.has(k)) throw E.notFound();
    const reason = reasonOf(req.body);
    auth.assertFresh(req, 'feature_flag_change');
    const r = flags.save(k, { kill: true }, { action: 'kill', reason, actor: req.auth.user });
    admin.audit(req, 'flags.kill', 'feature_flag', k, r.before, r.after, reason);
    res.json({ flag: flagVo(k) });
  });
}

module.exports = { createFlags, mountFlags, REGISTRY, ROUTE_RULES, CORE_ROUTES, MODULE_FLAGS, JOB_FLAGS, MIGRATIONS, bucket, parseEnvOverrides };
