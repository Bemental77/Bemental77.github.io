#pragma once
//
// jit_system_registers.h — Phase 4 part 3. mfspr / mtspr / mfmsr /
// mtmsr / mftb. The CR-field ops (mfcr/mtcrf/mcrf) and segment-register
// ops (mtsr/mfsr/mtsrin/mfsrin/tlbie) are deferred — they require the
// Dolphin u64 CR-encoding helpers (Phase 4.5) or are rarely-emitted
// privileged ops (deferred indefinitely).

#include "bementalJIT/types.h"
#include "code_op.h"
#include "reg_cache.h"

class WasmModuleBuilder;

namespace bemental::powerpc {


void emit_mfspr(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                u32 ctx_ptr);
void emit_mtspr(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                u32 ctx_ptr);
void emit_mfmsr(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                u32 ctx_ptr);
void emit_mtmsr(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                u32 ctx_ptr);

}  // namespace bemental::powerpc
