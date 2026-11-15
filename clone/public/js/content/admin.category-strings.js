// Text catalog defaults for public/js/views/admin/category-pages.js (CLONE_SPEC.md §32.3, §42.5). Admin overrides live in
// the database (Admin › Content › Texts); this object is only the default. The labels and explanations of each choice
// come from the server (server/content/category-pages.js, `server.category_pages.admin.*`). The object between the
// markers must stay strict JSON: the server reads it to build the catalog (server/cms/texts.js).
import { register } from '../i18n.js';

export const STRINGS = /* CONTENT_JSON_BEGIN */ {
  "admin.category.title": "Category pages",
  "admin.category.sub": "Layout, featured carousel, sidebar groups, strips and banner per category. Site defaults (Owner settings): layout {layout}, carousel size {size}.",
  "admin.category.owner_settings": "Owner settings",
  "admin.category.view": "View page",
  "admin.category.category": "Category",
  "admin.category.effective": "Showing the {layout} layout",
  "admin.category.updated": "changed {time}",
  "admin.category.defaults": "recommended defaults",
  "admin.category.featured_now": "Featured now",
  "admin.category.pinned": "pinned",
  "admin.category.none": "None",
  "admin.category.series": "Series in this category",
  "admin.category.auto_groups": "Automatic groups (copy a line into Custom groups to change it)",
  "admin.category.history": "History",
  "admin.category.recommended": "Recommended: {value}.",
  "admin.category.inherit": "Site default ({value})",
  "admin.category.layout_new": "New",
  "admin.category.layout_classic": "Classic",
  "admin.category.grouping_auto": "Automatic",
  "admin.category.grouping_custom": "Custom (the groups below)",
  "admin.category.groups": "Custom groups",
  "admin.category.groups_format": "One group per line: Label | type:value1,value2 | glyph or img:<media id> | #colour. Types: series, tag, office, country, kind. Glyphs: {glyphs}.",
  "admin.category.hub_label": "Hub link label",
  "admin.category.hub_href": "Hub link address",
  "admin.category.banner_title": "Banner title",
  "admin.category.banner_body": "Banner text",
  "admin.category.banner_cta_label": "Main button label",
  "admin.category.banner_cta_href": "Main button address",
  "admin.category.banner_link_label": "Second button label",
  "admin.category.banner_link_href": "Second button address",
  "admin.category.reason": "Reason (audit log)",
  "admin.category.save": "Save",
  "admin.category.saved": "Category page saved",
  "admin.category.reset": "Reset to recommended",
  "admin.category.reset_title": "Reset this category page to the recommended defaults?",
  "admin.category.on": "on",
  "admin.category.off": "off"
} /* CONTENT_JSON_END */;
export const META = /* CONTENT_META_BEGIN */ {} /* CONTENT_META_END */;
register(STRINGS, META);
