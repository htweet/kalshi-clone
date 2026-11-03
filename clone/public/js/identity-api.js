// Identity, onboarding and compliance endpoints (Phase 3, CLONE_SPEC §25). Same transport as api.js (cookie session,
// CSRF + client token headers, step-up retry); kept separate so api.js stays the market/trading surface.
import { request } from './api.js';

const u = (uid, p = '') => `/v1/users/${encodeURIComponent(uid)}${p}`;
const qs = (o) => { const s = new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString(); return s ? `?${s}` : ''; };
let configP = null;
let countriesP = null;

export const idApi = {
  config: (fresh = false) => { if (fresh || !configP) configP = request('GET', '/v1/identity/config').catch((e) => { configP = null; throw e; }); return configP; },
  countries: () => { if (!countriesP) countriesP = request('GET', '/v1/identity/countries').then((r) => r.countries).catch((e) => { countriesP = null; throw e; }); return countriesP; },
  state: (uid, details = false) => request('GET', u(uid, `/sign_up${details ? '?include=details' : ''}`)),
  resume: () => request('POST', '/v1/resume_sign_up', {}),
  skip: (uid) => request('POST', u(uid, '/sign_up/skip'), {}),
  sendCode: (uid, b) => request('POST', u(uid, '/verify_phone/send'), b),
  verifyCode: (uid, code) => request('POST', u(uid, '/verify_phone'), { code }),
  saveName: (uid, b) => request('PUT', u(uid, '/sign_up/name'), b),
  saveBirthday: (uid, b) => request('PUT', u(uid, '/sign_up/birthday'), b),
  saveAddress: (uid, b) => request('PUT', u(uid, '/sign_up/address'), b),
  submit: (uid) => request('POST', u(uid, '/sign_up/submit'), {}),
  suggest: (country, q) => request('GET', `/v1/address/suggest${qs({ country, q })}`),
  identity: (uid) => request('GET', u(uid, '/identity')),
  resendVerification: (uid) => request('POST', u(uid, '/email_verification'), {}),
  verifyEmail: (token) => request('POST', '/v1/verify_email', { token }),
  requestReset: (email) => request('POST', '/v1/passwords/reset', { email }),
  resetValid: (token) => request('GET', `/v1/passwords/reset/${encodeURIComponent(token)}`),
  confirmReset: (token, password) => request('PUT', `/v1/passwords/reset/${encodeURIComponent(token)}/confirm`, { password }),
  exportData: (uid) => request('POST', u(uid, '/data_export'), {}),
  closeAccount: (uid, b) => request('POST', u(uid, '/close_account'), b),
  geolocation: (uid) => request('GET', u(uid, '/geolocation')),
  reportLocation: (uid, b) => request('POST', u(uid, '/geolocation'), b),
  holds: (uid) => request('GET', u(uid, '/withdrawal_holds')),
  // OAuth (P3.3)
  oauthStart: (provider) => request('POST', `/v1/oauth/${encodeURIComponent(provider)}/start`, {}),
  oauthCallback: (provider, b) => request('POST', `/v1/oauth/${encodeURIComponent(provider)}/callback?four_digit_code=true`, b),
  oauthLink: (b) => request('POST', '/v1/oauth/link', b),
  oauthLinks: (uid) => request('GET', u(uid, '/oauth')),
  oauthLinkStart: (uid, provider) => request('POST', u(uid, `/oauth/${encodeURIComponent(provider)}/link`), {}),
  oauthUnlink: (uid, provider) => request('DELETE', u(uid, `/oauth/${encodeURIComponent(provider)}`)),
  // Passkeys (P3.4)
  passkeys: (uid) => request('GET', u(uid, '/passkeys')),
  passkeyRegOptions: (uid) => request('POST', u(uid, '/passkeys/registration/options'), {}),
  passkeyRegister: (uid, b) => request('POST', u(uid, '/passkeys/registration'), b),
  passkeyRemove: (uid, id) => request('DELETE', u(uid, `/passkeys/${encodeURIComponent(id)}`)),
  passkeyLoginOptions: () => request('POST', '/v1/passkeys/authentication/options', {}),
  passkeyLogin: (credential) => request('POST', '/v1/passkeys/authentication', { credential }),
  passkeyStepUpOptions: () => request('POST', '/v1/passkeys/step_up/options', {}, { stepUpDone: true }),
  passkeyStepUp: (credential) => request('POST', '/v1/passkeys/step_up', { credential }, { stepUpDone: true }),
  // Dev mailbox (not in production)
  devMailbox: (to) => request('GET', `/v1/dev/mailbox${qs({ to })}`),
  devSms: () => request('GET', '/v1/dev/sms'),
};
