# CLONE_SPEC — Binary event-contract exchange web app (black-box study of kalshi.com)

Status: clean-room specification. Written only from observed behavior: captured network traffic, public documentation, and string-level facts from shipped JavaScript bundles. It contains no copied source code, styles, images, fonts or text assets. Implementers should build from this document only.

> **Revision 2 — which Kalshi version this describes.** Sections 1–12 were written from the **2026-02-22 archived frontend build** plus the live public API and docs. The live site blocked this environment, so the UI could not be loaded directly (§0.3). **Section 13 updates the spec to the live site as of 2026-11-02 11:18–11:20 UTC (Next.js build `v3-3LP8JYaUgMIitMhWMD`)**, using a browser HAR the user captured from their own logged-out session [HAR3]. Where §13 and earlier sections disagree, §13 is current.

Date of study: 2026-11-02. Tooling: REA (reverse-engineer-anything) MCP and CLI, a headless Chromium driven over CDP, and the public Internet Archive.

---

## 0. How to read this spec

### 0.1 Evidence keys

Every requirement carries a bracketed evidence tag. Tags resolve as follows.

| Tag | What it is | Retained identity |
|---|---|---|
| `HAR1#n` | Live captures of the public Trade API v2 (`https://api.elections.kalshi.com/trade-api/v2`), record ordinal *n* | REA Evidence `ev_2a706a10a8fdd99bd15bbd07c1ef1bbb04a0a321d15fd88343c60d3515129b80` (file `evidence/api.har`, sha256 `2735f3cf…eb50`) |
| `HAR2#n` | Live captures of the web client's own public `/v1` endpoints on the same API host, record ordinal *n* | REA Evidence `ev_e89289557f15bb8e8233dd5a338e01c35c68b3121e9d1cfeb1c3c9301a730a0d` (file `evidence/web_v1.har`, sha256 `0998d412…6762`) |
| `JS:<chunk>:"<string>"` | A literal string in a production JS chunk (`/_next/static/chunks/<chunk>.js`), from the 2026-02-22 archived build `dpl_APHhwGSMcEPDSpnuRWs1hfDeSf1J` | REA partial Evidence `ev_396bb459d71ca277376e9e723436df3f517e1b476ffa467c314af354dbc34dd3` (directory sha256 `c31a7da8…9b4`) |
| `DOC:<page>` | Public developer docs at `docs.kalshi.com` (`openapi.yaml` v3.35.0, `asyncapi.yaml`, and `*.md` pages) | `evidence/openapi.yaml`, `evidence/asyncapi.yaml` (other `.md` pages fetched live) |
| `SHOT:home` | Screenshot of the archived homepage, snapshot `web.archive.org/web/20260222130800/https://kalshi.com/` | `evidence/wb_home.png` |
| `CHK` | Capture of the live site refusing automated access | `evidence/checkpoint.net.json` |
| `HAR3#n` | **Live site, 2026-11-02**, user-supplied DevTools HAR from a logged-out Chrome 155 session (market page, Browse, Calendar and Social prefetches). *n* is the entry ordinal in the original 286-entry capture. | `evidence/web_live_2026-11-02.har` (98 first-party entries; identifying headers and third-party trackers removed; sha256 `9e28ea83…d008`; each entry keeps `_original_index`) |

HAR1 ordinals: 0 exchange/status · 1 exchange/schedule · 2 events?with_nested_markets · 3 series list · 4 search/tags_by_categories · 5 search/filters_by_sport · 6 markets?status=open · 7 events/{t} · 8 events/{t}/metadata · 9 series/{t} · 10 markets/{t} · 11 markets/{t}/orderbook · 12 markets/trades (got 429) · 13 candlesticks · 14 historical/cutoff · 15 milestones · 16 unknown market (404) · 17 portfolio/balance without auth (401) · 18 POST order without auth (401) · 19 `limit=abc` (400) · 20 `status=bogus` (400) · 21 `limit=100000` (400) · 22 cursor page 2.

HAR2 ordinals: 0 `/v1/bff/feed` · 1 `/v1/bff/home` · 2 `/v1/live_data/count` · 3 `/v1/search/series` · 4 `/v1/cached/series/fee_changes` · 5 `/v1/location` · 6 `/v1/keywords/` · 7 `/v1/events` · 8 `/v1/users/{id}/balance` without auth (401).

### 0.2 Confidence words

- **OBSERVED**: seen directly in a capture, screenshot or doc.
- **INFERRED**: deduced from code strings or structure. Execution was not observed.
- **UNKNOWN**: not established by the evidence. The clone must choose; any such choice is marked *design choice*.

### 0.3 Scope limits (read first)

1. **The live web UI could not be exercised.** Every request to `https://kalshi.com/` from this environment, including from a real Chromium, got **HTTP 429** with a *Vercel Security Checkpoint* page. The challenge POST `/.well-known/vercel/security/request-challenge` then returned status **708** [CHK]. The bot protection was not bypassed. As a result:
   - Logged-in screens (portfolio, account, deposits) were **not observed rendering**. Their behavior is INFERRED from bundle strings and the public API, or is UNKNOWN.
   - UI structure comes from one archived homepage render [SHOT:home] and the archived JS. Later archive snapshots (July 2026) also captured only the checkpoint.
2. Archive.org started rate-limiting after about 10 page loads. Market, browse, category, calendar, sign-up and portfolio snapshots could not be rendered (`chrome-error`). Their layouts are UNKNOWN beyond route names and API calls.
3. REA's full static analysis of the 77-chunk bundle hit its 300 s per-source deadline. Partial Evidence was retained (`ev_396bb459…`), and chunk-level string citations were taken directly from the same files.
4. **HAR3 limits.** It holds Fetch/XHR and React Server Component (RSC) payloads only: no document HTML, JavaScript, CSS, fonts or images, and no screenshots. It is logged-out. So for the current site, page structure, class names, font names, routes, data shapes and polling behavior are OBSERVED, but exact colors, spacing values and logged-in screens are still UNKNOWN (U15–U20).

---

## 1. Product summary

A regulated exchange for **binary event contracts**. Each market settles at **$1.00 for YES or $0.00** (or a scalar value). Users buy YES or NO at prices in $0.01–$0.99 and see prices as implied probabilities ("54%"). Content follows a hierarchy:

```
Series (template, e.g. "Fed meeting")  ─1:N─>  Event (one occurrence, e.g. "Fed decision in December")  ─1:N─>  Market (one binary outcome, e.g. "Cut 25bps")
```

