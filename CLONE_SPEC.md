# CLONE_SPEC — Binary event-contract exchange web app (black-box study of kalshi.com)

Status: clean-room specification. Written only from observed behavior: captured network traffic, public documentation, and string-level facts from shipped JavaScript bundles. It contains no copied source code, styles, images, fonts or text assets. Implementers should build from this document only.

> **Revision 5 (2026-11-03):** §20 event live chat. Security research of Kalshi's public surfaces and the phased plan are in `PLAN.md`.
>
> **Revision 4 (2026-11-02):** §16 fractional contracts, §17 combos with RFQ/quotes and the Positions / Resting / RFQs / Quotes / History portfolio tabs, §18 the admin panel and CMS, §19 sports live data and scoreboards.
>
> **Revision 3 (2026-11-02):** §14 specifies the Perps margin product, and §15 the live UI/UX from the user's screenshots and the current build's JS chunks, analysed with REA.
>
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
| `SHOT3:<page>` | User-supplied screenshots of the live site on 2026-11-02 (logged out, dark theme, ~1700px wide): `home`, `home-scroll`, `event-multi` (`/markets/kxnextpressecperm/…`), `event-related`, `event-social`, `live` (`/calendar`), `browse` (`/browse`), `event-h2h` (`/markets/controls/senate-winner/controls-2026`), `event-series`. Described here; not redistributed (they contain third-party branding and photos). | session uploads |
| `JS26:<chunk>:"<string>"` | Literal strings in the **current** build's JS chunks (`/_next/static/immutable/chunks/*.js`, build `v3-3LP8JYaUgMIitMhWMD`), fetched from the static CDN path, which is not behind the bot checkpoint | REA Evidence `ev_46583010dbc420327910cd6a4dfbcc1a0afb77b26bd38f151c3e667359fbd39c` (97-file inventory; the route view of the selected chunk returned no routes, so citations are string-level) |
| `HAR3#n` | **Live site, 2026-11-02**, user-supplied DevTools HAR from a logged-out Chrome 155 session (market page, Browse, Calendar and Social prefetches). *n* is the entry ordinal in the original 286-entry capture. | `evidence/web_live_2026-11-02.har` (98 first-party entries; identifying headers and third-party trackers removed; sha256 `9e28ea83…d008`; each entry keeps `_original_index`; REA Evidence `ev_124ab23da6a5c10eab2448adc93cdab46d09a4d5dee60e0506d223c45acdf04a`, summary view `ev_dec18c6c…1509`, 98/98 records decoded) |

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
| §14 Perps margin product: markets, mark/index, isolated margin up to max leverage, liquidation, funding, price bands, fees, TP/SL, transfers, WS | yes | see §14 for design choices; tests `clone/tests/perps.e2e.test.js` |
| §15 redesign: dark shell, home, browse frequency, event page, BUY/SELL + Dollars ticket, interest, rolling 15-min markets, Pro | yes | tests `clone/tests/redesign.e2e.test.js` |
| §16 fractional contracts (0.01-contract units, conserving cent rounding, per-market flag, migration) | yes | tests `fractional.e2e.test.js` |
| §17 combos (multivariate markets), two-sided RFQ/quotes, portfolio tabs Positions · Resting · RFQs · Quotes · History | yes | tests `combos`, `rfq`, `orders`, `positions`, `history` |
| §18 admin panel and CMS (roles, audit, catalog drafts + CSV import, resolution desk, content, ops, users, moderation, announcements, reports, settings) | yes | tests `admin.e2e.test.js` |
| §19 sports live data: simulated games in six sports, scoreboards, live odds, auto-settlement, `/sports` hub | yes | tests `sports.e2e.test.js` |
| §20 event live chat (rooms, slow mode, moderation, reports, presence, XSS-safe rendering, chat rate limits) | yes | tests `chat.e2e.test.js` |
| KYC/identity, real payment rails, AI summaries, GIFs, ballot lookup, public signed API keys, ice hockey league | **no** | deposits are simulated; see §16.x–19.x "not done" notes |

Verification: 103 Playwright scenarios across 13 files in `clone/tests/` (run `npm run test:e2e`), each against a real server, a real SQLite file and Chromium. The second file covers the §13 additions: layout, grid/list persistence, subcategories, calendar, the full social loop, live price-alert and fill notifications, limits enforcement and cooling-off, the session lock, two-factor login, persistence across a restart, and no horizontal overflow at 390px in light and dark.

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

## 14. Perpetual futures ("Perps")

Parlance's leveraged perpetual-futures product. This section was written from the public margin API docs (cited by file name: a doc file `a_b_c.md` is `https://docs.kalshi.com/a/b/c.md`, fetched 2026-11-02; not redistributed here), one live public listing sample (`/v1/search/series?derivative_type=margin`, cited as **[live]**), and strings in the shipped web bundle (cited by chunk file name). These sources were treated as data. No code, text, images or fonts were copied. Anything the sources do not establish is marked **UNKNOWN**, followed by the design choice the clone makes.

Implementation: `clone/server/perps.js` (engine + REST), `clone/server/ws.js` (channels), `clone/public/js/views/perps.js`, `clone/public/js/perps-api.js`, `clone/public/perps.css`; tests: `clone/tests/perps.e2e.test.js`.

### 14.1 Product model

| Topic | Evidence | Clone behaviour |
| - | - | - |
| Naming | "Perps", "margin" and "perpetual futures" all mean the same product; the API uses the *margin* namespace (`margin.md`). | UI says "Perps"; REST lives under `/v1/perps/*`; doc field names are kept (`account_equity`, `margin_used`, `funding_amount` …). |
| Listing shape | Each perp is a single market with `contract_size`, `last_price`, `previous_price`, `funding_rate`, `funding_time`, `leverage_estimate(s)`, `asset_class`, and `product_metadata` (`asset_name`, `funding_schedule` cron, `decimal_count`, `description`, `index_provider`) **[live]**. | `GET /v1/perps/markets[/:ticker]` returns these fields, plus the `MarginMarket` fields from `margin-rest_market_get-market.md`. |
| Asset classes | `PERPS_ASSET_CLASSES = [Crypto, Equities, Metals, FX, Energy, Indices, Rates, Compute, GPU, EventContracts]` (chunk `0b-vmmhwqitt_.js`); the docs enum is `Crypto, Equities, Metals, Indices, Energy` (`api-reference_get-funding-schedule.md`). | Seven invented markets: `PLXBTCPERP`, `PLXETHPERP`, `PLXSOLPERP` (Crypto), `PLXGOLDPERP` (Metals), `PLXOILPERP` (Energy), `PLXUS10YPERP` (Rates), `PLXGPUHRPERP` (Compute). Chips appear in the bundle's order, and only for classes that have markets. |
| Routes | Landing `/perps` with `/perps/{ticker}` (chunk `23fib2gc7zn_d.js`, `landing:"/perps"`); category route `/perps/categories/{assetClass}` lower-cased (chunk `23fib2gc7zn_d.js`); portfolio `portfolioProductRoutes.perpetuals = "/portfolio/perps"` with `perpsTab ∈ positions\|orders\|history`, default `positions` (chunk `0b-vmmhwqitt_.js`). | All of these routes exist. `/portfolio?perpsTab=…` also renders the Perps portfolio, and the Predictions portfolio links to it. |
| Contract size and price | BTC `contract_size 0.0001`, `last_price 7.7923` **[live]**: per-contract price = underlying level × contract size. The bundle computes contracts = dollars × leverage ÷ (conversionPrice × contractSize) (chunk `36qdzse90bk1i.js`). Tick is $0.0001 (`margin_price-banding.md`). | Orders, fills and books are priced **per contract** in 4-dp dollars. Internally prices are integer centicents (1 cc = $0.0001 = one tick). The UI shows the underlying level (contract price ÷ contract size), for example BTC at $100,000.00. |
| Quantities | Fixed-point counts with fractional contracts down to 0.01 (`FixedPointCount` in `margin-rest_risk_get-risk.md`). | **Design choice:** whole contracts only, emitted as `"99.00"` `fp` strings. |
| Display terms | `PERPS_DISPLAY_TERMS = {marginRequirement:"Cost", positionEquity:"Position value", notionalExposure:"Total size"}` (chunks `36qdzse90bk1i.js`, `3x09fsrfwgctp.js`). Leverage is shown as `"10x"` (`formatLeverage`) and the funding rate as a percent with 4 dp (`formatFundingRate`), both in chunk `0b-vmmhwqitt_.js`. | Ticket rows: Contracts, Total size, Cost (margin), Est. fees, Est. liq. price. The positions table has a Position value column. |

### 14.2 Prices: last, index (reference) and mark

- `price` is the last trade. `reference_price` is the underlying index scaled per contract. `settlement_mark_price` is used for settlement and funding, and `liquidation_mark_price` for liquidation (`margin-rest_market_get-market.md`, `margin-ws_websockets_market-ticker.md`). The docs name third-party index sources, which Parlance does not use.
- **UNKNOWN**: the formula for the mark price. **Design:** both marks equal the reference price (index × contract size, rounded to the tick).
- **Design:** the index is a deterministic simulation. It is a geometric random walk with mean reversion toward an anchor, uses a per-market daily volatility, and draws from a seeded PRNG whose state is persisted in `perp_markets`. It advances on the engine tick and is persisted every tick. Mark prices go into `perp_price_history` as 1-minute OHLC bars. Seeding adds 7 days of 15-minute bars, 2 hours of 1-minute bars, a 24-hour public trade tape, and past funding rates.
- Admin and test hook: `POST /v1/perps/admin/markets/:ticker/index {price, freeze}` (also `engine.perps.setIndex`) pins the index. Pinning resets the funding premium window.

### 14.3 Margin, leverage, liquidation

