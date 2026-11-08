'use strict';
// Server-side wording of Phase 7A (CLONE_SPEC.md §36): the real-money launch waitlist, its consent wording, the opinion
// survey defaults and the newsletter. Keyed templates with named variables; Admin › Content › Texts overrides them as
// `server.waitlists.<key>` (server/cms/texts.js lists this module). Survey questions are CMS entries of type `survey`
// (Admin › Waitlists › Survey); the defaults below seed them until an admin publishes a change.
const catalog = require('./catalog');

const STRINGS = {
  // the consent wording shown next to every join button (its version is a hash of the published wording)
  'consent.text': 'By joining you agree that Parlance may email you about the real-money launch: the launch date, the newsletter and your place on the list. We store your email address encrypted, never sell it, and every email has a one-click unsubscribe. You can leave and delete your data at any time.',
  'list.real_money_launch': 'Real-money launch waitlist',
  'list.perps': 'Perps waitlist',
  // errors
  'error.consent_required': 'Please agree to the consent wording to join.',
  'error.consent_changed': 'The consent wording has changed. Reload the page and read it again before joining.',
  'error.email_invalid': 'Enter a valid email address.',
  'error.link_invalid': 'This link is not valid. Join again to get a new one.',
  'error.link_used': 'This confirmation link has already been used.',
  'error.link_expired': 'This confirmation link has expired. Join again to get a new one.',
  'error.not_joined': 'You are not on this waitlist.',
  'error.not_confirmed': 'Confirm your email address first.',
  'error.survey_closed': 'The survey is closed: answers cannot be changed after the launch.',
  'error.survey_invalid': 'Some answers are not valid.',
  'error.launch_email_unavailable': 'The launch email can be sent once the switch to production has run.',
  'error.launch_email_sent': 'The launch email has already been sent or scheduled.',
  'error.unknown_list': 'There is no such waitlist.',
  // notifications (titles and bodies; the CMS templates notify.<type> wrap them)
  'notify.joined.title': "You're on the real-money waitlist",
  'notify.joined.body': 'We will email you before Parlance switches to real money. You can answer a short survey on the waitlist page.',
  'notify.target.title': 'Launch waitlist target reached',
  'notify.target.body': '{count} confirmed members joined the real-money waitlist (target {target}). The switch to production stays a manual, two-person decision.',
  'notify.launch_offer.title': "Send the \"We're live with real money\" email?",
  'notify.launch_offer.body': 'The switch to production has run. {count} confirmed waitlist members can get the launch email: send it from Admin › Play mode or Admin › Waitlists. It is never sent automatically.',
  // emails
  'greeting.guest': 'there',
  'email.unsubscribe_line': 'Unsubscribe with one click: {link}',
  'email.unsubscribe_html': 'Unsubscribe with one click',
  // survey: naira bands (amounts formatted in the display currency)
  'survey.band': '{min} to {max}',
  'survey.band_open': '{min} or more',
  // survey moderation
  'survey.flag.link': 'contains a link',
  'survey.flag.word': 'contains a blocked word',
  'survey.flag.repeat': 'looks like spam',
  // CSV export header
  'csv.header': 'entry_id,list,status,email,joined_time,confirmed_time,unsubscribed_time,consent_time,consent_version,consent_text_sha256,consent_source,consent_ip_hash,source,utm_source,utm_medium,utm_campaign,ref_code',
};
const s = catalog.scoped('server.waitlists.', STRINGS);

// Opinion survey defaults (PLAN P7A.3): seeded questions for the launch list, Nigerian payment methods and naira bands.
// Bands are in internal cents (1 cent = ₦1 at the NGN display default, CLONE_SPEC.md §30) and formatted for display.
const SURVEY_DEFAULTS = {
  'real_money_launch.would_trade': {
    kind: 'single', sort: 10, required: false, active: true,
    prompt: 'Would you trade on Parlance with real money?',
    options: [{ id: 'yes', label: 'Yes, as soon as it launches' }, { id: 'maybe', label: 'Maybe, I want to see it first' }, { id: 'no', label: 'No, play money is enough for me' }],
  },
  'real_money_launch.first_deposit': {
    kind: 'naira_band', sort: 20, required: false, active: true,
    prompt: 'How much would you expect to deposit first?',
    bands: [{ id: 'b1', min_cents: 0, max_cents: 500000 }, { id: 'b2', min_cents: 500000, max_cents: 2000000 }, { id: 'b3', min_cents: 2000000, max_cents: 10000000 }, { id: 'b4', min_cents: 10000000, max_cents: 50000000 }, { id: 'b5', min_cents: 50000000, max_cents: null }],
  },
  'real_money_launch.payment_method': {
    kind: 'single', sort: 30, required: false, active: true,
    prompt: 'How would you prefer to pay in?',
    options: [{ id: 'bank_transfer', label: 'Bank transfer' }, { id: 'card', label: 'Debit card' }, { id: 'ussd', label: 'USSD' }, { id: 'wallet', label: 'Mobile wallet' }],
  },
  'real_money_launch.markets': {
    kind: 'multi', sort: 40, required: false, active: true,
    prompt: 'Which markets interest you?',
    options: [{ id: 'elections', label: 'Elections and politics' }, { id: 'football', label: 'Football and other sports' }, { id: 'economy', label: 'The economy and the naira' }, { id: 'crypto', label: 'Crypto' }, { id: 'entertainment', label: 'Music, film and entertainment' }, { id: 'weather', label: 'Weather and climate' }],
  },
  'real_money_launch.comment': {
    kind: 'text', sort: 50, required: false, active: true, max_len: 500,
    prompt: 'Anything else you would like us to know?',
  },
};
// Free-text moderation: a short blocklist (invented, inoffensive placeholders plus common spam markers). Admins review
// every comment anyway; a flag only sorts the queue.
const BLOCKED_WORDS = ['viagra', 'casino bonus', 'free money', 'click here', 'whatsapp me', 'loan offer'];

module.exports = { STRINGS, s, SURVEY_DEFAULTS, BLOCKED_WORDS };
