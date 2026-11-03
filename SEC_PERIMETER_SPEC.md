## 21. Perimeter security

Status 2026-11-03 · PLAN Phase 1A (P1.1, P1.2, P1.3, P1.10, P1.11, P1.12, gaps G7 and G13) · branch `phase-1-security`.
Evidence ids (S1–S12) are the observations in `PLAN.md` §2; everything else is a Parlance design choice, stated as such.
Tests: `clone/tests/security-perimeter.e2e.test.js` (12 browser + HTTP tests, run against the production bundle).

### 21.1 Where the controls sit

| Order | Stage | File | What it does |
|---|---|---|---|
| 1 | `security.early` | `server/security.js` | Per-response CSP nonce and security headers; CORS; `robots.txt`; honeypots; `POST /v1/csp-report`; `POST /v1/bot/challenge`; `POST /v1/client_token`. Runs before body parsing and before the session / CSRF middleware, so these endpoints never need a session or CSRF token. |
| 2 | session + CSRF | `server/auth.js` (Phase 1B) | `req.auth`, session CSRF, login CSRF. |
| 3 | `security.apiGuard` | `server/security.js` → `server/bot.js` | Tiered rate limits on `/v1` and `/trade-api`; signed client token on every `/v1` write. |
| 4 | routes | `server/app.js` … | Unchanged. |
| 5 | `security.mountStatic` | `server/security.js` | Explicit static allowlist, hashed immutable assets, SPA page template (nonce + boot proof), bot challenge for suspicious HTML requests, 404 for everything else. |
| WS | `security.checkUpgrade` | `server/ws.js` | Origin allowlist + client token on the `/v1/ws` upgrade. |

All state is in SQLite: `security_events`, `security_challenges_used`, `rate_buckets`, and the settings rows `security.rate_limits`, `security.bot`, `taker_fee`, `rolling_window` in `admin_settings`. The signing key is an HKDF sub-key (`bot-management:v1`) of the deployment master key in `server/crypto.js` (Phase 1B): `SECRET_KEY`, else `data/secret.key` next to the database, generated with mode 0600 on first run, git-ignored, covered by the `.claude` deny rules, never logged.

### 21.2 Security headers and CSP (P1.1; S5, S6, S12)

| Header | Value | Evidence / choice |
|---|---|---|
| `Content-Security-Policy` (HTML) | `default-src 'self'; script-src 'self' 'nonce-N'; style-src 'self' 'nonce-N'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://H wss://H; frame-ancestors 'self'; base-uri 'none'; form-action 'self'; object-src 'none'; manifest-src 'self'; worker-src 'self'; report-uri /v1/csp-report; report-to csp` | S12 (nonces on scripts/styles), S6 (`frame-ancestors`). `H` is the request's own host, validated against a host pattern before it is echoed. No `unsafe-inline`, `unsafe-eval` or wildcards. |
| `Content-Security-Policy` (everything else) | `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` | S5 (API sends `default-src 'none'`). Applied to API, static and 404 responses. |
| `Reporting-Endpoints` | `csp="<origin>/v1/csp-report"` | Choice: Reporting API plus legacy `report-uri`. |
| `X-Content-Type-Options` | `nosniff` | S5 |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Choice |
| `Permissions-Policy` | `accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), usb=(), browsing-topics=()` | Choice: the app uses none of these. Geolocation will be re-enabled for `self` when P3.6 lands. |
| `Cross-Origin-Opener-Policy` / `-Resource-Policy` | `same-origin` / `same-origin` | Choice |
| `X-Frame-Options` | `SAMEORIGIN` | Legacy twin of `frame-ancestors` (S6). |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | S5. Only when `NODE_ENV=production`, or behind a trusted proxy (`TRUST_PROXY`) that reports `X-Forwarded-Proto: https`. A spoofed header without trust is ignored (tested). |
| `Cache-Control` | `no-store` on any response with a session and on `/v1/users/*` | S5. Decided when headers are written, because the session is attached after the header middleware. HTML is also `no-store` (it carries a nonce); the challenge is `private, no-store` (S1). |

