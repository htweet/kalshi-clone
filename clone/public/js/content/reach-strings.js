// Text catalog defaults for public/js/views/reach-settings.js: data saver, SMS notifications and language in Settings (CLONE_SPEC.md §32.3, §38). Admin overrides live in the database (Admin ›
// Content › Texts); this object is only the default. Keys: <area>.<section>.<slug>; {name} placeholders are the declared
// variables. The object between the markers must stay strict JSON: the server reads it to build the catalog
// (server/cms/texts.js).
import { register } from '../i18n.js';

export const STRINGS = /* CONTENT_JSON_BEGIN */ {
  "reach.title": "Data and messages",
  "reach.saver.label": "Data saver",
  "reach.saver.hint": "Lighter pages for slow or costly mobile data: smaller images, price updates every 10 seconds, and refreshing instead of a live connection when your network is unstable. Nothing plays by itself.",
  "reach.saver.on_toast": "Data saver is on",
  "reach.saver.off_toast": "Data saver is off",
  "reach.sms.label": "SMS notifications",
  "reach.sms.on": "On since {time}: money, security, fills and price alerts are also sent to your verified phone.",
  "reach.sms.off": "Get money, security, fills and price alerts by SMS too (at most {per_day} a day).",
  "reach.sms.phone_needed": "SMS needs a verified phone number.",
  "reach.sms.verify_phone": "Verify your phone",
  "reach.sms.agree": "I agree to the wording above.",
  "reach.sms.tick": "Tick the box to agree before switching SMS on.",
  "reach.sms.turn_on": "Turn on SMS notifications",
  "reach.sms.turn_off": "Turn off SMS notifications",
  "reach.sms.on_toast": "SMS notifications are on",
  "reach.sms.off_toast": "SMS notifications are off",
  "reach.language": "Language"
} /* CONTENT_JSON_END */;
export const META = /* CONTENT_META_BEGIN */ {} /* CONTENT_META_END */;
register(STRINGS, META);
