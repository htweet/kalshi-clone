'use strict';
// parlance/no-unescaped-html (PLAN P1.8): flags HTML built from values that are not known to be escaped.
//
// It checks two things:
//   1. Every `${…}` inside a template literal that contains HTML markup (`<tag`, `</tag`, `<!--`), wherever that
//      template is written (view code, builders, helpers).
//   2. Every value written to an HTML sink: `.innerHTML =` / `+=`, `.outerHTML =`, `.srcdoc =`,
//      `.insertAdjacentHTML(pos, html)`.
// A value is "safe" when it cannot carry markup an attacker controls:
//   - literals, numbers, booleans, arithmetic/comparison/unary results, `.length` / `.size`;
//   - calls to an escaper (`esc`, `escapeHTML`, `encodeURIComponent` — configurable);
//   - number/date formatting (`Math.*`, `Number()`, `.toFixed()`, `.toLocaleString()`, `.toISOString()`, …);
//   - calls to a function declared or imported in the module (an HTML builder: its own templates are checked by rule 1);
//   - `cond ? safe : safe`, `a || safe`, `x && safe`, `safe + safe`, string methods on a safe value;
//   - `list.map((x) => safe).join(…)` and `list.map(builderFn).join(…)`;
//   - a `const`/`let` whose initialiser and later assignments are all safe.
// Everything else (object properties from API data, function parameters, unknown method calls) must be wrapped in
// esc(), or the line annotated with
//   // eslint-disable-next-line parlance/no-unescaped-html -- <why this value is safe or already HTML>
// (parlance/require-disable-justification enforces the `-- reason`).

const DEFAULT_ESCAPERS = ['esc', 'escapeHTML', 'escapeHtml', 'encodeURIComponent'];
const NUMERIC_GLOBALS = new Set(['Number', 'parseInt', 'parseFloat', 'Boolean', 'isNaN', 'isFinite']);
const SAFE_OBJECTS = new Set(['Math', 'Number', 'Date']);
const FORMAT_METHODS = new Set(['toFixed', 'toPrecision', 'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString', 'toISOString', 'toUTCString', 'getTime', 'getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours', 'getMinutes', 'getSeconds', 'indexOf', 'findIndex', 'includes', 'startsWith', 'endsWith', 'has', 'some', 'every', 'test']);
// Methods that return (part of) the receiver: safe exactly when the receiver (and any string arguments) are safe.
const STRING_METHODS = new Set(['trim', 'trimStart', 'trimEnd', 'slice', 'substring', 'substr', 'toUpperCase', 'toLowerCase', 'toLocaleUpperCase', 'toLocaleLowerCase', 'padStart', 'padEnd', 'repeat', 'concat', 'at', 'charAt', 'normalize', 'replace', 'replaceAll', 'toString']);
const SINK_PROPS = new Set(['innerHTML', 'outerHTML', 'srcdoc']);
const HTML_RE = /<\/?[a-zA-Z][\w-]*[\s>/]|<\/?[a-zA-Z][\w-]*$|<!--/;

const propName = (m) => (m && m.type === 'MemberExpression' ? (m.computed ? (m.property.type === 'Literal' ? String(m.property.value) : null) : m.property.name) : null);
const unwrap = (n) => (n && n.type === 'ChainExpression' ? n.expression : n);