The nonce is 16 random bytes (base64) per response. `public/index.html` is a template: the server replaces the nonce placeholders on the stylesheet links and the module script and fills `<meta name="plx-boot">`; the test checks the nonce rotates per response and every `nonce=""` attribute matches the header.

**CSP reports.** `POST /v1/csp-report` accepts `application/csp-report` (legacy) and `application/reports+json` (Reporting API), 16 KB maximum (413 above, 415 for other types), at most 20 stored per IP then one every 5 s (excess answered 204 and dropped). Each report is stored as a `csp_report` security event with query strings stripped from URLs and the sample cut to 80 characters.

### 21.3 Strict style CSP: no inline styles (G13)

All 115 `style="…"` attributes in `public/js/**` were removed (`grep style= public/js` finds none). Two replacements:
- Static values → utility classes in `public/utilities.css` (`.m-0`, `.mt-8`, `.d-flex`, `.c-yes`, `.center-60` …). They carry `!important` so they keep the precedence the inline attributes had over component rules.
- Dynamic values (bar widths, series and team colours, depth meters, chart heights) → `data-vars="--name:value"` emitted by `vars()` in `public/js/dynstyle.js`. One `MutationObserver` applies them through the CSSOM (`element.style.setProperty`), which CSP allows, before the next paint. `.v-bg`, `.v-w`, `.v-h`, `.v-flex`, `.v-color` read them. Only `--custom-properties` are accepted; `;` is stripped from values.

The E2E test visits 16 public routes and 15 signed-in/admin routes in Chromium with a `securitypolicyviolation` listener and requires zero violations. A positive control (an injected `style` attribute is reported) proves the detector works. The challenge page itself uses a nonce'd `<style>` and `<script>`.

### 21.4 Self-hosted fonts (P1.2)

Inter (variable, 100–900) and Barlow Condensed 600/700, latin and latin-ext subsets, from `@fontsource-variable/inter@5.3.0` and `@fontsource/barlow-condensed@5.3.0`, in `public/fonts/` with their SIL OFL 1.1 licences (`OFL-Inter.txt`, `OFL-BarlowCondensed.txt`, published at `/fonts/*.txt`). `public/fonts.css` declares them; the Google Fonts links are gone, so the CSP needs no third-party origin. The test checks both families load and every request the page makes is same-origin.

### 21.5 CORS (P1.3; S4)

- Allowed origins: `ALLOWED_ORIGINS` (comma-separated) or `start({ security: { allowedOrigins } })`, plus the server's own origin (from `Host` and the trusted protocol).
- Preflight from a foreign origin → **403** `origin_not_allowed` (S4), logged as `cors_rejected`. From an allowed origin → **204**, `Access-Control-Allow-Origin: <origin>`, `-Allow-Credentials: true`, `-Allow-Methods: GET, POST, PUT, PATCH, DELETE`, `-Allow-Headers: Content-Type, X-Csrf-Token, Idempotency-Key, X-Client-Token` (S4 list, with our client-token header in place of the WAF header), `-Max-Age: 600`.
- Actual requests from an allowed origin get `Access-Control-Expose-Headers: X-Csrf-Token, Etag` (S4). Foreign origins get no ACAO. Foreign-origin **writes** (for example a cross-site form post) are refused with 403 before any route runs. Choice: S4 only shows the preflight behaviour.
- `Vary: Origin` on every response to a request with an `Origin`.

### 21.6 Bot management (P1.10; S1, S2)

**Suspicion score** for HTML requests (choice; thresholds are not observable): automation or crawler User-Agent, or none (+3); `Accept` without `text/html` (+1); no `Accept-Language`, or `*` (+1); not a browser navigation (`Sec-Fetch-Mode: navigate` / `Sec-Fetch-Dest: document`), counted only on potentially trustworthy origins (https, localhost), because browsers send Fetch Metadata only there (+2); Chrome UA without client hints (+1); more than `html_per_minute` HTML pages from one IP in a minute (+3). A score of 3 or more is challenged. Headless Chromium (Playwright) scores 1 (no `Accept-Language`) and passes. `HeadlessChrome` is deliberately not flagged: a JavaScript-capable browser solves the challenge anyway, so challenging it only adds latency.

