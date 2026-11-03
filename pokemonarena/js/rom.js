// pokemonarena/js/rom.js -- ROM identity, hashing and a bounds-checked little-endian reader.
//
// Pure ES module for browsers AND Node: no `node:` imports, no DOM, no globals except
// (optionally) `crypto.subtle` inside the *Async helpers. Nothing here contains ROM-derived
// content: only the offsets/hashes of the one ROM this page is pinned to.
//
// The pin (binding decision 2026-11-01): Pokemon SoulGold v1.1.1, the file the site already
// serves at gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba. Any other ROM is refused by
// loadPack() (tables.js) and must be refused by every online feature.

export const PINNED = Object.freeze({
  fileName: 'Pokemon SoulGold (v1.1.1).gba',
  length: 33554432,
  md5: 'b2c5caf9bc6dd28a44052427ee3ab1b7',
  sha256: '8071e2c348d54c3ec7b78b53837c5cbd757d5cfc461a50fa5ffbc9f5ab35060a',
  title: 'POKEMON EMER',
  gameCode: 'BPEE',
  makerCode: '01',
  fixedByte: 0x96,
  version: 0,
  headerChecksum: 0x72,
});

export const ROM_BASE = 0x08000000; // GBA bus address of ROM offset 0
export const ROM_WINDOW = 0x02000000; // 32 MiB cartridge window

export class RomMismatchError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'RomMismatchError';
    this.details = details || null;
  }
}

/** Raised when the ROM *is* the pinned file by hash but a table fails a structural expectation
 *  (only reachable with verify:'none' on a damaged/patched buffer, or in the mutation tests). */
export class RomFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RomFormatError';
  }
}

/** Accepts Uint8Array / Buffer / ArrayBuffer / other typed-array views. */
export function toBytes(src) {
  if (src instanceof Uint8Array) return src; // Buffer is a Uint8Array subclass
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  if (ArrayBuffer.isView(src)) return new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
  throw new TypeError('ROM must be a Uint8Array, Buffer, ArrayBuffer or typed-array view');
}

/** Bounds-checked little-endian reader over a ROM image. All offsets are FILE offsets. */
export class RomReader {
  constructor(src) {
    this.bytes = toBytes(src);
    this.length = this.bytes.length;
    this.dv = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
  }
  u8(o) { return this.dv.getUint8(o); }
  s8(o) { return this.dv.getInt8(o); }
  u16(o) { return this.dv.getUint16(o, true); }
  u32(o) { return this.dv.getUint32(o, true); }
  /** Pointer field -> file offset, or null for a zero pointer. Anything else outside the
   *  cartridge window is a format error (a table that points at RAM/BIOS is not this ROM). */
  ptr(o) {
    const v = this.u32(o);
    if (v === 0) return null;
    return this.ptrValue(v, o);
  }
  ptrValue(v, at) {
    if (v < ROM_BASE || v >= ROM_BASE + ROM_WINDOW || v - ROM_BASE >= this.length) {
      throw new RomFormatError(`bad ROM pointer 0x${v.toString(16)} read at 0x${at.toString(16)}`);
    }
    return v - ROM_BASE;
  }
  isRomPtr(v) { return v >= ROM_BASE && v < ROM_BASE + this.length; }
  /** u16 list terminated by `term` (default 0xFFFF). `max` guards a runaway read. */
  u16List(o, term = 0xffff, max = 4096) {
    const out = [];
    for (let i = 0; i < max; i++) {
      const v = this.u16(o + 2 * i);
      if (v === term) return out;
      out.push(v);
    }
    throw new RomFormatError(`u16 list at 0x${o.toString(16)} not terminated within ${max} entries`);
  }
  allZero(o, n) {
    const b = this.bytes;
    for (let i = 0; i < n; i++) if (b[o + i] !== 0) return false;
    return true;
  }
}

// ---------------------------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------------------------

const latin1 = (b, o, n) => {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]);
  return s;
};

