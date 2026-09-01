#pragma once
//
// jit_compare.h — Phase 4.5 compare ops (cmp/cmpi/cmpl/cmpli). Uses
// the cr_encode helpers to set CR[crfd] in Dolphin's u64 encoding.

#include "bementalJIT/types.h"
#include "code_op.h"
#include "cr_shadow.h"        // [PM57] CmpFuse
#include "fpr_reg_cache.h"
#include "reg_cache.h"

class WasmModuleBuilder;

namespace bemental::powerpc {


// [PM57 cmp-fuse] Optional trailing `fuse`: when BEM_LAZY_CR and the compare
// defers, it records its operand locals + kind here so an immediately-following
// conditional branch can fuse (direct operand compare). nullptr = no fusion.
void emit_cmpi (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                u32 ctx_ptr, CmpFuse* fuse = nullptr);
void emit_cmpli(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                u32 ctx_ptr, CmpFuse* fuse = nullptr);
void emit_cmp  (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                u32 ctx_ptr, CmpFuse* fuse = nullptr);
void emit_cmpl (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                u32 ctx_ptr, CmpFuse* fuse = nullptr);
// op19 CR-logical (crand/crandc/creqv/crnand/crnor/cror/crorc/crxor) — native.
void emit_cr_logic(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                   const CodeOp& op, u32 ctx_ptr);

}  // namespace bemental::powerpc
