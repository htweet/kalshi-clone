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
  // Phase 6 (CLONE_SPEC.md §34): the server composes the wording from server/content/perps.js; these wrap it.
  ['perps_waitlist_joined', 'Perps', 'Perps waitlist joined'], ['perps_waitlist_approved', 'Perps', 'Perps access unlocked (waitlist)'], ['perps_apy', 'Perps', 'Interest on Perps collateral'],
  ['referral_reward', 'Money', 'Referral reward'],
  ['transfer', 'Money', 'Deposit or withdrawal'], ['reward', 'Money', 'Reward'], ['market_reward', 'Money', 'Market reward'],
  ['security', 'Account', 'Security alert'], ['account', 'Account', 'Account notice'], ['identity', 'Account', 'Identity verification'], ['admin_approval', 'Account', 'Approval request (staff)'],
  ['social_post', 'Social', 'New post from someone you follow'], ['social_like', 'Social', 'Like'], ['social_comment', 'Social', 'Comment'], ['social_follow', 'Social', 'New follower'],
  ['trade_alert', 'Social', 'Trade alert'], ['circle_request', 'Social', 'Inner Circle request'], ['circle_accepted', 'Social', 'Inner Circle accepted'], ['group_chat', 'Social', 'Group chat message'],
  ['sports_major', 'Sports', 'Major game event'],
  // Phase 5D (CLONE_SPEC.md §33): the server composes the wording from server/content/playmode.js; these wrap it.
  ['bonus_credited', 'Money', 'Signup bonus credited'], ['heist_result', 'Money', 'Vault Heist result'], ['money_controls', 'Account', 'Deposits / withdrawals switched off or on'],
  ['production_reset', 'Account', 'Play mode ended: balances reset'],
  // Phase 7 (CLONE_SPEC.md §35): the server composes the wording from server/content/api.js; these wrap it.
  ['api_key_created', 'Account', 'API key created or rotated'], ['api_key_revoked', 'Account', 'API key revoked'], ['api_key_expiring', 'Account', 'API key expiring soon'],
  // Phase 7A (CLONE_SPEC.md §36): the server composes the wording from server/content/waitlists.js; these wrap it.
  ['waitlist_joined', 'Waitlists', 'Real-money waitlist joined'], ['waitlist_target', 'Waitlists', 'Launch waitlist target reached (staff)'],
  ['waitlist_launch_offer', 'Waitlists', 'Launch email offered after the production switch (staff)'],
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
  // Phase 6 (CLONE_SPEC.md §34.9): Perps waitlist emails, sent directly (account notices outside the matrix).
  'email.perps_waitlist_joined': {
    kind: 'email', group: 'Perps email', label: 'Joined the Perps waitlist', fields: ['email_subject', 'email_text', 'email_html'], vars: ['name', 'position', 'link', 'app_name'],
    sample: { name: 'Ada', position: '12', link: 'https://parlance.example/perps', app_name: 'Parlance' },
    defaults: {
      email_subject: 'You joined the Perps waitlist',
      email_text: 'Hi {{name}},\n\nYou are number {{position}} in line for Perps on {{app_name}}. We will email you as soon as your access is unlocked.\n\n{{link}}',
      email_html: '<p>Hi {{name}},</p><p>You are number {{position}} in line for Perps on {{app_name}}. We will email you as soon as your access is unlocked.</p><p><a href="{{link}}">Open Perps</a></p>',
    },
  },
  'email.perps_waitlist_approved': {
    kind: 'email', group: 'Perps email', label: 'Perps access unlocked', fields: ['email_subject', 'email_text', 'email_html'], vars: ['name', 'link', 'app_name'],
    sample: { name: 'Ada', link: 'https://parlance.example/perps', app_name: 'Parlance' },
    defaults: {
      email_subject: 'Your Perps access is unlocked',
      email_text: 'Hi {{name}},\n\nYour Perps access on {{app_name}} is unlocked: you can now move funds to Perps and trade perpetual futures.\n\n{{link}}',
      email_html: '<p>Hi {{name}},</p><p>Your Perps access on {{app_name}} is unlocked: you can now move funds to Perps and trade perpetual futures.</p><p><a href="{{link}}">Start trading Perps</a></p>',
    },
  },
  // Phase 7 (CLONE_SPEC.md §35): API key security emails, sent directly (account security notices outside the matrix).
  'email.api_key_created': {
    kind: 'email', group: 'API email', label: 'API key created', fields: ['email_subject', 'email_text', 'email_html'], vars: ['name', 'label', 'key_id', 'scopes', 'fingerprint', 'link', 'app_name'],
    sample: { name: 'Ada', label: 'Market maker', key_id: 'plxk_00000000-0000-4000-8000-000000000000', scopes: 'read, trade', fingerprint: 'SHA256:abc', link: 'https://parlance.example/account/api-keys', app_name: 'Parlance' },
    defaults: {
      email_subject: 'A new API key was added to your account',
      email_text: 'Hi {{name}},\n\nThe API key "{{label}}" ({{key_id}}, scopes {{scopes}}, fingerprint {{fingerprint}}) was added to your {{app_name}} account. If this was not you, revoke it and change your password now.\n\n{{link}}',
      email_html: '<p>Hi {{name}},</p><p>The API key <strong>{{label}}</strong> ({{key_id}}, scopes {{scopes}}, fingerprint {{fingerprint}}) was added to your {{app_name}} account. If this was not you, revoke it and change your password now.</p><p><a href="{{link}}">Review your API keys</a></p>',
    },
  },
  'email.api_key_revoked': {
    kind: 'email', group: 'API email', label: 'API key revoked', fields: ['email_subject', 'email_text', 'email_html'], vars: ['name', 'label', 'key_id', 'by', 'link', 'app_name'],
    sample: { name: 'Ada', label: 'Market maker', key_id: 'plxk_00000000-0000-4000-8000-000000000000', by: 'by you', link: 'https://parlance.example/account/api-keys', app_name: 'Parlance' },
    defaults: {
      email_subject: 'An API key was revoked',
      email_text: 'Hi {{name}},\n\nThe API key "{{label}}" ({{key_id}}) was revoked {{by}}. Programs using it are signed out.\n\n{{link}}',
      email_html: '<p>Hi {{name}},</p><p>The API key <strong>{{label}}</strong> ({{key_id}}) was revoked {{by}}. Programs using it are signed out.</p><p><a href="{{link}}">Review your API keys</a></p>',
    },
  },
  'email.api_key_expiring': {
    kind: 'email', group: 'API email', label: 'API key expiring soon', fields: ['email_subject', 'email_text', 'email_html'], vars: ['name', 'label', 'key_id', 'expires', 'link', 'app_name'],
    sample: { name: 'Ada', label: 'Market maker', key_id: 'plxk_00000000-0000-4000-8000-000000000000', expires: '2026-12-01 09:00 UTC', link: 'https://parlance.example/account/api-keys', app_name: 'Parlance' },
    defaults: {
      email_subject: 'Your API key expires soon',
      email_text: 'Hi {{name}},\n\nThe API key "{{label}}" ({{key_id}}) expires on {{expires}}. Create or rotate a key before then to keep your programs running.\n\n{{link}}',
      email_html: '<p>Hi {{name}},</p><p>The API key <strong>{{label}}</strong> ({{key_id}}) expires on {{expires}}. Create or rotate a key before then to keep your programs running.</p><p><a href="{{link}}">Manage your API keys</a></p>',
    },
  },
  // Phase 7A (CLONE_SPEC.md §36): real-money launch waitlist emails. Every one carries {{unsubscribe_link}} (one click, no
  // sign-in); the sender appends it when an override leaves it out, and adds a List-Unsubscribe header.
  'email.waitlist_confirm': {
    kind: 'email', group: 'Waitlist email', label: 'Confirm your place (guest double opt-in)', fields: ['email_subject', 'email_text', 'email_html'], vars: ['link', 'hours', 'list_name', 'unsubscribe_link', 'app_name'],
    sample: { link: 'https://parlance.example/waitlist/confirm?token=SAMPLE', hours: '48', list_name: 'Real-money launch waitlist', unsubscribe_link: 'https://parlance.example/waitlist/unsubscribe?token=SAMPLE', app_name: 'Parlance' },
    defaults: {
      email_subject: 'Confirm your place on the {{app_name}} real-money waitlist',
      email_text: 'Hello,\n\nSomeone (hopefully you) asked to join the {{list_name}}. Confirm your email address to take your place:\n{{link}}\n\nThe link works once and expires in {{hours}} hours. If this was not you, ignore this email: an unconfirmed request is deleted automatically.\n\nUnsubscribe: {{unsubscribe_link}}',
      email_html: '<p>Hello,</p><p>Someone (hopefully you) asked to join the {{list_name}}. Confirm your email address to take your place.</p><p><a href="{{link}}">Confirm my place</a></p><p>The link works once and expires in {{hours}} hours. If this was not you, ignore this email: an unconfirmed request is deleted automatically.</p><p><a href="{{unsubscribe_link}}">Unsubscribe</a></p>',
    },
  },
  'email.waitlist_welcome': {
    kind: 'email', group: 'Waitlist email', label: 'You are on the list', fields: ['email_subject', 'email_text', 'email_html'], vars: ['name', 'list_name', 'manage_link', 'unsubscribe_link', 'app_name'],
    sample: { name: 'Ada', list_name: 'Real-money launch waitlist', manage_link: 'https://parlance.example/waitlist', unsubscribe_link: 'https://parlance.example/waitlist/unsubscribe?token=SAMPLE', app_name: 'Parlance' },
    defaults: {
      email_subject: "You're on the {{app_name}} real-money waitlist",
      email_text: 'Hi {{name}},\n\nThank you for joining the {{list_name}}. We will email you before {{app_name}} switches to real money. Tell us what you would like to trade in a short survey:\n{{manage_link}}\n\nUnsubscribe with one click: {{unsubscribe_link}}',
      email_html: '<p>Hi {{name}},</p><p>Thank you for joining the {{list_name}}. We will email you before {{app_name}} switches to real money.</p><p><a href="{{manage_link}}">Take the short survey</a></p><p><a href="{{unsubscribe_link}}">Unsubscribe with one click</a></p>',
    },
  },
  'email.waitlist_already': {
    kind: 'email', group: 'Waitlist email', label: 'Already on the list (guest form)', fields: ['email_subject', 'email_text', 'email_html'], vars: ['list_name', 'manage_link', 'unsubscribe_link', 'app_name'],
    sample: { list_name: 'Real-money launch waitlist', manage_link: 'https://parlance.example/waitlist/manage?token=SAMPLE', unsubscribe_link: 'https://parlance.example/waitlist/unsubscribe?token=SAMPLE', app_name: 'Parlance' },
    defaults: {
      email_subject: "You're already on the {{app_name}} real-money waitlist",
      email_text: 'Hello,\n\nSomeone asked to join the {{list_name}} with this email address, but you are already on it. There is nothing more to do.\n\nYour place and survey answers: {{manage_link}}\nUnsubscribe with one click: {{unsubscribe_link}}',
      email_html: '<p>Hello,</p><p>Someone asked to join the {{list_name}} with this email address, but you are already on it. There is nothing more to do.</p><p><a href="{{manage_link}}">Your place and survey answers</a></p><p><a href="{{unsubscribe_link}}">Unsubscribe with one click</a></p>',
    },
  },
  'email.waitlist_newsletter': {
    kind: 'email', group: 'Waitlist email', label: 'Waitlist newsletter (Admin › Waitlists › Newsletter)', fields: ['email_subject', 'email_text', 'email_html'], vars: ['name', 'count', 'target', 'link', 'unsubscribe_link', 'app_name'],
    sample: { name: 'Ada', count: '1,250', target: '5,000', link: 'https://parlance.example/waitlist', unsubscribe_link: 'https://parlance.example/waitlist/unsubscribe?token=SAMPLE', app_name: 'Parlance' },
    defaults: {
      email_subject: 'News from the {{app_name}} real-money waitlist',
      email_text: 'Hi {{name}},\n\n{{count}} people have joined the real-money waitlist so far. Thank you for being one of them. We will tell you the launch date as soon as it is set.\n\n{{link}}\n\nUnsubscribe with one click: {{unsubscribe_link}}',
      email_html: '<p>Hi {{name}},</p><p>{{count}} people have joined the real-money waitlist so far. Thank you for being one of them. We will tell you the launch date as soon as it is set.</p><p><a href="{{link}}">See the waitlist</a></p><p><a href="{{unsubscribe_link}}">Unsubscribe with one click</a></p>',
    },
  },
  'email.waitlist_launch': {
    kind: 'email', group: 'Waitlist email', label: "We're live with real money (offered after the production switch)", fields: ['email_subject', 'email_text', 'email_html'], vars: ['name', 'link', 'unsubscribe_link', 'app_name'],
    sample: { name: 'Ada', link: 'https://parlance.example/funds', unsubscribe_link: 'https://parlance.example/waitlist/unsubscribe?token=SAMPLE', app_name: 'Parlance' },
    defaults: {
      email_subject: "We're live with real money on {{app_name}}",
      email_text: 'Hi {{name}},\n\nYou asked us to tell you first: {{app_name}} now runs on real money. Play balances were reset when we switched. Deposit and start trading:\n{{link}}\n\nUnsubscribe with one click: {{unsubscribe_link}}',
      email_html: '<p>Hi {{name}},</p><p>You asked us to tell you first: {{app_name}} now runs on real money. Play balances were reset when we switched.</p><p><a href="{{link}}">Deposit and start trading</a></p><p><a href="{{unsubscribe_link}}">Unsubscribe with one click</a></p>',
    },
  },
  'email.waitlist_target_admin': {
    kind: 'email', group: 'Waitlist email', label: 'Launch target reached (staff alert)', fields: ['email_subject', 'email_text', 'email_html'], vars: ['count', 'target', 'link', 'app_name'],
    sample: { count: '5,000', target: '5,000', link: 'https://parlance.example/admin/waitlists', app_name: 'Parlance' },
    defaults: {
      email_subject: '{{app_name}}: the launch waitlist reached its target',
      email_text: '{{count}} confirmed members have joined the real-money launch waitlist (target {{target}}).\n\nNothing switches automatically: the switch to production stays the two-person, RESET-confirmed flow in Admin › Play mode.\n\n{{link}}',
      email_html: '<p>{{count}} confirmed members have joined the real-money launch waitlist (target {{target}}).</p><p>Nothing switches automatically: the switch to production stays the two-person, RESET-confirmed flow in Admin › Play mode.</p><p><a href="{{link}}">Open Admin › Waitlists</a></p>',
    },
  },
  'sms.phone_code': {
    kind: 'sms', group: 'Text messages', label: 'Phone verification code', fields: ['sms'], vars: ['code', 'minutes', 'app_name'],
    sample: { code: '482913', minutes: '10', app_name: 'Parlance' },
    defaults: { sms: 'Your Parlance code is {{code}}. It expires in {{minutes}} minutes. Never share it with anyone.' },
  },
  // Phase 8 (CLONE_SPEC.md §38.7): the SMS notification channel (simulated provider adapter, flag `sms`, off by default).
  'sms.notification': {
    kind: 'sms', group: 'Text messages', label: 'Notification by SMS (money, security, fills, price alerts)', fields: ['sms'], vars: ['title', 'body', 'app_name'],
    sample: { title: 'Order filled', body: 'Bought 10 YES at ₦64.', app_name: 'Parlance' },
    defaults: { sms: '{{app_name}}: {{title}}. {{body}} Reply STOP or switch SMS off in Settings.' },
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
