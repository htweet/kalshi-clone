'use strict';
// Features added from the 2026-11-02 live capture (CLONE_SPEC §13): social, notifications + price targets,
// account limits, two-factor login, calendar feed, categories with subcategories, social trades.
const crypto = require('node:crypto');
const { eventLimits } = require('./calendar-limits'); // calendar event_limits (Phase 5B, CLONE_SPEC.md §29)
const { tx } = require('./db');
const { nowIso, newId, dollars, ufp, ustr, E, ApiError, encCursor, decCursor } = require('./util');

// Category navigation (spec §13.3; names follow the observed top-level set, subcategories come from series tags).
const CATEGORIES = ['Politics', 'Sports', 'Elections', 'Crypto', 'Climate and Weather', 'Economics', 'Entertainment', 'Companies', 'Financials', 'Science and Technology'];
const DAY_MS = 86400000;
const COOL_OFF_MS = DAY_MS;

// ---------------- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ----------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(buf) {
  let bits = 0; let val = 0; let out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32decode(s) {
  let bits = 0; let val = 0; const out = [];
  for (const ch of String(s).replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch); if (i < 0) continue;
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totp(secret, ms = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(ms / 30000)));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}
const verifyTotp = (secret, code) => /^\d{6}$/.test(String(code || '')) && [-1, 0, 1].some((w) => totp(secret, Date.now() + w * 30000) === String(code));

const dayKey = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10); // design choice: UTC day
const dayStartMs = (ms = Date.now()) => Date.parse(dayKey(ms) + 'T00:00:00Z');

