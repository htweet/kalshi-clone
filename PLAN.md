# Parlance Exchange — phased build, research and security plan

Status date: 2026-11-03. Covers everything not yet built, everything still to research (with REA), and the security work that runs through every phase. Companion documents: `CLONE_SPEC.md` (§1–§19 behaviour spec; §20 live chat when it lands) and `clone/README.md`.

**Ground rules for every phase**
1. **Security first.** Phase 1 (security foundation) must ship before any feature phase that touches money, identity or user content. Every later phase passes the security gate in §6.
2. **Clean room.** Build from observed behaviour and public docs only. No Kalshi code, text, images, fonts, logos or trademarks; invented data only.
3. **Research ethics.** Logged-out public surfaces and the public developer docs only, at a polite rate. Never bypass Kalshi's bot challenge or WAF, never use anyone's credentials, never automate logged-in access. Logged-in behaviour comes only from captures you make yourself, with personal data removed before sharing.
4. **Definition of done.** Fully wired, 100% DB-persistent, end-to-end browser tests, `npm audit` clean, spec section updated with evidence and design choices, full suite green before merging to `main`.
5. **Nigeria first, multi-country ready** (owner decision 2026-11-08, `CLONE_SPEC.md` §30.0). Parlance is mainly for Nigerians and may scale to more countries. Defaults are Nigerian (NGN, WAT, en-NG, Nigerian states and calendar); country facts (divisions, offices, seats, election rules, parties, holidays, currency, time zone) are admin-managed data keyed by country code, never hard-coded; election features assume N parties, not two. Clean room still holds: invented candidates and parties in seed data, never real politicians or their photos.

---

## 1. Where things stand

Built and passing (94 end-to-end browser tests on `main`): prediction-market exchange (matching engine, lifecycle, settlement, fees, netting), live WebSocket data, social, notifications and price alerts, account limits, TOTP two-factor, calendar, dark redesign matching the live site, Dollars/BUY/SELL ticket, daily interest, rolling 15-minute markets, Pro table, Perps margin product, fractional contracts, combos with two-sided RFQ/quotes, the five portfolio tabs, admin panel/CMS, sports live scoreboards.

Fixed 2026-11-03: "database is locked" on start (single-instance lock, busy timeout, clean Ctrl+C shutdown) and the `ws` high-severity advisories (8.18.3 → 8.22.1; `npm audit` clean).

Done 2026-11-03: **event live chat** (spec §20) with server-side auth, CSRF, chat-specific rate limits, slow mode, moderation, reports and XSS-safe rendering; WebSocket frames capped at 64 KB (an oversized frame previously could crash the server). 103 end-to-end tests.

---

## 2. Security research findings (Kalshi, observed 2026-11-02/03)

How Kalshi keeps automated clients — including this Claude Code session — away from its pages and sensitive files, and what each control maps to here. Evidence keys as in `CLONE_SPEC.md` §0.1.

| # | Kalshi control (observed) | Evidence | Clone today | Plan |
|---|---|---|---|---|
| S1 | **Bot challenge on every HTML route.** Vercel Security Checkpoint answers automated clients with 429 + `x-vercel-mitigated: challenge` and `cache-control: private, no-store`; the challenge POST returns 708. It covers `/`, `/robots.txt`, `/.env`, `/.git/config` alike, so probes for sensitive files learn nothing. | [CHK]; header capture 2026-11-03 (scratchpad `sec/`) | none | P1.10 bot challenge |
| S2 | **WAF token on API and WebSocket calls.** AWS WAF JS integration (`AwsWafIntegration`, `AwsWafToken`, `AwsWafTokenForWebSocket`, `AwsWafTokenToAxiosConfig`, `awsWafCookieDomainList`, `awsWafFetchRetryCount`, endpoint `*.edge.sdk.awswaf.com`); requests carry `x-aws-waf-token`. | JS26:3pds_3l0ju6me (REA `ev_0525729f…`); HAR3 request headers | none | P1.10 signed client token |
| S3 | **Static assets public but opaque.** Content-hashed immutable chunks (`cache-control: public,max-age=31536000,immutable`); **no source maps** (`.js.map` → 404). | header capture | unhashed assets, no maps | P1.11 |
| S4 | **API CORS allowlist.** Preflight from `https://kalshi.com` → 204 with credentials and an explicit header allowlist (incl. `X-Csrf-Token`, `X-Aws-Waf-Token`, `Idempotency-Key`); from a foreign origin → **403**. Responses expose only `X-Csrf-Token, Etag`. | preflight capture 2026-11-03; HAR3 | no ACAO for foreign origins (browser-blocked) but OPTIONS still 200 | P1.3 |
| S5 | **Locked-down JSON responses.** API sends `content-security-policy: default-src 'none';`, `x-content-type-options: nosniff`, HSTS (`max-age=31536000; includeSubDomains`), `cache-control: no-store` on authenticated routes. | HAR3, header capture | none of these | P1.1 |
| S6 | **Clickjacking defence.** Site CSP `frame-ancestors 'self' *.kalshi.com *.kalshi.co`. | HAR3 #7 | none | P1.1 |
| S7 | **CSRF.** Axios client with `withCredentials` and `xsrfHeaderName: CSRF_HEADER_NAME`; token in `csrfToken` storage, sent as `x-csrf-token`. | JS26:0lt3ma0qstivi (REA `ev_51dfbee8…`) | implemented (header on mutating requests) | P1.4 login CSRF |
| S8 | **Uniform auth errors.** Unauthenticated → 401 `token_authentication_failure` (+ `support_action`) with no detail about the resource. | capture 2026-11-03 | implemented | keep |
| S9 | **Strong customer auth.** Passkeys/WebAuthn (`/passkeys/registration`, `/passkeys/authentication`), 4-digit MFA login, `action_verification_mfa` step-up for sensitive actions, `enableWithdrawalMfa`. | JS26:3pds_3l0ju6me, 0bszqignr8pgk; api_callsites | TOTP login only | P1.6, P3 |
| S10 | **Fraud and compliance signals.** GeoComply geolocation (`accountRequiresGeoComply`, "GeoComply couldn't be reached"), Riskified fraud session (`riskified-session-id`), device-ID hash. | JS26 (6 + 2 + 4 files) | none | P3.6–P3.7 |
| S11 | **Telemetry scrubbing.** Monitoring URLs are scrubbed of IDs by regex: `/debit/cards/…`, `/plaid/accounts/…`, `/frontend_sessions/…`, `/passkeys/…`, `/referrals/offer/…`, `/realized_pnl_reports/…`. | JS26:3pds_3l0ju6me | no telemetry yet | P9.4 |
| S12 | **CSP nonces** on preloaded styles/scripts (`nonce: r.nonce`). | JS26 (6 files) | none | P1.1 |

What we could **not** observe (logged-in pages, admin tooling, server internals, rate-limit thresholds, password policy, session lifetime) stays UNKNOWN; the clone's choices are listed in P1.

**"Keep AI agents away from vital files" — two separate things:**
- *Public site (what Kalshi does):* S1–S5. Sensitive paths never reach application code, HTML sits behind a challenge, assets carry no source, the API accepts only its own origin plus a valid WAF token. P1.10–P1.12 reproduce this. These controls raise cost; they are not a guarantee, since determined humans with real browsers still pass.
- *Your repository and machines (what Claude Code can read while developing):* real protection is keeping secrets **out of reach**, not hoping a tool won't look — no production credentials or real databases on dev machines, secrets in a vault/environment, least-privilege tokens. On top of that, Claude Code honours project permission rules: P1.13 adds `.claude/settings.json` deny rules for `.env*`, `clone/data/**`, key files and production configs, plus a pre-commit secret scanner. Treat these rules as guardrails against accidents, not a security boundary.

---

## 3. Phased implementation plan

Size: S ≈ a day, M ≈ 2–4 days, L ≈ a week+, for one engineer with this codebase. Each phase ends with its exit criteria and the §6 security gate.

### Phase 0 — Stabilise (S, mostly done)
- ✅ Single-instance DB lock, busy timeout, clean shutdown; `ws` upgrade.
- P0.1 CI on GitHub Actions: `npm ci`, `npm audit --audit-level=high`, full E2E suite headless, on every PR; required check before merge.
- P0.2 Dependabot (npm + GitHub Actions), weekly.
- P0.3 Windows dev notes in README (Git Bash paths, run from repo root vs `clone/`).
- Exit: CI green on `main`; branch protection on `main`.

