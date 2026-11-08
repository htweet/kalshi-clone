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
| T | Margin/liquidation invariants broken by rounding | Integer units and an integer cost basis (exact realized PnL), margin reserved before matching, a double-entry perps journal in the ledger audit; property-based tests of conservation, non-negative collateral, insurance accounting and zero-sum funding (`perps-invariants`) | ✅ P6 gate (§17) |
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

### 12. Trading core and resolution integrity (Phase 5A, `CLONE_SPEC.md` §28)

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| T | Off-grid or over-precise prices create unmatchable levels or rounding exploits | Every limit is checked against the market's grid in the engine (`invalid_price`); prices are integers (centi-cents), so there is no float math in matching | ✅ (`trading-core` grid test) |
| T | Fee rounding drift (many tiny fills each rounded up, or rounding skimmed silently) | Exact micro-dollar fees with BigInt; one accumulator per order; journal books the rounding cent separately (`house:fees:rounding`) and the audit reconciles it against `orders.fee_micro` | ✅ |
| E | Releasing collateral that a user's positions do not actually guarantee | Guarantee computed from the worst single-winner scenario (and "no winner") inside the fill / settlement transaction; scalar events excluded; repayment at once when the hedge shrinks; advances journaled against `house:collateral_advance` and audited | ✅ |
| T | A wrong or malicious resolution pays the wrong side | Source note required; settlement delay as a review window; **two-person rule** option (a different admin with `resolution.write` must approve; self-approval refused; requests lapse after 24 h); step-up for corrections and for changing the policy | ✅ (`trading-core` two-person test) |
| R | "Nobody decided that" after a payout is reversed | Every request, approval, rejection and correction is a hash-chained audit row with the reason, requester and approver; `settlement_corrections` keeps the before/after value, the claw-back and the re-pay | ✅ |
| T | Correction leaves money unaccounted for, or a user's balance silently wrong | Settlement rows are append-only (`effective_payout_cents` tracks the corrected amount); each difference is a ledger + journal entry against the market escrow, which must return to zero; negative cash follows the Phase 4 debt rule (withdrawals blocked); every affected user is notified | ✅ (ledger audit in the suite) |
| E | Unprivileged staff create or reshape markets | Drafting markets (including scalar bounds and grids) needs `catalog.write`; resolution needs `resolution.write`; policy needs `settings.write`; all routes are in the authz matrix | ✅ (`authz`) |
| D | Flip sell or auto-sell used to place oversized orders | Both go through the normal order path: Idempotency-Key, body schema, trading limits, balance reservation, fractional rules | ✅ |

### 13. Markets and content (Phase 5B, `CLONE_SPEC.md` §29)

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

### 14. Progressive Web App and Web Push (`CLONE_SPEC.md` §31)

