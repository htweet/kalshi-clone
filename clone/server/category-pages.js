'use strict';
// Category pages (owner request 2026-11-15, CLONE_SPEC.md §41): the data behind /category/<slug> in one bounded request,
// the admin's per-category choices, and the invented seed markets the new page needs (Nigerian city weather for the
// Top-cities strip, the Harbor crude commodity with an underlying price).
//
//   GET  /v1/bff/category/:slug                    sidebar counts, featured carousel, one page of cards, strips, banner
//   POST /v1/bff/category/:slug/banner/dismiss     a member hides the category banner (visitors: browser storage)
//   GET  /v1/admin/category_pages[/:slug]          Admin › Category pages (content.write)
//   PUT  /v1/admin/category_pages/:slug            save (validated, with a reason, audited `category_pages.update`)
//
// Every query is bounded and indexed: events and series by category (migration 0006), volumes from the running totals
// (market_volume, market_volume_hourly; never a market's trade history), one page of 24 cards, at most 200 candidates
// for the automatic featured pick. Layout: the owner setting `category.layout` (new | classic), overridable per category.
const C = require('./currency');
const { s: S } = require('./content/category-pages');
const { tx } = require('./db');
const { newId, nowIso, E, ApiError, UNITS, encCursor, decCursor } = require('./util');
const { CATEGORIES } = require('./features');

const COMBO = 'PLXCOMBO';
const H = 3600 * 1000;
const D = 24 * H;
const slugOf = (c) => c.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const fromSlug = (s) => CATEGORIES.find((c) => slugOf(c) === s) || null;
const GLYPHS = ['chart', 'coin', 'drop', 'sun', 'cloud', 'oil', 'bolt', 'ballot', 'ball', 'film', 'chip', 'bank', 'flag', 'globe', 'star', 'mic', 'rocket', 'home'];
const FILTER_TYPES = ['series', 'tag', 'office', 'country', 'kind'];
const KINDS = ['games', 'lines', 'futures'];
const STATUS = { open: ['active'], unopened: ['initialized'], closed: ['closed', 'inactive', 'determined'], settled: ['finalized'], all: null };
const FREQS = ['fifteen_min', 'hourly', 'daily', 'weekly', 'monthly', 'annual', 'one_off'];
const ORDERS = ['trending', 'event-volume', 'newest', 'closing-soon'];
const PAGE = 24;
const HEX = /^#[0-9a-f]{6}$/i;
const TICKER = /^[A-Z0-9][A-Z0-9._-]{1,63}$/;
const PIN = /^(series:)?[A-Z0-9][A-Z0-9._-]{1,63}$/;
const PATH = /^\/(?!\/)[A-Za-z0-9/_?=&%.~+-]{0,200}$/;
const plain = (s, max) => typeof s === 'string' && s.length <= max && !/[<>\u0000-\u001f]/.test(s);
// Invented cities for the Top-cities strip: code, name, typical November high (°C), rain chance (%).
const CITIES = [['LOS', 'Lagos', 31, 55], ['ABV', 'Abuja', 32, 25], ['KAN', 'Kano', 33, 5], ['PHC', 'Port Harcourt', 30, 70], ['IBA', 'Ibadan', 31, 45], ['ENU', 'Enugu', 30, 35]];
const RAIN_SERIES = 'PLXRAINDAY';
const CRUDE = 'PLXCRUDE';
const FLASH = 'PLXFLASH';

function defaults(cat) {
  return {
    layout: 'inherit', carousel_size: null,
    featured: { pins: ({ Crypto: [`series:${FLASH}`], Financials: [`series:${CRUDE}`] })[cat] || [], exclude: [] },
    // Crypto starts with one coin group (both PLX series), like the observed coin groups; the rest group automatically.
    grouping: cat === 'Crypto' ? 'custom' : 'auto', groups: cat === 'Crypto' ? [{ id: 'plx', label: 'PLX', icon: { glyph: 'coin', color: '#d9480f' }, filter: { type: 'series', values: ['PLXFLASH', 'PLXCOIN'] }, collapsed: true }] : [], hub: null,
    top_cities: cat === 'Climate and Weather',
    docked_ticket: cat === 'Sports',
    outcome_avatars: ['Politics', 'Elections', 'Entertainment', 'Sports', 'Companies'].includes(cat),
    banner: { enabled: cat === 'Crypto', version: 1, title: '', body: '', cta_label: '', cta_href: cat === 'Crypto' ? '/perps' : '', link_label: '', link_href: cat === 'Crypto' ? '/help?q=invest' : '' },
  };
}