- Initial margin = maintenance margin × `initial_margin_multiplier` (`margin-rest_risk_get-risk-parameters.md`). Liquidation happens at a margin ratio threshold (`liquidation_margin_ratio_threshold`), and there is also a queue-entry threshold.
- Docs leverage is 1 ÷ margin rate and falls as notional grows (`leverage_estimates` keyed 1k…1M in `margin-rest_market_get-market.md`). Live values are about 2x–15x **[live]**.
- **UNKNOWN**: the real maintenance-margin model. The docs describe scenario matrices (hvar/apc/aug/funding), market-impact liquidation configs, and subgroups that share margin (`api-reference_get-maintenance-margin-metadata.md`). **Design:** a flat rate per market. Initial margin rate = 1 ÷ `max_leverage`, and maintenance rate = initial rate ÷ 2 (multiplier 2), so BTC at 20x max gives 5% initial and 2.5% maintenance. `leverage_estimates` are reported, but leverage limits do not scale with size.
- Docs have both cross and isolated margin: `SubaccountType` is `cross | isolated | auto_rebalance`, and the exit-trigger endpoints exist in both cross and isolated variants (`margin-rest_portfolio_get-balance.md`, `margin-rest_exit-triggers_*`). **Design: isolated margin per (user, market)**, reported as `subaccount 0`, `subaccount_type "isolated"`, `is_portfolio false`. The user picks leverage from 1x up to the market max. Cost = notional ÷ leverage is moved from Perps available collateral into the position's margin.
- Position equity = margin + unrealized PnL, with unrealized PnL = qty × (mark − entry), signed. Maintenance requirement = |qty| × mark × maintenance rate.
- Liquidation price, with long and short both written in terms of |q|:
  - long: (|q|·E − M) ÷ (|q|·(1 − r))
  - short: (M + |q|·E) ÷ (|q|·(1 + r))
- **Liquidation (design):** each tick, any position whose equity is below maintenance margin is closed in full at the liquidation mark. The liquidity account takes over the position.
  - Remaining equity minus a liquidation fee goes back to available. The fee is the smaller of the remaining equity and ½ × maintenance margin.
  - A shortfall is recorded against an insurance tally in `perp_meta`. Losses never draw on other collateral, because margin is isolated.
  - Each liquidation writes a `perp_liquidations` row, a `perp_fills` row (`source=liquidation`), a liquidation trade print, ledger rows, and a `perp_liquidation` notification.
- Reporting: `GET /v1/perps/risk` follows `margin-rest_risk_get-risk.md` literally, where `position_leverage` = notional ÷ maintenance margin. It also returns `effective_leverage` and `margin_ratio`. `GET /v1/perps/balance` follows `margin-rest_portfolio_get-balance.md` (`subaccount_balances[]` with position_value, account_equity, maintenance_margin, initial_margin, resting_orders_margin, available_balance, plus `settled_funds`) and adds `predictions_cash_dollars`.

### 14.4 Funding

- The schedule is a cron per asset class, evaluated in US Eastern Time (`api-reference_get-funding-schedule.md`). Live schedules: Crypto `0 */8 * * *`, Metals `0 10 * * *`, Energy `30 14 * * *`, Indices `0 16 * * *` **[live]**.
- The estimate is a time-weighted average of the premium index over `[last_funding_time, now)`, finalized at `next_funding_time` (`margin-rest_funding_get-funding-rate-estimate.md`). The premium is the signed fraction of book vs index (`margin-rest_funding_get-premium-index.md`). Markets carry `funding_cap`, `funding_deadband`, `funding_limit_unit`, and `funding_invalid_premium_handling` (`dampen|exclude`).
- Payment rows carry `funding_rate`, `mark_price`, `quantity` and `funding_amount`, which is positive when received and negative when paid (`margin-rest_funding_get-funding-history.md`). The bundle has a `margin_funding_payment` notification type (chunk `0b-vmmhwqitt_.js`).
- **UNKNOWN**: the payment formula and the interest component. **Design:**
  - The premium (book mid − mark) ÷ mark is sampled each tick.
  - rate = clamp(average premium + 0.01% interest, ±0.75%) per period.
  - payment = round(−qty × mark × rate), so with a positive rate longs pay and shorts receive. Funding is zero-sum, and the liquidity account takes part.
  - Payments are applied to the isolated position margin and written to `perp_funding_payments`. Rates go to `perp_funding_rates`.
  - Intervals are 8h (Crypto, Compute) or 24h, aligned to UTC rather than ET (a simplification). `start({ perps: { fundingIntervalMs } })` or `PERPS_FUNDING_INTERVAL_MS` shortens every interval, for tests.
  - Missed periods during downtime are paid once on restart.
  - Notifications are sent at most once per user per hour.

### 14.5 Orders

- Request fields follow `margin-rest_orders_create-order.md`:
  - `side` is `bid|ask`; the clone also accepts `long|short|buy|sell`.
  - `count`, `price` (fixed-point dollars), `time_in_force ∈ fill_or_kill|good_till_canceled|immediate_or_cancel`, `post_only`, `reduce_only`, and `client_order_id`.
  - Reduce-only caps the count at the position size and is rejected unless the order is IOC or FOK.
  - The response carries `order_id`, `fill_count`, `remaining_count`, `average_fill_price` and `average_fee_paid`.
- Self-trade prevention per docs is `taker_at_cross|maker`. **Design:** always `taker_at_cross`, which stops matching at the user's own resting order.
- **UNKNOWN**: market orders. The docs only have limit orders plus TIF. **Design:** `type: "market"` is an IOC limit at mark ± 5%.
- Matching is price-time priority. Makers get their resting price. Each fill writes `perp_trades` and two `perp_fills` rows (with `entry_price` and `realized_pnl` as in `margin-rest_portfolio_get-fills.md`). Fills against an open opposite position close it first, then open the rest (flip).
- A resting limit order holds margin for every contract: ⌈price ÷ leverage⌉ plus the taker-fee cap. That holding is released pro rata on fill or on cancel. Taker orders are dry-run against the book first, and rejected with `409 insufficient_margin` if margin and fees exceed available collateral.
- Not built: amend, decrease, order groups, subaccounts, batch endpoints (`margin.md` says batch is not available on margin anyway), `market_version`, `expiration_time`.

### 14.6 Price banding

Docs (`margin_price-banding.md`):
- Ticks are $0.0001.
- A bid must be at least the lower of 80% of the best bid or 1,000 ticks below it.
- An ask must be at most the higher of 120% of the best ask or 1,000 ticks above it.
- A side with no resting orders has no band. Resting orders are not canceled when the band moves.

The clone enforces exactly that rule. **Design addition:** every user order must also fall within [min(80% of mark, mark − 1,000 ticks), max(120% of mark, mark + 1,000 ticks)]. A violation returns `400 price_outside_band`, with the allowed range shown as underlying levels in `details`. The bundle has a `price_band_cancel` notification (chunk `0b-vmmhwqitt_.js`). **UNKNOWN** when that fires; the clone never cancels resting orders because of the band.

### 14.7 Fees

Fees are maker and taker rates expressed as a decimal fraction of notional; the docs' examples are 0.0005 maker and 0.0012 taker (`margin-rest_fees_get-fee-tiers.md`, `margin-rest_fees_get-fee-tier-rates.md`). Live `fee_multiplier` is 0 **[live]**. **UNKNOWN**: actual retail rates. **Design:** maker 0.02% and taker 0.06% for every market, fee = ⌈count × price × rate⌉ in centicents. The liquidity account pays nothing. `GET /v1/perps/fee_tiers` returns the maps.

### 14.8 Exit triggers (take profit / stop loss)

- Docs: a bracket (`stop_loss_price` and/or `take_profit_price`) or a trailing stop, set on a position. It fires reduce-only orders that close the position and is evaluated against the mark every tick.
- Statuses are `pending_on_entry|active|filled|failed|canceled`. Reasons are `user_canceled|position_closed|order_rejected|position_flipped|…`. `triggered_leg` is `stop_loss|take_profit`. Sources: `margin-rest_exit-triggers_set-isolated-exit-trigger.md` and related files.
- Clone: `PUT|DELETE /v1/perps/positions/:ticker/exit_trigger`, `GET /v1/perps/exit_triggers`. Brackets only; trailing stops and order-anchored triggers are not built.
- **Design:** take profit and stop loss must sit on the profitable or protective side of the current mark.
- When a leg fires, the clone sends a reduce-only market order (`source=exit_trigger`), sets the trigger to `filled` with its `triggered_leg`, and sends a `perp_exit_trigger` notification. Closing or flipping the position cancels the trigger with the matching reason.

### 14.9 Transfers between Predictions cash and Perps collateral

- Docs: `POST /portfolio/intra_exchange_instance_transfer` with `source` and `destination` in `event_contract|margined`, an `amount` in **centicents**, and an optional `client_transfer_id` (a duplicate returns 409). The docs say it is processed asynchronously and is "not yet available" in production (`margin-rest_portfolio_intra-account-transfer.md`, `margin.md`). The bundle tracks perps cash apart from predictions cash (`account_equity` checks in chunk `3gq1uugohtlk0.js`) and has a `margin_transfer_completed` notification (chunk `0b-vmmhwqitt_.js`).
- Clone: `POST /v1/perps/transfers` accepts either `{direction: to_perps|to_predictions, amount_dollars}` or the docs shape. Transfers are whole cents and complete synchronously.
- Prediction cash moves through `engine.credit(uid, ±cents, 'perps_transfer', …)`, so the existing ledger and `user_balance` WS events stay consistent.
- Each transfer writes `perp_transfers` and `perp_ledger` rows and sends a notification. `GET /v1/perps/enabled` mirrors `/margin/enabled` (`margin-rest_exchange_get-enabled-status.md`); it is true for any signed-in user.

### 14.10 Liquidity

**Design:** the existing system liquidity account quotes 8 levels on each side around mark × (1 + simulated basis):
- half-spread is 1.5 bp
- levels are 2 bp apart
- each level is about $1.5k of notional, growing with depth

It re-quotes when the mark moves or its orders fill, at most once a second unless forced. Unfilled quotes are deleted on re-quote so the table stays small. The account has unlimited collateral, is excluded from liquidation, and takes part in funding.

### 14.11 WebSocket

- Docs: a separate path `/trade-api/ws/v2/margin` (`marginWsUrl` in chunk `1zneyt5_c85al.js`, `margin.md`). It carries the same channels as event contracts (`orderbook_delta`, `ticker`, `trade`, `fill`, `user_orders`, `order_group_updates`, `market_lifecycle_v2`). Timestamps are `*_ms` epoch milliseconds. Tickers are coalesced to at most 1 per second per market and carry `reference_price`, `settlement_mark_price`, `liquidation_mark_price` and `funding_rate{rate,next_funding_time_ms}` (`margin-ws_websockets_market-ticker.md`).
- **Design:** the clone multiplexes Perps on the existing `/v1/ws` connection, with prefixed channels:
  - public: `perp_ticker` (docs payload, at most 1/s per market, forced on trades and pins), `perp_orderbook` (a full `perp_orderbook_snapshot` on subscribe and on every change, instead of deltas), `perp_trade`
  - private: `perp_orders`, `perp_positions`, `perp_account`
- The UI recomputes unrealized PnL, ROI and position value locally from each `perp_ticker` mark.

### 14.12 Persistence

