#!/usr/bin/env node
'use strict';
// Production asset build (PLAN P1.11, mirrors S3: content-hashed, minified, immutable chunks and no source maps).
//
//   node scripts/build.js             build public/ -> dist/
//   node scripts/build.js --if-stale  build only when dist/ is missing or older than the sources
//
// Output: dist/index.html (the page template, with __CSP_NONCE__ / __PLX_BOOT__ placeholders the server fills per
// response), dist/assets/main-<hash>.js + chunk-<hash>.js (ES modules, code-split), dist/assets/app-<hash>.css (every
// stylesheet linked from public/index.html, in order) and the fonts it references, dist/manifest.json (source hash).
// PWA (CLONE_SPEC.md §31): dist/offline.html (static fallback page, its stylesheet links pointed at the bundle) and
// dist/sw.js (the service worker with this build's version and precache list: every hashed asset, the offline page,
// the web app manifest and the icons). The version is derived from the source hash, the output file list and an
// optional `salt` (tests use it to produce a "new version" without touching the sources).
// No .map files and no sourceMappingURL comments are produced. The build goes to a temporary directory first and is
// swapped in, so a running server never sees a half-written dist/.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const DIST = path.join(ROOT, 'dist');
const MANIFEST = 'manifest.json';

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : [p];
  }).sort();
}