### Phase 1 — Security foundation (L, **before any new money/identity feature**)
- P1.1 **Security headers** middleware: site CSP (`default-src 'self'`; `script-src 'self'` with per-response nonce; `style-src 'self'` + nonce — refactor inline `style=""` attributes into classes first; `img-src 'self' data:`; `connect-src 'self' ws(s):`; `frame-ancestors 'self'`; `base-uri 'none'`; `form-action 'self'`; report endpoint), API CSP `default-src 'none'`, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera/mic/geolocation off except where used), `Cross-Origin-Opener-Policy: same-origin`, HSTS in production. Mirrors S5, S6, S12.
- P1.2 **Self-host fonts** (Inter, Barlow Condensed) so CSP needs no third-party origins.
- P1.3 **CORS**: explicit origin allowlist from config; 403 on foreign preflight; expose only `X-Csrf-Token, Etag`. Mirrors S4.
- P1.4 **Sessions**: `__Host-` cookie, `Secure` in production, `SameSite=Lax` (Strict for admin), session ID rotation on login/MFA/privilege change, idle timeout + absolute lifetime, "log out all devices", device/session list in Account; login CSRF (pre-session token).
- P1.5 **Login hardening**: per-account and per-IP exponential backoff, lockout notifications, uniform error timing, password policy (length ≥ 12, breached-password check against a bundled k-anonymity list), scrypt parameters reviewed (or argon2id via a vetted package), no default admin password (first-run admin setup from environment/CLI).
- P1.6 **Step-up verification** for sensitive actions — MFA disable, withdrawals, API-key creation, email change — mirrors `action_verification_mfa` (S9).
- P1.7 **Authorization matrix tests**: for every route, anonymous / user / other-user / each admin role → expected status (catches IDOR and privilege bugs).
- P1.8 **Input/output safety**: central validation schemas, body size limits per route, output encoding audit (no `innerHTML` with user content anywhere — lint rule), safe link rendering.
- P1.9 **Idempotency keys** on order placement, deposits, withdrawals, transfers (Kalshi allows `Idempotency-Key`, S4).
- P1.10 **Bot management**: tiered rate limits (anonymous / user / API key / admin), a self-hosted proof-of-work JS challenge for suspicious HTML traffic (challenge cookie bound to IP + UA hash, short TTL), a signed client token required on API + WS like S2, honeypot paths (`/.env`, `/.git/*`, `/wp-admin`, `*.map`) that return 404 and raise an alert, `robots.txt` + AI-crawler policy (advisory only).
- P1.11 **Asset hygiene**: build step with content-hashed, minified assets and long-lived immutable caching; no source maps in production (S3).
- P1.12 **Sensitive-path denial**: never fall through to the SPA for dot-files, server paths or data extensions; serve only an explicit static allowlist.
- P1.13 **Repo and agent guardrails**: `.claude/settings.json` permission deny rules (`Read(./.env*)`, `Read(./clone/data/**)`, `Read(**/*.pem)`, `Read(**/*.key)`, production config paths), `gitleaks` pre-commit and CI secret scanning, `.env.example` only, CODEOWNERS on security-sensitive files.
- P1.14 **Security logging**: auth events (login ok/fail, MFA, lockout, session revoke), admin actions (already audited), rate-limit and challenge hits; tamper-evident (hash-chained) audit log.
- P1.15 **Data protection**: encrypt TOTP secrets and other sensitive columns at rest (key from environment), backups encrypted, PII minimisation in logs.
- Exit: header/CORS/cookie checks pass in automated tests; OWASP ZAP baseline scan clean of high/medium; authz matrix 100% green; threat model (STRIDE) for auth, trading, payments, admin written into `SECURITY.md`.

### Phase 2 — Social and community completion (M)
- ✅ Event live chat (§20). Remaining: reactions, message editing.
- P2.1 Post extras: attach a position tag ("Yes · outcome · market"), share links, ⋯ menu (report — partly done — mute, copy link), "Read more" truncation, edit window.
- P2.2 GIFs: self-hosted, moderated sticker set first (no third-party key); an external GIF provider later behind a server proxy with content filtering.
- P2.3 Keyword and market follows, profile search, timeline counts, badges (earned rules).
- P2.4 Notification preferences and price-movement subscriptions (per-channel toggles).
- Security gate: abuse controls (rate limits, spam heuristics, report/ban paths), XSS tests on every new text field, moderation audit.

### Phase 3 — Accounts, identity and compliance (L)
- P3.1 Identity onboarding exactly as observed (spec §13.14): full-screen flow with a segmented progress bar, steps **phone code → legal name → date of birth (18+) → address + country-specific national ID → "Verifying info…" → outcome (approved / manual review / rejected / retry)**, "Not now" skip with resume, persisted progress per step, trading and deposits gated until approved. Plus email verification and password reset (signed single-use tokens, short expiry) via an SMTP abstraction with a local dev mailbox.
- P3.1a **Personal data protection** (blocking for P3): field-level AES-GCM encryption for legal name, date of birth, address and national ID; national ID stored encrypted plus a keyed hash for duplicate detection, **never returned in full** (last 2–4 digits only), never logged, excluded from telemetry and audit payloads; country-specific format validation; support role sees masked values and every unmasked view is audited; `autocomplete="off"` on ID fields; retention/deletion policy; age check server-side.
- P3.2 Phone verification with **4-digit codes** (spec §13.9/§13.14): E.164 validation, an SMS provider abstraction (dev stub shows codes in a local outbox), code expiry ~10 min, max attempts, resend cooldown, per-number/per-IP/per-country send limits (SMS-pumping fraud protection), codes stored hashed.
- P3.3 OAuth sign-in (Google/Apple) with PKCE and state, account linking rules.
- P3.4 Passkeys (WebAuthn) registration/authentication; passkey-required option for admins (S9).
- P3.5 Identity verification (KYC) through a provider interface with a sandbox adapter; status gating on deposits/trading.
- P3.6 Geolocation compliance: allowed-region policy using IP + browser geolocation, re-checked on sensitive actions, clear blocked-state UX (mirrors S10; simulated provider).
- P3.7 Fraud signals: device fingerprint hash, velocity rules, risk score feeding withdrawal holds (mirrors S10).
- P3.8 Privacy: data export, account closure, retention policy.
- Security gate: token handling review, account-takeover scenarios tested (reset-link reuse, OAuth linking, SIM-swap-style phone change requires step-up).

### Phase 4 — Payments, sandbox only (L)
- P4.1 Deposit/withdrawal rails through provider abstractions: card and bank (test mode), crypto (testnet). No real money in this project.
- P4.2 Withdrawal MFA (S9), holds, limits, AML rule hooks, reconciliation job between provider records and the ledger; double-entry ledger audit.
- Security gate: webhook signature verification, replay protection, idempotency, no PAN/bank data stored (tokens only), PCI scope minimised.

### Phase 5 — Markets and content (M–L)
- P5.1 Sub-cent price structures (`tapered`, `deci_cent` grids) with fractional quantities.
- P5.2 Scalar/escalator markets, sports derivatives (spreads, totals), ice-hockey league, calendar `event_limits` grouping.
- P5.3 Ballot lookup ("What's on your ballot?") with invented or properly licensed civic data.
- P5.4 AI news summaries/timeline from the platform's own news items (LLM API behind the server, cached, citations, safety filtering, cost caps).
- Security gate: market-creation permissions, resolution integrity (two-person rule option), prompt-injection handling for AI summaries.

### Phase 5C — Content management (CMS) for everything user-facing (L)
Owner requirement (2026-11-04): every frontend value, text, image, notification and email template is managed in the
admin panel; only technical configuration stays in code. Runs after the Naira and PWA branches merge and before Phase 6,
so later phases build on it.
- C.1 **Text catalog:** every UI string is a keyed entry with a code default; admin overrides in Admin › Content › Texts
  (search by page and section, in-context preview, typed variables such as `{amount}`, plain text or sanitised rich text,
  locale-ready, default `en-NG`).
- C.2 **Media library:** upload and replace logo, favicon and PWA icons, hero and promo art, category and hub images,
  email header. Server-side re-encode (metadata stripped, type checked), no SVG uploads, size limits, slots per usage.
