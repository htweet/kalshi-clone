'use strict';
// ESLint flat config (PLAN P1.8 input/output safety). `npm run lint` runs it in CI.
// Scope is security, not style: unsafe HTML sinks (XSS), dynamic code execution, javascript: URLs.
const globals = require('globals');
const noUnsanitized = require('eslint-plugin-no-unsanitized');
const noUnescapedHtml = require('./eslint-rules/no-unescaped-html');
const requireDisableJustification = require('./eslint-rules/require-disable-justification');
const noHardcodedText = require('./eslint-rules/no-hardcoded-text');

const parlance = { rules: { 'no-unescaped-html': noUnescapedHtml, 'require-disable-justification': requireDisableJustification, 'no-hardcoded-text': noHardcodedText } };

const security = {
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
  'no-script-url': 'error',
  'parlance/require-disable-justification': 'error',
};

module.exports = [
  { ignores: ['node_modules/**', 'data/**', 'dist/**', 'build/**', 'preview/**', 'test-results/**', 'public/vendor/**', '**/*.min.js'] },
  { linterOptions: { reportUnusedDisableDirectives: 'warn' } },
  {
    // Browser SPA (ES modules).
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser } },
    plugins: { parlance, 'no-unsanitized': noUnsanitized },
    rules: {
      ...security,
      // innerHTML / outerHTML / srcdoc / insertAdjacentHTML and every HTML template literal (see the rule header).
      'parlance/no-unescaped-html': 'error',
      // Remaining HTML/code sinks, checked by Mozilla's no-unsanitized with its strict defaults.
      'no-unsanitized/method': ['error', { defaultDisable: true, escape: { methods: ['esc'] } }, {
        import: { properties: [0] },
        createContextualFragment: { properties: [0] },
        write: { objectMatches: ['document'], properties: [0] },
        writeln: { objectMatches: ['document'], properties: [0] },
        setHTMLUnsafe: { properties: [0] },
        parseHTMLUnsafe: { properties: [0] },
        parseFromString: { properties: [0] },
      }],
      // no-unsanitized/property only knows innerHTML/outerHTML and cannot follow esc()-wrapped template parts, so those
      // sinks (plus srcdoc) are checked by parlance/no-unescaped-html instead.
    },
  },
  {
    // Text catalog enforcement (CLONE_SPEC.md §32.10): user-facing text in SPA modules comes from t()/te() keys. The
    // keyed content modules hold the defaults, and the catalog runtime itself has no copy.
    files: ['public/js/**/*.js'],
    ignores: ['public/js/content/**', 'public/js/i18n.js'],
    rules: { 'parlance/no-hardcoded-text': 'error' },
  },
  {
    // The service worker (CLONE_SPEC.md §31) is a classic script in the ServiceWorkerGlobalScope.
    files: ['public/sw.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.serviceworker } },
  },
  {
    // Node server, tests, tooling (CommonJS).
    files: ['server/**/*.js', 'tests/**/*.js', 'eslint-rules/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } },
    plugins: { parlance },
    rules: { ...security },
  },
];
