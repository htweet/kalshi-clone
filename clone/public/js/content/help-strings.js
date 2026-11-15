// Text catalog defaults for public/js/views/help.js — the Help Center (CLONE_SPEC.md §40, §32.3). The guides themselves
// are CMS pages (Admin › Content › Pages, help/<slug>); these are the labels around them and the topic names. The object
// between the markers must stay strict JSON: the server reads it to build the catalog (server/cms/texts.js).
import { register } from '../i18n.js';

export const STRINGS = /* CONTENT_JSON_BEGIN */ {
  "help.home.title": "Help center",
  "help.home.doc_title": "Help center · Parlance",
  "help.home.description": "Step-by-step guides for trading, money, your account and every Parlance feature.",
  "help.home.see_all": "See all {count} guides",
  "help.search.label": "Search the help center",
  "help.search.placeholder": "Search for help, e.g. withdraw, two-factor, sell",
  "help.search.submit": "Search",
  "help.search.results_for": "Results for “{query}”",
  "help.search.no_results": "No guides match your search. Try other words, or contact support below.",
  "help.search.all_topics": "Browse all topics",
  "help.category.getting-started.title": "Getting started",
  "help.category.getting-started.description": "Create your account, verify your identity and find your way around.",
  "help.category.trading.title": "Trading",
  "help.category.trading.description": "Prices, placing and selling orders, alerts, settlement and fees.",
  "help.category.money.title": "Money",
  "help.category.money.description": "Deposits, withdrawals, statements and your activity.",
  "help.category.account-security.title": "Account & security",
  "help.category.account-security.description": "Sign-in, two-factor login, passkeys, limits, notifications and your data.",
  "help.category.features.title": "Features",
  "help.category.features.description": "Elections hub, rewards and referrals, social, API keys and the waitlist.",
  "help.category.troubleshooting.title": "Troubleshooting",
  "help.category.troubleshooting.description": "Fix pages that do not load, rejected orders and verification problems.",
  "help.category.more.title": "More help",
  "help.category.more.description": "More articles from the Parlance team.",
  "help.guide.doc_title": "{title} · Parlance Help",
  "help.guide.breadcrumb": "Breadcrumb",
  "help.guide.topic_guides": "Guides in {topic}",
  "help.guide.related": "Related guides",
  "help.guide.not_found": "We couldn’t find that guide",
  "help.guide.not_found_body": "It may have moved. Search the help center or browse the topics.",
  "help.guide.back_home": "Help center home",
  "help.feedback.question": "Was this guide helpful?",
  "help.feedback.yes": "Yes",
  "help.feedback.no": "No",
  "help.feedback.what_was_missing": "What was missing or unclear? (optional)",
  "help.feedback.send": "Send feedback",
  "help.feedback.thanks": "Thanks for your feedback.",
  "help.feedback.thanks_tell_more": "Thanks. Tell us what was missing so we can improve this guide.",
  "help.contact.title": "Still need help?",
  "help.contact.body": "Our support team in Nigeria replies within one working day.",
  "help.contact.contact_support": "Contact support",
  "help.contact.faq": "FAQ",
  "help.contact.status": "System status"
} /* CONTENT_JSON_END */;
export const META = /* CONTENT_META_BEGIN */ {} /* CONTENT_META_END */;
register(STRINGS, META);
