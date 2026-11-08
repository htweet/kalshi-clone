'use strict';
// Play mode, money controls and the switch to production (PLAN Phase 5D, CLONE_SPEC.md §33).
//
// Play mode (Admin › Play mode, one master switch) runs the whole exchange on play money:
//   • signup bonus: an admin-set amount credited to every new account, minted (`play:mint`) or paid from the Central
//     Bank vault, journaled double-entry;
//   • deposits: POST deposits without a payment method is a free, instant play-money credit (rail `play`, contra
//     `play:mint`), with an optional daily cap per user; every payment rail is unreachable (the gate below refuses them,
//     and server/payments.js asks engine.money before touching a provider);
//   • withdrawals: refused on every path (`withdrawals_play_mode`), not only hidden in the UI;
//   • a "Play money" banner and labels on the client (CMS texts).
// Mode markers: every ledger row and journal entry is stamped with the money mode and epoch current when it was
// written (SQLite triggers, so no call site can forget). The production switch archives every play balance and
// position under a reset batch, sets them to zero and starts a new real-money epoch, so play and real money never mix;
// the ledger audit gains checks that prove it. Play mode cannot be switched on while real customer money exists.
//
// Switch to production: preview (exact counts and totals) → request (settings.write, step-up, reason, typed RESET) →
// a second admin approves (step-up, typed RESET; the two-person rule of CLONE_SPEC.md §28.7) → a database snapshot is
// written (VACUUM INTO the data directory) → one transaction cancels every customer order, voids open RFQs, archives and
// zeroes balances, positions, perps accounts, collateral advances and the vault, ends the bonus and the heist, and
// starts the real-money epoch. Accounts, markets and content are kept. Idempotent (the approval executes once).
//
// Money controls (play and production): the site-wide deposit / withdrawal switches are the payments.deposits /
// payments.withdrawals flags; per user, deposits and/or withdrawals can be revoked with a reason the user sees (CMS
// template), enforced by the gate on every rail and in server/payments.js, live over WebSocket and audited.
const fs = require('node:fs');
const path = require('node:path');
const { tx } = require('./db');
const { newId, nowIso, dollars, ApiError, E } = require('./util');
const journal = require('./journal');
const C = require('./currency');
const { s } = require('./content/playmode');
const { check: checkBody } = require('./validate');

