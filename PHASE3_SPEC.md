## 25. Accounts, identity, compliance and account area

Phase 3 of `PLAN.md` (P3.1–P3.8, P3.1a personal-data protection, §11 A1–A6 and A12, residual items RS2, RS3, RS6, RS9,
RS10). Evidence: `CLONE_SPEC.md` §4.7, §13.9, §13.14 (onboarding), §13.15 (document verification), §13.16 (account area),
§13.19 (locked endpoints, rewards). Everything not shown in that evidence is a **design choice**, marked as such. All
data in code, fixtures and tests is invented ("Sample"/"Test" names, 555-01xx phone numbers, never-issued 9xx SSNs,
"Maple Test Avenue"); no real person, organisation or vendor is named or imitated (the verification vendor is our own
"Parlance Verify (sandbox)").

### 25.1 Modules

| File | Role |
|---|---|
| `server/identity.js` | Mounts everything below; personal-data vault (P3.1a); onboarding steps and resume; phone codes (P3.2); email verification and password reset; compliance gate; A2 lock; data export and closure (P3.8); admin identity lookup with audited unmask; compliance settings; retention job |
| `server/countries.js` | Dial codes and national-number rules (E.164), regions, postal formats, per-country national ID (label, format, checksum, masking), simulated IP table and coarse geo boxes |
| `server/messaging.js` | Email (dev outbox or SMTP: EHLO, STARTTLS, AUTH PLAIN) and SMS (dev outbox or JSON webhook) providers; `/v1/dev/mailbox`, `/v1/dev/sms` (RS6) |
| `server/kyc.js` | KYC provider interface, deterministic sandbox, async two-stage job worker, admin review queue and decisions (P3.5) |
| `server/docv.js`, `server/images.js` | Document verification: QR handoff, phone capture session, uploads, image sanitising, encryption, retention, audited staff view (A1) |
| `server/compliance.js` | Simulated geolocation (P3.6) and fraud signals / risk score / withdrawal holds (P3.7) |
| `server/oauth.js` | OIDC relying party (PKCE S256 + state + nonce) and a built-in mock provider for dev/test (P3.3) |
| `server/webauthn.js` | Passkeys without a library: CBOR, authenticator data, COSE keys, signatures, counters (P3.4) |
| `server/account-area.js`, `server/pdf.js` | Settings preferences, marketing consent, connected apps, Your activity, Documents (P&L, CSV, PDF), checklist, promo codes (A3–A6, A12) |
| `public/js/views/onboarding.js`, `docv-phone.js`, `identity-pages.js` | Full-screen onboarding + document verification, phone page, verify-email / forgot / reset / OAuth callback / dev mailbox |
| `public/js/views/account.js`, `account-*.js`, `account-menu.js`, `rewards.js`, `placeholder.js` | Account frame, ☰ menu, category index, settings, activity, documents, identity & privacy, rewards, placeholder pages |
| `public/js/qr.js`, `pow.js`, `prefs.js`, `identity-api.js`, `webauthn-client.js`, `public/account.css` | Local QR encoder, sign-in proof of work, app-wide display prefs, Phase 3 transport, WebAuthn glue, styles |
| `public/js/views/admin/compliance.js` | Admin › Identity reviews, Fraud & holds, Compliance, Promo codes |

### 25.2 Onboarding (P3.1; CLONE_SPEC §13.14 observed)

- **Frame** (observed): full-screen page with only the wordmark and a three-segment progress bar; header, footer and
  banners are hidden (`body.ob-mode`).
- **Steps** (observed order): phone number → "Enter your 4 digit code" (four boxes, first focused, Continue disabled until
  four digits, "Resend code" pill with a visible `m:ss` countdown, "Learn more") → "What's your name?" (legal first/last,
  floating labels, "Not now") → "When's your birthday?" (MM · DD · Year with auto-advance; "You must be 18 or over…",
  "Federal law requires…") → "What's your address?" (country select, address with simulated autocomplete of invented
  addresses, apt, city, region select/field, postal code, **country-specific national ID** — e.g. SSN · 9 digits, NIN ·
  11 digits — `autocomplete="off"`, the "same address as on your state ID… not a business or PO box" rule) →
  "Verifying info…" (spinner around the wordmark) → document verification (§25.4) → "Verifying info…" → outcome.
