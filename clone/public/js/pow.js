// Sign-in proof of work (RS2; CLONE_SPEC.md §25.11): after repeated failed sign-ins for an account the server answers
// 429 too_many_attempts with {pow: {token, id, bits}} instead of locking the account; the browser finds a nonce with
// SHA-256("<id>:<nonce>") having `bits` leading zero bits (≈4k–262k hashes) and retries. Pure JS SHA-256 (synchronous,
// works on plain-http origins where crypto.subtle is missing), in slices so the page stays responsive.
const K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d,
  0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
const W = new Uint32Array(64);

// SHA-256 of an ASCII string; returns the first 32-bit word of the digest (enough to count up to 32 leading zero bits)
// and the second (for bits > 32, never used here).
export function sha256Words(str) {
  const n = str.length;
  const blocks = ((n + 9 + 63) >> 6);
  const m = new Uint32Array(blocks * 16);
  for (let i = 0; i < n; i++) m[i >> 2] |= (str.charCodeAt(i) & 0xff) << (24 - (i & 3) * 8);
  m[n >> 2] |= 0x80 << (24 - (n & 3) * 8);
  m[blocks * 16 - 1] = n * 8;
  let h0 = 0x6a09e667; let h1 = 0xbb67ae85; let h2 = 0x3c6ef372; let h3 = 0xa54ff53a; let h4 = 0x510e527f; let h5 = 0x9b05688c; let h6 = 0x1f83d9ab; let h7 = 0x5be0cd19;
  for (let b = 0; b < blocks; b++) {
    for (let t = 0; t < 16; t++) W[t] = m[b * 16 + t];
    for (let t = 16; t < 64; t++) {
      const x = W[t - 15]; const y = W[t - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
    }
    let a = h0; let c1 = h1; let c = h2; let d = h3; let e = h4; let f = h5; let g = h6; let h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[t] + W[t]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & c1) ^ (a & c) ^ (c1 & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = c1; c1 = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + c1) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  return [h0 >>> 0, h1 >>> 0];
}

const zeroBits = (w) => (w === 0 ? 32 : Math.clz32(w));

export async function solvePow({ id, bits }) {
  if (!id || !(bits > 0 && bits <= 28)) throw new Error('invalid sign-in check');
  for (let n = 0; ; n += 1) {
    if (zeroBits(sha256Words(`${id}:${n}`)[0]) >= bits) return String(n);
    if (n % 20000 === 19999) await new Promise((r) => setTimeout(r, 0)); // yield to the page
  }
}
