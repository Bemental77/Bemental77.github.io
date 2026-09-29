// sr_gp_thin.js — split the SR guest's GP stream into frames and, for a frame the renderer will
// never show, drop ONLY its draw commands.
//
// WHY.  The page relays frames to Dolphin with backpressure (gamecube.html forwards Dolphin's
// recompAck as {cmd:'ack'}; sr_render_worker.js keeps at most 2 posts un-acked).  While it holds,
// frames keep arriving.  A superseded frame cannot simply be skipped: the GP is a STATE MACHINE,
// and every later frame is decoded against the CP/XF/BP state its commands left behind (vertex
// formats, matrices, TEV, texture setup).  What a superseded frame contributes that nobody sees is
// its PIXELS -- the primitives.  So its state commands are kept, in order, and its primitive
// commands (0x80-0xBF: header + count x vertex size) are removed.
//
// SIZING is sr_gx.c's gp_feed / vtx_size, the same walk the guest's own PE model uses, carried
// across calls (VCD/VAT persist from the first byte of the stream).  A frame is walked ONCE, on
// arrival, recording the byte ranges of its primitives; thinning later just cuts those ranges out.
// A frame that does not walk cleanly (an unknown opcode, or the last command running past the
// frame's end) is NEVER thinned: it is kept whole and counted, because a wrong cut would desync
// the stream for every later frame.
//
// A frame ends just past a copy to the XFB (BP 0x52 with bit 14), which is also where sr_gx.c
// publishes the ring (sr_gx_mark_frame), so a pump chunk always ends on a frame boundary.

const cf = (f) => (f <= 1 ? 1 : f <= 3 ? 2 : 4);
const CS = [2, 3, 4, 2, 3, 4];
const CNT_BIT = [21, 0, 9, 18, 27, 5, 14, 23], FMT_BIT = [22, 1, 10, 19, 28, 6, 15, 24], GRP = [0, 1, 1, 1, 1, 2, 2, 2];

export class GpThinner {
  constructor() {
    this.vlo = 0; this.vhi = 0;
    this.vat = Array.from({ length: 8 }, () => [0, 0, 0]);
    this.unknown = 0; this.badFmt = 0;
  }
  vsize(v) {                                           // sr_gx.c vtx_size, line for line
    const lo = this.vlo, hi = this.vhi, [g0, g1, g2] = this.vat[v];
    let s = 0, t;
    for (let b = 0; b < 9; b++) s += (lo >>> b) & 1;
    t = (lo >>> 9) & 3; if (t === 1) s += cf((g0 >>> 1) & 7) * ((g0 & 1) ? 3 : 2); else if (t) s += t - 1;
    t = (lo >>> 11) & 3;
    if (t) { const ntb = (g0 >>> 9) & 1, i3 = (g0 >>> 31) & 1;
      s += t === 1 ? cf((g0 >>> 10) & 7) * (ntb ? 9 : 3) : (t - 1) * (ntb && i3 ? 3 : 1); }
    for (let c = 0; c < 2; c++) {
      t = (lo >>> (13 + 2 * c)) & 3; const f = (g0 >>> (c ? 18 : 14)) & 7;
      if (t === 1) { if (f > 5) this.badFmt++; else s += CS[f]; } else if (t) s += t - 1;
    }
    for (let i = 0; i < 8; i++) {
      t = (hi >>> (2 * i)) & 3; if (!t) continue;
      const g = GRP[i] === 0 ? g0 : GRP[i] === 1 ? g1 : g2;
      s += t === 1 ? cf((g >>> FMT_BIT[i]) & 7) * (((g >>> CNT_BIT[i]) & 1) ? 2 : 1) : t - 1;
    }
    return s;
  }
  // Walk one pump chunk (whole frames).  Returns [{ bytes, prims: [[a,b],...], clean }] per frame.
  split(b) {
    const out = [];
    const u32 = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    let i = 0, start = 0, prims = [], clean = true;
    const cut = (end) => { out.push({ bytes: b.subarray(start, end), prims: prims.map(([x, y]) => [x - start, y - start]), clean });
                           start = end; prims = []; clean = true; };
    while (i < b.length) {
      const op = b[i];
      if (op === 0x00) { i += 1; continue; }
      if (op === 0x08) {
        const s = b[i + 1], v = u32(i + 2);
        switch (s & 0xF0) {
          case 0x50: this.vlo = v; break; case 0x60: this.vhi = v; break;
          case 0x70: this.vat[s & 7][0] = v; break; case 0x80: this.vat[s & 7][1] = v; break;
          case 0x90: this.vat[s & 7][2] = v; break; default: break;
        }
        i += 6; continue;
      }
      if (op === 0x10) { i += 5 + 4 * (((u32(i + 1) >>> 16) & 0xF) + 1); continue; }
      if (op === 0x20 || op === 0x28 || op === 0x30 || op === 0x38) { i += 5; continue; }
      if (op === 0x40) { i += 9; continue; }
      if (op === 0x48) { i += 1; continue; }
      if (op === 0x61) {
        const isCopy = b[i + 1] === 0x52 && (b[i + 3] & 0x40);
        i += 5;
        if (isCopy) cut(Math.min(i, b.length));
        continue;
      }
      if (op >= 0x80 && op <= 0xBF) {
        const n = (b[i + 1] << 8) | b[i + 2];
        const end = i + 3 + n * this.vsize(op & 7);
        prims.push([i, Math.min(end, b.length)]);
        i = end; continue;
      }
      this.unknown++; clean = false; i += 1;       // gp_feed's OnUnknown: one byte
    }
    if (i !== b.length) clean = false;             // last command ran past the chunk
    if (start < b.length) cut(b.length);           // a tail with no copy (should not happen: see top)
    return out;
  }
}

// The frame's bytes with its primitive ranges removed (state commands kept, in order).
export function stripDraws(fr) {
  if (!fr.prims.length) return fr.bytes;
  let keep = fr.bytes.length;
  for (const [a, b] of fr.prims) keep -= (b - a);
  const o = new Uint8Array(keep);
  let w = 0, r = 0;
  for (const [a, b] of fr.prims) { o.set(fr.bytes.subarray(r, a), w); w += a - r; r = b; }
  o.set(fr.bytes.subarray(r), w);
  return o;
}
