#!/usr/bin/env node
'use strict';
// Text-catalog extractor (CLONE_SPEC.md §32.3, PLAN 5C C.1). Moves hard-coded user-facing text out of SPA modules into
// keyed content modules, rewriting each occurrence to a catalog call:
//
//   node scripts/cms-extract.js [--dry] [--report] public/js/views/foo.js …   (default: every SPA module)
//
// What counts as user-facing (the same rules the enforcement check in eslint-rules/no-hardcoded-text.js applies):
//   - text nodes of HTML template literals (`<b>Open orders</b>`), and the values of text attributes (placeholder,
//     title, aria-label, alt, label); interior `${…}` become declared variables: `You have {count} orders`;
//   - string literals and templates that reach such a place through `cond ? 'A' : 'B'`, `a || 'B'`, `'A' + x`;
//   - text written to the DOM or shown to the user: toast()/confirm()/alert()/prompt(), new Error(), .textContent,
//     .innerText, .title, .placeholder, document.title, setAttribute('aria-label'|'title'|'placeholder'|'alt', …);
//   - label properties ({ label: 'Deposit', title: …, hint: …, empty: … }) and arguments of the module's own HTML
//     builders (section('Open orders', …));
//   - any other sentence-like literal (two or more words, starting with a capital letter or ending in punctuation).
// Data values are left alone: CSS class lists, ids, paths, selectors, event names, comparison operands, object keys,
// and capitalised words that the server also uses as data (category names, statuses).
//
// Output per area (file): public/js/content/<area>-strings.js with a strict-JSON block (the server reads it without an
// ESM loader), keys `<area>.<section>.<slug>`; the module imports { t, te, ts } from i18n.js and the content module.
// Module-level occurrences use ts() (evaluated once; see i18n.js). HTML contexts use te() (escaped template, variables
// as given), everything else t() (plain text, escaped by the caller as before).
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const JS = path.join(PUB, 'js');
const CONTENT = path.join(JS, 'content');
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const REPORT = args.includes('--report');
const SKIP_FILES = new Set(['i18n.js', 'dynstyle.js']);

// ------------------------------------------------------------------------------------------------ helpers
const walkDir = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'content' ? [] : walkDir(path.join(d, e.name))) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
const cssClasses = new Set();
for (const f of fs.readdirSync(PUB).filter((x) => x.endsWith('.css'))) for (const m of fs.readFileSync(path.join(PUB, f), 'utf8').matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) cssClasses.add(m[1]);
// Capitalised words the server uses as data (categories, statuses, sports names): never rewritten unless shown as text.
const serverData = new Set();
for (const f of fs.readdirSync(path.join(ROOT, 'server')).filter((x) => x.endsWith('.js'))) {
  try {
    const ast = acorn.parse(fs.readFileSync(path.join(ROOT, 'server', f), 'utf8'), { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true });
    (function w(n) { if (!n || typeof n.type !== 'string') return; if (n.type === 'Literal' && typeof n.value === 'string' && /^[A-Z][\w &.-]{1,40}$/.test(n.value) && !/\s{2}/.test(n.value)) serverData.add(n.value); for (const k of Object.keys(n)) { const v = n[k]; if (Array.isArray(v)) v.forEach(w); else if (v && typeof v.type === 'string') w(v); } })(ast);
  } catch { /* not every server file parses as a script (none expected) */ }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', rarr: '→', larr: '←', uarr: '↑', darr: '↓', times: '×', hellip: '…', mdash: '—', ndash: '–', bull: '•', copy: '©', reg: '®', trade: '™', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', check: '✓', cent: '¢', deg: '°', plusmn: '±', laquo: '«', raquo: '»', rsaquo: '›', lsaquo: '‹', minus: '−', le: '≤', ge: '≥', thinsp: ' ', zwnj: '‌' };
