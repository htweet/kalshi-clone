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
  // Phase 8 P8.7 (A18, CLONE_SPEC.md §38.8): the help centre and company pages behind the footer and the ☰ Trust /
  // Research / Support groups, with Nigerian contact and support-hours content. Invented contact details only.
  'support/faq': {
    section: 'help', title: 'Frequently asked questions', seo_title: 'FAQ · Parlance', seo_description: 'Quick answers about accounts, naira amounts, trading, fees and the real-money waitlist.',
    body: '<h2>Accounts</h2><h3>Who can open an account?</h3><p>Anyone 18 or older. Identity verification uses a Nigerian phone number and ID.</p><h3>Is my money real?</h3><p>Not yet. Parlance runs on play money while we prepare the real-money launch; <a href="/waitlist">join the waitlist</a> to hear first.</p><h2>Trading</h2><h3>What does a price mean?</h3><p>A contract pays ₦100 if its outcome happens. A price of ₦64 means the market gives the outcome a 64% chance.</p><h3>Can I sell before the result?</h3><p>Yes, at the current bid, at any time while the market is open.</p><h2>Fees and payments</h2><h3>What are the fees?</h3><p>See the <a href="/support/fees">fee schedule</a>.</p><h3>How do deposits work?</h3><p>Bank transfer, card and USSD rails are simulated in the sandbox.</p><h2>Referrals</h2><h3>How do referral rewards work?</h3><p>Share your code from <a href="/rewards">Rewards</a>. When a friend trades the goal amount, you both get a reward. Every referral is checked before it is paid.</p>',
  },
  'support/contact': {
    section: 'help', title: 'Contact support', seo_title: 'Contact support · Parlance', seo_description: 'How and when to reach the Parlance support team in Nigeria.',
    body: '<h2>Support hours (West Africa Time, WAT)</h2><ul><li>Monday to Friday: 8:00 to 20:00</li><li>Saturday: 10:00 to 16:00</li><li>Sundays and Nigerian public holidays: closed. Urgent account security issues are handled every day.</li></ul><h2>How to reach us</h2><ul><li>Email: <a href="mailto:support@example.test">support@example.test</a> (we reply within one working day)</li><li>In the app: Account › Help</li></ul><h2>Account security</h2><p>If you think someone else has access to your account, change your password and sign out of all devices from Account › Security, then email us. Parlance staff will never ask for your password, codes or card details.</p>',
  },
  'support/accessibility': {
    section: 'info', title: 'Accessibility statement', seo_title: 'Accessibility · Parlance', seo_description: 'How Parlance meets WCAG 2.2 AA, what we test and how to report a barrier.',
    body: '<h2>Our commitment</h2><p>Parlance aims to meet the Web Content Accessibility Guidelines (WCAG) 2.2 at level AA on every page, in light and dark themes, on phones and on desktops.</p><h2>What we do</h2><ul><li>Automated accessibility checks (axe-core) of the key pages in light and dark at phone and desktop widths, on every change.</li><li>Keyboard paths for trading, funds and the account area, with a visible focus outline.</li><li>Touch targets of at least 24 by 24 pixels, colour contrast of at least 4.5:1 for text (brand colours are checked when an admin changes them).</li><li>Text alternatives for charts, the elections map and gauges; reduced motion when your device asks for it.</li><li>Data saver mode for slow or costly networks.</li></ul><h2>Known limitations</h2><p>Some chart details are summarised rather than read out point by point. Tell us if anything gets in your way.</p><h2>Report a barrier</h2><p>Email <a href="mailto:accessibility@example.test">accessibility@example.test</a> or use <a href="/support/contact">Contact support</a>. We aim to reply within five working days.</p>',
  },
  'trust/security': {
    section: 'info', title: 'Security', seo_title: 'Security · Parlance', seo_description: 'How Parlance protects accounts and data.',
    body: '<h2>Your account</h2><ul><li>Two-factor authentication and passkeys.</li><li>Step-up checks before sensitive actions such as withdrawals.</li><li>Sign-in alerts and a list of your devices with "sign out everywhere".</li></ul><h2>Your data</h2><p>Identity details are encrypted at rest and never shown in full. See the <a href="/trust/privacy">privacy policy</a>.</p><h2>Report a vulnerability</h2><p>Email <a href="mailto:security@example.test">security@example.test</a>.</p>',
  },
  'trust/regulation': {
    section: 'info', title: 'Regulation', seo_title: 'Regulation · Parlance', seo_description: 'The regulatory status of Parlance Exchange.',
    body: '<p>Parlance Exchange is a demonstration exchange running on play money. It is not licensed to take real-money deposits. Before any real-money launch in Nigeria, the required licences and a legal review of every market type will be in place, and this page will list them.</p><p>Personal data is handled in line with the Nigeria Data Protection Act 2023.</p>',
  },
  'research/blog': {
    section: 'info', title: 'Blog', seo_title: 'Blog · Parlance', seo_description: 'News and explainers from Parlance.',
    body: '<p>Explainers on prediction markets, new market launches and product news will appear here.</p>',
  },
  'research/data': {
    section: 'info', title: 'Market data', seo_title: 'Market data · Parlance', seo_description: 'Prices, volumes and history of Parlance markets.',
    body: '<p>Every market page has its price history and a CSV download. Developers can read prices, order books and trades through the <a href="/docs">public API</a>.</p>',
  },
  'research/papers': {
    section: 'info', title: 'Research', seo_title: 'Research · Parlance', seo_description: 'Research on prediction markets and forecasting.',
    body: '<p>Research notes on market accuracy and forecasting will be published here.</p>',
  },
  'incentives/terms': {
    section: 'legal', title: 'Liquidity Incentive Program terms', seo_title: 'Liquidity Incentive Program terms · Parlance', seo_description: 'The terms of the Liquidity Incentive Program.',
    body: '', // empty: the program's built-in terms (server/incentives.js) are shown until an admin publishes a body
  },
};
// Footer (A18, CLONE_SPEC.md §38.8): Product · Company · Help columns and social links. The social links point at each
// network's home page until an admin enters Parlance's own handles (Admin › Content › Pages & footer): no handle is invented.
const FOOTER = {
  tagline: 'Parlance Exchange · demo build · simulated funds only · Lagos, Nigeria',
  columns: [
    { title: 'Product', links: [{ label: 'Markets', href: '/browse' }, { label: 'Live', href: '/live' }, { label: 'Calendar', href: '/calendar' }, { label: 'Elections hub', href: '/category/elections/nigeria-2027' }, { label: 'Perps', href: '/perps' }, { label: 'API docs', href: '/docs' }] },
    { title: 'Company', links: [{ label: 'Trust & security', href: '/trust/security' }, { label: 'Privacy policy', href: '/trust/privacy' }, { label: 'Terms of service', href: '/legal/terms' }, { label: 'Regulation', href: '/trust/regulation' }, { label: 'Research', href: '/research/papers' }, { label: 'Blog', href: '/research/blog' }] },
    { title: 'Help', links: [{ label: 'Help center', href: '/support/help-center' }, { label: 'FAQ', href: '/support/faq' }, { label: 'Contact support', href: '/support/contact' }, { label: 'Fee schedule', href: '/support/fees' }, { label: 'Responsible trading', href: '/support/responsible-trading' }, { label: 'Accessibility', href: '/support/accessibility' }, { label: 'Status', href: '/status' }] },
  ],
  social: [
    { network: 'whatsapp', label: 'WhatsApp', href: 'https://www.whatsapp.com/' },
    { network: 'x', label: 'X', href: 'https://x.com/' },
    { network: 'facebook', label: 'Facebook', href: 'https://www.facebook.com/' },
    { network: 'instagram', label: 'Instagram', href: 'https://www.instagram.com/' },
    { network: 'telegram', label: 'Telegram', href: 'https://telegram.org/' },
  ],
};
// Developer portal prose (CLONE_SPEC.md §35.9): docs/* pages, seeded into the CMS on first start (server/dev-portal.js).
Object.assign(PAGES, require('./developer-docs').DOCS_PAGES);
module.exports = { PAGES, FOOTER };
