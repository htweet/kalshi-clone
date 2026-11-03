// Phase 3 transport (CLONE_SPEC.md §25): identity onboarding, phone codes, document verification, email verification,
// password reset, OAuth, passkeys, compliance, privacy, and the account area (preferences, consent, connected apps,
// activity, documents, rewards, promo codes). Same request() as api.js: cookie session, CSRF, client token, step-up.
import { request } from './api.js';

const u = (uid, p = '') => `/v1/users/${encodeURIComponent(uid)}${p}`;
const qs = (o) => { const s = new URLSearchParams(Object.entries(o || {}).filter(([, v]) => v != null && v !== '')).toString(); return s ? `?${s}` : ''; };

export const idApi = {
  config: () => request('GET', '/v1/identity/config'),
  countries: () => request('GET', '/v1/identity/countries').then((r) => r.countries),
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
  // document verification (§13.15)
  docv: (uid) => request('GET', u(uid, '/docv')),
  docvStart: (uid) => request('POST', u(uid, '/docv/sessions'), {}),
  docvUpload: (uid, kind, image) => request('POST', u(uid, '/docv/documents'), { kind, image }, { timeoutMs: 60000 }),
  docvSubmit: (uid) => request('POST', u(uid, '/docv/submit'), {}),
  docvExit: (uid) => request('POST', u(uid, '/docv/exit'), {}),
  handoffClaim: (token) => request('POST', '/v1/docv/handoff/claim', { token }),
  handoffState: () => request('GET', '/v1/docv/handoff'),
  // email + password reset
  sendVerification: (uid) => request('POST', u(uid, '/email_verification'), {}),
  verifyEmail: (token) => request('POST', '/v1/verify_email', { token }),
  requestReset: (email) => request('POST', '/v1/passwords/reset', { email }),
  resetValid: (token) => request('GET', `/v1/passwords/reset/${encodeURIComponent(token)}`),
  confirmReset: (token, password) => request('PUT', `/v1/passwords/reset/${encodeURIComponent(token)}/confirm`, { password }),
  // OAuth (P3.3)
  oauthStart: (provider) => request('POST', `/v1/oauth/${encodeURIComponent(provider)}/start`, {}),
  oauthCallback: (provider, b) => request('POST', `/v1/oauth/${encodeURIComponent(provider)}/callback`, b),
  oauthLink: (b) => request('POST', '/v1/oauth/link', b),
  oauthLinkStart: (uid, provider) => request('POST', u(uid, `/oauth/${encodeURIComponent(provider)}/link`), {}),
  oauthLinks: (uid) => request('GET', u(uid, '/oauth')),
  oauthUnlink: (uid, provider) => request('DELETE', u(uid, `/oauth/${encodeURIComponent(provider)}`)),
  // passkeys (P3.4) and the A2-locked endpoints
  passkeys: (uid) => request('GET', u(uid, '/passkeys')),
  signInMethods: (uid) => request('GET', u(uid, '/sign_in_methods')),
  apiKeys: (uid) => request('GET', u(uid, '/api_keys')),
  passkeyRegOptions: (uid) => request('POST', u(uid, '/passkeys/registration/options'), {}),
  passkeyRegister: (uid, credential, name) => request('POST', u(uid, '/passkeys/registration'), { credential, name }),
  passkeyRemove: (uid, id) => request('DELETE', u(uid, `/passkeys/${encodeURIComponent(id)}`)),
  passkeyLoginOptions: () => request('POST', '/v1/passkeys/authentication/options', {}),
  passkeyLogin: (credential) => request('POST', '/v1/passkeys/authentication', { credential }),
  passkeyStepUpOptions: () => request('POST', '/v1/passkeys/step_up/options', {}, { stepUpDone: true }),
  passkeyStepUp: (credential) => request('POST', '/v1/passkeys/step_up', { credential }, { stepUpDone: true }),
  // compliance (P3.6, P3.7)
  geolocation: (uid) => request('GET', u(uid, '/geolocation')),
  reportLocation: (uid, b) => request('POST', u(uid, '/geolocation'), b),
  holds: (uid) => request('GET', u(uid, '/withdrawal_holds')),
  // privacy (P3.8)
  dataExport: (uid) => request('POST', u(uid, '/data_export'), {}),
  closeAccount: (uid, b) => request('POST', u(uid, '/close_account'), b),
  // account area (A3–A6, A12)
  preferences: (uid) => request('GET', u(uid, '/preferences')),
  setPreferences: (uid, preferences) => request('PUT', u(uid, '/preferences'), { preferences }),
  consent: (uid) => request('GET', u(uid, '/marketing_consent')),
  setConsent: (uid, b) => request('POST', u(uid, '/marketing_consent'), b),
  connectedApps: (uid) => request('GET', u(uid, '/connected_apps')),
  revokeApp: (uid, id) => request('DELETE', u(uid, `/connected_apps/${encodeURIComponent(id)}`)),
  activity: (uid, o) => request('GET', u(uid, `/activity${qs(o)}`)),
  activityCsvUrl: (uid, type) => u(uid, `/activity.csv${qs({ type })}`),
  taxDocuments: (uid) => request('GET', u(uid, '/tax_documents')),
  checklist: () => request('GET', '/v1/rewards/new_user_checklist'),
  redeemPromo: (uid, code) => request('POST', u(uid, '/promo_codes'), { code }),
  promoRedemptions: (uid) => request('GET', u(uid, '/promo_codes')),
  // dev outboxes (non-production, loopback only)
  devMailbox: () => request('GET', '/v1/dev/mailbox'),
  devSms: () => request('GET', '/v1/dev/sms'),
};
