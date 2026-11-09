'use strict';
// Central Bank, promotions treasury and the Vault Heist game (PLAN Phase 5D, CLONE_SPEC.md §33).
//
// Money model (double-entry, server/journal.js): the vault is the journal account `bank:vault` (a positive balance is
// money the bank holds). Admin funding mints from `bank:funding` (there is no outside money in this sandbox); defunding
// returns to it. Every naira that leaves or enters the vault is an engine.credit() with `contra: 'bank:vault'`, so the
// user's ledger row, the journal entry and the vault move together in one transaction, and the ledger audit keeps
// balancing. The extra audit checks below prove the vault never goes negative.
//
//   Play mode (play money)  the vault is the prize pot of the Vault Heist: crew fees go in, cracked heists take a share
//                            out; it can also pay the signup bonus (play mode › bonus source "treasury").
//   Production               the vault is the promotions treasury: signup bonuses, incentive rewards (§29) and the
//                            referral hook (payments.grantCredit) draw from it; with too little budget a payout is
//                            queued (or refused, per setting) and paid FIFO once the vault is funded.
// The Central Bank is the `central_bank` feature flag (off on a new database) and the game the `heist` flag.
//
// Heist: the server draws a secret code with the crypto RNG (injectable in tests only through the start option
// `centralBank: { rng }`, ignored in production; never from a request), stores it AES-GCM encrypted and sends it to the
// client only once the heist is over. Each guess is checked on the server and answered with Mastermind feedback (exact =
// right digit right place, near = right digit wrong place); the alarm rises with every guess. Guesses are numbered by
// the client (`n`), so a retried request replays the stored answer instead of using a second guess.
const crypto = require('node:crypto');
const { tx } = require('./db');
const { newId, nowIso, dollars, ApiError, E } = require('./util');
const { ensureSchema } = require('./migrations/schema-guard');
const kc = require('./crypto');
const journal = require('./journal');
const C = require('./currency');
const { s } = require('./content/playmode');
const { check: checkBody } = require('./validate');

