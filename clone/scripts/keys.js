#!/usr/bin/env node
'use strict';
// Master key ring tool (RS4 key rotation, PLAN P9.6; CLONE_SPEC.md §39.10; runbook docs/runbooks/rotate-keys.md).
//
//   npm run keys -- status [--data-dir data]          where the ring comes from, key ids and fingerprints (never keys)
//   npm run keys -- rotate --file <keyring.json>      add k<n+1> and make it active; creates the ring from SECRET_KEY /
//                                                     the key file when <keyring.json> does not exist yet
//   npm run keys -- backup-key                        print a new random 64-hex backup key (for BACKUP_KEY / a secret)
//
// After `rotate`: point SECRET_KEYRING_FILE at the file (or update the Docker secret) and restart. On start the server
// sees values under the old key, re-encrypts them in the background, verifies, and retires the old key (Admin › System).
// The old key stays in the ring as verify-only for the audit-chain rows it sealed and for the HMAC lookups.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const kc = require('../server/crypto');
const { addKeyToFile } = require('../server/keyring');

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null; };
const dir = path.resolve(opt('data-dir') || path.join(__dirname, '..', 'data'));

if (cmd === 'status') {
  const src = kc.ringSource({ dir });
  const r = kc.keyring({ dir });
  console.log(`source: ${src.kind}${src.file ? ` (${src.file})` : ''}${src.inDataDir ? ' — inside the data folder: not allowed in production' : ''}`);
  console.log(`active: ${r.active}   hmac: ${r.hmac}`);
  for (const [kid, k] of r.keys) console.log(`  ${kid}  fingerprint ${kc.fingerprint(k)}${r.created && r.created[kid] ? `  created ${r.created[kid]}` : ''}`);
} else if (cmd === 'rotate') {
  const file = opt('file');
  if (!file) { console.error('usage: npm run keys -- rotate --file <keyring.json>'); process.exit(2); }
  const target = path.resolve(file);
  let fromRing = null; let fromKey = null;
  if (!fs.existsSync(target)) {
    const r = kc.keyring({ dir }); // the ring in use now (SECRET_KEYRING / SECRET_KEY / the key file)
    fromRing = { active: r.active, hmac: r.hmac, keys: Object.fromEntries([...r.keys].map(([k, v]) => [k, v.toString('hex')])), created: r.created || {} };
    if (r.keys.size === 1 && r.keys.has('k1')) { fromRing = null; fromKey = r.keys.get('k1'); }
  }
  const kid = addKeyToFile({ file: target, fromKey, fromRing });
  console.log(`Added ${kid} (active) to ${target}. Set SECRET_KEYRING_FILE=${target} (keep it outside the data folder) and restart; re-encryption runs on start.`);
} else if (cmd === 'backup-key') {
  console.log(crypto.randomBytes(32).toString('hex'));
} else {
  console.error('usage: npm run keys -- status | rotate --file <keyring.json> | backup-key');
  process.exit(2);
}
