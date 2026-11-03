# Security policy and threat model — Parlance Exchange

Parlance is a clean-room study clone of a prediction-market exchange. It handles **simulated money only** (sandbox
deposits and withdrawals, invented markets). It still treats accounts, balances, orders and user content as if they were
real, because the point of the project is to build the controls a real exchange needs (`PLAN.md` Phase 1).

## Supported versions

Only the latest commit on `main` is supported. Fixes are not back-ported to older commits or branches.

## Reporting a vulnerability

- **Do not open a public issue for a vulnerability.** Use GitHub's private reporting instead: repository **Security →
  Report a vulnerability** (private security advisory). If that is not available to you, contact the repository owner
  (`@htweet`) through GitHub and ask for a private channel; do not include details in the first message.
- Include: affected route, page or file; steps to reproduce; what an attacker gains; and any proof-of-concept. Redact
  any real personal data or credentials you came across.
- What to expect: acknowledgement within **3 working days**, a first assessment (severity, CVSS 3.1 vector) within
  **10 working days**, and a fix or mitigation plan for High/Critical issues within **30 days**. You will be told when the
  fix lands and, if you wish, credited in the advisory.
- **Safe harbour.** Good-faith research that follows this policy is welcome and will not be pursued: test only against
  your own local instance (`npm start`), never against other people's deployments or accounts; do not degrade service for
  others, access other users' data beyond what is needed to show the issue, or keep data afterwards; give us a
  reasonable time to fix before disclosure (default 90 days, sooner once a fix ships).
- Out of scope: findings that need a compromised machine or browser; missing hardening on the local dev server that is
  documented as production-only (for example HSTS over plain `http://localhost`); denial of service by volume; social
  engineering; reports from automated scanners without a demonstrated impact; the real exchange this project studies
  (report those to its operator, and never test it — see `PLAN.md` ground rule 3).

## How the codebase is defended (summary)

| Layer | Control | Where |
|---|---|---|
| Perimeter | Security headers, per-response CSP nonce, CORS allowlist, sensitive-path denial, static allowlist, proof-of-work bot challenge, signed client token on `/v1` writes and the WebSocket, honeypots, tiered rate limits | `clone/server/security.js`, `clone/server/bot.js` (P1.1–P1.3, P1.10–P1.12) |
| Identity | Sessions (`__Host-` cookie in production, rotation, idle/absolute timeouts), session CSRF + login CSRF, login backoff and lockout, password policy with breached-password list, TOTP two-factor, step-up for sensitive actions, first-admin bootstrap (no default password), security event log | `clone/server/auth.js`, `passwords.js`, `features.js` (P1.4–P1.6, P1.14) |
| Data | Sensitive columns encrypted with HKDF sub-keys of a master key outside the repo; tamper-evident (HMAC-chained) admin audit log | `clone/server/crypto.js`, `audit-chain.js` (P1.14, P1.15) |
| Authorization | Per-route guards (`requireUser` with the `:uid` ownership check, admin permission matrix `can(perm)`, moderator checks), object-level ownership checks in handlers; every registered route classified and tested for anonymous / user / other user / each admin role | `clone/server/app.js`, `admin.js`, `chat.js`; `clone/tests/authz.e2e.test.js` (P1.7) |
| Input/output | Per-route JSON body limits and declarative body schemas for high-risk writes; escaped HTML rendering enforced by lint (`parlance/no-unescaped-html`) | `clone/server/validate.js`, `clone/eslint.config.js`, `clone/eslint-rules/` (P1.8) |
| Money safety | `Idempotency-Key` replay (24 h, persisted) on orders, deposits, withdrawals, perps transfers, RFQ accept/confirm; exact cost-capped Dollars orders | `clone/server/idempotency.js`, `clone/server/engine.js` (P1.9, gap G2) |
| Supply chain and repo | CI with `npm audit`, lint, full E2E suite, gitleaks, CodeQL, OWASP ZAP baseline; Dependabot; pinned action SHAs; pre-commit secret scan; CODEOWNERS; agent deny rules | `.github/`, `.githooks/`, `scripts/`, `.claude/settings.json`, `.zap/rules.tsv` (P0.1, P0.2, P1.13) |

