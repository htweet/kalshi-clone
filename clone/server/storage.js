'use strict';
// Object storage adapter (PLAN P9.2, CLONE_SPEC.md §39.4). One small interface, two drivers:
//   local  a folder on disk (the default: <data dir>/objects for media, <data dir>/backups for backups);
//   s3     any S3-compatible service (AWS S3, Cloudflare R2, Backblaze B2, MinIO, Wasabi, DigitalOcean Spaces, …) over
//          HTTPS with AWS Signature Version 4, implemented here with node:crypto and fetch (no SDK).
// Interface: put(key, Buffer, {contentType, meta}) · get(key) → Buffer|null · head(key) → {size, etag, meta}|null ·
// list(prefix) → [{key, size, mtime}] (sorted by key) · delete(key) · describe() (no secrets) · kind; and, for objects too
// large to hold in memory (database snapshots, CLONE_SPEC.md §39.17): putFile(key, path, {contentType, meta, move}) streams
// a file in (S3: one streamed PUT signed with the file's SHA-256 up to the part size, else a multipart upload of
// part-size pieces), getFile(key, path) → {size}|null streams an object out, and the local driver's pathOf(key) /
// stagingFile(key) let a backup be written next to its final place and moved in with a rename.
// Keys are relative paths of [A-Za-z0-9._/-] segments; "..", empty segments and leading "/" are refused, so a key can
// never escape the folder or address another bucket. Nothing in the app depends on the provider: the provider is
// configuration (OBJECT_STORAGE / BACKUP_STORAGE and the S3_* / BACKUP_S3_* variables, documented in .env.example).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// Hash of a file, streamed (memory: one read buffer).
async function hashFileWith(file, algo) {
  const h = crypto.createHash(algo);
  await pipeline(fs.createReadStream(file, { highWaterMark: 1 << 20 }), new Writable({ write(d, e, cb) { h.update(d); cb(); } }));
  return h.digest('hex');
}
const rand = () => crypto.randomBytes(4).toString('hex');

class StorageError extends Error { constructor(message, status) { super(message); this.status = status; } }
const KEY_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
function checkKey(key) {
  const k = String(key || '');
  if (!KEY_RE.test(k) || k.length > 900 || k.split('/').some((s) => s === '.' || s === '..')) throw new StorageError(`invalid object key ${JSON.stringify(k.slice(0, 80))}`, 400);
  return k;
}

