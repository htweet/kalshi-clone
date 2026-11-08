// Text catalog defaults for public/js/views/share.js: the share sheet, copy-trade and your share links (CLONE_SPEC.md §32.3, §38). Admin overrides live in the database (Admin ›
// Content › Texts); this object is only the default. Keys: <area>.<section>.<slug>; {name} placeholders are the declared
// variables. The object between the markers must stay strict JSON: the server reads it to build the catalog
// (server/cms/texts.js).
import { register } from '../i18n.js';

export const STRINGS = /* CONTENT_JSON_BEGIN */ {
  "share.title": "Share",
  "share.title_position": "Share your position",
  "share.title_trade": "Share your trade",
  "share.channel.whatsapp": "WhatsApp",
  "share.channel.x": "X",
  "share.channel.facebook": "Facebook",
  "share.channel.telegram": "Telegram",
  "share.channel.copy": "Copy link",
  "share.link_label": "Share link",
  "share.copied": "Link copied",
  "share.copy_manually": "Select the link and copy it",
  "share.close": "Close",
  "share.sign_in": "Log in to share your positions and trades.",
  "share.show_legend": "What others will see",
  "share.show_side": "Side (Yes or No)",
  "share.show_price": "Price",
  "share.show_size": "Number of contracts",
  "share.copy_note": "Friends who open the link can copy your trade: their ticket is filled in for them to check. Nothing is ever traded for them.",
  "share.no_copy_note": "Friends who open the link see the market and what you chose to show.",
  "share.create": "Create share link",
  "share.text_trade": "I bought {side} on \"{title}\" on Parlance. Copy my trade:",
  "share.text_position": "I hold {side} on \"{title}\" on Parlance.",
  "share.links_title": "Your share links",
  "share.links_intro": "Every link you shared, how many times it was opened and how many people signed up from it. Revoke a link to stop it working.",
  "share.col.link": "Link",
  "share.col.opens": "Opens",
  "share.col.signups": "Sign-ups",
  "share.col.actions": "Actions",
  "share.kind.market": "Market",
  "share.kind.event": "Event",
  "share.kind.position": "Position",
  "share.kind.trade": "Trade",
  "share.none": "You have not shared anything yet.",
  "share.revoke": "Revoke",
  "share.revoked": "Revoked",
  "share.revoked_toast": "Link revoked",
  "share.button": "Share",
  "share.copy.banner": "Copied from a trade shared by {name}: {side}{price}{size}. Check the ticket and place your own order; nothing is traded for you.",
  "share.copy.price": " at {price}",
  "share.copy.size": ", {count} contracts",
  "share.copy.gone": "This shared trade is no longer available.",
  "share.share_position": "Share position"
} /* CONTENT_JSON_END */;
export const META = /* CONTENT_META_BEGIN */ {} /* CONTENT_META_END */;
register(STRINGS, META);
