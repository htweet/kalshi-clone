'use strict';
// Migration 0006 — Help Center feedback (owner request 2026-11-15, CLONE_SPEC.md §40). "Was this helpful?" under every
// help guide: one vote per voter and guide (a member's later vote replaces the earlier one), with an optional comment.
// voter is `u:<user id>` for a signed-in member, or `a:` + the SHA-256 of a random token the visitor's browser keeps
// (no IP address or other personal data is stored for visitors). Admin › Content › Help feedback reads it.
const SQL = `
CREATE TABLE IF NOT EXISTS help_feedback (id TEXT PRIMARY KEY, slug TEXT NOT NULL, voter TEXT NOT NULL, user_id TEXT, helpful INTEGER NOT NULL,
  comment TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(slug, voter));
CREATE INDEX IF NOT EXISTS idx_help_feedback_slug ON help_feedback(slug, updated_at);
CREATE INDEX IF NOT EXISTS idx_help_feedback_updated ON help_feedback(updated_at);
`;

module.exports = {
  id: 6,
  name: 'help-feedback',
  up(db) { db.exec(SQL); },
};
