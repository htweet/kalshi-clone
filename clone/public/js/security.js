// Signed client token (PLAN P1.10, mirrors S2: the live site's WAF SDK fetches a token after page load and sends it as
// `x-aws-waf-token` on API calls and as a query parameter on the WebSocket). The server embeds a short-lived, signed
// boot proof in the HTML it serves (only after any bot challenge has been passed); this module exchanges it at
// /v1/client_token for an HMAC-signed token bound to this client, sends it as `X-Client-Token` on every /v1 call and as
// `ct` on the WebSocket URL, and refreshes it at half its lifetime. The same token is also set as an HttpOnly cookie.
import { t } from './i18n.js'; // text catalog (CLONE_SPEC.md §32.3)
import './content/security-strings.js';

const ENDPOINT = '/v1/client_token';
let token = null;
let expiresAt = 0;
let inflight = null;
let timer = null;

const bootProof = () => document.querySelector('meta[name="plx-boot"]')?.getAttribute('content') || '';

async function fetchToken() {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (token) headers['X-Client-Token'] = token; // refresh with the current (or recently expired) token
  const res = await fetch(ENDPOINT, { method: 'POST', headers, credentials: 'same-origin', body: JSON.stringify({ boot: bootProof() }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) throw new Error((data.error && data.error.message) || t('security.fetch_token.client_token_request_failed', { status: res.status }));
  token = data.token;
  expiresAt = Date.now() + data.expires_in * 1000;
  clearTimeout(timer);
  timer = setTimeout(() => { refreshClientToken().catch(() => { /* retried on next use */ }); }, Math.max(5000, (data.expires_in * 1000) / 2));
  return token;
}

// Resolves with a valid token (fetching or refreshing when missing / past half-life). Never rejects: callers fall
// back to the cookie copy, and the server answers 403 client_token_* if neither is valid.
export function refreshClientToken(force = false) {
  if (!force && token && Date.now() < expiresAt - 5000) return Promise.resolve(token);
  if (!inflight) inflight = fetchToken().catch(() => null).finally(() => { inflight = null; });
  return inflight;
}

export const clientToken = {
  get: () => (token && Date.now() < expiresAt ? token : null),
  ready: refreshClientToken(),
  refresh: refreshClientToken,
};

export const isClientTokenError = (status, body) => status === 403 && /^client_token_/.test(body?.error?.code || '');
