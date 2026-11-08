'use strict';
// Referral programs (PLAN P6.3; reusable by Phase 8 P8.1, CLONE_SPEC.md §34.8). A program is a key ('perps' today)
// with settings in admin_settings (`referrals:<program>`) and a payout callback supplied by the module that owns the
// product (server/perps-ops.js pays into Perps collateral through the promotions treasury). The module owns codes,
// referrals, qualification, rewards and fraud checks; it never moves money itself.
//
//   codes      one per user per program; 10 characters from a 32-symbol alphabet (no 0/O/1/I), drawn with the crypto
//              RNG (50 bits): not guessable, and applying codes is rate limited per user
//   apply      the referee adds a code: not their own, once per program, only within `signup_window_days` of signing up
//              and before they qualify by themselves (the program's `eligible` hook, e.g. no Perps trade yet)
//   progress   the product reports the referee's activity (cents; never activity against the referrer); at `threshold_cents` the referral qualifies and both
//              sides are rewarded (referee bonus, referrer reward), the referrer within the lifetime caps
//   expiry     a referral not qualified within `expiry_days` expires (the job, and lazily)
// Statuses: referral pending → rewarded | expired | void (production switch); reward paid | queued | refused | capped.
// Phase 8 (P8.1, CLONE_SPEC.md §38.2): a program may supply `review(referral)` → fraud signals. A qualifying referral with
// signals is held (`review`) in the admin review queue (referral_reviews) instead of being paid; approve pays both sides
// (`rewarded`), reject closes it (`rejected`, nothing paid). Referrals record how they were attributed (`source`: code,
// link, waitlist) and a keyed hash of the referee's IP at attribution (`ip_hash`) for the IP-velocity signal.
const crypto = require('node:crypto');
const { tx } = require('./db');
const { newId } = require('./util');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS referral_codes (code TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, program TEXT NOT NULL, created_ts INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_codes_user ON referral_codes(user_id, program);
CREATE TABLE IF NOT EXISTS referrals (id TEXT PRIMARY KEY, program TEXT NOT NULL, code TEXT NOT NULL, referrer_id TEXT NOT NULL, referee_id TEXT NOT NULL, status TEXT NOT NULL,
  progress_cents INTEGER NOT NULL DEFAULT 0, threshold_cents INTEGER NOT NULL, reward_referrer_cents INTEGER NOT NULL, reward_referee_cents INTEGER NOT NULL,
  created_ts INTEGER NOT NULL, expires_ts INTEGER NOT NULL, qualified_ts INTEGER, epoch TEXT NOT NULL DEFAULT '');
CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_referee ON referrals(program, referee_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(program, referrer_id, status);
CREATE TABLE IF NOT EXISTS referral_rewards (id TEXT PRIMARY KEY, referral_id TEXT NOT NULL, program TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL, detail TEXT, created_ts INTEGER NOT NULL, epoch TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_referral_rewards_user ON referral_rewards(program, user_id);
CREATE TABLE IF NOT EXISTS referral_reviews (id TEXT PRIMARY KEY, referral_id TEXT NOT NULL, program TEXT NOT NULL, status TEXT NOT NULL, signals_json TEXT NOT NULL DEFAULT '[]',
  created_ts INTEGER NOT NULL, decided_by TEXT, decided_ts INTEGER, note TEXT);
CREATE INDEX IF NOT EXISTS idx_referral_reviews_status ON referral_reviews(program, status, created_ts);
`;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DAY = 86400000;
const BASE_DEFAULTS = { enabled: true, reward_referrer_cents: 1000, reward_referee_cents: 500, threshold_cents: 10000, expiry_days: 30, signup_window_days: 30, lifetime_cap_count: 20, lifetime_cap_cents: 20000 };
const SPEC = {
  enabled: { type: 'boolean' }, reward_referrer_cents: { type: 'integer', min: 0, max: 10000000 }, reward_referee_cents: { type: 'integer', min: 0, max: 10000000 },
  threshold_cents: { type: 'integer', min: 1, max: 1000000000 }, expiry_days: { type: 'integer', min: 1, max: 365 }, signup_window_days: { type: 'integer', min: 1, max: 3650 },
  lifetime_cap_count: { type: 'integer', min: 0, max: 100000 }, lifetime_cap_cents: { type: 'integer', min: 0, max: 1000000000 },
};
const newCode = (len = 10) => [...crypto.randomBytes(len)].map((b) => ALPHABET[b % 32]).join(''); // 256 = 8 x 32: unbiased

class ReferralError extends Error { constructor(code, status = 409) { super(code); this.code = code; this.status = status; } }

function createReferrals({ db, now = () => Date.now(), epoch = () => '' }) {
  db.exec(SCHEMA);
  { const have = new Set(db.prepare('PRAGMA table_info(referrals)').all().map((c) => c.name)); // Phase 8 columns, additive
    if (!have.has('source')) db.exec("ALTER TABLE referrals ADD COLUMN source TEXT NOT NULL DEFAULT 'code'");
    if (!have.has('ip_hash')) db.exec('ALTER TABLE referrals ADD COLUMN ip_hash TEXT'); }
  const programs = new Map(); // key -> { defaults, payout, eligible, notify }
  const register = (key, def) => programs.set(key, { ...def, defaults: { ...BASE_DEFAULTS, ...(def.defaults || {}) } });
  const prog = (key) => { const p = programs.get(key); if (!p) throw new Error(`unknown referral program ${key}`); return p; };
  function settings(key) {
    const r = db.prepare('SELECT value FROM admin_settings WHERE key=?').get(`referrals:${key}`);
    return { ...prog(key).defaults, ...(r ? JSON.parse(r.value) : {}) };
  }
  function codeFor(uid, key) {
    const have = db.prepare('SELECT code FROM referral_codes WHERE user_id=? AND program=?').get(uid, key);
    if (have) return have.code;
    for (let i = 0; i < 8; i++) {
      const code = newCode();
      const r = db.prepare('INSERT INTO referral_codes(code,user_id,program,created_ts) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(code, uid, key, now());
      if (r.changes) return code;
      const again = db.prepare('SELECT code FROM referral_codes WHERE user_id=? AND program=?').get(uid, key);
      if (again) return again.code;
    }
    throw new Error('could not allocate a referral code');
  }
  // In-process rate limit on applying codes (stops code guessing): 5 attempts per user per minute.
  const attempts = new Map();
  function limited(uid) {
    const t = now(); const list = (attempts.get(uid) || []).filter((x) => t - x < 60000);
    if (list.length >= 5) { attempts.set(uid, list); return true; }
    list.push(t); attempts.set(uid, list); return false;
  }
  function expire(key = null) {
    const t = now();
    return db.prepare(`UPDATE referrals SET status='expired' WHERE status='pending' AND expires_ts<=?${key ? ' AND program=?' : ''}`).run(...(key ? [t, key] : [t])).changes;
  }
  function apply(uid, raw, key, { source = 'code', ipHash = null, skipLimit = false } = {}) {
    const s = settings(key); const p = prog(key);
    if (!s.enabled) throw new ReferralError('referral_program_off');
    if (!skipLimit && limited(uid)) throw new ReferralError('referral_rate_limited', 429);
    const code = String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const owner = code.length >= 6 && code.length <= 16 ? db.prepare('SELECT * FROM referral_codes WHERE code=? AND program=?').get(code, key) : null;
    if (!owner) throw new ReferralError('referral_code_invalid', 400);
    if (owner.user_id === uid) throw new ReferralError('referral_self');
    return tx(db, () => {
      if (db.prepare('SELECT 1 FROM referrals WHERE program=? AND referee_id=?').get(key, uid)) throw new ReferralError('referral_already_used');
      const u = db.prepare('SELECT created_at FROM users WHERE id=?').get(uid);
      const age = u ? now() - Date.parse(u.created_at) : Infinity;
      if (!(age <= s.signup_window_days * DAY) || (p.eligible && !p.eligible(uid))) throw new ReferralError('referral_too_late');
      const id = newId('ref_');
      db.prepare('INSERT INTO referrals(id,program,code,referrer_id,referee_id,status,threshold_cents,reward_referrer_cents,reward_referee_cents,created_ts,expires_ts,epoch,source,ip_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, key, code, owner.user_id, uid, 'pending', s.threshold_cents, s.reward_referrer_cents, s.reward_referee_cents, now(), now() + s.expiry_days * DAY, epoch(), ['code', 'link', 'waitlist'].includes(source) ? source : 'code', ipHash);
      return db.prepare('SELECT * FROM referrals WHERE id=?').get(id);
    });
  }
  const earned = (uid, key) => db.prepare("SELECT COALESCE(SUM(amount_cents),0) c, COUNT(*) n FROM referral_rewards WHERE program=? AND user_id=? AND role='referrer' AND status IN ('paid','queued')").get(key, uid);
  // The product reports activity of a referee; returns the rewards made (to notify) when the referral qualifies.
  // Fraud check: activity against the referrer (the pair trading with each other) never counts.
  function progress(uid, key, cents, { counterparty = null } = {}) {
    if (!(cents > 0)) return null;
    const r0 = db.prepare("SELECT * FROM referrals WHERE program=? AND referee_id=? AND status='pending'").get(key, uid);
    if (!r0) return null;
    if (counterparty && counterparty === r0.referrer_id) return null;
    if (r0.expires_ts <= now()) { expire(key); return null; }
    const p = prog(key);
    return tx(db, () => {
      db.prepare("UPDATE referrals SET progress_cents=progress_cents+? WHERE id=? AND status='pending'").run(Math.round(cents), r0.id);
      const r = db.prepare('SELECT * FROM referrals WHERE id=?').get(r0.id);
      if (r.status !== 'pending' || r.progress_cents < r.threshold_cents) return null;
      // Fraud review (Phase 8): signals hold the referral for an admin decision instead of paying it.
      const signals = p.review ? p.review(r) || [] : [];
      if (signals.length) {
        db.prepare("UPDATE referrals SET status='review', qualified_ts=? WHERE id=?").run(now(), r.id);
        const rid = newId('rrv_');
        db.prepare('INSERT INTO referral_reviews(id,referral_id,program,status,signals_json,created_ts) VALUES(?,?,?,?,?,?)').run(rid, r.id, key, 'pending', JSON.stringify(signals), now());
        return { referral: db.prepare('SELECT * FROM referrals WHERE id=?').get(r.id), rewards: [], review: { id: rid, signals } };
      }
      db.prepare("UPDATE referrals SET status='rewarded', qualified_ts=? WHERE id=?").run(now(), r.id);
      return { referral: db.prepare('SELECT * FROM referrals WHERE id=?').get(r.id), rewards: payRewards(r, key) };
    });
  }
  // Both sides of a qualified referral: the referee bonus, then the referrer reward within the lifetime caps.
  function payRewards(r, key) {
    const s = settings(key); const p = prog(key);
    const out = [];
    {
      const reward = (user, role, cents0, capped) => {
        const id = newId('rr_');
        let status = 'capped'; let detail = null;
        if (cents0 > 0 && !capped) {
          const res = p.payout({ uid: user, cents: cents0, role, referral: r, rewardId: id }) || {};
          status = res.paid ? 'paid' : res.queued ? 'queued' : 'refused';
          detail = res.reason || null;
        }
        db.prepare('INSERT INTO referral_rewards(id,referral_id,program,user_id,role,amount_cents,status,detail,created_ts,epoch) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, r.id, key, user, role, cents0, status, detail, now(), epoch());
        out.push({ id, user_id: user, role, amount_cents: cents0, status });
      };
      reward(r.referee_id, 'referee', r.reward_referee_cents, false);
      const e = earned(r.referrer_id, key);
      const capped = (s.lifetime_cap_count > 0 && e.n >= s.lifetime_cap_count) || (s.lifetime_cap_cents > 0 && e.c + r.reward_referrer_cents > s.lifetime_cap_cents);
      reward(r.referrer_id, 'referrer', r.reward_referrer_cents, capped);
    }
    return out;
  }
  // Admin decision on a held referral: approve pays both sides now, reject closes it unpaid.
  function decideReview(reviewId, approve, { actorId = null, note = '' } = {}) {
    return tx(db, () => {
      const v = db.prepare('SELECT * FROM referral_reviews WHERE id=?').get(reviewId);
      if (!v) throw new ReferralError('referral_review_not_found', 404);
      if (v.status !== 'pending') throw new ReferralError('referral_review_closed');
      const r = db.prepare('SELECT * FROM referrals WHERE id=?').get(v.referral_id);
      db.prepare('UPDATE referral_reviews SET status=?, decided_by=?, decided_ts=?, note=? WHERE id=?').run(approve ? 'approved' : 'rejected', actorId, now(), String(note || '').slice(0, 500), v.id);
      if (!r || r.status !== 'review') return { review: db.prepare('SELECT * FROM referral_reviews WHERE id=?').get(v.id), rewards: [] };
      db.prepare('UPDATE referrals SET status=? WHERE id=?').run(approve ? 'rewarded' : 'rejected', r.id);
      const rewards = approve ? payRewards(r, v.program) : [];
      return { review: db.prepare('SELECT * FROM referral_reviews WHERE id=?').get(v.id), referral: db.prepare('SELECT * FROM referrals WHERE id=?').get(r.id), rewards };
    });
  }
  const reviews = (key, status = 'pending') => db.prepare(`SELECT v.*, r.code, r.referrer_id, r.referee_id, r.progress_cents, r.threshold_cents, r.source FROM referral_reviews v JOIN referrals r ON r.id=v.referral_id WHERE v.program=? ${status === 'all' ? '' : 'AND v.status=?'} ORDER BY v.created_ts DESC LIMIT 200`).all(...(status === 'all' ? [key] : [key, status]));
  const iso = (t) => (t ? new Date(t).toISOString() : null);
  // Shape of the observed referrals summary (CLONE_SPEC.md §13.19), per program.
  function summary(uid, key) {
    expire(key);
    const s = settings(key);
    const mine = db.prepare('SELECT * FROM referrals WHERE program=? AND referrer_id=? ORDER BY created_ts DESC LIMIT 100').all(key, uid);
    const count = (st) => mine.filter((r) => r.status === st).length;
    const asRef = db.prepare('SELECT * FROM referrals WHERE program=? AND referee_id=?').get(key, uid);
    const e = earned(uid, key);
    const asReferee = db.prepare('SELECT * FROM referrals WHERE program=? AND referee_id=?').get(key, uid);
    const rewards = db.prepare('SELECT * FROM referral_rewards WHERE program=? AND user_id=? ORDER BY created_ts DESC LIMIT 50').all(key, uid);
    return {
      program: key, enabled: !!s.enabled, referral_code: codeFor(uid, key),
      current_offer: { reward_type: prog(key).rewardType || 'perps_collateral', referrer_cents: s.reward_referrer_cents, referee_cents: s.reward_referee_cents, threshold_cents: s.threshold_cents, referrer_dollars: (s.reward_referrer_cents / 100).toFixed(2), referee_dollars: (s.reward_referee_cents / 100).toFixed(2), threshold_dollars: (s.threshold_cents / 100).toFixed(2), expiry_days: s.expiry_days },
      lifetime_cap: { amount_cents: s.lifetime_cap_cents, number_of_referrals: s.lifetime_cap_count },
      total_earned_cents: e.c, total_earned_dollars: (e.c / 100).toFixed(2), total_credited_referrals: e.n,
      pending_count: count('pending'), completed_count: count('rewarded'), expired_count: count('expired'), review_count: count('review'),
      can_apply: !!(s.enabled && !asRef && (!prog(key).eligible || prog(key).eligible(uid)) && (() => { const u = db.prepare('SELECT created_at FROM users WHERE id=?').get(uid); return u && now() - Date.parse(u.created_at) <= s.signup_window_days * DAY; })()),
      referrals: mine.map((r) => ({ id: r.id, status: r.status, progress_dollars: (r.progress_cents / 100).toFixed(2), threshold_dollars: (r.threshold_cents / 100).toFixed(2), created_time: iso(r.created_ts), expires_time: iso(r.expires_ts), qualified_time: iso(r.qualified_ts) })),
      referred_by: asReferee ? { status: asReferee.status, progress_dollars: (asReferee.progress_cents / 100).toFixed(2), threshold_dollars: (asReferee.threshold_cents / 100).toFixed(2), expires_time: iso(asReferee.expires_ts), bonus_dollars: (asReferee.reward_referee_cents / 100).toFixed(2) } : null,
      eligibility_progress: asReferee ? { amount_traded_cents: asReferee.progress_cents, threshold_cents: asReferee.threshold_cents } : null,
      rewards: rewards.map((x) => ({ id: x.id, role: x.role, amount_dollars: (x.amount_cents / 100).toFixed(2), status: x.status, created_time: iso(x.created_ts) })),
    };
  }
  function adminList(key) {
    expire(key);
    const email = (id) => db.prepare('SELECT email FROM users WHERE id=?').get(id)?.email || id;
    return {
      settings: settings(key),
      counts: Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM referrals WHERE program=? GROUP BY status').all(key).map((r) => [r.status, r.n])),
      rewards_total_cents: db.prepare("SELECT COALESCE(SUM(amount_cents),0) c FROM referral_rewards WHERE program=? AND status IN ('paid','queued')").get(key).c,
      referrals: db.prepare('SELECT * FROM referrals WHERE program=? ORDER BY created_ts DESC LIMIT 200').all(key).map((r) => ({ id: r.id, code: r.code, referrer: email(r.referrer_id), referee: email(r.referee_id), status: r.status, source: r.source || 'code', progress_cents: r.progress_cents, threshold_cents: r.threshold_cents, created_time: iso(r.created_ts), qualified_time: iso(r.qualified_ts) })),
      reviews: reviews(key, 'all').map((v) => ({ id: v.id, referral_id: v.referral_id, status: v.status, signals: JSON.parse(v.signals_json || '[]'), referrer: email(v.referrer_id), referee: email(v.referee_id), code: v.code, source: v.source, progress_cents: v.progress_cents, created_time: iso(v.created_ts), decided_by: v.decided_by ? email(v.decided_by) : null, decided_time: iso(v.decided_ts), note: v.note })),
      rewards: db.prepare('SELECT * FROM referral_rewards WHERE program=? ORDER BY created_ts DESC LIMIT 200').all(key).map((x) => ({ id: x.id, user: email(x.user_id), role: x.role, amount_cents: x.amount_cents, status: x.status, created_time: iso(x.created_ts) })),
    };
  }
  // Production switch (server/play-mode.js): play-epoch referrals that never qualified are void; queued rewards canceled.
  function voidPlay() {
    return {
      referrals: db.prepare("UPDATE referrals SET status='void' WHERE status IN ('pending','review')").run().changes,
      reviews: db.prepare("UPDATE referral_reviews SET status='void' WHERE status='pending'").run().changes,
      rewards: db.prepare("UPDATE referral_rewards SET status='canceled' WHERE status='queued'").run().changes,
    };
  }
  const pending = () => ({ referrals: db.prepare("SELECT COUNT(*) c FROM referrals WHERE status='pending'").get().c, queued_rewards: db.prepare("SELECT COUNT(*) n, COALESCE(SUM(amount_cents),0) c FROM referral_rewards WHERE status='queued'").get() });
  return { register, settings, codeFor, apply, progress, expire, summary, adminList, voidPlay, pending, decideReview, reviews, SPEC, ReferralError };
}

module.exports = { createReferrals, ReferralError, SPEC, BASE_DEFAULTS, newCode };
