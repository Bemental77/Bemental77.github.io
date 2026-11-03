// pokemonarena/js/anim_ram.js -- the memory map the ROM's own animation code runs against (a JS model of the GBA bus).
//
// Pure ES module (browser + Node): Uint8Array / DataView only. Nothing ROM-derived is stored here; the ROM image is handed in
// by the caller. This is the "minimal RAM" of the move-animation engine (see ANIM.md): the code under test is the ROM's own
// THUMB battle-animation code, executed by anim_cpu.js, and it needs somewhere to read and write:
//
//   0x02000000  EWRAM  256 KiB   (lazily zero: every byte starts 0; the animator seeds the few engine variables the code needs)
//   0x03000000  IWRAM   32 KiB
//   0x04000000  I/O registers (0x400 bytes); a write to a DMA control register with the enable bit performs the transfer
//   0x05000000  palette RAM 1 KiB (BG 0x000..0x1FF, OBJ 0x200..0x3FF)
//   0x06000000  VRAM 96 KiB (BG tile/map area first, OBJ tiles from 0x10000 in BG modes 0..2)
//   0x07000000  OAM 1 KiB
//   0x08000000  the cartridge (read only; mirrors at 0x0A.. and 0x0C..)
//
// Every access to an address nothing is mapped at is counted (and optionally logged), never silently dropped: that log is how
// the harness discovers which engine variables a callback needs and is what the coverage table reports.

export const EWRAM_BASE = 0x02000000, EWRAM_SIZE = 0x40000;
export const IWRAM_BASE = 0x03000000, IWRAM_SIZE = 0x8000;
export const IO_BASE = 0x04000000, IO_SIZE = 0x400;
export const PRAM_BASE = 0x05000000, PRAM_SIZE = 0x400;
export const VRAM_BASE = 0x06000000, VRAM_SIZE = 0x18000;
export const OAM_BASE = 0x07000000, OAM_SIZE = 0x400;
export const ROM_BASE = 0x08000000;

// I/O register offsets used by the model (GBATEK names).
export const IO = Object.freeze({
  DISPCNT: 0x00, DISPSTAT: 0x04, VCOUNT: 0x06,
  BG0CNT: 0x08, BG1CNT: 0x0a, BG2CNT: 0x0c, BG3CNT: 0x0e,
  BG0HOFS: 0x10, BG0VOFS: 0x12, BG1HOFS: 0x14, BG1VOFS: 0x16, BG2HOFS: 0x18, BG2VOFS: 0x1a, BG3HOFS: 0x1c, BG3VOFS: 0x1e,
  BG2PA: 0x20, BG2PB: 0x22, BG2PC: 0x24, BG2PD: 0x26, BG2X: 0x28, BG2Y: 0x2c,
  BG3PA: 0x30, BG3PB: 0x32, BG3PC: 0x34, BG3PD: 0x36, BG3X: 0x38, BG3Y: 0x3c,
  WIN0H: 0x40, WIN1H: 0x42, WIN0V: 0x44, WIN1V: 0x46, WININ: 0x48, WINOUT: 0x4a,
  MOSAIC: 0x4c, BLDCNT: 0x50, BLDALPHA: 0x52, BLDY: 0x54,
  DMA0: 0xb0, DMA1: 0xbc, DMA2: 0xc8, DMA3: 0xd4,
  IME: 0x208,
});

export class MemFault extends Error {
  constructor(msg, addr) { super(msg); this.name = 'MemFault'; this.addr = addr >>> 0; }
}

