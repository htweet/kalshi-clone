'use strict';
// Migration 0001 — baseline (PLAN P9.2, CLONE_SPEC.md §39.3).
// Phases 0-8 upgraded the schema with idempotent column checks and one-time data upgrades spread over fourteen modules,
// run on every start. They now run here, once, in the order the server used to run them (server/app.js construction
// order), so every existing database upgrades exactly as before and a new database ends at the same schema. Each module
// keeps the code in an exported `schema(db)`; its checksum (with the SQL it executes) is part of this migration's, so an
// edit to an applied baseline is refused at start — later changes go in new numbered migrations.
const MODULES = ['../auth', '../waitlists', '../admin', '../audit-chain', '../identity', '../kyc', '../messaging', '../perps', '../combos', '../central-bank', '../play-mode', '../referrals'];

module.exports = {
  id: 1,
  name: 'baseline',
  sources: () => {
    const db = require('../db');
    const out = [db.SCHEMA, db.migrate, db.migratePhase5a];
    for (const m of MODULES) { const mod = require(m); out.push(mod.schema); if (mod.SCHEMA) out.push(mod.SCHEMA); }
    return out;
  },
  up(db, ctx = {}) {
    require('../db').migrate(db); // core tables (also run at open(), before seeding; idempotent)
    require('../journal').init(db); // the double-entry journal tables (the play-mode markers below stamp them)
    require('../auth').schema(db, { keyDir: ctx.keyDir }); // sessions, two-factor (hashes plaintext session tokens, encrypts TOTP secrets)
    require('../waitlists').schema(db); // waitlists; moves the Phase 6 perp_waitlist table into it
    require('../admin').schema(db); // admin, CMS drafts and promos, admin_audit
    require('../audit-chain').schema(db); // hash-chain columns on admin_audit
    require('../identity').schema(db);
    require('../kyc').schema(db);
    require('../messaging').schema(db); // email / SMS outboxes
    require('../perps').schema(db); // Perps tables, subaccounts, positions rebuild, units (x100) once
    require('../combos').schema(db); // RFQ columns, combo price grid
    require('../central-bank').schema(db);
    require('../play-mode').schema(db); // money-mode markers on the ledger and journals
    require('../referrals').schema(db);
  },
};