function mountFeatures({ v1, db, engine, requireUser, eventFull, getEvent }) {
  // Extension points used by the Phase 2 community modules (server/community.js, CLONE_SPEC.md §24): serializer
  // decorators, feed filters and extra feeds, post / reply creation (stickers, verified position tags, circle-only
  // visibility), per-post visibility, and the notification gate (type × channel preferences, quiet hours, mutes).
  const hooks = { postVo: [], commentVo: [], profileVo: [], feeds: [], feedFilter: null, beforePost: null, afterPost: null, beforeComment: null, afterComment: null, commentFilter: null, canView: null, notifyGate: null, afterPostNotify: null };
  // ======================= notifications =======================
  const notifVo = (n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, read: !!n.read_at, created_time: new Date(n.created_ts).toISOString() });
  function notify(userId, { type, title, body = '', link = '', actor = null, meta = null }) {
    // The gate decides per type × channel: store in-app, toast live, and queue email / push (server/notify-prefs.js).
    const gate = hooks.notifyGate ? hooks.notifyGate(userId, { type, title, body, link, actor, meta }) : null;
    if (gate && !gate.store) return null;
    const n = { id: newId('n_'), user_id: userId, type, title: (gate && gate.title) || title, body, link, read_at: null, created_ts: Date.now() };
    db.prepare('INSERT INTO notifications(id,user_id,type,title,body,link,read_at,created_ts) VALUES(?,?,?,?,?,?,?,?)').run(n.id, userId, type, n.title, body, link, null, n.created_ts);
    engine.emit('notification', userId, gate && gate.quiet ? { ...notifVo(n), quiet: true } : notifVo(n));
    return n.id;
  }
  const isSystem = (uid) => !!db.prepare('SELECT is_system FROM users WHERE id=?').get(uid)?.is_system;
  const eventLink = (ticker) => {
    const r = db.prepare('SELECT e.ticker et, s.ticker st, s.slug FROM markets m JOIN events e ON e.ticker=m.event_ticker JOIN series s ON s.ticker=e.series_ticker WHERE m.ticker=?').get(ticker)
      || db.prepare('SELECT e.ticker et, s.ticker st, s.slug FROM events e JOIN series s ON s.ticker=e.series_ticker WHERE e.ticker=?').get(ticker);
    return r ? `/markets/${r.st.toLowerCase()}/${r.slug}/${r.et.toLowerCase()}` : '/';
  };
  const marketLabel = (ticker) => {
    const m = db.prepare('SELECT title, yes_sub_title FROM markets WHERE ticker=?').get(ticker);
    return m ? m.title : ticker;
  };

  engine.on('fill', (uid, f) => {
    if (isSystem(uid)) return;
    notify(uid, { type: 'fill', title: `Order filled: ${ustr(f.count)} ${f.side.toUpperCase()} @ ${f.price_cents}¢`, body: marketLabel(f.market_ticker), link: eventLink(f.market_ticker), meta: { is_taker: !!f.is_taker, order_id: f.order_id } });
  });
  engine.on('settlement', (uid, s) => {
    if (isSystem(uid)) return;
    notify(uid, { type: 'settlement', title: `Market settled ${s.result.toUpperCase()} · paid $${(s.payout_cents / 100).toFixed(2)}`, body: marketLabel(s.market_ticker), link: eventLink(s.market_ticker) });
  });
  // Custom price targets fire once when the YES last price crosses the threshold.
  engine.on('ticker', (ticker, q) => {
    if (q.last_price == null) return;
    const hits = db.prepare('SELECT * FROM price_targets WHERE market_ticker=? AND triggered_at IS NULL AND ((direction=\'above\' AND ?>=price_cents) OR (direction=\'below\' AND ?<=price_cents))').all(ticker, q.last_price, q.last_price);
    for (const t of hits) {
      db.prepare('UPDATE price_targets SET triggered_at=? WHERE id=?').run(nowIso(), t.id);
      notify(t.user_id, { type: 'price_target', title: `Price alert: Yes is ${q.last_price}¢ (${t.direction} ${t.price_cents}¢)`, body: marketLabel(ticker), link: eventLink(ticker) });
    }
  });

  v1.get('/users/:uid/notifications', requireUser, (req, res) => {
    const rows = db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_ts DESC, rowid DESC LIMIT 100').all(req.auth.user.id);
    const unread = db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read_at IS NULL').get(req.auth.user.id).c;
    res.json({ notifications: rows.map(notifVo), unread_count: unread });
  });
  v1.put('/users/:uid/notifications/read', requireUser, (req, res) => {
    db.prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').run(nowIso(), req.auth.user.id);
    res.json({ ok: true });
  });
  v1.put('/users/:uid/notifications/:nid/read', requireUser, (req, res) => {
    const r = db.prepare('UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=? AND user_id=?').run(nowIso(), req.params.nid, req.auth.user.id);
    if (!r.changes) throw E.notFound();
    res.json({ ok: true });
  });

  const targetVo = (t) => ({ id: t.id, market_ticker: t.market_ticker, market_title: marketLabel(t.market_ticker), direction: t.direction, price_dollars: dollars(t.price_cents), created_time: t.created_at, triggered_time: t.triggered_at });
  v1.get('/users/:uid/notifications/custom_price_targets', requireUser, (req, res) => {
    const args = [req.auth.user.id];
    let extra = '';
    if (req.query.market_ticker) { extra = ' AND market_ticker=?'; args.push(String(req.query.market_ticker)); }
    res.json({ price_targets: db.prepare(`SELECT * FROM price_targets WHERE user_id=?${extra} ORDER BY created_at DESC`).all(...args).map(targetVo) });
  });
  v1.post('/users/:uid/notifications/custom_price_targets', requireUser, (req, res) => {
    const b = req.body || {};
    const m = db.prepare('SELECT ticker, status FROM markets WHERE ticker=?').get(String(b.market_ticker || ''));
    if (!m) throw E.notFound();
    if (!['above', 'below'].includes(b.direction)) throw E.badRequest('direction must be above or below');
    const p = Number(b.price_cents);
    if (!Number.isInteger(p) || p < 1 || p > 99) throw E.badRequest('price_cents must be an integer between 1 and 99');
    if (db.prepare('SELECT COUNT(*) c FROM price_targets WHERE user_id=? AND triggered_at IS NULL').get(req.auth.user.id).c >= 50) throw E.conflict('too_many_price_targets', 'at most 50 active price alerts');
    const t = { id: newId('pt_'), user_id: req.auth.user.id, market_ticker: m.ticker, direction: b.direction, price_cents: p, created_at: nowIso(), triggered_at: null };
    db.prepare('INSERT INTO price_targets(id,user_id,market_ticker,direction,price_cents,created_at) VALUES(?,?,?,?,?,?)').run(t.id, t.user_id, t.market_ticker, t.direction, p, t.created_at);
    res.status(201).json({ price_target: targetVo(t) });
  });
  v1.delete('/users/:uid/notifications/custom_price_targets', requireUser, (req, res) => {
    const r = db.prepare('DELETE FROM price_targets WHERE id=? AND user_id=?').run(String(req.query.id || ''), req.auth.user.id);
    if (!r.changes) throw E.notFound();
    res.json({ ok: true });
  });

  // ======================= account limits =======================
  const LIMITS = { deposit: { unit: 'cents', max: 10_000_000 }, trading: { unit: 'cents', max: 10_000_000 }, session: { unit: 'minutes', max: 1440 } };
  function limitRow(uid, kind) {
    let r = db.prepare('SELECT * FROM user_limits WHERE user_id=? AND kind=?').get(uid, kind);
    if (r && r.pending_set && Date.parse(r.pending_effective_at) <= Date.now()) {
      db.prepare('UPDATE user_limits SET value=pending_value, pending_value=NULL, pending_set=0, pending_effective_at=NULL, updated_at=? WHERE user_id=? AND kind=?').run(nowIso(), uid, kind);
      r = db.prepare('SELECT * FROM user_limits WHERE user_id=? AND kind=?').get(uid, kind);
    }
    return r || null;
  }
  const limitValue = (uid, kind) => limitRow(uid, kind)?.value ?? null;
  function setLimit(uid, kind, v) {
    if (v !== null && (!Number.isInteger(v) || v < 1 || v > LIMITS[kind].max)) throw E.badRequest(`limit must be a positive whole number up to ${LIMITS[kind].max}${LIMITS[kind].unit === 'cents' ? ' cents' : ' minutes'}, or null to remove`);
    const cur = limitValue(uid, kind);
    const tighter = v !== null && (cur === null || v <= cur);
    const now = nowIso();
    db.prepare('INSERT INTO user_limits(user_id,kind,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,kind) DO NOTHING').run(uid, kind, null, now);
    if (tighter) db.prepare('UPDATE user_limits SET value=?, pending_value=NULL, pending_set=0, pending_effective_at=NULL, updated_at=? WHERE user_id=? AND kind=?').run(v, now, uid, kind);
    else if (v !== cur) db.prepare('UPDATE user_limits SET pending_value=?, pending_set=1, pending_effective_at=?, updated_at=? WHERE user_id=? AND kind=?').run(v, new Date(Date.now() + COOL_OFF_MS).toISOString(), now, uid, kind);
  }
  const usedToday = {
    deposit: (uid) => db.prepare("SELECT COALESCE(SUM(amount_cents),0) c FROM ledger WHERE user_id=? AND kind='deposit' AND created_at>=?").get(uid, new Date(dayStartMs()).toISOString()).c,
    trading: (uid) => db.prepare('SELECT CAST((COALESCE(SUM(initial_count*price_cents),0)+99)/100 AS INTEGER) c FROM orders WHERE user_id=? AND created_at>=?').get(uid, new Date(dayStartMs()).toISOString()).c,
    session: (uid) => db.prepare('SELECT seconds FROM session_usage WHERE user_id=? AND day=?').get(uid, dayKey())?.seconds ?? 0,
  };
  function limitVo(uid, kind) {
    const r = limitRow(uid, kind);
    const money = LIMITS[kind].unit === 'cents';
    const conv = (v) => (v == null ? null : money ? dollars(v) : v);
    const used = usedToday[kind](uid);
    return {
      kind,
      [money ? 'limit_dollars' : 'limit_minutes']: conv(r?.value ?? null),
      pending: r?.pending_set ? { [money ? 'limit_dollars' : 'limit_minutes']: conv(r.pending_value), effective_time: r.pending_effective_at } : null,
      [money ? 'used_today_dollars' : 'used_today_seconds']: money ? dollars(used) : used,
      period: 'day',
    };
  }
  const parseLimit = (b, kind) => {
    const money = LIMITS[kind].unit === 'cents';
    const raw = b && (money ? b.limit_dollars : b.limit_minutes);
    if (raw === null || raw === '' || raw === undefined) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw E.badRequest('limit must be a number or null');
    return money ? Math.round(n * 100) : n;
  };
  const limitRoutes = [['deposit', '/deposit_limits', '/deposit_limit'], ['trading', '/trading_limits', '/trading_limits'], ['session', '/daily_session_time_limit', '/daily_session_time_limit']];
  for (const [kind, getPath, putPath] of limitRoutes) {
    v1.get(`/users/:uid${getPath}`, requireUser, (req, res) => res.json({ limit: limitVo(req.auth.user.id, kind) }));
    v1.put(`/users/:uid${putPath}`, requireUser, (req, res) => { setLimit(req.auth.user.id, kind, parseLimit(req.body, kind)); res.json({ limit: limitVo(req.auth.user.id, kind) }); });
  }
  function checkDeposit(uid, cents) {
    const lim = limitValue(uid, 'deposit');
    if (lim != null && usedToday.deposit(uid) + cents > lim) throw E.conflict('deposit_limit_exceeded', 'this deposit would exceed your daily deposit limit', `limit $${(lim / 100).toFixed(2)} per day`);
  }
  function checkTrading(uid, costCents) {
    const lim = limitValue(uid, 'trading');
    if (lim != null && usedToday.trading(uid) + costCents > lim) throw E.conflict('trading_limit_exceeded', 'this order would exceed your daily trading limit', `limit $${(lim / 100).toFixed(2)} per day`);
  }
  // Session-time accounting: every authenticated /v1 request adds the gap since the last one (capped at 60 s).
  const SESSION_EXEMPT = /^\/(session|log_out|users\/[^/]+\/(daily_session_time_limit|deposit_limits?|trading_limits))$/;
  function sessionMiddleware(req, res, next) {
    if (!req.auth) return next();
    const uid = req.auth.user.id;
    const now = Date.now();
    const day = dayKey(now);
    const row = db.prepare('SELECT * FROM session_usage WHERE user_id=? AND day=?').get(uid, day);
    if (!row) db.prepare('INSERT INTO session_usage(user_id,day,seconds,last_seen_ms) VALUES(?,?,0,?)').run(uid, day, now);
    else db.prepare('UPDATE session_usage SET seconds=seconds+?, last_seen_ms=? WHERE user_id=? AND day=?').run(Math.round(Math.min(Math.max(now - row.last_seen_ms, 0), 60000) / 1000), now, uid, day);
    const lim = limitValue(uid, 'session');
    if (lim != null && usedToday.session(uid) >= lim * 60 && !SESSION_EXEMPT.test(req.path)) {
      return next(new ApiError(403, 'session_time_limit_reached', 'you have reached your daily session time limit', `limit ${lim} minutes per day; resets at 00:00 UTC`));
    }
    next();
  }

  // Two-factor login (TOTP) routes and the login gate moved to server/auth.js (CLONE_SPEC §22); totp() stays here.

  // ======================= social =======================
  const profile = (uid) => db.prepare('SELECT * FROM social_profiles WHERE user_id=?').get(uid);
  const byNick = (n) => db.prepare('SELECT * FROM social_profiles WHERE nickname=?').get(String(n || ''));
  function profileVo(p, viewer) {
    const c = (sql, ...a) => db.prepare(sql).get(...a).c;
    const pnl = db.prepare('SELECT COALESCE(SUM(realized_pnl_cents),0) c FROM positions WHERE user_id=?').get(p.user_id).c;
    const vol = db.prepare('SELECT COALESCE(SUM(count),0) c FROM fills WHERE user_id=?').get(p.user_id).c;
    const vo = {
      nickname: p.nickname, bio: p.bio, share_trades: !!p.share_trades, joined_time: p.created_at,
      followers: c('SELECT COUNT(*) c FROM follows WHERE followee_id=?', p.user_id),
      following: c('SELECT COUNT(*) c FROM follows WHERE follower_id=?', p.user_id),
      posts: c('SELECT COUNT(*) c FROM posts WHERE user_id=?', p.user_id),
      is_following: viewer ? !!db.prepare('SELECT 1 FROM follows WHERE follower_id=? AND followee_id=?').get(viewer, p.user_id) : false,
      is_me: viewer === p.user_id,
      metrics: { realized_pnl_dollars: dollars(pnl), volume_fp: ufp(vol), trades: c('SELECT COUNT(*) c FROM fills WHERE user_id=?', p.user_id) },
    };
    for (const h of hooks.profileVo) h(vo, p, viewer);
    return vo;
  }
  v1.get('/users/:uid/social/profile', requireUser, (req, res) => {
    const p = profile(req.auth.user.id);
    res.json({ profile: p ? profileVo(p, req.auth.user.id) : null });
  });
  v1.post('/users/:uid/social/profile', requireUser, (req, res) => {
    const b = req.body || {};
    const cur = profile(req.auth.user.id);
    const nickname = b.nickname === undefined && cur ? cur.nickname : String(b.nickname || '').trim();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(nickname)) throw E.badRequest('nickname must be 3-20 letters, digits or underscores');
    const other = byNick(nickname);
    if (other && other.user_id !== req.auth.user.id) throw E.conflict('nickname_taken', 'that nickname is taken');
    const bio = String(b.bio ?? cur?.bio ?? '').trim();
    if (bio.length > 280) throw E.badRequest('bio must be at most 280 characters');
    const share = b.share_trades === undefined ? (cur ? cur.share_trades : 1) : (b.share_trades ? 1 : 0);
    db.prepare('INSERT INTO social_profiles(user_id,nickname,bio,share_trades,created_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET nickname=excluded.nickname, bio=excluded.bio, share_trades=excluded.share_trades')
      .run(req.auth.user.id, nickname, bio, share, nowIso());
    res.status(cur ? 200 : 201).json({ profile: profileVo(profile(req.auth.user.id), req.auth.user.id) });
  });
  v1.get('/social/profile', (req, res) => {
    const p = byNick(req.query.nickname);
    if (!p) throw E.notFound();
    res.json({ profile: profileVo(p, req.auth?.user.id) });
  });
  v1.get('/social/profile/holdings', (req, res) => {
    const p = byNick(req.query.nickname);
    if (!p) throw E.notFound();
    if (!p.share_trades) return res.json({ holdings: [], hidden: true });
    const rows = db.prepare('SELECT p.*, m.yes_sub_title, m.event_ticker, e.title et FROM positions p JOIN markets m ON m.ticker=p.market_ticker JOIN events e ON e.ticker=m.event_ticker WHERE p.user_id=? AND (p.yes_count>0 OR p.no_count>0) ORDER BY p.updated_at DESC').all(p.user_id);
    res.json({ holdings: rows.map((r) => ({ market_ticker: r.market_ticker, event_ticker: r.event_ticker, event_title: r.et, outcome: r.yes_sub_title, side: r.yes_count > 0 ? 'yes' : 'no', position_fp: ufp(r.yes_count || r.no_count), link: eventLink(r.market_ticker) })) });
  });

  const postVo = (p, viewer) => {
    const author = profile(p.user_id);
    const ev = p.event_ticker ? getEvent(p.event_ticker) : null;
    const vo = {
      id: p.id, body: p.body, created_time: new Date(p.created_ts).toISOString(),
      author: { nickname: author ? author.nickname : 'unknown' },
      event: ev ? { event_ticker: ev.ticker, title: ev.title, link: eventLink(ev.ticker) } : null,
      like_count: db.prepare('SELECT COUNT(*) c FROM post_likes WHERE post_id=?').get(p.id).c,
      comment_count: db.prepare('SELECT COUNT(*) c FROM comments WHERE post_id=?').get(p.id).c,
      liked: viewer ? !!db.prepare('SELECT 1 FROM post_likes WHERE post_id=? AND user_id=?').get(p.id, viewer) : false,
      bookmarked: viewer ? !!db.prepare('SELECT 1 FROM post_bookmarks WHERE post_id=? AND user_id=?').get(p.id, viewer) : false,
      is_mine: viewer === p.user_id,
    };
    for (const h of hooks.postVo) h(vo, p, viewer);
    return vo;
  };
  v1.get('/social/posts', (req, res) => {
    const viewer = req.auth?.user.id || null;
    const feed = String(req.query.feed || 'all');
    const feeds = ['all', 'following', 'bookmarks', ...hooks.feeds];
    if (!feeds.includes(feed)) throw E.badRequest(`feed must be ${feeds.join(', ')}`);
    if (feed !== 'all' && !viewer) throw E.unauthorized();
    const where = []; const args = [];
    if (feed === 'following') { where.push('p.user_id IN (SELECT followee_id FROM follows WHERE follower_id=?)'); args.push(viewer); }
    if (feed === 'bookmarks') { where.push('p.id IN (SELECT post_id FROM post_bookmarks WHERE user_id=?)'); args.push(viewer); }
    if (req.query.event_ticker) { where.push('p.event_ticker=?'); args.push(String(req.query.event_ticker)); }
    if (req.query.nickname) { const pr = byNick(req.query.nickname); where.push('p.user_id=?'); args.push(pr ? pr.user_id : '-'); }
    if (hooks.feedFilter) hooks.feedFilter({ feed, viewer, where, args, req }); // mutes, circle-only visibility, topic feed
    const cur = decCursor(req.query.cursor);
    const off = cur ? cur.o : 0;
    const rows = db.prepare(`SELECT p.* FROM posts p ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.created_ts DESC, p.rowid DESC LIMIT 21 OFFSET ?`).all(...args, off);
    res.json({ posts: rows.slice(0, 20).map((p) => postVo(p, viewer)), cursor: rows.length > 20 ? encCursor({ o: off + 20 }) : '' });
  });
  v1.get('/social/posts/:pid', (req, res) => {
    const p = db.prepare('SELECT * FROM posts WHERE id=?').get(req.params.pid);
    if (!p || (hooks.canView && !hooks.canView(p, req.auth?.user.id || null))) throw E.notFound();
    res.json({ post: postVo(p, req.auth?.user.id) });
  });
  const requireProfile = (uid) => { const p = profile(uid); if (!p) throw E.conflict('social_profile_required', 'create a social profile (nickname) first'); return p; };
  const textBody = (b, max) => {
    const s = String((b && b.body) || '').trim();
    if (!s) throw E.badRequest('body is required');
    if (s.length > max) throw E.badRequest(`body must be at most ${max} characters`);
    return s;
  };
  v1.post('/users/:uid/social/posts', requireUser, (req, res) => {
    const me = requireProfile(req.auth.user.id);
    const ext = hooks.beforePost ? hooks.beforePost(req, me) : null; // body rules, sticker, verified position tag, visibility
    const body = ext ? ext.body : textBody(req.body, 500);
    const et = req.body.event_ticker ? String(req.body.event_ticker) : null;
    if (et && !getEvent(et)) throw E.notFound();
    const id = newId('p_');
    tx(db, () => {
      db.prepare('INSERT INTO posts(id,user_id,event_ticker,body,created_ts) VALUES(?,?,?,?,?)').run(id, req.auth.user.id, et, body, Date.now());
      if (hooks.afterPost) hooks.afterPost(db.prepare('SELECT * FROM posts WHERE id=?').get(id), ext, me);
    });
    const post = db.prepare('SELECT * FROM posts WHERE id=?').get(id);
    for (const f of db.prepare('SELECT follower_id FROM follows WHERE followee_id=?').all(req.auth.user.id)) {
      if (hooks.canView && !hooks.canView(post, f.follower_id)) continue; // circle-only posts reach circle members only
      notify(f.follower_id, { type: 'social_post', title: `@${me.nickname} posted`, body: (body || 'Sticker').slice(0, 120), link: `/social/post/${encodeURIComponent(id)}`, actor: req.auth.user.id });
    }
    if (hooks.afterPostNotify) hooks.afterPostNotify(post, ext, me); // topic followers
    res.status(201).json({ post: postVo(post, req.auth.user.id) });
  });
  const ownPost = (req) => {
    const p = db.prepare('SELECT * FROM posts WHERE id=?').get(req.params.pid);
    if (!p || (hooks.canView && !hooks.canView(p, req.auth?.user.id || null))) throw E.notFound(); // circle-only posts: members only
    return p;
  };
  v1.delete('/users/:uid/social/posts/:pid', requireUser, (req, res) => {
    const p = ownPost(req);
    if (p.user_id !== req.auth.user.id && !req.auth.user.is_admin) throw E.forbidden('you can only delete your own posts');
    db.prepare('DELETE FROM posts WHERE id=?').run(p.id);
    res.json({ ok: true });
  });
  v1.post('/users/:uid/social/posts/:pid/like', requireUser, (req, res) => {
    const p = ownPost(req);
    const r = db.prepare('INSERT INTO post_likes(post_id,user_id,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(p.id, req.auth.user.id, nowIso());
    const me = profile(req.auth.user.id);
    if (r.changes && p.user_id !== req.auth.user.id) notify(p.user_id, { type: 'social_like', title: `${me ? '@' + me.nickname : 'Someone'} liked your post`, body: p.body.slice(0, 120), link: `/social/post/${encodeURIComponent(p.id)}`, actor: req.auth.user.id });
    res.json({ post: postVo(p, req.auth.user.id) });
  });
  v1.delete('/users/:uid/social/posts/:pid/unlike', requireUser, (req, res) => {
    const p = ownPost(req);
    db.prepare('DELETE FROM post_likes WHERE post_id=? AND user_id=?').run(p.id, req.auth.user.id);
    res.json({ post: postVo(p, req.auth.user.id) });
  });
  v1.post('/users/:uid/social/posts/:pid/bookmark', requireUser, (req, res) => {
    const p = ownPost(req);
    db.prepare('INSERT INTO post_bookmarks(post_id,user_id,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(p.id, req.auth.user.id, nowIso());
    res.json({ post: postVo(p, req.auth.user.id) });
  });
  v1.delete('/users/:uid/social/posts/:pid/bookmark', requireUser, (req, res) => {
    const p = ownPost(req);
    db.prepare('DELETE FROM post_bookmarks WHERE post_id=? AND user_id=?').run(p.id, req.auth.user.id);
    res.json({ post: postVo(p, req.auth.user.id) });
  });
  const commentVo = (c, viewer) => {
    const vo = { id: c.id, body: c.body, created_time: new Date(c.created_ts).toISOString(), author: { nickname: profile(c.user_id)?.nickname || 'unknown' }, is_mine: viewer === c.user_id };
    for (const h of hooks.commentVo) h(vo, c, viewer);
    return vo;
  };
  v1.get('/social/posts/:pid/comments', (req, res) => {
    const p = ownPost(req);
    const viewer = req.auth?.user.id;
    res.json({ comments: db.prepare('SELECT * FROM comments WHERE post_id=? ORDER BY created_ts, rowid').all(p.id).filter((c) => !hooks.commentFilter || hooks.commentFilter(c, viewer)).map((c) => commentVo(c, viewer)) });
  });
  v1.post('/users/:uid/social/posts/:pid/comments', requireUser, (req, res) => {
    const me = requireProfile(req.auth.user.id);
    const p = ownPost(req);
    const ext = hooks.beforeComment ? hooks.beforeComment(req, me) : null; // body rules + sticker
    const body = ext ? ext.body : textBody(req.body, 300);
    const id = newId('c_');
    tx(db, () => {
      db.prepare('INSERT INTO comments(id,post_id,user_id,body,created_ts) VALUES(?,?,?,?,?)').run(id, p.id, req.auth.user.id, body, Date.now());
      if (hooks.afterComment) hooks.afterComment(id, ext);
    });
    if (p.user_id !== req.auth.user.id) notify(p.user_id, { type: 'social_comment', title: `@${me.nickname} replied to your post`, body: (body || 'Sticker').slice(0, 120), link: `/social/post/${encodeURIComponent(p.id)}`, actor: req.auth.user.id });
    res.status(201).json({ comment: commentVo(db.prepare('SELECT * FROM comments WHERE id=?').get(id), req.auth.user.id) });
  });
  v1.delete('/users/:uid/social/posts/:pid/comments/:cid', requireUser, (req, res) => {
    const c = db.prepare('SELECT * FROM comments WHERE id=? AND post_id=?').get(req.params.cid, req.params.pid);
    if (!c) throw E.notFound();
    if (c.user_id !== req.auth.user.id && !req.auth.user.is_admin) throw E.forbidden('you can only delete your own comments');
    db.prepare('DELETE FROM comments WHERE id=?').run(c.id);
    res.json({ ok: true });
  });
  v1.post('/users/:uid/social/follow', requireUser, (req, res) => {
    const me = requireProfile(req.auth.user.id);
    const t = byNick(req.body && req.body.nickname);
    if (!t) throw E.notFound();
    if (t.user_id === req.auth.user.id) throw E.badRequest('you cannot follow yourself');
    const r = db.prepare('INSERT INTO follows(follower_id,followee_id,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(req.auth.user.id, t.user_id, nowIso());
    if (r.changes) notify(t.user_id, { type: 'social_follow', title: `@${me.nickname} followed you`, link: `/social/profile/${me.nickname}`, actor: req.auth.user.id });
    res.json({ profile: profileVo(t, req.auth.user.id) });
  });
  v1.delete('/users/:uid/social/follow', requireUser, (req, res) => {
    const t = byNick(req.query.nickname);
    if (!t) throw E.notFound();
    db.prepare('DELETE FROM follows WHERE follower_id=? AND followee_id=?').run(req.auth.user.id, t.user_id);
    res.json({ profile: profileVo(t, req.auth.user.id) });
  });
  v1.get('/social/leaderboard', (req, res) => {
    const metric = String(req.query.metric || 'pnl');
    if (!['pnl', 'volume'].includes(metric)) throw E.badRequest('metric must be pnl or volume');
    const sql = metric === 'pnl'
      ? 'SELECT sp.nickname, COALESCE((SELECT SUM(realized_pnl_cents) FROM positions WHERE user_id=sp.user_id),0) v FROM social_profiles sp ORDER BY v DESC, sp.nickname LIMIT 25'
      : 'SELECT sp.nickname, COALESCE((SELECT SUM(count) FROM fills WHERE user_id=sp.user_id),0) v FROM social_profiles sp ORDER BY v DESC, sp.nickname LIMIT 25';
    res.json({ metric, leaders: db.prepare(sql).all().map((r, i) => ({ rank: i + 1, nickname: r.nickname, value: metric === 'pnl' ? dollars(r.v) : ufp(r.v) })) });
  });
  // Recent trades with trader nicknames (spec §13.5: /v1/social/trades?series_ticker=…).
  v1.get('/social/trades', (req, res) => {
    const where = []; const args = [];
    if (req.query.market_ticker) { where.push('t.market_ticker=?'); args.push(String(req.query.market_ticker)); }
    if (req.query.event_ticker) { where.push('m.event_ticker=?'); args.push(String(req.query.event_ticker)); }
    if (req.query.series_ticker) { where.push('e.series_ticker=?'); args.push(String(req.query.series_ticker)); }
    const cur = decCursor(req.query.cursor);
    const off = cur ? cur.o : 0;
    const rows = db.prepare(`SELECT t.*, m.yes_sub_title FROM trades t JOIN markets m ON m.ticker=t.market_ticker JOIN events e ON e.ticker=m.event_ticker ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.created_ts DESC, t.rowid DESC LIMIT 51 OFFSET ?`).all(...args, off);
    const nickFor = (tradeId, taker) => {
      const f = db.prepare('SELECT sp.nickname, sp.share_trades FROM fills f JOIN social_profiles sp ON sp.user_id=f.user_id WHERE f.trade_id=? AND f.is_taker=?').get(tradeId, taker ? 1 : 0);
      return f && f.share_trades ? f.nickname : '';
    };
    res.json({
      trades: rows.slice(0, 50).map((t) => ({ trade_id: t.id, ticker: t.market_ticker, outcome: t.yes_sub_title, price_dollars: dollars(t.yes_price_cents), count_fp: ufp(t.count), taker_side: t.taker_side, taker_nickname: nickFor(t.id, true), maker_nickname: nickFor(t.id, false), create_date: new Date(t.created_ts).toISOString() })),
      cursor: rows.length > 50 ? encCursor({ o: off + 50 }) : '',
    });
  });
  v1.get('/social/top_holders', (req, res) => {
    const t = String(req.query.market_ticker || '');
    if (!db.prepare('SELECT 1 FROM markets WHERE ticker=?').get(t)) throw E.notFound();
    const side = (col) => db.prepare(`SELECT sp.nickname, p.${col} n FROM positions p JOIN social_profiles sp ON sp.user_id=p.user_id WHERE p.market_ticker=? AND p.${col}>0 AND sp.share_trades=1 ORDER BY p.${col} DESC LIMIT 10`).all(t).map((r) => ({ nickname: r.nickname, position_fp: ufp(r.n) }));
    res.json({ yes: side('yes_count'), no: side('no_count') });
  });

  // ======================= categories + calendar =======================
  const tagsByCategory = () => {
    const out = Object.fromEntries(CATEGORIES.map((c) => [c, new Set()]));
    for (const s of db.prepare('SELECT category, tags FROM series').all()) for (const t of JSON.parse(s.tags)) (out[s.category] ||= new Set()).add(t);
    return out;
  };
  v1.get('/categories', (req, res) => {
    const tags = tagsByCategory();
    res.json({ categories: CATEGORIES.map((c) => ({ name: c, slug: c.toLowerCase().replace(/[^a-z0-9]+/g, '-'), subcategories: [...tags[c]].sort() })) });
  });
  // Calendar card feed (spec §13.4): a live section first, then one section per date (earliest open market close).
  v1.get('/calendar', (req, res) => {
    const cat = req.query.category ? String(req.query.category) : null;
    if (cat && !CATEGORIES.some((c) => c.toLowerCase() === cat.toLowerCase())) throw E.badRequest('unknown category');
    const evs = db.prepare("SELECT * FROM events WHERE series_ticker<>'PLXCOMBO' ORDER BY rowid").all().map(eventFull)
      .filter((e) => e.markets.some((m) => ['active', 'initialized', 'inactive'].includes(m.status)));
    const counts = {};
    let all = { count: 0, live_count: 0 };
    for (const e of evs) {
      const c = (counts[e.category] ||= { count: 0, live_count: 0 });
      c.count += 1; all.count += 1;
      if (e.is_live) { c.live_count += 1; all.live_count += 1; }
    }
    const shown = cat ? evs.filter((e) => e.category.toLowerCase() === cat.toLowerCase()) : evs;
    const dateOf = (e) => {
      const ms = e.markets.filter((m) => m.status !== 'finalized').map((m) => Date.parse(m.status === 'initialized' ? m.open_time : m.close_time));
      return dayKey(Math.min(...ms));
    };
    const today = dayKey();
    const sections = [];
    const live = shown.filter((e) => e.is_live);
    if (live.length) sections.push({ section_key: `${today}:live`, group_type: 'date', date: today, is_live: true, events: live });
    const byDate = new Map();
    for (const e of shown.filter((x) => !x.is_live)) { const d = dateOf(e); if (!byDate.has(d)) byDate.set(d, []); byDate.get(d).push(e); }
    for (const d of [...byDate.keys()].sort()) sections.push({ section_key: d, group_type: 'date', date: d, is_live: false, events: byDate.get(d) });
    for (const s of sections) s.event_limits = eventLimits(s.events); // recurring families capped per section (Phase 5B)
    res.json({ sections, filters: { categories: counts, all }, total_count: shown.length, next_cursor: '' });
  });

  // ======================= interest (spec §15.4 "3.5% Interest") =======================
  // Design choice: once per UTC day, credit cash + open-position cost basis × APY / 365, rounded to the cent.
  db.exec('CREATE TABLE IF NOT EXISTS interest_accruals (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL, base_cents INTEGER NOT NULL, amount_cents INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, day))');
  // APY is editable in the admin settings (server/admin.js stores it in meta 'setting_interest_apy'); default 3.5%.
  const apyNow = () => { const r = db.prepare("SELECT value FROM meta WHERE key='setting_interest_apy'").get(); const n = r ? Number(r.value) : NaN; return Number.isFinite(n) ? n : 0.035; };
  let lastDay = null;
  function accrueInterest() {
    const day = dayKey();
    // Accounts start earning the day after they are created (keeps a day's balance stable once credited).
    if (lastDay === day && !db.prepare("SELECT 1 FROM users u WHERE is_system=0 AND substr(created_at,1,10)<? AND NOT EXISTS (SELECT 1 FROM interest_accruals a WHERE a.user_id=u.id AND a.day=?) LIMIT 1").get(day, day)) return;
    lastDay = day;
    const APY = apyNow();
    for (const u of db.prepare('SELECT id, balance_cents FROM users u WHERE is_system=0 AND substr(created_at,1,10)<? AND NOT EXISTS (SELECT 1 FROM interest_accruals a WHERE a.user_id=u.id AND a.day=?)').all(day, day)) {
      const pos = db.prepare('SELECT COALESCE(SUM(yes_cost_cents+no_cost_cents),0) c FROM positions WHERE user_id=?').get(u.id).c;
      const base = Math.max(0, u.balance_cents) + pos;
      const amt = Math.round((base * APY) / 365);
      tx(db, () => {
        db.prepare('INSERT INTO interest_accruals(user_id,day,base_cents,amount_cents,created_at) VALUES(?,?,?,?,?)').run(u.id, day, base, amt, nowIso());
        if (amt > 0) engine.credit(u.id, amt, 'interest', day, `${(APY * 100).toFixed(1)}% APY interest`);
      });
      if (amt > 0) engine.emit('user_balance', u.id, engine.balance(u.id));
    }
  }
  engine.on('tick', () => { try { accrueInterest(); } catch (e) { console.error('interest', e); } });
  v1.get('/users/:uid/interest', requireUser, (req, res) => {
    const rows = db.prepare('SELECT * FROM interest_accruals WHERE user_id=? ORDER BY day DESC LIMIT 30').all(req.auth.user.id);
    res.json({ apy: String(apyNow()), total_dollars: dollars(rows.reduce((a, r) => a + r.amount_cents, 0)), accruals: rows.map((r) => ({ day: r.day, base_dollars: dollars(r.base_cents), amount_dollars: dollars(r.amount_cents) })) });
  });

  return { notify, checkDeposit, checkTrading, sessionMiddleware, CATEGORIES, hooks, postVo, commentVo, profileVo, eventLink };
}

module.exports = { mountFeatures, totp, verifyTotp, b32encode, CATEGORIES };
