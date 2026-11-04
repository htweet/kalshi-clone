'use strict';
// Allowlist HTML sanitiser for CMS rich text, page bodies and email HTML (CLONE_SPEC.md §32.9). It never passes markup
// through: the input is tokenised, every text run is re-escaped, and only allowlisted elements are re-emitted, with no
// attributes except `href` on links (https:, mailto: or a site path; never javascript:, data:, vbscript: or
// protocol-relative). Comments, doctype, processing instructions and every other element are dropped; the contents of
// script, style, iframe, object, embed, template, svg, math, textarea, select and noscript are dropped with them.
// Unclosed elements are closed, stray end tags ignored, so the output is always well-formed.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const PROFILES = {
  // Text-catalog keys flagged rich: bold, italic, lists, links, paragraphs, line breaks.
  rich: new Set(['b', 'strong', 'i', 'em', 'ul', 'ol', 'li', 'a', 'p', 'br']),
  // CMS pages and email bodies: the above plus headings and quotes.
  page: new Set(['b', 'strong', 'i', 'em', 'ul', 'ol', 'li', 'a', 'p', 'br', 'h2', 'h3', 'h4', 'blockquote', 'hr']),
};
const VOID = new Set(['br', 'hr']);
const DROP_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'svg', 'math', 'textarea', 'select', 'noscript', 'title', 'head', 'xmp', 'plaintext', 'noembed', 'noframes']);
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, e) => {
  if (e[0] === '#') { const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : ''; }
  return Object.prototype.hasOwnProperty.call(NAMED, e.toLowerCase()) ? NAMED[e.toLowerCase()] : m;
});

// A link target the CMS accepts: https:// URL, mailto:, or a site path ("/help/fees", not "//evil"). Control characters
// and whitespace inside the scheme (used to hide "java\tscript:") are removed before the check.
function safeHref(raw) {
  const v = decode(String(raw ?? '')).replace(/[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, '');
  if (/^\/(?![/\\])[^\s"'<>]*$/.test(v)) return v;
  if (/^https:\/\/[^\s"'<>\\]+$/i.test(v)) { try { const u = new URL(v); return u.protocol === 'https:' && u.hostname ? u.href : null; } catch { return null; } }
  if (/^mailto:[^\s"'<>:\\]+@[^\s"'<>\\]+$/i.test(v)) return v;
  return null;
}

// opts.placeholders: a link target may be exactly one template placeholder (`href="{{link}}"`, email templates); the
// template engine checks the substituted URL with safeHref() when it renders.
function sanitize(input, profile = 'rich', opts = {}) {
  const allowed = PROFILES[profile] || PROFILES.rich;
  const s = String(input ?? '');
  let out = ''; const stack = []; let drop = 0; let i = 0;
  const text = (t) => { if (!drop) out += esc(decode(t)); };
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { text(s.slice(i)); break; }
    text(s.slice(i, lt));
    if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt + 4); i = e < 0 ? s.length : e + 3; continue; }
    const m = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)(\/?)>/.exec(s.slice(lt));
    if (!m) {
      if (/^<[!?/]/.test(s.slice(lt, lt + 2))) { const e = s.indexOf('>', lt); i = e < 0 ? s.length : e + 1; continue; } // <!doctype>, <?pi?>, broken end tag
      text('<'); i = lt + 1; continue;
    }
    i = lt + m[0].length;
    const close = m[1] === '/'; const name = m[2].toLowerCase();
    if (DROP_CONTENT.has(name)) {
      if (!close && !m[4]) drop += 1; else if (close && drop) drop -= 1;
      continue;
    }
    if (drop || !allowed.has(name)) continue;
    if (close) {
      const at = stack.lastIndexOf(name);
      if (at < 0) continue;
      while (stack.length > at) out += `</${stack.pop()}>`;
      continue;
    }
    if (VOID.has(name)) { out += `<${name}>`; continue; }
    if (name === 'a') {
      const hm = /(?:^|\s)href\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(m[3]);
      const rawHref = hm ? (hm[2] ?? hm[3] ?? hm[4]) : null;
      const ph = opts.placeholders && rawHref && /^\{\{\s*([a-z][a-z0-9_]*)\s*\}\}$/.exec(rawHref.trim());
      if (ph) { out += `<a href="{{${ph[1]}}}">`; stack.push('a'); continue; }
      const href = rawHref ? safeHref(rawHref) : null;
      if (!href) { stack.push('a'); out += '<a>'; continue; } // keep the text, drop the target
      const ext = /^https:/i.test(href);
      out += `<a href="${esc(href)}"${ext ? ' rel="noopener noreferrer" target="_blank"' : ''}>`;
      stack.push('a');
      continue;
    }
    if (name === 'li' && stack[stack.length - 1] === 'li') out += `</${stack.pop()}>`;
    if (name === 'p' && stack.includes('p')) { while (stack.includes('p')) out += `</${stack.pop()}>`; }
    out += `<${name}>`; stack.push(name);
  }
  while (stack.length) out += `</${stack.pop()}>`;
  return out;
}

// Plain-text policy (text-catalog keys that are not rich): text is escaped wherever it is shown, and as defence in
// depth markup-like sequences and script URLs are refused when saved.
function plainProblem(v) {
  const s = String(v ?? '');
  if (/<\s*[A-Za-z!/?]/.test(s)) return 'markup is not allowed in plain text (use a rich-text key for formatting)';
  if (/(java|vb)\s*script\s*:|data\s*:\s*text\/html/i.test(s)) return 'script URLs are not allowed';
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) return 'control characters are not allowed';
  return null;
}

module.exports = { sanitize, safeHref, plainProblem, esc, decode };
