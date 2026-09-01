//
// hle_prologue.cpp — Port from live gekko_emit.cpp:1958-1975. The
// HLE-check prologue's contract is preserved byte-for-byte (input:
// start_pc as i32 → return: i32 0=continue, 1=HLE took over, exit
// block). The host-side hle_check handler reads PowerPCState.PC if it
// replaced; the prologue reads it back and returns.

#include "hle_prologue.h"

#include "bementalJIT/types.h"
#include "bementalJIT/wasm_module_builder.h"
#include "ppc_offsets.h"

namespace bemental::powerpc {

static constexpr u8 BLOCK_TYPE_VOID = 0x40;

void emit_hle_prologue(WasmModuleBuilder& wb, u32 ctx_ptr, u32 start_pc) {
    wb.op_i32_const((s32)start_pc);
    wb.op_call(WIMPORT_HLE_CHECK);  // (i32 start_pc) -> i32

    // if non-zero, HLE replaced — read PC and return early.
    wb.op_if(BLOCK_TYPE_VOID);
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_i32_load(ppc_off::PC);
        wb.op_return();
    wb.op_end();
}

}  // namespace bemental::powerpc
