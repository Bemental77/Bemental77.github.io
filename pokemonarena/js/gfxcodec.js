// pokemonarena/js/gfxcodec.js
//
// ROM graphics codecs for the SoulGold v1.1.1 ROM (Emerald engine with a pokeemerald-expansion data layout).
// Pure ES module: runs in the browser and in Node. No node: imports, no Buffer; Uint8Array / DataView only.
// Everything here is hand-written code. It contains no ROM-derived data; pixels are produced at runtime from
// the ROM bytes the caller hands in.
//
// Contents
//   * GBA BIOS LZ77 (type 0x10)                         lz77Probe / lz77Decode
//   * the expansion's "smol" tANS picture + tilemap     smolHeader / smolDecode / smolTilemapDecode / smolProbe
//   * 4bpp / 8bpp tile sheets -> indexed bitmaps        tilesToBitmap   (1D, 2D and metatile orderings)
//   * tilemap entries (h/v flip + palette bank)         renderTilemap
//   * BGR555 palettes -> RGBA                           readPalette / paletteToRGBA / bitmapToRGBA
//   * 1bpp / 2bpp font glyph decoders                   decodeGlyph2bpp / decodeGlyph1bpp
//
// Conventions
//   * A "bitmap" is { width, height, pixels: Uint8Array(width*height) } of PALETTE INDICES. pixels hold the
//     colour index straight from the tile data (0..15 for 4bpp, 0..255 for 8bpp); renderTilemap folds the tilemap
//     entry's palette bank in, as bank*16 + index, so one 256-entry palette covers a whole background.
//   * Colour index 0 is transparent on the GBA. bitmapToRGBA takes { transparent0 } (default true).
//   * Every decoder is deterministic and side-effect free.

export class GfxError extends Error {
  constructor(msg) { super(msg); this.name = 'GfxError'; }
}

/* ------------------------------------------------------------------------------------------------ LZ77 */

// GBA BIOS LZ77UnComp (type 0x10): header byte 0x10, 24-bit decompressed size, then flag bytes (MSB first);
// a set flag = 2-byte back-reference (len = hi nibble + 3, disp = 12 bits + 1), a clear flag = literal byte.
// Returns { data, size, consumed } or null when the bytes are not a well-formed LZ77 stream. Never throws on
// bad input: it is what the contact-sheet scanner calls on every candidate offset.
export function lz77Probe(buf, off, maxSize = 0x100000) {
  if (off < 0 || off + 4 > buf.length || buf[off] !== 0x10) return null;
  const size = buf[off + 1] | (buf[off + 2] << 8) | (buf[off + 3] << 16);
  if (size === 0 || size > maxSize) return null;
  const out = new Uint8Array(size);
  let ip = off + 4, op = 0;
  while (op < size) {
    if (ip >= buf.length) return null;
    const flags = buf[ip++];
    for (let b = 7; b >= 0 && op < size; b--) {
      if (flags & (1 << b)) {
        if (ip + 1 >= buf.length) return null;
        const b1 = buf[ip++], b2 = buf[ip++];
        const len = (b1 >> 4) + 3, disp = (((b1 & 15) << 8) | b2) + 1;
        if (disp > op) return null;
        for (let k = 0; k < len && op < size; k++) { out[op] = out[op - disp]; op++; }
      } else {
        if (ip >= buf.length) return null;
        out[op++] = buf[ip++];
      }
    }
  }
  return { data: out, size, consumed: ip - off };
}

export function lz77Decode(buf, off) {
  const r = lz77Probe(buf, off);
  if (!r) throw new GfxError('not a valid LZ77 stream at 0x' + off.toString(16));
  return r;
}

/* ------------------------------------------------------------------------------------------------ smol */
//
// The expansion's picture codec ("smol"). 8-byte header:
//   u32 A = mode:4 | imageSize:14 | symSize:14      (imageSize counts 4-byte words of output)
//   u32 B = initialState:6 | bitstreamSize:13 | loSize:13   (bitstreamSize counts 4-byte words)
// A compressed picture is an instruction stream (lo: LEB-style length/offset bytes) over a vector of 16-bit
// "symbols" (sym: four 4-bit nibbles each). Depending on the mode the lo and/or sym vectors are themselves
// tANS-coded (one shared bitstream, one carried state; nibble frequency tables are 3 packed u32 each) and the sym
// vector may be delta coded:
//   mode 1  neither coded      mode 2  sym coded      mode 3  sym coded + delta
//   mode 4  lo coded           mode 5  lo+sym coded   mode 6  lo+sym coded + sym delta
//   mode 8  tilemap: header is { u32 A = 8 | tilemapSize:14 | symSize:14 ; u32 tileNumberSize }, raw sym u16s,
//           then the same instruction stream, then a running-sum delta over the u16 entries.
// This decoder was written against the layout above and verified by self-consistency on every picture (the
// output length must equal imageSize*4, the symbols consumed must equal symSize, and the instruction bytes
// consumed must equal loSize); see tools/pokemonarena_ui_assets_test.mjs.