[HAR1#2, HAR1#9, HAR1#10, DOC:api-reference/market/get-series]

Optional groupings: **Milestone** (a real-world happening, such as a game or race, that links several events) [HAR1#15, HAR2#1], **Structured target** (a team or person entity with an image) [JS:e290871032c0dda8:"/structured_targets/"], **Keyword/tag** [HAR2#6].

---

## 2. Architecture of the observed web client

| Aspect | Finding | Confidence | Evidence |
|---|---|---|---|
| Framework | Next.js App Router with React Server Components (`?_rsc=` fetches) and a Turbopack build | OBSERVED | Archive CDX lists `kalshi.com/?_rsc=…`; chunk `turbopack-b26eb5e120581326.js`; `globalThis.TURBOPACK` in every chunk |
| Hosting / edge | Vercel, with Vercel bot-mitigation challenge | OBSERVED | `server: Vercel`, `x-vercel-mitigated: challenge` [CHK] |
| HTTP client | axios instances with `withCredentials: true` and a per-request timeout | INFERRED | `JS:e290871032c0dda8:"this.exchangeApiV2="`, `"this.bffApi="`, `requestTimeoutMs` |
| API base clients | `exchangeApi` → `{API}/v1`; `exchangeApiV2` → `{API}/trade-api/v2`; `bffApi` → `{API}/v1/bff`; `statsApi` → stats host | INFERRED | same chunk |
| API host | `https://api.elections.kalshi.com` (prod); WS `wss://api.elections.kalshi.com` | INFERRED | `JS:b589944cd3448416:"exchangeWsUrl:\"wss://api.elections.kalshi.com\""` |
| Server-side data | Server components fetch public data with Next `revalidate` caching: feed 120 s, events 300 s, forecast history 3600 s | INFERRED | `JS:b589944cd3448416:"/v1/bff/feed"` with `revalidate:120`; `"/v1/events/"` with `revalidate:300`; `forecast_history` with `revalidate:3600` |
| State management | **Hybrid.** (1) A MobX root store (domain stores with `resolveX(id).updateFromVo(vo)` identity maps, `action` wrappers, `observer()` components). (2) TanStack-style query hooks (`useQuery` with `queryKey`, `staleTime`, `refetchInterval`) for newer features. (3) A few small zustand stores (e.g. support chat) | INFERRED | `makeAutoObservable` in 8 chunks, `observer(` in 19; `useQuery` ×18; `(0,i.create)()(…)` near `/v1/intercom/jwt` in `584b55ba4be030d2` |
| Transport layer | One "TransportLayer" class with one method per endpoint (`submitOrder`, `getProfile`, …). Each takes success/error callbacks and returns an axios CancelToken source | INFERRED | `JS:e290871032c0dda8:"submitOrder("` |
| Realtime | A single multiplexed WebSocket, `{WS}/v1/ws?csrfToken=…&frontend_session=…` | INFERRED | `JS:3473efe5315bf961:"/v1/ws"` |
| Styling | CSS-in-JS (emotion/styled), some Tailwind; custom webfonts; Material Symbols icon font | INFERRED | library strings; font requests in the archived load |
| Third parties | Analytics (Segment, Amplitude, Statsig), session replay (LogRocket), RUM (Datadog), Sentry, Intercom; fraud/KYC (Sardine, Riskified, Socure, Persona); payments (Plaid, Stripe, Braintree, Aeropay, Mesh crypto) | INFERRED | library-name hits across chunks; endpoints in §6 |

**Clone guidance (design choice):** any SPA framework works. Preserve these observable contracts: cookie session, CSRF header, the endpoint shapes in §5–6, the WebSocket protocol in §7, and the client-persistence keys in §9.

---

## 3. Client routes (screens)

Routes are recovered from `href`s in the archived homepage HTML and from route string literals in the JS. "Render observed" means seen in [SHOT:home] or the archived HTML.

| Route | Screen | Render observed | Evidence |
|---|---|---|---|
| `/` | Home / trending feed | yes | SHOT:home; HAR2#1 |
| `/markets/{series_ticker_lc}/{series_slug}/{event_ticker_lc}` | Event detail (all markets of one event) | link only | 60+ hrefs, e.g. `/markets/kxwohockey/winter-olympics-hockey/kxwohockey-men26cgold` |
| `/markets` · `/markets/` | Markets index | string only | `JS:…:"/markets"` |
| `/browse?order_by=event-volume&status=open` | Browse grid with sort and filter | link only | homepage href |
| `/category/{category}[/{sub}[/{leaf}]]` | Category feed, e.g. `/category/sports/basketball/pro-basketball-m` | link only | homepage hrefs; `JS:…:"/category/sports/"` |
| `/sports/` · `/sports/all-sports` | Sports hub | string only | `JS` literals |
| `/live/{slug}` | Live milestone page | string only | `JS:…:"/live/trump-agenda"`; nav item "LIVE 44" in SHOT:home |
| `/calendar` | Event calendar | string only | `JS:2445a5e65c18ea63:"/calendar"` |
| `/watchlist` | User watchlist | string only | `JS:2445a5e65c18ea63:"/watchlist"` |
| `/portfolio` | Positions, orders, history (auth) | string only | `JS` literals; storage keys `kalshi-portfolio-*` |
| `/account/banking` · `/account/referrals` | Account settings (auth) | string only | `JS` literals |
| `/ideas` · `/ideas/feed` · `/ideas/posts/{id}` · `/ideas/profiles/{nickname}` | Social feed ("SOCIAL" in nav) | string only | homepage href `/ideas/feed`; `JS` literals |
| `/tag/{tag}` | Tag listing | link only | `/tag/international-relations` |
| `/sign-in` | Log in (title "Sign in to your Account") | title only | archived nav (2026-06-13) |
| `/sign-up` + `/sign-up/{email,password,phone-number,phone-verify,verify,two-factor-code,birthday,profile,profile-address,identity,banking,survey,review-needed,duplicate-account,reactivate-account,on-the-go}` | Multi-step registration wizard | string only | `JS:113d82f2bef48b8f:"/sign-up/identity"` and siblings |
| `/search` | Search results | string only | `JS` literal |
| `/faq` `/fee-schedule` `/incentives` `/market-integrity` `/privacy-policy` `/regulatory` `/responsible-trading` | Static legal/info pages | link only | homepage footer hrefs |

Event URL rule (OBSERVED from hrefs): lower-cased series ticker, then a human slug of the series, then the lower-cased event ticker. The slug is decorative; resolution uses the tickers (INFERRED).

---

## 4. Screens, components and state machines

### 4.1 Global header [SHOT:home]

- Brand wordmark (left), then primary nav: **Markets**, **Live** with a red live-count badge (e.g. "44"), **Social**.
- Search input with placeholder text in the spirit of "trade on anything"; magnifier icon.
- Logged out: **Log in** (outlined) and **Sign up** (filled) buttons. Logged in: UNKNOWN (expected balance/portfolio/avatar; not observed).
- Category tab strip: Trending · Politics · Sports · Culture · Crypto · Climate · Economics · Mentions · Companies · Financials · Tech & Science. The active tab is bold.
- **Live count**: `GET /v1/live_data/count` → `{"count":99}` [HAR2#2]. Polled every **30 s**, `staleTime` 30 s, no polling while the tab is hidden [JS:afefab63e6753a28:"refetchInterval:3e4"].

### 4.2 Home (`/`) [SHOT:home, HAR2#0–1]

Data: `GET /v1/bff/home` returns `{home:{highlights[], trending[], top_categories[], sports_competition_recs[]}, hydrated_data:{milestones{}, structured_targets{}, keywords{}}}` [HAR2#1]. Below the fold, `GET /v1/bff/feed?…` returns `{sections:[{type, keyword_id, keyword, display_label, cards[], use_section_results_for_see_more}], hydrated_data}` [HAR2#0]. Sections are paged by query string; the exact params are UNKNOWN. On failure the feed falls back to an empty structure `{sections:[], hydrated_data:{milestones:{},structured_targets:{},keywords:{}}}` [JS:b589944cd3448416:"fetchBffPublicFeed"].

Layout, left column (OBSERVED):
1. **Hero carousel** of highlight cards with a "1 of 7" pager and prev/next arrows. Each card shows the event title, a market table (columns *Market · Pays out · Odds*), and per-outcome rows: avatar, name, payout multiplier (e.g. `1.79x`), and a probability pill (`54%`). It also shows total volume (`$12,672,872 vol`), a secondary link (e.g. "Spread and Total"), a news blurb, and a line chart of price history on the right.
2. **Top Markets** grid. Each card: title, thumbnail, 2+ outcome rows with name, multiplier and % pill. A LIVE badge plus game state ("Round 3") for live milestones; sports cards show score chips.

Right rail (OBSERVED): **Trending** (top 3 with rank, title, subtitle, %, and delta arrow ▲/▼ with value), **Top movers** (same format), **New** (truncated). Each heading links to a list.

Display formulas (INFERRED from shown numbers):
- *Odds %* = YES price in cents (e.g. $0.54 → 54%). Which of last/bid/ask is used is UNKNOWN; *design choice*: last trade price, falling back to the bid/ask midpoint.
- *Pays out multiplier* = 1 / price (1/0.54 ≈ 1.85; the screen shows 1.79x, so fees or ask are likely included). Exact formula UNKNOWN; *design choice*: `1 / yes_ask`, 2 decimals.
- *Delta* = current minus previous price in cents (`previous_price_dollars`) [HAR1#10].

### 4.3 Event detail (`/markets/{s}/{slug}/{e}`)

Render not observed. Data sources (INFERRED from code; endpoints OBSERVED):
- Event with nested markets: `GET /v1/events/{event_ticker}` (server, revalidate 300 s). If any market is `initialized` with `open_date` in the past, the client refetches uncached [JS:b589944cd3448416:"/v1/events/"]. Public v2 equivalent: `GET /trade-api/v2/events/{t}?with_nested_markets=true` [HAR1#7].
- Event metadata (image URL, per-market `color_code`, settlement sources) [HAR1#8].
- Series (rules, contract URLs, fee type, settlement sources) [HAR1#9].
- Price history: `/v1/cached/series/{s}/markets/{m}/forecast_history?start_ts&end_ts&period_interval&candlestick_function=mean_price`, and an event-level variant [JS:b589944cd3448416:"forecast_history"]. Public: `GET /series/{s}/markets/{m}/candlesticks?start_ts&end_ts&period_interval∈{1,60,1440}` → `candlesticks[{end_period_ts, price{open,high,low,close,mean,previous}_dollars, yes_bid{…}, yes_ask{…}, volume_fp, open_interest_fp}]` [HAR1#13].
- Order book: initial REST `GET /markets/{t}/orderbook` → `{orderbook_fp:{yes_dollars:[[price,count]…], no_dollars:[…]}}`, bids only, ascending price [HAR1#11, DOC:orderbook_responses]. Then WS `orderbook` channel (§7).
- Recent trades: `GET /trade-api/v2/markets/trades?ticker=…` [JS:e290871032c0dda8:"exchangeApiV2.get(\"/markets/trades\""]; this request got **429** during capture [HAR1#12].
- Per-user position for the event (auth): `/v1/users/{id}/event_positions/{event}`.
- Tabs remembered client-side: market-section tab, social-section tab and bottom tab (keys in §9).

Order book semantics (OBSERVED in docs): a YES bid at *p* is equivalent to a NO ask at *1−p*. Best YES ask = 1 − best NO bid. The ticker message fields `yes_bid_dollars`, `yes_ask_dollars` and `no_*` follow this rule [HAR1#10: yes_ask 0.10 ↔ no_bid 0.90].

#### Trade ticket state machine (INFERRED; the UI was not observed)

```
idle ──select outcome(YES/NO)──> editing ──submit──> submitting ──200──> confirmed(order.status ∈ {executed, resting, canceled})
  ^                                │                     │
  └──────────close/clear───────────┘                     └─4xx/5xx──> error(message from error.code) ──edit──> editing
```

- Request (web client): `POST /v1/users/{user_id}/orders`, body = order spec. Response `{order, status}` [JS:e290871032c0dda8:"submitOrder("]. Public v2: `POST /trade-api/v2/portfolio/events/orders` with single-book `bid`/`ask` side and dollar-string prices [DOC:create-order-v2].
- Amend: `POST /users/{id}/orders/{oid}/amend`. Decrease: `…/decrease`. Cancel: `DELETE /users/{id}/orders/{oid}`. Queue position: `GET …/queue_position` [JS:e290871032c0dda8].
- After close, every order operation, cancel included, is rejected with `MARKET_INACTIVE` [DOC:market_lifecycle].
- Duplicate-submit guard: the client cancels an identical request (same method+url+params+data) re-sent while `document.hidden`, unless flagged `allowRequestEvenIfPageIsHidden` [JS:e290871032c0dda8:"Cancel request due to page not being visible."].

### 4.4 Market lifecycle state machine (OBSERVED, DOC:market_lifecycle)

```
initialized ──open_time──> active ──close_time──> closed ──result set──> determined ──timer(settlement_timer_seconds)──> finalized
                             │  ^                    ^  │                   │                                          ^
                deactivated  v  │ activated          │  └─close_time moved─>│active (close_date_updated, activated)    │
                          inactive ──close_time──────┘                      └─dispute──> disputed ──> amended ──timer────┘
```

- REST filter mapping: `unopened`→initialized, `open`→active, `paused`→inactive, `closed`→past close but not finalized, `settled`→finalized. Any other value → **400** `{"error":{"code":"bad_request","message":"bad request","details":"invalid status filter"}}` [HAR1#20].
- Reactivating from `inactive` cancels all resting orders.
- `result ∈ {"yes","no","scalar",""}`. `settlement_timer_seconds` example: 1800 [HAR1#10].

### 4.5 Browse / Category / Search

- Browse is a series/event grid. Sort key is persisted locally (`kalshi-search-series-order-by`). The URL carries `order_by=event-volume&status=open` (OBSERVED href).
- Data: `GET /v1/search/series?…` → `{total_results_count, current_page:[{series_ticker, series_title, event_ticker, event_title, event_subtitle, category, total_series_volume, total_volume, markets:[{ticker, yes_bid_dollars, yes_ask_dollars, last_price_dollars, price_delta, close_ts, …}], is_trending, is_new, is_closing, is_price_delta, search_score, tags, fee_type}], next_cursor, suggested_pages[], search_id}` [HAR2#3]. The server loops on `next_cursor` until it runs out [JS:b589944cd3448416:"/v1/search/series"].
- Category taxonomy: `GET /search/tags_by_categories` → `{tags_by_categories:{Category:[tag…]|null}}` [HAR1#4]. Sports filters: `GET /search/filters_by_sport` [HAR1#5].
- Related series: `/v1/search/related_series`. Social profile search: `/v1/search/social_profiles` [JS:e290871032c0dda8].
- Empty results: UNKNOWN. *Design choice*: show a "no markets match" empty state.

### 4.6 Portfolio (auth; render not observed)

INFERRED from endpoints and storage keys:
- Balance: WS `user_balance` messages (`msg.available`) [JS:e290871032c0dda8:"channels:[\"user_balance\"]"]. Public `GET /portfolio/balance` → 401 without auth [HAR1#17].
- Current value `/users/{id}/portfolio/current_value`; sampled portfolio chart `/users/{id}/sampled_portfolio?…`; event positions `/users/{id}/event_positions?…`; resting orders; order history `/users/{id}/order_history`; trade history `/users/{id}/trade_history`; settlements `/users/{id}/settlement_history`; P&L `/users/{id}/account/realized_pnl…`; CSV export of transactions [JS:e290871032c0dda8:"transactionsCSV("].
- View toggles persisted locally: `kalshi-portfolio-view`, `kalshi-portfolio-show-open`, `kalshi-portfolio-show-pending`, `kalshi-portfolio-compact-table`, `kalshi-portfolio-filter-category-enabled`, `kalshi-PortfolioEventsSort(Order)`, `kalshi-AllRestingEventsSort(Order)`.

### 4.7 Authentication & registration

| Step | Endpoint (web `/v1`) | Evidence |
|---|---|---|
| Log in (MFA path) | `POST /log_in_mfa?four_digit_code=true` | JS:e290871032c0dda8 |
| Log in, password step | UNKNOWN exact path (expected `/log_in`) | — |
| OAuth (Google) | `POST /oauth/{provider}/callback?four_digit_code=true`; route `/oauth-web/google/callback` | JS |
| Log out | `POST /log_out`; also clears color palette and theme cookie | JS:e290871032c0dda8:"/log_out" |
| Sign up | `POST /users` (+query), `GET /users/{id}/sign_up`, `POST /resume_sign_up`, `/users/{id}/verify_phone`, `/verify`, `/sign_up/digital_verification`, `/sign_up/document_verification`, `/docv_token` | JS |
| Password reset | `POST /passwords/reset`, `PUT /passwords/reset/{token}/confirm` | JS |
| 2FA | `/users/{id}/auth_configuration`, `/auth_configuration/authenticator_app`, `/action_verification_mfa` | JS |

Session model (INFERRED): a cookie session (`withCredentials`) plus a CSRF token stored in localStorage under **`csrfToken`** with an expiry wrapper, sent as header **`x-csrf-token`** on every axios request [JS:4fc61d5ac521de17:"CSRF_HEADER_NAME\",0,\"x-csrf-token\""]. On a response flagged *unauthorized*, the client clears the stored user id and access level [JS:e290871032c0dda8:"clearUserId"].

Registration wizard step order (INFERRED from route names; branch conditions UNKNOWN): email → password → phone-number → phone-verify → two-factor-code → birthday → profile → profile-address → identity (KYC) → banking → survey → (review-needed | duplicate-account | reactivate-account).

### 4.8 Other user features (INFERRED from endpoints; not rendered)

Watchlist / favorited series (`GET/PUT/DELETE /users/{id}/favorited_series[/{s}]`); keyword follows; notifications (list, mark read, settings, custom price targets, price-movement subscriptions); responsible-trading controls (`trading_limits`, `trading_cool_off`, `self_exclusion`, `deposit_limit`, `daily_session_time_limit`); referrals; API keys; deposits/withdrawals across Plaid, debit, Braintree, Stripe, Aeropay and crypto; tax documents; support tickets (Zendesk); social (posts, comments, likes, bookmarks, follows, leaderboard, badges, top holders, profile metrics). All are in JS:e290871032c0dda8 (see §6).

---

## 5. Public REST API (Trade API v2): protocol facts

Base URLs: `https://external-api.kalshi.com/trade-api/v2` and the shared `https://api.elections.kalshi.com/trade-api/v2`; demo at `https://demo-api.kalshi.co/trade-api/v2` [DOC:openapi.yaml servers]. 136 operations in 18 tags: account, api-keys, communications (RFQ/quotes/block trades), events, exchange, fcm, historical, incentive-programs, live-data, market, milestone, multivariate, order-groups, orders, portfolio, search, structured-targets [DOC:openapi.yaml].

### 5.1 Encoding conventions (OBSERVED)

- Prices are **dollar strings with 4 decimals**: `"0.0800"`. Quantities are **fixed-point strings with 2 decimals** (`_fp` suffix): `"2927.71"`. Fields end in `_dollars` or `_fp` [HAR1#10]. Fractional contracts exist.
- Timestamps: RFC 3339 strings (`close_time`, `created_time` with microseconds). Candles use unix seconds (`end_period_ts`) [HAR1#10, HAR1#13]. Zero time renders as `0001-01-01T00:00:00Z` [HAR1#7].
- Price grid: `price_level_structure:"linear_cent"`, `price_ranges:[{start:"0.0000",end:"1.0000",step:"0.0100"}]` [HAR1#10].
- Pagination: opaque base64 `cursor` in the response; pass `cursor=` to continue; empty cursor means end [HAR1#2, HAR1#22, DOC:pagination].
- Fees: `fee_type` ∈ {`quadratic`, `quadratic_with_maker_fee`, …} with `fee_multiplier` [HAR1#9, HAR2#3]. Trade fee is rounded **up** to $0.000001, then a rounding fee re-aligns the balance to $0.0001 (direct) or $0.01 (non-direct), with a per-order rebate accumulator [DOC:fee_rounding]. The fee-model coefficient is **UNKNOWN** from this evidence.

### 5.2 Market object fields (OBSERVED, HAR1#10)

`ticker, event_ticker, market_type("binary"), title, yes_sub_title, no_sub_title, status, open_time, close_time, expected_expiration_time, latest_expiration_time, expiration_time, settlement_timer_seconds, can_close_early, early_close_condition, rules_primary, rules_secondary, result, expiration_value, yes_bid_dollars, yes_ask_dollars, no_bid_dollars, no_ask_dollars, yes_bid_size_fp, yes_ask_size_fp, last_price_dollars, previous_price_dollars, previous_yes_bid_dollars, previous_yes_ask_dollars, volume_fp, volume_24h_fp, open_interest_fp, notional_value_dollars("1.0000"), price_level_structure, price_ranges[], settlement_bounds_type, exchange_index, created_time, updated_time`.

Event fields [HAR1#2]: `event_ticker, series_ticker, title, sub_title, category, mutually_exclusive, strike_period, collateral_return_type, settlement_sources[{name,url}], exchange_index, last_updated_ts, markets[]`.
Series fields [HAR1#9]: `ticker, title, category, categories[], tags[], frequency, fee_type, fee_multiplier, contract_url, contract_terms_url, settlement_sources[], additional_prohibitions[], product_metadata{}`.
Exchange status [HAR1#0]: `exchange_active, trading_active, intra_exchange_transfers_active, exchange_index_statuses[]`. Schedule [HAR1#1]: `standard_hours[{monday:[{open_time,close_time}]…}], maintenance_windows[]`.

### 5.3 Authentication (DOC:openapi.yaml securitySchemes, DOC:api_keys)

API clients sign each request with RSA-PSS. Headers: `KALSHI-ACCESS-KEY`, `KALSHI-ACCESS-TIMESTAMP` (ms), `KALSHI-ACCESS-SIGNATURE` (base64 over timestamp+method+path). An OAuth bearer alternative exists. The browser app uses cookie session + CSRF instead (§4.7).

### 5.4 Error behavior (OBSERVED)

| Case | Status | Body | Evidence |
|---|---|---|---|
| Unknown market ticker | 404 | `{"error":{"code":"not_found","message":"not found"}}` | HAR1#16 |
| Auth required, none sent (v2) | 401 | `{"error":{"code":"token_authentication_failure","message":"token authentication failure"}}` | HAR1#17, #18 |
| Auth required (web v1) | 401 | same, plus `"support_action":"support_chat"` | HAR2#8 |
| Bad enum value | 400 | `{"error":{"code":"bad_request","message":"bad request","details":"invalid status filter"}}` | HAR1#20 |
| Unparseable param (`limit=abc`) | 400 | `{"msg":"Invalid format for parameter limit: …"}` (**different envelope**) | HAR1#19 |
| Param out of range (`limit=100000`) | 400 | `{"msg":"Parameter validation failed for GetMarkets: …'lte' tag"}` | HAR1#21 |
| Rate limited | 429 | `{"error":{"code":"too_many_requests","message":"too many requests"}}` | HAR1#12 |
| Order op after close | 4xx | code `MARKET_INACTIVE` (exact HTTP status UNKNOWN) | DOC:market_lifecycle |

Client classification (INFERRED): the web client maps errors to `{notFound, cancelled, tooManyRequests, timeout, maintenance, unauthorized}`. The first four are logged as info, not errors. `maintenance` disconnects with reason "maintenance". `error.service==="auth"` disconnects with "unavailability". `error.service==="query-exchange"` sets a "query exchange down" flag. `unauthorized` clears the stored user id [JS:e290871032c0dda8:"handleErrorCallback("].

Rate limits (DOC:rate_limits): token-bucket "tiers" with per-endpoint token costs (`GET /account/endpoint_costs`), separate read/write budgets, and WebSocket connection caps.

---

## 6. Web-client internal API inventory (`{API}/v1`)

244 distinct call sites were recovered [JS:e290871032c0dda8, b589944cd3448416, others; full list in `evidence/api_callsites_home.txt`]. Grouped (`{u}` = user id):

- **Market data:** `GET events/`, `cached/events/`, `markets/{id}`, `cached/markets/{id}`, `markets_by_ticker/{t}`, `cached/markets_by_ticker/{t}`, `series/`, `series/{t}`, `cached/series/fee_changes`, `brackets/series/{t}`, `structured_targets/`, `milestones/`, `live_data/{type}/milestone/{id}`, `live_data/batch?milestone_ids=`, `live_data/feed`, `live_data/milestone/{id}/game_stats`, `live_data/count`, `keywords/`, `incentive_programs/`, `multivariate_event_collections/…` (+ `PUT …/lookup`, `POST`).
- **BFF:** `GET /bff/home`, `/bff/home/feed`, `/bff/feed`, `/bff/category/{c}`, `/bff/users/{id}…`.
- **Search:** `search/series`, `search/related_series`, `search/filters_by_sport`, `search/tags_by_categories`, `search/social_profiles`, `search/experiment_key`.
- **Session/auth:** `log_in_mfa`, `log_out`, `oauth/{p}/callback`, `oauth/log_in_mfa_required`, `passwords/reset`, `resume_sign_up`, `referral_signup`, `sardine/session`, `location` (→ `{country_iso, state_iso, city_name, postal_code}` [HAR2#5]), `intercom/jwt`.
- **User:** `GET/PUT/DELETE /users/{u}`, `properties` (GET/PATCH), `subscribe` (PATCH), `email`, `password`, `ssn`, `attribution`, `frontend_sessions` (POST/DELETE), `metrics/client_event`.
- **Trading:** `POST /users/{u}/orders`, `…/orders/{o}/amend`, `…/decrease`, `DELETE …/orders/{o}`, `…/queue_position`, `positions/{t}`, `event_positions[/{e}]`, `trades`, `order_history`, `trade_history`, `settlement_history`, `post_trade_recommendations`, `netting_enabled`, `first_trade_incentive`.
- **Funds:** `deposits`, `withdrawals`, `withdrawal_times`, `deposit_limits`, `payments/metadata`, `plaid/{accounts,deposit,withdrawal}`, `debit/{cards,payment,payment_session,payment_status_web,withdrawal}`, `braintree/{client_token,payment_methods,deposit,withdrawal}`, `stripe/{payment_intent,withdrawal,ani_deposit,account_link}`, `aeropay/link_token`, `banks/{all_accounts,linked_accounts}`, `crypto/{account,wallets,access_token,withdrawal}`, `mesh/…`.
- **Engagement:** `favorited_series`, `keyword_follows`, `notifications[...]`, `referrals`, `referral_code`, `api_keys`, `tax-documents/{id}/version/{v}`, `zendesk/tickets`, `social/*` (posts, comments, likes, bookmarks, follow, profile, leaderboard, badges, holdings, top_holders, trades, timeline_count).
- **RFQ:** `rfqs/`, `communications/rfqs/`, `communications/quotes/` (GET/POST/PUT/DELETE).

---

## 7. Realtime protocol (WebSocket)

### 7.1 Public API WebSocket (OBSERVED, DOC:asyncapi.yaml)

`wss://external-api-ws.kalshi.com/trade-api/ws/v2`, authenticated with the API-key headers. JSON text frames.

- Client → server: `{"id":N,"cmd":"subscribe","params":{"channels":[…],"market_ticker(s)":…}}`; also `unsubscribe` (`sids`), `list_subscriptions`, `update_subscription` (add/delete markets on a `sid`).
- Server → client: `subscribed {sid, channel}`, `unsubscribed`, `ok`, `error {code,msg}`; data messages `{type, sid, seq, msg}`.
- Channels: `orderbook_delta` (first an `orderbook_snapshot`, then deltas with `price_dollars`, `delta_fp`, `side`; `seq` must be contiguous, and a gap means resubscribe), `ticker`, `trade`, `fill`, `market_positions`, `market_lifecycle_v2`, `multivariate_market_lifecycle`, `communications`, `order_group_updates`, `user_orders`, plus index-price feeds.
- Ping/pong control frames keep the connection alive.

### 7.2 Web-app WebSocket (INFERRED from JS:3473efe5315bf961 and JS:e290871032c0dda8)

- URL: `{WS}/v1/ws?csrfToken=<localStorage csrfToken>&frontend_session=<localStorage fe-session-id>`.
- One shared connection. `subscribe(params, handler)` first looks for an existing subscription with **equal params**. If found, it adds the handler to that subscription's subscriber set; otherwise it sends `{id: nextCommandId++, cmd:"subscribe", params}` and records it as pending.
- **Subscription response timeout: 5 s.** If no response arrives, the client closes the socket, which triggers a reconnect.
- On open: reset `nextCommandId=1`, reset backoff, clear pending unsubscriptions, **resubscribe** all live subscriptions, and emit `connected`.
- On close: clear subscription timers. If not an intentional close, reconnect with **exponential backoff + random jitter** (`delay`, `random_ms`, `next_exp`). Exact constants are UNKNOWN; *design choice*: 500 ms × 2^n capped at 30 s, plus 0–500 ms jitter. Programmatic close uses code **4000**; dispose uses code **1000**.
- Channels used by the web app: `ticker` (all markets: `market_ids:[]`; messages buffered per market id and flushed in throttled batches), `orderbook` (per `market_id` + `market_tickers`; `orderbook_snapshot` resets the book, then `orderbook_delta` applies `msg.yes_dollars`/`no_dollars` entries), `user_balance` (`msg.available`), `user_orders`, `market_lifecycle_v2`, `fill`, `position(s)`, `communications`.
- The orderbook store shows a loading state for up to **2.5 s** after subscribing (`initialSubscriptionLoading`).

---

## 8. Settings & persistence layout

### 8.1 Server-side (authoritative; INFERRED from endpoints)

Per user: profile, properties (key/value), notification settings, trading limits, self-exclusion, deposit limits, session time limit, favorited series, keyword follows, API keys, linked banks/cards/wallets, referral data, netting flag. Per order/fill/position/settlement: see §5.2 shapes and DOC:openapi.yaml schemas.

### 8.2 Client-side storage keys (OBSERVED string literals)

| Key | Store | Purpose (INFERRED) | Evidence |
|---|---|---|---|
| `csrfToken` | localStorage (with expiry wrapper) | CSRF token for the header and the WS query | JS:4fc61d5ac521de17 |
| `fe-session-id` | localStorage | frontend session id sent on WS | JS:4fc61d5ac521de17 |
| `userId`, `userRole`, `email`, `phone`, `loggedOutUserId` | localStorage | identity hints | JS:4fc61d5ac521de17 |
| `registrationUserId`, `registrationEmail` | sessionStorage | sign-up wizard continuity | JS:4fc61d5ac521de17 |
| `Kalshi-Watchlist` | localStorage | watchlist state (logged-out) | JS:3dc71b2f4f2d44c5 |
| `Kalshi-RecentlyVisitedEventTickers` | localStorage | recents list | JS:3dc71b2f4f2d44c5 |
| `Kalshi-OrderBookSettings` | localStorage | order book display prefs | JS:3dc71b2f4f2d44c5 |
| `Kalshi-EventPage{MarketSectionTab,SocialSectionTab,BottomTabIndex}` | localStorage | remembered tabs | JS:3dc71b2f4f2d44c5 |
| `kalshi-theme` (+ theme cookie), `kalshi-color-palette` | localStorage/cookie | light/dark theme | JS:3473efe5315bf961 |
| `kalshi-portfolio-*`, `kalshi-*Sort*` | localStorage | portfolio view prefs | JS |
| `kalshi-search-series-order-by`, `kalshi-ra-filter`, `kalshi-ra-time-filter` | localStorage | browse/activity filters | JS |
| `kalshi_referral`, `kalshi_cid`, `kalshi_attribution_history` | localStorage | attribution | JS |
| `riskified-session-id` | storage | fraud session | JS |

---

## 9. File formats

- **CSV export** of portfolio transactions (`transactionsCSV`). Columns UNKNOWN; *design choice*: `time,type,ticker,side,count,price,fee,total`.
- **Tax documents** fetched by id/version (format UNKNOWN; likely PDF).
- **Images**: `.webp`/`.png` from public S3/CloudFront buckets (series images, structured-target logos) [HAR1#8 `image_url`]. The clone must use its own images.
- **PWA manifest** `/manifest.json` (contents not inspected).

---

## 10. Non-functional behaviors

- Server-side caching windows: 120 s (feeds/search), 300 s (events), 3600 s (history) [JS].
- The client skips duplicate requests while the tab is hidden (§4.3).
- Live count polling stops in the background (§4.1).
- The exchange can be paused (`trading_active:false`); maintenance windows are listed in the schedule [HAR1#0–1, DOC:maintenance_and_pauses]. In maintenance mode the UI shows a banner (`uiStore.banner.maintenance.mode==="on"`) [JS:e290871032c0dda8].

---

## 11. UNKNOWN register (to be resolved by design choice in the clone)

U13 is resolved for Calendar and Browse by §13.4 and §13.2.

U1 logged-in header contents · U2 exact odds/multiplier formulas · U3 fee coefficient · U4 password-login endpoint path · U5 sign-up branch conditions · U6 event page layout · U7 portfolio layout and columns · U8 CSV columns · U9 WS backoff constants · U10 HTTP status for `MARKET_INACTIVE` · U11 empty/error state copy · U12 BFF feed paging params · U13 calendar/browse/category layouts · U14 whether watchlist syncs to server when logged in (endpoints exist for favorited series).
U15 exact hex values behind the current design tokens (`surface-x10`, `text-x10`, `fill-x30…x50`) and the type-scale metrics (CSS not captured) · U16 how `event_limits` groups are expanded in the calendar UI · U17 fractional-contract order entry UX · U18 contents and ranking of the `/ideas/feed` Social feed (loaded client-side, not in HAR3) · U19 name of the push channel for notifications · U20 delivery channel of the 4-digit MFA code (email or SMS).

---

## 12. Clean-room clone mapping (what our implementation covers)

The companion implementation in `clone/` (product name **"Parlance Exchange"**, with its own palette, logo, typeface (Inter, SIL OFL), copy and invented seed content) implements this behavior subset:

| Spec area | Implemented | Notes |
|---|---|---|
| §3 + §13.1 routes `/`, `/browse`, `/live`, `/category/:c[/:sub]`, `/markets/:s/:slug/:e`, `/calendar`, `/social`, `/social/leaderboard`, `/social/profile/:nick`, `/portfolio`, `/watchlist`, `/notifications`, `/account/*`, `/sign-in`, `/sign-up`, `/search` | yes | History-API SPA |
| §13.2 layout system: 1320px container, `minmax(min(360px,100%),1fr)` card grid with 8px gaps, semantic surface/text/fill token scale, light + dark, skeleton shimmer, fade-in, 70vh not-found | yes | own token values (U15) and Inter instead of the proprietary Kalshi Sans |
| §4.1 + §13.3 header: Markets / Live (count polled every 30 s) / Social / Calendar; category strip; subcategory chips | yes | 10 categories; subcategories come from series tags |
| §4.2 home: hero carousel, top markets, trending, top movers, new | yes | |
| §4.3 + §13.5 event page: outcomes, chart with 1H/1D/1W change, order book, ticket, rules, Activity (trades with nicknames), Ideas, Top holders, price alerts | yes | book and ticker are pushed over WS instead of 4 s polling |
| §4.4 lifecycle initialized → active → closed → determined → finalized, `MARKET_INACTIVE` | yes | admin endpoint drives determination |
| §4.5 + §13.2 browse: 24 per page, sort, status, category, grid/list (persisted) | yes | |
| §13.4 calendar: live section, date sections, category counts with live counts | yes | `event_limits` collapsing not implemented (U16) |
| §4.6 portfolio: balance, positions, resting orders (cancel), fills, settlements, CSV | yes | |
| §4.7 + §13.9 auth: sign up, log in, log out, two-factor login | yes | TOTP 6-digit authenticator code instead of a 4-digit message code (U20) |
| §4.8 watchlist (server-persisted, U14 resolved to "yes") | yes | |
| §13.6 social: profiles, posts, replies, likes, bookmarks, follows, feeds, leaderboard, holdings, top holders | yes | |
| §13.7 notifications: inbox, read/read-all, live push, custom price targets | yes | |
| §13.8 account limits: deposit, trading, daily session time | yes | 24 h cooling-off for loosening (design choice) |
| §5 dollar-string/fp encodings, cursor pagination, error envelopes, 429 | yes | |
| §7.2 WS: shared connection, dedup subscriptions, 5 s response timeout, backoff, resubscribe | yes | plus private `notifications` channel |
| §8 settings persisted server-side (theme, chart range, tabs, sort, browse layout, social feed) | yes | per the user's 100%-DB requirement |
| §13.10 Perps (margin products), §13.11 spotlights, fractional contracts, KYC, payment rails, RFQ, AI summaries | **no** | Perps would need a margin, funding and liquidation engine; deposits are simulated |

Verification: 21 Playwright scenarios against a real server, a real SQLite file and Chromium (`clone/tests/e2e.test.js` 13, `clone/tests/features.e2e.test.js` 8). The second file covers the §13 additions: layout, grid/list persistence, subcategories, calendar, the full social loop, live price-alert and fill notifications, limits enforcement and cooling-off, the session lock, two-factor login, persistence across a restart, and no horizontal overflow at 390px in light and dark.

---

## 13. Live site as of 2026-11-02 (HAR3)

### 13.1 Build and routes (OBSERVED)

- Next.js App Router, build id `v3-3LP8JYaUgMIitMhWMD`, RSC `staleTime` 300 s, Vercel prerender (`x-nextjs-prerender: 1`, `x-vercel-cache: HIT`) [HAR3#7, #10, #28].
- Route groups seen in RSC trees: `(explore)/(no-right-sidebar)/browse` rewritten to `/browse/render` [HAR3#7, #28]; `(main)/calendar` rewritten to `/calendar/cached` [HAR3#10]; `(main)/(social)/ideas/feed` [HAR3#8, #27]. The market page is served from `/markets/render/desktop/{series}/{slug}`, as shown by the `next-url` request header [HAR3#7]; public URL `/markets/{series}/{slug}`.
- Page titles: "Browse Markets | Kalshi" [HAR3#28]; "Kalshi Event Calendar: Trade on Future Events" [HAR3#10]; Social is titled "Kalshi Social", described "Back your beliefs", and marked `noindex, nofollow` [HAR3#27].

### 13.2 Visual system and layout (OBSERVED class and font names; values UNKNOWN, U15)

- **Fonts changed since February.** The body now uses an in-house family "Kalshi Sans" (Regular, Medium and Semibold woff2 preloaded, plus an on-demand variable cut). Also present: Kalshi Condensed Medium, Graphik Wide (Semibold, Super), Graphik Compact (Regular, Medium) and OO Theran Light [HAR3#7 `:HL` font preloads; HAR3#27 body font-class map]. These are proprietary; the clone uses Inter.
- Body classes: `font-kalshi-sans overscroll-y-none overflow-x-hidden bg-surface-x10 text-text-x10` [HAR3#27].
- Semantic token scale: `surface-x10`, `text-x10`, `fill-x30/x40/x50` (each with `dark:` variants, so light and dark themes), `rounded-x20`, type classes `typ-title-x10` and `typ-body-x20` [HAR3#10, #28].
- Layout rules: content container `px-3 sm:px-1 mx-auto max-w-[1320px] lg:max-w-none`; page wrapper `flex flex-col pt-3 pb-2 animate-fade-in`; **browse/calendar grid `w-full grid gap-2 grid-cols-[repeat(auto-fill,minmax(min(360px,100%),1fr))] pb-2`**; loading skeleton is a `fill-x40 → fill-x30 → fill-x40` shimmer gradient, 12 cards in grid layout; not-found is centred in a `h-[70vh]` box, max 300px wide, with a contact-support link [HAR3#10, #28].
- Browse is a grid or list view (`initialLayout: "grid"`) [HAR3#28].
- Per-market colors come from data (`background_color_light_mode`/`_dark_mode`, e.g. `#AA00FF`/`#D24DFF`), as do icon URLs [HAR3#28, #75].

### 13.3 Category navigation (OBSERVED)

Dehydrated query `["categoryNavigation"]` [HAR3#28], also embedded in the Social layout [HAR3#27]. Eleven categories, each with subcategories:
- **Climate and Weather**: ski resorts, climate change, daily/hourly temperature, heatwaves, hurricanes and more.
- **Commodities**: metals, oil and gas, and more.
- **Crypto**: 15 min, hourly, per-coin and more.
- **Economics**: Fed, GDP, inflation, jobs and more.
- **Elections**: US, primaries, 2028, Senate, House, Governor, combos and more.
- **Entertainment**, **Financials**, **Mentions**, **Politics**, **Science and Technology**.
- **Sports**: 20 sports.

The calendar facets add "companies". Live event count: `initialLiveCount` 137, then `/v1/live_data/count` → `{"count":139}` [HAR3#232].

### 13.4 Calendar (OBSERVED HAR3#10)

- `initialCardFeedData.pages[]`: `{sections[], hydrated_data, next_cursor, total_count}`; query key signature `["liveCardFeed",{}]`.
- Section: `{group_type:"date", section_key:"YYYY-MM-DD" or "YYYY-MM-DD:live", date, is_live, event_limits[], items[]}`.
- The first section is the live one (`2026-11-02:live`, 193 items).
- `items[]` hold `{type:"event_ticker", event_ticker}` references hydrated from `hydrationData.events/series`.
- `event_limits[]` caps recurring families shown per section: `{event_tickers:[25 fifteen-minute crypto/commodity/FX events], max_count:3}` and `{event_tickers:[24 daily-temperature events], max_count:2}`.
- Filters (`initialFiltersData`): `categoriesByName{name:{count, liveCount}}` (e.g. climate and weather 110/38, crypto 12/12), `categoryOrdering`, sport and esports orderings and facets, `allFacet {count:4088, liveCount:133}`.
- Live scoreboard data (`initialLiveData`) is keyed by milestone id (e.g. `type:"cricket_match"`).

### 13.5 Market page requests and cadence (OBSERVED HAR3#17–#285, `/markets/kxhormuznorm/…`)

| Request | Cadence (median of HAR3 gaps) | Response shape |
|---|---|---|
| `GET /v1/markets/order_books?market_tickers=T` | **4.0 s** poll | `{order_books:[{yes:[[cents,qty]…], no, yes_dollars:[["0.0100",qty]…], no_dollars}], order_books_fp}` |
| `GET /v1/cached/markets_by_ticker/T` | **3.7 s** poll; `cache-control: max-age=60`, `x-kalshi-historical: live` | market incl. `previous_hour/day/week_price(_dollars)`, `volume_fp`, `open_interest_fp`, `fractional_trading_enabled`, `settlement_timer_seconds: 1800`, `can_close_early` |
| `GET /v1/milestones/{id}/volume` | **5.0 s** poll | `{milestone_id, dollar_volume, events:[{event_ticker, dollar_volume}]}` |
| `GET /v1/social/trades?series_ticker=S` | **10.0 s** poll; `max-age=20` | `{trades:[{trade_id, market_id, ticker, price, price_dollars, count, count_fp, taker_side, taker_action, maker_nickname, taker_nickname, create_date}] (100), cursor}` |
| `GET /v1/live_data/count` | **30.2 s** poll | `{count}` |
| `GET /v1/bff/cards?event_tickers=E&include_sports_derivatives=true` | once; `max-age=30` | `{cards:[{type:"contract", series/event fields, milestone_id, markets[29], product_metadata}], hydrated_data:{milestones, keywords}}` |
| `GET /v1/cached/events/?tickers=E` | once; `max-age=60` | `{events:[{…, markets[], header_title, product_metadata, exchange_shard}]}` |
| `GET /v1/cached/events/fee_changes?event_tickers=E&limit=100` | once | `{event_fee_changes:[], cursor:""}` |
| `GET /v1/series/?series_tickers=a,b` | once per related set | `{series:[{…, fee_type:"quadratic", fee_multiplier, settlement_sources, contract_url, product_metadata}]}` |
| `GET /api-app/ai-summary/timeline-points?event_id=…&market_ticker=…` | twice | `{"markets":[]}` (same-origin Next API) |
| `GET /v1/cached/exchange/status` | once | `{exchange_active, trading_active}` |
| `GET kalshi-public-docs…/product-info/manual-banner-details.json?v=<ts>` | once | `{content:"", visibilityTokens:["all"], position:"top"}` (site banner) |

Quantities are now fractional in places (`count_fp: "19.65"`, `volume_fp: "159544.78"`) [HAR3#19, #70], so fractional trading exists (U17).

### 13.6 Social (OBSERVED route and nicknames; endpoints INFERRED from the archived bundle)

- `/ideas/feed` is in the `(social)` route group [HAR3#27]. Its posts load client-side and are not in HAR3 (U18).
- Trades carry `maker_nickname` and `taker_nickname`, empty when the trader does not share [HAR3#19].
- Endpoints from `evidence/api_callsites_home.txt`:
  - Posts: `social/posts/{id}`, `…/comments`, `users/{u}/social/posts` (POST, DELETE), `…/unlike`, `…/bookmark`.
  - Profiles and follows: `users/{u}/social/follow`, `users/{u}/social/profile`, `social/profile{,/metrics,/holdings,/category_metric}`, `users/{u}/social/sharing_preference`, `search/social_profiles`.
  - Other: `social/leaderboard`, `social/top_holders`, `social/trades`, `social/timeline_count`, `social/badges`.

### 13.7 Notifications (INFERRED, callsites lines 15–17, 94–98, 136, 182–183, 204, 224–226)

- `users/{u}/notifications`, plus `…/{id}/read`, `…/read` (all), `…/preferences` and `…/settings/{t}`.
- `…/custom_price_targets` (GET/POST/DELETE), `…/price_movement_subscriptions` and `…/social_account_subscriptions`.

### 13.8 Responsible-trading limits (INFERRED, callsites lines 82, 85, 114, 219, 220)

`users/{u}/daily_session_time_limit` (GET/PUT), `users/{u}/deposit_limits` (GET) and `deposit_limit` (PUT), `users/{u}/trading_limits` (GET). Period, cooling-off and error codes are UNKNOWN. The clone's design choices:
- UTC day.
- Tightening a limit applies at once; loosening waits 24 h.
- Exceeding a limit returns 409 `deposit_limit_exceeded` / `trading_limit_exceeded`, or 403 `session_time_limit_reached`.

### 13.9 Two-factor login (INFERRED, callsites lines 152, 156, 163)

`POST /log_in_mfa?four_digit_code=true`, `/oauth/log_in_mfa_required?four_digit_code=true`, and `users/{u}/action_verification_mfa?four_digit_code=true`. The code is 4 digits; its delivery channel is UNKNOWN (U20).
- Clone design choice: TOTP authenticator (RFC 6238, 6 digits).
- `POST /v1/log_in` returns `{mfa_required, mfa_token}` instead of a session; `POST /v1/log_in_mfa {mfa_token, code}` completes it.
- Challenges allow 5 attempts and expire after 5 minutes.

### 13.10 New product: margin "Perps" (OBSERVED HAR3#239, #28)

- `GET /v1/search/series?derivative_type=margin&order_by=trending` returns perpetual contracts, e.g. `KXBTCPERP`, with:
  - `funding_rate`, `funding_time`;
  - `leverage_estimate` and `leverage_estimates` by notional;
  - `contract_size: 0.0001`, `last_price`, `previous_price`, `asset_class`;
  - chart gradient colors.
- A spotlight card advertises "Perps 7% APY" (`type:"tentpole_spotlight"`, `share_link …/perps?action=interest`).
- **Not implemented in the clone.**

### 13.11 Spotlights (OBSERVED HAR3#28)

Dehydrated query `["spotlights"]` holds explore-page promotion cards:
- Text and links: `title`, `web_title`, `web_overline`, `share_link`, `see_more_button_text`.
- Styling: `primary_color` (named: purple, blue).
- Targeting: `series_ticker_list`, `preferred_categories`, `live_tab`, `hide_on_explore_page_web_logged_out`.

Not implemented; the clone keeps the home hero carousel.

### 13.12 What changed since the 2026-02-22 build

| Area | Feb 2026 (§1–12) | Nov 2026 (§13) |
|---|---|---|
| Body font | Graphik / Inter variable | in-house **Kalshi Sans** (+ Kalshi Condensed, Graphik Wide/Compact) |
| Styling | utility classes | semantic `-x10…-x50` token scale with dark variants |
| Browse | category pages | `/browse` 360px card grid, grid/list layouts, 24 per page |
| Calendar | route name only | live and dated sections, category counts with live counts |
| Social | "SOCIAL" nav item | `/ideas/feed`, trader nicknames on trades |
| Market page data | `/v1/events/{e}` + WS | `/v1/bff/cards`, `/v1/cached/*` endpoints and 4–10 s polling loops |
| Products | binary event contracts | plus margin **Perps** and fractional contracts |

---

## Appendix A. Evidence per view (requests and scripts)

| View | Requests (observed or recovered) | Scripts (chunk → string) |
|---|---|---|
| Global shell | `GET /v1/live_data/count` [HAR2#2]; WS `/v1/ws` | `afefab63e6753a28` → `"/v1/live_data/count"`, `refetchInterval:3e4`; `3473efe5315bf961` → `"/v1/ws"`, `"kalshi-theme"` |
| Home `/` | `GET /v1/bff/home` [HAR2#1]; `GET /v1/bff/feed` [HAR2#0]; forecast history `/v1/cached/series/{s}/markets/{m}/forecast_history` | `b589944cd3448416` → `"/v1/bff/feed"`, `fetchBffPublicFeed`, `forecast_history`; `e290871032c0dda8` → `bffApi.get("/home")`, `bffApi.get("/home/feed"…)` |
| Event `/markets/{s}/{slug}/{e}` | `/v1/events/{e}` (v2 equivalent HAR1#7), `/events/{e}/metadata` [HAR1#8], `/series/{s}` [HAR1#9], `/markets/{t}` [HAR1#10], orderbook [HAR1#11], trades [HAR1#12 → 429], candlesticks [HAR1#13]; WS `orderbook`, `ticker`, `market_lifecycle_v2` | `b589944cd3448416` → `"/v1/events/"`; `e290871032c0dda8` → `channels:["orderbook"]`, `"orderbook_snapshot"`, `exchangeApiV2.get("/markets/trades"`, `submitOrder(`; `3dc71b2f4f2d44c5` → `"Kalshi-EventPage*"`, `"Kalshi-OrderBookSettings"` |
| Browse / Search / Category | `GET /v1/search/series` [HAR2#3], `/search/tags_by_categories` [HAR1#4], `/search/filters_by_sport` [HAR1#5], `/v1/bff/category/{c}` | `b589944cd3448416` → `"/v1/search/series"`; `e290871032c0dda8` → `bffApi.get("/category/"…)`; storage `"kalshi-search-series-order-by"` |
| Portfolio | `/v1/users/{u}/{portfolio/current_value, sampled_portfolio, event_positions, order_history, trade_history, settlement_history, account/realized_pnl}`; WS `user_balance`, `user_orders`; v2 `/portfolio/balance` → 401 [HAR1#17] | `e290871032c0dda8` → `channels:["user_balance"]`, `transactionsCSV(`; storage `"kalshi-portfolio-*"` |
| Sign-in / Sign-up | `POST /v1/log_in_mfa`, `/oauth/{p}/callback`, `/log_out`, `POST /users`, `/resume_sign_up`, `/users/{u}/verify_phone` | `e290871032c0dda8` → `"/log_in_mfa?four_digit_code=true"`, `"/log_out"`; `113d82f2bef48b8f` → `"/sign-up/identity"`; `4fc61d5ac521de17` → `CSRF_HEADER_NAME`/`csrfToken` |
| Watchlist | `/v1/users/{u}/favorited_series` (GET/PUT/DELETE) | `3dc71b2f4f2d44c5` → `"Kalshi-Watchlist"`; `2445a5e65c18ea63` → `"/watchlist"` |
| Live `/live/*` | `/v1/live_data/feed`, `/v1/live_data/batch?milestone_ids=`, `/v1/live_data/{type}/milestone/{id}`, `/milestones` [HAR1#15] | `afefab63e6753a28` → `useMilestoneLiveData` |
| Edge (any route) | `GET /` → 429 checkpoint; `POST /.well-known/vercel/security/request-challenge` → 708 [CHK] | `challenge.v2.min.js` (Vercel, not app code) |
| Market page (live, Nov 2026) | `/v1/markets/order_books` (4 s), `/v1/cached/markets_by_ticker/{t}` (3.7 s), `/v1/milestones/{id}/volume` (5 s), `/v1/social/trades` (10 s), `/v1/bff/cards`, `/v1/cached/events/`, `/v1/cached/events/fee_changes`, `/v1/series/`, `/api-app/ai-summary/timeline-points` [HAR3#17–#285] | RSC prefetch trees (no JS captured in HAR3) |
| Browse (live) | RSC `/browse?_rsc=` with dehydrated `categoryNavigation`, `liveData.count`, `spotlights`; grid search key `["search","series","enhanced",{order_by:"trending",page_size:24,status:["open","unopened"],with_milestones:true}]` [HAR3#7, #28] | client components `SearchResultsView`, `LoggedOutSportsSortProvider` |
| Calendar (live) | RSC `/calendar?_rsc=` with `initialCardFeedData`, `initialFiltersData`, `initialLiveData` [HAR3#10] | client component `LiveDataSeeder` |
| Social (live) | RSC `/ideas/feed?_rsc=` [HAR3#8, #27] | `(social)` route group |
| Perps (live) | `/v1/search/series?derivative_type=margin` [HAR3#239] | — |
