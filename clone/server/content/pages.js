'use strict';
// CMS pages: the code defaults (CLONE_SPEC.md §32.7). Admin › Content › Pages edits them (and adds new ones); routes
// stay stable: /legal/:slug, /trust/:slug, /research/:slug and /support/:slug show the page `<group>/<slug>`,
// /incentives/terms the page `incentives/terms`, /help/:slug a help article (`help/<slug>`, merged with the help CMS).
// Bodies are limited rich text (sanitised allowlist: headings, paragraphs, lists, bold, italic, quotes, safe links).
// Sections: legal (publishing needs a fresh step-up), help, info. The footer columns are data here too.
const PAGES = {
  'legal/terms': {
    section: 'legal', title: 'Terms of service', seo_title: 'Terms of service · Parlance', seo_description: 'The terms that apply when you use Parlance Exchange, a sandbox demonstration exchange.',
    body: '<h2>About these terms</h2><p>Parlance Exchange is a demonstration build. Every balance, deposit and payout is simulated and no real money moves.</p><h2>Your account</h2><ul><li>Keep your sign-in details private and turn on two-factor authentication.</li><li>One account per person.</li></ul><h2>Trading</h2><p>Contracts settle on the result published by the settlement source named on each market. Read the market rules before you trade.</p><p>See also the <a href="/trust/privacy">privacy policy</a> and <a href="/support/responsible-trading">responsible trading</a>.</p>',
  },
  'trust/privacy': {
    section: 'legal', title: 'Privacy policy', seo_title: 'Privacy policy · Parlance', seo_description: 'What Parlance stores about you, why, and how to export or delete it.',
    body: '<h2>What we store</h2><p>Your email, profile, trading activity and the identity details you give during verification. Identity details are encrypted at rest.</p><h2>Your choices</h2><ul><li>Download your data from Account › Identity &amp; privacy.</li><li>Close your account at any time.</li></ul><h2>Cookies</h2><p>We use one session cookie and no advertising trackers.</p>',
  },
  'support/responsible-trading': {
    section: 'legal', title: 'Responsible trading', seo_title: 'Responsible trading · Parlance', seo_description: 'Limits and tools that help you trade within your means.',
    body: '<h2>Trade within your means</h2><p>Only trade what you can afford to lose. Set daily deposit, loss and session-time limits in <a href="/account/limits">Account › Limits</a>.</p><h2>Take a break</h2><p>A cooling-off period applies when you raise a limit. Lowering a limit takes effect at once.</p>',
  },
  'support/help-center': {
    section: 'help', title: 'Help center', seo_title: 'Help center · Parlance', seo_description: 'Answers to common questions about trading on Parlance.',
    body: '<h2>Frequently asked questions</h2><h3>What is an event contract?</h3><p>A contract that pays a fixed amount if an outcome happens, and nothing if it does not.</p><h3>How are fees charged?</h3><p>See the <a href="/support/fees">fee schedule</a>.</p><h3>Is this real money?</h3><p>No. Parlance is a sandbox: every amount is simulated.</p>',
  },
  'support/fees': {
    section: 'info', title: 'Fee schedule', seo_title: 'Fee schedule · Parlance', seo_description: 'How trading fees are calculated on Parlance.',
    body: '<h2>Trading fees</h2><p>Taker fees follow the quadratic schedule: a fee rate times contracts times price times one minus the price, rounded up to the next kobo per order. Resting (maker) orders pay no fee.</p><p>Deposits and withdrawals are free in the sandbox.</p>',
  },
  'incentives/terms': {
    section: 'legal', title: 'Liquidity Incentive Program terms', seo_title: 'Liquidity Incentive Program terms · Parlance', seo_description: 'The terms of the Liquidity Incentive Program.',
    body: '', // empty: the program's built-in terms (server/incentives.js) are shown until an admin publishes a body
  },
};
const FOOTER = {
  tagline: 'Parlance Exchange · demo build · simulated funds only',
  columns: [
    { title: 'Product', links: [{ label: 'Markets', href: '/browse' }, { label: 'Calendar', href: '/calendar' }, { label: 'Social', href: '/social' }] },
    { title: 'Company', links: [{ label: 'Terms of service', href: '/legal/terms' }, { label: 'Privacy policy', href: '/trust/privacy' }] },
    { title: 'Help', links: [{ label: 'Help center', href: '/support/help-center' }, { label: 'Responsible trading', href: '/support/responsible-trading' }, { label: 'Fee schedule', href: '/support/fees' }] },
  ],
};
// Developer portal prose (CLONE_SPEC.md §35.9): docs/* pages, seeded into the CMS on first start (server/dev-portal.js).
Object.assign(PAGES, require('./developer-docs').DOCS_PAGES);
module.exports = { PAGES, FOOTER };
