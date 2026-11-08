// Text catalog defaults for public/js/views/admin/owner-settings.js: Admin › Owner settings (CLONE_SPEC.md §32.3, §38). Admin overrides live in the database (Admin ›
// Content › Texts); this object is only the default. Keys: <area>.<section>.<slug>; {name} placeholders are the declared
// variables. The object between the markers must stay strict JSON: the server reads it to build the catalog
// (server/cms/texts.js).
import { register } from '../i18n.js';

export const STRINGS = /* CONTENT_JSON_BEGIN */ {
  "admin.owner.title": "Owner settings",
  "admin.owner.intro": "Every owner choice is a switch or a setting (ground rule 6). Each shows the recommended standard default and what it does; a change needs a reason, is audited, and takes effect at once. Settings that affect money or security also ask you to confirm your identity.",
  "admin.owner.on": "On",
  "admin.owner.off": "Off",
  "admin.owner.default": "Default",
  "admin.owner.changed": "Changed",
  "admin.owner.override": "Start option",
  "admin.owner.edit": "Edit",
  "admin.owner.step_up": "needs a fresh step-up",
  "admin.owner.env_cap": "capped at {cap} by the environment",
  "admin.owner.where": "Where it is used",
  "admin.owner.reason": "Reason (recorded in the audit log)",
  "admin.owner.save": "Save",
  "admin.owner.saved": "{label} saved",
  "admin.owner.range": "From {min} to {max}",
  "admin.owner.history": "History",
  "admin.owner.no_history": "Never changed: the recommended default applies.",
  "admin.owner.history_row": "{from} → {to} · {who} · {time}",
  "admin.owner.unit.hours": "{value} hours",
  "admin.owner.unit.days": "{value} days",
  "admin.owner.unit.per_minute": "{value} a minute",
  "admin.owner.unit.percent": "{value}%",
  "admin.owner.unit.seconds": "{value} seconds",
  "admin.owner.unit.count": "{value}",
  "admin.owner.unit_name.hours": "hours",
  "admin.owner.unit_name.days": "days",
  "admin.owner.unit_name.per_minute": "a minute",
  "admin.owner.unit_name.percent": "percent",
  "admin.owner.unit_name.seconds": "seconds",
  "admin.owner.unit_name.count": "number",
  "admin.owner.switches_title": "Switches",
  "admin.owner.switches_intro": "Every feature flag with what it does and its recommended default. Change them in Admin › Feature flags (a reason and a step-up, audited, live).",
  "admin.owner.col.switch": "Switch",
  "admin.owner.col.explanation": "What it does",
  "admin.owner.col.recommended": "Recommended",
  "admin.owner.col.now": "Now",
  "admin.owner.to_flags": "Open Admin › Feature flags",
  "admin.owner.recommended": "Recommended standard: {value}"
} /* CONTENT_JSON_END */;
export const META = /* CONTENT_META_BEGIN */ {} /* CONTENT_META_END */;
register(STRINGS, META);
