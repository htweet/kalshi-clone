# Parlance Exchange (clean-room clone)

A functional binary event-contract exchange built only from `../CLONE_SPEC.md`. Layout, page structure and features follow the live site as captured on 2026-11-02 (spec §13). It uses its own name, logo, palette, typefaces (Inter and Barlow Condensed, self-hosted, SIL OFL), copy and invented seed data. No third-party code or assets.

## Run

```bash
npm install
npm start            # http://localhost:3000, or the next free port if 3000 is taken (DB at data/parlance.db, auto-seeded);
                     # serves the hashed production bundle in dist/, built first if missing or stale
npm run dev          # same, but serves the unbundled sources from public/ (no build step)
npm run build        # build dist/: content-hashed, minified JS/CSS + fonts, no source maps (scripts/build.js)
npm run seed         # wipe and re-seed the database
npm run test:e2e     # 226 end-to-end browser scenarios across 27 files (Playwright + node:test)
```

**If it won't start.** The server prints `Could not start Parlance Exchange: …` with the reason:
- *Node … is too old*: install Node 22.5 or newer (`node -v` to check). The database layer is `node:sqlite`.
- *Another Parlance server (process N) is already using …*: one really is running, because the lock is an OS file lock that is released whenever a server exits, even after a crash. Use that one, stop it (Ctrl+C in its terminal), or start a second copy on its own database: `DB_FILE=data/second.db npm start`.
- *npm warn install-scripts … esbuild*: harmless. esbuild ships its binary as a platform package, and the build works without the postinstall step.
- *Port … is busy*: only with an explicit `PORT`. Leave `PORT` unset to take the next free port (3000-3019).
- *bash: cd: clone: No such file or directory*: you are already inside `clone/`. Run `npm install && npm start` there.
- After `git pull`, run `npm install` again before `npm start`: dependencies change between phases.

**Admin bootstrap (no default password, `../CLONE_SPEC.md` §22.5).** On first start with no admin, the server prints a single-use setup link (`http://localhost:3000/setup?token=…`, valid 60 minutes) where you create the first admin. Alternatives: `ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='…' npm start` (PowerShell: `$env:ADMIN_EMAIL='…'; $env:ADMIN_PASSWORD='…'; npm start`), or `npm run create-admin` with the server stopped (prompts for email and password). Passwords need 12+ characters mixing two character classes, not your name/email, and not a common breached password. Demo social accounts `maple_quant`, `harborwatch`, `rainmaker` (`<name>@parlance.local`) get a random password printed once when the database is seeded, or `DEMO_PASSWORD`. Admins can pause, resume, close and resolve markets from any event page. New users sign up and deposit through the sandbox rails (☰ → Deposit & withdraw) or demo funds on the Portfolio page. Account › Security has password change, two-factor login, withdrawal verification, signed-in devices (sign out one / everywhere) and the account's security activity.

Port: with `PORT` unset the server tries 3000-3019 and prints the URL it actually bound. With `PORT=8080 npm start` (PowerShell: `$env:PORT=8080; npm start`) it uses exactly that port and exits with a clear message if the port is busy.

Environment: `PORT`, `DB_FILE`, `RATE_BURST`, `RATE_PER_SEC`; identity: `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `DEMO_PASSWORD`, `SECRET_KEY` / `SECRET_KEY_FILE` (default: `secret.key` next to the database), `SECURE_COOKIES=1` behind a TLS proxy, `SCRYPT_LOG_N`; Web Push: `VAPID_SUBJECT`, `PUSH_ALLOWED_HOSTS` (see `.env.example`). Requires Node ≥ 22.5 (`node:sqlite`).

## Install as an app (PWA)

Parlance is a Progressive Web App (`../CLONE_SPEC.md` §31). Browsers only allow it on `https://` or on `localhost` /
`127.0.0.1`, so a plain-http address on your LAN shows no install option.
- **Chrome, Edge, Android:** open the site, then ☰ → **Install app** (or the install icon in the address bar). Signed
  out, a ☰ button appears next to Log in while installation is possible. The installed app opens in its own window
  and offers Markets, Portfolio and Deposit shortcuts on its icon.
- **iPhone / iPad (Safari):** ☰ → **Install app** shows the steps: Share → **Add to Home Screen** → Add.
- **Offline:** page loads that fail show a small offline page with **Retry**. Prices, balances and orders always need
  the network; only the public, content-hashed app files are cached (never pages, API responses or anything personal).
- **Updates:** after a deploy, open tabs show **New version available — Reload**. Nothing switches until you click.
- `npm start` (production bundle) precaches the whole bundle; `npm run dev` registers a development worker that caches
  only the offline page and icons, so edited sources are never served stale. To reset: DevTools › Application ›
  Service workers › Unregister, or sign out (which empties the caches).

