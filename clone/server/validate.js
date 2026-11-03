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
  [/^\/v1\/users\/[^/]+\/(deposits|withdrawals)$/, '1kb'],
  [/^\/v1\/perps\/transfers$/, '1kb'],
  [/^\/v1\/(log_in|log_in_mfa|log_out|client_token)$/, '4kb'],
  [/^\/v1\/users$/, '4kb'],
  [/^\/v1\/users\/[^/]+\/orders(\/[^/]+\/(amend|decrease))?$/, '4kb'],
  [/^\/v1\/perps\/(orders|positions\/[^/]+\/(close|exit_trigger))$/, '4kb'],
  [/^\/v1\/communications\//, '8kb'],
  [/^\/v1\/users\/[^/]+\/chat\//, '4kb'],
  [/^\/v1\/users\/[^/]+\/social\//, '8kb'],
  [/^\/v1\/users\/[^/]+\/(mfa|notifications)\b/, '4kb'],
  [/^\/v1\/admin\/catalog\/import$/, '256kb'], // CSV import: a few hundred rows
  [/^\/v1\/admin\//, '64kb'],
];
const limitFor = (p) => (BODY_LIMITS.find(([re]) => re.test(p)) || [null, DEFAULT_LIMIT])[1];

function jsonBody() {
  const parsers = new Map();
  const parserFor = (limit) => {
    if (!parsers.has(limit)) parsers.set(limit, express.json({ limit }));
    return parsers.get(limit);
  };
  return (req, res, next) => {
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
  money: { amount_dollars: { type: ['number', 'string'], maxLen: 16, required: true } },
  perpsTransfer: { direction: S(16), source: S(32), destination: S(32), amount_dollars: NUMISH, amount: NUMISH, client_transfer_id: { ...ID, nullable: true } },
  perpsOrder: {
    ticker: S(64), side: S(8), action: S(8), direction: S(16), type: S(16), time_in_force: TIF, count: NUMISH, count_fp: NUMISH, price: NUMISH, price_dollars: NUMISH, leverage: NUMISH,
    client_order_id: { ...S(64), nullable: true }, reduce_only: FLAG, post_only: FLAG,
    take_profit: { type: ['object', 'number', 'string'], nullable: true, maxLen: 32 }, stop_loss: { type: ['object', 'number', 'string'], nullable: true, maxLen: 32 },
    expiration_time: { type: ['string', 'number'], maxLen: 64, nullable: true },
  },
  perpsClose: { percent: { type: ['number', 'string'], maxLen: 16 } },
  rfqAccept: { accepted_side: S(8) },
  // Posts, replies and chat messages may be a sticker alone (PLAN P2.2): the handlers require body or sticker_id.
  socialPost: { body: { type: 'string', maxLen: 2000, nullable: true }, event_ticker: { ...S(64), nullable: true }, sticker_id: { ...S(40), nullable: true }, position: { type: 'object', nullable: true } },
  socialComment: { body: { type: 'string', maxLen: 2000, nullable: true }, sticker_id: { ...S(40), nullable: true } },
  chatMessage: { body: { type: 'string', maxLen: 2000, nullable: true }, reply_to: { ...S(64), nullable: true }, sticker_id: { ...S(40), nullable: true } },
  // Phase 2 writes (server/social2.js, server/chat-extras.js; PHASE2_SPEC.md §24.9).
  textEdit: { body: { type: 'string', maxLen: 2000, required: true } },
  mute: { nickname: { type: 'string', maxLen: 20, required: true } },
  topic: { kind: { type: 'string', maxLen: 16, required: true }, value: { type: 'string', maxLen: 80, required: true } },
  avatar: { sticker_id: { ...S(40), nullable: true, required: true } },
  notifPrefs: { types: { type: 'object' }, quiet_hours: { type: 'object' } },
  notifSetting: { in_app: { type: 'boolean' }, email: { type: 'boolean' } },
  moveSub: { market_ticker: { ...S(64), required: true }, threshold_cents: { type: 'integer', min: 1, max: 99, required: true }, window_minutes: { type: 'integer', min: 1, max: 1440, required: true }, direction: S(8) },
  // social-admin and sticker moderation: no required fields, so authorization (checked by the route) answers first.
  socialAdmin: { decision: S(16), reason: { type: 'string', maxLen: 1000 }, event_ticker: { ...S(64), nullable: true }, position_tag: S(8), post_subtype: S(16), body: { type: 'string', maxLen: 2000 } },
  stickerToggle: { enabled: { type: 'boolean' }, reason: { type: 'string', maxLen: 1000 } },
  report: { kind: S(16), id: S(64), reason: { type: 'string', maxLen: 1000 } },
  // Admin catalog has its own per-field validator (admin.js check()/FieldError); this only bounds the shape.
  adminCatalog: {},
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
  ['POST', /^\/users\/([^/]+)\/social\/posts$/, 'socialPost', {}, 'owner'],
  ['POST', /^\/users\/([^/]+)\/social\/posts\/[^/]+\/comments$/, 'socialComment', {}, 'owner'],
  ['POST', /^\/users\/([^/]+)\/social\/reports$/, 'report', {}, 'owner'],
  ['POST', /^\/users\/([^/]+)\/chat\/[^/]+\/messages$/, 'chatMessage', {}, 'owner'],
  ['PUT', /^\/users\/([^/]+)\/chat\/[^/]+\/messages\/[^/]+$/, 'textEdit', { unknown: 'reject' }, 'owner'],
  ['PUT', /^\/users\/([^/]+)\/social\/posts\/[^/]+$/, 'textEdit', { unknown: 'reject' }, 'owner'],
  ['POST', /^\/users\/([^/]+)\/social\/mutes$/, 'mute', { unknown: 'reject' }, 'owner'],
  ['POST', /^\/users\/([^/]+)\/social\/topics$/, 'topic', { unknown: 'reject' }, 'owner'],
  ['PUT', /^\/users\/([^/]+)\/social\/profile\/avatar$/, 'avatar', { unknown: 'reject' }, 'owner'],
  ['PUT', /^\/users\/([^/]+)\/notifications\/preferences$/, 'notifPrefs', { unknown: 'reject' }, 'owner'],
  ['PUT', /^\/users\/([^/]+)\/notifications\/settings\/[^/]+$/, 'notifSetting', { unknown: 'reject' }, 'owner'],
  ['POST', /^\/users\/([^/]+)\/notifications\/price_movement_subscriptions$/, 'moveSub', { unknown: 'reject' }, 'owner'],
  ['PUT', /^\/users\/([^/]+)\/social\/social-admin\//, 'socialAdmin', { unknown: 'reject' }, 'owner'],
  ['PUT', /^\/admin\/stickers\/[^/]+$/, 'stickerToggle', { unknown: 'reject' }, 'staff'],
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

module.exports = { jsonBody, validateRoutes, check, ValidationError, SCHEMAS, BODY_LIMITS, limitFor };
