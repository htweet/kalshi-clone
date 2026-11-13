'use strict';
// Owner settings (PLAN.md ground rule 6, owner decision 2026-11-08; CLONE_SPEC.md §38.1). Every owner choice that is a
// value (an amount, a duration, a rate, a threshold) rather than a capability is a validated setting here; capabilities
// are feature flags (server/flags.js, §33). Each setting has:
//   - the recommended standard default (REGISTRY);
//   - a short CMS-managed label and explanation (server/content/switches.js, Admin › Content › Texts);
//   - validation (type, range, cross-field rules), a reason on every change, step-up where it affects money or security,
//     one hash-chained audit row (`owner_settings.update`), and it takes effect live: modules read get() on every use, a
//     change nudges open pages through the public `feature_flags` channel (public settings ride in the flag bundle).
// Storage: admin_settings rows `owner:<key>` (value JSON). A missing row means the default.
const { ApiError, E } = require('./util');
const { s: SW } = require('./content/switches');

// [key, group, type, default, opts]  type: int | bool. opts: min, max, unit, stepUp (money / security / personal data),
// pub (sent to every client in the flag bundle), cap() (an environment upper bound), where (the admin page it serves).
const REGISTRY = [
  ['waitlists.confirm_link_hours', 'waitlists', 'int', 48, { min: 1, max: 336, unit: 'hours', where: '/admin/waitlists' }],
  ['waitlists.unconfirmed_delete_days', 'waitlists', 'int', 7, { min: 1, max: 90, unit: 'days', where: '/admin/waitlists' }],
  ['waitlists.newsletter_per_minute', 'waitlists', 'int', 120, { min: 1, max: 10000, unit: 'per_minute', where: '/admin/waitlists', cap: () => { const n = Number(process.env.NEWSLETTER_PER_MINUTE); return Number.isInteger(n) && n > 0 ? n : null; } }],
  ['waitlists.export_includes_email', 'waitlists', 'bool', true, { stepUp: true, where: '/admin/waitlists' }],
  ['elections.pending_expiry_hours', 'elections', 'int', 24, { min: 1, max: 168, unit: 'hours', where: '/admin/elections' }],
  ['elections.projected_pct', 'elections', 'int', 90, { min: 51, max: 99, unit: 'percent', where: '/admin/elections' }],
  ['elections.rating_safe_pct', 'elections', 'int', 90, { min: 52, max: 99, unit: 'percent', where: '/admin/elections' }],
  ['elections.rating_likely_pct', 'elections', 'int', 75, { min: 51, max: 98, unit: 'percent', where: '/admin/elections' }],
  ['elections.rating_lean_pct', 'elections', 'int', 60, { min: 51, max: 97, unit: 'percent', where: '/admin/elections' }],
  ['referrals.review_ip_signups_per_day', 'growth', 'int', 5, { min: 2, max: 1000, unit: 'count', stepUp: true, where: '/admin/growth' }],
  ['share.clicks_per_ip_per_minute', 'growth', 'int', 60, { min: 1, max: 10000, unit: 'per_minute', where: '/admin/growth' }],
  ['i18n.min_coverage_pct', 'reach', 'int', 95, { min: 1, max: 100, unit: 'percent', where: '/admin/cms/languages' }],
  ['ssr.cache_seconds', 'reach', 'int', 60, { min: 0, max: 3600, unit: 'seconds', where: '/admin/owner_settings' }],
  ['data_saver.default_on', 'reach', 'bool', false, { pub: true, where: '/admin/owner_settings' }],
  ['sms.per_user_per_day', 'reach', 'int', 10, { min: 1, max: 100, unit: 'count', stepUp: true, where: '/admin/owner_settings' }],
  // Database growth fix (CLONE_SPEC.md §39.17): the built-in liquidity accounts' write rate (server/sim-activity.js).
  ['simulation.activity', 'simulation', 'enum', 'low', { values: ['off', 'low', 'normal'], where: '/admin/owner_settings' }],
  // Phase 9A (CLONE_SPEC.md §39.7): backups, observability, alert thresholds, admin access. Backup settings touch personal
  // data (what is kept, for how long) and the allowlist touches security: both need a step-up.
  ['backups.interval_minutes', 'backups', 'int', 15, { min: 5, max: 1440, unit: 'minutes', stepUp: true, where: '/admin/system' }],
  ['backups.nightly_hour_wat', 'backups', 'int', 2, { min: 0, max: 23, unit: 'hour', stepUp: true, where: '/admin/system' }],
  ['backups.wal_ship_seconds', 'backups', 'int', 10, { min: 1, max: 300, unit: 'seconds', stepUp: true, where: '/admin/system' }],
  ['backups.keep_interval_hours', 'backups', 'int', 48, { min: 1, max: 720, unit: 'hours', stepUp: true, where: '/admin/system' }],
  ['backups.keep_interval_count', 'backups', 'int', 8, { min: 1, max: 1000, unit: 'count', stepUp: true, where: '/admin/system' }], // CLONE_SPEC.md §39.17
  ['backups.retention_daily', 'backups', 'int', 7, { min: 1, max: 90, unit: 'count', stepUp: true, where: '/admin/system' }],
  ['backups.retention_weekly', 'backups', 'int', 4, { min: 0, max: 52, unit: 'count', stepUp: true, where: '/admin/system' }],
  ['backups.retention_monthly', 'backups', 'int', 12, { min: 0, max: 120, unit: 'count', stepUp: true, where: '/admin/system' }],
  ['backups.max_age_minutes', 'backups', 'int', 60, { min: 5, max: 1440, unit: 'minutes', where: '/admin/system' }],
  ['backups.drill_max_age_days', 'backups', 'int', 30, { min: 1, max: 365, unit: 'days', where: '/admin/system' }],
  ['backups.drill_every_days', 'backups', 'int', 7, { min: 0, max: 90, unit: 'days', where: '/admin/system' }],
  // Commit durability (performance pass 2026-11-13, CLONE_SPEC.md §39.18): off = SQLite synchronous NORMAL (an app crash
  // loses nothing, the database cannot corrupt; a power cut can lose the newest commits), on = FULL (every commit waits for
  // the disk). Launch readiness requires it on before real money.
  ['db.max_durability', 'backups', 'bool', false, { stepUp: true, where: '/admin/system' }],
  ['logs.level', 'observability', 'enum', 'info', { values: ['debug', 'info', 'warn', 'error'], where: '/admin/system' }],
  ['logs.retention_days', 'observability', 'int', 90, { min: 7, max: 730, unit: 'days', stepUp: true, where: '/admin/system' }],
  // Data retention by class (Phase 9A not-built item, 2026-11-13; CLONE_SPEC.md §39.19). Days a record is kept; 0 keeps it
  // forever. Personal data: step-up. Closed accounts' identity data has its own schedule (Admin › Identity, KYC days).
  ['retention.notifications_days', 'retention', 'int', 365, { min: 0, max: 3650, unit: 'days', stepUp: true, where: '/admin/system' }],
  ['retention.device_days', 'retention', 'int', 180, { min: 0, max: 730, unit: 'days', stepUp: true, where: '/admin/system' }],
  ['retention.share_clicks_days', 'retention', 'int', 90, { min: 0, max: 730, unit: 'days', stepUp: true, where: '/admin/system' }],
  ['retention.email_copies_days', 'retention', 'int', 30, { min: 0, max: 365, unit: 'days', stepUp: true, where: '/admin/system' }],
  ['retention.chat_days', 'retention', 'int', 0, { min: 0, max: 3650, unit: 'days', stepUp: true, where: '/admin/system' }],
  ['traces.sample_pct', 'observability', 'int', 10, { min: 1, max: 100, unit: 'percent', where: '/admin/system' }],
  ['anchors.interval_minutes', 'observability', 'int', 60, { min: 5, max: 1440, unit: 'minutes', where: '/admin/system' }],
  ['alerts.error_rate_pct', 'alerts', 'int', 5, { min: 1, max: 100, unit: 'percent', where: '/admin/system' }],
  ['alerts.order_p99_ms', 'alerts', 'int', 100, { min: 5, max: 10000, unit: 'ms', where: '/admin/system' }],
  ['alerts.job_stall_minutes', 'alerts', 'int', 10, { min: 1, max: 1440, unit: 'minutes', where: '/admin/system' }],
  ['alerts.disk_free_pct', 'alerts', 'int', 15, { min: 1, max: 90, unit: 'percent', where: '/admin/system' }],
  ['alerts.cert_expiry_days', 'alerts', 'int', 14, { min: 1, max: 90, unit: 'days', where: '/admin/system' }],
  ['alerts.repeat_minutes', 'alerts', 'int', 60, { min: 5, max: 1440, unit: 'minutes', where: '/admin/system' }],
  ['ops.readyz_disk_free_mb', 'alerts', 'int', 500, { min: 50, max: 100000, unit: 'mb', where: '/admin/system' }],
  ['ops.maintenance_retry_after_sec', 'operations', 'int', 300, { min: 10, max: 86400, unit: 'seconds', where: '/admin/system' }],
  ['admin.ip_allowlist', 'operations', 'cidrs', '', { stepUp: true, where: '/admin/system' }],
  ['keys.max_age_days', 'operations', 'int', 365, { min: 30, max: 1825, unit: 'days', stepUp: true, where: '/admin/system' }],
];
// Comma-separated IP addresses / CIDR ranges ("" = no restriction), normalised; null when any entry is invalid.
const net = require('node:net');
function normCidrs(raw) {
  if (typeof raw !== 'string' || raw.length > 2000) return null;
  const parts = raw.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  if (parts.length > 50) return null;
  for (const p of parts) {
    const [ip, bits] = p.split('/');
    const fam = net.isIP(ip);
    if (!fam) return null;
    if (bits !== undefined && !(/^\d{1,3}$/.test(bits) && Number(bits) <= (fam === 4 ? 32 : 128))) return null;
  }
  return parts.join(', ');
}
// Whether `ip` is in the list (empty list = everyone). IPv4-mapped IPv6 addresses are compared as IPv4.
function ipAllowed(list, ip) {
  const parts = String(list || '').split(/[\s,]+/).filter(Boolean);
  if (!parts.length) return true;
  const addr = String(ip || '').replace(/^::ffff:/, '');
  const fam = net.isIP(addr);
  if (!fam) return false;
  const bl = new net.BlockList();
  for (const p of parts) { const [a, b] = p.split('/'); const f = net.isIP(a) === 6 ? 'ipv6' : 'ipv4'; if (b === undefined) bl.addAddress(a, f); else bl.addSubnet(a, Number(b), f); }
  return bl.check(addr, fam === 6 ? 'ipv6' : 'ipv4');
}
const DEFS = new Map(REGISTRY.map(([key, group, type, def, o = {}]) => [key, { key, group, type, default: def, ...o }]));
const GROUPS = [...new Set(REGISTRY.map((r) => r[1]))];
const SKEY = (k) => `owner:${k}`;