**Proof-of-work challenge** (S1: 429 + `cache-control: private, no-store` on every HTML route). The response is HTTP 429 with `X-Plx-Mitigated: challenge`, the site CSP, and a page whose nonce'd script finds `n` with `SHA-256(id:n)` having `d` leading zero bits (default 14, about 16k hashes, tens of milliseconds). The SHA-256 is pure JS, because `crypto.subtle` is missing on plain-http origins. The challenge (`id`, time, difficulty, IP+UA binding) is HMAC-signed. `POST /v1/bot/challenge` checks the signature, binding, a 2-minute age limit, the proof and single use (`security_challenges_used`). It then sets `plx_chk` (HttpOnly, SameSite=Lax, 30 min, `__Host-` + `Secure` over https), bound to an HMAC of IP + User-Agent, and the page reloads. Choice: verify answers 200/403, not S1's 708. Challenge modes are `off`, `suspicious` (default) and `all` (attack mode, also the test hook `start({ security: { challengeMode: 'all' } })`), switchable live in Admin › Settings. `robots.txt` is never challenged (S1 challenges it; choice: crawlers must be able to read the policy).

**Signed client token** (S2: `x-aws-waf-token` on API calls, `AwsWafTokenForWebSocket`). Every page the server renders carries a signed boot proof (10 min, bound to IP+UA). A challenged client only gets one after passing. After load, `public/js/security.js` posts it to `/v1/client_token` and receives `{token, expires_in}`: HMAC-signed `{issued, expires, binding}`, 15 min by default, also set as an HttpOnly SameSite=Strict `plx_ct` cookie. The SPA sends it as `X-Client-Token` on every write (`api.js`, admin `ui.js`), as `ct=` on the WebSocket URL (`ws.js`), and refreshes it at half-life using the current token. Expired tokens can be exchanged for 12 h, so a sleeping laptop recovers. A 403 `client_token_*` triggers one silent refresh and retry. The server requires a valid token (header, else cookie) on every `/v1` POST/PUT/PATCH/DELETE (403 `client_token_required` / `client_token_invalid`). The WebSocket upgrade requires an allowed `Origin` (if one is sent; this also blocks cross-site WebSocket hijacking) and a valid token, else `HTTP 403` before the handshake. Rejections are logged (`client_token_rejected`, `ws_rejected`).

**Honeypots** (P1.10/P1.12): any dot-segment except `/.well-known/` (`/.env*`, `/.git/*`, `/.DS_Store` …), `/wp-admin`, `/wp-login.php`, `/xmlrpc`, `/phpmyadmin`, `/cgi-bin`, `/actuator`; `/server/`, `/data/`, `/node_modules/`, `/scripts/`, `/tests/`, `/dist/`; `package(-lock).json`, `secret.key`, config files; extensions `.map .sqlite .db .db-wal .sql .bak .env .key .pem .log .php …`. Paths are percent-decoded first (`/%2e%65nv` is caught). The response is a plain-text 404 (never the SPA page) and a `honeypot` event. Choice: S1 answers these with the challenge; the brief asks for 404.

**`robots.txt`**: disallows 20 AI training / answer-engine crawlers (GPTBot, ClaudeBot, CCBot, Google-Extended, PerplexityBot …) and keeps `/v1/`, `/trade-api/`, `/admin`, `/account`, `/portfolio` out for everyone. It states in the file that it is **advisory only**: well-behaved crawlers honour it, and enforcement is the challenge, tokens and rate limits.

**Tiered rate limits** (replaces the single per-IP bucket; 429 `too_many_requests` with `Retry-After`, spec §5.4 envelope unchanged):

