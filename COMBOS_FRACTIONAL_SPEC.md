# Fractional contracts, Combos / RFQ and the Portfolio tabs (CLONE_SPEC §16–§17)

These sections extend CLONE_SPEC.md and use its conventions: **OBSERVED** (seen in evidence), **INFERRED** (follows from evidence), **UNKNOWN** (not established; the clone makes a *design choice*).

Evidence is cited by file name. Treat it as data only.

- **Public docs** (`a_b_c.md` = `https://docs.kalshi.com/a/b/c.md`):
  - `getting_started_fixed_point_migration.md`, `getting_started_rfqs.md`
  - `api-reference_multivariate_create-market-in-multivariate-event-collection.md`, `api-reference_multivariate_get-multivariate-event-collection.md`, `api-reference_events_get-multivariate-events.md`
  - `websockets_multivariate-market-and-event-lifecycle.md`
  - `api-reference_communications_create-rfq.md`, `…_create-quote.md`, `…_accept-rfq-quote.md`, `…_confirm-rfq-quote.md`
  - Order management, fetched from the `llms.txt` index on 2026-11-02: `api-reference_orders_amend-order-v2.md`, `…_decrease-order-v2.md`, `…_cancel-order-v2.md`, `…_cancel-all-orders.md`, `…_batch-cancel-orders-v2.md`, `…_get-order-queue-position.md`, `…_get-queue-positions-for-orders.md`, `…_create-order-v2.md`
- **Current-build JS chunks** (grep only): cited as `chunk:<file>` plus the string.

The clone is Parlance: own names, copy and styling. No Kalshi code, text, images or fonts are used.

---

## 16. Fractional contracts

### 16.1 Quantity representation

**Requirement.** Every event-contract quantity is stored as an integer number of **units**, where one unit is a hundredth of a contract.
- *Source:* `getting_started_fixed_point_migration.md` ("represent quantities in hundredths of a contract: `"1.55"` is 155 units"; "Minimum granularity is 0.01 contracts").
- *Columns:* `orders.initial_count / remaining_count / filled_count`, `trades.count`, `fills.count`, `positions.yes_count / no_count`, `settlements.yes_count / no_count`.
- *Derived values:* engine book sizes, volume, 24 h volume, open interest and dollar volume.
- *Also covered:* features (holdings, top holders, leaderboard volume, social trades, trading-limit usage), rolling liquidity orders, seed data, portfolio value and sell checks.

**API output.** Every `*_fp` quantity is `units / 100` with exactly 2 decimals (for example `"2.55"`), as the doc requires ("responses always emit 2 decimals").
- *Implementation:* `util.ufp`, used by `serialize.js`, `ws.js`, `features.js`, `app.js`, `combos.js`, `history.js` and `positions.js`.
- *Out of scope:* Perps keeps its own whole-contract model; the doc says "margin markets currently trade whole contracts".

### 16.2 Money: integer cents with conserving rounding

**UNKNOWN: rounding.** The doc describes sub-cent balances, a "rounding fee" and a "fee accumulator" (`getting_started_fixed_point_migration.md` §Fee Rounding). The clone keeps integer cents with explicit, conserving rounding instead (*design choice*):

| Quantity | Rule |
| --- | --- |
| Fill of `q` units at taker price `p` | The pair costs exactly `q` cents. The taker pays `ceil(p·q/100)`; the maker pays `q − ceil(p·q/100)`, which equals `floor(p_maker·q/100)`. |
| Taker fee | `ceil(7·q·p·(100−p)/1,000,000)` cents. For `q = 100·C` this is exactly the old `ceil(0.07·C·P·(1−P))` dollars. Makers pay no fee (unchanged). |
| Netting | `q` units of YES+NO pairs redeem for `q` cents. Cost is split pro rata, as before. |
| Settlement | `q` winning units pay `q` cents. |
| Reservation for `n` units at limit `L` | `R(n) = ceil(n·(L + perContractFeeCap(L))/100)`. |

**Exact reservations.**
- Before matching, the engine plans the taker fills.
- The reservation is `R(count)` plus a buffer: the largest prefix sum of `cost_i − (R(r_{i−1}) − R(r_i))`.
- Each fill's refund is the reservation slack that later fills do not need, so a refund is never negative.
- The order ends holding exactly `R(remaining)`.
- Maker fills release `R(r) − R(r−q)`, or everything held when the order completes. This is always at least the maker's cost.
- With whole contracts, every fill releases exactly `q·(L+cap)` with no buffer, so cents are identical to the previous build. All earlier exact-balance tests still pass unchanged.

