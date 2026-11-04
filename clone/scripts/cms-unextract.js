'use strict';
// Undoes scripts/cms-extract.js for keys that turned out to be data, not text (an IANA zone id, a category name sent to
// the API): every t/tx/ts('key') call is replaced by the literal default and the key removed from its content module.
//   node scripts/cms-unextract.js key1 key2 …
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'public', 'js');
const CONTENT = path.join(JS, 'content');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
const keys = process.argv.slice(2);
const defaults = {};
for (const f of fs.readdirSync(CONTENT).filter((x) => x.endsWith('-strings.js'))) {
  const p = path.join(CONTENT, f); let s = fs.readFileSync(p, 'utf8');
  const a = s.indexOf('/* CONTENT_JSON_BEGIN */'); const b = s.indexOf('/* CONTENT_JSON_END */');
  if (a < 0) continue;
  const obj = JSON.parse(s.slice(a + 24, b));
  let changed = false;
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(obj, k)) { defaults[k] = obj[k]; delete obj[k]; changed = true; }
  if (changed) { s = `${s.slice(0, a + 24)} ${JSON.stringify(obj, null, 2)} ${s.slice(b)}`; fs.writeFileSync(p, s); }
}
const q = (v) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
for (const f of walk(JS).filter((x) => !x.startsWith(CONTENT))) {
  let s = fs.readFileSync(f, 'utf8'); const before = s;
  for (const [k, v] of Object.entries(defaults)) s = s.split(new RegExp(`\\b(?:t|tx|ts)\\('${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\)`)).join(q(v));
  if (s !== before) { fs.writeFileSync(f, s); console.log(`${path.relative(ROOT, f)}: restored`); }
}
for (const k of keys) if (!(k in defaults)) console.log(`not found: ${k}`);