**Push notifications (Web Push).** Settings › Notifications › *Push in this browser* › **Turn on for this device**
asks for the notification permission, subscribes this browser with the server's VAPID key and lists it under the
device list (with **Send test notification** and **Remove**). Then every notification type whose **Push** pill is on
reaches the device's notification centre, even with Parlance closed; clicking one opens its page.
- The server generates its VAPID key pair on first start and stores it encrypted with the master key
  (`SECRET_KEY` / `data/secret.key`). Changing that key drops existing subscriptions; users turn push on again.
- Set `VAPID_SUBJECT=mailto:you@example.com` (or an https URL) so push services can reach the operator. Only the
  push services of Chrome / Android, Firefox, Safari and Edge are accepted; `PUSH_ALLOWED_HOSTS` adds others.
- Locally, delivery goes out from your machine to the browser vendor's push service, so push works on `localhost` with
  internet access. Undeliverable messages are retried with backoff from a database outbox (they survive a restart);
  a subscription the push service reports gone (404/410) is deleted. Signing out unsubscribes the browser.
- The tests never touch the network: `tests/pwa.e2e.test.js` points subscriptions at a local fake push service that
  verifies the VAPID signature and decrypts each message (`start({ push: { insecureEndpointHosts: ['127.0.0.1:<port>'] } })`,
  refused in production).
- `node scripts/make-icons.js` redraws the app icons (`--check` verifies them).
- Text and app identity are data: every PWA string is keyed in `public/js/content/pwa-strings.js` (server-side text in
  `server/content/pwa.js`), and the manifest (name, colours, icons, shortcuts) is built from `PWA_CONFIG` there.

## Trading core (Phase 5A)

- **Finer prices.** Some markets trade in 0.1¢ steps (`deci_cent`), or in finer steps near 0¢ and 100¢ (`tapered`). Combos use 0.1¢ steps, and 0.01¢ near the edges. The ticket's limit field steps by the market's tick and lists the bands.
- **Fees.** Fees are charged once per order: the exact fee of every fill is added up and rounded up a single time.
- **Scalar markets** (for example *Harbor GDP growth in Q4 2026*) pay YES a share of $1 by the reported value between a floor and a cap; NO gets the rest. Admins resolve them with the value.
- **Settings › Trade mechanics** are live:
  - **Skip order review** is off by default, so orders show a review first.
  - **Auto-sell prompt** offers a take-profit sell after a buy fills.
  - **Flip sell** lets you sell more than you hold to buy the other side.
  - **Collateral return**, on by default, gives cash back early when your positions across one either/or event guarantee a payout. Portfolio shows the amount.
- **Admin › Resolution.** A settled market can be corrected (clawed back or re-paid, with a reason and step-up). An optional two-person rule makes a second admin approve resolutions and corrections.

## Pages

- Header: MARKETS (`/browse`), INVEST (`/perps`), LIVE (`/live`), PRO (`/pro`), MORE (calendar, social, leaderboard, watchlist, responsible trading, theme). Dark theme by default.
- Home: hero carousel, info cards, Upcoming strip, category sections, rail with Perps promo, hubs, Trending, Harbor 2026, Top movers.
- Market pages: head-to-head bar, multi-line chart (1D/1W/1M/ALL), outcome table, Social / Activity / Order book / Rules / Top holders, related events, news, add-to-calendar (.ics) and price-history CSV. The ticket has BUY/SELL and Dollars / Contracts / Limit modes, plus 3.5% interest and price alerts.
- Live / Calendar: rolling Above/Below windows on an invented PLX index, live events, dated sections, Determined card.
- Perps (`/perps`): leveraged long/short perpetual futures with mark/index price, isolated margin, liquidation, funding, TP/SL, price bands, and transfers to and from cash.
- Fractional contracts: sizes down to 0.01 contract on enabled markets; Dollars mode buys fractional amounts; "Hide fractional shares" order-book setting.
- Combos (`/combos`, ◇ COMBO on market pages and Live): 2–6 legs from different events, priced by request-for-quote; other users can quote too (opt in under Portfolio › RFQs).
- Portfolio: Positions · Resting (edit, decrease, cancel all, queue position, expiry) · RFQs · Quotes · History (filters + CSV), plus the Perps tab.
- Sports (`/sports`, Live page sidebar): simulated live games in seven sports (including the invented Icebound Hockey League: periods, power plays, overtime and shootouts) with scoreboards, play-by-play, live odds and automatic settlement. Clocks run live on every board and in the event header (game clock, match time for tennis, map time for esports). Each game also has a **Spread & Total** event (favourite and underdog spreads, a main and an alternate total), listed under "Spread and Total" on the game's page, priced from the game's own simulation and settled from the final score.
- Admin (`/admin`, admins only): roles and audit log, catalog drafts and CSV import, resolution desk, homepage/banner/nav/news/help content, market and perps ops, users, moderation, announcements, reports, settings.
- Live chat on events (● Live chat on the event header): slow mode, replies, reports, moderator delete/mute/pin/lock (Admin › Chat).
- Also: Social, Notifications, Watchlist, Account (profile, two-factor login, limits, alerts, appearance).