const VAULT = 'bank:vault';
const FUNDING = 'bank:funding';
const DAY = 86400000;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS cb_ops (id TEXT PRIMARY KEY, kind TEXT NOT NULL, amount_cents INTEGER NOT NULL, balance_after_cents INTEGER NOT NULL, reason TEXT NOT NULL, actor_id TEXT, actor_email TEXT, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cb_heists (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, client_id TEXT, status TEXT NOT NULL, level INTEGER NOT NULL, digits INTEGER NOT NULL,
  max_guesses INTEGER NOT NULL, guesses_used INTEGER NOT NULL DEFAULT 0, alarm INTEGER NOT NULL DEFAULT 0, fee_cents INTEGER NOT NULL, loot_cents INTEGER NOT NULL DEFAULT 0, code_enc TEXT NOT NULL,
  started_ts INTEGER NOT NULL, deadline_ts INTEGER NOT NULL, ended_ts INTEGER, epoch TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_cb_heists_user ON cb_heists(user_id, started_ts);
CREATE INDEX IF NOT EXISTS idx_cb_heists_status ON cb_heists(status, deadline_ts);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cb_heists_client ON cb_heists(user_id, client_id) WHERE client_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS cb_guesses (heist_id TEXT NOT NULL REFERENCES cb_heists(id) ON DELETE CASCADE, n INTEGER NOT NULL, guess TEXT NOT NULL, exact INTEGER NOT NULL, near INTEGER NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (heist_id, n));
CREATE TABLE IF NOT EXISTS cb_payout_queue (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, purpose TEXT NOT NULL, mode TEXT NOT NULL, amount_cents INTEGER NOT NULL,
  ref TEXT, memo TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'queued', created_ts INTEGER NOT NULL, paid_ts INTEGER, epoch TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_cb_queue_status ON cb_payout_queue(status, created_ts);
`;
const DEFAULTS = {
  heist: { crew_fee_cents: 500, timer_seconds: 60, base_digits: 4, base_guesses: 10, max_share_pct: 10, max_loot_cents: 50000, max_loot_user_day_cents: 100000,
    attempts_per_day: 5, jail_minutes: 10, max_level: 6, decay_minutes: 60, min_vault_cents: 100 },
  treasury: { on_empty: 'queue' }, // queue | refuse
};
const HEIST_SPEC = {
  crew_fee_cents: { type: 'integer', min: 1, max: 100000000 }, timer_seconds: { type: 'integer', min: 10, max: 600 }, base_digits: { type: 'integer', min: 3, max: 6 },
  base_guesses: { type: 'integer', min: 3, max: 20 }, max_share_pct: { type: 'integer', min: 1, max: 100 }, max_loot_cents: { type: 'integer', min: 1, max: 1000000000 },
  max_loot_user_day_cents: { type: 'integer', min: 1, max: 1000000000 }, attempts_per_day: { type: 'integer', min: 1, max: 100 }, jail_minutes: { type: 'integer', min: 0, max: 1440 },
  max_level: { type: 'integer', min: 0, max: 8 }, decay_minutes: { type: 'integer', min: 1, max: 10080 }, min_vault_cents: { type: 'integer', min: 0, max: 1000000000 },
};

// Mastermind feedback for unique-digit codes.
function feedback(code, guess) {
  let exact = 0; let near = 0;
  for (let i = 0; i < code.length; i++) { if (guess[i] === code[i]) exact += 1; else if (code.includes(guess[i])) near += 1; }
  return { exact, near };
}
// `digits` different digits; rng(max) → integer in [0, max).
function drawCode(digits, rng) {
  const pool = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
  let out = '';
  for (let i = 0; i < digits; i++) out += pool.splice(rng(pool.length), 1)[0];
  return out;
}

// Schema and its additive columns (part of migration 0001, server/migrations/0001-baseline.js).
function schema(db) {
  db.exec(SCHEMA);
  // Phase 6 (CLONE_SPEC.md §34.7): a queued payout can name a destination other than predictions cash (Perps collateral).
  if (!db.prepare('PRAGMA table_info(cb_payout_queue)').all().some((c) => c.name === 'dest_json')) db.exec('ALTER TABLE cb_payout_queue ADD COLUMN dest_json TEXT');
}

function mountCentralBank({ v1, db, engine, auth, admin, flags, feat, keyDir, options = {} }) {
  ensureSchema(db, schema); // migration 0001 (server/migrations)
  const destinations = {}; // kind -> ({ user_id, amount_cents, mode, ref, memo, dest }, contra) => void (server/perps-ops.js: 'perps')
  journal.init(db);
  const production = process.env.NODE_ENV === 'production';
  if (options.rng && production) console.warn('centralBank.rng is ignored in production');
  const rng = !production && typeof options.rng === 'function' ? options.rng : (max) => crypto.randomInt(max);
  const codeKey = kc.deriveKey('heist-code:v1', { dir: keyDir });
  const hooks = { playOn: () => false, epoch: () => '' }; // set by server/play-mode.js
  const now = () => (typeof options.now === 'function' && !production ? options.now() : Date.now());

  // ---------------------------------------------------------------- settings
  function settings() {
    const r = db.prepare("SELECT value FROM admin_settings WHERE key='central_bank'").get();
    const v = r ? JSON.parse(r.value) : {};
    return { heist: { ...DEFAULTS.heist, ...(v.heist || {}) }, treasury: { ...DEFAULTS.treasury, ...(v.treasury || {}) } };
  }
  const putSettings = (v, by) => admin.putSetting('central_bank', v, by);
  const stateRow = () => { const r = db.prepare("SELECT value FROM admin_settings WHERE key='central_bank_state'").get(); return r ? JSON.parse(r.value) : { level: 0, level_ts: 0 }; };
  const open = () => flags.jobOn('central_bank');
  const balance = () => journal.balanceOf(db, VAULT);
  // Security level: +1 per cracked heist, −1 per decay period since the last change.
  function level() {
    const st = stateRow(); const H = settings().heist;
    const decayed = st.level_ts ? Math.floor((now() - st.level_ts) / (H.decay_minutes * 60000)) : 0;
    return Math.max(0, Math.min(H.max_level, st.level - decayed));
  }
  function raiseLevel() { const H = settings().heist; admin.putSetting('central_bank_state', { level: Math.min(H.max_level, level() + 1), level_ts: now() }, null); }
  const shape = (lvl) => { const H = settings().heist; return { digits: Math.min(8, H.base_digits + Math.floor(lvl / 2)), guesses: Math.max(3, H.base_guesses - lvl) }; };
  function publicVo() {
    const H = settings().heist; const lvl = level(); const sh = shape(lvl);
    return { open: open(), play_mode: hooks.playOn(), heist_open: open() && hooks.playOn() && flags.jobOn('heist'), balance_dollars: hooks.playOn() ? dollars(balance()) : null,
      security_level: lvl, max_level: H.max_level, heist: { crew_fee_dollars: dollars(H.crew_fee_cents), timer_seconds: H.timer_seconds, digits: sh.digits, guesses: sh.guesses, attempts_per_day: H.attempts_per_day,
        max_share_pct: H.max_share_pct, max_loot_dollars: dollars(H.max_loot_cents), max_loot_user_day_dollars: dollars(H.max_loot_user_day_cents), jail_minutes: H.jail_minutes } };
  }
  const emitVault = () => { if (hooks.playOn()) engine.emit('central_bank', { type: 'vault', balance_dollars: dollars(balance()), security_level: level() }); };

  // ---------------------------------------------------------------- vault movements
  function fundOp(kind, cents, reason, actor) {
    return tx(db, () => {
      if (kind === 'defund' && balance() < cents) throw new ApiError(409, 'insufficient_vault', s('bank.insufficient_vault', { amount: C.moneyCents(balance()) }));
      journal.post(db, { kind: `cb_${kind}`, memo: reason.slice(0, 120) }, kind === 'fund' ? [[VAULT, cents], [FUNDING, -cents]] : [[VAULT, -cents], [FUNDING, cents]]);
      const id = newId('cbo_');
      db.prepare('INSERT INTO cb_ops(id,kind,amount_cents,balance_after_cents,reason,actor_id,actor_email,ts) VALUES(?,?,?,?,?,?,?,?)').run(id, kind, cents, balance(), reason, actor?.id || null, actor?.email || null, Date.now());
      return db.prepare('SELECT * FROM cb_ops WHERE id=?').get(id);
    });
  }
  // Treasury payout to a user, from the vault. mode 'cash' (ledger kind as given) or 'credit' (non-withdrawable,
  // expiring credit). Inside the caller's transaction when there is one. → { paid } | { queued } | { refused }
  // `dest` (optional): { kind, … } routes the money to a registered destination instead of predictions cash.
  function pay({ uid, cents, mode = 'cash', kind = 'bonus', purpose = 'bonus', ref = null, memo = '', queueRef = null, dest = null }) {
    if (!(cents > 0)) return { paid: false };
    if (dest && !destinations[dest.kind]) throw new Error(`unknown treasury destination ${dest.kind}`);
    return tx(db, () => {
      if (balance() >= cents) {
        if (dest) destinations[dest.kind]({ user_id: uid, amount_cents: cents, mode: kind, ref, memo, dest }, VAULT);
        else engine.credit(uid, cents, mode === 'credit' ? 'credit' : kind, ref, memo, { contra: VAULT });
        return { paid: true };
      }
      if (settings().treasury.on_empty === 'refuse') return { refused: true, reason: 'treasury_empty' };
      const id = newId('cbq_');
      db.prepare('INSERT INTO cb_payout_queue(id,user_id,purpose,mode,amount_cents,ref,memo,status,created_ts,epoch,dest_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, uid, purpose, mode === 'credit' ? 'credit' : kind, cents, queueRef ?? ref, memo, 'queued', Date.now(), hooks.epoch(), dest ? JSON.stringify(dest) : null);
      return { queued: true, id };
    });
  }
  // FIFO: pay queued items while the vault covers them (after funding, and on the engine tick).
  function processQueue() {
    const paid = [];
    tx(db, () => {
      for (const q of db.prepare("SELECT * FROM cb_payout_queue WHERE status='queued' ORDER BY created_ts, rowid").all()) {
        if (balance() < q.amount_cents) break;
        const dest = q.dest_json ? JSON.parse(q.dest_json) : null;
        if (dest && destinations[dest.kind]) destinations[dest.kind]({ ...q, dest }, VAULT);
        else engine.credit(q.user_id, q.amount_cents, q.mode, q.ref, q.memo, { contra: VAULT });
        db.prepare("UPDATE cb_payout_queue SET status='paid', paid_ts=? WHERE id=?").run(Date.now(), q.id);
        paid.push(q);
      }
    });
    for (const q of paid) {
      engine.emit('user_balance', q.user_id, engine.balance(q.user_id));
      try { feat.notify(q.user_id, { type: 'reward', title: s('notify.payout_paid.title', { amount: C.moneyCents(q.amount_cents) }), body: s('notify.payout_paid.body', { memo: q.memo }), link: '/funds' }); } catch (e) { console.error('treasury notify', e.message); }
    }
    if (paid.length) emitVault();
    return paid.length;
  }
  // Promotions treasury hooks (production use, §33): incentive rewards and the referral credit hook draw from the vault
  // while the Central Bank is on; otherwise the Phase 4/5B accounts are used as before.
  engine.treasury = { active: () => open(), pay, account: VAULT, balance, destinations };

  // ---------------------------------------------------------------- heists
  const heistRow = (id) => db.prepare('SELECT * FROM cb_heists WHERE id=?').get(String(id));
  const enc = (code, id) => kc.encrypt(code, `cb_heists.code:${id}`, codeKey);
  const dec = (h) => kc.decrypt(h.code_enc, `cb_heists.code:${h.id}`, codeKey);
  const dayStart = () => { const d = new Date(now()); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
  const jailUntil = (uid) => { const r = db.prepare("SELECT MAX(ended_ts) t FROM cb_heists WHERE user_id=? AND status IN ('caught','timeout') AND epoch=?").get(uid, hooks.epoch()).t; return r ? r + settings().heist.jail_minutes * 60000 : 0; };
  const attemptsToday = (uid) => db.prepare("SELECT COUNT(*) c FROM cb_heists WHERE user_id=? AND started_ts>=? AND status<>'void'").get(uid, dayStart()).c;
  const lootToday = (uid) => db.prepare("SELECT COALESCE(SUM(loot_cents),0) c FROM cb_heists WHERE user_id=? AND status='cracked' AND ended_ts>=?").get(uid, dayStart()).c;
  const nameOf = (uid) => db.prepare('SELECT display_name FROM users WHERE id=?').get(uid)?.display_name || '—';
  function heistVo(h, uid) {
    const over = h.status !== 'active';
    const guesses = db.prepare('SELECT n, guess, exact, near, ts FROM cb_guesses WHERE heist_id=? ORDER BY n').all(h.id).map((g) => ({ n: g.n, guess: g.guess, exact: g.exact, near: g.near, time: new Date(g.ts).toISOString() }));
    return { id: h.id, status: h.status, level: h.level, digits: h.digits, max_guesses: h.max_guesses, guesses_used: h.guesses_used, guesses_left: h.max_guesses - h.guesses_used, alarm: h.alarm,
      crew_fee_dollars: dollars(h.fee_cents), loot_dollars: dollars(h.loot_cents), started_time: new Date(h.started_ts).toISOString(), deadline_time: new Date(h.deadline_ts).toISOString(),
      ended_time: h.ended_ts ? new Date(h.ended_ts).toISOString() : null, seconds_left: over ? 0 : Math.max(0, Math.ceil((h.deadline_ts - now()) / 1000)), guesses,
      code: over && h.user_id === uid ? dec(h) : null }; // the code leaves the server only when the heist is over
  }
  function feedItem(h) { return { id: h.id, name: nameOf(h.user_id), status: h.status, loot_dollars: dollars(h.loot_cents), level: h.level, time: new Date(h.ended_ts || h.started_ts).toISOString() }; }
  // Ends a heist (caught / timeout): the fee stays in the vault, the user goes to jail. Inside a transaction.
  function fail(h, status) {
    const r = db.prepare("UPDATE cb_heists SET status=?, ended_ts=?, alarm=? WHERE id=? AND status='active'").run(status, now(), status === 'caught' ? 100 : h.alarm, h.id);
    return r.changes > 0;
  }
  function afterEnd(h) {
    const x = heistRow(h.id);
    engine.emit('central_bank', { type: 'feed', item: feedItem(x) });
    emitVault();
    const H = settings().heist;
    try {
      if (x.status === 'cracked') feat.notify(x.user_id, { type: 'heist_result', title: s('notify.heist.won.title', { amount: C.moneyCents(x.loot_cents) }), body: s('notify.heist.won.body', { code: dec(x) }), link: '/heist' });
      else feat.notify(x.user_id, { type: 'heist_result', title: s('notify.heist.lost.title', { amount: C.moneyCents(x.fee_cents) }), body: s('notify.heist.lost.body', { code: dec(x), until: C.timeLabel ? C.timeLabel(x.ended_ts + H.jail_minutes * 60000) : new Date(x.ended_ts + H.jail_minutes * 60000).toISOString() }), link: '/heist' });
    } catch (e) { console.error('heist notify', e.message); }
  }
  // Heists past their deadline end as `timeout` (the job, and lazily on every read).
  function expire() {
    const due = db.prepare("SELECT * FROM cb_heists WHERE status='active' AND deadline_ts<=?").all(now());
    const ended = [];
    for (const h of due) if (tx(db, () => fail(h, 'timeout'))) ended.push(h);
    for (const h of ended) afterEnd(h);
  }
  // In-process rate limit per user: guesses (10 per 5 s) and starts (6 per minute).
  const buckets = new Map();
  function limited(key, max, windowMs) {
    const t = now(); const list = (buckets.get(key) || []).filter((x) => t - x < windowMs);
    if (list.length >= max) { buckets.set(key, list); return true; }
    list.push(t); buckets.set(key, list); return false;
  }
  function requireOpen(req) {
    if (!hooks.playOn()) throw new ApiError(403, 'heist_play_mode_only', s('heist.play_only'));
    if (!open()) throw flags.disabledError('central_bank');
    if (!flags.on('heist', { req })) throw flags.disabledError('heist');
  }
  const requireUser = (req, res, next) => {
    if (!req.auth) return next(E.unauthorized());
    if (req.params.uid && req.params.uid !== req.auth.user.id) return next(E.forbidden('cannot access another user'));
    next();
  };
  function myState(uid) {
    expire();
    const active = db.prepare("SELECT * FROM cb_heists WHERE user_id=? AND status='active' ORDER BY started_ts DESC LIMIT 1").get(uid);
    const H = settings().heist; const j = jailUntil(uid);
    return { active: active ? heistVo(active, uid) : null, attempts_today: attemptsToday(uid), attempts_per_day: H.attempts_per_day, jail_until: j > now() ? new Date(j).toISOString() : null,
      loot_today_dollars: dollars(lootToday(uid)), max_loot_user_day_dollars: dollars(H.max_loot_user_day_cents),
      history: db.prepare('SELECT * FROM cb_heists WHERE user_id=? AND status<>\'active\' ORDER BY started_ts DESC LIMIT 20').all(uid).map((h) => heistVo(h, uid)), bank: publicVo() };
  }
  v1.get('/central_bank', (req, res) => { res.json({ central_bank: publicVo() }); });
  v1.get('/central_bank/feed', (req, res) => {
    const rows = db.prepare("SELECT * FROM cb_heists WHERE status IN ('cracked','caught','timeout') AND epoch=? ORDER BY ended_ts DESC LIMIT 25").all(hooks.epoch());
    res.json({ feed: rows.map(feedItem) });
  });
  v1.get('/central_bank/most_wanted', (req, res) => {
    const rows = db.prepare("SELECT user_id, SUM(loot_cents) loot, COUNT(*) n FROM cb_heists WHERE status='cracked' AND epoch=? GROUP BY user_id HAVING SUM(loot_cents)>0 ORDER BY loot DESC, MIN(ended_ts) LIMIT 10").all(hooks.epoch());
    res.json({ most_wanted: rows.map((r, i) => ({ rank: i + 1, name: nameOf(r.user_id), loot_dollars: dollars(r.loot), heists: r.n })) });
  });
  v1.get('/users/:uid/heists', requireUser, (req, res) => res.json(myState(req.auth.user.id)));
  v1.post('/users/:uid/heists', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const b = checkBody(req.body || {}, { client_id: { type: 'string', maxLen: 64, pattern: /^[A-Za-z0-9_-]{1,64}$/ } }, { unknown: 'reject' });
    requireOpen(req);
    expire();
    if (b.client_id) { const prev = db.prepare('SELECT * FROM cb_heists WHERE user_id=? AND client_id=?').get(uid, b.client_id); if (prev) return res.status(200).json({ heist: heistVo(prev, uid), replayed: true }); }
    if (limited(`start:${uid}`, 6, 60000)) throw new ApiError(429, 'too_many_requests', s('heist.too_fast'));
    const H = settings().heist;
    const j = jailUntil(uid);
    if (j > now()) throw new ApiError(409, 'heist_jailed', s('heist.jailed', { until: new Date(j).toISOString() }), new Date(j).toISOString());
    if (db.prepare("SELECT 1 FROM cb_heists WHERE user_id=? AND status='active'").get(uid)) throw new ApiError(409, 'heist_active', s('heist.active'));
    if (attemptsToday(uid) >= H.attempts_per_day) throw new ApiError(409, 'heist_daily_limit', s('heist.daily_limit', { limit: H.attempts_per_day }));
    if (balance() < H.min_vault_cents || balance() <= 0) throw new ApiError(409, 'vault_empty', s('bank.vault_empty'));
    if (engine.balance(uid) < H.crew_fee_cents) throw new ApiError(409, 'insufficient_balance', s('heist.fee', { amount: C.moneyCents(H.crew_fee_cents), balance: C.moneyCents(engine.balance(uid)) }));
    const lvl = level(); const sh = shape(lvl);
    const id = newId('hst_');
    const t0 = now();
    const code = drawCode(sh.digits, rng);
    tx(db, () => {
      db.prepare('INSERT INTO cb_heists(id,user_id,client_id,status,level,digits,max_guesses,fee_cents,code_enc,started_ts,deadline_ts,epoch) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, uid, b.client_id || null, 'active', lvl, sh.digits, sh.guesses, H.crew_fee_cents, enc(code, id), t0, t0 + H.timer_seconds * 1000, hooks.epoch());
      engine.credit(uid, -H.crew_fee_cents, 'heist_fee', id, s('memo.heist_fee'), { contra: VAULT }); // the fee goes into the vault
    });
    engine.emit('user_balance', uid, engine.balance(uid));
    emitVault();
    res.status(201).json({ heist: heistVo(heistRow(id), uid) });
  });
  v1.post('/users/:uid/heists/:id/guesses', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const h0 = heistRow(req.params.id);
    if (!h0 || h0.user_id !== uid) throw E.notFound();
    const b = checkBody(req.body || {}, { guess: { type: 'string', required: true, maxLen: 8 }, n: { type: 'integer', min: 1, max: 30 } }, { unknown: 'reject' });
    // A retried guess (same n) replays the stored answer.
    if (b.n) { const g = db.prepare('SELECT * FROM cb_guesses WHERE heist_id=? AND n=?').get(h0.id, b.n); if (g) return res.json({ result: { n: g.n, guess: g.guess, exact: g.exact, near: g.near }, heist: heistVo(heistRow(h0.id), uid), replayed: true }); }
    if (h0.status !== 'active') throw new ApiError(409, 'heist_over', s('heist.not_active'));
    requireOpen(req);
    if (h0.deadline_ts <= now()) { expire(); throw new ApiError(409, 'heist_over', s('heist.not_active')); }
    if (!new RegExp(`^\\d{${h0.digits}}$`).test(b.guess) || new Set(b.guess).size !== h0.digits) throw new ApiError(400, 'guess_invalid', s('heist.guess_format', { digits: h0.digits }));
    if (limited(`guess:${uid}`, 10, 5000)) throw new ApiError(429, 'too_many_requests', s('heist.too_fast'));
    let result; let ended = false;
    tx(db, () => {
      const h = heistRow(h0.id); // re-read inside the transaction
      if (h.status !== 'active') throw new ApiError(409, 'heist_over', s('heist.not_active'));
      const n = h.guesses_used + 1;
      if (b.n && b.n !== n) throw new ApiError(409, 'guess_out_of_order', 'guess number out of order', `next guess is ${n}`);
      const code = dec(h);
      const fb = feedback(code, b.guess);
      const alarm = Math.min(100, Math.round((100 * n) / h.max_guesses));
      db.prepare('INSERT INTO cb_guesses(heist_id,n,guess,exact,near,ts) VALUES(?,?,?,?,?,?)').run(h.id, n, b.guess, fb.exact, fb.near, now());
      db.prepare('UPDATE cb_heists SET guesses_used=?, alarm=? WHERE id=?').run(n, alarm, h.id);
      result = { n, guess: b.guess, exact: fb.exact, near: fb.near };
      if (fb.exact === h.digits) {
        // Cracked: a share of the vault scaled by speed and guesses left, capped per heist and per user per day, and by
        // the vault itself (read inside this transaction, so two crews cracking together can never overdraw it).
        const H = settings().heist;
        const t = now();
        const timeFrac = Math.max(0, Math.min(1, (h.deadline_ts - t) / (H.timer_seconds * 1000)));
        const guessFrac = (h.max_guesses - n) / h.max_guesses;
        const score = 0.4 + 0.3 * timeFrac + 0.3 * guessFrac;
        const vault = balance();
        const cap = Math.min(Math.floor((vault * H.max_share_pct) / 100), H.max_loot_cents, Math.max(0, H.max_loot_user_day_cents - lootToday(uid)));
        const loot = Math.max(0, Math.min(vault, Math.floor(cap * score)));
        db.prepare("UPDATE cb_heists SET status='cracked', ended_ts=?, loot_cents=? WHERE id=?").run(t, loot, h.id);
        if (loot > 0) engine.credit(uid, loot, 'heist_loot', h.id, s('memo.heist_loot'), { contra: VAULT });
        raiseLevel();
        ended = true;
      } else if (n >= h.max_guesses) { fail({ ...h, alarm }, 'caught'); ended = true; }
    });
    const h = heistRow(h0.id);
    if (ended) { afterEnd(h); engine.emit('user_balance', uid, engine.balance(uid)); }
    res.json({ result, heist: heistVo(h, uid) });
  });
  // Job: end heists past their deadline; pay queued treasury items (paused while the heist / bank flags are off).
  let lastQueue = 0;
  engine.on('tick', () => {
    try {
      if (flags.jobOn('heist')) expire();
      if (open() && Date.now() - lastQueue > 5000) { lastQueue = Date.now(); processQueue(); }
    } catch (e) { if (!/not open|closed/i.test(e.message)) console.error('central bank', e); }
  });

  // ---------------------------------------------------------------- admin
  const A = '/admin/central_bank';
  const reasonOf = (b) => { const r = String((b && b.reason) || '').trim(); if (r.length < 3 || r.length > 500) throw new ApiError(400, 'validation_failed', 'validation failed', 'reason: a reason of 3-500 characters is required'); return r; };
  const centsOf = (v) => { const n = typeof v === 'string' ? Number(v) : v; if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > 100000000 || Math.abs(Math.round(n * 100) - n * 100) > 1e-6) return null; return Math.round(n * 100); };
  const adminVo = () => ({
    central_bank: publicVo(), balance_dollars: dollars(balance()), settings: settings(), flags: { central_bank: flags.state.get('central_bank'), heist: flags.state.get('heist') },
    ops: db.prepare('SELECT * FROM cb_ops ORDER BY ts DESC LIMIT 50').all().map((o) => ({ id: o.id, kind: o.kind, amount_dollars: dollars(o.amount_cents), balance_after_dollars: dollars(o.balance_after_cents), reason: o.reason, actor_email: o.actor_email, time: new Date(o.ts).toISOString() })),
    queue: db.prepare("SELECT * FROM cb_payout_queue ORDER BY CASE status WHEN 'queued' THEN 0 ELSE 1 END, created_ts DESC LIMIT 100").all().map((q) => ({ id: q.id, user_email: db.prepare('SELECT email FROM users WHERE id=?').get(q.user_id)?.email, purpose: q.purpose, mode: q.mode, amount_dollars: dollars(q.amount_cents), memo: q.memo, status: q.status, created_time: new Date(q.created_ts).toISOString(), paid_time: q.paid_ts ? new Date(q.paid_ts).toISOString() : null })),
    queued_dollars: dollars(db.prepare("SELECT COALESCE(SUM(amount_cents),0) c FROM cb_payout_queue WHERE status='queued'").get().c),
    heists: db.prepare('SELECT * FROM cb_heists ORDER BY started_ts DESC LIMIT 50').all().map((h) => ({ ...feedItem(h), user_email: db.prepare('SELECT email FROM users WHERE id=?').get(h.user_id)?.email, guesses_used: h.guesses_used, max_guesses: h.max_guesses, fee_dollars: dollars(h.fee_cents) })),
    stats: db.prepare("SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN status='cracked' THEN 1 ELSE 0 END),0) cracked, COALESCE(SUM(fee_cents),0) fees, COALESCE(SUM(loot_cents),0) loot FROM cb_heists WHERE epoch=?").get(hooks.epoch()),
  });
  v1.get(A, admin.can('users.read'), (req, res) => res.json(adminVo()));
  for (const kind of ['fund', 'defund']) {
    v1.post(`${A}/${kind}`, admin.can('users.money'), (req, res) => {
      const b = req.body || {};
      const cents = centsOf(b.amount_dollars);
      if (cents == null) throw new ApiError(400, 'validation_failed', 'validation failed', 'amount_dollars: a positive amount with at most 2 decimals');
      const reason = reasonOf(b);
      auth.assertFresh(req, 'central_bank_funding'); // step-up
      const before = balance();
      const op = fundOp(kind, cents, reason, req.auth.user);
      admin.audit(req, `central_bank.${kind}`, 'central_bank', VAULT, { balance_cents: before }, { balance_cents: op.balance_after_cents, amount_cents: cents }, reason);
      emitVault();
      if (kind === 'fund') processQueue();
      res.json(adminVo());
    });
  }
  v1.put(`${A}/settings`, admin.can('settings.write'), (req, res) => {
    const b = req.body || {};
    const reason = reasonOf(b);
    const errs = {};
    const cur = settings(); const next = { heist: { ...cur.heist }, treasury: { ...cur.treasury } };
    try {
      checkBody(b, { heist: { type: 'object' }, treasury: { type: 'object' }, reason: { type: 'string' } }, { unknown: 'reject' });
      if (b.heist) Object.assign(next.heist, checkBody(b.heist, HEIST_SPEC, { unknown: 'reject' }));
      if (b.treasury) Object.assign(next.treasury, checkBody(b.treasury, { on_empty: { type: 'string', enum: ['queue', 'refuse'] } }, { unknown: 'reject' }));
    } catch (e) { if (e.fields) Object.assign(errs, e.fields); else throw e; }
    if (!b.heist && !b.treasury) errs.body = 'send heist and/or treasury settings';
    if (Object.keys(errs).length) { const e = new ApiError(400, 'validation_failed', 'validation failed', Object.entries(errs).map(([k, m]) => `${k}: ${m}`).join('; ')); e.toJSON = () => ({ error: { code: e.code, message: e.message, details: e.details, fields: errs } }); throw e; }
    auth.assertFresh(req, 'central_bank_settings');
    putSettings(next, req.auth.user.id);
    admin.audit(req, 'central_bank.settings', 'settings', 'central_bank', cur, next, reason);
    engine.emit('central_bank', { type: 'settings' });
    res.json(adminVo());
  });
  v1.post(`${A}/queue/process`, admin.can('users.money'), (req, res) => { const n = processQueue(); res.json({ paid: n, ...adminVo() }); });

  return { balance, pay, processQueue, settings, level, publicVo, hooks, VAULT, FUNDING, expire, emitVault, feedback, drawCode, destinations,
    // Production switch (server/play-mode.js): play-mode heists void, the queue of the play epoch canceled.
    voidPlay: () => { db.prepare("UPDATE cb_heists SET status='void', ended_ts=? WHERE status='active'").run(Date.now()); db.prepare("UPDATE cb_payout_queue SET status='canceled' WHERE status='queued'").run(); admin.putSetting('central_bank_state', { level: 0, level_ts: 0 }, null); },
  };
}

module.exports = { schema, SCHEMA, mountCentralBank, feedback, drawCode, VAULT, FUNDING };
