// Try-it signing for the developer portal (CLONE_SPEC.md §35.9). A demo key pair is generated here with WebCrypto
// (RSA-PSS, 2048 bits, SHA-256); the private key is created non-extractable and kept in this browser's IndexedDB, so it
// never leaves the browser (only the public key is sent, to register the demo key). Requests are signed over
// timestamp + METHOD + path (no query string) with a 32-byte salt, exactly like any API client.
const DB = 'parlance-docs';
const STORE = 'keys';
let memory = null; // fallback when IndexedDB is unavailable (private windows)

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function op(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tr = db.transaction(STORE, mode);
    const req = fn(tr.objectStore(STORE));
    tr.oncomplete = () => { db.close(); resolve(req && req.result); };
    tr.onerror = () => { db.close(); reject(tr.error); };
  });
}
export async function loadDemoKey() {
  try { return (await op('readonly', (s) => s.get('demo'))) || memory; } catch { return memory; }
}
export async function saveDemoKey(rec) {
  memory = rec;
  try { await op('readwrite', (s) => s.put(rec, 'demo')); } catch { /* memory only */ }
}
export async function clearDemoKey() {
  memory = null;
  try { await op('readwrite', (s) => s.delete('demo')); } catch { /* ignore */ }
}
const b64 = (buf) => { let s = ''; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s); };
// → { privateKey (CryptoKey, non-extractable), publicPem }
export async function newKeyPair() {
  const kp = await crypto.subtle.generateKey({ name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['sign', 'verify']);
  const spki = b64(await crypto.subtle.exportKey('spki', kp.publicKey));
  const publicPem = `-----BEGIN PUBLIC KEY-----\n${spki.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----\n`;
  return { privateKey: kp.privateKey, publicPem };
}
export async function signedHeaders(rec, method, path) {
  const ts = String(Date.now());
  const msg = new TextEncoder().encode(`${ts}${method.toUpperCase()}${path.split('?')[0]}`);
  const sig = await crypto.subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, rec.privateKey, msg);
  return { 'PARLANCE-ACCESS-KEY': rec.keyId, 'PARLANCE-ACCESS-TIMESTAMP': ts, 'PARLANCE-ACCESS-SIGNATURE': b64(sig) };
}