- C.3 **Notification and email templates:** in-app title and body, push, email subject plus HTML and text bodies, SMS,
  per notification type; shared email layout (header, footer, legal); preview with sample data; test-send to the dev
  mailbox.
- C.4 **Pages:** terms, privacy, responsible trading, help and FAQ, incentive terms, footer links; slugs, SEO title and
  description, scheduled publishing.
- C.5 **Branding and values:** brand and YES colours (contrast-checked), logo and app name (drives the PWA manifest),
  alongside the existing settings, payments and Currency & defaults panels.
- C.6 **Governance:** editor and publisher roles; draft, preview, publish, schedule; version history and one-click
  rollback; hash-chained audit; step-up for legal pages; live updates without restart; JSON export and import.
- C.7 **Enforcement:** a test that fails when user-facing text is hard-coded in views (like the §27 token check).
- Security gate: all CMS content escaped or sanitised (allowlist), no raw HTML or script, logic-free templates with
  declared variables only, upload validation and re-encoding, permission checks, rate limits.

### Phase 5D — Admin feature flags (M–L)
Owner requirement: every feature and module can be switched and rolled out from the admin panel; runs after Phase 5C.
- Admin › Feature flags with a flag for every feature and module: trading mechanics, combos/RFQ, perps, sports, social
  and chat, payments per rail, identity and sign-in methods, AI summaries, ballot, incentives, hubs, notification
  channels, PWA, currency switch.
- Each flag: on/off, percentage rollout, allow/deny by user, role or region, schedule, kill switch.
- Server enforcement: `feature_disabled` on routes, jobs paused. Client: UI hidden.
- Live via WS; audit, reason and step-up; change history.
- Env vars stay only as technical overrides.
- Tests: switching a flag off hides the UI and blocks the API; rollout, region and schedule work; persistence; an
  enforcement test that fails when a feature lacks a flag.
- Built on `phase-5d` (CLONE_SPEC.md §33), with the owner-approved scope extension below:
  - **D.1 Flags** (`server/flags.js`): 51 flags in 11 groups with parents; evaluation order override → kill → on/off →
    schedule → legacy switch → parent → deny → allow → regions → rollout (SHA-256 bucket per flag and user); gate on
    `/v1` before every router (`feature_disabled`, authorization errors first, staff sign-in bypass); handler and pipeline
    checks; 13 job flags paused while off; booleans-only bundle with live `feature_flags` nudges and schedule boundaries;
    Admin › Feature flags (reason, step-up, history, hash-chained audit, kill switch); `FEATURE_FLAGS` technical
    override; enforcement scan of routes, rules, `mount*` modules and `[data-flag]` hooks.
  - **D.2 Play mode** (`server/play-mode.js`): master switch with the real-money reverse guard; trigger-stamped money
    mode and epoch on every ledger row and journal entry, with audit checks; signup bonus (minted or from the vault);
    free play deposits with a daily cap and every real rail unreachable; withdrawals refused on every path; banner and
    labels (CMS texts).
  - **D.3 Switch to production**: preview with exact counts and totals; request with typed RESET and step-up; approval
    by a second admin with RESET; `VACUUM INTO` backup; one transaction archiving and zeroing balances, positions, perps,
    escrow, advances and the vault, canceling customer orders; idempotent; notices and live updates.
  - **D.4 Central Bank and Vault Heist** (`server/central-bank.js`, `/heist`): vault funding with reason and step-up,
    live balance; Mastermind heist with an encrypted server-side code, timer, tries, alarm, loot formula and caps,
    security level with decay, jail, daily limit, idempotent starts and guesses, rate limits, live feed and Most Wanted;
    concurrency-safe payouts; test-only RNG option.
  - **D.5 Money controls and treasury**: site-wide deposit / withdrawal flags; per-user revocation with a reason the user
    sees, on every rail, live and audited (Admin › Users); the Central Bank as the promotions treasury in production
    (bonus credits, incentive rewards, referral credits; queue or refuse when empty; FIFO payout when funded).
  - Suites `flags` (8 scenarios) and `playmode` (8 scenarios); authz matrix extended.

### Phase 6 — Perps completion (M)
- P6.1 Amend/decrease, order groups, subaccounts and transfers, trailing stops.
- P6.2 Size-tiered margin and the portfolio maintenance-margin model; fractional perps.
- P6.3 APY on perps collateral, rewards/referrals, waitlist access.
- Security gate: liquidation and funding invariants under property-based tests; risk-limit enforcement.

### Phase 7 — Public trading API (L)
- P7.1 API keys with RSA-PSS / Ed25519 signed requests (timestamp + method + path), scopes, per-key rate tiers, key rotation and revocation; step-up to create keys.
- P7.2 Batch orders, order groups, historical data endpoints, public WebSocket `/trade-api/ws/v2` with authenticated private channels.
- P7.3 **Developer portal**: Account › API keys page (create with step-up, label, scopes read/trade, IP allowlist optional, show private key once / accept user-supplied public key, rotate, revoke, last-used), generated OpenAPI 3 + AsyncAPI docs served at `/docs` with try-it against a **demo environment** (separate DB, fake money), quick-start guides and code samples (curl, Python, JavaScript) for signing requests, rate-limit tiers and usage dashboard, changelog and deprecation policy, status page.
- P7.4 API parity checklist against the public Trade API v2 reference (markets, events, series, orderbook, trades, candlesticks, portfolio balance/positions/orders/fills/settlements, order create/amend/decrease/cancel/batch, order groups, RFQ/quotes, multivariate collections, WebSocket channels) with contract tests generated from our OpenAPI spec.
- Security gate: signature replay window, clock-skew handling, key storage (public keys only), abuse throttling.

### Phase 7A — Waitlists: Perps on, real-money launch waitlist and newsletter (S–M)
Owner decisions 2026-11-08: the Phase 6 and 7 design choices are confirmed as built (`CLONE_SPEC.md` §34.13, §35.14); the Perps waitlist is **on**; and a **real-money launch waitlist** gauges demand while the site runs in play mode. The owner will announce: "join the waitlist for the newsletter on the real-money launch". Once N people have joined, the owner decides to switch to real money: play mode off and the Central Bank off, through the existing two-person production switch (§33).
- **P7A.1 Perps waitlist on:**
  - `perps.waitlist` is enabled by default for new databases, and an existing database is switched on once by an audited migration, with the reason "owner decision 2026-11-08";
  - the test servers that need open Perps say so explicitly; no assertion is weakened.
- **P7A.2 Launch waitlist:** a reusable waitlist module. The Perps waitlist moves onto it unchanged in behaviour; a list is a key (`perps`, `real_money_launch`).
  - **Who can join:**
    - signed-in users with one click;
    - guests with an email and **double opt-in** (a confirmation link, expiring, single use).
  - **Consent and privacy:**
    - consent is recorded with time, wording version and source, following the Nigeria Data Protection Act 2023;
    - every email carries a one-click unsubscribe, and users can delete their data;
    - no duplicates; rate limits and bot protection on the guest form; email addresses are encrypted at rest, with a hash for lookups.
- **P7A.3 Opinion survey (optional, short, admin-defined through the CMS):** example questions:
  - would you trade with real money?
  - expected first deposit, in naira bands;
  - preferred payment method (bank transfer, card, USSD, wallet);
  - which markets interest you;
  - a free-text comment, moderated.
  Answers can be edited until launch; results appear as aggregates only.
- **P7A.4 Public side:**
  - a "Join the real-money waitlist" call to action in the play-mode banner, on Funds and on Home;
  - a `/waitlist` page with the CMS pitch text, the survey and the user's status;
  - an optional public progress bar ("N of TARGET joined"), which an admin can switch on or off.
- **P7A.5 Admin › Waitlists:**
  - **Per list:** the count, confirmed vs pending, daily growth, sources (UTM or referral code), the target N and survey results.
  - **Export:** CSV with consent fields only, behind step-up and audited.
  - **Approve or invite:** for the Perps list.
  - **Newsletter:** a CMS template with preview and test send, sent now or scheduled, through a throttled, persisted outbox that resumes after a restart. Members who unsubscribed or never confirmed are skipped.
  - **Target reached:**
    - the admins get a one-time alert (in-app and email);
    - the Play mode page shows "launch target reached";
    - the switch itself stays the manual, two-person, RESET-confirmed production switch. **Nothing switches automatically.**
  - **Launch email:** when the production switch runs, admins are offered the "We're live with real money" email to confirmed members. It is never sent automatically.
