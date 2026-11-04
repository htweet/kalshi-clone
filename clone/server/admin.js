'use strict';
// Admin panel + CMS (CLONE_SPEC.md §18). Everything here is persisted in SQLite tables created below with
// CREATE TABLE IF NOT EXISTS; no existing table's schema is changed.
//
// Quantity rule: this module never interprets raw quantity columns itself. Volumes, positions and orders come from
// engine.quote(), the serializers in serialize.js, or the user-facing routes (dispatched internally through the v1
// router as the target user, see asUser()). The only quantity aggregates computed here (per-day trade volume for the
// reports dashboard) are converted with util.ufp / util.UNITS, the same helpers the serializers use. Money columns
// (*_cents) are integer cents.
const CS = require('./content/currency-strings'); // keyed user-facing wording (CLONE_SPEC.md §30)
const fs = require('node:fs');
const { tx } = require('./db');
const { nowIso, newId, dollars, ufp, usd, UNITS, E, ApiError, slugify } = require('./util');
const { marketVo, scalarVo } = require('./serialize');
const { STRUCTURES } = require('./pricing'); // Phase 5A price grids (CLONE_SPEC.md §28.1)
const { CATEGORIES } = require('./features');
const auditChain = require('./audit-chain');
const currency = require('./currency'); // display currency and new-account defaults (CLONE_SPEC.md §30)
const { check: checkBody } = require('./validate');

// ----------------------------------------------------------------------------------------------- roles
const PERMS = ['catalog.read', 'catalog.write', 'content.write', 'content.publish', 'resolution.write', 'markets.ops', 'perps.ops', 'users.read', 'users.support', 'users.money',
  'social.moderate', 'announce', 'reports.read', 'settings.write', 'roles.write', 'audit.read'];
