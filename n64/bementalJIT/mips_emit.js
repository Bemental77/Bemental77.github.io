// bementalJIT — N64/MIPS guest emitter (per-console fork; see
// n64/docs/jit/README.md and the de-sharing rule: GC owns
// gamecube/bementalJIT, DC owns the root copy, N64 owns this one).
//
// v1 shape ("unrolled call-threaded skeleton + native ALU"):
// each compiled block is one wasm function covering a recompile_block span.
// Per instruction it either
//   (a) emits NATIVE wasm reading/writing the core's architectural state in
//       linear memory (int64_t reg[32]; MIPS-III 32-bit ops produce
//       sign-extended 64-bit results), or
//   (b) falls back: stores the instruction's precomp_instr* into the PC
//       global, call_indirects that instruction's ORIGINAL interpreter op,
//       then compares PC against the next instruction — any divergence
//       (branch taken, exception, interrupt, block end) exits the function
//       and r4300_step's dispatch resumes at the new PC.
// The interrupt/Count contract is preserved by construction: every op that
// polls gen_interrupt (branch tails, ERET, MTC0) is a fallback, and PC is
// exact at every fallback boundary, so cp0_update_count's PC->addr deltas
// are exactly what the cached interpreter produces. The differential
// harness (tools/n64_jit_diff_test.mjs) is the regression gate.
//
// Contract with the page: window.bementalMips.compileSpan(p, Module)
// returns a wasm-table index (installed by the bridge as entry->ops) or 0.
(function () {
  'use strict';

  // ---- wasm binary helpers ----
  function leb(n) { var o = []; n >>>= 0; do { var b = n & 0x7f; n >>>= 7; o.push(n ? b | 0x80 : b); } while (n); return o; }
  function sleb(n) { var o = [], more = true; n |= 0; while (more) { var b = n & 0x7f; n >>= 7; if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) more = false; else b |= 0x80; o.push(b); } return o; }
  function section(id, content) { return [id].concat(leb(content.length), content); }

  var OP = {
    block: 0x02, end: 0x0B, br_if: 0x0D, call_indirect: 0x11,
    i32_load: 0x28, i64_load: 0x29, i32_store: 0x36, i64_store: 0x37,
    i32_const: 0x41, i64_const: 0x42,
    i32_ne: 0x47, i64_lt_s: 0x53, i64_lt_u: 0x54,
    i32_add: 0x6A, i32_sub: 0x6B, i32_shl: 0x74, i32_shr_s: 0x75, i32_shr_u: 0x76,
    i64_add: 0x7C, i64_and: 0x83, i64_or: 0x84, i64_xor: 0x85,
    i32_wrap_i64: 0xA7, i64_extend_i32_s: 0xAC, i64_extend_i32_u: 0xAD,
  };

  // absolute-address loads/stores: base i32.const 0, address in the offset immediate
  function loadI64(addr) { return [OP.i32_const, 0x00, OP.i64_load, 0x03].concat(leb(addr)); }
  function loadI32(addr) { return [OP.i32_const, 0x00, OP.i32_load, 0x02].concat(leb(addr)); }
  // store: address operand must precede the value bytes
  function storeI64(addr, valueBytes) { return [OP.i32_const, 0x00].concat(valueBytes, [OP.i64_store, 0x03], leb(addr)); }
  function storeI32Const(addr, value) { return [OP.i32_const, 0x00, OP.i32_const].concat(sleb(value), [OP.i32_store, 0x02], leb(addr)); }

  function sext16(v) { return (v << 16) >> 16; }

  // ---- per-instruction native emitters ----
  // Each returns the value-producing byte sequence for the destination
  // register (64-bit on the stack), or null if the op is not handled.
  // ctx = { reg: regBase }; rs/rt/rd/sa/imm decoded from the word.
  function emitNative(word, ctx) {
    if (word === 0) return { bytes: [], dest: -1 }; // NOP: emit nothing
    var op = (word >>> 26) & 0x3F;
    var rs = (word >>> 21) & 0x1F, rt = (word >>> 16) & 0x1F, rd = (word >>> 11) & 0x1F;
    var sa = (word >>> 6) & 0x1F, fn = word & 0x3F;
    var imm = word & 0xFFFF;
    var R = function (r) { return ctx.reg + r * 8; };
    var wrap = [OP.i32_wrap_i64], xs = [OP.i64_extend_i32_s], xu = [OP.i64_extend_i32_u];
    var v;
    if (op === 0) { // SPECIAL
      switch (fn) {
        case 0x00: // SLL rd, rt, sa
          v = loadI64(R(rt)).concat(wrap, [OP.i32_const], sleb(sa), [OP.i32_shl], xs); return { bytes: v, dest: rd };
        case 0x02: // SRL
          v = loadI64(R(rt)).concat(wrap, [OP.i32_const], sleb(sa), [OP.i32_shr_u], xs); return { bytes: v, dest: rd };
        case 0x03: // SRA
          v = loadI64(R(rt)).concat(wrap, [OP.i32_const], sleb(sa), [OP.i32_shr_s], xs); return { bytes: v, dest: rd };
        case 0x04: // SLLV rd, rt, rs (wasm masks the count mod 32)
          v = loadI64(R(rt)).concat(wrap, loadI64(R(rs)), wrap, [OP.i32_shl], xs); return { bytes: v, dest: rd };
        case 0x06: // SRLV
          v = loadI64(R(rt)).concat(wrap, loadI64(R(rs)), wrap, [OP.i32_shr_u], xs); return { bytes: v, dest: rd };
        case 0x07: // SRAV
          v = loadI64(R(rt)).concat(wrap, loadI64(R(rs)), wrap, [OP.i32_shr_s], xs); return { bytes: v, dest: rd };
        case 0x21: // ADDU rd, rs, rt (32-bit add, sign-extended)
          v = loadI64(R(rs)).concat(wrap, loadI64(R(rt)), wrap, [OP.i32_add], xs); return { bytes: v, dest: rd };
        case 0x23: // SUBU
          v = loadI64(R(rs)).concat(wrap, loadI64(R(rt)), wrap, [OP.i32_sub], xs); return { bytes: v, dest: rd };
        case 0x24: // AND (full 64-bit)
          v = loadI64(R(rs)).concat(loadI64(R(rt)), [OP.i64_and]); return { bytes: v, dest: rd };
        case 0x25: // OR
          v = loadI64(R(rs)).concat(loadI64(R(rt)), [OP.i64_or]); return { bytes: v, dest: rd };
        case 0x26: // XOR
          v = loadI64(R(rs)).concat(loadI64(R(rt)), [OP.i64_xor]); return { bytes: v, dest: rd };
        case 0x27: // NOR = ~(rs | rt)
          v = loadI64(R(rs)).concat(loadI64(R(rt)), [OP.i64_or, OP.i64_const], sleb(-1), [OP.i64_xor]); return { bytes: v, dest: rd };
        case 0x2A: // SLT (64-bit signed compare)
          v = loadI64(R(rs)).concat(loadI64(R(rt)), [OP.i64_lt_s], xu); return { bytes: v, dest: rd };
        case 0x2B: // SLTU
          v = loadI64(R(rs)).concat(loadI64(R(rt)), [OP.i64_lt_u], xu); return { bytes: v, dest: rd };
        default: return null;
      }
    }
    switch (op) {
      case 0x09: // ADDIU rt, rs, imm
        v = loadI64(R(rs)).concat(wrap, [OP.i32_const], sleb(sext16(imm)), [OP.i32_add], xs); return { bytes: v, dest: rt };
      case 0x0A: // SLTI (imm sign-extended to 64, signed compare)
        v = loadI64(R(rs)).concat([OP.i64_const], sleb(sext16(imm)), [OP.i64_lt_s], xu); return { bytes: v, dest: rt };
      case 0x0B: // SLTIU (imm sign-extended, UNSIGNED compare — MIPS quirk)
        v = loadI64(R(rs)).concat([OP.i64_const], sleb(sext16(imm)), [OP.i64_lt_u], xu); return { bytes: v, dest: rt };
      case 0x0C: // ANDI (imm zero-extended, 64-bit op)
        v = loadI64(R(rs)).concat([OP.i64_const], sleb(imm), [OP.i64_and]); return { bytes: v, dest: rt };
      case 0x0D: // ORI
        v = loadI64(R(rs)).concat([OP.i64_const], sleb(imm), [OP.i64_or]); return { bytes: v, dest: rt };
      case 0x0E: // XORI
        v = loadI64(R(rs)).concat([OP.i64_const], sleb(imm), [OP.i64_xor]); return { bytes: v, dest: rt };
      case 0x0F: // LUI (sign-extended imm<<16)
        v = [OP.i64_const].concat(sleb((imm << 16) | 0)); return { bytes: v, dest: rt };
      default: return null;
    }
  }

  // ---- block compiler ----
  var stats = { blocks: 0, nativeOps: 0, fallbackOps: 0, fails: 0 };

  function compileSpan(p, Module) {
    // p = { vaddr, entryPtr, span, srcPtr, stride, addrOff, pcGlobal, reg, hi, lo }
    var HEAPU32 = Module.HEAPU32;
    var body = [OP.block, 0x40]; // (block $exit ...)
    var ctx = { reg: p.reg };
    for (var i = 0; i < p.span; i++) {
      var word = HEAPU32[(p.srcPtr >> 2) + i];
      var instrPtr = p.entryPtr + i * p.stride;
      var nextPtr = instrPtr + p.stride;
      var nat = emitNative(word, ctx);
      if (nat) {
        if (nat.dest > 0) body = body.concat(storeI64(p.reg + nat.dest * 8, nat.bytes));
        // dest 0 (r0) or NOP: discard — r0 is hardwired zero
        stats.nativeOps++;
      } else {
        var opsIdx = HEAPU32[instrPtr >> 2]; // precomp_instr.ops at offset 0
        body = body.concat(
          storeI32Const(p.pcGlobal, instrPtr),                    // PC = &instr[i]
          [OP.i32_const], sleb(opsIdx), [OP.call_indirect, 0x00, 0x00],
          loadI32(p.pcGlobal), [OP.i32_const], sleb(nextPtr),
          [OP.i32_ne, OP.br_if, 0x00]                             // diverged -> exit
        );
        stats.fallbackOps++;
      }
    }
    body = body.concat(storeI32Const(p.pcGlobal, p.entryPtr + p.span * p.stride)); // fall-through
    body.push(OP.end);   // end $exit
    body.push(OP.end);   // end function
    body.unshift(0x00);  // no locals

    var typeSec = section(1, [].concat(leb(1), [0x60, 0x00, 0x00]));
    var importSec = section(2, [].concat(leb(2),
      [1, 0x65, 1, 0x74, 0x01, 0x70, 0x00, 0x00],   // "e"."t" table funcref
      [1, 0x65, 1, 0x6D, 0x02, 0x00, 0x00]));        // "e"."m" memory
    var funcSec = section(3, [].concat(leb(1), leb(0)));
    var exportSec = section(7, [].concat(leb(1), [1, 0x66, 0x00], leb(0)));
    var codeSec = section(10, [].concat(leb(1), leb(body.length), body));
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
      if (stats.fails === 1) console.error('[bementalJIT] compile failed:', e, 'span', p.span, 'vaddr', p.vaddr.toString(16));
      return 0;
    }
  }

  window.bementalMips = { compileSpan: compileSpan, stats: stats };
})();
