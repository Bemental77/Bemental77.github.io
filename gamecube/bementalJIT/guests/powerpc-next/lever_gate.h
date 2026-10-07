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

bool bem_lever_on(u32 bit);

}  // namespace bemental::powerpc