Trust boundaries added: a service worker between the page and the network; Cache Storage on the user's device; the
server → third-party push services (an outbound request to a URL the browser supplied) → the user's lock screen.

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| T / I | **Cache poisoning / leakage**: a personalised or attacker-influenced response is cached and served to later users of the device (or after sign-out) | The worker stores only the build's precache list, fetched with `credentials: 'omit'` (no session, so no user data), exact paths without query strings, same-origin 200s that are not redirected, `no-store` or `private`; runtime responses are never written; one cache per build, old ones deleted on activation; sign-out empties Cache Storage | ✅ (`pwa`: every cache entry inspected; sign-out test) |
| S / T | **Nonce and boot-proof reuse**: a cached HTML page replays an old CSP nonce or signed boot proof | Navigations are network-only (navigation preload) and never stored; the only cached HTML is the static offline page, which has no script, no nonce and its own `default-src 'none'` policy without a script source | ✅ (fresh nonce on every navigation; offline page asserted script-free) |
| T / E | The worker weakens the perimeter (strips client tokens, CSRF, Idempotency-Key, bypasses the bot challenge) | `/v1`, `/trade-api`, the WebSocket, non-GET and cross-origin requests are not intercepted at all; the challenge page arrives through the worker unchanged and is solved | ✅ (forced-challenge scenario through a controlling worker) |
| T | A malicious or stale worker persists | Served from the origin only (`worker-src 'self'`, scope `/`), `no-cache` and `updateViaCache: 'none'`, its own restrictive CSP; updates activate only on the user's click; a fixed build replaces it on the next check | ✅ / residual (no remote kill switch beyond a new `/sw.js`) |
| I | **Push payload privacy**: notification text exposed to the push service, at rest, or beyond what the user already sees | Payloads are encrypted end to end (RFC 8291 aes128gcm, padded to 128-byte buckets); the push service sees only metadata. The payload is the in-app notification's title, body and deep link, nothing more. Outbox payloads, endpoints and subscription keys are AES-GCM encrypted at rest with row-bound AAD; the API never returns endpoints or keys | ✅ (fake service decrypts with the subscription key only; DB rows asserted encrypted) / residual: text shows on lock screens |
| S / I | **VAPID key handling**: the private key leaks or is forged | Generated server-side once, stored AES-256-GCM encrypted under an HKDF sub-key of the master key (`web-push:v1`), never logged or returned; JWTs are ES256, audience-bound to the push service origin, valid 12 h, cached per audience | ✅ (fake service verifies signature, `aud`, `exp`, `sub` against the published key) |
| T / E | **SSRF** through the subscription endpoint (the server POSTs to a browser-supplied URL) | `https:` on the default port, host name only (no IP literal, no `localhost`), on a known push-service allowlist (`PUSH_ALLOWED_HOSTS` extends it); re-checked before every send; `redirect: 'error'`, 10 s timeout; the http test allowlist is refused in production | ✅ (validation cases) |
| S / I | One user's notifications reach another person (shared browser, re-subscription) | A re-subscribed endpoint moves to the new account and the old owner's queue is dropped; signing in as a different account unsubscribes a foreign subscription in the browser; sign-out deletes this browser's subscription first; owner-only routes, IDOR-checked | ✅ (`pwa`, `authz`) |
| D | Push storms or a dead push service exhaust the server | Matrix gate and the hourly per-user cap apply first; at most 10 devices per user; test sends rate-limited; exponential backoff (≤ 1 h, Retry-After honoured), at most 8 attempts, TTL expiry, 404/410 delete the subscription; finished rows pruned after 7 days | ✅ |
| T | Hostile push content (forged or replayed message) opens an external site | Notification clicks accept only same-origin paths; anything else opens `/` | ✅ (hostile link test) |

### 15. Content management (Phase 5C, `CLONE_SPEC.md` §32)

Trust boundaries added: staff editors and publishers → content that every visitor renders (texts, rich text, page
bodies, templates, images, colours); uploaded files → the server's image decoders.

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| T / E | **Stored XSS through managed content** (a text, rich text, page body, footer link, template or alt text carrying markup or script) | Plain texts are escaped wherever shown (`t()` is "unescaped" to `parlance/no-unescaped-html`; `te()` escapes) and markup-like input is refused on save; rich text, page bodies and email HTML pass an allowlist sanitiser (tokenizer, re-escaped text, allowlisted elements, `href` only, `https:` / `mailto:` / site paths); no inline handlers, no `javascript:` / `data:` URLs, no inline styles (colours are CSS variables from `/content-theme.css`) | ✅ (`cms`, `cms-content`: XSS in texts, rich text, templates, pages, links) |
| T / E | **Template injection** | Logic-free `{{name}}` placeholders with declared variables only; other syntax refused; variables HTML-escaped in email HTML, link variables must be safe URLs | ✅ |
| T / E / D | **Malicious uploads**: SVG with script, polyglots (image + HTML/JS), metadata leaks, decompression bombs | Magic-byte detection (PNG/JPEG only), size and dimension limits, inflate output capped, refusal of trailing data and embedded markup, re-encode from pixels (metadata and payloads cannot survive); served `nosniff` with `default-src 'none'; sandbox` | ✅ (EXIF / text chunk gone, polyglot / SVG refused) |
| I | **Draft leakage** (unpublished terms, announcements) | Drafts only in staff-only, `no-store` preview responses; public bundle, pages and the WebSocket message never contain them | ✅ |
| E / R | Unauthorised or unaccountable changes | `content.write` vs `content.publish`; legal pages need step-up; reasons required; every publish, schedule, rollback, import, upload and test send in the hash-chained audit log; versions with rollback | ✅ (`authz` matrix, `cms`) |
| D | Abuse of uploads, test sends or writes | Admin rate tier plus per-user CMS limits (writes 120/min, uploads 30/min, test sends 10/min); body limits per route | ✅ |
| T | Supply chain of the JPEG codec | `jpeg-js` 0.4.4 pinned exactly (official package, no dependencies, BSD-3), resolution and memory limits set; `npm audit` clean | ✅ / residual: third-party decoder |

