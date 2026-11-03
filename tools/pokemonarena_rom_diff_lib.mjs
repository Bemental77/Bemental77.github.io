// tools/pokemonarena_rom_diff_lib.mjs -- INDEPENDENT ROM table reader for the engine-vs-ROM audit (stage FA2).
//
// This file deliberately imports NOTHING from pokemonarena/js (not tables.js, not rom.js, not charset.js): it re-derives every
// table base from the ROM's own literal-pool references, re-derives every record layout from the Thumb code that reads it
// (the "census"), and decodes the records with its own reader. The test then diffs this decode against the pack the engine uses.
// Nothing here is ROM content: only offsets, strides, bit positions and algorithms. Pure ASCII, Node only.

export const ROM_BASE = 0x08000000;

export class Rom {
  constructor(buf) {
    this.b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.len = this.b.length;
  }
  u8(o) { return this.b[o]; }
  s8(o) { return (this.b[o] << 24) >> 24; }
  u16(o) { return this.b[o] | (this.b[o + 1] << 8); }
  u32(o) { return (this.b[o] | (this.b[o + 1] << 8) | (this.b[o + 2] << 16) | (this.b[o + 3] << 24)) >>> 0; }
  isPtr(v) { return v >= ROM_BASE && v - ROM_BASE < this.len; }
  /** file offset of a ROM pointer word at `o`, or -1 when it is not a ROM pointer */
  ptr(o) { const v = this.u32(o); return this.isPtr(v) ? v - ROM_BASE : -1; }
}

// ---- Gen-3 text (own copy, ASCII subset + the glyphs the battle tables use) ---------------------------------------------
const CH = new Array(256).fill(null);
CH[0x00] = ' ';
for (let i = 0; i < 10; i++) CH[0xa1 + i] = String(i);
for (let i = 0; i < 26; i++) { CH[0xbb + i] = String.fromCharCode(65 + i); CH[0xd5 + i] = String.fromCharCode(97 + i); }
Object.assign(CH, { 0x1b: 'e\u0301', 0xab: '!', 0xac: '?', 0xad: '.', 0xae: '-', 0xb4: "'", 0xb5: '\u2642', 0xb6: '\u2640', 0xb8: ',', 0xba: '/', 0xf0: ':', 0x2d: '&', 0x2e: '+', 0x5b: '%', 0x5c: '(', 0x5d: ')', 0xfe: '\n' });
/** decode bytes at `o` up to 0xFF (max n bytes); returns null when the string is unterminated or has a byte outside the table */
export function text(rom, o, max = 64) {
  let s = '';
  for (let i = 0; i < max; i++) {
    const c = rom.u8(o + i);
    if (c === 0xff) return s;
    const g = CH[c];
    s += g === null ? `{${c.toString(16)}}` : g;
  }
  return null;
}
const nameOk = (rom, o, max) => { let allz = true; for (let i = 0; i < max; i++) if (rom.u8(o + i)) { allz = false; break; } return allz || validStr(rom, o, max); };
const validStr = (rom, o, max) => { for (let i = 0; i < max; i++) { const c = rom.u8(o + i); if (c === 0xff) return i > 0 || max > 0; if (CH[c] === null && !(c >= 0x53 && c <= 0x59) && c !== 0x1b && c !== 0x2a && c !== 0x36 && c !== 0xb0 && c !== 0xb1 && c !== 0xb2) return false; } return false; };

// ---- pointer census ------------------------------------------------------------------------------------------------------
/** count of 4-aligned literal words equal to each ROM address (only addresses with >= minRefs) */
export function pointerHistogram(rom, minRefs = 3) {
  const h = new Map();
  for (let o = 0; o + 4 <= rom.len; o += 4) {
    const v = rom.u32(o);
    if (v >= ROM_BASE && v - ROM_BASE < rom.len) h.set(v, (h.get(v) || 0) + 1);
  }
  const out = new Map();
  for (const [k, v] of h) if (v >= minRefs) out.set(k, v);
  return out;
}

/** every 4-aligned file offset holding the literal word `addr` */
export function refsTo(rom, addr) {
  const out = [];
  for (let o = 0; o + 4 <= rom.len; o += 4) if (rom.u32(o) === addr) out.push(o);
  return out;
}