| Tier | Key | Default | Applies to |
|---|---|---|---|
| anonymous | IP | `RATE_BURST` / `RATE_PER_SEC` (300 / 150 s⁻¹) | `/v1` + `/trade-api` without a session; the client-token bootstrap |
| user | account | 2× anonymous | signed-in requests |
| admin | account | 5× anonymous | staff (admin flag or any admin role) |
| auth | IP | 60 burst, 1 s⁻¹ | `POST /v1/log_in*`, `/v1/users` (sign-up), `/v1/password*`, challenge verify; on top of the tier |
| write | account or IP | 300 burst, 30 s⁻¹ | every mutation; on top of the tier |

Token buckets live in memory. Every 2 s, buckets that are not full are written to `rate_buckets`, and full ones are deleted (a full bucket is the default). They are reloaded at boot, so a restart does not reset an attacker's allowance (tested). The flush never runs inside another transaction. Phase 1B's per-account login backoff sits on top of this.

**Security event log** `security_events(ts, kind, ip, ua, method, path, user_id, detail)`. Kinds: `challenge_served`, `challenge_passed`, `challenge_failed`, `honeypot`, `csp_report`, `rate_limited`, `client_token_rejected`, `ws_rejected`, `cors_rejected`. Writes are throttled per kind+IP (20, then one per 3 s), so a flood cannot fill the disk. Retention is 30 days and 200k rows. **Admin › Security** (`/admin/security`, permission `audit.read`, `GET /v1/admin/security/events?kind=&ip=&limit=`) shows 24-hour counts per kind and a filterable table.

### 21.7 Asset hygiene (P1.11; S3)

`npm run build` (`scripts/build.js`, esbuild 0.28.2 pinned as a devDependency) writes `dist/`:
- `assets/main-<hash>.js` plus `chunk-<hash>.js`: ESM, code-split, minified, no legal comments.
- `assets/app-<hash>.css`: every stylesheet linked from `index.html`, in order.
- `<font>-<hash>.woff2`, `index.html` (the template, now referencing the hashed files) and `manifest.json` (source hash, entries, file list).

No `.map` files and no `sourceMappingURL` comments: the build fails if either appears. It builds into a temporary directory and swaps it in. Admin sections now use literal `import()`s so the bundler can split them. Hashed assets are served with `cache-control: public, max-age=31536000, immutable` (S3). In production mode, `/js/*` sources, per-file CSS and `*.map` all answer 404.

Modes: `npm start` (and `NODE_ENV=production`, or `ASSETS=dist`) serves `dist/`, rebuilding first when it is missing or its source hash is stale. `npm run dev` / `ASSETS=src` serves `public/` unbundled (`no-cache`); the existing E2E files use this mode, and the perimeter test uses `dist`. Without dev dependencies (`npm ci --omit=dev`) a stale `dist/` is a startup error, so build before deploying.

### 21.8 Static allowlist (P1.12)

Served: `/assets/*.{js,css,woff2}` (dist), or `/js/**/*.js`, the root `*.css` files that exist and `/fonts/*.woff2` (dev); `/fonts/*.txt` (licences); `/robots.txt`. The SPA page is served only for GET/HEAD on extension-less paths with no dot-segment, outside `/v1` and `/trade-api`. Anything else (`/foo.png`, `/index.html`, `/manifest.json`, `/markets/x/y/z.json`) is a plain 404. `dotfiles: 'deny'` and `redirect: false` on every static mount.

### 21.9 Runtime-editable exchange settings (G7)

Admin › Settings & health has a new **Exchange & perimeter** form (`PUT /v1/admin/settings`, permission `settings.write`). It edits the taker fee coefficient (0–0.25, 4 decimals), the rolling window (5–86,400 s), the burst and per-second rate of every rate-limit tier, and the bot settings (challenge mode, PoW difficulty 4–24, client-token lifetime, challenge-pass lifetime, HTML pages per minute). Validation is per field.