// ------------------------------------------------------------------------------------------------ local folder
function localDriver({ dir }) {
  const root = path.resolve(dir);
  const file = (key) => path.join(root, ...checkKey(key).split('/'));
  const metaFile = (key) => `${file(key)}.meta.json`;
  return {
    kind: 'local',
    describe: () => ({ driver: 'local', dir: root }),
    config: () => ({ driver: 'local', dir: root }), // rebuilds this driver in the operations worker
    async put(key, body, { contentType = 'application/octet-stream', meta = {} } = {}) {
      const f = file(key);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const tmp = `${f}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      await fs.promises.writeFile(tmp, body, { mode: 0o600 }); // asynchronous: a large backup never holds up requests
      await fs.promises.rename(tmp, f); // atomic: a reader never sees half an object
      await fs.promises.writeFile(metaFile(key), JSON.stringify({ contentType, meta }), { mode: 0o600 });
      // The etag: the caller's SHA-256 when given (a large backup is already hashed in the operations worker), else MD5.
      return { key, size: body.length, etag: meta && meta.sha256 ? meta.sha256 : crypto.createHash('md5').update(body).digest('hex') };
    },
    async get(key) { try { return await fs.promises.readFile(file(key)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } },
    // Large objects: a staging file beside the object (same file system, skipped by list()), moved in with a rename.
    pathOf: (key) => file(key),
    stagingFile(key) { const f = file(key); fs.mkdirSync(path.dirname(f), { recursive: true }); return `${f}.tmp-${process.pid}-${rand()}`; },
    async putFile(key, src, { contentType = 'application/octet-stream', meta = {}, move = false } = {}) {
      const f = file(key);
      await fs.promises.mkdir(path.dirname(f), { recursive: true });
      const size = (await fs.promises.stat(src)).size;
      let moved = false;
      if (move) { try { await fs.promises.rename(src, f); moved = true; } catch (e) { if (e.code !== 'EXDEV') throw e; } }
      if (!moved) {
        const tmp = `${f}.tmp-${process.pid}-${rand()}`;
        await fs.promises.copyFile(src, tmp);
        await fs.promises.rename(tmp, f); // atomic: a reader never sees half an object
        if (move) await fs.promises.unlink(src).catch(() => {});
      }
      await fs.promises.writeFile(metaFile(key), JSON.stringify({ contentType, meta }), { mode: 0o600 });
      return { key, size, etag: meta && meta.sha256 ? meta.sha256 : await hashFileWith(f, 'md5') };
    },
    async getFile(key, dest) {
      try { await fs.promises.copyFile(file(key), dest); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
      return { size: (await fs.promises.stat(dest)).size };
    },
    async head(key) {
      try {
        const st = fs.statSync(file(key));
        let m = {}; try { m = JSON.parse(fs.readFileSync(metaFile(key), 'utf8')); } catch { /* no sidecar */ }
        return { size: st.size, mtime: st.mtimeMs, contentType: m.contentType || null, meta: m.meta || {} };
      } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    },
    async list(prefix = '') {
      const out = [];
      const walk = (d, rel) => {
        let ents = [];
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) walk(path.join(d, e.name), r);
          else if (!e.name.endsWith('.meta.json') && !e.name.includes('.tmp-') && r.startsWith(prefix)) { const st = fs.statSync(path.join(d, e.name)); out.push({ key: r, size: st.size, mtime: st.mtimeMs }); }
        }
      };
      walk(root, '');
      return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    },
    async delete(key) { for (const f of [file(key), metaFile(key)]) { try { fs.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') throw e; } } },
  };
}

// ------------------------------------------------------------------------------------------------ S3 (SigV4)
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
// RFC 3986 encoding as SigV4 wants it (every byte except unreserved; "/" kept in paths).
const enc = (s, keepSlash = false) => { const e = encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`); return keepSlash ? e.replace(/%2F/g, '/') : e; };

// Signs a request (AWS Signature Version 4, service s3). Exported for the fake server in the tests, which recomputes it.
// `payloadHash`: the body's SHA-256 when the body is streamed (computed beforehand); otherwise it is hashed here.
function signV4({ method, url, headers, body, accessKeyId, secretAccessKey, region, service = 's3', now = new Date(), payloadHash: givenHash = null }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = givenHash || sha256(body || Buffer.alloc(0));
  const h = { ...headers, host: u.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
  const names = Object.keys(h).map((k) => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const query = [...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [method, enc(decodeURIComponent(u.pathname), true), query, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  return { ...h, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

// `partSize`: files above it go up as a multipart upload of parts this size (S3 wants at least 5 MiB; 16 MiB keeps memory
// low and a 5 GB single-PUT limit far away).
function s3Driver({ endpoint, region = 'auto', bucket, accessKeyId, secretAccessKey, prefix = '', pathStyle = true, timeoutMs = 30000, fetchImpl = fetch, partSize = 16 * 1048576 }) {
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new Error('S3 storage needs an endpoint, a bucket, an access key id and a secret access key');
  const base = new URL(endpoint);
  if (base.protocol !== 'https:' && !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(base.hostname)) throw new Error('S3 storage endpoints must use https (plain http only on loopback, for tests)');
  const pre = prefix ? `${String(prefix).replace(/^\/+|\/+$/g, '')}/` : '';
  const urlOf = (key, q = '') => {
    const objectPath = key == null ? '' : `/${enc(pre + key, true)}`;
    return pathStyle ? `${base.origin}/${enc(bucket)}${objectPath}${q}` : `${base.protocol}//${bucket}.${base.host}${objectPath || '/'}${q}`;
  };
  // `stream` (with `payloadHash`): a function returning the body as a Node stream (a large file), sent with its length.
  async function request(method, key, { body, headers = {}, query = '', stream = null, payloadHash = null, timeout = timeoutMs } = {}) {
    const url = urlOf(key, query);
    const signed = signV4({ method, url, headers, body: stream ? null : body, payloadHash: stream ? payloadHash : null, accessKeyId, secretAccessKey, region });
    delete signed.host; // fetch sets it
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeout);
    try {
      return await fetchImpl(url, { method, headers: signed, body: stream ? stream() : body && body.length ? body : undefined, signal: ac.signal, ...(stream ? { duplex: 'half' } : {}) });
    } finally { clearTimeout(t); }
  }
  const metaHeaders = (meta) => Object.fromEntries(Object.entries(meta || {}).map(([k, v]) => [`x-amz-meta-${String(k).toLowerCase().replace(/[^a-z0-9-]/g, '-')}`, String(v).replace(/[^\x20-\x7e]/g, '?').slice(0, 256)]));
  const fail = async (r, what) => { const text = await r.text().catch(() => ''); const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] || r.status; throw new StorageError(`S3 ${what} failed: ${code}`, r.status); };
  return {
    kind: 's3',
    describe: () => ({ driver: 's3', endpoint: base.origin, bucket, region, prefix: pre || null }),
    // Rebuilds this driver in the operations worker (only with the built-in fetch; an injected fetch stays on this thread).
    config: () => (fetchImpl === globalThis.fetch ? { driver: 's3', endpoint, region, bucket, accessKeyId, secretAccessKey, prefix, pathStyle, timeoutMs, partSize } : null),
    async put(key, body, { contentType = 'application/octet-stream', meta = {} } = {}) {
      checkKey(key);
      const headers = { 'content-type': contentType, 'content-length': String(body.length), 'x-amz-meta-sha256': sha256(body) };
      for (const [k, v] of Object.entries(meta)) headers[`x-amz-meta-${String(k).toLowerCase().replace(/[^a-z0-9-]/g, '-')}`] = String(v).replace(/[^\x20-\x7e]/g, '?').slice(0, 256);
      const r = await request('PUT', key, { body, headers });
      if (!r.ok) await fail(r, 'put');
      await r.arrayBuffer().catch(() => null);
      return { key, size: body.length, etag: (r.headers.get('etag') || '').replace(/"/g, '') };
    },
    async get(key) {
      checkKey(key);
      const r = await request('GET', key);
      if (r.status === 404) { await r.arrayBuffer().catch(() => null); return null; }
      if (!r.ok) await fail(r, 'get');
      return Buffer.from(await r.arrayBuffer());
    },
    // A file of any size: one streamed PUT signed with the file's SHA-256 (the caller's meta.sha256 when given), or a
    // multipart upload of `partSize` pieces (each read, hashed and signed on its own; the upload is aborted on failure).
    async putFile(key, src, { contentType = 'application/octet-stream', meta = {}, move = false } = {}) {
      checkKey(key);
      const size = (await fs.promises.stat(src)).size;
      const sum = meta && /^[0-9a-f]{64}$/.test(String(meta.sha256 || '')) ? meta.sha256 : await hashFileWith(src, 'sha256');
      const mh = { ...metaHeaders(meta), 'x-amz-meta-sha256': sum };
      let etag = '';
      if (size <= partSize) {
        const r = await request('PUT', key, { stream: () => fs.createReadStream(src), payloadHash: sum, headers: { 'content-type': contentType, 'content-length': String(size), ...mh }, timeout: Math.max(timeoutMs, 600000) });
        if (!r.ok) await fail(r, 'put');
        await r.arrayBuffer().catch(() => null);
        etag = (r.headers.get('etag') || '').replace(/"/g, '');
      } else {
        const init = await request('POST', key, { query: '?uploads', headers: { 'content-type': contentType, ...mh } });
        if (!init.ok) await fail(init, 'multipart start');
        const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await init.text())?.[1];
        if (!uploadId) throw new StorageError('S3 multipart start failed: no upload id', 502);
        const parts = [];
        const fd = await fs.promises.open(src, 'r');
        try {
          for (let n = 1, off = 0; off < size; n += 1, off += partSize) {
            const len = Math.min(partSize, size - off);
            const b = Buffer.alloc(len);
            await fd.read(b, 0, len, off);
            const r = await request('PUT', key, { body: b, query: `?partNumber=${n}&uploadId=${enc(uploadId)}`, headers: { 'content-length': String(len) }, timeout: Math.max(timeoutMs, 600000) });
            if (!r.ok) await fail(r, 'multipart part');
            await r.arrayBuffer().catch(() => null);
            parts.push(`<Part><PartNumber>${n}</PartNumber><ETag>${String(r.headers.get('etag') || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</ETag></Part>`);
          }
          const done = await request('POST', key, { body: Buffer.from(`<CompleteMultipartUpload>${parts.join('')}</CompleteMultipartUpload>`), query: `?uploadId=${enc(uploadId)}`, headers: { 'content-type': 'application/xml' } });
          const text = await done.text();
          if (!done.ok || /<Error>/.test(text)) throw new StorageError(`S3 multipart complete failed: ${/<Code>([^<]+)<\/Code>/.exec(text)?.[1] || done.status}`, done.status);
          etag = (/<ETag>([^<]+)<\/ETag>/.exec(text)?.[1] || '').replace(/&quot;|"/g, '');
        } catch (e) {
          await request('DELETE', key, { query: `?uploadId=${enc(uploadId)}` }).then((r) => r.arrayBuffer()).catch(() => null);
          throw e;
        } finally { await fd.close(); }
      }
      if (move) await fs.promises.unlink(src).catch(() => {});
      return { key, size, etag };
    },
    async getFile(key, dest) {
      checkKey(key);
      const r = await request('GET', key);
      if (r.status === 404) { await r.arrayBuffer().catch(() => null); return null; }
      if (!r.ok) await fail(r, 'get');
      await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest, { mode: 0o600 }));
      return { size: (await fs.promises.stat(dest)).size };
    },
    async head(key) {
      checkKey(key);
      const r = await request('HEAD', key);
      if (r.status === 404) return null;
      if (!r.ok) throw new StorageError(`S3 head failed: ${r.status}`, r.status);
      const meta = {};
      for (const [k, v] of r.headers) if (k.startsWith('x-amz-meta-')) meta[k.slice(11)] = v;
      return { size: Number(r.headers.get('content-length') || 0), mtime: Date.parse(r.headers.get('last-modified') || '') || null, contentType: r.headers.get('content-type'), meta };
    },
    async list(prefixArg = '') {
      const out = []; let token = null;
      for (let page = 0; page < 1000; page++) {
        const q = `?list-type=2&prefix=${enc(pre + prefixArg)}${token ? `&continuation-token=${enc(token)}` : ''}`;
        const r = await request('GET', null, { query: q });
        if (!r.ok) await fail(r, 'list');
        const xml = await r.text();
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const k = /<Key>([^<]*)<\/Key>/.exec(m[1])?.[1] || '';
          const unesc = k.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
          out.push({ key: unesc.slice(pre.length), size: Number(/<Size>(\d+)<\/Size>/.exec(m[1])?.[1] || 0), mtime: Date.parse(/<LastModified>([^<]+)<\/LastModified>/.exec(m[1])?.[1] || '') || null });
        }
        if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
        token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1];
        if (!token) break;
      }
      return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    },
    async delete(key) {
      checkKey(key);
      const r = await request('DELETE', key);
      if (!r.ok && r.status !== 404) await fail(r, 'delete');
      await r.arrayBuffer().catch(() => null);
    },
  };
}

// Builds a driver from configuration. `spec`: 'local' | 'local:<dir>' | 's3'; `env` prefix: '' (S3_*) or 'BACKUP_' (BACKUP_S3_*).
function fromEnv({ spec, defaultDir, envPrefix = '' }) {
  const s = String(spec || 'local');
  if (s === 's3') {
    const e = (n) => process.env[`${envPrefix}S3_${n}`];
    return s3Driver({ endpoint: e('ENDPOINT'), region: e('REGION') || 'auto', bucket: e('BUCKET'), accessKeyId: e('ACCESS_KEY_ID'), secretAccessKey: e('SECRET_ACCESS_KEY'), prefix: e('PREFIX') || '', pathStyle: e('PATH_STYLE') !== '0' });
  }
  if (s === 'local') return localDriver({ dir: defaultDir });
  if (s.startsWith('local:')) return localDriver({ dir: s.slice(6) });
  throw new Error(`unknown storage "${s}" (use local, local:<folder> or s3)`);
}
// The S3 settings are read through this helper so every variable name appears literally (env documentation check).
function envSnapshot() {
  return {
    OBJECT_STORAGE: process.env.OBJECT_STORAGE, BACKUP_STORAGE: process.env.BACKUP_STORAGE,
    S3: [process.env.S3_ENDPOINT, process.env.S3_REGION, process.env.S3_BUCKET, process.env.S3_ACCESS_KEY_ID, process.env.S3_SECRET_ACCESS_KEY, process.env.S3_PREFIX, process.env.S3_PATH_STYLE].map(Boolean),
    BACKUP_S3: [process.env.BACKUP_S3_ENDPOINT, process.env.BACKUP_S3_REGION, process.env.BACKUP_S3_BUCKET, process.env.BACKUP_S3_ACCESS_KEY_ID, process.env.BACKUP_S3_SECRET_ACCESS_KEY, process.env.BACKUP_S3_PREFIX, process.env.BACKUP_S3_PATH_STYLE].map(Boolean),
  };
}

function create(opt) {
  if (!opt) return null;
  if (opt.driver === 's3') return s3Driver(opt);
  if (opt.driver === 'local') return localDriver(opt);
  if (typeof opt.put === 'function') return opt; // an injected driver (tests)
  throw new Error('storage: driver must be local or s3');
}

module.exports = { create, fromEnv, localDriver, s3Driver, signV4, checkKey, StorageError, envSnapshot };