function createOwnerSettings({ db, engine, overrides = {} }) {
  const cache = new Map();
  const read = (key) => {
    if (cache.has(key)) return cache.get(key);
    const r = db.prepare('SELECT value FROM admin_settings WHERE key=?').get(SKEY(key));
    let v = DEFS.get(key).default;
    if (r) { try { v = JSON.parse(r.value); } catch { /* keep the default */ } }
    cache.set(key, v);
    return v;
  };
  // The effective value: a start option override (tests), else the stored value, else the default; capped by the env.
  function get(key) {
    const d = DEFS.get(key);
    if (!d) throw new Error(`unknown owner setting ${key}`);
    let v = Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : read(key);
    const cap = d.cap ? d.cap() : null;
    if (cap != null && typeof v === 'number' && v > cap) v = cap;
    return v;
  }
  const isDefault = (key) => !db.prepare('SELECT 1 FROM admin_settings WHERE key=?').get(SKEY(key));
  function validate(key, raw, current = {}) {
    const d = DEFS.get(key);
    if (!d) throw new ApiError(404, 'not_found', SW('error.unknown_setting'));
    let v;
    if (d.type === 'bool') {
      if (typeof raw !== 'boolean') throw fieldErr({ value: 'must be true or false' });
      v = raw;
    } else if (d.type === 'enum') {
      if (!d.values.includes(raw)) throw fieldErr({ value: `must be one of ${d.values.join(', ')}` });
      v = raw;
    } else if (d.type === 'cidrs') {
      v = normCidrs(raw);
      if (v == null) throw fieldErr({ value: 'must be IP addresses or CIDR ranges separated by commas (empty = everyone)' });
    } else {
      const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
      if (!Number.isInteger(n) || n < d.min || n > d.max) throw fieldErr({ value: `must be a whole number from ${d.min} to ${d.max}` });
      const cap = d.cap ? d.cap() : null;
      if (cap != null && n > cap) throw fieldErr({ value: SW('error.env_cap', { cap }) });
      v = n;
    }
    // Cross-field rule: the rating bands stay ordered (Safe > Likely > Lean > 50).
    if (key.startsWith('elections.rating_')) {
      const b = { safe: current['elections.rating_safe_pct'], likely: current['elections.rating_likely_pct'], lean: current['elections.rating_lean_pct'] };
      b[key.replace('elections.rating_', '').replace('_pct', '')] = v;
      if (!(b.safe > b.likely && b.likely > b.lean && b.lean > 50)) throw fieldErr({ value: SW('error.bands_order') });
    }
    return v;
  }
  function fieldErr(errs) {
    const e = new ApiError(400, 'validation_failed', 'validation failed', Object.entries(errs).map(([k, m]) => `${k}: ${m}`).join('; '));
    e.toJSON = () => ({ error: { code: e.code, message: e.message, details: e.details, fields: errs } });
    return e;
  }
  const listeners = [];
  function set(key, value, actorId) {
    db.prepare('INSERT INTO admin_settings(key,value,updated_at,updated_by) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by')
      .run(SKEY(key), JSON.stringify(value), new Date().toISOString(), actorId || null);
    cache.delete(key);
    for (const fn of listeners) { try { fn(key, value); } catch (e) { console.error('owner setting listener', e); } }
  }
  const all = () => Object.fromEntries([...DEFS.keys()].map((k) => [k, get(k)]));
  const publicValues = () => Object.fromEntries([...DEFS.values()].filter((d) => d.pub).map((d) => [d.key, get(d.key)]));
  void engine;
  return { REGISTRY, DEFS, GROUPS, get, set, all, validate, isDefault, publicValues, listeners, overrides, requestChecks: {} };
}

