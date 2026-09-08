// lib/bgz.js — reader for the BLOCK-GZIP disc format written by tools/bgzip.mjs.
//
// Loaded BOTH by dreamcast.html (<script>) and by the flycast worker shim
// (importScripts, alongside /lib/seqlock.js and /lib/ringbuffer.js), because
// the eager path and the lazy path must agree byte-for-byte about where a
// block lives. Publishes globalThis.BGZ.
//
// THE FORMAT. A `.bgz` part is a concatenation of INDEPENDENT gzip members,
// each covering exactly `block` bytes of uncompressed data (the last member of
// a part may be short). The sidecar `<name>.bgzi.json` carries, per part, the
// compressed length of every member — so member i starts at the prefix sum of
// the lengths before it, and covers uncompressed [i*block, (i+1)*block).
// Blocks never straddle a part, which keeps the arithmetic local and lets one
// part be validated on its own.
//
// ⚠ NEVER HAND A WHOLE .bgz FILE TO DecompressionStream. Verified in Chrome 152
// on 2026-09-08: a 3-member concatenation fails with "TypeError: Failed to
// fetch", while the middle member sliced out by byte offset inflates to exactly
// its 65,536 B with a matching checksum. Node's zlib.gunzipSync DOES accept the
// concatenation, so a Node-only test passes on a file no browser can read.
// Every reader here is therefore per-member.
//
// Two inflate paths, on purpose:
//   * inflateMemberSync() — pure JS, used by the worker's FS read hook, which
//     Emscripten calls SYNCHRONOUSLY and so cannot await DecompressionStream.
//     Measured on this machine: 0.52 ms per 64 KiB member (119.6 MiB/s),
//     1.92 ms per 256 KiB member (130.5 MiB/s).
//   * inflateMemberAsync() — native DecompressionStream where available, for
//     the page's eager path and the worker's readahead, both of which can await.
// The sync one also CHECKS CRC32 and ISIZE per member, which is a real
// integrity check on every block a game touches — the 2026-08-27 prod break
// (parts served as 133-byte Git-LFS pointers, diagnosed only as an SH4 crash)
// would have surfaced as a named error on the first read.
(function (root) {
  'use strict';
  const INF_LBASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
  const INF_LEXT  = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  const INF_DBASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
  const INF_DEXT  = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
  const INF_ORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
  function huffBuild(lengths, n) {
    const count = new Int32Array(16);
    for (let i = 0; i < n; i++) count[lengths[i]]++;
    count[0] = 0;
    const offs = new Int32Array(16);
    for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
    const symbol = new Int32Array(n);
    for (let i = 0; i < n; i++) if (lengths[i]) symbol[offs[lengths[i]]++] = i;
    return { count: count, symbol: symbol };
  }
  let INF_FIXED = null;
  function fixedTables() {
    if (INF_FIXED) return INF_FIXED;
    const l = new Uint8Array(288);
    for (let i = 0; i < 144; i++) l[i] = 8;
    for (let i = 144; i < 256; i++) l[i] = 9;
    for (let i = 256; i < 280; i++) l[i] = 7;
    for (let i = 280; i < 288; i++) l[i] = 8;
    const d = new Uint8Array(30);
    for (let i = 0; i < 30; i++) d[i] = 5;
    INF_FIXED = { lc: huffBuild(l, 288), dc: huffBuild(d, 30) };
    return INF_FIXED;
  }
  let INF_CRCT = null;
  function crc32(buf) {
    if (!INF_CRCT) {
      INF_CRCT = new Int32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        INF_CRCT[n] = c;
      }
    }
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = INF_CRCT[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }
  function inflateRaw(src, pos, hint) {
    let out = new Uint8Array(hint > 0 ? hint : 1 << 20);
    let o = 0, p = pos, bitbuf = 0, bitcnt = 0;
    function bits(need) {
      let val = bitbuf;
      while (bitcnt < need) {
        if (p >= src.length) throw new Error('inflate: out of input');
        val |= src[p++] << bitcnt;
        bitcnt += 8;
      }
      bitbuf = val >>> need;
      bitcnt -= need;
      return val & ((1 << need) - 1);
    }
    function ensure(extra) {
      if (o + extra <= out.length) return;
      let cap = out.length || 1;
      while (cap < o + extra) cap *= 2;
      const nb = new Uint8Array(cap);
      nb.set(out.subarray(0, o));
      out = nb;
    }
    function decode(h) {
      let code = 0, first = 0, index = 0;
      for (let len = 1; len <= 15; len++) {
        code |= bits(1);
        const count = h.count[len];
        if (code - count < first) return h.symbol[index + (code - first)];
        index += count; first += count; first <<= 1; code <<= 1;
      }
      throw new Error('inflate: invalid code');
    }
    function codes(lc, dc) {
      for (;;) {
        let sym = decode(lc);
        if (sym < 256) { ensure(1); out[o++] = sym; continue; }
        if (sym === 256) return;
        sym -= 257;
        if (sym >= 29) throw new Error('inflate: invalid length code');
        const len = INF_LBASE[sym] + bits(INF_LEXT[sym]);
        const ds = decode(dc);
        if (ds >= 30) throw new Error('inflate: invalid distance code');
        const dist = INF_DBASE[ds] + bits(INF_DEXT[ds]);
        if (dist > o) throw new Error('inflate: distance too far back');
        ensure(len);
        let from = o - dist;
        for (let i = 0; i < len; i++) out[o++] = out[from++];
      }
    }
    let last = 0;
    do {
      last = bits(1);
      const type = bits(2);
      if (type === 0) {
        bitbuf = 0; bitcnt = 0;                       // stored: byte-align
        if (p + 4 > src.length) throw new Error('inflate: stored block truncated');
        const len = src[p] | (src[p + 1] << 8);
        const nl = src[p + 2] | (src[p + 3] << 8);
        if ((len ^ 0xffff) !== nl) throw new Error('inflate: stored length mismatch');
        p += 4;
        if (p + len > src.length) throw new Error('inflate: stored block truncated');
        ensure(len);
        out.set(src.subarray(p, p + len), o);
        o += len; p += len;
      } else if (type === 1) {
        const f = fixedTables();
        codes(f.lc, f.dc);
      } else if (type === 2) {
        const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
        if (nlen > 286 || ndist > 30) throw new Error('inflate: too many codes');
        const lengths = new Uint8Array(320);
        for (let i = 0; i < ncode; i++) lengths[INF_ORDER[i]] = bits(3);
        for (let i = ncode; i < 19; i++) lengths[INF_ORDER[i]] = 0;
        const clc = huffBuild(lengths, 19);
        let idx = 0;
        while (idx < nlen + ndist) {
          const sym = decode(clc);
          if (sym < 16) { lengths[idx++] = sym; continue; }
          let val = 0, rep;
          if (sym === 16) {
            if (idx === 0) throw new Error('inflate: repeat with no previous length');
            val = lengths[idx - 1]; rep = 3 + bits(2);
          } else if (sym === 17) rep = 3 + bits(3);
          else rep = 11 + bits(7);
          if (idx + rep > nlen + ndist) throw new Error('inflate: too many lengths');
          while (rep--) lengths[idx++] = val;
        }
        if (lengths[256] === 0) throw new Error('inflate: no end-of-block code');
        codes(huffBuild(lengths, nlen), huffBuild(lengths.subarray(nlen, nlen + ndist), ndist));
      } else {
        throw new Error('inflate: invalid block type');
      }
    } while (!last);
    return out.subarray(0, o);
  }
  function gunzipBytes(u8) {
    if (u8.length < 18 || u8[0] !== 0x1f || u8[1] !== 0x8b) throw new Error('gunzip: not a gzip stream');
    if (u8[2] !== 8) throw new Error('gunzip: unsupported method ' + u8[2]);
    const flg = u8[3];
    let p = 10;
    if (flg & 4) p += 2 + (u8[p] | (u8[p + 1] << 8));            // FEXTRA
    if (flg & 8) { while (p < u8.length && u8[p]) p++; p++; }     // FNAME
    if (flg & 16) { while (p < u8.length && u8[p]) p++; p++; }    // FCOMMENT
    if (flg & 2) p += 2;                                          // FHCRC
    const n = u8.length;
    const crc   = (u8[n - 8] | (u8[n - 7] << 8) | (u8[n - 6] << 16) | (u8[n - 5] << 24)) >>> 0;
    const isize = (u8[n - 4] | (u8[n - 3] << 8) | (u8[n - 2] << 16) | (u8[n - 1] << 24)) >>> 0;
    const out = inflateRaw(u8, p, isize);
    if (out.length !== isize) throw new Error('gunzip: inflated ' + out.length + ' B, ISIZE says ' + isize);
    if (crc32(out) !== crc) throw new Error('gunzip: CRC32 mismatch');
    return out;
  }

  // ── index helpers ─────────────────────────────────────────────────────────
  // prepare() turns the wire index into one with prefix sums, so a lookup is
  // arithmetic and not a scan. Called once per disc file.
  function prepare(idx, base) {
    if (!idx || idx.format !== 'bgz1') throw new Error('bgz: bad index format ' + (idx && idx.format));
    let uStart = 0;
    const parts = idx.parts.map(function (p) {
      const cOff = new Float64Array(p.clen.length + 1);
      for (let i = 0; i < p.clen.length; i++) cOff[i + 1] = cOff[i] + p.clen[i];
      if (cOff[p.clen.length] !== p.csize) {
        throw new Error('bgz: ' + p.url + ' block lengths sum to ' + cOff[p.clen.length] +
                        ' B, index says csize ' + p.csize);
      }
      const q = { url: (base || '') + p.url, raw: p.raw, csize: p.csize, clen: p.clen,
                  cOff: cOff, uStart: uStart, nBlocks: p.clen.length };
      uStart += p.raw;
      return q;
    });
    if (uStart !== idx.bytes) {
      throw new Error('bgz: parts total ' + uStart + ' B, index says bytes ' + idx.bytes);
    }
    return { format: idx.format, name: idx.name, bytes: idx.bytes, block: idx.block, parts: parts };
  }

  // Which block holds guest byte `pos`, and where its compressed bytes live.
  // Returns null past the end.
  function locate(ix, pos) {
    if (pos < 0 || pos >= ix.bytes) return null;
    let lo = 0, hi = ix.parts.length - 1, pi = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const p = ix.parts[mid];
      if (pos < p.uStart) hi = mid - 1;
      else if (pos >= p.uStart + p.raw) lo = mid + 1;
      else { pi = mid; break; }
    }
    const p = ix.parts[pi];
    const bi = Math.floor((pos - p.uStart) / ix.block);
    const uOff = p.uStart + bi * ix.block;                       // guest offset of block start
    const uLen = Math.min(ix.block, p.raw - bi * ix.block);      // uncompressed length
    return { part: p, partIndex: pi, blockIndex: bi, url: p.url,
             cFrom: p.cOff[bi], cTo: p.cOff[bi + 1] - 1, uOff: uOff, uLen: uLen,
             key: pi * 1000000 + bi };
  }

  // Total blocks, for readahead bounds.
  function blockCount(ix) {
    let n = 0;
    for (let i = 0; i < ix.parts.length; i++) n += ix.parts[i].nBlocks;
    return n;
  }

  // The block AFTER `loc`, or null at the end of the image. Readahead walks
  // this rather than assuming a uniform block index across parts, because the
  // last block of each part is short.
  function next(ix, loc) {
    if (loc.blockIndex + 1 < loc.part.nBlocks) return locate(ix, loc.uOff + loc.uLen);
    if (loc.partIndex + 1 >= ix.parts.length) return null;
    return locate(ix, ix.parts[loc.partIndex + 1].uStart);
  }

  // ── inflate ───────────────────────────────────────────────────────────────
  function inflateMemberSync(u8) { return gunzipBytes(u8); }

  const HAS_DS = (typeof DecompressionStream === 'function');
  async function inflateMemberAsync(u8) {
    if (!HAS_DS) return gunzipBytes(u8);
    const ab = await new Response(
      new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))
    ).arrayBuffer();
    return new Uint8Array(ab);
  }

  root.BGZ = {
    prepare: prepare,
    locate: locate,
    next: next,
    blockCount: blockCount,
    inflateMemberSync: inflateMemberSync,
    inflateMemberAsync: inflateMemberAsync,
    hasNativeInflate: HAS_DS,
  };
})(typeof self !== 'undefined' ? self : globalThis);