const ROLE_PERMS = {
  admin: PERMS,
  editor: ['catalog.read', 'catalog.write', 'content.write'],
  resolver: ['catalog.read', 'resolution.write'],
  risk: ['catalog.read', 'markets.ops', 'perps.ops', 'reports.read'],
  support: ['users.read', 'users.support', 'announce'],
  moderator: ['social.moderate'],
  // CMS (CLONE_SPEC.md §32.2): editors save drafts and preview (content.write); publishers also publish, schedule and roll back.
  publisher: ['catalog.read', 'content.write', 'content.publish'],
};
const ROLES = Object.keys(ROLE_PERMS);
const COMBO_SERIES = 'PLXCOMBO';
const FLASH_SERIES = 'PLXFLASH';
// Taker fee coefficient: engine-held, persisted in admin_settings and editable at runtime (gap G7, CLONE_SPEC §21.9).
const { setTakerFeeCoefficient, takerFeeCoefficient, DEFAULT_TAKER_FEE_COEFFICIENT } = require('./engine');
const DEFAULT_APY = 0.035;
const APY_META_KEY = 'setting_interest_apy'; // read by features.js accrueInterest()
const DEFAULT_SETTINGS = {
  features: { social: true, perps: true, combos: true },
  publish_liquidity: { enabled: true, spread_cents: 4, size_contracts: 100, levels: 2 },
  featured_tab: { label: 'Harbor 2026', href: '/category/elections', color: '' },
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS admin_roles (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL, granted_by TEXT, granted_at TEXT NOT NULL, PRIMARY KEY (user_id, role));
CREATE TABLE IF NOT EXISTS admin_audit (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, actor_id TEXT, actor_email TEXT, action TEXT NOT NULL, target_type TEXT NOT NULL DEFAULT '', target_id TEXT NOT NULL DEFAULT '', before_json TEXT, after_json TEXT, reason TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_admin_audit_ts ON admin_audit(ts);
CREATE TABLE IF NOT EXISTS admin_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT);
CREATE TABLE IF NOT EXISTS cms_draft_series (ticker TEXT PRIMARY KEY, title TEXT NOT NULL, slug TEXT NOT NULL, category TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', frequency TEXT NOT NULL DEFAULT 'one_off',
  rules TEXT NOT NULL DEFAULT '', settlement_sources TEXT NOT NULL DEFAULT '[]', fee_type TEXT NOT NULL DEFAULT 'quadratic', fee_multiplier REAL NOT NULL DEFAULT 1, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cms_draft_events (ticker TEXT PRIMARY KEY, series_ticker TEXT NOT NULL, title TEXT NOT NULL, sub_title TEXT NOT NULL DEFAULT '', category TEXT NOT NULL, mutually_exclusive INTEGER NOT NULL DEFAULT 0,
  is_live INTEGER NOT NULL DEFAULT 0, live_label TEXT NOT NULL DEFAULT '', news TEXT NOT NULL DEFAULT '', featured INTEGER NOT NULL DEFAULT 0, icon_color TEXT NOT NULL DEFAULT '', created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cms_draft_markets (ticker TEXT PRIMARY KEY, event_ticker TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', yes_sub_title TEXT NOT NULL, no_sub_title TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#5b5bd6',
  open_time TEXT NOT NULL, close_time TEXT NOT NULL, expected_expiration_time TEXT NOT NULL, settlement_timer_seconds INTEGER NOT NULL DEFAULT 300, rules_primary TEXT NOT NULL DEFAULT '',
  fractional INTEGER NOT NULL DEFAULT 1, initial_price INTEGER NOT NULL DEFAULT 50, seed_liquidity INTEGER NOT NULL DEFAULT 1, import_batch TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cms_event_meta (event_ticker TEXT PRIMARY KEY, icon_color TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cms_hero (event_ticker TEXT PRIMARY KEY, position INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cms_hubs (id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cms_promos (id TEXT PRIMARY KEY, overline TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, subtitle TEXT NOT NULL DEFAULT '', link TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#008751',
  starts_at TEXT, ends_at TEXT, position INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cms_banners (id TEXT PRIMARY KEY, content TEXT NOT NULL, link TEXT NOT NULL DEFAULT '', visibility TEXT NOT NULL DEFAULT 'all', position TEXT NOT NULL DEFAULT 'top',
  starts_at TEXT, ends_at TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cms_nav (category TEXT PRIMARY KEY, label TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS cms_info_cards (id TEXT PRIMARY KEY, title TEXT NOT NULL, subtitle TEXT NOT NULL DEFAULT '', link TEXT NOT NULL, icon TEXT NOT NULL DEFAULT 'info', position INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cms_news (id TEXT PRIMARY KEY, event_ticker TEXT NOT NULL, source TEXT NOT NULL, published_at TEXT NOT NULL, headline TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_cms_news_event ON cms_news(event_ticker);
CREATE TABLE IF NOT EXISTS cms_help (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, body TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS res_resolutions (id TEXT PRIMARY KEY, market_ticker TEXT NOT NULL, result TEXT NOT NULL, source_note TEXT NOT NULL, settlement_delay_sec INTEGER NOT NULL, status TEXT NOT NULL,
  resolved_by TEXT, created_at TEXT NOT NULL, reversed_by TEXT, reversed_at TEXT, reversal_note TEXT);
CREATE INDEX IF NOT EXISTS idx_res_market ON res_resolutions(market_ticker, created_at);
CREATE TABLE IF NOT EXISTS ops_liquidity (market_ticker TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, spread_cents INTEGER NOT NULL, size_contracts INTEGER NOT NULL, levels INTEGER NOT NULL DEFAULT 1,
  fair_cents INTEGER NOT NULL DEFAULT 50, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ops_market_flags (market_ticker TEXT PRIMARY KEY, combo_eligible INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS acct_locks (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, reason TEXT NOT NULL, locked_by TEXT, locked_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mod_reports (id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, content_id TEXT NOT NULL, post_id TEXT NOT NULL,
  author_id TEXT, excerpt TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, resolved_by TEXT, resolved_at TEXT, resolution TEXT);
CREATE INDEX IF NOT EXISTS idx_mod_reports_status ON mod_reports(status, created_at);
CREATE TABLE IF NOT EXISTS mod_hidden (kind TEXT NOT NULL, content_id TEXT NOT NULL, hidden_by TEXT, reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, PRIMARY KEY (kind, content_id));
CREATE TABLE IF NOT EXISTS mod_bans (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, reason TEXT NOT NULL, banned_by TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mod_verified (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, verified_by TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ann_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ann_announcements (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '', segment TEXT NOT NULL, recipients INTEGER NOT NULL,
  template_id TEXT, created_by TEXT, created_at TEXT NOT NULL);
`;

// ----------------------------------------------------------------------------------------------- validation
// Field errors come back as {error:{code:'validation_failed', message, details, fields:{name: msg}}}.
class FieldError extends ApiError {
  constructor(fields) {
    super(400, 'validation_failed', 'validation failed', Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('; '));
    this.fields = fields;
  }
  toJSON() { return { error: { code: this.code, message: this.message, details: this.details, fields: this.fields } }; }
}
const isIso = (v) => typeof v === 'string' && v.length >= 10 && Number.isFinite(Date.parse(v));
const iso = (v) => new Date(Date.parse(v)).toISOString();
const SAFE_LINK = /^(\/(?!\/)[^\s]*|https:\/\/[^\s]+)$/;
// Field parsers: (value, present) -> clean value, or throw a string message.
const F = {
  text: (min, max, def) => ({ def, parse: (v) => { const s = String(v ?? '').trim(); if (s.length < min) throw min === 1 ? 'is required' : `must be at least ${min} characters`; if (s.length > max) throw `must be at most ${max} characters`; return s; } }),
  int: (min, max, def) => ({ def, parse: (v) => { const n = Number(v); if (v === '' || v == null || !Number.isInteger(n) || n < min || n > max) throw `must be a whole number from ${min} to ${max}`; return n; } }),
  optNum: () => ({ def: null, parse: (v) => { if (v === '' || v == null) return null; const n = Number(v); if (!Number.isFinite(n) || Math.abs(n) > 1e12) throw 'must be a number'; return n; } }),
  num: (min, max, def) => ({ def, parse: (v) => { const n = Number(v); if (v === '' || v == null || !Number.isFinite(n) || n < min || n > max) throw `must be a number from ${min} to ${max}`; return n; } }),
  bool: (def) => ({ def, parse: (v) => (v === true || v === 1 || v === '1' || v === 'true' || v === 'on' ? 1 : 0) }),
  oneOf: (list, def) => ({ def, parse: (v) => { if (!list.includes(v)) throw `must be one of ${list.join(', ')}`; return v; } }),
  category: () => ({ parse: (v) => { if (!CATEGORIES.includes(v)) throw 'must be one of the site categories'; return v; } }),
  color: (def) => ({ def, parse: (v) => { if (!/^#[0-9a-fA-F]{6}$/.test(String(v || ''))) throw 'must be a #rrggbb colour'; return String(v).toLowerCase(); } }),
  optColor: () => ({ def: '', parse: (v) => { if (v === '' || v == null) return ''; if (!/^#[0-9a-fA-F]{6}$/.test(String(v))) throw 'must be a #rrggbb colour or empty'; return String(v).toLowerCase(); } }),
  link: (optional) => ({ def: optional ? '' : undefined, parse: (v) => { const s = String(v ?? '').trim(); if (!s && optional) return ''; if (!SAFE_LINK.test(s)) throw 'must be a site path starting with / or an https:// URL'; return s; } }),
  time: (optional) => ({ def: optional ? null : undefined, parse: (v) => { if ((v === '' || v == null) && optional) return null; if (!isIso(v)) throw 'must be a date and time'; return iso(v); } }),
  slug: () => ({ parse: (v) => { const s = String(v || '').trim().toLowerCase(); if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(s)) throw 'must be lowercase letters, digits and dashes'; return s; } }),
  ticker: () => ({ parse: (v) => { const s = String(v || '').trim().toUpperCase(); if (!/^[A-Z0-9][A-Z0-9._-]{1,63}$/.test(s)) throw 'must be 2-64 characters: A-Z, 0-9, dot, dash or underscore'; return s; } }),
  // Targeting lists stored as JSON text: series tickers or site categories (comma-separated string or array). G8 promo targeting.
  jsonList: (kind, max) => ({ def: '[]', parse: (v) => {
    if (typeof v === 'string' && v.startsWith('[')) { try { v = JSON.parse(v); } catch { throw 'must be a list'; } }
    const a = (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => String(x).trim()).filter(Boolean);
    if (a.length > max) throw `at most ${max} entries`;
    const out = kind === 'series' ? a.map((x) => x.toUpperCase()) : a.map((x) => CATEGORIES.find((c) => c.toLowerCase() === x.toLowerCase()) || x);
    for (const x of out) if (kind === 'series' ? !/^[A-Z0-9][A-Z0-9._-]{1,63}$/.test(x) : !CATEGORIES.includes(x)) throw kind === 'series' ? `${x} is not a series ticker` : `${x} is not a site category`;
    return JSON.stringify([...new Set(out)]);
  } }),
  tags: () => ({ def: [], parse: (v) => { const a = Array.isArray(v) ? v : String(v || '').split(','); const out = a.map((x) => String(x).trim()).filter(Boolean); if (out.length > 10 || out.some((x) => x.length > 30)) throw 'at most 10 tags of up to 30 characters'; return out; } }),
  sources: () => ({ def: [], parse: (v) => {
    const a = Array.isArray(v) ? v : String(v || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [name, url] = l.split('|').map((x) => x.trim()); return { name, url: url || '' }; });
    if (a.length > 5) throw 'at most 5 settlement sources';
    for (const s of a) { if (!s || !s.name || String(s.name).length > 80) throw 'each source needs a name (up to 80 characters)'; if (s.url && !/^https:\/\//.test(s.url)) throw 'source URLs must start with https://'; }
    return a.map((s) => ({ name: String(s.name), url: String(s.url || '') }));
  } }),
};
// Validate `body` against `spec`; `base` supplies current values for partial updates.
function check(body, spec, base = null) {
  const out = {}; const errs = {};
  for (const [k, f] of Object.entries(spec)) {
    const present = body && Object.prototype.hasOwnProperty.call(body, k);
    if (!present) {
      if (base && Object.prototype.hasOwnProperty.call(base, k)) { out[k] = base[k]; continue; }
      if (f.def !== undefined) { out[k] = typeof f.def === 'object' && f.def !== null ? JSON.parse(JSON.stringify(f.def)) : f.def; continue; }
    }
    try { out[k] = f.parse(present ? body[k] : undefined); } catch (m) { errs[k] = typeof m === 'string' ? m : 'is invalid'; }
  }
  if (Object.keys(errs).length) throw new FieldError(errs);
  return out;
}
const reasonOf = (b, min = 3) => {
  const r = String((b && b.reason) || '').trim();
  if (r.length < min || r.length > 500) throw new FieldError({ reason: `a reason of ${min}-500 characters is required` });
  return r;
};

// RFC 4180-ish CSV parser (quoted fields, doubled quotes, CRLF).
function parseCsv(text) {
  const rows = []; let row = []; let f = ''; let q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}
const csvEsc = (v) => (/[",\n\r]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
const IMPORT_COLUMNS = ['event_ticker', 'market_ticker', 'yes_sub_title', 'no_sub_title', 'title', 'color', 'open_time', 'close_time', 'expected_expiration_time', 'settlement_timer_seconds', 'rules_primary', 'initial_price', 'seed_liquidity'];

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

function mountAdmin({ v1, app, db, engine, notify, eventFull, rate = {}, rollingWindowSec = 900 }) {
  db.exec(SCHEMA);
  { // Phase 5A draft-market columns (price grid, scalar bounds); additive.
    const have = new Set(db.prepare('PRAGMA table_info(cms_draft_markets)').all().map((c) => c.name));
    for (const [c, def] of [['price_level_structure', "TEXT NOT NULL DEFAULT 'linear_cent'"], ['market_type', "TEXT NOT NULL DEFAULT 'binary'"], ['floor_strike', 'REAL'], ['cap_strike', 'REAL'], ['scalar_unit', "TEXT NOT NULL DEFAULT ''"]]) if (!have.has(c)) db.exec(`ALTER TABLE cms_draft_markets ADD COLUMN ${c} ${def}`);
  }
  // Promo-card targeting (gap G8; spec §13.11 series_ticker_list / preferred_categories / hide_on_explore_page_web_logged_out).
  { const promoCols = new Set(db.prepare('PRAGMA table_info(cms_promos)').all().map((c) => c.name));
    if (!promoCols.has('series_tickers')) db.exec("ALTER TABLE cms_promos ADD COLUMN series_tickers TEXT NOT NULL DEFAULT '[]'");
    if (!promoCols.has('categories')) db.exec("ALTER TABLE cms_promos ADD COLUMN categories TEXT NOT NULL DEFAULT '[]'");
    if (!promoCols.has('hide_logged_out')) db.exec('ALTER TABLE cms_promos ADD COLUMN hide_logged_out INTEGER NOT NULL DEFAULT 0'); }
  const startedAt = Date.now();
  const getEvent = (t) => db.prepare('SELECT * FROM events WHERE ticker=?').get(t);
  const getSeries = (t) => db.prepare('SELECT * FROM series WHERE ticker=?').get(t);
  const getMarket = (t) => db.prepare('SELECT * FROM markets WHERE ticker=?').get(t);
  const lpId = () => db.prepare("SELECT id FROM users WHERE email='liquidity@parlance.local'").get()?.id || null;
  const hasTable = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  let combosAvailable = false;
  try { require.resolve('./combos'); combosAvailable = true; } catch { combosAvailable = false; }

  // ---------------------------------------------------------------- settings
  function setting(key) {
    const r = db.prepare('SELECT value FROM admin_settings WHERE key=?').get(key);
    const def = DEFAULT_SETTINGS[key];
    if (!r) return def === undefined ? null : JSON.parse(JSON.stringify(def));
    const v = JSON.parse(r.value);
    return def && typeof def === 'object' && !Array.isArray(def) ? { ...def, ...v } : v;
  }
  function putSetting(key, value, by) {
    db.prepare('INSERT INTO admin_settings(key,value,updated_at,updated_by) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by')
      .run(key, JSON.stringify(value), nowIso(), by || null);
  }
  const apyNow = () => { const r = db.prepare('SELECT value FROM meta WHERE key=?').get(APY_META_KEY); return r ? Number(r.value) : DEFAULT_APY; };
  const features = () => setting('features');
  const hooks = { resolutionGate: null }; // set by server/trading-core.js (two-person rule, CLONE_SPEC.md §28.7)
  // Runtime-editable exchange settings (gap G7): applied at boot from the persisted values, changed live by PUT /settings.
  setTakerFeeCoefficient(setting('taker_fee')?.coefficient ?? DEFAULT_TAKER_FEE_COEFFICIENT);
  currency.configure(setting('display_currency'), setting('account_defaults')); // display currency + new-account defaults (§30)
  const persistedRollingWindow = () => setting('rolling_window')?.seconds ?? null;

  // ---------------------------------------------------------------- roles + audit
  function rolesOf(u) {
    if (!u) return [];
    const set = new Set(db.prepare('SELECT role FROM admin_roles WHERE user_id=?').all(u.id).map((r) => r.role).filter((r) => ROLE_PERMS[r]));
    if (u.is_admin) set.add('admin');
    return ROLES.filter((r) => set.has(r));
  }
  const permsOf = (roles) => new Set(roles.flatMap((r) => ROLE_PERMS[r] || []));
  const can = (perm) => (req, res, next) => {
    if (!req.auth) return next(E.unauthorized());
    const roles = rolesOf(req.auth.user);
    if (!roles.length) return next(new ApiError(403, 'forbidden', 'forbidden', 'admin access required'));
    if (!permsOf(roles).has(perm)) return next(new ApiError(403, 'forbidden', 'forbidden', `your role does not include ${perm}`));
    req.adminRoles = roles;
    next();
  };
  function audit(req, action, targetType, targetId, before, after, reason = '') {
    // Tamper-evident: every row is HMAC-chained to the previous one (server/audit-chain.js, CLONE_SPEC §22.7).
    auditChain.append(db, { actor_id: req.auth?.user.id || null, actor_email: req.auth?.user.email || null, action, target_type: targetType, target_id: targetId, before, after, reason });
  }

  // ---------------------------------------------------------------- internal reads through the user-facing routes
  // Runs a GET on the v1 router as user `uid`, so the admin views reuse exactly the SQL + serializers of the user routes.
  function asUser(uid, url) {
    return new Promise((resolve, reject) => {
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
      if (!user) { reject(E.notFound()); return; }
      const u = new URL(url, 'http://internal');
      const req = { method: 'GET', url: u.pathname + u.search, originalUrl: '/v1' + u.pathname + u.search, baseUrl: '', path: u.pathname, headers: {}, query: Object.fromEntries(u.searchParams), params: {},
        auth: { user, session: { csrf_token: null } }, adminInternal: true, ip: 'internal', get: () => undefined, header: () => undefined };
      let status = 200;
      const res = { locals: {}, headersSent: false, statusCode: 200, status(c) { status = c; this.statusCode = c; return this; }, setHeader() {}, set() { return this; }, getHeader() {}, end() { resolve(null); },
        json(b) { if (status >= 400) reject(Object.assign(new Error(b?.error?.message || 'internal request failed'), { body: b, status })); else resolve(b); return this; },
        send(b) { resolve(b); return this; } };
      try { v1.handle(req, res, (err) => reject(err || E.notFound())); } catch (e) { reject(e); }
    });
  }

  // ---------------------------------------------------------------- response decorators (public reads)
  // Wraps res.json for one method + path so CMS / moderation data is layered onto existing responses.
  function decorate(method, re, fn) {
    v1.use((req, res, next) => {
      if (req.method !== method || !re.test(req.path) || req.adminInternal) return next();
      const json = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode < 400 && body && typeof body === 'object') {
          try { const r = fn(body, req, res); if (r && r.__status) { res.status(r.__status); return json(r.body); } } catch (e) { console.error('admin decorate', req.path, e); }
        }
        return json(body);
      };
      next();
    });
  }

  // ---------------------------------------------------------------- account locks + posting bans + feature switches
  const isLocked = (uid) => !!db.prepare('SELECT 1 FROM acct_locks WHERE user_id=?').get(uid);
  const isBanned = (uid) => !!db.prepare('SELECT 1 FROM mod_bans WHERE user_id=?').get(uid);
  const lockedError = () => new ApiError(403, 'account_locked', 'this account is locked', 'contact support to restore access');
  v1.use((req, res, next) => {
    if (req.adminInternal) return next();
    // A locked account is signed out everywhere: its sessions are deleted on lock and any surviving cookie is ignored.
    if (req.auth && isLocked(req.auth.user.id)) req.auth = null;
    // RS9: a locked account is refused by POST /log_in only after its password was verified (server/auth.js), so the
    // answer to a wrong password is the same for locked, unlocked and unknown accounts (no account-existence signal).
    if (req.method === 'POST' && req.path === '/log_in_mfa') {
      const ch = db.prepare('SELECT user_id FROM mfa_challenges WHERE token=?').get(String((req.body && req.body.mfa_token) || ''));
      if (ch && isLocked(ch.user_id)) return next(lockedError());
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const f = features();
      const p = req.path;
      if (!f.social && /^\/users\/[^/]+\/social\//.test(p)) return next(new ApiError(403, 'feature_disabled', 'social features are turned off'));
      if (!f.perps && /^\/perps\//.test(p) && !/^\/perps\/admin\//.test(p)) return next(new ApiError(403, 'feature_disabled', 'perps are turned off'));
      if (!f.combos && (/^\/multivariate_event_collections\//.test(p) || /^\/users\/[^/]+\/combo_slip$/.test(p) || /^\/communications\/(rfqs|quotes)/.test(p))) return next(new ApiError(403, 'feature_disabled', 'combos are turned off'));
      if (req.auth && req.method === 'POST' && (/^\/users\/[^/]+\/social\/posts$/.test(p) || /^\/users\/[^/]+\/social\/posts\/[^/]+\/comments$/.test(p)) && isBanned(req.auth.user.id)) {
        return next(new ApiError(403, 'posting_banned', 'you are not allowed to post', 'your posting privileges were removed by a moderator'));
      }
      // Combo eligibility (ops_market_flags.combo_eligible = 0 excludes a market as a leg).
      if (combosAvailable && req.method === 'POST' && /^\/multivariate_event_collections\/[^/]+(\/markets)?$/.test(p)) {
        const legs = Array.isArray(req.body && req.body.selected_markets) ? req.body.selected_markets : [];
        for (const l of legs) {
          const t = String((l && l.market_ticker) || '');
          if (db.prepare('SELECT 1 FROM ops_market_flags WHERE market_ticker=? AND combo_eligible=0').get(t)) return next(new ApiError(400, 'invalid_leg', 'this market is not eligible for combos', t));
        }
      }
    }
    next();
  });

  // Session carries the admin roles so the client can show the Admin link.
  decorate('GET', /^\/session$/, (body, req) => { if (body.user && req.auth) body.user.admin_roles = rolesOf(req.auth.user); });
  const withRoles = (body) => { if (body.user && body.user.user_id) body.user.admin_roles = rolesOf(db.prepare('SELECT * FROM users WHERE id=?').get(body.user.user_id)); };
  decorate('POST', /^\/log_in$/, withRoles);
  decorate('POST', /^\/log_in_mfa$/, withRoles);

  // ---------------------------------------------------------------- moderation decorators
  const hiddenSet = (kind) => new Set(db.prepare('SELECT content_id FROM mod_hidden WHERE kind=?').all(kind).map((r) => r.content_id));
  const verifiedNick = (nick) => !!db.prepare('SELECT 1 FROM social_profiles sp JOIN mod_verified v ON v.user_id=sp.user_id WHERE sp.nickname=?').get(String(nick || ''));
  const markAuthor = (a) => { if (a && a.nickname) a.verified = verifiedNick(a.nickname); };
  decorate('GET', /^\/social\/posts$/, (body) => {
    if (!Array.isArray(body.posts)) return;
    const hidden = hiddenSet('post');
    body.posts = body.posts.filter((p) => !hidden.has(p.id));
    for (const p of body.posts) markAuthor(p.author);
  });
  decorate('GET', /^\/social\/posts\/[^/]+$/, (body, req) => {
    if (!body.post) return;
    if (hiddenSet('post').has(body.post.id)) return { __status: 404, body: E.notFound().toJSON() };
    markAuthor(body.post.author);
    void req;
  });
  decorate('GET', /^\/social\/posts\/[^/]+\/comments$/, (body) => {
    if (!Array.isArray(body.comments)) return;
    const hidden = hiddenSet('comment');
    body.comments = body.comments.filter((c) => !hidden.has(c.id));
    for (const c of body.comments) markAuthor(c.author);
  });
  decorate('GET', /^\/social\/profile$/, (body) => { if (body.profile) body.profile.verified = verifiedNick(body.profile.nickname); });
  decorate('GET', /^\/users\/[^/]+\/social\/profile$/, (body) => { if (body.profile) body.profile.verified = verifiedNick(body.profile.nickname); });
  decorate('GET', /^\/social\/leaderboard$/, (body) => { for (const l of body.leaders || []) l.verified = verifiedNick(l.nickname); });

  // ---------------------------------------------------------------- CMS decorators (home + combos)
  const windowOk = (r, now = Date.now()) => (!r.starts_at || Date.parse(r.starts_at) <= now) && (!r.ends_at || Date.parse(r.ends_at) > now);
  const nonCombo = (cat) => db.prepare('SELECT * FROM events WHERE category=? AND series_ticker<>? ORDER BY rowid').all(cat, COMBO_SERIES);
  decorate('GET', /^\/bff\/home$/, (body, req) => {
    const h = body.home;
    if (!h) return;
    const hero = db.prepare('SELECT event_ticker FROM cms_hero ORDER BY position').all();
    if (hero.length) {
      const evs = hero.map((r) => getEvent(r.event_ticker)).filter(Boolean).map(eventFull).filter((e) => e.markets.some((m) => m.status === 'active'));
      if (evs.length) h.highlights = evs;
    }
    const hubs = db.prepare('SELECT * FROM cms_hubs WHERE active=1 ORDER BY position, created_at').all();
    if (hubs.length) {
      h.hubs = hubs.map((x) => { const evs = nonCombo(x.category).map(eventFull); return { category: x.category, title: x.title, dollar_volume: evs.reduce((a, e) => a + e.dollar_volume, 0), events: evs.length }; });
    }
    // Home shows untargeted promos; series / category promos appear on those pages (GET /v1/promos, server/social2.js).
    const promos = db.prepare('SELECT * FROM cms_promos WHERE active=1 ORDER BY position, created_at').all().filter((r) => windowOk(r))
      .filter((r) => (r.series_tickers || '[]') === '[]' && (r.categories || '[]') === '[]' && !(r.hide_logged_out && !req.auth));
    h.promos = promos.length ? promos.map((p) => ({ id: p.id, overline: p.overline, title: p.title, subtitle: p.subtitle, link: p.link, color: p.color })) : null;
    const info = db.prepare('SELECT * FROM cms_info_cards WHERE active=1 ORDER BY position, created_at').all();
    h.info_cards = info.length ? info.map((c) => ({ id: c.id, title: c.title, subtitle: c.subtitle, link: c.link, icon: c.icon })) : null;
  });
  if (combosAvailable) {
    decorate('GET', /^\/multivariate_event_collections\/[^/]+$/, (body) => {
      const c = body.multivariate_contract;
      if (!c || !Array.isArray(c.events)) return;
      const off = new Set(db.prepare('SELECT market_ticker FROM ops_market_flags WHERE combo_eligible=0').all().map((r) => r.market_ticker));
      if (!off.size) return;
      c.events = c.events.map((e) => ({ ...e, markets: e.markets.filter((m) => !off.has(m.ticker)) })).filter((e) => e.markets.length);
    });
  }

  // eventFull() hook (app.js): icon colour + attached news items.
  function decorateEvent(vo) {
    const meta = db.prepare('SELECT icon_color FROM cms_event_meta WHERE event_ticker=?').get(vo.event_ticker);
    if (meta && meta.icon_color) vo.icon_color = meta.icon_color;
    const news = db.prepare('SELECT * FROM cms_news WHERE event_ticker=? AND active=1 ORDER BY published_at DESC, position').all(vo.event_ticker);
    if (news.length) vo.news_items = news.map((n) => ({ id: n.id, source: n.source, published_time: n.published_at, headline: n.headline, summary: n.summary }));
    return vo;
  }

  // ---------------------------------------------------------------- public CMS endpoints
  function navConfig() {
    const rows = new Map(db.prepare('SELECT * FROM cms_nav').all().map((r) => [r.category, r]));
    const cats = CATEGORIES.map((c, i) => ({ name: c, label: rows.get(c)?.label || '', position: rows.has(c) ? rows.get(c).position : 1000 + i, hidden: !!rows.get(c)?.hidden }))
      .sort((a, b) => a.position - b.position);
    return { categories: cats.map(({ name, label, hidden }) => ({ name, label, hidden })), featured: setting('featured_tab') };
  }
  const bannerVo = (b) => ({ id: b.id, content: b.content, link: b.link, visibility: b.visibility, position: b.position, visibilityTokens: [b.visibility] });
  v1.get('/site_config', (req, res) => {
    const who = req.auth ? 'logged_in' : 'logged_out';
    const banners = db.prepare('SELECT * FROM cms_banners WHERE active=1 ORDER BY created_at DESC').all().filter((b) => windowOk(b) && (b.visibility === 'all' || b.visibility === who));
    res.json({ banners: banners.map(bannerVo), nav: navConfig(), features: features(), display_currency: currency.descriptor() });
  });
  v1.get('/help', (req, res) => res.json({ pages: db.prepare('SELECT slug,title,updated_at FROM cms_help WHERE published=1 AND active=1 ORDER BY position, title').all().map((p) => ({ slug: p.slug, title: p.title, updated_time: p.updated_at })) }));
  v1.get('/help/:slug', (req, res) => {
    const p = db.prepare('SELECT * FROM cms_help WHERE slug=? AND published=1 AND active=1').get(String(req.params.slug).toLowerCase());
    if (!p) throw E.notFound();
    res.json({ page: { slug: p.slug, title: p.title, body: p.body, updated_time: p.updated_at } });
  });

  // User-facing: report a post or comment (spec evidence: social-admin moderation endpoints; reporting is a design choice).
  v1.post('/users/:uid/social/reports', (req, res) => {
    if (!req.auth) throw E.unauthorized();
    if (req.params.uid !== req.auth.user.id) throw E.forbidden('cannot access another user');
    const b = req.body || {};
    const kind = b.kind === 'comment' ? 'comment' : b.kind === 'post' ? 'post' : null;
    if (!kind) throw E.badRequest('kind must be post or comment');
    const reason = String(b.reason || '').trim();
    if (reason.length < 3 || reason.length > 300) throw new FieldError({ reason: 'tell us what is wrong (3-300 characters)' });
    let content; let postId;
    if (kind === 'post') { content = db.prepare('SELECT * FROM posts WHERE id=?').get(String(b.id || '')); postId = content?.id; }
    else { content = db.prepare('SELECT * FROM comments WHERE id=?').get(String(b.id || '')); postId = content?.post_id; }
    if (!content) throw E.notFound();
    if (content.user_id === req.auth.user.id) throw E.badRequest('you cannot report your own content');
    const dup = db.prepare("SELECT id FROM mod_reports WHERE reporter_id=? AND kind=? AND content_id=? AND status='open'").get(req.auth.user.id, kind, content.id);
    if (dup) return res.json({ report: { id: dup.id, status: 'open' }, duplicate: true });
    const id = newId('rp_');
    db.prepare('INSERT INTO mod_reports(id,reporter_id,kind,content_id,post_id,author_id,excerpt,reason,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, req.auth.user.id, kind, content.id, postId, content.user_id, String(content.body).slice(0, 280), reason, 'open', nowIso());
    res.status(201).json({ report: { id, status: 'open' } });
  });

  // ================================================================ admin API
  const A = '/admin';
  v1.get(`${A}/me`, (req, res) => {
    if (!req.auth) throw E.unauthorized();
    const roles = rolesOf(req.auth.user);
    if (!roles.length) throw new ApiError(403, 'forbidden', 'forbidden', 'admin access required');
    res.json({ user: { user_id: req.auth.user.id, email: req.auth.user.email, display_name: req.auth.user.display_name }, roles, permissions: [...permsOf(roles)].sort(), role_matrix: ROLE_PERMS, all_permissions: PERMS });
  });

  // ---- roles
  v1.get(`${A}/roles`, can('roles.write'), (req, res) => {
    const rows = db.prepare('SELECT DISTINCT u.* FROM users u LEFT JOIN admin_roles r ON r.user_id=u.id WHERE u.is_admin=1 OR r.user_id IS NOT NULL ORDER BY u.email').all();
    res.json({ staff: rows.map((u) => ({ user_id: u.id, email: u.email, display_name: u.display_name, roles: rolesOf(u) })), roles: ROLES, role_matrix: ROLE_PERMS, all_permissions: PERMS });
  });
  v1.put(`${A}/roles/:userId`, can('roles.write'), (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id=? OR email=?').get(req.params.userId, String(req.params.userId).toLowerCase());
    if (!u || u.is_system) throw E.notFound();
    const roles = Array.isArray(req.body && req.body.roles) ? [...new Set(req.body.roles)] : null;
    if (!roles || roles.some((r) => !ROLE_PERMS[r])) throw new FieldError({ roles: `must be a list of: ${ROLES.join(', ')}` });
    const before = rolesOf(u);
    if (before.includes('admin') && !roles.includes('admin')) {
      if (u.id === req.auth.user.id) throw E.conflict('cannot_demote_self', 'you cannot remove your own admin role');
      const admins = db.prepare("SELECT COUNT(*) c FROM users u WHERE u.is_system=0 AND (u.is_admin=1 OR EXISTS (SELECT 1 FROM admin_roles r WHERE r.user_id=u.id AND r.role='admin'))").get().c;
      if (admins <= 1) throw E.conflict('last_admin', 'at least one admin must remain');
    }
    tx(db, () => {
      db.prepare('DELETE FROM admin_roles WHERE user_id=?').run(u.id);
      for (const r of roles) db.prepare('INSERT INTO admin_roles(user_id,role,granted_by,granted_at) VALUES(?,?,?,?)').run(u.id, r, req.auth.user.id, nowIso());
      // The admin role also drives users.is_admin, which the pre-existing admin routes check.
      db.prepare('UPDATE users SET is_admin=? WHERE id=?').run(roles.includes('admin') ? 1 : 0, u.id);
    });
    const after = rolesOf(db.prepare('SELECT * FROM users WHERE id=?').get(u.id));
    audit(req, 'roles.set', 'user', u.id, { email: u.email, roles: before }, { email: u.email, roles: after });
    res.json({ user_id: u.id, email: u.email, roles: after });
  });

  // ---- audit
  v1.get(`${A}/audit`, can('audit.read'), (req, res) => {
    const where = []; const args = [];
    const qv = (k) => String(req.query[k] || '').trim();
    if (qv('actor')) { where.push('lower(actor_email) LIKE ?'); args.push(`%${qv('actor').toLowerCase()}%`); }
    if (qv('action')) { where.push('action LIKE ?'); args.push(`${qv('action')}%`); }
    if (qv('target')) { where.push('(target_id LIKE ? OR target_type=?)'); args.push(`%${qv('target')}%`, qv('target')); }
    if (qv('from') && isIso(qv('from'))) { where.push('ts>=?'); args.push(Date.parse(qv('from'))); }
    if (qv('to') && isIso(qv('to'))) { where.push('ts<?'); args.push(Date.parse(qv('to')) + (qv('to').length === 10 ? 86400000 : 0)); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const total = db.prepare(`SELECT COUNT(*) c FROM admin_audit ${w}`).get(...args).c;
    const rows = db.prepare(`SELECT * FROM admin_audit ${w} ORDER BY ts DESC, rowid DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    res.json({ total, entries: rows.map((r) => ({ id: r.id, time: new Date(r.ts).toISOString(), actor_email: r.actor_email, action: r.action, target_type: r.target_type, target_id: r.target_id, before: r.before_json ? JSON.parse(r.before_json) : null, after: r.after_json ? JSON.parse(r.after_json) : null, reason: r.reason })) });
  });

  // ================================================================ catalog
  const SERIES_SPEC = {
    title: F.text(1, 100), slug: F.slug(), category: F.category(), tags: F.tags(), frequency: F.oneOf(['one_off', 'daily', 'weekly', 'monthly', 'annual', 'fifteen_min'], 'one_off'),
    rules: F.text(0, 4000, ''), settlement_sources: F.sources(), fee_type: F.oneOf(['quadratic', 'flat', 'none'], 'quadratic'), fee_multiplier: F.num(0, 10, 1),
  };
  const EVENT_SPEC = {
    series_ticker: F.ticker(), title: F.text(1, 140), sub_title: F.text(0, 140, ''), category: F.category(), mutually_exclusive: F.bool(0), is_live: F.bool(0), live_label: F.text(0, 40, ''),
    news: F.text(0, 600, ''), featured: F.bool(0), icon_color: F.optColor(),
  };
  const MARKET_SPEC = {
    event_ticker: F.ticker(), title: F.text(0, 200, ''), yes_sub_title: F.text(1, 80), no_sub_title: F.text(0, 80, ''), color: F.color('#5b5bd6'),
    open_time: F.time(), close_time: F.time(), expected_expiration_time: F.time(true), settlement_timer_seconds: F.int(0, 604800, 300), rules_primary: F.text(0, 4000, ''),
    fractional: F.bool(1), initial_price: F.int(1, 99, 50), seed_liquidity: F.bool(1),
    // Phase 5A (CLONE_SPEC.md §28.1, §28.4): price grid and scalar payout bounds; creation needs catalog.write.
    price_level_structure: F.oneOf(STRUCTURES, 'linear_cent'), market_type: F.oneOf(['binary', 'scalar'], 'binary'),
    floor_strike: F.optNum(), cap_strike: F.optNum(), scalar_unit: F.text(0, 12, ''),
  };
  const draftSeries = (t) => db.prepare('SELECT * FROM cms_draft_series WHERE ticker=?').get(t);
  const draftEvent = (t) => db.prepare('SELECT * FROM cms_draft_events WHERE ticker=?').get(t);
  const draftMarket = (t) => db.prepare('SELECT * FROM cms_draft_markets WHERE ticker=?').get(t);
  // Tickers are unique per kind (a single-market event may share its market's ticker, as the seed does).
  const tickerTaken = { series: (t) => !!(getSeries(t) || draftSeries(t)), events: (t) => !!(getEvent(t) || draftEvent(t)), markets: (t) => !!(getMarket(t) || draftMarket(t)) };
  const iconColor = (t) => db.prepare('SELECT icon_color FROM cms_event_meta WHERE event_ticker=?').get(t)?.icon_color || '';

  const seriesRow = (s, state) => ({ state, ticker: s.ticker, title: s.title, slug: s.slug, category: s.category, tags: JSON.parse(s.tags), frequency: s.frequency, rules: s.rules,
    settlement_sources: JSON.parse(s.settlement_sources), fee_type: s.fee_type, fee_multiplier: s.fee_multiplier,
    events: state === 'published' ? db.prepare('SELECT COUNT(*) c FROM events WHERE series_ticker=?').get(s.ticker).c + db.prepare('SELECT COUNT(*) c FROM cms_draft_events WHERE series_ticker=?').get(s.ticker).c
      : db.prepare('SELECT COUNT(*) c FROM cms_draft_events WHERE series_ticker=?').get(s.ticker).c });
  const eventRow = (e, state) => ({ state, ticker: e.ticker, series_ticker: e.series_ticker, title: e.title, sub_title: e.sub_title, category: e.category, mutually_exclusive: !!e.mutually_exclusive,
    is_live: !!e.is_live, live_label: e.live_label, news: e.news, featured: !!e.featured, icon_color: state === 'draft' ? e.icon_color : iconColor(e.ticker),
    markets: db.prepare('SELECT COUNT(*) c FROM markets WHERE event_ticker=?').get(e.ticker).c + db.prepare('SELECT COUNT(*) c FROM cms_draft_markets WHERE event_ticker=?').get(e.ticker).c,
    series_slug: (getSeries(e.series_ticker) || draftSeries(e.series_ticker))?.slug || '' });
  const marketRow = (m, state) => {
    const base = { state, ticker: m.ticker, event_ticker: m.event_ticker, title: m.title, yes_sub_title: m.yes_sub_title, no_sub_title: m.no_sub_title, color: m.color, open_time: m.open_time,
      close_time: m.close_time, expected_expiration_time: m.expected_expiration_time, settlement_timer_seconds: m.settlement_timer_seconds, rules_primary: m.rules_primary };
    Object.assign(base, { price_level_structure: m.price_level_structure || 'linear_cent', market_type: m.market_type || 'binary', floor_strike: m.floor_strike ?? null, cap_strike: m.cap_strike ?? null, scalar_unit: m.scalar_unit || '' });
    if (state === 'draft') return { ...base, status: 'draft', fractional: !!m.fractional, initial_price: m.initial_price, seed_liquidity: !!m.seed_liquidity, import_batch: m.import_batch };
    const vo = marketVo(m, engine.quote(m.ticker));
    return { ...base, status: m.status, result: m.result, fractional: !!m.fractional_trading_enabled, volume_fp: vo.volume_fp, open_interest_fp: vo.open_interest_fp, last_price_dollars: vo.last_price_dollars };
  };
  const like = (q) => `%${String(q || '').trim().toLowerCase()}%`;

  v1.get(`${A}/catalog/series`, can('catalog.read'), (req, res) => {
    const q = like(req.query.q);
    const pub = db.prepare("SELECT * FROM series WHERE ticker<>? AND (lower(ticker) LIKE ? OR lower(title) LIKE ?) ORDER BY rowid DESC").all(COMBO_SERIES, q, q).map((s) => seriesRow(s, 'published'));
    const dr = db.prepare('SELECT * FROM cms_draft_series WHERE lower(ticker) LIKE ? OR lower(title) LIKE ? ORDER BY created_at DESC').all(q, q).map((s) => seriesRow(s, 'draft'));
    res.json({ series: [...dr, ...pub], categories: CATEGORIES });
  });
  v1.get(`${A}/catalog/events`, can('catalog.read'), (req, res) => {
    const q = like(req.query.q); const st = String(req.query.series || '');
    const f = st ? ' AND series_ticker=?' : '';
    const a = st ? [st] : [];
    const pub = db.prepare(`SELECT * FROM events WHERE series_ticker NOT IN (?,?) AND (lower(ticker) LIKE ? OR lower(title) LIKE ?)${f} ORDER BY rowid DESC`).all(COMBO_SERIES, FLASH_SERIES, q, q, ...a).map((e) => eventRow(e, 'published'));
    const dr = db.prepare(`SELECT * FROM cms_draft_events WHERE (lower(ticker) LIKE ? OR lower(title) LIKE ?)${f} ORDER BY created_at DESC`).all(q, q, ...a).map((e) => eventRow(e, 'draft'));
    res.json({ events: [...dr, ...pub] });
  });
  v1.get(`${A}/catalog/markets`, can('catalog.read'), (req, res) => {
    const q = like(req.query.q); const et = String(req.query.event || '');
    const f = et ? ' AND m.event_ticker=?' : '';
    const a = et ? [et] : [];
    const pub = db.prepare(`SELECT m.* FROM markets m JOIN events e ON e.ticker=m.event_ticker WHERE e.series_ticker NOT IN (?,?) AND (lower(m.ticker) LIKE ? OR lower(m.title) LIKE ? OR lower(m.yes_sub_title) LIKE ?)${f} ORDER BY m.rowid DESC LIMIT 500`)
      .all(COMBO_SERIES, FLASH_SERIES, q, q, q, ...a).map((m) => marketRow(m, 'published'));
    const dr = db.prepare(`SELECT * FROM cms_draft_markets m WHERE (lower(ticker) LIKE ? OR lower(title) LIKE ? OR lower(yes_sub_title) LIKE ?)${f} ORDER BY created_at DESC`).all(q, q, q, ...a).map((m) => marketRow(m, 'draft'));
    res.json({ markets: [...dr, ...pub] });
  });

  // Create drafts.
  v1.post(`${A}/catalog/series`, can('catalog.write'), (req, res) => {
    const b = req.body || {};
    const errs = {};
    let ticker; try { ticker = F.ticker().parse(b.ticker); if (tickerTaken.series(ticker)) errs.ticker = 'is already used'; } catch (m) { errs.ticker = m; }
    let v; try { v = check({ ...b, slug: String(b.slug || '').trim() || slugify(b.title || '') || 'series' }, SERIES_SPEC); } catch (e) { if (e instanceof FieldError) Object.assign(errs, e.fields); else throw e; }
    if (Object.keys(errs).length) throw new FieldError(errs);
    const now = nowIso();
    db.prepare('INSERT INTO cms_draft_series(ticker,title,slug,category,tags,frequency,rules,settlement_sources,fee_type,fee_multiplier,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(ticker, v.title, v.slug, v.category, JSON.stringify(v.tags), v.frequency, v.rules, JSON.stringify(v.settlement_sources), v.fee_type, v.fee_multiplier, req.auth.user.id, now, now);
    const row = seriesRow(draftSeries(ticker), 'draft');
    audit(req, 'catalog.series.create', 'series', ticker, null, row);
    res.status(201).json({ series: row });
  });
  v1.post(`${A}/catalog/events`, can('catalog.write'), (req, res) => {
    const b = req.body || {};
    const errs = {};
    let ticker; try { ticker = F.ticker().parse(b.ticker); if (tickerTaken.events(ticker)) errs.ticker = 'is already used'; } catch (m) { errs.ticker = m; }
    const parent = getSeries(String(b.series_ticker || '').toUpperCase()) || draftSeries(String(b.series_ticker || '').toUpperCase());
    let v; try { v = check({ category: parent?.category, ...b }, EVENT_SPEC); } catch (e) { if (e instanceof FieldError) Object.assign(errs, e.fields); else throw e; }
    if (!parent && !errs.series_ticker) errs.series_ticker = 'no such series';
    if (parent && parent.ticker === COMBO_SERIES) errs.series_ticker = 'combos are created by traders, not the CMS';
    if (Object.keys(errs).length) throw new FieldError(errs);
    const now = nowIso();
    db.prepare('INSERT INTO cms_draft_events(ticker,series_ticker,title,sub_title,category,mutually_exclusive,is_live,live_label,news,featured,icon_color,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(ticker, v.series_ticker, v.title, v.sub_title, v.category, v.mutually_exclusive, v.is_live, v.live_label, v.news, v.featured, v.icon_color, req.auth.user.id, now, now);
    const row = eventRow(draftEvent(ticker), 'draft');
    audit(req, 'catalog.event.create', 'event', ticker, null, row);
    res.status(201).json({ event: row });
  });
  function validateMarketTimes(v, errs) {
    if (!errs.close_time && !errs.open_time && Date.parse(v.close_time) <= Date.parse(v.open_time)) errs.close_time = 'must be after the open time';
    if (v.expected_expiration_time && !errs.close_time && Date.parse(v.expected_expiration_time) < Date.parse(v.close_time)) errs.expected_expiration_time = 'must be at or after the close time';
  }
  function validateScalar(v, errs) {
    if (v.market_type !== 'scalar') { v.floor_strike = null; v.cap_strike = null; return; }
    if (v.floor_strike == null) errs.floor_strike = 'a scalar market needs a floor';
    if (v.cap_strike == null) errs.cap_strike = 'a scalar market needs a cap';
    if (v.floor_strike != null && v.cap_strike != null && !(v.cap_strike > v.floor_strike)) errs.cap_strike = 'must be above the floor';
  }
  function marketDraftFrom(b, batch, actor) {
    const errs = {};
    let ticker; try { ticker = F.ticker().parse(b.ticker ?? b.market_ticker); if (tickerTaken.markets(ticker)) errs.ticker = 'is already used'; } catch (m) { errs.ticker = m; }
    const et = String(b.event_ticker || '').trim().toUpperCase();
    const parent = getEvent(et) || draftEvent(et);
    let v; try { v = check({ open_time: nowIso(), ...Object.fromEntries(Object.entries(b).filter(([, x]) => x !== '' || false)), event_ticker: et }, MARKET_SPEC); } catch (e) { if (e instanceof FieldError) Object.assign(errs, e.fields); else throw e; }
    if (!parent) errs.event_ticker = 'no such event';
    else if (parent.series_ticker === COMBO_SERIES || parent.series_ticker === FLASH_SERIES) errs.event_ticker = 'markets cannot be added to this event';
    if (v) validateMarketTimes(v, errs);
    if (v) validateScalar(v, errs);
    if (Object.keys(errs).length) throw new FieldError(errs);
    if (!v.no_sub_title) v.no_sub_title = `Not ${v.yes_sub_title}`;
    if (!v.title) v.title = parent.mutually_exclusive ? `${parent.title} — ${v.yes_sub_title}` : parent.title;
    if (!v.expected_expiration_time) v.expected_expiration_time = new Date(Date.parse(v.close_time) + 3600000).toISOString();
    if (!v.rules_primary) v.rules_primary = `If "${v.yes_sub_title}" is confirmed by the settlement source, this market resolves YES. Otherwise it resolves NO.`;
    return { ticker, v, batch, actor };
  }
  const insertDraftMarket = ({ ticker, v, batch, actor }) => {
    const now = nowIso();
    db.prepare('INSERT INTO cms_draft_markets(ticker,event_ticker,title,yes_sub_title,no_sub_title,color,open_time,close_time,expected_expiration_time,settlement_timer_seconds,rules_primary,fractional,initial_price,seed_liquidity,import_batch,created_by,created_at,updated_at,price_level_structure,market_type,floor_strike,cap_strike,scalar_unit) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(ticker, v.event_ticker, v.title, v.yes_sub_title, v.no_sub_title, v.color, v.open_time, v.close_time, v.expected_expiration_time, v.settlement_timer_seconds, v.rules_primary, v.fractional, v.initial_price, v.seed_liquidity, batch || null, actor, now, now,
        v.price_level_structure || 'linear_cent', v.market_type || 'binary', v.floor_strike ?? null, v.cap_strike ?? null, v.scalar_unit || '');
  };
  v1.post(`${A}/catalog/markets`, can('catalog.write'), (req, res) => {
    const d = marketDraftFrom(req.body || {}, null, req.auth.user.id);
    insertDraftMarket(d);
    const row = marketRow(draftMarket(d.ticker), 'draft');
    audit(req, 'catalog.market.create', 'market', d.ticker, null, row);
    res.status(201).json({ market: row });
  });

  // Edit (draft or published).
  v1.put(`${A}/catalog/series/:ticker`, can('catalog.write'), (req, res) => {
    const t = req.params.ticker.toUpperCase();
    const d = draftSeries(t); const p = d ? null : getSeries(t);
    if (!d && !p) throw E.notFound();
    const cur = d || p;
    const base = { ...cur, tags: JSON.parse(cur.tags), settlement_sources: JSON.parse(cur.settlement_sources) };
    const v = check(req.body || {}, SERIES_SPEC, base);
    const before = seriesRow(cur, d ? 'draft' : 'published');
    const table = d ? 'cms_draft_series' : 'series';
    db.prepare(`UPDATE ${table} SET title=?, slug=?, category=?, tags=?, frequency=?, rules=?, settlement_sources=?, fee_type=?, fee_multiplier=?${d ? ', updated_at=?' : ''} WHERE ticker=?`)
      .run(v.title, v.slug, v.category, JSON.stringify(v.tags), v.frequency, v.rules, JSON.stringify(v.settlement_sources), v.fee_type, v.fee_multiplier, ...(d ? [nowIso()] : []), t);
    const after = seriesRow(d ? draftSeries(t) : getSeries(t), d ? 'draft' : 'published');
    audit(req, 'catalog.series.update', 'series', t, before, after);
    res.json({ series: after });
  });
  v1.put(`${A}/catalog/events/:ticker`, can('catalog.write'), (req, res) => {
    const t = req.params.ticker.toUpperCase();
    const d = draftEvent(t); const p = d ? null : getEvent(t);
    if (!d && !p) throw E.notFound();
    const cur = d || { ...p, icon_color: iconColor(t) };
    const body = { ...(req.body || {}) };
    if (!d) body.series_ticker = cur.series_ticker; // published events keep their series
    const v = check(body, EVENT_SPEC, cur);
    if (d && !getSeries(v.series_ticker) && !draftSeries(v.series_ticker)) throw new FieldError({ series_ticker: 'no such series' });
    const before = eventRow(cur, d ? 'draft' : 'published');
    if (d) {
      db.prepare('UPDATE cms_draft_events SET series_ticker=?, title=?, sub_title=?, category=?, mutually_exclusive=?, is_live=?, live_label=?, news=?, featured=?, icon_color=?, updated_at=? WHERE ticker=?')
        .run(v.series_ticker, v.title, v.sub_title, v.category, v.mutually_exclusive, v.is_live, v.live_label, v.news, v.featured, v.icon_color, nowIso(), t);
    } else {
      tx(db, () => {
        db.prepare('UPDATE events SET title=?, sub_title=?, category=?, mutually_exclusive=?, is_live=?, live_label=?, news=?, featured=? WHERE ticker=?')
          .run(v.title, v.sub_title, v.category, v.mutually_exclusive, v.is_live, v.live_label, v.news, v.featured, t);
        db.prepare('INSERT INTO cms_event_meta(event_ticker,icon_color,updated_at) VALUES(?,?,?) ON CONFLICT(event_ticker) DO UPDATE SET icon_color=excluded.icon_color, updated_at=excluded.updated_at').run(t, v.icon_color, nowIso());
      });
    }
    const after = eventRow(d ? draftEvent(t) : getEvent(t), d ? 'draft' : 'published');
    audit(req, 'catalog.event.update', 'event', t, before, after);
    res.json({ event: after });
  });
  v1.put(`${A}/catalog/markets/:ticker`, can('catalog.write'), (req, res) => {
    const t = req.params.ticker.toUpperCase();
    const d = draftMarket(t); const p = d ? null : getMarket(t);
    if (!d && !p) throw E.notFound();
    if (p && getEvent(p.event_ticker)?.series_ticker === COMBO_SERIES) throw E.badRequest('combo markets are not editable');
    const body = { ...(req.body || {}) };
    const cur = d || { ...p, fractional: p.fractional_trading_enabled, initial_price: 50, seed_liquidity: 0 };
    if (p) {
      body.event_ticker = p.event_ticker;
      if (p.status !== 'initialized') delete body.open_time; // only unopened markets may move their open time
      if (['closed', 'determined', 'finalized'].includes(p.status)) { delete body.close_time; delete body.expected_expiration_time; }
    }
    const v = check(body, MARKET_SPEC, cur);
    const errs = {}; validateMarketTimes(v, errs); if (d) validateScalar(v, errs);
    if (Object.keys(errs).length) throw new FieldError(errs);
    const before = marketRow(d || p, d ? 'draft' : 'published');
    if (d) {
      if (!getEvent(v.event_ticker) && !draftEvent(v.event_ticker)) throw new FieldError({ event_ticker: 'no such event' });
      db.prepare('UPDATE cms_draft_markets SET event_ticker=?, title=?, yes_sub_title=?, no_sub_title=?, color=?, open_time=?, close_time=?, expected_expiration_time=?, settlement_timer_seconds=?, rules_primary=?, fractional=?, initial_price=?, seed_liquidity=?, price_level_structure=?, market_type=?, floor_strike=?, cap_strike=?, scalar_unit=?, updated_at=? WHERE ticker=?')
        .run(v.event_ticker, v.title, v.yes_sub_title, v.no_sub_title || `Not ${v.yes_sub_title}`, v.color, v.open_time, v.close_time, v.expected_expiration_time || v.close_time, v.settlement_timer_seconds, v.rules_primary, v.fractional, v.initial_price, v.seed_liquidity,
          v.price_level_structure || 'linear_cent', v.market_type || 'binary', v.floor_strike ?? null, v.cap_strike ?? null, v.scalar_unit || '', nowIso(), t);
    } else {
      db.prepare('UPDATE markets SET title=?, yes_sub_title=?, no_sub_title=?, color=?, open_time=?, close_time=?, expected_expiration_time=?, settlement_timer_seconds=?, rules_primary=?, updated_at=? WHERE ticker=?')
        .run(v.title, v.yes_sub_title, v.no_sub_title || `Not ${v.yes_sub_title}`, v.color, v.open_time, v.close_time, v.expected_expiration_time || v.close_time, v.settlement_timer_seconds, v.rules_primary, nowIso(), t);
    }
    const after = marketRow(d ? draftMarket(t) : getMarket(t), d ? 'draft' : 'published');
    audit(req, 'catalog.market.update', 'market', t, before, after);
    res.json({ market: after });
  });

  // Discard a draft.
  v1.delete(`${A}/catalog/:kind/:ticker`, can('catalog.write'), (req, res) => {
    const t = req.params.ticker.toUpperCase();
    const k = req.params.kind;
    const table = { series: 'cms_draft_series', events: 'cms_draft_events', markets: 'cms_draft_markets' }[k];
    if (!table) throw E.notFound();
    const row = db.prepare(`SELECT * FROM ${table} WHERE ticker=?`).get(t);
    if (!row) throw E.conflict('not_a_draft', 'only drafts can be discarded; use market ops to pause or close published markets');
    if (k === 'series' && db.prepare('SELECT 1 FROM cms_draft_events WHERE series_ticker=?').get(t)) throw E.conflict('has_children', 'discard the draft events of this series first');
    if (k === 'events' && db.prepare('SELECT 1 FROM cms_draft_markets WHERE event_ticker=?').get(t)) throw E.conflict('has_children', 'discard the draft markets of this event first');
    db.prepare(`DELETE FROM ${table} WHERE ticker=?`).run(t);
    audit(req, `catalog.${k}.discard`, k, t, row, null);
    res.json({ ok: true });
  });

  // ---- publish (draft → live tables). Publishing a child publishes its draft parents; an event publishes its draft markets.
  function publishSeries(t) {
    const d = draftSeries(t);
    if (!d) return null;
    db.prepare('INSERT INTO series(ticker,title,slug,category,tags,frequency,fee_type,fee_multiplier,settlement_sources,rules) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(d.ticker, d.title, d.slug, d.category, d.tags, d.frequency, d.fee_type, d.fee_multiplier, d.settlement_sources, d.rules);
    db.prepare('DELETE FROM cms_draft_series WHERE ticker=?').run(t);
    return t;
  }
  function publishEventRow(t, published) {
    const d = draftEvent(t);
    if (!d) return;
    if (publishSeries(d.series_ticker)) published.push({ kind: 'series', ticker: d.series_ticker });
    db.prepare('INSERT INTO events(ticker,series_ticker,title,sub_title,category,mutually_exclusive,is_live,live_label,news,featured,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(d.ticker, d.series_ticker, d.title, d.sub_title, d.category, d.mutually_exclusive, d.is_live, d.live_label, d.news, d.featured, nowIso());
    if (d.icon_color) db.prepare('INSERT INTO cms_event_meta(event_ticker,icon_color,updated_at) VALUES(?,?,?) ON CONFLICT(event_ticker) DO UPDATE SET icon_color=excluded.icon_color').run(t, d.icon_color, nowIso());
    db.prepare('DELETE FROM cms_draft_events WHERE ticker=?').run(t);
    published.push({ kind: 'event', ticker: t });
  }
  const pendingLiquidity = [];
  function publishMarketRow(t, published) {
    const d = draftMarket(t);
    if (!d) return;
    publishEventRow(d.event_ticker, published);
    const now = nowIso();
    const status = Date.parse(d.open_time) <= Date.now() ? 'active' : 'initialized';
    db.prepare('INSERT INTO markets(ticker,event_ticker,title,yes_sub_title,no_sub_title,color,status,open_time,close_time,expected_expiration_time,settlement_timer_seconds,rules_primary,created_at,updated_at,fractional_trading_enabled,price_level_structure,market_type,floor_strike,cap_strike,scalar_unit) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(d.ticker, d.event_ticker, d.title, d.yes_sub_title, d.no_sub_title, d.color, status, d.open_time, d.close_time, d.expected_expiration_time, d.settlement_timer_seconds, d.rules_primary, now, now, d.fractional,
        d.price_level_structure || 'linear_cent', d.market_type || 'binary', d.floor_strike ?? null, d.cap_strike ?? null, d.scalar_unit || '');
    db.prepare('DELETE FROM cms_draft_markets WHERE ticker=?').run(t);
    const pl = setting('publish_liquidity');
    if (d.seed_liquidity && pl.enabled) {
      db.prepare('INSERT INTO ops_liquidity(market_ticker,enabled,spread_cents,size_contracts,levels,fair_cents,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(market_ticker) DO UPDATE SET enabled=1, fair_cents=excluded.fair_cents')
        .run(d.ticker, 1, pl.spread_cents, pl.size_contracts, pl.levels, d.initial_price, now);
      pendingLiquidity.push(d.ticker);
    }
    published.push({ kind: 'market', ticker: t, status });
  }
  function validateEventPublish(t) {
    const live = db.prepare('SELECT COUNT(*) c FROM markets WHERE event_ticker=?').get(t).c;
    const drafts = db.prepare('SELECT COUNT(*) c FROM cms_draft_markets WHERE event_ticker=?').get(t).c;
    if (!live && !drafts) throw E.conflict('no_markets', 'an event needs at least one market before it can be published');
  }
  v1.post(`${A}/catalog/:kind/:ticker/publish`, can('catalog.write'), (req, res) => {
    const t = req.params.ticker.toUpperCase();
    const k = req.params.kind;
    const published = [];
    tx(db, () => {
      if (k === 'series') {
        if (!draftSeries(t)) throw E.conflict('not_a_draft', 'already published');
        publishSeries(t); published.push({ kind: 'series', ticker: t });
      } else if (k === 'events') {
        const d = draftEvent(t);
        if (!d) throw E.conflict('not_a_draft', 'already published');
        validateEventPublish(t);
        publishEventRow(t, published);
        for (const m of db.prepare('SELECT ticker FROM cms_draft_markets WHERE event_ticker=? ORDER BY created_at').all(t)) publishMarketRow(m.ticker, published);
      } else if (k === 'markets') {
        if (!draftMarket(t)) throw E.conflict('not_a_draft', 'already published');
        publishMarketRow(t, published);
      } else throw E.notFound();
    });
    for (const p of published) if (p.kind === 'market') engine.emit('lifecycle', p.ticker, 'created', p.status);
    flushLiquidity();
    audit(req, `catalog.${k}.publish`, k, t, null, { published });
    res.json({ published });
  });

  // Preview of a draft (or published) event in the public card shape.
  v1.get(`${A}/catalog/preview/:ticker`, can('catalog.read'), (req, res) => {
    const t = req.params.ticker.toUpperCase();
    const live = getEvent(t);
    if (live) return res.json({ state: 'published', event: eventFull(live) });
    const d = draftEvent(t);
    if (!d) throw E.notFound();
    const s = getSeries(d.series_ticker) || draftSeries(d.series_ticker);
    const pseudo = (m) => ({ ticker: m.ticker, event_ticker: m.event_ticker, title: m.title, yes_sub_title: m.yes_sub_title, no_sub_title: m.no_sub_title, color_code: m.color, status: 'draft',
      open_time: m.open_time, close_time: m.close_time, expected_expiration_time: m.expected_expiration_time, rules_primary: m.rules_primary, last_price_dollars: dollars(m.initial_price), yes_ask_dollars: dollars(Math.min(99, m.initial_price + 1)), volume_fp: '0.00' });
    const markets = db.prepare('SELECT * FROM cms_draft_markets WHERE event_ticker=? ORDER BY created_at').all(t).map(pseudo);
    res.json({ state: 'draft', event: { event_ticker: d.ticker, series_ticker: d.series_ticker, series_slug: s?.slug || '', series_title: s?.title || '', title: d.title, sub_title: d.sub_title, category: d.category,
      mutually_exclusive: !!d.mutually_exclusive, is_live: !!d.is_live, live_label: d.live_label, news: d.news, featured: !!d.featured, icon_color: d.icon_color || null, tags: s ? JSON.parse(s.tags) : [], markets, dollar_volume: 0,
      close_time: markets.map((m) => m.close_time).sort()[0] || null, rules: s?.rules || '' } });
  });

  // ---- CSV bulk import of markets
  v1.get(`${A}/catalog/import/template.csv`, can('catalog.read'), (req, res) => {
    const close = new Date(Date.now() + 30 * 86400000).toISOString();
    const rows = [IMPORT_COLUMNS, ['PLXEXAMPLE-27Q1', 'PLXEXAMPLE-27Q1-YES', 'It happens', 'It does not', '', '#2f6fed', '', close, '', '300', '', '50', '1']];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="parlance-market-import-template.csv"');
    res.send(rows.map((r) => r.map(csvEsc).join(',')).join('\n') + '\n');
  });
  v1.post(`${A}/catalog/import`, can('catalog.write'), (req, res) => {
    const text = String((req.body && req.body.csv) || '');
    if (!text.trim()) throw new FieldError({ csv: 'paste or upload a CSV file' });
    if (text.length > 60000) throw new FieldError({ csv: 'the file is too large (60 KB max)' });
    const rows = parseCsv(text);
    const header = rows.shift().map((h) => h.trim().toLowerCase());
    const missing = ['event_ticker', 'market_ticker', 'yes_sub_title', 'close_time'].filter((c) => !header.includes(c));
    if (missing.length) throw new FieldError({ csv: `missing required column(s): ${missing.join(', ')}` });
    const unknown = header.filter((h) => !IMPORT_COLUMNS.includes(h));
    if (unknown.length) throw new FieldError({ csv: `unknown column(s): ${unknown.join(', ')}` });
    if (rows.length > 500) throw new FieldError({ csv: 'at most 500 rows per import' });
    const batch = newId('imp_');
    const created = []; const errors = []; const seen = new Set();
    tx(db, () => {
      rows.forEach((r, i) => {
        const obj = Object.fromEntries(header.map((h, j) => [h, (r[j] ?? '').trim()]));
        try {
          if (seen.has(String(obj.market_ticker).toUpperCase())) throw new FieldError({ market_ticker: 'appears twice in this file' });
          const d = marketDraftFrom(obj, batch, req.auth.user.id);
          insertDraftMarket(d);
          seen.add(d.ticker);
          created.push(d.ticker);
        } catch (e) {
          if (!(e instanceof FieldError)) throw e;
          errors.push({ row: i + 2, market_ticker: obj.market_ticker || '', errors: Object.entries(e.fields).map(([f, m]) => `${f} ${m}`) });
        }
      });
    });
    audit(req, 'catalog.import', 'import', batch, null, { created, errors: errors.length });
    res.status(created.length ? 201 : 200).json({ batch, created, errors, rows: rows.length });
  });

  // ================================================================ liquidity bot (re-quoting via the liquidity user)
  function requote(ticker) {
    const lp = lpId();
    if (!lp) return { placed: 0, canceled: 0 };
    const cfg = db.prepare('SELECT * FROM ops_liquidity WHERE market_ticker=?').get(ticker);
    const m = getMarket(ticker);
    if (!m) return { placed: 0, canceled: 0 };
    let canceled = 0; let placed = 0;
    if (['active', 'inactive'].includes(m.status)) {
      for (const o of db.prepare("SELECT id FROM orders WHERE user_id=? AND market_ticker=? AND status='resting'").all(lp, ticker)) {
        try { engine.cancelOrder(lp, o.id, 'requote'); canceled += 1; } catch { /* already gone */ }
      }
    }
    if (!cfg || !cfg.enabled || m.status !== 'active') return { placed, canceled };
    const q = engine.quote(ticker);
    const fair = Math.max(2, Math.min(98, q.last_price ?? cfg.fair_cents ?? 50));
    const half = Math.max(1, Math.round(cfg.spread_cents / 2));
    for (let lvl = 0; lvl < cfg.levels; lvl++) {
      const yesBid = fair - half - lvl;
      const noBid = 100 - (fair + half + lvl);
      for (const [side, price] of [['yes', yesBid], ['no', noBid]]) {
        if (price < 1 || price > 99) continue;
        try { engine.placeOrder(lp, { ticker, side, price, count: cfg.size_contracts * UNITS, post_only: true, source: 'liquidity' }); placed += 1; } catch { /* would cross or market closed */ }
      }
    }
    return { placed, canceled };
  }
  function flushLiquidity() {
    while (pendingLiquidity.length) { const t = pendingLiquidity.shift(); try { requote(t); } catch (e) { console.error('requote', t, e); } }
  }
  // Markets published before their open time get their starting liquidity when they activate.
  engine.on('lifecycle', (ticker, type) => {
    if (type !== 'activated') return;
    if (!db.prepare('SELECT 1 FROM ops_liquidity WHERE market_ticker=? AND enabled=1').get(ticker)) return;
    setImmediate(() => { try { requote(ticker); } catch (e) { console.error('requote', ticker, e); } });
  });

  // ================================================================ resolution desk
  const resVo = (r) => r && ({ id: r.id, result: r.result, source_note: r.source_note, settlement_delay_sec: r.settlement_delay_sec, status: r.status, resolved_by: emailOf(r.resolved_by), created_at: r.created_at,
    reversed_by: emailOf(r.reversed_by), reversed_at: r.reversed_at, reversal_note: r.reversal_note });
  const emailOf = (uid) => (uid ? db.prepare('SELECT email FROM users WHERE id=?').get(uid)?.email || uid : null);
  function deskRow(m) {
    const vo = marketVo(m, engine.quote(m.ticker));
    const ev = getEvent(m.event_ticker);
    const r = db.prepare('SELECT * FROM res_resolutions WHERE market_ticker=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(m.ticker);
    const settles = m.status === 'determined' ? new Date(Date.parse(m.determined_at) + m.settlement_timer_seconds * 1000).toISOString() : null;
    const settlement = m.status === 'finalized' ? 'settled' : m.status === 'determined' ? 'pending_settlement' : 'awaiting_result';
    return { ticker: m.ticker, event_ticker: m.event_ticker, event_title: ev?.title || '', title: m.title, outcome: m.yes_sub_title, status: m.status, result: m.result || null, close_time: m.close_time,
      can_close_early: !!m.can_close_early, settlement_timer_seconds: m.settlement_timer_seconds, settles_at: settles, settled_at: m.settled_at, settlement,
      open_interest_fp: vo.open_interest_fp, volume_fp: vo.volume_fp, last_price_dollars: vo.last_price_dollars,
      payouts: m.status === 'finalized' ? { users: db.prepare('SELECT COUNT(*) c FROM settlements WHERE market_ticker=?').get(m.ticker).c, paid_dollars: dollars(db.prepare('SELECT COALESCE(SUM(COALESCE(effective_payout_cents,payout_cents)),0) c FROM settlements WHERE market_ticker=?').get(m.ticker).c) } : null,
      market_type: m.market_type || 'binary', ...scalarVo(m),
      resolution: resVo(r) };
  }
  v1.get(`${A}/resolution/queue`, can('catalog.read'), (req, res) => {
    const now = nowIso();
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const rows = db.prepare(`SELECT m.* FROM markets m JOIN events e ON e.ticker=m.event_ticker WHERE e.series_ticker NOT IN (?,?) AND (
        m.status IN ('closed','determined') OR (m.status IN ('active','inactive') AND m.close_time<=?) OR (m.status='finalized' AND m.settled_at>=?)) ORDER BY m.close_time DESC LIMIT 200`)
      .all(COMBO_SERIES, FLASH_SERIES, now, weekAgo);
    const open = db.prepare("SELECT m.* FROM markets m JOIN events e ON e.ticker=m.event_ticker WHERE e.series_ticker NOT IN (?,?) AND m.status IN ('active','inactive') AND m.close_time>? ORDER BY m.close_time LIMIT 300").all(COMBO_SERIES, FLASH_SERIES, now);
    res.json({ queue: rows.map(deskRow), open: open.map((m) => ({ ticker: m.ticker, title: m.title, outcome: m.yes_sub_title, status: m.status, close_time: m.close_time, can_close_early: !!m.can_close_early })) });
  });
  v1.get(`${A}/resolution/:ticker`, can('catalog.read'), (req, res, next) => {
    if (['approvals', 'policy'].includes(req.params.ticker)) return next(); // Phase 5A routes (server/trading-core.js)
    const m = getMarket(req.params.ticker);
    if (!m) throw E.notFound();
    res.json({ market: deskRow(m), history: db.prepare('SELECT * FROM res_resolutions WHERE market_ticker=? ORDER BY created_at DESC, rowid DESC').all(m.ticker).map(resVo) });
  });
  // Resolve a market: binary YES/NO, or a scalar market's expiration value (CLONE_SPEC.md §28.4). With the two-person
  // rule on (server/trading-core.js, §28.7) the request is queued for a second admin and answered 202.
  function validateResolve(m, b) {
    const errs = {};
    const scalar = m.market_type === 'scalar';
    let value = null;
    if (scalar) { value = Number(b.expiration_value); if (b.expiration_value === undefined || b.expiration_value === null || b.expiration_value === '' || !Number.isFinite(value)) errs.expiration_value = 'enter the settlement value'; }
    else if (!['yes', 'no'].includes(b.result)) errs.result = 'choose YES or NO';
    const note = String(b.source_note || '').trim();
    if (note.length < 5 || note.length > 1000) errs.source_note = 'a source note of 5-1000 characters is required';
    let delay = m.settlement_timer_seconds;
    if (b.settlement_delay_sec !== undefined && b.settlement_delay_sec !== '') {
      delay = Number(b.settlement_delay_sec);
      if (!Number.isInteger(delay) || delay < 0 || delay > 604800) errs.settlement_delay_sec = 'must be 0-604800 seconds';
    }
    if (Object.keys(errs).length) throw new FieldError(errs);
    if (getEvent(m.event_ticker)?.series_ticker === COMBO_SERIES) throw E.conflict('combo_market', 'combo markets resolve from their legs');
    if (!['closed', 'active', 'inactive'].includes(m.status)) throw E.conflict('invalid_transition', `cannot resolve a ${m.status} market`);
    if (['active', 'inactive'].includes(m.status) && Date.parse(m.close_time) > Date.now() && !m.can_close_early) throw E.conflict('not_closed', 'this market is still open and cannot close early');
    return { result: scalar ? 'scalar' : b.result, expiration_value: scalar ? value : null, source_note: note, settlement_delay_sec: delay };
  }
  // Runs a validated resolution; `actor` is the request whose admin is audited (the approver under the two-person rule).
  function executeResolve(req, ticker, v, extraAudit = {}) {
    const m = getMarket(ticker);
    if (!m) throw E.notFound();
    const p = validateResolve(m, v);
    const before = deskRow(m);
    db.prepare('UPDATE markets SET settlement_timer_seconds=? WHERE ticker=?').run(p.settlement_delay_sec, m.ticker);
    engine.determine(m.ticker, p.result, { expiration_value: p.expiration_value });
    db.prepare('INSERT INTO res_resolutions(id,market_ticker,result,source_note,settlement_delay_sec,status,resolved_by,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(newId('res_'), m.ticker, p.result === 'scalar' ? `scalar:${p.expiration_value}` : p.result, p.source_note, p.settlement_delay_sec, 'determined', req.auth.user.id, nowIso());
    if (p.settlement_delay_sec === 0) engine.finalize(m.ticker);
    const after = deskRow(getMarket(m.ticker));
    audit(req, 'resolution.resolve', 'market', m.ticker, before, { ...after, ...extraAudit }, p.source_note);
    return after;
  }
  v1.post(`${A}/resolution/:ticker/resolve`, can('resolution.write'), (req, res) => {
    const m = getMarket(req.params.ticker);
    if (!m) throw E.notFound();
    const p = validateResolve(m, req.body || {});
    if (hooks.resolutionGate) { const pending = hooks.resolutionGate(req, 'resolve', m.ticker, p); if (pending) return res.status(202).json(pending); }
    res.json({ market: executeResolve(req, m.ticker, p) });
  });
  // Reversal is only possible before finalization (no money has moved yet). See CLONE_SPEC §18.4.
  v1.post(`${A}/resolution/:ticker/reverse`, can('resolution.write'), (req, res) => {
    const m = getMarket(req.params.ticker);
    if (!m) throw E.notFound();
    const note = reasonOf({ reason: (req.body || {}).note ?? (req.body || {}).reason }, 5);
    if (m.status === 'finalized') throw E.conflict('already_settled', 'this market has already settled; payouts cannot be reversed from the desk', 'use POST /admin/resolution/:ticker/correct (settlement correction with claw-back, CLONE_SPEC.md §28.7)');
    if (m.status !== 'determined') throw E.conflict('invalid_transition', `only a determined market can be reversed (status is ${m.status})`);
    if (hasTable('combo_legs')) {
      const dep = db.prepare("SELECT cm.ticker FROM combo_legs cl JOIN markets cm ON cm.ticker=cl.combo_ticker WHERE cl.market_ticker=? AND cm.status IN ('determined','finalized') LIMIT 1").get(m.ticker);
      if (dep) throw E.conflict('combo_dependency', 'a combo has already resolved from this result; it cannot be reversed', dep.ticker);
    }
    const before = deskRow(m);
    tx(db, () => {
      db.prepare("UPDATE markets SET status='closed', result='', determined_at=NULL, updated_at=? WHERE ticker=? AND status='determined'").run(nowIso(), m.ticker);
      db.prepare("UPDATE res_resolutions SET status='reversed', reversed_by=?, reversed_at=?, reversal_note=? WHERE market_ticker=? AND status='determined'").run(req.auth.user.id, nowIso(), note, m.ticker);
    });
    engine.emit('lifecycle', m.ticker, 'determination_reversed', 'closed');
    const after = deskRow(getMarket(m.ticker));
    audit(req, 'resolution.reverse', 'market', m.ticker, before, after, note);
    res.json({ market: after });
  });
  v1.post(`${A}/resolution/:ticker/finalize`, can('resolution.write'), (req, res) => {
    const m = getMarket(req.params.ticker);
    if (!m) throw E.notFound();
    if (m.status !== 'determined') throw E.conflict('invalid_transition', 'only a determined market can be settled');
    const before = deskRow(m);
    engine.finalize(m.ticker);
    db.prepare("UPDATE res_resolutions SET status='finalized' WHERE market_ticker=? AND status='determined'").run(m.ticker);
    const after = deskRow(getMarket(m.ticker));
    audit(req, 'resolution.finalize', 'market', m.ticker, before, after);
    res.json({ market: after });
  });
  engine.on('lifecycle', (ticker, type) => { if (type === 'settled') db.prepare("UPDATE res_resolutions SET status='finalized' WHERE market_ticker=? AND status='determined'").run(ticker); });
  v1.post(`${A}/resolution/:ticker/close`, can('resolution.write'), (req, res) => {
    const m = getMarket(req.params.ticker);
    if (!m) throw E.notFound();
    const reason = reasonOf(req.body);
    if (!m.can_close_early && Date.parse(m.close_time) > Date.now()) throw E.conflict('cannot_close_early', 'this market does not allow early close');
    const before = deskRow(m);
    engine.close(m.ticker);
    const after = deskRow(getMarket(m.ticker));
    audit(req, 'resolution.close_early', 'market', m.ticker, before, after, reason);
    res.json({ market: after });
  });

  // ================================================================ content CMS
  const C = (table, fields, extra = {}) => ({ table, fields, ...extra });
  const COLL = {
    hubs: C('cms_hubs', { title: F.text(1, 60), category: F.category(), position: F.int(0, 9999, 0), active: F.bool(1) }),
    promos: C('cms_promos', { overline: F.text(0, 30, ''), title: F.text(1, 80), subtitle: F.text(0, 140, ''), link: F.link(), color: F.color('#008751'), starts_at: F.time(true), ends_at: F.time(true), position: F.int(0, 9999, 0), active: F.bool(1),
      series_tickers: F.jsonList('series', 20), categories: F.jsonList('category', 10), hide_logged_out: F.bool(0) }), // targeting (G8)
    banners: C('cms_banners', { content: F.text(1, 240), link: F.link(true), visibility: F.oneOf(['all', 'logged_in', 'logged_out'], 'all'), position: F.oneOf(['top', 'bottom'], 'top'), starts_at: F.time(true), ends_at: F.time(true), active: F.bool(1) }),
    info_cards: C('cms_info_cards', { title: F.text(1, 40), subtitle: F.text(0, 80, ''), link: F.link(), icon: F.oneOf(['shield', 'bars', 'clock', 'star', 'info'], 'info'), position: F.int(0, 9999, 0), active: F.bool(1) }),
    news: C('cms_news', { event_ticker: F.ticker(), source: F.text(1, 40), published_at: F.time(), headline: F.text(1, 160), summary: F.text(0, 800, ''), position: F.int(0, 9999, 0), active: F.bool(1) }, { order: 'published_at DESC' }),
    help: C('cms_help', { slug: F.slug(), title: F.text(1, 100), body: F.text(1, 20000), published: F.bool(1), position: F.int(0, 9999, 0), active: F.bool(1) }),
  };
  const collCheck = (name, v, id) => {
    const errs = {};
    if ((name === 'promos' || name === 'banners') && v.starts_at && v.ends_at && Date.parse(v.ends_at) <= Date.parse(v.starts_at)) errs.ends_at = 'must be after the start';
    if (name === 'news' && !getEvent(v.event_ticker)) errs.event_ticker = 'no such published event';
    if (name === 'promos') { const miss = JSON.parse(v.series_tickers || '[]').filter((t) => !getSeries(t)); if (miss.length) errs.series_tickers = `no such series: ${miss.join(', ')}`; }
    if (name === 'help' && db.prepare('SELECT 1 FROM cms_help WHERE slug=? AND id<>?').get(v.slug, id || '')) errs.slug = 'is already used';
    if (Object.keys(errs).length) throw new FieldError(errs);
  };
  const collGet = (c, id) => db.prepare(`SELECT * FROM ${c.table} WHERE id=?`).get(id);
  v1.get(`${A}/content/:coll`, can('content.write'), (req, res, next) => {
    const c = COLL[req.params.coll];
    if (!c) return next();
    res.json({ items: db.prepare(`SELECT * FROM ${c.table} ORDER BY ${c.order || 'position, created_at'}`).all() });
  });
  v1.post(`${A}/content/:coll`, can('content.write'), (req, res, next) => {
    const c = COLL[req.params.coll];
    if (!c) return next();
    const v = check(req.body || {}, c.fields);
    collCheck(req.params.coll, v);
    const id = newId(`${req.params.coll.slice(0, 3)}_`);
    const now = nowIso();
    const cols = Object.keys(c.fields);
    db.prepare(`INSERT INTO ${c.table}(id,${cols.join(',')},created_at,updated_at) VALUES(?,${cols.map(() => '?').join(',')},?,?)`).run(id, ...cols.map((k) => v[k]), now, now);
    const row = collGet(c, id);
    audit(req, `content.${req.params.coll}.create`, req.params.coll, id, null, row);
    res.status(201).json({ item: row });
  });
  v1.put(`${A}/content/:coll/:id`, can('content.write'), (req, res, next) => {
    const c = COLL[req.params.coll];
    if (!c) return next();
    const cur = collGet(c, req.params.id);
    if (!cur) throw E.notFound();
    const v = check(req.body || {}, c.fields, cur);
    collCheck(req.params.coll, v, cur.id);
    const cols = Object.keys(c.fields);
    db.prepare(`UPDATE ${c.table} SET ${cols.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`).run(...cols.map((k) => v[k]), nowIso(), cur.id);
    const row = collGet(c, cur.id);
    audit(req, `content.${req.params.coll}.update`, req.params.coll, cur.id, cur, row);
    res.json({ item: row });
  });
  v1.delete(`${A}/content/:coll/:id`, can('content.write'), (req, res, next) => {
    const c = COLL[req.params.coll];
    if (!c) return next();
    const cur = collGet(c, req.params.id);
    if (!cur) throw E.notFound();
    db.prepare(`DELETE FROM ${c.table} WHERE id=?`).run(cur.id);
    audit(req, `content.${req.params.coll}.delete`, req.params.coll, cur.id, cur, null);
    res.json({ ok: true });
  });
  // Hero carousel: ordered selection of events (empty = featured events, the default).
  v1.get(`${A}/hero`, can('content.write'), (req, res) => {
    const sel = db.prepare('SELECT h.event_ticker, h.position, e.title FROM cms_hero h LEFT JOIN events e ON e.ticker=h.event_ticker ORDER BY h.position').all();
    const candidates = db.prepare('SELECT ticker, title, category, featured FROM events WHERE series_ticker NOT IN (?,?) ORDER BY rowid').all(COMBO_SERIES, FLASH_SERIES);
    res.json({ selected: sel, candidates: candidates.map((e) => ({ event_ticker: e.ticker, title: e.title, category: e.category, featured: !!e.featured })) });
  });
  v1.put(`${A}/hero`, can('content.write'), (req, res) => {
    const list = Array.isArray(req.body && req.body.event_tickers) ? req.body.event_tickers.map(String) : null;
    if (!list || list.length > 12) throw new FieldError({ event_tickers: 'choose up to 12 events' });
    const bad = list.filter((t) => !getEvent(t));
    if (bad.length) throw new FieldError({ event_tickers: `unknown event(s): ${bad.join(', ')}` });
    const before = db.prepare('SELECT event_ticker FROM cms_hero ORDER BY position').all().map((r) => r.event_ticker);
    tx(db, () => { db.prepare('DELETE FROM cms_hero').run(); [...new Set(list)].forEach((t, i) => db.prepare('INSERT INTO cms_hero(event_ticker,position) VALUES(?,?)').run(t, i)); });
    audit(req, 'content.hero.set', 'hero', 'home', before, [...new Set(list)]);
    res.json({ selected: [...new Set(list)] });
  });
  // Category navigation + featured tab.
  v1.get(`${A}/nav`, can('content.write'), (req, res) => res.json(navConfig()));
  v1.put(`${A}/nav`, can('content.write'), (req, res) => {
    const b = req.body || {};
    const cats = Array.isArray(b.categories) ? b.categories : null;
    if (!cats) throw new FieldError({ categories: 'categories list is required' });
    const names = cats.map((c) => c && c.name);
    if (names.length !== CATEGORIES.length || CATEGORIES.some((c) => !names.includes(c))) throw new FieldError({ categories: 'must list every site category exactly once' });
    const errs = {};
    cats.forEach((c, i) => { if (String(c.label || '').length > 24) errs[`categories.${i}.label`] = 'must be at most 24 characters'; });
    const ft = check(b.featured || {}, { label: F.text(1, 24), href: F.link(), color: F.optColor() });
    if (Object.keys(errs).length) throw new FieldError(errs);
    const before = navConfig();
    tx(db, () => {
      db.prepare('DELETE FROM cms_nav').run();
      cats.forEach((c, i) => db.prepare('INSERT INTO cms_nav(category,label,position,hidden) VALUES(?,?,?,?)').run(c.name, String(c.label || '').trim(), i, c.hidden ? 1 : 0));
      putSetting('featured_tab', ft, req.auth.user.id);
    });
    const after = navConfig();
    audit(req, 'content.nav.set', 'nav', 'categories', before, after);
    res.json(after);
  });

  // ================================================================ market ops
  v1.get(`${A}/ops`, can('markets.ops'), (req, res) => {
    const liq = new Map(db.prepare('SELECT * FROM ops_liquidity').all().map((r) => [r.market_ticker, r]));
    const flags = new Map(db.prepare('SELECT * FROM ops_market_flags').all().map((r) => [r.market_ticker, r]));
    const rows = db.prepare("SELECT m.*, e.title et, e.series_ticker st FROM markets m JOIN events e ON e.ticker=m.event_ticker WHERE e.series_ticker NOT IN (?,?) AND m.status IN ('initialized','active','inactive') ORDER BY m.rowid").all(COMBO_SERIES, FLASH_SERIES);
    const markets = rows.map((m) => {
      const vo = marketVo(m, engine.quote(m.ticker));
      const l = liq.get(m.ticker);
      return { ticker: m.ticker, event_title: m.et, series_ticker: m.st, outcome: m.yes_sub_title, status: m.status, yes_bid_dollars: vo.yes_bid_dollars, yes_ask_dollars: vo.yes_ask_dollars, last_price_dollars: vo.last_price_dollars,
        volume_fp: vo.volume_fp, open_interest_fp: vo.open_interest_fp, liquidity: l ? { enabled: !!l.enabled, spread_cents: l.spread_cents, size_contracts: l.size_contracts, levels: l.levels } : null,
        combo_eligible: flags.has(m.ticker) ? !!flags.get(m.ticker).combo_eligible : true };
    });
    const series = db.prepare('SELECT ticker, title, fee_type, fee_multiplier FROM series WHERE ticker NOT IN (?) ORDER BY rowid').all(COMBO_SERIES);
    let rolling = null;
    if (hasTable('flash_windows')) {
      const cur = db.prepare('SELECT * FROM flash_windows ORDER BY start_ts DESC LIMIT 1').get();
      rolling = { window_seconds: Math.max(5, Number(rollingWindowSec) || 900), series_ticker: FLASH_SERIES, windows_total: db.prepare('SELECT COUNT(*) c FROM flash_windows').get().c,
        current: cur ? { event_ticker: cur.event_ticker, market_ticker: cur.market_ticker, start_time: new Date(cur.start_ts).toISOString(), end_time: new Date(cur.end_ts).toISOString(), target_dollars: dollars(cur.target_cents) } : null,
        recent: db.prepare('SELECT * FROM flash_windows WHERE result IS NOT NULL ORDER BY end_ts DESC LIMIT 5').all().map((w) => ({ event_ticker: w.event_ticker, end_time: new Date(w.end_ts).toISOString(), target_dollars: dollars(w.target_cents), close_dollars: dollars(w.close_cents), result: w.result })),
        configurable: 'ROLLING_WINDOW_SEC environment variable / start({rollingWindowSec}) (read at boot)' };
    }
    res.json({ trading_active: engine.tradingActive, markets, series, rolling, combos_available: combosAvailable, publish_liquidity: setting('publish_liquidity') });
  });
  v1.post(`${A}/ops/exchange`, can('markets.ops'), (req, res) => {
    const reason = reasonOf(req.body);
    const before = { trading_active: engine.tradingActive };
    engine.tradingActive = !!(req.body && req.body.trading_active);
    db.prepare("INSERT INTO meta(key,value) VALUES('trading_active',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(engine.tradingActive ? '1' : '0');
    audit(req, 'ops.exchange', 'exchange', 'trading', before, { trading_active: engine.tradingActive }, reason);
    res.json({ trading_active: engine.tradingActive });
  });
  v1.post(`${A}/ops/markets/:ticker/:action`, can('markets.ops'), (req, res) => {
    const m = getMarket(req.params.ticker);
    if (!m) throw E.notFound();
    const action = req.params.action;
    if (!['pause', 'resume', 'requote'].includes(action)) throw E.notFound();
    const reason = action === 'requote' ? '' : reasonOf(req.body);
    const before = { status: m.status };
    let extra = null;
    if (action === 'pause') engine.deactivate(m.ticker);
    else if (action === 'resume') engine.activate(m.ticker); // cancels resting orders (spec §4.4); configured liquidity re-quotes
    else extra = requote(m.ticker);
    const after = { status: getMarket(m.ticker).status, ...(extra || {}) };
    audit(req, `ops.market.${action}`, 'market', m.ticker, before, after, reason);
    res.json({ market: after });
  });
  v1.put(`${A}/ops/series/:ticker/fee`, can('markets.ops'), (req, res) => {
    const s = getSeries(req.params.ticker);
    if (!s || s.ticker === COMBO_SERIES) throw E.notFound();
    const v = check(req.body || {}, { fee_multiplier: F.num(0, 10) });
    const reason = reasonOf(req.body);
    db.prepare('UPDATE series SET fee_multiplier=? WHERE ticker=?').run(v.fee_multiplier, s.ticker);
    audit(req, 'ops.series.fee', 'series', s.ticker, { fee_multiplier: s.fee_multiplier }, { fee_multiplier: v.fee_multiplier }, reason);
    res.json({ series: { ticker: s.ticker, fee_multiplier: v.fee_multiplier } });
  });
  v1.put(`${A}/ops/markets/:ticker/liquidity`, can('markets.ops'), (req, res) => {
    const m = getMarket(req.params.ticker);
    if (!m) throw E.notFound();
    const cur = db.prepare('SELECT * FROM ops_liquidity WHERE market_ticker=?').get(m.ticker);
    const v = check(req.body || {}, { enabled: F.bool(1), spread_cents: F.int(2, 40), size_contracts: F.int(1, 10000), levels: F.int(1, 5, 1) }, cur ? { ...cur } : null);
    const fair = engine.quote(m.ticker).last_price ?? cur?.fair_cents ?? 50;
    db.prepare('INSERT INTO ops_liquidity(market_ticker,enabled,spread_cents,size_contracts,levels,fair_cents,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(market_ticker) DO UPDATE SET enabled=excluded.enabled, spread_cents=excluded.spread_cents, size_contracts=excluded.size_contracts, levels=excluded.levels, fair_cents=excluded.fair_cents, updated_at=excluded.updated_at')
      .run(m.ticker, v.enabled, v.spread_cents, v.size_contracts, v.levels, fair, nowIso());
    const r = requote(m.ticker);
    audit(req, 'ops.market.liquidity', 'market', m.ticker, cur || null, { ...v, ...r });
    res.json({ liquidity: { ...v, enabled: !!v.enabled }, requote: r });
  });
  v1.put(`${A}/ops/markets/:ticker/combo`, can('markets.ops'), (req, res) => {
    if (!combosAvailable) throw E.notFound();
    const m = getMarket(req.params.ticker);
    if (!m) throw E.notFound();
    const eligible = !!(req.body && req.body.eligible);
    const before = db.prepare('SELECT combo_eligible FROM ops_market_flags WHERE market_ticker=?').get(m.ticker);
    db.prepare('INSERT INTO ops_market_flags(market_ticker,combo_eligible,updated_at) VALUES(?,?,?) ON CONFLICT(market_ticker) DO UPDATE SET combo_eligible=excluded.combo_eligible, updated_at=excluded.updated_at').run(m.ticker, eligible ? 1 : 0, nowIso());
    audit(req, 'ops.market.combo', 'market', m.ticker, { combo_eligible: before ? !!before.combo_eligible : true }, { combo_eligible: eligible });
    res.json({ combo_eligible: eligible });
  });

  // ================================================================ perps ops
  const perpRow = (m) => ({ ticker: m.ticker, title: m.title, asset_class: m.asset_class, status: m.status, max_leverage: m.max_leverage, index_price: m.index_price, sim_frozen: !!m.sim_frozen,
    next_funding_time: m.next_funding_ts ? new Date(m.next_funding_ts).toISOString() : null, last_funding_time: m.last_funding_ts ? new Date(m.last_funding_ts).toISOString() : null });
  const perpGet = (t) => (hasTable('perp_markets') ? db.prepare('SELECT * FROM perp_markets WHERE ticker=?').get(String(t).toUpperCase()) : null);
  v1.get(`${A}/perps`, can('perps.ops'), (req, res) => {
    if (!hasTable('perp_markets')) return res.json({ markets: [], available: false });
    res.json({ available: true, markets: db.prepare('SELECT * FROM perp_markets ORDER BY sort_order').all().map(perpRow) });
  });
  v1.post(`${A}/perps/:ticker/:action`, can('perps.ops'), (req, res) => {
    const m = perpGet(req.params.ticker);
    if (!m) throw E.notFound();
    const a = req.params.action;
    if (!['halt', 'resume', 'funding'].includes(a)) throw E.notFound();
    const before = perpRow(m);
    let out = null;
    if (a === 'halt') { reasonOf(req.body); if (m.status !== 'active') throw E.conflict('invalid_transition', `market is ${m.status}`); db.prepare("UPDATE perp_markets SET status='halted' WHERE ticker=?").run(m.ticker); }
    if (a === 'resume') { if (m.status !== 'halted') throw E.conflict('invalid_transition', `market is ${m.status}`); db.prepare("UPDATE perp_markets SET status='active', sim_ts=? WHERE ticker=?").run(Date.now(), m.ticker); }
    if (a === 'funding') { if (!engine.perps) throw E.conflict('perps_unavailable', 'perps engine is not running'); out = engine.perps.runFunding(m.ticker); }
    const after = perpRow(perpGet(m.ticker));
    audit(req, `perps.${a}`, 'perp_market', m.ticker, before, after, (req.body && req.body.reason) || '');
    res.json({ market: after, result: out });
  });
  v1.put(`${A}/perps/:ticker/leverage`, can('perps.ops'), (req, res) => {
    const m = perpGet(req.params.ticker);
    if (!m) throw E.notFound();
    const v = check(req.body || {}, { max_leverage: F.num(1, 100) });
    const reason = reasonOf(req.body);
    db.prepare('UPDATE perp_markets SET max_leverage=? WHERE ticker=?').run(v.max_leverage, m.ticker);
    audit(req, 'perps.leverage', 'perp_market', m.ticker, { max_leverage: m.max_leverage }, { max_leverage: v.max_leverage }, reason);
    res.json({ market: perpRow(perpGet(m.ticker)) });
  });

  // ================================================================ users
  const userBrief = (u) => ({ user_id: u.id, email: u.email, display_name: u.display_name, nickname: u.nickname || null, balance_dollars: dollars(u.balance_cents), created_at: u.created_at,
    is_system: !!u.is_system, locked: isLocked(u.id), banned: isBanned(u.id), roles: rolesOf(u) });
  v1.get(`${A}/users`, can('users.read'), (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const where = "WHERE (?='' OR lower(u.email) LIKE ? OR lower(u.display_name) LIKE ? OR lower(COALESCE(sp.nickname,'')) LIKE ?)";
    const args = [q, `%${q}%`, `%${q}%`, `%${q}%`];
    const total = db.prepare(`SELECT COUNT(*) c FROM users u LEFT JOIN social_profiles sp ON sp.user_id=u.id ${where}`).get(...args).c;
    const rows = db.prepare(`SELECT u.*, sp.nickname FROM users u LEFT JOIN social_profiles sp ON sp.user_id=u.id ${where} ORDER BY u.created_at DESC, u.rowid DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    res.json({ total, users: rows.map(userBrief) });
  });
  v1.get(`${A}/users/:id`, can('users.read'), async (req, res) => {
    const u = db.prepare('SELECT u.*, sp.nickname FROM users u LEFT JOIN social_profiles sp ON sp.user_id=u.id WHERE u.id=?').get(req.params.id);
    if (!u) throw E.notFound();
    const p = (path) => `/users/${encodeURIComponent(u.id)}${path}`;
    const [balance, positions, orders, tx_, limitsD, limitsT, limitsS, mfa] = await Promise.all([
      asUser(u.id, p('/balance')), asUser(u.id, p('/positions')), asUser(u.id, p('/orders?status=resting')), asUser(u.id, p('/transactions')),
      asUser(u.id, p('/deposit_limits')), asUser(u.id, p('/trading_limits')), asUser(u.id, p('/daily_session_time_limit')), asUser(u.id, p('/mfa')),
    ]);
    const lock = db.prepare('SELECT * FROM acct_locks WHERE user_id=?').get(u.id);
    res.json({
      user: { ...userBrief(u), verified: !!db.prepare('SELECT 1 FROM mod_verified WHERE user_id=?').get(u.id), lock: lock ? { reason: lock.reason, locked_by: emailOf(lock.locked_by), locked_at: lock.locked_at } : null },
      balance, positions: positions.positions, resting_orders: orders.orders, transactions: tx_.transactions.slice(0, 50), transactions_total: tx_.transactions.length,
      limits: { deposit: limitsD.limit, trading: limitsT.limit, session: limitsS.limit }, mfa_enabled: !!mfa.enabled,
      sessions: db.prepare('SELECT COUNT(*) c FROM sessions WHERE user_id=? AND expires_at>?').get(u.id, nowIso()).c,
      audit: db.prepare("SELECT * FROM admin_audit WHERE target_type='user' AND target_id=? ORDER BY ts DESC LIMIT 20").all(u.id).map((r) => ({ time: new Date(r.ts).toISOString(), actor_email: r.actor_email, action: r.action, reason: r.reason })),
    });
  });
  const targetUser = (req) => {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
    if (!u) throw E.notFound();
    if (u.is_system) throw E.conflict('system_account', 'system accounts cannot be changed here');
    return u;
  };
  v1.post(`${A}/users/:id/adjust`, can('users.money'), (req, res) => {
    const u = targetUser(req);
    const b = req.body || {};
    const amt = Number(b.amount_dollars);
    const errs = {};
    if (!Number.isFinite(amt) || amt === 0 || Math.abs(amt) > 1000000 || Math.abs(Math.round(amt * 100) - amt * 100) > 1e-6) errs.amount_dollars = CS.t('error.adjust_amount', { max: currency.moneyCents(100_000_000) });
    let reason = '';
    try { reason = reasonOf(b); } catch (e) { Object.assign(errs, e.fields); }
    if (Object.keys(errs).length) throw new FieldError(errs);
    const cents = Math.round(amt * 100);
    const before = { balance_dollars: dollars(engine.balance(u.id)) };
    tx(db, () => {
      if (cents < 0 && engine.balance(u.id) + cents < 0) throw E.conflict('insufficient_balance', 'a debit cannot take the cash balance below zero');
      engine.credit(u.id, cents, 'adjustment', `admin:${req.auth.user.id}`, reason);
    });
    engine.emit('user_balance', u.id, engine.balance(u.id));
    notify(u.id, { type: 'account', title: CS.t('notify.balance_adjust.title', { direction: CS.t(cents > 0 ? 'notify.balance_adjust.credit' : 'notify.balance_adjust.debit'), amount: currency.moneyCents(Math.abs(cents)) }), body: reason, link: '/portfolio' });
    const after = { balance_dollars: dollars(engine.balance(u.id)) };
    audit(req, 'users.adjust_balance', 'user', u.id, before, { ...after, amount_dollars: dollars(cents) }, reason);
    res.json(after);
  });
  v1.post(`${A}/users/:id/lock`, can('users.support'), (req, res) => {
    const u = targetUser(req);
    const reason = reasonOf(req.body);
    if (u.id === req.auth.user.id) throw E.conflict('cannot_lock_self', 'you cannot lock your own account');
    if (isLocked(u.id)) throw E.conflict('already_locked', 'account is already locked');
    // Resting orders are canceled so a locked account cannot keep trading passively.
    const resting = db.prepare("SELECT id FROM orders WHERE user_id=? AND status='resting'").all(u.id);
    let canceled = 0;
    for (const o of resting) { try { engine.cancelOrder(u.id, o.id, 'account_locked'); canceled += 1; } catch { /* market not open */ } }
    tx(db, () => {
      db.prepare('INSERT INTO acct_locks(user_id,reason,locked_by,locked_at) VALUES(?,?,?,?)').run(u.id, reason, req.auth.user.id, nowIso());
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
      db.prepare('DELETE FROM mfa_challenges WHERE user_id=?').run(u.id);
    });
    audit(req, 'users.lock', 'user', u.id, { locked: false }, { locked: true, orders_canceled: canceled }, reason);
    res.json({ locked: true, orders_canceled: canceled });
  });
  v1.post(`${A}/users/:id/unlock`, can('users.support'), (req, res) => {
    const u = targetUser(req);
    const reason = reasonOf(req.body);
    if (!isLocked(u.id)) throw E.conflict('not_locked', 'account is not locked');
    db.prepare('DELETE FROM acct_locks WHERE user_id=?').run(u.id);
    audit(req, 'users.unlock', 'user', u.id, { locked: true }, { locked: false }, reason);
    res.json({ locked: false });
  });
  v1.post(`${A}/users/:id/reset_mfa`, can('users.support'), (req, res) => {
    const u = targetUser(req);
    const reason = reasonOf(req.body);
    const had = !!db.prepare('SELECT enabled FROM mfa WHERE user_id=?').get(u.id)?.enabled;
    db.prepare('DELETE FROM mfa WHERE user_id=?').run(u.id);
    db.prepare('DELETE FROM mfa_challenges WHERE user_id=?').run(u.id);
    notify(u.id, { type: 'security', title: 'Two-factor login was reset by support', body: 'Set it up again in Account & security.', link: '/account' });
    audit(req, 'users.reset_mfa', 'user', u.id, { mfa_enabled: had }, { mfa_enabled: false }, reason);
    res.json({ mfa_enabled: false });
  });
  v1.post(`${A}/users/:id/clear_session_time`, can('users.support'), (req, res) => {
    const u = targetUser(req);
    const reason = reasonOf(req.body);
    const day = dayKey(Date.now());
    const before = db.prepare('SELECT seconds FROM session_usage WHERE user_id=? AND day=?').get(u.id, day)?.seconds ?? 0;
    db.prepare('UPDATE session_usage SET seconds=0 WHERE user_id=? AND day=?').run(u.id, day);
    audit(req, 'users.clear_session_time', 'user', u.id, { used_today_seconds: before }, { used_today_seconds: 0 }, reason);
    res.json({ used_today_seconds: 0 });
  });
  // Override a responsible-trading limit immediately (no cooling-off), or remove it with value null.
  v1.put(`${A}/users/:id/limits/:kind`, can('users.money'), (req, res) => {
    const u = targetUser(req);
    const kind = req.params.kind;
    if (!['deposit', 'trading', 'session'].includes(kind)) throw E.notFound();
    const b = req.body || {};
    const reason = reasonOf(b);
    let value = null;
    if (b.value !== null && b.value !== '' && b.value !== undefined) {
      const n = Number(b.value);
      const max = kind === 'session' ? 1440 : 100000;
      if (!Number.isFinite(n) || n <= 0 || n > max) throw new FieldError({ value: kind === 'session' ? 'minutes per day, 1-1440, or empty to remove' : CS.t('error.limit_override', { max: currency.moneyCents(10_000_000) }) });
      value = kind === 'session' ? Math.round(n) : Math.round(n * 100);
    }
    const before = db.prepare('SELECT value, pending_value, pending_set FROM user_limits WHERE user_id=? AND kind=?').get(u.id, kind) || null;
    db.prepare('INSERT INTO user_limits(user_id,kind,value,pending_value,pending_set,pending_effective_at,updated_at) VALUES(?,?,?,NULL,0,NULL,?) ON CONFLICT(user_id,kind) DO UPDATE SET value=excluded.value, pending_value=NULL, pending_set=0, pending_effective_at=NULL, updated_at=excluded.updated_at')
      .run(u.id, kind, value, nowIso());
    audit(req, 'users.override_limit', 'user', u.id, before && { kind, ...before }, { kind, value }, reason);
    res.json({ kind, value });
  });

  // ================================================================ social moderation
  const reportVo = (r) => {
    const author = r.author_id ? db.prepare('SELECT sp.nickname FROM social_profiles sp WHERE sp.user_id=?').get(r.author_id)?.nickname : null;
    const exists = r.kind === 'post' ? !!db.prepare('SELECT 1 FROM posts WHERE id=?').get(r.content_id) : !!db.prepare('SELECT 1 FROM comments WHERE id=?').get(r.content_id);
    return { id: r.id, kind: r.kind, content_id: r.content_id, post_id: r.post_id, excerpt: r.excerpt, reason: r.reason, status: r.status, created_at: r.created_at, reporter_email: emailOf(r.reporter_id),
      author_id: r.author_id, author_nickname: author, author_banned: r.author_id ? isBanned(r.author_id) : false, content_exists: exists,
      hidden: !!db.prepare('SELECT 1 FROM mod_hidden WHERE kind=? AND content_id=?').get(r.kind, r.content_id),
      reports_on_content: db.prepare('SELECT COUNT(*) c FROM mod_reports WHERE kind=? AND content_id=?').get(r.kind, r.content_id).c,
      resolution: r.resolution, resolved_by: emailOf(r.resolved_by), resolved_at: r.resolved_at };
  };
  v1.get(`${A}/moderation/reports`, can('social.moderate'), (req, res) => {
    const st = ['open', 'actioned', 'dismissed', 'all'].includes(req.query.status) ? req.query.status : 'open';
    const rows = db.prepare(`SELECT * FROM mod_reports ${st === 'all' ? '' : 'WHERE status=?'} ORDER BY created_at DESC LIMIT 300`).all(...(st === 'all' ? [] : [st]));
    res.json({ reports: rows.map(reportVo), open_count: db.prepare("SELECT COUNT(*) c FROM mod_reports WHERE status='open'").get().c });
  });
  function moderate(req, kind, contentId, action, reason) {
    let before = null;
    tx(db, () => {
      if (action === 'hide') {
        db.prepare('INSERT INTO mod_hidden(kind,content_id,hidden_by,reason,created_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING').run(kind, contentId, req.auth.user.id, reason, nowIso());
      } else if (action === 'unhide') {
        db.prepare('DELETE FROM mod_hidden WHERE kind=? AND content_id=?').run(kind, contentId);
      } else if (action === 'delete') {
        const t = kind === 'post' ? 'posts' : 'comments';
        before = db.prepare(`SELECT * FROM ${t} WHERE id=?`).get(contentId) || null;
        db.prepare(`DELETE FROM ${t} WHERE id=?`).run(contentId);
      }
      if (action !== 'unhide') {
        db.prepare("UPDATE mod_reports SET status=?, resolution=?, resolved_by=?, resolved_at=? WHERE kind=? AND content_id=? AND status='open'")
          .run(action === 'dismiss' ? 'dismissed' : 'actioned', action, req.auth.user.id, nowIso(), kind, contentId);
      }
    });
    audit(req, `moderation.${action}`, kind, contentId, before, { action }, reason);
  }
  v1.post(`${A}/moderation/reports/:id/:action`, can('social.moderate'), (req, res) => {
    const r = db.prepare('SELECT * FROM mod_reports WHERE id=?').get(req.params.id);
    if (!r) throw E.notFound();
    const action = req.params.action;
    if (!['hide', 'delete', 'dismiss'].includes(action)) throw E.notFound();
    const reason = String((req.body && req.body.reason) || '').trim() || `report ${r.id}`;
    moderate(req, r.kind, r.content_id, action, reason);
    res.json({ report: reportVo(db.prepare('SELECT * FROM mod_reports WHERE id=?').get(r.id)) });
  });
  v1.post(`${A}/moderation/content/:kind/:id/:action`, can('social.moderate'), (req, res) => {
    const kind = req.params.kind;
    if (!['post', 'comment'].includes(kind) || !['hide', 'unhide', 'delete'].includes(req.params.action)) throw E.notFound();
    moderate(req, kind, req.params.id, req.params.action, String((req.body && req.body.reason) || '').trim());
    res.json({ ok: true });
  });
  v1.get(`${A}/moderation/hidden`, can('social.moderate'), (req, res) => {
    const rows = db.prepare('SELECT * FROM mod_hidden ORDER BY created_at DESC LIMIT 200').all();
    res.json({ hidden: rows.map((h) => { const c = db.prepare(`SELECT body, user_id FROM ${h.kind === 'post' ? 'posts' : 'comments'} WHERE id=?`).get(h.content_id); return { kind: h.kind, content_id: h.content_id, excerpt: c ? String(c.body).slice(0, 200) : '(deleted)', author_nickname: c ? db.prepare('SELECT nickname FROM social_profiles WHERE user_id=?').get(c.user_id)?.nickname : null, hidden_by: emailOf(h.hidden_by), created_at: h.created_at, reason: h.reason }; }) });
  });
  const profileRows = (q) => db.prepare("SELECT sp.*, u.email FROM social_profiles sp JOIN users u ON u.id=sp.user_id WHERE (?='' OR lower(sp.nickname) LIKE ? OR lower(u.email) LIKE ?) ORDER BY sp.nickname LIMIT 200")
    .all(q, `%${q}%`, `%${q}%`).map((p) => ({ user_id: p.user_id, nickname: p.nickname, email: p.email, bio: p.bio, banned: isBanned(p.user_id), verified: !!db.prepare('SELECT 1 FROM mod_verified WHERE user_id=?').get(p.user_id),
      ban: db.prepare('SELECT reason, created_at FROM mod_bans WHERE user_id=?').get(p.user_id) || null, posts: db.prepare('SELECT COUNT(*) c FROM posts WHERE user_id=?').get(p.user_id).c }));
  v1.get(`${A}/moderation/profiles`, can('social.moderate'), (req, res) => res.json({ profiles: profileRows(String(req.query.q || '').trim().toLowerCase()) }));
  v1.post(`${A}/moderation/users/:id/:action`, can('social.moderate'), (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
    if (!u || u.is_system) throw E.notFound();
    const a = req.params.action;
    if (!['ban', 'unban', 'verify', 'unverify'].includes(a)) throw E.notFound();
    const reason = a === 'ban' || a === 'unban' ? reasonOf(req.body) : String((req.body && req.body.reason) || '');
    const before = { banned: isBanned(u.id), verified: !!db.prepare('SELECT 1 FROM mod_verified WHERE user_id=?').get(u.id) };
    if (a === 'ban') db.prepare('INSERT INTO mod_bans(user_id,reason,banned_by,created_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET reason=excluded.reason').run(u.id, reason, req.auth.user.id, nowIso());
    if (a === 'unban') db.prepare('DELETE FROM mod_bans WHERE user_id=?').run(u.id);
    if (a === 'verify') db.prepare('INSERT INTO mod_verified(user_id,verified_by,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(u.id, req.auth.user.id, nowIso());
    if (a === 'unverify') db.prepare('DELETE FROM mod_verified WHERE user_id=?').run(u.id);
    const after = { banned: isBanned(u.id), verified: !!db.prepare('SELECT 1 FROM mod_verified WHERE user_id=?').get(u.id) };
    if (a === 'ban') notify(u.id, { type: 'account', title: 'Your posting privileges were removed', body: reason, link: '/social' });
    audit(req, `moderation.${a}`, 'user', u.id, before, after, reason);
    res.json(after);
  });
  // Evidenced social-admin call sites (api_callsites_home.txt lines 27, 28, 144), mapped onto the same permission.
  const SA = '/users/:uid/social/social-admin';
  const selfOnly = (req) => { if (req.params.uid !== req.auth.user.id) throw E.forbidden('cannot access another user'); };
  v1.delete(`${SA}/posts/:pid`, can('social.moderate'), (req, res) => { selfOnly(req); if (!db.prepare('SELECT 1 FROM posts WHERE id=?').get(req.params.pid)) throw E.notFound(); moderate(req, 'post', req.params.pid, 'delete', 'social-admin delete'); res.json({ ok: true }); });
  v1.delete(`${SA}/posts/:pid/comments/:cid`, can('social.moderate'), (req, res) => { selfOnly(req); if (!db.prepare('SELECT 1 FROM comments WHERE id=? AND post_id=?').get(req.params.cid, req.params.pid)) throw E.notFound(); moderate(req, 'comment', req.params.cid, 'delete', 'social-admin delete'); res.json({ ok: true }); });
  v1.get(`${SA}/profiles`, can('social.moderate'), (req, res) => { selfOnly(req); res.json({ profiles: profileRows(String(req.query.query || req.query.q || '').trim().toLowerCase()) }); });

  // ================================================================ announcements
  const SEGMENTS = {
    all: { label: 'Everyone', sql: 'SELECT id FROM users WHERE is_system=0' },
    traders: { label: 'Traders (any fill)', sql: 'SELECT id FROM users u WHERE is_system=0 AND EXISTS (SELECT 1 FROM fills f WHERE f.user_id=u.id)' },
    funded: { get label() { return CS.t('admin.segment.funded', { zero: currency.moneyCents(0) }); }, sql: 'SELECT id FROM users WHERE is_system=0 AND balance_cents>0' },
    no_trades: { label: 'Never traded', sql: 'SELECT id FROM users u WHERE is_system=0 AND NOT EXISTS (SELECT 1 FROM fills f WHERE f.user_id=u.id)' },
    social: { label: 'Social members (have a nickname)', sql: 'SELECT u.id FROM users u JOIN social_profiles sp ON sp.user_id=u.id WHERE u.is_system=0' },
    staff: { label: 'Staff (any admin role)', sql: 'SELECT id FROM users u WHERE is_system=0 AND (is_admin=1 OR EXISTS (SELECT 1 FROM admin_roles r WHERE r.user_id=u.id))' },
  };
  const segmentIds = (seg) => db.prepare(SEGMENTS[seg].sql).all().map((r) => r.id).filter((id) => !isLocked(id));
  v1.get(`${A}/announcements`, can('announce'), (req, res) => {
    res.json({
      segments: Object.entries(SEGMENTS).map(([k, s]) => ({ key: k, label: s.label, count: segmentIds(k).length })),
      templates: db.prepare('SELECT * FROM ann_templates ORDER BY name').all(),
      history: db.prepare('SELECT * FROM ann_announcements ORDER BY created_at DESC LIMIT 100').all().map((a) => ({ ...a, created_by: emailOf(a.created_by) })),
    });
  });
  const ANN_SPEC = { title: F.text(1, 120), body: F.text(0, 500, ''), link: F.link(true) };
  v1.post(`${A}/announcements`, can('announce'), (req, res) => {
    const b = req.body || {};
    const v = check(b, { ...ANN_SPEC, segment: F.oneOf(Object.keys(SEGMENTS), 'all') });
    // Optional promotional topic (Settings › Notifications › Promotional, CLONE_SPEC.md §24.5): recipients' channel choices apply.
    const topic = check(b, { topic: F.oneOf(['', 'breaking_events', 'new_markets', 'politics', 'crypto', 'commodities'], '') }).topic;
    const ids = segmentIds(v.segment);
    const id = newId('ann_');
    for (const uid of ids) notify(uid, { type: topic ? `promo_${topic}` : 'announcement', title: v.title, body: v.body, link: v.link });
    db.prepare('INSERT INTO ann_announcements(id,title,body,link,segment,recipients,template_id,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, v.title, v.body, v.link, v.segment, ids.length, b.template_id ? String(b.template_id) : null, req.auth.user.id, nowIso());
    audit(req, 'announcements.send', 'announcement', id, null, { ...v, recipients: ids.length });
    res.status(201).json({ announcement: { id, ...v, recipients: ids.length } });
  });
  v1.post(`${A}/announcements/templates`, can('announce'), (req, res) => {
    const v = check(req.body || {}, { name: F.text(1, 60), ...ANN_SPEC });
    const id = newId('tpl_'); const now = nowIso();
    db.prepare('INSERT INTO ann_templates(id,name,title,body,link,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id, v.name, v.title, v.body, v.link, now, now);
    audit(req, 'announcements.template.create', 'template', id, null, v);
    res.status(201).json({ template: db.prepare('SELECT * FROM ann_templates WHERE id=?').get(id) });
  });
  v1.delete(`${A}/announcements/templates/:id`, can('announce'), (req, res) => {
    const t = db.prepare('SELECT * FROM ann_templates WHERE id=?').get(req.params.id);
    if (!t) throw E.notFound();
    db.prepare('DELETE FROM ann_templates WHERE id=?').run(t.id);
    audit(req, 'announcements.template.delete', 'template', t.id, t, null);
    res.json({ ok: true });
  });

  // ================================================================ reports dashboard
  function reportRange(q) {
    const today = dayKey(Date.now());
    const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : dayKey(Date.now() - 29 * 86400000);
    const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : today;
    const a = Date.parse(`${from}T00:00:00Z`); const b = Date.parse(`${to}T00:00:00Z`) + 86400000;
    if (!(b > a)) throw new FieldError({ to: 'must be on or after the start date' });
    if ((b - a) / 86400000 > 400) throw new FieldError({ from: 'range is limited to 400 days' });
    return { from, to, a, b };
  }
  async function buildReport(q) {
    const { from, to, a, b } = reportRange(q);
    const days = [];
    for (let t = a; t < b; t += 86400000) days.push(dayKey(t));
    const byDay = Object.fromEntries(days.map((d) => [d, { day: d, trades: 0, volume_units: 0, volume_cents_x: 0, fees_cents: 0, deposits_cents: 0, withdrawals_cents: 0, active_users: 0, signups: 0 }]));
    const DAY = "strftime('%Y-%m-%d', created_ts/1000, 'unixepoch')";
    for (const r of db.prepare(`SELECT ${DAY} d, COUNT(*) n, COALESCE(SUM(count),0) u, COALESCE(SUM(count*yes_price_cc),0)/100 c FROM trades WHERE created_ts>=? AND created_ts<? GROUP BY d`).all(a, b)) {
      if (byDay[r.d]) Object.assign(byDay[r.d], { trades: r.n, volume_units: r.u, volume_cents_x: r.c });
    }
    for (const r of db.prepare(`SELECT ${DAY} d, COALESCE(SUM(fee_cents),0) f, COUNT(DISTINCT f.user_id) au FROM fills f JOIN users u ON u.id=f.user_id WHERE u.is_system=0 AND created_ts>=? AND created_ts<? GROUP BY d`).all(a, b)) {
      if (byDay[r.d]) Object.assign(byDay[r.d], { fees_cents: r.f, active_users: r.au });
    }
    const isoA = new Date(a).toISOString(); const isoB = new Date(b).toISOString();
    for (const r of db.prepare("SELECT substr(created_at,1,10) d, kind, COALESCE(SUM(amount_cents),0) s FROM ledger WHERE kind IN ('deposit','withdrawal') AND created_at>=? AND created_at<? GROUP BY d, kind").all(isoA, isoB)) {
      if (byDay[r.d]) byDay[r.d][r.kind === 'deposit' ? 'deposits_cents' : 'withdrawals_cents'] = Math.abs(r.s);
    }
    for (const r of db.prepare('SELECT substr(created_at,1,10) d, COUNT(*) n FROM users WHERE is_system=0 AND created_at>=? AND created_at<? GROUP BY d').all(isoA, isoB)) if (byDay[r.d]) byDay[r.d].signups = r.n;
    // Volume dollars = Σ count × price / UNITS (same conversion as engine.quote dollar_volume_cents).
    const daily = days.map((d) => { const x = byDay[d]; return { day: d, trades: x.trades, volume_fp: ufp(x.volume_units), volume_dollars: dollars(Math.round(x.volume_cents_x / UNITS)), fees_dollars: dollars(x.fees_cents),
      deposits_dollars: dollars(x.deposits_cents), withdrawals_dollars: dollars(x.withdrawals_cents), active_users: x.active_users, signups: x.signups }; });
    const sumU = days.reduce((s, d) => s + byDay[d].volume_units, 0);
    const sumC = days.reduce((s, d) => s + byDay[d].volume_cents_x, 0);
    const activeTotal = db.prepare('SELECT COUNT(DISTINCT f.user_id) c FROM fills f JOIN users u ON u.id=f.user_id WHERE u.is_system=0 AND f.created_ts>=? AND f.created_ts<?').get(a, b).c;
    // Current state from engine.quote / marketVo (open interest is a point-in-time figure).
    const live = db.prepare("SELECT m.*, e.title et, e.series_ticker st FROM markets m JOIN events e ON e.ticker=m.event_ticker WHERE m.status IN ('active','inactive','closed','determined')").all();
    const lp = lpId();
    const lpPos = lp ? new Map((await asUser(lp, `/users/${encodeURIComponent(lp)}/positions`)).positions.map((p) => [p.ticker, p])) : new Map();
    let oiTotal = 0;
    const exposure = live.map((m) => {
      const vo = marketVo(m, engine.quote(m.ticker));
      oiTotal += Number(vo.open_interest_fp);
      const p = lpPos.get(m.ticker);
      return { ticker: m.ticker, event_title: m.et, outcome: m.yes_sub_title, status: m.status, open_interest_fp: vo.open_interest_fp, notional_dollars: dollars(Math.round(Number(vo.open_interest_fp) * 100)),
        last_price_dollars: vo.last_price_dollars, house_side: p ? p.side : null, house_position_fp: p ? p.position_fp : '0.00', house_cost_dollars: p ? p.total_cost_dollars : '0.0000', house_value_dollars: p ? p.market_value_dollars : '0.0000' };
    }).filter((x) => Number(x.open_interest_fp) > 0 || Number(x.house_position_fp) > 0).sort((x, y) => Number(y.open_interest_fp) - Number(x.open_interest_fp)).slice(0, 25);
    const top = db.prepare('SELECT t.market_ticker, COUNT(*) n, SUM(t.count) u, SUM(t.count*t.yes_price_cc)/100 c FROM trades t WHERE t.created_ts>=? AND t.created_ts<? GROUP BY t.market_ticker ORDER BY u DESC LIMIT 10').all(a, b)
      .map((r) => { const m = getMarket(r.market_ticker); return { ticker: r.market_ticker, title: m?.title || r.market_ticker, outcome: m?.yes_sub_title || '', trades: r.n, volume_fp: ufp(r.u), volume_dollars: dollars(Math.round(r.c / UNITS)) }; });
    return {
      from, to, generated_at: nowIso(),
      totals: {
        trades: days.reduce((s, d) => s + byDay[d].trades, 0), volume_fp: ufp(sumU), volume_dollars: dollars(Math.round(sumC / UNITS)),
        fees_dollars: dollars(days.reduce((s, d) => s + byDay[d].fees_cents, 0)), deposits_dollars: dollars(days.reduce((s, d) => s + byDay[d].deposits_cents, 0)),
        withdrawals_dollars: dollars(days.reduce((s, d) => s + byDay[d].withdrawals_cents, 0)), active_users: activeTotal, signups: days.reduce((s, d) => s + byDay[d].signups, 0),
        open_interest_fp: oiTotal.toFixed(2), users_total: db.prepare('SELECT COUNT(*) c FROM users WHERE is_system=0').get().c,
      },
      daily, top_markets: top, exposure,
    };
  }
  v1.get(`${A}/reports`, can('reports.read'), async (req, res) => res.json(await buildReport(req.query)));
  v1.get(`${A}/reports.csv`, can('reports.read'), async (req, res) => {
    const r = await buildReport(req.query);
    const cols = ['day', 'trades', 'volume_fp', 'volume_dollars', 'fees_dollars', 'deposits_dollars', 'withdrawals_dollars', 'active_users', 'signups'];
    // Money columns in the display currency (CLONE_SPEC.md §30): volume_ngn … in naira, or the original *_dollars under USD.
    const head = cols.map((c) => (c.endsWith('_dollars') ? currency.csvCol(c.slice(0, -8), c) : c));
    const cell = (c, v) => (c.endsWith('_dollars') ? currency.csvDollars(v) : v);
    const lines = [head.join(','), ...r.daily.map((d) => cols.map((c) => csvEsc(cell(c, d[c]))).join(',')),
      ['total', ...cols.slice(1).map((c) => cell(c, r.totals[c]))].map(csvEsc).join(',')];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="parlance-report-${r.from}-to-${r.to}.csv"`);
    res.send(lines.join('\n') + '\n');
  });

  // ================================================================ settings + health
  const secSettings = () => app?.locals?.security?.settings() ?? null; // perimeter: rate-limit tiers + bot management (server/bot.js)
  function settingsVo() {
    return {
      interest_apy: apyNow(), features: features(), publish_liquidity: setting('publish_liquidity'),
      taker_fee: { coefficient: takerFeeCoefficient(), formula: 'fee = ceil(coefficient × C × P × (1 − P) × series fee multiplier)', editable: true, note: 'Applies to new fills immediately; per-series fee multipliers (Market ops) scale it.' },
      rate_limit: { burst: secSettings()?.rate_limits.anonymous.burst ?? rate.burst ?? null, per_second: secSettings()?.rate_limits.anonymous.per_second ?? rate.perSec ?? null, scope: 'anonymous tier, per client IP, /v1 and /trade-api', editable: true, note: 'Defaults from RATE_BURST / RATE_PER_SEC; signed-in, staff, credential-endpoint and write tiers below.' },
      rate_limits: secSettings()?.rate_limits ?? null,
      bot: secSettings()?.bot ?? null,
      rolling_window_seconds: app?.locals?.rolling ? app.locals.rolling.windowSec() : Math.max(5, Number(persistedRollingWindow() ?? rollingWindowSec) || 900),
    };
  }
  v1.get(`${A}/settings`, can('settings.write'), (req, res) => res.json({ settings: settingsVo() }));
  v1.put(`${A}/settings`, can('settings.write'), (req, res) => {
    const b = req.body || {};
    const before = settingsVo();
    const errs = {};
    let apy; let feats; let pl; let fee; let rollSec; let secPatch = null;
    if (b.interest_apy !== undefined) { const n = Number(b.interest_apy); if (!Number.isFinite(n) || n < 0 || n > 0.2) errs.interest_apy = 'must be between 0 and 0.20 (20%)'; else apy = n; }
    if (b.features !== undefined) { if (typeof b.features !== 'object' || !b.features) errs.features = 'must be an object'; else feats = { ...features(), ...Object.fromEntries(['social', 'perps', 'combos'].filter((k) => k in b.features).map((k) => [k, !!b.features[k]])) }; }
    if (b.publish_liquidity !== undefined) {
      try { pl = check(b.publish_liquidity, { enabled: F.bool(1), spread_cents: F.int(2, 40), size_contracts: F.int(1, 10000), levels: F.int(1, 5) }, setting('publish_liquidity')); pl.enabled = !!pl.enabled; }
      catch (e) { if (e instanceof FieldError) for (const [k, v] of Object.entries(e.fields)) errs[`publish_liquidity.${k}`] = v; else throw e; }
    }
    if (b.taker_fee_coefficient !== undefined) { const n = Number(b.taker_fee_coefficient); if (b.taker_fee_coefficient === null || b.taker_fee_coefficient === '' || !Number.isFinite(n) || n < 0 || n > 0.25 || Math.abs(Math.round(n * 10000) - n * 10000) > 1e-6) errs.taker_fee_coefficient = 'must be between 0 and 0.25 with at most 4 decimal places'; else fee = n; }
    if (b.rolling_window_seconds !== undefined) { const n = Number(b.rolling_window_seconds); if (!Number.isInteger(n) || n < 5 || n > 86400) errs.rolling_window_seconds = 'must be a whole number of seconds from 5 to 86400'; else rollSec = n; }
    const sec = app?.locals?.security;
    if (sec && (b.rate_limits !== undefined || b.bot !== undefined)) { const v = sec.validate({ rate_limits: b.rate_limits, bot: b.bot }); Object.assign(errs, v.errs); secPatch = v.out; }
    if (Object.keys(errs).length) throw new FieldError(errs);
    tx(db, () => {
      if (fee !== undefined) putSetting('taker_fee', { coefficient: fee }, req.auth.user.id);
      if (rollSec !== undefined) putSetting('rolling_window', { seconds: rollSec }, req.auth.user.id);
      if (secPatch) sec.save(secPatch, req.auth.user.id, nowIso());
      if (apy !== undefined) db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(APY_META_KEY, String(apy));
      if (feats) putSetting('features', feats, req.auth.user.id);
      if (pl) putSetting('publish_liquidity', pl, req.auth.user.id);
    });
    if (fee !== undefined) setTakerFeeCoefficient(fee); // live: the next fill uses it
    if (rollSec !== undefined) app?.locals?.rolling?.setWindowSec(rollSec); // live: the next window opens on the new grid
    const after = settingsVo();
    audit(req, 'settings.update', 'settings', 'system', before, after);
    res.json({ settings: after });
  });

  // ---------------------------------------------------------------- Currency & defaults (CLONE_SPEC.md §30)
  // Display currency, locale and time zone (every money string and date in the app, server and SPA), and the defaults
  // written to NEW accounts. Saving needs settings.write, a reason and a fresh step-up (server/auth.js SENSITIVE), and
  // writes one hash-chained audit row; the change is pushed live on the public `display_currency` channel.
  const currencyVo = () => ({ display_currency: currency.config(), account_defaults: currency.accountDefaults(), descriptor: currency.descriptor(),
    options: { codes: currency.CODES, locales: currency.LOCALES, themes: currency.THEMES, channels: currency.CHANNELS, display_modes: ['payout', 'shares'] } });
  v1.get('/exchange/display_currency', (req, res) => res.json({ display_currency: currency.descriptor() }));
  v1.get(`${A}/settings/currency`, can('settings.write'), (req, res) => res.json(currencyVo()));
  v1.put(`${A}/settings/currency`, can('settings.write'), (req, res) => {
    const b = req.body || {};
    const reason = reasonOf(b);
    const errs = {};
    let cfg; let acct;
    if (b.display_currency !== undefined) {
      try {
        const d = checkBody(b.display_currency, { code: { type: 'string', enum: currency.CODES }, locale: { type: 'string', enum: currency.LOCALES }, timezone: { type: 'string', maxLen: 64 } }, { unknown: 'reject' });
        if (d.timezone !== undefined && !currency.validTz(d.timezone)) errs['display_currency.timezone'] = 'must be an IANA time zone such as Africa/Lagos';
        cfg = { ...currency.config(), ...d };
      } catch (e) { if (e.fields) for (const [k, v] of Object.entries(e.fields)) errs[`display_currency.${k}`] = v; else throw e; }
    }
    if (b.account_defaults !== undefined) {
      try {
        const a = checkBody(b.account_defaults, { theme: { type: 'string', enum: currency.THEMES }, order_review: { type: 'boolean' }, flip_sell: { type: 'boolean' }, display_mode: { type: 'string', enum: ['payout', 'shares'] }, notification_channels: { type: 'object' } }, { unknown: 'reject' });
        if (a.notification_channels !== undefined) checkBody(a.notification_channels, Object.fromEntries(currency.CHANNELS.map((c) => [c, { type: 'boolean' }])), { unknown: 'reject' });
        const curA = currency.accountDefaults();
        acct = { ...curA, ...a, notification_channels: { ...curA.notification_channels, ...(a.notification_channels || {}) } };
      } catch (e) { if (e.fields) for (const [k, v] of Object.entries(e.fields)) errs[`account_defaults.${k}`] = v; else throw e; }
    }
    if (cfg === undefined && acct === undefined) errs.body = 'nothing to change: send display_currency and/or account_defaults';
    if (Object.keys(errs).length) throw new FieldError(errs);
    const before = { display_currency: currency.config(), account_defaults: currency.accountDefaults() };
    const nextCfg = cfg ? currency.normalizeConfig(cfg) : undefined;
    const nextAcct = acct ? currency.normalizeAccount(acct) : undefined;
    tx(db, () => {
      if (nextCfg) putSetting('display_currency', nextCfg, req.auth.user.id);
      if (nextAcct) putSetting('account_defaults', nextAcct, req.auth.user.id);
      audit(req, 'settings.currency', 'settings', 'currency', before, { display_currency: nextCfg || before.display_currency, account_defaults: nextAcct || before.account_defaults }, reason);
    });
    currency.configure(nextCfg, nextAcct); // live: the next formatted string uses it
    if (nextCfg) engine.emit('display_currency', currency.descriptor()); // every open page re-renders
    res.json(currencyVo());
  });
  v1.get(`${A}/health`, can('settings.write'), (req, res) => {
    const pc = db.prepare('PRAGMA page_count').get().page_count; const ps = db.prepare('PRAGMA page_size').get().page_size;
    let file = null; let walBytes = 0;
    try { file = db.prepare('PRAGMA database_list').all().find((d) => d.name === 'main')?.file || null; if (file) walBytes = fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0; } catch { /* ignore */ }
    const hub = app?.locals?.wsHub;
    const count = (t) => (hasTable(t) ? db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c : null);
    res.json({
      ok: true, db: { bytes: pc * ps, wal_bytes: walBytes, file }, uptime_seconds: Math.round((Date.now() - startedAt) / 1000), started_at: new Date(startedAt).toISOString(),
      ws_clients: hub ? hub.clients.size : null, node: process.version, memory_mb: Math.round(process.memoryUsage().rss / 1048576), trading_active: engine.tradingActive,
      tables: { users: count('users'), markets: count('markets'), orders: count('orders'), trades: count('trades'), notifications: count('notifications'), admin_audit: count('admin_audit') },
    });
  });

  return { decorateEvent, rolesOf, asUser, requote, can, rollingWindowSec: persistedRollingWindow, audit, deskRow, executeResolve, validateResolve, hooks, setting, putSetting, getMarket };
}

module.exports = { mountAdmin, ROLE_PERMS, PERMS, parseCsv, IMPORT_COLUMNS };
