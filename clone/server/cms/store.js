'use strict';
// CMS content store and workflow (CLONE_SPEC.md §32.2). One table holds every managed entry, keyed by type, key and
// locale, with a draft value, the published value and an optional scheduled value; every publish, rollback, scheduled
// publish and import writes a version row (value, author, time, reason) and one hash-chained admin_audit row
// (server/audit-chain.js). Values are JSON; a published value of null means "back to the code default".
//
//   draft     content.write  saveDraft / discardDraft — never visible to the public bundle or routes
//   publish   content.publish publish now, or schedule (`at`): the job publishes it at that time, after a restart too
//   rollback  content.publish republish any earlier version (or the default) as a new version
// Types register a handler: validate(key, value) -> clean value (throws {field: message}), legal(key, value) -> bool
// (publishing needs a fresh step-up), changed(key) -> after a publish (caches, live push).
const { nowIso } = require('../util');
const { tx } = require('../db');
const auditChain = require('../audit-chain');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cms_entries (type TEXT NOT NULL, key TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'en-NG',
  draft_json TEXT, draft_by TEXT, draft_at TEXT,
  published_json TEXT, published_version INTEGER NOT NULL DEFAULT 0, published_by TEXT, published_at TEXT,
  scheduled_json TEXT, scheduled_at INTEGER, scheduled_by TEXT, scheduled_by_email TEXT, scheduled_reason TEXT,
  PRIMARY KEY (type, key, locale));
CREATE INDEX IF NOT EXISTS idx_cms_entries_sched ON cms_entries(scheduled_at);
CREATE TABLE IF NOT EXISTS cms_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, key TEXT NOT NULL, locale TEXT NOT NULL, version INTEGER NOT NULL,
  value_json TEXT, action TEXT NOT NULL, author_id TEXT, author_email TEXT, reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_cms_versions_key ON cms_versions(type, key, locale, version);
