'use strict';
// Fixed-window rate limits persisted in SQLite (Phase 5B security gate: ballot lookups, AI-summary regeneration).
// Keys are hashed before they are stored, so no IP address or user id is kept in clear in this table.
const { ApiError } = require('./util');
const kc = require('./crypto');

const SCHEMA = 'CREATE TABLE IF NOT EXISTS content_rate_limits (bucket TEXT NOT NULL, key_hash TEXT NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (bucket, key_hash))';

function createLimiter(db, bucket, { limit, windowMs }) {
  db.exec(SCHEMA);
  const get = db.prepare('SELECT window_start, count FROM content_rate_limits WHERE bucket=? AND key_hash=?');
  const put = db.prepare('INSERT INTO content_rate_limits(bucket,key_hash,window_start,count) VALUES(?,?,?,?) ON CONFLICT(bucket,key_hash) DO UPDATE SET window_start=excluded.window_start, count=excluded.count');
  let lastPurge = 0;
  return {
    // Counts one request for `key`; throws 429 (with retry_after_sec) once the window's limit is reached.
    hit(key) {
      const now = Date.now();
      const ws = now - (now % windowMs);
      const h = kc.sha256hex(`${bucket}:${key}`).slice(0, 32);
      const row = get.get(bucket, h);
      const count = row && row.window_start === ws ? row.count : 0;
      if (count >= limit) {
        const retry = Math.max(1, Math.ceil((ws + windowMs - now) / 1000));
        const e = new ApiError(429, 'too_many_requests', 'too many requests', `try again in ${retry} s`);
        e.toJSON = () => ({ error: { code: e.code, message: e.message, details: e.details, retry_after_sec: retry } });
        throw e;
      }
      put.run(bucket, h, ws, count + 1);
      if (now - lastPurge > 60000) { lastPurge = now; db.prepare('DELETE FROM content_rate_limits WHERE window_start<?').run(now - 24 * 3600 * 1000); }
    },
  };
}

module.exports = { createLimiter };
