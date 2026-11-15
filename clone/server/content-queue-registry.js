'use strict';
// The content queue's types in the content registry (CLONE_SPEC.md §41, §43): Admin › Content › All content, History and
// Trash for news items (ingested and approved), news sources, news keyword rules and the published market content.
// Called by server/content-queue.js (registerContent) once the registry is mounted. Every write goes through the
// queue's own functions (its sanitising, length caps and audit row); revisions follow from the registry's audit
// listener, except market content, whose history is its CMS versions (history 'cms', restore = the queue's restore).
//
//   news_items     pending -> draft, approved -> published, rejected (or taken down) -> hidden. Edit headline, excerpt,
//                  category (an approved item's event rows follow at once); publish = approve, unpublish = reject. Trash
//                  removes the item and its event rows (gone from event pages and the category strip at once); an item
//                  in the Trash is not fetched again. Deleting an approved item for good needs a step-up.
//   news_sources   enabled -> published, disabled -> hidden. Name, feed URL, default category, on/off, interval. Trash
//                  takes the fetch log along; refused while the source is being fetched.
//   news_rules     active -> published, else hidden. Weight and on/off (keyword and category are fixed).
//   market_content published text -> published, unpublished (version 0) -> hidden, only a pending queue item -> draft
//                  (reviewed in the queue). Edit the three texts (a new CMS version); restore any CMS version. Trash
//                  removes the CMS entry (the event page's "About this market" goes at once); refused while new texts are
//                  being written for the event and for drafts. Deleting published text for good needs a step-up.
const { E, ApiError } = require('./util');
const { s: S } = require('./content/content-admin');

// Reading needs content.write (as the queues); every change is a content.publish decision in the queue.
const QUEUE = { read: 'content.write', write: 'content.publish', publish: 'content.publish', purge: 'content.publish' };
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const opts = (list) => list.map((x) => [x, x]);
const like = (q) => `%${String(q || '').toLowerCase()}%`;
const notFound = () => new ApiError(404, 'not_found', S('error.not_found'));
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

