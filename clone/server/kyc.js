'use strict';
// Identity verification (KYC) through a provider interface (PLAN P3.5; CLONE_SPEC §13.14 "Verifying info…", §13.15
// document verification; CLONE_SPEC.md §25.5).
//
// Two stages, each an asynchronous job ("Verifying info…" on screen while it runs):
//   1. data       — after the address step: our own rules (duplicate national ID, age, blocked residence) and the
//                   provider's data check. Pass → `documents_required` (document verification, §13.15).
//   2. documents  — after the ID front, back and selfie are uploaded (server/docv.js): the provider's document and
//                   selfie check. Outcome → approved / review (manual) / rejected / retry.
// Provider interface:  { name, verifyData(applicant), verifyDocuments(applicant, docsMeta) } → Promise<{ decision:
//   'approved'|'review'|'rejected'|'retry', reason_category?, reference? }>; it may throw for an outage (the job is retried
//   with backoff, then the user is asked to retry).
// Sandbox adapter (non-production; deterministic by invented test data, never real people):
//   legal last name "Retry"  → data stage asks for another try (data_mismatch)
//   legal last name "Outage" → data stage provider outage (retried, then retry / provider_unavailable)
//   legal last name "Review" → documents stage: manual review queue
//   legal last name "Reject" → documents stage: rejected (identity_mismatch)
//   anything else            → approved after documents
// Jobs are rows in `kyc_jobs`, processed by an in-process worker; a restart resumes queued and interrupted jobs.
// Without a provider in production, both stages go to the manual review queue.
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
  const ref = () => `sbx_${Math.random().toString(36).slice(2, 12)}`;
  const last = (a) => String(a.last_name || '').trim().toLowerCase();
  return {
    name: 'sandbox',
    async verifyData(a) {
      if (last(a) === 'outage') throw new Error('sandbox provider outage');
      if (last(a) === 'retry') return { decision: 'retry', reason_category: 'data_mismatch', reference: ref() };
      return { decision: 'approved', reference: ref() };
    },
    async verifyDocuments(a, docs) {
      const kinds = new Set(docs.map((d) => d.kind));
      if (!kinds.has('id_front') || !kinds.has('id_back') || !kinds.has('selfie')) return { decision: 'retry', reason_category: 'documents_unreadable', reference: ref() };
      if (last(a) === 'review') return { decision: 'review', reason_category: 'manual_review', reference: ref() };
      if (last(a) === 'reject') return { decision: 'rejected', reason_category: 'identity_mismatch', reference: ref() };
      return { decision: 'approved', reference: ref() };
    },
  };
}

const ADMIN_REASONS = ['identity_mismatch', 'duplicate_account', 'unsupported_region', 'fraud_suspected', 'age_requirement', 'data_mismatch', 'documents_unreadable', 'other'];

