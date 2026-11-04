'use strict';
// Notification and email templates: the code defaults (CLONE_SPEC.md §32.5). Admin › Content › Templates edits them;
// published overrides live in the database. Templates are logic-free: `{{name}}` placeholders only, from the variables
// declared per template; email HTML is sanitised and every variable is HTML-escaped there, plain text elsewhere.
//
// Notification types: the server composes each notification's wording (title, body) where it happens, so a type's
// default channel templates pass it through ({{title}}, {{body}}) and keep the wording users saw before; an admin can
// replace any channel with their own text using the declared variables. Fields per type:
//   inapp_title / inapp_body   inbox row and the live toast
//   push_title / push_body     Web Push and in-browser push
//   email_subject / email_text / email_html   the email (wrapped in the shared layout)
//   sms                        text message (where the type has an SMS send)
const NOTIFY_VARS = ['title', 'body', 'link', 'open_line', 'app_name'];
const passThrough = {
  inapp_title: '{{title}}', inapp_body: '{{body}}', push_title: '{{title}}', push_body: '{{body}}',
  email_subject: 'Parlance: {{title}}', email_text: '{{body}}{{open_line}}', email_html: '<p>{{body}}</p><p><a href="{{link}}">Open in Parlance</a></p>',
};
const NOTIFY_FIELDS = ['inapp_title', 'inapp_body', 'push_title', 'push_body', 'email_subject', 'email_text', 'email_html'];
// [type, group, label]
const TYPES = [
  ['fill', 'Trading', 'Order filled'], ['settlement', 'Trading', 'Market settled'], ['settlement_correction', 'Trading', 'Settlement corrected'],
  ['price_target', 'Trading', 'Price alert'], ['price_movement', 'Trading', 'Price movement'], ['order_expired', 'Trading', 'Order expired'],
  ['order_canceled_market', 'Trading', 'Order canceled (market closed)'], ['rfq_quote', 'Trading', 'RFQ quote received'], ['rfq_accepted', 'Trading', 'RFQ quote accepted'],
  ['rfq_executed', 'Trading', 'RFQ executed'], ['rfq_failed', 'Trading', 'RFQ failed'],
  ['perp_fill', 'Perps', 'Perps order filled'], ['perp_exit_trigger', 'Perps', 'Perps exit trigger'], ['perp_liquidation', 'Perps', 'Perps liquidation'],
  ['margin_transfer_completed', 'Perps', 'Margin transfer completed'], ['margin_funding_payment', 'Perps', 'Funding payment'],
  ['transfer', 'Money', 'Deposit or withdrawal'], ['reward', 'Money', 'Reward'], ['market_reward', 'Money', 'Market reward'],
  ['security', 'Account', 'Security alert'], ['account', 'Account', 'Account notice'], ['identity', 'Account', 'Identity verification'], ['admin_approval', 'Account', 'Approval request (staff)'],
  ['social_post', 'Social', 'New post from someone you follow'], ['social_like', 'Social', 'Like'], ['social_comment', 'Social', 'Comment'], ['social_follow', 'Social', 'New follower'],
  ['trade_alert', 'Social', 'Trade alert'], ['circle_request', 'Social', 'Inner Circle request'], ['circle_accepted', 'Social', 'Inner Circle accepted'], ['group_chat', 'Social', 'Group chat message'],
  ['sports_major', 'Sports', 'Major game event'],
  // Phase 5D (CLONE_SPEC.md §33): the server composes the wording from server/content/playmode.js; these wrap it.
  ['bonus_credited', 'Money', 'Signup bonus credited'], ['heist_result', 'Money', 'Vault Heist result'], ['money_controls', 'Account', 'Deposits / withdrawals switched off or on'],
  ['production_reset', 'Account', 'Play mode ended: balances reset'],
  ['announcement', 'Announcements', 'Announcement'], ['promo_breaking_events', 'Announcements', 'Promotion: breaking events'], ['promo_new_markets', 'Announcements', 'Promotion: new markets'],
  ['promo_politics', 'Announcements', 'Promotion: politics'], ['promo_crypto', 'Announcements', 'Promotion: crypto'], ['promo_commodities', 'Announcements', 'Promotion: commodities'],
];
const SAMPLE = { title: 'Order filled: 10 YES @ ₦64', body: 'Will the Harbor Bridge open by June?', link: '/portfolio', open_line: '\n\nOpen: /portfolio', app_name: 'Parlance' };

const TEMPLATES = {};
for (const [type, group, label] of TYPES) TEMPLATES[`notify.${type}`] = { kind: 'notification', type, group, label, fields: NOTIFY_FIELDS, vars: NOTIFY_VARS, sample: SAMPLE, defaults: { ...passThrough } };
TEMPLATES['notify._default'] = { kind: 'notification', type: '*', group: 'Other', label: 'Any other notification type', fields: NOTIFY_FIELDS, vars: NOTIFY_VARS, sample: SAMPLE, defaults: { ...passThrough } };

