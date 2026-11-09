'use strict';
// FIX 4.4 gateway, simulated (PLAN A17, CLONE_SPEC.md §35.8). A tag=value, SOH-delimited TCP acceptor, off by default
// (flag api.fix; its own port: start option `fix: { port, host }` or FIX_PORT, 0 = any free port). No FIX library: the
// parser below enforces BeginString, BodyLength and CheckSum, caps message and buffer size, and each session is
// rate-limited (raw messages per second, plus the API key's rate tier for application messages).
//
// Sessions. TargetCompID PARLANCE = order entry (plus market data and RFQ); PARLANCEDC = drop copy (read-only: every
// ExecutionReport for the user's orders from any channel — web, REST, FIX). Logon (35=A) is signed with an API key:
//   553 Username   = the API key id
//   96 RawData     = base64 signature over SendingTime(52), MsgType(35), MsgSeqNum(34), SenderCompID(49) and
//                    TargetCompID(56) joined with SOH (0x01), e.g. "20261108-10:00:00.000\x01A\x011\x01MYFIRM\x01PARLANCE";
//                    95 RawDataLength = its length. RSA keys: RSA-PSS SHA-256 (salt 32); Ed25519 keys: Ed25519.
//   98 EncryptMethod = 0, 108 HeartBtInt = 5-300 s, 141 ResetSeqNumFlag = Y resets both sequences to 1.
// SendingTime must fall inside the API timestamp window (at least 5 s past / 1 s future); the signed logon is
// remembered like a REST signature (replay refused). Scopes: order entry needs `trade`, drop copy `read`; the IP
// allowlist and the tier's FIX session cap apply. One live session per (key, SenderCompID, TargetCompID).
// Sequence numbers persist across reconnects (fix_session_state). Gaps: the gateway sends ResendRequest(2) and ignores
// the out-of-order message; a counterparty ResendRequest is answered from the stored outbound application messages
// (43 PossDupFlag=Y, 122 OrigSendingTime) with SequenceReset-GapFill(4, 123=Y) over admin messages. Too-low MsgSeqNum
// without PossDupFlag → Logout.
//
// Symbology. Predictions: 55 Symbol = market ticker; 54 Side 1 = Buy, 2 = Sell; 20001 ContractSide Y (default) or N;
// 44 Price = the contract side's price in dollars (0.4500); 38 OrderQty = contracts (2 decimals where the market allows
// fractions). Perps: 55 Symbol = perps ticker (e.g. PLXBTCPERP); 54 Side 1 = Buy/long, 2 = Sell/short; 44 Price in
// dollars; 1 Account = subaccount; 20002 Leverage. 40 OrdType 1 = Market, 2 = Limit; 59 TimeInForce 1 = GTC (default),
// 3 = IOC (market orders); 126 ExpireTime = good-til-time; 18 ExecInst containing 6 = post only.
// Messages: D NewOrderSingle, F OrderCancelRequest, G OrderCancelReplaceRequest, q OrderMassCancelRequest → 8
// ExecutionReport, 9 OrderCancelReject, r OrderMassCancelReport; V MarketDataRequest → W snapshot, X incremental, Y
// reject; R QuoteRequest (creates an RFQ) → AI QuoteStatusReport, then S Quote for each quote received. Admin: 0 1 2
// 3 4 5 A; j BusinessMessageReject for unsupported types. Orders go through the same pipeline as REST
// (server/trade-api.js dispatch: flags, money controls, identity gate, limits).
const net = require('node:net');
const crypto = require('node:crypto');
const { E, ApiError, nowIso, newId } = require('./util');
const P = require('./pricing');
const { s } = require('./content/api');

const SOH = '\x01';
const BEGIN = 'FIX.4.4';
const MAX_BODY = 8192;
const MAX_BUFFER = 32768;
const RAW_RATE = 100; // inbound messages per second per session (burst 2×)
const TARGETS = { PARLANCE: 'order', PARLANCEDC: 'dropcopy' };
const ADMIN_TYPES = new Set(['0', '1', '2', '3', '4', '5', 'A']);
const SCHEMA = `
CREATE TABLE IF NOT EXISTS fix_session_state (session_key TEXT PRIMARY KEY, key_id TEXT NOT NULL, sender_comp_id TEXT NOT NULL, target_comp_id TEXT NOT NULL,
  in_seq INTEGER NOT NULL DEFAULT 1, out_seq INTEGER NOT NULL DEFAULT 1, updated_ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS fix_outbound (session_key TEXT NOT NULL, seq INTEGER NOT NULL, msg_type TEXT NOT NULL, fields TEXT NOT NULL, sent_ts INTEGER NOT NULL, PRIMARY KEY (session_key, seq));
CREATE TABLE IF NOT EXISTS fix_orders (order_id TEXT NOT NULL, session_key TEXT NOT NULL, product TEXT NOT NULL, cl_ord_id TEXT NOT NULL, orig_cl_ord_id TEXT, created_ts INTEGER NOT NULL, PRIMARY KEY (order_id, session_key));
CREATE INDEX IF NOT EXISTS idx_fix_orders_cl ON fix_orders(session_key, cl_ord_id);
CREATE TABLE IF NOT EXISTS fix_session_log (id TEXT PRIMARY KEY, session_key TEXT NOT NULL, key_id TEXT, user_id TEXT, event TEXT NOT NULL, detail TEXT, ts INTEGER NOT NULL);
`;

