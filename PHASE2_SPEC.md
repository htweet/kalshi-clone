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
`notifications` WebSocket channel; status `sent`, or `no_device` when none is registered; 6. **in-app** → the inbox row
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
