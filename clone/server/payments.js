'use strict';
// Payments, sandbox only (PLAN Phase 4: P4.1 rails, P4.2 holds / limits / AML / reconciliation / ledger audit;
// CLONE_SPEC.md §26). No real money, no real providers: the rails are the in-process sandbox providers of
// server/payment-providers.js, which report every status change through the signed webhook endpoint below.
//
// Route families mirror the observed web-client funds API (CLONE_SPEC.md §6, §26.1; vendor names replaced by neutral
// ones), all under /v1/users/:uid unless marked:
//   generic  GET|POST deposits, GET|POST withdrawals (with method_id: a rail; without: the demo-funds method),
//            GET withdrawal_times, GET payments/metadata (per-method min / max / fee / availability / ETA, balances),
//            GET credit_history, GET withdrawal_addresses
//   cards    GET debit/cards, DELETE debit/cards/:id, POST debit/payment_session, POST debit/payment,
//            GET debit/payment_status_web?payment_id=, POST debit/payment/:id/challenge, POST debit/withdrawal
//   bank     POST|GET bank_link/accounts, DELETE bank_link/accounts/:id, POST bank_link/deposit, POST bank_link/withdrawal,
//            GET banks/all_accounts, POST banks/linked_accounts, DELETE banks/linked_accounts/:bank_id
//   crypto   GET|PUT crypto/account, GET|POST crypto/wallets, DELETE crypto/wallets/:wallet_id, POST crypto/withdrawal,
//            POST crypto/simulate_deposit (sandbox); global GET /v1/payments/supported_networks
//   global   POST /v1/payments/tokenize/card (isolated tokenizer), POST /v1/payments/webhooks/:provider
// Every deposit / withdrawal creation on a rail requires Idempotency-Key; withdrawals and new payout destinations need
// step-up (withdrawal two-factor when on). Admin routes, reconciliation and the ledger audit job: server/payments-admin.js.
const express = require('express');
const { tx } = require('./db');
const { newId, dollars, ApiError, E } = require('./util');
const kc = require('./crypto');
const journal = require('./journal');
const auditChain = require('./audit-chain');
const { createSandbox, TEST_CARDS, INSTITUTIONS, BANK_ACCOUNTS, PROVIDERS, RAIL_OF, PROVIDER_OF, SIG_HEADER, webhookKey, signature, EXAMPLE_ADDRESSES } = require('./payment-providers');
const { mountPaymentsAdmin } = require('./payments-admin');

const MIN = 60000; const HOUR = 60 * MIN; const DAY = 24 * HOUR;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS payment_methods (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL, provider TEXT NOT NULL, token TEXT,
  label TEXT NOT NULL DEFAULT '', brand TEXT, last4 TEXT, exp_month INTEGER, exp_year INTEGER, institution TEXT, mask TEXT, subtype TEXT, address TEXT, network TEXT,
  status TEXT NOT NULL DEFAULT 'active', cooling_until INTEGER, created_ts INTEGER NOT NULL, removed_ts INTEGER);
CREATE INDEX IF NOT EXISTS idx_payment_methods_user ON payment_methods(user_id, status);
CREATE TABLE IF NOT EXISTS payment_transactions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, direction TEXT NOT NULL, rail TEXT NOT NULL, method_id TEXT,
  amount_cents INTEGER NOT NULL, fee_cents INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, provider TEXT, provider_ref TEXT, failure_code TEXT, hold_id TEXT,
  confirmations INTEGER NOT NULL DEFAULT 0, label TEXT NOT NULL DEFAULT '', created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL, completed_ts INTEGER);
