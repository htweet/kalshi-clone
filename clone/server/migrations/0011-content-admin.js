'use strict';
// Migration 0011 — content management for every entity (owner request 2026-11-15, CLONE_SPEC.md §43). Self-contained:
// it only adds two tables; no existing table changes, so every existing reader keeps working.
//   content_revisions  one row per admin create / update / trash / restore / purge of a registered content type that
//                      has no history of its own (the CMS store keeps its own versions in cms_versions): the content
//                      fields before and after (JSON), the actor, the reason and the time. "Restore this version"
//                      writes a revision's `after` back through the type's own validation.
//   content_trash      soft delete: the trashed item's full rows (and dependent rows) as JSON, removed from the live
//                      table at once so no public query can show it; restorable until purged after the owner-set number
//                      of days (owner setting content.trash_retention_days) or deleted forever from the Trash.
const SQL = `
CREATE TABLE IF NOT EXISTS content_revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL, action TEXT NOT NULL,
  before_json TEXT, after_json TEXT, actor_id TEXT, actor_email TEXT, reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_content_revisions_key ON content_revisions(type, key, version);
CREATE INDEX IF NOT EXISTS idx_content_revisions_time ON content_revisions(created_at);
CREATE TABLE IF NOT EXISTS content_trash (id TEXT PRIMARY KEY, type TEXT NOT NULL, key TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', snapshot_json TEXT NOT NULL,
  deleted_by TEXT, deleted_by_email TEXT, reason TEXT NOT NULL DEFAULT '', deleted_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_content_trash_key ON content_trash(type, key);
CREATE INDEX IF NOT EXISTS idx_content_trash_time ON content_trash(deleted_at);
`;

module.exports = {
  id: 11,
  name: 'content-admin',
  up(db) { db.exec(SQL); },
  SQL,
};
