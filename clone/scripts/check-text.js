'use strict';
// Runs parlance/no-hardcoded-text (CLONE_SPEC.md §32.10) over every SPA module and prints each finding.
//   node scripts/check-text.js            (exit code 1 when anything is reported)
const fs = require('node:fs');
const path = require('node:path');
const { Linter } = require('eslint');
const rule = require('../eslint-rules/no-hardcoded-text');
const noUnescapedHtml = require('../eslint-rules/no-unescaped-html'); // registered (off) so its disable comments resolve

const JS = path.join(__dirname, '..', 'public', 'js');
const SKIP = new Set(['i18n.js']); // the catalog runtime itself
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'content' ? [] : walk(path.join(d, e.name))) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));

function lintText(code, filename = 'snippet.js') {
  const linter = new Linter({ configType: 'flat' });
  return linter.verify(code, [{ files: ['**/*.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'module' }, plugins: { parlance: { rules: { 'no-hardcoded-text': rule, 'no-unescaped-html': noUnescapedHtml } } }, linterOptions: { reportUnusedDisableDirectives: 'off' }, rules: { 'parlance/no-hardcoded-text': 'error' } }], { filename });
}
function checkAll() {
  const out = [];
  for (const f of walk(JS)) {
    if (SKIP.has(path.basename(f))) continue;
    for (const m of lintText(fs.readFileSync(f, 'utf8'), f)) out.push({ file: path.relative(path.join(JS, '..', '..'), f), line: m.line, column: m.column, message: m.message, fatal: !!m.fatal });
  }
  return out;
}
module.exports = { lintText, checkAll };
if (require.main === module) {
  const r = checkAll();
  for (const m of r) console.log(`${m.file}:${m.line}:${m.column} ${m.message}`);
  console.log(r.length ? `${r.length} hard-coded string(s)` : 'no hard-coded user-facing text');
  process.exitCode = r.length ? 1 : 0;
}