### 16. Feature flags, play mode, Central Bank and money controls (Phase 5D, `CLONE_SPEC.md` §33)

Trust boundaries added: staff → switches that change what every user can do (flags, play mode, the production reset,
money controls, the vault); users → a game that moves (play) money out of a shared vault; the client → a flag bundle it
could tamper with.

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| E / T | **Client-side bypass of a switched-off feature** (calling the API of a hidden page, editing the flag bundle) | Server-authoritative evaluation on every request: the `/v1` gate (`feature_disabled`) runs before every router, pipelines and jobs ask the server state; the bundle only drives the UI | ✅ (`flags`: every flag off blocks its API) |
| I | **Targeting lists leak** (who is allow- or deny-listed, rollout membership of others) | The public bundle carries the caller's booleans only; lists are admin-only (`settings.write`) | ✅ |
| E | **Authorization signal changes** (a disabled flag answering before authz would reveal resources or mask IDOR checks) | The gate leaves requests to the route when there is no session on a write or the `:uid` is not the caller; admin routes are gated only by explicit rules | ✅ (`authz` matrix unchanged with every flag on) |
| D / E | **Locking staff out** (password sign-in disabled) | `signin.password` never refuses a staff email; `FEATURE_FLAGS` overrides the DB for incident recovery | ✅ |
| R / E | Unaccountable or hasty changes | Reason, fresh step-up, history per flag and the hash-chained audit on every flag, play-mode, Central Bank and money-control change | ✅ |
| T / E | **A single admin wiping balances** (the production reset) | Typed `RESET`, step-up for request and approval, a different admin must approve (two-person rule), 24 h lapse, one pending request, executes once; backup snapshot before any change | ✅ / residual: one person with two admin accounts |
| T | **Play and real money mixing** (play money withdrawn, or real money reset) | Play mode refuses to start while real customer money exists; withdrawals refused on every path in play mode (gate + `payments.js`); rails unreachable; trigger-stamped money mode / epoch on every ledger row and journal entry, audit checks for mixed epochs and minted play money in a real epoch | ✅ |
| T / I | **Cheating the heist** (reading the code, replaying guesses, racing payouts) | Code drawn with `crypto.randomInt`, stored AES-GCM encrypted with row-bound AAD, returned only after the end; guesses judged server-side in a transaction re-reading heist and vault; numbered guesses replay instead of consuming; idempotent starts; per-user rate limits, daily attempts, jail; loot capped by the vault inside the transaction | ✅ (`playmode`: concurrent cracks within the pot, journal balanced) |
| T | **RNG manipulation through the API** | The deterministic RNG is a process start option for tests, ignored when `NODE_ENV=production`; no request field reaches it | ✅ |
| I | **Personal data in the public heist feed** | Display names only; no ids or emails on the `central_bank` channel | ✅ |
| T / E | **Bypassing a per-user revocation** through another rail | One classifier for every deposit / withdrawal path in the gate plus the same guard inside `payments.js` | ✅ (`flags`: every rail refused) |
| T | **Treasury overdraft** | Payouts from `bank:vault` only when it covers them (inside the transaction); otherwise queued or refused; audit check `vault_non_negative` | ✅ |
| I | **Backup file exposure** | Written with mode 600 inside the data directory (already denied to coding agents by `.claude/settings.json`) | residual: not encrypted as a file; move off-host in production |

### 17. Perps completion (Phase 6, `CLONE_SPEC.md` §34)

