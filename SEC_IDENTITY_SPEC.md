## 22. Identity, sessions and login security

Phase 1B of `PLAN.md` (P1.4 sessions, P1.5 login hardening, P1.6 step-up verification, P1.14 auth security log and
hash-chained audit, P1.15 encryption of secret columns, gap G4). Code: `clone/server/auth.js` (sessions, login CSRF,
throttling, step-up, routes, first-admin bootstrap), `clone/server/passwords.js` (hashing + policy),
`clone/server/common-passwords.txt` (bundled breached list), `clone/server/crypto.js` (shared key + AES-GCM helper),
`clone/server/audit-chain.js` (tamper-evident admin audit), `clone/server/create-admin.js` (CLI). UI:
`public/js/views/auth.js`, Account › Security in `public/js/views/account.js`, `public/js/views/stepup.js` (modal),
Admin › Sign-in & audit integrity in `public/js/views/admin/identity.js`. Tests: `clone/tests/auth-security.e2e.test.js`.

### 22.1 Evidence (what Kalshi does) and what stays unknown

| # | Observation | Evidence | Clone |
|---|---|---|---|
| S7 | The web client sends credentials with every API call (`withCredentials`) and a CSRF token in a dedicated header (`xsrfHeaderName: CSRF_HEADER_NAME`, sent as `x-csrf-token`), kept in `csrfToken` storage; the API exposes `X-Csrf-Token` to the browser. | JS26:0lt3ma0qstivi (REA `ev_51dfbee8…`); preflight capture 2026-11-03 (PLAN §2 S4) | Session CSRF unchanged (header on every write, compared in constant time). New: **login CSRF** for the pre-session endpoints; rotated tokens are returned in an `X-Csrf-Token` response header that the client stores (§22.2). |
| S8 | Unauthenticated requests get `401 token_authentication_failure` with no detail about the resource. | capture 2026-11-03 | Kept. Login failures are uniform: `401 invalid_credentials "incorrect email or password"` for unknown email and wrong password alike (§22.3). |
| S9 | Strong customer authentication: passkeys (`/passkeys/registration`, `/passkeys/authentication`), a 4-digit MFA login code, an `action_verification_mfa` step for sensitive actions, and an `enableWithdrawalMfa` account setting. | JS26:3pds_3l0ju6me, 0bszqignr8pgk; api_callsites | Step-up verification with a `step_up_required` error and modal (§22.6); withdrawal two-factor setting (§22.6). The clone's MFA is TOTP (6 digits, authenticator app) because it needs no SMS/email provider (U20 stays UNKNOWN: Kalshi's code is 4 digits, channel not observed). Passkeys are P3.4. |

Not observable from outside (PLAN §2 last paragraph): Kalshi's session lifetime, idle timeout, lockout thresholds,
password policy, hashing, admin tooling and audit-log design. Every value below is a **design choice** for the clone,
recorded with its rationale.

### 22.2 Sessions (P1.4)

- **Cookie.** `__Host-plx_session` with `Path=/; HttpOnly; Secure; SameSite=Lax` when served over HTTPS or with
  `NODE_ENV=production` / `SECURE_COOKIES=1` (behind a TLS-terminating proxy). Browsers only accept a `__Host-` cookie
  with `Secure`, which they refuse to set over plain `http://localhost`, so local development uses the unprefixed name
  `plx_session` with the same attributes minus `Secure`. Both names are accepted on read. Accounts with any admin role
  get `SameSite=Strict` (PLAN P1.4); the SPA's own requests are same-site, so this only stops cross-site navigations
  from carrying the admin cookie. `Max-Age` equals the absolute lifetime.
- **Hashed tokens.** The 256-bit cookie token is never stored: `sessions.token` holds its SHA-256. A leaked database
  therefore yields no usable session. Each row also has a public id `sid` (`ses_…`) used for the device list,
  revocation and WebSocket binding. Rows written by earlier builds (plaintext tokens) are hashed in place on start-up,
  idempotently (`token_hashed` flag), so existing cookies keep working.
