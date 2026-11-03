'use strict';
// Social completion (PLAN Phase 2: P2.1–P2.3, A11 position / trade / leaderboard alerts, gap G8; CLONE_SPEC.md §24).
//
//   P2.1  post extras: position tag verified against the author's own positions / fills at post time ("Yes · outcome ·
//         market"), sticker, circle-only visibility, 10-minute edit window with persisted edit history (moderators see
//         it), canonical share path /social/post/:id, per-user mutes applied to feeds, replies, chat, group chats and
//         notifications.
//   P2.2  self-made sticker set (server/stickers.js) stored as ids, admin enable/disable; optional external GIF adapter
//         (server/gif-provider.js), OFF.
//   P2.3  topic follows (events, markets, keywords) with a feed and notifications, nickname-prefix profile search
//         (rate-limited, never by email), timeline counts, earned badges (computed from persisted data, persisted).
//   A11   position alerts (followers / Inner Circle see a followed trader open or close a position, only when that
//         trader shares trades), trade alerts (per-trader opt-in), leaderboard push.
//   G8    the four observed PUT social-admin call sites (bodies are a documented design choice) + promo targeting.
// Tables: CREATE TABLE IF NOT EXISTS; foreign keys to users / posts / comments with ON DELETE CASCADE (seed reset works).
const { tx } = require('./db');
const { nowIso, newId, ufp, ApiError, E } = require('./util');
const { STICKERS, BY_ID: STICKER_SVG, STICKER_ID } = require('./stickers');
const { createGifProvider } = require('./gif-provider');
const { bucket, limit, cleanText, cleanReason, schemaGuard, isModerator, audit, iso, NICK, TICKER } = require('./community-util');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS social_stickers (id TEXT PRIMARY KEY, label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, updated_by TEXT);
CREATE TABLE IF NOT EXISTS post_extras (post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE, sticker_id TEXT, visibility TEXT NOT NULL DEFAULT 'public',
  position_ticker TEXT, position_side TEXT, position_units INTEGER, position_outcome TEXT, position_title TEXT, position_event_ticker TEXT, position_held TEXT,
  edited_ts INTEGER, edit_count INTEGER NOT NULL DEFAULT 0, edited_by_mod INTEGER NOT NULL DEFAULT 0, subtype TEXT NOT NULL DEFAULT 'standard');
