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
#include "fpr_reg_cache.h"
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
//
// `access_bytes` is the size of the upcoming load/store (1/2/4) so the
// bound check accounts for accesses that straddle the MEM1 tail. Without
// this, a 4-byte access at EA = ram_size - 1 passes the guard but reads
// bytes through ram_size + 2 → wasm linear-memory OOB trap when the host
// heap hasn't grown past mem1_base + ram_size + (width-1). Pass-6 audit
// 2026-06-06 (workflow a8a87199a5f5ac928): root cause of the OOB trap
// observed shortly after `Audio DMA configured` — a JIT block hit the
// MEM1 tail during the audio ISR's context save path with width>1.
// ---------------------------------------------------------------------------
static void emit_fastmem_guard(WasmModuleBuilder& wb, LoadStoreParams params,
                               u32 access_bytes) {
    // Degenerate MEM1 window (ram_size smaller than the access width — e.g.
    // an unconfigured mem1 in a test harness): the `ram_size -
    // (access_bytes - 1)` bound below wraps unsigned and ADMITS every
    // address into the fast path, whose host address (EA & mask) + base
    // then aliases low linear memory (observed as address-zero heap
    // corruption in test_gekko_next). Emit constant-false so the select
    // always takes the trampoline — matches legacy build_block's behavior
    // when mem1 is unconfigured. Compile-time constant; zero cost on a
    // real config.
    if (params.ram_size < access_bytes) {
        wb.op_i32_const(0);
        return;
    }
    // (EA & 0x1F000000) == 0  — top bits zero (filters out MMIO @ 0xCC* etc.)
    wb.op_local_get(LOCAL_TMP_EA);
    wb.op_i32_const(0x1F000000);
    wb.op_i32_and();
    wb.op_i32_eqz();
    // (EA & mem1_mask) <= ram_size - access_bytes — the masked EA plus the
    // access width must fit within ram_size. Use lt_u with bound = ram_size
    // - (access_bytes - 1) which is the smallest EA that would write past
    // the end. For 4-byte access, bound = ram_size - 3.
    wb.op_local_get(LOCAL_TMP_EA);
    wb.op_i32_const((s32)params.mem1_mask);
    wb.op_i32_and();
    wb.op_i32_const((s32)(params.ram_size - (access_bytes - 1)));
    wb.op_i32_lt_u();
    // AND
    wb.op_i32_and();
}

static u32 load_width_bytes(LoadWidth w) {
    switch (w) {
    case LoadWidth::U8:  return 1;
    case LoadWidth::U16: return 2;
    case LoadWidth::S16: return 2;
    case LoadWidth::U32: return 4;
    }
    return 4;
}

static u32 store_width_bytes(StoreWidth w) {
    switch (w) {
    case StoreWidth::U8:  return 1;
    case StoreWidth::U16: return 2;
    case StoreWidth::U32: return 4;
    }
    return 4;
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
                             FPRRegCache& frc,
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
    emit_fastmem_guard(wb, params, load_width_bytes(width));
    rc.Flush(params.ctx_ptr);  // stack-neutral — guard stays on top
    frc.Flush(params.ctx_ptr);

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
                              FPRRegCache& frc,
                              LoadStoreParams params, u32 rs, u32 ra,
                              StoreWidth width, bool update) {
    // Read RS — bind for the value-to-be-stored.
    auto rc_rs = rc.Bind(rs, RCMode::Read);
    const u32 rs_local = rc_rs.local_idx();

    emit_fastmem_guard(wb, params, store_width_bytes(width));
    rc.Flush(params.ctx_ptr);
    frc.Flush(params.ctx_ptr);
    wb.op_if(BLOCK_TYPE_VOID);

    emit_fastmem_store(wb, params, width, rs_local);

    wb.op_else();

    emit_slowmem_store(wb, width, rs_local);

    wb.op_end();

    // TODO(audit 2026-06-01): update-form stores (opcd 37/39/41/43/45 — Rc/L
    // low-bit set) should suppress the RA writeback if the slow path raised
    // EXCEPTION_DSI. PowerPC architecture spec: update-form ops must NOT
    // commit RA on a DSI/Alignment/data-page-fault. Currently the writeback
    // is unconditional, which can desynchronize RA from the architectural
    // state on a faulting store. Cleanly emitting the guard requires a
    // ppc_off::Exceptions and EXCEPTION_DSI constant; neither is in
    // ppc_offsets.h today (only PC/NPC/GPR/CR/MSR/FPSCR/XER/SPR are
    // defined). Skipped per the audit instructions' PARTIAL fallback path.
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
                                  FPRRegCache& frc,
                                  LoadStoreParams params, u32 addr,
                                  StoreWidth width, u32 src_local) {
    // Flush dirty GPRs to PowerPCState — host MMIO handler may read them
    // (e.g. ExpansionInterface inspects gpr[3..5] for some commands).
    rc.Flush(params.ctx_ptr);
    frc.Flush(params.ctx_ptr);
    // Push address + value, call import. The wasm `call` to a host import
    // is a strict happens-before barrier per wasm semantics — no
    // subsequent op can be hoisted across it.
    wb.op_i32_const((s32)addr);
    wb.op_local_get(src_local);
    wb.op_call(write_import_for_width(width));
}