CREATE INDEX IF NOT EXISTS idx_payment_tx_user ON payment_transactions(user_id, created_ts);
CREATE INDEX IF NOT EXISTS idx_payment_tx_provider ON payment_transactions(provider, provider_ref);
CREATE INDEX IF NOT EXISTS idx_payment_tx_status ON payment_transactions(status);
CREATE INDEX IF NOT EXISTS idx_payment_tx_hold ON payment_transactions(hold_id);
CREATE TABLE IF NOT EXISTS crypto_accounts (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, address TEXT NOT NULL UNIQUE, network TEXT NOT NULL DEFAULT 'sandbox', terms_accepted_ts INTEGER NOT NULL, created_ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bank_link_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, institution_id TEXT NOT NULL, accounts TEXT NOT NULL, created_ts INTEGER NOT NULL, expires_ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS card_payment_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_ts INTEGER NOT NULL, expires_ts INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS webhook_events (provider TEXT NOT NULL, event_id TEXT NOT NULL, type TEXT NOT NULL, received_ts INTEGER NOT NULL, PRIMARY KEY (provider, event_id));
CREATE TABLE IF NOT EXISTS webhook_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, provider TEXT NOT NULL, event_id TEXT, type TEXT, outcome TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', ip TEXT);
CREATE INDEX IF NOT EXISTS idx_webhook_log_ts ON webhook_log(ts);
CREATE TABLE IF NOT EXISTS aml_cases (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, rule TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', txn_id TEXT, hold_id TEXT,
  created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL, decided_by TEXT, outcome TEXT, reason TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_aml_cases_status ON aml_cases(status, created_ts);
`;

const DEFAULT_SETTINGS = {
  demo_funds: null, // null = on outside production (PAYMENTS_DEMO_FUNDS overrides)
  rails: { card: true, bank: true, crypto: true },
  limits: { min_cents: 100, card_deposit_max_cents: 250000, bank_deposit_max_cents: 2500000, card_withdrawal_max_cents: 250000, crypto_withdrawal_max_cents: 1000000, withdrawal_day_cents: 2500000, withdrawal_month_cents: 10000000 },
  fees: { crypto_network_fee_cents: 100 },
  crypto: { confirmations: 3, address_cooling_hours: 24 },
  credits: { expiry_days: 30 },
  sandbox: { ach_settle_seconds: 30, payout_seconds: 10, block_seconds: 5 },
  aml: {
    structuring: { action: 'case', threshold_cents: 1000000, band_pct: 10, count: 3, window_hours: 24 },
    rapid_in_out: { action: 'case', pct: 80, window_hours: 24 },
    new_crypto_address: { action: 'hold' },
  },
};
const AML_ACTIONS = ['off', 'case', 'hold'];
const RULE_TEXT = { structuring: 'Several deposits just under the reporting threshold', rapid_in_out: 'Withdrawing most of a recent deposit without trading', new_crypto_address: 'First withdrawal to a new crypto address' };
const STATUS_TEXT = {
  requires_action: 'Needs your confirmation', processing: 'Processing', pending: 'Funds available · settling', settled: 'Settled', succeeded: 'Completed', confirming: 'Confirming',
  failed: 'Failed', returned: 'Returned', held: 'Under review', paid: 'Sent', reversed: 'Returned to balance',
};
const FAIL_TEXT = { card_declined: 'Your card was declined.', insufficient_funds: 'The card has insufficient funds.', authentication_failed: 'The card verification was not completed.', invalid_token: 'This card can no longer be used.',
  R01_insufficient_funds: 'The bank returned the deposit: insufficient funds.', R02_account_closed: 'The bank account is closed.' };
const FINAL = new Set(['succeeded', 'settled', 'failed', 'returned', 'paid', 'reversed']);
const NETWORKS = [{ id: 'sandbox', name: 'Sandbox chain', asset: 'tUSD', address_format: 'tpx1 + 34 lower-case base32 characters (the last 6 are a checksum)', example: EXAMPLE_ADDRESSES[0] }];

const merge = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b || {})) o[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? merge(a[k], v) : v; return o; };
const usd = (c) => `$${(c / 100).toFixed(2)}`;
const centsOf = (v) => {
  const a = typeof v === 'string' && /^\d+(\.\d{1,2})?$/.test(v.trim()) ? Number(v) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(a) || a <= 0 || a > 1000000) return null;
  const c = Math.round(a * 100);
  return Math.abs(c - a * 100) < 1e-6 ? c : null;
};

function mountPayments({ v1, db, engine, auth, identity, security, feat, keyDir, admin, options = {} }) {
  db.exec(SCHEMA);
  journal.init(db);
  const production = process.env.NODE_ENV === 'production';
  const compliance = identity.compliance;
  const D = merge(DEFAULT_SETTINGS, options.settings || {});
  function settings() {
    const r = db.prepare("SELECT value FROM admin_settings WHERE key='payments'").get();
    return merge(D, r ? JSON.parse(r.value) : {});
  }
  const saveSettings = (v, by) => db.prepare("INSERT INTO admin_settings(key,value,updated_at,updated_by) VALUES('payments',?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by").run(JSON.stringify(v), new Date().toISOString(), by || null);
  journal.hooks.creditExpiryDays = () => settings().credits.expiry_days;
  const demoEnabled = () => { const s = settings().demo_funds; if (s != null) return !!s; if (process.env.PAYMENTS_DEMO_FUNDS != null) return process.env.PAYMENTS_DEMO_FUNDS === '1'; return !production; };
  // Sandbox rails stay on outside production; in production they need PAYMENTS_SANDBOX=1 (there are no real providers).
  const sandboxOn = options.sandbox ?? (process.env.PAYMENTS_SANDBOX != null ? process.env.PAYMENTS_SANDBOX === '1' : !production);
  const railOn = (rail) => sandboxOn && !!settings().rails[rail];
  const notify = (uid, m) => { try { feat.notify(uid, { type: 'transfer', link: '/funds', ...m }); } catch (e) { console.error('transfer notify', e.message); } };
  const logSec = (kind, req, detail) => { try { security.bot.record(kind, req, detail); } catch { /* best effort */ } };
  const getUser = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);

  // ------------------------------------------------------------------ webhook receiver (shared by HTTP and in-process delivery)
  const whKeys = Object.fromEntries(PROVIDERS.map((p) => [p, webhookKey(p, keyDir)]));
  const TOLERANCE_S = 300;
  const wlog = db.prepare('INSERT INTO webhook_log(ts,provider,event_id,type,outcome,reason,ip) VALUES(?,?,?,?,?,?,?)');
  // -> {status, code, body}
  function receive({ provider, raw, signatureHeader, ip, req = null }) {
    const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
    const reject = (status, code, reason, ev = {}) => {
      try { wlog.run(Date.now(), clip(provider, 40), clip(ev.id, 80), clip(ev.type, 60), 'rejected', reason, ip || null); } catch { /* ignore */ }
      logSec('webhook_rejected', req, { provider: clip(provider, 40), reason, code, event_id: clip(ev.id, 80) || undefined });
      return { status, code, body: new ApiError(status, code, 'webhook rejected', reason).toJSON() };
    };
    if (!PROVIDERS.includes(provider)) return { status: 404, code: 'not_found', body: E.notFound().toJSON() };
    const h = String(signatureHeader || '');
    const parts = Object.fromEntries(h.split(',').map((p) => p.trim().split('=')).filter((x) => x.length === 2));
    if (!h || !/^\d{9,11}$/.test(parts.t || '') || !/^[0-9a-f]{64}$/.test(parts.v1 || '')) return reject(400, 'webhook_signature_missing', 'missing or malformed signature header');
    const body = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
    if (!kc.safeEqual(parts.v1, signature(whKeys[provider], parts.t, body))) return reject(400, 'webhook_signature_invalid', 'signature does not match');
    if (Math.abs(Math.floor(Date.now() / 1000) - Number(parts.t)) > TOLERANCE_S) return reject(400, 'webhook_timestamp_stale', 'timestamp outside the 5-minute tolerance');
    let ev;
    try { ev = JSON.parse(body); } catch { return reject(400, 'webhook_payload_invalid', 'body is not JSON'); }
    if (!ev || typeof ev.id !== 'string' || !/^[A-Za-z0-9_-]{4,80}$/.test(ev.id) || typeof ev.type !== 'string' || !ev.data || !ev.data.object || typeof ev.data.object !== 'object') return reject(400, 'webhook_payload_invalid', 'event shape not recognised');
    try {
      const fresh = tx(db, () => {
        if (db.prepare('SELECT 1 FROM webhook_events WHERE provider=? AND event_id=?').get(provider, ev.id)) return false;
        db.prepare('INSERT INTO webhook_events(provider,event_id,type,received_ts) VALUES(?,?,?,?)').run(provider, ev.id, ev.type, Date.now());
        applyEvent(provider, ev);
        return true;
      });
      if (!fresh) return reject(409, 'webhook_replayed', 'event id already processed', ev);
    } catch (e) {
      pendingEvents.length = 0;
      console.error('payments webhook', ev.type, e.message);
      try { wlog.run(Date.now(), provider, ev.id, ev.type, 'error', 'handler error (provider retries)', ip || null); } catch { /* ignore */ }
      return { status: 500, code: 'internal_server_error', body: { error: { code: 'internal_server_error', message: 'internal server error' } } };
    }
    wlog.run(Date.now(), provider, ev.id, ev.type, 'accepted', '', ip || null);
    flushEvents();
    return { status: 200, code: null, body: { received: true } };
  }
  const sandbox = createSandbox({ db, keyDir, settings, receiver: (m) => receive(m), quiet: !!options.quiet, pollMs: options.pollMs ?? 150 });

  // App-level routes (server/app.js): raw body, before the session and the shared JSON parser.
  const rawBody = express.raw({ type: () => true, limit: '64kb' });
  function webhookRoute(req, res, next) {
    security.bot.preSessionLimit('anonymous')(req, res, (err) => {
      if (err) return next(err);
      rawBody(req, res, (e2) => {
        if (e2) return res.status(e2.status === 413 ? 413 : 400).json(new ApiError(e2.status === 413 ? 413 : 400, 'webhook_payload_invalid', 'webhook rejected').toJSON());
        const out = receive({ provider: String(req.params.provider), raw: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), signatureHeader: req.get(SIG_HEADER), ip: security.clientIp(req), req });
        res.status(out.status).json(out.body);
      });
    });
  }

  // ------------------------------------------------------------------ isolated card tokenizer (PCI scope)
  // The card number and CVC exist only inside this function: read from this route's own raw-body buffer (the shared JSON
  // parser skips the path, server/validate.js), checked, tokenized by the sandbox vault and dropped. They are never
  // logged, persisted, echoed or put in an error; errors are fixed codes. A tokenization needs a fresh card payment
  // session (POST debit/payment_session) and is rate-limited per user (card-testing control).
  const tokBuckets = new Map();
  const tokRaw = express.raw({ type: () => true, limit: '1kb' });
  function tokenizeRoute(req, res) {
    const fail = (status, code, message) => res.status(status).json({ error: { code, message } });
    if (!req.auth) return fail(401, 'token_authentication_failure', 'token authentication failure');
    if (!railOn('card')) return fail(403, 'rail_disabled', 'card payments are not available');
    const uid = req.auth.user.id; const now = Date.now();
    const b = (tokBuckets.get(uid) || []).filter((t) => now - t < 10 * MIN);
    if (b.length >= 10) return fail(429, 'too_many_requests', 'too many card attempts; try again in a few minutes');
    b.push(now); tokBuckets.set(uid, b);
    if (tokBuckets.size > 50000) tokBuckets.clear();
    tokRaw(req, res, (err) => {
      if (err) return fail(400, 'card_invalid', 'card details could not be read');
      let input = null;
      try { input = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '{}'); } catch { input = null; }
      if (Buffer.isBuffer(req.body)) req.body.fill(0);
      req.body = undefined;
      if (!input || typeof input !== 'object' || Array.isArray(input)) return fail(400, 'card_invalid', 'card details could not be read');
      const sid = typeof input.session_id === 'string' ? input.session_id : '';
      const s = db.prepare('SELECT * FROM card_payment_sessions WHERE id=? AND user_id=? AND expires_ts>? AND uses<5').get(sid, uid, now);
      if (!s) { input = null; return fail(400, 'payment_session_invalid', 'start a new card payment and try again'); }
      db.prepare('UPDATE card_payment_sessions SET uses=uses+1 WHERE id=?').run(s.id);
      try {
        const t = sandbox.card.tokenize(uid, { number: typeof input.number === 'string' ? input.number : '', exp_month: input.exp_month, exp_year: input.exp_year, cvc: typeof input.cvc === 'string' ? input.cvc : '' });
        input = null;
        res.status(201).json({ token: t.token, card: { brand: t.brand, last4: t.last4, exp_month: t.exp_month, exp_year: t.exp_year } });
      } catch (e) {
        input = null;
        const known = ['card_number_invalid', 'card_not_sandbox', 'card_expiry_invalid', 'card_cvc_invalid'];
        return known.includes(e.code) ? fail(400, e.code, e.message) : fail(400, 'card_invalid', 'card details could not be read');
      }
    });
  }

  // ------------------------------------------------------------------ balances
  const cashOf = (uid) => journal.balanceOf(db, journal.accounts.cash(uid));
  const creditsOf = (uid) => Math.max(0, journal.balanceOf(db, journal.accounts.credits(uid)));
  const unsettledOf = (uid) => db.prepare("SELECT COALESCE(SUM(amount_cents),0) c FROM payment_transactions WHERE user_id=? AND direction='deposit' AND rail='bank' AND status='pending'").get(uid).c;
  // Design choices (§26.5): unsettled bank deposits can be traded with at once but not withdrawn until they settle;
  // promotional credits are tradable, never withdrawable. Withdrawable = cash − credits − unsettled (cash excludes credits).
  const withdrawableOf = (uid) => Math.max(0, cashOf(uid) - unsettledOf(uid));
  engine.transferableCents = (uid) => Math.max(0, cashOf(uid)); // perps transfers move cash, not credits (server/perps.js)
  function withdrawnSince(uid, ms) {
    const since = new Date(Date.now() - ms).toISOString();
    const out = db.prepare("SELECT COALESCE(SUM(-amount_cents),0) c FROM ledger WHERE user_id=? AND kind IN ('withdrawal','withdrawal_fee','withdrawal_hold') AND created_at>=?").get(uid, since).c;
    const back = db.prepare("SELECT COALESCE(SUM(amount_cents),0) c FROM ledger WHERE user_id=? AND kind IN ('withdrawal_reversal','withdrawal_hold_reversal') AND created_at>=?").get(uid, since).c;
    return Math.max(0, out - back);
  }
  const monthStart = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
  const dayStart = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
  function limitUsage(uid) {
    const L = settings().limits;
    return { withdrawal_day: { limit_dollars: dollars(L.withdrawal_day_cents), used_dollars: dollars(withdrawnSince(uid, Date.now() - dayStart())) },
      withdrawal_month: { limit_dollars: dollars(L.withdrawal_month_cents), used_dollars: dollars(withdrawnSince(uid, Date.now() - monthStart())) } };
  }
  // Withdrawal limits (UTC day and calendar month), credits and the unsettled-funds rule, for every withdrawal path
  // (rails, demo funds, and the legacy fraud-hold path through compliance.setWithdrawalPrecheck).
  function withdrawalPrecheck(uid, cents) {
    const L = settings().limits;
    const cash = cashOf(uid);
    if (cash < 0) throw new ApiError(409, 'negative_balance', 'your cash balance is negative', `a returned deposit left you owing ${usd(-cash)}; deposit to repay it first`);
    const w = withdrawableOf(uid);
    if (cents > w) {
      const unsettled = unsettledOf(uid); const cr = creditsOf(uid);
      if (engine.balance(uid) >= cents && (unsettled > 0 || cr > 0)) {
        throw new ApiError(409, unsettled > 0 ? 'funds_unsettled' : 'credits_not_withdrawable', 'part of your balance cannot be withdrawn yet',
          `${unsettled > 0 ? `${usd(unsettled)} from bank deposits is still settling` : ''}${unsettled > 0 && cr > 0 ? ' and ' : ''}${cr > 0 ? `${usd(cr)} is promotional credit (tradable, not withdrawable)` : ''}; you can withdraw up to ${usd(w)} now`);
      }
      throw E.conflict('insufficient_balance', 'insufficient balance', `you can withdraw up to ${usd(w)}`);
    }
    const day = withdrawnSince(uid, Date.now() - dayStart());
    if (day + cents > L.withdrawal_day_cents) throw new ApiError(409, 'withdrawal_limit_exceeded', 'this withdrawal would exceed your daily withdrawal limit', `limit ${usd(L.withdrawal_day_cents)} per day; ${usd(Math.max(0, L.withdrawal_day_cents - day))} left today`);
    const month = withdrawnSince(uid, Date.now() - monthStart());
    if (month + cents > L.withdrawal_month_cents) throw new ApiError(409, 'withdrawal_limit_exceeded', 'this withdrawal would exceed your monthly withdrawal limit', `limit ${usd(L.withdrawal_month_cents)} per month; ${usd(Math.max(0, L.withdrawal_month_cents - month))} left this month`);
  }
  compliance.setWithdrawalPrecheck(withdrawalPrecheck);
  // Deposit limit (§13.8) counts deposits already credited today plus rail deposits still on their way.
  function depositPrecheck(uid, cents) {
    const inflight = db.prepare("SELECT COALESCE(SUM(amount_cents),0) c FROM payment_transactions WHERE user_id=? AND direction='deposit' AND status IN ('processing','requires_action','confirming') AND created_ts>=?").get(uid, dayStart()).c;
    feat.checkDeposit(uid, cents + inflight);
  }
  // Observed `nonwithdrawable_credits` shape (HAR5 rewards summary): per product, amount + expiry + the credits.
  function nonwithdrawableCredits(uid) {
    const list = journal.creditAllocation(db, uid).filter((x) => x.remaining_cents > 0).map((x) => ({ id: x.grant.id, source: x.grant.source, amount_cents: x.remaining_cents, amount_dollars: dollars(x.remaining_cents),
      granted_cents: x.grant.amount_cents, expires_time: new Date(x.grant.expires_ts).toISOString(), expiry_days: Math.max(0, Math.ceil((x.grant.expires_ts - Date.now()) / DAY)) }));
    const total = list.reduce((a, c) => a + c.amount_cents, 0);
    return { predictions: { amount_cents: total, amount_dollars: dollars(total), expiry_days: list.length ? Math.min(...list.map((c) => c.expiry_days)) : null, credits: list }, perps: { amount_cents: 0, amount_dollars: dollars(0), credits: [] } };
  }
  // Phase 8 hook (referrals): grant a promotional credit, e.g. once the referee reaches the offer's threshold_cents.
  const grantCredit = (uid, cents, source, ref) => { engine.credit(uid, cents, 'credit', ref ?? null, source); engine.emit('user_balance', uid, engine.balance(uid)); };
  // Expiry job: what is left of an expired grant leaves the credits account (back to the promotions budget).
  function expireCredits() {
    for (const g of db.prepare("SELECT DISTINCT user_id FROM credit_grants WHERE status='active' AND expires_ts<=?").all(Date.now())) {
      tx(db, () => {
        for (const x of journal.creditAllocation(db, g.user_id)) {
          if (x.grant.expires_ts > Date.now()) continue;
          if (x.remaining_cents > 0) engine.credit(g.user_id, -x.remaining_cents, 'credit_expired', x.grant.id, `Promotional credit expired (${x.grant.source})`);
          db.prepare("UPDATE credit_grants SET status='expired', expired_cents=? WHERE id=?").run(x.remaining_cents, x.grant.id);
        }
      });
      engine.emit('user_balance', g.user_id, engine.balance(g.user_id));
    }
  }

  // ------------------------------------------------------------------ AML rule hooks (§26.7)
  function openCase(uid, rule, action, detail, { txnId = null, holdId = null } = {}) {
    const existing = db.prepare("SELECT * FROM aml_cases WHERE user_id=? AND rule=? AND status IN ('open','escalated') AND created_ts>?").get(uid, rule, Date.now() - DAY);
    if (existing && !holdId) {
      const d = JSON.parse(existing.detail);
      db.prepare('UPDATE aml_cases SET detail=?, updated_ts=?, txn_id=COALESCE(?,txn_id) WHERE id=?').run(JSON.stringify({ ...d, ...detail, repeats: (d.repeats || 1) + 1 }), Date.now(), txnId, existing.id);
      return existing.id;
    }
    const id = newId('aml_');
    db.prepare('INSERT INTO aml_cases(id,user_id,rule,status,action,detail,txn_id,hold_id,created_ts,updated_ts) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, uid, rule, 'open', action, JSON.stringify(detail), txnId, holdId, Date.now(), Date.now());
    auditChain.append(db, { actor_id: null, actor_email: null, action: 'aml.case_opened', target_type: 'user', target_id: uid, before: null, after: { case: id, rule, action, txn: txnId, hold: holdId }, reason: RULE_TEXT[rule] });
    return id;
  }
  function amlDeposit(uid, cents) {
    const r = settings().aml.structuring;
    if (r.action === 'off') return [];
    const lo = Math.round(r.threshold_cents * (1 - r.band_pct / 100));
    if (cents < lo || cents >= r.threshold_cents) return [];
    const n = db.prepare("SELECT COUNT(*) c FROM payment_transactions WHERE user_id=? AND direction='deposit' AND amount_cents>=? AND amount_cents<? AND created_ts>=? AND status NOT IN ('failed')").get(uid, lo, r.threshold_cents, Date.now() - r.window_hours * HOUR).c + 1;
    return n >= r.count ? [{ rule: 'structuring', action: 'case', detail: { deposits_in_window: n, band: `${usd(lo)}–${usd(r.threshold_cents - 1)}`, window_hours: r.window_hours } }] : [];
  }
  function amlWithdrawal(uid, cents, method) {
    const S = settings().aml; const hits = [];
    const r = S.rapid_in_out;
    if (r.action !== 'off') {
      const since = new Date(Date.now() - r.window_hours * HOUR).toISOString();
      const dep = db.prepare("SELECT COALESCE(SUM(amount_cents),0) c, MIN(created_at) f FROM ledger WHERE user_id=? AND kind='deposit' AND created_at>=?").get(uid, since);
      const fills = dep.f ? db.prepare('SELECT COUNT(*) c FROM fills WHERE user_id=? AND created_ts>=?').get(uid, Date.parse(dep.f)).c : 0;
      if (dep.c > 0 && cents * 100 >= dep.c * r.pct && fills === 0) hits.push({ rule: 'rapid_in_out', action: r.action, detail: { deposited_dollars: dollars(dep.c), withdrawal_dollars: dollars(cents), window_hours: r.window_hours } });
    }
    if (method && method.type === 'crypto_address' && S.new_crypto_address.action !== 'off') {
      const used = db.prepare("SELECT 1 FROM payment_transactions WHERE method_id=? AND direction='withdrawal' AND status IN ('processing','paid') LIMIT 1").get(method.id);
      if (!used) hits.push({ rule: 'new_crypto_address', action: S.new_crypto_address.action, detail: { address: maskAddr(method.address), added_time: new Date(method.created_ts).toISOString() } });
    }
    return hits;
  }
  const maskAddr = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-6)}` : null);

  // ------------------------------------------------------------------ serializers
  function methodVo(m) {
    const base = { id: m.id, type: m.type, label: m.label, status: m.status, created_time: new Date(m.created_ts).toISOString(), can_deposit: m.type !== 'crypto_address', can_withdraw: true };
    if (m.type === 'card') return { ...base, brand: m.brand, last4: m.last4, exp_month: m.exp_month, exp_year: m.exp_year, can_withdraw: !!cardPaidIn(m.id) };
    if (m.type === 'bank') return { ...base, bank_id: m.id, institution: m.institution, mask: m.mask, subtype: m.subtype };
    return { ...base, wallet_id: m.id, network: m.network || 'sandbox', address: m.address, address_masked: maskAddr(m.address), cooling_until: m.cooling_until ? new Date(m.cooling_until).toISOString() : null, cooling: !!(m.cooling_until && m.cooling_until > Date.now()), can_deposit: false };
  }
  const cardPaidIn = (methodId) => db.prepare("SELECT 1 FROM payment_transactions WHERE method_id=? AND direction='deposit' AND status='succeeded' LIMIT 1").get(methodId);
  function txnVo(t) {
    return { id: t.id, direction: t.direction, rail: t.rail, method_id: t.method_id, amount_dollars: dollars(t.amount_cents), fee_dollars: dollars(t.fee_cents), net_dollars: dollars(t.amount_cents - t.fee_cents), status: t.status, status_label: STATUS_TEXT[t.status] || t.status,
      final: FINAL.has(t.status), failure_code: t.failure_code, failure_message: t.failure_code ? FAIL_TEXT[t.failure_code] || 'The payment did not go through.' : null, label: t.label, confirmations: t.confirmations,
      confirmations_required: t.rail === 'crypto' && t.direction === 'deposit' ? settings().crypto.confirmations : null, hold_id: t.hold_id, created_time: new Date(t.created_ts).toISOString(), updated_time: new Date(t.updated_ts).toISOString(),
      completed_time: t.completed_ts ? new Date(t.completed_ts).toISOString() : null, challenge: t.status === 'requires_action' ? { path: `/funds/challenge/${t.id}` } : null };
  }
  const txn = (id) => db.prepare('SELECT * FROM payment_transactions WHERE id=?').get(id);
  const ownTxn = (uid, id) => { const t = txn(String(id || '')); if (!t || t.user_id !== uid) throw E.notFound(); return t; };
  const ownMethod = (uid, id, type) => {
    const m = db.prepare("SELECT * FROM payment_methods WHERE id=? AND user_id=? AND status='active'").get(String(id || ''), uid);
    if (!m || (type && m.type !== type)) throw new ApiError(404, 'payment_method_not_found', 'payment method not found');
    return m;
  };
  const setTxn = (id, fields) => { const ks = Object.keys(fields); db.prepare(`UPDATE payment_transactions SET ${ks.map((k) => `${k}=?`).join(', ')}, updated_ts=? WHERE id=?`).run(...ks.map((k) => fields[k]), Date.now(), id); return txn(id); };
  const pendingEvents = [];
  const changed = (t) => { pendingEvents.push([t.user_id, txnVo(t)]); };
  function flushEvents() {
    while (pendingEvents.length) {
      const [uid, vo] = pendingEvents.shift();
      engine.emit('payment', uid, vo);
      engine.emit('user_balance', uid, engine.balance(uid));
    }
  }
  function newTxn(uid, f) {
    const id = newId('pt_');
    db.prepare('INSERT INTO payment_transactions(id,user_id,direction,rail,method_id,amount_cents,fee_cents,status,provider,provider_ref,hold_id,label,created_ts,updated_ts,completed_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, uid, f.direction, f.rail, f.method_id ?? null, f.amount, f.fee ?? 0, f.status, f.provider ?? null, f.provider_ref ?? null, f.hold_id ?? null, f.label ?? '', Date.now(), Date.now(), FINAL.has(f.status) ? Date.now() : null);
    return txn(id);
  }
  const labelOf = (m) => (m.type === 'card' ? `${m.brand === 'mastercard' ? 'Mastercard' : 'Visa'} •••• ${m.last4}` : m.type === 'bank' ? `${m.institution} •••• ${m.mask}` : `Crypto ${maskAddr(m.address)}`);
  const RAIL_OF_TYPE = { card: 'card', bank: 'bank', crypto_address: 'crypto' };

  // ------------------------------------------------------------------ webhook effects (the only path that changes rail state)
  function applyEvent(provider, ev) {
    const o = ev.data.object;
    const rail = RAIL_OF[provider];
    let t = o.merchant_ref ? txn(String(o.merchant_ref)) : db.prepare('SELECT * FROM payment_transactions WHERE provider=? AND provider_ref=?').get(provider, String(o.id));
    if (ev.type === 'crypto_deposit.detected') {
      if (t) return;
      const acct = db.prepare('SELECT * FROM crypto_accounts WHERE address=?').get(String(o.address || ''));
      if (!acct) return; // not one of our addresses: nothing to credit
      t = newTxn(acct.user_id, { direction: 'deposit', rail: 'crypto', amount: o.amount_cents, status: 'confirming', provider, provider_ref: o.id, label: `Crypto deposit to ${maskAddr(acct.address)}` });
      changed(t);
      return;
    }
    if (!t || t.provider !== provider) return; // unknown to us: reconciliation reports it (missing_in_ledger)
    const uid = t.user_id;
    const done = (fields) => { t = setTxn(t.id, { ...fields, ...(FINAL.has(fields.status) ? { completed_ts: Date.now() } : {}) }); changed(t); };
    switch (ev.type) {
      case 'charge.succeeded':
        if (!['processing', 'requires_action'].includes(t.status)) return;
        engine.credit(uid, t.amount_cents, 'deposit', t.id, `Card deposit · ${t.label}`, { contra: 'clearing:card' });
        done({ status: 'succeeded' });
        notify(uid, { title: `Deposit of ${usd(t.amount_cents)} completed`, body: `${t.label} · cash balance ${usd(engine.balance(uid))}` });
        return;
      case 'charge.failed':
        if (!['processing', 'requires_action'].includes(t.status)) return;
        done({ status: 'failed', failure_code: String(o.failure_code || 'card_declined').slice(0, 40) });
        notify(uid, { title: `Deposit of ${usd(t.amount_cents)} failed`, body: FAIL_TEXT[o.failure_code] || 'The payment did not go through.' });
        return;
      case 'charge.requires_action':
        if (t.status === 'processing') done({ status: 'requires_action' });
        return;
      case 'ach_debit.pending':
        if (t.status !== 'processing') return;
        engine.credit(uid, t.amount_cents, 'deposit', t.id, `Bank deposit · ${t.label} (settling)`, { contra: 'clearing:bank' });
        done({ status: 'pending' });
        notify(uid, { title: `Deposit of ${usd(t.amount_cents)} is on its way`, body: 'You can trade with it now; it can be withdrawn once the bank settles it.' });
        return;
      case 'ach_debit.settled':
        if (t.status !== 'pending') return;
        done({ status: 'settled' });
        notify(uid, { title: `Deposit of ${usd(t.amount_cents)} settled`, body: `${t.label} · it can now be withdrawn` });
        return;
      case 'ach_debit.returned': {
        if (!['pending', 'processing'].includes(t.status)) return;
        // Documented rule (§26.5): the return always comes out of cash, which may go negative (a debt). Credits are not
        // touched; a negative cash balance blocks withdrawals until a deposit repays it.
        if (t.status === 'pending') engine.credit(uid, -t.amount_cents, 'deposit_return', t.id, `Bank deposit returned (${o.failure_code || 'return'})`, { contra: 'clearing:bank' });
        done({ status: 'returned', failure_code: String(o.failure_code || 'R01_insufficient_funds').slice(0, 40) });
        const c = cashOf(uid);
        notify(uid, { title: `Your bank returned a deposit of ${usd(t.amount_cents)}`, body: c < 0 ? `It was already used, so you owe ${usd(-c)}. Your next deposit repays it first; withdrawals are paused until then.` : FAIL_TEXT[o.failure_code] || 'The deposit was taken back out of your balance.' });
        return;
      }
      case 'payout.paid': case 'crypto_withdrawal.confirmed': {
        if (t.status !== 'processing') return;
        const net = t.amount_cents - t.fee_cents;
        journal.post(db, { kind: 'payout_paid', ref: t.id, userId: uid, memo: 'provider paid the withdrawal out' }, [[`payouts:${rail}`, -net], [`clearing:${rail}`, net]]);
        done({ status: 'paid', confirmations: Number(o.confirmations) || t.confirmations });
        notify(uid, { title: `Withdrawal of ${usd(t.amount_cents)} sent`, body: rail === 'crypto' ? `${usd(net)} sent to ${t.label.replace(/^Crypto /, '')} (network fee ${usd(t.fee_cents)})` : t.label });
        return;
      }
      case 'payout.failed': {
        if (t.status !== 'processing') return;
        const net = t.amount_cents - t.fee_cents;
        engine.credit(uid, net, 'withdrawal_reversal', t.id, `Withdrawal failed: returned to balance (${o.failure_code || 'failed'})`, { contra: `payouts:${rail}` });
        if (t.fee_cents) engine.credit(uid, t.fee_cents, 'withdrawal_reversal', t.id, 'Withdrawal fee refunded', { contra: 'house:fees:network' });
        done({ status: 'failed', failure_code: String(o.failure_code || 'payout_failed').slice(0, 40) });
        notify(uid, { title: `Withdrawal of ${usd(t.amount_cents)} failed`, body: `${FAIL_TEXT[o.failure_code] || 'It could not be delivered.'} The money is back in your balance.` });
        return;
      }
      case 'crypto_deposit.confirmation': {
        if (t.status !== 'confirming') return;
        const need = settings().crypto.confirmations;
        const c = Math.max(t.confirmations, Number(o.confirmations) || 0);
        if (c < need) { done({ status: 'confirming', confirmations: c }); return; }
        engine.credit(uid, t.amount_cents, 'deposit', t.id, `Crypto deposit (${c} confirmations)`, { contra: 'clearing:crypto' });
        done({ status: 'succeeded', confirmations: c });
        notify(uid, { title: `Crypto deposit of ${usd(t.amount_cents)} confirmed`, body: `${c} confirmations · cash balance ${usd(engine.balance(uid))}` });
        return;
      }
      default:
    }
  }

  // ------------------------------------------------------------------ deposits / withdrawals
  const requireKey = (req) => { if (!req.get('idempotency-key')) throw new ApiError(400, 'idempotency_key_required', 'an Idempotency-Key header is required', 'send a new random key per deposit or withdrawal; resend the same key when retrying it'); };
  const parseAmount = (b) => { const c = centsOf(b && b.amount_dollars); if (c == null) throw new ApiError(400, 'validation_failed', 'validation failed', 'amount_dollars: a positive amount with at most 2 decimals'); return c; };

  function createDeposit(req, m) {
    const uid = req.auth.user.id;
    requireKey(req);
    const cents = parseAmount(req.body);
    const L = settings().limits;
    if (m.type === 'crypto_address') throw new ApiError(400, 'crypto_deposit_address', 'crypto deposits are sent to your deposit address', 'see crypto/account for your address');
    const rail = m.type;
    if (!railOn(rail)) throw new ApiError(403, 'rail_disabled', `${rail} deposits are not available right now`);
    if (cents < L.min_cents) throw new ApiError(400, 'amount_too_small', `the minimum deposit is ${usd(L.min_cents)}`);
    const max = rail === 'card' ? L.card_deposit_max_cents : L.bank_deposit_max_cents;
    if (cents > max) throw new ApiError(400, 'amount_too_large', `the maximum ${rail} deposit is ${usd(max)}`);
    depositPrecheck(uid, cents);
    const a = compliance.assess(uid, req, 'deposit', cents);
    const hits = amlDeposit(uid, cents);
    const t = tx(db, () => {
      compliance.saveAssessment(uid, 'deposit', cents, a, 'allow');
      let row = newTxn(uid, { direction: 'deposit', rail, method_id: m.id, amount: cents, status: 'processing', provider: PROVIDER_OF[rail], label: labelOf(m) });
      for (const h of hits) openCase(uid, h.rule, h.action, h.detail, { txnId: row.id });
      const rec = rail === 'card' ? sandbox.card.charge({ ref: row.id, token: m.token, amount_cents: cents }) : sandbox.bank.debit({ ref: row.id, token: m.token, amount_cents: cents });
      row = setTxn(row.id, { provider_ref: rec.id });
      return row;
    });
    return { status: 201, body: { transaction: txnVo(t), payment_id: t.id } };
  }

  function createWithdrawal(req, m) {
    const uid = req.auth.user.id;
    requireKey(req);
    const cents = parseAmount(req.body);
    const S = settings(); const L = S.limits;
    const rail = RAIL_OF_TYPE[m.type];
    if (!railOn(rail)) throw new ApiError(403, 'rail_disabled', `${rail} withdrawals are not available right now`);
    if (rail === 'card' && !cardPaidIn(m.id)) throw new ApiError(409, 'card_payout_not_eligible', 'withdrawals go only to a card you have deposited with', 'deposit with this card first, or withdraw to a bank account');
    const fee = rail === 'crypto' ? S.fees.crypto_network_fee_cents : 0;
    if (cents < Math.max(L.min_cents, fee + 1)) throw new ApiError(400, 'amount_too_small', `the minimum withdrawal is ${usd(Math.max(L.min_cents, fee + 1))}`);
    const max = rail === 'crypto' ? L.crypto_withdrawal_max_cents : rail === 'card' ? L.card_withdrawal_max_cents : null;
    if (max != null && cents > max) throw new ApiError(400, 'amount_too_large', `the maximum ${rail} withdrawal is ${usd(max)}`);
    if (m.type === 'crypto_address' && m.cooling_until && m.cooling_until > Date.now()) {
      throw new ApiError(409, 'destination_cooling', 'this address is new: withdrawals to it open after a cooling period', `available from ${new Date(m.cooling_until).toISOString()}`);
    }
    withdrawalPrecheck(uid, cents);
    const a = compliance.assess(uid, req, 'withdrawal', cents);
    const hits = amlWithdrawal(uid, cents, m);
    const fraudHold = compliance.holdsEnabled() && a.score >= identity.settings().fraud.hold_threshold;
    const hold = fraudHold || hits.some((h) => h.action === 'hold');
    const label = labelOf(m);
    const t = tx(db, () => {
      compliance.saveAssessment(uid, 'withdrawal', cents, a, hold ? 'hold' : 'allow');
      if (hold) {
        const holdId = compliance.createHold(uid, cents, a.score, [...a.signals, ...hits.filter((h) => h.action === 'hold').map((h) => ({ code: `aml_${h.rule}`, points: 0, label: RULE_TEXT[h.rule] }))], { link: '/funds' });
        const row = newTxn(uid, { direction: 'withdrawal', rail, method_id: m.id, amount: cents, fee, status: 'held', provider: PROVIDER_OF[rail], hold_id: holdId, label });
        for (const h of hits) openCase(uid, h.rule, h.action, h.detail, { txnId: row.id, holdId: h.action === 'hold' ? holdId : null });
        return row;
      }
      const row = newTxn(uid, { direction: 'withdrawal', rail, method_id: m.id, amount: cents, fee, status: 'processing', provider: PROVIDER_OF[rail], label });
      for (const h of hits) openCase(uid, h.rule, h.action, h.detail, { txnId: row.id });
      engine.credit(uid, -(cents - fee), 'withdrawal', row.id, `Withdrawal to ${label}`, { contra: `payouts:${rail}` });
      if (fee) engine.credit(uid, -fee, 'withdrawal_fee', row.id, 'Crypto network fee');
      return startPayout(row, m);
    });
    if (hold) auth.logEvent(uid, 'withdrawal_held', req, { payment: t.id, hold_id: t.hold_id, score: a.score });
    return { status: hold ? 202 : 201, body: { transaction: txnVo(t), payment_id: t.id, ...(hold ? { status: 'held', hold_id: t.hold_id, message: 'Your withdrawal is being reviewed before it is sent.' } : {}), balance_dollars: dollars(engine.balance(uid)) } };
  }
  function startPayout(row, m) {
    const net = row.amount_cents - row.fee_cents;
    const rec = row.rail === 'bank' ? sandbox.bank.payout({ ref: row.id, token: m.token, amount_cents: net })
      : row.rail === 'card' ? sandbox.card.payout({ ref: row.id, token: m.token, amount_cents: net }) : sandbox.crypto.send({ ref: row.id, address: m.address, amount_cents: net });
    return setTxn(row.id, { status: 'processing', provider_ref: rec.id });
  }
  // A held rail withdrawal: release sends it to the provider; reverse returns it (compliance credits the reversal).
  compliance.onHoldDecision((h, action) => {
    const row = db.prepare('SELECT * FROM payment_transactions WHERE hold_id=?').get(h.id);
    if (!row || row.status !== 'held') return false;
    if (action === 'reverse') { changed(setTxn(row.id, { status: 'reversed', completed_ts: Date.now() })); setImmediate(flushEvents); return false; }
    const m = db.prepare('SELECT * FROM payment_methods WHERE id=?').get(row.method_id);
    const net = row.amount_cents - row.fee_cents;
    journal.post(db, { kind: 'withdrawal_hold_release', ref: h.id, userId: row.user_id, memo: 'held withdrawal released to the provider' }, [[journal.accounts.held(row.user_id), -row.amount_cents], [`payouts:${row.rail}`, net], ['house:fees:network', row.fee_cents]]);
    changed(startPayout(row, m)); setImmediate(flushEvents);
    return true;
  });

  // Demo funds: the generic POST deposits / withdrawals without a method_id (non-production; journaled; limits, AML).
  function demoDeposit(req) {
    if (!demoEnabled()) throw new ApiError(403, 'demo_funds_disabled', 'demo funds are not available', 'choose a payment method (method_id)');
    const uid = req.auth.user.id;
    const cents = parseAmount(req.body);
    const hits = amlDeposit(uid, cents);
    tx(db, () => {
      feat.checkDeposit(uid, cents);
      const row = newTxn(uid, { direction: 'deposit', rail: 'demo', amount: cents, status: 'succeeded', label: 'Demo funds' });
      engine.credit(uid, cents, 'deposit', row.id, 'simulated deposit');
      for (const h of hits) openCase(uid, h.rule, h.action, h.detail, { txnId: row.id });
    });
    engine.emit('user_balance', uid, engine.balance(uid));
    return { status: 201, body: { balance_dollars: dollars(engine.balance(uid)) } };
  }
  function demoWithdraw(req) {
    if (!demoEnabled()) throw new ApiError(403, 'demo_funds_disabled', 'demo funds are not available', 'choose a payout method (method_id)');
    const uid = req.auth.user.id;
    const cents = parseAmount(req.body);
    if (engine.balance(uid) < cents) throw E.conflict('insufficient_balance', 'insufficient balance');
    withdrawalPrecheck(uid, cents);
    const hits = amlWithdrawal(uid, cents, null);
    if (hits.some((h) => h.action === 'hold')) {
      const holdId = tx(db, () => {
        const id = compliance.createHold(uid, cents, 0, hits.filter((h) => h.action === 'hold').map((h) => ({ code: `aml_${h.rule}`, points: 0, label: RULE_TEXT[h.rule] })));
        for (const h of hits) openCase(uid, h.rule, h.action, h.detail, { holdId: h.action === 'hold' ? id : null });
        return id;
      });
      engine.emit('user_balance', uid, engine.balance(uid));
      return { status: 202, body: { status: 'held', hold_id: holdId, amount_dollars: dollars(cents), balance_dollars: dollars(engine.balance(uid)), message: 'Your withdrawal is being reviewed before it is sent.' } };
    }
    tx(db, () => {
      const row = newTxn(uid, { direction: 'withdrawal', rail: 'demo', amount: cents, status: 'paid', label: 'Demo funds' });
      engine.credit(uid, -cents, 'withdrawal', row.id, 'simulated withdrawal');
      for (const h of hits) openCase(uid, h.rule, h.action, h.detail, { txnId: row.id });
    });
    engine.emit('user_balance', uid, engine.balance(uid));
    return { status: 201, body: { balance_dollars: dollars(engine.balance(uid)) } };
  }

  // ------------------------------------------------------------------ routes
  const requireUser = (req, res, next) => {
    if (!req.auth) return next(E.unauthorized());
    if (req.params.uid && req.params.uid !== req.auth.user.id) return next(E.forbidden('cannot access another user'));
    next();
  };
  const send = (res, out) => { res.status(out.status).json(out.body); flushEvents(); };
  const U = '/users/:uid';
  const list = (uid, type) => db.prepare("SELECT * FROM payment_methods WHERE user_id=? AND status='active' AND type=? ORDER BY created_ts DESC").all(uid, type).map(methodVo);
  const removeMethod = (req, type) => {
    const m = ownMethod(req.auth.user.id, req.params.id, type);
    db.prepare("UPDATE payment_methods SET status='removed', removed_ts=? WHERE id=?").run(Date.now(), m.id);
    auth.logEvent(req.auth.user.id, 'payment_method_removed', req, { type: m.type, method: m.id });
    return { ok: true };
  };
  function insertMethod(uid, f) {
    if (db.prepare("SELECT COUNT(*) c FROM payment_methods WHERE user_id=? AND status='active'").get(uid).c >= 20) throw E.conflict('too_many_payment_methods', 'at most 20 saved payment methods');
    const id = newId('pm_');
    db.prepare('INSERT INTO payment_methods(id,user_id,type,provider,token,label,brand,last4,exp_month,exp_year,institution,mask,subtype,address,network,cooling_until,created_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, uid, f.type, f.provider, f.token ?? null, String(f.label || '').slice(0, 40), f.brand ?? null, f.last4 ?? null, f.exp_month ?? null, f.exp_year ?? null, f.institution ?? null, f.mask ?? null, f.subtype ?? null, f.address ?? null, f.network ?? null, f.cooling_until ?? null, Date.now());
    return db.prepare('SELECT * FROM payment_methods WHERE id=?').get(id);
  }
  function destinationAdded(req, m) {
    auth.logEvent(req.auth.user.id, 'payment_method_added', req, { type: m.type, method: m.id });
    try { auth.alertUser(getUser(req.auth.user.id), 'New withdrawal destination added', `${labelOf(m)} was added as a withdrawal destination.${m.cooling_until ? ` Withdrawals to it open ${new Date(m.cooling_until).toUTCString()}.` : ''}`); } catch { /* ignore */ }
  }

  // ---- generic
  function methodsMeta() {
    const S = settings(); const L = S.limits;
    return [
      { type: 'card', label: 'Debit card', available: railOn('card'), deposit: { min_dollars: dollars(L.min_cents), max_dollars: dollars(L.card_deposit_max_cents), fee_dollars: dollars(0), eta: 'instant' },
        withdrawal: { min_dollars: dollars(L.min_cents), max_dollars: dollars(L.card_withdrawal_max_cents), fee_dollars: dollars(0), eta: 'minutes (sandbox)', note: 'only to a card you deposited with' } },
      { type: 'bank', label: 'Bank account (ACH)', available: railOn('bank'), deposit: { min_dollars: dollars(L.min_cents), max_dollars: dollars(L.bank_deposit_max_cents), fee_dollars: dollars(0), eta: 'funds usable at once; settles in 1–3 business days' },
        withdrawal: { min_dollars: dollars(L.min_cents), max_dollars: null, fee_dollars: dollars(0), eta: '1–3 business days' } },
      { type: 'crypto', label: 'Crypto (sandbox chain)', available: railOn('crypto'), deposit: { min_dollars: dollars(L.min_cents), max_dollars: null, fee_dollars: dollars(0), eta: `${S.crypto.confirmations} confirmations` },
        withdrawal: { min_dollars: dollars(Math.max(L.min_cents, S.fees.crypto_network_fee_cents + 1)), max_dollars: dollars(L.crypto_withdrawal_max_cents), fee_dollars: dollars(S.fees.crypto_network_fee_cents), eta: 'about 10 minutes (1 block)' } },
      ...(demoEnabled() ? [{ type: 'demo', label: 'Demo funds (simulated, instant)', available: true, deposit: { min_dollars: dollars(1), max_dollars: dollars(10000000), fee_dollars: dollars(0), eta: 'instant' }, withdrawal: { min_dollars: dollars(1), max_dollars: null, fee_dollars: dollars(0), eta: 'instant' } }] : []),
    ];
  }
  function withdrawalTimes() {
    const S = settings();
    return [
      { method: 'bank', label: 'Bank account (ACH)', estimate: '1–3 business days', sandbox_seconds: S.sandbox.payout_seconds, available: railOn('bank') },
      { method: 'card', label: 'Debit card', estimate: 'within 30 minutes', sandbox_seconds: S.sandbox.payout_seconds, available: railOn('card') },
      { method: 'crypto', label: 'Crypto (sandbox chain)', estimate: 'about 10 minutes (1 block)', sandbox_seconds: S.sandbox.block_seconds, network_fee_dollars: dollars(S.fees.crypto_network_fee_cents), available: railOn('crypto') },
      ...(demoEnabled() ? [{ method: 'demo', label: 'Demo funds', estimate: 'instant', sandbox_seconds: 0, available: true }] : []),
    ];
  }
  v1.get(`${U}/payments/metadata`, requireUser, (req, res) => {
    const uid = req.auth.user.id; const S = settings(); const c = cashOf(uid);
    res.json({
      sandbox: sandboxOn, demo_funds: demoEnabled(), methods: methodsMeta(),
      balances: { balance_dollars: dollars(engine.balance(uid)), cash_dollars: dollars(c), withdrawable_dollars: dollars(withdrawableOf(uid)), unsettled_dollars: dollars(unsettledOf(uid)),
        nonwithdrawable_credits_dollars: dollars(creditsOf(uid)), owed_dollars: dollars(Math.max(0, -c)), held_dollars: dollars(db.prepare("SELECT COALESCE(SUM(amount_cents),0) c FROM withdrawal_holds WHERE user_id=? AND status='held'").get(uid).c) },
      nonwithdrawable_credits: nonwithdrawableCredits(uid), limits: limitUsage(uid),
      crypto: { confirmations: S.crypto.confirmations, address_cooling_hours: S.crypto.address_cooling_hours },
      card_behaviors: TEST_CARDS.map((t) => ({ last4: t.number.slice(-4), brand: t.brand, behavior: t.behavior, label: t.label })),
      institutions: INSTITUTIONS, bank_accounts: BANK_ACCOUNTS.map((a) => ({ name: a.name, mask: a.mask, hint: a.hint })),
    });
  });
  v1.get('/payments/supported_networks', (req, res) => res.json({ networks: NETWORKS.map((n) => ({ ...n, available: railOn('crypto'), confirmations: settings().crypto.confirmations, withdrawal_fee_dollars: dollars(settings().fees.crypto_network_fee_cents) })) }));
  v1.get(`${U}/withdrawal_times`, requireUser, (req, res) => res.json({ withdrawal_times: withdrawalTimes() }));
  v1.get(`${U}/credit_history`, requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const alloc = new Map(journal.creditAllocation(db, uid).map((x) => [x.grant.id, x.remaining_cents]));
    const rows = db.prepare('SELECT * FROM credit_grants WHERE user_id=? ORDER BY created_ts DESC LIMIT 200').all(uid);
    res.json({ nonwithdrawable_credits: nonwithdrawableCredits(uid), credits: rows.map((g) => ({ id: g.id, source: g.source, product: g.product, granted_dollars: dollars(g.amount_cents), remaining_dollars: dollars(g.status === 'active' ? alloc.get(g.id) || 0 : 0),
      expired_dollars: dollars(g.expired_cents), status: g.status === 'active' && !(alloc.get(g.id) > 0) ? 'used' : g.status, granted_time: new Date(g.created_ts).toISOString(), expires_time: new Date(g.expires_ts).toISOString() })) });
  });
  const txList = (uid, direction, limit) => db.prepare('SELECT * FROM payment_transactions WHERE user_id=? AND direction=? ORDER BY created_ts DESC, rowid DESC LIMIT ?').all(uid, direction, limit).map(txnVo);
  v1.get(`${U}/deposits`, requireUser, (req, res) => res.json({ deposits: txList(req.auth.user.id, 'deposit', Math.min(200, Math.max(1, Number(req.query.limit) || 50))) }));
  v1.get(`${U}/withdrawals`, requireUser, (req, res) => res.json({ withdrawals: txList(req.auth.user.id, 'withdrawal', Math.min(200, Math.max(1, Number(req.query.limit) || 50))) }));
  // POST deposits / withdrawals are registered in server/app.js (their original place) and call these.
  const generic = {
    deposit: (req, res) => send(res, req.body && req.body.method_id ? createDeposit(req, ownMethod(req.auth.user.id, req.body.method_id)) : demoDeposit(req)),
    withdraw: (req, res) => send(res, req.body && req.body.method_id ? createWithdrawal(req, ownMethod(req.auth.user.id, req.body.method_id)) : demoWithdraw(req)),
  };
  v1.get(`${U}/withdrawal_addresses`, requireUser, (req, res) => res.json({ withdrawal_addresses: list(req.auth.user.id, 'crypto_address') }));

  // ---- cards
  v1.get(`${U}/debit/cards`, requireUser, (req, res) => res.json({ cards: list(req.auth.user.id, 'card') }));
  v1.delete(`${U}/debit/cards/:id`, requireUser, (req, res) => res.json(removeMethod(req, 'card')));
  v1.post(`${U}/debit/payment_session`, requireUser, (req, res) => {
    if (!railOn('card')) throw new ApiError(403, 'rail_disabled', 'card payments are not available');
    const id = newId('cps_');
    db.prepare('DELETE FROM card_payment_sessions WHERE expires_ts<?').run(Date.now() - DAY);
    db.prepare('INSERT INTO card_payment_sessions(id,user_id,created_ts,expires_ts) VALUES(?,?,?,?)').run(id, req.auth.user.id, Date.now(), Date.now() + 15 * MIN);
    res.status(201).json({ session_id: id, expires_time: new Date(Date.now() + 15 * MIN).toISOString(), tokenize_path: '/v1/payments/tokenize/card' });
  });
  v1.post(`${U}/debit/payment`, requireUser, (req, res) => {
    const uid = req.auth.user.id; const b = req.body;
    requireKey(req);
    let m;
    if (b.card_id) m = ownMethod(uid, b.card_id, 'card');
    else {
      const info = sandbox.card.tokenInfo(b.token || '', uid);
      if (!info) throw new ApiError(400, 'card_token_invalid', 'enter the card again');
      m = db.prepare("SELECT * FROM payment_methods WHERE user_id=? AND token=? AND status='active'").get(uid, info.token)
        || insertMethod(uid, { type: 'card', provider: 'sandbox_card', token: info.token, brand: info.brand, last4: info.last4, exp_month: info.exp_month, exp_year: info.exp_year, label: b.label || 'Debit card' });
    }
    send(res, createDeposit(req, m));
  });
  v1.get(`${U}/debit/payment_status_web`, requireUser, (req, res) => res.json({ payment: txnVo(ownTxn(req.auth.user.id, req.query.payment_id)) }));
  v1.post(`${U}/debit/payment/:id/challenge`, requireUser, (req, res) => {
    const t = ownTxn(req.auth.user.id, req.params.id);
    if (t.status !== 'requires_action') throw E.conflict('no_challenge', 'this payment does not need a confirmation');
    sandbox.card.completeChallenge(t.provider_ref, req.body.result);
    res.json({ payment: txnVo(txn(t.id)), message: 'Your answer was sent to the card issuer.' });
  });
  v1.post(`${U}/debit/withdrawal`, requireUser, (req, res) => send(res, createWithdrawal(req, ownMethod(req.auth.user.id, req.body.card_id, 'card'))));

  // ---- bank (the bank-link provider's accounts, then the exchange's linked accounts)
  v1.post(`${U}/bank_link/accounts`, requireUser, (req, res) => {
    if (!railOn('bank')) throw new ApiError(403, 'rail_disabled', 'bank transfers are not available right now');
    const uid = req.auth.user.id;
    let link;
    try { link = sandbox.bank.link(uid, { institution_id: req.body.institution_id, username: req.body.username, password: req.body.password }); } catch (e) {
      if (e.code) { auth.logEvent(uid, 'bank_link_failed', req, { reason: e.code }); throw new ApiError(400, e.code, e.message); }
      throw e;
    }
    db.prepare('INSERT INTO bank_link_sessions(id,user_id,institution_id,accounts,created_ts,expires_ts) VALUES(?,?,?,?,?,?)').run(link.link_id, uid, link.institution.id, JSON.stringify(link.accounts.map((a) => a.account_id)), Date.now(), Date.now() + 30 * MIN);
    res.status(201).json({ link_id: link.link_id, institution: link.institution, accounts: link.accounts });
  });
  v1.get(`${U}/bank_link/accounts`, requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const linked = new Set(db.prepare("SELECT token FROM payment_methods WHERE user_id=? AND type='bank' AND status='active'").all(uid).map((r) => r.token));
    const rows = db.prepare('SELECT a.*, s.expires_ts FROM sbx_bank_accounts a JOIN bank_link_sessions s ON s.id=a.link_id WHERE a.user_id=? AND (s.expires_ts>? OR a.token IN (SELECT token FROM payment_methods WHERE user_id=? AND status=\'active\')) ORDER BY a.created_ts DESC LIMIT 60').all(uid, Date.now(), uid);
    res.json({ accounts: rows.map((a) => ({ account_id: a.token, link_id: a.link_id, institution: INSTITUTIONS.find((i) => i.id === a.institution_id)?.name, name: a.name, mask: a.mask, subtype: a.subtype, linked: linked.has(a.token) })) });
  });
  v1.delete(`${U}/bank_link/accounts/:id`, requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const a = sandbox.bank.account(req.params.id, uid);
    if (!a) throw E.notFound();
    db.prepare("UPDATE payment_methods SET status='removed', removed_ts=? WHERE user_id=? AND token=? AND status='active'").run(Date.now(), uid, a.token);
    db.prepare('UPDATE bank_link_sessions SET expires_ts=0 WHERE id=? AND user_id=?').run(a.link_id, uid);
    res.json({ ok: true });
  });
  v1.post(`${U}/bank_link/deposit`, requireUser, (req, res) => send(res, createDeposit(req, ownMethod(req.auth.user.id, req.body.bank_id, 'bank'))));
  v1.post(`${U}/bank_link/withdrawal`, requireUser, (req, res) => send(res, createWithdrawal(req, ownMethod(req.auth.user.id, req.body.bank_id, 'bank'))));
  v1.get(`${U}/banks/all_accounts`, requireUser, (req, res) => res.json({ accounts: list(req.auth.user.id, 'bank') }));
  v1.post(`${U}/banks/linked_accounts`, requireUser, (req, res) => {
    if (!railOn('bank')) throw new ApiError(403, 'rail_disabled', 'bank transfers are not available right now');
    const uid = req.auth.user.id; const b = req.body;
    const link = db.prepare('SELECT * FROM bank_link_sessions WHERE id=? AND user_id=? AND expires_ts>?').get(String(b.link_id || ''), uid, Date.now());
    if (!link || !JSON.parse(link.accounts).includes(String(b.account_id || ''))) throw new ApiError(400, 'bank_link_invalid', 'link the bank again and choose an account');
    const acct = sandbox.bank.account(b.account_id, uid);
    if (db.prepare("SELECT 1 FROM payment_methods WHERE user_id=? AND token=? AND status='active'").get(uid, acct.token)) throw E.conflict('payment_method_exists', 'this account is already linked');
    const m = insertMethod(uid, { type: 'bank', provider: 'sandbox_bank', token: acct.token, institution: INSTITUTIONS.find((i) => i.id === acct.institution_id).name, mask: acct.mask, subtype: acct.subtype, label: b.label || acct.name });
    destinationAdded(req, m);
    res.status(201).json({ account: methodVo(m) });
  });
  v1.delete(`${U}/banks/linked_accounts/:id`, requireUser, (req, res) => res.json(removeMethod(req, 'bank')));

  // ---- crypto
  const cryptoAccountRow = (uid) => db.prepare('SELECT * FROM crypto_accounts WHERE user_id=?').get(uid);
  const cryptoAccountVo = (a) => ({ enabled: !!a, terms_accepted: !!a, address: a ? a.address : null, network: a ? a.network : null, asset: 'tUSD', confirmations_required: settings().crypto.confirmations,
    terms: 'Sandbox chain only: test tokens with no value. Deposits are credited after the required confirmations; withdrawals to a new address open after a cooling period.' });
  v1.get(`${U}/crypto/account`, requireUser, (req, res) => res.json({ account: cryptoAccountVo(cryptoAccountRow(req.auth.user.id)) }));
  v1.put(`${U}/crypto/account`, requireUser, (req, res) => {
    if (!railOn('crypto')) throw new ApiError(403, 'rail_disabled', 'crypto transfers are not available right now');
    if (req.body.accept_terms !== true) throw new ApiError(400, 'terms_required', 'accept the crypto terms to open a deposit address');
    const uid = req.auth.user.id;
    if (!cryptoAccountRow(uid)) db.prepare('INSERT INTO crypto_accounts(user_id,address,network,terms_accepted_ts,created_ts) VALUES(?,?,?,?,?)').run(uid, sandbox.crypto.newAddress(), 'sandbox', Date.now(), Date.now());
    res.json({ account: cryptoAccountVo(cryptoAccountRow(uid)) });
  });
  v1.get(`${U}/crypto/wallets`, requireUser, (req, res) => res.json({ wallets: list(req.auth.user.id, 'crypto_address') }));
  v1.post(`${U}/crypto/wallets`, requireUser, (req, res) => {
    if (!railOn('crypto')) throw new ApiError(403, 'rail_disabled', 'crypto transfers are not available right now');
    const uid = req.auth.user.id; const b = req.body;
    if ((b.network || 'sandbox') !== 'sandbox') throw new ApiError(400, 'network_unsupported', 'only the sandbox chain is supported');
    const addr = String(b.address || '').trim();
    if (!sandbox.crypto.validAddress(addr)) throw new ApiError(400, 'crypto_address_invalid', 'that is not a valid sandbox-chain address', 'addresses start with tpx1, are 38 characters long and end in a checksum');
    if (db.prepare('SELECT 1 FROM crypto_accounts WHERE address=?').get(addr)) throw new ApiError(400, 'crypto_address_internal', 'that is a Parlance deposit address; send to an external wallet');
    if (db.prepare("SELECT 1 FROM payment_methods WHERE user_id=? AND address=? AND status='active'").get(uid, addr)) throw E.conflict('payment_method_exists', 'this address is already saved');
    const hours = settings().crypto.address_cooling_hours;
    const m = insertMethod(uid, { type: 'crypto_address', provider: 'sandbox_crypto', address: addr, network: 'sandbox', label: b.label || 'Crypto wallet', cooling_until: hours > 0 ? Date.now() + hours * HOUR : null });
    destinationAdded(req, m);
    res.status(201).json({ wallet: methodVo(m) });
  });
  v1.delete(`${U}/crypto/wallets/:id`, requireUser, (req, res) => res.json(removeMethod(req, 'crypto_address')));
  v1.post(`${U}/crypto/withdrawal`, requireUser, (req, res) => send(res, createWithdrawal(req, ownMethod(req.auth.user.id, req.body.wallet_id, 'crypto_address'))));
  v1.post(`${U}/crypto/simulate_deposit`, requireUser, (req, res) => {
    if (!railOn('crypto')) throw new ApiError(403, 'rail_disabled', 'crypto transfers are not available right now');
    const uid = req.auth.user.id;
    const a = cryptoAccountRow(uid);
    if (!a) throw new ApiError(409, 'crypto_account_required', 'open your crypto deposit address first');
    const cents = parseAmount(req.body);
    if (cents < settings().limits.min_cents) throw new ApiError(400, 'amount_too_small', `the minimum deposit is ${usd(settings().limits.min_cents)}`);
    depositPrecheck(uid, cents);
    const hits = amlDeposit(uid, cents);
    const rec = tx(db, () => { const r = sandbox.crypto.simulateIncoming({ address: a.address, amount_cents: cents }); for (const h of hits) openCase(uid, h.rule, h.action, h.detail); return r; });
    res.status(202).json({ provider_ref: rec.id, status: 'detected', message: 'Broadcast on the sandbox chain; credited after the required confirmations.' });
  });

  // ------------------------------------------------------------------ admin, reconciliation, ledger audit, jobs
  const pendingPayouts = (rail) => db.prepare("SELECT COALESCE(SUM(amount_cents-fee_cents),0) c FROM payment_transactions WHERE rail=? AND direction='withdrawal' AND status='processing'").get(rail).c;
  const adminApi = mountPaymentsAdmin({ v1, db, engine, auth, admin, sandbox, settings, saveSettings, D, AML_ACTIONS, RULE_TEXT, txnVo, pendingPayouts, demoEnabled, sandboxOn, expireCredits, options });

  sandbox.start();
  return {
    webhookRoute, tokenizeRoute, generic, settings, withdrawableOf, receive, sandbox, admin: adminApi, grantCredit,
    setDeliveryBase: (b) => sandbox.setBase(b),
    close: () => { sandbox.stop(); adminApi.stop(); },
  };
}

module.exports = { mountPayments, DEFAULT_SETTINGS };