`;
const LOCALES = ['en-NG'];
const DEFAULT_LOCALE = 'en-NG';
const parse = (s) => (s == null ? null : JSON.parse(s));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

class CmsError extends Error {
  constructor(status, code, message, fields) { super(message); this.status = status; this.code = code; this.fields = fields || null; }
}

function createStore({ db, emit, requireFresh }) {
  db.exec(SCHEMA);
  const handlers = new Map();
  const register = (type, h) => handlers.set(type, h);
  const handler = (type) => { const h = handlers.get(type); if (!h) throw new CmsError(404, 'not_found', `unknown content type ${type}`); return h; };
  const loc = (l) => { const x = l || DEFAULT_LOCALE; if (!LOCALES.includes(x)) throw new CmsError(400, 'validation_failed', 'unsupported locale', { locale: `must be one of ${LOCALES.join(', ')}` }); return x; };
  const row = (type, key, locale) => db.prepare('SELECT * FROM cms_entries WHERE type=? AND key=? AND locale=?').get(type, key, locale);
  const ensure = (type, key, locale) => db.prepare('INSERT INTO cms_entries(type,key,locale) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(type, key, locale);
  const actorOf = (req) => ({ id: req?.auth?.user.id || null, email: req?.auth?.user.email || null });

  function clean(type, key, value) {
    try { return handler(type).validate(key, value); } catch (e) {
      if (e instanceof CmsError) throw e;
      if (e && typeof e === 'object' && !(e instanceof Error)) { const { code, ...fields } = e; throw new CmsError(400, code || 'validation_failed', 'validation failed', fields); }
      throw e;
    }
  }
  function entryVo(r, type, key, locale) {
    return {
      type, key, locale,
      draft: r ? parse(r.draft_json) : null, has_draft: !!(r && r.draft_json != null), draft_by: r?.draft_by || null, draft_time: r?.draft_at || null,
      published: r ? parse(r.published_json) : null, published_version: r?.published_version || 0, published_by: r?.published_by || null, published_time: r?.published_at || null,
      scheduled: r && r.scheduled_at ? { value: parse(r.scheduled_json), at: new Date(r.scheduled_at).toISOString(), by: r.scheduled_by_email || r.scheduled_by, reason: r.scheduled_reason } : null,
    };
  }
  const get = (type, key, locale = DEFAULT_LOCALE) => entryVo(row(type, key, loc(locale)), type, key, loc(locale));

  function saveDraft(req, type, key, value, locale) {
    const l = loc(locale);
    const v = clean(type, key, value);
    ensure(type, key, l);
    db.prepare('UPDATE cms_entries SET draft_json=?, draft_by=?, draft_at=? WHERE type=? AND key=? AND locale=?').run(JSON.stringify(v), actorOf(req).email, nowIso(), type, key, l);
    emit({ preview: true, changed: [{ type, key }] });
    return get(type, key, l);
  }
  function discardDraft(req, type, key, locale) {
    const l = loc(locale);
    db.prepare('UPDATE cms_entries SET draft_json=NULL, draft_by=NULL, draft_at=NULL WHERE type=? AND key=? AND locale=?').run(type, key, l);
    return get(type, key, l);
  }

  // Writes the published value (inside the caller's transaction): version row + audit row.
  function apply(type, key, l, value, { action, actor, reason }) {
    ensure(type, key, l);
    const r = row(type, key, l);
    const before = parse(r.published_json);
    const version = (r.published_version || 0) + 1;
    const at = nowIso();
    db.prepare('UPDATE cms_entries SET published_json=?, published_version=?, published_by=?, published_at=? WHERE type=? AND key=? AND locale=?')
      .run(value == null ? null : JSON.stringify(value), version, actor.email, at, type, key, l);
    db.prepare('INSERT INTO cms_versions(type,key,locale,version,value_json,action,author_id,author_email,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(type, key, l, version, value == null ? null : JSON.stringify(value), action, actor.id, actor.email, reason, at);
    auditChain.append(db, { actor_id: actor.id, actor_email: actor.email, action: `cms.${action}`, target_type: `cms.${type}`, target_id: `${key}@${l}`, before: { version: version - 1, value: before }, after: { version, value }, reason });
    return version;
  }
  function changed(type, key) {
    const h = handlers.get(type);
    try { if (h && h.changed) h.changed(key); } catch (e) { console.error('cms changed', type, key, e); }
  }
  const legal = (type, key, value) => { const h = handlers.get(type); return !!(h && h.legal && h.legal(key, value)); };
  const reasonOf = (reason) => {
    const r = String(reason ?? '').trim();
    if (r.length < 3 || r.length > 500) throw new CmsError(400, 'validation_failed', 'validation failed', { reason: 'a reason of 3-500 characters is required' });
    return r;
  };

  // Publish the current draft now, or schedule it. `value` (optional) publishes that value instead of the draft.
  function publish(req, type, key, { reason, at, locale, value } = {}) {
    const l = loc(locale);
    const why = reasonOf(reason);
    const r = row(type, key, l);
    let v;
    if (value !== undefined) v = value === null ? null : clean(type, key, value);
    else if (r && r.draft_json != null) v = clean(type, key, parse(r.draft_json)); // re-validated: rules may have tightened
    else throw new CmsError(409, 'no_draft', 'there is no draft to publish');
    if (legal(type, key, v) || legal(type, key, r ? parse(r.published_json) : null)) requireFresh(req, 'cms_legal_publish');
    const actor = actorOf(req);
    if (at !== undefined && at !== null && at !== '') {
      const ts = Date.parse(at);
      if (!Number.isFinite(ts)) throw new CmsError(400, 'validation_failed', 'validation failed', { at: 'must be a date and time' });
      if (ts <= Date.now()) throw new CmsError(400, 'validation_failed', 'validation failed', { at: 'must be in the future' });
      if (ts > Date.now() + 366 * 86400000) throw new CmsError(400, 'validation_failed', 'validation failed', { at: 'must be within a year' });
      ensure(type, key, l);
      db.prepare('UPDATE cms_entries SET scheduled_json=?, scheduled_at=?, scheduled_by=?, scheduled_by_email=?, scheduled_reason=?, draft_json=NULL, draft_by=NULL, draft_at=NULL WHERE type=? AND key=? AND locale=?')
        .run(v == null ? null : JSON.stringify(v), ts, actor.id, actor.email, why, type, key, l);
      auditChain.append(db, { actor_id: actor.id, actor_email: actor.email, action: 'cms.schedule', target_type: `cms.${type}`, target_id: `${key}@${l}`, before: null, after: { at: new Date(ts).toISOString(), value: v }, reason: why });
      return get(type, key, l);
    }
    tx(db, () => {
      apply(type, key, l, v, { action: 'publish', actor, reason: why });
      db.prepare('UPDATE cms_entries SET draft_json=NULL, draft_by=NULL, draft_at=NULL WHERE type=? AND key=? AND locale=?').run(type, key, l);
    });
    changed(type, key);
    emit({ changed: [{ type, key }] });
    return get(type, key, l);
  }
  function unschedule(req, type, key, { reason, locale } = {}) {
    const l = loc(locale);
    const why = reasonOf(reason);
    const r = row(type, key, l);
    if (!r || !r.scheduled_at) throw new CmsError(409, 'not_scheduled', 'nothing is scheduled for this entry');
    const actor = actorOf(req);
    db.prepare('UPDATE cms_entries SET draft_json=COALESCE(draft_json, scheduled_json), scheduled_json=NULL, scheduled_at=NULL, scheduled_by=NULL, scheduled_by_email=NULL, scheduled_reason=NULL WHERE type=? AND key=? AND locale=?').run(type, key, l);
    auditChain.append(db, { actor_id: actor.id, actor_email: actor.email, action: 'cms.unschedule', target_type: `cms.${type}`, target_id: `${key}@${l}`, before: { at: new Date(r.scheduled_at).toISOString() }, after: null, reason: why });
    return get(type, key, l);
  }
  // version 0 = the code default.
  function rollback(req, type, key, { version, reason, locale } = {}) {
    const l = loc(locale);
    const why = reasonOf(reason);
    const n = Number(version);
    if (!Number.isInteger(n) || n < 0) throw new CmsError(400, 'validation_failed', 'validation failed', { version: 'must be a version number (0 = default)' });
    let v = null;
    if (n > 0) {
      const ver = db.prepare('SELECT * FROM cms_versions WHERE type=? AND key=? AND locale=? AND version=?').get(type, key, l, n);
      if (!ver) throw new CmsError(404, 'not_found', 'no such version');
      v = parse(ver.value_json);
      if (v != null) v = clean(type, key, v);
    }
    const cur = row(type, key, l);
    if (legal(type, key, v) || legal(type, key, cur ? parse(cur.published_json) : null)) requireFresh(req, 'cms_legal_publish');
    tx(db, () => apply(type, key, l, v, { action: 'rollback', actor: actorOf(req), reason: `${why} (to version ${n})` }));
    changed(type, key);
    emit({ changed: [{ type, key }] });
    return get(type, key, l);
  }
  const versions = (type, key, locale = DEFAULT_LOCALE) => db.prepare('SELECT * FROM cms_versions WHERE type=? AND key=? AND locale=? ORDER BY version DESC LIMIT 200').all(type, key, loc(locale))
    .map((v) => ({ version: v.version, value: parse(v.value_json), action: v.action, author: v.author_email, reason: v.reason, time: v.created_at }));

  // Published values of a type (Map key -> value), non-null only.
  function published(type, locale = DEFAULT_LOCALE) {
    const m = new Map();
    for (const r of db.prepare('SELECT key, published_json FROM cms_entries WHERE type=? AND locale=? AND published_json IS NOT NULL').all(type, locale)) m.set(r.key, parse(r.published_json));
    return m;
  }
  // Published values overlaid with drafts (staff preview only).
  function withDrafts(type, locale = DEFAULT_LOCALE) {
    const m = published(type, locale);
    for (const r of db.prepare('SELECT key, draft_json FROM cms_entries WHERE type=? AND locale=? AND draft_json IS NOT NULL').all(type, locale)) m.set(r.key, parse(r.draft_json));
    return m;
  }
  const rows = (type, locale = DEFAULT_LOCALE) => db.prepare('SELECT * FROM cms_entries WHERE type=? AND locale=?').all(type, locale).map((r) => entryVo(r, type, r.key, locale));

  // Scheduled publishes that are due (the job calls this every tick; state is in the DB, so it resumes after a restart).
  function tick(now = Date.now()) {
    const due = db.prepare('SELECT * FROM cms_entries WHERE scheduled_at IS NOT NULL AND scheduled_at<=? ORDER BY scheduled_at LIMIT 50').all(now);
    const done = [];
    for (const r of due) {
      try {
        tx(db, () => {
          const v = parse(r.scheduled_json);
          apply(r.type, r.key, r.locale, v, { action: 'scheduled_publish', actor: { id: r.scheduled_by, email: r.scheduled_by_email }, reason: r.scheduled_reason || 'scheduled' });
          db.prepare('UPDATE cms_entries SET scheduled_json=NULL, scheduled_at=NULL, scheduled_by=NULL, scheduled_by_email=NULL, scheduled_reason=NULL WHERE type=? AND key=? AND locale=?').run(r.type, r.key, r.locale);
        });
        done.push({ type: r.type, key: r.key });
      } catch (e) { console.error('cms scheduled publish', r.type, r.key, e); }
    }
    for (const d of done) changed(d.type, d.key);
    if (done.length) emit({ changed: done });
    return done.length;
  }

  // ------------------------------------------------------------------ export / import
  function exportAll() {
    const out = { format: 'parlance-cms', version: 1, exported_at: nowIso(), entries: [] };
    for (const r of db.prepare('SELECT * FROM cms_entries WHERE published_json IS NOT NULL OR draft_json IS NOT NULL ORDER BY type, key, locale').all()) {
      out.entries.push({ type: r.type, key: r.key, locale: r.locale, published: parse(r.published_json), ...(r.draft_json != null ? { draft: parse(r.draft_json) } : {}) });
    }
    return out;
  }
  // Validates every entry first; returns the diff. With apply, publishes each changed value (one version + audit row
  // each) and stores drafts, all in one transaction.
  function importAll(req, data, { dryRun = true, reason } = {}) {
    if (!data || typeof data !== 'object' || data.format !== 'parlance-cms' || !Array.isArray(data.entries)) throw new CmsError(400, 'validation_failed', 'validation failed', { data: 'expected an export file ({format: "parlance-cms", entries: [...]})' });
    if (data.entries.length > 20000) throw new CmsError(400, 'validation_failed', 'validation failed', { data: 'at most 20000 entries' });
    const errors = []; const diff = []; const plan = [];
    data.entries.forEach((e, i) => {
      try {
        if (!e || typeof e !== 'object' || typeof e.type !== 'string' || typeof e.key !== 'string') throw { entry: 'needs type and key' };
        if (!handlers.has(e.type)) throw { type: `unknown content type ${e.type}` };
        const l = loc(e.locale);
        const pub = e.published == null ? null : clean(e.type, e.key, e.published);
        const draft = e.draft === undefined ? undefined : e.draft == null ? null : clean(e.type, e.key, e.draft);
        const cur = row(e.type, e.key, l);
        const curPub = cur ? parse(cur.published_json) : null;
        if (!same(curPub, pub)) { diff.push({ type: e.type, key: e.key, locale: l, change: curPub == null ? 'add' : pub == null ? 'reset' : 'update', before: curPub, after: pub }); plan.push({ ...e, locale: l, pub, draft, publish: true, isLegal: legal(e.type, e.key, pub) || legal(e.type, e.key, curPub) }); }
        else if (draft !== undefined && !same(cur ? parse(cur.draft_json) : null, draft)) { diff.push({ type: e.type, key: e.key, locale: l, change: 'draft', before: cur ? parse(cur.draft_json) : null, after: draft }); plan.push({ ...e, locale: l, pub, draft, publish: false }); }
      } catch (err) {
        if (err instanceof CmsError) errors.push({ index: i, key: e && e.key, fields: err.fields || { entry: err.message } });
        else if (err && typeof err === 'object' && !(err instanceof Error)) { const { code, ...fields } = err; void code; errors.push({ index: i, key: e && e.key, fields }); } else throw err;
      }
    });
    const summary = { dry_run: !!dryRun, valid: !errors.length, errors, changes: diff.length, diff: diff.slice(0, 2000) };
    if (dryRun || errors.length) return summary;
    const why = reasonOf(reason);
    if (plan.some((p) => p.isLegal)) requireFresh(req, 'cms_legal_publish');
    const actor = actorOf(req);
    tx(db, () => {
      for (const p of plan) {
        if (p.publish) apply(p.type, p.key, p.locale, p.pub, { action: 'import', actor, reason: why });
        if (p.draft !== undefined) { ensure(p.type, p.key, p.locale); db.prepare('UPDATE cms_entries SET draft_json=?, draft_by=?, draft_at=? WHERE type=? AND key=? AND locale=?').run(p.draft == null ? null : JSON.stringify(p.draft), actor.email, nowIso(), p.type, p.key, p.locale); }
      }
    });
    const touched = plan.filter((p) => p.publish).map((p) => ({ type: p.type, key: p.key }));
    for (const x of touched) changed(x.type, x.key);
    if (touched.length) emit({ changed: touched });
    return { ...summary, applied: true };
  }

  return { register, handler, get, saveDraft, discardDraft, publish, unschedule, rollback, versions, published, withDrafts, rows, tick, exportAll, importAll, LOCALES, DEFAULT_LOCALE };
}

module.exports = { createStore, CmsError, LOCALES, DEFAULT_LOCALE };