// ------------------------------------------------------------------------------------------------ codec
const utc = (t = Date.now()) => { const d = new Date(t); const p = (n, w = 2) => String(n).padStart(w, '0'); return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`; };
function parseUtc(v) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(String(v || ''));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], m[7] ? Number(m[7].padEnd(3, '0').slice(0, 3)) : 0);
}
const checksum = (buf) => { let n = 0; for (const b of buf) n = (n + b) % 256; return String(n).padStart(3, '0'); };
// fields: [[tag, value], ...] starting with 35. Returns the full message buffer (latin1).
function encode(fields) {
  const body = fields.map(([t, v]) => `${t}=${v}${SOH}`).join('');
  const head = `8=${BEGIN}${SOH}9=${Buffer.byteLength(body, 'latin1')}${SOH}`;
  const pre = Buffer.from(head + body, 'latin1');
  return Buffer.concat([pre, Buffer.from(`10=${checksum(pre)}${SOH}`, 'latin1')]);
}
// Parses complete messages from `buf`. Returns { messages, rest, error }. A message with a wrong checksum is returned
// with `bad: 'checksum'` (the session ignores it, as FIX requires); framing errors stop the stream.
function parse(buf) {
  const messages = []; let off = 0;
  for (;;) {
    const r = buf.subarray(off);
    if (!r.length) break;
    if (r.length < 2) break;
    if (r[0] !== 0x38 || r[1] !== 0x3d) return { messages, rest: Buffer.alloc(0), error: 'message must start with 8=' };
    const s1 = r.indexOf(1);
    if (s1 < 0) { if (r.length > 32) return { messages, rest: Buffer.alloc(0), error: 'BeginString too long' }; break; }
    if (r.toString('latin1', 2, s1) !== BEGIN) return { messages, rest: Buffer.alloc(0), error: `BeginString must be ${BEGIN}` };
    if (r.length < s1 + 3) break;
    if (r[s1 + 1] !== 0x39 || r[s1 + 2] !== 0x3d) return { messages, rest: Buffer.alloc(0), error: 'BodyLength (9) must follow BeginString' };
    const s2 = r.indexOf(1, s1 + 1);
    if (s2 < 0) { if (r.length > s1 + 12) return { messages, rest: Buffer.alloc(0), error: 'BodyLength too long' }; break; }
    const lenStr = r.toString('latin1', s1 + 3, s2);
    if (!/^\d{1,5}$/.test(lenStr)) return { messages, rest: Buffer.alloc(0), error: 'BodyLength is not a number' };
    const len = Number(lenStr);
    if (len > MAX_BODY || len < 5) return { messages, rest: Buffer.alloc(0), error: `BodyLength ${len} outside 5-${MAX_BODY}` };
    const bodyEnd = s2 + 1 + len;
    if (r.length < bodyEnd + 7) break;
    const trailer = r.toString('latin1', bodyEnd, bodyEnd + 7);
    if (!/^10=\d{3}\x01$/.test(trailer)) return { messages, rest: Buffer.alloc(0), error: 'BodyLength does not match the message (CheckSum 10 not found where expected)' };
    const bad = checksum(r.subarray(0, bodyEnd)) !== trailer.slice(3, 6) ? 'checksum' : null;
    const fields = [];
    let fieldErr = null;
    for (const part of r.toString('latin1', s2 + 1, bodyEnd).split(SOH)) {
      if (!part) continue;
      const i = part.indexOf('=');
      const tag = i > 0 ? part.slice(0, i) : '';
      if (!/^\d{1,5}$/.test(tag)) { fieldErr = 'malformed field'; continue; }
      fields.push([Number(tag), part.slice(i + 1)]);
    }
    const map = new Map();
    for (const [t, v] of fields) if (!map.has(t)) map.set(t, v);
    messages.push({ fields, map, type: map.get(35), bad: bad || fieldErr, raw: r.subarray(0, bodyEnd + 7) });
    off += bodyEnd + 7;
  }
  return { messages, rest: buf.subarray(off), error: null };
}

// ------------------------------------------------------------------------------------------------ gateway
function createFixGateway({ db, engine, apiKeys, tradeApi, flags, security = null, env = 'main', options = {} }) {
  db.exec(SCHEMA);
  const sessions = new Map(); // id -> Session
  let server = null; let boundPort = null; let starting = null;
  const wantPort = options.port != null ? Number(options.port) : process.env.FIX_PORT != null ? Number(process.env.FIX_PORT) : 0;
  const host = options.host || process.env.FIX_HOST || '127.0.0.1'; // FIX_HOST=0.0.0.0 in the container: TLS ends at the proxy (deploy/)
  const record = (kind, detail) => { try { security?.bot.record(kind, null, detail); } catch { /* best effort */ } };
  const logEv = (sess, event, detail = {}) => { try { db.prepare('INSERT INTO fix_session_log(id,session_key,key_id,user_id,event,detail,ts) VALUES(?,?,?,?,?,?,?)').run(newId('fxl_'), sess.sessionKey || '-', sess.key?.id || null, sess.user?.id || null, event, JSON.stringify(detail), Date.now()); } catch { /* closing */ } };
  const stateOf = (k) => db.prepare('SELECT * FROM fix_session_state WHERE session_key=?').get(k);
  const isPerp = (t) => { try { return !!db.prepare('SELECT 1 FROM perp_markets WHERE ticker=?').get(String(t || '').toUpperCase()); } catch { return false; } };
  const isMarket = (t) => !!db.prepare('SELECT 1 FROM markets WHERE ticker=?').get(String(t || ''));

  class Session {
    constructor(socket) {
      this.id = newId('fxs_'); this.socket = socket; this.state = 'logon'; this.buf = Buffer.alloc(0);
      this.remote = `${socket.remoteAddress}:${socket.remotePort}`; this.ip = String(socket.remoteAddress || '').replace(/^::ffff:/, '');
      this.queue = Promise.resolve(); this.lastRecv = Date.now(); this.lastSent = Date.now(); this.testPending = null;
      this.tokens = RAW_RATE * 2; this.tokTs = Date.now(); this.badCount = 0; this.msgsIn = 0; this.msgsOut = 0;
      this.orders = new Map(); // order id -> { cl, orig, product, filled, status, price, initial, remaining, known }
      this.clIds = new Set(); this.md = new Map(); this.rfqs = new Map(); this.lastBooks = new Map();
      socket.setNoDelay(true);
      socket.on('data', (d) => this.onData(d));
      socket.on('error', () => this.destroy());
      socket.on('close', () => this.destroy());
      this.logonTimer = setTimeout(() => { if (this.state === 'logon') this.destroy(); }, 10000);
    }
    onData(d) {
      if (this.state === 'closed') return;
      this.buf = Buffer.concat([this.buf, d]);
      if (this.buf.length > MAX_BUFFER) return this.fatal('message too large');
      const r = parse(this.buf);
      this.buf = Buffer.from(r.rest);
      for (const m of r.messages) {
        const now = Date.now();
        this.tokens = Math.min(RAW_RATE * 2, this.tokens + ((now - this.tokTs) / 1000) * RAW_RATE); this.tokTs = now;
        if (this.tokens < 1) return this.fatal(s('fix.rate'));
        this.tokens -= 1;
        this.queue = this.queue.then(() => this.handle(m)).catch((e) => { console.error('fix handle', e); this.fatal('internal error'); });
      }
      if (r.error) this.queue = this.queue.then(() => this.fatal(r.error));
      return undefined;
    }
    // ---- outbound
    send(type, fields, { store = !ADMIN_TYPES.has(type), seq = null, possDup = false, origTime = null } = {}) {
      if (this.state === 'closed' || this.socket.destroyed) return;
      const n = seq ?? this.outSeq;
      const now = Date.now();
      const head = [[35, type], [49, this.target || 'PARLANCE'], [56, this.sender || 'UNKNOWN'], [34, n], [52, utc(now)]];
      if (possDup) head.push([43, 'Y'], [122, origTime || utc(now)]);
      const msg = encode([...head, ...fields]);
      this.socket.write(msg);
      this.lastSent = now; this.msgsOut += 1;
      if (seq == null) {
        this.outSeq += 1;
        if (this.sessionKey) {
          db.prepare('UPDATE fix_session_state SET out_seq=?, updated_ts=? WHERE session_key=?').run(this.outSeq, now, this.sessionKey);
          if (store) db.prepare('INSERT OR REPLACE INTO fix_outbound(session_key,seq,msg_type,fields,sent_ts) VALUES(?,?,?,?,?)').run(this.sessionKey, n, type, JSON.stringify(fields), now);
        }
      }
    }
    saveIn() { if (this.sessionKey) db.prepare('UPDATE fix_session_state SET in_seq=?, updated_ts=? WHERE session_key=?').run(this.inSeq, Date.now(), this.sessionKey); }
    reject(m, reason, text, refTag) { this.send('3', [[45, m.map.get(34) || 0], ...(refTag ? [[371, refTag]] : []), [372, m.type || ''], [373, reason], [58, text]]); }
    bizReject(m, reason, text) { this.send('j', [[45, m.map.get(34) || 0], [372, m.type || ''], [380, reason], [58, text]]); }
    logout(text) {
      if (this.state === 'closed') return;
      if (this.outSeq) this.send('5', [[58, text]]);
      this.state = 'closing';
      setTimeout(() => this.destroy(), 200);
    }
    fatal(text) { logEv(this, 'error', { text }); if (this.state === 'active') this.logout(text); else { try { this.socket.write(encode([[35, '5'], [49, 'PARLANCE'], [56, 'UNKNOWN'], [34, 1], [52, utc()], [58, text]])); } catch { /* ignore */ } this.destroy(); } }
    destroy() {
      if (this.state === 'closed') return;
      if (this.sessionKey) logEv(this, 'disconnected', {});
      this.state = 'closed'; clearTimeout(this.logonTimer); sessions.delete(this.id);
      try { this.socket.destroy(); } catch { /* ignore */ }
    }
    // ---- inbound
    async handle(m) {
      if (this.state === 'closed') return;
      this.lastRecv = Date.now(); this.msgsIn += 1;
      if (m.bad === 'checksum') { this.badCount += 1; record('fix_garbled', { session: this.id }); if (this.badCount > 5) this.fatal('too many garbled messages'); return; }
      if (this.state === 'logon') { await this.logon(m); return; }
      if (m.bad) { this.reject(m, 0, 'malformed field'); return; }
      if (m.map.get(49) !== this.sender || m.map.get(56) !== this.target) { this.reject(m, 9, 'CompID problem'); this.logout('CompID problem'); return; }
      const seq = Number(m.map.get(34));
      if (!Number.isInteger(seq) || seq < 1) { this.reject(m, 1, s('fix.required_tag', { tag: 34 }), 34); return; }
      if (m.type === '4' && m.map.get(123) !== 'Y') { // SequenceReset, reset mode: ignores 34
        const nx = Number(m.map.get(36));
        if (Number.isInteger(nx) && nx >= this.inSeq) { this.inSeq = nx; this.saveIn(); } else this.reject(m, 5, s('fix.bad_value', { tag: 36 }), 36);
        return;
      }
      if (seq < this.inSeq) {
        if (m.map.get(43) === 'Y') return; // a possible duplicate we already processed
        this.logout(s('fix.seq_low', { expected: this.inSeq, received: seq }));
        return;
      }
      if (seq > this.inSeq) {
        if (m.type === '2') await this.onResend(m); // honour their resend request even inside a gap
        if (!this.resendAsked || this.resendAsked < seq) { this.send('2', [[7, this.inSeq], [16, 0]]); this.resendAsked = seq; logEv(this, 'gap', { expected: this.inSeq, received: seq }); }
        if (m.type === '5') this.logout('logout');
        return;
      }
      this.inSeq += 1; this.saveIn();
      if (this.resendAsked && this.inSeq > this.resendAsked) this.resendAsked = 0;
      switch (m.type) {
        case '0': if (m.map.get(112) && this.testPending === m.map.get(112)) this.testPending = null; return;
        case '1': this.send('0', [[112, m.map.get(112) || '']]); return;
        case '2': await this.onResend(m); return;
        case '3': return;
        case '4': { const nx = Number(m.map.get(36)); if (Number.isInteger(nx) && nx > this.inSeq) { this.inSeq = nx; this.saveIn(); } return; }
        case '5': this.send('5', [[58, 'logout acknowledged']]); this.state = 'closing'; setTimeout(() => this.destroy(), 100); return;
        case 'A': this.reject(m, 5, 'already logged on'); return;
        default: break;
      }
      await this.app(m);
    }
    async logon(m) {
      const v = (t) => m.map.get(t);
      const refuse = (why, detail = {}) => { record('fix_logon_failed', { reason: why, ...detail }); logEv(this, 'logon_refused', { reason: why }); this.fatal(s('fix.bad_logon')); };
      if (m.bad || m.type !== 'A') return refuse('first message must be a valid Logon');
      for (const t of [49, 56, 34, 52, 98, 108, 553, 96]) if (v(t) == null || v(t) === '') return refuse('missing tag', { tag: t });
      const type = TARGETS[v(56)];
      if (!type) return refuse('unknown TargetCompID');
      if (!/^[A-Za-z0-9_.-]{1,32}$/.test(v(49))) return refuse('bad SenderCompID');
      const hb = Number(v(108));
      if (v(98) !== '0' || !Number.isInteger(hb) || hb < 1 || hb > 300) return refuse('bad EncryptMethod / HeartBtInt');
      if (v(95) != null && Number(v(95)) !== String(v(96)).length) return refuse('RawDataLength mismatch');
      const st = apiKeys.settings();
      const t = parseUtc(v(52)); const now = Date.now();
      if (t == null || now - t > Math.max(5000, st.window_past_ms) || t - now > Math.max(1000, st.window_future_ms)) return refuse('SendingTime outside the window');
      const k = apiKeys.getKey(v(553));
      const sig = Buffer.from(String(v(96)), 'base64');
      const pre = [v(52), v(35), v(34), v(49), v(56)].join(SOH);
      if (!k || !apiKeys.verifyWith(crypto.createPublicKey(k.public_key_pem), k.algorithm, pre, sig)) return refuse('signature', { key: String(v(553)).slice(0, 60) });
      if (apiKeys.effectiveStatus(k) !== 'active' || apiKeys.blockedReason(k.user_id)) return refuse('key inactive or account unavailable', { key: k.id });
      if (!flags.on('api.fix', { uid: k.user_id })) return refuse('flag off');
      const scopes = JSON.parse(k.scopes);
      if (!scopes.includes(type === 'order' ? 'trade' : 'read')) return refuse('scope');
      if (!apiKeys.ipAllowed(JSON.parse(k.ip_allowlist || '[]'), this.ip)) return refuse('ip');
      const h = crypto.createHash('sha256').update(`fix|${v(52)}|${v(96)}`).digest('hex');
      db.prepare('DELETE FROM api_replay WHERE expires_ts<?').run(now);
      if (!db.prepare('INSERT INTO api_replay(key_id,sig_hash,expires_ts) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(k.id, h, now + 60000).changes) return refuse('replayed logon');
      const tier = apiKeys.tierOf(k);
      if ([...sessions.values()].filter((x) => x.state === 'active' && x.key.id === k.id).length >= tier.fix_sessions) return refuse('session cap');
      const sessionKey = `${k.id}|${v(49)}|${v(56)}`;
      if ([...sessions.values()].some((x) => x.state === 'active' && x.sessionKey === sessionKey)) return refuse('session already active');
      if (!stateOf(sessionKey)) db.prepare('INSERT INTO fix_session_state(session_key,key_id,sender_comp_id,target_comp_id,in_seq,out_seq,updated_ts) VALUES(?,?,?,?,1,1,?)').run(sessionKey, k.id, v(49), v(56), now);
      const reset = v(141) === 'Y';
      if (reset) { db.prepare('UPDATE fix_session_state SET in_seq=1, out_seq=1 WHERE session_key=?').run(sessionKey); db.prepare('DELETE FROM fix_outbound WHERE session_key=?').run(sessionKey); }
      const row = stateOf(sessionKey);
      const seq = Number(v(34));
      if (!Number.isInteger(seq) || seq < row.in_seq) return refuse('MsgSeqNum too low', { expected: row.in_seq, received: seq });
      Object.assign(this, { state: 'active', key: { ...k, scopes }, user: db.prepare('SELECT * FROM users WHERE id=?').get(k.user_id), type, sender: v(49), target: v(56), sessionKey, hb, inSeq: row.in_seq, outSeq: row.out_seq, loggedOn: now });
      this.principal = { user: this.user, key: this.key, tier };
      clearTimeout(this.logonTimer);
      for (const o of db.prepare('SELECT * FROM fix_orders WHERE session_key=?').all(sessionKey)) this.orders.set(o.order_id, { cl: o.cl_ord_id, orig: o.orig_cl_ord_id, product: o.product, known: true, ...this.snapshot(o.order_id, o.product) });
      const gap = seq > this.inSeq;
      if (!gap) { this.inSeq = seq + 1; this.saveIn(); }
      apiKeys.bumpUsage(k.id, 'fix', 1, this.ip);
      logEv(this, 'logon', { type, reset, in_seq: this.inSeq, out_seq: this.outSeq });
      this.send('A', [[98, 0], [108, hb], ...(reset ? [[141, 'Y']] : [])]);
      if (gap) { this.send('2', [[7, this.inSeq], [16, 0]]); this.resendAsked = seq; this.inSeq = this.inSeq; logEv(this, 'gap', { expected: this.inSeq, received: seq }); }
    }
    async onResend(m) {
      const begin = Math.max(1, Number(m.map.get(7)) || 1);
      let end = Number(m.map.get(16)) || 0;
      const last = this.outSeq - 1;
      if (!end || end > last) end = last;
      const stored = new Map(db.prepare('SELECT * FROM fix_outbound WHERE session_key=? AND seq BETWEEN ? AND ?').all(this.sessionKey, begin, end).map((r) => [r.seq, r]));
      let gapStart = null;
      const flushGap = (upTo) => { if (gapStart != null) { this.send('4', [[123, 'Y'], [36, upTo]], { seq: gapStart, possDup: true }); gapStart = null; } };
      for (let n = begin; n <= end; n++) {
        const r = stored.get(n);
        if (!r) { if (gapStart == null) gapStart = n; continue; }
        flushGap(n);
        this.send(r.msg_type, JSON.parse(r.fields), { seq: n, possDup: true, origTime: utc(r.sent_ts) });
      }
      flushGap(end + 1);
      logEv(this, 'resend', { begin, end });
    }
    // ---- application messages
    async app(m) {
      const v = (t) => m.map.get(t);
      apiKeys.bumpUsage(this.key.id, 'fix', 1, this.ip);
      const orderTypes = new Set(['D', 'F', 'G', 'q', 'R']);
      if (this.type === 'dropcopy' && (orderTypes.has(m.type) || m.type === 'V')) { this.bizReject(m, 4, s('fix.drop_copy_only')); return; }
      if (!['D', 'F', 'G', 'q', 'V', 'R'].includes(m.type)) { this.bizReject(m, 3, s('fix.unsupported', { type: m.type })); return; }
      try { apiKeys.charge(this.principal, m.type === 'V' ? 'read' : 'write', m.type === 'F' ? 2 : 10, null); } catch (e) {
        if (m.type === 'D') this.execReject(v(11), v(55), v(54), v(38), e.details || s('fix.rate')); else this.bizReject(m, 0, s('fix.rate'));
        return;
      }
      if (orderTypes.has(m.type) && !flags.on('api.trading', { uid: this.user.id })) { this.bizReject(m, 4, s('auth.feature_off')); return; }
      if (m.type === 'D') return this.newOrder(m);
      if (m.type === 'F') return this.cancel(m);
      if (m.type === 'G') return this.replace(m);
      if (m.type === 'q') return this.massCancel(m);
      if (m.type === 'V') return this.marketData(m);
      if (m.type === 'R') return this.quoteRequest(m);
      return undefined;
    }
    required(m, tags) { for (const t of tags) if (m.map.get(t) == null || m.map.get(t) === '') { this.reject(m, 1, s('fix.required_tag', { tag: t }), t); return false; } return true; }
    ctx() { return { ip: this.ip, headers: { 'user-agent': `parlance-fix/${this.sender}` }, channel: 'fix' }; }
    errText(r) { const e = r.body && r.body.error; return e ? `${e.code}: ${e.message}${e.details ? ` (${typeof e.details === 'string' ? e.details : JSON.stringify(e.details)})` : ''}` : r.body && r.body.msg ? r.body.msg : 'rejected'; }
    execReject(cl, sym, side, qty, text) {
      this.send('8', [[37, 'NONE'], [11, cl || 'NONE'], [17, newId('ex_')], [150, '8'], [39, '8'], [55, sym || ''], [54, side || '1'], [38, qty || '0'], [14, '0'], [151, '0'], [6, '0'], [103, 99], [58, String(text).slice(0, 400)], [60, utc()]]);
    }
    async newOrder(m) {
      const v = (t) => m.map.get(t);
      if (!this.required(m, [11, 55, 54, 38, 40])) return;
      const cl = v(11); const sym = v(55); const side = v(54); const qty = v(38); const ordType = v(40);
      if (cl.length > 64) return this.execReject(cl, sym, side, qty, s('fix.bad_value', { tag: 11 }));
      if (!['1', '2'].includes(side)) return this.execReject(cl, sym, side, qty, s('fix.bad_value', { tag: 54 }));
      if (!['1', '2'].includes(ordType)) return this.execReject(cl, sym, side, qty, s('fix.bad_value', { tag: 40 }));
      if (ordType === '2' && !v(44)) return this.execReject(cl, sym, side, qty, s('fix.required_tag', { tag: 44 }));
      if (this.clIds.has(cl) || db.prepare('SELECT 1 FROM fix_orders WHERE session_key=? AND cl_ord_id=?').get(this.sessionKey, cl)) return this.execReject(cl, sym, side, qty, 'duplicate ClOrdID');
      const perp = isPerp(sym);
      if (!perp && !isMarket(sym)) return this.execReject(cl, sym, side, qty, `unknown symbol ${sym}`);
      if (perp && !this.key.scopes.includes('perps')) return this.execReject(cl, sym, side, qty, s('forbidden.scope', { scope: 'perps' }));
      this.clIds.add(cl);
      let r;
      if (perp) {
        const body = { ticker: sym.toUpperCase(), side: side === '1' ? 'bid' : 'ask', type: ordType === '1' ? 'market' : 'limit', count: Number(qty), client_order_id: cl, ...(ordType === '2' ? { price: v(44) } : {}), ...(v(1) ? { subaccount: Number(v(1)) } : {}), ...(v(20002) ? { leverage: Number(v(20002)) } : {}), ...(String(v(18) || '').includes('6') ? { post_only: true } : {}), ...(v(20004) ? { order_group_id: v(20004) } : {}) };
        r = await tradeApi.dispatch(this.principal, 'POST', '/perps/orders', body, this.ctx());
        if (r.status < 400) this.track(r.body.order.order_id, cl, null, 'perps');
      } else {
        const contract = (v(20001) || 'Y').toUpperCase() === 'N' ? 'no' : 'yes';
        const body = { ticker: sym, side: contract, action: side === '1' ? 'buy' : 'sell', type: ordType === '1' ? 'market' : 'limit', count_fp: qty, client_order_id: cl };
        if (ordType === '2') body[`${contract}_price_dollars`] = v(44);
        if (v(126)) { const t = parseUtc(v(126)); if (t == null) return this.execReject(cl, sym, side, qty, s('fix.bad_value', { tag: 126 })); body.expiration_ts = Math.floor(t / 1000); }
        if (String(v(18) || '').includes('6')) body.post_only = true;
        if (v(20004)) body.order_group_id = v(20004); // an order group made over REST (CLONE_SPEC.md §35.8)
        r = await tradeApi.createOrder(this.principal, body, this.ctx());
        if (r.status < 400) this.track(r.body.order.order_id, cl, null, 'predictions');
      }
      if (r.status >= 400) { this.clIds.delete(cl); this.execReject(cl, sym, side, qty, this.errText(r)); }
    }
    track(orderId, cl, orig, product) {
      const cur = this.orders.get(orderId) || { known: false, ...this.snapshot(orderId, product) };
      Object.assign(cur, { cl, orig, product });
      this.orders.set(orderId, cur);
      db.prepare('INSERT INTO fix_orders(order_id,session_key,product,cl_ord_id,orig_cl_ord_id,created_ts) VALUES(?,?,?,?,?,?) ON CONFLICT(order_id,session_key) DO UPDATE SET cl_ord_id=excluded.cl_ord_id, orig_cl_ord_id=excluded.orig_cl_ord_id').run(orderId, this.sessionKey, product, cl, orig, Date.now());
    }
    snapshot(orderId, product) {
      if (product === 'perps') { const o = db.prepare('SELECT * FROM perp_orders WHERE id=?').get(orderId); return o ? { filled: o.filled_count, status: o.status, price: o.price_cc, initial: o.initial_count, remaining: o.remaining_count } : {}; }
      const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
      return o ? { filled: o.filled_count, status: o.status, price: o.price_cc ?? o.price_cents * 100, initial: o.initial_count, remaining: o.remaining_count } : {};
    }
    findOrder(m) {
      const id = m.map.get(37); const orig = m.map.get(41);
      if (id && id !== 'NONE') {
        if (db.prepare('SELECT 1 FROM orders WHERE id=? AND user_id=?').get(id, this.user.id)) return { id, product: 'predictions' };
        if (isPerpOrder(id, this.user.id)) return { id, product: 'perps' };
      }
      if (orig) {
        const f = db.prepare('SELECT * FROM fix_orders WHERE session_key=? AND cl_ord_id=?').get(this.sessionKey, orig);
        if (f) return { id: f.order_id, product: f.product };
        const o = db.prepare("SELECT id FROM orders WHERE user_id=? AND client_order_id=? ORDER BY seq DESC LIMIT 1").get(this.user.id, orig);
        if (o) return { id: o.id, product: 'predictions' };
      }
      return null;
    }
    cancelReject(m, to, text, reason = 1) {
      const v = (t) => m.map.get(t);
      this.send('9', [[37, v(37) || 'NONE'], [11, v(11) || 'NONE'], [41, v(41) || 'NONE'], [39, '8'], [434, to], [102, reason], [58, String(text).slice(0, 400)]]);
    }
    async cancel(m) {
      if (!this.required(m, [11])) return;
      const f = this.findOrder(m);
      if (!f) return this.cancelReject(m, 1, s('fix.unknown_order'));
      this.track(f.id, m.map.get(11), m.map.get(41) || this.orders.get(f.id)?.cl || null, f.product);
      const r = f.product === 'perps' ? await tradeApi.dispatch(this.principal, 'DELETE', `/perps/orders/${encodeURIComponent(f.id)}`, undefined, this.ctx()) : await tradeApi.cancelOrder(this.principal, f.id, this.ctx());
      if (r.status >= 400) this.cancelReject(m, 1, this.errText(r), r.status === 404 ? 1 : 0);
    }
    async replace(m) {
      const v = (t) => m.map.get(t);
      if (!this.required(m, [11])) return;
      const f = this.findOrder(m);
      if (!f) return this.cancelReject(m, 2, s('fix.unknown_order'));
      this.track(f.id, v(11), v(41) || this.orders.get(f.id)?.cl || null, f.product);
      let r;
      if (f.product === 'perps') r = await tradeApi.dispatch(this.principal, 'POST', `/perps/orders/${encodeURIComponent(f.id)}/amend`, { ...(v(44) ? { price: v(44) } : {}), ...(v(38) ? { count: Number(v(38)) } : {}) }, this.ctx());
      else {
        const o = db.prepare('SELECT * FROM orders WHERE id=?').get(f.id);
        const userSide = o.action === 'sell' ? (o.side === 'yes' ? 'no' : 'yes') : o.side;
        r = await tradeApi.amendOrder(this.principal, f.id, { ...(v(44) ? { [`${userSide}_price_dollars`]: v(44) } : {}), ...(v(38) ? { count_fp: v(38) } : {}) }, this.ctx());
      }
      if (r.status >= 400) this.cancelReject(m, 2, this.errText(r), 0);
    }
    async massCancel(m) {
      const v = (t) => m.map.get(t);
      const typ = v(530) || '7';
      if (!['1', '7'].includes(typ)) { this.send('r', [[11, v(11) || 'NONE'], [37, 'MASS'], [530, typ], [531, 0], [532, 99], [58, s('fix.bad_value', { tag: 530 })]]); return; }
      if (typ === '1' && !v(55)) { this.reject(m, 1, s('fix.required_tag', { tag: 55 }), 55); return; }
      let n = 0;
      const sym = v(55);
      for (const o of db.prepare("SELECT id, market_ticker FROM orders WHERE user_id=? AND status='resting'").all(this.user.id)) {
        if (typ === '1' && o.market_ticker !== sym) continue;
        this.track(o.id, v(11) || 'MASS', this.orders.get(o.id)?.cl || null, 'predictions');
        if ((await tradeApi.cancelOrder(this.principal, o.id, this.ctx())).status < 400) n += 1;
      }
      try {
        for (const o of db.prepare("SELECT id, ticker FROM perp_orders WHERE user_id=? AND status='resting'").all(this.user.id)) {
          if (typ === '1' && o.ticker !== String(sym).toUpperCase()) continue;
          this.track(o.id, v(11) || 'MASS', this.orders.get(o.id)?.cl || null, 'perps');
          if ((await tradeApi.dispatch(this.principal, 'DELETE', `/perps/orders/${encodeURIComponent(o.id)}`, undefined, this.ctx())).status < 400) n += 1;
        }
      } catch { /* no perps tables */ }
      this.send('r', [[11, v(11) || 'NONE'], [37, 'MASS'], [530, typ], [531, typ], [533, n], ...(sym ? [[55, sym]] : [])]);
    }
    // ---- execution reports (from engine events, any channel)
    wants(product, orderId, clientOrderId) {
      if (this.state !== 'active') return false;
      if (this.type === 'dropcopy') return true;
      if (this.orders.has(orderId)) return true;
      return !!clientOrderId && this.clIds.has(clientOrderId);
    }
    report(orderId, product, execType, extra = []) {
      const o = product === 'perps' ? db.prepare('SELECT * FROM perp_orders WHERE id=?').get(orderId) : db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
      if (!o) return;
      const t = this.orders.get(orderId) || {};
      const q = (u) => (Number(u) / 100).toFixed(2);
      let side; let contract = null; let sym; let px; let avg = '0';
      if (product === 'perps') {
        side = o.side === 'bid' ? '1' : '2'; sym = o.ticker; px = o.price_cc != null ? P.ccToDollars(o.price_cc) : '0';
        if (o.filled_count) avg = P.ccToDollars(Math.round(o.fill_cost_cc / o.filled_count));
      } else {
        side = o.action === 'sell' ? '2' : '1'; const cs = o.action === 'sell' ? (o.side === 'yes' ? 'no' : 'yes') : o.side; contract = cs === 'yes' ? 'Y' : 'N'; sym = o.market_ticker;
        const cc = o.price_cc ?? o.price_cents * 100; const userCc = o.action === 'sell' ? P.CC - cc : cc; px = P.ccToDollars(userCc);
        const f = db.prepare('SELECT COALESCE(SUM(count),0) n, COALESCE(SUM(count*price_cc),0) v FROM fills WHERE order_id=?').get(orderId);
        if (f.n) { const a = Math.round(f.v / f.n); avg = P.ccToDollars(o.action === 'sell' ? P.CC - a : a); }
      }
      const status = o.status === 'resting' ? (o.filled_count > 0 ? '1' : '0') : o.status === 'executed' || (o.status !== 'canceled' && o.remaining_count === 0) ? (o.filled_count >= o.initial_count ? '2' : '4') : o.cancel_reason === 'expired' ? 'C' : '4';
      const cl = t.cl || o.client_order_id || 'NONE';
      this.send('8', [[37, orderId], [11, cl], ...(t.orig ? [[41, t.orig]] : []), [17, newId('ex_')], [150, execType], [39, status], [55, sym], [54, side], ...(contract ? [[20001, contract]] : []),
        ...(o.subaccount != null && product === 'perps' ? [[1, o.subaccount]] : []), [38, q(o.initial_count)], [40, product === 'perps' ? (o.type === 'market' ? '1' : '2') : (o.order_type === 'limit' ? '2' : '1')], [44, px],
        [14, q(o.filled_count)], [151, o.status === 'resting' ? q(o.remaining_count) : '0.00'], [6, avg], ...extra, [60, utc()], [20003, o.source || 'user']]);
    }
    onOrder(orderId, product, clientOrderId) {
      if (!this.wants(product, orderId, clientOrderId)) return;
      const now = this.snapshot(orderId, product);
      let t = this.orders.get(orderId);
      if (!t) { t = { cl: clientOrderId || null, orig: null, product, known: false }; this.orders.set(orderId, t); }
      if (!t.known) { t.known = true; Object.assign(t, { ...now, filled: 0 }); this.report(orderId, product, '0'); if (now.filled > 0 && product === 'perps') this.fillsFor(orderId, t); }
      if (product === 'perps' && now.filled > (t.filled || 0)) this.fillsFor(orderId, t);
      if (now.status === 'canceled' && t.status !== 'canceled') this.report(orderId, product, now.status === 'canceled' && this.snapshotReason(orderId, product) === 'expired' ? 'C' : '4');
      else if (now.status === 'resting' && t.status === 'resting' && (now.price !== t.price || now.initial !== t.initial || (now.remaining < t.remaining && now.filled === t.filled))) this.report(orderId, product, '5');
      Object.assign(t, now);
    }
    snapshotReason(orderId, product) { try { return (product === 'perps' ? db.prepare('SELECT cancel_reason r FROM perp_orders WHERE id=?') : db.prepare('SELECT cancel_reason r FROM orders WHERE id=?')).get(orderId)?.r; } catch { return null; } }
    onFill(f) {
      if (!this.wants('predictions', f.order_id, f.client_order_id)) return;
      let t = this.orders.get(f.order_id);
      if (!t) { t = { cl: f.client_order_id || null, orig: null, product: 'predictions', known: false }; this.orders.set(f.order_id, t); }
      if (!t.known) { t.known = true; Object.assign(t, this.snapshot(f.order_id, 'predictions')); this.report(f.order_id, 'predictions', '0'); }
      const o = db.prepare('SELECT action FROM orders WHERE id=?').get(f.order_id);
      const userCc = o && o.action === 'sell' ? P.CC - f.price_cc : f.price_cc;
      this.report(f.order_id, 'predictions', 'F', [[31, P.ccToDollars(userCc)], [32, (f.count / 100).toFixed(2)], [1003, f.trade_id]]);
      Object.assign(t, this.snapshot(f.order_id, 'predictions'));
    }
    fillsFor(orderId, t) {
      const seen = t.fills || (t.fills = new Set());
      for (const f of db.prepare('SELECT * FROM perp_fills WHERE order_id=? ORDER BY created_ts, rowid').all(orderId)) {
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        this.report(orderId, 'perps', 'F', [[31, P.ccToDollars(f.price_cc)], [32, (f.count / 100).toFixed(2)], [1003, f.trade_id]]);
      }
    }
    // ---- market data
    async marketData(m) {
      const v = (t) => m.map.get(t);
      if (!this.required(m, [262, 263])) return;
      const id = v(262); const sub = v(263);
      if (sub === '2') { this.md.delete(id); return; }
      const syms = m.fields.filter(([t]) => t === 55).map(([, x]) => x);
      if (!syms.length) { this.send('Y', [[262, id], [281, 0], [58, s('fix.required_tag', { tag: 55 })]]); return; }
      const depth = Math.max(0, Number(v(264)) || 0);
      for (const sym of syms) {
        const perp = isPerp(sym);
        if (!perp && !isMarket(sym)) { this.send('Y', [[262, id], [281, 0], [58, `unknown symbol ${sym}`]]); return; }
      }
      if (sub === '1') this.md.set(id, { syms: new Set(syms.map((x) => (isPerp(x) ? x.toUpperCase() : x))), depth });
      for (const sym of syms) this.snapshotMd(id, isPerp(sym) ? sym.toUpperCase() : sym, depth);
    }
    levels(sym) {
      if (isPerp(sym)) { const b = engine.perps.bookMsg(sym); return { bids: b.bids.map(([p, n]) => [p, n]), offers: b.asks.map(([p, n]) => [p, n]) }; }
      const b = engine.book(sym);
      const bids = [...b.yes.entries()].sort((a, z) => z[0] - a[0]).map(([p, n]) => [P.ccToDollars(p), (n / 100).toFixed(2)]);
      const offers = [...b.no.entries()].sort((a, z) => z[0] - a[0]).map(([p, n]) => [P.ccToDollars(P.CC - p), (n / 100).toFixed(2)]);
      return { bids, offers };
    }
    snapshotMd(id, sym, depth) {
      const l = this.levels(sym);
      const cut = (a) => (depth ? a.slice(0, depth) : a);
      const entries = [...cut(l.bids).map(([p, n]) => [['269', '0'], ['270', p], ['271', n]]), ...cut(l.offers).map(([p, n]) => [['269', '1'], ['270', p], ['271', n]])];
      this.lastBooks.set(`${id}|${sym}`, l);
      this.send('W', [[262, id], [55, sym], [268, entries.length], ...entries.flat().map(([t, x]) => [Number(t), x])]);
    }
    mdUpdate(sym, trade = null) {
      for (const [id, sub] of this.md) {
        if (!sub.syms.has(sym)) continue;
        const groups = [];
        if (trade) groups.push([[279, 0], [269, 2], [55, sym], [270, trade.price], [271, trade.size]]);
        else {
          const prev = this.lastBooks.get(`${id}|${sym}`) || { bids: [], offers: [] };
          const cur = this.levels(sym);
          this.lastBooks.set(`${id}|${sym}`, cur);
          for (const [key, typ] of [['bids', '0'], ['offers', '1']]) {
            const a = new Map(prev[key]); const b = new Map(cur[key]);
            for (const p of new Set([...a.keys(), ...b.keys()])) {
              if (a.get(p) === b.get(p)) continue;
              groups.push(b.has(p) ? [[279, a.has(p) ? 1 : 0], [269, typ], [55, sym], [270, p], [271, b.get(p)]] : [[279, 2], [269, typ], [55, sym], [270, p]]);
            }
          }
        }
        if (groups.length) this.send('X', [[262, id], [268, groups.length], ...groups.flat()]);
      }
    }
    // ---- RFQ
    async quoteRequest(m) {
      const v = (t) => m.map.get(t);
      if (!this.required(m, [131, 55, 38])) return;
      const r = await tradeApi.dispatch(this.principal, 'POST', '/communications/rfqs', { market_ticker: v(55), contracts_fp: v(38) }, this.ctx());
      if (r.status >= 400) { this.send('AI', [[131, v(131)], [55, v(55)], [297, 5], [58, this.errText(r).slice(0, 400)]]); return; }
      const rfqId = r.body.id || r.body.rfq?.id;
      this.rfqs.set(rfqId, v(131));
      this.send('AI', [[131, v(131)], [117, rfqId], [55, v(55)], [297, 0]]);
    }
    onQuote(type, q) {
      if (this.type !== 'order' || type !== 'quote_created' || !this.rfqs.has(q.rfq_id)) return;
      this.send('S', [[131, this.rfqs.get(q.rfq_id)], [117, q.id], [55, q.market_ticker], [132, q.yes_bid_dollars || '0'], [133, q.no_bid_dollars ? P.ccToDollars(P.CC - P.ccFromDollars(q.no_bid_dollars)) : '0'], [134, q.yes_contracts_fp || '0'], [135, q.no_contracts_fp || '0']]);
    }
  }
  const isPerpOrder = (id, uid) => { try { return !!db.prepare('SELECT 1 FROM perp_orders WHERE id=? AND user_id=?').get(id, uid); } catch { return false; } };

  // ---------------------------------------------------------------- engine events → sessions
  const forUser = (uid, fn) => { for (const x of sessions.values()) if (x.state === 'active' && x.user.id === uid) { try { fn(x); } catch (e) { if (!/not open|closed/i.test(e.message)) console.error('fix event', e.message); } } };
  engine.on('user_order', (uid, o) => { if (sessions.size) forUser(uid, (x) => x.onOrder(o.id, 'predictions', o.client_order_id)); });
  engine.on('fill', (uid, f) => { if (sessions.size) { const co = db.prepare('SELECT client_order_id FROM orders WHERE id=?').get(f.order_id)?.client_order_id; forUser(uid, (x) => x.onFill({ ...f, client_order_id: co })); } });
  engine.on('perp_order', (uid, o) => { if (sessions.size) forUser(uid, (x) => x.onOrder(o.order_id, 'perps', o.client_order_id)); });
  engine.on('communications', (uid, type, msg) => { if (sessions.size && uid) forUser(uid, (x) => x.onQuote(type, msg)); });
  const mdAll = (sym, trade) => { for (const x of sessions.values()) if (x.state === 'active' && x.md.size) { try { x.mdUpdate(sym, trade); } catch (e) { void e; } } };
  engine.on('book_delta', (t) => { if (sessions.size) mdAll(t); });
  engine.on('perp_book', (t) => { if (sessions.size) mdAll(t); });
  engine.on('trade', (tr) => { if (sessions.size) mdAll(tr.market_ticker, { price: P.ccToDollars(tr.yes_price_cc), size: (tr.count / 100).toFixed(2) }); });
  engine.on('perp_trade', (t, tr) => { if (sessions.size) mdAll(t, { price: tr.price, size: tr.count }); });

  // ---------------------------------------------------------------- lifecycle
  const closeWhere = (pred, text) => { for (const x of [...sessions.values()]) if (pred(x)) { logEv(x, 'disconnect', { text }); if (x.state === 'active') x.logout(text); else x.destroy(); } };
  apiKeys.events.on('revoked', (k) => closeWhere((x) => x.key && x.key.id === k.id, s('fix.key_revoked')));
  apiKeys.events.on('production_reset', () => closeWhere(() => true, s('fix.production_reset')));
  function listen() {
    if (server || starting) return starting;
    const srv = net.createServer((socket) => { const x = new Session(socket); sessions.set(x.id, x); });
    srv.maxConnections = 200;
    starting = new Promise((resolve) => {
      srv.once('error', (e) => { console.error(`FIX gateway could not listen on ${host}:${wantPort}: ${e.message}`); starting = null; resolve(null); });
      srv.listen(wantPort, host, () => { server = srv; boundPort = srv.address().port; starting = null; resolve(boundPort); });
    });
    return starting;
  }
  function stop(text = s('fix.feature_off')) {
    closeWhere(() => true, text);
    if (server) { const srv = server; server = null; boundPort = null; srv.close(); }
  }
  // Heartbeats, test requests, flag / key re-checks, and the listener following the api.fix flag.
  const iv = setInterval(() => {
    try {
      const on = flags.jobOn('api.fix');
      if (on && !server) listen();
      if (!on && server) stop();
      const now = Date.now();
      for (const x of [...sessions.values()]) {
        if (x.state !== 'active') continue;
        const k = apiKeys.getKey(x.key.id);
        if (!k || apiKeys.effectiveStatus(k) !== 'active' || apiKeys.blockedReason(x.user.id) || !flags.on('api.fix', { uid: x.user.id })) { x.logout(s('fix.key_revoked')); continue; }
        if (now - x.lastSent >= x.hb * 1000) x.send('0', []);
        if (now - x.lastRecv > x.hb * 1000 + 1000 && !x.testPending) { x.testPending = `TEST-${now}`; x.testSent = now; x.send('1', [[112, x.testPending]]); } else if (x.testPending && now - x.testSent > x.hb * 1000 + 1000) { x.logout('heartbeat timeout'); }
      }
    } catch (e) { if (!/not open|closed/i.test(e.message)) console.error('fix tick', e.message); }
  }, 500);
  iv.unref?.();

  const sessionVo = (x) => ({ id: x.id, key_id: x.key?.id || null, user_id: x.user?.id || null, user_email: x.user?.email || null, sender_comp_id: x.sender || null, target_comp_id: x.target || null, type: x.type || null,
    state: x.state, remote: x.remote, logged_on_time: x.loggedOn ? new Date(x.loggedOn).toISOString() : null, in_seq: x.inSeq || null, out_seq: x.outSeq || null, messages_in: x.msgsIn, messages_out: x.msgsOut, heartbeat_seconds: x.hb || null });
  return {
    listen, stop, port: () => boundPort, listening: () => !!server, env,
    sessions: () => [...sessions.values()].filter((x) => x.state === 'active').map(sessionVo),
    disconnect: (id, text) => { const x = sessions.get(id); if (!x) return false; logEv(x, 'admin_disconnect', { text }); x.logout(text || s('fix.disconnected_admin')); return true; },
    close: () => { clearInterval(iv); stop('server shutting down'); },
  };
}

// Admin › API keys › FIX sessions (live list, disconnect). The gateway is created after the app (server/index.js).
function mountFixAdmin({ v1, admin, getGateway }) {
  const can = admin.can;
  v1.get('/admin/fix/sessions', can('users.read'), (req, res) => {
    const g = getGateway();
    res.json({ listening: !!g && g.listening(), port: g ? g.port() : null, sessions: g ? g.sessions() : [] });
  });
  v1.post('/admin/fix/sessions/:id/disconnect', can('users.support'), (req, res) => {
    const reason = String((req.body && req.body.reason) || '').trim();
    if (reason.length < 3 || reason.length > 500) throw new ApiError(400, 'validation_failed', 'validation failed', 'reason: a reason of 3-500 characters is required');
    const g = getGateway();
    const sess = g ? g.sessions().find((x) => x.id === req.params.id) : null;
    if (!sess || !g.disconnect(req.params.id, s('fix.disconnected_admin'))) throw E.notFound();
    admin.audit(req, 'fix.disconnect', 'fix_session', req.params.id, sess, { at: nowIso() }, reason);
    res.json({ disconnected: true, session: sess });
  });
}

// The message tables of the portal's FIX pages (GET /docs/fix.json): one declaration, rendered by public/js/views/docs.js.
// [msgType, name, direction, session types, [[tag, field, required?, note]]]
const FIX_SPEC = {
  version: BEGIN, targets: TARGETS, signed_logon: '52 SendingTime, 35 MsgType, 34 MsgSeqNum, 49 SenderCompID, 56 TargetCompID joined with SOH; RSA-PSS SHA-256 (salt 32) or Ed25519; base64 in 96 RawData',
  header: [[8, 'BeginString', true, 'FIX.4.4'], [9, 'BodyLength', true, 'bytes after this field up to the CheckSum, at most 8192'], [35, 'MsgType', true], [49, 'SenderCompID', true, 'yours; 1-32 of A-Z a-z 0-9 _ . -'], [56, 'TargetCompID', true, 'PARLANCE or PARLANCEDC'], [34, 'MsgSeqNum', true], [52, 'SendingTime', true, 'UTC YYYYMMDD-HH:MM:SS.sss'], [43, 'PossDupFlag', false], [122, 'OrigSendingTime', false], [10, 'CheckSum', true, 'sum of bytes mod 256, 3 digits']],
  messages: [
    ['A', 'Logon', 'both', ['order', 'dropcopy'], [[98, 'EncryptMethod', true, '0'], [108, 'HeartBtInt', true, '1-300 seconds'], [141, 'ResetSeqNumFlag', false, 'Y resets both sides to 1'], [553, 'Username', true, 'API key id'], [95, 'RawDataLength', false], [96, 'RawData', true, 'base64 signature']]],
    ['0', 'Heartbeat', 'both', ['order', 'dropcopy'], [[112, 'TestReqID', false, 'when answering a TestRequest']]],
    ['1', 'TestRequest', 'both', ['order', 'dropcopy'], [[112, 'TestReqID', true]]],
    ['2', 'ResendRequest', 'both', ['order', 'dropcopy'], [[7, 'BeginSeqNo', true], [16, 'EndSeqNo', true, '0 = up to the latest']]],
    ['3', 'Reject', 'both', ['order', 'dropcopy'], [[45, 'RefSeqNum', true], [371, 'RefTagID', false], [372, 'RefMsgType', false], [373, 'SessionRejectReason', false], [58, 'Text', false]]],
    ['4', 'SequenceReset', 'both', ['order', 'dropcopy'], [[123, 'GapFillFlag', false, 'Y = gap fill'], [36, 'NewSeqNo', true]]],
    ['5', 'Logout', 'both', ['order', 'dropcopy'], [[58, 'Text', false]]],
    ['D', 'NewOrderSingle', 'in', ['order'], [[11, 'ClOrdID', true, 'unique per session, at most 64'], [55, 'Symbol', true, 'market or perps ticker'], [54, 'Side', true, '1 Buy, 2 Sell'], [38, 'OrderQty', true, 'contracts'], [40, 'OrdType', true, '1 Market, 2 Limit'], [44, 'Price', false, 'dollars, required for limit'], [59, 'TimeInForce', false, '1 GTC (default), 3 IOC'], [126, 'ExpireTime', false, 'good-til-time'], [18, 'ExecInst', false, '6 = post only'], [20001, 'ContractSide', false, 'Predictions: Y (default) or N'], [1, 'Account', false, 'Perps: subaccount'], [20002, 'Leverage', false, 'Perps'], [20004, 'OrderGroupID', false, 'an order group id (made over REST)']]],
    ['F', 'OrderCancelRequest', 'in', ['order'], [[11, 'ClOrdID', true], [41, 'OrigClOrdID', false], [37, 'OrderID', false, 'one of 37 / 41']]],
    ['G', 'OrderCancelReplaceRequest', 'in', ['order'], [[11, 'ClOrdID', true], [41, 'OrigClOrdID', false], [37, 'OrderID', false], [38, 'OrderQty', false, 'new total quantity'], [44, 'Price', false, 'new price']]],
    ['q', 'OrderMassCancelRequest', 'in', ['order'], [[11, 'ClOrdID', true], [530, 'MassCancelRequestType', true, '1 by Symbol, 7 all orders'], [55, 'Symbol', false]]],
    ['8', 'ExecutionReport', 'out', ['order', 'dropcopy'], [[37, 'OrderID', true], [11, 'ClOrdID', true], [41, 'OrigClOrdID', false], [17, 'ExecID', true], [150, 'ExecType', true, '0 New, F Trade, 4 Canceled, 5 Replaced, 8 Rejected, C Expired'], [39, 'OrdStatus', true, '0 New, 1 Partially filled, 2 Filled, 4 Canceled, 8 Rejected, C Expired'], [55, 'Symbol', true], [54, 'Side', true], [20001, 'ContractSide', false], [38, 'OrderQty', true], [44, 'Price', false], [14, 'CumQty', true], [151, 'LeavesQty', true], [6, 'AvgPx', true], [31, 'LastPx', false], [32, 'LastQty', false], [1003, 'TradeID', false], [103, 'OrdRejReason', false], [58, 'Text', false], [60, 'TransactTime', true], [20003, 'OrderSource', false, 'user, api, fix, rfq …']]],
    ['9', 'OrderCancelReject', 'out', ['order'], [[37, 'OrderID', true], [11, 'ClOrdID', true], [41, 'OrigClOrdID', true], [39, 'OrdStatus', true], [434, 'CxlRejResponseTo', true, '1 cancel, 2 replace'], [102, 'CxlRejReason', false], [58, 'Text', false]]],
    ['r', 'OrderMassCancelReport', 'out', ['order'], [[11, 'ClOrdID', true], [530, 'MassCancelRequestType', true], [531, 'MassCancelResponse', true, '0 rejected'], [533, 'TotalAffectedOrders', false]]],
    ['V', 'MarketDataRequest', 'in', ['order'], [[262, 'MDReqID', true], [263, 'SubscriptionRequestType', true, '0 snapshot, 1 snapshot + updates, 2 unsubscribe'], [264, 'MarketDepth', false], [146, 'NoRelatedSym', true], [55, 'Symbol', true, 'repeating']]],
    ['W', 'MarketDataSnapshotFullRefresh', 'out', ['order'], [[262, 'MDReqID', true], [55, 'Symbol', true], [268, 'NoMDEntries', true], [269, 'MDEntryType', true, '0 bid, 1 offer'], [270, 'MDEntryPx', true], [271, 'MDEntrySize', true]]],
    ['X', 'MarketDataIncrementalRefresh', 'out', ['order'], [[262, 'MDReqID', true], [268, 'NoMDEntries', true], [279, 'MDUpdateAction', true, '0 new, 1 change, 2 delete'], [269, 'MDEntryType', true, '0 bid, 1 offer, 2 trade'], [55, 'Symbol', true], [270, 'MDEntryPx', true], [271, 'MDEntrySize', false]]],
    ['Y', 'MarketDataRequestReject', 'out', ['order'], [[262, 'MDReqID', true], [281, 'MDReqRejReason', false], [58, 'Text', false]]],
    ['R', 'QuoteRequest', 'in', ['order'], [[131, 'QuoteReqID', true], [146, 'NoRelatedSym', true], [55, 'Symbol', true], [38, 'OrderQty', true]]],
    ['AI', 'QuoteStatusReport', 'out', ['order'], [[131, 'QuoteReqID', true], [117, 'QuoteID', false, 'the RFQ id'], [55, 'Symbol', true], [297, 'QuoteStatus', true, '0 accepted, 5 rejected'], [58, 'Text', false]]],
    ['S', 'Quote', 'out', ['order'], [[131, 'QuoteReqID', true], [117, 'QuoteID', true], [55, 'Symbol', true], [132, 'BidPx', false, 'YES bid'], [133, 'OfferPx', false, 'YES offer (1 − NO bid)'], [134, 'BidSize', false], [135, 'OfferSize', false]]],
    ['j', 'BusinessMessageReject', 'out', ['order', 'dropcopy'], [[45, 'RefSeqNum', true], [372, 'RefMsgType', true], [380, 'BusinessRejectReason', true, '3 unsupported type, 4 not available'], [58, 'Text', false]]],
  ].map(([type, name, direction, sessions, fields]) => ({ type, name, direction, sessions, fields: fields.map(([tag, field, required, note]) => ({ tag, field, required: !!required, note: note || '' })) })),
};

module.exports = { createFixGateway, mountFixAdmin, encode, parse, checksum, utc, parseUtc, SOH, TARGETS, FIX_SPEC };