New attack surface: subaccounts and transfers between them, order amend / decrease and order groups (writes on existing
orders), trailing stops (server-side triggers), portfolio margin (losses shared across positions), money paid by the
house into collateral (APY, referral rewards), referral codes, the waitlist gate, Admin › Perps ops.

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| S / I / T | **IDOR on new objects**: amending, decreasing or cancelling another user's order; reading or cancelling another user's order group; moving another user's subaccount funds | Every lookup is keyed by `req.auth.user.id` (orders, groups, subaccounts are per user; foreign ids answer 404); a group must belong to the caller and the order's subaccount | ✅ (`authz` IDOR probes + matrix) |
| T | **Money created or lost by rounding** in fills, funding, liquidations, transfers, APY | Integer units and cost basis; realized PnL paid rounded down with the remainder tallied; funding made zero-sum with the liquidity account absorbing rounding; every movement journaled double-entry and audited (bridge = main collateral, tables = postings, PnL conservation) | ✅ (`perps-invariants`: independent table equation after every action) |
| T | **Negative collateral / loss socialised to other users** after a gap | Isolated losses beyond margin are covered by the insurance fund then the backstop (house), never by other collateral; cross losses draw on the subaccount's own free collateral and margins first; a margin lock never overdraws | ✅ (property + targeted gap tests) |
| E | **Bypassing risk limits** by splitting orders, using resting orders, or subaccounts | Worst-case check includes the subaccount's same-side resting orders; leverage checked against the blended maximum at that size; open-order limits per market and in total per user; limits on subaccounts and groups; self-trade prevention across all of a user's subaccounts | ✅ (`perps-risk` at the API) / residual: per-subaccount position limits (a user may hold the max in each subaccount) |
| T | **Emptying a losing portfolio** (moving the free balance of a cross subaccount out while its positions are under water, leaving the loss to the insurance fund and the house) | Withdrawals from a cross subaccount with positions are limited to `min(free, equity − initial margin)`, to Predictions and to other subaccounts alike | ✅ (`perps-risk`: the move is refused, the withdrawable part moves, no liquidation or shortfall) |
| T | **Amend race / partial replace** (old order canceled, new one refused) | Amend runs cancel + placement in one transaction with every check; any refusal rolls back | ✅ (`perps-trading`) |
| T | **Trailing stop firing twice or not at all** under fast moves | Watermark updated and persisted before the check on every evaluation; the trigger row is updated in the same transaction as its order; evaluation after every index change and tick | ✅ (spike-and-gap test) / residual: discrete evaluation |
| T / E | **Referral abuse** (self-referral, code guessing, farming) | Own code refused; one code per user per program; codes from the crypto RNG (50 bits); 5 attempts per user per minute; codes only within 30 days of sign-up and before the first trade; volume threshold, never counting volume traded against the referrer; lifetime caps per referrer; system accounts excluded | ✅ / residual: no device or payment-instrument linkage |
| T | **Treasury drained by APY or rewards** | Paid only while the vault covers the amount (inside the transaction), otherwise queued or refused; vault audit check; APY rate and referral rewards need `perps.ops`, a reason and a fresh step-up; no APY without an admin enabling it | ✅ |
| T | **Clock manipulation of APY accrual** | The accrual clock is a process start option for tests, ignored when `NODE_ENV=production`; no request field reaches it; turning APY on never back-dates | ✅ |
| E | **Waitlist bypass** (trading before approval through another route) | Enforced in the `/v1` flag gate before any router, for every Perps write that adds money or risk; protective actions (cancel, close, reduce-only, transfers out) stay allowed so funds are never trapped | ✅ (`perps-growth`) |
| T / R | **Unaccountable risk changes** (tiers, limits) | `perps.ops` + reason + step-up + hash-chained audit; tier validation (caps increase, rates never fall, maintenance below initial) | ✅ |
| T | **Play money crossing into production** through the new balances | The production switch archives and zeroes subaccounts, accruals, queued payouts and pending referrals and closes every perps journal account; perps journal entries carry the money mode and epoch (audit check for mixed epochs) | ✅ (`perps-growth`) |

### 18. Public trading API, WebSocket, FIX, developer portal and demo (Phase 7, `CLONE_SPEC.md` §35)

