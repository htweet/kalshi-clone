'use strict';
// Server-side wording of the content queue (CLONE_SPEC.md §40): the sentences the offline template generator writes for
// a market's description, background and resolution notes. CMS-managed: Admin › Content › Texts overrides any of them as
// `server.content_queue.<key>`; a change applies to content generated afterwards (published text is never rewritten).
const catalog = require('./catalog');

const STRINGS = {
  'template.description.binary': '{title}{subtitle}. This {category} market asks one Yes or No question. Members trade Yes and No contracts, and the Yes price reads as the market’s estimate of the chance that the answer is Yes.',
  'template.description.multi': '{title}{subtitle}. This {category} market has {count} outcomes: {outcomes}. Each outcome trades as its own Yes or No contract, and its Yes price reads as the market’s estimate of the chance that it happens.',
  'template.description.more': 'and {count} more',
  'template.subtitle': ' ({subtitle})',
  'template.background': 'This market is part of the “{series}” series, {frequency}. Trading closes on {close_date}, and the result is expected after {expiry_date}. {sources}',
  'template.sources': 'It settles from: {sources}.',
  'template.no_sources': 'Its settlement source is named in the rules below.',
  'template.resolution.intro': '{rules}',
  'template.resolution.line': '{outcome}: {rule}',
  'template.resolution.default_rule': 'resolves Yes if the settlement source confirms this outcome, otherwise No.',
  'template.resolution.payout': 'A contract pays the full amount when its outcome occurs and nothing otherwise. Settlement follows the confirmation by the settlement source; Parlance Exchange is play money.',
  'frequency.one_off': 'a one-off event',
  'frequency.daily': 'repeated daily',
  'frequency.weekly': 'repeated weekly',
  'frequency.monthly': 'repeated monthly',
  'frequency.fifteen_min': 'repeated every 15 minutes',
  'frequency.custom': 'on its own schedule',
};

const s = catalog.scoped('server.content_queue.', STRINGS);
module.exports = { STRINGS, s };