Guardrails for coding agents (`.claude/settings.json`) stop accidental reads of `.env*`, `clone/data/**` and key files by
Claude Code's own tools. They are **not a security boundary** (a script the agent writes can still open a file). The real
protection is that no production secret or real database ever exists on a development machine.

## STRIDE threat model

Scope: the Node/Express server (`clone/server`), the browser SPA (`clone/public`), the SQLite database and its key file,
the WebSocket, and the repository/CI. Trust boundaries: browser ↔ server (HTTP and WebSocket), server ↔ SQLite file and
key file on disk, staff (admin roles) ↔ regular users, repository ↔ CI and contributors. Status: **✅ in place** (with the
test that proves it), **◑ partial**, **☐ planned** (PLAN item).

### 1. Authentication and sessions

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| S | Credential stuffing / password guessing | Per-account and per-IP exponential backoff and lockout, uniform error timing, breached-password list, minimum length 12 (`auth.js`, `passwords.js`) | ✅ P1.5 |
| S | Session hijack via stolen cookie | `HttpOnly`, `SameSite`, `Secure` + `__Host-` prefix in production, idle and absolute timeouts, rotation on login/MFA/privilege change, "log out all devices", device list | ✅ P1.4 |
| S | Login CSRF / session fixation | Pre-session login CSRF token; new session id on every login | ✅ P1.4 |
| S | Default or leaked admin password | No default password: first admin from `ADMIN_EMAIL`/`ADMIN_PASSWORD`, `start({admin})` or a one-time setup URL | ✅ P1.5 |
| T | CSRF on state-changing requests | Per-session token in `x-csrf-token` on every non-GET request with a session; CORS allowlist; SameSite | ✅ (app.js, auth.js) |
| R | User denies a login or a security change | Security event log (login ok/fail, MFA, lockout, session revoke, step-up) with IP prefix and device summary | ✅ P1.14 |
| I | Account enumeration through sign-in/sign-up errors | Uniform `invalid_credentials`, uniform timing; unauthenticated API answers `401 token_authentication_failure` with no resource detail (S8) | ✅ |
| I | TOTP secrets readable from a stolen database | Encrypted at rest with an HKDF sub-key of the master key kept outside the DB | ✅ P1.15 |
| D | Lockout used to deny a victim access | Backoff is time-limited (max 15 min) and per scope; lockout notifications | ✅ P1.5 |
| E | Sensitive change from a hijacked but idle session | Step-up (recent password / TOTP) for MFA disable, password/email change, withdrawals, large deposits/transfers, role changes | ✅ P1.6 |

### 2. Trading and ledger (event contracts)

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| S | Placing orders as another user (IDOR on `/v1/users/:uid/...`) | `requireUser` rejects a `:uid` that is not the session's user; handlers use `req.auth.user.id`, never the path; matrix test probes every `/users/:uid` route as user B against user A | ✅ P1.7 (`authz.e2e.test.js`) |
| T | Double submission (double click, retry after timeout) places two orders | `Idempotency-Key` per user action; same key + same body → stored response replayed, different body → `409 idempotency_key_conflict`; concurrent duplicate → `409 idempotency_key_in_progress` | ✅ P1.9 (`idempotency.e2e.test.js`) |
| T | Dollars order spends more than the amount (per-fill rounding across many makers) | Size against the exact planned cost (each fill's ceil'd principal + fee) by binary search; reserve exactly that; invariant check | ✅ G2 (`idempotency.e2e.test.js`) |
| T | Balance races / negative balances | Single-process engine, every fill in one SQLite transaction (`tx`), reservations held before matching, exact refunds | ✅ (engine.js) |
| T | Type confusion / oversized fields in order bodies | Schema check (`validate.js`): types, string lengths, object shape; 4 KB body limit | ✅ P1.8 |
| R | Disputed trades or balance changes | Append-only ledger (`ledger` table) for every movement; fills/trades keep ids and timestamps | ✅ |
| I | Leaking other users' orders/fills through APIs | Reads scoped to `req.auth.user.id`; public trades carry no user ids | ✅ |
| D | Order flooding | Global token bucket, tiered limits (P1.10), MAX_COUNT per order, daily trading limits (`features.js`) | ✅ |
| E | Trading while the exchange or market is paused/closed | Engine checks `tradingActive` and market status inside the transaction | ✅ |