- **Lifetimes.** Absolute 30 days from sign-in (`expires_at`, unchanged column). Sliding idle timeout: **30 minutes for
  any account with an admin role, 7 days otherwise** (`idle_ms` stored per session at creation; `last_seen_ms` refreshed
  at most every `min(30 s, idle/10)`). An expired session is deleted when next seen and logged as `session_expired`.
  Any authenticated HTTP request counts as activity, including an open tab's background polls; a closed or idle tab
  expires.
- **Rotation.** A new token is issued: on **log in / sign-up / MFA completion / admin setup** (a brand-new session; the
  session the request arrived with is deleted first, so a planted cookie can never be upgraded — fixation defence); on
  **turning two-factor on** and **password change** (same `sid` and device entry, new token and CSRF token); on a
  **privilege change** — the target's sessions are all revoked (they sign in again with the new rights), and an admin
  changing their own roles gets a rotated session while their other sessions are revoked.
- **Metadata.** Created, last seen, IP *prefix* (IPv4 /24, IPv6 /48; full addresses are never stored) and a user-agent
  *summary* ("Chrome on Linux"; the raw string is not stored).
- **Account › Security** lists signed-in devices (this device marked) with "Sign out device" per row and **"Sign out
  everywhere"** (all sessions including this one). Revocation is live: the WebSocket hub closes the revoked sessions'
  sockets with code **4401** after a `session_revoked` frame, and the client then re-checks `/v1/session` and drops to the
  signed-out state. The hub also re-validates every socket's session on its 15 s keep-alive tick, so idle/absolute
  expiry, account locks and admin-side deletions end private channels too.
- **WebSocket upgrade** uses exactly the HTTP validity rules (hashed token, idle + absolute expiry, account lock) plus
  the existing `csrfToken` query check (spec §7.2).
- **Login CSRF.** `GET /v1/auth/csrf` sets a short-lived (60 min) `HttpOnly` cookie `plx_pre` (`__Host-plx_pre` over
  HTTPS) holding `<nonce>.<expiry>` and returns `csrf_token = HMAC-SHA256(login-csrf key, cookie value)`. `POST
  /v1/log_in`, `/v1/users`, `/v1/log_in_mfa`, `/v1/auth/setup_admin` and `/v1/auth/complete_password_change` require
  that token in `x-csrf-token`; otherwise `403 forbidden "missing or invalid login csrf token"`. A cross-site page can
  neither read the token nor set the cookie, so it cannot sign a victim into an attacker's account. The client fetches
  a fresh token before every sign-in/sign-up. The session CSRF token (per session, returned at sign-in and by
  `/v1/session`) still guards every other write.

### 22.3 Login hardening (P1.5)

- **Uniform failures.** Unknown email and wrong password return the same status, body and headers, and both cost one
  scrypt evaluation (unknown emails are checked against a precomputed dummy hash with the current parameters). Unknown
  emails are logged only in masked form (`g***@example.test`).
- **Backoff and lockout (persisted in `auth_throttle`).** Two counters per attempt: the account key
  (`acct:` + SHA-256 of the normalised email — the same for existing and non-existing accounts, so behaviour reveals
  nothing) and the client IP. From the 5th failure on an account (20th from one IP) within 60 minutes, sign-in is refused
  for 30 s, doubling with every further failure up to 15 minutes. While locked, every attempt — even with the right
  password — gets `429 too_many_attempts` with `retry_after_sec`; the UI shows "Too many sign-in attempts. Try again in
  N seconds." A success clears the account counter (the IP counter only decays, so a success on an attacker's own
  account cannot reset it). Failed step-up and password-change checks and wrong MFA codes count as well.
- **Notification.** The first lockout of an existing account sends an in-app security notification and an email
  (stub: a row in `email_outbox`, listed in Admin › Sign-in & audit integrity; no mail is sent) and logs `lockout`.
### 22.4 Password policy and password management (P1.5)

- **Password policy** (sign-up, password change, forced change, admin setup, `ADMIN_PASSWORD`, `create-admin`): at least
  12 and at most 128 characters; at least two of lowercase / uppercase / digits / symbols; not one repeated character;
  must not contain the email address, its local part or any ≥4-character part of the email or display name; must not be
  a known breached password. The breached check uses `server/common-passwords.txt` — 451 SHA-1 hashes (HIBP
  "Pwned Passwords" style, no network) of the most common breached passwords and their usual long variants — and also
  tests the de-leeted form (`P@ssw0rd` → `password`) and the alphabetic core (`Summer2025!!` → `summer`). Messages name
  the rule that failed ("Password must be at least 12 characters.", "…appears in lists of breached passwords…"). Login
  never applies the policy, so older accounts can still sign in.
