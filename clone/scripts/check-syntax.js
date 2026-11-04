'use strict';
// Parses every SPA module (ES2024+, module goal) and reports syntax errors. Used after scripts/cms-extract.js rewrites.
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

const JS = path.join(__dirname, '..', 'public', 'js');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
let bad = 0;
for (const f of walk(JS)) {
  try { acorn.parse(fs.readFileSync(f, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' }); } catch (e) { bad += 1; console.log(`${path.relative(JS, f)}: ${e.message}`); }
}
console.log(bad ? `${bad} file(s) failed` : 'all modules parse');
process.exitCode = bad ? 1 : 0;
