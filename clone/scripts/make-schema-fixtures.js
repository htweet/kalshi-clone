#!/usr/bin/env node
'use strict';
// Schema fixtures from every released phase (PLAN P9.2, §8 item 6; CLONE_SPEC.md §39.3).
//
//   node scripts/make-schema-fixtures.js [phase ...]
//
// For each merged phase below, the clone/ folder of that commit is exported (git archive) into a temporary folder, the
// server of that phase is started on a fresh database with this repository's node_modules, invented data is created
// through its own API (two traders with deposits and a matched trade, an admin flag change that writes hash-chained audit
// rows), the server is stopped and the database is dumped as SQL (schema + rows, gzip) to
// tests/fixtures/schemas/<phase>.sql.gz. tests/migrations.e2e.test.js loads each dump, upgrades it with this build and
// runs the ledger, journal and audit-chain verifiers.
//
// Invented data only: example.test addresses, generated passwords, no personal data. The fixture master key is a fixed,
// public test key (derived below), so the audit chain of the dump can be verified; it protects nothing.
const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const CLONE = path.resolve(__dirname, '..');
const ROOT = path.resolve(CLONE, '..');
const OUT = path.join(CLONE, 'tests', 'fixtures', 'schemas');
// Phase → the commit on main where that phase was complete (CLONE_SPEC.md §39.3 lists the same table).
const PHASES = [
  ['phase-5d', 'ecb3513'], // feature flags, play mode, Central Bank
  ['phase-6', 'a0c0798'], // Perps completion
  ['phase-7', 'a5c102b'], // public trading API
  ['phase-7a', '2bbdf85'], // waitlists
  ['phase-7b', 'e001020'], // elections hub v2
  ['phase-8', 'af3e581'], // growth and reach
];
const FIXTURE_KEY = crypto.createHash('sha256').update(['parlance', 'schema', 'fixture', 'public', 'test', 'key'].join(':')).digest('hex');

// The child: runs inside the exported phase folder, so `require('../server/index.js')` is that phase's server.
const CHILD = `
'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { start } = require(path.join(process.env.PHASE_DIR, 'server', 'index.js'));
const { Client } = require(process.env.CLIENT_LIB);
const dbFile = process.env.FIXTURE_DB;
const PW = 'Benue-Harbor-Quill-' + crypto.randomBytes(3).toString('hex');
const HIGH = { burst: 1e6, per_second: 1e6 };
(async () => {
  const srv = await start({ port: 0, dbFile, quiet: true, sports: false, tickMs: 500, rate: { burst: 1e6, perSec: 1e6 },
    security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH }, admin: { email: 'root.fixture@example.test', password: PW },
    flags: { defaults: { 'perps.waitlist': false } } });
  const base = 'http://127.0.0.1:' + srv.port;
  const idem = () => ({ 'idempotency-key': crypto.randomUUID() });
  const a = await new Client(base, 'a').signUp('ada.fixture@example.test', PW, 'Ada Fixture');
  const b = await new Client(base, 'b').signUp('bola.fixture@example.test', PW, 'Bola Fixture');
  for (const c of [a, b]) { const r = await c.call('POST', '/v1/users/' + c.uid + '/deposits', { amount_dollars: 500 }, idem()); if (r.status !== 201) throw new Error('deposit ' + r.status + ' ' + r.text); }
  const q = new DatabaseSync(dbFile);
  const m = q.prepare("SELECT ticker FROM markets WHERE status='active' AND mve_collection_ticker IS NULL ORDER BY ticker LIMIT 1").get();
  q.close();
  const o1 = await a.call('POST', '/v1/users/' + a.uid + '/orders', { ticker: m.ticker, side: 'yes', action: 'buy', type: 'limit', price: 40, count: 10 }, idem());
  const o2 = await b.call('POST', '/v1/users/' + b.uid + '/orders', { ticker: m.ticker, side: 'no', action: 'buy', type: 'limit', price: 60, count: 10 }, idem());
  if (o1.status >= 300 || o2.status >= 300) throw new Error('orders ' + o1.status + ' ' + o2.status + ' ' + o2.text);
  const admin = await new Client(base, 'admin').logIn('root.fixture@example.test', PW);
  for (const enabled of [false, true]) {
    const r = await admin.call('PUT', '/v1/admin/flags/social', { enabled, reason: 'schema fixture: flag change audit row' });
    if (r.status !== 200) throw new Error('flag ' + r.status + ' ' + r.text);
  }
  await srv.close();
  console.log(JSON.stringify({ ok: true, market: m.ticker }));
})().catch((e) => { console.error(e); process.exit(1); });
`;

