#!/usr/bin/env node
'use strict';
// Bundled secret scanner (PLAN P1.13), used by the pre-commit hook when gitleaks is not installed.
// It is a guardrail against accidents, not a replacement for gitleaks in CI (.github/workflows/ci.yml).
//
//   node scripts/secret-scan.js            # staged changes (what the pre-commit hook runs)
//   node scripts/secret-scan.js --all      # every tracked file
//   node scripts/secret-scan.js FILE...    # specific files on disk
//
// A line that must contain a match (a test fixture, a documented example) can carry `secret-scan:allow`.
// Paths in .secretscanignore (one glob per line, `#` comments) are skipped entirely.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = (() => {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(); } catch { return path.resolve(__dirname, '..'); }
})();

// Content rules: high-signal token formats plus a generic "secret-looking assignment" rule gated on entropy.
const RULES = [
  // A backtick-quoted header is documentation (e.g. evidence/openapi.yaml describing the PEM format), not key material.
  { id: 'private-key', re: /`?-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----`?/, skip: (m) => m.startsWith('`') && m.endsWith('`') },
  { id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
  { id: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { id: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'slack-webhook', re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/ },
  { id: 'stripe-live-key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'anthropic-api-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: 'openai-api-key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}\b/ },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { id: 'url-credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@'"]{1,64}:[^/\s:@'"]{8,}@[^\s'"]+/i, skip: (m) => /:\/\/[^:]+:(?:password|pass|secret|xxx+|\*+|<[^>]+>|\$\{?[A-Z_]+\}?)@/i.test(m) },
  { id: 'generic-secret-assignment',
    re: /(?:secret|passw(?:or)?d|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret)[A-Za-z0-9_]*['"]?\s*[:=]\s*['"`]([^'"`\s]{20,})['"`]/i,
    skip: (m, g) => entropy(g[1]) < 3.5 },
];

// Files that must never be committed, whatever their content.
const FORBIDDEN = [
  { id: 'dotenv-file', test: (p) => /(^|\/)\.env(\.[^/]+)?$/.test(p) && !/(^|\/)\.env\.example$/.test(p) },
  { id: 'key-material', test: (p) => /\.(pem|key|p12|pfx|jks|keystore)$/i.test(p) || /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(p) },
  { id: 'database-file', test: (p) => /^clone\/data\//.test(p) || /\.(db|sqlite3?|db-wal|db-shm)$/i.test(p) },
];

function entropy(s) {
  const f = new Map();
  for (const c of s) f.set(c, (f.get(c) || 0) + 1);
  let h = 0;
  for (const n of f.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

function globToRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') { if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; } else re += '[^/]*'; }
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
const IGNORE = (() => {
  const f = path.join(ROOT, '.secretscanignore');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map(globToRe);
})();
const ignored = (p) => IGNORE.some((re) => re.test(p));

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const gitBuf = (...args) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });

function targets(argv) {
  if (argv.includes('--all')) return git('ls-files', '-z').split('\0').filter(Boolean).map((p) => ({ p, read: () => fs.readFileSync(path.join(ROOT, p)) }));
  const files = argv.filter((a) => !a.startsWith('--'));
  if (files.length) return files.map((f) => ({ p: path.relative(ROOT, path.resolve(f)).split(path.sep).join('/'), read: () => fs.readFileSync(f) }));
  // Staged content (the index), not the working tree: that is what will be committed.
  return git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').split('\0').filter(Boolean).map((p) => ({ p, read: () => gitBuf('show', `:${p}`) }));
}

const findings = [];
for (const t of targets(process.argv.slice(2))) {
  if (ignored(t.p)) continue;
  for (const f of FORBIDDEN) if (f.test(t.p)) findings.push({ file: t.p, line: 0, rule: f.id, text: 'this kind of file must not be committed' });
  let buf;
  try { buf = t.read(); } catch { continue; }
  if (buf.length > 5 * 1024 * 1024 || buf.subarray(0, 8000).includes(0)) continue; // binary or huge
  const lines = buf.toString('utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.includes('secret-scan:allow') || line.length > 20000) return;
    for (const r of RULES) {
      const m = r.re.exec(line);
      if (!m || (r.skip && r.skip(m[0], m))) continue;
      const s = m[0];
      findings.push({ file: t.p, line: i + 1, rule: r.id, text: s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-2)} (redacted)` : '(redacted)' });
    }
  });
}

if (findings.length) {
  console.error(`secret scan: ${findings.length} finding(s)`);
  for (const f of findings) console.error(`  ${f.file}${f.line ? `:${f.line}` : ''}  [${f.rule}]  ${f.text}`);
  console.error('Remove the secret (rotate it if it was real), or mark a deliberate fixture with `secret-scan:allow`.');
  process.exit(1);
}
console.log('secret scan: no findings');