module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'disallow HTML built from values that are not known to be escaped (XSS)' },
    schema: [{ type: 'object', properties: { escapers: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }],
    messages: {
      interp: 'Unescaped value in HTML template: wrap `{{text}}` in esc(), or annotate why it is safe.',
      sink: 'Value written to {{sink}} is not known to be escaped HTML: `{{text}}`.',
    },
  },
  create(context) {
    const opts = context.options[0] || {};
    const escapers = new Set(opts.escapers || DEFAULT_ESCAPERS);
    const src = context.sourceCode;
    const short = (n) => { const t = src.getText(n).replace(/\s+/g, ' '); return t.length > 60 ? `${t.slice(0, 57)}...` : t; };

    function variableOf(id) {
      let scope = src.getScope(id);
      while (scope) {
        const v = scope.set.get(id.name);
        if (v) return v;
        scope = scope.upper;
      }
      return null;
    }

    // A function declared, assigned to a const, or imported in this module. Its own HTML templates are checked where they
    // are written, so its return value counts as built HTML. Parameters (callbacks handed in) do not qualify.
    function isBuilder(id) {
      const v = variableOf(id);
      return !!v && v.defs.length > 0 && v.defs.every((d) => d.type === 'FunctionName' || d.type === 'ImportBinding' || (d.type === 'Variable' && d.parent && d.parent.kind === 'const'));
    }

    function callbackSafe(fn, seen) {
      fn = unwrap(fn);
      if (!fn) return false;
      if (fn.type === 'Identifier') return isBuilder(fn); // .map(rowHtml): a builder
      if (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression') return false;
      if (fn.body.type !== 'BlockStatement') return safe(fn.body, seen);
      const rets = [];
      const visit = (node) => {
        if (!node || typeof node.type !== 'string') return;
        if (node !== fn && /Function/.test(node.type)) return; // nested functions return elsewhere
        if (node.type === 'ReturnStatement') { rets.push(node.argument); return; }
        for (const k of Object.keys(node)) {
          if (k === 'parent') continue;
          const c = node[k];
          if (Array.isArray(c)) c.forEach(visit); else if (c && typeof c.type === 'string') visit(c);
        }
      };
      visit(fn.body);
      return rets.every((r) => r == null || safe(r, seen));
    }

    // ALL_CAPS bindings are module constants by convention (icon SVG markup, label tables): trusted static content.
    const isConstName = (n) => /^[A-Z][A-Z0-9_]*$/.test(n) && n.length > 1;
    // …unless the constant holds catalog text (ts('…')): admin-editable, so it is checked like any other value.
    const rawTextIn = new Map();
    function holdsRawText(id) {
      const v = variableOf(id);
      if (!v) return false;
      if (rawTextIn.has(v)) return rawTextIn.get(v);
      rawTextIn.set(v, false);
      let found = false;
      const visit = (n) => {
        if (found || !n || typeof n.type !== 'string') return;
        if (n.type === 'CallExpression' && unwrap(n.callee).type === 'Identifier' && catalogKind(unwrap(n.callee)) === 'raw') { found = true; return; }
        if (n.type === 'Identifier' && n !== id && isConstName(n.name) && n.parent && !(n.parent.type === 'MemberExpression' && n.parent.property === n && !n.parent.computed) && holdsRawText(n)) { found = true; return; }
        for (const k of Object.keys(n)) { if (k === 'parent') continue; const c = n[k]; if (Array.isArray(c)) c.forEach(visit); else if (c && typeof c.type === 'string') visit(c); }
      };
      for (const d of v.defs) if (d.type === 'Variable' && d.node.init) visit(d.node.init);
      rawTextIn.set(v, found);
      return found;
    }
    const trustedConst = (id) => isConstName(id.name) && !holdsRawText(id);
    const rootOf = (m) => { let o = unwrap(m); while (o && o.type === 'MemberExpression') o = unwrap(o.object); return o; };
    // A const object/array literal whose values are all safe (e.g. `const label = { open: 'Open', … }`).
    function constTable(id, seen) {
      const v = variableOf(id);
      if (!v || v.defs.length !== 1) return null;
      const d = v.defs[0];
      if (d.type !== 'Variable' || !d.parent || d.parent.kind !== 'const' || !d.node.init) return null;
      let init = unwrap(d.node.init);
      if (init.type === 'CallExpression' && init.arguments[0] && /freeze$/.test(src.getText(init.callee))) init = init.arguments[0];
      return init.type === 'ObjectExpression' || init.type === 'ArrayExpression' ? init : null;
    }
    const tableValues = (t) => (t.type === 'ObjectExpression' ? t.properties.map((p) => (p.type === 'Property' ? p.value : null)) : t.elements);
    function memberSafe(node, seen) {
      if (['length', 'size'].includes(propName(node))) return true;
      const root = rootOf(node);
      if (root && root.type === 'Identifier' && trustedConst(root)) return true;
      const obj = unwrap(node.object);
      if (obj.type !== 'Identifier') return false;
      const t = constTable(obj, seen);
      if (!t) return false;
      const name = node.computed ? null : propName(node);
      if (name && t.type === 'ObjectExpression') {
        const p = t.properties.find((x) => x.type === 'Property' && !x.computed && ((x.key.type === 'Identifier' && x.key.name === name) || (x.key.type === 'Literal' && String(x.key.value) === name)));
        return !!p && safe(p.value, seen);
      }
      return tableValues(t).every((v) => v == null || safe(v, seen));
    }
    // Parameters of a callback iterating a literal table: `[['open', 'Open'], …].map(([k, l]) => …)`.
    const ITER = new Set(['map', 'flatMap', 'forEach', 'filter', 'find', 'some', 'every']);
    function literalDeep(n) {
      n = unwrap(n);
      if (!n) return true;
      if (n.type === 'Literal') return true;
      if (n.type === 'TemplateLiteral') return n.expressions.length === 0;
      if (n.type === 'ArrayExpression') return n.elements.every((e) => e == null || literalDeep(e));
      if (n.type === 'ObjectExpression') return n.properties.every((p) => p.type === 'Property' && literalDeep(p.value));
      if (n.type === 'UnaryExpression') return true;
      return false;
    }
    function paramFromLiteralTable(def) {
      const fn = def.node;
      const call = fn && fn.parent;
      if (!call || call.type !== 'CallExpression') return false;
      const callee = unwrap(call.callee);
      // The index parameter of an iteration callback is a number: `.map((x, i) => …)`, `Array.from(n, (_, i) => …)`.
      const isFrom = src.getText(callee) === 'Array.from' && call.arguments[1] === fn;
      if ((isFrom || (call.arguments[0] === fn && callee.type === 'MemberExpression' && ITER.has(propName(callee)))) && fn.params[1] && fn.params[1].type === 'Identifier' && fn.params[1] === def.name) return true;
      if (call.arguments[0] !== fn) return false;
      if (callee.type !== 'MemberExpression' || !ITER.has(propName(callee))) return false;
      let recv = unwrap(callee.object);
      if (recv.type === 'Identifier') { const t = constTable(recv); if (!t) return false; recv = t; }
      if (recv.type === 'CallExpression') { // Object.entries(CONST) / [..].filter(..)
        const c = unwrap(recv.callee);
        if (c.type === 'MemberExpression' && /^Object\.(entries|keys|values)$/.test(src.getText(c)) && recv.arguments[0] && recv.arguments[0].type === 'Identifier') { const t = constTable(recv.arguments[0]); return !!t && literalDeep(t); }
        return false;
      }
      return (recv.type === 'ArrayExpression' || recv.type === 'ObjectExpression') && literalDeep(recv) && fn.params.indexOf(def.name) <= 0 && fn.params.length >= 1;
    }

    function identifierSafe(id, seen) {
      if (id.name === 'undefined') return true;
      if (trustedConst(id)) return true;
      const v = variableOf(id);
      if (!v || !v.defs.length || seen.has(v)) return seen.has(v); // unknown global → unsafe; recursion → assume ok
      seen.add(v);
      for (const def of v.defs) {
        if (def.type === 'Parameter' && paramFromLiteralTable(def)) continue;
        if (def.type !== 'Variable') return false; // parameters, imports, functions
        if (def.parent && def.parent.kind === 'var') return false;
        if (!def.node.init) {
          // `let x;` then assigned below: safe when every assignment is (checked over the write references).
          const loop = def.parent && def.parent.parent && /^For(In|Of)Statement$/.test(def.parent.parent.type);
          if (loop) return false;
          continue;
        }
        if (!safe(def.node.init, seen)) return false;
      }
      for (const ref of v.references) {
        if (!ref.isWrite() || ref.init) continue;
        const p = ref.identifier.parent;
        if (p.type === 'AssignmentExpression') { if (!safe(p.right, seen)) return false; }
        else if (p.type !== 'UpdateExpression') return false;
      }
      return true;
    }

    // Text-catalog helpers (public/js/i18n.js, CLONE_SPEC.md §32.3), recognised by what they are imported as:
    //   t / ts (and the content modules' t)  plain, admin-editable text: NOT safe in HTML (wrap in esc());
    //   te / tes / tHtml / tr                 escaped template text: safe when every variable passed is safe.
    function catalogKind(id) {
      const v = variableOf(id);
      const d = v && v.defs.length === 1 ? v.defs[0] : null;
      if (!d || d.type !== 'ImportBinding' || !d.parent || d.parent.type !== 'ImportDeclaration') return null;
      if (!/(^|\/)(i18n|[\w.-]+-strings)\.js$/.test(String(d.parent.source.value))) return null;
      const imported = d.node.imported ? d.node.imported.name : null;
      if (imported === 't' || imported === 'ts') return 'raw';
      if (['te', 'tes', 'tHtml', 'tr'].includes(imported)) return 'escaped';
      return null;
    }
    function catalogVarsSafe(node, seen) {
      const v = unwrap(node.arguments[1]);
      if (!v) return true;
      if (v.type !== 'ObjectExpression') return safe(v, seen);
      return v.properties.every((p) => p.type === 'Property' && safe(p.value, seen));
    }

    function callSafe(node, seen) {
      const callee = unwrap(node.callee);
      if (callee.type === 'Identifier') {
        if (escapers.has(callee.name) || NUMERIC_GLOBALS.has(callee.name)) return true;
        if (callee.name === 'String') return node.arguments.every((a) => safe(a, seen));
        const kind = catalogKind(callee);
        if (kind === 'raw') return false;
        if (kind === 'escaped') return catalogVarsSafe(node, seen);
        return isBuilder(callee); // a function declared/imported in this module: an HTML builder
      }
      if (callee.type !== 'MemberExpression') return false;
      const name = propName(callee);
      const obj = unwrap(callee.object);
      if (obj.type === 'Identifier' && SAFE_OBJECTS.has(obj.name)) return true;
      if (name && escapers.has(name)) return true; // e.g. lib.esc(x)
      if (FORMAT_METHODS.has(name)) return true;
      if (name === 'join') {
        const sepOk = node.arguments.every((a) => safe(a, seen));
        if (obj.type === 'ArrayExpression') return sepOk && obj.elements.every((e) => e == null || safe(e.type === 'SpreadElement' ? e.argument : e, seen));
        if (obj.type === 'CallExpression') {
          const inner = unwrap(obj.callee);
          const innerName = propName(inner);
          if (innerName === 'map' || innerName === 'flatMap') return sepOk && callbackSafe(obj.arguments[0], seen);
          if (src.getText(inner) === 'Array.from' && obj.arguments[1]) return sepOk && callbackSafe(obj.arguments[1], seen);
          if (['filter', 'slice', 'sort', 'reverse', 'concat'].includes(innerName)) return sepOk && safe(obj, seen);
        }
        return sepOk && safe(obj, seen);
      }
      if (name === 'map' || name === 'flatMap') return callbackSafe(node.arguments[0], seen);
      // Array methods that return (a subset of) the receiver's own elements.
      if (['filter', 'slice', 'sort', 'reverse', 'flat'].includes(name)) return safe(obj, seen);
      if (name === 'concat' && obj.type !== 'Literal') return safe(obj, seen) && node.arguments.every((a) => safe(a, seen));
      if (STRING_METHODS.has(name)) return safe(obj, seen) && node.arguments.every((a) => a.type === 'Literal' || a.type.endsWith('FunctionExpression') || safe(a, seen));
      return false;
    }

    function safe(node, seen = new Set()) {
      node = unwrap(node);
      if (!node) return true;
      switch (node.type) {
        case 'Literal': return true;
        // An HTML template nested in an expression is checked (and reported) on its own by the TemplateLiteral visitor.
        case 'TemplateLiteral': return looksLikeHtml(node) || node.expressions.every((e) => safe(e, seen));
        case 'TaggedTemplateExpression': return node.tag.type === 'Identifier' && escapers.has(node.tag.name);
        case 'Identifier': return identifierSafe(node, seen);
        case 'MemberExpression': return memberSafe(node, seen);
        case 'ConditionalExpression': return safe(node.consequent, seen) && safe(node.alternate, seen);
        case 'LogicalExpression': return node.operator === '&&' ? safe(node.right, seen) : safe(node.left, seen) && safe(node.right, seen);
        case 'BinaryExpression': return node.operator === '+' ? safe(node.left, seen) && safe(node.right, seen) : true;
        case 'UnaryExpression': case 'UpdateExpression': return true;
        case 'SequenceExpression': return safe(node.expressions[node.expressions.length - 1], seen);
        case 'ArrayExpression': return node.elements.every((e) => e == null || safe(e.type === 'SpreadElement' ? e.argument : e, seen));
        case 'CallExpression': return callSafe(node, seen);
        case 'AssignmentExpression': return safe(node.right, seen);
        default: return false;
      }
    }

    function looksLikeHtml(tpl) { return tpl.quasis.some((q) => HTML_RE.test(q.value.cooked ?? q.value.raw)); }
    const checked = new WeakSet();
    function checkTemplate(tpl) {
      if (checked.has(tpl)) return;
      checked.add(tpl);
      for (const e of tpl.expressions) {
        const ue = unwrap(e);
        if (ue.type === 'TemplateLiteral') { checkTemplate(ue); continue; } // nested template: check its own parts
        if (!safe(e)) context.report({ node: e, messageId: 'interp', data: { text: short(e) } });
      }
    }
    function checkSink(value, sink) {
      const v = unwrap(value);
      if (v.type === 'TemplateLiteral') { checkTemplate(v); return; }
      if (!safe(v)) context.report({ node: value, messageId: 'sink', data: { sink, text: short(value) } });
    }

    return {
      TemplateLiteral(node) {
        if (node.parent && node.parent.type === 'TaggedTemplateExpression') return;
        if (looksLikeHtml(node)) checkTemplate(node);
      },
      AssignmentExpression(node) {
        const name = propName(node.left);
        if (SINK_PROPS.has(name) && (node.operator === '=' || node.operator === '+=')) checkSink(node.right, `.${name}`);
      },
      CallExpression(node) {
        const callee = unwrap(node.callee);
        if (propName(callee) === 'insertAdjacentHTML' && node.arguments[1]) checkSink(node.arguments[1], '.insertAdjacentHTML()');
      },
    };
  },
};
