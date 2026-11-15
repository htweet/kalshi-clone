'use strict';
// News feed fetcher (owner decision 2026-11-15, CLONE_SPEC.md §40.2). Fetches one publisher's public RSS / Atom feed and
// returns headline, link, a short plain-text excerpt, date, guid and the feed's own categories per item — never the
// article body (content:encoded and similar elements are not read).
//
// Bounded and SSRF-safe:
//   - https only; the URL may not carry credentials; ports other than 443 are refused;
//   - every address the host name resolves to must be public (loopback, private, link-local, CGNAT, multicast,
//     documentation and reserved ranges are refused, IPv4-mapped IPv6 included); the connection uses the address that
//     was checked (the custom lookup returns it), so a DNS answer cannot change between the check and the connect;
//   - redirects are followed at most `maxRedirects` times and every hop is checked again;
//   - one deadline for the whole fetch (`timeoutMs`), a size cap on the body as received and after decompression
//     (`maxBytes`), at most `maxItems` items parsed;
//   - test option `allow: ['127.0.0.1:<port>']`: those exact host:port pairs may be fetched over http (a local fixture
//     server); `only: true` refuses every other host before any DNS lookup (no test ever reaches the network).
// Runs in a worker thread (fetching and XML parsing stay off the request thread); falls back to the calling thread when
// a worker cannot be started.
const path = require('node:path');
const { Worker, isMainThread, parentPort } = require('node:worker_threads');

const LIMITS = { timeoutMs: 10000, maxBytes: 2 * 1024 * 1024, maxRedirects: 3, maxItems: 60 };
const UA = 'ParlanceNewsBot/1.0 (headline, link and excerpt with attribution)';

// ------------------------------------------------------------------------------------------------ address policy
let blockList = null;
function blocked(ip) {
  const net = require('node:net');
  if (!blockList) {
    blockList = new net.BlockList();
    for (const [a, b] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blockList.addSubnet(a, b, 'ipv4');
    for (const [a, b] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32], ['2001::', 23], ['2002::', 16], ['100::', 64]]) blockList.addSubnet(a, b, 'ipv6');
  }
  let addr = String(ip || '').replace(/^\[|\]$/g, '');
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (m) addr = m[1];
  const fam = net.isIP(addr);
  if (!fam) return true;
  return blockList.check(addr, fam === 6 ? 'ipv6' : 'ipv4');
}
class FetchError extends Error { constructor(status, message, http) { super(message); this.status = status; this.http = http || null; } }