- **Persistence and resume**: every step is saved server-side when Continue is pressed (`PUT /users/:uid/sign_up/{name,
  birthday,address}`), `GET /users/:uid/sign_up` returns `next_step`, `POST /resume_sign_up` resumes (spec §4.7 call
  sites). "Not now" (`POST …/sign_up/skip`) and "Exit identity verification" leave the flow; a banner on every page
  invites the user back. Reloading mid-flow returns to the same step with the saved fields prefilled (never the national
  ID, which is never sent back).
- **Statuses**: `not_started → in_progress → pending (data) → documents_required → pending (documents) → approved |
  review | rejected | retry`, plus `closed`. Outcome screens (design choice; not captured): approved ("You're verified",
  Start trading), manual review ("We're reviewing your info"), rejected (reason category text + support), retry ("Let's
  try that again", prefilled details, attempts left; after 3 attempts a retry becomes manual review).
- **Server-side rules**: name letters/spaces/hyphens/apostrophes; date valid and **age ≥ 18 computed on the server**
  (`400 age_requirement`; the date is not logged); postal format per country; PO boxes refused; national ID format and
  checksum per country (SIN Luhn, CPF check digits, TFN weights, SSN area/group/serial rules; 9xx SSNs accepted only in
  the sandbox). Error messages never echo the submitted value.
- **After sign-in / sign-up** (design choice): when verification gates trading, unverified non-staff users land in
  onboarding; staff go where they were going.

### 25.3 Personal-data protection (P3.1a)

- **Field-level encryption**: legal name, date of birth, address, phone, national ID and ID photos are AES-256-GCM
  encrypted with a **per-user data key**; the data key is itself encrypted with an HKDF sub-key (`identity-kek:v1`) of
  the deployment master key (`server/crypto.js`). Each ciphertext's AAD binds it to its field and user, so a value copied
  into another row does not decrypt. Tests dump every text value of every table and find none of the plaintext values.
- **National ID**: stored encrypted plus an HMAC (`national-id-hash:v1`, country-prefixed) for duplicate detection; the
  last 2–4 digits only are kept for display. It is **never returned in full** by any endpoint — not to staff, not in the
  data export, not even to the owner (`•••-••-7712`).
- **Phone**: E.164 encrypted; HMAC for duplicate signals; last 4 digits for display. Codes are HMACs (`phone-code:v1`).
- **Never logged**: security events carry masked or categorical data only (`{step: 'address', country}`, masked phone);
  audit rows of staff access record *who, whose, which field and why*, never the value; console errors never include
  applicant data; telemetry does not exist yet (P9.4).
- **Staff views are masked** (`R*** R***`, `••/••/••••`, `•••• NY, US · 10•••`). Revealing a field (support/admin roles)
  needs a reason of ≥5 characters, writes a hash-chained `identity.unmask` audit row and an `identity_viewed_by_staff`
  event in the customer's own security activity. National IDs cannot be revealed (`403 not_unmaskable`).
- **Retention**: verification codes, emails and SMS 30 days; browser-location checks 30 days; device records 180 days; ID
  photos are erased at the decision (or after `documents_days`, 30, if abandoned); after closure the remaining
  verification record (status, ID hash) is kept `kyc_days` (5 years) for anti-fraud/AML record keeping, then deleted. All
  values are admin-configurable (Admin › Compliance) and shown to the user (Identity & privacy).

### 25.4 Document verification (A1; CLONE_SPEC §13.15)

- **Screens** (observed): intro "Let's get you verified" / "It will only take 2 minutes" / "What you will need:" with line
  icons for *Government Issued ID* and *Smartphone* / "Get started" / ✕ close / "powered by **Parlance Verify (sandbox)**";
  "Continue on your phone" with "Scan the QR code below with your phone's camera" and the QR; desktop waiting screen
  "Stay on this page" / "Check back here to complete verification" / animated ID-and-face scan / "Uploading your
  documents…" / "Exit identity verification" pill. The desktop polls every 1.5 s, switches to the waiting screen when the
  phone connects and ticks off each photo live; when the phone submits it shows "Verifying info…" then the outcome.
- **QR**: `public/js/qr.js` is our own encoder (byte mode, EC level M, versions 1–10, all eight masks with penalty
  scoring); verified module-for-module against a reference implementation for 48 cases (versions 1–10, every mask). The
  QR encodes `https://<origin>/verify/m#t=<token>`: a 256-bit token in the **fragment** (never sent to the server in a URL,
  so it cannot leak into logs or `Referer`), stored only as SHA-256, **single use**, **10-minute** expiry, **bound to the
  desktop session** that created it (signing out or starting a new handoff kills it).
- **Phone**: the page reads and removes the fragment, claims the token once (`POST /docv/handoff/claim`; a second claim
  answers `410 handoff_used`), and receives a 15-minute capture session: an HttpOnly, SameSite=Strict cookie scoped to
  `/v1/docv` plus a CSRF value sent as `X-Docv-Csrf`. It ends when the desktop session ends (`401 handoff_expired`). Each
  photo comes from `<input type="file" accept="image/*" capture="environment|user">` (front, back, selfie).
- **Uploads**: the browser re-encodes every photo through a canvas to JPEG ≤1600 px (drops EXIF/GPS); the server
  (`server/images.js`) sniffs the type from the bytes (JPEG/PNG only), rewrites the container keeping only image segments
  (all APPn/COM, PNG text/time/eXIf chunks dropped), discards anything after the end marker, checks 200–8000 px and a
  6 MB cap, then encrypts with the user's data key into SQLite (`docv_documents.data`). There is **no URL that serves an
  image**; staff use `POST /admin/kyc/:user/documents/:doc/view` (support/admin, reason ≥5 chars, `kyc.document_view`
  audit row) which returns a `data:` URL. Max 15 uploads per handoff. Tests confirm no JPEG/PNG markers at rest and no
  EXIF/GPS/trailing payload after decryption.
- **Same-device fallback**: "Continue on this device instead" offers the same three inputs on the desktop (session
  authenticated), same checks. "Exit identity verification" keeps uploaded photos and closes the handoff link.

### 25.5 Identity verification (P3.5)

Provider interface `{ name, verifyData(applicant), verifyDocuments(applicant, docsMeta) }` → `{decision, reason_category,
reference}`; may throw (retried 3× with backoff, then `retry/provider_unavailable`). Jobs live in `kyc_jobs` and are run
by an in-process worker; a restart resumes queued and interrupted jobs (tested). Our own rules run first: duplicate
national ID on another open account → rejected `duplicate_account`; match with a closed account → manual review; under
18 → rejected; blocked residence → rejected `unsupported_region`. **Sandbox** (deterministic by invented last name):
`Retry` → data-stage retry, `Outage` → provider outage, `Review` → manual review after documents, `Reject` → rejected after
documents, anything else → approved. Without a provider in production both stages go to manual review. **Admin ›
Identity reviews**: queue by status with masked data, duplicate-ID flag, risk score and document count; detail dialog with
reveal (audited), document view (audited), history and the decision form (approve / reject / ask to retry with a reason
category; support role, step-up, audited; staff cannot decide their own case). Photos are kept during manual review and
erased at the decision.

### 25.6 Gating, location and fraud (P3.1, P3.6, P3.7)

- **Gate** (one middleware, after authentication, step-up, validation and idempotency) on deposits, withdrawals, orders,
  amend, perps orders and transfers, RFQs, quotes, accept/confirm: location first (`403 geo_restricted` with country and
  source), then identity (`403 identity_verification_required` with `identity_status`, `action`, `next`), then fraud.
  Closed accounts: `403 account_closed`. The SPA shows one explanation dialog for these codes.
- **Enforcement switch** (design choice for compatibility): `npm start` / `npm run dev` enforce verification
  (`KYC_REQUIRED=0` turns it off); programmatic `start()` leaves it off unless `identity: { kycRequired: true }`,
  `KYC_REQUIRED=1` or `NODE_ENV=production`; Admin › Compliance can force it on or off at runtime (audited). This keeps the
  140 pre-Phase-3 tests valid while the Phase 3 suites run with it on.
- **Location** (simulated provider): the client IP's country from a documentation-range IP table plus admin overrides
  (`{cidr, country}`), and, when the user consents (Identity & privacy › Share browser location;
  `Permissions-Policy: geolocation=(self)`), the country of the browser's coordinates — only the derived country is kept,
  for 30 minutes. Default blocked list `CU, IR, KP, SY` (admin-editable); loopback/unknown addresses allowed by default
  (`unknown_ip: block` available). Re-checked on every gated request. A region banner ("Trading, deposits and withdrawals
  aren't available in your region (Cuba)") shows on every page while blocked.
- **Fraud signals**: a random per-browser device ID (`X-Device-Id`, stored only as an HMAC) and a UA hash — no
  fingerprinting beyond that — plus velocity rules (new account, new/shared device, 3+ devices a day, deposit/withdrawal
  velocity, withdrawing most of a fresh deposit without trading, failed sign-ins, IP country ≠ residence, phone shared)
  give a score per money movement (`risk_assessments`). A withdrawal at/above the threshold (default 60) is **held**:
  `202 {status:'held'}`, funds move into the hold (`withdrawal_hold` ledger entry). Admin › Fraud & holds (users.read;
  decisions users.money, reason, step-up, audited) releases or reverses it (`withdrawal_hold_reversal`).

### 25.7 Phone codes, email and messaging (P3.2, P3.1, RS6)

- 4-digit codes, `crypto.randomInt`, HMAC-stored, 10-minute expiry, 5 attempts (attempts left shown), a new code
  supersedes the old one, resend cooldown 30 s (configurable) with a visible countdown. Send limits (SMS-pumping
  protection, admin-editable): per number 5/h, per IP (hashed) 10/h, per account 10/day, per destination country 200/h
  with per-country overrides and a country block list; premium-rate prefixes refused. Changing a verified number needs
  step-up (SIM-swap defence) and alerts the user.
- Email verification (signed, single-use, 24 h; fingerprinted to the address, so a changed email kills old links) is sent
  at sign-up and after an email change. Password reset: uniform `202` answer for known/unknown/rate-limited emails (3 per
  address per hour, 20 per IP), 30-minute single-use signed link fingerprinted to the current password hash (any other
  outstanding link dies), policy enforced, all sessions revoked, user alerted. Tokens are stored as SHA-256.
- Transports: dev outbox (default outside production; `/dev/mailbox` page and `/v1/dev/{mailbox,sms}`, **loopback clients
  only, never registered in production**), SMTP (`SMTP_URL`, `MAIL_FROM`; STARTTLS required before AUTH; only masked
  metadata kept), SMS webhook (`SMS_WEBHOOK_URL`, `SMS_WEBHOOK_TOKEN`). In production without a provider, SMS fails with
  `503 sms_unavailable` (no silent drop).

### 25.8 OAuth and passkeys (P3.3, P3.4, A2)

- **OAuth/OIDC**: authorization-code flow with PKCE S256, `state` (single use, 10 min, bound to the browser's
  login-CSRF cookie, or to the session when linking) and `nonce`; exact redirect URI; ID-token signature (RS256/ES256 via
  JWKS), issuer, audience, expiry checks. Existing link → sign-in (two-factor still applies); provider-verified matching
  email → the account password is required before linking; unverified match → refused; otherwise a new account without
  a password. Linking from Account needs step-up; unlinking the last sign-in method is refused. Real Google/Apple only
  with `identity.oauth.<p>.{clientId, clientSecret}`; otherwise, outside production, the built-in mock provider at
  `/mock-oidc/<p>/…` (its own page with a nonce'd style, invented test identities). `GET /v1/auth/csrf` now keeps an
  unexpired login-CSRF cookie (≥10 minutes left) so the state binding survives the redirect's page load.
- **Passkeys**: attestation `none`, ES256/EdDSA/RS256, discoverable credentials with user verification; checks
  `clientData.type`, origin, `crossOrigin`, single-use 5-minute challenge bound to the login-CSRF cookie (sign-in) or the
  session (registration, step-up), rpIdHash, UP+UV flags, credential id, signature, and the **signature counter** (a
  non-increasing counter is refused as a possible clone). A user-verified passkey satisfies two-factor and step-up.
  Admin option: staff must sign in or confirm with a passkey before any admin route answers.
- **A2** (observed §13.19): `GET /users/:uid/passkeys`, `/sign_in_methods` and `/api_keys` — and passkey registration,
  provider linking and API-key creation — answer exactly `403 {"error":{"code":"permission_denied","message":"You do not
  have permission to perform this action","details":"Please make sure you are logged in with the correct account.
  Contact support if you believe this is an error.","support_action":"support_chat"}}` until identity verification is
  approved; changes additionally need a fresh step-up. Design choice: staff accounts are exempt (they can be required to
  use passkeys for the admin panel). API keys themselves are Phase 7; the endpoint returns an empty list once unlocked.

### 25.9 Account area (A3–A6, A12; CLONE_SPEC §13.16, §13.19)

- **Header**: trophy icon (leaderboard) and ☰ menu: Leaderboard and Rewards round buttons; Account & security · Your
  activity · Invest · Liquidity Rewards · Documents · API Docs · Settings; collapsible Trust ▾ / Research ▾ / Support ▾;
  Enter promo code; Log out (plus Portfolio, Admin for staff, and the light/dark quick switch the earlier tests use).
  Destinations of later phases (Liquidity Rewards — Phase 5, API Docs — Phase 7, Trust/Research/Support — Phase 8) open
  placeholder pages that say so. A list icon at the start of the category strip opens the category index (categories
  and subcategories).
- **Frame** `/account/*`: content left, right-hand card nav with icons — Account & security (`/account`, sub-tabs
  Security · Identity & privacy · Social profile · Account limits · Price alerts — the earlier sections moved here) ·
  Your activity (`/account/activity`) · Documents (`/account/taxes`) · Settings (`/account/settings`).
  `/account/appearance` redirects to Settings. At 900 px and below the nav becomes a horizontal strip above the content.
- **Your activity**: condensed title with a ⤓ icon, chips **All · Deposit · Withdrawal · Order · Trade · Settlement ·
  Credit** over `server/history.js` (new `activity` filter; ledger kinds `credit`, `withdrawal_hold`, `…_reversal`,
  `closure_payout` added), CSV of the chosen chip, empty state "No activity with these filters", chip remembered per
  account.
- **Documents**: explanatory paragraph (realized P&L per year incl. fees and credits/rebates, updated monthly, **not tax
  advice**); table **Year · PnL with fees · PnL without fees · Transactions ⤓**; yearly statements as chips per year
  (simulated 1099-INT when interest > 0, 1099-MISC when credits > 0, and a P&L summary), each as CSV and **PDF** (our own
  PDF 1.4 writer, standard Helvetica, exact xref offsets), all stamped "SIMULATED STATEMENT – NOT A TAX FORM – NOT TAX
  ADVICE". Realized P&L replays fills per market (average cost; YES+NO pairs redeem for $1 as the engine nets them) plus
  settlements; tests check it equals the engine's realized P&L and the cash effect of a closed round trip.
- **Settings**, in the observed order: (1) "Browse and manage markets by" Payout and odds / Shares and prices with a live
  preview card (the real card component on an invented market), applied to every market card (Yes/No share-price buttons
  instead of multiplier + % pill); (2) Connected apps (`oauth_grants`; list/remove; empty until Phase 7 issues grants);
  (3) Notifications — **Phase 2's module** (`views/notification-settings.js`, `mountNotificationSettings`); (4) Marketing
  text messages — status line, our own SMS disclosure (versioned, hashed), consent checkbox, "Opt in to marketing texts" /
  "No thanks" / "Opt out"; requires a verified phone; every opt-in/opt-out is an append-only `marketing_consents` row
  (time, text version, text SHA-256, phone last 4, IP prefix, device); a new text version requires re-consent; (5) Security
  notifications — Phase 2's `mountSecurityNotificationSetting` (single source of truth in its preferences); (6) Theme
  System (follows `prefers-color-scheme` live) / Light / Dark and **Accessible colors** (Yes blue / No orange, both
  themes, via CSS custom properties app-wide); (7) Trade mechanics — Flip sell, Auto-sell prompt after buy, Skip order
  review, Collateral return (stored now, tagged "takes effect in Phase 5"), RFQ opt-in (the existing `rfq_enabled`, live)
  with a terms link, Advanced shard settings (Phase 9 note); (8) Market preview price type — Last traded / Current buy,
  applied to the home cards and hero and to the portfolio price column ("Mark" / "Buy now"). Preferences are validated
  strictly server-side (`PUT /users/:uid/preferences`) and stored in `user_settings`, so they apply on load on any device.
- **Rewards** (`/rewards`, `GET /v1/rewards/new_user_checklist` → `{variant, steps:[{step,status}]×4, revamp_enabled}`):
  verify identity · first deposit · first trade · create profile. **Promo codes**: created in Admin › Promo codes
  (users.money; code, credit ≤ $1,000, max redemptions, window; audited), redeemed from ☰ › Enter promo code or Rewards:
  validated server-side, single use per account (unique key), global cap enforced by a conditional update, 10 failed
  attempts per hour per account, identity verification required when gating is on, credited to the ledger as kind
  `credit` (shows under Activity › Credit and on the 1099-MISC statement). Referrals/promotions are Phase 8.

### 25.10 Privacy: export and closure (P3.8)

- **Export** (`POST /users/:uid/data_export`, owner, fresh step-up): one JSON file — account, identity (own decrypted
  details; national ID masked), settings, preferences, consent records, orders, fills, positions, settlements, ledger,
  watchlist, notifications, alerts, limits, social, chat, perps, security (sessions, events, passkeys, linked providers,
  devices), holds, document metadata (no photos).
- **Closure** (`POST /users/:uid/close_account {confirm:'CLOSE'}`, fresh step-up): refused while event-contract or perps
  positions are open, perps orders rest, perps collateral remains or a withdrawal is held; resting orders and open
  RFQs/quotes are canceled; remaining cash is paid out (`closure_payout`); **crypto-shredding**: the user's data key is
  deleted, ciphertexts and ID photos cleared, phone challenges, emails, SMS, tokens, MFA, passkeys, provider links and
  location checks deleted; the account row stays (ledger and fills keep their references) with a placeholder email,
  name and an unusable password; sessions revoked. The audit row `privacy.account_closed` carries no email or other PII.

### 25.11 Residual security items closed

- **RS2**: after `accountThreshold` failures an account is no longer hard-locked: each further sign-in must carry a
  proof of work (`SHA-256(id:nonce)` with 12 leading zero bits, +1 per further failure up to 18; HMAC-signed, bound to the
  email's key, 2-minute, single use). The answer keeps the same shape for unknown emails (`429 too_many_attempts`,
  `retry_after_sec: 0`, `pow`). The sign-in page solves it automatically ("Checking your browser…"). Per-IP backoff stays
  a hard limit. The owner is alerted once ("Repeated failed sign-ins").
- **RS3**: the last accepted TOTP time step is stored per user (`mfa.last_step`); a code for that step or an earlier one is
  refused for login, step-up, enabling and disabling; acceptance is a conditional update (no double use under a race).
- **RS6**: real SMTP and SMS-webhook transports behind the messaging abstraction (§25.7).
- **RS9**: the admin module no longer answers `account_locked` before the password check; a locked account answers a
  wrong password byte-for-byte like any other account.
- **RS10**: the SPA sends `X-Plx-Idle` (seconds since the last real interaction: pointer, key, wheel, touch) on every
  request; the server advances the session's last-seen time only to `now − idle`, so background polls no longer keep an
  idle session alive. WebSocket (re)connects do not count as activity. Clients without the header (API scripts) count
  every request.

### 25.12 API summary (all under `/v1`; every route classified in `tests/authz.e2e.test.js`)

| Area | Routes | Who |
|---|---|---|
| Config | `GET identity/config`, `identity/countries` | public |
| Onboarding | `GET users/:uid/sign_up`, `POST resume_sign_up`, `POST users/:uid/sign_up/{skip,submit}`, `PUT users/:uid/sign_up/{name,birthday,address}`, `GET address/suggest` | owner / user |
| Phone | `POST users/:uid/verify_phone/send`, `POST users/:uid/verify_phone` | owner |
| Documents | `GET users/:uid/docv`, `POST users/:uid/docv/{sessions,documents,submit,exit}`; `POST docv/handoff/{claim,documents,submit}`, `GET docv/handoff` | owner; handoff token / capture cookie |
| Email, reset | `POST users/:uid/email_verification`, `POST verify_email`, `POST passwords/reset`, `GET passwords/reset/:token`, `PUT passwords/reset/:token/confirm` | owner; public (signed tokens, login CSRF) |
| OAuth | `POST oauth/:provider/{start,callback}`, `POST oauth/link`, `POST users/:uid/oauth/:provider/link`, `GET users/:uid/oauth`, `DELETE users/:uid/oauth/:provider`; mock `/mock-oidc/:provider/{authorize,token,jwks}` | public (login CSRF) / owner (+A2, step-up) |
| Passkeys | `POST users/:uid/passkeys/registration[/options]`, `GET`/`DELETE users/:uid/passkeys[/:id]`, `POST passkeys/authentication[/options]`, `POST passkeys/step_up[/options]` | owner (+A2, step-up) / public / user |
| A2 | `GET users/:uid/sign_in_methods`, `GET users/:uid/api_keys` | owner (+A2) |
| Privacy | `GET users/:uid/identity`, `POST users/:uid/data_export`, `POST users/:uid/close_account` | owner (+step-up) |
| Compliance | `GET`/`POST users/:uid/geolocation`, `GET users/:uid/withdrawal_holds` | owner |
| Account area | `GET`/`PUT users/:uid/preferences`, `GET`/`POST users/:uid/marketing_consent`, `GET users/:uid/connected_apps`, `DELETE …/:id`, `GET users/:uid/activity[.csv]`, `GET users/:uid/tax_documents`, `…/:year/transactions.csv`, `…/:year/:form.{csv,pdf}`, `GET`/`POST users/:uid/promo_codes`, `GET rewards/new_user_checklist` | owner / user |
| Admin | `GET admin/kyc/queue`, `POST admin/kyc/:userId/decision`, `GET admin/kyc/:userId/documents`, `POST …/documents/:docId/view`, `GET admin/identity/users/:id`, `POST …/unmask`, `GET`/`PUT admin/compliance/settings`, `GET admin/fraud/overview`, `POST admin/fraud/holds/:id/:action`, `GET`/`POST admin/promo_codes`, `PUT admin/promo_codes/:id` | users.read / users.support / settings.write / users.money |
| Dev | `GET dev/mailbox`, `GET dev/sms` | non-production, loopback only |

Tables (all `CREATE TABLE IF NOT EXISTS`, idempotent column migrations): `identity_profiles`, `identity_keys`,
`identity_tokens`, `identity_request_log`, `phone_challenges`, `sms_send_log`, `sms_outbox`, `kyc_jobs`, `kyc_decisions`,
`docv_sessions`, `docv_documents`, `geo_checks`, `device_sightings`, `risk_assessments`, `withdrawal_holds`,
`oauth_requests`, `oauth_links`, `oauth_link_tokens`, `mock_oidc_codes`, `mock_oidc_keys`, `passkeys`, `webauthn_users`,
`webauthn_challenges`, `session_amr`, `login_pow_used`, `marketing_consents`, `oauth_grants`, `promo_codes`,
`promo_redemptions`, `promo_attempts`; `mfa.last_step` added. Settings row `admin_settings.compliance`.

### 25.13 Tests

- `tests/onboarding.e2e.test.js` (5): full UI flow with QR handoff to a 390 px phone context, QR modules compared with the
  encoder for the exact handoff URL, live desktop updates, EXIF/GPS/trailing bytes stripped, encrypted at rest, erased at
  the decision, gating before/after, no plaintext PII in a full DB dump, masked APIs; handoff security (single use,
  expiry, session binding, bad file type, missing CSRF, exit keeps progress, same-device fallback); Review → admin queue
  (masked, audited reveal and document view, decision with step-up) / Reject / Retry; "Not now" + banner + reload
  persistence, validation (phone, wrong code with attempts left, cooldown, server-side underage, PO box, ID format without
  echo, duplicate ID); SMS per-number and per-country limits, 390 px on every step, restart with a queued KYC job.
- `tests/identity2.e2e.test.js` (13): email verification and password reset through the dev mailbox; OAuth via the mock
  provider (UI, state/PKCE/binding/code-injection tampering, account linking); A2 envelope + passkeys with Chromium's CDP
  virtual authenticator (register with step-up, sign in, counter regression, forged signature, passkey step-up); admin
  passkey policy; RS2, RS3, RS9, RS10; location (IP override, browser geolocation, banner, dialog); fraud hold and
  reversal; export and closure.
- `tests/account-area.e2e.test.js` (5): frame, ☰ menu order, placeholders, category index, sub-tabs, 390 px; activity
  chips/CSV/empty/persistence; documents P&L/CSV/PDF/IDOR; settings order, each setting persisted and applied (cards,
  theme incl. system, accessible palette, consent records, connected apps, Phase 2 modules, trade mechanics, preview
  price on home and portfolio, strict validation, fresh-browser reload); promo codes, checklist, restart.

**Changes to existing tests** (minimal):
- `tests/security-perimeter.e2e.test.js`: `Permissions-Policy` now expects `geolocation=(self)` (P3.6 browser location).
- `tests/auth-security.e2e.test.js`: the lockout test asserts RS2 (proof of work instead of a timed lock; notification
  "Repeated failed sign-ins"); TOTP codes reused within one 30-second step now use the next step's code (RS3).
- `tests/features.e2e.test.js`, `tests/e2e.test.js` (where they re-use a TOTP code in the same step): same RS3 adjustment.
- `tests/authz.e2e.test.js`: Phase 3 routes classified.
(The exact list for this change set is in the hand-over report.)

### 25.14 Residual risks

- The KYC provider, location provider and fraud scoring are **simulations**; no real identity, sanctions or geolocation
  checks run. Browser geolocation is user-controlled and spoofable; VPNs defeat the IP table.
- Images are re-encoded in the browser and container-sanitised on the server, not re-encoded server-side (no image
  library); a malicious client can upload a crafted but structurally valid JPEG/PNG. Images are never served to anyone
  but staff as `data:` URLs inside the admin page.
- Data keys are wrapped by one master key without rotation (RS4, Phase 9). A database **and** key compromise exposes PII.
- The dev mailbox/SMS endpoints exist in any non-production build; they are loopback-only, but a dev server exposed
  through a local reverse proxy would show them to that proxy's clients.
- The handoff link can be forwarded by the user to someone else within 10 minutes (as with any vendor QR flow); the
  desktop sees the phone connect and can exit.
- Proof of work raises the cost of online guessing but does not stop a determined, well-resourced attacker; the per-IP
  hard limit and password policy remain the main defences.
- A2 exempts staff accounts by design; staff identity is assumed verified out of band.