// ---- layout derivation (structure predicates over high-reference candidates) ----------------------------------------------
function runLength(pass, from, to) { let n = 0; for (let i = from; i < to; i++) { if (!pass(i)) break; n++; } return n; }

const PRED = {
  // moves: 72-byte records, name ptr +0 and description ptr +4 both point at text
  moves: (rom, b) => {
    const pass = (i) => { const a = b + i * 72; const n = rom.ptr(a), d = rom.ptr(a + 4); return n >= 0 && d >= 0 && validStr(rom, n, 48) && validStr(rom, d, 400) && rom.u16(a + 8) < 2048; };
    const n = runLength(pass, 0, 1200);
    return n >= 900 ? { stride: 72, count: n } : null;
  },
  // species: 280-byte records; name is inline at +0x33 (13 bytes), level-up list pointer at +0xa8; all-zero slots are legal
  species: (rom, b) => {
    const pass = (i) => {
      const a = b + i * 280; let z = true;
      for (let k = 0; k < 280; k++) if (rom.u8(a + k)) { z = false; break; }
      if (z) return true;
      return (nameOk(rom, a + 0x33, 14)) && (rom.u32(a + 0xa8) === 0 || rom.ptr(a + 0xa8) >= 0) && rom.u8(a + 6) < 21 && rom.u8(a + 7) < 21;
    };
    const n = runLength(pass, 0, 2000);
    return n >= 1000 ? { stride: 280, count: n } : null;
  },
  // abilities: 32-byte records, name inline at +0 (<= 20 bytes), two description pointers at +0x14 and +0x18
  abilities: (rom, b) => {
    const pass = (i) => { const a = b + i * 32; return validStr(rom, a, 21) && rom.ptr(a + 0x14) >= 0 && rom.ptr(a + 0x18) >= 0; };
    const n = runLength(pass, 0, 800);
    return n >= 400 ? { stride: 32, count: n } : null;
  },
  // items: 44-byte records; description ptr +0x0c, name ptr +0x14, plural ptr +0x18
  items: (rom, b) => {
    const pass = (i) => { const a = b + i * 44; const d = rom.ptr(a + 0x0c), n = rom.ptr(a + 0x14); return d >= 0 && n >= 0 && validStr(rom, n, 24); };
    const n = runLength(pass, 0, 1400);
    return n >= 800 ? { stride: 44, count: n } : null;
  },
  // natures: 20-byte records; name ptr +0, stat-up code +4, stat-down code +5 (1..5)
  natures: (rom, b) => {
    const pass = (i) => { const a = b + i * 20; const n = rom.ptr(a); return n >= 0 && validStr(rom, n, 12) && rom.u8(a + 4) >= 1 && rom.u8(a + 4) <= 5 && rom.u8(a + 5) >= 1 && rom.u8(a + 5) <= 5; };
    const n = runLength(pass, 0, 60);
    return n >= 20 ? { stride: 20, count: n } : null;
  },
  // type names: 40-byte records, name inline at +0
  types: (rom, b) => {
    const pass = (i) => validStr(rom, b + i * 40, 10) && rom.u8(b + i * 40) !== 0 && rom.u8(b + i * 40) !== 0xff;
    const n = runLength(pass, 0, 40);
    let withPtr = 0; for (let i = 0; i < n; i++) if (rom.ptr(b + i * 40 + 36) >= 0) withPtr++;
    return n === 21 && withPtr >= 19 ? { stride: 40, count: n } : null;
  },
  // type chart: n*n u32 cells, every cell one of 0 / 0x800 / 0x1000 / 0x2000, row 0 all neutral
  typeChart: (rom, b) => {
    for (const n of [21]) {
      let ok = true;
      for (let i = 0; i < n * n && ok; i++) { const v = rom.u32(b + i * 4); if (v !== 0 && v !== 2048 && v !== 4096 && v !== 8192) ok = false; }
      for (let d = 0; d < n && ok; d++) if (rom.u32(b + d * 4) !== 4096) ok = false;
      if (ok) return { stride: n * 4, count: n };
    }
    return null;
  },
  // experience tables: 8 rows of 101 u32, row 0 starts 0,0.., every row non-decreasing and ends above 100000
  exp: (rom, b) => {
    for (let r = 0; r < 8; r++) {
      let prev = 0;
      for (let l = 0; l < 101; l++) { const v = rom.u32(b + (r * 101 + l) * 4); if (v < prev) return null; prev = v; }
      if (prev < 600000 || prev > 2000000) return null;
    }
    return { stride: 404, count: 8 };
  },
  // stat-stage ratios: 13 (num, den) u8 pairs, stage 0 first, pair 6 neutral, ratio strictly increasing
  stageRatios: (rom, b) => {
    let prev = -1;
    for (let s = 0; s < 13; s++) { const n = rom.u8(b + 2 * s), d = rom.u8(b + 2 * s + 1); if (!n || !d) return null; const r = n / d; if (r <= prev) return null; prev = r; if (s === 6 && n !== d) return null; }
    return { stride: 2, count: 13 };
  },
};

