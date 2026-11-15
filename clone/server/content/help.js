'use strict';
// Help Center (owner request 2026-11-15, CLONE_SPEC.md §40): the code defaults for the step-by-step user guides. Each guide
// is a CMS page `help/<slug>` (Admin › Content › Pages edits, hides, reorders and adds guides; history and rollback come
// with the CMS), served at /help/<slug> and listed on the Help Center home (/help, /support/help-center).
//   category  one of CATEGORIES (the topic group on the Help Center home)
//   summary   one line under the title in lists and search results
//   position  order inside the topic (smaller first)
//   related   up to six other guides shown under "Related guides"
// Bodies use the CMS page allowlist (server/cms/sanitize.js): numbered steps are <ol>, tips are <blockquote>, and
// screenshots are <figure><img src="/help-img/…"> (captured from Parlance by `npm run help:screenshots`; an admin can
// point an image at an upload from the media library instead, /media/<id>.png). Step names match the app's own labels.
// Category titles and descriptions are text-catalog keys (help.category.<key>.title / .description), editable in
// Admin › Content › Texts.
const CATEGORIES = ['getting-started', 'trading', 'money', 'account-security', 'features', 'troubleshooting'];

const fig = (file, alt, caption) => `<figure><img src="/help-img/${file}" alt="${alt}"><figcaption>${caption}</figcaption></figure>`;