The engine owns these SQLite tables, created with `CREATE TABLE IF NOT EXISTS`: `perp_markets` (config and simulation state), `perp_price_history`, `perp_accounts`, `perp_orders`, `perp_trades`, `perp_fills`, `perp_positions`, `perp_funding_rates`, `perp_funding_payments`, `perp_liquidations`, `perp_exit_triggers`, `perp_transfers`, `perp_ledger`, and `perp_meta`. The only in-memory state is throttle timestamps, such as the last ticker emit and the last re-quote. Seeding is idempotent per ticker. `perps.e2e.test.js` restarts the server twice and checks that positions, collateral, the pinned simulation, history, triggers, liquidations, funding and transfers all survive.

---

## 15. UI/UX of the live site (SHOT3) and the redesign

### 15.1 Shell (OBSERVED SHOT3:all)

- **Theme:** dark by default. The page is near-black, cards are one step lighter with a 1px border and ~16px radius, and the text is white/grey.
- **Typography:** page titles, market titles and section titles use a condensed bold display face. Body text uses a neutral sans. The current fonts are Kalshi Sans and Kalshi Condensed (§13.2). The clone uses Inter plus Barlow Condensed (both OFL).
- **Header, left to right:**
  - Green wordmark.
  - Uppercase, letter-spaced nav: **MARKETS · INVEST · LIVE n · PRO · MORE ▾**. The live count is red and changes 140 → 151 across the screenshots, consistent with the 30 s poll (§13.5). The current section is highlighted (MARKETS is green on `/browse`, LIVE on `/calendar`).
  - A wide pill search, "Trade on anything".
  - An outlined "Log in" pill and a filled "Sign up" pill.
- **Category strip:** Trending, **Midterms** (a featured hub in a highlight colour), Elections, Politics, Sports, Culture, Crypto, Commodities, Climate, Economics, Mentions, Finance, Tech & Science. These are short labels for the data categories in §13.3.
- **Clone:** same structure.
  - The wordmark "Parlance" uses its own violet; the featured hub "Harbor 2026" is coral.
  - INVEST → `/perps` (§14); PRO → `/pro` (§15.7); MORE → Calendar, Social, Leaderboard, Watchlist, Responsible trading, and a light/dark toggle.

### 15.2 Home (OBSERVED SHOT3:home, home-scroll)

1. **Hero carousel** ("1 of 7", circular prev/next):
   - Category overline with icon, then a large condensed question.
   - Table **Market · Pays out · Odds**: outcome avatar, outcome name underlined in the outcome colour, payout multiplier (`1.33x`), and odds as an outlined pill (`73%`).
   - `$144,681,295 vol` with a "Trade" link, then **News** with a one-paragraph summary.
   - Right side: legend with the current % per outcome, a brand watermark, and a multi-line chart with a dotted grid, right-hand % axis and date axis.
2. **Three info cards:** "Market integrity", "Markets over Monopolies", "Responsible trading", each with an icon and subtitle. The clone uses its own copy.
3. **Upcoming:** a horizontal carousel with ‹ › buttons. Each card has an icon, a ☆ watch star, an uppercase time or date ("10:05 PM", "NOV 3"), a bold title and a tag pill ("KPIs", "US Elections").
4. **Category sections** ("Politics ›"): two-column market cards. A card has an icon, title, date ("Jan 1 @ 1:00AM"), two outcome rows (avatar, underlined name, multiplier, odds pill) and dollar volume.
5. **Right rail:**
   - Perps promo ("PERPS · Earn up to 7% APY for a limited time").
   - Hub cards with dollar volume ("Midterms Hub $1,318,352,167 volume", "Public Companies Hub · Trade on upcoming KPIs").
   - Lists **Trending**, **2026 Primaries** and **Top movers**: title, leading outcome, % and a coloured ▲/▼ change.

### 15.3 Browse (OBSERVED SHOT3:browse)

- Title "Browse Markets". On the right are pill dropdowns **Trending ▾ · Frequency ▾ · All categories ▾ · …**.
- Three-column cards. Each row has an outcome avatar, the name with a coloured underline, the multiplier and an outlined odds pill. The card's subtitle is the date ("Nov 3") or a red **LIVE** marker plus competition.
- Live sports cards add score columns, and their border is tinted red.
- **Clone:**
  - Frequency filter (`fifteen_min | daily | weekly | monthly | one_off`, from series `frequency`; `GET /v1/search/series?frequency=`).
  - The underline width is proportional to the chance (design choice; the screenshots show varying widths).
  - The odds pill opens the market with that outcome selected.

### 15.4 Event page (OBSERVED SHOT3:event-*)

- **Header:**
  - Large square image; breadcrumb in uppercase ("US ELECTIONS / 2026 MIDTERM PREDICTIONS"); condensed title; settlement one-liner.
  - Action icons: add-to-calendar (with a badge), comments, share, download, and "Live chat" for live events.
- **Two-outcome events:** a head-to-head row (avatar, name, a split bar in the two colours, name, avatar) with the date under the bar [SHOT3:event-h2h].
- **Chart:**
  - Legend, then lines with the outcome name and a big % at each line's end; a scrubber.
  - `$… vol`, with **1D 1W 1M ALL** on the right.
- **Outcome table:** header "Chance", a sort icon and a search icon. Each row has a photo, name, big condensed %, a ▲/▼ day change, and outlined **Yes 74¢** (green) and **No 27¢** (red) buttons.
- **Related events:** tabs of related event groups ("Events · Balance of Power · Election Specials · Seat Counts") with search and "Show more" [SHOT3:event-series].
- **Below the table:**
  - "People are also trading": icon and title rows, then "Show more".
  - "Breaking News": source, date, headline and summary.
  - **Social | Activity** tabs. The composer says "What's on your mind?" and has GIF and "+ Add a position" buttons. A post shows the nickname, age and a position tag ("Yes · Ben Ferguson · Before Jan …"), its body with "Read more", and actions (like, reply, bookmark, share, ⋯) [SHOT3:event-social].
- **Ticket:**
  - **BUY | SELL** tabs and a **DOLLARS ▾** unit menu.
  - The question, then the selected outcome (avatar and condensed name).
  - A **YES 21¢ | NO 81¢** segmented toggle, with the selected side filled.
  - A "**3.5% Interest**" link. It is backed by `interest_rate_amount` and `margin_interest_rate_amount` settings and an `openHelpCenterInterestApy` handler [JS26:0b-vmmhwqitt_:"openHelpCenterInterestApy", JS26:0bszqignr8pgk:"interest_rate_amount"].
  - A "Dollars $0" input; "Odds 82% chance"; "Max payout" with the expiry date and a large amount ["Max payout" in JS26:0-un45q67vg9u, 16-dlj79axbgf].
  - A full-width "Sign up to trade" button when logged out. A COMBO (parlay) button sits above the ticket.
- **Clone:**
  - All of the above except GIFs, live chat, photos and COMBO. Avatars are generated monograms, and news comes from the event's own update.
  - Add-to-calendar downloads an **iCalendar** file (RFC 5545 `VEVENT` at close time); download gives a **CSV** of chart history (`time,market,outcome,yes_price_dollars,volume_contracts`).
  - The ticket offers modes **Dollars** (`type:"dollars"`, `amount_dollars`), **Contracts** (market IOC) and **Limit order**. The chosen mode is persisted (`ticket_mode`).
  - **SELL** sends `action:"sell"`. The server turns "sell YES at p" into "buy NO at 100−p", which nets against the held YES for $1 per pair. It refuses to sell more than you hold (409 `insufficient_position`).
  - Interest: 3.5% APY on cash plus open-position cost, credited once per UTC day starting the day after sign-up (design choice; ledger kind `interest`, `GET /v1/users/{u}/interest`).

### 15.5 Live / Calendar (OBSERVED SHOT3:live — the LIVE nav item lands on `/calendar`)

- **Left rail:**
  - FEATURED with sport icons (NFL, NCAA Football, NBA…), then "What's next".
  - Collapsible categories with counts ("Tennis (257)", "Basketball (554)").
- **Centre:** red condensed "**LIVE · 198**", then rolling **15-minute** cards:
  - Asset icon and "BTC 15 MIN".
  - "Target $77,769.29" and "↑ $155.07 Above".
  - A sparkline against the dotted target line.
  - "Above · 99%" and "Below · 1%" pills, plus volume.
- **Right rail:** a COMBO button and a "**Determined** · Outcome: Up · Explore Crypto" card. The chunks' "15 min" crypto subcategory and `KX…15M` events match this [HAR3#10 `event_limits`].
- **Clone (`server/rolling.js`):**
  - An invented "PLX token" index with a persisted random walk.
  - A new window event every `ROLLING_WINDOW_SEC` (default 900 s). Its target is the index at window open, and its market is "Above".
  - Liquidity quotes both sides at 47¢.
  - At close the window is determined (`yes` if close > target) and then settled by the normal lifecycle.
  - Endpoints: `GET /v1/rolling/current` (window, target, distance, price path) and `GET /v1/rolling/determined`. The Live page shows the card and the latest Determined window; `/live` shows only the live section, while `/calendar` adds the dated sections.

### 15.6 Pro (UNKNOWN content; the nav item is OBSERVED)

The PRO destination was not captured. Design choice: `/pro` is a dense, sortable table of every open market (bid, ask, last, 24h change, volume), updated live over the `ticker` channel, with one-click links to the pre-selected ticket.

### 15.7 Clone verification for §15

`clone/tests/redesign.e2e.test.js` has 7 browser scenarios:
- Shell, MORE menu, dark default; home sections; the Upcoming star persisting to the watchlist.
- Frequency filter; Pro sort and its links into the ticket.
- Head-to-head; `.ics` and CSV downloads and their formats; related events.
- Dollars buy, SELL netting and the oversell refusal.
- One interest accrual per day.
- A rolling window from trade to settlement payout, and the Determined card.
- No horizontal overflow at 390px, plus a restart.

---

## 16. Fractional contracts

These sections extend CLONE_SPEC.md and use its conventions: **OBSERVED** (seen in evidence), **INFERRED** (follows from evidence), **UNKNOWN** (not established; the clone makes a *design choice*).

Evidence for §16–17 is cited by file name. Treat it as data only.

