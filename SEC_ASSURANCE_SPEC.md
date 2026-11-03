# Parlance security specification — assurance

Companion to `PLAN.md` (Phase 0 and Phase 1C), `SECURITY.md` (disclosure policy and STRIDE threat model) and the other
Phase 1 sections (`SEC_PERIMETER_SPEC.md` §21, `SEC_IDENTITY_SPEC.md` §22).

## 23. Assurance, CI and guardrails

Scope: PLAN P0.1 (CI), P0.2 (Dependabot), P0.3 (Windows notes), P1.7 (authorization matrix), P1.8 (input/output safety),
P1.9 (idempotency keys), P1.13 (repository and agent guardrails) and gap G2 (cost-capped orders). Everything here is
either a check that runs automatically (CI, pre-commit, lint, tests) or a server control proven by an end-to-end test.

### 23.1 Continuous integration (`.github/workflows/ci.yml`)

Runs on every push and pull request; four jobs, each meant to be a required check on `main` (branch protection, PLAN
P0.1 exit criterion).

| Job | What it does | Fails when |
|---|---|---|
| **test** | Node 22, `npm ci` (lockfile only), `npm audit --audit-level=high`, `npm run lint`, bundled secret scan of tracked files, `npm run build --if-present`, `npx playwright install --with-deps chromium`, full `npm run test:e2e`. On failure uploads the test temp directory (SQLite files, `e2e-output.txt`) as an artefact for 14 days. | any high/critical advisory, lint error, undocumented env var, secret finding, build error or failing test |
| **secrets** | gitleaks over the **full history** (`fetch-depth: 0`): a secret removed in a later commit is still a leak. | any finding |
| **codeql** | CodeQL `javascript-typescript`, `security-extended` queries, over `clone/server`, `clone/public`, `scripts`. Results land in the Security tab. | a CodeQL error result |
| **zap** | Starts the real server (fresh DB, sports off) and runs the OWASP ZAP baseline (passive scan + AJAX spider) against it; `scripts/zap-gate.js` then reads `report_json.json`. | any **High or Medium** alert not accepted in `.zap/rules.tsv`, or any alert whose rule is marked `FAIL` there |

Design choices:
- **Third-party actions are pinned to full commit SHAs** (tag in a trailing comment). A moved tag cannot change what CI
  runs; Dependabot (`github-actions` ecosystem) proposes SHA bumps weekly.
- `permissions: contents: read` at workflow level; only the jobs that need more get it (`security-events: write` for
  CodeQL, `pull-requests: write` for gitleaks PR comments). `persist-credentials: false` on every checkout.
- ZAP runs with `fail_action: false` and the gate script decides, because ZAP's own exit code treats every WARN as a
  failure and cannot distinguish risk levels. `.zap/rules.tsv` has two kinds of entries: **IGNORE** with a written
  justification (the gate refuses an IGNORE without one) and **FAIL** for perimeter controls that must never regress
  (CSP, anti-clickjacking, `nosniff`, CORS, cookie flags, `X-Powered-By`). Accepted today: 10202 (no anti-CSRF form
  token — the SPA posts JSON with a header token), 10035 (HSTS over plain localhost), 10096 (timestamps are public market
  data), and three informational rules.
- `concurrency` cancels superseded runs of the same ref.
- The workflow was validated with `actionlint` 1.7.12 and a YAML parse.

**Dependabot** (`.github/dependabot.yml`): npm in `/clone` and GitHub Actions, weekly (Monday 06:00 UTC); dev-tooling
minor/patch updates grouped; all actions updates grouped.

### 23.2 Pre-commit hook and secret scanning (`.githooks/pre-commit`)

Installed automatically by `npm install` in `clone/` (`prepare` → `scripts/install-hooks.js` sets
`git config core.hooksPath .githooks`; skipped outside a git checkout or with `SKIP_GIT_HOOKS=1`). It runs:
1. `scripts/secret-scan.js` on the **staged** content (the index, not the working tree). Rules: private key blocks, AWS
   key ids, GitHub/GitLab/Slack/npm/Stripe/Google/Anthropic/OpenAI token formats, JWTs, credentials in URLs, and a
   generic `secret|password|api_key|token = "…"` rule gated on Shannon entropy ≥ 3.5 (so `password: 'parlance-demo'`
   style fixtures do not trip it). It also **blocks file types** outright: `.env*` (except `.env.example`), key material
   (`*.pem`, `*.key`, `*.p12`, `id_rsa*` …) and database files (`clone/data/**`, `*.db`, `*.sqlite`). Findings are printed
   redacted. A deliberate fixture line can carry `secret-scan:allow`; whole paths can be listed in `.secretscanignore`.
