'use strict';
// Production configuration guard (PLAN P9.6, RS7 / RS8; CLONE_SPEC.md §39.10). With NODE_ENV=production the server
// refuses to start unless every check below passes, and the error names each failing setting. The same checks feed the
// "Production configuration" item of Admin › Launch readiness (report mode, any environment).
const path = require('node:path');
const crypto = require('./crypto');

const httpsOrigin = (v) => { try { const u = new URL(String(v)); return u.protocol === 'https:' && u.pathname === '/' && !u.search ? `${u.protocol}//${u.host}` : null; } catch { return null; } };
const inside = (file, dir) => { if (!file || !dir) return false; const rel = path.relative(path.resolve(dir), path.resolve(file)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

// Returns [{ setting, ok, message }]. `dataDir`: the folder holding the database (the data volume).
function checks({ env = process.env, dataDir, options = {} } = {}) {
  const out = [];
  const add = (setting, ok, message) => out.push({ setting, ok: !!ok, message });
  const origins = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  add('ALLOWED_ORIGINS', origins.length && origins.every(httpsOrigin), 'ALLOWED_ORIGINS must list the site\'s https origins (RS8: the Host header is not trusted in production).');
  const pub = httpsOrigin(env.PUBLIC_ORIGIN);
  add('PUBLIC_ORIGIN', !!pub, 'PUBLIC_ORIGIN must be the public https origin, e.g. https://example.ng.');
  const adm = httpsOrigin(env.ADMIN_ORIGIN);
  add('ADMIN_ORIGIN', !!adm && adm !== pub, 'ADMIN_ORIGIN must be the separate https admin origin, e.g. https://admin.example.ng (not the public origin).');
  if (pub && origins.length) add('ALLOWED_ORIGINS includes PUBLIC_ORIGIN', origins.map(httpsOrigin).includes(pub), 'ALLOWED_ORIGINS must include PUBLIC_ORIGIN.');
  const logN = Number(env.SCRYPT_LOG_N || 16);
  add('SCRYPT_LOG_N', Number.isInteger(logN) && logN >= 17, 'SCRYPT_LOG_N must be 17 or more (RS7: scrypt cost at least 2^17 in production).');
  let ring = null;
  try { ring = crypto.ringSource({ dir: dataDir }); } catch { ring = null; }
  const keyOk = ring && (ring.kind === 'env' || ring.kind === 'env_keyring' || (ring.kind === 'keyring_file' && !inside(ring.file, dataDir)) || (ring.kind === 'key_file' && env.SECRET_KEY_FILE && !inside(ring.file, dataDir)));
  add('SECRET_KEY', keyOk, 'The master key must come from SECRET_KEY / SECRET_KEYRING or a secrets file (SECRET_KEY_FILE / SECRET_KEYRING_FILE) outside the data folder, not the generated data/secret.key.');
  const backupKeyOk = !!env.BACKUP_KEY || (!!env.BACKUP_KEY_FILE && !inside(env.BACKUP_KEY_FILE, dataDir));
  add('BACKUP_KEY', backupKeyOk, 'BACKUP_KEY (or BACKUP_KEY_FILE outside the data folder) must be set: backups are encrypted with their own key, kept off the server.');
  if (env.SECRET_KEY && env.BACKUP_KEY) add('BACKUP_KEY differs from SECRET_KEY', env.SECRET_KEY !== env.BACKUP_KEY, 'BACKUP_KEY must not be the master key.');
  add('DEMO_ACCOUNTS', env.DEMO_ACCOUNTS === 'off', 'DEMO_ACCOUNTS=off is required: the seeded demo traders cannot sign in in production.');
  add('DEMO_PASSWORD', !env.DEMO_PASSWORD, 'DEMO_PASSWORD must not be set in production.');
  add('DEMO_API', env.DEMO_API === '0', 'DEMO_API=0 is required: the in-process demo trading environment is off in production.');
  add('SPORTS', env.SPORTS === '0', 'SPORTS=0 is required: the simulated sports feed is a demo simulator.');
  add('SECURE_COOKIES', env.SECURE_COOKIES !== '0' && options.secureCookies !== false, 'Cookies must be Secure (__Host- prefixed): do not set SECURE_COOKIES=0.');
  const trust = String(env.TRUST_PROXY || '').trim();
  add('TRUST_PROXY', !!trust && trust !== 'true' && trust !== '*', 'TRUST_PROXY must name the reverse proxy / CDN address ranges (e.g. "loopback, 172.18.0.0/16"), never "true": the client IP must not come from a header a visitor can forge.');
  const ff = String(env.FEATURE_FLAGS || '');
  add('FEATURE_FLAGS', !/elections\.simulator\s*=\s*(on|1|true)/i.test(ff), 'FEATURE_FLAGS must not switch the elections results simulator on in production.');
  add('BACKUP_STORAGE', !!env.BACKUP_STORAGE && env.BACKUP_STORAGE !== 'local' && !(env.BACKUP_STORAGE.startsWith('local:') && inside(env.BACKUP_STORAGE.slice(6), dataDir)), 'BACKUP_STORAGE must point off the data volume: s3 (an S3-compatible bucket) or local:<folder> on another disk.');
  return out;
}

class ConfigError extends Error { constructor(failing) { super(`Refusing to start in production; fix these settings:\n${failing.map((c) => `  - ${c.setting}: ${c.message}`).join('\n')}`); this.code = 'CONFIG_GUARD'; this.failing = failing; } }

// Throws ConfigError listing every failing setting when NODE_ENV=production.
function enforce({ env = process.env, dataDir, options = {} } = {}) {
  if (env.NODE_ENV !== 'production') return [];
  const failing = checks({ env, dataDir, options }).filter((c) => !c.ok);
  if (failing.length) throw new ConfigError(failing);
  return [];
}

module.exports = { checks, enforce, ConfigError, httpsOrigin };
