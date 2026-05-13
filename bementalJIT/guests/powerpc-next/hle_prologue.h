#pragma once
//
// hle_prologue.h — Phase 4 port of the HLE prologue from live
// gekko_emit.cpp:1958-1975. Emit at the top of every block:
//   i32.const(start_pc)
//   call WIMPORT_HLE_CHECK
//   if nonzero: load PC and return early
//   else: drop the result and fall through.

#include "bementalJIT/types.h"

class WasmModuleBuilder;

namespace bemental::powerpc {


// WIMPORT indices preserved from live gekko_emit.h (11-import shape).
//   0  ppc_read8         (i32) -> i32
//   1  ppc_read16
//   2  ppc_read32
//   3  ppc_write8        (i32, i32) -> ()
//   4  ppc_write16
//   5  ppc_write32
//   6  ppc_interp        (i32, i32) -> ()
//   7  ppc_check_exc     (i32) -> i32
//   8  ppc_break_block   (i32, i32) -> ()
//   9  ppc_hle_check     (i32) -> i32
//  10  ppc_hle_fire      (i32, i32) -> i32
constexpr u32 WIMPORT_HLE_CHECK = 9;
constexpr u32 WIMPORT_HLE_FIRE  = 10;
constexpr u32 WIMPORT_COUNT     = 11;

void emit_hle_prologue(WasmModuleBuilder& wb, u32 ctx_ptr, u32 start_pc);

}  // namespace bemental::powerpc
