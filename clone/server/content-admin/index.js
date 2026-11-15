'use strict';
// Content management for every entity (owner request 2026-11-15, CLONE_SPEC.md §41): one registry of content types,
// generic revision history, soft delete with a Trash, and Admin › Content › All content / History / Trash.
//
// Registry. Each content type registers (registry.register(def), also from other modules: app.locals.contentRegistry):
//   type, perms {read, write, publish, purge}, fields [{name, kind, options?, max?, nullable?}] (the editable content
//   fields: the generic form, revisions and "restore this version" use exactly these), editor(key) (link to the type's
//   own editor), history 'revisions' | 'cms' (the CMS store keeps its own versions: they are reused, not copied),
//   list({q}) -> [{key, title, status, updated_at, updated_by}], get(key) -> {…, data} | null,
//   update?(req, key, data, reason), setPublished?(req, key, on, reason), rollback?(req, key, version, reason),
//   trash? {refuse(key, item) -> why | null, take(key) -> snapshot (removes the live rows), put(snapshot), stepUp(snapshot)},
//   auditMatch?(auditEvent) -> key | null (which audited admin writes are revisions of this type), changed?(key).
// Status of an item: draft | published | scheduled | hidden | trashed.
//
// Revisions (table content_revisions, migration 0006): every audited admin create / update of a registered type that
// has no history of its own becomes a revision through the audit chain's listener (server/audit-chain.js onAppend), so
// the existing editors are covered without each writing revisions; trash, restore and purge are recorded here.
// Trash (table content_trash): deleting moves the item's rows into the Trash in one transaction, so no public query can
// return it; restore puts them back; items older than the owner setting content.trash_retention_days are purged by the
// job below (at start and every `purgeMs`). Delete forever needs the type's purge permission, and a fresh step-up for
// legal pages and market news (published market content).
//
// Routes (all need content.write to open; each action also checks the type's own permission):
//   GET  /v1/admin/content_index                 the index: q, type, status, offset, limit
//   GET  /v1/admin/content_index/item            one item with its fields (?type=&key=)
//   PUT  /v1/admin/content_index/item            generic form save {type, key, data, reason}
//   GET  /v1/admin/content_index/history         revisions (?type=&key= for one item, else the newest across types)
//   POST /v1/admin/content_index/history/restore {revision, reason}: restore that version
//   GET  /v1/admin/content_index/trash           the Trash
//   POST /v1/admin/content_index/trash           {items: [{type, key}], reason}: move to the Trash
//   POST /v1/admin/content_index/trash/restore   {ids, reason}
//   POST /v1/admin/content_index/trash/purge     {ids, reason}: delete forever
//   POST /v1/admin/content_index/bulk            {action: publish|unpublish|trash|restore, items, reason}
const { tx } = require('../db');
const auditChain = require('../audit-chain');
const { ApiError, E, newId, nowIso } = require('../util');
const { check } = require('../validate');
const { ensureSchema } = require('../migrations/schema-guard');
const { SQL } = require('../migrations/0006-content-admin');
const { s: S } = require('../content/content-admin');
const { registerBuiltins } = require('./adapters');