New attack surface: API keys (creation, rotation, revocation, the private key shown once), signed requests on
`/trade-api/v2` (orders, batches, order groups, RFQ, Perps), the public WebSocket (`/trade-api/ws/v2`, `/margin`), a FIX
4.4 TCP acceptor, the `/docs` portal with in-browser signing, a second exchange (the demo environment) behind a
same-origin proxy, the status page and its admin-posted incidents.

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| S | **Forged or stolen request** (no key, another key, a tampered path) | Signature over `timestamp + METHOD + path` with RSA-PSS SHA-256 (salt 32) or Ed25519, verified with Node's crypto; unknown key ids verified against a dummy key (same work, no timing oracle); only public keys stored | ✅ (`trade-api`) |
| S / R | **Replay** of a captured state-changing request | (key, hash of timestamp + signature) persisted for the window and refused a second time; timestamps outside 5 s past / 1 s future refused with the server time | ✅ (`trade-api`) / residual: GETs may be replayed inside the window (read-only) |
| I | **Private-key exposure** | Generated keys: shown once (`no-store`), never stored or logged; pasted private keys refused before storage; the demo Try-it key is a non-extractable WebCrypto key in the browser's IndexedDB; signatures never logged (asserted) | ✅ (`api-keys`, `dev-portal`) |
| S / E | **Cookie or key confusion** (CSRF through the API, key used on browser routes) | `/trade-api` never accepts a session cookie (anonymous and cookie both get 401) and so needs no CSRF; `/v1` never reads the API headers; the internal dispatch object is built server-side (`app.request`), never from client data | ✅ (`trade-api`, `authz`) |
| E | **Scope escalation** | `read` always; `trade` for order entry; `perps` for the margin product; checked per operation from the registry, on the WebSocket path and at FIX logon | ✅ (`authz` signed-key probes) |
| E | **Bypassing the web app's rules through the API** | Writes are dispatched through the same `/v1` gates: step-up guard, flags (with play-mode money controls), session limits, body schemas, locks, Idempotency-Key, identity / location / fraud gate, trading limits; `api.trading` switches API order entry off on its own | ✅ (`trade-api`) |
| S | **Use by a blocked owner or from the wrong place** | Locked, closed (self-excluded) or frozen owners get 401 `account_unavailable` even with a valid signature; CIDR allowlists (IPv4 / IPv6) per key → 403; demo keys refused on production and the reverse (prefix + separate databases) | ✅ (`trade-api`, `dev-portal`) |
| D | **Abuse / flooding** | Token buckets per key and tier (read / write, per-endpoint costs; batches cost per item; a request above the bucket is refused), WebSocket connection caps, 64 KiB frames, 20 commands/s, FIX session caps, 100 messages/s per FIX session, 8 KiB FIX bodies and 32 KiB buffers; failed signatures still pass the per-IP perimeter limiter | ✅ / residual: buckets per process (RS1) |
| T | **FIX framing attacks** (bad BodyLength, CheckSum, huge messages, sequence games) | Own parser: BeginString, BodyLength and CheckSum enforced, size caps, garbled messages ignored and counted, too-low MsgSeqNum → Logout, gaps resolved by resend / gap fill only | ✅ (`fix`) |
| R | **Unaccountable key and session actions** | Create, rotate, revoke, tier changes, settings, FIX disconnects: hash-chained audit with actor and reason; user-visible security activity; notifications and emails from CMS templates | ✅ |
| I / E | **IDOR on keys, orders, groups, RFQs** | Every lookup keyed by the key's owner (foreign ids 404); key management only on the owner's `/users/:uid` paths; staff routes behind `users.read` / `users.support` / `settings.write` | ✅ (`authz` IDOR probes, `api-keys`) |
| T | **Revoked key still connected** | Revocation, expiry, the owner's lock or the flag going off end the key's WebSocket sessions (4401) and FIX sessions (Logout) at once, and every heartbeat re-checks | ✅ (`api-keys`, `trade-api`, `fix`) |
| T / I | **Demo proxy as a pivot** | Only `/demo-api/trade-api/*`; only the API headers cross, never cookies or Set-Cookie; 64 KiB body cap; loopback target fixed at start; the demo is a separate database with play money | ✅ (`dev-portal`) |
| T | **Portal / incident content injection** | Prose is CMS pages sanitised by the 'page' allowlist (now with `pre`/`code`, no attributes); incidents are plain text; the portal runs under the site's strict CSP (no inline script; Try-it is a module) | ✅ (`dev-portal` CSP check) |
| T | **Play money crossing into production through API state** | The production switch cancels API orders like all orders, closes order groups and logs FIX sessions out; keys survive (credentials, not money) | ✅ (`fix`) |

### 19. Waitlists, launch survey and newsletter (Phase 7A, `CLONE_SPEC.md` §36)

