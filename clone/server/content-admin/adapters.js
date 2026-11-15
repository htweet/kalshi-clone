'use strict';
// The built-in content types of the registry (CLONE_SPEC.md §43). Every adapter writes through the owning module's own
// validation (the CMS store, admin.js collection checks, or the existing admin route, called internally with
// registry.dispatch) and its audit row; revisions follow from the audit listener in ./index.js.
//
//   CMS store (history: the store's own versions, restore = rollback; publish needs content.publish)
//     page (pages and help guides), text, template (notification, email and SMS templates), media (slots), footer,
//     brand, incident (status page), survey (waitlist survey questions). Trash only for items without a code default
//     (custom pages, incidents, custom survey questions); built-in ones are reset or hidden instead.
//   Admin › Content collections (content.write): banners, promos (promo cards), info_cards, news, help (the §18.5 help
//     collection), hubs (home hub tiles); nav and hero (singletons: edit, history, restore).
//   Catalog copy (catalog.write): catalog_series / catalog_events / catalog_markets — title, rules and descriptions only
//     (never prices or trading state); drafts can be trashed, published ones cannot (market ops pause or close them).
//   Elections (catalog.write): election_parties, election_candidates, election_races, election_elections text fields.
//   Promo codes (users.money): description and on/off; unused codes can be trashed.
const { E, ApiError, nowIso } = require('../util');
const { s: S } = require('../content/content-admin');
const { PAGES } = require('../content/pages');
const { SURVEY_DEFAULTS } = require('../content/waitlists');
const { CATEGORIES } = require('../features');
const texts = require('../cms/texts');
const templates = require('../cms/templates');

