'use strict';
// Developer portal prose: the code defaults of the CMS pages under docs/* (CLONE_SPEC.md §35.9, §32.7). On first start
// server/dev-portal.js publishes each one through the CMS store as version 1, so an admin edits, publishes and rolls them
// back in Admin › Content › Pages like any other page; only the generated reference (OpenAPI, AsyncAPI, FIX message
// tables) comes from code. Bodies are the CMS 'page' allowlist (headings, paragraphs, lists, links, pre/code); code
// samples are HTML-escaped text. The JavaScript and Python samples are run by tests/dev-portal.e2e.test.js.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const code = (s) => `<pre><code>${esc(s.trim())}</code></pre>`;

const CURL = String.raw`
# Sign: base64( RSA-PSS-SHA256( timestamp + METHOD + path ) ), salt length 32
TS=$(date +%s%3N)
PATH_ONLY=/trade-api/v2/portfolio/balance
SIG=$(printf '%s' "$TS"GET"$PATH_ONLY" | openssl dgst -sha256 -sign key.pem \
  -sigopt rsa_padding_mode:pss -sigopt rsa_pss_saltlen:32 | base64 -w0)
curl -s "$PARLANCE_API_BASE$PATH_ONLY" \
  -H "PARLANCE-ACCESS-KEY: $PARLANCE_KEY_ID" \
  -H "PARLANCE-ACCESS-TIMESTAMP: $TS" \
  -H "PARLANCE-ACCESS-SIGNATURE: $SIG"
`;

const JS = String.raw`
// Node.js 18+, no dependencies. Usage:
//   PARLANCE_API_BASE=http://localhost:3000 PARLANCE_KEY_ID=plxk_... PARLANCE_PRIVATE_KEY_PATH=key.pem node balance.js
const crypto = require('node:crypto');
const fs = require('node:fs');

const base = process.env.PARLANCE_API_BASE;
const keyId = process.env.PARLANCE_KEY_ID;
const key = crypto.createPrivateKey(fs.readFileSync(process.env.PARLANCE_PRIVATE_KEY_PATH));

function sign(method, path) {
  const ts = String(Date.now());
  const msg = ts + method + path.split('?')[0];
  const sig = key.asymmetricKeyType === 'ed25519'
    ? crypto.sign(null, Buffer.from(msg), key)
    : crypto.sign('sha256', Buffer.from(msg), { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
  return { 'PARLANCE-ACCESS-KEY': keyId, 'PARLANCE-ACCESS-TIMESTAMP': ts, 'PARLANCE-ACCESS-SIGNATURE': sig.toString('base64') };
}

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { ...sign(method, path), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

call('GET', '/trade-api/v2/portfolio/balance').then((r) => console.log(JSON.stringify(r)));
`;

const PY = String.raw`
# Python 3.9+ with the "cryptography" package. Usage:
#   PARLANCE_API_BASE=http://localhost:3000 PARLANCE_KEY_ID=plxk_... PARLANCE_PRIVATE_KEY_PATH=key.pem python3 balance.py
import base64, json, os, time, urllib.request
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, ed25519

BASE = os.environ["PARLANCE_API_BASE"]
KEY_ID = os.environ["PARLANCE_KEY_ID"]
with open(os.environ["PARLANCE_PRIVATE_KEY_PATH"], "rb") as f:
    KEY = serialization.load_pem_private_key(f.read(), password=None)

def sign(method, path):
    ts = str(int(time.time() * 1000))
    msg = (ts + method + path.split("?")[0]).encode()
    if isinstance(KEY, ed25519.Ed25519PrivateKey):
        sig = KEY.sign(msg)
    else:
        sig = KEY.sign(msg, padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=32), hashes.SHA256())
    return {"PARLANCE-ACCESS-KEY": KEY_ID, "PARLANCE-ACCESS-TIMESTAMP": ts, "PARLANCE-ACCESS-SIGNATURE": base64.b64encode(sig).decode()}

def call(method, path):
    req = urllib.request.Request(BASE + path, method=method, headers=sign(method, path))
    try:
        with urllib.request.urlopen(req) as res:
            return {"status": res.status, "body": json.loads(res.read())}
    except urllib.error.HTTPError as e:
        return {"status": e.code, "body": json.loads(e.read())}

print(json.dumps(call("GET", "/trade-api/v2/portfolio/balance")))
`;