2. `gitleaks git --pre-commit --staged` when gitleaks is installed (falls back to `gitleaks protect --staged` on older
   releases) — the same engine CI uses.
3. `scripts/audit-gate.js`: `npm audit --json --audit-level=high` in `clone/`; blocks on high/critical advisories, but
   only warns when the registry is unreachable so offline commits stay possible (CI is strict).

`git commit --no-verify` bypasses the hook; CI re-runs the same checks, so a bypass only delays the failure.

### 23.3 Agent and repository guardrails (P1.13)

- `.claude/settings.json` — Claude Code `permissions.deny` rules (schema-validated against
  `json.schemastore.org/claude-code-settings.json`): `Read` of `.env`, `.env.*`, `clone/.env*`, `clone/data/**`
  (including `secret.key`), `**/*.pem`, `**/*.key`, `**/*.p12`, `**/*.pfx`, SSH keys, `*.db`/`*.sqlite`,
  `**/secrets/**`, production configs, `~/.aws`, `~/.ssh`, `~/.npmrc`, `~/.config/gh`; `Edit` of `clone/data/**` and
  `.git/**`; and Bash denies for `cat/less/head/tail/source` of `.env*`, reading `clone/data/*` (`cat`, `sqlite3`,
  `xxd`, `strings`), dumping keys (`openssl … -in *.key`, `base64 *.pem`), `printenv`/`env`, disabling the hooks
  (`git config core.hooksPath …`, `git commit --no-verify`/`-n`) and force pushes. Each path appears both in `./…` form
  (relative to the working directory) and `/…` form (anchored at the repository root), so sessions started in `clone/`
  are covered too. Read denies also stop Claude Code's Edit/Write tools on those paths.
  - Trade-off: `Read(./.env.*)` also covers `clone/.env.example`, so agents cannot open or edit the example file with
    their file tools. That is acceptable: it holds no secrets, humans maintain it, and `scripts/check-env-example.js`
    (part of `npm run lint`) fails CI whenever a server env var is missing from it.
  - These rules are guardrails against accidents, not a boundary: a script an agent writes can still open any file. The
    real protection is that production secrets and real databases never exist on development machines (PLAN §2).
- `.gitignore`: `.env*` (except `.env.example`), key material, database files, `.claude/settings.local.json`, generated
  `clone/dist/`, test and ZAP reports. `.gitattributes` keeps hooks and scripts LF on Windows checkouts.
- `clone/.env.example` documents every variable read under `clone/server/` (checked by `scripts/check-env-example.js`,
  which understands `process.env.X`, `process.env['X']`, `env('X')`-style readers and destructuring).
- `.github/CODEOWNERS`: owner review on CI/guardrail files, identity/perimeter/authorization code, the matching engine,
  perps, combos/RFQ, the ledger, client code that handles tokens or renders user content, and the security tests.
- `SECURITY.md`: disclosure policy (private advisory, response targets, safe harbour) and the STRIDE threat model for
  authentication, trading/ledger, payments, admin, social/chat, WebSocket, perps and combos/RFQ, with mitigations mapped
  to files, PLAN items and the tests that prove them.

### 23.4 Lint: unsafe HTML sinks (P1.8 output encoding)

`clone/eslint.config.js` (flat config, ESLint 10.13.0, exact-pinned devDependencies) — security rules only, no style:
- **`parlance/no-unescaped-html`** (`clone/eslint-rules/no-unescaped-html.js`, the "equivalent custom rule"). Checks
  (1) every `${…}` inside any template literal that contains HTML markup, wherever it is written, and (2) every value
  written to `.innerHTML`, `.outerHTML`, `.srcdoc` or `.insertAdjacentHTML()`. A value is safe when it is a literal, a
  number/boolean result, `esc()`/`encodeURIComponent()`, number/date formatting, a call to a function declared or
  imported in the module (an HTML builder whose own templates are checked where they are written), a `const`/`let`
  whose every assignment is safe, a member of a constant lookup table, an ALL_CAPS module constant, a callback parameter
  iterating a literal table or an index parameter, or `list.map(safe).join(…)`. Everything else — API data, function
  parameters, unknown method results — must be wrapped in `esc()` or annotated.
- Mozilla **`eslint-plugin-no-unsanitized`** 4.1.5 (`no-unsanitized/method`) for the remaining code/markup sinks:
  dynamic `import()`, `document.write/writeln`, `createContextualFragment`, `setHTMLUnsafe`, `parseHTMLUnsafe`,
  `DOMParser.parseFromString`. (`no-unsanitized/property` is not used: it cannot follow `esc()` inside a template, which
  the custom rule does.)