CREATE INDEX IF NOT EXISTS idx_post_extras_position ON post_extras(position_ticker);
CREATE INDEX IF NOT EXISTS idx_post_extras_visibility ON post_extras(visibility);
CREATE TABLE IF NOT EXISTS post_edits (id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE, editor_id TEXT, by_moderator INTEGER NOT NULL DEFAULT 0,
  prev_body TEXT NOT NULL, new_body TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', edited_ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_post_edits_post ON post_edits(post_id, edited_ts);
CREATE TABLE IF NOT EXISTS comment_extras (comment_id TEXT PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE, sticker_id TEXT);
CREATE TABLE IF NOT EXISTS user_mutes (muter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, muted_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY (muter_id, muted_id));
CREATE TABLE IF NOT EXISTS topic_follows (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, kind, value));
CREATE INDEX IF NOT EXISTS idx_topic_follows_value ON topic_follows(kind, value);
CREATE TABLE IF NOT EXISTS social_badges (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, badge TEXT NOT NULL, earned_at TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', PRIMARY KEY (user_id, badge));
CREATE TABLE IF NOT EXISTS profile_avatars (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, sticker_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'auto_approved',
  decided_by TEXT, decided_at TEXT, reason TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS social_position_state (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, market_ticker TEXT NOT NULL, side TEXT NOT NULL, updated_ts INTEGER NOT NULL, PRIMARY KEY (user_id, market_ticker));
CREATE TABLE IF NOT EXISTS leaderboard_ranks (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, metric TEXT NOT NULL, rank INTEGER NOT NULL, updated_ts INTEGER NOT NULL, PRIMARY KEY (user_id, metric));
`;

const EDIT_WINDOW_MS = 10 * 60 * 1000;
const MAX_POST = 500;
const MAX_COMMENT = 300;
const SUBTYPES = ['standard', 'analysis', 'news', 'humor', 'promotional'];
const BADGES = [
  ['first_trade', 'First trade', 'Made a first trade'],
  ['ten_trades', '10 trades', 'Completed 10 trades'],
  ['profitable_month', 'Profitable month', 'Settled positions made a profit within one calendar month (UTC)'],
  ['top_10', 'Top 10 trader', 'Reached the top 10 of the profit leaderboard'],
  ['verified', 'Verified', 'Profile verified by Parlance'],
];
const BADGE_LABEL = Object.fromEntries(BADGES.map(([k, l]) => [k, l]));
const KEYWORD = /^[\p{L}\p{N}][\p{L}\p{N} #$&'.+-]{1,31}$/u;

function mountSocial2({ v1, db, engine, requireUser, can, rolesOf, getFeat, circle, getEvent }) {
  db.exec(SCHEMA);
  const opt = { editWindowMs: EDIT_WINDOW_MS };
  const writeBuckets = new Map();
  const searchIp = bucket(20, 2);
  const searchUser = bucket(20, 2);
  const limitWrite = (res, group, uid) => {
    if (!writeBuckets.has(group)) writeBuckets.set(group, bucket(20, 1));
    limit(res, [[writeBuckets.get(group), uid]]);
  };
  const gif = createGifProvider(); // disabled: no provider is configured in this build
  const feat = () => getFeat();

  v1.use(schemaGuard([
    ['PUT', /^\/users\/([^/]+)\/social\/posts\/[^/]+$/, { body: { type: 'string', maxLen: 2000, required: true } }, { unknown: 'reject' }, 'owner'],
    ['POST', /^\/users\/([^/]+)\/social\/mutes$/, { nickname: { type: 'string', maxLen: 20, required: true } }, { unknown: 'reject' }, 'owner'],
    ['POST', /^\/users\/([^/]+)\/social\/topics$/, { kind: { type: 'string', maxLen: 16, required: true }, value: { type: 'string', maxLen: 80, required: true } }, { unknown: 'reject' }, 'owner'],
    ['PUT', /^\/users\/([^/]+)\/social\/profile\/avatar$/, { sticker_id: { type: 'string', maxLen: 40, nullable: true, required: true } }, { unknown: 'reject' }, 'owner'],
    ['PUT', /^\/users\/([^/]+)\/social\/social-admin\//, { decision: { type: 'string', maxLen: 16 }, reason: { type: 'string', maxLen: 1000 }, event_ticker: { type: 'string', maxLen: 64, nullable: true }, position_tag: { type: 'string', maxLen: 8 }, post_subtype: { type: 'string', maxLen: 16 }, body: { type: 'string', maxLen: 2000 } }, { unknown: 'reject' }, 'owner'],
    ['PUT', /^\/admin\/stickers\/[^/]+$/, { enabled: { type: 'boolean' }, reason: { type: 'string', maxLen: 1000 } }, { unknown: 'reject' }, 'staff'],
  ], { rolesOf }));

  // ------------------------------------------------------------ stickers (seeded from server/stickers.js)
  {
    const now = nowIso();
    const ins = db.prepare('INSERT INTO social_stickers(id,label,enabled,position,updated_at) VALUES(?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label');
    STICKERS.forEach((s, i) => ins.run(s.id, s.label, i, now));
  }
  const stickerRow = (id) => db.prepare('SELECT * FROM social_stickers WHERE id=?').get(String(id || ''));
  const stickerUrl = (id) => `/v1/social/stickers/${encodeURIComponent(id)}.svg`;
  const stickerVo = (id) => { const s = stickerRow(id); return s && s.enabled && STICKER_SVG.has(s.id) ? { id: s.id, label: s.label, url: stickerUrl(s.id) } : null; };
  function stickerParam(raw) {
    if (raw == null || raw === '') return null;
    if (typeof raw !== 'string' || !STICKER_ID.test(raw)) throw E.badRequest('sticker_id must be one of the Parlance stickers');
    const s = stickerRow(raw);
    if (!s || !STICKER_SVG.has(s.id)) throw E.badRequest('unknown sticker');
    if (!s.enabled) throw new ApiError(400, 'sticker_disabled', 'that sticker is not available');
    return s.id;
  }

  // ------------------------------------------------------------ shared helpers
  const profileOf = (uid) => db.prepare('SELECT * FROM social_profiles WHERE user_id=?').get(uid);
  const byNick = (n) => db.prepare('SELECT * FROM social_profiles WHERE nickname=?').get(String(n || ''));
  const userRow = (uid) => db.prepare('SELECT * FROM users WHERE id=?').get(uid);
  const isSystem = (uid) => !!userRow(uid)?.is_system;
  const isBanned = (uid) => !!db.prepare('SELECT 1 FROM mod_bans WHERE user_id=?').get(uid);
  const isMuted = (muter, muted) => !!muter && !!muted && muter !== muted && !!db.prepare('SELECT 1 FROM user_mutes WHERE muter_id=? AND muted_id=?').get(muter, muted);
  const requireProfile = (uid) => { const p = profileOf(uid); if (!p) throw E.conflict('social_profile_required', 'create a social profile (nickname) first'); return p; };
  const evLink = (et) => feat().eventLink(et);
  const n = (uid, o) => feat().notify(uid, o);

  // ------------------------------------------------------------ visibility (circle-only posts)
  const extrasOf = (pid) => db.prepare('SELECT * FROM post_extras WHERE post_id=?').get(pid);
  function canView(p, viewer) {
    const x = extrasOf(p.id);
    if (!x || x.visibility !== 'circle') return true;
    if (!viewer) return false;
    if (viewer === p.user_id || circle.isMember(p.user_id, viewer)) return true;
    return isModerator(rolesOf, userRow(viewer));
  }
  const CIRCLE_POST = "SELECT post_id FROM post_extras WHERE visibility='circle'";
  function visibilityClause(viewer) {
    if (!viewer) return { sql: `p.id NOT IN (${CIRCLE_POST})`, args: [] };
    return { sql: `(p.id NOT IN (${CIRCLE_POST}) OR p.user_id=? OR p.user_id IN (SELECT owner_id FROM circle_members WHERE member_id=?))`, args: [viewer, viewer] };
  }
  const mutedClause = (viewer) => ({ sql: 'p.user_id NOT IN (SELECT muted_id FROM user_mutes WHERE muter_id=?)', args: [viewer] });

  // ------------------------------------------------------------ position tags (P2.1)
  // "Held" = a current position on that side, or any buy fill on that side in the past (a sell of YES is stored as a
  // buy of NO with action 'sell', so it does not count as having held NO).
  const marketInfo = (t) => db.prepare('SELECT m.ticker, m.title, m.yes_sub_title, m.event_ticker, m.status, e.title et FROM markets m JOIN events e ON e.ticker=m.event_ticker WHERE m.ticker=?').get(t);
  function heldState(uid, ticker, side) {
    const p = db.prepare('SELECT yes_count, no_count FROM positions WHERE user_id=? AND market_ticker=?').get(uid, ticker);
    const now = p ? (side === 'yes' ? p.yes_count : p.no_count) : 0;
    if (now > 0) return { held: 'current', units: now };
    const past = db.prepare("SELECT 1 FROM fills f JOIN orders o ON o.id=f.order_id WHERE f.user_id=? AND f.market_ticker=? AND f.side=? AND COALESCE(o.action,'buy')='buy' LIMIT 1").get(uid, ticker, side);
    return past ? { held: 'past', units: 0 } : null;
  }
  const tagLabel = (side, outcome, title) => `${side === 'yes' ? 'Yes' : 'No'} · ${outcome} · ${title}`;
  function positionParam(uid, raw) {
    if (raw == null) return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) throw E.badRequest('position must be an object {market_ticker, side}');
    const t = typeof raw.market_ticker === 'string' ? raw.market_ticker.toUpperCase() : '';
    if (!TICKER.test(t)) throw E.badRequest('position.market_ticker is invalid');
    if (!['yes', 'no'].includes(raw.side)) throw E.badRequest('position.side must be yes or no');
    const m = marketInfo(t);
    if (!m) throw E.notFound();
    const h = heldState(uid, t, raw.side);
    if (!h) throw new ApiError(409, 'position_not_held', 'you can only tag a position you hold or have held', `no ${raw.side.toUpperCase()} position on ${t}`);
    return { ticker: t, side: raw.side, units: h.units, held: h.held, outcome: m.yes_sub_title, title: m.title || m.et, event_ticker: m.event_ticker };
  }
  const positionVo = (x) => ({
    market_ticker: x.position_ticker, event_ticker: x.position_event_ticker, side: x.position_side, outcome: x.position_outcome, market_title: x.position_title,
    label: tagLabel(x.position_side, x.position_outcome, x.position_title), held: x.position_held, position_fp: ufp(x.position_units || 0),
    link: `${evLink(x.position_ticker)}?market=${encodeURIComponent(x.position_ticker)}&side=${x.position_side}`,
  });
  v1.get('/users/:uid/social/position_tags', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const cur = db.prepare('SELECT market_ticker t, yes_count, no_count FROM positions WHERE user_id=? AND (yes_count>0 OR no_count>0) ORDER BY updated_at DESC LIMIT 50').all(uid);
    const past = db.prepare("SELECT DISTINCT f.market_ticker t, f.side FROM fills f JOIN orders o ON o.id=f.order_id WHERE f.user_id=? AND COALESCE(o.action,'buy')='buy' ORDER BY f.created_ts DESC LIMIT 100").all(uid);
    const seen = new Set(); const out = [];
    const push = (t, side, held, units) => {
      const k = `${t}:${side}`;
      if (seen.has(k)) return;
      const m = marketInfo(t);
      if (!m) return;
      seen.add(k);
      out.push({ market_ticker: t, event_ticker: m.event_ticker, side, outcome: m.yes_sub_title, market_title: m.title || m.et, event_title: m.et, held, position_fp: ufp(units), label: tagLabel(side, m.yes_sub_title, m.title || m.et) });
    };
    for (const r of cur) { if (r.yes_count > 0) push(r.t, 'yes', 'current', r.yes_count); if (r.no_count > 0) push(r.t, 'no', 'current', r.no_count); }
    for (const r of past) push(r.t, r.side, 'past', 0);
    res.json({ positions: out.slice(0, 60) });
  });

  // ------------------------------------------------------------ badges (P2.3): computed from persisted data, persisted
  const badgeIds = (uid) => db.prepare('SELECT badge FROM social_badges WHERE user_id=? ORDER BY earned_at, badge').all(uid).map((r) => r.badge);
  function award(uid, badge, detail = '') {
    const r = db.prepare('INSERT INTO social_badges(user_id,badge,earned_at,detail) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(uid, badge, nowIso(), detail);
    const p = profileOf(uid);
    if (r.changes && p) n(uid, { type: 'social_badge', title: `You earned the “${BADGE_LABEL[badge]}” badge`, body: BADGES.find(([k]) => k === badge)[2], link: `/social/profile/${encodeURIComponent(p.nickname)}` });
  }
  function evaluate(uid) {
    if (!uid || isSystem(uid)) return;
    const fills = db.prepare('SELECT COUNT(*) c FROM fills WHERE user_id=?').get(uid).c;
    if (fills >= 1) award(uid, 'first_trade');
    if (fills >= 10) award(uid, 'ten_trades');
    const month = db.prepare('SELECT substr(created_at,1,7) m, SUM(payout_cents-cost_cents) p FROM settlements WHERE user_id=? GROUP BY m HAVING p>0 ORDER BY m LIMIT 1').get(uid);
    if (month) award(uid, 'profitable_month', month.m);
    if (db.prepare('SELECT 1 FROM mod_verified WHERE user_id=?').get(uid)) award(uid, 'verified');
    else db.prepare("DELETE FROM social_badges WHERE user_id=? AND badge='verified'").run(uid); // follows the moderator's decision
  }
  v1.get('/social/badges', (req, res) => {
    const p = byNick(req.query.nickname);
    if (!p) throw E.notFound();
    evaluate(p.user_id);
    const earned = new Map(db.prepare('SELECT * FROM social_badges WHERE user_id=?').all(p.user_id).map((r) => [r.badge, r]));
    res.json({ nickname: p.nickname, badges: BADGES.map(([id, label, description]) => ({ id, label, description, earned: earned.has(id), earned_time: earned.get(id)?.earned_at || null, detail: earned.get(id)?.detail || null })) });
  });

  // ------------------------------------------------------------ avatars: a choice from the moderated sticker set
  const avatarVo = (uid) => {
    const a = db.prepare('SELECT * FROM profile_avatars WHERE user_id=?').get(uid);
    if (!a || a.status === 'rejected') return null;
    const s = stickerVo(a.sticker_id);
    return s ? { sticker_id: s.id, url: s.url } : null;
  };
  v1.put('/users/:uid/social/profile/avatar', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    requireProfile(uid);
    limitWrite(res, 'avatar', uid);
    const b = req.body || {};
    if (b.sticker_id === null || b.sticker_id === '') { db.prepare('DELETE FROM profile_avatars WHERE user_id=?').run(uid); return res.json({ avatar: null }); }
    const prev = db.prepare('SELECT * FROM profile_avatars WHERE user_id=?').get(uid);
    const id = stickerParam(b.sticker_id);
    if (prev && prev.status === 'rejected' && prev.sticker_id === id) throw new ApiError(409, 'avatar_rejected', 'a moderator declined this picture for your profile; pick another one');
    db.prepare("INSERT INTO profile_avatars(user_id,sticker_id,status,updated_at) VALUES(?,?,'auto_approved',?) ON CONFLICT(user_id) DO UPDATE SET sticker_id=excluded.sticker_id, status='auto_approved', decided_by=NULL, decided_at=NULL, reason='', updated_at=excluded.updated_at").run(uid, id, nowIso());
    res.json({ avatar: avatarVo(uid) });
  });

  // ------------------------------------------------------------ edit window + history (P2.1)
  const ensureExtras = (pid) => db.prepare('INSERT INTO post_extras(post_id) VALUES(?) ON CONFLICT(post_id) DO NOTHING').run(pid);
  function applyEdit(req, p, body, { byMod = false, reason = '' } = {}) {
    const now = Date.now();
    tx(db, () => {
      ensureExtras(p.id);
      db.prepare('INSERT INTO post_edits(id,post_id,editor_id,by_moderator,prev_body,new_body,reason,edited_ts) VALUES(?,?,?,?,?,?,?,?)').run(newId('pe_'), p.id, req.auth.user.id, byMod ? 1 : 0, p.body, body, reason, now);
      db.prepare('UPDATE posts SET body=? WHERE id=?').run(body, p.id);
      db.prepare(`UPDATE post_extras SET edited_ts=?, edit_count=edit_count+1${byMod ? ', edited_by_mod=1' : ''} WHERE post_id=?`).run(now, p.id);
    });
  }
  v1.put('/users/:uid/social/posts/:pid', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    requireProfile(uid);
    const p = db.prepare('SELECT * FROM posts WHERE id=?').get(String(req.params.pid));
    if (!p || p.user_id !== uid) throw E.notFound(); // someone else's post is indistinguishable from a missing one
    if (isBanned(uid)) throw new ApiError(403, 'posting_banned', 'you are not allowed to post', 'your posting privileges were removed by a moderator');
    if (db.prepare("SELECT 1 FROM mod_hidden WHERE kind='post' AND content_id=?").get(p.id)) throw E.notFound();
    if (Date.now() - p.created_ts > opt.editWindowMs) throw new ApiError(409, 'edit_window_closed', `posts can be edited for ${Math.round(opt.editWindowMs / 60000)} minutes after posting`);
    limitWrite(res, 'edit', uid);
    const body = cleanText(req.body?.body, MAX_POST, { allowEmpty: !!extrasOf(p.id)?.sticker_id });
    if (body !== p.body) applyEdit(req, p, body);
    res.json({ post: feat().postVo(db.prepare('SELECT * FROM posts WHERE id=?').get(p.id), uid) });
  });
  const editsVo = (pid) => db.prepare('SELECT e.*, sp.nickname FROM post_edits e LEFT JOIN social_profiles sp ON sp.user_id=e.editor_id WHERE e.post_id=? ORDER BY e.edited_ts').all(pid)
    .map((e) => ({ id: e.id, edited_time: iso(e.edited_ts), by_moderator: !!e.by_moderator, editor: e.by_moderator ? 'moderator' : e.nickname || null, previous_body: e.prev_body, new_body: e.new_body, reason: e.reason }));
  v1.get('/admin/moderation/posts/:pid', can('social.moderate'), (req, res) => {
    const p = db.prepare('SELECT * FROM posts WHERE id=?').get(String(req.params.pid));
    if (!p) throw E.notFound();
    const x = extrasOf(p.id);
    res.json({ post: { id: p.id, body: p.body, author_nickname: profileOf(p.user_id)?.nickname || null, created_time: iso(p.created_ts), event_ticker: p.event_ticker, subtype: x?.subtype || 'standard', visibility: x?.visibility || 'public',
      position: x?.position_ticker ? positionVo(x) : null, sticker_id: x?.sticker_id || null, hidden: !!db.prepare("SELECT 1 FROM mod_hidden WHERE kind='post' AND content_id=?").get(p.id) }, edits: editsVo(p.id) });
  });

  // ------------------------------------------------------------ mutes (P2.1)
  v1.get('/users/:uid/social/mutes', requireUser, (req, res) => {
    const rows = db.prepare('SELECT m.created_at, sp.nickname FROM user_mutes m JOIN social_profiles sp ON sp.user_id=m.muted_id WHERE m.muter_id=? ORDER BY m.created_at DESC').all(req.auth.user.id);
    res.json({ mutes: rows.map((r) => ({ nickname: r.nickname, created_time: r.created_at })) });
  });
  v1.post('/users/:uid/social/mutes', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    limitWrite(res, 'mute', uid);
    const nick = req.body?.nickname;
    if (typeof nick !== 'string' || !NICK.test(nick)) throw E.badRequest('nickname is required');
    const t = byNick(nick);
    if (!t) throw E.notFound();
    if (t.user_id === uid) throw E.badRequest('you cannot mute yourself');
    if (db.prepare('SELECT COUNT(*) c FROM user_mutes WHERE muter_id=?').get(uid).c >= 500) throw E.conflict('too_many_mutes', 'at most 500 muted traders');
    db.prepare('INSERT INTO user_mutes(muter_id,muted_id,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(uid, t.user_id, nowIso());
    res.status(201).json({ muted: { nickname: t.nickname } });
  });
  v1.delete('/users/:uid/social/mutes', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    limitWrite(res, 'mute', uid);
    const t = byNick(req.query.nickname);
    if (!t) throw E.notFound();
    db.prepare('DELETE FROM user_mutes WHERE muter_id=? AND muted_id=?').run(uid, t.user_id);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ topic follows (P2.3)
  function topicParam(b) {
    const kind = b?.kind;
    if (!['event', 'market', 'keyword'].includes(kind)) throw E.badRequest('kind must be event, market or keyword');
    if (typeof b.value !== 'string') throw E.badRequest('value is required');
    if (kind === 'keyword') {
      const v = b.value.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
      if (!KEYWORD.test(v)) throw E.badRequest('keywords are 2-32 letters, digits, spaces or # $ & \' . + -');
      return { kind, value: v };
    }
    const v = b.value.trim().toUpperCase();
    if (!TICKER.test(v)) throw E.badRequest('value must be a ticker');
    const ok = kind === 'event' ? db.prepare("SELECT 1 FROM events WHERE ticker=? AND series_ticker<>'PLXCOMBO'").get(v) : db.prepare('SELECT 1 FROM markets WHERE ticker=? AND mve_collection_ticker IS NULL').get(v);
    if (!ok) throw E.notFound();
    return { kind, value: v };
  }
  function topicVo(r) {
    const vo = { kind: r.kind, value: r.value, created_time: r.created_at, label: r.value, link: null };
    if (r.kind === 'event') { const e = getEvent(r.value); vo.label = e ? e.title : r.value; vo.link = evLink(r.value); }
    if (r.kind === 'market') { const m = marketInfo(r.value); vo.label = m ? `${m.yes_sub_title} · ${m.title || m.et}` : r.value; vo.link = m ? `${evLink(r.value)}?market=${encodeURIComponent(r.value)}` : null; }
    if (r.kind === 'keyword') vo.label = `“${r.value}”`;
    return vo;
  }
  v1.get('/users/:uid/social/topics', requireUser, (req, res) => {
    res.json({ topics: db.prepare('SELECT * FROM topic_follows WHERE user_id=? ORDER BY created_at DESC').all(req.auth.user.id).map(topicVo) });
  });
  v1.post('/users/:uid/social/topics', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    limitWrite(res, 'topic', uid);
    const t = topicParam(req.body);
    const exists = db.prepare('SELECT 1 FROM topic_follows WHERE user_id=? AND kind=? AND value=?').get(uid, t.kind, t.value);
    if (!exists && db.prepare('SELECT COUNT(*) c FROM topic_follows WHERE user_id=?').get(uid).c >= 50) throw E.conflict('too_many_topics', 'you can follow at most 50 topics');
    db.prepare('INSERT INTO topic_follows(user_id,kind,value,created_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(uid, t.kind, t.value, nowIso());
    res.status(201).json({ topic: topicVo(db.prepare('SELECT * FROM topic_follows WHERE user_id=? AND kind=? AND value=?').get(uid, t.kind, t.value)) });
  });
  v1.delete('/users/:uid/social/topics', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    limitWrite(res, 'topic', uid);
    const t = topicParam({ kind: req.query.kind, value: String(req.query.value ?? '') });
    db.prepare('DELETE FROM topic_follows WHERE user_id=? AND kind=? AND value=?').run(uid, t.kind, t.value);
    res.json({ ok: true });
  });
  // Posts on topics the viewer follows: the post's event, a market of that event or its position tag, or a keyword.
  function topicsClause(viewer) {
    const rows = db.prepare('SELECT kind, value FROM topic_follows WHERE user_id=?').all(viewer);
    const ors = []; const args = [];
    const of = (k) => rows.filter((r) => r.kind === k).map((r) => r.value);
    const evs = of('event'); const mks = of('market'); const kws = of('keyword');
    const ph = (a) => a.map(() => '?').join(',');
    if (evs.length) { ors.push(`p.event_ticker IN (${ph(evs)})`); args.push(...evs); }
    if (mks.length) {
      ors.push(`p.event_ticker IN (SELECT event_ticker FROM markets WHERE ticker IN (${ph(mks)}))`); args.push(...mks);
      ors.push(`p.id IN (SELECT post_id FROM post_extras WHERE position_ticker IN (${ph(mks)}))`); args.push(...mks);
    }
    for (const k of kws) { ors.push('instr(lower(p.body), ?) > 0'); args.push(k); }
    return ors.length ? { sql: `(${ors.join(' OR ')})`, args } : { sql: '0', args: [] };
  }
  // Notify followers of a matching topic: not the author, not those who see it already as a follower, only viewers
  // allowed to see the post (circle-only), and never more than 500 per post.
  function notifyTopicFollowers(post, ext, me) {
    const body = post.body;
    const matches = new Map();
    const add = (uid, label) => { if (!matches.has(uid)) matches.set(uid, label); };
    if (post.event_ticker) {
      const e = getEvent(post.event_ticker);
      for (const r of db.prepare("SELECT user_id FROM topic_follows WHERE kind='event' AND value=?").all(post.event_ticker)) add(r.user_id, e ? e.title : post.event_ticker);
      for (const r of db.prepare("SELECT t.user_id, t.value FROM topic_follows t JOIN markets m ON m.ticker=t.value WHERE t.kind='market' AND m.event_ticker=?").all(post.event_ticker)) add(r.user_id, e ? e.title : r.value);
    }
    if (ext?.position) for (const r of db.prepare("SELECT user_id FROM topic_follows WHERE kind='market' AND value=?").all(ext.position.ticker)) add(r.user_id, `${ext.position.outcome} · ${ext.position.title}`);
    if (body) {
      const lower = body.toLowerCase();
      for (const r of db.prepare("SELECT user_id, value FROM topic_follows WHERE kind='keyword'").all()) if (lower.includes(r.value)) add(r.user_id, `“${r.value}”`);
    }
    let sent = 0;
    for (const [uid, label] of matches) {
      if (uid === post.user_id || sent >= 500 || !canView(post, uid)) continue;
      if (db.prepare('SELECT 1 FROM follows WHERE follower_id=? AND followee_id=?').get(uid, post.user_id)) continue;
      n(uid, { type: 'social_topic', title: `@${me.nickname} posted about ${label}`, body: (body || 'Sticker').slice(0, 120), link: `/social/post/${encodeURIComponent(post.id)}`, actor: post.user_id });
      sent += 1;
    }
  }

  // ------------------------------------------------------------ profile search (P2.3): nickname prefix only
  v1.get('/search/social_profiles', (req, res) => {
    limit(res, [[searchIp, req.ip || 'local'], ...(req.auth ? [[searchUser, req.auth.user.id]] : [])], 'too many searches, try again shortly');
    const raw = req.query.query ?? req.query.q ?? '';
    if (typeof raw !== 'string') throw E.badRequest('query must be a string');
    const q = raw.trim().replace(/^@/, '');
    let lim = 10;
    if (req.query.limit !== undefined) { lim = Number(req.query.limit); if (!/^\d+$/.test(String(req.query.limit)) || lim < 1 || lim > 20) throw E.badRequest('limit must be 1-20'); }
    res.setHeader('Cache-Control', 'no-store');
    if (!q) return res.json({ profiles: [] });
    if (!NICK.test(q)) throw E.badRequest('search by nickname: letters, digits and underscores only');
    const like = `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = db.prepare("SELECT sp.user_id, sp.nickname FROM social_profiles sp JOIN users u ON u.id=sp.user_id WHERE u.is_system=0 AND sp.nickname LIKE ? ESCAPE '\\' ORDER BY length(sp.nickname), sp.nickname LIMIT ?").all(like, lim);
    res.json({ profiles: rows.map((r) => ({ nickname: r.nickname, verified: !!db.prepare('SELECT 1 FROM mod_verified WHERE user_id=?').get(r.user_id),
      followers: db.prepare('SELECT COUNT(*) c FROM follows WHERE followee_id=?').get(r.user_id).c, badges: badgeIds(r.user_id), avatar: avatarVo(r.user_id) })) });
  });

  // ------------------------------------------------------------ timeline count (P2.3): new posts since a time
  v1.get('/social/timeline_count', (req, res) => {
    const viewer = req.auth?.user.id || null;
    const feed = String(req.query.feed || 'all');
    if (!['all', 'following', 'topics', 'circle'].includes(feed)) throw E.badRequest('feed must be all, following, topics or circle');
    if (feed !== 'all' && !viewer) throw E.unauthorized();
    const sraw = String(req.query.since ?? '');
    const since = /^\d{10,14}$/.test(sraw) ? Number(sraw) : Date.parse(sraw);
    if (!Number.isFinite(since)) throw E.badRequest('since must be an ISO time or epoch milliseconds');
    const where = ['p.created_ts > ?', "p.id NOT IN (SELECT content_id FROM mod_hidden WHERE kind='post')"]; const args = [since];
    const vis = visibilityClause(viewer); where.push(vis.sql); args.push(...vis.args);
    if (viewer) { where.push('p.user_id <> ?'); args.push(viewer); const m = mutedClause(viewer); where.push(m.sql); args.push(...m.args); }
    if (feed === 'following') { where.push('p.user_id IN (SELECT followee_id FROM follows WHERE follower_id=?)'); args.push(viewer); }
    if (feed === 'circle') { where.push('p.user_id IN (SELECT owner_id FROM circle_members WHERE member_id=?)'); args.push(viewer); }
    if (feed === 'topics') { const t = topicsClause(viewer); where.push(t.sql); args.push(...t.args); }
    if (req.query.event_ticker) { where.push('p.event_ticker=?'); args.push(String(req.query.event_ticker)); }
    const r = db.prepare(`SELECT COUNT(*) c, MAX(p.created_ts) last FROM posts p WHERE ${where.join(' AND ')}`).get(...args);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ feed, count: r.c, latest_time: iso(r.last) });
  });

  // ------------------------------------------------------------ stickers + GIF adapter routes (P2.2)
  v1.get('/social/stickers', (req, res) => {
    res.json({ stickers: db.prepare('SELECT * FROM social_stickers WHERE enabled=1 ORDER BY position, id').all().filter((s) => STICKER_SVG.has(s.id)).map((s) => ({ id: s.id, label: s.label, url: stickerUrl(s.id) })), gifs: gif.status() });
  });
  v1.get('/social/stickers/:file', (req, res) => {
    const m = /^([a-z0-9][a-z0-9-]{1,31})\.svg$/.exec(String(req.params.file));
    const s = m && stickerRow(m[1]);
    if (!s || !s.enabled || !STICKER_SVG.has(s.id)) throw E.notFound();
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'none'; script-src 'none'; frame-ancestors 'none'; sandbox");
    res.send(STICKER_SVG.get(s.id).svg);
  });
  v1.get('/social/gifs/search', (req, res, next) => {
    (async () => {
      if (!req.auth) throw E.unauthorized();
      if (!gif.enabled) throw new ApiError(403, 'feature_disabled', 'GIF search is not enabled on this exchange', 'gif_provider_disabled: use the Parlance sticker set');
      limit(res, [[searchUser, req.auth.user.id]]);
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      if (!q || q.length > 50) throw E.badRequest('q is required (at most 50 characters)');
      const items = await gif.search(q);
      res.json({ results: (items || []).map(({ id, rating, url }) => ({ id, rating, url })) });
    })().catch(next);
  });
  v1.get('/admin/stickers', can('social.moderate'), (req, res) => {
    res.json({ stickers: db.prepare('SELECT * FROM social_stickers ORDER BY position, id').all().map((s) => ({ id: s.id, label: s.label, enabled: !!s.enabled, url: stickerUrl(s.id), updated_at: s.updated_at,
      uses: db.prepare('SELECT (SELECT COUNT(*) FROM post_extras WHERE sticker_id=?)+(SELECT COUNT(*) FROM comment_extras WHERE sticker_id=?) c').get(s.id, s.id).c })), gifs: gif.status() });
  });
  v1.put('/admin/stickers/:id', can('social.moderate'), (req, res) => {
    const s = stickerRow(req.params.id);
    if (!s) throw E.notFound();
    const en = req.body?.enabled;
    if (typeof en !== 'boolean') throw E.badRequest('enabled must be true or false');
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
    db.prepare('UPDATE social_stickers SET enabled=?, updated_at=?, updated_by=? WHERE id=?').run(en ? 1 : 0, nowIso(), req.auth.user.id, s.id);
    audit(db, req, en ? 'social.sticker.enable' : 'social.sticker.disable', 'sticker', s.id, { enabled: !!s.enabled }, { enabled: en }, reason);
    res.json({ sticker: { id: s.id, label: s.label, enabled: en, url: stickerUrl(s.id) } });
  });

  // ------------------------------------------------------------ social-admin PUT endpoints (G8)
  // Observed call sites (evidence/api_callsites_home.txt lines 236-239); request bodies are UNKNOWN → Parlance design.
  const SA = '/users/:uid/social/social-admin';
  const selfOnly = (req) => { if (req.params.uid !== req.auth.user.id) throw E.forbidden('cannot access another user'); };
  const modPost = (pid) => { const p = db.prepare('SELECT * FROM posts WHERE id=?').get(String(pid)); if (!p) throw E.notFound(); return p; };
  v1.put(`${SA}/determine_profile_image/:id`, can('social.moderate'), (req, res) => {
    selfOnly(req);
    const target = db.prepare('SELECT user_id, nickname FROM social_profiles WHERE user_id=? OR nickname=?').get(String(req.params.id), String(req.params.id));
    const a = target && db.prepare('SELECT * FROM profile_avatars WHERE user_id=?').get(target.user_id);
    if (!a) throw E.notFound();
    const d = req.body?.decision;
    if (!['approve', 'reject'].includes(d)) throw E.badRequest('decision must be approve or reject');
    const reason = d === 'reject' ? cleanReason(req.body?.reason, 3, 500) : (typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '');
    const status = d === 'approve' ? 'approved' : 'rejected';
    db.prepare('UPDATE profile_avatars SET status=?, decided_by=?, decided_at=?, reason=? WHERE user_id=?').run(status, req.auth.user.id, nowIso(), reason, target.user_id);
    audit(db, req, 'social.profile_image', 'user', target.user_id, { sticker_id: a.sticker_id, status: a.status }, { sticker_id: a.sticker_id, status }, reason);
    if (status === 'rejected') n(target.user_id, { type: 'account', title: 'A moderator removed your profile picture', body: reason, link: `/social/profile/${encodeURIComponent(target.nickname)}` });
    res.json({ profile_image: { nickname: target.nickname, sticker_id: a.sticker_id, status } });
  });
  v1.put(`${SA}/posts/:pid/market_status`, can('social.moderate'), (req, res) => {
    selfOnly(req);
    const p = modPost(req.params.pid);
    const b = req.body || {};
    const reason = cleanReason(b.reason, 3, 500);
    if (b.event_ticker === undefined && b.position_tag === undefined) throw E.badRequest('send event_ticker (string or null) and/or position_tag ("keep" or "remove")');
    let et = p.event_ticker;
    if (b.event_ticker !== undefined) {
      if (b.event_ticker === null) et = null;
      else { const v = String(b.event_ticker).toUpperCase(); if (!TICKER.test(v) || !getEvent(v)) throw E.badRequest('event_ticker must be an existing event or null'); et = v; }
    }
    if (b.position_tag !== undefined && !['keep', 'remove'].includes(b.position_tag)) throw E.badRequest('position_tag must be keep or remove');
    const before = { event_ticker: p.event_ticker, position: extrasOf(p.id)?.position_ticker || null };
    tx(db, () => {
      db.prepare('UPDATE posts SET event_ticker=? WHERE id=?').run(et, p.id);
      if (b.position_tag === 'remove') { ensureExtras(p.id); db.prepare('UPDATE post_extras SET position_ticker=NULL, position_side=NULL, position_units=NULL, position_outcome=NULL, position_title=NULL, position_event_ticker=NULL, position_held=NULL WHERE post_id=?').run(p.id); }
    });
    audit(db, req, 'social.post_market_status', 'post', p.id, before, { event_ticker: et, position: extrasOf(p.id)?.position_ticker || null }, reason);
    res.json({ post: feat().postVo(modPost(p.id), req.auth.user.id) });
  });
  v1.put(`${SA}/posts/:pid/post_subtype`, can('social.moderate'), (req, res) => {
    selfOnly(req);
    const p = modPost(req.params.pid);
    const st = req.body?.post_subtype;
    if (!SUBTYPES.includes(st)) throw E.badRequest(`post_subtype must be one of ${SUBTYPES.join(', ')}`);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
    const before = extrasOf(p.id)?.subtype || 'standard';
    tx(db, () => { ensureExtras(p.id); db.prepare('UPDATE post_extras SET subtype=? WHERE post_id=?').run(st, p.id); });
    audit(db, req, 'social.post_subtype', 'post', p.id, { post_subtype: before }, { post_subtype: st }, reason);
    res.json({ post: feat().postVo(modPost(p.id), req.auth.user.id) });
  });
  v1.put(`${SA}/posts/:pid/update`, can('social.moderate'), (req, res) => {
    selfOnly(req);
    const p = modPost(req.params.pid);
    const reason = cleanReason(req.body?.reason, 3, 500);
    const body = cleanText(req.body?.body, MAX_POST, { allowEmpty: !!extrasOf(p.id)?.sticker_id });
    applyEdit(req, p, body, { byMod: true, reason });
    audit(db, req, 'social.post_update', 'post', p.id, { body: p.body }, { body }, reason);
    if (p.user_id !== req.auth.user.id) n(p.user_id, { type: 'account', title: 'A moderator edited your post', body: reason, link: `/social/post/${encodeURIComponent(p.id)}` });
    res.json({ post: feat().postVo(modPost(p.id), req.auth.user.id) });
  });

  // ------------------------------------------------------------ promo targeting (G8): event + category placements
  // Home (bff/home, server/admin.js) shows untargeted promos; targeted promos appear on the event pages of their series
  // and on their category pages. hide_logged_out hides a promo from signed-out visitors (spec §13.11 fields).
  v1.get('/promos', (req, res) => {
    const series = typeof req.query.series_ticker === 'string' ? req.query.series_ticker.toUpperCase().slice(0, 64) : '';
    const cat = typeof req.query.category === 'string' ? req.query.category.slice(0, 64) : '';
    if (!series && !cat) throw E.badRequest('series_ticker or category is required');
    const cols = new Set(db.prepare('PRAGMA table_info(cms_promos)').all().map((c) => c.name));
    if (!cols.has('series_tickers')) return res.json({ promos: [] });
    const now = Date.now();
    const rows = db.prepare('SELECT * FROM cms_promos WHERE active=1 ORDER BY position, created_at').all()
      .filter((r) => (!r.starts_at || Date.parse(r.starts_at) <= now) && (!r.ends_at || Date.parse(r.ends_at) > now))
      .filter((r) => !(r.hide_logged_out && !req.auth))
      .filter((r) => {
        let st = []; let cs = [];
        try { st = JSON.parse(r.series_tickers || '[]'); cs = JSON.parse(r.categories || '[]'); } catch { /* malformed row: not targeted */ }
        return (series && st.includes(series)) || (cat && cs.some((c) => String(c).toLowerCase() === cat.toLowerCase()));
      });
    res.json({ promos: rows.map((p) => ({ id: p.id, overline: p.overline, title: p.title, subtitle: p.subtitle, link: p.link, color: p.color })) });
  });

  // ------------------------------------------------------------ features.js hooks
  function decoratePost(vo, p, viewer) {
    const x = extrasOf(p.id);
    vo.sticker = x?.sticker_id ? stickerVo(x.sticker_id) : null;
    vo.position = x?.position_ticker ? positionVo(x) : null;
    vo.visibility = x?.visibility || 'public';
    vo.edited = !!x?.edited_ts;
    vo.edited_time = iso(x?.edited_ts);
    vo.edited_by_moderator = !!x?.edited_by_mod;
    vo.subtype = x?.subtype || 'standard';
    vo.share_path = `/social/post/${encodeURIComponent(p.id)}`;
    vo.editable_until = viewer && viewer === p.user_id && Date.now() - p.created_ts < opt.editWindowMs ? iso(p.created_ts + opt.editWindowMs) : null;
    vo.author.badges = badgeIds(p.user_id);
    vo.author.avatar = avatarVo(p.user_id);
    vo.author_muted = isMuted(viewer, p.user_id);
  }
  function decorateComment(vo, c) {
    const x = db.prepare('SELECT sticker_id FROM comment_extras WHERE comment_id=?').get(c.id);
    vo.sticker = x?.sticker_id ? stickerVo(x.sticker_id) : null;
    vo.author.badges = badgeIds(c.user_id);
    vo.author.avatar = avatarVo(c.user_id);
  }
  function decorateProfile(vo, p, viewer) {
    vo.badges = badgeIds(p.user_id);
    vo.avatar = avatarVo(p.user_id);
    vo.is_muted = isMuted(viewer, p.user_id);
    vo.circle = viewer && viewer !== p.user_id ? circle.relation(viewer, p.user_id) : null;
    vo.mutual = !!viewer && viewer !== p.user_id && !!db.prepare('SELECT 1 FROM follows a JOIN follows b ON b.follower_id=a.followee_id AND b.followee_id=a.follower_id WHERE a.follower_id=? AND a.followee_id=?').get(viewer, p.user_id);
    vo.trade_alerts = !!viewer && !!db.prepare('SELECT 1 FROM social_account_subs WHERE user_id=? AND target_id=?').get(viewer, p.user_id);
    if (viewer === p.user_id) { const a = db.prepare('SELECT * FROM profile_avatars WHERE user_id=?').get(p.user_id); vo.avatar_status = a ? { sticker_id: a.sticker_id, status: a.status, reason: a.reason } : null; }
  }
  function feedFilter({ feed, viewer, where, args, req }) {
    const vis = visibilityClause(viewer); where.push(vis.sql); args.push(...vis.args);
    if (viewer && !req.query.nickname) { const m = mutedClause(viewer); where.push(m.sql); args.push(...m.args); }
    if (feed === 'topics') { const t = topicsClause(viewer); where.push(t.sql); args.push(...t.args); }
    if (feed === 'circle') { where.push('p.user_id IN (SELECT owner_id FROM circle_members WHERE member_id=?)'); args.push(viewer); }
  }
  function beforePost(req) {
    const b = req.body || {};
    const sticker = stickerParam(b.sticker_id);
    const position = positionParam(req.auth.user.id, b.position);
    const visibility = b.visibility == null ? 'public' : b.visibility;
    if (!['public', 'circle'].includes(visibility)) throw E.badRequest('visibility must be public or circle');
    const body = cleanText(b.body, MAX_POST, { allowEmpty: !!sticker });
    return { sticker, position, visibility, body };
  }
  function afterPost(post, ext) {
    if (ext && (ext.sticker || ext.position || ext.visibility !== 'public')) {
      const ps = ext.position;
      db.prepare('INSERT INTO post_extras(post_id,sticker_id,visibility,position_ticker,position_side,position_units,position_outcome,position_title,position_event_ticker,position_held) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(post.id, ext.sticker, ext.visibility, ps?.ticker ?? null, ps?.side ?? null, ps?.units ?? null, ps?.outcome ?? null, ps?.title ?? null, ps?.event_ticker ?? null, ps?.held ?? null);
    }
  }
  function afterPostNotify(post, ext, me) { try { notifyTopicFollowers(post, ext, me); } catch (e) { console.error('topic notify', e); } }
  function beforeComment(req) {
    const sticker = stickerParam(req.body?.sticker_id);
    return { sticker, body: cleanText(req.body?.body, MAX_COMMENT, { allowEmpty: !!sticker }) };
  }
  function afterComment(commentId, ext) { if (ext?.sticker) db.prepare('INSERT INTO comment_extras(comment_id,sticker_id) VALUES(?,?)').run(commentId, ext.sticker); }
  const commentFilter = (c, viewer) => !isMuted(viewer, c.user_id);

  function attachFeatures(f) {
    const h = f.hooks;
    h.postVo.push(decoratePost);
    h.commentVo.push(decorateComment);
    h.profileVo.push(decorateProfile);
    h.feeds.push('topics', 'circle');
    h.feedFilter = feedFilter;
    h.beforePost = beforePost;
    h.afterPost = afterPost;
    h.afterPostNotify = afterPostNotify;
    h.beforeComment = beforeComment;
    h.afterComment = afterComment;
    h.commentFilter = commentFilter;
    h.canView = canView;
  }

  // ------------------------------------------------------------ position + trade alerts (A11)
  // Fills are batched per synchronous engine run: per (trader, order) a trade alert to followers who turned on trade
  // alerts for that trader; per (trader, market) a position alert when the position opened, closed or flipped, to the
  // trader's followers and Inner Circle. Only traders who share their trades (social_profiles.share_trades) are announced.
  let pending = null;
  engine.on('fill', (uid, f) => {
    if (!pending) { pending = []; setImmediate(processFills); }
    pending.push([uid, f]);
  });
  const sideNow = (uid, ticker) => { const p = db.prepare('SELECT yes_count, no_count FROM positions WHERE user_id=? AND market_ticker=?').get(uid, ticker); return p ? (p.yes_count > 0 ? 'yes' : p.no_count > 0 ? 'no' : 'none') : 'none'; };
  const audienceOf = (uid) => [...new Set([...db.prepare('SELECT follower_id u FROM follows WHERE followee_id=?').all(uid).map((r) => r.u), ...circle.membersOf(uid)])].filter((x) => x !== uid);
  function processFills() {
    const batch = pending || []; pending = null;
    try {
      const orders = new Map(); const markets = new Map();
      for (const [uid, f] of batch) {
        dirty.add(uid);
        const k = `${uid}|${f.order_id}`;
        const o = orders.get(k) || { uid, order_id: f.order_id, ticker: f.market_ticker, side: f.side, units: 0, value: 0 };
        o.units += f.count; o.value += f.count * f.price_cents; orders.set(k, o);
        markets.set(`${uid}|${f.market_ticker}`, { uid, ticker: f.market_ticker });
      }
      for (const o of orders.values()) {
        const p = profileOf(o.uid);
        if (!p || !p.share_trades || isSystem(o.uid)) continue;
        const subs = db.prepare('SELECT user_id FROM social_account_subs WHERE target_id=? AND trades=1').all(o.uid).map((r) => r.user_id);
        if (!subs.length) continue;
        const ord = db.prepare('SELECT action FROM orders WHERE id=?').get(o.order_id);
        const sell = ord?.action === 'sell';
        const shown = sell ? (o.side === 'yes' ? 'no' : 'yes') : o.side;
        const px = Math.round(o.value / o.units);
        const m = marketInfo(o.ticker);
        for (const s of subs) n(s, { type: 'trade_alert', title: `@${p.nickname} ${sell ? 'sold' : 'bought'} ${(o.units / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${shown.toUpperCase()} · ${m ? m.yes_sub_title : o.ticker} @ ${sell ? 100 - px : px}¢`, body: m ? (m.title || m.et) : o.ticker, link: evLink(o.ticker), actor: o.uid });
      }
      for (const { uid, ticker } of markets.values()) {
        const now = sideNow(uid, ticker);
        const prev = db.prepare('SELECT side FROM social_position_state WHERE user_id=? AND market_ticker=?').get(uid, ticker)?.side || 'none';
        if (now === prev) continue;
        db.prepare('INSERT INTO social_position_state(user_id,market_ticker,side,updated_ts) VALUES(?,?,?,?) ON CONFLICT(user_id,market_ticker) DO UPDATE SET side=excluded.side, updated_ts=excluded.updated_ts').run(uid, ticker, now, Date.now());
        const p = profileOf(uid);
        if (!p || !p.share_trades || isSystem(uid)) continue;
        const m = marketInfo(ticker);
        const what = m ? `${m.yes_sub_title} · ${m.title || m.et}` : ticker;
        const title = now === 'none' ? `@${p.nickname} closed a ${prev.toUpperCase()} position` : prev === 'none' ? `@${p.nickname} opened a ${now.toUpperCase()} position` : `@${p.nickname} flipped to ${now.toUpperCase()}`;
        for (const to of audienceOf(uid)) n(to, { type: 'position_alert', title, body: what, link: evLink(ticker), actor: uid });
      }
    } catch (e) { if (!/database is not open/i.test(String(e && e.message))) console.error('position alerts', e); }
  }
  // Settlement closes positions silently (no alert): keep the announced state in step.
  engine.on('settlement', (uid, s) => { dirty.add(uid); try { db.prepare("UPDATE social_position_state SET side='none', updated_ts=? WHERE user_id=? AND market_ticker=?").run(Date.now(), uid, s.market_ticker); } catch { /* closed */ } });

  // ------------------------------------------------------------ leaderboard push + badge sweeps
  // Rank by realized profit (the public leaderboard). The first sweep sets the baseline; afterwards a trader who
  // enters the top 10 or climbs within it gets a `leaderboard` notification (Push only in the matrix).
  function sweepLeaders() {
    const top = db.prepare('SELECT sp.user_id, COALESCE((SELECT SUM(realized_pnl_cents) FROM positions WHERE user_id=sp.user_id),0) v FROM social_profiles sp JOIN users u ON u.id=sp.user_id WHERE u.is_system=0 ORDER BY v DESC, sp.nickname LIMIT 10').all();
    // The very first sweep on a database records ranks silently (no burst of alerts for an existing leaderboard).
    const baseline = !db.prepare("SELECT 1 FROM meta WHERE key='leaderboard_push_baseline'").get();
    if (baseline) db.prepare("INSERT INTO meta(key,value) VALUES('leaderboard_push_baseline',?) ON CONFLICT(key) DO NOTHING").run(nowIso());
    const inTop = new Set();
    top.forEach((r, i) => {
      if (r.v <= 0) return;
      const rank = i + 1;
      inTop.add(r.user_id);
      award(r.user_id, 'top_10');
      const prev = db.prepare("SELECT rank FROM leaderboard_ranks WHERE user_id=? AND metric='pnl'").get(r.user_id);
      db.prepare("INSERT INTO leaderboard_ranks(user_id,metric,rank,updated_ts) VALUES(?,'pnl',?,?) ON CONFLICT(user_id,metric) DO UPDATE SET rank=excluded.rank, updated_ts=excluded.updated_ts").run(r.user_id, rank, Date.now());
      if (!baseline && (!prev || rank < prev.rank)) n(r.user_id, { type: 'leaderboard', title: `You're #${rank} on the Parlance profit leaderboard`, body: prev ? `Up from #${prev.rank}` : 'You entered the top 10', link: '/social/leaderboard' });
    });
    for (const r of db.prepare("SELECT user_id FROM leaderboard_ranks WHERE metric='pnl'").all()) if (!inTop.has(r.user_id)) db.prepare("DELETE FROM leaderboard_ranks WHERE user_id=? AND metric='pnl'").run(r.user_id);
    for (const r of db.prepare("SELECT v.user_id FROM mod_verified v WHERE NOT EXISTS (SELECT 1 FROM social_badges b WHERE b.user_id=v.user_id AND b.badge='verified')").all()) award(r.user_id, 'verified');
    db.prepare("DELETE FROM social_badges WHERE badge='verified' AND user_id NOT IN (SELECT user_id FROM mod_verified)").run();
  }
  const dirty = new Set();
  let lastLeaders = 0; let lastPrune = Date.now();
  engine.on('tick', () => {
    try {
      for (const uid of [...dirty].slice(0, 200)) { dirty.delete(uid); evaluate(uid); }
      const now = Date.now();
      if (now - lastLeaders > 3000) { lastLeaders = now; sweepLeaders(); }
      if (now - lastPrune > 60000) { lastPrune = now; for (const b of writeBuckets.values()) b.prune(); searchIp.prune(); searchUser.prune(); }
    } catch (e) { if (!/database is not open/i.test(String(e && e.message))) console.error('social tick', e); }
  });

  return { attachFeatures, isMuted, stickerParam, stickerVo, avatarVo, badgeIds, evaluate, sweepLeaders, canView, profileOf, byNick };
}

module.exports = { mountSocial2, EDIT_WINDOW_MS, BADGES, SUBTYPES };
