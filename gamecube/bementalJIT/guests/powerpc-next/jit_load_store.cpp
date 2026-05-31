//
// jit_load_store.cpp — Phase 3 implementation. Guard-branch fastmem +
// MMIO-routed slow path. Replaces the live tree's path-(a)/(b)/(c) soup
// in emit_load_d / emit_store_d.
//
// Bug class closed structurally: the slow path is taken unconditionally
// for any EA outside MEM1's [base, base+ram_size) range — including MMIO
// addresses like 0xCC005000. No "trust the DFA" bypass.
//
// Emit shape per op (D-form load shown — store/X-form analogous):
//   compute EA -> LOCAL_TMP_EA
//   push fastmem-guard i32 to stack    (uses LOCAL_TMP_EA, stack-additive)
//   rc.Flush(ctx_ptr)                  (stack-neutral)
//   wb.op_if(BLOCK_TYPE_VOID)          (consumes the guard from stack)
//     ;; fast path
//     load (EA & mem1_mask) + mem1_base, byte-swap, write result to RT local
//   wb.op_else()
//     ;; slow path — MMIO routes here too
//     push EA, call WIMPORT_READ*, write result to RT local
//   wb.op_end()
//   rc invalidates immediate-tracking on op_end (structural fix for the
//   b11 coherence bug class).
//   if (update): write EA local back to RA via RegCache.Bind(ra, Write).

#include "jit_load_store.h"

#include "bementalJIT/types.h"
#include "bementalJIT/wasm_module_builder.h"
#include "code_op.h"
#include "common/op_info.h"
#include "ppc_analyst.h"
#include "ppc_offsets.h"
#include "reg_cache.h"

