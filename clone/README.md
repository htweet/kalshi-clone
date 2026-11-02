# Parlance Exchange (clean-room clone)

A functional binary event-contract exchange built only from `../CLONE_SPEC.md`. It uses its own name, palette, typography, copy and invented seed data. No third-party code or assets.

## Run

```bash
npm install
npm start            # http://localhost:3000, or the next free port if 3000 is taken (DB at data/parlance.db, auto-seeded)
npm run seed         # wipe and re-seed the database
npm run test:e2e     # 13 end-to-end browser tests (Playwright + node:test)
```

Seeded admin account: `admin@parlance.local` / `parlance-admin`. It can pause, resume, close and resolve markets from any event page. New users sign up and deposit simulated funds on the Portfolio page.

Port: with `PORT` unset the server tries 3000-3019 and prints the URL it actually bound. With `PORT=8080 npm start` (PowerShell: `$env:PORT=8080; npm start`) it uses exactly that port and exits with a clear message if the port is busy.

Environment: `PORT`, `DB_FILE`, `RATE_BURST`, `RATE_PER_SEC`. Requires Node ≥ 22.5 (`node:sqlite`).

## Architecture

| Layer | File | Spec |
|---|---|---|
| SQLite schema (users, sessions, settings, series/events/markets, orders, trades, fills, positions, settlements, ledger, watchlist, recents) | `server/db.js` | §8.1 |
| Matching engine: one book per market, YES@p ≡ NO@(100-p), price-time priority, taker fee, YES+NO netting, lifecycle + settlement | `server/engine.js` | §4.3, §4.4, §5.1 |
| REST: `/trade-api/v2/*` public market data and `/v1/*` web API (session cookie + `x-csrf-token`), error envelopes, cursor pagination, token-bucket 429 | `server/app.js` | §5, §6 |
| WebSocket `/v1/ws`: `ticker`, `orderbook` (snapshot + delta), `trade`, `market_lifecycle_v2`, `user_balance`, `user_orders`, `fill` | `server/ws.js` | §7 |
| SPA: router, root store, query cache with polling, shared socket with dedup, 5 s subscription timeout, backoff and resubscribe | `public/js/*` | §2, §7.2 |

All state is server-side in SQLite: balances, orders, positions, watchlist, recently viewed and UI settings (theme, chart range, tabs, sort, portfolio view). Only the theme for signed-out visitors and the CSRF token mirror use localStorage.

Design choices for spec UNKNOWNs: fee = ceil(0.07·C·P·(1−P)) charged to takers only; odds = last trade (else mid); payout multiplier = 1/ask; settlement timer 5 s; WS backoff 500 ms·2ⁿ (max 30 s) + jitter; CSV columns `time,type,amount_usd,reference,memo`.
