'use strict';
// A TLS-terminating reverse proxy for the tests (what Caddy does in deploy/): HTTPS on its own port in front of the
// app's plain HTTP listener, the Host header passed through, X-Forwarded-For / X-Forwarded-Proto set by the proxy only
// (a client's own copies are dropped), WebSocket upgrades piped. `x-test-client-ip` lets a test pretend the client came
// from another address (the proxy writes that into X-Forwarded-For), to exercise the trusted-proxy and allowlist rules.
// The certificate is self-signed for 127.0.0.1 / localhost, made with the openssl CLI into a temporary folder.
const https = require('node:https');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function selfSigned(dir) {
  const key = path.join(dir, 'proxy-key.pem'); const cert = path.join(dir, 'proxy-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

function createTlsProxy({ target, tls }) {
  const forwardHeaders = (req) => {
    const h = { ...req.headers };
    delete h['x-forwarded-for']; delete h['x-forwarded-proto']; delete h['x-forwarded-host'];
    h['x-forwarded-for'] = String(req.headers['x-test-client-ip'] || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    delete h['x-test-client-ip'];
    h['x-forwarded-proto'] = 'https';
    return h;
  };
  const server = https.createServer(tls, (req, res) => {
    const up = http.request({ host: '127.0.0.1', port: target, method: req.method, path: req.url, headers: forwardHeaders(req) }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  server.on('upgrade', (req, socket, head) => {
    const up = net.connect(target, '127.0.0.1', () => {
      const h = forwardHeaders(req);
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      if (head && head.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  return {
    server,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
  };
}

module.exports = { createTlsProxy, selfSigned };