### 3. Payments (sandbox deposits, withdrawals, perps transfers)

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| S | Withdrawal from a hijacked session | Step-up (password, or TOTP when withdrawal 2FA is on) per withdrawal | ✅ P1.6 |
| T | Replayed deposit/withdrawal/transfer request | `Idempotency-Key` (24 h, persisted); `client_transfer_id` uniqueness on perps transfers | ✅ P1.9 |
| T | Malformed amounts (floats, objects, huge values) | `amount_dollars` positive, ≤ 2 decimals, ≤ $100,000; body schema with unknown fields rejected; 1 KB limit | ✅ P1.8 |
| R | "I never withdrew that" | Ledger entries + security events + idempotency records keyed by user | ✅ |
| I | Payment data exposure | Tokens only, never PAN/bank numbers (see §11) | ✅ P4 |
| D | Deposit-limit abuse | Account deposit limits (`features.js`), counting in-flight rail deposits | ✅ |
| E | Bypassing withdrawal holds/AML hooks | Every withdrawal path goes through the same precheck, risk score and AML hooks (see §11) | ✅ P4.2 |

### 4. Admin and CMS

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| S | Non-staff reaching admin APIs | `can(perm)` on every `/v1/admin/*` route; legacy `requireAdmin` on `/admin/markets`, `/admin/exchange`, perps admin; matrix test checks every admin route for every role | ✅ P1.7 |
| E | A role exceeding its permissions (editor resolving markets, support moving money) | Permission matrix (`ROLE_PERMS` in `admin.js`): each route bound to one permission; matrix test asserts allow/deny for all six roles | ✅ P1.7 |
| E | Self-escalation / removing the last admin | Cannot demote self or the last admin; role changes need step-up and rotate the target's sessions | ✅ |
| T | Tampering with the audit log to hide an action | HMAC-chained `admin_audit` rows + chain head in `meta` | ✅ P1.14 |
| R | Staff deny an action | Every admin write audited with actor, before/after and a required reason | ✅ |
| I | Admin pages leaking user PII to the wrong role | `users.read` permission; support sees users, editors do not | ✅ |
| T | Stored XSS through CMS content (banners, help pages, news) | Links restricted to site paths / `https:` (`F.link`), every interpolation escaped (lint rule) | ✅ P1.8 |
| D | Admin session left open | 30-minute idle timeout for staff sessions | ✅ P1.4 |

### 5. Social and live chat

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| S | Posting as someone else | Author is always the session user; `/users/:uid/` ownership check | ✅ |
| T | Stored XSS in posts, comments, chat, nicknames | Server stores text; client renders through `esc()`; lint rule fails CI on unescaped interpolations; XSS payload tests in `chat.e2e.test.js` | ✅ P1.8 |
| T | Deleting or editing other users' posts/messages | Handler checks owner or moderator; IDOR probes in the matrix test | ✅ P1.7 |
| R | Abuse without trace | Reports queue, moderation actions audited | ✅ |
| I | Private profile/holdings leaks | Only public profile fields serialised | ✅ |
| D | Spam / flooding | Chat per-user and per-IP buckets, slow mode, mutes, posting bans, body size limits | ✅ |
| E | Banned or muted user still posting | Ban/mute checked on every write | ✅ |
| I | Circle-only posts or private group chats leaking | One visibility rule for single post, replies, likes, feeds, counts, links and notifications (404 for others); group paths 404 for non-members; `groups` WS channel published per current member; moderator group views audited (CLONE_SPEC §24.6–24.7) | ✅ Phase 2 |
| T | Edits rewriting history | 10-minute post / 5-minute chat edit windows; every edit kept (`post_edits`, `chat_message_edits`) and shown to moderators; moderator edits marked and audited | ✅ Phase 2 |
| D | Harassment through circle requests, group adds, notifications | Mutes drop notifications caused by the muted user; 24 h cool-off after a declined request; adds limited to mutual follows / circle with a uniform refusal; per-user / per-IP buckets on every new write; email / push capped per hour | ✅ Phase 2 |
| S | Malicious media in stickers / GIFs | Only Parlance's own SVG stickers, served by id with `default-src 'none'` + `sandbox`; external GIF adapter off (server-side proxy with host allowlist when enabled) | ✅ Phase 2 |

