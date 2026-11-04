'use strict';
// Central request validation (PLAN P1.8): per-route JSON body size limits and declarative body schemas for the
// highest-risk write routes. Handlers keep their own semantic checks (and error messages); these schemas stop type
// confusion (objects/arrays where strings or numbers are expected), oversized strings and unexpected body shapes before
// any handler code runs.
//
// Wiring (server/app.js): `app.use(jsonBody())` replaces the single global express.json(), and
// `v1.use(validateRoutes({ rolesOf }))` runs the schema table below for every /v1 request.
const express = require('express');
const { ApiError } = require('./util');

// ------------------------------------------------------------------------------------------------ body size limits
// First match wins; paths are the full request path. Anything not listed keeps the previous global limit.
const DEFAULT_LIMIT = '64kb';
const BODY_LIMITS = [
  [/^\/v1\/(users\/[^/]+\/docv\/documents|docv\/handoff\/documents)$/, '9mb'], // one ID photo, base64 (Phase 3, server/docv.js)
  [/^\/v1\/users\/[^/]+\/(deposits|withdrawals)$/, '1kb'],
  [/^\/v1\/perps\/transfers$/, '1kb'],
  [/^\/v1\/(log_in|log_in_mfa|log_out|client_token)$/, '4kb'],
  [/^\/v1\/users$/, '4kb'],
  [/^\/v1\/users\/[^/]+\/orders(\/[^/]+\/(amend|decrease))?$/, '4kb'],
  [/^\/v1\/perps\/(orders|positions\/[^/]+\/(close|exit_trigger))$/, '4kb'],
  [/^\/v1\/communications\//, '8kb'],
  [/^\/v1\/users\/[^/]+\/chat\//, '4kb'],
  [/^\/v1\/users\/[^/]+\/social\//, '8kb'],
  [/^\/v1\/users\/[^/]+\/groups\b/, '8kb'], // group chats (Phase 2, server/groups.js)
  [/^\/v1\/users\/[^/]+\/(mfa|notifications|push_subscriptions)\b/, '4kb'], // push_subscriptions: Web Push (CLONE_SPEC §31)
  [/^\/v1\/admin\/catalog\/import$/, '256kb'], // CSV import: a few hundred rows
  [/^\/v1\/admin\/cms\/media$/, '12mb'], // one image upload, base64 (CMS media library, CLONE_SPEC.md §32.6)
  [/^\/v1\/admin\/cms\/import$/, '8mb'], // a full content export
  [/^\/v1\/admin\//, '64kb'],
];
const limitFor = (p) => (BODY_LIMITS.find(([re]) => re.test(p)) || [null, DEFAULT_LIMIT])[1];
// Paths that read their own raw body (server/payments.js): the card tokenizer (a card number must never sit in a shared
// parser's error object) and provider webhooks (the HMAC covers the exact bytes).
const RAW_BODY = /^\/v1\/payments\/(tokenize\/card|webhooks\/[^/]+)$/;
BODY_LIMITS.unshift([/^\/v1\/users\/[^/]+\/(debit|bank_link|banks|crypto)\//, '2kb']);

function jsonBody() {
  const parsers = new Map();
  const parserFor = (limit) => {
    if (!parsers.has(limit)) parsers.set(limit, express.json({ limit }));
    return parsers.get(limit);
  };
  return (req, res, next) => {
    if (req.method === 'POST' && RAW_BODY.test(req.path)) return next();
    const limit = limitFor(req.path);
    parserFor(limit)(req, res, (err) => {
      if (err && err.type === 'entity.too.large') return next(new ApiError(413, 'payload_too_large', 'request body too large', `this endpoint accepts at most ${limit}`));
      next(err);
    });
  };
}

// ------------------------------------------------------------------------------------------------ schemas
// Field spec: { type: 'string'|'number'|'integer'|'boolean'|'object'|'array' or a list of them, required, nullable,
//               maxLen (strings), min/max (numbers), enum, pattern, maxItems (arrays) }.
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

class ValidationError extends ApiError {
  constructor(fields) {
    super(400, 'validation_failed', 'validation failed', Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('; '));
    this.fields = fields;
  }
  toJSON() { return { error: { code: this.code, message: this.message, details: this.details, fields: this.fields } }; }
}

function checkField(v, spec) {
  if (v === null) return spec.nullable ? null : 'must not be null';
  const types = [].concat(spec.type || []);
  const t = typeOf(v);
  const okType = !types.length || types.some((x) => x === t || (x === 'integer' && t === 'number' && Number.isInteger(v)));
  if (!okType) return `must be ${types.join(' or ')}`;
  if (t === 'number' && !Number.isFinite(v)) return 'must be a finite number';
  if (t === 'string') {
    if (spec.maxLen != null && v.length > spec.maxLen) return `must be at most ${spec.maxLen} characters`;
    if (spec.pattern && !spec.pattern.test(v)) return 'has an invalid format';
  }
  if (t === 'number') {
    if (spec.min != null && v < spec.min) return `must be at least ${spec.min}`;
    if (spec.max != null && v > spec.max) return `must be at most ${spec.max}`;
  }
  if (t === 'array' && spec.maxItems != null && v.length > spec.maxItems) return `must have at most ${spec.maxItems} items`;
  if (spec.enum && !spec.enum.includes(v)) return `must be one of ${spec.enum.join(', ')}`;
  if (spec.items && t === 'array') {
    for (const it of v) { const e = checkField(it, spec.items); if (e) return `items ${e}`; }
  }
  return null;
}

// Validate `body` against `schema`. Options: unknown ('ignore' | 'reject'), maxKeys.
function check(body, schema, { unknown = 'ignore', maxKeys = 32 } = {}) {
  if (body === undefined) body = {};
  if (typeOf(body) !== 'object') throw new ValidationError({ body: 'must be a JSON object' });
  const keys = Object.keys(body);
  if (keys.length > maxKeys) throw new ValidationError({ body: `must have at most ${maxKeys} fields` });
  const errs = {};
  for (const [k, spec] of Object.entries(schema)) {
    const present = Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined;
    if (!present) { if (spec.required) errs[k] = 'is required'; continue; }
    const e = checkField(body[k], spec);
    if (e) errs[k] = e;
  }
  if (unknown === 'reject') for (const k of keys) if (!schema[k]) errs[k] = 'is not an accepted field';
  if (Object.keys(errs).length) throw new ValidationError(errs);
  return body;
}

const S = (maxLen = 64) => ({ type: 'string', maxLen });
const NUMISH = { type: ['number', 'string'], maxLen: 32 }; // amounts and counts accept "1.50" strings (fixed-point)
const ID = { type: 'string', maxLen: 64, pattern: /^[A-Za-z0-9_.:-]+$/ };
// Time-in-force values accepted by the handlers (perps.js TIF map; Kalshi API spellings for event contracts).
const TIF = { type: 'string', enum: ['gtc', 'ioc', 'fok', 'good_till_canceled', 'immediate_or_cancel', 'fill_or_kill'] };
const FLAG = { type: ['boolean', 'string', 'number'], maxLen: 8 };

const SCHEMAS = {
  order: {
    ticker: S(64), side: S(8), action: S(8), type: S(16), time_in_force: TIF,
    count: NUMISH, count_fp: NUMISH, price: { type: ['number', 'string'], maxLen: 16, nullable: true }, price_dollars: NUMISH, yes_price: NUMISH, no_price: NUMISH,
    amount_dollars: NUMISH, client_order_id: { ...S(64), nullable: true }, expiration_time: { type: ['string', 'number'], maxLen: 64, nullable: true },
    post_only: FLAG, reduce_only: FLAG,
  },
  amend: { price: NUMISH, price_dollars: NUMISH, count: NUMISH, count_fp: NUMISH, remaining_count: NUMISH, remaining_count_fp: NUMISH, reduce_by: NUMISH, reduce_by_fp: NUMISH, reduce_to: NUMISH, reduce_to_fp: NUMISH, expiration_time: { type: ['string', 'number'], maxLen: 64, nullable: true } },
  // method_id: a payment rail (server/payments.js); without it the demo-funds method.
  money: { amount_dollars: { type: ['number', 'string'], maxLen: 16, required: true }, method_id: { type: 'string', maxLen: 64, pattern: /^[A-Za-z0-9_.:-]+$/ } },
  perpsTransfer: { direction: S(16), source: S(32), destination: S(32), amount_dollars: NUMISH, amount: NUMISH, client_transfer_id: { ...ID, nullable: true } },
  perpsOrder: {
    ticker: S(64), side: S(8), action: S(8), direction: S(16), type: S(16), time_in_force: TIF, count: NUMISH, count_fp: NUMISH, price: NUMISH, price_dollars: NUMISH, leverage: NUMISH,
    client_order_id: { ...S(64), nullable: true }, reduce_only: FLAG, post_only: FLAG,
    take_profit: { type: ['object', 'number', 'string'], nullable: true, maxLen: 32 }, stop_loss: { type: ['object', 'number', 'string'], nullable: true, maxLen: 32 },
    expiration_time: { type: ['string', 'number'], maxLen: 64, nullable: true },
  },
  perpsClose: { percent: { type: ['number', 'string'], maxLen: 16 } },
  rfqAccept: { accepted_side: S(8) },
  // Phase 5A (CLONE_SPEC.md §28): RFQ quotes on the finer grid with the HVM last look; resolution desk writes.
  rfqQuote: { rfq_id: ID, yes_bid: NUMISH, no_bid: NUMISH, contracts_fp: NUMISH, rest_remainder: FLAG, hvm: { type: 'boolean' } },
  adminResolve: { result: { type: 'string', enum: ['yes', 'no'] }, expiration_value: NUMISH, source_note: { type: 'string', maxLen: 1000 }, settlement_delay_sec: { type: ['number', 'string'], maxLen: 16 } },
  adminCorrect: { result: { type: 'string', enum: ['yes', 'no'] }, expiration_value: NUMISH, reason: { type: 'string', maxLen: 1000 } }, // required-ness is the handler's (authorization errors keep precedence)
  adminApproval: { note: { type: 'string', maxLen: 500 } },
  adminResolutionPolicy: { two_person_rule: { type: 'boolean' } },
  // A post, reply or chat message may be a sticker alone (PLAN P2.2): the handlers require a body or a sticker_id.
  socialPost: { body: { type: 'string', maxLen: 2000, nullable: true }, event_ticker: { ...S(64), nullable: true }, sticker_id: { ...S(40), nullable: true }, position: { type: 'object', nullable: true }, visibility: S(16) },
  socialComment: { body: { type: 'string', maxLen: 2000, nullable: true }, sticker_id: { ...S(40), nullable: true } },
  chatMessage: { body: { type: 'string', maxLen: 2000, nullable: true }, reply_to: { ...S(64), nullable: true }, sticker_id: { ...S(40), nullable: true } },
  report: { kind: S(16), id: S(64), reason: { type: 'string', maxLen: 1000 } },
  // Admin catalog has its own per-field validator (admin.js check()/FieldError); this only bounds the shape.
  adminCatalog: {},
  // Payment rails (server/payments.js, CLONE_SPEC.md §26). Card numbers never reach these routes (tokenizer only).
  cardPayment: { card_id: ID, token: { ...ID, maxLen: 80 }, session_id: ID, amount_dollars: { type: ['number', 'string'], maxLen: 16, required: true }, label: { type: 'string', maxLen: 40 } },
  cardPayout: { card_id: { ...ID, required: true }, amount_dollars: { type: ['number', 'string'], maxLen: 16, required: true } },
  bankMove: { bank_id: { ...ID, required: true }, amount_dollars: { type: ['number', 'string'], maxLen: 16, required: true } },
  cryptoPayout: { wallet_id: { ...ID, required: true }, amount_dollars: { type: ['number', 'string'], maxLen: 16, required: true } },
  bankLink: { institution_id: { ...ID, required: true }, username: { type: 'string', maxLen: 64, required: true }, password: { type: 'string', maxLen: 64, required: true } },
  bankAccount: { link_id: { ...ID, required: true }, account_id: { ...ID, required: true }, label: { type: 'string', maxLen: 40 } },
  cryptoAccount: { accept_terms: { type: 'boolean', required: true } },
  cryptoWallet: { address: { type: 'string', maxLen: 80, required: true }, network: { type: 'string', maxLen: 16 }, label: { type: 'string', maxLen: 40 } },
  cryptoSimulate: { amount_dollars: { type: ['number', 'string'], maxLen: 16, required: true } },
  paymentChallenge: { result: { type: 'string', enum: ['approve', 'fail'], required: true } },
  // Web Push subscriptions (server/webpush.js, CLONE_SPEC.md §31): PushSubscription.toJSON() with snake_case expiry.
  // The handler checks the endpoint (https, known push service) and the key encodings and lengths.
  pushSubscribe: { endpoint: { type: 'string', maxLen: 2048, required: true }, keys: { type: 'object', required: true }, expiration_time: { type: 'number', nullable: true }, label: { type: 'string', maxLen: 60 } },
  pushUnsubscribe: { endpoint: { type: 'string', maxLen: 2048, required: true } },
  empty: {},
  // Admin › Settings › Currency & defaults (server/admin.js, CLONE_SPEC.md §30); nested objects are checked by the handler.
  adminCurrency: { display_currency: { type: 'object' }, account_defaults: { type: 'object' }, reason: { type: 'string', maxLen: 500 } }, // reason required by the handler (authorization errors keep precedence)
};

// Route table: method, path relative to /v1, schema, options, who is validated ('owner' = signed-in user acting on
// their own /users/:uid path; 'staff' = signed-in user with any admin role). Requests that will be rejected by the
// route's own auth (anonymous, another user's uid, non-staff on admin routes) skip validation, so authorization errors
// keep precedence over validation errors and reveal nothing.
const ROUTES = [
  ['POST', /^\/users\/([^/]+)\/orders$/, 'order', {}, 'owner'],
  ['POST', /^\/users\/([^/]+)\/orders\/[^/]+\/(amend|decrease)$/, 'amend', {}, 'owner'],
  ['POST', /^\/users\/([^/]+)\/(deposits|withdrawals)$/, 'money', { unknown: 'reject' }, 'owner'],
  ['POST', /^\/perps\/transfers$/, 'perpsTransfer', { unknown: 'reject' }, 'owner'],
  ['POST', /^\/perps\/orders$/, 'perpsOrder', {}, 'owner'],
  ['POST', /^\/perps\/positions\/[^/]+\/close$/, 'perpsClose', { unknown: 'reject' }, 'owner'],
  ['PUT', /^\/communications\/(rfqs\/[^/]+\/)?quotes\/[^/]+\/accept$/, 'rfqAccept', {}, 'owner'],
  ['POST', /^\/communications\/(quotes|rfqs\/[^/]+\/quotes)$/, 'rfqQuote', {}, 'owner'],
  ['POST', /^\/admin\/resolution\/[^/]+\/resolve$/, 'adminResolve', { unknown: 'reject' }, 'staff'],
  ['POST', /^\/admin\/resolution\/[^/]+\/correct$/, 'adminCorrect', { unknown: 'reject' }, 'staff'],
  ['POST', /^\/admin\/resolution\/approvals\/[^/]+\/(approve|reject)$/, 'adminApproval', { unknown: 'reject' }, 'staff'],
  ['PUT', /^\/admin\/resolution\/policy$/, 'adminResolutionPolicy', { unknown: 'reject' }, 'staff'],
  ['PUT', /^\/admin\/settings\/currency$/, 'adminCurrency', { unknown: 'reject' }, 'staff'],
  ['POST', /^\/users\/([^/]+)\/collateral_returns\/refresh$/, 'empty', { unknown: 'reject' }, 'owner'],
  ['POST', /^\/users\/([^/]+)\/social\/posts$/, 'socialPost', {}, 'owner'],
  ['POST', /^\/users\/([^/]+)\/social\/posts\/[^/]+\/comments$/, 'socialComment', {}, 'owner'],
  ['POST', /^\/users\/([^/]+)\/social\/reports$/, 'report', {}, 'owner'],
  ['POST', /^\/users\/([^/]+)\/chat\/[^/]+\/messages$/, 'chatMessage', {}, 'owner'],
  // Payment rails (server/payments.js, CLONE_SPEC.md §26).
  ['POST', /^\/users\/([^/]+)\/debit\/payment$/, 'cardPayment', { unknown: 'reject' }, 'owner'],
  ['POST', /^\/users\/([^/]+)\/debit\/payment_session$/, 'empty', { unknown: 'reject' }, 'owner'],
  ['POST', /^\/users\/([^/]+)\/debit\/payment\/[^/]+\/challenge$/, 'paymentChallenge', { unknown: 'reject' }, 'owner'],
  ['POST', /^\/users\/([^/]+)\/debit\/withdrawal$/, 'cardPayout', { unknown: 'reject' }, 'owner'],
  ['POST', /^\/users\/([^/]+)\/bank_link\/(deposit|withdrawal)$/, 'bankMove', { unknown: 'reject' }, 'owner'],
  ['POST', /^\/users\/([^/]+)\/bank_link\/accounts$/, 'bankLink', { unknown: 'reject' }, 'owner'],
  ['POST', /^\/users\/([^/]+)\/banks\/linked_accounts$/, 'bankAccount', { unknown: 'reject' }, 'owner'],
  ['PUT', /^\/users\/([^/]+)\/crypto\/account$/, 'cryptoAccount', { unknown: 'reject' }, 'owner'],
  ['POST', /^\/users\/([^/]+)\/crypto\/wallets$/, 'cryptoWallet', { unknown: 'reject' }, 'owner'],
  ['POST', /^\/users\/([^/]+)\/crypto\/withdrawal$/, 'cryptoPayout', { unknown: 'reject' }, 'owner'],
  ['POST', /^\/users\/([^/]+)\/crypto\/simulate_deposit$/, 'cryptoSimulate', { unknown: 'reject' }, 'owner'],
  ['POST', /^\/users\/([^/]+)\/push_subscriptions$/, 'pushSubscribe', { unknown: 'reject' }, 'owner'],
  ['DELETE', /^\/users\/([^/]+)\/push_subscriptions$/, 'pushUnsubscribe', { unknown: 'reject' }, 'owner'],
  ['POST', /^\/users\/([^/]+)\/push_subscriptions\/[^/]+\/test$/, 'empty', { unknown: 'reject' }, 'owner'],
  ['POST', /^\/admin\/catalog\/(series|events|markets|import|[^/]+\/[^/]+\/publish)$/, 'adminCatalog', { maxKeys: 64 }, 'staff'],
  ['PUT', /^\/admin\/catalog\/(series|events|markets)\/[^/]+$/, 'adminCatalog', { maxKeys: 64 }, 'staff'],
];

function validateRoutes({ rolesOf = () => [] } = {}) {
  return (req, res, next) => {
    for (const [method, re, name, opts, who] of ROUTES) {
      if (req.method !== method) continue;
      const m = re.exec(req.path);
      if (!m) continue;
      if (!req.auth) return next();
      if (who === 'owner' && m[1] && m[1] !== req.auth.user.id) return next();
      if (who === 'staff' && !rolesOf(req.auth.user).length) return next();
      check(req.body, SCHEMAS[name], opts);
      return next();
    }
    next();
  };
}

module.exports = { jsonBody, validateRoutes, check, ValidationError, SCHEMAS, BODY_LIMITS, limitFor, RAW_BODY };
