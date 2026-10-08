// lever_gate.h — emit-time kill switches for the 2026-10-04 exact op-count levers.
//
// Every lever behind this gate is ON by default and is claimed BIT-EXACT against
// the emitted code it replaces (each lever's comment names its proof). The kill
// cell exists so ONE binary hosts both arms of a runtime matched pair: write the
// lever's bit into the cell BEFORE the blocks compile (the read is at EMIT time,
// like BEM_MIPS_FLAG_CELL / BEM_GPUIDLE_MODE_CELL) and those blocks are emitted
// exactly as before the lever landed.
//
//   BEM_LEVER_KILL_CELL  W  0 (browser-zeroed) = every lever ON; bit set = that
//                           lever OFF. The env var BJIT_LEVER_KILL (page query
//                           ?bjit_lever_kill=0x3ff, threaded by gamecube.html's
//                           ?bjit_* -> Module.ENV pass) is OR'd in, read once.
//   BEM_LEVER_CENSUS_CELL R 0x80000000 | the effective mask (arm proof).
// 0x026B3EE0..0x026B3EFC matched no 0x026B3xxx literal (hex, decimal or >>2
// index form) anywhere in the tree when taken (grep, 2026-10-04), and no range
// writer covers them (late-EFB ring ends 0x026B3E90, DSP diag ring 0x026B3210);
// the neighbours are the chain selector 0x026B3ED4 and the pre-load-drop census
// 0x026B3ED8.
//
// With g_bem_lc_base == 0 (unit tests, small heaps) the cell is not read and every
// lever is ON — the tests exercise the shipping arm.
#pragma once

#include "bementalJIT/types.h"