function registerQueueContent({ registry, db, store, getEvent, TYPE, CAPS, categories, news, sources, rules, content }) {
  const reinsert = (table, row) => {
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
  };
  const taken = (key) => E.conflict('key_taken', S('error.key_taken', { key }));

  // ================================================================ news items
  const item = (id) => db.prepare('SELECT * FROM news_items WHERE id=?').get(String(id));
  const NEWS_STATUS = { pending: 'draft', approved: 'published', rejected: 'hidden' };
  const itemVo = (r) => ({ key: r.id, title: r.headline, status: NEWS_STATUS[r.status] || 'hidden', updated_at: iso(r.decided_ts || r.fetched_ts), updated_by: r.decided_email || null });
  const eventsOf = (rows) => [...new Set(rows.map((r) => r.event_ticker))];
  registry.register({
    type: 'news_items', perms: QUEUE, editor: () => '/admin/content_queue/news',
    fields: [{ name: 'headline', kind: 'text', max: 200 }, { name: 'excerpt', kind: 'textarea', max: 300 }, { name: 'category', kind: 'select', options: opts(categories) }],
    list: ({ q }) => (q
      ? db.prepare('SELECT * FROM news_items WHERE lower(headline) LIKE ? OR lower(publisher) LIKE ? OR lower(id)=? ORDER BY fetched_ts DESC LIMIT 1000').all(like(q), like(q), q)
      : db.prepare('SELECT * FROM news_items ORDER BY fetched_ts DESC LIMIT 1000').all()).map(itemVo),
    get: (key) => { const r = item(key); return r ? { ...itemVo(r), data: { headline: r.headline, excerpt: r.excerpt, category: r.category } } : null; },
    update: (req, key, data, reason) => { const r = item(key); if (!r) throw notFound(); news.editNews(req, r, data, reason); }, // changed() pushes the event pages
    setPublished: (req, key, on, reason) => {
      const r = item(key);
      if (!r) throw notFound();
      if (on ? r.status === 'approved' : r.status === 'rejected') return;
      news.emitEvents(on ? news.approveOne(req, r, {}, reason) : news.rejectOne(req, r, reason));
    },
    trash: {
      take: (key) => {
        const r = item(key);
        const rows = db.prepare('SELECT * FROM cms_news WHERE ingest_item_id=?').all(r.id);
        db.prepare('DELETE FROM cms_news WHERE ingest_item_id=?').run(r.id);
        db.prepare('DELETE FROM news_items WHERE id=?').run(r.id);
        return { row: r, news: rows };
      },
      put: (snap) => {
        const r = snap.row;
        if (db.prepare('SELECT 1 FROM news_items WHERE url_norm=? OR title_hash=?').get(r.url_norm, r.title_hash)) throw taken(r.headline);
        reinsert('news_items', r);
        for (const n of snap.news || []) reinsert('cms_news', n);
      },
      stepUp: (snap) => snap.row?.status === 'approved', // published market news, as the registry's `news` type
    },
    auditMatch: (e) => (e.target_type === 'news_item' && /^content_queue\.news\.(approve|edit)$/.test(e.action) ? e.target_id : null),
    // Event pages showing the item follow live (approve / edit / trash / restore).
    changed: (key) => {
      const live = db.prepare('SELECT event_ticker FROM cms_news WHERE ingest_item_id=?').all(String(key));
      const trashed = db.prepare("SELECT snapshot_json FROM content_trash WHERE type='news_items' AND key=? ORDER BY deleted_at DESC LIMIT 1").get(String(key));
      news.emitEvents(eventsOf([...live, ...((trashed && parse(trashed.snapshot_json)?.news) || [])]));
    },
  });

  // ================================================================ news sources
  const source = (id) => db.prepare('SELECT * FROM news_sources WHERE id=?').get(String(id));
  const sourceVo = (r) => ({ key: r.id, title: r.name, status: r.enabled ? 'published' : 'hidden', updated_at: iso(r.updated_ts || r.created_ts), updated_by: null });
  registry.register({
    type: 'news_sources', perms: QUEUE, editor: () => '/admin/content_queue/sources',
    fields: [{ name: 'name', kind: 'text', max: 60 }, { name: 'feed_url', kind: 'text', max: 500 }, { name: 'default_category', kind: 'select', options: opts(categories) },
      { name: 'enabled', kind: 'bool' }, { name: 'interval_minutes', kind: 'int' }],
    list: ({ q }) => (q
      ? db.prepare('SELECT * FROM news_sources WHERE lower(name) LIKE ? OR lower(feed_url) LIKE ? ORDER BY position, name').all(like(q), like(q))
      : db.prepare('SELECT * FROM news_sources ORDER BY position, name').all()).map(sourceVo),
    get: (key) => { const r = source(key); return r ? { ...sourceVo(r), data: registry.types.get('news_sources').pick(r) } : null; },
    update: (req, key, data, reason) => { const r = source(key); if (!r) throw notFound(); sources.updateSource(req, r, data, reason); },
    setPublished: (req, key, on, reason) => { const r = source(key); if (!r) throw notFound(); sources.updateSource(req, r, { enabled: !!on }, reason); },
    trash: {
      refuse: (key) => (sources.busy(String(key)) ? S('why.fetching') : null),
      take: (key) => {
        const r = source(key);
        const log = db.prepare('SELECT * FROM news_fetch_log WHERE source_id=?').all(r.id);
        db.prepare('DELETE FROM news_fetch_log WHERE source_id=?').run(r.id);
        db.prepare('DELETE FROM news_sources WHERE id=?').run(r.id);
        return { row: r, log };
      },
      put: (snap) => {
        if (db.prepare('SELECT 1 FROM news_sources WHERE feed_url=?').get(snap.row.feed_url)) throw taken(snap.row.feed_url);
        reinsert('news_sources', snap.row);
        for (const l of snap.log || []) reinsert('news_fetch_log', l);
      },
    },
    auditMatch: (e) => (e.target_type === 'news_source' && /^content_queue\.source\.(create|update)$/.test(e.action) ? e.target_id : null),
  });

  // ================================================================ news keyword rules
  const rule = (id) => db.prepare('SELECT * FROM news_category_rules WHERE id=?').get(String(id));
  const ruleVo = (r) => ({ key: r.id, title: `${r.keyword} → ${r.category}`, status: r.active ? 'published' : 'hidden', updated_at: iso(r.updated_ts || r.created_ts), updated_by: null });
  registry.register({
    type: 'news_rules', perms: QUEUE, editor: () => '/admin/content_queue/rules',
    fields: [{ name: 'weight', kind: 'int' }, { name: 'active', kind: 'bool' }],
    list: ({ q }) => (q
      ? db.prepare('SELECT * FROM news_category_rules WHERE lower(keyword) LIKE ? OR lower(category) LIKE ? ORDER BY category, keyword').all(like(q), like(q))
      : db.prepare('SELECT * FROM news_category_rules ORDER BY category, keyword').all()).map(ruleVo),
    get: (key) => { const r = rule(key); return r ? { ...ruleVo(r), data: registry.types.get('news_rules').pick(r) } : null; },
    update: (req, key, data, reason) => { const r = rule(key); if (!r) throw notFound(); rules.updateRule(req, r, data, reason); },
    setPublished: (req, key, on, reason) => { const r = rule(key); if (!r) throw notFound(); rules.updateRule(req, r, { active: !!on }, reason); },
    trash: {
      take: (key) => { const r = rule(key); db.prepare('DELETE FROM news_category_rules WHERE id=?').run(r.id); rules.invalidateRules(); return { row: r }; },
      put: (snap) => {
        const r = snap.row;
        if (db.prepare('SELECT 1 FROM news_category_rules WHERE category=? AND keyword=?').get(r.category, r.keyword)) throw taken(`${r.keyword} → ${r.category}`);
        reinsert('news_category_rules', r);
        rules.invalidateRules();
      },
    },
    auditMatch: (e) => (e.target_type === 'news_rule' && /^content_queue\.rule\.(create|update)$/.test(e.action) ? e.target_id : null),
  });

  // ================================================================ published market content (CMS entry market_content/<event>)
  const K = (key) => String(key).toUpperCase(); // keys are event tickers
  const entryRows = (key) => db.prepare('SELECT * FROM cms_entries WHERE type=? AND key=?').all(TYPE, K(key));
  const pendingOf = (t) => db.prepare("SELECT * FROM market_content_queue WHERE event_ticker=? AND status='pending' ORDER BY created_ts DESC, rowid DESC LIMIT 1").get(t);
  const evTitle = (t) => getEvent(t)?.title || t;
  const texts = (v) => Object.fromEntries(Object.keys(CAPS).map((f) => [f, String((v && v[f]) ?? '')]));
  function contentVo(key) {
    const e = store.get(TYPE, key);
    if (e.published) return { key, title: evTitle(key), status: 'published', updated_at: e.published_time, updated_by: e.published_by, data: texts(e.published) };
    const p = pendingOf(key);
    if (entryRows(key).length) return { key, title: evTitle(key), status: 'hidden', updated_at: e.published_time, updated_by: e.published_by, data: texts(p) };
    if (p) return { key, title: evTitle(key), status: 'draft', updated_at: iso(p.created_ts), updated_by: null, data: texts(p) };
    return null;
  }
  const contentKeys = (q) => {
    const keys = [...new Set([...db.prepare('SELECT DISTINCT key FROM cms_entries WHERE type=?').all(TYPE).map((r) => r.key),
      ...db.prepare("SELECT DISTINCT event_ticker k FROM market_content_queue WHERE status='pending'").all().map((r) => r.k)])];
    if (!q) return keys;
    const s = String(q).toLowerCase();
    return keys.filter((k) => k.toLowerCase().includes(s) || String(evTitle(k)).toLowerCase().includes(s));
  };
  registry.register({
    type: TYPE, perms: QUEUE, history: 'cms', editor: () => '/admin/content_queue/content',
    fields: Object.keys(CAPS).map((name) => ({ name, kind: 'textarea', max: CAPS[name] })),
    pick: (v) => (v ? texts(v) : null),
    list: ({ q }) => contentKeys(q).map(contentVo).filter(Boolean).map(({ data, ...rest }) => { void data; return rest; }),
    get: (key) => contentVo(K(key)),
    update: (req, key, data, reason) => content.editContent(req, K(key), data, reason),
    rollback: (req, key, version, reason) => content.restoreContent(req, K(key), version, reason),
    setPublished: (req, key, on, reason) => {
      const t = K(key);
      const cur = content.publishedContent(t);
      if (!on) { if (cur) content.restoreContent(req, t, 0, reason); return; }
      if (cur) return;
      // Publish again: the newest version that had text (a draft is approved in the queue instead).
      const v = db.prepare('SELECT version FROM cms_versions WHERE type=? AND key=? AND value_json IS NOT NULL ORDER BY version DESC LIMIT 1').get(TYPE, t);
      if (!v) throw E.conflict('cannot_publish', S('why.review_in_queue'));
      content.restoreContent(req, t, v.version, reason);
    },
    trash: {
      refuse: (key) => (content.busy(K(key)) ? S('why.generating') : !entryRows(key).length ? S('why.review_in_queue') : null),
      take: (key) => { const rows = entryRows(key); db.prepare('DELETE FROM cms_entries WHERE type=? AND key=?').run(TYPE, K(key)); return { entries: rows }; },
      put: (snap, key) => { if (entryRows(key).length) throw taken(key); for (const r of snap.entries || []) reinsert('cms_entries', r); },
      stepUp: (snap) => (snap.entries || []).some((r) => r.published_json != null), // published market content
    },
    changed: (key) => { try { store.handler(TYPE).changed?.(K(key)); } catch (e) { console.error('market content changed', key, e.message); } },
  });
}

module.exports = { registerQueueContent };
