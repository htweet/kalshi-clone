'use strict';
// An in-process S3-compatible server for the tests (no network): path-style buckets, PUT / GET / HEAD / DELETE objects,
// ListObjectsV2 with continuation tokens, x-amz-meta-* headers, multipart uploads (database growth fix, §39.17). Every request's AWS Signature Version 4 is recomputed
// from the request (server/storage.js signV4 with the known secret) and compared with the Authorization header; a wrong
// signature, a wrong access key or a body whose hash does not match x-amz-content-sha256 is answered 403.
const http = require('node:http');
const crypto = require('node:crypto');
const { signV4 } = require('../../server/storage');

function createFakeS3({ accessKeyId = 'AKFAKETESTKEY0001', secretAccessKey = 'fake-secret-for-tests-only', region = 'auto', pageSize = 1000 } = {}) {
  const buckets = new Map(); // bucket -> Map(key -> {body, meta, contentType, mtime})
  const log = []; // {method, key, status}
  const uploads = new Map(); const multipartDone = []; // multipart uploads in progress / completed
  const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const u = new URL(req.url, `http://${req.headers.host}`);
      const parts = u.pathname.split('/').slice(1);
      const bucket = decodeURIComponent(parts[0] || '');
      const key = parts.slice(1).map(decodeURIComponent).join('/');
      const done = (status, payload = '', headers = {}) => { log.push({ method: req.method, key, status }); res.writeHead(status, headers); res.end(payload); };
      // ---- signature check
      const auth = String(req.headers.authorization || '');
      const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
      if (!m || m[1] !== accessKeyId || m[3] !== region) return done(403, '<Error><Code>InvalidAccessKeyId</Code></Error>');
      if (crypto.createHash('sha256').update(body).digest('hex') !== req.headers['x-amz-content-sha256']) return done(403, '<Error><Code>XAmzContentSHA256Mismatch</Code></Error>');
      const signed = Object.fromEntries(m[4].split(';').filter((h) => h !== 'host' && h !== 'x-amz-date' && h !== 'x-amz-content-sha256').map((h) => [h, req.headers[h]]));
      const amz = String(req.headers['x-amz-date'] || '');
      const now = new Date(Date.UTC(+amz.slice(0, 4), +amz.slice(4, 6) - 1, +amz.slice(6, 8), +amz.slice(9, 11), +amz.slice(11, 13), +amz.slice(13, 15)));
      const want = signV4({ method: req.method, url: `http://${req.headers.host}${req.url}`, headers: signed, body, accessKeyId, secretAccessKey, region, now });
      if (want.authorization !== auth) return done(403, '<Error><Code>SignatureDoesNotMatch</Code></Error>');
      if (Math.abs(Date.now() - now.getTime()) > 15 * 60000) return done(403, '<Error><Code>RequestTimeTooSkewed</Code></Error>');
      // ---- operations
      if (!buckets.has(bucket)) buckets.set(bucket, new Map());
      const b = buckets.get(bucket);
      // Multipart uploads (CreateMultipartUpload, UploadPart, CompleteMultipartUpload, AbortMultipartUpload).
      if (req.method === 'POST' && key && u.searchParams.has('uploads')) {
        const id = crypto.randomBytes(8).toString('hex');
        const meta = {}; for (const [k, v] of Object.entries(req.headers)) if (k.startsWith('x-amz-meta-')) meta[k.slice(11)] = v;
        uploads.set(id, { bucket, key, parts: new Map(), meta, contentType: req.headers['content-type'] || 'application/octet-stream' });
        return done(200, `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>${xml(bucket)}</Bucket><Key>${xml(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`, { 'content-type': 'application/xml' });
      }
      if (req.method === 'PUT' && key && u.searchParams.has('uploadId')) {
        const up = uploads.get(u.searchParams.get('uploadId'));
        if (!up) return done(404, '<Error><Code>NoSuchUpload</Code></Error>');
        const etag = crypto.createHash('md5').update(body).digest('hex');
        up.parts.set(Number(u.searchParams.get('partNumber')), { body, etag });
        return done(200, '', { etag: `"${etag}"` });
      }
      if (req.method === 'POST' && key && u.searchParams.has('uploadId')) {
        const up = uploads.get(u.searchParams.get('uploadId'));
        if (!up) return done(404, '<Error><Code>NoSuchUpload</Code></Error>');
        const listed = [...String(body).matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>"?([0-9a-f]+)"?<\/ETag>/g)].map((m) => [Number(m[1]), m[2]]);
        if (!listed.length || listed.some(([n, e], i) => n !== i + 1 || !up.parts.has(n) || up.parts.get(n).etag !== e)) return done(400, '<Error><Code>InvalidPart</Code></Error>');
        b.set(key, { body: Buffer.concat(listed.map(([n]) => up.parts.get(n).body)), meta: up.meta, contentType: up.contentType, mtime: new Date() });
        uploads.delete(u.searchParams.get('uploadId'));
        multipartDone.push({ key, parts: listed.length });
        return done(200, `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Key>${xml(key)}</Key><ETag>"multipart-${listed.length}"</ETag></CompleteMultipartUploadResult>`, { 'content-type': 'application/xml' });
      }
      if (req.method === 'DELETE' && key && u.searchParams.has('uploadId')) { uploads.delete(u.searchParams.get('uploadId')); return done(204); }
      if (req.method === 'PUT' && key) {
        const meta = {}; for (const [k, v] of Object.entries(req.headers)) if (k.startsWith('x-amz-meta-')) meta[k.slice(11)] = v;
        b.set(key, { body, meta, contentType: req.headers['content-type'] || 'application/octet-stream', mtime: new Date() });
        return done(200, '', { etag: `"${crypto.createHash('md5').update(body).digest('hex')}"` });
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && key) {
        const o = b.get(key);
        if (!o) return done(404, req.method === 'HEAD' ? '' : '<Error><Code>NoSuchKey</Code></Error>');
        const h = { 'content-type': o.contentType, 'content-length': String(o.body.length), 'last-modified': o.mtime.toUTCString() };
        for (const [k, v] of Object.entries(o.meta)) h[`x-amz-meta-${k}`] = v;
        return done(200, req.method === 'HEAD' ? '' : o.body, h);
      }
      if (req.method === 'DELETE' && key) { b.delete(key); return done(204); }
      if (req.method === 'GET' && !key && u.searchParams.get('list-type') === '2') {
        const prefix = u.searchParams.get('prefix') || '';
        const all = [...b.keys()].filter((k) => k.startsWith(prefix)).sort();
        const start = Number(u.searchParams.get('continuation-token') || 0);
        const page = all.slice(start, start + pageSize);
        const more = start + pageSize < all.length;
        return done(200, `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${xml(bucket)}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + pageSize}</NextContinuationToken>` : ''}${page.map((k) => `<Contents><Key>${xml(k)}</Key><Size>${b.get(k).body.length}</Size><LastModified>${b.get(k).mtime.toISOString()}</LastModified></Contents>`).join('')}</ListBucketResult>`, { 'content-type': 'application/xml' });
      }
      return done(400, '<Error><Code>NotImplemented</Code></Error>');
    });
  });
  return {
    server, buckets, log, multipartDone, accessKeyId, secretAccessKey, region,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
  };
}

module.exports = { createFakeS3 };
