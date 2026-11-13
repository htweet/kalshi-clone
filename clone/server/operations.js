'use strict';
// Operations (PLAN Phase 9A P9.2-P9.8, CLONE_SPEC.md §39): the operating switches and their enforcement, Admin › System
// (backups, restore drills, keys, audit anchors, migrations, alerts and their contacts, readiness), Admin › Launch
// readiness (automatic checks, owner-ticked items, the waitlist target) and the gate it puts on the play → real-money
// production switch, /.well-known/security.txt, the move of media and identity documents into object storage, and the
// log retention job.
//
// Switches (feature flags whose "on" means the mode is in force, server/flags.js):
//   ops.maintenance   writes on /v1 and the Trade API answer 503 `maintenance` with Retry-After (the flag's end time, else
//                     `ops.maintenance_retry_after_sec`); sign-in, sign-out and step-up keep working; staff keep full access;
//                     the site shows the CMS maintenance message. Start / end are the flag's schedule.
//   ops.trading_halt  no order placement, amend, RFQ accept / confirm or Perps order on any path (the engine refuses too,
//                     so FIX, the Trade API and internal liquidity jobs stop); cancels and decreases work. A banner and the
//                     status page say so. Resuming is a two-person request (ops_approvals).
//   ops.read_only     every write is refused with 503 `read_only` except signing in / out, step-up and the switch itself.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ApiError, E, newId } = require('./util');
const { s: OS } = require('./content/ops');
const { s: SW } = require('./content/switches');
const configGuard = require('./config-guard');
const migrations = require('./migrations');
const { verifyDatabase } = require('./verify');
const opsWorker = require('./ops-worker'); // heavy checks off the request thread (performance fix 2026-11-09)
const { restore } = require('./backups');
const { ipAllowed } = require('./owner-settings');
const auditChain = require('./audit-chain');

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
// Paths (relative to /v1) that keep working in every mode: signing in / out, step-up, CSRF and client-token bootstrap.
const ALWAYS = [/^\/(log_in|log_in_mfa|log_out|step_up|session|auth\/csrf|client_token|bot\/challenge|csp-report)$/, /^\/passkeys\/(authentication|step_up)/];
// Order entry (the halt): placement, amend, RFQ execution, Perps orders and amends, combo slips that place orders.
const TRADING = [/^\/users\/[^/]+\/orders$/, /^\/users\/[^/]+\/orders\/[^/]+\/amend$/, /^\/perps\/orders$/, /^\/perps\/orders\/[^/]+\/amend$/, /^\/perps\/positions\/[^/]+\/close$/,
  /^\/communications\/(rfqs\/[^/]+\/)?quotes\/[^/]+\/(accept|confirm)$/];
const OWNER_ITEMS = ['pen_test', 'terms_privacy', 'ndpa', 'support', 'incident_contacts'];
const EVIDENCE = ['dependency_scan', 'image_scan', 'load_test'];
const EVIDENCE_MAX_AGE_MS = 30 * 86400000;
// Load-test targets (PLAN P9.5): orders/s sustained, order p99, WebSocket fan-out p99, public page p95.
const LOAD_TARGETS = { orders_per_sec: 200, order_p99_ms: 50, ws_fanout_p99_ms: 250, page_p95_ms: 300 };

