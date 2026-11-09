'use strict';
// Alerts (PLAN P9.4, CLONE_SPEC.md §39.5). The server evaluates its own rules every 30 s and tells the owner through the
// confirmed alert contacts; Prometheus + Alertmanager (deploy/) evaluate the same signals from the metrics port plus the
// ones a process cannot see about itself (site down, certificate expiry from the outside).
//
// Rules (thresholds are owner settings): backup overdue, restore drill overdue, audit anchor overdue, verifier failure
// (ledger / journal audit, audit chain, anchor comparison), error rate (5xx share over 5 minutes), order latency (p99
// order-to-ack), job stalled, disk filling, certificate expiry (TLS_CERT_FILE, when the proxy's certificate is mounted).
// A rule that starts firing is sent at once, repeated every `alerts.repeat_minutes` while it fires, and a resolution is
// sent when it clears. Every alert is recorded (ops_alerts).
//
// Contacts (Admin › System › Alerts): email (through the email provider), webhook (an HTTPS endpoint; JSON body signed
// with HMAC-SHA256 in X-Parlance-Signature, so an SMS gateway, a chat app or a phone push service can relay it), push
// (Web Push to a staff account's installed app). A contact receives real alerts only once confirmed: "Send test" delivers
// a message with a 6-digit code, and the code entered back in Admin › System proves the message arrived.
const crypto = require('node:crypto');
const fs = require('node:fs');
const kc = require('./crypto');
const { newId } = require('./util');

const RULES = ['backup_overdue', 'restore_drill_overdue', 'anchor_overdue', 'verifier_failure', 'error_rate', 'order_latency', 'job_stalled', 'disk_filling', 'cert_expiry'];
const CODE_TTL_MS = 30 * 60000;

