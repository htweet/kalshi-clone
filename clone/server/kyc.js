'use strict';
// Identity verification (KYC) through a provider interface (PLAN P3.5; CLONE_SPEC §13.14 "Verifying info…", spec §25).
//
// Provider interface:  { name, verify(applicant) → Promise<{ decision: 'approved'|'review'|'rejected'|'retry',
//                        reason_category?, reference? }> }  — it may throw for an outage (the job is retried with backoff).
// Sandbox adapter (non-production, deterministic by test data — invented values only):
//   legal last name "Review" → manual review · "Reject" → rejected (identity_mismatch) · "Retry" → retry (data_mismatch)
//   "Outage" → provider error (retried, then retry/provider_unavailable) · anything else → approved.
// Before the provider is asked, our own rules run: duplicate national ID (keyed hash) on another open account →
// rejected (duplicate_account); a match with a closed account's retained fingerprint → manual review; residence in a
// blocked region → rejected (unsupported_region).
// Jobs are rows in `kyc_jobs`, processed by an in-process worker; a restart resumes queued and interrupted jobs.
// Without a provider in production, submissions go to the manual review queue.
const { nowIso, newId, ApiError, E } = require('./util');
const { check } = require('./validate');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kyc_jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  run_after INTEGER NOT NULL, created_ts INTEGER NOT NULL, finished_ts INTEGER, decision TEXT, reason_category TEXT, reference TEXT, error TEXT);
CREATE INDEX IF NOT EXISTS idx_kyc_jobs_due ON kyc_jobs(status, run_after);
CREATE TABLE IF NOT EXISTS kyc_decisions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ts INTEGER NOT NULL, source TEXT NOT NULL, decision TEXT NOT NULL, reason_category TEXT, actor_id TEXT, note TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_kyc_decisions_user ON kyc_decisions(user_id, ts);
`;

function sandboxProvider() {
  return {
    name: 'sandbox',
    async verify(a) {
      const last = String(a.last_name || '').trim().toLowerCase();
      const reference = `sbx_${Math.random().toString(36).slice(2, 12)}`;
      if (last === 'outage') throw new Error('sandbox provider outage');
      if (last === 'review') return { decision: 'review', reason_category: 'manual_review', reference };
      if (last === 'reject') return { decision: 'rejected', reason_category: 'identity_mismatch', reference };
      if (last === 'retry') return { decision: 'retry', reason_category: 'data_mismatch', reference };
      return { decision: 'approved', reference };
    },
  };
}

const ADMIN_REASONS = ['identity_mismatch', 'duplicate_account', 'unsupported_region', 'fraud_suspected', 'age_requirement', 'data_mismatch', 'other'];

function createKyc(ctx) {
  const { db, profile, setProfile, open, logEvent, audit, can, notify, settings, sandbox, REASONS, auth, opt } = ctx;
  db.exec(SCHEMA);
  const ko = ctx.options.kyc || {};
  const provider = ko.provider || (sandbox ? sandboxProvider() : null);
  const delayMs = ko.delayMs ?? 1500; // simulated provider latency: the "Verifying info…" screen is visible
  const pollMs = ko.pollMs ?? 400;
  const maxJobAttempts = 3;
  let timer = null; let running = false;

  const record = (uid, source, decision, reason, actor = null, note = '') => db.prepare('INSERT INTO kyc_decisions(id,user_id,ts,source,decision,reason_category,actor_id,note) VALUES(?,?,?,?,?,?,?,?)')
    .run(newId('kd_'), uid, Date.now(), source, decision, reason || null, actor, note);

  function submit(uid, req) {
    const p = profile(uid);
    db.prepare("UPDATE kyc_jobs SET status='superseded' WHERE user_id=? AND status IN ('queued','running')").run(uid);
    setProfile(uid, { status: 'pending', submitted_at: nowIso(), decided_at: null, kyc_reason: null, kyc_attempts: (p.kyc_attempts || 0) + 1, skipped_at: null });
    db.prepare('INSERT INTO kyc_jobs(id,user_id,provider,status,run_after,created_ts) VALUES(?,?,?,?,?,?)').run(newId('kj_'), uid, provider ? provider.name : 'manual', 'queued', Date.now() + delayMs, Date.now());
    logEvent(uid, 'identity_submitted', req, { attempt: (p.kyc_attempts || 0) + 1 });
  }

  const STATUS_OF = { approved: 'approved', review: 'review', rejected: 'rejected', retry: 'retry' };
  const TITLES = {
    approved: ['You’re verified', 'Your identity is verified. You can now deposit and trade.'],
    review: ['We’re reviewing your details', 'Our team will finish verifying your identity, usually within 1–2 business days.'],
    rejected: ['We couldn’t verify your identity', 'Open the identity page for details.'],
    retry: ['Check your details', 'We couldn’t verify your identity with the details you entered. Check them and try again.'],
  };
  function apply(uid, decision, reason, { source = 'provider', actor = null, note = '', by = null } = {}) {
    const p = profile(uid);
    let d = decision;
    let r = reason || null;
    if (d === 'retry' && (p.kyc_attempts || 0) >= opt.maxKycAttempts) { d = 'review'; r = 'manual_review'; } // out of retries: a human looks
    setProfile(uid, { status: STATUS_OF[d], kyc_reason: d === 'approved' ? null : r, decided_at: d === 'review' ? null : nowIso(), decided_by: by });
    record(uid, source, d, r, actor, note);
    const [title, body] = TITLES[d];
    try { notify(uid, { type: 'identity', title, body: d === 'rejected' || d === 'retry' ? (REASONS[r] || body) : body, link: '/sign-up/identity' }); } catch { /* notification failure must not undo the decision */ }
    logEvent(uid, `identity_${d}`, null, { source, reason: r });
  }

  // Our own rules first, then the provider. The decrypted applicant only lives in memory for this call.
  async function evaluate(job) {
    const uid = job.user_id;
    const p = profile(uid);
    if (!p || p.status !== 'pending') return { skip: true };
    if (p.national_id_hash) {
      const dup = db.prepare("SELECT status FROM identity_profiles WHERE national_id_hash=? AND user_id<>? AND status<>'closed' AND status IN ('approved','review','pending') LIMIT 1").get(p.national_id_hash, uid);
      if (dup) return { decision: 'rejected', reason_category: 'duplicate_account' };
      if (db.prepare("SELECT 1 FROM identity_profiles WHERE national_id_hash=? AND user_id<>? AND status='closed' LIMIT 1").get(p.national_id_hash, uid)) return { decision: 'review', reason_category: 'manual_review', note: 'national ID matches a closed account' };
    }
    if (!p.age_verified) return { decision: 'rejected', reason_category: 'age_requirement' };
    if ((settings().blocked_countries || []).includes(p.country)) return { decision: 'rejected', reason_category: 'unsupported_region' };
    if (!provider) return { decision: 'review', reason_category: 'manual_review', note: 'no identity provider configured' };
    const name = open(uid, 'name', p.name_enc) || {};
    const applicant = { first_name: name.first, last_name: name.last, dob: open(uid, 'dob', p.dob_enc), address: open(uid, 'address', p.address_enc), national_id: open(uid, 'national_id', p.national_id_enc), country: p.country };
    return provider.verify(applicant);
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      // Jobs left "running" by a crash are picked up again.
      db.prepare("UPDATE kyc_jobs SET status='queued' WHERE status='running' AND run_after<?").run(Date.now() - 60000);
      const due = db.prepare("SELECT * FROM kyc_jobs WHERE status='queued' AND run_after<=? ORDER BY run_after LIMIT 5").all(Date.now());
      for (const job of due) {
        db.prepare("UPDATE kyc_jobs SET status='running', attempts=attempts+1, run_after=? WHERE id=?").run(Date.now(), job.id);
        try {
          const r = await evaluate(job);
          if (r.skip) { db.prepare("UPDATE kyc_jobs SET status='superseded', finished_ts=? WHERE id=?").run(Date.now(), job.id); continue; }
          db.prepare("UPDATE kyc_jobs SET status='done', finished_ts=?, decision=?, reason_category=?, reference=? WHERE id=?").run(Date.now(), r.decision, r.reason_category || null, r.reference || null, job.id);
          if (profile(job.user_id)?.status === 'pending') apply(job.user_id, r.decision, r.reason_category, { note: r.note || '' });
        } catch (e) {
          const attempts = job.attempts + 1;
          if (attempts >= maxJobAttempts) {
            db.prepare("UPDATE kyc_jobs SET status='failed', finished_ts=?, error=? WHERE id=?").run(Date.now(), 'provider error', job.id);
            if (profile(job.user_id)?.status === 'pending') apply(job.user_id, 'retry', 'provider_unavailable');
          } else {
            db.prepare("UPDATE kyc_jobs SET status='queued', run_after=?, error=? WHERE id=?").run(Date.now() + 500 * 2 ** attempts, 'provider error', job.id);
          }
          console.error('kyc: provider call failed (job retried):', e.message);
        }
      }
    } catch (e) {
      if (!/not open|closed/i.test(e.message)) console.error('kyc worker', e.message);
    } finally { running = false; }
  }

  function historyOf(uid) {
    return db.prepare('SELECT d.*, u.email actor_email FROM kyc_decisions d LEFT JOIN users u ON u.id=d.actor_id WHERE d.user_id=? ORDER BY d.ts DESC LIMIT 50').all(uid)
      .map((d) => ({ time: new Date(d.ts).toISOString(), source: d.source, decision: d.decision, reason_category: d.reason_category, actor: d.actor_email || null, note: d.note }));
  }

  function mountRoutes(v1) {
    // Review queue: masked personal data only (unmasking is a separate, audited call in server/identity.js).
    v1.get('/admin/kyc/queue', can('users.read'), (req, res) => {
      const status = String(req.query.status || 'review');
      const allowed = ['review', 'pending', 'retry', 'rejected', 'approved', 'all'];
      if (!allowed.includes(status)) throw E.badRequest(`status must be one of ${allowed.join(', ')}`);
      const rows = db.prepare(`SELECT p.user_id, p.status, p.kyc_reason, p.kyc_attempts, p.submitted_at, p.decided_at, p.country, p.national_id_hash, u.email, u.display_name
        FROM identity_profiles p JOIN users u ON u.id=p.user_id WHERE p.status<>'closed' AND p.status<>'not_started' ${status === 'all' ? '' : 'AND p.status=?'} ORDER BY COALESCE(p.submitted_at, p.updated_at) DESC LIMIT 500`)
        .all(...(status === 'all' ? [] : [status]));
      const counts = Object.fromEntries(db.prepare("SELECT status, COUNT(*) c FROM identity_profiles WHERE status<>'closed' GROUP BY status").all().map((r) => [r.status, r.c]));
      res.json({ counts, items: rows.map((r) => {
        const pr = profile(r.user_id);
        const n = open(r.user_id, 'name', pr.name_enc);
        return { user_id: r.user_id, email: r.email, display_name: r.display_name, status: r.status, reason_category: r.kyc_reason, attempts: r.kyc_attempts, submitted_time: r.submitted_at, decided_time: r.decided_at,
          country: r.country, legal_name: n ? `${n.first[0]}*** ${n.last[0]}***` : null, national_id: pr.national_id_last ? `${pr.national_id_type === 'ssn' ? '•••-••-' : '•••• '}${pr.national_id_last}` : null,
          duplicate_national_id: !!(r.national_id_hash && db.prepare('SELECT 1 FROM identity_profiles WHERE national_id_hash=? AND user_id<>? LIMIT 1').get(r.national_id_hash, r.user_id)),
          risk_score: ctx.compliance.riskSummary(r.user_id).latest_score };
      }) });
    });
    v1.post('/admin/kyc/:userId/decision', can('users.support'), (req, res) => {
      const b = check(req.body, { decision: { type: 'string', enum: ['approve', 'reject', 'retry'], required: true }, reason_category: { type: 'string', enum: ADMIN_REASONS, nullable: true }, note: { type: 'string', maxLen: 500 } }, { unknown: 'reject' });
      const u = db.prepare('SELECT * FROM users WHERE id=? OR email=?').get(String(req.params.userId), String(req.params.userId).toLowerCase());
      const p = u && profile(u.id);
      if (!u || !p || ['not_started', 'in_progress', 'closed'].includes(p.status)) throw E.notFound();
      if (u.id === req.auth.user.id) throw E.conflict('cannot_decide_self', 'you cannot decide your own identity verification');
      if (b.decision !== 'approve' && !b.reason_category) throw new ApiError(400, 'validation_failed', 'validation failed', 'reason_category: required when rejecting or asking for a retry');
      auth.assertFresh(req, 'kyc_decision');
      const decision = { approve: 'approved', reject: 'rejected', retry: 'retry' }[b.decision];
      const before = { status: p.status, reason_category: p.kyc_reason };
      db.prepare("UPDATE kyc_jobs SET status='superseded' WHERE user_id=? AND status IN ('queued','running')").run(u.id);
      apply(u.id, decision, decision === 'approved' ? null : b.reason_category, { source: 'admin', actor: req.auth.user.id, note: String(b.note || '').trim(), by: req.auth.user.id });
      const after = { status: profile(u.id).status, reason_category: profile(u.id).kyc_reason };
      audit(req, `kyc.${b.decision}`, u.id, before, after, String(b.note || '').trim() || b.reason_category || 'approved');
      res.json({ user_id: u.id, status: after.status, reason_category: after.reason_category });
    });
  }

  function purge() { db.prepare("DELETE FROM kyc_jobs WHERE status IN ('done','failed','superseded') AND created_ts<?").run(Date.now() - 90 * 86400000); }

  return {
    submit, mountRoutes, historyOf, purge, apply, provider: () => provider,
    start: () => { if (!timer) { timer = setInterval(() => { tick(); }, pollMs); timer.unref?.(); } },
    stop: () => { clearInterval(timer); timer = null; },
    tick,
  };
}

module.exports = { createKyc, sandboxProvider };