/** Derive the base file offset of every table. Candidates are pointer values with many literal-pool references; the
 *  predicate decides which candidate is the table. Returns { name: {base, refs, stride, count, rivals} }. */
export function deriveLayout(rom) {
  const hist = pointerHistogram(rom, 2);
  const need = { moves: 100, species: 50, abilities: 10, items: 10, natures: 5, types: 5, typeChart: 3, exp: 5, stageRatios: 4 };
  const out = {};
  for (const [name, pred] of Object.entries(PRED)) {
    const cands = [...hist.entries()].filter(([, n]) => n >= need[name]).sort((a, b) => b[1] - a[1]);
    const hits = [];
    for (const [addr, refs] of cands) {
      const base = addr - ROM_BASE;
      let r = null;
      try { r = pred(rom, base); } catch (_e) { r = null; }
      if (r) hits.push({ base, refs, ...r });
    }
    out[name] = hits.length ? { ...hits[0], rivals: hits.slice(1).map((h) => ({ base: h.base, refs: h.refs })) } : null;
  }
  return out;
}

// ---- record decoders (own bit layout, confirmed by census()) -----------------------------------------------------------------
export function decodeMove(rom, base, id) {
  const a = base + id * 72;
  const tcp = rom.u16(a + 0x0a), at = rom.u16(a + 0x0c), b14 = rom.u8(a + 0x14), b15 = rom.u8(a + 0x15);
  const addPtr = rom.ptr(a + 0x2c);
  const nAdd = b15 >> 5;
  const additional = [];
  if (addPtr >= 0) for (let k = 0; k < nAdd; k++) additional.push([rom.u16(addPtr + 4 * k), rom.u8(addPtr + 4 * k + 2), rom.u8(addPtr + 4 * k + 3)]);
  return {
    id, name: text(rom, rom.ptr(a), 48), effect: rom.u16(a + 8),
    type: tcp & 31, category: (tcp >> 5) & 3, power: tcp >> 7,
    accuracy: at & 127, target: (at >> 7) & 15, pp: rom.u8(a + 0x0e),
    priority: ((b14 & 15) << 28) >> 28, strikeCount: b14 >> 4,
    critStage: (b15 >> 2) & 3, alwaysCrit: (b15 >> 4) & 1, multiHit: b15 & 1, selfDestruct: (b15 >> 1) & 1, nAdditional: nAdd,
    flagsA: rom.u8(a + 0x16), flagsB: rom.u8(a + 0x17), hitFlags: rom.u8(a + 0x18),
    arg: rom.u8(a + 0x24), argWord: rom.u32(a + 0x24),
    additional,
  };
}