const DAY = 86400000;
const STATUSES = ['draft', 'published', 'scheduled', 'hidden', 'trashed'];
const BULK_MAX = 200;
const J = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const P = (s) => { if (s == null) return null; try { return JSON.parse(s); } catch { return null; } };
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function mountContentAdmin({ v1, app, db, engine, admin, auth, options = {} }) {
  ensureSchema(db, (d) => d.exec(SQL)); // migration 0006 (server/migrations)
  const types = new Map();
  const permsOf = (req) => admin.permsOf(admin.rolesOf(req.auth.user));
  const has = (req, perm) => !!perm && permsOf(req).has(perm);
  const need = (req, perm) => { if (!has(req, perm)) throw new ApiError(403, 'forbidden', 'forbidden', S('error.no_permission', { perm })); };
  const actorOf = (req) => ({ id: req?.auth?.user.id || null, email: req?.auth?.user.email || null });
  const retentionDays = () => { try { return Number(app.locals.ownerSettings.get('content.trash_retention_days')) || 30; } catch { return 30; } };
  const reasonOf = (r) => { const x = String(r ?? '').trim(); if (x.length < 3 || x.length > 500) { const e = new ApiError(400, 'validation_failed', 'validation failed', `reason: ${S('error.reason_required')}`); e.fields = { reason: S('error.reason_required') }; e.toJSON = () => ({ error: { code: e.code, message: e.message, details: e.details, fields: e.fields } }); throw e; } return x; };
  const typeDef = (t) => { const d = types.get(String(t || '')); if (!d) throw new ApiError(404, 'not_found', S('error.unknown_type')); return d; };
  const label = (d) => d.label || S(`type.${d.type}`);

  // Live update to open pages (the CMS `content` channel; off with the cms.live_updates flag, like the CMS itself).
  function live(changed) {
    try { app.locals.cms?.invalidate(); } catch (e) { console.error('content live', e.message); }
    if (engine.flags && !engine.flags.jobOn('cms.live_updates')) return;
    try { engine.emit('content', { changed }); } catch (e) { console.error('content emit', e.message); }
  }

  // Internal call of an existing admin route as the requesting admin (its validation, side effects and audit row are
  // reused, not duplicated). Runs through the v1 router; the response body is returned, an error response is thrown.
  function dispatch(req, method, url, body) {
    return new Promise((resolve, reject) => {
      const u = new URL(url, 'http://internal');
      const r2 = { method, url: u.pathname + u.search, originalUrl: `/v1${u.pathname}${u.search}`, baseUrl: '', path: u.pathname, headers: { 'content-type': 'application/json' }, query: Object.fromEntries(u.searchParams), params: {},
        body: body || {}, auth: req.auth, adminInternal: true, ip: req.ip || 'internal', get: () => undefined, header: () => undefined };
      let status = 200;
      const res = { locals: {}, headersSent: false, statusCode: 200, status(c) { status = c; this.statusCode = c; return this; }, setHeader() {}, set() { return this; }, getHeader() {}, on() { return this; }, once() { return this; }, end() { resolve(null); },
        json(b) { if (status >= 400) { const e = new ApiError(status, b?.error?.code || 'error', b?.error?.message || 'error', b?.error?.details); if (b?.error) e.toJSON = () => b; reject(e); } else resolve(b); return this; },
        send(b) { resolve(b); return this; } };
      try { v1.handle(r2, res, (err) => reject(err || E.notFound())); } catch (e) { reject(e); }
    });
  }

  // ---------------------------------------------------------------- revisions
  const lastRev = (type, key) => db.prepare('SELECT * FROM content_revisions WHERE type=? AND key=? ORDER BY version DESC LIMIT 1').get(type, String(key));
  function record(type, key, action, before, after, actor, reason) {
    const v = (lastRev(type, key)?.version || 0) + 1;
    db.prepare('INSERT INTO content_revisions(type,key,version,action,before_json,after_json,actor_id,actor_email,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(type, String(key), v, action, J(before), J(after), actor.id || null, actor.email || null, String(reason || ''), nowIso());
  }
  // Every audited admin write: a revision of the registered type it belongs to (the existing editors included).
  auditChain.onAppend(db, (e) => {
    if (!e || !e.action || e.action.startsWith('content_admin.')) return;
    for (const d of types.values()) {
      if (!d.auditMatch) continue;
      const key = d.auditMatch(e);
      if (key == null) continue;
      const cur = d.get(String(key));
      const after = cur ? cur.data : null;
      const prev = lastRev(d.type, key);
      const before = prev ? P(prev.after_json) : e.before ? d.pick(e.before) : null;
      const action = /\.create$/.test(e.action) ? 'create' : 'update';
      if (action === 'update' && same(before, after)) return; // nothing in the content fields changed (a status-only publish)
      record(d.type, key, action, before, after, { id: e.actor_id, email: e.actor_email }, e.reason);
      return;
    }
  });

  // ---------------------------------------------------------------- registry
  function register(def) {
    if (!def || !/^[a-z][a-z0-9_]{1,40}$/.test(def.type || '')) throw new Error(`content type: bad type ${def && def.type}`);
    if (types.has(def.type)) throw new Error(`content type ${def.type} is already registered`);
    const fields = def.fields || [];
    const pick = def.pick || ((row) => {
      if (!row) return null;
      const out = {};
      for (const f of fields) {
        const v = row[f.name];
        out[f.name] = f.kind === 'bool' ? !!v : f.kind === 'int' ? Number(v ?? 0) : v ?? (f.nullable ? null : '');
      }
      return out;
    });
    types.set(def.type, { history: 'revisions', perms: {}, ...def, fields, pick });
  }

  // ---------------------------------------------------------------- trash
  const trashRow = (id) => db.prepare('SELECT * FROM content_trash WHERE id=?').get(String(id || ''));
  function trashItem(req, type, key, reason) {
    const d = typeDef(type);
    need(req, d.perms.write);
    if (!d.trash) throw E.conflict('cannot_trash', S('error.cannot_trash', { why: S('why.no_trash') }));
    const cur = d.get(String(key));
    if (!cur) throw new ApiError(404, 'not_found', S('error.not_found'));
    const why = d.trash.refuse ? d.trash.refuse(String(key), cur) : null;
    if (why) throw E.conflict('cannot_trash', S('error.cannot_trash', { why }));
    const actor = actorOf(req); const id = newId('tr_');
    tx(db, () => {
      const snap = d.trash.take(String(key), cur);
      db.prepare('INSERT INTO content_trash(id,type,key,title,snapshot_json,deleted_by,deleted_by_email,reason,deleted_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, d.type, String(key), String(cur.title || key).slice(0, 300), JSON.stringify(snap), actor.id, actor.email, reason, Date.now());
      record(d.type, key, 'trash', cur.data, null, actor, reason);
      admin.audit(req, 'content_admin.trash', `content:${d.type}`, String(key), { title: cur.title, data: cur.data }, { trash_id: id }, reason);
    });
    try { d.changed?.(String(key)); } catch (e) { console.error('content changed', d.type, e.message); }
    live([{ type: d.type, key: String(key) }]);
    return { id, type: d.type, key: String(key) };
  }
  function untrash(req, id, reason) {
    const row = trashRow(id);
    if (!row) throw new ApiError(404, 'not_found', S('error.not_in_trash'));
    const d = typeDef(row.type);
    need(req, d.perms.write);
    if (d.get(row.key)) throw E.conflict('key_taken', S('error.key_taken', { key: row.key }));
    const actor = actorOf(req);
    tx(db, () => {
      d.trash.put(JSON.parse(row.snapshot_json), row.key);
      db.prepare('DELETE FROM content_trash WHERE id=?').run(row.id);
      record(d.type, row.key, 'restore', null, d.get(row.key)?.data ?? null, actor, reason);
      admin.audit(req, 'content_admin.restore', `content:${d.type}`, row.key, { trash_id: row.id }, { title: row.title }, reason);
    });
    try { d.changed?.(row.key); } catch (e) { console.error('content changed', d.type, e.message); }
    live([{ type: d.type, key: row.key }]);
    return { type: d.type, key: row.key };
  }
  const purgeNeedsStepUp = (d, row) => !!(d && d.trash && d.trash.stepUp && d.trash.stepUp(JSON.parse(row.snapshot_json)));
  function purgeRow(row, actor, reason, req = null) {
    const d = types.get(row.type);
    tx(db, () => {
      try { d?.trash?.purge?.(JSON.parse(row.snapshot_json), row.key); } catch (e) { console.error('content purge hook', row.type, e.message); }
      db.prepare('DELETE FROM content_trash WHERE id=?').run(row.id);
      record(row.type, row.key, 'purge', null, null, actor, reason);
      const entry = { actor_id: actor.id, actor_email: actor.email, action: 'content_admin.purge', target_type: `content:${row.type}`, target_id: row.key, before: { trash_id: row.id, title: row.title, deleted_by: row.deleted_by_email, deleted_time: new Date(row.deleted_at).toISOString() }, after: null, reason };
      if (req) admin.audit(req, entry.action, entry.target_type, entry.target_id, entry.before, null, reason); else auditChain.append(db, entry);
    });
  }
  function purge(req, id, reason) {
    const row = trashRow(id);
    if (!row) throw new ApiError(404, 'not_found', S('error.not_in_trash'));
    const d = types.get(row.type);
    need(req, d ? d.perms.purge : 'settings.write');
    if (purgeNeedsStepUp(d, row)) auth.assertFresh(req, 'content_purge');
    purgeRow(row, actorOf(req), reason, req);
    return { type: row.type, key: row.key };
  }
  // Retention: items older than the owner setting are deleted for good (a system purge, audited).
  function purgeExpired(now = Date.now()) {
    const days = retentionDays();
    const old = db.prepare('SELECT * FROM content_trash WHERE deleted_at<? ORDER BY deleted_at LIMIT 500').all(now - days * DAY);
    for (const row of old) { try { purgeRow(row, { id: null, email: 'system@parlance.local' }, S('reason.purged', { days })); } catch (e) { console.error('content trash purge', row.id, e.message); } }
    return old.length;
  }

  // ---------------------------------------------------------------- index
  const visible = (req) => [...types.values()].filter((d) => has(req, d.perms.read));
  const iso = (ms) => new Date(ms).toISOString();
  function trashVo(row, d, req) {
    const days = retentionDays();
    return { id: row.id, trash_id: row.id, type: row.type, type_label: d ? label(d) : row.type, key: row.key, title: row.title, status: 'trashed', reason: row.reason, deleted_by: row.deleted_by_email,
      updated_at: iso(row.deleted_at), updated_by: row.deleted_by_email, deleted_at: iso(row.deleted_at), purge_at: iso(row.deleted_at + days * DAY),
      can_restore: !!d && has(req, d.perms.write), can_purge: !!d && has(req, d.perms.purge), step_up: purgeNeedsStepUp(d, row) };
  }
  const capsOf = (d, req) => ({ write: has(req, d.perms.write), publish: has(req, d.perms.publish) && !!d.setPublished, purge: has(req, d.perms.purge), trash: !!d.trash && has(req, d.perms.write), edit: !!d.update && d.fields.length > 0 && has(req, d.perms.write) });
  v1.get('/admin/content_index', admin.can('content.write'), (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 100);
    const type = String(req.query.type || ''); const status = String(req.query.status || '');
    if (status && !STATUSES.includes(status)) throw E.badRequest(`status must be one of ${STATUSES.join(', ')}`);
    const defs = visible(req);
    const counts = Object.fromEntries(defs.map((d) => [d.type, 0]));
    let items = [];
    for (const d of defs) {
      const caps = capsOf(d, req);
      if (status !== 'trashed') {
        for (const it of d.list({ q }) || []) {
          counts[d.type] += 1;
          if (type && d.type !== type) continue;
          items.push({ type: d.type, type_label: label(d), key: String(it.key), title: it.title || String(it.key), status: it.status || 'published', updated_at: it.updated_at || null, updated_by: it.updated_by || null, edit_href: d.editor ? d.editor(String(it.key)) : null, history: d.history, can: caps });
        }
      }
    }
    if (!status || status === 'trashed') {
      const byType = new Map(defs.map((d) => [d.type, d]));
      for (const row of db.prepare('SELECT * FROM content_trash ORDER BY deleted_at DESC LIMIT 2000').all()) {
        const d = byType.get(row.type);
        if (!d) continue;
        counts[d.type] += 1;
        if (type && d.type !== type) continue;
        items.push({ ...trashVo(row, d, req), edit_href: null, history: d.history, can: capsOf(d, req) });
      }
    }
    if (status) items = items.filter((x) => x.status === status);
    if (q) items = items.filter((x) => `${x.title} ${x.key} ${x.type} ${x.type_label}`.toLowerCase().includes(q));
    items.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')) || a.type.localeCompare(b.type) || a.key.localeCompare(b.key));
    const total = items.length;
    const offset = Math.max(0, Number(req.query.offset) || 0); const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    res.json({ total, offset, limit, items: items.slice(offset, offset + limit), statuses: STATUSES,
      types: defs.map((d) => ({ type: d.type, label: label(d), count: counts[d.type], history: d.history, can: capsOf(d, req) })), retention_days: retentionDays() });
  });

  const itemQuery = (req) => {
    const b = check(req.query, { type: { type: 'string', maxLen: 60, required: true }, key: { type: 'string', maxLen: 300, required: true } });
    const d = typeDef(b.type); need(req, d.perms.read);
    return { d, key: b.key };
  };
  v1.get('/admin/content_index/item', admin.can('content.write'), (req, res) => {
    const { d, key } = itemQuery(req);
    const it = d.get(key);
    if (!it) throw new ApiError(404, 'not_found', S('error.not_found'));
    res.json({ item: { type: d.type, type_label: label(d), key, title: it.title, status: it.status, updated_at: it.updated_at || null, updated_by: it.updated_by || null, data: it.data, fields: d.fields, edit_href: d.editor ? d.editor(key) : null, history: d.history, can: capsOf(d, req) } });
  });
  v1.put('/admin/content_index/item', admin.can('content.write'), async (req, res) => {
    const b = check(req.body, { type: { type: 'string', maxLen: 60, required: true }, key: { type: 'string', maxLen: 300, required: true }, data: { type: 'object', required: true }, reason: { type: 'string', maxLen: 500 } }, { unknown: 'reject' });
    const d = typeDef(b.type);
    const reason = reasonOf(b.reason);
    need(req, d.perms.write);
    if (!d.update || !d.fields.length) throw E.conflict('cannot_edit', S('error.cannot_edit'));
    if (!d.get(b.key)) throw new ApiError(404, 'not_found', S('error.not_found'));
    const data = Object.fromEntries(d.fields.filter((f) => Object.prototype.hasOwnProperty.call(b.data, f.name)).map((f) => [f.name, f.nullable && b.data[f.name] === '' ? null : b.data[f.name]]));
    await d.update(req, b.key, data, reason);
    try { d.changed?.(b.key); } catch (e) { console.error('content changed', d.type, e.message); }
    live([{ type: d.type, key: b.key }]);
    const it = d.get(b.key);
    res.json({ item: { type: d.type, key: b.key, title: it?.title, status: it?.status, data: it?.data ?? null } });
  });

  // ---------------------------------------------------------------- history
  const revVo = (r, d, req) => ({ id: `r:${r.id}`, type: r.type, type_label: d ? label(d) : r.type, key: r.key, version: r.version, action: r.action, before: P(r.before_json), after: P(r.after_json), actor: r.actor_email, reason: r.reason, time: r.created_at,
    restorable: !!d && !!d.update && r.after_json != null && ['create', 'update', 'restore', 'restore_version'].includes(r.action) && has(req, d.perms.write) });
  function cmsVo(v, d, req) {
    const prev = db.prepare('SELECT value_json FROM cms_versions WHERE type=? AND key=? AND locale=? AND version<? ORDER BY version DESC LIMIT 1').get(v.type, v.key, v.locale, v.version);
    return { id: `c:${v.id}`, type: v.type, type_label: label(d), key: v.key, version: v.version, locale: v.locale, action: v.action, before: prev ? P(prev.value_json) : null, after: P(v.value_json), actor: v.author_email, reason: v.reason, time: v.created_at,
      restorable: has(req, d.perms.publish) };
  }
  v1.get('/admin/content_index/history', admin.can('content.write'), (req, res) => {
    const limit = Math.min(300, Math.max(1, Number(req.query.limit) || 100));
    const defs = new Map(visible(req).map((d) => [d.type, d]));
    let out = [];
    if (req.query.type || req.query.key) {
      const { d, key } = itemQuery(req);
      out = db.prepare('SELECT * FROM content_revisions WHERE type=? AND key=? ORDER BY version DESC LIMIT ?').all(d.type, key, limit).map((r) => revVo(r, d, req));
      if (d.history === 'cms') out.push(...db.prepare('SELECT * FROM cms_versions WHERE type=? AND key=? ORDER BY id DESC LIMIT ?').all(d.type, key, limit).map((v) => cmsVo(v, d, req)));
    } else {
      out = db.prepare('SELECT * FROM content_revisions ORDER BY id DESC LIMIT ?').all(limit * 2).filter((r) => defs.has(r.type)).map((r) => revVo(r, defs.get(r.type), req));
      const cmsTypes = [...defs.values()].filter((d) => d.history === 'cms').map((d) => d.type);
      if (cmsTypes.length) out.push(...db.prepare(`SELECT * FROM cms_versions WHERE type IN (${cmsTypes.map(() => '?').join(',')}) ORDER BY id DESC LIMIT ?`).all(...cmsTypes, limit).map((v) => cmsVo(v, defs.get(v.type), req)));
    }
    out.sort((a, b) => String(b.time).localeCompare(String(a.time)) || String(b.id).localeCompare(String(a.id)));
    res.json({ revisions: out.slice(0, limit) });
  });
  v1.post('/admin/content_index/history/restore', admin.can('content.write'), async (req, res) => {
    const b = check(req.body, { revision: { type: 'string', maxLen: 40, required: true }, reason: { type: 'string', maxLen: 500 } }, { unknown: 'reject' });
    const m = /^([rc]):(\d+)$/.exec(b.revision);
    if (!m) throw new ApiError(404, 'not_found', S('error.no_revision'));
    if (m[1] === 'c') {
      const v = db.prepare('SELECT * FROM cms_versions WHERE id=?').get(Number(m[2]));
      if (!v) throw new ApiError(404, 'not_found', S('error.no_revision'));
      const d = typeDef(v.type);
      const reason = reasonOf(b.reason);
      need(req, d.perms.publish);
      d.rollback(req, v.key, v.version, reason, v.locale);
      return res.json({ restored: { type: d.type, key: v.key, version: v.version } });
    }
    const r = db.prepare('SELECT * FROM content_revisions WHERE id=?').get(Number(m[2]));
    if (!r) throw new ApiError(404, 'not_found', S('error.no_revision'));
    const d = typeDef(r.type);
    const reason = reasonOf(b.reason);
    need(req, d.perms.write);
    if (r.after_json == null) throw E.conflict('revision_deleted', S('error.revision_deleted'));
    if (!d.update) throw E.conflict('cannot_edit', S('error.cannot_edit'));
    if (!d.get(r.key)) throw new ApiError(404, 'not_found', S('error.not_found'));
    const mark = db.prepare('SELECT COALESCE(MAX(id),0) m FROM content_revisions').get().m;
    await d.update(req, r.key, P(r.after_json), reason);
    // The revision the write produced (through the audit listener) is labelled as a restore of version N.
    db.prepare("UPDATE content_revisions SET action='restore_version', reason=? WHERE id>? AND type=? AND key=?").run(`${reason} (version ${r.version})`, mark, r.type, r.key);
    try { d.changed?.(r.key); } catch (e) { console.error('content changed', d.type, e.message); }
    live([{ type: d.type, key: r.key }]);
    res.json({ restored: { type: d.type, key: r.key, version: r.version }, item: d.get(r.key) });
  });

  // ---------------------------------------------------------------- trash routes
  v1.get('/admin/content_index/trash', admin.can('content.write'), (req, res) => {
    const defs = new Map(visible(req).map((d) => [d.type, d]));
    const rows = db.prepare('SELECT * FROM content_trash ORDER BY deleted_at DESC LIMIT 2000').all().filter((r) => defs.has(r.type));
    res.json({ items: rows.map((r) => trashVo(r, defs.get(r.type), req)), retention_days: retentionDays() });
  });
  const ITEMS = { type: 'array', maxItems: BULK_MAX, required: true };
  const itemsOf = (list) => list.map((x) => ({ type: String(x && x.type || ''), key: String(x && x.key || ''), trash_id: x && x.trash_id ? String(x.trash_id) : null }));
  v1.post('/admin/content_index/trash', admin.can('content.write'), (req, res) => {
    const b = check(req.body, { items: ITEMS, reason: { type: 'string', maxLen: 500 } }, { unknown: 'reject' });
    const reason = reasonOf(b.reason);
    const results = itemsOf(b.items).map((it) => attempt(it, () => trashItem(req, it.type, it.key, reason)));
    res.json({ results });
  });
  v1.post('/admin/content_index/trash/restore', admin.can('content.write'), (req, res) => {
    const b = check(req.body, { ids: { type: 'array', maxItems: BULK_MAX, required: true }, reason: { type: 'string', maxLen: 500 } }, { unknown: 'reject' });
    const reason = reasonOf(b.reason);
    res.json({ results: b.ids.map((id) => attempt({ trash_id: String(id) }, () => untrash(req, String(id), reason))) });
  });
  v1.post('/admin/content_index/trash/purge', admin.can('content.write'), (req, res) => {
    const b = check(req.body, { ids: { type: 'array', maxItems: BULK_MAX, required: true }, reason: { type: 'string', maxLen: 500 } }, { unknown: 'reject' });
    const reason = reasonOf(b.reason);
    // Permission and step-up are checked for every item before anything is deleted: a refusal deletes nothing.
    for (const id of b.ids) {
      const row = trashRow(id);
      if (!row) continue;
      const d = types.get(row.type);
      need(req, d ? d.perms.purge : 'settings.write');
      if (purgeNeedsStepUp(d, row)) auth.assertFresh(req, 'content_purge');
    }
    res.json({ results: b.ids.map((id) => attempt({ trash_id: String(id) }, () => purge(req, String(id), reason))) });
  });
  function attempt(it, fn) {
    try { return { ...it, ok: true, ...(fn() || {}) }; } catch (e) {
      if (e && e.code === 'step_up_required') throw e; // the client confirms, then retries the whole request
      if (!(e instanceof ApiError) && !(e && e.status)) throw e;
      return { ...it, ok: false, http: e.status, code: e.code, message: e.message, details: e.details || null };
    }
  }

  // ---------------------------------------------------------------- bulk
  v1.post('/admin/content_index/bulk', admin.can('content.write'), async (req, res) => {
    const b = check(req.body, { action: { type: 'string', enum: ['publish', 'unpublish', 'trash', 'restore'], required: true }, items: ITEMS, reason: { type: 'string', maxLen: 500 } }, { unknown: 'reject' });
    const reason = reasonOf(b.reason);
    const results = [];
    for (const it of itemsOf(b.items)) {
      if (b.action === 'trash') { results.push(attempt(it, () => trashItem(req, it.type, it.key, reason))); continue; }
      if (b.action === 'restore') {
        const id = it.trash_id || db.prepare('SELECT id FROM content_trash WHERE type=? AND key=? ORDER BY deleted_at DESC LIMIT 1').get(it.type, it.key)?.id;
        results.push(attempt(it, () => untrash(req, id, reason)));
        continue;
      }
      try {
        const d = typeDef(it.type);
        need(req, d.perms.publish);
        if (!d.setPublished) throw E.conflict('cannot_publish', S('error.cannot_publish'));
        if (!d.get(it.key)) throw new ApiError(404, 'not_found', S('error.not_found'));
        await d.setPublished(req, it.key, b.action === 'publish', reason);
        try { d.changed?.(it.key); } catch (e) { console.error('content changed', d.type, e.message); }
        live([{ type: d.type, key: it.key }]);
        const now = d.get(it.key);
        results.push({ ...it, ok: true, status: now?.status || null });
      } catch (e) {
        if (e && e.code === 'step_up_required') throw e;
        if (!(e && e.status)) throw e;
        results.push({ ...it, ok: false, http: e.status, code: e.code, message: e.message, details: e.details || null });
      }
    }
    res.json({ results });
  });

  // ---------------------------------------------------------------- built-in types, hooks, retention job
  const registry = { register, types, record, trashItem, untrash, purge, purgeExpired, dispatch, live, label };
  registerBuiltins({ registry, db, app, engine, admin, auth, dispatch });
  // Deletes in the existing editors (Admin › Content collections, catalog drafts) go to the Trash.
  admin.hooks.trash = (req, type, key, reason) => trashItem(req, type, key, reason);
  try { purgeExpired(); } catch (e) { console.error('content trash purge', e.message); }
  const timer = setInterval(() => { try { purgeExpired(); } catch (e) { console.error('content trash purge', e.message); } }, options.purgeMs ?? 10 * 60 * 1000);
  timer.unref?.();
  registry.close = () => clearInterval(timer);
  return registry;
}

module.exports = { mountContentAdmin, STATUSES };
