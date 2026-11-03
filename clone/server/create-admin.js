'use strict';
// npm run create-admin — create (or re-enable) an admin account from the command line (CLONE_SPEC §22.5).
// Interactive: prompts for email, display name and password (not echoed). Non-interactive: ADMIN_EMAIL and
// ADMIN_PASSWORD (and optional ADMIN_NAME) in the environment. Run it while the server is stopped (the database is
// single-writer and locked by a running server). Uses DB_FILE like the server.
const path = require('node:path');
const readline = require('node:readline');
const { open } = require('./db');
const { nowIso, newId } = require('./util');
const pw = require('./passwords');

function ask(rl, q, { hidden = false } = {}) {
  return new Promise((resolve) => {
    if (!hidden) { rl.question(q, (a) => resolve(a.trim())); return; }
    const out = rl.output;
    rl._writeToOutput = (s) => { if (s.includes(q)) out.write(s); else out.write(s.replace(/[^\r\n]/g, '*')); };
    rl.question(q, (a) => { rl._writeToOutput = (s) => out.write(s); out.write('\n'); resolve(a); });
  });
}

async function main() {
  const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'parlance.db');
  let email = process.env.ADMIN_EMAIL; let password = process.env.ADMIN_PASSWORD; let name = process.env.ADMIN_NAME;
  if (!email || !password) {
    if (!process.stdin.isTTY) throw new Error('set ADMIN_EMAIL and ADMIN_PASSWORD, or run in a terminal to be prompted');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    try {
      email = email || await ask(rl, 'Admin email: ');
      name = name || await ask(rl, 'Display name [Exchange Admin]: ');
      password = await ask(rl, 'Password: ', { hidden: true });
      const again = await ask(rl, 'Repeat password: ', { hidden: true });
      if (password !== again) throw new Error('the passwords do not match');
    } finally { rl.close(); }
  }
  email = String(email).trim().toLowerCase();
  name = String(name || '').trim() || 'Exchange Admin';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('that is not a valid email address');
  const bad = pw.checkPolicy(password, { email, name });
  if (bad) throw new Error(`password rejected: ${bad.message}`);

  const db = open(file); // throws a clear error when a server is running on this database
  try {
    const hash = pw.hashPasswordSync(password);
    const ex = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    let id;
    if (ex) {
      if (ex.is_system) throw new Error('that is a system account');
      id = ex.id;
      db.prepare('UPDATE users SET password_hash=?, is_admin=1 WHERE id=?').run(hash, id);
    } else {
      id = newId('u_');
      db.prepare('INSERT INTO users(id,email,display_name,password_hash,is_admin,balance_cents,created_at) VALUES(?,?,?,?,1,0,?)').run(id, email, name, hash, nowIso());
    }
    const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    if (has('admin_roles')) db.prepare("INSERT INTO admin_roles(user_id,role,granted_by,granted_at) VALUES(?,'admin',NULL,?) ON CONFLICT DO NOTHING").run(id, nowIso());
    if (has('sessions')) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id); // a reset password ends old sessions
    if (has('auth_events')) db.prepare('INSERT INTO auth_events(id,ts,user_id,type,ip_prefix,device,detail) VALUES(?,?,?,?,?,?,?)').run(newId('ae_'), Date.now(), id, 'admin_bootstrap', '', 'command line', JSON.stringify({ via: 'create-admin', existing: !!ex }));
    if (has('admin_audit')) {
      const chain = require('./audit-chain');
      chain.init(db, { keyDir: path.dirname(path.resolve(file)) });
      chain.append(db, { actor_id: null, actor_email: 'cli', action: 'admin.bootstrap', target_type: 'user', target_id: id, after: { email, via: 'create-admin' }, reason: 'npm run create-admin' });
    }
    console.log(`${ex ? 'Updated' : 'Created'} admin ${email}. Start the server and log in.`);
  } finally { db.close(); }
}

main().catch((e) => { console.error(`create-admin: ${e.message}`); process.exit(1); });