export function decodeSpecies(rom, base, id) {
  const a = base + id * 280;
  let z = true;
  for (let k = 0; k < 280; k++) if (rom.u8(a + k)) { z = false; break; }
  if (z) return null;
  const ev = rom.u16(a + 0x0c);
  return {
    id, name: text(rom, a + 0x33, 14),
    base: [0, 1, 2, 3, 4, 5].map((k) => rom.u8(a + k)), // hp atk def spe spa spd
    types: [rom.u8(a + 6), rom.u8(a + 7)], catchRate: rom.u8(a + 8), expYield: rom.u16(a + 0x0a),
    evYield: [0, 1, 2, 3, 4, 5].map((k) => (ev >> (2 * k)) & 3),
    genderRatio: rom.u8(a + 0x12), growth: rom.u8(a + 0x15), friendship: rom.u8(a + 0x14),
    abilities: [0, 1, 2].map((k) => rom.u16(a + 0x18 + 2 * k)), innates: [0, 1, 2].map((k) => rom.u16(a + 0x20 + 2 * k)),
    height: rom.u16(a + 0x44), weight: rom.u16(a + 0x46),
  };
}

export function decodeItem(rom, base, id) {
  const a = base + id * 44;
  return { id, name: text(rom, rom.ptr(a + 0x14), 24), price: rom.u32(a), holdEffect: rom.u8(a + 0x1c), param: rom.u8(a + 0x1d) };
}
export function decodeAbility(rom, base, id) {
  const a = base + id * 32;
  return { id, name: text(rom, a, 21), flags: rom.u8(a + 0x1d), rating: rom.s8(a + 0x1c) };
}
export function decodeNature(rom, base, id) {
  const a = base + id * 20;
  return { id, name: text(rom, rom.ptr(a), 12), up: rom.u8(a + 4), down: rom.u8(a + 5) };
}
export function decodeTypeChart(rom, base, n = 21) {
  const rows = [];
  for (let a = 0; a < n; a++) { const r = []; for (let d = 0; d < n; d++) r.push(rom.u32(base + (a * n + d) * 4)); rows.push(r); }
  return rows;
}

// ---- Thumb literal-pool census -------------------------------------------------------------------------------------------
// For every literal-pool word equal to a table base, find the `ldr rX,[pc,#imm]` that loads it, then follow the registers
// derived from rX through up to `win` instructions and histogram the field loads (op, byte offset) and the bit operation
// applied next. This is how a record layout is read off the ROM's own code instead of off the decoder.
export function census(rom, base, { win = 60 } = {}) {
  const addr = ROM_BASE + base;
  const loads = new Map(), ops = new Map();
  let sites = 0;
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (const w of refsTo(rom, addr)) {
    for (let p = Math.max(0, w - 1024); p < w; p += 2) {
      const ww = rom.u16(p);
      if ((ww >> 11) !== 9) continue;
      const lit = (((p + ROM_BASE + 4) & ~3) + ((ww & 255) << 2)) - ROM_BASE;
      if (lit !== w) continue;
      sites++;
      const taint = new Set([(ww >> 8) & 7]);
      const tag = new Map();
      let o = p + 2;
      for (let n = 0; n < win; n++, o += 2) {
        const x = rom.u16(o);
        const hi = x >> 11;
        // ldr/ldrb/ldrh rd,[rb,#imm]
        if ((x >> 13) === 3 || (x >> 12) === 8) {
          const wordLike = (x >> 13) === 3;
          const isLoad = wordLike ? ((x >> 11) & 1) === 1 : ((x >> 11) & 1) === 1;
          const rb = (x >> 3) & 7, rd = x & 7, imm5 = (x >> 6) & 31;
          if (!isLoad) continue;
          if (taint.has(rb)) {
            const op = wordLike ? (((x >> 12) & 1) ? 'ldrb' : 'ldr') : 'ldrh';
            const off = op === 'ldr' ? imm5 << 2 : op === 'ldrh' ? imm5 << 1 : imm5;
            const key = `${op}+${off}`;
            bump(loads, key); tag.set(rd, key); taint.delete(rd);
          } else { taint.delete(rd); tag.delete(rd); }
          continue;
        }
        // add rd, rs, rn  /  adds rd, rs, rn  (format 2) and hi-register add / mov
        if ((x >> 9) === 0xc) { // adds rd, rs, rn
          const rd = x & 7, rs = (x >> 3) & 7, rn = (x >> 6) & 7;
          if (taint.has(rs) || taint.has(rn)) taint.add(rd); else taint.delete(rd);
          tag.delete(rd); continue;
        }
        if ((x >> 10) === 0x11) { // hi-register ops
          const t = (x >> 8) & 3, rd = (x & 7) | ((x >> 4) & 8), rs = (x >> 3) & 15;
          if (t === 3) break; // bx
          if (rd < 8) {
            if (t === 0) { if (taint.has(rs) || taint.has(rd)) taint.add(rd); }
            else if (t === 2) { if (taint.has(rs)) taint.add(rd); else taint.delete(rd); }
            tag.delete(rd);
          }
          continue;
        }
        if ((x >> 13) === 0 && ((x >> 11) & 3) !== 3) { // lsl/lsr/asr rd, rs, #imm5
          const t = (x >> 11) & 3, imm = (x >> 6) & 31, rs = (x >> 3) & 7, rd = x & 7;
          const nm = ['lsls', 'lsrs', 'asrs'][t];
          if (tag.has(rs)) { bump(ops, `${tag.get(rs)} -> ${nm} #${t > 0 && imm === 0 ? 32 : imm}`); tag.set(rd, tag.get(rs) + '|' + nm + imm); } else tag.delete(rd);
          taint.delete(rd); continue;
        }
        if ((x >> 11) === 0x1e || hi === 0x1c || (x >> 12) === 13 || (x >> 9) === 0x5e) break; // call / branch / pop: stop following
        // anything else that writes a low register clears it (conservative)
        if ((x >> 13) === 1) { const rd = (x >> 8) & 7; if (((x >> 11) & 3) !== 1) { taint.delete(rd); tag.delete(rd); } continue; }
        if ((x >> 10) === 0x10) { const rd = x & 7; const t = (x >> 6) & 15; if (t !== 8 && t !== 10 && t !== 11) { taint.delete(rd); tag.delete(rd); } continue; }
      }
    }
  }
  return { sites, loads, ops };
}