/** Parse the cartridge header. Never throws on short input: reports what it can. */
export function readHeader(src) {
  const b = toBytes(src);
  if (b.length < 0xc0) return { ok: false, length: b.length };
  let sum = 0;
  for (let i = 0xa0; i <= 0xbc; i++) sum = (sum - b[i]) & 0xff;
  const computed = (sum - 0x19) & 0xff;
  return {
    ok: true,
    length: b.length,
    title: latin1(b, 0xa0, 12),
    gameCode: latin1(b, 0xac, 4),
    makerCode: latin1(b, 0xb0, 2),
    fixedByte: b[0xb2],
    version: b[0xbc],
    headerChecksum: b[0xbd],
    headerChecksumComputed: computed,
    headerChecksumOk: computed === b[0xbd],
  };
}

// ---------------------------------------------------------------------------------------------
// SHA-256 (pure JS, synchronous). Constants are derived with exact integer arithmetic, not
// recalled and not taken from floating point: K[i] = floor(frac(cbrt(prime_i)) * 2^32),
// H[i] = floor(frac(sqrt(prime_i)) * 2^32), via BigInt integer roots.
// ---------------------------------------------------------------------------------------------

function iroot(n, k) {
  // floor(n^(1/k)) for BigInt n >= 0, k in {2,3}
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / k) + 1);
  for (;;) {
    const y = ((BigInt(k) - 1n) * x + n / x ** (BigInt(k) - 1n)) / BigInt(k);
    if (y >= x) return x;
    x = y;
  }
}
const FIRST_PRIMES = (() => {
  const p = [];
  for (let n = 2; p.length < 64; n++) {
    let ok = true;
    for (let i = 0; i < p.length && p[i] * p[i] <= n; i++) if (n % p[i] === 0) { ok = false; break; }
    if (ok) p.push(n);
  }
  return p;
})();
const M32 = 0xffffffffn;
const SHA_K = Uint32Array.from(FIRST_PRIMES, (p) => Number(iroot(BigInt(p) << 96n, 3) & M32));
const SHA_H0 = Uint32Array.from(FIRST_PRIMES.slice(0, 8), (p) => Number(iroot(BigInt(p) << 64n, 2) & M32));

const hex32 = (words, le) => {
  let s = '';
  for (let i = 0; i < words.length; i++) {
    let w = words[i] >>> 0;
    if (le) w = (((w & 0xff) << 24) | ((w & 0xff00) << 8) | ((w >>> 8) & 0xff00) | (w >>> 24)) >>> 0;
    s += w.toString(16).padStart(8, '0');
  }
  return s;
};

function md_pad(b, bigEndianLength) {
  // The bytes that follow the last whole 64-byte block: remainder + 0x80 + zeros + bit length.
  const len = b.length;
  const rem = len % 64;
  const tailLen = rem < 56 ? 64 : 128;
  const tail = new Uint8Array(tailLen);
  tail.set(b.subarray(len - rem), 0);
  tail[rem] = 0x80;
  const bits = BigInt(len) * 8n;
  for (let i = 0; i < 8; i++) {
    const byte = Number((bits >> BigInt(8 * i)) & 0xffn);
    if (bigEndianLength) tail[tailLen - 1 - i] = byte; else tail[tailLen - 8 + i] = byte;
  }
  return { tail, whole: len - rem };
}

export function sha256Hex(src) {
  const b = toBytes(src);
  const H = new Uint32Array(SHA_H0);
  const W = new Uint32Array(64);
  const K = SHA_K;
  const block = (buf, off) => {
    for (let i = 0; i < 16; i++) {
      const j = off + 4 * i;
      W[i] = (buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const w15 = W[i - 15], w2 = W[i - 2];
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & bb) ^ (a & c) ^ (bb & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + bb) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  };
  const { tail, whole } = md_pad(b, true);
  for (let o = 0; o < whole; o += 64) block(b, o);
  for (let o = 0; o < tail.length; o += 64) block(tail, o);
  return hex32(H, false);
}

// ---------------------------------------------------------------------------------------------
// MD5 (pure JS, synchronous). The T table is fixed data (RFC 1321). tools/pokemonarena_pack_test.mjs
// re-derives it from Math.sin and asserts equality, so a transcription slip cannot ship.
// ---------------------------------------------------------------------------------------------

export const MD5_T = Uint32Array.from([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]);
const MD5_S = Uint8Array.from([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);

export function md5Hex(src) {
  const b = toBytes(src);
  const st = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
  const M = new Uint32Array(16);
  const T = MD5_T, S = MD5_S;
  const block = (buf, off) => {
    for (let i = 0; i < 16; i++) {
      const j = off + 4 * i;
      M[i] = buf[j] | (buf[j + 1] << 8) | (buf[j + 2] << 16) | (buf[j + 3] << 24);
    }
    let a = st[0], bb = st[1], c = st[2], d = st[3];
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (bb & c) | (~bb & d); g = i; }
      else if (i < 32) { f = (d & bb) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = bb ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (bb | ~d); g = (7 * i) & 15; }
      const x = (a + f + T[i] + M[g]) | 0;
      a = d; d = c; c = bb;
      bb = (bb + ((x << S[i]) | (x >>> (32 - S[i])))) | 0;
    }
    st[0] = (st[0] + a) | 0; st[1] = (st[1] + bb) | 0; st[2] = (st[2] + c) | 0; st[3] = (st[3] + d) | 0;
  };
  const { tail, whole } = md_pad(b, false);
  for (let o = 0; o < whole; o += 64) block(b, o);
  for (let o = 0; o < tail.length; o += 64) block(tail, o);
  return hex32(st, true);
}

