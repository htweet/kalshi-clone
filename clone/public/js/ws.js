// Shared WebSocket client (spec §7.2): one connection, de-duplicated subscriptions,
// 5 s subscription-response timeout, exponential backoff with jitter, resubscribe on open.
// Data saver (CLONE_SPEC.md §38.7): fewer live updates (price ticks are batched: the latest per market every 10 s) and a
// polling fallback when the connection is unstable (two drops within a minute, or no connection after 10 s): the socket
// then retries only every 60 s and the registered pollers (socket.onPoll) refresh what is on screen every 15 s.
import { csrf, FE_SESSION_KEY } from './api.js';
import { clientToken, refreshClientToken } from './security.js';

const SUB_TIMEOUT_MS = 5000;
const BACKOFF_BASE = 500;
const BACKOFF_MAX = 30000;
const SAVER_TICK_MS = 10000; // data saver: ticker messages delivered at most every 10 s per market (latest wins)
const POLL_MS = 15000; // polling fallback cadence
const UNSTABLE_RETRY_MS = 60000; // socket retry while polling
const saverOn = () => typeof document !== 'undefined' && document.documentElement.dataset.saver === '1';

export class Socket {
  constructor() {
    this.conn = null;
    this.nextCommandId = 1;
    this.backoffExponent = 0;
    this.subs = new Map();          // key -> { params, handlers:Set, sids:[], pendingId }
    this.byCmd = new Map();         // cmd id -> key
    this.bySid = new Map();         // sid -> key
    this.timers = new Map();
    this.listeners = new Set();
    this.intentionalClose = false;
    this.reconnectTimer = null;
    this.connected = false;
    this.drops = []; // close times, for the "unstable" decision
    this.mode = 'ws'; // 'ws' | 'polling'
    this.pollers = new Set();
    this.pollTimer = null;
    this.batch = new Map(); // data saver: key -> latest ticker message
    this.batchTimer = null;
  }
  // Pollers refresh what is on screen while the connection is unstable (polling fallback). Returns an unsubscribe.
  onPoll(fn) { this.pollers.add(fn); return () => this.pollers.delete(fn); }
  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    clearInterval(this.pollTimer); this.pollTimer = null;
    if (mode === 'polling') this.pollTimer = setInterval(() => { if (typeof document !== 'undefined' && document.hidden) return; for (const fn of this.pollers) { try { fn(); } catch (e) { console.error(e); } } }, POLL_MS);
    this.emitState({ connected: this.connected, mode });
  }

  onState(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emitState(s) { this.connected = s.connected; const st = { mode: this.mode, ...s }; for (const fn of this.listeners) fn(st); }

  url() {
    const u = new URL('/v1/ws', location.href);
    u.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    u.searchParams.set('csrfToken', csrf.get() || '');
    const ct = clientToken.get(); // signed client token (PLAN P1.10; S2 AwsWafTokenForWebSocket)
    if (ct) u.searchParams.set('ct', ct);
    let fe = null;
    try { fe = localStorage.getItem(FE_SESSION_KEY); if (!fe) { fe = crypto.randomUUID(); localStorage.setItem(FE_SESSION_KEY, fe); } } catch { /* ignore */ }
    if (fe) u.searchParams.set('frontend_session', fe);
    return u.toString();
  }

  connect() {
    this.intentionalClose = false;
    // The upgrade needs a valid client token: make sure one is fresh, then open.
    const gen = (this.connectGen = (this.connectGen || 0) + 1);
    refreshClientToken().then(() => { if (gen === this.connectGen && !this.intentionalClose) this.open(); });
  }

  open() {
    const conn = new WebSocket(this.url());
    this.conn = conn;
    clearTimeout(this.openTimer);
    // Data saver: no connection within 10 s counts as unstable (polling fallback until a connection holds).
    this.openTimer = setTimeout(() => { if (this.conn === conn && conn.readyState !== WebSocket.OPEN && saverOn()) this.setMode('polling'); }, 10000);
    conn.onopen = () => {
      if (this.conn !== conn) return;
      clearTimeout(this.openTimer);
      this.nextCommandId = 1;
      this.backoffExponent = 0;
      this.openedAt = Date.now();
      this.emitState({ connected: true });
      this.resubscribe();
    };
    conn.onmessage = (ev) => { if (this.conn === conn) this.handle(JSON.parse(ev.data)); };
    conn.onclose = (ev) => {
      if (this.conn !== conn) return;
      for (const t of this.timers.values()) clearTimeout(t);
      this.timers.clear();
      this.emitState({ connected: false, code: ev.code });
      if (ev.code === 4401) window.dispatchEvent(new Event('parlance:session-ended')); // session revoked or expired (CLONE_SPEC §22.2)
      if (this.intentionalClose) return;
      // Unstable connection (data saver): two drops within a minute switch to polling; the socket retries every 60 s and
      // returns to live updates once a connection has held for a minute.
      const now = Date.now();
      this.drops = this.drops.filter((t) => now - t < 60000); this.drops.push(now);
      if (saverOn() && this.drops.length >= 2) this.setMode('polling');
      const delay = this.mode === 'polling' ? UNSTABLE_RETRY_MS : Math.min(BACKOFF_MAX, BACKOFF_BASE * 2 ** this.backoffExponent) + Math.floor(Math.random() * 500);
      this.backoffExponent += 1;
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }

  // Reconnect with fresh credentials (e.g. after log in / log out).
  reconnect() {
    this.close(4000, 'credentials changed', { intentional: true });
    this.connect();
  }

  close(code = 1000, reason = '', { intentional = true } = {}) {
    this.intentionalClose = intentional;
    clearTimeout(this.reconnectTimer);
    if (this.conn && this.conn.readyState <= 1) this.conn.close(code, reason);
    this.conn = null;
  }

  send(obj) { if (this.conn && this.conn.readyState === WebSocket.OPEN) { this.conn.send(JSON.stringify(obj)); return true; } return false; }

  subscribe(params, handler) {
    const key = JSON.stringify(params);
    let s = this.subs.get(key);
    if (s) { s.handlers.add(handler); } else {
      s = { params, handlers: new Set([handler]), sids: [], pendingId: null };
      this.subs.set(key, s);
      this.sendSubscribe(key);
    }
    return () => {
      s.handlers.delete(handler);
      if (s.handlers.size === 0) {
        this.subs.delete(key);
        if (s.sids.length) this.send({ id: this.nextCommandId++, cmd: 'unsubscribe', params: { sids: s.sids } });
        for (const sid of s.sids) this.bySid.delete(sid);
      }
    };
  }

  sendSubscribe(key) {
    const s = this.subs.get(key);
    const id = this.nextCommandId++;
    s.pendingId = id;
    s.sids = [];
    this.byCmd.set(id, key);
    if (this.send({ id, cmd: 'subscribe', params: s.params })) {
      this.timers.set(id, setTimeout(() => this.close(4000, 'subscription response timeout', { intentional: false }), SUB_TIMEOUT_MS));
    }
  }

  resubscribe() {
    this.byCmd.clear();
    this.bySid.clear();
    for (const key of this.subs.keys()) this.sendSubscribe(key);
  }

  handle(m) {
    if (m.id != null && this.timers.has(m.id) && (m.type === 'subscribed' || m.type === 'error')) {
      clearTimeout(this.timers.get(m.id));
      this.timers.delete(m.id);
    }
    if (m.type === 'subscribed') {
      const key = this.byCmd.get(m.id);
      const s = key && this.subs.get(key);
      if (s) { s.sids.push(m.msg.sid); this.bySid.set(m.msg.sid, key); }
      return;
    }
    if (m.type === 'error') { console.warn('[ws] error', m.msg); return; }
    if (this.mode === 'polling' && this.openedAt && Date.now() - this.openedAt > 60000) { this.drops = []; this.setMode('ws'); } // held for a minute
    if (m.sid != null) {
      const s = this.subs.get(this.bySid.get(m.sid));
      if (!s) return;
      // Data saver: price ticks are batched (latest per market and subscription, every 10 s); everything else is live.
      if (m.type === 'ticker' && saverOn()) {
        this.batch.set(`${m.sid}|${m.msg && m.msg.market_ticker}`, m);
        if (!this.batchTimer) this.batchTimer = setTimeout(() => this.flushBatch(), SAVER_TICK_MS);
        return;
      }
      for (const h of s.handlers) h(m);
    }
  }
  flushBatch() {
    this.batchTimer = null;
    const msgs = [...this.batch.values()]; this.batch.clear();
    for (const m of msgs) { const s = this.subs.get(this.bySid.get(m.sid)); if (s) for (const h of s.handlers) h(m); }
  }
}

export const socket = new Socket();