### 6. WebSocket (`/v1/ws`)

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| S | Cross-site WebSocket hijacking | Upgrade needs the session cookie **and** the matching CSRF token in the URL, plus the signed client token (`ct`) and an allowed `Origin` | ✅ (ws.js, security.js) |
| I | Receiving another user's private data | Private channels (`user_balance`, `user_orders`, `fill`, `notifications`, `perp_*`, `communications`, `groups`) refused without auth (`code 9`) and published only to the owning user id; matrix test subscribes as user B while user A trades | ✅ P1.7 |
| D | Oversized frames / subscription floods | 64 KB `maxPayload`, chat filter capped at 20 tickers, keep-alive reaping | ✅ |
| T | Forged server messages | Server → client only; client commands limited to subscribe/unsubscribe | ✅ |

### 7. Perps (margin product)

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| S/I | Reading or cancelling another user's perps orders/positions | All perps reads/writes keyed by `req.auth.user.id`; order cancel checks owner (404 otherwise); IDOR probes in the matrix test | ✅ P1.7 |
| T | Duplicate order/transfer/close on retry | `Idempotency-Key` on `/perps/orders`, `/perps/transfers`, `/perps/positions/:t/close` | ✅ P1.9 |
| T | Margin/liquidation invariants broken by rounding | Centicent arithmetic, margin reserved before matching; property-based tests planned | ◑ P6 gate |
| E | Users calling perps admin endpoints (index, simulation, funding) | `requireAdmin` (is_admin) — matrix test | ✅ |
| D | Funding/liquidation loop overload | Tick-driven, bounded per tick | ✅ |

### 8. Combos and RFQ

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| S | Accepting a quote on someone else's RFQ / confirming someone else's quote | `acceptQuote` requires the RFQ owner, `confirmQuote` the quote's maker (404 otherwise); IDOR probes | ✅ P1.7 |
| T | Accept/confirm replayed → two executions | Quote state machine (`open → accepted → confirmed → executed`) plus `Idempotency-Key` on accept/confirm | ✅ P1.9 |
| I | Requester identity exposed to makers | Opaque `communications_id`, not user ids; `obscure_creator_id` shows others the empty-input SHA-256 placeholder until execution (CLONE_SPEC §24.10) | ✅ G3 |
| E | Maker bypassing daily trading limits through quote confirmation | Limit checked on confirm (G4) | ✅ |
| D | RFQ spam | At most N open RFQs per user, TTLs on RFQs and quotes | ✅ |

### 9. Repository, CI and supply chain

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| I | Secrets committed | Pre-commit scan (gitleaks or bundled scanner, also blocks `.env`, keys, DB files), gitleaks on full history in CI, `.gitignore`, `.env.example` only | ✅ P1.13 |
| T | Malicious dependency or action update | Lockfile + `npm ci`, `npm audit --audit-level=high` in CI and pre-commit, exact pinned devDependencies, actions pinned to commit SHAs, Dependabot PRs reviewed via CODEOWNERS | ✅ P0.1, P0.2 |
| T | Unsafe code merged | CodeQL (security-extended), ESLint security rules, ZAP baseline, full E2E suite as required checks; CODEOWNERS on security-sensitive files | ✅ (branch protection on `main` to enable) |
| I | Coding agent reading secrets during development | `.claude/settings.json` deny rules; no real secrets on dev machines | ✅ (guardrail only) |

