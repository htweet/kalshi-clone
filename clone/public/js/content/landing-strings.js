// Text catalog defaults for the layout variants (public/js/views/landing.js, views/layout-parts.js; CLONE_SPEC.md §44).
// Admin overrides live in the database (Admin › Content › Texts); this object is only the default. Keys:
// <area>.<section>.<slug>; {name} placeholders are the declared variables. The object between the markers must stay
// strict JSON: the server reads it to build the catalog (server/cms/texts.js).
import { register } from '../i18n.js';

export const STRINGS = /* CONTENT_JSON_BEGIN */ {
  "landing.title": "Parlance Exchange — trade on what happens next",
  "landing.h1": "Parlance Exchange: trade on the outcome of real-world events",
  "landing.hero.carousel": "carousel",
  "landing.hero.label": "Featured markets",
  "landing.hero.slide": "slide",
  "landing.hero.of": "{value} of {total}",
  "landing.hero.previous": "Previous market",
  "landing.hero.next": "Next market",
  "landing.hero.pause": "Pause the carousel",
  "landing.hero.play": "Play the carousel",
  "landing.volume": "{money} volume",
  "landing.read_more": "Read more ⌄",
  "landing.read_less": "Read less ⌃",
  "landing.ticker.label": "Weekly forecasts",
  "landing.ticker.pause": "Pause the weekly forecasts",
  "landing.ticker.play": "Play the weekly forecasts",
  "landing.change_1d": "({value} 1D)",
  "landing.up": "up",
  "landing.down": "down",
  "landing.watch.heading": "Markets to watch",
  "landing.promo.invest": "Invest",
  "landing.promo.perps": "Trade the next big move in crypto, gold and oil",
  "landing.promo.apy": "Earn {apy}% APY on your cash",
  "landing.hub.default": "{category} hub",
  "landing.monthly.heading": "Monthly forecasts",
  "landing.monthly.forecasted": "forecasted",
  "landing.monthly.chance": "chance",
  "landing.live": "Live",
  "landing.closes": "Closes {day}",
  "landing.no_trades_yet": "No trades yet.",
  "landing.chart_sr": "{label}: {lines}; from {from} to {to}",
  "landing.note": "Prices are set by traders on an open order book. <b>Simulated funds only.</b> <a href=\"/support/responsible-trading\">Trade responsibly</a>."
} /* CONTENT_JSON_END */;
export const META = /* CONTENT_META_BEGIN */ {
  "landing.note": { "rich": true }
} /* CONTENT_META_END */;
register(STRINGS, META);
