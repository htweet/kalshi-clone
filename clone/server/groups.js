'use strict';
// Group chats (PLAN §11 A11; CLONE_SPEC §13.16 notification row "Group chats"; PHASE2_SPEC.md §24.7).
//
// Private rooms of up to 50 people. A group is created from the creator's mutual follows and Inner Circle; any member
// may add their own mutual follows / circle members; the owner can rename and remove members; anyone can leave (the
// owner's role passes to the longest-standing member). Messages are persisted and delivered live over the private
// `groups` WebSocket channel to current members only (membership is re-read for every publish).
//
// Same security model as event chat (server/chat.js, CLONE_SPEC §20.6): session + CSRF on every write (sending is REST
// only), per-user and per-IP token buckets, posting bans, locked accounts, the social feature switch, one-line plain
// text (NFC, no control / bidi characters) rendered client-side with textContent only, unguessable ids, no user ids or
// emails in payloads, mute (the viewer's mutes hide that author's messages) and report (admin report queue, kind
// 'group'). Non-members get 404 for every group path, so group ids cannot be probed. Moderators (social.moderate) can
// open a group in Admin › Group chats — every such view is written to the audit log — delete messages, remove
// members and lock the group.
const { tx } = require('./db');
const { nowIso, newId, ApiError, E } = require('./util');
const { bucket, limit, cleanText, cleanReason, schemaGuard, isModerator, audit, iso, NICK, ID } = require('./community-util');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT REFERENCES users(id) ON DELETE SET NULL, created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0, lock_reason TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS chat_group_members (group_id TEXT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member', joined_ts INTEGER NOT NULL, added_by TEXT, last_read_seq INTEGER NOT NULL DEFAULT 0, notified_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (group_id, user_id));
CREATE INDEX IF NOT EXISTS idx_chat_group_members_user ON chat_group_members(user_id);
CREATE TABLE IF NOT EXISTS chat_group_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, group_id TEXT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL DEFAULT 'text', nickname TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', sticker_id TEXT, reply_to TEXT,
  created_ts INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, deleted_by TEXT, deleted_ts INTEGER, mod_state TEXT NOT NULL DEFAULT 'visible');