// ------------------------------------------------------------------------------------------------ validation
function bad(field, msg) {
  const e = new ApiError(400, 'validation_failed', S('error.bad_config'), `${field}: ${msg}`);
  e.toJSON = () => ({ error: { code: e.code, message: e.message, details: e.details, fields: { [field]: msg } } });
  return e;
}
function validate(cat, raw, db) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('config', 'must be an object');
  const d = defaults(cat);
  const out = { ...d };
  const bool = (k) => { if (raw[k] === undefined) return; if (raw[k] !== null && typeof raw[k] !== 'boolean') throw bad(k, 'must be true, false or null'); out[k] = raw[k] === null ? d[k] : raw[k]; };
  if (raw.layout !== undefined) { if (!['inherit', 'new', 'classic'].includes(raw.layout)) throw bad('layout', 'must be inherit, new or classic'); out.layout = raw.layout; }
  if (raw.carousel_size !== undefined && raw.carousel_size !== null && raw.carousel_size !== '') {
    const n = Number(raw.carousel_size);
    if (!Number.isInteger(n) || n < 1 || n > 10) throw bad('carousel_size', 'must be a whole number from 1 to 10, or empty');
    out.carousel_size = n;
  }
  for (const k of ['top_cities', 'docked_ticket', 'outcome_avatars']) bool(k);
  if (raw.featured !== undefined) {
    const f = raw.featured || {};
    const list = (k, max) => {
      const v = f[k] == null ? [] : f[k];
      if (!Array.isArray(v) || v.length > max) throw bad(`featured.${k}`, `must be a list of at most ${max}`);
      const xs = [...new Set(v.map((x) => String(x).trim().toUpperCase().replace(/^SERIES:/, 'series:')).filter(Boolean))];
      for (const x of xs) if (!PIN.test(x)) throw bad(`featured.${k}`, `"${x}" is not an event ticker or series:TICKER`);
      for (const x of xs) {
        const known = x.startsWith('series:') ? db.prepare('SELECT 1 FROM series WHERE ticker=? AND category=?').get(x.slice(7), cat) : db.prepare('SELECT 1 FROM events WHERE ticker=? AND category=?').get(x, cat);
        if (!known) throw bad(`featured.${k}`, `"${x}" is not in this category`);
      }
      return xs;
    };
    out.featured = { pins: list('pins', 20), exclude: list('exclude', 50) };
  }
  if (raw.grouping !== undefined) { if (!['auto', 'custom'].includes(raw.grouping)) throw bad('grouping', 'must be auto or custom'); out.grouping = raw.grouping; }
  if (raw.groups !== undefined) {
    if (!Array.isArray(raw.groups) || raw.groups.length > 30) throw bad('groups', 'must be a list of at most 30 groups');
    const ids = new Set();
    out.groups = raw.groups.map((g, i) => {
      const at = `groups[${i}]`;
      if (!g || typeof g !== 'object') throw bad(at, 'must be an object');
      const label = String(g.label || '').trim();
      if (!label || !plain(label, 40)) throw bad(`${at}.label`, '1-40 characters of plain text');
      let id = String(g.id || '').trim().toLowerCase() || `g${i + 1}`;
      if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id) || ids.has(id)) id = `g${i + 1}-${ids.size}`;
      ids.add(id);
      const f = g.filter || {};
      if (!FILTER_TYPES.includes(f.type)) throw bad(`${at}.filter.type`, `one of ${FILTER_TYPES.join(', ')}`);
      const values = (Array.isArray(f.values) ? f.values : String(f.values || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
      if (!values.length || values.length > 50) throw bad(`${at}.filter.values`, '1-50 values');
      if (f.type === 'series') for (const v of values) if (!TICKER.test(v.toUpperCase()) || !db.prepare('SELECT 1 FROM series WHERE ticker=? AND category=?').get(v.toUpperCase(), cat)) throw bad(`${at}.filter.values`, `"${v}" is not a series of this category`);
      if (f.type === 'kind') for (const v of values) if (!KINDS.includes(v)) throw bad(`${at}.filter.values`, `kinds are ${KINDS.join(', ')}`);
      for (const v of values) if (!plain(v, 64)) throw bad(`${at}.filter.values`, 'plain text values');
      const icon = g.icon || {};
      const outIcon = {};
      if (icon.glyph) { if (!GLYPHS.includes(icon.glyph)) throw bad(`${at}.icon.glyph`, `one of ${GLYPHS.join(', ')}`); outIcon.glyph = icon.glyph; }
      if (icon.color) { if (!HEX.test(icon.color)) throw bad(`${at}.icon.color`, 'a colour like #1c7ed6'); outIcon.color = icon.color.toLowerCase(); }
      if (icon.asset_id) {
        const a = db.prepare("SELECT width, height FROM cms_media WHERE id=? AND variant='original'").get(String(icon.asset_id));
        if (!a) throw bad(`${at}.icon.asset_id`, 'no such image in the media library');
        if (a.width !== a.height) throw bad(`${at}.icon.asset_id`, 'the icon image must be square');
        outIcon.asset_id = String(icon.asset_id);
      }
      return { id, label, icon: outIcon, filter: { type: f.type, values: f.type === 'series' ? values.map((v) => v.toUpperCase()) : values }, collapsed: g.collapsed === true };
    });
  }
  if (raw.hub !== undefined) {
    const h = raw.hub;
    if (h === null || (!h.label && !h.href)) out.hub = null;
    else {
      if (!plain(String(h.label || ''), 40) || !String(h.label || '').trim()) throw bad('hub.label', '1-40 characters of plain text');
      if (!PATH.test(String(h.href || ''))) throw bad('hub.href', 'a path on this site, starting with /');
      out.hub = { label: String(h.label).trim(), href: String(h.href) };
    }
  }
  if (raw.banner !== undefined) {
    const b = raw.banner || {};
    const t = (k, max) => { const v = String(b[k] ?? '').trim(); if (!plain(v, max)) throw bad(`banner.${k}`, `at most ${max} characters of plain text`); return v; };
    const p = (k) => { const v = String(b[k] ?? '').trim(); if (v && !PATH.test(v)) throw bad(`banner.${k}`, 'a path on this site, starting with /'); return v; };
    out.banner = { enabled: b.enabled === true, version: 1, title: t('title', 80), body: t('body', 200), cta_label: t('cta_label', 30), cta_href: p('cta_href'), link_label: t('link_label', 30), link_href: p('link_href') };
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ module
function mountCategoryPages({ v1, db, engine, admin, eventFull, options = {} }) {
  const can = admin.can;
  const tables = new Map();
  const hasTable = (t) => { if (!tables.has(t) || !tables.get(t)) tables.set(t, !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)); return tables.get(t); };
  const setting = (k, def) => { try { return engine.ownerSettings ? engine.ownerSettings.get(k) : def; } catch { return def; } };

  const stored = (cat) => { const r = db.prepare('SELECT config, version, updated_at FROM category_page_config WHERE category=?').get(cat); if (!r) return null; try { return { ...JSON.parse(r.config), _version: r.version, _updated_at: r.updated_at }; } catch { return null; } };
  const configOf = (cat) => { const s = stored(cat); const d = defaults(cat); if (!s) return d; const { _version, _updated_at, ...c } = s; void _version; void _updated_at; return { ...d, ...c, featured: { ...d.featured, ...(c.featured || {}) }, banner: { ...d.banner, ...(c.banner || {}) } }; };
  const layoutOf = (cfg) => (cfg.layout === 'new' || cfg.layout === 'classic' ? cfg.layout : setting('category.layout', 'new'));

  // ---------------------------------------------------------------- sidebar groups
  const seriesOf = (cat) => db.prepare('SELECT ticker, title, slug, tags, frequency FROM series WHERE category=? AND ticker<>? ORDER BY rowid').all(cat, COMBO)
    .map((s) => ({ ...s, tags: (() => { try { return JSON.parse(s.tags); } catch { return []; } })() }));
  function defaultHub(cat) {
    if (cat === 'Economics') return { label: S('hub.economics'), href: '/hubs/economics' };
    if (cat === 'Sports') return { label: S('hub.sports'), href: '/sports', testid: 'sports-hub-link' };
    if (cat === 'Crypto') return { label: S('hub.crypto'), href: '/perps', external: true };
    if (cat === 'Elections') {
      let slug = 'nigeria-2027';
      if (hasTable('el_elections')) { const r = db.prepare("SELECT slug FROM el_elections WHERE country='NG' AND active=1 ORDER BY CASE kind WHEN 'general' THEN 0 ELSE 1 END, date LIMIT 1").get(); if (r) slug = r.slug; }
      return { label: S('hub.elections'), href: `/category/elections/${slug}` };
    }
    return null;
  }
  function autoGroups(cat, series) {
    const groups = [];
    if (cat === 'Elections' && hasTable('el_race_markets') && hasTable('el_offices')) {
      const offices = db.prepare(`SELECT o.key, MIN(o.name) name, MIN(o.sort) sort FROM el_race_markets rm JOIN el_races r ON r.id=rm.race_id JOIN el_offices o ON o.id=r.office_id
        JOIN markets m ON m.ticker=rm.market_ticker JOIN events e ON e.ticker=m.event_ticker WHERE e.category='Elections' GROUP BY o.key ORDER BY sort, key`).all();
      if (offices.length) {
        for (const o of offices) groups.push({ id: `office-${o.key.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, label: o.name, icon: { glyph: 'ballot' }, filter: { type: 'office', values: [o.key] } });
        const intl = db.prepare("SELECT DISTINCT el.country FROM el_race_markets rm JOIN el_races r ON r.id=rm.race_id JOIN el_elections el ON el.id=r.election_id WHERE el.country<>'NG'").all().map((x) => x.country);
        if (intl.length) groups.push({ id: 'international', label: S('group.international'), icon: { glyph: 'globe' }, filter: { type: 'country', values: intl } });
        for (const s of series) groups.push({ id: `series-${s.ticker.toLowerCase()}`, label: s.title, icon: { glyph: 'flag' }, filter: { type: 'series', values: [s.ticker] } });
        return groups;
      }
    }
    const byTag = new Map();
    for (const s of series) { const tag = s.tags[0] || s.title; if (!byTag.has(tag)) byTag.set(tag, []); byTag.get(tag).push(s.ticker); }
    for (const [tag, list] of [...byTag].sort((a, b) => a[0].localeCompare(b[0]))) groups.push({ id: `tag-${tag.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, label: tag, icon: {}, filter: { type: 'tag', values: [tag] }, children: list.length > 1 ? list : [] });
    return groups;
  }
  const groupsOf = (cat, cfg, series) => (cfg.grouping === 'custom' && cfg.groups.length ? cfg.groups.map((g) => ({ ...g, children: g.filter.type === 'series' && g.filter.values.length > 1 ? g.filter.values : [] })) : autoGroups(cat, series));
  const iconVo = (icon) => {
    if (!icon) return {};
    if (icon.asset_id) { const a = db.prepare("SELECT id, ext FROM cms_media WHERE id=? AND variant='original'").get(icon.asset_id); if (a) return { url: `/media/${a.id}.${a.ext}`, color: icon.color || null }; }
    return { glyph: icon.glyph || null, color: icon.color || null };
  };

  // ---------------------------------------------------------------- event filters (SQL)
  const marks = (n) => Array(n).fill('?').join(',');
  function filterSql(f) {
    const v = f.values;
    if (f.type === 'series') return { sql: `e.series_ticker IN (${marks(v.length)})`, args: v };
    if (f.type === 'tag') return { sql: `EXISTS (SELECT 1 FROM json_each(s.tags) j WHERE lower(j.value) IN (${marks(v.length)}))`, args: v.map((x) => x.toLowerCase()) };
    if (f.type === 'office') {
      if (!hasTable('el_race_markets')) return { sql: '0', args: [] };
      return { sql: `e.ticker IN (SELECT m.event_ticker FROM el_race_markets rm JOIN el_races r ON r.id=rm.race_id JOIN el_offices o ON o.id=r.office_id JOIN markets m ON m.ticker=rm.market_ticker WHERE o.key IN (${marks(v.length)}))`, args: v };
    }
    if (f.type === 'country') {
      if (!hasTable('el_race_markets')) return { sql: '0', args: [] };
      return { sql: `e.ticker IN (SELECT m.event_ticker FROM el_race_markets rm JOIN el_races r ON r.id=rm.race_id JOIN el_elections el ON el.id=r.election_id JOIN markets m ON m.ticker=rm.market_ticker WHERE el.country IN (${marks(v.length)}))`, args: v };
    }
    if (f.type === 'kind') {
      const games = hasTable('sports_event_links') ? 'e.ticker IN (SELECT event_ticker FROM sports_event_links)' : '0';
      const lines = hasTable('sports_line_events') ? 'e.ticker IN (SELECT event_ticker FROM sports_line_events)' : '0';
      const parts = v.map((k) => (k === 'games' ? games : k === 'lines' ? lines : `NOT (${games}) AND NOT (${lines})`));
      return { sql: `(${parts.map((p) => `(${p})`).join(' OR ')})`, args: [] };
    }
    return { sql: '0', args: [] };
  }
  function whereOf(cat, q, { only = [] } = {}) {
    const w = ['e.category=?', 'e.series_ticker<>?']; const args = [cat, COMBO];
    const st = STATUS[q.status || 'open'];
    if (st) { w.push(`EXISTS (SELECT 1 FROM markets m WHERE m.event_ticker=e.ticker AND m.status IN (${marks(st.length)}))`); args.push(...st); }
    const use = (k) => !only.length || only.includes(k);
    if (use('frequency') && q.frequency) { w.push('s.frequency=?'); args.push(q.frequency); }
    if (use('series') && q.series) { w.push('e.series_ticker=?'); args.push(q.series); }
    if (use('tag') && q.tag) { const f = filterSql({ type: 'tag', values: [q.tag] }); w.push(f.sql); args.push(...f.args); }
    if (use('group') && q.groupFilter) { const f = filterSql(q.groupFilter); w.push(f.sql); args.push(...f.args); }
    if (use('kind') && q.kind) { const f = filterSql({ type: 'kind', values: [q.kind] }); w.push(f.sql); args.push(...f.args); }
    return { sql: w.join(' AND '), args };
  }
  const FROM = 'FROM events e JOIN series s ON s.ticker=e.series_ticker';
  const VOL24 = '(SELECT COALESCE(SUM(h.volume_units),0) FROM markets m JOIN market_volume_hourly h ON h.market_ticker=m.ticker WHERE m.event_ticker=e.ticker AND h.hour_ts>?)';
  const VOL = '(SELECT COALESCE(SUM(v.volume_units),0) FROM markets m JOIN market_volume v ON v.market_ticker=m.ticker WHERE m.event_ticker=e.ticker)';
  const CLOSE = "(SELECT MIN(m.close_time) FROM markets m WHERE m.event_ticker=e.ticker AND m.status IN ('active','initialized','inactive'))";
  const count = (cat, q, extra) => { const wq = whereOf(cat, q, { only: [] }); const sql = extra ? `${wq.sql} AND ${extra.sql}` : wq.sql; return db.prepare(`SELECT COUNT(*) n ${FROM} WHERE ${sql}`).get(...wq.args, ...(extra ? extra.args : [])).n; };

  function page(cat, q, offset, size) {
    const wq = whereOf(cat, q);
    const dayAgo = Math.floor((Date.now() - D) / H) * H;
    const order = { trending: [`${VOL24} DESC, ${VOL} DESC`, [dayAgo]], 'event-volume': [`${VOL} DESC`, []], newest: ['e.created_at DESC', []], 'closing-soon': [`${CLOSE} IS NULL, ${CLOSE} ASC`, []] }[q.order_by] || [`${VOL24} DESC, ${VOL} DESC`, [dayAgo]];
    const total = db.prepare(`SELECT COUNT(*) n ${FROM} WHERE ${wq.sql}`).get(...wq.args).n;
    const rows = db.prepare(`SELECT e.* ${FROM} WHERE ${wq.sql} ORDER BY ${order[0]}, e.rowid DESC LIMIT ? OFFSET ?`).all(...wq.args, ...order[1], size, offset);
    return { total, rows };
  }

  // ---------------------------------------------------------------- featured carousel
  function featuredOf(cat, cfg) {
    const size = cfg.carousel_size || setting('category.carousel_size', 3);
    const dayAgo = Math.floor((Date.now() - D) / H) * H;
    const open = db.prepare(`SELECT e.ticker, e.series_ticker FROM events e WHERE e.category=? AND e.series_ticker<>? AND EXISTS (SELECT 1 FROM markets m WHERE m.event_ticker=e.ticker AND m.status='active')
      ORDER BY ${VOL24} DESC, ${VOL} DESC, e.created_at DESC, e.rowid DESC LIMIT 200`).all(cat, COMBO, dayAgo);
    const newestOf = (series) => db.prepare("SELECT e.ticker FROM events e WHERE e.category=? AND e.series_ticker=? AND EXISTS (SELECT 1 FROM markets m WHERE m.event_ticker=e.ticker AND m.status='active') ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1").get(cat, series)?.ticker;
    const isOpen = (t) => !!db.prepare("SELECT 1 FROM events e WHERE e.ticker=? AND e.category=? AND EXISTS (SELECT 1 FROM markets m WHERE m.event_ticker=e.ticker AND m.status='active')").get(t, cat);
    const out = [];
    for (const p of cfg.featured.pins) { const t = p.startsWith('series:') ? newestOf(p.slice(7)) : (isOpen(p) ? p : null); if (t && !out.includes(t)) out.push(t); }
    const ex = new Set(cfg.featured.exclude);
    for (const r of open) { if (out.length >= size) break; if (!out.includes(r.ticker) && !ex.has(r.ticker) && !ex.has(`series:${r.series_ticker}`)) out.push(r.ticker); }
    return out.slice(0, size).map((t) => { const ev = eventFull(db.prepare('SELECT * FROM events WHERE ticker=?').get(t)); ev.pinned = cfg.featured.pins.some((p) => p === t || p === `series:${ev.series_ticker}`); ev.underlying = underlyingOf(ev); return ev; });
  }
  const thin = (pts, n) => { const step = Math.max(1, Math.ceil(pts.length / n)); return pts.filter((_, i) => i % step === 0 || i === pts.length - 1); };
  function underlyingOf(ev) {
    if (ev.series_ticker === FLASH && hasTable('flash_windows')) {
      const w = db.prepare('SELECT * FROM flash_windows WHERE event_ticker=?').get(ev.event_ticker);
      if (!w) return null;
      const pts = db.prepare('SELECT ts, price_cents p FROM flash_prices WHERE ts>=? ORDER BY ts LIMIT 5000').all(w.start_ts);
      const now = pts.length ? pts[pts.length - 1].p : w.target_cents;
      return { kind: 'target', label: S('underlying.flash'), target_cents: w.target_cents, target_ts: w.start_ts, end_ts: w.end_ts, now_cents: now, change_cents: now - w.target_cents, change_pct: w.target_cents ? ((now - w.target_cents) / w.target_cents) * 100 : 0, points: thin(pts, 120).map((x) => ({ t: x.ts, v: x.p })) };
    }
    const pts = db.prepare('SELECT ts, price p FROM underlying_prices WHERE series_ticker=? AND ts>=? ORDER BY ts LIMIT 2000').all(ev.series_ticker, Date.now() - 10 * D);
    if (!pts.length) return null;
    const now = pts[pts.length - 1];
    const prev = db.prepare('SELECT price p FROM underlying_prices WHERE series_ticker=? AND ts<=? ORDER BY ts DESC LIMIT 1').get(ev.series_ticker, now.ts - D)?.p ?? pts[0].p;
    const strikes = new Map(db.prepare("SELECT ticker, floor_strike k FROM markets WHERE event_ticker=? AND floor_strike IS NOT NULL AND market_type<>'scalar'").all(ev.event_ticker).map((x) => [x.ticker, Number(x.k)]));
    const lead = ev.markets.filter((m) => strikes.has(m.ticker)).sort((a, b) => Number(b.last_price_dollars || 0) - Number(a.last_price_dollars || 0))[0];
    return { kind: 'strike', label: ev.series_ticker === CRUDE ? S('underlying.crude') : ev.series_title, now_cents: now.p, change_cents: now.p - prev, change_pct: prev ? ((now.p - prev) / prev) * 100 : 0, updated_ts: now.ts,
      strike_cents: lead ? strikes.get(lead.ticker) : null, strike_label: lead ? lead.yes_sub_title : null, points: thin(pts, 160).map((x) => ({ t: x.ts, v: x.p })) };
  }

  // ---------------------------------------------------------------- strips
  const lead = (ms) => ms.reduce((a, m) => (Number(m.last_price_dollars || 0) > Number(a?.last_price_dollars || -1) ? m : a), null);
  function topCities() {
    const days = [C.dayKey(Date.now()), C.dayKey(Date.now() + D)];
    const rows = db.prepare('SELECT ce.event_ticker, ce.city, ce.day, ce.kind FROM category_city_events ce JOIN events e ON e.ticker=ce.event_ticker WHERE ce.day IN (?,?)').all(...days);
    if (!rows.length) return null;
    const out = { days: { today: days[0], tomorrow: days[1] }, today: [], tomorrow: [] };
    for (const [i, day] of days.entries()) {
      for (const [code, city] of CITIES) {
        const hi = rows.find((r) => r.day === day && r.city === code && r.kind === 'high');
        if (!hi) continue;
        const ev = eventFull(db.prepare('SELECT * FROM events WHERE ticker=?').get(hi.event_ticker));
        if (!ev.markets.some((m) => m.status === 'active')) continue;
        const rn = rows.find((r) => r.day === day && r.city === code && r.kind === 'rain');
        const rain = rn ? eventFull(db.prepare('SELECT * FROM events WHERE ticker=?').get(rn.event_ticker)) : null;
        const m = lead(ev.markets);
        out[i ? 'tomorrow' : 'today'].push({ city, event_ticker: ev.event_ticker, series_ticker: ev.series_ticker, series_slug: ev.series_slug, market: m,
          rain: rain ? { event_ticker: rain.event_ticker, series_ticker: rain.series_ticker, series_slug: rain.series_slug, market: rain.markets[0] } : null });
      }
    }
    return out;
  }
  function sportsStrip(status) {
    if (!hasTable('sports_event_links') || !hasTable('sports_milestones')) return null;
    const rows = db.prepare(`SELECT sel.event_ticker, ms.status, ms.start_ts, l.id lid, l.short_name, l.sort, s.slug series_slug, e.series_ticker FROM sports_event_links sel JOIN sports_milestones ms ON ms.id=sel.milestone_id
      JOIN sports_leagues l ON l.id=ms.league_id JOIN events e ON e.ticker=sel.event_ticker JOIN series s ON s.ticker=e.series_ticker
      WHERE ms.status IN ('live','scheduled') ORDER BY l.sort, CASE ms.status WHEN 'live' THEN 0 ELSE 1 END, ms.start_ts LIMIT 300`).all();
    const leagues = new Map();
    for (const r of rows) { if (!leagues.has(r.lid)) leagues.set(r.lid, { id: r.lid, label: r.short_name, total: 0, games: [] }); const g = leagues.get(r.lid); g.total += 1; if (g.games.length < 4) g.games.push(r); }
    const strip = [...leagues.values()].slice(0, 6).map((g) => ({ ...g, games: g.games.map((r) => {
      const ms = db.prepare("SELECT ticker, yes_sub_title, color FROM markets WHERE event_ticker=? AND status IN ('active','initialized') ORDER BY rowid LIMIT 3").all(r.event_ticker);
      return { event_ticker: r.event_ticker, series_ticker: r.series_ticker, series_slug: r.series_slug, status: r.status, start_time: new Date(r.start_ts).toISOString(),
        outcomes: ms.map((m) => { const q = engine.quote(m.ticker); return { ticker: m.ticker, name: m.yes_sub_title, color: m.color, prob: q.last_price_cc == null ? null : Math.round(q.last_price_cc / 100) }; }) };
    }) }));
    const featuredLeagues = hasTable('sports_leagues') ? db.prepare('SELECT id, name, short_name, series_ticker, sport FROM sports_leagues WHERE featured=1 ORDER BY sort LIMIT 10').all() : [];
    return { strip, featured_leagues: featuredLeagues, kinds: KINDS.map((k) => ({ key: k, count: count('Sports', { status }, filterSql({ type: 'kind', values: [k] })) })) };
  }

  // ---------------------------------------------------------------- BFF
  const parse = (req) => {
    const q = req.query || {};
    const pick = (k, list, def) => { const v = q[k] == null || q[k] === '' ? def : String(q[k]); if (v && list && !list.includes(v)) throw E.badRequest(`invalid ${k}`); return v; };
    const series = q.series ? String(q.series).toUpperCase() : '';
    if (series && !TICKER.test(series)) throw E.badRequest('invalid series');
    const tag = q.tag ? String(q.tag) : '';
    if (tag && !plain(tag, 64)) throw E.badRequest('invalid tag');
    const group = q.group ? String(q.group) : '';
    if (group && !/^[a-z0-9][a-z0-9-]{0,80}$/.test(group)) throw E.badRequest('invalid group');
    return { status: pick('status', Object.keys(STATUS), 'open'), frequency: pick('frequency', FREQS, ''), order_by: pick('order_by', ORDERS, 'trending'), kind: pick('kind', KINDS, ''), series, tag, group, cursor: q.cursor ? String(q.cursor) : '' };
  };
  v1.get('/bff/category/:slug', (req, res) => {
    const cat = fromSlug(String(req.params.slug));
    if (!cat) throw E.notFound();
    const cfg = configOf(cat);
    const layout = layoutOf(cfg);
    if (layout === 'classic') return res.json({ category: { name: cat, slug: slugOf(cat) }, layout });
    const q = parse(req);
    const series = seriesOf(cat);
    const groups = groupsOf(cat, cfg, series);
    if (q.group) { const g = groups.find((x) => x.id === q.group); if (!g) throw E.badRequest('unknown group'); q.groupFilter = g.filter; }
    const cur = q.cursor ? decCursor(q.cursor) : null;
    const offset = cur && Number.isInteger(cur.o) && cur.o > 0 ? Math.min(cur.o, 100000) : 0;
    const pg = page(cat, q, offset, PAGE);
    const body = { category: { name: cat, slug: slugOf(cat) }, layout, filters: { status: q.status, frequency: q.frequency, order_by: q.order_by, kind: q.kind, series: q.series, tag: q.tag, group: q.group },
      events: pg.rows.map(eventFull), total: pg.total, next_cursor: offset + PAGE < pg.total ? encCursor({ o: offset + PAGE }) : '' };
    if (offset) return res.json(body);
    // Sidebar counts follow the status filter only (what "All markets (N)" means), never the list's own filters.
    const base = { status: q.status };
    const sq = whereOf(cat, base);
    const bySeries = new Map(db.prepare(`SELECT e.series_ticker t, COUNT(*) n ${FROM} WHERE ${sq.sql} GROUP BY e.series_ticker`).all(...sq.args).map((r) => [r.t, r.n]));
    const byFreq = new Map(db.prepare(`SELECT s.frequency f, COUNT(*) n ${FROM} WHERE ${sq.sql} GROUP BY s.frequency`).all(...sq.args).map((r) => [r.f, r.n]));
    const sTitle = new Map(series.map((s) => [s.ticker, s]));
    body.sidebar = {
      all: [...bySeries.values()].reduce((a, n) => a + n, 0),
      frequencies: FREQS.filter((f) => byFreq.get(f)).map((f) => ({ key: f, count: byFreq.get(f) })),
      groups: groups.map((g) => ({ id: g.id, label: g.label, icon: iconVo(g.icon), type: g.filter.type, tag: g.filter.type === 'tag' ? g.filter.values[0] : null, series: g.filter.type === 'series' && g.filter.values.length === 1 ? g.filter.values[0] : null,
        count: g.filter.type === 'series' ? g.filter.values.reduce((a, t) => a + (bySeries.get(t) || 0), 0) : count(cat, base, filterSql(g.filter)), collapsed: !!g.collapsed,
        children: (g.children || []).filter((t) => sTitle.has(t)).map((t) => ({ ticker: t, title: sTitle.get(t).title, count: bySeries.get(t) || 0 })) })),
      hub: cfg.hub || defaultHub(cat),
    };
    const filtered = q.frequency || q.series || q.tag || q.group || q.kind;
    body.carousel_size = cfg.carousel_size || setting('category.carousel_size', 3);
    body.featured = filtered ? [] : featuredOf(cat, cfg);
    body.top_cities = cfg.top_cities ? topCities() : null;
    body.sports = cat === 'Sports' ? sportsStrip(q.status) : null;
    body.docked_ticket = !!cfg.docked_ticket;
    body.outcome_avatars = !!cfg.outcome_avatars;
    body.banner = bannerOf(cat, cfg, req);
    res.json(body);
  });
  v1.get('/bff/category/:slug/underlying/:event', (req, res) => {
    const cat = fromSlug(String(req.params.slug));
    const e = cat && db.prepare('SELECT * FROM events WHERE ticker=? AND category=?').get(String(req.params.event).toUpperCase(), cat);
    if (!e) throw E.notFound();
    res.json({ underlying: underlyingOf(eventFull(e)) });
  });
  function bannerOf(cat, cfg, req) {
    const b = cfg.banner;
    if (!b || !b.enabled) return null;
    const key = slugOf(cat);
    const dflt = (k) => (cat === 'Crypto' ? S(`banner.crypto.${k}`) : '');
    const out = { version: b.version, title: b.title || dflt('title'), body: b.body || dflt('body'), cta_label: b.cta_label || dflt('cta'), cta_href: b.cta_href, link_label: b.link_label || dflt('link'), link_href: b.link_href, key };
    if (!out.title) return null;
    if (req.auth) { const d = db.prepare('SELECT banner_version v FROM category_banner_dismissals WHERE user_id=? AND category=?').get(req.auth.user.id, cat); if (d && d.v >= b.version) return null; }
    return out;
  }
  v1.post('/bff/category/:slug/banner/dismiss', (req, res) => {
    const cat = fromSlug(String(req.params.slug));
    if (!cat) throw E.notFound();
    if (!req.auth) throw E.unauthorized();
    const v = configOf(cat).banner.version;
    db.prepare('INSERT INTO category_banner_dismissals(user_id,category,banner_version,created_at) VALUES(?,?,?,?) ON CONFLICT(user_id,category) DO UPDATE SET banner_version=excluded.banner_version, created_at=excluded.created_at').run(req.auth.user.id, cat, v, nowIso());
    res.json({ ok: true, banner_version: v });
  });

  // ---------------------------------------------------------------- admin
  const FIELDS = ['layout', 'carousel_size', 'pins', 'exclude', 'grouping', 'groups', 'hub', 'top_cities', 'docked_ticket', 'outcome_avatars', 'banner'];
  const help = () => Object.fromEntries(FIELDS.map((k) => [k, { label: k === 'groups' ? S('admin.grouping.label') : S(`admin.${k}.label`), help: S(`admin.${k}.help`) }]));
  const history = (cat) => db.prepare("SELECT ts, actor_email, reason FROM admin_audit WHERE action='category_pages.update' AND target_id=? ORDER BY ts DESC LIMIT 30").all(cat).map((h) => ({ time: new Date(h.ts).toISOString(), actor_email: h.actor_email, reason: h.reason }));
  const adminVo = (cat) => {
    const cfg = configOf(cat); const s = stored(cat);
    const series = seriesOf(cat);
    return { category: { name: cat, slug: slugOf(cat) }, config: cfg, customised: !!s, updated_at: s ? s._updated_at : null, defaults: defaults(cat), effective_layout: layoutOf(cfg),
      site: { layout: setting('category.layout', 'new'), carousel_size: setting('category.carousel_size', 3) }, help: help(), glyphs: GLYPHS, filter_types: FILTER_TYPES, kinds: KINDS,
      series: series.map((x) => ({ ticker: x.ticker, title: x.title, tags: x.tags, frequency: x.frequency })), auto_groups: autoGroups(cat, series).map(({ id, label, filter }) => ({ id, label, filter })),
      featured_now: featuredOf(cat, cfg).map((e) => ({ event_ticker: e.event_ticker, title: e.title, pinned: e.pinned })), history: history(cat) };
  };
  v1.get('/admin/category_pages', can('content.write'), (req, res) => res.json({ categories: CATEGORIES.map((c) => { const s = stored(c); return { name: c, slug: slugOf(c), customised: !!s, layout: layoutOf(configOf(c)), updated_at: s ? s._updated_at : null }; }), site: { layout: setting('category.layout', 'new'), carousel_size: setting('category.carousel_size', 3) } }));
  v1.get('/admin/category_pages/:slug', can('content.write'), (req, res) => { const cat = fromSlug(String(req.params.slug)); if (!cat) throw E.notFound(); res.json(adminVo(cat)); });
  v1.put('/admin/category_pages/:slug', can('content.write'), (req, res) => {
    const cat = fromSlug(String(req.params.slug));
    if (!cat) throw E.notFound();
    const b = req.body || {};
    const reason = String(b.reason || '').trim();
    if (reason.length < 3 || reason.length > 500) throw bad('reason', 'a reason of 3-500 characters is required');
    const before = stored(cat);
    const prev = configOf(cat);
    if (b.reset === true) {
      db.prepare('DELETE FROM category_page_config WHERE category=?').run(cat);
      admin.audit(req, 'category_pages.update', 'category', cat, before, null, reason);
      return res.json(adminVo(cat));
    }
    const next = validate(cat, b.config, db);
    // A changed banner text shows the banner again to everyone who dismissed the earlier one.
    const textOf = (x) => JSON.stringify([x.title, x.body, x.cta_label, x.cta_href, x.link_label, x.link_href, x.enabled]);
    next.banner.version = textOf(next.banner) !== textOf(prev.banner) ? (prev.banner.version || 1) + 1 : prev.banner.version || 1;
    tx(db, () => {
      db.prepare('INSERT INTO category_page_config(category,config,version,updated_at,updated_by) VALUES(?,?,1,?,?) ON CONFLICT(category) DO UPDATE SET config=excluded.config, version=version+1, updated_at=excluded.updated_at, updated_by=excluded.updated_by')
        .run(cat, JSON.stringify(next), nowIso(), req.auth.user.id);
      admin.audit(req, 'category_pages.update', 'category', cat, before, next, reason);
    });
    res.json(adminVo(cat));
  });

  // ---------------------------------------------------------------- invented seed markets (npm start; tests opt in)
  const lpId = () => db.prepare("SELECT id FROM users WHERE email='liquidity@parlance.local'").get()?.id;
  function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  const hash = (str) => { let h = 2166136261; for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  const iso = (ms) => new Date(ms).toISOString();
  function tzOffsetMs(ms, tz) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second)) - Math.floor(ms / 1000) * 1000;
  }
  const endOfDay = (key) => { const guess = Date.parse(`${key}T23:59:00Z`); return guess - tzOffsetMs(guess, C.config().timezone || 'Africa/Lagos'); };
  const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const stamp = (key) => `${key.slice(2, 4)}${MON[Number(key.slice(5, 7)) - 1]}${key.slice(8, 10)}`;
  const ensureSeries = (t, title, tags, freq, rules) => {
    if (db.prepare('SELECT 1 FROM series WHERE ticker=?').get(t)) return;
    db.prepare('INSERT INTO series(ticker,title,slug,category,tags,frequency,fee_type,fee_multiplier,settlement_sources,rules) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(t, title, title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), t === CRUDE ? 'Financials' : 'Climate and Weather', JSON.stringify(tags), freq, 'quadratic', 1, JSON.stringify([{ name: 'Parlance Weather Desk', url: 'https://example.org/weather' }]), rules);
  };
  // An event with its markets, a day of hourly prints ending at the fair price (history only) and resting liquidity.
  function addEvent({ ticker, series, title, sub, category, mutually, markets, openMs, closeMs, rules, r }) {
    db.prepare("INSERT INTO events(ticker,series_ticker,title,sub_title,category,mutually_exclusive,is_live,live_label,news,featured,created_at) VALUES(?,?,?,?,?,?,0,'','',0,?)").run(ticker, series, title, sub, category, mutually ? 1 : 0, iso(openMs));
    for (const m of markets) {
      db.prepare(`INSERT INTO markets(ticker,event_ticker,title,yes_sub_title,no_sub_title,color,status,open_time,close_time,expected_expiration_time,settlement_timer_seconds,rules_primary,created_at,updated_at,fractional_trading_enabled,floor_strike)
        VALUES(?,?,?,?,?,?,'active',?,?,?,5,?,?,?,1,?)`).run(m.t, ticker, markets.length > 1 ? `${title} — ${m.yes}` : title, m.yes, m.no, m.color || '#3a7bff', iso(openMs), iso(closeMs), iso(closeMs + H), rules, nowIso(), nowIso(), m.strike ?? null);
      let p = m.fair; const path = [];
      for (let i = 0; i < 24; i++) { path.unshift(p); p = Math.max(2, Math.min(98, p + Math.round((r() - 0.5) * 6))); }
      const now = Date.now();
      path.forEach((px, i) => db.prepare('INSERT INTO trades(id,market_ticker,yes_price_cents,yes_price_cc,count,taker_side,created_ts) VALUES(?,?,?,?,?,?,?)').run(newId('t_'), m.t, px, px * 100, (5 + Math.floor(r() * 120)) * UNITS, r() > 0.5 ? 'yes' : 'no', now - (24 - i) * H));
    }
  }
  // Resting liquidity on both sides around the last print, through the engine (reservations are journaled).
  function liquidity(lp, tickers) {
    for (const t of tickers) {
      const fm = db.prepare('SELECT yes_price_cents p FROM trades WHERE market_ticker=? ORDER BY created_ts DESC LIMIT 1').get(t)?.p ?? 50;
      try { engine.placeOrder(lp, { ticker: t, side: 'yes', price_cc: Math.max(1, fm - 2) * 100, count: 200 * UNITS, post_only: true, source: 'liquidity' }); } catch { /* liquidity optional */ }
      try { engine.placeOrder(lp, { ticker: t, side: 'no', price_cc: Math.max(1, 100 - (fm + 2)) * 100, count: 200 * UNITS, post_only: true, source: 'liquidity' }); } catch { /* liquidity optional */ }
    }
  }
  const COLORS = ['#3a7bff', '#2fd18b', '#f59f00', '#be4bdb'];
  function ensureCityDay(lp, [code, city, base, rain], key, openMs) {
    const hiT = `PLXHI${code}-${stamp(key)}`;
    if (db.prepare('SELECT 1 FROM events WHERE ticker=?').get(hiT)) return false;
    const closeMs = endOfDay(key);
    const date = C.dateLabel(closeMs - H);
    const r = rng(hash(code + key));
    const b = base + Math.round((r() - 0.5) * 2);
    const raw = [12 + r() * 6, 30 + r() * 14, 26 + r() * 12, 8 + r() * 6];
    const sum = raw.reduce((a, x) => a + x, 0);
    const fair = raw.map((x) => Math.max(3, Math.min(90, Math.round((x / sum) * 100))));
    const labels = [`≤${b - 2}°`, `${b - 1}–${b}°`, `${b + 1}–${b + 2}°`, `≥${b + 3}°`];
    const series = `PLXHI${code}`;
    ensureSeries(series, S('seed.high.series', { city }), ['Daily temperature', city], 'daily', S('seed.high.series_rules', { city }));
    ensureSeries(RAIN_SERIES, S('seed.rain.series'), ['Rain'], 'daily', S('seed.rain.series_rules'));
    tx(db, () => {
      addEvent({ ticker: hiT, series, title: S('seed.high.title', { city, date }), sub: S('seed.high.sub', { city }), category: 'Climate and Weather', mutually: true, openMs, closeMs, rules: S('seed.high.rules', { city, date }), r,
        markets: labels.map((l, i) => ({ t: `${hiT}-B${i + 1}`, yes: l, no: S('seed.high.no', { bracket: l }), fair: fair[i], color: COLORS[i] })) });
      const rnT = `${RAIN_SERIES}-${stamp(key)}${code}`;
      addEvent({ ticker: rnT, series: RAIN_SERIES, title: S('seed.rain.title', { city, date }), sub: S('seed.rain.sub', { city }), category: 'Climate and Weather', mutually: false, openMs, closeMs, rules: S('seed.rain.rules', { city, date }), r,
        markets: [{ t: rnT, yes: S('seed.rain.yes'), no: S('seed.rain.no'), fair: Math.max(3, Math.min(95, rain + Math.round((r() - 0.5) * 20))), color: '#1c7ed6' }] });
      db.prepare('INSERT OR IGNORE INTO category_city_events(event_ticker,city,day,kind) VALUES(?,?,?,?)').run(hiT, code, key, 'high');
      db.prepare('INSERT OR IGNORE INTO category_city_events(event_ticker,city,day,kind) VALUES(?,?,?,?)').run(rnT, code, key, 'rain');
    });
    liquidity(lp, [...labels.map((_, i) => `${hiT}-B${i + 1}`), `${RAIN_SERIES}-${stamp(key)}${code}`]);
    return true;
  }
  function rollCities() {
    const lp = lpId();
    if (!lp) return;
    const now = Date.now();
    for (const [i, key] of [C.dayKey(now), C.dayKey(now + D)].entries()) for (const c of CITIES) ensureCityDay(lp, c, key, i ? now : now - 6 * H);
  }
  function ensureCrude() {
    const lp = lpId();
    if (!lp || db.prepare('SELECT 1 FROM series WHERE ticker=?').get(CRUDE)) return;
    const r = rng(20261115);
    const now = Date.now();
    const pts = []; let p = 8856;
    for (let i = 0; i < 7 * 24; i++) { pts.unshift(p); p = Math.max(6000, Math.min(14000, p + Math.round((r() - 0.5) * 120))); }
    const d = new Date(now); const closeMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 0, 22, 0);
    const strikes = [[9001, 46], [9501, 27], [10001, 14], [10501, 7]];
    tx(db, () => {
      ensureSeries(CRUDE, S('seed.crude.series'), ['Commodities', 'Oil & Gas'], 'monthly', S('seed.crude.series_rules'));
      pts.forEach((v, i) => db.prepare('INSERT OR REPLACE INTO underlying_prices(series_ticker,ts,price) VALUES(?,?,?)').run(CRUDE, now - (7 * 24 - i) * H, v));
      const et = `${CRUDE}-${stamp(C.dayKey(closeMs))}`;
      addEvent({ ticker: et, series: CRUDE, title: S('seed.crude.title'), sub: S('seed.crude.sub'), category: 'Financials', mutually: false, openMs: now - 10 * D, closeMs, rules: S('seed.crude.rules', { price: C.moneyCents(strikes[0][0]) }), r,
        markets: strikes.map(([k, f], i) => ({ t: `${et}-T${k}`, yes: S('seed.crude.yes', { price: C.moneyCents(k) }), no: S('seed.crude.no', { price: C.moneyCents(k) }), fair: f, color: COLORS[i], strike: k })) });
    });
    liquidity(lp, strikes.map(([k]) => `${CRUDE}-${stamp(C.dayKey(closeMs))}-T${k}`));
  }
  let lastRoll = 0; let lastCrude = 0;
  function stepCrude(now) {
    const last = db.prepare('SELECT price p FROM underlying_prices WHERE series_ticker=? ORDER BY ts DESC LIMIT 1').get(CRUDE);
    if (!last) return;
    db.prepare('INSERT OR REPLACE INTO underlying_prices(series_ticker,ts,price) VALUES(?,?,?)').run(CRUDE, now, Math.max(6000, Math.min(14000, Math.round(last.p + (Math.random() - 0.5) * 30))));
    db.prepare('DELETE FROM underlying_prices WHERE series_ticker=? AND ts<?').run(CRUDE, now - 30 * D);
  }
  if (options.seed) {
    try { ensureCrude(); rollCities(); } catch (e) { console.error('category seed', e); }
    engine.on('tick', () => {
      const now = Date.now();
      try {
        if (now - lastCrude >= 60000) { lastCrude = now; stepCrude(now); }
        if (now - lastRoll >= 60000) { lastRoll = now; rollCities(); }
      } catch (e) { console.error('category seed tick', e); }
    });
  }
  return { configOf, layoutOf, rollCities, stepCrude, ensureCrude, CITIES, defaults };
}

module.exports = { mountCategoryPages, validate, defaults, CITIES, GLYPHS };
