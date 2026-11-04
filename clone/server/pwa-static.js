'use strict';
// Progressive Web App files (CLONE_SPEC.md §31). Part of the static allowlist: server/security.js mountStatic() calls
// this before the SPA page handler, in both asset modes.
//
//   /manifest.webmanifest  application/manifest+json, public, 1 hour
//   /sw.js                 the service worker: dist/sw.js as built (version = build hash, precache = hashed assets), or
//                          public/sw.js rendered with a "dev-…" version and only the files below precached. no-cache, and
//                          its own CSP: a worker gets the CSP of its script response, and the API policy
//                          (default-src 'none') would forbid its fetch() calls
//   /offline.html          the static offline page (no scripts, no inline styles), its own strict CSP, no-cache
//   /icons/*.png|svg       app icons, public, 7 days
// Nothing here depends on the session or the user; the service worker fetches these without credentials.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { renderServiceWorker, PWA_STATIC } = require('../scripts/build');

const PUBLIC = path.join(__dirname, '..', 'public');
const DIST = path.join(__dirname, '..', 'dist');
const SW_CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const OFFLINE_CSP = "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'; object-src 'none'";

function mountPwaStatic(target, { assets, notFound }) {
  const dist = assets === 'dist';
  const memo = new Map(); // file -> { mtime, body }
  const load = (file, render) => {
    const st = fs.statSync(file);
    const hit = memo.get(file);
    if (hit && hit.mtime === st.mtimeMs) return hit.body;
    const raw = fs.readFileSync(file, 'utf8');
    const body = render ? render(raw) : raw;
    memo.set(file, { mtime: st.mtimeMs, body });
    return body;
  };
  const devSw = (src) => renderServiceWorker(src, `dev-${crypto.createHash('sha256').update(src).digest('hex').slice(0, 12)}`, PWA_STATIC);
  const send = (res, type, cacheControl, body, csp) => {
    res.setHeader('Cache-Control', cacheControl);
    if (csp) res.setHeader('Content-Security-Policy', csp);
    res.type(type).send(body);
  };
  const file = (name) => (dist ? path.join(DIST, name) : path.join(PUBLIC, name));
  const guard = (fn) => (req, res) => { try { fn(req, res); } catch (e) { if (e.code === 'ENOENT') return notFound(res); throw e; } };

  target.get('/manifest.webmanifest', guard((req, res) => send(res, 'application/manifest+json', 'public, max-age=3600', load(path.join(PUBLIC, 'manifest.webmanifest')))));
  target.get('/sw.js', guard((req, res) => send(res, 'text/javascript; charset=utf-8', 'no-cache', load(file('sw.js'), dist ? null : devSw), SW_CSP)));
  target.get('/offline.html', guard((req, res) => send(res, 'text/html; charset=utf-8', 'no-cache', load(file('offline.html')), OFFLINE_CSP)));
  target.use('/icons', (req, res, next) => (/^\/[a-z0-9-]+\.(png|svg)$/.test(req.path) ? next() : notFound(res)),
    express.static(path.join(PUBLIC, 'icons'), { index: false, dotfiles: 'deny', redirect: false, fallthrough: true, setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=604800') }));
}

module.exports = { mountPwaStatic, SW_CSP, OFFLINE_CSP };