export class GbaMem {
  /** @param {Uint8Array} rom  the cartridge image */
  constructor(rom, opts = {}) {
    this.rom = rom;
    this.romDv = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
    this.romMask = 0x01ffffff;
    this.ewram = new Uint8Array(EWRAM_SIZE); this.ewDv = new DataView(this.ewram.buffer);
    this.iwram = new Uint8Array(IWRAM_SIZE); this.iwDv = new DataView(this.iwram.buffer);
    this.io = new Uint8Array(IO_SIZE); this.ioDv = new DataView(this.io.buffer);
    this.pram = new Uint8Array(PRAM_SIZE); this.prDv = new DataView(this.pram.buffer);
    this.vram = new Uint8Array(VRAM_SIZE); this.vrDv = new DataView(this.vram.buffer);
    this.oam = new Uint8Array(OAM_SIZE); this.oamDv = new DataView(this.oam.buffer);
    this.unmapped = new Map();       // "r32:0x00000000" -> count, for every access to nothing
    this.logUnmapped = opts.logUnmapped !== false;
    this.strict = !!opts.strict;     // throw MemFault instead of counting
    this.watch = null;               // optional (addr, size, isWrite, value) tap for the discovery tools
    this.dmaLog = [];
    this.hblankDma = null;           // an armed HBlank DMA (scanline effect), see arm/disarm below
    this.bgMode = null;
    this.openBus = null;             // optional (kind, address) -> value for a READ of unmapped memory: the real chip returns the bus's last value (the prefetched instruction), see move_anim.js
    this.pcProbe = null; this.lrProbe = null;   // set by the harness: current / link register, recorded with the first unmapped access
    this.ioTap = null;               // optional (offset, value) tap on every register write (discovery / tests)
  }

  /* ----------------------------------------------------------------------------------------------- faults */
  _miss(kind, a, v) {
    if (this.strict) throw new MemFault(`${kind} at unmapped 0x${(a >>> 0).toString(16)}`, a);
    if (this.logUnmapped) {
      const k = kind + ':0x' + (a >>> 0).toString(16);
      const e = this.unmapped.get(k);
      if (e) e.n++;
      else this.unmapped.set(k, { n: 1, pc: this.pcProbe ? this.pcProbe() : 0, lr: this.lrProbe ? this.lrProbe() : 0 });   // first offender: where it happened
    }
    if (kind[0] === 'r' && this.openBus) return this.openBus(kind, a);
    return 0;
  }

  /* ----------------------------------------------------------------------------------------------- reads */
  read8(a) {
    a >>>= 0;
    switch (a >>> 24) {
      case 2: return this.ewram[a & 0x3ffff];
      case 3: return this.iwram[a & 0x7fff];
      case 4: return a - IO_BASE < IO_SIZE ? this.io[a - IO_BASE] : this._miss('r8', a);
      case 5: return this.pram[a & 0x3ff];
      case 6: return this.vram[this._vi(a)];
      case 7: return this.oam[a & 0x3ff];
      case 8: case 9: case 10: case 11: case 12: case 13: {
        const o = a & this.romMask; return o < this.rom.length ? this.rom[o] : 0;
      }
      default: return this._miss('r8', a);
    }
  }
  read16(a) {
    a >>>= 0;
    const al = a & ~1;
    switch (a >>> 24) {
      case 2: return this.ewDv.getUint16(al & 0x3ffff, true);
      case 3: return this.iwDv.getUint16(al & 0x7fff, true);
      case 4: return al - IO_BASE < IO_SIZE ? this.ioDv.getUint16(al - IO_BASE, true) : this._miss('r16', a);
      case 5: return this.prDv.getUint16(al & 0x3ff, true);
      case 6: return this.vrDv.getUint16(this._vi(al), true);
      case 7: return this.oamDv.getUint16(al & 0x3ff, true);
      case 8: case 9: case 10: case 11: case 12: case 13: {
        const o = al & this.romMask; return o + 2 <= this.rom.length ? this.romDv.getUint16(o, true) : 0;
      }
      default: return this._miss('r16', a);
    }
  }
  read32(a) {
    a >>>= 0;
    const al = a & ~3;
    switch (a >>> 24) {
      case 2: return this.ewDv.getUint32(al & 0x3ffff, true);
      case 3: return this.iwDv.getUint32(al & 0x7fff, true);
      case 4: return al - IO_BASE < IO_SIZE ? this.ioDv.getUint32(al - IO_BASE, true) : this._miss('r32', a);
      case 5: return this.prDv.getUint32(al & 0x3ff, true);
      case 6: return this.vrDv.getUint32(this._vi(al), true);
      case 7: return this.oamDv.getUint32(al & 0x3ff, true);
      case 8: case 9: case 10: case 11: case 12: case 13: {
        const o = al & this.romMask; return o + 4 <= this.rom.length ? this.romDv.getUint32(o, true) : 0;
      }
      default: return this._miss('r32', a);
    }
  }
  // VRAM mirrors every 128 KiB; the upper 32 KiB of each mirror repeats the OBJ block (0x10000..0x17FFF).
  _vi(a) { const o = a & 0x1ffff; return o >= 0x18000 ? o - 0x8000 : o; }