- Onboarding and identity (`../CLONE_SPEC.md` §13.14-13.16, §25): sign-up → email code → phone code → legal name → birthday → address → "Verifying info…" → document verification (ID front, back, selfie; desktop can continue on a phone through a 10-minute QR link) → result. With `npm start`, trading, deposits, withdrawals and transfers wait for an approved identity. `KYC_REQUIRED=0 npm start` turns that gate off, and an admin can switch it in Admin › Identity. Verification codes go to the dev mailbox at `http://localhost:3000/v1/dev/mailbox` (email and SMS; never registered in production). The identity check is a deterministic sandbox, so use invented data only. The legal last name picks the outcome: `Review` (manual review, Admin › Identity), `Reject`, `Retry`, `Outage`; anything else is approved after the documents step.
- Account area (☰ menu): Your activity, Documents, Settings (notification matrix, theme and accessible colors, trade mechanics, market preview price type), Account & security (passkeys, sign-in methods, devices), Rewards, promo codes.

- Deposit and withdraw (☰ → Deposit & withdraw, `/funds`; `../CLONE_SPEC.md` §26): **sandbox only, no real money.** Pick a method, an amount, review, and follow the status live. Payment methods are under Account & security › Payment methods.
  - **Debit card** (instant): only these invented test numbers are accepted. Any future expiry date, any 3-digit code. Never type a real card number; the sandbox refuses it and keeps nothing.

    | Number | Result |
    |---|---|
    | `4000 9910 0000 0002`, `5500 9910 0000 0004` | approved |
    | `4000 9920 0000 0000` | declined |
    | `4000 9930 0000 0008` | declined: insufficient funds |
    | `4000 9940 0000 0006`, `5500 9940 0000 0008` | asks for a verification step (Approve or Fail on the sandbox issuer screen) |

  - **Bank account** (ACH-like): "Link a bank account", choose any sandbox bank, sign in with `sandbox` / `sandbox-pass`, then pick an account: `••0001` settles normally, `••0002` returns deposits (insufficient funds), `••0003` fails withdrawals. Bank deposits can be traded at once and withdrawn once settled (about 30 s in the sandbox).
  - **Crypto** (test chain): accept the terms to get a deposit address, then "Simulate transfer" (credited after 3 confirmations, one block every 5 s). Withdraw to an address from `GET /v1/payments/supported_networks` (`example`); a new address needs a password check, has a 24-hour cooling period, and the first withdrawal to it is reviewed in Admin › Payments.
  - **Demo funds** (outside production): instant simulated deposits and withdrawals, as before (also the Portfolio "Demo funds" box).
  - Promotional credits (promo codes) can be traded but not withdrawn, and expire after 30 days. Admin › Payments has transactions, reconciliation, AML cases, the double-entry ledger audit, provider settings (limits, fees, sandbox timings) and the webhook log.

- Hubs (`../CLONE_SPEC.md` §29): **Harbor 2026 hub** (`/hubs/elections`, MORE menu and the home rail) with a Senate map of invented states driven by the race markets, the expected-seat history and the governor race's forecast history; **Rates outlook** (`/hubs/economics`) with the implied path from the central-bank decision markets. All states, places, rates and news are invented.
- **What's on your ballot?** (`/ballot` and the elections hub): type an address or a 5-digit code from the invented ranges (for example `90142` or "Harbor City") to see the contests that have markets. Your address is used once and never stored or logged; signed-in users can save the matched area (only the area id is kept) and forget it again.
- **AI summaries**: event pages with news items (Admin › Content › News items) show a short summary with numbered citations to the news and a timeline. By default an offline, deterministic extractive summarizer writes it; nothing leaves the server. To use an external model instead, set **both** `ANTHROPIC_API_KEY` and `AI_SUMMARY_MODEL` (the model id you want) before `npm start`; without both, the external adapter is off. Daily request and token budgets, the moderation blocklist, and hide / regenerate (with a reason, audited) are in Admin › AI summaries; when the budget is used up or a reply fails validation, the extractive summary is shown instead.
- **Liquidity rewards** (`/incentives`, ☰ → Liquidity Rewards): programs per event with start, end, competition and reward pool (Active / Upcoming, search, sort by reward). Accept the terms to take part; resting orders near the best price earn a share of the pool (formula in `../CLONE_SPEC.md` §29.7), shown as this month's and lifetime rewards. Payouts arrive as cash or credits (simulated funds). Admin › Liquidity incentives creates programs, runs snapshots, pays out and sets blocked regions.
- The calendar caps recurring families (for example the daily temperature markets) per date with a "+N more" button.

