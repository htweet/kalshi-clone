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
npm run test:e2e     # 259 end-to-end browser scenarios across 32 files (Playwright + node:test)
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

## Currency (naira by default)

- **Prices and balances show in naira.** A contract pays **₦100**: a 64¢ price shows as **₦64**, a balance of $25.00 as **₦2,500**, and finer markets show kobo (**₦64.50**). Odds (%) and payout multipliers are unchanged. Perps prices, margin, funding and P&L use the same rule.
- **Amounts you type are naira.** Deposits, withdrawals, transfers, the ticket's **Naira** mode and limits take whole naira. Limit prices are the same number as before (64 = ₦64).
- **It is a display rule, not an exchange rate.** The API keeps its fields (`*_dollars`); `GET /v1/exchange/display_currency` tells you the rule (display = dollars × 100 under NGN).
- **Admin › Settings › Currency & defaults** switches between NGN and USD, sets the locale and time zone (default Africa/Lagos) and the settings new accounts start with. Changes need a reason and a password check, are audited, and update open pages at once.

## Managing content

Everything people read on the site is edited in **Admin › Content & settings** (`/admin/cms`): texts, notification and
email templates, images, pages and the footer, and the brand. Code keeps only the defaults.

**Who can do what.** An **editor** saves drafts, previews them, sends test emails and uploads images. A **publisher**
(or an admin) also publishes, schedules and rolls back. Give roles in Admin › Roles.

**Change a text** (a button, heading, hint or error message):
1. Admin › Content & settings › **Texts**. Search for the words you see on the page, or pick the page and section.
2. Open the key, type the new text and **Save draft**. Words in braces, such as `{amount}`, are filled in by the app;
   keep them (you can move them). A text that uses a name the key does not offer is refused.
3. **Preview in context** opens the site in preview mode: you see your drafts, nobody else does. Leave it with
   **Exit preview**.
4. A publisher clicks **Publish…**, gives a reason, and optionally a date and time to publish later. Open pages update
   at once; a few texts shown in menus ask the reader to reload.
5. **History** lists every version; **Restore** puts an earlier one back (version 0 is the original wording).

Plain texts cannot contain HTML. A few texts are marked *rich*: they accept bold, italic, lists and links (to `https:`
addresses or site pages); everything else is removed.

**Notification and email templates** (Templates): each kind of notification has its in-app, push and email texts; the
account emails (confirm email, password reset, security alerts) and the phone-code SMS have their own. Use
`{{variable}}` placeholders from the list shown; no other syntax is allowed. **Preview with sample data**, then **Send a
test to me** (it arrives in the dev mailbox at `/dev/mailbox` in development). The shared email layout sets the header,
footer and legal line of every email.

**Images** (Media): upload PNG or JPEG files. The server re-saves every image, which removes hidden data such as the
location a photo was taken; SVG and other formats are refused. Then pick an image for a slot (logo, favicon, app icon,
promo art, category icons, email header, empty states) and publish it. A square app icon of at least 512 px gives the
home-screen icons of the installed app.

**Pages & footer**: edit the terms, privacy policy, responsible trading, help centre, fee schedule and incentive terms,
or add a page (`support/contact` shows at `/support/contact`). Each page has an SEO title and description. Publishing a
legal page asks for your password again. The footer has a tagline and link columns.

**Branding**: the brand and YES colours for the light and dark themes (each must be readable: at least 4.5:1 contrast
with the page background), and the app name and short name used by the browser tab and the installed app.

**Backups** (Import / export): download all content as JSON; importing a file shows exactly what would change before
you apply it.

Fees, limits, features, payments and Currency & defaults stay in their own settings panels, linked from the overview;
feature flags, play mode and the Central Bank have their own sections (below).
For developers: new strings go in through `node scripts/cms-extract.js <file>`; `npm run lint` fails on hard-coded
user-facing text (`CLONE_SPEC.md` §32).

## Feature flags, play mode and the Central Bank (Phase 5D)

Admin guide for `../CLONE_SPEC.md` §33. Every change below needs a reason and a password check, is written to the
hash-chained audit log, and reaches open pages at once.