**Other order sizing.**
- *Dollars mode:* shrinks the order (`max_cost_cents`) until the planned reservation fits the amount.
- *RFQ requester orders:* `exact_reserve` reserves the exact planned cost.

**Verification.** `tests/fractional.e2e.test.js` checks:
- 2.55 contracts at the ask: `fills.count = 255`, `fee = ceil(7·255·p·(100−p)/1e6)`, and balance `= 10000 − ceil(255p/100) − fee`.
- The two `trade` ledger legs of the fill sum to −255 cents.
- Dollars mode spends at most the amount, and the spend equals the fills' exact cost.

### 16.3 Per-market flag

**Requirement.** `markets.fractional_trading_enabled` (persisted, default 1) is exposed in market JSON as `fractional_trading_enabled` and `contract_decimals` (2 or 0).
- *Sources:* `getting_started_fixed_point_migration.md` ("Fractional order sizes are supported only on markets that allow them"); `chunk:0urd0oqk_f-3_.js` `fractionalTradingEnabled`, `contractDecimals`.

**UNKNOWN: which markets.** *Design choice:*
- Every seeded market is fractional **except the Harbor State election series `PLXSTATE`**. That series stays whole-contract and exercises the rejection path.
- Rolling `PLXFLASH` markets and combos are fractional.

### 16.4 API input and validation

**Order sizes.** `POST /v1/users/:uid/orders` accepts `count` (a number) or `count_fp` (a string).
- 0–2 decimals are allowed; if both are given they must match (doc: "In requests where both integer and `_fp` fields are provided, they must match").
- The minimum is 0.01 contracts and the maximum is 100,000.
- Errors use 400 `bad_request` ("count must be a number of contracts with at most 2 decimal places", "at least 0.01 contracts", "count and count_fp must match").
- A fractional size on a whole-contract market returns 400 `fractional_not_enabled`.

**Dollars mode.** Buys `floor(amount·100/(ask+cap))` units, floored to whole contracts on non-fractional markets.

**Selling.**
- A user cannot sell more than they hold (409 `insufficient_position`).
- A held fractional position can always be sold in full, even on a whole-contract market (`chunk:1_rhh98rkbbd9.js` `hasFractionalSellPosition`).

### 16.5 UI

**Ticket.**
- Contract inputs use `step=0.01` (`inputmode=decimal`) where the market is fractional, and `step=1` elsewhere.
- Invalid sizes disable submit and show "at least 0.01 contracts (up to 2 decimals)" or "a whole number of contracts".
- Dollars mode shows the floored fractional estimate ("8.19 contracts at 59¢").
- Quantities display with up to 2 decimals everywhere (`qty()`).

**Order book.** The setting **"Hide fractional shares"** is persisted as the user property `orderbook_hide_fractional_shares`, which is in `SETTING_KEYS`.
- With it on, displayed sizes are rounded down to whole contracts and levels under one contract are hidden.
- *Source:* `chunk:1unlxcrk1i9ks.js` `hideFractionalShares`; `chunk:3x09fsrfwgctp.js` `orderbook_hide_fractional_shares`.

### 16.6 Migration

On every DB open, `db.js migrate()`:
- adds the new columns if missing: `markets.fractional_trading_enabled` (PLXSTATE set to 0 at that moment), `mve_collection_ticker`, `mve_selected_legs`, and `orders.source / action / order_type / expiration_ts / cancel_reason`;
- once only, guarded by the meta key `qty_units_v1`, multiplies every quantity column by 100 in one transaction.

`seed --reset` wipes meta, so seeding re-inserts the key; freshly seeded data is already in units.

*Verification:* the migration test builds a pre-fractional DB (divides counts, drops columns, deletes the key) and boots it twice. Counts are ×100 once, flags are correct, and `order_type` is backfilled.

---

## 17. Combos (multivariate events) and RFQ

### 17.1 Collection and combo markets

