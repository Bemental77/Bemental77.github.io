#pragma once
//
// jit_compare.h — Phase 4.5 compare ops (cmp/cmpi/cmpl/cmpli). Uses
// the cr_encode helpers to set CR[crfd] in Dolphin's u64 encoding.

#include "bementalJIT/types.h"
#include "code_op.h"
#include "fpr_reg_cache.h"
#include "reg_cache.h"

class WasmModuleBuilder;

namespace bemental::powerpc {


void emit_cmpi (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                u32 ctx_ptr);
void emit_cmpli(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                u32 ctx_ptr);
void emit_cmp  (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                u32 ctx_ptr);
void emit_cmpl (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                u32 ctx_ptr);

}  // namespace bemental::powerpc
