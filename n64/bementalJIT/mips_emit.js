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
// r0 is cached like any other register: this core's interpreter WRITES
// reg[0] for ops whose destination is r0, and later reads observe it; the
// differential gate compares reg[0] too.
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

  var OP = {
    block: 0x02, loop: 0x03, if_: 0x04, else_: 0x05, end: 0x0B,
    br: 0x0C, br_if: 0x0D, call_indirect: 0x11,
    local_get: 0x20, local_set: 0x21,
    i32_load: 0x28, i64_load: 0x29, i32_load8_u: 0x2D, i32_store: 0x36, i64_store: 0x37, i32_store8: 0x3A,
    i32_const: 0x41, i64_const: 0x42,
    i32_eqz: 0x45, i32_eq: 0x46, i32_ne: 0x47, i32_le_u: 0x4D,
    i64_eq: 0x51, i64_ne: 0x52, i64_lt_s: 0x53, i64_lt_u: 0x54, i64_gt_s: 0x55, i64_le_s: 0x57, i64_ge_s: 0x59,
    i32_add: 0x6A, i32_sub: 0x6B, i32_mul: 0x6C, i32_and: 0x71, i32_or: 0x72, i32_xor: 0x73, i32_shl: 0x74, i32_shr_s: 0x75, i32_shr_u: 0x76,
    i32_extend8_s: 0xC0, i32_extend16_s: 0xC1,
    i64_add: 0x7C, i64_mul: 0x7E, i64_shr_s: 0x87, i64_and: 0x83, i64_or: 0x84, i64_xor: 0x85,
    i32_div_s: 0x6D, i32_div_u: 0x6E, i32_rem_s: 0x6F, i32_rem_u: 0x70,
    i32_wrap_i64: 0xA7, i64_extend_i32_s: 0xAC, i64_extend_i32_u: 0xAD,
    i64_shl: 0x86, i64_shr_u: 0x88,
    f32_load: 0x2A, f32_store: 0x38, f64_load: 0x2B, f64_store: 0x39,
    f32_abs: 0x8B, f32_neg: 0x8C, f32_sqrt: 0x91, f32_add: 0x92, f32_sub: 0x93, f32_mul: 0x94, f32_div: 0x95,
    f64_abs: 0x99, f64_neg: 0x9A, f64_sqrt: 0x9F, f64_add: 0xA0, f64_sub: 0xA1, f64_mul: 0xA2, f64_div: 0xA3,
    void_: 0x40,
  };

  // locals: 0,1 = i32 scratch (addr, word); 2..33 = i64 guest r0..r31
  var L_ADDR = 0, L_WORD = 1, L_REG0 = 2, L_I64S = 34, L_JT = 35; // i64 scratch (mult), i32 jump target

  function loadI64(addr) { return [OP.i32_const, 0x00, OP.i64_load, 0x03].concat(leb(addr)); }
  function loadI32(addr) { return [OP.i32_const, 0x00, OP.i32_load, 0x02].concat(leb(addr)); }
  function storeI64(addr, valueBytes) { return [OP.i32_const, 0x00].concat(valueBytes, [OP.i64_store, 0x03], leb(addr)); }
  function storeI32(addr, valueBytes) { return [OP.i32_const, 0x00].concat(valueBytes, [OP.i32_store, 0x02], leb(addr)); }
  function storeI32Const(addr, value) { return storeI32(addr, [OP.i32_const].concat(sleb(value))); }

  function sext16(v) { return (v << 16) >> 16; }

  // ---- block-local register cache ----
  function RegCache(regBase) {
    this.regBase = regBase;
    this.loaded = new Array(32).fill(false);
    this.dirty = new Array(32).fill(false);
  }
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
    this.loaded[r] = true;
    this.dirty[r] = true;
    return [OP.local_set].concat(leb(L_REG0 + r));
  };
  RegCache.prototype.flush = function () {
    var out = [];
    for (var r = 0; r < 32; r++) {
      if (this.dirty[r]) {
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
    return out;
  };
  RegCache.prototype.invalidate = function () {
    this.loaded.fill(false);
    this.dirty.fill(false);
  };
  RegCache.prototype.flushAndInvalidate = function () {
    var out = this.flush();
    this.invalidate();
    return out;
  };

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
        default: return null;
      }
      return v.concat(C.writeFromStack(dest));
    }
    dest = rt;
    switch (op) {
      case 0x08:                                                                                          // ADDI (no trap in this core)
      case 0x09: v = C.read(rs).concat(wrap, [OP.i32_const], sleb(sext16(imm)), [OP.i32_add], xs); break; // ADDIU
      case 0x0A: v = C.read(rs).concat([OP.i64_const], sleb(sext16(imm)), [OP.i64_lt_s], xu); break;      // SLTI
      case 0x0B: v = C.read(rs).concat([OP.i64_const], sleb(sext16(imm)), [OP.i64_lt_u], xu); break;      // SLTIU
      case 0x0C: v = C.read(rs).concat([OP.i64_const], sleb(imm), [OP.i64_and]); break;                   // ANDI
      case 0x0D: v = C.read(rs).concat([OP.i64_const], sleb(imm), [OP.i64_or]); break;                    // ORI
      case 0x0E: v = C.read(rs).concat([OP.i64_const], sleb(imm), [OP.i64_xor]); break;                   // XORI
      case 0x0F: v = [OP.i64_const].concat(sleb((imm << 16) | 0)); break;                                 // LUI
      default: return null;
    }
    return v.concat(C.writeFromStack(dest));
  }

  // ---- native branch decoding ----
  // Returns { cond: null | (C)=>bytes, ... } — cond emission is DEFERRED so
  // that rejecting the candidate (IDLE/OUT/non-native slot) cannot poison
  // the cache compile-state with loads that were never emitted.
  function decodeBranch(word, addr) {
    var op = (word >>> 26) & 0x3F;
    var rs = (word >>> 21) & 0x1F, rt = (word >>> 16) & 0x1F;
    var imm = sext16(word & 0xFFFF);
    var bTarget = (addr + 4 + imm * 4) >>> 0;
    function cmpRR(opc) { return function (C) { return C.read(rs).concat(C.read(rt), [opc]); }; }
    function cmpRZ(opc) { return function (C) { return C.read(rs).concat([OP.i64_const, 0x00, opc]); }; }
    if (op === 0x00) { // SPECIAL: JR/JALR — runtime register target, ALWAYS the _OUT path
      var fn0 = word & 0x3F;
      var rdJ = (word >>> 11) & 0x1F;
      if (fn0 === 0x08) return { cond: null, link: false, likely: false, target: null, targetReg: rs };
      if (fn0 === 0x09) return { cond: null, link: true, linkReg: rdJ, likely: false, target: null, targetReg: rs };
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

  function emitCountBatch(p, addr) {
    var val = [OP.i32_const].concat(sleb((addr + 8) | 0),
      loadI32(p.lastAddr), [OP.i32_sub, OP.i32_const, 0x02, OP.i32_shr_u],
      [OP.i32_const], sleb(p.cpo), [OP.i32_mul],
      loadI32(p.count), [OP.i32_add]);
    return storeI32(p.count, val);
  }

  // last_addr = finalAddr; if (next_interrupt <= Count) { flush; PC=finalPtr;
  // gen_interrupt(); invalidate; if (PC != finalPtr) br $exit }
  // The CACHE must be clean across gen_interrupt — it runs exception
  // delivery and can hand control to arbitrary guest code after we exit.
  function emitTailPoll(p, C, finalAddr, finalPtr, exitDepth) {
    return storeI32Const(p.lastAddr, finalAddr | 0).concat(
      loadI32(p.nextInt), loadI32(p.count), [OP.i32_le_u],
      [OP.if_, OP.void_],
      C.flush(),                          // compile-state: dirty cleared on BOTH arms (flush emits stores only here, but the arm not taken loses nothing: dirty was already current)
      storeI32Const(p.pcGlobal, finalPtr),
      [OP.i32_const], sleb(p.genInt), [OP.call_indirect, 0x00, 0x00],
      loadI32(p.pcGlobal), [OP.i32_const], sleb(finalPtr), [OP.i32_ne],
      [OP.br_if].concat(leb(exitDepth + 1)),
      [OP.end]
    );
  }

  // _OUT taken-tail: jump_to(target); last_addr = PC->addr (runtime — PC was
  // set by jump_to); poll gen_interrupt (PC already correct, no recheck —
  // the block exits regardless). targetBytes pushes the i32 target.
  function emitOutJumpTail(p, targetBytes, exitDepth) {
    return [].concat(
      storeI32(p.jumpToAddr, targetBytes),
      [OP.i32_const], sleb(p.jumpToFunc), [OP.call_indirect, 0x00, 0x00],
      storeI32(p.lastAddr, loadI32(p.pcGlobal).concat([OP.i32_load, 0x02], leb(p.addrOff))),
      loadI32(p.nextInt), loadI32(p.count), [OP.i32_le_u],
      [OP.if_, OP.void_],
        [OP.i32_const], sleb(p.genInt), [OP.call_indirect, 0x00, 0x00],
      [OP.end],
      [OP.br].concat(leb(exitDepth))
    );
  }

  // ---- native loads & stores ----
  // Shared structure (exit-don't-join): the fast arm operates on the cache
  // and CONTINUES — the fallback arm flushes a snapshot, calls the interp op
  // and EXITS the block unconditionally (PC is correct either way after the
  // op). The register cache therefore stays hot across native memory
  // traffic; only genuinely slow accesses (TLB/MMIO/fb-protected) pay an
  // exit. Compile-state mutations inside the fast arm are sound because the
  // fast arm is the only continuing path.
  function emitLoad(word, instrPtr, p, C, opsIdx, exitDepth) {
    var op = (word >>> 26) & 0x3F;
    if (op !== 0x20 && op !== 0x21 && op !== 0x23 && op !== 0x24 && op !== 0x25 && op !== 0x27) return null;
    var rs = (word >>> 21) & 0x1F, rt = (word >>> 16) & 0x1F;
    var imm = sext16(word & 0xFFFF);
    var tableBase, cmpVal;
    if (op === 0x23 || op === 0x27) { tableBase = p.readmemW; cmpVal = p.rdRdram; }
    else if (op === 0x20 || op === 0x24) { tableBase = p.readmemB; cmpVal = p.rdRdramB; }
    else { tableBase = p.readmemH; cmpVal = p.rdRdramH; }
    var shiftB = [OP.local_get, L_ADDR, OP.i32_const, 0x03, OP.i32_and, OP.i32_const, 0x03, OP.i32_xor, OP.i32_const, 0x03, OP.i32_shl];
    var shiftH = [OP.local_get, L_ADDR, OP.i32_const, 0x02, OP.i32_and, OP.i32_const, 0x02, OP.i32_xor, OP.i32_const, 0x03, OP.i32_shl];
    var val;
    switch (op) {
      case 0x23: val = [OP.local_get, L_WORD, OP.i64_extend_i32_s]; break;
      case 0x27: val = [OP.local_get, L_WORD, OP.i64_extend_i32_u]; break;
      case 0x24: val = [OP.local_get, L_WORD].concat(shiftB, [OP.i32_shr_u, OP.i32_const], sleb(0xFF), [OP.i32_and, OP.i64_extend_i32_u]); break;
      case 0x20: val = [OP.local_get, L_WORD].concat(shiftB, [OP.i32_shr_u, OP.i32_const], sleb(0xFF), [OP.i32_and, OP.i32_extend8_s, OP.i64_extend_i32_s]); break;
      case 0x25: val = [OP.local_get, L_WORD].concat(shiftH, [OP.i32_shr_u, OP.i32_const], sleb(0xFFFF), [OP.i32_and, OP.i64_extend_i32_u]); break;
      case 0x21: val = [OP.local_get, L_WORD].concat(shiftH, [OP.i32_shr_u, OP.i32_const], sleb(0xFFFF), [OP.i32_and, OP.i32_extend16_s, OP.i64_extend_i32_s]); break;
    }
    return [].concat(
      C.read(rs), [OP.i32_wrap_i64, OP.i32_const], sleb(imm), [OP.i32_add, OP.local_set, L_ADDR],
      [OP.local_get, L_ADDR, OP.i32_const, 0x10, OP.i32_shr_u, OP.i32_const, 0x02, OP.i32_shl],
      [OP.i32_load, 0x02], leb(tableBase),
      [OP.i32_const], sleb(cmpVal), [OP.i32_eq],
      [OP.if_, OP.void_],
        [OP.local_get, L_ADDR, OP.i32_const], sleb(0xFFFFFC), [OP.i32_and],
        [OP.i32_load, 0x02], leb(p.dramBase), [OP.local_set, L_WORD],
        val, C.writeFromStack(rt), // join: rt loaded+dirty (slow arm refreshes the local; its redundant flush is benign)
      [OP.else_],
        // continue-after-fallback: snapshot-flush (compile-state untouched —
        // the redundant later flush rewrites identical values), run the
        // interp op, then refresh ONLY the op's write-set (rt) into its
        // local so both arms join in the same compile-state (rt loaded).
        // PC divergence (TLB exception) still exits.
        C.flushSnapshot(),
        storeI32Const(p.pcGlobal, instrPtr),
        [OP.i32_const], sleb(opsIdx), [OP.call_indirect, 0x00, 0x00],
        loadI64(p.regBase + rt * 8), [OP.local_set], leb(L_REG0 + rt),
        loadI32(p.pcGlobal), [OP.i32_const], sleb(instrPtr + p.stride), [OP.i32_ne],
        [OP.br_if].concat(leb(exitDepth + 1)),
      [OP.end]
    );
  }

  // CHECK_MEMORY mirror (cached_interp.c): if (!invalid_code[a>>12]) and the
  // page block instr at (a&0xFFF)/4 has ops != NOTCOMPILED, mark the page
  // invalid; blocks[x] dereferenced only under invalid_code[x]==0.
  function checkMemoryBytes(p) {
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

  // SW/SB/SH: fast path writes the host-endian u32 dram array with the
  // mask-merge write_rdram_dram performs (SW mask ~0 = plain store), then
  // mirrors CHECK_MEMORY (cached_interp.c): if (!invalid_code[a>>12]) and
  // the page block instr at (a&0xFFF)/4 has ops != NOTCOMPILED, mark the
  // page invalid. blocks[x] is only dereferenced when invalid_code[x]==0,
  // exactly like the interpreter (a page with no block has invalid_code 1).
  function emitStore(word, instrPtr, p, C, opsIdx, exitDepth) {
    var op = (word >>> 26) & 0x3F;
    if (op !== 0x28 && op !== 0x29 && op !== 0x2B) return null;
    var rs = (word >>> 21) & 0x1F, rt = (word >>> 16) & 0x1F;
    var imm = sext16(word & 0xFFFF);
    var tableBase, cmpVal;
    if (op === 0x2B) { tableBase = p.writememW; cmpVal = p.wrRdram; }
    else if (op === 0x28) { tableBase = p.writememB; cmpVal = p.wrRdramB; }
    else { tableBase = p.writememH; cmpVal = p.wrRdramH; }
    var shiftB = [OP.local_get, L_ADDR, OP.i32_const, 0x03, OP.i32_and, OP.i32_const, 0x03, OP.i32_xor, OP.i32_const, 0x03, OP.i32_shl];
    var shiftH = [OP.local_get, L_ADDR, OP.i32_const, 0x02, OP.i32_and, OP.i32_const, 0x02, OP.i32_xor, OP.i32_const, 0x03, OP.i32_shl];
    // dram word address bytes (push i32 address of the containing word)
    var wordAddr = [OP.local_get, L_ADDR, OP.i32_const].concat(sleb(0xFFFFFC), [OP.i32_and]);
    var storeBytes;
    if (op === 0x2B) {
      // SW: dram[word] = (u32)reg[rt]
      storeBytes = wordAddr.concat(C.read(rt), [OP.i32_wrap_i64], [OP.i32_store, 0x02], leb(p.dramBase));
    } else {
      var isByte = (op === 0x28);
      var maskC = isByte ? 0xFF : 0xFFFF;
      var sh = isByte ? shiftB : shiftH;
      // w = dram[word]; merged = (w & ~(mask<<s)) | (((u32)rt & mask) << s)
      storeBytes = [].concat(
        wordAddr, [OP.i32_load, 0x02], leb(p.dramBase), [OP.local_set, L_WORD],
        wordAddr,
        // (w & ~(mask<<s))
        [OP.local_get, L_WORD, OP.i32_const], sleb(maskC), sh, [OP.i32_shl, OP.i32_const], sleb(-1), [OP.i32_xor, OP.i32_and],
        // ((rt & mask) << s)
        C.read(rt), [OP.i32_wrap_i64, OP.i32_const], sleb(maskC), [OP.i32_and], sh, [OP.i32_shl],
        [OP.i32_or],
        [OP.i32_store, 0x02], leb(p.dramBase)
      );
    }
    var checkMemory = checkMemoryBytes(p);
    return [].concat(
      C.read(rs), [OP.i32_wrap_i64, OP.i32_const], sleb(imm), [OP.i32_add, OP.local_set, L_ADDR],
      [OP.local_get, L_ADDR, OP.i32_const, 0x10, OP.i32_shr_u, OP.i32_const, 0x02, OP.i32_shl],
      [OP.i32_load, 0x02], leb(tableBase),
      [OP.i32_const], sleb(cmpVal), [OP.i32_eq],
      [OP.if_, OP.void_],
        storeBytes,
        checkMemory,
      [OP.else_],
        // continue-after-fallback: store ops write no guest registers, so
        // both arms join with the cache untouched; snapshot-flush keeps
        // memory current for the interp op (it reads rs/rt from reg[])
        C.flushSnapshot(),
        storeI32Const(p.pcGlobal, instrPtr),
        [OP.i32_const], sleb(opsIdx), [OP.call_indirect, 0x00, 0x00],
        loadI32(p.pcGlobal), [OP.i32_const], sleb(instrPtr + p.stride), [OP.i32_ne],
        [OP.br_if].concat(leb(exitDepth + 1)),
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
  function cuGuard(p, C, nativeBytes, instrPtr, opsIdx, exitDepth) {
    return [].concat(
      loadI32(p.cp0Status), [OP.i32_const], sleb(0x20000000), [OP.i32_and],
      [OP.if_, OP.void_],
        nativeBytes,
      [OP.else_],
        C.flushSnapshot(),
        storeI32Const(p.pcGlobal, instrPtr),
        [OP.i32_const], sleb(opsIdx), [OP.call_indirect, 0x00, 0x00],
        [OP.br].concat(leb(exitDepth + 1)),
      [OP.end]
    );
  }
  // push the float*/double* for FPR index i from the live bank
  function fprPtr(bank, i) { return [OP.i32_const, 0x00, OP.i32_load, 0x02].concat(leb(bank + i * 4)); }

  function emitCop1(word, instrPtr, p, C, opsIdx, exitDepth) {
    var op = (word >>> 26) & 0x3F;
    if (op !== 0x11) return null;
    var sub = (word >>> 21) & 0x1F;       // rs field: move/bc/fmt
    var rt = (word >>> 16) & 0x1F;        // GPR for moves; ft for arith
    var fs = (word >>> 11) & 0x1F;
    var fd = (word >>> 6) & 0x1F;
    var fn = word & 0x3F;
    var nat = null;
    if (sub === 0x00) {        // MFC1: rt = SE32(*(i32*)simple[fs])
      nat = fprPtr(p.cp1Simple, fs).concat([OP.i32_load, 0x02, 0x00], [OP.i64_extend_i32_s], C.writeFromStack(rt));
    } else if (sub === 0x04) { // MTC1: *(i32*)simple[fs] = rt32
      nat = fprPtr(p.cp1Simple, fs).concat(C.read(rt), [OP.i32_wrap_i64], [OP.i32_store, 0x02, 0x00]);
    } else if (sub === 0x01) { // DMFC1: rt = *(i64*)double[fs]
      nat = fprPtr(p.cp1Double, fs).concat([OP.i64_load, 0x03, 0x00], C.writeFromStack(rt));
    } else if (sub === 0x05) { // DMTC1
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
        default: return null; // CVT/ROUND/TRUNC/compares: explicit rounding/flags — fallback
      }
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
    } else {
      return null; // BC1 branches, fmt W/L: fallback
    }
    return cuGuard(p, C, nat, instrPtr, opsIdx, exitDepth);
  }

  // LWC1/LDC1/SWC1/SDC1: CU1 guard outside, then the same live-dispatch-table
  // fast path as integer loads/stores; FPR access through the runtime banks.
  function emitCop1Mem(word, instrPtr, p, C, opsIdx, exitDepth) {
    var op = (word >>> 26) & 0x3F;
    if (op !== 0x31 && op !== 0x35 && op !== 0x39 && op !== 0x3D) return null;
    var base = (word >>> 21) & 0x1F, ft = (word >>> 16) & 0x1F;
    var imm = sext16(word & 0xFFFF);
    var ea = C.read(base).concat([OP.i32_wrap_i64, OP.i32_const], sleb(imm), [OP.i32_add, OP.local_set, L_ADDR]);
    var tblIdx = [OP.local_get, L_ADDR, OP.i32_const, 0x10, OP.i32_shr_u, OP.i32_const, 0x02, OP.i32_shl];
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
    var nat = [].concat(
      ea,
      tblIdx, [OP.i32_load, 0x02], leb(tableBase),
      [OP.i32_const], sleb(cmpVal), [OP.i32_eq],
      [OP.if_, OP.void_],
        fast,
      [OP.else_],
        C.flushSnapshot(),
        storeI32Const(p.pcGlobal, instrPtr),
        [OP.i32_const], sleb(opsIdx), [OP.call_indirect, 0x00, 0x00],
        loadI32(p.pcGlobal), [OP.i32_const], sleb(instrPtr + p.stride), [OP.i32_ne],
        [OP.br_if].concat(leb(exitDepth + 2)), // inside cu-if + this if
      [OP.end]
    );
    return cuGuard(p, C, nat, instrPtr, opsIdx, exitDepth);
  }

  // ---- block compiler ----
  var stats = { blocks: 0, nativeOps: 0, nativeBranches: 0, nativeLoads: 0, nativeStores: 0, nativeFP: 0, fallbackOps: 0, fails: 0 };

  function compileSpan(p, Module) {
    var HEAPU32 = Module.HEAPU32;
    var C = new RegCache(p.reg);
    p.regBase = p.reg;
    p_hi_lo.hi = p.hi; p_hi_lo.lo = p.lo;
    var body = [];
    var EXIT = 1, TOP = 0;
    var i = 0;
    while (i < p.span) {
      var word = HEAPU32[(p.srcPtr >> 2) + i];
      var addr = (p.vaddr + i * 4) >>> 0;
      var instrPtr = p.entryPtr + i * p.stride;
      var nextPtr = instrPtr + p.stride;

      // (b) native branch?
      var br = null, brOut = false;
      var dec = decodeBranch(word, addr);
      if (dec && i + 1 < p.span) {
        var slotWord = HEAPU32[(p.srcPtr >> 2) + i + 1];
        var isIdle = dec.target !== null && (dec.target === addr) && (slotWord === 0);
        // _OUT mirror: runtime targets (JR/JALR) are ALWAYS the OUT path
        // (cached_interp table binds JR->JR_OUT); constant targets follow
        // recomp.c's variant conditions
        var isOut = dec.target === null || (dec.target < p.blockStart) || (dec.target >= p.blockEnd) || (addr === p.blockEnd - 4);
        // probe the slot with a throwaway cache clone — a rejected probe
        // must leave no compile-state behind
        var probeC = new RegCache(p.reg);
        probeC.loaded = C.loaded.slice(); probeC.dirty = C.dirty.slice();
        if (!isIdle && emitAlu(slotWord, probeC) !== null) { br = dec; brOut = isOut; }
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
            return emitOutJumpTail(p, tb, exitD);
          }
          return emitTailPoll(p, Cx, br.target, targetPtr, exitD).concat(
            targetIdx === 0
              ? [OP.br].concat(leb(topD))
              : storeI32Const(p.pcGlobal, targetPtr).concat([OP.br], leb(exitD)));
        }
        function skipJumpSplit(Cx, exitD, topD) {
          // if (skip_jump == 0) take else behave-as-not-taken-and-exit
          return loadI32(p.skipJump).concat([OP.i32_eqz, OP.if_, OP.void_],
            takenTail(Cx, exitD + 1, topD + 1),
            [OP.else_],
              emitTailPoll(p, Cx, fallAddr, fallPtr, exitD + 1),
              storeI32Const(p.pcGlobal, fallPtr),
              [OP.br].concat(leb(exitD + 1)),
            [OP.end]);
        }
        if (br.cond === null) {
          // unconditional: J/JAL/JR/JALR — capture, link, slot, count, flush, split
          body = body.concat(
            captureBytes,
            linkBytes,
            emitAlu(slotWord2, C),
            emitCountBatch(p, addr),
            C.flush(),
            skipJumpSplit(C, EXIT, TOP)
          );
          C.invalidate();
        } else if (!br.likely) {
          body = body.concat(
            br.cond(C),
            linkBytes,
            emitAlu(slotWord2, C),
            emitCountBatch(p, addr),
            C.flush(),
            [OP.if_, OP.void_],
              skipJumpSplit(C, EXIT + 1, TOP + 1),
            [OP.else_],
              emitTailPoll(p, C, fallAddr, fallPtr, EXIT + 1),
            [OP.end]
          );
          C.invalidate();
        } else {
          body = body.concat(
            br.cond(C),
            linkBytes,
            C.flush(),
            [OP.if_, OP.void_]
          );
          var Ct = new RegCache(p.reg);
          Ct.loaded = C.loaded.slice(); Ct.dirty = C.dirty.slice();
          body = body.concat(
            emitAlu(slotWord2, Ct),
            emitCountBatch(p, addr),
            Ct.flush(),
            skipJumpSplit(Ct, EXIT + 1, TOP + 1),
            [OP.else_],
              emitCountBatch(p, addr),
              emitTailPoll(p, C, fallAddr, fallPtr, EXIT + 1),
            [OP.end]
          );
          C.invalidate();
        }
        stats.nativeBranches++;
        i += 2;
        continue;
      }

      // (c) native load / store?
      var opsIdxL = HEAPU32[instrPtr >> 2];
      var ld = emitLoad(word, instrPtr, p, C, opsIdxL, EXIT);
      if (ld) {
        body = body.concat(ld);
        stats.nativeLoads++;
        i++;
        continue;
      }
      var st = emitStore(word, instrPtr, p, C, opsIdxL, EXIT);
      if (st) {
        body = body.concat(st);
        stats.nativeStores++;
        i++;
        continue;
      }

      // (e) COP1? (window.__jitNoFP disables FP emission for perf attribution)
      var fp = window.__jitNoFP ? null : (emitCop1(word, instrPtr, p, C, opsIdxL, EXIT) || emitCop1Mem(word, instrPtr, p, C, opsIdxL, EXIT));
      if (fp) {
        body = body.concat(fp);
        stats.nativeFP++;
        i++;
        continue;
      }

      // (a) native ALU?
      var alu = emitAlu(word, C);
      if (alu !== null) {
        body = body.concat(alu);
        stats.nativeOps++;
        i++;
        continue;
      }

      // (d) fallback: flush, call interp op, invalidate
      var opsIdx = HEAPU32[instrPtr >> 2];
      body = body.concat(
        C.flushAndInvalidate(),
        storeI32Const(p.pcGlobal, instrPtr),
        [OP.i32_const], sleb(opsIdx), [OP.call_indirect, 0x00, 0x00],
        loadI32(p.pcGlobal), [OP.i32_const], sleb(nextPtr),
        [OP.i32_ne, OP.br_if].concat(leb(EXIT))
      );
      stats.fallbackOps++;
      i++;
    }
    body = body.concat(
      C.flush(),
      storeI32Const(p.pcGlobal, p.entryPtr + p.span * p.stride)
    );

    var full = [0x04, 0x02, 0x7F, 0x20, 0x7E, 0x01, 0x7E, 0x01, 0x7F,  // locals: 2xi32, 32xi64 regs, i64 scratch, i32 jump-target
      OP.block, OP.void_,
      OP.loop, OP.void_]
      .concat(body,
      [OP.end, OP.end, OP.end]);

    var typeSec = section(1, [].concat(leb(1), [0x60, 0x00, 0x00]));
    var importSec = section(2, [].concat(leb(2),
      [1, 0x65, 1, 0x74, 0x01, 0x70, 0x00, 0x00],
      [1, 0x65, 1, 0x6D, 0x02, 0x00, 0x00]));
    var funcSec = section(3, [].concat(leb(1), leb(0)));
    var exportSec = section(7, [].concat(leb(1), [1, 0x66, 0x00], leb(0)));
    var codeSec = section(10, [].concat(leb(1), leb(full.length), full));
    var bytes = new Uint8Array([0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00]
      .concat(typeSec, importSec, funcSec, exportSec, codeSec));
    try {
      var mod = new WebAssembly.Module(bytes);
      var inst = new WebAssembly.Instance(mod, { e: { t: Module.wasmTable, m: Module.wasmMemory } });
      var idx = Module.wasmTable.length;
      Module.wasmTable.grow(1);
      Module.wasmTable.set(idx, inst.exports.f);
      stats.blocks++;
      return idx;
    } catch (e) {
      stats.fails++;
      if (stats.fails <= 3) console.error('[bementalJIT] compile failed:', e, 'span', p.span, 'vaddr', (p.vaddr >>> 0).toString(16));
      return 0;
    }
  }

  window.bementalMips = { compileSpan: compileSpan, stats: stats };
})();