New attack surface: a public guest form that takes an email address, confirmation / manage / unsubscribe links, an
RFC 8058 one-click endpoint that runs before the session middleware, survey answers with free text, a consent CSV of
personal data, a bulk mailer, and the Perps waitlist flag switched on by a migration.

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| S | **Subscribing someone else** (a third party enters a victim's address) | Double opt-in: nothing is sent to a guest entry except the confirmation; the link is 32 random bytes stored only as SHA-256, single use (marked in the confirming transaction), 48 h; unconfirmed requests deleted a week after expiry; the landing page confirms on a click, not on load (mail scanners) | ✅ (`waitlists`) |
| I | **Account / membership enumeration** through the guest form | The same `202 {status: "check_email"}` for new, pending, confirmed, unsubscribed and account emails, over the limit and for the honeypot; only the inbox owner learns the state ("already on the list" email) | ✅ (`waitlists`) |
| D | **Form spam, mail bombing** | Signed client token (bot challenge) and login CSRF on the form; auth rate tier + persisted per-IP limit (10/h) + per-email limit (3/h, silent); honeypot field logged as a security event; token routes limited per IP; the newsletter is throttled (120/min) | ✅ (`waitlists`) / residual: per-process limits (RS1), shared NAT |
| S / T | **Forged or cross-entry tokens** (unsubscribe, delete, survey edits of another member) | Manage tokens are `entry id + HMAC-SHA256` with a dedicated key, compared in constant time; a signature is bound to its entry id; signed-in routes act only on the caller's own entry; no entry id is accepted in a body | ✅ (`authz` waitlist IDOR test) |
| S | **One-click unsubscribe abused as CSRF** | Without cookies or CSRF by design (RFC 8058); it can only unsubscribe the entry the HMAC token names, is idempotent and rate limited; no other action is reachable without the token | ✅ |
| I | **Personal data at rest** | Guest emails AES-256-GCM (row-bound AAD) + keyed HMAC for lookups; members store no copy; IPs only as keyed hashes; the admin page shows aggregates only (asserted); export is consent fields only, `users.support` + step-up + audit; CSV formula injection neutralised | ✅ (`waitlists`, `authz`) |
| T | **Stored XSS through free-text answers or survey content** | Answers stripped of markup and control characters, capped, rendered with `esc()`; question prompts and labels refused when they contain markup (CMS validator); never shown publicly; moderation queue | ✅ (`waitlists`) |
| R | **Unprovable consent** (NDPA 2023) | Time, wording version and SHA-256, source and IP hash per join; withdrawal kept as `unsubscribed_ts`; the consent wording is a versioned CMS text and a stale version is refused (`consent_changed`) | ✅ |
| E | **Unauthorised newsletter or launch email** | `announce` + reason + step-up + audit; the launch email only after a production switch, once; the `newsletter` flag stops routes and the job; nothing is sent automatically | ✅ (`waitlists`) |
| S / T | **Unverified account confirming someone else's inbox, or taking over their guest entry** (sign up with a victim's address, one-click join) | One click only for a verified account email; otherwise the join is the guest double opt-in (link to the inbox, `pending`, not counted, no newsletter, the same non-enumerating reply); a guest entry links to an account only after that account verifies the email; a link records the account that requested it | ✅ (`waitlists` unverified-join test; found in review) / residual: an inbox owner who confirms a link an impostor requested links the entry to that account (§36.9) |
| T | **Silent re-opening of Perps** | The waitlist flag migration runs once per database (meta marker), audited with the owner's reason; an admin "off" is never overridden | ✅ (`waitlists`) |

### 20. Elections hub v2 (Phase 7B, `CLONE_SPEC.md` §37)

