'use strict';
// Layout variants (owner requests 2026-11-15, CLONE_SPEC.md §41): the data of the new landing page for visitors and of
// the new member home. Which variant a visitor or a member sees is an owner setting (`layout.home_visitors`,
// `layout.home_members`, server/owner-settings.js); this module only serves the data and the admin controls.
//
//   GET /v1/bff/landing         one bundled call for the landing page: hero slides, Weekly forecasts chips, Markets to
//                               watch, promo cards, the hub card, the Monthly forecast and the category lists. Bounded
//                               queries: event volume comes from the running totals in market_volume (migration 0004),
//                               charts from at most one hourly close per market and hour over 7 days, and the whole
//                               answer is cached for 10 s per variant (signed in / out) unless an admin input changed.
//   GET /v1/bff/member_home     the member home extras: the open 15-minute windows (server/rolling.js) and the member's
//                               onboarding steps and card choices (Customize your view, dismissed cards).
//   Admin › Content › Landing page (content.write): GET /v1/admin/landing, PUT /v1/admin/landing/config,
//                               PUT|DELETE /v1/admin/landing/content/:kind/:ref — every change audited.
// Hero pins are the Hero carousel selection (cms_hero, Admin › Content › Hero carousel), shared with the member home.
const zlib = require('node:zlib');
const { nowIso, E, ApiError, UNITS } = require('./util');
const { marketVo } = require('./serialize');
const P = require('./pricing');
const { plainProblem } = require('./cms/sanitize');
const { CATEGORIES } = require('./features');

const SECTIONS = ['hero', 'ticker', 'watch', 'categories'];
const DEFAULT_CONFIG = { sections: SECTIONS, hidden: [], hero_count: 6, hero_fill_auto: false, chips_auto: true, chip_pins: [], watch_pins: [], monthly: { event_ticker: '', title: '' }, category_count: 4 };
const CONFIG_KEY = 'landing_config';
const DAY = 86400000;
const HALF_LIFE_DAYS = 14;
const CACHE_MS = 10000;
const TICKER = /^[A-Z0-9][A-Z0-9._-]{1,63}$/;

function fieldError(fields) {
  const e = new ApiError(400, 'validation_failed', 'validation failed', Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('; '));
  e.toJSON = () => ({ error: { code: e.code, message: e.message, details: e.details, fields } });
  return e;
}

