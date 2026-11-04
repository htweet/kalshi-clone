'use strict';
// parlance/no-hardcoded-text (CLONE_SPEC.md §32.10, PLAN 5C C.7): user-facing text in SPA modules must come from the
// text catalog (t() / te() / ts() / tes() / tr() with keys in public/js/content/*-strings.js), so the admin can manage
// it. Like the §27 token check, the heuristic is deliberately concrete:
//   1. text nodes of HTML template literals and HTML string literals (`<b>Open orders</b>`), and the values of text
//      attributes (placeholder, title, aria-label, alt, label): any run with two or more letters outside `${…}`;
//   2. text written to the page or shown to the user: toast(), alert(), confirm(), prompt(), new Error(), and
//      assignments to .textContent / .innerText / .title / .placeholder / .ariaLabel / document.title;
//   3. any other sentence-like string literal or template (two or more words; a capital first letter or ending in
//      sentence punctuation).
// Not text (never reported): strings without two letters in a row (symbols such as ›, ·, ×, %), CSS class lists,
// selectors, paths and URLs, identifiers and ALL-CAPS codes, object keys, comparison operands, arguments of DOM / storage
// / event / formatting APIs, and the catalog calls' own key arguments. ALLOW below lists the remaining data values that
// look like text (category names sent to the API, file-format lines), each with its reason.
// Run scripts/cms-extract.js to move a reported string into the catalog.
const fs = require('node:fs');
const path = require('node:path');

// Data values that look like text. Keep this list short; every entry says why it is not user-facing copy.
const ALLOW = new Set([
  'Climate and Weather', 'Science and Technology', // category names: API data (server/features.js CATEGORIES); labels are keyed
  'PRODID:-//Parlance Exchange//Markets//EN', // iCalendar file header (a file format, not UI text)
  'Parlance', // the service-worker / notification fallback title is keyed in pwa-strings; this literal is a storage namespace
]);
const TEXT_ATTRS = new Set(['placeholder', 'title', 'aria-label', 'alt', 'label', 'aria-description', 'aria-placeholder', 'aria-roledescription', 'aria-valuetext']);
const TEXT_CALLS = new Set(['toast', 'alert', 'confirm', 'prompt']);
const TEXT_PROPS = new Set(['textContent', 'innerText', 'title', 'placeholder', 'ariaLabel']);
const CATALOG = new Set(['t', 'te', 'ts', 'tes', 'tr', 'tx', 'T', 'tHtml', 'tc', 'register', 'errorText']);
const DATA_CALLS = new Set(['querySelector', 'querySelectorAll', 'getElementById', 'closest', 'matches', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'CustomEvent', 'Event', 'getAttribute', 'setAttribute', 'removeAttribute', 'hasAttribute', 'toggleAttribute', 'add', 'remove', 'toggle', 'contains', 'createElement', 'createElementNS', 'getItem', 'setItem', 'removeItem', 'fetch', 'log', 'warn', 'error', 'debug', 'info', 'NumberFormat', 'DateTimeFormat', 'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString', 'split', 'join', 'replace', 'replaceAll', 'includes', 'startsWith', 'endsWith', 'indexOf', 'test', 'match', 'matchAll', 'RegExp', 'parse', 'stringify', 'encodeURIComponent', 'postMessage', 'pushState', 'replaceState', 'navigate', 'subscribe', 'request', 'get', 'post', 'put', 'del', 'patch', 'call', 'has', 'set', 'delete', 'padStart', 'padEnd', 'Symbol', 'setProperty', 'getPropertyValue', 'download', 'Blob', 'URL', 'URLSearchParams', 'append', 'emit', 'catSlug', 'icon', 'vars', 'esc', 'Notification', 'applyTheme', 'setProp', 'localeCompare', 'find', 'filter', 'some', 'every', 'sort', ...CATALOG]);
const HTML_RE = /<\/?[a-zA-Z][\w-]*[\s>/]|<\/?[a-zA-Z][\w-]*$|<!--/;