// SQL dump: tables (with their rows), then views, indexes and triggers — so rows load without firing triggers.
function dump(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const lit = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' || typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? `X'${Buffer.from(v).toString('hex')}'` : `'${String(v).replace(/'/g, "''")}'`);
  const out = ['PRAGMA foreign_keys=OFF;', 'BEGIN;'];
  const objs = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid").all();
  for (const o of objs.filter((x) => x.type === 'table' && !x.name.startsWith('sqlite_'))) {
    out.push(`${o.sql};`);
    const cols = db.prepare(`PRAGMA table_info("${o.name}")`).all().map((c) => c.name);
    for (const r of db.prepare(`SELECT * FROM "${o.name}"`).iterate()) out.push(`INSERT INTO "${o.name}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map((c) => lit(r[c])).join(',')});`);
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get()) for (const r of db.prepare('SELECT * FROM sqlite_sequence').all()) out.push(`INSERT INTO sqlite_sequence(name,seq) VALUES (${lit(r.name)},${lit(r.seq)});`);
  for (const t of ['view', 'index', 'trigger']) for (const o of objs.filter((x) => x.type === t)) out.push(`${o.sql};`);
  out.push('COMMIT;');
  db.close();
  return `${out.join('\n')}\n`;
}

function main() {
  const want = process.argv.slice(2);
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, commit] of PHASES) {
    if (want.length && !want.includes(name)) continue;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `parlance-fixture-${name}-`));
    try {
      const tar = path.join(tmp, 'src.tar');
      execFileSync('git', ['-C', ROOT, 'archive', '--format=tar', '-o', tar, commit, 'clone'], { stdio: 'inherit' });
      execFileSync('tar', ['-xf', tar, '-C', tmp]);
      const dir = path.join(tmp, 'clone');
      fs.symlinkSync(path.join(CLONE, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
      const child = path.join(dir, 'make-fixture.js');
      fs.writeFileSync(child, CHILD);
      const dbFile = path.join(tmp, 'data', 'fixture.db');
      fs.mkdirSync(path.dirname(dbFile), { recursive: true });
      const r = spawnSync(process.execPath, ['--no-warnings', child], { cwd: dir, stdio: 'inherit', timeout: 300000,
        env: { ...process.env, PHASE_DIR: dir, CLIENT_LIB: path.join(CLONE, 'tests', 'lib', 'client.js'), FIXTURE_DB: dbFile, SECRET_KEY: FIXTURE_KEY, NODE_ENV: 'test', KYC_REQUIRED: '0', SPORTS: '0' } });
      if (r.status !== 0) throw new Error(`${name}: the ${commit} server run failed`);
      const sql = dump(dbFile);
      const gz = zlib.gzipSync(Buffer.from(sql), { level: 9 });
      fs.writeFileSync(path.join(OUT, `${name}.sql.gz`), gz);
      console.log(`${name} (${commit}): ${(gz.length / 1024).toFixed(0)} kB gzip, ${(sql.length / 1048576).toFixed(1)} MB SQL`);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
}

if (require.main === module) main();
module.exports = { PHASES, FIXTURE_KEY, dump };