export function smolHeader(buf, off) {
  if (off < 0 || off + 8 > buf.length) throw new GfxError('smol header out of range at 0x' + off.toString(16));
  const A = (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
  const B = (buf[off + 4] | (buf[off + 5] << 8) | (buf[off + 6] << 16) | (buf[off + 7] << 24)) >>> 0;
  return {
    mode: A & 0xF, imageSize: (A >>> 4) & 0x3FFF, symSize: (A >>> 18) & 0x3FFF,
    initialState: B & 0x3F, bitstreamSize: (B >>> 6) & 0x1FFF, loSize: (B >>> 19) & 0x1FFF,
  };
}

function u32le(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

// 3 packed u32 -> 16 nibble frequencies (which must total 64) -> 64-entry decode table of {sym, k, y}.
function smolBuildTable(buf, o) {
  if (o + 12 > buf.length) throw new GfxError('smol frequency table out of range');
  const f = new Array(16).fill(0);
  let f15 = 0;
  for (let i = 0; i < 3; i++) {
    const w = u32le(buf, o + 4 * i);
    for (let j = 0; j < 5; j++) f[i * 5 + j] = (w >>> (6 * j)) & 0x3F;
    f15 += (w & 0xC0000000) >>> (30 - 2 * i) >>> 0;
  }
  f[15] = f15;
  let total = 0;
  for (let i = 0; i < 16; i++) total += f[i];
  if (total !== 64) throw new GfxError('smol frequency table sums to ' + total + ', expected 64');
  const sym = new Uint8Array(64), kk = new Uint8Array(64), yy = new Uint16Array(64);
  let n = 0;
  for (let s = 0; s < 16; s++) {
    for (let t = 0; t < f[s]; t++) {
      const j = f[s] + t;             // 1..127
      const k = 6 - (31 - Math.clz32(j));
      sym[n] = s; kk[n] = k; yy[n] = (j << k) - 64; n++;
    }
  }
  return { sym, k: kk, y: yy };
}

// Shared by images (mode 1..6) and tilemaps (mode 8): the lo/sym instruction interpreter.
function smolInstructions(lo, loSize, sym, symSize, dest) {
  let d = 0, sp = 0, lp = 0;
  const cap = dest.length;
  do {
    if (lp >= lo.length) throw new GfxError('smol instruction stream truncated');
    let len, off;
    if (lo[lp] & 0x80) {
      len = (lo[lp] & 0x7F) | (lo[lp + 1] << 7);
      off = lo[lp + 2] & 0x7F;
      if (lo[lp + 2] & 0x80) { off |= lo[lp + 3] << 7; lp += 4; } else lp += 3;
    } else {
      len = lo[lp] & 0x7F;
      off = lo[lp + 1] & 0x7F;
      if (lo[lp + 1] & 0x80) { off |= lo[lp + 2] << 7; lp += 3; } else lp += 2;
    }
    if (len !== 0) {
      if (sp >= symSize) throw new GfxError('smol symbol vector exhausted');
      const v = sym[sp++];
      if (d + 1 + len > cap) throw new GfxError('smol output overflow');
      dest[d++] = v;
      if (off === 1) { for (let i = 0; i < len; i++) dest[d++] = v; }
      else {
        if (off > d) throw new GfxError('smol back-reference before start of output');
        let from = d - off;
        for (let i = 0; i < len; i++) dest[d++] = dest[from++];
      }
    } else {
      if (sp + off > symSize) throw new GfxError('smol symbol vector exhausted');
      if (d + off > cap) throw new GfxError('smol output overflow');
      for (let i = 0; i < off; i++) dest[d++] = sym[sp++];
    }
  } while (lp < loSize);
  return { produced: d, symUsed: sp, loUsed: lp };
}

// Decode a smol picture (modes 1..6). Returns { data: Uint8Array(imageSize*4), header, consumed } where
// `consumed` is the number of ROM bytes the compressed blob occupies (header + tables + bitstream + any raw
// tail), so blobs can be walked back to back. Throws GfxError on any inconsistency.
export function smolDecode(buf, off) {
  const h = smolHeader(buf, off);
  if (h.mode === 0) throw new GfxError('mode 0 is LZ77, not smol');
  if (h.mode < 1 || h.mode > 6) throw new GfxError('unsupported smol mode ' + h.mode);
  if (h.loSize === 0 || h.symSize === 0) throw new GfxError('empty smol stream');
  const loEnc = h.mode >= 4;
  const symEnc = h.mode === 2 || h.mode === 3 || h.mode >= 5;
  const symDelta = h.mode === 3 || h.mode === 6;
  let p = off + 8, loT = null, symT = null;
  if (h.mode === 4) { loT = smolBuildTable(buf, p); p += 12; }
  else if (h.mode === 2 || h.mode === 3) { symT = smolBuildTable(buf, p); p += 12; }
  else if (h.mode >= 5) { loT = smolBuildTable(buf, p); symT = smolBuildTable(buf, p + 12); p += 24; }
  const bsStart = p;
  let leftover = p + ((loEnc || symEnc) ? 4 * h.bitstreamSize : 0);
  if (leftover > buf.length) throw new GfxError('smol bitstream runs past the end of the ROM');
  let bitPos = 0, state = h.initialState;
  const decodeNibbles = (T, n, delta) => {
    const out = new Uint8Array(n);
    let cur = 0;
    for (let i = 0; i < n; i++) {
      if (state > 63) throw new GfxError('smol tANS state ' + state + ' out of range');
      let s = T.sym[state];
      if (delta) { cur = (cur + s) & 0xF; s = cur; }
      out[i] = s;
      const k = T.k[state];
      const bi = bsStart + (bitPos >> 3);
      const v = (((buf[bi] | (buf[bi + 1] << 8)) >> (bitPos & 7)) & ((1 << k) - 1));
      bitPos += k;
      state = T.y[state] + v;
    }
    return out;
  };
  let loVec, symVec;
  if (loEnc) {
    const nib = decodeNibbles(loT, h.loSize * 2, false);
    loVec = new Uint8Array(h.loSize);
    for (let i = 0; i < h.loSize; i++) loVec[i] = nib[2 * i] | (nib[2 * i + 1] << 4);
  }
  if (symEnc) {
    const nib = decodeNibbles(symT, h.symSize * 4, symDelta);
    symVec = new Uint16Array(h.symSize);
    for (let i = 0; i < h.symSize; i++) symVec[i] = nib[4 * i] | (nib[4 * i + 1] << 4) | (nib[4 * i + 2] << 8) | (nib[4 * i + 3] << 12);
  }
  if (!symEnc) {
    if (leftover + 2 * h.symSize > buf.length) throw new GfxError('smol raw symbols run past the end of the ROM');
    symVec = new Uint16Array(h.symSize);
    for (let i = 0; i < h.symSize; i++) symVec[i] = buf[leftover + 2 * i] | (buf[leftover + 2 * i + 1] << 8);
    leftover += h.symSize * 2;
  }
  if (!loEnc) {
    if (leftover + h.loSize > buf.length) throw new GfxError('smol raw lo bytes run past the end of the ROM');
    loVec = buf.subarray(leftover, leftover + h.loSize);
    leftover += h.loSize;
  }
  const dest = new Uint16Array(h.imageSize * 2);
  const r = smolInstructions(loVec, h.loSize, symVec, h.symSize, dest);
  if (r.produced !== h.imageSize * 2) throw new GfxError('smol produced ' + r.produced * 2 + ' bytes, header says ' + h.imageSize * 4);
  if (r.symUsed !== h.symSize) throw new GfxError('smol consumed ' + r.symUsed + ' symbols, header says ' + h.symSize);
  if (r.loUsed !== h.loSize) throw new GfxError('smol consumed ' + r.loUsed + ' instruction bytes, header says ' + h.loSize);
  const data = new Uint8Array(h.imageSize * 4);
  for (let i = 0; i < dest.length; i++) { data[2 * i] = dest[i] & 0xFF; data[2 * i + 1] = dest[i] >> 8; }
  return { data, header: h, consumed: leftover - off };
}

export function smolProbe(buf, off) {
  try { return smolDecode(buf, off); } catch (e) { if (e instanceof GfxError) return null; throw e; }
}

// Smol tilemap (mode 8). Returns { entries: Uint16Array(tilemapSize/2), header, consumed }.
export function smolTilemapDecode(buf, off) {
  if (off < 0 || off + 8 > buf.length) throw new GfxError('smol tilemap header out of range');
  const A = u32le(buf, off), tileNumberSize = u32le(buf, off + 4);
  const mode = A & 0xF, tilemapSize = (A >>> 4) & 0x3FFF, symSize = (A >>> 18) & 0x3FFF;
  if (mode !== 8) throw new GfxError('not a smol tilemap (mode ' + mode + ')');
  if (tilemapSize === 0 || tilemapSize & 1 || symSize === 0 || tileNumberSize === 0 || tileNumberSize > 0x10000) {
    throw new GfxError('implausible smol tilemap header');
  }
  const data = off + 8;
  const loOffset = symSize * 2 + 2 * (symSize % 2);
  if (data + loOffset + tileNumberSize > buf.length) throw new GfxError('smol tilemap runs past the end of the ROM');
  const sym = new Uint16Array(symSize);
  for (let i = 0; i < symSize; i++) sym[i] = buf[data + 2 * i] | (buf[data + 2 * i + 1] << 8);
  const lo = buf.subarray(data + loOffset, data + loOffset + tileNumberSize);
  const dest = new Uint16Array(tilemapSize / 2);
  const r = smolInstructions(lo, tileNumberSize, sym, symSize, dest);
  if (r.produced !== dest.length) throw new GfxError('smol tilemap produced ' + r.produced + ' entries, header says ' + dest.length);
  if (r.symUsed !== symSize) throw new GfxError('smol tilemap consumed ' + r.symUsed + ' symbols, header says ' + symSize);
  if (r.loUsed !== tileNumberSize) throw new GfxError('smol tilemap consumed ' + r.loUsed + ' instruction bytes, header says ' + tileNumberSize);
  const entries = new Uint16Array(dest.length);
  let prev = 0;
  for (let i = 0; i < dest.length; i++) { prev = (prev + dest[i]) & 0xFFFF; entries[i] = prev; }
  return { entries, header: { mode, tilemapSize, symSize, tileNumberSize }, consumed: 8 + loOffset + tileNumberSize };
}

export function smolTilemapProbe(buf, off) {
  try { return smolTilemapDecode(buf, off); } catch (e) { if (e instanceof GfxError) return null; throw e; }
}

// One entry point for "a compressed graphic of unknown flavour at this offset": LZ77 first (header byte 0x10),
// then smol. Returns { data, kind: 'lz77'|'smol', consumed } or null.
export function decompressAny(buf, off) {
  if (buf[off] === 0x10) {
    const r = lz77Probe(buf, off);
    if (r) return { data: r.data, kind: 'lz77', consumed: r.consumed };
  }
  const s = smolProbe(buf, off);
  if (s) return { data: s.data, kind: 'smol' + s.header.mode, consumed: s.consumed };
  return null;
}

/* --------------------------------------------------------------------------------------- tile sheets */

// Tile data -> indexed bitmap.
//   data       Uint8Array of 4bpp (32 B/tile) or 8bpp (64 B/tile) tiles
//   tilesW/H   size of the produced bitmap in 8x8 tiles
//   opts.bpp   4 (default) or 8
//   opts.metaW, opts.metaH   tiles per metatile (gbagfx "-mwidth/-mheight"): the data is ordered metatile by
//              metatile (left to right, then down), row-major inside each. 0/1 = plain row-major (the 1D
//              OBJ ordering of a tilesW-wide sprite is exactly this).
//   opts.vramStride   if set, the data is laid out as a 2D OBJ VRAM image whose rows are vramStride tiles apart
//              (tile (x,y) is at tile index y*vramStride + x) instead of packed.
//   opts.firstTile    index of the first tile to use (default 0)
// 4bpp tiles: low nibble = left pixel. Pixels beyond the data are index 0.
export function tilesToBitmap(data, tilesW, tilesH, opts = {}) {
  const bpp = opts.bpp === 8 ? 8 : 4;
  const tileBytes = bpp === 8 ? 64 : 32;
  const metaW = opts.metaW > 1 ? opts.metaW : 0, metaH = opts.metaH > 1 ? opts.metaH : 0;
  const first = opts.firstTile || 0;
  const W = tilesW * 8, H = tilesH * 8;
  const pixels = new Uint8Array(W * H);
  const metasPerRow = metaW ? Math.ceil(tilesW / metaW) : 0;
  for (let ty = 0; ty < tilesH; ty++) {
    for (let tx = 0; tx < tilesW; tx++) {
      let t;
      if (opts.vramStride) t = ty * opts.vramStride + tx;
      else if (metaW && metaH) {
        const mx = (tx / metaW) | 0, my = (ty / metaH) | 0;
        t = (my * metasPerRow + mx) * metaW * metaH + (ty % metaH) * metaW + (tx % metaW);
      } else t = ty * tilesW + tx;
      const base = (first + t) * tileBytes;
      if (base + tileBytes > data.length) continue;
      for (let y = 0; y < 8; y++) {
        const row = (ty * 8 + y) * W + tx * 8;
        if (bpp === 8) {
          for (let x = 0; x < 8; x++) pixels[row + x] = data[base + y * 8 + x];
        } else {
          for (let x = 0; x < 8; x += 2) {
            const b = data[base + y * 4 + (x >> 1)];
            pixels[row + x] = b & 15;
            pixels[row + x + 1] = b >> 4;
          }
        }
      }
    }
  }
  return { width: W, height: H, pixels };
}

// Render a tilemap over a 4bpp tile set. entries: Uint16Array of GBA text-BG entries
// (bits 0-9 tile, 10 hflip, 11 vflip, 12-15 palette bank). Returns an indexed bitmap whose pixel values are
// bank*16 + index (index 0 of any bank stays "transparent" only when bank*16+0 is treated so by the caller;
// use opts.transparentZero = true to force pixel value 0 wherever the tile index is 0).
export function renderTilemap(tileData, entries, mapW, mapH, opts = {}) {
  const W = mapW * 8, H = mapH * 8;
  const pixels = new Uint8Array(W * H);
  const tileBase = opts.tileBase || 0;
  for (let my = 0; my < mapH; my++) {
    for (let mx = 0; mx < mapW; mx++) {
      const e = entries[my * mapW + mx];
      const tile = (e & 0x3FF) - tileBase;
      const hf = (e >> 10) & 1, vf = (e >> 11) & 1, bank = (e >> 12) & 15;
      const base = tile * 32;
      if (tile < 0 || base + 32 > tileData.length) continue;
      for (let y = 0; y < 8; y++) {
        const sy = vf ? 7 - y : y;
        for (let x = 0; x < 8; x++) {
          const sx = hf ? 7 - x : x;
          const b = tileData[base + sy * 4 + (sx >> 1)];
          const idx = (sx & 1) ? (b >> 4) : (b & 15);
          pixels[(my * 8 + y) * W + mx * 8 + x] = (idx === 0 && opts.transparentZero) ? 0 : bank * 16 + idx;
        }
      }
    }
  }
  return { width: W, height: H, pixels };
}

// Cut a sub-rectangle (in pixels) out of a bitmap.
export function cropBitmap(bm, x0, y0, w, h) {
  const pixels = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x0 + x, sy = y0 + y;
      if (sx >= 0 && sx < bm.width && sy >= 0 && sy < bm.height) pixels[y * w + x] = bm.pixels[sy * bm.width + sx];
    }
  }
  return { width: w, height: h, pixels };
}