// Emit a load from a compile-time-known MMIO address. Leaves the loaded
// value (sign-extended for S16) on the stack.
// 2026-06-01: callers now inline the body to avoid the Flush-after-Bind
// stale-zero ordering bug; this helper is preserved for future reuse and
// marked maybe_unused.
[[maybe_unused]] static void emit_const_mmio_load(WasmModuleBuilder& wb, RegCache& rc,
                                 FPRRegCache& frc,
                                 LoadStoreParams params, u32 addr,
                                 LoadWidth width) {
    rc.Flush(params.ctx_ptr);
    frc.Flush(params.ctx_ptr);
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
void emit_load_d(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
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
        // CRITICAL: Flush dirty regcache BEFORE Bind(rt, Write). Binding rt
        // first marks its wasm-local as the canonical source; the subsequent
        // Flush inside emit_const_mmio_load would then write rt's stale local
        // (default 0) to memory[gpr(rt)] BEFORE the import call produces the
        // loaded value. This is the same stale-zero memory-corruption bug
        // fixed for emit_load_common at 2026-05-31 (commit 4247f98 — see
        // ordering comment at lines 245-260 above). Mirror that ordering
        // here: Flush, then Bind(Write), then perform the load.
        rc.Flush(params.ctx_ptr);
        frc.Flush(params.ctx_ptr);
        auto rc_rt = rc.Bind(rt, RCMode::Write);
        // emit_const_mmio_load also calls rc.Flush internally — a second
        // Flush after Bind(Write) would re-trigger the stale-write bug.
        // Inline its body here (sans the redundant Flush) instead.
        wb.op_i32_const((s32)op.const_ea);
        wb.op_call(read_import_for_width(width));
        if (width == LoadWidth::S16) {
            wb.op_i32_const(16);
            wb.op_i32_shl();
            wb.op_i32_const(16);
            wb.op_i32_shr_s();
        }
        wb.op_local_set(rc_rt.local_idx());
        if (update && ra != 0) {
            auto rc_ra = rc.Bind(ra, RCMode::Write);
            wb.op_i32_const((s32)op.const_ea);
            wb.op_local_set(rc_ra.local_idx());
        }
        return;
    }

    emit_ea_d_form(wb, rc, ra, simm);
    emit_load_common(wb, rc, frc, params, rt, ra, width, update);
}

void emit_store_d(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
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
        emit_const_mmio_store(wb, rc, frc, params, op.const_ea, width,
                              rc_rs.local_idx());
        if (update && ra != 0) {
            auto rc_ra = rc.Bind(ra, RCMode::Write);
            wb.op_i32_const((s32)op.const_ea);
            wb.op_local_set(rc_ra.local_idx());
        }
        return;
    }

    emit_ea_d_form(wb, rc, ra, simm);
    emit_store_common(wb, rc, frc, params, rs, ra, width, update);
}

void emit_load_x(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                 LoadStoreParams params, const CodeOp& op,
                 LoadWidth width, bool update) {
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rb   = GekkoOperands::RB(inst);
    emit_ea_x_form(wb, rc, ra, rb);
    emit_load_common(wb, rc, frc, params, rt, ra, width, update);
}

