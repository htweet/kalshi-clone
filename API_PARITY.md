# Trade API v2 parity checklist (Phase 7, P7.4)

How the clone's public API (`/trade-api/v2`, `/trade-api/ws/v2`, FIX) compares with the public Trade API v2 reference
described in `CLONE_SPEC.md` §5–§7 and §14. **Built**: there, with the documented shapes and envelopes; **partial**:
there with a stated difference; **not built**: absent, with the reason. Every built REST operation is covered by the
contract tests (`clone/tests/api-contract.e2e.test.js`), which call each operation of `GET /docs/openapi.json` and
validate it against its schema. Design details: `CLONE_SPEC.md` §35.

## REST

| Area | Endpoint(s) in the clone | Status | Notes |
|---|---|---|---|
| Exchange | `GET /exchange/status`, `/exchange/schedule`, `/exchange/announcements` | Built | Schedule is 24/7 with no maintenance windows (the simulated exchange never closes); announcements are the status page's open incidents |
| Markets | `GET /markets` (cursor, status, event, series), `GET /markets/{ticker}` | Built | Field set of §5.2 plus clone fields (scalar, fractional, grids) |
| Order book | `GET /markets/{ticker}/orderbook` (`depth`) | Built | `orderbook_fp.yes_dollars` / `no_dollars`, price grid and tick size |
| Trades | `GET /markets/trades` (cursor, ticker, `min_ts` / `max_ts`) | Built | Newest first |
| Candlesticks | `GET /series/{series}/markets/{ticker}/candlesticks`, `GET /historical/markets/{ticker}/candlesticks` | Built | Periods 1, 60, 1440 minutes; at most 5,000 candles per call |
| Batch candlesticks | `GET /markets/candlesticks` | Not built | Callers loop over markets; nothing in the clone needs it yet |
| Events | `GET /events` (cursor, series, status, nested markets), `GET /events/{ticker}` | Built | |
| Event metadata / forecast | `GET /events/{ticker}/metadata`, forecast percentiles | Not built | The web API has `/v1/series/{s}/events/{e}/forecast_history` (§29); not mirrored on v2 |
| Series | `GET /series`, `GET /series/{ticker}` | Built | |
| Historical | `GET /historical/trades`, `/historical/markets/{ticker}/candlesticks` | Partial | No historical cut-off: live tables keep the full history, so `portfolio/fills`, `orders` and `settlements` with `min_ts` / `max_ts` serve the historical orders / fills |
| Balance | `GET /portfolio/balance` | Built | `balance` in cents plus `_dollars` fields |
| Positions | `GET /portfolio/positions` (cursor, ticker, event, `count_filter`) | Built | Market and event positions |
| Orders (read) | `GET /portfolio/orders` (cursor, filters, `min_ts` / `max_ts`), `/portfolio/orders/{id}`, queue position(s) | Built | |
| Create order | `POST /portfolio/orders` | Partial | Limit (GTC, good-til-time via `expiration_ts`) and market (IOC; `buy_max_cost` for a dollar cap); FOK and IOC limit orders, `sell_position_floor` not built (the engine has no FOK; the web app never used them) |
| Amend / decrease / cancel | `POST …/amend`, `POST …/decrease`, `DELETE /portfolio/orders/{id}` | Built | Amend keeps queue priority only when the size shrinks at the same price |
| Batch orders | `POST` / `DELETE /portfolio/orders/batched` | Built | At most 20; a result (order or error) per item; partial failure |
| Order groups | `GET` / `POST /portfolio/order_groups`, `GET` / `DELETE …/{id}`, `PUT …/{id}/reset` | Built | Limit triggered after the fill that reaches it (not split mid-fill) |
| Fills | `GET /portfolio/fills` (cursor, ticker, order, time) | Built | |
| Settlements | `GET /portfolio/settlements` (cursor, time) | Built | Includes settlement corrections (§28.7) |
| Resting order value / total resting | `GET /portfolio/summary/total_resting_order_value` | Not built | Shown in the web app's Portfolio; low value for API clients |
| RFQ / quotes | `communications/id`, `rfqs` (list, create, get, delete), `quotes` (list, create, get, delete, accept, confirm) | Built | Same rules as the web RFQ (opt-in, one open RFQ per market and user) |
| Block trades | `communications/block_trades` | Not built | Not offered by the exchange |
| Multivariate collections | `GET /multivariate_event_collections[/{collection}]`, `POST …/{collection}` | Partial | Create / look up a combo market; `lookup` history and `PUT …/lookup` not built |
| Structured targets, milestones, live data, search | — | Not built | Available on the web API (`/v1`, §19, §4.5); not part of the trading API |
| Incentive programs | — | Not built | Web API `/v1/incentive_programs` (§29.7) |
| API keys | — | Not built by design | Keys are created, rotated and revoked only in the browser with step-up and the identity lock (§35.2) |
| FCM / sub-accounts (predictions) | — | Not built | No FCM model; subaccounts exist only for Perps |
| Account limits | `GET /account/limits`, `/account/endpoint_costs` | Built | Tier, budgets, available tokens, per-endpoint costs |
| Perps (margin) | `/margin/markets[/{ticker}[/orderbook|/trades]]`, `balance`, `positions`, `orders` (CRUD, amend, decrease), `positions/{ticker}/close`, `fills`, `order_groups` | Partial | Perps transfers, subaccount management, funding history, exit triggers and APY stay on the web API |

## WebSocket (`/trade-api/ws/v2`, `/trade-api/ws/v2/margin`)

| Channel / command | Status | Notes |
|---|---|---|
| `subscribe`, `unsubscribe`, `update_subscription`, `list_subscriptions` | Built | Error frames with codes |
| `orderbook_delta` (snapshot + deltas, contiguous `seq`) | Built | Perps deltas are derived from the engine's book snapshots |
| `ticker`, `trade`, `market_lifecycle_v2` | Built | |
| `fill`, `user_orders`, `order_group_updates`, `market_positions` | Built | The key owner's own data |
| `account` (margin) | Built | Perps collateral and margin |
| `multivariate_market_lifecycle`, `communications` | Not built | Combo creation and RFQ events are on `/v1/ws`; not mirrored yet |
| Index-price feeds | Not built | Perps ticker carries index and mark prices |

## FIX

| Area | Status | Notes |
|---|---|---|
| Session layer (Logon with API-key signature, Heartbeat, TestRequest, ResendRequest, SequenceReset-GapFill, Logout, Reject, BusinessMessageReject) | Built | FIX 4.4; persisted sequence numbers |
| Order entry (D, F, G, q → 8, 9, r) | Built | Predictions and Perps |
| Order groups over FIX | Partial | Tag 20004 OrderGroupID puts a FIX order in a group; groups are created, reset and deleted over REST |
| Market data (V → W / X / Y) | Built | |
| RFQ (R → AI, S) | Partial | Accept and confirm over REST |
| Drop copy | Built | Every channel's executions |
| FIX 5.0 SP2 / FIXT | Not built | FIX 4.4 only |