- **Public docs** (`a_b_c.md` = `https://docs.kalshi.com/a/b/c.md`):
  - `getting_started_fixed_point_migration.md`, `getting_started_rfqs.md`
  - `api-reference_multivariate_create-market-in-multivariate-event-collection.md`, `api-reference_multivariate_get-multivariate-event-collection.md`, `api-reference_events_get-multivariate-events.md`
  - `websockets_multivariate-market-and-event-lifecycle.md`
  - `api-reference_communications_create-rfq.md`, `…_create-quote.md`, `…_accept-rfq-quote.md`, `…_confirm-rfq-quote.md`
  - Order management, fetched from the `llms.txt` index on 2026-11-02: `api-reference_orders_amend-order-v2.md`, `…_decrease-order-v2.md`, `…_cancel-order-v2.md`, `…_cancel-all-orders.md`, `…_batch-cancel-orders-v2.md`, `…_get-order-queue-position.md`, `…_get-queue-positions-for-orders.md`, `…_create-order-v2.md`
- **Current-build JS chunks** (grep only): cited as `chunk:<file>` plus the string.

The clone is Parlance: own names, copy and styling. No Kalshi code, text, images or fonts are used.


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

---

## 18. Admin panel and CMS

Parlance's staff console lives at `/admin` (single-page route inside the existing SPA) and is backed by `clone/server/admin.js`. Every admin table is created there with `CREATE TABLE IF NOT EXISTS`; no existing table's schema changes. Everything is persisted in the same SQLite file and survives a restart.

### 18.1 Evidence vs. design choice

Almost none of a real exchange's back office is observable from outside. The table below separates what the captures show from what Parlance designed.

| Area | Status | Evidence / rationale |
|---|---|---|
| Social moderation API | **OBSERVED call sites** (shape INFERRED) | `evidence/api_callsites_home.txt` lines 27-28: `DELETE users/{uid}/social/social-admin/posts/{post}` and `…/posts/{post}/comments/{comment}`. Line 144: `GET users/{uid}/social/social-admin/profiles?…`. Lines 236-239: `PUT …/social-admin/determine_profile_image/{id}`, `…/posts/{id}/market_status`, `…/post_subtype` and `…/update`. Parlance implements the first three paths (same URL shape, gated by the `social.moderate` permission). The four `PUT` ones are not implemented, because their bodies are UNKNOWN. |
| Site banner | **OBSERVED** | §13.5: `manual-banner-details.json` returns `{content:"", visibilityTokens:["all"], position:"top"}`. Parlance banners keep `content`, `visibility` (exposed as `visibilityTokens: [visibility]`) and `position` (`top`/`bottom`), and add an optional link and an active window. |
| Spotlights / promo cards | **OBSERVED fields** | §13.11 dehydrated `["spotlights"]`: `title`, `web_title`, `web_overline`, `share_link`, `primary_color`, targeting (`series_ticker_list`, `preferred_categories`, `hide_on_explore_page_web_logged_out`). Parlance promo cards use overline, title, subtitle, link, colour and active dates. Targeting is a design choice that was not built. |
| Category navigation | **OBSERVED data** | §13.3 dehydrated `["categoryNavigation"]` and the `categoryOrdering` facet (§13.4) show that order and labels are data-driven. Parlance makes order, display labels, hidden flags and the featured tab (label, link, colour) editable. |
| Market lifecycle controls | **DOC + OBSERVED** | §4.4 lifecycle (deactivate/activate/close/determine/finalize) and `settlement_timer_seconds` (§13.5). The resolution desk drives the existing `engine.close/determine/finalize`. |
| Roles, audit log, permission matrix, catalog drafts, CSV import, reports, announcements, user support actions, settings | **UNKNOWN → design choice** | Not observable. These are all Parlance's own design. |

### 18.2 Roles and permissions

Roles are stored in `admin_roles(user_id, role)`. A user with `users.is_admin = 1` always has `admin`, and granting or removing `admin` keeps `is_admin` in sync, so the earlier `requireAdmin` routes still work. Every `/v1/admin/*` route checks a permission on the server (`can(perm)`). The last admin cannot be demoted, and admins cannot demote themselves.

| Permission | admin | editor | resolver | risk | support | moderator |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| catalog.read (catalog, resolution queue view) | ✓ | ✓ | ✓ | ✓ | | |
| catalog.write (create / edit / publish / import) | ✓ | ✓ | | | | |
| content.write (hero, hubs, promos, banners, nav, info cards, news, help) | ✓ | ✓ | | | | |
| resolution.write (resolve, reverse, settle now, early close) | ✓ | | ✓ | | | |
| markets.ops (exchange switch, pause/resume, fees, liquidity bot, combo flag) | ✓ | | | ✓ | | |
| perps.ops (halt/resume, max leverage, run funding) | ✓ | | | ✓ | | |
| reports.read | ✓ | | | ✓ | | |
| users.read (search, detail) | ✓ | | | | ✓ | |
| users.support (lock/unlock, reset 2FA, clear session time) | ✓ | | | | ✓ | |
| users.money (balance adjustment, limit override) | ✓ | | | | | |
| announce | ✓ | | | | ✓ | |
| social.moderate (reports, hide/delete, bans, verified badge, social-admin paths) | ✓ | | | | | ✓ |
| settings.write (settings, health) | ✓ | | | | | |
| roles.write | ✓ | | | | | |
| audit.read | ✓ | | | | | |

Users with no role who open `/admin` get a friendly page (`data-testid=admin-forbidden`), and the API returns 403. Signed-out visitors get 401 from the API and a sign-in prompt in the UI. A role that lacks a section's permission sees `section-forbidden` inside the shell.

**Audit.** Every admin mutation writes one row to `admin_audit(id, ts, actor_id, actor_email, action, target_type, target_id, before_json, after_json, reason)`. The audit viewer filters by actor, action prefix, target and date range.

### 18.3 Catalog CMS: draft → published

- **Draft storage.** Drafts live in their own tables: `cms_draft_series`, `cms_draft_events` and `cms_draft_markets`. Public queries only ever read `series`, `events` and `markets`, so drafts can never reach a public API, search, the calendar, combos or the home page. No public query had to change.
- **Publishing.** Publish copies the draft rows into the live tables and deletes the drafts, all in one transaction. Publishing an event also publishes its draft series and all of its draft markets. Publishing a market also publishes its draft parents. An event cannot be published until it has at least one market.
- **Market status on publish.** A market becomes `active` if its open time has passed, otherwise `initialized`, and the engine tick activates it later.
- **Editing live items.** Published items are edited in place, with these limits:
  - A market's open time can only move while it is `initialized`.
  - A market's close and expiration times are locked once it is closed.
  - The icon colour of a published event is stored in `cms_event_meta`.
- **Validation.** Tickers are unique per kind and use `[A-Z0-9._-]`, 2-64 characters. A single-market event may share its market's ticker, as the seed does.
  - Categories must be one of the site categories.
  - Colours use `#rrggbb`.
  - Times: open < close ≤ expected expiration.
  - Settlement timer: 0-604800 s. Starting price: 1-99¢.
  - Fee multiplier: 0-10.
  - Settlement source URLs must be `https://`.
  - Field errors come back as `{error:{code:"validation_failed", fields:{…}}}` and are shown inline next to each field.
- **Preview.** `/admin/preview/{EVENT}` renders the draft with the public `eventCard` component plus a table of its markets.
- **CSV import.**
  - Columns: `event_ticker, market_ticker, yes_sub_title, no_sub_title, title, color, open_time, close_time, expected_expiration_time, settlement_timer_seconds, rules_primary, initial_price, seed_liquidity`.
  - The required columns are the first three plus `close_time`.
  - The template is a download.
  - Valid rows become draft markets. Invalid rows are reported as `{row, market_ticker, errors[]}`, and the report downloads as a CSV.
- **Starting liquidity.** This is configurable in Settings: `publish_liquidity {enabled, spread_cents, size_contracts, levels}`. When a market with `seed_liquidity` is published, an `ops_liquidity` row is written and the existing liquidity user (`liquidity@parlance.local`) quotes both sides around `initial_price` with post-only orders. Markets that publish before their open time are quoted when the engine emits `activated`.

### 18.4 Resolution desk

- **Queue.** The desk lists closed markets, active or inactive markets past their close time, determined markets, and markets finalized in the last 7 days. Combo and rolling (PLXFLASH) markets are excluded because they resolve automatically.
- **Resolve.** Requires YES/NO, a source note (5-1000 characters, stored in `res_resolutions`) and an optional settlement delay. The delay is written to `markets.settlement_timer_seconds`. The desk then calls `engine.determine()`; the existing tick runs `engine.finalize()` (payouts, `settlements`, `settlement` ledger rows, notifications) when the timer expires. A delay of 0 settles immediately.
- **Reversal (before settlement only).** A `determined` market goes back to `closed` with `result=''` and `determined_at=NULL`, and the resolution row is marked `reversed` with a reversal note. No money has moved at that point, so this is ledger-correct by construction.
  - Reversal is refused if a combo has already resolved from this leg.
  - **Reversal after settlement is not supported.** Clawing back paid-out cash safely needs negative-balance handling and user-facing disputes. The desk returns `409 already_settled`. The settlement delay is the review window that allows a reversal.
- **Settle now** finalizes a determined market immediately.
- **Close early** requires a reason and the market's `can_close_early` flag, and calls `engine.close()`.

### 18.5 Content CMS and how the public site reads it

| Content | Table | Public effect | Default when empty |
|---|---|---|---|
| Hero carousel (ordered event list) | `cms_hero` | `bff/home.highlights` (open events only) | featured events |
| Hubs | `cms_hubs` | `bff/home.hubs` (volume/count computed with `eventFull`) | the two built-in hubs |
| Promo / spotlight cards | `cms_promos` | `bff/home.promos`, rendered in the home rail | Perps promo |
| Site banner | `cms_banners` | `/v1/site_config.banners`, rendered in the shell under the header (top) or above the footer (bottom) | none |
| Category navigation + featured tab | `cms_nav`, `admin_settings.featured_tab` | `/v1/site_config.nav`, rendered as the category strip | 10 categories, "Harbor 2026" → `/category/elections` |
| Info cards | `cms_info_cards` | `bff/home.info_cards` | the three built-in cards |
| News items | `cms_news` | `news_items[]` on every `eventFull` event, shown in the event page's News section | the event's `news` text only |
| Help pages | `cms_help` | `GET /v1/help`, `GET /v1/help/:slug`, SPA route `/help/:slug` | — |

**Safe help-page rendering.** Help text is HTML-escaped first. After that, only `#`/`##`/`###` headings, `-` bullets, paragraphs, `**bold**` and `[text](/path | https://…)` links are turned into markup. Scripts and HTML are shown as plain text; the test checks this with an injected `<script>` and `<img onerror>`.

**How CMS data reaches public routes.** Public read routes are unchanged. `admin.js` registers small `v1` response decorators that wrap `res.json` for exact method + path pairs:

