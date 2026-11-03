'use strict';
// Event live chat (CHAT_SPEC.md §20). One room per event, created lazily on first write. Everything is persisted in
// the SQLite tables below (CREATE TABLE IF NOT EXISTS; no existing table changes). Sending is REST only, so the
// session cookie, the x-csrf-token check, the global rate limiter, account locks and posting bans all apply; the
// `chat` WebSocket channel is receive-only. Moderation reuses the admin role model (permission `social.moderate`),
// the admin audit log (admin_audit) and the admin report queue (mod_reports, kind 'chat').
//
// Security notes:
// - Message bodies are stored raw and only ever rendered client-side with textContent; the server never builds HTML.
// - Public payloads carry the author's nickname snapshot + verified flag only (never emails or user ids).
// - Message ids are random UUIDs (unguessable); pagination cursors are message ids validated against the room.
const { tx } = require('./db');
const { nowIso, newId, ApiError, E } = require('./util');
const { ROLE_PERMS } = require('./admin');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_rooms (event_ticker TEXT PRIMARY KEY, slow_mode_sec INTEGER NOT NULL DEFAULT 0, locked INTEGER NOT NULL DEFAULT 0, lock_reason TEXT NOT NULL DEFAULT '',
  after_close TEXT NOT NULL DEFAULT 'read_only', pinned_message_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, room TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname TEXT NOT NULL, body TEXT NOT NULL, reply_to TEXT, created_ts INTEGER NOT NULL, edited_ts INTEGER, deleted INTEGER NOT NULL DEFAULT 0, deleted_by TEXT, deleted_ts INTEGER,
  mod_state TEXT NOT NULL DEFAULT 'visible');
CREATE INDEX IF NOT EXISTS idx_chat_messages_room ON chat_messages(room, deleted, seq);
CREATE INDEX IF NOT EXISTS idx_chat_messages_user ON chat_messages(room, user_id, created_ts);
CREATE TABLE IF NOT EXISTS chat_mutes (room TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, until_ts INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '',
  muted_by TEXT, created_at TEXT NOT NULL, PRIMARY KEY (room, user_id));
