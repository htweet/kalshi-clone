'use strict';
// Server wording for the category pages (owner request 2026-11-15, CLONE_SPEC.md §42): the invented seed markets (Nigerian
// city weather, the Harbor crude commodity), the default category banners, the default hub links and the admin help next
// to every per-category choice. CMS-managed: Admin › Content › Texts overrides any of it as `server.category_pages.<key>`.
const catalog = require('./catalog');

const STRINGS = {
  // ---- invented seed markets
  'seed.high.series': '{city} daily high',
  'seed.high.title': 'Highest temperature in {city} on {date}?',
  'seed.high.sub': 'Daily high at the {city} weather station (°C)',
  'seed.high.rules': 'Resolves to the bracket that holds the highest temperature recorded at the {city} weather station on {date} (West Africa Time), as published by the Parlance Weather Desk.',
  'seed.high.no': 'Not {bracket}',
  'seed.high.series_rules': 'Each event resolves to the bracket that holds the highest temperature recorded at the {city} weather station on its day (West Africa Time), as published by the Parlance Weather Desk.',
  'seed.rain.series': 'Rain today',
  'seed.rain.series_rules': 'Each event resolves YES if at least 0.2 mm of rain is recorded at its city\'s weather station on its day (West Africa Time).',
  'seed.rain.title': 'Will it rain in {city} on {date}?',
  'seed.rain.sub': 'Measurable rain at the {city} station',
  'seed.rain.yes': 'Rain',
  'seed.rain.no': 'No rain',
  'seed.rain.rules': 'Resolves YES if at least 0.2 mm of rain is recorded at the {city} weather station on {date} (West Africa Time).',
  'seed.crude.series': 'Harbor crude oil',
  'seed.crude.title': 'How high will Harbor crude get by the end of next month?',
  'seed.crude.sub': 'Harbor Light crude, front-month settlement',
  'seed.crude.yes': '{price} or above',
  'seed.crude.no': 'Below {price}',
  'seed.crude.series_rules': 'Each event resolves from the invented Harbor Light crude index published by the Parlance Commodities Desk.',
  'seed.crude.rules': 'Resolves YES if the Harbor Light crude index settles at or above {price} on any trading day before the event closes. The index is invented for Parlance and published by the Parlance Commodities Desk.',
  'underlying.crude': 'Harbor Light crude',
  'underlying.flash': 'PLX index',
  // ---- default banners (Admin › Category pages edits them per category)
  'banner.crypto.title': 'Understanding Invest',
  'banner.crypto.body': 'Trade prices up or down with leverage and no expiry, in play money.',
  'banner.crypto.cta': 'Get started',
  'banner.crypto.link': 'Learn about Invest',
  // ---- default hub links
  'hub.economics': 'Rates outlook hub',
  'hub.elections': 'Elections hub',
  'hub.sports': 'Live scores',
  'hub.crypto': 'Invest',
  'hub.companies': 'Public companies hub',
  // ---- default sidebar labels (elections offices are data from the country model)
  'group.by_election': 'Elections',
  'group.international': 'International elections',
  // ---- admin: labels and help next to every per-category choice (ground rule 6)
  'admin.layout.label': 'Page layout',
  'admin.layout.help': 'New: sidebar, featured carousel and market cards. Classic: the earlier list with chips and filters. "Use the site default" follows the owner setting Category page layout (recommended: new).',
  'admin.carousel_size.label': 'Featured carousel size',
  'admin.carousel_size.help': 'How many events the featured carousel cycles through (1 of N). Empty uses the owner setting (recommended: 3); three keeps the carousel quick to scan.',
  'admin.pins.label': 'Pinned featured events (in order)',
  'admin.pins.help': 'One per line: an event ticker, or series:TICKER for the newest open event of a series (useful for markets that roll over, such as 15-minute windows). Pinned events come first; the rest are picked automatically by the last 24 hours of volume, then total volume, then newest.',
  'admin.exclude.label': 'Never feature',
  'admin.exclude.help': 'One per line: an event ticker or series:TICKER. Excluded events are skipped by the automatic pick (a pin still shows).',
  'admin.grouping.label': 'Sidebar groups',
  'admin.grouping.help': 'Automatic groups the category\'s series by their first tag (elections by office, sports by sport). Custom uses the groups below, in this order.',
  'admin.groups.help': 'Each group links to the markets it matches: series (tickers), a tag, an elections office, an elections country or a sports kind (games, lines, futures). Icons are a glyph in a colour, or a square image from the media library.',
  'admin.hub.label': 'Hub link',
  'admin.hub.help': 'The link under the sidebar groups (for example the elections hub). Leave both empty to use the recommended default for the category.',
  'admin.top_cities.label': 'Top cities strip',
  'admin.top_cities.help': 'The strip of city weather cards (Today / Tomorrow) above the title. Recommended: on for Climate, where the daily city markets are.',
  'admin.docked_ticket.label': 'Docked trade ticket',
  'admin.docked_ticket.help': 'On wide screens a trade ticket stays docked on the right and follows the outcome a visitor picks. Recommended: on for Sports.',
  'admin.outcome_avatars.label': 'Outcome avatars',
  'admin.outcome_avatars.help': 'Round initials avatars in the outcome colour next to named outcomes (people, teams, parties). Recommended: on where outcomes are names.',
  'admin.banner.label': 'Category banner',
  'admin.banner.help': 'A promotional banner at the top of the category. Visitors can dismiss it; changing its text shows it again to everyone. Members\' dismissals are stored with the account, visitors\' in the browser.',
  'admin.inherit': 'Use the site default',
  'error.bad_config': 'This category page configuration is not valid.',
};

const s = catalog.scoped('server.category_pages.', STRINGS);
module.exports = { STRINGS, s };
