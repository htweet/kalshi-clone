'use strict';
// Migration 0015 — WAL segments by time (WAL growth alert, CLONE_SPEC.md §39.20). The alert rule, the metrics scrape and
// Admin › System read "WAL shipped in the last hour" (SUM(bytes) WHERE created_ts >= now - 1 h) every 30 s; with
// shipping every 10 s a week's window holds ~60,000 segments, read in full without an index on created_ts.
module.exports = {
  id: 15,
  name: 'wal-segment-time',
  up(db) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ops_wal_segments'").get()) return;
    db.exec('CREATE INDEX IF NOT EXISTS idx_ops_wal_created ON ops_wal_segments(created_ts, bytes);');
  },
};
