// Text catalog defaults for public/js/locale.js: the language switcher and the data saver toggle (CLONE_SPEC.md §32.3, §38). Admin overrides live in the database (Admin ›
// Content › Texts); this object is only the default. Keys: <area>.<section>.<slug>; {name} placeholders are the declared
// variables. The object between the markers must stay strict JSON: the server reads it to build the catalog
// (server/cms/texts.js).
import { register } from '../i18n.js';

export const STRINGS = /* CONTENT_JSON_BEGIN */ {
  "locale.footer.language": "Language",
  "locale.footer.data_saver": "Data saver",
  "locale.saver.on": "Data saver is on: lighter pages and fewer live updates.",
  "locale.saver.off": "Data saver is off."
} /* CONTENT_JSON_END */;
export const META = /* CONTENT_META_BEGIN */ {} /* CONTENT_META_END */;
register(STRINGS, META);
