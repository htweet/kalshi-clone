'use strict';
// Inner Circle (PLAN §11 A11; CLONE_SPEC §13.16 notification rows "Inner Circle requests" / "Inner Circle accepted";
// CLONE_SPEC.md §24.6). A close-friends circle: a member sends a request by nickname, the other side accepts or
// declines; accepting makes the relationship mutual (each is in the other's circle); either side can remove it at any
// time. Circle-only posts (server/social2.js) are visible to the author and the author's circle only; Group chats
// (server/groups.js) can be started with circle members. Everything is persisted; mutes and posting bans apply.
const { nowIso, newId, ApiError, E } = require('./util');
const { tx } = require('./db');
const { bucket, limit, schemaGuard, NICK, iso } = require('./community-util');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS circle_requests (id TEXT PRIMARY KEY, from_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, to_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL, created_ts INTEGER NOT NULL, decided_ts INTEGER);
CREATE INDEX IF NOT EXISTS idx_circle_requests_to ON circle_requests(to_id, status);
CREATE INDEX IF NOT EXISTS idx_circle_requests_from ON circle_requests(from_id, status);
CREATE TABLE IF NOT EXISTS circle_members (owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, member_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, PRIMARY KEY (owner_id, member_id));
CREATE INDEX IF NOT EXISTS idx_circle_members_member ON circle_members(member_id);
`;
const MAX_CIRCLE = 150;
const MAX_PENDING = 50;

function mountCircle({ v1, db, requireUser, rolesOf, getFeat, isMuted }) {
  db.exec(SCHEMA);
  const writes = bucket(20, 0.5); // per user
  v1.use(schemaGuard([
    ['POST', /^\/users\/([^/]+)\/social\/circle\/requests$/, { nickname: { type: 'string', maxLen: 20, required: true } }, { unknown: 'reject' }, 'owner'],
  ], { rolesOf }));

  const profileOf = (uid) => db.prepare('SELECT * FROM social_profiles WHERE user_id=?').get(uid);
  const byNick = (n) => db.prepare('SELECT * FROM social_profiles WHERE nickname=?').get(String(n || ''));
  const isMember = (owner, member) => !!db.prepare('SELECT 1 FROM circle_members WHERE owner_id=? AND member_id=?').get(owner, member);
  const membersOf = (uid) => db.prepare('SELECT member_id FROM circle_members WHERE owner_id=?').all(uid).map((r) => r.member_id);
  const pendingBetween = (a, b) => db.prepare("SELECT * FROM circle_requests WHERE from_id=? AND to_id=? AND status='pending'").get(a, b);
  // Relation from viewer's side: member | requested (viewer asked) | incoming (they asked) | null.
  function relation(viewer, other) {
    if (isMember(viewer, other)) return 'member';
    if (pendingBetween(viewer, other)) return 'requested';
    if (pendingBetween(other, viewer)) return 'incoming';
    return null;
  }
  const requireProfile = (uid) => { const p = profileOf(uid); if (!p) throw E.conflict('social_profile_required', 'create a social profile (nickname) first'); return p; };
  const guard = (req, res) => {
    const uid = req.auth.user.id;
    if (db.prepare('SELECT 1 FROM mod_bans WHERE user_id=?').get(uid)) throw new ApiError(403, 'posting_banned', 'you are not allowed to post', 'your social privileges were removed by a moderator');
    limit(res, [[writes, uid]]);
  };
  const reqVo = (r, viewer) => {
    const other = r.from_id === viewer ? r.to_id : r.from_id;
    return { id: r.id, direction: r.from_id === viewer ? 'outgoing' : 'incoming', nickname: profileOf(other)?.nickname || 'unknown', status: r.status, created_time: iso(r.created_ts), decided_time: iso(r.decided_ts) };
  };
  function join(a, b) {
    const now = nowIso();
    db.prepare('INSERT INTO circle_members(owner_id,member_id,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(a, b, now);
    db.prepare('INSERT INTO circle_members(owner_id,member_id,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(b, a, now);
  }
  const notify = (uid, o) => getFeat().notify(uid, o);

  v1.get('/users/:uid/social/circle', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const members = db.prepare('SELECT c.created_at, sp.nickname FROM circle_members c JOIN social_profiles sp ON sp.user_id=c.member_id WHERE c.owner_id=? ORDER BY sp.nickname COLLATE NOCASE').all(uid);
    const incoming = db.prepare("SELECT * FROM circle_requests WHERE to_id=? AND status='pending' ORDER BY created_ts DESC").all(uid).filter((r) => !isMuted(uid, r.from_id));
    const outgoing = db.prepare("SELECT * FROM circle_requests WHERE from_id=? AND status='pending' ORDER BY created_ts DESC").all(uid);
    res.json({ members: members.map((m) => ({ nickname: m.nickname, since: m.created_at })), incoming: incoming.map((r) => reqVo(r, uid)), outgoing: outgoing.map((r) => reqVo(r, uid)), limit: MAX_CIRCLE });
  });

  v1.post('/users/:uid/social/circle/requests', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const me = requireProfile(uid);
    guard(req, res);
    const nick = req.body?.nickname;
    if (typeof nick !== 'string' || !NICK.test(nick)) throw E.badRequest('nickname is required');
    const t = byNick(nick);
    if (!t) throw E.notFound();
    if (t.user_id === uid) throw E.badRequest('you cannot add yourself to your Inner Circle');
    if (isMember(uid, t.user_id)) throw E.conflict('already_in_circle', `@${t.nickname} is already in your Inner Circle`);
    if (db.prepare('SELECT COUNT(*) c FROM circle_members WHERE owner_id=?').get(uid).c >= MAX_CIRCLE) throw E.conflict('circle_full', `an Inner Circle holds at most ${MAX_CIRCLE} people`);
    // They already asked us: requesting back accepts theirs.
    const theirs = pendingBetween(t.user_id, uid);
    if (theirs) {
      tx(db, () => { db.prepare("UPDATE circle_requests SET status='accepted', decided_ts=? WHERE id=?").run(Date.now(), theirs.id); join(uid, t.user_id); });
      notify(t.user_id, { type: 'circle_accepted', title: `@${me.nickname} accepted your Inner Circle request`, link: '/social/circle', actor: uid });
      return res.status(200).json({ request: reqVo(db.prepare('SELECT * FROM circle_requests WHERE id=?').get(theirs.id), uid), relation: 'member' });
    }
    const mine = pendingBetween(uid, t.user_id);
    if (mine) return res.status(200).json({ request: reqVo(mine, uid), relation: 'requested', duplicate: true });
    if (db.prepare("SELECT COUNT(*) c FROM circle_requests WHERE from_id=? AND status='pending'").get(uid).c >= MAX_PENDING) throw E.conflict('too_many_requests_pending', `at most ${MAX_PENDING} pending Inner Circle requests`);
    // A declined request cannot be re-sent for 24 hours (anti-harassment).
    const lastDeclined = db.prepare("SELECT decided_ts FROM circle_requests WHERE from_id=? AND to_id=? AND status='declined' ORDER BY decided_ts DESC LIMIT 1").get(uid, t.user_id);
    if (lastDeclined && Date.now() - lastDeclined.decided_ts < 86400000) throw E.conflict('request_cooldown', 'you can ask again 24 hours after a declined request');
    const r = { id: newId('cr_'), from_id: uid, to_id: t.user_id, status: 'pending', created_ts: Date.now() };
    db.prepare('INSERT INTO circle_requests(id,from_id,to_id,status,created_ts) VALUES(?,?,?,?,?)').run(r.id, r.from_id, r.to_id, r.status, r.created_ts);
    // The gate drops this if the target muted the requester (no notification; the request waits silently).
    notify(t.user_id, { type: 'circle_request', title: `@${me.nickname} wants to add you to their Inner Circle`, body: 'Accept to see each other\'s circle-only posts and chat in groups.', link: '/social/circle', actor: uid });
    res.status(201).json({ request: reqVo(db.prepare('SELECT * FROM circle_requests WHERE id=?').get(r.id), uid), relation: 'requested' });
  });

  const incomingReq = (uid, rid) => {
    const r = db.prepare('SELECT * FROM circle_requests WHERE id=?').get(String(rid));
    if (!r || r.to_id !== uid || r.status !== 'pending') throw E.notFound();
    return r;
  };
  v1.post('/users/:uid/social/circle/requests/:rid/accept', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const me = requireProfile(uid);
    guard(req, res);
    const r = incomingReq(uid, req.params.rid);
    if (db.prepare('SELECT COUNT(*) c FROM circle_members WHERE owner_id=?').get(uid).c >= MAX_CIRCLE) throw E.conflict('circle_full', `an Inner Circle holds at most ${MAX_CIRCLE} people`);
    tx(db, () => { db.prepare("UPDATE circle_requests SET status='accepted', decided_ts=? WHERE id=?").run(Date.now(), r.id); join(uid, r.from_id); });
    notify(r.from_id, { type: 'circle_accepted', title: `@${me.nickname} accepted your Inner Circle request`, link: '/social/circle', actor: uid });
    res.json({ request: reqVo(db.prepare('SELECT * FROM circle_requests WHERE id=?').get(r.id), uid), relation: 'member' });
  });
  v1.post('/users/:uid/social/circle/requests/:rid/decline', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    guard(req, res);
    const r = incomingReq(uid, req.params.rid);
    db.prepare("UPDATE circle_requests SET status='declined', decided_ts=? WHERE id=?").run(Date.now(), r.id); // the requester is not told
    res.json({ request: reqVo(db.prepare('SELECT * FROM circle_requests WHERE id=?').get(r.id), uid) });
  });
  v1.delete('/users/:uid/social/circle/requests/:rid', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    guard(req, res);
    const r = db.prepare('SELECT * FROM circle_requests WHERE id=?').get(String(req.params.rid));
    if (!r || r.from_id !== uid || r.status !== 'pending') throw E.notFound();
    db.prepare("UPDATE circle_requests SET status='cancelled', decided_ts=? WHERE id=?").run(Date.now(), r.id);
    res.json({ ok: true });
  });
  // Remove someone from your circle (mutual: both directions end).
  v1.delete('/users/:uid/social/circle/members', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    guard(req, res);
    const t = byNick(req.query.nickname);
    if (!t || !isMember(uid, t.user_id)) throw E.notFound();
    tx(db, () => {
      db.prepare('DELETE FROM circle_members WHERE (owner_id=? AND member_id=?) OR (owner_id=? AND member_id=?)').run(uid, t.user_id, t.user_id, uid);
    });
    res.json({ ok: true, relation: null });
  });

  return { isMember, membersOf, relation, prune: () => writes.prune() };
}

module.exports = { mountCircle, MAX_CIRCLE };
