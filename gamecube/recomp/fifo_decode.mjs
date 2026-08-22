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
const idxBytes = (t) => (t === 3 ? 2 : t === 2 ? 1 : 0); // DIRECT handled separately

// Decode the per-vertex byte size from the current VCD (CP 0x50 lo, 0x60 hi). Handles the
// indexed attributes MP4 uses; DIRECT attributes would need the VAT (flagged, not sized).
function vertexSize(vcdLo, vcdHi) {
  let bytes = 0, direct = false;
  if (vcdLo & 0x1) bytes += 1;                 // PNMTXIDX (position/normal matrix index)
  for (let i = 0; i < 8; i++) if (vcdLo & (1 << (1 + i))) bytes += 1; // TEXnMTXIDX
  const pos = (vcdLo >> 9) & 3, nrm = (vcdLo >> 11) & 3, c0 = (vcdLo >> 13) & 3, c1 = (vcdLo >> 15) & 3;
  for (const t of [pos, nrm, c0, c1]) { if (t === 1) direct = true; else bytes += idxBytes(t); }
  for (let i = 0; i < 8; i++) { const t = (vcdHi >> (2 * i)) & 3; if (t === 1) direct = true; else bytes += idxBytes(t); }
  return { bytes, direct };
}

export function decodeFifo(buf, len, fmt) {
  const dv = buf instanceof DataView ? buf : new DataView(buf.buffer || buf, buf.byteOffset || 0, len);
  const end = len ?? dv.byteLength;
  let p = 0;
  const cmds = [];
  let vcdLo = 0, vcdHi = 0;
  const u8 = () => dv.getUint8(p++);
  const u16 = () => { const v = dv.getUint16(p, false); p += 2; return v; };   // big-endian
  const u32 = () => { const v = dv.getUint32(p, false); p += 4; return v; };
  const f32 = () => { const v = dv.getFloat32(p, false); p += 4; return v; };

  while (p < end) {
    const op = u8();
    if (op === 0x00) { continue; }                                            // NOP
    if (op === 0x08) {                                                        // LOAD_CP_REG
      const addr = u8(), val = u32();
      if (addr === 0x50) vcdLo = val; else if (addr === 0x60) vcdHi = val;
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
      const { bytes, direct } = vertexSize(vcdLo, vcdHi);
      const vstart = p;
      const draw = { t: 'draw', prim, vat, nverts, vbytes: bytes, direct, vstart };
      // DIRECT decode when a fixed layout is supplied (positions [+ colors] inline).
      // fmt = { posDirect:true, posComps, clrDirect:bool } — pos = posComps x f32, clr = rgba8.
      if (direct && fmt && fmt.posDirect) {
        const positions = [], colors = [];
        const stride = fmt.posComps * 4 + (fmt.clrDirect ? 4 : 0);
        for (let v = 0; v < nverts; v++) {
          const pv = []; for (let c = 0; c < fmt.posComps; c++) pv.push(f32()); positions.push(pv);
          if (fmt.clrDirect) { colors.push([u8(), u8(), u8(), u8()]); }
        }
        draw.positions = positions; draw.colors = colors; draw.vbytes = stride;
      } else if (!direct && bytes > 0) {
        p += nverts * bytes;                                                  // skip indexed vertex block
      }
      draw.vend = p;
      cmds.push(draw);
    } else {
      cmds.push({ t: 'UNKNOWN', op, at: p - 1 }); break;                      // stop on unrecognized op
    }
  }
  return { cmds, consumed: p, total: end, clean: p === end && !cmds.some(c => c.t === 'UNKNOWN') };
}
