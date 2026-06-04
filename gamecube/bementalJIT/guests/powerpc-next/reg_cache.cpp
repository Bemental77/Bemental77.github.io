//
// RegCache — implementation. Pure host C++ logic; the actual WASM emit
// (i32.load / i32.store / local.get / local.set / op_if / op_else /
// op_end) goes through bementalJIT's WasmModuleBuilder.
//
// Status: wired through jit_load_store / jit_integer / jit_branch /
// jit_compare / jit_system_registers / ppc_emit (build_block_next).

#include "reg_cache.h"

#include "bementalJIT/types.h"
#include "bementalJIT/wasm_module_builder.h"
#include "code_op.h"

namespace bemental::powerpc {

// PowerPCState GPR offset — matches gekko_emit.h ppc_off::gpr() layout.
// (PC@0x000, NPC@0x004, GPR[0]@0x014..)
static constexpr u32 PPC_GPR_BASE_OFF = 0x014u;
static constexpr u32 ppc_gpr_off(u32 n) { return PPC_GPR_BASE_OFF + (n * 4u); }

// ---------------------------------------------------------------------------
// RCWasmLocal::release — RAII binding-release. Phase 2 is a no-op because
// WASM locals don't have a finite host-pool to return to; the binding is
// the block's lifetime. Stub kept for API symmetry and future cross-block
// local reuse.
// ---------------------------------------------------------------------------
void RCWasmLocal::release() {
    m_rc = nullptr;
}

RCWasmLocal::~RCWasmLocal() {
    if (m_rc) release();
}

// ---------------------------------------------------------------------------
// RegCache ctor.
// ---------------------------------------------------------------------------
RegCache::RegCache(WasmModuleBuilder& wb)
    : m_wb(wb) {}

// ---------------------------------------------------------------------------
// OnBlockEntry — assign one WASM local per live PPC GPR. Live-in set comes
// from CodeBlock::m_gpr_inputs (computed by PPCAnalyzer). Writes-only GPRs
// also get a local (defined+used within the block).
// ---------------------------------------------------------------------------
void RegCache::OnBlockEntry(const CodeBlock& block, u32 wasm_local_base) {
    m_local_base = wasm_local_base;
    m_if_depth   = 0;
    for (u32 i = 0; i < 32; ++i) {
        m_state[i] = PregState{};
        m_state[i].local_idx = wasm_local_base + i;
        // Mark live-ins as needing a prologue load.
        if (block.m_gpr_inputs[i]) {
            m_state[i].assigned = true;
        }
    }
}

// ---------------------------------------------------------------------------
// EmitPrologueLoads — for every live-in preg, emit
//   local.set(idx, i32.load(ctx_ptr + gpr_off(N)))
// ---------------------------------------------------------------------------
void RegCache::EmitPrologueLoads(u32 ctx_ptr) {
    for (u32 i = 0; i < 32; ++i) {
        if (!m_state[i].assigned || m_state[i].loaded) continue;
        m_wb.op_i32_const((s32)ctx_ptr);
        m_wb.op_i32_load(ppc_gpr_off(i));
        m_wb.op_local_set(m_state[i].local_idx);
        m_state[i].loaded = true;
    }
}

// ---------------------------------------------------------------------------
// Bind — return a RAII handle for the local backing preg, ensuring its
// prologue-load has been emitted (lazy fill).
// ---------------------------------------------------------------------------
RCWasmLocal RegCache::Bind(u32 preg, RCMode mode) {
    PregState& s = m_state[preg];
    if (!s.assigned) {
        s.local_idx = m_local_base + preg;
        s.assigned  = true;
        s.loaded    = true;  // Read-mode use of a non-live-in preg is an
                              // analyzer fail-safe — we mark loaded but
                              // emit no prologue load (the caller has to
                              // store before reading; the local's u32{0}
                              // default value is fine).
    }
    if (mode == RCMode::Write || mode == RCMode::ReadWrite) {
        s.dirty  = true;
        s.is_imm = false;
    }
    return RCWasmLocal(this, s.local_idx, preg, mode);
}

// ---------------------------------------------------------------------------
// BindOrImm — Read-mode helper that folds compile-time-known immediates.
// ---------------------------------------------------------------------------
RCOpArg RegCache::BindOrImm(u32 preg) {
    PregState& s = m_state[preg];
    if (s.is_imm) return RCOpArg::Imm(s.imm);
    // Force a Bind(Read) to ensure the local is loaded.
    Bind(preg, RCMode::Read);
    return RCOpArg::Local(s.local_idx);
}

void RegCache::DiscardImm(u32 preg) {
    m_state[preg].is_imm = false;
}

void RegCache::SetImmediate32(u32 preg, u32 imm) {
    PregState& s = m_state[preg];
    s.imm    = imm;
    s.is_imm = true;
    s.dirty  = true;  // PowerPCState doesn't reflect the new value until flushed
}

void RegCache::MarkDirty(u32 preg) {
    m_state[preg].dirty = true;
}

// ---------------------------------------------------------------------------
// Flush — write dirty locals back to PowerPCState.
// ---------------------------------------------------------------------------
void RegCache::Flush(u32 ctx_ptr, BitSet32 mask) {
    for (u32 i = 0; i < 32; ++i) {
        if (!mask[i] || !m_state[i].dirty) continue;
        m_wb.op_i32_const((s32)ctx_ptr);
        if (m_state[i].is_imm) {
            m_wb.op_i32_const((s32)m_state[i].imm);
        } else {
            m_wb.op_local_get(m_state[i].local_idx);
        }
        m_wb.op_i32_store(ppc_gpr_off(i));
        m_state[i].dirty = false;
    }
}

// Reload every assigned GPR cache local from PowerPCState. Used after host
// mutations of gpr[] (interp fallbacks, HLE handlers). Cost = 3 wasm ops
// per assigned local; cap is 32 regs. Clears dirty + is_imm to keep the
// cache state consistent with what we just wrote into the locals.
void RegCache::ReloadAll(u32 ctx_ptr) {
    for (u32 i = 0; i < 32; ++i) {
        if (!m_state[i].assigned) continue;
        m_wb.op_i32_const((s32)ctx_ptr);
        m_wb.op_i32_load(ppc_gpr_off(i));
        m_wb.op_local_set(m_state[i].local_idx);
        m_state[i].dirty  = false;
        m_state[i].is_imm = false;
        m_state[i].loaded = true;
    }
}

// ---------------------------------------------------------------------------
// EmitIf / EmitElse / EmitEndIf — wrap WASM control-flow ops with flush-
// before, invalidate-on-arm-merge. Replaces every raw op_if / op_else /
// op_end call in emit ops (closes the b11 coherence bug class
// structurally).
// ---------------------------------------------------------------------------
void RegCache::EmitIf(u32 ctx_ptr, u32 result_type) {
    Flush(ctx_ptr);
    m_wb.op_if((u8)(result_type & 0xFF));
    ++m_if_depth;
}

void RegCache::EmitElse(u32 ctx_ptr) {
    Flush(ctx_ptr);
    for (auto& s : m_state) s.is_imm = false;
    m_wb.op_else();
}

void RegCache::EmitEndIf(u32 ctx_ptr) {
    Flush(ctx_ptr);
    for (auto& s : m_state) s.is_imm = false;
    m_wb.op_end();
    if (m_if_depth > 0) --m_if_depth;
}

}  // namespace bemental::powerpc
