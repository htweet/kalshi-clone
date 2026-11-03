// Shared WebSocket client (spec §7.2): one connection, de-duplicated subscriptions,
// 5 s subscription-response timeout, exponential backoff with jitter, resubscribe on open.
import { csrf, FE_SESSION_KEY } from './api.js';
import { clientToken, refreshClientToken } from './security.js';

const SUB_TIMEOUT_MS = 5000;
const BACKOFF_BASE = 500;
const BACKOFF_MAX = 30000;

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
  }

  onState(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emitState(s) { this.connected = s.connected; for (const fn of this.listeners) fn(s); }

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
    conn.onopen = () => {
      if (this.conn !== conn) return;
      this.nextCommandId = 1;
      this.backoffExponent = 0;
      this.emitState({ connected: true });
      this.resubscribe();
    };
    conn.onmessage = (ev) => { if (this.conn === conn) this.handle(JSON.parse(ev.data)); };
    conn.onclose = (ev) => {
      if (this.conn !== conn) return;
      for (const t of this.timers.values()) clearTimeout(t);
      this.timers.clear();
      this.emitState({ connected: false, code: ev.code });
      if (ev.code === 4401) window.dispatchEvent(new Event('parlance:session-ended')); // session revoked or expired (SEC_IDENTITY_SPEC §22.2)
      if (this.intentionalClose) return;
      const delay = Math.min(BACKOFF_MAX, BACKOFF_BASE * 2 ** this.backoffExponent) + Math.floor(Math.random() * 500);
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
    if (m.sid != null) {
      const s = this.subs.get(this.bySid.get(m.sid));
      if (s) for (const h of s.handlers) h(m);
    }
  }
}

export const socket = new Socket();
