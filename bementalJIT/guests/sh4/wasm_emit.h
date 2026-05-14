// Minimal seam impl. Native SHIL coverage roadmap lives in wasm_emit.h.reference.
// wasm_emit.h — SHIL → WASM emitter seam for the Flycast/Dreamcast guest.
//
// This pass lands the public surface (build_block + emitShilOp + emitBlockExit
// + RegCache + ctx_off + WIMPORT_*) so rec_wasm.cpp can call into bementalJIT
// without further API churn. emitShilOp returns false for every op except
// shop_ifb itself, forcing the caller's IFB-fallback path. Native SHIL emit
// is a follow-up.

#pragma once
#include "bementalJIT/wasm_module_builder.h"
#include "bementalJIT/types.h"

#include "hw/sh4/dyna/shil.h"
#include "hw/sh4/dyna/blockmanager.h"
#include "hw/sh4/dyna/decoder.h"

#include <cstring>
#include <unordered_map>
#include <vector>

namespace bemental::sh4 {

// ---------------------------------------------------------------------------
// Imports the JIT host MUST provide when instantiating a compiled block.
// Order is fixed; rec_wasm.cpp's buildModule must match.
// ---------------------------------------------------------------------------
enum WasmImportFunc : u32 {
    WIMPORT_READ8   = 0,
    WIMPORT_READ16  = 1,
    WIMPORT_READ32  = 2,
    WIMPORT_WRITE8  = 3,
    WIMPORT_WRITE16 = 4,
    WIMPORT_WRITE32 = 5,
    WIMPORT_IFB     = 6,    // (opcode_imm, pc) -> void
    WIMPORT_SHIL_FB = 7,    // (block_vaddr, op_idx) -> void
    WIMPORT_COUNT   = 8
};

// ---------------------------------------------------------------------------
// Sh4Context field offsets, in bytes from the start of the struct.
// Source of truth: dreamcast/flycast-src/core/hw/sh4/sh4_if.h. Verified
// against current Flycast main as of 2026-05-13:
//   sq_buffer[2] (64) + xf[16] (64) + fr[16] (64) + r[16] (64) = 0x100
//   mac (8) + r_bank[8] (32)                                   = 0x128
//   gbr,ssr,spc,sgr,dbr,vbr,pr,fpul,pc                         pc @ 0x148
//   jdyn (u32) directly after pc                                  @ 0x14C
//   sr_t sr      (status @ +0, T @ +4)                            @ 0x150 / 0x154
//   fpscr (4) + old_sr (4) + old_fpscr (4) + CpuRunning (4)
//   + sh4_sched_next (4) + interrupt_pend (4) + temp_reg (4)
//   + cycle_counter                                               @ 0x174
// ---------------------------------------------------------------------------
namespace ctx_off {
    constexpr u32 PC            = 0x148;
    constexpr u32 JDYN          = 0x14C;
    constexpr u32 SR_STATUS     = 0x150;
    constexpr u32 SR_T          = 0x154;
    constexpr u32 CYCLE_COUNTER = 0x174;
}

// ---------------------------------------------------------------------------
// Local layout for emitted block functions.
//   (param ctx_ptr i32) (param ram_base i32) (result i32)
// Locals 0/1 are function params; locals 2..6 are fixed i32 scratch.
// RegCache appends per-register cache locals starting at index 7.
// ---------------------------------------------------------------------------
constexpr u32 LOCAL_CTX  = 0;
constexpr u32 LOCAL_RAM  = 1;
constexpr u32 LOCAL_TMP  = 2;
constexpr u32 LOCAL_TMP2 = 3;
constexpr u32 LOCAL_TMP3 = 4;
constexpr u32 LOCAL_TMP4 = 5;
constexpr u32 LOCAL_TMP5 = 6;
constexpr u32 LOCAL_FIXED_I32_COUNT = 5;   // TMP..TMP5

// ---------------------------------------------------------------------------
// RegCache — maps Sh4Context byte-offset to a WASM local.
//
// API surface only. assignLocal/flushAll/reloadAll/markDirty are present so
// the future native-emit pass can plug straight in without touching
// emitShilOp / emitBlockExit / build_block. The minimal-seam emitter does
// not allocate any cache slots yet (the IFB fallback path goes straight
// through context memory), so all queries fall through to "uncached".
// ---------------------------------------------------------------------------
struct RegCacheEntry {
    u32  wasmLocal;
    bool dirty;
};

struct RegCache {
    std::unordered_map<u32, RegCacheEntry> entries;
    u32 nextLocal = 2 + LOCAL_FIXED_I32_COUNT;

    void assignLocal(u32 ctxOffset) {
        if (entries.find(ctxOffset) != entries.end()) return;
        RegCacheEntry e;
        e.wasmLocal = nextLocal++;
        e.dirty     = false;
        entries[ctxOffset] = e;
    }

    s32 getLocal(u32 ctxOffset) const {
        auto it = entries.find(ctxOffset);
        return it != entries.end() ? (s32)it->second.wasmLocal : -1;
    }

    void markDirty(u32 ctxOffset) {
        auto it = entries.find(ctxOffset);
        if (it != entries.end()) it->second.dirty = true;
    }

    u32 localCount() const { return nextLocal - (2 + LOCAL_FIXED_I32_COUNT); }

    void flushAll(WasmModuleBuilder& b) {
        for (auto& kv : entries) {
            if (!kv.second.dirty) continue;
            b.op_local_get(LOCAL_CTX);
            b.op_local_get(kv.second.wasmLocal);
            b.op_i32_store(kv.first);
            kv.second.dirty = false;
        }
    }

    void reloadAll(WasmModuleBuilder& b) {
        for (auto& kv : entries) {
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(kv.first);
            b.op_local_set(kv.second.wasmLocal);
            kv.second.dirty = false;
        }
    }
};

// ---------------------------------------------------------------------------
// Public emit API.
// ---------------------------------------------------------------------------

// Emit one SHIL op into b. Returns true if natively handled, false if the
// caller should emit a fallback (WIMPORT_IFB or WIMPORT_SHIL_FB) instead.
bool emitShilOp(WasmModuleBuilder& b, const shil_opcode& op,
                RuntimeBlockInfo* block, u32 opIndex, RegCache& cache);

// Emit the block-exit PC write (BET_CLS_Static / BET_CLS_Dynamic /
// BET_CLS_COND). Must run before the function returns — without it the
// dispatcher loops forever on a stale PC.
void emitBlockExit(WasmModuleBuilder& b, RuntimeBlockInfo* block,
                   const RegCache& cache);

// Assemble a complete WASM module that runs `block`'s SHIL oplist. The
// module exports a single function "run" of type
//   (param ctx_ptr i32) (param ram_base i32) (result i32)
// returning the next PC the host dispatcher should look up. Each non-natively
// handled op emits a flushAll + WIMPORT_IFB(op_imm, op_pc) + reloadAll
// sandwich. Empty oplists are valid and produce a module that just runs
// emitBlockExit and returns.
std::vector<u8> build_block(RuntimeBlockInfo* block);

} // namespace bemental::sh4
