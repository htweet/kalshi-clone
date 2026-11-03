#!/usr/bin/env node
'use strict';
// Installs the repository's git hooks (.githooks/) by pointing core.hooksPath at them. Run by `npm run prepare`
// (which `npm install` runs automatically). Safe to re-run; silently does nothing outside a git checkout
// (for example in a packed tarball) or when HUSKY=0 / SKIP_GIT_HOOKS=1 is set.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.env.SKIP_GIT_HOOKS === '1' || process.env.HUSKY === '0') process.exit(0);
const root = path.resolve(__dirname, '..');
const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' });
if (inside.status !== 0 || inside.stdout.trim() !== 'true') process.exit(0);
const set = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, encoding: 'utf8' });
if (set.status === 0) console.log('git hooks: core.hooksPath = .githooks (pre-commit: secret scan + npm audit)');
else console.warn(`git hooks: could not set core.hooksPath (${(set.stderr || '').trim()}); run \`git config core.hooksPath .githooks\` yourself`);
