'use strict';
// Live chat completion (PLAN gap G10, P2.1/P2.2; PHASE2_SPEC.md §24.7): reactions from a small fixed emoji set
// (toggle, counts live over the `chat` WebSocket channel), editing own messages within 5 minutes ("edited" marker,
// history kept for moderators), sticker messages (ids from the moderated sticker set, never URLs) and per-user mutes
// on history reads (live frames are filtered by the muter's client: the public `chat` channel carries nicknames only,
// never user ids, so the server cannot and does not reveal who muted whom).
// Tables (CREATE TABLE IF NOT EXISTS; chat_messages itself is unchanged apart from the body/edited_ts it already has).
const { tx } = require('./db');
const { newId, ApiError, E } = require('./util');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_reactions (message_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, reaction TEXT NOT NULL, created_ts INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, reaction));
CREATE INDEX IF NOT EXISTS idx_chat_reactions_msg ON chat_reactions(message_id);
CREATE TABLE IF NOT EXISTS chat_message_edits (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, editor_id TEXT, prev_body TEXT NOT NULL, new_body TEXT NOT NULL, edited_ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_chat_edits_msg ON chat_message_edits(message_id, edited_ts);
CREATE TABLE IF NOT EXISTS chat_message_extras (message_id TEXT PRIMARY KEY, sticker_id TEXT);
`;

// Fixed set (design choice): key → emoji. Keys travel on the wire; the client renders the emoji from its own table.
const REACTIONS = { up: '👍', heart: '❤️', laugh: '😂', wow: '😮', fire: '🔥', chart: '📈' };
const EDIT_WINDOW_MS = 5 * 60 * 1000;

function bucket(burst, perSec) {
  const m = new Map();
  return {
    take(key) {
      const now = Date.now();
      const b = m.get(key) || { tokens: burst, ts: now };
      b.tokens = Math.min(burst, b.tokens + ((now - b.ts) / 1000) * perSec);
      b.ts = now; m.set(key, b);
      if (b.tokens < 1) return Math.max(1, Math.ceil((1 - b.tokens) / perSec));
      b.tokens -= 1;
      return 0;
    },
  };
}

function mountChatExtras({ v1, db, chat, social, requireUser, can, options = {} }) {
  db.exec(SCHEMA);
  const opt = { editWindowMs: EDIT_WINDOW_MS, ...options };

  const countsOf = (mid) => {
    const out = {};
    for (const r of db.prepare('SELECT reaction, COUNT(*) c FROM chat_reactions WHERE message_id=? GROUP BY reaction').all(mid)) if (REACTIONS[r.reaction]) out[r.reaction] = r.c;
    return out;
  };
  // Message shape additions: reactions {key: count}, my_reactions (REST to a signed-in viewer only), sticker.
  chat.hooks.vo.push((vo, r, viewerId) => {
    vo.reactions = countsOf(r.id);
    if (viewerId) vo.my_reactions = db.prepare('SELECT reaction FROM chat_reactions WHERE message_id=? AND user_id=?').all(r.id, viewerId).map((x) => x.reaction);
    const x = db.prepare('SELECT sticker_id FROM chat_message_extras WHERE message_id=?').get(r.id);
    vo.sticker = x?.sticker_id ? social.stickerVo(x.sticker_id) : null;
    vo.edited_time = r.edited_ts ? new Date(r.edited_ts).toISOString() : null;
  });
  chat.hooks.beforeMessage = (req) => { const s = social.stickerParam(req.body?.sticker_id); return { sticker: s, allowEmptyBody: !!s }; };
  chat.hooks.afterMessage = (mid, ext) => { if (ext?.sticker) db.prepare('INSERT INTO chat_message_extras(message_id,sticker_id) VALUES(?,?)').run(mid, ext.sticker); };
  chat.hooks.historyFilter = (r, viewer) => !social.isMuted(viewer, r.user_id);

  // Member writes share chat's guards: locked account, posting ban, social switch, per-user + per-IP chat buckets.
  function target(req) {
    const t = chat.tickerParam(req.params.ticker);
    const m = chat.msgById(req.params.id);
    if (!m || m.room !== t || m.deleted) throw E.notFound();
    return { t, m };
  }
  function roomOpen(t, uid) {
    const room = chat.roomRow(t);
    const status = chat.roomStatus(room, chat.eventActive(t));
    if (status === 'locked') throw new ApiError(403, 'chat_locked', 'this chat is locked by a moderator');
    if (status === 'read_only') throw new ApiError(403, 'chat_closed', 'this chat is read-only because the event is closed');
    if (chat.muteRow(t, uid)) throw new ApiError(403, 'chat_muted', 'you are muted in this chat');
  }

  // Reactions: PUT adds, DELETE removes (idempotent), so a client toggle is safe to retry.
  // Reactions get their own (larger) buckets so a few taps never eat the chat send budget.
  const env = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? n : d; };
  const rBuckets = { user: bucket(env('CHAT_REACT_USER_BURST', 20), env('CHAT_REACT_USER_PER_SEC', 2)), ip: bucket(env('CHAT_REACT_IP_BURST', 60), env('CHAT_REACT_IP_PER_SEC', 6)) };
  function guardReaction(req, res) {
    const uid = req.auth.user.id;
    if (db.prepare('SELECT 1 FROM acct_locks WHERE user_id=?').get(uid)) throw new ApiError(403, 'account_locked', 'this account is locked');
    if (db.prepare('SELECT 1 FROM mod_bans WHERE user_id=?').get(uid)) throw new ApiError(403, 'posting_banned', 'you are not allowed to post', 'your posting privileges were removed by a moderator');
    const f = db.prepare("SELECT value FROM admin_settings WHERE key='features'").get();
    try { if (f && JSON.parse(f.value).social === false) throw new ApiError(403, 'feature_disabled', 'social features are turned off'); } catch (e) { if (e instanceof ApiError) throw e; }
    const w = Math.max(rBuckets.user.take(uid), rBuckets.ip.take(req.ip || 'local'));
    if (w) { res.setHeader('Retry-After', String(w)); const e = new ApiError(429, 'too_many_requests', 'too many requests', `slow down, try again in ${w}s`); e.toJSON = function toJSON() { return { error: { code: this.code, message: this.message, details: this.details, retry_after_sec: w } }; }; throw e; }
  }
  const react = (on) => (req, res) => {
    guardReaction(req, res);
    const { t, m } = target(req);
    const key = String(req.params.reaction);
    if (!Object.prototype.hasOwnProperty.call(REACTIONS, key)) throw E.badRequest(`reaction must be one of ${Object.keys(REACTIONS).join(', ')}`);
    roomOpen(t, req.auth.user.id);
    const uid = req.auth.user.id;
    if (on) db.prepare('INSERT INTO chat_reactions(message_id,user_id,reaction,created_ts) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(m.id, uid, key, Date.now());
    else db.prepare('DELETE FROM chat_reactions WHERE message_id=? AND user_id=? AND reaction=?').run(m.id, uid, key);
    const reactions = countsOf(m.id);
    chat.publish(t, 'chat_reactions', { event_ticker: t, id: m.id, reactions });
    res.json({ id: m.id, reactions, my_reactions: db.prepare('SELECT reaction FROM chat_reactions WHERE message_id=? AND user_id=?').all(m.id, uid).map((x) => x.reaction) });
  };
  v1.put('/users/:uid/chat/:ticker/messages/:id/reactions/:reaction', requireUser, react(true));
  v1.delete('/users/:uid/chat/:ticker/messages/:id/reactions/:reaction', requireUser, react(false));

  // Edit own message within the window; previous text kept in chat_message_edits for moderators.
  v1.put('/users/:uid/chat/:ticker/messages/:id', requireUser, (req, res) => {
    chat.guardWriter(req, res);
    const { t, m } = target(req);
    if (m.user_id !== req.auth.user.id) throw E.notFound(); // someone else's message is indistinguishable from a missing one
    roomOpen(t, req.auth.user.id);
    if (Date.now() - m.created_ts > opt.editWindowMs) throw new ApiError(409, 'edit_window_closed', `messages can be edited for ${Math.round(opt.editWindowMs / 60000)} minutes after sending`);
    const hasSticker = !!db.prepare('SELECT sticker_id FROM chat_message_extras WHERE message_id=?').get(m.id)?.sticker_id;
    const raw = req.body?.body;
    const body = hasSticker && (raw == null || (typeof raw === 'string' && !raw.trim())) ? '' : chat.cleanBody(raw);
    if (body !== m.body) {
      const now = Date.now();
      tx(db, () => {
        db.prepare('INSERT INTO chat_message_edits(id,message_id,editor_id,prev_body,new_body,edited_ts) VALUES(?,?,?,?,?,?)').run(newId('ce_'), m.id, req.auth.user.id, m.body, body, now);
        db.prepare('UPDATE chat_messages SET body=?, edited_ts=? WHERE id=?').run(body, now, m.id);
      });
      chat.publish(t, 'chat_edited', chat.makeVo()(chat.msgById(m.id)));
    }
    res.json({ message: chat.makeVo()(chat.msgById(m.id), req.auth.user.id) });
  });

  // Moderators: full edit history of one message (also shown in Admin › Chat › room).
  v1.get('/admin/chat/messages/:id/edits', can('social.moderate'), (req, res) => {
    const m = chat.msgById(req.params.id);
    if (!m) throw E.notFound();
    res.json({ message: { id: m.id, event_ticker: m.room, nickname: m.nickname, body: m.body, created_time: new Date(m.created_ts).toISOString(), edited_time: m.edited_ts ? new Date(m.edited_ts).toISOString() : null, deleted: !!m.deleted, mod_state: m.mod_state },
      edits: db.prepare('SELECT * FROM chat_message_edits WHERE message_id=? ORDER BY edited_ts').all(m.id).map((e) => ({ id: e.id, edited_time: new Date(e.edited_ts).toISOString(), previous_body: e.prev_body, new_body: e.new_body })) });
  });

  return { REACTIONS };
}

module.exports = { mountChatExtras, REACTIONS, EDIT_WINDOW_MS };