namespace bemental::powerpc {

constexpr u32 BEM_LEVER_KILL_CELL = 0x026B3EE0u;
// R  0x80000000 | the effective kill mask (cell | BJIT_LEVER_KILL env), rewritten
//    on every lever query; 0 = no block has been emitted under the gate yet.
constexpr u32 BEM_LEVER_CENSUS_CELL = 0x026B3EE4u;

// Single-precision fused multiply-add fast arm (emit_single_fma_lane): exact
// tie-corrected arm for f32-valued a/c, and the scalar op59 family routed to it.
constexpr u32 BEM_LEVER_FMA_SINGLE = 1u << 0;
// (bit 1 reserved: a double-precision fma fast arm for f32-valued a/c was
// built and DROPPED 2026-10-04 — SAB's op63 fma sites are Newton-Raphson
// refinements on full-precision doubles, so the guard never passed and only
// added ops: fnmsub 369 -> 392 executed ops/occurrence in block_replay.)
// ps_muls0/ps_muls1 f64x2 arm when both inputs are Single-resident.
constexpr u32 BEM_LEVER_PS_MULS_SIMD = 1u << 2;
// lfd/lfdu/stfs/stfsu/stfsx without the mid-block frc.Flush (the flush-narrow
// already applied to lfs/psq_l/psq_st and the integer paths).
constexpr u32 BEM_LEVER_FPMEM_NOFLUSH = 1u << 3;
// stfs/stfsu/stfsx of a Single-resident FPR stores its f32 lane bits directly.
constexpr u32 BEM_LEVER_STFS_SINGLE = 1u << 4;
// emit_psq_convert_to_double (the NaN-exact f32->f64 widen) as a typed `if`
// instead of a `select`, so the Inf/NaN splice arm only runs when taken.
constexpr u32 BEM_LEVER_WIDEN_BRANCH = 1u << 5;
// Integer load/store (emit_load_common / emit_store_common): the pre-op ctx.PC
// store and the GPR flush move from the common path into the slow arms' host
// calls (LoadStoreParams::defer_pc / host_rc).
constexpr u32 BEM_LEVER_MEM_SLOWARM = 1u << 6;
// Fastmem accesses fold the MEM1 base into the memarg offset, and integer
// loads commit straight into rt (no LOCAL_TMP_FPVAL park + copy).
constexpr u32 BEM_LEVER_FASTMEM_LEAN = 1u << 7;
// Scalar fadds/fsubs/fmuls/fdivs on Single-resident inputs stay Single; fmuls
// skips Force25Bit for an f32-valued Double c.
constexpr u32 BEM_LEVER_FP_SINGLE_ARITH = 1u << 8;
// FPRRegCache::EmitPromoteToDouble widens both lanes with one
// f64x2.promote_low_f32x4 when no lane is Inf/NaN.
constexpr u32 BEM_LEVER_PROMOTE_SIMD = 1u << 9;
// Block terminal: chain to the terminator's STATIC b/bc successors through
// compile-time-constant dispatch buckets (PC compare first).
constexpr u32 BEM_LEVER_STATIC_CHAIN = 1u << 10;
// RegCache::Bind(Write) skips the first-touch load of a GPR the current op
// does not read (CodeOp::regsIn).
constexpr u32 BEM_LEVER_WRITE_NOLOAD = 1u << 11;
// FPRRegCache::Flush batches its constant shadow-mask set/clear RMWs into one.
constexpr u32 BEM_LEVER_FLUSH_MASK_BATCH = 1u << 12;
// Mid-block coalesced taken exits (emit_coalesced_taken_exit, plain per-block
// bodies) tail-chain in-WASM to their STATIC target through the same
// downcount-bail + constant-bucket probe emit_chain_or_return gives a static
// block terminal, instead of op_return-ing every taken exit to the C loop.
constexpr u32 BEM_LEVER_TAKEN_CHAIN = 1u << 13;
// Superblocks: the block decoder follows b / bl / RAS-predicted blr into the
// next contiguous block (DecodeBlockFollow) and emits the chain as ONE function:
// GPR/FPR locals stay live across the joins, each join is serviced exactly like
// the block boundary it replaces. Read by the DECODER's caller (JitWasm::
// TryCompileBlock, block_replay compile_at), not by the emitter.
constexpr u32 BEM_LEVER_FOLLOW = 1u << 14;
// Dispatch-probe diet for plain per-block bodies (emit_chain_or_return, static
// and runtime-PC probes): bucket byte offset as PC & (MASK << 2) — equal to
// ((PC >> 2) & MASK) * 4 for EVERY u32 PC — and no `slot >= 0` test after a tag
// hit (every g_bem_disp_tag writer stores a table index >= 0 to the slot in the
// same step; every release/clear resets tag and slot together).
constexpr u32 BEM_LEVER_PROBE_DIET = 1u << 15;
// Idle-loop skip on the TAKEN back-edge only (Jit64 placement: bcx calls
// CoreTiming::Idle inside the taken path). An idle-classified block charges its
// cycles like any block and stores downcount = 0 only when its terminator
// branches back to the block start; the not-taken exit is an ordinary block exit
// instead of a clock-jump to the next event. The spinning path ends with the same
// downcount (0) as before.
constexpr u32 BEM_LEVER_IDLE_TAKEN = 1u << 16;
// Mid-block (coalesced) conditional branches flush dirty GPRs only inside the
// taken arm, which leaves the block; the fall-through keeps them dirty in their
// wasm locals until the next exit. FPRs keep the head flush (the 2026-07-23
// FPR keep-dirty attempt measured worse live; see emit_bcx).
constexpr u32 BEM_LEVER_GPR_EXIT_FLUSH = 1u << 17;
// Integer/FP-word byte swaps (emit_bswap_i32 / emit_bswap_i16 and the fastmem
// load/store value paths) through ONE i8x16.shuffle on lane 0 instead of the
// 11-op scalar rotate/mask sequence: splat (or v128.load32_zero / load16_splat),
// shuffle, extract (or v128.store32/16_lane). Pure byte permutation; the S16
// load sign-extends with i16x8.extract_lane_s.
constexpr u32 BEM_LEVER_BSWAP_SIMD = 1u << 18;
// Eager CR-field build without the i64 assembly: lo32 and hi32 go out as two
// i32 stores (the same 8 little-endian bytes as the one i64.store), hi32's
// LT/NOT-GT bits come from two selects over baked constants, a cmpi/cmpli
// immediate is a const operand (no LOCAL_TMP_IMM round trip; `a - 0` is `a`),
// and a conditional branch IMMEDIATELY after a cmp of the same field tests the
// cmp's operands directly (the PM57 CmpFuse, here with the eager store kept).
constexpr u32 BEM_LEVER_CR_LEAN = 1u << 19;
// No pre-op ctx.PC store for a branch whose NATIVE emitter writes ctx.PC on
// every path that leaves the block (b/bl, bc bo=20 / bdnz / bdz / CR-bit
// forms without LK, bclr bo=20, bcctr without a CTR/CR test): those emitters
// never read ctx.PC, and every later in-block reader of ctx.PC writes its own
// first (the BEM_LEVER_MEM_SLOWARM invariant), so the store is dead. Forms that
// fall back to the interpreter keep it.
constexpr u32 BEM_LEVER_BRANCH_NOPC = 1u << 20;
// Builder peephole over the emitted block body: `local.set X; local.get X`
// with nothing between becomes `local.tee X` (WasmModuleBuilder::op_local_get).
constexpr u32 BEM_LEVER_SET_GET_TEE = 1u << 21;
// GPR live-ins are loaded at the top of the first op that reads them
// (CodeOp::regsIn) instead of all at block entry, so a path that leaves the
// block (mid-block taken exit, superblock seam bail) before a register's first
// use never loads it. Plain blocks and superblocks built by build_block_next
// only; never in a resident (wasm `loop`) body. Any lazy load that would land
// inside a control arm aborts the build, which is redone with this lever off.
constexpr u32 BEM_LEVER_LAZY_LIVEIN = 1u << 22;
// At a flush that leaves the block (epilogue, terminal branch, seam bail,
// RAS-mispredict exit), a dirty Single FPR whose lanes have no Inf/NaN is
// written to ps0/ps1 by ONE v128.store of f64x2.promote_low_f32x4 (the
// BEM_LEVER_PROMOTE_SIMD fast arm's value) instead of two extract_lane +
// local.set + i64.store pairs; the Inf/NaN arm is unchanged.
constexpr u32 BEM_LEVER_FPR_EXIT_STORE = 1u << 23;
// Mid-block conditional branches flush FPRs only inside the taken arm (as an
// exiting flush); the fall-through keeps Singles resident and dirty. The FPR
// half of BEM_LEVER_GPR_EXIT_FLUSH.
constexpr u32 BEM_LEVER_FPR_EXIT_FLUSH = 1u << 24;
// emit_convert_to_single (Dolphin ConvertToSingle) as an `if` on the denormal
// range instead of computing both candidate values and a select.
constexpr u32 BEM_LEVER_CVT_SINGLE_BRANCH = 1u << 25;
// Integer D-form loads/stores (lwz/lbz/lhz/lha/stw/stb/sth, no update) that
// share a base GPR with no write to it in between: the first access of the
// group computes one range flag for the group's whole displacement span, and
// every access branches on that flag local (fast arm: (ra & mask) + base +
// simm) instead of computing EA + its own guard; a false flag runs the access's
// unhoisted code. build_block_next only, never in a resident loop body.
constexpr u32 BEM_LEVER_BASE_HOIST = 1u << 26;
// BEM_LEVER_MEM_SLOWARM for the memory paths it did not cover: the FP D-form
// loads/stores (lfs/lfsu/lfd/lfdu/stfs/stfsu/stfd/stfdu/psq_l/psq_lu/psq_st/
// psq_stu) and the compile-time-EA write-gather-pipe store carve-out. Their
// common-path rc.Flush and (FP: when the op is not the block's first FP op)
// pre-op ctx.PC store move into the host calls, emitted immediately before
// each arm's first host import (emit_host_call_prep) from the snapshotted
// state; the gather-pipe drain inside the append gets the same prep.
constexpr u32 BEM_LEVER_SLOWARM_FP_GP = 1u << 27;
// A block terminal b/bl/bc whose arm has just stored a constant ctx.PC runs the
// block tail (idle store, gather drain, flushes) and the static-successor chain
// INSIDE that arm, with the chain specialized to the arm's constant (no ctx.PC
// reload and compare). Plain per-block bodies only. Requires
// BEM_LEVER_STATIC_CHAIN (the chain it specializes).
constexpr u32 BEM_LEVER_KNOWN_PC_CHAIN = 1u << 28;
// BEM_LEVER_BASE_HOIST groups also admit the FP D-form accesses lfs / lfd /
// stfs / stfd / psq_l / psq_st (no update). Their fast arms branch on the
// group flag (psq: the FLOAT arm; every other psq arm computes EA itself).
constexpr u32 BEM_LEVER_BASE_HOIST_FP = 1u << 29;
// Single-FPR block-edge conversions through SIMD fast paths, each falling back
// to the unchanged scalar code: (exit) an exiting flush with >= 2
// BEM_LEVER_FPR_EXIT_STORE registers tests them for Inf/NaN ONCE (lane-wise
// unsigned max of |bits|) and stores each with one v128.store (needs
// BEM_LEVER_FLUSH_MASK_BATCH); (entry) the assumed-Single prologue loads and the
// volatile value-verify test every pair at once for "non-NaN and exact in f32"
// (promote(demote(x)) == x) and take demote(x) as the PEM ConvertToSingle.
constexpr u32 BEM_LEVER_SINGLE_EDGE_SIMD = 1u << 30;

// ---- Second kill word (levers 32+) ------------------------------------------
// BEM_LEVER_KILL_CELL's bit 31 cannot be a lever (BEM_LEVER_CENSUS_CELL uses it
// as the "published" marker), so levers from 32 on live in a second word with
// the same protocol: BEM_LEVER_KILL2_CELL W (0 = every lever ON; OR'd with env
// BJIT_LEVER_KILL2, i.e. page query ?bjit_lever_kill2=...), census at
// BEM_LEVER_CENSUS2_CELL = 0x80000000 | effective mask. 0x026B3EE8/EEC matched
// no literal in gamecube/ (hex or decimal form, grep 2026-10-08) and lie in the
// 0x026B3EE0..0x026B3EFC block lever_gate.h took on 2026-10-04.
constexpr u32 BEM_LEVER_KILL2_CELL   = 0x026B3EE8u;
constexpr u32 BEM_LEVER_CENSUS2_CELL = 0x026B3EECu;

// Lever 32 (word 2, bit 0): fcmpu/fcmpo build the CR field as one select over
// the four baked encodings (LT/GT/EQ/unordered) instead of assembling hi32/lo32
// bit by bit, and read a Single-repr operand as f64.promote_f32 of its lane 0
// (the comparison only sees order and NaN-ness, which promote and the PEM widen
// agree on) instead of promoting the register to Double.
constexpr u32 BEM_LEVER2_FCMP_SELECT = 1u << 0;
// (word 2, bits 1-2: tried 2026-10-08 and DROPPED — no pre-op ctx.PC store for
// pure FP ops measured -0.75%, under the 1% bar; fadds/fsubs/fmuls/fdivs with a
// Double input leaving a Single result measured -1.1% but changed the shadow
// single-mask column of the replay trace, so it is not a bit-identical lever.)

bool bem_lever_on(u32 bit);
bool bem_lever2_on(u32 bit);

}  // namespace bemental::powerpc
