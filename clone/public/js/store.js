// Root store (observable) + query cache with staleTime/refetchInterval (spec §2 hybrid pattern).
import { api, csrf } from './api.js';
import { socket } from './ws.js';
import { toast } from './lib.js';

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
    // Each call may be refused (e.g. session_time_limit_reached); the user is still signed in.
    const [b, p, sp] = await Promise.all([api.balance(user.user_id).catch(() => ({ balance_dollars: null })), api.properties(user.user_id).catch(() => ({ properties: {} })), api.myProfile(user.user_id).catch(() => ({ profile: null }))]);
    this.balance = b.balance_dollars;
    this.nickname = sp.profile ? sp.profile.nickname : null;
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

  // Login CSRF (SEC_IDENTITY_SPEC §22.2): pre-session endpoints need a fresh token bound to a short-lived cookie.
  async preAuth() { csrf.set((await api.loginCsrf()).csrf_token); }

  // Returns {mfa_token} when a second factor is required, {change_token} when an admin forced a password reset,
  // otherwise completes the sign-in.
  async login(email, password) {
    await this.preAuth();
    const r = await api.logIn({ email, password });
    if (r.mfa_required) return { mfa_token: r.mfa_token };
    if (r.password_change_required) return { change_token: r.change_token };
    await this.finishLogin(r);
    return null;
  }

  async loginMfa(mfaToken, code) {
    const r = await api.logInMfa({ mfa_token: mfaToken, code });
    if (r.password_change_required) return { change_token: r.change_token };
    await this.finishLogin(r);
    return null;
  }

  async completePasswordChange(changeToken, newPassword) { await this.finishLogin(await api.completePasswordChange({ change_token: changeToken, new_password: newPassword })); }

  async setupAdmin(body) { await this.preAuth(); await this.finishLogin(await api.setupAdmin(body)); }

  async finishLogin(r) {
    csrf.set(r.csrf_token);
    socket.reconnect();
    await this.setUser(r.user);
  }

  async signup(body) {
    await this.preAuth();
    const r = await api.signUp(body);
    csrf.set(r.csrf_token);
    socket.reconnect();
    await this.setUser(r.user);
  }

  // The server ended this session (signed out from another device, idle timeout, lock): re-check and, if it is
  // really gone, drop to the signed-out state without another round trip.
  async sessionEnded() {
    if (this.checking || !this.user) return;
    this.checking = true;
    try {
      const had = this.user;
      await this.load();
      if (!this.user) { this.clearLocal(); toast('You were signed out of this device.'); }
      else if (this.user.user_id !== had.user_id) this.notify();
    } finally { this.checking = false; }
  }

  clearLocal() {
    csrf.clear();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.user = null; this.balance = null; this.props = {}; this.nickname = null;
    applyTheme(localTheme());
    queries.clear();
    this.notify();
  }

  async logout() {
    try { await api.logOut(); } catch { /* ignore */ }
    csrf.clear();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.user = null; this.balance = null; this.props = {}; this.nickname = null;
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

export function localTheme() { try { return localStorage.getItem('parlance-theme') || 'dark'; } catch { return 'dark'; } }
export function applyTheme(t) { document.documentElement.dataset.theme = t === 'light' ? 'light' : 'dark'; }

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
window.addEventListener('parlance:session-ended', () => { session.sessionEnded(); });
export const queries = new QueryCache();
