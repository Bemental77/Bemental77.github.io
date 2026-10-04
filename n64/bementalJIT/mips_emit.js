// bementalJIT — N64/MIPS guest emitter (per-console fork; see
// n64/docs/jit/README.md and the de-sharing rule: GC owns
// gamecube/bementalJIT, DC owns the root copy, N64 owns this one).
//
// v3 shape ("native ALU/branches/loads + block-local register cache"):
// each compiled block is one wasm function covering a recompile_block span,
// structured as (block $exit (loop $top ...)).
//
// REGISTER CACHE (the gamecube reg_cache.cpp role): guest GPRs live in wasm
// locals across the block — loaded from int64_t reg[32] lazily on first
// read, written to locals only (no memory store per op). The dirty set is
// FLUSHED to linear memory before anything that can observe or mutate guest
// state: every fallback call_indirect, every gen_interrupt call, every
// block exit, and the loop back-edge (so the $top compile-time state is
// empty on every path). After a fallback or gen_interrupt the entire cache
// is INVALIDATED — the interpreter op may have written any register.
// r0 is cached like any other register, and the differential gate compares
// reg[0] too — but WHETHER the core writes reg[0] is PER-OPCODE, not a rule.
// recomp.c rewrites most instructions whose destination is r0 into a plain
// NOP (`if (dst->f.i.rt == reg) RNOP()`), so they write nothing at all; the
// ones it does NOT guard (MTHI/MTLO/MULT/DIV, MTC1/DMTC1, stores) still run
// and do write reg[0]. See the SPECIAL_RD_NOP / ITYPE_RT_NOP block below —
// an earlier version of this comment claimed a blanket "the interpreter
// WRITES reg[0]", and that wrong belief WAS the superMarioStarRoad.z64
// divergence.
//
// Per instruction:
//   (a) native ALU — exact MIPS-III semantics on cached regs;
//   (b) native BRANCH — mirrors cached_interp.c DECLARE_JUMP exactly:
//       PLAIN variant only (recomp.c's OUT/IDLE conditions fall back),
//       delay slot must itself be native (cannot fault → no EPC/BD
//       exposure), condition evaluated BEFORE the slot, link written
//       unconditionally, Count += ((addr+8)-last_addr)>>2*count_per_op,
//       last_addr = final PC, skip_jump guard, next_interrupt<=Count poll
//       with PC stored before gen_interrupt and re-checked after;
//   (c) native LOAD — LW/LWU/LB/LBU/LH/LHU through the LIVE dispatch
//       table (readmem*[a>>16] compared against read_rdram* at runtime, so
//       framebuffer-protection remapping and TLB/MMIO route to fallback);
//       RDRAM hits read the host-endian u32 dram array with BE sub-word
//       shifts and SE8/SE16/SE32 exactly like readb/readh/readw;
//   (d) fallback — flush cache, store exact precomp_instr* into PC,
//       call_indirect the ORIGINAL interpreter op, invalidate cache, exit
//       the block on PC divergence.
// The differential harness (tools/n64_jit_diff_test.mjs) gates every wave.
(function () {
  'use strict';

  // ---- wasm binary helpers ----
  function leb(n) { var o = []; n >>>= 0; do { var b = n & 0x7f; n >>>= 7; o.push(n ? b | 0x80 : b); } while (n); return o; }
  function sleb(n) { var o = [], more = true; n |= 0; while (more) { var b = n & 0x7f; n >>= 7; if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) more = false; else b |= 0x80; o.push(b); } return o; }
  function section(id, content) { return [id].concat(leb(content.length), content); }
  // A module's bytes written straight into one Uint8Array: `parts` is a list of byte arrays
  // (plain arrays or Uint8Arrays) and of { id, chunks } sections whose content is the chunks
  // in order. The bytes are exactly those of the concat-based assembly it replaces (header,
  // then each section as [id, leb(len), content]); it only skips building them as JS arrays
  // first — for a 32-span batch module that was ~200 KB of number arrays concatenated and
  // copied twice, a quarter of the compile worker's time (FAST EMIT, emitBatch).
  // (a plain loop: TypedArray.set from a JS array converts element by element, slower here)
  function packCopy(out, o, c) { for (var j = 0, n = c.length; j < n; j++) out[o + j] = c[j]; return o + n; }
  // FNV-1a over a Uint32Array's first n words (the recompile key's bucket hash). Out of
  // compileSpan, which is too large to be optimized, so the loop runs as optimized code.
  function keyHash(a, n) { var h = 0x811c9dc5 | 0; for (var i = 0; i < n; i++) h = Math.imul(h ^ a[i], 16777619); return h; }
  // THE OFFER PATH OUT OF compileSpan (2026-10-04). Before a span is offered to the compile worker,
  // compileSpan scans its ops (null ops, JIT slots), builds the recompile key (the whole 4 KB page's
  // words + the span's ops) and compares it against the cache bucket — on the CORE's thread, ~150
  // times in one MK64 scene-change field (fields 1206/1242/1244: compileSpan's own frames, keyHash,
  // asyncOffer were most of a 30-60 ms field in a CPU profile). compileSpan is too large to be
  // optimized, so those per-word loops ran unoptimized. They are these small functions now, with the
  // same reads in the same order and the same results; the page's words, contiguous in the heap, are
  // one typed-array copy where HEAPU32 is the heap itself (in the compile worker it is a Proxy over
  // the copied inputs, read word by word as before).
  function opsZeroAt(U, base, stride, n) { for (var g = 0; g < n; g++) if (U[(base + g * stride) >> 2] === 0) return g; return -1; }
  function opsAnyAtOrAbove(U, base, stride, n, tb) { for (var g = 0; g < n; g++) if (U[(base + g * stride) >> 2] >= tb) return true; return false; }
  function keyFillWords(k, off, U, w0, n) {
    if (U instanceof Uint32Array) { k.set(U.subarray(w0, w0 + n), off); return; }
    for (var q = 0; q < n; q++) k[off + q] = U[w0 + q];
  }
  function keyFillOps(k, off, U, base, stride, n) { for (var q = 0; q < n; q++) k[off + q] = U[(base + q * stride) >> 2]; }
  function keyEq(a, b, n) { if (a.length !== n) return false; for (var q = 0; q < n; q++) if (a[q] !== b[q]) return false; return true; }
  function packModule(parts) {
    var total = 0, i, k, c, n;
    for (i = 0; i < parts.length; i++) {
      var pt = parts[i];
      if (pt.chunks) {
        for (n = 0, k = 0; k < pt.chunks.length; k++) n += pt.chunks[k].length;
        pt.len = n; pt.head = [pt.id].concat(leb(n));
        total += pt.head.length + n;
      } else total += pt.length;
    }
    var out = new Uint8Array(total), o = 0;
    for (i = 0; i < parts.length; i++) {
      var q = parts[i];
      if (q.chunks) {
        out.set(q.head, o); o += q.head.length;
        for (k = 0; k < q.chunks.length; k++) { c = q.chunks[k]; o = packCopy(out, o, c); }
      } else o = packCopy(out, o, q);
    }
    return out;
  }

  var OP = {
    block: 0x02, loop: 0x03, if_: 0x04, else_: 0x05, end: 0x0B,
    br: 0x0C, br_if: 0x0D, call: 0x10, call_indirect: 0x11, return_call_indirect: 0x13,
    local_get: 0x20, local_set: 0x21,
    i32_load: 0x28, i64_load: 0x29, i32_load8_u: 0x2D, i32_store: 0x36, i64_store: 0x37, i32_store8: 0x3A,
    i32_const: 0x41, i64_const: 0x42,
    i32_eqz: 0x45, i32_eq: 0x46, i32_ne: 0x47, i32_le_u: 0x4D, i32_ge_u: 0x4F,
    i64_eq: 0x51, i64_ne: 0x52, i64_lt_s: 0x53, i64_lt_u: 0x54, i64_gt_s: 0x55, i64_le_s: 0x57, i64_ge_s: 0x59,
    i32_add: 0x6A, i32_sub: 0x6B, i32_mul: 0x6C, i32_and: 0x71, i32_or: 0x72, i32_xor: 0x73, i32_shl: 0x74, i32_shr_s: 0x75, i32_shr_u: 0x76,
    i32_extend8_s: 0xC0, i32_extend16_s: 0xC1,
    i64_add: 0x7C, i64_sub: 0x7D, i64_mul: 0x7E, i64_shr_s: 0x87, i64_and: 0x83, i64_or: 0x84, i64_xor: 0x85,
    i32_div_s: 0x6D, i32_div_u: 0x6E, i32_rem_s: 0x6F, i32_rem_u: 0x70,
    i32_wrap_i64: 0xA7, i64_extend_i32_s: 0xAC, i64_extend_i32_u: 0xAD,
    i64_shl: 0x86, i64_shr_u: 0x88,
    f32_load: 0x2A, f32_store: 0x38, f64_load: 0x2B, f64_store: 0x39,
    f32_abs: 0x8B, f32_neg: 0x8C, f32_sqrt: 0x91, f32_add: 0x92, f32_sub: 0x93, f32_mul: 0x94, f32_div: 0x95,
    f64_abs: 0x99, f64_neg: 0x9A, f64_sqrt: 0x9F, f64_add: 0xA0, f64_sub: 0xA1, f64_mul: 0xA2, f64_div: 0xA3,
    // wave 11a (FP converts)
    local_tee: 0x22, f32_const: 0x43, f64_const: 0x44,
    f32_lt: 0x5D, f64_lt: 0x63,
    // wave 11b (FP compares): the rest of the float relational set
    f32_eq: 0x5B, f32_ne: 0x5C, f32_gt: 0x5E, f32_le: 0x5F, f32_ge: 0x60,
    f64_eq: 0x61, f64_ne: 0x62, f64_gt: 0x64, f64_le: 0x65, f64_ge: 0x66,
    f32_ceil: 0x8D, f32_floor: 0x8E, f32_trunc: 0x8F,
    f64_ceil: 0x9B, f64_floor: 0x9C, f64_trunc: 0x9D,
    i32_trunc_f32_s: 0xA8, i32_trunc_f64_s: 0xAA, i64_trunc_f32_s: 0xAE, i64_trunc_f64_s: 0xB0,
    f32_convert_i32_s: 0xB2, f32_convert_i64_s: 0xB4, f32_demote_f64: 0xB6,
    f64_convert_i32_s: 0xB7, f64_convert_i64_s: 0xB9, f64_promote_f32: 0xBB,
    void_: 0x40,
    // multi-entry spans (2026-09-30): intra-span dispatch + entry wrappers
    br_table: 0x0E, return_: 0x0F, global_get: 0x23, global_set: 0x24,
  };
  var VT = { i32: 0x7F, i64: 0x7E, f32: 0x7D, f64: 0x7C };

  // locals: 0,1 = i32 scratch (addr, word); 2..33 = i64 guest r0..r31
  var L_ADDR = 0, L_WORD = 1, L_REG0 = 2, L_I64S = 34, L_JT = 35, L_COND = 36; // i64 scratch (mult), i32 jump target, i32 branch condition
  var L_F32 = 37, L_F64 = 38;   // wave 11a: rounded-value scratch for the convert guard
  // wave 11b: FP compares need BOTH operands in locals (the unordered
  // predicates read each operand twice, for `x != x`). Appended as NEW local
  // groups rather than widening the wave-11a pair, so L_F32/L_F64 keep their
  // indices and roundToIntNat is untouched.
  var L_F32B = 39, L_F64B = 40;
  // multi-entry spans (2026-09-30): the segment index the body dispatches to
  // on entry and on every backward in-span branch (br_table at $top). A NEW
  // local appended after every existing group, so no index above moves.
  var L_START = 41;
  // COLD PATHS (2026-10-03): the index of the out-of-line handler a cold arm jumps to
  // (see COLD PATHS in compileSpan). A new local after every existing group.
  var L_COLD = 42;
  // LEAN CODE (2026-10-03): the Count value a branch tail just stored (emitCountBatch tees it), read
  // back by that tail's interrupt poll instead of a reload. Locals 42 and 43 are always declared now.
  var L_CNT = 43;
  // RAW (2026-10-01): 1 while compiling a block that has pinned registers.
  // Its body is then wrapped as (block $raw (block $exit ...) epilogue), and
  // every exit that follows an interpreter/core call — where reg[] is already
  // authoritative and a pinned local may be STALE (the op may have written
  // reg[]) — branches one level further, to $raw, skipping the epilogue.
  // 0 otherwise: the emitted bytes are then exactly the pre-pinning shape.
  var RAW = 0;

  function loadI64(addr) { return [OP.i32_const, 0x00, OP.i64_load, 0x03].concat(leb(addr)); }
  function loadI32(addr) { return [OP.i32_const, 0x00, OP.i32_load, 0x02].concat(leb(addr)); }
  function storeI64(addr, valueBytes) { return [OP.i32_const, 0x00].concat(valueBytes, [OP.i64_store, 0x03], leb(addr)); }
  function storeI32(addr, valueBytes) { return [OP.i32_const, 0x00].concat(valueBytes, [OP.i32_store, 0x02], leb(addr)); }
  function storeI32Const(addr, value) { return storeI32(addr, [OP.i32_const].concat(sleb(value))); }

  function sext16(v) { return (v << 16) >> 16; }

  // SLEB128 over a full 64-bit value. The existing sleb() coerces with `n |= 0`
  // and so cannot encode i64.const INT64_MIN, which the .L convert guard needs.
  function sleb64(v) {
    var o = [], more = true;
    while (more) {
      var b = Number(v & 0x7Fn);
      v >>= 7n;
      if ((v === 0n && !(b & 0x40)) || (v === -1n && (b & 0x40))) more = false; else b |= 0x80;
      o.push(b);
    }
    return o;
  }
  // IEEE-754 little-endian immediate bytes for f32.const / f64.const
  function f32Bytes(v) { var b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); return Array.prototype.slice.call(b); }
  function f64Bytes(v) { var b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); return Array.prototype.slice.call(b); }

  // ---- MIPS mnemonic decode (census labelling only; not used for codegen) ----
  var M_OP = {
    0x02: 'J', 0x03: 'JAL', 0x04: 'BEQ', 0x05: 'BNE', 0x06: 'BLEZ', 0x07: 'BGTZ',
    0x08: 'ADDI', 0x09: 'ADDIU', 0x0A: 'SLTI', 0x0B: 'SLTIU', 0x0C: 'ANDI', 0x0D: 'ORI', 0x0E: 'XORI', 0x0F: 'LUI',
    0x12: 'COP2', 0x13: 'COP3',
    0x14: 'BEQL', 0x15: 'BNEL', 0x16: 'BLEZL', 0x17: 'BGTZL',
    0x18: 'DADDI', 0x19: 'DADDIU', 0x1A: 'LDL', 0x1B: 'LDR',
    0x20: 'LB', 0x21: 'LH', 0x22: 'LWL', 0x23: 'LW', 0x24: 'LBU', 0x25: 'LHU', 0x26: 'LWR', 0x27: 'LWU',
    0x28: 'SB', 0x29: 'SH', 0x2A: 'SWL', 0x2B: 'SW', 0x2C: 'SDL', 0x2D: 'SDR', 0x2E: 'SWR', 0x2F: 'CACHE',
    0x30: 'LL', 0x31: 'LWC1', 0x34: 'LLD', 0x35: 'LDC1', 0x37: 'LD',
    0x38: 'SC', 0x39: 'SWC1', 0x3C: 'SCD', 0x3D: 'SDC1', 0x3F: 'SD',
  };
  var M_SPECIAL = {
    0x00: 'SLL', 0x02: 'SRL', 0x03: 'SRA', 0x04: 'SLLV', 0x06: 'SRLV', 0x07: 'SRAV',
    0x08: 'JR', 0x09: 'JALR', 0x0C: 'SYSCALL', 0x0D: 'BREAK', 0x0F: 'SYNC',
    0x10: 'MFHI', 0x11: 'MTHI', 0x12: 'MFLO', 0x13: 'MTLO', 0x14: 'DSLLV', 0x16: 'DSRLV', 0x17: 'DSRAV',
    0x18: 'MULT', 0x19: 'MULTU', 0x1A: 'DIV', 0x1B: 'DIVU', 0x1C: 'DMULT', 0x1D: 'DMULTU', 0x1E: 'DDIV', 0x1F: 'DDIVU',
    0x20: 'ADD', 0x21: 'ADDU', 0x22: 'SUB', 0x23: 'SUBU', 0x24: 'AND', 0x25: 'OR', 0x26: 'XOR', 0x27: 'NOR',
    0x2A: 'SLT', 0x2B: 'SLTU', 0x2C: 'DADD', 0x2D: 'DADDU', 0x2E: 'DSUB', 0x2F: 'DSUBU',
    0x30: 'TGE', 0x31: 'TGEU', 0x32: 'TLT', 0x33: 'TLTU', 0x34: 'TEQ', 0x36: 'TNE',
    0x38: 'DSLL', 0x3A: 'DSRL', 0x3B: 'DSRA', 0x3C: 'DSLL32', 0x3E: 'DSRL32', 0x3F: 'DSRA32',
  };
  var M_REGIMM = {
    0x00: 'BLTZ', 0x01: 'BGEZ', 0x02: 'BLTZL', 0x03: 'BGEZL', 0x08: 'TGEI', 0x09: 'TGEIU',
    0x0A: 'TLTI', 0x0B: 'TLTIU', 0x0C: 'TEQI', 0x0E: 'TNEI',
    0x10: 'BLTZAL', 0x11: 'BGEZAL', 0x12: 'BLTZALL', 0x13: 'BGEZALL',
  };
  var M_CP0 = { 0x00: 'MFC0', 0x01: 'DMFC0', 0x04: 'MTC0', 0x05: 'DMTC0' };
  var M_TLB = { 0x01: 'TLBR', 0x02: 'TLBWI', 0x06: 'TLBWR', 0x08: 'TLBP', 0x18: 'ERET' };
  var M_CP1_SUB = { 0x00: 'MFC1', 0x01: 'DMFC1', 0x02: 'CFC1', 0x04: 'MTC1', 0x05: 'DMTC1', 0x06: 'CTC1' };
  var M_FMT = { 0x10: 'S', 0x11: 'D', 0x14: 'W', 0x15: 'L' };
  var M_CP1_FN = {
    0x00: 'ADD', 0x01: 'SUB', 0x02: 'MUL', 0x03: 'DIV', 0x04: 'SQRT', 0x05: 'ABS', 0x06: 'MOV', 0x07: 'NEG',
    0x08: 'ROUND.L', 0x09: 'TRUNC.L', 0x0A: 'CEIL.L', 0x0B: 'FLOOR.L',
    0x0C: 'ROUND.W', 0x0D: 'TRUNC.W', 0x0E: 'CEIL.W', 0x0F: 'FLOOR.W',
    0x20: 'CVT.S', 0x21: 'CVT.D', 0x24: 'CVT.W', 0x25: 'CVT.L',
  };
  var M_CP1_COND = ['F', 'UN', 'EQ', 'UEQ', 'OLT', 'ULT', 'OLE', 'ULE',
                    'SF', 'NGLE', 'SEQ', 'NGL', 'LT', 'NGE', 'LE', 'NGT'];
  function mnem(word) {
    if (word === 0) return 'NOP';
    var op = (word >>> 26) & 0x3F, rs = (word >>> 21) & 0x1F, rt = (word >>> 16) & 0x1F, fn = word & 0x3F;
    if (op === 0x00) return M_SPECIAL[fn] || ('SPECIAL.' + fn.toString(16));
    if (op === 0x01) return M_REGIMM[rt] || ('REGIMM.' + rt.toString(16));
    if (op === 0x10) {
      if (rs & 0x10) return M_TLB[fn] || ('COP0.' + fn.toString(16));
      var c0 = M_CP0[rs];
      // MFC0/MTC0 carry the CP0 register number: which rd it is decides
      // whether the op is inert (emittable) or has side effects (Count/
      // Compare/Status — mips_instructions.def:620-735). A bare "MTC0"
      // bucket cannot rank that, and ranking it is the whole point.
      if (c0 === 'MFC0' || c0 === 'MTC0') return c0 + '.' + ((word >>> 11) & 0x1F);
      return c0 || ('COP0.rs' + rs.toString(16));
    }
    if (op === 0x11) {
      if (rs === 0x08) return ['BC1F', 'BC1T', 'BC1FL', 'BC1TL'][rt & 3];
      if (M_CP1_SUB[rs] !== undefined) return M_CP1_SUB[rs];
      var f = M_FMT[rs];
      if (f === undefined) return 'COP1.rs' + rs.toString(16);
      // the FP condition selects one of 16 predicates with DIFFERENT NaN
      // handling (fpu.h:222-300); "C.cond.S" hides which, so name it
      if (fn >= 0x30) return 'C.' + (M_CP1_COND[fn & 0x0F] || (fn & 0x0F)) + '.' + f;
      return (M_CP1_FN[fn] || ('FN' + fn.toString(16))) + '.' + f;
    }
    return M_OP[op] || ('OP.' + op.toString(16));
  }

  // ---- runtime execution census (wave 5b, ?jit=census) ----
  // Ranks the REMAINING emitter work by measured execution frequency rather
  // than by compile-time site counts (gate #6: measured, not guessed).
  //
  // Counters live in JS and are bumped through an imported host function
  // ("e"."c") that census-mode blocks call. Linear-memory counters would be
  // cheaper, but this build exports no _malloc (verified 2026-08-29: a page
  // eval reported `typeof Module._malloc === "undefined"`), so there is no
  // guest-invisible scratch region to put them in. Census is a COUNTING arm,
  // never a timing arm — the import call cost cannot change the counts, and
  // ?jit / ?jit=nofp emit byte-identical code to before (bump() returns []).
  // raised from 512 when MFC0/MTC0 gained a per-CP0-register suffix and the
  // FP compares gained a per-predicate one — the bucket space multiplies
  // (each also appears as a `<BRANCH>@slot:<MNEM>` variant)
  var CENSUS_MAX = 4096;
  var census = { on: null, keys: Object.create(null), names: [], counts: new Uint32Array(CENSUS_MAX), over: 0 };
  function censusBump(i) { census.counts[i]++; }
  function censusIdx(key) {
    var i = census.keys[key];
    if (i === undefined) {
      if (census.names.length >= CENSUS_MAX) { census.over++; return CENSUS_MAX - 1; }
      i = census.names.length; census.keys[key] = i; census.names.push(key);
    }
    return i;
  }
  // bytes that bump one census bucket; empty (and free) when census is off
  function bump(key) {
    if (!census.on) return [];
    return [OP.i32_const].concat(sleb(censusIdx(key)), [OP.call, 0x00]);
  }

  // ---- block-local register cache ----
  function RegCache(regBase) {
    this.regBase = regBase;
    this.loaded = new Array(32).fill(false);
    this.dirty = new Array(32).fill(false);
    // PINNED registers (2026-10-01, see PINNING in compileSpan): live in
    // their locals for the WHOLE block — loaded once in the prologue, written
    // back once in the epilogue — so a loop's back-edge and every label join
    // carry them in locals instead of a store + reload. A pinned register is
    // permanently loaded AND dirty in compile-state: the local is the
    // authoritative copy everywhere inside the block, and reg[] is brought
    // current (a) before every interpreter / core call (flushSnapshot,
    // flushAll, flushAndInvalidate) and (b) on every exit — the $exit
    // epilogue for plain exits, (a) for the RAW exits that follow a call.
    this.pinned = new Array(32).fill(false);
    this.err = { readOnlyWrite: -1 };     // shared with every clone
  }
  RegCache.prototype.clone = function () {
    var c = new RegCache(this.regBase);
    c.loaded = this.loaded.slice(); c.dirty = this.dirty.slice(); c.pinned = this.pinned.slice();
    c.err = this.err;
    return c;
  };
  // `written` is an over-approximation of the registers the span's native
  // code can write. A pinned register outside it is READ-ONLY in this block:
  // permanently CLEAN, so it is never stored back (its local always equals
  // reg[] — it is reloaded after every interpreter op, the only other
  // writer). writeFromStack enforces that the approximation really is one.
  RegCache.prototype.setPinned = function (pins, written) {
    for (var r = 0; r < 32; r++) {
      this.pinned[r] = !!pins[r];
      if (pins[r]) { this.loaded[r] = true; this.dirty[r] = !!written[r]; }
    }
  };
  // load every pinned register from reg[] into its local: the prologue, and
  // the re-sync after an interpreter op that CONTINUES in-block (it may have
  // written any register)
  RegCache.prototype.reloadPinned = function () {
    var out = [];
    for (var r = 0; r < 32; r++) if (this.pinned[r]) out = out.concat(loadI64(this.regBase + r * 8), [OP.local_set], leb(L_REG0 + r));
    return out;
  };
  RegCache.prototype.storePinned = function () {
    var out = [];
    for (var r = 0; r < 32; r++) if (this.pinned[r] && this.dirty[r]) out = out.concat(storeI64(this.regBase + r * 8, [OP.local_get].concat(leb(L_REG0 + r))));
    return out;
  };
  // value bytes that leave reg r (i64) on the stack; loads it first if needed
  RegCache.prototype.read = function (r) {
    var pre = [];
    if (!this.loaded[r]) {
      pre = loadI64(this.regBase + r * 8).concat([OP.local_set], leb(L_REG0 + r));
      this.loaded[r] = true;
    }
    return pre.concat([OP.local_get], leb(L_REG0 + r));
  };
  // consumes an i64 from the stack into reg r (local only; marks dirty)
  RegCache.prototype.writeFromStack = function (r) {
    // never reached while gprWrites over-approximates; if it ever is, the
    // whole span is refused (compileSpan checks err) rather than miscompiled
    if (this.pinned[r] && !this.dirty[r]) this.err.readOnlyWrite = r;
    this.loaded[r] = true;
    this.dirty[r] = true;
    return [OP.local_set].concat(leb(L_REG0 + r));
  };
  // flush(): the JOIN flush (label boundaries, branch tails). Pinned
  // registers stay in their locals — that is the point of pinning.
  RegCache.prototype.flush = function () {
    var out = [];
    for (var r = 0; r < 32; r++) {
      if (this.dirty[r] && !this.pinned[r]) {
        out = out.concat(storeI64(this.regBase + r * 8, [OP.local_get].concat(leb(L_REG0 + r))));
        this.dirty[r] = false;
      }
    }
    return out;
  };
  // flush bytes for the CURRENT dirty set WITHOUT mutating compile-state —
  // for fallback arms that exit the block (their state dies with them)
  RegCache.prototype.flushSnapshot = function () {
    var out = [];
    for (var r = 0; r < 32; r++) {
      if (this.dirty[r]) out = out.concat(storeI64(this.regBase + r * 8, [OP.local_get].concat(leb(L_REG0 + r))));
    }
    out.regs = this.dirtyRegs();          // the same set, for a cold handler (see COLD PATHS)
    return out;
  };
  // every register whose local is ahead of reg[] right now (pinned ones included): exactly the
  // stores flushSnapshot / flushAll would emit at this point
  RegCache.prototype.dirtyRegs = function () {
    var out = [];
    for (var r = 0; r < 32; r++) if (this.dirty[r]) out.push(r);
    return out;
  };
  // Emit ONLY the load prologue for reg r (leaves NOTHING on the stack) and
  // mark it loaded. Needed wherever a later `read` would otherwise emit that
  // prologue INSIDE a conditional arm while the compile-state claims the
  // local is live on both arms — see the join note above emitStore.
  RegCache.prototype.ensure = function (r) {
    if (this.loaded[r]) return [];
    this.loaded[r] = true;
    return loadI64(this.regBase + r * 8).concat([OP.local_set], leb(L_REG0 + r));
  };
  // flushAll(): flush() PLUS the pinned registers — before a core call whose
  // path always EXITS the block (gen_interrupt). Pinned stay loaded+dirty in
  // compile-state (they are, on every other path).
  RegCache.prototype.flushAll = function () {
    var out = this.flush();
    return out.concat(this.storePinned());
  };
  RegCache.prototype.invalidate = function () {
    for (var r = 0; r < 32; r++) if (!this.pinned[r]) { this.loaded[r] = false; this.dirty[r] = false; }
  };
  // before an interpreter op: reg[] must be complete, pinned included. A
  // caller whose path CONTINUES after the op must then emit reloadPinned().
  RegCache.prototype.flushAndInvalidate = function () {
    var out = this.flushAll();
    this.invalidate();
    return out;
  };

  // ---- recomp.c's RNOP rewrite: a DESTINATION OF r0 makes the WHOLE
  // instruction a NOP (2026-09-02) ----
  //
  // Most recomp.c emitters end with `if (dst->f.i.rt == reg) RNOP();` or
  // `if (dst->f.r.rd == reg) RNOP();`. `reg` is the global `int64_t reg[32]`
  // and `recompile_standard_{i,r}_type` binds `f.i.rt = reg + rt` /
  // `f.r.rd = reg + rd` (recomp.c:99-117), so the test is exactly
  // "destination register is r0". `RNOP()` sets `dst->ops = NOP`
  // (recomp.c:137-141) — the instruction then does NOTHING: no arithmetic,
  // NO MEMORY ACCESS, and no write to reg[0].
  //
  // This emitter's header used to assert the opposite ("this core's
  // interpreter WRITES reg[0] for ops whose destination is r0"). That is true
  // only of the ops recomp.c does NOT guard — MTHI/MTLO/MULT/MULTU/DIV/DIVU
  // (destination is hi/lo), MTC1/DMTC1 (destination is an FPR) and every
  // store (no destination at all). For the guarded family the emitter wrote
  // reg[0] where the core writes nothing, and reg[0] IS in the differential
  // checksum.
  //
  // Found on superMarioStarRoad.z64, which DIVERGED at VI frame 24. Bisecting
  // the compiled spans (?jitonly=) isolated ONE block, 0x802ca6d0, span 6:
  //     802ca6d0 lui   $t2, 0x8034
  //     802ca6d4 lw    $t3, -0x4d70($t2)
  //     802ca6d8 addiu $t3, $t3, 1
  //     802ca6dc sw    $t3, -0x4d70($t2)
  //     802ca6e0 j     0x80327b98
  //     802ca6e4 addiu $zero, $zero, 0x101   <- delay slot
  // RADDIU (recomp.c:1770-1775) turns that last one into NOP — the live
  // precomp_instr.ops for it reads a different table index from its
  // neighbouring ADDIU, which is the runtime confirmation — while emitAlu
  // computed 0x101 and stored it into reg[0].
  //
  // (This is why the earlier per-class ablation pointed at the _OUT branch
  // tail: disabling _OUT emission made the `j` fall back, and the interpreter
  // then ran the delay slot itself. The tail was never the defect; the ALU
  // delay slot it carried was.)
  //
  // SPECIAL fn codes this emitter handles whose destination is rd AND which
  // recomp.c guards: RSLL/RSRL/RSRA (:148,:156,:164), RSLLV/RSRLV/RSRAV
  // (:172,:180,:188), RMFHI/RMFLO (:228,:243), RADD/RADDU/RSUB/RSUBU
  // (:338,:346,:354,:362), RAND/ROR/RXOR/RNOR (:370,:378,:386,:394),
  // RSLT/RSLTU (:402,:410). Deliberately ABSENT: 0x11/0x13 (MTHI/MTLO) and
  // 0x18-0x1B (MULT/MULTU/DIV/DIVU) — unguarded, they still run.
  var SPECIAL_RD_NOP = { 0x00: 1, 0x02: 1, 0x03: 1, 0x04: 1, 0x06: 1, 0x07: 1, 0x10: 1, 0x12: 1,
                         0x20: 1, 0x21: 1, 0x22: 1, 0x23: 1, 0x24: 1, 0x25: 1, 0x26: 1, 0x27: 1,
                         0x2A: 1, 0x2B: 1,
                         // doubleword ALU (2026-09-30): RDSLLV/RDSRLV/RDSRAV (recomp.c:258,
                         // :266,:274), RDADD/RDADDU/RDSUB/RDSUBU (:418,:426,:434,:442),
                         // RDSLL/RDSRL/RDSRA/RDSLL32/RDSRL32/RDSRA32 (:487-527) — every one
                         // ends `if (dst->f.r.rd == reg) RNOP()`
                         0x14: 1, 0x16: 1, 0x17: 1, 0x2C: 1, 0x2D: 1, 0x2E: 1, 0x2F: 1,
                         0x38: 1, 0x3A: 1, 0x3B: 1, 0x3C: 1, 0x3E: 1, 0x3F: 1 };
  // I-type opcodes this emitter handles whose destination is rt AND which
  // recomp.c guards: RADDI/RADDIU (:1766,:1774), RSLTI/RSLTIU (:1782,:1790),
  // RANDI/RORI/RXORI/RLUI (:1798,:1806,:1814,:1822).
  var ITYPE_RT_NOP = { 0x08: 1, 0x09: 1, 0x0A: 1, 0x0B: 1, 0x0C: 1, 0x0D: 1, 0x0E: 1, 0x0F: 1,
                       0x18: 1, 0x19: 1 };   // RDADDI/RDADDIU (recomp.c:1928,:1936)

  // ---- native ALU emitters ----
  // Returns body bytes (value computed and written into the cache) or null.
  var p_hi_lo = { hi: 0, lo: 0 }; // bound per-compile (hi/lo addresses)
  function emitAlu(word, C) {
    if (word === 0) return []; // NOP
    var op = (word >>> 26) & 0x3F;
    var rs = (word >>> 21) & 0x1F, rt = (word >>> 16) & 0x1F, rd = (word >>> 11) & 0x1F;
    var sa = (word >>> 6) & 0x1F, fn = word & 0x3F;
    var imm = word & 0xFFFF;
    var wrap = [OP.i32_wrap_i64], xs = [OP.i64_extend_i32_s], xu = [OP.i64_extend_i32_u];
    var v = null, dest = -1;
    if (op === 0) {
      dest = rd;
      if (rd === 0 && SPECIAL_RD_NOP[fn]) return [];   // recomp.c RNOP
      switch (fn) {
        case 0x00: v = C.read(rt).concat(wrap, [OP.i32_const], sleb(sa), [OP.i32_shl], xs); break;   // SLL
        case 0x02: v = C.read(rt).concat(wrap, [OP.i32_const], sleb(sa), [OP.i32_shr_u], xs); break; // SRL
        case 0x03: v = C.read(rt).concat(wrap, [OP.i32_const], sleb(sa), [OP.i32_shr_s], xs); break; // SRA
        case 0x04: v = C.read(rt).concat(wrap, C.read(rs), wrap, [OP.i32_shl], xs); break;           // SLLV
        case 0x06: v = C.read(rt).concat(wrap, C.read(rs), wrap, [OP.i32_shr_u], xs); break;         // SRLV
        case 0x07: v = C.read(rt).concat(wrap, C.read(rs), wrap, [OP.i32_shr_s], xs); break;         // SRAV
        case 0x20:                                                                                     // ADD (no trap in this core)
        case 0x21: v = C.read(rs).concat(wrap, C.read(rt), wrap, [OP.i32_add], xs); break;           // ADDU
        case 0x22:                                                                                     // SUB (no trap in this core)
        case 0x23: v = C.read(rs).concat(wrap, C.read(rt), wrap, [OP.i32_sub], xs); break;           // SUBU
        case 0x24: v = C.read(rs).concat(C.read(rt), [OP.i64_and]); break;                            // AND
        case 0x25: v = C.read(rs).concat(C.read(rt), [OP.i64_or]); break;                             // OR
        case 0x26: v = C.read(rs).concat(C.read(rt), [OP.i64_xor]); break;                            // XOR
        case 0x27: v = C.read(rs).concat(C.read(rt), [OP.i64_or, OP.i64_const], sleb(-1), [OP.i64_xor]); break; // NOR
        case 0x10: return loadI64(p_hi_lo.hi).concat(C.writeFromStack(rd));                            // MFHI
        case 0x12: return loadI64(p_hi_lo.lo).concat(C.writeFromStack(rd));                            // MFLO
        case 0x11: return storeI64(p_hi_lo.hi, C.read(rs));                                            // MTHI
        case 0x13: return storeI64(p_hi_lo.lo, C.read(rs));                                            // MTLO
        case 0x18: // MULT: temp = rs64 * rt64 (FULL 64-bit operands); hi = temp>>32 (arith); lo = SE32(temp)
          return C.read(rs).concat(C.read(rt), [OP.i64_mul, OP.local_set], leb(L_I64S),
            storeI64(p_hi_lo.hi, [OP.local_get].concat(leb(L_I64S), [OP.i64_const], sleb(32), [OP.i64_shr_s])),
            storeI64(p_hi_lo.lo, [OP.local_get].concat(leb(L_I64S), wrap, xs)));
        case 0x19: // MULTU: (u64)(u32)rs * (u64)(u32)rt; hi = (i64)temp>>32 (ARITH — product can set bit 63); lo = SE32
          return C.read(rs).concat(wrap, xu, C.read(rt), wrap, xu, [OP.i64_mul, OP.local_set], leb(L_I64S),
            storeI64(p_hi_lo.hi, [OP.local_get].concat(leb(L_I64S), [OP.i64_const], sleb(32), [OP.i64_shr_s])),
            storeI64(p_hi_lo.lo, [OP.local_get].concat(leb(L_I64S), wrap, xs)));
        case 0x1A: // DIV: if (rt32 != 0) { lo=SE32(rs32/rt32); hi=SE32(rs32%rt32) } else SKIP (stale hi/lo)
          return C.read(rs).concat(wrap, [OP.local_set, L_ADDR], C.read(rt), wrap, [OP.local_set, L_WORD],
            [OP.local_get, L_WORD, OP.if_, OP.void_],
            storeI64(p_hi_lo.lo, [OP.local_get, L_ADDR, OP.local_get, L_WORD, OP.i32_div_s].concat(xs)),
            storeI64(p_hi_lo.hi, [OP.local_get, L_ADDR, OP.local_get, L_WORD, OP.i32_rem_s].concat(xs)),
            [OP.end]);
        case 0x1B: // DIVU
          return C.read(rs).concat(wrap, [OP.local_set, L_ADDR], C.read(rt), wrap, [OP.local_set, L_WORD],
            [OP.local_get, L_WORD, OP.if_, OP.void_],
            storeI64(p_hi_lo.lo, [OP.local_get, L_ADDR, OP.local_get, L_WORD, OP.i32_div_u].concat(xs)),
            storeI64(p_hi_lo.hi, [OP.local_get, L_ADDR, OP.local_get, L_WORD, OP.i32_rem_u].concat(xs)),
            [OP.end]);
        case 0x2A: v = C.read(rs).concat(C.read(rt), [OP.i64_lt_s], xu); break;                       // SLT
        case 0x2B: v = C.read(rs).concat(C.read(rt), [OP.i64_lt_u], xu); break;                       // SLTU
        // ---- doubleword ALU (2026-09-30), mips_instructions.def:1502-1516,
        // :1718-1740, :1752-1786. wasm's i64 shifts take the count mod 64,
        // which is exactly `rrs32 & 0x3F` for the variable forms.
        case 0x14: v = C.read(rt).concat(C.read(rs), [OP.i64_shl]); break;                            // DSLLV
        case 0x16: v = C.read(rt).concat(C.read(rs), [OP.i64_shr_u]); break;                          // DSRLV
        case 0x17: v = C.read(rt).concat(C.read(rs), [OP.i64_shr_s]); break;                          // DSRAV
        case 0x2C:                                                                                     // DADD (no trap in this core)
        case 0x2D: v = C.read(rs).concat(C.read(rt), [OP.i64_add]); break;                            // DADDU
        case 0x2E:                                                                                     // DSUB (no trap in this core)
        case 0x2F: v = C.read(rs).concat(C.read(rt), [OP.i64_sub]); break;                            // DSUBU
        case 0x38: v = C.read(rt).concat([OP.i64_const], sleb(sa), [OP.i64_shl]); break;              // DSLL
        case 0x3A: v = C.read(rt).concat([OP.i64_const], sleb(sa), [OP.i64_shr_u]); break;           // DSRL
        case 0x3B: v = C.read(rt).concat([OP.i64_const], sleb(sa), [OP.i64_shr_s]); break;           // DSRA
        case 0x3C: v = C.read(rt).concat([OP.i64_const], sleb(32 + sa), [OP.i64_shl]); break;         // DSLL32
        case 0x3E: v = C.read(rt).concat([OP.i64_const], sleb(32 + sa), [OP.i64_shr_u]); break;      // DSRL32
        case 0x3F: v = C.read(rt).concat([OP.i64_const], sleb(32 + sa), [OP.i64_shr_s]); break;      // DSRA32
        case 0x0F: return [];                                                                          // SYNC: ADD_TO_PC(1) only (:1473)
        default: return null;
      }
      return v.concat(C.writeFromStack(dest));
    }
    dest = rt;
    if (rt === 0 && ITYPE_RT_NOP[op]) return [];   // recomp.c RNOP
    switch (op) {
      case 0x08:                                                                                          // ADDI (no trap in this core)
      case 0x09: v = C.read(rs).concat(wrap, [OP.i32_const], sleb(sext16(imm)), [OP.i32_add], xs); break; // ADDIU
      case 0x0A: v = C.read(rs).concat([OP.i64_const], sleb(sext16(imm)), [OP.i64_lt_s], xu); break;      // SLTI
      case 0x0B: v = C.read(rs).concat([OP.i64_const], sleb(sext16(imm)), [OP.i64_lt_u], xu); break;      // SLTIU
      case 0x0C: v = C.read(rs).concat([OP.i64_const], sleb(imm), [OP.i64_and]); break;                   // ANDI
      case 0x0D: v = C.read(rs).concat([OP.i64_const], sleb(imm), [OP.i64_or]); break;                    // ORI
      case 0x0E: v = C.read(rs).concat([OP.i64_const], sleb(imm), [OP.i64_xor]); break;                   // XORI
      case 0x0F: v = [OP.i64_const].concat(sleb((imm << 16) | 0)); break;                                 // LUI
      case 0x18:                                                                                          // DADDI (no trap in this core, :129)
      case 0x19: v = C.read(rs).concat([OP.i64_const], sleb(sext16(imm)), [OP.i64_add]); break;          // DADDIU (:135)
      case 0x2F: return [];                                                                               // CACHE: ADD_TO_PC(1) only (:507)
      default: return null;
    }
    return v.concat(C.writeFromStack(dest));
  }

  // ---- native branch decoding ----
  // Returns { cond: null | (C)=>bytes, ... } — cond emission is DEFERRED so
  // that rejecting the candidate (IDLE/OUT/non-native slot) cannot poison
  // the cache compile-state with loads that were never emitted.
  function decodeBranch(word, addr, p) {
    var op = (word >>> 26) & 0x3F;
    var rs = (word >>> 21) & 0x1F, rt = (word >>> 16) & 0x1F;
    var imm = sext16(word & 0xFFFF);
    var bTarget = (addr + 4 + imm * 4) >>> 0;
    function cmpRR(opc) { return function (C) { return C.read(rs).concat(C.read(rt), [opc]); }; }
    function cmpRZ(opc) { return function (C) { return C.read(rs).concat([OP.i64_const, 0x00, opc]); }; }
    // wave 11b: BC1F/BC1T/BC1FL/BC1TL — a branch on FCR31 bit 23. The core
    // dispatches these as recomp_bc[(word >> 16) & 3] (recomp.c:1584), i.e.
    // bits 20:18 are IGNORED, so the emitter mirrors that mask exactly rather
    // than the wider MIPS-IV cc field. `cu1: true` marks the DECLARE_JUMP
    // cop1 flag: check_cop1_unusable() runs BEFORE anything else
    // (cached_interp.c:73-78), so compileSpan emits a bail prefix.
    if (op === 0x11 && rs === 0x08) {
      if (!p || !fcr31Ok(p)) return null;
      var bcBytes = loadI32(p.fcr31).concat([OP.i32_const], sleb(0x800000), [OP.i32_and]);
      if (!(rt & 1)) bcBytes = bcBytes.concat([OP.i32_eqz]);   // BC1F/BC1FL test == 0
      return { cond: function () { return bcBytes.slice(); }, link: false,
               likely: !!(rt & 2), target: bTarget, cu1: true };
    }
    if (op === 0x00) { // SPECIAL: JR/JALR — runtime register target, ALWAYS the _OUT path
      var fn0 = word & 0x3F;
      var rdJ = (word >>> 11) & 0x1F;
      if (fn0 === 0x08) return { cond: null, link: false, likely: false, target: null, targetReg: rs };
      // JALR's link register is `&rrd` (mips_instructions.def:1465) and
      // DECLARE_JUMP writes it only `if (link_register != &reg[0])`
      // (cached_interp.c:78-81) — so `jalr $zero, $rs` links NOTHING. RJALR
      // (recomp.c:198-203) has no RNOP guard, so the jump itself still runs;
      // only the link is suppressed. Same reg[0] class as the RNOP family.
      if (fn0 === 0x09) return { cond: null, link: rdJ !== 0, linkReg: rdJ, likely: false, target: null, targetReg: rs };
      return null;
    }
    switch (op) {
      case 0x02: return { cond: null, link: false, likely: false, target: (((addr + 4) & 0xF0000000) | ((word & 0x3FFFFFF) << 2)) >>> 0 };
      case 0x03: return { cond: null, link: true, likely: false, target: (((addr + 4) & 0xF0000000) | ((word & 0x3FFFFFF) << 2)) >>> 0 };
      case 0x04: return { cond: cmpRR(OP.i64_eq), link: false, likely: false, target: bTarget };
      case 0x05: return { cond: cmpRR(OP.i64_ne), link: false, likely: false, target: bTarget };
      case 0x06: if (rt !== 0) return null; return { cond: cmpRZ(OP.i64_le_s), link: false, likely: false, target: bTarget };
      case 0x07: if (rt !== 0) return null; return { cond: cmpRZ(OP.i64_gt_s), link: false, likely: false, target: bTarget };
      case 0x14: return { cond: cmpRR(OP.i64_eq), link: false, likely: true, target: bTarget };
      case 0x15: return { cond: cmpRR(OP.i64_ne), link: false, likely: true, target: bTarget };
      case 0x16: if (rt !== 0) return null; return { cond: cmpRZ(OP.i64_le_s), link: false, likely: true, target: bTarget };
      case 0x17: if (rt !== 0) return null; return { cond: cmpRZ(OP.i64_gt_s), link: false, likely: true, target: bTarget };
      case 0x01:
        switch (rt) {
          case 0x00: return { cond: cmpRZ(OP.i64_lt_s), link: false, likely: false, target: bTarget };
          case 0x01: return { cond: cmpRZ(OP.i64_ge_s), link: false, likely: false, target: bTarget };
          case 0x02: return { cond: cmpRZ(OP.i64_lt_s), link: false, likely: true, target: bTarget };
          case 0x03: return { cond: cmpRZ(OP.i64_ge_s), link: false, likely: true, target: bTarget };
          case 0x10: return { cond: cmpRZ(OP.i64_lt_s), link: true, likely: false, target: bTarget };
          case 0x11: return { cond: cmpRZ(OP.i64_ge_s), link: true, likely: false, target: bTarget };
          case 0x12: return { cond: cmpRZ(OP.i64_lt_s), link: true, likely: true, target: bTarget };
          case 0x13: return { cond: cmpRZ(OP.i64_ge_s), link: true, likely: true, target: bTarget };
          default: return null;
        }
      default: return null;
    }
  }

  // Any jump/branch that has a delay slot — WIDER than decodeBranch, which
  // returns null for shapes it will not emit (BLEZ/BGTZ with rt != 0, BC1 when
  // FCR31 is unavailable). Used only to keep labels off delay slots, where a
  // too-wide answer merely drops a label and a too-narrow one would split a
  // branch from its slot.
  function isBranchWord(w) {
    var op = (w >>> 26) & 0x3F;
    if (op === 0x00) { var fn = w & 0x3F; return fn === 0x08 || fn === 0x09; }
    if (op === 0x01) { var rt = (w >>> 16) & 0x1F; return rt <= 0x03 || (rt >= 0x10 && rt <= 0x13); }
    if (op >= 0x02 && op <= 0x07) return true;
    if (op >= 0x14 && op <= 0x17) return true;
    if (op === 0x11 && ((w >>> 21) & 0x1F) === 0x08) return true;
    return false;
  }

  // interpreter ops that can call gen_interrupt() while leaving PC at the
  // next instruction: MTC0 (COP0 rs=4) and every store opcode
  function mayGenInterrupt(w) {
    var op = (w >>> 26) & 0x3F;
    if (op === 0x10) return ((w >>> 21) & 0x1F) === 0x04;
    return (op >= 0x28 && op <= 0x2E) || op === 0x38 || op === 0x39 || op === 0x3C || op === 0x3D || op === 0x3F;
  }
  // the subset of those that is ALWAYS a generic fallback, so ALWAYS hands
  // back: MTC0, SWL/SWR/SDL/SDR, SC/SCD (SB/SH/SW/SD/SWC1/SDC1 are native and
  // hand back only on their rare off-RDRAM arm). The instruction after one is
  // made a LABEL (compileSpan, label source (d)): the dispatcher's very next
  // `PC->ops()` then re-enters native code there instead of interpreting the
  // rest of the span. It costs nothing at that boundary — the fallback has
  // already flushed and emptied the register cache.
  function alwaysHandsBack(w) {
    var op = (w >>> 26) & 0x3F;
    if (op === 0x10) return ((w >>> 21) & 0x1F) === 0x04;
    return op === 0x2A || op === 0x2C || op === 0x2D || op === 0x2E || op === 0x38 || op === 0x3C;
  }

  // pinning (compileSpan): every GPR an instruction word can name, over-
  // approximated — too wide only adds a pin, never changes what executes
  var PIN_MAX = 12;
  function gprRefs(w, refs) {
    var op = (w >>> 26) & 0x3F, rs = (w >>> 21) & 0x1F, rt = (w >>> 16) & 0x1F;
    if (op === 0x00) { refs[rs]++; refs[rt]++; refs[(w >>> 11) & 0x1F]++; return; }
    if (op === 0x01) { refs[rs]++; return; }
    if (op === 0x02) return;
    if (op === 0x03) { refs[31]++; return; }
    if (op >= 0x10 && op <= 0x13) { if (rs === 0 || rs === 1 || rs === 2 || rs === 4 || rs === 5 || rs === 6) refs[rt]++; return; }
    if (op === 0x31 || op === 0x35 || op === 0x39 || op === 0x3D || op === 0x2F) { refs[rs]++; return; }
    refs[rs]++; refs[rt]++;
  }

  // ...and every GPR an instruction word can WRITE, over-approximated: rd of
  // any SPECIAL, $ra for JAL / REGIMM, rt of everything that is not a store,
  // a branch, J, CACHE or an FP load/store. Scanned to span INCLUSIVE (the
  // last branch's delay slot is emitted with it).
  function gprWrites(w, out) {
    var op = (w >>> 26) & 0x3F, rt = (w >>> 16) & 0x1F;
    if (op === 0x00) { out[(w >>> 11) & 0x1F] = true; return; }
    if (op === 0x01 || op === 0x03) { out[31] = true; return; }
    if (op === 0x02 || (op >= 0x04 && op <= 0x07) || (op >= 0x14 && op <= 0x17)) return;
    if ((op >= 0x28 && op <= 0x2F) || op === 0x38 || op === 0x39 || op === 0x3C || op === 0x3D || op === 0x3F) return;
    if (op === 0x31 || op === 0x35) return;
    out[rt] = true;
  }

  // Count += ((addr + 8 - last_addr) >> 2) * count_per_op, the value also left in L_CNT for the
  // poll that follows on every path (emitTailPoll). LEAN CODE: count_per_op 1 or 2 is a single
  // shift — exact because the difference is always a multiple of 4: addr + 8 is a word address
  // and every writer of last_addr stores a word address (PC->addr, an EPC through jump_to, the
  // reset vector 0xa4000040, skip_jump = PC->addr, or a constant this emitter bakes), so
  // ((d >> 2) * 2) == (d >> 1) and ((d >> 2) * 1) == (d >> 2).
  function emitCountBatch(p, addr) {
    var scale = (p.cpo === 1) ? [OP.i32_const, 0x02, OP.i32_shr_u]
      : (p.cpo === 2) ? [OP.i32_const, 0x01, OP.i32_shr_u]
      : [OP.i32_const, 0x02, OP.i32_shr_u, OP.i32_const].concat(sleb(p.cpo), [OP.i32_mul]);
    var val = [OP.i32_const].concat(sleb((addr + 8) | 0),
      loadI32(p.lastAddr), [OP.i32_sub], scale,
      loadI32(p.count), [OP.i32_add, OP.local_tee], leb(L_CNT));
    return storeI32(p.count, val);
  }

  // last_addr = finalAddr; if (next_interrupt <= Count) { flush; PC=finalPtr;
  // gen_interrupt(); invalidate; if (PC != finalPtr) br $exit }
  // The CACHE must be clean across gen_interrupt — it runs exception
  // delivery and can hand control to arbitrary guest code after we exit.
  function emitTailPoll(p, C, finalAddr, finalPtr, exitDepth) {
    if (COLD) {
      var flushRegs = C.dirtyRegs();
      C.flushAll();                       // same compile-state effect as the inline arm
      return storeI32Const(p.lastAddr, finalAddr | 0).concat(
        loadI32(p.nextInt), [OP.local_get], leb(L_CNT), [OP.i32_le_u],      // L_CNT: emitCountBatch's Count
        [OP.if_, OP.void_],
          coldJump([].concat(
            bump('#gen_interrupt'),
            storeI32Const(p.pcGlobal, finalPtr),
            [OP.i32_const], sleb(p.genInt), [OP.call_indirect, 0x00, 0x00]), exitDepth + 1, flushRegs),
        [OP.end]);
    }
    return storeI32Const(p.lastAddr, finalAddr | 0).concat(
      loadI32(p.nextInt), [OP.local_get], leb(L_CNT), [OP.i32_le_u],      // L_CNT: emitCountBatch's Count
      [OP.if_, OP.void_],
      bump('#gen_interrupt'),
      C.flushAll(),                       // compile-state: dirty cleared on BOTH arms (flush emits stores only here, but the arm not taken loses nothing: dirty was already current)
      storeI32Const(p.pcGlobal, finalPtr),
      [OP.i32_const], sleb(p.genInt), [OP.call_indirect, 0x00, 0x00],
      // ALWAYS return to the dispatcher after gen_interrupt (2026-09-30).
      // It used to continue in-block when PC was unchanged, but gen_interrupt
      // can END THE FRAME without moving PC: a VI_INT event calls
      // retro_return() (interrupt.c VI_INT case), which sets stop_stepping,
      // and when the MI interrupt is masked no exception is raised. The
      // interpreter's DECLARE_JUMP returns to r4300_step, which sees
      // stop_stepping && VI_Count and ends retro_run right there
      // (r4300.c:175-196); a block that kept going ran guest code into the
      // NEXT frame. Latent on the entry back-edge since wave 2, it became a
      // frame-1 divergence (MK64 boot) once every in-span branch went native.
      // PC already holds the right successor (finalPtr, or gen_interrupt's
      // redirect), so exiting is exact and costs one dispatch per interrupt.
      [OP.br].concat(leb(exitDepth + 1 + RAW)),
      [OP.end]
    );
  }

  // _OUT taken-tail: jump_to(target); last_addr = PC->addr (runtime — PC was
  // set by jump_to); poll gen_interrupt (PC already correct, no recheck —
  // the block exits regardless). targetBytes pushes the i32 target.
  function emitOutJumpTail(p, targetBytes, exitDepth, C) {
    if (COLD) {
      // LEAN CODE: the gen_interrupt arm is a cold handler (no registers: the caller flushed,
      // and the pinned ones are written back first thing below); the block returns after it
      // either way, so `call $h; return` is the arm, and CHAINING's fall-through is unchanged
      return [].concat(
        C.storePinned(),
        jumpToBytes(p, targetBytes),
        storeI32(p.lastAddr, loadI32(p.pcGlobal).concat([OP.i32_load, 0x02], leb(p.addrOff))),
        loadI32(p.nextInt), loadI32(p.count), [OP.i32_le_u],
        [OP.if_, OP.void_],
          coldJump([].concat(bump('#gen_interrupt'), [OP.i32_const], sleb(p.genInt), [OP.call_indirect, 0x00, 0x00]), exitDepth + 1, []),
        [OP.end],
        bump('#exit:jump_to'),
        chainOr(exitDepth));
    }
    return [].concat(
      C.storePinned(),              // the caller's C.flush() left only pinned registers unwritten
      jumpToBytes(p, targetBytes),
      storeI32(p.lastAddr, loadI32(p.pcGlobal).concat([OP.i32_load, 0x02], leb(p.addrOff))),
      loadI32(p.nextInt), loadI32(p.count), [OP.i32_le_u],
      [OP.if_, OP.void_],
        bump('#gen_interrupt'),
        [OP.i32_const], sleb(p.genInt), [OP.call_indirect, 0x00, 0x00],
        CHAIN && !RAW ? [OP.br].concat(leb(exitDepth + 1)) : [],     // gen_interrupt ran: back to the dispatcher
      [OP.end],
      bump('#exit:jump_to'),
      chainOr(exitDepth)
    );
  }

  // ---- CHAINING (2026-10-03) ----
  // WHY. Every block exit returned to r4300_step, which checks retro_stop_stepping() and
  // getVI_Count() and calls PC->ops() — the dispatch loop (mainLoopInner, where r4300_step is
  // inlined) was 8.8% of the core thread's self time in an MK64 race profile.
  // WHAT. At the exits where nothing that can end the frame has run on the path — a jump_to
  // tail, an in-span branch exit or the fall-through, each after its interrupt poll was NOT
  // taken — the block tail-calls PC->ops() itself (return_call_indirect: the callee returns to
  // r4300_step, which then checks as it would have). EXACT: r4300_step leaves its loop when
  // stop_stepping && VI_Count > 0; stop_stepping is only ever set (retro_return) and VI_Count
  // only ever incremented (interrupt.c) inside gen_interrupt or the calls that may run it, and
  // every path through one of those (a taken interrupt poll, a store's slow arm, a fallback
  // op that mayGenInterrupt) still hands back to the dispatcher. So on a chained path both
  // flags are what they were when r4300_step called this block — and it called it, so its
  // check then said "continue"; the skipped check would have said the same. Off when the
  // browser has no wasm tail calls (feature-tested) and under register pinning (RAW: the
  // epilogue must run first).
  // OFF BY DEFAULT — opt in with ?jitchain=1 (fbasync.js). PRICED 2026-10-03 at half a core
  // (n64_field_cost_probe --clock --nodbg --wcpu 0.5, MK64 race 1900-3000, interleaved
  // H K K H H K, load 4.0-5.2): HEAD 10.24 / 10.35 / 9.60 ms per field, chained 9.03 / 9.76 /
  // 10.81 — inside the rig's noise, so like PINNING it does not ship on until a quieter
  // measurement shows a gain. Off, the emitted bytes are identical to the unchained emitter's.
  var CHAIN = false;              // per compile: chaining on for this span
  var chainOK = null;             // wasm tail calls supported (tested once per realm)
  function chainOn() {
    if (EMIT_ONLY) return EMIT_ONLY.chain === true;
    var g = (typeof globalThis !== 'undefined') ? globalThis : self, f = g.__fbAsync;
    if (!(f && f.jitChain === true)) return false;     // opt-in: ?jitchain=1
    if (chainOK === null) {
      try {
        // (module (type (func)) (table 1 funcref) (func (return_call_indirect (type 0) (i32.const 0))))
        chainOK = WebAssembly.validate(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0,
          3, 2, 1, 0, 4, 4, 1, 0x70, 0, 1, 10, 9, 1, 7, 0, 0x41, 0, 0x13, 0, 0, 0x0b]));
      } catch (e) { chainOK = false; }
    }
    return chainOK;
  }
  // the exit at a `br exitD` to $exit: a tail call of PC->ops when chaining, else that br
  // ONLY INTO A JIT BLOCK (an op at or above the core's table length). An interpreter op is
  // left to the dispatcher: NOTCOMPILED, FIN_BLOCK and the jump ops call PC->ops() from inside
  // their own frame, so a chain through them would nest a C frame per hop (measured: "Maximum
  // call stack size exceeded" in MK64's boot). Label wrappers tail-call their body for the
  // same reason (see the wrappers below).
  function chainOr(exitD) {
    if (!CHAIN || RAW || !TABLE_BASE) return [OP.br].concat(leb(exitD + RAW));
    return [].concat(loadI32(p_chain.pcGlobal), [OP.i32_load, 0x02, 0x00], [OP.local_set], leb(L_ADDR),
                     [OP.local_get], leb(L_ADDR), [OP.i32_const], sleb(TABLE_BASE), [OP.i32_ge_u],
                     [OP.if_, OP.void_],
                       bump('#chain'),
                       [OP.local_get], leb(L_ADDR), [OP.return_call_indirect, 0x00, 0x00],
                     [OP.end],
                     [OP.br].concat(leb(exitD + RAW)));
  }
  var p_chain = null;             // the compile's params (chainOr needs pcGlobal)

  // ---- COLD PATHS (2026-10-03) ----
  // WHY. Measured with tools/n64_emit_unit_test.mjs's harness driving MANY distinct emitted
  // spans round-robin (the shape of a game's frame, unlike one hot loop): 1500 spans x 150
  // instructions ran at 26-45 ns per guest instruction against 2.3-2.8 ns for 10 such spans —
  // the same code, ten times slower, because the emitted code does not fit the CPU's caches.
  // The MK64 race measures exactly that: ~400k guest instructions in a heavy field at 15-19 ns
  // each (n64_field_cost_probe --attr). Most of every span's bytes are arms that almost never
  // run — each load/store/FP op's slow arm (flush the dirty registers, call the interpreter op),
  // each branch's gen_interrupt arm, CHECK_MEMORY's code-page probe — interleaved with the hot
  // path, so the hot path is spread over many more cache lines than it needs. With the slow arms
  // removed the 1500-span case ran 17.6 ns, and with CHECK_MEMORY's inner probe also removed
  // 6.3 ns (diagnostic arms, not shippable — this is what they priced).
  // WHAT. A cold arm is moved out of the hot path, and its body — what the arm did inline, ending
  // in a return to the dispatcher — runs out of line: since 2026-10-03 (LEAN CODE) as a call of
  // its own function (see COLD CALLS at coldJump; the first shape, `L_COLD = k; br $cold` into
  // one br_table at the end of the body, cost TurboFan a phi move per live local at every arm).
  // CHECK_MEMORY's code-page probe becomes a call to one helper function per module. With cold
  // paths, label entries need no wrapper functions either (LABELS BY PC, at the multi-entry
  // dispatch). The one behavioural difference: a slow LOAD used to
  // continue in-block after its interpreter op; it now returns to the dispatcher, which runs
  // PC->ops for the next instruction — the same instruction the block would have run next, with
  // reg[] complete (every register was flushed before the op). Exact either way; it costs a
  // dispatch only on the rare off-RDRAM access.
  // ?jitcold=0 (fbasync.js publishes it in both realms) keeps every arm inline (and the label
  // wrappers): A/B arm, kill switch.
  var COLD = null;           // per-compile handler list while compileSpan runs with cold paths on
  function coldOn() {
    var g = (typeof globalThis !== 'undefined') ? globalThis : self, f = g.__fbAsync;
    if (EMIT_ONLY) return EMIT_ONLY.cold !== false;
    return !(f && f.jitCold === false);
  }
  // pinning (see PINNING in compileSpan): window.__jitPin, or ?jitpin=1 (fbasync.js publishes it)
  function pinOn() {
    if (typeof window !== 'undefined' && window.__jitPin) return true;
    if (EMIT_ONLY) return false;
    var g = (typeof globalThis !== 'undefined') ? globalThis : self, f = g.__fbAsync;
    return !!(f && f.jitPin);
  }
  // COLD CALLS (LEAN CODE, 2026-10-03). A cold arm is `local.get <its dirty registers>; call $h;
  // return`, and $h — one function per arm, appended to the module after the span's functions
  // (COLD_FN0 + k) — stores those registers to reg[] in register order, then runs `tail`, and
  // returns; the block then returns to the dispatcher. Same effects, in the same order, as the
  // arm had inline. WHY NOT A SHARED br TARGET (the first COLD PATHS shape, `L_COLD = k; br $cold`
  // into one br_table of handlers at the end of the body): in TurboFan that merge point makes
  // every local any handler reads a phi, so EVERY cold arm's site materialised all of them into
  // fixed registers — 8-10 moves (zeroing the locals not yet assigned on that path) before its
  // jmp, laid into the hot path of every load, store and branch (measured: a 20-instruction MK64
  // span's body was 3136 bytes of machine code). A call passes only that arm's own registers,
  // and a handler that never runs is never even compiled (V8 compiles wasm functions lazily).
  // `exitD` is kept for the call sites' symmetry with the inline arms; a call needs no depth.
  var COLD_FN0 = 0;          // function index of this span's first cold handler
  function coldJump(tail, exitD, regs) {
    var k = COLD.length;
    COLD.push({ regs: regs, tail: tail });
    var site = [];
    for (var q = 0; q < regs.length; q++) { site.push(OP.local_get); app(site, leb(L_REG0 + regs[q])); }
    site.push(OP.call); app(site, leb(COLD_FN0 + k)); site.push(OP.return_);
    return site;
  }
  // the handler function's bytes: param q is register regs[q] (i64)
  function coldHandlerFn(h, regBase) {
    if (h.raw) return h.raw;               // a prebuilt helper (LABELS BY PC's guard)
    var f = [0x00];
    for (var q = 0; q < h.regs.length; q++) app(f, storeI64(regBase + h.regs[q] * 8, [OP.local_get].concat(leb(q))));
    app(f, h.tail); f.push(OP.end);
    return f;
  }
  // a handler's type index: 0 = ()->(), 1 = (i32)->() (CHECK_MEMORY's helper / census), 1 + n = (i64 x n)->()
  function coldType(h) { return h.raw ? h.type : (h.regs.length ? 1 + h.regs.length : 0); }
  var TYPE_SEC = (function () {
    var t = [].concat(leb(34), [0x60, 0x00, 0x00], [0x60, 0x01, 0x7F, 0x00]);
    for (var n = 1; n <= 32; n++) { t.push(0x60); app(t, leb(n)); for (var q = 0; q < n; q++) t.push(0x7E); t.push(0x00); }
    return section(1, t);
  })();

  // The slow (non-RDRAM / CU1-clear) arm of a native memory or FP op.
  //
  // Normally it runs THIS instruction's interpreter op and CONTINUES in-block,
  // exiting only if the op diverged PC. When the op sits in a branch DELAY
  // SLOT (`slow` supplied) it must instead hand the WHOLE BRANCH back to the
  // interpreter and exit unconditionally: only the interpreter sets
  // g_dev.r4300.delay_slot around the slot (cached_interp.c:73-96), and
  // without that flag a faulting slot records EPC/BD wrong and never sets
  // skip_jump (exception.c:143-145), so the cancelled jump would still be
  // taken. Re-running the branch from its own first instruction is EXACT:
  // the only guest state the block has written by then is the link register,
  // and DECLARE_JUMP writes it the identical value (SE32(addr+8)) again.
  //
  // `preFlush` is the caller's C.flushSnapshot() captured BEFORE it built the
  // fast-arm bytes — the same parameter, for the same reason, as cuGuard's.
  // Omit it only where the caller marks no register dirty while building that
  // arm. See the note above emitLoad.
  // `exitAlways` (2026-09-30): a slow STORE can reach an MMIO write handler
  // that runs gen_interrupt itself (mi_controller.c:105) — and gen_interrupt
  // can END THE FRAME without moving PC (VI_INT -> retro_return ->
  // stop_stepping). The interpreter then returns to r4300_step, which ends
  // retro_run; a block that continued ran the next frame's code inside this
  // one. So a store's slow arm always hands back to the dispatcher (PC is
  // already the next instruction). Loads keep continuing: no read handler
  // calls gen_interrupt.
  function slowArm(p, C, instrPtr, opsIdx, brDepth, slow, refreshReg, preFlush, exitAlways) {
    var flushed = preFlush || C.flushSnapshot();
    if (COLD) {
      // out of line, and always back to the dispatcher (see COLD PATHS)
      return coldJump([].concat(
        storeI32Const(p.pcGlobal, slow ? slow.ptr : instrPtr),
        [OP.i32_const], sleb(slow ? slow.opsIdx : opsIdx), [OP.call_indirect, 0x00, 0x00]), brDepth, flushed.regs);
    }
    if (slow) {
      return [].concat(
        flushed,
        storeI32Const(p.pcGlobal, slow.ptr),
        [OP.i32_const], sleb(slow.opsIdx), [OP.call_indirect, 0x00, 0x00],
        [OP.br].concat(leb(brDepth + RAW)));
    }
    return [].concat(
      flushed,
      storeI32Const(p.pcGlobal, instrPtr),
      [OP.i32_const], sleb(opsIdx), [OP.call_indirect, 0x00, 0x00],
      refreshReg >= 0 ? loadI64(p.regBase + refreshReg * 8).concat([OP.local_set], leb(L_REG0 + refreshReg)) : [],
      exitAlways
        ? [OP.br].concat(leb(brDepth + RAW))
        : [].concat(loadI32(p.pcGlobal), [OP.i32_const], sleb(instrPtr + p.stride), [OP.i32_ne],
                    [OP.br_if], leb(brDepth + RAW)));
  }

  // ---- native loads & stores ----
  // Shared structure (exit-don't-join): the fast arm operates on the cache
  // and CONTINUES — the fallback arm flushes a snapshot, calls the interp op
  // and EXITS the block unconditionally (PC is correct either way after the
  // op). The register cache therefore stays hot across native memory
  // traffic; only genuinely slow accesses (TLB/MMIO/fb-protected) pay an
  // exit. Compile-state mutations inside the fast arm are sound because the
  // fast arm is the only continuing path.
  //
  // JOIN CONTRACT, third instance — fixed 2026-09-02 (conker.z64 diverged at
  // VI frame 82). `fastBytes` ends with `C.writeFromStack(rt)`, which marks rt
  // DIRTY; `slowArm` then called `C.flushSnapshot()`, which on the SLOW arm
  // emitted a store of a wasm local that is only assigned on the FAST arm —
  // writing wasm's zero-init over reg[rt] and only then calling the
  // interpreter op. The comment that used to sit here called that "benign"
  // because the op normally rewrites reg[rt] straight after. It is not benign
  // whenever the op does NOT write rt:
  //   * the load FAULTS (TLB miss / MMIO) — the interpreter leaves reg[rt]
  //     alone, we have already zeroed it, and PC divergence exits the block
  //     with the wrong value live;
  //   * `ops` is NOTCOMPILED/NOTCOMPILED2 — recompiles, writes no register;
  //   * (before the RNOP fix above) rt == 0, where the op is a plain NOP.
  // HONESTY NOTE ON REACH — the standing caveat wave 6's cuGuard carries. This
  // was found while chasing conker.z64's frame-82 divergence and it did NOT
  // fix it: conker still DIVERGES at 82 with this repaired. It is a real bug
  // proven by executing unit tests; it is not a demonstrated cause of any
  // observed misbehaviour on a ROM.
  // The repair is cuGuard's: capture the snapshot BEFORE building the fast arm,
  // so the slow arm flushes only what was dirty on ENTRY to this instruction.
  // That is exact and costs nothing (unlike emitStore's C.ensure hoist, which
  // is still right there because a store READS rt).
  // LEAN CODE (2026-10-03): the effective address `rs + imm` into L_ADDR, LEFT ON THE STACK as
  // well (local.tee) for the dispatch-table index that always follows; no add for imm == 0.
  function effAddr(C, rs, imm) {
    return C.read(rs).concat([OP.i32_wrap_i64], imm ? [OP.i32_const].concat(sleb(imm), [OP.i32_add]) : [], [OP.local_tee, L_ADDR]);
  }
  // consumes the effective address effAddr left on the stack: 1 when the live dispatch table
  // does NOT route this 64 KB page to read/write_rdram* — the slow arm's condition
  // (`hit`: the inverse, 1 when it does — the inline slow arm's if/else shape, ?jitcold=0)
  function tblCheck(tableBase, cmpVal, hit) {
    return [OP.i32_const, 0x10, OP.i32_shr_u, OP.i32_const, 0x02, OP.i32_shl, OP.i32_load, 0x02].concat(
      leb(tableBase), [OP.i32_const], sleb(cmpVal), [hit ? OP.i32_eq : OP.i32_ne]);
  }
  function emitLoad(word, instrPtr, p, C, opsIdx, exitDepth, slow) {
    var op = (word >>> 26) & 0x3F;
    if (op !== 0x20 && op !== 0x21 && op !== 0x23 && op !== 0x24 && op !== 0x25 && op !== 0x27 && op !== 0x37) return null;
    var rs = (word >>> 21) & 0x1F, rt = (word >>> 16) & 0x1F;
    // recomp.c RNOP (see SPECIAL_RD_NOP above): RLB/RLH/RLW/RLBU/RLHU/RLWU/RLD
    // all end with `if (dst->f.i.rt == reg) RNOP()` (:1960,:1968,:1984,:1992,
    // :2000,:2016,:2108). A load into r0 does not even perform the ACCESS —
    // which also means it can neither fault nor touch MMIO, so emitting
    // nothing is exact in a delay slot too.
    if (rt === 0) return [];
    // captured BEFORE fastBytes marks rt dirty — see the join-contract note above
    var preFlush = C.flushSnapshot();
    var imm = sext16(word & 0xFFFF);
    var tableBase, cmpVal;
    if (op === 0x37) { tableBase = p.readmemD; cmpVal = p.rdRdramD; }   // LD (wave 9)
    else if (op === 0x23 || op === 0x27) { tableBase = p.readmemW; cmpVal = p.rdRdram; }
    else if (op === 0x20 || op === 0x24) { tableBase = p.readmemB; cmpVal = p.rdRdramB; }
    else { tableBase = p.readmemH; cmpVal = p.rdRdramH; }
    var shiftB = [OP.local_get, L_ADDR, OP.i32_const, 0x03, OP.i32_and, OP.i32_const, 0x03, OP.i32_xor, OP.i32_const, 0x03, OP.i32_shl];
    var shiftH = [OP.local_get, L_ADDR, OP.i32_const, 0x02, OP.i32_and, OP.i32_const, 0x02, OP.i32_xor, OP.i32_const, 0x03, OP.i32_shl];
    // `val` consumes the loaded dram word from the stack (LEAN CODE: it used to be parked in
    // L_WORD and read straight back; the sub-word shift reads only L_ADDR)
    var val;
    switch (op) {
      case 0x23: val = [OP.i64_extend_i32_s]; break;
      case 0x27: val = [OP.i64_extend_i32_u]; break;
      case 0x24: val = shiftB.concat([OP.i32_shr_u, OP.i32_const], sleb(0xFF), [OP.i32_and, OP.i64_extend_i32_u]); break;
      case 0x20: val = shiftB.concat([OP.i32_shr_u, OP.i32_const], sleb(0xFF), [OP.i32_and, OP.i32_extend8_s, OP.i64_extend_i32_s]); break;
      case 0x25: val = shiftH.concat([OP.i32_shr_u, OP.i32_const], sleb(0xFFFF), [OP.i32_and, OP.i64_extend_i32_u]); break;
      case 0x21: val = shiftH.concat([OP.i32_shr_u, OP.i32_const], sleb(0xFFFF), [OP.i32_and, OP.i32_extend16_s, OP.i64_extend_i32_s]); break;
    }
    // ORDER MATTERS — the same emit-call-order trap documented on emitStore.
    // fastBytes calls C.writeFromStack(rt), which marks rt loaded; if the
    // address read ran AFTER that and rs == rt (`lw $8, off($8)` — a
    // ubiquitous pointer chase) the read would collapse to a bare local.get
    // of a local that is only assigned INSIDE the fast arm, computing the
    // effective address from wasm's zero-init. Read rs FIRST, always.
    var addrBytes = effAddr(C, rs, imm);
    // LD (wave 9): readd() reads the word at `a` as the HIGH half and the word
    // at `a+4` as the LOW half (m64p_memory.c:127-133,
    // *value = ((uint64_t)w[0] << 32) | w[1]) — the identical shape LDC1
    // already uses below, just against the GPR file. CHECK_MEMORY is a
    // load-side no-op, so nothing else changes.
    var fastBytes = (op === 0x37)
      ? [].concat(
          [OP.local_get, L_ADDR, OP.i32_const], sleb(0xFFFFFC), [OP.i32_and],
          [OP.i32_load, 0x02], leb(p.dramBase), [OP.i64_extend_i32_u, OP.i64_const], sleb(32), [OP.i64_shl],
          [OP.local_get, L_ADDR, OP.i32_const, 0x04, OP.i32_add, OP.i32_const], sleb(0xFFFFFC), [OP.i32_and],
          [OP.i32_load, 0x02], leb(p.dramBase), [OP.i64_extend_i32_u],
          [OP.i64_or],
          C.writeFromStack(rt))
      : [].concat(
          [OP.local_get, L_ADDR, OP.i32_const], sleb(0xFFFFFC), [OP.i32_and],
          [OP.i32_load, 0x02], leb(p.dramBase),
          val, C.writeFromStack(rt)); // join: rt loaded+dirty (slow arm refreshes the local; its redundant flush is benign)
    if (COLD) {
      // LEAN CODE: the slow arm never continues in-block (a cold handler returns), so the fast
      // arm needs no if/else around it — `if (table != rdram) cold; fast`. Compile-state:
      // the fast arm is the only path that reaches what follows, as it was the only continuing one.
      return [].concat(
        addrBytes, tblCheck(tableBase, cmpVal),
        [OP.if_, OP.void_],
          bump((slow ? 'SLOTSLOW:' : 'SLOW:') + mnem(word)),
          slowArm(p, C, instrPtr, opsIdx, exitDepth + 1, slow, rt, preFlush),
        [OP.end],
        fastBytes);
    }
    return [].concat(
      addrBytes, tblCheck(tableBase, cmpVal, true),
      [OP.if_, OP.void_],
        fastBytes,
      [OP.else_],
        bump((slow ? 'SLOTSLOW:' : 'SLOW:') + mnem(word)),
        // continue-after-fallback: flush the PRE-INSTRUCTION dirty set (rt is
        // deliberately NOT in it — see the join-contract note above), run the
        // interp op, then refresh ONLY the op's write-set (rt) into its local
        // so both arms join in the same compile-state (rt loaded).
        // PC divergence (TLB exception) still exits.
        slowArm(p, C, instrPtr, opsIdx, exitDepth + 1, slow, rt, preFlush),
      [OP.end]
    );
  }

  // CHECK_MEMORY mirror (cached_interp.c): if (!invalid_code[a>>12]) and the
  // page block instr at (a&0xFFF)/4 has ops != NOTCOMPILED, mark the page
  // invalid; blocks[x] dereferenced only under invalid_code[x]==0.
  function checkMemoryBytes(p) {
    if (COLD) {
      // the code-page probe (ops != NOTCOMPILED) is a call to the module's helper (chkHelper)
      return [].concat(
        [OP.local_get, L_ADDR, OP.i32_const, 0x0C, OP.i32_shr_u],
        [OP.i32_load8_u, 0x00], leb(p.invalidCode),
        [OP.i32_eqz, OP.if_, OP.void_],
          [OP.local_get, L_ADDR, OP.call], leb(CHK_FN),
        [OP.end]);
    }
    return [].concat(
      [OP.local_get, L_ADDR, OP.i32_const, 0x0C, OP.i32_shr_u],
      [OP.i32_load8_u, 0x00], leb(p.invalidCode),
      [OP.i32_eqz, OP.if_, OP.void_],
        [OP.local_get, L_ADDR, OP.i32_const, 0x0C, OP.i32_shr_u, OP.i32_const, 0x02, OP.i32_shl],
        [OP.i32_load, 0x02], leb(p.blocksBase),
        [OP.i32_load, 0x02, 0x00],
        [OP.local_get, L_ADDR, OP.i32_const], sleb(0xFFF), [OP.i32_and, OP.i32_const, 0x02, OP.i32_shr_u, OP.i32_const], sleb(p.stride), [OP.i32_mul, OP.i32_add],
        [OP.i32_load, 0x02, 0x00],
        [OP.i32_const], sleb(p.notCompiled), [OP.i32_ne],
        [OP.if_, OP.void_],
          [OP.local_get, L_ADDR, OP.i32_const, 0x0C, OP.i32_shr_u, OP.i32_const, 0x01],
          [OP.i32_store8, 0x00], leb(p.invalidCode),
        [OP.end],
      [OP.end]
    );
  }

  // ---- JUMP_TO IN-MODULE (2026-10-03) ----
  // Every _OUT exit (JAL / J / JR to another page, a register jump) stored the target in
  // jump_to_address and called the core's jump_to_func through the table — ~15k calls in a
  // heavy MK64 field, jump_to_func + update_invalid_addr 4.2% of the field in a profile. The
  // common case is a few loads, so the module does it itself, in one helper (type (i32)->(),
  // the target): for a KSEG0/KSEG1 target with skip_jump clear it runs update_invalid_addr's
  // two mirror lines, and when the page is valid sets actual = blocks[page] and
  // PC = actual->block + ((addr - actual->start) >> 2) — exactly the statements of
  // jump_to_func (cached_interp.c) on that path, in the same order. Everything else (skip_jump
  // set, a TLB-mapped target, a page to (re)initialise) calls jump_to_func as before, which
  // repeats the mirror lines harmlessly (they are idempotent) and does the rest. Needs &actual
  // (p.actualPtr, a core that stamps 'N64L'); without it the exits call jump_to_func.
  var JT_FN = -1;            // the helper's function index in the module being compiled, -1 = none
  function jtHelper(p) {
    var slow = [].concat(storeI32(p.jumpToAddr, [OP.local_get, 0x00]),
      [OP.i32_const], sleb(p.jumpToFunc), [OP.call_indirect, 0x00, 0x00], [OP.return_]);
    var pg = [OP.local_get, 0x00, OP.i32_const, 0x0C, OP.i32_shr_u];
    var pgX = [OP.local_get, 0x00, OP.i32_const].concat(sleb(0x20000000), [OP.i32_xor, OP.i32_const, 0x0C, OP.i32_shr_u]);
    return [0x01, 0x01, 0x7F].concat(
      loadI32(p.skipJump),
      [OP.local_get, 0x00, OP.i32_const], sleb(0x80000000 | 0), [OP.i32_sub, OP.i32_const], sleb(0x40000000), [OP.i32_ge_u, OP.i32_or],
      [OP.if_, OP.void_], slow, [OP.end],
      pg, [OP.i32_load8_u, 0x00], leb(p.invalidCode), [OP.if_, OP.void_], pgX, [OP.i32_const, 0x01, OP.i32_store8, 0x00], leb(p.invalidCode), [OP.end],
      pgX, [OP.i32_load8_u, 0x00], leb(p.invalidCode), [OP.if_, OP.void_], pg, [OP.i32_const, 0x01, OP.i32_store8, 0x00], leb(p.invalidCode), [OP.end],
      pg, [OP.i32_load8_u, 0x00], leb(p.invalidCode), [OP.if_, OP.void_], slow, [OP.end],
      storeI32(p.actualPtr, [].concat(pg, [OP.i32_const, 0x02, OP.i32_shl, OP.i32_load, 0x02], leb(p.blocksBase), [OP.local_tee, 0x01])),
      storeI32(p.pcGlobal, [].concat(
        [OP.local_get, 0x01, OP.i32_load, 0x02, 0x00],
        [OP.local_get, 0x00, OP.local_get, 0x01, OP.i32_load, 0x02, 0x04, OP.i32_sub, OP.i32_const, 0x02, OP.i32_shr_u],
        [OP.i32_const], sleb(p.stride), [OP.i32_mul, OP.i32_add])),
      [OP.end]);
  }
  // the bytes that do jump_to(target) at an _OUT exit: targetBytes push the i32 target
  function jumpToBytes(p, targetBytes) {
    if (JT_FN >= 0) return targetBytes.concat([OP.call], leb(JT_FN));
    return storeI32(p.jumpToAddr, targetBytes).concat([OP.i32_const], sleb(p.jumpToFunc), [OP.call_indirect, 0x00, 0x00]);
  }

  // the helper's body (one i32 param: the address): CHECK_MEMORY past invalid_code[a>>12] == 0
  var CHK_FN = 0;            // its function index in the module being compiled
  function chkHelper(p) {
    return [0x00].concat(
      [OP.local_get, 0x00, OP.i32_const, 0x0C, OP.i32_shr_u, OP.i32_const, 0x02, OP.i32_shl],
      [OP.i32_load, 0x02], leb(p.blocksBase),
      [OP.i32_load, 0x02, 0x00],
      [OP.local_get, 0x00, OP.i32_const], sleb(0xFFF), [OP.i32_and, OP.i32_const, 0x02, OP.i32_shr_u, OP.i32_const], sleb(p.stride), [OP.i32_mul, OP.i32_add],
      [OP.i32_load, 0x02, 0x00],
      [OP.i32_const], sleb(p.notCompiled), [OP.i32_ne],
      [OP.if_, OP.void_],
        [OP.local_get, 0x00, OP.i32_const, 0x0C, OP.i32_shr_u, OP.i32_const, 0x01],
        [OP.i32_store8, 0x00], leb(p.invalidCode),
      [OP.end],
      [OP.end]);
  }

  // SW/SB/SH: fast path writes the host-endian u32 dram array with the
  // mask-merge write_rdram_dram performs (SW mask ~0 = plain store), then
  // mirrors CHECK_MEMORY (cached_interp.c): if (!invalid_code[a>>12]) and
  // the page block instr at (a&0xFFF)/4 has ops != NOTCOMPILED, mark the
  // page invalid. blocks[x] is only dereferenced when invalid_code[x]==0,
  // exactly like the interpreter (a page with no block has invalid_code 1).
  function emitStore(word, instrPtr, p, C, opsIdx, exitDepth, slow) {
    var op = (word >>> 26) & 0x3F;
    if (op !== 0x28 && op !== 0x29 && op !== 0x2B && op !== 0x3F) return null;
    var rs = (word >>> 21) & 0x1F, rt = (word >>> 16) & 0x1F;
    var imm = sext16(word & 0xFFFF);
    var tableBase, cmpVal;
    if (op === 0x2B) { tableBase = p.writememW; cmpVal = p.wrRdram; }
    else if (op === 0x28) { tableBase = p.writememB; cmpVal = p.wrRdramB; }
    else if (op === 0x29) { tableBase = p.writememH; cmpVal = p.wrRdramH; }
    else { tableBase = p.writememD; cmpVal = p.wrRdramD; }                 // SD (wave 9)
    // JOIN CONTRACT (fixed 2026-08-29 — this was a latent divergence).
    // Unlike the CU1 guard, a store's slow arm CONTINUES in-block (it exits
    // only if the interp op diverged PC), so the two arms JOIN. The address
    // read (rs) and the value read (rt) must therefore both be emitted
    // OUTSIDE the if/else: previously `C.read(rt)` was called while building
    // the fast-arm bytes, which (a) marked rt loaded in the compile-state
    // while emitting its load prologue only on the fast path — so on the SLOW
    // path local L_REG0+rt stayed at wasm's zero-init and a later in-block
    // read of rt saw 0 — and (b) for the rs==rt case made `C.read(rs)` at the
    // top a bare local.get of that same not-yet-initialised local, computing
    // the effective address from 0. `ensure(rt)` hoists the load to the top,
    // and rs is now read BEFORE rt in emit-call order so it owns the prologue.
    var addrBytes = effAddr(C, rs, imm);    // leaves the address on the stack for tblCheck
    var rtPre = C.ensure(rt);
    var shiftB = [OP.local_get, L_ADDR, OP.i32_const, 0x03, OP.i32_and, OP.i32_const, 0x03, OP.i32_xor, OP.i32_const, 0x03, OP.i32_shl];
    var shiftH = [OP.local_get, L_ADDR, OP.i32_const, 0x02, OP.i32_and, OP.i32_const, 0x02, OP.i32_xor, OP.i32_const, 0x03, OP.i32_shl];
    // dram word address bytes (push i32 address of the containing word)
    var wordAddr = [OP.local_get, L_ADDR, OP.i32_const].concat(sleb(0xFFFFFC), [OP.i32_and]);
    var word4Addr = [OP.local_get, L_ADDR, OP.i32_const, 0x04, OP.i32_add, OP.i32_const].concat(sleb(0xFFFFFC), [OP.i32_and]);
    var storeBytes;
    if (op === 0x2B) {
      // SW: dram[word] = (u32)reg[rt]
      storeBytes = wordAddr.concat(C.read(rt), [OP.i32_wrap_i64], [OP.i32_store, 0x02], leb(p.dramBase));
    } else if (op === 0x3F) {
      // SD (wave 9): writed() splits the doubleword HIGH-word-first —
      // write_word(a+0, (u32)(v>>32)); write_word(a+4, (u32)v) — each with
      // mask ~0, so no read-modify-write (m64p_memory.c:170-181). Identical
      // shape to SDC1 below. CHECK_MEMORY still tests only the page of `a`:
      // the interpreter's CHECK_MEMORY() reads the GLOBAL `address`, which
      // writed()'s own parameter shadows, so it is never advanced to a+4.
      storeBytes = [].concat(
        wordAddr, C.read(rt), [OP.i64_const], sleb(32), [OP.i64_shr_u, OP.i32_wrap_i64], [OP.i32_store, 0x02], leb(p.dramBase),
        word4Addr, C.read(rt), [OP.i32_wrap_i64], [OP.i32_store, 0x02], leb(p.dramBase));
    } else {
      var isByte = (op === 0x28);
      var maskC = isByte ? 0xFF : 0xFFFF;
      var sh = isByte ? shiftB : shiftH;
      // w = dram[word]; merged = (w & ~(mask<<s)) | (((u32)rt & mask) << s)
      storeBytes = [].concat(
        wordAddr,
        wordAddr, [OP.i32_load, 0x02], leb(p.dramBase),
        // (w & ~(mask<<s))
        [OP.i32_const], sleb(maskC), sh, [OP.i32_shl, OP.i32_const], sleb(-1), [OP.i32_xor, OP.i32_and],
        // ((rt & mask) << s)
        C.read(rt), [OP.i32_wrap_i64, OP.i32_const], sleb(maskC), [OP.i32_and], sh, [OP.i32_shl],
        [OP.i32_or],
        [OP.i32_store, 0x02], leb(p.dramBase)
      );
    }
    var checkMemory = checkMemoryBytes(p);
    if (COLD) {
      // LEAN CODE: as emitLoad — `if (table != rdram) cold; fast` (the cold arm never continues)
      return [].concat(
        addrBytes, rtPre, tblCheck(tableBase, cmpVal),
        [OP.if_, OP.void_],
          bump((slow ? 'SLOTSLOW:' : 'SLOW:') + mnem(word)),
          slowArm(p, C, instrPtr, opsIdx, exitDepth + 1, slow, -1, undefined, true),
        [OP.end],
        storeBytes,
        checkMemory);
    }
    return [].concat(
      addrBytes, rtPre, tblCheck(tableBase, cmpVal, true),
      [OP.if_, OP.void_],
        storeBytes,
        checkMemory,
      [OP.else_],
        bump((slow ? 'SLOTSLOW:' : 'SLOW:') + mnem(word)),
        // continue-after-fallback: store ops write no guest registers, so
        // both arms join with the cache untouched; snapshot-flush keeps
        // memory current for the interp op (it reads rs/rt from reg[])
        slowArm(p, C, instrPtr, opsIdx, exitDepth + 1, slow, -1, undefined, true),
      [OP.end]
    );
  }

  // ---- COP1 (wave 6) ----
  // Every COP1 op is wrapped in the CU1 guard (Status bit 0x20000000): when
  // clear, the interpreter op raises the coprocessor-unusable exception
  // (Cause/EPC handled there) and PC always diverges — so the guard's else
  // arm is snapshot-flush + interp call + unconditional exit. Pointer-bank
  // indirection is performed at RUNTIME (reg_cop1_simple/double[i] loads),
  // which makes Status.FR bank flips automatically correct.
  // `preFlush` MUST be the caller's C.flushSnapshot() captured BEFORE it built
  // nativeBytes (fixed 2026-08-29). MFC1/DMFC1 end their native arm with
  // C.writeFromStack(rt), which marks rt DIRTY; calling flushSnapshot() here
  // would then emit, on the CU1-CLEAR arm, a store of a wasm local that is
  // only assigned on the CU1-SET arm — writing zero over the guest register
  // and only then handing control to the interpreter. flushSnapshot() does not
  // mutate compile-state, so capturing it early is free and always safe.
  function cuGuard(p, C, nativeBytes, instrPtr, opsIdx, exitDepth, word, slow, preFlush) {
    if (COLD) {
      return [].concat(
        loadI32(p.cp0Status), [OP.i32_const], sleb(0x20000000), [OP.i32_and],
        [OP.if_, OP.void_],
          nativeBytes,
        [OP.else_],
          coldJump([].concat(
            bump((slow ? 'SLOTCU1MISS:' : 'CU1MISS:') + mnem(word)),
            storeI32Const(p.pcGlobal, slow ? slow.ptr : instrPtr),
            [OP.i32_const], sleb(slow ? slow.opsIdx : opsIdx), [OP.call_indirect, 0x00, 0x00]), exitDepth + 1, preFlush.regs),
        [OP.end]
      );
    }
    return [].concat(
      loadI32(p.cp0Status), [OP.i32_const], sleb(0x20000000), [OP.i32_and],
      [OP.if_, OP.void_],
        nativeBytes,
      [OP.else_],
        bump((slow ? 'SLOTCU1MISS:' : 'CU1MISS:') + mnem(word)),
        preFlush,
        // in a delay slot the coprocessor-unusable exception needs delay_slot
        // set, which only the interpreter does — hand back the whole branch
        storeI32Const(p.pcGlobal, slow ? slow.ptr : instrPtr),
        [OP.i32_const], sleb(slow ? slow.opsIdx : opsIdx), [OP.call_indirect, 0x00, 0x00],
        [OP.br].concat(leb(exitDepth + 1 + RAW)),
      [OP.end]
    );
  }
  // push the float*/double* for FPR index i from the live bank
  function fprPtr(bank, i) { return [OP.i32_const, 0x00, OP.i32_load, 0x02].concat(leb(bank + i * 4)); }

  // wave 11b: FCR31's address arrives as jit_params[43], gated by the version
  // magic at [44] (recomp.c). Unlike wave 10a's g_cp0_regs there is NO layout
  // identity to assert against another param — FCR31 sits ~6.8MB from
  // reg_cop1_simple in a different section — so the ONLY protection against a
  // page/core version skew is that magic plus this shape check. Emitting a
  // store to a guessed address would silently corrupt guest memory instead of
  // falling back, which is the failure this refuses.
  function fcr31Ok(p) { return !!p.fcr31 && (p.fcr31 & 3) === 0; }

  // ---- COP1 converts (wave 11a) ----
  //
  // These are emitted from the SHIPPED dist binary's own lowering, not from a
  // reading of the C. That distinction matters because fpu.h's casts are C
  // UNDEFINED BEHAVIOUR out of range, so only the compiled artifact defines
  // the answer (n64/docs/jit/TASKS.md asked for exactly this determination
  // before any convert emitter was written).
  //
  // Ground truth, by disassembling n64/N64Wasm/dist/n64wasm.wasm (wasm2wat):
  //
  //  * The build has NO nontrapping-fptoint: `i32.trunc_sat_*` / `i64.trunc_sat_*`
  //    occur ZERO times in the whole 2.6 MB module, while the trapping
  //    `i32.trunc_f32_s` occurs 128 times. So every float->int cast is the
  //    TRAPPING opcode, and LLVM must guard it.
  //  * The guard LLVM emitted is identical in every one of these ops
  //    (func 2548 = TRUNC.W.S, 2539 = FLOOR.W.S, 2544 = CEIL.W.S,
  //     2547 = TRUNC.W.D, 2545 = TRUNC.L.D, 2546 = TRUNC.L.S):
  //        r = <round>(x); if (|r| < 2^31)  dest = (i32)r;  else dest = INT32_MIN
  //    (2^63 / INT64_MIN for the .L forms). NaN takes the else arm, because
  //    abs(NaN) < k is false — so NaN converts to INT_MIN here, NOT to 0 as
  //    a saturating conversion would give. Reproduced EXACTLY below.
  //  * `set_rounding()` (fpu.h:63-83) IS INERT in this build. In CVT.S.W
  //    (func 2563), CVT.S.L (2561), CVT.D.L (2558) and CVT.S.D (2564) it
  //    compiles to a load of FCR31, a table index, and then a literal `drop`
  //    — wasm has no dynamic rounding mode, so fesetround() cannot affect the
  //    result. Every int->float / float->float convert is therefore plain
  //    round-to-nearest-even and needs no FCR31 access at all.
  //
  // DELIBERATELY NOT EMITTED HERE, and each for a specific reason:
  //  * ROUND.W/L.* — lowers to `call 700` (roundf). C round() is half-AWAY-
  //    from-zero; wasm f32.nearest is half-to-EVEN. They differ at .5, so
  //    f32.nearest would NOT be bit-exact.
  //  * CVT.W.* / CVT.L.* — dispatch on FCR31&3 (funcs 2554-2557).
  //  * C.cond.* and BC1* — read/write FCR31 bit 23 (0x800000).
  //    All three need FCR31's ADDRESS, which is not in the jit_params block
  //    (recomp.c:2500-2542 ends at index 42) and is not derivable from any
  //    param that is: FCR31 lives at 63865504 in the shipped binary while
  //    reg_cop1_simple is at 70682880 — different sections, ~6.8 MB apart,
  //    so there is no wave-10a-style layout identity to assert. Adding
  //    jit_params[43] = &FCR31 is a ONE-LINE core change, but the core cannot
  //    currently be rebuilt (the vendored emsdk now reports 6.0.2 and
  //    CLAUDE.md records that libretronew.c no longer compiles under it), and
  //    guessing the address would silently corrupt FCR31 rather than fall
  //    back. So this half of wave 11 is BLOCKED ON THE TOOLCHAIN, not on the
  //    emitter, and is left falling back.
  //
  // banks: 'W' results are int32 written through reg_cop1_simple[fd]; 'L'
  // results are int64 written through reg_cop1_double[fd] (verified in the
  // disassembly above — TRUNC.W.D stores via 70682880 and loads via 70683008).
  var CVT_ROUND = {  // fn -> [wasm round op for S, for D], dest is 32-bit?
    0x09: ['trunc', false], 0x0A: ['ceil', false], 0x0B: ['floor', false],  // TRUNC/CEIL/FLOOR .L
    0x0D: ['trunc', true],  0x0E: ['ceil', true],  0x0F: ['floor', true],   // TRUNC/CEIL/FLOOR .W
  };
  function roundToIntNat(p, srcIsS, dstIsW, roundName, fs, fd) {
    var srcBank = srcIsS ? p.cp1Simple : p.cp1Double;
    var dstBank = dstIsW ? p.cp1Simple : p.cp1Double;
    var ld = srcIsS ? [OP.f32_load, 0x02, 0x00] : [OP.f64_load, 0x03, 0x00];
    var tee = srcIsS ? L_F32 : L_F64;
    var roundOp = OP[(srcIsS ? 'f32_' : 'f64_') + roundName];
    var absOp = srcIsS ? OP.f32_abs : OP.f64_abs;
    var ltOp = srcIsS ? OP.f32_lt : OP.f64_lt;
    var bound = dstIsW ? 2147483648 : 9223372036854775808;
    var boundBytes = srcIsS ? [OP.f32_const].concat(f32Bytes(bound)) : [OP.f64_const].concat(f64Bytes(bound));
    var cvtOp = srcIsS ? (dstIsW ? OP.i32_trunc_f32_s : OP.i64_trunc_f32_s)
                       : (dstIsW ? OP.i32_trunc_f64_s : OP.i64_trunc_f64_s);
    var minBytes = dstIsW ? [OP.i32_const].concat(sleb(-2147483648))
                          : [OP.i64_const].concat(sleb64(-9223372036854775808n));
    var st = dstIsW ? [OP.i32_store, 0x02, 0x00] : [OP.i64_store, 0x03, 0x00];
    return [].concat(
      fprPtr(dstBank, fd),
      fprPtr(srcBank, fs), ld,
      [roundOp, OP.local_tee], leb(tee),
      [absOp], boundBytes, [ltOp],
      [OP.if_, dstIsW ? VT.i32 : VT.i64],
        [OP.local_get].concat(leb(tee), [cvtOp]),
      [OP.else_],
        minBytes,
      [OP.end],
      st);
  }
  // ROUND.* and CVT.W/L.* (2026-09-30). fpu.h round_w_s is
  // `(int32_t) roundf(x)` — half AWAY from zero, which the shipped binary
  // reaches through a libc call — so f32.nearest (half to EVEN) is NOT it.
  // Exact replacement, valid for every input:
  //     t = trunc(x);  r = (|x - t| >= 0.5) ? t + copysign(1, x) : t
  // x - t is exact (it is x's own fractional bits), and t + +-1 is exact
  // because a nonzero fraction implies |t| < 2^23 (2^52 for doubles).
  // NaN: x - t is NaN, the test is false, r = NaN; +-inf: inf - inf = NaN,
  // r = inf. Both then take the guard's INT_MIN arm, exactly as
  // roundToIntNat's trunc/ceil/floor do (same LLVM guard in the binary).
  // CVT.* selects trunc/ceil/floor/round from FCR31&3 at RUN TIME, like
  // cvt_w_s; the store/guard tail is shared with roundToIntNat.
  function roundModeNat(p, srcIsS, dstIsW, fs, fd, byFcr31) {
    var P = srcIsS ? 'f32_' : 'f64_';
    var FT = srcIsS ? VT.f32 : VT.f64;
    var srcBank = srcIsS ? p.cp1Simple : p.cp1Double;
    var dstBank = dstIsW ? p.cp1Simple : p.cp1Double;
    var ld = srcIsS ? [OP.f32_load, 0x02, 0x00] : [OP.f64_load, 0x03, 0x00];
    var X = srcIsS ? L_F32 : L_F64, T = srcIsS ? L_F32B : L_F64B;
    var half = srcIsS ? [OP.f32_const].concat(f32Bytes(0.5)) : [OP.f64_const].concat(f64Bytes(0.5));
    var one = srcIsS ? [OP.f32_const].concat(f32Bytes(1)) : [OP.f64_const].concat(f64Bytes(1));
    var COPYSIGN = srcIsS ? 0x98 : 0xA6;
    var roundAway = [].concat(
      [OP.local_get], leb(X), [OP[P + 'trunc'], OP.local_set], leb(T),
      [OP.local_get], leb(X), [OP.local_get], leb(T), [OP[P + 'sub'], OP[P + 'abs']], half, [OP[P + 'ge']],
      [OP.if_, FT],
        [OP.local_get], leb(T), one, [OP.local_get], leb(X), [COPYSIGN, OP[P + 'add']],
      [OP.else_],
        [OP.local_get], leb(T),
      [OP.end]);
    var rnd;
    if (!byFcr31) rnd = roundAway;
    else {
      var mode = loadI32(p.fcr31).concat([OP.i32_const, 0x03, OP.i32_and, OP.local_set, L_WORD]);
      var op1 = function (o) { return [OP.local_get].concat(leb(X), [OP[P + o]]); };
      rnd = [].concat(mode,
        [OP.local_get, L_WORD, OP.i32_eqz, OP.if_, FT],
          roundAway,
        [OP.else_],
          [OP.local_get, L_WORD, OP.i32_const, 0x01, OP.i32_eq, OP.if_, FT],
            op1('trunc'),
          [OP.else_],
            [OP.local_get, L_WORD, OP.i32_const, 0x02, OP.i32_eq, OP.if_, FT],
              op1('ceil'),
            [OP.else_],
              op1('floor'),
            [OP.end],
          [OP.end],
        [OP.end]);
    }
    var bound = dstIsW ? 2147483648 : 9223372036854775808;
    var boundBytes = srcIsS ? [OP.f32_const].concat(f32Bytes(bound)) : [OP.f64_const].concat(f64Bytes(bound));
    var cvtOp = srcIsS ? (dstIsW ? OP.i32_trunc_f32_s : OP.i64_trunc_f32_s)
                       : (dstIsW ? OP.i32_trunc_f64_s : OP.i64_trunc_f64_s);
    var minBytes = dstIsW ? [OP.i32_const].concat(sleb(-2147483648))
                          : [OP.i64_const].concat(sleb64(-9223372036854775808n));
    var st = dstIsW ? [OP.i32_store, 0x02, 0x00] : [OP.i64_store, 0x03, 0x00];
    return [].concat(
      fprPtr(srcBank, fs), ld, [OP.local_set], leb(X),
      fprPtr(dstBank, fd),
      rnd, [OP.local_tee], leb(X),
      [OP[P + 'abs']], boundBytes, [OP[P + 'lt']],
      [OP.if_, dstIsW ? VT.i32 : VT.i64],
        [OP.local_get].concat(leb(X), [cvtOp]),
      [OP.else_],
        minBytes,
      [OP.end],
      st);
  }

  // plain converts: no rounding mode is observable (see the set_rounding note)
  function plainCvtNat(p, sub, fn, fs, fd) {
    var S = 0x10, D = 0x11, W = 0x14, L = 0x15;
    var srcBank, ld, conv, dstBank, st;
    if (sub === S && fn === 0x21) {        // CVT.D.S  (func 2560)
      srcBank = p.cp1Simple; ld = [OP.f32_load, 0x02, 0x00]; conv = OP.f64_promote_f32;
      dstBank = p.cp1Double; st = [OP.f64_store, 0x03, 0x00];
    } else if (sub === D && fn === 0x20) { // CVT.S.D  (func 2564)
      srcBank = p.cp1Double; ld = [OP.f64_load, 0x03, 0x00]; conv = OP.f32_demote_f64;
      dstBank = p.cp1Simple; st = [OP.f32_store, 0x02, 0x00];
    } else if (sub === W && fn === 0x20) { // CVT.S.W  (func 2563)
      srcBank = p.cp1Simple; ld = [OP.i32_load, 0x02, 0x00]; conv = OP.f32_convert_i32_s;
      dstBank = p.cp1Simple; st = [OP.f32_store, 0x02, 0x00];
    } else if (sub === W && fn === 0x21) { // CVT.D.W  (func 2559)
      srcBank = p.cp1Simple; ld = [OP.i32_load, 0x02, 0x00]; conv = OP.f64_convert_i32_s;
      dstBank = p.cp1Double; st = [OP.f64_store, 0x03, 0x00];
    } else if (sub === L && fn === 0x20) { // CVT.S.L  (func 2561)
      srcBank = p.cp1Double; ld = [OP.i64_load, 0x03, 0x00]; conv = OP.f32_convert_i64_s;
      dstBank = p.cp1Simple; st = [OP.f32_store, 0x02, 0x00];
    } else if (sub === L && fn === 0x21) { // CVT.D.L  (func 2558)
      srcBank = p.cp1Double; ld = [OP.i64_load, 0x03, 0x00]; conv = OP.f64_convert_i64_s;
      dstBank = p.cp1Double; st = [OP.f64_store, 0x03, 0x00];
    } else return null;
    return [].concat(fprPtr(dstBank, fd), fprPtr(srcBank, fs), ld, [conv], st);
  }

  // ---- COP1 compares (wave 11b) ----
  //
  // C.cond.fmt is `FCR31 = (FCR31 & ~0x800000) | (predicate << 23)`, and the
  // 16 predicates differ ONLY in NaN handling. fpu.h:222-388 gives the
  // FCR31 result for each, and wasm's float relations already match it for
  // 12 of the 16: a wasm compare is false whenever either operand is NaN,
  // which is exactly what fpu.h's isnan-clear and its no-isnan-check forms
  // both produce. The four `u`-prefixed forms SET the bit on NaN, and are
  // built here without a second compare of the same pair:
  //     ult(s,t) == !(s >= t)     ule(s,t) == !(s > t)
  // (NaN makes ge/gt false, so the negation is true — and for ordered
  // operands the negation is the ordinary <, <=.) `un` and `ueq` genuinely
  // need both operands twice, which is why L_F32B/L_F64B exist.
  //
  // ⚠ THE HALF fpu.h DOES NOT SHOW, and it changed this wave's plan. The
  // dispatched instruction is NOT just the fpu.h helper: for the eight
  // SIGNALLING predicates — SF NGLE SEQ NGL LT NGE LE NGT, fn 0x38-0x3F —
  // mips_instructions.def:1300-1390 wraps the helper in
  //     if (isnan(fs) || isnan(ft)) { DebugMessage(...); stop = 1; }
  // `stop` is the global that ends emulation (r4300.c:53,147-166). The FCR31
  // result is identical either way, so a "plain wasm" emitter would look
  // bit-exact on every architectural checksum and still fail to halt where
  // the interpreter halts. n64/docs/jit/TASKS.md called these predicates
  // "exactly emittable with plain wasm" reading fpu.h alone; they are not.
  // So 0x38-0x3F carry a NaN pre-test that hands the instruction back to the
  // interpreter (which then does the message, `stop`, and the compare). The
  // non-signalling eight, fn 0x30-0x37, have no such wrapper and need no
  // guard. This is the wave-11a lesson again: read the dispatched code.
  var CMP_SIGNALLING = 0x38;   // fn >= this => the isnan/stop wrapper applies
  // predicate -> i32 0/1, given both operands already in locals a/b
  function cmpPredicate(isS, cond, a, b) {
    var O = isS ? 'f32_' : 'f64_';
    var A = [OP.local_get].concat(leb(a)), B = [OP.local_get].concat(leb(b));
    var nanA = A.concat(A, [OP[O + 'ne']]);          // s != s
    var nanB = B.concat(B, [OP[O + 'ne']]);          // t != t
    var rel = function (o) { return A.concat(B, [OP[O + o]]); };
    switch (cond) {
      case 0x0: case 0x8: case 0x9: return [OP.i32_const, 0x00];  // F / SF / NGLE: always clear
      case 0x1: return nanA.concat(nanB, [OP.i32_or]);            // UN
      case 0x2: case 0xA: case 0xB: return rel('eq');             // EQ / SEQ / NGL
      case 0x3: return nanA.concat(nanB, [OP.i32_or], rel('eq'), [OP.i32_or]); // UEQ
      case 0x4: case 0xC: case 0xD: return rel('lt');             // OLT / LT / NGE
      case 0x5: return rel('ge').concat([OP.i32_eqz]);            // ULT == !(s >= t)
      case 0x6: case 0xE: case 0xF: return rel('le');             // OLE / LE / NGT
      case 0x7: return rel('gt').concat([OP.i32_eqz]);            // ULE == !(s > t)
      default: return null;
    }
  }
  // `bailBytes` runs the interpreter op and exits; it is only reachable on the
  // signalling predicates with a NaN operand.
  function compareNat(p, isS, fn, fs, ft, bailBytes) {
    var cond = fn & 0x0F;
    var bank = isS ? p.cp1Simple : p.cp1Double;
    var ld = isS ? [OP.f32_load, 0x02, 0x00] : [OP.f64_load, 0x03, 0x00];
    var a = isS ? L_F32 : L_F64, b = isS ? L_F32B : L_F64B;
    var pred = cmpPredicate(isS, cond, a, b);
    if (pred === null) return null;
    // C.F.* takes no operands at all (fpu.h:221-224 c_f_s()) and has no
    // signalling wrapper, so it loads nothing.
    var needOperands = (cond !== 0x0) || (fn >= CMP_SIGNALLING);
    var out = needOperands
      ? [].concat(fprPtr(bank, fs), ld, [OP.local_set], leb(a),
                  fprPtr(bank, ft), ld, [OP.local_set], leb(b))
      : [];
    if (fn >= CMP_SIGNALLING) {
      var A = [OP.local_get].concat(leb(a)), B = [OP.local_get].concat(leb(b));
      var ne = OP[(isS ? 'f32_' : 'f64_') + 'ne'];
      out = out.concat(
        A, A, [ne], B, B, [ne], [OP.i32_or],
        [OP.if_, OP.void_],
          bailBytes,
        [OP.end]);
    }
    // FCR31 = (FCR31 & ~FCR31_CMP_BIT) | (pred << 23)
    return out.concat(storeI32(p.fcr31,
      loadI32(p.fcr31).concat([OP.i32_const], sleb(~0x800000 | 0), [OP.i32_and],
        pred, [OP.i32_const], sleb(23), [OP.i32_shl], [OP.i32_or])));
  }

  function emitCop1(word, instrPtr, p, C, opsIdx, exitDepth, slow) {
    var op = (word >>> 26) & 0x3F;
    if (op !== 0x11) return null;
    // captured BEFORE `nat` is built — see the note on cuGuard
    var preFlush = C.flushSnapshot();
    var sub = (word >>> 21) & 0x1F;       // rs field: move/bc/fmt
    var rt = (word >>> 16) & 0x1F;        // GPR for moves; ft for arith
    var fs = (word >>> 11) & 0x1F;
    var fd = (word >>> 6) & 0x1F;
    var fn = word & 0x3F;
    var nat = null;
    // set when this op was emitted by the wave-11a convert path. Counted
    // separately in stats so a wave that silently emitted NOTHING new cannot
    // pass the gates looking green — the wave-10a `nativeCop0` lesson.
    var fpCvt = false;
    var fpCmp = false;
    if (sub === 0x00 || sub === 0x01) { // MFC1 / DMFC1
      // recomp.c RMFC1 (:1530-1537) / RDMFC1 (:1539-1546) end with
      // `if (dst->f.r.rt == reg) RNOP()`, so a move into r0 is a NOP — no GPR
      // write and, because RNOP replaces the op wholesale, NO CU1 CHECK
      // either. Emitting nothing (not even cuGuard) is therefore exact.
      if (rt === 0) return [];                                       // recomp.c RNOP
      nat = (sub === 0x00)
        ? fprPtr(p.cp1Simple, fs).concat([OP.i32_load, 0x02, 0x00], [OP.i64_extend_i32_s], C.writeFromStack(rt))
        : fprPtr(p.cp1Double, fs).concat([OP.i64_load, 0x03, 0x00], C.writeFromStack(rt));
    } else if (sub === 0x04) { // MTC1: *(i32*)simple[fs] = rt32 (RMTC1 :1558-1564 has NO r0 guard)
      nat = fprPtr(p.cp1Simple, fs).concat(C.read(rt), [OP.i32_wrap_i64], [OP.i32_store, 0x02, 0x00]);
    } else if (sub === 0x05) { // DMTC1 (RDMTC1 :1566-1572, likewise unguarded)
      nat = fprPtr(p.cp1Double, fs).concat(C.read(rt), [OP.i64_store, 0x03, 0x00]);
    } else if (sub === 0x10 || sub === 0x11) { // fmt S / D arithmetic
      var S = (sub === 0x10);
      var ldop = S ? [OP.f32_load, 0x02, 0x00] : [OP.f64_load, 0x03, 0x00];
      var stop = S ? [OP.f32_store, 0x02, 0x00] : [OP.f64_store, 0x03, 0x00];
      var bank = S ? p.cp1Simple : p.cp1Double;
      var binop = null, unop = null;
      switch (fn) {
        case 0x00: binop = S ? OP.f32_add : OP.f64_add; break;
        case 0x01: binop = S ? OP.f32_sub : OP.f64_sub; break;
        case 0x02: binop = S ? OP.f32_mul : OP.f64_mul; break;
        case 0x03: binop = S ? OP.f32_div : OP.f64_div; break;
        case 0x04: unop = S ? OP.f32_sqrt : OP.f64_sqrt; break;
        case 0x05: unop = S ? OP.f32_abs : OP.f64_abs; break;
        case 0x06: unop = -1; break; // MOV: pure copy
        case 0x07: unop = S ? OP.f32_neg : OP.f64_neg; break;
        default:
          // wave 11a: TRUNC/CEIL/FLOOR .W/.L and CVT.D.S / CVT.S.D.
          // ROUND.* (0x08/0x0C) and CVT.W/L.* (0x24/0x25) still fall back —
          // see the wave-11a note above. wave 11b adds the compares (0x30-0x3F).
          var rc = CVT_ROUND[fn];
          if (rc) { fpCvt = true; nat = roundToIntNat(p, S, rc[1], rc[0], fs, fd); break; }
          // 2026-09-30: ROUND.L/.W (0x08/0x0C) as an exact roundf/round, and
          // CVT.W/.L (0x24/0x25) as the FCR31&3 dispatch fpu.h performs
          // (cvt_w_s etc., fpu.h:180-219). CVT needs FCR31's address.
          if (fn === 0x08 || fn === 0x0C) { fpCvt = true; nat = roundModeNat(p, S, fn === 0x0C, fs, fd, false); break; }
          if ((fn === 0x24 || fn === 0x25) && fcr31Ok(p)) { fpCvt = true; nat = roundModeNat(p, S, fn === 0x24, fs, fd, true); break; }
          var pc1 = plainCvtNat(p, sub, fn, fs, fd);
          if (pc1) { fpCvt = true; nat = pc1; break; }
          if (fn >= 0x30 && fcr31Ok(p)) {
            // inside the CU1 guard's if-arm, and (for the signalling
            // predicates) inside the NaN pre-test's if-arm: two frames above
            // whatever depth the caller handed us.
            var cmpBail = [].concat(
              bump((slow ? 'SLOTCMPNAN:' : 'CMPNAN:') + mnem(word)),
              preFlush,
              storeI32Const(p.pcGlobal, slow ? slow.ptr : instrPtr),
              [OP.i32_const], sleb(slow ? slow.opsIdx : opsIdx), [OP.call_indirect, 0x00, 0x00],
              [OP.br].concat(leb(exitDepth + 2 + RAW)));
            var cm = compareNat(p, S, fn, fs, rt, cmpBail);
            if (cm) { fpCmp = true; nat = cm; break; }
          }
          return null;
      }
      if (nat === null) {
        // store sig: push fd ptr, compute value, store
        var valBytes;
        if (binop !== null) {
          valBytes = fprPtr(bank, fs).concat(ldop, fprPtr(bank, rt), ldop, [binop]);
        } else if (unop === -1) {
          valBytes = fprPtr(bank, fs).concat(ldop);
        } else {
          valBytes = fprPtr(bank, fs).concat(ldop, [unop]);
        }
        nat = fprPtr(bank, fd).concat(valBytes, stop);
      }
    } else if (sub === 0x14 || sub === 0x15) {
      // wave 11a: fmt W / L — CVT.S.W, CVT.D.W, CVT.S.L, CVT.D.L only
      // (every other W/L function code is RESERVED, pure_interp.c:601-621)
      nat = plainCvtNat(p, sub, fn, fs, fd);
      if (nat === null) return null;
      fpCvt = true;
    } else if (sub === 0x02 && fcr31Ok(p) && fs !== 0) {
      // CFC1 (2026-09-30), mips_instructions.def:760-771: after the CU1 check,
      // `if (rfs==31) rrt32 = SE32(FCR31)` — rrt32 is the LOW 32-bit half of
      // reg[rt] only, so the high half is PRESERVED — and any rfs other than
      // 0 and 31 writes nothing. RCFC1 (recomp.c:1549-1556) RNOPs rt == 0.
      // fs == 0 (FCR0) stays a fallback: its address is not in the block.
      if (rt === 0) return [];                                       // recomp.c RNOP
      if (fs === 31) {
        nat = C.read(rt).concat([OP.i64_const], sleb64(-4294967296n), [OP.i64_and],
          loadI32(p.fcr31), [OP.i64_extend_i32_u, OP.i64_or], C.writeFromStack(rt));
      } else nat = [];
    } else {
      return null; // BC1 branches, CTC1, CFC1 $0: fallback
    }
    if (fpCvt) stats.nativeFPCvt++;
    if (fpCmp) stats.nativeFPCmp++;
    return cuGuard(p, C, nat, instrPtr, opsIdx, exitDepth, word, slow, preFlush);
  }

  // LWC1/LDC1/SWC1/SDC1: CU1 guard outside, then the same live-dispatch-table
  // fast path as integer loads/stores; FPR access through the runtime banks.
  function emitCop1Mem(word, instrPtr, p, C, opsIdx, exitDepth, slow) {
    var op = (word >>> 26) & 0x3F;
    if (op !== 0x31 && op !== 0x35 && op !== 0x39 && op !== 0x3D) return null;
    // captured BEFORE `nat` is built — see the note on cuGuard
    var preFlush = C.flushSnapshot();
    var base = (word >>> 21) & 0x1F, ft = (word >>> 16) & 0x1F;
    var imm = sext16(word & 0xFFFF);
    var ea = effAddr(C, base, imm);          // leaves the address on the stack for tblCheck
    var wordOff = [OP.local_get, L_ADDR, OP.i32_const].concat(sleb(0xFFFFFC), [OP.i32_and]);
    var word4Off = [OP.local_get, L_ADDR, OP.i32_const, 0x04, OP.i32_add, OP.i32_const].concat(sleb(0xFFFFFC), [OP.i32_and]);
    var fast, tableBase, cmpVal;
    if (op === 0x31) {        // LWC1: *(u32*)simple[ft] = dram word
      tableBase = p.readmemW; cmpVal = p.rdRdram;
      fast = fprPtr(p.cp1Simple, ft).concat(wordOff, [OP.i32_load, 0x02], leb(p.dramBase), [OP.i32_store, 0x02, 0x00]);
    } else if (op === 0x35) { // LDC1: *(u64*)double[ft] = (w0<<32)|w1
      tableBase = p.readmemD; cmpVal = p.rdRdramD;
      fast = fprPtr(p.cp1Double, ft).concat(
        wordOff, [OP.i32_load, 0x02], leb(p.dramBase), [OP.i64_extend_i32_u, OP.i64_const], sleb(32), [OP.i64_shl],
        word4Off, [OP.i32_load, 0x02], leb(p.dramBase), [OP.i64_extend_i32_u],
        [OP.i64_or, OP.i64_store, 0x03, 0x00]);
    } else if (op === 0x39) { // SWC1: dram word = *(u32*)simple[ft]; CHECK_MEMORY
      tableBase = p.writememW; cmpVal = p.wrRdram;
      fast = wordOff.concat(fprPtr(p.cp1Simple, ft), [OP.i32_load, 0x02, 0x00], [OP.i32_store, 0x02], leb(p.dramBase), checkMemoryBytes(p));
    } else {                  // SDC1: dram[a]=hi32(v), dram[a+4]=lo32(v); CHECK_MEMORY
      tableBase = p.writememD; cmpVal = p.wrRdramD;
      fast = [].concat(
        fprPtr(p.cp1Double, ft), [OP.i64_load, 0x03, 0x00, OP.local_set], leb(L_I64S),
        wordOff, [OP.local_get].concat(leb(L_I64S), [OP.i64_const], sleb(32), [OP.i64_shr_u, OP.i32_wrap_i64]), [OP.i32_store, 0x02], leb(p.dramBase),
        word4Off, [OP.local_get].concat(leb(L_I64S), [OP.i32_wrap_i64]), [OP.i32_store, 0x02], leb(p.dramBase),
        checkMemoryBytes(p));
    }
    var nat = COLD
      // LEAN CODE: as emitLoad — `if (table != rdram) cold; fast` (the cold arm never continues)
      ? [].concat(
          ea, tblCheck(tableBase, cmpVal),
          [OP.if_, OP.void_],
            bump((slow ? 'SLOTSLOW:' : 'SLOW:') + mnem(word)),
            slowArm(p, C, instrPtr, opsIdx, exitDepth + 2, slow, -1, undefined, op === 0x39 || op === 0x3D), // inside cu-if + this if
          [OP.end],
          fast)
      : [].concat(
      ea, tblCheck(tableBase, cmpVal, true),
      [OP.if_, OP.void_],
        fast,
      [OP.else_],
        bump((slow ? 'SLOTSLOW:' : 'SLOW:') + mnem(word)),
        slowArm(p, C, instrPtr, opsIdx, exitDepth + 2, slow, -1, undefined, op === 0x39 || op === 0x3D), // inside cu-if + this if; SWC1/SDC1 hand back (see slowArm)
      [OP.end]
    );
    return cuGuard(p, C, nat, instrPtr, opsIdx, exitDepth, word, slow, preFlush);
  }

  // ---- COP0 (wave 10a) ----
  // MFC0 is exactly `rrt = SE32(g_cp0_regs[rd])` for every rd EXCEPT RANDOM
  // (1) and COUNT (9), which call cp0_update_count() first
  // (mips_instructions.def:618-634). There is no coprocessor-usable check on
  // this path, so MFC0 cannot fault and needs no delay-slot bail arm.
  //
  // MTC0 is deliberately NOT emitted. It is not the symmetric write: Count,
  // Compare and Status run event-queue surgery, an FR-bit FPR shuffle and an
  // inline interrupt poll (:636-735). The runtime census says that is exactly
  // where the traffic is -- MTC0.12 (Status) is 22-28% of all remaining
  // fallbacks on pkmnsnap/flyingDragon -- so a native "inert registers only"
  // MTC0 would buy nearly nothing while adding a side-effect surface.
  //
  // g_cp0_regs' base is not in the param block, but two of its elements are:
  // p.count is &g_cp0_regs[CP0_COUNT_REG] (index 9) and p.cp0Status is
  // &g_cp0_regs[CP0_STATUS_REG] (index 12), both uint32_t (cp0_private.h:27,
  // cp0.h:104-132; recomp.c:2514,2536). Their byte difference is therefore
  // exactly 12, and that identity is ASSERTED at emit time -- if the core's
  // layout ever changes, this returns null and the op falls back rather than
  // computing an address from a stale assumption.
  function emitCop0(word, p, C) {
    if (((word >>> 26) & 0x3F) !== 0x10) return null;
    if (((word >>> 21) & 0x1F) !== 0x00) return null;      // MFC0 only (rs field)
    var rt = (word >>> 16) & 0x1F, rd = (word >>> 11) & 0x1F;
    // recomp.c RMFC0 (:818-824) ends `if (dst->f.r.rt == reg) RNOP()`, and the
    // guard is applied AFTER rd is rebound to g_cp0_regs — so it fires for
    // every rd, RANDOM and COUNT included.
    if (rt === 0) return [];                               // recomp.c RNOP
    if (rd === 1 || rd === 9) return null;                 // RANDOM / COUNT: cp0_update_count() first
    if ((p.cp0Status - p.count) !== 12) return null;       // layout guard (see above)
    return loadI32((p.count - 9 * 4) + rd * 4)
      .concat([OP.i64_extend_i32_s], C.writeFromStack(rt));
  }

  // ---- delay-slot codegen (wave 8) ----
  // Wave 2 accepted a branch only when its delay slot was a pure ALU op,
  // because a faulting slot needs g_dev.r4300.delay_slot set for EPC/BD and
  // skip_jump, and only the interpreter sets it. The wave-5b runtime census
  // showed what that costs: on mariokart 74% of ALL fallback executions were
  // branches rejected for exactly this reason (BNEL@slot:SB 26.0%,
  // BNE@slot:LHU 22.7%, BEQL@slot:LW 11.5%, JR@slot:SW 5.1%, ...), and each
  // one exits the block into the dispatcher. Not one was @span-end or @idle.
  //
  // The fix keeps exactness without touching the core: a memory/FP slot is
  // emitted natively, and its RDRAM fast arm CANNOT fault (readmem*[a>>16]
  // == read_rdram* means a direct RDRAM access — no TLB walk, no MMIO), so
  // delay_slot is never observed there. Every other arm (off-RDRAM, CU1
  // clear) hands the WHOLE BRANCH back to the interpreter and exits, which
  // re-runs branch+slot with the flag set. See slowArm().
  function emitSlotNative(word, slotPtr, p, Cx, opsIdx, exitD, slow) {
    // MFC0 is fault-free (no coprocessor-usable check, no memory access), so
    // it is safe in a delay slot with no bail arm: g_dev.r4300.delay_slot can
    // never be observed by it.
    var r = emitCop0(word, p, Cx);
    if (r) return r;
    r = emitLoad(word, slotPtr, p, Cx, opsIdx, exitD, slow);
    if (r) return r;
    r = emitStore(word, slotPtr, p, Cx, opsIdx, exitD, slow);
    if (r) return r;
    if (typeof window !== 'undefined' && window.__jitNoFP) return null;
    r = emitCop1(word, slotPtr, p, Cx, opsIdx, exitD, slow);
    if (r) return r;
    return emitCop1Mem(word, slotPtr, p, Cx, opsIdx, exitD, slow);
  }

  // ---- block compiler ----
  var stats = { blocks: 0, nativeOps: 0, nativeBranches: 0, nativeMemSlots: 0, nativeLoads: 0, nativeStores: 0, nativeFP: 0, nativeFPCvt: 0, nativeFPCmp: 0, nativeFPBranches: 0, nativeCop0: 0, fallbackOps: 0, fails: 0, slotReuses: 0, distinctSlots: 0 };
  // table slot per guest entry address: a recompile REUSES its slot via
  // wasmTable.set, unrooting the previous instance for GC — the table is
  // bounded by distinct block entries, not by recompile churn (vaddr keys
  // are stable across precomp_block realloc; host entryPtr is not)
  var slotByVaddr = Object.create(null);
  // recompile cache (see compileSpan): hash -> [{ key, inst, labels, labelOps }]
  var spanCache = new Map(), spanCacheN = 0, SPAN_CACHE_MAX = 16384;

  // Append in place. compileSpan used `body = body.concat(...)` per
  // instruction, which re-copies the whole body every time — quadratic in
  // span length, and the emitter's JS was 11.25% of main-thread time in the
  // MK64 race window under a 4x throttle (110 compiles in 700 frames).
  function app(dst, src) { for (var q = 0; q < src.length; q++) dst.push(src[q]); }

  // ---- COMPILE BUDGET (2026-10-02) ----
  // A scene load asks for hundreds of new spans inside one field; on the
  // user's phone (Mali-G715, ?costdbg=1) a single field then spent 80-325 ms
  // compiling, and the field IS the frame. So at most JIT_BUDGET spans are
  // emitted and compiled per field (cache hits do not count); the rest stay on
  // the cached interpreter for now and are QUEUED. At the end of every
  // retro_run (libretronew.c calls frameEnd) the budget is refilled and the
  // queue is compiled oldest first, again at most JIT_BUDGET.
  // Deterministic: the budget counts spans, never time, so every console
  // defers the same requests at the same points. And exact either way: a
  // compiled span and the interpreter it replaces are the same machine (the
  // hashed 27-ROM sweeps), and a queued span is only installed if its entry
  // still holds the very interpreter op it held when offered, in the same
  // valid page — compileSpan then compiles the words in memory NOW, with the
  // recompile key computed from them, so a page that changed meanwhile is
  // compiled as it is (or, if it was invalidated, left to NOTCOMPILED).
  // ?jitbudget=N sets it (published by fbasync.js in both realms); 0 = no
  // budget, the old behaviour, and the A/B arm.
  var JIT_BUDGET = null, budgetLeft = 0, deferQ = [], deferSet = new Set(), draining = false;
  function jitBudget() {
    if (JIT_BUDGET === null) {
      var g = (typeof globalThis !== 'undefined') ? globalThis : self, f = g.__fbAsync;
      JIT_BUDGET = (f && typeof f.jitBudget === 'number' && f.jitBudget >= 0) ? f.jitBudget : 6;
      budgetLeft = JIT_BUDGET;
    }
    return JIT_BUDGET;
  }
  function frameEnd() {
    ASYNC.frameEnds++;
    if (ASYNC.ready.length) asyncInstallReady();
    asyncFlush();
    if (!jitBudget()) return;
    budgetLeft = JIT_BUDGET;
    var M = (typeof globalThis !== 'undefined' ? globalThis : self).Module;
    if (!deferQ.length || !M) return;
    var U = M.HEAPU32;
    draining = true;
    try {
      while (deferQ.length && budgetLeft > 0) {
        var d = deferQ.shift(); deferSet.delete(d.p.entryPtr);
        var p = d.p, page = (p.vaddr >>> 12);
        // the same page, still valid, its entry still the interpreter op it was
        var bp = U[(p.blocksBase >> 2) + page];
        if (!bp || U[bp >> 2] !== d.blk || U[(bp >> 2) + 1] !== (p.blockStart >>> 0) || U[(bp >> 2) + 2] !== (p.blockEnd >>> 0)) { stats.deferStale = (stats.deferStale || 0) + 1; continue; }
        if (M.HEAPU8[p.invalidCode + page]) { stats.deferStale = (stats.deferStale || 0) + 1; continue; }
        if (U[p.entryPtr >> 2] !== d.op || d.op === p.notCompiled) { stats.deferStale = (stats.deferStale || 0) + 1; continue; }
        var idx = compileSpan(p, M);
        if (idx > 0 && U[p.entryPtr >> 2] === d.op) { U[p.entryPtr >> 2] = idx; stats.deferInstalled = (stats.deferInstalled || 0) + 1; }
      }
    } finally { draining = false; }
  }

  // ---- OFF-THREAD EMISSION (2026-10-03) ----
  // Where a span's compile time goes, measured in the MK64 boot+race window
  // (n64/tools/n64_field_cost_probe.mjs, HEAD, this box): 1591 compiles took
  // 5265 ms in the core's thread, of which the WebAssembly.Module compile was
  // 460 ms and instantiation 92 ms — the other ~90% is THIS FILE's JS building
  // the bytes. A budget can spread that but not remove it (one big span is
  // tens of ms by itself on a phone). So the bytes are built in a second worker
  // (jit_compile_worker.js runs this same file with EMIT_ONLY set): the core's
  // thread copies the span's inputs — the 4 KB page's words and the span's
  // precomp ops fields, which is everything compileSpan bakes into a module
  // (see RECOMPILE CACHE below) — posts them, and returns 0, so the span runs
  // on the cached interpreter meanwhile. The compiled module comes back as a
  // WebAssembly.Module and is installed at the next field end (frameEnd), and
  // only if every input it was built from still holds: the page's words, every
  // ops field (init_block resets them to NOTCOMPILED on invalidation), the
  // page's precomp block (same array, same bounds), and the page still valid.
  // Exact: the module is the one compileSpan would have built from the same
  // words in this thread (the same function runs on a copy of them; a read
  // outside the copy fails the job instead of guessing), and a compiled span
  // and the interpreter it replaces are the same machine — the property
  // rollback's re-simulation already rests on (the code cache is kept across
  // a state load), proven by the differential harness and the rollback probe.
  // So WHEN a module lands moves time only, never what the guest computes.
  // Off: ?jitasync=0 (published by fbasync.js in both realms), census mode,
  // no Worker, or a core that never calls frameEnd — then the per-field budget
  // above applies.
  var EMIT_ONLY = null;          // set in the compile worker: compileSpan stops after emitting
  var TABLE_BASE = 0;            // the core's table length before any JIT slot (see NO COMPILED CODE UNDER A SPAN)
  var ASYNC = { on: null, w: null, nextId: 1, pending: new Map(), ready: [], outbox: [], frameEnds: 0, M: null,
                offered: 0, installed: 0, stale: 0, failed: 0, maxInstallMs: 0, reoffered: 0, retry: 0, modules: 0 };
  function asyncOn(Module) {
    if (EMIT_ONLY) return false;
    if (ASYNC.on === false) return false;
    if (!ASYNC.frameEnds) return false;          // this core calls frameEnd: installs can happen
    if (ASYNC.on === true) return true;
    var g = (typeof globalThis !== 'undefined') ? globalThis : self, f = g.__fbAsync;
    if ((f && f.jitAsync === false) || census.on || typeof Worker !== 'function' || typeof g.__n64JitWorkerUrl !== 'string') { ASYNC.on = false; return false; }
    try {
      ASYNC.w = new Worker(g.__n64JitWorkerUrl);
      ASYNC.w.onmessage = function (e) {
        var d = e.data, list = Array.isArray(d) ? d : [d];
        for (var k = 0; k < list.length; k++) {
          var x = list[k];
          if (x && x.batch) {
            // one module for the whole batch: every item points at the shared holder
            var Bh = { mod: x.mod || null, bytes: x.bytes || null, inst: null };
            for (var q = 0; q < x.items.length; q++) { if (x.items[q].ok) x.items[q].B = Bh; ASYNC.ready.push(x.items[q]); }
          } else ASYNC.ready.push(x);
        }
      };
      ASYNC.w.onerror = function (e) {
        // a worker that fails leaves everything it was asked for on the interpreter;
        // from now on spans compile in this thread again
        ASYNC.on = false; ASYNC.pending.clear(); stats.asyncWorkerError = String((e && e.message) || e).slice(0, 160);
      };
      ASYNC.M = Module;
      ASYNC.on = true;
    } catch (e) { ASYNC.on = false; stats.asyncWorkerError = String((e && e.message) || e).slice(0, 160); }
    return ASYNC.on;
  }
  function jitFlags() {
    return { noFP: !!(typeof window !== 'undefined' && window.__jitNoFP), noLabels: !!(typeof window !== 'undefined' && window.__jitNoLabels),
             pin: pinOn(), cold: coldOn(), chain: chainOn() };
  }
  function asyncOffer(p, U, span, pageW0, pageN, keyArr) {
    var page = p.vaddr >>> 12, bp = U[(p.blocksBase >> 2) + page];
    var nOps = span + 2, ops = new Uint32Array(nOps);
    for (var k = 0; k < nOps; k++) ops[k] = U[(p.entryPtr + k * p.stride) >> 2];
    var words = U.slice(pageW0, pageW0 + pageN + 1);    // the page, and the word after it
    var id = ASYNC.nextId++;
    var job = { id: id, p: Object.assign({}, p), w0: pageW0, words: words, ops: ops, flags: jitFlags(), tableBase: TABLE_BASE };
    if (WARM.corpus) warmStart(job);
    if (WARM.capture) WARM.capture.push({ p: job.p, w0: pageW0, words: words, ops: ops, flags: job.flags, tableBase: TABLE_BASE });
    ASYNC.pending.set(id, { p: job.p, w0: pageW0, words: words, ops: ops, bp: bp, blk: bp ? U[bp >> 2] : 0, keyArr: keyArr, tries: ASYNC.retry | 0 });
    // batched: one message per field end (or per 32 offers) — a scene load offers hundreds
    // of spans inside one field, and a message each cost more than the copy itself
    ASYNC.outbox.push(job);
    if (ASYNC.outbox.length >= 32) asyncFlush();
    ASYNC.offered++;
  }
  // ---- A SHIPPED SPAN CORPUS (2026-10-04) ----
  // A scene load offers hundreds of spans at once (MK64's race start: ~390 in three fields), and
  // until each module lands its span runs on the cached interpreter — the race start's fields
  // over budget at half a core. But WHAT a session compiles is the same from run to run: the
  // recompile key (RECOMPILE CACHE: the span's addresses, its page's words, its ops fields) of
  // every MK64 1P race span was identical across two runs (1355 of 1355), and the precomp blocks
  // land at the same host addresses. So a title can ship the inputs of the spans a session
  // offered (dist/jit/<internal name>.json.gz, n64/tools/n64_jit_corpus.mjs makes them): at the
  // first offer of a session, if every session-static field of the param block, the emitter
  // flags and the table base are the ones the corpus was made with, its jobs go to the compile
  // worker at LOW priority (behind every real offer), and each module that comes back is only
  // put in the recompile cache — installed nowhere. A span is installed from it only when the
  // core offers it and compileSpan's key, built from memory AS IT IS, equals the corpus key in
  // full: the same inputs, so the same module compileSpan would build (exact, as every cache
  // hit). A corpus that matches nothing costs its compile time in the worker and nothing else.
  // ?jitcorpus=0 (fbasync.js publishes nothing for it; core_worker.js does not load one) = off.
  var WARM = { corpus: null, capture: null, started: false, ids: new Map(), offered: 0, cached: 0, dropped: null };
  var WARM_PER_SPAN = { vaddr: 1, entryPtr: 1, span: 1, srcPtr: 1, blockStart: 1, blockEnd: 1 };
  function warmStart(live) {
    var C = WARM.corpus; WARM.corpus = null;
    if (WARM.started) return; WARM.started = true;
    var k, why = null;
    for (k in C.static) if (C.static[k] !== live.p[k]) { why = 'param ' + k; break; }
    if (!why) for (k in live.p) if (!WARM_PER_SPAN[k] && !(k in C.static)) { why = 'param ' + k + ' not in corpus'; break; }
    if (!why && JSON.stringify(C.flags) !== JSON.stringify(live.flags)) why = 'flags';
    if (!why && (C.tableBase | 0) !== (live.tableBase | 0)) why = 'tableBase';
    if (why) { WARM.dropped = why; return; }
    var out = [];
    for (var i = 0; i < C.jobs.length; i++) {
      var cj = C.jobs[i], pp = Object.assign({}, live.p), w = C.pages[cj.pg];
      for (k in WARM_PER_SPAN) pp[k] = cj[k];
      var id = ASYNC.nextId++, pageN = w.words.length - 1, span = cj.span;
      var key = new Uint32Array(6 + pageN + span);
      key[0] = pp.vaddr >>> 0; key[1] = pp.entryPtr >>> 0; key[2] = span; key[3] = pp.blockStart >>> 0;
      key[4] = pp.blockEnd >>> 0; key[5] = pp.srcPtr >>> 0;
      key.set(w.words.subarray(0, pageN), 6); key.set(cj.ops.subarray(0, span), 6 + pageN);
      WARM.ids.set(id, key);
      out.push({ id: id, p: pp, w0: w.w0, words: w.words, ops: cj.ops, flags: live.flags, tableBase: live.tableBase });
      if (out.length === 32) { ASYNC.w.postMessage({ warm: out }); out = []; }
      WARM.offered++;
    }
    if (out.length) ASYNC.w.postMessage({ warm: out });
  }
  // a corpus module back from the worker: into the recompile cache, nowhere else
  function warmPut(M, r, key) {
    if (!r.ok) return;
    var kh = keyHash(key, key.length), b = spanCache.get(kh);
    if (b) for (var i = 0; i < b.length; i++) if (keyEq(b[i].key, key, key.length)) return;   // compiled live meanwhile
    var Bh = r.B;
    if (!Bh.inst) { Bh.inst = new WebAssembly.Instance(Bh.mod || new WebAssembly.Module(Bh.bytes), { e: { t: M.wasmTable, m: M.wasmMemory } }); ASYNC.modules++; }
    var fns = [Bh.inst.exports['s' + r.k]];
    for (var wk = 1; wk < r.labels.length; wk++) fns.push(r.nfn === 1 ? fns[0] : Bh.inst.exports['s' + r.k + '_' + wk]);
    cachePut(key, fns, r.labels, r.labelOps);
    WARM.cached++;
  }
  // corpus = { static, flags, tableBase, pages: [{ w0, words: Uint32Array }], jobs: [{ vaddr, entryPtr,
  // span, srcPtr, blockStart, blockEnd, pg, ops: Uint32Array }] } (core_worker.js decodes the file)
  function warmCorpus(c) { if (!WARM.started && c && c.jobs && c.jobs.length) WARM.corpus = c; }
  function asyncFlush() {
    if (!ASYNC.outbox.length || !ASYNC.w) return;
    var b = ASYNC.outbox; ASYNC.outbox = [];
    ASYNC.w.postMessage(b);
  }
  function asyncStale(why) { var w = ASYNC.staleWhy || (ASYNC.staleWhy = {}); w[why] = (w[why] | 0) + 1; return false; }
  // r.maxW / r.maxO: the furthest word / ops field the emitter read (everything it baked in)
  function asyncStillHolds(M, j, r) {
    var U = M.HEAPU32, p = j.p, page = p.vaddr >>> 12, k;
    var nw = (r && r.maxW >= 0) ? r.maxW + 1 : j.words.length, no = (r && r.maxO >= 0) ? r.maxO + 1 : j.ops.length;
    // the ops of the span's own entries (j.ops holds span + 2): the one after the span is read
    // only by the null-ops refusal, never baked — it is typically NOTCOMPILED when offered and
    // compiled by the time the module lands, which made 309 of 314 MK64 race spans stale
    if (no > j.ops.length - 2) no = j.ops.length - 2;
    if (M.HEAPU8[p.invalidCode + page]) return asyncStale('invalid');
    var bp = U[(p.blocksBase >> 2) + page];
    if (!bp || bp !== j.bp || U[bp >> 2] !== j.blk || U[(bp >> 2) + 1] !== (p.blockStart >>> 0) || U[(bp >> 2) + 2] !== (p.blockEnd >>> 0)) return asyncStale('block');
    for (k = 0; k < nw; k++) if (U[j.w0 + k] !== j.words[k]) return asyncStale(k === j.words.length - 1 ? 'wordAfterPage' : 'words');
    // An instruction of the span whose op is now a JIT slot (another span's entry or label,
    // installed since — overlapping spans of one page) is fine: this module's fallback there
    // calls the interpreter op it was built with, which is what a span compiled before that
    // install (the synchronous path) does.
    for (k = 0; k < no; k++) {
      var cur = U[(p.entryPtr + k * p.stride) >> 2];
      if (cur === j.ops[k]) continue;
      if (k > 0 && TABLE_BASE && cur >= TABLE_BASE && j.ops[k] < TABLE_BASE) continue;
      return asyncStale(k === 0 ? 'entryOp' : 'ops');
    }
    return true;
  }
  function asyncInstallReady() {
    var M = ASYNC.M || ((typeof globalThis !== 'undefined' ? globalThis : self).Module);
    var t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
    // at most ~2 ms of installing per field end (an instantiate is ~0.05-0.1 ms here; a scene
    // load can bring back hundreds at once): the rest waits for the next field end
    var q = ASYNC.ready, i;
    for (i = 0; i < q.length; i++) {
      if (t0 && i > 0 && performance.now() - t0 > 2) break;   // every item: one may instantiate a whole batch module
      var r = q[i], j = ASYNC.pending.get(r.id);
      if (!j) {
        var wkey = WARM.ids.get(r.id);
        if (wkey) { WARM.ids.delete(r.id); try { warmPut(M, r, wkey); } catch (e) { stats.warmErr = String((e && e.message) || e).slice(0, 160); } }
        continue;
      }
      ASYNC.pending.delete(r.id);
      if (!r.ok) { ASYNC.failed++; if (r.err && !stats.asyncLastErr) stats.asyncLastErr = r.err; continue; }
      if (!asyncStillHolds(M, j, r)) {
        ASYNC.stale++;
        // The page is still valid and the entry still holds the interpreter op it was offered
        // with, but a word or ops field it was built from moved (a data word in a code page):
        // offer it again from memory as it is NOW, as a recompile would. Otherwise it would stay
        // on the interpreter until the page happened to be recompiled.
        var pv = j.p, U0 = M.HEAPU32;
        if (!M.HEAPU8[pv.invalidCode + (pv.vaddr >>> 12)] && U0[pv.entryPtr >> 2] === j.ops[0] && (j.tries | 0) < 3) {
          ASYNC.reoffered++;
          ASYNC.retry = j.tries ? j.tries + 1 : 1;
          var ri = compileSpan(pv, M);
          ASYNC.retry = 0;
          if (ri > 0 && U0[pv.entryPtr >> 2] === j.ops[0]) U0[pv.entryPtr >> 2] = ri;   // a cache hit: installed at once
        }
        continue;
      }
      try {
        var fns = [], wk;
        if (r.B) {
          // a batched module: instantiated once, at its first install
          var Bh = r.B;
          if (!Bh.inst) {
            Bh.inst = new WebAssembly.Instance(Bh.mod || new WebAssembly.Module(Bh.bytes), { e: { t: M.wasmTable, m: M.wasmMemory } });
            ASYNC.modules++;
          }
          fns.push(Bh.inst.exports['s' + r.k]);
          // LABELS BY PC (nfn 1): every label's slot holds the body itself
          for (wk = 1; wk < r.labels.length; wk++) fns.push(r.nfn === 1 ? fns[0] : Bh.inst.exports['s' + r.k + '_' + wk]);
        } else {
          var mod = r.mod || new WebAssembly.Module(r.bytes);
          var inst = new WebAssembly.Instance(mod, { e: { t: M.wasmTable, m: M.wasmMemory, c: censusBump } });
          ASYNC.modules++;
          fns.push(inst.exports.f);
          for (wk = 1; wk < r.labels.length; wk++) fns.push(inst.exports['f' + wk] || fns[0]);   // no wrapper: LABELS BY PC
        }
        var p = j.p, U = M.HEAPU32;
        U[p.entryPtr >> 2] = installSlot(M, p.vaddr >>> 0, fns[0]);   // what recomp.c does with a nonzero return
        for (wk = 1; wk < r.labels.length; wk++) {
          var lptr = p.entryPtr + r.labels[wk] * p.stride;
          if (U[lptr >> 2] !== r.labelOps[wk]) continue;
          U[lptr >> 2] = installSlot(M, (p.vaddr + r.labels[wk] * 4) >>> 0, fns[wk]);
          stats.labelEntries = (stats.labelEntries || 0) + 1;
        }
        stats.blocks++;
        cachePut(j.keyArr, fns, r.labels, r.labelOps);
        ASYNC.installed++;
      } catch (e) {
        ASYNC.failed++; stats.fails++;
        if (stats.fails <= 3) console.error('[bementalJIT] async install failed:', e, 'vaddr', (j.p.vaddr >>> 0).toString(16));
      }
    }
    ASYNC.ready = q.slice(i);           // (no message can arrive during this loop)
    if (t0) { var d = performance.now() - t0; if (d > ASYNC.maxInstallMs) ASYNC.maxInstallMs = d; }
  }
  // the compile worker's side: run compileSpan on a copy of the inputs
  function emitJob(job, batchCtx) {
    var p = job.p, miss = 0, w0 = job.w0, words = job.words, ops = job.ops, base = p.entryPtr >>> 0, stride = p.stride;
    var maxW = -1, maxO = -1;                 // the furthest copied word / ops field it read
    var H = new Proxy({}, { get: function (t, key) {
      var i = +key;
      if (i !== i) return undefined;
      var wi = i - w0;
      if (wi >= 0 && wi < words.length) { if (wi > maxW) maxW = wi; return words[wi]; }
      var off = i * 4 - base;
      if (off >= 0 && off % stride === 0 && off / stride < ops.length) { if (off / stride > maxO) maxO = off / stride; return ops[off / stride]; }
      miss++;
      return 0;
    } });
    window.__jitNoFP = job.flags.noFP; window.__jitNoLabels = job.flags.noLabels; window.__jitPin = job.flags.pin;
    EMIT_ONLY = { out: null, tableBase: job.tableBase | 0, cold: job.flags.cold !== false, chain: job.flags.chain === true,
                  batch: !!batchCtx, fnBase: batchCtx ? batchCtx.fnBase : 0, jt: !!(batchCtx && batchCtx.jt), part: null };
    TABLE_BASE = job.tableBase | 0;
    var idx = 0;
    // FAST EMIT: compileSpan reads the page and the span's ops straight from the copies where it can
    var fast = { words: words, w0: w0, ops: ops, base: base,
                 seen: function (w, o) { if (w > maxW) maxW = w; if (o > maxO) maxO = o; } };
    try { idx = compileSpan(p, { HEAPU32: H, fast: fast }); } catch (e) { return { id: job.id, ok: false, err: String((e && e.message) || e).slice(0, 200) }; }
    var out = EMIT_ONLY.out, part = EMIT_ONLY.part;
    EMIT_ONLY = null;
    if (batchCtx) {
      if (!idx || !part) return { id: job.id, ok: false, err: idx ? 'no module' : 'refused' };
      if (miss) return { id: job.id, ok: false, err: 'read outside the copied inputs (' + miss + ')' };
      return { id: job.id, ok: true, part: part, labels: part.labels, labelOps: part.labelOps, nfn: part.nfn, maxW: maxW, maxO: maxO };
    }
    if (!idx || !out) return { id: job.id, ok: false, err: idx ? 'no module' : 'refused' };
    if (miss) return { id: job.id, ok: false, err: 'read outside the copied inputs (' + miss + ')' };
    return { id: job.id, ok: true, bytes: out.bytes, labels: out.labels, labelOps: out.labelOps, maxW: maxW, maxO: maxO };
  }
  // ---- BATCHED MODULES (2026-10-03) ----
  // WHY. One wasm module per span made the MK64 race a chain of ~1660 modules, and calling
  // across MANY DISTINCT MODULES is what is slow — not the code inside them. Measured with a
  // wasm dispatcher (the r4300_step shape) chaining 21-instruction emitted spans (the MK64
  // race's mean: ~19k JIT dispatches for ~400k instructions in a heavy field): 1600 spans in
  // 1600 modules ran 23-25 ns per guest instruction (~500 ns per dispatch) — the race's own
  // 15-19 ns — against 1.1 ns for 4000 instances of ONE module, and 10 ns for the same 1600
  // spans as functions of ONE module. Each V8 module is its own code space and jump table, so
  // every dispatch into a new module lands on new pages.
  // WHAT. The compile worker receives offers in batches (asyncFlush: up to 32, or every field
  // end) and now emits each batch as ONE module: one shared CHECK_MEMORY helper (function 0),
  // then every span's body and label wrappers, one global (the multi-entry segment hand-off —
  // a wrapper sets it and its body consumes it at entry, so spans can share it), exports
  // "s<k>" / "s<k>_<w>". Each span is still validated and installed on its own
  // (asyncStillHolds): a stale span's functions are simply never installed. The code is byte
  // for byte what the span's own module held, but for function indices.
  function emitBatch(jobs) {
    // JUMP_TO IN-MODULE: the batch's helper sits at function 1 when the core gave &actual
    var jt = !!(jobs.length && jobs[0].p.actualPtr);
    var items = [], parts = [], fnBase = jt ? 2 : 1, p0 = null, t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
    for (var bj = 0; bj < jobs.length; bj++) {
      var job = jobs[bj];
      if (!!job.p.actualPtr !== jt) { items.push({ id: job.id, ok: false, err: 'mixed &actual in one batch' }); continue; }
      var r = emitJob(job, { batch: true, fnBase: fnBase, jt: jt });
      if (!r.ok) { items.push(r); continue; }
      r.k = parts.length;
      parts.push({ fnBase: fnBase, part: r.part });
      fnBase += r.part.funcs.length;
      if (!p0) p0 = job.p;
      delete r.part;
      items.push(r);
    }
    if (!parts.length) return { batch: true, items: items, bytes: null };
    var funcs = jt ? [chkHelper(p0), jtHelper(p0)] : [chkHelper(p0)], types = jt ? [1, 1] : [1], k, w;
    for (k = 0; k < parts.length; k++) for (w = 0; w < parts[k].part.funcs.length; w++) { funcs.push(parts[k].part.funcs[w]); types.push(parts[k].part.types[w]); }
    var exps = [], nExp = 0;
    var name = function (t) { var a = t.split('').map(function (ch) { return ch.charCodeAt(0); }); return leb(a.length).concat(a); };
    // every list is built in place: a batch is ~100 KB of code, and concat-per-item is quadratic
    for (k = 0; k < parts.length; k++) {
      var fb = parts[k].fnBase, nf = parts[k].part.nfn;   // the body and its wrappers, if any (not the cold handlers)
      app(exps, name('s' + k)); exps.push(0x00); app(exps, leb(fb)); nExp++;
      for (w = 1; w < nf; w++) { app(exps, name('s' + k + '_' + w)); exps.push(0x00); app(exps, leb(fb + w)); nExp++; }
    }
    var fdecl = leb(funcs.length);
    for (k = 0; k < types.length; k++) app(fdecl, leb(types[k]));
    // FAST EMIT: the code section is the functions' own arrays, written once into the module
    var code = [leb(funcs.length)];
    for (k = 0; k < funcs.length; k++) { code.push(leb(funcs[k].length)); code.push(funcs[k]); }
    var bytes = packModule([[0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00],
      TYPE_SEC,
      section(2, [].concat(leb(2), [1, 0x65, 1, 0x74, 0x01, 0x70, 0x00, 0x00], [1, 0x65, 1, 0x6D, 0x02, 0x00, 0x00])),
      section(3, fdecl),
      section(6, [0x01, 0x7F, 0x01, OP.i32_const, 0x00, OP.end]),
      { id: 7, chunks: [leb(nExp), exps] },
      { id: 10, chunks: code }]);
    return { batch: true, items: items, bytes: bytes, spans: parts.length, ms: t0 ? performance.now() - t0 : 0 };
  }
  function installSlot(Module, vkey, fn) {
    var sidx = slotByVaddr[vkey];
    if (sidx !== undefined) {
      Module.wasmTable.set(sidx, fn);
      stats.slotReuses++;
    } else {
      sidx = Module.wasmTable.length;
      Module.wasmTable.grow(1);
      Module.wasmTable.set(sidx, fn);
      slotByVaddr[vkey] = sidx;
      stats.distinctSlots++;
    }
    return sidx;
  }
  // fns: the span's entry function and its label wrappers, in label order
  function cachePut(keyArr, fns, labels, labelOps) {
    var kh = 0x811c9dc5 | 0;
    for (var kq = 0; kq < keyArr.length; kq++) kh = Math.imul(kh ^ keyArr[kq], 16777619);
    if (spanCacheN >= SPAN_CACHE_MAX) { spanCache.clear(); spanCacheN = 0; }
    var nb = spanCache.get(kh);
    if (!nb) { nb = []; spanCache.set(kh, nb); }
    nb.push({ key: keyArr, fns: fns, labels: labels, labelOps: labelOps });
    spanCacheN++;
  }

  function compileSpan(p, Module) {
    // resolved once, on the first compile — the page sets window.__jitCensus
    // before loading this script, and it must stay constant for the session
    // (it decides each module's import/type shape)
    if (census.on === null) census.on = !!(typeof window !== 'undefined' && window.__jitCensus);
    RAW = 0;
    COLD = null;
    var HEAPU32 = Module.HEAPU32;
    var C = new RegCache(p.reg);
    p.regBase = p.reg;
    p_hi_lo.hi = p.hi; p_hi_lo.lo = p.lo;
    var body = [];
    var EXIT = 1, TOP = 0;
    var i = 0;
    // ---- DELAY-SLOT GUARD PRECONDITION ----
    // `p.delaySlot` is &g_dev.r4300.delay_slot, behind the param-block version
    // magic. Without it the block CANNOT tell that it was invoked as a branch
    // delay slot (see the guard emitted at the bottom of this function), and an
    // unguarded block is a guest-corrupting bug, not a missed optimisation. So a
    // core too old to supply it gets NO jit at all — the whole ROM stays on the
    // cached interpreter, which is the shipped default anyway.
    if (!p.delaySlot) {
      stats.noDelaySlotRejects = (stats.noDelaySlotRejects || 0) + 1;
      if (stats.noDelaySlotRejects === 1 && typeof console !== 'undefined') {
        console.warn('[jit] disabled: core does not export &delay_slot (param-block version skew)');
      }
      return 0;
    }

    // ---- NULL-OPS GUARD (thewheel.z64 wedge, n64/docs/jit/TASKS.md:301) ----
    // Every interpreter-fallback path bakes a table index read at COMPILE time
    // (`HEAPU32[instrPtr >> 2]`) straight into a `call_indirect` -- slowArm:414
    // and :420, cuGuard:629, and the generic fallback at the bottom of this
    // loop. Nothing ever checked that index for 0. A `precomp_instr` whose
    // `ops` is still null when the bridge runs therefore compiles to
    // `call_indirect 0`, and index 0 of the wasm table is the null entry, so
    // the block TRAPS the first time that path is reached.
    //
    // That is what thewheel.z64 does: it stalls at VI 245 under ?jit with
    // "RuntimeError: null function", and the mode ladder puts the fault in
    // native emission (?jit=wrap and ?jit=v05 both reach VI 401 on the same
    // ROM, and ?jit=nofp stalls identically with nativeFP=0, so it is neither
    // the plumbing nor FP). It is a TRAP, not the poll-starvation wedge the
    // task list hypothesised.
    //
    // Refusing the whole span is the conservative repair: the block simply
    // stays on the cached interpreter, exactly as it did before wave 1, and it
    // is retried on the next recompile when ops may be populated. span+1 is
    // scanned because delay-slot emission reads one instruction past the span.
    //
    // ---- PAGE-END TRUNCATION (2026-09-30) — what the null-ops rejects WERE ----
    // Every one of those rejects was a span that ran PAST ITS 4KB PAGE.
    // recompile_block (recomp.c:2383-2455) does not stop at the page end: for
    // KSEG0/KSEG1 code with no J/JR before it, it keeps compiling the NEXT
    // page's words into this page's precomp array (up to index
    // length-2+length/4) and then appends one or two FIN_BLOCK entries; for
    // TLB-mapped / 0xa4000000 pages it stops at the page end and appends the
    // FIN_BLOCKs right there. So the reported span covered (a) continuation
    // instructions, (b) the FIN_BLOCK slots — whose source "words" the emitter
    // would have emitted as ordinary instructions — and ended on an index the
    // compile never wrote (ops == 0, calloc'd by init_block). MK64 on a phone:
    // 44 such spans, each left entirely on the interpreter; the ROM's first
    // one here was vaddr 0x800cdff8 (page offset 0xff8, span 14).
    // The exact repair is to END THE JIT SPAN AT THE PAGE END: the block's
    // fall-through exit then sets PC = &block[length], the first continuation
    // entry, which THIS recompile wrote (non-null) — so the dispatcher runs the
    // same op the cached interpreter would have reached by `PC++`, and nothing
    // past the page is ever emitted (for a TLB page the next VIRTUAL page need
    // not even be the next physical one that `source` points into).
    var span = p.span;
    var pageLen = ((p.blockEnd - p.blockStart) >>> 0) >>> 2;
    var entryInPage = ((p.vaddr - p.blockStart) >>> 0) >>> 2;
    if (pageLen > 0 && entryInPage < pageLen && span > pageLen - entryInPage) {
      span = pageLen - entryInPage;
      stats.pageTruncated = (stats.pageTruncated || 0) + 1;
    }
    if (span <= 0) return 0;
    var g = opsZeroAt(HEAPU32, p.entryPtr, p.stride, span + 1);
    if (g >= 0) {
      stats.nullOpsRejects = (stats.nullOpsRejects || 0) + 1;
      if (stats.nullOpsRejects === 1 && typeof console !== 'undefined') {
        console.warn('[jit] span rejected: precomp_instr.ops == 0 at index ' + g +
                     ' of ' + span + ' (vaddr 0x' + (p.vaddr >>> 0).toString(16) + ')');
      }
      return 0;
    }
    // ---- NO COMPILED CODE UNDER A SPAN (2026-10-03) ----
    // Every fallback path bakes the op it finds in the span's precomp entries as the
    // INTERPRETER op to call for that one instruction. recompile_block hands the bridge a
    // page whose ops are all fresh interpreter ops, but a span compiled LATER — off-thread
    // (OFF-THREAD EMISSION re-offers a span whose page moved), or drained from the budget
    // queue — can find another span's entry or label already holding a JIT block there.
    // Baking that would make a "one instruction" fallback run a whole block (and recurse:
    // measured, "Maximum call stack size exceeded" from a JIT module). Interpreter ops are
    // functions of the core's own table; JIT blocks are slots appended after it, so any op at
    // or above the table's length at the first compile is not an interpreter op: refuse.
    // ONLY THE SPAN'S OWN ENTRIES (2026-10-03): index `span` — the instruction after the span
    // — is never baked into a module (a branch at span-1 is emitted as a 'span-end' fallback of
    // its own op; the fall-through exit stores the POINTER &block[span], not its op). It is
    // very often the entry of the NEXT function, already a JIT block, and checking it refused
    // 177 MK64 race spans outright (every jitOpReject measured was at index == span), among
    // them the game's hottest loops, which then ran on the cached interpreter for good.
    if (!TABLE_BASE) TABLE_BASE = EMIT_ONLY ? (EMIT_ONLY.tableBase | 0) : (Module.wasmTable ? Module.wasmTable.length : 0);
    if (TABLE_BASE && opsAnyAtOrAbove(HEAPU32, p.entryPtr, p.stride, span, TABLE_BASE)) {
      stats.jitOpRejects = (stats.jitOpRejects || 0) + 1;
      return 0;
    }

    // ---- MULTI-ENTRY SPANS (2026-09-30) ----
    // The core installs a JIT block as ONE instruction's ops: the span ENTRY
    // (recomp.c:2583). Every other instruction of the span keeps its
    // interpreter op, so control that arrives anywhere else — the return
    // point after a JAL (the callee's JR lands at addr+8 via jump_to), or an
    // in-span branch target — ran on the CACHED INTERPRETER until the next
    // jump happened to hit an entry. And a PLAIN branch to any in-span target
    // other than the entry EXITED the block to do exactly that.
    // Labels fix both. A label is an in-span index that is (a) the target of
    // an in-page PLAIN branch of this span, or (b) the return point addr+8 of
    // a linking jump of this span, or (c) the entry itself. The body is laid
    // out as one segment per label under a br_table (the classic switch
    // lowering): a FORWARD in-span branch is a direct `br` to its segment, a
    // BACKWARD one sets L_START and re-enters the dispatch at $top. Each label
    // k >= 1 also gets an exported entry wrapper that is written into
    // block[label].ops, so the dispatcher enters native code there too.
    // Exactness: a label boundary is a join, so the register cache is flushed
    // and emptied on the fall-through into it (branch tails already arrive
    // flushed and empty). Count / last_addr / interrupt polling happen on the
    // branch exactly as before — the only thing a native in-span branch skips
    // is the round trip through the dispatcher, which the interpreter would
    // make with the same PC, last_addr and Count.
    // A label that is the DELAY SLOT of a branch is dropped (the branch's
    // native emission consumes branch+slot as one unit), and so is a branch
    // targeting ITSELF (the IDLE shape stays a fallback, as before).
    // Label sources, all over the WHOLE 4KB page's words (the page is one
    // physical page, so `source` is contiguous across it):
    //   (a) PLAIN branch/jump targets inside this span — from this span OR
    //       from another span of the same page (IDO's `j cond; ... cond: bne
    //       body` loop shape ends one span at the `j` and lands in another);
    //   (b) addr+8 of every linking jump in this span (the JR return point);
    //   (c) addr+8 of every CONDITIONAL branch in this span: the not-taken
    //       path already arrives there flushed and empty, so the label costs
    //       nothing at run time, and it is where an interrupt taken on that
    //       path returns to (EPC = the poll's final PC).
    // A word that is really data can only ADD a label, which costs a cache
    // flush at that boundary and never changes what executes.
    var srcW = p.srcPtr >> 2;
    var labelOrd = new Int32Array(span + 1).fill(-1);
    var wantLabel = [0];
    var pageW0 = srcW, pageN = span, pageA0 = p.vaddr >>> 0, spanOff = 0;
    if (pageLen > 0 && entryInPage < pageLen) {
      pageW0 = srcW - entryInPage; pageN = pageLen; pageA0 = p.blockStart >>> 0; spanOff = entryInPage;
    }

    // ---- RECOMPILE CACHE (2026-09-30) ----
    // MK64 recompiles ~110 spans inside a 700-frame race window (pages that
    // hold both code and written data get invalidated, init_block resets
    // them, and NOTCOMPILED recompiles the SAME code). Under a 4x CPU
    // throttle the emitter's JS was 11.25% of all main-thread time there.
    // Everything this function bakes into a module is a function of: the
    // param-block addresses (static per session), vaddr/entryPtr/span/page
    // bounds, the 4KB page's words (decode AND label discovery) and the ops
    // fields of the span's precomp entries (fallback/guard targets). So the
    // key is exactly that, compared IN FULL on a hit (the hash only picks the
    // bucket), and a hit re-installs the very same instance — identical code,
    // no byte generation, no wasm compile.
    // (the ops of the span's own entries only: index `span` is not baked — see above)
    var keyLen = 6 + pageN + span;
    var keyArr = new Uint32Array(keyLen);
    keyArr[0] = p.vaddr >>> 0; keyArr[1] = p.entryPtr >>> 0; keyArr[2] = span; keyArr[3] = p.blockStart >>> 0;
    keyArr[4] = p.blockEnd >>> 0; keyArr[5] = p.srcPtr >>> 0;
    var kh = 0x811c9dc5 | 0, kq;
    // FAST EMIT: in the compile worker HEAPU32 is a Proxy over the copied inputs (emitJob), and
    // these two loops (the whole page, every span op) went through its trap per word. When the
    // copies cover both ranges they are read directly — the same words, the same furthest-read
    // marks (Module.fast.seen) — and otherwise through HEAPU32 as before.
    var FP = Module.fast, fw = FP ? pageW0 - FP.w0 : -1;
    if (FP && fw >= 0 && fw + pageN <= FP.words.length && (p.entryPtr >>> 0) === FP.base && span <= FP.ops.length &&
        (((p.entryPtr >>> 2) - FP.w0) >= FP.words.length || (((p.entryPtr + (span - 1) * p.stride) >>> 2) - FP.w0) < 0)) {
      for (kq = 0; kq < pageN; kq++) keyArr[6 + kq] = FP.words[fw + kq];
      for (kq = 0; kq < span; kq++) keyArr[6 + pageN + kq] = FP.ops[kq];
      FP.seen(pageN ? fw + pageN - 1 : -1, span - 1);
    } else {
      keyFillWords(keyArr, 6, HEAPU32, pageW0, pageN);
      keyFillOps(keyArr, 6 + pageN, HEAPU32, p.entryPtr, p.stride, span);
    }
    kh = keyHash(keyArr, keyLen);
    var bucket = EMIT_ONLY ? null : spanCache.get(kh);
    if (bucket) {
      for (var bi = 0; bi < bucket.length; bi++) {
        var ce = bucket[bi];
        if (!keyEq(ce.key, keyArr, keyLen)) continue;
        var hidx = installSlot(Module, p.vaddr >>> 0, ce.fns[0]);
        for (var hk = 1; hk < ce.labels.length; hk++) {
          var hptr = p.entryPtr + ce.labels[hk] * p.stride;
          if (HEAPU32[hptr >> 2] !== ce.labelOps[hk]) continue;
          HEAPU32[hptr >> 2] = installSlot(Module, (p.vaddr + ce.labels[hk] * 4) >>> 0, ce.fns[hk]);
          stats.labelEntries = (stats.labelEntries || 0) + 1;
        }
        stats.cacheHits = (stats.cacheHits || 0) + 1;
        return hidx;
      }
    }

    // built off this thread (OFF-THREAD EMISSION above): the interpreter runs it meanwhile
    if (!draining && asyncOn(Module)) {
      asyncOffer(p, HEAPU32, span, pageW0, pageN, keyArr);
      stats.asyncOffered = (stats.asyncOffered || 0) + 1;
      return 0;
    }
    // over this field's compile budget: run it on the interpreter, compile later
    if (!EMIT_ONLY && jitBudget() && !draining) {
      if (budgetLeft <= 0) {
        if (!deferSet.has(p.entryPtr) && deferQ.length < 4096) {
          var pageBp = HEAPU32[(p.blocksBase >> 2) + (p.vaddr >>> 12)];
          deferQ.push({ p: Object.assign({}, p), op: HEAPU32[p.entryPtr >> 2], blk: pageBp ? HEAPU32[pageBp >> 2] : 0 });
          deferSet.add(p.entryPtr);
        }
        stats.deferred = (stats.deferred || 0) + 1;
        return 0;
      }
      budgetLeft--;
    } else if (draining) budgetLeft--;

    for (var li = 0; li < pageN; li++) {
      var lw = keyArr[6 + li];             // = HEAPU32[pageW0 + li], read just above (FAST EMIT)
      var la = (pageA0 + li * 4) >>> 0;
      var ld0 = decodeBranch(lw, la, p);
      if (!ld0) continue;
      var own = li - spanOff;              // index within this span, if inside it
      if (ld0.target !== null && ld0.target >= p.blockStart && ld0.target < p.blockEnd && la !== ((p.blockEnd - 4) >>> 0)) {
        var lt = ((ld0.target - p.vaddr) | 0) / 4;
        if (lt > 0 && lt < span && lt !== own) wantLabel.push(lt);
      }
      if (own >= 0 && own < span) {
        if (ld0.link && own + 2 < span) wantLabel.push(own + 2);
        else if (ld0.cond !== null && own + 2 < span) wantLabel.push(own + 2);
      }
    }
    // (d) the instruction after an op that always hands back to the
    // dispatcher (see alwaysHandsBack) — scanned over the span only
    for (var hb = 0; hb + 1 < span; hb++) {
      if (alwaysHandsBack(HEAPU32[srcW + hb])) wantLabel.push(hb + 1);
    }
    wantLabel.sort(function (a, b) { return a - b; });
    var labels = [];
    for (var lk = 0; lk < wantLabel.length; lk++) {
      var lx = wantLabel[lk];
      if (labels.length && labels[labels.length - 1] === lx) continue;
      if (lx > 0 && isBranchWord(HEAPU32[srcW + lx - 1])) continue;   // a delay slot
      labels.push(lx);
    }
    if (window.__jitNoLabels) labels = [0];   // attribution arm: single-entry spans
    var nSeg = labels.length;
    for (var lo = 0; lo < nSeg; lo++) labelOrd[labels[lo]] = lo;
    // original interpreter ops at every label, read BEFORE any install
    var labelOps = labels.map(function (x) { return HEAPU32[(p.entryPtr + x * p.stride) >> 2]; });
    // ---- PINNING (2026-10-01) ----
    // In the MK64 race window the native back-edge ran 7.4M times and in-span
    // forward branches 11.3M times per 700 frames (?jit=census), and EVERY
    // one of them used to flush the dirty registers to reg[] and reload each
    // one lazily on the far side — a label is a join, and joins were empty.
    // A register referenced inside a native loop (the instructions from a
    // backward in-span branch's label target through its delay slot) is
    // instead PINNED: loaded once in the prologue, kept in its local across
    // every join, written back on exit (see RegCache.pinned and RAW). The
    // field decode below over-approximates (a data word or an FP register
    // field can only add a pin, which costs a prologue load + epilogue store
    // and never changes what executes). r0 is never pinned.
    var pins = new Array(32).fill(false), nPins = 0, pinW = new Array(32).fill(false);
    // OPT-IN (window.__jitPin, 2026-10-01): exact by the unit corpus and the
    // 27-ROM hashed sweep, but its matched pairs on MK64 were inside the rig's
    // noise (4x CPU: 0.979 and 1.056 against the unpinned emitter, opposite
    // signs) — so it does not ship on until a quiet-box pair shows a gain.
    if (pinOn()) {
      var refs = new Int32Array(32);
      for (var pb = 0; pb + 1 < span; pb++) {
        var pd = decodeBranch(HEAPU32[srcW + pb], (p.vaddr + pb * 4) >>> 0, p);
        if (!pd || pd.target === null || pd.target < p.blockStart || pd.target >= p.blockEnd) continue;
        var pt = ((pd.target - p.vaddr) | 0) / 4;
        if (pt < 0 || pt >= pb || labelOrd[pt] < 0) continue;   // backward to a label, not a self-loop
        for (var pr = pt; pr <= pb + 1; pr++) gprRefs(HEAPU32[srcW + pr], refs);
      }
      refs[0] = 0;
      var cand = [];
      for (var rr = 1; rr < 32; rr++) if (refs[rr] >= 2) cand.push(rr);
      cand.sort(function (a, b) { return refs[b] - refs[a] || a - b; });
      for (var pc2 = 0; pc2 < cand.length && pc2 < PIN_MAX; pc2++) { pins[cand[pc2]] = true; nPins++; }
      for (var pw = 0; pw <= span && nPins; pw++) gprWrites(HEAPU32[srcW + pw], pinW);
    }
    if (nPins) {
      C.setPinned(pins, pinW);
      RAW = 1;
      stats.pinnedBlocks = (stats.pinnedBlocks || 0) + 1;
      stats.pinnedRegs = (stats.pinnedRegs || 0) + nPins;
    }
    // COLD PATHS: handlers collected while the body is emitted; the helper sits after the
    // body function and its label wrappers
    COLD = coldOn() ? [] : null;
    // LABELS BY PC (with cold paths): no wrapper functions — see the multi-entry dispatch below
    var PCL = !!COLD && nSeg > 1;
    var NFN = COLD ? 1 : nSeg;          // the span's own functions: the body (and, without PCL, its wrappers)
    CHAIN = chainOn(); p_chain = p;
    CHK_FN = (EMIT_ONLY && EMIT_ONLY.batch) ? 0 : (census.on ? 1 : 0) + NFN;   // a batch module puts the helper first
    // JUMP_TO IN-MODULE: a batch module that has the helper puts it second (emitBatch decides
    // for the batch); a module of its own has it after CHK_FN, with cold paths on only
    JT_FN = (EMIT_ONLY && EMIT_ONLY.batch) ? (EMIT_ONLY.jt ? 1 : -1) : ((COLD && p.actualPtr) ? CHK_FN + 1 : -1);
    // cold handlers follow the span's own functions (and, in a module of its own, the helpers)
    COLD_FN0 = (EMIT_ONLY && EMIT_ONLY.batch) ? EMIT_ONLY.fnBase + NFN : CHK_FN + (JT_FN >= 0 ? 2 : 1);
    var seg = 0;
    EXIT = nSeg; TOP = nSeg - 1;       // segment 0's depths (1 / 0 when nSeg == 1)
    var closedSegs = 0;

    while (i < span) {
      // entering a label: close the previous segment with an EMPTY cache
      if (i > 0 && labelOrd[i] >= 0) {
        app(body, [].concat(C.flush()));
        C.invalidate();
        body.push(OP.end);
        closedSegs++;
        seg = labelOrd[i];
        EXIT = nSeg - seg; TOP = nSeg - 1 - seg;
      }
      var word = HEAPU32[(p.srcPtr >> 2) + i];
      var addr = (p.vaddr + i * 4) >>> 0;
      var instrPtr = p.entryPtr + i * p.stride;
      var nextPtr = instrPtr + p.stride;

      // (b) native branch?
      var br = null, brOut = false, slotMem = false;
      var brReason = null;   // census: why a decodable branch was NOT emitted
      var dec = decodeBranch(word, addr, p);
      if (dec && i + 1 >= span) {
        brReason = 'span-end';
      } else if (dec && labelOrd[i + 1] >= 0) {
        // cannot happen (delay-slot labels are dropped above); refuse rather
        // than swallow a segment boundary inside branch+slot
        brReason = 'slot-label';
      } else if (dec) {
        var slotWord = HEAPU32[(p.srcPtr >> 2) + i + 1];
        var isIdle = dec.target !== null && (dec.target === addr) && (slotWord === 0);
        // _OUT mirror: runtime targets (JR/JALR) are ALWAYS the OUT path
        // (cached_interp table binds JR->JR_OUT); constant targets follow
        // recomp.c's variant conditions
        var isOut = dec.target === null || (dec.target < p.blockStart) || (dec.target >= p.blockEnd) || (addr === p.blockEnd - 4);
        // probe the slot with a throwaway cache clone — a rejected probe
        // must leave no compile-state behind
        var probeC = C.clone();
        if (isIdle) brReason = 'idle';
        else if (emitAlu(slotWord, probeC) !== null) { br = dec; brOut = isOut; }
        else {
          // The probe DISCARDS its bytes, but emitCop1 is the one emitter that
          // bumps a stat itself — so a probed-then-emitted FP delay slot was
          // counted TWICE (found by the unit corpus: nativeFPCmp read 2 for one
          // C.LT.S in a slot; nativeFPCvt has had the same inflation since
          // wave 11a). These counters are the LIVENESS evidence for a wave, so
          // an over-reporting one is worse than none: restore them around the
          // probe and let the real emission below do the counting.
          var cvt0 = stats.nativeFPCvt, cmp0 = stats.nativeFPCmp;
          var coldN0 = COLD ? COLD.length : 0;
          var probed = emitSlotNative(slotWord, p.entryPtr + (i + 1) * p.stride, p, probeC,
                                      HEAPU32[(p.entryPtr + (i + 1) * p.stride) >> 2], 0,
                                      { ptr: instrPtr, opsIdx: HEAPU32[instrPtr >> 2] });
          if (COLD) COLD.length = coldN0;     // the probe's bytes are discarded: so are its handlers
          stats.nativeFPCvt = cvt0; stats.nativeFPCmp = cmp0;
          if (probed !== null) { br = dec; brOut = isOut; slotMem = true; }
          else brReason = 'slot:' + mnem(slotWord);
        }
      }
      if (br) {
        var slotWord2 = HEAPU32[(p.srcPtr >> 2) + i + 1];
        var fallPtr = p.entryPtr + (i + 2) * p.stride;
        var fallAddr = (addr + 8) | 0;
        var targetIdx = 0, targetPtr = 0;
        if (!brOut) {
          targetIdx = ((br.target - p.vaddr) | 0) / 4;
          targetPtr = p.entryPtr + targetIdx * p.stride;
        }
        // wave 11b: BC1* carry DECLARE_JUMP's cop1 flag, so
        // check_cop1_unusable() runs FIRST and, when CU1 is clear, raises the
        // exception and returns WITHOUT branching (cached_interp.c:73-78,
        // cp0.c:76-85). Emit that as a bail PREFIX rather than wrapping the
        // whole branch: at this point not one byte of this instruction has run,
        // so re-executing the branch under the interpreter is exact — the same
        // argument slowArm() makes for a faulting delay slot, only stronger
        // (there, the link register had already been written).
        var cu1Prefix = [];
        if (br.cu1 && COLD) {
          cu1Prefix = [].concat(
            loadI32(p.cp0Status), [OP.i32_const], sleb(0x20000000), [OP.i32_and], [OP.i32_eqz],
            [OP.if_, OP.void_],
              coldJump([].concat(
                bump('CU1MISS:' + mnem(word)),
                storeI32Const(p.pcGlobal, instrPtr),
                [OP.i32_const], sleb(HEAPU32[instrPtr >> 2]), [OP.call_indirect, 0x00, 0x00]), EXIT + 1, C.dirtyRegs()),
            [OP.end]);
        } else if (br.cu1) {
          cu1Prefix = [].concat(
            loadI32(p.cp0Status), [OP.i32_const], sleb(0x20000000), [OP.i32_and], [OP.i32_eqz],
            [OP.if_, OP.void_],
              bump('CU1MISS:' + mnem(word)),
              C.flushSnapshot(),
              storeI32Const(p.pcGlobal, instrPtr),
              [OP.i32_const], sleb(HEAPU32[instrPtr >> 2]), [OP.call_indirect, 0x00, 0x00],
              [OP.br].concat(leb(EXIT + 1 + RAW)),
            [OP.end]);
        }
        var linkRegNo = br.link ? (br.linkReg !== undefined ? br.linkReg : 31) : -1;
        var linkBytes = br.link ? [OP.i64_const].concat(sleb((addr + 8) | 0), C.writeFromStack(linkRegNo)) : [];
        // runtime target captured BEFORE link/slot (they may clobber the register)
        var captureBytes = (br.targetReg !== undefined)
          ? C.read(br.targetReg).concat([OP.i32_wrap_i64, OP.local_set], leb(L_JT))
          : [];
        // taken-control tail at a given $exit/$top depth (PLAIN: static PC,
        // back-edge for self-entry; OUT: jump_to with const or captured target)
        function takenTail(Cx, exitD, topD) {
          if (brOut) {
            var tb = (br.targetReg !== undefined)
              ? [OP.local_get].concat(leb(L_JT))
              : [OP.i32_const].concat(sleb(br.target | 0));
            return emitOutJumpTail(p, tb, exitD, Cx);
          }
          // in-span label: native. Forward = direct br to that segment's
          // block; backward (incl. the entry) = set L_START, re-dispatch at
          // $top. `nest` is how many if/else frames the caller is inside.
          var tOrd = (targetIdx >= 0 && targetIdx < span) ? labelOrd[targetIdx] : -1;
          var nest = exitD - EXIT;
          var poll = emitTailPoll(p, Cx, br.target, targetPtr, exitD);
          if (tOrd > seg) return poll.concat(bump('#fwd'), [OP.br], leb(tOrd - seg - 1 + nest));
          if (tOrd >= 0) {
            return poll.concat(bump('#backedge'),
              nSeg > 1 ? [OP.i32_const].concat(sleb(PCL ? targetIdx : tOrd), [OP.local_set], leb(L_START)) : [],   // PCL: the dispatch is by span index
              [OP.br], leb(topD));
          }
          return poll.concat(bump('#exit:branch'), storeI32Const(p.pcGlobal, targetPtr), chainOr(exitD));
        }
        // delay-slot bytes at a given $exit depth. ALU slots emit inline as
        // before; memory/FP slots emit their native fast arm and bail the
        // WHOLE branch to the interpreter on any arm that could fault.
        var slotPtr = p.entryPtr + (i + 1) * p.stride;
        var slotOpsIdx = HEAPU32[slotPtr >> 2];
        var slowSpec = { ptr: instrPtr, opsIdx: HEAPU32[instrPtr >> 2] };
        function emitSlot(Cx, exitD) {
          return slotMem
            ? emitSlotNative(slotWord2, slotPtr, p, Cx, slotOpsIdx, exitD, slowSpec)
            : emitAlu(slotWord2, Cx);
        }
        // skip_jump is tested ONCE, at the block's entry (SKIP_JUMP AT ENTRY, at the delay-slot
        // guard below): it cannot change while native code runs, so every native branch is a
        // plain taken tail. (The name is kept for the three call sites.)
        function skipJumpSplit(Cx, exitD, topD) {
          return takenTail(Cx, exitD, topD);
        }
        if (br.cond === null) {
          // unconditional: J/JAL/JR/JALR — capture, link, slot, count, flush, split
          app(body, [].concat(
            cu1Prefix,
            captureBytes,
            linkBytes,
            emitSlot(C, EXIT),
            emitCountBatch(p, addr),
            C.flush(),
            skipJumpSplit(C, EXIT, TOP)
          ));
          C.invalidate();
        } else if (!br.likely) {
          // the condition is parked in a LOCAL rather than left on the wasm
          // stack across the slot: a memory delay slot emits its own
          // if/else and can br out of the block, and stack residue across
          // those is needless risk
          // LEAN CODE: an ALU slot is straight-line stack code (no if, no br), so there the
          // condition simply stays on the stack underneath it — no L_COND round trip
          var condPark = slotMem ? [OP.local_set].concat(leb(L_COND)) : [];
          var condTake = slotMem ? [OP.local_get].concat(leb(L_COND)) : [];
          app(body, [].concat(
            cu1Prefix,
            br.cond(C), condPark,
            linkBytes,
            emitSlot(C, EXIT),
            emitCountBatch(p, addr),
            C.flush(),
            condTake,
            [OP.if_, OP.void_],
              skipJumpSplit(C, EXIT + 1, TOP + 1),
            [OP.else_],
              emitTailPoll(p, C, fallAddr, fallPtr, EXIT + 1),
            [OP.end]
          ));
          C.invalidate();
        } else {
          app(body, [].concat(
            cu1Prefix,
            br.cond(C),
            linkBytes,
            C.flush(),
            [OP.if_, OP.void_]
          ));
          var Ct = C.clone();
          app(body, [].concat(
            emitSlot(Ct, EXIT + 1),
            emitCountBatch(p, addr),
            Ct.flush(),
            skipJumpSplit(Ct, EXIT + 1, TOP + 1),
            [OP.else_],
              emitCountBatch(p, addr),
              emitTailPoll(p, C, fallAddr, fallPtr, EXIT + 1),
            [OP.end]
          ));
          C.invalidate();
        }
        stats.nativeBranches++;
        if (br.cu1) stats.nativeFPBranches++;   // wave-11b liveness counter
        if (slotMem) stats.nativeMemSlots++;
        i += 2;
        continue;
      }

      // (c) native load / store?
      var opsIdxL = HEAPU32[instrPtr >> 2];
      var ld = emitLoad(word, instrPtr, p, C, opsIdxL, EXIT);
      if (ld) {
        app(body, [].concat(ld));
        stats.nativeLoads++;
        i++;
        continue;
      }
      var st = emitStore(word, instrPtr, p, C, opsIdxL, EXIT);
      if (st) {
        app(body, [].concat(st));
        stats.nativeStores++;
        i++;
        continue;
      }

      // (e) COP1? (window.__jitNoFP disables FP emission for perf attribution)
      var fp = window.__jitNoFP ? null : (emitCop1(word, instrPtr, p, C, opsIdxL, EXIT) || emitCop1Mem(word, instrPtr, p, C, opsIdxL, EXIT));
      if (fp) {
        app(body, [].concat(fp));
        stats.nativeFP++;
        i++;
        continue;
      }

      // (f) native COP0 (MFC0)?
      var c0 = emitCop0(word, p, C);
      if (c0) {
        app(body, [].concat(c0));
        stats.nativeCop0++;
        i++;
        continue;
      }

      // (a) native ALU?
      var alu = emitAlu(word, C);
      if (alu !== null) {
        app(body, [].concat(alu));
        stats.nativeOps++;
        i++;
        continue;
      }

      // (d) fallback: flush, call interp op, invalidate
      var opsIdx = HEAPU32[instrPtr >> 2];
      app(body, [].concat(
        bump(mnem(word) + (brReason ? '@' + brReason : '')),
        C.flushAndInvalidate(),
        storeI32Const(p.pcGlobal, instrPtr),
        [OP.i32_const], sleb(opsIdx), [OP.call_indirect, 0x00, 0x00],
        // MTC0 Count/Status run gen_interrupt inline (mips_instructions.def
        // :672,:698) and any store may hit the MI write handler that does
        // (mi_controller.c:105): either can end the frame without moving PC,
        // so those hand back to the dispatcher unconditionally (see slowArm).
        mayGenInterrupt(word)
          ? [OP.br].concat(leb(EXIT + RAW))
          : [].concat(loadI32(p.pcGlobal), [OP.i32_const], sleb(nextPtr), [OP.i32_ne, OP.br_if], leb(EXIT + RAW),
                      C.reloadPinned())   // continuing: the op may have written a pinned register
      ));
      stats.fallbackOps++;
      i++;
    }
    app(body, [].concat(
      C.flush(),
      bump('#exit:fallthrough'),
      storeI32Const(p.pcGlobal, p.entryPtr + span * p.stride),
      CHAIN && !RAW ? chainOr(EXIT) : []
    ));
    if (C.err.readOnlyWrite >= 0) {
      stats.fails++;
      if (stats.fails <= 3) console.error('[bementalJIT] write to read-only pinned r' + C.err.readOnlyWrite, (p.vaddr >>> 0).toString(16));
      return 0;
    }
    if (closedSegs !== nSeg - 1) {
      // a label was stepped over — never emit a module with unbalanced blocks
      stats.fails++;
      if (stats.fails <= 3) console.error('[bementalJIT] label/segment mismatch', closedSegs, nSeg, (p.vaddr >>> 0).toString(16));
      return 0;
    }

    // ---- DELAY-SLOT ENTRY GUARD (conker.z64 frame-82 divergence, 2026-09-04) ----
    // A JIT block is installed as ONE instruction's `ops`, and the core calls
    // `PC->ops()` in two places that require it to execute EXACTLY ONE
    // instruction and then return:
    //   * DECLARE_JUMP's delay slot (`PC++; delay_slot=1; PC->ops();`,
    //     cached_interp.c:87-90) — reachable whenever a block ENTRY address is
    //     also some branch's `addr+4`;
    //   * FIN_BLOCK's delay-slot path (cached_interp.c:184-206), which fires at
    //     EVERY page boundary: it `jump_to()`s the next page, calls that page's
    //     FIRST instruction as the slot, and then **RESTORES `PC = inst+1`** —
    //     discarding whatever PC the callee left behind.
    // A whole span running there is wrong twice over: it executes instructions
    // the guest never issued (with `delay_slot` set, so any fault inside is
    // recorded as a BD exception), and its `last_addr`/`Count` writes SURVIVE
    // the PC restore. That is the conker.z64 bug, and it is a WRAP, not a
    // drift: the block took its branch, wrote `last_addr = 0x1001402c`, and
    // FIN_BLOCK then restored PC to 0x10014004, so the next
    // `cp0_update_count()` computed `(0x10014004 - 0x1001402c) >> 2` = -40
    // bytes as UNSIGNED — Count jumped by ~0xC0000000, `next_interrupt`
    // collapsed to 0, and the guest fell into a permanent interrupt storm
    // (599M gen_interrupt calls in 252 VI). Witnessed, not inferred: a
    // temporary negative-delta watchdog in `cp0_update_count` fired exactly
    // once in the ?jit arm with `PC->addr=0x10014004 last_addr=0x1001402c`
    // and `delay_slot=1`, and ZERO times in the interpreter arm.
    // The repair is the one the wave-8 slow arm already uses: hand the
    // instruction back. `delay_slot != 0` means the caller wants one
    // instruction, so run the ENTRY instruction's ORIGINAL interpreter op and
    // return. That is exact — it is literally what `PC->ops()` would have done
    // — and it costs one i32 load per block entry.
    // ---- SKIP_JUMP AT ENTRY (LEAN CODE, 2026-10-03) ----
    // DECLARE_JUMP takes a branch only `if (take_jump && !skip_jump)`. skip_jump is set ONLY by an
    // exception taken while delay_slot is set (exception.c:109,:143) and cleared ONLY by
    // gen_interrupt (interrupt.c:596-608, which that same exception made due by zeroing
    // next_interrupt). Native code never runs with delay_slot set (this guard), its interpreter
    // fallbacks for non-branch ops run with delay_slot clear, and a branch op that falls back
    // sets and clears it inside its own call (its slot's exception, then its poll). So while a
    // block's native code runs, skip_jump holds the value it had at the block's entry — and
    // every native branch used to re-test it (a load, a test, and a second copy of the
    // not-taken tail laid into the hot path of EVERY branch). Tested here instead: a block
    // entered with skip_jump set does what it does as a delay slot — runs its entry
    // instruction's ORIGINAL interpreter op and returns — so until gen_interrupt clears it the
    // guest advances on the interpreter, one instruction per dispatch, exactly as without a JIT.
    var entryOps = labelOps[0];
    var slotGuard = [].concat(
      loadI32(p.delaySlot), loadI32(p.skipJump), [OP.i32_or],
      [OP.if_, OP.void_],
        // census bucket so the guard's REACH is measurable on a real ROM
        // rather than assumed — a guard that never fires and a guard that
        // saves the run look identical from a PASS (the wave-10a lesson).
        bump('#delayslot-entry'),
        [OP.i32_const], sleb(entryOps), [OP.call_indirect, 0x00, 0x00],
        [OP.br].concat(leb(1)),          // inside the if (0) -> $exit block (1)
      [OP.end]);

    // Multi-entry dispatch. Label 0's function IS the body, so the common
    // entry costs exactly what it did before (plus one global read when the
    // span has labels). Wrapper k (>= 1) runs its OWN delay-slot guard with
    // ITS label's original op, sets the module global to k and calls the body;
    // the body reads the global into L_START and resets it to 0, so a direct
    // dispatcher call of label 0 always starts at segment 0.
    var startPro = [], dispatch = [];
    var coldList = COLD;
    if (PCL) {
      // ---- LABELS BY PC (LEAN CODE, 2026-10-03) ----
      // Every label used to get a WRAPPER function (its own delay-slot guard, the module global
      // set to k, a call of the body) — ~23k tiny functions in the MK64 race, each a separate
      // piece of machine code, and every label entry paid two prologues and two guards. The core
      // always calls an op as `PC->ops()` (r4300_step, DECLARE_JUMP's slot, FIN_BLOCK,
      // NOTCOMPILED, a chained exit), so the body can tell which label it was entered at from
      // PC itself: idx = (PC - entryPtr) / stride, exactly (stride = odd << tz, so the division
      // is a shift and a multiply by the odd part's inverse mod 2^32). Each label's table slot
      // now holds the BODY, and its dispatch br_table is indexed by span index (backward
      // branches set L_START to the target's index). The guard calls the entered label's own
      // original op through a cold helper ($g, a br_table over idx). An index that is not a
      // label cannot occur: a slot holds this body only while this span's install put it there,
      // and only into the slots of its own entry and labels, whose op fields are the very
      // precomp entries PC points at — it would trap rather than run the wrong code.
      var stz = 0; while (!((p.stride >>> stz) & 1) && stz < 31) stz++;
      var sodd = p.stride >>> stz, sinv = sodd;
      for (var ni = 0; ni < 5; ni++) sinv = Math.imul(sinv, 2 - Math.imul(sodd, sinv));
      var maxL = labels[nSeg - 1];
      startPro = [].concat(loadI32(p.pcGlobal), [OP.i32_const], sleb(p.entryPtr | 0), [OP.i32_sub],
        stz ? [OP.i32_const].concat(sleb(stz), [OP.i32_shr_u]) : [], [OP.i32_const], sleb(sinv), [OP.i32_mul],
        [OP.local_set], leb(L_START));
      // $g(idx): run label idx's ORIGINAL interpreter op (any other idx: none — see above)
      var gFn = [0x00];
      for (var gb = 0; gb < nSeg; gb++) gFn.push(OP.block, OP.void_);
      gFn.push(OP.block, OP.void_, OP.local_get, 0x00, OP.br_table); app(gFn, leb(maxL + 1));
      for (var gi = 0; gi <= maxL; gi++) app(gFn, leb(labelOrd[gi] >= 0 ? labelOrd[gi] + 1 : 0));
      app(gFn, [0x00, OP.end, OP.return_]);
      for (gb = 0; gb < nSeg; gb++) { gFn.push(OP.end); app(gFn, [OP.i32_const].concat(sleb(labelOps[gb]), [OP.call_indirect, 0x00, 0x00, OP.return_])); }
      gFn.push(OP.end);
      var gIdx = COLD_FN0 + coldList.length;
      coldList.push({ raw: gFn, type: 1 });
      slotGuard = [].concat(
        loadI32(p.delaySlot), loadI32(p.skipJump), [OP.i32_or],
        [OP.if_, OP.void_],
          bump('#delayslot-entry'),
          [OP.local_get], leb(L_START), [OP.call], leb(gIdx),
          [OP.return_],                  // before any prologue: nothing to write back
        [OP.end]);
      // (block x nSeg (block $bad br_table) unreachable) — label ordinal k sits at depth k + 1
      for (var db = 0; db <= nSeg; db++) dispatch.push(OP.block, OP.void_);
      dispatch.push(OP.local_get); app(dispatch, leb(L_START)); dispatch.push(OP.br_table); app(dispatch, leb(maxL + 1));
      for (var di = 0; di <= maxL; di++) app(dispatch, leb(labelOrd[di] >= 0 ? labelOrd[di] + 1 : 0));
      app(dispatch, [0x00, OP.end, 0x00, OP.end]);   // default: $bad, then `unreachable`; the last end closes ordinal 0's block
    } else if (nSeg > 1) {
      startPro = [OP.global_get, 0x00, OP.local_set].concat(leb(L_START), [OP.i32_const, 0x00, OP.global_set, 0x00]);
      for (var bb = 0; bb < nSeg; bb++) dispatch.push(OP.block, OP.void_);
      var tgts = [];
      for (bb = 0; bb < nSeg; bb++) tgts = tgts.concat(leb(bb));
      dispatch = dispatch.concat([OP.local_get], leb(L_START), [OP.br_table], leb(nSeg), tgts, leb(0), [OP.end]);
    }

    var LOCALS = [0x0A, 0x02, 0x7F, 0x20, 0x7E, 0x01, 0x7E, 0x01, 0x7F, 0x01, 0x7F, 0x01, 0x7D, 0x01, 0x7C, 0x01, 0x7D, 0x01, 0x7C, 0x01, 0x7F];  // locals: 2xi32, 32xi64 regs, i64 scratch, i32 jump-target, i32 branch-cond, f32+f64 convert scratch (wave 11a), f32+f64 compare operand B (wave 11b), i32 segment start (multi-entry)
    COLD = null;
    LOCALS = [0x0B].concat(LOCALS.slice(1), [0x02, 0x7F]);   // + i32 L_COLD (used with cold paths) + i32 L_CNT
    // PCL: the entry index comes from PC, before the guard (which needs it)
    var pre = PCL ? startPro : [], mid = PCL ? [] : startPro;
    var full = RAW
      // (block $raw  guard  (block $exit  prologue (loop $top ...))  epilogue)
      // The delay-slot guard sits in $raw so its exit skips the epilogue: it
      // runs before the prologue, when the pinned locals hold nothing.
      ? LOCALS.concat(pre, [OP.block, OP.void_], slotGuard, [OP.block, OP.void_], mid, C.reloadPinned(),
          [OP.loop, OP.void_], bump('#block-iter'), dispatch, body,
          [OP.end, OP.end], C.storePinned(), [OP.end, OP.end])
      : LOCALS.concat(pre, [OP.block, OP.void_], slotGuard, mid,
          [OP.loop, OP.void_], bump('#block-iter'), dispatch, body,
          [OP.end, OP.end, OP.end]);

    if (coldList) stats.coldArms = (stats.coldArms || 0) + coldList.length;

    // census adds one imported host func "e"."c" (type 1: (i32)->()), which
    // takes function index 0 and pushes the defined block function to 1
    var cen = !!census.on;
    var batch = !!(EMIT_ONLY && EMIT_ONLY.batch);
    var bodyFn = batch ? EMIT_ONLY.fnBase : (cen ? 1 : 0);
    var funcs = [full];
    for (var wk = 1; wk < NFN; wk++) {
      funcs.push([0x00].concat(            // no locals
        loadI32(p.delaySlot), loadI32(p.skipJump), [OP.i32_or], [OP.if_, OP.void_],   // see SKIP_JUMP AT ENTRY
          bump('#delayslot-entry'),
          [OP.i32_const], sleb(labelOps[wk]), [OP.call_indirect, 0x00, 0x00],
          [OP.return_],
        [OP.end],
        [OP.i32_const], sleb(wk), [OP.global_set, 0x00],
        // CHAINING: a tail call, so a chain into a label leaves no wrapper frame behind
        CHAIN ? [0x12] : [OP.call], leb(bodyFn),
        [OP.end]));
    }
    var ftypes = funcs.map(function () { return 0; });
    if (batch) {
      // BATCHED MODULES: this span's functions go into the module emitBatch assembles
      // (cold handlers last, at COLD_FN0 = fnBase + nSeg)
      if (coldList) for (var hb2 = 0; hb2 < coldList.length; hb2++) { funcs.push(coldHandlerFn(coldList[hb2], p.reg)); ftypes.push(coldType(coldList[hb2])); }
      EMIT_ONLY.part = { funcs: funcs, types: ftypes, labels: labels, labelOps: labelOps, nfn: NFN };
      return 1;
    }
    if (coldList) {
      funcs.push(chkHelper(p)); ftypes.push(1);   // CHK_FN: after the body and its wrappers
      if (JT_FN >= 0) { funcs.push(jtHelper(p)); ftypes.push(1); }   // JT_FN = CHK_FN + 1
      for (var hb1 = 0; hb1 < coldList.length; hb1++) { funcs.push(coldHandlerFn(coldList[hb1], p.reg)); ftypes.push(coldType(coldList[hb1])); }   // COLD_FN0 = CHK_FN + 1
    }
    var typeSec = TYPE_SEC;
    var importSec = section(2, [].concat(leb(cen ? 3 : 2),
      [1, 0x65, 1, 0x74, 0x01, 0x70, 0x00, 0x00],
      [1, 0x65, 1, 0x6D, 0x02, 0x00, 0x00],
      cen ? [1, 0x65, 1, 0x63, 0x00, 0x01] : []));
    var fdecl = leb(funcs.length);
    for (wk = 0; wk < ftypes.length; wk++) app(fdecl, leb(ftypes[wk]));
    var funcSec = section(3, fdecl);
    var globalSec = nSeg > 1 ? section(6, [0x01, 0x7F, 0x01, OP.i32_const, 0x00, OP.end]) : [];
    // exports: "f" = label 0 (the body), "f<k>" = wrapper k
    var exps = leb(NFN).concat([1, 0x66, 0x00], leb(bodyFn));
    for (wk = 1; wk < NFN; wk++) {
      var nm = ('f' + wk).split('').map(function (ch) { return ch.charCodeAt(0); });
      exps = exps.concat(leb(nm.length), nm, [0x00], leb(bodyFn + wk));
    }
    var exportSec = section(7, exps);
    // in place: `code = code.concat(...)` per function re-copied the body for every label
    // wrapper after it — 34.6 ms of a 292-instruction span's 35 ms emit (92 wrappers)
    // (FAST EMIT: written straight into the module's bytes, see packModule)
    var code = [leb(funcs.length)];
    for (wk = 0; wk < funcs.length; wk++) { code.push(leb(funcs[wk].length)); code.push(funcs[wk]); }
    var bytes = packModule([[0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00],
      typeSec, importSec, funcSec, globalSec, exportSec, { id: 10, chunks: code }]);
    if (EMIT_ONLY) { EMIT_ONLY.out = { bytes: bytes, labels: labels, labelOps: labelOps }; return 1; }
    try {
      var mod = new WebAssembly.Module(bytes);
      var inst = new WebAssembly.Instance(mod, { e: { t: Module.wasmTable, m: Module.wasmMemory, c: censusBump } });
      var idx = installSlot(Module, p.vaddr >>> 0, inst.exports.f);
      // Label entries: written straight into block[label].ops, the same field
      // recomp.c:2583 writes for the entry. init_block resets every one of
      // them to NOTCOMPILED on invalidation (cached_interp.c jump_to_func ->
      // init_block), and a later recompile_block over the same range
      // overwrites them with fresh interpreter ops — both exactly as for the
      // entry itself. Written only if the field still holds the op read above.
      for (wk = 1; wk < nSeg; wk++) {
        var lptr = p.entryPtr + labels[wk] * p.stride;
        if (HEAPU32[lptr >> 2] !== labelOps[wk]) continue;
        HEAPU32[lptr >> 2] = installSlot(Module, (p.vaddr + labels[wk] * 4) >>> 0, inst.exports['f' + wk] || inst.exports.f);
        stats.labelEntries = (stats.labelEntries || 0) + 1;
      }
      stats.blocks++;
      var fns1 = [inst.exports.f];
      for (wk = 1; wk < nSeg; wk++) fns1.push(inst.exports['f' + wk] || inst.exports.f);
      cachePut(keyArr, fns1, labels, labelOps);
      return idx;
    } catch (e) {
      stats.fails++;
      if (stats.fails <= 3) console.error('[bementalJIT] compile failed:', e, 'span', span, 'vaddr', (p.vaddr >>> 0).toString(16));
      return 0;
    }
  }

  // census(): [[key, executions], ...] sorted by executions desc. Empty when
  // the session was not started in census mode.
  function censusDump() {
    var out = [];
    for (var i = 0; i < census.names.length; i++) out.push([census.names[i], census.counts[i] >>> 0]);
    out.sort(function (a, b) { return b[1] - a[1]; });
    return out;
  }
  window.bementalMips = { compileSpan: compileSpan, frameEnd: frameEnd, stats: stats, census: censusDump, censusOn: function () { return !!census.on; },
                         async: ASYNC, emitJob: emitJob, emitBatch: emitBatch, warm: WARM, warmCorpus: warmCorpus };
})();