let classes = null;
function cssClasses() {
  if (classes) return classes;
  classes = new Set();
  const pub = path.join(__dirname, '..', 'public');
  try { for (const f of fs.readdirSync(pub).filter((x) => x.endsWith('.css'))) for (const m of fs.readFileSync(path.join(pub, f), 'utf8').matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) classes.add(m[1]); } catch { /* no stylesheets: class check falls back to the pattern */ }
  return classes;
}
const hasWord = (s) => /[A-Za-zÀ-ɏ]{2}/.test(s);
const isClassList = (s) => s.trim().split(/\s+/).every((w) => cssClasses().has(w) || /^[a-z0-9]+(-[a-z0-9]+)+$/.test(w));
const pathLike = (s) => /^[A-Z][a-z]+(\/[A-Z][A-Za-z_]+)+$/.test(s) || /^(\/|\.\/|\.\.\/|https?:|mailto:|data:|#|\?|[a-z]+:\/\/)/.test(s) || /^[\w-]+\.(png|svg|js|css|json|csv|pdf|jpg)$/.test(s);
const codeLike = (s) => /^[a-z_$][\w$.:/-]*$/.test(s) || /^[A-Z0-9_]+$/.test(s) || /^[a-z]+([A-Z][a-z0-9]*)+$/.test(s) || /[{};=]\s*$/.test(s) || /^[.#[]/.test(s);
const sentenceLike = (s) => { const x = s.trim(); return /\s/.test(x) && /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(x) && (/^[A-ZÀ-Þ]/.test(x) || /[.!?…]$/.test(x)) && !pathLike(x) && !isClassList(x) && !/^-{0,2}[a-z-]+:\s/.test(x); };
const ENT = /&(#x?[0-9a-f]+|[a-z]+);/gi;

// Text runs of an HTML template: quasis lexed as markup; expressions are holes.
function htmlTextRuns(parts) { // parts: array of strings (quasis) — returns [{text, attr}]
  const runs = []; let state = 'text'; let buf = ''; let attr = ''; let quote = ''; let tag = ''; let attrBuf = null;
  const flush = () => { if (hasWord(buf.replace(ENT, ' '))) runs.push({ text: buf.trim(), attr: false }); buf = ''; };
  parts.forEach((q, pi) => {
    for (let i = 0; i < q.length; i++) {
      const c = q[i];
      if (state === 'text') { if (c === '<' && /[A-Za-z/!]/.test(q[i + 1] || '')) { flush(); state = q.startsWith('<!--', i) ? 'comment' : 'tagname'; tag = ''; continue; } buf += c; continue; }
      if (state === 'comment') { if (q.startsWith('-->', i)) { state = 'text'; i += 2; } continue; }
      if (state === 'raw') { if (q.startsWith(`</${tag}`, i)) state = 'tag'; continue; }
      if (state === 'tagname') { if (/[\w/-]/.test(c)) { tag += c; continue; } state = 'tag'; i -= 1; continue; }
      if (state === 'tag') { if (c === '>') { state = /^(script|style)$/i.test(tag) ? 'raw' : 'text'; continue; } if (/[A-Za-z_:@-]/.test(c)) { attr = c; state = 'attrname'; } continue; }
      if (state === 'attrname') { if (/[\w:.@-]/.test(c)) { attr += c; continue; } if (c === '=') { state = 'beforeval'; continue; } state = 'tag'; i -= 1; continue; }
      if (state === 'beforeval') { if (c === '"' || c === "'") { quote = c; state = 'attrval'; attrBuf = TEXT_ATTRS.has(attr.toLowerCase()) ? '' : null; continue; } if (!/\s/.test(c)) state = 'unquoted'; continue; }
      if (state === 'unquoted') { if (/\s/.test(c)) state = 'tag'; else if (c === '>') state = 'text'; continue; }
      if (state === 'attrval') { if (c === quote) { if (attrBuf != null && hasWord(attrBuf.replace(ENT, ' '))) runs.push({ text: attrBuf.trim(), attr: true }); attrBuf = null; state = 'tag'; continue; } if (attrBuf != null) attrBuf += c; continue; }
    }
    if (pi < parts.length - 1) { if (state === 'text') buf += ' '; else if (state === 'attrval' && attrBuf != null) attrBuf += ' '; }
  });
  flush();
  // A bare {{placeholder}} is template syntax shown as an example (Admin › Templates), not copy.
  return runs.filter((r) => !ALLOW.has(r.text) && !/^[\s\d.,:;%+×x·•–—-]*$/.test(r.text) && !/^\{\{\s*\w+\s*\}\}$/.test(r.text));
}

module.exports = {
  meta: {
    type: 'suggestion',
    docs: { description: 'user-facing text must come from the text catalog (Admin › Content › Texts)' },
    schema: [],
    messages: { text: 'Hard-coded user-facing text "{{text}}": move it to the text catalog (t()/te(); scripts/cms-extract.js).' },
  },
  create(context) {
    const report = (node, text) => context.report({ node, messageId: 'text', data: { text: text.length > 60 ? `${text.slice(0, 57)}...` : text } });
    const calleeName = (c) => (c && c.type === 'Identifier' ? c.name : c && c.type === 'MemberExpression' && !c.computed ? c.property.name : null);
    // Walks up through value-preserving wrappers (conditionals, ||, +, parentheses).
    function contextOf(node) {
      let child = node; let p = node.parent;
      while (p && ((p.type === 'ConditionalExpression' && p.test !== child) || (p.type === 'LogicalExpression' && !(p.operator === '&&' && p.left === child)) || (p.type === 'BinaryExpression' && p.operator === '+') || p.type === 'ChainExpression')) { child = p; p = p.parent; }
      return { p, child };
    }
    function excluded(n) {
      const p = n.parent;
      if (!p) return true;
      if (/^(Import|Export)/.test(p.type) || p.type === 'ImportExpression') return true;
      if ((p.type === 'Property' || p.type === 'MethodDefinition' || p.type === 'PropertyDefinition') && p.key === n) return true;
      if (p.type === 'MemberExpression' && p.property === n) return true;
      if (p.type === 'BinaryExpression' && p.operator !== '+') return true;
      if (p.type === 'SwitchCase' || (p.type === 'ConditionalExpression' && p.test === n) || p.type === 'TaggedTemplateExpression') return true;
      if (p.type === 'ExpressionStatement' && p.directive) return true;
      const { p: q, child } = contextOf(n);
      if (q && (q.type === 'CallExpression' || q.type === 'NewExpression') && q.arguments.includes(child)) {
        const name = calleeName(q.callee);
        if (name && DATA_CALLS.has(name) && !(name === 'setAttribute' && q.arguments[1] === child && q.arguments[0].type === 'Literal' && TEXT_ATTRS.has(String(q.arguments[0].value)))) return true;
      }
      return false;
    }
    function strong(n) {
      const { p, child } = contextOf(n);
      if (!p) return false;
      if ((p.type === 'CallExpression' || p.type === 'NewExpression') && p.arguments.includes(child)) {
        const name = calleeName(p.callee);
        if (TEXT_CALLS.has(name) || (name === 'Error' && p.type === 'NewExpression')) return true;
        if (name === 'setAttribute' && p.arguments[1] === child && p.arguments[0].type === 'Literal' && TEXT_ATTRS.has(String(p.arguments[0].value))) return true;
      }
      if (p.type === 'AssignmentExpression' && p.right === child && p.left.type === 'MemberExpression' && !p.left.computed && TEXT_PROPS.has(p.left.property.name)) return true;
      if (p.type === 'ThrowStatement') return true;
      return false;
    }
    function checkString(node, s) {
      const x = s.trim();
      if (!hasWord(x) || ALLOW.has(x) || excluded(node)) return;
      if (HTML_RE.test(x)) { for (const r of htmlTextRuns([s])) report(node, r.text); return; }
      if (pathLike(x) || isClassList(x)) return;
      if (strong(node)) { if (!codeLike(x) || /\s/.test(x)) report(node, x); return; }
      if (sentenceLike(x)) report(node, x);
    }
    return {
      Literal(node) { if (typeof node.value === 'string') checkString(node, node.value); },
      TemplateLiteral(node) {
        if (node.parent && node.parent.type === 'TaggedTemplateExpression') return;
        const parts = node.quasis.map((q) => q.value.cooked ?? q.value.raw);
        if (parts.some((q) => HTML_RE.test(q))) { for (const r of htmlTextRuns(parts)) report(node, r.text); return; }
        const joined = parts.join(' ').trim();
        if (!hasWord(joined) || excluded(node) || ALLOW.has(joined)) return;
        if (strong(node)) { report(node, joined); return; }
        if (sentenceLike(parts.join('{x}').replace(/\{x\}/g, 'x'))) report(node, joined);
      },
      AssignmentExpression(node) { // .innerHTML = '...' plain text without tags is text too
        const name = node.left.type === 'MemberExpression' && !node.left.computed ? node.left.property.name : null;
        if ((name === 'innerHTML' || name === 'outerHTML') && node.right.type === 'Literal' && typeof node.right.value === 'string' && !HTML_RE.test(node.right.value) && hasWord(node.right.value)) report(node.right, node.right.value.trim());
      },
    };
  },
  ALLOW,
  htmlTextRuns,
};
