// Transport layer (spec §2): one method per endpoint, cookie session + x-csrf-token header.
import { getLocalWithExpiry, setLocalWithExpiry, removeLocal } from './lib.js';
import { refreshClientToken, isClientTokenError } from './security.js';

export const CSRF_KEY = 'csrfToken';
export const FE_SESSION_KEY = 'fe-session-id';
const CSRF_TTL = 30 * 24 * 3600 * 1000;

export class ApiError extends Error {
  constructor(status, body) {
    const e = (body && body.error) || {};
    super(e.details ? `${e.message}: ${e.details}` : e.message || body?.msg || `HTTP ${status}`);
    this.status = status;
    this.code = e.code || (status === 400 ? 'bad_request' : 'error');
    // Error classification mirrors the observed client (spec §5.4).
    this.notFound = status === 404;
    this.unauthorized = status === 401;
    this.tooManyRequests = status === 429;
    this.retryAfter = e.retry_after_sec ?? null; // chat rate limit / slow mode countdown
    this.mutedUntil = e.muted_until ?? null; // chat mute
    this.details = e.details ?? null;
    this.methods = e.methods ?? null; // step_up_required: ['password'] | ['totp'] | both (CLONE_SPEC §22.6)
  }
}

export const csrf = {
  get: () => getLocalWithExpiry(CSRF_KEY),
  set: (t) => setLocalWithExpiry(CSRF_KEY, t, CSRF_TTL),
  clear: () => removeLocal(CSRF_KEY),
};