/** WebCrypto SHA-256 when available (browser main thread/worker, Node >= 19), else the pure-JS one. */
export async function sha256HexFast(src) {
  const b = toBytes(src);
  const subtle = typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) return sha256Hex(b);
  const buf = await subtle.digest('SHA-256', b);
  return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------------

/**
 * Compare a buffer against the pin.
 *   hash: 'sha256' (default) | 'full' (sha256 + md5) | 'none' (length + header only)
 * Returns { ok, reasons[], header, sha256?, md5? }. `ok` is true only if EVERY requested check passed.
 */
export function identify(src, { hash = 'sha256' } = {}) {
  const b = toBytes(src);
  const header = readHeader(b);
  const reasons = [];
  if (b.length !== PINNED.length) reasons.push(`length ${b.length} != ${PINNED.length}`);
  if (header.ok) {
    if (header.title !== PINNED.title) reasons.push(`title ${JSON.stringify(header.title)} != ${JSON.stringify(PINNED.title)}`);
    if (header.gameCode !== PINNED.gameCode) reasons.push(`gameCode ${header.gameCode} != ${PINNED.gameCode}`);
    if (header.makerCode !== PINNED.makerCode) reasons.push(`makerCode ${header.makerCode} != ${PINNED.makerCode}`);
    if (header.fixedByte !== PINNED.fixedByte) reasons.push(`fixed byte 0x${header.fixedByte.toString(16)}`);
    if (header.version !== PINNED.version) reasons.push(`header version ${header.version} != ${PINNED.version}`);
    if (!header.headerChecksumOk) reasons.push('header checksum invalid');
    if (header.headerChecksum !== PINNED.headerChecksum) reasons.push(`header checksum 0x${header.headerChecksum.toString(16)} != 0x${PINNED.headerChecksum.toString(16)}`);
  } else reasons.push('too short for a GBA header');
  const out = { ok: false, reasons, header };
  if (reasons.length === 0 && hash !== 'none') {
    out.sha256 = sha256Hex(b);
    if (out.sha256 !== PINNED.sha256) reasons.push(`sha256 ${out.sha256} != ${PINNED.sha256}`);
    if (hash === 'full') {
      out.md5 = md5Hex(b);
      if (out.md5 !== PINNED.md5) reasons.push(`md5 ${out.md5} != ${PINNED.md5}`);
    }
  }
  out.ok = reasons.length === 0;
  return out;
}

/** Throws RomMismatchError unless `src` is the pinned ROM. Async variant uses WebCrypto for the hash. */
export function assertPinned(src, opts) {
  const r = identify(src, opts);
  if (!r.ok) throw new RomMismatchError(`not the pinned ROM (${PINNED.fileName}): ${r.reasons.join('; ')}`, r);
  return r;
}
export async function assertPinnedAsync(src) {
  const quick = identify(src, { hash: 'none' });
  if (!quick.ok) throw new RomMismatchError(`not the pinned ROM (${PINNED.fileName}): ${quick.reasons.join('; ')}`, quick);
  const sha = await sha256HexFast(src);
  if (sha !== PINNED.sha256) {
    throw new RomMismatchError(`not the pinned ROM (${PINNED.fileName}): sha256 ${sha} != ${PINNED.sha256}`, { ...quick, sha256: sha });
  }
  return { ...quick, ok: true, sha256: sha };
}