**Feature flags** (Admin › Feature flags, `settings.write`). Every feature and module has a flag: trading mechanics
(order types, order review, flip sell, fractional, scalar, collateral return, rolling markets), combos and RFQs, perps,
sports (spread & total, live clocks), social, live chat and group chats, watchlist, price alerts, deposits,
withdrawals and each payment rail, interest, identity verification, sign-up and each sign-in method, AI summaries,
ballot, incentives, rewards, hubs and their widgets, the in-app / email / push channels, app install and push devices,
the currency switch, live content updates, and the play-mode features.
- **Kill** switches a feature off for everyone at once; **Revive** releases the kill switch.
- **Edit** sets: on / off; **rollout** (a percentage of signed-in users, stable per user: the same people keep it as you
  raise it; signed-out visitors only at 100 %); **allow / deny users** (emails); **allow / deny roles** (`guest`, `user`
  = any signed-in account, `staff`, or an admin role); **regions** (2-letter countries, from the location check of
  Admin › Compliance); a **start** and **end** time. The dialog lists the server routes the flag guards and its history.
- Off means: its pages show "not available", its menu entries and buttons disappear, its API answers
  `403 feature_disabled`, and its background jobs (simulations, deliveries, accruals) pause.
- Order of precedence: a module that is not running at all (for example `SPORTS=0`) → the `FEATURE_FLAGS` environment
  variable (`FEATURE_FLAGS=perps=off,sports=on`, a technical override for incidents) → the kill switch → the flag's own
  settings. The old Admin › Settings switches for social, perps and combos still work alongside.

**Play mode** (Admin › Play mode, `settings.write`): the whole site runs on free play money.
- **Turn play mode on** only works while no customer holds real money (balances, positions, open orders, perps,
  pending payments, held withdrawals); the panel shows those counts.
- **Bonus and deposits**: a signup bonus for every new account (minted, or paid from the Central Bank vault) and an
  optional daily play-money deposit cap per user. Deposits are free and instant (Transfers › Deposit shows a play-money
  form); card, bank and crypto are not used; withdrawals are off everywhere. A "Play money" banner is on every page.
- **Switch to production**: **Preview the reset** shows exactly what will be archived and set to ₦0. Type `RESET` and a
  reason to request it; a **second admin** approves (typing `RESET` again). A database backup is written to
  `data/backups/` first, then customer orders are canceled and every balance, position, perps account and the vault
  are archived and set to ₦0. Accounts, markets and content stay. Users get a notice. Play mode cannot be turned on again
  while real money exists.

**Central Bank** (Admin › Central Bank; views `users.read`, funding `users.money`, settings `settings.write`).
- Switch the Central Bank and the Vault Heist on or off; **Fund vault** / **Defund** with a reason.
- In play mode the vault is the Vault Heist prize pot (`/heist`, MORE menu): players pay a crew fee into the vault, guess
  a secret code (a teal dot for each right digit in the right place, a ring for a right digit in the wrong place) before
  the timer and the alarm run out, and take a share of the vault. Settings: crew fee, timer, code length and tries,
  share and caps per heist and per day, attempts per day, jail time, security level and its decay.
- In production the vault is the **promotions treasury**: signup bonuses (as promotional credit), liquidity rewards and
  referral credits are paid from it. When the budget is short, payouts are **queued** (paid in order once you fund the
  vault, or with **Pay queued now**) or **refused**, per setting.

**Money controls** (Admin › Users › a user › Money controls, `users.money`): revoke deposits, withdrawals or both for
one account, with a reason the user sees on Transfers and in a notice. Site-wide, use the **Deposits** and
**Withdrawals** flags.

For developers: a new feature module or route group must get a flag in `server/flags.js` (`REGISTRY`, `ROUTE_RULES`,
`MODULE_FLAGS`) or be listed as platform core; `tests/flags.e2e.test.js` fails otherwise. Hide its entry points with
`data-flag="<key>"` and its pages through `ROUTE_FLAGS` in `public/js/flags.js`.

## Perps completion (Phase 6)

Admin and user guide for `../CLONE_SPEC.md` §34.