// Idempotency-Key (PLAN P1.9): one fresh key per user action on money-moving calls; retries of that action reuse it,
// so a repeated or replayed submit never places a second order / deposit / withdrawal / transfer.
export const newIdempotencyKey = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`);
const idem = () => ({ idempotencyKey: newIdempotencyKey() });

export async function request(method, url, body, { raw = false, timeoutMs = 15000, stepUpDone = false, idempotencyKey = null } = {}, retried = false) {
  const headers = { Accept: 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const t = csrf.get();
  if (t) headers['x-csrf-token'] = t;
  // Signed client token on every /v1 request, reads included (PLAN P1.10; HAR4 shows the WAF token on every API call).
  // The server enforces it on writes and /v1/users/* reads; the HttpOnly cookie copy covers a missing header.
  if (/^\/v1\//.test(url)) { const ct = await refreshClientToken(); if (ct) headers['X-Client-Token'] = ct; }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', signal: ctl.signal });
  } catch (e) {
    const err = new ApiError(0, { error: { code: 'network', message: e.name === 'AbortError' ? 'request timed out' : 'network error' } });
    err.timeout = e.name === 'AbortError';
    throw err;
  } finally { clearTimeout(timer); }
  // A rotated session (MFA on, password change, privilege change) comes with a new CSRF token (CLONE_SPEC §22.2).
  const rotated = res.headers.get('x-csrf-token'); if (rotated) csrf.set(rotated);
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !retried && isClientTokenError(res.status, data)) { await refreshClientToken(true); return request(method, url, body, { raw, timeoutMs, stepUpDone, idempotencyKey }, true); }
  // Sensitive action: confirm with password / two-factor code in a modal, then retry once (§22.6).
  if (!res.ok && data?.error?.code === 'step_up_required' && !stepUpDone) {
    const { stepUp } = await import('./views/stepup.js');
    await stepUp(new ApiError(res.status, data));
    return request(method, url, body, { raw, timeoutMs, stepUpDone: true, idempotencyKey }, retried);
  }
  if (res.status === 401 && data?.error?.code === 'token_authentication_failure') window.dispatchEvent(new Event('parlance:session-ended'));
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

const u = (uid, p = '') => `/v1/users/${encodeURIComponent(uid)}${p}`;
const qs = (o) => {
  const s = new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();
  return s ? `?${s}` : '';
};

export const api = {
  session: () => request('GET', '/v1/session'),
  signUp: (b) => request('POST', '/v1/users', b),
  logIn: (b) => request('POST', '/v1/log_in', b),
  // Identity, sessions and step-up (CLONE_SPEC §22)
  loginCsrf: () => request('GET', '/v1/auth/csrf'),
  completePasswordChange: (b) => request('POST', '/v1/auth/complete_password_change', b),
  setupStatus: (token) => request('GET', `/v1/auth/setup${qs({ token })}`),
  setupAdmin: (b) => request('POST', '/v1/auth/setup_admin', b),
  stepUp: (b) => request('POST', '/v1/step_up', b, { stepUpDone: true }),
  security: (uid) => request('GET', u(uid, '/security')),
  sessions: (uid) => request('GET', u(uid, '/sessions')),
  revokeSession: (uid, sid) => request('DELETE', u(uid, `/sessions/${encodeURIComponent(sid)}`)),
  revokeAllSessions: (uid) => request('DELETE', u(uid, '/sessions')),
  securityEvents: (uid) => request('GET', u(uid, '/security_events')),
  changePassword: (uid, b) => request('PUT', u(uid, '/password'), b),
  changeEmail: (uid, email) => request('PUT', u(uid, '/email'), { email }),
  setWithdrawalMfa: (uid, enabled) => request('PUT', u(uid, '/withdrawal_mfa'), { enabled }),
  logOut: () => request('POST', '/v1/log_out', {}),
  home: () => request('GET', '/v1/bff/home'),
  liveCount: () => request('GET', '/v1/live_data/count'),
  categories: () => request('GET', '/v1/categories'),
  search: (o) => request('GET', `/v1/search/series${qs(o)}`),
  event: (t) => request('GET', `/trade-api/v2/events/${encodeURIComponent(t)}`),
  series: (t) => request('GET', `/trade-api/v2/series/${encodeURIComponent(t)}`),
  orderbook: (t) => request('GET', `/trade-api/v2/markets/${encodeURIComponent(t)}/orderbook`),
  trades: (t) => request('GET', `/trade-api/v2/markets/trades${qs({ ticker: t, limit: 20 })}`),
  candles: (s, t, o) => request('GET', `/trade-api/v2/series/${encodeURIComponent(s)}/markets/${encodeURIComponent(t)}/candlesticks${qs(o)}`),
  balance: (uid) => request('GET', u(uid, '/balance')),
  properties: (uid) => request('GET', u(uid, '/properties')),
  setProperties: (uid, properties) => request('PUT', u(uid, '/properties'), { properties }),
  deposit: (uid, amount) => request('POST', u(uid, '/deposits'), { amount_dollars: amount }, idem()),
  withdraw: (uid, amount) => request('POST', u(uid, '/withdrawals'), { amount_dollars: amount }, idem()),
  submitOrder: (uid, b) => request('POST', u(uid, '/orders'), b, idem()),
  cancelOrder: (uid, oid) => request('DELETE', u(uid, `/orders/${encodeURIComponent(oid)}`)),
  orders: (uid, status) => request('GET', u(uid, `/orders${qs({ status })}`)),
  positions: (uid) => request('GET', u(uid, '/positions')),
  fills: (uid) => request('GET', u(uid, '/fills')),
  settlements: (uid) => request('GET', u(uid, '/settlement_history')),
  transactions: (uid) => request('GET', u(uid, '/transactions')),
  csvUrl: (uid) => u(uid, '/transactions.csv'),
  watchlist: (uid) => request('GET', u(uid, '/watchlist')),
  watch: (uid, ev) => request('PUT', u(uid, `/watchlist/${encodeURIComponent(ev)}`), {}),
  unwatch: (uid, ev) => request('DELETE', u(uid, `/watchlist/${encodeURIComponent(ev)}`)),
  visit: (uid, ev) => request('POST', u(uid, '/recently_visited'), { event_ticker: ev }),
  recent: (uid) => request('GET', u(uid, '/recently_visited')),
  related: (t) => request('GET', `/v1/events/${encodeURIComponent(t)}/related`),
  interest: (uid) => request('GET', u(uid, '/interest')),
  rollingCurrent: () => request('GET', '/v1/rolling/current'),
  rollingDetermined: () => request('GET', '/v1/rolling/determined'),
  logInMfa: (b) => request('POST', '/v1/log_in_mfa', b),
  calendar: (o) => request('GET', `/v1/calendar${qs(o || {})}`),
  socialTrades: (o) => request('GET', `/v1/social/trades${qs(o)}`),
  topHolders: (t) => request('GET', `/v1/social/top_holders${qs({ market_ticker: t })}`),
  posts: (o) => request('GET', `/v1/social/posts${qs(o || {})}`),
  createPost: (uid, b) => request('POST', u(uid, '/social/posts'), b),
  deletePost: (uid, pid) => request('DELETE', u(uid, `/social/posts/${encodeURIComponent(pid)}`)),
  like: (uid, pid) => request('POST', u(uid, `/social/posts/${encodeURIComponent(pid)}/like`), {}),
  unlike: (uid, pid) => request('DELETE', u(uid, `/social/posts/${encodeURIComponent(pid)}/unlike`)),
  bookmark: (uid, pid) => request('POST', u(uid, `/social/posts/${encodeURIComponent(pid)}/bookmark`), {}),
  unbookmark: (uid, pid) => request('DELETE', u(uid, `/social/posts/${encodeURIComponent(pid)}/bookmark`)),
  comments: (pid) => request('GET', `/v1/social/posts/${encodeURIComponent(pid)}/comments`),
  comment: (uid, pid, body) => request('POST', u(uid, `/social/posts/${encodeURIComponent(pid)}/comments`), { body }),
  deleteComment: (uid, pid, cid) => request('DELETE', u(uid, `/social/posts/${encodeURIComponent(pid)}/comments/${encodeURIComponent(cid)}`)),
  myProfile: (uid) => request('GET', u(uid, '/social/profile')),
  saveProfile: (uid, b) => request('POST', u(uid, '/social/profile'), b),
  profile: (nickname) => request('GET', `/v1/social/profile${qs({ nickname })}`),
  holdings: (nickname) => request('GET', `/v1/social/profile/holdings${qs({ nickname })}`),
  follow: (uid, nickname) => request('POST', u(uid, '/social/follow'), { nickname }),
  unfollow: (uid, nickname) => request('DELETE', u(uid, `/social/follow${qs({ nickname })}`)),
  leaderboard: (metric) => request('GET', `/v1/social/leaderboard${qs({ metric })}`),
  notifications: (uid) => request('GET', u(uid, '/notifications')),
  readNotification: (uid, id) => request('PUT', u(uid, `/notifications/${encodeURIComponent(id)}/read`), {}),
  readAll: (uid) => request('PUT', u(uid, '/notifications/read'), {}),
  priceTargets: (uid, ticker) => request('GET', u(uid, `/notifications/custom_price_targets${qs({ market_ticker: ticker })}`)),
  addPriceTarget: (uid, b) => request('POST', u(uid, '/notifications/custom_price_targets'), b),
  deletePriceTarget: (uid, id) => request('DELETE', u(uid, `/notifications/custom_price_targets${qs({ id })}`)),
  limit: (uid, kind) => request('GET', u(uid, { deposit: '/deposit_limits', trading: '/trading_limits', session: '/daily_session_time_limit' }[kind])),
  setLimit: (uid, kind, b) => request('PUT', u(uid, { deposit: '/deposit_limit', trading: '/trading_limits', session: '/daily_session_time_limit' }[kind]), b),
  mfa: (uid) => request('GET', u(uid, '/mfa')),
  mfaSetup: (uid) => request('POST', u(uid, '/mfa/setup'), {}),
  mfaEnable: (uid, code) => request('POST', u(uid, '/mfa/enable'), { code }),
  mfaDisable: (uid, code) => request('POST', u(uid, '/mfa/disable'), { code }),
  // Combos + RFQ (spec §17)
  comboCollection: () => request('GET', '/v1/multivariate_event_collections/PLXCOMBO'),
  createCombo: (legs) => request('POST', '/v1/multivariate_event_collections/PLXCOMBO/markets', { selected_markets: legs }),
  combo: (t) => request('GET', `/v1/combos/${encodeURIComponent(t)}`),
  myCombos: (uid) => request('GET', u(uid, '/combos')),
  comboSlip: (uid) => request('GET', u(uid, '/combo_slip')),
  saveComboSlip: (uid, b) => request('PUT', u(uid, '/combo_slip'), b),
  clearComboSlip: (uid) => request('DELETE', u(uid, '/combo_slip')),
  createRfq: (b) => request('POST', '/v1/communications/rfqs', b),
  rfqs: (scope) => request('GET', `/v1/communications/rfqs${qs({ scope })}`),
  rfq: (id) => request('GET', `/v1/communications/rfqs/${encodeURIComponent(id)}`),
  cancelRfq: (id) => request('DELETE', `/v1/communications/rfqs/${encodeURIComponent(id)}`),
  createQuote: (b) => request('POST', '/v1/communications/quotes', b),
  quotes: () => request('GET', '/v1/communications/quotes'),
  deleteQuote: (id) => request('DELETE', `/v1/communications/quotes/${encodeURIComponent(id)}`),
  acceptQuote: (rfqId, qid, side) => request('PUT', `/v1/communications/rfqs/${encodeURIComponent(rfqId)}/quotes/${encodeURIComponent(qid)}/accept`, { accepted_side: side }, idem()),
  amendOrder: (uid, oid, b) => request('POST', u(uid, `/orders/${encodeURIComponent(oid)}/amend`), b),
  decreaseOrder: (uid, oid, b) => request('POST', u(uid, `/orders/${encodeURIComponent(oid)}/decrease`), b),
  cancelAllOrders: (uid, o) => request('DELETE', u(uid, `/orders${qs(o || {})}`)),
  portfolioPositions: (uid, o) => request('GET', u(uid, `/portfolio/positions${qs(o || {})}`)),
  sellQuote: (uid, ticker, count) => request('GET', u(uid, `/positions/${encodeURIComponent(ticker)}/sell_quote${qs({ count })}`)),
  history: (uid, o) => request('GET', u(uid, `/history${qs(o || {})}`)),
  historyCsvUrl: (uid, query) => u(uid, `/history.csv${query ? `?${query}` : ''}`),
  confirmQuote: (qid) => request('PUT', `/v1/communications/quotes/${encodeURIComponent(qid)}/confirm`, {}, idem()),
  admin: (ticker, action, body) => request('POST', `/v1/admin/markets/${encodeURIComponent(ticker)}/${action}`, body || {}),
  // Event live chat (CLONE_SPEC.md §20)
  chat: (t, o) => request('GET', `/v1/events/${encodeURIComponent(t)}/chat${qs(o || {})}`),
  chatPost: (uid, t, b) => request('POST', u(uid, `/chat/${encodeURIComponent(t)}/messages`), b),
  chatDelete: (uid, t, id) => request('DELETE', u(uid, `/chat/${encodeURIComponent(t)}/messages/${encodeURIComponent(id)}`)),
  chatReport: (uid, t, id, reason) => request('POST', u(uid, `/chat/${encodeURIComponent(t)}/messages/${encodeURIComponent(id)}/report`), { reason }),
  chatMod: (t, action, b) => request('POST', `/v1/admin/chat/rooms/${encodeURIComponent(t)}/${encodeURIComponent(action)}`, b || {}),
};
