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