  /* ---------------------------------------------------------------------------------------------- writes */
  write8(a, v) {
    a >>>= 0; v &= 255;
    switch (a >>> 24) {
      case 2: this.ewram[a & 0x3ffff] = v; return;
      case 3: this.iwram[a & 0x7fff] = v; return;
      case 4: if (a - IO_BASE < IO_SIZE) this._ioWrite8(a - IO_BASE, v); else this._miss('w8', a); return;
      case 5: { const o = a & 0x3fe; this.pram[o] = v; this.pram[o + 1] = v; return; }   // 8-bit writes replicate
      case 6: { const o = this._vi(a); if (o < 0x10000) { const e = o & ~1; this.vram[e] = v; this.vram[e + 1] = v; } return; } // OBJ area ignores them
      case 7: return;                                                                    // OAM ignores 8-bit writes
      default: this._miss('w8', a); // ROM writes land here too
    }
  }
  write16(a, v) {
    a >>>= 0; v &= 0xffff;
    const al = a & ~1;
    switch (a >>> 24) {
      case 2: this.ewDv.setUint16(al & 0x3ffff, v, true); return;
      case 3: this.iwDv.setUint16(al & 0x7fff, v, true); return;
      case 4: if (al - IO_BASE < IO_SIZE) this._ioWrite16(al - IO_BASE, v); else this._miss('w16', a); return;
      case 5: this.prDv.setUint16(al & 0x3ff, v, true); return;
      case 6: this.vrDv.setUint16(this._vi(al), v, true); return;
      case 7: this.oamDv.setUint16(al & 0x3ff, v, true); return;
      default: this._miss('w16', a);
    }
  }
  write32(a, v) {
    a >>>= 0; v >>>= 0;
    const al = a & ~3;
    switch (a >>> 24) {
      case 2: this.ewDv.setUint32(al & 0x3ffff, v, true); return;
      case 3: this.iwDv.setUint32(al & 0x7fff, v, true); return;
      case 4:
        if (al - IO_BASE < IO_SIZE) { this._ioWrite16(al - IO_BASE, v & 0xffff, true); this._ioWrite16(al - IO_BASE + 2, v >>> 16); } else this._miss('w32', a);
        return;
      case 5: this.prDv.setUint32(al & 0x3ff, v, true); return;
      case 6: this.vrDv.setUint32(this._vi(al), v, true); return;
      case 7: this.oamDv.setUint32(al & 0x3ff, v, true); return;
      default: this._miss('w32', a);
    }
  }

