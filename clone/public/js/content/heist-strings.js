// Text catalog defaults for public/js/views/heist.js (CLONE_SPEC.md §33, §32.3). Admin overrides live in the database
// (Admin › Content › Texts); this object is only the default. Keys: <area>.<section>.<slug>; {name} placeholders are the
// declared variables. The object between the markers must stay strict JSON: the server reads it to build the catalog
// (server/cms/texts.js).
import { register } from '../i18n.js';

export const STRINGS = /* CONTENT_JSON_BEGIN */ {
  "heist.page.title": "Vault Heist",
  "heist.page.doc_title": "Vault Heist · Parlance",
  "heist.page.tagline": "Crack the Central Bank's code before the alarm goes off. Play money only.",
  "heist.page.sign_in": "Log in to plan a heist",
  "heist.page.closed": "The Central Bank is closed right now.",
  "heist.page.play_only": "The Vault Heist opens only while Parlance runs on play money.",
  "heist.vault.label": "In the vault",
  "heist.vault.level": "Security level",
  "heist.vault.level_value": "{level} / {max}",
  "heist.rules.title": "How it works",
  "heist.rules.fee": "Pay the crew fee of {fee}. It goes into the vault.",
  "heist.rules.code": "Guess a {digits}-digit code with no repeated digits. You get {guesses} tries and {seconds} seconds.",
  "heist.rules.feedback": "After each try: a teal dot for every right digit in the right place, a ring for a right digit in the wrong place.",
  "heist.rules.loot": "Crack it fast with tries to spare for a bigger cut: up to {share}% of the vault, at most {max} per heist and {day} per day.",
  "heist.rules.jail": "Run out of tries or time and the alarm catches you: the fee is lost and you sit in jail for {minutes} minutes.",
  "heist.rules.level": "Every cracked vault raises the security level: longer codes, fewer tries. It cools down over time.",
  "heist.start.button": "Start the heist · {fee}",
  "heist.start.attempts": "{left} of {total} attempts left today",
  "heist.start.jailed": "In jail until {time}",
  "heist.start.no_attempts": "No attempts left today. Come back tomorrow.",
  "heist.active.time_left": "Time left",
  "heist.active.seconds": "{seconds}s",
  "heist.active.alarm": "Alarm",
  "heist.active.tries_left": "{left} tries left",
  "heist.active.digit": "Digit {n}",
  "heist.active.try": "Try code",
  "heist.active.history": "Your tries",
  "heist.active.no_tries": "No tries yet. The dial is waiting.",
  "heist.active.exact": "{n} right place",
  "heist.active.near": "{n} wrong place",
  "heist.active.invalid": "Enter {digits} different digits.",
  "heist.result.won_title": "Vault cracked!",
  "heist.result.won_body": "You got away with {loot}.",
  "heist.result.won_nothing": "The vault was nearly empty, so the cut is {loot}.",
  "heist.result.lost_title": "The alarm went off",
  "heist.result.lost_body": "The crew fee of {fee} stays in the vault.",
  "heist.result.timeout_title": "Out of time",
  "heist.result.code": "The code was",
  "heist.result.again": "Plan another heist",
  "heist.feed.title": "Live heist feed",
  "heist.feed.empty": "No heists yet. Be the first.",
  "heist.feed.cracked": "{name} cracked the vault: {loot}",
  "heist.feed.caught": "{name} tripped the alarm",
  "heist.feed.timeout": "{name} ran out of time",
  "heist.wanted.title": "Most Wanted",
  "heist.wanted.empty": "Nobody has cracked the vault yet.",
  "heist.wanted.row": "Heists cracked: {heists}"
} /* CONTENT_JSON_END */;
export const META = /* CONTENT_META_BEGIN */ {} /* CONTENT_META_END */;
register(STRINGS, META);
