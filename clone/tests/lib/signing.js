'use strict';
// Signed public-API requests for the Phase 7 suites (CLONE_SPEC.md §35.3). Keys are generated at test time; no key
// material is committed. Signature: base64 over `timestamp + METHOD + path` (no query string); RSA keys sign with
// RSA-PSS / SHA-256 / salt length 32, Ed25519 keys with Ed25519.
const crypto = require('node:crypto');
const { WebSocket } = require('ws');

function sign(privateKey, message) {
  const k = typeof privateKey === 'string' ? crypto.createPrivateKey(privateKey) : privateKey;
  if (k.asymmetricKeyType === 'ed25519') return crypto.sign(null, Buffer.from(message), k).toString('base64');
  return crypto.sign('sha256', Buffer.from(message), { key: k, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }).toString('base64');
}
function headersFor({ keyId, privateKey, method, path, ts = Date.now() }) {
  const p = String(path).split('?')[0];
  return { 'PARLANCE-ACCESS-KEY': keyId, 'PARLANCE-ACCESS-TIMESTAMP': String(ts), 'PARLANCE-ACCESS-SIGNATURE': sign(privateKey, `${ts}${method.toUpperCase()}${p}`) };
}
const ed25519 = () => crypto.generateKeyPairSync('ed25519');
const rsa = (bits = 2048) => crypto.generateKeyPairSync('rsa', { modulusLength: bits });
const pubPem = (kp) => kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();

class SignedClient {
  // base: http://host:port; prefix: '' (main) or '/demo-api' (demo behind the main site); keyId + privateKey.
  constructor(base, keyId, privateKey, { prefix = '' } = {}) { Object.assign(this, { base, keyId, privateKey, prefix }); }
  async call(method, path, body, { headers = {}, ts, sigPath, raw = false } = {}) {
    const full = `${this.prefix}${path}`;
    const h = { accept: 'application/json', ...headersFor({ keyId: this.keyId, privateKey: this.privateKey, method, path: sigPath || full, ts }), ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(this.base + full, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return raw ? { r, text } : { status: r.status, body: json, text, headers: r.headers, code: json && json.error ? json.error.code : null, reason: json && json.error ? json.error.reason : null };
  }
  // Public WebSocket with the signed upgrade headers (method GET, the WebSocket path).
  socket(path = '/trade-api/ws/v2', { ts, headers = {} } = {}) {
    const full = `${this.prefix}${path}`;
    const u = new URL(full, this.base); u.protocol = 'ws:';
    const ws = new WebSocket(u, { headers: { ...headersFor({ keyId: this.keyId, privateKey: this.privateKey, method: 'GET', path: full, ts }), ...headers } });
    return wrapSocket(ws);
  }
}

function wrapSocket(ws) {
  const messages = []; const waiters = []; let id = 0;
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch { return; }
    messages.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  const closed = new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: String(reason) })));
  const opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); ws.once('unexpected-response', (req, res) => reject(Object.assign(new Error(`ws upgrade refused: ${res.statusCode}`), { status: res.statusCode }))); });
  const waitFor = (pred, ms = 6000) => {
    const hit = messages.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error('timed out waiting for a WebSocket message')); } }, ms);
    });
  };
  const cmd = (c, params) => { const myId = ++id; ws.send(JSON.stringify({ id: myId, cmd: c, ...(params ? { params } : {}) })); return myId; };
  const subscribe = async (channels, params = {}) => {
    const myId = cmd('subscribe', { channels, ...params });
    const out = [];
    for (let i = 0; i < channels.length; i++) {
      const m = await waitFor((x) => x.id === myId && ['subscribed', 'error'].includes(x.type) && !out.includes(x));
      out.push(m);
      if (m.type === 'error') break;
    }
    return out;
  };
  return { ws, messages, opened, closed, waitFor, cmd, subscribe, close: () => { try { ws.close(); } catch { /* ignore */ } } };
}

module.exports = { sign, headersFor, ed25519, rsa, pubPem, SignedClient, wrapSocket };
