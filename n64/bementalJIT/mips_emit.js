// bementalJIT — N64/MIPS guest emitter (per-console fork; see
// n64/docs/jit/README.md and the de-sharing rule: GC owns
// gamecube/bementalJIT, DC owns the root copy, N64 owns this one).
//
// v2 shape ("native ALU + native branches"):
// each compiled block is one wasm function covering a recompile_block span,
// structured as (block $exit (loop $top ...)). Per instruction:
//   (a) native ALU — wasm reading/writing the core's architectural state in
//       linear memory (int64_t reg[32]) with exact MIPS-III semantics;
//   (b) native BRANCH — mirrors cached_interp.c DECLARE_JUMP exactly (see
//       the table below), only for the PLAIN variant (in-page target, not
//       the OUT/IDLE conditions recomp.c uses) and only when the delay-slot
//       instruction is native-ALU (cannot fault → no EPC/BD exposure, the
//       skip_jump guard still mirrored). Back-edge to the block's own entry
//       continues natively via br $top — that is every hot loop, because
//       every jump target becomes its own block entry. Other targets exit
//       with PC set to the in-page precomp_instr*.
//   (c) fallback — store exact precomp_instr* into PC, call_indirect the
//       ORIGINAL interpreter op, exit the block on PC divergence.
//
// DECLARE_JUMP contract mirrored for native branches (cached_interp.c:73+):
//   take = cond(regs)            — BEFORE the delay slot
//   if (link) *link = SE32(addr+8)  — unconditionally, even for likely
//   non-likely OR taken: run delay slot;
//     Count += ((addr+8) - last_addr)>>2 * count_per_op   (cp0.c:89-97)
//   taken && !skip_jump: PC = in-page target ptr; else PC = addr+8 ptr
//   last_addr = final PC->addr
//   if (next_interrupt <= Count) gen_interrupt()  — PC global stored first
//   (gen_interrupt may move PC → re-check, exit block if diverged)
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
    i32_load: 0x28, i64_load: 0x29, i32_store: 0x36, i64_store: 0x37,
    i32_const: 0x41, i64_const: 0x42,
    i32_eqz: 0x45, i32_eq: 0x46, i32_ne: 0x47, i32_le_u: 0x4D,
    i64_eq: 0x51, i64_ne: 0x52, i64_lt_s: 0x53, i64_lt_u: 0x54, i64_gt_s: 0x55, i64_le_s: 0x57, i64_ge_s: 0x59,
    i32_add: 0x6A, i32_sub: 0x6B, i32_mul: 0x6C, i32_and: 0x71, i32_or: 0x72, i32_xor: 0x73, i32_shl: 0x74, i32_shr_s: 0x75, i32_shr_u: 0x76,
    i32_extend8_s: 0xC0, i32_extend16_s: 0xC1,
    i64_add: 0x7C, i64_and: 0x83, i64_or: 0x84, i64_xor: 0x85,
    i32_wrap_i64: 0xA7, i64_extend_i32_s: 0xAC, i64_extend_i32_u: 0xAD,
    void_: 0x40,
  };

  // absolute-address loads/stores: base i32.const 0, address in the offset immediate
  function loadI64(addr) { return [OP.i32_const, 0x00, OP.i64_load, 0x03].concat(leb(addr)); }
  function loadI32(addr) { return [OP.i32_const, 0x00, OP.i32_load, 0x02].concat(leb(addr)); }
  function storeI64(addr, valueBytes) { return [OP.i32_const, 0x00].concat(valueBytes, [OP.i64_store, 0x03], leb(addr)); }
  function storeI32(addr, valueBytes) { return [OP.i32_const, 0x00].concat(valueBytes, [OP.i32_store, 0x02], leb(addr)); }
  function storeI32Const(addr, value) { return storeI32(addr, [OP.i32_const].concat(sleb(value))); }

  function sext16(v) { return (v << 16) >> 16; }

  // ---- native ALU emitters (wave 1) ----
  // Returns { bytes (value producer, 64-bit on stack), dest } or null.
  function emitNative(word, ctx) {
    if (word === 0) return { bytes: [], dest: -1 }; // NOP
    var op = (word >>> 26) & 0x3F;
    var rs = (word >>> 21) & 0x1F, rt = (word >>> 16) & 0x1F, rd = (word >>> 11) & 0x1F;
    var sa = (word >>> 6) & 0x1F, fn = word & 0x3F;
    var imm = word & 0xFFFF;
    var R = function (r) { return ctx.reg + r * 8; };
    var wrap = [OP.i32_wrap_i64], xs = [OP.i64_extend_i32_s], xu = [OP.i64_extend_i32_u];
    var v;
    if (op === 0) {
      switch (fn) {
        case 0x00: v = loadI64(R(rt)).concat(wrap, [OP.i32_const], sleb(sa), [OP.i32_shl], xs); return { bytes: v, dest: rd };  // SLL
        case 0x02: v = loadI64(R(rt)).concat(wrap, [OP.i32_const], sleb(sa), [OP.i32_shr_u], xs); return { bytes: v, dest: rd }; // SRL
        case 0x03: v = loadI64(R(rt)).concat(wrap, [OP.i32_const], sleb(sa), [OP.i32_shr_s], xs); return { bytes: v, dest: rd }; // SRA
        case 0x04: v = loadI64(R(rt)).concat(wrap, loadI64(R(rs)), wrap, [OP.i32_shl], xs); return { bytes: v, dest: rd };       // SLLV
        case 0x06: v = loadI64(R(rt)).concat(wrap, loadI64(R(rs)), wrap, [OP.i32_shr_u], xs); return { bytes: v, dest: rd };     // SRLV
        case 0x07: v = loadI64(R(rt)).concat(wrap, loadI64(R(rs)), wrap, [OP.i32_shr_s], xs); return { bytes: v, dest: rd };     // SRAV
        case 0x21: v = loadI64(R(rs)).concat(wrap, loadI64(R(rt)), wrap, [OP.i32_add], xs); return { bytes: v, dest: rd };       // ADDU
        case 0x23: v = loadI64(R(rs)).concat(wrap, loadI64(R(rt)), wrap, [OP.i32_sub], xs); return { bytes: v, dest: rd };       // SUBU
        case 0x24: v = loadI64(R(rs)).concat(loadI64(R(rt)), [OP.i64_and]); return { bytes: v, dest: rd };                        // AND
        case 0x25: v = loadI64(R(rs)).concat(loadI64(R(rt)), [OP.i64_or]); return { bytes: v, dest: rd };                         // OR
        case 0x26: v = loadI64(R(rs)).concat(loadI64(R(rt)), [OP.i64_xor]); return { bytes: v, dest: rd };                        // XOR
        case 0x27: v = loadI64(R(rs)).concat(loadI64(R(rt)), [OP.i64_or, OP.i64_const], sleb(-1), [OP.i64_xor]); return { bytes: v, dest: rd }; // NOR
        case 0x2A: v = loadI64(R(rs)).concat(loadI64(R(rt)), [OP.i64_lt_s], xu); return { bytes: v, dest: rd };                   // SLT
        case 0x2B: v = loadI64(R(rs)).concat(loadI64(R(rt)), [OP.i64_lt_u], xu); return { bytes: v, dest: rd };                   // SLTU
        default: return null;
      }
    }
    switch (op) {
      case 0x09: v = loadI64(R(rs)).concat(wrap, [OP.i32_const], sleb(sext16(imm)), [OP.i32_add], xs); return { bytes: v, dest: rt }; // ADDIU
      case 0x0A: v = loadI64(R(rs)).concat([OP.i64_const], sleb(sext16(imm)), [OP.i64_lt_s], xu); return { bytes: v, dest: rt };      // SLTI
      case 0x0B: v = loadI64(R(rs)).concat([OP.i64_const], sleb(sext16(imm)), [OP.i64_lt_u], xu); return { bytes: v, dest: rt };      // SLTIU
      case 0x0C: v = loadI64(R(rs)).concat([OP.i64_const], sleb(imm), [OP.i64_and]); return { bytes: v, dest: rt };                   // ANDI
      case 0x0D: v = loadI64(R(rs)).concat([OP.i64_const], sleb(imm), [OP.i64_or]); return { bytes: v, dest: rt };                    // ORI
      case 0x0E: v = loadI64(R(rs)).concat([OP.i64_const], sleb(imm), [OP.i64_xor]); return { bytes: v, dest: rt };                   // XORI
      case 0x0F: v = [OP.i64_const].concat(sleb((imm << 16) | 0)); return { bytes: v, dest: rt };                                     // LUI
      default: return null;
    }
  }

  function emitNativeStore(word, ctx, p) {
    var nat = emitNative(word, ctx);
    if (!nat) return null;
    // dest -1 = NOP (word 0). For every other op MIRROR the interpreter,
    // which writes through &reg[dest] even when dest is r0 — subsequent
    // reads of r0 then see that value, and the differential gate compares
    // reg[0] too. (MIPS spec discards r0 writes; this core does not.)
    if (nat.dest >= 0) return storeI64(p.reg + nat.dest * 8, nat.bytes);
    return []; // NOP
  }

  // ---- native branch decoding (wave 2) ----
  // Returns { cond: bytes producing i32 take (or null for unconditional),
  //           link: bool, likely: bool, target: u32 } or null if not a
  //   natively supported branch/jump opcode.
  function decodeBranch(word, addr, ctx) {
    var op = (word >>> 26) & 0x3F;
    var rs = (word >>> 21) & 0x1F, rt = (word >>> 16) & 0x1F;
    var imm = sext16(word & 0xFFFF);
    var R = function (r) { return ctx.reg + r * 8; };
    var bTarget = (addr + 4 + imm * 4) >>> 0;
    function cmpRR(opc) { return loadI64(R(rs)).concat(loadI64(R(rt)), [opc]); }
    function cmpRZ(opc) { return loadI64(R(rs)).concat([OP.i64_const, 0x00, opc]); }
    switch (op) {
      case 0x02: return { cond: null, link: false, likely: false, target: (((addr + 4) & 0xF0000000) | ((word & 0x3FFFFFF) << 2)) >>> 0 }; // J
      case 0x03: return { cond: null, link: true, likely: false, target: (((addr + 4) & 0xF0000000) | ((word & 0x3FFFFFF) << 2)) >>> 0 };  // JAL
      case 0x04: return { cond: cmpRR(OP.i64_eq), link: false, likely: false, target: bTarget };  // BEQ
      case 0x05: return { cond: cmpRR(OP.i64_ne), link: false, likely: false, target: bTarget };  // BNE
      case 0x06: if (rt !== 0) return null; return { cond: cmpRZ(OP.i64_le_s), link: false, likely: false, target: bTarget }; // BLEZ
      case 0x07: if (rt !== 0) return null; return { cond: cmpRZ(OP.i64_gt_s), link: false, likely: false, target: bTarget }; // BGTZ
      case 0x14: return { cond: cmpRR(OP.i64_eq), link: false, likely: true, target: bTarget };   // BEQL
      case 0x15: return { cond: cmpRR(OP.i64_ne), link: false, likely: true, target: bTarget };   // BNEL
      case 0x16: if (rt !== 0) return null; return { cond: cmpRZ(OP.i64_le_s), link: false, likely: true, target: bTarget };  // BLEZL
      case 0x17: if (rt !== 0) return null; return { cond: cmpRZ(OP.i64_gt_s), link: false, likely: true, target: bTarget };  // BGTZL
      case 0x01: // REGIMM
        switch (rt) {
          case 0x00: return { cond: cmpRZ(OP.i64_lt_s), link: false, likely: false, target: bTarget }; // BLTZ
          case 0x01: return { cond: cmpRZ(OP.i64_ge_s), link: false, likely: false, target: bTarget }; // BGEZ
          case 0x02: return { cond: cmpRZ(OP.i64_lt_s), link: false, likely: true, target: bTarget };  // BLTZL
          case 0x03: return { cond: cmpRZ(OP.i64_ge_s), link: false, likely: true, target: bTarget };  // BGEZL
          case 0x10: return { cond: cmpRZ(OP.i64_lt_s), link: true, likely: false, target: bTarget };  // BLTZAL
          case 0x11: return { cond: cmpRZ(OP.i64_ge_s), link: true, likely: false, target: bTarget };  // BGEZAL
          case 0x12: return { cond: cmpRZ(OP.i64_lt_s), link: true, likely: true, target: bTarget };   // BLTZALL
          case 0x13: return { cond: cmpRZ(OP.i64_ge_s), link: true, likely: true, target: bTarget };   // BGEZALL
          default: return null;
        }
      default: return null;
    }
  }

  // Count += ((addr+8) - last_addr)>>2 * cpo ; (matches cp0_update_count with
  // PC at the post-slot instruction in every DECLARE_JUMP path)
  function emitCountBatch(p, addr) {
    var val = [OP.i32_const].concat(sleb((addr + 8) | 0),
      loadI32(p.lastAddr), [OP.i32_sub, OP.i32_const, 0x02, OP.i32_shr_u],
      [OP.i32_const], sleb(p.cpo), [OP.i32_mul],
      loadI32(p.count), [OP.i32_add]);
    return storeI32(p.count, val);
  }

  // last_addr = finalAddr; if (next_interrupt <= Count) { PC = finalPtr;
  // gen_interrupt(); if (PC != finalPtr) br $exit(depth exitDepth); }
  function emitTailPoll(p, finalAddr, finalPtr, exitDepth) {
    return storeI32Const(p.lastAddr, finalAddr | 0).concat(
      loadI32(p.nextInt), loadI32(p.count), [OP.i32_le_u],
      [OP.if_, OP.void_],
      storeI32Const(p.pcGlobal, finalPtr),
      [OP.i32_const], sleb(p.genInt), [OP.call_indirect, 0x00, 0x00],
      loadI32(p.pcGlobal), [OP.i32_const], sleb(finalPtr), [OP.i32_ne],
      [OP.br_if].concat(leb(exitDepth + 1)), // +1: inside the if block
      [OP.end]
    );
  }

  // ---- native loads (wave 3) ----
  // Fast path mirrors the interpreter's LIVE dispatch: load
  // readmem*[a>>16] from linear memory and compare against read_rdram* —
  // framebuffer-protection remapping (saved_readmem swap) therefore takes
  // the fallback automatically. dram is a host-endian u32 array indexed by
  // (a & 0xffffff)>>2; byte/half extraction uses the BE shifts
  // (BSHIFT=((a&3)^3)<<3, HSHIFT=((a&2)^2)<<3) and LB/LH sign-extend
  // (SE8/SE16) exactly like readb/readh + the op bodies.
  // locals: 0 = address (i32), 1 = fetched word (i32)
  function emitLoad(word, instrPtr, nextPtr, p, ctx) {
    var op = (word >>> 26) & 0x3F;
    if (op !== 0x20 && op !== 0x21 && op !== 0x23 && op !== 0x24 && op !== 0x25 && op !== 0x27) return null;
    var rs = (word >>> 21) & 0x1F, rt = (word >>> 16) & 0x1F;
    var imm = sext16(word & 0xFFFF);
    var R = function (r) { return ctx.reg + r * 8; };
    var tableBase, cmpVal;
    if (op === 0x23 || op === 0x27) { tableBase = p.readmemW; cmpVal = p.rdRdram; }
    else if (op === 0x20 || op === 0x24) { tableBase = p.readmemB; cmpVal = p.rdRdramB; }
    else { tableBase = p.readmemH; cmpVal = p.rdRdramH; }
    var shiftB = [OP.local_get, 0x00, OP.i32_const, 0x03, OP.i32_and, OP.i32_const, 0x03, OP.i32_xor, OP.i32_const, 0x03, OP.i32_shl];
    var shiftH = [OP.local_get, 0x00, OP.i32_const, 0x02, OP.i32_and, OP.i32_const, 0x02, OP.i32_xor, OP.i32_const, 0x03, OP.i32_shl];
    var val;
    switch (op) {
      case 0x23: val = [OP.local_get, 0x01, OP.i64_extend_i32_s]; break;                    // LW: SE32
      case 0x27: val = [OP.local_get, 0x01, OP.i64_extend_i32_u]; break;                    // LWU
      case 0x24: val = [OP.local_get, 0x01].concat(shiftB, [OP.i32_shr_u, OP.i32_const], sleb(0xFF), [OP.i32_and, OP.i64_extend_i32_u]); break; // LBU
      case 0x20: val = [OP.local_get, 0x01].concat(shiftB, [OP.i32_shr_u, OP.i32_const], sleb(0xFF), [OP.i32_and, OP.i32_extend8_s, OP.i64_extend_i32_s]); break; // LB: SE8
      case 0x25: val = [OP.local_get, 0x01].concat(shiftH, [OP.i32_shr_u, OP.i32_const], sleb(0xFFFF), [OP.i32_and, OP.i64_extend_i32_u]); break; // LHU
      case 0x21: val = [OP.local_get, 0x01].concat(shiftH, [OP.i32_shr_u, OP.i32_const], sleb(0xFFFF), [OP.i32_and, OP.i32_extend16_s, OP.i64_extend_i32_s]); break; // LH: SE16
    }
    var opsIdx = null; // filled by caller-provided fallback bytes
    return [].concat(
      // a = (i32)reg[rs] + imm  -> local 0
      loadI64(R(rs)), [OP.i32_wrap_i64, OP.i32_const], sleb(imm), [OP.i32_add, OP.local_set, 0x00],
      // readmem*[a>>16] == read_rdram* ?
      [OP.local_get, 0x00, OP.i32_const, 0x10, OP.i32_shr_u, OP.i32_const, 0x02, OP.i32_shl],
      [OP.i32_load, 0x02], leb(tableBase),
      [OP.i32_const], sleb(cmpVal), [OP.i32_eq],
      [OP.if_, OP.void_],
        // w = dram[(a & 0xfffffc)]  -> local 1
        [OP.local_get, 0x00, OP.i32_const], sleb(0xFFFFFC), [OP.i32_and],
        [OP.i32_load, 0x02], leb(p.dramBase), [OP.local_set, 0x01],
        storeI64(R(rt), val), // mirrors interp: writes reg[0] too when rt==0
      [OP.else_],
        storeI32Const(p.pcGlobal, instrPtr),
        [OP.i32_const], sleb(Module_opsIdx(instrPtr)), [OP.call_indirect, 0x00, 0x00],
        loadI32(p.pcGlobal), [OP.i32_const], sleb(nextPtr), [OP.i32_ne],
        [OP.br_if, 0x02], // $exit from inside if/else
      [OP.end]
    );
  }
  var Module_opsIdx = null; // bound per-compile (reads precomp_instr.ops)

  // ---- block compiler ----
  var stats = { blocks: 0, nativeOps: 0, nativeBranches: 0, nativeLoads: 0, fallbackOps: 0, fails: 0 };

  function compileSpan(p0, Module) {
    var HEAPU32 = Module.HEAPU32;
    var p = p0; // { vaddr, entryPtr, span, srcPtr, stride, addrOff, pcGlobal,
                //   reg, hi, lo, blockStart, blockEnd, lastAddr, nextInt,
                //   count, cpo, skipJump, genInt }
    var ctx = { reg: p.reg };
    Module_opsIdx = function (instrPtr) { return HEAPU32[instrPtr >> 2]; };
    var body = [];
    // depths inside the main body: br $top = 0 (loop), br $exit = 1 (block)
    var EXIT = 1, TOP = 0;
    var i = 0;
    while (i < p.span) {
      var word = HEAPU32[(p.srcPtr >> 2) + i];
      var addr = (p.vaddr + i * 4) >>> 0;
      var instrPtr = p.entryPtr + i * p.stride;
      var nextPtr = instrPtr + p.stride;

      // (b) native branch?
      var br = null, slotStore = null;
      var dec = decodeBranch(word, addr, ctx);
      if (dec && i + 1 < p.span) {
        var slotWord = HEAPU32[(p.srcPtr >> 2) + i + 1];
        var isIdle = (dec.target === addr) && (slotWord === 0);
        var isOut = (dec.target < p.blockStart) || (dec.target >= p.blockEnd) || (addr === p.blockEnd - 4);
        slotStore = emitNativeStore(slotWord, ctx, p);
        if (!isIdle && !isOut && slotStore !== null) br = dec;
      }
      if (br) {
        var targetIdx = ((br.target - p.vaddr) | 0) / 4; // page-relative; may be outside the span
        var targetPtr = p.entryPtr + targetIdx * p.stride;
        var fallPtr = p.entryPtr + (i + 2) * p.stride;
        var fallAddr = (addr + 8) | 0;
        var linkBytes = br.link ? storeI64(p.reg + 31 * 8, [OP.i64_const].concat(sleb((addr + 8) | 0))) : [];
        if (br.cond === null) {
          // unconditional J/JAL: link, slot, count, skip_jump-guarded jump
          body = body.concat(
            linkBytes, slotStore,
            emitCountBatch(p, addr),
            loadI32(p.skipJump), [OP.i32_eqz, OP.if_, OP.void_],
              emitTailPoll(p, br.target, targetPtr, EXIT + 1),
              (targetIdx === 0
                ? [OP.br].concat(leb(TOP + 1))
                : storeI32Const(p.pcGlobal, targetPtr).concat([OP.br], leb(EXIT + 1))),
            [OP.else_],
              emitTailPoll(p, fallAddr, fallPtr, EXIT + 1),
              storeI32Const(p.pcGlobal, fallPtr),
              [OP.br].concat(leb(EXIT + 1)),
            [OP.end]
          );
        } else if (!br.likely) {
          // non-likely: cond BEFORE slot; link + slot unconditional
          body = body.concat(
            br.cond,                                          // i32 take on stack
            linkBytes, slotStore,
            emitCountBatch(p, addr),
            [OP.if_, OP.void_],
              loadI32(p.skipJump), [OP.i32_eqz, OP.if_, OP.void_],
                emitTailPoll(p, br.target, targetPtr, EXIT + 2),
                (targetIdx === 0
                  ? [OP.br].concat(leb(TOP + 2))
                  : storeI32Const(p.pcGlobal, targetPtr).concat([OP.br], leb(EXIT + 2))),
              [OP.else_],
                emitTailPoll(p, fallAddr, fallPtr, EXIT + 2),
                storeI32Const(p.pcGlobal, fallPtr),
                [OP.br].concat(leb(EXIT + 2)),
              [OP.end],
            [OP.else_],
              emitTailPoll(p, fallAddr, fallPtr, EXIT + 1),
            [OP.end]
          );
        } else {
          // likely: link unconditional (matches the macro); slot + jump only
          // when taken; not-taken still batches Count on addr+8 and polls
          body = body.concat(
            br.cond,
            linkBytes,
            [OP.if_, OP.void_],
              slotStore,
              emitCountBatch(p, addr),
              loadI32(p.skipJump), [OP.i32_eqz, OP.if_, OP.void_],
                emitTailPoll(p, br.target, targetPtr, EXIT + 2),
                (targetIdx === 0
                  ? [OP.br].concat(leb(TOP + 2))
                  : storeI32Const(p.pcGlobal, targetPtr).concat([OP.br], leb(EXIT + 2))),
              [OP.else_],
                emitTailPoll(p, fallAddr, fallPtr, EXIT + 2),
                storeI32Const(p.pcGlobal, fallPtr),
                [OP.br].concat(leb(EXIT + 2)),
              [OP.end],
            [OP.else_],
              emitCountBatch(p, addr),
              emitTailPoll(p, fallAddr, fallPtr, EXIT + 1),
            [OP.end]
          );
        }
        stats.nativeBranches++;
        i += 2; // branch + consumed delay slot
        continue;
      }

      // (a2) native load?
      var ld = emitLoad(word, instrPtr, nextPtr, p, ctx);
      if (ld) {
        body = body.concat(ld);
        stats.nativeLoads++;
        i++;
        continue;
      }

      // (a) native ALU?
      var natStore = emitNativeStore(word, ctx, p);
      if (natStore !== null) {
        body = body.concat(natStore);
        stats.nativeOps++;
        i++;
        continue;
      }

      // (c) fallback
      var opsIdx = HEAPU32[instrPtr >> 2];
      body = body.concat(
        storeI32Const(p.pcGlobal, instrPtr),
        [OP.i32_const], sleb(opsIdx), [OP.call_indirect, 0x00, 0x00],
        loadI32(p.pcGlobal), [OP.i32_const], sleb(nextPtr),
        [OP.i32_ne, OP.br_if].concat(leb(EXIT))
      );
      stats.fallbackOps++;
      i++;
    }
    // natural fall-through past the span
    body = body.concat(storeI32Const(p.pcGlobal, p.entryPtr + p.span * p.stride));

    var full = [0x01, 0x02, 0x7F,           // locals: 2 x i32 (addr, word)
      OP.block, OP.void_,                   // $exit
      OP.loop, OP.void_]                    // $top
      .concat(body,
      [OP.end,                              // end $top (loop falls through)
       OP.end,                              // end $exit
       OP.end]);                            // end function

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
