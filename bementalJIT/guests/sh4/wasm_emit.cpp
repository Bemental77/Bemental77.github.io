// wasm_emit.cpp — SHIL → WASM seam impl. See wasm_emit.h.reference for the
// full SHIL native-emit roadmap.

#include "wasm_emit.h"

namespace bemental::sh4 {

// Encode the shop_ifb fallback as a direct WIMPORT_IFB(opcode_imm, pc) call.
// rs1 holds the original SH4 16-bit opcode word; rs2 holds the guest PC.
// Both arrive as imm params from the SHIL lowerer.
static void emit_ifb_call(WasmModuleBuilder& b, const shil_opcode& op) {
    if (op.rs1.is_imm()) {
        b.op_i32_const((s32)op.rs1.imm_value());
    } else {
        b.op_i32_const(0);
    }
    if (op.rs2.is_imm()) {
        b.op_i32_const((s32)op.rs2.imm_value());
    } else {
        b.op_i32_const(0);
    }
    b.op_call(WIMPORT_IFB);
}

bool emitShilOp(WasmModuleBuilder& b, const shil_opcode& op,
                RuntimeBlockInfo* /*block*/, u32 /*opIndex*/,
                RegCache& /*cache*/) {
    if (op.op == shop_ifb) {
        emit_ifb_call(b, op);
        return true;
    }
    return false;
}

void emitBlockExit(WasmModuleBuilder& b, RuntimeBlockInfo* block,
                   const RegCache& cache) {
    const u32 bcls = BET_GET_CLS(block->BlockType);

    switch (bcls) {
    case BET_CLS_Static:
        b.op_local_get(LOCAL_CTX);
        if (block->BlockType == BET_StaticIntr) {
            b.op_i32_const((s32)block->NextBlock);
        } else {
            b.op_i32_const((s32)block->BranchBlock);
        }
        b.op_i32_store(ctx_off::PC);
        break;

    case BET_CLS_Dynamic: {
        b.op_local_get(LOCAL_CTX);
        s32 jdynLocal = cache.getLocal(ctx_off::JDYN);
        if (jdynLocal >= 0) {
            b.op_local_get((u32)jdynLocal);
        } else {
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(ctx_off::JDYN);
        }
        b.op_i32_store(ctx_off::PC);
        break;
    }

    case BET_CLS_COND: {
        const u32 cond = (block->BlockType == BET_Cond_1) ? 1u : 0u;

        b.op_local_get(LOCAL_CTX);

        if (block->has_jcond) {
            s32 jdynLocal = cache.getLocal(ctx_off::JDYN);
            if (jdynLocal >= 0) {
                b.op_local_get((u32)jdynLocal);
            } else {
                b.op_local_get(LOCAL_CTX);
                b.op_i32_load(ctx_off::JDYN);
            }
        } else {
            s32 srTLocal = cache.getLocal(ctx_off::SR_T);
            if (srTLocal >= 0) {
                b.op_local_get((u32)srTLocal);
            } else {
                b.op_local_get(LOCAL_CTX);
                b.op_i32_load(ctx_off::SR_T);
            }
        }

        if (cond == 1) {
            b.op_if(WASM_TYPE_I32);
        } else {
            b.op_i32_eqz();
            b.op_if(WASM_TYPE_I32);
        }
        b.op_i32_const((s32)block->BranchBlock);
        b.op_else();
        b.op_i32_const((s32)block->NextBlock);
        b.op_end();

        b.op_i32_store(ctx_off::PC);
        break;
    }

    default:
        b.op_local_get(LOCAL_CTX);
        b.op_i32_const((s32)block->NextBlock);
        b.op_i32_store(ctx_off::PC);
        break;
    }
}

std::vector<u8> build_block(RuntimeBlockInfo* block) {
    WasmModuleBuilder b;
    b.emitHeader();

    // ---- Type section ----
    //  type 0: (i32, i32) -> i32   — block "run"(ctx_ptr, ram_base) -> next_pc
    //  type 1: (i32) -> i32        — read8/read16/read32
    //  type 2: (i32, i32) -> ()    — write8/write16/write32, ifb, shil_fb
    b.emitTypeSection(3);
    {
        const u8 i32t[]  = { WASM_TYPE_I32 };
        const u8 i32x2[] = { WASM_TYPE_I32, WASM_TYPE_I32 };
        b.emitFuncType(i32x2, 2, i32t,  1);
        b.emitFuncType(i32t,  1, i32t,  1);
        b.emitFuncType(i32x2, 2, nullptr, 0);
    }
    b.endSection();

    // ---- Import section: memory + WIMPORT_COUNT host functions ----
    b.emitImportSection(1 + WIMPORT_COUNT);
    b.emitImportMemory("env", "memory", 1);
    b.emitImportFunc("env", "sh4_read8",   /*type*/1);
    b.emitImportFunc("env", "sh4_read16",  /*type*/1);
    b.emitImportFunc("env", "sh4_read32",  /*type*/1);
    b.emitImportFunc("env", "sh4_write8",  /*type*/2);
    b.emitImportFunc("env", "sh4_write16", /*type*/2);
    b.emitImportFunc("env", "sh4_write32", /*type*/2);
    b.emitImportFunc("env", "sh4_ifb",     /*type*/2);
    b.emitImportFunc("env", "sh4_shil_fb", /*type*/2);
    b.endSection();

    // ---- Function section: 1 function of type 0 ----
    {
        const u32 idx[] = { 0 };
        b.emitFunctionSection(1, idx);
    }

    // ---- Export section: "run" → func index = WIMPORT_COUNT ----
    b.emitExportSection("run", WIMPORT_COUNT);

    // ---- Code section ----
    b.beginCodeSection(1);
    b.beginFuncBody();

    // Locals: LOCAL_FIXED_I32_COUNT i32 scratch (TMP..TMP5). Params (CTX,
    // RAM) are not declared as locals — they're function params and live at
    // indices 0/1 implicitly.
    {
        const u32 counts[] = { LOCAL_FIXED_I32_COUNT };
        const u8  types[]  = { WASM_TYPE_I32 };
        b.emitLocals(1, counts, types);
    }

    RegCache cache;

    if (block != nullptr) {
        for (size_t i = 0; i < block->oplist.size(); ++i) {
            const shil_opcode& op = block->oplist[i];
            if (emitShilOp(b, op, block, (u32)i, cache)) continue;

            cache.flushAll(b);
            const s32 op_imm = op.rs1.is_imm() ? (s32)op.rs1.imm_value() : 0;
            const s32 op_pc  = (s32)block->vaddr + (s32)op.guest_offs;
            b.op_i32_const(op_imm);
            b.op_i32_const(op_pc);
            b.op_call(WIMPORT_IFB);
            cache.reloadAll(b);
        }
        emitBlockExit(b, block, cache);
        b.op_local_get(LOCAL_CTX);
        b.op_i32_load(ctx_off::PC);
    } else {
        b.op_i32_const(0);
    }

    b.endFuncBody();
    b.endSection();

    return b.getBytes();
}

} // namespace bemental::sh4
