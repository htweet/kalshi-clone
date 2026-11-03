'use strict';
// Sandbox payment providers (PLAN P4.1; CLONE_SPEC.md §26.2–§26.4). In-process simulations only: no provider SDKs, no
// network calls to anyone, no real money, invented institutions and test numbers.
//
// Interface (one object per rail, like server/kyc.js's sandbox provider):
//   card   { name:'sandbox_card', rail:'card',   tokenize(input), charge({ref, token, amount_cents}), completeChallenge(providerRef, result) }
//   bank   { name:'sandbox_bank', rail:'bank',   institutions(), link({institution_id, username, password}), debit({ref, token, amount_cents}), payout({ref, token, amount_cents}) }
//   crypto { name:'sandbox_crypto', rail:'crypto', newAddress(), validAddress(a), simulateIncoming({address, amount_cents}), send({ref, address, amount_cents}), mine(n) }
// Every call returns the provider's own record ({id, status, ...}). Status changes after that are never pushed into the
// exchange directly: the provider side writes them to its own tables (sbx_provider_records), queues a webhook event
// (sbx_webhook_outbox) and a delivery worker POSTs it, HMAC-signed, to /v1/payments/webhooks/<provider> — the same path
// and verification a real provider would use (loopback HTTP once the server is listening; before that, or without a
// server, the identical verify-and-apply function in process). Delayed transitions (ACH settlement or return, payouts,
// blocks) are rows in sbx_provider_jobs with an absolute due time, so a restart resumes them.
//
// The card vault keeps a token, brand, last 4, expiry and the sandbox behaviour of the test number — never the number or
// the CVC. Only the documented test numbers are accepted; any other (possibly real) number is refused and not kept.
const crypto = require('node:crypto');
const http = require('node:http');
const { newId } = require('./util');
const kc = require('./crypto');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sbx_card_vault (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, brand TEXT NOT NULL, last4 TEXT NOT NULL, exp_month INTEGER NOT NULL, exp_year INTEGER NOT NULL, behavior TEXT NOT NULL, created_ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sbx_bank_accounts (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, institution_id TEXT NOT NULL, name TEXT NOT NULL, mask TEXT NOT NULL, subtype TEXT NOT NULL, behavior TEXT NOT NULL, link_id TEXT NOT NULL, created_ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sbx_provider_records (id TEXT PRIMARY KEY, provider TEXT NOT NULL, kind TEXT NOT NULL, merchant_ref TEXT, amount_cents INTEGER NOT NULL, status TEXT NOT NULL, failure_code TEXT,
  confirmations INTEGER NOT NULL DEFAULT 0, target TEXT, meta TEXT NOT NULL DEFAULT '{}', created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_sbx_records_ref ON sbx_provider_records(merchant_ref);
CREATE INDEX IF NOT EXISTS idx_sbx_records_status ON sbx_provider_records(provider, status);
CREATE TABLE IF NOT EXISTS sbx_provider_jobs (id TEXT PRIMARY KEY, provider TEXT NOT NULL, record_id TEXT NOT NULL, action TEXT NOT NULL, run_after INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued', created_ts INTEGER NOT NULL, done_ts INTEGER);
CREATE INDEX IF NOT EXISTS idx_sbx_jobs_due ON sbx_provider_jobs(status, run_after);
CREATE TABLE IF NOT EXISTS sbx_webhook_outbox (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, provider TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, deliver_after INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', last_status INTEGER, last_error TEXT, created_ts INTEGER NOT NULL, delivered_ts INTEGER);
CREATE INDEX IF NOT EXISTS idx_sbx_outbox_due ON sbx_webhook_outbox(status, deliver_after, seq);
`;

const PROVIDERS = ['sandbox_card', 'sandbox_bank', 'sandbox_crypto'];
const RAIL_OF = { sandbox_card: 'card', sandbox_bank: 'bank', sandbox_crypto: 'crypto' };
const PROVIDER_OF = { card: 'sandbox_card', bank: 'sandbox_bank', crypto: 'sandbox_crypto' };

// ------------------------------------------------------------------ test data (invented; documented in clone/README.md)
// Luhn-valid numbers on an invented sandbox range. Behaviour is chosen by the number; any expiry in the future, any CVC.
const TEST_CARDS = [
  { number: '4000991000000002', brand: 'visa', behavior: 'approve', label: 'Approved' },
  { number: '4000992000000000', brand: 'visa', behavior: 'decline', label: 'Declined (card_declined)' },
  { number: '4000993000000008', brand: 'visa', behavior: 'insufficient_funds', label: 'Declined (insufficient_funds)' },
  { number: '4000994000000006', brand: 'visa', behavior: 'challenge', label: '3-D Secure-style challenge' },
  { number: '5500991000000004', brand: 'mastercard', behavior: 'approve', label: 'Approved' },
  { number: '5500994000000008', brand: 'mastercard', behavior: 'challenge', label: '3-D Secure-style challenge' },
];
const CARD_BEHAVIOR = new Map(TEST_CARDS.map((c) => [c.number, c]));
// Invented institutions. Sandbox sign-in: username "sandbox", password "sandbox-pass" (anything else is refused).
const INSTITUTIONS = [
  { id: 'ins_maple', name: 'Maple Test Bank' },
  { id: 'ins_harbor', name: 'Harbor Sandbox Credit Union' },
  { id: 'ins_cedar', name: 'Cedar Example Savings' },
];
const SANDBOX_LOGIN = { username: 'sandbox', password: 'sandbox-pass' };
// Each linked institution offers the same three sandbox accounts.
const BANK_ACCOUNTS = [
  { key: 'checking', name: 'Everyday Checking', mask: '0001', subtype: 'checking', behavior: 'good', hint: 'Deposits settle; withdrawals arrive.' },
  { key: 'returns', name: 'Returns Checking', mask: '0002', subtype: 'checking', behavior: 'return_r01', hint: 'Deposits are returned (insufficient funds) instead of settling.' },
  { key: 'closed', name: 'Closed Savings', mask: '0003', subtype: 'savings', behavior: 'payout_fail', hint: 'Withdrawals fail (account closed).' },
];

const luhn = (s) => { let sum = 0; let dbl = false; for (let i = s.length - 1; i >= 0; i--) { let d = s.charCodeAt(i) - 48; if (dbl) { d *= 2; if (d > 9) d -= 9; } sum += d; dbl = !dbl; } return sum % 10 === 0; };

// Crypto: invented "Sandbox chain" addresses: "tpx1" + 28 base32 characters + a 6-character checksum
// (base32 of SHA-256("tpx1" + body)). Lower-case only.
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const b32 = (buf, n) => { let out = ''; let bits = 0; let val = 0; for (const byte of buf) { val = (val << 8) | byte; bits += 8; while (bits >= 5 && out.length < n) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } } return out; };
const addrChecksum = (body) => b32(crypto.createHash('sha256').update(`tpx1${body}`).digest(), 6);
const ADDRESS_RE = /^tpx1[a-z2-7]{34}$/;
function validAddress(a) {
  const s = String(a || '');
  if (!ADDRESS_RE.test(s)) return false;
  const body = s.slice(4, 32);
  return addrChecksum(body) === s.slice(32);
}
function makeAddress(seed) {
  const body = b32(seed ? crypto.createHash('sha256').update(String(seed)).digest() : crypto.randomBytes(20), 28);
  return `tpx1${body}${addrChecksum(body)}`;
}
// Two fixed, valid addresses outside the exchange (for docs, tests and the UI's "try this" hint).
const EXAMPLE_ADDRESSES = [makeAddress('parlance-sandbox-external-wallet-1'), makeAddress('parlance-sandbox-external-wallet-2')];

// ------------------------------------------------------------------ webhook signing (shared with the receiver)
const SIG_HEADER = 'parlance-signature';
const webhookKey = (provider, keyDir) => kc.deriveKey(`payments-webhook:${provider}:v1`, { dir: keyDir });
const signature = (key, ts, raw) => kc.hmacHex(key, `${ts}.${raw}`);
const signHeader = (key, ts, raw) => `t=${ts},v1=${signature(key, ts, raw)}`;

function createSandbox({ db, keyDir, settings, receiver, quiet = false, pollMs = 150 }) {
  db.exec(SCHEMA);
  const keys = Object.fromEntries(PROVIDERS.map((p) => [p, webhookKey(p, keyDir)]));
  let base = null; // http://127.0.0.1:<port> once the server listens
  let timer = null; let blockTimer = null; let busy = false; let closed = false; let lastBlock = Date.now();
  let seq = db.prepare('SELECT COALESCE(MAX(seq),0) s FROM sbx_webhook_outbox').get().s;
  const S = () => settings().sandbox;

  const record = (id) => db.prepare('SELECT * FROM sbx_provider_records WHERE id=?').get(id);
  const vo = (r) => ({ id: r.id, kind: r.kind, merchant_ref: r.merchant_ref, amount_cents: r.amount_cents, status: r.status, failure_code: r.failure_code, confirmations: r.confirmations, ...JSON.parse(r.meta || '{}') });
  function newRecord(provider, kind, { ref, amount, status, target = null, meta = {}, prefix }) {
    const id = newId(prefix);
    db.prepare('INSERT INTO sbx_provider_records(id,provider,kind,merchant_ref,amount_cents,status,target,meta,created_ts,updated_ts) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, provider, kind, ref ?? null, amount, status, target, JSON.stringify(meta), Date.now(), Date.now());
    return record(id);
  }
  const setStatus = (id, status, extra = {}) => {
    const sets = ['status=?', 'updated_ts=?']; const args = [status, Date.now()];
    if ('failure_code' in extra) { sets.push('failure_code=?'); args.push(extra.failure_code); }
    if ('confirmations' in extra) { sets.push('confirmations=?'); args.push(extra.confirmations); }
    db.prepare(`UPDATE sbx_provider_records SET ${sets.join(',')} WHERE id=?`).run(...args, id);
    return record(id);
  };
  function emit(provider, type, rec, delayMs = 0) {
    seq += 1;
    const id = newId('evt_');
    const payload = JSON.stringify({ id, type, created: Math.floor(Date.now() / 1000), livemode: false, data: { object: vo(rec) } });
    db.prepare('INSERT INTO sbx_webhook_outbox(id,seq,provider,type,payload,deliver_after,created_ts) VALUES(?,?,?,?,?,?,?)').run(id, seq, provider, type, payload, Date.now() + delayMs, Date.now());
    kick();
    return id;
  }
  const job = (provider, recordId, action, delayMs) => db.prepare('INSERT INTO sbx_provider_jobs(id,provider,record_id,action,run_after,created_ts) VALUES(?,?,?,?,?,?)').run(newId('sj_'), provider, recordId, action, Date.now() + Math.max(0, delayMs), Date.now());

  // ---------------------------------------------------------------- card
  const card = {
    name: 'sandbox_card', rail: 'card',
    // input: {number, exp_month, exp_year, cvc}. Returns the token record; throws {code} on bad input. Never stores or
    // returns the number or CVC; the caller drops its copy.
    tokenize(uid, input) {
      const number = String(input.number ?? '').replace(/[\s-]/g, '');
      const fail = (code, message) => { const e = new Error(message); e.code = code; throw e; };
      if (!/^\d{12,19}$/.test(number) || !luhn(number)) fail('card_number_invalid', 'enter a valid card number');
      const t = CARD_BEHAVIOR.get(number);
      if (!t) fail('card_not_sandbox', 'this sandbox only accepts its test card numbers');
      const m = Number(input.exp_month); const y = Number(input.exp_year) < 100 ? 2000 + Number(input.exp_year) : Number(input.exp_year);
      const now = new Date();
      if (!Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(y) || y > now.getUTCFullYear() + 20 || y * 12 + m < now.getUTCFullYear() * 12 + now.getUTCMonth() + 1) fail('card_expiry_invalid', 'enter a valid expiry date in the future');
      if (!/^\d{3,4}$/.test(String(input.cvc ?? ''))) fail('card_cvc_invalid', 'enter the 3- or 4-digit security code');
      const token = `tok_${crypto.randomBytes(12).toString('hex')}`;
      db.prepare('INSERT INTO sbx_card_vault(token,user_id,brand,last4,exp_month,exp_year,behavior,created_ts) VALUES(?,?,?,?,?,?,?,?)').run(token, uid, t.brand, number.slice(-4), m, y, t.behavior, Date.now());
      return { token, brand: t.brand, last4: number.slice(-4), exp_month: m, exp_year: y };
    },
    tokenInfo: (token, uid) => db.prepare('SELECT token, brand, last4, exp_month, exp_year FROM sbx_card_vault WHERE token=? AND user_id=?').get(String(token), uid),
    charge({ ref, token, amount_cents }) {
      const v = db.prepare('SELECT * FROM sbx_card_vault WHERE token=?').get(token);
      const r = newRecord('sandbox_card', 'charge', { ref, amount: amount_cents, status: 'processing', target: token, prefix: 'ch_', meta: { last4: v ? v.last4 : null } });
      if (!v) { emit('sandbox_card', 'charge.failed', setStatus(r.id, 'failed', { failure_code: 'invalid_token' })); return record(r.id); }
      if (v.behavior === 'approve') emit('sandbox_card', 'charge.succeeded', setStatus(r.id, 'succeeded'));
      else if (v.behavior === 'decline') emit('sandbox_card', 'charge.failed', setStatus(r.id, 'failed', { failure_code: 'card_declined' }));
      else if (v.behavior === 'insufficient_funds') emit('sandbox_card', 'charge.failed', setStatus(r.id, 'failed', { failure_code: 'insufficient_funds' }));
      else emit('sandbox_card', 'charge.requires_action', setStatus(r.id, 'requires_action'));
      return record(r.id);
    },
    // Card payout (push to card): the approve / challenge test cards receive it; decline and insufficient-funds cards fail.
    payout({ ref, token, amount_cents }) {
      const v = db.prepare('SELECT * FROM sbx_card_vault WHERE token=?').get(token);
      const r = newRecord('sandbox_card', 'card_payout', { ref, amount: amount_cents, status: 'in_transit', target: token, prefix: 'cpo_', meta: { last4: v ? v.last4 : null } });
      job('sandbox_card', r.id, v && (v.behavior === 'approve' || v.behavior === 'challenge') ? 'payout_paid' : 'payout_fail', S().payout_seconds * 1000);
      return r;
    },
    completeChallenge(providerRef, result) {
      const r = record(providerRef);
      if (!r || r.status !== 'requires_action') return null;
      if (result === 'approve') emit('sandbox_card', 'charge.succeeded', setStatus(r.id, 'succeeded'));
      else emit('sandbox_card', 'charge.failed', setStatus(r.id, 'failed', { failure_code: 'authentication_failed' }));
      return record(r.id);
    },
  };

  // ---------------------------------------------------------------- bank (ACH-like)
  const bank = {
    name: 'sandbox_bank', rail: 'bank',
    institutions: () => INSTITUTIONS,
    // Sandbox credentials are checked and forgotten. Returns accounts with provider tokens and masks only.
    link(uid, { institution_id, username, password }) {
      const ins = INSTITUTIONS.find((i) => i.id === institution_id);
      const fail = (code, message) => { const e = new Error(message); e.code = code; throw e; };
      if (!ins) fail('institution_unknown', 'choose one of the sandbox institutions');
      if (!kc.safeEqual(String(username), SANDBOX_LOGIN.username) || !kc.safeEqual(String(password), SANDBOX_LOGIN.password)) fail('bank_login_failed', 'the sandbox bank did not accept those credentials');
      const linkId = newId('bl_');
      const accounts = BANK_ACCOUNTS.map((a) => {
        const token = `bacct_${crypto.randomBytes(12).toString('hex')}`;
        db.prepare('INSERT INTO sbx_bank_accounts(token,user_id,institution_id,name,mask,subtype,behavior,link_id,created_ts) VALUES(?,?,?,?,?,?,?,?,?)').run(token, uid, ins.id, a.name, a.mask, a.subtype, a.behavior, linkId, Date.now());
        return { account_id: token, name: a.name, mask: a.mask, subtype: a.subtype, hint: a.hint };
      });
      return { link_id: linkId, institution: ins, accounts };
    },
    account: (token, uid) => db.prepare('SELECT * FROM sbx_bank_accounts WHERE token=? AND user_id=?').get(String(token), uid),
    // ACH debit (a deposit): accepted at once (pending), then settles — or is returned — after the settlement delay.
    debit({ ref, token, amount_cents }) {
      const a = db.prepare('SELECT * FROM sbx_bank_accounts WHERE token=?').get(token);
      const r = newRecord('sandbox_bank', 'ach_debit', { ref, amount: amount_cents, status: 'pending', target: token, prefix: 'ach_', meta: { mask: a ? a.mask : null } });
      emit('sandbox_bank', 'ach_debit.pending', r);
      job('sandbox_bank', r.id, a && a.behavior === 'return_r01' ? 'ach_return' : 'ach_settle', S().ach_settle_seconds * 1000);
      return r;
    },
    payout({ ref, token, amount_cents }) {
      const a = db.prepare('SELECT * FROM sbx_bank_accounts WHERE token=?').get(token);
      const r = newRecord('sandbox_bank', 'payout', { ref, amount: amount_cents, status: 'in_transit', target: token, prefix: 'po_', meta: { mask: a ? a.mask : null } });
      job('sandbox_bank', r.id, a && a.behavior === 'payout_fail' ? 'payout_fail' : 'payout_paid', S().payout_seconds * 1000);
      return r;
    },
  };

  // ---------------------------------------------------------------- crypto (testnet-style)
  const cryptoRail = {
    name: 'sandbox_crypto', rail: 'crypto',
    newAddress: () => makeAddress(),
    validAddress,
    exampleAddresses: () => EXAMPLE_ADDRESSES,
    // An incoming transfer seen on the sandbox chain: 0 confirmations; each block adds one (blockMs, or mine()).
    simulateIncoming({ address, amount_cents }) {
      const r = newRecord('sandbox_crypto', 'crypto_in', { ref: null, amount: amount_cents, status: 'confirming', target: address, prefix: 'ctx_', meta: { address, tx_hash: crypto.randomBytes(16).toString('hex') } });
      emit('sandbox_crypto', 'crypto_deposit.detected', r);
      return r;
    },
    send({ ref, address, amount_cents }) {
      const r = newRecord('sandbox_crypto', 'crypto_out', { ref, amount: amount_cents, status: 'broadcast', target: address, prefix: 'ctx_', meta: { address, tx_hash: crypto.randomBytes(16).toString('hex') } });
      return r;
    },
    mine(n = 1) {
      for (let i = 0; i < n; i++) mineOne();
      lastBlock = Date.now();
      return n;
    },
  };
  function mineOne() {
    const need = Math.max(1, settings().crypto.confirmations);
    for (const r of db.prepare("SELECT * FROM sbx_provider_records WHERE provider='sandbox_crypto' AND status IN ('confirming','broadcast') ORDER BY created_ts").all()) {
      const c = r.confirmations + 1;
      if (r.kind === 'crypto_in') {
        const done = c >= need;
        emit('sandbox_crypto', 'crypto_deposit.confirmation', setStatus(r.id, done ? 'confirmed' : 'confirming', { confirmations: c }));
      } else {
        emit('sandbox_crypto', 'crypto_withdrawal.confirmed', setStatus(r.id, 'confirmed', { confirmations: c }));
      }
    }
  }

  // ---------------------------------------------------------------- worker: jobs, blocks, delivery
  function runJobs() {
    for (const j of db.prepare("SELECT * FROM sbx_provider_jobs WHERE status='queued' AND run_after<=? ORDER BY run_after LIMIT 20").all(Date.now())) {
      db.prepare("UPDATE sbx_provider_jobs SET status='done', done_ts=? WHERE id=?").run(Date.now(), j.id);
      const r = record(j.record_id);
      if (!r) continue;
      if (j.action === 'ach_settle' && r.status === 'pending') emit('sandbox_bank', 'ach_debit.settled', setStatus(r.id, 'settled'));
      else if (j.action === 'ach_return' && r.status === 'pending') emit('sandbox_bank', 'ach_debit.returned', setStatus(r.id, 'returned', { failure_code: 'R01_insufficient_funds' }));
      else if (j.action === 'payout_paid' && r.status === 'in_transit') emit(j.provider, 'payout.paid', setStatus(r.id, 'paid'));
      else if (j.action === 'payout_fail' && r.status === 'in_transit') emit(j.provider, 'payout.failed', setStatus(r.id, 'failed', { failure_code: j.provider === 'sandbox_card' ? 'card_declined' : 'R02_account_closed' }));
    }
  }
  function deliverHttp(provider, raw, header) {
    return new Promise((resolve) => {
      const u = new URL(`/v1/payments/webhooks/${provider}`, base);
      const rq = http.request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), [SIG_HEADER]: header, 'user-agent': 'parlance-sandbox-provider/1' }, timeout: 5000 }, (res) => {
        let text = ''; res.setEncoding('utf8'); res.on('data', (c) => { if (text.length < 2000) text += c; });
        res.on('end', () => { let code = null; try { code = JSON.parse(text)?.error?.code || null; } catch { /* not JSON */ } resolve({ status: res.statusCode, code }); });
      });
      rq.on('timeout', () => rq.destroy(new Error('timeout')));
      rq.on('error', (e) => resolve({ status: 0, code: e.message }));
      rq.end(raw);
    });
  }
  async function deliver() {
    for (;;) {
      if (closed) return;
      const ev = db.prepare("SELECT * FROM sbx_webhook_outbox WHERE status='pending' AND deliver_after<=? ORDER BY seq LIMIT 1").get(Date.now());
      if (!ev) return;
      const ts = Math.floor(Date.now() / 1000);
      const header = signHeader(keys[ev.provider], ts, ev.payload);
      let out;
      try { out = base ? await deliverHttp(ev.provider, ev.payload, header) : await receiver({ provider: ev.provider, raw: Buffer.from(ev.payload), signatureHeader: header, ip: 'in-process' }); } catch (e) { out = { status: 0, code: e.message }; }
      if (closed) return;
      // 2xx, or "already processed" (an earlier attempt got through): delivered. Anything else: retry with backoff.
      if ((out.status >= 200 && out.status < 300) || out.code === 'webhook_replayed') {
        db.prepare("UPDATE sbx_webhook_outbox SET status='delivered', attempts=attempts+1, last_status=?, delivered_ts=? WHERE id=?").run(out.status, Date.now(), ev.id);
      } else {
        const attempts = ev.attempts + 1;
        db.prepare('UPDATE sbx_webhook_outbox SET status=?, attempts=?, last_status=?, last_error=?, deliver_after=? WHERE id=?')
          .run(attempts >= 12 ? 'failed' : 'pending', attempts, out.status, String(out.code || '').slice(0, 200), Date.now() + Math.min(60000, 250 * 2 ** attempts), ev.id);
        if (!quiet && attempts >= 3) console.error(`payments sandbox: webhook ${ev.type} delivery failed (${out.status} ${out.code || ''}), attempt ${attempts}`);
        return; // keep the order: later events wait for this one
      }
    }
  }
  async function tick() {
    if (busy || closed) return;
    busy = true;
    try {
      runJobs();
      const bs = S().block_seconds;
      if (bs > 0 && Date.now() - lastBlock >= bs * 1000) cryptoRail.mine(1);
      await deliver();
    } catch (e) {
      if (!/not open|closed/i.test(e.message)) console.error('payments sandbox', e.message);
    } finally { busy = false; }
  }
  function kick() { if (!closed) setImmediate(() => { tick(); }); }

  return {
    card, bank, crypto: cryptoRail,
    byRail: { card, bank, crypto: cryptoRail },
    record, vo,
    setBase: (b) => { base = b; kick(); },
    start: () => { if (!timer) { timer = setInterval(() => { tick(); }, pollMs); timer.unref?.(); } kick(); },
    stop: () => { closed = true; clearInterval(timer); clearInterval(blockTimer); timer = null; },
    tick,
    outbox: (limit = 200) => db.prepare('SELECT id, provider, type, status, attempts, last_status, last_error, created_ts, delivered_ts FROM sbx_webhook_outbox ORDER BY seq DESC LIMIT ?').all(limit),
  };
}

module.exports = { createSandbox, TEST_CARDS, INSTITUTIONS, BANK_ACCOUNTS, SANDBOX_LOGIN, PROVIDERS, RAIL_OF, PROVIDER_OF, validAddress, makeAddress, EXAMPLE_ADDRESSES, luhn, SIG_HEADER, webhookKey, signature, signHeader };
