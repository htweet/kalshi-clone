#!/usr/bin/env node
'use strict';
// Guardrail (PLAN P1.13): every environment variable the server reads must be documented in clone/.env.example.
// Run from anywhere: `node scripts/check-env-example.js` (also part of `npm run lint` in clone/).
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'clone', 'server');
const EXAMPLE = path.join(ROOT, 'clone', '.env.example');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : d.name.endsWith('.js') ? [p] : [];
  });
}

const used = new Map(); // name -> first file
const add = (name, file) => { if (!used.has(name)) used.set(name, path.relative(ROOT, file)); };
for (const file of walk(SERVER)) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) add(m[1], file);
  for (const m of src.matchAll(/process\.env\[\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]\s*\]/g)) add(m[1], file);
  // Small local readers such as `env('CHAT_USER_BURST', 8)` / `envNum("X")` that wrap process.env[k].
  for (const m of src.matchAll(/\benv[A-Za-z]*\(\s*['"`]([A-Z][A-Z0-9_]*)['"`]/g)) add(m[1], file);
  for (const m of src.matchAll(/\{([^}]*)\}\s*=\s*process\.env\b/g)) {
    for (const part of m[1].split(',')) { const n = part.split(/[:=]/)[0].trim(); if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) add(n, file); }
  }
}

const documented = new Set();
for (const line of fs.readFileSync(EXAMPLE, 'utf8').split(/\r?\n/)) {
  const m = /^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
  if (m) documented.add(m[1]);
}

const missing = [...used].filter(([n]) => !documented.has(n));
if (missing.length) {
  console.error('clone/.env.example is missing environment variables read by the server:');
  for (const [n, f] of missing) console.error(`  ${n}  (first read in ${f})`);
  process.exit(1);
}
console.log(`env check: ${used.size} variables read by clone/server, all documented in clone/.env.example`);