**For traders** (Perps market page and Portfolio › Perps):
- **Subaccounts** (Portfolio › Perps › Subaccounts): create up to 10 named subaccounts, each on **isolated margin**
  (each position has its own margin) or **portfolio margin** (all positions of the subaccount share its collateral and
  are liquidated on the subaccount's total maintenance margin, largest position first). Move funds between subaccounts
  there, and between Predictions cash and any subaccount in the transfer box; the ticket has a subaccount picker.
- **Edit an order** (Open orders › Edit): a smaller size at the same price keeps your place in the queue; a new price or
  a larger size replaces the order.
- **Order groups** (Portfolio › Perps › Order groups): a *limit* group cancels its open orders once its orders have
  filled the limit; a *one-cancels-the-other* group cancels the rest after the first fill; **Cancel all** cancels every
  open order of a group. Pick the group in the ticket.
- **Trailing stop** (position row › Trail): the stop follows the best mark by the percentage you set and closes the
  position when the mark falls back that far (rises, for a short).
- **Margin tiers**: bigger positions need more margin; the ticket shows the tier and the maximum leverage at your size,
  the market page lists the tiers. Fractional sizes (0.01 contract) work on every market except US 10Y Yield.
- **Rewards** (Portfolio › Perps › Rewards): interest on your Perps collateral when it is running, and your referral
  code; a friend who adds it and trades enough on Perps earns you both a bonus in Perps collateral.

**Admin › Perps ops** (`perps.ops`: the Admin and Risk roles). Every change needs a reason (audited); tiers, risk
limits, APY and referral rewards also a password check.
- **Margin tiers** per market: the notional cap of each tier with its initial and maintenance margin (%). Tier 1 sets
  the market's maximum leverage; the last cap is the largest position allowed.
- **Risk limits**: open orders per market and in total per user, subaccounts per user, order groups and orders per group.
- **APY**: switch interest on collateral on, set the yearly rate and the payout interval; **Pay out now**. In play mode
  it is play money; in production it is paid from the Central Bank (promotions treasury) and queued or refused when the
  budget is empty (Admin › Central Bank shows the queue).
- **Waitlist**: switch the gate with the `perps.waitlist` feature flag. While it is on, new users join the waitlist from
  the Perps page and see their place in line; **Invite next in line** (FIFO), **Approve selected** or **Revoke
  selected**. Approved users get a notification and an email (Admin › Content › Templates › Perps email › Perps access
  unlocked; joining sends "Joined the Perps waitlist") and their open page unlocks at once. Users who already traded Perps, and staff, keep access; anyone can always close
  positions and move money back to Predictions.
- **Referrals**: program on / off, rewards for the referrer and the friend, the Perps volume to qualify, the days to
  qualify and to add a code, lifetime caps per referrer.
- **Perps journal**: shows whether the perps ledger balances, the insurance fund, the backstop and the fees collected.

Flags (Admin › Feature flags): `perps.subaccounts`, `perps.portfolio_margin`, `perps.order_groups`, `perps.amend`,
`perps.trailing_stops`, `perps.fractional`, `perps.apy`, `perps.referrals`, `perps.waitlist` (off on a new database).

## Trading core (Phase 5A)

- **Finer prices.** Some markets trade in 0.1¢ steps (`deci_cent`), or in finer steps near 0¢ and 100¢ (`tapered`). Combos use 0.1¢ steps, and 0.01¢ near the edges. The ticket's limit field steps by the market's tick and lists the bands.
- **Fees.** Fees are charged once per order: the exact fee of every fill is added up and rounded up a single time.
- **Scalar markets** (for example *Harbor GDP growth in Q4 2026*) pay YES a share of ₦100 (one contract) by the reported value between a floor and a cap; NO gets the rest. Admins resolve them with the value.
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

Environment: `PORT`, `DB_FILE`, `RATE_BURST`, `RATE_PER_SEC` (anonymous rate-limit tier defaults), `ALLOWED_ORIGINS`, `TRUST_PROXY`, `ASSETS` (`dist` or `src`), `ROLLING_WINDOW_SEC` (rolling market window, default 900), `SPORTS=0` (turn the sports simulation off), `SPORTS_SPEED` (game seconds per real second, default 1), `PAYMENTS_DEMO_FUNDS` (`0`/`1`, instant demo funds; default on outside production), `PAYMENTS_SANDBOX` (`0`/`1`, sandbox payment rails; default on outside production), `ANTHROPIC_API_KEY` + `AI_SUMMARY_MODEL` (optional external AI summarizer; both must be set, see above), `FEATURE_FLAGS` (technical flag overrides, `key=on|off,…`, see Feature flags).

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
