'use strict';
// Lists catalog keys whose default text is also a string literal in server code (likely an API data value, such as a
// category name, rather than display text), with where each key is used. A review aid for scripts/cms-extract.js.
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

const ROOT = path.join(__dirname, '..');
const serverData = new Set();
for (const f of fs.readdirSync(path.join(ROOT, 'server')).filter((x) => x.endsWith('.js'))) {
  const ast = acorn.parse(fs.readFileSync(path.join(ROOT, 'server', f), 'utf8'), { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true });
  (function w(n) { if (!n || typeof n.type !== 'string') return; if (n.type === 'Literal' && typeof n.value === 'string') serverData.add(n.value); for (const k of Object.keys(n)) { const v = n[k]; if (Array.isArray(v)) v.forEach(w); else if (v && typeof v.type === 'string') w(v); } })(ast);
}
const dir = path.join(ROOT, 'public', 'js', 'content');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
const code = walk(path.join(ROOT, 'public', 'js')).filter((f) => !f.includes(`${path.sep}content${path.sep}`)).map((f) => [f, fs.readFileSync(f, 'utf8')]);
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('-strings.js'))) {
  const s = fs.readFileSync(path.join(dir, f), 'utf8');
  const a = s.indexOf('/* CONTENT_JSON_BEGIN */'); const b = s.indexOf('/* CONTENT_JSON_END */');
  if (a < 0) continue;
  for (const [k, v] of Object.entries(JSON.parse(s.slice(a + 24, b)))) {
    if (!serverData.has(v) || v.length < 3) continue;
    const uses = code.filter(([, src]) => src.includes(`'${k}'`)).map(([file, src]) => { const i = src.indexOf(`'${k}'`); const line = src.slice(0, i).split('\n').length; return `${path.relative(ROOT, file)}:${line}`; });
    console.log(`${k}\t${JSON.stringify(v)}\t${uses.join(' ')}`);
  }
}
