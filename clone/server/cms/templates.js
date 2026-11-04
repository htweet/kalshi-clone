'use strict';
// Template engine (CLONE_SPEC.md §32.5): logic-free `{{name}}` substitution with declared variables only, escaped per
// channel. HTML fields (email body, layout footer) are sanitised with the 'page' allowlist when saved; when rendered,
// every variable is HTML-escaped, and a variable used as a link target must be a safe URL (else it becomes "#").
const { TEMPLATES, FIELD_LIMITS, HTML_FIELDS } = require('../content/notification-templates');
const { sanitize, safeHref, plainProblem, esc } = require('./sanitize');

const TAG = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;
const BAD_TAG = /\{\{(?!\s*[a-z][a-z0-9_]*\s*\}\})|\{\{\s*[a-z][a-z0-9_]*\s*\}\}\}/; // {{#if}}, {{> partial}}, {{{raw}}}, {{a.b}}, {{ x | y }} …
const varsIn = (s) => [...new Set([...String(s).matchAll(TAG)].map((m) => m[1]))];

function definition(key) { return Object.prototype.hasOwnProperty.call(TEMPLATES, key) ? TEMPLATES[key] : null; }

// Validates an override (an object with some of the template's fields); returns the cleaned object.
function validate(key, value) {
  const d = definition(key);
  if (!d) throw { key: 'unknown template' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw { value: 'must be an object of template fields' };
  const out = {}; const errs = {};
  for (const [f, v] of Object.entries(value)) {
    if (!d.fields.includes(f)) { errs[f] = `not a field of this template (fields: ${d.fields.join(', ')})`; continue; }
    if (v == null || v === '') continue; // empty = keep the default for this field
    if (typeof v !== 'string') { errs[f] = 'must be text'; continue; }
    if (v.length > (FIELD_LIMITS[f] || 2000)) { errs[f] = `must be at most ${FIELD_LIMITS[f] || 2000} characters`; continue; }
    if (BAD_TAG.test(v)) { errs[f] = 'templates are logic-free: only {{variable}} placeholders are allowed'; continue; }
    const undeclared = varsIn(v).filter((x) => !d.vars.includes(x));
    if (undeclared.length) { errs[f] = `undeclared variable ${undeclared.map((x) => `{{${x}}}`).join(', ')}; this template can use ${d.vars.map((x) => `{{${x}}}`).join(', ')}`; errs.code = 'undeclared_variable'; continue; }
    if (HTML_FIELDS.has(f)) { out[f] = sanitize(v, 'page', { placeholders: true }); continue; }
    const p = plainProblem(v);
    if (p) { errs[f] = p; continue; }
    out[f] = v;
  }
  if (Object.keys(errs).length) throw errs;
  return out;
}

// Fills one field. mode 'html': variables escaped, link targets checked; 'plain': as given.
function fill(tpl, vars, mode) {
  const s = String(tpl ?? '');
  if (mode !== 'html') return s.replace(TAG, (m, k) => (vars[k] == null ? '' : String(vars[k])));
  return s
    .replace(/href="\{\{\s*([a-z][a-z0-9_]*)\s*\}\}"/g, (m, k) => `href="${esc(safeHref(vars[k]) || '#')}"`)
    .replace(TAG, (m, k) => (vars[k] == null ? '' : esc(vars[k])));
}

// Effective field values of a template: published override (or a preview value) over the defaults.
function fields(key, override) {
  const d = definition(key) || definition('notify._default');
  return { ...d.defaults, ...(override || {}) };
}
function renderField(key, field, vars, override) {
  const f = fields(key, override);
  return fill(f[field], vars, HTML_FIELDS.has(field) ? 'html' : 'plain');
}
// The full email: subject, text and HTML (body wrapped in the shared layout).
function renderEmail(key, vars, override, layoutOverride, { headerImage = null, origin = '' } = {}) {
  const f = fields(key, override);
  const L = fields('email._layout', layoutOverride);
  const lv = { app_name: vars.app_name || 'Parlance', year: String(new Date().getUTCFullYear()) };
  const abs = (h) => (h && h.startsWith('/') && origin ? origin + h : h);
  const bodyHtml = fill(f.email_html || `<p>${esc('')}</p>`, vars, 'html').replace(/href="(\/[^"]*)"/g, (m, p) => `href="${esc(abs(p))}"`);
  const footer = fill(L.footer_html, lv, 'html').replace(/href="(\/[^"]*)"/g, (m, p) => `href="${esc(abs(p))}"`);
  const header = headerImage ? `<img src="${esc(abs(headerImage))}" alt="${esc(fill(L.header_text, lv, 'plain'))}" width="600">` : `<strong>${esc(fill(L.header_text, lv, 'plain'))}</strong>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div data-part="header">${header}</div><div data-part="body">${bodyHtml}</div><hr><div data-part="footer">${footer}<p>${esc(fill(L.legal_text, lv, 'plain'))}</p></div></body></html>`;
  const text = `${fill(f.email_text, vars, 'plain')}\n\n--\n${fill(L.legal_text, lv, 'plain')}`;
  return { subject: fill(f.email_subject, vars, 'plain').replace(/[\r\n]+/g, ' '), text, html };
}

function list() {
  return Object.entries(TEMPLATES).map(([key, d]) => ({ key, kind: d.kind, group: d.group, label: d.label, fields: d.fields, vars: d.vars, defaults: d.defaults, sample: d.sample }));
}

module.exports = { validate, fill, fields, renderField, renderEmail, definition, list, varsIn, TEMPLATES };