- **Hashing.** scrypt with the parameters stored in every hash: `scrypt2$N$r$p$salt$key`. Default N = 2^16, r = 8,
  p = 1 (64 MiB, 4× the first build's N = 2^14); `SCRYPT_LOG_N` (14–20) raises it where hardware allows (OWASP's
  reference is N = 2^17). Hashing runs on the libuv pool (`crypto.scrypt`), not the event loop. A successful login with
  the legacy `scrypt$salt$key` format or weaker parameters is transparently re-hashed (`password_rehash` event).
- **Password change** (`PUT /v1/users/:uid/password`): requires the current password **and** step-up; rotates this
  session and signs out all other sessions; alerts the user.
- **Admin-forced reset** (`POST /v1/admin/users/:id/force_password_reset`, permission `users.support`, reason
  required, step-up): sets `must_change_password`, signs the account out everywhere, audits and alerts. At the next
  sign-in (after the password and, if on, the TOTP code) no session is issued; the response is
  `{password_change_required, change_token}` (15-minute single-use token, stored hashed) and the UI asks for a new
  password, then signs in. (A reset-by-email link is P3.1.)
### 22.5 First admin and demo accounts (P1.5: no default admin password)

- **No default admin password.** The seed no longer creates `admin@parlance.local`. The first admin comes from, in
  order: `start({ admin: { email, password } })` or `ADMIN_EMAIL` + `ADMIN_PASSWORD` on start (policy-checked; a weak
  password refuses to start; never overwrites an existing usable password); `npm run create-admin` (interactive prompt
  with hidden input, or the same env vars; run while the server is stopped); or, when no admin can sign in, a
  **one-time setup URL** printed to the console (`/setup?token=…`, single use, 60 minutes, stored hashed; a restart
  invalidates the previous link). Databases from earlier builds: if `admin@parlance.local` still has the old
  `parlance-admin` password it is disabled at start-up (`!default-password-removed`), so that password no longer works
  and the setup link appears. All three paths log `admin_bootstrap` and append an `admin.bootstrap` audit row.
- **Demo accounts.** `maple_quant@`, `harborwatch@`, `rainmaker@parlance.local` keep working in the dev seed with a
  **generated password printed once** at seed time (`Demo-…-NN`), or the value of `DEMO_PASSWORD` /
  `start({ demoPassword })` (tests). Old databases where they still have `parlance-demo` get a new password the same
  way. Choice: keeping them usable keeps the social/moderation demo working, and a per-install random password removes
  the shared default.

### 22.6 Step-up verification (P1.6)

- Sensitive actions require a password or TOTP check within the last **10 minutes** (a sign-in counts). Otherwise the
  server answers `403 {error: {code: "step_up_required", message, details, methods: ["password","totp"] | ["password"] |
  ["totp"], action}}`. `POST /v1/step_up {password} | {code}` records the check on the session (`auth_at`, and
  `totp_at` for codes); failures count toward the lockout counters and are logged.
- Guarded, in one central list in `auth.js`: two-factor off, password change, email change, the withdrawal two-factor
  setting, withdrawals, deposits and perps transfers above **$10,000**, admin role changes and admin-forced password
  resets. API-key creation joins the list when keys exist (P7.1).