- `no-eval`, `no-implied-eval`, `no-new-func`, `no-script-url` everywhere.
- **`parlance/require-disable-justification`**: an `eslint-disable` comment for any of these rules must carry
  `-- <reason>` (≥ 12 characters).

Findings on introduction: 281 → 0. Of these, ~200 data values (API fields such as sides, statuses, counts, scores,
tickers, ids; helper parameters such as labels, class names, colours, hrefs) were wrapped in `esc()`; ~25 false
positives were removed by teaching the rule the patterns above; 11 sites are annotated with a justification because the
value is markup by contract (`dialog(html)`, `confirmAction({body, extraHtml})`, `section(title, sub, actions)`,
`formHtml({extra})`, table `rowAttrs`/`render` callbacks, the header menu, `winBar(attrs)`, the order-edit form row, the
combo leg row, the info-card icon constant, the help-page link substitution on already-escaped text). Two
double-escaping regressions the first mechanical pass introduced (home info cards, perps fill source) were caught in
review and fixed by escaping once, at the sink.

`npm run lint` = `eslint .` + `node ../scripts/check-env-example.js`.

### 23.5 Request validation and body limits (`clone/server/validate.js`, P1.8)

- **Per-route JSON body limits** replace the single global `express.json({limit: '64kb'})`: deposits/withdrawals and
  perps transfers 1 KB; log in/sign up/client token 4 KB; orders, amend/decrease, perps orders/close/exit triggers 4 KB;
  chat 4 KB; social and RFQ/quotes 8 KB; admin CSV import 256 KB; everything else keeps 64 KB. Over the limit →
  `413 payload_too_large` with the limit in `details` (previously a 500).
- **Declarative schemas** for the highest-risk writes (orders, amend/decrease, deposits, withdrawals, perps
  transfers/orders/close, RFQ accept, social posts/comments/reports, chat messages, admin catalog writes): body must be a
  JSON object with a bounded number of fields; each known field has allowed types, string length caps, numeric ranges
  or patterns (e.g. `client_order_id` ≤ 64 chars, `client_transfer_id` `[A-Za-z0-9_.:-]{1,64}`). Money routes
  (deposits, withdrawals, perps transfers/close) **reject unknown fields**; the others ignore them (Kalshi-style APIs
  accept optional fields) but still type-check the known ones. Errors are `400 validation_failed` with a `fields` map,
  the same envelope as the admin validator.
- Handlers keep their semantic checks and messages; the schemas stop type confusion (`{"amount_dollars": {"$gt": 0}}`,
  arrays as tickers, objects as post bodies) before handler code runs.
- Validation runs only for requests that will reach the handler: anonymous requests, another user's `/users/:uid` and
  non-staff requests on admin routes skip it, so authorization errors keep precedence and reveal nothing.
- Wired with two lines in `server/app.js`: `app.use(jsonBody())` and `v1.use(validateRoutes(…))` (registered first on
  the v1 router, so admin-mounted routes are covered).

### 23.6 Idempotency keys (`clone/server/idempotency.js`, P1.9)

- Header `Idempotency-Key: [A-Za-z0-9_.:-]{1,255}` on `POST /users/:uid/orders`, `/deposits`, `/withdrawals`,
  `POST /perps/orders`, `/perps/transfers`, `/perps/positions/:ticker/close`, and RFQ `…/quotes/:qid/accept` and
  `…/confirm` (both path forms).
- Table `idempotency_keys(user_id, idem_key, route, request_hash, status, response, created_ts)`, primary key
  `(user_id, idem_key)`. `request_hash` = SHA-256 of method, full path and the canonical JSON body (sorted keys).
- First request: a placeholder row is written, the handler runs, the response status and JSON body are stored.
  Same key + same hash within 24 h → the stored response is replayed with `Idempotent-Replayed: true` (the handler does
  not run). Same key + different hash → `409 idempotency_key_conflict`. A request arriving while the first is still
  running → `409 idempotency_key_in_progress`; a placeholder older than 60 s (crashed request) is discarded.
- **Not stored:** 5xx, 401, 403 (step-up required, client-token errors), 408, 425, 429 — the operation did not run, so
  the client's retry with the same key must execute. Business errors (e.g. 409 `insufficient_balance`) are stored, as
  the operation's outcome.
