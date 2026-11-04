// Progressive Web App user-facing text (CLONE_SPEC.md §31.12): one keyed module so a later CMS can manage it. Views
// reference keys through t('install.item'), never literals. The build (scripts/build.js) and the dev server
// (server/content/pwa.js) read the same object to render the static offline page and the service worker's fallback
// text, so the object between the markers must stay strict JSON (double quotes, no comments, no trailing comma).
// Values are plain text; callers escape them where they go into HTML.
// Key groups: install.* (☰ entry, signed-out menu, iOS steps) · update.* (toast) · offline.* (offline page, worker
// fallback) · push.* (Settings › Notifications › System notifications, the worker's default title).
export const PWA_STRINGS = /* PWA_STRINGS_JSON_BEGIN */ {
  "install.item": "Install app",
  "install.menu_label": "Menu",
  "install.guest_log_in": "Log in",
  "install.guest_sign_up": "Sign up",
  "install.guest_light": "Light mode",
  "install.guest_dark": "Dark mode",
  "install.ios_title": "Install Parlance",
  "install.ios_intro": "Add Parlance to your Home Screen to open it like an app.",
  "install.ios_step_share_before": "Tap",
  "install.ios_step_share_label": "Share",
  "install.ios_step_share_after": "in Safari's toolbar.",
  "install.ios_step_add_before": "Scroll down and tap",
  "install.ios_step_add_label": "Add to Home Screen",
  "install.ios_step_confirm_before": "Tap",
  "install.ios_step_confirm_label": "Add",
  "install.ios_done": "Done",

  "update.message": "New version available",
  "update.reload": "Reload",

  "offline.document_title": "Offline · Parlance",
  "offline.heading": "You're offline",
  "offline.body": "Parlance can't reach the exchange right now. Prices, balances and orders need a connection, so nothing is shown until you're back online.",
  "offline.retry": "Retry",
  "offline.home": "Go to home",
  "offline.fallback_text": "You are offline. Reconnect and reload the page.",

  "push.default_title": "Parlance",
  "push.section_title": "System notifications",
  "push.section_intro": "Web Push shows notifications in your device's notification centre, even when Parlance is closed. They contain only what the in-app notification shows.",
  "push.unsupported": "This browser can't receive system notifications.",
  "push.on": "This device receives system notifications.",
  "push.turn_on": "Turn on for this device",
  "push.turn_off": "Turn off on this device",
  "push.this_device": "This device",
  "push.added": "added",
  "push.last_delivered": "last delivered",
  "push.never": "never",
  "push.failed": "failed",
  "push.send_test": "Send test notification",
  "push.remove": "Remove",
  "push.none": "No device receives system notifications yet.",
  "push.list_unavailable": "Devices are unavailable.",
  "push.toast_on": "System notifications are on for this device",
  "push.toast_off": "System notifications are off for this device",
  "push.toast_test": "Test notification sent",
  "push.toast_removed": "Device removed",
  "push.error_unsupported": "This browser does not support push notifications.",
  "push.error_blocked": "Notifications are blocked for this site. Allow them in your browser settings, then try again.",
  "push.error_not_ready": "The service worker is not ready yet. Reload the page and try again."
} /* PWA_STRINGS_JSON_END */;

// Lookup with a visible fallback, so a missing key shows up in review instead of rendering "undefined".
export const t = (key) => (Object.prototype.hasOwnProperty.call(PWA_STRINGS, key) ? PWA_STRINGS[key] : key);