// System messages (sent directly, not through the notification matrix).
Object.assign(TEMPLATES, {
  'email.verify_email': {
    kind: 'email', group: 'Account email', label: 'Confirm your email', fields: ['email_subject', 'email_text', 'email_html'], vars: ['name', 'link', 'hours', 'app_name'],
    sample: { name: 'Ada', link: 'https://parlance.example/verify-email?token=SAMPLE', hours: '24', app_name: 'Parlance' },
    defaults: {
      email_subject: 'Confirm your email for Parlance',
      email_text: "Hi {{name}},\n\nConfirm this email address for your Parlance account:\n{{link}}\n\nThe link works once and expires in {{hours}} hours. If you didn't create a Parlance account, ignore this email.",
      email_html: "<p>Hi {{name}},</p><p>Confirm this email address for your Parlance account:</p><p><a href=\"{{link}}\">Confirm my email</a></p><p>The link works once and expires in {{hours}} hours. If you didn't create a Parlance account, ignore this email.</p>",
    },
  },
  'email.password_reset': {
    kind: 'email', group: 'Account email', label: 'Reset your password', fields: ['email_subject', 'email_text', 'email_html'], vars: ['link', 'minutes', 'app_name'],
    sample: { link: 'https://parlance.example/reset-password?token=SAMPLE', minutes: '30', app_name: 'Parlance' },
    defaults: {
      email_subject: 'Reset your Parlance password',
      email_text: "Someone (hopefully you) asked to reset the password for your Parlance account.\n\nChoose a new password here:\n{{link}}\n\nThe link works once and expires in {{minutes}} minutes. If you didn't ask for this, you can ignore this email; your password stays the same.",
      email_html: "<p>Someone (hopefully you) asked to reset the password for your Parlance account.</p><p><a href=\"{{link}}\">Choose a new password</a></p><p>The link works once and expires in {{minutes}} minutes. If you didn't ask for this, you can ignore this email; your password stays the same.</p>",
    },
  },
  'email.security_alert': {
    kind: 'email', group: 'Account email', label: 'Security alert email', fields: ['email_subject', 'email_text', 'email_html'], vars: ['title', 'body', 'app_name'],
    sample: { title: 'New sign-in', body: 'A new sign-in to your account from Chrome on Linux.', app_name: 'Parlance' },
    defaults: {
      email_subject: 'Parlance security alert: {{title}}',
      email_text: "{{body}}\n\nIf this wasn't you, change your password and review your signed-in devices in Account › Security.",
      email_html: "<p>{{body}}</p><p>If this wasn't you, change your password and review your signed-in devices in Account › Security.</p>",
    },
  },
  'email.email_changed': {
    kind: 'email', group: 'Account email', label: 'Email address changed', fields: ['email_subject', 'email_text', 'email_html'], vars: ['masked_email', 'app_name'],
    sample: { masked_email: 'a***@example.com', app_name: 'Parlance' },
    defaults: {
      email_subject: 'Parlance security alert: your email address was changed',
      email_text: "The email on your Parlance account was changed to {{masked_email}}. If this wasn't you, contact support.",
      email_html: "<p>The email on your Parlance account was changed to {{masked_email}}. If this wasn't you, contact support.</p>",
    },
  },
  'sms.phone_code': {
    kind: 'sms', group: 'Text messages', label: 'Phone verification code', fields: ['sms'], vars: ['code', 'minutes', 'app_name'],
    sample: { code: '482913', minutes: '10', app_name: 'Parlance' },
    defaults: { sms: 'Your Parlance code is {{code}}. It expires in {{minutes}} minutes. Never share it with anyone.' },
  },
  'push.test': {
    kind: 'push', group: 'Push', label: 'Test notification (Settings › Notifications)', fields: ['push_title', 'push_body'], vars: ['app_name'],
    sample: { app_name: 'Parlance' },
    defaults: { push_title: 'Test notification', push_body: 'Push notifications are working on this device.' },
  },
  // The shared email layout: header (the email-header image slot when set, else the header text), footer and legal text.
  'email._layout': {
    kind: 'layout', group: 'Email layout', label: 'Shared email layout', fields: ['header_text', 'footer_html', 'legal_text'], vars: ['app_name', 'year'],
    sample: { app_name: 'Parlance', year: '2026' },
    defaults: {
      header_text: 'Parlance Exchange',
      footer_html: '<p>You are receiving this because you have a Parlance account. Manage email in <a href="/notifications/settings">Settings › Notifications</a>.</p>',
      legal_text: 'Parlance Exchange is a sandbox demonstration. No real money is involved. © {{year}} Parlance.',
    },
  },
});
const FIELD_LIMITS = { inapp_title: 200, inapp_body: 1000, push_title: 200, push_body: 1000, email_subject: 200, email_text: 10000, email_html: 20000, sms: 480, header_text: 200, footer_html: 4000, legal_text: 1000 };
const HTML_FIELDS = new Set(['email_html', 'footer_html']);

module.exports = { TEMPLATES, FIELD_LIMITS, HTML_FIELDS, NOTIFY_FIELDS };