- Keys are per user, survive restarts (SQLite), and expire after 24 h (purged lazily, at most once a minute).
- Runs after authentication and after the admin lock/feature middleware; requests the route will refuse (anonymous,
  another user's uid) are left to the route.
- **Client:** `public/js/api.js` generates one key per user action (`crypto.randomUUID()`) for deposits, withdrawals,
  orders, RFQ accept and quote confirm, and `perps-api.js` for perps orders, transfers and close. The key travels with
  the request options, so `request()`'s automatic retries (client-token refresh, step-up) resend **the same key**: a
  retried action executes once. A new click is a new key.
- CORS already allows the header (`server/security.js` allowlist), matching S4.

### 23.7 Gap G2 — Dollars / target-cost orders never exceed the cap

Cause: `placeOrder(max_cost_cents)` shrank the order one step at a time (at most 1,000 iterations) against a
*reservation bound* (`R(n)` plus a rounding buffer), and placed the order anyway when the loop ran out or reached the
minimum size. Each fill's principal and fee are rounded up per maker, so against many small makers the real cost per
0.01 contract can be several times the nominal price (2¢ vs 0.52¢ at 50¢): reproduced as **$66.31 spent on a $15.00
Dollars order** across 3,000 makers of 0.01 contracts.

Fix (`server/engine.js`): a cost cap forces IOC with an **exact** reservation (each planned fill's ceil'd principal +
fee), and the size is the largest multiple of the market's step whose exact planned cost fits the cap, found by binary
search (planned cost is non-decreasing in size). The per-maker rounding is therefore inside the budget; an amount below
the smallest fill is `400`; an invariant check refuses any plan above the cap. Whole-contract markets keep whole-contract
sizing; fills and ledger entries are unchanged otherwise.

Proof: `idempotency.e2e.test.js` › G2 inserts 3,000 resting 0.01-contract makers at the best price and places a $15
Dollars order: spend ≤ $15, spend = fills' principal + fees, at most one fill's cost left unspent, nothing left reserved.
The same test fails against the previous engine (spent 6,631¢).

### 23.8 Authorization matrix (`clone/tests/authz.e2e.test.js`, P1.7)

- **Route enumeration at runtime:** the test walks the live Express router stack (`app.router.stack`, recursing into
  routers listed in `app.locals.routers`, the one-line mount table added to `server/app.js`). An unclassified route, a
  stale table entry, or a router mounted without a mount-table entry fails the suite — new routes must be classified.
- **Expectations table** (`EXPECT`): every route is `public`, `user`, `owner` (`/users/:uid`), `staff`, `perm:<p>`
  (admin permission, `ROLE_PERMS` imported live from `server/admin.js`), `self+perm:<p>` (social-admin) or
  `legacy-admin` (`users.is_admin`). 252 routes today.
- **Probes** (> 1,000 per run): anonymous → `401 token_authentication_failure` unless public; a signed-in user → passes
  the gate on user/owner routes, `403 forbidden` on staff routes; **IDOR** → user B on user A's `/users/:uid/…` is
  `403` for every such route; each of the six admin roles → allowed exactly when the role has the route's permission,
  else `403`. Probes go through the real perimeter (client token, CSRF, login CSRF) like the SPA. Destructive probes
  (log out everywhere) use disposable principals.
- **Object-level IDOR** through B's own paths with A's object ids: orders (read, queue position, amend, decrease,
  cancel), perps orders (read, cancel), RFQs (read, cancel), quotes (read, delete, accept, confirm), posts and comments
  (delete), chat messages (delete), notifications (mark read), price alerts (delete), sessions (revoke) — all refused,
  and A's rows are verified unchanged.
- **WebSocket:** anonymous sockets are refused every private channel (`code 9`); a socket with A's cookie but a wrong
  CSRF token is anonymous; a foreign `Origin` is refused at the upgrade; while A trades and deposits, B's socket
  (subscribed to all private channels) receives none of A's events; broadcast RFQ events carry no user id or email.
- Mutation-checked: misclassifying a route (public↔owner, wrong permission, user→admin) makes the matrix fail.
- Result: **no authorization defect found** in the current route set; all 252 routes behave as classified.

### 23.9 How to run locally

```bash
cd clone
npm install                     # also installs the pre-commit hook
npm audit --audit-level=high    # dependency advisories
npm run lint                    # ESLint security rules + .env.example coverage
node ../scripts/secret-scan.js --all     # bundled secret scan of tracked files (or: gitleaks git .)
npm run test:e2e                # full suite (includes authz + idempotency)
node --no-warnings --test tests/authz.e2e.test.js tests/idempotency.e2e.test.js   # just these two
# ZAP baseline (needs Docker):
npm start &                     # http://localhost:3000
docker run --rm --network=host -v "$PWD/..:/zap/wrk:rw" ghcr.io/zaproxy/zaproxy:stable \
  zap-baseline.py -t http://localhost:3000 -c .zap/rules.tsv -J report_json.json -a -j || true
node ../scripts/zap-gate.js ../report_json.json ../.zap/rules.tsv
```