- `GET /bff/home`
- `GET /session`
- `POST /log_in` and `POST /log_in_mfa` (to add `admin_roles`)
- `GET /social/posts`, `/social/posts/:id` and `/social/posts/:id/comments`
- `GET /social/profile` and `GET /social/leaderboard`
- `GET /multivariate_event_collections/:c`

`eventFull` in `app.js` also calls `admin.decorateEvent(vo)`, which adds the event's icon colour and news items.

### 18.6 Market ops, perps ops and settings

**Market ops**
- Exchange trading on/off uses `engine.tradingActive` and is persisted in `meta.trading_active`.
- Per-market pause/resume calls `engine.deactivate/activate`. Activation cancels resting orders, per the exchange rule; a configured liquidity bot then re-quotes.
- Series fee multipliers are written to `series.fee_multiplier`, which the engine already applies to every fill.
- Liquidity bot: `ops_liquidity` stores enable, spread, size and levels per market. Saving cancels the liquidity user's resting orders in that market and re-quotes around the last price.
- Combo eligibility: `ops_market_flags.combo_eligible = 0` hides the market from the combo collection, and leg validation rejects it with `400 invalid_leg`. Both are enforced in `admin.js` without editing `combos.js`, and the toggle only appears if `server/combos.js` exists.
- Rolling-market window: read-only view of the window length (set at boot), the current window and recent results.

**Perps ops** update `perp_markets.status` (`halted`/`active`) and `max_leverage` directly; the perps engine already rejects orders on non-active markets and skips them in its tick. "Run funding" calls the exported `engine.perps.runFunding()`. `perps.js` was not modified.

**Settings**

| Setting | Behaviour |
|---|---|
| Interest APY | Stored in `meta.setting_interest_apy` and read by `features.js` on every accrual and by `GET /users/:uid/interest`. Effective: the test checks the next accrual uses it. |
| Feature switches (social, perps, combos) | `admin_settings.features`. Server: mutating requests to the switched-off feature return `403 feature_disabled`. Client: entry points are hidden and routes show a "feature unavailable" page. |
| Publish-liquidity defaults | Editable; see §18.3. |
| Taker fee coefficient | **Display-only.** `0.07` is a constant in `engine.js`, which is out of bounds for this work. The effective per-series scaling is the fee multiplier above. |
| Rate limit | Display-only view of the boot configuration. |
| Health | DB size (+ WAL), uptime, WebSocket clients (`app.locals.wsHub`, set in `index.js`), memory and row counts. |

### 18.7 Users, moderation and announcements

**Users.** The detail view never interprets raw quantity columns. `asUser(uid, url)` dispatches the user-facing GET routes through the `v1` router as the target user: `/balance`, `/positions`, `/orders?status=resting`, `/transactions`, the three limit routes and `/mfa`. The admin view therefore shows exactly what the user sees, using the same SQL and serializers. Actions, each with a required reason:

- **Credit/debit.** Writes an `adjustment` ledger row via `engine.credit`, cannot take cash below zero, emits `user_balance` (the header updates live) and notifies the user.
- **Lock.** Writes to `acct_locks`, deletes the user's sessions and MFA challenges, and cancels resting orders. While locked, `/log_in` and `/log_in_mfa` return `403 account_locked`, and any surviving cookie is treated as signed out.
- **Unlock.**
- **Reset two-factor.**
- **Clear today's session time.**
- **Override a limit.** Takes effect immediately, skipping the cooling-off period.

**Moderation**
- Any signed-in user can report a post (⋯ menu) or a reply (Report button): `POST /v1/users/:uid/social/reports`, stored in `mod_reports` and de-duplicated per reporter and item.
- The moderator queue can hide (`mod_hidden`, filtered out of feeds, and the single-post endpoint returns 404), delete, or dismiss a report. It can also ban or unban posting (`mod_bans` → `403 posting_banned` on new posts and replies) and verify profiles (`mod_verified` → `author.verified`, shown as a ✓ badge next to nicknames).

**Announcements**
- Sent with `notify()` to every unlocked user in a segment: everyone, traders, funded, never traded, social members or staff. Notifications are stored and pushed live over the private `notifications` channel.
- Templates are stored in `ann_templates`, and the send history in `ann_announcements`.

### 18.8 Reports

`GET /v1/admin/reports?from=YYYY-MM-DD&to=YYYY-MM-DD` covers UTC days (default: the last 30 days, at most 400). It returns:

- **Totals and per-day series:**
  - trades
  - volume in contracts (`ufp(Σcount)`)
  - volume in dollars (`Σcount×price / UNITS`, the same conversion as `engine.quote().dollar_volume_cents`)
  - fees (`Σ fills.fee_cents`)
  - deposits and withdrawals (ledger)
  - active traders (distinct non-system fillers)
  - sign-ups
- **Open interest:** the current figure only, from `marketVo`.
- **Top markets** by volume in the range.
- **Exposure per market:** open interest, maximum payout and the liquidity account's position, read through its own positions route.

`/v1/admin/reports.csv` exports the daily rows plus a total row. The charts are hand-built SVG bar charts, one series per chart, with hover tooltips, using the app's `--brand` and `--line` tokens.

### 18.9 Endpoints (all under `/v1`)

**Public**
- `GET /site_config`
- `GET /help`, `GET /help/:slug`
- `POST /users/:uid/social/reports`

**social-admin aliases (`social.moderate`)**
- `DELETE /users/:uid/social/social-admin/posts/:pid`
- `DELETE /users/:uid/social/social-admin/posts/:pid/comments/:cid`
- `GET /users/:uid/social/social-admin/profiles`

**Admin (`/admin/…`)**

| Area | Endpoints |
|---|---|
| Identity, roles, audit | `GET me`; `GET roles`; `PUT roles/:userId`; `GET audit` |
| Catalog | `GET catalog/series\|events\|markets`; `POST catalog/series\|events\|markets`; `PUT catalog/{series\|events\|markets}/:ticker`; `DELETE catalog/:kind/:ticker` (drafts only); `POST catalog/:kind/:ticker/publish`; `GET catalog/preview/:ticker`; `GET catalog/import/template.csv`; `POST catalog/import` |
| Resolution | `GET resolution/queue`; `GET resolution/:ticker`; `POST resolution/:ticker/{resolve\|reverse\|finalize\|close}` |
| Content | `GET/POST content/{hubs\|promos\|banners\|info_cards\|news\|help}`; `PUT/DELETE content/:coll/:id`; `GET/PUT hero`; `GET/PUT nav` |
| Market ops | `GET ops`; `POST ops/exchange`; `POST ops/markets/:ticker/{pause\|resume\|requote}`; `PUT ops/series/:ticker/fee`; `PUT ops/markets/:ticker/liquidity`; `PUT ops/markets/:ticker/combo` |
| Perps ops | `GET perps`; `POST perps/:ticker/{halt\|resume\|funding}`; `PUT perps/:ticker/leverage` |
| Users | `GET users`; `GET users/:id`; `POST users/:id/{adjust\|lock\|unlock\|reset_mfa\|clear_session_time}`; `PUT users/:id/limits/:kind` |
| Moderation | `GET moderation/reports`; `POST moderation/reports/:id/{hide\|delete\|dismiss}`; `POST moderation/content/:kind/:id/{hide\|unhide\|delete}`; `GET moderation/hidden`; `GET moderation/profiles`; `POST moderation/users/:id/{ban\|unban\|verify\|unverify}` |
| Announcements | `GET announcements`; `POST announcements`; `POST announcements/templates`; `DELETE announcements/templates/:id` |
| Reports | `GET reports`; `GET reports.csv` |
| Settings and health | `GET/PUT settings`; `GET health` |

### 18.10 Tables (created by `server/admin.js`)

| Purpose | Tables |
|---|---|
| Roles, audit, settings | `admin_roles`, `admin_audit`, `admin_settings` |
| Catalog drafts | `cms_draft_series`, `cms_draft_events`, `cms_draft_markets`, `cms_event_meta` |
| Content | `cms_hero`, `cms_hubs`, `cms_promos`, `cms_banners`, `cms_nav`, `cms_info_cards`, `cms_news`, `cms_help` |
| Resolution | `res_resolutions` |
| Market ops | `ops_liquidity`, `ops_market_flags` |
| Accounts and moderation | `acct_locks`, `mod_reports`, `mod_hidden`, `mod_bans`, `mod_verified` |
| Announcements | `ann_templates`, `ann_announcements` |

Foreign keys point only to `users`, with `ON DELETE CASCADE`, so `npm run seed` (a reset) still works.

### 18.11 Verification

`clone/tests/admin.e2e.test.js` has 14 Playwright scenarios against a real server, a temp SQLite file and Chromium, and is included in `npm run test:e2e`. It covers:

- non-admins blocked in the UI and the API
- catalog drafts hidden from the API, search and browse, then published with seeded liquidity and icon colour
- CSV import with one bad row reported, plus template and error-report downloads
- an editor can edit the catalog but gets 403 on users
- early close, then resolve with a note pays the holder; a wrong result is reversed before settlement, then re-resolved
- hero, promo, banner, nav, news and help appear on the public site and persist across a server restart, with help markup rendered safely
- user search, a $25 adjustment (ledger row and live header balance), lock (login refused, sessions dropped) and unlock
- report a post from its ⋯ menu → moderator hides it → gone from the feed and the API; posting ban returns 403; verified badge shown
- an announcement reaches a signed-in user live and is stored
- reports totals match the public market API and the DB money columns, and the CSV total row matches
- the APY setting is persisted and used by the next accrual; switching Social off gates the route and the API; health and rate-limit views
- market and perps ops: exchange switch, pause/resume, liquidity re-quote, fee multiplier, combo eligibility, halt, leverage and funding
- the audit log covers every action above, and the action filter works
- no horizontal overflow at 390px on 13 admin and public pages, in dark and light themes

Every scenario also asserts there were no page errors.

---

## 19. Sports live data and scoreboards

