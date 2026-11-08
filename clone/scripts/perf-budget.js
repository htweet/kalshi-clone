'use strict';
// Performance budgets for the production bundle (PLAN P8.6, CLONE_SPEC.md §38.7): what a low-end Android phone on a 3G
// network downloads before the first page can render. Run after `npm run build` (CI does, see .github/workflows/ci.yml);
// tests/perf.e2e.test.js runs the same check and measures LCP and INP on a throttled phone.
//
//   initial_js   the entry module and every chunk it imports statically (the browser fetches all of them before the app
//                starts), compressed as served (Brotli)
//   css          the one stylesheet, compressed as served
//   chunk        any single lazily loaded chunk (a view), compressed
//   total_js     every script in the bundle, compressed (the service worker precaches them after the first visit)
//
// Raising a budget is a deliberate change: say why in the commit and update §38.7.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BUDGETS_KB = { initial_js: 160, css: 32, chunk: 24, total_js: 380 };
const DIST = path.join(__dirname, '..', 'dist');

function compressed(file) {
  const br = `${file}.br`;
  if (fs.existsSync(br)) return fs.statSync(br).size;
  return zlib.brotliCompressSync(fs.readFileSync(file)).length;
}

function measure(dist = DIST) {
  const dir = path.join(dist, 'assets');
  const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
  const initial = new Set();
  const walk = (f) => {
    if (initial.has(f)) return;
    initial.add(f);
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // Static imports only (`import … from "./chunk-X.js"` / `import "./chunk-X.js"`); `import("./…")` is lazy.
    for (const m of src.matchAll(/(?:^|[;}\s])import\s*(?:[^'"();]*?from\s*)?["']\.\/([A-Za-z0-9_-]+\.js)["']/g)) walk(m[1]);
  };
  walk(manifest.entry.js);
  const scripts = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  const size = Object.fromEntries(scripts.map((f) => [f, compressed(path.join(dir, f))]));
  const lazy = scripts.filter((f) => !initial.has(f));
  const largest = lazy.reduce((a, f) => (size[f] > (size[a] || 0) ? f : a), '');
  const kb = (n) => Math.round((n / 1024) * 10) / 10;
  return {
    initial_js: kb([...initial].reduce((a, f) => a + size[f], 0)),
    initial_files: initial.size,
    css: kb(compressed(path.join(dir, manifest.entry.css))),
    chunk: kb(size[largest] || 0),
    largest_chunk: largest,
    total_js: kb(scripts.reduce((a, f) => a + size[f], 0)),
  };
}

function check(dist = DIST) {
  const m = measure(dist);
  const over = Object.entries(BUDGETS_KB).filter(([k, v]) => m[k] > v).map(([k, v]) => `${k} ${m[k]} KB > ${v} KB`);
  return { measured: m, budgets: BUDGETS_KB, over };
}

if (require.main === module) {
  const r = check();
  for (const [k, v] of Object.entries(BUDGETS_KB)) console.log(`${k.padEnd(10)} ${String(r.measured[k]).padStart(7)} KB  (budget ${v} KB)`);
  if (r.over.length) { console.error(`Performance budget exceeded: ${r.over.join('; ')}`); process.exit(1); }
  console.log('Performance budgets: within limits.');
}

module.exports = { BUDGETS_KB, measure, check };
