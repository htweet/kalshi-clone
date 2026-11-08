'use strict';
// Share and copy-trade links (PLAN P8.2, CLONE_SPEC.md §38.3). Flags `share_links` and `copy_trade` (child).
//
//   link       a market, an event, the sharer's own position or one of their own trades. Stored server-side; the URL is
//              /s/<id>.<sig>: a 128-bit random id (not enumerable) and an HMAC-SHA256 signature (key `share-link:v1`), so a
//              forged or altered token fails before any lookup. The sharer revokes it (owner route); admins can too.
//   landing    GET /s/<token>: counts the open (per-IP limit, an owner setting), sets first-party attribution cookies
//              (`plx_share`, and `plx_ref` with the sharer's Predictions referral code while referrals are on) and answers
//              302 to a path the server builds from the stored tickers — never from the request — so it cannot be an open
//              redirect. Unknown, revoked or switched-off links land on the home page.
//   shown      what the sharer chose: side always; price and size only when ticked. GET /v1/share/<token> is public and
//              returns only those fields; GET /v1/share/<token>/copy (flag copy_trade) returns the ticket prefill.
//   copy       the event page pre-fills the ticket (market, side, limit price, size when shown) and says so; it never
//              places an order by itself — the visitor reviews and submits like any order.
//   channels   WhatsApp first (the main sharing channel in Nigeria), then X, Facebook, Telegram and copy-link: plain share
//              URLs built on the client; nothing is called from the server.
//   counts     opens and sign-ups attributed to each link (the `plx_share` cookie read at sign-up), on the sharer's list
//              and in Admin › Growth.
const crypto = require('node:crypto');
const kc = require('./crypto');
const { newId, ApiError, E, ufp } = require('./util');
const P = require('./pricing');
const { createLimiter } = require('./content-rate');
const { check } = require('./validate');
const { s: GS } = require('./content/growth');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS share_links (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, event_ticker TEXT NOT NULL,
  market_ticker TEXT, fill_id TEXT, side TEXT, price_cc INTEGER, count_units INTEGER, show_price INTEGER NOT NULL DEFAULT 0, show_size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', clicks INTEGER NOT NULL DEFAULT 0, signups INTEGER NOT NULL DEFAULT 0, created_ts INTEGER NOT NULL, revoked_ts INTEGER, revoked_by TEXT, last_click_ts INTEGER);
CREATE INDEX IF NOT EXISTS idx_share_links_user ON share_links(user_id, created_ts);
CREATE TABLE IF NOT EXISTS share_clicks (id INTEGER PRIMARY KEY AUTOINCREMENT, link_id TEXT NOT NULL, ts INTEGER NOT NULL, ip_hash TEXT NOT NULL, counted INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_share_clicks_link ON share_clicks(link_id, ts);
CREATE TABLE IF NOT EXISTS share_attributions (link_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, ts INTEGER NOT NULL, PRIMARY KEY (link_id, user_id));
`;
const KINDS = ['market', 'event', 'position', 'trade'];
const TOKEN_RE = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/;
const COOKIE_DAYS = 30;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}

function mountShareLinks({ v1, db, engine, auth, admin, flags, security, keyDir, referrals, options = {} }) {
  db.exec(SCHEMA);
  const key = kc.deriveKey('share-link:v1', { dir: keyDir });
  const ipKey = kc.deriveKey('share-ip:v1', { dir: keyDir });
  const sign = (id) => crypto.createHmac('sha256', key).update(`share:${id}`).digest('base64url').slice(0, 22);
  const tokenOf = (id) => `${id}.${sign(id)}`;
  // Verifies the signature first (constant time), then loads the row.
  function linkOf(token) {
    const m = TOKEN_RE.exec(String(token || ''));
    if (!m || !kc.safeEqual(m[2], sign(m[1]))) return null;
    return db.prepare('SELECT * FROM share_links WHERE id=?').get(m[1]) || null;
  }
  const OS = engine.ownerSettings;
  const ipOf = (req) => (security && security.clientIp ? security.clientIp(req) : req.ip) || '';
  const ipHash = (req) => kc.hmacHex(ipKey, String(ipOf(req))).slice(0, 32);
  const createLimit = createLimiter(db, 'share_create', { limit: Number(options.createsPer10Min || 30), windowMs: 600000 });
  const can = admin.can;
  const requireOwner = (req, res, next) => { if (!req.auth) return next(E.unauthorized()); if (req.params.uid !== req.auth.user.id) return next(E.forbidden('cannot access another user')); next(); };

  const eventRow = (t) => db.prepare('SELECT e.ticker, e.title, e.series_ticker, s.slug FROM events e JOIN series s ON s.ticker=e.series_ticker WHERE e.ticker=?').get(String(t || ''));
  const marketRow = (t) => db.prepare('SELECT ticker, event_ticker, yes_sub_title, title, status FROM markets WHERE ticker=?').get(String(t || ''));
  // The landing path: built only from stored tickers (encoded), always a site path.
  function pathOf(l, token = null) {
    const ev = eventRow(l.event_ticker);
    if (!ev) return '/';
    const q = new URLSearchParams();
    if (l.market_ticker) q.set('market', l.market_ticker);
    if (l.side && (l.kind === 'position' || l.kind === 'trade')) q.set('side', l.side);
    if (token && (l.kind === 'position' || l.kind === 'trade')) q.set('s', token);
    const qs = q.toString();
    return `/markets/${encodeURIComponent(ev.series_ticker.toLowerCase())}/${encodeURIComponent(ev.slug)}/${encodeURIComponent(ev.ticker.toLowerCase())}${qs ? `?${qs}` : ''}`;
  }
  const sharerName = (uid) => {
    const u = db.prepare('SELECT display_name FROM users WHERE id=?').get(uid);
    let nick = null;
    try { nick = db.prepare('SELECT nickname FROM social_profiles WHERE user_id=?').get(uid)?.nickname || null; } catch { /* no social module */ }
    return nick ? `@${nick}` : (u ? String(u.display_name).split(/\s+/)[0] : GS('share.someone'));
  };
  // What a visitor may see: the sharer's choices only.
  function publicVo(l, token) {
    const ev = eventRow(l.event_ticker); const m = l.market_ticker ? marketRow(l.market_ticker) : null;
    const vo = { kind: l.kind, status: l.status, event_ticker: l.event_ticker, market_ticker: l.market_ticker, title: ev ? ev.title : '', outcome: m ? m.yes_sub_title : null, path: pathOf(l, token), sharer: l.kind === 'position' || l.kind === 'trade' ? sharerName(l.user_id) : null };
    if (l.kind === 'position' || l.kind === 'trade') {
      vo.side = l.side;
      if (l.show_price && l.price_cc != null) { vo.price_dollars = P.ccToDollars(l.price_cc); vo.price_cc = l.price_cc; }
      if (l.show_size && l.count_units != null) vo.count_fp = ufp(l.count_units);
    }
    return vo;
  }
  const ownerVo = (l) => ({ id: l.id, token: tokenOf(l.id), url_path: `/s/${tokenOf(l.id)}`, kind: l.kind, event_ticker: l.event_ticker, market_ticker: l.market_ticker, side: l.side, show_price: !!l.show_price, show_size: !!l.show_size,
    status: l.status, clicks: l.clicks, signups: l.signups, created_time: new Date(l.created_ts).toISOString(), revoked_time: l.revoked_ts ? new Date(l.revoked_ts).toISOString() : null, title: eventRow(l.event_ticker)?.title || '' });

  // ---------------------------------------------------------------- owner routes
  const BODY = { kind: { type: 'string', enum: KINDS, required: true }, ticker: { type: 'string', maxLen: 80 }, fill_id: { type: 'string', maxLen: 80 }, show_price: { type: 'boolean' }, show_size: { type: 'boolean' } };
  v1.post('/users/:uid/share_links', requireOwner, (req, res) => {
    const b = check(req.body || {}, BODY, { unknown: 'reject' });
    const uid = req.auth.user.id;
    try { createLimit.hit(uid); } catch { throw new ApiError(429, 'too_many_requests', GS('error.share_limit')); }
    const row = { kind: b.kind, event_ticker: null, market_ticker: null, fill_id: null, side: null, price_cc: null, count_units: null, show_price: 0, show_size: 0 };
    if (b.kind === 'event') { const ev = eventRow(String(b.ticker || '').toUpperCase()); if (!ev) throw new ApiError(404, 'share_target', GS('error.share_target')); row.event_ticker = ev.ticker; }
    if (b.kind === 'market' || b.kind === 'position') {
      const m = marketRow(String(b.ticker || '').toUpperCase());
      if (!m) throw new ApiError(404, 'share_target', GS('error.share_target'));
      row.event_ticker = m.event_ticker; row.market_ticker = m.ticker;
      if (b.kind === 'position') {
        const p = db.prepare('SELECT yes_count, no_count, yes_cost_cents, no_cost_cents FROM positions WHERE user_id=? AND market_ticker=?').get(uid, m.ticker);
        if (!p || (!(p.yes_count > 0) && !(p.no_count > 0))) throw new ApiError(403, 'share_not_yours', GS('error.share_not_yours'));
        row.side = p.yes_count > 0 ? 'yes' : 'no';
        row.count_units = p.yes_count || p.no_count;
        const cost = row.side === 'yes' ? p.yes_cost_cents : p.no_cost_cents;
        row.price_cc = row.count_units ? Math.round((cost * P.UNITS * P.CC_PER_CENT) / row.count_units) : null; // average price
      }
    }
    if (b.kind === 'trade') {
      const f = db.prepare('SELECT f.*, m.event_ticker FROM fills f JOIN markets m ON m.ticker=f.market_ticker WHERE f.id=?').get(String(b.fill_id || ''));
      if (!f || f.user_id !== uid) throw new ApiError(403, 'share_not_yours', GS('error.share_not_yours')); // someone else's fill: the same answer as none
      Object.assign(row, { event_ticker: f.event_ticker, market_ticker: f.market_ticker, fill_id: f.id, side: f.side, price_cc: f.price_cc, count_units: f.count });
    }
    if (b.kind === 'position' || b.kind === 'trade') { row.show_price = b.show_price === false ? 0 : 1; row.show_size = b.show_size === true ? 1 : 0; }
    const id = crypto.randomBytes(16).toString('base64url');
    db.prepare('INSERT INTO share_links(id,user_id,kind,event_ticker,market_ticker,fill_id,side,price_cc,count_units,show_price,show_size,status,created_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, uid, row.kind, row.event_ticker, row.market_ticker, row.fill_id, row.side, row.price_cc, row.count_units, row.show_price, row.show_size, 'active', Date.now());
    const l = db.prepare('SELECT * FROM share_links WHERE id=?').get(id);
    res.status(201).json({ share_link: { ...ownerVo(l), public: publicVo(l, tokenOf(id)) } });
  });
  v1.get('/users/:uid/share_links', requireOwner, (req, res) => res.json({ share_links: db.prepare('SELECT * FROM share_links WHERE user_id=? ORDER BY created_ts DESC LIMIT 200').all(req.auth.user.id).map(ownerVo) }));
  v1.delete('/users/:uid/share_links/:id', requireOwner, (req, res) => {
    const l = db.prepare('SELECT * FROM share_links WHERE id=? AND user_id=?').get(String(req.params.id), req.auth.user.id);
    if (!l) throw E.notFound(); // another user's link: not found, never "forbidden" (no enumeration)
    db.prepare("UPDATE share_links SET status='revoked', revoked_ts=?, revoked_by=? WHERE id=? AND status='active'").run(Date.now(), req.auth.user.id, l.id);
    res.json({ share_link: ownerVo(db.prepare('SELECT * FROM share_links WHERE id=?').get(l.id)) });
  });

  // ---------------------------------------------------------------- public reads
  const activeOf = (token) => { const l = linkOf(token); if (!l || l.status !== 'active' || !eventRow(l.event_ticker)) throw new ApiError(404, 'share_gone', GS('error.share_gone')); return l; };
  v1.get('/share/:token', (req, res) => { const l = activeOf(req.params.token); res.setHeader('Cache-Control', 'no-store'); res.json({ share: publicVo(l, req.params.token) }); });
  v1.get('/share/:token/copy', (req, res) => {
    const l = activeOf(req.params.token);
    if (l.kind !== 'position' && l.kind !== 'trade') throw new ApiError(404, 'share_gone', GS('error.share_gone'));
    const m = marketRow(l.market_ticker);
    res.setHeader('Cache-Control', 'no-store');
    // Prefill only: what the sharer chose to show. The client never places an order from this.
    res.json({ copy: { ticker: l.market_ticker, event_ticker: l.event_ticker, side: l.side, price_cc: l.show_price ? l.price_cc : null, count_fp: l.show_size && l.count_units != null ? ufp(l.count_units) : null, market_status: m ? m.status : null, sharer: sharerName(l.user_id), auto_trade: false } });
  });

  // ---------------------------------------------------------------- landing (outside /v1, before the SPA)
  function landing(req, res) {
    const token = String(req.params.token || '');
    const l = flags.jobOn('share_links') ? linkOf(token) : null;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!l || l.status !== 'active' || !eventRow(l.event_ticker)) return res.redirect(302, '/');
    const ih = ipHash(req); const now = Date.now();
    const recent = db.prepare('SELECT COUNT(*) c FROM share_clicks WHERE ip_hash=? AND ts>? AND counted=1').get(ih, now - 60000).c;
    const counted = recent < OS.get('share.clicks_per_ip_per_minute') ? 1 : 0;
    db.prepare('INSERT INTO share_clicks(link_id,ts,ip_hash,counted) VALUES(?,?,?,?)').run(l.id, now, ih, counted);
    if (counted) db.prepare('UPDATE share_links SET clicks=clicks+1, last_click_ts=? WHERE id=?').run(now, l.id);
    const secure = security && security.production ? '; Secure' : '';
    const cookies = [`plx_share=${l.id}; Path=/; Max-Age=${COOKIE_DAYS * 86400}; SameSite=Lax; HttpOnly${secure}`];
    if (referrals && flags.jobOn('referrals.predictions') && referrals.settings().enabled) cookies.push(`plx_ref=${referrals.codeFor(l.user_id)}; Path=/; Max-Age=${COOKIE_DAYS * 86400}; SameSite=Lax${secure}`);
    res.setHeader('Set-Cookie', cookies);
    engine.emit('share_links', { id: l.id, type: 'click' });
    return res.redirect(302, pathOf(l, tokenOf(l.id)));
  }
  function mountStatic(target) { target.get(/^\/s\/([A-Za-z0-9_.-]{1,80})$/, (req, res) => { req.params.token = /^\/s\/(.+)$/.exec(req.path)[1]; landing(req, res); }); }
  // Sign-ups attributed to the link that brought the visitor (first-party cookie set by the landing).
  auth.events.on('signup', ({ user, req }) => {
    try {
      const id = parseCookies(req && req.headers && req.headers.cookie).plx_share;
      if (!id || !/^[A-Za-z0-9_-]{22}$/.test(id)) return;
      const l = db.prepare('SELECT id FROM share_links WHERE id=?').get(id);
      if (!l) return;
      if (db.prepare('INSERT INTO share_attributions(link_id,user_id,ts) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(l.id, user.id, Date.now()).changes) db.prepare('UPDATE share_links SET signups=signups+1 WHERE id=?').run(l.id);
    } catch (e) { console.error('share attribution', e.message); }
  });

  // ---------------------------------------------------------------- admin: Admin › Growth › Share links
  v1.get('/admin/share_links', can('users.read'), (req, res) => {
    const email = (id) => db.prepare('SELECT email FROM users WHERE id=?').get(id)?.email || id;
    const totals = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(signups),0) signups, COALESCE(SUM(CASE WHEN status='active' THEN 1 ELSE 0 END),0) active FROM share_links").get();
    const byKind = Object.fromEntries(db.prepare('SELECT kind, COUNT(*) n, COALESCE(SUM(clicks),0) c FROM share_links GROUP BY kind').all().map((r) => [r.kind, { links: r.n, clicks: r.c }]));
    res.json({ totals, by_kind: byKind, links: db.prepare('SELECT * FROM share_links ORDER BY clicks DESC, created_ts DESC LIMIT 200').all().map((l) => ({ ...ownerVo(l), token: undefined, url_path: undefined, user: email(l.user_id) })) });
  });
  v1.post('/admin/share_links/:id/revoke', can('users.support'), (req, res) => {
    const l = db.prepare('SELECT * FROM share_links WHERE id=?').get(String(req.params.id));
    if (!l) throw E.notFound();
    const reason = String((req.body || {}).reason || '').trim();
    if (reason.length < 3 || reason.length > 500) throw new ApiError(400, 'validation_failed', 'validation failed', 'reason: a reason of 3-500 characters is required');
    db.prepare("UPDATE share_links SET status='revoked', revoked_ts=?, revoked_by=? WHERE id=?").run(Date.now(), req.auth.user.id, l.id);
    admin.audit(req, 'share_links.revoke', 'share_link', l.id, { status: l.status }, { status: 'revoked' }, reason);
    res.json({ share_link: ownerVo(db.prepare('SELECT * FROM share_links WHERE id=?').get(l.id)) });
  });

  return { mountStatic, linkOf, publicVo, tokenOf, pathOf };
}

module.exports = { mountShareLinks };
