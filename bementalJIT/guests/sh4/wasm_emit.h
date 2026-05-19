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

// Linear-memory offset of flycast's vram[0] (RamRegion data ptr). Set by
// the bridge at SH4 init time (dreamcast/flycast-bridge/rec_wasm.cpp
// wasm_block_trampoline first-call); read by the emitter at compile time
// to bake an area-4/5 VRAM fastpath into shop_writem/readm. Zero means
// "not yet initialized" — emitter falls back to the sh4_write32/read32
// callback in that case.
extern u32 g_vram_lin_base;

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
    bool loaded;   // F9 lazy mode: false until first use loads the local
};

struct RegCache {
    std::unordered_map<u32, RegCacheEntry> entries;
    u32 nextLocal = 2 + LOCAL_FIXED_I32_COUNT;
    u32 _tmp64LocalIdx = 0;

    void assignLocal(u32 ctxOffset) {
        if (entries.find(ctxOffset) != entries.end()) return;
        RegCacheEntry e;
        e.wasmLocal = nextLocal++;
        e.dirty     = false;
        e.loaded    = false;
        entries[ctxOffset] = e;
    }

    // Alias used by scanBlock and pre-emit register discovery.
    void addOffset(u32 ctxOffset) { assignLocal(ctxOffset); }

    // Pre-scan: walk the SHIL oplist and allocate a cache local for every
    // 32-bit integer register the block reads or writes, plus the fixed
    // ctx fields that block exit reads (jdyn, sr.T).
    void scanBlock(RuntimeBlockInfo* block) {
        for (size_t i = 0; i < block->oplist.size(); ++i) {
            const shil_opcode& op = block->oplist[i];
            if (op.rs1.is_r32i()) addOffset(op.rs1.reg_offset());
            if (op.rs2.is_r32i()) addOffset(op.rs2.reg_offset());
            if (op.rs3.is_r32i()) addOffset(op.rs3.reg_offset());
            if (op.rd.is_r32i())  addOffset(op.rd.reg_offset());
            if (op.rd2.is_r32i()) addOffset(op.rd2.reg_offset());
            if (op.op == shop_jdyn)  addOffset(ctx_off::JDYN);
            if (op.op == shop_jcond) addOffset(ctx_off::JDYN);
        }
        u32 bcls = BET_GET_CLS(block->BlockType);
        if (bcls == BET_CLS_COND) {
            if (block->has_jcond) addOffset(ctx_off::JDYN);
            else                  addOffset(ctx_off::SR_T);
        }
        if (bcls == BET_CLS_Dynamic) addOffset(ctx_off::JDYN);
    }

    s32 getLocal(u32 ctxOffset) const {
        auto it = entries.find(ctxOffset);
        return it != entries.end() ? (s32)it->second.wasmLocal : -1;
    }

    void markDirty(u32 ctxOffset) {
        auto it = entries.find(ctxOffset);
        if (it != entries.end()) it->second.dirty = true;
    }

    // F9 lazy reload support. isLoaded/markLoaded let emitLoadParamCached
    // and the exit-path readers populate the cache local on first use rather
    // than eagerly in the block prologue.
    bool isLoaded(u32 ctxOffset) const {
        auto it = entries.find(ctxOffset);
        return it != entries.end() ? it->second.loaded : false;
    }

    void markLoaded(u32 ctxOffset) {
        auto it = entries.find(ctxOffset);
        if (it != entries.end()) it->second.loaded = true;
    }

    // After a fallback call (IFB/SHIL_FB) the context-memory state is the
    // authoritative one; cached locals are stale. Mark every entry not-loaded
    // so the next use re-fetches from memory. dirty bits are cleared by the
    // preceding flushAll, so there is nothing in-local to preserve.
    void invalidateAll() {
        for (auto& kv : entries) kv.second.loaded = false;
    }

    u32 localCount() const { return nextLocal - (2 + LOCAL_FIXED_I32_COUNT); }

    // i64 scratch local index — set by build_block after all i32 locals
    // are allocated, used by dual-output ops (adc/sbc/negc/mul_u64/mul_s64).
    u32 tmp64Local() const { return _tmp64LocalIdx; }

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
// vaddr_to_idx (optional): when non-null, intra-module block linking is
// enabled. For BET_StaticJump (and the taken arm of BET_Cond) targets whose
// vaddr is present in the map AND distinct from this block's own vaddr,
// emitBlockExit emits `return_call WIMPORT_COUNT+idx` (wasm tail-call) instead
// of returning to the C++ dispatcher. Tail-call replaces this function's
// stack frame so chains of N blocks run in O(1) stack — no depth bounding
// needed, no overflow. build_block (single-block module) passes nullptr.
void emitBlockExit(WasmModuleBuilder& b, RuntimeBlockInfo* block,
                   const RegCache& cache,
                   const std::unordered_map<u32, u32>* vaddr_to_idx = nullptr);

// Assemble a complete WASM module that runs `block`'s SHIL oplist. The
// module exports a single function "run" of type
//   (param ctx_ptr i32) (param ram_base i32) (result i32)
// returning the next PC the host dispatcher should look up. Each non-natively
// handled op emits a flushAll + WIMPORT_IFB(op_imm, op_pc) + reloadAll
// sandwich. Empty oplists are valid and produce a module that just runs
// emitBlockExit and returns.
std::vector<u8> build_block(RuntimeBlockInfo* block);

// F1 (shard) — assemble a SINGLE WASM module containing N block functions,
// exported as "run_0", "run_1", ..., "run_<N-1>". Each function has the same
// (i32 ctx_ptr, i32 ram_base) -> i32 signature as build_block's "run" export.
//
// Intra-shard block linking (F2) is wired automatically: a vaddr→local-func-idx
// map is built from `blocks` and passed to emitBlockFuncBody, so static-jump
// and BET_Cond targets that point to siblings inside the SAME shard emit a
// `return_call` tail-call instead of returning to the C++ dispatcher. Blocks
// targeting vaddrs OUTSIDE the shard fall through to the dispatcher unchanged.
//
// Empty `blocks` is valid (returns an empty exports module — caller should
// just skip install in that case).
std::vector<u8> build_blocks(const std::vector<RuntimeBlockInfo*>& blocks);

} // namespace bemental::sh4