const decodeEntities = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(cp) ? String.fromCodePoint(cp) : m; }
  return Object.prototype.hasOwnProperty.call(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : m;
});
// Raw template text -> [{ch, pos}] with escapes decoded (positions are source offsets).
function cookChars(raw, start) {
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { out.push({ ch: c, pos: start + i, end: start + i + 1 }); continue; }
    const n = raw[i + 1];
    const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
    let ch; let len = 2;
    if (n === 'u') {
      if (raw[i + 2] === '{') { const j = raw.indexOf('}', i); ch = String.fromCodePoint(parseInt(raw.slice(i + 3, j), 16)); len = j - i + 1; } else { ch = String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16)); len = 6; }
    } else if (n === 'x') { ch = String.fromCharCode(parseInt(raw.slice(i + 2, i + 4), 16)); len = 4; } else if (n === '\n') { ch = ''; } else ch = simple[n] ?? n;
    out.push({ ch, pos: start + i, end: start + i + len });
    i += len - 1;
  }
  return out;
}
const letters = (s) => (s.match(/[A-Za-zÀ-ɏ]/g) || []).length;
const hasWord = (s) => /[A-Za-zÀ-ɏ]{2}/.test(s);
const isClassList = (s) => s.trim().split(/\s+/).every((w) => cssClasses.has(w) || /^[a-z0-9]+(-[a-z0-9]+)+$/.test(w));
const identLike = (s) => /^[a-z_$][\w$.:/-]*$/.test(s) || /^[A-Z0-9_]+$/.test(s) || /^[a-z]+([A-Z][a-z0-9]*)+$/.test(s); // ids, paths, CONSTANTS, camelCase
const pathLike = (s) => /^[A-Z][a-z]+(\/[A-Z][A-Za-z_]+)+$/.test(s) || /^[A-Z][A-Z-]*:[^ ]/.test(s) || (/\/\//.test(s) && !/\s/.test(s)) || /^(\/|\.\/|\.\.\/|https?:|mailto:|data:|#|\?|[a-z]+:\/\/)/.test(s) || /^[\w-]+\.(png|svg|js|css|json|csv|pdf|jpg)$/.test(s);
const selectorLike = (s) => /^[.#[]/.test(s) || /^\w+\[/.test(s) || /^[a-z]+(\.[\w-]+)+$/.test(s);
const cssLike = (s) => /^-{0,2}[a-z-]+:\s*[^ ]/.test(s) && !/\s[a-z]+\s[a-z]+\s/.test(s);
// Sentence-like: two or more words, a capital first letter or sentence punctuation.
const sentenceLike = (s) => { const x = s.trim(); return /\s/.test(x) && hasWord(x) && (/^[A-ZÀ-Þ]/.test(x) || /[.!?…:]$/.test(x)) && !pathLike(x) && !isClassList(x) && !cssLike(x); };
// Label-like: a capitalised word or phrase (single words allowed: "Deposit", "Cancel").
const labelLike = (s) => { const x = s.trim(); return hasWord(x) && (/^[A-ZÀ-Þ][a-zß-ÿ’']/.test(x) || sentenceLike(x)) && !pathLike(x) && !selectorLike(x) && !/^[A-Z][a-z]+[A-Z]/.test(x); };
const TEXT_ATTRS = new Set(['placeholder', 'title', 'aria-label', 'alt', 'label', 'aria-description', 'aria-placeholder', 'aria-roledescription', 'aria-valuetext']);
const TEXT_CALLS = new Set(['toast', 'alert', 'confirm', 'prompt']);
const TEXT_PROPS = new Set(['textContent', 'innerText', 'title', 'placeholder', 'ariaLabel', 'label', 'alt']);
const LABEL_KEYS = new Set(['label', 'title', 'text', 'sub', 'subtitle', 'placeholder', 'hint', 'help', 'empty', 'heading', 'description', 'desc', 'message', 'msg', 'caption', 'cta', 'tooltip', 'note', 'intro', 'lede', 'summary', 'legend', 'confirm', 'button', 'btn', 'error', 'ok', 'aria', 'more', 'prompt', 'overline', 'tag', 'badge', 'name', 'short', 'long', 'blurb', 'info', 'detail', 'details', 'action', 'question', 'answer', 'body', 'head', 'what', 'why', 'how']);
// Calls whose string arguments are never text (selectors, events, storage keys, element names, attributes).
const DATA_CALLS = new Set(['querySelector', 'querySelectorAll', 'getElementById', 'closest', 'matches', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'CustomEvent', 'Event', 'getAttribute', 'removeAttribute', 'hasAttribute', 'toggleAttribute', 'add', 'remove', 'toggle', 'contains', 'createElement', 'createElementNS', 'getItem', 'setItem', 'removeItem', 'fetch', 'log', 'warn', 'error', 'debug', 'info', 'NumberFormat', 'DateTimeFormat', 'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString', 'split', 'join', 'replace', 'replaceAll', 'includes', 'startsWith', 'endsWith', 'indexOf', 'lastIndexOf', 'test', 'match', 'matchAll', 'RegExp', 'Date', 'parse', 'stringify', 'encodeURIComponent', 'decodeURIComponent', 'postMessage', 'pushState', 'replaceState', 'navigate', 'subscribe', 'request', 'get', 'post', 'put', 'del', 'patch', 'call', 'has', 'set', 'delete', 'padStart', 'padEnd', 'import', 'require', 'Symbol', 'getPropertyValue', 'setProperty', 'removeProperty', 'getComputedStyle', 'insertAdjacentHTML', 'insertAdjacentElement', 'scrollIntoView', 'focus', 'blob', 'Blob', 'URL', 'URLSearchParams', 'append', 'download', 'emit', 'on', 'off', 'once', 'catSlug', 'catLabel', 'icon', 'evIcon', 'vars', 'te', 't', 'ts', 'tes', 'tx', 'tr', 'T', 'tHtml', 'tc', 'register', 'apiCall', 'route', 'go', 'link', 'href', 'svg', 'path', 'el', 'q', '$', '$$', 'sel', 'byId', 'find', 'filter', 'some', 'every', 'sort', 'localeCompare', 'Notification', 'applyTheme', 'setProp', 'trackEvent']);

// ------------------------------------------------------------------------------------------------ per file
function areaOf(file) {
  const rel = path.relative(JS, file).replace(/\\/g, '/').replace(/\.js$/, '');
  if (rel === 'main') return 'shell';
  return rel.replace(/^views\//, '').replace(/\//g, '.');
}
const snake = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
function slugOf(text) {
  const words = text.replace(/\{[a-z0-9_]+\}/gi, ' ').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z0-9]+/g) || ['text'];
  let s = words.slice(0, 5).join('_');
  if (s.length > 40) s = s.slice(0, 40).replace(/_[^_]*$/, '') || s.slice(0, 40);
  if (/^\d/.test(s)) s = `n${s}`;
  return s || 'text';
}

function processFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  const area = areaOf(file);
  let ast;
  try { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', ranges: true, locations: true }); } catch (e) { console.error(`parse ${file}: ${e.message}`); return null; }
  // parent links + enclosing top-level section name + module-level flag
  const all = [];
  (function link(n, parent, section, inFn) {
    if (!n || typeof n.type !== 'string') return;
    n.parent = parent; n.inFn = inFn; n.section = section; all.push(n);
    let sec = section; let fn = inFn;
    if (!inFn) {
      if (n.type === 'FunctionDeclaration' && n.id) sec = n.id.name;
      else if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier') sec = n.id.name;
      else if (n.type === 'ExportDefaultDeclaration') sec = 'default';
    }
    if (/Function/.test(n.type)) fn = true;
    if ((n.type === 'Property' || n.type === 'MethodDefinition') && !inFn && n.key && n.key.type === 'Identifier' && section) sec = `${section}_${n.key.name}`;
    for (const k of Object.keys(n)) {
      if (k === 'parent' || k === 'inFn' || k === 'section') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach((x) => link(x, n, sec, fn)); else if (v && typeof v.type === 'string') link(v, n, sec, fn);
    }
  })(ast, null, '', false);

  // Names already bound in the module: the catalog helpers must not shadow anything.
  const bound = new Set();
  for (const n of all) {
    if (n.type === 'Identifier' && n.parent && ((n.parent.type === 'VariableDeclarator' && n.parent.id === n) || (/Function/.test(n.parent.type) && (n.parent.params.includes(n) || n.parent.id === n)) || n.parent.type === 'ImportSpecifier' || n.parent.type === 'ImportDefaultSpecifier' || n.parent.type === 'CatchClause' || n.parent.type === 'AssignmentPattern' || n.parent.type === 'ArrayPattern' || (n.parent.type === 'Property' && n.parent.parent?.type === 'ObjectPattern'))) bound.add(n.name);
  }
  // A module converted earlier keeps its catalog import: reuse its local names (incremental extraction).
  const i18nImport = ast.body.find((n) => n.type === 'ImportDeclaration' && /(^|\/)i18n\.js$/.test(n.source.value));
  const existingNames = {};
  if (i18nImport) for (const sp of i18nImport.specifiers) if (sp.type === 'ImportSpecifier') { existingNames[sp.imported.name] = sp.local.name; bound.delete(sp.local.name); }
  const names = { t: existingNames.t || (bound.has('t') ? 'tx' : 't'), te: existingNames.te || 'te', ts: existingNames.ts || 'ts', tes: existingNames.tes || 'tes' };
  if (bound.has('te') || bound.has('ts') || bound.has('tes') || (names.t === 'tx' && bound.has('tx'))) { console.error(`${file}: helper names clash (t/te/ts/tx bound locally); skipped`); return null; }

  const strings = {}; // key -> text (new in this run)
  const byText = new Map(); // `${section}\0${text}` -> key
  // Keys already in the area's content module (an earlier run): reused for the same text, never overwritten.
  const existing = readModule(area);
  for (const [k, v] of Object.entries(existing)) { const sec = k.slice(area.length + 1).split('.').slice(0, -1).join('.'); if (!byText.has(`${sec}\0${v}`)) byText.set(`${sec}\0${v}`, k); }
  const taken = (k) => Object.prototype.hasOwnProperty.call(strings, k) || Object.prototype.hasOwnProperty.call(existing, k);
  const repl = []; // { start, end, render(sub) }
  const keyFor = (section, text) => {
    const sec = snake(section || 'common').slice(0, 32) || 'common';
    const id = `${sec}\0${text}`;
    if (byText.has(id)) { const k0 = byText.get(id); if (!(k0 in strings) && existing[k0] === undefined) strings[k0] = text; return k0; }
    let base = `${area}.${sec}.${slugOf(text)}`; let k = base; let i = 2;
    while (taken(k)) k = `${base}_${i++}`;
    strings[k] = text; byText.set(id, k);
    return k;
  };
  const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
  const pad = (lead, call, trail) => (lead || trail ? `(${[lead && q(lead), call, trail && q(trail)].filter(Boolean).join(' + ')})` : call);
  const handled = new Set(); // literal / template nodes already covered

  // Variable name for an interpolated expression.
  function varName(e, used) {
    let n = e;
    for (;;) {
      if (n.type === 'CallExpression' && n.arguments.length === 1 && ['esc', 'String', 'Number'].includes(n.callee.name)) { n = n.arguments[0]; continue; }
      if (n.type === 'ChainExpression') { n = n.expression; continue; }
      break;
    }
    let base = 'value';
    if (n.type === 'Identifier') base = n.name;
    else if (n.type === 'MemberExpression' && !n.computed) base = n.property.name;
    else if (n.type === 'CallExpression') base = n.callee.type === 'Identifier' ? n.callee.name : n.callee.type === 'MemberExpression' && !n.callee.computed ? n.callee.property.name : 'value';
    else if (n.type === 'LogicalExpression' || n.type === 'ConditionalExpression') base = 'value';
    base = snake(base) || 'value';
    if (!/^[a-z]/.test(base)) base = `v_${base}`;
    if (['toFixed', 'to_fixed', 'join', 'map', 'length'].includes(base)) base = 'value';
    let k = base; let i = 2;
    while (used.has(k)) k = `${base}_${i++}`;
    used.add(k);
    return k;
  }

  // Literal-ish descendants of an expression that reach the output (not conditions, not call arguments).
  function outputLeaves(e, cb, escaped = false) {
    if (!e) return;
    if (e.type === 'CallExpression' && e.callee.type === 'Identifier' && ['esc', 'String'].includes(e.callee.name) && e.arguments.length === 1) { outputLeaves(e.arguments[0], cb, true); return; }
    if (escaped) { const c = cb; cb = (leaf) => c(leaf, true); }
    switch (e.type) {
      case 'Literal': if (typeof e.value === 'string') cb(e); return;
      case 'TemplateLiteral': if (!looksHtml(e)) cb(e); return; // HTML templates are handled on their own
      case 'ConditionalExpression': outputLeaves(e.consequent, cb, escaped); outputLeaves(e.alternate, cb, escaped); return;
      case 'LogicalExpression': if (e.operator !== '&&') outputLeaves(e.left, cb, escaped); outputLeaves(e.right, cb, escaped); return;
      case 'BinaryExpression': if (e.operator === '+') { outputLeaves(e.left, cb, escaped); outputLeaves(e.right, cb, escaped); } return;
      case 'SequenceExpression': outputLeaves(e.expressions[e.expressions.length - 1], cb, escaped); return;
      case 'ParenthesizedExpression': outputLeaves(e.expression, cb, escaped); return;
      default:
    }
  }
  const HTML_RE = /<\/?[a-zA-Z][\w-]*[\s>/]|<\/?[a-zA-Z][\w-]*$|<!--/;
  function looksHtml(tpl) { return tpl.quasis.some((qq) => HTML_RE.test(qq.value.cooked ?? qq.value.raw)); }

  // ------------------------------------------------------------ HTML template: lex text runs and text attributes
  function lexHtml(items) {
    const exprCtx = new Map(); // expression node -> 'text' | 'textattr' | 'other'
    let state = 'text'; let run = []; let attrName = ''; let quote = ''; let tagName = ''; let rawUntil = ''; let attrRun = null;
    const runs = [];
    const flush = () => { if (run.length) runs.push({ items: run, attr: false }); run = []; };
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const ch = it.kind === 'c' ? it.ch : null;
      const peek = (o) => { const x = items[i + o]; return x && x.kind === 'c' ? x.ch : null; };
      if (state === 'text') {
        if (it.kind === 'e') { exprCtx.set(it.node, 'text'); run.push(it); continue; }
        if (ch === '<' && (/[A-Za-z/]/.test(peek(1) || '') || peek(1) === '!')) {
          flush();
          if (peek(1) === '!' && peek(2) === '-' && peek(3) === '-') { state = 'comment'; continue; }
          state = 'tagname'; tagName = ''; continue;
        }
        run.push(it); continue;
      }
      if (state === 'comment') { if (ch === '>' && items[i - 1]?.ch === '-' && items[i - 2]?.ch === '-') state = 'text'; continue; }
      if (state === 'raw') { if (ch === '<' && peek(1) === '/') { let s = ''; for (let j = 2; j < 2 + rawUntil.length; j++) s += peek(j) || ''; if (s.toLowerCase() === rawUntil) { state = 'tag'; tagName = ''; } } if (it.kind === 'e') exprCtx.set(it.node, 'other'); continue; }
      if (state === 'tagname') {
        if (it.kind === 'e') { exprCtx.set(it.node, 'other'); state = 'tag'; continue; }
        if (/[\w/-]/.test(ch)) { tagName += ch; continue; }
        state = 'tag'; i -= 1; continue;
      }
      if (state === 'tag') {
        if (it.kind === 'e') { exprCtx.set(it.node, 'other'); continue; }
        if (ch === '>') { const tn = tagName.toLowerCase(); state = (tn === 'script' || tn === 'style') ? 'raw' : 'text'; rawUntil = tn; continue; }
        if (/[A-Za-z_:@-]/.test(ch)) { attrName = ch; state = 'attrname'; continue; }
        continue;
      }
      if (state === 'attrname') {
        if (it.kind === 'e') { exprCtx.set(it.node, 'other'); state = 'tag'; continue; }
        if (/[\w:.@-]/.test(ch)) { attrName += ch; continue; }
        if (ch === '=') { state = 'beforeval'; continue; }
        state = 'tag'; i -= 1; continue;
      }
      if (state === 'beforeval') {
        if (ch === '"' || ch === "'") { quote = ch; state = 'attrval'; attrRun = TEXT_ATTRS.has(attrName.toLowerCase()) ? [] : null; continue; }
        if (it.kind === 'e') { exprCtx.set(it.node, 'other'); state = 'tag'; continue; }
        if (/\s/.test(ch)) continue;
        state = 'unquoted'; continue;
      }
      if (state === 'unquoted') { if (it.kind === 'e') { exprCtx.set(it.node, 'other'); continue; } if (/\s/.test(ch)) state = 'tag'; else if (ch === '>') { state = 'text'; } continue; }
      if (state === 'attrval') {
        if (it.kind === 'c' && ch === quote) { if (attrRun && attrRun.length) runs.push({ items: attrRun, attr: true }); attrRun = null; state = 'tag'; continue; }
        if (it.kind === 'e') exprCtx.set(it.node, attrRun ? 'textattr' : 'other');
        if (attrRun) attrRun.push(it);
        continue;
      }
    }
    flush();
    return { runs, exprCtx };
  }
  // An HTML string literal ('<b>Open orders</b>'): rewritten into a template literal with te() runs.
  function processHtmlLiteral(lit) {
    handled.add(lit);
    const raw = src.slice(lit.start + 1, lit.end - 1);
    const chars = cookChars(raw, lit.start + 1).map((c) => ({ kind: 'c', ...c }));
    const { runs } = lexHtml(chars);
    const spans = [];
    for (const r of runs) {
      const its = r.items.slice();
      while (its.length && /^[ \t\n\r]*$/.test(its[0].ch)) its.shift();
      while (its.length && /^[ \t\n\r]*$/.test(its[its.length - 1].ch)) its.pop();
      if (!its.length) continue;
      const text = decodeEntities(its.map((x) => x.ch).join('')).replace(/[ \t\n\r]+/g, ' ').trim();
      if (letters(text) < 2 || !hasWord(text)) continue;
      spans.push({ from: its[0].pos, to: its[its.length - 1].end, key: keyFor(lit.section, text) });
    }
    if (!spans.length) return;
    const tplEsc = (ch) => (ch === '`' ? '\\`' : ch === '\\' ? '\\\\' : ch === '$' ? '\\$' : ch === '\n' ? '\\n' : ch);
    let out = '`';
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      const sp = spans.find((s) => s.from === c.pos);
      if (sp) { out += `\${${lit.inFn ? names.te : names.tes}(${q(sp.key)})}`; while (i < chars.length && chars[i].pos < sp.to) i++; i--; continue; }
      out += tplEsc(c.ch);
    }
    out += '`';
    repl.push({ start: lit.start, end: lit.end, render: () => out });
  }
  function processHtml(tpl) {
    handled.add(tpl);
    const items = []; // {kind:'c', ch, pos, end} | {kind:'e', node, idx}
    tpl.quasis.forEach((qq, i) => {
      for (const c of cookChars(src.slice(qq.start, qq.end), qq.start)) items.push({ kind: 'c', ...c });
      if (i < tpl.expressions.length) items.push({ kind: 'e', node: tpl.expressions[i], idx: i, pos: qq.end, end: tpl.quasis[i + 1].start });
    });
    const { runs, exprCtx } = lexHtml(items);
    // Literal leaves of expressions in text positions (`${open ? 'Open' : 'Closed'}`) -> te()
    for (const [node, ctx] of exprCtx) {
      if (ctx === 'other') continue;
      const visit = (leaf, escaped = false) => {
        if (handled.has(leaf)) return;
        if (leaf.type === 'Literal') {
          const v = leaf.value;
          if (HTML_RE.test(v)) { if (!escaped) processHtmlLiteral(leaf); return; }
          if (!hasWord(v) || letters(v) < 2 || isClassList(v) || pathLike(v.trim())) return;
          if (!/\s/.test(v.trim()) && /^[a-z]+$/.test(v.trim()) && ctx === 'text' && false) return;
          handled.add(leaf);
          const lead = v.match(/^\s*/)[0]; const trail = v.match(/\s*$/)[0];
          const text = v.trim().replace(/[ \t\n\r]+/g, ' ');
          const key = keyFor(leaf.section, text);
          const call = escaped ? `${leaf.inFn ? names.t : names.ts}(${q(key)})` : `${leaf.inFn ? names.te : names.tes}(${q(key)})`;
          repl.push({ start: leaf.start, end: leaf.end, render: () => pad(lead, call, trail) });
        } else if (leaf.type === 'TemplateLiteral') {
          if (!plainTemplate(leaf, escaped ? 't' : 'te')) for (const e of leaf.expressions) outputLeaves(e, visit, escaped);
        }
      };
      outputLeaves(node, visit);
    }
    for (const r of runs) emitRun(r, tpl);
  }

  function emitRun(r, tpl) {
    let its = r.items.slice();
    const isWs = (x) => x.kind === 'c' && /^[ \t\n\r]*$/.test(x.ch);
    // trim whitespace and edge expressions
    while (its.length && isWs(its[0])) its.shift();
    while (its.length && isWs(its[its.length - 1])) its.pop();
    if (!its.length) return;
    const textOnly = its.filter((x) => x.kind === 'c').map((x) => x.ch).join('');
    const decoded = decodeEntities(textOnly);
    if (letters(decoded) < 2 || !hasWord(decoded)) return;
    if (/^\s*[{}[\];=()]/.test(decoded) && /[{};=]/.test(decoded) && !/\s[a-z]+\s/i.test(decoded)) return; // code / JSON
    const used = new Set();
    const vars = [];
    let text = '';
    let buf = '';
    for (const x of its) {
      if (x.kind === 'c') { buf += x.ch; continue; }
      text += decodeEntities(buf); buf = '';
      const name = varName(x.node, used);
      vars.push({ name, node: x.node });
      text += `{${name}}`;
    }
    text += decodeEntities(buf);
    text = text.replace(/[ \t\n\r]+/g, ' ').trim();
    if (/\{(?![a-z][a-z0-9_]*\})/i.test(text.replace(/\{[a-z][a-z0-9_]*\}/g, '')) && /\{[a-z][a-z0-9_]*\}/i.test(decoded)) { console.error(`${file}: literal {name} in text, check manually: ${text}`); }
    const key = keyFor(tpl.section, text);
    const start = its[0].pos; // an expression item spans its `${` … `}` delimiters
    const end = its[its.length - 1].end;
    repl.push({ start, end, render: (sub) => `\${${tpl.inFn ? names.te : names.tes}(${q(key)}${vars.length ? `, { ${vars.map((v) => (v.node.type === 'Identifier' && v.node.name === v.name ? v.name : `${v.name}: ${sub(v.node.start, v.node.end)}`)).join(', ')} }` : ''})}` });
  }

  // A non-HTML template literal that is user-facing text -> fn('key', { vars })
  function plainTemplate(tpl, fn) {
    if (handled.has(tpl)) return false;
    const lit = tpl.quasis.map((x) => x.value.cooked ?? '').join(' ');
    if (letters(lit) < 2 || !hasWord(lit) || pathLike(lit.trim()) || isClassList(lit) || (selectorLike(lit.trim()) && !/\s/.test(lit.trim()))) return false;
    handled.add(tpl);
    const used = new Set();
    const vars = [];
    let text = '';
    tpl.quasis.forEach((qq, i) => {
      text += qq.value.cooked ?? '';
      if (i < tpl.expressions.length) { const name = varName(tpl.expressions[i], used); vars.push({ name, node: tpl.expressions[i] }); text += `{${name}}`; }
    });
    const lead = text.match(/^[ \t\n\r]*/)[0]; const trail = text.match(/[ \t\n\r]*$/)[0];
    text = text.trim().replace(/[ \t\n\r]+/g, ' ');
    const key = keyFor(tpl.section, text);
    const f = fn === 'te' ? (tpl.inFn ? names.te : names.tes) : tpl.inFn ? names.t : names.ts;
    repl.push({ start: tpl.start, end: tpl.end, render: (sub) => {
      const call = `${f}(${q(key)}${vars.length ? `, { ${vars.map((v) => (v.node.type === 'Identifier' && v.node.name === v.name ? v.name : `${v.name}: ${sub(v.node.start, v.node.end)}`)).join(', ')} }` : ''})`;
      return pad(lead, call, trail);
    } });
    return true;
  }

  function stringLiteral(lit, fn) {
    if (handled.has(lit)) return;
    handled.add(lit);
    const v = lit.value;
    const lead = v.match(/^[ \t\n\r]*/)[0]; const trail = v.match(/[ \t\n\r]*$/)[0];
    const text = v.trim().replace(/[ \t\n\r]+/g, ' ');
    const key = keyFor(lit.section, text);
    const f = fn === 'te' ? (lit.inFn ? names.te : names.tes) : lit.inFn ? names.t : names.ts;
    const call = `${f}(${q(key)})`;
    repl.push({ start: lit.start, end: lit.end, render: () => pad(lead, call, trail) });
  }

  // ------------------------------------------------------------ classify string literals / plain templates
  const calleeName = (c) => (c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' && !c.computed ? c.property.name : null);
  const localFns = new Set();
  for (const n of all) {
    if (n.type === 'FunctionDeclaration' && n.id) localFns.add(n.id.name);
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init && /Function/.test(n.init.type)) localFns.add(n.id.name);
  }
  const comparedValues = new Set();
  for (const n of all) {
    if (n.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(n.operator)) for (const s of [n.left, n.right]) if (s.type === 'Literal' && typeof s.value === 'string') comparedValues.add(s.value);
    if (n.type === 'SwitchCase' && n.test && n.test.type === 'Literal') comparedValues.add(n.test.value);
    if (n.type === 'Property' && !n.computed && n.key.type === 'Literal') comparedValues.add(n.key.value);
  }

  // Walks up through output-preserving wrappers; returns the context node and the child below it.
  function contextOf(node) {
    let child = node; let p = node.parent;
    while (p) {
      if (p.type === 'ConditionalExpression' && p.test !== child) { child = p; p = p.parent; continue; }
      if (p.type === 'LogicalExpression' && !(p.operator === '&&' && p.left === child)) { child = p; p = p.parent; continue; }
      if (p.type === 'BinaryExpression' && p.operator === '+') { child = p; p = p.parent; continue; }
      if (p.type === 'TemplateLiteral' && !looksHtml(p)) { child = p; p = p.parent; continue; }
      if (p.type === 'SequenceExpression' || p.type === 'ParenthesizedExpression' || p.type === 'ChainExpression') { child = p; p = p.parent; continue; }
      if (p.type === 'CallExpression' && p.callee.type === 'Identifier' && ['esc', 'String'].includes(p.callee.name) && p.arguments[0] === child) { child = p; p = p.parent; continue; }
      break;
    }
    return { p, child };
  }
  function strongContext(node) {
    const { p, child } = contextOf(node);
    if (!p) return null;
    if ((p.type === 'CallExpression' || p.type === 'NewExpression') && p.arguments.includes(child)) {
      const name = calleeName(p.callee);
      if (TEXT_CALLS.has(name) || (name === 'Error' && p.type === 'NewExpression')) return 'strong';
      if (name === 'insertAdjacentHTML' && p.arguments[1] === child) return 'html';
      if (name === 'h' && p.arguments.indexOf(child) >= 2) return 'strong'; // h(tag, attrs, ...children): text children
      if (name === 'setAttribute' && p.arguments[1] === child && p.arguments[0].type === 'Literal' && TEXT_ATTRS.has(String(p.arguments[0].value))) return 'strong';
      if (name && localFns.has(name) && p.callee.type === 'Identifier') return 'builder';
      if (name && DATA_CALLS.has(name)) return 'data';
      return 'call';
    }
    if (p.type === 'AssignmentExpression' && p.right === child) {
      const name = p.left.type === 'MemberExpression' && !p.left.computed ? p.left.property.name : null;
      if (name && TEXT_PROPS.has(name)) return 'strong';
      if (name === 'innerHTML' || name === 'outerHTML') return 'html';
      return 'assign';
    }
    if (p.type === 'Property' && p.value === child && !p.computed) {
      const k = p.key.type === 'Identifier' ? p.key.name : String(p.key.value);
      const call = p.parent && p.parent.parent;
      if (call && call.type === 'CallExpression' && calleeName(call.callee) === 'h' && call.arguments[1] === p.parent) return TEXT_ATTRS.has(k) ? 'strong' : 'data';
      if (LABEL_KEYS.has(k)) return 'label';
      return 'prop';
    }
    if (p.type === 'ThrowStatement') return 'strong';
    if (p.type === 'ReturnStatement' || p.type === 'ArrowFunctionExpression') return 'return';
    if (p.type === 'ArrayExpression') return 'array';
    if (p.type === 'VariableDeclarator') return 'var';
    return p.type;
  }
  const excludedLiteral = (n) => {
    const p = n.parent;
    if (!p) return true;
    if (p.type === 'ImportDeclaration' || p.type === 'ExportNamedDeclaration' || p.type === 'ExportAllDeclaration' || p.type === 'ImportExpression') return true;
    if ((p.type === 'Property' || p.type === 'MethodDefinition' || p.type === 'PropertyDefinition') && p.key === n) return true;
    if (p.type === 'MemberExpression' && p.property === n) return true;
    if (p.type === 'BinaryExpression' && p.operator !== '+') return true;
    if (p.type === 'SwitchCase') return true;
    if (p.type === 'ConditionalExpression' && p.test === n) return true;
    if (p.type === 'TaggedTemplateExpression') return true;
    if (p.type === 'ExpressionStatement' && p.directive) return true;
    return false;
  };

  // HTML templates first (they set contexts for nested leaves), then everything else.
  for (const n of all) if (n.type === 'TemplateLiteral' && !(n.parent && n.parent.type === 'TaggedTemplateExpression') && looksHtml(n)) processHtml(n);
  for (const n of all) {
    if (handled.has(n)) continue;
    if (n.type === 'Literal' && typeof n.value === 'string') {
      if (excludedLiteral(n)) continue;
      const v = n.value; const x = v.trim();
      if (HTML_RE.test(v)) { processHtmlLiteral(n); continue; }
      if (!hasWord(x) || letters(x) < 2 || pathLike(x) || selectorLike(x) || isClassList(x)) continue;
      const ctx = strongContext(n);
      if (ctx === 'data') continue;
      if (ctx === 'html') { stringLiteral(n, 'te'); continue; }
      const sentence = sentenceLike(x);
      const label = labelLike(x) && !comparedValues.has(v) && !serverData.has(x) && !identLike(x);
      let ok = false;
      if (ctx === 'strong') ok = !identLike(x) || /\s/.test(x) || /^[A-Z][a-z]/.test(x);
      else if (ctx === 'label' || ctx === 'builder') ok = label || sentence;
      else if (ctx === 'array' || ctx === 'return' || ctx === 'var' || ctx === 'call' || ctx === 'prop' || ctx === 'assign') ok = sentence || (label && (ctx === 'array' || ctx === 'return' || ctx === 'call') && /^[A-Z][a-z]/.test(x));
      else ok = sentence;
      if (comparedValues.has(v) && !sentence) ok = false;
      if (serverData.has(x) && ctx !== 'strong' && ctx !== 'label' && ctx !== 'builder') ok = false; // API data (categories, statuses)
      if (ok) stringLiteral(n, 't');
    } else if (n.type === 'TemplateLiteral' && !(n.parent && n.parent.type === 'TaggedTemplateExpression') && !looksHtml(n)) {
      const lit = n.quasis.map((x) => x.value.cooked ?? '').join(' ').trim();
      if (!hasWord(lit)) continue;
      const ctx = strongContext(n);
      if (ctx === 'data') continue;
      if (ctx === 'html') { processHtml(n); continue; }
      const sentence = /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(lit) && !pathLike(lit) && !isClassList(lit) && !cssLike(lit);
      const ok = ctx === 'strong' || ((ctx === 'label' || ctx === 'builder') && (sentence || labelLike(lit))) || (sentence && (/^[A-Z]|[.!?…]$/.test(lit.trim()) || /\s(of|in|to|the|a|an|for|at|on|is|are|and|or|your|you)\s/i.test(` ${lit} `)));
      if (ok) plainTemplate(n, 't');
    }
  }

  if (!repl.length) return { file, area, strings, changed: false };
  // ------------------------------------------------------------ apply (nested replacements composed)
  repl.sort((a, b) => a.start - b.start || b.end - a.end);
  // drop exact duplicates / partial overlaps (keep the outer)
  const kept = [];
  for (const r of repl) {
    const clash = kept.find((k) => r.start < k.end && r.end > k.start && !(r.start >= k.start && r.end <= k.end) && !(k.start >= r.start && k.end <= r.end));
    if (clash) { console.error(`${file}: overlapping rewrite at ${r.start}-${r.end} skipped`); continue; }
    if (kept.find((k) => k.start === r.start && k.end === r.end)) continue;
    kept.push(r);
  }
  function sub(start, end) {
    let out = ''; let pos = start;
    const inside = kept.filter((r) => r.start >= start && r.end <= end && !(r.start === start && r.end === end && false));
    const top = inside.filter((r) => !inside.some((o) => o !== r && o.start <= r.start && o.end >= r.end && (o.start !== r.start || o.end !== r.end)));
    for (const r of top.sort((a, b) => a.start - b.start)) {
      out += src.slice(pos, r.start);
      out += r.render((s, e) => sub(s, e));
      pos = r.end;
    }
    return out + src.slice(pos, end);
  }
  let out = sub(0, src.length);
  // imports
  const rel = path.relative(path.dirname(file), JS).replace(/\\/g, '/') || '.';
  const pre = rel === '' || rel === '.' ? './' : `${rel}/`;
  const used = ['t', 'te', 'ts', 'tes'].filter((k) => new RegExp(`\\b${names[k]}\\(`).test(out));
  const imp = `import { ${used.map((k) => (names[k] === k ? k : `${k} as ${names[k]}`)).join(', ')} } from '${pre}i18n.js'; // text catalog (CLONE_SPEC.md §32.3)\nimport '${pre}content/${area}-strings.js';\n`;
  const firstImport = ast.body.find((n) => n.type === 'ImportDeclaration');
  if (i18nImport) {
    const missing = used.filter((k) => !existingNames[k]);
    if (missing.length) {
      const old = src.slice(i18nImport.start, i18nImport.end);
      const specs = [...i18nImport.specifiers.map((sp) => src.slice(sp.start, sp.end)), ...missing.map((k) => (names[k] === k ? k : `${k} as ${names[k]}`))];
      out = out.replace(old, `import { ${specs.join(', ')} } from '${i18nImport.source.value}';`);
    }
  } else {
    if (firstImport) { const at = out.indexOf(src.slice(firstImport.start, firstImport.end)); out = out.slice(0, at) + imp + out.slice(at); } else {
      // after the leading comment block
      const m = out.match(/^(\s*\/\/[^\n]*\n)*/); out = out.slice(0, m[0].length) + imp + out.slice(m[0].length);
    }
  }
  return { file, area, strings, changed: true, out, count: kept.length };
}

function readModule(area) {
  const target = path.join(CONTENT, `${area}-strings.js`);
  if (!fs.existsSync(target)) return {};
  const s = fs.readFileSync(target, 'utf8');
  const a = s.indexOf('/* CONTENT_JSON_BEGIN */'); const b = s.indexOf('/* CONTENT_JSON_END */');
  return a >= 0 && b > a ? JSON.parse(s.slice(a + 24, b)) : {};
}
function writeContentModule(area, strings, file) {
  const target = path.join(CONTENT, `${area}-strings.js`);
  let existing = {};
  if (fs.existsSync(target)) {
    const s = fs.readFileSync(target, 'utf8');
    const a = s.indexOf('/* CONTENT_JSON_BEGIN */'); const b = s.indexOf('/* CONTENT_JSON_END */');
    if (a >= 0 && b > a) existing = JSON.parse(s.slice(a + 24, b));
  }
  const merged = { ...existing, ...strings };
  const body = JSON.stringify(merged, null, 2);
  const src = `// Text catalog defaults for ${path.relative(ROOT, file).replace(/\\/g, '/')} (CLONE_SPEC.md §32.3). Generated by scripts/cms-extract.js,
// edited by hand when wording changes in code. Admin overrides live in the database (Admin › Content › Texts); this
// object is only the default. Keys: <area>.<section>.<slug>; {name} placeholders are the declared variables. The
// object between the markers must stay strict JSON: the server reads it to build the catalog (server/cms/texts.js).
import { register } from '../i18n.js';

export const STRINGS = /* CONTENT_JSON_BEGIN */ ${body} /* CONTENT_JSON_END */;
export const META = /* CONTENT_META_BEGIN */ {} /* CONTENT_META_END */;
register(STRINGS, META);
`;
  if (!DRY) fs.writeFileSync(target, src);
  return Object.keys(merged).length;
}

const targets = args.filter((a) => !a.startsWith('--')).map((a) => path.resolve(a));
const files = (targets.length ? targets : walkDir(JS)).filter((f) => !SKIP_FILES.has(path.basename(f)));
let total = 0;
for (const f of files) {
  const r = processFile(f);
  if (!r || !r.changed) continue;
  total += Object.keys(r.strings).length;
  if (REPORT) for (const [k, v] of Object.entries(r.strings)) console.log(`${k}\t${v}`);
  if (!DRY) { fs.writeFileSync(f, r.out); writeContentModule(r.area, r.strings, f); }
  console.error(`${path.relative(ROOT, f)}: ${r.count} rewrites, ${Object.keys(r.strings).length} keys`);
}
console.error(`total keys: ${total}`);
