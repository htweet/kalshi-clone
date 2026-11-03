'use strict';
// Signed client tokens for Node-side API clients in the E2E suite (PLAN P1.10, CLONE_SPEC §21).
// /v1 writes and the WebSocket upgrade need an `X-Client-Token`. Browsers get one transparently (public/js/security.js);
// a non-browser client has to earn it the same way any script would: fetch an HTML route, solve the proof-of-work
// challenge it is served, then trade the page's signed boot proof for a token. The token is bound to the client's IP +
// User-Agent, so the caller must send the same User-Agent (Node fetch's default) on its own requests.
const crypto = require('node:crypto');

function leadingZeroBits(buf) {
  let z = 0;
  for (const b of buf) { if (b === 0) { z += 8; continue; } return z + Math.clz32(b) - 24; }
  return z;
}
function solvePow(id, difficulty) {
  for (let n = 0; n < 1e9; n++) if (leadingZeroBits(crypto.createHash('sha256').update(`${id}:${n}`).digest()) >= difficulty) return String(n);
  throw new Error('proof of work not found');
}

// -> { token, expiresIn, challenged, cookies }
async function fetchClientToken(base, { headers = {} } = {}) {
  const cookies = {};
  const jar = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const keep = (r) => { for (const sc of r.headers.getSetCookie()) { const kv = sc.split(';')[0]; const i = kv.indexOf('='); cookies[kv.slice(0, i)] = kv.slice(i + 1); } };
  const get = async () => { const r = await fetch(`${base}/`, { headers: { ...headers, cookie: jar() } }); keep(r); return { status: r.status, html: await r.text() }; };
  let page = await get();
  let challenged = false;
  if (page.status === 429) {
    challenged = true;
    const cfg = JSON.parse(/<script type="application\/json" id="plx-challenge">([^<]+)<\/script>/.exec(page.html)[1]);
    const v = await fetch(base + cfg.v, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', cookie: jar() }, body: JSON.stringify({ token: cfg.t, nonce: solvePow(cfg.id, cfg.d) }) });
    keep(v);
    if (!v.ok) throw new Error(`challenge verify failed: ${v.status} ${await v.text()}`);
    page = await get();
  }
  const boot = /<meta name="plx-boot" content="([^"]+)"/.exec(page.html);
  if (page.status !== 200 || !boot) throw new Error(`no boot proof (HTTP ${page.status})`);
  const r = await fetch(`${base}/v1/client_token`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', cookie: jar() }, body: JSON.stringify({ boot: boot[1] }) });
  const j = await r.json();
  if (!r.ok) throw new Error(`client token bootstrap failed: ${r.status} ${JSON.stringify(j)}`);
  return { token: j.token, expiresIn: j.expires_in, challenged, cookies };
}

// Cached per base URL; refreshed before it expires.
function clientTokens(base, opts) {
  let tok = null; let exp = 0; let pending = null;
  return async () => {
    if (tok && Date.now() < exp - 30000) return tok;
    if (!pending) pending = fetchClientToken(base, opts).then((r) => { tok = r.token; exp = Date.now() + r.expiresIn * 1000; return tok; }).finally(() => { pending = null; });
    return pending;
  };
}

module.exports = { fetchClientToken, clientTokens, solvePow, leadingZeroBits };