/* ----------------------------------------------------------------------------------------- palettes */

// Read `count` BGR555 entries (raw, uncompressed, little-endian u16) at ROM offset `off`.
export function readPalette(buf, off, count = 16) {
  if (off < 0 || off + count * 2 > buf.length) throw new GfxError('palette out of range at 0x' + off.toString(16));
  const p = new Uint16Array(count);
  for (let i = 0; i < count; i++) p[i] = buf[off + 2 * i] | (buf[off + 2 * i + 1] << 8);
  return p;
}

// BGR555 -> RGBA bytes (5-bit channel c -> (c<<3)|(c>>2), the usual 0..255 expansion). Returns Uint8Array(4*n).
// Alpha is 255 everywhere unless opts.transparent0 is set, which makes entries 0, 16, 32 ... transparent
// (index 0 of every 16-colour bank is the GBA's transparent colour).
export function paletteToRGBA(pal, opts = {}) {
  const out = new Uint8Array(pal.length * 4);
  for (let i = 0; i < pal.length; i++) {
    const c = pal[i];
    const r = c & 31, g = (c >> 5) & 31, b = (c >> 10) & 31;
    out[4 * i] = (r << 3) | (r >> 2);
    out[4 * i + 1] = (g << 3) | (g >> 2);
    out[4 * i + 2] = (b << 3) | (b >> 2);
    out[4 * i + 3] = (opts.transparent0 && (i & 15) === 0) ? 0 : 255;
  }
  return out;
}