Every save is one audited `settings.update` entry (before/after of the whole settings view, hash-chained by Phase 1B) and takes effect without a restart:
- The fee is an integer in 1/10,000ths inside `engine.js`, so the arithmetic stays exact. At 0.07 it gives bit-identical results to the old constant (checked over a full price × size × multiplier grid). The next fill uses the new value (tested: 10 contracts at 0.035).
- `rolling.js` opens the next window on the new grid; open windows keep their stored close time.
- Rate tiers and bot settings reload in memory.

Persisted values are applied at boot. They take precedence over `ROLLING_WINDOW_SEC` and `RATE_*`, which become defaults.

### 21.10 Tests (`tests/security-perimeter.e2e.test.js`)

1. Headers on HTML / API / static; `no-store` on authenticated and `/v1/users/*` responses; HSTS only behind a trusted https proxy, with a spoofed header ignored.
2. CSP nonce rotates per response and matches every `nonce=` attribute; no placeholders and no inline styles in the page.
3. Zero CSP violations on 31 routes in Chromium (with a positive control); fonts self-hosted; all requests same-origin.
4. CSP reports: both formats, query stripping, truncation, 415/413, flood capped.
5. CORS: foreign preflight 403, partner 204 with exact headers, expose headers, own origin allowed, foreign write 403 + event.
6. Challenge: curl / python-requests / no UA / GPTBot get the 429 page; robots.txt is open; wrong PoW, foreign binding and replay are refused; the pass cookie admits curl; the Node helper earns a token; Chromium is not challenged; a forced challenge is solved transparently by Chromium.
7. Client token: missing / forged / tampered / foreign-UA / expired → 403 on writes; WS refused without a token, with a forged or expired token, or with a foreign Origin; an expired token is refreshed; a bad bootstrap is refused; the SPA sends the header, the `ct` URL parameter and the cookie.
8. Honeypots → 404 text + events (path, IP, UA); sources and maps 404 in production; no maps built.
9. Hashed assets: immutable, minified, manifest matches the served entries, fonts hashed.
10. Rate-limit tiers: auth bucket, user vs anonymous separation, 429 envelope + `Retry-After`, buckets persisted across restart.
11. G7: admin edits fee / window / tier / PoW in the UI, validation error shown, rows + audit entry written, the next trade pays 0.035, Admin › Security lists and filters events, non-staff get 403.
12. Restart: events, used challenges, settings (fee and window re-applied), 0600 secret, pre-restart token still valid.

Node-side API clients in other test files obtain tokens through `tests/helpers/client-token.js`, which solves the challenge like any script would. Phase 1C's `tests/lib/client.js` does the same through the boot proof.

### 21.11 Residual risks

- **These controls raise cost; they are not a wall.** A determined script can run a real or headless browser, pass the PoW and replay the boot proof → client token chain. Its value is pricing out bulk HTTP clients and making abuse visible (PLAN §2). Difficulty and attack mode are the levers.
- IP + UA binding breaks on mobile IP changes (the page's client recovers by refreshing; a challenge pass needs a re-solve). Behind a proxy, `TRUST_PROXY` must be set, or every client shares the proxy's IP for rate limits and bindings.
- Rate limits and the HTML counter are per process. Several instances would need a shared store (planned with P9.2 PostgreSQL).
- The own-origin rule trusts `Host`. DNS rebinding against a local dev server could reach unauthenticated endpoints (cookies stay with the real host). A `PUBLIC_ORIGIN` / allowed-hosts check would close it.
- The taker fee coefficient is process-global (one exchange per process). Admin edits affect only new fills; resting-order fee reserves computed at the old coefficient are not re-priced, though the refund logic returns any unused reserve.
- `robots.txt` is advisory; the honeypot list is a denylist and cannot be exhaustive. The static allowlist is the real guarantee.
- The challenge page's PoW can be solved off-page by a script (the helper does exactly that). The signature, binding, 2-minute expiry and single use limit reuse, not solving.
- CSP reports via the Reporting API are batched by the browser and sent only to trustworthy origins; the legacy `report-uri` covers the rest.
