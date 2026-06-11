#pragma once
//
// jit_load_store.h — Phase 3 integer load/store emitters. Replaces the
// path (a)/(b)/(c) soup in the live tree's emit_load_d/emit_store_d with
// a single guard-branch shape per scope-doc §4 Phase 3.
//
// Guard branch (per scope-doc §3.1):
//   ;; EA in a wasm local
//   (EA & 0x1F000000) == 0
//   AND
//   (EA & 0x01FFFFFF) < ram_size
//   if (guard):
//     fast path — direct i32.load/store with offset = mem1_base + (EA & mem1_mask)
//   else:
//     slow path — call WIMPORT_READ*/WRITE*  (MMIO routed by host handler)
//
// The path-(b) MMIO leak bug class (described in emit_path_b_correctness_bug.md)
// is structurally unreachable because the slow path is taken unconditionally
// on any out-of-MEM1 EA — including MMIO addresses like 0xCC005000 — without
// a "trust the DFA" bypass.

#include "bementalJIT/types.h"
#include "code_op.h"
#include "fpr_reg_cache.h"
#include "reg_cache.h"

class WasmModuleBuilder;

namespace bemental::powerpc {


// Per-block load/store parameters. Carry-by-value into each emit call.
struct LoadStoreParams {
    u32 ctx_ptr   = 0;   // PowerPCState address in host linear memory
    u32 mem1_base = 0;   // host pointer to MEM1 (0 disables fastmem entirely)
    u32 mem1_mask = 0;   // typically 0x01FFFFFF (32 MB minus 1)
    u32 ram_size  = 0;   // typically 0x02000000
};

// WASM import indices. Match the existing live-tree contract in
// bementalJIT/guests/powerpc/gekko_emit.h (preserved across the rebuild).
enum class LoadWidth  : u8 { U8, U16, S16, U32 };
enum class StoreWidth : u8 { U8, U16, U32 };

// D-form load: EA = (RA==0 ? 0 : gpr[RA]) + SIMM. RT receives the loaded
// value. Update mode writes EA back to RA when update=true.
void emit_load_d(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                 LoadStoreParams params, const CodeOp& op,
                 LoadWidth width, bool update);

// D-form store: EA = (RA==0 ? 0 : gpr[RA]) + SIMM. RS provides the stored
// value. Update mode writes EA back to RA when update=true.
void emit_store_d(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                  LoadStoreParams params, const CodeOp& op,
                  StoreWidth width, bool update);

// X-form load: EA = (RA==0 ? 0 : gpr[RA]) + gpr[RB].
void emit_load_x(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                 LoadStoreParams params, const CodeOp& op,
                 LoadWidth width, bool update);

// X-form store: EA = (RA==0 ? 0 : gpr[RA]) + gpr[RB].
void emit_store_x(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                  LoadStoreParams params, const CodeOp& op,
                  StoreWidth width, bool update);

// ----- FP X-form (indexed) — single-precision load / store + stfiwx.
// All three route through the host WIMPORT slow path (no fastmem). The
// FPR is stored as f64 at PowerPCState +ps0(rs) per Dolphin's paired-single
// layout. lfsx promotes the f32 in memory to f64; stfsx demotes the f64 in
// the FPR back to f32. stfiwx writes the low 32 bits of the f64 slot
// (matches Dolphin's little-endian host storage of the f64).
//
// Op31 xo: 535 lfsx, 663 stfsx, 983 stfiwx. Per gekko_emit.cpp:2847-2878
// these were the top-3 of remaining op31 interp fallbacks (= 85% of total
// op31 fallbacks in a 500K-dispatch window).
void emit_lfsx  (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                 LoadStoreParams params, const CodeOp& op);
void emit_stfsx (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                 LoadStoreParams params, const CodeOp& op);
void emit_stfiwx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                 LoadStoreParams params, const CodeOp& op);

// ----- FP D-form (immediate offset) double load / store.
// lfd (opc 50), lfdu (opc 51), stfd (opc 54), stfdu (opc 55). Slowmem-only.
void emit_lfd (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
               LoadStoreParams params, const CodeOp& op, bool update);
void emit_stfd(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
               LoadStoreParams params, const CodeOp& op, bool update);

// ----- D-form load/store-multiple (opc 46/47). Per Jit64 Jit_LoadStore.cpp.
void emit_lmw (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
               LoadStoreParams params, const CodeOp& op);
void emit_stmw(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
               LoadStoreParams params, const CodeOp& op);

// ----- FP D-form (immediate offset) single load/store (opc 48 lfs,
// 49 lfsu, 52 stfs, 53 stfsu). Store uses PEM ConvertToSingle (bit-exact
// port of Interpreter_FPUtils.h:541-562, native as of 2026-06-11).
void emit_lfs (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
               LoadStoreParams params, const CodeOp& op, bool update);
void emit_stfs(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
               LoadStoreParams params, const CodeOp& op, bool update);

}  // namespace bemental::powerpc
