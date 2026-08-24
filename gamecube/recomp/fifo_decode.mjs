// [wasm-recomp 2026-08-21] GP-FIFO decoder — the front-half of the render consumer.
// Parses the big-endian GameCube GP-FIFO byte stream that the recompiled game emits into
// gx_fifo_buf (via the software write-gather-pipe) into structured commands the WebGPU
// back-half can draw. Opcodes + register layout are from the decomp's GXCommandList.h and
// __GXSetVCD (CP regs 0x50/0x60 = the vertex descriptor). This is deliberately format-
// exact so it matches what Dolphin's own OpcodeDecoder consumes.
//
// Opcodes: 0x00 NOP, 0x08 LOAD_CP_REG, 0x10 LOAD_XF_REG, 0x20/28/30/38 LOAD_INDX_A..D,
//          0x40 CALL_DL, 0x48 INVL_VC, 0x61 LOAD_BP_REG, 0x80..0xB8 DRAW (prim|vat).

const PRIM = {
  0x80: 'QUADS', 0x88: 'QUADS2', 0x90: 'TRIANGLES', 0x98: 'TRIANGLE_STRIP',
  0xA0: 'TRIANGLE_FAN', 0xA8: 'LINES', 0xB0: 'LINE_STRIP', 0xB8: 'POINTS',
};

// Attribute component type codes in the VCD: 0=NONE, 1=DIRECT, 2=INDEX8, 3=INDEX16.
const idxBytes = (t) => (t === 3 ? 2 : t === 2 ? 1 : 0);
const FMT_SZ = [1, 1, 2, 2, 4];                 // U8, S8, U16, S16, F32
const COL_SZ = [2, 3, 4, 2, 3, 4];              // RGB565, RGB8, RGBX8, RGBA4, RGBA6, RGBA8
function readAttr(dv, off, fmt, shift) {         // read one position/texcoord element (big-endian)
  let v;
  if (fmt === 4) return dv.getFloat32(off, false);        // F32 (no shift)
  else if (fmt === 3) v = dv.getInt16(off, false);        // S16
  else if (fmt === 2) v = dv.getUint16(off, false);       // U16
  else if (fmt === 1) v = dv.getInt8(off);                // S8
  else v = dv.getUint8(off);                              // U8
  return v / (1 << (shift || 0));                          // fixed-point -> float
}

// Decode the full per-vertex layout from the VCD (CP 0x50/0x60) + VAT_A (CP 0x70). Sizes BOTH
// indexed and DIRECT attributes, and returns where the position lives within each vertex so the
// draw handler can extract it. Attribute order per the GX vertex format: PNMTXIDX, TEXnMTXIDX,
// POS, NRM, COL0, COL1, TEX0..7.
function vertexLayout(vcdLo, vcdHi, vat) {
  let off = 0, direct = false, posOff = -1, posComps = 0, posFmt = 4, posShift = 0;
  const posT = (vcdLo >> 9) & 3, nrmT = (vcdLo >> 11) & 3, c0T = (vcdLo >> 13) & 3, c1T = (vcdLo >> 15) & 3;
  if (vcdLo & 0x1) off += 1;                                              // PNMTXIDX
  for (let i = 0; i < 8; i++) if (vcdLo & (1 << (1 + i))) off += 1;       // TEXnMTXIDX
  if (posT === 1) { direct = true; posComps = ((vat & 1) ? 3 : 2); posFmt = (vat >> 1) & 7; posShift = (vat >> 4) & 0x1F; posOff = off; off += posComps * FMT_SZ[posFmt]; }
  else if (posT) off += idxBytes(posT);
  if (nrmT === 1) { direct = true; const nc = ((vat >> 9) & 1) ? 9 : 3; off += nc * FMT_SZ[(vat >> 10) & 7]; }
  else if (nrmT) off += idxBytes(nrmT);
  if (c0T === 1) { direct = true; off += COL_SZ[(vat >> 14) & 7]; }
  else if (c0T) off += idxBytes(c0T);
  if (c1T === 1) { direct = true; off += COL_SZ[(vat >> 18) & 7]; }
  else if (c1T) off += idxBytes(c1T);
  for (let i = 0; i < 8; i++) {
    const tT = (vcdHi >> (2 * i)) & 3;
    if (tT === 1) { direct = true; if (i === 0) { const tc = ((vat >> 21) & 1) ? 2 : 1; off += tc * FMT_SZ[(vat >> 22) & 7]; } else off += 2 * 4; }
    else if (tT) off += idxBytes(tT);
  }
  return { perVert: off, direct, posOff, posComps, posFmt, posShift, posElem: FMT_SZ[posFmt] };
}

