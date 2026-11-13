'use strict';
// HTTP and WebSocket clients for API-level E2E tests (authz matrix, idempotency). They authenticate exactly the way the
// SPA does: load the page, exchange its boot proof for the signed client token (`X-Client-Token`, PLAN P1.10), fetch
// the login CSRF token (P1.4), then log in and send the session CSRF token on every write. Steps the server does not
// offer (e.g. an older build without client tokens) are skipped, so the helpers work across builds.
const { WebSocket } = require('ws');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 parlance-e2e';

class Client {
  constructor(base, name = 'client') {
    this.base = base;
    this.name = name;
    this.jar = new Map();
    this.csrf = '';
    this.ct = '';
    this.user = null;
  }

  get uid() { return this.user && this.user.user_id; }
  cookieHeader() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }

  absorb(r) {
    const list = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
    for (const c of list) {
      const kv = c.split(';')[0];
      const i = kv.indexOf('=');
      if (i < 1) continue;
      const k = kv.slice(0, i).trim(); const v = kv.slice(i + 1).trim();
      if (v === '' || /max-age=0\b/i.test(c) || /expires=thu, 01 jan 1970/i.test(c)) this.jar.delete(k); else this.jar.set(k, v);
    }
    const rotated = r.headers.get('x-csrf-token');
    if (rotated) this.csrf = rotated;
  }

  // autoRefresh (load generation, off by default): a write refused with client_token_invalid fetches a new client token
  // and is retried once, as the SPA does (public/js/api.js); tests of expired or forged tokens keep seeing the refusal.
  async call(method, p, body, headers = {}, retried = false) {
    const h = { 'user-agent': UA, accept: 'application/json', ...headers };
    const cookie = this.cookieHeader();
    if (cookie) h.cookie = cookie;
    if (body !== undefined) h['content-type'] = 'application/json';
    if (this.csrf && !('x-csrf-token' in headers)) h['x-csrf-token'] = this.csrf;
    if (this.ct && !('x-client-token' in headers)) h['x-client-token'] = this.ct;
    const init = { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)), redirect: 'manual' };
    let r;
    try { r = await fetch(this.base + p, init); } catch (e) {
      // A pooled keep-alive socket to a server that was restarted: safe to retry reads once.
      if (method !== 'GET' && method !== 'HEAD') throw e;
      r = await fetch(this.base + p, init);
    }
    this.absorb(r);
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (json && typeof json.csrf_token === 'string') this.csrf = json.csrf_token;
    const code = json && json.error ? json.error.code : null;
    if (this.autoRefresh && !retried && code === 'client_token_invalid' && !('x-client-token' in headers) && p !== '/v1/client_token') {
      if (!this.renewing) this.renewing = this.boot().finally(() => { this.renewing = null; }); // one renewal for concurrent refusals
      await this.renewing;
      return this.call(method, p, body, headers, true);
    }
    return { status: r.status, body: json, text, headers: r.headers, code };
  }

  // What the SPA does on page load: boot proof -> client token; login CSRF token for the sign-in form.
  async boot() {
    const page = await this.call('GET', '/', undefined, { accept: 'text/html' });
    const meta = /<meta[^>]*name="plx-boot"[^>]*>/.exec(page.text || '');
    const proof = meta && /content="([^"]*)"/.exec(meta[0]);
    if (proof) {
      const t = await this.call('POST', '/v1/client_token', { boot: proof[1] });
      if (t.status === 200 && t.body && t.body.token) this.ct = t.body.token;
    }
    await this.call('GET', '/v1/auth/csrf');
    return this;
  }

  async signUp(email, password, displayName) {
    await this.boot();
    const r = await this.call('POST', '/v1/users', { email, password, display_name: displayName });
    if (r.status !== 201) throw new Error(`sign-up ${email} failed: ${r.status} ${r.text}`);
    this.user = r.body.user;
    return this;
  }

  async logIn(email, password) {
    this.jar.clear(); this.csrf = ''; this.ct = '';
    await this.boot();
    const r = await this.call('POST', '/v1/log_in', { email, password });
    if (r.status !== 200 || !r.body || !r.body.user) throw new Error(`log-in ${email} failed: ${r.status} ${r.text}`);
    this.user = r.body.user;
    return this;
  }

  // WebSocket on /v1/ws with this client's cookie, CSRF token and client token (as the SPA's ws.js does).
  // keep: false (load generation) keeps only a small rolling buffer of command replies and skips decoding ordinary feed
  // messages unless a waiter is pending: with hundreds of sockets, keeping every message grows without limit.
  socket({ csrf = this.csrf, origin = this.base, keep = true } = {}) {
    const u = new URL('/v1/ws', this.base);
    u.protocol = 'ws:';
    u.searchParams.set('csrfToken', csrf || '');
    if (this.ct) u.searchParams.set('ct', this.ct);
    const ws = new WebSocket(u, { headers: { cookie: this.cookieHeader(), 'user-agent': UA }, origin });
    const messages = [];
    const waiters = [];
    let id = 0;
    ws.on('message', (raw) => {
      const str = String(raw);
      if (!keep && !waiters.length && !str.includes('"id":')) return;
      let m; try { m = JSON.parse(str); } catch { return; }
      if (keep) messages.push(m);
      else if (m.id != null) { messages.push(m); if (messages.length > 200) messages.shift(); }
      for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
    });
    const opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); ws.once('unexpected-response', (req, res) => reject(new Error(`ws upgrade refused: ${res.statusCode}`))); });
    const waitFor = (pred, ms = 5000) => {
      const hit = messages.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error('timed out waiting for a WebSocket message')); } }, ms);
      });
    };
    const subscribe = async (channels, params = {}) => {
      const myId = ++id;
      ws.send(JSON.stringify({ id: myId, cmd: 'subscribe', params: { channels, ...params } }));
      const replies = [];
      for (let i = 0; i < channels.length; i++) {
        const m = await waitFor((x) => x.id === myId && (x.type === 'subscribed' || x.type === 'error') && !replies.includes(x));
        replies.push(m);
        if (m.type === 'error') break;
      }
      return replies;
    };
    return { ws, messages, opened, waitFor, subscribe, close: () => { try { ws.close(); } catch { /* ignore */ } } };
  }
}

module.exports = { Client, UA };