namespace bemental::powerpc {

static constexpr u8 BLOCK_TYPE_VOID = 0x40;

// Locked import indices (must match the live tree's gekko_emit.h enum).
static constexpr u32 WIMPORT_READ8   = 0;
static constexpr u32 WIMPORT_READ16  = 1;
static constexpr u32 WIMPORT_READ32  = 2;
static constexpr u32 WIMPORT_WRITE8  = 3;
static constexpr u32 WIMPORT_WRITE16 = 4;
static constexpr u32 WIMPORT_WRITE32 = 5;

// Scratch locals reserved by the per-block layout (mirror gekko_emit.h
// LOCAL_TMP_A/B locked indices).
static constexpr u32 LOCAL_TMP_EA  = 0;
static constexpr u32 LOCAL_TMP_VAL = 1;

// ---------------------------------------------------------------------------
// EA computation
// ---------------------------------------------------------------------------
static void emit_ea_d_form(WasmModuleBuilder& wb, RegCache& rc, u32 ra, u32 simm) {
    if (ra == 0) {
        wb.op_i32_const((s32)simm);
    } else {
        auto rc_a = rc.Bind(ra, RCMode::Read);
        wb.op_local_get(rc_a.local_idx());
        wb.op_i32_const((s32)simm);
        wb.op_i32_add();
    }
    wb.op_local_set(LOCAL_TMP_EA);
}

static void emit_ea_x_form(WasmModuleBuilder& wb, RegCache& rc, u32 ra, u32 rb) {
    auto rc_b = rc.Bind(rb, RCMode::Read);
    if (ra == 0) {
        wb.op_local_get(rc_b.local_idx());
    } else {
        auto rc_a = rc.Bind(ra, RCMode::Read);
        wb.op_local_get(rc_a.local_idx());
        wb.op_local_get(rc_b.local_idx());
        wb.op_i32_add();
    }
    wb.op_local_set(LOCAL_TMP_EA);
}

// ---------------------------------------------------------------------------
// emit_fastmem_guard — push i32 (1 = fastmem hit, 0 = miss) onto stack.
// ---------------------------------------------------------------------------
static void emit_fastmem_guard(WasmModuleBuilder& wb, LoadStoreParams params) {
    // (EA & 0x1F000000) == 0  — top bits zero (filters out MMIO @ 0xCC* etc.)
    wb.op_local_get(LOCAL_TMP_EA);
    wb.op_i32_const(0x1F000000);
    wb.op_i32_and();
    wb.op_i32_eqz();
    // (EA & mem1_mask) < ram_size
    wb.op_local_get(LOCAL_TMP_EA);
    wb.op_i32_const((s32)params.mem1_mask);
    wb.op_i32_and();
    wb.op_i32_const((s32)params.ram_size);
    wb.op_i32_lt_u();
    // AND
    wb.op_i32_and();
}

// ---------------------------------------------------------------------------
// Byte-swap helpers — PowerPC is big-endian; WASM linear memory is
// little-endian. After every fastmem load we byte-swap; before every
// fastmem store we byte-swap.
// ---------------------------------------------------------------------------
static void emit_bswap_i32(WasmModuleBuilder& wb) {
    // Pattern: ((x << 8) & 0xFF00FF00) | ((x >>> 8) & 0x00FF00FF), then
    // (y << 16) | (y >>> 16). Two stages, each saved through LOCAL_TMP_VAL.
    wb.op_local_tee(LOCAL_TMP_VAL);
    wb.op_i32_const(8);
    wb.op_i32_shl();
    wb.op_i32_const((s32)0xFF00FF00u);
    wb.op_i32_and();
    wb.op_local_get(LOCAL_TMP_VAL);
    wb.op_i32_const(8);
    wb.op_i32_shr_u();
    wb.op_i32_const(0x00FF00FF);
    wb.op_i32_and();
    wb.op_i32_or();
    wb.op_local_tee(LOCAL_TMP_VAL);
    wb.op_i32_const(16);
    wb.op_i32_shl();
    wb.op_local_get(LOCAL_TMP_VAL);
    wb.op_i32_const(16);
    wb.op_i32_shr_u();
    wb.op_i32_or();
}

static void emit_bswap_i16(WasmModuleBuilder& wb) {
    wb.op_local_tee(LOCAL_TMP_VAL);
    wb.op_i32_const(8);
    wb.op_i32_shl();
    wb.op_local_get(LOCAL_TMP_VAL);
    wb.op_i32_const(8);
    wb.op_i32_shr_u();
    wb.op_i32_or();
    wb.op_i32_const(0xFFFF);
    wb.op_i32_and();
}

static u32 read_import_for_width(LoadWidth w) {
    switch (w) {
    case LoadWidth::U8:  return WIMPORT_READ8;
    case LoadWidth::U16: return WIMPORT_READ16;
    case LoadWidth::S16: return WIMPORT_READ16;
    case LoadWidth::U32: return WIMPORT_READ32;
    }
    return WIMPORT_READ32;
}

static u32 write_import_for_width(StoreWidth w) {
    switch (w) {
    case StoreWidth::U8:  return WIMPORT_WRITE8;
    case StoreWidth::U16: return WIMPORT_WRITE16;
    case StoreWidth::U32: return WIMPORT_WRITE32;
    }
    return WIMPORT_WRITE32;
}

// ---------------------------------------------------------------------------
// Fast-path load: leaves loaded+swapped value on the stack.
// ---------------------------------------------------------------------------
static void emit_fastmem_load_value(WasmModuleBuilder& wb,
                                    LoadStoreParams params, LoadWidth width) {
    wb.op_local_get(LOCAL_TMP_EA);
    wb.op_i32_const((s32)params.mem1_mask);
    wb.op_i32_and();
    wb.op_i32_const((s32)params.mem1_base);
    wb.op_i32_add();
    switch (width) {
    case LoadWidth::U8:
        wb.op_i32_load8_u(0);
        break;
    case LoadWidth::U16:
        wb.op_i32_load16_u(0);
        emit_bswap_i16(wb);
        break;
    case LoadWidth::S16:
        wb.op_i32_load16_u(0);
        emit_bswap_i16(wb);
        // sign-extend 16-bit → 32
        wb.op_i32_const(16);
        wb.op_i32_shl();
        wb.op_i32_const(16);
        wb.op_i32_shr_s();
        break;
    case LoadWidth::U32:
        wb.op_i32_load(0);
        emit_bswap_i32(wb);
        break;
    }
}

// Slow-path load via WIMPORT_READ*. Leaves value (with sign-extension if
// LoadWidth::S16) on the stack.
static void emit_slowmem_load_value(WasmModuleBuilder& wb, LoadWidth width) {
    wb.op_local_get(LOCAL_TMP_EA);
    wb.op_call(read_import_for_width(width));
    if (width == LoadWidth::S16) {
        wb.op_i32_const(16);
        wb.op_i32_shl();
        wb.op_i32_const(16);
        wb.op_i32_shr_s();
    }
}

// Fast-path store: pops nothing additional; uses src_local as the value
// source. Stack-neutral.
static void emit_fastmem_store(WasmModuleBuilder& wb, LoadStoreParams params,
                               StoreWidth width, u32 src_local) {
    wb.op_local_get(LOCAL_TMP_EA);
    wb.op_i32_const((s32)params.mem1_mask);
    wb.op_i32_and();
    wb.op_i32_const((s32)params.mem1_base);
    wb.op_i32_add();
    wb.op_local_get(src_local);
    switch (width) {
    case StoreWidth::U8:
        wb.op_i32_store8(0);
        break;
    case StoreWidth::U16:
        emit_bswap_i16(wb);
        wb.op_i32_store16(0);
        break;
    case StoreWidth::U32:
        emit_bswap_i32(wb);
        wb.op_i32_store(0);
        break;
    }
}

// Slow-path store via WIMPORT_WRITE*. Stack-neutral.
static void emit_slowmem_store(WasmModuleBuilder& wb, StoreWidth width,
                               u32 src_local) {
    wb.op_local_get(LOCAL_TMP_EA);
    wb.op_local_get(src_local);
    wb.op_call(write_import_for_width(width));
}

// ---------------------------------------------------------------------------
// emit_load — shared D-form / X-form load implementation. Caller has
// already emitted EA into LOCAL_TMP_EA.
// ---------------------------------------------------------------------------
static void emit_load_common(WasmModuleBuilder& wb, RegCache& rc,
                             LoadStoreParams params, u32 rt, u32 ra,
                             LoadWidth width, bool update) {
    // Push fastmem-guard onto stack, then flush dirty bindings, THEN bind
    // rt for Write. Binding rt before the flush was a memory-corruption
    // bug — Bind(Write) marks rt dirty, and the subsequent Flush then
    // writes rt's stale wasm-local-default (0) to memory[gpr(rt)] before
    // the load result is produced. The block's end-of-flow flush only
    // covers locals that were re-marked dirty AFTER the load, so the
    // zero-write was the final memory state. 2026-05-31 SAB boot:
    // L2GlobalInvalidate's epilogue `lwz r31, 12(r1)` zeroed memory's
    // gpr(31) slot mid-load, surfacing as __init_hardware's mtlr r31; blr
    // returning to PC=0 (caller-saved r31 = 0 after function return).
    emit_fastmem_guard(wb, params);
    rc.Flush(params.ctx_ptr);  // stack-neutral — guard stays on top

    // Bind RT now (post-flush). Marks rt dirty so its end-of-block flush
    // writes the loaded value back to memory.
    auto rc_rt = rc.Bind(rt, RCMode::Write);
    const u32 rt_local = rc_rt.local_idx();

    wb.op_if(BLOCK_TYPE_VOID);

    // ---- fast path ----
    emit_fastmem_load_value(wb, params, width);
    wb.op_local_set(rt_local);

    wb.op_else();

    // ---- slow path ----
    emit_slowmem_load_value(wb, width);
    wb.op_local_set(rt_local);

    wb.op_end();

    // RegCache invalidates immediate-tracking on merge — emitter doesn't
    // need to do it manually since we marked rt dirty via Bind(Write) and
    // both arms wrote through to the same local.

    if (update && ra != 0) {
        auto rc_ra = rc.Bind(ra, RCMode::Write);
        wb.op_local_get(LOCAL_TMP_EA);
        wb.op_local_set(rc_ra.local_idx());
    }
}

static void emit_store_common(WasmModuleBuilder& wb, RegCache& rc,
                              LoadStoreParams params, u32 rs, u32 ra,
                              StoreWidth width, bool update) {
    // Read RS — bind for the value-to-be-stored.
    auto rc_rs = rc.Bind(rs, RCMode::Read);
    const u32 rs_local = rc_rs.local_idx();

    emit_fastmem_guard(wb, params);
    rc.Flush(params.ctx_ptr);
    wb.op_if(BLOCK_TYPE_VOID);

    emit_fastmem_store(wb, params, width, rs_local);

    wb.op_else();

    emit_slowmem_store(wb, width, rs_local);

    wb.op_end();

    if (update && ra != 0) {
        auto rc_ra = rc.Bind(ra, RCMode::Write);
        wb.op_local_get(LOCAL_TMP_EA);
        wb.op_local_set(rc_ra.local_idx());
    }
}

// ---------------------------------------------------------------------------
// Const-address MMIO routing.
//
// Ported from Dolphin Jit64's EmuCodeBlock::WriteToConstAddress
// (Source/Core/Core/PowerPC/Jit64Common/EmuCodeBlock.cpp:631-686). When
// the analyzer proved the effective address at compile time, MMIO writes
// (0xCC000000..0xCC03FFFF — GameCube hardware-register window) must
// route DIRECTLY through the host ppc_write* import. The runtime
// MMIO-mirror fast path (live emitter, gekko_emit.cpp:640) is a
// performance hack that lets the host coalesce writes into a SAB mirror;
// for MMIO addresses with side effects (DVDInterface DICR/DICMDBUF,
// AudioInterface, ProcessorInterface…) that coalescing reorders the
// store with respect to subsequent JIT-emitted ops and the host MMIO
// handler — which is exactly the DICR.TSTART-before-DICMDBUF[0] ordering
// failure that triggers DVDInterface.cpp:1286 "Unknown DVD command
// 00000000 - fatal error" on PSO boot.
//
// Const-EA store ordering guarantee: rc.Flush(ctx_ptr) is emitted BEFORE
// the import call (so any dirty GPRs the handler may inspect through
// PowerPCState are coherent), and the import call is a wasm `call` to
// an imported host function — the V8 wasm engine treats imports as
// opaque external calls and is forbidden by the wasm-spec from
// reordering wasm side effects across them. The subsequent JIT-emitted
// op observes the host write's full side effect.
// ---------------------------------------------------------------------------
static constexpr u32 MMIO_BASE = 0xCC000000u;
static constexpr u32 MMIO_END  = 0xCC040000u;

static bool is_mmio_const_addr(u32 addr) {
    return addr >= MMIO_BASE && addr < MMIO_END;
}

// Emit a store to a compile-time-known MMIO address. Stack-neutral.
static void emit_const_mmio_store(WasmModuleBuilder& wb, RegCache& rc,
                                  LoadStoreParams params, u32 addr,
                                  StoreWidth width, u32 src_local) {
    // Flush dirty GPRs to PowerPCState — host MMIO handler may read them
    // (e.g. ExpansionInterface inspects gpr[3..5] for some commands).
    rc.Flush(params.ctx_ptr);
    // Push address + value, call import. The wasm `call` to a host import
    // is a strict happens-before barrier per wasm semantics — no
    // subsequent op can be hoisted across it.
    wb.op_i32_const((s32)addr);
    wb.op_local_get(src_local);
    wb.op_call(write_import_for_width(width));
}

// Emit a load from a compile-time-known MMIO address. Leaves the loaded
// value (sign-extended for S16) on the stack.
static void emit_const_mmio_load(WasmModuleBuilder& wb, RegCache& rc,
                                 LoadStoreParams params, u32 addr,
                                 LoadWidth width) {
    rc.Flush(params.ctx_ptr);
    wb.op_i32_const((s32)addr);
    wb.op_call(read_import_for_width(width));
    if (width == LoadWidth::S16) {
        wb.op_i32_const(16);
        wb.op_i32_shl();
        wb.op_i32_const(16);
        wb.op_i32_shr_s();
    }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------
void emit_load_d(WasmModuleBuilder& wb, RegCache& rc,
                 LoadStoreParams params, const CodeOp& op,
                 LoadWidth width, bool update) {
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 simm = GekkoOperands::SIMM_16(inst);

    // Compile-time-known address: route MMIO directly through the import,
    // keep non-MMIO on the fastmem path. RAM loads still go through the
    // guarded if/else (BAT/TLB races on MMU enable would otherwise
    // require yet another const-address gate).
    if (op.has_const_ea && is_mmio_const_addr(op.const_ea)) {
        auto rc_rt = rc.Bind(rt, RCMode::Write);
        emit_const_mmio_load(wb, rc, params, op.const_ea, width);
        wb.op_local_set(rc_rt.local_idx());
        if (update && ra != 0) {
            auto rc_ra = rc.Bind(ra, RCMode::Write);
            wb.op_i32_const((s32)op.const_ea);
            wb.op_local_set(rc_ra.local_idx());
        }
        return;
    }

    emit_ea_d_form(wb, rc, ra, simm);
    emit_load_common(wb, rc, params, rt, ra, width, update);
}

void emit_store_d(WasmModuleBuilder& wb, RegCache& rc,
                  LoadStoreParams params, const CodeOp& op,
                  StoreWidth width, bool update) {
    const u32 inst = op.inst;
    const u32 rs   = GekkoOperands::RS(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 simm = GekkoOperands::SIMM_16(inst);

    // Const-address MMIO store: bypass the fastmem-guarded if/else and
    // route directly to the host import. Preserves the host-observable
    // store ordering required by DVDInterface DICR.TSTART/DICMDBUF[0],
    // AudioInterface, etc.
    if (op.has_const_ea && is_mmio_const_addr(op.const_ea)) {
        auto rc_rs = rc.Bind(rs, RCMode::Read);
        emit_const_mmio_store(wb, rc, params, op.const_ea, width,
                              rc_rs.local_idx());
        if (update && ra != 0) {
            auto rc_ra = rc.Bind(ra, RCMode::Write);
            wb.op_i32_const((s32)op.const_ea);
            wb.op_local_set(rc_ra.local_idx());
        }
        return;
    }

    emit_ea_d_form(wb, rc, ra, simm);
    emit_store_common(wb, rc, params, rs, ra, width, update);
}

void emit_load_x(WasmModuleBuilder& wb, RegCache& rc,
                 LoadStoreParams params, const CodeOp& op,
                 LoadWidth width, bool update) {
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rb   = GekkoOperands::RB(inst);
    emit_ea_x_form(wb, rc, ra, rb);
    emit_load_common(wb, rc, params, rt, ra, width, update);
}

void emit_store_x(WasmModuleBuilder& wb, RegCache& rc,
                  LoadStoreParams params, const CodeOp& op,
                  StoreWidth width, bool update) {
    const u32 inst = op.inst;
    const u32 rs   = GekkoOperands::RS(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rb   = GekkoOperands::RB(inst);
    emit_ea_x_form(wb, rc, ra, rb);
    emit_store_common(wb, rc, params, rs, ra, width, update);
}

// ---------------------------------------------------------------------------
// FP X-form: lfsx / stfsx / stfiwx. All route through WIMPORT_READ32/WRITE32
// without fastmem (FPRs touched in MMIO range is exceedingly rare and the
// f32 reinterpret prelude/postlude is awkward to share with the integer
// fastmem shape). Flush regcache before the call so host MMIO handlers see
// coherent PowerPCState.
// Ported from gekko_emit.cpp:2847-2878.
// ---------------------------------------------------------------------------

// Compute EA = (ra ? gpr[ra] : 0) + gpr[rb] and leave it on the wasm stack.
static void emit_ea_x_stack(WasmModuleBuilder& wb, RegCache& rc,
                            u32 ra, u32 rb) {
    auto rc_rb = rc.Bind(rb, RCMode::Read);
    if (ra == 0) {
        wb.op_local_get(rc_rb.local_idx());
    } else {
        auto rc_ra = rc.Bind(ra, RCMode::Read);
        wb.op_local_get(rc_ra.local_idx());
        wb.op_local_get(rc_rb.local_idx());
        wb.op_i32_add();
    }
}

// lfsx fT, rA, rB — load f32 at EA, promote to f64, store at ps0(rt).
// gekko_emit.cpp:2847 emit_lfsx_impl.
void emit_lfsx(WasmModuleBuilder& wb, RegCache& rc,
               LoadStoreParams params, const CodeOp& op) {
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rb   = GekkoOperands::RB(inst);

    // Compute EA to stack, save into LOCAL_TMP_EA.
    emit_ea_x_stack(wb, rc, ra, rb);
    wb.op_local_set(LOCAL_TMP_EA);

    // Flush regcache before WIMPORT call (host may dereference PowerPCState).
    rc.Flush(params.ctx_ptr);

    // Push ctx pointer for the eventual f64.store at the end.
    wb.op_i32_const((s32)params.ctx_ptr);
    // read32(EA) returns u32 big-endian-converted bits.
    wb.op_local_get(LOCAL_TMP_EA);
    wb.op_call(WIMPORT_READ32);
    // reinterpret as f32 -> promote to f64 -> store
    wb.op_f32_reinterpret_i32();
    wb.op_f64_promote_f32();
    wb.op_f64_store(ppc_off::ps0(rt));
}

// stfsx fS, rA, rB — demote ps0(rs) f64 to f32, store via WIMPORT_WRITE32.
// gekko_emit.cpp:2858 emit_stfsx_impl.
void emit_stfsx(WasmModuleBuilder& wb, RegCache& rc,
                LoadStoreParams params, const CodeOp& op) {
    const u32 inst = op.inst;
    const u32 rs   = GekkoOperands::RS(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rb   = GekkoOperands::RB(inst);

    emit_ea_x_stack(wb, rc, ra, rb);
    wb.op_local_set(LOCAL_TMP_EA);

    rc.Flush(params.ctx_ptr);

    // write32(EA, demote(f64) as u32) — push EA, push value, call.
    wb.op_local_get(LOCAL_TMP_EA);
    wb.op_i32_const((s32)params.ctx_ptr);
    wb.op_f64_load(ppc_off::ps0(rs));
    wb.op_f32_demote_f64();
    wb.op_i32_reinterpret_f32();
    wb.op_call(WIMPORT_WRITE32);
}

// stfiwx fS, rA, rB — write low 32 bits of ps0(rs) f64 as a word.
// Little-endian f64 host storage puts the low 32 bits at offset +0.
// gekko_emit.cpp:2872 emit_stfiwx_impl.
void emit_stfiwx(WasmModuleBuilder& wb, RegCache& rc,
                 LoadStoreParams params, const CodeOp& op) {
    const u32 inst = op.inst;
    const u32 rs   = GekkoOperands::RS(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rb   = GekkoOperands::RB(inst);

    emit_ea_x_stack(wb, rc, ra, rb);
    wb.op_local_set(LOCAL_TMP_EA);

    rc.Flush(params.ctx_ptr);

    wb.op_local_get(LOCAL_TMP_EA);
    wb.op_i32_const((s32)params.ctx_ptr);
    wb.op_i32_load(ppc_off::ps0(rs));  // low 32 bits of f64 slot (little-endian host)
    wb.op_call(WIMPORT_WRITE32);
}

}  // namespace bemental::powerpc
