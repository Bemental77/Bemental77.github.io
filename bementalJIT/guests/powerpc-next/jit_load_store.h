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
void emit_load_d(WasmModuleBuilder& wb, RegCache& rc,
                 LoadStoreParams params, const CodeOp& op,
                 LoadWidth width, bool update);

// D-form store: EA = (RA==0 ? 0 : gpr[RA]) + SIMM. RS provides the stored
// value. Update mode writes EA back to RA when update=true.
void emit_store_d(WasmModuleBuilder& wb, RegCache& rc,
                  LoadStoreParams params, const CodeOp& op,
                  StoreWidth width, bool update);

// X-form load: EA = (RA==0 ? 0 : gpr[RA]) + gpr[RB].
void emit_load_x(WasmModuleBuilder& wb, RegCache& rc,
                 LoadStoreParams params, const CodeOp& op,
                 LoadWidth width, bool update);

// X-form store: EA = (RA==0 ? 0 : gpr[RA]) + gpr[RB].
void emit_store_x(WasmModuleBuilder& wb, RegCache& rc,
                  LoadStoreParams params, const CodeOp& op,
                  StoreWidth width, bool update);

}  // namespace bemental::powerpc