function createKyc(ctx) {
  const { db, profile, setProfile, open, logEvent, audit, can, notify, settings, sandbox, REASONS, auth, opt } = ctx;
  db.exec(SCHEMA);
  const jc = new Set(db.prepare('PRAGMA table_info(kyc_jobs)').all().map((c) => c.name));
  if (!jc.has('stage')) db.exec("ALTER TABLE kyc_jobs ADD COLUMN stage TEXT NOT NULL DEFAULT 'data'");
  const ko = ctx.options.kyc || {};
  const provider = ko.provider || (sandbox ? sandboxProvider() : null);
  const delayMs = ko.delayMs ?? 1500; // simulated provider latency: the "Verifying info…" screen is visible
  const pollMs = ko.pollMs ?? 400;
  const maxJobAttempts = 3;
  let timer = null; let running = false;
  let docv = null; // server/docv.js (set by identity.js once mounted)

  const record = (uid, source, decision, reason, actor = null, note = '') => db.prepare('INSERT INTO kyc_decisions(id,user_id,ts,source,decision,reason_category,actor_id,note) VALUES(?,?,?,?,?,?,?,?)')
    .run(newId('kd_'), uid, Date.now(), source, decision, reason || null, actor, note);

  function enqueue(uid, stage) {
    db.prepare("UPDATE kyc_jobs SET status='superseded' WHERE user_id=? AND status IN ('queued','running')").run(uid);
    db.prepare('INSERT INTO kyc_jobs(id,user_id,provider,status,run_after,created_ts,stage) VALUES(?,?,?,?,?,?,?)').run(newId('kj_'), uid, provider ? provider.name : 'manual', 'queued', Date.now() + delayMs, Date.now(), stage);
  }
  // Stage 1: the details from onboarding (§13.14).
  function submit(uid, req) {
    const p = profile(uid);
    setProfile(uid, { status: 'pending', kyc_stage: 'data', submitted_at: nowIso(), decided_at: null, kyc_reason: null, kyc_attempts: (p.kyc_attempts || 0) + 1, skipped_at: null });
    enqueue(uid, 'data');
    logEvent(uid, 'identity_submitted', req, { attempt: (p.kyc_attempts || 0) + 1, stage: 'data' });
  }
  // Stage 2: the documents from the phone or this device (§13.15).
  function submitDocuments(uid, req) {
    setProfile(uid, { status: 'pending', kyc_stage: 'documents', decided_at: null, kyc_reason: null, skipped_at: null });
    enqueue(uid, 'documents');
    logEvent(uid, 'identity_submitted', req, { stage: 'documents' });
  }

  const STATUS_OF = { approved: 'approved', review: 'review', rejected: 'rejected', retry: 'retry', documents: 'documents_required' };
  const TITLES = {
    approved: ['You’re verified', 'Your identity is verified. You can now deposit and trade.'],
    review: ['We’re reviewing your details', 'Our team will finish verifying your identity, usually within 1–2 business days.'],
    rejected: ['We couldn’t verify your identity', 'Open the identity page for details.'],
    retry: ['Check your details', 'We couldn’t verify your identity with the details you entered. Check them and try again.'],
  };
  // decision: approved | review | rejected | retry | documents (data stage passed → document verification next).
  function apply(uid, decision, reason, { source = 'provider', actor = null, note = '', by = null } = {}) {
    const p = profile(uid);
    let d = decision;
    let r = reason || null;
    if (d === 'retry' && (p.kyc_attempts || 0) >= opt.maxKycAttempts) { d = 'review'; r = 'manual_review'; } // out of retries: a human looks
    setProfile(uid, { status: STATUS_OF[d], kyc_stage: d === 'documents' ? 'documents' : p.kyc_stage, kyc_reason: d === 'approved' || d === 'documents' ? null : r,
      decided_at: d === 'review' || d === 'documents' ? null : nowIso(), decided_by: by });
    record(uid, source, d, r, actor, note);
    // Retention (P3.1a): document images are erased once a final decision exists, or when the user must start over.
    if (docv && ['approved', 'rejected', 'retry'].includes(d)) docv.eraseDocuments(uid, `decision:${d}`);
    if (d !== 'documents') {
      const [title, body] = TITLES[d];
      try { notify(uid, { type: 'identity', title, body: d === 'rejected' || d === 'retry' ? (REASONS[r] || body) : body, link: '/sign-up/identity' }); } catch { /* notification failure must not undo the decision */ }
    }
    logEvent(uid, `identity_${d === 'documents' ? 'documents_required' : d}`, null, { source, reason: r });
  }

  // Our own rules first, then the provider. The decrypted applicant only lives in memory for this call.
  function applicantOf(uid, p) {
    const name = open(uid, 'name', p.name_enc) || {};
    return { first_name: name.first, last_name: name.last, dob: open(uid, 'dob', p.dob_enc), address: open(uid, 'address', p.address_enc), national_id: open(uid, 'national_id', p.national_id_enc), country: p.country };
  }
  async function evaluate(job) {
    const uid = job.user_id;
    const p = profile(uid);
    if (!p || p.status !== 'pending' || (p.kyc_stage || 'data') !== job.stage) return { skip: true };
    if (job.stage === 'documents') {
      if (!provider) return { decision: 'review', reason_category: 'manual_review', note: 'no identity provider configured' };
      return provider.verifyDocuments(applicantOf(uid, p), docv ? docv.documentsMeta(uid) : []);
    }
    if (p.national_id_hash) {
      const dup = db.prepare("SELECT status FROM identity_profiles WHERE national_id_hash=? AND user_id<>? AND status IN ('approved','review','pending','documents_required') LIMIT 1").get(p.national_id_hash, uid);
      if (dup) return { decision: 'rejected', reason_category: 'duplicate_account' };
      if (db.prepare("SELECT 1 FROM identity_profiles WHERE national_id_hash=? AND user_id<>? AND status='closed' LIMIT 1").get(p.national_id_hash, uid)) return { decision: 'review', reason_category: 'manual_review', note: 'national ID matches a closed account' };
    }
    if (!p.age_verified) return { decision: 'rejected', reason_category: 'age_requirement' };
    if ((settings().blocked_countries || []).includes(p.country)) return { decision: 'rejected', reason_category: 'unsupported_region' };
    if (!provider) return { decision: 'documents' };
    const r = await provider.verifyData(applicantOf(uid, p));
    return r.decision === 'approved' ? { ...r, decision: 'documents' } : r;
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
          const cur = profile(job.user_id);
          if (cur?.status === 'pending' && (cur.kyc_stage || 'data') === job.stage) apply(job.user_id, r.decision, r.reason_category, { note: r.note || '' });
        } catch (e) {
          const attempts = job.attempts + 1;
          if (attempts >= maxJobAttempts) {
            db.prepare("UPDATE kyc_jobs SET status='failed', finished_ts=?, error=? WHERE id=?").run(Date.now(), 'provider error', job.id);
            if (profile(job.user_id)?.status === 'pending') apply(job.user_id, 'retry', 'provider_unavailable');
          } else {
            db.prepare("UPDATE kyc_jobs SET status='queued', run_after=?, error=? WHERE id=?").run(Date.now() + 500 * 2 ** attempts, 'provider error', job.id);
          }
          if (!ctx.options.quietProvider) console.error('kyc: provider call failed (job retried):', e.message); // never the applicant's data
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
    // Review queue: masked personal data only (unmasking and document views are separate, audited calls).
    v1.get('/admin/kyc/queue', can('users.read'), (req, res) => {
      const status = String(req.query.status || 'review');
      const allowed = ['review', 'pending', 'documents_required', 'retry', 'rejected', 'approved', 'all'];
      if (!allowed.includes(status)) throw E.badRequest(`status must be one of ${allowed.join(', ')}`);
      const rows = db.prepare(`SELECT p.user_id, p.status, p.kyc_stage, p.kyc_reason, p.kyc_attempts, p.submitted_at, p.decided_at, p.country, p.national_id_hash, u.email, u.display_name
        FROM identity_profiles p JOIN users u ON u.id=p.user_id WHERE p.status NOT IN ('closed','not_started','in_progress') ${status === 'all' ? '' : 'AND p.status=?'} ORDER BY COALESCE(p.submitted_at, p.updated_at) DESC LIMIT 500`)
        .all(...(status === 'all' ? [] : [status]));
      const counts = Object.fromEntries(db.prepare("SELECT status, COUNT(*) c FROM identity_profiles WHERE status<>'closed' GROUP BY status").all().map((r) => [r.status, r.c]));
      res.json({ counts, items: rows.map((r) => {
        const pr = profile(r.user_id);
        const n = open(r.user_id, 'name', pr.name_enc);
        return { user_id: r.user_id, email: r.email, display_name: r.display_name, status: r.status, stage: r.kyc_stage, reason_category: r.kyc_reason, attempts: r.kyc_attempts, submitted_time: r.submitted_at, decided_time: r.decided_at,
          country: r.country, legal_name: n ? ctx.mask.name(n) : null, national_id: pr.national_id_last ? ctx.mask.nationalId(pr.national_id_last, pr.national_id_type) : null,
          duplicate_national_id: !!(r.national_id_hash && db.prepare('SELECT 1 FROM identity_profiles WHERE national_id_hash=? AND user_id<>? LIMIT 1').get(r.national_id_hash, r.user_id)),
          documents: docv ? docv.documentsMeta(r.user_id).length : 0,
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
    submit, submitDocuments, mountRoutes, historyOf, purge, apply, provider: () => provider, attachDocv: (d) => { docv = d; },
    start: () => { if (!timer) { timer = setInterval(() => { tick(); }, pollMs); timer.unref?.(); } },
    stop: () => { clearInterval(timer); timer = null; },
    tick,
  };
}

module.exports = { createKyc, sandboxProvider };