const WS = String.raw`
// Node.js with the "ws" package: the upgrade request is signed like REST (method GET, the WebSocket path).
const ws = new WebSocket('ws://localhost:3000/trade-api/ws/v2', { headers: sign('GET', '/trade-api/ws/v2') });
ws.on('open', () => ws.send(JSON.stringify({ id: 1, cmd: 'subscribe', params: { channels: ['orderbook_delta', 'fill'], market_ticker: 'PLXSNOW-26DEC-T10' } })));
ws.on('message', (m) => console.log(String(m)));
`;

const FIX_LOGON = String.raw`
8=FIX.4.4|9=...|35=A|49=MYFIRM|56=PARLANCE|34=1|52=20261108-10:00:00.000|98=0|108=30|141=Y|553=plxk_...|95=344|96=<base64 signature>|10=...|
signed text = "20261108-10:00:00.000" SOH "A" SOH "1" SOH "MYFIRM" SOH "PARLANCE"   (SOH = 0x01)
`;

const DOCS_PAGES = {
  'docs/welcome': {
    section: 'info', title: 'Welcome to the Parlance API', seo_title: 'API documentation · Parlance', seo_description: 'Build on Parlance Exchange: REST, WebSocket and FIX APIs for event contracts and perpetual futures.',
    body: `<p>The Parlance Exchange API gives programs the same markets people trade on the website: real-time market data and order entry for <strong>event contracts</strong> (Predictions) and <strong>perpetual futures</strong> (Perps). Everything here is a sandbox: balances, deposits and payouts are simulated.</p>
<h2>Start here</h2><ul><li><a href="/docs/quick-start">Quick Start</a>: create an API key, sign your first request.</li><li><a href="/docs/concepts">Concepts</a>: prices, quantities, cursors, errors, rate limits.</li><li><a href="/docs/demo">Demo environment</a>: try every call with play money, right from these pages.</li></ul>
<p>Using the API means you accept the <a href="/docs/agreement">Developer Agreement</a>. Service health is on the <a href="/status">status page</a>.</p>`,
  },
  'docs/quick-start': {
    section: 'info', title: 'Quick Start', seo_title: 'Quick Start · Parlance API', seo_description: 'Create an API key and sign your first request in curl, Python or JavaScript.',
    body: `<h2>1. Create an API key</h2><p>Open <a href="/account/api-keys">Account › API keys</a> (identity verification and a password check are required). Either let us generate an RSA key pair — the private key is shown <strong>once</strong>, save it — or paste your own RSA or Ed25519 public key. Pick scopes: <code>read</code>, <code>trade</code> (order entry) and <code>perps</code> (the margin product). You can limit a key to IP addresses and give it an expiry.</p>
<h2>2. Sign every request</h2><p>Send three headers: <code>PARLANCE-ACCESS-KEY</code> (the key id), <code>PARLANCE-ACCESS-TIMESTAMP</code> (now, in milliseconds) and <code>PARLANCE-ACCESS-SIGNATURE</code>: base64 of a signature over <code>timestamp + METHOD + path</code>, where path has no query string. RSA keys sign with RSA-PSS, SHA-256 and a 32-byte salt; Ed25519 keys sign with Ed25519. Requests more than 5 seconds old or 1 second in the future are refused, and a signed state-changing request cannot be replayed.</p>
<h3>curl</h3>${code(CURL)}
<h3>Python</h3>${code(PY)}
<h3>JavaScript (Node.js 18+)</h3>${code(JS)}
<h3>WebSocket</h3>${code(WS)}
<h2>3. Try it on the demo</h2><p>Every reference page has a <strong>Try it</strong> panel that signs requests in your browser against the demo environment (<code>/demo-api/trade-api/v2</code>) with a demo key whose private key never leaves your browser.</p>`,
  },
  'docs/concepts': {
    section: 'info', title: 'Concepts', seo_title: 'Concepts · Parlance API', seo_description: 'Prices, quantities, cursors, errors, idempotency and rate limits.',
    body: `<h2>Prices and quantities</h2><p>Prices are dollar strings with four decimals (<code>"0.4500"</code>); request bodies also accept whole cents (<code>yes_price: 45</code>). Quantities are fixed-point strings with two decimals (<code>count_fp: "2.50"</code>) on markets that allow fractions. A YES and a NO contract on the same market always add up to $1.</p>
<h2>Pagination</h2><p>Lists return an opaque <code>cursor</code>; pass it back to get the next page. An empty cursor means there are no more results. History endpoints also take <code>min_ts</code> and <code>max_ts</code> (unix seconds).</p>
<h2>Errors</h2><p>Errors use <code>{"error":{"code","message","details"}}</code>. A query parameter that cannot be parsed, or is out of range, answers <code>{"msg": "..."}</code> instead. Authentication failures are <code>401 token_authentication_failure</code> with a <code>reason</code> (for example <code>clock_skew</code>, <code>invalid_signature</code>, <code>replayed_request</code>, <code>key_revoked</code>); a missing scope or a refused IP address is <code>403</code>; a rate limit is <code>429</code> with a <code>Retry-After</code> header.</p>
<h2>Idempotency</h2><p>Send an <code>Idempotency-Key</code> header on order creation to make retries safe: the same key with the same body returns the first response.</p>
<h2>Rate limits</h2><p>Each key has a tier with separate read and write budgets in tokens per second; most endpoints cost 10 tokens. See <a href="/docs/rate-limits">Rate limits</a>, or ask the API: <code>GET /trade-api/v2/account/limits</code> and <code>/account/endpoint_costs</code>.</p>
<h2>The same rules as the website</h2><p>Orders sent through the API pass the same checks as the website: feature switches, play-mode money controls, identity verification, your own trading and session limits, and account locks.</p>`,
  },
  'docs/predictions': {
    section: 'info', title: 'Predictions APIs', seo_title: 'Predictions APIs · Parlance', seo_description: 'REST, WebSocket and FIX for event contracts.',
    body: `<p>Event contracts pay $1 when their outcome happens. Market data needs no key; portfolio and order endpoints need a key with the <code>read</code> or <code>trade</code> scope. Order entry: create, amend (price or size), decrease (keeps queue priority), cancel, and batches of up to 20 orders with a result per order. <strong>Order groups</strong> cap the contracts filled across a set of orders: when the limit is reached, every resting order in the group is canceled until you reset it.</p>
<p>The WebSocket at <code>/trade-api/ws/v2</code> streams the order book (a snapshot, then deltas with a contiguous <code>seq</code>), tickers, trades and market lifecycle, plus your fills, orders, order groups and positions. FIX order entry and drop copy are described under <a href="/docs/fix">FIX</a>.</p>`,
  },
  'docs/perps': {
    section: 'info', title: 'Perps APIs', seo_title: 'Perps APIs · Parlance', seo_description: 'REST, WebSocket and FIX for perpetual futures.',
    body: `<p>Perpetual futures trade under <code>/trade-api/v2/margin</code>. Market data is public; balances, positions and orders need a key with the <code>perps</code> scope (and <code>trade</code> to place orders). Orders take a side (<code>bid</code> / <code>ask</code>), a price in dollars, a count, a leverage and a subaccount. The WebSocket at <code>/trade-api/ws/v2/margin</code> carries the same channels as Predictions plus your collateral (<code>account</code>). Funding, margin tiers and liquidation work as on the website.</p>`,
  },
  'docs/fix': {
    section: 'info', title: 'FIX', seo_title: 'FIX gateway · Parlance', seo_description: 'FIX 4.4 order entry, market data, RFQ and drop copy.',
    body: `<h2>Connectivity</h2><p>FIX 4.4 over TCP (tag=value, SOH-delimited). The gateway is switched on by the exchange; its host and port are shown on the <a href="/status">status page</a>. Use <code>TargetCompID=PARLANCE</code> for order entry, market data and RFQ, and <code>PARLANCEDC</code> for a read-only <strong>drop copy</strong> that receives every execution report for your orders, whichever channel placed them.</p>
<h2>Authentication and sessions</h2><p>The Logon (35=A) carries your API key id in <code>553 Username</code> and, in <code>96 RawData</code>, the base64 signature over SendingTime, MsgType, MsgSeqNum, SenderCompID and TargetCompID joined with SOH. <code>141=Y</code> resets both sequence numbers to 1; otherwise sequence numbers continue across reconnects. Gaps are filled with ResendRequest and SequenceReset-GapFill.</p>${code(FIX_LOGON)}
<h2>Order entry</h2><p>NewOrderSingle (D), OrderCancelRequest (F), OrderCancelReplaceRequest (G) and OrderMassCancelRequest (q), answered with ExecutionReport (8), OrderCancelReject (9) and OrderMassCancelReport (r). Predictions use <code>55=</code> the market ticker, <code>54=1</code> buy or <code>2</code> sell, and <code>20001=Y</code> or <code>N</code> for the contract side, with <code>44</code> the price of that side in dollars. Perps use the perps ticker, <code>54=1</code> long or <code>2</code> short, <code>1 Account</code> for the subaccount and <code>20002</code> for leverage.</p>
<h2>Market data and RFQ</h2><p>MarketDataRequest (V) answers with a snapshot (W) and, when subscribed, incremental refreshes (X). A QuoteRequest (R) opens an RFQ; quotes arrive as Quote (S) messages. Unsupported messages get a BusinessMessageReject (j). The generated message tables below list every tag.</p>`,
  },
  'docs/rate-limits': {
    section: 'info', title: 'Rate limits', seo_title: 'Rate limits · Parlance API', seo_description: 'API rate tiers, token costs and connection caps.',
    body: '<p>Every key belongs to a tier. Reads and writes have separate token buckets that refill every second; the bucket holds one second of budget. Most requests cost 10 tokens, cancels cost 2, and a batch costs its per-order cost times the number of orders. Tiers also cap open WebSocket connections and FIX sessions per key. When a bucket is empty the API answers 429 with a Retry-After header. Ask support to move a key to a higher tier.</p>',
  },
  'docs/demo': {
    section: 'info', title: 'Demo environment', seo_title: 'Demo environment · Parlance API', seo_description: 'A separate exchange with play money for testing your integration.',
    body: '<p>The demo environment is a separate exchange with its own database, users, keys and play money. Its REST base is <code>/demo-api/trade-api/v2</code> and its WebSockets are under <code>/demo-api/trade-api/ws/v2</code>. Demo keys only work there and production keys never do. Sign the full path you request, including <code>/demo-api</code>. Demo accounts start with play money in Predictions and Perps; data may be reset at any time.</p>',
  },
  'docs/changelog': {
    section: 'info', title: 'Changelog', seo_title: 'Changelog · Parlance API', seo_description: 'API changes and the deprecation policy.',
    body: `<h2>2026-11-08 — Trade API v2</h2><ul><li>Added: signed API keys (RSA-PSS and Ed25519), scopes, IP allowlists, rate tiers, <code>/account/limits</code> and <code>/account/endpoint_costs</code>.</li><li>Added: batch create and cancel, amend and decrease, order groups, history with cursors, RFQ and multivariate collections, Perps under <code>/margin</code>.</li><li>Added: the public WebSocket (<code>/trade-api/ws/v2</code> and <code>/margin</code>), the FIX 4.4 gateway and the demo environment.</li></ul>
<h2>Deprecation policy</h2><p>We announce a breaking change here at least 90 days before it ships, keep the old behaviour working for that period, and mark deprecated fields and endpoints in the reference. Additive changes (new endpoints, new optional fields, new enum values) can ship at any time: clients should ignore fields they do not know.</p>`,
  },
  'docs/agreement': {
    section: 'legal', title: 'Developer Agreement', seo_title: 'Developer Agreement · Parlance', seo_description: 'The terms for using the Parlance API.',
    body: `<h2>Using the API</h2><p>The API is offered for building tools on the Parlance Exchange sandbox. You are responsible for every request signed with your keys. Keep private keys secret, use IP allowlists where you can, and revoke a key you think is exposed.</p>
<h2>Fair use</h2><ul><li>Stay within your rate tier; do not try to get around rate limits with several accounts.</li><li>Do not test the security of the service except through a disclosed program.</li><li>Do not present data from the API as coming from anyone other than Parlance.</li></ul>
<h2>Changes and suspension</h2><p>We may change the API under the deprecation policy in the <a href="/docs/changelog">changelog</a>, and may suspend keys that break these terms. Nothing here is investment advice. See also the <a href="/legal/terms">terms of service</a>.</p>`,
  },
};

module.exports = { DOCS_PAGES, SAMPLES: { js: JS, python: PY, curl: CURL } };