function createAlerts({ db, keyDir, settings, messaging = null, webpush = null, obs = null, logger = null, text, signals = {}, allowHosts = null, audit = () => {}, now = () => Date.now(), fetchImpl = fetch }) {
  const encKey = kc.deriveKey('ops-secrets:v1', { dir: keyDir });
  const sigKey = kc.deriveKey('ops-webhook-signing:v1', { dir: keyDir });
  const S = (k, d) => { try { const v = settings ? settings(k) : undefined; return v == null ? d : v; } catch { return d; } };
  const T = (k, v) => (text ? text(k, v) : k);

  // ---------------------------------------------------------------- contacts
  const mask = (kind, t) => (kind === 'email' ? t.replace(/^(.).*(@.*)$/, '$1•••$2') : kind === 'webhook' ? (() => { try { const u = new URL(t); return `${u.protocol}//${u.host}/…`; } catch { return '…'; } })() : t);
  const targetOf = (c) => kc.decrypt(c.target_enc, `ops_alert_contacts.target:${c.id}`, encKey);
  function validTarget(kind, target) {
    const t = String(target || '').trim();
    if (kind === 'email') return /^[^\s@]{1,64}@[^\s@]{1,190}\.[A-Za-z]{2,}$/.test(t) ? t.toLowerCase() : null;
    if (kind === 'webhook') {
      try {
        const u = new URL(t);
        const loopback = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname);
        if (u.username || u.password) return null;
        if (u.protocol === 'https:' || (u.protocol === 'http:' && loopback && (allowHosts ? allowHosts(u) : process.env.NODE_ENV !== 'production'))) return u.toString();
      } catch { /* invalid */ }
      return null;
    }
    if (kind === 'push') return db.prepare('SELECT id FROM users WHERE id=? OR email=?').get(t, t.toLowerCase())?.id || null;
    return null;
  }
  function addContact({ kind, target, label }, actor) {
    if (!['email', 'webhook', 'push'].includes(kind)) return { error: { kind: 'email, webhook or push' } };
    const t = validTarget(kind, target);
    if (!t) return { error: { target: kind === 'email' ? 'a valid email address' : kind === 'webhook' ? 'an https:// URL' : 'a staff account (id or email)' } };
    const id = newId('ac_');
    db.prepare('INSERT INTO ops_alert_contacts(id,kind,label,target_enc,target_masked,created_by,created_ts) VALUES(?,?,?,?,?,?,?)')
      .run(id, kind, String(label || kind).slice(0, 80), kc.encrypt(t, `ops_alert_contacts.target:${id}`, encKey), mask(kind, kind === 'push' ? db.prepare('SELECT email FROM users WHERE id=?').get(t)?.email || t : t), actor || null, now());
    return { contact: contactVo(db.prepare('SELECT * FROM ops_alert_contacts WHERE id=?').get(id)) };
  }
  const contactVo = (c) => ({ id: c.id, kind: c.kind, label: c.label, target: c.target_masked, confirmed: !!c.confirmed_ts, confirmed_time: c.confirmed_ts ? new Date(c.confirmed_ts).toISOString() : null,
    last_test_time: c.last_test_ts ? new Date(c.last_test_ts).toISOString() : null, last_result: c.last_result || null, code_pending: !!(c.code_hash && c.code_expires_ts > now()) });
  const contacts = () => db.prepare('SELECT * FROM ops_alert_contacts WHERE deleted_ts IS NULL ORDER BY created_ts').all();
  const removeContact = (id) => db.prepare('UPDATE ops_alert_contacts SET deleted_ts=? WHERE id=? AND deleted_ts IS NULL').run(now(), id).changes === 1;

  // ---------------------------------------------------------------- delivery
  function sign(body, ts) { return `t=${ts},v1=${crypto.createHmac('sha256', sigKey).update(`${ts}.${body}`).digest('hex')}`; }
  async function deliver(c, msg) {
    const target = targetOf(c);
    if (c.kind === 'email') {
      if (!messaging) return { ok: false, detail: 'no email provider' };
      const r = await messaging.sendEmail({ to: target, subject: msg.subject, text: msg.text });
      return { ok: !!r.ok, detail: r.transport };
    }
    if (c.kind === 'webhook') {
      const body = JSON.stringify({ type: msg.type, rule: msg.rule, status: msg.status, severity: msg.severity, title: msg.subject, text: msg.text, time: new Date(now()).toISOString(), ...(msg.code ? { code: msg.code } : {}) });
      const ts = Math.floor(now() / 1000);
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 10000);
      try {
        const r = await fetchImpl(target, { method: 'POST', headers: { 'content-type': 'application/json', 'x-parlance-signature': sign(body, ts), 'user-agent': 'parlance-alerts/1' }, body, redirect: 'error', signal: ac.signal });
        await r.arrayBuffer().catch(() => null);
        return { ok: r.status >= 200 && r.status < 300, detail: `HTTP ${r.status}` };
      } catch (e) { return { ok: false, detail: e.name === 'AbortError' ? 'timeout' : 'unreachable' }; } finally { clearTimeout(t); }
    }
    if (c.kind === 'push') {
      if (!webpush) return { ok: false, detail: 'push not available' };
      const n = webpush.enqueueUser(target, { title: msg.subject, body: msg.text.slice(0, 180), link: '/admin/system', pref: 'security' });
      return { ok: n > 0, detail: `${n} device(s)` };
    }
    return { ok: false, detail: 'unknown kind' };
  }
  // Test send: a fresh 6-digit code the admin types back to confirm the contact.
  async function testContact(id, actor) {
    const c = db.prepare('SELECT * FROM ops_alert_contacts WHERE id=? AND deleted_ts IS NULL').get(id);
    if (!c) return null;
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    db.prepare('UPDATE ops_alert_contacts SET code_hash=?, code_expires_ts=? WHERE id=?').run(kc.hmacHex(sigKey, `${id}:${code}`), now() + CODE_TTL_MS, id);
    const r = await deliver(c, { type: 'test', rule: 'test', status: 'test', severity: 'info', subject: T('alert.test.subject'), text: T('alert.test.body', { code }), code });
    db.prepare('UPDATE ops_alert_contacts SET last_test_ts=?, last_result=? WHERE id=?').run(now(), r.ok ? `delivered (${r.detail})` : `failed (${r.detail})`, id);
    db.prepare('INSERT INTO ops_alerts(id,rule,severity,status,started_ts,resolved_ts,last_sent_ts,sends,detail_json,test) VALUES(?,?,?,?,?,?,?,?,?,1)').run(newId('al_'), 'test', 'info', r.ok ? 'sent' : 'failed', now(), now(), now(), 1, JSON.stringify({ contact: id, actor }));
    return { contact: contactVo(db.prepare('SELECT * FROM ops_alert_contacts WHERE id=?').get(id)), delivered: r.ok, detail: r.detail };
  }
  function confirmContact(id, code) {
    const c = db.prepare('SELECT * FROM ops_alert_contacts WHERE id=? AND deleted_ts IS NULL').get(id);
    if (!c || !c.code_hash || c.code_expires_ts < now()) return { ok: false, reason: 'no_code' };
    if (!kc.safeEqual(kc.hmacHex(sigKey, `${id}:${String(code || '').trim()}`), c.code_hash)) return { ok: false, reason: 'wrong_code' };
    db.prepare('UPDATE ops_alert_contacts SET confirmed_ts=?, code_hash=NULL, code_expires_ts=NULL WHERE id=?').run(now(), id);
    return { ok: true, contact: contactVo(db.prepare('SELECT * FROM ops_alert_contacts WHERE id=?').get(id)) };
  }

  // ---------------------------------------------------------------- rules
  // signals: functions returning the inputs (backup status, drill, anchor, verifier results, http stats, jobs, disk).
  function evaluate() {
    const out = [];
    const t = now();
    const fire = (rule, firing, severity, detail) => out.push({ rule, firing: !!firing, severity, detail });
    try {
      const b = signals.backup ? signals.backup() : null;
      if (b && b.enabled) fire('backup_overdue', !b.last_backup || b.last_backup.age_sec > Number(S('backups.max_age_minutes', 60)) * 60, 'critical', b.last_backup ? { age_sec: b.last_backup.age_sec } : { last: null });
      const d = signals.drill ? signals.drill() : undefined;
      if (d !== undefined) fire('restore_drill_overdue', !d || t - d.finished_ts > Number(S('backups.drill_max_age_days', 30)) * 86400000, 'warning', d ? { age_days: Math.floor((t - d.finished_ts) / 86400000) } : { last: null });
      const a = signals.anchor ? signals.anchor() : undefined;
      if (a !== undefined) fire('anchor_overdue', !a || t - a.ts > 2 * Number(S('anchors.interval_minutes', 60)) * 60000, 'warning', a ? { age_min: Math.floor((t - a.ts) / 60000) } : { last: null });
      const v = signals.verifiers ? signals.verifiers() : null;
      if (v) fire('verifier_failure', !v.ok, 'critical', { failing: v.failing || [] });
      const h = signals.http ? signals.http() : null;
      if (h) fire('error_rate', h.total >= 20 && (100 * h.errors) / h.total > Number(S('alerts.error_rate_pct', 5)), 'critical', { errors: h.errors, total: h.total });
      const p99 = signals.orderP99 ? signals.orderP99() : null;
      if (p99 != null) fire('order_latency', p99 * 1000 > Number(S('alerts.order_p99_ms', 100)), 'warning', { p99_ms: Math.round(p99 * 1000) });
      const j = signals.jobs ? signals.jobs() : null;
      if (j) { const stale = j.filter((x) => x.age_sec > Number(S('alerts.job_stall_minutes', 10)) * 60); fire('job_stalled', stale.length > 0, 'critical', { jobs: stale.map((x) => x.name) }); }
      const disk = signals.disk ? signals.disk() : null;
      if (disk && disk.total) fire('disk_filling', (100 * disk.free) / disk.total < Number(S('alerts.disk_free_pct', 15)), 'critical', { free_pct: Math.round((1000 * disk.free) / disk.total) / 10 });
      const certFile = process.env.TLS_CERT_FILE;
      if (certFile) {
        try { const c = new crypto.X509Certificate(fs.readFileSync(certFile)); const days = (Date.parse(c.validTo) - t) / 86400000; fire('cert_expiry', days < Number(S('alerts.cert_expiry_days', 14)), 'critical', { days_left: Math.floor(days) }); } catch (e) { fire('cert_expiry', true, 'critical', { error: 'certificate unreadable' }); }
      }
    } catch (e) { if (logger) logger.error('alert evaluation failed', { error: e.message }); }
    return out;
  }
  async function run() {
    const results = evaluate();
    const confirmed = contacts().filter((c) => c.confirmed_ts);
    const sends = [];
    for (const r of results) {
      const open = db.prepare("SELECT * FROM ops_alerts WHERE rule=? AND status='firing' AND test=0 ORDER BY started_ts DESC LIMIT 1").get(r.rule);
      let msg = null;
      if (r.firing && !open) {
        const id = newId('al_');
        db.prepare("INSERT INTO ops_alerts(id,rule,severity,status,started_ts,detail_json) VALUES(?,?,?,'firing',?,?)").run(id, r.rule, r.severity, now(), JSON.stringify(r.detail || {}));
        msg = { id, status: 'firing' };
        if (logger) logger.warn('alert firing', { rule: r.rule, detail: r.detail });
      } else if (r.firing && open && now() - (open.last_sent_ts || 0) >= Number(S('alerts.repeat_minutes', 60)) * 60000) msg = { id: open.id, status: 'firing' };
      else if (!r.firing && open) {
        db.prepare("UPDATE ops_alerts SET status='resolved', resolved_ts=? WHERE id=?").run(now(), open.id);
        msg = { id: open.id, status: 'resolved' };
        if (logger) logger.info('alert resolved', { rule: r.rule });
      }
      if (!msg) continue;
      const subject = T(`alert.${msg.status}.subject`, { rule: T(`alert.rule.${r.rule}`) });
      const body = T(`alert.${msg.status}.body`, { rule: T(`alert.rule.${r.rule}`), detail: JSON.stringify(r.detail || {}), time: new Date(now()).toISOString() });
      for (const c of confirmed) sends.push(deliver(c, { type: 'alert', rule: r.rule, status: msg.status, severity: r.severity, subject, text: body }).then((x) => x, () => ({ ok: false })));
      db.prepare('UPDATE ops_alerts SET last_sent_ts=?, sends=sends+? WHERE id=?').run(now(), confirmed.length, msg.id);
    }
    await Promise.all(sends);
    return results;
  }
  let timer = null;
  const start = (everyMs = 30000, onRun = () => {}) => { if (timer) return; timer = setInterval(() => { run().then(() => onRun(true), (e) => onRun(false, e)); }, everyMs); timer.unref(); };
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  const firing = () => db.prepare("SELECT * FROM ops_alerts WHERE status='firing' AND test=0 ORDER BY started_ts DESC").all().map((a) => ({ id: a.id, rule: a.rule, severity: a.severity, started_time: new Date(a.started_ts).toISOString(), detail: JSON.parse(a.detail_json || '{}') }));
  const history = (limit = 50) => db.prepare('SELECT * FROM ops_alerts ORDER BY started_ts DESC LIMIT ?').all(limit).map((a) => ({ id: a.id, rule: a.rule, severity: a.severity, status: a.status, test: !!a.test, started_time: new Date(a.started_ts).toISOString(), resolved_time: a.resolved_ts ? new Date(a.resolved_ts).toISOString() : null, sends: a.sends }));
  return { RULES, addContact, removeContact, contacts: () => contacts().map(contactVo), testContact, confirmContact, evaluate, run, start, stop, firing, history, sign };
}

module.exports = { createAlerts, RULES };
