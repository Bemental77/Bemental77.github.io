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
    // Bind RT in Write mode — invalidates any prior immediate / read state.
    auto rc_rt = rc.Bind(rt, RCMode::Write);
    const u32 rt_local = rc_rt.local_idx();

    // Push fastmem-guard onto stack, then flush dirty bindings, then op_if.
    emit_fastmem_guard(wb, params);
    rc.Flush(params.ctx_ptr);  // stack-neutral — guard stays on top
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
// Public entry points
// ---------------------------------------------------------------------------
void emit_load_d(WasmModuleBuilder& wb, RegCache& rc,
                 LoadStoreParams params, const CodeOp& op,
                 LoadWidth width, bool update) {
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 simm = GekkoOperands::SIMM_16(inst);
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

}  // namespace bemental::powerpc