- **Client.** `api.request()` (and the admin toolkit's `call()`) catches `step_up_required`, opens the "Confirm it's
  you" modal (password, or the 6-digit code, with a switch when both are allowed), calls `/v1/step_up`, and retries the
  original request once. Cancel rejects with `step_up_cancelled`, and the action is not performed.
- **Withdrawal two-factor** (mirrors `enableWithdrawalMfa`): an Account › Security toggle, available once two-factor
  login is on (changing it needs step-up; turning two-factor off clears it). When on, **every** withdrawal needs a fresh
  TOTP code (`methods: ["totp"]`; a password does not satisfy it, and a successful withdrawal consumes the
  verification).

### 22.7 Tamper-evident admin audit log

Every `admin_audit` row (admin panel, chat moderation, admin bootstrap, CLI) is appended through
`audit-chain.js`: `chain_seq` (1, 2, 3, …), `prev_hash` (the previous row's hash; 64 zeros for the first) and
`hash = HMAC-SHA256(audit-chain key, [chain_seq, all row fields, prev_hash])`. The newest row is also recorded as a
MAC-protected chain head in `meta`. `GET /v1/admin/audit/verify` (`audit.read`) recomputes the chain and reports the
first problem: an edited row ("row contents do not match its hash"), a broken link, a gap, a row without a hash, or
deleted newest rows. The Admin page's **Verify audit chain** button shows "Chain intact · N entries verified" or
"Tampering detected at entry #n: …". The key matters: a bare hash chain could be recomputed by anyone with write access
to the database; an HMAC chain cannot without the server key. Rows written before chaining existed are sealed once at
start-up, but only those after the last chained row, so a hash cleared in the middle of the chain is reported, not
silently re-chained.

### 22.8 Encryption at rest (P1.15)

- `server/crypto.js` (shared with the perimeter work): one 32-byte master key from `SECRET_KEY`, else `SECRET_KEY_FILE`,
  else `secret.key` next to the database (created with mode 0600, never overwritten; git-ignored and in the `.claude`
  deny rules). Purpose-specific sub-keys via HKDF-SHA256 (`field-encryption:v1`, `login-csrf:v1`, `audit-chain:v1`).
- **TOTP secrets** (`mfa.secret`) are stored as `enc:v1:<iv>.<tag>.<ciphertext>` (AES-256-GCM, 96-bit random IV) with
  additional data `mfa.secret:<user id>`, so a ciphertext copied to another user's row does not decrypt. Plaintext rows
  from earlier builds are encrypted in place on start-up (idempotent). MFA challenge tokens, setup and password-change
  tokens and session tokens are stored as SHA-256 hashes. No other secret columns exist today (the CSRF token per session
  is only useful together with the session cookie).
- Key rotation is not implemented: changing the key makes existing TOTP enrolments unreadable (users re-enrol) and the
  audit chain unverifiable from the old rows. Recorded as a residual risk.

### 22.9 Security log (P1.14)

`auth_events` (persisted; 400-day retention): `signup`, `login_ok`, `login_fail`, `lockout` (account or IP),
`logout`, `mfa_on`, `mfa_off`, `mfa_fail`, `step_up`, `step_up_fail`, `password_change`, `password_change_fail`,
`password_change_required`, `password_reset_forced`, `password_rehash`, `email_change`, `withdrawal_mfa_on/off`,
`session_revoke`, `sessions_revoke_all`, `sessions_revoked` (privilege change), `session_expired`, `admin_bootstrap`,
`default_password_removed`. Each row: time, user (or none, with a masked email), IP prefix, device summary, JSON detail.
Users see their own in **Account › Security › Security activity** (`GET /v1/users/:uid/security_events`); staff with
`audit.read` see everyone's in **Admin › Sign-in & audit integrity** (`GET /v1/admin/identity/events`, filter by type
prefix and email), next to the email outbox stub (`GET /v1/admin/identity/outbox`, `users.support`).

### 22.10 G4 — maker trading limit on RFQ confirm

`confirmQuote()` now applies the maker's daily trading limit to the order the confirmation creates (maker bid ×
size, `trading_limit_exceeded`, nothing executes, the quote stays accepted until it lapses), matching the taker-side
check on accept.

### 22.11 API summary