function mountOperations(ctx) {
  const { v1, app, db, engine, auth, admin, flags, ownerSettings: OSET, security, keyDir, dbFile, mediaStorage, backups, backupStorage, obs, logger, anchors, alerts, keyring, options = {} } = ctx;
  const can = admin.can;
  const S = (k) => OSET.get(k);
  const now = () => Date.now();
  const on = (k) => flags.globalState(k).on;
  const isStaff = (req) => !!(req.auth && admin.rolesOf(req.auth.user).length);
  const reasonOf = (b) => { const r = String((b && b.reason) || '').trim(); if (r.length < 3 || r.length > 500) { const e = new ApiError(400, 'validation_failed', 'validation failed', 'reason: a reason of 3-500 characters is required'); e.toJSON = () => ({ error: { code: e.code, message: e.message, details: e.details, fields: { reason: 'a reason of 3-500 characters is required' } } }); throw e; } return r; };
  const sysAudit = ({ action, target_id, after, reason, actor = null }) => auditChain.append(db, { actor_id: actor?.id || null, actor_email: actor?.email || null, action, target_type: 'operations', target_id: String(target_id || ''), after, reason: reason || '' });

  // ---------------------------------------------------------------- switch enforcement
  const retryAfter = (key) => { const f = flags.state.get(key); const end = f && f.ends_at && f.ends_at > now() ? Math.ceil((f.ends_at - now()) / 1000) : null; return String(end || S('ops.maintenance_retry_after_sec')); };
  function modeError(code, key, details) {
    const e = new ApiError(code === 'trading_halted' ? 409 : 503, code, OS(`error.${code}`), details);
    e.retryAfter = code === 'trading_halted' ? null : retryAfter(key);
    return e;
  }
  // flags.gates entry: (req) → ApiError | null. Runs for /v1 and for the Trade API's internal dispatch (same chain).
  function switchGate(req) {
    const p = req.path;
    const write = !SAFE.has(req.method);
    if (ALWAYS.some((re) => re.test(p))) return null;
    if (on('ops.read_only') && write && !(isStaff(req) && /^\/admin\/(flags\/ops\.read_only(\/kill)?|ops\/approvals\/[^/]+\/(approve|reject))$/.test(p))) return modeError('read_only', 'ops.read_only');
    if (on('ops.maintenance') && write && !isStaff(req)) return modeError('maintenance', 'ops.maintenance', OS('error.maintenance_details'));
    if (on('ops.trading_halt') && req.method === 'POST' && TRADING.some((re) => re.test(p))) return modeError('trading_halted', 'ops.trading_halt');
    return null;
  }
  flags.gates.push(switchGate);
  // Retry-After rides on the error envelope (server/app.js error handler copies e.retryAfter).
  // The engine refuses orders while halted, whatever path they come from (FIX, internal jobs, the Trade API).
  {
    let base = engine.tradingActive;
    Object.defineProperty(engine, 'tradingActive', { configurable: true, enumerable: true, get: () => base && !on('ops.trading_halt'), set: (v) => { base = !!v; } });
    engine.tradingBase = () => base;
  }
  // Two-person resume: a change that would end the halt becomes a pending request (202) for another admin.
  flags.changeGuards.push((key, before, after, req, reason) => {
    if (key !== 'ops.trading_halt') return null;
    const wasOn = !!before.enabled && !before.kill;
    const willOn = !!after.enabled && !after.kill;
    if (!wasOn || willOn) return null;
    const pending = db.prepare("SELECT * FROM ops_approvals WHERE kind='trading_resume' AND status='pending'").get();
    if (pending) return { status: 'pending_approval', approval: approvalVo(pending), message: OS('error.two_person') };
    const id = newId('opa_');
    db.prepare("INSERT INTO ops_approvals(id,kind,status,reason,requested_by,requested_ts) VALUES(?,'trading_resume','pending',?,?,?)").run(id, reason, req.auth.user.id, now());
    const a = db.prepare('SELECT * FROM ops_approvals WHERE id=?').get(id);
    admin.audit(req, 'ops.trading_resume.requested', 'feature_flag', 'ops.trading_halt', null, approvalVo(a), reason);
    return { status: 'pending_approval', approval: approvalVo(a), message: OS('error.two_person') };
  });
  const emailOf = (id) => (id ? db.prepare('SELECT email FROM users WHERE id=?').get(id)?.email || id : null);
  const approvalVo = (a) => ({ id: a.id, kind: a.kind, status: a.status, reason: a.reason, requested_by: emailOf(a.requested_by), requested_time: new Date(a.requested_ts).toISOString(),
    decided_by: emailOf(a.decided_by), decided_time: a.decided_ts ? new Date(a.decided_ts).toISOString() : null, decision_note: a.decision_note || null });
  v1.get('/admin/ops/approvals', can('settings.write'), (req, res) => res.json({ approvals: db.prepare('SELECT * FROM ops_approvals ORDER BY requested_ts DESC LIMIT 50').all().map(approvalVo) }));
  const pendingOps = (id) => { const a = db.prepare('SELECT * FROM ops_approvals WHERE id=?').get(String(id)); if (!a) throw E.notFound(); if (a.status !== 'pending') throw E.conflict('approval_closed', `this request is ${a.status}`); return a; };
  v1.post('/admin/ops/approvals/:id/approve', can('settings.write'), (req, res) => {
    const a = pendingOps(req.params.id);
    if (a.requested_by === req.auth.user.id) throw E.conflict('same_admin', OS('error.same_admin'), 'the two-person rule needs a second admin');
    auth.assertFresh(req, 'feature_flag_change');
    const r = flags.save('ops.trading_halt', { enabled: false, kill: false }, { action: 'update', reason: `${a.reason} (approved)`, actor: req.auth.user });
    db.prepare("UPDATE ops_approvals SET status='approved', decided_by=?, decided_ts=? WHERE id=?").run(req.auth.user.id, now(), a.id);
    admin.audit(req, 'ops.trading_resume', 'feature_flag', 'ops.trading_halt', r.before, r.after, a.reason);
    res.json({ approval: approvalVo(db.prepare('SELECT * FROM ops_approvals WHERE id=?').get(a.id)) });
  });
  v1.post('/admin/ops/approvals/:id/reject', can('settings.write'), (req, res) => {
    const a = pendingOps(req.params.id);
    const note = String((req.body || {}).note || '').trim();
    if (note.length < 3 || note.length > 500) throw new ApiError(400, 'validation_failed', 'validation failed', 'note: give a reason of 3-500 characters');
    db.prepare("UPDATE ops_approvals SET status='rejected', decided_by=?, decided_ts=?, decision_note=? WHERE id=?").run(req.auth.user.id, now(), note, a.id);
    admin.audit(req, 'ops.trading_resume.rejected', 'feature_flag', 'ops.trading_halt', approvalVo(a), null, note);
    res.json({ approval: approvalVo(db.prepare('SELECT * FROM ops_approvals WHERE id=?').get(a.id)) });
  });
  // The client sees the switches in its flag bundle (booleans) and, for the banner, when maintenance ends.
  flags.bundleExtras.push(() => {
    const f = flags.state.get('ops.maintenance');
    return { operations: { maintenance_ends_time: on('ops.maintenance') && f.ends_at ? new Date(f.ends_at).toISOString() : null, admin_origin: security.adminOrigin || null } };
  });
  // Status page notices (server/dev-portal.js).
  app.locals.opsStatus = () => ({ maintenance: on('ops.maintenance'), trading_halted: on('ops.trading_halt'), read_only: on('ops.read_only') });

  // ---------------------------------------------------------------- admin origin: IP allowlist
  app.locals.adminIpAllowed = (req) => ipAllowed(S('admin.ip_allowlist'), security.clientIp(req));
  OSET.requestChecks['admin.ip_allowlist'] = (value, req) => {
    const ip = security.clientIp(req);
    if (value && !ipAllowed(value, ip)) {
      const e = new ApiError(400, 'validation_failed', 'validation failed', `value: ${OS('error.lockout', { ip })}`);
      e.toJSON = () => ({ error: { code: e.code, message: e.message, details: e.details, fields: { value: OS('error.lockout', { ip }) } } });
      throw e;
    }
  };

  // ---------------------------------------------------------------- /.well-known/security.txt (RFC 9116)
  app.get('/.well-known/security.txt', (req, res) => {
    const origin = (security.publicOrigin || security.selfOrigin(req) || '').replace(/\/$/, '');
    const contact = process.env.SECURITY_CONTACT || `mailto:security@${(() => { try { return new URL(origin).hostname; } catch { return 'example.invalid'; } })()}`;
    const expires = new Date(now() + 180 * 86400000); expires.setUTCHours(0, 0, 0, 0);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.type('text/plain').send([`Contact: ${contact}`, `Expires: ${expires.toISOString()}`, `Policy: ${origin}/trust/vulnerability-disclosure`, `Canonical: ${origin}/.well-known/security.txt`, 'Preferred-Languages: en', ''].join('\n'));
  });

  // ---------------------------------------------------------------- restore drills
  let drillRunning = null;
  function restoreDrill({ trigger = 'manual', actor = null } = {}) {
    if (drillRunning) return drillRunning;
    if (!backupStorage) return Promise.reject(new ApiError(409, 'backups_unavailable', 'backups are not configured (in-memory database)'));
    const id = newId('drill_');
    db.prepare("INSERT INTO ops_restore_drills(id,started_ts,status,trigger,actor_id) VALUES(?,?,'running',?,?)").run(id, now(), trigger, actor?.id || null);
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-drill-')), 'restored.db');
    drillRunning = (async () => {
      try {
        await backups.flush();
        let r; let v;
        // Restoring and verifying a whole database is heavy: it runs in the operations worker (server/ops-worker.js)
        // whenever the backup store can be rebuilt there, so requests keep flowing during a drill.
        const storageConfig = backupStorage.config ? backupStorage.config() : null;
        if (storageConfig && options.drillInWorker !== false) {
          const k = backups.keys;
          const anchorRows = db.prepare('SELECT * FROM ops_anchors ORDER BY seq DESC LIMIT 500').all();
          const res = await opsWorker.run('drill', { storageConfig, outFile: out, keyDir, anchors: anchorRows,
            backupKeys: { activeHex: k.active.toString('hex'), activeId: k.activeId, all: [...k.all].map(([kid, buf]) => [kid, buf.toString('hex')]) } });
          r = res.restore; v = res.verify;
        } else {
          r = await restore({ storage: backupStorage, outFile: out, keyDir, force: true, keys: backups.keys });
          const d = new DatabaseSync(out);
          try {
            const head = (() => { try { return d.prepare('SELECT MAX(chain_seq) s FROM admin_audit').get().s || 0; } catch { return 0; } })();
            const anchor = db.prepare('SELECT * FROM ops_anchors WHERE chain_seq<=? ORDER BY seq DESC LIMIT 1').get(head) || null;
            v = verifyDatabase(d, { keyDir, anchor });
            v.checks.schema = { ok: (() => { try { return migrations.version(d) === migrations.LATEST; } catch { return false; } })(), version: (() => { try { return migrations.version(d); } catch { return null; } })() };
            v.ok = Object.values(v.checks).every((c) => c.ok);
          } finally { d.close(); }
        }
        const backupRow = db.prepare('SELECT id FROM ops_backups WHERE object_key=?').get(r.snapshot.key);
        db.prepare('UPDATE ops_restore_drills SET finished_ts=?, status=?, backup_id=?, target_ts=?, segments=?, checks_json=? WHERE id=?')
          .run(now(), v.ok ? 'ok' : 'failed', backupRow?.id || r.snapshot.id || null, r.reached_ts, r.segments, JSON.stringify(v.checks), id);
        sysAudit({ action: 'ops.restore_drill', target_id: id, after: { ok: v.ok, snapshot: r.snapshot.key, segments: r.segments }, reason: trigger, actor });
        obs.job('restore_drill', v.ok);
        return drillVo(db.prepare('SELECT * FROM ops_restore_drills WHERE id=?').get(id));
      } catch (e) {
        db.prepare("UPDATE ops_restore_drills SET finished_ts=?, status='failed', error=? WHERE id=?").run(now(), String(e.message).slice(0, 500), id);
        obs.job('restore_drill', false, e.message);
        throw e;
      } finally {
        drillRunning = null;
        for (const f of [out, `${out}-wal`, `${out}-shm`]) { try { fs.unlinkSync(f); } catch { /* gone */ } }
        try { fs.rmdirSync(path.dirname(out)); } catch { /* not empty */ }
      }
    })();
    return drillRunning;
  }
  const drillVo = (d) => (d ? { id: d.id, status: d.status, trigger: d.trigger, started_time: new Date(d.started_ts).toISOString(), finished_time: d.finished_ts ? new Date(d.finished_ts).toISOString() : null,
    age_sec: d.finished_ts ? Math.round((now() - d.finished_ts) / 1000) : null, segments: d.segments, checks: JSON.parse(d.checks_json || 'null'), error: d.error || null } : null);
  const lastDrill = () => db.prepare("SELECT * FROM ops_restore_drills WHERE status='ok' ORDER BY finished_ts DESC LIMIT 1").get();

  // ---------------------------------------------------------------- live verifiers (cached; Admin › System, alerts)
  let verifierCache = null;
  async function verifiers({ fresh = false } = {}) {
    if (!fresh && verifierCache && now() - verifierCache.ts < 10 * 60000) return verifierCache;
    // The ledger audit and the audit chain read the whole database: on a file database they run in the operations worker
    // on a read-only connection (a consistent snapshot), so they never hold up requests.
    const fileDb = dbFile && dbFile !== ':memory:';
    let checks;
    try { checks = fileDb && options.verifyInWorker !== false ? await opsWorker.run('verifyLive', { dbFile: path.resolve(dbFile), keyDir }) : opsWorker.liveChecks(db); } catch (e) { checks = opsWorker.liveChecks(db); void e; }
    try { const a = await anchors.check(); checks.anchor = { ok: a.ok || a.detail === 'no anchor yet', detail: a.detail, anchor: a.anchor }; } catch (e) { checks.anchor = { ok: false, error: e.message }; }
    verifierCache = { ts: now(), ok: Object.values(checks).every((c) => c.ok), checks, failing: Object.entries(checks).filter(([, c]) => !c.ok).map(([k]) => k) };
    return verifierCache;
  }

  // ---------------------------------------------------------------- Launch readiness
  const evidence = (kind) => db.prepare('SELECT * FROM ops_evidence WHERE kind=?').get(kind);
  const sawHttps = { ts: 0 };
  app.use((req, res, next) => { if (security.isHttps && security.isHttps(req)) sawHttps.ts = now(); next(); });
  const gateEnforced = () => options.launchGate ?? (process.env.NODE_ENV === 'production' || process.env.LAUNCH_GATE === '1');
  async function readiness() {
    const t = now();
    const c = [];
    const add = (key, ok, detail) => c.push({ key, label: OS(`check.${key}`), help: OS(`check.${key}.help`), ok: !!ok, detail: detail || null });
    const guard = configGuard.checks({ dataDir: keyDir, env: { ...process.env, ...(options.configEnv || {}) } });
    const bad = guard.filter((x) => !x.ok);
    add('config_guard', !bad.length, bad.length ? bad.map((x) => x.setting).join(', ') : null);
    const pub = configGuard.httpsOrigin(security.publicOrigin || process.env.PUBLIC_ORIGIN || '');
    add('tls_hsts', !!pub && security.hsts && t - sawHttps.ts < 24 * 3600000, !pub ? 'PUBLIC_ORIGIN is not https' : !security.hsts ? 'HSTS is not sent (set TRUST_PROXY to the proxy ranges)' : t - sawHttps.ts >= 24 * 3600000 ? 'no request over HTTPS through the trusted proxy in the last 24 h' : null);
    const adm = configGuard.httpsOrigin(security.adminOrigin || '');
    add('admin_origin', !!adm && adm !== pub, adm ? null : 'ADMIN_ORIGIN is not set to an https origin');
    const b = backups.status();
    add('backups_fresh', on('ops.backups') && b.last_backup && b.last_backup.age_sec <= S('backups.max_age_minutes') * 60 && (!backups.shipping || (b.last_wal_segment ? b.last_wal_segment.age_sec <= 3600 : true)),
      !on('ops.backups') ? 'the backup schedule is off' : !b.last_backup ? 'no backup yet' : `newest backup ${Math.round(b.last_backup.age_sec / 60)} min old`);
    add('backups_offsite', !!backupStorage && (backupStorage.kind === 's3' || (backupStorage.describe().dir && !configGuardInside(backupStorage.describe().dir, keyDir))), backupStorage ? JSON.stringify(backupStorage.describe()) : 'not configured');
    add('db_durability', S('db.max_durability') === true, S('db.max_durability') ? null : 'Admin › Owner settings › Maximum durability is off');
    const d = lastDrill();
    add('restore_drill', d && t - d.finished_ts <= S('backups.drill_max_age_days') * 86400000, d ? `last drill ${Math.floor((t - d.finished_ts) / 86400000)} day(s) ago` : 'no successful drill yet');
    const confirmed = alerts.contacts().filter((x) => x.confirmed).length;
    add('alerts_contact', on('ops.alerts') && confirmed > 0, on('ops.alerts') ? `${confirmed} confirmed contact(s)` : 'alert delivery is off');
    const ks = keyring.status();
    const act = ks.keys.find((k) => k.kid === ks.active);
    add('key_ages', act && act.age_days <= S('keys.max_age_days') && ks.pending === 0, act ? `active ${ks.active}, ${act.age_days} day(s) old${ks.pending ? `, ${ks.pending} value(s) to re-encrypt` : ''}` : 'no active key');
    const an = await anchors.check();
    add('audit_anchor', an.ok && an.anchor && an.anchor.age_sec <= 2 * S('anchors.interval_minutes') * 60, an.anchor ? `${an.detail}; ${Math.round(an.anchor.age_sec / 60)} min old` : an.detail);
    for (const kind of EVIDENCE) {
      const e = evidence(kind);
      add(kind, e && e.ok && t - e.ts <= EVIDENCE_MAX_AGE_MS, e ? `${e.ok ? 'clean' : 'findings'} · recorded ${new Date(e.ts).toISOString().slice(0, 10)}` : 'not recorded yet');
    }
    const badFlags = ['ops.maintenance', 'ops.read_only', 'ops.trading_halt', 'elections.simulator'].filter(on).concat(['ops.backups', 'ops.alerts'].filter((k) => !on(k)));
    add('flags_launch', !badFlags.length, badFlags.length ? badFlags.join(', ') : null);
    const items = OWNER_ITEMS.map((k) => { const r = db.prepare('SELECT * FROM ops_launch_items WHERE key=?').get(k); return { key: k, label: OS(`item.${k}`), done: !!(r && r.done), note: r ? r.note : '', done_date: r ? r.done_date : null, updated_by: r ? emailOf(r.updated_by) : null, updated_time: r ? new Date(r.updated_ts).toISOString() : null }; });
    let waitlist = null;
    try { const W = app.locals.waitlistsApi; if (W) { const st = W.settings('real_money_launch'); waitlist = { target: st.target, count: W.confirmedCount('real_money_launch') }; } } catch { waitlist = null; }
    const blocking = [...c.filter((x) => !x.ok).map((x) => x.label), ...items.filter((x) => !x.done).map((x) => x.label)];
    return { ready: !blocking.length, blocking, checks: c, items, waitlist, gate_enforced: gateEnforced(), config: guard, load_targets: LOAD_TARGETS };
  }
  const configGuardInside = (file, dir) => { if (!file || !dir) return false; const rel = path.relative(path.resolve(dir), path.resolve(file)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
  // The production switch (server/play-mode.js) asks this before a request and before the approval runs.
  async function assertLaunchReady() {
    if (!gateEnforced()) return;
    const r = await readiness();
    if (r.ready) return;
    const e = new ApiError(409, 'launch_not_ready', OS('error.launch_not_ready'), r.blocking.join('; '));
    e.toJSON = () => ({ error: { code: e.code, message: e.message, details: e.details, blocking: r.blocking } });
    throw e;
  }
  app.locals.launchReadiness = { readiness, assertLaunchReady, gateEnforced };
  v1.get('/admin/launch_readiness', can('settings.write'), async (req, res) => res.json(await readiness()));
  v1.put('/admin/launch_readiness/items/:key', can('settings.write'), async (req, res) => {
    const key = String(req.params.key);
    if (!OWNER_ITEMS.includes(key)) throw E.notFound();
    const b = req.body || {};
    const reason = reasonOf(b);
    if (typeof b.done !== 'boolean') throw new ApiError(400, 'validation_failed', 'validation failed', 'done: true or false');
    const note = String(b.note || '').trim().slice(0, 1000);
    const date = b.done_date == null || b.done_date === '' ? null : String(b.done_date);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, 'validation_failed', 'validation failed', 'done_date: a date (YYYY-MM-DD)');
    if (b.done && !date) throw new ApiError(400, 'validation_failed', 'validation failed', 'done_date: the date the item was completed');
    auth.assertFresh(req, 'launch_readiness'); // it unlocks the switch to real money
    const before = db.prepare('SELECT * FROM ops_launch_items WHERE key=?').get(key) || null;
    db.prepare('INSERT INTO ops_launch_items(key,done,note,done_date,updated_by,updated_ts) VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET done=excluded.done, note=excluded.note, done_date=excluded.done_date, updated_by=excluded.updated_by, updated_ts=excluded.updated_ts')
      .run(key, b.done ? 1 : 0, note, date, req.auth.user.id, now());
    admin.audit(req, 'ops.launch_item', 'launch_readiness', key, before ? { done: !!before.done, note: before.note, done_date: before.done_date } : null, { done: b.done, note, done_date: date }, reason);
    res.json(await readiness());
  });
  // Evidence from CI (npm audit / Trivy summaries) and the load-test report (scripts/load.js --report).
  v1.post('/admin/launch_readiness/evidence', can('settings.write'), async (req, res) => {
    const b = req.body || {};
    const kind = String(b.kind || '');
    if (!EVIDENCE.includes(kind)) throw new ApiError(400, 'validation_failed', 'validation failed', `kind: one of ${EVIDENCE.join(', ')}`);
    const reason = reasonOf(b);
    const rep = b.report && typeof b.report === 'object' ? b.report : null;
    if (!rep || JSON.stringify(rep).length > 50000) throw new ApiError(400, 'validation_failed', 'validation failed', 'report: a JSON object (at most 50 kB)');
    let ok; let summary;
    if (kind === 'load_test') {
      const r = rep.results || rep;
      const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      summary = { orders_per_sec: num(r.orders_per_sec), order_p99_ms: num(r.order_p99_ms), ws_fanout_p99_ms: num(r.ws_fanout_p99_ms), page_p95_ms: num(r.page_p95_ms), machine: String(rep.machine || '').slice(0, 200), profile: String(rep.profile || '').slice(0, 40) };
      ok = summary.orders_per_sec != null && summary.orders_per_sec >= LOAD_TARGETS.orders_per_sec && summary.order_p99_ms != null && summary.order_p99_ms <= LOAD_TARGETS.order_p99_ms
        && summary.ws_fanout_p99_ms != null && summary.ws_fanout_p99_ms <= LOAD_TARGETS.ws_fanout_p99_ms && summary.page_p95_ms != null && summary.page_p95_ms <= LOAD_TARGETS.page_p95_ms;
    } else {
      const n = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
      const v = rep.vulnerabilities || rep.metadata?.vulnerabilities || rep;
      summary = { tool: String(rep.tool || (kind === 'image_scan' ? 'trivy' : 'npm audit')).slice(0, 40), critical: n(v.critical), high: n(v.high), medium: n(v.medium), low: n(v.low), target: String(rep.target || '').slice(0, 200) };
      ok = summary.critical === 0 && summary.high === 0;
    }
    db.prepare('INSERT INTO ops_evidence(kind,ts,ok,summary_json,recorded_by) VALUES(?,?,?,?,?) ON CONFLICT(kind) DO UPDATE SET ts=excluded.ts, ok=excluded.ok, summary_json=excluded.summary_json, recorded_by=excluded.recorded_by')
      .run(kind, now(), ok ? 1 : 0, JSON.stringify(summary), req.auth.user.id);
    admin.audit(req, 'ops.evidence', 'launch_readiness', kind, null, { ok, summary }, reason);
    res.status(201).json(await readiness());
  });

  // ---------------------------------------------------------------- Admin › System
  async function systemView() {
    const b = backups.status();
    const firing = alerts.firing();
    return {
      migrations: migrations.status(db),
      backups: { ...b, recent: backups.list(15).map((x) => ({ id: x.id, kind: x.kind, status: x.status, time: new Date(x.created_ts).toISOString(), bytes: x.bytes, sha256: x.sha256, key_id: x.key_id, deleted: !!x.deleted_ts, error: x.error })) },
      restore_drill: { last_ok: drillVo(lastDrill()), recent: db.prepare('SELECT * FROM ops_restore_drills ORDER BY started_ts DESC LIMIT 10').all().map(drillVo), running: !!drillRunning },
      keys: keyring.status(),
      anchor: { ...(await anchors.check()), public_key: anchors.publicKey, key_id: anchors.keyId },
      verifiers: await verifiers(),
      readiness: obs.readiness(),
      switches: ['ops.maintenance', 'ops.trading_halt', 'ops.read_only', 'ops.traces', 'ops.backups', 'ops.alerts'].map((k) => { const f = flags.state.get(k); return { key: k, on: on(k), enabled: f.enabled, starts_time: f.starts_at ? new Date(f.starts_at).toISOString() : null, ends_time: f.ends_at ? new Date(f.ends_at).toISOString() : null, help: SW(`flag.${k}`) }; }),
      approvals: db.prepare("SELECT * FROM ops_approvals WHERE status='pending' ORDER BY requested_ts DESC").all().map(approvalVo),
      alerts: { firing, contacts: alerts.contacts(), history: alerts.history(20) },
      storage: { media: mediaStorage ? mediaStorage.describe() : null, backups: backupStorage ? backupStorage.describe() : null, blob_move: blobStatus() },
      database: databaseInfo(),
      metrics: { port: obs.metricsPort || null, host: obs.metricsPort ? (process.env.METRICS_HOST || '127.0.0.1') : null },
      admin_origin: security.adminOrigin || null, public_origin: security.publicOrigin || null,
    };
  }
  // Database size and the last `npm run db:compact` run (scripts/db-compact.js, CLONE_SPEC.md §39.17).
  function databaseInfo() {
    const f = dbFile && dbFile !== ':memory:' ? path.resolve(dbFile) : null;
    const st = (x) => { try { return fs.statSync(x).size; } catch { return 0; } };
    const vo = (r) => (r ? { id: r.id, time: new Date(r.ts).toISOString(), older_than_days: r.older_than_days, bytes_before: r.bytes_before, bytes_after: r.bytes_after, counts: JSON.parse(r.counts_json || '{}'), backup_id: r.backup_id, error: r.error || null } : null);
    const q = (sql) => { try { return db.prepare(sql).get(); } catch { return null; } };
    return { bytes: f ? st(f) + st(`${f}-wal`) : null, wal_bytes: f ? st(`${f}-wal`) : null,
      last_compaction: vo(q("SELECT * FROM ops_compactions WHERE status='ok' AND dry_run=0 ORDER BY ts DESC LIMIT 1")),
      last_refused: vo(q("SELECT * FROM ops_compactions WHERE status='refused' AND ts > COALESCE((SELECT MAX(ts) FROM ops_compactions WHERE status='ok' AND dry_run=0), 0) ORDER BY ts DESC LIMIT 1")) };
  }
  v1.get('/admin/system', can('settings.write'), async (req, res) => res.json(await systemView()));
  v1.post('/admin/system/backups', can('settings.write'), async (req, res) => {
    const reason = reasonOf(req.body);
    auth.assertFresh(req, 'backup');
    const r = await backups.snapshot('manual', { note: reason, actor: req.auth.user });
    res.status(201).json({ backup: r, system: await systemView() });
  });
  v1.post('/admin/system/restore_drill', can('settings.write'), async (req, res) => {
    reasonOf(req.body);
    const d = await restoreDrill({ trigger: 'manual', actor: req.auth.user });
    res.status(201).json({ drill: d, system: await systemView() });
  });
  v1.post('/admin/system/anchor', can('settings.write'), async (req, res) => {
    const reason = reasonOf(req.body);
    const a = await anchors.anchor({ reason });
    res.status(201).json({ anchor: { seq: a.seq, chain_seq: a.chain_seq, object_key: a.object_key || null }, system: await systemView() });
  });
  v1.post('/admin/system/verify', can('settings.write'), async (req, res) => res.json({ verifiers: await verifiers({ fresh: true }) }));
  v1.post('/admin/system/keys/rotate', can('settings.write'), async (req, res) => {
    const reason = reasonOf(req.body);
    auth.assertFresh(req, 'key_rotation');
    let r;
    try { r = keyring.rotate({ actor: req.auth.user.id }); } catch (e) { if (e.code === 'rotation_manual') throw new ApiError(409, 'rotation_manual', OS('error.rotation_manual')); throw e; }
    admin.audit(req, 'ops.key_rotate', 'crypto_key', r.kid, null, { kid: r.kid }, reason);
    if (req.body && req.body.wait) await r.rotation;
    res.status(202).json({ kid: r.kid, keys: keyring.status() });
  });
  // Alert contacts.
  v1.post('/admin/system/alerts/contacts', can('settings.write'), (req, res) => {
    const b = req.body || {};
    reasonOf(b);
    auth.assertFresh(req, 'alert_contact');
    const r = alerts.addContact({ kind: String(b.kind || ''), target: String(b.target || ''), label: String(b.label || '') }, req.auth.user.id);
    if (r.error) { const e = new ApiError(400, 'validation_failed', 'validation failed', Object.entries(r.error).map(([k, m]) => `${k}: ${m}`).join('; ')); e.toJSON = () => ({ error: { code: e.code, message: e.message, details: e.details, fields: r.error } }); throw e; }
    admin.audit(req, 'ops.alert_contact.add', 'alert_contact', r.contact.id, null, r.contact, String(b.reason).trim());
    res.status(201).json({ contact: r.contact, contacts: alerts.contacts() });
  });
  v1.post('/admin/system/alerts/contacts/:id/test', can('settings.write'), async (req, res) => {
    const r = await alerts.testContact(String(req.params.id), req.auth.user.id);
    if (!r) throw E.notFound();
    admin.audit(req, 'ops.alert_contact.test', 'alert_contact', req.params.id, null, { delivered: r.delivered, detail: r.detail }, 'test send');
    res.json(r);
  });
  v1.post('/admin/system/alerts/contacts/:id/confirm', can('settings.write'), (req, res) => {
    const r = alerts.confirmContact(String(req.params.id), (req.body || {}).code);
    if (!r.ok) throw new ApiError(400, r.reason === 'no_code' ? 'code_expired' : 'invalid_code', r.reason === 'no_code' ? 'send a new test first' : 'that code is not right');
    admin.audit(req, 'ops.alert_contact.confirm', 'alert_contact', req.params.id, null, r.contact, 'code entered');
    res.json({ contact: r.contact, contacts: alerts.contacts() });
  });
  v1.delete('/admin/system/alerts/contacts/:id', can('settings.write'), (req, res) => {
    const reason = reasonOf(req.body);
    if (!alerts.removeContact(String(req.params.id))) throw E.notFound();
    admin.audit(req, 'ops.alert_contact.remove', 'alert_contact', req.params.id, null, null, reason);
    res.json({ contacts: alerts.contacts() });
  });
  v1.post('/admin/system/alerts/run', can('settings.write'), async (req, res) => res.json({ results: await alerts.run(), firing: alerts.firing() }));

  // ---------------------------------------------------------------- media and identity documents → object storage
  let blobState = { moved: 0, remaining: null, running: false, error: null };
  const hasTable = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  function blobStatus() {
    const q = (sql) => { try { return db.prepare(sql).get().c; } catch { return 0; } };
    blobState.remaining = q("SELECT COUNT(*) c FROM cms_media WHERE storage_key IS NULL AND length(data)>0") + q('SELECT COUNT(*) c FROM docv_documents WHERE storage_key IS NULL AND data IS NOT NULL');
    return { ...blobState };
  }
  let blobAgain = false; let blobPass = null;
  // A call while a pass runs asks for another pass and waits for the whole move (storage writes are asynchronous, so a
  // pass can still be running when a caller asks; it gets the finished status, never a half-done one).
  async function moveBlobs() {
    if (blobState.running) { blobAgain = true; return blobPass; }
    if (!mediaStorage) return blobState;
    blobPass = movePass();
    return blobPass;
  }
  async function movePass() {
    blobState.running = true;
    try {
      for (;;) {
        const m = hasTable('cms_media') ? db.prepare("SELECT id, ext, mime, data FROM cms_media WHERE storage_key IS NULL AND length(data)>0 LIMIT 20").all() : [];
        const d = hasTable('docv_documents') ? db.prepare('SELECT id, user_id, data FROM docv_documents WHERE storage_key IS NULL AND data IS NOT NULL LIMIT 20').all() : [];
        if (!m.length && !d.length) break;
        for (const r of m) {
          const key = `media/${r.id}.${r.ext}`;
          await mediaStorage.put(key, Buffer.from(r.data), { contentType: r.mime });
          db.prepare("UPDATE cms_media SET storage_key=?, data=x'' WHERE id=? AND storage_key IS NULL").run(key, r.id);
          blobState.moved += 1;
        }
        for (const r of d) {
          const key = `kyc/${r.user_id}/${r.id}.sealed`; // already sealed with the user's data key (server/docv.js)
          await mediaStorage.put(key, Buffer.from(r.data), { contentType: 'application/octet-stream' });
          db.prepare('UPDATE docv_documents SET storage_key=?, data=NULL WHERE id=? AND storage_key IS NULL').run(key, r.id);
          blobState.moved += 1;
        }
      }
      blobState.error = null;
    } catch (e) { blobState.error = e.message; logger.error('blob move failed', { error: e.message }); } finally { blobState.running = false; }
    if (blobAgain) { blobAgain = false; return movePass(); } // an upload arrived while this pass ran
    return blobStatus();
  }

  // ---------------------------------------------------------------- retention of the database logs (owner setting)
  function purgeLogs() {
    const cut = now() - S('logs.retention_days') * 86400000;
    let n = 0;
    try { n += db.prepare('DELETE FROM security_events WHERE ts<?').run(cut).changes; } catch { /* table missing */ }
    try { n += db.prepare('DELETE FROM auth_events WHERE ts<?').run(cut).changes; } catch { /* table missing */ }
    try { n += db.prepare("DELETE FROM ops_alerts WHERE status<>'firing' AND started_ts<?").run(cut).changes; } catch { /* table missing */ }
    if (n) sysAudit({ action: 'ops.retention_purge', target_id: 'logs', after: { rows: n, older_than_days: S('logs.retention_days') }, reason: OS('reason.retention') });
    return n;
  }

  // ---------------------------------------------------------------- jobs
  const timers = []; const sweepTimers = [];
  function startJobs({ schedule = true } = {}) {
    keyring.startup();
    moveBlobs().catch(() => {});
    if (mediaStorage) { const t = setInterval(() => { moveBlobs().catch(() => {}); }, options.blobSweepMs || 60000); t.unref(); sweepTimers.push(t); } // safety sweep
    if (!schedule) return;
    if (backups.shipping || options.backupSchedule) {
      const tick = () => { if (!flags.jobOn('ops.backups')) return; backups.tick(); obs.job('backups', true); };
      timers.push(setInterval(tick, options.backupTickMs || 5000));
    }
    anchors.start((ok, e) => obs.job('anchors', ok, e && e.message), options.anchorTickMs || 30000);
    timers.push(setInterval(() => obs.job('anchors', true), 60000)); // the anchor job is alive even between anchors
    alerts.start(options.alertTickMs || 30000, (ok, e) => obs.job('alerts', ok, e && e.message));
    timers.push(setInterval(() => {
      try {
        purgeLogs();
        const every = S('backups.drill_every_days');
        const last = db.prepare("SELECT MAX(started_ts) t FROM ops_restore_drills").get().t || 0;
        if (every > 0 && backupStorage && now() - last > every * 86400000 && db.prepare("SELECT 1 FROM ops_backups WHERE status='ok' LIMIT 1").get()) restoreDrill({ trigger: 'schedule' }).catch(() => {});
        verifiers({ fresh: true }).catch(() => {});
        obs.job('maintenance_jobs', true);
      } catch (e) { obs.job('maintenance_jobs', false, e.message); }
    }, options.hourlyMs || 3600000));
    for (const t of timers) t.unref();
  }
  function stopJobs() { timers.splice(0).forEach(clearInterval); sweepTimers.splice(0).forEach(clearInterval); anchors.stop(); alerts.stop(); }

  return { lastVerifiers: () => verifierCache, switchGate, restoreDrill, readiness, assertLaunchReady, systemView, verifiers, moveBlobs, blobStatus, purgeLogs, startJobs, stopJobs, LOAD_TARGETS, OWNER_ITEMS };
}

module.exports = { mountOperations, LOAD_TARGETS, OWNER_ITEMS, TRADING, ALWAYS };