const MINT = 'play:mint';
const APPROVAL_TTL_MS = 24 * 3600 * 1000;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS money_controls (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, deposits_revoked INTEGER NOT NULL DEFAULT 0, withdrawals_revoked INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '', updated_by TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS money_control_history (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, deposits_revoked INTEGER NOT NULL, withdrawals_revoked INTEGER NOT NULL, reason TEXT NOT NULL,
  actor_id TEXT, actor_email TEXT, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pm_events (id TEXT PRIMARY KEY, action TEXT NOT NULL, epoch TEXT NOT NULL, reason TEXT NOT NULL, actor_id TEXT, actor_email TEXT, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pm_approvals (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL, preview_json TEXT NOT NULL, requested_by TEXT NOT NULL, requested_ts INTEGER NOT NULL,
  decided_by TEXT, decided_ts INTEGER, decision_note TEXT, batch_id TEXT);
CREATE TABLE IF NOT EXISTS pm_reset_batches (id TEXT PRIMARY KEY, approval_id TEXT UNIQUE, from_epoch TEXT NOT NULL, requested_by TEXT, approved_by TEXT, reason TEXT NOT NULL, backup_file TEXT NOT NULL,
  counts_json TEXT NOT NULL, totals_json TEXT NOT NULL, created_ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pm_archive_balances (batch_id TEXT NOT NULL, user_id TEXT NOT NULL, balance_cents INTEGER NOT NULL, cash_cents INTEGER NOT NULL, credits_cents INTEGER NOT NULL,
  reserved_cents INTEGER NOT NULL, held_cents INTEGER NOT NULL, perps_cc INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (batch_id, user_id));
CREATE TABLE IF NOT EXISTS pm_archive_positions (batch_id TEXT NOT NULL, user_id TEXT NOT NULL, market_ticker TEXT NOT NULL, yes_count INTEGER NOT NULL, no_count INTEGER NOT NULL, yes_cost_cents INTEGER NOT NULL,
  no_cost_cents INTEGER NOT NULL, realized_pnl_cents INTEGER NOT NULL, fees_paid_cents INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pm_archive_orders (batch_id TEXT NOT NULL, order_id TEXT NOT NULL, user_id TEXT NOT NULL, market_ticker TEXT NOT NULL, kind TEXT NOT NULL, remaining_count INTEGER NOT NULL, reserved INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pm_archive_perps (batch_id TEXT NOT NULL, user_id TEXT NOT NULL, ticker TEXT NOT NULL, qty INTEGER NOT NULL, entry_cc REAL NOT NULL, margin_cc INTEGER NOT NULL, realized_cc INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pm_archive_accounts (batch_id TEXT NOT NULL, account TEXT NOT NULL, balance_cents INTEGER NOT NULL, PRIMARY KEY (batch_id, account));
CREATE INDEX IF NOT EXISTS idx_pm_archive_positions ON pm_archive_positions(batch_id, user_id);
`;
// One registration per process for the shared module hooks; each call is routed to the instance of its database (a test
// process may restart the server on the same file).
const INSTANCES = new WeakMap();
let hooksInstalled = false;
function installSharedHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  C.hooks.accountCreated.push((uid, db) => INSTANCES.get(db)?.grantBonus(uid));
  journal.hooks.auditChecks.push((db, got) => INSTANCES.get(db)?.auditChecks(db, got) || []);
}
const DEFAULTS = { on: false, bonus: { enabled: false, amount_cents: 0, source: 'mint' }, deposits: { daily_cap_cents: null } };
const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

// Mode markers on the ledger and the journal: additive columns filled by triggers from meta (money_mode, money_epoch).
function installMarkers(db) {
  // The perps journal (server/perps-ledger.js, CLONE_SPEC.md §34.6) is stamped the same way.
  for (const t of ['ledger', 'journal_entries', 'perp_journal_entries'].filter((x) => hasTable(db, x))) {
    const cols = new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
    if (!cols.has('money_mode')) db.exec(`ALTER TABLE ${t} ADD COLUMN money_mode TEXT`);
    if (!cols.has('money_epoch')) db.exec(`ALTER TABLE ${t} ADD COLUMN money_epoch TEXT`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS trg_${t}_money_mode AFTER INSERT ON ${t} WHEN NEW.money_mode IS NULL BEGIN
      UPDATE ${t} SET money_mode=COALESCE((SELECT value FROM meta WHERE key='money_mode'),'real'), money_epoch=COALESCE((SELECT value FROM meta WHERE key='money_epoch'),'genesis') WHERE rowid=NEW.rowid; END;`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_money_epoch ON ${t}(money_epoch)`);
  }
}

function mountPlayMode({ v1, db, engine, auth, admin, flags, feat, payments, centralBank, keyDir, options = {} }) {
  db.exec(SCHEMA);
  if (!db.prepare('PRAGMA table_info(pm_archive_perps)').all().some((c) => c.name === 'subaccount')) db.exec('ALTER TABLE pm_archive_perps ADD COLUMN subaccount INTEGER NOT NULL DEFAULT 0'); // Phase 6 (§34.12)
  installMarkers(db);
  const metaGet = (k) => db.prepare('SELECT value FROM meta WHERE key=?').get(k)?.value;
  const metaSet = (k, v) => db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
  const mode = () => metaGet('money_mode') || 'real';
  const epoch = () => metaGet('money_epoch') || 'genesis';
  function settings() {
    const r = db.prepare("SELECT value FROM admin_settings WHERE key='play_mode'").get();
    const v = r ? JSON.parse(r.value) : {};
    return { on: !!v.on, bonus: { ...DEFAULTS.bonus, ...(v.bonus || {}) }, deposits: { ...DEFAULTS.deposits, ...(v.deposits || {}) } };
  }
  const putSettings = (v, by) => admin.putSetting('play_mode', v, by);
  const isOn = () => settings().on && mode() === 'play';
  centralBank.hooks.playOn = isOn;
  centralBank.hooks.epoch = epoch;
  const can = admin.can;
  const reasonOf = (b) => { const r = String((b && b.reason) || '').trim(); if (r.length < 3 || r.length > 500) throw new ApiError(400, 'validation_failed', 'validation failed', 'reason: a reason of 3-500 characters is required'); return r; };
  const fieldErr = (errs) => { const e = new ApiError(400, 'validation_failed', 'validation failed', Object.entries(errs).map(([k, m]) => `${k}: ${m}`).join('; ')); e.toJSON = () => ({ error: { code: e.code, message: e.message, details: e.details, fields: errs } }); return e; };
  const centsOf = (v, { zero = false } = {}) => { const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || (!zero && n === 0) || n > 100000000 || Math.abs(Math.round(n * 100) - n * 100) > 1e-6) return null; return Math.round(n * 100); };
  const emailOf = (id) => (id ? db.prepare('SELECT email FROM users WHERE id=?').get(id)?.email || id : null);
  const dayStart = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
  const changed = (keys = ['play_mode']) => engine.emit('feature_flags', { version: flags.version, keys });

  // ---------------------------------------------------------------- money controls (per user)
  const controlsRow = (uid) => db.prepare('SELECT * FROM money_controls WHERE user_id=?').get(uid) || { deposits_revoked: 0, withdrawals_revoked: 0, reason: '' };
  function controlsVo(uid, req) {
    const c = controlsRow(uid);
    const depOn = req ? flags.on('payments.deposits', { req }) : flags.on('payments.deposits', { uid });
    const wdOn = req ? flags.on('payments.withdrawals', { req }) : flags.on('payments.withdrawals', { uid });
    const play = isOn();
    const dep = c.deposits_revoked ? { allowed: false, code: 'deposits_revoked', message: s('money.deposits_revoked'), reason: c.reason } : !depOn ? { allowed: false, code: 'feature_disabled', message: s('money.deposits_off') } : { allowed: true };
    const wd = play ? { allowed: false, code: 'withdrawals_play_mode', message: s('money.play_withdrawals') } : c.withdrawals_revoked ? { allowed: false, code: 'withdrawals_revoked', message: s('money.withdrawals_revoked'), reason: c.reason } : !wdOn ? { allowed: false, code: 'feature_disabled', message: s('money.withdrawals_off') } : { allowed: true };
    return { deposits: dep, withdrawals: wd, deposits_revoked: !!c.deposits_revoked, withdrawals_revoked: !!c.withdrawals_revoked, reason: c.reason || '' };
  }
  const revokedError = (kind, c) => {
    const details = c.reason ? s('money.revoked_details', { reason: c.reason }) : '';
    const e = kind === 'deposits' ? new ApiError(403, 'deposits_revoked', s('money.deposits_revoked'), details) : new ApiError(403, 'withdrawals_revoked', s('money.withdrawals_revoked'), details);
    e.toJSON = () => ({ error: { code: e.code, message: e.message, details: e.details, reason: c.reason } });
    return e;
  };
  // Request → 'deposit' | 'withdrawal' | 'rail' (payment-method setup on a real rail) | null.
  const DEPOSIT = [['POST', /^\/users\/[^/]+\/deposits$/], ['POST', /^\/users\/[^/]+\/(debit\/payment|bank_link\/deposit|crypto\/simulate_deposit)$/], ['PUT', /^\/users\/[^/]+\/crypto\/account$/]];
  const WITHDRAWAL = [['POST', /^\/users\/[^/]+\/withdrawals$/], ['POST', /^\/users\/[^/]+\/(debit|bank_link|crypto)\/withdrawal$/]];
  const RAIL_WRITE = /^\/users\/[^/]+\/(debit|bank_link|banks|crypto)\//;
  function classify(req) {
    if (WITHDRAWAL.some(([m, re]) => m === req.method && re.test(req.path))) return 'withdrawal';
    if (DEPOSIT.some(([m, re]) => m === req.method && re.test(req.path))) return 'deposit';
    if (req.method !== 'GET' && (RAIL_WRITE.test(req.path) || req.path === '/payments/tokenize/card')) return 'rail';
    return null;
  }
  // The guard behind every money path: the gate (HTTP) and server/payments.js (defence in depth) both call it.
  function assertMoney(uid, kind, { rail = null } = {}) {
    if (isOn()) {
      if (kind === 'withdrawal') throw new ApiError(403, 'withdrawals_play_mode', s('money.play_withdrawals'));
      if (kind === 'rail' || (kind === 'deposit' && rail && rail !== 'play')) throw new ApiError(403, 'play_mode_rails_off', s('money.play_rails'));
    } else if (kind === 'deposit' && rail === 'play') throw new ApiError(403, 'play_mode_off', s('money.play_off'));
    const c = controlsRow(uid);
    if (kind === 'deposit' && c.deposits_revoked) throw revokedError('deposits', c);
    if (kind === 'withdrawal' && c.withdrawals_revoked) throw revokedError('withdrawals', c);
  }
  flags.gates.push((req) => {
    const kind = classify(req);
    if (!kind || !req.auth) return null;
    const own = /^\/users\/([^/]+)\//.exec(req.path);
    if (own && own[1] !== req.auth.user.id) return null; // the route answers 403 first
    const rail = kind === 'deposit' ? (req.path.endsWith('/deposits') ? (req.body && req.body.method_id ? 'rail' : 'play-or-demo') : 'rail') : null;
    try { assertMoney(req.auth.user.id, kind, { rail: rail === 'play-or-demo' ? (isOn() ? 'play' : null) : rail }); } catch (e) { return e; }
    return null;
  });

  // ---------------------------------------------------------------- play deposits + closure + payments hooks
  const playDepositedToday = (uid) => db.prepare("SELECT COALESCE(SUM(amount_cents),0) c FROM payment_transactions WHERE user_id=? AND rail='play' AND direction='deposit' AND created_ts>=?").get(uid, dayStart()).c;
  function playMoneyVo(uid) {
    const cap = settings().deposits.daily_cap_cents;
    const used = playDepositedToday(uid);
    return { play_mode: isOn(), free_deposits: isOn() && flags.on('play.free_deposits', { uid }), daily_cap_dollars: cap == null ? null : dollars(cap), used_today_dollars: dollars(used), left_today_dollars: cap == null ? null : dollars(Math.max(0, cap - used)) };
  }
  function playDeposit(req) {
    const uid = req.auth.user.id;
    if (!flags.on('play.free_deposits', { req })) throw flags.disabledError('play.free_deposits');
    const cents = centsOf(req.body && req.body.amount_dollars);
    if (cents == null) throw new ApiError(400, 'validation_failed', 'validation failed', 'amount_dollars: a positive amount with at most 2 decimals');
    const cap = settings().deposits.daily_cap_cents;
    const t = tx(db, () => {
      const used = playDepositedToday(uid);
      if (cap != null && used + cents > cap) throw new ApiError(409, 'play_deposit_cap', s('money.play_cap', { amount: C.moneyCents(cap), left: C.moneyCents(Math.max(0, cap - used)) }));
      feat.checkDeposit(uid, cents); // the user's own daily deposit limit (§13.8) still applies
      const id = newId('pay_');
      db.prepare('INSERT INTO payment_transactions(id,user_id,direction,rail,method_id,amount_cents,fee_cents,status,provider,label,created_ts,updated_ts,completed_ts) VALUES(?,?,?,?,?,?,0,?,?,?,?,?,?)')
        .run(id, uid, 'deposit', 'play', null, cents, 'succeeded', null, s('memo.play_deposit'), Date.now(), Date.now(), Date.now());
      engine.credit(uid, cents, 'deposit', id, s('memo.play_deposit'), { contra: MINT });
      return id;
    });
    engine.emit('user_balance', uid, engine.balance(uid));
    return { status: 201, body: { balance_dollars: dollars(engine.balance(uid)), payment_id: t, play_money: playMoneyVo(uid) } };
  }
  engine.money = {
    playOn: isOn, assert: assertMoney, playDeposit, mode, epoch,
    closureContra: () => (isOn() ? MINT : undefined), // a closed play account's balance goes back to the mint, never out
  };
  void payments;

  // ---------------------------------------------------------------- signup bonus
  function grantBonus(uid) {
    const st = settings(); const b = st.bonus;
    if (!b.enabled || !(b.amount_cents > 0)) return null;
    const u = db.prepare('SELECT is_system FROM users WHERE id=?').get(uid);
    if (!u || u.is_system) return null;
    if (!flags.on('play.signup_bonus', { uid })) return null;
    const amount = C.moneyCents(b.amount_cents);
    if (isOn()) {
      if (b.source === 'treasury' && centralBank && flags.jobOn('central_bank')) {
        const r = centralBank.pay({ uid, cents: b.amount_cents, kind: 'bonus', purpose: 'signup_bonus', ref: 'signup', memo: s('memo.bonus_play') });
        if (r.queued) feat.notify(uid, { type: 'bonus_credited', title: s('notify.bonus.title', { amount }), body: s('notify.bonus.queued', { amount }), link: '/funds' });
        if (!r.paid) return r;
      } else engine.credit(uid, b.amount_cents, 'bonus', 'signup', s('memo.bonus_play'), { contra: MINT });
      feat.notify(uid, { type: 'bonus_credited', title: s('notify.bonus.title', { amount }), body: s('notify.bonus.body_play', { amount }), link: '/funds' });
    } else {
      // Production: the promotions treasury pays a non-withdrawable credit; without the Central Bank there is no bonus.
      if (!centralBank || !flags.jobOn('central_bank')) return null;
      const r = centralBank.pay({ uid, cents: b.amount_cents, mode: 'credit', purpose: 'signup_bonus', ref: 'signup', memo: s('memo.bonus_real') });
      if (r.queued) { feat.notify(uid, { type: 'bonus_credited', title: s('notify.bonus.title', { amount }), body: s('notify.bonus.queued', { amount }), link: '/funds' }); return r; }
      if (!r.paid) return r;
      feat.notify(uid, { type: 'bonus_credited', title: s('notify.bonus.title', { amount }), body: s('notify.bonus.body_real', { amount }), link: '/funds' });
    }
    engine.emit('user_balance', uid, engine.balance(uid));
    centralBank?.emitVault();
    return { paid: true };
  }

  // ---------------------------------------------------------------- real money check, preview
  const sys = 'SELECT id FROM users WHERE is_system=1';
  function realMoney() {
    const q = (sql, ...a) => db.prepare(sql).get(...a).c;
    return {
      balances: q(`SELECT COUNT(*) c FROM users WHERE is_system=0 AND balance_cents<>0`),
      positions: q(`SELECT COUNT(*) c FROM positions WHERE user_id NOT IN (${sys}) AND (yes_count>0 OR no_count>0)`),
      orders: q(`SELECT COUNT(*) c FROM orders WHERE status='resting' AND user_id NOT IN (${sys})`),
      perps: hasTable(db, 'perp_accounts') ? q(`SELECT COUNT(*) c FROM perp_accounts WHERE user_id NOT IN (${sys}) AND available_cc<>0`) + q(`SELECT COUNT(*) c FROM perp_positions WHERE user_id NOT IN (${sys}) AND qty<>0`)
        + (hasTable(db, 'perp_subaccounts') ? q(`SELECT COUNT(*) c FROM perp_subaccounts WHERE subaccount>0 AND user_id NOT IN (${sys}) AND available_cc<>0`) : 0) : 0,
      pending: hasTable(db, 'payment_transactions') ? q("SELECT COUNT(*) c FROM payment_transactions WHERE status IN ('processing','requires_action','pending','confirming','held')") : 0,
      holds: hasTable(db, 'withdrawal_holds') ? q("SELECT COUNT(*) c FROM withdrawal_holds WHERE status='held'") : 0,
    };
  }
  function preview() {
    const q = (sql, ...a) => db.prepare(sql).get(...a);
    const users = q(`SELECT COUNT(*) n, COALESCE(SUM(balance_cents),0) c FROM users WHERE is_system=0 AND balance_cents<>0`);
    const cust = db.prepare('SELECT id FROM users WHERE is_system=0').all().map((r) => r.id);
    let cash = 0; let credits = 0; let held = 0;
    for (const id of cust) { cash += journal.balanceOf(db, journal.accounts.cash(id)); credits += journal.balanceOf(db, journal.accounts.credits(id)); held += journal.balanceOf(db, journal.accounts.held(id)); }
    const orders = q(`SELECT COUNT(*) n, COALESCE(SUM(reserved_cents),0) c FROM orders WHERE status='resting' AND user_id NOT IN (${sys})`);
    const pos = q('SELECT COUNT(*) n, COUNT(DISTINCT user_id) u, COALESCE(SUM(yes_cost_cents+no_cost_cents),0) c FROM positions WHERE yes_count<>0 OR no_count<>0 OR yes_cost_cents<>0 OR no_cost_cents<>0');
    const escrow = q("SELECT COALESCE(SUM(balance_cents),0) c, COUNT(*) n FROM journal_balances WHERE account LIKE 'escrow:%' AND balance_cents<>0");
    const perps = hasTable(db, 'perp_accounts') ? { accounts: q(`SELECT COUNT(*) n, COALESCE(SUM(available_cc),0) c FROM perp_accounts WHERE user_id NOT IN (${sys}) AND available_cc<>0`), positions: q('SELECT COUNT(*) n FROM perp_positions WHERE qty<>0').n, orders: q(`SELECT COUNT(*) n FROM perp_orders WHERE status='resting' AND user_id NOT IN (${sys})`).n } : { accounts: { n: 0, c: 0 }, positions: 0, orders: 0 };
    const rfqs = hasTable(db, 'rfqs') ? q("SELECT COUNT(*) n FROM rfqs WHERE status IN ('open','accepted')").n : 0;
    const quotes = hasTable(db, 'rfq_quotes') ? q("SELECT COUNT(*) n FROM rfq_quotes WHERE status IN ('open','accepted','confirmed')").n : 0;
    const grants = q("SELECT COUNT(*) n FROM credit_grants WHERE status='active'").n;
    const collateral = hasTable(db, 'collateral_returns') ? q('SELECT COUNT(*) n, COALESCE(SUM(amount_cents),0) c FROM collateral_returns').c : 0;
    const heists = q("SELECT COUNT(*) n FROM cb_heists WHERE status='active'").n;
    // Phase 6 (CLONE_SPEC.md §34): Perps subaccounts, APY accruals, pending referrals and queued rewards.
    const px = engine.perpsOps ? engine.perpsOps.previewCounts() : { counts: {}, totals: { perps_subaccounts_cc: 0, perps_apy_accrued_cc: 0, referral_rewards_queued_dollars: dollars(0) } };
    // Phase 7A (CLONE_SPEC.md §36): waitlist members, consents and survey answers are not money: the switch keeps them.
    const wl = engine.waitlistOps ? engine.waitlistOps.previewCounts() : {};
    const elx = engine.electionsOps ? engine.electionsOps.previewCounts() : {}; // Phase 7B (§37): election data is kept
    return {
      counts: { accounts_with_balance: users.n, open_orders: orders.n, positions: pos.n, position_holders: pos.u, markets_with_escrow: escrow.n, perps_accounts: perps.accounts.n, perps_positions: perps.positions, perps_orders: perps.orders,
        open_rfqs: rfqs, open_quotes: quotes, active_credit_grants: grants, active_heists: heists, ...px.counts, kept_accounts: db.prepare('SELECT COUNT(*) c FROM users WHERE is_system=0').get().c, kept_markets: db.prepare('SELECT COUNT(*) c FROM markets').get().c, ...wl, ...elx },
      totals: { balances_dollars: dollars(users.c), cash_dollars: dollars(cash), credits_dollars: dollars(credits), held_dollars: dollars(held), reserved_dollars: dollars(orders.c), position_cost_dollars: dollars(pos.c),
        escrow_dollars: dollars(escrow.c), perps_dollars: ((perps.accounts.c + px.totals.perps_subaccounts_cc) / 10000).toFixed(4), perps_apy_accrued_dollars: (px.totals.perps_apy_accrued_cc / 10000).toFixed(4),
        referral_rewards_queued_dollars: px.totals.referral_rewards_queued_dollars, collateral_advances_dollars: dollars(collateral), vault_dollars: dollars(centralBank ? centralBank.balance() : 0) },
      play_mode: isOn(), epoch: epoch(), generated_time: nowIso(),
    };
  }

  // ---------------------------------------------------------------- turning play mode on (with the reverse guard)
  function turnOn(req, reason) {
    if (isOn()) throw E.conflict('play_mode_on', 'play mode is already on');
    const rm = realMoney();
    if (Object.values(rm).some((n) => n > 0)) {
      const e = new ApiError(409, 'real_money_exists', s('play.real_money_exists'), s('play.real_money_details', { balances: rm.balances, positions: rm.positions + rm.orders, perps: rm.perps, pending: rm.pending, holds: rm.holds }));
      e.toJSON = () => ({ error: { code: e.code, message: e.message, details: e.details, real_money: rm } });
      throw e;
    }
    const ep = newId('pe_');
    tx(db, () => {
      metaSet('money_mode', 'play'); metaSet('money_epoch', ep);
      putSettings({ ...settings(), on: true }, req.auth.user.id);
      db.prepare('INSERT INTO pm_events(id,action,epoch,reason,actor_id,actor_email,ts) VALUES(?,?,?,?,?,?,?)').run(newId('pme_'), 'on', ep, reason, req.auth.user.id, req.auth.user.email, Date.now());
      admin.audit(req, 'play_mode.on', 'settings', 'play_mode', { on: false, mode: 'real' }, { on: true, mode: 'play', epoch: ep }, reason);
    });
    changed();
    centralBank?.emitVault();
  }

  // ---------------------------------------------------------------- the switch to production
  function backup(batch) {
    if (!keyDir) throw new ApiError(500, 'backup_failed', s('play.backup_failed'), 'no data directory (in-memory database)');
    const dir = path.join(keyDir, 'backups');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `parlance-pre-production-${batch}.db`);
    try { db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); } catch (e) { throw new ApiError(500, 'backup_failed', s('play.backup_failed'), e.message); }
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw new ApiError(500, 'backup_failed', s('play.backup_failed'));
    return file;
  }
  function executeReset(a, approver) {
    if (!isOn()) throw new ApiError(409, 'play_mode_off', s('play.not_on'));
    const batch = newId('rb_');
    const RESET = `reset:${batch}`;
    const file = backup(batch); // before anything changes
    const fromEpoch = epoch();
    const touchedMarkets = new Map(); // ticker -> book before
    const touchedUsers = new Set();
    const counts = { orders: 0, rfqs: 0, quotes: 0, perps_orders: 0, perps_positions: 0, perps_accounts: 0, positions: 0, balances: 0, accounts: 0, grants: 0, holds: 0, heists: 0 };
    const totals = { balances_cents: 0, cash_cents: 0, credits_cents: 0, held_cents: 0, escrow_cents: 0, vault_cents: 0, perps_cc: 0 };
    const t0 = Date.now();
    tx(db, () => {
      // 1. Customer orders: canceled, their reservations released to the account first (then archived with it).
      for (const o of db.prepare(`SELECT * FROM orders WHERE status='resting' AND user_id NOT IN (${sys})`).all()) {
        if (!touchedMarkets.has(o.market_ticker)) touchedMarkets.set(o.market_ticker, engine.book(o.market_ticker));
        db.prepare('INSERT INTO pm_archive_orders(batch_id,order_id,user_id,market_ticker,kind,remaining_count,reserved) VALUES(?,?,?,?,?,?,?)').run(batch, o.id, o.user_id, o.market_ticker, 'order', o.remaining_count, o.reserved_cents);
        engine.releaseOrder(o.id, 'canceled', 'production_reset');
        touchedUsers.add(o.user_id); counts.orders += 1;
      }
      // 2. RFQs and quotes hold no money: closed.
      if (hasTable(db, 'rfqs')) counts.rfqs = db.prepare("UPDATE rfqs SET status='cancelled', closed_reason='production_reset', updated_ts=? WHERE status IN ('open','accepted')").run(t0).changes;
      if (hasTable(db, 'rfq_quotes')) counts.quotes = db.prepare("UPDATE rfq_quotes SET status='cancelled', closed_reason='production_reset', updated_ts=? WHERE status IN ('open','accepted','confirmed')").run(t0).changes;
      // 3. Perps: customer orders canceled, every position archived and closed, customer collateral archived and zeroed.
      if (hasTable(db, 'perp_accounts')) {
        for (const o of db.prepare(`SELECT * FROM perp_orders WHERE status='resting' AND user_id NOT IN (${sys})`).all()) {
          db.prepare('INSERT INTO pm_archive_orders(batch_id,order_id,user_id,market_ticker,kind,remaining_count,reserved) VALUES(?,?,?,?,?,?,?)').run(batch, o.id, o.user_id, o.ticker, 'perp_order', o.remaining_count, o.reserved_cc);
          db.prepare("UPDATE perp_orders SET status='canceled', reserved_cc=0, updated_ts=? WHERE id=?").run(t0, o.id);
          counts.perps_orders += 1;
        }
        for (const p of db.prepare('SELECT * FROM perp_positions WHERE qty<>0 OR margin_cc<>0').all()) {
          db.prepare('INSERT INTO pm_archive_perps(batch_id,user_id,ticker,qty,entry_cc,margin_cc,realized_cc,subaccount) VALUES(?,?,?,?,?,?,?,?)').run(batch, p.user_id, p.ticker, p.qty, p.entry_cc, p.margin_cc, p.realized_cc, p.subaccount ?? 0);
          counts.perps_positions += 1;
        }
        db.prepare('DELETE FROM perp_positions').run();
        db.prepare("UPDATE perp_exit_triggers SET status='canceled', status_reason='production_reset', updated_ts=? WHERE status='active'").run(t0);
      }
      // 4. Prediction positions (every holder, so YES and NO open interest stay paired) and collateral advances.
      for (const p of db.prepare('SELECT * FROM positions WHERE yes_count<>0 OR no_count<>0 OR yes_cost_cents<>0 OR no_cost_cents<>0 OR realized_pnl_cents<>0').all()) {
        db.prepare('INSERT INTO pm_archive_positions(batch_id,user_id,market_ticker,yes_count,no_count,yes_cost_cents,no_cost_cents,realized_pnl_cents,fees_paid_cents) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(batch, p.user_id, p.market_ticker, p.yes_count, p.no_count, p.yes_cost_cents, p.no_cost_cents, p.realized_pnl_cents, p.fees_paid_cents);
        touchedUsers.add(p.user_id); counts.positions += 1;
      }
      db.prepare('DELETE FROM positions').run();
      if (hasTable(db, 'collateral_returns')) db.prepare('DELETE FROM collateral_returns').run();
      // 5. Journal accounts that held play money outside user accounts: market escrow, collateral advances, perps
      //    collateral, the vault. Each is closed into the batch's reset account.
      const accts = db.prepare("SELECT account, balance_cents b FROM journal_balances WHERE balance_cents<>0 AND (account LIKE 'escrow:%' OR account IN ('house:collateral_advance','perps:collateral',?))").all(centralBank ? centralBank.VAULT : 'bank:vault');
      for (const x of accts) {
        db.prepare('INSERT INTO pm_archive_accounts(batch_id,account,balance_cents) VALUES(?,?,?)').run(batch, x.account, x.b);
        journal.post(db, { kind: 'play_reset', ref: batch, memo: `production switch: ${x.account} closed` }, [[x.account, -x.b], [RESET, x.b]]);
        if (x.account.startsWith('escrow:')) totals.escrow_cents += x.b;
        if (x.account === 'bank:vault') totals.vault_cents = x.b;
        counts.accounts += 1;
      }
      // 6. Customer balances: cash, credits, reservations (zero after step 1) and holds, archived and set to zero.
      const perpsAcct = hasTable(db, 'perp_accounts') ? db.prepare('SELECT available_cc c FROM perp_accounts WHERE user_id=?') : null;
      for (const u of db.prepare('SELECT id, balance_cents FROM users WHERE is_system=0').all()) {
        const cash = journal.balanceOf(db, journal.accounts.cash(u.id)); const cr = journal.balanceOf(db, journal.accounts.credits(u.id));
        const held = journal.balanceOf(db, journal.accounts.held(u.id)); const res = journal.balanceOf(db, journal.accounts.reserved(u.id));
        const pcc = perpsAcct ? perpsAcct.get(u.id)?.c || 0 : 0;
        if (!u.balance_cents && !cash && !cr && !held && !res && !pcc) continue;
        db.prepare('INSERT INTO pm_archive_balances(batch_id,user_id,balance_cents,cash_cents,credits_cents,reserved_cents,held_cents,perps_cc) VALUES(?,?,?,?,?,?,?,?)').run(batch, u.id, u.balance_cents, cash, cr, res, held, pcc);
        const lid = newId('l_');
        if (u.balance_cents) db.prepare('INSERT INTO ledger(id,user_id,kind,amount_cents,ref,memo,created_at) VALUES(?,?,?,?,?,?,?)').run(lid, u.id, 'play_reset', -u.balance_cents, batch, s('memo.reset', { batch }), nowIso());
        db.prepare('UPDATE users SET balance_cents=0 WHERE id=?').run(u.id);
        journal.post(db, { kind: 'play_reset', ref: batch, userId: u.id, memo: s('memo.reset', { batch }), ledgerId: u.balance_cents ? lid : null },
          [[journal.accounts.cash(u.id), -cash], [journal.accounts.credits(u.id), -cr], [journal.accounts.held(u.id), -held], [journal.accounts.reserved(u.id), -res], [RESET, cash + cr + held + res]]);
        if (pcc) { db.prepare('UPDATE perp_accounts SET available_cc=0, updated_at=? WHERE user_id=?').run(nowIso(), u.id); counts.perps_accounts += 1; totals.perps_cc += pcc; }
        touchedUsers.add(u.id); counts.balances += 1;
        totals.balances_cents += u.balance_cents; totals.cash_cents += cash; totals.credits_cents += cr; totals.held_cents += held;
      }
      // Phase 6 (CLONE_SPEC.md §34): subaccounts, APY accruals, referrals, order groups; every perps journal account closed.
      if (engine.perpsOps) Object.assign(counts, engine.perpsOps.resetForProduction(batch));
      // Phase 7 (CLONE_SPEC.md §35.11): API keys survive; prediction order groups close (their orders were canceled above).
      if (engine.apiOps) Object.assign(counts, engine.apiOps.resetForProduction(batch));
      counts.grants = db.prepare("UPDATE credit_grants SET status='reset' WHERE status='active'").run().changes;
      if (hasTable(db, 'withdrawal_holds')) counts.holds = db.prepare("UPDATE withdrawal_holds SET status='reset' WHERE status='held'").run().changes;
      counts.heists = db.prepare("SELECT COUNT(*) c FROM cb_heists WHERE status='active'").get().c;
      centralBank?.voidPlay();
      // 7. Play mode off, the bonus off, the heist flag off; the real-money epoch starts.
      const st = settings();
      putSettings({ ...st, on: false, bonus: { ...st.bonus, enabled: false } }, approver.id);
      flags.save('heist', { enabled: false }, { action: 'update', reason: `production switch ${batch}`, actor: approver });
      metaSet('money_mode', 'real'); metaSet('money_epoch', batch);
      if (engine.perpsOps) engine.perpsOps.reopenAfterReset(); // the liquidity float, in the real-money epoch
      db.prepare('INSERT INTO pm_reset_batches(id,approval_id,from_epoch,requested_by,approved_by,reason,backup_file,counts_json,totals_json,created_ts) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(batch, a.id, fromEpoch, a.requested_by, approver.id, a.reason, path.basename(file), JSON.stringify(counts), JSON.stringify(totals), Date.now());
      db.prepare("UPDATE pm_approvals SET status='executed', decided_by=?, decided_ts=?, batch_id=? WHERE id=? AND status='pending'").run(approver.id, Date.now(), batch, a.id);
      db.prepare('INSERT INTO pm_events(id,action,epoch,reason,actor_id,actor_email,ts) VALUES(?,?,?,?,?,?,?)').run(newId('pme_'), 'production', batch, a.reason, approver.id, approver.email, Date.now());
    });
    // Live: books, balances, notices.
    for (const [t, before] of touchedMarkets) { try { engine.afterBookChange(t, before, new Set(), []); } catch (e) { console.error('reset book', e.message); } }
    for (const uid of touchedUsers) {
      engine.emit('user_balance', uid, engine.balance(uid));
      const u = db.prepare('SELECT is_system FROM users WHERE id=?').get(uid);
      if (u && !u.is_system) { try { feat.notify(uid, { type: 'production_reset', title: s('notify.reset.title'), body: s('notify.reset.body', { zero: C.moneyCents(0) }), link: '/portfolio' }); } catch (e) { console.error('reset notify', e.message); } }
    }
    changed(['play_mode', 'heist']);
    engine.emit('central_bank', { type: 'settings' });
    try { engine.apiOps?.afterReset(); } catch (e) { console.error('reset api', e.message); } // FIX sessions are logged out
    try { engine.waitlistOps?.afterProductionSwitch(batch); } catch (e) { console.error('reset waitlists', e.message); } // survey locked; launch email offered (§36)
    try { engine.electionsOps?.afterProductionSwitch(batch); } catch (e) { console.error('reset elections', e.message); } // simulator off; election data kept (§37)
    return { batch_id: batch, backup_file: path.basename(file), counts, totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k.replace(/_cents$/, '_dollars').replace(/_cc$/, '_cc'), k.endsWith('_cc') ? v : dollars(v)])) };
  }

  // ---------------------------------------------------------------- routes
  const approvalVo = (a) => ({ id: a.id, kind: a.kind, status: a.status, reason: a.reason, preview: JSON.parse(a.preview_json), requested_by: emailOf(a.requested_by), requested_time: new Date(a.requested_ts).toISOString(),
    expires_time: new Date(a.requested_ts + APPROVAL_TTL_MS).toISOString(), decided_by: emailOf(a.decided_by), decided_time: a.decided_ts ? new Date(a.decided_ts).toISOString() : null, decision_note: a.decision_note, batch_id: a.batch_id });
  const expireApprovals = () => db.prepare("UPDATE pm_approvals SET status='expired' WHERE status='pending' AND requested_ts<=?").run(Date.now() - APPROVAL_TTL_MS);
  const batchVo = (b) => ({ id: b.id, from_epoch: b.from_epoch, requested_by: emailOf(b.requested_by), approved_by: emailOf(b.approved_by), reason: b.reason, backup_file: b.backup_file, counts: JSON.parse(b.counts_json), totals: JSON.parse(b.totals_json), time: new Date(b.created_ts).toISOString() });
  const stateVo = () => {
    expireApprovals();
    const st = settings();
    return { play_mode: { on: isOn(), mode: mode(), epoch: epoch(), bonus: { enabled: st.bonus.enabled, amount_dollars: dollars(st.bonus.amount_cents), source: st.bonus.source }, deposits: { daily_cap_dollars: st.deposits.daily_cap_cents == null ? null : dollars(st.deposits.daily_cap_cents) } },
      real_money: realMoney(), approvals: db.prepare('SELECT * FROM pm_approvals ORDER BY requested_ts DESC LIMIT 20').all().map(approvalVo),
      batches: db.prepare('SELECT * FROM pm_reset_batches ORDER BY created_ts DESC LIMIT 20').all().map(batchVo),
      events: db.prepare('SELECT * FROM pm_events ORDER BY ts DESC LIMIT 30').all().map((e) => ({ action: e.action, epoch: e.epoch, reason: e.reason, actor_email: e.actor_email, time: new Date(e.ts).toISOString() })),
      launch_waitlist: engine.waitlistOps ? engine.waitlistOps.launchSummary() : null }; // Phase 7A: target reached, launch email offer (§36)
  };
  // Public: is the site on play money (the banner and labels).
  v1.get('/play_mode', (req, res) => res.json({ play_mode: { on: isOn() } }));
  v1.get('/users/:uid/play_money', (req, res) => {
    if (!req.auth) throw E.unauthorized();
    if (req.params.uid !== req.auth.user.id) throw E.forbidden('cannot access another user');
    res.json({ play_money: playMoneyVo(req.auth.user.id) });
  });
  v1.get('/users/:uid/money_controls', (req, res) => {
    if (!req.auth) throw E.unauthorized();
    if (req.params.uid !== req.auth.user.id) throw E.forbidden('cannot access another user');
    res.json({ money_controls: controlsVo(req.auth.user.id, req) });
  });
  // The flag bundle also carries the caller's play-mode and money-control state (one fetch on load and on each nudge).
  flags.bundleExtras.push((req) => ({ play_mode: { on: isOn() }, money: req.auth ? controlsVo(req.auth.user.id, req) : null }));

  v1.get('/admin/play_mode', can('settings.write'), (req, res) => res.json(stateVo()));
  v1.get('/admin/play_mode/preview', can('settings.write'), (req, res) => res.json({ preview: preview() }));
  v1.put('/admin/play_mode', can('settings.write'), (req, res) => {
    const b = req.body || {};
    if (b.on !== true) throw new ApiError(400, 'validation_failed', 'validation failed', 'on: send true to turn play mode on; turning it off is the production switch (POST /admin/play_mode/production_switch)');
    const reason = reasonOf(b);
    auth.assertFresh(req, 'play_mode_switch');
    turnOn(req, reason);
    res.json(stateVo());
  });
  v1.put('/admin/play_mode/settings', can('settings.write'), (req, res) => {
    const b = req.body || {};
    const errs = {};
    try { checkBody(b, { bonus: { type: 'object' }, deposits: { type: 'object' }, reason: { type: 'string', maxLen: 500 } }, { unknown: 'reject' }); } catch (e) { if (e.fields) Object.assign(errs, e.fields); else throw e; }
    const cur = settings(); const next = { ...cur, bonus: { ...cur.bonus }, deposits: { ...cur.deposits } };
    if (b.bonus) {
      try { checkBody(b.bonus, { enabled: { type: 'boolean' }, amount_dollars: { type: ['number', 'string'], maxLen: 16 }, source: { type: 'string', enum: ['mint', 'treasury'] } }, { unknown: 'reject' }); } catch (e) { if (e.fields) for (const [k, m] of Object.entries(e.fields)) errs[`bonus.${k}`] = m; else throw e; }
      if (b.bonus.enabled !== undefined) next.bonus.enabled = !!b.bonus.enabled;
      if (b.bonus.source !== undefined) next.bonus.source = b.bonus.source;
      if (b.bonus.amount_dollars !== undefined) { const c = centsOf(b.bonus.amount_dollars, { zero: true }); if (c == null) errs['bonus.amount_dollars'] = 'a non-negative amount with at most 2 decimals'; else next.bonus.amount_cents = c; }
    }
    if (b.deposits) {
      try { checkBody(b.deposits, { daily_cap_dollars: { type: ['number', 'string'], maxLen: 16, nullable: true } }, { unknown: 'reject' }); } catch (e) { if (e.fields) for (const [k, m] of Object.entries(e.fields)) errs[`deposits.${k}`] = m; else throw e; }
      if (b.deposits.daily_cap_dollars !== undefined) {
        if (b.deposits.daily_cap_dollars === null || b.deposits.daily_cap_dollars === '') next.deposits.daily_cap_cents = null;
        else { const c = centsOf(b.deposits.daily_cap_dollars); if (c == null) errs['deposits.daily_cap_dollars'] = 'a positive amount with at most 2 decimals, or empty for no cap'; else next.deposits.daily_cap_cents = c; }
      }
    }
    if (!b.bonus && !b.deposits) errs.body = 'send bonus and/or deposits settings';
    let reason = '';
    try { reason = reasonOf(b); } catch { errs.reason = 'a reason of 3-500 characters is required'; }
    if (Object.keys(errs).length) throw fieldErr(errs);
    auth.assertFresh(req, 'play_mode_settings');
    putSettings(next, req.auth.user.id);
    admin.audit(req, 'play_mode.settings', 'settings', 'play_mode', cur, next, reason);
    changed();
    res.json(stateVo());
  });
  v1.post('/admin/play_mode/production_switch', can('settings.write'), (req, res) => {
    const b = req.body || {};
    if (b.confirm !== 'RESET') throw new ApiError(400, 'confirm_reset_required', s('play.confirm_reset'), 'confirm: type RESET');
    const reason = reasonOf(b);
    if (!isOn()) throw new ApiError(409, 'play_mode_off', s('play.not_on'));
    expireApprovals();
    if (db.prepare("SELECT 1 FROM pm_approvals WHERE status='pending'").get()) throw new ApiError(409, 'approval_pending', s('play.pending_exists'));
    auth.assertFresh(req, 'production_switch');
    const id = newId('pma_');
    const pv = preview();
    db.prepare('INSERT INTO pm_approvals(id,kind,status,reason,preview_json,requested_by,requested_ts) VALUES(?,?,?,?,?,?,?)').run(id, 'production_switch', 'pending', reason, JSON.stringify(pv), req.auth.user.id, Date.now());
    const a = db.prepare('SELECT * FROM pm_approvals WHERE id=?').get(id);
    admin.audit(req, 'play_mode.production_switch.requested', 'settings', 'play_mode', null, approvalVo(a), reason);
    for (const u of db.prepare('SELECT * FROM users WHERE is_admin=1 OR id IN (SELECT user_id FROM admin_roles)').all()) {
      if (u.id === req.auth.user.id) continue;
      if (!admin.rolesOf(u).some((r) => (require('./admin').ROLE_PERMS[r] || []).includes('settings.write'))) continue;
      try { feat.notify(u.id, { type: 'admin_approval', title: s('notify.approval.title'), body: reason.slice(0, 140), link: '/admin/play_mode' }); } catch { /* best effort */ }
    }
    res.status(202).json({ status: 'pending_approval', approval: approvalVo(a) });
  });
  const pendingApproval = (id) => {
    expireApprovals();
    const a = db.prepare('SELECT * FROM pm_approvals WHERE id=?').get(String(id));
    if (!a) throw E.notFound();
    if (a.status !== 'pending') throw E.conflict('approval_closed', `this request is ${a.status}`);
    return a;
  };
  v1.post('/admin/play_mode/approvals/:id/approve', can('settings.write'), (req, res) => {
    const a = pendingApproval(req.params.id);
    if (a.requested_by === req.auth.user.id) throw E.conflict('same_admin', 'a different admin must approve this request', 'the two-person rule needs a second admin');
    if ((req.body || {}).confirm !== 'RESET') throw new ApiError(400, 'confirm_reset_required', s('play.confirm_reset'), 'confirm: type RESET');
    auth.assertFresh(req, 'production_switch');
    const out = executeReset(a, req.auth.user);
    admin.audit(req, 'play_mode.production_switch', 'settings', 'play_mode', { on: true, epoch: JSON.parse(a.preview_json).epoch, approval_id: a.id, requested_by: emailOf(a.requested_by) }, { on: false, ...out }, a.reason);
    res.json({ result: { ...out, launch_email: engine.waitlistOps ? engine.waitlistOps.launchSummary().launch_email : null }, ...stateVo() });
  });
  v1.post('/admin/play_mode/approvals/:id/reject', can('settings.write'), (req, res) => {
    const a = pendingApproval(req.params.id);
    const note = String((req.body || {}).note || '').trim();
    if (note.length < 3 || note.length > 500) throw new ApiError(400, 'validation_failed', 'validation failed', 'note: give a reason of 3-500 characters');
    db.prepare("UPDATE pm_approvals SET status='rejected', decided_by=?, decided_ts=?, decision_note=? WHERE id=?").run(req.auth.user.id, Date.now(), note, a.id);
    admin.audit(req, 'play_mode.production_switch.rejected', 'settings', 'play_mode', approvalVo(a), null, note);
    res.json(stateVo());
  });
  // Per-user money controls (Admin › Users).
  v1.get('/admin/users/:id/money_controls', can('users.read'), (req, res) => {
    const u = db.prepare('SELECT id FROM users WHERE id=?').get(String(req.params.id));
    if (!u) throw E.notFound();
    res.json({ money_controls: controlsVo(u.id), history: db.prepare('SELECT * FROM money_control_history WHERE user_id=? ORDER BY ts DESC LIMIT 50').all(u.id).map((h) => ({ deposits_revoked: !!h.deposits_revoked, withdrawals_revoked: !!h.withdrawals_revoked, reason: h.reason, actor_email: h.actor_email, time: new Date(h.ts).toISOString() })) });
  });
  v1.put('/admin/users/:id/money_controls', can('users.money'), (req, res) => {
    const u = db.prepare('SELECT id, is_system FROM users WHERE id=?').get(String(req.params.id));
    if (!u) throw E.notFound();
    const b = checkBody(req.body || {}, { deposits_revoked: { type: 'boolean', required: true }, withdrawals_revoked: { type: 'boolean', required: true }, reason: { type: 'string', maxLen: 500, required: true } }, { unknown: 'reject' });
    const reason = reasonOf(b);
    auth.assertFresh(req, 'money_controls');
    const before = controlsRow(u.id);
    tx(db, () => {
      db.prepare('INSERT INTO money_controls(user_id,deposits_revoked,withdrawals_revoked,reason,updated_by,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET deposits_revoked=excluded.deposits_revoked, withdrawals_revoked=excluded.withdrawals_revoked, reason=excluded.reason, updated_by=excluded.updated_by, updated_at=excluded.updated_at')
        .run(u.id, b.deposits_revoked ? 1 : 0, b.withdrawals_revoked ? 1 : 0, reason, req.auth.user.id, nowIso());
      db.prepare('INSERT INTO money_control_history(id,user_id,deposits_revoked,withdrawals_revoked,reason,actor_id,actor_email,ts) VALUES(?,?,?,?,?,?,?,?)').run(newId('mch_'), u.id, b.deposits_revoked ? 1 : 0, b.withdrawals_revoked ? 1 : 0, reason, req.auth.user.id, req.auth.user.email, Date.now());
      admin.audit(req, 'users.money_controls', 'user', u.id, { deposits_revoked: !!before.deposits_revoked, withdrawals_revoked: !!before.withdrawals_revoked, reason: before.reason }, { deposits_revoked: b.deposits_revoked, withdrawals_revoked: b.withdrawals_revoked }, reason);
    });
    // The user sees the change at once (flag bundle nudge on their own sockets) and gets a notice (CMS template).
    const off = b.deposits_revoked && b.withdrawals_revoked ? 'both' : b.deposits_revoked ? 'deposits' : b.withdrawals_revoked ? 'withdrawals' : null;
    const wasOff = before.deposits_revoked && before.withdrawals_revoked ? 'both' : before.deposits_revoked ? 'deposits' : before.withdrawals_revoked ? 'withdrawals' : null;
    try {
      if (off) feat.notify(u.id, { type: 'money_controls', title: s('notify.controls.title', { what: s(`notify.controls.what.${off}`) }), body: s('notify.controls.body', { reason }), link: '/funds' });
      else if (wasOff) feat.notify(u.id, { type: 'money_controls', title: s('notify.controls.title_on', { what: s(`notify.controls.what.${wasOff}`) }), body: s('notify.controls.body', { reason }), link: '/funds' });
    } catch (e) { console.error('controls notify', e.message); }
    engine.emit('feature_flags_user', u.id, { version: flags.version, keys: ['money_controls'] });
    res.json({ money_controls: controlsVo(u.id) });
  });

  // ---------------------------------------------------------------- ledger audit checks (server/journal.js hooks)
  function auditChecks(dbx, got) {
    const problems = [];
    // Every entry of the current epoch carries the current money mode: play and real money never mix.
    const ep = epoch(); const md = mode();
    const mixed = dbx.prepare('SELECT COUNT(*) c FROM journal_entries WHERE money_epoch=? AND money_mode<>?').get(ep, md).c
      + (hasTable(dbx, 'perp_journal_entries') ? dbx.prepare('SELECT COUNT(*) c FROM perp_journal_entries WHERE money_epoch=? AND money_mode<>?').get(ep, md).c : 0);
    if (mixed) problems.push({ check: 'money_mode_mixed', expected_cents: 0, actual_cents: mixed, detail: `entries of epoch ${ep} written in another money mode` });
    // A real-money epoch holds no play-money postings.
    if (md === 'real') { const minted = dbx.prepare("SELECT COALESCE(SUM(p.amount_cents),0) c FROM journal_postings p JOIN journal_entries e ON e.id=p.entry_id WHERE e.money_epoch=? AND p.account=?").get(ep, MINT).c; if (minted) problems.push({ check: 'play_money_in_real_epoch', account: MINT, expected_cents: 0, actual_cents: minted, detail: 'play money minted during a real-money epoch' }); }
    if (got('bank:vault') < 0) problems.push({ check: 'vault_non_negative', account: 'bank:vault', expected_cents: 0, actual_cents: got('bank:vault'), detail: 'the Central Bank vault is overdrawn' });
    return problems;
  }
  INSTANCES.set(db, { grantBonus, auditChecks });
  installSharedHooks();

  return { isOn, mode, epoch, settings, realMoney, preview, assertMoney, controlsVo, executeReset, grantBonus, playDeposit };
}

module.exports = { mountPlayMode, installMarkers, MINT };
