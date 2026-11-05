'use strict';
// Server-side wording of the public trading API (PLAN Phase 7, CLONE_SPEC.md §35): API-key errors, signed-request
// authentication failures, rate-tier refusals, notification titles and bodies, FIX reject texts and status-page
// component names. Keyed templates with named variables; Admin › Content › Texts overrides them as `server.api.<key>`
// (server/cms/texts.js lists this module).
const catalog = require('./catalog');

const STRINGS = {
  // key management
  'error.label': 'label must be 1-60 characters of plain text',
  'error.scopes': 'scopes must include read, and may add trade and perps',
  'error.scope_unknown': 'unknown scope {scope}; use read, trade or perps',
  'error.ip_list': 'ip_allowlist takes at most {max} IPv4 / IPv6 addresses or CIDR ranges',
  'error.ip_entry': '{entry} is not an IP address or CIDR range',
  'error.expiry': 'expires_at must be a time in the future, at most 2 years from now',
  'error.mode': 'mode must be generate (we create an RSA key pair and show you the private key once) or public_key (you paste your own RSA or Ed25519 public key)',
  'error.public_key_missing': 'paste a PEM public key (-----BEGIN PUBLIC KEY-----)',
  'error.public_key_private': 'that is a private key; paste only the public key. Never share your private key, with us or anyone else',
  'error.public_key_invalid': 'that is not a valid PEM public key',
  'error.public_key_type': 'use an RSA (2048-8192 bit) or Ed25519 public key',
  'error.public_key_duplicate': 'this public key is already registered to an active API key',
  'error.key_limit': 'you can have at most {max} active API keys; revoke one first',
  'error.key_not_found': 'API key not found',
  'error.key_inactive': 'this API key is already revoked or expired',
  'error.tier': 'unknown tier {tier}',
  // signed-request authentication (401 token_authentication_failure, with a reason)
  'auth.missing_headers': 'signed requests need PARLANCE-ACCESS-KEY, PARLANCE-ACCESS-TIMESTAMP and PARLANCE-ACCESS-SIGNATURE',
  'auth.malformed': 'the PARLANCE-ACCESS-* headers are malformed',
  'auth.wrong_environment_demo': 'this is a demo API key: send it to the demo environment (/demo-api/trade-api/v2)',
  'auth.wrong_environment_main': 'this is a production API key: it does not work in the demo environment',
  'auth.clock_skew_past': 'the request timestamp is {seconds} s in the past; requests are accepted up to {past} s in the past and {future} s in the future (server time {now} ms)',
  'auth.clock_skew_future': 'the request timestamp is {seconds} s in the future; requests are accepted up to {past} s in the past and {future} s in the future (server time {now} ms)',
  'auth.invalid_signature': 'the signature does not match: sign timestamp + METHOD + path (no query string) with the key\'s private key',
  'auth.key_revoked': 'this API key was revoked',
  'auth.key_expired': 'this API key has expired',
  'auth.account_unavailable': 'this account cannot use the API right now; contact support',
  'auth.replayed': 'this signed request was already used; sign every state-changing request afresh',
  'auth.required': 'this endpoint needs a signed request (an API key)',
  'auth.feature_off': 'API access is turned off right now',
  'forbidden.scope': 'this API key does not have the {scope} scope',
  'forbidden.ip': 'this API key cannot be used from {ip}',
  'rate.limited': 'the {bucket} budget of this key\'s {tier} tier is used up; retry in {seconds} s',
  'rate.batch_too_large': 'this request costs {cost} tokens, more than the {tier} tier\'s {bucket} budget of {capacity}',
  'rate.ws_connections': 'this key already has {count} open WebSocket connections (the {tier} tier allows {max})',
  // order groups (predictions)
  'group.not_found': 'order group not found',
  'group.triggered': 'this order group hit its contracts limit; reset it before placing more orders in it',
  'group.inactive': 'this order group is {status}',
  'group.limit': 'contracts_limit must be a number of contracts with at most 2 decimals, at least 1',
  'group.max': 'you can have at most {max} active order groups',
  'batch.size': 'send 1-{max} orders in one batch',
  'batch.ids': 'send ids: a list of 1-{max} order ids',
  // notifications (titles and bodies; the CMS templates notify.api_key_* wrap them)
  'notify.created.title': 'New API key: {label}',
  'notify.created.body': 'An API key with the {scopes} scopes was added to your account (fingerprint {fingerprint}). If this was not you, revoke it in Account › API keys and change your password.',
  'notify.revoked.title': 'API key revoked: {label}',
  'notify.revoked.body': 'The API key {label} ({key}) was revoked {by}. Programs using it are signed out.',
  'notify.revoked.by_you': 'by you',
  'notify.revoked.by_staff': 'by Parlance support',
  'notify.revoked.by_rotation': 'after its rotation grace period',
  'notify.expiring.title': 'API key expiring: {label}',
  'notify.expiring.body': 'The API key {label} ({key}) expires on {time}. Create or rotate a key before then to keep your programs running.',
  'notify.rotated.title': 'API key rotated: {label}',
  'notify.rotated.body': 'A new key replaces {old}; the old key keeps working until {time}.',
  // status page
  'status.component.api': 'Trading API (REST)',
  'status.component.websocket': 'WebSocket',
  'status.component.fix': 'FIX gateway',
  'status.component.demo': 'Demo environment',
  'status.component.web': 'Website',
  // FIX gateway reject texts
  'fix.bad_logon': 'logon refused: the signature, key or timestamp is not valid',
  'fix.not_logged_on': 'log on first',
  'fix.seq_low': 'MsgSeqNum too low, expecting {expected} but received {received}',
  'fix.unsupported': 'unsupported message type {type}',
  'fix.required_tag': 'required tag {tag} missing',
  'fix.bad_value': 'value of tag {tag} is not valid',
  'fix.unknown_order': 'unknown order',
  'fix.rate': 'message rate limit exceeded',
  'fix.drop_copy_only': 'this is a drop copy session: order entry is not accepted',
  'fix.disconnected_admin': 'disconnected by Parlance support',
  'fix.key_revoked': 'the API key was revoked',
  'fix.feature_off': 'the FIX gateway is turned off',
  'fix.production_reset': 'the exchange switched to production',
};
const s = catalog.scoped('server.api.', STRINGS);

module.exports = { STRINGS, s };