### 10. Identity, personal data and compliance (Phase 3, `CLONE_SPEC.md` §25)

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| I | Database theft exposes identity data | Per-user AES-256-GCM data keys wrapped by an HKDF sub-key of the master key; AAD binds each ciphertext to its field and user; national ID as keyed hash + last digits only; no plaintext PII at rest (tested by a full DB dump) | ✅ P3.1a |
| I | Staff browsing PII / ID photos | Masked admin views; reveal and document view need support/admin, a reason, are hash-chain audited and shown to the customer; national ID never revealable | ✅ P3.1a, P3.5 |
| T/I | Malicious or metadata-laden ID photo uploads | Type sniffing, container rewrite dropping all metadata and trailing bytes, size/dimension caps, canvas re-encode in the browser, encrypted storage, no public URL, erasure at the decision | ✅ A1 (no server-side re-encode: residual) |
| S | QR handoff hijack | 256-bit token in the URL fragment, hash-only storage, single use, 10 min, bound to the desktop session; capture cookie HttpOnly/SameSite=Strict + CSRF value | ✅ A1 |
| S | Account takeover via SIM swap, provider linking, reset links | Phone change needs step-up; OAuth linking of an existing email needs the password; PKCE + state + nonce; reset links single use, fingerprinted to the password hash, sessions revoked | ✅ P3.2–P3.3 |
| S | Cloned or replayed passkeys / TOTP | Challenge single use + binding, origin and rpId checks, signature counter; TOTP last-step record (RS3) | ✅ P3.4, RS3 |
| D | Lockout of a known email by a stranger | Proof of work instead of a timed account lock (RS2); per-IP hard backoff | ✅ RS2 |
| I | Account-existence signals | Uniform login (RS9) and reset answers | ✅ RS9 |
| E | Trading/deposits before verification or from blocked regions | Server gate: identity status, simulated location (IP + consented browser fix), fraud holds on withdrawals; A2 lock on passkeys/sign-in methods/API keys | ✅ P3.1, P3.6, P3.7, A2 |
| R | Disputed consent or closure | Append-only marketing-consent records (text version + hash), PII-free closure audit, export for the owner after step-up | ✅ A6, P3.8 |

### 11. Payment rails, sandbox only (Phase 4, `CLONE_SPEC.md` §26)

Trust boundaries added: payment provider ↔ webhook endpoint (server-to-server, no session), browser ↔ card tokenizer,
exchange ↔ its own provider simulators (loopback HTTP).

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| S | Forged provider webhook credits an account | HMAC-SHA256 over `t.body` with a per-provider HKDF key, constant-time compare; unsigned / wrong-signature events refused before parsing; applied only by state machine | ✅ (`payments.e2e` webhooks) |
| T | Replayed or delayed webhook | 5-minute timestamp tolerance; event-id dedupe in the same transaction that applies it (`409 webhook_replayed`) | ✅ |
| R | "That webhook never arrived / was not ours" | `webhook_log` (accepted / rejected / error, IP) and `security_events` (`webhook_rejected` with the reason); provider outbox with attempts | ✅ |
| I | Card numbers in the database, logs, errors or responses | Isolated tokenizer route with its own raw parser (outside the shared JSON parser, request logging and the /v1 router), buffer zeroed, fixed error codes; only the documented test numbers accepted (real numbers refused, not kept); token + brand + last 4 + expiry stored; SPA clears the fields | ✅ (DB/WAL/log/response grep) |
| I | Bank or wallet data exposure | Bank: mask + provider token; sandbox credentials checked, never stored; crypto addresses are public by nature, masked in AML details | ✅ |
| S | Card testing through the tokenizer | Signed-in user, client token, a short-lived payment session per attempt (5 uses), 10 attempts per 10 minutes | ✅ |
| E | Withdrawal from a hijacked session to an attacker's destination | Step-up on each new payout destination and each withdrawal (TOTP when withdrawal 2FA is on); security alert on a new destination; 24 h cooling for new crypto addresses; the first withdrawal to one is held (AML hook); card payouts only to a card that paid in | ✅ |
| T | Double deposit / withdrawal on retry | `Idempotency-Key` **required** on every rail creation; replay returns the stored response | ✅ |
| E | Withdrawing unsettled ACH funds or promotional credits (bust-out) | Withdrawable = cash − credits − unsettled; credits cannot move to Perps; returns debit cash (negative = debt, withdrawals blocked) | ✅ |
| E | Structuring, rapid in-and-out, laundering through new addresses | AML rule hooks open audited cases and can hold withdrawals through `withdrawal_holds`; daily and monthly withdrawal limits | ✅ (simple rules, see residual) |
| T | Ledger drift or tampering between balances and money movements | Double-entry journal for every balance change (central engine hooks); audit job + admin check (balanced entries, cash + credits = balance, reservations, holds, escrow = open interest, pending payouts); reconciliation of provider records vs ledger with an audited resolution queue | ✅ |
| D | Webhook flooding | Anonymous rate tier, 64 KB raw-body limit, rejection logging throttled per kind and IP | ✅ |
| E | Staff moving money without trace | Reconciliation adjustments, AML decisions and payment settings need `users.money` / `settings.write`, a reason and step-up; all hash-chain audited | ✅ |

### 12. Markets and content (Phase 5B, `CLONE_SPEC.md` §29)

