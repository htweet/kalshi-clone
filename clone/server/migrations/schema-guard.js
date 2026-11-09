'use strict';
// A module's own schema function runs only when its database did not go through the migration runner
// (server/migrations/index.js sets db.__migrated): e.g. a module used directly on a fresh database in a unit test.
// Kept apart from the runner so modules can require it without loading every migration (and without a require cycle).
function ensureSchema(db, fn, ...args) {
  if (db.__migrated) return;
  fn(db, ...args);
}
module.exports = { ensureSchema };