// Indexed bitmap + palette -> RGBA (Uint8ClampedArray-compatible Uint8Array). Index 0 is transparent unless
// opts.transparent0 === false. pal may be a Uint16Array of BGR555 (<= 256 entries).
export function bitmapToRGBA(bm, pal, opts = {}) {
  const t0 = opts.transparent0 !== false;
  const rgba = paletteToRGBA(pal);
  const out = new Uint8Array(bm.width * bm.height * 4);
  for (let i = 0; i < bm.pixels.length; i++) {
    const idx = bm.pixels[i];
    const o = i * 4;
    if (idx >= pal.length || (t0 && (idx & 15) === 0)) continue;
    out[o] = rgba[idx * 4]; out[o + 1] = rgba[idx * 4 + 1]; out[o + 2] = rgba[idx * 4 + 2]; out[o + 3] = 255;
  }
  return out;
}

// A grayscale 16-colour BGR555 palette (index 0 black .. 15 white) for contact sheets of unidentified art.
export function grayPalette(n = 16) {
  const p = new Uint16Array(n);
  for (let i = 0; i < n; i++) { const v = Math.round(((i % 16) * 31) / 15); p[i] = v | (v << 5) | (v << 10); }
  return p;
}

/* -------------------------------------------------------------------------------------------- fonts */
//
// The ROM's fonts are stored the way the Emerald engine's text.c reads them: an array of glyphs (512 per font:
// the 256 Gen-3 character codes, then 256 "extra symbol" glyphs reached through the 0xF9 prefix), 64 bytes each,
// 2 bits per pixel. A glyph is four 8x8 2bpp tiles of 16 bytes: top-left at +0, top-right at +16, bottom-left at
// +32, bottom-right at +48. Each tile row is one little-endian u16 holding eight 2-bit pixels; the LEFTMOST pixel
// is in the HIGH two bits (bits 15-14) -- measured: decoding low-bits-first renders every glyph mirrored. The
// right-hand tiles are only used by glyphs wider than 8 px. A parallel 512-byte table (stored 0x200 bytes BEFORE
// the glyph array) gives each glyph's advance width in pixels.
// Pixel values are colour ROLES: 0 background (transparent), 1 foreground, 2 shadow. The ROM's glyph data also
// contains 3 in the cell rows above and below a glyph's body; text.c's half-row lookup treats it like 0, so
// by default it is folded to 0 (opts.fold3 === false keeps the raw value). The caller maps roles to palette entries.