// Admin routes (settings.write): list with explanations, change with a reason (+ step-up where marked), history.
function mountOwnerSettings({ v1, db, os, admin, auth, flags }) {
  const can = admin.can;
  const label = (k) => SW(`setting.${k}.label`);
  const help = (k) => SW(`setting.${k}.help`);
  const valueText = (d, v) => (d.type === 'bool' ? SW(v ? 'value.on' : 'value.off') : d.type === 'cidrs' && !v ? SW('value.everyone') : String(v));
  const vo = (d) => {
    const v = os.get(d.key);
    const cap = d.cap ? d.cap() : null;
    return { key: d.key, group: d.group, group_label: SW(`group.${d.group}`), type: d.type, value: v, default: d.default, is_default: os.isDefault(d.key) && !Object.prototype.hasOwnProperty.call(os.overrides, d.key),
      min: d.min ?? null, max: cap != null && d.max != null ? Math.min(d.max, cap) : d.max ?? null, unit: d.unit || null, env_cap: cap, step_up: !!d.stepUp, where: d.where || null, values: d.values || null,
      label: label(d.key), help: help(d.key), recommended: SW('recommended', { value: valueText(d, d.default) }), override: Object.prototype.hasOwnProperty.call(os.overrides, d.key) };
  };
  const history = (key) => db.prepare("SELECT ts, actor_email, before_json, after_json, reason FROM admin_audit WHERE action='owner_settings.update' AND target_id=? ORDER BY ts DESC LIMIT 50").all(key)
    .map((h) => ({ time: new Date(h.ts).toISOString(), actor_email: h.actor_email, before: JSON.parse(h.before_json || 'null'), after: JSON.parse(h.after_json || 'null'), reason: h.reason }));
  // Every feature flag with its explanation and recommended default (the switch catalogue of ground rule 6).
  const switches = () => [...flags.FLAGS.values()].map((f) => ({ key: f.key, group: f.group, default: f.default, recommended: SW('recommended', { value: SW(f.default ? 'value.on' : 'value.off') }), help: SW(`flag.${f.key}`), effective: flags.globalState(f.key).on }));
  v1.get('/admin/owner_settings', can('settings.write'), (req, res) => res.json({ settings: [...os.DEFS.values()].map(vo), groups: os.GROUPS.map((g) => ({ key: g, label: SW(`group.${g}`) })), switches: switches() }));
  v1.get('/admin/owner_settings/:key', can('settings.write'), (req, res) => {
    const d = os.DEFS.get(String(req.params.key));
    if (!d) throw E.notFound();
    res.json({ setting: vo(d), history: history(d.key) });
  });
  v1.put('/admin/owner_settings/:key', can('settings.write'), (req, res) => {
    const key = String(req.params.key);
    const d = os.DEFS.get(key);
    if (!d) throw E.notFound();
    const b = req.body || {};
    const unknown = Object.keys(b).filter((k) => !['value', 'reason'].includes(k));
    if (unknown.length) throw new ApiError(400, 'validation_failed', 'validation failed', `${unknown[0]}: is not a setting field`);
    const reason = String(b.reason || '').trim();
    if (reason.length < 3 || reason.length > 500) {
      const e = new ApiError(400, 'validation_failed', 'validation failed', 'reason: a reason of 3-500 characters is required');
      e.toJSON = () => ({ error: { code: e.code, message: e.message, details: e.details, fields: { reason: 'a reason of 3-500 characters is required' } } });
      throw e;
    }
    const value = os.validate(key, b.value, os.all());
    if (os.requestChecks[key]) os.requestChecks[key](value, req); // e.g. the admin allowlist must keep the caller in (§39.6)
    if (d.stepUp) auth.assertFresh(req, 'owner_setting_change'); // money / security / personal data (CLONE_SPEC.md §22.6)
    const before = os.get(key);
    os.set(key, value, req.auth.user.id);
    admin.audit(req, 'owner_settings.update', 'owner_setting', key, { value: before }, { value }, reason);
    flags.changed([`owner:${key}`]); // live: open pages refetch the bundle (public settings ride in it)
    res.json({ setting: vo(d), history: history(key) });
  });
  flags.bundleExtras.push(() => ({ owner_settings: os.publicValues() }));
}

module.exports = { createOwnerSettings, mountOwnerSettings, REGISTRY, DEFS, normCidrs, ipAllowed };