Trust boundaries added: CMS news text → summarizer (and, when configured, → an external model API and back); browser →
ballot lookup (a postal address); resting orders → incentive rewards → the journal.

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| T | **Prompt injection** in a news item steers the summary ("ignore previous instructions…", links, markup) | News text is data: tags, control and bidi characters and links are stripped, `<`, `>`, `&` escaped, and each item sits in its own `<item id>` element inside `<news_items>`; the system prompt says the items are untrusted and asks for JSON only. The extractive summarizer drops instruction-like, linked or marked-up sentences | ✅ (`markets-content` AI test: prompt shape, injected item) |
| T | A compromised or confused model reply (HTML, links, instructions, invented sources) | Output validated before use: JSON shape, 1..N sentences, ≤ 300 characters each and a total cap, no `<`/`>`/entities, no URLs or markdown links, no instruction echo, every sentence cites only ids that were sent, moderation blocklist; anything else is discarded and the extractive summary is served (`fallback_reason invalid_output:*`), counted in `ai_usage.rejected`. Rendered with `esc()` only | ✅ (fake adapter returns a link + unknown id → rejected) |
| D / $ | Runaway model spend (many events, repeated regeneration) | Daily request and token budgets in Admin › AI summaries (estimate checked before each call; over budget → extractive, no call); cache keyed by the news-set hash, so a summary is generated once per set; concurrent requests for the same set share one call; admin regeneration limited to 6 per 10 minutes per admin (SQLite-backed, hashed keys); SDK timeout 20 s, one retry | ✅ (cost-cap and rate-limit tests) |
| I | API key or model choice leaking | Key only from `ANTHROPIC_API_KEY`, never logged or returned; the adapter exists only when both variables are set; no model id in code; `.env.example` documents empty values | ✅ |
| R / E | Unaccountable summary moderation | Hide / unhide / regenerate / settings need `content.write` (settings `settings.write`), a reason, and write a hash-chained audit row; hides apply per event and survive new news | ✅ (audit rows asserted) |
| I | **Ballot lookup** stores or leaks home addresses | The address is used once in memory to resolve an invented jurisdiction and never written to the DB, logs or audit; lookups are POST (no address in URLs or access logs); only a jurisdiction id is saved, by explicit choice, and can be forgotten | ✅ (DB file + WAL byte grep and log grep) |
| D | Address enumeration / scraping of the lookup | 20 lookups a minute per user and 120 per IP (hashed keys), 200-character cap, strict body schema | ✅ |
| T / E | Gaming incentive rewards (self-match, system liquidity, ineligible regions) | Only enrolled users from an eligible region accrue (re-checked on each visit; ineligible → suspended); system accounts never score; per-side score capped at the target size; rewards accrue in micro-cents and pay whole cents once; payouts need `users.money`, a reason and step-up, and post balanced journal entries (`house:incentives` or `house:promotions`); the ledger audit covers them | ✅ (payout + ledger audit test). Wash-trading detection is a residual |
| T | Spread / total settled against the wrong score | Lines resolve from the persisted final state of the same deterministic simulation that drives the scoreboard, through the normal determine → finalize path; half-point lines cannot push | ✅ |

## Residual risks and planned work

- Single-process SQLite: no horizontal scaling; Phase 9 moves to PostgreSQL (P9.2).
- No WAF/CDN in front of the dev server (P9.3); TLS terminates at a reverse proxy in production (P9.1).
- Payments run on sandbox rails only (Phase 4, `CLONE_SPEC.md` §26.13): simulated providers with loopback webhook delivery
  and derived secrets, an in-process tokenizer instead of provider-hosted fields, three AML rule hooks rather than a
  monitoring programme. KYC, geolocation and fraud signals are simulations (Phase 3, `CLONE_SPEC.md` §25.14).
- Signed API keys for the public trading API are not built (P7.1).
- Property-based tests for perps margin/liquidation invariants (P6 gate).
- Phase 5B (`CLONE_SPEC.md` §29.10): the injection filter and moderation blocklist are heuristics; output validation is
  the real control. No wash-trading or self-matching detection for incentive rewards yet. The ballot rate limit and
  the summary budget are per process (PLAN §10 RS1). A saved ballot area is not yet part of the data export.

Review this document whenever a phase passes the §6 security gate in `PLAN.md`.
