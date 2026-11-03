'use strict';
// Email and SMS delivery through provider abstractions (PLAN P3.1, P3.2, residual RS6; CLONE_SPEC §25).
//
// Email transports:  'dev'  — every message is written to `email_outbox` (shown on /dev/mailbox, never in production)
//                    'smtp' — a small SMTP client (EHLO, STARTTLS when offered, AUTH PLAIN, MAIL/RCPT/DATA) configured by
//                             SMTP_URL (smtp://user:pass@host:587 or smtps://…:465) and MAIL_FROM. Only metadata (masked
//                             recipient + subject) is kept in the outbox, never the body: bodies carry single-use links.
// SMS transports:    'dev'  — `sms_outbox` (body visible on /dev/mailbox; the number stored masked + AES-GCM encrypted)
//                    'webhook' — POST {to, body} JSON to SMS_WEBHOOK_URL with `Authorization: Bearer SMS_WEBHOOK_TOKEN`
//                             (any SMS gateway behind a small adapter). Only masked metadata is stored.
// In production without a configured provider, sending fails with 503 (no silent drop, no dev outbox).
const net = require('node:net');
const tls = require('node:tls');
const { newId, nowIso, ApiError } = require('./util');
const kc = require('./crypto');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sms_outbox (id TEXT PRIMARY KEY, user_id TEXT, to_masked TEXT NOT NULL, to_enc TEXT, body TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '', transport TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_sms_outbox_created ON sms_outbox(created_at);
CREATE TABLE IF NOT EXISTS email_outbox (id TEXT PRIMARY KEY, user_id TEXT, to_email TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
`;

const clean = (s, n = 998) => String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, n); // no header injection
const maskEmail = (e) => { const [l, d] = String(e).split('@'); return d ? `${(l || '?')[0]}***@${d}` : '***'; };

// ------------------------------------------------------------------------------------------------ minimal SMTP client
function smtpSend({ url, from, to, subject, text, timeoutMs = 15000 }) {
  const u = new URL(url);
  const implicitTls = u.protocol === 'smtps:';
  const port = Number(u.port) || (implicitTls ? 465 : 587);
  const host = u.hostname;
  const user = decodeURIComponent(u.username || '');
  const pass = decodeURIComponent(u.password || '');
  const requireTls = u.searchParams.get('tls') !== 'off';
  return new Promise((resolve, reject) => {
    let sock = implicitTls ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    let buf = '';
    let waiter = null;
    const timer = setTimeout(() => fail(new Error('smtp timeout')), timeoutMs);
    function fail(e) { clearTimeout(timer); try { sock.destroy(); } catch { /* ignore */ } reject(e); }
    function onData(chunk) {
      buf += chunk.toString('utf8');
      // A reply is complete when its last line has "NNN " (space after the code).
      const lines = buf.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) {
          const reply = lines.slice(0, i + 1);
          buf = lines.slice(i + 1).join('\r\n');
          if (waiter) { const w = waiter; waiter = null; w({ code: Number(reply[reply.length - 1].slice(0, 3)), lines: reply }); }
          return;
        }
      }
    }
    const attach = (s) => { s.on('data', onData); s.on('error', fail); };
    attach(sock);
    const read = () => new Promise((r) => { waiter = r; });
    const cmd = async (line, ok) => {
      if (line != null) sock.write(`${line}\r\n`);
      const r = await read();
      if (!ok.includes(r.code)) throw new Error(`smtp ${r.code}`);
      return r;
    };
    (async () => {
      await cmd(null, [220]);
      let ehlo = await cmd('EHLO parlance.local', [250]);
      if (!implicitTls && ehlo.lines.some((l) => /STARTTLS/i.test(l))) {
        await cmd('STARTTLS', [220]);
        sock.removeListener('data', onData);
        sock = tls.connect({ socket: sock, servername: host });
        attach(sock);
        await new Promise((r, j) => { sock.once('secureConnect', r); sock.once('error', j); });
        ehlo = await cmd('EHLO parlance.local', [250]);
      } else if (!implicitTls && requireTls && user) {
        throw new Error('smtp server does not offer STARTTLS; refusing to send credentials in clear text');
      }
      if (user) await cmd(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString('base64')}`, [235]);
      await cmd(`MAIL FROM:<${clean(from, 254)}>`, [250]);
      await cmd(`RCPT TO:<${clean(to, 254)}>`, [250, 251]);
      await cmd('DATA', [354]);
      const body = String(text).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
      const msg = [`From: Parlance <${clean(from, 254)}>`, `To: <${clean(to, 254)}>`, `Subject: ${clean(subject)}`, `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${newId('m')}@parlance.local>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', body, '.'].join('\r\n');
      await cmd(msg, [250]);
      sock.write('QUIT\r\n');
      clearTimeout(timer);
      setTimeout(() => sock.end(), 50);
      resolve();
    })().catch(fail);
  });
}

function createMessaging({ db, keyDir, options = {} }) {
  db.exec(SCHEMA);
  const production = process.env.NODE_ENV === 'production';
  const smtpUrl = options.smtpUrl ?? process.env.SMTP_URL ?? '';
  const mailFrom = options.mailFrom ?? process.env.MAIL_FROM ?? 'no-reply@parlance.local';
  const smsUrl = options.smsWebhookUrl ?? process.env.SMS_WEBHOOK_URL ?? '';
  const smsToken = options.smsWebhookToken ?? process.env.SMS_WEBHOOK_TOKEN ?? '';
  const emailTransport = smtpUrl ? 'smtp' : production ? 'none' : 'dev';
  const smsTransport = smsUrl ? 'webhook' : production ? 'none' : 'dev';
  const devOutbox = options.devOutbox ?? !production; // /dev/mailbox and the dev SMS outbox
  const encKey = kc.deriveKey('field-encryption:v1', { dir: keyDir });

  // Email. Never throws for delivery problems (a failed alert must not fail the request); returns {ok, transport}.
  async function sendEmail({ userId = null, to, subject, text }) {
    const row = (body) => db.prepare('INSERT INTO email_outbox(id,user_id,to_email,subject,body,created_at) VALUES(?,?,?,?,?,?)').run(newId('em_'), userId, emailTransport === 'dev' ? clean(to, 254) : maskEmail(to), clean(subject), body, nowIso());
    if (emailTransport === 'dev') { row(String(text)); return { ok: true, transport: 'dev' }; }
    if (emailTransport === 'none') { console.error('email: no SMTP_URL configured; message not sent'); return { ok: false, transport: 'none' }; }
    try {
      await smtpSend({ url: smtpUrl, from: mailFrom, to, subject, text });
      row('(sent via SMTP; body not stored)');
      return { ok: true, transport: 'smtp' };
    } catch (e) {
      console.error('email: SMTP delivery failed:', e.message); // the message and recipient are not logged
      return { ok: false, transport: 'smtp' };
    }
  }

  // SMS. Throws 503 sms_unavailable when no provider can deliver (the caller shows a clear error).
  async function sendSms({ userId = null, to, masked, body, kind = '' }) {
    if (smsTransport === 'none') throw new ApiError(503, 'sms_unavailable', 'text messages cannot be sent right now', 'no SMS provider is configured');
    const id = newId('sms_');
    if (smsTransport === 'dev') {
      db.prepare('INSERT INTO sms_outbox(id,user_id,to_masked,to_enc,body,kind,transport,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, userId, masked, kc.encrypt(to, `sms_outbox.to:${id}`, encKey), body, kind, 'dev', nowIso());
      return { ok: true, transport: 'dev' };
    }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10000);
    try {
      const r = await fetch(smsUrl, { method: 'POST', headers: { 'content-type': 'application/json', ...(smsToken ? { authorization: `Bearer ${smsToken}` } : {}) }, body: JSON.stringify({ to, body }), signal: ctl.signal });
      if (!r.ok) throw new Error(`status ${r.status}`);
    } catch (e) {
      console.error('sms: provider delivery failed:', e.message);
      throw new ApiError(503, 'sms_unavailable', 'text messages cannot be sent right now', 'please try again in a few minutes');
    } finally { clearTimeout(t); }
    db.prepare('INSERT INTO sms_outbox(id,user_id,to_masked,to_enc,body,kind,transport,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id, userId, masked, null, '', kind, 'webhook', nowIso());
    return { ok: true, transport: 'webhook' };
  }

  // Dev mailbox (tests and local development read it). Not registered in production.
  function mountDevRoutes(v1) {
    if (!devOutbox) return;
    const linkRe = /https?:\/\/[^\s]+|\/(?:verify-email|reset-password)\?token=[A-Za-z0-9._~-]+/g;
    v1.get('/dev/mailbox', (req, res) => {
      const to = String(req.query.to || '').trim().toLowerCase();
      const rows = to ? db.prepare('SELECT * FROM email_outbox WHERE lower(to_email)=? ORDER BY created_at DESC, rowid DESC LIMIT 100').all(to)
        : db.prepare('SELECT * FROM email_outbox ORDER BY created_at DESC, rowid DESC LIMIT 100').all();
      res.setHeader('Cache-Control', 'no-store');
      res.json({ transport: emailTransport, messages: rows.map((m) => ({ id: m.id, to: m.to_email, subject: m.subject, body: m.body, links: (m.body.match(linkRe) || []), time: m.created_at })) });
    });
    v1.get('/dev/sms', (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ transport: smsTransport, messages: db.prepare('SELECT id, to_masked, body, kind, created_at FROM sms_outbox ORDER BY created_at DESC, rowid DESC LIMIT 100').all()
        .map((m) => ({ id: m.id, to: m.to_masked, body: m.body, kind: m.kind, time: m.created_at })) });
    });
  }

  function purge(maxAgeMs = 30 * 86400000) {
    const cut = new Date(Date.now() - maxAgeMs).toISOString();
    db.prepare('DELETE FROM sms_outbox WHERE created_at<?').run(cut);
    db.prepare('DELETE FROM email_outbox WHERE created_at<?').run(cut);
  }

  return { sendEmail, sendSms, mountDevRoutes, purge, info: () => ({ email: emailTransport, sms: smsTransport, dev_outbox: devOutbox }) };
}

module.exports = { createMessaging, smtpSend };
