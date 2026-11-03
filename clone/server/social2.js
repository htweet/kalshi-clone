'use strict';
// Social and community completion (PLAN Phase 2: P2.1–P2.4, gap G8; PHASE2_SPEC.md §24).
//
//   P2.1  post extras: position tag verified against the author's own fills/positions at post time, sticker, edit window
//         with persisted edit history (visible to moderators), share path, per-user mutes (posts, replies, chat, and
//         notifications from muted users are hidden for the muter).
//   P2.2  self-hosted, moderated sticker set (server/stickers.js) stored as ids; admin enable/disable; optional external
//         GIF provider adapter (server/gif-provider.js), disabled without a key.
//   P2.3  topic follows (events, markets, keywords) with a feed and notifications, nickname-prefix profile search
//         (rate-limited, never by email), timeline counts, earned badges (computed and persisted).
//   P2.4  notification preferences per type × channel (in-app, email stub) with quiet hours; price-movement
//         subscriptions honoured by the notifier.
//   G8    the four PUT social-admin moderation endpoints (request bodies are a documented design choice) and promo-card
//         targeting (series, categories, logged-out visibility).
//
// Wiring (server/app.js): mounted after the admin module and before mountFeatures, so the middleware and response
// decorators registered here run ahead of the feature routes; attachFeatures(feat) then plugs the hooks that
// server/features.js exposes (post/comment/profile serializers, feed filter, post/comment creation, notify gate).
// Every table below is created with CREATE TABLE IF NOT EXISTS; foreign keys point to users/posts/comments with
// ON DELETE CASCADE so `npm run seed` (a reset) keeps working. No existing table's schema changes (the promo targeting
// columns are added by server/admin.js, which owns cms_promos).
const { tx } = require('./db');
const { nowIso, newId, ufp, ApiError, E } = require('./util');
const { ROLE_PERMS } = require('./admin');
const auditChain = require('./audit-chain');
const { STICKERS, BY_ID: STICKER_SVG, STICKER_ID } = require('./stickers');
const { createGifProvider } = require('./gif-provider');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS social_stickers (id TEXT PRIMARY KEY, label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, updated_by TEXT);
CREATE TABLE IF NOT EXISTS post_extras (post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE, sticker_id TEXT,
  position_ticker TEXT, position_side TEXT, position_units INTEGER, position_outcome TEXT, position_title TEXT, position_event_ticker TEXT, position_held TEXT,
  edited_ts INTEGER, edit_count INTEGER NOT NULL DEFAULT 0, edited_by_mod INTEGER NOT NULL DEFAULT 0, subtype TEXT NOT NULL DEFAULT 'standard');
CREATE INDEX IF NOT EXISTS idx_post_extras_position ON post_extras(position_ticker);
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
CREATE TABLE IF NOT EXISTS notif_prefs (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, types TEXT NOT NULL DEFAULT '{}', quiet TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notif_email_outbox (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, created_ts INTEGER NOT NULL, send_after_ts INTEGER NOT NULL, sent_ts INTEGER);
CREATE INDEX IF NOT EXISTS idx_notif_email_status ON notif_email_outbox(status, send_after_ts);
CREATE TABLE IF NOT EXISTS price_move_subs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, market_ticker TEXT NOT NULL, threshold_cents INTEGER NOT NULL,
  window_minutes INTEGER NOT NULL, direction TEXT NOT NULL DEFAULT 'any', created_at TEXT NOT NULL, last_notified_ts INTEGER, last_notified_price INTEGER, last_move_cents INTEGER);
