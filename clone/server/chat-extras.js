'use strict';
// Event live chat completion (PLAN gap G10, P2.1/P2.2; CLONE_SPEC.md §24.8): reactions from a small fixed set
// (toggle; counts live over the `chat` WebSocket channel), editing your own message within 5 minutes ("edited";
// previous text kept for moderators), sticker messages (ids from the moderated sticker set, never URLs) and the
// viewer's mutes on history reads. Live frames carry nicknames only (never user ids), so the muter's client hides
// live messages from muted nicknames itself; the server never reveals who muted whom.
const { tx } = require('./db');
const { newId, ApiError, E } = require('./util');
const { bucket, limit, schemaGuard, iso } = require('./community-util');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_reactions (message_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, reaction TEXT NOT NULL, created_ts INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, reaction));
CREATE INDEX IF NOT EXISTS idx_chat_reactions_msg ON chat_reactions(message_id);
CREATE TABLE IF NOT EXISTS chat_message_edits (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, editor_id TEXT, prev_body TEXT NOT NULL, new_body TEXT NOT NULL, edited_ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_chat_edits_msg ON chat_message_edits(message_id, edited_ts);
CREATE TABLE IF NOT EXISTS chat_message_extras (message_id TEXT PRIMARY KEY, sticker_id TEXT);
`;
// Fixed set (design choice): the key travels on the wire; clients render the emoji from their own table.
const REACTIONS = { up: '👍', heart: '❤️', laugh: '😂', wow: '😮', fire: '🔥', chart: '📈' };
const EDIT_WINDOW_MS = 5 * 60 * 1000;

function mountChatExtras({ v1, db, chat, social, requireUser, rolesOf, can }) {
  db.exec(SCHEMA);
  const opt = { editWindowMs: EDIT_WINDOW_MS };
  const rUser = bucket(20, 2); const rIp = bucket(60, 6);
  v1.use(schemaGuard([
    ['PUT', /^\/users\/([^/]+)\/chat\/[^/]+\/messages\/[^/]+$/, { body: { type: 'string', maxLen: 4000, required: true } }, { unknown: 'reject' }, 'owner'],
  ], { rolesOf }));

  const countsOf = (mid) => {
    const out = {};
    for (const r of db.prepare('SELECT reaction, COUNT(*) c FROM chat_reactions WHERE message_id=? GROUP BY reaction').all(mid)) if (REACTIONS[r.reaction]) out[r.reaction] = r.c;
    return out;
  };
  const mine = (mid, uid) => db.prepare('SELECT reaction FROM chat_reactions WHERE message_id=? AND user_id=?').all(mid, uid).map((x) => x.reaction);
  const stickerOf = (mid) => db.prepare('SELECT sticker_id FROM chat_message_extras WHERE message_id=?').get(mid)?.sticker_id || null;
  chat.hooks.vo.push((vo, r, viewerId) => {
    vo.reactions = countsOf(r.id);
    if (viewerId) vo.my_reactions = mine(r.id, viewerId);
    const s = stickerOf(r.id);
    vo.sticker = s ? social.stickerVo(s) : null;
    vo.edited_time = iso(r.edited_ts);
  });
  chat.hooks.beforeMessage = (req) => { const s = social.stickerParam(req.body?.sticker_id); return { sticker: s, allowEmptyBody: !!s }; };
  chat.hooks.afterMessage = (mid, ext) => { if (ext?.sticker) db.prepare('INSERT INTO chat_message_extras(message_id,sticker_id) VALUES(?,?)').run(mid, ext.sticker); };
  chat.hooks.historyFilter = (r, viewer) => !social.isMuted(viewer, r.user_id);

  function target(req) {
    const t = chat.tickerParam(req.params.ticker);
    const m = chat.msgById(req.params.id);
    if (!m || m.room !== t || m.deleted) throw E.notFound();
    return { t, m };
  }
  function roomOpen(t, uid) {
    const status = chat.roomStatus(chat.roomRow(t), chat.eventActive(t));
    if (status === 'locked') throw new ApiError(403, 'chat_locked', 'this chat is locked by a moderator');
    if (status === 'read_only') throw new ApiError(403, 'chat_closed', 'this chat is read-only because the event is closed');
    if (chat.muteRow(t, uid)) throw new ApiError(403, 'chat_muted', 'you are muted in this chat');
  }
  // Reactions: PUT adds, DELETE removes (idempotent, so a client toggle is safe to retry). Their own buckets, so a few
  // taps never use up the message budget; posting bans, locks and the social switch apply as for messages.
  const react = (on) => (req, res) => {
    const uid = req.auth.user.id;
    if (db.prepare('SELECT 1 FROM acct_locks WHERE user_id=?').get(uid)) throw new ApiError(403, 'account_locked', 'this account is locked');
    if (db.prepare('SELECT 1 FROM mod_bans WHERE user_id=?').get(uid)) throw new ApiError(403, 'posting_banned', 'you are not allowed to post', 'your posting privileges were removed by a moderator');
    const f = db.prepare("SELECT value FROM admin_settings WHERE key='features'").get();
    let socialOn = true; try { socialOn = !f || JSON.parse(f.value).social !== false; } catch { /* default on */ }
    if (!socialOn) throw new ApiError(403, 'feature_disabled', 'social features are turned off');
    limit(res, [[rUser, uid], [rIp, req.ip || 'local']]);
    const { t, m } = target(req);
    const key = String(req.params.reaction);
    if (!Object.prototype.hasOwnProperty.call(REACTIONS, key)) throw E.badRequest(`reaction must be one of ${Object.keys(REACTIONS).join(', ')}`);
    roomOpen(t, uid);
    if (on) db.prepare('INSERT INTO chat_reactions(message_id,user_id,reaction,created_ts) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(m.id, uid, key, Date.now());
    else db.prepare('DELETE FROM chat_reactions WHERE message_id=? AND user_id=? AND reaction=?').run(m.id, uid, key);
    const reactions = countsOf(m.id);
    chat.publish(t, 'chat_reactions', { event_ticker: t, id: m.id, reactions });
    res.json({ id: m.id, reactions, my_reactions: mine(m.id, uid) });
  };
  v1.put('/users/:uid/chat/:ticker/messages/:id/reactions/:reaction', requireUser, react(true));
  v1.delete('/users/:uid/chat/:ticker/messages/:id/reactions/:reaction', requireUser, react(false));

  // Edit your own message within the window; the previous text is kept in chat_message_edits for moderators.
  v1.put('/users/:uid/chat/:ticker/messages/:id', requireUser, (req, res) => {
    chat.guardWriter(req, res);
    const { t, m } = target(req);
    if (m.user_id !== req.auth.user.id) throw E.notFound(); // someone else's message is indistinguishable from a missing one
    roomOpen(t, req.auth.user.id);
    if (Date.now() - m.created_ts > opt.editWindowMs) throw new ApiError(409, 'edit_window_closed', `messages can be edited for ${Math.round(opt.editWindowMs / 60000)} minutes after sending`);
    const raw = req.body?.body;
    const body = stickerOf(m.id) && (raw == null || (typeof raw === 'string' && !raw.trim())) ? '' : chat.cleanBody(raw);
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

  // Moderators: the full edit history of one message (shown in Admin › Chat › room).
  v1.get('/admin/chat/messages/:id/edits', can('social.moderate'), (req, res) => {
    const m = chat.msgById(req.params.id);
    if (!m) throw E.notFound();
    res.json({ message: { id: m.id, event_ticker: m.room, nickname: m.nickname, body: m.body, created_time: iso(m.created_ts), edited_time: iso(m.edited_ts), deleted: !!m.deleted, mod_state: m.mod_state },
      edits: db.prepare('SELECT * FROM chat_message_edits WHERE message_id=? ORDER BY edited_ts').all(m.id).map((e) => ({ id: e.id, edited_time: iso(e.edited_ts), previous_body: e.prev_body, new_body: e.new_body })) });
  });

  return { REACTIONS, prune: () => { rUser.prune(); rIp.prune(); } };
}

module.exports = { mountChatExtras, REACTIONS, EDIT_WINDOW_MS };
