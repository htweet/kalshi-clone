// Root store (observable) + query cache with staleTime/refetchInterval (spec §2 hybrid pattern).
import { api, csrf } from './api.js';
import { socket } from './ws.js';

class Observable {
  constructor() { this.subs = new Set(); }
  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  notify() { for (const fn of this.subs) fn(this); }
}

class SessionStore extends Observable {
  constructor() { super(); this.user = null; this.balance = null; this.props = {}; this.loaded = false; this.unsubs = []; }
  get uid() { return this.user && this.user.user_id; }

  async load() {
    try {
      const s = await api.session();
      if (s.user) { csrf.set(s.csrf_token); await this.setUser(s.user); } else { csrf.clear(); this.user = null; }
    } catch { this.user = null; }
    this.loaded = true;
    this.notify();
  }

  async setUser(user) {
    this.user = user;
    const [b, p] = await Promise.all([api.balance(user.user_id), api.properties(user.user_id)]);
    this.balance = b.balance_dollars;
    this.props = p.properties || {};
    applyTheme(this.props.theme);
    this.wsBind();
    this.notify();
  }

  wsBind() {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (!this.user) return;
    this.unsubs.push(socket.subscribe({ channels: ['user_balance'] }, (m) => {
      if (m.type === 'user_balance') { this.balance = m.msg.available_dollars; this.notify(); }
    }));
  }

  async login(email, password) {
    const r = await api.logIn({ email, password });
    csrf.set(r.csrf_token);
    socket.reconnect();
    await this.setUser(r.user);
  }

  async signup(body) {
    const r = await api.signUp(body);
    csrf.set(r.csrf_token);
    socket.reconnect();
    await this.setUser(r.user);
  }

  async logout() {
    try { await api.logOut(); } catch { /* ignore */ }
    csrf.clear();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.user = null; this.balance = null; this.props = {};
    applyTheme(localTheme());
    queries.clear();
    socket.reconnect();
    this.notify();
  }

  // Settings: DB-persisted for signed-in users; theme falls back to localStorage when signed out.
  async setProp(key, value) {
    this.props = { ...this.props, [key]: value };
    if (key === 'theme') { applyTheme(value); try { localStorage.setItem('parlance-theme', value); } catch { /* ignore */ } }
    this.notify();
    if (this.user) await api.setProperties(this.uid, { [key]: value });
  }
}

export function localTheme() { try { return localStorage.getItem('parlance-theme') || 'light'; } catch { return 'light'; } }
export function applyTheme(t) { document.documentElement.dataset.theme = t === 'dark' ? 'dark' : 'light'; }

// Minimal query cache: key -> {data, error, ts, promise}; staleTime & polling while visible.
class QueryCache {
  constructor() { this.map = new Map(); }
  async fetch(key, fn, { staleTime = 0 } = {}) {
    const k = JSON.stringify(key);
    const hit = this.map.get(k);
    if (hit && hit.data !== undefined && Date.now() - hit.ts < staleTime) return hit.data;
    if (hit && hit.promise) return hit.promise;
    const entry = hit || {};
    entry.promise = fn().then((d) => { entry.data = d; entry.ts = Date.now(); entry.promise = null; return d; }, (e) => { entry.promise = null; throw e; });
    this.map.set(k, entry);
    return entry.promise;
  }
  invalidate(prefix) { const p = JSON.stringify(prefix).slice(0, -1); for (const k of this.map.keys()) if (k.startsWith(p)) this.map.delete(k); }
  clear() { this.map.clear(); }
  poll(key, fn, { interval, onData }) {
    let stopped = false;
    const run = async () => {
      if (stopped) return;
      if (!document.hidden) { try { onData(await this.fetch(key, fn, { staleTime: interval - 50 })); } catch { /* keep polling */ } }
      if (!stopped) t = setTimeout(run, interval);
    };
    let t = setTimeout(run, 0);
    return () => { stopped = true; clearTimeout(t); };
  }
}

export const session = new SessionStore();
export const queries = new QueryCache();