CREATE INDEX IF NOT EXISTS idx_price_move_market ON price_move_subs(market_ticker);
`;

const EDIT_WINDOW_MS = 10 * 60 * 1000; // P2.1: authors may edit for 10 minutes
const MAX_POST = 500;
const MAX_COMMENT = 300;
const MAX_MUTES = 500;
const MAX_TOPICS = 50;
const MAX_MOVE_SUBS = 50;
const SUBTYPES = ['standard', 'analysis', 'news', 'humor', 'promotional'];
const BADGES = [
  ['first_trade', 'First trade', 'Made a first trade'],
  ['ten_trades', '10 trades', 'Completed 10 trades'],
  ['profitable_month', 'Profitable month', 'Settled positions made a profit within one calendar month (UTC)'],
  ['top_10', 'Top 10 trader', 'Reached the top 10 of the profit leaderboard'],
  ['verified', 'Verified', 'Profile verified by Parlance'],
];
const BADGE_LABEL = Object.fromEntries(BADGES.map(([k, l]) => [k, l]));
// Notification types × channels. `locked` types cannot be turned off (security / account notices).
const NTYPES = [
  ['fill', 'Order fills', { in_app: true, email: true }],
  ['settlement', 'Settlements', { in_app: true, email: true }],
  ['price_target', 'Price alerts', { in_app: true, email: true }],
  ['price_movement', 'Price movements', { in_app: true, email: false }],
  ['order_expired', 'Expired orders', { in_app: true, email: false }],
  ['rfq', 'RFQs and quotes', { in_app: true, email: false }],
  ['social_post', 'Posts from traders you follow', { in_app: true, email: false }],
  ['social_topic', 'Posts on topics you follow', { in_app: true, email: false }],
  ['social_like', 'Likes on your posts', { in_app: true, email: false }],
  ['social_comment', 'Replies to your posts', { in_app: true, email: false }],
  ['social_follow', 'New followers', { in_app: true, email: false }],
  ['social_badge', 'Badges you earn', { in_app: true, email: false }],
  ['account', 'Account and security', { in_app: true, email: true }, true],
];
const NTYPE = new Map(NTYPES.map(([k, l, d, locked]) => [k, { label: l, def: d, locked: !!locked }]));
const prefKey = (type) => (String(type).startsWith('rfq_') ? 'rfq' : NTYPE.has(type) ? type : null);
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
// C0 controls except tab / line feed / carriage return; bidi overrides, isolates and direction marks (text spoofing).
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const BIDI = new RegExp(`[${String.fromCodePoint(0x061c, 0x200e, 0x200f)}${String.fromCodePoint(0x202a)}-${String.fromCodePoint(0x202e)}${String.fromCodePoint(0x2066)}-${String.fromCodePoint(0x2069)}]`);
const KEYWORD = /^[\p{L}\p{N}][\p{L}\p{N} #$&'.+-]{1,31}$/u;
const TICKER = /^[A-Z0-9][A-Z0-9._-]{0,63}$/;
const NICK = /^[A-Za-z0-9_]{1,20}$/;
// Shared placeholder for obscured RFQ creators (getting_started_rfqs.md: the empty-input SHA-256).
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

// Token bucket keyed by user id or IP; take() → 0 when allowed, else seconds until the next token.
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
class LimitError extends ApiError {
  constructor(sec) { super(429, 'too_many_requests', 'too many requests', `slow down, try again in ${sec}s`); this.sec = sec; }
  toJSON() { const j = super.toJSON(); j.error.retry_after_sec = this.sec; return j; }
}

// Post / reply text (multi-line allowed): string, well-formed, NFC, trimmed, no control or bidi-override characters.
function cleanText(raw, max, { allowEmpty = false } = {}) {
  if (raw == null || raw === '') { if (allowEmpty) return ''; throw E.badRequest('body is required'); }
  if (typeof raw !== 'string') throw E.badRequest('body must be a string');
  if (raw.length > max * 4) throw E.badRequest(`body must be at most ${max} characters`);
  if (typeof raw.isWellFormed === 'function' && !raw.isWellFormed()) throw E.badRequest('body contains invalid characters');
  const s = raw.normalize('NFC').trim();
  if (!s) { if (allowEmpty) return ''; throw E.badRequest('body is required'); }
  if (CONTROL.test(s)) throw E.badRequest('body cannot contain control characters');
  if (BIDI.test(s)) throw E.badRequest('body cannot contain text-direction override characters');
  if (s.length > max) throw E.badRequest(`body must be at most ${max} characters`);
  return s;
}

function mountSocial2({ v1, db, engine, requireUser, can, rolesOf, notify, getEvent, options = {} }) {
  db.exec(SCHEMA);
  const opt = { editWindowMs: EDIT_WINDOW_MS, ...options };
  const env = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? n : d; };
  const limits = {
    write: [env('SOCIAL_WRITE_BURST', 20), env('SOCIAL_WRITE_PER_SEC', 1)],
    search: [env('SOCIAL_SEARCH_BURST', 20), env('SOCIAL_SEARCH_PER_SEC', 2)],
  };
  const writeBuckets = new Map(); // one bucket per write group, keyed by user
  const searchIp = bucket(...limits.search);
  const searchUser = bucket(...limits.search);
  const limitWrite = (group, uid) => {
    if (!writeBuckets.has(group)) writeBuckets.set(group, bucket(...limits.write));
    const w = writeBuckets.get(group).take(uid);
    if (w) throw new LimitError(w);
  };
  const gif = createGifProvider();
  let feat = null; // server/features.js API, attached after it is mounted

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
  const isSystem = (uid) => !!db.prepare('SELECT is_system FROM users WHERE id=?').get(uid)?.is_system;
  const isMod = (u) => !!u && rolesOf(u).some((r) => (ROLE_PERMS[r] || []).includes('social.moderate'));
  const isBanned = (uid) => !!db.prepare('SELECT 1 FROM mod_bans WHERE user_id=?').get(uid);
  const isMuted = (muter, muted) => !!muter && !!muted && muter !== muted && !!db.prepare('SELECT 1 FROM user_mutes WHERE muter_id=? AND muted_id=?').get(muter, muted);
  const requireProfile = (uid) => { const p = profileOf(uid); if (!p) throw E.conflict('social_profile_required', 'create a social profile (nickname) first'); return p; };
  const eventLink = (marketTicker) => {
    const r = db.prepare('SELECT e.ticker et, s.ticker st, s.slug FROM markets m JOIN events e ON e.ticker=m.event_ticker JOIN series s ON s.ticker=e.series_ticker WHERE m.ticker=?').get(marketTicker);
    return r ? `/markets/${r.st.toLowerCase()}/${r.slug}/${r.et.toLowerCase()}` : '/';
  };
  const evLink = (eventTicker) => {
    const r = db.prepare('SELECT e.ticker et, s.ticker st, s.slug FROM events e JOIN series s ON s.ticker=e.series_ticker WHERE e.ticker=?').get(eventTicker);
    return r ? `/markets/${r.st.toLowerCase()}/${r.slug}/${r.et.toLowerCase()}` : '/';
  };
  const audit = (req, action, targetType, targetId, before, after, reason = '') => auditChain.append(db, { actor_id: req.auth.user.id, actor_email: req.auth.user.email, action, target_type: targetType, target_id: targetId, before, after, reason });
  const reasonOf = (b, min = 3) => { const r = typeof b?.reason === 'string' ? b.reason.trim() : ''; if (r.length < min || r.length > 500 || CONTROL.test(r)) throw E.badRequest(`a reason of ${min}-500 characters is required`); return r; };
  const n = (uid, o) => notify(uid, o); // features.notify (lazy, see app.js)

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
    label: `${x.position_side === 'yes' ? 'Yes' : 'No'} · ${x.position_outcome} · ${x.position_title}`, held: x.position_held, position_fp: ufp(x.position_units || 0),
    link: `${eventLink(x.position_ticker)}?market=${encodeURIComponent(x.position_ticker)}&side=${x.position_side}`,
  });
  // Taggable positions for the composer's "+ Add a position" picker.
  v1.get('/users/:uid/social/position_tags', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    const cur = db.prepare(`SELECT p.market_ticker t, p.yes_count, p.no_count FROM positions p JOIN markets m ON m.ticker=p.market_ticker WHERE p.user_id=? AND (p.yes_count>0 OR p.no_count>0) ORDER BY p.updated_at DESC LIMIT 50`).all(uid);
    const past = db.prepare(`SELECT DISTINCT f.market_ticker t, f.side FROM fills f JOIN orders o ON o.id=f.order_id WHERE f.user_id=? AND COALESCE(o.action,'buy')='buy' ORDER BY f.created_ts DESC LIMIT 100`).all(uid);
    const seen = new Set(); const out = [];
    const push = (t, side, held, units) => {
      const k = `${t}:${side}`;
      if (seen.has(k)) return;
      const m = marketInfo(t);
      if (!m) return;
      seen.add(k);
      out.push({ market_ticker: t, event_ticker: m.event_ticker, side, outcome: m.yes_sub_title, market_title: m.title || m.et, event_title: m.et, held, position_fp: ufp(units), label: `${side === 'yes' ? 'Yes' : 'No'} · ${m.yes_sub_title} · ${m.title || m.et}` });
    };
    for (const r of cur) { if (r.yes_count > 0) push(r.t, 'yes', 'current', r.yes_count); if (r.no_count > 0) push(r.t, 'no', 'current', r.no_count); }
    for (const r of past) push(r.t, r.side, 'past', 0);
    res.json({ positions: out.slice(0, 60) });
  });

  // ------------------------------------------------------------ badges (P2.3): computed from persisted data, persisted
  const badgeIds = (uid) => db.prepare('SELECT badge FROM social_badges WHERE user_id=? ORDER BY earned_at, badge').all(uid).map((r) => r.badge);
  function award(uid, badge, detail = '') {
    const r = db.prepare('INSERT INTO social_badges(user_id,badge,earned_at,detail) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(uid, badge, nowIso(), detail);
    if (r.changes && profileOf(uid)) n(uid, { type: 'social_badge', title: `You earned the “${BADGE_LABEL[badge]}” badge`, body: BADGES.find(([k]) => k === badge)[2], link: `/social/profile/${encodeURIComponent(profileOf(uid).nickname)}` });
  }
  function evaluate(uid) {
    if (!uid || isSystem(uid)) return;
    const fills = db.prepare('SELECT COUNT(*) c FROM fills WHERE user_id=?').get(uid).c;
    if (fills >= 1) award(uid, 'first_trade');
    if (fills >= 10) award(uid, 'ten_trades');
    const month = db.prepare('SELECT substr(created_at,1,7) m, SUM(payout_cents-cost_cents) p FROM settlements WHERE user_id=? GROUP BY m HAVING p>0 ORDER BY m LIMIT 1').get(uid);
    if (month) award(uid, 'profitable_month', month.m);
    const verified = !!db.prepare('SELECT 1 FROM mod_verified WHERE user_id=?').get(uid);
    if (verified) award(uid, 'verified');
    else db.prepare("DELETE FROM social_badges WHERE user_id=? AND badge='verified'").run(uid); // follows the moderator's verification
  }
  function sweepLeaders() {
    const top = db.prepare('SELECT sp.user_id, COALESCE((SELECT SUM(realized_pnl_cents) FROM positions WHERE user_id=sp.user_id),0) v FROM social_profiles sp ORDER BY v DESC, sp.nickname LIMIT 10').all();
    for (const r of top) if (r.v > 0) award(r.user_id, 'top_10');
    for (const r of db.prepare("SELECT v.user_id FROM mod_verified v WHERE NOT EXISTS (SELECT 1 FROM social_badges b WHERE b.user_id=v.user_id AND b.badge='verified')").all()) award(r.user_id, 'verified');
    db.prepare("DELETE FROM social_badges WHERE badge='verified' AND user_id NOT IN (SELECT user_id FROM mod_verified)").run();
  }
  const dirty = new Set();
  engine.on('fill', (uid) => dirty.add(uid));
  engine.on('settlement', (uid) => dirty.add(uid));
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
    limitWrite('avatar', uid);
    const b = req.body || {};
    if (b.sticker_id === null || b.sticker_id === '') { db.prepare('DELETE FROM profile_avatars WHERE user_id=?').run(uid); return res.json({ avatar: null }); }
    const prev = db.prepare('SELECT * FROM profile_avatars WHERE user_id=?').get(uid);
    const id = stickerParam(b.sticker_id);
    if (prev && prev.status === 'rejected' && prev.sticker_id === id) throw new ApiError(409, 'avatar_rejected', 'a moderator declined this picture for your profile; pick another one');
    db.prepare("INSERT INTO profile_avatars(user_id,sticker_id,status,updated_at) VALUES(?,?,'auto_approved',?) ON CONFLICT(user_id) DO UPDATE SET sticker_id=excluded.sticker_id, status='auto_approved', decided_by=NULL, decided_at=NULL, reason='', updated_at=excluded.updated_at").run(uid, id, nowIso());
    res.json({ avatar: avatarVo(uid) });
  });

  // ------------------------------------------------------------ edit window + history (P2.1)
  const extrasOf = (pid) => db.prepare('SELECT * FROM post_extras WHERE post_id=?').get(pid);
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
    limitWrite('edit', uid);
    const x = extrasOf(p.id);
    const body = cleanText(req.body?.body, MAX_POST, { allowEmpty: !!x?.sticker_id });
    if (body === p.body) return res.json({ post: feat.postVo(p, uid) });
    applyEdit(req, p, body);
    res.json({ post: feat.postVo(db.prepare('SELECT * FROM posts WHERE id=?').get(p.id), uid) });
  });
  const editsVo = (pid) => db.prepare('SELECT e.*, sp.nickname FROM post_edits e LEFT JOIN social_profiles sp ON sp.user_id=e.editor_id WHERE e.post_id=? ORDER BY e.edited_ts').all(pid)
    .map((e) => ({ id: e.id, edited_time: iso(e.edited_ts), by_moderator: !!e.by_moderator, editor: e.by_moderator ? 'moderator' : e.nickname || null, previous_body: e.prev_body, new_body: e.new_body, reason: e.reason }));
  v1.get('/admin/moderation/posts/:pid', can('social.moderate'), (req, res) => {
    const p = db.prepare('SELECT * FROM posts WHERE id=?').get(String(req.params.pid));
    if (!p) throw E.notFound();
    const x = extrasOf(p.id);
    res.json({ post: { id: p.id, body: p.body, author_nickname: profileOf(p.user_id)?.nickname || null, created_time: iso(p.created_ts), event_ticker: p.event_ticker, subtype: x?.subtype || 'standard',
      position: x?.position_ticker ? positionVo(x) : null, sticker_id: x?.sticker_id || null, hidden: !!db.prepare("SELECT 1 FROM mod_hidden WHERE kind='post' AND content_id=?").get(p.id) }, edits: editsVo(p.id) });
  });

  // ------------------------------------------------------------ mutes (P2.1)
  v1.get('/users/:uid/social/mutes', requireUser, (req, res) => {
    const rows = db.prepare('SELECT m.created_at, sp.nickname FROM user_mutes m JOIN social_profiles sp ON sp.user_id=m.muted_id WHERE m.muter_id=? ORDER BY m.created_at DESC').all(req.auth.user.id);
    res.json({ mutes: rows.map((r) => ({ nickname: r.nickname, created_time: r.created_at })) });
  });
  v1.post('/users/:uid/social/mutes', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    limitWrite('mute', uid);
    const nick = req.body?.nickname;
    if (typeof nick !== 'string' || !NICK.test(nick)) throw E.badRequest('nickname is required');
    const t = byNick(nick);
    if (!t) throw E.notFound();
    if (t.user_id === uid) throw E.badRequest('you cannot mute yourself');
    if (db.prepare('SELECT COUNT(*) c FROM user_mutes WHERE muter_id=?').get(uid).c >= MAX_MUTES) throw E.conflict('too_many_mutes', `at most ${MAX_MUTES} muted traders`);
    db.prepare('INSERT INTO user_mutes(muter_id,muted_id,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(uid, t.user_id, nowIso());
    res.status(201).json({ muted: { nickname: t.nickname } });
  });
  v1.delete('/users/:uid/social/mutes', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    limitWrite('mute', uid);
    const t = byNick(req.query.nickname);
    if (!t) throw E.notFound();
    db.prepare('DELETE FROM user_mutes WHERE muter_id=? AND muted_id=?').run(uid, t.user_id);
    res.json({ ok: true });
  });
  const mutedClause = (viewer, col) => (viewer ? { sql: `${col} NOT IN (SELECT muted_id FROM user_mutes WHERE muter_id=?)`, args: [viewer] } : null);

  // ------------------------------------------------------------ topic follows (P2.3)
  function topicParam(b) {
    const kind = b?.kind;
    if (!['event', 'market', 'keyword'].includes(kind)) throw E.badRequest('kind must be event, market or keyword');
    if (typeof b.value !== 'string') throw E.badRequest('value is required');
    if (kind === 'keyword') {
      const v = b.value.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
      if (!KEYWORD.test(v) || BIDI.test(v)) throw E.badRequest('keywords are 2-32 letters, digits, spaces or # $ & \' . + -');
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
    if (r.kind === 'market') { const m = marketInfo(r.value); vo.label = m ? `${m.yes_sub_title} · ${m.title || m.et}` : r.value; vo.link = m ? `${eventLink(r.value)}?market=${encodeURIComponent(r.value)}` : null; }
    if (r.kind === 'keyword') vo.label = `“${r.value}”`;
    return vo;
  }
  v1.get('/users/:uid/social/topics', requireUser, (req, res) => {
    res.json({ topics: db.prepare('SELECT * FROM topic_follows WHERE user_id=? ORDER BY created_at DESC').all(req.auth.user.id).map(topicVo) });
  });
  v1.post('/users/:uid/social/topics', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    limitWrite('topic', uid);
    const t = topicParam(req.body);
    if (db.prepare('SELECT COUNT(*) c FROM topic_follows WHERE user_id=?').get(uid).c >= MAX_TOPICS && !db.prepare('SELECT 1 FROM topic_follows WHERE user_id=? AND kind=? AND value=?').get(uid, t.kind, t.value)) throw E.conflict('too_many_topics', `you can follow at most ${MAX_TOPICS} topics`);
    db.prepare('INSERT INTO topic_follows(user_id,kind,value,created_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(uid, t.kind, t.value, nowIso());
    res.status(201).json({ topic: topicVo(db.prepare('SELECT * FROM topic_follows WHERE user_id=? AND kind=? AND value=?').get(uid, t.kind, t.value)) });
  });
  v1.delete('/users/:uid/social/topics', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    limitWrite('topic', uid);
    const t = topicParam({ kind: req.query.kind, value: String(req.query.value ?? '') });
    db.prepare('DELETE FROM topic_follows WHERE user_id=? AND kind=? AND value=?').run(uid, t.kind, t.value);
    res.json({ ok: true });
  });
  // SQL for "posts on topics this viewer follows" (events, markets — the post's event or its position tag — and keywords).
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
  // Notify followers of a matching topic (not the author, not those who muted the author, not followers of the author
  // who already got the "posted" notification). Fan-out capped.
  function notifyTopicFollowers(post, ext, me) {
    const body = post.body;
    const matches = new Map(); // uid -> label
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
      if (uid === post.user_id || sent >= 500) continue;
      if (db.prepare('SELECT 1 FROM follows WHERE follower_id=? AND followee_id=?').get(uid, post.user_id)) continue;
      n(uid, { type: 'social_topic', title: `@${me.nickname} posted about ${label}`, body: (body || 'Sticker').slice(0, 120), link: `/social/post/${encodeURIComponent(post.id)}`, actor: post.user_id });
      sent += 1;
    }
  }

  // ------------------------------------------------------------ profile search (P2.3): nickname prefix only
  v1.get('/search/social_profiles', (req, res) => {
    const ipWait = searchIp.take(req.ip || 'local');
    const uWait = req.auth ? searchUser.take(req.auth.user.id) : 0;
    if (ipWait || uWait) { res.setHeader('Retry-After', String(Math.max(ipWait, uWait))); throw new LimitError(Math.max(ipWait, uWait)); }
    const raw = req.query.query ?? req.query.q ?? '';
    if (typeof raw !== 'string') throw E.badRequest('query must be a string');
    const q = raw.trim().replace(/^@/, '');
    let limit = 10;
    if (req.query.limit !== undefined) { limit = Number(req.query.limit); if (!/^\d+$/.test(String(req.query.limit)) || limit < 1 || limit > 20) throw E.badRequest('limit must be 1-20'); }
    if (!q) return res.json({ profiles: [] });
    if (!NICK.test(q)) throw E.badRequest('search by nickname: letters, digits and underscores only');
    const like = `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = db.prepare("SELECT sp.user_id, sp.nickname FROM social_profiles sp JOIN users u ON u.id=sp.user_id WHERE u.is_system=0 AND sp.nickname LIKE ? ESCAPE '\\' ORDER BY length(sp.nickname), sp.nickname LIMIT ?").all(like, limit);
    res.json({ profiles: rows.map((r) => ({ nickname: r.nickname, verified: !!db.prepare('SELECT 1 FROM mod_verified WHERE user_id=?').get(r.user_id),
      followers: db.prepare('SELECT COUNT(*) c FROM follows WHERE followee_id=?').get(r.user_id).c, badges: badgeIds(r.user_id), avatar: avatarVo(r.user_id) })) });
  });

  // ------------------------------------------------------------ timeline count (P2.3): new posts since a time
  v1.get('/social/timeline_count', (req, res) => {
    const viewer = req.auth?.user.id || null;
    const feed = String(req.query.feed || 'all');
    if (!['all', 'following', 'topics'].includes(feed)) throw E.badRequest('feed must be all, following or topics');
    if (feed !== 'all' && !viewer) throw E.unauthorized();
    const sraw = String(req.query.since ?? '');
    const since = /^\d{10,14}$/.test(sraw) ? Number(sraw) : Date.parse(sraw);
    if (!Number.isFinite(since)) throw E.badRequest('since must be an ISO time or epoch milliseconds');
    const where = ['p.created_ts > ?', "p.id NOT IN (SELECT content_id FROM mod_hidden WHERE kind='post')"]; const args = [since];
    if (viewer) { where.push('p.user_id <> ?'); args.push(viewer); const m = mutedClause(viewer, 'p.user_id'); where.push(m.sql); args.push(...m.args); }
    if (feed === 'following') { where.push('p.user_id IN (SELECT followee_id FROM follows WHERE follower_id=?)'); args.push(viewer); }
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
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'none'; script-src 'none'; frame-ancestors 'none'; sandbox");
    res.send(STICKER_SVG.get(s.id).svg);
  });
  v1.get('/social/gifs/search', async (req, res, next) => {
    try {
      if (!req.auth) throw E.unauthorized();
      if (!gif.enabled) throw new ApiError(403, 'feature_disabled', 'GIF search is not enabled on this exchange', 'gif_provider_disabled: use the Parlance sticker set');
      const w = searchUser.take(req.auth.user.id); if (w) throw new LimitError(w);
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      if (!q || q.length > 50) throw E.badRequest('q is required (at most 50 characters)');
      const items = await gif.search(q);
      res.json({ results: (items || []).map(({ id, rating, url }) => ({ id, rating, url })) });
    } catch (e) { next(e); }
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
    audit(req, en ? 'social.sticker.enable' : 'social.sticker.disable', 'sticker', s.id, { enabled: !!s.enabled }, { enabled: en }, reason);
    res.json({ sticker: { id: s.id, label: s.label, enabled: en, url: stickerUrl(s.id) } });
  });

  // ------------------------------------------------------------ notification preferences (P2.4)
  function prefsOf(uid) {
    const r = db.prepare('SELECT * FROM notif_prefs WHERE user_id=?').get(uid);
    const saved = r ? JSON.parse(r.types) : {};
    const quiet = r ? JSON.parse(r.quiet) : {};
    const types = {};
    for (const [k, t] of NTYPE) {
      const s = saved[k] || {};
      types[k] = t.locked ? { ...t.def } : { in_app: s.in_app ?? t.def.in_app, email: s.email ?? t.def.email };
    }
    return { types, quiet: { enabled: !!quiet.enabled, start: quiet.start || '22:00', end: quiet.end || '07:00', timezone: quiet.timezone || 'UTC' } };
  }
  const prefsVo = (uid) => {
    const p = prefsOf(uid);
    return { channels: ['in_app', 'email'], types: [...NTYPE].map(([k, t]) => ({ type: k, label: t.label, locked: t.locked, ...p.types[k] })), quiet_hours: p.quiet, in_quiet_hours: inQuiet(p.quiet) };
  };
  const minutesIn = (tz, ms = Date.now()) => {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
    return Number(parts.find((x) => x.type === 'hour').value) * 60 + Number(parts.find((x) => x.type === 'minute').value);
  };
  const toMin = (s) => { const m = HHMM.exec(s); return Number(m[1]) * 60 + Number(m[2]); };
  function inQuiet(q, ms = Date.now()) {
    if (!q.enabled) return false;
    const now = minutesIn(q.timezone, ms); const a = toMin(q.start); const b = toMin(q.end);
    return a === b ? true : a < b ? now >= a && now < b : now >= a || now < b;
  }
  const quietEndsAt = (q, ms = Date.now()) => ms + ((toMin(q.end) - minutesIn(q.timezone, ms) + 1440) % 1440 || 1440) * 60000;
  function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0); return true; } catch { return false; } }
  function savePrefs(uid, b) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw E.badRequest('a preferences object is required');
    const cur = db.prepare('SELECT * FROM notif_prefs WHERE user_id=?').get(uid);
    const types = cur ? JSON.parse(cur.types) : {};
    let quiet = cur ? JSON.parse(cur.quiet) : {};
    if (b.types !== undefined) {
      if (!b.types || typeof b.types !== 'object' || Array.isArray(b.types)) throw E.badRequest('types must be an object keyed by notification type');
      for (const [k, v] of Object.entries(b.types)) {
        const t = NTYPE.get(k);
        if (!t) throw E.badRequest(`unknown notification type ${k}`);
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw E.badRequest(`types.${k} must be an object`);
        for (const ch of Object.keys(v)) if (!['in_app', 'email'].includes(ch) || typeof v[ch] !== 'boolean') throw E.badRequest(`types.${k}.${ch} must be a boolean in_app or email flag`);
        if (t.locked && Object.entries(v).some(([ch, on]) => on !== t.def[ch])) throw new ApiError(400, 'preference_locked', `${t.label} notifications cannot be turned off`);
        types[k] = { ...(types[k] || {}), ...v };
      }
    }
    if (b.quiet_hours !== undefined) {
      const q = b.quiet_hours;
      if (!q || typeof q !== 'object' || Array.isArray(q)) throw E.badRequest('quiet_hours must be an object');
      const next = { ...quiet };
      if (q.enabled !== undefined) { if (typeof q.enabled !== 'boolean') throw E.badRequest('quiet_hours.enabled must be a boolean'); next.enabled = q.enabled; }
      for (const k of ['start', 'end']) if (q[k] !== undefined) { if (typeof q[k] !== 'string' || !HHMM.test(q[k])) throw E.badRequest(`quiet_hours.${k} must be HH:MM (24 h)`); next[k] = q[k]; }
      if (q.timezone !== undefined) { if (typeof q.timezone !== 'string' || q.timezone.length > 64 || !validTz(q.timezone)) throw E.badRequest('quiet_hours.timezone must be an IANA time zone such as Europe/London'); next.timezone = q.timezone; }
      quiet = next;
    }
    db.prepare('INSERT INTO notif_prefs(user_id,types,quiet,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET types=excluded.types, quiet=excluded.quiet, updated_at=excluded.updated_at').run(uid, JSON.stringify(types), JSON.stringify(quiet), nowIso());
  }
  v1.get('/users/:uid/notifications/preferences', requireUser, (req, res) => res.json(prefsVo(req.auth.user.id)));
  v1.put('/users/:uid/notifications/preferences', requireUser, (req, res) => {
    limitWrite('prefs', req.auth.user.id);
    savePrefs(req.auth.user.id, req.body);
    res.json(prefsVo(req.auth.user.id));
  });
  // Observed call site `…/notifications/settings/{t}`: one type's channels.
  v1.put('/users/:uid/notifications/settings/:type', requireUser, (req, res) => {
    limitWrite('prefs', req.auth.user.id);
    if (!NTYPE.has(req.params.type)) throw E.notFound();
    savePrefs(req.auth.user.id, { types: { [req.params.type]: req.body || {} } });
    res.json(prefsVo(req.auth.user.id));
  });
  // Gate called by features.notify() for every notification: muted actors, per-type channels, quiet hours, email stub.
  function notifyGate(uid, msg) {
    if (msg.actor && isMuted(uid, msg.actor)) return { store: false };
    const key = prefKey(msg.type);
    const p = prefsOf(uid);
    const quiet = inQuiet(p.quiet);
    const ch = key ? p.types[key] : { in_app: true, email: false };
    if (ch.email) {
      const now = Date.now();
      // Dev email stub: rows are the "sent" mail (no SMTP); quiet hours defer delivery to the end of the window.
      db.prepare('INSERT INTO notif_email_outbox(id,user_id,type,subject,body,link,status,created_ts,send_after_ts,sent_ts) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(newId('em_'), uid, msg.type, String(msg.title).slice(0, 200), String(msg.body || '').slice(0, 1000), String(msg.link || ''), quiet ? 'deferred' : 'sent', now, quiet ? quietEndsAt(p.quiet, now) : now, quiet ? null : now);
    }
    if (!ch.in_app) return { store: false };
    return { store: true, push: !quiet };
  }
  function flushOutbox() {
    db.prepare("UPDATE notif_email_outbox SET status='sent', sent_ts=? WHERE status='deferred' AND send_after_ts<=?").run(Date.now(), Date.now());
  }

  // ------------------------------------------------------------ price-movement subscriptions (P2.4)
  const WINDOWS = [1, 5, 15, 30, 60, 240, 1440];
  const subVo = (s) => { const m = marketInfo(s.market_ticker); return { id: s.id, market_ticker: s.market_ticker, market_title: m ? (m.title || m.et) : s.market_ticker, outcome: m ? m.yes_sub_title : '', threshold_cents: s.threshold_cents, window_minutes: s.window_minutes, direction: s.direction, created_time: s.created_at, last_notified_time: iso(s.last_notified_ts), last_move_cents: s.last_move_cents, link: m ? eventLink(s.market_ticker) : null }; };
  v1.get('/users/:uid/notifications/price_movement_subscriptions', requireUser, (req, res) => {
    const args = [req.auth.user.id]; let extra = '';
    if (req.query.market_ticker) { extra = ' AND market_ticker=?'; args.push(String(req.query.market_ticker)); }
    res.json({ subscriptions: db.prepare(`SELECT * FROM price_move_subs WHERE user_id=?${extra} ORDER BY created_at DESC`).all(...args).map(subVo) });
  });
  v1.post('/users/:uid/notifications/price_movement_subscriptions', requireUser, (req, res) => {
    const uid = req.auth.user.id;
    limitWrite('subs', uid);
    const b = req.body || {};
    const t = typeof b.market_ticker === 'string' ? b.market_ticker.toUpperCase() : '';
    if (!TICKER.test(t)) throw E.badRequest('market_ticker is required');
    if (!marketInfo(t)) throw E.notFound();
    const th = b.threshold_cents;
    if (!Number.isInteger(th) || th < 1 || th > 99) throw E.badRequest('threshold_cents must be a whole number of cents from 1 to 99');
    const w = b.window_minutes;
    if (!WINDOWS.includes(w)) throw E.badRequest(`window_minutes must be one of ${WINDOWS.join(', ')}`);
    const dir = b.direction ?? 'any';
    if (!['any', 'up', 'down'].includes(dir)) throw E.badRequest('direction must be any, up or down');
    if (db.prepare('SELECT COUNT(*) c FROM price_move_subs WHERE user_id=?').get(uid).c >= MAX_MOVE_SUBS) throw E.conflict('too_many_subscriptions', `at most ${MAX_MOVE_SUBS} price-movement alerts`);
    if (db.prepare('SELECT 1 FROM price_move_subs WHERE user_id=? AND market_ticker=? AND threshold_cents=? AND window_minutes=? AND direction=?').get(uid, t, th, w, dir)) throw E.conflict('subscription_exists', 'you already have this alert');
    const id = newId('pm_');
    db.prepare('INSERT INTO price_move_subs(id,user_id,market_ticker,threshold_cents,window_minutes,direction,created_at) VALUES(?,?,?,?,?,?,?)').run(id, uid, t, th, w, dir, nowIso());
    res.status(201).json({ subscription: subVo(db.prepare('SELECT * FROM price_move_subs WHERE id=?').get(id)) });
  });
  v1.delete('/users/:uid/notifications/price_movement_subscriptions', requireUser, (req, res) => {
    limitWrite('subs', req.auth.user.id);
    const r = db.prepare('DELETE FROM price_move_subs WHERE id=? AND user_id=?').run(String(req.query.id || ''), req.auth.user.id);
    if (!r.changes) throw E.notFound();
    res.json({ ok: true });
  });
  // Reference = the last trade at or before (now − window), else the first trade inside the window. A subscription
  // fires when |last − reference| ≥ threshold in its direction, at most once per window (persisted, restart-safe).
  engine.on('ticker', (ticker, q) => {
    if (q.last_price == null) return;
    let subs;
    try { subs = db.prepare('SELECT * FROM price_move_subs WHERE market_ticker=?').all(ticker); } catch { return; }
    if (!subs.length) return;
    const now = Date.now();
    for (const s of subs) {
      const winMs = s.window_minutes * 60000;
      if (s.last_notified_ts && now - s.last_notified_ts < winMs) continue;
      const ref = db.prepare('SELECT yes_price_cents p FROM trades WHERE market_ticker=? AND created_ts<=? ORDER BY created_ts DESC, rowid DESC LIMIT 1').get(ticker, now - winMs)
        || db.prepare('SELECT yes_price_cents p FROM trades WHERE market_ticker=? AND created_ts>? ORDER BY created_ts, rowid LIMIT 1').get(ticker, now - winMs);
      if (!ref) continue;
      const move = q.last_price - ref.p;
      if (Math.abs(move) < s.threshold_cents || (s.direction === 'up' && move <= 0) || (s.direction === 'down' && move >= 0)) continue;
      db.prepare('UPDATE price_move_subs SET last_notified_ts=?, last_notified_price=?, last_move_cents=? WHERE id=?').run(now, q.last_price, move, s.id);
      const m = marketInfo(ticker);
      n(s.user_id, { type: 'price_movement', title: `${m ? m.yes_sub_title : ticker} moved ${move > 0 ? '▲' : '▼'} ${Math.abs(move)}¢ in ${s.window_minutes >= 60 ? `${s.window_minutes / 60} h` : `${s.window_minutes} min`} (now ${q.last_price}¢)`, body: m ? (m.title || m.et) : ticker, link: eventLink(ticker) });
    }
  });

  // ------------------------------------------------------------ social-admin PUT endpoints (G8)
  // Call sites (evidence/api_callsites_home.txt lines 236-239); the request bodies are UNKNOWN, so these are Parlance's design.
  const SA = '/users/:uid/social/social-admin';
  const selfOnly = (req) => { if (req.params.uid !== req.auth.user.id) throw E.forbidden('cannot access another user'); };
  const modPost = (pid) => { const p = db.prepare('SELECT * FROM posts WHERE id=?').get(String(pid)); if (!p) throw E.notFound(); return p; };
  v1.put(`${SA}/determine_profile_image/:id`, can('social.moderate'), (req, res) => {
    selfOnly(req);
    const target = db.prepare('SELECT user_id FROM social_profiles WHERE user_id=? OR nickname=?').get(String(req.params.id), String(req.params.id));
    const a = target && db.prepare('SELECT * FROM profile_avatars WHERE user_id=?').get(target.user_id);
    if (!a) throw E.notFound();
    const d = req.body?.decision;
    if (!['approve', 'reject'].includes(d)) throw E.badRequest('decision must be approve or reject');
    const reason = d === 'reject' ? reasonOf(req.body) : (typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '');
    const status = d === 'approve' ? 'approved' : 'rejected';
    db.prepare('UPDATE profile_avatars SET status=?, decided_by=?, decided_at=?, reason=? WHERE user_id=?').run(status, req.auth.user.id, nowIso(), reason, target.user_id);
    audit(req, 'social.profile_image', 'user', target.user_id, { sticker_id: a.sticker_id, status: a.status }, { sticker_id: a.sticker_id, status }, reason);
    if (status === 'rejected') n(target.user_id, { type: 'account', title: 'A moderator removed your profile picture', body: reason, link: '/social/settings' });
    res.json({ profile_image: { sticker_id: a.sticker_id, status } });
  });
  v1.put(`${SA}/posts/:pid/market_status`, can('social.moderate'), (req, res) => {
    selfOnly(req);
    const p = modPost(req.params.pid);
    const b = req.body || {};
    const reason = reasonOf(b);
    if (b.event_ticker === undefined && b.position_tag === undefined) throw E.badRequest('send event_ticker (string or null) and/or position_tag ("keep" or "remove")');
    let et = p.event_ticker;
    if (b.event_ticker !== undefined) {
      if (b.event_ticker === null) et = null;
      else { if (typeof b.event_ticker !== 'string' || !TICKER.test(b.event_ticker.toUpperCase()) || !getEvent(b.event_ticker.toUpperCase())) throw E.badRequest('event_ticker must be an existing event or null'); et = b.event_ticker.toUpperCase(); }
    }
    if (b.position_tag !== undefined && !['keep', 'remove'].includes(b.position_tag)) throw E.badRequest('position_tag must be keep or remove');
    const before = { event_ticker: p.event_ticker, position: extrasOf(p.id)?.position_ticker || null };
    tx(db, () => {
      db.prepare('UPDATE posts SET event_ticker=? WHERE id=?').run(et, p.id);
      if (b.position_tag === 'remove') { ensureExtras(p.id); db.prepare('UPDATE post_extras SET position_ticker=NULL, position_side=NULL, position_units=NULL, position_outcome=NULL, position_title=NULL, position_event_ticker=NULL, position_held=NULL WHERE post_id=?').run(p.id); }
    });
    const after = { event_ticker: et, position: extrasOf(p.id)?.position_ticker || null };
    audit(req, 'social.post_market_status', 'post', p.id, before, after, reason);
    res.json({ post: feat.postVo(modPost(p.id), req.auth.user.id) });
  });
  v1.put(`${SA}/posts/:pid/post_subtype`, can('social.moderate'), (req, res) => {
    selfOnly(req);
    const p = modPost(req.params.pid);
    const st = req.body?.post_subtype;
    if (!SUBTYPES.includes(st)) throw E.badRequest(`post_subtype must be one of ${SUBTYPES.join(', ')}`);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
    const before = extrasOf(p.id)?.subtype || 'standard';
    tx(db, () => { ensureExtras(p.id); db.prepare('UPDATE post_extras SET subtype=? WHERE post_id=?').run(st, p.id); });
    audit(req, 'social.post_subtype', 'post', p.id, { post_subtype: before }, { post_subtype: st }, reason);
    res.json({ post: feat.postVo(modPost(p.id), req.auth.user.id) });
  });
  v1.put(`${SA}/posts/:pid/update`, can('social.moderate'), (req, res) => {
    selfOnly(req);
    const p = modPost(req.params.pid);
    const reason = reasonOf(req.body);
    const body = cleanText(req.body?.body, MAX_POST, { allowEmpty: !!extrasOf(p.id)?.sticker_id });
    applyEdit(req, p, body, { byMod: true, reason });
    audit(req, 'social.post_update', 'post', p.id, { body: p.body }, { body }, reason);
    if (p.user_id !== req.auth.user.id) n(p.user_id, { type: 'account', title: 'A moderator edited your post', body: reason, link: `/social/post/${encodeURIComponent(p.id)}` });
    res.json({ post: feat.postVo(modPost(p.id), req.auth.user.id) });
  });

  // ------------------------------------------------------------ promo targeting (G8): event + category placements
  // Home (bff/home, server/admin.js) shows untargeted promos; targeted promos appear on the event pages of their series
  // and on their category pages. hide_logged_out hides a promo from signed-out visitors everywhere (spec §13.11 fields).
  v1.get('/promos', (req, res) => {
    const series = typeof req.query.series_ticker === 'string' ? req.query.series_ticker.toUpperCase() : '';
    const cat = typeof req.query.category === 'string' ? req.query.category : '';
    if (!series && !cat) throw E.badRequest('series_ticker or category is required');
    const now = Date.now();
    const rows = db.prepare('SELECT * FROM cms_promos WHERE active=1 ORDER BY position, created_at').all()
      .filter((r) => (!r.starts_at || Date.parse(r.starts_at) <= now) && (!r.ends_at || Date.parse(r.ends_at) > now))
      .filter((r) => !(r.hide_logged_out && !req.auth))
      .filter((r) => {
        const st = JSON.parse(r.series_tickers || '[]'); const cs = JSON.parse(r.categories || '[]');
        return (series && st.includes(series)) || (cat && cs.some((c) => c.toLowerCase() === cat.toLowerCase()));
      });
    res.json({ promos: rows.map((p) => ({ id: p.id, overline: p.overline, title: p.title, subtitle: p.subtitle, link: p.link, color: p.color })) });
  });

  // ------------------------------------------------------------ features.js hooks
  function decoratePost(vo, p, viewer) {
    const x = extrasOf(p.id);
    vo.sticker = x?.sticker_id ? stickerVo(x.sticker_id) : null;
    vo.position = x?.position_ticker ? positionVo(x) : null;
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
  function decorateComment(vo, c, viewer) {
    const x = db.prepare('SELECT sticker_id FROM comment_extras WHERE comment_id=?').get(c.id);
    vo.sticker = x?.sticker_id ? stickerVo(x.sticker_id) : null;
    vo.author.badges = badgeIds(c.user_id);
    vo.author.avatar = avatarVo(c.user_id);
    void viewer;
  }
  function decorateProfile(vo, p, viewer) {
    vo.badges = badgeIds(p.user_id);
    vo.avatar = avatarVo(p.user_id);
    vo.is_muted = isMuted(viewer, p.user_id);
    if (viewer === p.user_id) { const a = db.prepare('SELECT * FROM profile_avatars WHERE user_id=?').get(p.user_id); vo.avatar_status = a ? { sticker_id: a.sticker_id, status: a.status, reason: a.reason } : null; }
  }
  function feedFilter({ feed, viewer, where, args, req }) {
    if (viewer && !req.query.nickname) { const m = mutedClause(viewer, 'p.user_id'); where.push(m.sql); args.push(...m.args); }
    if (feed === 'topics') { const t = topicsClause(viewer); where.push(t.sql); args.push(...t.args); }
  }
  function beforePost(req) {
    const b = req.body || {};
    const sticker = stickerParam(b.sticker_id);
    const position = positionParam(req.auth.user.id, b.position);
    return { sticker, position, allowEmptyBody: !!sticker };
  }
  function afterPost(post, ext, me) {
    if (ext && (ext.sticker || ext.position)) {
      const ps = ext.position;
      db.prepare('INSERT INTO post_extras(post_id,sticker_id,position_ticker,position_side,position_units,position_outcome,position_title,position_event_ticker,position_held) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(post.id, ext.sticker, ps?.ticker ?? null, ps?.side ?? null, ps?.units ?? null, ps?.outcome ?? null, ps?.title ?? null, ps?.event_ticker ?? null, ps?.held ?? null);
    }
    try { notifyTopicFollowers(post, ext, me); } catch (e) { console.error('topic notify', e); }
  }
  function beforeComment(req) {
    const sticker = stickerParam(req.body?.sticker_id);
    return { sticker, allowEmptyBody: !!sticker };
  }
  function afterComment(commentId, ext) {
    if (ext?.sticker) db.prepare('INSERT INTO comment_extras(comment_id,sticker_id) VALUES(?,?)').run(commentId, ext.sticker);
  }
  const commentFilter = (c, viewer) => !isMuted(viewer, c.user_id);

  function attachFeatures(f) {
    feat = f;
    const h = f.hooks;
    h.postVo.push(decoratePost);
    h.commentVo.push(decorateComment);
    h.profileVo.push(decorateProfile);
    h.feeds.push('topics');
    h.feedFilter = feedFilter;
    h.beforePost = beforePost;
    h.afterPost = afterPost;
    h.beforeComment = beforeComment;
    h.afterComment = afterComment;
    h.commentFilter = commentFilter;
    h.notifyGate = notifyGate;
  }

  // ------------------------------------------------------------ background: badges, deferred email, bucket pruning
  let lastLeaders = 0; let lastPrune = Date.now();
  engine.on('tick', () => {
    try {
      for (const uid of [...dirty].slice(0, 200)) { dirty.delete(uid); evaluate(uid); }
      const now = Date.now();
      if (now - lastLeaders > 5000) { lastLeaders = now; sweepLeaders(); flushOutbox(); }
      if (now - lastPrune > 60000) { lastPrune = now; for (const b of writeBuckets.values()) b.prune(); searchIp.prune(); searchUser.prune(); }
    } catch (e) { if (!/database is not open/i.test(String(e && e.message))) console.error('social2 tick', e); }
  });

  return { attachFeatures, isMuted, stickerParam, stickerVo, avatarVo, badgeIds, evaluate, sweepLeaders, prefsOf, inQuiet, limits, cleanText };
}

module.exports = { mountSocial2, cleanText, EDIT_WINDOW_MS, BADGES, NTYPES, SUBTYPES };