function mountLanding({ v1, db, engine, admin, flags, getRolling, getAccountArea, getIdentity }) {
  const can = admin.can;
  const cfgRow = () => db.prepare('SELECT value, updated_at FROM admin_settings WHERE key=?').get(CONFIG_KEY);
  function config() {
    const r = cfgRow();
    let v = {};
    if (r) { try { v = JSON.parse(r.value); } catch { v = {}; } }
    return { ...DEFAULT_CONFIG, ...v, monthly: { ...DEFAULT_CONFIG.monthly, ...(v.monthly || {}) } };
  }
  const dollarsOfCc = (cc) => Math.round(Number(cc || 0) / (UNITS * P.CC_PER_CENT) / 100);

  // ------------------------------------------------------------------ candidates: one query over the open catalogue
  function candidates() {
    const now = Date.now();
    return db.prepare(`SELECT e.ticker, e.series_ticker, e.title, e.sub_title, e.category, e.created_at, e.is_live, e.live_label, e.news, s.slug series_slug, s.title series_title,
        COALESCE(SUM(v.dollar_volume_cc), 0) dv, MIN(m.close_time) close_time, COUNT(m.ticker) n
      FROM events e JOIN series s ON s.ticker=e.series_ticker JOIN markets m ON m.event_ticker=e.ticker AND m.status='active' LEFT JOIN market_volume v ON v.market_ticker=m.ticker
      WHERE e.series_ticker <> 'PLXCOMBO' AND e.series_ticker NOT LIKE 'PLXFLASH%' GROUP BY e.ticker`).all()
      .map((r) => {
        const age = Math.max(0, (now - Date.parse(r.created_at || 0)) / DAY);
        // Volume and recency: money traded, halved for every two weeks of the event's age; newest first among equals.
        return { ...r, dollars: dollarsOfCc(r.dv), score: dollarsOfCc(r.dv) / 2 ** (age / HALF_LIFE_DAYS) + 1 / (1 + age) };
      })
      .sort((a, b) => b.score - a.score || String(b.created_at).localeCompare(String(a.created_at)));
  }

  // ------------------------------------------------------------------ per-event data
  const marketsOf = (et) => db.prepare('SELECT * FROM markets WHERE event_ticker=? ORDER BY rowid').all(et);
  const PICK = ['ticker', 'yes_sub_title', 'color_code', 'status', 'market_type', 'floor_strike', 'cap_strike', 'scalar_unit', 'last_price_dollars', 'previous_price_dollars', 'yes_bid_dollars', 'yes_ask_dollars', 'dollar_volume'];
  const fullVo = (m) => { const vo = marketVo(m, engine.quote(m.ticker)); return Object.fromEntries(PICK.filter((k) => vo[k] !== undefined).map((k) => [k, vo[k]])); };
  // A lighter view for lists (the newest trade and the one 24 hours ago: two indexed lookups).
  const lastCc = db.prepare('SELECT yes_price_cc p FROM trades WHERE market_ticker=? ORDER BY created_ts DESC LIMIT 1');
  const atCc = db.prepare('SELECT yes_price_cc p FROM trades WHERE market_ticker=? AND created_ts<=? ORDER BY created_ts DESC LIMIT 1');
  function liteVo(m) {
    const last = lastCc.get(m.ticker)?.p ?? null;
    const prev = atCc.get(m.ticker, Date.now() - DAY)?.p ?? last;
    return { ticker: m.ticker, yes_sub_title: m.yes_sub_title, color_code: m.color, status: m.status, market_type: m.market_type || 'binary', floor_strike: m.floor_strike, cap_strike: m.cap_strike, scalar_unit: m.scalar_unit || '',
      last_price_dollars: P.ccToDollars(last), previous_price_dollars: P.ccToDollars(prev) };
  }
  const priceOf = (vo) => (vo.last_price_dollars != null ? Number(vo.last_price_dollars) : vo.yes_bid_dollars != null && vo.yes_ask_dollars != null ? (Number(vo.yes_bid_dollars) + Number(vo.yes_ask_dollars)) / 2 : -1);
  const ranked = (vos) => vos.filter((m) => m.status === 'active').sort((a, b) => priceOf(b) - priceOf(a));
  // Hourly closes over 7 days: one row per hour at most (the newest trade of each hour), cents with one decimal.
  const hourly = db.prepare('SELECT created_ts / 3600000 h, yes_price_cc p, MAX(created_ts) ts FROM trades WHERE market_ticker=? AND created_ts>=? GROUP BY h ORDER BY h');
  function pointsOf(ticker, lastDollars) {
    const rows = hourly.all(ticker, Date.now() - 7 * DAY);
    const step = Math.max(1, Math.ceil(rows.length / 60)); // at most 60 points a line (2.8 hours each over a full week)
    const pts = rows.filter((_, i) => i % step === 0 || i === rows.length - 1).map((r) => [Math.floor(r.ts / 1000), Math.round(r.p / 10) / 10]);
    if (lastDollars != null && pts.length < 2) pts.push([Math.floor(Date.now() / 1000), Math.round(Number(lastDollars) * 1000) / 10]);
    return pts;
  }
  const mediaOf = (id) => { if (!id) return null; const a = db.prepare("SELECT id, ext, width, height FROM cms_media WHERE id=? AND variant='original'").get(id); return a ? { url: `/media/${a.id}.${a.ext}`, width: a.width, height: a.height } : null; };
  const contentOf = (kind, ref) => db.prepare('SELECT * FROM landing_content WHERE kind=? AND ref=?').get(kind, ref) || null;
  function imageOf(ev) {
    for (const c of [contentOf('event', ev.ticker), contentOf('series', ev.series_ticker)]) {
      const img = c && mediaOf(c.image_asset_id);
      if (img) return { ...img, alt: c.image_alt || '' };
    }
    return null;
  }
  function contextOf(ev) {
    const own = contentOf('event', ev.ticker)?.context || contentOf('series', ev.series_ticker)?.context;
    if (own) return { text: own, source: 'admin' };
    const n = db.prepare('SELECT headline, summary FROM cms_news WHERE event_ticker=? AND active=1 ORDER BY published_at DESC, position LIMIT 1').get(ev.ticker);
    if (n) return { text: n.summary ? `${n.headline}. ${n.summary}` : n.headline, source: 'news' };
    if (ev.news) return { text: ev.news, source: 'news' };
    const rules = db.prepare("SELECT rules_primary r FROM markets WHERE event_ticker=? AND rules_primary<>'' ORDER BY rowid LIMIT 1").get(ev.ticker)?.r || '';
    return { text: [ev.sub_title, rules].filter(Boolean).join('. '), source: 'event' };
  }
  const iconColor = (t) => db.prepare('SELECT icon_color FROM cms_event_meta WHERE event_ticker=?').get(t)?.icon_color || '';
  const base = (ev) => ({ event_ticker: ev.ticker, series_ticker: ev.series_ticker, series_slug: ev.series_slug, series_title: ev.series_title, title: ev.title, category: ev.category, close_time: ev.close_time,
    is_live: !!ev.is_live, live_label: ev.live_label || '', dollar_volume: ev.dollars, icon_color: iconColor(ev.ticker) });
  function rich(ev, n) {
    const ms = ranked(marketsOf(ev.ticker).map(fullVo)).slice(0, n);
    return { ...base(ev), image: imageOf(ev), context: contextOf(ev).text, markets: ms.map((m) => ({ ...m, points: pointsOf(m.ticker, m.last_price_dollars) })) };
  }
  const lead = (ev) => ranked(marketsOf(ev.ticker).map(liteVo))[0] || null;

  // ------------------------------------------------------------------ the landing payload
  function heroEvents(cands, cfg) {
    const byT = new Map(cands.map((c) => [c.ticker, c]));
    const pins = db.prepare('SELECT event_ticker FROM cms_hero ORDER BY position').all().map((r) => byT.get(r.event_ticker)).filter(Boolean);
    const excluded = new Set(db.prepare("SELECT ref FROM landing_content WHERE kind='event' AND hero_exclude=1").all().map((r) => r.ref));
    const xSeries = new Set(db.prepare("SELECT ref FROM landing_content WHERE kind='series' AND hero_exclude=1").all().map((r) => r.ref));
    const auto = cands.filter((c) => !excluded.has(c.ticker) && !xSeries.has(c.series_ticker) && !pins.includes(c));
    const list = pins.length && !cfg.hero_fill_auto ? pins : [...pins, ...auto];
    return { list: list.slice(0, Math.max(pins.length, cfg.hero_count)), pinned: new Set(pins.map((p) => p.ticker)) };
  }
  function chips(cands, cfg) {
    const out = []; const seen = new Set();
    const chipOf = (ev, vo, label, pinned) => ({ ...base(ev), label: label || ev.title.replace(/\?$/, ''), pinned, market: vo });
    for (const p of cfg.chip_pins) {
      const m = db.prepare('SELECT * FROM markets WHERE ticker=?').get(p.market_ticker);
      if (!m || m.status !== 'active') continue;
      const ev = cands.find((c) => c.ticker === m.event_ticker);
      if (!ev) continue;
      out.push(chipOf(ev, liteVo(m), p.label, true)); seen.add(ev.ticker);
    }
    if (cfg.chips_auto) {
      const week = Date.now() + 7 * DAY;
      for (const ev of [...cands].filter((c) => c.close_time && Date.parse(c.close_time) <= week && !seen.has(c.ticker)).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time))) {
        if (out.length >= 12) break;
        const l = lead(ev);
        if (!l) continue;
        out.push(chipOf(ev, l, '', false));
      }
    }
    return out;
  }
  function monthly(cands, cfg) {
    const pick = (cfg.monthly.event_ticker && cands.find((c) => c.ticker === cfg.monthly.event_ticker))
      || cands.find((c) => db.prepare("SELECT 1 FROM markets WHERE event_ticker=? AND status='active' AND market_type='scalar'").get(c.ticker));
    if (!pick) return null;
    const ev = rich(pick, 1);
    return { ...ev, heading_title: cfg.monthly.title || pick.title };
  }
  function promos(req) {
    const now = Date.now();
    const ok = (r) => (!r.starts_at || Date.parse(r.starts_at) <= now) && (!r.ends_at || Date.parse(r.ends_at) > now);
    const rows = db.prepare('SELECT * FROM cms_promos WHERE active=1 ORDER BY position, created_at').all().filter(ok)
      .filter((r) => (r.series_tickers || '[]') === '[]' && (r.categories || '[]') === '[]' && !(r.hide_logged_out && !req.auth) && (r.placement || 'all') !== 'home');
    return rows.length ? rows.map((p) => ({ id: p.id, overline: p.overline, title: p.title, subtitle: p.subtitle, link: p.link, color: p.color, art: p.art || '' })) : null;
  }
  function hub(cands) {
    const h = db.prepare('SELECT * FROM cms_hubs WHERE active=1 ORDER BY position, created_at LIMIT 1').get();
    const cat = h ? h.category : 'Elections';
    let title = h ? h.title : null; let href = null;
    if (!h) { try { const el = db.prepare("SELECT slug, title FROM el_elections WHERE country='NG' AND active=1 ORDER BY CASE kind WHEN 'general' THEN 0 ELSE 1 END, date LIMIT 1").get(); if (el) { title = el.title; href = `/category/elections/${el.slug}`; } } catch { /* elections not set up */ } }
    const inCat = cands.filter((c) => c.category === cat);
    return { category: cat, title, href, dollar_volume: inCat.reduce((a, c) => a + c.dollars, 0), events: inCat.length };
  }
  function categories(cands, cfg) {
    const nav = new Map(db.prepare('SELECT * FROM cms_nav').all().map((r) => [r.category, r]));
    const cats = [...new Set(cands.map((c) => c.category))].filter((c) => !nav.get(c)?.hidden)
      .sort((a, b) => (nav.get(a)?.position ?? 1000 + CATEGORIES.indexOf(a)) - (nav.get(b)?.position ?? 1000 + CATEGORIES.indexOf(b)));
    return cats.slice(0, cfg.category_count).map((cat) => ({ category: cat, events: cands.filter((c) => c.category === cat).slice(0, 6).map((ev) => ({ ...base(ev), lead: lead(ev) })) }));
  }
  const apy = () => { const r = db.prepare("SELECT value FROM meta WHERE key='setting_interest_apy'").get(); return r ? Number(r.value) : 0.035; };

  function build(req) {
    const cfg = config();
    const cands = candidates();
    const { list, pinned } = heroEvents(cands, cfg);
    const heroSet = new Set(list.map((e) => e.ticker));
    const watchPins = cfg.watch_pins.map((t) => cands.find((c) => c.ticker === t)).filter(Boolean);
    const watch = (watchPins.length ? watchPins : [...cands.filter((c) => !heroSet.has(c.ticker)), ...cands]).filter((v, i, a) => a.indexOf(v) === i).slice(0, 3);
    return {
      sections: cfg.sections.filter((s) => !cfg.hidden.includes(s)),
      hero: list.map((ev) => ({ ...rich(ev, 3), pinned: pinned.has(ev.ticker) })),
      chips: chips(cands, cfg),
      watch: watch.map((ev) => rich(ev, 2)),
      monthly: monthly(cands, cfg),
      promos: promos(req),
      hub: hub(cands),
      apy: apy(),
      categories: categories(cands, cfg),
      generated_time: nowIso(),
    };
  }
  // Admin inputs the payload depends on; a change to any of them rebuilds at once instead of after the cache time.
  function signature() {
    const one = (sql) => JSON.stringify(db.prepare(sql).get());
    return [one('SELECT group_concat(event_ticker) h FROM (SELECT event_ticker FROM cms_hero ORDER BY position)'), JSON.stringify(cfgRow() || null),
      one('SELECT COUNT(*) n, MAX(updated_at) u FROM landing_content'), one('SELECT COUNT(*) n, MAX(updated_at) u FROM cms_promos'), one('SELECT COUNT(*) n, MAX(updated_at) u FROM cms_hubs'),
      one('SELECT COUNT(*) n, MAX(updated_at) u FROM cms_news'), one('SELECT group_concat(category || position || hidden) x FROM cms_nav'), one('SELECT COUNT(*) n, MAX(updated_at) u FROM cms_event_meta')].join('|');
  }
  const cache = new Map();
  function landing(req) {
    const key = req.auth ? 'member' : 'visitor';
    const sig = signature();
    const c = cache.get(key);
    if (c && c.sig === sig && Date.now() - c.at < CACHE_MS) return c.body;
    const json = JSON.stringify({ landing: build(req) });
    const body = { json, gz: zlib.gzipSync(json, { level: 6 }) };
    cache.set(key, { sig, at: Date.now(), body });
    return body;
  }
  // Sent gzip-compressed when the browser accepts it (about a fifth of the size on a 3G phone).
  v1.get('/bff/landing', (req, res) => {
    const b = landing(req);
    res.setHeader('Vary', 'Accept-Encoding');
    res.type('application/json');
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) { res.setHeader('Content-Encoding', 'gzip'); res.end(b.gz); } else res.end(b.json);
  });

  // ------------------------------------------------------------------ member home extras
  function onboarding(uid) {
    const p = db.prepare('SELECT email_verified_at, status FROM identity_profiles WHERE user_id=?').get(uid);
    const idStatus = getIdentity()?.statusOf ? getIdentity().statusOf(uid) : p?.status;
    const steps = [
      ['email', !!p?.email_verified_at, '/verify-email'],
      ['identity', idStatus === 'approved', '/sign-up/identity'],
      ['deposit', !!db.prepare("SELECT 1 FROM ledger WHERE user_id=? AND kind='deposit' LIMIT 1").get(uid), '/funds/deposit'],
      ['trade', !!db.prepare('SELECT 1 FROM fills WHERE user_id=? LIMIT 1').get(uid), '/browse'],
    ].map(([step, done, href]) => ({ step, done, href }));
    const next = steps.findIndex((s) => !s.done);
    return { steps, completed: steps.filter((s) => s.done).length, total: steps.length, current: next < 0 ? null : steps[next].step, step_number: next < 0 ? steps.length : next + 1 };
  }
  v1.get('/bff/member_home', (req, res) => {
    const rolling = getRolling();
    const fifteen = rolling && flags.on('trading.rolling', { req }) ? rolling.openWindows() : { windows: [], next_close_time: null };
    let me = null;
    if (req.auth) {
      const prefs = getAccountArea()?.prefsOf ? getAccountArea().prefsOf(req.auth.user.id) : {};
      me = { onboarding: onboarding(req.auth.user.id), view_mode: prefs.view_mode || 'prediction', onboarding_dismissed: !!prefs.home_onboarding_dismissed, customize_dismissed: !!prefs.home_customize_dismissed };
    }
    res.json({ fifteen_min: fifteen, me, apy: apy() });
  });

  // ------------------------------------------------------------------ Admin › Content › Landing page
  const A = '/admin/landing';
  const eventExists = (t) => !!db.prepare('SELECT 1 FROM events WHERE ticker=?').get(t);
  v1.get(A, can('content.write'), (req, res) => {
    const cands = candidates();
    const cfg = config();
    const { list, pinned } = heroEvents(cands, cfg);
    const rows = new Map(db.prepare('SELECT * FROM landing_content').all().map((r) => [`${r.kind}:${r.ref}`, r]));
    const vo = (kind, ref) => { const r = rows.get(`${kind}:${ref}`); return r ? { hero_exclude: !!r.hero_exclude, context: r.context, image_asset_id: r.image_asset_id, image_alt: r.image_alt, image: mediaOf(r.image_asset_id), updated_at: r.updated_at, updated_by: r.updated_by } : null; };
    const media = db.prepare("SELECT id, ext, width, height, original_name, created_at FROM cms_media WHERE variant='original' ORDER BY created_at DESC LIMIT 200").all().map((a) => ({ id: a.id, url: `/media/${a.id}.${a.ext}`, width: a.width, height: a.height, name: a.original_name }));
    res.json({
      config: cfg, sections: SECTIONS,
      variants: Object.fromEntries(['layout.home_visitors', 'layout.home_members'].map((k) => [k, engine.ownerSettings ? engine.ownerSettings.get(k) : null])),
      hero: list.map((e) => ({ event_ticker: e.ticker, title: e.title, pinned: pinned.has(e.ticker) })),
      chips: chips(cands, cfg).map((c) => ({ event_ticker: c.event_ticker, market_ticker: c.market.ticker, label: c.label, pinned: c.pinned })),
      events: cands.map((c) => ({ event_ticker: c.ticker, series_ticker: c.series_ticker, series_title: c.series_title, title: c.title, category: c.category, dollar_volume: c.dollars, close_time: c.close_time, pinned: pinned.has(c.ticker),
        content: vo('event', c.ticker), series_content: vo('series', c.series_ticker), context_default: contextOf({ ...c, ticker: c.ticker }).text })),
      markets: db.prepare("SELECT m.ticker, m.yes_sub_title, e.title event_title FROM markets m JOIN events e ON e.ticker=m.event_ticker WHERE m.status='active' AND e.series_ticker <> 'PLXCOMBO' AND e.series_ticker NOT LIKE 'PLXFLASH%' ORDER BY e.rowid, m.rowid LIMIT 500").all(),
      media,
    });
  });
  v1.put(`${A}/config`, can('content.write'), (req, res) => {
    const b = req.body || {};
    const cur = config();
    const errs = {};
    const next = { ...cur };
    const unknown = Object.keys(b).filter((k) => !['sections', 'hidden', 'hero_count', 'hero_fill_auto', 'chips_auto', 'chip_pins', 'watch_pins', 'monthly', 'category_count', 'reason'].includes(k));
    if (unknown.length) errs[unknown[0]] = 'is not a landing setting';
    if ('sections' in b) { if (!Array.isArray(b.sections) || b.sections.length !== SECTIONS.length || SECTIONS.some((s) => !b.sections.includes(s))) errs.sections = `must list ${SECTIONS.join(', ')} once each`; else next.sections = b.sections; }
    if ('hidden' in b) { if (!Array.isArray(b.hidden) || b.hidden.some((s) => !SECTIONS.includes(s))) errs.hidden = `sections from ${SECTIONS.join(', ')}`; else next.hidden = [...new Set(b.hidden)]; }
    const int = (k, min, max) => { if (!(k in b)) return; const n = Number(b[k]); if (!Number.isInteger(n) || n < min || n > max) errs[k] = `a whole number from ${min} to ${max}`; else next[k] = n; };
    int('hero_count', 1, 12); int('category_count', 0, 10);
    for (const k of ['hero_fill_auto', 'chips_auto']) if (k in b) { if (typeof b[k] !== 'boolean') errs[k] = 'true or false'; else next[k] = b[k]; }
    if ('chip_pins' in b) {
      const list = Array.isArray(b.chip_pins) ? b.chip_pins : null;
      if (!list || list.length > 12) errs.chip_pins = 'up to 12 chips';
      else {
        const out = [];
        for (const [i, p] of list.entries()) {
          const t = String(p?.market_ticker || '').trim().toUpperCase(); const label = String(p?.label || '').trim();
          if (!TICKER.test(t) || !db.prepare('SELECT 1 FROM markets WHERE ticker=?').get(t)) { errs[`chip_pins.${i}.market_ticker`] = 'no such market'; continue; }
          if (label.length > 32 || plainProblem(label)) { errs[`chip_pins.${i}.label`] = 'plain text up to 32 characters'; continue; }
          if (!out.some((x) => x.market_ticker === t)) out.push({ market_ticker: t, label });
        }
        next.chip_pins = out;
      }
    }
    if ('watch_pins' in b) {
      const list = Array.isArray(b.watch_pins) ? [...new Set(b.watch_pins.map((x) => String(x).trim().toUpperCase()))] : null;
      if (!list || list.length > 3) errs.watch_pins = 'up to 3 events';
      else if (list.some((t) => !eventExists(t))) errs.watch_pins = `unknown event(s): ${list.filter((t) => !eventExists(t)).join(', ')}`;
      else next.watch_pins = list;
    }
    if ('monthly' in b) {
      const m = b.monthly && typeof b.monthly === 'object' ? b.monthly : null;
      const t = String(m?.event_ticker || '').trim().toUpperCase(); const title = String(m?.title || '').trim();
      if (!m) errs.monthly = 'must be {event_ticker, title}';
      else if (t && !eventExists(t)) errs['monthly.event_ticker'] = 'no such event';
      else if (title.length > 80 || plainProblem(title)) errs['monthly.title'] = 'plain text up to 80 characters';
      else next.monthly = { event_ticker: t, title };
    }
    if (Object.keys(errs).length) throw fieldError(errs);
    const { reason, ...clean } = next; void reason;
    admin.putSetting(CONFIG_KEY, clean, req.auth.user.id);
    admin.audit(req, 'landing.config', 'landing', 'config', cur, clean, String(b.reason || ''));
    cache.clear();
    res.json({ config: config() });
  });
  function refOf(req) {
    const kind = req.params.kind;
    const ref = String(req.params.ref || '').toUpperCase();
    if (!['event', 'series'].includes(kind)) throw E.notFound();
    const exists = kind === 'event' ? eventExists(ref) : !!db.prepare('SELECT 1 FROM series WHERE ticker=?').get(ref);
    if (!exists) throw E.notFound();
    return { kind, ref };
  }
  v1.put(`${A}/content/:kind/:ref`, can('content.write'), (req, res) => {
    const { kind, ref } = refOf(req);
    const b = req.body || {};
    const cur = contentOf(kind, ref);
    const errs = {};
    const unknown = Object.keys(b).filter((k) => !['hero_exclude', 'context', 'image_asset_id', 'image_alt', 'reason'].includes(k));
    if (unknown.length) errs[unknown[0]] = 'is not a landing field';
    const context = 'context' in b ? String(b.context ?? '').trim() : cur?.context || '';
    if (context.length > 600) errs.context = 'at most 600 characters'; else if (plainProblem(context)) errs.context = plainProblem(context);
    const alt = 'image_alt' in b ? String(b.image_alt ?? '').trim() : cur?.image_alt || '';
    if (alt.length > 160) errs.image_alt = 'at most 160 characters'; else if (plainProblem(alt)) errs.image_alt = plainProblem(alt);
    const img = 'image_asset_id' in b ? (b.image_asset_id ? String(b.image_asset_id) : null) : cur?.image_asset_id || null;
    if (img && !mediaOf(img)) errs.image_asset_id = 'no such uploaded image (Admin › Content › Media)';
    if ('hero_exclude' in b && typeof b.hero_exclude !== 'boolean') errs.hero_exclude = 'true or false';
    if (Object.keys(errs).length) throw fieldError(errs);
    const ex = 'hero_exclude' in b ? (b.hero_exclude ? 1 : 0) : cur?.hero_exclude || 0;
    db.prepare(`INSERT INTO landing_content(ref,kind,hero_exclude,context,image_asset_id,image_alt,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(kind,ref) DO UPDATE SET hero_exclude=excluded.hero_exclude, context=excluded.context, image_asset_id=excluded.image_asset_id, image_alt=excluded.image_alt, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
      .run(ref, kind, ex, context, img, alt, nowIso(), req.auth.user.email);
    const after = contentOf(kind, ref);
    admin.audit(req, 'landing.content', `landing.${kind}`, ref, cur, after, String(b.reason || ''));
    cache.clear();
    res.json({ content: after });
  });
  v1.delete(`${A}/content/:kind/:ref`, can('content.write'), (req, res) => {
    const { kind, ref } = refOf(req);
    const cur = contentOf(kind, ref);
    db.prepare('DELETE FROM landing_content WHERE kind=? AND ref=?').run(kind, ref);
    if (cur) admin.audit(req, 'landing.content_reset', `landing.${kind}`, ref, cur, null);
    cache.clear();
    res.json({ ok: true });
  });

  return { build, config, invalidate: () => cache.clear() };
}

module.exports = { mountLanding, DEFAULT_CONFIG, SECTIONS };
