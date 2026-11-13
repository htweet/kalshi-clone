# CLONE_SPEC — Binary event-contract exchange web app (black-box study of kalshi.com)

Status: clean-room specification. Written only from observed behavior: captured network traffic, public documentation, and string-level facts from shipped JavaScript bundles. It contains no copied source code, styles, images, fonts or text assets. Implementers should build from this document only.

> **Revision 12 (2026-11-08):** §36 waitlists (PLAN Phase 7A): the Perps waitlist on by default with a one-time audited
> migration; a reusable waitlist module; the real-money launch waitlist (one-click join, guest double opt-in with hashed
> single-use links, NDPA consent records, encrypted guest emails with a keyed hash, one-click unsubscribe and RFC 8058
> headers, deletion, export and closure), the opinion survey as CMS entries (naira bands, Nigerian payment methods,
> moderated free text), Admin › Waitlists (target and one-time alert, progress bar, consent CSV, throttled resumable
> newsletter outbox) and the launch email offered after the two-person production switch.
>
> **Revision 11 (2026-11-04):** §34 Perps completion (PLAN Phase 6): order amend and decrease, order groups, subaccounts and transfers, server-side trailing stops, size-tiered margin with portfolio (cross) maintenance margin and liquidation, fractional perps, a double-entry perps journal, APY on collateral, Perps referrals, waitlist access; property-based liquidation and funding invariants. §14 updated where behaviour changed.
>
> **Revision 10 (2026-11-04):** §33 feature flags (PLAN Phase 5D): a DB-backed flag per feature and module with rollout, targeting, schedule and kill switch, enforced on the server; play mode on play money with the Central Bank and the Vault Heist; the switch to production with a two-person reset; per-user and site-wide deposit / withdrawal controls; the Central Bank as the promotions treasury.
>
> **Revision 9 (2026-11-03):** §28 trading core (PLAN Phase 5A): sub-cent price grids, the fee accumulator, scalar markets, order review / auto-sell / flip sell, MECNET collateral return, settlement correction with the two-person rule, combos on the finer grid with the HVM window.
>
> **Revision 8 (2026-11-03):** §26 payments, sandbox only (PLAN Phase 4).
>
> **Revision 7 (2026-11-03):** §13.13–§13.19 from logged-in captures and screenshots; §24 social and community completion; §25 accounts, identity, compliance and the account area (PLAN Phases 2–3).
>
> **Revision 6 (2026-11-03):** §21 perimeter security, §22 identity/sessions/login security, §23 assurance, CI and guardrails (PLAN Phase 0–1).
>
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
| `HAR5#n` | **Logged-in** user-supplied HAR, 2026-11-03 12:21–12:22 UTC (Perps, categories, Browse, Incentives, Account › Taxes/Profile, Leaderboard, sign-up resume). | `evidence/web_loggedin2_2026-11-03.har` (95 first-party entries, sha256 `56e9d5f5…`); `{user_id}` substituted; private responses reduced to key shapes; page/RSC bodies removed; token/tracking header values removed |
| `SHOT5:<page>` | User-supplied logged-in screenshots, 2026-11-03: `kyc-intro`, `kyc-qr`, `menu`, `activity`, `lip` (Liquidity Incentive Program), `documents`, `api-docs`, `settings-1…7` (`/account/settings`). Described structurally only; **not stored** (the QR code encodes a live verification session). | session uploads |
| `SHOT4:<step>` | User-supplied screenshots of the logged-in **identity-verification onboarding**, 2026-11-03: `phone-code`, `name`, `birthday`, `address`, `verifying`. Described structurally only; **not stored** (they contain personal data). | session uploads |
| `HAR4#n` | **Logged-in** user-supplied DevTools HAR, 2026-11-03 10:43 UTC, 13 first-party requests on market pages (no portfolio/account calls). *n* = original entry ordinal. | `evidence/web_loggedin_2026-11-03.har` (sha256 `d2fd690b…`); account user id replaced with `{user_id}`; CSRF/WAF/tracking header **values** removed (names kept in `_present_security_headers`); telemetry POST body removed; Datadog entries dropped |
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

API clients sign each request with RSA-PSS. Headers: `KALSHI-ACCESS-KEY`, `KALSHI-ACCESS-TIMESTAMP` (ms), `KALSHI-ACCESS-SIGNATURE` (base64 over timestamp+method+path). An OAuth bearer alternative exists. The browser app uses cookie session + CSRF instead (§4.7). **Clone:** §35.3 (`PARLANCE-ACCESS-*`, RSA-PSS or Ed25519).

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

U13 is resolved for Calendar and Browse by §13.4 and §13.2. U16 is resolved by a design choice in §29.4.

U1 logged-in header contents · U2 exact odds/multiplier formulas · U3 fee coefficient · U4 password-login endpoint path · U5 sign-up branch conditions · U6 event page layout · U7 portfolio layout and columns · U8 CSV columns · U9 WS backoff constants · U10 HTTP status for `MARKET_INACTIVE` · U11 empty/error state copy · U12 BFF feed paging params · U13 calendar/browse/category layouts · U14 whether watchlist syncs to server when logged in (endpoints exist for favorited series).
U15 exact hex values behind the current design tokens (`surface-x10`, `text-x10`, `fill-x30…x50`) and the type-scale metrics (CSS not captured) · U16 how `event_limits` groups are expanded in the calendar UI · U17 fractional-contract order entry UX · U18 contents and ranking of the `/ideas/feed` Social feed (loaded client-side, not in HAR3) · U19 name of the push channel for notifications · U20 delivery channel of the 4-digit MFA code (email or SMS).


### 11.1 Closure status (2026-11-13)
Every register item is now either resolved by evidence or settled by a recorded design choice in the clone (PLAN.md §8
item 2). Where this spec still says UNKNOWN elsewhere, the same paragraph names the design choice that stands in for it.

| Item | Resolution (design choice unless noted) | Where |
|---|---|---|
| U1 logged-in header | balance, portfolio link, notifications bell, account menu (☰) with avatar / initials | §13.16 (A3), §25 |
| U2 odds / multiplier | chance = last trade price, falling back to the bid/ask midpoint; multiplier = 1 / YES ask, 2 decimals | §2 (Home cards) |
| U3 fee coefficient | quadratic taker fee, coefficient editable at runtime (default from the public fee docs) | §16, §21.9 (G7) |
| U4 password-login path | `POST /v1/log_in` with login CSRF and step-up | §22 |
| U5 sign-up branches | email → password → phone code → name → birthday → address; KYC sandbox after | §25 |
| U6 event page layout | built from the redesign observations | §15 |
| U7 portfolio layout and columns | the five tabs as built; **verification against real screens still open (G14, owner captures)** | §17.11 |
| U8 CSV columns | History CSV: time, type, market, description, side, action, quantity, price, amount, fee, status (NGN) | §17.9 |
| U9 WebSocket backoff | 500 ms base, ×2 per attempt, 30 s cap, random jitter; 5 s subscription timeout | §7.2, `public/js/ws.js` |
| U10 `MARKET_INACTIVE` status | HTTP 409 `market_inactive` | §5.4 |
| U11 empty / error copy | every empty and error state is CMS text (Admin › Texts) | §32 |
| U12 BFF feed paging | the home BFF answers in one response (no paging); lists page with cursors where they grow | §2, §35 |
| U13 calendar / browse layouts | resolved by evidence | §13.2, §13.4 |
| U14 watchlist sync | server-side watchlist for signed-in members (`/v1/users/:uid/watchlist`), local for visitors | §17 |
| U15 design-token values | own token scale (type, weights, spacing, radius, colours) applied to every stylesheet | §27 |
| U16 `event_limits` expansion | resolved by a design choice | §29.4 |
| U17 fractional order entry | fractional quantities in the ticket, the book and the API | §16.3 |
| U18 social feed contents / ranking | as built in the social completion phase | §24 |
| U19 push channel name | the private `notifications` channel carries `push` messages; Web Push for devices | §20, §31 |
| U20 4-digit MFA code delivery | authenticator-app codes (TOTP); no SMS or email login codes | §22 |

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
| §13.4 calendar: live section, date sections, category counts with live counts | yes | `event_limits` per section with a "+N more" expander (U16 design choice, §29.4) |
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
| §34 Perps completion (Phase 6): amend / decrease, order groups (limit, OCO, group cancel), subaccounts and transfers, trailing stops, size-tiered margin, portfolio (cross) margin and liquidation, fractional perps, perps double-entry journal, APY on collateral, referrals, waitlist, Admin › Perps ops | yes | tests `perps-trading`, `perps-risk`, `perps-growth`, `perps-invariants`; design choices (§34.13) |
| §15 redesign: dark shell, home, browse frequency, event page, BUY/SELL + Dollars ticket, interest, rolling 15-min markets, Pro | yes | tests `clone/tests/redesign.e2e.test.js` |
| §16 fractional contracts (0.01-contract units, conserving cent rounding, per-market flag, migration) | yes | tests `fractional.e2e.test.js` |
| §17 combos (multivariate markets), two-sided RFQ/quotes, portfolio tabs Positions · Resting · RFQs · Quotes · History | yes | tests `combos`, `rfq`, `orders`, `positions`, `history` |
| §18 admin panel and CMS (roles, audit, catalog drafts + CSV import, resolution desk, content, ops, users, moderation, announcements, reports, settings) | yes | tests `admin.e2e.test.js` |
| §19 sports live data: simulated games in seven sports (ice hockey added in §29.3), scoreboards, live odds, auto-settlement, `/sports` hub | yes | tests `sports.e2e.test.js` |
| §20 event live chat (rooms, slow mode, moderation, reports, presence, XSS-safe rendering, chat rate limits) | yes | tests `chat.e2e.test.js` |
| §21–23 security foundation: headers/CSP nonces, CORS allowlist, bot challenge + client tokens, honeypots, hashed assets; hashed rotating sessions, login hardening, no default admin, step-up, encrypted MFA secrets, hash-chained audit; CI, lint, validation, idempotency, authz matrix | yes | tests `security-perimeter`, `auth-security`, `authz`, `idempotency` |
| §24 social completion: position-tagged posts, stickers, mute, edit window, follows/topics, profile search, badges, full notification matrix + push/email channels, Inner Circle, group chats, RFQ rest-remainder/obscured creator, chat reactions/edits | yes | tests `social2`, `groupchat` |
| §25 identity: onboarding (phone code → name → DOB → address/ID → document verification with QR phone handoff), encrypted PII, KYC sandbox + review, email verification/reset, OAuth (mock provider), passkeys, geo/fraud simulation, export/closure, account area (activity, documents, settings), promo codes, checklist | yes | tests `onboarding`, `identity2`, `account-area` |
| §26 payments, sandbox only: observed funds routes (cards, bank link, crypto, deposits/withdrawals, withdrawal_times, metadata, credit_history), card tokenizer (no PAN stored), ACH pending → settled / returns, crypto confirmations, signed webhooks with replay protection, double-entry journal + audit, reconciliation queue, limits, AML hooks, holds, withdrawal 2FA, non-withdrawable credits, Admin › Payments | yes (sandbox) | tests `payments`; UI is a Parlance design (screens not observed) |
| §28 trading core (Phase 5A): price grids `linear_cent` / `deci_cent` / `tapered` / combo `center_deci_edge_centi_cent` in centi-cents, G1 fee accumulator, scalar markets, order review + auto-sell prompt, flip sell, MECNET collateral return, settlement correction (claw-back, debt rule, step-up, audit) with the optional two-person rule, combos on the finer grid + HVM 3 s window | yes | tests `trading-core`; tick bands and the tapered name are design choices (§28.1) |
| §29 markets and content (Phase 5B): sports spreads and totals settled from the final score, ice-hockey league, running clocks and live header label (G9), calendar `event_limits`, ballot lookup on invented jurisdictions (no address stored), AI news summaries + timeline (offline extractive default with citations, optional external adapter, cache, cost caps, injection handling, admin hide/regenerate), Liquidity Incentive Program (A13, journaled payouts), hub widgets: Senate map, Fed funds outlook, forecast history (A15) | yes | tests `markets-content`; civic data, rates and news invented; accrual formula is a design choice |
| §31 Progressive Web App: web app manifest + own icons, service worker (precache of the hashed bundle, network-only navigations, offline page, user-confirmed updates), install entry (prompt / iOS steps), real Web Push (VAPID RFC 8292, aes128gcm RFC 8291, encrypted outbox with retries) | yes | tests `pwa`; design choices (not observed on the live site) |
| §32 content management (Phase 5C): every SPA string in a keyed text catalog (client and server `t()`, admin overrides, declared variables, plain or allowlist rich text, live updates, staff preview), notification / email / SMS templates on every send, media library with server-side re-encode and slots (logo, icons, manifest), CMS pages with SEO and legal step-up, footer, brand colours with a contrast check, drafts → schedule → publish → rollback with hash-chained audit, editor / publisher roles, JSON export / import with dry run, hard-coded-text enforcement | yes | tests `cms`, `cms-content` |
| §33 feature flags, play mode, Central Bank and money controls (Phase 5D): a flag for every feature and module (on/off, kill switch, rollout, allow/deny by user, role and region, schedule) enforced by a server gate with jobs paused and the UI hidden live, Admin › Feature flags with reason, step-up, history and audit; play mode with signup bonus, free deposits and no withdrawals; Vault Heist against the Central Bank vault; two-person switch to production with backup, archives and reset; per-user deposit / withdrawal revocation; the promotions treasury | yes | tests `flags`, `playmode`; design choices (not observed) |
| §35 public trading API: signed API keys (RSA-PSS / Ed25519), rate tiers, `/trade-api/v2` (orders, batch, groups, history, RFQ, Perps), public WebSocket, FIX 4.4 gateway (simulated), developer portal with demo Try it, status page | yes | tests `api-keys`, `trade-api`, `fix`, `dev-portal`, `api-contract`; parity in `API_PARITY.md` |
| §36 waitlists (Phase 7A): Perps waitlist on by default (audited migration), real-money launch waitlist with one-click and double opt-in joins, consent records, encrypted guest emails, unsubscribe / delete / export, CMS survey with naira bands, Admin › Waitlists (target alert, progress bar, consent CSV, throttled newsletter outbox), launch email offered after the production switch | yes | tests `waitlists`, `authz`, `perps-growth`, `flags` |
| Real KYC vendors, real payment providers (sandbox rails built, no real money), real email/SMS delivery | **no / simulated** | real-world services stay sandboxed by design (PLAN §8.1) | payments run on sandbox rails (§26); see §16.x–19.x "not done" notes |

Verification: 284 end-to-end scenarios across 36 files in `clone/tests/` (run `npm run test:e2e`), each against a real server and a real SQLite file, in Chromium (Playwright) wherever there is UI; the Phase 6 security gate (`perps-invariants`) drives the live engine with property-based sequences. The second file covers the §13 additions: layout, grid/list persistence, subcategories, calendar, the full social loop, live price-alert and fill notifications, limits enforcement and cooling-off, the session lock, two-factor login, persistence across a restart, and no horizontal overflow at 390px in light and dark.

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
- **Clone:** the Perps product is §14; interest on Perps collateral (APY) is §34.7. The spotlight card itself is not built (the home hero carousel stays).

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

### 13.13 Logged-in client behaviour (OBSERVED HAR4)

- **Security headers per request.** Every API call carries `x-aws-waf-token`, including cached public reads (`/v1/cached/series/{s}/markets/{id}/forecast_history`, `/v1/milestones/{id}/volume`). `x-csrf-token` rides on credentialed `/v1` calls: `GET /v1/social/trades`, `GET /v1/events/`, `GET /v1/series/` and `POST /v1/users/{user_id}/metrics/client_event`. The cached reads don't carry it [HAR4 all entries]. Tracking IDs (`x-appsflyer-web-id`, `x-fbp`) go on some credentialed calls. Unauthenticated public reads still answer without any token (curl, 2026-11-03), so the WAF token is enforced at the edge for page traffic, not as an API requirement for public data.
- **Charts use forecast history, not candles.** `GET /v1/cached/series/{series}/markets/{market_uuid}/forecast_history?start_ts&end_ts&period_interval=1440&candlestick_function=mean_price` returns `{forecast_history:[{market_ticker, event_ticker, raw_numerical_forecast, numerical_forecast, formatted_forecast:"65.69%", end_period_ts, period_interval}]}`: 382 daily points for a ~2-year range [HAR4#2–#14].
- **Event detail.** `GET /v1/events/?tickers=…&with_markdown=true` adds `mutually_exclusive_side`, `collateral_return_type:"MECNET"`, `settle_details` (markdown) and `underlying` [HAR4].
- **Polling while logged in.** `milestones/{id}/volume` and `social/trades?series_ticker=` repeat about every 5 s and 10 s, matching §13.5.
- **First-party telemetry.** `POST /v1/users/{user_id}/metrics/client_event` returns 204 with a newline-delimited JSON body of `event_data` records. The body was removed from evidence and its fields are not specified here (privacy).
- **Not in this capture (still UNKNOWN):** the portfolio tabs, Account/Security, deposits, withdrawals and order entry while logged in (research R2/R3 remain open).

### 13.14 Identity-verification onboarding (OBSERVED SHOT4)

This is the multi-step flow a signed-in user goes through before trading. It confirms the INFERRED sign-up wizard of §4.7 (`/sign-up/identity`, `verify_phone`, `resume_sign_up` call sites).

- **Frame.** A full-screen dark page with only the centred wordmark. A **segmented progress bar** sits at the top: three segments, the first full and the second partly filled as steps advance. There is no site navigation.
- **Phone verification [SHOT4:phone-code].**
  - Title: "Enter your 4 digit code". Line: "We've sent a code to <phone in international format>". Hint: "check your text message spam folder".
  - **Four separate single-digit boxes**, with the first focused.
  - "Continue" stays disabled until all four digits are entered. "Resend code" is a secondary pill button, and "Learn more" a text link.
  - Matches the `four_digit_code=true` call sites (§13.9).
- **Legal name [SHOT4:name].**
  - "What's your name?", "It helps us verify your identity." with a dotted-underline "Learn more".
  - Fields: "Legal first name" and "Legal last name", each a floating label inside a rounded field.
  - "Continue" is the primary button. **"Not now"** lets the user skip and resume later (`resume_sign_up`).
- **Date of birth [SHOT4:birthday].** "When's your birthday?" with three fields, MM · DD · Year (auto-advance; the focused field gets an accent border). Notices: "You must be 18 or over to use Kalshi" and "Federal law requires submitting truthful information". Continue stays disabled until the date is valid.
- **Address and national ID [SHOT4:address].**
  - "What's your address?" with the note "we won't send you marketing mail".
  - Fields: **Country** select (country-specific fields follow); "Residential address" with autocomplete; "Apt, suite, other"; "City"; "State/Province/Region" select; "Postal code"; and a **national identification number** whose label and format depend on the country (e.g. Nigeria shows "National Identification Number (NIN) · 11 digits"; presumably SSN in the US).
  - Rule: "use the same address as on your state ID or driver's license, not a business or PO box".
- **Verification [SHOT4:verifying].** A centred spinner around the wordmark with "Verifying info…" while the identity check runs. The outcome screens (pass, manual review, fail) were not captured and are UNKNOWN.
- **Clone mapping.** Phase 3 (P3.1, P3.2, P3.5) in `PLAN.md`. The identity provider is a sandbox adapter, and no real identity checks are run.

### 13.15 Document verification (OBSERVED SHOT5:kyc-intro, kyc-qr)

This step follows §13.14, on the third progress-bar segment.
- **Intro screen:**
  - "Let's get you verified", "It will only take 2 minutes".
  - "What you will need:" with line-art icons for "Government Issued ID" and "Smartphone".
  - A "Get started" button, and a "powered by <third-party verification vendor>" footer.
- **"Continue on your phone":** "Here's how you do it: Scan the QR code below with your phone's camera" above a QR code. This is a cross-device handoff: document and selfie capture happen on the phone, inside the vendor's flow.
- **Desktop waiting screen [SHOT5:kyc-wait]:** "Stay on this page" / "Check back here to complete verification". An animated ID-and-face scanning illustration. Status text "Uploading your documents…". The vendor footer. An ✕ close button top-right, and a pill button "**Exit identity verification**".
- **Clone:** our own sandbox "Parlance Verify". The QR code is generated locally and encodes a single-use, short-lived, session-bound handoff URL. The phone captures the ID front, back and a selfie. Uploads are encrypted at rest and never publicly addressable. A same-device upload fallback is included for accessibility.

### 13.16 Account area (OBSERVED SHOT5:menu, activity, documents, settings-*)

- **Header (signed in):**
  - A trophy icon (leaderboard) and a ☰ menu.
  - A list icon at the start of the category strip opens a category index.
- **☰ menu:**
  - Two round icon buttons: **Leaderboard** and **Rewards**.
  - Items: Account & security, Your activity, Invest, Liquidity Rewards, Documents, API Docs, Settings.
  - Collapsible groups: **Trust ▾**, **Research ▾**, **Kalshi support ▾**.
  - Then "Enter promo code" and "Log out".
- **`/account/*` layout:** content on the left. A right-hand card nav with icons: **Account & security · Your activity · Documents · Settings**.
- **Your activity:**
  - A condensed title with a ⤓ download icon.
  - Filter chips: **All · Deposit · Withdrawal · Order · Trade · Settlement · Credit**.
  - Empty state: an ⃠ icon with "No activity with these filters".
- **Documents:**
  - An explanatory paragraph: realized P&L per year, including fees and credits/rebates, updated monthly, not tax advice. A link to a help-centre taxes page.
  - A table: **Year · PnL with fees · PnL without fees · Transactions ⤓**.
  - An explanation of yearly tax forms (interest, credits/rewards, digital-asset reporting by the crypto partner).
  - Per-year form chips, e.g. "2024: 1099-INT · 1099-MISC".
  - **Clone:** simulated statements, clearly marked "not tax advice".
- **Settings, in page order:**
  1. **"Browse and manage markets by"**: ◉ Payout and odds / ○ Shares and prices, with a live market-card preview (multiplier and % pill vs share prices).
  2. **Connected apps**: "Manage applications you have authorized to access your Kalshi account" (OAuth grants list).
  3. **Notifications ⓘ**: collapsible groups, each type with channel pills **In-app · Email · Push** (filled = on). Only some channels are offered per type.
     - **General:** Transfers (Email, Push); Referral rewards; Referral activity; Market rewards.
     - **Predictions:** Price movement; Market settlement (Email, Push); Order auto-cancellation ⌄; Taker-side trade confirmation ⌄; Maker-side trade confirmation ⌄.
     - **Sports:** Major events ⌄.
     - **Social:** Post alerts, Trade alerts, Position alerts, Likes comments & follows, **Inner Circle requests**, **Inner Circle accepted**, **Group chats** (all In-app, Push); Leaderboard (Push only).
     - **Promotional:** Breaking events, New markets, Politics (In-app, Email, Push); Crypto, Commodities (In-app, Push).
  4. **Marketing text messages**: an opt-in status line, an **SMS marketing disclosure**, a consent checkbox, and "Opt in to marketing texts" / "No thanks". The disclosure covers: consent to automated marketing, security, verification and two-factor texts; consent not a condition of purchase; message frequency and rates; STOP/HELP.
  5. **Security notifications**: a toggle, "Notifications for all sensitive actions on your account".
  6. **Theme**: ◉ System (match device) / Light / Dark. **Accessible colors** toggle, "Best for red-green color blindness".
  7. **Trade mechanics**, all toggles:
     - **Flip sell**: sell more shares than you own to buy the other side.
     - **Auto-sell prompt after buy**: after a fill, offer an automatic sell target.
     - **Skip order review**: place immediately unless a warning or required step needs acknowledgement. This implies an **order review step** by default.
     - **Collateral return**: cash back early for hedged positions; ties to `collateral_return_type:"MECNET"` [HAR4].
     - **Create and respond to "Request for quotes"**: the RFQ opt-in, with a link to the terms.
     - **Advanced shard settings ›**: balance management and **exchange shard transfers**; ties to `exchange_shard` [HAR3/HAR4].
  8. **Market preview price type**: ◉ Last traded price / ○ Current buy price (best Yes/No prices on home and portfolio).
- **Footer:** wordmark and social icons. Columns **PRODUCT** (Pro, Invest, Markets…), **COMPANY** (About, Research, Blog…), **HELP** (Help Center, FAQ, Fee schedule…).

### 13.17 Liquidity Incentive Program (OBSERVED SHOT5:lip; DOC `api-reference/incentive-programs/get-incentives`)

- **Left nav** "PREDICTIONS": All plus categories.
- **Header:** title with a dotted "Terms" link.
- **Region banner:** e.g. "Incentive programs are not available in your region".
- **Stats:** the current month's rewards ("Nov 2026 $0") and "Lifetime rewards $0" with a ⟲ history icon.
- **Tabs:** **ACTIVE · UPCOMING**, with "Search title or ticker".
- **Table:** **Market** (event title · subtitle, "N markets ⌄" expander) · **Start** · **End** (with time zone) · **Competition** (Low/High) · **Reward ↓** (dollar pool, sortable).
- **UNKNOWN:** how rewards accrue (presumably resting liquidity near the mid). Check the public incentives docs before building.

### 13.18 Developer documentation portal (OBSERVED SHOT5:api-docs; DOC `llms.txt`)

- **Header:** wordmark + "API Docs", a search box (Ctrl K) and a theme toggle.
- **Tabs:** **Welcome · Quick Start · Concepts · Predictions APIs · Perps APIs · Changelog**.
- **Hero:** "Welcome to … API Documentation", covering the Exchange API for real-time market data and trade execution, with a **Developer Agreement** link.
- **"The APIs" cards:** **Predictions APIs** (event contracts: REST, WebSocket and **FIX**) and **Perps APIs** (perpetual futures: REST, WebSocket and FIX). Then a "Get started" grid.
- **FIX documentation** covers connectivity, authentication and sessions, order entry, order groups, market data, RFQ and drop copy.

### 13.19 Logged-in account, rewards and Perps data (OBSERVED HAR5)

- **Routes [HAR5 RSC trees and titles]:**
  - `/incentives` ("Liquidity Incentive Program")
  - `/account/taxes` (the Documents page)
  - `/account/profile`
  - `/social/leaderboard`
  - `/perps` (client components `PerpsListClient`, `PerpsRouteShown`) and `/perps/{ticker}` (e.g. `kxbtcperp`, `kxgoldperp`, `kxustech100perp`)
  - `/category/{commodities|economics|financials|mentions|science}`
  - `/sign-up` (onboarding resume)
- **Security-sensitive account endpoints are locked mid-verification.** `GET /v1/users/{user_id}/passkeys`, `/sign_in_methods` and `/api_keys` return **403** `{"error":{"code":"permission_denied","message":"You do not have permission to perform this action","details":"Please make sure you are logged in with the correct account. Contact support if you believe this is an error.","support_action":"support_chat"}}`. The account had not finished identity verification (§13.15).
  - INFERRED: these features require completed verification and/or a fresh step-up.
  - Clone design choice: lock them until KYC is approved, and require step-up.
- **Rewards:**
  - `GET /v1/rewards/new_user_checklist` → `{variant, steps:[{step,status}]×4, revamp_enabled}`.
  - `GET /v1/rewards/referrals/summary` → `{referrer:{referral_code, blocked, address_book_eligible, predictions:{eligible, eligibility_status, total_earned_cents/_dollars, total_credited_referrals, pending, pending_count, completed_count, expired_count, lifetime_cap{amount_cents, number_of_referrals}, current_offer{reward_type, referrer, referee}, referrals[], eligibility_progress{amount_traded_cents, threshold_cents…}}}}`.
  - `GET /v1/users/{user_id}/promotions/perps_new_user_trade_incentive/progress` → `{active, amount_traded_cents, in_progress_tier_key, has_traded_perps}`.
- **Perps access:**
  - `GET /v1/users/{user_id}/margin_waitlist` → `{has_joined, x_share_completed, fcm_application_completed, beta_unlocked, can_start_onboarding}`. This is a waitlist and beta gate; the user shares on X and completes an FCM (futures commission merchant) application.
  - `POST /v1/personalization/rank_margin_tickers` → `{market_ids[8]}`: a personalised Perps ordering.
- **Perps market detail:** `GET /v1/margin/markets/{ticker}` adds `credit_long/short_leverage_estimates`, `long/short_leverage_estimates` by notional, `daily_volatility_bps`, `liquidation_mark_price{price, ts_ms}`, `fractional_trading_enabled`, `bid`/`ask`, `contract_size`. Index feeds come from a CDN (`/NDX`, `/NDX-Hour`, `-Day`, `-Last`). There is a sparkline API at `/api-app/perps/sparkline/{ticker}`.
- **Incentives:** `GET /v1/incentive_programs/?page_size&status&type` → `{incentive_programs:[…]}` (empty in this region; matches the region banner in §13.17).
- **Other:**
  - `/api-app/midterms/senate-map` and `/api-app/fed-funds/outlook`: data widgets for featured hubs.
  - `GET /v1/series/{s}/events/{e}/forecast_history`: event-level forecast series.
  - `GET /v1/live_data/batch?milestone_ids=` → `{live_datas:[{type, details}]}` (§19).

### 13.20 Election hub on results night (OBSERVED SHOT, 2026-11-08, logged out)

Four owner screenshots of `/category/elections/midterms` while votes were being counted. Recorded as structure only: the
page names real candidates, parties and photos, none of which the clone uses (clean room; invented people only). Built as
Phase 7B (PLAN.md), adapted to Nigeria first (§30.0).

- **Shell:**
  - The page sits under the category strip with **Midterms** highlighted.
  - **Left sidebar:** All markets · US Elections · **Midterms** (current) · 2028 · Senate · House · Governor · International elections · Referendums.
  - **Title:** "2026 Midterm Election Predictions".
  - **Tabs:** **OVERVIEW · SENATE · HOUSE · GOVERNOR · STATES · MY BALLOT**, with a "Search states and candidates" box at the right.
- **Control forecast gauges:** two cards, "Senate control forecast" and "House control forecast".
  - A half-circle dial runs from one party's colour to the other's, with a pointer.
  - The centre shows a big percentage (e.g. "100%") and a rating word under it ("Safe Dem").
  - Party labels sit at each end, with party icons.
- **Chamber switch and seat bar:** pills **Senate · House · Governor**, then a seat bar.
  - **Ends:** "56 DEM forecast" on the left and "REP forecast 44" on the right; under them, "47 current" and "53 current".
  - **Centre:** "● LIVE KALSHI MIDTERMS FORECAST".
  - **Segments:** four, shaded from solid to leaning for each side.
- **Results map:** the whole country, with states coloured by party.
  - **Solid** colour = settled; **hatched** = projected or leaning.
  - **Tick** = race called.
  - Some states show a **percentage** instead of a tick (e.g. "AK 97%").
  - Grey = no race.
  - **Small states:** listed in a column at the right, each with a tick.
  - **Hover tooltip:** state badge, "<State> Senate winner?", "98.5% of vote counted"; one row per candidate (photo, name, vote share % and vote count, **Yes**/**No** result); then trading volume ("$192,649 vol").
  - **Watermark:** the brand name sits at the map's corner.
- **Ratings chart (swingometer):** nine columns.
  - Columns: DEM · Safe · Likely · Lean · Toss-up · Lean · Likely · Safe · REP, each headed with a count (e.g. "2 Safe", "0 Likely").
  - The two ends show a party mascot and "20 Settled" / "13 Settled".
  - Races still open are circular state bubbles stacked in their column.
  - Bottom labels give the probability bands: 100% · 90%+ · 75%+ · 60%+ · 50% · 60%+ · 75%+ · 90%+ · 100%.
- **TIMELINE:** a play button and a track with marker dots for past moments, ending at "● LIVE". Scrubbing replays the map, the seat bar and the ratings chart at that time.
- **Featured** (a dropdown title): race cards.
  - **Header:** "<Race> winner?" and "96.9% votes counted · D +0.9" (the margin is underlined, with a tooltip).
  - **Body:** the two leading candidates with photo, name and chance ("99%" / "1%"), a two-colour bar, and each side's vote count.
  - **Other variants:** a party-level card shows party icons instead of photos; a card with no margin shows "· 205,287 votes".
- **"● LIVE AMERICAN POWER INDEX":** one composite number from the platform's markets.
  - **Headline:** "Leaning Democratic +16.3", with "Flat Last 24H" under it.
  - **Blurb:** "The 'S&P' for politics … one number to represent the shifts in political power. Learn more".
  - **Chart:** Feb to Nov, with a scale running "+17 R … Tie … +17 D". The line is red above the tie and blue below, with event dots and a live dot at the end.
- **More markets:** a table with an "N events" count ("34 events") and a Market column.
- **"Midterms Chat":** a floating pill at the bottom right showing the online count ("67K"), opened by a chevron. It is a hub-level chat room (compare event chat, §20).
- **Copy observed:** "Safe Dem", "Settled", "LIVE", "votes counted", "vol", "Yes"/"No", "Flat Last 24H".

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
| Quantities | Fixed-point counts with fractional contracts down to 0.01 (`FixedPointCount` in `margin-rest_risk_get-risk.md`). | Integer units (hundredths of a contract) since Phase 6, emitted as `"2.57"` `fp` strings; fractional per market (§34.5). Originally whole contracts. |
| Display terms | `PERPS_DISPLAY_TERMS = {marginRequirement:"Cost", positionEquity:"Position value", notionalExposure:"Total size"}` (chunks `36qdzse90bk1i.js`, `3x09fsrfwgctp.js`). Leverage is shown as `"10x"` (`formatLeverage`) and the funding rate as a percent with 4 dp (`formatFundingRate`), both in chunk `0b-vmmhwqitt_.js`. | Ticket rows: Contracts, Total size, Cost (margin), Est. fees, Est. liq. price. The positions table has a Position value column. |

### 14.2 Prices: last, index (reference) and mark

- `price` is the last trade. `reference_price` is the underlying index scaled per contract. `settlement_mark_price` is used for settlement and funding, and `liquidation_mark_price` for liquidation (`margin-rest_market_get-market.md`, `margin-ws_websockets_market-ticker.md`). The docs name third-party index sources, which Parlance does not use.
- **UNKNOWN**: the formula for the mark price. **Design:** both marks equal the reference price (index × contract size, rounded to the tick).
- **Design:** the index is a deterministic simulation. It is a geometric random walk with mean reversion toward an anchor, uses a per-market daily volatility, and draws from a seeded PRNG whose state is persisted in `perp_markets`. It advances on the engine tick and is persisted every tick. Mark prices go into `perp_price_history` as 1-minute OHLC bars. Seeding adds 7 days of 15-minute bars, 2 hours of 1-minute bars, a 24-hour public trade tape, and past funding rates.
- Admin and test hook: `POST /v1/perps/admin/markets/:ticker/index {price, freeze}` (also `engine.perps.setIndex`) pins the index. Pinning resets the funding premium window.

### 14.3 Margin, leverage, liquidation

- Initial margin = maintenance margin × `initial_margin_multiplier` (`margin-rest_risk_get-risk-parameters.md`). Liquidation happens at a margin ratio threshold (`liquidation_margin_ratio_threshold`), and there is also a queue-entry threshold.
- Docs leverage is 1 ÷ margin rate and falls as notional grows (`leverage_estimates` keyed 1k…1M in `margin-rest_market_get-market.md`). Live values are about 2x–15x **[live]**.
- **UNKNOWN**: the real maintenance-margin model. The docs describe scenario matrices (hvar/apc/aug/funding), market-impact liquidation configs, and subgroups that share margin (`api-reference_get-maintenance-margin-metadata.md`). **Design:** tier 1 of each market's size tiers has initial margin rate = 1 ÷ `max_leverage` and maintenance rate = initial rate ÷ 2 (multiplier 2), so BTC at 20x max gives 5% initial and 2.5% maintenance; since Phase 6 the requirements rise with notional through bracketed size tiers, leverage limits scale with size, and the last tier caps the position (§34.4).
- Docs have both cross and isolated margin: `SubaccountType` is `cross | isolated | auto_rebalance`, and the exit-trigger endpoints exist in both cross and isolated variants (`margin-rest_portfolio_get-balance.md`, `margin-rest_exit-triggers_*`). **Design:** subaccounts (0 = primary) are `isolated` (margin per (user, subaccount, market)) or `cross` (portfolio maintenance margin, §34.1, §34.4), reported in `subaccount`, `subaccount_type` and `is_portfolio`. The user picks leverage from 1x up to the maximum at the position's size. Cost = notional ÷ leverage is moved from the subaccount's free collateral into the position's margin.
- Position equity = margin + unrealized PnL, with unrealized PnL = qty × (mark − entry), signed. Maintenance requirement = |qty| × mark × maintenance rate.
- Liquidation price, with long and short both written in terms of |q|:
  - long: (|q|·E − M) ÷ (|q|·(1 − r))
  - short: (M + |q|·E) ÷ (|q|·(1 + r))
- **Liquidation (design):** each tick, any isolated position whose equity is below its (tiered) maintenance margin is closed in full at the liquidation mark; cross subaccounts liquidate on their portfolio maintenance margin, largest requirement first (§34.4). The liquidity account takes over the position.
  - Remaining equity minus a liquidation fee goes back to available. The fee is the smaller of the remaining equity and ½ × maintenance margin; it goes to the insurance fund.
  - A shortfall is paid by the insurance fund, then the backstop (journaled, §34.6; the `perp_meta` tally is kept). An isolated loss never draws on other collateral.
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
- Amend, decrease, order groups and subaccounts are built in §34.1–§34.2. Not built: batch endpoints (`margin.md` says batch is not available on margin anyway), `market_version`, `expiration_time`.

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
- Clone: `PUT|DELETE /v1/perps/positions/:ticker/exit_trigger`, `GET /v1/perps/exit_triggers`. Brackets and, since Phase 6, trailing stops tracked on the server (§34.3); order-anchored triggers are not built.
- **Design:** take profit and stop loss must sit on the profitable or protective side of the current mark.
- When a leg fires, the clone sends a reduce-only market order (`source=exit_trigger`), sets the trigger to `filled` with its `triggered_leg`, and sends a `perp_exit_trigger` notification. Closing or flipping the position cancels the trigger with the matching reason.

### 14.9 Transfers between Predictions cash and Perps collateral

- Docs: `POST /portfolio/intra_exchange_instance_transfer` with `source` and `destination` in `event_contract|margined`, an `amount` in **centicents**, and an optional `client_transfer_id` (a duplicate returns 409). The docs say it is processed asynchronously and is "not yet available" in production (`margin-rest_portfolio_intra-account-transfer.md`, `margin.md`). The bundle tracks perps cash apart from predictions cash (`account_equity` checks in chunk `3gq1uugohtlk0.js`) and has a `margin_transfer_completed` notification (chunk `0b-vmmhwqitt_.js`).
- Clone: `POST /v1/perps/transfers` accepts either `{direction: to_perps|to_predictions, amount_dollars}` or the docs shape, and an optional `subaccount` (default 0). Transfers are whole cents and complete synchronously. Moves between subaccounts use `POST /v1/perps/subaccounts/transfers` (§34.1).
- Prediction cash moves through `engine.credit(uid, ±cents, 'perps_transfer', …)`, so the existing ledger and `user_balance` WS events stay consistent.
- Each transfer writes `perp_transfers` and `perp_ledger` rows, posts the perps journal (`perps:bridge`, §34.6) and sends a notification. `GET /v1/perps/enabled` mirrors `/margin/enabled` (`margin-rest_exchange_get-enabled-status.md`); it is true for any signed-in user.

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

The engine owns these SQLite tables, created with `CREATE TABLE IF NOT EXISTS`: `perp_markets` (config and simulation state), `perp_price_history`, `perp_accounts`, `perp_orders`, `perp_trades`, `perp_fills`, `perp_positions`, `perp_funding_rates`, `perp_funding_payments`, `perp_liquidations`, `perp_exit_triggers`, `perp_transfers`, `perp_ledger`, and `perp_meta`; Phase 6 adds the tables of §34.10 (forward-only migrations: additive columns, a one-time units migration and a one-time rebuild of `perp_positions` keyed by subaccount). The only in-memory state is throttle timestamps, such as the last ticker emit and the last re-quote. Seeding is idempotent per ticker. `perps.e2e.test.js` restarts the server twice and checks that positions, collateral, the pinned simulation, history, triggers, liquidations, funding and transfers all survive.

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
  - The wordmark "Parlance" uses its own brand green (Nigerian green, #008751); the featured hub "Harbor 2026" is coral.
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
  - **Hover readout** (OBSERVED, owner screenshot 2026-11-08, a soccer match chart; built on every price chart in `public/js/chart-hover.js`):
    - **Follows the pointer:** a vertical line with the time above it ("1:01 PM"; with the date when the range is over 36 h) and a dot on each line.
    - **Legend:** beside the line, one row per outcome with the name in small caps over a big condensed value in its colour ("LAZ 57.5%", "TIE 23.2%", "NAP 19.9%"), ordered as the lines are, top first. Each value is that series' last point at or before the moment.
    - **Placement:** the legend flips to the left of the line near the right edge. The end labels give way while it shows, and everything hides when the pointer leaves.
    - **Other inputs:**
      - **touch:** a tap or a horizontal drag shows it; a tap elsewhere hides it;
      - **keyboard:** the chart is focusable; ← / → step through points, Home / End jump, Escape hides; the values are announced to screen readers.
    - **Charts:** event, home and hub forecast charts, plus the Perps mark chart (one row, a naira price).
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
| C1 | Sub-cent amounts | Integer cents; taker ceil / maker remainder; fee ceil per order through the accumulator since §28.3 (G1) |
| C2 | Fractional markets | All seeded markets except PLXSTATE; combos and rolling markets on (§16.3) |
| C3 | Combo ticker | sha256 of the sorted legs (§17.1) |
| C4 | Leg limits | 2–6 legs, distinct events, active non-combo non-rolling markets |
| C5 | Combo price grid | `center_deci_edge_centi_cent` since §28.8 (G12) |
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
  - **Reversal after settlement** goes through the settlement correction of §28.7 (claw-back through the ledger, debt rule, step-up, optional two-person rule). The reverse action itself still returns `409 already_settled` on a settled market. The settlement delay remains the review window for a reversal without money moving.
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

**Perps ops** update `perp_markets.status` (`halted`/`active`); the perps engine rejects orders on non-active markets and skips them in its tick. Max leverage goes through `engine.perps.setMaxLeverage()`, which rescales the market's size tiers so tier 1 matches (§34.4). "Run funding" calls the exported `engine.perps.runFunding()`. Since Phase 6 the page also holds margin tiers, risk limits, APY, the waitlist, referral settings and the perps journal check (§34.10).

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

## 21. Perimeter security

Status 2026-11-03 · PLAN Phase 1A (P1.1, P1.2, P1.3, P1.10, P1.11, P1.12, gaps G7 and G13) · branch `phase-1-security`.
Evidence ids (S1–S12) are the observations in `PLAN.md` §2. **HAR4** is the sanitised logged-in capture `evidence/web_loggedin_2026-11-03.har` (13 API entries; each lists `_present_security_headers`). Everything else is a Parlance design choice, stated as such.
Tests: `clone/tests/security-perimeter.e2e.test.js` (12 browser + HTTP tests, run against the production bundle).

### 21.1 Where the controls sit

| Order | Stage | File | What it does |
|---|---|---|---|
| 1 | `security.early` | `server/security.js` | Per-response CSP nonce and security headers; CORS; `robots.txt`; honeypots; `POST /v1/csp-report`; `POST /v1/bot/challenge`; `POST /v1/client_token`. Runs before body parsing and before the session / CSRF middleware, so these endpoints never need a session or CSRF token. |
| 2 | session + CSRF | `server/auth.js` (Phase 1B) | `req.auth`, session CSRF, login CSRF. |
| 3 | `security.apiGuard` | `server/security.js` → `server/bot.js` | Tiered rate limits on `/v1` and `/trade-api`; signed client token on every `/v1` write and every `/v1/users/*` request. |
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

**Signed client token** (S2: `x-aws-waf-token` on API calls, `AwsWafTokenForWebSocket`). Every page the server renders carries a signed boot proof (10 min, bound to IP+UA). A challenged client only gets one after passing. After load, `public/js/security.js` posts it to `/v1/client_token` and receives `{token, expires_in}`: HMAC-signed `{issued, expires, binding}`, 15 min by default, also set as an HttpOnly SameSite=Strict `plx_ct` cookie. The SPA sends it as `X-Client-Token` on **every `/v1` request, reads included** (`api.js`, admin `ui.js`), as `ct=` on the WebSocket URL (`ws.js`), and refreshes it at half-life using the current token. Expired tokens can be exchanged for 12 h, so a sleeping laptop recovers. A 403 `client_token_*` triggers one silent refresh and retry.

Sending versus enforcing follows HAR4:
- The observed client attaches `x-aws-waf-token` to all 13 API requests, including cached public reads (`/v1/cached/series/…`, `/v1/milestones/{id}/volume`).
- It attaches `x-csrf-token` to credentialed `/v1` calls, GETs and POSTs alike (`/v1/social/trades`, `/v1/events/`, `/v1/series/`, `POST /v1/users/{id}/metrics/client_event`), but not to cached reads.
- Plain unauthenticated public reads (`/v1/live_data/count`, `/trade-api/v2/exchange/status`) answer 200 with no token at all.

So the server requires a valid token (header, else cookie; 403 `client_token_required` / `client_token_invalid`) on:
- every `/v1` POST/PUT/PATCH/DELETE;
- every request under `/v1/users/*` (authenticated reads such as balance, orders, positions, history and CSV exports — a signed-in session does not replace it);
- the WebSocket upgrade.

Public unauthenticated reads (`/v1` market, social, live-data and BFF reads, `/v1/session`, and all of `/trade-api/v2/*`) stay open, so third-party API clients and cached reads keep working. The WebSocket upgrade requires an allowed `Origin` (if one is sent; this also blocks cross-site WebSocket hijacking) and a valid token, else `HTTP 403` before the handshake. Rejections are logged (`client_token_rejected`, `ws_rejected`).

**Honeypots** (P1.10/P1.12): any dot-segment except `/.well-known/` (`/.env*`, `/.git/*`, `/.DS_Store` …), `/wp-admin`, `/wp-login.php`, `/xmlrpc`, `/phpmyadmin`, `/cgi-bin`, `/actuator`; `/server/`, `/data/`, `/node_modules/`, `/scripts/`, `/tests/`, `/dist/`; `package(-lock).json`, `secret.key`, config files; extensions `.map .sqlite .db .db-wal .sql .bak .env .key .pem .log .php …`. Paths are percent-decoded first (`/%2e%65nv` is caught). The response is a plain-text 404 (never the SPA page) and a `honeypot` event. Choice: S1 answers these with the challenge; the brief asks for 404.

**`robots.txt`**: disallows 20 AI training / answer-engine crawlers (GPTBot, ClaudeBot, CCBot, Google-Extended, PerplexityBot …) and keeps `/v1/`, `/trade-api/`, `/admin`, `/account`, `/portfolio` out for everyone. It states in the file that it is **advisory only**: well-behaved crawlers honour it, and enforcement is the challenge, tokens and rate limits.

**Tiered rate limits** (replaces the single per-IP bucket; 429 `too_many_requests` with `Retry-After`, spec §5.4 envelope unchanged):

| Tier | Key | Default | Applies to |
|---|---|---|---|
| anonymous | IP | `RATE_BURST` / `RATE_PER_SEC` (300 / 150 s⁻¹) | `/v1` + `/trade-api` without a session; the client-token bootstrap |
| user | account | 2× anonymous | signed-in requests |
| admin | account | 5× anonymous | staff (admin flag or any admin role) |
| auth | IP | 60 burst, 1 s⁻¹ | Credential routes of CLONE_SPEC §22.11: every `/v1/auth/*` (login CSRF, first-admin setup, forced password change), `/v1/step_up`, `/v1/log_in`, `/v1/log_in_mfa`, `POST /v1/users` (sign-up), `/v1/users/:uid/password`, plus the bot-challenge verify; on top of the tier |
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

Served: `/assets/*.{js,css,woff2}` (dist), or `/js/**/*.js`, the root `*.css` files that exist and `/fonts/*.woff2` (dev); `/fonts/*.txt` (licences); `/robots.txt`; the PWA files `/manifest.webmanifest`, `/sw.js`, `/offline.html` and `/icons/*.{png,svg}` (§31). The SPA page is served only for GET/HEAD on extension-less paths with no dot-segment, outside `/v1` and `/trade-api`. Anything else (`/foo.png`, `/index.html`, `/manifest.json`, `/markets/x/y/z.json`) is a plain 404. `dotfiles: 'deny'` and `redirect: false` on every static mount.

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
7. Client token: the HAR4 split (public `/v1` and `/trade-api/v2` reads 200 without a token; `/v1/users/*` reads 403 without one, even with a session); missing / forged / tampered / foreign-UA / expired → 403 on writes; WS refused without a token, with a forged or expired token, or with a foreign Origin; an expired token is refreshed; a bad bootstrap is refused; the SPA sends the header on every `/v1` read and write, the `ct` URL parameter and the cookie.
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

---

## 22. Identity, sessions and login security

Phase 1B of `PLAN.md` (P1.4 sessions, P1.5 login hardening, P1.6 step-up verification, P1.14 auth security log and
hash-chained audit, P1.15 encryption of secret columns, gap G4). Code: `clone/server/auth.js` (sessions, login CSRF,
throttling, step-up, routes, first-admin bootstrap), `clone/server/passwords.js` (hashing + policy),
`clone/server/common-passwords.txt` (bundled breached list), `clone/server/crypto.js` (shared key + AES-GCM helper),
`clone/server/audit-chain.js` (tamper-evident admin audit), `clone/server/create-admin.js` (CLI). UI:
`public/js/views/auth.js`, Account › Security in `public/js/views/account.js`, `public/js/views/stepup.js` (modal),
Admin › Sign-in & audit integrity in `public/js/views/admin/identity.js`. Tests: `clone/tests/auth-security.e2e.test.js`.

### 22.1 Evidence (what Kalshi does) and what stays unknown

| # | Observation | Evidence | Clone |
|---|---|---|---|
| S7 | The web client sends credentials with every API call (`withCredentials`) and a CSRF token in a dedicated header (`xsrfHeaderName: CSRF_HEADER_NAME`, sent as `x-csrf-token`), kept in `csrfToken` storage; the API exposes `X-Csrf-Token` to the browser. | JS26:0lt3ma0qstivi (REA `ev_51dfbee8…`); preflight capture 2026-11-03 (PLAN §2 S4) | Session CSRF unchanged (header on every write, compared in constant time). New: **login CSRF** for the pre-session endpoints; rotated tokens are returned in an `X-Csrf-Token` response header that the client stores (§22.2). |
| S8 | Unauthenticated requests get `401 token_authentication_failure` with no detail about the resource. | capture 2026-11-03 | Kept. Login failures are uniform: `401 invalid_credentials "incorrect email or password"` for unknown email and wrong password alike (§22.3). |
| S9 | Strong customer authentication: passkeys (`/passkeys/registration`, `/passkeys/authentication`), a 4-digit MFA login code, an `action_verification_mfa` step for sensitive actions, and an `enableWithdrawalMfa` account setting. | JS26:3pds_3l0ju6me, 0bszqignr8pgk; api_callsites | Step-up verification with a `step_up_required` error and modal (§22.6); withdrawal two-factor setting (§22.6). The clone's MFA is TOTP (6 digits, authenticator app) because it needs no SMS/email provider (U20 stays UNKNOWN: Kalshi's code is 4 digits, channel not observed). Passkeys are P3.4. |

Not observable from outside (PLAN §2 last paragraph): Kalshi's session lifetime, idle timeout, lockout thresholds,
password policy, hashing, admin tooling and audit-log design. Every value below is a **design choice** for the clone,
recorded with its rationale.

### 22.2 Sessions (P1.4)

- **Cookie.** `__Host-plx_session` with `Path=/; HttpOnly; Secure; SameSite=Lax` when served over HTTPS or with
  `NODE_ENV=production` / `SECURE_COOKIES=1` (behind a TLS-terminating proxy). Browsers only accept a `__Host-` cookie
  with `Secure`, which they refuse to set over plain `http://localhost`, so local development uses the unprefixed name
  `plx_session` with the same attributes minus `Secure`. Both names are accepted on read. Accounts with any admin role
  get `SameSite=Strict` (PLAN P1.4); the SPA's own requests are same-site, so this only stops cross-site navigations
  from carrying the admin cookie. `Max-Age` equals the absolute lifetime.
- **Hashed tokens.** The 256-bit cookie token is never stored: `sessions.token` holds its SHA-256. A leaked database
  therefore yields no usable session. Each row also has a public id `sid` (`ses_…`) used for the device list,
  revocation and WebSocket binding. Rows written by earlier builds (plaintext tokens) are hashed in place on start-up,
  idempotently (`token_hashed` flag), so existing cookies keep working.
- **Lifetimes.** Absolute 30 days from sign-in (`expires_at`, unchanged column). Sliding idle timeout: **30 minutes for
  any account with an admin role, 7 days otherwise** (`idle_ms` stored per session at creation; `last_seen_ms` refreshed
  at most every `min(30 s, idle/10)`). An expired session is deleted when next seen and logged as `session_expired`.
  Any authenticated HTTP request counts as activity, including an open tab's background polls; a closed or idle tab
  expires.
- **Rotation.** A new token is issued: on **log in / sign-up / MFA completion / admin setup** (a brand-new session; the
  session the request arrived with is deleted first, so a planted cookie can never be upgraded — fixation defence); on
  **turning two-factor on** and **password change** (same `sid` and device entry, new token and CSRF token); on a
  **privilege change** — the target's sessions are all revoked (they sign in again with the new rights), and an admin
  changing their own roles gets a rotated session while their other sessions are revoked.
- **Metadata.** Created, last seen, IP *prefix* (IPv4 /24, IPv6 /48; full addresses are never stored) and a user-agent
  *summary* ("Chrome on Linux"; the raw string is not stored).
- **Account › Security** lists signed-in devices (this device marked) with "Sign out device" per row and **"Sign out
  everywhere"** (all sessions including this one). Revocation is live: the WebSocket hub closes the revoked sessions'
  sockets with code **4401** after a `session_revoked` frame, and the client then re-checks `/v1/session` and drops to the
  signed-out state. The hub also re-validates every socket's session on its 15 s keep-alive tick, so idle/absolute
  expiry, account locks and admin-side deletions end private channels too.
- **WebSocket upgrade** uses exactly the HTTP validity rules (hashed token, idle + absolute expiry, account lock) plus
  the existing `csrfToken` query check (spec §7.2).
- **Login CSRF.** `GET /v1/auth/csrf` sets a short-lived (60 min) `HttpOnly` cookie `plx_pre` (`__Host-plx_pre` over
  HTTPS) holding `<nonce>.<expiry>` and returns `csrf_token = HMAC-SHA256(login-csrf key, cookie value)`. `POST
  /v1/log_in`, `/v1/users`, `/v1/log_in_mfa`, `/v1/auth/setup_admin` and `/v1/auth/complete_password_change` require
  that token in `x-csrf-token`; otherwise `403 forbidden "missing or invalid login csrf token"`. A cross-site page can
  neither read the token nor set the cookie, so it cannot sign a victim into an attacker's account. The client fetches
  a fresh token before every sign-in/sign-up. The session CSRF token (per session, returned at sign-in and by
  `/v1/session`) still guards every other write.

### 22.3 Login hardening (P1.5)

- **Uniform failures.** Unknown email and wrong password return the same status, body and headers, and both cost one
  scrypt evaluation (unknown emails are checked against a precomputed dummy hash with the current parameters). Unknown
  emails are logged only in masked form (`g***@example.test`).
- **Backoff and lockout (persisted in `auth_throttle`).** Two counters per attempt: the account key
  (`acct:` + SHA-256 of the normalised email — the same for existing and non-existing accounts, so behaviour reveals
  nothing) and the client IP. From the 5th failure on an account (20th from one IP) within 60 minutes, sign-in is refused
  for 30 s, doubling with every further failure up to 15 minutes. While locked, every attempt — even with the right
  password — gets `429 too_many_attempts` with `retry_after_sec`; the UI shows "Too many sign-in attempts. Try again in
  N seconds." A success clears the account counter (the IP counter only decays, so a success on an attacker's own
  account cannot reset it). Failed step-up and password-change checks and wrong MFA codes count as well.
- **Notification.** The first lockout of an existing account sends an in-app security notification and an email
  (stub: a row in `email_outbox`, listed in Admin › Sign-in & audit integrity; no mail is sent) and logs `lockout`.
### 22.4 Password policy and password management (P1.5)

- **Password policy** (sign-up, password change, forced change, admin setup, `ADMIN_PASSWORD`, `create-admin`): at least
  12 and at most 128 characters; at least two of lowercase / uppercase / digits / symbols; not one repeated character;
  must not contain the email address, its local part or any ≥4-character part of the email or display name; must not be
  a known breached password. The breached check uses `server/common-passwords.txt` — 451 SHA-1 hashes (HIBP
  "Pwned Passwords" style, no network) of the most common breached passwords and their usual long variants — and also
  tests the de-leeted form (`P@ssw0rd` → `password`) and the alphabetic core (`Summer2025!!` → `summer`). Messages name
  the rule that failed ("Password must be at least 12 characters.", "…appears in lists of breached passwords…"). Login
  never applies the policy, so older accounts can still sign in.
- **Hashing.** scrypt with the parameters stored in every hash: `scrypt2$N$r$p$salt$key`. Default N = 2^16, r = 8,
  p = 1 (64 MiB, 4× the first build's N = 2^14); `SCRYPT_LOG_N` (14–20) raises it where hardware allows (OWASP's
  reference is N = 2^17). Hashing runs on the libuv pool (`crypto.scrypt`), not the event loop. A successful login with
  the legacy `scrypt$salt$key` format or weaker parameters is transparently re-hashed (`password_rehash` event).
- **Password change** (`PUT /v1/users/:uid/password`): requires the current password **and** step-up; rotates this
  session and signs out all other sessions; alerts the user.
- **Admin-forced reset** (`POST /v1/admin/users/:id/force_password_reset`, permission `users.support`, reason
  required, step-up): sets `must_change_password`, signs the account out everywhere, audits and alerts. At the next
  sign-in (after the password and, if on, the TOTP code) no session is issued; the response is
  `{password_change_required, change_token}` (15-minute single-use token, stored hashed) and the UI asks for a new
  password, then signs in. (A reset-by-email link is P3.1.)
### 22.5 First admin and demo accounts (P1.5: no default admin password)

- **No default admin password.** The seed no longer creates `admin@parlance.local`. The first admin comes from, in
  order: `start({ admin: { email, password } })` or `ADMIN_EMAIL` + `ADMIN_PASSWORD` on start (policy-checked; a weak
  password refuses to start; never overwrites an existing usable password); `npm run create-admin` (interactive prompt
  with hidden input, or the same env vars; run while the server is stopped); or, when no admin can sign in, a
  **one-time setup URL** printed to the console (`/setup?token=…`, single use, 60 minutes, stored hashed; a restart
  invalidates the previous link). Databases from earlier builds: if `admin@parlance.local` still has the old
  `parlance-admin` password it is disabled at start-up (`!default-password-removed`), so that password no longer works
  and the setup link appears. All three paths log `admin_bootstrap` and append an `admin.bootstrap` audit row.
- **Demo accounts.** `maple_quant@`, `harborwatch@`, `rainmaker@parlance.local` keep working in the dev seed with a
  **generated password printed once** at seed time (`Demo-…-NN`), or the value of `DEMO_PASSWORD` /
  `start({ demoPassword })` (tests). Old databases where they still have `parlance-demo` get a new password the same
  way. Choice: keeping them usable keeps the social/moderation demo working, and a per-install random password removes
  the shared default.

### 22.6 Step-up verification (P1.6)

- Sensitive actions require a password or TOTP check within the last **10 minutes** (a sign-in counts). Otherwise the
  server answers `403 {error: {code: "step_up_required", message, details, methods: ["password","totp"] | ["password"] |
  ["totp"], action}}`. `POST /v1/step_up {password} | {code}` records the check on the session (`auth_at`, and
  `totp_at` for codes); failures count toward the lockout counters and are logged.
- Guarded, in one central list in `auth.js`: two-factor off, password change, email change, the withdrawal two-factor
  setting, withdrawals, deposits and perps transfers above **$10,000**, admin role changes and admin-forced password
  resets. API-key creation joins the list when keys exist (P7.1).
- **Client.** `api.request()` (and the admin toolkit's `call()`) catches `step_up_required`, opens the "Confirm it's
  you" modal (password, or the 6-digit code, with a switch when both are allowed), calls `/v1/step_up`, and retries the
  original request once. Cancel rejects with `step_up_cancelled`, and the action is not performed.
- **Withdrawal two-factor** (mirrors `enableWithdrawalMfa`): an Account › Security toggle, available once two-factor
  login is on (changing it needs step-up; turning two-factor off clears it). When on, **every** withdrawal needs a fresh
  TOTP code (`methods: ["totp"]`; a password does not satisfy it, and a successful withdrawal consumes the
  verification).

### 22.7 Tamper-evident admin audit log

Every `admin_audit` row (admin panel, chat moderation, admin bootstrap, CLI) is appended through
`audit-chain.js`: `chain_seq` (1, 2, 3, …), `prev_hash` (the previous row's hash; 64 zeros for the first) and
`hash = HMAC-SHA256(audit-chain key, [chain_seq, all row fields, prev_hash])`. The newest row is also recorded as a
MAC-protected chain head in `meta`. `GET /v1/admin/audit/verify` (`audit.read`) recomputes the chain and reports the
first problem: an edited row ("row contents do not match its hash"), a broken link, a gap, a row without a hash, or
deleted newest rows. The Admin page's **Verify audit chain** button shows "Chain intact · N entries verified" or
"Tampering detected at entry #n: …". The key matters: a bare hash chain could be recomputed by anyone with write access
to the database; an HMAC chain cannot without the server key. Rows written before chaining existed are sealed once at
start-up, but only those after the last chained row, so a hash cleared in the middle of the chain is reported, not
silently re-chained.

### 22.8 Encryption at rest (P1.15)

- `server/crypto.js` (shared with the perimeter work): one 32-byte master key from `SECRET_KEY`, else `SECRET_KEY_FILE`,
  else `secret.key` next to the database (created with mode 0600, never overwritten; git-ignored and in the `.claude`
  deny rules). Purpose-specific sub-keys via HKDF-SHA256 (`field-encryption:v1`, `login-csrf:v1`, `audit-chain:v1`).
- **TOTP secrets** (`mfa.secret`) are stored as `enc:v1:<iv>.<tag>.<ciphertext>` (AES-256-GCM, 96-bit random IV) with
  additional data `mfa.secret:<user id>`, so a ciphertext copied to another user's row does not decrypt. Plaintext rows
  from earlier builds are encrypted in place on start-up (idempotent). MFA challenge tokens, setup and password-change
  tokens and session tokens are stored as SHA-256 hashes. No other secret columns exist today (the CSRF token per session
  is only useful together with the session cookie).
- Key rotation is not implemented: changing the key makes existing TOTP enrolments unreadable (users re-enrol) and the
  audit chain unverifiable from the old rows. Recorded as a residual risk.

### 22.9 Security log (P1.14)

`auth_events` (persisted; 400-day retention): `signup`, `login_ok`, `login_fail`, `lockout` (account or IP),
`logout`, `mfa_on`, `mfa_off`, `mfa_fail`, `step_up`, `step_up_fail`, `password_change`, `password_change_fail`,
`password_change_required`, `password_reset_forced`, `password_rehash`, `email_change`, `withdrawal_mfa_on/off`,
`session_revoke`, `sessions_revoke_all`, `sessions_revoked` (privilege change), `session_expired`, `admin_bootstrap`,
`default_password_removed`. Each row: time, user (or none, with a masked email), IP prefix, device summary, JSON detail.
Users see their own in **Account › Security › Security activity** (`GET /v1/users/:uid/security_events`); staff with
`audit.read` see everyone's in **Admin › Sign-in & audit integrity** (`GET /v1/admin/identity/events`, filter by type
prefix and email), next to the email outbox stub (`GET /v1/admin/identity/outbox`, `users.support`).

### 22.10 G4 — maker trading limit on RFQ confirm

`confirmQuote()` now applies the maker's daily trading limit to the order the confirmation creates (maker bid ×
size, `trading_limit_exceeded`, nothing executes, the quote stays accepted until it lapses), matching the taker-side
check on accept.

### 22.11 API summary

| Method + path | Auth | Notes |
|---|---|---|
| `GET /v1/auth/csrf` | none | login-CSRF cookie + token |
| `POST /v1/users`, `/v1/log_in`, `/v1/log_in_mfa` | login CSRF | sign-up / sign-in; `{mfa_required, mfa_token}`, `{password_change_required, change_token}` or `{user, csrf_token}` |
| `POST /v1/auth/complete_password_change` | login CSRF | after an admin-forced reset |
| `GET /v1/auth/setup?token=`, `POST /v1/auth/setup_admin` | login CSRF (POST) | one-time first-admin setup |
| `POST /v1/log_out` | session | deletes this session |
| `POST /v1/step_up` | session | `{password}` or `{code}` |
| `GET /v1/users/:uid/security` | session | MFA / withdrawal-MFA state, step-up window, idle timeout, policy |
| `GET /v1/users/:uid/sessions`, `DELETE …/sessions/:sid`, `DELETE …/sessions` | session | devices, sign out one, sign out everywhere |
| `GET /v1/users/:uid/security_events` | session | own security activity |
| `PUT /v1/users/:uid/password`, `PUT …/email`, `PUT …/withdrawal_mfa` | session + step-up | |
| `GET/POST /v1/users/:uid/mfa[/setup|/enable|/disable]` | session (disable: + step-up) | moved from `features.js`; secrets encrypted |
| `GET /v1/admin/identity/events`, `GET /v1/admin/audit/verify` | `audit.read` | |
| `GET /v1/admin/identity/outbox`, `POST /v1/admin/users/:id/force_password_reset` | `users.support` (+ step-up) | `:id` may be an email |

Start options (`server/index.js`): `admin`, `demoPassword`, `auth: { idleMs, adminIdleMs, absoluteMs, stepUpMs,
accountThreshold, ipThreshold, baseLockMs, maxLockMs, failureWindowMs, largeDepositCents, largeTransferCents,
secureCookies, … }` (defaults in `auth.js`), `quiet`; the result includes `setupUrl` / `setupPath`.

### 22.12 Tests (`clone/tests/auth-security.e2e.test.js`, 13 browser tests)

Weak / single-class / name-containing / breached passwords refused with their messages; hash format stores cost
parameters; session token only as SHA-256 in the DB; login rotation; login CSRF missing / bogus / from another browser
→ 403 on all pre-session endpoints; unknown-email vs wrong-password responses byte-identical with similar timing;
account and unknown-email lockout, UI message, owner notification + email stub + event, doubling lock, unlock after
cool-down; device list, sign out one device (the other browser drops to signed-out live), sign out everywhere; MFA-on
rotation (new cookie and CSRF, same device); step-up modal for password change (wrong then right password) and
two-factor off (via code), cancel leaves an email change undone; withdrawal two-factor (code only, per withdrawal,
cancel withdraws nothing); TOTP secret encrypted and key file 0600; maker trading limit on RFQ confirm (G4); privilege
change revokes the target's sessions, admin role change needs step-up, admin sessions are Strict/30-minute; forced
password reset with step-up modal and new-password flow; audit chain intact → edited row detected at #1 → restored →
deleted tail detected; first admin via setup URL (single use, 410 on reuse, weak password refused), legacy
`parlance-admin` disabled, `ADMIN_EMAIL`/`ADMIN_PASSWORD` (weak refuses to start); restart keeps hashed sessions,
failure counters, events, encrypted TOTP (plaintext rows migrate and still verify); idle timeout; per-IP lock.

### 22.13 Residual risks and follow-ups

- **Account lockout as denial of service.** Anyone who knows an email can keep it locked for up to 15 minutes at a time;
  the doubling caps the cost to the victim but does not remove it. A CAPTCHA/proof-of-work step (the perimeter
  challenge) instead of a hard lock for the account key is the next step.
- **Admin lock disclosure.** The admin module refuses `POST /v1/log_in` for an admin-locked account with
  `account_locked` before the password is checked (pre-existing behaviour kept for its tests), which reveals that a
  locked account exists.
- **TOTP replay.** A code may be reused within its 30-second window (no last-used-step record); rate limits and the
  challenge attempt cap bound the risk.
- **Idle timeout and background polling.** An open tab keeps a session alive through its polls; only a closed or idle
  tab expires. Distinguishing user activity from polls is not done.
- **Forced reset still trusts the old password once** to reach the "choose a new password" step; a reset-by-email link
  (P3.1) is needed when the old password itself is compromised.
- **No key rotation** for `secret.key` (§22.8); **truncation** of the audit table together with the `meta` head row is
  only detectable against an external copy of the head (e.g. shipped to logs, P9.4).
- **Email delivery is a stub** (`email_outbox`); SMTP is P3.1. Passkeys / WebAuthn are P3.4.
- The scrypt default (N = 2^16) is below OWASP's N = 2^17 reference for latency on small hosts; raise `SCRYPT_LOG_N` in
  production.

---

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
| **secrets** | gitleaks 8.30.1 (pinned) over the **full history** (`fetch-depth: 0`) with `.gitleaks.toml`: a secret removed in a later commit is still a leak. | any finding |
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

`.gitleaks.toml` extends the default gitleaks rules and relaxes only `generic-api-key` under `clone/tests/` (throwaway
account passwords in E2E fixtures, e.g. the one gitleaks flagged in `auth-security.e2e.test.js`); every token-format rule
still applies to tests. The bundled scanner applies the same exception to its generic rule.

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
  or patterns (e.g. `client_order_id` ≤ 64 chars, `client_transfer_id` `[A-Za-z0-9_.:-]{1,64}`, `time_in_force` one of
  `gtc`, `ioc`, `fok`, `good_till_canceled`, `immediate_or_cancel`, `fill_or_kill` — the spellings the handlers accept). Money routes
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

---

## 24. Social and community completion

Status 2026-11-03 · PLAN Phase 2 (P2.1–P2.4), §11 A6 (notification matrix) and A11 (Inner Circle, Group chats, position
alerts, likes/comments/follows, leaderboard push), gaps G3, G8 and G10 · branch `phase-2-3`.
Conventions as in CLONE_SPEC: **OBSERVED** (seen in evidence), **INFERRED** (follows from evidence), **design choice**
(Parlance's own decision). All copy, art (the sticker set) and code are Parlance's own; no third-party assets.

Code: `clone/server/community.js` (entry point) → `circle.js`, `social2.js`, `notify-prefs.js`, `groups.js`,
`chat-extras.js`, plus `community-util.js`, `stickers.js`, `gif-provider.js`. Client: `public/js/views/social2.js`
(helpers), `notification-settings.js`, `social-manage.js`, `groups.js`, `admin/community2.js`, `public/social2.css`.
Tests: `clone/tests/social2.e2e.test.js` (12 scenarios), `clone/tests/groupchat.e2e.test.js` (4 scenarios).

### 24.1 Evidence vs design choice

| Area | Status | Evidence / rationale |
|---|---|---|
| Post UI: position tag "Yes · outcome · market", body with **Read more**, actions like / reply / bookmark / share / ⋯; composer "What's on your mind?" with GIF and **+ Add a position** | **OBSERVED** | CLONE_SPEC §15.4 [SHOT3:event-social] |
| Social endpoints `social/posts/{id}`, `…/comments`, `…/unlike`, `…/bookmark`, `users/{u}/social/follow`, `search/social_profiles`, `social/timeline_count`, `social/badges` | **OBSERVED call sites** | CLONE_SPEC §13.6 (`evidence/api_callsites_home.txt`) |
| Notification endpoints `…/notifications/preferences`, `…/settings/{t}`, `…/price_movement_subscriptions`, `…/social_account_subscriptions` | **OBSERVED call sites** (shapes INFERRED) | CLONE_SPEC §13.7 |
| Notification matrix: groups General / Predictions / Sports / Social / Promotional; per type channel pills **In-app · Email · Push** (filled = on); only listed channels offered; ⌄ on Order auto-cancellation, Taker-side and Maker-side trade confirmation, Sports Major events; Social rows incl. **Inner Circle requests / accepted**, **Group chats**, Leaderboard (Push only); "Security notifications" toggle | **OBSERVED** | CLONE_SPEC §13.16 item 3 and 5 [SHOT5:settings-*] |
| Which pills are filled by default, channels of rows whose pills were not listed (Referral rewards / activity, Market rewards, Price movement, Order auto-cancellation, trade confirmations, Major events), the content of each ⌄ | UNKNOWN → **design choice** | §24.5 |
| Four `PUT …/social-admin/…` call sites (`determine_profile_image/{id}`, `posts/{id}/market_status`, `…/post_subtype`, `…/update`) | **OBSERVED call sites**, bodies UNKNOWN → **design choice** | CLONE_SPEC §18.1 |
| Promo targeting fields `series_ticker_list`, `preferred_categories`, `hide_on_explore_page_web_logged_out` | **OBSERVED fields** | CLONE_SPEC §13.11 |
| RFQ `rest_remainder` (RFQ and quote) and `obscure_creator_id` with the empty-input SHA-256 placeholder | **DOC** | `evidence/openapi.yaml` CreateRFQRequest / CreateQuoteRequest / RFQ.creator_id; `asyncapi.yaml` |
| Inner Circle, Group chats: existence and notification rows | **OBSERVED** (names only) | §13.16 |
| Everything else: sticker art, stickers instead of GIFs, edit windows, mutes, Inner Circle mechanics, group-chat rules, reactions set, limits, quiet hours, push transport | **design choice** | sections below |

### 24.2 Posts (P2.1)

- **Position tag.** Composer **+ Add a position** lists the author's taggable positions (`GET /v1/users/:uid/social/position_tags`:
  current positions per side, then markets bought earlier). The post carries `position: {market_ticker, side}`; the
  server re-checks at post time that the author **holds** that side now or **bought** it before (a sell of YES is stored
  as a NO buy with `action='sell'` and does not count as having held NO) → else `409 position_not_held`. The tag is
  snapshotted in `post_extras` (outcome, market title, held = `current|past`, units) and rendered as
  "**Yes · Approved · Will Harbor City approve the waterfront tram?**", linking to the market with the side preselected.
- **Audience.** `visibility: public | circle`. Circle-only posts are visible to the author, the author's Inner Circle
  and moderators only — single post, replies, likes, bookmarks, feeds (all, following, profile, event, topics), timeline
  counts and follower / topic notifications all apply the same rule (`hooks.canView`, `visibilityClause`); others get 404.
- **Share.** Canonical path `/social/post/:id` (`share_path`); the share button uses the Web Share API when present,
  else copies the absolute link; ⋯ → Copy link.
- **⋯ menu.** Copy link · Share… (when supported) · for your own post Edit (inside the window) and Delete · for others
  Mute @nick / Unmute and Report post (existing report dialog and queue).
- **Read more.** Bodies over 280 characters or 6 lines are clamped to 5 lines with a Read more / Show less toggle; the
  canonical page shows the full text.
- **Edit window.** Authors may edit for **10 minutes** (`PUT /v1/users/:uid/social/posts/:pid`, else `409
  edit_window_closed`); the card shows "· edited" (moderator edits "· edited by a moderator"). Every edit is a
  `post_edits` row (previous and new text, editor, reason); moderators see the history in Admin › Community › Post lookup
  (`GET /v1/admin/moderation/posts/:pid`). Someone else's post answers 404. Hidden posts and banned authors cannot edit.
- **Text rules** for posts, replies and edits (`community-util.cleanText`): string, well-formed UTF-16, NFC, trimmed,
  ≤ 500 (posts) / 300 (replies) characters, line breaks allowed, other C0/C1 controls, bidi overrides / isolates /
  direction marks and long combining-mark runs refused. A sticker alone is a valid post or reply.
- **Mutes** (`user_mutes`): per viewer, silent (the muted person is not told), up to 500. Applied server-side to every
  feed (except the muted person's own profile, where their posts show dimmed), replies, event-chat history, group-chat
  history and unread counts, Inner Circle incoming requests, and to **every notification caused by the muted user**
  (`actor` on notify → dropped in the gate). Live chat / group frames carry nicknames only, so the client drops frames
  from muted nicknames itself.

### 24.3 Stickers and GIFs (P2.2)

- Ten original SVG stickers (`server/stickers.js`: plain shapes, no scripts, styles, event handlers or external
  references), seeded into `social_stickers`. Picker ("GIF · Sticker") in the post composer, reply forms, event chat and
  group chats. Content stores the **sticker id** only; URLs are always built by the server
  (`/v1/social/stickers/<id>.svg`, served with `Content-Security-Policy: default-src 'none'; …; sandbox`).
- Admin › Community › Stickers enables / disables each sticker (audited). A disabled sticker leaves the picker, its URL
  answers 404, existing posts / replies / messages render without it, and posting it answers `400 sticker_disabled`.
- Profile pictures are a choice from the same set (`PUT …/social/profile/avatar`); moderators can decline one
  (`determine_profile_image`), which removes it and tells the user.
- **External GIF adapter** (`server/gif-provider.js`): the interface (server-side proxy, one allowlisted API host and one
  media host, https only, rating filter, id pattern, size and content-type caps) exists but is **off** — no provider is
  configured, `GET /v1/social/gifs/search` answers `403 feature_disabled` (`gif_provider_disabled`), and the picker
  says so.

### 24.4 Topics, search, timeline counts, badges (P2.3)

- **Topic follows** (`topic_follows`): events (Follow button on event pages), markets, and keywords (2–32 letters,
  digits, spaces or `# $ & ' . + -`, lower-cased) from Social settings; up to 50. The **Topics** feed lists posts on a
  followed event, a market of it or tagged with it, or containing a keyword. A new matching post notifies followers of
  the topic (`social_topic` → Post alerts), except the author, followers of the author (they already get `social_post`)
  and anyone not allowed to see it; at most 500 per post.
- **Profile search** `GET /v1/search/social_profiles?query=` — nickname **prefix** only (`[A-Za-z0-9_]{1,20}`, `@`
  ignored, LIKE wildcards escaped), never by email or name; system accounts excluded; 20 per IP and 20 per user burst,
  2/s refill → `429` + `retry_after_sec` + `Retry-After`; `Cache-Control: no-store`.
- **Timeline count** `GET /v1/social/timeline_count?feed=all|following|topics|circle&since=` — posts by others since a
  time, excluding hidden, muted and invisible posts. The feed polls it every 10 s and shows "N new posts · show".
- **Badges** (`social_badges`, earned once, persisted, notified): First trade, 10 trades, Profitable month (a calendar
  month of settled profit), Top 10 trader (profit leaderboard), Verified (follows the moderator's verification). Shown
  on profiles, posts and replies; `GET /v1/social/badges?nickname=`.
- New feeds: **Inner Circle** (posts by your circle) and **Topics**, next to For you / Following / Saved.

### 24.5 Notifications: matrix, channels, quiet hours (P2.4, A6)

**Matrix** (`server/notify-prefs.js` TYPES; filled = default on, — = not offered, *fixed* = channel not offered but always
on/off):

| Group | Type | In-app | Email | Push | ⌄ sub-options (design choice) | Internal producers |
|---|---|---|---|---|---|---|
| General | Transfers | *on (fixed)* | ● | ● | — | deposits, withdrawals, perps transfers |
| | Referral rewards | ● | ● | ● | — | (none yet: Phase 8) |
| | Referral activity | ● | ○ | ● | — | (none yet) |
| | Market rewards | ● | ● | ● | — | (none yet: Phase 5 incentives) |
| Predictions | Price movement | ● | ○ | ● | threshold 1–50¢ (10), window 5 min / 15 min / 1 h / 4 h / 1 day (1 h), "Also alert on markets I hold" (off) | custom price targets, price-movement subscriptions, held markets |
| | Market settlement | *on (fixed)* | ● | ● | — | settlements |
| | Order auto-cancellation | ● | ○ | ● | expired good-til-time orders (on), resting orders canceled when a market closes or reopens (on) | `order_expired`, `order_canceled_market` |
| | Taker-side trade confirmation | ● | ○ | ○ | every fill incl. partial (default) / only when the order completes | fills where you took |
| | Maker-side trade confirmation | ● | ○ | ● | same | fills of your resting orders |
| Sports | Major events | ● | — | ● | game starts (on), final score (on), for games I have positions in / I hold or watch | live game status transitions |
| Social | Post alerts | ● | — | ● | — | posts by people you follow, topic posts |
| | Trade alerts | ● | — | ○ | — | trades of traders whose bell you turned on |
| | Position alerts | ● | — | ○ | — | followed / circle traders open, close or flip a position |
| | Likes, comments & follows | ● | — | ● | — | likes, replies, follows |
| | Inner Circle requests | ● | — | ● | — | circle requests |
| | Inner Circle accepted | ● | — | ● | — | accepted requests |
| | Group chats | ● | — | ● | — | added to a group, new messages (one per unread burst) |
| | Leaderboard | *off (fixed)* | — | ● | — | entering / climbing the profit top 10 |
| Promotional | Breaking events, New markets, Politics | ● | ○ | ○ | — | admin announcements tagged with that topic |
| | Crypto, Commodities | ● | — | ○ | — | same |

Design choices behind the table: a channel without a pill is fixed (money records — transfers and settlements — always
reach the inbox, so existing behaviour is unchanged; Leaderboard is push-only as observed; Social and two Promotional
rows have no email); marketing email and push are opt-in; noisy alerts (trade alerts, position-alert push) are opt-in.
Types outside the matrix (RFQ, perps, announcements without a topic, badges, moderation notices) stay in-app only.
**Security notifications** (separate toggle, default on): account notices always reach the inbox and sign-in alerts
also email (CLONE_SPEC §22.3); the toggle adds push for every sensitive-action notice.

**Delivery** — every notification passes `features.notify()` → `hooks.notifyGate` (`notify-prefs.gate`):
1. mute check on the causing user; 2. matrix row from the internal type (fills → taker / maker from the fill);
3. sub-options (e.g. `fills: complete` keeps fills of a still-resting order silent and turns the last fill into one
"Order filled: N YES @ avg P¢" summary, de-duplicated per order in `notif_order_done`); 4. **email** → a
`notif_deliveries` row, then the existing dev mailbox `email_outbox` (no SMTP; subject "Parlance: …"); 5. **push** → a
`notif_deliveries` row delivered to the user's registered browsers (`push_devices`) as a `push` frame on the private
`notifications` WebSocket channel, and as real **Web Push** to every subscribed device (§31.7); status `sent`, or
`no_device` when neither exists; 6. **in-app** → the inbox row
and the live toast. At most 120 email and 120 push deliveries per user per hour (`dropped_rate` beyond).
**Browser push** (the flag): Settings › "Push in this browser" registers the browser (`POST …/push_devices`), stores its
id locally and asks for the Notification permission; the client shows `new Notification(…)` only for frames that list
this device and only when permission is granted.
**Quiet hours** `{enabled, start, end, timezone}` (IANA zone, windows may wrap midnight): email and push are stored as
`deferred` with `send_after` = the end of the window and sent by the 1 s flush; in-app rows are kept without a toast
(`quiet: true` on the live frame); switching quiet hours off releases deferred deliveries at once. Restart-safe
(timestamps in SQLite).
**Price-movement subscriptions** (`price_move_subs`, ≤ 50 per user): market, threshold 1–99¢, window 5–1440 min,
direction any / up / down; reference = last trade at or before now − window, else the first trade inside it; fires at
most once per window (persisted). Created from the event page (**Move alert**). Trade alerts are subscribed per trader
(`social_account_subscriptions`, the bell on a profile, followers only; unfollowing removes it).
**Sports major events**: transitions of live games (`live_data` status scheduled → live → final; the first observation
after start is the baseline) notify holders of the game's event (and watchers if chosen).
**UI**: `mountNotificationSettings(el)` (exported; Phase 3's `/account/settings` mounts it, `/notifications/settings`
shows it alone) — collapsible groups, pills, ⌄ forms, quiet hours, push in this browser, the user's recent email / push
deliveries; `mountSecurityNotificationSetting(el)` renders the separate security toggle. Admin › **Notification outbox**
(`users.support`) lists every email / push delivery.

### 24.6 Inner Circle (A11)

Request by nickname (profile button **Add to Inner Circle**, or `/social/circle`) → the other side **Accepts** or
**Declines** (the requester is not told about a decline; a new request is possible after 24 h) → the relationship is
**mutual** (`circle_members` holds both directions). Requesting someone who already asked you accepts theirs. Either
side **removes** it (both directions end). Up to 150 members and 50 pending outgoing requests. Notifications:
`circle_request`, `circle_accepted`. Circle members see each other's circle-only posts and can be added to group chats.
Bans block requests; a muted requester's request waits silently.

### 24.7 Group chats (A11)

- Up to 50 members, 100 groups per user. Created from the creator's **mutual follows and Inner Circle**
  (`GET …/groups/candidates`); any member can add their own connections; the **owner** renames and removes; anyone
  leaves; when the owner leaves, the longest-standing member becomes owner; an empty group is archived. A person who is
  unknown, unconnected, banned or has muted the inviter gets the same `409 cannot_add_member`.
- Messages: one line, 1–500 characters (event-chat rules), optional sticker and reply; delete own; ⋯ Report (kind
  `group` in the admin report queue) and Mute. History pages of 50 (`before` cursor validated against the group).
  System lines record joins, leaves, renames and removals. Unread = text messages after `last_read_seq`, excluding your
  own and muted authors; opening a conversation marks it read.
- Live: private WebSocket channel **`groups`** (`group_message`, `group_message_deleted`, `group_updated`,
  `group_removed`), published per current member, so removed members stop receiving at once.
- Notifications: "added you to …" and one `group_chat` notification per unread burst (`notified_seq`).
- Moderation (`social.moderate`): Admin › Community › Group chats lists groups (members, messages, open reports);
  opening one is **audited** (`group.view`) because the content is private; delete message, remove member, lock /
  unlock (members get a locked composer live, `403 group_locked`). Report-queue Hide / Delete on a `group` report removes
  the message live and actions the report.

### 24.8 Event chat completion (G10)

Reactions from a fixed set (👍 ❤️ 😂 😮 🔥 📈; keys `up heart laugh wow fire chart`): `PUT` adds, `DELETE` removes
(idempotent), counts broadcast live (`chat_reactions` frames carry counts only), own selection returned on REST; own
buckets (20 burst, 2/s per user; 60 / 6 per IP). **Edit** your own message for **5 minutes**
(`PUT …/chat/:ticker/messages/:id`, chat text rules, "(edited)" live via `chat_edited`), previous text kept in
`chat_message_edits` (`GET /v1/admin/chat/messages/:id/edits`). Sticker messages. Locked / read-only rooms and room mutes
refuse reactions and edits like messages. Muted authors are filtered from history (server) and live frames (client).

### 24.9 Moderation and G8

- Admin › **Community** (`social.moderate`): Stickers, Post lookup (body, tag, audience, type, edit history, actions),
  Group chats. Admin › **Notification outbox** (`users.support`).
- The four observed `PUT /v1/users/:uid/social/social-admin/…` paths (same `self+perm:social.moderate` model as the
  existing DELETE / GET social-admin paths; bodies are Parlance's):
  - `determine_profile_image/:id` `{decision: approve|reject, reason}` (`:id` = user id or nickname; reject needs a reason, removes the picture, tells the user);
  - `posts/:pid/market_status` `{event_ticker: string|null, position_tag: keep|remove, reason}` — re-link / detach the event and position tag;
  - `posts/:pid/post_subtype` `{post_subtype: standard|analysis|news|humor|promotional, reason?}`;
  - `posts/:pid/update` `{body, reason}` — moderator edit (history row `by_moderator`, "edited by a moderator", author told).
  Each writes one hash-chained `admin_audit` row (`social.profile_image`, `social.post_market_status`,
  `social.post_subtype`, `social.post_update`); sticker switches `social.sticker.enable|disable`; group actions
  `group.view|delete|lock|unlock|remove_member`.
- **Promo targeting**: `cms_promos` gains `series_tickers`, `categories` (JSON lists, validated against existing series
  and site categories) and `hide_logged_out`. Untargeted promos stay on home; targeted ones appear on the event pages of
  their series and on their category pages (`GET /v1/promos?series_ticker=|category=`); `hide_logged_out` hides a card
  from signed-out visitors everywhere. Admin › Content › Promo cards edits the fields.
- Admin announcements accept an optional promotional `topic` (breaking_events, new_markets, politics, crypto,
  commodities); recipients' channel choices for that row apply.

### 24.10 RFQ (G3)

- `obscure_creator_id: true` on `POST /v1/communications/rfqs`: other users (RFQ lists, broadcasts, quotes before
  execution) see `creator_id` = `e3b0c442…b855` (SHA-256 of empty input); the creator always sees the real
  communications id; after a successful execution the RFQ shows the real id to everyone and the executed quote to its
  counterparty (accepting or confirming alone does not reveal it) — as documented.
- **Partial quotes** (Parlance extension): a maker may quote part of a contract-sized RFQ with `contracts_fp`
  (≤ RFQ size). **RFQ `rest_remainder`**: when the execution filled less than the RFQ size, the unfilled remainder is
  placed as the requester's **GTC limit order at the executed price** (normal order path: trading limit, reservation,
  matching; `source='rfq_remainder'`; id in `rfqs.remainder_order_id`, shown to the requester); without it the remainder
  lapses. **Quote `rest_remainder`**: an unfilled maker remainder stays on the book instead of being canceled.
  Target-cost RFQs have no remainder.

### 24.11 Endpoints (all under `/v1`; every one classified in `tests/authz.e2e.test.js`)

| Who | Endpoints |
|---|---|
| public | `GET social/badges`, `search/social_profiles`, `social/timeline_count`, `social/stickers`, `social/stickers/:file`, `promos` |
| user | `GET social/gifs/search` (403 while off) |
| owner (`/users/:uid/…`) | posts: `PUT social/posts/:pid`; `GET social/position_tags`; `PUT social/profile/avatar`; `GET/POST/DELETE social/mutes`; `GET/POST/DELETE social/topics` |
| | circle: `GET social/circle`; `POST social/circle/requests`; `POST …/requests/:rid/accept`, `…/decline`; `DELETE …/requests/:rid`; `DELETE social/circle/members?nickname=` |
| | notifications: `GET/PUT notifications/preferences`; `PUT notifications/settings/:type`; `GET notifications/deliveries`; `GET/POST notifications/push_devices`, `DELETE …/push_devices/:id`; `GET/POST/DELETE notifications/price_movement_subscriptions`; `GET/POST/DELETE notifications/social_account_subscriptions` |
| | groups: `GET/POST groups`; `GET groups/candidates`; `GET/PUT groups/:gid`; `POST groups/:gid/members`; `DELETE groups/:gid/members/:nickname`; `POST groups/:gid/leave`; `POST groups/:gid/messages`; `DELETE …/messages/:mid`; `POST …/messages/:mid/report`; `PUT groups/:gid/read` |
| | chat: `PUT/DELETE chat/:ticker/messages/:id/reactions/:reaction`; `PUT chat/:ticker/messages/:id` |
| self + `social.moderate` | `PUT social/social-admin/determine_profile_image/:id`, `…/posts/:pid/market_status`, `…/post_subtype`, `…/update` |
| `social.moderate` | `GET admin/moderation/posts/:pid`; `GET admin/stickers`, `PUT admin/stickers/:id`; `GET admin/groups`, `GET admin/groups/:gid`, `POST admin/groups/:gid/:action`; `GET admin/chat/messages/:id/edits` |
| `users.support` | `GET admin/notifications/deliveries` |

Changed existing endpoints (additive): `POST …/social/posts` (+`sticker_id`, `position`, `visibility`; body optional with
a sticker), `POST …/comments` (+`sticker_id`), `POST …/chat/:t/messages` (+`sticker_id`), `GET social/posts`
(+`feed=topics|circle`, visibility and mute filters), post / comment / profile / chat-message shapes (+sticker,
position, visibility, edited, badges, avatar, circle relation, reactions), `POST communications/rfqs`
(+`obscure_creator_id`), `POST communications/quotes` (+`contracts_fp`, `rest_remainder`), `POST admin/announcements`
(+`topic`), `admin/content/promos` (+targeting fields).

### 24.12 Tables (CREATE TABLE IF NOT EXISTS; foreign keys to users / posts / comments with ON DELETE CASCADE)

`social_stickers`, `post_extras`, `post_edits`, `comment_extras`, `user_mutes`, `topic_follows`, `social_badges`,
`profile_avatars`, `social_position_state`, `leaderboard_ranks` (social2.js) · `circle_requests`, `circle_members`
(circle.js) · `notif_prefs`, `notif_deliveries`, `push_devices`, `notif_order_done`, `price_move_subs`,
`price_move_held`, `social_account_subs` (notify-prefs.js) · `chat_groups`, `chat_group_members`,
`chat_group_messages` (groups.js) · `chat_reactions`, `chat_message_edits`, `chat_message_extras` (chat-extras.js).
Additive columns (forward-only, `ALTER TABLE … ADD COLUMN` when missing): `cms_promos.series_tickers|categories|
hide_logged_out`, `rfqs.obscure_creator_id|remainder_order_id`, `rfq_quotes.rest_remainder`. `meta`
`leaderboard_push_baseline`. The existing `email_outbox` (dev mailbox) is reused.

### 24.13 Security (PLAN §6 gate)

- **Authorization**: every new route classified in the authz matrix (anonymous / user / IDOR / six admin roles all pass);
  object-level checks in handlers (another user's post, group, request, device, subscription, chat message → 404 or
  403; non-members get 404 for every group path); WebSocket `groups` is private and published per current member;
  frames carry nicknames, never user ids or emails (tested with a second and third user).
- **CSRF / perimeter**: all writes are REST behind the session CSRF header, the signed client token and CORS; no
  WebSocket writes.
- **Validation**: per-route body schemas (`schemaGuard` on `server/validate.js` `check()`; unknown fields refused on all
  new writes), `8kb` body limit for `/users/:uid/groups`; text rules in §24.2 / §24.7; enums and ranges for every
  preference, option and moderator action; tickers, nicknames, ids matched against strict patterns.
- **XSS**: user text is stored raw and rendered with `esc()` in templates (lint rule) or `textContent` (`h()` builder);
  sticker images come only from server URLs; the SVG route sends `default-src 'none'` + `sandbox`. Tests inject
  `<img onerror>`, `<script>`, `<svg onload>` into posts, replies, edits, chat edits, group names, group messages,
  report reasons and notification titles and check nothing executes in the app or admin.
- **Rate limits** (token buckets, `429` + `retry_after_sec` + `Retry-After`): post edits / mutes / topics / avatar
  (20 burst, 1/s per user each), profile search (20 burst, 2/s per IP and per user), circle writes (20, 0.5/s), group
  messages (8, 0.5/s per user; 30, 3/s per IP), group admin actions (20, 1/s), reactions (20, 2/s; 60, 6/s per IP),
  preference / subscription / device writes (30, 1/s); email and push 120 per user per hour.
- **Abuse controls**: posting bans and account locks apply to edits, circle requests, group actions and messages;
  mutes; reports; moderator lock; 24-hour cool-off after a declined circle request; caps on groups, members, mutes,
  topics, subscriptions, devices; candidate-only adds; uniform `cannot_add_member` (no account probing).
- **Privacy**: circle-only posts never leave the circle (feeds, counts, notifications, links); moderator reads of private
  group chats are audited; position / trade alerts only for traders who share their trades; search never matches email.
- **Audit**: every moderator action and every group-chat view is a hash-chained `admin_audit` row (verified in tests).
- **STRIDE notes** — S: sessions + CSRF unchanged; T: edits keep history; R: audit chain for moderators, edit history
  for authors; I: visibility rules above, no ids in frames, obscured RFQ creator; D: rate limits, caps, frame cap
  unchanged, quiet-hour flush bounded (200 per second); E: permission checks server-side, social-admin requires
  `self + social.moderate`.

### 24.14 Verification

`tests/social2.e2e.test.js` (12): position tag picker + server verification, sticker, Read more, copy link, canonical page,
SVG headers; edit window + moderator history; mute across feed / replies / notifications / chat (history and live);
topics + "N new posts" + topic notifications + search (prefix only, rate limit) + badges; Inner Circle request → live
notification → accept → circle-only post visibility (member, follower, anonymous, direct link) → remove; the exact
§13.16 matrix, pill persistence, API guards, email channel + price-move alert from the event page, browser push,
"order completes" summary, quiet hours defer / release, leaderboard push-only, security toggle, transfers; G8 actions
from the admin UI + profile-picture decline + sticker switch + promo targeting + audit chain; chat reactions / edit /
sticker live; XSS across all new fields (app and admin); IDOR on every new object + `groups` channel isolation; RFQ
G3; position / trade alerts, sports major events, auto-cancel reasons, promotional topics, outbox; restart persistence
and 390px (dark + light) with no overflow, page errors or CSP violations.
`tests/groupchat.e2e.test.js` (4): creation from mutual follows / circle, three live browsers, unread, coalesced
notifications, reply, sticker, refusals; add / owner-only remove (live) / rename / leave + owner hand-over; report → queue
→ live delete, audited view + lock (live), mute, posting ban, rate limit, validation, text-only rendering; restart and
390px.

### 24.15 Shared-file edits (small, exact-string)

`server/app.js` (2 lines: mount + `attachChat`), `features.js` (extension hooks, `actor` / `meta` on notify, fill meta,
links to `/social/post/:id`), `chat.js` (hooks + exported internals), `combos.js` (G3), `admin.js` (promo targeting,
announcement topic), `ws.js` (`groups` channel, `push` frames), `validate.js` (sticker-only bodies, groups body limit),
`public/js/api.js`, `main.js` (routes, Messages icon, push / quiet toasts, More menu), `views/social.js`, `components.js`
(post card), `notifications.js`, `chat.js`, `event.js`, `browse.js`, `admin.js`, `admin/site.js` (export report dialog),
`admin/content.js`, `lib.js` (icons), `index.html` (stylesheet), `package.json`, `tests/authz.e2e.test.js`.

### 24.16 Residual risks and follow-ups

- Rate-limit buckets are in memory per process (as everywhere: RS1). Push is a dev transport (WebSocket + browser
  Notification); a Web Push (VAPID) service worker is a production follow-up. Email stays the dev mailbox (RS6).
- Live chat / group frames are filtered client-side for mutes (the server does not know who muted whom per frame by
  design); history, counts and notifications are filtered server-side.
- Referral / market-reward notification rows have no producers until Phases 5 and 8; their preferences are stored.
- Sports major events take their first observation after a restart as the baseline (a transition during downtime is
  not notified).
- The GIF adapter is untested against a real provider (off by design; no key in this project).

---

## 25. Accounts, identity, compliance and account area

Phase 3 of `PLAN.md` (P3.1–P3.8, P3.1a personal-data protection, §11 A1–A6 and A12, residual items RS2, RS3, RS6, RS9,
RS10). Evidence: `CLONE_SPEC.md` §4.7, §13.9, §13.14 (onboarding), §13.15 (document verification), §13.16 (account area),
§13.19 (locked endpoints, rewards). Everything not shown in that evidence is a **design choice**, marked as such. All
data in code, fixtures and tests is invented ("Sample"/"Test" names, 555-01xx phone numbers, never-issued 9xx SSNs,
"Maple Test Avenue"); no real person, organisation or vendor is named or imitated (the verification vendor is our own
"Parlance Verify (sandbox)").

### 25.1 Modules

| File | Role |
|---|---|
| `server/identity.js` | Mounts everything below; personal-data vault (P3.1a); onboarding steps and resume; phone codes (P3.2); email verification and password reset; compliance gate; A2 lock; data export and closure (P3.8); admin identity lookup with audited unmask; compliance settings; retention job |
| `server/countries.js` | Dial codes and national-number rules (E.164), regions, postal formats, per-country national ID (label, format, checksum, masking), simulated IP table and coarse geo boxes |
| `server/messaging.js` | Email (dev outbox or SMTP: EHLO, STARTTLS, AUTH PLAIN) and SMS (dev outbox or JSON webhook) providers; `/v1/dev/mailbox`, `/v1/dev/sms` (RS6) |
| `server/kyc.js` | KYC provider interface, deterministic sandbox, async two-stage job worker, admin review queue and decisions (P3.5) |
| `server/docv.js`, `server/images.js` | Document verification: QR handoff, phone capture session, uploads, image sanitising, encryption, retention, audited staff view (A1) |
| `server/compliance.js` | Simulated geolocation (P3.6) and fraud signals / risk score / withdrawal holds (P3.7) |
| `server/oauth.js` | OIDC relying party (PKCE S256 + state + nonce) and a built-in mock provider for dev/test (P3.3) |
| `server/webauthn.js` | Passkeys without a library: CBOR, authenticator data, COSE keys, signatures, counters (P3.4) |
| `server/account-area.js`, `server/pdf.js` | Settings preferences, marketing consent, connected apps, Your activity, Documents (P&L, CSV, PDF), checklist, promo codes (A3–A6, A12) |
| `public/js/views/onboarding.js`, `docv-phone.js`, `identity-pages.js` | Full-screen onboarding + document verification, phone page, verify-email / forgot / reset / OAuth callback / dev mailbox |
| `public/js/views/account.js`, `account-*.js`, `account-menu.js`, `rewards.js`, `placeholder.js` | Account frame, ☰ menu, category index, settings, activity, documents, identity & privacy, rewards, placeholder pages |
| `public/js/qr.js`, `pow.js`, `prefs.js`, `identity-api.js`, `webauthn-client.js`, `public/account.css` | Local QR encoder, sign-in proof of work, app-wide display prefs, Phase 3 transport, WebAuthn glue, styles |
| `public/js/views/admin/compliance.js` | Admin › Identity reviews, Fraud & holds, Compliance, Promo codes |

### 25.2 Onboarding (P3.1; CLONE_SPEC §13.14 observed)

- **Frame** (observed): full-screen page with only the wordmark and a three-segment progress bar; header, footer and
  banners are hidden (`body.ob-mode`).
- **Steps** (observed order): phone number → "Enter your 4 digit code" (four boxes, first focused, Continue disabled until
  four digits, "Resend code" pill with a visible `m:ss` countdown, "Learn more") → "What's your name?" (legal first/last,
  floating labels, "Not now") → "When's your birthday?" (MM · DD · Year with auto-advance; "You must be 18 or over…",
  "Federal law requires…") → "What's your address?" (country select, address with simulated autocomplete of invented
  addresses, apt, city, region select/field, postal code, **country-specific national ID** — e.g. SSN · 9 digits, NIN ·
  11 digits — `autocomplete="off"`, the "same address as on your state ID… not a business or PO box" rule) →
  "Verifying info…" (spinner around the wordmark) → document verification (§25.4) → "Verifying info…" → outcome.
- **Persistence and resume**: every step is saved server-side when Continue is pressed (`PUT /users/:uid/sign_up/{name,
  birthday,address}`), `GET /users/:uid/sign_up` returns `next_step`, `POST /resume_sign_up` resumes (spec §4.7 call
  sites). "Not now" (`POST …/sign_up/skip`) and "Exit identity verification" leave the flow; a banner on every page
  invites the user back. Reloading mid-flow returns to the same step with the saved fields prefilled (never the national
  ID, which is never sent back).
- **Statuses**: `not_started → in_progress → pending (data) → documents_required → pending (documents) → approved |
  review | rejected | retry`, plus `closed`. Outcome screens (design choice; not captured): approved ("You're verified",
  Start trading), manual review ("We're reviewing your info"), rejected (reason category text + support), retry ("Let's
  try that again", prefilled details, attempts left; after 3 attempts a retry becomes manual review).
- **Server-side rules**: name letters/spaces/hyphens/apostrophes; date valid and **age ≥ 18 computed on the server**
  (`400 age_requirement`; the date is not logged); postal format per country; PO boxes refused; national ID format and
  checksum per country (SIN Luhn, CPF check digits, TFN weights, SSN area/group/serial rules; 9xx SSNs accepted only in
  the sandbox). Error messages never echo the submitted value.
- **After sign-in / sign-up** (design choice): when verification gates trading, unverified non-staff users land in
  onboarding; staff go where they were going.

### 25.3 Personal-data protection (P3.1a)

- **Field-level encryption**: legal name, date of birth, address, phone, national ID and ID photos are AES-256-GCM
  encrypted with a **per-user data key**; the data key is itself encrypted with an HKDF sub-key (`identity-kek:v1`) of
  the deployment master key (`server/crypto.js`). Each ciphertext's AAD binds it to its field and user, so a value copied
  into another row does not decrypt. Tests dump every text value of every table and find none of the plaintext values.
- **National ID**: stored encrypted plus an HMAC (`national-id-hash:v1`, country-prefixed) for duplicate detection; the
  last 2–4 digits only are kept for display. It is **never returned in full** by any endpoint — not to staff, not in the
  data export, not even to the owner (`•••-••-7712`).
- **Phone**: E.164 encrypted; HMAC for duplicate signals; last 4 digits for display. Codes are HMACs (`phone-code:v1`).
- **Never logged**: security events carry masked or categorical data only (`{step: 'address', country}`, masked phone);
  audit rows of staff access record *who, whose, which field and why*, never the value; console errors never include
  applicant data; telemetry does not exist yet (P9.4).
- **Staff views are masked** (`R*** R***`, `••/••/••••`, `•••• NY, US · 10•••`). Revealing a field (support/admin roles)
  needs a reason of ≥5 characters, writes a hash-chained `identity.unmask` audit row and an `identity_viewed_by_staff`
  event in the customer's own security activity. National IDs cannot be revealed (`403 not_unmaskable`).
- **Retention**: verification codes, emails and SMS 30 days; browser-location checks 30 days; device records 180 days; ID
  photos are erased at the decision (or after `documents_days`, 30, if abandoned); after closure the remaining
  verification record (status, ID hash) is kept `kyc_days` (5 years) for anti-fraud/AML record keeping, then deleted. All
  values are admin-configurable (Admin › Compliance) and shown to the user (Identity & privacy).

### 25.4 Document verification (A1; CLONE_SPEC §13.15)

- **Screens** (observed): intro "Let's get you verified" / "It will only take 2 minutes" / "What you will need:" with line
  icons for *Government Issued ID* and *Smartphone* / "Get started" / ✕ close / "powered by **Parlance Verify (sandbox)**";
  "Continue on your phone" with "Scan the QR code below with your phone's camera" and the QR; desktop waiting screen
  "Stay on this page" / "Check back here to complete verification" / animated ID-and-face scan / "Uploading your
  documents…" / "Exit identity verification" pill. The desktop polls every 1.5 s, switches to the waiting screen when the
  phone connects and ticks off each photo live; when the phone submits it shows "Verifying info…" then the outcome.
- **QR**: `public/js/qr.js` is our own encoder (byte mode, EC level M, versions 1–10, all eight masks with penalty
  scoring); verified module-for-module against a reference implementation for 48 cases (versions 1–10, every mask). The
  QR encodes `https://<origin>/verify/m#t=<token>`: a 256-bit token in the **fragment** (never sent to the server in a URL,
  so it cannot leak into logs or `Referer`), stored only as SHA-256, **single use**, **10-minute** expiry, **bound to the
  desktop session** that created it (signing out or starting a new handoff kills it).
- **Phone**: the page reads and removes the fragment, claims the token once (`POST /docv/handoff/claim`; a second claim
  answers `410 handoff_used`), and receives a 15-minute capture session: an HttpOnly, SameSite=Strict cookie scoped to
  `/v1/docv` plus a CSRF value sent as `X-Docv-Csrf`. It ends when the desktop session ends (`401 handoff_expired`). Each
  photo comes from `<input type="file" accept="image/*" capture="environment|user">` (front, back, selfie).
- **Uploads**: the browser re-encodes every photo through a canvas to JPEG ≤1600 px (drops EXIF/GPS); the server
  (`server/images.js`) sniffs the type from the bytes (JPEG/PNG only), rewrites the container keeping only image segments
  (all APPn/COM, PNG text/time/eXIf chunks dropped), discards anything after the end marker, checks 200–8000 px and a
  6 MB cap, then encrypts with the user's data key into SQLite (`docv_documents.data`). There is **no URL that serves an
  image**; staff use `POST /admin/kyc/:user/documents/:doc/view` (support/admin, reason ≥5 chars, `kyc.document_view`
  audit row) which returns a `data:` URL. Max 15 uploads per handoff. Tests confirm no JPEG/PNG markers at rest and no
  EXIF/GPS/trailing payload after decryption.
- **Same-device fallback**: "Continue on this device instead" offers the same three inputs on the desktop (session
  authenticated), same checks. "Exit identity verification" keeps uploaded photos and closes the handoff link.

### 25.5 Identity verification (P3.5)

Provider interface `{ name, verifyData(applicant), verifyDocuments(applicant, docsMeta) }` → `{decision, reason_category,
reference}`; may throw (retried 3× with backoff, then `retry/provider_unavailable`). Jobs live in `kyc_jobs` and are run
by an in-process worker; a restart resumes queued and interrupted jobs (tested). Our own rules run first: duplicate
national ID on another open account → rejected `duplicate_account`; match with a closed account → manual review; under
18 → rejected; blocked residence → rejected `unsupported_region`. **Sandbox** (deterministic by invented last name):
`Retry` → data-stage retry, `Outage` → provider outage, `Review` → manual review after documents, `Reject` → rejected after
documents, anything else → approved. Without a provider in production both stages go to manual review. **Admin ›
Identity reviews**: queue by status with masked data, duplicate-ID flag, risk score and document count; detail dialog with
reveal (audited), document view (audited), history and the decision form (approve / reject / ask to retry with a reason
category; support role, step-up, audited; staff cannot decide their own case). Photos are kept during manual review and
erased at the decision.

### 25.6 Gating, location and fraud (P3.1, P3.6, P3.7)

- **Gate** (one middleware, after authentication, step-up, validation and idempotency) on deposits, withdrawals, orders,
  amend, perps orders and transfers, RFQs, quotes, accept/confirm: location first (`403 geo_restricted` with country and
  source), then identity (`403 identity_verification_required` with `identity_status`, `action`, `next`), then fraud.
  Closed accounts: `403 account_closed`. The SPA shows one explanation dialog for these codes.
- **Enforcement switch** (design choice for compatibility): `npm start` / `npm run dev` enforce verification
  (`KYC_REQUIRED=0` turns it off); programmatic `start()` leaves it off unless `identity: { kycRequired: true }`,
  `KYC_REQUIRED=1` or `NODE_ENV=production`; Admin › Compliance can force it on or off at runtime (audited). This keeps the
  140 pre-Phase-3 tests valid while the Phase 3 suites run with it on.
- **Location** (simulated provider): the client IP's country from a documentation-range IP table plus admin overrides
  (`{cidr, country}`), and, when the user consents (Identity & privacy › Share browser location;
  `Permissions-Policy: geolocation=(self)`), the country of the browser's coordinates — only the derived country is kept,
  for 30 minutes. Default blocked list `CU, IR, KP, SY` (admin-editable); loopback/unknown addresses allowed by default
  (`unknown_ip: block` available). Re-checked on every gated request. A region banner ("Trading, deposits and withdrawals
  aren't available in your region (Cuba)") shows on every page while blocked.
- **Fraud signals**: a random per-browser device ID (`X-Device-Id`, stored only as an HMAC) and a UA hash — no
  fingerprinting beyond that — plus velocity rules (new account, new/shared device, 3+ devices a day, deposit/withdrawal
  velocity, withdrawing most of a fresh deposit without trading, failed sign-ins, IP country ≠ residence, phone shared)
  give a score per money movement (`risk_assessments`). A withdrawal at/above the threshold (default 60) is **held**:
  `202 {status:'held'}`, funds move into the hold (`withdrawal_hold` ledger entry). Admin › Fraud & holds (users.read;
  decisions users.money, reason, step-up, audited) releases or reverses it (`withdrawal_hold_reversal`).

### 25.7 Phone codes, email and messaging (P3.2, P3.1, RS6)

- 4-digit codes, `crypto.randomInt`, HMAC-stored, 10-minute expiry, 5 attempts (attempts left shown), a new code
  supersedes the old one, resend cooldown 30 s (configurable) with a visible countdown. Send limits (SMS-pumping
  protection, admin-editable): per number 5/h, per IP (hashed) 10/h, per account 10/day, per destination country 200/h
  with per-country overrides and a country block list; premium-rate prefixes refused. Changing a verified number needs
  step-up (SIM-swap defence) and alerts the user.
- Email verification (signed, single-use, 24 h; fingerprinted to the address, so a changed email kills old links) is sent
  at sign-up and after an email change. Password reset: uniform `202` answer for known/unknown/rate-limited emails (3 per
  address per hour, 20 per IP), 30-minute single-use signed link fingerprinted to the current password hash (any other
  outstanding link dies), policy enforced, all sessions revoked, user alerted. Tokens are stored as SHA-256.
- Transports: dev outbox (default outside production; `/dev/mailbox` page and `/v1/dev/{mailbox,sms}`, **loopback clients
  only, never registered in production**), SMTP (`SMTP_URL`, `MAIL_FROM`; STARTTLS required before AUTH; only masked
  metadata kept), SMS webhook (`SMS_WEBHOOK_URL`, `SMS_WEBHOOK_TOKEN`). In production without a provider, SMS fails with
  `503 sms_unavailable` (no silent drop).

### 25.8 OAuth and passkeys (P3.3, P3.4, A2)

- **OAuth/OIDC**: authorization-code flow with PKCE S256, `state` (single use, 10 min, bound to the browser's
  login-CSRF cookie, or to the session when linking) and `nonce`; exact redirect URI; ID-token signature (RS256/ES256 via
  JWKS), issuer, audience, expiry checks. Existing link → sign-in (two-factor still applies); provider-verified matching
  email → the account password is required before linking; unverified match → refused; otherwise a new account without
  a password. Linking from Account needs step-up; unlinking the last sign-in method is refused. Real Google/Apple only
  with `identity.oauth.<p>.{clientId, clientSecret}`; otherwise, outside production, the built-in mock provider at
  `/mock-oidc/<p>/…` (its own page with a nonce'd style, invented test identities). `GET /v1/auth/csrf` now keeps an
  unexpired login-CSRF cookie (≥10 minutes left) so the state binding survives the redirect's page load.
- **Passkeys**: attestation `none`, ES256/EdDSA/RS256, discoverable credentials with user verification; checks
  `clientData.type`, origin, `crossOrigin`, single-use 5-minute challenge bound to the login-CSRF cookie (sign-in) or the
  session (registration, step-up), rpIdHash, UP+UV flags, credential id, signature, and the **signature counter** (a
  non-increasing counter is refused as a possible clone). A user-verified passkey satisfies two-factor and step-up.
  Admin option: staff must sign in or confirm with a passkey before any admin route answers.
- **A2** (observed §13.19): `GET /users/:uid/passkeys`, `/sign_in_methods` and `/api_keys` — and passkey registration,
  provider linking and API-key creation — answer exactly `403 {"error":{"code":"permission_denied","message":"You do not
  have permission to perform this action","details":"Please make sure you are logged in with the correct account.
  Contact support if you believe this is an error.","support_action":"support_chat"}}` until identity verification is
  approved; changes additionally need a fresh step-up. Design choice: staff accounts are exempt (they can be required to
  use passkeys for the admin panel). API keys themselves are Phase 7; the endpoint returns an empty list once unlocked.

### 25.9 Account area (A3–A6, A12; CLONE_SPEC §13.16, §13.19)

- **Header**: trophy icon (leaderboard) and ☰ menu: Leaderboard and Rewards round buttons; Account & security · Your
  activity · Invest · Liquidity Rewards · Documents · API Docs · Settings; collapsible Trust ▾ / Research ▾ / Support ▾;
  Enter promo code; Log out (plus Portfolio, Admin for staff, and the light/dark quick switch the earlier tests use).
  Destinations of later phases (Liquidity Rewards — Phase 5, API Docs — Phase 7, Trust/Research/Support — Phase 8) open
  placeholder pages that say so. A list icon at the start of the category strip opens the category index (categories
  and subcategories).
- **Frame** `/account/*`: content left, right-hand card nav with icons — Account & security (`/account`, sub-tabs
  Security · Identity & privacy · Social profile · Account limits · Price alerts — the earlier sections moved here) ·
  Your activity (`/account/activity`) · Documents (`/account/taxes`) · Settings (`/account/settings`).
  `/account/appearance` redirects to Settings. At 900 px and below the nav becomes a horizontal strip above the content.
- **Your activity**: condensed title with a ⤓ icon, chips **All · Deposit · Withdrawal · Order · Trade · Settlement ·
  Credit** over `server/history.js` (new `activity` filter; ledger kinds `credit`, `withdrawal_hold`, `…_reversal`,
  `closure_payout` added), CSV of the chosen chip, empty state "No activity with these filters", chip remembered per
  account.
- **Documents**: explanatory paragraph (realized P&L per year incl. fees and credits/rebates, updated monthly, **not tax
  advice**); table **Year · PnL with fees · PnL without fees · Transactions ⤓**; yearly statements as chips per year
  (simulated 1099-INT when interest > 0, 1099-MISC when credits > 0, and a P&L summary), each as CSV and **PDF** (our own
  PDF 1.4 writer, standard Helvetica, exact xref offsets), all stamped "SIMULATED STATEMENT – NOT A TAX FORM – NOT TAX
  ADVICE". Realized P&L replays fills per market (average cost; YES+NO pairs redeem for $1 as the engine nets them) plus
  settlements; tests check it equals the engine's realized P&L and the cash effect of a closed round trip.
- **Settings**, in the observed order: (1) "Browse and manage markets by" Payout and odds / Shares and prices with a live
  preview card (the real card component on an invented market), applied to every market card (Yes/No share-price buttons
  instead of multiplier + % pill); (2) Connected apps (`oauth_grants`; list/remove; empty until Phase 7 issues grants);
  (3) Notifications — **Phase 2's module** (`views/notification-settings.js`, `mountNotificationSettings`); (4) Marketing
  text messages — status line, our own SMS disclosure (versioned, hashed), consent checkbox, "Opt in to marketing texts" /
  "No thanks" / "Opt out"; requires a verified phone; every opt-in/opt-out is an append-only `marketing_consents` row
  (time, text version, text SHA-256, phone last 4, IP prefix, device); a new text version requires re-consent; (5) Security
  notifications — Phase 2's `mountSecurityNotificationSetting` (single source of truth in its preferences); (6) Theme
  System (follows `prefers-color-scheme` live) / Light / Dark and **Accessible colors** (Yes blue / No orange, both
  themes, via CSS custom properties app-wide); (7) Trade mechanics — Flip sell, Auto-sell prompt after buy, Skip order
  review, Collateral return (stored now, tagged "takes effect in Phase 5"), RFQ opt-in (the existing `rfq_enabled`, live)
  with a terms link, Advanced shard settings (Phase 9 note); (8) Market preview price type — Last traded / Current buy,
  applied to the home cards and hero and to the portfolio price column ("Mark" / "Buy now"). Preferences are validated
  strictly server-side (`PUT /users/:uid/preferences`) and stored in `user_settings`, so they apply on load on any device.
- **Rewards** (`/rewards`, `GET /v1/rewards/new_user_checklist` → `{variant, steps:[{step,status}]×4, revamp_enabled}`):
  verify identity · first deposit · first trade · create profile. **Promo codes**: created in Admin › Promo codes
  (users.money; code, credit ≤ $1,000, max redemptions, window; audited), redeemed from ☰ › Enter promo code or Rewards:
  validated server-side, single use per account (unique key), global cap enforced by a conditional update, 10 failed
  attempts per hour per account, identity verification required when gating is on, credited to the ledger as kind
  `credit` (shows under Activity › Credit and on the 1099-MISC statement). Referrals/promotions are Phase 8.

### 25.10 Privacy: export and closure (P3.8)

- **Export** (`POST /users/:uid/data_export`, owner, fresh step-up): one JSON file — account, identity (own decrypted
  details; national ID masked), settings, preferences, consent records, orders, fills, positions, settlements, ledger,
  watchlist, notifications, alerts, limits, social, chat, perps, security (sessions, events, passkeys, linked providers,
  devices), holds, document metadata (no photos).
- **Closure** (`POST /users/:uid/close_account {confirm:'CLOSE'}`, fresh step-up): refused while event-contract or perps
  positions are open, perps orders rest, perps collateral remains or a withdrawal is held; resting orders and open
  RFQs/quotes are canceled; remaining cash is paid out (`closure_payout`); **crypto-shredding**: the user's data key is
  deleted, ciphertexts and ID photos cleared, phone challenges, emails, SMS, tokens, MFA, passkeys, provider links and
  location checks deleted; the account row stays (ledger and fills keep their references) with a placeholder email,
  name and an unusable password; sessions revoked. The audit row `privacy.account_closed` carries no email or other PII.

### 25.11 Residual security items closed

- **RS2**: after `accountThreshold` failures an account is no longer hard-locked: each further sign-in must carry a
  proof of work (`SHA-256(id:nonce)` with 12 leading zero bits, +1 per further failure up to 18; HMAC-signed, bound to the
  email's key, 2-minute, single use). The answer keeps the same shape for unknown emails (`429 too_many_attempts`,
  `retry_after_sec: 0`, `pow`). The sign-in page solves it automatically ("Checking your browser…"). Per-IP backoff stays
  a hard limit. The owner is alerted once ("Repeated failed sign-ins").
- **RS3**: the last accepted TOTP time step is stored per user (`mfa.last_step`); a code for that step or an earlier one is
  refused for login, step-up, enabling and disabling; acceptance is a conditional update (no double use under a race).
- **RS6**: real SMTP and SMS-webhook transports behind the messaging abstraction (§25.7).
- **RS9**: the admin module no longer answers `account_locked` before the password check; a locked account answers a
  wrong password byte-for-byte like any other account.
- **RS10**: the SPA sends `X-Plx-Idle` (seconds since the last real interaction: pointer, key, wheel, touch) on every
  request; the server advances the session's last-seen time only to `now − idle`, so background polls no longer keep an
  idle session alive. WebSocket (re)connects do not count as activity. Clients without the header (API scripts) count
  every request.

### 25.12 API summary (all under `/v1`; every route classified in `tests/authz.e2e.test.js`)

| Area | Routes | Who |
|---|---|---|
| Config | `GET identity/config`, `identity/countries` | public |
| Onboarding | `GET users/:uid/sign_up`, `POST resume_sign_up`, `POST users/:uid/sign_up/{skip,submit}`, `PUT users/:uid/sign_up/{name,birthday,address}`, `GET address/suggest` | owner / user |
| Phone | `POST users/:uid/verify_phone/send`, `POST users/:uid/verify_phone` | owner |
| Documents | `GET users/:uid/docv`, `POST users/:uid/docv/{sessions,documents,submit,exit}`; `POST docv/handoff/{claim,documents,submit}`, `GET docv/handoff` | owner; handoff token / capture cookie |
| Email, reset | `POST users/:uid/email_verification`, `POST verify_email`, `POST passwords/reset`, `GET passwords/reset/:token`, `PUT passwords/reset/:token/confirm` | owner; public (signed tokens, login CSRF) |
| OAuth | `POST oauth/:provider/{start,callback}`, `POST oauth/link`, `POST users/:uid/oauth/:provider/link`, `GET users/:uid/oauth`, `DELETE users/:uid/oauth/:provider`; mock `/mock-oidc/:provider/{authorize,token,jwks}` | public (login CSRF) / owner (+A2, step-up) |
| Passkeys | `POST users/:uid/passkeys/registration[/options]`, `GET`/`DELETE users/:uid/passkeys[/:id]`, `POST passkeys/authentication[/options]`, `POST passkeys/step_up[/options]` | owner (+A2, step-up) / public / user |
| A2 | `GET users/:uid/sign_in_methods`, `GET users/:uid/api_keys` | owner (+A2) |
| Privacy | `GET users/:uid/identity`, `POST users/:uid/data_export`, `POST users/:uid/close_account` | owner (+step-up) |
| Compliance | `GET`/`POST users/:uid/geolocation`, `GET users/:uid/withdrawal_holds` | owner |
| Account area | `GET`/`PUT users/:uid/preferences`, `GET`/`POST users/:uid/marketing_consent`, `GET users/:uid/connected_apps`, `DELETE …/:id`, `GET users/:uid/activity[.csv]`, `GET users/:uid/tax_documents`, `…/:year/transactions.csv`, `…/:year/:form.{csv,pdf}`, `GET`/`POST users/:uid/promo_codes`, `GET rewards/new_user_checklist` | owner / user |
| Admin | `GET admin/kyc/queue`, `POST admin/kyc/:userId/decision`, `GET admin/kyc/:userId/documents`, `POST …/documents/:docId/view`, `GET admin/identity/users/:id`, `POST …/unmask`, `GET`/`PUT admin/compliance/settings`, `GET admin/fraud/overview`, `POST admin/fraud/holds/:id/:action`, `GET`/`POST admin/promo_codes`, `PUT admin/promo_codes/:id` | users.read / users.support / settings.write / users.money |
| Dev | `GET dev/mailbox`, `GET dev/sms` | non-production, loopback only |

Tables (all `CREATE TABLE IF NOT EXISTS`, idempotent column migrations): `identity_profiles`, `identity_keys`,
`identity_tokens`, `identity_request_log`, `phone_challenges`, `sms_send_log`, `sms_outbox`, `kyc_jobs`, `kyc_decisions`,
`docv_sessions`, `docv_documents`, `geo_checks`, `device_sightings`, `risk_assessments`, `withdrawal_holds`,
`oauth_requests`, `oauth_links`, `oauth_link_tokens`, `mock_oidc_codes`, `mock_oidc_keys`, `passkeys`, `webauthn_users`,
`webauthn_challenges`, `session_amr`, `login_pow_used`, `marketing_consents`, `oauth_grants`, `promo_codes`,
`promo_redemptions`, `promo_attempts`; `mfa.last_step` added. Settings row `admin_settings.compliance`.

### 25.13 Tests

- `tests/onboarding.e2e.test.js` (5): full UI flow with QR handoff to a 390 px phone context, QR modules compared with the
  encoder for the exact handoff URL, live desktop updates, EXIF/GPS/trailing bytes stripped, encrypted at rest, erased at
  the decision, gating before/after, no plaintext PII in a full DB dump, masked APIs; handoff security (single use,
  expiry, session binding, bad file type, missing CSRF, exit keeps progress, same-device fallback); Review → admin queue
  (masked, audited reveal and document view, decision with step-up) / Reject / Retry; "Not now" + banner + reload
  persistence, validation (phone, wrong code with attempts left, cooldown, server-side underage, PO box, ID format without
  echo, duplicate ID); SMS per-number and per-country limits, 390 px on every step, restart with a queued KYC job.
- `tests/identity2.e2e.test.js` (13): email verification and password reset through the dev mailbox; OAuth via the mock
  provider (UI, state/PKCE/binding/code-injection tampering, account linking); A2 envelope + passkeys with Chromium's CDP
  virtual authenticator (register with step-up, sign in, counter regression, forged signature, passkey step-up); admin
  passkey policy; RS2, RS3, RS9, RS10; location (IP override, browser geolocation, banner, dialog); fraud hold and
  reversal; export and closure.
- `tests/account-area.e2e.test.js` (5): frame, ☰ menu order, placeholders, category index, sub-tabs, 390 px; activity
  chips/CSV/empty/persistence; documents P&L/CSV/PDF/IDOR; settings order, each setting persisted and applied (cards,
  theme incl. system, accessible palette, consent records, connected apps, Phase 2 modules, trade mechanics, preview
  price on home and portfolio, strict validation, fresh-browser reload); promo codes, checklist, restart.

**Changes to existing tests** (minimal):
- `tests/security-perimeter.e2e.test.js`: `Permissions-Policy` now expects `geolocation=(self)` (P3.6 browser location).
- `tests/auth-security.e2e.test.js`: the backoff test asserts RS2 (proof of work instead of a timed lock: 429 with a
  challenge for known and unknown emails alike, single-use proofs, growing difficulty, "Repeated failed sign-ins" alert,
  the browser still signs in); TOTP codes come from `freshTotp()` (next unused 30-second step, RS3) in `enableMfa`, the
  two-factor-off flow (step-up code first, then a newer code for the retried request), the withdrawal step-up and the
  restart sign-in; the in-page withdrawal promises are awaited with a 20-second bound so a refused code cannot hang.
- `tests/features.e2e.test.js`: `freshTotp()` for enable / sign-in / disable (RS3); the reply button locator is
  `[data-reply] button[type=submit]` because Phase 2 added a Sticker button to the reply form.
- `tests/authz.e2e.test.js`: the 82 Phase 3 routes classified.
- `package.json`: the three Phase 3 suites added to `test:e2e`.

### 25.14 Residual risks

- The KYC provider, location provider and fraud scoring are **simulations**; no real identity, sanctions or geolocation
  checks run. Browser geolocation is user-controlled and spoofable; VPNs defeat the IP table.
- Images are re-encoded in the browser and container-sanitised on the server, not re-encoded server-side (no image
  library); a malicious client can upload a crafted but structurally valid JPEG/PNG. Images are never served to anyone
  but staff as `data:` URLs inside the admin page.
- Data keys are wrapped by one master key without rotation (RS4, Phase 9). A database **and** key compromise exposes PII.
- The dev mailbox/SMS endpoints exist in any non-production build; they are loopback-only, but a dev server exposed
  through a local reverse proxy would show them to that proxy's clients.
- The handoff link can be forwarded by the user to someone else within 10 minutes (as with any vendor QR flow); the
  desktop sees the phone connect and can exit.
- Proof of work raises the cost of online guessing but does not stop a determined, well-resourced attacker; the per-IP
  hard limit and password policy remain the main defences.
- A2 exempts staff accounts by design; staff identity is assumed verified out of band.

---

## 26. Payments (sandbox only)

Phase 4 of `PLAN.md` (P4.1 rails, P4.2 withdrawal MFA, holds, limits, AML hooks, reconciliation, double-entry ledger
audit; the §6 security gate). **No real money, no real providers, no real personal data**: every rail is an in-process
sandbox with invented institutions, test card numbers and a test chain. Vendor names that appear in the observed call
sites are replaced by neutral ones throughout.

### 26.1 Evidence vs design choice

| Observed (evidence) | Clone |
|---|---|
| Funds call sites in the public bundle (`evidence/api_callsites_home.txt` lines 11–218, §6): `debit/{cards,payment_session,payment,payment_status_web,withdrawal}`, `banks/{all_accounts,linked_accounts}`, a bank-link provider's `accounts`/`deposit`/`withdrawal`, `crypto/{account (GET/PUT),wallets,withdrawal}`, a global `…/supported_networks`, `…/withdrawal_addresses`, `deposits`, `withdrawals`, `withdrawal_times`, `payments/metadata`, `credit_history`, `deposit_limits` | Same resource families and verbs under `/v1/users/:uid/` (bank-link provider → `bank_link/…`; networks → `GET /v1/payments/supported_networks`; addresses → `withdrawal_addresses`) |
| `nonwithdrawable_credits: {predictions: {amount_cents, amount_dollars, expiry_days, credits[]}, perps: {…}}` in `/v1/rewards/referrals/summary` [HAR5]; the referral offer's `referee.threshold_cents` | Same shape in `payments/metadata` and `credit_history`; credits are tradable, not withdrawable, and expire; `grantCredit()` is the Phase 8 hook for referral rewards |
| `Idempotency-Key` in the API CORS allowlist (PLAN §2 S4); `enableWithdrawalMfa`, `action_verification_mfa` (S9) | Required on every rail deposit / withdrawal; step-up and withdrawal two-factor on withdrawals and new payout destinations |
| Deposit / withdraw **screens**, provider flows, settlement times, fees, limits, AML rules, ledger internals | **UNKNOWN.** The live site serves a bot checkpoint to automated browsers and we do not bypass it, so the UI and all behaviour below are **Parlance design** (research R2/R3 still open) |

### 26.2 Provider interface and sandbox rails (`server/payment-providers.js`)

One object per rail, like the KYC sandbox provider (§25.5): `card {tokenize, charge, completeChallenge, payout}`,
`bank {institutions, link, debit, payout}`, `crypto {newAddress, validAddress, simulateIncoming, send, mine}`. Each call
returns the provider's own record. **Every later status change reaches the exchange only through the signed webhook
endpoint** (§26.3): the provider side writes its record (`sbx_provider_records`), queues an event (`sbx_webhook_outbox`)
and a delivery worker POSTs it to `/v1/payments/webhooks/<provider>` over loopback HTTP once the server listens (before
that, the identical verify-and-apply function in process). Delayed transitions are rows in `sbx_provider_jobs` with an
absolute due time, so a restart resumes them; undelivered events are retried with backoff (12 attempts) in order.

- **Card** (`sandbox_card`): only the documented test numbers are accepted; any other number (possibly a real card) is
  refused and nothing is kept. Behaviour by number: approve `4000 9910 0000 0002` / `5500 9910 0000 0004`, decline
  `4000 9920 0000 0000`, insufficient funds `4000 9930 0000 0008`, 3-D Secure-style challenge `4000 9940 0000 0006` /
  `5500 9940 0000 0008` (invented, Luhn-valid; any future expiry, any CVC). Card payouts go only to a card that has paid
  in (closed loop); decline / insufficient-funds cards fail the payout.
- **Bank** (`sandbox_bank`, ACH-like): institutions Maple Test Bank, Harbor Sandbox Credit Union, Cedar Example Savings;
  sandbox sign-in `sandbox` / `sandbox-pass` (checked, never stored). Accounts ••0001 (settles; payouts arrive), ••0002
  (deposits are returned R01 insufficient funds), ••0003 (payouts fail R02 account closed). A debit is accepted at once
  (`ach_debit.pending`) and settles or returns after `sandbox.ach_settle_seconds` (default 30 s); payouts after
  `sandbox.payout_seconds` (10 s).
- **Crypto** (`sandbox_crypto`, testnet-style): asset "tUSD" on the "Sandbox chain"; addresses `tpx1` + 28 base32
  characters + a 6-character SHA-256 checksum, format-validated. A per-user deposit address after accepting the terms
  (`PUT crypto/account`). Incoming transfers (sandbox trigger `POST crypto/simulate_deposit`) are credited after
  `crypto.confirmations` blocks (default 3); a block every `sandbox.block_seconds` (5 s; 0 = manual) or on Admin ›
  Payments `sandbox/crypto/mine`. Withdrawals carry a network fee (`fees.crypto_network_fee_cents`, $1.00), deducted from
  the amount sent, and are paid at the next block.

### 26.3 Webhooks (`POST /v1/payments/webhooks/:provider`)

- Header `Parlance-Signature: t=<unix seconds>,v1=<hex>`, `v1 = HMAC-SHA256(key, "<t>.<raw body>")`, compared in constant
  time. Per-provider keys are HKDF sub-keys of the master key (`server/crypto.js`, `SECRET_KEY` / `secret.key`).
- 5-minute tolerance on `t`; event ids deduplicated in `webhook_events` inside the same transaction that applies the
  event (a replay answers `409 webhook_replayed`, nothing is re-applied). Unsigned / malformed → `400
  webhook_signature_missing`, wrong signature → `webhook_signature_invalid`, old → `webhook_timestamp_stale`.
- Raw body (64 KB) read by the route itself, before the session, CSRF and client-token middleware; anonymous rate tier.
- Every outcome is in `webhook_log` (Admin › Payments › Webhook log); rejections also go to the security log
  (`security_events`, kind `webhook_rejected`, with the reason code).
- Effects are state machines (`charge.*`, `ach_debit.{pending,settled,returned}`, `payout.{paid,failed}`,
  `crypto_deposit.{detected,confirmation}`, `crypto_withdrawal.confirmed`): an event that does not match the current
  status is ignored, so out-of-order or duplicate delivery is harmless.

### 26.4 Card data and PCI scope

- The card number and CVC go only to `POST /v1/payments/tokenize/card`, an app-level route with its own 1 KB raw-body
  parser (the shared JSON parser skips the path, so no parser error object ever holds a number). The buffer is zeroed,
  the values dropped, errors are fixed codes (`card_number_invalid`, `card_not_sandbox`, …) that never echo input.
- A tokenization needs a fresh card payment session (`POST debit/payment_session`, 15 min, 5 uses) and is limited to
  10 per user per 10 minutes (card-testing control).
- Stored: token, brand, last 4, expiry, sandbox behaviour (`sbx_card_vault`); saved cards (`payment_methods`) keep the
  token, brand, last 4 and expiry. Bank accounts: mask + provider token only. The SPA clears the card fields at submit.
- Proof: `payments.e2e.test.js` greps the database file and WAL bytes (Latin-1 and UTF-16), every server log line and
  every API response for each test number (with and without spaces): none.
- The sandbox test-card hint list is served by `GET /v1/users/:uid/payments/sandbox/test_cards` (signed in; 404 when
  the sandbox rails are off, i.e. in production) instead of being bundled in client code, so no Luhn-valid number ships in
  public JavaScript or is reachable by an anonymous crawler (the ZAP baseline flagged one as PII once the service worker
  exposed every bundle URL). A test scans `public/` and `dist/` for card-shaped numbers.

### 26.5 Money rules (design choices)

- **Card**: credited when `charge.succeeded` arrives (normally within ~200 ms); a challenge (`requires_action`) shows the
  sandbox issuer's Approve / Fail step, then the client polls `debit/payment_status_web` (observed) and listens on the
  private `payments` WebSocket channel.
- **ACH**: credited at `ach_debit.pending`, so **unsettled funds can be traded at once but not withdrawn** until
  `settled` (withdrawable = cash − unsettled bank deposits). Choice: matches common brokerage practice and keeps the
  exposure to the value of the deposit.
- **Returns**: the return always comes out of **cash**, which may go **negative**: that negative cash is the debt
  ("You owe $X" on Transfers). Withdrawals are refused (`negative_balance`) until a deposit repays it; credits are never
  used to cover it; the user is notified.
- **Credits** (observed `nonwithdrawable_credits`): a promo / reward credit is posted to the user's credits account.
  Orders spend credits first; money an order releases goes back to credits up to what that order took from them; fills,
  netting and settlement pay cash. Credits cannot be withdrawn (`credits_not_withdrawable`) or moved to Perps
  (`credits_not_transferable`); unused credit expires after `credits.expiry_days` (30), removed by a job. Withdrawable
  = cash − non-withdrawable credits − unsettled ACH (cash already excludes credits).
- **Limits**: withdrawals per UTC day ($25,000) and calendar month ($100,000) across every method; deposit maxima per
  rail; the §13.8 daily deposit limit counts in-flight rail deposits too.
- **Demo funds**: `POST deposits` / `withdrawals` **without** `method_id` stay the instant simulated method (all existing
  clients and tests); journaled, limits and AML apply; off in production (`PAYMENTS_DEMO_FUNDS`); `Idempotency-Key`
  honoured but optional there. With `method_id` the same routes use the rail (key required).

### 26.6 Double-entry journal (`server/journal.js`)

- `journal_entries` + `journal_postings` (signed cents; each entry sums to zero) + `journal_balances` (materialised).
  Accounts: `user:<id>:{cash,credits,reserved,held}`, `escrow:<ticker>`, `clearing:<rail>`, `payouts:<rail>`,
  `house:{fees,fees:network,interest,promotions,adjustments,suspense}`, `perps:collateral`, `payouts:closure`,
  `equity:opening`. The single-entry `ledger` table is unchanged and stays the user-facing statement.
- **Hooked centrally** in `server/engine.js`: `credit()` (every deposit, withdrawal, refund, netting, settlement,
  interest, credit, adjustment, perps transfer, hold, closure payout — contra account by kind, or an explicit one from
  the rails), `ledgerOnly()` (trade principal → market escrow, taker fee → `house:fees`) and the order reservation
  (cash/credits → reserved). No call site changed; system accounts inserted with a balance get an opening entry.
- **Migration**: on first start, every user's cash, reservations and holds and every market's open interest get an
  opening entry against `equity:opening`; later, any account with money but no postings is opened the same way.
- **Audit** (job every 10 minutes, Admin › Payments › Ledger audit, `POST …/ledger_audit/run`): every entry balances;
  the trial balance is zero; materialised balances equal posting sums; cash + credits = `users.balance_cents`;
  reserved = Σ `orders.reserved_cents`; held = open withdrawal holds; each market's escrow = its open interest
  (Σ YES = Σ NO units); `payouts:<rail>` = processing withdrawals; nothing in suspense. The full suite was run with the
  audit on every test server's database at shutdown: every database balanced except in two suites that fabricate state
  with raw SQL (`idempotency` inserts 3,000 resting maker orders and debits the balance directly for G2; `fractional`
  writes a one-sided position into a pre-fractional database), where the audit correctly reports the out-of-journal
  change. That is the check doing its job, not a missing hook.

### 26.7 Holds, limits, AML hooks, step-up

- Risk score (§25.6) on every rail withdrawal; at/above the threshold the withdrawal is **held** through the existing
  `withdrawal_holds` (`compliance.createHold`). Releasing a held rail withdrawal in Admin › Fraud & holds (or from the
  AML case) sends it to its provider; reversing returns it.
- AML rule hooks (Admin › Payments settings: `off | case | hold`): **structuring** (≥ 3 deposits within 24 h in the band
  just under $10,000), **rapid deposit-then-withdraw** (a withdrawal ≥ 80 % of the last 24 h's deposits with no trade),
  **first crypto withdrawal to a new address** (default `hold`). Cases (`aml_cases`) are opened with an audit-chain row,
  and closed or escalated with a reason, step-up and audit.
- Step-up (§22.6) on every withdrawal and on each new payout destination (`banks/linked_accounts`, `crypto/wallets`);
  with withdrawal two-factor on, a fresh authenticator code per withdrawal / destination. A new crypto address has a
  **cooling period** (24 h) before withdrawals to it; the user gets a security alert when a destination is added.

### 26.8 Reconciliation (`server/payments-admin.js`)

Job every 15 minutes and on demand: each provider record vs its transaction (missing in ledger, missing at provider,
amount, status) and each transaction's journal effect vs its status (ledger mismatch). Mismatches go to the queue
(`recon_items`, signature-deduplicated); resolution (`acknowledge`, or `adjust_user` for an amount mismatch on a credited
deposit, which posts the difference) needs `users.money`, a reason and step-up, and is written to the hash-chained audit
log. A resolved signature is not raised again.

### 26.9 Admin › Payments

Sub-tabs: Transactions (house/provider account balances, every transaction), Reconciliation (run, resolve), AML cases
(close / escalate; release / reverse the linked hold), Ledger audit (live result, recorded runs), Provider settings
(rails on/off, limits, fees, confirmations, cooling, credit lifetime, sandbox timings, AML rule actions; `settings.write`,
reason, step-up, audit), Webhook log (received events and the sandbox delivery queue; `audit.read`). Views need
`users.read`; money and case decisions `users.money` (existing permissions, no role change).

### 26.10 UI (Parlance design)

- `/funds` Transfers: cash, withdrawable, non-withdrawable credits (with expiry), settling, owed, under review; recent
  transfers with live status; credits. ☰ menu "Deposit & withdraw" and a link on Portfolio.
- `/funds/deposit` and `/funds/withdraw`: method picker (saved cards / banks / addresses, add card, link bank, crypto,
  demo funds) → amount (per-method min / max / fee / ETA from `payments/metadata`, withdrawable shown) → review →
  status (live over the `payments` channel; card challenge inline; `/funds/challenge/:id`).
- Account › Account & security › **Payment methods**: cards, bank accounts, crypto deposit address, withdrawal addresses
  (cooling badge); add / remove. Styles in `public/payments.css`, no inline styles (CSP nonces), 390 px clean.
- Your activity and History show deposits, returns, withdrawals, network fees, reversals and expired credits (chips
  Deposit / Withdrawal / Credit); Transfers notifications (Settings › Notifications › Transfers: in-app, email, push).

### 26.11 Endpoints (all `/v1`; every route classified in `tests/authz.e2e.test.js`)

| Area | Routes | Who |
|---|---|---|
| Generic | `GET|POST users/:uid/deposits`, `GET|POST users/:uid/withdrawals`, `GET users/:uid/withdrawal_times`, `GET users/:uid/payments/metadata`, `GET users/:uid/credit_history`, `GET users/:uid/withdrawal_addresses` | owner |
| Cards | `GET users/:uid/debit/cards`, `DELETE …/:id`, `POST users/:uid/debit/{payment_session,payment,withdrawal}`, `GET users/:uid/debit/payment_status_web`, `POST users/:uid/debit/payment/:id/challenge`; `POST payments/tokenize/card` | owner; user |
| Bank | `POST|GET users/:uid/bank_link/accounts`, `DELETE …/:id`, `POST users/:uid/bank_link/{deposit,withdrawal}`, `GET users/:uid/banks/all_accounts`, `POST users/:uid/banks/linked_accounts`, `DELETE …/:id` | owner |
| Crypto | `GET|PUT users/:uid/crypto/account`, `GET|POST users/:uid/crypto/wallets`, `DELETE …/:id`, `POST users/:uid/crypto/{withdrawal,simulate_deposit}`; `GET payments/supported_networks` | owner; public |
| Webhooks | `POST payments/webhooks/:provider` | public (HMAC) |
| Admin | `GET admin/payments/{overview,transactions,reconciliation,aml_cases,ledger_audit}`, `POST admin/payments/reconciliation/{run,:id/resolve}`, `POST admin/payments/aml_cases/:id/:action`, `POST admin/payments/ledger_audit/run`, `POST admin/payments/sandbox/crypto/mine`, `GET|PUT admin/payments/settings`, `GET admin/payments/webhooks` | users.read / users.money / settings.write / audit.read |

Tables: `payment_methods`, `payment_transactions`, `crypto_accounts`, `bank_link_sessions`, `card_payment_sessions`,
`webhook_events`, `webhook_log`, `aml_cases`, `recon_runs`, `recon_items`, `journal_entries`, `journal_postings`,
`journal_balances`, `journal_order_credits`, `credit_grants`, `ledger_audits`; provider side `sbx_card_vault`,
`sbx_bank_accounts`, `sbx_provider_records`, `sbx_provider_jobs`, `sbx_webhook_outbox`. Settings row
`admin_settings.payments`. WebSocket: private channel `payments`.

### 26.12 Tests (`tests/payments.e2e.test.js`, 9 scenarios)

Card approve / decline / challenge in the browser (live header balance, Transfers notification, Your activity),
insufficient funds, failed challenge, non-test number refused, closed-loop card payout, 390 px; bank link in the browser,
ACH pending → settled with unsettled funds tradable but not withdrawable, payout, a return that reverses the credit and
leaves a debt repaid by the next deposit; crypto address, confirmations 1 → 3, a new address with step-up in the UI and
a cooling period, the AML hold released in Admin, network fee, withdrawal two-factor; webhooks unsigned / bad signature
/ stale / replayed refused and logged, a signed event applied once; Idempotency-Key required, replayed, conflicting;
withdrawal limit, structuring and rapid in-out cases with audit, non-withdrawable credits (spent first, returned on
cancel, not withdrawable or transferable, expired by the job); reconciliation amount mismatch resolved in Admin (audit
chain verified), missing-at-provider, ledger audit balanced in the UI and catching a direct balance edit; a pending ACH
settlement and payout resuming after a restart; no card number in DB, WAL, logs or responses.

**Changes to existing code and tests** (small, exact edits): `engine.js` (journal hooks), `compliance.js` (shared hold
creation, release listener, withdrawal precheck), `identity.js` (rail routes in the gate), `auth.js` (step-up list),
`idempotency.js`, `validate.js` (schemas, raw-body paths, `method_id` on the money schema), `history.js` (new ledger kinds,
rail status), `notify-prefs.js` (rail transfers notify on completion), `ws.js` (`payments` channel), `perps.js` (credits
stay with predictions), `sports.js` (opening entry for its system account), `security.js` (stylesheets served relative to
their root, so a checkout under a dot-directory works), `app.js` / `index.js` (wiring). Tests: `authz.e2e.test.js`
classifies the 44 new routes; `package.json` adds the suite. No existing assertion changed.

### 26.13 Residual risks

- Simulations only: no real processor, ACH network or chain; webhook secrets are derived, not exchanged with a provider;
  delivery is loopback. A production integration needs the provider's real signature scheme and IP allowlisting.
- The tokenizer runs inside the exchange process (a real deployment uses the provider's hosted fields, taking card data
  entirely out of scope); memory is not scrubbed beyond dropping references and zeroing the request buffer.
- AML rules are three simple hooks, not a monitoring programme (no sanctions screening, no SAR workflow).
- Credits consumption is conservative (released order funds go back to credits first) and per order, not per grant.
- Single-process SQLite: the journal, jobs and provider worker assume one server (PLAN §10 RS1, Phase 9).
- The ledger audit detects inconsistencies; it does not prevent a writer with database access from changing both sides.

## 27. Visual system

### 27.1 Observed vs. Parlance design

| Aspect | Observed on the live site (§13.2, §15) | Parlance |
|---|---|---|
| Theme | Dark default; semantic `surface/text/fill` scales with light variants | Same structure, own palette (Nigerian green brand #008751, lifted to #13a866 on dark; coral featured hub) |
| Container | `max-w-[1320px]`, `px-3` on phones | `--container: 1320px`; gutter 24px, 12px at ≤640px |
| Grid | `minmax(min(360px,100%),1fr)`, `gap-2` | Unchanged (8px gap) |
| Type classes | `typ-title-x10`, `typ-body-x20` exist; values UNKNOWN (U15) | Token scale below; `.typ-*` classes kept and mapped onto it |
| Faces | Kalshi Sans (body), Kalshi Condensed (titles) | Inter (variable) + Barlow Condensed 600/700, self-hosted, SIL OFL |
| Header | Wordmark, uppercase tracked nav, pill search, category strip | Same order; values chosen (below) |
| Odds | Outlined pill, outcome underline in its colour | Same; 40px pill, 16px bold tabular |

Values the screenshots do not give (sizes, weights, spacing, control heights) are Parlance design choices.

### 27.2 Tokens (`clone/public/app.css`, first `:root` block)

- **Type scale** (size / paired line height): `--fs-3xs` 10/12 (count badges and small monograms only), `2xs` 11/14,
  `xs` 12/16, `sm` 13/18, `md` 14/20 (body), `lg` 16/24, `xl` 18/24, `2xl` 22/28, `3xl` 28/34, `4xl` 36/40, `5xl`
  44/48. A rule that sets `--fs-N` also sets `--lh-N` unless it needs a unitless display line height.
- **Weights:** `--fw-regular` 400, `--fw-medium` 500, `--fw-semibold` 600, `--fw-bold` 700. No other weight is used.
- **Tracking:** `--ls-tight` −0.02em (wordmark), `--ls-display` −0.01em (display face, large numbers), `--ls-normal`
  0, `--ls-caps` 0.06em (uppercase labels, overlines, nav, table headers).
- **Spacing:** 4px grid with 2px and 6px half steps: `--space-half` 2, `-1` 4, `-1h` 6, `-2` 8, `-3` 12, `-4` 16, `-5`
  20, `-6` 24, `-8` 32, `-10` 40, `-12` 48, `-16` 64.
- **Controls:** `--control-sm` 32, `--control-md` 40, `--control-lg` 48. **Radii:** `--rounded-x05` 4, `-x10` 8, `-x20`
  12, `-x30` 16, `--rounded-pill`.
- **Layout:** `--container` 1320px, `--gutter`, `--header-h` (64/56px), `--strip-h` (48/44px); sticky offsets derive
  from these.

### 27.3 Rules

1. **Display face** (`--font-display`) only for display headlines: page titles, hero and event titles, section heads
   (home sections, event "People are also trading"), the event's big tabs, the ticket outcome and payout, outcome
   chances in the event table, scoreboard scores and the wordmark. Never below 16px. Everything else is Inter.
2. **One page-title style:** `.page-title` (display, 36/40 bold, 28/34 on phones) on every page (Browse, Portfolio,
   Perps, Settings and the account area, Social, Leaderboard, Notifications, Watchlist, Combos, Pro, Sports, Rewards;
   the Live title uses the same size in the live colour).
3. **Section headings inside cards** (`.panel h2`, settings sections, rail boxes): Inter 18/24 semibold.
4. **Tables:** header 12/16 semibold uppercase tracked (`--ls-caps`), cells 14/20, tabular numerals.
5. **Numbers:** `font-variant-numeric: tabular-nums` on prices, percents, money, counts, odds pills, multipliers,
   order-book and chart readouts.
6. **Controls:** one button system, `.btn` (secondary, 40px) with `.btn-primary`, `.btn-secondary`, `.btn-ghost` ×
   `.btn-sm` (32) / default (40) / `.btn-lg` (48), `.btn-pill` for the rounded shape. Native `select`, text inputs and
   textareas share one styled look (`:where()` defaults, so component rules still win); selects use `appearance:
   none` with a CSS chevron. Chips 32px, segmented controls 32px, tabs 40px with trailing actions (`.tabs > .btn`) on
   the same row. Every focusable element shows a 2px brand `:focus-visible` outline; inputs add a soft ring.
7. **Cards:** stat rows are grids with `align-items: start`, so a tall card (the Portfolio funds form) does not stretch
   the others.
8. No inline `style=""` (strict style CSP, §21.3); dynamic values go through `js/dynstyle.js` custom properties.

### 27.4 Layout fixes made with the system

- **Event header:** the icon and title share the first grid row and the title takes the whole main column; the action
  bar (Live chat, calendar, discussion, share, download, Watch, Follow, Move alert) has its own row and never overlaps
  the series label. On phones it is at most two rows; the text pills share out each row's free space.
- **Home hero:** single column at ≤760px (title, table, news, then chart); the Market / Pays out / Odds headers never
  overlap.
- **Phone header:** the wordmark stays; search collapses to a 40px icon button that expands over the header row when
  focused.
- **Portfolio:** stat cards hug their content; the funds form uses small controls; Perps / Export CSV sit on the tab
  row; the Sort select is the styled select. On phones the three values share one row and the form spans it.
- **Settings:** every section heading uses the same card-heading style, including Notifications.
- **Header nav:** uppercase is kept (observed) at 13px semibold with 0.06em tracking instead of 15px/750/0.08em; the
  category strip is 14px medium (active semibold) instead of 17px semibold.

### 27.5 Enforcement and tooling

- `clone/scripts/apply-type-tokens.js` rewrites literal font sizes, weights, letter-spacing, margins/padding/gaps and
  radii in `public/*.css` to tokens, gives a re-tokenised font size its paired line height, and renames px-named
  utility classes in the views (`mt-14` → `mt-16`, `fs-17` → `fs-lg`, `h-44` → `h-48`). It is idempotent; `--check`
  exits 1 when anything would change. Re-run it after merging branches that add CSS or views, then review display
  headlines by hand.
- `clone/scripts/visual-audit.js <outdir> <tag>` screenshots 16 pages at 1280 dark, 390 dark and 1280 light on a
  throwaway database and reports horizontal overflow and page errors.
- `clone/tests/visual-system.e2e.test.js` (6 scenarios): no literal font-size, font-weight, letter-spacing or off-scale
  spacing outside the token block (allowlist empty; `±1px` margins allowed for hairline border compensation; SVG chart
  text uses SVG user units and is out of scope); the token script is a no-op; at 1280 and 390 in dark and light: event
  title ≥ 50% of the main column at 1280, no overlap between series label, title and action bar, phone hero single
  column with non-overlapping headers, phone brand visible and search usable, portfolio stat cards not stretched,
  identical computed page-title family/size/weight/line height across Browse, Portfolio, Perps, Settings, Leaderboard
  and Social, visible focus rings, tabular numerals, control heights, and no horizontal overflow, page errors or CSP
  violations on 16 pages.

### 27.6 Choices confirmed by the owner (2026-11-03)

- Page titles stay in the condensed display face (rule 2, matching §15.1).
- Header nav 13px semibold uppercase with 0.06em tracking; category strip 14px medium.
- Market-card titles 16px semibold; other sizes as listed in §27.2.
- Brand colour: Nigerian green. Light theme `#008751` (the flag green, 4.6:1 on white); dark theme `#13a866`, the same hue lifted to 6.3:1 on the dark surface. Avatar, category and outcome palettes are data colours and unchanged. Enforced by the brand-colour scenario in `tests/visual-system.e2e.test.js`.
- YES colour: teal, so it never reads as the brand. Dark `#22c3b5` (8.8:1 on the surface), light `#0b7285` (5.6:1 on white and under white text); text on YES fills uses `--on-yes`. NO stays red. Enforced by the YES-colour scenario.

---

## 28. Trading core (Phase 5A)

PLAN.md Phase 5 (P5.1, the scalar part of P5.2, the security gate), gaps G1, G6 and G12, and A7–A9 from §13.16. Code:
`server/pricing.js` (grids, centi-cent prices, fee arithmetic), `server/engine.js` (matching, accumulator, scalar
settlement, correction primitive), `server/trading-core.js` (collateral return, corrections, two-person rule, seed
content), the ticket in `public/js/views/event.js`, Portfolio, Settings and the resolution desk. Tests:
`tests/trading-core.e2e.test.js`.

### 28.1 Price grids (P5.1)

**Observed.** Markets carry `price_level_structure` (`"linear_cent"` with `price_ranges:[{start:"0.0000",end:"1.0000",step:"0.0100"}]`,
HAR1#10). The openapi `PriceRange{start,end,step}` says to "use these ranges to determine valid prices rather than
hardcoding the structure name". The RFQ docs name `center_deci_edge_centi_cent` for combos (§17.5). Prices are 4-decimal
dollar strings (§5.1).

**UNKNOWN.** The band edges of the sub-cent structures and the exact name of the tapered one.

**Design choice.** Prices are stored as integer **centi-cents** (cc, $0.0001; $1 = 10,000 cc), which is the resolution of
the 4-decimal strings. Every grid is symmetric (p is a tick ⇔ 10,000 − p is a tick), and every grid contains every whole
cent, so integer-cent callers stay valid everywhere.

| `price_level_structure` | Bands (start–end: step) | Use |
| --- | --- | --- |
| `linear_cent` | 0–1: $0.01 | every market before Phase 5A (default) |
| `deci_cent` | 0–1: $0.001 | seeded `PLXSNOW-26DEC`, the scalar `PLXGDP-26Q4` |
| `tapered` | 0–0.01: $0.0001 · 0.01–0.10: $0.001 · 0.10–0.90: $0.01 · 0.90–0.99: $0.001 · 0.99–1: $0.0001 | seeded `PLXCOMET-26` |
| `center_deci_edge_centi_cent` | 0–0.01: $0.0001 · 0.01–0.99: $0.001 · 0.99–1: $0.0001 | every combo (G12) |

- **Storage.** New columns `orders.price_cc`, `trades.yes_price_cc`, `fills.price_cc` are authoritative. The
  `price_cents` columns stay as the rounded whole-cent view for label-only readers. Triggers fill `*_cc` for rows that
  integer-cent writers insert (seed data, simulated sports prints). The migration backfills `cc = cents × 100` and is
  additive (§28.9).
- **Engine.** `placeOrder` takes `price_cc` or the legacy `price` (cents), rejects a limit that is not a tick
  (400 `invalid_price`, with the bands in `details`), and matches by `price_cc`. Market orders use the top tick of the
  grid as the protective limit (99¢ on `linear_cent`, as before). The reservation bound generalises exactly:
  `R(n) = ceil(n·(L + 100·cap)/10^4)` with L in cc.
- **API.** `POST /users/:uid/orders` and `…/amend` accept `price_dollars` (≤ 4 decimals) or `price` in cents (decimals
  allowed). Market JSON adds `price_ranges` from the grid and `tick_size_dollars` (the smallest step). The order book,
  trades, candlesticks, the WS `ticker` / `orderbook_snapshot` / `orderbook_delta` / `trade` messages and the order and
  fill objects all emit the 4-decimal strings from cc. `GET …/orderbook` also returns the grid.
- **UI.** The ticket's limit input steps by the grid's smallest tick (1, 0.1 or 0.01 ¢), validates against the bands and
  lists them ("Ticks: …"). Prices render as `45¢`, `45.3¢`, `0.55¢` everywhere (book, outcome rows, Activity,
  Portfolio, History). The book header names a non-default grid. The chart keeps sub-cent values.

### 28.2 Fractional quantities on every grid

Quantities stay integer hundredths of a contract (§16.1). q units at p cc: the pair costs exactly q cents; the taker pays
`ceil(q·p/10^4)` and the maker `floor(q·p_maker/10^4)` (§16.2 with cc). Settlement and netting are unchanged.

### 28.3 Fee accumulator (G1)

**Observed (DOC fee_rounding, §5.1).** The trade fee is rounded **up** to $0.000001, a rounding fee realigns the balance,
and a per-order accumulator rebates the excess.

**Design choice.**
- The exact fee of a fill is `ceil(k·m·q·p·(10^4 − p) / 10^12)` micro-dollars (k = coefficient × 10^4, m = series
  multiplier × 10^4; BigInt, so it is exact at every size).
- Each order keeps an accumulator (`orders.fee_micro`). After every fill the order has been charged
  `ceil(accumulated / 10^4)` whole cents, so a fill pays `ceil(acc_after) − ceil(acc_before)` cents (it can be 0).
- The result: an order pays ceil(Σ exact fees), at most one cent of rounding per order, instead of up to one cent per
  fill. A single-fill order pays exactly what it did before, so the whole-contract tests are unchanged.
- Plans, the reservation buffer, the Positions sell estimate (`sellWalk`) and RFQ sizing use the same accumulator.
- **Journal (balances to the cent).** A fill's charge moves from `user:<uid>:reserved` to `house:fees` (the increase of
  floor(accumulated)) and `house:fees:rounding` (the rest, −1 to +1 cent). The residual below a cent is carried in
  `orders.fee_micro` (exposed as `taker_fees_exact_dollars` and `taker_fees_rounding_dollars`). The audit checks
  `house:fees:rounding = Σ(fees_cents − floor(fee_micro/10^4))` over orders. Pre-5A orders are migrated as exact
  (`fee_micro = fees_cents × 10^4`).

### 28.4 Scalar markets (P5.2, scalar part)

**Observed (openapi).** `market_type: binary | scalar`, `floor_strike`, `cap_strike`, `expiration_value`,
`settlement_value_dollars` / `yes_settlement_value_dollars`, `result: 'scalar'`, `settlement_bounds_type`.

**Design choice.**
- A scalar market is the same two-sided book. At expiration the reported value v sets the YES payout to
  `s = clamp((v − floor)/(cap − floor), 0, 1)`, rounded to the nearest $0.0001. NO pays `1 − s`.
- Each holder is paid `floor(yes·s) + floor(no·(1 − s))` cents. The up to 1¢ per holder left in escrow goes to
  `house:settlement_rounding`, so escrow ends at exactly zero.
- Binary markets are the special case s ∈ {0, 1}; it is the same code path.
- **Resolution.** The resolution desk (and the event-page admin box) asks for the value instead of YES/NO
  (`expiration_value`). The market shows the value, `settlement_value_dollars` and `result: "scalar"`.
- **UI.**
  - The outcome row reads "Scalar · pays by value, −2% to 6%".
  - A "How this market pays" card shows the formula and a worked example, then the settled value and both payouts.
  - The ticket notes the formula, the review shows the payout range, and the closed ticket shows "Settled at 3.1%: YES pays 63.75¢".
- **Seed.** An invented `PLXGDP-26Q4` (Harbor GDP growth, floor −2%, cap 6%, 0.1¢ grid).
- **Creation.** The catalog draft takes `market_type`, `floor_strike`, `cap_strike`, `scalar_unit` and
  `price_level_structure` (`catalog.write` only; the cap must exceed the floor).

### 28.5 Order review, auto-sell prompt and flip sell (A7, A8)

- **Order review.** By default (**Skip order review** off, §13.16) the ticket's button reads "Review · Buy Yes" and opens
  a review panel: the order, the price or limit (and expiry), the max cost, the fee estimate and the payout. It has
  **Edit** and **Place order**.
  - With Skip order review on, the order is placed at once.
  - A flip sell always shows the review ("unless a warning … needs acknowledgement", §13.16).
  - The panel replaces the ticket body while open, so a sticky ticket never outgrows the viewport.
- **Auto-sell prompt.** With the setting on, a buy that filled offers "Set an automatic sell?".
  - The filled size is prefilled at the average fill price (from the new `fill_avg_price_dollars` on the order
    response) + 10¢, snapped to the grid.
  - **Place sell** submits a resting limit sell, which is an ordinary GTC order.
- **Flip sell.** With **Flip sell** on, `POST orders` with `action:"sell"` and a size above the holding no longer
  returns 409 `insufficient_position`.
  - It places one order buying the other side for the full size. The held part nets back to cash first (§15.4) and
    the remainder opens the opposite position.
  - `orders.flip_units` records the opening part, and the response carries `flip:{closed_fp, opened_side, opened_fp}`.
  - The ticket shows "Flip sell: Sells 165 YES you hold and buys 10 NO at 87.8¢".
  - On whole-contract markets the opening part must be whole.
  - Without the setting, the old 409 now tells the user about the setting.
- **UNKNOWN.** The live review layout, the default auto-sell target and whether flip is one order or two.
  **Design choice:** as above.

### 28.6 Collateral return on mutually exclusive events (A9)

**Observed.** `collateral_return_type: "MECNET"` on mutually exclusive events (HAR4). The openapi `EventData` says MECNET
netting "applies within this event" and "requires netting to be enabled for the trading account" (the
**Collateral return** setting, §13.16, default on).

**Design choice.**
- **Guarantee.** At most one outcome of the event resolves YES, and possibly none. The guaranteed payout of a user's
  positions is `G = Σ no − max(0, maxᵢ(noᵢ − yesᵢ))`.
  - Determined outcomes count at their known payout.
  - Once any outcome is known YES, every other outcome pays its NO side exactly.
  - Events with a scalar market never qualify.
- **Advance.** The engine re-derives the user's advance for that event inside every fill and settlement transaction
  (`positionHooks`, `settleHooks`), keeping it at G.
  - The difference is a ledger entry of kind `collateral_return` against `house:collateral_advance` (positive when
    released, negative when repaid).
  - Settlement pays the full payout as usual, then the advance is repaid from it.
  - Selling part of the hedge repays at once from the sale's netting proceeds.
- **Setting.** With Collateral return off, nothing new is released, but a shrinking guarantee still repays the excess.
- **Audit.** `house:collateral_advance = −Σ collateral_returns.amount_cents`; escrow still equals open interest (the
  advance is not taken from escrow).
- **API and UI.**
  - `GET /users/:uid/collateral_returns`, plus `POST …/refresh` (Settings calls it when the toggle changes).
  - Events expose `collateral_return_type`.
  - Portfolio › Positions shows a "Collateral returned" stat and a "Collateral returned early" card per event.
  - The total value no longer counts the advance twice.
  - History lists `collateral_return` rows under Trades.
- **Example (seeded rate decision, 3 outcomes).** NO on all three × 10 contracts → G = $30 − $10 = **$20 back now**.

### 28.7 Settlement correction, two-person rule, permissions (G6, security gate)

**UNKNOWN (§18.1 R12).** Admin tooling. **Design choice:**
- **Correct a settled market.** `POST /admin/resolution/:ticker/correct {result | expiration_value, reason}` needs
  `resolution.write` and **step-up** (`settlement_correction`). The reason must be 10–1000 characters. The market must
  be finalized and must not be a combo or a leg of a resolved combo.
  - The reverse-before-settlement path (§18.4) is unchanged; on a settled market it still answers `already_settled`, and
    its details now point here.
  - The engine re-prices every settlement row at the new result. Each holder's difference is a `settlement_correction`
    ledger entry against `escrow:<ticker>`: a claw-back or a re-pay. The scalar rounding residual is re-derived, so
    escrow ends at zero.
  - Cash may go **negative**. This is the Phase 4 debt rule (§26.5): withdrawals answer `negative_balance` until a
    deposit repays it, and credits are not touched.
  - Settlement rows keep what was paid. `settlements.effective_payout_cents` tracks the corrected amount, which feeds
    settlement history, Documents P&L and the desk totals.
  - Each correction is a `settlement_corrections` row (users, claw-back, re-paid, requester, approver) and a
    `res_resolutions` row with status `corrected`. It writes a hash-chained `resolution.correct` audit row with the
    reason.
  - Every affected user is notified (`settlement_correction`) with the amount, the reason and, when cash is negative,
    what they owe.
- **Two-person rule.** It is an admin setting (`PUT /admin/resolution/policy {two_person_rule}`, `settings.write` +
  step-up, stored in `admin_settings`).
  - With it on, a resolution or a correction answers **202** `pending_approval` and creates a `res_approvals` row. Other
    resolvers are notified.
  - A **different** admin with `resolution.write` approves (`…/approvals/:id/approve`; same admin → 409 `same_admin`;
    corrections need step-up) or rejects with a note. Requests lapse after 24 h.
  - Request, approval and rejection are each audited. Nothing changes until approval.
  - The desk shows the rule, a "Waiting for a second admin" table and the Correct settlement… dialog.
- **Market-creation permissions.** Drafting a market (including scalar and grid fields) still needs `catalog.write`. A
  resolver gets 403. The authz matrix classifies every new route.

### 28.8 Combos on the finer grid and the HVM window (G12)

- **Grid.** Combo markets use `center_deci_edge_centi_cent` (§28.1); existing combos are migrated.
  - Quotes are validated against the market's grid: 0.1¢ in the middle and 0.01¢ near the edges for combos, whole cents
    for single markets.
  - Quotes are stored as `rfq_quotes.yes_bid_cc / no_bid_cc`.
  - The Other RFQs form steps 0.1¢ for combos.
  - The simulated maker keeps whole-cent quotes, which are valid on every grid. **Design choice:** its price model is
    unchanged.
- **HVM.** Observed (`getting_started_rfqs.md` §Timing): standard 30 s, HVM 3 s.
  - **Design choice:** a maker opts in per quote (`hvm: true`, the "HVM 3 s" checkbox). Accepting it opens a 3-second
    last-look window (`confirm_window_ms`).
  - If the maker does not confirm in time, the quote expires `not_confirmed` and the RFQ reopens.
  - Quotes show `hvm` and `confirm_window_seconds`, and the Quotes tab marks them "HVM 3 s".
  - The window is `combos.hvmConfirmWindowMs` (default 3000).

### 28.9 Migration and shared files

`db.js migratePhase5a()` (idempotent, additive) adds:
- **markets:** `price_level_structure`, `market_type`, `floor_strike`, `cap_strike`, `scalar_unit`, `expiration_value`,
  `settlement_value_cc`;
- **orders:** `price_cc`, `fee_micro`, `flip_units`;
- **trades:** `yes_price_cc`;
- **fills:** `price_cc`, `fee_micro`;
- **settlements:** `settlement_value_cc`, `effective_payout_cents`, `corrected_at`.

It also adds a `price_cc` book index and the triggers of §28.1, then backfills. New tables are created by
`server/trading-core.js` (`collateral_returns`, `res_approvals`, `settlement_corrections`) and `server/combos.js`
(quote cc columns, `hvm`, `confirm_window_ms`). `seed --reset` clears the new tables.

Small shared-file edits: `server/app.js` (mount, order route, cc views), `server/seed.js` (reset list),
`public/index.html` (`trading.css`), `package.json` (test file). `public/js/main.js` is unchanged.

### 28.10 Verification (`tests/trading-core.e2e.test.js`, 10 scenarios)

| Scenario | Checks |
| --- | --- |
| Sub-cent grid | Grid JSON; a 0.1¢ limit from the ticket (off-grid refused in UI and API) crossing two makers with price improvement; exact per-fill micro fees; order fee = ceil(Σ); cash = principal + fee exactly; journal split; book, candles and tapered 0.01¢ resting bid |
| Review on/off | Review panel, Edit; Skip order review places at once |
| Auto-sell | Prompt after a fill; resting 20.5¢ take-profit |
| Flip sell | Refused when off (UI + 409); review line; position flips; `flip_units` |
| Scalar | Two users, desk resolve at 3.1%; YES/NO payouts floored; residual to the house; event page and History |
| Collateral return | MECNET guarantee $20 released; Portfolio card; journal; off keeps but claws on sell; settlement repays to zero |
| Correction | Step-up dialog; claw-back to negative cash (debt rule blocks withdrawal); re-pay; notifications; audit chain; History |
| Two-person rule | 202 pending; same admin refused; second admin approves from the desk; rejected resolution changes nothing; catalog permissions for scalar drafts |
| Combos + HVM | Combo grid; off-grid quote refused; 0.1¢ HVM quote from Portfolio; 3 s lapse; confirmed execution at 39.7¢ with exact fee |
| Restart | Persistence of prices, advances, corrections, approvals; `journal.audit()` and the admin ledger audit pass; 390px light/dark with the review open, scalar page, collateral card |

Existing tests changed: ticket flows click **Place order** after **Review** (the review step is on by default), and
the Settings test expects no "takes effect in Phase 5" tags.

### 28.11 Residual risks

- **Fee rounding, journal and seed content.**
  - The rounding cent is booked to `house:fees:rounding` per fill and can move back by a cent within an order. It nets
    to ≤ 1¢ per order.
  - Account closure or seed resets that delete orders would leave rounding postings unmatched. The reset already
    leaves the journal unmatched (pre-existing).
  - Seed content for the new structures is inserted at startup when missing, so existing databases gain three events.
- **Collateral return.**
  - The guarantee assumes "none of the outcomes" is possible (conservative). Exhaustive events would allow a larger
    release.
  - A repayment can make cash negative only if the user moved the cash out between fills. It is the same debt rule.
- **Corrections.** A correction cannot cascade into combos (it is refused when a combo resolved from the leg). It does
  not re-run collateral advances already repaid.
- **Two-person rule.**
  - It relies on distinct staff accounts. One person with two admin accounts defeats it; that is an organisational
    control.
  - Pending requests are not re-validated against market changes made between request and approval, beyond the
    handler's own checks at execution.

**Confirmed by the owner (2026-11-04):** the design choices above as built: grid bands and names, fee rounding once per
order, the conservative MECNET guarantee, flip sell as one order, per-quote HVM opt-in, auto-sell default (average fill
+ 10¢), order review on by default, two-person requests lapsing after 24 hours, corrections refused when a combo
already resolved from the leg.

## 29. Markets and content (Phase 5B)

PLAN.md Phase 5 items P5.2 (non-scalar parts), P5.3 and P5.4, gap G9, and scope items A13 and A15. Conventions as in §19:
**OBSERVED** (seen in evidence), **INFERRED** (follows from evidence), **design choice** (Parlance's own decision),
**UNKNOWN** (not established; a design choice stands in). All leagues, teams, places, postcodes, rates, news and copy are
invented. Code: `server/sports.js` + `server/sports-lines.js` (§29.2–29.3), `server/calendar-limits.js` (§29.4),
`server/markets-content.js` mounting `ballot.js` + `civic-data.js` (§29.5), `ai-summary.js` + `ai-providers.js` (§29.6),
`incentives.js` (§29.7) and `hubs.js` (§29.8); views `event.js`, `scoreboard.js`, `sports.js`, `calendar.js`,
`ai-summary.js`, `hubs.js`, `incentives.js`, `admin/content5b.js`; styles `public/markets5b.css`.

### 29.1 Evidence vs design choice

| Fact | Source | Status |
|---|---|---|
| Sports markets beyond the winner exist on the live site as separate events (spreads, totals) | PLAN P5.2 wording; series naming in captured calendars | INFERRED; lines, steps and pricing are design choices |
| `event_limits[]` caps recurring families per calendar section: `{event_tickers:[…], max_count:3}` (15-minute families), `max_count:2` (daily temperature) | §13.4, HAR3#10 | OBSERVED (shape); how the UI expands them is UNKNOWN (U16) |
| `/incentives` page: left PREDICTIONS nav, Terms link, region banner, month + lifetime rewards with ⟲ history, ACTIVE · UPCOMING tabs, search, table Market (N markets ⌄) · Start · End (time zone) · Competition (Low/High) · Reward ↓ | §13.17, SHOT5:lip | OBSERVED |
| `GET /v1/incentive_programs/?page_size&status&type` → `{incentive_programs:[…]}`, empty where not offered | §13.19, HAR5 | OBSERVED (shape); item fields INFERRED from the public docs page name `get-incentives` |
| How incentive rewards accrue | §13.17 | **UNKNOWN** (design choice in §29.7) |
| `/api-app/midterms/senate-map`, `/api-app/fed-funds/outlook`, `GET /v1/series/{s}/events/{e}/forecast_history`; `/api-app/ai-summary/timeline-points` on market pages | §13.19, §13.5, Appendix A | OBSERVED (paths only); payloads UNKNOWN |
| Ballot lookup ("What's on your ballot?"), AI summaries with citations, hockey, running clocks, live header label | PLAN P5.3, P5.4, G9 | requirement; everything else design choice |

### 29.2 Sports derivatives: spreads and totals (P5.2)

- **One extra event per game**: `{game event}-LINES` ("Home vs Away: Spread & Total", `mutually_exclusive = 0`, same
  league series), linked in `sports_line_events (event_ticker, milestone_id, game_event_ticker)`; markets in
  `sports_lines (market_ticker, milestone_id, event_ticker, kind spread|total, side home|away|'', line, fair, quoted_cents,
  quoted_ts, priced_ts)`. Four markets: the favourite's spread at the median pre-game margin, the underdog's spread at the
  sport's minimum, a main total at the median total and an alternate total one step higher. Every line is a half point,
  so nothing can push. Units and steps per sport: goals (soccer min 0.5 / step 1, hockey 1.5 / 1), points (basketball
  1.5 / 10, football 1.5 / 7), games (tennis 1.5 / 3), runs (cricket 4.5 / 20), rounds (esports 2.5 / 6). Copy: "Frostport
  Narwhals by over 1.5", "Over 5.5 goals"; tickers `…-LINES-SPFPN15`, `…-LINES-TOT55`.
- **Fair value (design choice):** Monte Carlo over the game's own deterministic model. The persisted state is cloned
  `lineSims` times (default 120) with independent PRNG streams seeded from the game id and the current game time, each
  clone played to the end with the same `resolve()/next()` that drives the live game; P(YES) is the share of paths that
  cover (Laplace-smoothed). Re-priced at most every `linesMs` (4 s) per game, at most two games per engine tick, and
  quoted by the liquidity account exactly like the winner markets (§19.5: reference print, bid one cent below, offer one
  above).
- **Settlement:** at the final whistle the winner markets and every line go through `engine.determine` together; a line
  is YES when, on the final measures (score, games, runs or rounds per side), `side − other > line` (spread) or
  `home + away > line` (total), then finalizes through the normal path (settlements, ledger, notifications).
- **UI:** the game's event page shows a **Spread and Total** card (Spread / Total groups, live % via `ticker`, Yes / No
  open the lines event with that market selected); the lines event page shows the game's scoreboard, the live header
  label and a link back to the moneyline. Lines events carry `sports_lines` (not `live_data`), so cards stay plain market
  cards and the calendar does not show two scoreboards for one game. `GET /v1/sports/events/{t}` accepts either ticker
  and adds `lines: {event_ticker, game_event_ticker, markets:[{market_ticker, kind, side, line, fair_probability}]}`.

### 29.3 Ice hockey, running clocks and the live header label (G9)

- **Icebound Hockey League** (`IHL`, `hockey_game`, four invented teams; inserted into existing databases as well):
  3 × 20-minute periods, one segment per 30–60 s of play, Poisson goals from team strength, shots / saves / hits /
  faceoffs, minor penalties (2:00 power play ×2.4 for the team with the advantage, ×0.25 short-handed, ended early by a
  power-play goal), 5-minute 3-on-3 sudden-death overtime (×1.7), then a best-of-3 shootout with sudden death (the
  winner is credited one goal). Win probability: Poisson over the remaining regulation time plus an OT / shootout split.
  Labels `P2 13:58`, `2nd intermission`, `OT 3:12`, `Shootout · 2-1`; details add `power_play {team,
  remaining_seconds}`, `home_shots`, `away_shots`, `shootout`. Box score: shots, power plays (PPG/PP), penalty minutes,
  hits, faceoffs, saves. Seeded fixtures: one live (2nd period), one upcoming, one final.
- **Running clocks:** every `live_data.details` carries `game_clock {name, seconds, running, direction up|down, format
  mmss|minute|hmmss|none, cap?, rate, as_of}`: the countdown for basketball, football and hockey, the match minute for
  soccer, the **match time** for tennis and the **map time** for esports (cricket counts overs). The client advances
  every `[data-gclock]` element four times a second at `rate` game seconds per second until the next `live_data`
  message replaces it (`scoreboard.js tickClocks`), so clocks run between server updates and after a WebSocket drop.
- **Live header label:** the event header shows `● Live · Q3 4:12` / `Set 2 · 3-2 · 1:12:05` / `Final 2-1` / the start
  time from the game's live data, patched in place by the page-wide `live_data` patcher (part `evlabel`); card
  subtitles and hub cards use the same running label.

### 29.4 Calendar `event_limits` (§13.4, U16)

`GET /v1/calendar` adds `event_limits[]` to every section in the observed shape. Design choice: a family is one series;
`fifteen_min` and `hourly` series are capped at 3, `daily` at 2; sports fixtures are never capped (they are distinct
games, not a recurring family). The page shows the first `max_count` events of a family in section order and a
**"+N more · {series}"** card after the last one; it expands in place ("Show less" collapses). The `npm start` demo data
adds a daily temperature family of five invented cities so the cap is visible (§29.8).

### 29.5 Ballot lookup (P5.3)

- **Data (invented):** 12 states on a 3 × 4 tile map (`civic-data.js STATES`), two Harbor State districts and three
  cities, each with five-digit "ZIP-like" ranges inside 90100–98999 and the contests it votes on (event tickers: the
  Harbor State governor and senate races, the Harbor City mayoral race and the tram measure, the seven `PLXSENATE` races of
  the demo data). Stored in `ballot_jurisdictions` (upserted from code at boot).
- **Lookup:** `POST /v1/ballot/lookup {address}` (≤ 200 characters, strict schema; public; 20 a minute per user and 120 per
  IP, hashed keys in `content_rate_limits`). A five-digit code picks the most specific place whose range contains it,
  otherwise a whole-word match on place names. Answer: `{jurisdiction:{id, kind, name, chain[]}, contests:[{event_ticker,
  title, office, kind race|measure, level, jurisdiction, markets[], leader}], matched_by zip|name}`; contests whose
  event is missing or not trading are left out; no match → `jurisdiction: null`.
- **Privacy (design rule, tested):** the address exists only in memory for the lookup. It is never written to the
  database, a log or the audit trail; the request is a POST so it is not in a URL or access log. Signed-in users may save
  the **resolved jurisdiction id only** (`PUT /v1/users/{uid}/ballot {jurisdiction_id}` → `ballot_saved`), see it again
  (`GET`) and forget it (`DELETE`). The test greps the database file and WAL bytes and every log line for the address.
- **UI:** "What's on your ballot?" card on `/ballot` and the elections hub: privacy note, result chain (City · District ·
  State), contest links with the leading outcome, Save / Forget.

### 29.6 AI news summaries and timeline (P5.4)

- **Input:** the event's active CMS news items (`cms_news`, Admin › Content › News items), newest first, at most
  `max_items` (12). **Timeline:** the same items oldest first, numbered; citations use these numbers.
- **Providers** (`ai-providers.js`): `summarize({items, maxSentences, system, user}) → {text | sentences, usage}`.
  - *Extractive (default, offline, deterministic):* sentences from headlines and summaries; dropped when shorter than 24
    or longer than 280 characters, when they look like instructions (`ignore … instructions`, `system prompt`, role
    prefixes, `you are now`, …), contain links or markup, or hit the blocklist; scored by cross-item term agreement plus
    small headline and recency boosts, picked greedily with a same-source penalty and near-duplicate removal (Jaccard >
    0.5); each pick cites every item carrying the same fact (Jaccard ≥ 0.5) and the result is ordered chronologically.
  - *External (optional):* the Claude Messages API through the official SDK (`@anthropic-ai/sdk`, loaded lazily), created
    only when **both** `ANTHROPIC_API_KEY` and `AI_SUMMARY_MODEL` are set; the model id comes from the environment and
    is written nowhere in the code base. `max_tokens` 1024, 20 s timeout, one retry; `stop_reason: refusal` and SDK error
    classes (rate limit, auth, bad request, connection) become a fallback. Tests inject a fake adapter through
    `start({marketsContent: {ai: {adapter}}})`; no test touches the network.
- **Prompt (data, not instructions):** every item in its own `<item id>` element (source, published, headline, summary)
  inside `<news_items>`, with tags, control / zero-width / bidi characters and links stripped and `<`, `>`, `&` escaped,
  so an item cannot close its element; the system prompt states that the items are untrusted data, must never be
  followed, and asks for `{"sentences":[{"text","citations":[ids]}]}` only.
- **Output validation:** JSON object (the first `{…}` span), 1..`max_sentences` sentences, each 8–300 characters and
  ≤ `max_chars` (900) in total, no `<`, `>` or HTML entities, no URLs or markdown links, no markdown emphasis, no
  instruction echo, every citation an id that was sent (1–8 per sentence), moderation blocklist. A failure discards the
  reply and stores the extractive summary with `fallback_reason invalid_output:{reason}`.
- **Cache:** `ai_summaries (event_ticker, news_hash, provider, content_json, item_count, fallback_reason, tokens, trigger,
  created_ts)`; `news_hash` = SHA-256 over the sorted items' id, time, source, headline and summary. A summary is
  generated on the first read of a new set (concurrent reads share one generation) and served until the set changes or
  an admin regenerates; the latest five per event are kept.
- **Cost caps:** `admin_settings.ai_summary {enabled, daily_request_limit (100), daily_token_limit (100 000), max_items,
  max_sentences (3), max_chars, blocklist}`; usage per UTC day in `ai_usage (requests, input_tokens, output_tokens,
  fallbacks, rejected)`. Before a call the estimated tokens (prompt / 4 + 1024) must fit; otherwise the extractive summary
  is served (`fallback_reason budget`) and no request is made.
- **Admin › AI summaries** (`content.write`; settings `settings.write`): per event the provider, fallback reason and
  state; **Hide** / **Unhide** (per event, survives new news) and **Regenerate** (6 per 10 minutes per admin), each with
  a reason and a hash-chained audit row (`ai_summary.hide|unhide|regenerate|settings`); usage today; budget and
  blocklist form. Changes push `event_content {event_ticker, kind:'ai_summary'}` on the public `event_content` channel.
- **UI:** "Summary" card above News on the event page: sentences with numbered citation chips (jump to and highlight the
  news item), provider badge, "from N news items", a caution line, and the Timeline; hidden → "The summary for this event
  is not available".
- `GET /v1/events/{t}/ai_summary` → `{event_ticker, summary: {id, provider, provider_label, generated_time, news_hash,
  item_count, fallback_reason, sentences:[{text, citations:[{id, n}]}]} | null, hidden, timeline:[{n, id, date, source,
  headline}]}` (this also serves the role of the observed `timeline-points` call).

### 29.7 Liquidity Incentive Program (A13)

- **Programs** (`incentive_programs`): event, optional market subset, title, `incentive_type liquidity`, start / end,
  reward pool, competition (`auto` | low | high; auto = High with ≥ 3 earners at the last snapshot), target size,
  spread window (cents), discount factor, payout mode (`cash` | `credits`), status `scheduled → active → ended → paid`
  (or `canceled`).
- **Accrual formula (design choice; the public docs describe a pool shared by resting orders near the best price, but
  the weighting, cadence and caps are UNKNOWN):** every snapshot (`snapshotMs`, 60 s), for each active program
  `pool_slice = reward_pool × Δt / (end − start)` (Δt capped at two intervals, so an outage is not back-filled) is split
  equally between the program's market sides (YES bids and NO bids of each market). On a side the best resting price `b`
  comes from the whole book; each enrolled, eligible, non-system user scores
  `min(target_size, Σ remaining_units × discount^(b − price))` over orders with `b − price ≤ spread window`, and receives
  `side_slice × score / Σ scores`. Accruals are kept in micro-cents (`incentive_accruals`, 1 ¢ = 10⁶) so nothing is lost
  to rounding; a side with no qualifying order is not distributed; snapshots are logged in `incentive_snapshots`.
- **Eligibility:** users enrol by accepting the terms (`incentive_enrollments`, terms version, country) from an eligible
  region: the simulated geolocation of §25.6 (blocked countries, IP table, browser fix) plus the program's
  `blocked_regions` (Admin › Liquidity incentives; default CU, IR, KP, SY). Every visit re-checks it and an ineligible
  check suspends accrual. Where not eligible the list is empty and the page shows "Incentive programs are not available
  in your region" (observed).
- **Payout (journaled):** at the end (auto, on by default) or by an admin (**Pay out**: `users.money`, reason, step-up),
  each user receives the whole cents accrued and not yet paid: cash → `engine.credit(…, 'incentive', program, …,
  {contra: 'house:incentives'})` (ledger kind `incentive`, "Liquidity reward" in History / Your activity); credits →
  a `credit` entry (contra `house:promotions`, expiring grant, non-withdrawable). Rows in `incentive_rewards`; a
  `market_reward` notification (the existing Market rewards row of the notification matrix) and `user_balance`; the
  ledger audit (§26.6) covers both accounts.
- **Page `/incentives`:** observed layout (§13.17); stats are this month's paid rewards, lifetime rewards (⟲ history with
  per-program accruals) and "accruing, not yet paid"; enrolment card with the terms checkbox; `/incentives/terms`.
  Live: public `incentives` channel (program changes), private `incentive_rewards` (own accruals and payouts).
- **Admin › Liquidity incentives** (`markets.ops`): create / edit / cancel programs (reason, audit), run a snapshot,
  pay out (`users.money` + step-up), eligibility settings (`settings.write`).
- **API:** `GET /v1/incentive_programs?status=active|upcoming|ended|all&type=liquidity&page_size=` →
  `{incentive_programs:[{id, incentive_type, event_ticker, title, event_title, event_sub_title, series_ticker, category,
  markets[], start_date, end_date, period_reward_dollars, competition, target_size_fp, max_spread_cents,
  discount_factor_bps, payout_mode, status, paid_out, participants, accrued_dollars, paid_dollars}], region}`;
  `GET /v1/incentive_programs/terms`; `GET /v1/users/{uid}/incentives`; `POST|DELETE /v1/users/{uid}/incentives/enrollment`.

### 29.8 Hub data widgets (A15)

- **Senate map — removed** (owner decision 2026-11-08, replaced by the elections hub v2, §37 and §38.4). The page
  `/hubs/elections` now answers 301 to `/category/elections/nigeria-2027`; `GET /v1/hubs/senate_map` is gone (404); the
  home rail and MORE link to the Nigeria hub. The ballot lookup (§29.5, `/ballot`), the rates hub and forecast history
  below stay.
- **Fed funds outlook** (`GET /v1/hubs/fed_funds_outlook`): every open event of the central-bank series (`PLXRATE`,
  outcomes Cut / Hold / Hike), normalised probabilities, implied change `25 bp × (P(hike) − P(cut))` and the implied
  midpoint path from an invented current range of 4.25–4.50 %. Page `/hubs/economics` ("Rates outlook"): meeting table,
  implied path chart, the next meeting's implied-change history and outcome odds.
- **Event forecast history** (`GET /v1/series/{s}/events/{e}/forecast_history?days=1..30&period=60|240|1440`):
  `{kind probability|rate_decision, normalized, period_minutes, outcomes[], points:[{ts, values:{ticker: %},
  implied_change_bps?}]}` from the last trade at each period end (normalised to 100 % for mutually exclusive events).
- Widgets re-read their endpoint when a price they depend on changes (`ticker` channel, debounced).
- **Demo data** (`marketsContent.seedHubs`, on for `npm start`, off for programmatic test servers unless asked; meta key
  `hubs_seed_v1`): seven `PLXSENATE` races, central-bank meetings `PLXRATE-27JAN` / `-27MAR`, the daily temperature
  family `PLXTEMP` (five cities, renewed daily), five news items and two incentive programs (one active, one upcoming).
  Liquidity is placed through the engine, so the journal stays balanced.

### 29.9 Endpoints, tables, WebSocket, options

| Area | Routes (`/v1`; every one classified in `tests/authz.e2e.test.js`) | Who |
|---|---|---|
| Ballot | `POST ballot/lookup`, `GET ballot/jurisdictions/:id`; `GET|PUT|DELETE users/:uid/ballot` | public; owner |
| AI summaries | `GET events/:ticker/ai_summary`; `GET admin/ai_summaries`, `POST admin/ai_summaries/:ticker/{hide,unhide,regenerate}`; `GET|PUT admin/ai_summaries/settings` | public; content.write; settings.write |
| Incentives | `GET incentive_programs`, `GET incentive_programs/terms`; `GET users/:uid/incentives`, `POST|DELETE users/:uid/incentives/enrollment`; `GET|POST admin/incentives/programs`, `PUT …/:id`, `POST admin/incentives/snapshot`; `POST …/:id/payout`; `GET|PUT admin/incentives/settings` | public; owner; markets.ops; users.money; settings.write |
| Hubs | `GET hubs/fed_funds_outlook`, `GET series/:s/events/:e/forecast_history` (`hubs/senate_map` removed in Phase 8, §29.8) | public |

Bodies are checked with `validate.js check()` schemas inside the handlers (unknown fields rejected). Tables (`CREATE TABLE
IF NOT EXISTS`, no existing table changed): `sports_line_events`, `sports_lines`, `ballot_jurisdictions`,
`ballot_saved`, `content_rate_limits`, `ai_summaries`, `ai_summary_flags`, `ai_usage`, `incentive_programs`,
`incentive_enrollments`, `incentive_accruals`, `incentive_snapshots`, `incentive_rewards`; settings rows
`admin_settings.ai_summary` and `.incentives`. WebSocket: public `event_content` (filtered by `event_tickers`) and
`incentives`, private `incentive_rewards`. Options: `start({ sports: { lineSims, linesMs }, marketsContent: { seedHubs,
ai: { adapter, regeneratePer10Min }, incentives: { snapshotMs }, ballot: { ballotPerMinute, ballotPerIpMinute } } })`.

### 29.10 Security, verification, residual risks

- Security gate (PLAN §6): admin-only content management with reasons and hash-chained audit; prompt-injection handling
  and output validation (§29.6); cost caps; ballot privacy and rate limits; regeneration rate limit; strict body schemas;
  the authz matrix covers the 27 new routes; incentive payouts behind `users.money` and step-up; all output escaped; no
  inline styles (dynamic values through `dynstyle.js`). Threat rows: SECURITY.md §12.
- Verification: `clone/tests/markets-content.e2e.test.js` (8 scenarios, real server + SQLite + Chromium): a total bought
  through the event page and a spread via the API settle from the final score (results = `covers()` on the DB score,
  settlements and payouts); hockey header label counting down in the browser and matching the DB, hockey box score and
  live data, tennis and esports clocks running; the calendar cap (2 of 5) and its expander; ballot lookup by code and by
  name, saved jurisdiction only, no address in the DB file, WAL or any log line, validation and the per-user rate limit;
  extractive summary with valid citations and the injected item dropped (no script runs), the fake adapter's prompt
  delimited and escaped, its malicious reply rejected, the request budget falling back with no provider call, admin
  hide (live on the open page) / unhide / regenerate with audit, non-staff refused, regeneration rate limited; an admin
  program created in the UI, enrolment, accrual from a resting bid (system liquidity earns nothing), payout in the UI
  posting `house:incentives` → user cash, the ledger audit balanced, month / lifetime rewards live, region gating
  (banner, empty list, enrolment refused, accrual stopped); Senate tiles, expected seats and Fed meeting rows equal to
  values computed from DB trades, a trade moving a tile live, forecast history normalised; and a restart that keeps the
  cached summary (same id), the saved ballot area, rewards, programs and settled lines, with no horizontal overflow at
  390 px in dark and light on the new pages. `sports.e2e` now expects seven sport groups (hockey).
- Shared-file edits (small, exact-string): `server/app.js` (one mount line + an option), `server/index.js` (option
  pass-through, `seedHubs` for `npm start`), `server/features.js` (`event_limits` per calendar section),
  `server/ws.js` (three channels), `server/history.js` (ledger kind `incentive`), `server/notify-prefs.js`
  (`market_reward` → Market rewards), `server/sports.js` (hockey, clocks, lines), `public/js/main.js` (routes, MORE
  links), `public/index.html` (stylesheet), `public/js/views/{event,calendar,scoreboard,sports,home,admin}.js`,
  `admin/site.js` (news anchors), `package.json` (the suite; `@anthropic-ai/sdk` pinned, loaded only when configured),
  `.env.example`.
- Residual risks: the injection patterns and blocklist are heuristics (validation is the control); the external
  adapter has no streaming or structured-output mode (short JSON, validated); no wash-trading / self-match detection for
  incentive rewards; incentive and ballot limits are per process (PLAN §10 RS1); the accrual formula is a design choice
  until the real one is confirmed; lines are priced by a 120-path simulation (± a few cents of noise, smoothed by
  re-quoting at most every 4 s); the saved ballot area is not yet included in the data export (§25.10).


**Confirmed by the owner (2026-11-04):** the design choices above as built: the incentive reward formula (§29.7),
spreads and totals as a separate event per game on half-point lines, calendar caps (15-minute and hourly 3, daily 2,
sports never capped), the optional external summarizer with the pinned official SDK, and the `npm start`-only demo data.

## 30. Display currency (NGN) and admin defaults

Owner decision (2026-11-04): Parlance displays **Nigerian naira by default**. A contract pays **₦100**. The rule is
**display-only**: the engine, ledger, journal, database and API keep their units (integer cents, centi-cent prices,
`*_dollars` strings). It is a sandbox display rule, not an exchange rate.

### 30.0 Market focus: Nigeria first, multi-country ready (owner decision 2026-11-08)

Parlance is **mainly for Nigerians** and may later add more countries. Every new feature follows these rules:

- **Defaults:**
  - currency NGN (§30.1);
  - time zone Africa/Lagos (WAT, UTC+1);
  - en-NG formats;
  - Nigerian examples, copy and seed data: states, the FCT, geopolitical zones, the national calendar.
- **Nothing country-specific in code:** country facts live in DB-backed configuration that admins manage:
  - currency, time zone and locale;
  - administrative divisions;
  - elected offices and chambers, seat counts and election rules;
  - parties and their colours;
  - holidays;
  - which features are on.

  Adding a country means adding data, not code. Every feature that depends on a country takes a `country` (ISO 3166-1 alpha-2 code: `NG` first).
- **Multi-party by default:** election features never assume two parties. They handle N parties, coalitions and runoffs.
- **Clean room:** this still applies, so seed and demo data use invented candidates and parties. Real geography and public facts about offices are fine. Real politicians, real party marks and photos of real people are never seeded.

| Internal | NGN (default) | USD (alternative) |
|---|---|---|
| Contract price 64¢ (6,400 cc) | ₦64 | 64¢ |
| Sub-cent price 64.50¢ (6,450 cc) | ₦64.50 (kobo) | 64.5¢ |
| Amount $25.00 (2,500 cents) | ₦2,500 | $25.00 |
| Contract value $1.00 | ₦100 | $1.00 |
| Perps BTC level $96,250.00 | ₦9,625,000 | $96,250.00 |
| Funding $0.0123 | ₦1.23 | $0.0123 |

- 1 internal cent = ₦1, so amounts in whole cents are whole naira; kobo appear only when the value has them (sub-cent
  grids, perps prices and P&L in centi-cents, exact fee memos).
- Percent odds and payout multipliers are currency-free and unchanged.
- Perps follow the same ×100 rule for asset prices, notional, margin, funding and P&L, so no page mixes currencies.
- Money inputs take display units and convert at the client boundary: naira ÷ 100 = the API's dollars. Deposits,
  withdrawals, transfers, ticket amounts, combo amounts and limits take **whole naira** (the API takes at most 2 dollar
  decimals). Price inputs are the same number in both currencies (64 = ₦64 = 64¢); fine grids accept kobo where the grid
  allows (₦12.30 on `deci_cent`). Perps price inputs take naira levels.
- Labels: the ticket's "Dollars" mode is "Naira" (the API order type stays `dollars`); "Max payout", limits, fees,
  admin money fields and error messages quote ₦. Seeded copy that names dollar thresholds is written at the same rule
  ("PLX token above ₦500", "Each contract pays ₦100").

### 30.2 Configuration (DB, live)

- `admin_settings.display_currency` = `{code: NGN|USD, locale: en-NG|en-US|en-GB, timezone: IANA zone}`; defaults
  `NGN`, `en-NG`, `Africa/Lagos`. Loaded at boot, changed live by the admin panel, persisted across restarts.
- `admin_settings.account_defaults` = `{theme, order_review, flip_sell, display_mode, notification_channels}`.
  Applied once when an account is created (password sign-up and OAuth sign-up) by writing the account's own
  `user_settings` rows and, when a channel is off, a `notif_prefs` row. Existing accounts keep their saved choices.
- The SPA boots from `GET /v1/site_config` (`display_currency`) and listens on the public WebSocket channel
  `display_currency`; a change re-renders every open page in place.
- Time zone: dates, calendar labels, exports' local timestamps, rolling-market titles ("Closes 15:15 WAT") and
  statements format in the configured zone and locale. Server-side calendar sections are **local days** in that zone
  (`GET /v1/calendar` `date`): a close at 23:30 UTC belongs to the next Lagos day. Daily limits, the session limit,
  withdrawal limits and admin reports stay on **UTC days** (they were never local-day based); their help text says so.

### 30.3 Admin › Settings › Currency & defaults

- Fields: currency, locale, time zone; new-account theme, order review, flip sell, market preview (payout & odds vs
  shares & prices), in-app / email / push channels; reason.
- Live preview before saving: sample prices (whole and kobo), a balance, a payout, a perps level, funding, a date at
  23:30 UTC (the midnight edge) and the price-input unit, formatted with the form's values.
- `GET /v1/admin/settings/currency` and `PUT /v1/admin/settings/currency` need `settings.write`; the PUT needs a
  reason (3-500 characters), a fresh step-up (`admin_currency_settings` in the central SENSITIVE list), a strict body
  (`server/validate.js` `adminCurrency`, nested objects checked with `unknown: 'reject'`), and writes one hash-chained
  `settings.currency` audit row with before / after.

### 30.4 Developer API

Every existing field name and value is unchanged (they mirror the observed exchange API). New, public:
`GET /v1/exchange/display_currency` →
`{display_currency: {code, symbol, name, minor_unit, minor_units_per_major, contract_value, contract_value_display,
locale, timezone, per_internal_dollar, rule, supported}}`. Display value = `*_dollars × per_internal_dollar`
(100 under NGN). CSV exports name their money columns for the currency (`amount_ngn`, `price_ngn`, `volume_ngn`, …,
plain numbers in naira) and keep the original names (`amount_usd`, `price_dollars`, …) under USD.

### 30.5 One formatter each side, keyed wording

- Server: `server/currency.js` (`moneyCents`, `moneyDollars`, `priceCc`, `priceCents`, `assetPrice`, `csv*`, dates,
  `dayKey`, `descriptor`, `applyAccountDefaults`). SPA: `public/js/currency.js` (the same functions plus input
  conversion; `lib.js` re-exports `money`, `px`, `pxc`, so every view goes through it). Notifications, toasts, the
  dev-mailbox emails (built from notification title and body), ledger memos, error details, CSV exports, admin pages,
  incentives, perps and combos all format through them.
- PDF statements write the ISO code ("NGN 2,500") because the standard PDF fonts have no ₦ glyph, plus a line naming
  the currency and the display rule.
- CMS readiness (PLAN Phase 5C): every new or changed user-facing string of this phase is a keyed template with named
  variables in one module per side, `server/content/currency-strings.js` and `public/js/content/currency-strings.js`
  (`t(key, vars)`, `tHtml` for markup with pre-escaped variables).

### 30.6 Design choices to confirm

- Whole naira when the amount has no kobo (₦2,500, not ₦2,500.00); kobo shown with two digits when present.
- Notifications and ledger memos are text written at the time of the event, so switching currency does not rewrite
  the history of earlier messages; seeded titles are written once at seed time.
- Calendar sections follow the configured zone; responsible-trading limits, withdrawal limits and reports stay UTC.
- PDF statements use "NGN" instead of "₦"; CSV money columns are plain numbers named by currency.
- **Approved by the owner (2026-11-04):** whole-naira display without kobo when there is none; "NGN" in PDFs (no ₦
  glyph); `_ngn` CSV columns; UTC daily limits with Lagos-day calendar grouping; new-account defaults apply only to
  accounts created after a change.

### 30.7 Verification

`clone/tests/currency.e2e.test.js` (7 scenarios, real server + SQLite + Chromium): the descriptor and site config;
NGN on home, the ticket in Naira mode (whole-naira validation, contracts within ₦1,000, payout = contracts × ₦100, the
review line, the DB order type unchanged), `/funds` deposit of ₦2,500 → 2,500 cents in the ledger, the Transfers
notification (inbox, bell, dev-mailbox email and page), portfolio, the CSV (`amount_ngn`, trade memo in ₦) and the PNL
PDF; perps (mark ₦10,000,000, a ₦500 transfer = 50,000 cc, limit input in naira); kobo on `deci_cent` (book levels,
a ₦12.30 limit stored as 1,230 cc, portfolio order row); the admin switch NGN → USD with preview, reason and step-up,
audit row and chain verification, live update of another user's open page, persistence across a restart, and back to
NGN live; new-account defaults on a new account and not on an existing one; calendar grouping under the Lagos day vs
the UTC day around midnight and the preview's date across midnight. Existing suites expect the NGN default (currency
strings and money inputs only).

---

## 31. Progressive Web App

Status 2026-11-04 · PLAN §9 row "PWA" · branch `pwa`. Nothing here is observed on the live site: every value is a
Parlance design choice, stated as such. Tests: `clone/tests/pwa.e2e.test.js` (9 browser scenarios against the production
bundle).

### 31.1 Pieces

| File | Role |
|---|---|
| `server/content/pwa.js` | `PWA_CONFIG` (the manifest's editable fields; `/manifest.webmanifest` is built from it per request as `application/manifest+json`, 1 h cache), keyed server strings, the offline-page renderer (§31.12) |
| `public/js/content/pwa-strings.js` | Every PWA user-facing string, keyed (§31.12) |
| `public/icons/*` | Own "P" mark: `icon.svg`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png` (180), `badge-72.png` (monochrome notification badge). Drawn by `scripts/make-icons.js` (pure Node rasteriser + PNG encoder; `--check` verifies the committed files); no third-party assets |
| `public/sw.js` | The service worker, served at `/sw.js` (scope `/`) |
| `public/offline.html` | Template of the static offline page (keyed placeholders; no scripts, no inline styles, a Retry link) |
| `public/pwa.css` | Update toast, install steps, device list, offline page (tokens only, §27) |
| `public/js/pwa.js` | Registration, update toast, install prompt, cache clearing at sign-out, Web Push subscribe / unsubscribe / sync |
| `server/pwa-static.js` | The PWA paths in the static allowlist (§21.8), each with its own headers |
| `server/webpush.js` | VAPID keys, subscriptions API, RFC 8291 encryption, RFC 8292 signing, persisted outbox and its pump |
| `scripts/build.js` | Also writes `dist/sw.js` (version, precache list, keyed fallback strings), `dist/offline.html` (strings filled, stylesheet → hashed bundle) and `pwa: {version, precache}` in `dist/manifest.json` |

### 31.2 Manifest, icons and page tags

`name` "Parlance Exchange", `short_name` "Parlance", `id`, `start_url` and `scope` `/`, `display: standalone`,
`theme_color` `#008751` (the light-theme brand green, §27.6), `background_color` `#0d0e11` (the dark surface; the app's
default theme). Icons: 192 and 512 "any" (rounded tile, transparent corners), 512 "maskable" (full-bleed tile, the mark
inside the 80% safe zone), the SVG. Shortcuts: Markets (`/browse`), Portfolio (`/portfolio`), Deposit
(`/funds/deposit`). `index.html` adds `<link rel=manifest>`, `theme-color` for light (`#008751`) and dark (`#13a866`,
the dark-theme brand), `apple-touch-icon`, `apple-mobile-web-app-capable` / `-title` / `-status-bar-style` and
`mobile-web-app-capable`. The site CSP already allowed `manifest-src 'self'` and `worker-src 'self'` (§21.2).

### 31.3 What the service worker caches, and why

| Request | Handling | Why |
|---|---|---|
| Hashed assets of this build (`/assets/*-<hash>.{js,css,woff2}`), `/offline.html`, `/icons/*` | Precached at install, fetched with `credentials: 'omit'` and `cache: 'reload'`; served cache-first by exact path (no query string); a miss goes to the network and is not stored | Public, immutable, identical for every user. Without credentials the server sees no session, so nothing user-specific can enter the cache |
| Navigations (any HTML page) | Network only, through navigation preload. Never stored. On a network error: the cached `/offline.html` (else a plain-text 503) | Every page carries a per-response CSP nonce and a signed boot proof (§21.2, §21.6); reusing one would defeat both |
| `/v1/*`, `/trade-api/*`, the WebSocket, uploads, non-GET, cross-origin, anything else | Not handled: no `respondWith`, so the browser performs the request itself, unchanged | Client-token signing, CSRF, Idempotency-Key, the bot challenge and rate limits see exactly what they saw before |
| `/sw.js` | Never cached by the worker; `Cache-Control: no-cache` and `updateViaCache: 'none'` | Updates are detected on every check |
| `/manifest.webmanifest` | Not precached (network, 1 h HTTP cache) | Built from editable config; a cached copy would outlive an admin's change |

A response is stored only if it is a same-origin 200 that is not redirected and not marked `no-store` or `private` (a
`Set-Cookie` check is kept as a second line of defence; the header is never visible to a worker). One cache per build,
`plx-static-<version>`; activation deletes the others. Dev mode (`npm run dev`) serves a `dev-<hash of sw.js>`
version that precaches only the offline page and the icons, so stale sources are never served.

### 31.4 Security rules (hard)

- **Never cache HTML navigations**, any `/v1`, `/trade-api` or WebSocket traffic, anything `no-store` / `private`, or
  anything fetched with credentials. Pass every unhandled request through untouched.
- **Own CSPs.** `/sw.js` gets `default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self'; …` (a worker
  runs under the CSP of its script response, and the API policy would block its `fetch()`). `/offline.html` gets
  `default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; …` with no script source at all.
- **Static allowlist.** The PWA paths are added to §21.8 (`/icons/` accepts only `[a-z0-9-]+.(png|svg)`); everything
  else stays a 404.
- **Links from push payloads** must be same-origin paths (`/…`, not `//…`); anything else opens `/`.
- **Sign-out** clears every Cache Storage entry (on the transition from signed-in to signed-out, here or forced
  elsewhere), and, before the session ends, deletes this browser's push subscription on the server and unsubscribes it
  locally. The next full page load precaches again.

### 31.5 Updates

The worker never calls `skipWaiting()` on its own. When a new version finishes installing while a page is controlled,
the page shows the toast **"New version available — Reload"**; the click posts `SKIP_WAITING`, the new worker activates
(deleting the old cache and claiming the clients) and `controllerchange` reloads the page (a 4 s fallback reloads
anyway). Checks: on registration, whenever the tab becomes visible, and every 30 minutes. The version is the build
hash: SHA-256 of the source hash, the output file list and an optional salt (`build({ salt })`, used by the test to
produce a new version without touching the sources).

### 31.6 Install

`beforeinstallprompt` is captured (default prevented, so no mini-infobar) and shows **Install app** in the ☰ account
menu and, signed out, in a ☰ menu next to Log in / Sign up that exists only while installation is possible. The click
shows the deferred prompt once. On iOS Safari (no prompt API) the entry opens Add-to-Home-Screen steps (Share → Add to
Home Screen → Add). Hidden when `display-mode: standalone` matches or `navigator.standalone` is true, and after
`appinstalled`.

### 31.7 Web Push (the Push channel of §24.5)

- **Keys (RFC 8292).** One P-256 VAPID key pair per deployment, generated on first start. The private JWK is stored in
  `push_vapid`, AES-256-GCM encrypted under the HKDF sub-key `web-push:v1` of the master key (§22.8), AAD
  `push_vapid.private:1`. If it cannot be decrypted (master key changed), a new pair is generated and every
  subscription is removed (they are bound to the old key). `GET /v1/push/vapid_public_key` publishes the public key.
  `VAPID_SUBJECT` (mailto: or https:) is the `sub` claim.
- **Subscriptions.** `push_subscriptions`, one row per browser: endpoint and keys AES-GCM encrypted with row-bound AAD,
  an HMAC of the endpoint for lookups, push service name, label ("Chrome on Linux"), expiry, last success / failure,
  failure count. Endpoint rules: `https:` on the default port, a host name (no IP literal, no `localhost`) on a known
  push service (`fcm.googleapis.com`, `android.googleapis.com`, `*.push.services.mozilla.com`, `*.push.apple.com`,
  `*.notify.windows.com`; `PUSH_ALLOWED_HOSTS` adds more). `push.insecureEndpointHosts` (tests only) allows the listed
  `host:port` over http and is refused when `NODE_ENV=production`. Keys: `p256dh` an uncompressed point on P-256
  (checked by an ECDH), `auth` 16 bytes. At most 10 per user. Subscribing an endpoint that already exists moves the row
  to the caller (another account signed in on that browser) and drops what was queued for the previous owner.
  Endpoints and keys are never returned by the API.
- **Delivery.** `notify-prefs` `send()` (after the matrix gate, quiet hours and the hourly cap) calls
  `webpush.enqueueUser()`: one `push_outbox` row per subscription, payload AES-GCM encrypted at rest. A pump (engine
  tick, plus an immediate kick) claims due rows (`pending` → `sending`, attempts + 1) and POSTs `aes128gcm` bodies
  (RFC 8291: ephemeral ECDH, HKDF with the auth secret, one 4096-byte record, padded to a 128-byte boundary) with
  `Authorization: vapid t=<ES256 JWT {aud: endpoint origin, exp: +12 h, sub}>, k=<public key>`, `TTL` (the remaining
  lifetime: 12 h, 24 h for security notices, 1 h for promotions), `Urgency` (`high` for security, `low` for
  promotions, else `normal`), `redirect: 'error'` and a 10 s timeout.
  - 2xx → `sent`; 404 / 410 → the subscription is deleted (and its queued rows marked `gone`).
  - 429, 5xx, network errors → `pending` again after exponential backoff (30 s × 2ⁿ⁻¹, ±20%, at most 1 h; `Retry-After`
    honoured) up to 8 attempts, then `failed`; other 4xx → `failed`; TTL elapsed before sending → `expired`.
  - At boot, rows left in `sending` return to `pending` (at-least-once). The notification tag is the delivery id, so a
    duplicate replaces the earlier one instead of stacking. Finished rows are pruned after 7 days.
- **Payload.** `{title, body, link, tag, ts}`: exactly the in-app notification's title, body and deep link (title ≤ 120,
  body ≤ 300 characters, JSON ≤ 3000 bytes). Nothing else.
- **Service worker.** `push` → `showNotification(title, {body, icon, badge, tag, data.link})`; `notificationclick` →
  focuses an open window and routes it client-side to the link, else opens one. `pushsubscriptionchange` re-subscribes
  with the same key; the page re-registers the subscription at its next sign-in sync (a worker holds no session).
- **UI.** Settings › Notifications › "Push in this browser": the in-page pop-up switch (§24.5) and **System
  notifications**: "Turn on for this device" (permission → subscribe with the VAPID key → `POST …/push_subscriptions`),
  "Turn off on this device", and the device list with service, added, last delivered, failures, **Send test
  notification** and **Remove**. A browser with a Web Push subscription does not also show the in-page pop-up. On each
  sign-in the page re-sends this browser's subscription, or unsubscribes one that belongs to another account.

### 31.8 API

| Method + path | Auth | Notes |
|---|---|---|
| `GET /v1/push/vapid_public_key` | public | `{public_key}` (base64url, 65-byte uncompressed point) |
| `GET /v1/users/:uid/push_subscriptions` | owner | devices, without endpoints or keys |
| `POST /v1/users/:uid/push_subscriptions` | owner | `{endpoint, keys: {p256dh, auth}, expiration_time?, label?}`; 201 new, 200 re-subscribed; schema in `validate.js` (unknown fields rejected), 4 KB body limit |
| `DELETE /v1/users/:uid/push_subscriptions` | owner | `{endpoint}`: this browser unsubscribes itself |
| `DELETE /v1/users/:uid/push_subscriptions/:id` | owner | remove a device from the list |
| `POST /v1/users/:uid/push_subscriptions/:id/test` | owner | queue a test notification (5, then one per 30 s) |
| `GET /manifest.webmanifest`, `/sw.js`, `/offline.html`, `/icons/*` | public | static, classified in the authz matrix |

Start option `push: { subject, allowedHosts, insecureEndpointHosts, retryBaseMs, maxAttempts, timeoutMs }`.

### 31.9 Design choices to confirm

- Precache the whole hashed bundle (about 1.2 MB, every lazy chunk) rather than only the entry files, so the offline
  page is styled even on a cold start and later visits load from the cache.
- No offline data at all: market data and account pages need the network; the offline page says so.
- Theme colour: brand green in both modes (light `#008751`, dark `#13a866`) and in the manifest; background the dark
  surface.
- A known push-service allowlist on top of "https only" (SSRF guard); new browsers' services need `PUSH_ALLOWED_HOSTS`.
- Sign-out unsubscribes this browser from Web Push; an expired session keeps delivering until the user removes the
  device or the push service reports it gone.
- The signed-out ☰ menu exists only while installation is possible, so the signed-out header is otherwise unchanged.

### 31.10 Tests (`clone/tests/pwa.e2e.test.js`)

1. Manifest fields and content type, icons at their declared sizes (PNG headers and decoding in the page), page tags,
   no manifest errors reported by Chromium.
2. Registration (scope `/`, navigation preload on) and control; the hashed entry JS / CSS served by the worker; a
   fresh nonce on every navigation; Cache Storage holds exactly the precache list, no `/v1` / `/trade-api` entry,
   nothing `no-store`, and the only HTML is the offline page, without nonce, boot proof or script.
3. `context.setOffline(true)` → the offline page, styled from the cache, at the requested URL; online again → Retry
   loads the page.
4. A salted rebuild → the toast; the new worker waits; Reload → navigation, the new cache, the old one deleted.
5. Emulated `beforeinstallprompt` → signed-out ☰ and account ☰ entries, the prompt shown once, the 390 px header
   fits; iOS Safari user agent → instructions; standalone → never offered.
6. Web Push end to end. The UI subscribes; the browser's `PushManager` is replaced by one that returns a subscription
   to the **local fake push service**, and full Chromium runs headless because the headless shell denies
   notifications. A market order fills with taker Push on. The fake service verifies the VAPID JWT (ES256 signature
   over the server's key, `aud`, `exp`, `sub`) and decrypts the aes128gcm body with its own independent RFC 8291
   code. The payload equals the inbox row; endpoint, keys and payload are encrypted at rest. The decrypted message
   delivered to the worker (`ServiceWorker.deliverPushMessage`) becomes a notification whose click routes to the deep
   link; a hostile link falls back to `/`. Then: Send test notification, validation errors, another user's path / id
   refused, and a 410 deletes the subscription and empties the list.
7. A 503 is retried with backoff; the server restarts; a row left `sending` resumes; both are delivered.
8. Sign-out: caches emptied, the server row deleted, the browser unsubscribed; a reload precaches again.
9. Forced bot challenge (`challengeMode: 'all'`) through the controlling worker: the 429 page arrives via the worker,
   is solved, the page reloads, and a sign-up (client token, CSRF) succeeds.

Every scenario asserts no CSP violations and no page errors.

### 31.11 Residual risks

- **At-least-once delivery.** A crash between the push service's 201 and the row update re-sends after restart; the tag
  makes the duplicate replace the first notification.
- **Lock screens show the text.** The payload is what the inbox shows; on a shared or unlocked device that text is
  visible outside the app. Users can keep Push off per type in the matrix.
- **The push service sees metadata** (timing, size bucket, endpoint), never plaintext; padding hides lengths only to
  128-byte buckets.
- **VAPID key loss** (master key rotated or lost) invalidates every subscription; users must turn system notifications
  on again (§22.8 has no key rotation).
- **The outbox pump is per process** (PLAN §10 RS1).
- **Push-service allowlist** may lag new browsers. **iOS** delivers Web Push only to apps installed on the Home Screen
  (iOS 16.4+).
- **Old service workers** stay until the browser checks for an update; a broken release is fixed by publishing a new
  build (there is no other remote kill switch).

### 31.12 Content model (ready for the CMS phase)

Every PWA user-facing text, image reference and the manifest are data, so the CMS phase can manage them mechanically:
- **Client strings:** `public/js/content/pwa-strings.js` exports `PWA_STRINGS` (keys `install.*`, `update.*`,
  `offline.*`, `push.*`) and `t(key)`. `pwa.js`, the ☰ menus and Settings › System notifications use keys only.
  The object sits between JSON markers so Node reads it without an ES-module loader (`server/content/pwa.js`
  `clientStrings()`).
- **Offline page:** `public/offline.html` is a template with double-brace keys, filled and HTML-escaped by
  `renderOffline()` at build time (`dist/offline.html`) and by the dev server; an unknown key fails the build.
- **Service worker text** (offline fallback, default notification title) is filled into `sw.js` from the same keys.
- **Server strings:** `SERVER_STRINGS` in `server/content/pwa.js` (test notification title, body and link; push API
  error messages), read with `s(key, vars)`.
- **Manifest:** `PWA_CONFIG` (name, short name, description, colours, icons, shortcuts); `manifestOf(config)` builds
  the JSON; `mountPwaStatic(…, { config })` accepts an object or a function, so the CMS can pass the live settings.
- **Push payloads** carry the notification's own title and body (`features.notify` callers), so the CMS's
  notification templates drive them.
- Not yet data: the `theme-color` / Apple meta tags in `index.html`, and icon files (cache-first by fixed path in the
  worker); the CMS phase should template the meta tags and give edited icons content-hashed URLs.

## 32. Content management (CMS)

Owner requirement (2026-11-04): every user-facing value, text, image, notification and email template is managed in
the admin panel; only technical configuration stays in code (PLAN Phase 5C). Code lives in `clone/server/cms/`
(store, texts, templates, images, sanitiser, routes), `clone/server/content/` (keyed defaults), `clone/public/js/i18n.js`,
`clone/public/js/content-live.js`, `clone/public/js/content/*-strings.js` and `clone/public/js/views/admin/cms.js`.

### 32.1 What is managed where

| Content | Admin › Content & settings | Delivered by | Default when unset |
|---|---|---|---|
| Every SPA string (labels, headings, buttons, placeholders, empty states, help text, toasts, client errors) | Texts | `/content-bundle.js`, `/v1/content/bundle` | `public/js/content/<area>-strings.js` |
| Server wording (currency messages, PWA errors) | Texts (`server.*` keys) | server `t()` (`server/content/catalog.js`) | `server/content/*.js` |
| API error messages | Texts (`error.<code>`) | client `errorText()` | `{message}` (the server's own text) |
| Notification channels (in-app, push, email) per type, account emails, SMS, push test, email layout | Templates | `features.notify`, `notify-prefs`, `messaging`, `auth`, `identity`, `webpush` | `server/content/notification-templates.js` |
| Images (logo, wordmark, favicon, app icon, promo / hero / hub art, category icons, email header, empty states) | Media | `/media/<id>.<png\|jpg>`, bundle `media` | built-in artwork |
| Pages (legal, help, info) and the footer | Pages & footer | `/v1/pages/…`, page template SEO tags, bundle `footer` | `server/content/pages.js` |
| Brand and YES colours per theme, app name, short name, description | Branding | `/content-theme.css`, page template, `/manifest.webmanifest` | `public/app.css`, `server/content/pwa.js` |
| Fees, limits, features, payments, Currency & defaults | links from the hub to the existing panels (§18.6, §26, §30) | unchanged | unchanged |

Home hero, hubs, promos, banners, navigation, info cards, news and help articles keep their §18.5 collections (linked
from the hub); help articles are also served as CMS pages under `help/<slug>`.

### 32.2 Store, roles and workflow

- **Tables:** `cms_entries(type, key, locale, draft_json, published_json, published_version, scheduled_json,
  scheduled_at, …)` and `cms_versions(type, key, locale, version, value_json, action, author_id, author_email, reason,
  created_at)`; media in `cms_media` (originals and generated icon sizes). Additive; nothing else changes schema except
  the `email_outbox.html` column.
- **Roles:** `content.write` (editor: drafts, preview, test send, uploads, export, import dry run) and the new
  `content.publish` (publish, schedule, unschedule, rollback, apply an import). The new role **publisher** has
  `catalog.read`, `content.write` and `content.publish`; admin has everything; editor is unchanged.
- **Draft → preview → publish → schedule → history.** Drafts never reach a public route or the public bundle. The staff
  preview (`?cms_preview=1`, a banner with "Exit preview") swaps in `/v1/admin/cms/preview_bundle` (content.write,
  `no-store`); for anyone else the route answers 401/403 and the client drops the flag. Publishing needs a reason
  (3–500 characters); `at` schedules it (future, within a year). The scheduler (`cms.tickMs`, default 1 s) reads due
  rows from the database, so a schedule that falls due while the server is down is published when it starts.
- **Versions and rollback:** every publish, scheduled publish, rollback and import writes a version; rollback to any
  version, or to version 0 (the code default), is itself a new version.
- **Audit:** each publish, schedule, unschedule, rollback, import, upload and test send writes one hash-chained
  `admin_audit` row (`cms.*`, §22.7) with before/after and the reason.
- **Step-up:** publishing or rolling back a page whose section is `legal` (or an import touching one) needs a fresh
  step-up (`step_up_required`, the admin UI shows the confirm dialog).
- **Live:** a publish emits `content` on the public WebSocket channel with what changed (type and key, never draft
  values); open pages refetch the bundle (ETag, usually 304) and re-render the current route. Strings read once at
  module evaluation (`ts()`) are recorded; a change to one offers "Content was updated · Reload".
- **Export / import:** `GET /v1/admin/cms/export` (all published values and drafts, JSON `{format: "parlance-cms"}`);
  `POST /v1/admin/cms/import` validates every entry with the same rules as the editors, returns a diff
  (add / update / reset / draft) and changes nothing on a dry run; applying needs `content.publish` and a reason and
  runs in one transaction. Entries not in the file are left as they are.

### 32.3 Text catalog

- **Keys:** `<area>.<section>.<slug>` (area = SPA module, section = top-level function or constant). 4,000+ keys:
  every view in `public/js/views/**` and `public/js/*.js`, the shell markup in `index.html` (`data-t` /
  `data-t-attr`), the PWA strings (`pwa.*`), the currency wording (`currency.*`), API errors (`error.<code>`) and the
  server modules (`server.currency.*`, `server.pwa.*`).
- **Defaults** live only in the keyed content modules, one per area, inside a strict-JSON block the server reads
  without an ESM loader. `scripts/cms-extract.js` moved the existing literals there and rewrote the views; it is
  incremental (reuses keys, never overwrites) and is the tool for new strings.
- **Client:** `t(key, vars)` plain text (escaped by the view like any string), `te()` HTML (template escaped, variables
  as given; checked by `parlance/no-unescaped-html`, which now treats `t()` output as unescaped), `ts()` / `tes()` for
  module-level tables, `tr()` rich text, `errorText(code, message, details)` for API errors.
- **Server:** `server/content/catalog.js` `t(key, vars, default)`; overrides of `server.*` keys are installed on
  publish.
- **Variables** are declared by the default (`{amount}` placeholders); a template using any other name is refused on
  save (`undeclared_variable`). Typed variables (`META.vars: {amount: "money"}`) are formatted through the currency
  module on both sides.
- **Plain vs rich:** plain text refuses markup-like sequences (`<tag`, `<!`, `</`), script URLs and control
  characters and is always shown escaped; keys flagged `rich` in a module's META accept HTML reduced by the
  allowlist sanitiser (§32.9) to bold, italic, lists, paragraphs, line breaks and links to `https:`, `mailto:` or site
  paths (external links get `rel="noopener noreferrer"`).
- **Locale-ready:** entries are keyed by locale (default `en-NG`); the bundle carries its locale; adding a locale is a
  store and bundle parameter, not a schema change.
- **Admin › Texts:** search (key, default or text), filter by page (area) and section and state (customised, draft,
  scheduled), per-key editor with the default, declared variables, history with restore, and "Preview in context".

### 32.4 Delivery

- `/content-bundle.js` (classic script, before the app modules) and `/v1/content/bundle` (JSON) carry the published
  client texts, media slots, brand values and footer. `Cache-Control: no-cache` with a strong ETag (304 when unchanged).
- `/content-theme.css` (outside `/v1`, linked only while the brand differs from the defaults) holds the brand colours as CSS custom properties (`--brand`, `--yes`, `--brand-x20`,
  `--yes-x20`) for `:root[data-theme=light|dark]`; no inline styles (§21 CSP).
- The page template is filled per response: `<title>`, description, both `theme-color` metas, Apple title, favicon and
  apple-touch icon from the CMS; on page routes the page's SEO title and description.
- `/manifest.webmanifest` is built from the brand values and the app-icon slot (generated 192, 512 and maskable 512).

### 32.5 Notification and email templates

- Every notification type in the system has a template (`notify.<type>`, plus `notify._default` for any other type)
  with fields in-app title/body, push title/body, email subject, text and HTML. Defaults pass the wording composed by
  the server through (`{{title}}`, `{{body}}`), so existing messages are unchanged until an admin edits them; declared
  variables are `title`, `body`, `link`, `open_line`, `app_name`.
- System messages: `email.verify_email`, `email.password_reset`, `email.security_alert`, `email.email_changed`,
  `sms.phone_code`, `push.test`; their former inline wording is the default.
- Shared email layout `email._layout`: header (the `email_header` image slot when set, else the header text), sanitised
  footer HTML and legal text.
- Logic-free: only `{{name}}`; `{{#…}}`, `{{> …}}`, `{{{…}}}`, dotted or filtered tags and undeclared names are refused.
  Escaping per channel: HTML-escaped in email HTML (link variables must be safe URLs, else `#`), plain elsewhere.
- Wired sends: in-app row and live toast (`features.notify`), email and push channels and their deferred deliveries
  (`notify-prefs`, Web Push payloads), account emails (`auth`, `identity`), the phone code SMS and the push test. Email
  goes out as text plus HTML (`multipart/alternative` over SMTP; `email_outbox.html` in the dev mailbox).
- Preview with sample data (or given variables) and test send to the dev mailbox / dev SMS outbox / the admin's own
  inbox (rate limited).

### 32.6 Media library

- Uploads (`POST /v1/admin/cms/media`, base64 JSON, 12 MB body, 8 MB image): PNG or JPEG recognised by magic bytes
  only; SVG, GIF and everything else refused; 16–4096 px per side, at most 16 MP.
- Polyglots are refused: data after the PNG `IEND` / JPEG `EOI`, or markup / script anywhere in the bytes.
- **Re-encoded server-side:** PNG decoded here (chunk CRCs, inflate with an output cap, all colour types; interlaced
  refused) and written as 8-bit RGBA; JPEG decoded and re-encoded with `jpeg-js` (pinned 0.4.4, resolution and memory
  limits). Only pixels survive: EXIF, XMP, ICC, text chunks and comments are gone.
- Square uploads also get icon sizes (192, 512, maskable 512 with safe-zone padding, apple-touch 180, badge 72,
  favicon 48 and 32).
- Served at `/media/<id>.<ext>`: content-hashed ids, `immutable`, `nosniff`, `Content-Security-Policy: default-src
  'none'; sandbox`.
- Slots: logo, wordmark, favicon, app icon, home and perps promo art, hub art, category icons, email header, empty
  states. Assigning is a draft → publish like any entry, so swaps are live and every earlier assignment can be rolled
  back; uploads are never deleted.

### 32.7 Pages

- Slugs `group/slug`; fields title, section (`legal`, `help`, `info`), SEO title and description, sanitised rich body;
  scheduled publishing and rollback as above; legal pages need step-up.
- Defaults migrated from the static content: terms (`legal/terms`), privacy (`trust/privacy`), responsible trading
  (`support/responsible-trading`), help and FAQ (`support/help-center`), fee schedule (`support/fees`) and the
  incentive terms (`incentives/terms`, shown on `/incentives/terms` once a body is published).
- Routes stay stable: `/legal/:slug`, `/trust/:slug`, `/research/:slug`, `/support/:slug` show the page when it exists,
  else the §25.7 placeholder. The SPA sets `document.title` and the description meta from the page; the server sets
  both on a direct load.
- Footer: tagline and link columns, links limited to site paths or `https:` URLs.

### 32.8 Branding and values

- Brand and YES colours per theme; each must reach 4.5:1 against that theme's surface (`#ffffff` light, `#0d0e11`
  dark), otherwise `contrast_too_low` with the ratio. Applied through `/content-theme.css` (CSS variables), so the
  whole UI follows, live.
- App name, short name and description drive the manifest, the page title and the Apple title; the light brand colour
  is the manifest `theme_color`; both theme-color metas follow the theme colours.
- The hub links the existing technical panels (fees, limits, features, payments, Currency & defaults).

### 32.9 Security

- All CMS output is escaped, or sanitised by allowlist (`server/cms/sanitize.js`: a tokenizer that re-escapes text and
  re-emits only allowlisted elements, `href` only, script / style / iframe / svg contents dropped, `javascript:`,
  `data:`, `vbscript:` and protocol-relative links removed). No raw HTML, no inline event handlers, no inline styles.
- `parlance/no-unescaped-html` treats `t()` / `ts()` output as unescaped and checks every `te()` variable.
- Templates are logic-free; uploads are validated and re-encoded; every admin route has a permission check, the admin
  rate tier and per-user CMS limits (writes 120/min, uploads 30/min, test sends 10/min); bodies are validated with
  `server/validate.js`; every new route is classified in `tests/authz.e2e.test.js`.
- The preview can't leak drafts: drafts are only in staff-only, `no-store` responses; public pages and the WebSocket
  message never carry them.

### 32.10 Enforcement

`eslint-rules/no-hardcoded-text.js` (in `npm run lint`, and run by `tests/cms.e2e.test.js` through
`scripts/check-text.js`): text nodes and text attributes of HTML templates, strings shown with `toast()` / `alert()` /
`confirm()` / `new Error()` / `.textContent` / `.title` / `.placeholder` / `document.title`, and any other sentence-like
literal must come from the catalog. Symbols, class lists, paths, ids, codes, comparison operands and DOM / storage API
arguments are not text; a short commented `ALLOW` list covers data values that look like text (category names, the
iCalendar header).

### 32.11 Design choices to confirm

- Notification templates default to the server-composed wording (`{{title}}`, `{{body}}`) rather than per-type
  sentences, so no existing message changes on day one.
- An import changes only the entries in the file; it does not reset entries missing from it.
- Plain-text keys refuse markup-like input instead of storing and escaping it (defence in depth on top of escaping).
- JPEG uploads are re-encoded with `jpeg-js` (quality 88); PNG with the in-house encoder (Paeth filter, zlib level 9).
- Module-level strings (`ts()`) take a reload to show a live change; the page offers one.
- SMS exists only for the phone code; notification types have no SMS channel, so their templates have no SMS field.

### 32.12 Residual risks

- Server-side wording outside the keyed modules (most API error messages) is reachable only through `error.<code>`
  overrides on the client; emails and notifications are covered by templates.
- The rich-text defaults in code are trusted (not sanitised); only overrides pass the sanitiser.
- One locale is configured; translations need a locale list in the store and a picker.
- Media is stored in SQLite (fine for the sandbox; move to object storage with Phase 9).

### 32.13 Verification

`clone/tests/cms.e2e.test.js` (5 scenarios) and `clone/tests/cms-content.e2e.test.js` (5 scenarios), real server +
SQLite + Chromium: live text edit surviving a restart; draft hidden / preview visible; editor vs publisher; scheduled
publish (also across a restart); rollback (UI and API); undeclared variables; XSS in texts, rich text, templates,
page bodies and links; export → import with a dry-run diff; the enforcement check; templates in the dev mailbox and
in the in-app, push and SMS sends; media re-encode, polyglot / SVG refusal, live slot swap, manifest icons; pages with
schedule, SEO, rollback and legal step-up; brand contrast refusal and live colours in both themes, manifest and
theme-color; 390 px light and dark.

---

## 33. Feature flags, play mode, Central Bank and money controls (Phase 5D)

Owner requirement (PLAN Phase 5D, scope approved 2026-11-04): every feature and module can be switched and rolled out
from the admin panel; the exchange can run as a "fun ride" on play money with a Central Bank and a Vault Heist game, and
be switched to production with every play balance archived and reset; deposits and withdrawals can be switched off site
wide or per user. Nothing here is observed on the live site: every value is a Parlance design choice, stated as such.
Tests: `clone/tests/flags.e2e.test.js` (8 scenarios) and `clone/tests/playmode.e2e.test.js` (8 scenarios).

### 33.1 Pieces

| File | Role |
|---|---|
| `server/flags.js` | Flag registry (`REGISTRY`), route rules (`ROUTE_RULES`), platform core (`CORE_ROUTES`), module map (`MODULE_FLAGS`), job flags; evaluation, the `/v1` gate, changes with history, Admin › Feature flags API, the public bundle |
| `server/play-mode.js` | Play mode master switch and settings, mode markers (SQLite triggers), money gate (play rails, per-user revocation), play deposits, signup bonus, reverse guard, preview, two-person production switch with backup and reset, audit-chain checks |
| `server/central-bank.js` | Vault account, funding, promotions treasury (`engine.treasury`), payout queue, Vault Heist (code, guesses, loot, jail, limits, feed, Most Wanted) |
| `server/content/playmode.js` | Every server-side string of the phase, keyed (`server.playmode.*`, Admin › Content › Texts) |
| `public/js/flags.js` | Client bundle, `flagOn()`, `[data-flag]` hiding (MutationObserver), route gating with the CMS "not available" state, play banner and labels |
| `public/js/views/admin/flags.js`, `public/js/views/admin/playmode.js` | Admin › Feature flags; Admin › Play mode and Admin › Central Bank |
| `public/js/views/heist.js`, `public/playmode.css` | The Vault Heist page; flag, banner, notice and heist styles (tokens only, §27) |
| `public/js/content/{flags,heist,admin.flags,admin.playmode}-strings.js` | Client text catalog modules (§32.3) |

### 33.2 Flags: registry and evaluation

- **Registry.** 51 flags in groups trading, markets, sports, social, notifications, payments, identity, content, pwa,
  platform and play, each with a scope (`both`: routes and UI, `server`: pipeline or job only, `client`: UI only) and a
  parent (a child is off when its parent is): `trading` (limit / market / amount orders, order review, flip sell,
  fractional, scalar, collateral return), `trading.rolling`, `combos` → `combos.rfq`, `perps`, `sports` → `sports.lines`,
  `sports.live_clocks`, `social` → `social.chat`, `social.group_chat`, `watchlist`, `price_alerts`, `payments.deposits`,
  `payments.withdrawals`, `payments.card|bank|crypto`, `interest`, `identity.kyc`, `accounts.signup`, `signin.password`,
  `signin.oauth` → `signin.google|apple`, `signin.passkey`, `ai_summaries`, `ballot`, `incentives`, `rewards`, `hubs` →
  `hubs.widgets`, `notify.inapp|email|push`, `pwa.install`, `pwa.push`, `currency_switch`, `cms.live_updates`,
  `play.signup_bonus`, `play.free_deposits`, `central_bank` → `heist`. New databases start with every flag on except
  `central_bank` (once on it is the promotions treasury, see §33.7).
- **State per flag** (`feature_flags`): `enabled`, `kill`, `rollout_pct` (0–100), `allow_users` / `deny_users` (ids;
  the admin types emails), `allow_roles` / `deny_roles` (admin roles plus `guest`, `user` = any signed-in account,
  `staff` = any admin role), `allow_regions` / `deny_regions` (2-letter countries from the §25 location decision),
  `starts_at` / `ends_at`, `version`.
- **Evaluation** (server-authoritative, per request, for the flag and each parent):
  1. technical override: `FEATURE_FLAGS=perps=off,sports=on` or `start({ flags: { overrides } })` wins over the DB;
  2. kill switch → off; 3. `enabled` false → off; 4. outside the schedule → off; 5. legacy Admin › Settings switch
     (social / perps / combos, §18) off → off; 6. parent off → off;
  7. deny user / role / region → off; 8. allow user / role → on, skipping the rollout; 9. allow regions set and the
     request's region not in it → off; 10. rollout: `bucket(key, uid) < rollout_pct`, where the bucket is the first 4
     bytes of SHA-256(`<key>:<uid>`) mod 100 (stable per user and flag); a visitor without an account is in only at 100 %.
- **Precedence of environment variables.** Technical availability first (`SPORTS=0`, `PAYMENTS_SANDBOX=0`,
  `PAYMENTS_DEMO_FUNDS=0`, `KYC_REQUIRED`, AI keys: the module or provider is not running at all), then
  `FEATURE_FLAGS`, then the kill switch, then the flag's DB state. Documented in `.env.example` and the README.

### 33.3 Enforcement

- **Server gate** (`app.use('/v1', flags.gate)`, after the session, step-up and client-token middleware, before every
  router and the card tokenizer): every request is matched against `ROUTE_RULES` (method + path regex, optionally a body
  predicate: order `type`, a fractional count, a scalar or spread / total market); a matching flag that is off for the
  caller answers **403 `feature_disabled`** with `details` and `feature` set to the flag key (CMS key
  `server.playmode.flag.disabled`, client `error.feature_disabled`). Requests the route itself refuses first (no session
  on a write, another user's `/users/:uid`) are left to it, so authorization errors keep their codes; admin routes are
  gated only where a rule says so (`currency_switch`); `signin.password` never locks out staff (a staff email may still
  sign in to repair a flag).
- **Handlers and pipelines**: fractional and flip-sell checks in the order handler, collateral return in
  `trading-core.js`, notification channels in `features.notify` (in-app; account and money notices always stored) and
  `notify-prefs` (email / push enqueue and send), CMS live pushes in `cms/index.js`.
- **Jobs** pause while their flag is globally off (`jobOn`: override, kill, enabled, schedule, parent; rollout and
  targeting never pause a shared job): sports simulation, perps tick, rolling markets, RFQ maker pump, social
  evaluation, chat housekeeping, interest accrual, incentive snapshots, email / push delivery (queued rows wait as
  `deferred`), Web Push pump, heist expiry, treasury queue.
- **Client**: `GET /v1/feature_flags` → `{flags: {key: bool}, version, next_change_time, play_mode, money}` (booleans
  only, never the targeting lists). `[data-flag="a b"]` elements get `.flag-off` (display none) while any listed flag
  is off — nav links, ☰ and MORE entries, the ticket's order types and review step, event buttons (combo, chat,
  watchlist, alerts, interest, AI summary, spread & total), portfolio tabs, payment methods, sign-in buttons, PWA
  install and push settings, hub widgets, the rolling card; pages of a switched-off feature show the CMS-managed
  "not available" state (`flags.unavailable.*`). The public `feature_flags` WebSocket channel nudges every open page on a
  change (and a schedule boundary, checked each engine tick); the page refetches its own bundle and re-renders.
- **Enforcement test**: every mounted route is matched by a flag rule or by `CORE_ROUTES`; every rule matches at least
  one route; every `mount*` module of `server/app.js` is in `MODULE_FLAGS`; every `[data-flag]` in the SPA and every admin
  label names a registered flag. A new feature module or route group without a flag fails `flags.e2e.test.js`.

### 33.4 Admin › Feature flags

`settings.write`. Table by group with the effective state and why (`kill_switch`, `schedule`, `parent:…`,
`env_override`, `legacy_switch`), rollout, targeting, schedule, job marker; filter and search; **Kill** / **Revive**
(one click, reason) and **Edit** (every field, routes the flag guards, change history). Every change needs a reason
(3–500 characters) and a fresh step-up (`feature_flag_change`), writes a `feature_flag_history` row (version, action
`update` / `kill` / `unkill`, before / after, reason, actor) and one hash-chained `flags.*` audit row, bumps the bundle
version and reaches open pages live. Unknown fields, roles, users or countries, a percentage outside 0–100 and an end
before the start are refused.

### 33.5 Play mode

- **Master switch** (Admin › Play mode, `settings.write`, reason, step-up). Turning it on is refused with
  `real_money_exists` (counts in the body) while any customer (non-system) account has a non-zero balance, an open
  position or resting order, a perps balance or position, a pending payment or a held withdrawal. Turning it off is only
  the production switch (§33.6).
- **Mode markers.** `meta.money_mode` (`real` | `play`) and `meta.money_epoch` (`genesis`, then `pe_…` for each play
  period and `rb_…` for each reset batch). SQLite triggers stamp every new `ledger` row and `journal_entries` row with
  both, so no call site can forget; the ledger audit (§26.6) gains `money_mode_mixed` (an entry of the current epoch in
  another mode), `play_money_in_real_epoch` (postings to `play:mint` in a real epoch) and `vault_non_negative`.
  Balances never mix: real money must be zero to enter play mode and play money is archived to zero to leave it.
- **Signup bonus** (`play.signup_bonus`): an admin-set amount (whole naira; stored in internal cents, §30) credited
  once to every new account (password and OAuth sign-up, through the new-account-defaults hook), as cash minted from
  `play:mint` or paid from the Central Bank vault (setting `source`), with a `bonus_credited` notice (CMS template).
- **Deposits** (`play.free_deposits`): `POST deposits` without a method is a free, instant credit (rail `play`, contra
  `play:mint`, a `payment_transactions` row, Idempotency-Key honoured, the user's own §13.8 limit applies) up to an
  optional daily cap per user (UTC day, `play_deposit_cap`). Every real rail is unreachable: payment-method setup,
  rail deposits and the tokenizer answer `play_mode_rails_off` (gate and `payments.js`).
- **Withdrawals** are refused on every path (`withdrawals_play_mode`: demo, card, bank, crypto, also inside
  `payments.js`); a closed play account's balance goes back to the mint instead of a payout.
- **Labels**: the "Play money" banner on every page (with a link to the heist), "Play cash" in the header balance, a
  "Play money" chip on Portfolio, Transfers and the heist (CMS texts `flags.play.*`).

### 33.6 Switch to production and the reverse guard

1. **Preview** (`GET /admin/play_mode/preview`): exact counts (accounts with a balance, open orders, positions and
   holders, markets with escrow, perps accounts / positions / orders, open RFQs and quotes, active credits, heists in
   progress; accounts and markets kept) and totals (balances, cash, credits, held, reserved, position cost, escrow, perps
   collateral, collateral advances, vault).
2. **Request** (`POST /admin/play_mode/production_switch {reason, confirm: "RESET"}`, `settings.write`, step-up): a
   pending `pm_approvals` row with the preview; other admins are notified; one pending request at a time; 24 h lapse.
3. **Approval by a different admin** (`…/approvals/:id/approve {confirm: "RESET"}`, step-up; same admin →
   `same_admin`; the two-person rule of §28.7, its own table so the resolution desk never sees it) or rejection with a
   note.
4. **Backup first**: `VACUUM INTO <data dir>/backups/parlance-pre-production-<batch>.db` (mode 600). If it cannot be
   written nothing changes (`backup_failed`).
5. **One transaction**: customer resting orders canceled (`production_reset`, reservations released) and archived;
   open RFQs / quotes closed; customer perps orders canceled, every perps position archived and closed; every prediction
   position archived and deleted (every holder, so YES and NO open interest stay paired), collateral advances cleared;
   the journal accounts that held play money outside user accounts (market escrow, `house:collateral_advance`,
   `perps:collateral`, `bank:vault`) closed into `reset:<batch>`; every customer's cash, credits, reservations, holds and
   perps balance archived (`pm_archive_balances`) and set to zero with a `play_reset` ledger row and a balanced journal
   entry; credit grants and held withdrawals marked `reset`; heists voided; play mode, the bonus and the `heist` flag
   off; the real-money epoch `rb_<batch>` starts; the batch, approval, events and a `play_mode.production_switch` audit
   row are written.
6. Live: book deltas, balances, a `production_reset` notice to every customer (CMS template), the bundle nudge (the
   banner disappears).

Accounts, markets, content, history, fills, trades and settlements are kept. The approval executes once
(`approval_closed`), a second request answers `play_mode_off`. System accounts (house liquidity) keep their cash and
resting orders so markets stay quotable; their positions are archived with everyone's.

### 33.7 Central Bank and the promotions treasury

- **Vault**: journal account `bank:vault` (positive = money held); Admin › Central Bank funds (mint from `bank:funding`)
  and defunds (back to it, never below zero) with `users.money`, a reason and step-up; each operation is a `cb_ops` row
  and a `central_bank.fund|defund` audit row. The balance is live on the public `central_bank` channel while play mode
  is on (in production only admins see it).
- **Switches**: the `central_bank` and `heist` flags (Admin › Central Bank shows and flips them with reason and step-up).
- **Play mode**: the vault is the heist's prize pot; crew fees go in, loot comes out; it can also pay the signup bonus.
- **Production**: the vault is the promotions treasury. While the Central Bank is on, the signup bonus (a
  non-withdrawable, expiring credit), incentive rewards (§29.7) and the referral hook (`payments.grantCredit`, Phase 8)
  draw from it. A payout larger than the budget is queued (`cb_payout_queue`, user told) or refused (setting
  `treasury.on_empty`); queued payouts are paid FIFO when the vault is funded (after each funding, every 5 s, or
  "Pay queued now"). With the Central Bank off, incentive rewards keep their §29 accounts and there is no production
  bonus. Every payout is an `engine.credit(…, { contra: 'bank:vault' })`, so the journal reconciles.

### 33.8 Vault Heist

| Rule | Default (Admin › Central Bank) |
|---|---|
| Crew fee (into the vault) | ₦500 |
| Code | `base_digits` (4) + ⌊level / 2⌋ different digits, drawn with `crypto.randomInt` |
| Tries | `base_guesses` (10) − level, at least 3 |
| Timer | 60 s |
| Feedback per try | exact (right digit, right place) and near (right digit, wrong place); alarm = tries used / tries × 100 |
| Loot when cracked | ⌊min(vault × 10 %, ₦50,000, daily cap left) × (0.4 + 0.3 × time left share + 0.3 × tries left share)⌋, never more than the vault |
| Daily loot cap per user | ₦100,000 |
| Attempts per user per UTC day | 5 |
| Caught or out of time | fee lost, jail 10 min |
| Security level | +1 per cracked vault (max 6), −1 per 60 min |

- **Server-authoritative**: the code is AES-GCM encrypted at rest (HKDF sub-key `heist-code:v1`, row-bound AAD) and
  returned only once the heist is over; guesses are validated and judged on the server inside a transaction that
  re-reads the heist and the vault, so two crews cracking at once can never overdraw it.
- **Idempotent**: a start with the same `client_id` returns the same heist (no second fee); each guess carries its
  number `n` and a retried one replays the stored answer (`guess_out_of_order` otherwise).
- **Rate limited**: 6 starts a minute and 10 guesses per 5 s per user, on top of the tiers of §21.
- **Test RNG**: `start({ centralBank: { rng } })` replaces the random draw in tests; it is a process option, ignored
  when `NODE_ENV=production`, never a request field.
- **Feed and Most Wanted**: display names only, current epoch; live on `central_bank`.
- **UI** (`/heist`, MORE menu while play mode is on): the vault door (spins while a heist runs, opens or flashes), the
  security pips, the timer ring, the alarm meter, digit boxes, tries with teal pegs, the result with the revealed code,
  the live feed and Most Wanted; 390 px layout; reduced-motion respected.

### 33.9 Money controls

- **Site wide**: the `payments.deposits` and `payments.withdrawals` flags (every deposit / withdrawal route, every
  rail) with the full flag targeting.
- **Per user** (Admin › Users › Money controls, `users.money`, reason, step-up): revoke deposits, withdrawals or both
  (`money_controls`, history in `money_control_history`, `users.money_controls` audit). Enforced by the gate on every
  deposit path (demo / play, card payment and session, bank deposit, crypto address and simulated deposit) and every
  withdrawal path, and again inside `payments.js`; answers `deposits_revoked` / `withdrawals_revoked` with the reason
  (CMS keys `server.playmode.money.*`). The user gets a `money_controls` notice (template) and the open Transfers page
  switches to the blocked state with the reason, live. `GET /users/:uid/money_controls` and the flag bundle carry it.

### 33.10 API (all `/v1`; every route classified in `tests/authz.e2e.test.js`)

| Method + path | Who |
|---|---|
| `GET feature_flags`, `GET play_mode`, `GET central_bank`, `GET central_bank/feed`, `GET central_bank/most_wanted` | public |
| `GET users/:uid/heists`, `POST users/:uid/heists {client_id?}`, `POST users/:uid/heists/:id/guesses {guess, n?}`, `GET users/:uid/play_money`, `GET users/:uid/money_controls` | owner |
| `GET admin/flags`, `GET admin/flags/:key`, `PUT admin/flags/:key`, `POST admin/flags/:key/kill` | settings.write |
| `GET admin/play_mode`, `GET admin/play_mode/preview`, `PUT admin/play_mode {on: true}`, `PUT admin/play_mode/settings`, `POST admin/play_mode/production_switch`, `POST admin/play_mode/approvals/:id/{approve,reject}` | settings.write |
| `GET admin/central_bank` | users.read |
| `POST admin/central_bank/{fund,defund}`, `POST admin/central_bank/queue/process` | users.money |
| `PUT admin/central_bank/settings` | settings.write |
| `GET admin/users/:id/money_controls` / `PUT …` | users.read / users.money |

Tables: `feature_flags`, `feature_flag_history`, `money_controls`, `money_control_history`, `pm_events`, `pm_approvals`,
`pm_reset_batches`, `pm_archive_balances`, `pm_archive_positions`, `pm_archive_orders`, `pm_archive_perps`,
`pm_archive_accounts`, `cb_ops`, `cb_heists`, `cb_guesses`, `cb_payout_queue`; columns `money_mode`, `money_epoch` on
`ledger` and `journal_entries` (additive, filled by triggers). Settings rows `admin_settings.play_mode`,
`central_bank`, `central_bank_state`. WebSocket: public `feature_flags` (also per-user), `central_bank`. Start options
`flags: { overrides }`, `playMode`, `centralBank: { rng, now }` (tests only, ignored in production). New error codes are
in the client catalog (`scripts/cms-error-keys.js`). Notification templates `notify.bonus_credited`,
`notify.heist_result`, `notify.money_controls`, `notify.production_reset` (Transfers row of the matrix).

**Changes to existing code** (small, exact edits): `app.js` (flag creation and gate, mounts, fractional and flip-sell
checks), `index.js` (options), `ws.js` (channels), `journal.js` (audit hook), `currency.js` (new-account hook),
`payments.js` (play deposit routing, money guard calls, treasury for `grantCredit`), `payments-admin.js` (play rail
excluded from provider reconciliation), `identity.js` (closure contra in play mode), `incentives.js` (treasury payouts),
`history.js` (new ledger kinds), `notify-prefs.js` and `features.js` (channel flags, new types), `trading-core.js`
(collateral-return flag), `cms/index.js` (live-update flag), `cms/texts.js` (server module, preview routes), the tick
handlers of `sports.js`, `perps.js`, `rolling.js`, `combos.js`, `chat.js`, `social2.js`, `incentives.js`, `webpush.js`
(job pause), and `[data-flag]` hooks in the views. Existing tests: `authz.e2e.test.js` classifies the new routes; no
existing assertion changed.

### 33.11 Design choices to confirm

- `central_bank` starts off on a new database (so §29 incentive payouts keep their accounts until the treasury is
  funded and switched on); every other flag starts on.
- The legacy Admin › Settings feature switches (social, perps, combos) stay and are evaluated together with the flags.
- The production switch keeps the house liquidity account's cash and resting orders (markets stay quotable) but archives
  every position, including house positions, so open interest stays paired.
- Production bonus = non-withdrawable promotional credit from the treasury; play bonus = play cash.
- Play deposits keep the user's own deposit limit and Idempotency-Key; the daily cap is per UTC day.
- Money notices (bonus, heist, controls, reset) use the Transfers row of the notification matrix (email and push on by
  default).
- The heist uses unique digits and the loot formula above; the security level decays one step per 60 minutes.
- A play-mode account closure returns the balance to the mint (no payout).

### 33.12 Security

See `SECURITY.md` §16: server-authoritative evaluation, booleans-only bundle, gate order (authorization first), staff
sign-in bypass, step-up + reason + audit on every change, two-person rule + typed RESET + backup on the reset, trigger
mode markers and audit checks, vault overdraw prevention by transaction, encrypted heist codes, test-only RNG, rate
limits, idempotency.

### 33.13 Residual risks

- Per-process state: flag cache, heist rate limits and the job pauses assume one server (PLAN §10 RS1).
- ~~The backup is a plain SQLite file in the data directory~~ — closed by Phase 9A (§39.3): the pre-production backup is
  an encrypted, checksummed snapshot in the backup store (an S3-compatible bucket in production).
- The reset is one transaction on SQLite; a very large database would hold the write lock for its duration.
- Region targeting uses the simulated IP table / browser location of §25 (not a real geolocation provider).
- A rollout is by account; anonymous visitors only see a feature at 100 %.
- The funding of the vault is a mint in this sandbox; a real treasury would be funded from a real account.

### 33.14 Verification

`clone/tests/flags.e2e.test.js` (8 scenarios): the enforcement scan; every flag off hides its UI and blocks its API
(42 flags probed through the UI and/or API, parents, in-app and email channels, CMS live updates); rollout buckets,
allow / deny users and roles, regions; schedule boundaries live on an open page; kill switch, reason, step-up, history,
audit chain and the Admin UI with a live update of another user's page; the sports job paused; per-user money controls
from Admin › Users on every rail with the reason live, and the site-wide switches; persistence across a restart and the
start override over a DB kill switch. `clone/tests/playmode.e2e.test.js` (8 scenarios): see the file header.

## 34. Perps completion (Phase 6)

PLAN Phase 6 (gap G11): order amend and decrease, order groups, subaccounts with transfers, trailing stops (P6.1);
size-tiered margin, a portfolio maintenance-margin model and fractional perps (P6.2); APY on collateral, referrals and
waitlist access (P6.3); and the security gate (liquidation and funding invariants under property-based tests, risk
limits at the API). Evidence is what §13.19 and §14 already cite: the margin docs have `amend` / `decrease` and order
groups for both products, `SubaccountType = cross | isolated | auto_rebalance` with subaccount numbers, trailing-stop exit
triggers, `leverage_estimates` that fall with notional, `FixedPointCount` sizes, the "Perps 7% APY" spotlight (§13.10),
`GET /v1/users/{id}/margin_waitlist` and the referrals summary shape (§13.19). Formulas, limits and screens are
Parlance design choices, marked as such. Tests: `clone/tests/perps-trading.e2e.test.js` (8 scenarios, P6.1),
`perps-risk.e2e.test.js` (7, P6.2), `perps-growth.e2e.test.js` (5, P6.3) and `perps-invariants.e2e.test.js` (4, the
security gate); `perps.e2e.test.js` (12) still passes on the rewritten engine.

| File | Role |
|---|---|
| `server/perps.js` | The engine and its REST API: units, subaccounts, cost basis, size tiers, amend / decrease, order groups, trailing stops, isolated and portfolio liquidation, zero-sum funding, collateral bridge |
| `server/perps-ledger.js` | The perps double-entry journal (centicents) and its audit, joined to the main ledger audit |
| `server/perps-risk.js` | Bracketed tier requirements, blended max leverage, closed-form liquidation price, tier validation, risk-limit defaults |
| `server/perps-ops.js` | Admin › Perps ops API (tiers, risk limits, APY, waitlist, referral settings, journal check); the waitlist gate, APY accrual and payouts, the Perps referral program, the production-switch hooks |
| `server/referrals.js` | Reusable referral programs (codes, fraud checks, qualification, rewards, caps); Phase 8 adds programs to it |
| `server/content/perps.js` | Server wording, keyed (`server.perps.*`, Admin › Content › Texts) |
| `public/js/views/perps-more.js`, `public/js/views/admin/perps-ops.js` | Subaccounts, order groups, rewards, waitlist card, amend and trailing editors, tier table; Admin › Perps ops panels |
| `public/js/content/{perps2,admin.perps}-strings.js` | Client text catalog modules (§32.3) |

### 34.1 Subaccounts and transfers (P6.1)

- Subaccount `0` is the primary (its free collateral stays in `perp_accounts.available_cc`, so nothing existing moved);
  `POST /perps/subaccounts {name, margin_mode}` adds `1…31` (Admin limit, default 10). Each has a name and a margin
  mode, `isolated` (margin per position, as before) or `cross` (portfolio margin, §34.4); `PUT /perps/subaccounts/:n`
  renames or changes the mode, the mode only when the subaccount is flat with no resting orders (`409 subaccount_busy`).
- Orders, closes, exit triggers and the Predictions transfer take `subaccount` (default 0); positions are keyed by
  (user, subaccount, market); reads filter with `?subaccount=`. Self-trade prevention spans all of a user's
  subaccounts.
- `POST /perps/subaccounts/transfers {from_subaccount, to_subaccount, amount_dollars, client_transfer_id?}` moves free
  collateral between two subaccounts of the caller (whole cents; `Idempotency-Key`; a duplicate `client_transfer_id` is
  `409`); `perp_transfers` records it with `source = destination = margined` and both numbers. Unknown subaccounts are
  `404 subaccount_not_found`; they are per user, so another user's numbers do not exist for the caller.
- Withdrawals from a subaccount (to Predictions, or to another subaccount) are limited to its **withdrawable** amount:
  the free balance for an isolated subaccount; for a portfolio (`cross`) subaccount with open positions, the part of the
  free balance that keeps its equity at or above the positions' initial margin (`min(free, equity − IM)`), since there
  the free balance backs every position. More is `409 insufficient_margin` ("you can move at most … out of this
  portfolio subaccount"). Balances carry `withdrawable_dollars`; Subaccounts shows "… can move out" when it is less
  than the free balance. Without the limit a losing portfolio could be emptied and its loss left to the insurance fund
  and the house.
- UI: Perps portfolio › **Subaccounts** (table with mode, free, equity, maintenance, margin ratio; create; move funds;
  switch mode); the ticket and the transfer box get a subaccount picker once there are two; positions show the
  subaccount and "Portfolio margin".

### 34.2 Order amend, decrease and order groups (P6.1)

- `POST /perps/orders/:id/decrease {reduce_by | reduce_to}` (contracts, `_fp` spellings too) shrinks a resting order
  in place (same id, same queue place); the reservation is released pro rata; zero cancels it (`cancel_reason
  decreased`).
- `POST /perps/orders/:id/amend {price?, count?, client_order_id?}`: `count` is the new remaining size. The same price
  with a smaller count is a decrease; a new price or a larger count cancels the order (`cancel_reason amended`) and
  places its replacement (new id, `amended_from`) **in one transaction** with every check (band, margin, tiers, limits,
  group); if any check fails nothing changes. Response `{old_order, order}`.
- **Order groups** (`perp_order_groups`): `POST /perps/order_groups {kind: limit | oco, contracts_limit?, subaccount?}`,
  `GET`, `GET /:id` (with its orders), `DELETE /:id` (group-level cancel: every resting order of the group, then the
  group is `canceled`), `POST /:id/reset` (a triggered group becomes active again with nothing filled). Orders join
  with `order_group_id` (same subaccount, active group).
  - `limit`: the group's fills never exceed `contracts_limit`: a taker's size is capped, makers are filled only up to the
    remaining capacity during matching, and at the limit every other resting order of the group is canceled
    (`order_group_limit`), status `triggered`.
  - `oco` (one cancels the other): the first fill of any order cancels the group's other orders (`order_group_oco`); two
    makers of one OCO group are never both filled by one sweep.
  - Limits: active groups per user (20) and open orders per group (25), Admin-editable.
- UI: Open orders › **Edit** (price and contracts left; smaller size at the same price = decrease); Perps portfolio ›
  **Order groups** (create, filled of limit, open orders, Cancel all, Reset); the ticket's group picker.

### 34.3 Trailing stops (P6.1)

- `PUT /perps/positions/:ticker/exit_trigger {kind: 'trailing', trail_percent | trail_amount, subaccount?}`;
  one active bracket and one active trailing stop per position (`DELETE …?kind=trailing`). Stored with the trail
  (`trail_bps` or `trail_cc`), the **watermark** (best mark since it was set: highest for a long, lowest for a short) and
  the current stop.
- Server-side tracking: on every evaluation (each engine tick and every index change) the watermark is updated first
  and persisted, then the stop is recomputed (`watermark ∓ trail`) and compared with the mark. A gap through the stop
  fires at that evaluation with a reduce-only market order (mark ± 5 %); the trigger row is updated in the **same
  transaction** as the order, so it fires exactly once; `triggered_leg = trailing_stop`, `fired_mark_cc`, fill source
  `trailing_stop`, a notification. Between two evaluations only the endpoint mark is seen (design choice; ticks are
  sub-second). Closing or flipping the position cancels it. With the flag off no new trailing stop can be set; active
  ones keep protecting their positions.

### 34.4 Size-tiered margin, portfolio margin and risk limits (P6.2)

- **Tiers** (`perp_margin_tiers`, Admin › Perps ops): notional brackets with an initial and a maintenance rate. The
  requirement is **bracketed**: `MM(N) = Σ rate_k × (part of N inside tier k)` (continuous, rising faster than linearly);
  the blended maximum leverage at N is `N / IM(N)`; tier 1's initial rate is `1 / max_leverage` (editing either keeps
  the other in sync); the last cap is the **maximum position**. Defaults from max leverage: $50k at the full leverage,
  $250k at half, $1M at a quarter, maintenance = initial / 2, so every position of §14 keeps its old numbers.
  `leverage_estimates` and `margin_tiers` / `max_position_notional_dollars` in the market and `risk_parameters` come
  from the tiers.
- **Risk limits**, checked before collateral, on the worst case (this order's fills and resting remainder plus the
  subaccount's other same-side resting orders), only when exposure grows: `409 position_limit` above the maximum
  position; `400 leverage_exceeds_tier` when the chosen leverage exceeds the blended maximum at that size; `400` above
  max leverage; `409 open_order_limit` for open orders per market (50) and in total (200); subaccounts (10) and order
  groups (20) per user. A market order's check applies to what it can fill against the book.
- **Isolated** positions liquidate when margin + unrealized PnL < their bracketed MM. The estimated liquidation price
  is the closed-form root of `margin + q(m − entry) = MM(|q|·m)` solved tier by tier.
- **Portfolio (cross) margin** per subaccount: equity = free + reserved + Σ(margin + unrealized PnL); the portfolio
  MM is Σ of each position's bracketed MM. New exposure must leave equity ≥ Σ initial margin. When equity < portfolio
  MM, the subaccount's resting orders are canceled, then positions are closed at the mark **largest requirement first**
  until equity covers what is left. A loss beyond a position's margin draws first on the subaccount's free collateral,
  then on its other positions' margins, then the insurance fund, then the backstop. The liquidation price shown for a
  cross position holds the others at their marks.

### 34.5 Fractional perps (P6.2)

- Quantities are integer **units** (hundredths of a contract), as event contracts (§16.1); a one-time migration
  (`perp_meta units_v1`) multiplied every count column by 100. Inputs `count` / `count_fp` follow §16.4 (≤ 2 decimals,
  ≥ 0.01, must match); per-market `fractional_trading_enabled` (`PLXUS10YPERP` is whole-contract only:
  `400 fractional_not_enabled`); the flag `perps.fractional` off allows whole contracts only; a held fractional
  position can always be closed in full. Fees, margin and funding are computed on units exactly
  (`fee = ⌈units·p·rate/100⌉`, `margin = ⌈units·p/(100·lev)⌉`, `funding = round(−units·mark·rate/100)`).

### 34.6 Money: cost basis and the perps journal

- Positions keep an integer **cost basis** in unit-centicents (`cost_ucc = Σ units × price`); a close releases cost
  pro rata and realizes `closing × price − released` (long) exactly; the user side is paid whole centicents rounded down
  and the remainder is the `rounding_ucc` tally. So, exactly, `Σ realized + Σ unrealized = 0` over all parties.
- `server/perps-ledger.js` journals **every perps money movement double-entry in centicents**: transfers through
  `perps:bridge` (always `−100 ×` the main journal's `perps:collateral`), order reservations, margin locks and releases,
  fees, realized PnL, funding (`perps:funding`, zero after every event), liquidation fees and shortfalls
  (`perps:insurance`, then `perps:backstop`), subaccount transfers, APY and rewards, the liquidity float. Its audit is
  part of the main ledger audit (Admin › Payments, the audit job, Admin › Perps ops › Perps journal): entries balance,
  tables equal postings per subaccount, nothing negative, the bridge, funding zero-sum, insurance ≥ 0, and
  `−100 × perps:pnl + rounding = Σ signed cost basis of open positions`. Entries carry the money mode and epoch (the
  §33.5 triggers now include `perp_journal_entries`).
- Funding is zero-sum by construction: each user position pays or receives `round(−q·mark·rate)` and the liquidity
  account takes the exact opposite of their sum.

### 34.7 APY on Perps collateral (P6.3)

- Admin › Perps ops › APY (`PUT /admin/perps_ops/apy {enabled, rate_percent | rate_bps, payout_interval_ms, reason}`,
  step-up, audited): a yearly rate on each subaccount's collateral (free + reserved + margin; unrealized PnL does not
  earn). The accrual job (flag `perps.apy`) accrues continuously (`base × rate × Δt / 365 d`, per subaccount, in
  `perp_apy_accruals`) and pays whole cents at each interval (`perp_apy_payouts`; "Pay out now" too). Turning it on
  starts its clock; nothing is back-dated for time it was off.
- Funding source (§33.7): **play mode** → play money minted from `play:mint`; **production** → the promotions treasury:
  paid from `bank:vault` while it covers the amount, otherwise **queued** (`cb_payout_queue` with a Perps destination,
  paid FIFO into the subaccount when the vault is funded) or **refused** (per the treasury setting; refused interest is
  dropped); production without the Central Bank → refused. Journaled in both journals in one transaction.
- Test hook: the accrual clock is the start option `perps.apy.now` (ignored in production); no request field reaches it.
- `GET /perps/apy` (rate, accrued, next payout, payouts); Perps portfolio › **Rewards**; at most one notice per hour.

### 34.8 Perps referrals (P6.3, reusable module)

- `server/referrals.js` holds programs (`referrals:<program>` settings), codes (one per user per program, 10 symbols
  from a 32-letter alphabet without look-alikes, crypto RNG), referrals (`pending → rewarded | expired | void`) and
  rewards (`paid | queued | refused | capped`); the owning module supplies the payout and eligibility. Phase 8 adds
  predictions referrals as another program.
- Perps program: a friend adds a code (`POST /perps/referrals/apply`) within 30 days of signing up and before their first
  Perps trade; once their Perps volume reaches the threshold ($100) within 30 days, the friend gets a bonus ($5) and
  the referrer a reward ($10) in Perps collateral, through the same treasury path as APY; lifetime caps per referrer
  (20 rewards, $200; 0 = none) mark rewards over the cap `capped`. Fraud checks: no self-referral, one code per user,
  late codes refused, 5 attempts per user per minute (code guessing), system accounts never qualify, and volume the
  friend trades against the referrer (the pair trading with each other) never counts towards the threshold.
- `GET /perps/referrals` follows the observed summary shape (§13.19): code, offer, caps, earned, pending / completed /
  expired, referrals, referred-by progress, rewards. Admin › Perps ops › Referrals edits the settings (step-up).

### 34.9 Waitlist access (P6.3)

- Flag `perps.waitlist` (on = access by invitation; off by default in Phase 6, **on by default since Phase 7A**, with a
  one-time audited migration for existing databases, §36.1). `GET /perps/waitlist` returns the observed shape
  (`has_joined, beta_unlocked, can_start_onboarding, …`) plus `status`, `position` and `waiting_count`;
  `POST /perps/waitlist` joins (idempotent).
- Enforced in the flag gate before any route: while on, Perps writes that add money or risk (orders except reduce-only,
  amends, transfers in, subaccounts, order groups) need access: `403 perps_waitlist` with the caller's waitlist state.
  Reads, cancels, decreases, closes, reduce-only orders, exit triggers, referral codes and transfers back to Predictions
  always work, so no money is trapped. Staff and users with earlier Perps activity are approved automatically
  (`grandfathered`). Deny a user or role on the flag to exempt them.
- Admin › Perps ops › Waitlist: positions in line, **Invite next N** (FIFO), **Approve selected**, **Revoke selected**,
  with reasons in the audit log. In-app notifications `perps_waitlist_joined` / `perps_waitlist_approved` (templates
  `notify.perps_waitlist_*`; account notices outside the observed §13.16 matrix, which stays as observed) and system
  emails `email.perps_waitlist_joined` / `email.perps_waitlist_approved` (Admin › Content › Templates › Perps email,
  sent through the messaging provider while `notify.email` is on), all wording keyed; the user's open page unlocks live
  over the `perp_account` channel.

### 34.10 Admin, flags, API, tables, WebSocket

- **Admin › Perps ops** (`perps.ops`; Risk and Admin roles): the market table (§18.6) plus Margin tiers (per market,
  add / remove / edit, validated: caps increase, rates never fall, maintenance below initial), Risk limits, APY,
  Waitlist, Referrals and the Perps journal (balanced, insurance, backstop, fees). Every change: reason + audit; tiers,
  risk limits, APY and referral rewards also a fresh step-up.
- **Flags** (under `perps`): `perps.subaccounts`, `perps.portfolio_margin`, `perps.order_groups`, `perps.amend`,
  `perps.trailing_stops`, `perps.fractional`, `perps.apy` (job), `perps.referrals` (job), `perps.waitlist` (off by
  default); route rules in `server/flags.js` (signed-in reads answer 401 before `feature_disabled`); `mountPerpsOps`
  maps to `perps`. Tiered margin and the risk limits are not switchable (risk controls always apply).
- **User API** (`/v1/perps`, signed in, scoped to the caller): `subaccounts` (GET, POST), `subaccounts/:n` (PUT),
  `subaccounts/transfers` (POST), `orders/:id/amend`, `orders/:id/decrease`, `order_groups` (POST, GET),
  `order_groups/:id` (GET, DELETE), `order_groups/:id/reset`, `apy`, `waitlist` (GET, POST), `referrals`,
  `referrals/apply`; public `markets/:ticker/margin_tiers`. **Admin** (`/v1/admin/perps_ops`, `perps.ops`):
  `margin_tiers`, `margin_tiers/:ticker`, `risk`, `apy`, `apy/payout`, `waitlist`, `waitlist/{approve,revoke,invite}`,
  `referrals`, `ledger`. All classified in `tests/authz.e2e.test.js`; body schemas and size limits in
  `server/validate.js`; `Idempotency-Key` on subaccount transfers and amends.
- **Tables** (new): `perp_subaccounts`, `perp_order_groups`, `perp_margin_tiers`, `perp_journal_entries` /
  `_postings` / `_balances`, `perp_waitlist`, `perp_apy_accruals`, `perp_apy_payouts`, `referral_codes`, `referrals`,
  `referral_rewards`, `pm_archive_perps_balances`; new columns: `subaccount` on orders, fills, funding payments,
  liquidations, triggers and the perps ledger; `cost_ucc` on positions (key now user + subaccount + market, rebuilt
  once); `order_group_id`, `amended_from`, `cancel_reason` on orders; trailing columns on triggers;
  `from_subaccount` / `to_subaccount` on transfers; `fractional_trading_enabled` on markets; `dest_json` on the treasury
  queue. Settings `perps_risk`, `perps_apy`, `perps_apy_state`, `referrals:perps`.
- **WebSocket**: the private `perp_account` channel also carries `perp_subaccounts`, `perp_order_group`,
  `perp_waitlist`, `perp_apy` and `perp_referral` messages.

### 34.11 Security gate

- Property-based tests with a small deterministic harness (`tests/lib/property.js`: seeded PRNG, generators, the seed
  and the last actions printed on failure; `PROPERTY_SEED` / `PROPERTY_RUNS` replay or widen a run):
  fill arithmetic conserves PnL exactly (300 seeds); tiered MM is continuous and non-decreasing and the liquidation
  price solves equity = MM (300 seeds); the live engine under random orders, amends, decreases, closes, index moves
  with ±25 % gaps, funding, transfers, subaccount moves, trailing stops and order groups on isolated and cross
  subaccounts (5 seeds × 110 actions): after **every** action the ledger audit balances, an independent equation over
  the tables holds (collateral held = money bridged in + realized − fees + funding + shortfalls covered), nothing is
  negative, insurance + backstop = liquidation fees − shortfalls with the fund ≥ 0, every funding event sums to zero,
  open interest pairs, and after every mark change nothing stays open under maintenance margin; targeted gaps cover an
  isolated shortfall (other collateral untouched) and a portfolio liquidation.
- Risk limits at the API (`perps-risk`): max leverage, leverage per tier, max position counting resting orders,
  open orders per market and in total, subaccounts and order groups; IDOR probes (`authz`) for amend / decrease, order
  groups and subaccounts. See `SECURITY.md` §17.

### 34.12 Switch to production

The §33.6 reset now also archives every subaccount's free collateral and unpaid APY accrual
(`pm_archive_perps_balances`), deletes accruals, cancels queued APY payouts and queued referral rewards, voids pending
referrals, cancels active order groups and every resting perps order, zeroes all collateral, and closes every perps
journal account into `perps:reset:<batch>` before the epoch changes; the liquidity float is reopened in the real
epoch. The preview counts subaccounts with a balance, accruals, queued payouts, pending referrals, queued rewards and
active groups, with the accrued total. The reverse guard counts subaccount balances.

### 34.13 Design choices (confirmed by the owner 2026-11-08)

All choices below are accepted as built, with one change: the **Perps waitlist is on** (`perps.waitlist` enabled by
default; grandfathering, staff exemption and protective actions unchanged). Built in Phase 7A (PLAN.md).

- Subaccount 0 keeps its balance in `perp_accounts`; up to 32 subaccount numbers, 10 by default; `auto_rebalance` is
  not built.
- Amend's `count` is the new remaining size; an amend that is a pure decrease keeps the order id and queue place.
- Limit groups cap fills during matching (never overfill); OCO keeps the filled order's remainder.
- Trailing stops see the mark at each evaluation (tick or index change), not intra-tick highs; they keep firing while
  their flag is off.
- Tier defaults ($50k / $250k / $1M at 1×, 2×, 4× the base initial rate, maintenance = half) and bracketed (marginal)
  requirements; leverage checked against the blended maximum of the worst-case size.
- Portfolio margin closes the largest requirement first; a cross loss draws on free collateral, then other margins.
- A margin lock never overdraws: when rounding leaves a maker a few centicents short, the position's margin is that
  much smaller (instead of an insurance draw).
- APY on free + reserved + margin, accrued per subaccount, whole cents per payout, refused interest dropped; 7 %
  default rate offered but off until an admin enables it.
- Referral defaults ($10 / $5, $100 volume, 30 days, caps 20 / $200), rewards in Perps collateral.
- Waitlist: grandfathering on prior Perps activity; staff exempt; protective actions always allowed; its emails are
  system emails (always sent while email delivery is on), not a new row of the observed notification matrix.
- APY payouts use the Transfers row of the matrix and referral rewards the observed "Referral rewards" row.

### 34.14 Residual risks

- Per-process state: referral attempt limits, APY notice throttling and the flag cache (PLAN §10 RS1).
- The APY base is sampled per accrual step (about a second); collateral moved between steps earns on the sampled value.
- Trailing stops and liquidations act on discrete evaluations; a market that gaps between them fills at the next mark
  (with the 5 % market-order band). The liquidity account is the only counterparty for liquidations; a real exchange
  would need a liquidation queue and an auction.
- The backstop is an accounting account (the house); there is no auto-deleveraging.
- Referral fraud checks are account-level only (no device or payment-instrument linkage yet; Phase 8 / P3.7 signals).
- The units migration and the position-table rebuild run once on first boot of an old database; take a backup first.

### 34.15 Verification

`perps-trading` (8): subaccounts created and funded through the UI, moves between them, trading in a subaccount, the
journal balanced; amend and decrease from Open orders (same id vs replacement, reservations); a limit group that
cancels the rest at its limit, OCO, group-level cancel and reset; a trailing stop whose watermark follows live and that
fires exactly once on a spike-and-gap; each capability's flag off and on; persistence across a restart (a persisted
watermark fires after it); 390 px layouts. `perps-risk` (7): tiers on the market page and in the ticket, edited in
Admin › Perps ops; risk limits at the API (also through Admin › Perps ops › Risk limits); a position across tiers
liquidating on its bracketed MM; a cross subaccount surviving the move that liquidates the same isolated position, then
liquidating largest-first with no negative collateral; fractional sizes (UI, `count_fp`, partial close, whole-contract
market, funding on units, the flag); persistence. `perps-growth` (5): APY set in the admin UI, accrued on the injected
clock, queued, paid when the vault is funded, refused per setting, paused by its flag; referrals through the UI with
fraud checks and caps; the waitlist gate, join with position, bulk invite unlocking an open page live, a CMS-edited
approval email, revoke, persistence; play-money APY and rewards and the production switch zeroing the new balances.
`perps-invariants` (4): §34.11.

---

## 35. Public trading API (Phase 7)

Evidence: §5 (Trade API v2 protocol facts, envelopes, rate tiers), §6 (`api_keys` call site), §7.1 (public WebSocket),
§13.18 (developer portal), §13.19 (A2 lock on `/users/{uid}/api_keys`), §14.11 (`/trade-api/ws/v2/margin`), PLAN P7.1–P7.4,
A16, A17. Everything else in this section is a design choice of the clone, listed in §35.14.

### 35.1 Pieces

| Module | Role |
|---|---|
| `server/api-keys.js` | Keys (create / rotate / revoke), signature verification, replay store, owner checks, rate tiers (RateStore), usage, Account › API keys and Admin › API keys routes, notifications and emails, the expiry job |
| `server/api-registry.js` | The single route registry: schemas, the validator, OpenAPI 3.1 and AsyncAPI 2.6 generation, query checks |
| `server/trade-api.js` | `/trade-api/v2`: the auth gate, every operation, internal dispatch into the `/v1` pipeline, Predictions order groups, batches, history, Perps under `/margin` |
| `server/trade-ws.js` | `/trade-api/ws/v2` and `/trade-api/ws/v2/margin` |
| `server/fix.js` | FIX 4.4 gateway, its message tables, Admin › FIX sessions routes |
| `server/dev-portal.js` | `/docs/*.json`, `/v1/developer/*`, `/v1/status`, incidents (CMS type), docs seeding, the demo proxy and provisioning |
| `server/content/api.js`, `server/content/developer-docs.js` | Server wording; the portal's prose defaults (seeded into the CMS) |
| `public/js/views/api-keys.js`, `docs.js`, `status.js`, `admin/api-keys.js`, `public/js/docs-sign.js`, `public/developer.css` | Account › API keys, the portal, the status page, Admin › API keys and Status incidents, WebCrypto signing |

### 35.2 API keys (P7.1)

- **Account › API keys** (`/account/api-keys`, a sub-tab of Account & security). Locked by the A2 lock (403
  `permission_denied`, §13.19) until identity verification is approved; creating and rotating also need a fresh step-up
  (`api_key_create`, `api_key_rotate`). Revoking needs neither.
- **A key:** label (1–60 plain characters), scopes `read` (always) + optional `trade` (order entry) + optional `perps`
  (the margin product), optional IP allowlist (at most 20 IPv4 / IPv6 addresses or CIDR ranges), optional expiry (at most
  2 years), tier (default Basic). At most 10 active keys per user (setting).
- **Two modes:** `generate` — RSA-2048 made on the server; the PKCS#8 private key is in the create response only
  (`Cache-Control: no-store`), shown once with copy / download / "I have saved it", never stored or logged; `public_key`
  — the user pastes an RSA (2048–8192 bit) or Ed25519 SPKI PEM; a pasted private key is refused before anything is stored.
- **Stored** (`api_keys`): id (`plxk_<uuid>`; demo `plxdemo_<uuid>`), user, label, algorithm, public key PEM,
  fingerprint (`SHA256:<base64>` of the SPKI DER), origin, scopes, allowlist, tier, status, env, created / expires /
  revoked times, rotated from / to, last used time and IP.
- **Rotation** makes a new key with the same label, scopes, allowlist, expiry and tier; the old key's expiry becomes
  `min(expiry, now + grace)` (admin setting `rotation_grace_seconds`, default 24 h). **Revocation** (owner or staff, with
  a reason) is immediate; the `revoked` event ends the key's WebSocket sessions (close 4401 after `session_revoked`) and
  FIX sessions (Logout). Expiry is swept every engine tick; owners get a notice `expiry_notice_days` (3) before.
- **Usage** (`api_key_usage`, per key per UTC day): requests, 429s, errors, WebSocket connections, FIX messages; flushed
  every 2 s; shown in the usage dashboard (14 days) and Admin › API keys (30 days).
- **Notifications and emails** (CMS, §32.5): `notify.api_key_created` / `_revoked` / `_expiring` and
  `email.api_key_created` / `_revoked` / `_expiring`.
- **Admin › API keys** (`users.read`; tier and revoke `users.support`; settings `settings.write` + step-up): search by
  email, key id or label; tier select with reason; usage dialog; revoke with reason; rate-tier and grace settings; live
  FIX sessions with disconnect.

### 35.3 Signed requests

Headers `PARLANCE-ACCESS-KEY`, `PARLANCE-ACCESS-TIMESTAMP` (unix ms), `PARLANCE-ACCESS-SIGNATURE` = base64 of the
signature over `timestamp + METHOD + path` (path without the query string). RSA: RSA-PSS, SHA-256, salt length 32 (the
digest length); Ed25519: Ed25519. The `KALSHI-ACCESS-*` names are **not** accepted (§35.14). Checks in order: headers →
well-formed → environment prefix → window (default **5 s past, 1 s future**; start options `api.windowPastMs` /
`windowFutureMs` or Admin settings) → signature (unknown ids verified against a dummy key) → key active and unexpired →
owner not locked (`acct_locks`), closed (identity `closed`: closure / self-exclusion) or frozen (deposits and withdrawals
both revoked) → replay (state-changing requests; `api_replay`) → IP allowlist. Failures: 401
`token_authentication_failure` with `reason` one of `missing_headers`, `malformed`, `wrong_environment`, `clock_skew`
(with `server_time_ms` and a sentence saying how far off), `invalid_signature`, `key_revoked`, `key_expired`,
`account_unavailable`, `replayed_request`; 403 `forbidden` with `reason` `ip_not_allowed` / `insufficient_scope`. The
security log records each refusal (key id, reason; never the signature). A session cookie is never a credential on
`/trade-api`, and API headers are never read on `/v1`.

### 35.4 Rate tiers

| Tier | Read tokens/s | Write tokens/s | WebSocket connections | FIX sessions |
|---|---|---|---|---|
| Basic (default) | 200 | 100 | 5 | 1 |
| Advanced | 300 | 300 | 10 | 2 |
| Premier | 1,000 | 1,000 | 25 | 5 |
| Prime | 4,000 | 4,000 | 50 | 10 |

Token buckets per key and budget hold one second of budget. Costs: 10 per request; cancels 2; batch create 10 per
order, batch cancel 2 per id; `/account/*` 1. A request costing more than the bucket is refused. The 429 envelope is
`too_many_requests` with `tier`, `bucket`, `retry_after_seconds` and a `Retry-After` header. `GET /account/limits` and
`/account/endpoint_costs` expose them. Tiers and the default tier are editable (Admin › API keys). Buckets live in a
`RateStore` (in memory today; a shared store implements `take` / `level`, RS1). A verified key skips the per-IP
perimeter limiter; failed signatures do not.

### 35.5 REST surface (`/trade-api/v2`)

- **Public:** `exchange/status|schedule|announcements` (announcements = open status incidents), `markets`,
  `markets/trades` (cursor, `min_ts` / `max_ts`), `markets/{ticker}`, `markets/{ticker}/orderbook`, `events`,
  `events/{ticker}`, `series`, `series/{ticker}`, `series/{series_ticker}/markets/{ticker}/candlesticks`,
  `historical/trades`, `historical/markets/{ticker}/candlesticks`, `multivariate_event_collections[/{collection}]`,
  `margin/markets[/{ticker}[/orderbook|/trades]]`.
- **Key, `read`:** `account/limits`, `account/endpoint_costs`, `portfolio/balance`, `portfolio/positions`,
  `portfolio/orders` (cursor, filters), `portfolio/orders/queue_positions`, `portfolio/orders/{id}`,
  `portfolio/orders/{id}/queue_position`, `portfolio/fills` (cursor), `portfolio/settlements` (cursor),
  `portfolio/order_groups[/{id}]`, `communications/id`, `communications/rfqs[/{id}]`, `communications/quotes[/{id}]`.
- **Key, `trade`:** `POST portfolio/orders`, `POST|DELETE portfolio/orders/batched` (at most 20, per-item results,
  partial failure; closes gap G5), `DELETE portfolio/orders/{id}`, `POST …/amend`, `POST …/decrease`, order groups
  create / delete / `PUT …/reset`, RFQ and quote create / delete / accept / confirm, `POST
  multivariate_event_collections/{collection}`.
- **Perps (`perps` + `read` / `trade`):** `margin/balance|positions|orders[/{id}]|fills|order_groups`, `POST
  margin/orders`, `DELETE margin/orders/{id}`, amend, decrease, `POST margin/positions/{ticker}/close`, perps order groups.
- **Create-order body (v2):** `ticker, side (yes|no), action (buy|sell), type (limit|market), count | count_fp,
  yes_price | no_price | yes_price_dollars | no_price_dollars, client_order_id, expiration_ts (s), buy_max_cost (cents,
  market buys), post_only, order_group_id`; only `good_till_canceled` time in force. Order objects show the user's side
  and action with both `yes_price_dollars` and `no_price_dollars`, counts `_fp`, fees, `order_group_id` and `source`
  (`user`, `api`, `fix`, …).

**One engine, one rule set.** Writes are dispatched internally into the `/v1` pipeline (step-up guard, flag gate with
money controls, session limits, schemas, locks, Idempotency-Key, identity / location / fraud gate, the handler) as the
key's owner, on a request object built from `app.request`, so flags, play mode, trading limits and every other rule
apply exactly as on the website. Reads with cursors query the tables through the shared serializers.

**Predictions order groups** (`order_groups`, `order_group_orders`): `contracts_limit`; fills of member orders add up;
at the limit every resting member is canceled (`order_group_triggered`) and the group refuses orders until `reset`;
`delete` cancels the members. Evaluated after each fill (§35.14).

### 35.6 One registry → routes, docs, validation, tests (P7.3 / P7.4)

Each operation is declared once (id, method, path, tag, product, auth, scopes, bucket, cost, query schema, body schema,
response schema, handler). From it come the Express routes; the query checks (integers that do not parse or are out of
range answer `{msg}`, enums `{error}`); `GET /docs/openapi.json` (OpenAPI 3.1, servers production and demo, security
schemes, `x-parlance-*` extensions); the portal reference; and `tests/api-contract.e2e.test.js`. WebSocket channels are
declared the same way → `GET /docs/asyncapi.json` (AsyncAPI 2.6). FIX message tables → `GET /docs/fix.json`. The
validator is a JSON-Schema subset (`type`, `properties`, `required`, `items`, `enum`, `pattern`, `minimum` / `maximum`,
lengths, `anyOf` / `oneOf`, `$ref`); no new dependency.

### 35.7 Public WebSocket

`/trade-api/ws/v2` (Predictions) and `/trade-api/ws/v2/margin` (Perps; needs `perps`), signed upgrade (method GET, the
path), flag `api.ws`.

- **Commands:** `subscribe` (`channels`, `market_ticker` / `market_tickers`), `unsubscribe` (`sids`),
  `update_subscription` (`sids`, `market_tickers`, `add_markets` / `delete_markets`), `list_subscriptions`; replies
  `subscribed`, `unsubscribed`, `ok`; errors `{id, type:'error', msg:{code, msg}}` (1 bad JSON, 2 params, 5 unknown
  command, 8 unknown channel, 10 market required, 11 unknown sid, 12 rate, 13 too many subscriptions).
- **Data:** `{type, sid, seq, msg}`, `seq` contiguous per subscription.
- **Predictions channels:** `orderbook_delta` (`orderbook_snapshot` per market, then `orderbook_delta` with
  `price_dollars`, `delta_fp`, `side`), `ticker`, `trade`, `market_lifecycle_v2`; owner channels `fill`, `user_orders`,
  `order_group_updates`, `market_positions`.
- **Margin channels:** `orderbook_delta` (snapshot, then deltas computed from the engine's book snapshots), `ticker`,
  `trade`, `fill`, `user_orders`, `order_group_updates`, `market_positions`, `account`.
- **Caps:** per-key connections from the tier (429 at the upgrade), 64 KiB frames, 20 commands/s, 100 subscriptions.
  Heartbeat ping every 10 s; two missed pongs close the socket. A flag change, revocation, expiry or an owner lock
  closes the key's sockets at once (4401). The engine events feeding `/v1/ws` feed it too.

### 35.8 FIX gateway (A17, simulated)

- **Transport:** FIX 4.4 tag=value over TCP, flag `api.fix` (**off by default**; the listener starts and stops with the
  flag), port start option `fix.port` / `FIX_PORT` (0 = any free port). Own parser: BeginString `FIX.4.4`, BodyLength (at
  most 8192) and CheckSum enforced, 32 KiB buffer, garbled messages ignored (more than 5 → disconnect), 100 messages/s
  per session.
- **Sessions:** `TargetCompID` `PARLANCE` (order entry, market data, RFQ) or `PARLANCEDC` (drop copy).
- **Signed logon:** `553` key id, `96` base64 signature over `52 SendingTime`, `35 MsgType`, `34 MsgSeqNum`,
  `49 SenderCompID`, `56 TargetCompID` joined with SOH (`95` its length); SendingTime inside the API window;
  replay-protected; scopes `trade` (order entry) / `read` (drop copy); IP allowlist; the tier's session cap; one live
  session per (key, sender, target).
- **Sequence numbers** persist (`fix_session_state`); `141=Y` resets; gaps → ResendRequest, out-of-order messages ignored
  until filled; their ResendRequest → stored application messages resent with `43=Y` and `122`, admin ranges as
  SequenceReset-GapFill; too low without PossDup → Logout. Heartbeat, TestRequest, Logout, Reject (3) and
  BusinessMessageReject (j).
- **Order entry:** D / F / G / q → 8 / 9 / r through the same dispatch as REST (orders record `source = fix`);
  ExecutionReports come from engine events (`0` New, `F` Trade with 31/32, `4` Canceled, `5` Replaced, `8` Rejected,
  `C` Expired). Order-entry sessions report their own orders; drop copy reports all of the user's orders.
- **Market data:** V → W snapshot and X incremental refresh (bids, offers, trades), Y reject. **RFQ:** R → AI (accepted
  or rejected) and an S Quote per quote received.
- **Symbology:** Predictions `55` = market ticker, `54` 1 buy / 2 sell, `20001` ContractSide Y / N, `44` = that side's
  price in dollars, `38` contracts; Perps `55` = perps ticker, `54` 1 long / 2 short, `1` subaccount, `20002` leverage; `20004` OrderGroupID joins a group made over REST.
- **Admin:** Admin › API keys lists live sessions and disconnects them (reason, audit). Tables `fix_session_state`,
  `fix_outbound`, `fix_orders`, `fix_session_log`.

### 35.9 Developer portal (A16)

- **Frame:** `/docs` header (wordmark, "API Docs", search with Ctrl K, status link, theme toggle); tabs Welcome · Quick
  Start · Concepts · Predictions APIs · Perps APIs · FIX · Changelog; side links Rate limits, Demo environment,
  Developer Agreement, Your API keys. Flag `developer_portal`. It runs under the strict CSP (no inline script).
- **Prose** = CMS pages `docs/welcome`, `quick-start`, `concepts`, `predictions`, `perps`, `fix`, `rate-limits`, `demo`,
  `changelog` and `agreement` (the agreement is `legal`: publishing needs step-up), seeded on first start as published
  version 1 (reason `seed: …`), edited in Admin › Content › Pages, live on open pages. Quick Start has curl, Python and
  JavaScript signing samples; the JavaScript and Python ones are run by the tests.
- **Reference:** generated (REST operations per product and tag, parameters, body and response schemas, token cost,
  scopes; WebSocket channels; FIX message tables).
- **Try it** on each REST reference page: "Create demo credentials" generates an RSA-PSS key pair with WebCrypto (the
  private key non-extractable, kept in IndexedDB), registers the public key on the demo environment
  (`POST /v1/developer/demo_credentials`), then signs requests in the browser to `/demo-api/trade-api/v2` with
  `credentials: 'omit'`.

### 35.10 Status page

`/status` and `GET /v1/status` (flag `status_page`): overall state; components (REST API, WebSocket, FIX gateway with its
port, demo environment, website) from live state (flags, listeners, the demo instance), degraded by open incidents; and
incidents of the last 90 days. Incidents are CMS entries of type `incident` (title, details, status investigating /
identified / monitoring / resolved, impact maintenance / degraded / outage, components, start, end), posted and resolved
in Admin › Status incidents (draft + publish with a reason; every version kept). Open incidents also feed
`GET /trade-api/v2/exchange/announcements`.

### 35.11 Demo environment and the production switch

- **Demo** (`api.demo`): `npm start` starts a second exchange in the same process (`start({ env: 'demo' })`) with its own
  SQLite file (`<db>.demo.db` or `DEMO_DB_FILE`), its own port (`DEMO_PORT`, default any free port), play money, its own
  users and keys (`plxdemo_`), FIX off. `DEMO_API=0` disables it; programmatic starts need `demo: {}`.
- **Proxy:** the main site proxies `/demo-api/trade-api/*` (HTTP, streamed, 64 KiB, API headers only, no cookies either
  way) and the WebSocket upgrade `/demo-api/trade-api/ws/v2[/margin]`; the demo accepts signatures over its path with or
  without the `/demo-api` prefix.
- **Demo credentials:** a demo account linked to the signed-in user (`demo-<hash>@demo.example.test`, $10,000 of play
  money, $2,000 moved to Perps), at most 5 active demo keys (the oldest is revoked).
- **Production switch** (§33.6): API keys **survive** (credentials, not money); resting API orders are canceled like all
  orders; Predictions order groups are closed (`production_reset`); FIX sessions are logged out; the batch counts
  `api_order_groups` and `api_keys_kept`.

### 35.12 Parity and contract tests

`API_PARITY.md` (repository root) marks every area of the public Trade API v2 reference as built, partial or not built,
with the reason. `tests/api-contract.e2e.test.js` calls **every** operation of the OpenAPI document with a signed key and
validates the documented status and schema; an operation without a plan fails it.

### 35.13 Flags, routes, tables

- **Flags** (§33): `api.keys` (key management, signed authentication, the expiry job), `api.trading` (API and FIX order
  entry; child of `api.keys`), `api.ws` (public WebSocket; job), `api.fix` (off by default; job), `api.demo`,
  `developer_portal`, `status_page`. Client `[data-flag]`: the ☰ "API Docs" item; route flags for `/docs`, `/status`,
  `/account/api-keys`.
- **`/v1` routes:** `GET|POST /users/:uid/api_keys`, `POST /users/:uid/api_keys/:id/rotate`,
  `DELETE /users/:uid/api_keys/:id`, `GET /users/:uid/api_keys/usage`; `GET|PUT /admin/api_keys/settings`,
  `GET /admin/api_keys[/:id]`, `PUT /admin/api_keys/:id/tier`, `POST /admin/api_keys/:id/revoke`,
  `GET /admin/fix/sessions`, `POST /admin/fix/sessions/:id/disconnect`; `GET /status`, `GET /developer/portal`,
  `GET|POST /developer/demo_credentials`. Static: `/docs/openapi.json`, `/docs/asyncapi.json`, `/docs/fix.json`. All
  classified in `tests/authz.e2e.test.js` (signed-key probes with full and read-only keys; key and order IDOR).
- **Tables:** `api_keys`, `api_key_usage`, `api_replay`, `order_groups`, `order_group_orders`, `fix_session_state`,
  `fix_outbound`, `fix_orders`, `fix_session_log`; setting `api.settings`; CMS types `page` (docs/*) and `incident`.
- **Changed:** the CMS 'page' allowlist gains `pre` / `code`; the `/v1` order handler takes `post_only` and records the
  dispatch channel as `source`; the candlestick route's series parameter is named `:series_ticker`.

### 35.14 Design choices (confirmed by the owner 2026-11-08)

All choices below are accepted as built.

- Header names `PARLANCE-ACCESS-*` only; the `KALSHI-ACCESS-*` aliases are not accepted (clean-room naming; one
  spelling avoids ambiguity when both are sent).
- Window 5 s past / 1 s future; replay protection for state-changing requests only (GETs are read-only).
- Scopes: `read` always, `trade` optional, and a separate `perps` scope for the leveraged product.
- Tiers Basic / Advanced / Premier / Prime with the numbers of §35.4; one-second buckets; costs 10 / 2.
- Auth errors: precise reasons once the signature is proven (revoked, expired, account unavailable), generic before.
- "Frozen" = both deposits and withdrawals revoked by staff; "self-excluded" = a closed account.
- Demo environment in-process on its own port and database, behind a same-origin proxy (not a separate service).
- Predictions order groups evaluated after each fill (the filling order is not split at the limit).
- FIX: target comp ids `PARLANCE` / `PARLANCEDC`, custom tags 20001 / 20002 / 20003, the SOH-joined logon pre-image, only
  GTC limit orders (plus market IOC), sessions per (key, sender, target).
- Production switch: keys survive; orders and groups reset; FIX logged out.
- API key management stays in the browser (no key-management endpoints on the signed API).

### 35.15 Residual risks

Per-process rate buckets, WebSocket / FIX caps and the replay purge (RS1); GETs replayable inside the window; FIX without
TLS (closed by Phase 9A, §39.2: TLS ends at the proxy's layer-4 listener, plain FIX only on the internal network); the demo shares the process with production; group limits evaluated after fills;
Try-it keeps a demo key in the browser profile until "Forget this demo key".

### 35.16 Verification

- `api-keys` (4): the A2 lock, create with step-up, the private key shown once and never stored, a pasted Ed25519 key, a
  refused private key, scopes and an IP allowlist, usage, CMS notification and email; rotation with grace and revocation,
  audit and security activity, key IDOR; Admin › API keys tier / usage / revoke closing a WebSocket / rate settings;
  restart.
- `trade-api` (5): every security-gate case (headers, skew both ways, signatures, path tampering, replay, environment,
  cookies vs keys, scopes, IP, locked and frozen owners, expired and revoked keys, the security log without signatures),
  unparseable params, endpoint costs, a 429 with Retry-After shown in the usage dashboard; orders, batch with partial
  failure and batch cancel, idempotency, flags and trading limits; order groups, history cursors, Perps; the WebSocket.
- `fix` (6): §35.8 end to end, including the admin disconnect, a restart and the production switch.
- `dev-portal` (5): navigation, search, theme, the generated documents, Try it on the demo without cookies, environment
  isolation, CMS live edits, the JavaScript and Python samples, the status page with an incident, the flags.
- `api-contract` (3): §35.12 and the rendered reference listing exactly the documented operations. `authz`: §35.13.

## 36. Waitlists, launch survey and newsletter (Phase 7A)

Owner decisions 2026-11-08 (PLAN.md Phase 7A): the Perps waitlist is **on**, and a **real-money launch waitlist** gauges
demand while the exchange runs on play money (§33). Nigeria first (§30.0): naira bands, Nigerian payment methods,
`en-NG` number formatting, dates in the configured zone (WAT by default), the Nigeria Data Protection Act 2023 for
consent. Nothing in this section switches the exchange to real money: that stays the two-person, RESET-confirmed
production switch of §33.

### 36.1 Perps waitlist on (P7A.1)

- `perps.waitlist` is **enabled by default** for a new database (`server/flags.js` REGISTRY).
- **Migration** (`MIGRATIONS` in `server/flags.js`, run by `mountFlags` once the audit chain exists): on a database that
  already had flags (it predates this build), `perps_waitlist_on_2026_11_08` switches the flag on with the reason
  **"owner decision 2026-11-08"**: a `feature_flag_history` row (`action: migration`, no actor), a hash-chained
  `admin_audit` row (`flags.migration`) and a live nudge. A `meta` marker (`flag_migration:<id>`, with `result`
  `applied` / `already_set` / `new_database`) makes it run **once**: a later admin "off" is never switched back on. A
  pre-existing database without the row gets the old state (off) first, so the switch is always audited.
- **Opting out (tests and sandboxes):** the start option `flags: { defaults: { 'perps.waitlist': false } }` sets the
  state a *new* row starts with (admins can still change it; unlike `overrides`, which force a value). Suites that trade
  Perps as new users use it (see the PLAN 7A row); the in-process demo environment (§35.11) uses it too, so the API
  sandbox keeps open Perps. Behaviour of the gate itself is unchanged (§34.9).
- The Phase 6 table `perp_waitlist` moves into `waitlist_entries` (list `perps`); a read-only view `perp_waitlist`
  keeps the old shape for reports. Positions, grandfathering, staff exemption, approve / revoke / invite in Admin › Perps
  ops, CMS notifications and emails are unchanged (`tests/perps-growth.e2e.test.js` passes as before).

### 36.2 The waitlist module (P7A.2)

`server/waitlists.js`: `createWaitlists` (storage, shared by the Perps list) and `mountWaitlists` (routes, jobs). A list is
a key: `perps` (signed-in only; `waiting → approved / revoked`) and `real_money_launch` (signed-in and guests;
`pending → confirmed → unsubscribed`).

- **Signed in, one click — verified email only:** `POST /waitlists/real_money_launch/join` with `consent: true` and the
  `consent_version` the page showed. When the account's email is verified (`identity_profiles.email_verified_at`, §25)
  the entry is confirmed at once; a welcome email and an in-app notice (`waitlist_joined`) follow, and an unlinked guest
  entry with that email is taken over (the account has proven the inbox).
- **Signed in, unverified email:** an account can exist with an address its owner never proved, so the join is a
  **confirmation request** exactly like the guest form: `202 {status: "check_email", me: null, …}` whatever exists for
  that address (no enumeration), the same per-email limit, the same confirmation link sent to the account email (consent
  source `signed_in_unverified`). The entry stays `pending` with `user_id` empty: it is not counted, newsletters skip it
  and the page says "check your email". The link records the requesting account (`waitlist_tokens.user_id`); confirming
  it confirms the entry and links it to that account if the account still has that email. A guest entry with the same
  address is never taken over: a confirmed one only triggers the "already on the list" email to the inbox owner, a
  pending or unsubscribed one gets a new link to that inbox. **Verifying later:** verifying the account email
  (`POST /verify_email`) links unlinked entries with that address to the account; it does not confirm a pending entry
  (the member clicks one-click join again, now verified, or the link).
- **Guests, double opt-in:** `POST /waitlists/real_money_launch/guest_join` (`email`, consent, attribution, a hidden
  honeypot field `website`). It is a **pre-session endpoint** (login CSRF, §22.2) and, like every `/v1` write, needs the
  signed client token (the bot challenge, §21). The answer is always `202 {status: "check_email"}`:
  - new email → a pending entry and a confirmation email;
  - pending → a new link (the previous one is deleted: one live link per entry);
  - unsubscribed → pending again with a fresh consent record;
  - confirmed → an "already on the list" email to the owner (the requester learns nothing);
  - over the per-email limit (3 an hour) or a filled honeypot → nothing sent, the same answer.
- **The confirmation link** `/waitlist/confirm?token=…`: 32 random bytes (base64url), stored only as SHA-256 in
  `waitlist_tokens`, expiring after 48 hours (start option `waitlists.confirmTtlMs`), single use (marked used in the
  confirming transaction; a second use answers `410 waitlist_link_used`, an expired one `410 waitlist_link_expired`,
  anything else `400 waitlist_link_invalid`). The landing page confirms on a button click (mail scanners that prefetch
  links do not confirm anyone). Pending guest entries whose links expired over a week ago are deleted (hourly job).
- **Manage / unsubscribe token:** `<entry id>.<HMAC-SHA256>` derived from a dedicated key (`waitlist-token:v1`), never
  stored; it dies with the entry and survives restarts. It authorises `POST /waitlists/manage` (status, masked email,
  survey), `PUT /waitlists/real_money_launch/survey` with `token`, `POST /waitlists/unsubscribe` and
  `POST /waitlists/delete`. Emails carry it in two links: `/waitlist/manage?token=…` ("your place and survey"; it only
  reads; members with an account get `/waitlist` instead) and `/waitlist/unsubscribe?token=…` (unsubscribes on load).
- **Consent record** (NDPA 2023) on every join: `consent_ts`, `consent_version` (`cms<published version>-<12 hex of the
  wording's SHA-256>`), `consent_text_sha256`, `consent_source` (`signed_in` / `guest_form`) and `consent_ip_hash`
  (HMAC-SHA256 with `waitlist-ip:v1`, 32 hex; the IP itself is not kept). The wording is the CMS text
  `server.waitlists.consent.text`; the page shows it and echoes its version, and a mismatch answers
  `409 consent_changed` (the member always agreed to the wording on screen). Unsubscribing keeps the record and adds
  `unsubscribed_ts`; deletion removes everything.
- **Email at rest:** a guest's address is AES-256-GCM encrypted (`waitlist-email:v1`, bound to the row id) with a keyed
  HMAC (`waitlist-email-hash:v1`) as the dedupe and lookup key (unique per list). A member account stores no copy: the
  account email is the contact.
- **Linking:** a guest entry is linked to an account with the same email only once that account's email is verified —
  when the account verifies it, when a member with a verified email joins with one click, or when the guest confirms
  while such an account exists (or through the link the account itself requested); the encrypted copy is then dropped.
  Signing up with an address never links anything by itself.
- **Unsubscribe in every email:** each waitlist email carries `{{unsubscribe_link}}` (appended by the sender when an
  admin's override leaves it out) to `/waitlist/unsubscribe?token=…`, which unsubscribes on load and offers **Delete my
  data**; and the header pair `List-Unsubscribe: <…/v1/waitlists/one_click_unsubscribe?token=…>` +
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058). That POST runs before the session, CSRF and
  client-token middleware (mail providers send no cookies), authenticated by the token alone, rate limited per IP. The
  messaging provider gained an allowlisted `headers` field (SMTP and the dev outbox).
- **Privacy rights:** members leave (`POST …/unsubscribe`) or delete (`DELETE …/me`, or `POST /waitlists/delete` by
  token) at any time; the account data export lists every entry with its consent record and survey answers; account
  closure deletes them.
- **Sources:** `source` from the call to action (`banner`, `funds`, `home`, `direct`, …), `utm_source`, `utm_medium`,
  `utm_campaign` (lowercased, `[a-z0-9._-]`, 64 chars) and a referral code `ref` (upper-cased, 4–16 alphanumerics).
- **Abuse controls on the guest form:** the auth rate tier (§21), a persisted per-IP limit (10 an hour; start option
  `waitlists.guestJoinsPerIp`), a per-email limit (3 an hour, silent), the honeypot (logged as `waitlist_honeypot`),
  the client token and login CSRF; token routes have their own per-IP limit (60 per 10 minutes).

### 36.3 Opinion survey (P7A.3)

- Questions are CMS entries of the new type **`survey`** (key `<list>.<id>`): draft, publish with a reason, versions,
  rollback, hash-chained audit (§32.2). Value: `kind` (`single`, `multi`, `naira_band`, `text`), `prompt` (plain text,
  ≤ 200), `options` (2–12 `{id, label}`) or `bands` (2–10 ascending `{id, min_cents, max_cents}`, the last open-ended),
  `max_len` (text, 10–2000), `sort`, `required`, `active`. Defaults in `server/content/waitlists.js` until published.
- **Seeded:** would you trade with real money (single); expected first deposit in naira bands (₦0–5,000,
  ₦5,000–20,000, ₦20,000–100,000, ₦100,000–500,000, ₦500,000 or more); preferred payment method (bank transfer, debit
  card, USSD, mobile wallet); markets of interest (multi: elections and politics, football and other sports, the
  economy and the naira, crypto, music / film / entertainment, weather); a free-text comment (500 characters).
- **Answers** (`waitlist_survey_answers`): confirmed members only, editable until the launch — the production switch
  locks them (`survey_locked_ts`; `409 survey_closed`). Free text is stripped of markup and control characters, capped,
  set to `pending` moderation and flagged (`contains a link`, a blocklisted phrase, repeated characters).
- **Admins** see aggregates only (per option counts of confirmed and unsubscribed members) and the free text in a
  moderated list without identities (approve / hide, audited).

### 36.4 Public side (P7A.4)

- **Call to action** "Join the real-money waitlist" in the play-mode banner, on Funds (overview) and at the top of Home,
  only while play mode is on, each `[data-flag="waitlist.launch"]` and tagged with its source.
- **`/waitlist`:** the CMS pitch (rich text), the optional progress bar "N of TARGET joined" (confirmed members; "N
  people joined" without a target), one-click join or the guest form with the consent wording, the member's status
  (leave, delete my data) and the survey. `/waitlist/confirm` and `/waitlist/unsubscribe` are the landing pages. Every
  string is a catalog key (`public/js/content/waitlist-strings.js`); amounts are formatted in the display currency
  (₦ by default) and dates in the configured zone; the layout works at 390 px (no horizontal scroll, tested).

### 36.5 Admin › Waitlists (P7A.5)

- **Per list:** totals, confirmed / pending / unsubscribed, a 30-day daily growth chart (confirmed per day), sources
  (where they joined, UTM source and campaign, referral codes), the target, the public-count toggle (the
  `waitlist.launch.public_count` flag, with reason and step-up as on the flags page), survey results, the moderated
  comments and the question editor. The Perps list shows its counts and gate and links to Admin › Perps ops, where
  approve / revoke / invite work as before.
- **Target N:** `PUT /admin/waitlists/real_money_launch/target` (`settings.write`, reason, audited). When confirmed
  members reach it, every admin with `settings.write` gets **one** in-app alert (`waitlist_target`) and one email
  (`email.waitlist_target_admin`); the alert is stored with its target value, so it repeats only for a new target.
  Admin › Play mode shows "launch target reached". Nothing switches automatically.
- **Export:** `GET /admin/waitlists/real_money_launch/export.csv` (`users.support`, step-up, audited): consent fields
  only — entry id, list, status, email, joined / confirmed / unsubscribed times, consent time, version, wording hash,
  source and IP hash, UTM fields, referral code; no survey answers. Cells that start with `= + - @` are quoted with a
  leading apostrophe (CSV injection).
- **Newsletter** (`announce`; flag `newsletter`): the CMS template `email.waitlist_newsletter` (edit in Content ›
  Templates; preview and "send me a test" on the page), sent now or scheduled. A send snapshots the published template
  and becomes rows in `waitlist_newsletter_outbox` (every member of the list); the job sends at most N a minute
  (`waitlists.newsletterPerMinute` or `NEWSLETTER_PER_MINUTE`, default 120), re-checks each member's status at send
  time and records `sent`, `skipped_unconfirmed`, `skipped_unsubscribed`, `skipped_deleted` or `failed`; state is in the
  database, so a restart resumes where it stopped and a scheduled send fires after a restart. Cancel stops the queue.
  Per-send stats on the page. Delivery is at least once (a crash between sending and marking can repeat one email).
- **Launch email:** after the production switch (a `pm_reset_batches` row exists) Admin › Play mode and Admin ›
  Waitlists offer "Send the 'We're live with real money' email" (`email.waitlist_launch`) to confirmed members, with a
  reason and step-up, once. It is **never sent automatically**; staff with `announce` get an in-app reminder
  (`waitlist_launch_offer`).

### 36.6 The production switch

The switch keeps `waitlist_entries`, consent records and survey answers (they are not money). The preview counts them
(`kept_waitlist_members`, `kept_waitlist_consents`, `kept_survey_answers`, shown as "Also kept"); after the switch the
survey is locked and the launch email is offered (the approval response carries `launch_email`).

### 36.7 Flags, routes, tables

- **Flags** (group `growth`): `waitlist.launch` (on; routes, CTAs, `/waitlist`), `waitlist.launch.public_count`
  (off; the progress route and bar), `waitlist.launch.survey` (on; answering), `newsletter` (on; admin newsletter and
  launch-email routes, the outbox job). Off → `403 feature_disabled`, the job pauses, `[data-flag]` hides the UI live.
  Leaving is core: unsubscribe, delete and manage by token, and the signed-in unsubscribe / delete, work with every
  flag off.
- **Public `/v1`:** `GET /waitlists/real_money_launch`, `GET …/progress`, `POST …/guest_join`, `POST /waitlists/confirm`,
  `POST /waitlists/manage`, `POST /waitlists/unsubscribe`, `POST /waitlists/delete`, `PUT …/survey` (token or session),
  `POST /waitlists/one_click_unsubscribe` (app level, before the session middleware). **Signed in:** `POST …/join`,
  `POST …/unsubscribe`, `DELETE …/me`.
- **Admin:** `GET /admin/waitlists`, `GET /admin/waitlists/:list` (`users.read`), `PUT …/target` (`settings.write`),
  `GET …/export.csv` (`users.support`), `GET …/survey/comments` (`users.read`), `POST …/survey/comments/:id/:action`
  (`users.support`), `GET|POST …/newsletters`, `POST …/newsletters/preview`, `POST …/newsletters/test`,
  `POST …/newsletters/:id/cancel`, `POST …/launch_email` (`announce`). Survey questions use the CMS routes
  (`/admin/cms/survey/*`). All classified in `tests/authz.e2e.test.js`, with object-level probes (another user, forged
  and cross-entry tokens, moderation without the permission).
- **Tables:** `waitlist_entries`, `waitlist_tokens`, `waitlist_survey_answers`, `waitlist_newsletters`,
  `waitlist_newsletter_outbox`; view `perp_waitlist`; settings `waitlist:<list>` (target, alert, survey lock); `meta`
  markers `flag_migration:*`; `email_outbox.headers`. CMS: type `survey`; templates `email.waitlist_confirm`,
  `email.waitlist_welcome`, `email.waitlist_already`, `email.waitlist_newsletter`, `email.waitlist_launch`,
  `email.waitlist_target_admin`, `notify.waitlist_joined`, `notify.waitlist_target`, `notify.waitlist_launch_offer`;
  server texts `server.waitlists.*`.

### 36.8 Design choices to confirm

Owner decision 2026-11-08: recommended standards, admin-switchable (ground rule 6, §38.1).
- Confirmation links expire after **48 hours** (`waitlists.confirm_link_hours`); unconfirmed requests are deleted a week
  after their last link expired (`waitlists.unconfirmed_delete_days`) — owner: recommended standard, admin-switchable.
- **No default target N** (the admin sets it); the alert fires once per target value.
- The public progress bar is **off** until an admin shows it.
- Signed-in members with a **verified** account email are confirmed on one click; unverified accounts and guests
  confirm by email. Verifying the account email later confirms a pending entry that account requested (switch
  `waitlist.launch.auto_confirm_verified`, on; consent source `signed_in_verified_later`) — owner: recommended
  standard, admin-switchable.
- The guest form needs a ticked consent box; signed-in members agree by clicking the join button under the wording.
- The seeded survey questions and bands of §36.3; free text moderated before anyone reads it (nothing is public).
- Newsletter throttle **120 emails a minute** (`waitlists.newsletter_per_minute`; `NEWSLETTER_PER_MINUTE` is the upper
  bound) — owner: recommended standard, admin-switchable; newsletters go to the launch list only (Perps waitlist
  members never agreed to marketing email).
- The CSV export includes the email address with the consent fields (so consent can be proven per person; setting
  `waitlists.export_includes_email`, on, step-up) but no survey answers, and needs `users.support` + step-up — owner:
  recommended standard, admin-switchable.
- The production switch offers the launch email to confirmed members, once, from Admin › Play mode or Admin ›
  Waitlists; it locks the survey.
- Call-to-action cards in play mode (`waitlist.launch.cta_play`, on) and not outside it
  (`waitlist.launch.cta_production`, off) — owner: recommended standard, admin-switchable.

### 36.9 Residual risks

- Fixed after review (2026-11-08): an unverified account could confirm any inbox and take over a guest entry with one
  click. Now one click and linking need a verified account email. Remaining: if the inbox owner clicks a confirmation
  link that an impostor's account requested, the entry links to that account (the email says someone asked to join, so
  the owner chose to confirm).
- Per-process limits and the outbox job assume one instance (RS1); at-least-once newsletter delivery.
- The keyed hashes and encryption depend on the master key; no key rotation yet (RS4).
- HTML email links are `#` on plain-http development origins (the CMS link check accepts https only); the text part
  always carries the full links.
- Rate limits are per IP: shared NAT (common on Nigerian mobile networks) can hit the guest limit sooner; the per-IP
  limit is a start option and the auth tier is admin-editable.

### 36.10 Verification

- `tests/waitlists.e2e.test.js` (15 scenarios): the unverified-email one-click join (a confirmation link instead,
  pending, not counted, skipped by a newsletter, no takeover of a guest entry, linked on confirmation); the Perps waitlist
  default, the migration (once, audited, never again
  after an admin "off") and the Phase 6 table moved onto the module; a one-click join from the banner with consent
  fields, the welcome email with unsubscribe link and RFC 8058 headers, the survey (all four kinds, ₦ bands, edits); a
  guest double opt-in at 390 px (outbox link, hash-only token, encryption at rest, single use, expiry); unsubscribe by
  link and one-click POST, delete my data, linking only after email verification, export and closure; the CTAs on banner / Funds / Home at
  390 px and the flags (live hiding, `feature_disabled`, unsubscribe still working, survey flag); the target with its
  one-time alert and the Play mode note; the public progress bar toggle; the survey editor (CMS versions, validation);
  the consent CSV behind step-up; the newsletter (template preview, test send, throttled send resumed across a restart,
  skips, stats, a scheduled send fired after a restart, the flag); the production switch keeping the lists, locking
  the survey and offering the launch email; the guest form's limits, honeypot, client token, login CSRF and identical
  answers; persistence across a restart.
- `tests/authz.e2e.test.js`: every new route classified, plus the waitlist IDOR test. `tests/perps-growth.e2e.test.js`:
  the Perps waitlist unchanged. `tests/flags.e2e.test.js`: the new flags, rules and module.

## 37. Elections hub v2, Nigeria first (Phase 7B)

Owner request 2026-11-08 (PLAN.md Phase 7B, backlog A19): a results-night elections hub with the structure observed in
§13.20, adapted to Nigeria and built on a country model (§30.0). It replaces the Phase 5B tile-map hub (§29.8) as the
elections entry point: the MORE menu links to `/category/elections/nigeria-2027`; the Phase 5B page `/hubs/elections`
and its API were kept until the owner confirmed their removal (2026-11-08: removed in Phase 8, §29.8). Its invented 12 states are
the second country here ("Harbor", code `XH`, from the ISO 3166 user-assigned range). Clean room: real public
geography of Nigeria; invented parties, candidates, names, colours and results; no real people, marks or photos.

### 37.1 Country model (P7B.1) — data, never code

`server/elections.js` (`mountElections`) owns the tables; `server/elections-data.js` is seed data only, loaded once
(`meta` marker `elections_seed_v1`, start option `elections: { seed: true }`, on for `npm start`) and never read at
runtime. From then on everything is edited in **Admin › Elections**, every change with a reason and a hash-chained
audit row (`elections.<kind>.create|update`).

- **Countries** (`el_countries`): code, name, currency, time zone, locale and a configuration: division levels, the
  map level (`state`), the counting level (`lga`), the My Ballot levels (`state → lga → ward`) and the map grid size.
- **Divisions** (`el_divisions`, ids like `NG-LA-03-02`): Nigeria's 6 geopolitical zones, the 36 states and the FCT
  (ISO 3166-2:NG codes; the FCT flagged `territory`), the real number of LGAs per state (774), three senatorial
  districts per state plus one for the FCT (109), the real number of federal constituencies per state (360), and
  invented ward and polling-unit counts (8–14 wards per LGA, 15–25 polling units per ward; 8,542 wards in the seed).
  LGA and ward names are placeholders ("LGA 03", "Ward 02") that admins can rename. Each state has a hexagon-grid
  position for the map and a `small` flag (listed beside the map).
- **Offices and chambers** (`el_offices`): President (1, two-person calls), Senate (109, chamber), House of
  Representatives (360, chamber), Governor (36), State Houses of Assembly (990, chamber; configured, no races
  seeded). **Win rules are configuration** (`rule_json`, validated):
  - `plurality`: most votes (first past the post: Senate, House, Assembly, Harbor);
  - `spread`: most votes **and** at least `share` of the vote in at least `fraction` of the race's `unit` divisions;
    territories are left out of that count and, with `territory_required`, must reach the share too; `on_fail:
    runoff`. President: `{share 0.25, fraction [2,3], unit state, territory_required true}` → 25 % in 24 of the 36
    states and in the FCT. Governor: `{share 0.25, fraction [2,3], unit lga}` → 25 % in two-thirds of the state's LGAs.
- **Parties** (`el_parties`): name, short name, colour (validated `#rrggbb`), logo (a CMS media-library image id,
  §32.6 re-encoding), coalition, active. Seeded: five invented parties (two in the "Renewal Accord" coalition);
  Harbor: Blue, Red, Gold. **Candidates** (`el_candidates`): party, name (or none: a party-level contestant shows "LUP
  candidate"), photo (media id) or an initials avatar in the party colour, running mate.
- **Elections** (`el_elections`, slug = hub): `nigeria-2027` (general: presidency, 28 governorships, 109 Senate and
  360 House seats; governor holdovers for the 8 off-cycle states), `nigeria-offcycle` (Anambra, Bayelsa, Edo, Ekiti,
  Imo, Kogi, Ondo, Osun; per-race dates), `harbor-2026` (8 Senate seats + 16 holdover seats, the Harbor State
  governorship). Dates are demo values.
- **Races** (`el_races`): office, division, seat, name, area (division ids it covers: a Senate district is a group of
  whole LGAs, a federal constituency a group of wards), prior (per race, and per map unit for the presidency),
  featured, status `open | called | runoff`, winner. **Markets** (`el_race_markets`, `el_office_markets`) created
  through the engine with price history and liquidity (journaled): a winner event per candidate race (one market per
  candidate), "Nigeria President: runoff?", and "which party wins the most seats?" for each chamber (N party markets).
  Legislative seats link to the chamber-control markets. 129 markets in the seed.

### 37.2 Simulated results feed (P7B.2)

- **Counting units** (`el_reporting`): the LGAs for the presidency (774) and each governorship, the area for a
  legislative seat. Each unit has polling units in total and reported, and registered voters. Tallies per unit and
  candidate (`el_tallies`). Collation: polling units → ward (counts) → LGA (stored) → state → national (sums on read),
  so the state view, the 25 % tracker and the national total always agree with the stored rows.
- **Simulator** (design choice, like sports §19): a pure function of the election's seed and its simulated clock.
  Each unit starts reporting 30–330 simulated minutes after polls close and finishes 90–690 minutes later, linearly;
  votes = reported units × voters per unit × turnout (28–48 %) × vote shares drawn around the race prior (per state
  for the presidency) with seeded noise. Integer, monotonic, restart-safe (the clock is persisted in `sim_json`; the
  first tick after boot moves zero minutes). It runs on the engine tick only while the flag `elections.simulator` is on
  (**off by default**; `npm start` outside production turns it on with the `defaults` start option; the production
  switch turns it off) and the election's simulator is started. Admin › Elections: start, pause, advance N minutes,
  speed (simulated minutes per real minute, default 60), reset (refused once a race is called) — `markets.ops`, reason,
  audited. **No client can write the feed:** there is no write route; results are written by the server only.
- **Forecast** per race (design choice): called → certain; otherwise the market (winner markets normalised, or the
  race prior without markets) blended with a count model (normal approximation on the lead with σ = 0.18·√(share not
  reported)) by √(% reported). Chamber control: a seeded 300-draw simulation over the seat forecasts plus holdovers,
  blended with the control markets the same way. Map entries: `called` (solid, ✓: race called, or a state's
  presidential collation complete), `projected` (hatched, leader ≥ 90 %), `leading` (hatched), `pending`, `none`.
- **Results desk** (Admin › Elections › Results desk; `resolution.write`; a reason; **step-up**):
  - **Call** a winner: refused unless the candidate leads and meets the office's win rule on the reported results
    (`409 rule_not_met` with the detail). **Runoff**: only when every polling unit has reported and nobody meets the
    rule (`runoff_not_due`). **Uncall**: refused once a market has been resolved from the call (`settlement_executed`;
    reverse it on the resolution desk first); otherwise the pending proposals are withdrawn.
  - **Two-person** offices (the presidency): the call or uncall is a request (`202 pending_approval`, `el_calls`) that
    a different results-desk member approves (step-up) or rejects (note) within 24 h; the requester cannot approve it.
  - A call **proposes settlements** through the resolution desk (§28.7): `res_approvals` rows (`kind resolve`, YES for
    the winner's market, NO for the others; "runoff?" YES or NO), which a second resolver approves there; nothing
    resolves before that. Once every race of a chamber is called, its control markets are proposed for the party
    with the most seats (holdovers included). Resolvers are notified. Every step is audited (`elections.call`,
    `.uncall`, `.call.requested`, `.call.rejected`).
- **Snapshots** (`el_snapshots`): the compact hub state (per race: state, leader, ‰ reported, winner, ‰ chance,
  runner-up; per state for national races; chamber-control chances; the Power Index) at the start, every 30 simulated
  minutes (start option `snapshotEveryMin`), on every advance and on every call / uncall (markers). At most 400 per
  election; the oldest periodic ones are pruned first. The live page and the replay draw from the same compact state.
- **Live**: the public WebSocket channel `elections` (filter `hubs: [slug]`) nudges open pages on results (≤ 1/s),
  calls, price moves of linked markets and admin edits; pages refetch what is on screen (debounced, sequence-guarded).

### 37.3 Hub page (P7B.3) — `/category/elections/<hub>`

An unknown slug falls back to the category tag page. Everything about the country comes from the API.

- **Sidebar:** All markets · Elections · the country's hubs · Presidential · Senate · House of Reps · Governorship ·
  Off-cycle · international hubs (Harbor) · Referendums (chips at 390 px). **Tabs:** Overview, one per office with
  races (labels `elections.tab.<office key>`, else the office name), States, My Ballot; "Search states and candidates".
- **Control gauges:** one per chamber (the leading party's chance of most seats) and per single-race office (the
  leading candidate); dial from the leader's colour to the runner-up's, % and rating word (Safe ≥ 90, Likely ≥ 75, Lean
  ≥ 60, Toss-up), "Called" / "Runoff".
- **Office switch and seat bar:** forecast and current (called + holdover) seats per party, majority mark for
  chambers, "● LIVE PARLANCE FORECAST", other parties listed under the bar.
- **Results map:** hexagon tiles drawn in SVG from the grid positions (no imported map assets); solid = called,
  hatched = projected / leading in the party colour, ✓ or "% reported" labels, grey = no results, dashed = no race;
  "Small states and territories" listed beside it; legend; watermark. **Tooltip** on hover (mouse), on tap (touch;
  a tap elsewhere hides it) and on keyboard focus: state badge, "<race> winner?", "% of vote counted", one row per
  candidate (initials avatar, name, party, share, votes, Yes / No once called), seats per district for chambers,
  volume. Built with text nodes only.
- **Ratings swingometer:** Settled · Safe · Likely · Lean · Toss-up · Lean · Likely · Safe · Settled for the two
  parties leading most items, with bubbles; items led by any other party in "Other parties" (multi-party). Items are
  states for a national race, races otherwise.
- **Timeline:** play / scrub (range) / LIVE with call markers; scrubbing draws the snapshot's gauges, seat bar, map
  and ratings and says "Replaying <time> <label>".
- **Featured race cards** (admin `featured`): "<race> winner?", "% votes counted · LUP +3.2" (margin underlined, with
  a tooltip), the two leading candidates with chance and votes, a two-colour vote bar, Trade and Results.
- **Power Index:** headline ("Leaning <side> +x" / "Tied"), "x last 24H" / "Flat last 24H", the CMS blurb and "Learn
  more" (rich CMS text `elections.power.learn_more_body`), and the 30-day hourly history chart with the §15.4 hover
  readout. The formula is admin data (§37.5).
- **More markets:** every event linked to the hub ("N events"), leader and volume in ₦.
- **Hub chat:** a floating pill (bottom right) with "<hub> chat" and the online count, opening the §20 chat panel
  for room `HUB-<SLUG>` (rate limits, slow mode, moderation, reports, Admin › Chat). Rooms that are not events come
  from a `room` hook in `server/chat.js`; only rooms of existing hubs answer.
- **My Ballot:** pick state → LGA → ward (the country's `ballot_levels`); the contests whose area contains the ward
  (presidency, governorship, the Senate district, the federal constituency) with leader and market links. **No address
  is ever asked for.** Signed in, "Save this area" stores the division id only (`el_ballot_saved`), Forget deletes it.
- **Races and results:** per office a race list; a race panel with candidates (votes, share, chance, Yes / No),
  "N of M polling units reported", the **25 % tracker** (per candidate: states with ≥ 25 % out of 24 needed, the FCT
  check, "Meets the rule") and "a runoff is due" when every unit has reported and nobody meets it; results by state or
  LGA.
- NGN amounts, WAT times (the configured zone), 390 px layouts; all copy in the CMS (`public/js/content/
  elections-strings.js`, `admin.elections-strings.js`, server `server.elections.*`).

### 37.4 Routes, tables, flags, WebSocket

- **Public `/v1`:** `GET /elections/hubs`, `/elections/hubs/:slug`, `/elections/hubs/:slug/view?office=&at=`
  (gauges, seats, map, ratings; `at` = snapshot id), `/elections/hubs/:slug/timeline`, `/elections/hubs/:slug/races
  ?office=&division=`, `/elections/hubs/:slug/search?q=`, `/elections/races/:id`, `/elections/power_index/:country`,
  `/elections/countries/:code/divisions?parent=`, `/elections/ballot/:division`. **Owner:** `GET|PUT|DELETE
  /users/:uid/election_ballot` (`{division_id}` only).
- **Admin:** `GET /admin/elections` and `/admin/elections/elections/:id/desk`, `GET /admin/elections/calls`,
  `GET /admin/elections/:kind`, `GET /admin/elections/power_index/:country` (`catalog.read`); `POST
  /admin/elections/:kind`, `PUT /admin/elections/:kind/:id` (`catalog.write`; kinds countries, divisions, offices,
  parties, candidates, elections, races); `PUT /admin/elections/elections/:id/simulator` (`markets.ops`); `PUT
  /admin/elections/power_index/:country` (`settings.write`); `POST /admin/elections/races/:id/call|uncall`, `POST
  /admin/elections/calls/:id/approve|reject` (`resolution.write`). All classified in `tests/authz.e2e.test.js`
  (plus an elections IDOR test). Bodies are strict schemas (unknown fields rejected).
- **Tables:** `el_countries`, `el_divisions`, `el_offices`, `el_parties`, `el_candidates`, `el_elections`, `el_races`,
  `el_race_markets`, `el_office_markets`, `el_reporting`, `el_tallies`, `el_calls`, `el_snapshots`, `el_ballot_saved`;
  settings `elections_power_index:<country>`; `meta` `elections_seed_v1`. Existing tables used: `res_approvals`
  (proposals), `chat_*` (hub rooms), `admin_audit`.
- **Flags** (group `elections`): `elections.hub` (routes, page; module), `elections.results_map`, `elections.results`
  (race routes, cards, votes in tooltips), `elections.timeline` (timeline route, `at=` views), `elections.power_index`,
  `elections.chat` (chat routes of `HUB-*` rooms; `social.chat` too), `elections.simulator` (server job, **off by
  default**). Each hides its widget live (`data-flag`) and refuses its API (`403 feature_disabled`); the map's data is
  left out of the view answer. The map flag is not `elections.map`: a key ending in `.map` made
  `/v1/admin/flags/<key>` a source-map probe for the perimeter honeypot (§21), so it could never be edited; a test now
  checks every flag key against the honeypot.
- **WebSocket:** public channel `elections`, message `{hub, kind: results|call|prices|config, ts}`.
- **Production switch:** election data is not money: every `el_*` row is kept (the preview counts
  `kept_election_countries`, `_races`, `_results`, `_snapshots`); the simulator flag is switched off with the batch as
  reason and running simulators are paused. Play-money positions in election markets are reset like any other.

### 37.5 Power Index

An admin formula per country (Admin › Elections › Power Index, `settings.write`, reason, audited): value = offset + Σ
weight × price (0–100) over listed markets; labels for the positive and negative side; chart scale. Seeded for Nigeria:
`−50 + 0.5·P(LUP president) + 0.25·P(LUP most Senate seats) + 0.25·P(LUP most House seats)` ("LUP (ruling party)" vs
"Opposition"; LUP is the invented ruling party). History and the 24 h change are recomputed hourly from persisted trades
(so they survive restarts and match the database).

### 37.6 Design choices to confirm

Owner decisions 2026-11-08 (ground rule 6, §38.1):
- The old hub is removed: `/hubs/elections` answers 301 to the Nigeria hub and `GET /v1/hubs/senate_map` is gone (§29.8).
- Calls use the existing resolver role (`resolution.write`); country data `catalog.write`; the simulator `markets.ops`;
  the Power Index `settings.write`. No new role.
- Every call's settlement needs a second resolver on the resolution desk (the proposer cannot approve), even for
  one-person offices (switch `elections.second_resolver`, on; off executes the proposals at once, audited); pending
  calls and proposals lapse after 24 h (`elections.pending_expiry_hours`) — owner: recommended standard,
  admin-switchable.
- A winner call is refused unless the candidate meets the win rule on the results reported so far (a call before 100 %
  is a projection the desk takes responsibility for); a runoff only at 100 %.
- The win rule's FCT clause: 25 % in 24 states **and** in the FCT (`territory_required: true`), per the owner's brief;
  shown in words and editable per office (a checkbox with its explanation) in Admin › Elections › Data › Offices —
  owner: recommended standard, admin-switchable.
- The "projected" threshold (90 %, `elections.projected_pct`) and rating bands (90 / 75 / 60,
  `elections.rating_*_pct`) — owner: recommended standard, admin-switchable. The forecast blend (market or prior →
  count model by √% reported) and the seeded strengths, counts, turnout and timing are demo values.
- Legislative seats have party-level contestants and no per-seat markets (chamber-control markets instead); per-seat
  markets were not built (§38.12); State Houses of Assembly are configured without races.
- Counting stops at the LGA (wards and polling units are counts, not rows of results); LGA and ward names are
  placeholders.
- Snapshots every 30 simulated minutes, at most 400 per election; WebSocket nudges at most one a second per hub.
- The hub chat room is open while the hub is active; there is no "after the election" read-only switch yet.
- The map flag is `elections.results_map` (see §37.4).

### 37.7 Residual risks

- The simulator and the WebSocket throttle are per process (RS1); snapshots are full copies of the compact state
  (≈ 15–40 KB each).
- Call checks use the reported results at the moment of the call; a later correction of tallies (a real feed) would
  need an uncall and a new call.
- The results desk trusts the feed: with a real source (an owner decision: licensed feed or manual entry), entries
  need their own two-person and audit controls before calls.
- Admin-entered names are plain text and always escaped; a stored name from an import that bypasses the API is still
  rendered inert (tested), but other admin views must keep escaping it.
- Hub chat online counts are per WebSocket connection (approximate, as in §20).
- Legal and regulatory review of election markets in Nigeria is an owner decision before production (PLAN.md).

### 37.8 Verification

- `tests/elections.e2e.test.js` (13 scenarios, real server + SQLite + Chromium): the country model as data (zone /
  state / LGA counts, offices, seats and rules, the off-cycle states, multi-party parties and coalitions, engine
  markets and liquidity, Harbor), validation and audit of admin edits, Admin › Elections overview, data editor and
  Power Index form in the browser, every flag key editable; every hub widget on desktop and at 390 px without overflow
  (sidebar, tabs, search, three gauges, seat bar with 109 seats and majority 55, 37 tiles and the side list, ratings,
  timeline, featured cards, Power Index, More markets, chat pill); the feed advanced from Admin, live over WebSocket
  without a reload, API totals equal to `el_tallies` and `el_reporting`, counting by LGA, no client write path; the
  map tooltip on hover and on tap (inside the screen), a hostile stored name rendered as text; a governorship called
  in the UI with step-up and a reason, audited, its three proposals approved by a second resolver (the caller cannot),
  uncall refused once settled and allowed (proposals withdrawn) before; the presidency's 25 % tracker equal to a count
  over the stored tallies, the two-person call approved in the UI by the second person, Yes / No proposals including
  "runoff?" NO, a stricter rule refusing the winner call, the runoff call and state on the page; the timeline scrub to
  the start and to a call, LIVE and play; the Power Index value and 24 h change equal to a recomputation from trades,
  a formula change and CMS edits (blurb, rich Learn more) live; hub chat between two visitors with the online count,
  Admin › Chat and slow mode; My Ballot at 390 px (state → LGA → ward, the four contests, the house constituency from
  the stored area, only the division id saved, forget, guests); Harbor through the same code (map, holdovers, feed,
  call, ballot levels) and a new country created as data; each flag hiding its widget and refusing its API, the hub
  flag's "not available" page, the simulator flag pausing the feed; restart persistence and the production switch
  keeping election data and turning the simulator off.
- `tests/authz.e2e.test.js`: every route classified and the elections IDOR test. `tests/flags.e2e.test.js`: the new
  flags, rules, module and labels. `tests/chat.e2e.test.js`: event chat unchanged by the room hook.

## 38. Growth and reach, Nigeria first (Phase 8)

Built on `phase-8` from the owner's decisions of 2026-11-08 (PLAN.md Phase 8 and ground rule 6). Everything follows
ground rule 5 (Nigerian defaults, countries as data) and ground rule 6 (every owner choice is an admin switch).

### 38.1 Owner settings and switches (ground rule 6)

A capability is a feature flag (§33). An amount, a duration, a rate or a threshold is an **owner setting**: a validated
value in **Admin › Owner settings** (`/admin/owner_settings`, `settings.write`). Every setting shows its recommended
standard default, a CMS-managed explanation (`server.switches.setting.<key>.label` / `.help`), its unit and range,
whether it is changed from the default, a link to the page it serves and its change history. A change needs a reason
(3–500 characters) and, where it touches money, security or personal data, a step-up (`owner_setting_change`); it is
written to the hash-chained admin audit (`owner_settings.update`, before / after), stored in `admin_settings` as
`owner:<key>`, takes effect at once (modules read the value on use; listeners reset timers; public values reach every
browser in the flag bundle, `owner_settings`) and survives restarts. Start options can pin a value for tests and win
over the stored one (shown as "override"). An environment variable can bound a value (`NEWSLETTER_PER_MINUTE` is the
upper bound of the newsletter rate). Every flag carries a CMS explanation too (`server.switches.flag.<key>`), shown in
Admin › Feature flags and in the switch catalogue at the bottom of Admin › Owner settings.

| Setting | Recommended default | Range | Step-up | Used by |
|---|---|---|---|---|
| `waitlists.confirm_link_hours` | 48 h | 1–336 | – | guest / unverified confirmation links, the email's "expires in N hours" (§36.2) |
| `waitlists.unconfirmed_delete_days` | 7 days | 1–90 | – | deletes pending guest entries N days after their last link expired (hourly job; a change runs it at the next tick) |
| `waitlists.newsletter_per_minute` | 120 | 1–10,000, ≤ `NEWSLETTER_PER_MINUTE` | – | newsletter outbox throttle (§36.5) |
| `waitlists.export_includes_email` | on | – | yes | email column of the consent CSV (empty when off; the export audit records it) |
| `elections.pending_expiry_hours` | 24 h | 1–168 | – | pending two-person calls and resolution-desk proposals (§37.2, §28.7) |
| `elections.projected_pct` | 90 % | 51–99 | – | a counting race is "projected" on the map when the leader's chance reaches it |
| `elections.rating_safe_pct` / `_likely_pct` / `_lean_pct` | 90 / 75 / 60 % | 52–99 / 51–98 / 51–97, ordered | – | rating bands of gauges, ratings and their edges on the hub |
| `referrals.review_ip_signups_per_day` | 5 | 2–1,000 | yes | the "many sign-ups from one network" fraud signal (§38.2) |
| `share.clicks_per_ip_per_minute` | 60 | 1–10,000 | – | share-link opens counted per address (§38.3) |
| `i18n.min_coverage_pct` | 95 % | 1–100 | – | coverage a language needs before it can be switched on (§38.5) |
| `ssr.cache_seconds` | 60 s | 0–3,600 (0 = no cache) | – | server-rendered fragments and share cards (§38.4) |
| `data_saver.default_on` | off | – | – | data saver for visitors who have not chosen (§38.7); public |
| `sms.per_user_per_day` | 10 | 1–100 | yes | SMS notices per member per 24 h (§38.7) |

New switches (Admin › Feature flags; each with its CMS explanation and recommended default):

| Flag | Default | What it does |
|---|---|---|
| `waitlist.launch.cta_play` | on | the "Join the real-money waitlist" cards and banner link while play mode is on |
| `waitlist.launch.cta_production` | off | the same cards outside play mode |
| `waitlist.launch.auto_confirm_verified` | on | a pending entry an account requested is confirmed when that account verifies its email (consent source `signed_in_verified_later`, welcome email, target check); off: it stays pending until the link is used (the Phase 7A behaviour) |
| `elections.second_resolver` | on | a race call proposes settlements for a second resolver; off: the call executes them at once (marked approved, with a note), still audited |
| `referrals.predictions` | on | the Predictions referral program (§38.2) |
| `share_links` | on | signed share links and their landings (§38.3) |
| `copy_trade` (child of `share_links`) | on | the copy-trade prefill (§38.3) |
| `ssr` / `ssr.crawlers` | on / on | server rendering, share cards, sitemaps / crawler access past the browser check (§38.4) |
| `ssr.visitors` | **off** | owner decision 2026-11-09: the server-rendered market list is sent to search and link-preview crawlers only; visitors get the head metadata (title, description, canonical, share-card tags) and the app's own loading screen. On: visitors get the list until the app has loaded (§38.4) |
| `i18n` | on | languages other than the default (each language also has its own switch, all off) (§38.5) |
| `data_saver` | on | the data saver mode (§38.7) |
| `sms` | off | SMS notifications through the simulated adapter (§38.7) |

The referral offer amounts are program settings in Admin › Growth › Referrals (`users.money`, reason, step-up,
audited): ₦1,000 to the referrer, ₦500 to the friend, after ₦10,000 of the friend's trading, lifetime caps 20 rewards
/ ₦20,000 per referrer (internal cents, 1 cent = ₦1, §30). The FCT clause of the presidential win rule
(`territory_required`) is a checkbox with its explanation in Admin › Elections › Data › Offices, next to the rule in
words ("Win rule" column). No flag key ends in `.map` (the perimeter honeypot, §37.4); a test checks every key.

### 38.2 Referrals for Predictions (P8.1)

The second program of the reusable referral module (`server/referrals.js`, §34.8), in `server/growth-referrals.js`.

- **Codes and attribution.** Every member has a code (Rewards › Refer a friend, with share buttons). A friend is
  attributed by a code typed on Rewards, the `plx_ref` cookie of a referral link (`/?ref=CODE`) or a share link
  (§38.3) read at sign-up (`source: link`), or the `ref` a guest gave the real-money waitlist, applied when the account
  verifies its email and the entry links to it (`source: waitlist`). Within 30 days of sign-up and before the friend's
  first trade; never oneself.
- **Qualification.** The friend's Predictions fills (engine `fill` events) at traded value; fills whose counterparty is
  the referrer never count; system accounts never qualify. At ₦10,000 the referral qualifies.
- **Payment.** Play mode: play money (`bonus`, minted against `play:mint`). Production: the promotions treasury (the
  Central Bank, §33.7) as non-withdrawable credit, paid at once, queued or refused when the vault is empty; nothing is
  paid without the Central Bank (status `refused`). Lifetime caps per referrer (count and amount). Both sides are
  notified (CMS templates) and see it on Rewards.
- **Fraud signals** (beyond the account checks of §34.8): the same device as the referrer, the same payment card / bank
  account / wallet, many referred sign-ups from one network in 24 h (`referrals.review_ip_signups_per_day`), a friend
  whose P3.7 risk score reaches the hold threshold. A qualifying referral with any signal goes to the **review queue**
  in Admin › Growth (signals and detail shown): Approve pays both sides (step-up), Reject pays nothing; both audited.
- Table `referral_reviews`; columns `referrals.source`, `referrals.ip_hash` (keyed hash); the play-mode void of §33
  voids pending reviews too.

### 38.3 Share and copy-trade links (P8.2)

- **Links.** A market, an event, the sharer's own position or one of their own trades. The URL is `/s/<id>.<sig>`: a
  128-bit random id and an HMAC-SHA256 signature (key `share-link:v1`), so tokens cannot be enumerated or altered; a
  forged token fails before any lookup. Revocable by the sharer (DELETE, another member's id answers 404) and by
  support (Admin › Growth, reason, audited).
- **What is shown.** Side always; price and size only when the sharer ticks them. `GET /v1/share/<token>` (public)
  returns only those fields; `GET /v1/share/<token>/copy` (flag `copy_trade`) returns the ticket prefill.
- **Landing.** `GET /s/<token>` counts the open (per-address limit, §38.1), sets first-party attribution cookies
  (`plx_share`, and `plx_ref` with the sharer's referral code while referrals are on; 30 days, `SameSite=Lax`,
  `HttpOnly` for `plx_share`) and answers 302 to a path the server builds from the stored tickers (never from the
  request), so it cannot become an open redirect; unknown, revoked or switched-off links land on `/`.
- **Copy trade.** The event page pre-fills market, side, limit price and size (when shown) and says so
  ("copy-trade-note"); it **never places an order** — the visitor reviews and submits like any order.
- **Channels.** WhatsApp first, then X, Facebook, Telegram and copy-link: plain share URLs built in the browser; the
  server calls nothing. **Counts:** opens and sign-ups per link on Rewards › Your share links and in Admin › Growth.
- Tables `share_links`, `share_clicks`, `share_attributions`.

### 38.4 Public pages for search and social (P8.3)

- **Server rendering** (`server/seo.js`, flag `ssr`): home, all markets, categories, event pages, elections hubs, the
  rates hub, the API docs, the status page, CMS pages and help articles get their content inside `<main id="view"
  data-ssr="1">` and full metadata in `<head>`; the SPA renders over it. Since 2026-11-09 (owner decision) the body goes
  to search and link-preview crawlers only; visitors get the metadata and the app's loading screen unless the switch
  `ssr.visitors` is on (§39.16). Private routes (account, portfolio, funds,
  admin, rewards, notifications, messages, watchlist, verification, waitlist manage / confirm / unsubscribe) get
  `noindex` and no content.
- **Cache.** The fragment is cached per path (no query except an enabled `?lang`), language, display currency and
  canonical origin, for `ssr.cache_seconds`; it is built only from public data and never reads the session, cookies or
  other headers, so no visitor can be served another's page. The page itself stays `no-store` (per-response CSP nonce).
  `X-Parlance-SSR: cached | rendered` says which. Content changes and flag changes clear it.
- **Metadata.** Title, description, canonical URL (`PUBLIC_ORIGIN`, else the request's validated origin), `hreflang`
  for every enabled language plus `x-default`, Open Graph and X card tags, JSON-LD (Organization and WebSite on home,
  BreadcrumbList on events), with the CSP nonce.
- **Share cards.** `/og/site.png`, `/og/event/<TICKER>.png`, `/og/hub/<slug>.png`, `/og/share/<token>.png`: 1200 × 630
  PNGs drawn in pure JavaScript (`server/og-image.js`, a 5 × 7 bitmap font, the CMS PNG encoder) in the brand colours.
- **Search engines.** `/sitemap.xml` (index) → `/sitemaps/{pages,categories,markets,hubs}.xml` with `<lastmod>`;
  `robots.txt` gains the Sitemap line. Search and link-preview crawlers (Google, Bing, DuckDuckGo, Yandex, Baidu, Apple,
  Facebook, X, WhatsApp, Telegram, LinkedIn, Slack, Discord, Pinterest, Reddit) skip the browser check on public pages
  while `ssr.crawlers` is on (recorded as `crawler_exempt`); AI crawlers and every private route still get it.
- **Old hub.** `GET /hubs/elections` answers 301 to `/category/elections/nigeria-2027` (§29.8).

### 38.5 Languages (P8.4)

- **Locales as data** (`i18n_locales`: code, English and native name, direction, enabled, reviewed, default). Seeded:
  `en-NG` (default, on, reviewed) and Nigerian Pidgin (`pcm`), Hausa (`ha`), Yoruba (`yo`), Igbo (`ig`) — **all off and
  unreviewed** (owner decision 2026-11-08). Three published sample strings per language are flagged "needs review"
  with a note that they are machine-written; they never reach a visitor while the language is off. An admin can add a
  language (an RTL one included: `<html dir="rtl">`).
- **Translations** are CMS text entries of the locale (`cms_entries.locale`) through the same validator and sanitiser
  (declared variables only; plain text refuses markup; rich text allowlisted). Missing keys fall back to English, then
  the code default. Server wording (`server.*`) and templates (in-app, email, push, SMS) are per locale too.
- **Admin › Content › Languages:** coverage % (published translations / catalog keys), per-key review state, publish
  all drafts, mark reviewed (`content.publish`, reason), export (JSON with the English default per key) and import (dry
  run first; apply needs `content.publish`; imported keys are marked "needs review"). The per-language switch
  (`content.publish`, reason, step-up, audited) refuses unless the language is reviewed and its coverage reaches
  `i18n.min_coverage_pct`.
- **Choice.** `?lang=` (enabled only), the member's setting (`PUT /v1/users/<uid>/locale`, Settings) or the guest
  cookie `plx_locale` (footer switcher), else `en-NG`; only while `i18n` is on. No automatic switch from
  `Accept-Language` (members choose).
- **Formatting.** Numbers, dates and plurals per locale through `Intl` (`public/js/locale.js`); money keeps the display
  currency's format (§30). Table `i18n_text_review`.

### 38.6 Accessibility, WCAG 2.2 AA (P8.5)

- **Automated checks in the suite** (`tests/a11y.e2e.test.js`, axe-core 4.14 as a dev dependency, injected into the
  page): the key pages signed out (home, all markets, an event, the Nigeria hub, the rates hub, sign-in, sign-up,
  waitlist, FAQ, the accessibility statement) and signed in (Portfolio, Funds, Deposit, Settings, Security, Rewards) in
  light and dark at 1280 and 390 px: no violation of the WCAG 2.0 / 2.1 / 2.2 A and AA rules, and the contrast,
  target-size, label, name and SVG rules are shown to have run.
- **Fixes from the findings:** faint-text, "featured" and "live" colours raised to 4.5:1 in both themes; text on
  admin-chosen party colours picks near-black or white and darkens a mid-tone colour until white reaches 4.5:1; tab
  lists get `role=tab` / `aria-selected` kept in sync and arrow keys (`public/js/a11y.js`); links inside tab bars moved
  out of the tab list; map tiles named by their visible code and state, and answering Enter and Space; the ratings
  strip is a focusable named region; post-card and chat-pill buttons include their visible text in their names; a skip
  link; underlined links in running text; footer targets at least 24 × 24 px; date and time inputs show the focus ring
  (`:focus-within`); reduced motion stops every animation (pseudo-elements included) and makes scripted scrolling
  instant; charts carry a text summary, gauges and the seat bar their values.
- **Keyboard paths** tested with a visible focus at every stop: the skip link, a demo deposit, a trade through the
  ticket and its review, a setting in Account › Settings.
- **CMS colours:** brand and YES colours are refused below 4.5:1 (§32.8); party colours are made readable on display.
- **Accessibility statement:** the CMS page `/support/accessibility`, linked from the footer.

### 38.7 Built for Nigerian networks and phones (P8.6)

- **Data saver** (flag `data_saver`): a member setting (Settings › Data and messages; guests in their browser; the
  footer switch) with the admin default `data_saver.default_on` (off), applied from the first page view. On: no promo
  art, smaller images, price ticks batched every 10 s, the elections timeline never auto-plays; `<html data-saver="1">`.
- **Unstable connections** (with or without data saver): after two drops in a minute or 10 s without connecting, the
  client switches to polling (a banner says so) and back once the socket is stable.
- **Pre-compressed assets.** The build writes Brotli and gzip copies of every script and stylesheet; the server sends
  them to browsers that accept them (`Vary: Accept-Encoding`, `q=0` respected); compressed copies are not URLs of
  their own.
- **Performance budgets** (`scripts/perf-budget.js`, `npm run perf:budget`, a CI step after the build), compressed as
  served: scripts needed before the first render ≤ 160 KB (142 KB at the time of writing), stylesheet ≤ 32 KB (26.5),
  any lazy chunk ≤ 24 KB (12), all scripts ≤ 380 KB (344). `tests/perf.e2e.test.js` runs the same check and, on a
  390 px phone with a 4× slower CPU and a 3G link (1.44 Mbit/s, 562 ms round trip, cold cache, production bundle),
  requires LCP ≤ 2.5 s on home, an event and all markets (≈ 1.8 s measured: the server-rendered content paints first)
  and INP ≤ 200 ms for tabs, side and amount on the event page (≈ 50 ms).
- **SMS** (flag `sms`, off): a provider adapter interface; only the simulated adapter exists (writes to the development
  SMS outbox). Members opt in with a verified phone and the consent wording (version and hash recorded, NDPA 2023);
  opting out always works. Money, security, account, fill and price-alert notices are queued in a persisted outbox
  (CMS template `sms.notification`), at most `sms.per_user_per_day` per member per 24 h (the rest `skipped_cap`).
  Tables `sms_consents`, `sms_notify_outbox`; Admin › Growth shows the SMS outbox.
- Offline-tolerant pages through the PWA (§31) are unchanged.

### 38.8 Footer and help centre (P8.7)

The footer (CMS `footer`) has **Product** (Markets, Live, Calendar, Elections hub, Perps, API docs), **Company**
(Trust & security, Privacy, Terms, Regulation, Research, Blog) and **Help** (Help centre, FAQ, Contact support, Fee
schedule, Responsible trading, Accessibility, Status) columns, social links (network home pages, `https` only, known
networks only; the validator refuses others), the language switcher and the data saver switch. New CMS pages:
`support/faq`, `support/contact` (support hours in WAT: Monday–Friday 8:00–20:00, Saturday 10:00–16:00, closed on
Sundays and Nigerian public holidays; `support@example.test`), `support/accessibility`, `trust/security`,
`trust/regulation`, `research/blog`, `research/data`, `research/papers`.

### 38.9 Routes, tables, flags

- **Member:** `GET /v1/referrals`, `POST /v1/referrals/apply`, `GET|POST /v1/users/<uid>/share_links`,
  `DELETE /v1/users/<uid>/share_links/<id>`, `GET /v1/users/<uid>/reach`, `PUT /v1/users/<uid>/data_saver`,
  `PUT /v1/users/<uid>/sms_notifications`, `PUT /v1/users/<uid>/locale` (owner only; IDOR probes in `authz`).
- **Public:** `GET /v1/referrals/offer`, `GET /v1/share/<token>`, `GET /v1/share/<token>/copy`, `GET /v1/i18n/locales`,
  `/s/<token>`, `/og/*.png`, `/sitemap.xml`, `/sitemaps/*.xml`, `/robots.txt` (Sitemap line), `/hubs/elections` (301).
- **Admin:** `GET /v1/admin/owner_settings`, `GET|PUT /v1/admin/owner_settings/<key>` (`settings.write`);
  `GET /v1/admin/referrals` (`users.read`), `PUT /v1/admin/referrals/settings` (`users.money` + step-up),
  `POST /v1/admin/referrals/reviews/<id>/approve|reject`; `GET /v1/admin/share_links`,
  `POST /v1/admin/share_links/<id>/revoke` (`users.support`); `GET|POST /v1/admin/i18n/locales`,
  `PUT /v1/admin/i18n/locales/<code>`, `GET .../texts`, `PUT .../review`, `POST .../publish_drafts`, `GET .../export`,
  `POST .../import` (`content.write` / `content.publish`); `GET /v1/admin/sms/outbox` (`users.support`).
- **Removed:** `GET /v1/hubs/senate_map` (404).
- **Tables:** `referral_reviews`, `share_links`, `share_clicks`, `share_attributions`, `i18n_locales`,
  `i18n_text_review`, `sms_consents`, `sms_notify_outbox`; owner settings in `admin_settings` (`owner:<key>`).
- **Flags:** §38.1. Module and job gates in `server/flags.js` (`MODULE_FLAGS`, `JOB_FLAGS`, route rules).

### 38.10 Design choices (owner: recommended standard, admin-switchable)

Each is a recommended standard default the owner can change in the admin (§38.1):
- waitlist link lifetime 48 h, deletion 7 days after expiry, newsletter 120 a minute, email in the CSV — settings;
  call-to-action in play mode on and outside it off, auto-confirm on verification on — switches (§36.8);
- second resolver on, pending expiry 24 h, projected 90 %, bands 90 / 75 / 60, the FCT clause on — switch, settings and
  an editable rule (§37.6);
- referral ₦1,000 / ₦500 after ₦10,000, caps 20 / ₦20,000 — program settings; review threshold 5 network sign-ups a
  day — setting;
- share opens counted 60 per address per minute; page cache 60 s; data saver off by default; SMS off with 10 a day;
  languages off until reviewed with 95 % coverage.
Further choices (not switches): no automatic language from `Accept-Language`; WhatsApp listed first; the share card
uses the light-theme brand colours; crawler exemption by user agent (public pages only).

### 38.11 Residual risks

- The crawler exemption trusts the user agent: anyone claiming to be a search crawler skips the browser check, but
  only on public pages that crawlers are meant to see; rate tiers still apply and private routes keep the challenge.
- The fragment cache, share-click limits, the SMS cap window and the polling switch are per process (RS1).
- Referral fraud signals are heuristics (device id, payment fingerprint, keyed IP hash, risk score); they hold for
  review, they do not prove fraud. A VPN or many devices defeat them.
- Server-rendered prices are up to `ssr.cache_seconds` old for crawlers and the first paint (the SPA shows live data).
- SMS is simulated: delivery, sender id and cost controls of a real provider are untested; the consent record is ready.
- Machine-written samples exist in the database (flagged); they only show if an admin overrides the review rule by
  marking the language reviewed.
- axe-core finds about half of WCAG issues; a manual screen-reader pass (NVDA, TalkBack) is still to do.
- Performance is measured on an emulated phone and network, not on a real low-end device.

### 38.12 Not built

- **Per-seat legislative markets** (owner item 7B, default off): not built. Senate and House seats have party-level
  contestants and chamber-control markets (§37.6); a market per seat would add about 469 markets (109 + 360) with
  their own liquidity, resolution and hub surfaces — not a small change. No switch is registered for it.
- No real SMS provider (owner decision); no reviewed translations (owner decision: framework only).

### 38.13 Verification

- `tests/owner-switches.e2e.test.js` (8 scenarios): Admin › Owner settings lists every setting at its recommended
  default with its CMS explanation, a CMS edit of an explanation shows, bad values and missing reasons are refused;
  each 7A setting changed in the UI with its effect (link lifetime in the email and the token, deletion of old
  unconfirmed entries, newsletter rate, the CSV email column with step-up), the call-to-action switches in and outside
  play mode, auto-confirm with consent source `signed_in_verified_later` and the old behaviour when off; the second
  resolver off settling a call at once, pending expiry and expired proposals, band edges and the projected threshold
  on the hub, the FCT clause unticked and re-ticked in Admin › Elections; each Phase 8 flag switched in Admin › Feature
  flags with its effect seen live; each Phase 8 setting with its effect; a restart keeping every value and effect.
- `tests/growth.e2e.test.js` (6): referrals in production (treasury) and play mode, attribution by link and waitlist
  ref, trades with the referrer excluded, caps, the review queue, share and copy-trade links, persistence.
- `tests/reach.e2e.test.js` (9): server rendering and metadata, cache poisoning, crawlers, languages, data saver and
  the polling fallback, SMS, footer and help centre, admin text with `$&` / `$'` / `` $` `` / `$$` kept exactly as
  written in the served head and body (both the CMS head and the server rendering insert it with function replacers,
  never as a String.replace pattern), persistence.
- `tests/a11y.e2e.test.js` (8): §38.6, including the watch-star target size with a narrow star glyph and "Skip to
  content" keeping the page as it is (a fragment-only history step no longer redraws the route, so a half-filled
  deposit survives). `tests/history.e2e.test.js` gains a whole-view redraw while a History search is being typed: the
  replaced Portfolio view stops painting, and the typed search is kept and saved. `tests/perf.e2e.test.js` (3): §38.7.
- `tests/authz.e2e.test.js`: every new route classified, growth IDOR probes; `tests/flags.e2e.test.js`: the new flags.
- Existing tests changed for the removed hub: `markets-content` (the ballot card is tested on `/ballot`; the hub test
  asserts the 301 and the 404 of the senate API and a live Fed outlook refresh), `flags` (the hub flags are checked on
  `/hubs/economics`), `cms-content` (a new-page scenario uses `support/press`, as `support/contact` is now a default
  page), `account-area` (the observed Settings sections keep their order; "Data and messages" is appended after them).
- Full suite: 378 scenarios across 48 files.

## 39. Production readiness on one instance (Phase 9A)

Built on `phase-9a` (PLAN Phase 9A, P9.1–P9.8). Goal: Parlance can run in public on one server, in play mode first,
safely and observably, with data that survives anything short of losing every copy, and with the move to real money
gated by a checklist. Owner decision 2026-11-09 ("go with the recommendation"): one cloud VM in Docker (4 vCPU, 8 GB,
SSD) with Cloudflare in front; `admin.` on a separate subdomain; self-hosted Prometheus / Grafana / Loki with alerts to
the owner's phone and email; backups every 15 minutes plus continuous WAL shipping, encrypted, to an S3-compatible bucket;
the pen-test vendor and timing are the owner's. Every provider (cloud, domain, bucket, SMTP, phone relay) is not chosen
yet, so each is configuration with a placeholder (`deploy/env.example`, `clone/.env.example`).

### 39.1 What runs where

| Piece | Where | Notes |
|---|---|---|
| The exchange | `Dockerfile` → container `app` | Node 22 (pinned digest), non-root, read-only root, one `/data` volume, `HEALTHCHECK` |
| TLS, HTTP/3, HSTS, request limits, FIX over TLS | `deploy/caddy` | automatic certificates; `X-Forwarded-*` set here only; layer-4 TLS for FIX on 9443 |
| Backup verification | `backup` service (same image) | restores the store into tmpfs every 6 h and runs the verifiers |
| Metrics, uptime and certificate probes, rules | Prometheus + blackbox (`deploy/prometheus`) | scrapes the private metrics port |
| Alert delivery | Alertmanager (`deploy/alertmanager`; `entrypoint.sh` writes its configuration from the environment) | owner email + phone through a webhook relay |
| Logs | Loki + promtail (`deploy/loki`) | the app's lines are scrubbed JSON; 30 days |
| Dashboards | Grafana (`deploy/grafana`), under `/grafana` on the admin host | provisioned data sources and the "Parlance — overview" dashboard |

One command from a clean checkout (§8 item 7): `deploy/init-secrets.sh` once, then
`docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build`. Staging and production are two
copies of the same compose settings (`deploy/.env` per host); staging gets a restored copy with personal data removed
(`docs/runbooks/restore.md`). CI (`image` job) builds the image, scans it with Trivy (fixable high / critical fail the
build), writes a CycloneDX SBOM, runs the container smoke test (`scripts/container-smoke.js`: the config guard refusal,
`/healthz`, `/readyz`, a page, a sign-in, metrics only on the private port, non-root, no data or keys in the image) and a
load smoke run; reports are uploaded as artefacts.

### 39.2 Container and proxy

- Multi-stage build: `npm ci` and the asset build in `build`; the runtime stage holds production dependencies, `server/`,
  `public/`, `dist/` and the restore / keys / backup-verify scripts only; npm, npx, corepack and yarn are removed (the image
  scan found advisories in npm's own bundled packages). A build guard fails if `.env`, keys or databases reached the
  context; `.dockerignore` keeps `data/`, keys, `.env*`, tests and docs out.
- `HOST=0.0.0.0`, `FIX_HOST=0.0.0.0` inside the container (loopback by default elsewhere); only Caddy publishes ports.
- **Trusted proxy:** `TRUST_PROXY` names the proxy's address range (`172.30.10.0/24`, the compose network) — never
  `true`. The client IP used by rate limits, geo rules and the audit is the proxy's `X-Forwarded-For` only when the hop
  is trusted; Caddy in turn accepts Cloudflare's `CF-Connecting-IP` only from `CLOUDFLARE_IPS`. A forged header from
  anywhere else is ignored (tested).
- **FIX over TLS:** TLS ends at Caddy's layer-4 listener (9443) and is proxied to the plain FIX gateway on the internal
  network only, closing the §35.15 "FIX without TLS" residual. API clients connect with any FIX engine that speaks TLS.

### 39.3 Data durability

**Versioned migrations** (`server/migrations/`): one ordered list `NNNN-name.js`, applied in order at start inside one
IMMEDIATE transaction each, recorded in `schema_migrations` (id, name, SHA-256 checksum of the migration and of every
module function and SQL text it runs, time, duration, app version), under a lock row (`schema_migrations_lock`).
`0001-baseline` is the idempotent column checks and one-time upgrades Phases 0–8 spread over fourteen modules, run in
their original order (each module keeps an exported `schema(db)` used only when a database did not go through the
runner); `0002-operations` adds the Phase 9A tables and columns. At open, before seeding, a database recorded at a newer
version is refused (`schema_newer`, no silent downgrade), and so is one whose applied migration changed (`schema_checksum`
— write a new migration instead). A failing migration rolls back completely.

**Tested from every released schema:** `scripts/make-schema-fixtures.js` exports `clone/` at the commit where each phase
was complete (5D `ecb3513`, 6 `a0c0798`, 7 `a5c102b`, 7A `2bbdf85`, 7B `e001020`, 8 `af3e581`), runs that server on a fresh
database with invented data (two traders, deposits, a matched trade, flag changes that write audit rows), and dumps it as
gzip SQL to `tests/fixtures/schemas/` (about 320 kB each; the fixtures' master key is a public test key derived in the
script). The suite upgrades each and runs the verifiers.

**Backups** (`server/backups.js`): snapshots every `backups.interval_minutes` (15), a nightly full at
`backups.nightly_hour_wat` (02:00 WAT), one before the production switch, and manual ones. A snapshot ships pending WAL,
checkpoints (TRUNCATE) and copies the main file page for page, synchronously (this process is the only writer), so it sits
exactly at the start of a WAL generation; the copy is then sealed and uploaded asynchronously. **WAL shipping**
(Litestream-style): automatic checkpoints are off; every `backups.wal_ship_seconds` (10) the new frames up to the last
commit are sealed and uploaded as a segment; past 16 MB the WAL is checkpointed right after shipping and the next write
opens a new generation. **Encryption:** AES-256-GCM under the backup key (`BACKUP_KEY` / `BACKUP_KEY_FILE`, separate from
the master key; `BACKUP_KEY_PREVIOUS` opens objects after a backup-key change); object = `PLXB1` | key id | IV |
ciphertext | tag, with a JSON manifest (SHA-256 of plaintext and ciphertext, time, kind, generation) so a restore needs
nothing but the store and the key. **Retention** (owner settings): interval snapshots 48 h; nightly 7 daily / 4 weekly /
12 monthly; pre-production and manual a year; WAL older than the oldest kept snapshot deleted; every prune audited.

**Point-in-time restore:** `npm run restore -- --to <time|now> --out <file> [--verify]` picks the newest snapshot at or
before the time and applies each later WAL generation's shipped segments up to it (SQLite recovers the checksummed
frames on open; a partial generation stops at its last shipped commit). Loss window: the shipping interval. The command
refuses to write over a database a running server holds. **Restore drill:** Admin › System (and every
`backups.drill_every_days`, 7) restores the newest backup into a temporary file and runs integrity, ledger / journal,
Perps journal, audit chain (with the newest anchor) and schema version; the backup sidecar does the same from the store
alone every 6 hours. Alerts fire past `backups.max_age_minutes` (60) and `backups.drill_max_age_days` (30).

**Production-switch backup** (§33): now an encrypted, checksummed `pre_production` snapshot in the backup store, taken
before anything changes (the approval waits for the upload); this closes the §33.13 "unencrypted backup file" residual.

### 39.4 Object storage

`server/storage.js`: `put / get / head / list / delete` over a local folder (default: `<data>/objects` for media and
identity documents, `<data>/backups` for backups) or any S3-compatible service through AWS Signature V4 written with
`node:crypto` (no SDK; https only except loopback for tests; keys checked against path traversal). `OBJECT_STORAGE` and
`BACKUP_STORAGE` choose (`local`, `local:<folder>`, `s3` with `S3_*` / `BACKUP_S3_*`). CMS media and identity documents
move out of SQLite right after each upload and, for existing databases, by the same job at start (the blob migration;
progress in Admin › System): CMS media are public and served from the store at their stable `/media/<id>.<ext>` URLs;
identity documents stay sealed with the member's data key in the store (`kyc/<user>/<doc>.sealed`). A staff view of a
document (audited, reason required) now returns a **signed URL valid for 60 seconds and bound to the staff session**
(`/v1/admin/kyc/blob/<token>`, `Cache-Control: no-store`, sandbox CSP) instead of an inline data URL.

### 39.5 Observability

- **Logs** (`server/logger.js`): one JSON object per line; request id from the trusted proxy's `X-Request-Id` (else
  generated), echoed in the response and carried by AsyncLocalStorage into everything the request triggers; one request
  line per request (route group, status, ms — never the query string or ids). **Scrubbing** on every line: secret-named
  keys replaced whole; emails, phone numbers (E.164 and Nigerian 0-prefixed), bearer / basic / SigV4 credentials, JWTs,
  PEM keys, encrypted values, long hex and base64url secrets, Luhn-valid card numbers and 11-digit NIN / BVN masked; URLs
  lose their query strings. In production every `console.*` line goes through it. Level: owner setting `logs.level`.
- **Health:** `/healthz` (process up) and `/readyz` (database writable, migrations at the latest version, engine ticker
  alive, free disk above `ops.readyz_disk_free_mb`) answer `{"status": …}` only, `no-store`, rate-limited per IP; the
  reasons are on the metrics port and in Admin › System.
- **Metrics** on `METRICS_PORT` (bound to `METRICS_HOST`, optional `METRICS_TOKEN`), never on the public listener:
  requests by route group / method / status class, latency histograms per group, order-to-ack, matching time, WebSocket
  fan-out time, job age since last success, outbox depths, database and WAL size, disk free / total, memory, uptime, and
  `parlance_status{name=…}` for backup and WAL age, verifier results, the three switches, schema version and firing alerts.
- **Traces:** flag `ops.traces` (off); `traces.sample_pct` (10 %) of requests produce an OpenTelemetry-shaped span (W3C
  `traceparent` honoured and returned) written to the logs, and sent as OTLP/HTTP JSON when `OTEL_EXPORTER_OTLP_ENDPOINT`
  is set.
- **Alerts** (`server/alerts.js`, every 30 s): backup overdue, restore drill overdue, anchor overdue, verifier failure,
  error rate over `alerts.error_rate_pct` (5 % of ≥ 20 requests in 5 minutes), order p99 over `alerts.order_p99_ms` (100),
  job stalled (`alerts.job_stall_minutes`, 10), disk below `alerts.disk_free_pct` (15 %), certificate expiry
  (`TLS_CERT_FILE`, `alerts.cert_expiry_days`, 14). Sent when they start, every `alerts.repeat_minutes` (60) while firing,
  and when resolved, to every **confirmed** contact: email (through the email provider), webhook (JSON signed
  `X-Parlance-Signature: t=…,v1=HMAC-SHA256(t.body)` — an SMS gateway, a phone push service or a chat app), or push to a
  staff account's app. A contact is confirmed by entering the 6-digit code its test message carried. Prometheus rules in
  `deploy/prometheus/alerts.yml` add site down, the app not scraped, WAL shipping stalled, backup sidecar failures and
  certificate expiry from outside.
- **Audit-chain anchoring (RS5)** (`server/anchors.js`): every `anchors.interval_minutes` (60) the head of the admin
  audit chain is signed with an Ed25519 key derived from the master key and shipped to the logs (`audit_anchor`) and the
  backup store (`anchors/…json`). The public key is shown in Admin › System so anyone can check an anchor. The verifier
  compares the database with the newest stored anchor: a database rewritten after an anchor no longer contains the
  anchored row with the anchored hash, even if the rows behind it were re-chained.

### 39.6 Separate admin origin

With `ADMIN_ORIGIN` set (`https://admin.<domain>`), the admin panel and `/v1/admin/*`, `/v1/perps/admin/*`,
`/v1/social-admin*` answer only on that host (404 on the site); a browser opening the admin host lands on `/admin`.
The admin host has its own session cookie (`__Host-plx_admin`), and each session row records the origin it was created on
(`sessions.origin_kind`): a member session is never valid there, nor an admin-origin session on the site, whatever the
cookie is called. The admin host's CSP is stricter (`frame-ancestors 'none'`, `upgrade-insecure-requests`, only its own
WebSocket), with `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and `no-store`. The optional IP allowlist (owner
setting `admin.ip_allowlist`, CIDR list, step-up) is checked on the admin host before anything else (refusals logged); a
list that would lock out the caller's own address is refused. Staff signing in on the site get an "Admin" link to the
admin origin. Without `ADMIN_ORIGIN` (development, tests) everything behaves as before.

### 39.7 Operating switches (ground rule 6)

Feature flags whose "on" means the mode is in force (`server/flags.js` group `operations`), changed in Admin › System or
Admin › Feature flags with a reason and a step-up, audited, live over the `feature_flags` channel, each with a CMS
explanation and the recommended default (off):
- `ops.maintenance` — every write on `/v1` and the Trade API answers `503 maintenance` with `Retry-After` (seconds to the
  scheduled end, else `ops.maintenance_retry_after_sec`, 300); reads, sign-in / sign-out and step-up keep working; staff
  keep full access; a CMS banner on every page; the status page puts every component in maintenance. The flag's
  start / end schedule the window.
- `ops.trading_halt` — no order placement, amend, Perps order or close, or RFQ accept / confirm on any path (`409
  trading_halted`); the engine itself refuses while halted (`engine.tradingActive`), so FIX, the Trade API and internal
  liquidity jobs stop too; cancels and decreases work; banner and status-page notice; the exchange status reports
  `trading_active: false`. Switching it **off** creates a two-person request (`ops_approvals`, `202`) that another admin
  approves (step-up) in Admin › System.
- `ops.read_only` — for migrations and restores: every write refused (`503 read_only`), staff included, except signing in
  / out, step-up and switching read-only itself off.
- `ops.traces` (off), `ops.backups` and `ops.alerts` (on; jobs).

**Owner settings added** (Admin › Owner settings, each with its explanation, range and step-up where marked): backups
(interval 15 min, nightly hour 2 WAT, WAL every 10 s, interval copies 48 h, 7 / 4 / 12, alert age 60 min, drill age 30 d,
automatic drill every 7 d — retention and schedule need step-up), logs (level `info`, security / sign-in log retention 90 d
with step-up, traces 10 %, anchors every 60 min), alerts (thresholds above, repeat 60 min, not-ready below 500 MB free),
operations (maintenance Retry-After 300 s, admin IP allowlist empty = everyone with step-up, key age 365 d with step-up).
Owner settings gained two types: `enum` (the log level) and `cidrs` (the allowlist).

**Log retention job** (hourly): security events, sign-in events and resolved alerts older than `logs.retention_days` are
deleted, audited.

### 39.8 Admin › System and Admin › Launch readiness

**Admin › System** (`settings.write`): health checks and schema version; the operating switches with the pending
two-person approvals; backups (store, backup key id and source, newest backup and its age, WAL shipping, recent backups
with checksums, "Back up now"); restore drills (last success with its checks, "Run a restore drill"); keys (active, HMAC
key, source, each key's status, age, values and fingerprint, last rotation, "Rotate"); the audit anchor (newest, its
source and check, the public key, "Anchor now"); verifiers ("Verify now"); alerts (firing, contacts with test / confirm /
remove, history); object storage and the blob move. The page refreshes every 4 seconds while open; a slower answer never
overwrites a newer one.

**Admin › Launch readiness** (`settings.write`) turns "are we ready?" into checks, recomputed on every view (the page
refreshes live):
- automatic (green / red): production configuration (the config guard's checks), TLS and HSTS (https public origin, HSTS
  sent, an HTTPS request through the trusted proxy within 24 h), separate admin origin, backups fresh, backups off the
  server (S3, or a folder outside the data directory), restore drill recent, alerts reach a confirmed contact, key ages,
  audit anchor recent and matching, dependency scan clean, container image scan clean, load test within targets (the last
  three from results recorded in the page: npm audit / Trivy summaries and `scripts/load.js` reports, each valid 30 days),
  switches in their launch state (maintenance, read-only, halt and the results simulator off; backups and alerts on);
- owner-ticked items with a note and a date (step-up, audited): pen test done and findings closed; terms and privacy
  reviewed by counsel; NDPA registration and a data-protection officer; support hours and contacts; incident contacts;
- the real-money waitlist target (Phase 7A) next to its confirmed count.
The Phase 5D **production switch** refuses its request and its approval while any check is red or any item is open
(`409 launch_not_ready`, the message and `blocking` list name each one). The gate is always on in production; elsewhere
`LAUNCH_GATE=1` or the `ops.launchGate` start option turns it on (so development and the earlier suites keep their switch).

### 39.9 Load and capacity

`scripts/load.js` (Node only): order placement and cancels by N traders crossing on K markets (order-to-ack measured at
the client), WebSocket fan-out to M clients (receive time minus the server's publish timestamp), live sports ticks, public
pages (`/`, an event page, the home data), and the Trade API with Ed25519-signed requests. Self mode runs the server in its
own process on a temporary database; `--base` targets a running server. Profiles: `smoke` (CI, every merge; fails only on
errors, not on speed), `full` (2 minutes, 2,000 WebSocket clients, 200 orders/s target rate), `soak` (one hour, memory
sampled). Targets (PLAN P9.5): 200 orders/s sustained with p99 order-to-ack < 50 ms; 20,000 WebSocket clients with p99
fan-out < 250 ms; public pages p95 < 300 ms from the edge.

**Measured** on the development VM of this build — 4 vCPU Intel Xeon @ 2.1 GHz, 16 GB RAM, Linux 6.18, Node 22.23.4 —
with the server and the load generator on the same machine (two processes; at 2,000 sockets the generator itself used
up to 1.3 GB and most of a core, so client-side latencies include its own queueing), sports simulation off, `dist`
assets, 2026-11-09:

| Run | Load | Orders/s achieved | Order-to-ack p50 / p99 | WS fan-out p99 | Public pages p95 | Signed API p99 |
|---|---|---|---|---|---|---|
| sequential | one order at a time, nothing else | — | 10 ms / 31–40 ms | — | — | — |
| light | 20 traders, 30 orders/s, 200 WS, 4 page workers, 30 s | 30 | 23 ms / 97 ms | 8 ms | 51 ms | 91 ms |
| smoke | 8 traders, 60 orders/s target, 50 WS, 12 s | 57–58 (saturated) | 180–240 ms / 5.4–9 s | 4 ms | 310–490 ms | 480–560 ms |
| full | 40 traders, 200 orders/s target, 2,000 WS, 16 page workers, 60 s | 17.8 (saturated) | 836 ms / 70 s | 203 ms | 1.1 s | 32 s |

Server memory stayed at ~195 MB in every run (no growth over the runs; the one-hour soak was not run in this build).
**The P9.5 targets are not met on this machine:** one Node process does roughly 10 ms of CPU work per order (gates,
session and rate accounting, idempotency rows, matching, journal, notifications, fan-out), so the ceiling is about
60 orders/s with light fan-out and it falls sharply when every trade is fanned out to thousands of sockets (4.5 million
WebSocket messages in the full run). The fan-out target (p99 < 250 ms) held at 2,000 clients, not yet tried at 20,000.

**Capacity plan.** The recommended VM (4 vCPU, 8 GB, SSD) is CPU-bound on one core; more cores do not help a single
process. For a play-mode launch with a few thousand members online and occasional trading (tens of orders per second)
it has headroom; for the real-money targets (200 orders/s with 2× headroom = 400 orders/s capacity) the order path must
get about 7× cheaper per order, in this order: (1) profile-guided work on the order path — fewer synchronous writes per
request (session time accounting, rate buckets, idempotency rows batched), statement reuse; (2) move WebSocket fan-out
off the matching process (a fan-out worker, then the 9B shared pub/sub) and coalesce ticker updates per 100 ms;
(3) re-measure on the production VM through Cloudflare. **9B signal:** sustained > 30 orders/s for 15 minutes, order p99
above the 100 ms alert threshold on more than one day a week, or more than 2,000 concurrent WebSocket clients — any one
starts Phase 9B. The load test result recorded in Launch readiness must be within targets before real money.

### 39.10 Security hardening

- **Key rotation (RS4)** (`server/crypto.js`, `server/keyring.js`): a key ring (`SECRET_KEYRING` / `SECRET_KEYRING_FILE`,
  or `data/secret.keyring.json` in development; the single `SECRET_KEY` / key file is the ring `{k1}`). Encrypted values
  name their key (`enc:v2:<kid>:…`; `enc:v1:` = k1, unchanged for deployments that never rotated) and always open with
  the key they name; new values use the active key at once (no restart). Rotate (Admin › System in development, `npm run
  keys -- rotate --file <ring>` + restart in production) → the background job re-encrypts every registered column (TOTP
  secrets, identity key wrapping, heist codes, the SMS outbox, mock OIDC keys, OAuth verifiers, waitlist emails, VAPID and
  push subscriptions / outbox, alert contacts) in batches, verifies all of them, and retires the old key. Audit-chain rows
  record the key that sealed them (`admin_audit.key_id`); new rows use the active key and every row verifies with its own.
  Key metadata (fingerprints, never keys) in `crypto_keys`, rotations in `crypto_rotations`; a ring whose key does not
  match the fingerprint this database knows is refused at start.
- **Production config guard (RS7, RS8)** (`server/config-guard.js`): with `NODE_ENV=production` the server exits 78 and
  names every failing setting: `ALLOWED_ORIGINS` (https, including `PUBLIC_ORIGIN`), `PUBLIC_ORIGIN`, `ADMIN_ORIGIN`
  (https, different), `SCRYPT_LOG_N` ≥ 17, the master key from the environment or a secrets file outside the data folder,
  `BACKUP_KEY` the same way (and not the master key), `DEMO_ACCOUNTS=off` (the seeded demo traders keep their history but
  cannot sign in), no `DEMO_PASSWORD`, `DEMO_API=0`, `SPORTS=0`, Secure cookies, `TRUST_PROXY` set to ranges (never
  `true`), no `FEATURE_FLAGS` override starting the results simulator.
- **Secrets** come from the environment or Docker secrets files (`deploy/secrets/`, created by `deploy/init-secrets.sh`,
  git-ignored); rotation of each is in `docs/runbooks/rotate-keys.md`.
- **Disclosure:** `/.well-known/security.txt` (RFC 9116: contact `SECURITY_CONTACT`, policy, canonical, a 180-day expiry)
  and the CMS page `trust/vulnerability-disclosure` (how to report, 90-day disclosure, safe harbour) linked from the footer.
- **Runbooks** (`docs/runbooks/`): incident response (severity levels, who is called, first 15 minutes, CMS
  communication templates, forensics, post-incident review, dependency-update policy with security fixes in 7 days, the
  quarterly access review), restore and drills (with the staging copy), key and secret rotation, Cloudflare, and the
  penetration-test scope with rules of engagement and the staging test environment.

### 39.11 Routes, tables, flags, settings

- **Public:** `GET /healthz`, `GET /readyz`, `GET /.well-known/security.txt`; `GET /v1/status` gains `notices`.
- **Admin (`settings.write`):** `GET /v1/admin/system`; `POST /v1/admin/system/backups`, `/restore_drill`, `/anchor`,
  `/verify`, `/keys/rotate`, `/alerts/contacts`, `/alerts/contacts/<id>/test`, `/alerts/contacts/<id>/confirm`,
  `/alerts/run`; `DELETE /v1/admin/system/alerts/contacts/<id>`; `GET /v1/admin/ops/approvals`,
  `POST /v1/admin/ops/approvals/<id>/approve|reject`; `GET /v1/admin/launch_readiness`,
  `PUT /v1/admin/launch_readiness/items/<key>`, `POST /v1/admin/launch_readiness/evidence`.
  `GET /v1/admin/kyc/blob/<token>` (`users.support`, signed, 60 s, bound to the staff session).
- **Private port:** `/metrics`, `/readyz` (with reasons), `/healthz`.
- **Tables:** `schema_migrations`, `schema_migrations_lock`, `ops_backups`, `ops_wal_segments`, `ops_restore_drills`,
  `ops_anchors`, `ops_alerts`, `ops_alert_contacts`, `ops_approvals`, `ops_launch_items`, `ops_evidence`, `crypto_keys`,
  `crypto_rotations`; columns `sessions.origin_kind`, `admin_audit.key_id`, `cms_media.storage_key`,
  `docv_documents.storage_key`.
- **Flags:** `ops.maintenance`, `ops.trading_halt`, `ops.read_only`, `ops.traces` (off), `ops.backups`, `ops.alerts` (on).
- **Environment:** `ADMIN_ORIGIN`, `HOST`, `FIX_HOST`, `SECRET_KEYRING(_FILE)`, `BACKUP_KEY(_FILE|_PREVIOUS)`,
  `OBJECT_STORAGE`, `BACKUP_STORAGE`, `S3_*`, `BACKUP_S3_*`, `BACKUPS`, `DEMO_ACCOUNTS`, `LOG_FORMAT`, `LOG_LEVEL`,
  `METRICS_PORT|HOST|TOKEN`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `TLS_CERT_FILE`, `SECURITY_CONTACT`, `LAUNCH_GATE`
  (documented in `clone/.env.example`).

### 39.12 Design choices (owner: recommended standard, admin-switchable)

- Owner decisions 2026-11-09 (recommended standard): one VM in Docker behind Cloudflare; `admin.` subdomain; self-hosted
  Prometheus / Grafana / Loki; backups every 15 minutes + WAL shipping, encrypted, S3-compatible bucket; pen test by the
  owner's vendor. The domain, cloud provider, bucket provider, SMTP and phone relay are configuration placeholders.
- SQLite stays (single writer, one well-sized server); PostgreSQL and several instances are Phase 9B, started by the
  capacity signal (§39.9).
- Backups are full page copies plus WAL rather than logical dumps, so point-in-time restore is exact; a snapshot briefly
  blocks the event loop while the file is copied (proportional to the database size — see residual risks).
- Keyed lookup hashes stay on the ring's `hmac` key across rotations (they are compared, not decrypted; changing them
  needs a re-hash from plaintext).
- The launch gate is enforced in production only by default, so play-mode development and the earlier suites keep the
  Phase 5D switch unchanged.
- Signed short-lived URLs only for private objects (identity documents); public CMS media keep their stable URLs.
- Every switch and value above is admin-switchable with its recommended default (ground rule 6).

### 39.13 Residual risks

- **Capacity:** measured below the P9.5 targets on the test machine (§39.9: ~60 orders/s ceiling, fan-out to 2,000
  sockets within target): per-request CPU in the single Node process is the bottleneck. The capacity plan in §39.9 says
  what comes first and the signal that starts Phase 9B; the one-hour soak was not run in this build.
- A snapshot copies the database synchronously; on a multi-gigabyte database this pauses requests for the copy's
  duration. Mitigation then: larger interval, or the SQLite online-backup API with a WAL position barrier (9B moves to
  managed PostgreSQL PITR anyway).
- Backups and their key are only as off-site as configured: with the default local folder they share the server's disk
  (Launch readiness stays red until a bucket or another disk is set).
- WAL shipping assumes the server is the only writer (the instance lock guarantees it for servers; an operator writing
  with another SQLite connection could trigger a checkpoint that skips frames — restore still works to the last shipped
  commit before it).
- Retired keys stay in the ring while audit rows or lookup hashes need them; HMAC lookup keys are not rotated (above).
- The admin IP allowlist relies on the proxy chain being trusted correctly (`TRUST_PROXY`, `CLOUDFLARE_IPS`).
- Alerts from the app cannot report the app being down; that depends on Prometheus + blackbox + Alertmanager running.
- Rate limits, alert evaluation and the flag cache remain per process (RS1, Phase 9B).
- The layer-4 Caddy module and the full compose stack were validated by configuration checks here, not run end to end
  with real certificates; the first deploy follows README › Deployment step by step.

### 39.14 Not built

- Grafana Cloud as an alternative is documented (README), not configured.
- Running the whole E2E suite against the built container in CI (P9.1 bullet) is reduced to the container smoke test plus
  the load smoke; the E2E suites start their own in-process servers.
- No real S3, SMTP or phone-relay provider was contacted (no network in tests; providers not chosen).
- Data retention per data class (P9.2): only the security and sign-in logs (and resolved alerts) got a retention owner
  setting and job (`logs.retention_days`, audited). Chat history, waitlist guests (already purged by the Phase 7A setting
  for unconfirmed entries) and closed accounts' personal data after a legal hold (closure today destroys the member's data
  key at once, §25) have no new settings; a legal-hold period needs the 9C regulatory decision first.
- The one-hour soak run (P9.5) was not run; memory was flat across the shorter runs.

### 39.15 Verification

- `tests/ops.e2e.test.js` (7 scenarios, Chromium behind a TLS-terminating proxy, production-like settings): admin origin
  separation (404 on the site, own cookie, stricter CSP, sessions not valid across origins, the staff link, the IP
  allowlist with lock-out protection); maintenance across the site and the API (banner live, 503 + Retry-After, reads,
  sign-in, staff writes, status page, a scheduled window); the trading halt (banner, 409 on orders, cancels, engine,
  exchange status, status page) and its two-person resume in the UI; read-only mode; Admin › System (backup now, restore
  drill with every check, key age, anchor shipped to the store, migration version, a webhook alert contact tested and
  confirmed with its code); Launch readiness checks green and red live, evidence and owner items in the UI, the production
  switch refused naming the open items and then allowed and executed with an encrypted pre-production backup; a restart.
- `tests/migrations.e2e.test.js` (3): every phase fixture upgraded and verified; fresh vs upgraded schema; refusals
  (newer, edited, locked) and rollback.
- `tests/backups.e2e.test.js` (5): backup / destroy / one-command restore with verification, point in time, encryption and
  checksums, previous backup key, retention, the fake-S3 adapter with SigV4 checked on every request and a backup + restore
  through it, the media blob move and serving.
- `tests/ops-platform.e2e.test.js` (6): log scrubbing, config guard refusals (also the real process exiting 78), trusted
  proxy rules, key rotation round trips (admin and offline, restart), health and metrics endpoints, the webhook alert
  adapter with its signature and a firing / resolved rule.
- `tests/authz.e2e.test.js`: every new route classified; `tests/flags.e2e.test.js`: the new flags, labels and module.
- Existing tests changed: `onboarding` (the staff document view is a signed URL now, and documents are read from the
  object store once moved); `playmode` (the pre-production backup is an encrypted object that opens with the backup key);
  `auth-security` and `waitlists` (their simulated "old build" databases now also drop `schema_migrations`, as a database
  from before Phase 9A has none, so migration 0001's one-time upgrades — encrypting plaintext TOTP secrets, moving the
  Phase 6 `perp_waitlist` table — run for them as they would on a real old database).
- `scripts/container-smoke.js` and `scripts/load.js --profile smoke` in the CI `image` job.
- Full suite: 401 scenarios across 52 files, all passing (2026-11-09, after §39.16).

### 39.15a Deploy stack checked by running it (2026-11-13)
The Phase 9A stack had been checked with `docker compose config` and `caddy validate` without the FIX add-on only. Starting
each service with the dependency batch of 2026-11-13 found and fixed:
- **Alertmanager never started**: compose passed `--config.expand-env`, a flag Alertmanager does not have (0.28.1 nor
  0.35.0), and its configuration cannot read environment variables. `deploy/alertmanager/entrypoint.sh` now writes the
  configuration from `ALERT_EMAIL`, `ALERT_SMTP_*` and `ALERT_PHONE_WEBHOOK` (every value a quoted YAML string) and
  starts it; email and the phone webhook are each left out, with a log line, until configured. Checked by starting it
  configured, unconfigured and with a password containing quotes and backslashes (`amtool check-config` passes on the
  written file each time).
- **Grafana 13.3.0** loads the provisioned Prometheus and Loki data sources and the Parlance dashboard; it no longer
  contacts grafana.com (plugin update checks, background installs, the Angular detector list are off).
- **Caddy 2.11** (builder and runtime, pinned by digest) builds with the pinned layer-4 add-on and the Caddyfile,
  including the FIX over TLS block, validates.
- Loki 3.7.9 (`-verify-config`), Promtail 3.6.8 (`-check-syntax`) and blackbox-exporter 0.29.1 (`--config.check`)
  accept their files.
Still not run end to end: the whole stack with real certificates (needs the owner's domain).

### 39.16 Performance fix after the owner's report (2026-11-09)
Report: after updating to Phase 9A the owner's long-running local database answered "request timed out" and pages
stayed on the server-rendered market list. Reproduced with a 400 MB database: the first backup held the request thread
for **4.0 s** (copy, read, AES-GCM and two SHA-256 over the whole file, then an MD5 for the local etag), the restore drill
and the live ledger / audit-chain checks likewise ran in one piece, and the 15-minute backups repeated the stall.
- **Operations worker** (`server/ops-worker.js`, one `worker_threads` worker started on first use and unref'd): seals
  snapshots, runs restore drills (restore + integrity, journal, perps, audit chain, anchor, schema) and the live
  verifiers on a read-only connection (one snapshot transaction; `auditChain.verifyReadOnly` derives the key without
  writing). Each task falls back to the request thread only when it cannot run there (in-memory database, injected
  storage driver). Storage drivers expose `config()` so the worker rebuilds them (S3 only with the built-in fetch).
- **Asynchronous I/O**: the snapshot copy (`fs.promises.copyFile`; WAL checkpoints wait while it runs, the main file being
  stable until the next checkpoint) and the local storage driver's reads and writes; the local etag reuses the SHA-256
  the worker computed instead of hashing the object again.
- **Start-up**: `npm start` waits 2 minutes before the first scheduled snapshot (`ops.firstBackupDelayMs`); restore
  drills and verifiers already run on the hourly maintenance job, not at start.
- **Media move**: a second `moveBlobs()` call while a pass runs now waits for the pass and returns the finished status.
- Result on the same 400 MB database: no answer above 500 ms in 170 s including the first backup (slowest 477 ms, as on
  a fresh database); before, 4,034 ms. Home page in a browser on the production build: first visit 0.4 s, repeat 0.15 s.
- **Owner decision 2026-11-12** (asked with the measurements): keep the market list hidden from visitors by default.
  On the 3G phone profile of `perf.e2e` (4× CPU, 1.44 Mbit/s, 562 ms round trip, first visit) the Largest Contentful
  Paint is 1.7–1.9 s with `ssr.visitors` on and 4.3–6.8 s in the default (home 6.8 s, event and browse 4.3 s); on
  broadband the difference is under half a second. `perf.e2e` keeps the 2.5 s budget for the switch on and holds the
  default to an owner-accepted 8 s ceiling, so a regression in either mode still fails.
- Regression test: `backups.e2e` "a large database: backup, restore drill and live verifiers never hold up requests"
  (250 MB; no answer may exceed 700 ms; the old code answered 6 requests in 6.5 s). `reach.e2e` "quick-loading page"
  covers `ssr.visitors` (off: no body for visitors, full body for crawlers, the switch in Admin › Feature flags).

### 39.17 Database growth fix after the owner's report (2026-11-13)

**Cause.** The owner's database (`npm start` since 3 November) had reached 3.8 GB (5.9 M journal postings, 2.9 M
entries, 1.8 M ledger rows, 1.2 M orders, 600 k fills, 340 k trades) plus 7.9 GB of backups, and the site answered
"request timed out". (1) **Growth:** the built-in liquidity accounts (`liquidity@`, `sportsflow@`, `is_system = 1`)
re-quoted every simulated sports market on every 1¢ move of its fair price, once a second: cancel, a bot-against-bot
reference trade, two new resting orders — every order, fill, trade, journal entry and ledger row stored for good. A fresh
`npm start` wrote per minute 7,249 journal postings, 3,512 entries, 2,117 ledger rows, 1,395 orders, 698 fills and 349
trades (≈ 10 M postings a day), all by system accounts. (2) **Request-thread stalls** that grow with the tables (below).
(3) **Backups** read the whole snapshot into memory and sealed it in one buffer: twice the database in RAM, and a
database over 2 GiB could not be backed up at all (`readFileSync` refuses files over 2 GiB); restore did the same.

**Measured** (development VM: 4 vCPU, 15 GB, Node 22.23). A database built like the owner's: a fresh `npm start` for
two minutes, then invented system-account history added with `tests/lib/big-db.js` (fresh ids, audit-clean: 1.06 M
orders, 5.2 M postings, 2.6 M entries, 582 k fills, 280 k trades, 1.06 M ledger rows, one member with 60 k orders, fills
and ledger rows; 2.3 GB). The server started as `npm start` does (backups on) with a debug-only statement / event-loop
instrument (not committed), for 13 minutes (the 10-minute audit included) while a headless browser loaded the public
pages, a signed-in member's portfolio / history / funds and every admin page, and a probe asked `/v1/exchange/status`
every 200 ms. Every request-thread statement or job above 100 ms, before → after:

| Stall (source) | Before (main thread) | After |
|---|---|---|
| Scheduled ledger audit every 10 min (`payments-admin.js` → `journal.audit`: GROUP BY entry, GROUP BY account, reservations, play-mode epoch check) | 1,367 + 745 + 403 + 219 ms ≈ 2.7 s | 0 ms: operations worker (2.1 s + 1.4 s + 0.6 s + 0.4 s there) |
| Admin › Payments › Ledger audit view and "run now" (`payments-admin.js`) | up to 1,472 + 756 + 420 + 219 ms ≈ 2.9 s per view | 0 ms: worker; the page answers in 3–4 s while everything else keeps answering |
| Admin › Perps ops › Ledger (`perps-ops.js`: every posting grouped by account) | 780 ms per view | 0 ms: worker; the bridge check reads one indexed sum |
| `engine.expireOrders`, every engine tick (full scan of `orders` for expired good-til-time orders) | 115–165 ms every second | below 1 ms: partial index `idx_orders_expiring` |
| `GET /users/:uid/transactions` and the CSV (every ledger row of the member) | 150–180 ms, 6.1 s at the client | newest 500 (like the fill history); the CSV in keyset pages of 2,000 that yield between pages |
| Admin › Reports (trades by day / by market, deposits by day) | 212 / 370 / 107 ms | 150 / 113 ms / below 100 ms (`idx_trades_ts`, `idx_ledger_kind_ts`); still proportional to the chosen period (residual) |
| History timeline of the 60 k-row member (`history.js` UNION) | 150–170 ms | 200–290 ms under the same load (residual: proportional to one member's history) |
| A backup of the 2.3 GB database (`ops-worker.js` `sealFile`) | failed (`File size is greater than 2 GiB`) | 2.37 GB sealed and stored by the worker as a stream |
| WAL checkpoint while the worker reads (`backups.js`): TRUNCATE waits for readers with the 5 s busy timeout | up to 5 s (found in review: the hourly verifiers, and now the audits, hold a read snapshot) | never waits: busy means "next tick" |
| Single-row writes waiting on the disk (flash prices, session usage, perps history, sports quotes, commits) | 300 ms–2.9 s, ≈ 400 times | up to 730 ms, ≈ 40 times (the bots write a twentieth as much at "low") |

Event loop over the 13 minutes: before 960 delays ≥ 100 ms (220 over 1 s, worst 4.7 s), probes over 300 ms 456 (worst
5.6 s); after 914 (19 over 1 s; the worst, 4.3 s, is the one-off index build at start, before listening), probes over
300 ms 357 (worst 1.55 s). The remaining delays come from the machine, not the database: the browser client shares the
four cores (and another worktree's test suite ran at the same time); the same server and database with no client show 12
delays ≥ 100 ms in 75 s (worst 164 ms), a fresh database 8 (worst 392 ms).

**Write rates** (`rate.js`: fresh `npm start`, two minutes, rows per minute; normal = the code before):

| Level | journal_postings | journal_entries | ledger | orders | fills | trades |
|---|---|---|---|---|---|---|
| normal | 7,249 | 3,512 | 2,117 | 1,395 | 698 | 349 |
| low (default) | 391 (18.5×) | 191 (18.4×) | 111 (19×) | 80 (17×) | 40 (17×) | 20 (17×) |
| off | 0 simulated orders (the `sim-activity` suite) | | | | | |

**Design.**
- **Operations worker for every whole-table job** (`server/ledger-audit.js`, `server/ops-worker.js` tasks `ledgerAudit`,
  `perpsLedger`): the full ledger audit (journal, the database's module checks, pending payouts) and the Perps ledger page
  run on a read-only connection inside one read transaction; the request thread only records the result
  (`ledger_audits`). The module checks are plain functions of the database (`perpsChecks`, `playModeChecks`); a
  database names the checks it has (`journal.enableCheck`, set by Perps and play mode when mounted), so the worker runs
  exactly what the in-process hooks run and the results are identical (an in-memory database falls back to the request
  thread). A scheduled audit never overlaps the previous one.
- **Migration 0003** (`server/migrations/0003-db-growth.js`): `idx_orders_expiring` (partial), `idx_orders_resting_user`
  (partial; play-mode preview and reset), `idx_trades_ts` (trade tape, Trade API list, reports), `idx_fills_trade`
  (social trade feed, referral first trades, compaction), `idx_ledger_kind_ts` (reports); table `ops_compactions`.
  Building them on the measured database takes about 2.4 s once, at start, before the server listens.
- **Bounded queries:** the member's transactions (newest 500) and settlements (newest 500); the transactions CSV in
  pages.
- **Streaming backups:** the worker seals the checkpointed main file directly (no plaintext copy) into a staging file as
  the chunked format PLXB2 (1 MiB chunks, AES-256-GCM per chunk, header and chunk index authenticated; SECURITY.md),
  hashing plaintext and ciphertext on the way, then hands it to the store: the local driver renames the staging file into
  place, S3 streams one PUT signed with the precomputed SHA-256 up to 16 MiB or sends a multipart upload of 16 MiB parts.
  Checkpoints wait only while the main file is read, not during the upload. Restore streams the object (the local
  store's own file or a streamed download), checks its SHA-256, then decrypts into a temporary file renamed only after the
  last tag and the plaintext SHA-256 matched; PLXB1 objects (WAL segments, older snapshots) still open, as streams too.
  WAL generations are replayed only as an unbroken run from the snapshot's own (a missing generation ends the replay).
- **Simulated trading activity** (owner setting `simulation.activity`, Admin › Owner settings › Simulated markets, CMS
  explanation, reason, audit, live, default **low**; `server/sim-activity.js`): `normal` = the old behaviour; `low` =
  a market re-quotes only after its fair price moved 2¢ (and its quote is 15 s old) or moved at all and the quote is a
  minute old, at most 20 re-quotes a minute exchange-wide (token bucket), each with its reference trade when the price
  changed — the last trade always equals the quoted fair price, so prices, charts and volume keep moving; `off` = no
  re-quotes, reference trades or opening quotes (resting quotes stay). The 15-minute flash markets' two opening orders
  are not governed by it.
- **Backup count** (owner setting `backups.keep_interval_count`, default 8, step-up): interval snapshots are kept while
  inside `backups.keep_interval_hours` **and** among the newest 8; `pre_compaction` backups are kept a year like manual
  ones. README › Owner guide says how to clear `data/backups` safely.
- **`npm run db:compact`** (`scripts/db-compact.js`, `server/compact.js`): with the server stopped (the instance lock
  refuses otherwise) and the database at this build's schema. It takes an encrypted `pre_compaction` snapshot through the
  backup code first and refuses without one (recorded as refused). Then, in one transaction, for history older than
  `--days` (7): **compaction rules** —
  1. candidates are orders of system accounts placed by the liquidity jobs (`source = 'liquidity'`), not resting, created
     and last changed before the cut-off;
  2. a trade with any member fill is never touched, nor any order that filled in it, nor any of their journal entries or
     ledger rows; member rows are never selected at all;
  3. candidate orders with no fill are deleted with their `order_reserve` / `refund` journal entries, their ledger rows
     and their `journal_order_credits` rows;
  4. bot-against-bot trades (every fill from a candidate order, before the cut-off): their `trade` / `fee` journal entries
     and the `order_reserve` / `refund` entries of the orders that filled in them are replaced by one balancing
     `compaction_rollup` entry per system account, UTC day and money epoch / mode, whose postings are the net of the
     removed postings per journal account (zero nets are dropped; an unbalanced group aborts); their ledger rows by one
     `compaction` row per account and day; the orders, fills and trades themselves stay;
  5. `journal_balances` is not written: every account's posting sum is unchanged by construction; the full ledger audit
     (with the Perps and play-mode checks and pending payouts) is computed before and after and any difference in its
     result, problems or totals rolls everything back.
  Charts, candlesticks, volume, the trade tape and the Trade API read `trades`, which stay complete; positions are
  untouched. Afterwards `VACUUM` (needs free disk about the database's size), the WAL generation counter moves past the
  unshipped compaction writes and a `post_compaction` snapshot of the result is taken (so a point-in-time restore after
  the compaction starts from it, and one before it stops at the pre-compaction snapshot), the run is recorded in
  `ops_compactions` and the audit chain (`ops.db_compact`), and the sizes before / after are printed. `--dry-run` runs
  the same transaction and rolls it back (no backup needed). Admin › System › Database shows the size (with the WAL) and
  the last compaction (and a refused attempt after it).

**Tests** (each new one fails on the code before; shown by running them against `origin/main` with the new test files):
`large-db.e2e` (1.05 M orders, 5.2 M postings, 520 k fills: the scheduled audit, the ledger audit view and run, the Perps
ledger, a backup and a restore drill with no answer above 700 ms — the old code stalled several seconds; a 2.1 GiB
database backed up and restored with the resident set growing under 400 MB, byte-identical, PLXB2 on disk, and a PLXB1
object of the earlier format still restoring — the old code could not back it up); `db-compact.e2e` (real simulated
trading at "normal" with a member trading against the liquidity accounts, dated 10 days back: dry run, refusal without a
writable backup store, the real run keeping the audit clean and every member's orders, fills, ledger, positions,
balance, journal and history page, every trade and the candlestick chart identical, Admin › System in Chromium showing
the run, the pre-compaction backup restoring the old state); `sim-activity.e2e` (Chromium: low by default with its
explanation; normal → low cuts orders and journal entries at least 10× with reference trades still printing; off writes
nothing; audited; survives a restart); `backups.e2e` gains the S3 streamed / multipart upload and a multipart snapshot
restored, and the interval count limit.

**Existing tests changed:** `backups.e2e` (the snapshot object on disk starts with `PLXB2` instead of `PLXB1`: the
format changed by design; the encryption assertions are unchanged; the retention test also checks the count limit);
`sports.e2e` (pins `simulation.activity` to `normal` with a start option: it checks per-move re-quoting — the price within
3 points of the win probability — which is the normal level; low re-quotes on 2¢ moves within an exchange-wide budget);
`tests/lib/fake-s3.js` gains multipart uploads.

**Residual risks.** Per-member work still grows with that member's own history (the History timeline UNION: about
200 ms for a member with 60 k orders, 60 k fills and 60 k ledger rows; pushing the page limit into each branch is the
next step); Admin › Reports is proportional to the trades in the chosen period; the audit in the worker holds a read
snapshot for a few seconds on a large database, during which the WAL cannot be checkpointed (it grows, and a scheduled
snapshot waits for the next tick); single-row commits still wait on the disk when it is busy (synchronous = FULL is
kept for durability); `db:compact` needs the server stopped and free disk about the size of the database for VACUUM;
compaction does not shrink trades or fills (they are the price history); history written at "normal" before the
compaction remains until it is older than `--days`.

### 39.17a Fixes from the combined run (2026-11-13)
The first full local CI run of the combined batch (database growth + performance pass + dependency batch) passed every
stage except 4 of 409 end-to-end scenarios; each cause is fixed:
- **Admin › Perps buttons dead while panels loaded** (a real bug, shown by the halt test timing out under load): the
  Halt / Resume / Leverage / Fund click handler was attached only after the six extra panels (now including the Perps
  ledger in the operations worker) had loaded. It is attached before anything is awaited; `admin.e2e` holds the ledger
  request back and clicks Halt at once (fails on the old code). The audit-log scenario after it failed only because the
  halt never happened.
- **Interval backups kept by count**: two snapshots with the same time were ordered by chance; `prune` now breaks ties by
  row order, and the retention scenario gives its new snapshots distinct times.
- **The 2 GiB backup scenario** compared the manifest checksum with the file before the server started (the server writes
  as it starts); it now checks the round trip: the restored database is byte for byte the backed-up one.
- Full suite: 410 scenarios across 55 files.

### 39.18 Performance pass on the request path (2026-11-13)
A CPU profile of the server under `scripts/load.js --profile smoke` (60 orders/s, 50 WebSocket clients) put the largest
single cost in the transaction helper `tx` (`server/db.js`): SQLite ran with its default `synchronous = FULL`, so every
commit waited for the disk. Every signed-in request also wrote the member's session time (`server/features.js`).
- **Owner setting `db.max_durability`** (Admin › Owner settings › Backups, step-up, reason, audit, live): off =
  `synchronous NORMAL` (WAL mode: an app crash or restart loses nothing and the database cannot be corrupted; a power cut
  or operating-system crash can lose the newest commits), on = `FULL` (every commit waits for the disk). Recommended
  default **off while trading is play money**; Admin › Launch readiness has a check `db_durability` that requires it on,
  so the switch to real money cannot run without it. Applied at start and on every change.
- **Session time** is added up in memory per member and day and written at most every 15 s; the daily-limit check adds
  the unwritten seconds (still exact); an admin clearing it also clears the unwritten part; at most 15 s can be lost in a
  crash. Whole seconds are written and the remainder carries over (each gap used to be rounded on its own).
- Measured on the same machine and load (smoke profile, 60 orders/s target):

  | | FULL (before) | NORMAL (default now) |
  |---|---|---|
  | order p50 / p99 | 162 / 5,130 ms | 113 / 506 ms |
  | other API p99 | 2,890 ms | 465 ms |
  | public pages p95 | 321 ms | 222 ms |
- Tests: `features.e2e` (30 signed-in requests write the session row at most twice; the limit test unchanged),
  `ops.e2e` (the readiness check red by default and green once on, the switch to real money refused while it is off,
  `PRAGMA synchronous` 1 / 2, kept after a restart).
- Next on the request path (not done here): the idempotency layer's response handling and the demo market makers'
  quoting (`server/engine.js` `quote`) are the next largest self-time items in the profile.

### 39.19 Data retention by class (2026-11-13; Phase 9A not-built item)
Owner settings in Admin › Owner settings › Data retention (ground rule 6: recommended default, CMS explanation, reason,
step-up because they concern personal data, audit, live effect). Days a record is kept; 0 keeps it forever.

| Setting | Data | Default |
|---|---|---|
| `retention.notifications_days` | in-app notifications (read or not) | 365 |
| `retention.device_days` | device sightings (hashes used by fraud and referral checks), by last seen | 180 |
| `retention.share_clicks_days` | share-link click records (hashed address, time); links keep their totals | 90 |
| `retention.email_copies_days` | the server's copies of sent emails (addresses, personal details) | 30 |
| `retention.chat_days` | event chat messages | 0 (kept) |

Already scheduled elsewhere: security and sign-in logs (`logs.retention_days`, 90), closed accounts' identity data (Admin ›
Identity, KYC retention), unconfirmed waitlist guests (§36), backups (§39.3). The purge runs with the hourly maintenance
job, deletes in batches of 2,000 rows with a yield in between (a large purge never holds up requests), audits every class
it purged with its count (`ops.retention_purge`), and Admin › System (`GET /v1/admin/system` → `retention`) reports the
classes, their days and the last purge. Test: `retention.e2e` (defaults, chat kept, audit, the UI change, restart).

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
