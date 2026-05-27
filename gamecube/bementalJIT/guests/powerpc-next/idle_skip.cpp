//
// idle_skip.cpp — B1 idle-loop emit shape. Mirrors the live tree's
// jit_b1_idle_skip_2026_05_05.md behavior. When the analyzer marks a
// block's terminator branchIsIdleLoop=true, the emitter writes the
// branch target to PC and returns — letting the dispatcher's outer loop
// see the same idle pattern and FastForward the downcount.

#include "idle_skip.h"

#include "bementalJIT/types.h"
#include "bementalJIT/wasm_module_builder.h"
#include "code_op.h"
#include "ppc_offsets.h"
#include "reg_cache.h"

namespace bemental::powerpc {

void emit_idle_skip(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& term,
                    u32 ctx_ptr) {
    rc.Flush(ctx_ptr);
    // Set PC = branch target. The dispatcher's outer loop sees the same
    // self-target and applies the FastForward downcount advance.
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_const((s32)term.branchTo);
    wb.op_i32_store(ppc_off::PC);
}

}  // namespace bemental::powerpc