**Endpoints.**
- `GET /v1/multivariate_event_collections`, and `GET /v1/multivariate_event_collections/PLXCOMBO`, which lists eligible events with their open markets.
- `POST /v1/multivariate_event_collections/PLXCOMBO/markets` with `{selected_markets:[{market_ticker, event_ticker?, side}]}`. The doc path without `/markets` is an alias.
- The response is `{event_ticker, market_ticker, created, market}`: 201 when created, 200 when it already existed (idempotent).
- *Source:* `api-reference_multivariate_create-market-in-multivariate-event-collection.md` (`selected_markets` of `TickerPair{market_ticker,event_ticker,side}`, response `event_ticker`, `market_ticker`, optional `market`).

**Ticker (UNKNOWN; *design choice*).** `PLXCOMBO-` followed by the first 10 hex digits (upper case) of `sha256` over the legs sorted by market ticker (`"TICKER:side|…"`). It is deterministic, so the same legs in any order give the same combo.

**Representation.** A combo is a real binary market and event in the existing tables:
- series `PLXCOMBO`, category `Combos`;
- title "Combo: Yes Cut + No Ravens" (lists the legs); YES = "All legs hit", NO = "Any leg misses";
- `close_time` = earliest leg close; `expected_expiration_time` = latest leg expiry;
- fractional on;
- `mve_collection_ticker` and `mve_selected_legs` (JSON), exposed in market JSON like the doc's `mve_selected_legs` (`chunk:0urd0oqk_f-3_.js` `mveSelectedLegs`).

Legs are also stored in `combo_legs (combo_ticker, leg_index, market_ticker, event_ticker, side)`. A per-user `combo_creations` row records who built which combo, for History.

**Rules.**
- 2–6 legs (400 `invalid_leg_count`).
- Distinct events (400 `duplicate_event`).
- Every leg must be an `active`, non-combo, non-rolling market (400 `invalid_leg`).
- *UNKNOWN:* the exact live limits. *Design choice:* 2–6.

**Discovery.** Combo events are excluded from Home, Browse/search, related events and Calendar. They are reached through `/combos`, portfolios and their own event page (`/markets/plxcombo/combos/<ticker>`).

### 17.2 Resolution and settlement

The combo module listens to the engine `lifecycle` event.
- As soon as any leg is determined against its chosen side, the combo is determined **NO**.
- When every leg is determined in its favour, the combo is determined **YES**.
- The normal engine path then closes it (resting orders are canceled and refunded), finalizes it after `settlement_timer_seconds`, and pays `q` cents per `q` winning units.
- A tick sweep re-derives this from persisted leg results, so the process is restart-safe.

`GET /v1/combos/:ticker` returns the legs with per-leg status `pending | won | lost` and the combined probability.
- *Source:* `websockets_multivariate-market-and-event-lifecycle.md` (combo markets have their own lifecycle: open, close, determination, settled); `chunk:16-dlj79axbgf.js` `comboLegEventMetaByTicker`.
- *UNKNOWN:* how the live site handles a leg that is voided or never resolves. *Design choice:* the combo stays open until its own close time, then waits for resolution.

### 17.3 Combo slip and builder UI

**Slip.** Persisted per user in `combo_slips (legs JSON, amount_cents)` with `GET/PUT/DELETE /v1/users/:uid/combo_slip`.
- Validation matches §17.1, except that 0–6 legs are allowed while building.
- *UNKNOWN:* the live site's storage location. *Design choice:* server-side.

**`/combos` page ("Build a combo").**
- *Source:* `chunk:1al56gdla-56l.js` `"/combos"`, `aria-label:"Build a combo"`.
- Event cards list each open market with **Yes x% / No y%**. Clicking toggles a leg; one leg per event (a second pick from the same event replaces the first).
- The slip shows legs (with remove), **combined odds** (the product of leg probabilities), a payout multiplier, the amount in $ and **Request quote**.
- After the request, the quote appears with a countdown ("Accept · 9s"). Accept leads to **"Confirming…"** (`chunk:3v1hcpx41eiby.js`), then "Executed: N contracts at P¢ · View combo" with a toast. The slip is then cleared.

**Entry points.**
- The Live rail **◇ COMBO** button is a link to `/combos`.
- The event page has a **◇ COMBO** toggle above the ticket. In combo mode the outcome rows' Yes/No buttons add or remove legs (persisted), and a mini slip links to the builder.