CREATE INDEX IF NOT EXISTS idx_chat_group_messages_group ON chat_group_messages(group_id, deleted, seq);
`;
const MAX_MEMBERS = 50;
const MAX_GROUPS = 100;
const MAX_BODY = 500;
const PAGE_MAX = 100;

function mountGroups({ v1, app, db, engine, requireUser, rolesOf, can, getFeat, social, circle }) {
  db.exec(SCHEMA);
  const userBucket = bucket(8, 0.5);
  const ipBucket = bucket(30, 3);
  const adminBucket = bucket(20, 1); // create / invite / rename / remove / leave per user

  v1.use(schemaGuard([
    ['POST', /^\/users\/([^/]+)\/groups$/, { name: { type: 'string', maxLen: 200, required: true }, members: { type: 'array', maxItems: MAX_MEMBERS, items: { type: 'string', maxLen: 20 }, required: true } }, { unknown: 'reject' }, 'owner'],
    ['PUT', /^\/users\/([^/]+)\/groups\/[^/]+$/, { name: { type: 'string', maxLen: 200, required: true } }, { unknown: 'reject' }, 'owner'],
    ['POST', /^\/users\/([^/]+)\/groups\/[^/]+\/members$/, { nicknames: { type: 'array', maxItems: MAX_MEMBERS, items: { type: 'string', maxLen: 20 }, required: true } }, { unknown: 'reject' }, 'owner'],
    ['POST', /^\/users\/([^/]+)\/groups\/[^/]+\/messages$/, { body: { type: 'string', maxLen: 4000, nullable: true }, sticker_id: { type: 'string', maxLen: 40, nullable: true }, reply_to: { type: 'string', maxLen: 80, nullable: true } }, { unknown: 'reject' }, 'owner'],
    ['POST', /^\/users\/([^/]+)\/groups\/[^/]+\/messages\/[^/]+\/report$/, { reason: { type: 'string', maxLen: 1000, required: true } }, { unknown: 'reject' }, 'owner'],
    ['PUT', /^\/users\/([^/]+)\/groups\/[^/]+\/read$/, { message_id: { type: 'string', maxLen: 80 } }, { unknown: 'reject' }, 'owner'],
    ['POST', /^\/admin\/groups\/[^/]+\/[^/]+$/, { message_id: { type: 'string', maxLen: 80 }, nickname: { type: 'string', maxLen: 20 }, reason: { type: 'string', maxLen: 1000 } }, { unknown: 'reject' }, 'staff'],
  ], { rolesOf }));

  // ------------------------------------------------------------ helpers
  const profileOf = (uid) => db.prepare('SELECT * FROM social_profiles WHERE user_id=?').get(uid);
  const byNick = (n) => db.prepare('SELECT * FROM social_profiles WHERE nickname=?').get(String(n || ''));
  const verified = (uid) => !!uid && !!db.prepare('SELECT 1 FROM mod_verified WHERE user_id=?').get(uid);
  const isBanned = (uid) => !!db.prepare('SELECT 1 FROM mod_bans WHERE user_id=?').get(uid);
  const socialOn = () => { const r = db.prepare("SELECT value FROM admin_settings WHERE key='features'").get(); try { return !r || JSON.parse(r.value).social !== false; } catch { return true; } };
  const groupRow = (gid) => (ID.test(String(gid || '')) ? db.prepare('SELECT * FROM chat_groups WHERE id=?').get(String(gid)) : null);
  const memberRow = (gid, uid) => db.prepare('SELECT * FROM chat_group_members WHERE group_id=? AND user_id=?').get(gid, uid);
  const memberIds = (gid) => db.prepare('SELECT user_id FROM chat_group_members WHERE group_id=?').all(gid).map((r) => r.user_id);
  const msgById = (id) => db.prepare('SELECT * FROM chat_group_messages WHERE id=?').get(String(id || ''));
  // Mutual follow or Inner Circle: the people `uid` can bring into a group.
  const connected = (uid, other) => circle.isMember(uid, other)
    || !!db.prepare('SELECT 1 FROM follows a JOIN follows b ON b.follower_id=a.followee_id AND b.followee_id=a.follower_id WHERE a.follower_id=? AND a.followee_id=?').get(uid, other);
  // A group the caller belongs to; anything else (missing, other people's, malformed id) is 404.
  function memberGroup(req) {
    const g = groupRow(req.params.gid);
    if (!g || g.archived) throw E.notFound();
    const m = memberRow(g.id, req.auth.user.id);
    if (!m) throw E.notFound();
    return { g, m };
  }
  const requireNick = (uid) => { const p = profileOf(uid); if (!p) throw E.conflict('social_profile_required', 'pick a nickname before chatting', 'create a social profile (nickname) first'); return p; };
  function guardWriter(req, res, bucketPairs) {
    const uid = req.auth.user.id;
    if (db.prepare('SELECT 1 FROM acct_locks WHERE user_id=?').get(uid)) throw new ApiError(403, 'account_locked', 'this account is locked', 'contact support to restore access');
    if (isBanned(uid)) throw new ApiError(403, 'posting_banned', 'you are not allowed to post', 'your posting privileges were removed by a moderator');
    if (!socialOn()) throw new ApiError(403, 'feature_disabled', 'social features are turned off');
    limit(res, bucketPairs, 'you are sending too quickly');
  }
  const cleanName = (raw) => cleanText(raw, 50, { field: 'name', multiline: false });

  // ------------------------------------------------------------ serializers (no user ids or emails)
  function msgVo(r, viewer) {
    let reply = null;
    if (r.reply_to) {
      const p = msgById(r.reply_to);
      reply = !p || p.deleted ? { id: r.reply_to, deleted: true } : { id: p.id, nickname: p.nickname, excerpt: [...p.body].length > 90 ? [...p.body].slice(0, 90).join('') + '…' : (p.body || '[sticker]'), deleted: false };
    }
    const vo = { id: r.id, group_id: r.group_id, kind: r.kind, body: r.body, sticker: r.sticker_id ? social.stickerVo(r.sticker_id) : null, created_time: iso(r.created_ts),
      author: r.kind === 'system' ? null : { nickname: r.nickname, verified: verified(r.user_id) }, reply_to: reply };
    if (viewer !== undefined) vo.is_mine = !!viewer && viewer === r.user_id;
    return vo;
  }
  function membersVo(gid) {
    return db.prepare('SELECT m.role, m.joined_ts, sp.nickname, m.user_id FROM chat_group_members m LEFT JOIN social_profiles sp ON sp.user_id=m.user_id WHERE m.group_id=? ORDER BY m.role DESC, m.joined_ts')
      .all(gid).map((m) => ({ nickname: m.nickname || 'unknown', role: m.role, verified: verified(m.user_id), joined_time: iso(m.joined_ts) }));
  }
  const unreadOf = (gid, uid, lastRead) => db.prepare("SELECT COUNT(*) c FROM chat_group_messages WHERE group_id=? AND seq>? AND deleted=0 AND kind='text' AND (user_id IS NULL OR user_id<>?) AND (user_id IS NULL OR user_id NOT IN (SELECT muted_id FROM user_mutes WHERE muter_id=?))").get(gid, lastRead, uid, uid).c;
  function groupVo(g, uid) {
    const m = memberRow(g.id, uid);
    const last = db.prepare("SELECT * FROM chat_group_messages WHERE group_id=? AND deleted=0 AND (user_id IS NULL OR user_id NOT IN (SELECT muted_id FROM user_mutes WHERE muter_id=?)) ORDER BY seq DESC LIMIT 1").get(g.id, uid);
    return { id: g.id, name: g.name, role: m ? m.role : null, locked: !!g.locked, lock_reason: g.locked ? g.lock_reason : '', created_time: iso(g.created_ts), updated_time: iso(g.updated_ts),
      member_count: db.prepare('SELECT COUNT(*) c FROM chat_group_members WHERE group_id=?').get(g.id).c, unread: m ? unreadOf(g.id, uid, m.last_read_seq) : 0,
      last_message: last ? { kind: last.kind, nickname: last.kind === 'system' ? null : last.nickname, excerpt: last.body ? ([...last.body].length > 80 ? [...last.body].slice(0, 80).join('') + '…' : last.body) : last.sticker_id ? 'Sticker' : '', created_time: iso(last.created_ts) } : null };
  }

  // ------------------------------------------------------------ live delivery + notifications
  const emitTo = (uid, type, msg) => engine.emit('group', uid, type, msg);
  function publishMessage(g, row) {
    for (const uid of memberIds(g.id)) emitTo(uid, 'group_message', { ...msgVo(row), is_mine: uid === row.user_id });
  }
  const publishGroup = (g, type = 'group_updated') => { for (const uid of memberIds(g.id)) emitTo(uid, type, groupVo(groupRow(g.id), uid)); };
  function systemMessage(g, text) {
    const id = newId('gm_');
    db.prepare("INSERT INTO chat_group_messages(id,group_id,user_id,kind,nickname,body,created_ts) VALUES(?,?,NULL,'system','',?,?)").run(id, g.id, text, Date.now());
    const row = msgById(id);
    publishMessage(g, row);
    return row;
  }
  // One notification per unread burst per member: a member is notified again only after reading past the last one.
  function notifyMembers(g, row, author) {
    for (const m of db.prepare('SELECT * FROM chat_group_members WHERE group_id=? AND user_id<>?').all(g.id, row.user_id)) {
      if (m.notified_seq > m.last_read_seq) continue;
      if (social.isMuted(m.user_id, row.user_id)) continue;
      db.prepare('UPDATE chat_group_members SET notified_seq=? WHERE group_id=? AND user_id=?').run(row.seq, g.id, m.user_id);
      getFeat().notify(m.user_id, { type: 'group_chat', title: `@${author.nickname} in ${g.name}`, body: row.body ? row.body.slice(0, 120) : 'Sticker', link: `/messages/${encodeURIComponent(g.id)}`, actor: row.user_id });
    }
  }

  // ------------------------------------------------------------ reads
  v1.get('/users/:uid/groups', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const rows = db.prepare('SELECT g.* FROM chat_groups g JOIN chat_group_members m ON m.group_id=g.id WHERE m.user_id=? AND g.archived=0 ORDER BY g.updated_ts DESC LIMIT ?').all(uid, MAX_GROUPS);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ groups: rows.map((g) => groupVo(g, uid)) });
  });
  v1.get('/users/:uid/groups/candidates', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const rows = db.prepare(`SELECT DISTINCT sp.nickname, sp.user_id FROM social_profiles sp WHERE sp.user_id<>? AND (
        sp.user_id IN (SELECT member_id FROM circle_members WHERE owner_id=?)
        OR sp.user_id IN (SELECT a.followee_id FROM follows a JOIN follows b ON b.follower_id=a.followee_id AND b.followee_id=a.follower_id WHERE a.follower_id=?))
      AND sp.user_id NOT IN (SELECT muted_id FROM user_mutes WHERE muter_id=?) ORDER BY sp.nickname COLLATE NOCASE LIMIT 500`).all(uid, uid, uid, uid);
    res.json({ candidates: rows.map((r) => ({ nickname: r.nickname, in_circle: circle.isMember(uid, r.user_id), verified: verified(r.user_id) })) });
  });
  v1.get('/users/:uid/groups/:gid', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const { g } = memberGroup(req);
    let lim = 50;
    if (req.query.limit !== undefined) { lim = Number(req.query.limit); if (!/^\d+$/.test(String(req.query.limit)) || lim < 1 || lim > PAGE_MAX) throw E.badRequest(`limit must be a whole number from 1 to ${PAGE_MAX}`); }
    let beforeSeq = Number.MAX_SAFE_INTEGER;
    if (req.query.before) { const b = msgById(req.query.before); if (!b || b.group_id !== g.id) throw E.badRequest('invalid before cursor'); beforeSeq = b.seq; }
    const rows = db.prepare('SELECT * FROM chat_group_messages WHERE group_id=? AND deleted=0 AND seq<? ORDER BY seq DESC LIMIT ?').all(g.id, beforeSeq, lim + 1);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ group: { ...groupVo(g, uid), members: membersVo(g.id) },
      messages: rows.slice(0, lim).reverse().filter((r) => !r.user_id || !social.isMuted(uid, r.user_id)).map((r) => msgVo(r, uid)), has_more: rows.length > lim });
  });

  // ------------------------------------------------------------ group lifecycle
  function addMembers(g, inviter, nicks, { creating = false } = {}) {
    const uniq = [...new Set(nicks.map((x) => String(x).trim()))];
    const out = [];
    for (const nick of uniq) {
      if (!NICK.test(nick)) throw E.badRequest(`${nick || '(empty)'} is not a nickname`);
      const p = byNick(nick);
      // Same answer for "no such trader", "not connected" and "muted you": membership cannot be used to probe accounts.
      if (!p || p.user_id === inviter || !connected(inviter, p.user_id) || social.isMuted(p.user_id, inviter) || isBanned(p.user_id)) {
        throw E.conflict('cannot_add_member', `you can add people who follow you back or are in your Inner Circle (${nick})`);
      }
      if (memberRow(g.id, p.user_id)) { if (creating) continue; throw E.conflict('already_member', `@${p.nickname} is already in this group`); }
      out.push(p);
    }
    const count = db.prepare('SELECT COUNT(*) c FROM chat_group_members WHERE group_id=?').get(g.id).c;
    if (count + out.length > MAX_MEMBERS) throw E.conflict('group_full', `a group holds at most ${MAX_MEMBERS} people`);
    const now = Date.now();
    for (const p of out) db.prepare("INSERT INTO chat_group_members(group_id,user_id,role,joined_ts,added_by,last_read_seq,notified_seq) VALUES(?,?,'member',?,?,COALESCE((SELECT MAX(seq) FROM chat_group_messages WHERE group_id=?),0),0)").run(g.id, p.user_id, now, inviter, g.id);
    return out;
  }
  v1.post('/users/:uid/groups', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const me = requireNick(uid);
    guardWriter(req, res, [[adminBucket, uid]]);
    const name = cleanName(req.body?.name);
    const nicks = Array.isArray(req.body?.members) ? req.body.members : null;
    if (!nicks || !nicks.length) throw E.badRequest('add at least one person to start a group');
    if (db.prepare('SELECT COUNT(*) c FROM chat_group_members WHERE user_id=?').get(uid).c >= MAX_GROUPS) throw E.conflict('too_many_groups', `you can be in at most ${MAX_GROUPS} group chats`);
    const g = { id: newId('grp_'), name, now: Date.now() };
    let added = [];
    tx(db, () => {
      db.prepare('INSERT INTO chat_groups(id,name,created_by,created_ts,updated_ts) VALUES(?,?,?,?,?)').run(g.id, name, uid, g.now, g.now);
      db.prepare("INSERT INTO chat_group_members(group_id,user_id,role,joined_ts,added_by) VALUES(?,?,'owner',?,?)").run(g.id, uid, g.now, uid);
      added = addMembers(groupRow(g.id), uid, nicks, { creating: true });
      if (!added.length) throw E.badRequest('add at least one person to start a group');
    });
    const row = groupRow(g.id);
    systemMessage(row, `@${me.nickname} created the group with ${added.map((p) => `@${p.nickname}`).join(', ')}`);
    for (const p of added) getFeat().notify(p.user_id, { type: 'group_chat', title: `@${me.nickname} added you to ${name}`, body: 'Group chat', link: `/messages/${encodeURIComponent(g.id)}`, actor: uid });
    publishGroup(row);
    res.status(201).json({ group: { ...groupVo(row, uid), members: membersVo(g.id) } });
  });
  v1.put('/users/:uid/groups/:gid', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const me = requireNick(uid);
    const { g, m } = memberGroup(req);
    guardWriter(req, res, [[adminBucket, uid]]);
    if (m.role !== 'owner') throw new ApiError(403, 'not_group_owner', 'only the group owner can rename the group');
    const name = cleanName(req.body?.name);
    if (name !== g.name) {
      db.prepare('UPDATE chat_groups SET name=?, updated_ts=? WHERE id=?').run(name, Date.now(), g.id);
      systemMessage(g, `@${me.nickname} renamed the group to “${name}”`);
      publishGroup(groupRow(g.id));
    }
    res.json({ group: { ...groupVo(groupRow(g.id), uid), members: membersVo(g.id) } });
  });
  v1.post('/users/:uid/groups/:gid/members', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const me = requireNick(uid);
    const { g } = memberGroup(req);
    guardWriter(req, res, [[adminBucket, uid]]);
    if (g.locked) throw new ApiError(403, 'group_locked', 'a moderator locked this group', g.lock_reason || undefined);
    const nicks = Array.isArray(req.body?.nicknames) ? req.body.nicknames : null;
    if (!nicks || !nicks.length) throw E.badRequest('nicknames must list at least one person');
    let added = [];
    tx(db, () => { added = addMembers(g, uid, nicks); db.prepare('UPDATE chat_groups SET updated_ts=? WHERE id=?').run(Date.now(), g.id); });
    systemMessage(g, `@${me.nickname} added ${added.map((p) => `@${p.nickname}`).join(', ')}`);
    for (const p of added) getFeat().notify(p.user_id, { type: 'group_chat', title: `@${me.nickname} added you to ${g.name}`, body: 'Group chat', link: `/messages/${encodeURIComponent(g.id)}`, actor: uid });
    publishGroup(groupRow(g.id));
    res.status(201).json({ group: { ...groupVo(groupRow(g.id), uid), members: membersVo(g.id) } });
  });
  function removeMember(g, userId, { by = null, text }) {
    const was = memberRow(g.id, userId);
    tx(db, () => {
      db.prepare('DELETE FROM chat_group_members WHERE group_id=? AND user_id=?').run(g.id, userId);
      const left = db.prepare('SELECT * FROM chat_group_members WHERE group_id=? ORDER BY joined_ts, rowid').all(g.id);
      if (!left.length) db.prepare('UPDATE chat_groups SET archived=1, updated_ts=? WHERE id=?').run(Date.now(), g.id);
      else if (was && was.role === 'owner' && !left.some((x) => x.role === 'owner')) db.prepare("UPDATE chat_group_members SET role='owner' WHERE group_id=? AND user_id=?").run(g.id, left[0].user_id);
      db.prepare('UPDATE chat_groups SET updated_ts=? WHERE id=?').run(Date.now(), g.id);
    });
    emitTo(userId, 'group_removed', { id: g.id, by });
    const row = groupRow(g.id);
    if (!row.archived) { systemMessage(row, text); publishGroup(row); }
  }
  v1.post('/users/:uid/groups/:gid/leave', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const { g } = memberGroup(req);
    limit(res, [[adminBucket, uid]]);
    removeMember(g, uid, { by: 'self', text: `@${profileOf(uid)?.nickname || 'someone'} left the group` });
    res.json({ ok: true });
  });
  v1.delete('/users/:uid/groups/:gid/members/:nickname', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const me = requireNick(uid);
    const { g, m } = memberGroup(req);
    guardWriter(req, res, [[adminBucket, uid]]);
    const t = byNick(req.params.nickname);
    if (!t || !memberRow(g.id, t.user_id)) throw E.notFound();
    if (t.user_id === uid) throw E.badRequest('use leave to leave a group');
    if (m.role !== 'owner') throw new ApiError(403, 'not_group_owner', 'only the group owner can remove members');
    removeMember(g, t.user_id, { by: 'owner', text: `@${me.nickname} removed @${t.nickname}` });
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ messages
  v1.post('/users/:uid/groups/:gid/messages', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const me = requireNick(uid);
    const { g } = memberGroup(req);
    guardWriter(req, res, [[userBucket, uid], [ipBucket, req.ip || 'local']]);
    if (g.locked) throw new ApiError(403, 'group_locked', 'a moderator locked this group', g.lock_reason || undefined);
    const b = req.body || {};
    const sticker = social.stickerParam(b.sticker_id);
    const body = cleanText(b.body, MAX_BODY, { allowEmpty: !!sticker, multiline: false });
    let replyTo = null;
    if (b.reply_to != null && b.reply_to !== '') {
      const p = msgById(b.reply_to);
      if (!p || p.group_id !== g.id || p.kind !== 'text') throw E.badRequest('reply_to must be a message in this group');
      if (p.deleted) throw E.badRequest('that message was deleted');
      replyTo = p.id;
    }
    const id = newId('gm_');
    tx(db, () => {
      db.prepare("INSERT INTO chat_group_messages(id,group_id,user_id,kind,nickname,body,sticker_id,reply_to,created_ts) VALUES(?,?,?,'text',?,?,?,?,?)").run(id, g.id, uid, me.nickname, body, sticker, replyTo, Date.now());
      const row = msgById(id);
      db.prepare('UPDATE chat_group_members SET last_read_seq=? WHERE group_id=? AND user_id=?').run(row.seq, g.id, uid);
      db.prepare('UPDATE chat_groups SET updated_ts=? WHERE id=?').run(Date.now(), g.id);
    });
    const row = msgById(id);
    publishMessage(g, row);
    notifyMembers(g, row, me);
    res.status(201).json({ message: msgVo(row, uid) });
  });
  v1.delete('/users/:uid/groups/:gid/messages/:mid', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const { g } = memberGroup(req);
    const m = msgById(req.params.mid);
    if (!m || m.group_id !== g.id || m.deleted || m.user_id !== uid) throw E.notFound();
    db.prepare("UPDATE chat_group_messages SET deleted=1, deleted_by=?, deleted_ts=?, mod_state='author_deleted' WHERE id=?").run(uid, Date.now(), m.id);
    for (const u of memberIds(g.id)) emitTo(u, 'group_message_deleted', { group_id: g.id, id: m.id });
    res.json({ ok: true });
  });
  v1.post('/users/:uid/groups/:gid/messages/:mid/report', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const { g } = memberGroup(req);
    guardWriter(req, res, [[userBucket, uid], [ipBucket, req.ip || 'local']]);
    const m = msgById(req.params.mid);
    if (!m || m.group_id !== g.id || m.deleted || m.kind !== 'text') throw E.notFound();
    if (m.user_id === uid) throw E.badRequest('you cannot report your own message');
    const reason = cleanReason(req.body?.reason, 3, 300);
    const dup = db.prepare("SELECT id FROM mod_reports WHERE reporter_id=? AND kind='group' AND content_id=? AND status='open'").get(uid, m.id);
    if (dup) return res.json({ report: { id: dup.id, status: 'open' }, duplicate: true });
    const id = newId('rp_');
    db.prepare('INSERT INTO mod_reports(id,reporter_id,kind,content_id,post_id,author_id,excerpt,reason,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, uid, 'group', m.id, g.id, m.user_id, (m.body || '[sticker]').slice(0, 280), reason, 'open', nowIso());
    res.status(201).json({ report: { id, status: 'open' } });
  });
  v1.put('/users/:uid/groups/:gid/read', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const { g } = memberGroup(req);
    let seq = db.prepare('SELECT COALESCE(MAX(seq),0) s FROM chat_group_messages WHERE group_id=?').get(g.id).s;
    if (req.body?.message_id) { const m = msgById(req.body.message_id); if (!m || m.group_id !== g.id) throw E.badRequest('message_id must be a message in this group'); seq = m.seq; }
    db.prepare('UPDATE chat_group_members SET last_read_seq=MAX(last_read_seq,?) WHERE group_id=? AND user_id=?').run(seq, g.id, uid);
    res.json({ group: groupVo(groupRow(g.id), uid) });
  });

  // ------------------------------------------------------------ moderation (social.moderate; every action audited)
  const A = '/admin/groups';
  v1.get(A, can('social.moderate'), (req, res) => {
    const rows = db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM chat_group_members m WHERE m.group_id=g.id) members,
        (SELECT COUNT(*) FROM chat_group_messages x WHERE x.group_id=g.id AND x.kind='text') messages,
        (SELECT COUNT(*) FROM mod_reports r WHERE r.kind='group' AND r.post_id=g.id AND r.status='open') reports
      FROM chat_groups g ORDER BY reports DESC, g.updated_ts DESC LIMIT 300`).all();
    res.json({ groups: rows.map((g) => ({ id: g.id, name: g.name, members: g.members, messages: g.messages, open_reports: g.reports, locked: !!g.locked, archived: !!g.archived, updated_time: iso(g.updated_ts), created_time: iso(g.created_ts) })) });
  });
  v1.get(`${A}/:gid`, can('social.moderate'), (req, res) => {
    const g = groupRow(req.params.gid);
    if (!g) throw E.notFound();
    // Private conversations: every moderator view is recorded (who, when, which group).
    audit(db, req, 'group.view', 'group', g.id, null, { name: g.name }, 'moderator opened a group chat');
    const msgs = db.prepare('SELECT * FROM chat_group_messages WHERE group_id=? ORDER BY seq DESC LIMIT 200').all(g.id).map((r) => ({ ...msgVo(r), deleted: !!r.deleted, mod_state: r.mod_state }));
    res.json({ group: { id: g.id, name: g.name, locked: !!g.locked, lock_reason: g.lock_reason, archived: !!g.archived, created_time: iso(g.created_ts), members: membersVo(g.id) }, messages: msgs,
      reports: db.prepare("SELECT id, content_id, reason, status, created_at FROM mod_reports WHERE kind='group' AND post_id=? ORDER BY created_at DESC LIMIT 100").all(g.id) });
  });
  function modDelete(req, g, m, reason) {
    tx(db, () => {
      db.prepare("UPDATE chat_group_messages SET deleted=1, deleted_by=?, deleted_ts=?, mod_state='moderator_removed' WHERE id=?").run(req.auth.user.id, Date.now(), m.id);
      db.prepare("UPDATE mod_reports SET status='actioned', resolution='delete', resolved_by=?, resolved_at=? WHERE kind='group' AND content_id=? AND status='open'").run(req.auth.user.id, nowIso(), m.id);
    });
    audit(db, req, 'group.delete', 'group', g.id, { message_id: m.id, nickname: m.nickname, body: m.body }, { mod_state: 'moderator_removed' }, reason);
    for (const u of memberIds(g.id)) emitTo(u, 'group_message_deleted', { group_id: g.id, id: m.id });
  }
  v1.post(`${A}/:gid/:action`, can('social.moderate'), (req, res) => {
    const g = groupRow(req.params.gid);
    if (!g) throw E.notFound();
    const b = req.body || {};
    const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 500) : '';
    switch (req.params.action) {
      case 'delete': {
        const m = msgById(b.message_id);
        if (!m || m.group_id !== g.id || m.deleted) throw E.notFound();
        modDelete(req, g, m, reason);
        return res.json({ ok: true });
      }
      case 'lock': case 'unlock': {
        const lock = req.params.action === 'lock';
        db.prepare('UPDATE chat_groups SET locked=?, lock_reason=?, updated_ts=? WHERE id=?').run(lock ? 1 : 0, lock ? reason : '', Date.now(), g.id);
        audit(db, req, `group.${req.params.action}`, 'group', g.id, { locked: !!g.locked }, { locked: lock }, reason);
        publishGroup(groupRow(g.id));
        return res.json({ group: { id: g.id, locked: lock } });
      }
      case 'remove_member': {
        const t = byNick(b.nickname);
        if (!t || !memberRow(g.id, t.user_id)) throw E.notFound();
        removeMember(g, t.user_id, { by: 'moderator', text: `A moderator removed @${t.nickname}` });
        audit(db, req, 'group.remove_member', 'group', g.id, { nickname: t.nickname }, null, reason);
        return res.json({ ok: true });
      }
      default: throw E.notFound();
    }
  });

  // Admin report queue: group reports get accurate flags, and Hide / Delete remove the message (app-level hook ahead
  // of the v1 router, like the event chat's; Dismiss stays with server/admin.js).
  app.use('/v1', (req, res, next) => {
    if (req.method === 'GET' && req.path === '/admin/moderation/reports') {
      const json = res.json.bind(res);
      res.json = (body) => {
        try {
          if (res.statusCode < 400 && body && Array.isArray(body.reports)) {
            for (const r of body.reports) { if (r.kind !== 'group') continue; const m = msgById(r.content_id); r.content_exists = !!m && !m.deleted; r.hidden = false; r.group_id = r.post_id; }
          }
        } catch (e) { console.error('group reports decorate', e); }
        return json(body);
      };
      return next();
    }
    const mm = req.method === 'POST' && /^\/admin\/moderation\/reports\/([^/]+)\/(hide|delete)$/.exec(req.path);
    if (!mm) return next();
    const r = db.prepare('SELECT * FROM mod_reports WHERE id=?').get(decodeURIComponent(mm[1]));
    if (!r || r.kind !== 'group') return next();
    try {
      if (!req.auth || db.prepare('SELECT 1 FROM acct_locks WHERE user_id=?').get(req.auth.user.id)) throw E.unauthorized();
      if (!isModerator(rolesOf, req.auth.user)) throw new ApiError(403, 'forbidden', 'forbidden', 'your role does not include social.moderate');
      const g = groupRow(r.post_id);
      const m = msgById(r.content_id);
      const reason = String((req.body && req.body.reason) || '').trim().slice(0, 500) || `report ${r.id}`;
      if (g && m && !m.deleted) modDelete(req, g, m, reason);
      db.prepare("UPDATE mod_reports SET status='actioned', resolution=?, resolved_by=?, resolved_at=? WHERE kind='group' AND content_id=? AND status='open'").run(mm[2], req.auth.user.id, nowIso(), r.content_id);
      const after = db.prepare('SELECT * FROM mod_reports WHERE id=?').get(r.id);
      return res.json({ report: { id: after.id, kind: 'group', content_id: after.content_id, status: after.status, resolution: after.resolution } });
    } catch (e) { return next(e); }
  });

  let lastPrune = Date.now();
  engine.on('tick', () => { if (Date.now() - lastPrune > 60000) { lastPrune = Date.now(); userBucket.prune(); ipBucket.prune(); adminBucket.prune(); } });

  return { groupVo, memberIds };
}

module.exports = { mountGroups, MAX_MEMBERS };