New attack surface: admin-entered names and colours rendered on a public page and inside SVG, a results desk whose
calls propose market settlements, a simulated results feed, snapshots replayed to visitors, a public hub chat room,
a My Ballot picker, and new public read routes.

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| T | **Forged results** (a client writing votes or reporting) | No write route exists for results, tallies or snapshots; the simulator runs server-side only, behind `elections.simulator` (off by default, switched off by the production switch) and `markets.ops` + reason + audit for its controls | ✅ (`elections`, `authz`) |
| E / T | **A wrong or unilateral race call moving money** | Calls and uncalls need `resolution.write`, a reason and step-up; a winner must meet the configured win rule on the reported results; the presidency (any office marked two-person) needs a second, different person; a call only **proposes** settlements on the resolution desk, where a second resolver approves (the proposer cannot); uncall refused once a market was resolved from the call; everything hash-chain audited | ✅ (`elections`) |
| S | **Self-approval** of a two-person call or of its settlement | Approval refused for the requester (`same_person`, `same_admin`); pending requests expire after 24 h | ✅ (`elections`) |
| T | **Stored XSS through party / candidate / division names or colours** (SVG map, tooltip, cards, admin tables) | Names are plain text (markup and control characters refused at the API), escaped with `esc()` in every template, the tooltip built with text nodes; colours must be `#rrggbb` and reach CSS only as custom properties (no inline styles under the CSP); a hostile name stored by bypassing the API renders inert (tested) | ✅ (`elections`) |
| T | **Malicious media** (party logos, candidate photos) | Only ids of images in the CMS media library, which re-encodes uploads and refuses SVG and polyglots (§32.6) | ✅ |
| I | **Location privacy** (My Ballot) | No address is ever asked for: visitors pick divisions; a signed-in user may store a division id only (strict schema refuses any other field); owner-only routes with IDOR probes | ✅ (`elections`, `authz`) |
| D | **Hub chat abuse** | The §20 chat stack unchanged: per-user and per-IP limits, slow mode, mutes, bans, reports, moderation in Admin › Chat; only rooms of existing hubs; `elections.chat` + `social.chat` flags | ✅ (`elections`, `chat`) |
| D | **Expensive public reads** (hub views over ~500 races and 7,000 tallies) | One cached model per election (400 ms), bounded queries, search capped (60 characters, 20 results), snapshot reads by id, global rate tiers | ✅ / residual: per-process cache (RS1) |
| R | **Unaccountable data changes** | Every country-model edit, simulator action, call, approval, rejection and Power Index change is audited with a reason (before / after) | ✅ (`elections`) |
| T | **A flag that cannot be turned off** (a key ending in `.map` was swallowed by the perimeter honeypot) | The map flag is `elections.results_map`; a test checks every registered flag key against the honeypot patterns | ✅ (`elections`) |

### 21. Growth and reach (Phase 8, `CLONE_SPEC.md` §38)

New attack surface: owner settings that change money and data behaviour, a second referral program paying money,
public share links with a redirecting landing and attribution cookies, server-rendered public pages with an in-memory
cache, share-card images, sitemaps, a crawler exemption from the browser check, per-language translations and their
import, an SMS channel, and new member and admin routes.

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| E / R | **Silent or unauthorised change of an owner setting** (a lower confirmation lifetime, the CSV email, the SMS cap) | `settings.write`; typed and range-checked values (cross-field order for rating bands); a reason on every change; step-up for money / security / personal-data settings; hash-chained audit with before / after; history in the dialog; an environment upper bound where an operator must cap a value (`NEWSLETTER_PER_MINUTE`) | ✅ (`owner-switches`, `authz`) |
| S / T | **Referral fraud** (self-referral through a second account, trading with oneself to qualify, farming) | Volume never counts fills against the referrer; system accounts never qualify; one referrer per friend, before the first trade, within 30 days; lifetime caps; signals for the same device, the same payment instrument, many network sign-ups a day (owner setting), high risk score hold the referral in a review queue; approval needs step-up; rewards are non-withdrawable credit from the treasury (or play money) | ✅ (`growth`) / residual: heuristics (§38.11) |
| T / I | **Share-link enumeration or tampering** | 128-bit random ids with an HMAC-SHA256 signature checked before any lookup; tokens of other members' positions only expose what the sharer ticked; revocation by the sharer and by support; another member's link id answers 404 | ✅ (`growth`, `authz`) |
| T | **Open redirect through `/s/<token>`** | The redirect target is built from stored tickers on the server, never from the request; unknown, revoked, malformed or switched-off links go to `/` | ✅ (`growth`) |
| E | **Copy trade placing orders** | The copy endpoint returns a prefill only; the page never submits; orders go through the normal review and gates | ✅ (`growth`) |
| I / T | **Cache poisoning or private data in server-rendered pages** | Fragments are built from public data only, keyed by path, language, currency and the validated origin; no cookie or session is ever read or part of the key; query strings ignored (except an enabled `?lang`); forged `Host` / `X-Forwarded-Host` only see their own entry; private routes get `noindex` and no content; the page is `no-store` with a per-response nonce | ✅ (`reach` cache-poisoning test) |
| S | **Bots posing as crawlers to skip the browser check** | The exemption applies to public pages only and only while `ssr.crawlers` is on; AI crawlers are refused; private routes always get the challenge; rate tiers unchanged; exemptions are logged (`crawler_exempt`) | ✅ (`reach`) / residual: user-agent based (§38.11) |
| T | **Script or markup injection through translations** (import or editor) | Translations are CMS entries through the same validator and sanitiser (declared variables only, plain text refuses markup, rich text allowlisted); import is a dry run first and apply needs `content.publish`; imported keys are flagged "needs review"; a language cannot be switched on before review and coverage (step-up, audited) | ✅ (`reach`) |
| T | **Machine translation shown as reviewed** | All non-English languages ship off and unreviewed; samples carry a "needs review" note; the switch refuses an unreviewed language | ✅ (`reach`) |
| R / I | **Marketing or SMS consent not provable** (NDPA 2023) | SMS opt-in needs a verified phone and the versioned consent wording (version and hash stored); opt-out always works, with every flag off too | ✅ (`reach`) |
| D | **SMS abuse or cost runaway** | Off by default; simulated adapter only; only money, security, account, fill and alert notices; a daily cap per member (owner setting, step-up); a persisted outbox with `skipped_cap` | ✅ (`reach`, `owner-switches`) |
| D | **Expensive public pages and images** | Fragments and PNGs cached for the owner-set TTL; sitemaps bounded; share-click counting limited per address; rate tiers | ✅ / residual: per-process caches (RS1) |
| I | **Attribution cookies** | First-party only, `SameSite=Lax`, `plx_share` `HttpOnly`, 30 days, ids validated before use; no third-party tracker is loaded; share channels are plain links built in the browser | ✅ |

