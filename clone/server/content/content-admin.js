'use strict';
// Server-side wording of Admin › Content › All content (owner request 2026-11-15, CLONE_SPEC.md §41): the content
// type names, API error messages and the default reasons of the registry, revisions and Trash (server/content-admin).
// Keyed templates; Admin › Content › Texts overrides them as `server.contentadmin.<key>` (server/cms/texts.js).
const catalog = require('./catalog');

const STRINGS = {
  // content types (the client shows admin.content_index.type.<type> when the catalog has it, else this name)
  'type.page': 'Pages and help guides',
  'type.text': 'Texts',
  'type.template': 'Notification and email templates',
  'type.media': 'Media slots',
  'type.footer': 'Footer',
  'type.brand': 'Branding',
  'type.incident': 'Status incidents',
  'type.survey': 'Waitlist survey questions',
  'type.banners': 'Site banners',
  'type.promos': 'Promo cards',
  'type.info_cards': 'Info cards',
  'type.news': 'News items',
  'type.help': 'Help collection (More help)',
  'type.hubs': 'Home hubs',
  'type.nav': 'Category navigation',
  'type.hero': 'Home hero carousel',
  'type.promo_codes': 'Promo codes',
  'type.catalog_series': 'Series copy',
  'type.catalog_events': 'Event copy',
  'type.catalog_markets': 'Market copy',
  'type.election_parties': 'Election parties',
  'type.election_candidates': 'Election candidates',
  'type.election_races': 'Election races',
  'type.election_elections': 'Elections',
  // errors
  'error.unknown_type': 'There is no such content type.',
  'error.not_found': 'This item does not exist (it may be in the Trash).',
  'error.no_permission': 'Your role does not include {perm} for this content.',
  'error.cannot_trash': 'This item cannot be moved to the Trash: {why}',
  'error.cannot_edit': 'This content type is edited in its own editor.',
  'error.cannot_publish': 'Publishing and unpublishing do not apply to this content type.',
  'error.key_taken': 'Something with the same key exists again ({key}); rename or trash it before restoring this one.',
  'error.not_in_trash': 'This item is no longer in the Trash.',
  'error.no_revision': 'There is no such version.',
  'error.revision_deleted': 'This version is a deletion; restore the item from the Trash instead.',
  'error.reason_required': 'A reason of 3-500 characters is required.',
  'error.too_many': 'At most {max} items at once.',
  // why an item cannot go to the Trash
  'why.built_in': 'it is built in (reset it to the default, or hide it, instead).',
  'why.has_children': 'it still has {children}; move those first.',
  'why.redeemed': 'it has been redeemed; switch it off instead.',
  'why.published': 'it is live on the exchange; use market operations to pause or close it.',
  'why.no_trash': 'this content type has no Trash; edit or hide it instead.',
  // default reasons
  'reason.purged': 'kept in the Trash for {days} days (owner setting)',
};

const s = catalog.scoped('server.contentadmin.', STRINGS);
module.exports = { STRINGS, s };