`;

const MAX_LEN = 280;
const MAX_RAW = 4000; // reject absurd payloads before normalising
const COMBO_SERIES = 'PLXCOMBO';
const SLOW_MODES = [0, 5, 10, 30, 60, 120, 300];
const MUTE_MAX_MIN = 7 * 24 * 60;
// C0/C1 controls (incl. line breaks and tabs), line/paragraph separators.
const CONTROL = new RegExp('[\\x00-\\x1F\\x7F-\\x9F' + String.fromCodePoint(0x2028, 0x2029) + ']');
// Bidirectional overrides / isolates and invisible direction marks (text-spoofing).
const BIDI = new RegExp(`[${String.fromCodePoint(0x061c, 0x200e, 0x200f)}${String.fromCodePoint(0x202a)}-${String.fromCodePoint(0x202e)}${String.fromCodePoint(0x2066)}-${String.fromCodePoint(0x2069)}]`);
const ZALGO = /\p{M}{6,}/u;
const TICKER = /^[A-Z0-9][A-Z0-9._-]{0,63}$/;

// Token bucket keyed by user id or IP; take() returns 0 when allowed, else seconds until the next token.
function bucket(burst, perSec) {
  const m = new Map();
  return {
    take(key) {
      const now = Date.now();
      const b = m.get(key) || { tokens: burst, ts: now };
      b.tokens = Math.min(burst, b.tokens + ((now - b.ts) / 1000) * perSec);
      b.ts = now;
      m.set(key, b);
      if (b.tokens < 1) return Math.max(1, Math.ceil((1 - b.tokens) / perSec));
      b.tokens -= 1;
      return 0;
    },
    prune() { const now = Date.now(); for (const [k, b] of m) if (b.tokens + ((now - b.ts) / 1000) * perSec >= burst) m.delete(k); },
  };
}

// API error with extra machine-readable fields (retry_after_sec, muted_until) inside the standard envelope.
class ChatError extends ApiError {
  constructor(status, code, message, details, extra) { super(status, code, message, details); this.extra = extra || {}; }
  toJSON() { const j = super.toJSON(); Object.assign(j.error, this.extra); return j; }
}
const tooMany = (res, sec, why) => { res.setHeader('Retry-After', String(sec)); return new ChatError(429, 'too_many_requests', 'too many requests', why, { retry_after_sec: sec }); };

function cleanBody(raw) {
  if (typeof raw !== 'string') throw E.badRequest('body must be a string');
  if (raw.length > MAX_RAW) throw E.badRequest(`message must be at most ${MAX_LEN} characters`);
  if (typeof raw.isWellFormed === 'function' && !raw.isWellFormed()) throw E.badRequest('message contains invalid characters');
  const s = raw.normalize('NFC').trim();
  if (!s) throw E.badRequest('message cannot be empty');
  if (CONTROL.test(s)) throw E.badRequest('message cannot contain control characters such as line breaks or tabs');
  if (BIDI.test(s)) throw E.badRequest('message cannot contain text-direction override characters');
  if (ZALGO.test(s)) throw E.badRequest('message contains too many combining marks');
  if ([...s].length > MAX_LEN) throw E.badRequest(`message must be at most ${MAX_LEN} characters`);
  return s;
}

function mountChat({ v1, app, db, engine, requireUser, rolesOf, notify }) {
  db.exec(SCHEMA);
  const env = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? n : d; };
  // Stricter than the global limiter (300 burst / 150 per s per IP): per user and per IP, chat writes only.
  const limits = { userBurst: env('CHAT_USER_BURST', 5), userPerSec: env('CHAT_USER_PER_SEC', 0.5), ipBurst: env('CHAT_IP_BURST', 20), ipPerSec: env('CHAT_IP_PER_SEC', 2) };
  const userBucket = bucket(limits.userBurst, limits.userPerSec);
  const ipBucket = bucket(limits.ipBurst, limits.ipPerSec);

  // ------------------------------------------------------------ helpers
  const getEvent = (t) => db.prepare('SELECT ticker, title, series_ticker FROM events WHERE ticker=?').get(t);
  const isLocked = (uid) => !!db.prepare('SELECT 1 FROM acct_locks WHERE user_id=?').get(uid);
  const isBanned = (uid) => !!db.prepare('SELECT 1 FROM mod_bans WHERE user_id=?').get(uid);
  const nicknameOf = (uid) => db.prepare('SELECT nickname FROM social_profiles WHERE user_id=?').get(uid)?.nickname || null;
  const isMod = (u) => !!u && rolesOf(u).some((r) => (ROLE_PERMS[r] || []).includes('social.moderate'));
  const socialOn = () => {
    const r = db.prepare("SELECT value FROM admin_settings WHERE key='features'").get();
    try { return !r || JSON.parse(r.value).social !== false; } catch { return true; }
  };
  function tickerParam(raw) {
    const t = String(raw || '').toUpperCase();
    if (!TICKER.test(t)) throw E.notFound();
    const ev = getEvent(t);
    if (!ev || ev.series_ticker === COMBO_SERIES) throw E.notFound();
    return t;
  }
  const DEFAULT_ROOM = { slow_mode_sec: 0, locked: 0, lock_reason: '', after_close: 'read_only', pinned_message_id: null, created_at: null };
  const roomRow = (t) => db.prepare('SELECT * FROM chat_rooms WHERE event_ticker=?').get(t) || { event_ticker: t, ...DEFAULT_ROOM };
  function ensureRoom(t) {
    const now = nowIso();
    db.prepare('INSERT INTO chat_rooms(event_ticker,created_at,updated_at) VALUES(?,?,?) ON CONFLICT(event_ticker) DO NOTHING').run(t, now, now);
  }
  const eventActive = (t) => !!db.prepare("SELECT 1 FROM markets WHERE event_ticker=? AND status='active' LIMIT 1").get(t);
  const roomStatus = (room, active) => (room.locked ? 'locked' : active || room.after_close === 'open' ? 'open' : 'read_only');

  // Presence: distinct WebSocket connections subscribed to `chat` for the event (approximate online count).
  function onlineCounts() {
    const out = new Map();
    const hub = app.locals.wsHub;
    if (!hub) return out;
    for (const c of hub.clients) {
      const seen = new Set();
      for (const s of c.subs.values()) if (s.channel === 'chat' && s.tickers) for (const t of s.tickers) seen.add(t);
      for (const t of seen) out.set(t, (out.get(t) || 0) + 1);
    }
    return out;
  }
  const onlineOf = (t) => onlineCounts().get(t) || 0;

  // ------------------------------------------------------------ serializers (public: nickname + verified only)
  function makeVo() {
    const ver = new Map();
    const verified = (uid) => { if (!ver.has(uid)) ver.set(uid, !!db.prepare('SELECT 1 FROM mod_verified WHERE user_id=?').get(uid)); return ver.get(uid); };
    const replyVo = (id) => {
      if (!id) return null;
      const p = db.prepare('SELECT id, nickname, body, deleted FROM chat_messages WHERE id=?').get(id);
      if (!p || p.deleted) return { id, deleted: true };
      const chars = [...p.body];
      return { id: p.id, nickname: p.nickname, excerpt: chars.length > 90 ? chars.slice(0, 90).join('') + '…' : p.body, deleted: false };
    };
    return (r, viewerId) => {
      const vo = { id: r.id, event_ticker: r.room, body: r.body, created_time: new Date(r.created_ts).toISOString(), edited: !!r.edited_ts,
        author: { nickname: r.nickname, verified: verified(r.user_id) }, reply_to: replyVo(r.reply_to) };
      if (viewerId !== undefined) vo.is_mine = !!viewerId && viewerId === r.user_id;
      return vo;
    };
  }
  const msgById = (id) => db.prepare('SELECT * FROM chat_messages WHERE id=?').get(String(id || ''));
  function pinnedVo(room) {
    if (!room.pinned_message_id) return null;
    const m = msgById(room.pinned_message_id);
    return m && !m.deleted ? makeVo()(m) : null;
  }
  function roomVo(t, room = roomRow(t)) {
    const active = eventActive(t);
    return { event_ticker: t, status: roomStatus(room, active), event_active: active, locked: !!room.locked, lock_reason: room.locked ? room.lock_reason : '',
      slow_mode_sec: room.slow_mode_sec, after_close: room.after_close, pinned: pinnedVo(room), online: onlineOf(t),
      message_count: db.prepare('SELECT COUNT(*) c FROM chat_messages WHERE room=? AND deleted=0').get(t).c };
  }
  const muteRow = (t, uid) => { const r = db.prepare('SELECT * FROM chat_mutes WHERE room=? AND user_id=?').get(t, uid); return r && r.until_ts > Date.now() ? r : null; };
  const lastPostTs = (t, uid) => db.prepare('SELECT MAX(created_ts) ts FROM chat_messages WHERE room=? AND user_id=?').get(t, uid).ts || 0;
  function viewerVo(user, t, room) {
    if (!user) return { signed_in: false, can_post: false, block: 'signed_out' };
    const mod = isMod(user);
    const nick = nicknameOf(user.id);
    const mute = muteRow(t, user.id);
    const status = roomStatus(room, eventActive(t));
    const wait = !mod && room.slow_mode_sec ? Math.max(0, Math.ceil((lastPostTs(t, user.id) + room.slow_mode_sec * 1000 - Date.now()) / 1000)) : 0;
    const block = isBanned(user.id) ? 'banned' : !socialOn() ? 'feature_disabled' : !nick ? 'no_nickname' : status === 'locked' ? 'locked' : status === 'read_only' ? 'closed' : mute ? 'muted' : null;
    return { signed_in: true, nickname: nick, is_moderator: mod, can_post: !block, block, muted_until: mute ? new Date(mute.until_ts).toISOString() : null, slow_mode_wait_sec: wait };
  }

  const publish = (t, type, msg) => engine.emit('chat', t, type, msg);
  const publishState = (t) => publish(t, 'chat_room_state', roomVo(t));
  const publishPinned = (t) => publish(t, 'chat_pinned', { event_ticker: t, pinned: pinnedVo(roomRow(t)) });

  function audit(req, action, targetId, before, after, reason = '') {
    db.prepare('INSERT INTO admin_audit(id,ts,actor_id,actor_email,action,target_type,target_id,before_json,after_json,reason) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(newId('au_'), Date.now(), req.auth.user.id, req.auth.user.email, action, 'chat', String(targetId), before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), reason || '');
  }

  // Shared guards for every chat write by a member.
  function guardWriter(req, res) {
    const u = req.auth.user;
    if (isLocked(u.id)) throw new ApiError(403, 'account_locked', 'this account is locked', 'contact support to restore access');
    if (isBanned(u.id)) throw new ApiError(403, 'posting_banned', 'you are not allowed to post', 'your posting privileges were removed by a moderator');
    if (!socialOn()) throw new ApiError(403, 'feature_disabled', 'social features are turned off');
    const ipWait = ipBucket.take(req.ip || 'local');
    const userWait = userBucket.take(u.id);
    if (ipWait || userWait) throw tooMany(res, Math.max(ipWait, userWait), `you are sending messages too quickly, try again in ${Math.max(ipWait, userWait)}s`);
  }

  // Soft delete (kept for moderator review); unpins; resolves open reports when a moderator removes it.
  function removeMessage(req, m, byMod, reason) {
    const room = roomRow(m.room);
    tx(db, () => {
      db.prepare('UPDATE chat_messages SET deleted=1, deleted_by=?, deleted_ts=?, mod_state=? WHERE id=?').run(req.auth.user.id, Date.now(), byMod ? 'moderator_removed' : 'author_deleted', m.id);
      if (room.pinned_message_id === m.id) db.prepare('UPDATE chat_rooms SET pinned_message_id=NULL, updated_at=? WHERE event_ticker=?').run(nowIso(), m.room);
      if (byMod) {
        db.prepare("UPDATE mod_reports SET status='actioned', resolution='delete', resolved_by=?, resolved_at=? WHERE kind='chat' AND content_id=? AND status='open'").run(req.auth.user.id, nowIso(), m.id);
        audit(req, 'chat.delete', m.id, { room: m.room, nickname: m.nickname, body: m.body }, { mod_state: 'moderator_removed' }, reason);
      }
    });
    publish(m.room, 'chat_deleted', { event_ticker: m.room, id: m.id });
    if (room.pinned_message_id === m.id) publishPinned(m.room);
  }

  // ------------------------------------------------------------ public read
  v1.get('/events/:ticker/chat', (req, res) => {
    const t = tickerParam(req.params.ticker);
    let limit = 50;
    if (req.query.limit !== undefined) {
      limit = Number(req.query.limit);
      if (!/^\d+$/.test(String(req.query.limit)) || limit < 1 || limit > 100) throw E.badRequest('limit must be a whole number from 1 to 100');
    }
    let beforeSeq = Number.MAX_SAFE_INTEGER;
    if (req.query.before) {
      const b = db.prepare('SELECT seq, room FROM chat_messages WHERE id=?').get(String(req.query.before));
      if (!b || b.room !== t) throw E.badRequest('invalid before cursor');
      beforeSeq = b.seq;
    }
    const rows = db.prepare('SELECT * FROM chat_messages WHERE room=? AND deleted=0 AND seq<? ORDER BY seq DESC LIMIT ?').all(t, beforeSeq, limit + 1);
    const vo = makeVo();
    const viewer = req.auth ? req.auth.user.id : null;
    const room = roomRow(t);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ room: roomVo(t, room), messages: rows.slice(0, limit).reverse().map((r) => vo(r, viewer)), has_more: rows.length > limit, viewer: viewerVo(req.auth?.user, t, room) });
  });

  // ------------------------------------------------------------ member writes
  v1.post('/users/:uid/chat/:ticker/messages', requireUser, (req, res) => {
    guardWriter(req, res);
    const u = req.auth.user;
    const nick = nicknameOf(u.id);
    if (!nick) throw E.conflict('social_profile_required', 'pick a nickname before chatting', 'create a social profile (nickname) first');
    const t = tickerParam(req.params.ticker);
    const b = req.body || {};
    const body = cleanBody(b.body);
    let replyTo = null;
    if (b.reply_to != null && b.reply_to !== '') {
      if (typeof b.reply_to !== 'string') throw E.badRequest('reply_to must be a message id');
      const p = msgById(b.reply_to);
      if (!p || p.room !== t) throw E.badRequest('reply_to must be a message in this room');
      if (p.deleted) throw E.badRequest('that message was deleted');
      replyTo = p.id;
    }
    const room = roomRow(t);
    const status = roomStatus(room, eventActive(t));
    if (status === 'locked') throw new ApiError(403, 'chat_locked', 'this chat is locked by a moderator', room.lock_reason || undefined);
    if (status === 'read_only') throw new ApiError(403, 'chat_closed', 'this chat is read-only because the event is closed');
    const mute = muteRow(t, u.id);
    if (mute) {
      const until = new Date(mute.until_ts).toISOString();
      throw new ChatError(403, 'chat_muted', 'you are muted in this chat', `a moderator muted you until ${until}`, { muted_until: until });
    }
    const mod = isMod(u);
    if (room.slow_mode_sec && !mod) {
      const wait = Math.ceil((lastPostTs(t, u.id) + room.slow_mode_sec * 1000 - Date.now()) / 1000);
      if (wait > 0) throw tooMany(res, wait, `slow mode is on: wait ${wait}s before your next message`);
    }
    const m = { id: newId('cm_'), room: t, user_id: u.id, nickname: nick, body, reply_to: replyTo, created_ts: Date.now() };
    tx(db, () => {
      ensureRoom(t);
      db.prepare('INSERT INTO chat_messages(id,room,user_id,nickname,body,reply_to,created_ts) VALUES(?,?,?,?,?,?,?)').run(m.id, t, u.id, nick, body, replyTo, m.created_ts);
    });
    const row = msgById(m.id);
    publish(t, 'chat_message', makeVo()(row));
    res.status(201).json({ message: makeVo()(row, u.id), slow_mode_sec: room.slow_mode_sec });
  });

  v1.delete('/users/:uid/chat/:ticker/messages/:id', requireUser, (req, res) => {
    const t = tickerParam(req.params.ticker);
    const m = msgById(req.params.id);
    if (!m || m.room !== t || m.deleted) throw E.notFound();
    const own = m.user_id === req.auth.user.id;
    if (!own && !isMod(req.auth.user)) throw E.forbidden('you can only delete your own messages');
    if (own && isLocked(req.auth.user.id)) throw E.unauthorized();
    removeMessage(req, m, !own, String((req.body && req.body.reason) || '').slice(0, 300));
    res.json({ ok: true });
  });

  // Report → the admin report queue (mod_reports, kind 'chat', post_id = event ticker).
  v1.post('/users/:uid/chat/:ticker/messages/:id/report', requireUser, (req, res) => {
    guardWriter(req, res);
    const t = tickerParam(req.params.ticker);
    const m = msgById(req.params.id);
    if (!m || m.room !== t || m.deleted) throw E.notFound();
    if (m.user_id === req.auth.user.id) throw E.badRequest('you cannot report your own message');
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (reason.length < 3 || reason.length > 300 || CONTROL.test(reason)) throw E.badRequest('tell us what is wrong (3-300 characters)');
    const dup = db.prepare("SELECT id FROM mod_reports WHERE reporter_id=? AND kind='chat' AND content_id=? AND status='open'").get(req.auth.user.id, m.id);
    if (dup) return res.json({ report: { id: dup.id, status: 'open' }, duplicate: true });
    const id = newId('rp_');
    db.prepare('INSERT INTO mod_reports(id,reporter_id,kind,content_id,post_id,author_id,excerpt,reason,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, req.auth.user.id, 'chat', m.id, t, m.user_id, m.body.slice(0, 280), reason, 'open', nowIso());
    res.status(201).json({ report: { id, status: 'open' } });
  });

  // ------------------------------------------------------------ moderation (admin role model: social.moderate)
  const requireMod = (req, res, next) => {
    if (!req.auth) return next(E.unauthorized());
    if (!isMod(req.auth.user)) return next(new ApiError(403, 'forbidden', 'forbidden', 'your role does not include social.moderate'));
    next();
  };
  const A = '/admin/chat';
  v1.get(`${A}/rooms`, requireMod, (req, res) => {
    const since = Date.now() - 86400000;
    const now = Date.now();
    const online = onlineCounts();
    const rows = db.prepare(`SELECT r.*, e.title,
        (SELECT COUNT(*) FROM chat_messages m WHERE m.room=r.event_ticker AND m.deleted=0) n,
        (SELECT COUNT(*) FROM chat_messages m WHERE m.room=r.event_ticker AND m.created_ts>=?) n24,
        (SELECT MAX(created_ts) FROM chat_messages m WHERE m.room=r.event_ticker) last_ts,
        (SELECT COUNT(*) FROM chat_mutes x WHERE x.room=r.event_ticker AND x.until_ts>?) mutes,
        (SELECT COUNT(*) FROM mod_reports p WHERE p.kind='chat' AND p.post_id=r.event_ticker AND p.status='open') reports
      FROM chat_rooms r LEFT JOIN events e ON e.ticker=r.event_ticker ORDER BY last_ts DESC NULLS LAST LIMIT 500`).all(since, now);
    res.json({ rooms: rows.map((r) => ({ event_ticker: r.event_ticker, title: r.title || r.event_ticker, status: roomStatus(r, eventActive(r.event_ticker)), slow_mode_sec: r.slow_mode_sec, locked: !!r.locked,
      pinned: !!r.pinned_message_id, messages: r.n, messages_24h: r.n24, last_message_time: r.last_ts ? new Date(r.last_ts).toISOString() : null, active_mutes: r.mutes, open_reports: r.reports, online: online.get(r.event_ticker) || 0 })) });
  });
  v1.get(`${A}/rooms/:ticker`, requireMod, (req, res) => {
    const t = tickerParam(req.params.ticker);
    const vo = makeVo();
    const msgs = db.prepare('SELECT * FROM chat_messages WHERE room=? ORDER BY seq DESC LIMIT 200').all(t)
      .map((r) => ({ ...vo(r), deleted: !!r.deleted, mod_state: r.mod_state }));
    const mutes = db.prepare('SELECT x.*, sp.nickname FROM chat_mutes x LEFT JOIN social_profiles sp ON sp.user_id=x.user_id WHERE x.room=? AND x.until_ts>? ORDER BY x.until_ts').all(t, Date.now())
      .map((x) => ({ nickname: x.nickname || '(no nickname)', muted_until: new Date(x.until_ts).toISOString(), reason: x.reason }));
    res.json({ room: { ...roomVo(t), title: getEvent(t).title }, messages: msgs, mutes });
  });
  v1.post(`${A}/rooms/:ticker/:action`, requireMod, (req, res) => {
    const t = tickerParam(req.params.ticker);
    const b = req.body || {};
    const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 500) : '';
    const before = roomRow(t);
    const upd = (sql, ...args) => tx(db, () => { ensureRoom(t); db.prepare(`UPDATE chat_rooms SET ${sql}, updated_at=? WHERE event_ticker=?`).run(...args, nowIso(), t); });
    const target = () => { const m = msgById(b.message_id); if (!m || m.room !== t) throw E.notFound(); return m; };
    switch (req.params.action) {
      case 'delete': {
        const m = target();
        if (m.deleted) throw E.notFound();
        removeMessage(req, m, true, reason);
        return res.json({ ok: true });
      }
      case 'pin': {
        const m = target();
        if (m.deleted) throw E.badRequest('that message was deleted');
        upd('pinned_message_id=?', m.id);
        audit(req, 'chat.pin', t, { pinned_message_id: before.pinned_message_id }, { pinned_message_id: m.id }, reason);
        publishPinned(t);
        return res.json({ room: roomVo(t) });
      }
      case 'unpin': {
        upd('pinned_message_id=NULL');
        audit(req, 'chat.unpin', t, { pinned_message_id: before.pinned_message_id }, { pinned_message_id: null }, reason);
        publishPinned(t);
        return res.json({ room: roomVo(t) });
      }
      case 'slow_mode': {
        const s = Number(b.seconds);
        if (!SLOW_MODES.includes(s)) throw E.badRequest(`seconds must be one of ${SLOW_MODES.join(', ')}`);
        upd('slow_mode_sec=?', s);
        audit(req, 'chat.slow_mode', t, { slow_mode_sec: before.slow_mode_sec }, { slow_mode_sec: s }, reason);
        publishState(t);
        return res.json({ room: roomVo(t) });
      }
      case 'lock':
      case 'unlock': {
        const lock = req.params.action === 'lock';
        upd('locked=?, lock_reason=?', lock ? 1 : 0, lock ? reason : '');
        audit(req, `chat.${req.params.action}`, t, { locked: !!before.locked }, { locked: lock }, reason);
        publishState(t);
        return res.json({ room: roomVo(t) });
      }
      case 'settings': {
        if (!['read_only', 'open'].includes(b.after_close)) throw E.badRequest('after_close must be read_only or open');
        upd('after_close=?', b.after_close);
        audit(req, 'chat.settings', t, { after_close: before.after_close }, { after_close: b.after_close }, reason);
        publishState(t);
        return res.json({ room: roomVo(t) });
      }
      case 'mute': {
        const minutes = Number(b.minutes);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > MUTE_MAX_MIN) throw E.badRequest(`minutes must be a whole number from 1 to ${MUTE_MAX_MIN}`);
        let uid;
        if (b.message_id) uid = target().user_id;
        else { const p = db.prepare('SELECT user_id FROM social_profiles WHERE nickname=?').get(String(b.nickname || '')); if (!p) throw E.notFound(); uid = p.user_id; }
        if (uid === req.auth.user.id) throw E.badRequest('you cannot mute yourself');
        const until = Date.now() + minutes * 60000;
        tx(db, () => {
          ensureRoom(t);
          db.prepare('INSERT INTO chat_mutes(room,user_id,until_ts,reason,muted_by,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(room,user_id) DO UPDATE SET until_ts=excluded.until_ts, reason=excluded.reason, muted_by=excluded.muted_by, created_at=excluded.created_at')
            .run(t, uid, until, reason, req.auth.user.id, nowIso());
          audit(req, 'chat.mute', t, null, { nickname: nicknameOf(uid), minutes, muted_until: new Date(until).toISOString() }, reason);
        });
        if (notify) notify(uid, { type: 'account', title: `You were muted in a live chat for ${minutes} minute${minutes === 1 ? '' : 's'}`, body: reason, link: '/' });
        return res.json({ nickname: nicknameOf(uid), muted_until: new Date(until).toISOString() });
      }
      case 'unmute': {
        const p = db.prepare('SELECT user_id FROM social_profiles WHERE nickname=?').get(String(b.nickname || ''));
        if (!p) throw E.notFound();
        db.prepare('DELETE FROM chat_mutes WHERE room=? AND user_id=?').run(t, p.user_id);
        audit(req, 'chat.unmute', t, null, { nickname: b.nickname }, reason);
        return res.json({ ok: true });
      }
      default: throw E.notFound();
    }
  });

  // ------------------------------------------------------------ admin report queue integration
  // Runs at the app level ahead of the v1 router: chat reports (mod_reports.kind = 'chat') get accurate
  // content flags in the queue, and Hide / Delete on them removes the chat message (dismiss stays with admin.js).
  app.use('/v1', (req, res, next) => {
    if (req.method === 'GET' && req.path === '/admin/moderation/reports') {
      const json = res.json.bind(res);
      res.json = (body) => {
        try {
          if (res.statusCode < 400 && body && Array.isArray(body.reports)) {
            for (const r of body.reports) {
              if (r.kind !== 'chat') continue;
              const m = msgById(r.content_id);
              r.content_exists = !!m && !m.deleted;
              r.hidden = false;
              r.event_ticker = r.post_id;
            }
          }
        } catch (e) { console.error('chat reports decorate', e); }
        return json(body);
      };
      return next();
    }
    const mm = req.method === 'POST' && /^\/admin\/moderation\/reports\/([^/]+)\/(hide|delete)$/.exec(req.path);
    if (!mm) return next();
    const r = db.prepare('SELECT * FROM mod_reports WHERE id=?').get(decodeURIComponent(mm[1]));
    if (!r || r.kind !== 'chat') return next();
    try {
      if (!req.auth || isLocked(req.auth.user.id)) throw E.unauthorized();
      if (!isMod(req.auth.user)) throw new ApiError(403, 'forbidden', 'forbidden', 'your role does not include social.moderate');
      const m = msgById(r.content_id);
      const reason = String((req.body && req.body.reason) || '').trim().slice(0, 500) || `report ${r.id}`;
      if (m && !m.deleted) removeMessage(req, m, true, reason);
      db.prepare("UPDATE mod_reports SET status='actioned', resolution=?, resolved_by=?, resolved_at=? WHERE kind='chat' AND content_id=? AND status='open'").run(mm[2], req.auth.user.id, nowIso(), r.content_id);
      const after = db.prepare('SELECT * FROM mod_reports WHERE id=?').get(r.id);
      return res.json({ report: { id: after.id, kind: 'chat', content_id: after.content_id, status: after.status, resolution: after.resolution } });
    } catch (e) { return next(e); }
  });

  // ------------------------------------------------------------ live room state: presence + market lifecycle
  let lastOnline = new Map();
  let lastTick = 0;
  let lastPrune = Date.now();
  engine.on('tick', () => {
    const now = Date.now();
    if (now - lastTick < 2000) return;
    lastTick = now;
    try {
      const cur = onlineCounts();
      for (const t of new Set([...cur.keys(), ...lastOnline.keys()])) if ((cur.get(t) || 0) !== (lastOnline.get(t) || 0) && TICKER.test(String(t)) && getEvent(t)) publishState(t);
      lastOnline = cur;
      if (now - lastPrune > 60000) { lastPrune = now; userBucket.prune(); ipBucket.prune(); }
    } catch (e) { console.error('chat presence', e); }
  });
  engine.on('lifecycle', (marketTicker) => {
    try {
      const m = db.prepare('SELECT event_ticker FROM markets WHERE ticker=?').get(marketTicker);
      if (m && (lastOnline.has(m.event_ticker) || db.prepare('SELECT 1 FROM chat_rooms WHERE event_ticker=?').get(m.event_ticker))) publishState(m.event_ticker);
    } catch (e) { console.error('chat lifecycle', e); }
  });

  return { roomVo, limits };
}

module.exports = { mountChat, cleanBody, MAX_LEN };