const GUIDES = {
  // ------------------------------------------------------------------ Getting started
  'create-account': {
    category: 'getting-started', position: 10, title: 'Create your account',
    summary: 'Sign up with your email in under a minute.',
    related: ['verify-identity', 'add-funds', 'place-your-first-trade'],
    body: `<p>You need an account to trade, save a watchlist and get alerts. You must be 18 or older.</p>
<h2>Steps</h2>
<ol>
<li>Select <b>Sign up</b> at the top right of any page.</li>
<li>Enter your <b>Display name</b>, <b>Email</b> and a <b>Password</b>. The password needs at least 12 characters, mixing at least two of: lowercase, uppercase, digits and symbols. It cannot be your name or email.</li>
<li>Select <b>Create an account</b>. You are signed in straight away and your name appears at the top right.</li>
<li>Open the email we send you and select the link to confirm your address. The link works once.</li>
<li>When asked <b>What’s your phone number?</b>, choose <b>Nigeria (+234)</b>, enter your number and select <b>Continue</b>, or select <b>Not now</b> to do it later.</li>
</ol>
${fig('sign-up.jpg', 'The Create your account form with Display name, Email and Password fields', 'The sign-up form.')}
<h2>Good to know</h2>
<ul><li>You can also continue with Google or Apple where those buttons are shown.</li><li>One account per person. Keep your password private and turn on <a href="/help/two-factor-login">two-factor login</a>.</li></ul>`,
  },
  'verify-identity': {
    category: 'getting-started', position: 20, title: 'Verify your identity',
    summary: 'Confirm your phone, name, address and ID to unlock withdrawals and API keys.',
    related: ['create-account', 'withdraw-funds', 'verification-problems'],
    body: `<p>Identity verification protects your account and is required before you can withdraw or use API keys. It takes about two minutes. Have your government-issued ID and a smartphone ready.</p>
<h2>Steps</h2>
<ol>
<li>Select your name at the top right, then <b>Account &amp; security</b>.</li>
<li>Choose the <b>Identity &amp; privacy</b> tab and select <b>Verify your identity</b>.</li>
<li><b>What’s your phone number?</b> Choose <b>Nigeria (+234)</b>, enter your number and select <b>Continue</b>.</li>
<li><b>Enter your 4 digit code</b> from the text message. If it does not arrive, select <b>Resend code</b>, or <b>Use a different number</b>.</li>
<li><b>What’s your name?</b> Enter your <b>Legal first name</b> and <b>Legal last name</b> exactly as they appear on your ID.</li>
<li><b>When’s your birthday?</b> Enter your date of birth. You must be 18 or over.</li>
<li><b>What’s your address?</b> Enter your residential address (not a business address or PO box).</li>
<li><b>Let’s get you verified</b>: select <b>Get started</b>. Scan the QR code with your phone to continue there, or select <b>Continue on this device instead</b>.</li>
<li><b>Add photos of your ID</b>: take clear photos of the front and back of your ID, then a selfie, and select <b>Submit photos</b>.</li>
</ol>
${fig('identity-phone.jpg', 'The verification step asking for your phone number with the Nigeria country code', 'The first verification step.')}
<h2>What happens next</h2>
<ul><li>Most checks finish in a few minutes. Your status shows under <b>Identity verification</b> on the Identity &amp; privacy tab.</li><li>If a check fails you can try again; the screen shows how many attempts are left. See <a href="/help/verification-problems">Problems with verification</a>.</li></ul>
<blockquote>Parlance staff will never ask for your password or codes. Your identity details are encrypted and never shown in full.</blockquote>`,
  },
  'how-play-money-works': {
    category: 'getting-started', position: 30, title: 'How play money works',
    summary: 'Parlance runs on simulated naira today. Here is what that means for you.',
    related: ['add-funds', 'real-money-waitlist', 'how-prices-work'],
    body: `<p>Parlance is preparing for a real-money launch in Nigeria. Until then, every balance, deposit, trade and payout uses <b>simulated naira</b>. Nothing you do here moves real money.</p>
<h2>What you can do with play money</h2>
<ul><li>Trade every market exactly as you would with real money, with the same prices, order book and settlement.</li><li>Build a track record on the leaderboard and earn rewards in play money.</li><li>Practise with deposits and withdrawals: card, bank and crypto rails are simulated.</li></ul>
<h2>Steps to get started</h2>
<ol><li><a href="/help/create-account">Create your account</a>.</li><li><a href="/help/add-funds">Add play-money funds</a> from <b>Deposit &amp; withdraw</b>.</li><li><a href="/help/place-your-first-trade">Place your first trade</a>.</li><li>Want to hear when real money opens? <a href="/help/real-money-waitlist">Join the waitlist</a>.</li></ol>`,
  },
  'find-markets': {
    category: 'getting-started', position: 40, title: 'Find markets and build a watchlist',
    summary: 'Browse by category, search, sort by volume and star markets to follow them.',
    related: ['how-prices-work', 'price-alerts', 'elections-hub'],
    body: `<h2>Browse and search</h2>
<ol>
<li>Use the category tabs under the header (<b>Trending</b>, <b>Politics</b>, <b>Sports</b>, <b>Elections</b>, <b>Economics</b> and more), or select <b>Markets</b> for the full list.</li>
<li>On <b>Browse Markets</b>, switch between grid and list views and filter by how often markets close.</li>
<li>To search, type a word (for example <i>Lagos</i>) in the search box and press Enter.</li>
<li>Select <b>Live</b> for markets with games and events happening now, or open <b>More</b> › <b>Calendar</b> for what closes next.</li>
<li>Each category page lists its markets with filters on the left; see <a href="/help/browse-a-category">Browse a category page</a>.</li>
</ol>
${fig('browse.jpg', 'The Browse Markets page showing market cards with prices', 'Browse Markets.')}
<h2>Build a watchlist</h2>
<ol><li>Select the star (<b>Watch</b>) on any market card, or <b>☆ Watch</b> on a market page.</li><li>Find everything you starred, plus recently viewed markets, under <b>Watchlist</b> in the menu under your name.</li></ol>
<blockquote>Tip: turn on <b>Data saver</b> at the bottom of the page if you are on a slow or costly mobile connection.</blockquote>`,
  },
  'install-the-app': {
    category: 'getting-started', position: 50, title: 'Install Parlance on your phone',
    summary: 'Add Parlance to your home screen to open it like an app.',
    related: ['notifications', 'request-timed-out'],
    body: `<p>Parlance works in your browser and can be installed on your phone or computer, with no app store needed. Installed, it opens full screen and can show push notifications.</p>
<h2>Android (Chrome)</h2>
<ol><li>Open Parlance in Chrome.</li><li>Select <b>Install app</b> when the banner appears, or open Chrome’s ⋮ menu and choose <b>Install app</b> / <b>Add to Home screen</b>.</li><li>Confirm. The Parlance icon appears on your home screen.</li></ol>
<h2>iPhone and iPad (Safari)</h2>
<ol><li>Open Parlance in Safari.</li><li>Tap the Share button, then <b>Add to Home Screen</b>.</li><li>Tap <b>Add</b>.</li></ol>
<h2>Computer (Chrome or Edge)</h2>
<ol><li>Select the install icon at the right of the address bar, or the browser menu › <b>Install Parlance</b>.</li></ol>
<blockquote>If you lose connection, the app shows an offline page and retries by itself when you are back online.</blockquote>`,
  },

  // ------------------------------------------------------------------ Trading
  'how-prices-work': {
    category: 'trading', position: 10, title: 'Read a market: prices, chances and payouts',
    summary: 'A price of ₦64 means the market gives the outcome a 64% chance.',
    related: ['place-your-first-trade', 'how-markets-settle', 'trading-fees'],
    body: `<p>Every market asks a yes-or-no question. Each contract pays <b>₦100 if you are right</b> and nothing if you are wrong.</p>
<h2>How to read a market page</h2>
<ol>
<li><b>Price</b>: the <b>Yes</b> and <b>No</b> buttons show what one contract costs now, for example <b>Yes ₦52</b> and <b>No ₦50</b>.</li>
<li><b>Chance</b>: the price is also the market’s chance. ₦52 for Yes means about a 52% chance.</li>
<li><b>Payout</b>: buy 10 Yes contracts at ₦52 for ₦520. If the outcome happens you receive ₦1,000 (₦480 profit). If not, you receive nothing.</li>
<li><b>Chart</b>: switch between <b>1D</b>, <b>1W</b>, <b>1M</b> and <b>ALL</b>, and hover over the line to see the price at any time.</li>
<li><b>Order book</b>, <b>Rules</b> and <b>Activity</b> tabs under the chart show open offers, how the market is decided, and recent trades.</li>
</ol>
<h2>Prefer odds?</h2>
<p>Go to <b>Settings</b> › <b>Trade mechanics</b> and choose <b>Payout and odds</b> to show a multiplier and chance (for example 2.1x · 47%), or <b>Shares and prices</b> to show Yes and No prices.</p>
<blockquote>Always read the <b>Rules</b> tab before you trade: it names the settlement source and the exact closing time.</blockquote>`,
  },
  'place-your-first-trade': {
    category: 'trading', position: 20, title: 'Place your first trade',
    summary: 'Buy Yes or No on a market in five steps.',
    related: ['how-prices-work', 'limit-orders', 'sell-a-position'],
    body: `<h2>Before you start</h2>
<ul><li>You are signed in and have funds. See <a href="/help/add-funds">Add funds</a>.</li></ul>
<h2>Steps</h2>
<ol>
<li>Open a market, for example from the home page or <b>Markets</b>.</li>
<li>In the trade ticket on the right (at the bottom on a phone), make sure <b>BUY</b> is selected.</li>
<li>If the event has several outcomes, select the outcome you want in the list, then choose <b>YES</b> or <b>NO</b>.</li>
<li>Enter the amount in naira in the <b>Naira</b> box. The ticket shows how many contracts you get, the chance, and your <b>Max payout</b>.</li>
<li>Select <b>Review · Buy Yes</b> (or Buy No). Check the order, then select <b>Place order</b>.</li>
</ol>
${fig('ticket-buy.jpg', 'The trade ticket with BUY selected, YES chosen, an amount entered and the Review button', 'The trade ticket, ready to review.')}
<h2>What happens next</h2>
<ul><li>A message confirms how many contracts were filled. Your position appears under <b>Portfolio</b> › <b>Positions</b>.</li><li>If not everything can be filled at once, the rest waits as a resting order. See <a href="/help/manage-open-orders">Manage open orders</a>.</li></ul>
<blockquote>Prefer to buy a set number of contracts or name your own price? Open the <b>NAIRA ▾</b> menu in the ticket and choose <b>Contracts</b> or <b>Limit order</b>. Trading often? See <a href="/help/one-click-trading">Trade with 1-Click</a>.</blockquote>`,
  },
  'limit-orders': {
    category: 'trading', position: 30, title: 'Use limit orders',
    summary: 'Choose the price you want to pay and how long the order waits.',
    related: ['manage-open-orders', 'place-your-first-trade', 'trading-fees'],
    body: `<p>A limit order only fills at your price or better. If nobody sells at that price yet, it rests in the order book until it fills, expires or you cancel it. Resting (maker) orders pay no trading fee.</p>
<h2>Steps</h2>
<ol>
<li>Open a market and, in the trade ticket, open the <b>NAIRA ▾</b> menu.</li>
<li>Choose <b>Limit order</b>.</li>
<li>Choose <b>YES</b> or <b>NO</b>, then enter the <b>Limit price (₦)</b> you are willing to pay per contract.</li>
<li><b>Expires</b> is <b>Never (GTC)</b> (good till cancelled) unless you choose a time, after which the order cancels itself.</li>
<li>Enter the number of <b>Contracts</b>. The ticket shows the <b>Max cost</b>, the <b>Est. fee (if taken)</b> and the <b>Max payout</b>.</li>
<li>Select <b>Review · Buy Yes</b> (or Buy No), check the details, then select <b>Place order</b>.</li>
</ol>
${fig('ticket-limit.jpg', 'The trade ticket in Limit order mode with the price field', 'Limit order mode.')}
<h2>Good to know</h2>
<ul><li>Your ticket mode is remembered for next time.</li><li>See and cancel waiting orders under <b>Portfolio</b> › <b>Resting</b>.</li></ul>`,
  },
  'sell-a-position': {
    category: 'trading', position: 40, title: 'Sell or close a position',
    summary: 'Take profit or cut a loss before the market closes.',
    related: ['place-your-first-trade', 'how-markets-settle', 'manage-open-orders'],
    body: `<p>You can sell contracts you hold at the current bid at any time while the market is open. You do not have to wait for the result.</p>
<h2>From the market page</h2>
<ol>
<li>Open the market and select <b>SELL</b> at the top of the trade ticket.</li>
<li>Enter how many <b>Contracts</b> to sell. <b>You hold</b> shows how many you have and <b>Est. proceeds</b> what you would receive.</li>
<li>Select <b>Review · Sell Yes</b> (or Sell No), check the proceeds, then select <b>Place order</b>.</li>
</ol>
${fig('ticket-sell.jpg', 'The trade ticket with the SELL tab selected, showing contracts held', 'Selling from the trade ticket.')}
<h2>From your portfolio</h2>
<ol><li>Open <b>Portfolio</b> and stay on <b>Positions</b>.</li><li>Find the position and select <b>Sell</b>.</li><li>Choose how many contracts and confirm.</li></ol>
${fig('portfolio.jpg', 'The Portfolio page with the Positions tab', 'Portfolio › Positions.')}
<blockquote>Selling Yes when you also hold No (or the other way round) nets the two into cash at ₦100 a pair.</blockquote>`,
  },
  'manage-open-orders': {
    category: 'trading', position: 50, title: 'Manage open (resting) orders',
    summary: 'See, reduce or cancel orders that are waiting to fill.',
    related: ['limit-orders', 'order-rejected'],
    body: `<h2>Steps</h2>
<ol>
<li>Open <b>Portfolio</b> and select the <b>Resting</b> tab.</li>
<li>Each order shows its market, side, price, the amount <b>Remaining</b> and when it <b>Expires</b>.</li>
<li>To make an order smaller, use <b>Reduce remaining to</b> and enter the new amount.</li>
<li>To remove one order, select <b>Cancel</b>. To remove all orders on a market, select <b>Cancel market</b>; to remove everything, select <b>Cancel all</b>.</li>
</ol>
<h2>Good to know</h2>
<ul><li>Cancelling returns the money held for the order to your cash balance at once.</li><li>Orders can also be cancelled automatically, for example when a market pauses. You get a notification when that happens (see <a href="/help/notifications">notifications</a>).</li></ul>`,
  },
  'price-alerts': {
    category: 'trading', position: 60, title: 'Set a price alert',
    summary: 'Get notified when a market moves to the price you care about.',
    related: ['notifications', 'find-markets'],
    body: `<h2>Steps</h2>
<ol>
<li>Open the market and scroll to <b>Price alert</b> under the trade ticket.</li>
<li>Choose the outcome, and whether to alert when Yes is <b>above</b> or <b>below</b> a price.</li>
<li>Enter the <b>Price (₦)</b> and select <b>Add</b>.</li>
<li>To be told about any big move instead, select <b>Move alert</b> next to <b>Watch</b> at the top of the market.</li>
</ol>
${fig('price-alert.jpg', 'The Price alert form under the trade ticket', 'The price alert form.')}
<h2>Manage your alerts</h2>
<p>See and delete every alert under your name › <b>Account &amp; security</b> › <b>Price alerts</b>. Choose whether alerts reach you in the app, by email or by push in <b>Settings</b> › <b>Notifications</b> (Price movement).</p>`,
  },
  'how-markets-settle': {
    category: 'trading', position: 70, title: 'How markets settle and when you are paid',
    summary: 'Winning contracts pay ₦100 each as soon as the result is confirmed.',
    related: ['how-prices-work', 'sell-a-position', 'statements-and-documents'],
    body: `<ol>
<li><b>The market closes</b> at the time shown in its <b>Rules</b>. Trading stops.</li>
<li><b>The result is checked</b> against the settlement source named in the rules (for example an official announcement).</li>
<li><b>The market settles</b>: each winning contract pays ₦100 into your cash balance; losing contracts pay nothing. The market page shows <b>Settled at</b> with the result.</li>
<li><b>You are notified</b> (Market settlement notification) and the payout appears under <b>Your activity</b> as a Settlement.</li>
</ol>
<h2>Good to know</h2>
<ul><li>Payouts are usually within minutes of the result being confirmed. Some markets need longer when the source publishes late; the rules say so.</li><li>If a result is disputed or corrected, the market page and your activity show the change.</li><li>Settled positions move to <b>Portfolio</b> › <b>History</b>.</li></ul>`,
  },
  'trading-fees': {
    category: 'trading', position: 80, title: 'Fees explained',
    summary: 'Takers pay a small fee; resting (maker) orders and deposits are free.',
    related: ['limit-orders', 'how-prices-work'],
    body: `<ul>
<li><b>Taker fee</b>: when your order trades straight away against someone else’s waiting order, a fee is charged: a fee rate × contracts × price × (1 − price), rounded up to the next kobo per order. It is largest for prices near ₦50 and small near ₦1 or ₦99.</li>
<li><b>Maker orders</b>: a limit order that rests in the book and is filled later pays no fee.</li>
<li><b>Deposits and withdrawals</b>: free.</li>
</ul>
<h2>See the fee before you trade</h2>
<ol><li>Enter your order in the trade ticket.</li><li>Select <b>Review</b>: the review shows the fee and total before you place the order.</li></ol>
<p>The full schedule is on the <a href="/support/fees">fee schedule</a> page.</p>`,
  },

  // ------------------------------------------------------------------ Money
  'add-funds': {
    category: 'money', position: 10, title: 'Add funds (deposit)',
    summary: 'Deposit by card, bank transfer or crypto, or add demo funds.',
    related: ['how-play-money-works', 'withdraw-funds', 'trading-limits'],
    body: `<h2>Steps</h2>
<ol>
<li>Select your name at the top right, then <b>Deposit &amp; withdraw</b> (or select <b>Deposit</b> on your <b>Portfolio</b>).</li>
<li>Select <b>Deposit</b>. Under <b>How do you want to deposit?</b> choose a method:
<ul><li><b>Add a debit card</b>: instant, up to ₦250,000.</li><li><b>Link a bank account</b>: free, settles in 1–3 business days.</li><li><b>Crypto</b>: send test tokens on the sandbox chain.</li><li><b>Demo funds</b>: simulated and instant.</li></ul></li>
<li>Enter the <b>Amount</b> and select <b>Review</b>.</li>
<li>Confirm. If your card issuer asks you to confirm the payment, follow its screen.</li>
</ol>
${fig('deposit.jpg', 'The deposit page asking How do you want to deposit, with card, bank, crypto and demo options', 'Choosing a deposit method.')}
<h2>Good to know</h2>
<ul><li>Your balance shows as <b>Cash</b> in the header.</li><li>Bank deposits can be traded at once and withdrawn once settled.</li><li>Promo credits can be traded but not withdrawn.</li><li>A daily deposit limit applies if you set one (see <a href="/help/trading-limits">trading limits</a>).</li></ul>`,
  },
  'withdraw-funds': {
    category: 'money', position: 20, title: 'Withdraw funds',
    summary: 'Send your cash balance to your bank account or wallet.',
    related: ['verify-identity', 'two-factor-login', 'add-funds'],
    body: `<h2>Before you start</h2>
<ul><li>Your identity is verified (<a href="/help/verify-identity">how</a>).</li><li>Only the amount shown as <b>You can withdraw</b> can be withdrawn; credits and unsettled bank deposits cannot.</li></ul>
<h2>Steps</h2>
<ol>
<li>Select your name › <b>Deposit &amp; withdraw</b>, then <b>Withdraw</b>.</li>
<li>Under <b>Where should we send it?</b> choose <b>Link a bank account</b>, <b>Add a crypto address</b> or <b>Demo funds</b>.</li>
<li>Enter the <b>Amount</b> and select <b>Review</b>.</li>
<li>Confirm. If asked to <b>Confirm it’s you</b>, enter your two-factor code or use your passkey.</li>
</ol>
${fig('withdraw.jpg', 'The withdraw page asking Where should we send it', 'Choosing where to send a withdrawal.')}
<h2>What happens next</h2>
<ul><li>We review each withdrawal before it is sent, usually within one business day. Its status shows under <b>Recent transfers</b>.</li><li>A new bank account or address may have a short waiting period before its first withdrawal, to protect you.</li></ul>`,
  },
  'statements-and-documents': {
    category: 'money', position: 30, title: 'Download statements and your activity',
    summary: 'Yearly statements, a full activity history and CSV exports.',
    related: ['how-markets-settle', 'download-or-delete-your-data'],
    body: `<h2>Yearly statements</h2>
<ol><li>Select your name › <b>Documents</b>.</li><li>Under <b>Yearly statements</b>, choose the year and select <b>Download … transactions (CSV)</b> for that year.</li></ol>
${fig('documents.jpg', 'The Documents page with yearly statements', 'Documents › Yearly statements.')}
<h2>Your activity</h2>
<ol><li>Select your name › <b>Your activity</b>.</li><li>Filter by <b>Deposit</b>, <b>Withdrawal</b>, <b>Order</b>, <b>Trade</b>, <b>Settlement</b> or <b>Credit</b>, and select <b>Load more</b> for older items.</li></ol>
<h2>Positions and trade history</h2>
<ol><li>Open <b>Portfolio</b> › <b>History</b>.</li><li>Select <b>Export CSV</b> to download it.</li></ol>
<blockquote>Statements show realised profit and loss. They are not tax advice.</blockquote>`,
  },

  // ------------------------------------------------------------------ Account & security
  'two-factor-login': {
    category: 'account-security', position: 10, title: 'Turn on two-factor login',
    summary: 'Ask for a 6-digit code from an authenticator app every time you log in.',
    related: ['passkeys', 'secure-your-account', 'withdraw-funds'],
    body: `<h2>Before you start</h2>
<ul><li>Install an authenticator app on your phone (any app that shows 6-digit codes).</li></ul>
<h2>Steps</h2>
<ol>
<li>Select your name › <b>Account &amp; security</b>.</li>
<li>Under <b>Two-factor login</b>, select <b>Set up two-factor login</b>.</li>
<li><b>Add this key to your authenticator app</b>: scan it or type it in, or open the setup link on your phone.</li>
<li><b>Enter the code it shows</b> in the <b>6-digit code</b> box and confirm. You see <b>Two-factor login turned on</b>.</li>
<li>Recommended: tick <b>Require a two-factor code to withdraw</b> under <b>Withdrawal verification</b>.</li>
</ol>
${fig('account-security.jpg', 'The Account and security page with Password, Two-factor login and Withdrawal verification sections', 'Account & security.')}
<h2>Good to know</h2>
<ul><li>From then on, after your password you are asked for the code from your app.</li><li>Lost your phone? Contact <a href="/support/contact">support</a> from the email on your account.</li></ul>`,
  },
  passkeys: {
    category: 'account-security', position: 20, title: 'Sign in with a passkey',
    summary: 'Use your phone or computer’s fingerprint, face or PIN instead of a password.',
    related: ['two-factor-login', 'secure-your-account'],
    body: `<h2>Add a passkey</h2>
<ol>
<li>Select your name › <b>Account &amp; security</b> › <b>Identity &amp; privacy</b>.</li>
<li>Under <b>Passkeys</b>, select <b>Add a passkey</b>.</li>
<li>Follow your device’s prompt (fingerprint, face or screen lock). You see <b>Passkey added</b>.</li>
</ol>
<h2>Sign in with it</h2>
<ol><li>Go to <b>Log in</b>.</li><li>Select <b>Log in with a passkey</b> and confirm on your device.</li></ol>
<p>Remove a passkey from the same <b>Passkeys</b> list. If your browser says passkeys are not supported, use a password with two-factor login instead.</p>`,
  },
  'reset-password': {
    category: 'account-security', position: 30, title: 'Reset your password or get back in',
    summary: 'Forgot your password? Reset it by email.',
    related: ['secure-your-account', 'two-factor-login'],
    body: `<h2>Steps</h2>
<ol>
<li>Go to <b>Log in</b> and select <b>Forgot password?</b>.</li>
<li>Enter your <b>Email</b> and select <b>Send reset link</b>.</li>
<li>Open the email and select the link. It works once and expires after a short time.</li>
<li><b>Choose a new password</b>, enter it twice and save. You can now log in.</li>
</ol>
<h2>Still stuck?</h2>
<ul><li>No email? Check your spam folder, and that you typed the address you signed up with.</li><li>Lost access to your two-factor app? <a href="/support/contact">Contact support</a> from your account’s email.</li></ul>`,
  },
  'secure-your-account': {
    category: 'account-security', position: 40, title: 'Keep your account secure',
    summary: 'Change your password, review devices and sign out everywhere.',
    related: ['two-factor-login', 'passkeys', 'reset-password'],
    body: `<h2>Change your password</h2>
<ol><li>Select your name › <b>Account &amp; security</b>.</li><li>Under <b>Password</b>, enter your <b>Current password</b>, then the <b>New password</b> twice.</li><li>Select <b>Change password</b>.</li></ol>
<h2>Check where you are signed in</h2>
<ol><li>On the same page, see <b>Signed-in devices</b>.</li><li>Select <b>Sign out</b> next to a device you do not recognise, or <b>Sign out everywhere</b>.</li><li>Review <b>Security activity</b> for recent sign-ins and changes.</li></ol>
<h2>If you think someone else has access</h2>
<ol><li>Change your password and select <b>Sign out everywhere</b>.</li><li>Turn on <a href="/help/two-factor-login">two-factor login</a>.</li><li>Email <a href="/support/contact">support</a>.</li></ol>
<blockquote>Parlance staff will never ask for your password, codes or card details.</blockquote>`,
  },
  'trading-limits': {
    category: 'account-security', position: 50, title: 'Set deposit, trading and time limits',
    summary: 'Tools to help you trade within your means.',
    related: ['add-funds', 'notifications'],
    body: `<h2>Steps</h2>
<ol>
<li>Go to <a href="/account/limits">Account › Limits</a> (your name › <b>Account &amp; security</b> › <b>Account limits</b>).</li>
<li>Choose <b>Deposit limit</b> or <b>Trading limit</b> (naira per day), or <b>Daily session time</b> (minutes per day).</li>
<li>Enter the amount and select <b>Set limit</b>.</li>
</ol>
${fig('limits.jpg', 'The limits page with deposit, trading and daily session time limits', 'Account limits.')}
<h2>Good to know</h2>
<ul><li>Lowering a limit takes effect at once.</li><li>Raising or removing a limit (<b>Remove limit</b>) takes effect after a cooling-off period.</li><li>Read more about <a href="/support/responsible-trading">responsible trading</a>.</li></ul>`,
  },
  notifications: {
    category: 'account-security', position: 60, title: 'Choose your notifications',
    summary: 'Pick which alerts reach you in the app, by email or by push, and set quiet hours.',
    related: ['price-alerts', 'install-the-app'],
    body: `<h2>Steps</h2>
<ol>
<li>Select your name › <b>Settings</b>, then the <b>Notifications</b> section (or the bell › <b>Settings</b>).</li>
<li>For each kind (Transfers, Price movement, Market settlement, Order auto-cancellation, trade confirmations and more), switch <b>In-app</b>, <b>Email</b> and <b>Push</b> on or off. Changes save at once.</li>
<li>Under <b>Quiet hours</b>, tick <b>Pause email and push</b> and set <b>From</b>, <b>to</b> and your <b>Time zone</b> (West Africa Time for Nigeria).</li>
<li>Under <b>Push in this browser</b>, allow push to get alerts on this device.</li>
</ol>
${fig('notification-settings.jpg', 'The notification settings with In-app, Email and Push switches', 'Notification settings.')}
<p>Security notifications (sign-ins, password and withdrawal changes) are always sent.</p>`,
  },
  'download-or-delete-your-data': {
    category: 'account-security', position: 70, title: 'Download or delete your data',
    summary: 'Get a copy of your data or close your account.',
    related: ['statements-and-documents', 'secure-your-account'],
    body: `<h2>Download your data</h2>
<ol><li>Select your name › <b>Account &amp; security</b> › <b>Identity &amp; privacy</b>.</li><li>Under <b>Your data</b>, select <b>Download my data</b>. A file with your account, activity and settings downloads.</li></ol>
<h2>Close your account</h2>
<ol><li>Withdraw your balance and close open positions first.</li><li>On the same tab, select <b>Close account</b>.</li><li>Type <b>CLOSE</b> to confirm.</li></ol>
${fig('privacy.jpg', 'The Identity and privacy tab with Download my data and Close account', 'Identity & privacy.')}
<p>Some records are kept for the period the law requires. See the <a href="/trust/privacy">privacy policy</a>.</p>`,
  },

  // ------------------------------------------------------------------ Features
  'elections-hub': {
    category: 'features', position: 10, title: 'Use the Nigeria 2027 elections hub',
    summary: 'Follow every race, the map and your ballot in one place.',
    related: ['find-markets', 'price-alerts'],
    body: `<h2>Steps</h2>
<ol>
<li>Open <b>More</b> › <b>Elections hub</b>, or <b>Elections hub</b> in the footer. The <b>Overview</b> shows the President, Senate and House of Representatives forecasts and the seat bar.</li>
<li>Choose a tab: <b>Presidential</b>, <b>Senate</b>, <b>House</b> or <b>Governorship</b> for each race, with every candidate’s chance and the markets to trade.</li>
<li>Choose <b>States</b>, or use <b>Search states and candidates</b>, to go straight to a state. The <b>Results map</b> compares states at a glance.</li>
<li>Choose <b>My ballot</b> and pick your state, LGA and ward to see the races on your ballot.</li>
<li>Off-cycle governorship elections and international elections are in the list on the left.</li>
</ol>
${fig('elections.jpg', 'The elections hub page', 'The elections hub.')}
<blockquote>Markets reflect traders’ views, not official results. Each market’s Rules name the official source used to settle it.</blockquote>`,
  },
  'rewards-and-referrals': {
    category: 'features', position: 20, title: 'Refer a friend and use promo codes',
    summary: 'Share your code; you both earn a reward when your friend starts trading.',
    related: ['how-play-money-works', 'add-funds'],
    body: `<h2>Invite a friend</h2>
<ol>
<li>Select your name › <b>Rewards</b>.</li>
<li>Under <b>Refer a friend</b>, select <b>Invite friends</b> to share your link, or copy <b>Your code</b>.</li>
<li>When your friend signs up with it and trades the goal amount, you both get the reward. Every referral is checked first, so it can show <b>Under review</b> for a while.</li>
</ol>
${fig('rewards.jpg', 'The Rewards page with Refer a friend and Promo codes', 'Rewards.')}
<h2>Use a promo code</h2>
<ol><li>On <b>Rewards</b>, under <b>Promo codes</b>, select <b>Enter promo code</b> (also in the menu under your name).</li><li>Type the code and confirm. It adds a credit to your cash balance once.</li></ol>
<h2>Got a friend’s code after signing up?</h2>
<p>Under <b>Have a friend’s code?</b>, enter it and select <b>Add code</b>.</p>`,
  },
  'social-profile': {
    category: 'features', position: 30, title: 'Follow traders and share ideas',
    summary: 'Create a social profile, follow traders and see the leaderboard.',
    related: ['find-markets', 'secure-your-account'],
    body: `<h2>Create your profile</h2>
<ol><li>Select your name › <b>Account &amp; security</b> › <b>Social profile</b>.</li><li>Choose a <b>Nickname</b> and an optional <b>Bio</b>.</li><li>Choose whether to <b>Show my nickname on my trades and positions</b>, then select <b>Create profile</b>.</li></ol>
<h2>Follow and post</h2>
<ol><li>Open <b>Social</b> from the <b>More</b> menu.</li><li>Use <b>Find traders</b> to search by nickname, and select <b>Follow</b>.</li><li>Read <b>For you</b> or <b>Following</b>, like and reply to posts, and see the <b>Leaderboard</b> for top traders by profit or volume.</li></ol>
<blockquote>Report a post or reply that breaks the rules with its ⋯ menu › <b>Report post</b>. Moderators review every report.</blockquote>`,
  },
  'api-keys': {
    category: 'features', position: 40, title: 'Create an API key (developers)',
    summary: 'Trade from your own software with a signed API key.',
    related: ['verify-identity', 'secure-your-account'],
    body: `<h2>Before you start</h2>
<ul><li>Your identity is verified. API keys unlock once verification is approved.</li><li>Read the <a href="/docs">API docs</a>.</li></ul>
<h2>Steps</h2>
<ol>
<li>Select your name › <b>Account &amp; security</b> › <b>API keys</b>.</li>
<li>Under <b>Create a key</b>, choose what it may do, for example <b>Trade (place, change and cancel orders)</b>.</li>
<li>Choose <b>Generate an RSA key pair for me</b>, or <b>Use my own public key</b> and paste it.</li>
<li>Optional: set <b>Expires</b>. Select <b>Create key</b>.</li>
<li><b>Save your private key now</b>: select <b>Download .pem</b>. It is shown only once.</li>
</ol>
<p>Rotate or revoke keys from <b>Your keys</b> on the same page. Never share your private key.</p>`,
  },
  'real-money-waitlist': {
    category: 'features', position: 50, title: 'Join the real-money waitlist',
    summary: 'Be the first to hear when real-money trading opens in Nigeria.',
    related: ['how-play-money-works'],
    body: `<ol>
<li>Open <a href="/waitlist">Join the real-money waitlist</a>.</li>
<li>Signed in, select <b>Join with one click</b>. Otherwise enter your email and confirm it from the email we send.</li>
<li>Manage or leave the waitlist any time from the link in our emails.</li>
</ol>
<p>Real-money trading starts only once the required Nigerian licences are in place. See <a href="/trust/regulation">Regulation</a>.</p>`,
  },

  // ------------------------------------------------------------------ Troubleshooting
  'request-timed-out': {
    category: 'troubleshooting', position: 10, title: '“Request timed out” or the offline page',
    summary: 'What to do when a page does not load.',
    related: ['install-the-app', 'order-rejected'],
    body: `<h2>Try these steps in order</h2>
<ol>
<li>Check your connection: open another website. On mobile data, try Wi-Fi or move to better signal.</li>
<li>Reload the page. If you were placing an order, check <b>Portfolio</b> › <b>Resting</b> and <b>History</b> first, so you do not place it twice.</li>
<li>Turn on <b>Data saver</b> at the bottom of the page on slow connections.</li>
<li>Check the <a href="/status">Parlance status</a> page for incidents.</li>
<li>Still failing? Clear the site’s data in your browser settings, sign in again, and <a href="/support/contact">contact support</a> with the time it happened.</li>
</ol>
<blockquote>If you see the offline page, Parlance retries by itself as soon as your connection is back.</blockquote>`,
  },
  'order-rejected': {
    category: 'troubleshooting', position: 20, title: 'Why was my order rejected?',
    summary: 'Common reasons an order does not go through, and how to fix each.',
    related: ['manage-open-orders', 'trading-limits', 'add-funds'],
    body: `<ul>
<li><b>Not enough cash</b>: your balance must cover the order and its fee. <a href="/help/add-funds">Add funds</a> or lower the amount.</li>
<li><b>Market closed or paused</b>: the market page shows when trading stops. Paused markets reopen when the pause ends.</li>
<li><b>A limit was reached</b>: a trading or session-time limit you set blocks new orders until the next day. See <a href="/help/trading-limits">limits</a>.</li>
<li><b>Selling more than you hold</b>: the <b>SELL</b> ticket shows how many contracts you have.</li>
<li><b>Price moved</b>: in fast markets the price may change between review and placing. Review again, or use a <a href="/help/limit-orders">limit order</a>.</li>
<li><b>Verification needed</b>: some actions ask you to <a href="/help/verify-identity">verify your identity</a> or confirm it’s you first.</li>
</ul>
<p>The message under the trade ticket says which reason applies.</p>`,
  },
  'verification-problems': {
    category: 'troubleshooting', position: 30, title: 'Problems with identity verification',
    summary: 'No code, photos rejected or details not matching: what to do.',
    related: ['verify-identity', 'reset-password'],
    body: `<ul>
<li><b>No text message</b>: wait a minute, check your message spam folder, then select <b>Resend code</b>. Check the number, or select <b>Use a different number</b>.</li>
<li><b>Details do not match</b>: enter your legal name and date of birth exactly as on your ID, and your home address, not a business address.</li>
<li><b>Photos not accepted</b>: use good light, show all four corners of the ID, no glare, and keep your face clearly visible in the selfie.</li>
<li><b>Out of attempts</b>: the screen shows how many attempts are left. When none are left, <a href="/support/contact">contact support</a>.</li>
<li><b>QR code expired</b>: the code works once and expires in 10 minutes. Start again, or select <b>Continue on this device instead</b>.</li>
</ul>`,
  },

  // ------------------------------------------------------------------ Added 2026-11-15 (Pro terminal, 1-Click, view mode, category pages, 15-minute markets, news)
  'browse-a-category': {
    category: 'getting-started', position: 45, title: 'Browse a category page',
    summary: 'Filter a category by how often markets close, flip through featured markets and trade from the list.',
    related: ['find-markets', 'how-prices-work', 'place-your-first-trade'],
    body: `<ol>
<li>Pick a category in the strip under the header, for example <b>Economics</b> or <b>Climate</b>.</li>
<li>On the left, choose <b>All markets</b> or how often markets close (for example <b>Daily</b> or <b>Weekly</b>), then a group such as a series or a state. The number beside each shows how many markets are open.</li>
<li>At the top, the featured market shows <b>Market</b>, <b>Pays out</b> and <b>Odds</b> for its leading outcomes, with a price chart. Use ‹ › to move between featured markets (<b>1 of 3</b>).</li>
<li><b>Pays out</b> is what ₦1 returns if you are right: 2.50x means ₦2.50 back for every ₦1. Select an <b>Odds</b> button to open the trade ticket for that outcome.</li>
<li>Scroll for every market in the category. Change the order with <b>Trending</b> or <b>Volume</b>, and use <b>Frequency</b> to narrow the list.</li>
</ol>
<h2>Good to know</h2>
<ul><li><b>Climate</b> shows <b>Top cities</b> with today’s and tomorrow’s temperature markets; <b>Sports</b> shows the day’s <b>Games</b> at the top.</li><li>On a phone the groups on the left become a row you can scroll.</li><li>Some categories show a short banner; select <b>Dismiss</b> to hide it.</li></ul>`,
  },
  'one-click-trading': {
    category: 'trading', position: 25, title: 'Trade with 1-Click',
    summary: 'Place orders straight from the ticket, without the review step. Off until you turn it on.',
    related: ['place-your-first-trade', 'use-the-pro-terminal', 'trading-limits'],
    body: `<p>Every order shows a review step first. If you trade often you can turn that step off. It stays off until you choose otherwise, and it applies to the trade ticket and the Pro terminal alike.</p>
<h2>Turn it on</h2>
<ol>
<li>Open any market and, in the trade ticket, open the <b>NAIRA ▾</b> menu.</li>
<li>Switch on <b>Submit order with 1-Click</b>.</li>
<li>Read the confirmation and select <b>Turn on 1-Click</b>. You are asked only the first time.</li>
<li>The main button now reads <b>⚡ Buy with 1-Click</b> (or <b>⚡ Sell with 1-Click</b>): one press places the order.</li>
</ol>
<h2>Turn it off</h2>
<ol><li>Open the <b>NAIRA ▾</b> menu again and switch <b>Submit order with 1-Click</b> off. The review step is back at once.</li></ol>
<blockquote>Your limits, identity checks and security confirmations still apply to every order. If the switch is missing, the exchange has turned 1-Click off for everyone and every order is reviewed.</blockquote>`,
  },
  'use-the-pro-terminal': {
    category: 'features', position: 5, title: 'Use the Pro terminal',
    summary: 'A screener, order book, charts and a fast ticket on one screen, for active traders.',
    related: ['one-click-trading', 'choose-your-home-view', 'limit-orders'],
    body: `<p>Open <b>Pro</b> in the top menu. The terminal puts everything for active trading on one screen: <b>Screener</b>, <b>Chart</b>, <b>Order book</b>, <b>Quick ticket</b>, <b>Open orders</b>, <b>Positions</b>, <b>Recent trades</b> and <b>Price alerts</b>.</p>
<h2>Find markets with the screener</h2>
<ol>
<li>Choose a <b>Category</b>, when markets <b>Close</b> (for example <b>Within 7 days</b>), a <b>Min volume</b>, a <b>Max spread</b> and a <b>Min 24h move</b>, then select <b>Apply</b>.</li>
<li>Sort by any column (Bid, Ask, Last, 24h, Volume, Spread, Closes) by selecting its heading.</li>
<li>To keep the filters, enter a <b>Screen name</b> and select <b>Save screen</b>. Pick it again later from the saved screens list.</li>
</ol>
<h2>Trade</h2>
<ol>
<li>Select a market in the screener. The chart, order book and ticket switch to it.</li>
<li>In the <b>Order book</b>, select a price to load the <b>Quick ticket</b> at that price.</li>
<li>Choose <b>Buy</b> or <b>Sell</b>, <b>Yes</b> or <b>No</b>, <b>Limit</b> or <b>Market</b>, and the number of <b>Contracts</b>.</li>
<li>Select <b>Review</b>, check the order, and place it. With <a href="/help/one-click-trading">one-click trading</a> on, the order is placed at once.</li>
</ol>
<h2>Keyboard shortcuts</h2>
<ul><li><b>B</b> buy, <b>S</b> sell, <b>Y</b> / <b>N</b> side, <b>Enter</b> review, <b>Esc</b> cancel. Shortcuts pause while you type in a field.</li></ul>
<h2>Arrange the screen</h2>
<ol><li>Drag a panel by its handle, or select <b>Layout</b> to move or hide panels.</li><li>Select <b>Reset layout</b> to start again. Your layout and saved screens follow you to any browser you sign in on.</li></ol>`,
  },
  'choose-your-home-view': {
    category: 'account-security', position: 65, title: 'Choose Prediction or Trader view',
    summary: 'Decide what the home address opens: featured markets and news, or the Pro terminal.',
    related: ['use-the-pro-terminal', 'notifications'],
    body: `<ol>
<li>On the home page, find <b>Customize your view</b> on the right (or go to your name › <b>Settings</b> › <b>Home view</b>).</li>
<li>Choose <b>Prediction</b> for the home page with featured markets, odds and news.</li>
<li>Or choose <b>Trader</b>: the home address opens the Pro terminal and the trade ticket starts on limit orders.</li>
<li>The choice is saved at once and follows you to other browsers. Change it back the same way any time.</li>
</ol>`,
  },
  'fifteen-minute-markets': {
    category: 'trading', position: 65, title: 'Trade 15-minute markets',
    summary: 'Will the price be above or below the target when the window closes? A new window opens every 15 minutes.',
    related: ['how-prices-work', 'how-markets-settle', 'one-click-trading'],
    body: `<ol>
<li>On the home page, find <b>15 Min Markets</b>. The red timer shows when the current window closes.</li>
<li>Each card shows the <b>Target</b> and how far the price is above or below it right now.</li>
<li>Select <b>Above · N%</b> if you think the price will finish above the target, or <b>Below · N%</b> if below. N% is the market’s chance.</li>
<li>Choose an amount in the ticket and place the order.</li>
<li>When the window closes the market settles at once on the price at that moment, and a new window opens.</li>
</ol>
<blockquote>These markets move fast. Set a <a href="/help/trading-limits">trading limit</a> if you want a ceiling on what you spend each day.</blockquote>`,
  },
  'market-news-and-notes': {
    category: 'features', position: 60, title: 'Read market news and notes',
    summary: 'Headlines from Nigerian publishers and Parlance’s notes on each market, reviewed before they appear.',
    related: ['how-prices-work', 'how-markets-settle', 'find-markets'],
    body: `<ol>
<li>Open a market and scroll to <b>About this market</b> for its description, <b>Background</b> and <b>Resolution notes</b>.</li>
<li>Under the news list, each headline names its publisher. Select it to <b>Read the full story at</b> the publisher’s own site; it opens in a new tab.</li>
<li>Category pages show <b>In the news</b> with the latest headlines for that category and the markets they relate to.</li>
</ol>
<blockquote>News and notes are context, not advice. Every headline and note is reviewed by the Parlance team before it appears, and the market’s <b>Rules</b> alone decide how it settles.</blockquote>`,
  },
};

// The help/<slug> CMS page defaults (merged into server/content/pages.js PAGES).
const HELP_PAGES = Object.fromEntries(Object.entries(GUIDES).map(([slug, g]) => [`help/${slug}`, {
  section: 'help', title: g.title, seo_title: `${g.title} · Parlance Help`, seo_description: g.summary,
  category: g.category, summary: g.summary, position: g.position, related: g.related || [], body: g.body.replace(/\n/g, ''),
}]));

module.exports = { CATEGORIES, HELP_PAGES };