Not built yet (PLAN.md Phases 6-9; payments: sandbox rails built, no real money): public developer API keys and portal, FIX gateway, referrals payouts.

Perimeter security (`../CLONE_SPEC.md` §21): CSP with per-response nonces and the other security headers, CORS allowlist (`ALLOWED_ORIGINS`), proof-of-work bot challenge for suspicious HTML requests, signed client tokens on `/v1` writes and the WebSocket, honeypot paths, tiered persisted rate limits, Admin › Security event log. Taker fee coefficient, rolling window, rate limits and bot settings are editable live in Admin › Settings & health. Fonts are self-hosted (`public/fonts/`, SIL OFL).

Environment: `PORT`, `DB_FILE`, `RATE_BURST`, `RATE_PER_SEC` (anonymous rate-limit tier defaults), `ALLOWED_ORIGINS`, `TRUST_PROXY`, `ASSETS` (`dist` or `src`), `ROLLING_WINDOW_SEC` (rolling market window, default 900), `SPORTS=0` (turn the sports simulation off), `SPORTS_SPEED` (game seconds per real second, default 1), `PAYMENTS_DEMO_FUNDS` (`0`/`1`, instant demo funds; default on outside production), `PAYMENTS_SANDBOX` (`0`/`1`, sandbox payment rails; default on outside production), `ANTHROPIC_API_KEY` + `AI_SUMMARY_MODEL` (optional external AI summarizer; both must be set, see above).

## Styling

All design tokens live in the first `:root` block of `public/app.css`: the type scale (`--fs-*` with paired `--lh-*`), the four weights (`--fw-*`), tracking (`--ls-*`), the 4px spacing scale (`--space-*`), control heights (`--control-sm/md/lg`), radii and layout sizes; the colour themes follow. Every other stylesheet reads them, and no stylesheet may use a literal font size, font weight, letter-spacing or off-scale margin/padding/gap. `tests/visual-system.e2e.test.js` enforces this and checks the key layouts at 1280 and 390 px in both themes. After adding CSS or views, run `node scripts/apply-type-tokens.js` (idempotent; `--check` only reports) and `node scripts/visual-audit.js <outdir> <tag>` for screenshots. Rules and the full scale: `../CLONE_SPEC.md` §27.

## Architecture

| Layer | File | Spec |
|---|---|---|
| SQLite schema (users, sessions, settings, series/events/markets, orders, trades, fills, positions, settlements, ledger, watchlist, recents) | `server/db.js` | §8.1 |
| Matching engine: one book per market, YES@p ≡ NO@(100-p), price-time priority, taker fee, YES+NO netting, lifecycle + settlement | `server/engine.js` | §4.3, §4.4, §5.1 |
| REST: `/trade-api/v2/*` public market data and `/v1/*` web API (session cookie + `x-csrf-token`), error envelopes, cursor pagination, token-bucket 429 | `server/app.js` | §5, §6 |
| WebSocket `/v1/ws`: `ticker`, `orderbook` (snapshot + delta), `trade`, `market_lifecycle_v2`, `user_balance`, `user_orders`, `fill` | `server/ws.js` | §7 |
| Social, notifications + price targets, account limits, two-factor (TOTP), calendar, categories, daily interest | `server/features.js` | §13, §15 |
| Perps margin engine: markets, orders, positions, liquidation, funding, TP/SL, transfers | `server/perps.js` | §14 |
| Rolling Above/Below windows | `server/rolling.js` | §15.5 |
| Payments (sandbox): rails, webhooks, limits, AML, holds; sandbox providers; double-entry journal + audit; Admin › Payments and reconciliation | `server/payments.js`, `server/payment-providers.js`, `server/journal.js`, `server/payments-admin.js` | §26 |
| SPA: router, root store, query cache with polling, shared socket with dedup, 5 s subscription timeout, backoff and resubscribe | `public/js/*` | §2, §7.2 |

All state is server-side in SQLite: balances, orders, positions, watchlist, recently viewed and UI settings (theme, chart range, tabs, sort, portfolio view). Only the theme for signed-out visitors and the CSRF token mirror use localStorage.

Design choices for spec UNKNOWNs: fee = ceil(0.07·C·P·(1−P)) charged to takers only; odds = last trade (else mid); payout multiplier = 1/ask; settlement timer 5 s; WS backoff 500 ms·2ⁿ (max 30 s) + jitter; CSV columns `time,type,amount_usd,reference,memo`.