export function decodeGlyph2bpp(buf, off, opts = {}) {
  const rows = opts.rows || 16;           // glyph cell height in pixels (two tile rows)
  const fold3 = opts.fold3 !== false;
  const out = new Uint8Array(16 * rows);  // 16 px wide cell
  const tiles = [[0, 0, 0], [8, 0, 16], [0, 8, 32], [8, 8, 48]];
  for (const [ox, oy, boff] of tiles) {
    for (let y = 0; y < 8; y++) {
      const o = off + boff + y * 2;
      const row = buf[o] | (buf[o + 1] << 8);
      for (let x = 0; x < 8; x++) {
        const py = oy + y;
        if (py < rows) {
          const v = (row >> (2 * (7 - x))) & 3;
          out[py * 16 + ox + x] = (fold3 && v === 3) ? 0 : v;
        }
      }
    }
  }
  return { width: 16, height: rows, pixels: out };
}

// 1bpp glyph: `bytesPerRow` bytes per row, `rows` rows, leftmost pixel in the LOW bit (the GBA/hardware order).
export function decodeGlyph1bpp(buf, off, rows = 8, bytesPerRow = 1) {
  const w = bytesPerRow * 8;
  const out = new Uint8Array(w * rows);
  for (let y = 0; y < rows; y++) {
    for (let bx = 0; bx < bytesPerRow; bx++) {
      const b = buf[off + y * bytesPerRow + bx];
      for (let x = 0; x < 8; x++) out[y * w + bx * 8 + x] = (b >> x) & 1;
    }
  }
  return { width: w, height: rows, pixels: out };
}