**Combo event page.** Shows a legs card with per-leg status chips. It re-renders on the lifecycle events of the combo **and of its legs**. Normal order-book trading on the combo is allowed.

### 17.4 RFQ model

**Endpoints** (the docs' `/communications/...` paths under `/v1`):
- `POST /v1/communications/rfqs`
- `GET /v1/communications/rfqs?scope=mine|others`
- `GET /v1/communications/rfqs/:id`
- `DELETE /v1/communications/rfqs/:id`

**Sizing** takes exactly one of:
- `contracts_fp` / `contracts`: 0.01 steps, must match if both are given, never reduced for fees;
- `target_cost_dollars`: the requester's debit **including the taker fee**. Each quote derives the maximum units whose `ceil(u·p/100)+fee ≤ target` and returns them as `yes_contracts_fp` / `no_contracts_fp`.

*Source:* `getting_started_rfqs.md` §Sizing; `api-reference_communications_create-rfq.md`.

**Limits.**
- At most 100 open RFQs per user (doc).
- One open RFQ per user per market: 409 `rfq_exists` unless `replace_existing:true` (doc: "409 Conflict: Open RFQ already exists on this market ticker"; create-rfq has a "delete existing RFQs" flag).

**Persistence.** `rfqs`, with status `open | accepted | executed | expired | cancelled`, `closed_reason`, `expires_ts`.
- *UNKNOWN:* the RFQ lifetime. *Design choice:* 10 minutes (`combos.rfqTtlMs`).

**Pseudonymous IDs.** `creator_id` is `sha256(salt+uid)` truncated (`getting_started_rfqs.md` §Creator identity). The salt is persisted in meta.

### 17.5 Quotes, accept, confirm, execution

**Quotes.** `POST /v1/communications/quotes {rfq_id, yes_bid, no_bid}` (alias `POST /v1/communications/rfqs/:id/quotes`).
- Bids are dollars on the 1¢ grid. 0 declines a side, but not both. `yes_bid + no_bid ≤ $1.00` (400 `invalid_parameters`).
- A new quote from the same maker replaces the previous one (old status `cancelled`, reason `replaced`).
- Quotes are private to the requester and that maker.
- A quote expires after `quoteTtlMs` (default 20 s; configurable).
- *Sources:* `getting_started_rfqs.md` §Quotes; `api-reference_communications_create-quote.md`.
- *UNKNOWN:* combos use the `center_deci_edge_centi_cent` grid (doc). *Design choice:* the cent grid everywhere.

**Accept.** `PUT /v1/communications/rfqs/:id/quotes/:qid/accept {accepted_side}` (alias `PUT /v1/communications/quotes/:qid/accept`).
- `accepted_side` names the **bid accepted**: `"no"` accepts the maker's NO bid, so the requester buys **YES at `100 − no_bid`**; `"yes"` means the requester buys NO at `100 − yes_bid`.
- *UNKNOWN; design choice.* `chunk:3v1hcpx41eiby.js` colours `accepted_side==="no"` with the YES colour, consistent with this choice.
- The requester's balance is checked at accept (409 `insufficient_balance`), and so is the trading limit.
- The quote becomes `accepted` with `confirm_deadline_ts`; the RFQ becomes `accepted`.

**Confirm.** `PUT /v1/communications/quotes/:qid/confirm` (maker only).
- After the window (`confirmWindowMs`, default 30 s) the accepted quote becomes `expired` (reason `not_confirmed`) and the RFQ reopens.
- *Source:* `getting_started_rfqs.md` §Timing (standard 30 s, HVM 3 s).
- *UNKNOWN; design choice:* one configurable window for all markets, because human makers also quote combos. The execution timer is 0: confirmation executes synchronously so errors reach the confirmer.

**Execution through the real engine.**
1. The maker's **post-only** order rests at its bid for the RFQ size, with `order_type 'rfq'`.
2. The requester's IOC order crosses **exactly that order** (`match_order_id`) at the quoted price, with `exact_reserve`.
3. Any maker remainder is canceled.
4. Fills, taker fee, ledger, positions, netting and notifications behave as for any trade. The quote stores `maker_order_id` (`creator_order_id`) and `taker_order_id` (`rfq_creator_order_id`) (doc: "Match on `creator_order_id` … or `rfq_creator_order_id`").

**Failures.**
- Maker short of cash: 409 `insufficient_balance`, and the quote stays `accepted` so the maker can retry within the window.
- Maker order would cross the book: 409 `post_only_cross`, the quote is `cancelled` (`would_cross`), and the RFQ reopens (doc §Post-only quotes).
- Requester short of cash at execution: 409 `requester_insufficient_balance`, the maker order is canceled, and the quote is `cancelled`.

### 17.6 Two-sided RFQs, opt-in and Portfolio tabs

**Opt-in.** The user property `rfq_enabled` (in `SETTING_KEYS`; `chunk:3v1hcpx41eiby.js` `rfqEnabled` / `useRfqEnabled`) is required to:
- see and quote other users' RFQs (`scope=others`);
- request RFQs on single markets (403 `rfq_not_enabled`).

Requesting on combos is always allowed. The event-page ticket gets a **Request quote** mode (`order_type:"rfq"` in `chunk:3v1hcpx41eiby.js`) when the property is on.

**Portfolio tabs.** The observed tab set is `["position","resting","rfqs","quotes","history"]` (`chunk:0b-vmmhwqitt_.js`). Deep links: `/portfolio?tab=rfqs|quotes` (`&scope=others`). The tab is persisted in `portfolio_view`.
- **RFQs:** "Yours" | "Other RFQs" (`chunk:3v1hcpx41eiby.js` `myRfqs`, `allQuotes`, `quotesForMyRfqs`, `myOpenRfq`, `"Other RFQs"`).
  - Yours: market, size or target, status, age, open quotes as **Buy YES p¢ · n** / **Buy NO p¢ · n** with countdowns, and Cancel. Accepted RFQs show "waiting for maker" with a countdown.
  - Other RFQs: market, size, age, your quote and status, and a quote form (cents; client validation mirrors the server's).
- **Quotes:** quotes you made and quotes on your RFQs. Shows prices, size, status, **Confirm order · Ns** (shows **"Confirming…"** while running) and Delete (open quotes only; an accepted quote cannot be deleted).

### 17.7 Simulated maker

The liquidity user `liquidity@parlance.local` quotes **combo** RFQs only.
- *UNKNOWN; design choice:* single markets have book liquidity.
- Pricing: `fair = Π leg probabilities` (last price, else mid). Spread `s = max(3¢, ceil(8%·fair))`. `yes_bid = floor(fair − s)`, `no_bid = floor(100 − fair − s)`, clamped. The sum stays below $1.
- It re-quotes an open RFQ whenever it has no live quote, so an expired quote is replaced.
- It auto-confirms accepted quotes after `autoConfirmMs`.
- All timers are accelerators only. The tick sweep re-derives quotes, expiries, lapses and auto-confirms from persisted timestamps, so a restart neither loses nor repeats a transition.
- Test configuration: `start({combos:{quoteTtlMs, rfqTtlMs, confirmWindowMs, makerDelayMs, autoConfirmMs, spreadCents}})`.

### 17.8 WebSocket and notifications

**Private channel `communications`** (`server/ws.js`; doc: "Quote notifications arrive on the `communications` WebSocket channel").
- `rfq_created` and `rfq_deleted` go to every authenticated subscriber, with no requester identity beyond `creator_id`.
- `quote_created`, `quote_accepted`, `quote_executed`, `quote_expired` and `quote_deleted` go only to the requester and that maker.
- The RFQs, Quotes, Positions and History tabs and `/combos` update live.

**Notifications** (persisted; toasts):
- `rfq_quote` ("Quote received", to the requester, for human makers);
- `rfq_accepted` ("Your quote was accepted — confirm within Ns", to the maker);
- `rfq_executed` (both sides);
- `rfq_failed`;
- `order_expired` (§17.10).

### 17.9 Portfolio History

**Endpoint.** `GET /v1/users/:uid/history?type=all|trades|orders|settlements|combos|cash&market=&from=&to=&cursor=&limit=` returns one server-paginated timeline. It is a `UNION ALL` over persisted tables; no new event table is needed.

| Row type | Source |
| --- | --- |
| Order placed (with the user's action, side, type and "x of y filled") | `orders` |
| Canceled / expired remainder | `orders` |
| Fill (signed cost: taker ceil, maker floor; fee; maker/taker role) | `fills` |
| Settlement (result, quantity, +payout) | `settlements` |
| Netting, deposit, withdrawal, interest, perps transfer | `ledger` (the perps tables are not read) |
| Combo built | `combo_creations` |
| RFQ requested, quote made, RFQ execution (as requester or maker) | `rfqs` / `rfq_quotes` |

- **Ordering:** time desc, then a tie-break priority (cancel > settlement/ledger > fill > order), then id.
- **Cursor:** a keyset `(ts, prio, id)`, so live inserts do not shift pages.
- **Sells:** sells are stored as buys of the other side. History shows the user's intent ("Sold YES …"), using the new `orders.action` and `order_type` columns.

**CSV.** `GET /v1/users/:uid/history.csv` (same filters, up to 10,000 rows) has the columns `time,type,market,description,side,action,quantity,price_dollars,amount_dollars,fee_dollars,status`, with RFC-4180 quoting.

**UI.**
- Chips: All, Trades, Orders, Settlements, Combos/RFQ, Cash. Also a market search and from/to dates.
- Filters are persisted in the user property `history_filters`.
- **Load more** uses the cursor; **Download CSV** exports the filtered view.
- New fills and order or balance changes prepend live without a reload.
- The earlier Trade history, Settlements and Transactions tables are History sub-views (`data-tab=fills|settlements|transactions`).

**UNKNOWN:** the live site's exact History columns and grouping. *Design choice:* the columns above.

### 17.10 Resting orders

**Server** (doc paths `/portfolio/events/orders/{id}/amend|decrease`, `DELETE /portfolio/events/orders`, `/portfolio/orders/{id}/queue_position`, `/portfolio/orders/queue_positions` map to `/v1/users/:uid/orders/...`):
- **Amend:** `POST …/orders/:id/amend {price|price_dollars, count|count_fp (new total = filled + remaining), expiration_time}`.
  - A price change or a size increase **forfeits queue position**: the order gets a new `seq`, the same id, a new reservation, and may fill immediately.
  - Changing only the expiry, or decreasing the size, keeps it.
  - The response includes `queue_priority_kept`.
  - *Source:* `api-reference_orders_amend-order-v2.md` ("Amending only expiry or decreasing size preserves queue position. Increasing size or changing price forfeits queue position").
  - Prices are in the user's terms: for sells, the stored price is `100 − p`.
- **Decrease:** `POST …/orders/:id/decrease {reduce_by | reduce_to}`, exactly one (`api-reference_orders_decrease-order-v2.md`). It keeps `seq` and refunds `reserved − R(new)` exactly. `reduce_to 0` cancels.
- **Cancel all:** `DELETE /v1/users/:uid/orders?market_ticker=&event_ticker=` (`api-reference_orders_cancel-all-orders.md`, here scoped).
- **Queue position:** contracts ahead at the same market, side and price with a lower `seq` (`api-reference_orders_get-order-queue-position.md`: "number of preceding shares"). Returned as `queue_position_fp` per order and in bulk.
- **Good-til-time:** limit orders may carry `expiration_time`. IOC types cannot (`api-reference_orders_create-order-v2.md`: "`immediate_or_cancel` … cannot be combined with `expiration_time`").
  - The engine tick cancels expired orders (`cancel_reason='expired'`), releases the reservation, emits `user_orders` and notifies (`order_expired`).
  - It is persisted (`orders.expiration_ts`), so it works across restarts.

**UI.** The **Resting** tab lists rows grouped by event, then market (market link, outcome).
- Columns: side as BUY/SELL YES/NO, limit price, filled/total (2 dp), remaining, reserved, queue position, placed time, expiry countdown (or GTC) and status.
- Actions: inline **Edit** (price, total, expiry: keep / never / end of day / custom) with validation; **Decrease**; **Cancel**; per-market **Cancel market**; **Cancel all** with a confirm dialog; and an empty state.
- The ticket's Limit mode has **Expires: Never (GTC) / End of day / Custom**.
- *UNKNOWN:* the live end-of-day definition. *Design choice:* the user's local 23:59:59.

### 17.11 Positions

**Server.** `GET /v1/users/:uid/portfolio/positions?sort=value|pnl|closing&filter=all|open|closing|combos` returns positions grouped by event. Each position carries:
- side and quantity (2 dp);
- average price;
- **cost basis including fees paid** (the position's `fees_paid_cents`; `chunk:3v1hcpx41eiby.js` `positionFeeCost`);
- mark: last trade, else mid, mirrored for NO;
- market value; unrealized P&L in $ and %; realized P&L;
- **payout if right** (`q` units = `q` cents);
- **sell now**: walks the resting bids of the held side, excluding the user's own orders, exactly like a market sell (`q − ceil(q·(100−bid)/100) − fee` per level). INFERRED from `chunk:1al56gdla-56l.js` `collateralReturnedCents`; the exact live formula is UNKNOWN;
- resting-order count, market status and close time;
- state `open | settling (result) | closed`;
- for combos, legs with per-leg status.

Per-market position objects are INFERRED from `chunk:1_rhh98rkbbd9.js` `marketPosition`. The summary has total value (cash + held + positions), cash, positions value, today's change (vs `previous_price`) and all-time P&L (realized + unrealized). Open combos are counted (`chunk:2tu-kprteoa73.js` `openCombos`/`totalOpenCombos`/`openCombosEventTickers`).

`GET /v1/users/:uid/positions/:ticker/sell_quote?count=` is the Sell sheet estimate.

**UNKNOWN:** "closing soon" and the exact P&L definitions. *Design choices:* closing soon = closes within 7 days; unrealized P&L = value − (cost + fees).

**UI.** Positions is the default tab.
- A summary header; filter chips (All / Open / Closing soon / Combos) and a sort select (Value / P&L / Closing soon), persisted in `positions_filter` and `positions_sort`.
- Event group rows. Market rows keep `tr[data-ticker]` with outcome, side and contracts first.
- Each row has a **Sell** sheet: partial size or **Max**, Market or Limit, a live estimate of proceeds and fee from the server walk, submitted through the normal sell path. It also has **Buy more** (links to the ticket with market and side) and the existing **Close**.
- Settled combos are listed below.
- Live re-marking on `ticker`, `fill`, `user_orders` and `user_balance`.

### 17.12 UNKNOWN / design-choice summary

| # | Topic | Choice |
| --- | --- | --- |
| C1 | Sub-cent amounts | Integer cents; taker ceil / maker remainder; fee ceil; no accumulator (§16.2) |
| C2 | Fractional markets | All seeded markets except PLXSTATE; combos and rolling markets on (§16.3) |
| C3 | Combo ticker | sha256 of the sorted legs (§17.1) |
| C4 | Leg limits | 2–6 legs, distinct events, active non-combo non-rolling markets |
| C5 | Combo price grid | Cent grid (doc: deci/centi-cent edges) |
| C6 | `accepted_side` meaning | The bid accepted; the requester takes the other side |
| C7 | Timers | Quote 20 s, RFQ 10 min, one confirm window of 30 s, execution timer 0; all configurable |
| C8 | Simulated maker | Combos only; product of leg odds ± max(3¢, 8%) |
| C9 | Slip storage | Server-side, per user |
| C10 | History columns / CSV | As in §17.9 |
| C11 | End of day / closing soon | Local 23:59:59 / 7 days |

### 17.13 Verification

`npm run test:e2e` runs ten files. The six new ones:

| File | Covers |
| --- | --- |
| `tests/fractional.e2e.test.js` | Units, exact cents, Dollars and sells, validation, hide-fractional setting, settlement, migration, restart, 390 px |
| `tests/combos.e2e.test.js` | Rail button, slip persistence, quote → accept → Confirming… → executed with DB checks, idempotency and validation, expiry, re-quote and cancel, event combo mode, leg-driven resolution and settlement, restart, 390 px |
| `tests/rfq.e2e.test.js` | Two users: opt-in, ticket Request quote, live Other RFQs, quote validation, live accept, maker confirm with exact fills, fees and balances, lapse, delete, cancel, balance errors, restart, 390 px |
| `tests/orders.e2e.test.js` | Expires option, queue position, decrease keeps / amend loses priority with exact reservations, live partial fill, GTT expiry, cancel / market / all, restart, 390 px |
| `tests/positions.e2e.test.js` | Default tab, values vs DB and book, live re-mark, Sell sheet cash = estimate, combo legs, sort/filter persistence, settling → removed, restart, 390 px |
| `tests/history.e2e.test.js` | Every row type with signed amounts that reconcile to the cash balance, pagination, CSV, live prepend, persisted filters, restart, 390 px |