- **P7A.6 Cross-cutting:**
  - flags `waitlist.launch` (on), `waitlist.launch.public_count`, `waitlist.launch.survey`, `newsletter`;
  - all copy and emails in the CMS; DB-persistent and survives a restart;
  - authz classification; browser tests for joining (signed in and guest), confirming, the survey, unsubscribing, the newsletter send, the target alert and the restart;
  - `CLONE_SPEC.md` §36 (the elections hub becomes §37);
  - the production switch keeps waitlist members, consents and survey answers (they are not money).

### Phase 7B — Elections hub v2, Nigeria first (M–L)
Owner request 2026-11-08: a results-night elections hub modelled on the observed midterms page (`CLONE_SPEC.md` §13.20), adapted to Nigeria and built on the country model (ground rule 5). It replaces the Phase 5B tile-map hub (§29.8). That hub's invented 12 states stay as a second test country, proving nothing is Nigeria-specific in code.
- **P7B.1 Country and election model** (DB, Admin › Elections, every change audited with a reason). Each country (`NG` first; currency, time zone, locale) has:
  - **divisions:** for Nigeria, 6 geopolitical zones → 36 states + FCT → 774 LGAs → wards → polling units. Seeded: the zones, states, FCT and LGA counts; ward and polling-unit counts are invented demo numbers per state;
  - **offices and chambers:** President; Senate, 109 seats, 3 per state + 1 FCT; House of Representatives, 360 constituencies; 36 Governors; State Houses of Assembly;
  - **win rules, as configuration:**
    - **President:** most votes, plus at least 25% of votes in at least two-thirds of the states and the FCT. The rule is a configurable check; a runoff follows when no candidate meets it.
    - **Governor:** most votes, plus 25% in two-thirds of the state's LGAs.
    - **Legislative seats:** first past the post.
  - **parties:** name, short name, colour, logo through the CMS media library (§32.2), and an optional coalition;
  - **candidates:** with a photo through the CMS, or initials avatars;
  - **elections:** the general election plus off-cycle governorship elections (Anambra, Bayelsa, Edo, Ekiti, Imo, Kogi, Ondo, Osun).
  - Each race links to one or more markets: "winner?" per candidate or party, chamber control, seat counts, turnout.
- **P7B.2 Live results feed (simulated, like sports §19):**
  - results arrive the way the electoral commission collates them: polling unit → ward → LGA → state → national;
  - each race shows % of polling units reported and votes per candidate and party;
  - for the presidency, a tracker counts the states and FCT where each candidate has reached 25%;
  - an admin **results desk** calls and uncalls races with a reason, with a two-person check for the presidency;
  - a call proposes a settlement through the existing resolution desk (§28);
  - snapshots are persisted for the timeline;
  - the simulator only runs for demo and test, and is behind a flag.