  /* ---------------------------------------------------------------------------------------------- I/O */
  _ioWrite8(off, v) {
    // 8-bit writes to registers: merge into the halfword and take the 16-bit path (so DMA control still fires)
    const o = off & ~1;
    const cur = this.ioDv.getUint16(o, true);
    const nv = (off & 1) ? (cur & 0x00ff) | (v << 8) : (cur & 0xff00) | v;
    this._ioWrite16(o, nv);
  }
  _ioWrite16(off, v, firstOfWord = false) {
    // read-only / special registers
    if (off === IO.VCOUNT || off === IO.DISPSTAT + 2) return;
    if (this.ioTap) this.ioTap(off, v);
    this.ioDv.setUint16(off, v, true);
    // DMA control (CNT_H) of channel n sits at 0xB0 + 12n + 10
    if (off >= 0xb0 && off < 0xe0 && ((off - 0xb0) % 12) === 10) {
      const ch = ((off - 0xb0) / 12) | 0;
      this._dmaControl(ch, v);
    }
  }
  /** Programs a register from JS (no side effects). */
  setIo16(off, v) { this.ioDv.setUint16(off, v & 0xffff, true); }
  getIo16(off) { return this.ioDv.getUint16(off, true); }

  /* ---------------------------------------------------------------------------------------------- DMA */
  _dmaControl(ch, ctl) {
    const base = 0xb0 + 12 * ch;
    if (!(ctl & 0x8000)) { if (this.hblankDma && this.hblankDma.ch === ch) this.hblankDma = null; return; }
    const sad = this.ioDv.getUint32(base, true) & (ch === 0 ? 0x07ffffff : 0x0fffffff);
    const dad = this.ioDv.getUint32(base + 4, true) & (ch === 3 ? 0x0fffffff : 0x07ffffff);
    let cnt = this.ioDv.getUint16(base + 8, true);
    if (cnt === 0) cnt = ch === 3 ? 0x10000 : 0x4000;
    const timing = (ctl >> 12) & 3;
    const rec = { ch, sad, dad, cnt, ctl, timing };
    if (timing === 0) { this.dmaLog.push(rec); this._dmaRun(rec); this.ioDv.setUint16(base + 10, ctl & ~0x8000 & 0xffff, true); return; }
    if (timing === 2) { this.hblankDma = rec; return; }       // scanline effect: the PPU replays it per line
    this.dmaLog.push(Object.assign({ deferred: true }, rec));   // VBlank / special timing: counted, not run
  }
  _dmaRun(d) {
    const word = (d.ctl & 0x0400) !== 0;
    const step = word ? 4 : 2;
    const dstCtl = (d.ctl >> 5) & 3, srcCtl = (d.ctl >> 7) & 3;
    let s = d.sad, t = d.dad;
    const sInc = srcCtl === 0 ? step : srcCtl === 1 ? -step : srcCtl === 2 ? 0 : step;
    const tInc = dstCtl === 0 || dstCtl === 3 ? step : dstCtl === 1 ? -step : 0;
    for (let i = 0; i < d.cnt; i++) {
      if (word) this.write32(t, this.read32(s)); else this.write16(t, this.read16(s));
      s += sInc; t += tInc;
    }
  }

  /* ------------------------------------------------------------------------------------- JS-side helpers */
  /** Copy bytes into the memory map (used by the harness for seeding, not by the ROM code). */
  poke(addr, bytes) { for (let i = 0; i < bytes.length; i++) this.write8(addr + i, bytes[i]); }
  /** Raw EWRAM access for the harness (addr is a bus address). */
  ewU8(a) { return this.ewram[a & 0x3ffff]; }
  ewU16(a) { return this.ewDv.getUint16(a & 0x3ffff, true); }
  ewS16(a) { return this.ewDv.getInt16(a & 0x3ffff, true); }
  ewU32(a) { return this.ewDv.getUint32(a & 0x3ffff, true); }
  setEwU8(a, v) { this.ewram[a & 0x3ffff] = v; }
  setEwU16(a, v) { this.ewDv.setUint16(a & 0x3ffff, v & 0xffff, true); }
  setEwU32(a, v) { this.ewDv.setUint32(a & 0x3ffff, v >>> 0, true); }
  unmappedReport() { return [...this.unmapped.entries()].sort((a, b) => b[1].n - a[1].n); }
}