// Hash of every source file (path + bytes) plus this script, so any change marks dist/ stale.
function sourceHash() {
  const h = crypto.createHash('sha256');
  for (const f of [...walk(PUBLIC), __filename]) {
    h.update(path.relative(ROOT, f).replace(/\\/g, '/'));
    h.update('\0');
    h.update(fs.readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex');
}

function readManifest(dir = DIST) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')); } catch { return null; }
}

function isStale() {
  const m = readManifest();
  if (!m || !fs.existsSync(path.join(DIST, 'index.html'))) return true;
  return m.source_hash !== sourceHash();
}

const STYLE_LINK = /^[ \t]*<link rel="stylesheet" href="\/([A-Za-z0-9_-]+\.css)"[^>]*>[ \t]*\r?\n/gm;

// The service worker: version and precache list filled into public/sw.js.
const PWA_STATIC = ['/offline.html', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png', '/icons/badge-72.png'];
function renderServiceWorker(src, version, precache) {
  const out = src.replace(/'__PLX_SW_VERSION__'/, JSON.stringify(version)).replace(/\/\* __PLX_PRECACHE__ \*\/ \[[^\]]*\]/, JSON.stringify(precache));
  if (out.includes('__PLX_SW_VERSION__') || out.includes('__PLX_PRECACHE__')) throw new Error('public/sw.js placeholders were not filled');
  return out;
}

async function build({ quiet = false, salt = '' } = {}) {
  let esbuild;
  try { esbuild = require('esbuild'); } catch {
    throw new Error('esbuild is not installed (it is a devDependency). Run `npm install` (or build on a machine with dev dependencies and ship dist/).');
  }
  const t0 = Date.now();
  const hash = sourceHash();
  const tmp = path.join(ROOT, `.dist-tmp-${process.pid}-${Date.now()}`);
  const assets = path.join(tmp, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  try {
    const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
    const cssFiles = [...html.matchAll(STYLE_LINK)].map((m) => m[1]);
    if (!cssFiles.length) throw new Error('public/index.html links no stylesheets');
    const common = { bundle: true, minify: true, sourcemap: false, legalComments: 'none', logLevel: 'silent', metafile: true, write: true, outdir: assets };
    const js = await esbuild.build({
      ...common, entryPoints: { main: path.join(PUBLIC, 'js', 'main.js') }, splitting: true, format: 'esm', target: ['es2022'],
      entryNames: '[name]-[hash]', chunkNames: 'chunk-[hash]',
    });
    const css = await esbuild.build({
      ...common, stdin: { contents: cssFiles.map((f) => `@import "./${f}";`).join('\n'), resolveDir: PUBLIC, loader: 'css', sourcefile: 'bundle.css' },
      entryNames: 'app-[hash]', assetNames: '[name]-[hash]', loader: { '.woff2': 'file' },
    });
    const out = (meta, test) => Object.keys(meta.outputs).map((p) => path.basename(p)).find(test);
    const mainJs = out(js.metafile, (f) => /^main-[A-Z0-9]+\.js$/i.test(f));
    const appCss = out(css.metafile, (f) => /^app-[A-Z0-9]+\.css$/i.test(f));
    if (!mainJs || !appCss) throw new Error('esbuild did not produce the expected entry files');

    // The page template: one hashed stylesheet in place of the per-file links, the hashed entry module.
    let first = true;
    let page = html.replace(STYLE_LINK, (line) => {
      if (!first) return '';
      first = false;
      return line.replace(/href="\/[^"]+"/, `href="/assets/${appCss}"`);
    });
    const before = page;
    page = page.replace(/src="\/js\/main\.js"/, `src="/assets/${mainJs}"`);
    if (page === before) throw new Error('public/index.html has no /js/main.js module script');
    fs.writeFileSync(path.join(tmp, 'index.html'), page);
    // Offline fallback page: the same single hashed stylesheet in place of its per-file links.
    let firstOff = true;
    const offline = fs.readFileSync(path.join(PUBLIC, 'offline.html'), 'utf8').replace(STYLE_LINK, (line) => {
      if (!firstOff) return '';
      firstOff = false;
      return line.replace(/href="\/[^"]+"/, `href="/assets/${appCss}"`);
    });
    if (firstOff) throw new Error('public/offline.html links no stylesheet');
    fs.writeFileSync(path.join(tmp, 'offline.html'), offline);

    const files = walk(assets).map((f) => path.relative(tmp, f).replace(/\\/g, '/'));
    for (const f of files) {
      if (f.endsWith('.map')) throw new Error(`source map emitted: ${f}`);
      if (/\.(js|css)$/.test(f) && /sourceMappingURL/.test(fs.readFileSync(path.join(tmp, f), 'utf8'))) throw new Error(`sourceMappingURL left in ${f}`);
    }
    const precache = [...PWA_STATIC, ...files.map((f) => `/${f}`)];
    const version = crypto.createHash('sha256').update(`${hash}\0${files.join('\n')}\0${salt}`).digest('hex').slice(0, 16);
    fs.writeFileSync(path.join(tmp, 'sw.js'), renderServiceWorker(fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8'), version, precache));
    fs.writeFileSync(path.join(tmp, MANIFEST), JSON.stringify({ source_hash: hash, built_at: new Date().toISOString(), esbuild: esbuild.version, entry: { js: mainJs, css: appCss }, files, pwa: { version, precache } }, null, 1));

    fs.rmSync(DIST, { recursive: true, force: true });
    fs.renameSync(tmp, DIST);
    if (!quiet) console.log(`Built ${files.length} assets into dist/ in ${Date.now() - t0} ms (${mainJs}, ${appCss}).`);
    return readManifest();
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

let pending = null;
// Build when dist/ is missing or stale; concurrent callers share one build.
async function ensureBuilt({ quiet = true } = {}) {
  if (!isStale()) return readManifest();
  if (!pending) pending = build({ quiet }).finally(() => { pending = null; });
  return pending;
}

module.exports = { build, ensureBuilt, isStale, sourceHash, readManifest, renderServiceWorker, PWA_STATIC, DIST, PUBLIC };

if (require.main === module) {
  const skip = process.argv.includes('--if-stale') && !isStale();
  (skip ? Promise.resolve(readManifest()) : build()).then((m) => {
    if (skip) console.log(`dist/ is up to date (${m.entry.js}, ${m.entry.css}).`);
  }, (e) => { console.error(`Build failed: ${e.message}`); process.exit(1); });
}
