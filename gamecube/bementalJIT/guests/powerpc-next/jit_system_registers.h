#pragma once
//
// jit_system_registers.h — Phase 4 part 3. mfspr / mtspr / mfmsr /
// mtmsr / mftb. The CR-field ops (mfcr/mtcrf/mcrf) and segment-register
// ops (mtsr/mfsr/mtsrin/mfsrin/tlbie) are deferred — they require the
// Dolphin u64 CR-encoding helpers (Phase 4.5) or are rarely-emitted
// privileged ops (deferred indefinitely).

#include "bementalJIT/types.h"
#include "code_op.h"
#include "fpr_reg_cache.h"
#include "reg_cache.h"

class WasmModuleBuilder;

namespace bemental::powerpc {


void emit_mfspr(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                u32 ctx_ptr);
void emit_mtspr(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                u32 ctx_ptr);
void emit_mfmsr(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                u32 ctx_ptr);
void emit_mtmsr(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                u32 ctx_ptr);

// CR-pack/unpack and segment/TLB privileged ops. All fall back to interp.
// emit_fallback_interp inlines the WIMPORT_INTERP call+flush. The mtsr/tlbie
// family additionally end the block (MMU recompute boundary in Dolphin).
// gekko_emit.cpp:2526-2530 / :2677-2681 — `emit_fallback(c)` + `block_end`.
void emit_mfcr   (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                  u32 ctx_ptr);
void emit_mtcrf  (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                  u32 ctx_ptr);
void emit_mtsr   (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                  u32 ctx_ptr);
void emit_mfsr   (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                  u32 ctx_ptr);
void emit_mtsrin (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                  u32 ctx_ptr);
void emit_mfsrin (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                  u32 ctx_ptr);
void emit_tlbie  (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                  u32 ctx_ptr);

}  // namespace bemental::powerpc
