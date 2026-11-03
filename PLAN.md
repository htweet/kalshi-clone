# Parlance Exchange — phased build, research and security plan

Status date: 2026-11-03. Covers everything not yet built, everything still to research (with REA), and the security work that runs through every phase. Companion documents: `CLONE_SPEC.md` (§1–§19 behaviour spec; §20 live chat when it lands) and `clone/README.md`.

**Ground rules for every phase**
1. **Security first.** Phase 1 (security foundation) must ship before any feature phase that touches money, identity or user content. Every later phase passes the security gate in §6.
2. **Clean room.** Build from observed behaviour and public docs only. No Kalshi code, text, images, fonts, logos or trademarks; invented data only.
3. **Research ethics.** Logged-out public surfaces and the public developer docs only, at a polite rate. Never bypass Kalshi's bot challenge or WAF, never use anyone's credentials, never automate logged-in access. Logged-in behaviour comes only from captures you make yourself, with personal data removed before sharing.
4. **Definition of done.** Fully wired, 100% DB-persistent, end-to-end browser tests, `npm audit` clean, spec section updated with evidence and design choices, full suite green before merging to `main`.

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
- P3.1 Multi-step sign-up wizard, email verification and password reset (signed single-use tokens, short expiry), SMTP provider abstraction with a local dev mailbox.
- P3.2 Phone verification via an SMS provider abstraction (dev stub).
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

### Phase 6 — Perps completion (M)
- P6.1 Amend/decrease, order groups, subaccounts and transfers, trailing stops.
- P6.2 Size-tiered margin and the portfolio maintenance-margin model; fractional perps.
- P6.3 APY on perps collateral, rewards/referrals, waitlist access.
- Security gate: liquidation and funding invariants under property-based tests; risk-limit enforcement.

### Phase 7 — Public trading API (L)
- P7.1 API keys with RSA-PSS / Ed25519 signed requests (timestamp + method + path), scopes, per-key rate tiers, key rotation and revocation; step-up to create keys.
- P7.2 Batch orders, order groups, historical data endpoints, public WebSocket `/trade-api/ws/v2` with authenticated private channels.
- P7.3 Generated OpenAPI/AsyncAPI docs site.
- Security gate: signature replay window, clock-skew handling, key storage (public keys only), abuse throttling.

### Phase 8 — Growth and reach (M)
- P8.1 Referrals and copy-trade links (signed, non-guessable codes; fraud checks).
- P8.2 Server-side rendering or prerendering for public pages, sitemap, metadata; i18n framework; accessibility audit (WCAG 2.2 AA).

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
| R2 | Logged-in portfolio tabs: exact columns, empty states, sort/filter | REA `inspect_web_network_capture` with `sensitive_values` redaction | Your logged-in HAR with balances/IDs removed, screenshots | §17 refinements |
| R3 | Account/security pages: sessions/devices list, passkeys flow, MFA step-up prompts | chunk analysis (`passkeys`, `action_verification_mfa`); your screenshots | Screenshots of Account › Security | P1.4–P1.6, P3.4 |
| R4 | Full security header set from a real browser (HSTS, CSP, Permissions-Policy, report endpoints) | `inspect_web_network_capture` on an unsanitised-headers HAR | A HAR with response headers kept (cookies stripped) | P1.1 |
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
5. Phase 7 public API
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
| G5 | Batch cancel by order-ID list (§17.10) | 7 (with batch orders) |
| G6 | Resolution reversal after settlement (ledger clawback with audit) (§18) | 5 |
| G7 | Taker fee coefficient editable at runtime; rolling window and rate limits editable live (§18) | 1 (settings) |
| G8 | Four `PUT social-admin/...` moderation endpoints; promo-card targeting (§18) | 2 |
| G9 | Sports: ice-hockey league, live-updating event header label, running clocks for tennis/esports (§19) | 5 |
| G10 | Chat reactions and message editing (§20) | 2 |
| G11 | Perps: amend/decrease, order groups, subaccounts, trailing stops, size-tiered margin, portfolio maintenance margin, fractional perps, collateral APY, rewards/waitlist (§14) | 6 |
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
| 0 Stabilise | in progress (lock fix and `ws` upgrade done; CI, Dependabot, Windows notes next) |
| 1 Security foundation | in progress |
| 2 Social completion | live chat done; rest pending |
| 3 Identity & compliance | pending |
| 4 Payments (sandbox) | pending |
| 5 Markets & content | pending |
| 6 Perps completion | pending |
| 7 Public API | pending |
| 8 Growth & reach | pending |
| 9 Production readiness | pending |
| Research R1–R12 | R2/R3 waiting on logged-in screenshots from the user |