export function decodeFifo(buf, len, fmt) {
  const dv = buf instanceof DataView ? buf : new DataView(buf.buffer || buf, buf.byteOffset || 0, len);
  const end = len ?? dv.byteLength;
  let p = 0;
  const cmds = [];
  let vcdLo = 0, vcdHi = 0, vat0 = 0;
  const u8 = () => dv.getUint8(p++);
  const u16 = () => { const v = dv.getUint16(p, false); p += 2; return v; };   // big-endian
  const u32 = () => { const v = dv.getUint32(p, false); p += 4; return v; };
  const f32 = () => { const v = dv.getFloat32(p, false); p += 4; return v; };

  while (p < end) {
    const op = u8();
    if (op === 0x00) { continue; }                                            // NOP
    if (op === 0x08) {                                                        // LOAD_CP_REG
      const addr = u8(), val = u32();
      if (addr === 0x50) vcdLo = val; else if (addr === 0x60) vcdHi = val; else if (addr === 0x70) vat0 = val;
      cmds.push({ t: 'cp', addr, val });
    } else if (op === 0x10) {                                                 // LOAD_XF_REG
      const hdr = u32(), count = (hdr >>> 16) + 1, xfAddr = hdr & 0xFFFF;
      const data = []; for (let i = 0; i < count; i++) data.push(f32());
      cmds.push({ t: 'xf', addr: xfAddr, count, data });
    } else if (op === 0x61) {                                                 // LOAD_BP_REG
      const v = u32(); cmds.push({ t: 'bp', reg: v >>> 24, val: v & 0xFFFFFF });
    } else if (op >= 0x20 && op <= 0x38 && (op & 7) === 0) {                  // LOAD_INDX_A..D
      const idx = u16(), info = u16(); cmds.push({ t: 'indx', op, index: idx, len: (info >> 12) + 1, xfAddr: info & 0xFFF });
    } else if (PRIM[op & 0xF8]) {                                             // DRAW (prim|vat)
      const prim = PRIM[op & 0xF8], vat = op & 7, nverts = u16();
      const lay = vertexLayout(vcdLo, vcdHi, vat0);
      const vstart = p;
      const draw = { t: 'draw', prim, vat, nverts, vbytes: lay.perVert, direct: lay.direct, vstart };
      if (lay.perVert > 0) {
        if (lay.posOff >= 0 && lay.posComps > 0) {                            // extract inline positions
          const positions = [];
          for (let v = 0; v < nverts; v++) {
            const vb = p + v * lay.perVert, pv = [];
            for (let c = 0; c < lay.posComps; c++) pv.push(readAttr(dv, vb + lay.posOff + c * lay.posElem, lay.posFmt, lay.posShift));
            positions.push(pv);
          }
          draw.positions = positions;
        }
        p += nverts * lay.perVert;                                            // consume the vertex block
      }
      draw.vend = p;
      cmds.push(draw);
    } else if (op === 0x48) {                                                 // INVL_VC (invalidate vtx cache, 1 byte)
      cmds.push({ t: 'invl' });
    } else if (op === 0x40) {                                                 // CALL_DL (addr u32 + size u32)
      const addr = u32(), size = u32(); cmds.push({ t: 'calldl', addr, size });
    } else {
      cmds.push({ t: 'UNKNOWN', op, at: p - 1 }); break;                      // stop on unrecognized op
    }
  }
  return { cmds, consumed: p, total: end, clean: p === end && !cmds.some(c => c.t === 'UNKNOWN') };
}