| Method + path | Auth | Notes |
|---|---|---|
| `GET /v1/auth/csrf` | none | login-CSRF cookie + token |
| `POST /v1/users`, `/v1/log_in`, `/v1/log_in_mfa` | login CSRF | sign-up / sign-in; `{mfa_required, mfa_token}`, `{password_change_required, change_token}` or `{user, csrf_token}` |
| `POST /v1/auth/complete_password_change` | login CSRF | after an admin-forced reset |
| `GET /v1/auth/setup?token=`, `POST /v1/auth/setup_admin` | login CSRF (POST) | one-time first-admin setup |
| `POST /v1/log_out` | session | deletes this session |
| `POST /v1/step_up` | session | `{password}` or `{code}` |
| `GET /v1/users/:uid/security` | session | MFA / withdrawal-MFA state, step-up window, idle timeout, policy |
| `GET /v1/users/:uid/sessions`, `DELETE …/sessions/:sid`, `DELETE …/sessions` | session | devices, sign out one, sign out everywhere |
| `GET /v1/users/:uid/security_events` | session | own security activity |
| `PUT /v1/users/:uid/password`, `PUT …/email`, `PUT …/withdrawal_mfa` | session + step-up | |
| `GET/POST /v1/users/:uid/mfa[/setup|/enable|/disable]` | session (disable: + step-up) | moved from `features.js`; secrets encrypted |
| `GET /v1/admin/identity/events`, `GET /v1/admin/audit/verify` | `audit.read` | |
| `GET /v1/admin/identity/outbox`, `POST /v1/admin/users/:id/force_password_reset` | `users.support` (+ step-up) | `:id` may be an email |

Start options (`server/index.js`): `admin`, `demoPassword`, `auth: { idleMs, adminIdleMs, absoluteMs, stepUpMs,
accountThreshold, ipThreshold, baseLockMs, maxLockMs, failureWindowMs, largeDepositCents, largeTransferCents,
secureCookies, … }` (defaults in `auth.js`), `quiet`; the result includes `setupUrl` / `setupPath`.

### 22.12 Tests (`clone/tests/auth-security.e2e.test.js`, 13 browser tests)

Weak / single-class / name-containing / breached passwords refused with their messages; hash format stores cost
parameters; session token only as SHA-256 in the DB; login rotation; login CSRF missing / bogus / from another browser
→ 403 on all pre-session endpoints; unknown-email vs wrong-password responses byte-identical with similar timing;
account and unknown-email lockout, UI message, owner notification + email stub + event, doubling lock, unlock after
cool-down; device list, sign out one device (the other browser drops to signed-out live), sign out everywhere; MFA-on
rotation (new cookie and CSRF, same device); step-up modal for password change (wrong then right password) and
two-factor off (via code), cancel leaves an email change undone; withdrawal two-factor (code only, per withdrawal,
cancel withdraws nothing); TOTP secret encrypted and key file 0600; maker trading limit on RFQ confirm (G4); privilege
change revokes the target's sessions, admin role change needs step-up, admin sessions are Strict/30-minute; forced
password reset with step-up modal and new-password flow; audit chain intact → edited row detected at #1 → restored →
deleted tail detected; first admin via setup URL (single use, 410 on reuse, weak password refused), legacy
`parlance-admin` disabled, `ADMIN_EMAIL`/`ADMIN_PASSWORD` (weak refuses to start); restart keeps hashed sessions,
failure counters, events, encrypted TOTP (plaintext rows migrate and still verify); idle timeout; per-IP lock.

### 22.13 Residual risks and follow-ups

- **Account lockout as denial of service.** Anyone who knows an email can keep it locked for up to 15 minutes at a time;
  the doubling caps the cost to the victim but does not remove it. A CAPTCHA/proof-of-work step (the perimeter
  challenge) instead of a hard lock for the account key is the next step.
- **Admin lock disclosure.** The admin module refuses `POST /v1/log_in` for an admin-locked account with
  `account_locked` before the password is checked (pre-existing behaviour kept for its tests), which reveals that a
  locked account exists.
- **TOTP replay.** A code may be reused within its 30-second window (no last-used-step record); rate limits and the
  challenge attempt cap bound the risk.
- **Idle timeout and background polling.** An open tab keeps a session alive through its polls; only a closed or idle
  tab expires. Distinguishing user activity from polls is not done.
- **Forced reset still trusts the old password once** to reach the "choose a new password" step; a reset-by-email link
  (P3.1) is needed when the old password itself is compromised.
- **No key rotation** for `secret.key` (§22.8); **truncation** of the audit table together with the `meta` head row is
  only detectable against an external copy of the head (e.g. shipped to logs, P9.4).
- **Email delivery is a stub** (`email_outbox`); SMTP is P3.1. Passkeys / WebAuthn are P3.4.
- The scrypt default (N = 2^16) is below OWASP's N = 2^17 reference for latency on small hosts; raise `SCRYPT_LOG_N` in
  production.