- **P7B.3 Hub page** at `/category/elections/<hub>` (e.g. `nigeria-2027`):
  - **Left sidebar:** All markets · Elections · <hub> · Presidential · Senate · House of Reps · Governorship · Off-cycle · International elections · Referendums.
  - **Tabs:** Overview · Presidential · Senate · House · Governorship · States · My Ballot; plus a "Search states and candidates" box.
  - **Page elements:**
    - **control gauges**, multi-party: the leader's chance and a rating word;
    - **office switch and seat bar:** forecast and current seats per party, with a majority mark;
    - **results map** of the 36 states + FCT, drawn with simple shapes and no imported map assets:
      - solid = called, hatched = projected or leading, with ticks and % labels;
      - a side list for the FCT and small states;
      - a tooltip on hover (desktop) or tap (390 px) with % reported, candidates, vote share, votes, Yes/No and volume;
    - **ratings chart** (Safe · Likely · Lean · Toss-up by the leading party's probability, with "N Settled" ends);
    - **timeline** with play, markers and LIVE, replaying the map, seat bar and ratings;
    - **Featured race cards** (% reported, margin, chances, votes, two-colour bar);
    - **Power Index:**
      - **formula:** admin-defined, from market prices, e.g. ruling party vs opposition strength;
      - **display:** history chart, change over the last 24 h, and "Learn more" text from the CMS;
    - **More markets** table;
    - **floating hub chat** with an online count, reusing §20 chat (moderation, rate limits, slow mode).
  - **My Ballot** uses Nigerian divisions: choose state → LGA → ward. No address is stored (§29.5 rules).
- **P7B.4 Cross-cutting:**
  - every widget gets a flag (`elections.hub`, `.map`, `.results`, `.timeline`, `.power_index`, `.chat`);
  - all copy, labels, rating words and Learn-more text live in the CMS; NGN and WAT throughout; 390 px layouts;
  - live updates over WebSocket;
  - all data is DB-persistent and survives a restart, and the production switch resets play-money positions only;
  - authz classification; browser tests for every widget, the results desk and the timeline;
  - `CLONE_SPEC.md` §37.
- **Security gate:**
  - results-desk calls need a role, a reason and step-up, with the two-person rule for the presidency, all audited;
  - the feed cannot be written by clients;
  - hub chat follows §20 abuse controls;
  - map and tooltip rendering is XSS-safe (party and candidate names come from admins);
  - media goes through the CMS re-encoding.
- **Owner decisions before production:**
  - legal and regulatory review of election markets in Nigeria;
  - the source of real results, whether a licensed feed or manual entry by the results desk;
  - whether real parties and candidates are entered by admins at launch. They are never seeded.

### Phase 8 — Growth and reach, Nigeria first (M–L)
Detailed 2026-11-08. Every item follows ground rule 5: Nigerian defaults, country as data, ready for more countries.
- **P8.1 Referrals for Predictions** (a second program in `server/referrals.js`):
  - codes and share links;
  - rewards paid from the promotions treasury in production, or as play money in play mode;
  - qualification on a volume threshold, never counting trades against the referrer (as for Perps);
  - lifetime caps.
  - **Fraud signals beyond the account:** linkage between referrer and referee by device, payment instrument and IP velocity, using the P3.7 fraud scores; flagged referrals go to an admin review queue.
  - The waitlist's `ref` attribution (P7A.2) carries over at sign-up.
- **P8.2 Share and copy-trade links:**
  - every market, event, position and trade can be shared through a signed, non-guessable link;
  - **WhatsApp first** (the main sharing channel in Nigeria), then X, Facebook, Telegram and copy-link;
  - "Copy this trade" opens the market with the ticket prefilled from the shared position. It shows only what the sharer chose to show (side and price; sizes optional) and **never trades automatically**;
  - attribution and click counts; open-redirect-safe; links can be revoked.
- **P8.3 Public pages for search and social:**
  - **Server-rendered HTML** for public routes (home, categories, events, markets, series, hubs, docs, CMS pages, status), cached per locale and currency, never per user (no cookies in the cache key). The SPA takes over after load.
  - **Metadata:** title, description, canonical URL and `hreflang`.
  - **Share cards:** Open Graph and X cards with server-generated PNG images (price, chance and title; pure-JS encoder, CMS brand colours).
  - **Search engines:** `sitemap.xml` (split per section, last-modified dates), `robots.txt`, and structured data where it fits.
- **P8.4 Languages (i18n)** on the CMS text catalog (§32):
  - locales `en-NG` (default), Nigerian Pidgin (`pcm`), Hausa (`ha`), Yoruba (`yo`) and Igbo (`ig`), with more added as data;
  - **translation workflow in Admin › Texts:** missing keys fall back to English, coverage % per locale, review and publish per locale, export and import for translators;
  - **locale switcher:** stored per user, with a guest cookie;
  - **formatting:** numbers, dates and plurals per locale (`Intl`);
  - **layout:** RTL-ready for future countries;
  - **email and push templates** per locale.
- **P8.5 Accessibility, WCAG 2.2 AA:**
  - automated `axe-core` checks of the key pages in light and dark at 1280 and 390 px, in the test suite;
  - keyboard paths for trading, funds and account;
  - visible focus, 24 px minimum targets, contrast checks on CMS colour changes, reduced motion, and screen-reader labels for charts, the map and gauges (text alternatives);
  - fixes for everything found; an accessibility statement page.
- **P8.6 Built for Nigerian networks and phones:**
  - a **data saver mode** (lighter images, fewer live updates, polling fallback when the WebSocket is unstable, no autoplay);
  - performance budgets for low-end Android on 3G (JS and CSS size, LCP and INP targets) checked in CI;
  - offline-tolerant pages through the PWA (§31);
  - SMS as a notification channel through a simulated provider adapter (a real provider later, behind the same interface).
- **P8.7 Site footer and help centre** (A18): Product · Company · Help columns, social links, Trust · Research · Support · Fee schedule · FAQ. All CMS pages, with Nigerian contact and support-hours content.
- **P8.8 Cross-cutting:**
  - a flag per capability (`referrals.predictions`, `share_links`, `copy_trade`, `ssr`, `i18n`, `data_saver`, `sms`);
  - CMS text; DB persistence;
  - authz classification; browser tests per feature;
  - `CLONE_SPEC.md` §38; README; SECURITY.
- **Security gate:**
  - referral fraud (linkage signals, caps, the review queue);
  - share links are signed and cannot be enumerated or turned into open redirects;
  - server rendering never leaks private data or caches per-user pages (cache-poisoning tests);
  - translated text goes through the CMS sanitizer (no script or markup injection through translations);
  - marketing consent under the Nigeria Data Protection Act;
  - SMS abuse limits.
- **Owner decisions:** the referral reward amounts in naira; the first non-English locales and who translates; whether SMS goes to a real provider before launch.

### Phase 9 — Production readiness (L)
- P9.1 Hosting: container image, reverse proxy with TLS, secrets from the environment/vault, separate admin origin.
- P9.2 Database: move from SQLite to PostgreSQL before multi-instance (SQLite is single-writer); migrations tooling; PITR backups, restore drills.
- P9.3 CDN/WAF in front (managed rules + our P1.10 controls).
- P9.4 Observability: structured logs, metrics, traces, alerting; telemetry scrubbing of IDs and PII (mirrors S11).
- P9.5 Load testing (k6) on order placement, WS fan-out, live sports ticks; capacity plan.
- P9.6 Incident response runbook, external penetration test, vulnerability disclosure policy (`SECURITY.md`).

---

## 4. Research backlog (REA)

All research follows the ground rules (logged-out public surfaces and docs only; your own captures for logged-in pages; no bypassing).

| ID | Question | Method | Needs from you | Feeds |
|---|---|---|---|---|
| R1 | Live chat protocol and UI states (channel names, message shapes, moderation cues) | REA `analyze_javascript_application` on chunks containing chat code; `inspect_web_network_capture` on a HAR | HAR + screenshots of an event with live chat open (logged out is fine) | §20, Phase 2 |
| R2b | Identity onboarding outcome screens (approved / review / rejected), resend timer, country list and per-country ID fields | your screenshots of the remaining steps (blur personal data) | §13.14, P3.1 |
| R2 | Logged-in portfolio tabs: exact columns, empty states, sort/filter | REA `inspect_web_network_capture` with `sensitive_values` redaction | Your logged-in HAR with balances/IDs removed, screenshots | §17 refinements |
| R3 | Account/security pages: sessions/devices list, passkeys flow, MFA step-up prompts | chunk analysis (`passkeys`, `action_verification_mfa`); your screenshots | Screenshots of Account › Security | P1.4–P1.6, P3.4 |
| R4 | Full security header set from a real browser (HSTS, CSP, Permissions-Policy, report endpoints) — per-request token use answered by HAR4 (§13.13) | `inspect_web_network_capture` on an unsanitised-headers HAR | A HAR with response headers kept (cookies stripped) | P1.1 |
| R5 | Bot-management client lifecycle (token fetch/refresh, WS token use) — understanding only, for our own design | REA static analysis of the AWS WAF integration chunk | none | P1.10 |
| R6 | Telemetry/consent: scrub lists, consent banner, analytics opt-out | chunk analysis | none | P9.4, P3.8 |
| R7 | Sports live-data feed and WS updates (`/v1/live_data/*`, milestone channels) | HAR of a live game page + chunk analysis (`useMilestoneLiveData`) | HAR of a live sports page | §19 refinements |
| R8 | Combos builder (`/combos`) real flow and RFQ UI states | HAR + screenshots | screenshots of /combos | §17 refinements |
| R9 | Perps pages (`/perps`) layout and order panel | screenshots + chunk analysis | screenshots of /perps | §14 refinements |
| R10 | Docs drift (new endpoints, deprecations) | weekly diff of `docs.kalshi.com/llms.txt` | none | all |
| R11 | Mobile app API differences (optional) | REA APK analysis of an app you install on your own device | your APK pulled via adb (your device, your decision; check the app's terms) | P7 |
| R12 | Admin tooling | not observable from outside — design choice | none | §18 |

---

## 5. Sequencing at a glance

1. Phase 0 (finish CI) → **Phase 1 security foundation** (blocking)
2. Phase 2 social (live chat already in flight) in parallel with research R1–R4
3. Phase 3 identity/compliance → Phase 4 payments sandbox
4. Phases 5 and 6 in parallel (markets, perps)
5. Phase 7 public API → **Phase 7A waitlists (Perps on, real-money launch waitlist)** → **Phase 7B elections hub v2 (Nigeria first)**
6. Phases 8–9 growth and production readiness, ending with the pen test

---

## 6. Security gate (every phase, before merge to `main`)

- Threat model updated for the new surface (STRIDE notes in `SECURITY.md`).
- Authz matrix tests extended to new routes; IDOR checks with a second user.
- XSS/CSRF/injection tests for every new input; WS messages size-capped and authenticated where private.
- Rate limits and abuse controls on new write paths.
- `npm audit` clean, secret scan clean, ZAP baseline clean (high/medium).
- Audit logging for new privileged actions.
- No secrets, real data or credentials committed; `.claude` deny rules cover any new sensitive paths.
- Spec section updated with evidence and design choices; full E2E suite green.

---

## 7. Known gaps carried from shipped work (must close for 100%)

Each item is tracked to a phase; none may be silently dropped.

| ID | Gap (source) | Phase |
|---|---|---|
| G1 | Sub-cent fee accumulator per the fixed-point docs (fees currently round up to whole cents) (§16) | 5 (with P5.1 sub-cent grids) |
| G2 | Dollars / target-cost orders filled across many makers can exceed the cap by 1–2¢ (§16) | 1 (P1.9 idempotency & order safety pass) |
| G3 | RFQ `rest_remainder` stored but not acted on; `obscure_creator_id` not implemented (§17) | 2 |
| G4 | Daily trading limit not checked for the maker on quote confirm (§17) | 1 |
| G5 | Batch cancel by order-ID list (§17.10) — ✅ closed by Phase 7 (`DELETE /trade-api/v2/portfolio/orders/batched`, §35.5) | 7 (with batch orders) |
| G6 | Resolution reversal after settlement (ledger clawback with audit) (§18) | 5 |
| G7 | Taker fee coefficient editable at runtime; rolling window and rate limits editable live (§18) | 1 (settings) |
| G8 | Four `PUT social-admin/...` moderation endpoints; promo-card targeting (§18) | 2 |
| G9 | Sports: ice-hockey league, live-updating event header label, running clocks for tennis/esports (§19) | 5 |
| G10 | Chat reactions and message editing (§20) | 2 |
| G11 | Perps: amend/decrease, order groups, subaccounts, trailing stops, size-tiered margin, portfolio maintenance margin, fractional perps, collateral APY, rewards/waitlist (§14) — ✅ closed by Phase 6 (§34) | 6 |
| G12 | Combo markets on a finer price grid; combos HVM 3 s confirm window option (§17) | 5 |
| G13 | Inline `style=""` attributes across views block a strict style CSP | 1 (P1.1, tracked refactor) |
| G14 | Logged-in screens verified against real screenshots (Positions/Resting/RFQs/Quotes/History, Account/Security, Deposits) | Research R2–R3, then fixes in the owning phase |

## 8. Definition of "100% complete"

The project is complete only when **all** of the following hold:

1. **Feature parity:** every row of `CLONE_SPEC.md` §12 is "yes" or an explicitly accepted, documented exclusion (real-money payments and real KYC stay simulated/sandboxed by design, since this is a clone, not a licensed exchange). Every §7 gap above is closed.
2. **Spec closure:** every UNKNOWN in §11 and §13–§20 is either resolved by evidence (research R1–R12) or recorded as a design choice with rationale; no "TODO" in the spec.
3. **Logged-in views verified:** screens built against the user-supplied logged-in screenshots (R2, R3) match structure and behaviour; differences documented.
4. **Security:** Phase 1 complete; every phase passed the §6 gate; `SECURITY.md` threat model current; external-style DAST (ZAP) clean of high/medium; dependency and secret scans clean; authz matrix covers 100% of routes.
5. **Quality:** full E2E suite green in CI on every push; no page errors; 390px phone layout clean on every route; light and dark themes; WCAG 2.2 AA audit with no critical issues.
6. **Data:** 100% DB-persistent; migrations forward-only and tested from every released schema; backup/restore drill passes.
7. **Operations:** deployable from a clean checkout with one documented command; health checks, logs, metrics and alerts in place; runbooks for incidents and restore.
8. **Documentation:** README (run, configure, admin bootstrap, Windows notes), `CLONE_SPEC.md`, `PLAN.md` progress table, `SECURITY.md`, API docs.

## 9. Progress tracker

| Phase | Status |
|---|---|
| 0 Stabilise | ✅ done; CI green on `main` (tests, lint, audit, gitleaks, CodeQL, ZAP). Owner action: enable branch protection on `main` requiring the CI checks |
| 1 Security foundation | ✅ done (spec §21–23; 140 E2E tests at the time; 181 across 22 files after Phases 2–3; 187 across 23 with the visual-system suite). Residual risks tracked in §21.11/§22 and §10 below |
| 2 Social completion | ✅ built on `phase-2-3` (CLONE_SPEC.md §24): P2.1–P2.4, A6 notification matrix, A11 (Inner Circle, Group chats, position / trade / leaderboard alerts), G3, G8, G10; `social2.e2e` + `groupchat.e2e` suites |
| 3 Identity & compliance | ✅ built on `phase-2-3` (CLONE_SPEC.md §25): onboarding (email/phone codes, name, birthday, address), KYC sandbox + admin review queue, document verification with phone QR hand-off, encrypted per-user PII, mock Google/Apple sign-in, passkeys, A1–A6 (A2 403 lock), promo codes from A12, location blocking and fraud holds (simulated), data export and account closure, RS2/RS3/RS6/RS9/RS10; `onboarding` + `identity2` + `account-area` suites. Residual: simulated KYC/geo/fraud, no server-side image re-encode, no master-key rotation |
| 4 Payments (sandbox) | ✅ built on `phase-4` (CLONE_SPEC.md §26): observed funds route families with neutral names; sandbox card (isolated tokenizer, token + brand + last 4 + expiry only, invented test numbers, decline / insufficient / challenge, closed-loop payouts), ACH-like bank (link, pending → settled, returns with negative-cash debt, unsettled funds tradable not withdrawable), testnet-style crypto (deposit address, N confirmations, fee, new-address cooling); signed webhooks (HMAC-SHA256 over t.body, 5 min, event-id dedupe, rejections in the security log); double-entry journal hooked in `engine.js` with migration, audit job and admin check; reconciliation queue; withdrawal limits; AML hooks (structuring, rapid in-out, new crypto address) with cases and holds; step-up / withdrawal 2FA on withdrawals and new payout destinations; Idempotency-Key required; non-withdrawable expiring credits; Admin › Payments; `payments.e2e` suite. Residual: simulated providers and loopback delivery, tokenizer in-process (no hosted fields), three rule hooks not an AML programme, conservative credit attribution, single-process SQLite (§26.13) |
| UI visual system overhaul | ✅ built on `ui-overhaul` (CLONE_SPEC.md §27): token scale for type (11 steps with paired line heights), weights 400–700, tracking, 4px spacing and control heights applied to every stylesheet by `clone/scripts/apply-type-tokens.js`; one button/select/input/tabs/stat-card system; one page-title style; fixes for the event header, phone hero and header, Portfolio cards and Settings headings; `visual-system.e2e` suite (token enforcement + layout at 1280/390, dark/light) |
| 5A Trading core | ✅ built on `phase-5a` (CLONE_SPEC.md §28): P5.1 price grids (`linear_cent`, `deci_cent`, `tapered`, combo `center_deci_edge_centi_cent`) stored in centi-cents with fractional quantities through book, matching, validation, ticket, order book, chart and REST/WS; G1 per-order fee accumulator (exact micro-dollar fees, one rounding cent per order, journal split `house:fees` / `house:fees:rounding`); scalar markets (P5.2 core: floor/cap payout, floored per holder, rounding to the house, desk value entry, seeded `PLXGDP-26Q4`); A7 order review (skippable) and auto-sell prompt; A8 flip sell; A9 MECNET collateral return journaled as an advance; G6 settlement correction with claw-back, Phase 4 debt rule, step-up, audit chain and notifications; two-person rule; market-creation permissions; G12 combos on the finer grid and the HVM 3 s window; `trading-core.e2e` suite (10 scenarios). Residual: tick bands and the tapered name are design choices, conservative MECNET guarantee, corrections do not cascade into combos (§28.11) |
| 5 Markets & content | pending |
| 5B Markets & content | ✅ built on `phase-5b` (CLONE_SPEC.md §29): P5.2 sports derivatives (spread and total events per game, Monte Carlo fair values from the game's own simulation, settled from the final score), G9 (Icebound Hockey League with periods, power plays, OT and shootout; running clocks for every sport incl. tennis match time and esports map time; live event header label), calendar `event_limits` with "+N more" (U16 resolved as a design choice), P5.3 ballot lookup on invented jurisdictions (no address stored; only a saved jurisdiction id; rate limited), P5.4 AI news summaries + timeline (offline extractive default with citations; optional Claude adapter only with `ANTHROPIC_API_KEY` + `AI_SUMMARY_MODEL`; cache by news-set hash; daily request/token budget with extractive fallback; delimited input, validated output, blocklist; admin hide/regenerate audited and rate limited), A13 Liquidity Incentive Program (programs, Active/Upcoming, monthly/lifetime rewards, region gating, terms, accrual formula from resting liquidity, cash/credit payouts through the journal, admin), A15 hub widgets (Senate map, Fed funds outlook, event forecast history); `markets-content` suite (8 scenarios). Phase 5A items (sub-cent grids, fee accumulator, scalar markets, order review, flip sell, collateral return, resolution reversal, combos) are on `phase-5a` |
| 5C Content management (CMS) | ✅ built on `phase-5c` (CLONE_SPEC.md §32; owner requirement 2026-11-04): content store with drafts, staff-only preview, publish, scheduled publish (resumes after restart), versions and one-click rollback, hash-chained audit with reasons, step-up for legal pages, live updates over the public `content` channel, JSON export / import with a dry-run diff; editor (`content.write`) and new publisher (`content.publish`) roles; C.1 text catalog (4,000+ keys: every SPA string extracted into keyed modules, server keys, `error.<code>`, declared and typed variables, plain or allowlist rich text, ETag bundle, Admin › Texts with search, page / section filters, history and in-context preview); C.2 media library (magic-byte PNG/JPEG only, polyglot and SVG refusal, server-side re-encode, icon sizes, slots driving logo, favicon, manifest icons, promo / hub art, category icons, email header, empty states); C.3 templates on every send (in-app, push, email text + HTML with a shared layout, SMS code, push test; preview and test send); C.4 pages (legal, help, info; SEO; footer); C.5 branding (contrast-checked brand / YES colours per theme via CSS variables, app name and short name in the manifest and meta tags; hub links the settings panels); C.7 `parlance/no-hardcoded-text` in lint and tests; `cms` + `cms-content` suites (10 scenarios). Residual: most server API error wording is overridable only through client `error.<code>` keys; one locale configured; media in SQLite (§32.12) |
| 5D Feature flags | ✅ built on `phase-5d` (CLONE_SPEC.md §33; owner-approved scope 2026-11-04): DB-backed flag for every feature and module (on/off, kill switch, percentage rollout, allow / deny by user, role and region, schedule) enforced by a server gate (`feature_disabled`), jobs paused, UI hidden live with a CMS "not available" state, Admin › Feature flags with reason, step-up, history and audit, `FEATURE_FLAGS` technical override, route / module enforcement scan; play mode (master switch with the real-money reverse guard, trigger-stamped money mode and epoch, signup bonus, free deposits with a daily cap, withdrawals refused everywhere, banner and labels); two-person switch to production (preview, RESET, backup, archives, zero balances, idempotent); Central Bank vault and Vault Heist (server-side encrypted code, Mastermind feedback, timer, alarm, loot caps, security level, jail, limits, feed, Most Wanted, concurrency-safe); per-user deposit / withdrawal revocation and site-wide switches; the Central Bank as the promotions treasury; `flags` + `playmode` suites (16 scenarios). Residual: per-process flag cache and rate limits, unencrypted backup file in the data directory, simulated region data (§33.13) |
| Currency & defaults (NGN) | ✅ built on `naira` (CLONE_SPEC.md §30): NGN display default (a contract pays ₦100, 1 internal cent = ₦1, kobo on sub-cent grids, perps ×100), display-only (engine, ledger, journal, DB and API unchanged); `GET /v1/exchange/display_currency`; DB-backed currency, locale and time zone switched live over WebSocket; Admin › Settings › Currency & defaults (preview, reason, step-up, hash-chained audit) with new-account defaults (theme, order review, flip sell, market preview, notification channels); one formatter per side for views, toasts, notifications, emails, memos, errors, CSV and PDF; calendar days in the configured zone; keyed wording modules for Phase 5C; `currency` suite (7 scenarios). Residual: past notifications and memos keep the wording of their time; limits and reports stay on UTC days |
| PWA | ✅ built on `pwa` (CLONE_SPEC.md §31; tracked here at the owner's request): web app manifest (standalone, brand theme colour, shortcuts to Markets / Portfolio / Deposit) with own icons drawn by `clone/scripts/make-icons.js`; service worker versioned by the build hash that precaches only the public hashed assets (fetched without credentials), never caches navigations, `/v1`, `/trade-api` or the WebSocket and passes everything else through untouched; static offline page under its own strict CSP; "New version available — Reload" toast with user-confirmed `skipWaiting`; "Install app" in the ☰ menus (`beforeinstallprompt`, iOS Add-to-Home-Screen steps, hidden when standalone); caches and this browser's push subscription cleared at sign-out; real Web Push for the Push channel (VAPID RFC 8292 keys encrypted at rest, aes128gcm RFC 8291 with `node:crypto` only, subscriptions API with an https + push-service allowlist, device list with test send and remove, persisted encrypted outbox with backoff, 404/410 cleanup, resumable after restart); CMS-ready content: every PWA string keyed in `public/js/content/pwa-strings.js` / `server/content/pwa.js`, the offline page rendered from them at build time, the manifest built from one config object (§31.12); `pwa` suite (9 scenarios, production bundle, local fake push service). Residual: at-least-once delivery, lock-screen text, VAPID key tied to the master key (§31.11) |
| 6 Perps completion | ✅ built on `phase-6` (CLONE_SPEC.md §34): P6.1 order amend (replace in one transaction) and decrease (in place), order groups (limit groups capped during matching, OCO, group-level cancel, reset, limits), subaccounts (isolated or cross) with transfers between them and with Predictions cash, server-side trailing stops (persisted watermark, fires once on a gap); P6.2 size-tiered margin (bracketed IM/MM per market, editable in Admin › Perps ops; tier 1 = max leverage, last cap = max position), portfolio maintenance margin with largest-first liquidation, fractional perps on integer units (one-time migration), risk limits (leverage per tier, max position with resting orders, open orders per market / total, subaccounts, order groups); P6.3 APY on collateral (accrual job, treasury queue / refuse, play money in play mode), Perps referrals in a reusable `server/referrals.js`, waitlist gate in the flag gate with Admin approve / bulk invite / revoke and CMS notifications and emails; a double-entry perps journal in centicents joined to the ledger audit; 9 flags under `perps`; production switch archives and zeroes the new balances; security gate: property-based liquidation and funding invariants (`tests/lib/property.js`) and API risk-limit tests; suites `perps-trading`, `perps-risk`, `perps-growth`, `perps-invariants` (24 scenarios). Residual: discrete trigger and liquidation evaluation, the liquidity account as the only liquidation counterparty, per-process throttles (§34.14) |
| 7 Public API | ✅ merged to `main` 2026-11-08 (1844923); built on `phase-7` (CLONE_SPEC.md §35; parity in `API_PARITY.md`): P7.1 API keys (Account › API keys with the A2 lock and step-up; RSA-2048 generated and shown once, or pasted RSA / Ed25519 public keys; scopes read / trade / perps; CIDR allowlists; expiry; rotation with an admin-set grace; revocation signing WebSocket and FIX sessions out; usage dashboard; CMS notifications and emails), signed requests (`PARLANCE-ACCESS-*`, RSA-PSS SHA-256 salt 32 or Ed25519, 5 s / 1 s window with clear skew errors, persisted replay store, dummy-key verification, locked / frozen / closed owners refused, 403 scope / IP), rate tiers Basic / Advanced / Premier / Prime (token buckets, endpoint costs, `/account/limits`, `/account/endpoint_costs`, 429 + Retry-After, RateStore interface for RS1), Admin › API keys; P7.2 `/trade-api/v2` (orders through the same `/v1` gates, batch create / cancel with per-item results (G5), amend, decrease, order groups, history with cursors, RFQ, multivariate, Perps under `/margin`), public WebSocket `/trade-api/ws/v2` and `/margin` (channels, commands, seq, caps, heartbeat, revocation); P7.3 developer portal `/docs` (CMS-seeded prose, search, theme, agreement, generated OpenAPI 3.1 / AsyncAPI 2.6 / FIX tables from one registry, browser-signed Try it on an in-process demo environment behind `/demo-api`), status page with admin incidents; P7.4 contract tests over every operation; A16, A17 FIX 4.4 gateway (signed logon, sequence recovery, order entry, market data, RFQ, drop copy, admin disconnect); 7 flags; suites `api-keys`, `trade-api`, `fix`, `dev-portal`, `api-contract` (23 scenarios) + authz. Residual: per-process buckets and caps (RS1), FIX without TLS, demo in-process (§35.15) |
| 7A Waitlists (Perps on, launch waitlist, newsletter) | ✅ built on `phase-7a` (CLONE_SPEC.md §36; owner decisions 2026-11-08): P7A.1 `perps.waitlist` on by default, a one-time audited migration (reason "owner decision 2026-11-08", meta marker, never re-enabled after an admin "off"), test servers that trade Perps as new users opt out explicitly with the new start option `flags: { defaults: { 'perps.waitlist': false } }` (perps, perps-trading, perps-risk, perps-growth, perps-invariants, authz, idempotency, payments, playmode and the Phase 7 harness; the demo environment too); P7A.2 reusable `server/waitlists.js` (the Perps list moved onto it unchanged, `perp_waitlist` kept as a view), one-click join for verified account emails (unverified accounts get the guest double opt-in), guest double opt-in (hash-only, single-use, 48 h links), NDPA consent records, encrypted guest emails with a keyed hash, one-click unsubscribe + RFC 8058 headers, leave / delete, export and closure, UTM and referral sources, linking once the account email is verified, rate limits, honeypot, client token, login CSRF, no enumeration; P7A.3 survey as CMS `survey` entries (single, multi, naira band, moderated free text; seeded with Nigerian payment methods), editable until the launch; P7A.4 CTAs on banner / Funds / Home, `/waitlist`, confirm / manage / unsubscribe pages, optional progress bar, 390 px; P7A.5 Admin › Waitlists (counts, growth, sources, target + one-time alert in-app and email, Play mode note, public-count toggle, survey results and moderation, question editor, consent CSV with step-up, newsletter preview / test / now / scheduled through a throttled persisted outbox, launch email offered after the switch, never automatic); P7A.6 flags `waitlist.launch`, `waitlist.launch.public_count`, `waitlist.launch.survey`, `newsletter`, CMS wording and templates, authz classification with IDOR probes, `waitlists` suite (15 scenarios). Residual: an inbox owner who confirms a link an impostor account requested links the entry to it, per-process limits and outbox (RS1), at-least-once newsletter delivery (§36.9) |
| 7B Elections hub v2 (Nigeria first) | ✅ built on `phase-7b` (CLONE_SPEC.md §37; owner request 2026-11-08, spec §13.20, §30.0): P7B.1 country model in the DB (countries, divisions NG zones → 36 states + FCT → 774 LGAs → wards → polling-unit counts, offices and chambers with win rules as configuration — the presidency's 25 % in two-thirds of the states and the FCT, governors' 25 % in two-thirds of the LGAs, first past the post — invented multi-party parties with coalitions and CMS logos, candidates with photos or initials, the general and the 8 off-cycle governorship elections, races linked to engine markets) managed in Admin › Elections with audited reasons, and the invented Harbor states as a second country with no code branches; P7B.2 deterministic simulated feed counted by LGA and collated to state and national, % reported, the 25 % tracker, results desk call / uncall / runoff with role, reason and step-up, two-person presidency, settlements proposed through the resolution desk, snapshots, simulator flag off by default, live over the `elections` channel; P7B.3 hub at `/category/elections/<hub>` (sidebar, tabs, search, gauges, seat bar, hexagon map with tooltips on hover and tap, ratings, timeline replay, featured cards, Power Index with an admin formula, More markets, floating hub chat on §20, My Ballot by state → LGA → ward); P7B.4 flags `elections.hub`, `.results_map` (not `.map`: the perimeter honeypot swallows paths ending in `.map`), `.results`, `.timeline`, `.power_index`, `.chat`, `.simulator`, CMS copy, NGN / WAT, 390 px, restart test, election data kept by the production switch, authz + IDOR, `elections` suite (13 scenarios). Residual: per-process simulator and throttles, demo forecast model, counting stops at the LGA (§37.7) |
| 8 Growth & reach (Nigeria first) | planned 2026-11-08 (P8.1–P8.8) |
| 9 Production readiness | pending |
| Research R1–R12 | R4 partly answered by HAR4 (logged-in request headers, spec §13.13); R2/R3 still need logged-in captures of Portfolio (all tabs), Account › Security, deposits/withdrawals and placing an order |

## 10. Residual security items after Phase 1 (tracked)

| ID | Item | Phase |
|---|---|---|
| RS1 | Rate-limit and lockout state is per process; move to a shared store before running several instances | 9 (with Postgres/Redis) |
| RS2 | Targeted lockout of a known email for up to 15 min (accepted trade-off; add CAPTCHA-free proof-of-work on repeated failures) | 3 |
| RS3 | TOTP code reuse inside its 30 s window; store last-used step per user | 3 |
| RS4 | Encryption-key rotation (versioned key IDs, re-encrypt job) | 9 |
| RS5 | Audit-chain head anchoring outside the DB (periodic signed checkpoint to logs/object storage) | 9 |
| RS6 | Real email/SMS delivery (stubs today) | 3 |
| RS7 | scrypt cost N=2^16 by default; raise to ≥2^17 in production config | 9 |
| RS8 | Host-header based origin on local dev (DNS rebinding); require `ALLOWED_ORIGINS` in production | 9 |
| RS9 | Admin module answers `account_locked` before password check (account-existence signal) | 3 |
| RS10 | Background polling keeps sessions from idling out; count only user-initiated activity | 3 |
| RS11 | ZAP baseline first runs in CI (needs Docker); triage its findings | 0/CI |

## 11. Scope added from the 2026-11-03 logged-in screenshots and captures (spec §13.15–§13.19)

Every item below is part of "100% complete" (§8) and is assigned to a phase.

| ID | Item (evidence) | Phase |
|---|---|---|
| A1 | Document verification: intro "Let's get you verified", cross-device **QR handoff** (locally generated single-use, short-lived, session-bound URL), phone capture of ID front/back + selfie, desktop "Stay on this page / Uploading your documents… / Exit identity verification", encrypted uploads, same-device fallback (§13.15) | 3 |
| A2 | Lock passkeys, sign-in methods and API keys until KYC is approved, plus step-up; same 403 envelope (§13.19) | 3 |
| A3 | Account area frame `/account/*` with the right-hand card nav (Account & security · Your activity · Documents · Settings); ☰ menu (Leaderboard, Rewards, Account & security, Your activity, Invest, Liquidity Rewards, Documents, API Docs, Settings, Trust ▾, Research ▾, Support ▾, Enter promo code, Log out); trophy icon; category-index icon (§13.16) | 3 |
| A4 | Your activity: chips All/Deposit/Withdrawal/Order/Trade/Settlement/Credit, CSV download, empty state (backed by History) (§13.16) | 3 |
| A5 | Documents (`/account/taxes`): yearly P&L with/without fees, transactions download, simulated tax-form statements per year, "not tax advice" (§13.16) | 3 |
| A6 | Settings, in observed order: display mode (Payout and odds / Shares and prices) with live preview card; Connected apps (OAuth grants list/revoke); full **notification matrix** (General, Predictions, Sports, Social incl. Inner Circle and Group chats, Promotional) × In-app/Email/Push; marketing-text opt-in with SMS disclosure and recorded consent (timestamp, text version); security-notifications toggle; Theme System/Light/Dark + Accessible colors (red-green safe palette); Trade mechanics (Flip sell, Auto-sell prompt after buy, Skip order review, Collateral return, RFQ opt-in with terms, Advanced shard settings); Market preview price type (Last traded / Current buy) (§13.16) | 2 (notifications), 3 (frame, display, theme, consent), 5 (trade mechanics) |
| A7 | **Order review step** before placing (skippable via setting) and **auto-sell prompt** after a fill (§13.16) | 5 |
| A8 | **Flip sell** (selling more than held buys the other side) (§13.16) | 5 |
| A9 | **Collateral return** for hedged positions: release collateral early on mutually exclusive events (`collateral_return_type: MECNET`) (§13.13, §13.16) | 5 |
| A10 | **Exchange shards** and balance transfers between shards (`exchange_shard`, "Advanced shard settings") (§13.16) | 9 (with multi-instance architecture) |
| A11 | Social: **Inner Circle** (request/accept close-friends circle), **Group chats**, Position alerts, Likes/comments/follows notifications, Leaderboard push (§13.16) | 2 |
| A12 | **Rewards**: new-user checklist (4 steps), referrals (code, offer, eligibility progress, lifetime cap, pending/completed/expired), promotions with progress (e.g. Perps new-user trade incentive), **promo-code entry** (§13.19) | 8 (referrals), 3 (checklist, promo codes) |
| A13 | **Liquidity Incentive Program** (`/incentives`): programs per event with start/end, competition level, reward pool, Active/Upcoming tabs, monthly and lifetime rewards, region gating, terms; reward accrual per the public incentives docs (§13.17) | 5 |
| A14 | Perps access: **waitlist / beta gate** (join, share, application, unlock), personalised ticker ranking, credit long/short leverage estimates, daily volatility, liquidation mark price, sparkline API, index feeds (§13.19) — waitlist / beta gate ✅ (§34.9); ranking, sparkline API and the share / application steps remain | 6 |
| A15 | Hub data widgets (Senate map, Fed funds outlook) and event-level forecast history (§13.19) | 5 |
| A16 | **Developer portal** structure: Welcome · Quick Start · Concepts · Predictions APIs · Perps APIs · Changelog; search; Developer Agreement; REST + WebSocket + **FIX** for both products (§13.18) — ✅ closed by Phase 7 (§35.9) | 7 |
| A17 | **FIX gateway** (simulated FIX 4.4/5.0SP2 subset): logon/session with API-key auth, order entry, order groups, market data, RFQ, **drop copy**; documented per the public FIX pages — ✅ closed by Phase 7 (§35.8; FIX 4.4 only, groups joined by tag 20004) | 7 |
| A18 | Site footer (Product / Company / Help columns, social links) and help-centre pages (Trust, Research, Support, Fee schedule, FAQ) (§13.16) | 8 |
| A19 | **Results-night elections hub** (owner screenshots 2026-11-08, §13.20): sidebar and tabs, control gauges, seat bar, results map with called/projected states and tooltips, ratings swingometer, timeline replay, featured race cards with % reported and margin, Power Index, More markets, hub chat; adapted to Nigeria and N parties (§30.0) | 7B — ✅ built in Phase 7B (§37) |