export const bytesOf = (rom, o, n) => Array.from(rom.b.slice(o, o + n));

// ---- the per-effect metadata table (found from the code that indexes it by move.effect) -----------------------------------
/** Follow every load of the move-effect halfword (ldrh [rec,#8]) and collect the ROM addresses the code loads from literal pools
 *  within the next 30 instructions; the address most often loaded whose target is a run of 6-byte records starting with a ROM
 *  pointer (a battle-script pointer) is the effect table: { base, count, scripts[], flags[] }. */
export function effectTable(rom, movesBase) {
  const votes = new Map();
  for (const w of refsTo(rom, ROM_BASE + movesBase)) {
    for (let p = Math.max(0, w - 1024); p < w; p += 2) {
      const ww = rom.u16(p);
      if ((ww >> 11) !== 9) continue;
      const lit = (((p + ROM_BASE + 4) & ~3) + ((ww & 255) << 2)) - ROM_BASE;
      if (lit !== w) continue;
      let sawEffect = false;
      for (let o = p + 2, n = 0; n < 30; n++, o += 2) {
        const x = rom.u16(o);
        if ((x >> 11) === 0x11 && ((x >> 6) & 31) === 4) sawEffect = true; // ldrh rd,[rb,#8]
        if (sawEffect && (x >> 11) === 9) {
          const lw = (((o + ROM_BASE + 4) & ~3) + ((x & 255) << 2)) - ROM_BASE;
          const v = rom.u32(lw);
          if (v >= ROM_BASE && v - ROM_BASE < rom.len && v !== ROM_BASE + movesBase) votes.set(v, (votes.get(v) || 0) + 1);
        }
      }
    }
  }
  let best = null;
  for (const [addr, n] of [...votes.entries()].sort((a, b) => b[1] - a[1])) {
    const base = addr - ROM_BASE;
    let count = 0;
    while (base + count * 6 + 6 <= rom.len && rom.isPtr(rom.u32(base + count * 6))) count++;
    if (count >= 300) { best = { base, count, votes: n }; break; }
  }
  if (!best) return null;
  best.scripts = []; best.flags = [];
  for (let i = 0; i < best.count; i++) { best.scripts.push(rom.u32(best.base + i * 6)); best.flags.push(rom.u16(best.base + i * 6 + 4)); }
  return best;
}
