'use strict';
// Geolocation compliance (PLAN P3.6) and fraud signals (P3.7), CLONE_SPEC §25. Mirrors PLAN §2 S10 (GeoComply location
// checks, a fraud session id, a device-ID hash) with simulated providers.
//
// Location: the country of the client IP (simulated IP-to-country table in server/countries.js plus admin overrides) and,
// when the user consents in the browser, the country of the reported coordinates (coarse boxes; the coordinates are
// never stored, only the derived country for 30 minutes). Either one in the blocked list blocks deposits, withdrawals,
// transfers and orders (`403 geo_restricted`); re-checked on every such request.
// Fraud: a random per-browser ID (sent as X-Device-Id, stored only as an HMAC) and a user-agent hash — no fingerprinting
// beyond that — plus velocity rules give a risk score per money movement. A withdrawal at or above the threshold is
// held for staff review (funds leave the balance into the hold; release completes it, reverse refunds it).
const Cur = require('./currency'); // display currency formatting (CLONE_SPEC.md §30)
const { tx } = require('./db');
const { newId, ApiError, E, dollars } = require('./util');
const kc = require('./crypto');
const C = require('./countries');
const { check } = require('./validate');
const journal = require('./journal');

const MIN = 60000; const HOUR = 60 * MIN; const DAY = 24 * HOUR;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS geo_checks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, sid TEXT, country TEXT NOT NULL, source TEXT NOT NULL, created_ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_geo_checks_user ON geo_checks(user_id, created_ts);
CREATE TABLE IF NOT EXISTS device_sightings (device_hash TEXT NOT NULL, user_id TEXT NOT NULL, ua_hash TEXT NOT NULL DEFAULT '', first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (device_hash, user_id));
CREATE INDEX IF NOT EXISTS idx_devices_user ON device_sightings(user_id, last_seen);
CREATE TABLE IF NOT EXISTS risk_assessments (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, amount_cents INTEGER, score INTEGER NOT NULL, signals TEXT NOT NULL DEFAULT '[]', action TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_risk_user ON risk_assessments(user_id, ts);
CREATE TABLE IF NOT EXISTS withdrawal_holds (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, amount_cents INTEGER NOT NULL, score INTEGER NOT NULL, signals TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL,
  created_ts INTEGER NOT NULL, decided_ts INTEGER, decided_by TEXT, reason TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_holds_status ON withdrawal_holds(status, created_ts);
`;
const DEVICE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SIGNAL_TEXT = {
  account_new: 'Account younger than 24 hours', no_device_id: 'No device ID', new_device: 'Device first seen within the hour', device_shared: 'Device used by other accounts',
  many_devices: '3+ devices in 24 hours', deposit_velocity: '5+ deposits in an hour', withdrawal_velocity: '3+ withdrawals in an hour',
  deposit_and_withdraw: 'Withdrawing most of a recent deposit without trading', failed_logins: '5+ failed sign-ins in 24 hours', geo_mismatch: 'IP country differs from residence',
  phone_shared: 'Phone number verified on another account',
};

function createCompliance(ctx) {
  const { db, engine, security, settings, profile, logEvent, audit, can, notify, requireUser, auth, getUser, keyDir } = ctx;
  db.exec(SCHEMA);
  const deviceKey = kc.deriveKey('device-id:v1', { dir: keyDir });

  // ------------------------------------------------------------------ geolocation (P3.6)
  const ipCountry = (req) => C.countryOfIp(security.clientIp(req), settings().ip_overrides || []);
  const browserFix = (req) => (req.auth ? db.prepare('SELECT * FROM geo_checks WHERE user_id=? AND sid=? AND created_ts>? ORDER BY created_ts DESC LIMIT 1').get(req.auth.user.id, req.auth.session.sid, Date.now() - 30 * MIN) : null);
  function geoDecision(req) {
    const s = settings();
    const blocked = new Set(s.blocked_countries || []);
    const ip = ipCountry(req);
    const fix = browserFix(req);
    const browser = fix ? fix.country : null;
    let block = null;
    if (blocked.has(ip)) block = { country: ip, source: 'ip' };
    else if (browser && blocked.has(browser)) block = { country: browser, source: 'browser' };
    else if (ip === 'ZZ' && s.unknown_ip === 'block' && !browser) block = { country: 'ZZ', source: 'ip' };
    const country = block ? block.country : browser || ip;
    return { allowed: !block, country, country_name: C.countryName(country), ip_country: ip, browser_country: browser, source: block ? block.source : browser ? 'browser' : 'ip',
      browser_checked_time: fix ? new Date(fix.created_ts).toISOString() : null, blocked_countries: [...blocked] };
  }
  function geoCheck(req, kind) {
    const d = geoDecision(req);
    if (d.allowed) return;
    logEvent(req.auth?.user.id, 'geo_blocked', req, { country: d.country, source: d.source, action: kind });
    const e = new ApiError(403, 'geo_restricted', 'Parlance isn’t available in your location', `trading, deposits and withdrawals aren’t permitted from ${d.country_name}`);
    e.toJSON = () => ({ error: { code: e.code, message: e.message, details: e.details, country: d.country, country_name: d.country_name, source: d.source } });
    throw e;
  }

  // ------------------------------------------------------------------ devices (P3.7)
  function deviceHash(req) {
    const id = req.get?.('x-device-id');
    return id && DEVICE_RE.test(id) ? kc.hmacHex(deviceKey, id).slice(0, 32) : null;
  }
  const uaHash = (req) => kc.sha256hex(String(req.get?.('user-agent') || '')).slice(0, 16);
  function recordDevice(uid, req) {
    const h = deviceHash(req);
    if (!h || !uid) return;
    const now = Date.now();
    db.prepare('INSERT INTO device_sightings(device_hash,user_id,ua_hash,first_seen,last_seen,count) VALUES(?,?,?,?,?,1) ON CONFLICT(device_hash,user_id) DO UPDATE SET last_seen=excluded.last_seen, ua_hash=excluded.ua_hash, count=count+1')
      .run(h, uid, uaHash(req), now, now);
  }
  const devicesOf = (uid) => db.prepare('SELECT device_hash, ua_hash, first_seen, last_seen, count FROM device_sightings WHERE user_id=? ORDER BY last_seen DESC LIMIT 50').all(uid)
    .map((d) => ({ device: d.device_hash.slice(0, 12), ua: d.ua_hash.slice(0, 8), first_seen_time: new Date(d.first_seen).toISOString(), last_seen_time: new Date(d.last_seen).toISOString(), uses: d.count }));

  // ------------------------------------------------------------------ risk score (P3.7)
  function assess(uid, req, kind, cents) {
    const now = Date.now();
    const signals = [];
    const add = (code, points, detail = '') => signals.push({ code, points, label: SIGNAL_TEXT[code], detail });
    const u = getUser(uid);
    if (now - Date.parse(u.created_at) < DAY) add('account_new', 15);
    const dev = deviceHash(req);
    if (!dev) add('no_device_id', 5);
    else {
      const row = db.prepare('SELECT first_seen FROM device_sightings WHERE device_hash=? AND user_id=?').get(dev, uid);
      if (!row || now - row.first_seen < HOUR) add('new_device', 10);
      const others = db.prepare('SELECT COUNT(DISTINCT user_id) c FROM device_sightings WHERE device_hash=? AND user_id<>? AND last_seen>?').get(dev, uid, now - 30 * DAY).c;
      if (others >= 2) add('device_shared', 25, `${others} other accounts`);
    }
    if (db.prepare('SELECT COUNT(DISTINCT device_hash) c FROM device_sightings WHERE user_id=? AND last_seen>?').get(uid, now - DAY).c >= 3) add('many_devices', 15);
    const since = (ms) => new Date(now - ms).toISOString();
    if (db.prepare("SELECT COUNT(*) c FROM ledger WHERE user_id=? AND kind='deposit' AND created_at>?").get(uid, since(HOUR)).c >= 5) add('deposit_velocity', 20);
    const wds = db.prepare("SELECT COUNT(*) c FROM ledger WHERE user_id=? AND kind IN ('withdrawal','withdrawal_hold') AND created_at>?").get(uid, since(HOUR)).c;
    if (wds >= 3) add('withdrawal_velocity', 20, `${wds} in the last hour`);
    if (kind === 'withdrawal') {
      const dep = db.prepare("SELECT COALESCE(SUM(amount_cents),0) c FROM ledger WHERE user_id=? AND kind='deposit' AND created_at>?").get(uid, since(DAY)).c;
      const fills = db.prepare('SELECT COUNT(*) c FROM fills WHERE user_id=? AND created_ts>?').get(uid, now - DAY).c;
      if (dep > 0 && cents >= 0.8 * dep && fills === 0) add('deposit_and_withdraw', 25);
    }
    if (db.prepare("SELECT COUNT(*) c FROM auth_events WHERE user_id=? AND type='login_fail' AND ts>?").get(uid, now - DAY).c >= 5) add('failed_logins', 10);
    const p = profile(uid);
    const ip = ipCountry(req);
    if (p?.country && ip !== 'ZZ' && ip !== p.country) add('geo_mismatch', 10, `IP ${ip}, residence ${p.country}`);
    if (p?.phone_hash && db.prepare('SELECT 1 FROM identity_profiles WHERE phone_hash=? AND user_id<>? LIMIT 1').get(p.phone_hash, uid)) add('phone_shared', 15);
    return { score: signals.reduce((a, s) => a + s.points, 0), signals };
  }
  const holdsEnabled = () => { const f = settings().fraud; return f.hold_withdrawals == null ? ctx.enforced() : !!f.hold_withdrawals; };
  function saveAssessment(uid, kind, cents, a, action) {
    db.prepare('INSERT INTO risk_assessments(id,user_id,ts,kind,amount_cents,score,signals,action) VALUES(?,?,?,?,?,?,?,?)').run(newId('ra_'), uid, Date.now(), kind, cents ?? null, a.score, JSON.stringify(a.signals), action);
  }
  const amountOf = (b) => { const a = Number(b && b.amount_dollars); return Number.isFinite(a) && a > 0 && a <= 100000 && Math.round(a * 100) === a * 100 ? Math.round(a * 100) : null; };

  // Called by the identity gate after the location and verification checks.
  function fraudGate(req, res, next, kind) {
    const uid = req.auth.user.id;
    try { recordDevice(uid, req); } catch { /* best effort */ }
    if (kind !== 'withdrawal' && kind !== 'deposit') return next();
    const cents = amountOf(req.body);
    if (cents == null) return next(); // the route reports the validation error
    const a = assess(uid, req, kind, cents);
    const threshold = settings().fraud.hold_threshold;
    if (kind === 'deposit' || !holdsEnabled() || a.score < threshold || engine.balance(uid) < cents) {
      saveAssessment(uid, kind, cents, a, kind === 'withdrawal' && a.score >= threshold ? 'flag' : 'allow');
      return next();
    }
    let id;
    try {
      // Payments (server/payments.js): withdrawal limits and the unsettled-funds rule apply before funds move into a hold.
      if (precheck) precheck(uid, cents);
      tx(db, () => {
        id = createHold(uid, cents, a.score, a.signals, { notifyUser: false });
        saveAssessment(uid, kind, cents, a, 'hold');
      });
    } catch (e) { return next(e); }
    engine.emit('user_balance', uid, engine.balance(uid));
    logEvent(uid, 'withdrawal_held', req, { hold_id: id, score: a.score });
    holdNotice(uid, cents, '/account/privacy');
    res.status(202).json({ status: 'held', hold_id: id, amount_dollars: dollars(cents), balance_dollars: dollars(engine.balance(uid)), message: 'Your withdrawal is being reviewed before it is sent.' });
  }

  // A withdrawal held for staff review: the funds leave the balance into the hold (journal account user:<uid>:held).
  // Shared by the fraud score above and the AML rules of server/payments.js. Runs inside the caller's transaction.
  function createHold(uid, cents, score, signals, { notifyUser = true, link = '/funds' } = {}) {
    const id = newId('wh_');
    tx(db, () => {
      engine.credit(uid, -cents, 'withdrawal_hold', id, 'withdrawal held for review');
      db.prepare('INSERT INTO withdrawal_holds(id,user_id,amount_cents,score,signals,status,created_ts) VALUES(?,?,?,?,?,?,?)').run(id, uid, cents, score, JSON.stringify(signals || []), 'held', Date.now());
    });
    if (notifyUser) holdNotice(uid, cents, link);
    return id;
  }
  function holdNotice(uid, cents, link) {
    try { notify(uid, { type: 'security', title: 'Withdrawal under review', body: `Your withdrawal of ${Cur.moneyCents(cents)} is being reviewed. This usually takes less than one business day.`, link }); } catch { /* ignore */ }
  }
  // Release / reverse listeners (server/payments.js sends a held rail withdrawal to its provider on release). A listener
  // returns true when it posted the journal entry for a release; otherwise the funds leave as a demo payout.
  const holdListeners = [];
  const onHoldDecision = (fn) => holdListeners.push(fn);
  let precheck = null;
  const setWithdrawalPrecheck = (fn) => { precheck = fn; };

  const holdVo = (h) => ({ id: h.id, amount_dollars: dollars(h.amount_cents), status: h.status, created_time: new Date(h.created_ts).toISOString(), decided_time: h.decided_ts ? new Date(h.decided_ts).toISOString() : null });
  const holdsOf = (uid) => db.prepare('SELECT * FROM withdrawal_holds WHERE user_id=? ORDER BY created_ts DESC').all(uid).map(holdVo);
  function riskSummary(uid) {
    const last = db.prepare('SELECT * FROM risk_assessments WHERE user_id=? ORDER BY ts DESC LIMIT 1').get(uid);
    return { latest_score: last ? last.score : null, latest_time: last ? new Date(last.ts).toISOString() : null, latest_signals: last ? JSON.parse(last.signals) : [], devices: devicesOf(uid).length,
      holds: db.prepare("SELECT COUNT(*) c FROM withdrawal_holds WHERE user_id=? AND status='held'").get(uid).c };
  }

  function mountRoutes(v1) {
    v1.get('/users/:uid/geolocation', requireUser, (req, res) => res.json(geoDecision(req)));
    // Optional browser location (consented in the UI). Only the derived country is stored, for 30 minutes of decisions.
    v1.post('/users/:uid/geolocation', requireUser, (req, res) => {
      const b = check(req.body, { latitude: { type: 'number', min: -90, max: 90, required: true }, longitude: { type: 'number', min: -180, max: 180, required: true }, accuracy: { type: 'number', min: 0, max: 1e7 } }, { unknown: 'reject' });
      const country = C.countryAt(b.latitude, b.longitude);
      db.prepare('INSERT INTO geo_checks(id,user_id,sid,country,source,created_ts) VALUES(?,?,?,?,?,?)').run(newId('gc_'), req.auth.user.id, req.auth.session.sid, country, 'browser', Date.now());
      const d = geoDecision(req);
      logEvent(req.auth.user.id, 'geo_check', req, { country, allowed: d.allowed });
      res.json(d);
    });
    v1.get('/users/:uid/withdrawal_holds', requireUser, (req, res) => res.json({ holds: holdsOf(req.auth.user.id) }));

    v1.get('/admin/fraud/overview', can('users.read'), (req, res) => {
      const holds = db.prepare('SELECT h.*, u.email FROM withdrawal_holds h JOIN users u ON u.id=h.user_id ORDER BY (h.status=\'held\') DESC, h.created_ts DESC LIMIT 200').all()
        .map((h) => ({ ...holdVo(h), user_id: h.user_id, email: h.email, score: h.score, signals: JSON.parse(h.signals) }));
      const risky = db.prepare('SELECT r.*, u.email FROM risk_assessments r JOIN users u ON u.id=r.user_id WHERE r.ts>? ORDER BY r.score DESC, r.ts DESC LIMIT 100').all(Date.now() - 7 * DAY)
        .map((r) => ({ id: r.id, user_id: r.user_id, email: r.email, time: new Date(r.ts).toISOString(), kind: r.kind, amount_dollars: r.amount_cents == null ? null : dollars(r.amount_cents), score: r.score, action: r.action, signals: JSON.parse(r.signals) }));
      const shared = db.prepare('SELECT device_hash, COUNT(DISTINCT user_id) n, MAX(last_seen) t FROM device_sightings WHERE last_seen>? GROUP BY device_hash HAVING n>=2 ORDER BY n DESC LIMIT 50').all(Date.now() - 30 * DAY)
        .map((d) => ({ device: d.device_hash.slice(0, 12), accounts: d.n, last_seen_time: new Date(d.t).toISOString() }));
      const geo = db.prepare("SELECT COUNT(*) c FROM auth_events WHERE type='geo_blocked' AND ts>?").get(Date.now() - DAY).c;
      res.json({ threshold: settings().fraud.hold_threshold, holds_enabled: holdsEnabled(), holds, assessments: risky, shared_devices: shared, geo_blocked_24h: geo });
    });
    v1.post('/admin/fraud/holds/:id/:action', can('users.money'), (req, res) => {
      const action = req.params.action;
      if (!['release', 'reverse'].includes(action)) throw E.notFound();
      const b = check(req.body, { reason: { type: 'string', maxLen: 500, required: true } }, { unknown: 'reject' });
      const h = db.prepare('SELECT * FROM withdrawal_holds WHERE id=?').get(String(req.params.id));
      if (!h) throw E.notFound();
      if (h.status !== 'held') throw E.conflict('hold_closed', 'this hold was already decided');
      const reason = b.reason.trim();
      if (reason.length < 3) throw new ApiError(400, 'validation_failed', 'validation failed', 'reason: a reason of 3-500 characters is required');
      auth.assertFresh(req, 'withdrawal_hold_decision');
      tx(db, () => {
        if (db.prepare("UPDATE withdrawal_holds SET status=?, decided_ts=?, decided_by=?, reason=? WHERE id=? AND status='held'").run(action === 'release' ? 'released' : 'reversed', Date.now(), req.auth.user.id, reason, h.id).changes !== 1) throw E.conflict('hold_closed', 'this hold was already decided');
        // Release: the held funds leave as the withdrawal (the `withdrawal_hold` ledger entry already took them from the
        // balance; the ledger stays append-only). Reverse: refunded with a `withdrawal_hold_reversal` entry.
        if (action === 'reverse') engine.credit(h.user_id, h.amount_cents, 'withdrawal_hold_reversal', h.id, 'held withdrawal reversed');
        const claimed = holdListeners.map((fn) => fn(h, action, req)).some((x) => x === true);
        if (action === 'release' && !claimed) journal.onHoldReleased(db, h); // held → paid out (double-entry journal)
        audit(req, `fraud.hold_${action}`, h.user_id, { hold: h.id, status: 'held' }, { hold: h.id, status: action === 'release' ? 'released' : 'reversed', amount_cents: h.amount_cents }, reason);
      });
      engine.emit('user_balance', h.user_id, engine.balance(h.user_id));
      try { notify(h.user_id, { type: 'security', title: action === 'release' ? 'Withdrawal sent' : 'Withdrawal reversed', body: action === 'release' ? `Your withdrawal of ${Cur.moneyCents(h.amount_cents)} was approved.` : `Your withdrawal of ${Cur.moneyCents(h.amount_cents)} was returned to your balance.`, link: '/account/privacy' }); } catch { /* ignore */ }
      res.json({ hold: holdVo(db.prepare('SELECT * FROM withdrawal_holds WHERE id=?').get(h.id)) });
    });
  }

  function forgetUser(uid) { db.prepare('DELETE FROM geo_checks WHERE user_id=?').run(uid); }
  function purge(r) {
    db.prepare('DELETE FROM geo_checks WHERE created_ts<?').run(Date.now() - r.geo_days * DAY);
    db.prepare('DELETE FROM device_sightings WHERE last_seen<?').run(Date.now() - r.device_days * DAY);
    db.prepare('DELETE FROM risk_assessments WHERE ts<?').run(Date.now() - 400 * DAY);
  }

  return { geoCheck, geoDecision, ipCountry, fraudGate, recordDevice, devicesOf, holdsOf, riskSummary, assess, mountRoutes, forgetUser, purge, createHold, onHoldDecision, setWithdrawalPrecheck, saveAssessment, holdsEnabled };
}

module.exports = { createCompliance, SIGNAL_TEXT };
