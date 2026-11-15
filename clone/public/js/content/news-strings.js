// Text catalog defaults for public/js/views/news.js (CLONE_SPEC.md §32.3, §40). Edited by hand when wording changes in
// code. Admin overrides live in the database (Admin › Content › Texts); this object is only the default. Keys:
// <area>.<section>.<slug>; {name} placeholders are the declared variables. The object between the markers must stay
// strict JSON: the server reads it to build the catalog (server/cms/texts.js).
import { register } from '../i18n.js';

export const STRINGS = /* CONTENT_JSON_BEGIN */ {
  "news.item.read_at": "Read the full story at {publisher}",
  "news.item.opens_new_tab": "(opens the publisher’s site in a new tab)",
  "news.strip.title": "In the news",
  "news.strip.note": "Headlines and short excerpts from the publishers named; the full stories are on their sites.",
  "news.strip.events": "Markets:",
  "news.about.title": "About this market",
  "news.about.background": "Background",
  "news.about.resolution": "Resolution notes",
  "news.about.meta": "Parlance market notes · updated {date}. The market rules decide how it settles."
} /* CONTENT_JSON_END */;
export const META = /* CONTENT_META_BEGIN */ {} /* CONTENT_META_END */;
register(STRINGS, META);