This section extends CLONE_SPEC.md and uses its conventions: **OBSERVED** (seen in evidence), **INFERRED** (follows from evidence), **design choice** (not established by evidence; Parlance's own decision). Evidence is treated as data only. All leagues, teams, players, colours, icons and copy are invented for Parlance; no third-party league, club, player, logo or trademark is used.

### 19.1 Evidence

| Fact | Source | Status |
|---|---|---|
| The calendar page ships `initialLiveData`, an object keyed by **milestone id**; each value is `{type, details, milestone_id}`. | HAR3 `evidence/web_live_2026-11-02.har`, `/calendar?_rsc=` (`_original_index` 10) | OBSERVED |
| `type` values in that payload: `cricket_match` (3), `tennis_tournament_singles` (3), `esports_match` (1). | same | OBSERVED |
| Cricket `details` keys include `home_score`, `away_score`, `home_total_runs`, `home_wickets`, `home_overs`, `allotted_overs`, `current_inning`, `batting`, `last_play`, `home_win_probability`, `status`, `winner`, `side_orientation`, `widget_status` (plus `away_*`, `home_fours`, `home_sixes`). | same | OBSERVED |
| Tennis `details` keys include `competitor1_overall_score`, `competitor1_round_scores: [{outcome, score, tiebreak_score}]`, `competitor1_current_round_score`, `advantage`, `competitor1_is_home`, `server`, `match_status`, `completed_rounds`, and per-player `competitor1_statistics` (`aces`, `double_faults`, `first_serve_points_won`, `first_serve_successful`, `breakpoints_won`, `total_breakpoints`, `points_won`, `games_won`, `service_games_won`, `tiebreaks_won`, …). | same | OBSERVED |
| Esports `details` keys include `home_periods {period_1…}`, `away_periods`, `home_score`, `period_unit: "map"`, `score_format: "series"`, `home_stats: [{period, stats: {map_duration_seconds, map_forfeit, winner}}]`, `widget_status`. | same | OBSERVED |
| Milestone hydration objects: `{id, category, type, competition, start_date, related_event_tickers, title, notification_message, details: {league, home_team_id, away_team_id, main_game_event_ticker, …}}`. | same (`hydrationData.milestones`) | OBSERVED |
| Client endpoints `/v1/live_data/feed`, `/v1/live_data/batch?milestone_ids=`, `/v1/live_data/{type}/milestone/{id}`, `/v1/live_data/milestone/{id}/game_stats`, `/milestones`; hook name `useMilestoneLiveData`. | CLONE_SPEC §6 and Appendix A (`JS:afefab63e6753a28`, HAR1#15) | OBSERVED (names); response shapes INFERRED |
| `/v1/live_data/count` polled every ~30 s. | CLONE_SPEC §13.5 | OBSERVED |
| Live page: FEATURED leagues with sport icons, "What's next", collapsible sports with counts ("Tennis (257)"). Browse live tennis cards: red **LIVE** + competition subtitle, per-player set-score columns and the current game score next to the odds pill, red-tinted border. | User screenshots, CLONE_SPEC §15.3 / §15.5 | OBSERVED |

Everything below that is not in this table — the simulation, rates, leagues, the hub page, the event-page scoreboard, table layouts, WS message shape — is a **design choice**.

### 19.2 Model

- **League** (`sports_leagues`): id (`GPL`, `CGA`, `CHL`, `CHW`, `CPL`, `LHO`, `HTB`, `VXM`), sport, name, short name, `featured`, series ticker `PLX{id}`. Featured leagues mirror the screenshot's FEATURED rail (pro football, college football, pro basketball, women's college basketball) plus soccer.
- **Team / player** (`sports_teams`): name, short name, 3-letter abbreviation, colour, rating. Monograms are generated from the abbreviation and colour.
- **Milestone** (`sports_milestones`): one game. `type` uses the observed names where they exist (`cricket_match`, `tennis_tournament_singles`, `esports_match`) and the same pattern otherwise (`soccer_match`, `basketball_game`, `football_game`). Status machine: `scheduled → live → final` (exposed to clients as `details.status` `scheduled | live | complete` and `widget_status` `pre | live | finished`, as observed).
- The full deterministic game state (including the PRNG state) is stored as JSON in `state_json`; denormalised columns hold scores, win probability, winner, live label and last play.

### 19.3 Simulation (design choice)

Each game advances in **segments** of game time; a segment is resolved when the game clock passes its end. A seeded PRNG (mulberry32, state persisted) makes every game reproducible from its seed.

| Sport (type) | Segment | Scoring model | Live label | Win probability |
|---|---|---|---|---|
| Soccer (`soccer_match`) | 1 match minute; 10-min half-time | Poisson goals per minute from team strength; shots, corners, fouls, yellow/red cards (a red card cuts the team's rate) | `1st half · 23'`, `Half-time`, `2nd half · 61'` | Exact three-way Poisson over remaining minutes (home / draw / away) |
| Basketball (`basketball_game`) | One possession (6–24 s); 12-min (pro) or 10-min (college W) quarters; OT until decided | Turnovers, 2s/3s with make rates, shooting fouls, offensive rebounds | `Q3 4:12`, `Half-time`, `OT 2:10` | Normal approximation: margin + strength drift + possession, σ = 0.24·√(seconds left) |
| Football (`football_game`) | One play (18–42 s); 15-min quarters; 10-min OT periods until decided | Downs & distance, runs/passes/sacks/turnovers, punts, field goals by distance, TD + PAT, safeties | `Q2 8:31` plus `2nd & 7 at OPP 34` | Normal approximation with field-position expected points, σ = 0.22·√(seconds left) |
| Tennis (`tennis_tournament_singles`) | One point (25–48 s, +90 s changeovers) | Serve model (first serve in, aces, double faults, serve/return win rates); deuce/advantage; tiebreak at 6-6 with correct serve rotation; best of 3 | `Set 2 · 3-2`, `· Tiebreak` | Exact Markov chain: game → tiebreak → set → match |
| Cricket T20 (`cricket_match`) | One delivery (28–45 s); 10-min innings break | Per-ball outcomes (dot, 1–3, 4, 6, wicket, wide) varying by powerplay / middle / death overs; target = first innings + 1; tie decided on boundary count (design choice) | `1st inns · 9.3 ov`, `Innings break`, `2nd inns · 12.4 ov` | Resource-based expected runs (balls and wickets left), normal approximation for the chase |
| Esports (`esports_match`) | One round (80–120 s); 5-min map break | Round win probability per map; first to 13, win by 2 from 12-12; best of 3 maps | `Map 2 · 8-5` | Exact recursion per map, then series |

A play is logged for every resolved segment that produces one (goals, shots, cards, possessions, plays, points of note, deliveries, rounds, period changes, final). Each play stores game time, period, clock text, team, kind, text, the score after it and the home win probability.

### 19.4 Clock, speed and persistence

- The game clock is driven by the exchange's engine tick (`engine.on('tick')`, every `tickMs`). Each tick advances every live game by `elapsed real ms × speed`.
- `speed` = game seconds per real second: `start({ sports: { speed } })`, else env `SPORTS_SPEED`, default 1 (real time). Seeded start times are also scaled by `speed`, so with `speed: 20` a "kick-off in 30 min" game starts in 90 s.
- Every tick writes the game row, new plays and changed stats in one transaction. **Restart:** the first tick after boot uses a zero time step, so each clock resumes exactly where the DB left it (no catch-up jump for downtime); later steps are capped at 5 s. Games whose scheduled start passed during downtime start at boot.
- **Seeding (idempotent):** on first mount, 21 fixtures are created relative to now — 8 live (fast-forwarded through the same simulation, with back-dated plays and price history; the live tennis match is chosen to have a first-set tiebreak), 9 upcoming and 4 recently final (resolved through the normal path). A `meta` key `sports_seed_v1` marks it; `npm run seed` (which wipes `meta`) also clears the sports tables so they are rebuilt. Every league is kept stocked with at least one upcoming fixture.

### 19.5 Markets, liquidity and settlement

- One **event** per game in the league's series (category `Sports`, series tags `[sport label, league name]`, which become the Sports subcategory chips). Title `Home vs Away`, sub-title `{competition} · Winner`, `mutually_exclusive`.
- **Winner markets:** one per team (`{event}-{ABBR}`); soccer adds `{event}-TIE` ("Draw") for a three-way market. Links: `sports_event_links (event_ticker ↔ milestone_id)`, `sports_markets (market_ticker → outcome home|away|draw)`.
- `events.is_live` / `live_label` are kept in sync on every tick (`is_live=1` only while live; final sets `Final · 2-1`), so `GET /v1/live_data/count` stays correct without changes.
- **Live odds:** when the fair price `round(100 × win probability)` (clamped 2–98¢) moves by ≥1¢ (at most once per `requoteMs`, default 1 s), the liquidity account cancels its resting orders, a reference trade of one contract prints at the fair price (system account `sportsflow@parlance.local` posts NO at `100−f`, the liquidity account takes it with an IOC YES at `f`), and the liquidity account rests a YES bid at `f−1` and a NO bid at `99−f` (`depthContracts`, default 150). Card and event-page odds (last price) therefore follow the win probability. Quantities use the engine's unit (`require('./engine').UNITS`, currently 100 = hundredths of a contract).
- **Settlement:** at the final whistle every market of the game goes through `engine.determine(ticker, outcome === winner ? 'yes' : 'no')` (which closes it and cancels resting orders); the engine tick finalizes after `settlement_timer_seconds` (5 s), writing `settlements`, the `settlement` ledger credit and the user notification through the existing path.

### 19.6 UI

- **Scoreboard components** (`public/js/views/scoreboard.js`): sport icons (own inline SVG), team monograms, compact score columns per sport (single score; tennis set columns with tiebreak superscript, serve dot and current game points; cricket `runs/wkts` + overs; esports current-map rounds + maps), win-probability bar (home / draw / away), the full board (team sports: score line, clock, down & distance / possession / red cards, line score; tennis set table; cricket innings rows with Target, CRR, RRR, requirement and recent balls; esports maps), play-by-play list and per-sport box score.
- **Cards** (`components.js` `eventCard`): events with `live_data` show red **LIVE** + competition + game state, home/away rows with score columns beside the odds pill, and a red-tinted border; finals show a "Final" tag.
- **Live page / calendar** (`calendar.js`): FEATURED leagues with sport icons and live counts, "What's next", collapsible sports with counts (`Soccer (3)`), each opening to its leagues. Filters are URL-addressable: `/live?league=CPL`, `/calendar?sport=tennis`.
- **Event page** (`event.js`): full scoreboard above the chart, Play-by-play / Box score tabs; live via WS; a final game shows **Final** and "{winner} won", and the ticket shows the resolved result.
- **Hub** `/sports` and `/sports/:league`: league tabs (with live badges), sport chips (`?sport=`), sections **Live now / Upcoming / Results** of game cards (compact board, odds per side and draw, last play, win-probability bar). Linked from MORE ("Sports scores") and from the Sports category ("Live scores ›" chip, shown when the sports engine is running).
- **Live updates:** one page-wide subscription to the `live_data` channel patches every element tagged `data-live-ms` (card columns, subtitles, hub state, last play, win bar); card odds pills follow the `ticker` channel once sports data is seen. The event page subscribes with `milestone_ids: [id]`. Polling fallback every 5 s while the socket is down (`/v1/live_data/batch`, `/v1/sports/events/{ticker}`).
- Styles only in `public/sports.css`, using the shared tokens; dark default, light supported.

### 19.7 API

| Endpoint | Response |
|---|---|
| `GET /v1/live_data/feed?sport=&league=&limit=` | `{live:[item], upcoming:[item], results:[item]}`, item = `{milestone, live_data, event}` (`event` is the full event with markets) |
| `GET /v1/live_data/batch?milestone_ids=a,b` (≤100) | `{live_datas:[live_data]}` |
| `GET /v1/live_data/{type}/milestone/{id}` | `{live_data}`; 404 when the type does not match |
| `GET /v1/live_data/milestone/{id}/game_stats` | `{milestone_id, type, stats:{home:{…}, away:{…}}, periods:{home:[…], away:[…]}, plays_count}` (from `sports_stats`) |
| `GET /v1/live_data/count` | unchanged: `{count}` |
| `GET /v1/milestones?category=&sport=&league=&type=&status=&related_event_ticker=&min_start_date=&max_start_date=&limit=&cursor=` | `{milestones:[milestone], cursor}` |
| `GET /v1/milestones/{id}` | `{milestone}` |
| `GET /v1/milestones/{id}/plays?limit=&before_seq=` | `{plays:[play]}` newest first |
| `GET /v1/sports/leagues` | `{featured:[league], sports:[{sport, label, type, count, live_count, leagues}], leagues, totals}`; `count` = scheduled + live |
| `GET /v1/sports/events/{event_ticker}` | `{milestone, live_data, plays}` (event page fallback); 404 for non-sports events |
| `GET /trade-api/v2/events/{t}` and every `eventFull` user | events linked to a game gain `milestone_id` and `live_data` |

`live_data` = `{milestone_id, type, sport, sport_label, league{id,name,short_name}, competition, title, start_date, status, live_label, event_ticker, home, away, outcomes{market_ticker: home|away|draw}, lines, stats, updated_ts, details}`; `details` carries the observed field names per type plus common `home_score, away_score, home_periods, away_periods, status, widget_status, winner, home_win_probability, away_win_probability, draw_probability (soccer), last_play, period, clock, period_label, side_orientation:"milestone"`. `milestone` = `{id, category:"Sports", type, sport, competition, title, start_date, end_date, status, league_id, league, related_event_tickers, notification_message, details{league, sport, home_team_id, away_team_id, main_game_event_ticker}, home, away, winner, last_updated_ts}`. `play` = `{seq, ts, game_time, period, clock, team, kind, text, home_score, away_score, home_win_probability}`.

### 19.8 WebSocket

- Public channel **`live_data`** on `/v1/ws`. Subscribe `{cmd:"subscribe", params:{channels:["live_data"], milestone_ids?:[…]}}` (no filter = every game).
- Message per live game per tick: `{type:"live_data", sid, seq, msg: live_data + {plays:[newest plays this tick, ≤30]}}`; also sent on start and on the final whistle.
- Market effects use the existing channels (`ticker`, `orderbook_delta`, `trade`, `market_lifecycle_v2`, private `fill`, `user_balance`, `notifications`).

### 19.9 Tables (created by `server/sports.js` with `CREATE TABLE IF NOT EXISTS`)

`sports_leagues`, `sports_teams`, `sports_milestones` (status, `state_json`, scores, `win_home/away/draw`, winner, `live_label`, `last_play`, `play_seq`, `start_ts`, `started_ts`, `ended_ts`, `updated_ts`), `sports_plays (milestone_id, seq)`, `sports_stats (milestone_id, side, stat, value)`, `sports_event_links (event_ticker ↔ milestone_id)`, `sports_markets (market_ticker → milestone_id, outcome, quoted_cents, quoted_ts)`. No foreign keys to core tables, so a full reseed can delete events and markets freely.

### 19.10 Configuration

- `start({ sports: { speed, requoteMs, depthContracts, settlementSeconds } })` enables the engine. `sports: false` (or omitting it from a programmatic `start()`) leaves it off, which keeps the existing scenario tests' fixed seed counts unchanged; `SPORTS=1` enables it for programmatic starts. `npm start` / `node server/index.js` enable it by default (`SPORTS=0` disables). Env `SPORTS_SPEED` sets the default speed.

### 19.11 Verification

`clone/tests/sports.e2e.test.js` (part of `npm run test:e2e`) boots `start({port, dbFile, tickMs: 250, sports: {speed: 10}})` on a temp DB and drives real Chromium:

1. **Final whistle:** seeded counts (≥8 live, ≥8 upcoming, ≥4 final, >500 plays); a user signs up, deposits, buys YES on home (ticket, Dollars mode), draw and away (API) of the soccer game nearest full-time; full-time arrives live on the open event page ("Final", "{winner} won"); the three markets are determined and finalized with the right results; the winning market's `settlements` row pays the held units, a `settlement` ledger credit and a `Market settled YES` notification exist; losers pay 0; the event is no longer live.
2. **Live page:** FEATURED leagues with icons; six collapsible sports whose counts equal the DB; every live game is a tinted card with LIVE + competition; soccer and basketball card scores equal the DB; header live count equals the DB; `?league=CPL`, the tennis group → Lighthouse Open link, and `/calendar?sport=cricket` filter correctly.
3. **Live movement:** a basketball card's clock and score change without a reload; on a competitive game's event page the home market's price changes and stays within 3¢ of the DB win probability; the last trade equals the quoted fair price and liquidity rests around it.
4. **Tennis/cricket:** set games and tiebreak superscripts equal the DB state, one serve dot, valid game points; the card shows the tiebreak superscript; cricket Target, CRR, RRR, runs/wickets and the requirement line equal the DB; observed detail field names are present in the API; a wrong type returns 404.
5. **Event page:** scoreboard above the chart; scores equal the DB; line score; play-by-play newest first, new plays stream in, text equals the DB row; box-score totals equal `sports_stats`; non-sports events have no scoreboard; `game_stats` and `milestones?related_event_ticker=` respond.
6. **Hub:** MORE → `/sports`; section counts equal the DB; league tab `/sports/chl` and `?sport=tennis` filter; results show final cards; unknown league is a not-found page; the Sports category shows the "Live scores" link.
7. **Unaffected + mobile + restart:** home, calendar category filter, the rolling PLX card and the non-game live event still render normally; no horizontal overflow at 390 px on the Live page, calendar, hub, a league page, the Sports category and one event page per sport; after a stop (3 s down) and restart, no game advanced while stopped, nothing was reseeded, every clock resumed from its persisted value without a catch-up jump, and clocks run again (verified in the UI).

No page errors are allowed in any scenario.

---

## 20. Event live chat

This section extends CLONE_SPEC.md and uses its conventions: **OBSERVED** (seen in evidence), **INFERRED** (follows from evidence), **design choice** (Parlance's own decision, not established by evidence). Product name is Parlance; all copy, styling and code are Parlance's own.

### 20.1 Evidence

| Fact | Source | Status |
|---|---|---|
| Event headers show a "● Live chat" pill next to the add-to-calendar, comments, share and download icons, on live events. | User screenshot of `/markets/controls/senate-winner/controls-2026`; CLONE_SPEC §15.4 ("Action icons: … and 'Live chat' for live events") | OBSERVED |
| Protocol, message shapes, moderation cues, panel layout, limits. | none captured (PLAN.md research item R1) | **design choice** (everything below) |

### 20.2 Model (design choice)

- **One room per event**, keyed by event ticker; created lazily on the first write (message or moderator action). Reads never create rows. Combo events (`PLXCOMBO`) have no chat.
- **Room status** is derived on every read/write:
  - `locked` when a moderator locked it;
  - otherwise `open` while the event has at least one `active` market, or when the room's `after_close` setting is `open`;
  - otherwise `read_only` (default after the event closes).
- **Messages**: 1–280 characters (Unicode code points, NFC, trimmed), one line, stored raw. Optional `reply_to` (must be a non-deleted message of the same room). Nickname is snapshotted at send time.
- **Deletion is soft**: `mod_state` = `visible | author_deleted | moderator_removed`. Deleted messages vanish from history and live views; moderators still see them in the admin room log. Deleting a pinned message unpins it. Quotes of a deleted message read "Original message was deleted".
- **Pinned message**: one per room, moderators only.
- **Slow mode**: per room, one of 0/5/10/30/60/120/300 s between messages per user, enforced server-side from the user's last persisted message (survives restarts). Moderators are exempt.
- **Mutes**: per user per room with an expiry (1 min – 7 days). The muted user also gets a notification.
- **Presence**: approximate "N online" = distinct WebSocket connections subscribed to the room's `chat` channel (every open event page subscribes).
- Not built: reactions, message editing (`edited_ts` column is reserved and always null), GIFs/media, typing indicators.

### 20.3 Tables (`server/chat.js`, `CREATE TABLE IF NOT EXISTS`; no existing table changed)

```
chat_rooms    (event_ticker PK, slow_mode_sec, locked, lock_reason, after_close 'read_only'|'open', pinned_message_id, created_at, updated_at)
chat_messages (seq INTEGER PK AUTOINCREMENT, id TEXT UNIQUE 'cm_'+UUIDv4, room, user_id → users, nickname, body, reply_to,
               created_ts, edited_ts, deleted, deleted_by, deleted_ts, mod_state)
               idx (room, deleted, seq), (room, user_id, created_ts)
chat_mutes    (room, user_id → users, until_ts, reason, muted_by, created_at, PK(room, user_id))
```

Reused: `mod_reports` (kind `chat`, `content_id` = message id, `post_id` = event ticker, excerpt, reason), `admin_audit`, `mod_bans`, `acct_locks`, `mod_verified`, `social_profiles`, `admin_settings.features.social`.

### 20.4 REST API

Public message shape (never contains email or user id):
`{id, event_ticker, body, created_time, edited, author:{nickname, verified}, reply_to:{id, nickname, excerpt, deleted}|null, is_mine?}` (`is_mine` only on REST responses to a signed-in viewer).

Room shape: `{event_ticker, status, event_active, locked, lock_reason, slow_mode_sec, after_close, pinned: message|null, online, message_count}`.

| Method + path | Auth | Notes |
|---|---|---|
| `GET /v1/events/{ticker}/chat?before={message_id}&limit=1..100` | public | `{room, messages (oldest→newest), has_more, viewer}`. `before` must be a message of this room (400 otherwise). `viewer` = `{signed_in, nickname, is_moderator, can_post, block: null|signed_out|no_nickname|banned|feature_disabled|locked|closed|muted, muted_until, slow_mode_wait_sec}`. `Cache-Control: no-store`. |
| `POST /v1/users/{uid}/chat/{ticker}/messages` `{body, reply_to?}` | member, CSRF | 201 `{message, slow_mode_sec}`. Errors: 400 `bad_request` (validation), 401, 403 `forbidden` (CSRF / other uid), 403 `account_locked`, 403 `posting_banned`, 403 `feature_disabled`, 409 `social_profile_required`, 404, 403 `chat_locked`, 403 `chat_closed`, 403 `chat_muted` (+`muted_until`), 429 `too_many_requests` (+`retry_after_sec`, `Retry-After` header) for rate limit or slow mode. |
| `DELETE /v1/users/{uid}/chat/{ticker}/messages/{id}` | author, or moderator | Author → `author_deleted`; moderator → `moderator_removed` + audit + open reports actioned. |
| `POST /v1/users/{uid}/chat/{ticker}/messages/{id}/report` `{reason 3–300}` | member, CSRF | 201 `{report}`; duplicate open report returns the existing one; own messages refused (400). Feeds the admin report queue. |
| `GET /v1/admin/chat/rooms` | `social.moderate` | Rooms with activity: messages, last 24 h, last message time, online, active mutes, open reports, state. |
| `GET /v1/admin/chat/rooms/{ticker}` | `social.moderate` | Room + latest 200 messages including deleted (`mod_state`) + active mutes (nickname, until, reason). |
| `POST /v1/admin/chat/rooms/{ticker}/{action}` | `social.moderate`, CSRF | `delete {message_id, reason?}`, `pin {message_id}`, `unpin`, `slow_mode {seconds}`, `lock {reason?}`, `unlock`, `settings {after_close}`, `mute {message_id or nickname, minutes, reason?}`, `unmute {nickname}`. Every action writes `admin_audit` (`chat.delete`, `chat.pin`, `chat.unpin`, `chat.slow_mode`, `chat.lock`, `chat.unlock`, `chat.settings`, `chat.mute`, `chat.unmute`) with before/after JSON. |
| `GET /v1/admin/moderation/reports`, `POST …/reports/{id}/hide|delete` | `social.moderate` | Existing queue. For kind `chat` the response gets accurate `content_exists` and `event_ticker`; Hide/Delete remove the chat message (soft delete, live) and action the report; Dismiss is unchanged. Implemented as an app-level hook in `server/chat.js` ahead of the v1 router (admin.js untouched). |

### 20.5 WebSocket (`/v1/ws`)

- Public channel **`chat`**, receive-only. Subscribe: `{cmd:'subscribe', params:{channels:['chat'], event_tickers:['EVT', …]}}` — 1–20 tickers, each a string ≤ 64 chars; otherwise `{type:'error', msg:{code:10}}`. Publishing goes only to subscriptions whose filter contains the event ticker.
- Messages (`{type, sid, seq, msg}`):
  - `chat_message` — public message shape;
  - `chat_deleted` — `{event_ticker, id}`;
  - `chat_pinned` — `{event_ticker, pinned: message|null}`;
  - `chat_room_state` — room shape; sent on slow mode / lock / settings changes, on market lifecycle changes of the event (close → read-only live), and when the online count changes (checked every ~2 s on the engine tick).
- Clients resubscribe on reconnect (shared socket behaviour) and the chat view refetches the newest page to fill the gap (and drops messages deleted meanwhile).

### 20.6 Security controls

1. **Auth on every write**: session cookie + `requireUser` (path uid must equal the session user); moderator endpoints check `social.moderate` through the admin role model (`rolesOf` + `ROLE_PERMS`) server-side. UI hiding is cosmetic only.
2. **CSRF**: the existing app middleware requires `x-csrf-token` on every non-GET request with a session (403 otherwise); WS upgrade still requires the `csrfToken` query for private channels.
3. **Rate limits** (stricter than the global 300-burst/150 per s per IP limiter), token buckets on chat writes (send + report): per user 8 burst, 1 per 2 s; per IP 30 burst, 3 per s (env `CHAT_USER_BURST`, `CHAT_USER_PER_SEC`, `CHAT_IP_BURST`, `CHAT_IP_PER_SEC`). 429 `too_many_requests` with `retry_after_sec` and `Retry-After`. Invalid attempts also spend tokens.
4. **Slow mode** enforced server-side from persisted timestamps.
5. **Refused accounts**: locked accounts (session ignored by admin middleware, plus an explicit check), posting bans (`mod_bans`, same ban as social posts), per-room mutes, locked and read-only rooms, social feature switch off.
6. **Validation**: body must be a JSON string; raw length ≤ 4000 before processing; well-formed UTF-16; NFC; trimmed 1–280 code points; rejects C0/C1 controls (incl. newlines/tabs), U+2028/2029, bidi overrides/isolates and direction marks, and runs of ≥ 6 combining marks; `reply_to` must be a live message in the same room; report reason 3–300 chars without controls; slow-mode and mute values from fixed ranges; tickers matched against `^[A-Z0-9][A-Z0-9._-]{0,63}$` and the events table.
7. **XSS**: bodies are stored raw and rendered only via `textContent` / text nodes (`h()` builder in `public/js/views/chat.js`); no user content goes through `innerHTML`. Admin tables pass user content through `esc()`. Links: http/https only, parsed with `URL`, `rel="noopener noreferrer nofollow ugc"`, `target="_blank"`; `javascript:` and other schemes stay plain text. No user-controlled attributes (nicknames are `[A-Za-z0-9_]{3,20}`).
8. **Privacy**: public payloads expose nickname snapshot + verified flag only; no emails or user ids in history or WS frames. Moderation targets authors by message id (or nickname), so the client never needs user ids.
9. **Unguessable ids**: message ids are `cm_` + random UUIDv4; pagination cursor is a message id validated against the room.
10. **WebSocket**: chat is receive-only (sending stays on REST so CSRF/auth/limits apply); publish only to subscribers of that event; subscriptions must carry an event filter (1–20); inbound frames capped at 64 KiB (`maxPayload`, close 1009) and socket errors are handled so an oversized frame drops the client instead of crashing the server; outbound chat frames are bounded by the 280-char body.
11. **Audit log** for every moderator action (actor, action, target, before/after, reason).

### 20.7 UI

- **Event header**: "● Live chat" pill first in the action row; red pulsing dot when the room is `open`, grey otherwise; unread badge while the panel is closed. Events with a live sports scoreboard also get a compact "● Live chat · N online" bar under the scoreboard.
- **Panel**: right side, full height on desktop, overlaying the page (the trade ticket stays reachable by closing it); bottom drawer (86 vh, backdrop) on phones. Header: title with live dot, "N online", moderation toggle (moderators), close. Pinned bar (moderators can unpin), state banner (locked + reason / read-only / slow mode).
- **Message list**: nickname, verified badge, relative time (refreshes every 30 s), reply quote, auto-linked text. Actions: Reply; Delete (own, or any for moderators); ⋯ menu with Report (Spam or scam / Harassment or hate / Off-topic) and, for moderators, Pin and Mute author 10 min / 1 h / 24 h. Infinite scroll up ("Load earlier messages" fallback), "Jump to latest · N new" when scrolled up.
- **Composer**: Enter sends; counter `n/280` (red and Send disabled over the limit or when empty); reply chip; slow-mode/rate-limit countdown "Slow mode · wait Ns" (from `retry_after_sec`, the room's slow mode after sending, or `viewer.slow_mode_wait_sec`); inline error line.
- **Prompts**: signed out → "Log in to join the conversation" + Log in (`?next=` back); no nickname → inline nickname form (creates the social profile); banned / social off / locked / read-only / muted ("You're muted in this chat until 3:42 PM") replace the composer, live where the server pushes state.
- **Admin → Chat** (`/admin/chat`, permission `social.moderate`): rooms table (state, messages, last 24 h, online, mutes, open reports, last message) and "Open room by ticker"; room page with slow mode, after-close setting, lock/unlock (reason dialog), pinned message, active mutes with Unmute, and the latest 200 messages (incl. removed) with Delete (reason) / Pin / Mute (duration + reason). Chat reports appear in Moderation → Report queue with type `chat`.
- Styles: `public/chat.css` (app.css tokens; dark default + light).

### 20.8 Verification

`clone/tests/chat.e2e.test.js` (in `npm run test:e2e`), real server + SQLite file + Chromium, two or more browser contexts:

1. A posts, B sees it live without reload; presence ≥ 2; reply with quote; A deletes own (live for B, `author_deleted` in DB); id format; history order after reload.
2. XSS: `<img onerror>`, `<script>`, `"><svg onload>`, `javascript:` render verbatim as text; no img/script/svg nodes, no dialog, no page error, `window.__xss` undefined; one https link with the safe `rel`; same after reload.
3. Validation (empty, spaces, 281 chars, BEL, newline, non-string, cross-room reply; 280 accepted); CSRF missing → 403; 401 / 403 / 404; history leaks no emails or user ids; bad cursor / limit → 400; per-user burst → 429 with `retry_after_sec` + `Retry-After`; composer counter 281/280 disables Send.
4. Signed-out reader sees history and sign-in prompt (link carries `next`); member without a nickname gets the nickname form (API 409), picks one and posts.
5. Moderator (seeded admin): slow mode banner live, API 429 for slow mode, browser send → 429 with countdown + error, Send disabled; pin (live for A); delete (live for B, `moderator_removed`, quote becomes "deleted"); mute (B's send refused with "muted … until", API 403 `chat_muted`); lock (A's composer replaced live, API `chat_locked`), unlock; non-moderator 403; audit rows for every action.
6. Report from ⋯ → `mod_reports` kind `chat`; own message not reportable; appears in Admin → Moderation; Delete there removes it live and actions the report; Admin → Chat rooms list → room page shows removed message and mute; Unmute works.
7. Closing the event's market turns the room read-only live (pill grey, banner, composer replaced); API 403 `chat_closed`; history still readable.
8. WS: chat subscription without `event_tickers` → error; delivery only to the subscribed room; 70 KiB frame → close 1009 (server keeps running).
9. Restart keeps history, pin, rooms; per-IP bucket across four users → 4th gets 429; 390 px bottom drawer with no horizontal overflow (dark and light, open and closed).

Result at time of writing: `tests/chat.e2e.test.js` 9/9 pass; full `npm run test:e2e` 103/103 pass (94 existing + 9 chat).

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
