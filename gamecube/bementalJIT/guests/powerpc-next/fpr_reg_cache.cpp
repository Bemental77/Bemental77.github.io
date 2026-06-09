//
// FPRRegCache — implementation. Per-block PPC-FPR → WASM-i64-local binding.
// Storage is i64 (not f64) — bit-exact NaN payload + signed-zero preservation.
//
// Status: class is declared and ready for the next step (build_block_next
// wires OnBlockEntry + EmitPrologueLoads). emit-site conversion lands in
// later steps (scalar opcode-63 → trivial PS opcode-4 → arith PS opcode-4
// → FP load/store family).

#include "fpr_reg_cache.h"

#include "bementalJIT/types.h"
#include "bementalJIT/wasm_module_builder.h"
#include "code_op.h"
#include "ppc_offsets.h"

namespace bemental::powerpc {

FPRRegCache::FPRRegCache(WasmModuleBuilder& wb)
    : m_wb(wb) {}

// OnBlockEntry — reserve two contiguous i64 wasm-local indices per FPR.
// Convention: ps0 lanes at [base..base+31], ps1 lanes at [base+32..base+63].
// Live-in pregs (block.m_fpr_inputs) get the assigned bit so the prologue
// emits their loads. Other pregs are lazily assigned on first Bind.
void FPRRegCache::OnBlockEntry(const CodeBlock& block, u32 wasm_local_base,
                               u32 ctx_ptr) {
    m_local_base   = wasm_local_base;
    m_if_depth     = 0;
    m_lazy_ctx_ptr = ctx_ptr;
    for (u32 i = 0; i < 32; ++i) {
        m_state[i] = PregState{};
        m_state[i].ps0_local_idx = wasm_local_base + i;
        m_state[i].ps1_local_idx = wasm_local_base + 32u + i;
        if (block.m_fpr_inputs[i]) {
            m_state[i].assigned = true;
        }
    }
}

// EmitPrologueLoads — for every live-in preg, emit i64 loads for BOTH lanes.
// Matches Jit64 FPURegCache.cpp:60-64 (MOVAPD loads ps0+ps1 as one 16-byte op).
void FPRRegCache::EmitPrologueLoads(u32 ctx_ptr) {
    for (u32 i = 0; i < 32; ++i) {
        if (!m_state[i].assigned) continue;
        if (!m_state[i].ps0_loaded) {
            EmitLaneLoad(ctx_ptr, i, FPR_LANE_PS0);
        }
        if (!m_state[i].ps1_loaded) {
            EmitLaneLoad(ctx_ptr, i, FPR_LANE_PS1);
        }
    }
}

// EmitLaneLoad — i64.load from ps0(N) or ps1(N) into the lane's local.
void FPRRegCache::EmitLaneLoad(u32 ctx_ptr, u32 preg, u8 lane) {
    m_wb.op_i32_const((s32)ctx_ptr);
    if (lane == FPR_LANE_PS0) {
        m_wb.op_i64_load(ppc_off::ps0(preg));
        m_wb.op_local_set(m_state[preg].ps0_local_idx);
        m_state[preg].ps0_loaded = true;
    } else {
        m_wb.op_i64_load(ppc_off::ps1(preg));
        m_wb.op_local_set(m_state[preg].ps1_local_idx);
        m_state[preg].ps1_loaded = true;
    }
}

// EmitLaneStore — i64.store from the lane's local to ps0(N) or ps1(N).
void FPRRegCache::EmitLaneStore(u32 ctx_ptr, u32 preg, u8 lane) {
    m_wb.op_i32_const((s32)ctx_ptr);
    if (lane == FPR_LANE_PS0) {
        m_wb.op_local_get(m_state[preg].ps0_local_idx);
        m_wb.op_i64_store(ppc_off::ps0(preg));
        m_state[preg].ps0_dirty = false;
    } else {
        m_wb.op_local_get(m_state[preg].ps1_local_idx);
        m_wb.op_i64_store(ppc_off::ps1(preg));
        m_state[preg].ps1_dirty = false;
    }
}

// Bind — return both lane indices for `preg`, lazy-loading any requested
// lane that hasn't been loaded yet. Write/ReadWrite mark requested lanes
// dirty. Pure-Write skips the lazy-load (the emit will define it).
RCFprPair FPRRegCache::Bind(u32 preg, FPRMode mode, u8 lane_mask) {
    PregState& s = m_state[preg];
    if (!s.assigned) {
        // Analyzer didn't mark this preg as live-in. Lazy-assign + lazy-
        // load — same shape as RegCache::Bind for analyzer-blind ops.
        s.ps0_local_idx = m_local_base + preg;
        s.ps1_local_idx = m_local_base + 32u + preg;
        s.assigned = true;
    }
    const bool wants_read = (mode != FPRMode::Write);
    if (wants_read) {
        if ((lane_mask & FPR_LANE_PS0) && !s.ps0_loaded) {
            EmitLaneLoad(m_lazy_ctx_ptr, preg, FPR_LANE_PS0);
        }
        if ((lane_mask & FPR_LANE_PS1) && !s.ps1_loaded) {
            EmitLaneLoad(m_lazy_ctx_ptr, preg, FPR_LANE_PS1);
        }
    } else {
        // Pure Write — mark lanes loaded so a future Read sees the local
        // (the emit guarantees it sets the local before any read).
        if (lane_mask & FPR_LANE_PS0) s.ps0_loaded = true;
        if (lane_mask & FPR_LANE_PS1) s.ps1_loaded = true;
    }
    if (mode == FPRMode::Write || mode == FPRMode::ReadWrite) {
        if (lane_mask & FPR_LANE_PS0) s.ps0_dirty = true;
        if (lane_mask & FPR_LANE_PS1) s.ps1_dirty = true;
    }
    return RCFprPair{s.ps0_local_idx, s.ps1_local_idx};
}

// Flush dirty lanes back to PowerPCState.
void FPRRegCache::Flush(u32 ctx_ptr, BitSet32 preg_mask, u8 lane_mask) {
    for (u32 i = 0; i < 32; ++i) {
        if (!preg_mask[i]) continue;
        if ((lane_mask & FPR_LANE_PS0) && m_state[i].ps0_dirty) {
            EmitLaneStore(ctx_ptr, i, FPR_LANE_PS0);
        }
        if ((lane_mask & FPR_LANE_PS1) && m_state[i].ps1_dirty) {
            EmitLaneStore(ctx_ptr, i, FPR_LANE_PS1);
        }
    }
}

// ReloadAll — for every assigned FPR, re-load both lanes from PowerPCState.
// Used after host mutations of ps[] (interp fallback, HLE that may touch
// FPRs). Clears dirty bits to keep state coherent with what we just wrote.
void FPRRegCache::ReloadAll(u32 ctx_ptr) {
    for (u32 i = 0; i < 32; ++i) {
        if (!m_state[i].assigned) continue;
        // Force-reload both lanes regardless of dirty state. The host may
        // have mutated either lane; the cache must reflect that.
        m_wb.op_i32_const((s32)ctx_ptr);
        m_wb.op_i64_load(ppc_off::ps0(i));
        m_wb.op_local_set(m_state[i].ps0_local_idx);
        m_state[i].ps0_dirty  = false;
        m_state[i].ps0_loaded = true;

        m_wb.op_i32_const((s32)ctx_ptr);
        m_wb.op_i64_load(ppc_off::ps1(i));
        m_wb.op_local_set(m_state[i].ps1_local_idx);
        m_state[i].ps1_dirty  = false;
        m_state[i].ps1_loaded = true;
    }
}

// EmitIf / EmitElse / EmitEndIf — flush before each arm + at merge so any
// dirty lane bound inside an arm doesn't leak across the join.
void FPRRegCache::EmitIf(u32 ctx_ptr, u32 result_type) {
    Flush(ctx_ptr);
    m_wb.op_if((u8)(result_type & 0xFF));
    ++m_if_depth;
}

void FPRRegCache::EmitElse(u32 ctx_ptr) {
    Flush(ctx_ptr);
    m_wb.op_else();
}

void FPRRegCache::EmitEndIf(u32 ctx_ptr) {
    Flush(ctx_ptr);
    m_wb.op_end();
    if (m_if_depth > 0) --m_if_depth;
}

}  // namespace bemental::powerpc