void emit_store_x(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                  LoadStoreParams params, const CodeOp& op,
                  StoreWidth width, bool update) {
    const u32 inst = op.inst;
    const u32 rs   = GekkoOperands::RS(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rb   = GekkoOperands::RB(inst);
    emit_ea_x_form(wb, rc, ra, rb);
    emit_store_common(wb, rc, frc, params, rs, ra, width, update);
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

// lfsx fT, rA, rB — load f32 at EA, promote to f64, store at ps0(rt) +
// splat to ps1(rt). Cache-local form: write the promoted f64 (as i64 bits)
// to both ps0 and ps1 cache locals. No memory traffic for the FPR side;
// memory becomes canonical at block-exit frc.Flush.
void emit_lfsx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
               LoadStoreParams params, const CodeOp& op) {
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rb   = GekkoOperands::RB(inst);

    // Compute EA to stack, save into LOCAL_TMP_EA.
    emit_ea_x_stack(wb, rc, ra, rb);
    wb.op_local_set(LOCAL_TMP_EA);

    // Flush GPRs (host MMIO handler may inspect them); flush FPRs so the
    // host READ32 doesn't see a stale ps0 slot (defensive — READ32 is a
    // memory read of the EA, not of ps0, but the FPR cache flush is cheap
    // and keeps memory ordering observable).
    rc.Flush(params.ctx_ptr);
    frc.Flush(params.ctx_ptr);

    // Read the f32 into an i64 (zero-extended after the f64 promote
    // round-trip). Land it in BOTH ps0 + ps1 cache locals.
    auto rt_pair = frc.Bind(rt, FPRMode::Write, FPR_LANE_BOTH);

    wb.op_local_get(LOCAL_TMP_EA);
    wb.op_call(WIMPORT_READ32);
    wb.op_f32_reinterpret_i32();
    wb.op_f64_promote_f32();
    wb.op_i64_reinterpret_f64();
    // Use local_tee so the i64 stays on the stack for the second local_set.
    wb.op_local_tee(rt_pair.ps0_idx);
    wb.op_local_set(rt_pair.ps1_idx);
}

// emit_convert_to_single — push ConvertToSingle(ps0_bits) as i32.
// Bit-exact port of Dolphin Interpreter_FPUtils.h:541-562 (the stfs/stfsu/
// stfsx store conversion; NOT the FTZ variant used by psq_st):
//   exp = (x >> 52) & 0x7ff
//   fast   (exp > 896 || mag == 0, and the "undefined" exp < 874 case —
//           both branches are the same formula):
//          ((x>>32) & 0xC0000000) | ((x>>29) & 0x3FFFFFFF)
//   denorm (874 <= exp <= 896 && mag != 0):
//          ((0x80000000 | ((x & DOUBLE_FRAC) >> 21)) >> (905 - exp))
//          | ((x>>32) & 0x80000000)
// Branchless via wasm `select` — both values computed, condition picks.
// In the discarded fast case the denorm shift amount may exceed 31; wasm
// i32.shr_u masks the count (&31), so it cannot trap. Clobbers
// LOCAL_TMP_VAL (exp scratch); ps0_local is an i64 FPR cache local.
static void emit_convert_to_single(WasmModuleBuilder& wb, u32 ps0_local) {
    // exp -> LOCAL_TMP_VAL
    wb.op_local_get(ps0_local);
    wb.op_i64_const(52);
    wb.op_i64_shr_u();
    wb.op_i32_wrap_i64();
    wb.op_i32_const(0x7FF);
    wb.op_i32_and();
    wb.op_local_set(LOCAL_TMP_VAL);

    // denorm value
    wb.op_local_get(ps0_local);
    wb.op_i64_const(0x000FFFFFFFFFFFFFll);  // Common::DOUBLE_FRAC
    wb.op_i64_and();
    wb.op_i64_const(21);
    wb.op_i64_shr_u();
    wb.op_i32_wrap_i64();
    wb.op_i32_const((s32)0x80000000u);
    wb.op_i32_or();
    wb.op_i32_const(905);
    wb.op_local_get(LOCAL_TMP_VAL);
    wb.op_i32_sub();
    wb.op_i32_shr_u();
    wb.op_local_get(ps0_local);
    wb.op_i64_const(32);
    wb.op_i64_shr_u();
    wb.op_i32_wrap_i64();
    wb.op_i32_const((s32)0x80000000u);
    wb.op_i32_and();
    wb.op_i32_or();

    // fast value
    wb.op_local_get(ps0_local);
    wb.op_i64_const(32);
    wb.op_i64_shr_u();
    wb.op_i32_wrap_i64();
    wb.op_i32_const((s32)0xC0000000u);
    wb.op_i32_and();
    wb.op_local_get(ps0_local);
    wb.op_i64_const(29);
    wb.op_i64_shr_u();
    wb.op_i32_wrap_i64();
    wb.op_i32_const(0x3FFFFFFF);
    wb.op_i32_and();
    wb.op_i32_or();

    // cond: (exp >= 874) & (exp <= 896) & (magnitude != 0)
    wb.op_local_get(LOCAL_TMP_VAL);
    wb.op_i32_const(874);
    wb.op_i32_ge_u();
    wb.op_local_get(LOCAL_TMP_VAL);
    wb.op_i32_const(896);
    wb.op_i32_le_u();
    wb.op_i32_and();
    // mag != 0: ((wrap(x>>32) & 0x7FFFFFFF) | wrap(x)) != 0 — no i64.eqz
    // in the builder, so do it in i32 halves.
    wb.op_local_get(ps0_local);
    wb.op_i64_const(32);
    wb.op_i64_shr_u();
    wb.op_i32_wrap_i64();
    wb.op_i32_const(0x7FFFFFFF);
    wb.op_i32_and();
    wb.op_local_get(ps0_local);
    wb.op_i32_wrap_i64();
    wb.op_i32_or();
    wb.op_i32_eqz();
    wb.op_i32_eqz();
    wb.op_i32_and();

    wb.op_select();  // cond ? denorm : fast
}

// stfsx fS, rA, rB — store f32 from ps0(rs) at EA, PEM ConvertToSingle
// semantics (2026-06-11: native emit replaces the interp-fallback stub;
// the conversion lives in emit_convert_to_single above).
void emit_stfsx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                LoadStoreParams params, const CodeOp& op) {
    const u32 inst = op.inst;
    const u32 rs   = GekkoOperands::RS(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rb   = GekkoOperands::RB(inst);

    emit_ea_x_stack(wb, rc, ra, rb);
    wb.op_local_set(LOCAL_TMP_EA);

    auto rs_pair = frc.Bind(rs, FPRMode::Read, FPR_LANE_PS0);

    // GPR flush — host WRITE32 may dispatch into MMIO that reads gpr[].
    rc.Flush(params.ctx_ptr);

    wb.op_local_get(LOCAL_TMP_EA);
    emit_convert_to_single(wb, rs_pair.ps0_idx);
    wb.op_call(WIMPORT_WRITE32);
}

// stfs  fS, d(rA) — D-form single store, PEM ConvertToSingle semantics.
// stfsu fS, d(rA) — update form: rA <- EA after the store.
// 2026-06-11: native emit (was interp fallback "deferred, needs PEM
// ConvertToSingle"). stfs is every single-precision float store the guest
// makes — the highest-frequency FP fallback in gameplay code paths.
void emit_stfs(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
               LoadStoreParams params, const CodeOp& op, bool update) {
    const u32 inst = op.inst;
    const u32 rs   = GekkoOperands::RS(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 simm = GekkoOperands::SIMM_16(inst);

    emit_ea_d_form(wb, rc, ra, simm);  // EA -> LOCAL_TMP_EA

    auto rs_pair = frc.Bind(rs, FPRMode::Read, FPR_LANE_PS0);

    // GPR flush — host WRITE32 may dispatch into MMIO that reads gpr[].
    rc.Flush(params.ctx_ptr);

    wb.op_local_get(LOCAL_TMP_EA);
    emit_convert_to_single(wb, rs_pair.ps0_idx);
    wb.op_call(WIMPORT_WRITE32);

    if (update && ra != 0) {
        auto rc_ra = rc.Bind(ra, RCMode::Write);
        wb.op_local_get(LOCAL_TMP_EA);
        wb.op_local_set(rc_ra.local_idx());
    }
}

// lfd  FRD, d(rA)  — load f64 (8 bytes BE) from EA, store at ps0(FRD).
// lfdu FRD, d(rA)  — same + rA <- EA (update form, opc 51).
// Slowmem-only path (no fastmem): two WIMPORT_READ32 calls (each host
// byte-swaps its u32), combined into i64 with high u32 in upper bits and
// low u32 in lower bits, then f64_reinterpret_i64 + f64_store directly to
// the PowerPCState mirror. No FPR cache.
//
// Per mp4_wedge_is_throughput_2026_06_07: every gcsetjmp/gclongjmp pays
// 18 of these via interp fallback (~18×WIMPORT_INTERP roundtrips). Native
// emit is the documented throughput fix path. Per FP audit researcher
// 2026-06-08: structurally mirrors emit_lfsx but for 8 bytes.
void emit_lfd(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
              LoadStoreParams params, const CodeOp& op, bool update) {
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 simm = GekkoOperands::SIMM_16(inst);

    emit_ea_d_form(wb, rc, ra, simm);  // EA -> LOCAL_TMP_EA

    rc.Flush(params.ctx_ptr);
    frc.Flush(params.ctx_ptr);

    // Bind rt for Write — only ps0 lane (lfd does NOT splat to ps1; ps1 is
    // preserved per scalar-FP semantics, unlike lfsx/lfs which DO splat).
    auto rt_pair = frc.Bind(rt, FPRMode::Write, FPR_LANE_PS0);

    // high u32 = read32(EA) <<i64 32
    wb.op_local_get(LOCAL_TMP_EA);
    wb.op_call(WIMPORT_READ32);
    wb.op_i64_extend_i32_u();
    wb.op_i64_const(32);
    wb.op_i64_shl();

    // low u32 = read32(EA + 4)
    wb.op_local_get(LOCAL_TMP_EA);
    wb.op_i32_const(4);
    wb.op_i32_add();
    wb.op_call(WIMPORT_READ32);
    wb.op_i64_extend_i32_u();

    // Combine + store into ps0 cache local (i64 — preserves bit pattern).
    wb.op_i64_or();
    wb.op_local_set(rt_pair.ps0_idx);

    if (update && ra != 0) {
        auto rc_ra = rc.Bind(ra, RCMode::Write);
        wb.op_local_get(LOCAL_TMP_EA);
        wb.op_local_set(rc_ra.local_idx());
    }
}

// stfd  FRS, d(rA) — store f64 from ps0(FRS) at EA (8 bytes BE).
// stfdu FRS, d(rA) — same + rA <- EA (update form, opc 55).
//
// Cache-local form: read the i64 from rs's ps0 cache local (the i64
// equals the big-endian guest's 8-byte value reinterpreted to host LE
// bits — same as the f64 stored in memory before). Extract halves via
// i64.shr / i64.wrap. The high i64 bits = guest BYTES 0..3; the low
// i64 bits = guest BYTES 4..7. WIMPORT_WRITE32 byte-swaps host LE u32 →
// guest BE bytes, so:
//   write32(EA,     wrap(local >> 32)) → EA..EA+3 = guest BYTES 0..3
//   write32(EA + 4, wrap(local))       → EA+4..EA+7 = guest BYTES 4..7
//
// Eliminates the latent stale-memory bug: when rs's ps0 lane is dirty in
// the cache, the prior code read memory ps0(rs)+0/+4 — which held the
// pre-write value. The fix is structural: read the local, which always
// holds the current value.
void emit_stfd(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
               LoadStoreParams params, const CodeOp& op, bool update) {
    const u32 inst = op.inst;
    const u32 rs   = GekkoOperands::RS(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 simm = GekkoOperands::SIMM_16(inst);

    emit_ea_d_form(wb, rc, ra, simm);  // EA -> LOCAL_TMP_EA

    // Read rs's ps0 lane from cache. No frc.Flush needed for the source
    // (we're reading from the local, not memory).
    auto rs_pair = frc.Bind(rs, FPRMode::Read, FPR_LANE_PS0);

    // GPR flush — host WRITE32 may dispatch into MMIO that reads gpr[].
    rc.Flush(params.ctx_ptr);

    // write32(EA, wrap(rs_local >> 32))  — guest BYTES 0..3 (high i64 bits).
    wb.op_local_get(LOCAL_TMP_EA);
    wb.op_local_get(rs_pair.ps0_idx);
    wb.op_i64_const(32);
    wb.op_i64_shr_u();
    wb.op_i32_wrap_i64();
    wb.op_call(WIMPORT_WRITE32);

    // write32(EA + 4, wrap(rs_local))    — guest BYTES 4..7 (low i64 bits).
    wb.op_local_get(LOCAL_TMP_EA);
    wb.op_i32_const(4);
    wb.op_i32_add();
    wb.op_local_get(rs_pair.ps0_idx);
    wb.op_i32_wrap_i64();
    wb.op_call(WIMPORT_WRITE32);

    if (update && ra != 0) {
        auto rc_ra = rc.Bind(ra, RCMode::Write);
        wb.op_local_get(LOCAL_TMP_EA);
        wb.op_local_set(rc_ra.local_idx());
    }
}


// ---------------------------------------------------------------------------
// psq_l / psq_st — native paired-single quantized load/store (D-forms,
// opcd 56/57/60/61). Bit-exact reference: Interpreter_LoadStorePaired.cpp
// (ILSP). Documented divergences (header comment): no HID2.PSE/LSQE gate
// (Jit64 parity — Jit64 emits none); DSI handling follows the lfs/stfs
// precedent (no gate; queued with the update-form RA audit item). GQR is a
// RUNTIME load every execution — no constant-GQR speculation (mtspr GQR is
// an interp fallback mutating spr[] mid-block).
// ---------------------------------------------------------------------------

// Extra scratch appended as the 4th locals group by build_block_next:
// two i32 pair-element stages + one f64 clamp stage.
static constexpr u32 LOCAL_PSQ_T0  = 98;
static constexpr u32 LOCAL_PSQ_T1  = 99;
static constexpr u32 LOCAL_PSQ_F64 = 100;

// Push ConvertToDouble(f32 bits in LOCAL_PSQ_T0) as i64. ILSP:237 uses the
// PEM widening that PRESERVES NaN payloads (incl. the SNaN quiet bit) while
// wasm f64.promote_f32 may canonicalize NaNs (spec-permitted). Promote is
// IEEE-bit-exact for normal/zero/subnormal/inf, so: promote for the common
// case, integer splice for exp==255 (FPU:607-612 arm, y=1 -> z=0x7<<59:
// ((x&0xc0000000)<<32) | z | ((x&0x3fffffff)<<29)) — also exact for inf.
// Non-static: also used by jit_floating_point.cpp (op59 singles / frsp)
// to widen the ForceSingle result back to the f64 register format.
void emit_psq_convert_to_double(WasmModuleBuilder& wb) {
    // splice value (exp==255 arm)
    wb.op_local_get(LOCAL_PSQ_T0);
    wb.op_i64_extend_i32_u();
    wb.op_i64_const((s64)0xC0000000ll);
    wb.op_i64_and();
    wb.op_i64_const(32);
    wb.op_i64_shl();
    wb.op_i64_const(0x3800000000000000ll);  // 0x7 << 59
    wb.op_i64_or();
    wb.op_local_get(LOCAL_PSQ_T0);
    wb.op_i64_extend_i32_u();
    wb.op_i64_const(0x3FFFFFFFll);
    wb.op_i64_and();
    wb.op_i64_const(29);
    wb.op_i64_shl();
    wb.op_i64_or();
    // promote value
    wb.op_local_get(LOCAL_PSQ_T0);
    wb.op_f32_reinterpret_i32();
    wb.op_f64_promote_f32();
    wb.op_i64_reinterpret_f64();
    // cond: exp == 255 -> pick splice
    wb.op_local_get(LOCAL_PSQ_T0);
    wb.op_i32_const(23);
    wb.op_i32_shr_u();
    wb.op_i32_const(0xFF);
    wb.op_i32_and();
    wb.op_i32_const(0xFF);
    wb.op_i32_eq();
    wb.op_select();
}

// Push ConvertToSingleFTZ(ps_local) as i32 (ILSP:159; FPU:565-577):
//   (exp > 896 || magnitude == 0) -> ((x>>32)&0xC0000000)|((x>>29)&0x3FFFFFFF)
//   else                          -> (x>>32)&0x80000000  (flush to signed 0)
static void emit_convert_to_single_ftz(WasmModuleBuilder& wb, u32 ps_local) {
    // fast value (val1)
    wb.op_local_get(ps_local);
    wb.op_i64_const(32);
    wb.op_i64_shr_u();
    wb.op_i32_wrap_i64();
    wb.op_i32_const((s32)0xC0000000u);
    wb.op_i32_and();
    wb.op_local_get(ps_local);
    wb.op_i64_const(29);
    wb.op_i64_shr_u();
    wb.op_i32_wrap_i64();
    wb.op_i32_const(0x3FFFFFFF);
    wb.op_i32_and();
    wb.op_i32_or();
    // sign-only flush value (val2)
    wb.op_local_get(ps_local);
    wb.op_i64_const(32);
    wb.op_i64_shr_u();
    wb.op_i32_wrap_i64();
    wb.op_i32_const((s32)0x80000000u);
    wb.op_i32_and();
    // cond: exp > 896 || mag == 0 -> pick fast
    wb.op_local_get(ps_local);
    wb.op_i64_const(52);
    wb.op_i64_shr_u();
    wb.op_i32_wrap_i64();
    wb.op_i32_const(0x7FF);
    wb.op_i32_and();
    wb.op_i32_const(896);
    wb.op_i32_gt_u();
    wb.op_local_get(ps_local);
    wb.op_i64_const(32);
    wb.op_i64_shr_u();
    wb.op_i32_wrap_i64();
    wb.op_i32_const(0x7FFFFFFF);
    wb.op_i32_and();
    wb.op_local_get(ps_local);
    wb.op_i32_wrap_i64();
    wb.op_i32_or();
    wb.op_i32_eqz();
    wb.op_i32_or();
    wb.op_select();
}

// Push the scale factor as f32 from a 6-bit scale field on the stack:
// dequantize factor = 2^-scale (f32 bits (127-sext6(s))<<23), quantize =
// 2^scale ((127+sext6(s))<<23). scale in [-32,31] -> exponent stays normal.
static void emit_psq_factor_from_scale(WasmModuleBuilder& wb, bool quantize) {
    wb.op_i32_const(26);
    wb.op_i32_shl();
    wb.op_i32_const(26);
    wb.op_i32_shr_s();
    if (quantize) {
        wb.op_i32_const(127);
        wb.op_i32_add();
    } else {
        wb.op_i32_const(-1);
        wb.op_i32_mul();
        wb.op_i32_const(127);
        wb.op_i32_add();
    }
    wb.op_i32_const(23);
    wb.op_i32_shl();
    wb.op_f32_reinterpret_i32();
}

// Clamp LOCAL_PSQ_F64 to [lo, hi] in place. Bounds are exactly
// f32-representable; f64 comparison of f32-valued data gives identical
// ordering to the interpreter's f32-domain std::clamp. NaN survives both
// selects (comparisons false keep it) and trunc_sat maps it to 0 — equal
// to the interpreter's host cast (0x80000000) truncated to any psq width.
static void emit_psq_clamp_f64(WasmModuleBuilder& wb, double lo, double hi) {
    // x = (x > hi) ? hi : x
    wb.op_f64_const(hi);
    wb.op_local_get(LOCAL_PSQ_F64);
    wb.op_local_get(LOCAL_PSQ_F64);
    wb.op_f64_const(hi);
    wb.op_f64_gt();
    wb.op_select();
    wb.op_local_set(LOCAL_PSQ_F64);
    // x = (x < lo) ? lo : x
    wb.op_f64_const(lo);
    wb.op_local_get(LOCAL_PSQ_F64);
    wb.op_local_get(LOCAL_PSQ_F64);
    wb.op_f64_const(lo);
    wb.op_f64_lt();
    wb.op_select();
    wb.op_local_set(LOCAL_PSQ_F64);
}

void emit_psq_l(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                LoadStoreParams params, const CodeOp& op, bool update) {
    const u32 inst = op.inst;
    const u32 rt = GekkoOperands::RD(inst);
    const u32 ra = GekkoOperands::RA(inst);
    const u32 W  = (inst >> 15) & 1u;
    const u32 I  = (inst >> 12) & 7u;
    const u32 simm12 = (u32)(((s32)(inst << 20)) >> 20);

    emit_ea_d_form(wb, rc, ra, simm12);
    rc.Flush(params.ctx_ptr);
    frc.Flush(params.ctx_ptr);

    auto rt_pair = frc.Bind(rt, FPRMode::Write, FPR_LANE_BOTH);

    // gqr -> LOCAL_TMP_VAL (ld_type bits 16-18, ld_scale 24-29)
    wb.op_i32_const((s32)params.ctx_ptr);
    wb.op_i32_load(ppc_off::spr(912u + I));
    wb.op_local_set(LOCAL_TMP_VAL);

    wb.op_local_get(LOCAL_TMP_VAL);
    wb.op_i32_const(16);
    wb.op_i32_shr_u();
    wb.op_i32_const(7);
    wb.op_i32_and();
    wb.op_i32_eqz();
    wb.op_if(BLOCK_TYPE_VOID);
    {
        // FLOAT: raw f32 patterns, no scale (ILSP:233-246)
        wb.op_local_get(LOCAL_TMP_EA);
        wb.op_call(WIMPORT_READ32);
        wb.op_local_set(LOCAL_PSQ_T0);
        emit_psq_convert_to_double(wb);
        wb.op_local_set(rt_pair.ps0_idx);
        if (W) {
            wb.op_i64_const(0x3FF0000000000000ll);  // ps1 = 1.0 (ILSP:238)
            wb.op_local_set(rt_pair.ps1_idx);
        } else {
            wb.op_local_get(LOCAL_TMP_EA);
            wb.op_i32_const(4);
            wb.op_i32_add();
            wb.op_call(WIMPORT_READ32);
            wb.op_local_set(LOCAL_PSQ_T0);
            emit_psq_convert_to_double(wb);
            wb.op_local_set(rt_pair.ps1_idx);
        }
    }
    wb.op_else();
    {
        wb.op_local_get(LOCAL_TMP_VAL);
        wb.op_i32_const(16);
        wb.op_i32_shr_u();
        wb.op_i32_const(4);
        wb.op_i32_and();
        wb.op_if(BLOCK_TYPE_VOID);
        {
            // U8/U16/S8/S16. Pair = ONE wide access (ILSP ReadPair):
            // u8 pair -> read16 (ps0 = hi byte); u16 pair -> read32.
            wb.op_local_get(LOCAL_TMP_VAL);
            wb.op_i32_const(16);
            wb.op_i32_shr_u();
            wb.op_i32_const(1);
            wb.op_i32_and();
            wb.op_if(BLOCK_TYPE_VOID);
            {   // 16-bit elements
                if (W) {
                    wb.op_local_get(LOCAL_TMP_EA);
                    wb.op_call(WIMPORT_READ16);
                    wb.op_local_set(LOCAL_PSQ_T0);
                } else {
                    wb.op_local_get(LOCAL_TMP_EA);
                    wb.op_call(WIMPORT_READ32);
                    wb.op_local_tee(LOCAL_PSQ_T1);
                    wb.op_i32_const(16);
                    wb.op_i32_shr_u();
                    wb.op_local_set(LOCAL_PSQ_T0);
                    wb.op_local_get(LOCAL_PSQ_T1);
                    wb.op_i32_const(0xFFFF);
                    wb.op_i32_and();
                    wb.op_local_set(LOCAL_PSQ_T1);
                }
            }
            wb.op_else();
            {   // 8-bit elements
                if (W) {
                    wb.op_local_get(LOCAL_TMP_EA);
                    wb.op_call(WIMPORT_READ8);
                    wb.op_local_set(LOCAL_PSQ_T0);
                } else {
                    wb.op_local_get(LOCAL_TMP_EA);
                    wb.op_call(WIMPORT_READ16);
                    wb.op_local_tee(LOCAL_PSQ_T1);
                    wb.op_i32_const(8);
                    wb.op_i32_shr_u();
                    wb.op_i32_const(0xFF);
                    wb.op_i32_and();
                    wb.op_local_set(LOCAL_PSQ_T0);
                    wb.op_local_get(LOCAL_PSQ_T1);
                    wb.op_i32_const(0xFF);
                    wb.op_i32_and();
                    wb.op_local_set(LOCAL_PSQ_T1);
                }
            }
            wb.op_end();

            const u32 lanes[2] = { LOCAL_PSQ_T0, LOCAL_PSQ_T1 };
            const u32 dests[2] = { rt_pair.ps0_idx, rt_pair.ps1_idx };
            const u32 nlanes = W ? 1u : 2u;
            for (u32 ln = 0; ln < nlanes; ++ln) {
                // signed? sign-extend the element in place (shl/shr_s pair)
                wb.op_local_get(LOCAL_TMP_VAL);
                wb.op_i32_const(16);
                wb.op_i32_shr_u();
                wb.op_i32_const(2);
                wb.op_i32_and();
                wb.op_if(BLOCK_TYPE_VOID);
                {
                    wb.op_local_get(LOCAL_TMP_VAL);
                    wb.op_i32_const(16);
                    wb.op_i32_shr_u();
                    wb.op_i32_const(1);
                    wb.op_i32_and();
                    wb.op_if(BLOCK_TYPE_VOID);
                    {
                        wb.op_local_get(lanes[ln]);
                        wb.op_i32_const(16);
                        wb.op_i32_shl();
                        wb.op_i32_const(16);
                        wb.op_i32_shr_s();
                        wb.op_local_set(lanes[ln]);
                    }
                    wb.op_else();
                    {
                        wb.op_local_get(lanes[ln]);
                        wb.op_i32_const(24);
                        wb.op_i32_shl();
                        wb.op_i32_const(24);
                        wb.op_i32_shr_s();
                        wb.op_local_set(lanes[ln]);
                    }
                    wb.op_end();
                }
                wb.op_end();

                // ps = f64( f32(elem) * 2^-scale ). Signed i32->f32 convert
                // is exact for the unsigned elements too (<= 65535).
                wb.op_local_get(lanes[ln]);
                wb.op_f32_convert_i32_s();
                wb.op_local_get(LOCAL_TMP_VAL);
                wb.op_i32_const(24);
                wb.op_i32_shr_u();
                wb.op_i32_const(0x3F);
                wb.op_i32_and();
                emit_psq_factor_from_scale(wb, /*quantize=*/false);
                wb.op_f32_mul();
                wb.op_f64_promote_f32();
                wb.op_i64_reinterpret_f64();
                wb.op_local_set(dests[ln]);
            }
            if (W) {
                wb.op_i64_const(0x3FF0000000000000ll);  // ps1 = 1.0
                wb.op_local_set(rt_pair.ps1_idx);
            }
        }
        wb.op_else();
        {
            // INVALID1/2/3: ps0 = ps1 = 0.0, NO memory access (ILSP:264-270)
            wb.op_i64_const(0);
            wb.op_local_set(rt_pair.ps0_idx);
            wb.op_i64_const(0);
            wb.op_local_set(rt_pair.ps1_idx);
        }
        wb.op_end();
    }
    wb.op_end();

    if (update && ra != 0) {
        auto rc_ra = rc.Bind(ra, RCMode::Write);
        wb.op_local_get(LOCAL_TMP_EA);
        wb.op_local_set(rc_ra.local_idx());
    }
}

void emit_psq_st(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                 LoadStoreParams params, const CodeOp& op, bool update) {
    const u32 inst = op.inst;
    const u32 rs = GekkoOperands::RD(inst);  // FS field, same bit position
    const u32 ra = GekkoOperands::RA(inst);
    const u32 W  = (inst >> 15) & 1u;
    const u32 I  = (inst >> 12) & 7u;
    const u32 simm12 = (u32)(((s32)(inst << 20)) >> 20);

    emit_ea_d_form(wb, rc, ra, simm12);
    auto rs_pair = frc.Bind(rs, FPRMode::Read, W ? FPR_LANE_PS0 : FPR_LANE_BOTH);
    rc.Flush(params.ctx_ptr);
    frc.Flush(params.ctx_ptr);

    // gqr -> LOCAL_TMP_VAL (st_type bits 0-2, st_scale 8-13)
    wb.op_i32_const((s32)params.ctx_ptr);
    wb.op_i32_load(ppc_off::spr(912u + I));
    wb.op_local_set(LOCAL_TMP_VAL);

    wb.op_local_get(LOCAL_TMP_VAL);
    wb.op_i32_const(7);
    wb.op_i32_and();
    wb.op_i32_eqz();
    wb.op_if(BLOCK_TYPE_VOID);
    {
        // FLOAT: ConvertToSingleFTZ per lane, no scale (ILSP:156-168)
        wb.op_local_get(LOCAL_TMP_EA);
        emit_convert_to_single_ftz(wb, rs_pair.ps0_idx);
        wb.op_call(WIMPORT_WRITE32);
        if (!W) {
            wb.op_local_get(LOCAL_TMP_EA);
            wb.op_i32_const(4);
            wb.op_i32_add();
            emit_convert_to_single_ftz(wb, rs_pair.ps1_idx);
            wb.op_call(WIMPORT_WRITE32);
        }
    }
    wb.op_else();
    {
        wb.op_local_get(LOCAL_TMP_VAL);
        wb.op_i32_const(4);
        wb.op_i32_and();
        wb.op_if(BLOCK_TYPE_VOID);
        {
            // ScaleAndClamp per lane (ILSP:60-68): conv = f32(ps) * 2^scale
            // (f32 domain), clamp to type bounds, C-cast truncation.
            const u32 srcs[2] = { rs_pair.ps0_idx, rs_pair.ps1_idx };
            const u32 outs[2] = { LOCAL_PSQ_T0, LOCAL_PSQ_T1 };
            const u32 nlanes = W ? 1u : 2u;
            for (u32 ln = 0; ln < nlanes; ++ln) {
                wb.op_local_get(srcs[ln]);
                wb.op_f64_reinterpret_i64();
                wb.op_f32_demote_f64();
                wb.op_local_get(LOCAL_TMP_VAL);
                wb.op_i32_const(8);
                wb.op_i32_shr_u();
                wb.op_i32_const(0x3F);
                wb.op_i32_and();
                emit_psq_factor_from_scale(wb, /*quantize=*/true);
                wb.op_f32_mul();
                wb.op_f64_promote_f32();
                wb.op_local_set(LOCAL_PSQ_F64);
                // clamp bounds by type at runtime: sign = bit1, width = bit0
                wb.op_local_get(LOCAL_TMP_VAL);
                wb.op_i32_const(2);
                wb.op_i32_and();
                wb.op_if(BLOCK_TYPE_VOID);
                {
                    wb.op_local_get(LOCAL_TMP_VAL);
                    wb.op_i32_const(1);
                    wb.op_i32_and();
                    wb.op_if(BLOCK_TYPE_VOID);
                    emit_psq_clamp_f64(wb, -32768.0, 32767.0);
                    wb.op_else();
                    emit_psq_clamp_f64(wb, -128.0, 127.0);
                    wb.op_end();
                }
                wb.op_else();
                {
                    wb.op_local_get(LOCAL_TMP_VAL);
                    wb.op_i32_const(1);
                    wb.op_i32_and();
                    wb.op_if(BLOCK_TYPE_VOID);
                    emit_psq_clamp_f64(wb, 0.0, 65535.0);
                    wb.op_else();
                    emit_psq_clamp_f64(wb, 0.0, 255.0);
                    wb.op_end();
                }
                wb.op_end();
                wb.op_local_get(LOCAL_PSQ_F64);
                wb.op_i32_trunc_sat_f64_s();
                wb.op_local_set(outs[ln]);
            }
            // pack + write (WritePair: ps0 in the high element)
            wb.op_local_get(LOCAL_TMP_VAL);
            wb.op_i32_const(1);
            wb.op_i32_and();
            wb.op_if(BLOCK_TYPE_VOID);
            {   // 16-bit elements
                if (W) {
                    wb.op_local_get(LOCAL_TMP_EA);
                    wb.op_local_get(LOCAL_PSQ_T0);
                    wb.op_i32_const(0xFFFF);
                    wb.op_i32_and();
                    wb.op_call(WIMPORT_WRITE16);
                } else {
                    wb.op_local_get(LOCAL_TMP_EA);
                    wb.op_local_get(LOCAL_PSQ_T0);
                    wb.op_i32_const(16);
                    wb.op_i32_shl();
                    wb.op_local_get(LOCAL_PSQ_T1);
                    wb.op_i32_const(0xFFFF);
                    wb.op_i32_and();
                    wb.op_i32_or();
                    wb.op_call(WIMPORT_WRITE32);
                }
            }
            wb.op_else();
            {   // 8-bit elements
                if (W) {
                    wb.op_local_get(LOCAL_TMP_EA);
                    wb.op_local_get(LOCAL_PSQ_T0);
                    wb.op_i32_const(0xFF);
                    wb.op_i32_and();
                    wb.op_call(WIMPORT_WRITE8);
                } else {
                    wb.op_local_get(LOCAL_TMP_EA);
                    wb.op_local_get(LOCAL_PSQ_T0);
                    wb.op_i32_const(0xFF);
                    wb.op_i32_and();
                    wb.op_i32_const(8);
                    wb.op_i32_shl();
                    wb.op_local_get(LOCAL_PSQ_T1);
                    wb.op_i32_const(0xFF);
                    wb.op_i32_and();
                    wb.op_i32_or();
                    wb.op_call(WIMPORT_WRITE16);
                }
            }
            wb.op_end();
        }
        wb.op_else();
        {
            // INVALID1/2/3: assert-only in the interpreter; NO write (ILSP:191-195)
        }
        wb.op_end();
    }
    wb.op_end();

    if (update && ra != 0) {
        auto rc_ra = rc.Bind(ra, RCMode::Write);
        wb.op_local_get(LOCAL_TMP_EA);
        wb.op_local_set(rc_ra.local_idx());
    }
}

// lfs  FRD, d(rA) — load f32 at EA, naive f32->f64 promote, store at
// ps0(FRD) + splat to ps1(FRD). Mirrors emit_lfsx (jit_load_store.cpp:546).
// Naive promote vs PEM ConvertToDouble — same approximation as existing
// emit_lfsx; tightening is a separate pass across lfs/lfsu/lfsx/lfsux.
void emit_lfs(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
              LoadStoreParams params, const CodeOp& op, bool update) {
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 simm = GekkoOperands::SIMM_16(inst);

    emit_ea_d_form(wb, rc, ra, simm);
    rc.Flush(params.ctx_ptr);
    frc.Flush(params.ctx_ptr);

    auto rt_pair = frc.Bind(rt, FPRMode::Write, FPR_LANE_BOTH);

    wb.op_local_get(LOCAL_TMP_EA);
    wb.op_call(WIMPORT_READ32);
    wb.op_f32_reinterpret_i32();
    wb.op_f64_promote_f32();
    wb.op_i64_reinterpret_f64();
    // Splat to both ps0 + ps1 cache locals — paired-singles ops that read
    // ps1 see fresh value. Use local_tee to keep the i64 on the stack.
    wb.op_local_tee(rt_pair.ps0_idx);
    wb.op_local_set(rt_pair.ps1_idx);

    if (update && ra != 0) {
        auto rc_ra = rc.Bind(ra, RCMode::Write);
        wb.op_local_get(LOCAL_TMP_EA);
        wb.op_local_set(rc_ra.local_idx());
    }
}

// lmw rD, d(rA) — load (32 - rD) words sequentially. Per Jit64
// Jit_LoadStore.cpp:644-667. Direct PowerPCState writes + ReloadAll to
// keep the regcache coherent with the loaded slots (avoids the 2026-05-31
// OSCacheInit r28-r31 class regression — see ppc_emit.cpp:54-58).
void emit_lmw(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
              LoadStoreParams params, const CodeOp& op) {
    const u32 inst = op.inst;
    const u32 rd   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 simm = GekkoOperands::SIMM_16(inst);

    rc.Flush(params.ctx_ptr);
    frc.Flush(params.ctx_ptr);

    if (ra == 0) {
        wb.op_i32_const((s32)simm);
    } else {
        wb.op_i32_const((s32)params.ctx_ptr);
        wb.op_i32_load(ppc_off::gpr(ra));
        wb.op_i32_const((s32)simm);
        wb.op_i32_add();
    }
    wb.op_local_set(LOCAL_TMP_EA);

    for (u32 i = rd; i <= 31; ++i) {
        wb.op_i32_const((s32)params.ctx_ptr);
        wb.op_local_get(LOCAL_TMP_EA);
        if (i != rd) {
            wb.op_i32_const((s32)((i - rd) * 4u));
            wb.op_i32_add();
        }
        wb.op_call(WIMPORT_READ32);
        wb.op_i32_store(ppc_off::gpr(i));
    }

    rc.ReloadAll(params.ctx_ptr);
    frc.ReloadAll(params.ctx_ptr);
}

// stmw rS, d(rA) — store (32 - rS) words sequentially. Per Jit64
// Jit_LoadStore.cpp:669-697. No ReloadAll needed since stmw doesn't write
// gpr[]; cache stays coherent.
void emit_stmw(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
               LoadStoreParams params, const CodeOp& op) {
    const u32 inst = op.inst;
    const u32 rs   = GekkoOperands::RS(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 simm = GekkoOperands::SIMM_16(inst);

    rc.Flush(params.ctx_ptr);
    frc.Flush(params.ctx_ptr);

    if (ra == 0) {
        wb.op_i32_const((s32)simm);
    } else {
        wb.op_i32_const((s32)params.ctx_ptr);
        wb.op_i32_load(ppc_off::gpr(ra));
        wb.op_i32_const((s32)simm);
        wb.op_i32_add();
    }
    wb.op_local_set(LOCAL_TMP_EA);

    for (u32 i = rs; i <= 31; ++i) {
        wb.op_local_get(LOCAL_TMP_EA);
        if (i != rs) {
            wb.op_i32_const((s32)((i - rs) * 4u));
            wb.op_i32_add();
        }
        wb.op_i32_const((s32)params.ctx_ptr);
        wb.op_i32_load(ppc_off::gpr(i));
        wb.op_call(WIMPORT_WRITE32);
    }
}

// stfiwx fS, rA, rB — write low 32 bits of ps0(rs) f64 as a word.
// Cache-local form: read the i64 from rs's ps0 lane, wrap to i32 low bits,
// write via WIMPORT_WRITE32. Eliminates the latent stale-memory read bug
// (when rs's ps0 lane is cached dirty, the prior i32_load of ps0(rs)
// returned the pre-write value).
void emit_stfiwx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                 LoadStoreParams params, const CodeOp& op) {
    const u32 inst = op.inst;
    const u32 rs   = GekkoOperands::RS(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rb   = GekkoOperands::RB(inst);

    emit_ea_x_stack(wb, rc, ra, rb);
    wb.op_local_set(LOCAL_TMP_EA);

    auto rs_pair = frc.Bind(rs, FPRMode::Read, FPR_LANE_PS0);
    rc.Flush(params.ctx_ptr);

    wb.op_local_get(LOCAL_TMP_EA);
    wb.op_local_get(rs_pair.ps0_idx);
    wb.op_i32_wrap_i64();
    wb.op_call(WIMPORT_WRITE32);
}

}  // namespace bemental::powerpc
