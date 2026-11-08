'use strict';
// A small FIX 4.4 test client (CLONE_SPEC.md §35.8): signed Logon with an API key, sequence numbers, message waits.
// Uses the server's own codec (server/fix.js) so framing, BodyLength and CheckSum match the gateway exactly.
const net = require('node:net');
const { encode, parse, utc, SOH } = require('../../server/fix');
const { sign } = require('./signing');

class FixClient {
  constructor(port, { sender = 'TESTFIRM', target = 'PARLANCE', keyId, privateKey } = {}) {
    Object.assign(this, { port, sender, target, keyId, privateKey, seq: 1, messages: [], waiters: [], buf: Buffer.alloc(0), closed: false });
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.sock = net.connect(this.port, '127.0.0.1', resolve);
      this.sock.once('error', reject);
      this.sock.on('data', (d) => {
        this.buf = Buffer.concat([this.buf, d]);
        const r = parse(this.buf);
        this.buf = Buffer.from(r.rest);
        for (const m of r.messages) {
          const msg = { type: m.type, map: m.map, fields: m.fields, get: (t) => m.map.get(t), all: (t) => m.fields.filter(([x]) => x === t).map(([, v]) => v) };
          this.messages.push(msg);
          for (const w of [...this.waiters]) if (w.pred(msg)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(msg); }
        }
      });
      this.closedP = new Promise((res) => this.sock.once('close', () => { this.closed = true; res(); }));
    });
  }
  // Sends one message; `seq` overrides (and does not advance) the sequence number; `raw` sends bytes as given.
  send(type, fields = [], { seq = null, sendingTime = utc(), extraHead = [] } = {}) {
    const n = seq ?? this.seq;
    if (seq == null) this.seq += 1;
    this.sock.write(encode([[35, type], [49, this.sender], [56, this.target], [34, n], [52, sendingTime], ...extraHead, ...fields]));
    return n;
  }
  raw(buf) { this.sock.write(buf); }
  logon({ reset = true, hb = 30, privateKey = this.privateKey, keyId = this.keyId, sendingTime = utc(), seq = null } = {}) {
    const n = seq ?? this.seq;
    const sig = sign(privateKey, [sendingTime, 'A', String(n), this.sender, this.target].join(SOH));
    return this.send('A', [[98, 0], [108, hb], ...(reset ? [[141, 'Y']] : []), [553, keyId], [95, sig.length], [96, sig]], { seq, sendingTime });
  }
  waitFor(pred, ms = 6000) {
    const hit = this.messages.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); reject(new Error(`timed out waiting for a FIX message (${this.messages.map((m) => m.type).join(',')})`)); } }, ms);
    });
  }
  close() { try { this.sock.destroy(); } catch { /* ignore */ } }
}

module.exports = { FixClient };
