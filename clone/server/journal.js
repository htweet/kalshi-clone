'use strict';
// Double-entry journal (PLAN P4.2; CLONE_SPEC.md §26.6). Sits beside the single-entry `ledger` table, which stays the
// user-facing statement (History, Your activity, CSV, tax documents). Every change to users.balance_cents is journaled
// centrally from server/engine.js (credit(), ledgerOnly() and the order reservation), so no call site needs to know.
//
// Model: an entry has two or more postings whose signed amounts sum to zero. Accounts are strings:
//   user:<uid>:cash        withdrawable cash the exchange owes the user (may go negative after a returned deposit)
//   user:<uid>:credits     non-withdrawable promotional credits: tradable, not withdrawable, they expire
//                          (cash + credits = users.balance_cents)
//   user:<uid>:reserved    funds held by resting orders (= SUM(orders.reserved_cents))
//   user:<uid>:held        withdrawals held for review (= SUM(withdrawal_holds.amount_cents WHERE status='held'))
//   escrow:<ticker>        contract collateral of a market (= open interest: SUM(yes_count) = SUM(no_count), in cents)
//   clearing:<rail>        receivable from / settled with a payment provider (card, bank, crypto, demo)
//   payouts:<rail>         withdrawals accepted but not yet paid out by the provider
//   house:fees, house:fees:network, house:interest, house:promotions, house:adjustments, perps:collateral,
//   payouts:closure, equity:opening (opening balances of databases created before the journal), house:suspense
// User-side accounts carry positive balances (liabilities); the exchange's own asset accounts carry the mirror image.
//
// Credits (observed `nonwithdrawable_credits`, CLONE_SPEC.md §26.5): a `credit` ledger entry (promo codes, rewards) is
// posted to user:<uid>:credits. An order reservation spends credits first; money an order releases (cancel, unused fee
// reserve) goes back to credits first, up to what that order took from them (journal_order_credits); fills, netting and
// settlement pay out cash. Debits that are not credit-aware (an admin adjustment, account closure) take cash first and
// then credits. Each grant expires (credit_grants.expires_ts); the payments job removes what is left of it.
//
// The audit (audit()) proves: every entry balances; every user's cash + credits equals users.balance_cents and its
// reserved / held accounts equal their tables; every market's escrow equals its open interest; pending payouts equal the
// pending withdrawals; the materialised balances equal the posting sums.
const { newId } = require('./util');
const { tx } = require('./db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS journal_entries (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT, user_id TEXT, memo TEXT NOT NULL DEFAULT '', ledger_id TEXT);
CREATE INDEX IF NOT EXISTS idx_journal_entries_ref ON journal_entries(ref);
CREATE INDEX IF NOT EXISTS idx_journal_entries_ts ON journal_entries(ts);
CREATE TABLE IF NOT EXISTS journal_postings (id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT NOT NULL REFERENCES journal_entries(id), account TEXT NOT NULL, amount_cents INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_journal_postings_account ON journal_postings(account);
CREATE INDEX IF NOT EXISTS idx_journal_postings_entry ON journal_postings(entry_id);
CREATE TABLE IF NOT EXISTS journal_balances (account TEXT PRIMARY KEY, balance_cents INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS journal_order_credits (order_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, credit_cents INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS credit_grants (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, source TEXT NOT NULL, ref TEXT, amount_cents INTEGER NOT NULL, created_ts INTEGER NOT NULL, expires_ts INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', expired_cents INTEGER NOT NULL DEFAULT 0, product TEXT NOT NULL DEFAULT 'predictions');
CREATE INDEX IF NOT EXISTS idx_credit_grants_user ON credit_grants(user_id, status, expires_ts);
CREATE TABLE IF NOT EXISTS ledger_audits (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, ok INTEGER NOT NULL, entries INTEGER NOT NULL, problems TEXT NOT NULL DEFAULT '[]', trigger TEXT NOT NULL DEFAULT 'job');
`;
const OPENED_KEY = 'journal_opened_v1';
const ready = new WeakSet();
// Default lifetime of a promotional credit (days); server/payments.js sets it from Admin › Payments settings.
const hooks = { creditExpiryDays: () => 30 };

const cash = (uid) => `user:${uid}:cash`;
const credits = (uid) => `user:${uid}:credits`;
const reserved = (uid) => `user:${uid}:reserved`;
const held = (uid) => `user:${uid}:held`;

function init(db) {
  if (ready.has(db)) return;
  db.exec(SCHEMA);
  ready.add(db);
}
const balanceOf = (db, account) => { init(db); return db.prepare('SELECT balance_cents c FROM journal_balances WHERE account=?').get(account)?.c ?? 0; };

// Post one balanced entry. postings: [[account, cents], ...]; zero postings are dropped; same-account postings merge.
function post(db, { kind, ref = null, userId = null, memo = '', ledgerId = null, ts = Date.now() }, postings) {
  init(db);
  const m = new Map();
  for (const [a, c] of postings) {
    if (typeof a !== 'string' || !a || !Number.isInteger(c)) throw new Error(`journal: invalid posting (${kind})`);
    m.set(a, (m.get(a) || 0) + c);
  }
  const list = [...m].filter(([, c]) => c !== 0);
  if (!list.length) return null;
  const sum = list.reduce((a, [, c]) => a + c, 0);
  if (sum !== 0) throw new Error(`journal: unbalanced entry (${kind}, sum ${sum})`);
  const id = newId('je_');
  return tx(db, () => {
    db.prepare('INSERT INTO journal_entries(id,ts,kind,ref,user_id,memo,ledger_id) VALUES(?,?,?,?,?,?,?)').run(id, ts, kind, ref, userId, String(memo).slice(0, 300), ledgerId);
    const ins = db.prepare('INSERT INTO journal_postings(entry_id,account,amount_cents) VALUES(?,?,?)');
    const bal = db.prepare('INSERT INTO journal_balances(account,balance_cents) VALUES(?,?) ON CONFLICT(account) DO UPDATE SET balance_cents=balance_cents+excluded.balance_cents');
    for (const [a, c] of list) { ins.run(id, a, c); bal.run(a, c); }
    return id;
  });
}

// Contra account for an engine.credit(uid, cents, kind, ref) — the money comes from / goes to this account.
// Payment rails pass an explicit contra (server/payments.js); the table covers every existing call site.
function contraFor(db, uid, kind, ref) {
  switch (kind) {
    case 'refund': return reserved(uid); // a resting order's reservation released back
    case 'netting': case 'settlement': return `escrow:${ref}`;
    case 'withdrawal_hold': case 'withdrawal_hold_reversal': return held(uid);
    case 'interest': return 'house:interest';
    case 'credit': case 'credit_expired': return 'house:promotions';
    case 'adjustment': return 'house:adjustments';
    case 'perps_transfer': return 'perps:collateral';
    case 'closure_payout': return 'payouts:closure';
    case 'deposit': case 'withdrawal': return 'clearing:demo'; // the simulated instant "demo funds" method
    case 'withdrawal_fee': return 'house:fees:network';
    default: return 'house:suspense';
  }
}

// Which user account(s) a credit() moves: [[account, cents], ...] summing to `cents`.
function userSide(db, uid, cents, kind, ref) {
  if (kind === 'credit' || kind === 'credit_expired') return [[credits(uid), cents]];
  if (kind === 'refund' && cents > 0 && ref) {
    const oc = db.prepare('SELECT credit_cents c FROM journal_order_credits WHERE order_id=?').get(ref)?.c || 0;
    const back = Math.min(oc, cents);
    if (back > 0) db.prepare('UPDATE journal_order_credits SET credit_cents=credit_cents-? WHERE order_id=?').run(back, ref);
    return [[credits(uid), back], [cash(uid), cents - back]];
  }
  // Debits that may exceed withdrawable cash (admin adjustment, account closure): cash first, then credits.
  if (cents < 0 && (kind === 'adjustment' || kind === 'closure_payout')) {
    const c = Math.max(0, balanceOf(db, cash(uid)));
    const fromCash = Math.min(c, -cents);
    return [[cash(uid), -fromCash], [credits(uid), cents + fromCash]];
  }
  return [[cash(uid), cents]];
}

// engine.credit(): the user's balance moves by `cents`; the contra takes the opposite.
function onCredit(db, { userId, cents, kind, ref, memo, ledgerId, contra }) {
  const side = userSide(db, userId, cents, kind, ref);
  const to = contra || contraFor(db, userId, kind, ref);
  // Closure forfeits unused credits to the house instead of paying them out.
  const credPart = side.find(([a]) => a === credits(userId))?.[1] || 0;
  const contraPostings = kind === 'closure_payout' && credPart ? [[to, -(cents - credPart)], ['house:promotions', -credPart]] : [[to, -cents]];
  post(db, { kind, ref, userId, memo, ledgerId }, [...side, ...contraPostings]);
  if (kind === 'credit' && cents > 0) {
    const days = Math.max(1, Number(hooks.creditExpiryDays()) || 30);
    db.prepare('INSERT INTO credit_grants(id,user_id,source,ref,amount_cents,created_ts,expires_ts) VALUES(?,?,?,?,?,?,?)').run(newId('cg_'), userId, String(memo || 'credit').slice(0, 80), ref ?? null, cents, Date.now(), Date.now() + days * 86400000);
  }
}

// engine.ledgerOnly(): no balance movement — the cost leaves the order reservation (trade principal into the market's
// escrow, taker fee to the house).
function onLedgerOnly(db, { userId, cents, kind, ref, memo, ledgerId }) {
  let to;
  if (kind === 'trade') {
    const t = db.prepare('SELECT market_ticker FROM trades WHERE id=?').get(ref);
    to = t ? `escrow:${t.market_ticker}` : 'house:suspense';
  } else if (kind === 'fee') to = 'house:fees';
  else to = 'house:suspense';
  post(db, { kind, ref, userId, memo, ledgerId }, [[reserved(userId), cents], [to, -cents]]);
}

// The order reservation (engine.placeOrder): credits first, then cash → reserved.
function onReserve(db, userId, orderId, cents) {
  const c = Math.max(0, balanceOf(db, credits(userId)));
  const fromCredits = Math.min(c, cents);
  if (fromCredits > 0) db.prepare('INSERT INTO journal_order_credits(order_id,user_id,credit_cents) VALUES(?,?,?) ON CONFLICT(order_id) DO UPDATE SET credit_cents=credit_cents+excluded.credit_cents').run(orderId, userId, fromCredits);
  post(db, { kind: 'order_reserve', ref: orderId, userId, memo: 'held for order' }, [[credits(userId), -fromCredits], [cash(userId), -(cents - fromCredits)], [reserved(userId), cents]]);
}

// A held legacy withdrawal released by staff: the funds leave the hold as the payout (no balance movement).
function onHoldReleased(db, hold, toAccount = 'clearing:demo') {
  post(db, { kind: 'withdrawal_hold_release', ref: hold.id, userId: hold.user_id, memo: 'held withdrawal released' }, [[held(hold.user_id), -hold.amount_cents], [toAccount, hold.amount_cents]]);
}

// Unused credit per active grant: the balance of user:<uid>:credits is attributed to the grants that expire last
// (credits are spent soonest-expiring first). -> [{grant, remaining_cents}]
function creditAllocation(db, uid) {
  init(db);
  let left = Math.max(0, balanceOf(db, credits(uid)));
  const grants = db.prepare("SELECT * FROM credit_grants WHERE user_id=? AND status='active' ORDER BY expires_ts DESC, created_ts DESC").all(uid);
  const out = [];
  for (const g of grants) { const r = Math.min(g.amount_cents, left); left -= r; out.push({ grant: g, remaining_cents: r }); }
  return out.reverse();
}

// Opening balances for a user created outside the journal (seed data, system users) or a database that predates it.
function openUser(db, uid, memo = 'opening balance') {
  init(db);
  const u = db.prepare('SELECT balance_cents FROM users WHERE id=?').get(uid);
  if (!u) return;
  const r = db.prepare('SELECT COALESCE(SUM(reserved_cents),0) c FROM orders WHERE user_id=?').get(uid).c;
  const h = hasTable(db, 'withdrawal_holds') ? db.prepare("SELECT COALESCE(SUM(amount_cents),0) c FROM withdrawal_holds WHERE user_id=? AND status='held'").get(uid).c : 0;
  post(db, { kind: 'opening_balance', userId: uid, memo }, [[cash(uid), u.balance_cents], [reserved(uid), r], [held(uid), h], ['equity:opening', -(u.balance_cents + r + h)]]);
}
const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

// Migration (idempotent): the first time, every user's cash / reservations / holds and every market's open interest get
// an opening entry against equity:opening. Afterwards, any user with money but no postings at all (a system account
// inserted with a balance) is opened the same way.
function migrate(db) {
  init(db);
  const accountUsed = db.prepare('SELECT 1 FROM journal_balances WHERE account IN (?,?,?) LIMIT 1');
  const first = !db.prepare('SELECT 1 FROM meta WHERE key=?').get(OPENED_KEY);
  tx(db, () => {
    for (const u of db.prepare('SELECT id FROM users').all()) {
      if (accountUsed.get(cash(u.id), reserved(u.id), held(u.id))) continue;
      openUser(db, u.id, first ? 'opening balance (journal migration)' : 'opening balance (account created outside the journal)');
    }
    if (first) {
      for (const m of db.prepare('SELECT market_ticker t, SUM(yes_count) y FROM positions GROUP BY market_ticker HAVING SUM(yes_count)>0').all()) {
        if (balanceOf(db, `escrow:${m.t}`) !== 0) continue;
        post(db, { kind: 'opening_balance', ref: m.t, memo: 'open interest (journal migration)' }, [[`escrow:${m.t}`, m.y], ['equity:opening', -m.y]]);
      }
      db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING').run(OPENED_KEY, new Date().toISOString());
    }
  });
}

// Ledger audit. Returns {ok, entries, problems:[{check, account?, expected_cents, actual_cents, detail}], totals}.
// `pendingPayouts(rail)` (from server/payments.js) gives the expected payouts:<rail> balance.
function audit(db, { pendingPayouts = null } = {}) {
  init(db);
  const problems = [];
  const entries = db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c;
  for (const r of db.prepare('SELECT entry_id, SUM(amount_cents) s, COUNT(*) n FROM journal_postings GROUP BY entry_id HAVING s<>0 OR n<2 LIMIT 50').all()) problems.push({ check: 'entry_balanced', entry_id: r.entry_id, expected_cents: 0, actual_cents: r.s, detail: 'postings of this entry do not sum to zero' });
  const sums = new Map(db.prepare('SELECT account, SUM(amount_cents) s FROM journal_postings GROUP BY account').all().map((r) => [r.account, r.s]));
  const got = (a) => sums.get(a) || 0;
  for (const r of db.prepare('SELECT account, balance_cents b FROM journal_balances').all()) if (r.b !== got(r.account)) problems.push({ check: 'materialised_balance', account: r.account, expected_cents: got(r.account), actual_cents: r.b, detail: 'journal_balances differs from the posting sum' });
  const cmp = (check, account, expected, detail, actual = got(account)) => { if (actual !== expected) problems.push({ check, account, expected_cents: expected, actual_cents: actual, detail }); };
  const users = db.prepare('SELECT id, balance_cents FROM users').all();
  const res = new Map(db.prepare('SELECT user_id, SUM(reserved_cents) c FROM orders GROUP BY user_id').all().map((r) => [r.user_id, r.c]));
  const holds = hasTable(db, 'withdrawal_holds') ? new Map(db.prepare("SELECT user_id, SUM(amount_cents) c FROM withdrawal_holds WHERE status='held' GROUP BY user_id").all().map((r) => [r.user_id, r.c])) : new Map();
  const known = new Set();
  for (const u of users) {
    for (const a of [cash(u.id), credits(u.id), reserved(u.id), held(u.id)]) known.add(a);
    cmp('user_balance', cash(u.id), u.balance_cents, 'users.balance_cents vs cash + credits postings', got(cash(u.id)) + got(credits(u.id)));
    if (got(credits(u.id)) < 0) problems.push({ check: 'credits_non_negative', account: credits(u.id), expected_cents: 0, actual_cents: got(credits(u.id)), detail: 'credit balance below zero' });
    cmp('user_reserved', reserved(u.id), res.get(u.id) || 0, 'order reservations vs postings');
    cmp('user_held', held(u.id), holds.get(u.id) || 0, 'withdrawal holds vs postings');
  }
  for (const [a, s] of sums) if (a.startsWith('user:') && !known.has(a) && s !== 0) problems.push({ check: 'orphan_account', account: a, expected_cents: 0, actual_cents: s, detail: 'postings for a user that no longer exists' });
  const oi = new Map(db.prepare('SELECT market_ticker t, SUM(yes_count) y, SUM(no_count) n FROM positions GROUP BY market_ticker').all().map((r) => [r.t, r]));
  const markets = new Set([...oi.keys(), ...[...sums.keys()].filter((a) => a.startsWith('escrow:')).map((a) => a.slice(7))]);
  for (const t of markets) {
    const p = oi.get(t) || { y: 0, n: 0 };
    if (p.y !== p.n) problems.push({ check: 'open_interest_pairs', account: `escrow:${t}`, expected_cents: p.y, actual_cents: p.n, detail: 'YES and NO open interest differ' });
    cmp('escrow', `escrow:${t}`, p.y, 'market escrow vs open interest');
  }
  if (pendingPayouts) for (const rail of ['bank', 'crypto', 'card']) cmp('pending_payouts', `payouts:${rail}`, pendingPayouts(rail), 'pending withdrawals vs postings');
  if (got('house:suspense') !== 0) problems.push({ check: 'suspense', account: 'house:suspense', expected_cents: 0, actual_cents: got('house:suspense'), detail: 'money posted to the suspense account (an unmapped ledger kind)' });
  const totals = {};
  for (const [a, s] of sums) {
    const k = /^user:.*:(cash|credits|reserved|held)$/.exec(a)?.[1];
    const key = k ? `user ${k}` : a.startsWith('escrow:') ? 'market escrow' : a;
    totals[key] = (totals[key] || 0) + s;
  }
  const grand = [...sums.values()].reduce((a, b) => a + b, 0);
  if (grand !== 0) problems.push({ check: 'trial_balance', expected_cents: 0, actual_cents: grand, detail: 'all postings together do not sum to zero' });
  return { ok: problems.length === 0, entries, problems, totals, accounts_checked: users.length * 4 + markets.size };
}

function recordAudit(db, result, trigger = 'job') {
  init(db);
  const id = newId('la_');
  db.prepare('INSERT INTO ledger_audits(id,ts,ok,entries,problems,trigger) VALUES(?,?,?,?,?,?)').run(id, Date.now(), result.ok ? 1 : 0, result.entries, JSON.stringify(result.problems.slice(0, 200)), trigger);
  db.prepare('DELETE FROM ledger_audits WHERE ts<?').run(Date.now() - 90 * 86400000);
  return id;
}

module.exports = { init, post, onCredit, onLedgerOnly, onReserve, onHoldReleased, openUser, migrate, audit, recordAudit, balanceOf, contraFor, creditAllocation, hooks, accounts: { cash, credits, reserved, held } };