// Checks a URL against the policy; returns { url, allowLocal } or throws FetchError.
function checkUrl(raw, policy = {}) {
  const net = require('node:net');
  let u;
  try { u = new URL(String(raw)); } catch { throw new FetchError('invalid_url', 'not a valid URL'); }
  const hostPort = `${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
  const allowed = (policy.allow || []).includes(hostPort);
  if (u.username || u.password) throw new FetchError('invalid_url', 'credentials in the URL are not allowed');
  if (!allowed) {
    if (u.protocol !== 'https:') throw new FetchError('https_only', 'only https feeds are fetched');
    if (u.port && u.port !== '443') throw new FetchError('blocked_port', 'only the standard https port is allowed');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && blocked(host)) throw new FetchError('blocked_address', 'the address is private, loopback or reserved');
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) throw new FetchError('blocked_address', 'local host names are not fetched');
    if (policy.only) throw new FetchError('blocked_policy', 'this server only fetches the hosts allowed by its test policy');
  }
  return { url: u, allowLocal: allowed };
}
// dns.lookup wrapper used for the connection: every resolved address must be public; the checked address is used.
function guardedLookup(hostname, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  require('node:dns').lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length) return cb(new FetchError('dns_failed', 'no address'));
    if (addrs.some((a) => blocked(a.address))) return cb(new FetchError('blocked_address', 'the host resolves to a private, loopback or reserved address'));
    const pick = opts.family ? addrs.filter((a) => a.family === opts.family) : addrs;
    if (!pick.length) return cb(new FetchError('dns_failed', 'no address of the requested family'));
    if (opts.all) return cb(null, pick);
    cb(null, pick[0].address, pick[0].family);
  });
}

// ------------------------------------------------------------------------------------------------ fetch
function fetchOnce(u, { allowLocal, deadline, maxBytes, etag, lastModified }) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? require('node:https') : require('node:http');
    const left = deadline - Date.now();
    if (left <= 0) { reject(new FetchError('timeout', 'the feed did not answer in time')); return; }
    const headers = { 'user-agent': UA, accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8', 'accept-encoding': 'gzip, deflate' };
    if (etag) headers['if-none-match'] = etag;
    if (lastModified) headers['if-modified-since'] = lastModified;
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    const req = mod.request(u, { method: 'GET', headers, ...(allowLocal ? {} : { lookup: guardedLookup }), agent: false }, (res) => {
      const status = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(status)) { res.resume(); done(resolve, { redirect: res.headers.location || '', http: status }); return; }
      if (status === 304) { res.resume(); done(resolve, { notModified: true, http: status }); return; }
      if (status < 200 || status >= 300) { res.resume(); done(reject, new FetchError('http_error', `the feed answered HTTP ${status}`, status)); return; }
      const len = Number(res.headers['content-length']);
      if (Number.isFinite(len) && len > maxBytes) { res.destroy(); done(reject, new FetchError('too_large', `the feed is larger than ${maxBytes} bytes`, status)); return; }
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      const zlib = require('node:zlib');
      const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : res;
      let wire = 0; let size = 0; const chunks = [];
      res.on('data', (c) => { wire += c.length; if (wire > maxBytes) { res.destroy(); done(reject, new FetchError('too_large', `the feed is larger than ${maxBytes} bytes`, status)); } });
      stream.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { res.destroy(); stream.destroy?.(); done(reject, new FetchError('too_large', `the feed is larger than ${maxBytes} bytes`, status)); return; }
        chunks.push(c);
      });
      stream.on('end', () => done(resolve, { body: Buffer.concat(chunks).toString('utf8'), http: status, bytes: wire, etag: res.headers.etag || null, lastModified: res.headers['last-modified'] || null }));
      stream.on('error', (e) => done(reject, new FetchError('read_failed', e.message, status)));
      res.on('error', (e) => done(reject, new FetchError('read_failed', e.message, status)));
    });
    const timer = setTimeout(() => { req.destroy(); done(reject, new FetchError('timeout', 'the feed did not answer in time')); }, left);
    req.on('error', (e) => done(reject, e instanceof FetchError ? e : e && e.cause instanceof FetchError ? e.cause : new FetchError(e && e.code === 'ENOTFOUND' ? 'dns_failed' : 'connect_failed', e && e.message ? e.message : 'connection failed')));
    req.end();
  });
}

async function fetchFeed({ url, policy = {}, limits = {}, etag = null, lastModified = null }) {
  const L = { ...LIMITS, ...limits };
  const t0 = Date.now();
  const deadline = t0 + L.timeoutMs;
  let current = url; let hops = 0;
  try {
    for (;;) {
      const { url: u, allowLocal } = checkUrl(current, policy);
      const r = await fetchOnce(u, { allowLocal, deadline, maxBytes: L.maxBytes, etag: hops ? null : etag, lastModified: hops ? null : lastModified });
      if (r.redirect !== undefined) {
        if (!r.redirect) throw new FetchError('http_error', 'redirect without a location', r.http);
        if (++hops > L.maxRedirects) throw new FetchError('too_many_redirects', `more than ${L.maxRedirects} redirects`, r.http);
        current = new URL(r.redirect, u).toString();
        continue;
      }
      if (r.notModified) return { status: 'not_modified', http: r.http, bytes: 0, ms: Date.now() - t0, items: [], etag, lastModified };
      const items = parseFeed(r.body, L.maxItems);
      if (!items.length && !/<(rss|feed|rdf:RDF)\b/i.test(r.body.slice(0, 4096))) throw new FetchError('not_a_feed', 'the answer is not an RSS or Atom feed', r.http);
      return { status: 'ok', http: r.http, bytes: r.bytes, ms: Date.now() - t0, items, etag: r.etag, lastModified: r.lastModified, final_url: current };
    }
  } catch (e) {
    const fe = e instanceof FetchError ? e : new FetchError('error', e && e.message ? e.message : String(e));
    return { status: fe.status, http: fe.http, bytes: 0, ms: Date.now() - t0, items: [], error: String(fe.message).slice(0, 300) };
  }
}

// ------------------------------------------------------------------------------------------------ parsing
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', copy: '©', reg: '®' };
const decode = (s) => String(s).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ' '; }
  return Object.prototype.hasOwnProperty.call(NAMED, e.toLowerCase()) ? NAMED[e.toLowerCase()] : m;
});
const INVISIBLE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\ufeff]', 'g');
const unCdata = (s) => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
// Feed text -> one line of plain text: CDATA unwrapped, entities decoded, tags removed (twice: descriptions often carry
// escaped HTML), invisible and control characters removed, whitespace collapsed.
function plain(s) {
  let x = decode(unCdata(s || ''));
  x = x.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ');
  x = decode(x).replace(/<[^>]*>/g, ' ').replace(/[<>]/g, ' ');
  return x.normalize('NFKC').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
}
// At most `max` characters, cut at a word boundary with an ellipsis.
function cut(s, max) {
  if (s.length <= max) return s;
  const c = s.slice(0, max - 1);
  const i = c.lastIndexOf(' ');
  return `${(i > max * 0.6 ? c.slice(0, i) : c).replace(/[\s,;:.–—-]+$/, '')}…`;
}
const tagRe = (name) => new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}\\s*>`, 'i');
const first = (block, names) => { for (const n of names) { const m = tagRe(n).exec(block); if (m && m[1].trim()) return m[1]; } return ''; };
const attr = (tag, name) => { const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag); return m ? decode(m[2] ?? m[3] ?? '') : ''; };
// WordPress feeds append "The post <title> appeared first on <site>." to descriptions: not part of the summary.
const BOILER = /\s*(The post .{1,300}? appeared first on .{1,120}?\.?|Continue reading.*|Read more.*|\[(…|\.\.\.|&#8230;)\])\s*$/i;

function parseFeed(xml, maxItems = LIMITS.maxItems) {
  const src = String(xml || '');
  const out = [];
  const re = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  let m;
  while ((m = re.exec(src)) && out.length < maxItems) {
    const b = m[2];
    const title = plain(first(b, ['title']));
    let link = '';
    if (m[1].toLowerCase() === 'entry') {
      const links = [...b.matchAll(/<link\b[^>]*\/?>/gi)].map((x) => x[0]);
      const alt = links.find((l) => !/\brel\s*=/i.test(l) || /\brel\s*=\s*["']alternate["']/i.test(l)) || links[0] || '';
      link = attr(alt, 'href');
    } else {
      link = plain(first(b, ['link']));
      if (!link) { const g = /<guid\b([^>]*)>([\s\S]*?)<\/guid\s*>/i.exec(b); if (g && !/isPermaLink\s*=\s*["']false["']/i.test(g[1])) link = plain(g[2]); }
    }
    const desc = plain(first(b, ['description', 'summary'])).replace(BOILER, '').trim();
    const date = plain(first(b, ['pubDate', 'published', 'updated', 'dc:date']));
    const guid = plain(first(b, ['guid', 'id'])).slice(0, 300);
    const cats = [...b.matchAll(/<category\b([^>]*?)(?:\/>|>([\s\S]*?)<\/category\s*>)/gi)].map((c) => plain(c[2] || attr(c[1], 'term'))).filter(Boolean).slice(0, 10).map((c) => c.slice(0, 60));
    if (!title || !link) continue;
    const ts = Date.parse(date);
    out.push({ title: cut(title, 200), link: link.slice(0, 1000), excerpt: cut(desc, 300), published_ts: Number.isFinite(ts) ? ts : null, guid, categories: cats });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ worker
const tasks = { fetchFeed };
if (!isMainThread && parentPort) {
  parentPort.on('message', async ({ id, task, args }) => {
    try { parentPort.postMessage({ id, ok: true, out: await tasks[task](args) }); } catch (e) { parentPort.postMessage({ id, ok: false, error: e && e.message ? e.message : String(e) }); }
  });
}
let worker = null; let seq = 0; const pending = new Map(); let broken = false;
function getWorker() {
  if (broken) return null;
  if (worker) return worker;
  try {
    worker = new Worker(path.join(__dirname, 'news-fetch.js'), { env: process.env });
    worker.unref();
    worker.on('message', ({ id, ok, out, error }) => {
      const p = pending.get(id); if (!p) return;
      pending.delete(id); if (!pending.size) worker?.unref();
      if (ok) p.resolve(out); else p.reject(new Error(error));
    });
    const fail = (e) => { for (const p of pending.values()) p.reject(e); pending.clear(); worker = null; };
    worker.on('error', fail);
    worker.on('exit', (code) => { if (pending.size) fail(new Error(`news worker exited (${code})`)); worker = null; });
    return worker;
  } catch { broken = true; return null; }
}
// Runs a task in the worker thread (here when `inline` or no worker could be started).
function run(task, args, { inline = false } = {}) {
  const w = inline ? null : getWorker();
  if (!w) return Promise.resolve().then(() => tasks[task](args));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    w.ref();
    w.postMessage({ id, task, args });
  });
}
async function stop() { const w = worker; worker = null; if (w) await w.terminate().catch(() => {}); }

module.exports = { fetchFeed, parseFeed, checkUrl, blocked, plain, cut, run, stop, LIMITS, FetchError };