## Residual risks and planned work

- Single-process SQLite: no horizontal scaling; Phase 9 moves to PostgreSQL (P9.2).
- No WAF/CDN in front of the dev server (P9.3); TLS terminates at a reverse proxy in production (P9.1).
- Payments run on sandbox rails only (Phase 4, `CLONE_SPEC.md` §26.13): simulated providers with loopback webhook delivery
  and derived secrets, an in-process tokenizer instead of provider-hosted fields, three AML rule hooks rather than a
  monitoring programme. KYC, geolocation and fraud signals are simulations (Phase 3, `CLONE_SPEC.md` §25.14).
- Phase 7 (`CLONE_SPEC.md` §35.13): rate buckets, the replay window cache's purge and WebSocket / FIX caps are per
  process (RS1); GET requests may be replayed inside the 6 s window; FIX runs without TLS (terminate TLS in front, P9.1);
  the demo environment shares the process (and the machine) with production.
- Phase 6 (`CLONE_SPEC.md` §34.14): trailing stops and liquidations act on discrete evaluations; the liquidity account
  is the only liquidation counterparty (no liquidation queue, auction or auto-deleveraging); referral fraud checks are
  account-level only; position limits are per subaccount; throttles are per process (RS1).
- Trading core (Phase 5A, `CLONE_SPEC.md` §28.11): the two-person rule assumes distinct people behind distinct admin
  accounts; corrections are refused (not cascaded) when a combo already resolved from the leg; the MECNET guarantee is
  conservative (it assumes no outcome may win).
- Phase 5B (`CLONE_SPEC.md` §29.10): the injection filter and moderation blocklist are heuristics; output validation is
  the real control. No wash-trading or self-matching detection for incentive rewards yet. The ballot rate limit and
  the summary budget are per process (PLAN §10 RS1). A saved ballot area is not yet part of the data export.
- PWA (`CLONE_SPEC.md` §31.11): Web Push is at-least-once (a crash after the push service accepted a message re-sends
  it; the tag de-duplicates on the device); notification text is visible on lock screens; the VAPID key is tied to the
  master key, so a key change invalidates every subscription; a released service worker can only be replaced, not
  remotely disabled.

- Phase 5D (`CLONE_SPEC.md` §33.13): the flag cache, heist rate limits and job pauses are per process (RS1); the
  pre-production backup is a plain SQLite file in the data directory; region targeting uses the simulated location data
  of Phase 3; the two-person reset relies on distinct people behind distinct admin accounts.

- Phase 8 (`CLONE_SPEC.md` §38.11): the crawler exemption is user-agent based (public pages only); fragment caches,
  share-click limits and the SMS cap are per process (RS1); referral fraud signals are heuristics that hold for review;
  SMS is simulated; a manual screen-reader pass is still to do.

Review this document whenever a phase passes the §6 security gate in `PLAN.md`.