const CONTENT = { read: 'content.write', write: 'content.write', publish: 'content.write', purge: 'content.publish' };
const CMS = { read: 'content.write', write: 'content.write', publish: 'content.publish', purge: 'content.publish' };
const CATALOG = { read: 'catalog.read', write: 'catalog.write', publish: 'catalog.write', purge: 'catalog.write' };
const MONEY = { read: 'users.money', write: 'users.money', publish: 'users.money', purge: 'users.money' };
const COMBO_SERIES = 'PLXCOMBO'; const FLASH_SERIES = 'PLXFLASH';
const now = () => Date.now();
const future = (t) => !!t && Date.parse(t) > now();
const past = (t) => !!t && Date.parse(t) <= now();
const short = (s, n = 90) => { const x = String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
const notFound = () => new ApiError(404, 'not_found', S('error.not_found'));

function registerBuiltins({ registry, db, app, admin, dispatch }) {
  const reinsert = (table, row) => {
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
  };

  // ================================================================ CMS store types
  const cms = () => app.locals.cms;
  const store = () => cms().store;
  const entryRows = (type, key) => db.prepare('SELECT * FROM cms_entries WHERE type=? AND key=?').all(type, key);
  function cmsType(type, { title, list, defaultOf = () => null, editor, trashable = (key) => !defaultOf(key), stepUp = () => false, hiddenOf = () => false }) {
    const status = (e, key) => (e.scheduled ? 'scheduled' : e.has_draft ? 'draft' : e.published == null && !defaultOf(key) ? 'hidden' : hiddenOf(e.published ?? defaultOf(key)) ? 'hidden' : 'published');
    const vo = (key) => {
      const e = store().get(type, key);
      const value = e.draft ?? e.published ?? defaultOf(key);
      const at = [e.draft_time, e.published_time].filter(Boolean).sort().pop() || null;
      return { key, title: title(key, value) || key, status: status(e, key), updated_at: at, updated_by: at && at === e.draft_time ? e.draft_by : e.published_by, data: value, exists: e.published != null || e.has_draft || !!e.scheduled || !!defaultOf(key) };
    };
    registry.register({
      type, perms: CMS, history: 'cms', editor,
      pick: (v) => v,
      list: ({ q }) => list(q).map((key) => vo(key)).filter((x) => x.exists).map(({ data, exists, ...rest }) => { void data; void exists; return rest; }),
      get: (key) => { const x = vo(key); if (!x.exists) return null; const { exists, ...rest } = x; void exists; return rest; },
      rollback: (req, key, version, reason, locale) => store().rollback(req, type, key, { version, reason, locale }),
      setPublished: (req, key, on, reason) => {
        if (on) return store().publish(req, type, key, { reason });
        if (defaultOf(key)) throw E.conflict('cannot_publish', S('error.cannot_publish'));
        return store().publish(req, type, key, { reason, value: null }); // a custom page, incident or question: off the site
      },
      trash: {
        refuse: (key) => (trashable(key) ? null : S('why.built_in')),
        take: (key) => { const rows = entryRows(type, key); db.prepare('DELETE FROM cms_entries WHERE type=? AND key=?').run(type, key); return { entries: rows }; },
        put: (snap, key) => { if (entryRows(type, key).length) throw E.conflict('key_taken', S('error.key_taken', { key })); for (const r of snap.entries || []) reinsert('cms_entries', r); },
        stepUp: (snap) => stepUp(snap),
      },
      changed: (key) => { try { store().handler(type).changed?.(key); } catch (e) { console.error('cms changed', type, e.message); } },
    });
  }
  const keysOf = (type) => db.prepare('SELECT DISTINCT key FROM cms_entries WHERE type=?').all(type).map((r) => r.key);
  const legalSnap = (snap) => (snap.entries || []).some((r) => { for (const j of [r.published_json, r.draft_json, r.scheduled_json]) { try { if (j && JSON.parse(j)?.section === 'legal') return true; } catch { /* not JSON */ } } return false; });
  cmsType('page', {
    title: (key, v) => v?.title, list: () => [...new Set([...Object.keys(PAGES), ...keysOf('page')])], defaultOf: (key) => PAGES[key] || null,
    editor: () => '/admin/cms/pages', stepUp: legalSnap, hiddenOf: (v) => !!(v && v.hidden),
  });
  cmsType('text', {
    title: (key, v) => short(v, 70), editor: (key) => `/admin/cms/texts?q=${encodeURIComponent(key)}`,
    defaultOf: (key) => texts.load().get(key)?.default ?? null, trashable: () => false,
    list: (q) => { const own = keysOf('text'); if (!q || q.length < 3) return own; const extra = []; for (const e of texts.load().values()) { if (extra.length >= 40) break; if (e.key.toLowerCase().includes(q) || e.default.toLowerCase().includes(q)) extra.push(e.key); } return [...new Set([...own, ...extra])]; },
  });
  cmsType('template', { title: (key) => templates.definition(key)?.label || key, list: () => templates.list().map((t) => t.key), defaultOf: (key) => templates.definition(key)?.defaults || null, editor: () => '/admin/cms/templates', trashable: () => false });
  cmsType('media', { title: (key) => cms().SLOTS[key]?.label || key, list: () => Object.keys(cms().SLOTS), defaultOf: (key) => (cms().SLOTS[key] ? { builtin: true } : null), editor: () => '/admin/cms/media', trashable: () => false });
  cmsType('footer', { title: () => S('type.footer'), list: () => ['links'], defaultOf: () => ({ builtin: true }), editor: () => '/admin/cms/pages', trashable: () => false });
  cmsType('brand', { title: () => S('type.brand'), list: () => ['theme'], defaultOf: () => ({ builtin: true }), editor: () => '/admin/cms/branding', trashable: () => false });
  cmsType('incident', { title: (key, v) => v?.title, list: () => keysOf('incident'), editor: () => '/admin/status' });
  cmsType('survey', { title: (key, v) => short(v?.prompt), list: () => [...new Set([...Object.keys(SURVEY_DEFAULTS), ...keysOf('survey')])], defaultOf: (key) => SURVEY_DEFAULTS[key] || null, editor: () => '/admin/waitlists', hiddenOf: (v) => !!(v && v.active === false) });

  // ================================================================ Admin › Content collections
  const COLL = admin.content.COLL;
  const opts = (list) => list.map((x) => [x, x]);
  const FIELDS = {
    banners: [{ name: 'content', kind: 'textarea', max: 240 }, { name: 'link', kind: 'text', max: 400 }, { name: 'visibility', kind: 'select', options: opts(['all', 'logged_in', 'logged_out']) }, { name: 'position', kind: 'select', options: opts(['top', 'bottom']) },
      { name: 'starts_at', kind: 'datetime', nullable: true }, { name: 'ends_at', kind: 'datetime', nullable: true }, { name: 'active', kind: 'bool' }],
    promos: [{ name: 'overline', kind: 'text', max: 30 }, { name: 'title', kind: 'text', max: 80 }, { name: 'subtitle', kind: 'text', max: 140 }, { name: 'link', kind: 'text', max: 400 }, { name: 'color', kind: 'color' },
      { name: 'starts_at', kind: 'datetime', nullable: true }, { name: 'ends_at', kind: 'datetime', nullable: true }, { name: 'position', kind: 'int' }, { name: 'active', kind: 'bool' }],
    info_cards: [{ name: 'title', kind: 'text', max: 40 }, { name: 'subtitle', kind: 'text', max: 80 }, { name: 'link', kind: 'text', max: 400 }, { name: 'icon', kind: 'select', options: opts(['shield', 'bars', 'clock', 'star', 'info']) }, { name: 'position', kind: 'int' }, { name: 'active', kind: 'bool' }],
    news: [{ name: 'event_ticker', kind: 'text', max: 64 }, { name: 'source', kind: 'text', max: 40 }, { name: 'published_at', kind: 'datetime' }, { name: 'headline', kind: 'text', max: 160 }, { name: 'summary', kind: 'textarea', max: 800 }, { name: 'active', kind: 'bool' }],
    help: [{ name: 'slug', kind: 'text', max: 60 }, { name: 'title', kind: 'text', max: 100 }, { name: 'body', kind: 'textarea', max: 20000 }, { name: 'published', kind: 'bool' }, { name: 'position', kind: 'int' }, { name: 'active', kind: 'bool' }],
    hubs: [{ name: 'title', kind: 'text', max: 60 }, { name: 'category', kind: 'select', options: opts(CATEGORIES) }, { name: 'position', kind: 'int' }, { name: 'active', kind: 'bool' }],
  };
  const TITLE = { banners: (r) => short(r.content), promos: (r) => r.title, info_cards: (r) => r.title, news: (r) => r.headline, help: (r) => r.title, hubs: (r) => r.title };
  const STATUS = {
    banners: (r) => (!r.active || past(r.ends_at) ? 'hidden' : future(r.starts_at) ? 'scheduled' : 'published'),
    promos: (r) => (!r.active || past(r.ends_at) ? 'hidden' : future(r.starts_at) ? 'scheduled' : 'published'),
    help: (r) => (!r.active ? 'hidden' : !r.published ? 'draft' : 'published'),
  };
  for (const name of Object.keys(FIELDS)) {
    const c = COLL[name];
    const row = (id) => db.prepare(`SELECT * FROM ${c.table} WHERE id=?`).get(String(id));
    const vo = (r) => ({ key: r.id, title: TITLE[name](r) || r.id, status: (STATUS[name] || ((x) => (x.active ? 'published' : 'hidden')))(r), updated_at: r.updated_at || r.created_at });
    const update = (req, key, data, reason) => {
      const cur = row(key);
      if (!cur) throw notFound();
      const v = admin.content.validate(name, data, cur, cur.id);
      const cols = Object.keys(c.fields);
      db.prepare(`UPDATE ${c.table} SET ${cols.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`).run(...cols.map((k) => v[k]), nowIso(), cur.id);
      admin.audit(req, `content.${name}.update`, name, cur.id, cur, row(cur.id), reason);
    };
    registry.register({
      type: name, perms: CONTENT, fields: FIELDS[name], editor: () => `/admin/content/${name}`,
      list: () => db.prepare(`SELECT * FROM ${c.table}`).all().map(vo),
      get: (key) => { const r = row(key); return r ? { ...vo(r), data: registry.types.get(name).pick(r) } : null; },
      update,
      setPublished: (req, key, on, reason) => update(req, key, name === 'help' ? { active: on, published: on } : { active: on }, reason),
      trash: {
        take: (key) => { const r = row(key); db.prepare(`DELETE FROM ${c.table} WHERE id=?`).run(r.id); return { row: r }; },
        put: (snap) => {
          if (name === 'help' && db.prepare('SELECT 1 FROM cms_help WHERE slug=?').get(snap.row.slug)) throw E.conflict('key_taken', S('error.key_taken', { key: snap.row.slug }));
          reinsert(c.table, snap.row);
        },
        stepUp: () => name === 'news', // market news is published market content: deleting it for good needs a step-up
      },
      auditMatch: (e) => (e.target_type === name && /^content\.[a-z_]+\.(create|update)$/.test(e.action) ? e.target_id : null),
    });
  }
  // Singletons: category navigation and the home hero carousel (edit, history, restore; nothing to trash).
  registry.register({
    type: 'nav', perms: CONTENT, editor: () => '/admin/content/nav',
    pick: (v) => (v && v.categories ? { categories: v.categories, featured: v.featured } : null),
    list: () => [{ key: 'categories', title: S('type.nav'), status: 'published', updated_at: db.prepare("SELECT updated_at FROM admin_settings WHERE key='featured_tab'").get()?.updated_at || null }],
    get: (key) => (key === 'categories' ? { key, title: S('type.nav'), status: 'published', data: admin.content.navConfig() } : null),
    update: (req, key, data, reason) => dispatch(req, 'PUT', '/admin/nav', { categories: data.categories, featured: data.featured, reason }),
    auditMatch: (e) => (e.action === 'content.nav.set' ? 'categories' : null),
  });
  const heroList = () => db.prepare('SELECT event_ticker FROM cms_hero ORDER BY position').all().map((r) => r.event_ticker);
  registry.register({
    type: 'hero', perms: CONTENT, editor: () => '/admin/content/hero',
    pick: (v) => (Array.isArray(v) ? { event_tickers: v } : v && Array.isArray(v.event_tickers) ? { event_tickers: v.event_tickers } : null),
    list: () => [{ key: 'home', title: S('type.hero'), status: heroList().length ? 'published' : 'hidden', updated_at: null }],
    get: (key) => (key === 'home' ? { key, title: S('type.hero'), status: heroList().length ? 'published' : 'hidden', data: { event_tickers: heroList() } } : null),
    update: (req, key, data, reason) => dispatch(req, 'PUT', '/admin/hero', { event_tickers: data.event_tickers || [], reason }),
    auditMatch: (e) => (e.action === 'content.hero.set' ? 'home' : null),
  });

  // ================================================================ promo codes (users.money)
  const promo = (id) => db.prepare('SELECT * FROM promo_codes WHERE id=?').get(String(id));
  const promoStatus = (p) => (!p.active || past(p.ends_at) ? 'hidden' : future(p.starts_at) ? 'scheduled' : 'published');
  const hasPromos = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='promo_codes'").get();
  if (hasPromos) registry.register({
    type: 'promo_codes', perms: MONEY, editor: () => '/admin/promos',
    fields: [{ name: 'description', kind: 'text', max: 140 }, { name: 'active', kind: 'bool' }],
    pick: (v) => (v ? { description: v.description ?? '', active: !!v.active } : null),
    list: () => db.prepare('SELECT * FROM promo_codes ORDER BY created_at DESC LIMIT 1000').all().map((p) => ({ key: p.id, title: `${p.code}${p.description ? ` · ${p.description}` : ''}`, status: promoStatus(p), updated_at: p.created_at })),
    get: (key) => { const p = promo(key); return p ? { key: p.id, title: `${p.code}${p.description ? ` · ${p.description}` : ''}`, status: promoStatus(p), updated_at: p.created_at, data: { description: p.description, active: !!p.active } } : null; },
    update: (req, key, data, reason) => dispatch(req, 'PUT', `/admin/promo_codes/${encodeURIComponent(key)}`, { ...data, reason }),
    setPublished: (req, key, on, reason) => dispatch(req, 'PUT', `/admin/promo_codes/${encodeURIComponent(key)}`, { active: on, reason }),
    trash: {
      refuse: (key) => { const p = promo(key); return p.redeemed_count > 0 || db.prepare('SELECT 1 FROM promo_redemptions WHERE promo_id=?').get(p.id) ? S('why.redeemed') : null; },
      take: (key) => { const p = promo(key); db.prepare('DELETE FROM promo_codes WHERE id=?').run(p.id); return { row: p }; },
      put: (snap) => { if (db.prepare('SELECT 1 FROM promo_codes WHERE code=?').get(snap.row.code)) throw E.conflict('key_taken', S('error.key_taken', { key: snap.row.code })); reinsert('promo_codes', snap.row); },
    },
    auditMatch: (e) => (e.target_type === 'promo_code' && /^promo\./.test(e.action) ? e.target_id : null),
  });

  // ================================================================ catalog copy (series, events, markets)
  const KIND = {
    series: { draft: 'cms_draft_series', live: 'series', audit: 'series', fields: [{ name: 'title', kind: 'text', max: 100 }, { name: 'rules', kind: 'textarea', max: 4000 }],
      title: (r) => r.title, liveRows: (q) => db.prepare("SELECT * FROM series WHERE ticker<>? AND (?='' OR lower(ticker) LIKE ? OR lower(title) LIKE ?) ORDER BY rowid DESC LIMIT 1000").all(COMBO_SERIES, q, `%${q}%`, `%${q}%`),
      children: (t) => (db.prepare('SELECT 1 FROM cms_draft_events WHERE series_ticker=?').get(t) ? 'draft events' : null) },
    events: { draft: 'cms_draft_events', live: 'events', audit: 'event', fields: [{ name: 'title', kind: 'text', max: 140 }, { name: 'sub_title', kind: 'text', max: 140 }, { name: 'live_label', kind: 'text', max: 40 }, { name: 'news', kind: 'textarea', max: 600 }],
      title: (r) => r.title, liveRows: (q) => db.prepare("SELECT * FROM events WHERE series_ticker NOT IN (?,?) AND (?='' OR lower(ticker) LIKE ? OR lower(title) LIKE ?) ORDER BY rowid DESC LIMIT 1000").all(COMBO_SERIES, FLASH_SERIES, q, `%${q}%`, `%${q}%`),
      children: (t) => (db.prepare('SELECT 1 FROM cms_draft_markets WHERE event_ticker=?').get(t) ? 'draft markets' : null) },
    markets: { draft: 'cms_draft_markets', live: 'markets', audit: 'market', fields: [{ name: 'title', kind: 'text', max: 200 }, { name: 'yes_sub_title', kind: 'text', max: 80 }, { name: 'no_sub_title', kind: 'text', max: 80 }, { name: 'rules_primary', kind: 'textarea', max: 4000 }],
      title: (r) => (r.yes_sub_title && r.title && !r.title.includes(r.yes_sub_title) ? `${r.title} — ${r.yes_sub_title}` : r.title || r.yes_sub_title),
      liveRows: (q) => db.prepare("SELECT m.* FROM markets m JOIN events e ON e.ticker=m.event_ticker WHERE e.series_ticker NOT IN (?,?) AND (?='' OR lower(m.ticker) LIKE ? OR lower(m.title) LIKE ? OR lower(m.yes_sub_title) LIKE ?) ORDER BY m.rowid DESC LIMIT 1000").all(COMBO_SERIES, FLASH_SERIES, q, `%${q}%`, `%${q}%`, `%${q}%`),
      children: () => null },
  };
  for (const [kind, k] of Object.entries(KIND)) {
    const type = `catalog_${kind}`;
    const draft = (t) => db.prepare(`SELECT * FROM ${k.draft} WHERE ticker=?`).get(String(t).toUpperCase());
    const live = (t) => db.prepare(`SELECT * FROM ${k.live} WHERE ticker=?`).get(String(t).toUpperCase());
    const vo = (r, state) => ({ key: r.ticker, title: k.title(r) || r.ticker, status: state === 'draft' ? 'draft' : kind === 'markets' && r.status === 'initialized' ? 'scheduled' : 'published', updated_at: r.updated_at || r.created_at || null });
    registry.register({
      type, perms: CATALOG, fields: k.fields, editor: () => `/admin/catalog/${kind}`,
      list: ({ q }) => [...db.prepare(`SELECT * FROM ${k.draft} ORDER BY created_at DESC`).all().map((r) => vo(r, 'draft')), ...k.liveRows(String(q || '').toLowerCase()).map((r) => vo(r, 'published'))],
      get: (key) => { const d = draft(key); const r = d || live(key); return r ? { ...vo(r, d ? 'draft' : 'published'), data: registry.types.get(type).pick(r) } : null; },
      update: (req, key, data, reason) => dispatch(req, 'PUT', `/admin/catalog/${kind}/${encodeURIComponent(key)}`, { ...data, reason }),
      setPublished: (req, key, on, reason) => {
        if (!on || !draft(key)) throw E.conflict('cannot_publish', S('error.cannot_publish'));
        return dispatch(req, 'POST', `/admin/catalog/${kind}/${encodeURIComponent(key)}/publish`, { reason });
      },
      trash: {
        refuse: (key) => { if (!draft(key)) return S('why.published'); const c = k.children(String(key).toUpperCase()); return c ? S('why.has_children', { children: c }) : null; },
        take: (key) => { const r = draft(key); db.prepare(`DELETE FROM ${k.draft} WHERE ticker=?`).run(r.ticker); return { row: r }; },
        put: (snap) => { const t = snap.row.ticker; if (draft(t) || live(t)) throw E.conflict('key_taken', S('error.key_taken', { key: t })); reinsert(k.draft, snap.row); },
      },
      auditMatch: (e) => (new RegExp(`^catalog\\.${k.audit}\\.(create|update)$`).test(e.action) ? e.target_id : null),
    });
  }

  // ================================================================ elections (parties, candidates, races, elections)
  const hasElections = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='el_parties'").get();
  const EL = {
    parties: { table: 'el_parties', fields: [{ name: 'name', kind: 'text', max: 80 }, { name: 'short_name', kind: 'text', max: 12 }, { name: 'coalition', kind: 'text', max: 80, nullable: true }, { name: 'color', kind: 'color' }, { name: 'active', kind: 'bool' }],
      title: (r) => `${r.name} (${r.country})`, status: (r) => (r.active ? 'published' : 'hidden'), publish: true },
    candidates: { table: 'el_candidates', fields: [{ name: 'name', kind: 'text', max: 80, nullable: true }, { name: 'running_mate', kind: 'text', max: 80, nullable: true }],
      title: (r) => `${r.name || db.prepare('SELECT name FROM el_parties WHERE id=?').get(r.party_id)?.name || r.party_id} · ${db.prepare('SELECT name FROM el_races WHERE id=?').get(r.race_id)?.name || r.race_id}`, status: () => 'published' },
    races: { table: 'el_races', fields: [{ name: 'name', kind: 'text', max: 120 }, { name: 'featured', kind: 'bool' }], title: (r) => r.name, status: () => 'published' },
    elections: { table: 'el_elections', fields: [{ name: 'title', kind: 'text', max: 120 }, { name: 'active', kind: 'bool' }], title: (r) => r.title, status: (r) => (r.active ? 'published' : 'hidden'), publish: true },
  };
  if (hasElections) for (const [kind, x] of Object.entries(EL)) {
    const type = `election_${kind}`;
    const row = (id) => db.prepare(`SELECT * FROM ${x.table} WHERE id=?`).get(String(id));
    const vo = (r) => ({ key: r.id, title: x.title(r), status: x.status(r), updated_at: r.updated_ts ? new Date(r.updated_ts).toISOString() : null });
    const put = (req, key, data, reason) => dispatch(req, 'PUT', `/admin/elections/${kind}/${encodeURIComponent(key)}`, { ...data, reason });
    registry.register({
      type, perms: CATALOG, fields: x.fields, editor: () => '/admin/elections/data',
      list: () => db.prepare(`SELECT * FROM ${x.table} ORDER BY rowid`).all().map(vo),
      get: (key) => { const r = row(key); return r ? { ...vo(r), data: registry.types.get(type).pick(r) } : null; },
      update: (req, key, data, reason) => put(req, key, Object.fromEntries(Object.entries(data).map(([f, v]) => [f, x.fields.find((y) => y.name === f)?.kind === 'bool' ? !!v : v])), reason),
      ...(x.publish ? { setPublished: (req, key, on, reason) => put(req, key, { active: on }, reason) } : {}),
      auditMatch: (e) => (e.target_type === type && /^elections\.[a-z]+\.(create|update)$/.test(e.action) ? e.target_id : null),
    });
  }
}

module.exports = { registerBuiltins };
