# Parlance Exchange (clean-room clone)

A functional binary event-contract exchange built only from `../CLONE_SPEC.md`. Layout, page structure and features follow the live site as captured on 2026-11-02 (spec §13). It uses its own name, logo, palette, typeface (Inter, SIL OFL), copy and invented seed data. No third-party code or assets.

## Run

```bash
npm install
npm start            # http://localhost:3000, or the next free port if 3000 is taken (DB at data/parlance.db, auto-seeded);
                     # serves the hashed production bundle in dist/, built first if missing or stale
npm run dev          # same, but serves the unbundled sources from public/ (no build step)
npm run build        # build dist/: content-hashed, minified JS/CSS + fonts, no source maps (scripts/build.js)
npm run seed         # wipe and re-seed the database
npm run test:e2e     # 103 end-to-end browser tests (Playwright + node:test)
```

**Admin bootstrap (no default password, `../CLONE_SPEC.md` §22.5).** On first start with no admin, the server prints a single-use setup link (`http://localhost:3000/setup?token=…`, valid 60 minutes) where you create the first admin. Alternatives: `ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='…' npm start` (PowerShell: `$env:ADMIN_EMAIL='…'; $env:ADMIN_PASSWORD='…'; npm start`), or `npm run create-admin` with the server stopped (prompts for email and password). Passwords need 12+ characters mixing two character classes, not your name/email, and not a common breached password. Demo social accounts `maple_quant`, `harborwatch`, `rainmaker` (`<name>@parlance.local`) get a random password printed once when the database is seeded, or `DEMO_PASSWORD`. Admins can pause, resume, close and resolve markets from any event page. New users sign up and deposit simulated funds on the Portfolio page. Account › Security has password change, two-factor login, withdrawal verification, signed-in devices (sign out one / everywhere) and the account's security activity.

Port: with `PORT` unset the server tries 3000-3019 and prints the URL it actually bound. With `PORT=8080 npm start` (PowerShell: `$env:PORT=8080; npm start`) it uses exactly that port and exits with a clear message if the port is busy.

Environment: `PORT`, `DB_FILE`, `RATE_BURST`, `RATE_PER_SEC`; identity: `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `DEMO_PASSWORD`, `SECRET_KEY` / `SECRET_KEY_FILE` (default: `secret.key` next to the database), `SECURE_COOKIES=1` behind a TLS proxy, `SCRYPT_LOG_N` (see `.env.example`). Requires Node ≥ 22.5 (`node:sqlite`).

## Pages

- Header: MARKETS (`/browse`), INVEST (`/perps`), LIVE (`/live`), PRO (`/pro`), MORE (calendar, social, leaderboard, watchlist, responsible trading, theme). Dark theme by default.
- Home: hero carousel, info cards, Upcoming strip, category sections, rail with Perps promo, hubs, Trending, Harbor 2026, Top movers.
- Market pages: head-to-head bar, multi-line chart (1D/1W/1M/ALL), outcome table, Social / Activity / Order book / Rules / Top holders, related events, news, add-to-calendar (.ics) and price-history CSV. The ticket has BUY/SELL and Dollars / Contracts / Limit modes, plus 3.5% interest and price alerts.
- Live / Calendar: rolling Above/Below windows on an invented PLX index, live events, dated sections, Determined card.
- Perps (`/perps`): leveraged long/short perpetual futures with mark/index price, isolated margin, liquidation, funding, TP/SL, price bands, and transfers to and from cash.
- Fractional contracts: sizes down to 0.01 contract on enabled markets; Dollars mode buys fractional amounts; "Hide fractional shares" order-book setting.
- Combos (`/combos`, ◇ COMBO on market pages and Live): 2–6 legs from different events, priced by request-for-quote; other users can quote too (opt in under Portfolio › RFQs).
- Portfolio: Positions · Resting (edit, decrease, cancel all, queue position, expiry) · RFQs · Quotes · History (filters + CSV), plus the Perps tab.
- Sports (`/sports`, Live page sidebar): simulated live games in six sports with scoreboards, play-by-play, live odds and automatic settlement.
- Admin (`/admin`, admins only): roles and audit log, catalog drafts and CSV import, resolution desk, homepage/banner/nav/news/help content, market and perps ops, users, moderation, announcements, reports, settings.
- Live chat on events (● Live chat on the event header): slow mode, replies, reports, moderator delete/mute/pin/lock (Admin › Chat).
- Also: Social, Notifications, Watchlist, Account (profile, two-factor login, limits, alerts, appearance).

Not built: KYC/identity checks, real payment rails, GIFs, ballot lookup, AI summaries, signed public API keys (spec §12).

Perimeter security (`../CLONE_SPEC.md` §21): CSP with per-response nonces and the other security headers, CORS allowlist (`ALLOWED_ORIGINS`), proof-of-work bot challenge for suspicious HTML requests, signed client tokens on `/v1` writes and the WebSocket, honeypot paths, tiered persisted rate limits, Admin › Security event log. Taker fee coefficient, rolling window, rate limits and bot settings are editable live in Admin › Settings & health. Fonts are self-hosted (`public/fonts/`, SIL OFL).

Environment: `PORT`, `DB_FILE`, `RATE_BURST`, `RATE_PER_SEC` (anonymous rate-limit tier defaults), `ALLOWED_ORIGINS`, `TRUST_PROXY`, `ASSETS` (`dist` or `src`), `ROLLING_WINDOW_SEC` (rolling market window, default 900), `SPORTS=0` (turn the sports simulation off), `SPORTS_SPEED` (game seconds per real second, default 1).

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
| SPA: router, root store, query cache with polling, shared socket with dedup, 5 s subscription timeout, backoff and resubscribe | `public/js/*` | §2, §7.2 |

All state is server-side in SQLite: balances, orders, positions, watchlist, recently viewed and UI settings (theme, chart range, tabs, sort, portfolio view). Only the theme for signed-out visitors and the CSRF token mirror use localStorage.

Design choices for spec UNKNOWNs: fee = ceil(0.07·C·P·(1−P)) charged to takers only; odds = last trade (else mid); payout multiplier = 1/ask; settlement timer 5 s; WS backoff 500 ms·2ⁿ (max 30 s) + jitter; CSV columns `time,type,amount_usd,reference,memo`.
